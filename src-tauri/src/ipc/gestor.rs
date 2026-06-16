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

/// Hero intake: one shot from a brief to a board that flows. Ensures the
/// workspace is at least L2 (so the loop runs and cards auto-dispatch to Doing),
/// plans the brief into proposals, approves them ALL into Backlog cards, and
/// emits the board. The user types once and watches their vision unfold — no
/// checkbox gate, no Settings trip (the act of building is the consent to flow).
#[tauri::command]
pub async fn gestor_build_feature(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    workspace_id: String,
    brief: String,
) -> Result<Vec<String>, AdeError> {
    // 1. Make sure the autonomous loop is running (≥ L2). Persist the dial and
    //    spawn the loop live, same path as a manual change in the Gestor tab.
    if !crate::gestor::autonomy::load(&state.db, &workspace_id)
        .await
        .can_dispatch()
    {
        sqlx::query(
            "INSERT INTO workspace_setting (workspace_id, key, value) VALUES (?, 'autonomy_level', 'L2') \
             ON CONFLICT(workspace_id, key) DO UPDATE SET value=excluded.value",
        )
        .bind(&workspace_id)
        .execute(&state.db)
        .await
        .map_err(AdeError::Db)?;
        crate::spawn_gestor_for_workspace(
            workspace_id.clone(),
            state.db.clone(),
            app.clone(),
            &state.gestor,
        )
        .await;
    }

    // 2. Plan the brief into repo-grounded proposals.
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

    // 3. Approve them all → Backlog cards. The loop takes it from here.
    let ids: Vec<String> = proposals.iter().map(|p| p.id.clone()).collect();
    let card_ids =
        crate::gestor::plan::approve_proposals(&state.db, &workspace_id, &ids).await?;

    // 4. Surface the fresh cards immediately (the loop re-emits as they flow).
    let _ = crate::ipc::board::emit_board(&app, &workspace_id, &state.db).await;
    Ok(card_ids)
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
    crate::gestor::dispatch::enqueue_card(&state.db, &workspace_id, &card.id).await
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
