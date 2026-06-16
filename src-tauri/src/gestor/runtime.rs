// runtime.rs (#45): one tokio loop per workspace, modeled on the sync worker
// (PLANO §2). Each tick: (1) emit evt:feed for new agent_events, (2) scheduler —
// pick queued tasks that fit a free slot and dispatch them, (3) tail each active
// worker's events.jsonl and feed the FSM.
//
// Dispatch itself (worktree+branch+tmux) is S7/#47, gates S8, push S9 — this
// slice lands the loop skeleton plus the testable scheduler/tail primitives.
// The loop is not spawned from setup() yet: the gestor stays opt-in (gestor_enabled
// default off), and the spawn wires in with #47 once a tick does real work.
//
// ponytail: pre-wired API; allow until the spawn lands.
#![allow(dead_code)]

use crate::db::DbPool;
use crate::gestor::provider::GestorProvider;
use crate::models::AgentTask;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// Worker/worktree-occupying states: while a task is in one of these, it holds a
/// parallelism slot (PLANO §4 `max_parallel_workers`). `queued` waits; pushing..
/// done are post-worker and free the slot.
fn occupies_slot(state: &str) -> bool {
    matches!(
        state,
        "preparing" | "working" | "awaiting_input" | "needs_fixes" | "verifying" | "reviewing"
    )
}

/// Pick which queued tasks to dispatch now: fill free slots oldest-first, capped
/// by `max_parallel` (PLANO §4, default 2; slice-1 runs with 1, #47). Pure so the
/// scheduler is testable with a fake queue.
pub fn select_dispatchable(tasks: &[AgentTask], max_parallel: usize) -> Vec<String> {
    let active = tasks.iter().filter(|t| occupies_slot(&t.state)).count();
    let free = max_parallel.saturating_sub(active);
    if free == 0 {
        return vec![];
    }
    let mut queued: Vec<&AgentTask> = tasks.iter().filter(|t| t.state == "queued").collect();
    queued.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    queued
        .into_iter()
        .take(free)
        .map(|t| t.id.clone())
        .collect()
}

/// The autonomous bridge: Backlog cards with no agent_task yet → new queued
/// tasks. A card with ANY task (in-flight or terminal) is skipped, so a failed
/// task never re-enqueues in a loop — re-running it is a manual action. Pure so
/// the bridge is testable without a DB.
pub fn cards_to_enqueue(backlog_card_ids: &[String], tasks: &[AgentTask]) -> Vec<String> {
    let has_task: std::collections::HashSet<&str> =
        tasks.iter().map(|t| t.card_id.as_str()).collect();
    backlog_card_ids
        .iter()
        .filter(|id| !has_task.contains(id.as_str()))
        .cloned()
        .collect()
}

/// Which Claude Code hook produced an `events.jsonl` line (D3/§2.3).
#[derive(Debug, PartialEq, Eq)]
pub enum HookEvent {
    Stop,
    Notification,
    SessionEnd,
    Other(String),
}

/// Parse one `events.jsonl` line into its hook kind, or `None` if it isn't a
/// recognizable hook payload. Reads only `hook_event_name` — never interprets the
/// transcript bytes (D3).
pub fn parse_hook_line(line: &str) -> Option<HookEvent> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let name = v.get("hook_event_name")?.as_str()?;
    Some(match name {
        "Stop" => HookEvent::Stop,
        "Notification" => HookEvent::Notification,
        "SessionEnd" => HookEvent::SessionEnd,
        other => HookEvent::Other(other.to_string()),
    })
}

/// Byte-offset cursor over an append-only `events.jsonl`. Returns only complete
/// lines (never a half-written trailing line) and advances past what it returned,
/// so a polling tail (1s, mtime) doesn't re-process or split records.
#[derive(Default)]
pub struct TailCursor {
    offset: usize,
}

impl TailCursor {
    pub fn new() -> Self {
        Self { offset: 0 }
    }

    pub fn read_new(&mut self, path: &Path) -> Vec<String> {
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(_) => return vec![],
        };
        if data.len() <= self.offset {
            // File shrank/rotated (e.g. relaunch truncated it) → resync.
            if data.len() < self.offset {
                self.offset = 0;
            }
            return vec![];
        }
        let fresh = &data[self.offset..];
        let end = match fresh.iter().rposition(|&b| b == b'\n') {
            Some(i) => i + 1,
            None => return vec![], // no complete line yet
        };
        self.offset += end;
        String::from_utf8_lossy(&fresh[..end])
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.to_string())
            .collect()
    }
}

/// Emit `evt:feed` for every agent_event written since `after_id`; returns the
/// new high-water id. Decouples emission from the FSM/jobs writers (which stay
/// AppHandle-free for testability).
pub async fn flush_feed(
    app: &tauri::AppHandle,
    db: &DbPool,
    workspace_id: &str,
    after_id: i64,
) -> i64 {
    let events = crate::repo::agent_events_after(db, workspace_id, after_id, 500)
        .await
        .unwrap_or_default();
    let mut high = after_id;
    for ev in &events {
        let _ = app.emit("evt:feed", ev);
        high = high.max(ev.id);
    }
    high
}

/// Spawn-once boot loop for one workspace. Probes the provider first; if missing,
/// emits `GESTOR_PROVIDER_MISSING` and returns without looping (gestor off, rest
/// of the app intact — D2). Otherwise ticks on `interval` or when `notify`d.
pub async fn start_runtime<P: GestorProvider>(
    db: DbPool,
    provider: Arc<P>,
    workspace_id: String,
    app: tauri::AppHandle,
    notify: Arc<tokio::sync::Notify>,
    interval_secs: u64,
) {
    if !crate::gestor::provider::probe_or_notify(&app, provider.as_ref()) {
        return;
    }

    // Resolve the workspace's repo + data paths once (dispatch needs them).
    let Ok(app_data_dir) = app.path().app_data_dir() else {
        return;
    };
    let Ok(ws) = crate::repo::workspace_by_id(&db, &workspace_id).await else {
        return;
    };
    let slug = ws.slug.clone();
    let repo_path = crate::gitlocal::find_repo_path(&ws.root_path).unwrap_or(ws.root_path.clone());

    let mut interval = tokio::time::interval(Duration::from_secs(interval_secs));
    interval.tick().await; // skip the immediate first tick

    let mut feed_hwm: i64 = 0;
    let mut cursors: std::collections::HashMap<String, TailCursor> =
        std::collections::HashMap::new();
    // Last time we saw activity from each task (for stall detection, #53).
    let mut last_activity: std::collections::HashMap<String, std::time::Instant> =
        std::collections::HashMap::new();

    loop {
        tokio::select! {
            _ = interval.tick() => {}
            _ = notify.notified() => {}
        }

        // 1. Surface anything the FSM/jobs wrote since last tick.
        feed_hwm = flush_feed(&app, &db, &workspace_id, feed_hwm).await;

        let mut tasks = crate::repo::agent_tasks_for_workspace(&db, &workspace_id)
            .await
            .unwrap_or_default();

        // 2. Scheduler: dispatch queued tasks into free slots (S7), gated on the
        // autonomy level (#57: L1 runs jobs but never dispatches workers).
        let cfg = crate::gestor::dispatch::load_dispatch_config(&db, &workspace_id).await;
        let level = crate::gestor::autonomy::load(&db, &workspace_id).await;

        // 2a. Autonomous bridge: approved Backlog cards → queued tasks, so the
        // loop runs brief→PR without a manual enqueue. Gated on can_dispatch
        // (L0/L1 never auto-pull from the board). Re-read tasks so the scheduler
        // below sees the fresh queue this same tick.
        if level.can_dispatch() {
            let backlog = crate::repo::backlog_card_ids(&db, &workspace_id)
                .await
                .unwrap_or_default();
            let mut enqueued = false;
            for card_id in cards_to_enqueue(&backlog, &tasks) {
                if crate::gestor::dispatch::enqueue_card(&db, &workspace_id, &card_id)
                    .await
                    .is_ok()
                {
                    enqueued = true;
                }
            }
            if enqueued {
                tasks = crate::repo::agent_tasks_for_workspace(&db, &workspace_id)
                    .await
                    .unwrap_or_default();
            }
        }
        for id in select_dispatchable(&tasks, cfg.max_parallel) {
            if !level.can_dispatch() {
                break;
            }
            if let Err(e) = crate::gestor::dispatch::dispatch_task(
                &db,
                &app_data_dir,
                &slug,
                &repo_path,
                &id,
                &cfg,
            )
            .await
            {
                let _ = crate::gestor::fsm::transition(
                    &db,
                    &id,
                    crate::gestor::fsm::TaskState::Failed,
                    Some(&format!("dispatch failed: {e}")),
                )
                .await;
            }
        }

        // 4. Clean up worktrees/windows of tasks that have left the worker stage.
        for task in tasks.iter().filter(|t| {
            t.worktree_path.is_some() && matches!(t.state.as_str(), "done" | "failed" | "aborted")
        }) {
            crate::gestor::dispatch::cleanup(&db, &repo_path, &task.id).await;
            cursors.remove(&task.id);
            let mut t = task.clone();
            t.worktree_path = None;
            let _ = crate::repo::update_agent_task(&db, &t).await;
        }

        // 3. Tail active workers' events.jsonl and feed the FSM.
        for task in tasks.iter().filter(|t| occupies_slot(&t.state)) {
            let Some(file) = task.events_file.as_deref() else {
                continue;
            };
            // Seed the stall clock when a task is first observed active.
            last_activity
                .entry(task.id.clone())
                .or_insert_with(std::time::Instant::now);
            let cursor = cursors.entry(task.id.clone()).or_default();
            let new_lines = cursor.read_new(Path::new(file));
            if !new_lines.is_empty() {
                // Real activity resets the stall clock.
                last_activity.insert(task.id.clone(), std::time::Instant::now());
            }
            for line in new_lines {
                match parse_hook_line(&line) {
                    Some(HookEvent::Notification) => {
                        let _ = crate::gestor::fsm::transition(
                            &db,
                            &task.id,
                            crate::gestor::fsm::TaskState::AwaitingInput,
                            Some("worker requested input"),
                        )
                        .await;
                    }
                    Some(HookEvent::Stop) => {
                        // Decide from git-state alone (D3): clean tree + commits
                        // ahead of base ⇒ gates; else stay working.
                        if let Some(wt) = task.worktree_path.as_deref() {
                            let sig = crate::gestor::fsm::WorkerSignals {
                                marker_done: false,
                                tree_clean: crate::gitlocal::tree_clean(wt),
                                commits_ahead: crate::gitlocal::commits_ahead(wt, &cfg.base_branch),
                            };
                            if let crate::gestor::fsm::StopOutcome::ToVerifying { .. } =
                                crate::gestor::fsm::decide_on_stop(&sig)
                            {
                                let _ = crate::gestor::fsm::transition(
                                    &db,
                                    &task.id,
                                    crate::gestor::fsm::TaskState::Verifying,
                                    None,
                                )
                                .await;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        // 5. Run gates for tasks that just entered `verifying` (S8). Re-read so a
        // working→verifying move from this same tick's tail is picked up now.
        let fresh = crate::repo::agent_tasks_for_workspace(&db, &workspace_id)
            .await
            .unwrap_or_default();
        for task in fresh.iter().filter(|t| t.state == "verifying") {
            if let Some(wt) = task.worktree_path.as_deref() {
                let _ = crate::gestor::gates::process_verifying(
                    &db,
                    task,
                    Path::new(wt),
                    task.window_id.as_deref(),
                    &cfg.gate_commands,
                    crate::gestor::gates::GATE_TIMEOUT,
                )
                .await;
            }
        }

        // 5b. Stall detection (#53): a `working` task silent past stall_timeout
        // gets a diagnose_stall job (nudge | escalate). Reset its clock after so
        // it won't re-fire for another stall_timeout.
        let stall_after = Duration::from_secs(cfg.stall_timeout_secs);
        for task in fresh.iter().filter(|t| t.state == "working") {
            let silent = last_activity
                .get(&task.id)
                .map(|t0| t0.elapsed())
                .unwrap_or_default();
            if silent >= stall_after {
                if let Some(wt) = task.worktree_path.as_deref() {
                    let summary = format!(
                        "tree_clean={}, commits_ahead={}",
                        crate::gitlocal::tree_clean(wt),
                        crate::gitlocal::commits_ahead(wt, &cfg.base_branch)
                    );
                    let _ = crate::gestor::stall::process_stall(
                        &db,
                        provider.as_ref(),
                        &workspace_id,
                        task,
                        Path::new(wt),
                        &summary,
                        silent.as_secs(),
                    )
                    .await;
                }
                last_activity.insert(task.id.clone(), std::time::Instant::now());
            }
        }

        // 6. Review (#39): the LLM judges each task's diff against its issue.
        // approve → pushing; needs_fixes → retry/escalate (handled inside).
        for task in fresh.iter().filter(|t| t.state == "reviewing") {
            if let Some(wt) = task.worktree_path.as_deref() {
                let diff = crate::gitlocal::diff(wt, &cfg.base_branch);
                let _ = crate::gestor::review::process_reviewing(
                    &db,
                    provider.as_ref(),
                    &workspace_id,
                    task,
                    Path::new(wt),
                    &diff,
                )
                .await;
            }
        }

        // 7. Publish: pushing → push + PR (S9). Needs the repo's GitHub
        // coordinates + a Keychain token.
        let after_review = crate::repo::agent_tasks_for_workspace(&db, &workspace_id)
            .await
            .unwrap_or_default();
        if let (Some(owner), Some(repo)) = (ws.github_owner.as_deref(), ws.github_repo.as_deref()) {
            if let Ok(Some(token)) = crate::ipc::github::keychain_get_for_workspace(&workspace_id) {
                for task in after_review.iter().filter(|t| t.state == "pushing") {
                    if let Err(e) = crate::gestor::publish::publish_task(
                        &db,
                        &workspace_id,
                        owner,
                        repo,
                        &repo_path,
                        &cfg.base_branch,
                        &token,
                    )
                    .await
                    {
                        let _ = crate::gestor::fsm::transition(
                            &db,
                            &task.id,
                            crate::gestor::fsm::TaskState::Failed,
                            Some(&format!("publish failed: {e}")),
                        )
                        .await;
                    }
                }

                // 8. CI polling + merge (#55). Poll open PRs; auto-merge ready
                // tasks at L3 (L2 waits for the human pr_merge IPC). Serialized:
                // at most one merge per workspace per tick.
                let gh = crate::gh::client::GitHubClient::new(
                    crate::gh::client::GITHUB_API_BASE.to_string(),
                    token.clone(),
                );
                let require_ci =
                    crate::ipc::settings::workspace_setting_value(&db, &workspace_id, "require_ci")
                        .await
                        .map(|v| v == "true")
                        .unwrap_or(false);

                let post_pr = crate::repo::agent_tasks_for_workspace(&db, &workspace_id)
                    .await
                    .unwrap_or_default();
                for task in post_pr
                    .iter()
                    .filter(|t| matches!(t.state.as_str(), "pr_open" | "ci_wait"))
                {
                    let _ = crate::gestor::merge::process_ci(
                        &db, &gh, owner, repo, &repo_path, task, require_ci,
                    )
                    .await;
                }

                if level.can_auto_merge() {
                    // one merge per tick (serialized fila)
                    if let Some(task) = crate::repo::agent_tasks_for_workspace(&db, &workspace_id)
                        .await
                        .unwrap_or_default()
                        .iter()
                        .find(|t| t.state == "ready_to_merge")
                    {
                        let _ = crate::gestor::merge::merge_task(
                            &db, &gh, owner, repo, &repo_path, task,
                        )
                        .await;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, state: &str, created_at: &str) -> AgentTask {
        AgentTask {
            id: id.into(),
            workspace_id: "w1".into(),
            card_id: "c".into(),
            state: state.into(),
            attempt: 1,
            max_attempts: 3,
            branch: None,
            worktree_path: None,
            window_id: None,
            events_file: None,
            fail_reason: None,
            last_event_at: None,
            started_at: None,
            finished_at: None,
            created_at: created_at.into(),
            updated_at: created_at.into(),
        }
    }

    #[test]
    fn scheduler_fills_free_slots_oldest_first() {
        let tasks = vec![
            task("b", "queued", "2026-01-02"),
            task("a", "queued", "2026-01-01"),
            task("c", "queued", "2026-01-03"),
        ];
        // cap 2, no active → two oldest
        assert_eq!(select_dispatchable(&tasks, 2), vec!["a", "b"]);
    }

    #[test]
    fn scheduler_respects_occupied_slots() {
        let tasks = vec![
            task("running", "working", "2026-01-01"),
            task("q", "queued", "2026-01-02"),
        ];
        // cap 1, one slot occupied → none dispatchable
        assert!(select_dispatchable(&tasks, 1).is_empty());
        // cap 2 → one free slot → the queued one
        assert_eq!(select_dispatchable(&tasks, 2), vec!["q"]);
    }

    #[test]
    fn scheduler_ignores_terminal_and_post_worker_states() {
        let tasks = vec![
            task("done", "done", "2026-01-01"),
            task("pr", "pr_open", "2026-01-02"), // post-worker, frees slot
            task("q", "queued", "2026-01-03"),
        ];
        assert_eq!(select_dispatchable(&tasks, 1), vec!["q"]);
    }

    #[test]
    fn enqueue_only_backlog_cards_without_a_task() {
        let backlog = vec!["c1".to_string(), "c2".to_string(), "c3".to_string()];
        let mut t_working = task("t", "working", "2026-01-01");
        t_working.card_id = "c1".into();
        let mut t_failed = task("f", "failed", "2026-01-01");
        t_failed.card_id = "c2".into(); // terminal task → still skipped (no retry loop)
        let tasks = vec![t_working, t_failed];
        // c1 has an in-flight task, c2 has a terminal one → only c3 is fresh.
        assert_eq!(cards_to_enqueue(&backlog, &tasks), vec!["c3"]);
        // empty board / no tasks → all enqueue
        assert_eq!(cards_to_enqueue(&backlog, &[]), backlog);
    }

    #[test]
    fn hook_line_parsing() {
        assert_eq!(
            parse_hook_line(r#"{"hook_event_name":"Stop","session_id":"x"}"#),
            Some(HookEvent::Stop)
        );
        assert_eq!(
            parse_hook_line(r#"{"hook_event_name":"Notification"}"#),
            Some(HookEvent::Notification)
        );
        assert_eq!(parse_hook_line("not json"), None);
        assert_eq!(parse_hook_line(r#"{"foo":1}"#), None);
    }

    #[test]
    fn tail_cursor_reads_only_new_complete_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        std::fs::write(&path, "line1\nline2\n").unwrap();

        let mut cur = TailCursor::new();
        assert_eq!(cur.read_new(&path), vec!["line1", "line2"]);
        // nothing new
        assert!(cur.read_new(&path).is_empty());

        // append a complete line + a partial (no trailing newline yet)
        std::fs::write(&path, "line1\nline2\nline3\npartial").unwrap();
        assert_eq!(cur.read_new(&path), vec!["line3"]);
        // partial completes
        std::fs::write(&path, "line1\nline2\nline3\npartial\n").unwrap();
        assert_eq!(cur.read_new(&path), vec!["partial"]);
    }
}
