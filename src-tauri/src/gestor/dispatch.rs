// dispatch.rs (#47): turning a ready card into a running worker (PLANO §3, §2.4,
// D4/D9). Sequential for slice-1 (max_parallel=1, no concurrent worktrees —
// parallelism is #58). The scheduler (runtime) calls `dispatch_task`, which:
// worktree+branch → instrumentation (S6) → tmux window (cwd in worktree) →
// launch the worker with L2 guardrails → inject the protocol prompt → FSM to
// working. `cleanup` removes the worktree + window on done/failure.
//
// The pure pieces (config, branch/path, prompt, launch command) are tested; the
// orchestration is integration glue over git/tmux/fsm.
//
// ponytail: dispatch_task is wired into the runtime loop, which isn't spawned
// from setup() yet (gestor opt-in, #45/#47 note); allow until the spawn lands.
#![allow(dead_code)]

use crate::db::DbPool;
use crate::error::AdeError;
use crate::gestor::fsm::{self, TaskState};
use crate::gestor::worker;
use crate::models::Card;
use std::path::{Path, PathBuf};

/// Per-workspace dispatch knobs (PLANO §4 guardrails), read from workspace_setting
/// with safe defaults. slice-1 default `max_parallel=1` (PLANO's 2 waits on #58).
#[derive(Debug, Clone)]
pub struct DispatchConfig {
    pub max_parallel: usize,
    pub base_branch: String,
    pub allowed_tools: Vec<String>,
    pub permission_mode: String,
    pub gate_commands: Vec<String>,
    pub max_attempts: i64,
    pub stall_timeout_secs: u64,
    /// Commands run once in a fresh worktree before the worker starts (e.g.
    /// `npm install`) so each isolated checkout has its deps (#58).
    pub worktree_setup_commands: Vec<String>,
}

impl Default for DispatchConfig {
    fn default() -> Self {
        Self {
            max_parallel: 1,
            base_branch: "main".into(),
            allowed_tools: vec!["Read".into(), "Edit".into(), "Bash".into()],
            permission_mode: "acceptEdits".into(),
            gate_commands: vec![],
            max_attempts: 3,
            stall_timeout_secs: 600,
            worktree_setup_commands: vec![],
        }
    }
}

/// Load the dispatch config for a workspace from settings (falling back to
/// `Default`). `allowed_tools_json` / `gate_commands` are JSON arrays.
pub async fn load_dispatch_config(db: &DbPool, workspace_id: &str) -> DispatchConfig {
    let d = DispatchConfig::default();
    let get = |k: &'static str| crate::ipc::settings::workspace_setting_value(db, workspace_id, k);
    let json_arr = |s: Option<String>| -> Option<Vec<String>> {
        serde_json::from_str::<Vec<String>>(&s?).ok()
    };
    DispatchConfig {
        max_parallel: get("max_parallel_workers")
            .await
            .and_then(|v| v.parse().ok())
            .unwrap_or(d.max_parallel),
        base_branch: get("base_branch").await.unwrap_or(d.base_branch),
        allowed_tools: json_arr(get("allowed_tools_json").await).unwrap_or(d.allowed_tools),
        // Worker permission mode scales with the autonomy level (#57).
        permission_mode: {
            let level = crate::gestor::autonomy::load(db, workspace_id).await;
            let l3_skip = get("l3_skip_permissions")
                .await
                .map(|v| v == "true")
                .unwrap_or(false);
            level.worker_permission_mode(l3_skip).to_string()
        },
        gate_commands: json_arr(get("gate_commands").await).unwrap_or(d.gate_commands),
        max_attempts: get("max_attempts")
            .await
            .and_then(|v| v.parse().ok())
            .unwrap_or(d.max_attempts),
        stall_timeout_secs: get("stall_timeout_secs")
            .await
            .and_then(|v| v.parse().ok())
            .unwrap_or(d.stall_timeout_secs),
        worktree_setup_commands: json_arr(get("worktree_setup_commands").await)
            .unwrap_or(d.worktree_setup_commands),
    }
}

/// Run a worktree's setup commands in order (e.g. `npm install`). First failure
/// aborts with the captured output so dispatch fails the task cleanly (#58).
pub async fn run_setup_commands(worktree: &Path, commands: &[String]) -> Result<(), AdeError> {
    for cmd in commands {
        let out = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .current_dir(worktree)
            .output()
            .await
            .map_err(|e| AdeError::Other(format!("setup `{cmd}` failed to spawn: {e}")))?;
        if !out.status.success() {
            return Err(AdeError::Other(format!(
                "setup `{cmd}` failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
    }
    Ok(())
}

/// Branch name for a card: `issue-<n>` when it tracks a GitHub issue, else a
/// slugged title (collision-safe enough for slice-1's sequential dispatch).
pub fn branch_for_card(card: &Card) -> String {
    match card.github_issue_number {
        Some(n) => format!("issue-{n}"),
        None => format!("gestor/{}", crate::gitlocal::slugify(&card.title, &card.id)),
    }
}

/// Isolated worktree path: `app_data_dir/worktrees/<slug>/<branch>` (PLANO §3).
/// The branch's `/` is flattened so it's a single path segment.
pub fn worktree_path(app_data_dir: &Path, slug: &str, branch: &str) -> PathBuf {
    app_data_dir
        .join("worktrees")
        .join(slug)
        .join(branch.replace('/', "-"))
}

/// The interactive worker launch command with L2 guardrails (PLANO §4): edits
/// auto-accepted, tools restricted to the workspace allow-list. The worker never
/// receives a token (D9) — push/PR are core-only.
pub fn worker_launch_command(cfg: &DispatchConfig) -> String {
    let mut cmd = format!("claude --permission-mode {}", cfg.permission_mode);
    if !cfg.allowed_tools.is_empty() {
        cmd.push_str(&format!(
            " --allowedTools '{}'",
            cfg.allowed_tools.join(",")
        ));
    }
    cmd
}

/// The enriched prompt injected into the worker: the issue, the gates that will
/// run, and the MANDATORY protocol (commit; never push; end with ADE_TASK_DONE).
pub fn build_worker_prompt(card: &Card, gate_commands: &[String]) -> String {
    let body = card.body_preview.as_deref().unwrap_or("");
    let gates = if gate_commands.is_empty() {
        "(none configured)".to_string()
    } else {
        gate_commands
            .iter()
            .map(|g| format!("`{g}`"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    format!(
        "You are an autonomous worker on an isolated git worktree. Implement the task below.\n\n\
         ## Task\n{}\n\n{}\n\n\
         ## Gates that will run on your commits\n{}\n\n\
         ## Protocol (MANDATORY)\n\
         - Commit your work with git when the task is complete.\n\
         - Do NOT push and do NOT open a PR — ADE handles push and PR.\n\
         - Stay within this worktree; do not touch other branches.\n\
         - End your FINAL message with exactly this line and nothing after it:\n\
         ADE_TASK_DONE\n",
        card.title, body, gates
    )
}

/// Dispatch one queued task: create its worktree+branch, instrument it, open a
/// tmux window in it, launch the worker, inject the prompt, and move the FSM to
/// `working`. Integration glue; failures bubble up so the caller fails the task.
pub async fn dispatch_task(
    db: &DbPool,
    app_data_dir: &Path,
    slug: &str,
    repo_path: &str,
    task_id: &str,
    cfg: &DispatchConfig,
) -> Result<(), AdeError> {
    let task = repo_task(db, task_id).await?;
    let card = crate::repo::card_by_id_required(db, &task.card_id).await?;

    let branch = branch_for_card(&card);
    let worktree = worktree_path(app_data_dir, slug, &branch);
    let worktree_str = worktree.to_string_lossy().to_string();

    fsm::transition(db, task_id, TaskState::Preparing, None).await?;

    crate::gitlocal::worktree_add(repo_path, &worktree_str, &branch, &cfg.base_branch)?;

    let events_file = worker::events_file_path(app_data_dir, task_id);
    worker::write_instrumentation(&worktree, &events_file)?;

    // Prepare deps in the isolated checkout before the worker starts (#58).
    run_setup_commands(&worktree, &cfg.worktree_setup_commands).await?;

    let winname = format!("gestor-{}", branch.replace('/', "-"));
    let issue_number = card.github_issue_number.unwrap_or(0) as u64;
    let url = card
        .github_issue_number
        .map(|n| format!("issue #{n}"))
        .unwrap_or_default();
    let window_id = crate::tmux::new_issue_window(
        slug,
        &worktree_str,
        &winname,
        issue_number,
        &card.title,
        &url,
    )?;

    crate::tmux::send_keys(&window_id, &worker_launch_command(cfg))?;
    crate::tmux::send_keys(&window_id, &build_worker_prompt(&card, &cfg.gate_commands))?;

    // Persist the dispatch artifacts before the working transition (the FSM
    // reloads the task, so these must already be on the row).
    let mut t = repo_task(db, task_id).await?;
    t.branch = Some(branch);
    t.worktree_path = Some(worktree_str);
    t.window_id = Some(window_id);
    t.events_file = Some(events_file.to_string_lossy().to_string());
    crate::repo::update_agent_task(db, &t).await?;

    fsm::transition(db, task_id, TaskState::Working, None).await?;
    Ok(())
}

/// Tear down a finished/failed task's worktree and tmux window (PLANO §3:
/// "worktree limpo ao sair"). Best-effort — a missing worktree/window is fine.
pub async fn cleanup(db: &DbPool, repo_path: &str, task_id: &str) {
    let Ok(task) = repo_task(db, task_id).await else {
        return;
    };
    if let Some(wt) = task.worktree_path.as_deref() {
        let _ = crate::gitlocal::worktree_remove(repo_path, wt);
    }
    if let Some(win) = task.window_id.as_deref() {
        let _ = crate::tmux::kill_window(win);
    }
}

async fn repo_task(db: &DbPool, task_id: &str) -> Result<crate::models::AgentTask, AdeError> {
    crate::repo::agent_task_by_id(db, task_id)
        .await?
        .ok_or_else(|| AdeError::Other(format!("agent_task {task_id} not found")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(title: &str, issue: Option<i64>, body: Option<&str>) -> Card {
        Card {
            id: "card1".into(),
            workspace_id: "w1".into(),
            column_id: "c1".into(),
            title: title.into(),
            body_preview: body.map(|b| b.into()),
            position: 1.0,
            source: "local".into(),
            github_issue_number: issue,
            github_state: None,
            assignee: None,
            labels_json: None,
            remote_updated_at: None,
            terminal_window_id: None,
            created_at: "t".into(),
            updated_at: "t".into(),
        }
    }

    #[test]
    fn branch_name_from_issue_or_title() {
        assert_eq!(branch_for_card(&card("X", Some(42), None)), "issue-42");
        assert_eq!(
            branch_for_card(&card("Add the Gestor view!", None, None)),
            "gestor/add-the-gestor-view"
        );
    }

    #[test]
    fn worktree_path_layout() {
        let p = worktree_path(Path::new("/data"), "myrepo", "issue-9");
        assert_eq!(p, Path::new("/data/worktrees/myrepo/issue-9"));
        // slashes in the branch are flattened to one segment
        let p2 = worktree_path(Path::new("/data"), "r", "gestor/foo");
        assert_eq!(p2, Path::new("/data/worktrees/r/gestor-foo"));
    }

    #[test]
    fn launch_command_applies_l2_guardrails() {
        let cmd = worker_launch_command(&DispatchConfig::default());
        assert!(cmd.contains("--permission-mode acceptEdits"));
        assert!(cmd.contains("--allowedTools 'Read,Edit,Bash'"));
    }

    #[tokio::test]
    async fn setup_commands_run_in_worktree_and_fail_loudly() {
        let dir = tempfile::tempdir().unwrap();
        // success: a command that writes a marker into the worktree
        run_setup_commands(dir.path(), &["touch installed".into()])
            .await
            .unwrap();
        assert!(dir.path().join("installed").exists());
        // empty list is a no-op
        run_setup_commands(dir.path(), &[]).await.unwrap();
        // failure surfaces
        assert!(run_setup_commands(dir.path(), &["exit 1".into()])
            .await
            .is_err());
    }

    #[test]
    fn prompt_carries_the_protocol() {
        let p = build_worker_prompt(
            &card("Do X", Some(1), Some("details here")),
            &["npm run build".into(), "npm test".into()],
        );
        assert!(p.contains("ADE_TASK_DONE"));
        assert!(p.contains("Do NOT push"));
        assert!(p.contains("Commit your work"));
        assert!(p.contains("Do X") && p.contains("details here"));
        assert!(p.contains("`npm run build`") && p.contains("`npm test`"));
    }
}
