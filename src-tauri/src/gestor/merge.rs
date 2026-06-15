// merge.rs (#55): PR → shipped (PLANO §1 publicar/shipped, D5/D10). CI is polled
// via check-runs; a green PR becomes ready_to_merge. L2 waits for a human click
// (the pr_merge IPC calls merge_task); L3 auto-merges. Merge is serialized — the
// runtime merges one task per workspace per tick — and on success closes the
// issue, moves the card to Done, and cleans the worktree.
//
// ponytail: wired into the runtime loop (not spawned from setup() yet); allow.
#![allow(dead_code)]

use crate::db::DbPool;
use crate::error::AdeError;
use crate::gestor::fsm::{self, TaskState};
use crate::gh::client::GitHubClient;
use crate::gh::types::CheckRun;
use crate::models::AgentTask;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum CiStatus {
    None,    // no checks configured
    Pending, // some still running
    Passed,  // all completed successfully
    Failed,  // at least one failed/cancelled/timed_out
}

/// Summarize check runs into a single CI status (pure, testable).
pub fn ci_status(runs: &[CheckRun]) -> CiStatus {
    if runs.is_empty() {
        return CiStatus::None;
    }
    let mut all_done = true;
    for r in runs {
        if r.status != "completed" {
            all_done = false;
        } else if matches!(
            r.conclusion.as_deref(),
            Some("failure") | Some("cancelled") | Some("timed_out") | Some("action_required")
        ) {
            return CiStatus::Failed;
        }
    }
    if all_done {
        CiStatus::Passed
    } else {
        CiStatus::Pending
    }
}

/// Poll CI for a task that has an open PR and advance the FSM: pr_open → ci_wait,
/// then ci_wait → ready_to_merge (green, or no checks when `require_ci` is false)
/// / awaiting_input (red) / stay (pending).
pub async fn process_ci(
    db: &DbPool,
    gh: &GitHubClient,
    owner: &str,
    repo: &str,
    repo_path: &str,
    task: &AgentTask,
    require_ci: bool,
) -> Result<(), AdeError> {
    if task.state == "pr_open" {
        fsm::transition(db, &task.id, TaskState::CiWait, None).await?;
    }
    let Some(branch) = task.branch.as_deref() else {
        return Ok(());
    };
    let Some(sha) = crate::gitlocal::head_sha(repo_path, branch) else {
        return Ok(());
    };
    let runs = gh.list_check_runs(owner, repo, &sha).await?;
    match ci_status(&runs) {
        CiStatus::Passed => {
            fsm::transition(db, &task.id, TaskState::ReadyToMerge, Some("CI green")).await?;
        }
        CiStatus::None if !require_ci => {
            fsm::transition(
                db,
                &task.id,
                TaskState::ReadyToMerge,
                Some("no CI configured"),
            )
            .await?;
        }
        CiStatus::Failed => {
            fsm::transition(db, &task.id, TaskState::AwaitingInput, Some("CI failed")).await?;
        }
        _ => {} // pending / (none + require_ci) → keep waiting
    }
    Ok(())
}

/// Merge a `ready_to_merge` task and ship it: merge the PR, close the issue, move
/// the card to Done, clean the worktree. The single mutation path for merging
/// (call it for L3 auto-merge or from the L2 pr_merge IPC). Serialization is the
/// caller's job (merge one per workspace per tick).
pub async fn merge_task(
    db: &DbPool,
    gh: &GitHubClient,
    owner: &str,
    repo: &str,
    repo_path: &str,
    task: &AgentTask,
) -> Result<(), AdeError> {
    let card = crate::repo::card_by_id_required(db, &task.card_id).await?;
    let pr_number = pr_number_for_task(db, task).await;
    let Some(pr_number) = pr_number else {
        return Err(AdeError::Other("no PR number recorded for task".into()));
    };

    fsm::transition(db, &task.id, TaskState::Merging, None).await?;

    let merged = gh.merge_pr(owner, repo, pr_number).await?;
    if !merged {
        fsm::transition(
            db,
            &task.id,
            TaskState::AwaitingInput,
            Some("GitHub declined the merge (conflicts?)"),
        )
        .await?;
        return Ok(());
    }

    fsm::transition(db, &task.id, TaskState::Merged, None).await?;

    // Close the tracked issue (best-effort).
    if let Some(n) = card.github_issue_number {
        let _ = gh.set_issue_state(owner, repo, n as u64, "closed").await;
    }

    // Card → Done, then clean up the worktree/window.
    let now = chrono::Utc::now().to_rfc3339();
    let _ = crate::repo::move_card_to_column(db, &card.id, &task.workspace_id, "Done", &now).await;
    fsm::transition(db, &task.id, TaskState::Cleanup, None).await?;
    crate::gestor::dispatch::cleanup(db, repo_path, &task.id).await;
    fsm::transition(db, &task.id, TaskState::Done, None).await?;
    Ok(())
}

/// Recover the PR number from the task's `pr_opened` agent_event (publish records
/// it there; structured pr_number on the card is #56).
async fn pr_number_for_task(db: &DbPool, task: &AgentTask) -> Option<u64> {
    let events = crate::repo::agent_events_for_workspace(db, &task.workspace_id, 200)
        .await
        .ok()?;
    events
        .iter()
        .filter(|e| e.task_id.as_deref() == Some(task.id.as_str()) && e.kind == "pr_opened")
        .find_map(|e| {
            let v: serde_json::Value = serde_json::from_str(e.payload_json.as_deref()?).ok()?;
            v["number"].as_u64()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(status: &str, conclusion: Option<&str>) -> CheckRun {
        CheckRun {
            status: status.into(),
            conclusion: conclusion.map(|s| s.into()),
        }
    }

    #[test]
    fn ci_status_summary() {
        assert_eq!(ci_status(&[]), CiStatus::None);
        assert_eq!(
            ci_status(&[run("completed", Some("success"))]),
            CiStatus::Passed
        );
        assert_eq!(
            ci_status(&[run("completed", Some("success")), run("in_progress", None)]),
            CiStatus::Pending
        );
        assert_eq!(
            ci_status(&[
                run("completed", Some("success")),
                run("completed", Some("failure"))
            ]),
            CiStatus::Failed
        );
        // neutral/skipped count as not-failed
        assert_eq!(
            ci_status(&[run("completed", Some("skipped"))]),
            CiStatus::Passed
        );
    }
}
