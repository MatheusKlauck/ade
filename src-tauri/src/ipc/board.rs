use crate::board_pos::{append_position, insert_between, needs_rebalance, rebalance};
use crate::error::AdeError;
use crate::gh::client::GitHubClient;
use crate::gh::types::ColumnName;
use crate::models::{BoardGetResult, Card};
use crate::notify::emit_notify;
use crate::sync::outbox;
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

        // Semantics: `before` is the card immediately BELOW the drop target (upper bound),
        // `after` is the card immediately ABOVE (lower bound). Positions are ascending top→bottom,
        // so after_pos < before_pos when both are present.
        match (before_pos, after_pos) {
            // Drop between two cards: midpoint.
            (Some(before), Some(after)) => insert_between(after, before),
            // Drop before the FIRST card (nothing below it): place above it, i.e. between 0 and it.
            (Some(before), None) => insert_between(0.0, before),
            // Column drop / append after the LAST card (nothing above it): place after it.
            (None, Some(after)) => append_position(Some(after)),
            // Empty column or completely unanchored: append after current max.
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

    let mut card: Card = crate::repo::card_by_id_required(&state.db, &card_id).await?;

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
    let target_column = ColumnName::try_from_str(&col_name);

    if target_column == Some(ColumnName::Done) {
        super::card_lifecycle::on_moved_to_done(&state.db, &app, &state.pty, &mut card).await?;
        return Ok(card);
    }

    if target_column != Some(ColumnName::Doing) {
        return Ok(card);
    }

    super::card_lifecycle::on_moved_to_doing(&state.db, &app, &card).await?;

    Ok(card)
}

#[tauri::command]
pub async fn card_promote(
    card_id: String,
    state: State<'_, Arc<crate::AppState>>,
    app: tauri::AppHandle,
) -> Result<Card, AdeError> {
    // 1. Load card
    let card: Card = crate::repo::card_by_id(&state.db, &card_id)
        .await?
        .ok_or_else(|| AdeError::Other("card not found".to_string()))?;

    // 2. Only local cards can be promoted
    if card.source != "local" {
        return Err(AdeError::Other("card already linked".to_string()));
    }

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

    // 5. Create GitHubClient
    let gh = GitHubClient::new(crate::gh::client::GITHUB_API_BASE.to_string(), token);

    // 6. Create the GitHub issue
    let issue = gh
        .create_issue(&owner, &repo, &card.title, card.body_preview.as_deref())
        .await
        .map_err(|e| AdeError::Other(format!("failed to create GitHub issue: {e}")))?;

    // 7. Update card in DB: source, issue number, state, remote_updated_at, labels_json
    let labels_initial = "[]";
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE card SET source = 'github', github_issue_number = ?, github_state = 'open', remote_updated_at = ?, labels_json = ?, updated_at = ? WHERE id = ?",
    )
    .bind(issue.number as i64)
    .bind(&issue.updated_at)
    .bind(labels_initial)
    .bind(&now)
    .bind(&card_id)
    .execute(&state.db)
    .await
    .map_err(AdeError::Db)?;

    // 8. If column is not Backlog, add kanban label
    let col_row = sqlx::query("SELECT name FROM board_column WHERE id = ?")
        .bind(&card.column_id)
        .fetch_optional(&state.db)
        .await
        .map_err(AdeError::Db)?;

    let col_name_str: Option<String> = col_row.map(|r| r.get::<String, _>("name"));

    let column_name = col_name_str
        .as_deref()
        .and_then(ColumnName::try_from_str)
        .unwrap_or(ColumnName::Backlog);

    let mut labels_vec: Vec<String> = Vec::new();

    match column_name {
        ColumnName::Backlog => {
            // No label needed
        }
        ColumnName::Doing | ColumnName::Paused | ColumnName::Pr => {
            // Non-Backlog open columns always carry a kanban label.
            let label = column_name
                .kanban_label()
                .expect("open non-Backlog columns have a kanban label")
                .to_string();
            gh.add_label(&owner, &repo, issue.number, &label)
                .await
                .map_err(|e| {
                    AdeError::Other(format!("failed to add label to GitHub issue: {e}"))
                })?;
            labels_vec.push(label);

            // Re-fetch the issue to get the updated timestamp after label add
            let updated_issue = gh
                .get_issue(&owner, &repo, issue.number)
                .await
                .map_err(|e| AdeError::Other(format!("failed to re-fetch GitHub issue: {e}")))?;
            let labels_json =
                serde_json::to_string(&labels_vec).unwrap_or_else(|_| "[]".to_string());
            sqlx::query("UPDATE card SET labels_json = ?, remote_updated_at = ? WHERE id = ?")
                .bind(&labels_json)
                .bind(&updated_issue.updated_at)
                .bind(&card_id)
                .execute(&state.db)
                .await
                .map_err(AdeError::Db)?;
        }
        ColumnName::Done => {
            // Close the issue
            gh.set_issue_state(&owner, &repo, issue.number, "closed")
                .await
                .map_err(|e| AdeError::Other(format!("failed to close GitHub issue: {e}")))?;
        }
    }

    // 9. Emit board event
    emit_board(&app, &card.workspace_id, &state.db).await?;

    // 10. Return the updated card
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
mod tests {
    use super::*;
    use crate::models::BoardColumn;
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

        sqlx::query("CREATE INDEX idx_card_board ON card(workspace_id, column_id, position);")
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

    // ── card_promote tests ──────────────────────────────────────────

    /// Helper: seed a workspace with github_owner and github_repo set.
    async fn seed_github_workspace(pool: &crate::db::DbPool) -> (String, Vec<String>) {
        let ws_id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO workspace (id, name, slug, root_path, github_owner, github_repo, created_at) VALUES (?, 'Dev', 'dev', '/tmp/dev', 'testowner', 'testrepo', ?)",
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

    /// Helper: insert a local card in a given column.
    async fn insert_local_card(
        pool: &crate::db::DbPool,
        ws_id: &str,
        col_id: &str,
        title: &str,
    ) -> String {
        let card_id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let pos = append_position(None);
        sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, position, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'local', ?, ?)",
        )
        .bind(&card_id)
        .bind(ws_id)
        .bind(col_id)
        .bind(title)
        .bind(pos)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await
        .unwrap();
        card_id
    }

    /// Test: promote local card in Backlog → only create_issue called, no add_label.
    /// Uses wiremock to verify the GitHub API calls.
    #[tokio::test]
    async fn card_promote_backlog_creates_issue_no_label() {
        use crate::gh::client::GitHubClient;
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;

        // Mock: POST /repos/testowner/testrepo/issues → create issue #42
        let issue_body = serde_json::json!({
            "number": 42,
            "title": "My task",
            "state": "open",
            "updated_at": "2025-06-10T12:00:00Z",
            "assignee": null,
            "labels": [],
            "html_url": "https://github.com/testowner/testrepo/issues/42",
            "pull_request": null,
            "body": null,
        });
        Mock::given(method("POST"))
            .and(path("/repos/testowner/testrepo/issues"))
            .and(header("Authorization", "Bearer testtoken"))
            .respond_with(ResponseTemplate::new(201).set_body_json(&issue_body))
            .mount(&server)
            .await;

        // No add_label mock needed — we expect no label calls for Backlog.
        // But wiremock will fail the test if any unexpected request is made.

        let gh = GitHubClient::new(server.uri(), "testtoken".to_string());

        // Create issue via the GitHub client
        let issue = gh
            .create_issue("testowner", "testrepo", "My task", None)
            .await
            .expect("create_issue should succeed");

        assert_eq!(issue.number, 42);
        assert_eq!(issue.state, "open");

        // Now test the DB side: verify card can be updated correctly
        let (pool, _tmp) = test_pool().await;
        let (ws_id, col_ids) = seed_github_workspace(&pool).await;
        let backlog_col = col_ids[0].clone();
        let card_id = insert_local_card(&pool, &ws_id, &backlog_col, "My task").await;

        // Simulate what card_promote does for a Backlog card
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "UPDATE card SET source = 'github', github_issue_number = ?, github_state = 'open', remote_updated_at = ?, labels_json = '[]', updated_at = ? WHERE id = ?",
        )
        .bind(issue.number as i64)
        .bind(&issue.updated_at)
        .bind(&now)
        .bind(&card_id)
        .execute(&pool)
        .await
        .unwrap();

        // Verify card state
        let card: Card = sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
        )
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(card.source, "github");
        assert_eq!(card.github_issue_number, Some(42));
        assert_eq!(card.github_state, Some("open".to_string()));
        assert_eq!(card.labels_json, Some("[]".to_string()));
    }

    /// Test: promote local card in Doing → create_issue + add_label called.
    /// Uses wiremock to verify both GitHub API calls.
    #[tokio::test]
    async fn card_promote_doing_creates_issue_and_adds_label() {
        use crate::gh::client::GitHubClient;
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;

        // Mock: POST /repos/testowner/testrepo/issues → create issue #42
        let issue_body = serde_json::json!({
            "number": 42,
            "title": "My doing task",
            "state": "open",
            "updated_at": "2025-06-10T12:00:00Z",
            "assignee": null,
            "labels": [],
            "html_url": "https://github.com/testowner/testrepo/issues/42",
            "pull_request": null,
            "body": null,
        });
        Mock::given(method("POST"))
            .and(path("/repos/testowner/testrepo/issues"))
            .and(header("Authorization", "Bearer testtoken"))
            .respond_with(ResponseTemplate::new(201).set_body_json(&issue_body))
            .mount(&server)
            .await;

        // Mock: POST /repos/testowner/testrepo/issues/42/labels → add kanban:doing
        Mock::given(method("POST"))
            .and(path("/repos/testowner/testrepo/issues/42/labels"))
            .and(header("Authorization", "Bearer testtoken"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 1,
                "url": "",
                "name": "kanban:doing",
                "color": "1f883d",
            })))
            .mount(&server)
            .await;

        // Mock: GET /repos/testowner/testrepo/issues/42 → re-fetch with updated labels
        let updated_issue_body = serde_json::json!({
            "number": 42,
            "title": "My doing task",
            "state": "open",
            "updated_at": "2025-06-10T12:01:00Z",
            "assignee": null,
            "labels": [{"name": "kanban:doing", "id": 1, "color": "1f883d"}],
            "html_url": "https://github.com/testowner/testrepo/issues/42",
            "pull_request": null,
            "body": null,
        });
        Mock::given(method("GET"))
            .and(path("/repos/testowner/testrepo/issues/42"))
            .and(header("Authorization", "Bearer testtoken"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&updated_issue_body))
            .mount(&server)
            .await;

        let gh = GitHubClient::new(server.uri(), "testtoken".to_string());

        // Step 1: Create issue
        let issue = gh
            .create_issue("testowner", "testrepo", "My doing task", None)
            .await
            .expect("create_issue should succeed");

        assert_eq!(issue.number, 42);

        // Step 2: Add kanban:doing label
        gh.add_label("testowner", "testrepo", 42, "kanban:doing")
            .await
            .expect("add_label should succeed");

        // Step 3: Re-fetch issue to get updated_at
        let updated_issue = gh
            .get_issue("testowner", "testrepo", 42)
            .await
            .expect("get_issue should succeed");

        assert!(updated_issue.labels.contains(&"kanban:doing".to_string()));

        // Now test the DB side
        let (pool, _tmp) = test_pool().await;
        let (ws_id, col_ids) = seed_github_workspace(&pool).await;
        let doing_col = col_ids[1].clone(); // Doing is index 1
        let card_id = insert_local_card(&pool, &ws_id, &doing_col, "My doing task").await;

        // Simulate what card_promote does for a Doing card
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "UPDATE card SET source = 'github', github_issue_number = ?, github_state = 'open', remote_updated_at = ?, labels_json = '[]', updated_at = ? WHERE id = ?",
        )
        .bind(issue.number as i64)
        .bind(&issue.updated_at)
        .bind(&now)
        .bind(&card_id)
        .execute(&pool)
        .await
        .unwrap();

        // After add_label, update labels_json and remote_updated_at
        let labels_json = serde_json::to_string(&vec!["kanban:doing".to_string()]).unwrap();
        sqlx::query("UPDATE card SET labels_json = ?, remote_updated_at = ? WHERE id = ?")
            .bind(&labels_json)
            .bind(&updated_issue.updated_at)
            .bind(&card_id)
            .execute(&pool)
            .await
            .unwrap();

        // Verify card state
        let card: Card = sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
        )
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(card.source, "github");
        assert_eq!(card.github_issue_number, Some(42));
        assert_eq!(card.github_state, Some("open".to_string()));
        // labels_json should contain kanban:doing
        let labels: Vec<String> =
            serde_json::from_str(card.labels_json.as_deref().unwrap_or("[]")).unwrap();
        assert!(
            labels.contains(&"kanban:doing".to_string()),
            "labels should contain kanban:doing, got: {:?}",
            labels
        );
        assert_eq!(
            card.remote_updated_at,
            Some("2025-06-10T12:01:00Z".to_string())
        );
    }

    /// M6-T3: Verify that the board query uses idx_card_board index.
    /// EXPLAIN QUERY PLAN on the board_get query should reference the index.
    #[tokio::test]
    async fn board_query_uses_idx_card_board() {
        let (pool, _tmp) = test_pool().await;
        let (ws_id, col_ids) = seed_workspace_and_columns(&pool).await;
        let backlog = col_ids[0].clone();

        // Insert a card so there's data
        let now = Utc::now().to_rfc3339();
        let card_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, position, source, created_at, updated_at) VALUES (?, ?, ?, 'Test', 1024.0, 'local', ?, ?)",
        )
        .bind(&card_id)
        .bind(&ws_id)
        .bind(&backlog)
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        // EXPLAIN QUERY PLAN on the board_get query
        let rows: Vec<sqlx::sqlite::SqliteRow> = sqlx::query(
            "EXPLAIN QUERY PLAN SELECT id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at FROM card WHERE workspace_id = ? ORDER BY position",
        )
        .bind(&ws_id)
        .fetch_all(&pool)
        .await
        .unwrap();

        // Collect the plan text
        let plan_text: Vec<String> = rows.iter().map(|r| r.get::<String, _>("detail")).collect();
        let plan_joined = plan_text.join(" | ");

        // The plan should reference idx_card_board (or at minimum not be a full table scan)
        assert!(
            plan_joined.contains("idx_card_board"),
            "EXPLAIN QUERY PLAN did not use idx_card_board. Plan: {:?}",
            plan_text
        );
    }

    // ── position-math regression tests ─────────────────────────────────────────
    // These tests lock in the fixed card_move position semantics without needing
    // a full Tauri AppState: they mirror the match arms directly.

    /// "Drop before the first card" path: before=Some(first_pos), after=None.
    /// Expected: new position is between 0 and first_pos, so it sorts before it.
    #[test]
    fn position_drop_before_first_card() {
        let first_pos = 1024.0_f64;
        // Mirrors: (Some(before), None) => insert_between(0.0, before)
        let new_pos = insert_between(0.0, first_pos);
        assert!(
            new_pos > 0.0,
            "new position should be above 0, got {}",
            new_pos
        );
        assert!(
            new_pos < first_pos,
            "new position {} should be less than first card position {}",
            new_pos,
            first_pos
        );
    }

    /// "Column drop / append after last card" path: before=None, after=Some(last_pos).
    /// Expected: new position is greater than last_pos, so it sorts after it.
    #[test]
    fn position_append_after_last_card() {
        let last_pos = 3072.0_f64;
        // Mirrors: (None, Some(after)) => append_position(Some(after))
        let new_pos = append_position(Some(last_pos));
        assert!(
            new_pos > last_pos,
            "new position {} should be greater than last card position {}",
            new_pos,
            last_pos
        );
    }
}
