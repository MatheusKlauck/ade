// M2-T8: Minimal run_cycle for spike tests; M5-T3 will expand this into a full worker loop.

use crate::db::DbPool;
use crate::error::AdeError;
use crate::gh::client::GitHubClient;
use crate::gh::types::{ColumnName, RemoteIssue, SyncAction};
use crate::models::Card;
use crate::sync::engine::{desired_column, reconcile, CardSnapshot, PendingIntent};
use crate::sync::outbox;
use chrono::Utc;

/// Trait for emitting notifications. In production, this wraps `app.emit`.
/// In tests, it appends to a Vec for assertion.
/// `#[allow(dead_code)]`: the worker is not yet wired into the Tauri app — that
/// lands in M5-T3, which removes the need for these allows.
#[allow(dead_code)]
pub trait Notifier: Send + Sync {
    fn notify(&self, level: &str, code: &str, message: &str);
}

/// A no-op notifier that discards all notifications.
#[allow(dead_code)]
pub struct NoopNotifier;

impl Notifier for NoopNotifier {
    fn notify(&self, _level: &str, _code: &str, _message: &str) {}
}

/// A notifier that captures (level, code, message) triples for test assertion.
#[allow(dead_code)]
pub struct CaptureNotifier {
    events: std::sync::Mutex<Vec<(String, String, String)>>,
}

#[allow(dead_code)]
impl CaptureNotifier {
    pub fn new() -> Self {
        Self {
            events: std::sync::Mutex::new(Vec::new()),
        }
    }

    pub fn take(&self) -> Vec<(String, String, String)> {
        self.events.lock().expect("lock").drain(..).collect()
    }
}

impl Notifier for CaptureNotifier {
    fn notify(&self, level: &str, code: &str, message: &str) {
        self.events.lock().expect("lock").push((
            level.to_string(),
            code.to_string(),
            message.to_string(),
        ));
    }
}

/// Parse the `from_column_name` field of an outbox payload into a `ColumnName`.
/// §13: the conflict check compares this source column against
/// `desired_column(remote_now)`.
#[allow(dead_code)]
fn parse_column_name(payload_json: &str) -> Result<ColumnName, AdeError> {
    let payload: serde_json::Value = serde_json::from_str(payload_json)
        .map_err(|e| AdeError::Other(format!("outbox payload json: {}", e)))?;
    let from_col_str = payload
        .get("from_column_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AdeError::Other("outbox payload missing from_column_name".into()))?;
    match from_col_str {
        "Backlog" => Ok(ColumnName::Backlog),
        "Doing" => Ok(ColumnName::Doing),
        "Paused" => Ok(ColumnName::Paused),
        "PR" => Ok(ColumnName::Pr),
        "Done" => Ok(ColumnName::Done),
        other => Err(AdeError::Other(format!("unknown column name: {}", other))),
    }
}

/// Run one sync cycle for a workspace.
/// 1. Look up workspace github_owner/github_repo and sync_state.last_sync
/// 2. Incremental fetch (or seed if no last_sync)
/// 3. Reconcile each issue via engine::reconcile()
/// 4. Apply actions in one DB transaction
/// 5. Run outbox sender pass (check each due intent against remote state)
/// 6. Update sync_state
#[allow(dead_code)]
pub async fn run_cycle(
    db: &DbPool,
    gh: &GitHubClient,
    workspace_id: &str,
    notifier: &dyn Notifier,
) -> Result<(), AdeError> {
    // 1. Look up workspace
    let ws: crate::models::Workspace = sqlx::query_as::<_, crate::models::Workspace>(
        "SELECT id, name, slug, root_path, github_owner, github_repo, startup_command, created_at FROM workspace WHERE id = ?",
    )
    .bind(workspace_id)
    .fetch_one(db)
    .await
    .map_err(AdeError::Db)?;

    let owner = ws
        .github_owner
        .ok_or_else(|| AdeError::Other("workspace has no github_owner".into()))?;
    let repo = ws
        .github_repo
        .ok_or_else(|| AdeError::Other("workspace has no github_repo".into()))?;

    // 2. Check sync_state for last_sync
    let last_sync: Option<String> =
        sqlx::query_scalar::<_, String>("SELECT last_sync FROM sync_state WHERE workspace_id = ?")
            .bind(workspace_id)
            .fetch_optional(db)
            .await
            .map_err(AdeError::Db)?;

    // 3. Fetch remote issues.
    // §11: the next `last_sync` watermark is captured BEFORE the request starts,
    // so issues touched during the round-trip aren't skipped next cycle.
    let cycle_start = Utc::now().to_rfc3339();
    let remote_issues: Vec<RemoteIssue> = if let Some(since) = &last_sync {
        gh.list_issues_since(&owner, &repo, since).await?
    } else {
        gh.list_issues_seed(&owner, &repo).await?
    };

    // 4. Build a map of local cards by github_issue_number for reconciliation
    let local_cards: Vec<Card> = sqlx::query_as::<_, Card>(
        "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE workspace_id = ?",
    )
    .bind(workspace_id)
    .fetch_all(db)
    .await
    .map_err(AdeError::Db)?;

    let mut local_by_number: std::collections::HashMap<i64, Card> =
        std::collections::HashMap::new();
    for card in &local_cards {
        if let Some(num) = card.github_issue_number {
            local_by_number.insert(num, card.clone());
        }
    }

    // 5. Load pending outbox intents.
    // §12 Row 4 / §13 step 1: ALL pending intents suspend reconciliation and are
    // checked for conflict, not only the ones whose backoff is due (`due()` only
    // gates the network retry, which lands in M5).
    let pending_rows = outbox::all_for_workspace(db, workspace_id).await?;
    let mut pending_by_card_id: std::collections::HashMap<String, outbox::OutboxRow> =
        std::collections::HashMap::new();
    for row in &pending_rows {
        pending_by_card_id.insert(row.card_id.clone(), row.clone());
    }

    // Build column name lookup: column_id -> ColumnName
    let columns: Vec<crate::models::BoardColumn> = sqlx::query_as::<_, crate::models::BoardColumn>(
        "SELECT id, workspace_id, name, position FROM board_column WHERE workspace_id = ?",
    )
    .bind(workspace_id)
    .fetch_all(db)
    .await
    .map_err(AdeError::Db)?;

    let mut col_name_by_id: std::collections::HashMap<String, ColumnName> =
        std::collections::HashMap::new();
    let mut col_id_by_name: std::collections::HashMap<ColumnName, String> =
        std::collections::HashMap::new();
    for col in &columns {
        let cname = match col.name.as_str() {
            "Backlog" => ColumnName::Backlog,
            "Doing" => ColumnName::Doing,
            "Paused" => ColumnName::Paused,
            "PR" => ColumnName::Pr,
            "Done" => ColumnName::Done,
            _ => continue,
        };
        col_name_by_id.insert(col.id.clone(), cname);
        col_id_by_name.insert(cname, col.id.clone());
    }

    // 6. Reconcile and apply actions — §14: all mutations land in one transaction.
    let now = Utc::now().to_rfc3339();
    let mut tx = db.begin().await.map_err(AdeError::Db)?;
    // Notifications are deferred until the transaction commits, so a rollback never
    // tells the user a move was dropped that wasn't actually persisted.
    let mut dropped_intents: Vec<u64> = Vec::new();

    for remote in &remote_issues {
        let number = remote.number as i64;
        let local_card = local_by_number.get(&number);

        // Build CardSnapshot if local card exists
        let snapshot = local_card.and_then(|card| {
            col_name_by_id
                .get(&card.column_id)
                .map(|&col_name| CardSnapshot {
                    card_id: card.id.clone(),
                    column: col_name,
                    remote_updated_at: card.remote_updated_at.clone(),
                })
        });

        let card_id_opt = local_card.map(|c| c.id.clone());

        // §13 step 1 — drop-before-reconcile: if a queued intent exists and the
        // remote has moved the card to a *different* column than `from_column_name`,
        // that's a genuine column conflict. Drop the intent (in-tx) and remove it
        // from the in-memory pending map BEFORE reconciling, so the card is
        // reconciled to the remote state in the SAME cycle (§12 Row 7 produces
        // MoveCard once `pending` is None). A metadata-only bump
        // (`desired == from_column`) keeps the intent and Row 4 still Ignores.
        if let Some(card_id) = &card_id_opt {
            // Read the source column out of the pending row (if any), then release
            // the immutable borrow before we may mutate the map below.
            let from_col_name = match pending_by_card_id.get(card_id) {
                Some(outbox_row) => Some(parse_column_name(&outbox_row.payload_json)?),
                None => None,
            };

            if let Some(from_col_name) = from_col_name {
                let desired_now = desired_column(remote);
                if desired_now != from_col_name {
                    // Genuine column conflict: drop intent, queue INTENT_DROPPED.
                    sqlx::query("DELETE FROM outbox WHERE card_id = ?")
                        .bind(card_id)
                        .execute(&mut *tx)
                        .await
                        .map_err(AdeError::Db)?;
                    pending_by_card_id.remove(card_id);
                    dropped_intents.push(remote.number);
                }
                // If desired_now == from_col_name, the remote change was metadata-only
                // (e.g., a comment). The intent is still valid; leave it for M5 sender.
            }
        }

        // Build PendingIntent from any intent that survived the conflict check.
        let pending = card_id_opt
            .as_ref()
            .and_then(|cid| pending_by_card_id.get(cid))
            .and_then(|row| {
                let payload: serde_json::Value = serde_json::from_str(&row.payload_json).ok()?;
                let to_col_str = payload.get("to_column_name")?.as_str()?;
                let to_col = match to_col_str {
                    "Backlog" => ColumnName::Backlog,
                    "Doing" => ColumnName::Doing,
                    "Paused" => ColumnName::Paused,
                    "PR" => ColumnName::Pr,
                    "Done" => ColumnName::Done,
                    _ => return None,
                };
                Some(PendingIntent {
                    base_remote_updated_at: Some(row.base_remote_updated_at.clone()),
                    to: to_col,
                })
            });

        let action = reconcile(remote, snapshot.as_ref(), pending.as_ref());

        match action {
            SyncAction::CreateCard { issue, column } => {
                let col_id = col_id_by_name
                    .get(&column)
                    .ok_or_else(|| AdeError::Other(format!("column not found: {:?}", column)))?;
                let card_id = uuid::Uuid::new_v4().to_string();
                let labels_json = serde_json::to_string(&issue.labels)
                    .map_err(|e| AdeError::Other(format!("labels json: {}", e)))?;
                sqlx::query(
                    "INSERT INTO card (id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'github', ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(&card_id)
                .bind(workspace_id)
                .bind(col_id)
                .bind(&issue.title)
                .bind(&issue.body_preview)
                .bind(0.0)
                .bind(issue.number as i64)
                .bind(&issue.state)
                .bind(&issue.assignee)
                .bind(&labels_json)
                .bind(&issue.updated_at)
                .bind(&now)
                .bind(&now)
                .execute(&mut *tx)
                .await
                .map_err(AdeError::Db)?;
            }
            SyncAction::MoveCard { card_id, to } => {
                let col_id = col_id_by_name
                    .get(&to)
                    .ok_or_else(|| AdeError::Other(format!("column not found: {:?}", to)))?;
                // §12 Row 7: MoveCard also refreshes fields — a remote move can carry
                // a title/labels/assignee change in the same payload.
                let labels_json = serde_json::to_string(&remote.labels)
                    .map_err(|e| AdeError::Other(format!("labels json: {}", e)))?;
                sqlx::query(
                    "UPDATE card SET column_id = ?, title = ?, github_state = ?, assignee = ?, labels_json = ?, remote_updated_at = ?, updated_at = ? WHERE id = ?",
                )
                .bind(col_id)
                .bind(&remote.title)
                .bind(&remote.state)
                .bind(&remote.assignee)
                .bind(&labels_json)
                .bind(&remote.updated_at)
                .bind(&now)
                .bind(&card_id)
                .execute(&mut *tx)
                .await
                .map_err(AdeError::Db)?;
            }
            SyncAction::RefreshCardFields { card_id } => {
                let labels_json = serde_json::to_string(&remote.labels)
                    .map_err(|e| AdeError::Other(format!("labels json: {}", e)))?;
                sqlx::query(
                    "UPDATE card SET title = ?, github_state = ?, assignee = ?, labels_json = ?, remote_updated_at = ?, updated_at = ? WHERE id = ?",
                )
                .bind(&remote.title)
                .bind(&remote.state)
                .bind(&remote.assignee)
                .bind(&labels_json)
                .bind(&remote.updated_at)
                .bind(&now)
                .bind(&card_id)
                .execute(&mut *tx)
                .await
                .map_err(AdeError::Db)?;
            }
            SyncAction::TouchRemoteUpdatedAt { card_id } => {
                sqlx::query("UPDATE card SET remote_updated_at = ?, updated_at = ? WHERE id = ?")
                    .bind(&remote.updated_at)
                    .bind(&now)
                    .bind(&card_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(AdeError::Db)?;
            }
            SyncAction::Ignore => {}
        }
    }

    // 8. Update sync_state — §11: watermark captured before the fetch (cycle_start).
    if last_sync.is_some() {
        sqlx::query("UPDATE sync_state SET last_sync = ? WHERE workspace_id = ?")
            .bind(&cycle_start)
            .bind(workspace_id)
            .execute(&mut *tx)
            .await
            .map_err(AdeError::Db)?;
    } else {
        sqlx::query("INSERT OR REPLACE INTO sync_state (workspace_id, last_sync) VALUES (?, ?)")
            .bind(workspace_id)
            .bind(&cycle_start)
            .execute(&mut *tx)
            .await
            .map_err(AdeError::Db)?;
    }

    tx.commit().await.map_err(AdeError::Db)?;

    // Emit deferred notifications only after the transaction has committed.
    for number in dropped_intents {
        notifier.notify(
            "warn",
            "INTENT_DROPPED",
            &format!(
                "issue #{} was moved on GitHub; your move was discarded",
                number
            ),
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    /// Helper: create a temp DB with full schema via migrations.
    async fn test_pool() -> (DbPool, tempfile::TempDir) {
        let dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
        let tmp = tempfile::tempdir_in(&dir).expect("tempdir");
        let path = tmp.path().join("test.db");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("pool connect");

        sqlx::query("PRAGMA journal_mode=WAL;")
            .execute(&pool)
            .await
            .expect("WAL");
        sqlx::query("PRAGMA busy_timeout=5000;")
            .execute(&pool)
            .await
            .expect("busy_timeout");

        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migrations");

        (pool, tmp)
    }

    /// Helper: seed a workspace with 5 columns and return the workspace ID + column ID map.
    async fn seed_workspace(
        pool: &DbPool,
    ) -> (String, std::collections::HashMap<ColumnName, String>) {
        let ws_id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        sqlx::query(
            "INSERT INTO workspace (id, name, slug, root_path, github_owner, github_repo, created_at) VALUES (?, 'TestWS', 'testws', '/tmp/test', ?, ?, ?)",
        )
        .bind(&ws_id)
        .bind("testowner")
        .bind("testrepo")
        .bind(&now)
        .execute(pool)
        .await
        .expect("insert workspace");

        let col_names = ["Backlog", "Doing", "Paused", "PR", "Done"];
        let mut col_ids = std::collections::HashMap::new();
        for (i, name) in col_names.iter().enumerate() {
            let cid = uuid::Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO board_column (id, workspace_id, name, position) VALUES (?, ?, ?, ?)",
            )
            .bind(&cid)
            .bind(&ws_id)
            .bind(name)
            .bind(i as i64)
            .execute(pool)
            .await
            .expect("insert column");

            let cname = match *name {
                "Backlog" => ColumnName::Backlog,
                "Doing" => ColumnName::Doing,
                "Paused" => ColumnName::Paused,
                "PR" => ColumnName::Pr,
                "Done" => ColumnName::Done,
                _ => panic!("unknown column name"),
            };
            col_ids.insert(cname, cid);
        }

        (ws_id, col_ids)
    }

    /// Helper: insert a card linked to a GitHub issue.
    async fn insert_card(
        pool: &DbPool,
        workspace_id: &str,
        column_id: &str,
        issue_number: i64,
        title: &str,
        remote_updated_at: &str,
    ) -> String {
        let card_id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, position, source, github_issue_number, github_state, remote_updated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'github', ?, 'open', ?, ?, ?)",
        )
        .bind(&card_id)
        .bind(workspace_id)
        .bind(column_id)
        .bind(title)
        .bind(1.0)
        .bind(issue_number)
        .bind(remote_updated_at)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await
        .expect("insert card");
        card_id
    }

    /// Build a GitHub-API-shaped issue JSON object, mirroring
    /// `gh::client::tests::issue_json`. The worker consumes raw GitHub JSON via
    /// `GitHubClient::map_issue`, so labels must be objects `{"name": ...}` and
    /// `assignee` must be null or `{"login": ...}` — serializing a `RemoteIssue`
    /// would emit `labels: ["..."]` (string array), which `map_issue` drops.
    fn issue_json(
        number: u64,
        state: &str,
        labels: &[&str],
        updated_at: &str,
    ) -> serde_json::Value {
        let label_objs: Vec<serde_json::Value> = labels
            .iter()
            .map(|name| serde_json::json!({ "name": name }))
            .collect();
        serde_json::json!({
            "number": number,
            "title": format!("Issue #{}", number),
            "state": state,
            "updated_at": updated_at,
            "assignee": serde_json::Value::Null,
            "labels": label_objs,
            "html_url": format!(
                "https://github.com/testowner/testrepo/issues/{}",
                number
            ),
            "body": serde_json::Value::Null,
        })
    }

    // -----------------------------------------------------------------------
    // Scenario 1: Remote close while Doing
    // Card in "Doing" column; wiremock returns the issue closed.
    // After run_cycle, card should end in "Done" column.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn scenario_1_remote_close_while_doing() {
        let (pool, _tmp) = test_pool().await;
        let (ws_id, col_ids) = seed_workspace(&pool).await;

        // Insert a card in Doing column, linked to issue #42
        let _card_id = insert_card(
            &pool,
            &ws_id,
            col_ids.get(&ColumnName::Doing).expect("Doing column"),
            42,
            "Doing issue",
            "2025-01-01T00:00:00Z",
        )
        .await;

        // Initialize sync_state (has last_sync → incremental fetch)
        sqlx::query("INSERT INTO sync_state (workspace_id, last_sync) VALUES (?, ?)")
            .bind(&ws_id)
            .bind("2025-01-01T00:00:00Z")
            .execute(&pool)
            .await
            .expect("insert sync_state");

        // Wiremock: return issue #42 closed (no kanban labels → desired_column = Done for closed)
        let server = wiremock::MockServer::start().await;
        let closed_issue = issue_json(42, "closed", &[], "2025-01-02T00:00:00Z");
        let body = serde_json::to_string(&vec![closed_issue]).expect("json");
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_string(&body))
            .mount(&server)
            .await;

        let gh = GitHubClient::new(server.uri(), "test-token".to_string());
        let notifier = CaptureNotifier::new();
        let result = run_cycle(&pool, &gh, &ws_id, &notifier).await;
        assert!(result.is_ok(), "run_cycle failed: {:?}", result.err());

        // Card should now be in Done column
        let card: Card = sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE github_issue_number = 42",
        )
        .fetch_one(&pool)
        .await
        .expect("card exists");

        assert_eq!(
            card.column_id,
            *col_ids.get(&ColumnName::Done).expect("Done column"),
            "card should be in Done after remote close"
        );
        assert_eq!(card.github_state.as_deref(), Some("closed"));
        // §12 Row 7: MoveCard also refreshes fields — title must reflect the remote.
        assert_eq!(
            card.title, "Issue #42",
            "MoveCard should refresh the title from the remote issue"
        );
    }

    // -----------------------------------------------------------------------
    // Fix 2 regression: an intent still in backoff (attempts>0, not yet due)
    // must still suspend reconciliation. Otherwise reconcile reverts the user's
    // optimistic move while the queued write waits to retry.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn intent_in_backoff_suspends_reconcile() {
        let (pool, _tmp) = test_pool().await;
        let (ws_id, col_ids) = seed_workspace(&pool).await;

        let backlog_id = col_ids.get(&ColumnName::Backlog).expect("Backlog column");
        let paused_id = col_ids.get(&ColumnName::Paused).expect("Paused column");

        // Card optimistically already in Paused (the user moved Backlog -> Paused).
        let card_id = insert_card(
            &pool,
            &ws_id,
            paused_id,
            77,
            "Backoff issue",
            "2025-01-01T00:00:00Z",
        )
        .await;

        // Outbox intent from=Backlog to=Paused, attempts=2, last_attempt 5s ago -> NOT due.
        let recent = (Utc::now() - chrono::Duration::seconds(5)).to_rfc3339();
        let payload = serde_json::json!({
            "from_column_name": "Backlog",
            "to_column_name": "Paused",
        })
        .to_string();
        sqlx::query(
            "INSERT INTO outbox (card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at)
             VALUES (?, 'set_column', ?, '2025-01-01T00:00:00Z', 2, 'boom', ?, ?)",
        )
        .bind(&card_id)
        .bind(&payload)
        .bind(&recent)
        .bind(&recent)
        .execute(&pool)
        .await
        .expect("insert outbox");

        sqlx::query("INSERT INTO sync_state (workspace_id, last_sync) VALUES (?, ?)")
            .bind(&ws_id)
            .bind("2025-01-01T00:00:00Z")
            .execute(&pool)
            .await
            .expect("sync_state");

        // Remote: issue #77 open, NO kanban label (desired=Backlog=from_column,
        // i.e. a comment-only bump), updated_at advanced to T2.
        let server = wiremock::MockServer::start().await;
        let issue = issue_json(77, "open", &[], "2025-01-02T00:00:00Z");
        let body = serde_json::to_string(&vec![issue]).expect("json");
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_string(&body))
            .mount(&server)
            .await;

        let gh = GitHubClient::new(server.uri(), "test-token".to_string());
        let notifier = CaptureNotifier::new();
        run_cycle(&pool, &gh, &ws_id, &notifier)
            .await
            .expect("run_cycle ok");

        let card: Card = sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
        )
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .expect("card exists");

        // Reconcile must have been suspended: card stays where the user put it.
        assert_eq!(
            card.column_id, *paused_id,
            "card must stay in Paused; a backoff intent still suspends reconcile"
        );
        assert_ne!(
            card.column_id, *backlog_id,
            "card must NOT be reverted to Backlog"
        );

        // Intent is comment-only (desired==from) so it is kept, not dropped.
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbox WHERE card_id = ?")
            .bind(&card_id)
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(
            count, 1,
            "comment-only bump must not drop the pending intent"
        );
    }

    // -----------------------------------------------------------------------
    // Scenario 2: Echo suppression
    // Card in "Doing" column with remote_updated_at = T1.
    // Wiremock returns issue with kanban:doing label and updated_at = T2 (newer).
    // After run_cycle: card stays in Doing, remote_updated_at bumped to T2.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn scenario_2_echo_suppression() {
        let (pool, _tmp) = test_pool().await;
        let (ws_id, col_ids) = seed_workspace(&pool).await;

        let doing_id = col_ids.get(&ColumnName::Doing).expect("Doing column");

        // Card in Doing, remote_updated_at = T1
        let card_id = insert_card(
            &pool,
            &ws_id,
            doing_id,
            10,
            "Echo issue",
            "2025-01-01T00:00:00Z", // T1
        )
        .await;

        sqlx::query("INSERT INTO sync_state (workspace_id, last_sync) VALUES (?, ?)")
            .bind(&ws_id)
            .bind("2025-01-01T00:00:00Z")
            .execute(&pool)
            .await
            .expect("sync_state");

        // Wiremock: issue #10 open with kanban:doing label, updated_at = T2
        let server = wiremock::MockServer::start().await;
        let echo_issue = issue_json(10, "open", &["kanban:doing"], "2025-01-02T00:00:00Z");
        let body = serde_json::to_string(&vec![echo_issue]).expect("json");
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_string(&body))
            .mount(&server)
            .await;

        let gh = GitHubClient::new(server.uri(), "test-token".to_string());
        let notifier = CaptureNotifier::new();
        let result = run_cycle(&pool, &gh, &ws_id, &notifier).await;
        assert!(result.is_ok(), "run_cycle failed: {:?}", result.err());

        // Card should still be in Doing
        let card: Card = sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
        )
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .expect("card exists");

        assert_eq!(
            card.column_id, *doing_id,
            "card should stay in Doing (echo suppressed)"
        );
        // remote_updated_at should be bumped to T2
        assert_eq!(
            card.remote_updated_at.as_deref(),
            Some("2025-01-02T00:00:00Z"),
            "remote_updated_at should be bumped to T2"
        );
    }

    // -----------------------------------------------------------------------
    // Scenario 3: Remote column change beats queued move
    // Card in Backlog, outbox has intent from=Backlog to=Paused.
    // Wiremock returns issue with kanban:doing label (remote moved to Doing ≠ from_column).
    // After run_cycle: intent dropped, card reconciled to Doing, INTENT_DROPPED emitted.
    //
    // Second assertion: an intent whose issue only gained a comment
    // (same desired_column as from_column) is NOT dropped.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn scenario_3_remote_change_beats_queued_move() {
        let (pool, _tmp) = test_pool().await;
        let (ws_id, col_ids) = seed_workspace(&pool).await;

        let backlog_id = col_ids.get(&ColumnName::Backlog).expect("Backlog column");
        let doing_id = col_ids.get(&ColumnName::Doing).expect("Doing column");

        // Card A in Backlog, linked to issue #55 — will be moved remotely to Doing
        let card_a_id = insert_card(
            &pool,
            &ws_id,
            backlog_id,
            55,
            "Intent-drop issue",
            "2025-01-01T00:00:00Z",
        )
        .await;

        // Card B in Backlog, linked to issue #56 — will get a comment only (stays Backlog)
        let card_b_id = insert_card(
            &pool,
            &ws_id,
            backlog_id,
            56,
            "Comment-only issue",
            "2025-01-01T00:00:00Z",
        )
        .await;

        // Outbox intent for card A: from=Backlog, to=Paused
        outbox::enqueue(
            &pool,
            &card_a_id,
            "Backlog",
            "Paused",
            "2025-01-01T00:00:00Z",
        )
        .await
        .expect("enqueue A");

        // Outbox intent for card B: from=Backlog, to=Paused (same from_column)
        outbox::enqueue(
            &pool,
            &card_b_id,
            "Backlog",
            "Paused",
            "2025-01-01T00:00:00Z",
        )
        .await
        .expect("enqueue B");

        sqlx::query("INSERT INTO sync_state (workspace_id, last_sync) VALUES (?, ?)")
            .bind(&ws_id)
            .bind("2025-01-01T00:00:00Z")
            .execute(&pool)
            .await
            .expect("sync_state");

        // Wiremock:
        //   issue #55 has kanban:doing (remote moved to Doing ≠ Backlog=from_column)
        //   issue #56 has no kanban labels (desired=Backlog = from_column)
        let server = wiremock::MockServer::start().await;
        let issue_55 = issue_json(55, "open", &["kanban:doing"], "2025-01-02T00:00:00Z");
        let issue_56 = issue_json(56, "open", &[], "2025-01-02T00:00:00Z");
        let body = serde_json::to_string(&vec![issue_55, issue_56]).expect("json");
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_string(&body))
            .mount(&server)
            .await;

        let gh = GitHubClient::new(server.uri(), "test-token".to_string());
        let notifier = CaptureNotifier::new();
        let result = run_cycle(&pool, &gh, &ws_id, &notifier).await;
        assert!(result.is_ok(), "run_cycle failed: {:?}", result.err());

        // Card A should be reconciled to Doing (intent dropped)
        let card_a: Card = sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
        )
        .bind(&card_a_id)
        .fetch_one(&pool)
        .await
        .expect("card A exists");

        assert_eq!(
            card_a.column_id, *doing_id,
            "card A should be moved to Doing (intent dropped, reconciled)"
        );

        // Outbox row for card A should be resolved (deleted)
        let count_a: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbox WHERE card_id = ?")
            .bind(&card_a_id)
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(
            count_a, 0,
            "outbox row for card A should be resolved (deleted)"
        );

        // INTENT_DROPPED notification should have been emitted
        let events = notifier.take();
        let intent_dropped = events.iter().any(|(level, code, msg)| {
            level == "warn" && code == "INTENT_DROPPED" && msg.contains("55")
        });
        assert!(
            intent_dropped,
            "INTENT_DROPPED should be emitted for card A"
        );

        // Card B should stay in Backlog (its intent is NOT dropped because desired=Backlog=from)
        // The intent remains in the outbox
        let card_b: Card = sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
        )
        .bind(&card_b_id)
        .fetch_one(&pool)
        .await
        .expect("card B exists");

        assert_eq!(
            card_b.column_id, *backlog_id,
            "card B should stay in Backlog (intent not dropped)"
        );

        // Outbox row for card B should still exist
        let count_b: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbox WHERE card_id = ?")
            .bind(&card_b_id)
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(
            count_b, 1,
            "outbox row for card B should still exist (intent not dropped)"
        );
    }
}
