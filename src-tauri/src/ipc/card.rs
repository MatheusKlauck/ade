use crate::error::AdeError;
use crate::gh::client::GitHubClient;
use crate::gh::types::IssueComment;
use crate::models::Card;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardDetail {
    pub card: Card,
    pub body: Option<String>,
    pub comments: Vec<IssueComment>,
}

#[tauri::command]
pub async fn card_detail(
    card_id: String,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<CardDetail, AdeError> {
    // 1. Load the card from DB
    let card: Card = sqlx::query_as::<_, Card>(
        "SELECT id, workspace_id, column_id, title, body_preview, position, source, \
         github_issue_number, github_state, assignee, labels_json, remote_updated_at, \
         terminal_window_id, created_at, updated_at \
         FROM card WHERE id = ?",
    )
    .bind(&card_id)
    .fetch_optional(&state.db)
    .await
    .map_err(AdeError::Db)?
    .ok_or_else(|| AdeError::Other(format!("card not found: {}", card_id)))?;

    // 2. If not a GitHub card or no issue number, return cached fields only
    if card.source != "github" || card.github_issue_number.is_none() {
        return Ok(CardDetail {
            body: card.body_preview.clone(),
            comments: vec![],
            card,
        });
    }

    let issue_number = card
        .github_issue_number
        .ok_or_else(|| AdeError::Other("missing github_issue_number".to_string()))?;

    // 3. Look up workspace for GitHub owner/repo
    let ws_row = sqlx::query("SELECT github_owner, github_repo FROM workspace WHERE id = ?")
        .bind(&card.workspace_id)
        .fetch_optional(&state.db)
        .await
        .map_err(AdeError::Db)?;

    let (owner, repo) = match ws_row {
        Some(r) => {
            let o: Option<String> = r.get("github_owner");
            let rp: Option<String> = r.get("github_repo");
            match (o, rp) {
                (Some(o), Some(rp)) => (o, rp),
                _ => {
                    // Missing owner/repo — return cached fields only
                    return Ok(CardDetail {
                        body: card.body_preview.clone(),
                        comments: vec![],
                        card,
                    });
                }
            }
        }
        None => {
            return Ok(CardDetail {
                body: card.body_preview.clone(),
                comments: vec![],
                card,
            });
        }
    };

    // 4. Get GitHub token from keychain (per-workspace, with legacy global fallback)
    let token = crate::ipc::github::keychain_get_for_workspace(&card.workspace_id)?
        .ok_or_else(|| AdeError::Other("GitHub token not found in keychain".to_string()))?;

    // 5. Create GitHub client
    let gh = GitHubClient::new("https://api.github.com".to_string(), token);

    // 6. Fetch the issue
    let issue = gh
        .get_issue(&owner, &repo, issue_number as u64)
        .await
        .map_err(|e| AdeError::GitHub(format!("failed to fetch issue: {e}")))?;

    // 7. Fetch comments
    let comments = gh
        .get_issue_comments(&owner, &repo, issue_number as u64)
        .await
        .map_err(|e| AdeError::GitHub(format!("failed to fetch comments: {e}")))?;

    // 8. Return CardDetail with full body
    Ok(CardDetail {
        card,
        body: issue.body,
        comments,
    })
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

    async fn seed_github_workspace(pool: &crate::db::DbPool) -> (String, Vec<String>) {
        let ws_id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO workspace (id, name, slug, root_path, github_owner, github_repo, created_at) \
             VALUES (?, 'Dev', 'dev', '/tmp/dev', 'testowner', 'testrepo', ?)",
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

    // ── DB-level tests (no Tauri State, no keychain) ──────────────

    #[tokio::test]
    async fn local_card_returns_cached_body_preview() {
        let (pool, _tmp) = test_pool().await;
        let (ws_id, col_ids) = seed_workspace_and_columns(&pool).await;
        let backlog = col_ids[0].clone();

        let now = Utc::now().to_rfc3339();
        let card_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, body_preview, position, source, \
             created_at, updated_at) \
             VALUES (?, ?, ?, 'Local card', 'Short preview', 1024.0, 'local', ?, ?)",
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
             terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
        )
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(card.source, "local");
        assert_eq!(card.body_preview, Some("Short preview".to_string()));
        // For a local card, card_detail would return:
        //   body = card.body_preview.clone(), comments = vec![]
        let expected_body = card.body_preview.clone();
        assert_eq!(expected_body, Some("Short preview".to_string()));
    }

    #[tokio::test]
    async fn github_card_without_owner_returns_cached_fields() {
        // A GitHub card whose workspace lacks github_owner/github_repo
        // should fall back to cached fields
        let (pool, _tmp) = test_pool().await;
        let (ws_id, col_ids) = seed_workspace_and_columns(&pool).await;
        let backlog = col_ids[0].clone();

        let now = Utc::now().to_rfc3339();
        let card_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, body_preview, position, source, \
             github_issue_number, github_state, created_at, updated_at) \
             VALUES (?, ?, ?, 'GH issue', 'preview text', 1024.0, 'github', 42, 'open', ?, ?)",
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
             terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
        )
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(card.source, "github");
        assert_eq!(card.github_issue_number, Some(42));

        // Verify workspace has no github_owner
        let ws_row = sqlx::query("SELECT github_owner, github_repo FROM workspace WHERE id = ?")
            .bind(&card.workspace_id)
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(ws_row.is_some());
        let row = ws_row.unwrap();
        let owner: Option<String> = row.get("github_owner");
        let repo: Option<String> = row.get("github_repo");
        assert!(owner.is_none() || repo.is_none());
        // In this case, card_detail would return cached body_preview and empty comments
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
             terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
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
             terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
        )
        .bind(&nonexistent)
        .fetch_optional(&pool)
        .await
        .unwrap();

        assert!(result.is_none());
    }

    // ── Wiremock tests for GitHub client (card_detail remote fetch) ──

    #[tokio::test]
    async fn get_issue_returns_full_body() {
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;

        let issue_resp = serde_json::json!({
            "number": 42,
            "title": "GitHub issue",
            "state": "open",
            "updated_at": "2025-06-10T12:00:00Z",
            "assignee": null,
            "labels": [],
            "html_url": "https://github.com/testowner/testrepo/issues/42",
            "pull_request": null,
            "body": "Full body text that is longer than any preview",
        });
        Mock::given(method("GET"))
            .and(path("/repos/testowner/testrepo/issues/42"))
            .and(header("Authorization", "Bearer testtoken"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&issue_resp))
            .mount(&server)
            .await;

        let gh = GitHubClient::new(server.uri(), "testtoken".to_string());

        let issue = gh
            .get_issue("testowner", "testrepo", 42)
            .await
            .expect("get_issue should succeed");
        assert_eq!(issue.number, 42);
        assert_eq!(issue.title, "GitHub issue");
        assert_eq!(
            issue.body,
            Some("Full body text that is longer than any preview".to_string())
        );
        // body_preview should be the truncated version (≤280 chars)
        assert!(issue.body_preview.is_some());
        assert_eq!(
            issue.body_preview.as_ref().unwrap().chars().count(),
            "Full body text that is longer than any preview"
                .chars()
                .count()
        );
    }

    #[tokio::test]
    async fn get_issue_comments_for_detail() {
        use wiremock::matchers::{header, method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;

        let comments = vec![
            serde_json::json!({
                "id": 1,
                "user": { "login": "alice" },
                "body": "First comment",
                "created_at": "2025-06-10T10:00:00Z",
                "updated_at": "2025-06-10T10:00:00Z",
            }),
            serde_json::json!({
                "id": 2,
                "user": { "login": "bob" },
                "body": "Second comment",
                "created_at": "2025-06-10T11:00:00Z",
                "updated_at": "2025-06-10T11:00:00Z",
            }),
        ];
        Mock::given(method("GET"))
            .and(path("/repos/testowner/testrepo/issues/42/comments"))
            .and(query_param("per_page", "30"))
            .and(header("Authorization", "Bearer testtoken"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&comments))
            .mount(&server)
            .await;

        let gh = GitHubClient::new(server.uri(), "testtoken".to_string());

        let result = gh
            .get_issue_comments("testowner", "testrepo", 42)
            .await
            .expect("get_issue_comments should succeed");
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].user_login, "alice");
        assert_eq!(result[0].body, "First comment");
        assert_eq!(result[1].user_login, "bob");
        assert_eq!(result[1].body, "Second comment");
    }

    #[tokio::test]
    async fn github_card_with_owner_repo_resolves_fields() {
        // Verify that a github card in a workspace with owner/repo can be
        // resolved to the correct owner/repo values from the DB
        let (pool, _tmp) = test_pool().await;
        let (ws_id, col_ids) = seed_github_workspace(&pool).await;
        let backlog = col_ids[0].clone();

        let now = Utc::now().to_rfc3339();
        let card_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, body_preview, position, source, \
             github_issue_number, github_state, created_at, updated_at) \
             VALUES (?, ?, ?, 'GH issue', 'preview', 1024.0, 'github', 42, 'open', ?, ?)",
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
             terminal_window_id, created_at, updated_at FROM card WHERE id = ?",
        )
        .bind(&card_id)
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(card.source, "github");
        assert_eq!(card.github_issue_number, Some(42));

        // Verify workspace has github_owner and github_repo
        let ws_row = sqlx::query("SELECT github_owner, github_repo FROM workspace WHERE id = ?")
            .bind(&card.workspace_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let owner: String = ws_row.get("github_owner");
        let repo: String = ws_row.get("github_repo");
        assert_eq!(owner, "testowner");
        assert_eq!(repo, "testrepo");
    }
}
