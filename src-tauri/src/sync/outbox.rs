use crate::db::DbPool;
use crate::error::AdeError;
use crate::gh::client::GitHubClient;
use crate::gh::types::ColumnName;
use crate::models::Card;
use crate::sync::notifier::Notifier;
use crate::sync::queries;
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
    let existing: Option<OutboxRow> = queries::outbox_row_for_card(db, card_id).await?;

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

    queries::upsert_set_column_intent(db, card_id, &payload_json, &base_remote, &created_at)
        .await?;

    Ok(())
}

/// Load every pending intent for a workspace, regardless of backoff/due state.
/// Reconcile suspension (§12 Row 4) and conflict-drop (§13 step 1) must consider
/// ALL pending rows — `due()` only governs when the network sender retries.
pub async fn all_for_workspace(
    db: &DbPool,
    workspace_id: &str,
) -> Result<Vec<OutboxRow>, AdeError> {
    queries::outbox_rows_for_workspace(db, workspace_id).await
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
    let rows = queries::outbox_rows_for_workspace(db, workspace_id).await?;

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
    queries::record_attempt_failure(db, card_id, error, now).await
}

pub async fn resolve(db: &DbPool, card_id: &str) -> Result<(), AdeError> {
    queries::delete_intent(db, card_id).await
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
#[path = "outbox_tests.rs"]
mod tests;
