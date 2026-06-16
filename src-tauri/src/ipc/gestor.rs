// ipc/gestor.rs (#56): the Tauri command surface for the Gestor panel. Exposes
// the intake (plan → proposals → approve), the live feed + tasks, on-demand
// release notes, and the L2 human merge gate. Each command runs the tested
// gestor library functions; the autonomous loop (runtime) is spawned separately.

use crate::error::AdeError;
use crate::models::{AgentEvent, AgentTask, IssueProposal};
use crate::AppState;
use std::path::Path;
use std::sync::Arc;
use tauri::State;

fn repo_path_for(ws: &crate::models::Workspace) -> String {
    crate::gitlocal::find_repo_path(&ws.root_path).unwrap_or_else(|| ws.root_path.clone())
}

/// Intake: turn a brief into repo-grounded proposals (claude -p). Returns the
/// proposals (status `proposed`); the UI reviews then calls `proposal_approve`.
#[tauri::command]
pub async fn gestor_plan(
    state: State<'_, Arc<AppState>>,
    workspace_id: String,
    brief: String,
) -> Result<Vec<IssueProposal>, AdeError> {
    let ws = crate::repo::workspace_by_id(&state.db, &workspace_id).await?;
    let repo = repo_path_for(&ws);
    let provider = crate::gestor::provider::ClaudeCli::new();
    let (_, proposals) = crate::gestor::plan::plan_issues(
        &state.db,
        &provider,
        &workspace_id,
        &brief,
        Path::new(&repo),
    )
    .await?;
    Ok(proposals)
}

/// Approve a batch of proposals → create local Backlog cards (deterministic).
#[tauri::command]
pub async fn proposal_approve(
    state: State<'_, Arc<AppState>>,
    workspace_id: String,
    proposal_ids: Vec<String>,
) -> Result<Vec<String>, AdeError> {
    crate::gestor::plan::approve_proposals(&state.db, &workspace_id, &proposal_ids).await
}

/// Send a card to the gestor: create a `queued` agent_task the runtime will pick
/// up and dispatch. Returns the new task id. (One in-flight task per card.)
#[tauri::command]
pub async fn gestor_enqueue_card(
    state: State<'_, Arc<AppState>>,
    workspace_id: String,
    card_id: String,
) -> Result<String, AdeError> {
    let card = crate::repo::card_by_id_required(&state.db, &card_id).await?;
    let cfg = crate::gestor::dispatch::load_dispatch_config(&state.db, &workspace_id).await;
    let now = chrono::Utc::now().to_rfc3339();
    let task = AgentTask {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id: workspace_id.clone(),
        card_id: card.id,
        state: "queued".into(),
        attempt: 1,
        max_attempts: cfg.max_attempts,
        branch: None,
        worktree_path: None,
        window_id: None,
        events_file: None,
        fail_reason: None,
        last_event_at: None,
        started_at: None,
        finished_at: None,
        created_at: now.clone(),
        updated_at: now,
    };
    crate::repo::insert_agent_task(&state.db, &task).await?;
    Ok(task.id)
}

/// List the tasks (with FSM state) for a workspace.
#[tauri::command]
pub async fn gestor_tasks_list(
    state: State<'_, Arc<AppState>>,
    workspace_id: String,
) -> Result<Vec<AgentTask>, AdeError> {
    crate::repo::agent_tasks_for_workspace(&state.db, &workspace_id).await
}

/// A page of the audit feed (newest first).
#[tauri::command]
pub async fn gestor_feed_list(
    state: State<'_, Arc<AppState>>,
    workspace_id: String,
    limit: i64,
) -> Result<Vec<AgentEvent>, AdeError> {
    crate::repo::agent_events_for_workspace(&state.db, &workspace_id, limit).await
}

/// On-demand release notes from the commit log since the last tag.
#[tauri::command]
pub async fn gestor_release_notes(
    state: State<'_, Arc<AppState>>,
    workspace_id: String,
) -> Result<String, AdeError> {
    let ws = crate::repo::workspace_by_id(&state.db, &workspace_id).await?;
    let repo = repo_path_for(&ws);
    let provider = crate::gestor::provider::ClaudeCli::new();
    crate::gestor::notes::release_notes(&state.db, &provider, &workspace_id, &repo).await
}

/// The L2 human merge gate: merge a task's PR and ship it (close issue, card→Done,
/// clean worktree). The autonomous loop does this at L3.
#[tauri::command]
pub async fn pr_merge(
    state: State<'_, Arc<AppState>>,
    workspace_id: String,
    task_id: String,
) -> Result<(), AdeError> {
    let task = crate::repo::agent_task_by_id(&state.db, &task_id)
        .await?
        .ok_or_else(|| AdeError::Other(format!("task {task_id} not found")))?;
    let ws = crate::repo::workspace_by_id(&state.db, &workspace_id).await?;
    let (owner, repo) = match (ws.github_owner.as_deref(), ws.github_repo.as_deref()) {
        (Some(o), Some(r)) => (o, r),
        _ => return Err(AdeError::Other("workspace has no GitHub remote".into())),
    };
    let token = crate::ipc::github::keychain_get_for_workspace(&workspace_id)?
        .ok_or(AdeError::TokenInvalid)?;
    let repo_path = repo_path_for(&ws);
    let gh =
        crate::gh::client::GitHubClient::new(crate::gh::client::GITHUB_API_BASE.to_string(), token);
    crate::gestor::merge::merge_task(&state.db, &gh, owner, repo, &repo_path, &task).await
}
