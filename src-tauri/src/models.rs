use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub root_path: String,
    pub github_owner: Option<String>,
    pub github_repo: Option<String>,
    pub startup_command: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BoardColumn {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Card {
    pub id: String,
    pub workspace_id: String,
    pub column_id: String,
    pub title: String,
    pub body_preview: Option<String>,
    pub position: f64,
    pub source: String,
    pub github_issue_number: Option<i64>,
    pub github_state: Option<String>,
    pub assignee: Option<String>,
    pub labels_json: Option<String>,
    pub remote_updated_at: Option<String>,
    pub terminal_window_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardGetResult {
    pub columns: Vec<BoardColumn>,
    pub cards: Vec<Card>,
}
