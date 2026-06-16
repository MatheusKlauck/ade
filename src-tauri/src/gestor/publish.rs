// publish.rs (#49): ADE publishes (PLANO D5). On review approve the core pushes
// the worker's branch (git2 + Keychain PAT via credentials callback — token never
// in argv, worker never has it, D9) and opens the PR, then moves the card to the
// PR column and the task to `pr_open`. CI polling + merge (L2/L3) are pós-fatia
// (#55). The HTTP surface (create_pr/get_pr) is wiremock-tested in gh::client;
// the card move is tested in repo; this module is the integration glue.
//
// ponytail: wired into the runtime loop (not spawned from setup() yet); allow.
#![allow(dead_code)]

use crate::db::DbPool;
use crate::error::AdeError;
use crate::gestor::fsm::{self, TaskState};
use crate::gh::client::GitHubClient;
use crate::models::AgentEvent;

const GITHUB_API: &str = "https://api.github.com";

/// Push a task's branch and open its PR, then card→PR / task→pr_open. The task is
/// expected to be in `pushing`. Failures bubble up so the caller fails the task.
pub async fn publish_task(
    db: &DbPool,
    workspace_id: &str,
    owner: &str,
    repo: &str,
    repo_path: &str,
    base_branch: &str,
    token: &str,
) -> Result<(), AdeError> {
    // The single in-flight task for this workspace in `pushing` (slice-1 is
    // sequential, max_parallel=1).
    let task = crate::repo::agent_tasks_for_workspace(db, workspace_id)
        .await?
        .into_iter()
        .find(|t| t.state == "pushing")
        .ok_or_else(|| AdeError::Other("no task in pushing".into()))?;

    let branch = task
        .branch
        .clone()
        .ok_or_else(|| AdeError::Other("task has no branch to push".into()))?;
    let card = crate::repo::card_by_id_required(db, &task.card_id).await?;

    // 1. Push the branch (core-only, authenticated).
    crate::gitlocal::push(repo_path, &branch, token)?;

    // 2. Open the PR.
    let body = card
        .github_issue_number
        .map(|n| format!("Closes #{n}\n\nOpened by the ADE gestor."))
        .unwrap_or_else(|| "Opened by the ADE gestor.".into());
    let gh = GitHubClient::new(GITHUB_API.to_string(), token.to_string());
    let pr = gh
        .create_pr(owner, repo, &branch, base_branch, &card.title, Some(&body))
        .await?;

    // 3. Card → PR column.
    let now = chrono::Utc::now().to_rfc3339();
    crate::repo::move_card_to_column(db, &card.id, workspace_id, "PR", &now).await?;

    // 4. Record the PR on the feed (structured pr_number/url storage is #55).
    let ev = AgentEvent {
        id: 0,
        workspace_id: workspace_id.to_string(),
        task_id: Some(task.id.clone()),
        job_id: None,
        ts: now,
        kind: "pr_opened".into(),
        level: "info".into(),
        payload_json: Some(
            serde_json::json!({ "number": pr.number, "url": pr.html_url }).to_string(),
        ),
        cost_usd: None,
        num_turns: None,
        duration_ms: None,
    };
    crate::repo::insert_agent_event(db, &ev).await?;

    // 5. task → pr_open.
    fsm::transition(db, &task.id, TaskState::PrOpen, None).await?;
    Ok(())
}
