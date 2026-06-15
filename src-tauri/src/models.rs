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

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AgentTask {
    pub id: String,
    pub workspace_id: String,
    pub card_id: String,
    pub state: String,
    pub attempt: i64,
    pub max_attempts: i64,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub window_id: Option<String>,
    pub events_file: Option<String>,
    pub fail_reason: Option<String>,
    pub last_event_at: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct GestorJob {
    pub id: String,
    pub workspace_id: String,
    pub kind: String,
    pub state: String,
    pub input_json: String,
    pub output_json: Option<String>,
    pub error: Option<String>,
    pub cost_usd: Option<f64>,
    pub num_turns: Option<i64>,
    pub duration_ms: Option<i64>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct IssueProposal {
    pub id: String,
    pub job_id: String,
    pub workspace_id: String,
    pub ord: i64,
    pub title: String,
    pub body: String,
    pub labels_json: Option<String>,
    pub depends_on_json: Option<String>,
    pub acceptance_json: Option<String>,
    pub priority: Option<String>,
    pub status: String,
    pub card_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AgentEvent {
    pub id: i64,
    pub workspace_id: String,
    pub task_id: Option<String>,
    pub job_id: Option<String>,
    pub ts: String,
    pub kind: String,
    pub level: String,
    pub payload_json: Option<String>,
    pub cost_usd: Option<f64>,
    pub num_turns: Option<i64>,
    pub duration_ms: Option<i64>,
}
