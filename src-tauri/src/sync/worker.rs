// M2-T8: Minimal run_cycle for spike tests; M5-T3 expands into full worker loop.

use crate::db::DbPool;
use crate::error::AdeError;
use crate::gh::client::GitHubClient;
use crate::gh::types::{ColumnName, RemoteIssue, SyncAction};
use crate::models::Card;
use crate::sync::engine::{desired_column, reconcile, CardSnapshot, PendingIntent};
use crate::sync::outbox;
use chrono::Utc;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Emitter;

// The Notifier impls live in sync/notifier.rs and RateBudget in sync/rate.rs;
// re-export here so existing `crate::sync::worker::{...}` paths keep working.
#[cfg(test)]
pub use crate::sync::notifier::CaptureNotifier;
pub use crate::sync::notifier::Notifier;
pub use crate::sync::rate::RateBudget;

use crate::sync::notifier::AppNotifier;

// ── CycleResult ─────────────────────────────────────────────────────

/// What `run_cycle` returns so the caller can decide what to do next
/// (e.g., ensure labels, emit ISSUE_LIST_LARGE).
pub struct CycleResult {
    pub was_seed: bool,
    pub issue_count: usize,
    #[allow(dead_code)]
    pub cycle_start: String,
}

// ── run_cycle ────────────────────────────────────────────────────────

/// Run one sync cycle for a workspace.
/// 1. Look up workspace github_owner/github_repo and sync_state.last_sync
/// 2. Incremental fetch (or seed if no last_sync)
/// 3. Reconcile each issue via engine::reconcile()
/// 4. Apply actions in one DB transaction
/// 5. Run outbox sender pass (check each due intent against remote state)
/// 6. Update sync_state
pub async fn run_cycle(
    db: &DbPool,
    gh: &GitHubClient,
    workspace_id: &str,
    notifier: &dyn Notifier,
    rate_budget: &RateBudget,
    force_full: bool,
) -> Result<CycleResult, AdeError> {
    // Check rate budget before making any HTTP requests.
    rate_budget.check().await?;

    // 1. Look up workspace
    let ws: crate::models::Workspace = crate::repo::workspace_by_id(db, workspace_id).await?;

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

    let was_seed = last_sync.is_none();

    // 3. Fetch remote issues.
    // §11: the next `last_sync` watermark is captured BEFORE the request starts,
    // so issues touched during the round-trip aren't skipped next cycle.
    //
    // A user-initiated "Sync" (`force_full`) does an authoritative full fetch
    // (state=all, no `since`) so it reconciles against the repo's entire issue list
    // and recovers any issue that fell behind the incremental watermark. The
    // background interval stays incremental (`since=last_sync`) for efficiency.
    let cycle_start = Utc::now().to_rfc3339();
    let remote_issues: Vec<RemoteIssue> = match (&last_sync, force_full) {
        (_, true) => gh.list_issues_full(&owner, &repo).await?,
        (Some(since), false) => gh.list_issues_since(&owner, &repo, since).await?,
        (None, false) => gh.list_issues_seed(&owner, &repo).await?,
    };

    let issue_count = remote_issues.len();

    // 4. Build a map of local cards by github_issue_number for reconciliation
    let local_cards: Vec<Card> = crate::repo::cards_for_workspace(db, workspace_id).await?;

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
    let columns: Vec<crate::models::BoardColumn> =
        crate::repo::columns_for_workspace(db, workspace_id).await?;

    let mut col_name_by_id: std::collections::HashMap<String, ColumnName> =
        std::collections::HashMap::new();
    let mut col_id_by_name: std::collections::HashMap<ColumnName, String> =
        std::collections::HashMap::new();
    for col in &columns {
        let Some(cname) = ColumnName::try_from_str(&col.name) else {
            continue;
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
                let to_col = ColumnName::try_from_str(to_col_str)?;
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

    Ok(CycleResult {
        was_seed,
        issue_count,
        cycle_start,
    })
}

/// Parse the `from_column_name` field of an outbox payload into a `ColumnName`.
/// §13: the conflict check compares this source column against
/// `desired_column(remote_now)`.
fn parse_column_name(payload_json: &str) -> Result<ColumnName, AdeError> {
    let payload: serde_json::Value = serde_json::from_str(payload_json)
        .map_err(|e| AdeError::Other(format!("outbox payload json: {}", e)))?;
    let from_col_str = payload
        .get("from_column_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AdeError::Other("outbox payload missing from_column_name".into()))?;
    ColumnName::try_from_str(from_col_str)
        .ok_or_else(|| AdeError::Other(format!("unknown column name: {}", from_col_str)))
}

// ── start_worker ─────────────────────────────────────────────────────

/// Spawn a per-workspace sync worker that loops on an interval.
/// Each cycle: sleep → check rate_budget → run_cycle → post-cycle hooks.
/// A `Notify` allows `sync_now` to kick an immediate cycle.
pub async fn start_worker(
    db: DbPool,
    gh: Arc<GitHubClient>,
    workspace_id: String,
    rate_budget: Arc<RateBudget>,
    app: tauri::AppHandle,
    notify: Arc<tokio::sync::Notify>,
    interval_secs: u64,
) {
    let mut interval = tokio::time::interval(Duration::from_secs(interval_secs));
    // The first tick completes immediately; skip it so we respect the interval.
    interval.tick().await;

    loop {
        // A user-initiated "Sync" arrives via `notify` and triggers a full reconcile;
        // the periodic `interval` tick stays incremental.
        let force_full = tokio::select! {
            _ = interval.tick() => false,
            _ = notify.notified() => true,
        };

        // No token yet: skip quietly instead of burning a 401 + SYNC_ERROR
        // toast every cycle. The worker is respawned when a token is saved.
        if !gh.has_token() {
            continue;
        }

        // Check rate budget — if paused, skip this cycle.
        if let Err(AdeError::RateLimited(_)) = rate_budget.check().await {
            let _ = app.emit(
                "evt:sync",
                serde_json::json!({
                    "workspace_id": &workspace_id,
                    "status": "error",
                    "last_sync": serde_json::Value::Null,
                }),
            );
            continue;
        }

        // Emit syncing status
        let _ = app.emit(
            "evt:sync",
            serde_json::json!({
                "workspace_id": &workspace_id,
                "status": "syncing",
                "last_sync": serde_json::Value::Null,
            }),
        );

        let notifier = AppNotifier(app.clone());
        match run_cycle(&db, &gh, &workspace_id, &notifier, &rate_budget, force_full).await {
            Ok(result) => {
                // If seed and issue count > 500, emit ISSUE_LIST_LARGE
                if result.was_seed && result.issue_count > 500 {
                    crate::notify::emit_notify(
                        &app,
                        "warn",
                        "ISSUE_LIST_LARGE",
                        &format!(
                            "workspace {} has {} issues; initial sync may take a while",
                            workspace_id, result.issue_count
                        ),
                    );
                }

                // Look up owner/repo once for the post-cycle hooks. A lookup
                // failure skips the hooks but must NOT skip the trailing
                // "idle" emit, or the UI stays stuck on "syncing".
                let ws: Option<crate::models::Workspace> =
                    crate::repo::workspace_by_id(&db, &workspace_id).await.ok();
                let owner_repo = ws
                    .as_ref()
                    .and_then(|ws| Some((ws.github_owner.as_ref()?, ws.github_repo.as_ref()?)));

                // If seed, ensure labels once
                if result.was_seed {
                    if let Some((owner, repo)) = owner_repo {
                        if let Ok(()) = gh.ensure_labels(owner, repo).await {
                            let _ = sqlx::query(
                                "UPDATE sync_state SET labels_ensured = 1 WHERE workspace_id = ?",
                            )
                            .bind(&workspace_id)
                            .execute(&db)
                            .await;
                        }
                    }
                }

                // M5-T4: Send outbox intents (§13.1 sender pass)
                if let Some((owner, repo)) = owner_repo {
                    if let Err(e) = outbox::send_outbox(
                        &db,
                        &gh,
                        owner,
                        repo,
                        &workspace_id,
                        &notifier,
                        &rate_budget,
                    )
                    .await
                    {
                        if let AdeError::RateLimited(ref hint) = e {
                            rate_budget
                                .pause_until(Instant::now() + rate_limit_pause(hint))
                                .await;
                            crate::notify::emit_notify(
                                &app,
                                "warn",
                                "RATE_LIMITED",
                                "GitHub rate limit hit during outbox send; pausing sync",
                            );
                        } else {
                            crate::notify::emit_notify(
                                &app,
                                "error",
                                "OUTBOX_SEND_ERROR",
                                &format!("outbox send failed: {}", e),
                            );
                        }
                    }
                }

                // Get current last_sync for the event
                let last_sync: Option<String> = sqlx::query_scalar::<_, String>(
                    "SELECT last_sync FROM sync_state WHERE workspace_id = ?",
                )
                .bind(&workspace_id)
                .fetch_optional(&db)
                .await
                .ok()
                .flatten();

                let _ = app.emit(
                    "evt:sync",
                    serde_json::json!({
                        "workspace_id": workspace_id,
                        "status": "idle",
                        "last_sync": last_sync,
                    }),
                );
            }
            Err(AdeError::RateLimited(ref hint)) => {
                // Pause until the reset hinted by the rate-limit headers
                // (x-ratelimit-reset epoch or retry-after delta), with a 60s
                // fallback when the hint isn't parseable.
                rate_budget
                    .pause_until(Instant::now() + rate_limit_pause(hint))
                    .await;
                crate::notify::emit_notify(
                    &app,
                    "warn",
                    "RATE_LIMITED",
                    "GitHub rate limit hit; pausing sync",
                );
                // Keep showing the last successful sync time in the UI.
                let last_sync: Option<String> = sqlx::query_scalar::<_, String>(
                    "SELECT last_sync FROM sync_state WHERE workspace_id = ?",
                )
                .bind(&workspace_id)
                .fetch_optional(&db)
                .await
                .ok()
                .flatten();
                let _ = app.emit(
                    "evt:sync",
                    serde_json::json!({
                        "workspace_id": workspace_id,
                        "status": "error",
                        "last_sync": last_sync,
                    }),
                );
            }
            Err(e) => {
                crate::notify::emit_notify(&app, "error", "SYNC_ERROR", &e.to_string());
                let last_sync: Option<String> = sqlx::query_scalar::<_, String>(
                    "SELECT last_sync FROM sync_state WHERE workspace_id = ?",
                )
                .bind(&workspace_id)
                .fetch_optional(&db)
                .await
                .ok()
                .flatten();
                let _ = app.emit(
                    "evt:sync",
                    serde_json::json!({
                        "workspace_id": workspace_id,
                        "status": "error",
                        "last_sync": last_sync,
                    }),
                );
            }
        }
    }
}

/// Translate the hint carried by `AdeError::RateLimited` into a pause duration.
/// The hint is either `x-ratelimit-reset` (unix epoch seconds) or `retry-after`
/// (delta seconds). Unparseable hints fall back to 60s; pauses cap at 1h.
fn rate_limit_pause(hint: &str) -> Duration {
    const FALLBACK_SECS: u64 = 60;
    const MAX_SECS: u64 = 3600;
    let secs = match hint.trim().parse::<i64>() {
        // Values this large are an epoch timestamp, not a delta.
        Ok(v) if v > 1_000_000_000 => (v - Utc::now().timestamp()).max(1) as u64,
        Ok(v) if v > 0 => v as u64,
        _ => FALLBACK_SECS,
    };
    Duration::from_secs(secs.min(MAX_SECS))
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
        let rate_budget = RateBudget::new();
        let result = run_cycle(&pool, &gh, &ws_id, &notifier, &rate_budget, false).await;
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
        let rate_budget = RateBudget::new();
        run_cycle(&pool, &gh, &ws_id, &notifier, &rate_budget, false)
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
        let rate_budget = RateBudget::new();
        let result = run_cycle(&pool, &gh, &ws_id, &notifier, &rate_budget, false).await;
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
        let rate_budget = RateBudget::new();
        let result = run_cycle(&pool, &gh, &ws_id, &notifier, &rate_budget, false).await;
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

    // -----------------------------------------------------------------------
    // M5-T3: seed then incremental — verify incremental fetch uses `since`
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn seed_then_incremental() {
        let (pool, _tmp) = test_pool().await;
        let (ws_id, _col_ids) = seed_workspace(&pool).await;

        // Wiremock for seed: return 3 open issues
        let server = wiremock::MockServer::start().await;

        let issue1 = issue_json(101, "open", &[], "2025-06-01T00:00:00Z");
        let issue2 = issue_json(102, "open", &[], "2025-06-01T00:00:00Z");
        let issue3 = issue_json(103, "open", &[], "2025-06-01T00:00:00Z");
        let seed_body = serde_json::to_string(&vec![issue1, issue2, issue3]).expect("json");

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::query_param("state", "open"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_string(&seed_body))
            .mount(&server)
            .await;

        let gh = GitHubClient::new(server.uri(), "test-token".to_string());
        let notifier = CaptureNotifier::new();
        let rate_budget = RateBudget::new();

        // Seed cycle — no last_sync
        let result = run_cycle(&pool, &gh, &ws_id, &notifier, &rate_budget, false)
            .await
            .expect("seed cycle");
        assert!(result.was_seed, "first cycle should be a seed");
        assert_eq!(result.issue_count, 3);

        // Verify last_sync is set
        let last_sync: String = sqlx::query_scalar::<_, String>(
            "SELECT last_sync FROM sync_state WHERE workspace_id = ?",
        )
        .bind(&ws_id)
        .fetch_one(&pool)
        .await
        .expect("last_sync");
        assert!(!last_sync.is_empty(), "last_sync should be set after seed");

        // Verify 3 cards were created
        let card_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM card WHERE workspace_id = ?")
                .bind(&ws_id)
                .fetch_one(&pool)
                .await
                .expect("card count");
        assert_eq!(card_count, 3, "should have 3 cards after seed");

        // Now set up wiremock for incremental fetch — return 1 new issue (#104)
        // and the existing issue #102 with updated labels
        // We need to reset the server mock
        let server2 = wiremock::MockServer::start().await;
        let issue4 = issue_json(104, "open", &[], "2025-06-02T00:00:00Z");
        let incremental_body = serde_json::to_string(&vec![issue4]).expect("json");

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::query_param("state", "all"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_string(&incremental_body))
            .mount(&server2)
            .await;

        let gh2 = GitHubClient::new(server2.uri(), "test-token".to_string());

        // Incremental cycle — has last_sync
        let result2 = run_cycle(&pool, &gh2, &ws_id, &notifier, &rate_budget, false)
            .await
            .expect("incremental cycle");
        assert!(!result2.was_seed, "second cycle should be incremental");

        // Verify the new card appears
        let card_count2: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM card WHERE workspace_id = ?")
                .bind(&ws_id)
                .fetch_one(&pool)
                .await
                .expect("card count");
        assert_eq!(card_count2, 4, "should have 4 cards after incremental");

        // Verify the since parameter was sent
        // We check the wiremock request log
        let requests = server2.received_requests().await.expect("requests");
        assert!(!requests.is_empty(), "should have received requests");
        let request_url = &requests[0].url;
        assert!(
            request_url.query().unwrap_or("").contains("since="),
            "incremental fetch should include since parameter, got: {:?}",
            request_url.query()
        );
    }

    // -----------------------------------------------------------------------
    // issue #10: a manual "Sync" (force_full) does an authoritative full fetch
    // (state=all, no `since`) and recovers an issue stranded behind the watermark.
    // An incremental cycle with the same watermark would never see it because the
    // issue's updated_at is older than last_sync.
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn manual_sync_full_recovers_stranded_issue() {
        let (pool, _tmp) = test_pool().await;
        let (ws_id, _col_ids) = seed_workspace(&pool).await;

        // Watermark is AHEAD of the stranded issue's updated_at.
        sqlx::query("INSERT INTO sync_state (workspace_id, last_sync) VALUES (?, ?)")
            .bind(&ws_id)
            .bind("2025-06-10T00:00:00Z")
            .execute(&pool)
            .await
            .expect("insert sync_state");

        // Stranded open issue: updated_at (2025-06-01) is BEFORE the watermark, so a
        // real incremental `since=2025-06-10` fetch would never return it.
        let stranded = issue_json(200, "open", &[], "2025-06-01T00:00:00Z");
        let body = serde_json::to_string(&vec![stranded]).expect("json");

        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::query_param("state", "all"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_string(&body))
            .mount(&server)
            .await;

        let gh = GitHubClient::new(server.uri(), "test-token".to_string());
        let notifier = CaptureNotifier::new();
        let rate_budget = RateBudget::new();

        // Manual sync: force_full = true.
        let result = run_cycle(&pool, &gh, &ws_id, &notifier, &rate_budget, true)
            .await
            .expect("full cycle");
        assert!(
            !result.was_seed,
            "a workspace with last_sync is not a seed even on a full sync"
        );

        // The stranded issue was recovered as a card.
        let card_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM card WHERE workspace_id = ? AND github_issue_number = 200",
        )
        .bind(&ws_id)
        .fetch_one(&pool)
        .await
        .expect("card count");
        assert_eq!(card_count, 1, "full sync should recover the stranded issue");

        // The full fetch must NOT carry a `since` watermark.
        let requests = server.received_requests().await.expect("requests");
        assert!(!requests.is_empty(), "should have received a request");
        let query = requests[0].url.query().unwrap_or("");
        assert!(
            query.contains("state=all"),
            "full fetch should request state=all, got: {query}"
        );
        assert!(
            !query.contains("since="),
            "full fetch must NOT include a since watermark, got: {query}"
        );
    }

    // -----------------------------------------------------------------------
    // M5-T3: rate budget pause test
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn rate_budget_pause() {
        let budget = RateBudget::new();

        // Initially not paused
        assert!(
            budget.check().await.is_ok(),
            "should not be paused initially"
        );

        // Set pause to future
        budget
            .pause_until(Instant::now() + Duration::from_secs(300))
            .await;

        // Check should return RateLimited
        let result = budget.check().await;
        assert!(
            matches!(result, Err(AdeError::RateLimited(_))),
            "should be rate limited when paused"
        );

        // Clear the pause
        budget.clear().await;

        // Check should return Ok now
        assert!(
            budget.check().await.is_ok(),
            "should not be paused after clear"
        );

        // Set a past instant — should be expired, check returns Ok
        budget
            .pause_until(Instant::now() - Duration::from_secs(1))
            .await;
        assert!(
            budget.check().await.is_ok(),
            "expired pause should return Ok"
        );
    }
}
