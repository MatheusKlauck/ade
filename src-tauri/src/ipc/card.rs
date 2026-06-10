use crate::error::AdeError;
use crate::models::Card;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn card_detail(
    card_id: String,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<Card, AdeError> {
    let card: Option<Card> = sqlx::query_as::<_, Card>(
        "SELECT id, workspace_id, column_id, title, body_preview, position, source, \
         github_issue_number, github_state, assignee, labels_json, remote_updated_at, \
         terminal_window_id, created_at, updated_at \
         FROM card WHERE id = ?",
    )
    .bind(&card_id)
    .fetch_optional(&state.db)
    .await
    .map_err(AdeError::Db)?;

    match card {
        Some(c) => Ok(c),
        None => Err(AdeError::Other(format!("card not found: {}", card_id))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
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
            "INSERT INTO workspace (id, name, slug, root_path, created_at) \
             VALUES (?, 'Dev', 'dev', '/tmp/dev', ?)",
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
                "INSERT INTO board_column (id, workspace_id, name, position) \
                 VALUES (?, ?, ?, ?)",
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
    async fn card_detail_returns_card() {
        let (pool, _tmp) = test_pool().await;
        let (ws_id, col_ids) = seed_workspace_and_columns(&pool).await;
        let backlog = col_ids[0].clone();

        let now = Utc::now().to_rfc3339();
        let card_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, position, source, \
             created_at, updated_at) \
             VALUES (?, ?, ?, 'Test card', 1024.0, 'local', ?, ?)",
        )
        .bind(&card_id)
        .bind(&ws_id)
        .bind(&backlog)
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        let card: Card = sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, \
             github_issue_number, github_state, assignee, labels_json, remote_updated_at, \
             terminal_window_id, created_at, updated_at \
             FROM card WHERE id = ?",
        )
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(card.id, card_id);
        assert_eq!(card.title, "Test card");
        assert_eq!(card.workspace_id, ws_id);
        assert_eq!(card.column_id, backlog);
        assert_eq!(card.position, 1024.0);
        assert_eq!(card.source, "local");
    }

    #[tokio::test]
    async fn card_detail_not_found() {
        let (pool, _tmp) = test_pool().await;
        let nonexistent = uuid::Uuid::new_v4().to_string();

        let result: Option<Card> = sqlx::query_as::<_, Card>(
            "SELECT id, workspace_id, column_id, title, body_preview, position, source, \
             github_issue_number, github_state, assignee, labels_json, remote_updated_at, \
             terminal_window_id, created_at, updated_at \
             FROM card WHERE id = ?",
        )
        .bind(&nonexistent)
        .fetch_optional(&pool)
        .await
        .unwrap();

        assert!(result.is_none());
    }
}
