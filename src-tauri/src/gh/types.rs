// M2-T7: Core types for the GitHub client and sync engine.

/// A GitHub label with its display colour. Used by the card detail view to
/// render coloured chips; the board/ledger only needs names (see
/// `RemoteIssue.labels`).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Label {
    pub name: String,
    pub color: String, // 6-digit hex, no leading '#'
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
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
    pub body: Option<String>,  // full body text (for card detail view)
    // Enrichment for the detail view (not persisted; only the live fetch in
    // card_detail surfaces these). `labels` above stays the names-only list the
    // sync engine reads.
    pub labels_detailed: Vec<Label>,
    pub assignee_avatar_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SyncAction {
    CreateCard {
        // Boxed: RemoteIssue is by far the largest variant payload (full issue
        // + detail enrichment), so boxing keeps SyncAction small.
        issue: Box<RemoteIssue>,
        column: ColumnName,
    },
    MoveCard {
        card_id: String,
        to: ColumnName,
    },
    RefreshCardFields {
        card_id: String,
    },
    #[allow(dead_code)] // constructed only by engine tests today
    TouchRemoteUpdatedAt {
        card_id: String,
    },
    Ignore,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct IssueComment {
    pub id: u64,
    pub user_login: String,
    pub user_avatar_url: Option<String>,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ColumnName {
    Backlog,
    Doing,
    Paused,
    Pr,
    Done,
}

/// The kanban labels managed by ADE on GitHub, with their colors.
pub const KANBAN_LABELS_WITH_COLORS: &[(&str, &str)] = &[
    (KANBAN_DOING, "1f883d"),
    (KANBAN_PAUSED, "d4a72c"),
    (KANBAN_PR, "8250df"),
];

pub const KANBAN_DOING: &str = "kanban:doing";
pub const KANBAN_PAUSED: &str = "kanban:paused";
pub const KANBAN_PR: &str = "kanban:pr";

/// All kanban label names (used for "remove all kanban labels").
pub const KANBAN_LABELS: &[&str] = &[KANBAN_DOING, KANBAN_PAUSED, KANBAN_PR];

impl ColumnName {
    /// The canonical board column name as stored in the DB and shown in the UI.
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            ColumnName::Backlog => "Backlog",
            ColumnName::Doing => "Doing",
            ColumnName::Paused => "Paused",
            ColumnName::Pr => "PR",
            ColumnName::Done => "Done",
        }
    }

    /// Parse a canonical column name. Single source of truth for the
    /// string ↔ enum mapping used by the board, sync worker, and outbox.
    pub fn try_from_str(name: &str) -> Option<ColumnName> {
        match name {
            "Backlog" => Some(ColumnName::Backlog),
            "Doing" => Some(ColumnName::Doing),
            "Paused" => Some(ColumnName::Paused),
            "PR" => Some(ColumnName::Pr),
            "Done" => Some(ColumnName::Done),
            _ => None,
        }
    }

    /// The kanban label that marks this column on GitHub.
    /// Done and Backlog have no label.
    pub fn kanban_label(&self) -> Option<&'static str> {
        match self {
            ColumnName::Doing => Some(KANBAN_DOING),
            ColumnName::Paused => Some(KANBAN_PAUSED),
            ColumnName::Pr => Some(KANBAN_PR),
            ColumnName::Done | ColumnName::Backlog => None,
        }
    }
}
