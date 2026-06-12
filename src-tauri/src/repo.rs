// Repository layer: the canonical SELECT column lists and fetch helpers for
// the card / workspace / board_column tables, so the 15-field card SELECT
// isn't copy-pasted across every IPC handler and sync pass.
//
// The column lists are macros (not consts) so queries can be assembled with
// `concat!` into `&'static str` literals, which sqlx 0.9 requires (SqlSafeStr).

/// The full card column list, in `Card` field order.
macro_rules! card_cols {
    () => {
        "id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at"
    };
}

/// The full workspace column list, in `Workspace` field order.
macro_rules! workspace_cols {
    () => {
        "id, name, slug, root_path, github_owner, github_repo, startup_command, created_at"
    };
}

pub(crate) use workspace_cols;

use crate::db::DbPool;
use crate::error::AdeError;
use crate::models::{BoardColumn, Card, Workspace};

/// Fetch a card by id, or `None` if it doesn't exist.
pub async fn card_by_id(db: &DbPool, card_id: &str) -> Result<Option<Card>, AdeError> {
    sqlx::query_as::<_, Card>(concat!("SELECT ", card_cols!(), " FROM card WHERE id = ?"))
        .bind(card_id)
        .fetch_optional(db)
        .await
        .map_err(AdeError::Db)
}

/// Fetch a card by id, erroring (sqlx `RowNotFound`) if it doesn't exist.
pub async fn card_by_id_required(db: &DbPool, card_id: &str) -> Result<Card, AdeError> {
    sqlx::query_as::<_, Card>(concat!("SELECT ", card_cols!(), " FROM card WHERE id = ?"))
        .bind(card_id)
        .fetch_one(db)
        .await
        .map_err(AdeError::Db)
}

/// Fetch all cards for a workspace, ordered by position.
pub async fn cards_for_workspace(db: &DbPool, workspace_id: &str) -> Result<Vec<Card>, AdeError> {
    sqlx::query_as::<_, Card>(concat!(
        "SELECT ",
        card_cols!(),
        " FROM card WHERE workspace_id = ? ORDER BY position"
    ))
    .bind(workspace_id)
    .fetch_all(db)
    .await
    .map_err(AdeError::Db)
}

/// Fetch a workspace by id, erroring (sqlx `RowNotFound`) if it doesn't exist.
pub async fn workspace_by_id(db: &DbPool, workspace_id: &str) -> Result<Workspace, AdeError> {
    sqlx::query_as::<_, Workspace>(concat!(
        "SELECT ",
        workspace_cols!(),
        " FROM workspace WHERE id = ?"
    ))
    .bind(workspace_id)
    .fetch_one(db)
    .await
    .map_err(AdeError::Db)
}

/// Fetch a workspace by id, or `None` if it doesn't exist.
pub async fn workspace_by_id_opt(
    db: &DbPool,
    workspace_id: &str,
) -> Result<Option<Workspace>, AdeError> {
    sqlx::query_as::<_, Workspace>(concat!(
        "SELECT ",
        workspace_cols!(),
        " FROM workspace WHERE id = ?"
    ))
    .bind(workspace_id)
    .fetch_optional(db)
    .await
    .map_err(AdeError::Db)
}

/// Fetch all board columns for a workspace, ordered by position.
pub async fn columns_for_workspace(
    db: &DbPool,
    workspace_id: &str,
) -> Result<Vec<BoardColumn>, AdeError> {
    sqlx::query_as::<_, BoardColumn>(
        "SELECT id, workspace_id, name, position FROM board_column WHERE workspace_id = ? ORDER BY position",
    )
    .bind(workspace_id)
    .fetch_all(db)
    .await
    .map_err(AdeError::Db)
}
