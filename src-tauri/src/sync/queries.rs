// Raw SQL for the outbox queue and the sync_state watermark, kept apart from
// the conflict/merge policy in outbox.rs and the sync loop in worker.rs. SQL is
// byte-for-byte the same as before the extraction — sqlx 0.9 requires string
// literals (SqlSafeStr), so nothing here is assembled at runtime.
//
// Transaction-bound writes (the `&mut *tx` UPDATE/INSERT of sync_state and the
// per-card DELETE in the reconcile pass) stay in worker.rs: threading the tx
// executor through here buys nothing.

use crate::db::DbPool;
use crate::error::AdeError;
use crate::sync::outbox::OutboxRow;

/// The current sync watermark for a workspace, or `None` if it never synced.
pub async fn read_last_sync(db: &DbPool, workspace_id: &str) -> Result<Option<String>, AdeError> {
    sqlx::query_scalar::<_, String>("SELECT last_sync FROM sync_state WHERE workspace_id = ?")
        .bind(workspace_id)
        .fetch_optional(db)
        .await
        .map_err(AdeError::Db)
}

/// The pending outbox intent for a card, if any.
pub async fn outbox_row_for_card(
    db: &DbPool,
    card_id: &str,
) -> Result<Option<OutboxRow>, AdeError> {
    sqlx::query_as::<_, OutboxRow>(
        "SELECT card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at FROM outbox WHERE card_id = ?",
    )
    .bind(card_id)
    .fetch_optional(db)
    .await
    .map_err(AdeError::Db)
}

/// Insert or replace a `set_column` intent, resetting attempts/backoff.
pub async fn upsert_set_column_intent(
    db: &DbPool,
    card_id: &str,
    payload_json: &str,
    base_remote_updated_at: &str,
    created_at: &str,
) -> Result<(), AdeError> {
    sqlx::query(
        "INSERT OR REPLACE INTO outbox (card_id, intent, payload_json, base_remote_updated_at, attempts, last_error, last_attempt_at, created_at)
         VALUES (?, 'set_column', ?, ?, 0, NULL, NULL, ?)",
    )
    .bind(card_id)
    .bind(payload_json)
    .bind(base_remote_updated_at)
    .bind(created_at)
    .execute(db)
    .await
    .map_err(AdeError::Db)?;
    Ok(())
}

/// Every pending intent for a workspace (joined to card for the workspace scope).
/// Shared by `all_for_workspace` and `due` — they query the identical set; the
/// JOIN-by-workspace_id is a recent bug fix and must stay exact.
pub async fn outbox_rows_for_workspace(
    db: &DbPool,
    workspace_id: &str,
) -> Result<Vec<OutboxRow>, AdeError> {
    sqlx::query_as::<_, OutboxRow>(
        "SELECT o.card_id, o.intent, o.payload_json, o.base_remote_updated_at, o.attempts, o.last_error, o.last_attempt_at, o.created_at
         FROM outbox o JOIN card c ON c.id = o.card_id
         WHERE c.workspace_id = ?",
    )
    .bind(workspace_id)
    .fetch_all(db)
    .await
    .map_err(AdeError::Db)
}

/// Bump attempts and record the failure reason/time for a card's intent.
pub async fn record_attempt_failure(
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

/// Drop a card's pending intent (resolved or cancelled).
pub async fn delete_intent(db: &DbPool, card_id: &str) -> Result<(), AdeError> {
    sqlx::query("DELETE FROM outbox WHERE card_id = ?")
        .bind(card_id)
        .execute(db)
        .await
        .map_err(AdeError::Db)?;
    Ok(())
}
