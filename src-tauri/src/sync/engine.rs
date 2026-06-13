// M2-T5: Sync engine — pure functions, no I/O
use crate::gh::types::{ColumnName, RemoteIssue, SyncAction};

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct CardSnapshot {
    pub card_id: String,
    pub column: ColumnName,
    pub remote_updated_at: Option<String>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct PendingIntent {
    pub base_remote_updated_at: Option<String>,
    pub to: ColumnName,
}

/// desired_column: closed → Done; has label kanban:doing → Doing;
/// kanban:paused → Paused; kanban:pr → Pr; else → Backlog.
#[allow(dead_code)]
pub fn desired_column(issue: &RemoteIssue) -> ColumnName {
    if issue.state == "closed" {
        return ColumnName::Done;
    }
    // First match among labels
    for label in &issue.labels {
        match label.as_str() {
            "kanban:doing" => return ColumnName::Doing,
            "kanban:paused" => return ColumnName::Paused,
            "kanban:pr" => return ColumnName::Pr,
            _ => {}
        }
    }
    ColumnName::Backlog
}

/// reconcile: first-match-wins decision table per CONTRACTS §12.
#[allow(dead_code)]
pub fn reconcile(
    remote: &RemoteIssue,
    local: Option<&CardSnapshot>,
    pending: Option<&PendingIntent>,
) -> SyncAction {
    // Row 1: ignore PRs
    if remote.is_pull_request {
        return SyncAction::Ignore;
    }

    // Row 2: create card for open, unknown issues
    if local.is_none() && remote.state == "open" {
        return SyncAction::CreateCard {
            issue: Box::new(remote.clone()),
            column: desired_column(remote),
        };
    }

    // Row 3: ignore closed issues with no local card
    if local.is_none() && remote.state == "closed" {
        return SyncAction::Ignore;
    }

    // Row 4: skip if there's a pending outbox intent (queued write suspends reconciliation)
    if pending.is_some() {
        return SyncAction::Ignore;
    }

    let local = local.expect("local must exist after row 2 & 3");

    // Row 5: nothing new — same updated_at
    if remote.updated_at == local.remote_updated_at.as_deref().unwrap_or("") {
        return SyncAction::Ignore;
    }

    let desired = desired_column(remote);

    // Row 6: echo of our own write, or metadata-only change — refresh fields, never move
    if desired == local.column {
        return SyncAction::RefreshCardFields {
            card_id: local.card_id.clone(),
        };
    }

    // Row 7: otherwise — remote moved the card
    SyncAction::MoveCard {
        card_id: local.card_id.clone(),
        to: desired,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gh::types::{ColumnName, RemoteIssue, SyncAction};

    fn make_issue(number: u64, state: &str, labels: &[&str], updated_at: &str) -> RemoteIssue {
        RemoteIssue {
            number,
            title: format!("Issue #{}", number),
            state: state.to_string(),
            updated_at: updated_at.to_string(),
            assignee: None,
            labels: labels.iter().map(|s| s.to_string()).collect(),
            html_url: format!("https://github.com/owner/repo/issues/{}", number),
            is_pull_request: false,
            body_preview: None,
            body: None,
            labels_detailed: Vec::new(),
            assignee_avatar_url: None,
        }
    }

    fn make_pr(number: u64, updated_at: &str) -> RemoteIssue {
        let mut issue = make_issue(number, "open", &[], updated_at);
        issue.is_pull_request = true;
        issue
    }

    fn make_snapshot(card_id: &str, column: ColumnName, remote_updated_at: &str) -> CardSnapshot {
        CardSnapshot {
            card_id: card_id.to_string(),
            column,
            remote_updated_at: Some(remote_updated_at.to_string()),
        }
    }

    fn make_pending() -> PendingIntent {
        PendingIntent {
            base_remote_updated_at: Some("2025-01-01T00:00:00Z".to_string()),
            to: ColumnName::Paused,
        }
    }

    // --- desired_column tests ---

    #[test]
    fn desired_column_closed_is_done() {
        let issue = make_issue(1, "closed", &[], "2025-01-01T00:00:00Z");
        assert_eq!(desired_column(&issue), ColumnName::Done);
    }

    #[test]
    fn desired_column_labels_map_to_columns() {
        let issue = make_issue(2, "open", &["kanban:doing"], "2025-01-01T00:00:00Z");
        assert_eq!(desired_column(&issue), ColumnName::Doing);

        let issue = make_issue(3, "open", &["kanban:paused"], "2025-01-01T00:00:00Z");
        assert_eq!(desired_column(&issue), ColumnName::Paused);

        let issue = make_issue(4, "open", &["kanban:pr"], "2025-01-01T00:00:00Z");
        assert_eq!(desired_column(&issue), ColumnName::Pr);
    }

    #[test]
    fn desired_column_first_kanban_label_wins() {
        let issue = make_issue(
            5,
            "open",
            &["kanban:doing", "kanban:paused"],
            "2025-01-01T00:00:00Z",
        );
        assert_eq!(desired_column(&issue), ColumnName::Doing);
    }

    #[test]
    fn desired_column_no_label_defaults_to_backlog() {
        let issue = make_issue(6, "open", &["bug", "enhancement"], "2025-01-01T00:00:00Z");
        assert_eq!(desired_column(&issue), ColumnName::Backlog);
    }

    // Row 1: ignore PRs
    #[test]
    fn reconcile_ignores_prs() {
        let remote = make_pr(10, "2025-01-02T00:00:00Z");
        let local = Some(make_snapshot(
            "card-1",
            ColumnName::Backlog,
            "2025-01-01T00:00:00Z",
        ));
        let result = reconcile(&remote, local.as_ref(), None);
        assert_eq!(result, SyncAction::Ignore);
    }

    // Row 2: create card for open, unknown issues
    #[test]
    fn reconcile_creates_open_unknown() {
        let remote = make_issue(20, "open", &[], "2025-01-02T00:00:00Z");
        let result = reconcile(&remote, None, None);
        assert_eq!(
            result,
            SyncAction::CreateCard {
                issue: Box::new(remote.clone()),
                column: ColumnName::Backlog,
            }
        );
    }

    // Row 3: ignore closed issues with no local card
    #[test]
    fn reconcile_ignores_closed_unknown() {
        let remote = make_issue(30, "closed", &[], "2025-01-02T00:00:00Z");
        let result = reconcile(&remote, None, None);
        assert_eq!(result, SyncAction::Ignore);
    }

    // Row 4: skip pending intent
    #[test]
    fn reconcile_skips_pending_intent() {
        let remote = make_issue(40, "open", &["kanban:doing"], "2025-01-03T00:00:00Z");
        let local = Some(make_snapshot(
            "card-4",
            ColumnName::Backlog,
            "2025-01-01T00:00:00Z",
        ));
        let pending = Some(make_pending());
        let result = reconcile(&remote, local.as_ref(), pending.as_ref());
        assert_eq!(result, SyncAction::Ignore);
    }

    // Row 5: same updated_at → noop
    #[test]
    fn reconcile_noop_same_updated_at() {
        let remote = make_issue(50, "open", &["kanban:doing"], "2025-01-02T00:00:00Z");
        let local = Some(make_snapshot(
            "card-5",
            ColumnName::Backlog,
            "2025-01-02T00:00:00Z",
        ));
        let result = reconcile(&remote, local.as_ref(), None);
        assert_eq!(result, SyncAction::Ignore);
    }

    // Row 6: desired column == local column → refresh fields (echo)
    #[test]
    fn reconcile_echo_refreshes_fields() {
        let remote = make_issue(60, "open", &["kanban:doing"], "2025-01-03T00:00:00Z");
        let local = Some(make_snapshot(
            "card-6",
            ColumnName::Doing,
            "2025-01-02T00:00:00Z",
        ));
        let result = reconcile(&remote, local.as_ref(), None);
        assert_eq!(
            result,
            SyncAction::RefreshCardFields {
                card_id: "card-6".to_string(),
            }
        );
    }

    // Row 7: remote moved the card
    #[test]
    fn reconcile_applies_remote_move() {
        let remote = make_issue(70, "open", &["kanban:doing"], "2025-01-03T00:00:00Z");
        let local = Some(make_snapshot(
            "card-7",
            ColumnName::Backlog,
            "2025-01-02T00:00:00Z",
        ));
        let result = reconcile(&remote, local.as_ref(), None);
        assert_eq!(
            result,
            SyncAction::MoveCard {
                card_id: "card-7".to_string(),
                to: ColumnName::Doing,
            }
        );
    }

    // Catch-all property test: for any input, exactly one condition matches (no panics, no ambiguous fallthrough).
    // We enumerate key boundary combinations and assert that reconcile always returns a valid variant.
    #[test]
    fn reconcile_exhaustive_always_returns_valid_action() {
        let states = ["open", "closed"];
        let label_sets: &[&[&str]] = &[&[], &["kanban:doing"], &["kanban:paused"], &["kanban:pr"]];
        let local_options: Vec<Option<CardSnapshot>> = vec![
            None,
            Some(make_snapshot(
                "c",
                ColumnName::Backlog,
                "2025-01-01T00:00:00Z",
            )),
            Some(make_snapshot(
                "c",
                ColumnName::Doing,
                "2025-01-01T00:00:00Z",
            )),
        ];
        let pending_options: Vec<Option<PendingIntent>> = vec![None, Some(make_pending())];

        for state in &states {
            for labels in label_sets {
                for local in &local_options {
                    for pending in &pending_options {
                        // Build a remote issue with is_pull_request both false and true
                        for is_pr in [false, true] {
                            let mut remote = make_issue(1, state, labels, "2025-01-02T00:00:00Z");
                            remote.is_pull_request = is_pr;

                            let result = reconcile(&remote, local.as_ref(), pending.as_ref());
                            // Verify the result is a valid SyncAction variant (not panicking)
                            match result {
                                SyncAction::CreateCard { .. }
                                | SyncAction::MoveCard { .. }
                                | SyncAction::RefreshCardFields { .. }
                                | SyncAction::TouchRemoteUpdatedAt { .. }
                                | SyncAction::Ignore => {
                                    // All valid — test passes for this combination
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
