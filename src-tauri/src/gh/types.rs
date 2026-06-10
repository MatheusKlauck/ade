// M2-T7: Core types for the GitHub client and sync engine.

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[allow(dead_code)]
pub struct RemoteIssue {
    pub number: u64,
    pub title: String,
    pub state: String,            // "open" | "closed"
    pub updated_at: String,       // ISO-8601
    pub assignee: Option<String>, // login
    pub labels: Vec<String>,      // names only
    pub html_url: String,
    pub is_pull_request: bool, // true if raw JSON has "pull_request" key
    pub body_preview: Option<String>, // first 280 chars of body
}

#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub enum SyncAction {
    CreateCard {
        issue: RemoteIssue,
        column: ColumnName,
    },
    MoveCard {
        card_id: String,
        to: ColumnName,
    },
    RefreshCardFields {
        card_id: String,
    },
    TouchRemoteUpdatedAt {
        card_id: String,
    },
    Ignore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum ColumnName {
    Backlog,
    Doing,
    Paused,
    Pr,
    Done,
}
