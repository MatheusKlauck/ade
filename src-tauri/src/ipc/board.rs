use crate::board_pos::append_position;
use crate::error::AdeError;
use crate::gh::client::GitHubClient;
use crate::models::{BoardGetResult, Card};
use crate::notify::emit_notify;
use chrono::Utc;
use sqlx::Row;
use std::sync::Arc;
use tauri::Emitter;
use tauri::State;

#[tauri::command]
pub async fn board_get(
    workspace_id: String,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<BoardGetResult, AdeError> {
    let columns = crate::repo::columns_for_workspace(&state.db, &workspace_id).await?;
    let cards = crate::repo::cards_for_workspace(&state.db, &workspace_id).await?;

    Ok(BoardGetResult { columns, cards })
}

#[tauri::command]
pub async fn card_create(
    workspace_id: String,
    column_id: String,
    title: String,
    state: State<'_, Arc<crate::AppState>>,
    app: tauri::AppHandle,
) -> Result<Card, AdeError> {
    let now = Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();

    let max_pos: Option<f64> = sqlx::query_scalar(
        "SELECT MAX(position) FROM card WHERE workspace_id = ? AND column_id = ?",
    )
    .bind(&workspace_id)
    .bind(&column_id)
    .fetch_one(&state.db)
    .await
    .map_err(AdeError::Db)?;

    let position = append_position(max_pos);

    sqlx::query(
        "INSERT INTO card (id, workspace_id, column_id, title, body_preview, position, source, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, 'local', ?, ?)",
    )
    .bind(&id)
    .bind(&workspace_id)
    .bind(&column_id)
    .bind(&title)
    .bind(position)
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await
    .map_err(AdeError::Db)?;

    let card = crate::repo::card_by_id_required(&state.db, &id).await?;

    emit_board(&app, &workspace_id, &state.db).await?;
    Ok(card)
}

#[tauri::command]
pub async fn card_update(
    card_id: String,
    title: Option<String>,
    body_preview: Option<String>,
    state: State<'_, Arc<crate::AppState>>,
    app: tauri::AppHandle,
) -> Result<Card, AdeError> {
    let now = Utc::now().to_rfc3339();

    if let Some(ref t) = title {
        sqlx::query("UPDATE card SET title = ?, updated_at = ? WHERE id = ?")
            .bind(t)
            .bind(&now)
            .bind(&card_id)
            .execute(&state.db)
            .await
            .map_err(AdeError::Db)?;
    }

    if let Some(ref b) = body_preview {
        sqlx::query("UPDATE card SET body_preview = ?, updated_at = ? WHERE id = ?")
            .bind(b)
            .bind(&now)
            .bind(&card_id)
            .execute(&state.db)
            .await
            .map_err(AdeError::Db)?;
    }

    let card = crate::repo::card_by_id_required(&state.db, &card_id).await?;

    emit_board(&app, &card.workspace_id, &state.db).await?;
    Ok(card)
}

#[tauri::command]
pub async fn card_delete(
    card_id: String,
    state: State<'_, Arc<crate::AppState>>,
    app: tauri::AppHandle,
) -> Result<(), AdeError> {
    let row = sqlx::query("SELECT workspace_id FROM card WHERE id = ?")
        .bind(&card_id)
        .fetch_optional(&state.db)
        .await
        .map_err(AdeError::Db)?;

    let workspace_id: String = match row {
        Some(r) => r.get("workspace_id"),
        None => {
            emit_notify(
                &app,
                "warn",
                "INTERNAL",
                &format!("card_delete: card {} not found", card_id),
            );
            return Ok(());
        }
    };

    sqlx::query("DELETE FROM card WHERE id = ?")
        .bind(&card_id)
        .execute(&state.db)
        .await
        .map_err(AdeError::Db)?;

    emit_board(&app, &workspace_id, &state.db).await?;
    Ok(())
}

#[tauri::command]
pub async fn card_move(
    card_id: String,
    to_column_id: String,
    before_card_id: Option<String>,
    after_card_id: Option<String>,
    state: State<'_, Arc<crate::AppState>>,
    app: tauri::AppHandle,
) -> Result<Card, AdeError> {
    super::card_lifecycle::move_card(
        &state.db,
        &app,
        &state.pty,
        card_id,
        to_column_id,
        before_card_id,
        after_card_id,
    )
    .await
}

#[tauri::command]
pub async fn card_promote(
    card_id: String,
    state: State<'_, Arc<crate::AppState>>,
    app: tauri::AppHandle,
) -> Result<Card, AdeError> {
    super::card_lifecycle::promote_card(&state.db, &app, card_id).await
}

/// Edit an existing GitHub-linked issue's title and/or body and push it to
/// GitHub immediately (direct write, like card_promote — the detail view is an
/// interactive surface that wants instant save feedback, unlike a drag which
/// goes through the outbox). The local card's title/body_preview are refreshed
/// from the GitHub response. Returns the updated card.
#[tauri::command]
pub async fn card_update_github(
    card_id: String,
    title: Option<String>,
    body: Option<String>,
    state: State<'_, Arc<crate::AppState>>,
    app: tauri::AppHandle,
) -> Result<Card, AdeError> {
    // 1. Load card
    let card: Card = crate::repo::card_by_id(&state.db, &card_id)
        .await?
        .ok_or_else(|| AdeError::Other("card not found".to_string()))?;

    // 2. Only linked GitHub cards can be edited on GitHub
    let issue_number = match (card.source.as_str(), card.github_issue_number) {
        ("github", Some(n)) => n as u64,
        _ => return Err(AdeError::Other("card is not a GitHub issue".to_string())),
    };

    // 3. Look up workspace for GitHub owner/repo
    let ws_row = sqlx::query("SELECT github_owner, github_repo FROM workspace WHERE id = ?")
        .bind(&card.workspace_id)
        .fetch_optional(&state.db)
        .await
        .map_err(AdeError::Db)?
        .ok_or_else(|| AdeError::Other("workspace not found".to_string()))?;

    let owner: String = ws_row
        .get::<Option<String>, _>("github_owner")
        .ok_or_else(|| AdeError::Other("workspace has no GitHub owner".to_string()))?;
    let repo: String = ws_row
        .get::<Option<String>, _>("github_repo")
        .ok_or_else(|| AdeError::Other("workspace has no GitHub repo".to_string()))?;

    // 4. Get GitHub token from keychain (per-workspace, with legacy global fallback)
    let token = crate::ipc::github::keychain_get_for_workspace(&card.workspace_id)?
        .ok_or_else(|| AdeError::Other("GitHub token not found in keychain".to_string()))?;

    // 5. Create GitHubClient and PATCH the issue
    let gh = GitHubClient::new(crate::gh::client::GITHUB_API_BASE.to_string(), token);
    let issue = gh
        .update_issue(
            &owner,
            &repo,
            issue_number,
            title.as_deref(),
            body.as_deref(),
        )
        .await
        .map_err(|e| AdeError::Other(format!("failed to update GitHub issue: {e}")))?;

    // 6. Refresh the local card's cached fields from the GitHub response.
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE card SET title = ?, body_preview = ?, remote_updated_at = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&issue.title)
    .bind(&issue.body_preview)
    .bind(&issue.updated_at)
    .bind(&now)
    .bind(&card_id)
    .execute(&state.db)
    .await
    .map_err(AdeError::Db)?;

    // 7. Emit board event + return the updated card
    emit_board(&app, &card.workspace_id, &state.db).await?;
    let updated_card = crate::repo::card_by_id_required(&state.db, &card_id).await?;
    Ok(updated_card)
}

pub(crate) async fn emit_board(
    app: &tauri::AppHandle,
    workspace_id: &str,
    pool: &crate::db::DbPool,
) -> Result<(), AdeError> {
    let columns = crate::repo::columns_for_workspace(pool, workspace_id).await?;
    let cards = crate::repo::cards_for_workspace(pool, workspace_id).await?;

    let payload = serde_json::json!({
        "workspace_id": workspace_id,
        "columns": columns,
        "cards": cards,
    });

    let _ = app.emit("evt:board", payload);
    Ok(())
}

#[cfg(test)]
#[path = "board_tests.rs"]
mod tests;
