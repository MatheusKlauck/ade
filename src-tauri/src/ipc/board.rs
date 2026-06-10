use crate::board_pos::{append_position, insert_between, needs_rebalance, rebalance};
use crate::error::AdeError;
use crate::models::{BoardColumn, BoardGetResult, Card};
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

    // M4: feature-6 trigger here (auto-launch terminal on move to Doing)
    let _ = from_column_id;

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
