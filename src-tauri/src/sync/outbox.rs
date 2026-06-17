use crate::db::DbPool;
use crate::error::AdeError;
use crate::gh::client::GitHubClient;
use crate::gh::types::ColumnName;
use crate::models::Card;
use crate::sync::notifier::Notifier;
use crate::sync::rate::RateBudget;
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OutboxRow {
    pub card_id: String,
    #[allow(dead_code)] // populated by FromRow; read only in tests
    pub intent: String,
    pub payload_json: String,
    pub base_remote_updated_at: String,
    pub attempts: i64,
    #[allow(dead_code)] // populated by FromRow; read only in tests
    pub last_error: Option<String>,
    pub last_attempt_at: Option<String>,
    pub created_at: String,
}

pub async fn enqueue(
    db: &DbPool,
    card_id: &str,
    from_column: &str,
    to_column: &str,
    base_remote_updated_at: &str,
) -> Result<(), AdeError> {
    let now = Utc::now().to_rfc3339();

    // If an intent is already pending for this card, merge instead of
    // replacing wholesale: the remote still reflects the ORIGINAL source
    // column, so the conflict check (§13 step 1) must keep comparing against
    // it. Replacing `from` with the latest local column would make two quick
    // legitimate drags look like a remote conflict and revert the user's move.
    let existing: Option<OutboxRow> = sqlx::query_as::<_, OutboxRow>(
        "SELECT card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at FROM outbox WHERE card_id = ?",
    )
    .bind(card_id)
    .fetch_optional(db)
    .await
    .map_err(AdeError::Db)?;

    let (effective_from, base_remote, created_at) = match &existing {
        Some(row) => {
            let original_from = serde_json::from_str::<serde_json::Value>(&row.payload_json)
                .ok()
                .and_then(|p| {
                    p.get("from_column_name")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or_else(|| from_column.to_string());
            (
                original_from,
                row.base_remote_updated_at.clone(),
                row.created_at.clone(),
            )
        }
        None => (
            from_column.to_string(),
            base_remote_updated_at.to_string(),
            now.clone(),
        ),
    };

    // Moving back to the original column cancels out: nothing to push.
    if effective_from == to_column {
        return resolve(db, card_id).await;
    }

    let payload_json = serde_json::json!({
        "from_column_name": effective_from,
        "to_column_name": to_column,
    })
    .to_string();

    sqlx::query(
        "INSERT OR REPLACE INTO outbox (card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at)
         VALUES (?, 'set_column', ?, ?, 0, NULL, NULL, ?)",
    )
    .bind(card_id)
    .bind(&payload_json)
    .bind(&base_remote)
    .bind(&created_at)
    .execute(db)
    .await
    .map_err(AdeError::Db)?;

    Ok(())
}

/// Load every pending intent for a workspace, regardless of backoff/due state.
/// Reconcile suspension (§12 Row 4) and conflict-drop (§13 step 1) must consider
/// ALL pending rows — `due()` only governs when the network sender retries.
pub async fn all_for_workspace(
    db: &DbPool,
    workspace_id: &str,
) -> Result<Vec<OutboxRow>, AdeError> {
    let rows: Vec<OutboxRow> = sqlx::query_as::<_, OutboxRow>(
        "SELECT o.card_id, o.intent, o.payload_json, o.base_remote_updated_at, o.attempts, o.last_error, o.last_attempt_at, o.created_at
         FROM outbox o JOIN card c ON c.id = o.card_id
         WHERE c.workspace_id = ?",
    )
    .bind(workspace_id)
    .fetch_all(db)
    .await
    .map_err(AdeError::Db)?;

    Ok(rows)
}

/// Retry backoff schedule (seconds) indexed by attempt count.
const BACKOFF_SCHEDULE_SECS: [i64; 4] = [0, 5, 30, 120];
const BACKOFF_MAX_SECS: i64 = 600;

pub async fn due(db: &DbPool, now: &str, workspace_id: &str) -> Result<Vec<OutboxRow>, AdeError> {
    let now_dt: DateTime<Utc> = now
        .parse()
        .map_err(|e| AdeError::Other(format!("invalid now timestamp: {}", e)))?;

    // Scoped to the workspace: each worker only sends its own intents
    // (it holds that workspace's column map for conflict reverts).
    let rows: Vec<OutboxRow> = sqlx::query_as::<_, OutboxRow>(
        "SELECT o.card_id, o.intent, o.payload_json, o.base_remote_updated_at, o.attempts, o.last_error, o.last_attempt_at, o.created_at
         FROM outbox o JOIN card c ON c.id = o.card_id
         WHERE c.workspace_id = ?",
    )
    .bind(workspace_id)
    .fetch_all(db)
    .await
    .map_err(AdeError::Db)?;

    let mut due_rows = Vec::new();

    for row in rows {
        let is_due = if row.attempts == 0 {
            let created: DateTime<Utc> = row
                .created_at
                .parse()
                .map_err(|e| AdeError::Other(format!("invalid created_at: {}", e)))?;
            now_dt >= created
        } else {
            let delay_secs = BACKOFF_SCHEDULE_SECS
                .get(row.attempts as usize)
                .copied()
                .unwrap_or(BACKOFF_MAX_SECS);

            let ref_str = row.last_attempt_at.as_deref().unwrap_or(&row.created_at);
            let ref_time: DateTime<Utc> = ref_str
                .parse()
                .map_err(|e| AdeError::Other(format!("invalid timestamp: {}", e)))?;

            let elapsed = now_dt.signed_duration_since(ref_time).num_seconds();
            elapsed >= delay_secs
        };

        if is_due {
            due_rows.push(row);
        }
    }

    Ok(due_rows)
}

pub async fn record_failure(
    db: &DbPool,
    card_id: &str,
    error: &str,
    now: &str,
) -> Result<(), AdeError> {
    sqlx::query(
        "UPDATE outbox SET attempts = attempts + 1, last_error = ?, last_attempt_at = ? WHERE card_id = ?",
    )
    .bind(error)
    .bind(now)
    .bind(card_id)
    .execute(db)
    .await
    .map_err(AdeError::Db)?;

    Ok(())
}

pub async fn resolve(db: &DbPool, card_id: &str) -> Result<(), AdeError> {
    sqlx::query("DELETE FROM outbox WHERE card_id = ?")
        .bind(card_id)
        .execute(db)
        .await
        .map_err(AdeError::Db)?;

    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────

/// Compute the desired column from a card's cached `github_state` and `labels_json`.
/// Mirrors `engine::desired_column` but works on DB fields instead of `RemoteIssue`.
/// Closed → Done; has kanban:doing → Doing; kanban:paused → Paused;
/// kanban:pr → Pr; else → Backlog.
pub fn desired_column_from_labels_state(
    github_state: Option<&str>,
    labels_json: Option<&str>,
) -> ColumnName {
    if github_state == Some("closed") {
        return ColumnName::Done;
    }
    if let Some(lj) = labels_json {
        if let Ok(labels) = serde_json::from_str::<Vec<String>>(lj) {
            for label in &labels {
                match label.as_str() {
                    crate::gh::types::KANBAN_DOING => return ColumnName::Doing,
                    crate::gh::types::KANBAN_PAUSED => return ColumnName::Paused,
                    crate::gh::types::KANBAN_PR => return ColumnName::Pr,
                    _ => {}
                }
            }
        }
    }
    ColumnName::Backlog
}

use crate::gh::types::KANBAN_LABELS;

// ── send_outbox ──────────────────────────────────────────────────────

/// Process all due outbox intents by making real GitHub API calls.
/// Per CONTRACTS §13: conflict-check, map to API calls, success → resolve,
/// failure → increment attempts (after 4th → drop & revert).
pub async fn send_outbox(
    db: &DbPool,
    gh: &GitHubClient,
    owner: &str,
    repo: &str,
    workspace_id: &str,
    notifier: &dyn Notifier,
    rate_budget: &RateBudget,
) -> Result<(), AdeError> {
    let now = Utc::now().to_rfc3339();
    let due_rows = due(db, &now, workspace_id).await?;

    // Load column id ↔ name mappings for this workspace.
    let columns: Vec<crate::models::BoardColumn> =
        crate::repo::columns_for_workspace(db, workspace_id).await?;

    let mut col_id_by_name: std::collections::HashMap<ColumnName, String> =
        std::collections::HashMap::new();
    for col in &columns {
        let Some(cname) = ColumnName::try_from_str(&col.name) else {
            continue;
        };
        col_id_by_name.insert(cname, col.id.clone());
    }

    for row in due_rows {
        // Load the card from DB.
        let card: Option<Card> = crate::repo::card_by_id(db, &row.card_id).await?;

        let card = match card {
            Some(c) => c,
            None => {
                // Card was deleted; drop the outbox row.
                let _ = resolve(db, &row.card_id).await;
                continue;
            }
        };

        let issue_number = match card.github_issue_number {
            Some(n) => n,
            None => {
                // Not a linked card; shouldn't happen, but skip safely.
                continue;
            }
        };

        // Parse payload.
        let payload: serde_json::Value = match serde_json::from_str(&row.payload_json) {
            Ok(v) => v,
            Err(e) => {
                let err_msg = format!("invalid outbox payload: {}", e);
                record_failure(db, &row.card_id, &err_msg, &now).await?;
                continue;
            }
        };
        let from_col_str = match payload.get("from_column_name").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => {
                let err_msg = "outbox payload missing from_column_name".to_string();
                record_failure(db, &row.card_id, &err_msg, &now).await?;
                continue;
            }
        };
        let to_col_str = match payload.get("to_column_name").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => {
                let err_msg = "outbox payload missing to_column_name".to_string();
                record_failure(db, &row.card_id, &err_msg, &now).await?;
                continue;
            }
        };
        let from_column = match ColumnName::try_from_str(from_col_str) {
            Some(c) => c,
            None => {
                let err = format!("unknown column name: {}", from_col_str);
                record_failure(db, &row.card_id, &err, &now).await?;
                continue;
            }
        };
        let to_column = match ColumnName::try_from_str(to_col_str) {
            Some(c) => c,
            None => {
                let err = format!("unknown column name: {}", to_col_str);
                record_failure(db, &row.card_id, &err, &now).await?;
                continue;
            }
        };

        // Step 1 — Conflict check: re-check the card's cached state against from_column.
        let desired = desired_column_from_labels_state(
            card.github_state.as_deref(),
            card.labels_json.as_deref(),
        );
        if desired != from_column {
            // Genuine column conflict: drop intent, revert card to desired column, notify.
            resolve(db, &row.card_id).await?;

            // Move card back to the desired column.
            if let Some(col_id) = col_id_by_name.get(&desired) {
                sqlx::query("UPDATE card SET column_id = ?, updated_at = ? WHERE id = ?")
                    .bind(col_id)
                    .bind(&now)
                    .bind(&row.card_id)
                    .execute(db)
                    .await
                    .map_err(AdeError::Db)?;
            }

            notifier.notify(
                "warn",
                "INTENT_DROPPED",
                &format!(
                    "issue #{} was moved on GitHub; your move was discarded",
                    issue_number
                ),
            );
            continue;
        }

        // Step 2 — Map intent to API calls (§13.2).
        // Check rate budget before making API calls.
        rate_budget.check().await?;

        let result = execute_outbox_intent(
            gh,
            owner,
            repo,
            issue_number as u64,
            &from_column,
            &to_column,
            rate_budget,
        )
        .await;

        match result {
            Ok(outbox_result) => {
                // Step 3 — Success: delete outbox row, update cached card fields.
                resolve(db, &row.card_id).await?;
                let labels_json = serde_json::to_string(&outbox_result.labels)
                    .map_err(|e| AdeError::Other(format!("labels json: {}", e)))?;
                sqlx::query(
                    "UPDATE card SET remote_updated_at = ?, github_state = ?, labels_json = ?, updated_at = ? WHERE id = ?",
                )
                .bind(&outbox_result.updated_at)
                .bind(&outbox_result.state)
                .bind(&labels_json)
                .bind(&now)
                .bind(&row.card_id)
                .execute(db)
                .await
                .map_err(AdeError::Db)?;
            }
            Err(e @ AdeError::RateLimited(_)) => {
                // Propagate rate limit upward (keeping the reset hint) —
                // the worker loop handles pausing.
                return Err(e);
            }
            Err(e) => {
                // Step 4 — Failure: increment attempts.
                let new_attempts = row.attempts + 1;
                if new_attempts >= 4 {
                    // Drop the outbox row, revert card to remote state, notify.
                    resolve(db, &row.card_id).await?;

                    // Compute desired_column from cached labels/state.
                    let revert_col = desired_column_from_labels_state(
                        card.github_state.as_deref(),
                        card.labels_json.as_deref(),
                    );
                    if let Some(col_id) = col_id_by_name.get(&revert_col) {
                        sqlx::query("UPDATE card SET column_id = ?, updated_at = ? WHERE id = ?")
                            .bind(col_id)
                            .bind(&now)
                            .bind(&row.card_id)
                            .execute(db)
                            .await
                            .map_err(AdeError::Db)?;
                    }

                    notifier.notify(
                        "error",
                        "SYNC_WRITE_FAILED",
                        &format!(
                            "outbox write for issue #{} failed after 4 attempts: {}",
                            issue_number, e
                        ),
                    );
                } else {
                    // Record failure and continue.
                    record_failure(db, &row.card_id, &e.to_string(), &now).await?;
                }
            }
        }
    }

    Ok(())
}

/// Result of successfully executing an outbox intent: the updated issue's
/// `updated_at`, `state`, and `labels` from the re-fetch.
struct OutboxResult {
    updated_at: String,
    state: String,
    labels: Vec<String>,
}

/// Execute the GitHub API calls for a single outbox intent.
/// Returns the issue's updated fields from the re-fetch on success.
async fn execute_outbox_intent(
    gh: &GitHubClient,
    owner: &str,
    repo: &str,
    issue_number: u64,
    from_column: &ColumnName,
    to_column: &ColumnName,
    rate_budget: &RateBudget,
) -> Result<OutboxResult, AdeError> {
    match (from_column, to_column) {
        // Target column is Done: remove all kanban labels + close the issue.
        (_, ColumnName::Done) => {
            rate_budget.check().await?;
            for &label in KANBAN_LABELS {
                gh.remove_label(owner, repo, issue_number, label).await?;
            }
            rate_budget.check().await?;
            gh.set_issue_state(owner, repo, issue_number, "closed")
                .await?;
        }
        // Source column is Done (target is non-Done): reopen + add target kanban label.
        (ColumnName::Done, _) => {
            rate_budget.check().await?;
            gh.set_issue_state(owner, repo, issue_number, "open")
                .await?;
            if let Some(label) = to_column.kanban_label() {
                rate_budget.check().await?;
                gh.add_label(owner, repo, issue_number, label).await?;
            }
        }
        // Target column is Backlog: remove all kanban labels only (no close).
        (_, ColumnName::Backlog) => {
            for &label in KANBAN_LABELS {
                rate_budget.check().await?;
                gh.remove_label(owner, repo, issue_number, label).await?;
            }
        }
        // Otherwise (both non-Done, non-Backlog): remove source label + add target label.
        (_, _) => {
            if let Some(from_label) = from_column.kanban_label() {
                rate_budget.check().await?;
                gh.remove_label(owner, repo, issue_number, from_label)
                    .await?;
            }
            if let Some(to_label) = to_column.kanban_label() {
                rate_budget.check().await?;
                gh.add_label(owner, repo, issue_number, to_label).await?;
            }
        }
    }

    // Re-fetch the issue to get updated_at, state, and labels.
    rate_budget.check().await?;
    let issue = gh.get_issue(owner, repo, issue_number).await?;
    Ok(OutboxResult {
        updated_at: issue.updated_at,
        state: issue.state,
        labels: issue.labels,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn test_pool() -> (DbPool, tempfile::TempDir) {
        let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let tmp = tempfile::tempdir_in(&dir).unwrap();
        let path = tmp.path().join("test.db");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();

        sqlx::query(
            "CREATE TABLE workspace (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                slug TEXT NOT NULL UNIQUE,
                root_path TEXT NOT NULL,
                github_owner TEXT,
                github_repo TEXT,
                startup_command TEXT,
                created_at TEXT NOT NULL
            );",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "CREATE TABLE card (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
                column_id TEXT NOT NULL,
                title TEXT NOT NULL,
                body_preview TEXT,
                position REAL NOT NULL,
                source TEXT NOT NULL CHECK (source IN ('local','github')),
                github_issue_number INTEGER,
                github_state TEXT CHECK (github_state IN ('open','closed')),
                assignee TEXT,
                labels_json TEXT,
                remote_updated_at TEXT,
                terminal_window_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "CREATE TABLE outbox (
                card_id TEXT PRIMARY KEY REFERENCES card(id) ON DELETE CASCADE,
                intent TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                base_remote_updated_at TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                last_attempt_at TEXT,
                created_at TEXT NOT NULL
            );",
        )
        .execute(&pool)
        .await
        .unwrap();

        (pool, tmp)
    }

    async fn seed_workspace_and_card(pool: &DbPool) -> (String, String) {
        let ws_id = uuid::Uuid::new_v4().to_string();
        let card_id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        sqlx::query(
            "INSERT INTO workspace (id, name, slug, root_path, created_at) VALUES (?1, 'Dev', 'dev', '/tmp/dev', ?2)",
        )
        .bind(&ws_id)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, position, source, created_at, updated_at) VALUES (?1, ?2, 'col1', 'Test card', 1.0, 'local', ?3, ?3)",
        )
        .bind(&card_id)
        .bind(&ws_id)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();

        (ws_id, card_id)
    }

    #[tokio::test]
    async fn double_enqueue_keeps_one_row() {
        let (pool, _tmp) = test_pool().await;
        let (_ws_id, card_id) = seed_workspace_and_card(&pool).await;

        let base_remote = Utc::now().to_rfc3339();

        enqueue(&pool, &card_id, "Backlog", "Doing", &base_remote)
            .await
            .unwrap();

        enqueue(&pool, &card_id, "Doing", "Paused", &base_remote)
            .await
            .unwrap();

        let rows: Vec<OutboxRow> = sqlx::query_as::<_, OutboxRow>(
            "SELECT card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at FROM outbox",
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(
            rows.len(),
            1,
            "should have exactly one row after double enqueue"
        );
        assert_eq!(rows[0].card_id, card_id);
        assert_eq!(rows[0].attempts, 0);
        // The merged intent keeps the ORIGINAL source column (the remote still
        // reflects Backlog) and only updates the destination.
        let payload: serde_json::Value = serde_json::from_str(&rows[0].payload_json).unwrap();
        assert_eq!(payload["from_column_name"], "Backlog");
        assert_eq!(payload["to_column_name"], "Paused");
    }

    #[tokio::test]
    async fn enqueue_back_to_origin_cancels_intent() {
        let (pool, _tmp) = test_pool().await;
        let (_ws_id, card_id) = seed_workspace_and_card(&pool).await;

        let base_remote = Utc::now().to_rfc3339();

        enqueue(&pool, &card_id, "Backlog", "Doing", &base_remote)
            .await
            .unwrap();
        enqueue(&pool, &card_id, "Doing", "Backlog", &base_remote)
            .await
            .unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbox WHERE card_id = ?")
            .bind(&card_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "moving back to the origin cancels the intent");
    }

    #[tokio::test]
    async fn backoff_schedule_respected() {
        let (pool, _tmp) = test_pool().await;
        let (ws_id, card_id) = seed_workspace_and_card(&pool).await;
        let now = Utc::now();

        // Row with attempts=1, last_attempt_at=30 seconds ago -> due (30s >= 5s)
        let past_30s = (now - chrono::Duration::seconds(30)).to_rfc3339();
        sqlx::query(
            "INSERT INTO outbox (card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at)
             VALUES (?1, 'set_column', '{}', ?2, 1, NULL, ?3, ?4)",
        )
        .bind(&card_id)
        .bind(&past_30s)
        .bind(&past_30s)
        .bind(&past_30s)
        .execute(&pool)
        .await
        .unwrap();

        let now_str = now.to_rfc3339();
        let due_rows = due(&pool, &now_str, &ws_id).await.unwrap();
        assert_eq!(due_rows.len(), 1, "attempts=1 with 30s elapsed is due");

        // Row with attempts=2, last_attempt_at=20 seconds ago -> NOT due (20s < 30s)
        let (pool2, _tmp2) = test_pool().await;
        let (ws2, card_id2) = seed_workspace_and_card(&pool2).await;
        let past_20s = (now - chrono::Duration::seconds(20)).to_rfc3339();
        sqlx::query(
            "INSERT INTO outbox (card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at)
             VALUES (?1, 'set_column', '{}', ?2, 2, NULL, ?3, ?4)",
        )
        .bind(&card_id2)
        .bind(&past_20s)
        .bind(&past_20s)
        .bind(&past_20s)
        .execute(&pool2)
        .await
        .unwrap();

        let due_rows2 = due(&pool2, &now_str, &ws2).await.unwrap();
        assert!(
            due_rows2.is_empty(),
            "attempts=2 with 20s elapsed is NOT due (needs 30s)"
        );

        // Row with attempts=0 -> due immediately
        let (pool3, _tmp3) = test_pool().await;
        let (ws3, card_id3) = seed_workspace_and_card(&pool3).await;
        let past_60s = (now - chrono::Duration::seconds(60)).to_rfc3339();
        sqlx::query(
            "INSERT INTO outbox (card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at)
             VALUES (?1, 'set_column', '{}', ?2, 0, NULL, NULL, ?3)",
        )
        .bind(&card_id3)
        .bind(&past_60s)
        .bind(&past_60s)
        .execute(&pool3)
        .await
        .unwrap();

        let due_rows3 = due(&pool3, &now_str, &ws3).await.unwrap();
        assert_eq!(due_rows3.len(), 1, "attempts=0 is always due");
    }

    #[tokio::test]
    async fn record_failure_increments() {
        let (pool, _tmp) = test_pool().await;
        let (_ws_id, card_id) = seed_workspace_and_card(&pool).await;
        let now = Utc::now().to_rfc3339();

        // Insert an outbox row with attempts=0
        sqlx::query(
            "INSERT INTO outbox (card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at)
             VALUES (?1, 'set_column', '{}', ?2, 0, NULL, NULL, ?2)",
        )
        .bind(&card_id)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        let fail_time = Utc::now().to_rfc3339();
        record_failure(&pool, &card_id, "network error", &fail_time)
            .await
            .unwrap();

        let row: OutboxRow = sqlx::query_as::<_, OutboxRow>(
            "SELECT card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at FROM outbox WHERE card_id = ?",
        )
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(row.attempts, 1);
        assert_eq!(row.last_error.as_deref(), Some("network error"));
        assert_eq!(row.last_attempt_at.as_deref(), Some(fail_time.as_str()));
    }

    #[tokio::test]
    async fn resolve_removes_row() {
        let (pool, _tmp) = test_pool().await;
        let (_ws_id, card_id) = seed_workspace_and_card(&pool).await;
        let now = Utc::now().to_rfc3339();

        sqlx::query(
            "INSERT INTO outbox (card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at)
             VALUES (?1, 'set_column', '{}', ?2, 0, NULL, NULL, ?2)",
        )
        .bind(&card_id)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        resolve(&pool, &card_id).await.unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbox WHERE card_id = ?")
            .bind(&card_id)
            .fetch_one(&pool)
            .await
            .unwrap();

        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn fourth_failure_flag() {
        let (pool, _tmp) = test_pool().await;
        let (ws_id, card_id) = seed_workspace_and_card(&pool).await;
        let now = Utc::now();
        // attempts=3, last_attempt_at=11 minutes ago -> still due (10m delay elapsed)
        let past_11m = (now - chrono::Duration::seconds(660)).to_rfc3339();
        sqlx::query(
            "INSERT INTO outbox (card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at)
             VALUES (?1, 'set_column', '{}', ?2, 3, NULL, ?3, ?4)",
        )
        .bind(&card_id)
        .bind(&past_11m)
        .bind(&past_11m)
        .bind(&past_11m)
        .execute(&pool)
        .await
        .unwrap();

        let now_str = now.to_rfc3339();
        let due_rows = due(&pool, &now_str, &ws_id).await.unwrap();
        assert_eq!(
            due_rows.len(),
            1,
            "attempts=3 with 11m elapsed is due (10m delay)"
        );
    }

    // ── M5-T4: send_outbox integration tests ──────────────────────────

    /// Helper: create a test pool with board_column table for send_outbox tests.
    async fn test_pool_with_columns() -> (DbPool, tempfile::TempDir) {
        let (pool, tmp) = test_pool().await;

        sqlx::query(
            "CREATE TABLE board_column (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                position INTEGER NOT NULL
            );",
        )
        .execute(&pool)
        .await
        .unwrap();

        (pool, tmp)
    }

    /// Helper: seed a workspace with 5 board columns and return (ws_id, col_id_map).
    async fn seed_workspace_with_columns(
        pool: &DbPool,
    ) -> (String, std::collections::HashMap<ColumnName, String>) {
        let ws_id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        sqlx::query(
            "INSERT INTO workspace (id, name, slug, root_path, github_owner, github_repo, created_at) VALUES (?1, 'Dev', 'dev', '/tmp/dev', 'owner', 'repo', ?2)",
        )
        .bind(&ws_id)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();

        let columns = [
            ("Backlog", 0i64),
            ("Doing", 1),
            ("Paused", 2),
            ("PR", 3),
            ("Done", 4),
        ];

        let mut col_id_by_name = std::collections::HashMap::new();
        for (name, pos) in &columns {
            let col_id = uuid::Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO board_column (id, workspace_id, name, position) VALUES (?1, ?2, ?3, ?4)",
            )
            .bind(&col_id)
            .bind(&ws_id)
            .bind(*name)
            .bind(*pos)
            .execute(pool)
            .await
            .unwrap();

            let cname = match *name {
                "Backlog" => ColumnName::Backlog,
                "Doing" => ColumnName::Doing,
                "Paused" => ColumnName::Paused,
                "PR" => ColumnName::Pr,
                "Done" => ColumnName::Done,
                _ => unreachable!(),
            };
            col_id_by_name.insert(cname, col_id);
        }

        (ws_id, col_id_by_name)
    }

    /// Spike 4: Move Doing→Done issues close call + label removal.
    /// Card in Doing column with github_issue_number=42, source=github,
    /// labels_json='["kanban:doing"]', github_state='open'.
    /// Enqueue outbox intent: from=Doing, to=Done.
    /// Wiremock: mock set_issue_state("closed") → 200, remove_label("kanban:doing") → 204.
    /// Assert: outbox row deleted, card moved to Done column, card's github_state = "closed".
    #[tokio::test]
    async fn send_outbox_doing_to_done() {
        use crate::sync::notifier::CaptureNotifier;
        use wiremock::matchers::{body_json, method as match_method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let (pool, _tmp) = test_pool_with_columns().await;
        let (ws_id, col_ids) = seed_workspace_with_columns(&pool).await;

        let card_id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let done_col_id = col_ids.get(&ColumnName::Done).unwrap().clone();

        // Card in Doing column, optimistically moved to Done by the UI.
        // DB: column_id = Done (optimistic), but labels_json still has "kanban:doing",
        // github_state = "open" — the labels haven't been pushed to GitHub yet.
        // Actually, for the conflict check, the card's labels_json and github_state
        // represent the *remote* cached state. When we enqueue Doing→Done, the
        // from_column=Doing matches the cached state (labels_json has kanban:doing,
        // github_state=open => desired_column=Doing). So the conflict check passes.
        // The optimistic move puts the card's column_id at Done in the UI.
        // But for the outbox sender, we re-check from_column against cached labels/state.
        sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, position, source, github_issue_number, github_state, labels_json, remote_updated_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'Test card', 1.0, 'github', 42, 'open', '[\"kanban:doing\"]', ?4, ?4, ?4)",
        )
        .bind(&card_id)
        .bind(&ws_id)
        .bind(&done_col_id) // optimistically moved to Done in UI
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        // Enqueue outbox intent: from=Doing, to=Done
        let base_remote = now.clone();
        enqueue(&pool, &card_id, "Doing", "Done", &base_remote)
            .await
            .unwrap();

        let server = MockServer::start().await;

        // Mock: remove_label("kanban:doing") for issue 42 → 204
        Mock::given(match_method("DELETE"))
            .and(path("/repos/owner/repo/issues/42/labels/kanban:doing"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;

        // Mock: remove_label("kanban:paused") for issue 42 → 404 (not present, OK)
        Mock::given(match_method("DELETE"))
            .and(path("/repos/owner/repo/issues/42/labels/kanban:paused"))
            .respond_with(ResponseTemplate::new(404).set_body_string("Not Found"))
            .mount(&server)
            .await;

        // Mock: remove_label("kanban:pr") for issue 42 → 404 (not present, OK)
        Mock::given(match_method("DELETE"))
            .and(path("/repos/owner/repo/issues/42/labels/kanban:pr"))
            .respond_with(ResponseTemplate::new(404).set_body_string("Not Found"))
            .mount(&server)
            .await;

        // Mock: set_issue_state("closed") → 200
        Mock::given(match_method("PATCH"))
            .and(path("/repos/owner/repo/issues/42"))
            .and(body_json(serde_json::json!({ "state": "closed" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "number": 42,
                "title": "Test issue",
                "state": "closed",
                "updated_at": "2025-01-03T00:00:00Z",
                "assignee": null,
                "labels": [],
                "html_url": "https://github.com/owner/repo/issues/42",
                "body": null,
            })))
            .mount(&server)
            .await;

        // Mock: get_issue for re-fetch → 200
        Mock::given(match_method("GET"))
            .and(path("/repos/owner/repo/issues/42"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "number": 42,
                "title": "Test issue",
                "state": "closed",
                "updated_at": "2025-01-03T00:00:00Z",
                "assignee": null,
                "labels": [],
                "html_url": "https://github.com/owner/repo/issues/42",
                "body": null,
            })))
            .mount(&server)
            .await;

        let gh = crate::gh::client::GitHubClient::new(server.uri(), "test-token".to_string());
        let rate_budget = crate::sync::rate::RateBudget::new();
        let notifier = CaptureNotifier::new();

        send_outbox(&pool, &gh, "owner", "repo", &ws_id, &notifier, &rate_budget)
            .await
            .expect("send_outbox should succeed");

        // Assert: outbox row deleted
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbox WHERE card_id = ?")
            .bind(&card_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "outbox row should be deleted after success");

        // Assert: card is in Done column
        let card: Card = sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
        )
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(card.column_id, done_col_id, "card should be in Done column");
        assert_eq!(
            card.github_state.as_deref(),
            Some("closed"),
            "card github_state should be closed"
        );
    }

    /// Spike 5: 4 consecutive failures → row dropped, card reverted, notification captured.
    /// Card in Paused column (optimistically moved from Backlog), github_issue_number=99,
    /// labels_json='[]', github_state='open', remote_updated_at set.
    /// Outbox intent: from=Backlog, to=Paused, attempts=3.
    /// Wiremock: all calls return 500.
    /// Assert: outbox row deleted, card reverted to Backlog, notification SYNC_WRITE_FAILED captured.
    #[tokio::test]
    async fn send_outbox_fourth_failure_reverts() {
        use crate::sync::notifier::CaptureNotifier;
        use wiremock::matchers::{method as match_method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let (pool, _tmp) = test_pool_with_columns().await;
        let (ws_id, col_ids) = seed_workspace_with_columns(&pool).await;

        let card_id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now();
        let past_11m = (now - chrono::Duration::seconds(660)).to_rfc3339();
        let backlog_col_id = col_ids.get(&ColumnName::Backlog).unwrap().clone();
        let paused_col_id = col_ids.get(&ColumnName::Paused).unwrap().clone();

        // Card optimistically in Paused column, but labels_json='[]' and github_state='open'
        // => desired_column = Backlog. from_column=Backlog matches.
        sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, position, source, github_issue_number, github_state, labels_json, remote_updated_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'Test card', 1.0, 'github', 99, 'open', '[]', ?4, ?4, ?4)",
        )
        .bind(&card_id)
        .bind(&ws_id)
        .bind(&paused_col_id) // optimistically in Paused
        .bind(&past_11m)
        .execute(&pool)
        .await
        .unwrap();

        // Outbox intent: from=Backlog, to=Paused, attempts=3
        // Using direct insert so we can set attempts=3
        let payload = serde_json::json!({
            "from_column_name": "Backlog",
            "to_column_name": "Paused",
        })
        .to_string();
        sqlx::query(
            "INSERT INTO outbox (card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at)
             VALUES (?1, 'set_column', ?2, ?3, 3, NULL, ?4, ?4)",
        )
        .bind(&card_id)
        .bind(&payload)
        .bind(&past_11m)
        .bind(&past_11m)
        .execute(&pool)
        .await
        .unwrap();

        // Wiremock: all calls return 500
        let server = MockServer::start().await;

        // Mock: add_label for "kanban:paused" → 500
        Mock::given(match_method("POST"))
            .and(path("/repos/owner/repo/issues/99/labels"))
            .respond_with(ResponseTemplate::new(500).set_body_string("Internal Server Error"))
            .mount(&server)
            .await;

        let gh = crate::gh::client::GitHubClient::new(server.uri(), "test-token".to_string());
        let rate_budget = crate::sync::rate::RateBudget::new();
        let notifier = CaptureNotifier::new();

        // send_outbox should not error (it handles failures internally)
        send_outbox(&pool, &gh, "owner", "repo", &ws_id, &notifier, &rate_budget)
            .await
            .expect("send_outbox should not return error on API failure");

        // Assert: outbox row deleted (dropped after 4th failure)
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbox WHERE card_id = ?")
            .bind(&card_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "outbox row should be deleted after 4th failure");

        // Assert: card reverted to Backlog (desired_column of issue with no labels = Backlog)
        let card: Card = sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
        )
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            card.column_id, backlog_col_id,
            "card should be reverted to Backlog column"
        );

        // Assert: SYNC_WRITE_FAILED notification captured
        let events = notifier.take();
        let sync_write_failed = events
            .iter()
            .any(|(level, code, _)| level == "error" && code == "SYNC_WRITE_FAILED");
        assert!(
            sync_write_failed,
            "should have SYNC_WRITE_FAILED notification, got: {:?}",
            events
        );
    }
}
