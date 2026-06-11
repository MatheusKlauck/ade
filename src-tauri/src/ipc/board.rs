use crate::board_pos::{append_position, insert_between, needs_rebalance, rebalance};
use crate::error::AdeError;
use crate::models::{BoardColumn, BoardGetResult, Card};
use crate::notify::emit_notify;
use crate::sync::outbox;
use chrono::Utc;
use sqlx::Row;
use std::sync::Arc;
use tauri::Emitter;
use tauri::State;

use crate::gitlocal;
use crate::tmux;

#[tauri::command]
pub async fn board_get(
    workspace_id: String,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<BoardGetResult, AdeError> {
    let columns: Vec<BoardColumn> =
        sqlx::query_as::<_, BoardColumn>(
            "SELECT id, workspace_id, name, position FROM board_column WHERE workspace_id = ? ORDER BY position",
        )
        .bind(&workspace_id)
        .fetch_all(&state.db)
        .await
        .map_err(AdeError::Db)?;

    let cards: Vec<Card> =
        sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE workspace_id = ? ORDER BY position",
        )
        .bind(&workspace_id)
        .fetch_all(&state.db)
        .await
        .map_err(AdeError::Db)?;

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

    let card: Card = sqlx::query_as::<_, Card>(
        "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await
    .map_err(AdeError::Db)?;

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

    let card: Card = sqlx::query_as::<_, Card>(
        "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
    )
    .bind(&card_id)
    .fetch_one(&state.db)
    .await
    .map_err(AdeError::Db)?;

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
    let mut tx = state.db.begin().await.map_err(AdeError::Db)?;

    let card_row = sqlx::query("SELECT workspace_id, column_id, position FROM card WHERE id = ?")
        .bind(&card_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(AdeError::Db)?;

    let (workspace_id, from_column_id, _old_position) = match card_row {
        Some(r) => (
            r.get::<String, _>("workspace_id"),
            r.get::<String, _>("column_id"),
            r.get::<f64, _>("position"),
        ),
        None => {
            emit_notify(
                &app,
                "warn",
                "INTERNAL",
                &format!("card_move: card {} not found", card_id),
            );
            return Err(AdeError::Other(format!("card {} not found", card_id)));
        }
    };

    let new_position = if before_card_id.is_none() && after_card_id.is_none() {
        let max_pos: Option<f64> = sqlx::query_scalar(
            "SELECT MAX(position) FROM card WHERE workspace_id = ? AND column_id = ?",
        )
        .bind(&workspace_id)
        .bind(&to_column_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(AdeError::Db)?;
        append_position(max_pos)
    } else {
        let before_pos = match before_card_id {
            Some(ref id) => {
                let row = sqlx::query("SELECT position FROM card WHERE id = ?")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(AdeError::Db)?;
                row.map(|r| r.get::<f64, _>("position"))
            }
            None => None,
        };
        let after_pos = match after_card_id {
            Some(ref id) => {
                let row = sqlx::query("SELECT position FROM card WHERE id = ?")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(AdeError::Db)?;
                row.map(|r| r.get::<f64, _>("position"))
            }
            None => None,
        };

        match (before_pos, after_pos) {
            (Some(a), Some(b)) => insert_between(a, b),
            (Some(a), None) => {
                let max_pos: Option<f64> = sqlx::query_scalar(
                    "SELECT MAX(position) FROM card WHERE workspace_id = ? AND column_id = ?",
                )
                .bind(&workspace_id)
                .bind(&to_column_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(AdeError::Db)?;
                let max = max_pos.unwrap_or(a);
                if max > a {
                    append_position(max_pos)
                } else {
                    append_position(Some(a))
                }
            }
            (None, Some(b)) => insert_between(0.0, b),
            (None, None) => {
                let max_pos: Option<f64> = sqlx::query_scalar(
                    "SELECT MAX(position) FROM card WHERE workspace_id = ? AND column_id = ?",
                )
                .bind(&workspace_id)
                .bind(&to_column_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(AdeError::Db)?;
                append_position(max_pos)
            }
        }
    };

    sqlx::query("UPDATE card SET column_id = ?, position = ?, updated_at = ? WHERE id = ?")
        .bind(&to_column_id)
        .bind(new_position)
        .bind(Utc::now().to_rfc3339())
        .bind(&card_id)
        .execute(&mut *tx)
        .await
        .map_err(AdeError::Db)?;

    let positions_in_column: Vec<(String, f64)> = sqlx::query(
        "SELECT id, position FROM card WHERE workspace_id = ? AND column_id = ? ORDER BY position",
    )
    .bind(&workspace_id)
    .bind(&to_column_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(AdeError::Db)?
    .into_iter()
    .map(|r: sqlx::sqlite::SqliteRow| {
        let id: String = r.get("id");
        let pos: f64 = r.get("position");
        (id, pos)
    })
    .collect();

    let pos_values: Vec<f64> = positions_in_column.iter().map(|(_, p)| *p).collect();
    if needs_rebalance(&pos_values) {
        let rebalanced = rebalance(&positions_in_column);
        for (id, pos) in rebalanced {
            sqlx::query("UPDATE card SET position = ? WHERE id = ?")
                .bind(pos)
                .bind(&id)
                .execute(&mut *tx)
                .await
                .map_err(AdeError::Db)?;
        }
    }

    tx.commit().await.map_err(AdeError::Db)?;

    let card: Card = sqlx::query_as::<_, Card>(
        "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
    )
    .bind(&card_id)
    .fetch_one(&state.db)
    .await
    .map_err(AdeError::Db)?;

    emit_board(&app, &workspace_id, &state.db).await?;

    // M5-T4: §13.1 — enqueue outbox intent for linked cards on user drag
    if card.source == "github" && card.github_issue_number.is_some() {
        if let Some(ref remote_updated_at) = card.remote_updated_at {
            // Resolve column names from IDs
            let from_col_row = sqlx::query("SELECT name FROM board_column WHERE id = ?")
                .bind(&from_column_id)
                .fetch_optional(&state.db)
                .await
                .map_err(AdeError::Db)?;
            let to_col_row = sqlx::query("SELECT name FROM board_column WHERE id = ?")
                .bind(&to_column_id)
                .fetch_optional(&state.db)
                .await
                .map_err(AdeError::Db)?;

            if let (Some(from_r), Some(to_r)) = (from_col_row, to_col_row) {
                let from_name: String = from_r.get::<String, _>("name");
                let to_name: String = to_r.get::<String, _>("name");
                // Only enqueue if the move is a real column change (not same column reorder)
                if from_name != to_name {
                    if let Err(e) = outbox::enqueue(
                        &state.db,
                        &card_id,
                        &from_name,
                        &to_name,
                        remote_updated_at,
                    )
                    .await
                    {
                        emit_notify(
                            &app,
                            "error",
                            "DB_ERROR",
                            &format!("failed to enqueue outbox intent: {}", e),
                        );
                    }
                }
            }
        }
    }

    // M4-T2: §16 trigger — auto-launch terminal on move to Doing (user drag only)
    let _ = from_column_id;

    // 1. Check if target column is "Doing"
    let col_row = sqlx::query("SELECT name FROM board_column WHERE id = ?")
        .bind(&to_column_id)
        .fetch_optional(&state.db)
        .await
        .map_err(AdeError::Db)?;

    let col_name: String = match col_row {
        Some(r) => r.get::<String, _>("name"),
        None => return Ok(card),
    };

    if col_name != "Doing" {
        return Ok(card);
    }

    // 2. Look up workspace for this card
    let ws_row = sqlx::query(
        "SELECT slug, root_path, github_owner, github_repo, startup_command FROM workspace WHERE id = ?",
    )
    .bind(&card.workspace_id)
    .fetch_optional(&state.db)
    .await
    .map_err(AdeError::Db)?;

    let ws = match ws_row {
        Some(r) => r,
        None => return Ok(card),
    };
    let slug: String = ws.get("slug");
    let root_path: String = ws.get("root_path");
    let github_owner: Option<String> = ws.get("github_owner");
    let github_repo: Option<String> = ws.get("github_repo");
    let startup_command: Option<String> = ws.get("startup_command");

    // 3. If card already has a terminal_window_id and it's alive, just re-focus it
    if let Some(ref wid) = card.terminal_window_id {
        if tmux::window_alive(&slug, wid).unwrap_or(false) {
            let _ = app.emit(
                "evt:terminal_focus",
                serde_json::json!({
                    "workspace_id": card.workspace_id,
                    "window_id": wid,
                }),
            );
            return Ok(card);
        }
    }

    // 4. Ensure base tmux session exists before creating windows
    if let Err(e) = tmux::ensure_base_session(&slug, &root_path) {
        emit_notify(
            &app,
            "warn",
            "TMUX_SESSION_FAILED",
            &format!("failed to create tmux session: {}", e),
        );
        return Ok(card);
    }

    // 5. Branch: GitHub-linked card vs local card
    let window_id: String =
        if let Some(issue_number) = card.github_issue_number.filter(|_| card.source == "github") {
            // GitHub-linked card
            let fallback = format!("issue-{}", issue_number);
            let winname = format!(
                "{}-{}",
                issue_number,
                gitlocal::slugify(&card.title, &fallback)
            );

            // Construct html_url
            let html_url = match (&github_owner, &github_repo) {
                (Some(owner), Some(repo)) => {
                    format!(
                        "https://github.com/{}/{}/issues/{}",
                        owner, repo, issue_number
                    )
                }
                _ => format!("https://github.com/issues/{}", issue_number),
            };

            // Create issue window with env vars
            let wid = match tmux::new_issue_window(
                &slug,
                &root_path,
                &winname,
                issue_number as u64,
                &card.title,
                &html_url,
            ) {
                Ok(w) => w,
                Err(e) => {
                    emit_notify(
                        &app,
                        "warn",
                        "TMUX_WINDOW_FAILED",
                        &format!("failed to create tmux issue window: {}", e),
                    );
                    return Ok(card);
                }
            };

            // Auto-branch: check setting (default true)
            let auto_branch: bool = match sqlx::query_scalar::<_, String>(
                "SELECT value FROM setting WHERE key = 'auto_branch'",
            )
            .fetch_optional(&state.db)
            .await
            .map_err(AdeError::Db)?
            {
                Some(val) => val != "false",
                None => true,
            };

            if auto_branch {
                match gitlocal::prepare_branch(&root_path, issue_number as u64) {
                    Ok(gitlocal::BranchOutcome::ReusedExisting) => {
                        emit_notify(
                            &app,
                            "info",
                            "BRANCH_EXISTS_REUSED",
                            &format!(
                                "branch issue-{} already exists, checking it out",
                                issue_number
                            ),
                        );
                    }
                    Ok(gitlocal::BranchOutcome::SkippedDirty) => {
                        emit_notify(
                            &app,
                            "warn",
                            "BRANCH_DIRTY_WORKTREE",
                            &format!(
                                "worktree has uncommitted changes; branch issue-{} not created",
                                issue_number
                            ),
                        );
                    }
                    Ok(gitlocal::BranchOutcome::Created) => {
                        // No notification on success
                    }
                    Err(e) => {
                        emit_notify(
                            &app,
                            "warn",
                            "BRANCH_FAILED",
                            &format!("failed to prepare branch issue-{}: {}", issue_number, e),
                        );
                    }
                }
            }

            // Run startup command (workspace-specific, or global fallback)
            let cmd = startup_command.as_deref().filter(|v| !v.is_empty());
            let global_cmd: Option<String> = if cmd.is_none() {
                sqlx::query("SELECT value FROM setting WHERE key = 'startup_command_global'")
                    .fetch_optional(&state.db)
                    .await
                    .map_err(AdeError::Db)?
                    .map(|r: sqlx::sqlite::SqliteRow| r.get::<String, _>("value"))
                    .filter(|v| !v.is_empty())
            } else {
                None
            };
            let run_cmd = cmd.or(global_cmd.as_deref());
            if let Some(cmd) = run_cmd {
                let _ = tmux::send_keys(&wid, cmd);
            }

            wid
        } else {
            // Local card: use new_app_window (no env vars, no issue window name)
            let id8 = &card.id[..card.id.len().min(8)];
            let fallback = format!("card-{}", id8);
            let winname = gitlocal::slugify(&card.title, &fallback);

            let wid = match tmux::new_app_window(&slug, &root_path) {
                Ok(w) => w,
                Err(e) => {
                    emit_notify(
                        &app,
                        "warn",
                        "TMUX_WINDOW_FAILED",
                        &format!("failed to create tmux app window: {}", e),
                    );
                    return Ok(card);
                }
            };

            // Run startup command (workspace-specific, or global fallback)
            let cmd_local = startup_command.as_deref().filter(|v| !v.is_empty());
            let global_cmd_local: Option<String> = if cmd_local.is_none() {
                sqlx::query("SELECT value FROM setting WHERE key = 'startup_command_global'")
                    .fetch_optional(&state.db)
                    .await
                    .map_err(AdeError::Db)?
                    .map(|r: sqlx::sqlite::SqliteRow| r.get::<String, _>("value"))
                    .filter(|v| !v.is_empty())
            } else {
                None
            };
            let run_cmd_local = cmd_local.or(global_cmd_local.as_deref());
            if let Some(cmd) = run_cmd_local {
                let _ = tmux::send_keys(&wid, cmd);
            }

            // Rename the window to the slugified name (new_app_window doesn't accept a name)
            // tmux rename-window is safe to use with the window id
            let _ = std::process::Command::new("tmux")
                .arg("rename-window")
                .arg("-t")
                .arg(&wid)
                .arg(&winname)
                .output();

            wid
        };

    // 6. Store terminal_window_id on the card
    sqlx::query("UPDATE card SET terminal_window_id = ? WHERE id = ?")
        .bind(&window_id)
        .bind(&card_id)
        .execute(&state.db)
        .await
        .map_err(AdeError::Db)?;

    // 7. Emit terminal_focus event
    let _ = app.emit(
        "evt:terminal_focus",
        serde_json::json!({
            "workspace_id": card.workspace_id,
            "window_id": window_id,
        }),
    );

    // 8. Re-emit board (terminal_window_id changed)
    emit_board(&app, &card.workspace_id, &state.db).await?;

    Ok(card)
}

async fn emit_board(
    app: &tauri::AppHandle,
    workspace_id: &str,
    pool: &crate::db::DbPool,
) -> Result<(), AdeError> {
    let columns: Vec<BoardColumn> =
        sqlx::query_as::<_, BoardColumn>(
            "SELECT id, workspace_id, name, position FROM board_column WHERE workspace_id = ? ORDER BY position",
        )
        .bind(workspace_id)
        .fetch_all(pool)
        .await
        .map_err(AdeError::Db)?;

    let cards: Vec<Card> =
        sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE workspace_id = ? ORDER BY position",
        )
        .bind(workspace_id)
        .fetch_all(pool)
        .await
        .map_err(AdeError::Db)?;

    let payload = serde_json::json!({
        "workspace_id": workspace_id,
        "columns": columns,
        "cards": cards,
    });

    let _ = app.emit("evt:board", payload);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn test_pool() -> (crate::db::DbPool, tempfile::TempDir) {
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

        sqlx::query(
            "CREATE TABLE card (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
                column_id TEXT NOT NULL REFERENCES board_column(id),
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

        (pool, tmp)
    }

    async fn seed_workspace_and_columns(pool: &crate::db::DbPool) -> (String, Vec<String>) {
        let ws_id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO workspace (id, name, slug, root_path, created_at) VALUES (?, 'Dev', 'dev', '/tmp/dev', ?)",
        )
        .bind(&ws_id)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();

        let col_names = ["Backlog", "Doing", "Paused", "PR", "Done"];
        let mut col_ids = Vec::new();
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
            .unwrap();
            col_ids.push(cid);
        }
        (ws_id, col_ids)
    }

    #[tokio::test]
    async fn seed_creates_five_columns() {
        let (pool, _tmp) = test_pool().await;
        let (ws_id, col_ids) = seed_workspace_and_columns(&pool).await;
        assert_eq!(col_ids.len(), 5);

        let cols: Vec<BoardColumn> =
            sqlx::query_as::<_, BoardColumn>(
                "SELECT id, workspace_id, name, position FROM board_column WHERE workspace_id = ? ORDER BY position",
            )
            .bind(&ws_id)
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(cols.len(), 5);
        assert_eq!(cols[0].name, "Backlog");
        assert_eq!(cols[1].name, "Doing");
        assert_eq!(cols[2].name, "Paused");
        assert_eq!(cols[3].name, "PR");
        assert_eq!(cols[4].name, "Done");
    }

    #[tokio::test]
    async fn card_create_roundtrip() {
        let (pool, _tmp) = test_pool().await;
        let (ws_id, col_ids) = seed_workspace_and_columns(&pool).await;
        let backlog = col_ids[0].clone();

        let now = Utc::now().to_rfc3339();
        let card_id = uuid::Uuid::new_v4().to_string();
        let pos = append_position(None);
        sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, position, source, created_at, updated_at) VALUES (?, ?, ?, 'Test card', ?, 'local', ?, ?)",
        )
        .bind(&card_id)
        .bind(&ws_id)
        .bind(&backlog)
        .bind(pos)
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        let card: Card = sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
        )
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(card.title, "Test card");
        assert_eq!(card.position, 1024.0);
    }

    #[tokio::test]
    async fn card_update_changes_title() {
        let (pool, _tmp) = test_pool().await;
        let (ws_id, col_ids) = seed_workspace_and_columns(&pool).await;
        let backlog = col_ids[0].clone();

        let now = Utc::now().to_rfc3339();
        let card_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, position, source, created_at, updated_at) VALUES (?, ?, ?, 'Old', 1024.0, 'local', ?, ?)",
        )
        .bind(&card_id)
        .bind(&ws_id)
        .bind(&backlog)
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("UPDATE card SET title = 'New' WHERE id = ?")
            .bind(&card_id)
            .execute(&pool)
            .await
            .unwrap();

        let row = sqlx::query("SELECT title FROM card WHERE id = ?")
            .bind(&card_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let title: String = row.get("title");
        assert_eq!(title, "New");
    }

    #[tokio::test]
    async fn card_move_within_column() {
        let (pool, _tmp) = test_pool().await;
        let (ws_id, col_ids) = seed_workspace_and_columns(&pool).await;
        let backlog = col_ids[0].clone();

        let now = Utc::now().to_rfc3339();
        let c1 = uuid::Uuid::new_v4().to_string();
        let c2 = uuid::Uuid::new_v4().to_string();
        let c3 = uuid::Uuid::new_v4().to_string();

        for (id, pos) in [(&c1, 1024.0), (&c2, 2048.0), (&c3, 3072.0)] {
            sqlx::query(
                "INSERT INTO card (id, workspace_id, column_id, title, position, source, created_at, updated_at) VALUES (?, ?, ?, 'Card', ?, 'local', ?, ?)",
            )
            .bind(id)
            .bind(&ws_id)
            .bind(&backlog)
            .bind(pos)
            .bind(&now)
            .bind(&now)
            .execute(&pool)
            .await
            .unwrap();
        }

        // Move c3 between c1 and c2
        let mut tx = pool.begin().await.unwrap();
        let new_pos = insert_between(1024.0, 2048.0);
        sqlx::query("UPDATE card SET position = ? WHERE id = ?")
            .bind(new_pos)
            .bind(&c3)
            .execute(&mut *tx)
            .await
            .unwrap();

        let positions_in_column: Vec<(String, f64)> = sqlx::query(
            "SELECT id, position FROM card WHERE workspace_id = ? AND column_id = ? ORDER BY position",
        )
        .bind(&ws_id)
        .bind(&backlog)
        .fetch_all(&mut *tx)
        .await
        .unwrap()
        .into_iter()
        .map(|r: sqlx::sqlite::SqliteRow| {
            let id: String = r.get("id");
            let pos: f64 = r.get("position");
            (id, pos)
        })
        .collect();

        let pos_values: Vec<f64> = positions_in_column.iter().map(|(_, p)| *p).collect();
        if needs_rebalance(&pos_values) {
            let rebalanced = rebalance(&positions_in_column);
            for (id, pos) in rebalanced {
                sqlx::query("UPDATE card SET position = ? WHERE id = ?")
                    .bind(pos)
                    .bind(&id)
                    .execute(&mut *tx)
                    .await
                    .unwrap();
            }
        }
        tx.commit().await.unwrap();

        let rows: Vec<sqlx::sqlite::SqliteRow> = sqlx::query(
            "SELECT id, position FROM card WHERE workspace_id = ? AND column_id = ? ORDER BY position",
        )
        .bind(&ws_id)
        .bind(&backlog)
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(rows.len(), 3);
        let ids: Vec<String> = rows.iter().map(|r| r.get::<String, _>("id")).collect();
        assert_eq!(ids, vec![c1, c3, c2]);
    }

    #[tokio::test]
    async fn card_move_across_columns_keeps_order() {
        let (pool, _tmp) = test_pool().await;
        let (ws_id, col_ids) = seed_workspace_and_columns(&pool).await;
        let backlog = col_ids[0].clone();
        let doing = col_ids[1].clone();

        let now = Utc::now().to_rfc3339();
        let c1 = uuid::Uuid::new_v4().to_string();
        let c2 = uuid::Uuid::new_v4().to_string();

        sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, position, source, created_at, updated_at) VALUES (?, ?, ?, 'A', 1024.0, 'local', ?, ?)",
        )
        .bind(&c1)
        .bind(&ws_id)
        .bind(&backlog)
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, position, source, created_at, updated_at) VALUES (?, ?, ?, 'B', 1024.0, 'local', ?, ?)",
        )
        .bind(&c2)
        .bind(&ws_id)
        .bind(&doing)
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        // Move c1 to doing (append)
        let mut tx = pool.begin().await.unwrap();
        let max_pos: Option<f64> = sqlx::query_scalar(
            "SELECT MAX(position) FROM card WHERE workspace_id = ? AND column_id = ?",
        )
        .bind(&ws_id)
        .bind(&doing)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        let new_pos = append_position(max_pos);
        sqlx::query("UPDATE card SET column_id = ?, position = ? WHERE id = ?")
            .bind(&doing)
            .bind(new_pos)
            .bind(&c1)
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let rows: Vec<sqlx::sqlite::SqliteRow> = sqlx::query(
            "SELECT id, column_id, position FROM card WHERE workspace_id = ? ORDER BY column_id, position",
        )
        .bind(&ws_id)
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(rows.len(), 2);
        let doing_ids: Vec<String> = rows
            .iter()
            .filter(|r| r.get::<String, _>("column_id") == doing)
            .map(|r| r.get::<String, _>("id"))
            .collect();
        assert_eq!(doing_ids, vec![c2, c1]);
    }

    #[tokio::test]
    async fn card_delete_removes_row() {
        let (pool, _tmp) = test_pool().await;
        let (ws_id, col_ids) = seed_workspace_and_columns(&pool).await;
        let backlog = col_ids[0].clone();

        let now = Utc::now().to_rfc3339();
        let c1 = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, position, source, created_at, updated_at) VALUES (?, ?, ?, 'A', 1024.0, 'local', ?, ?)",
        )
        .bind(&c1)
        .bind(&ws_id)
        .bind(&backlog)
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("DELETE FROM card WHERE id = ?")
            .bind(&c1)
            .execute(&pool)
            .await
            .unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM card")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
}
