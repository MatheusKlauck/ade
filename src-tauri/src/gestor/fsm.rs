// fsm.rs (#44): the agent_task state machine — the single source of transition
// (PLANO §3). No network, no model: pure deterministic core over SQLite. Every
// transition records an agent_event (D8). Also hosts the Stop decision table
// (§2.3): given the worker's git-state at end-of-turn, decide verifying vs stay.
//
// ponytail: pre-wired by the runtime (#45); allow until then.
#![allow(dead_code)]

use crate::db::DbPool;
use crate::error::AdeError;
use crate::models::AgentEvent;
use crate::repo;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// The lifecycle of one automated task (PLANO §3). The issue's shorthand
/// (working→verifying→publishing→shipped) maps onto the granular states here:
/// publishing = pushing/pr_open, shipped = done.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskState {
    Queued,
    Preparing,
    Working,
    AwaitingInput,
    NeedsFixes,
    Verifying,
    Reviewing,
    Pushing,
    PrOpen,
    CiWait,
    ReadyToMerge,
    Merging,
    Merged,
    Cleanup,
    Done,
    Failed,
    Aborted,
}

impl TaskState {
    pub fn as_str(&self) -> &'static str {
        use TaskState::*;
        match self {
            Queued => "queued",
            Preparing => "preparing",
            Working => "working",
            AwaitingInput => "awaiting_input",
            NeedsFixes => "needs_fixes",
            Verifying => "verifying",
            Reviewing => "reviewing",
            Pushing => "pushing",
            PrOpen => "pr_open",
            CiWait => "ci_wait",
            ReadyToMerge => "ready_to_merge",
            Merging => "merging",
            Merged => "merged",
            Cleanup => "cleanup",
            Done => "done",
            Failed => "failed",
            Aborted => "aborted",
        }
    }

    pub fn parse(s: &str) -> Result<TaskState, AdeError> {
        use TaskState::*;
        Ok(match s {
            "queued" => Queued,
            "preparing" => Preparing,
            "working" => Working,
            "awaiting_input" => AwaitingInput,
            "needs_fixes" => NeedsFixes,
            "verifying" => Verifying,
            "reviewing" => Reviewing,
            "pushing" => Pushing,
            "pr_open" => PrOpen,
            "ci_wait" => CiWait,
            "ready_to_merge" => ReadyToMerge,
            "merging" => Merging,
            "merged" => Merged,
            "cleanup" => Cleanup,
            "done" => Done,
            "failed" => Failed,
            "aborted" => Aborted,
            other => return Err(AdeError::Other(format!("unknown task state: {other}"))),
        })
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            TaskState::Done | TaskState::Failed | TaskState::Aborted
        )
    }
}

/// The allowed edges of the FSM (PLANO §3 diagram). Everything not listed is
/// rejected. `failed`/`aborted` are reachable from any non-terminal state.
pub fn can_transition(from: TaskState, to: TaskState) -> bool {
    use TaskState::*;
    if matches!(to, Failed | Aborted) {
        return !from.is_terminal();
    }
    matches!(
        (from, to),
        (Queued, Preparing)
            | (Preparing, Working)
            | (Working, AwaitingInput)
            | (AwaitingInput, Working)
            | (Working, Verifying)
            | (Verifying, Reviewing)
            | (Verifying, NeedsFixes)
            | (Reviewing, Pushing)
            | (Reviewing, NeedsFixes)
            | (Reviewing, AwaitingInput)
            | (NeedsFixes, Working)
            | (NeedsFixes, AwaitingInput)
            | (Pushing, PrOpen)
            | (PrOpen, CiWait)
            | (CiWait, ReadyToMerge)
            | (ReadyToMerge, Merging)
            | (Merging, Merged)
            | (Merged, Cleanup)
            | (Cleanup, Done)
    )
}

/// The board column a card sits in for a given FSM state (D13: the board is a
/// projection of the FSM, not a separate store). `transition` moves the card here
/// on every state change, so the column always reflects what the agent is doing.
pub fn column_for(state: TaskState) -> &'static str {
    use TaskState::*;
    match state {
        Queued | Preparing | Working | Verifying | Reviewing | NeedsFixes => "Doing",
        AwaitingInput | Failed | Aborted => "Paused",
        Pushing | PrOpen | CiWait | ReadyToMerge | Merging => "PR",
        Merged | Cleanup | Done => "Done",
    }
}

/// Apply a transition: validate it's legal, mutate the task's lifecycle fields,
/// persist, project onto the board (D13), and record an `agent_event`. The single
/// mutation path for state.
pub async fn transition(
    db: &DbPool,
    task_id: &str,
    to: TaskState,
    reason: Option<&str>,
) -> Result<crate::models::AgentTask, AdeError> {
    let mut task = repo::agent_task_by_id(db, task_id)
        .await?
        .ok_or_else(|| AdeError::Other(format!("agent_task {task_id} not found")))?;

    let from = TaskState::parse(&task.state)?;
    if from == to {
        return Ok(task); // idempotent no-op
    }
    if !can_transition(from, to) {
        return Err(AdeError::Other(format!(
            "illegal task transition {} → {}",
            from.as_str(),
            to.as_str()
        )));
    }

    let ts = now();
    task.state = to.as_str().to_string();
    task.updated_at = ts.clone();
    task.last_event_at = Some(ts.clone());
    if matches!(to, TaskState::Working) && task.started_at.is_none() {
        task.started_at = Some(ts.clone());
    }
    // Retrying after fixes consumes an attempt (PLANO §3: attempt+1 ≤ max_attempts).
    if from == TaskState::NeedsFixes && to == TaskState::Working {
        task.attempt += 1;
    }
    if to.is_terminal() {
        task.finished_at = Some(ts.clone());
    }
    if to == TaskState::Failed {
        task.fail_reason = reason.map(|r| r.to_string());
    }

    repo::update_agent_task(db, &task).await?;

    // D13: project the new state onto the board. The transition is already
    // persisted; a missing column or DB hiccup here must not undo it, so surface
    // it on stderr (no AppHandle at this layer to emit a notify) rather than fail.
    match repo::move_card_to_column(db, &task.card_id, &task.workspace_id, column_for(to), &ts)
        .await
    {
        Ok(true) => {}
        Ok(false) => eprintln!(
            "card projection: column '{}' not found for workspace {}",
            column_for(to),
            task.workspace_id
        ),
        Err(e) => eprintln!("card projection failed for task {}: {e}", task.id),
    }

    let level = match to {
        TaskState::Failed | TaskState::Aborted => "error",
        TaskState::AwaitingInput | TaskState::NeedsFixes => "warning",
        _ => "info",
    };
    let payload = serde_json::json!({ "from": from.as_str(), "to": to.as_str(), "reason": reason });
    let ev = AgentEvent {
        id: 0,
        workspace_id: task.workspace_id.clone(),
        task_id: Some(task.id.clone()),
        job_id: None,
        ts,
        kind: "task_transition".into(),
        level: level.into(),
        payload_json: Some(payload.to_string()),
        cost_usd: None,
        num_turns: None,
        duration_ms: None,
    };
    repo::insert_agent_event(db, &ev).await?;

    Ok(task)
}

/// Whether a task in `needs_fixes` may retry (PLANO §3 guard). The runtime uses
/// this to pick `working` (retry) vs `awaiting_input` (escalate to human).
pub fn can_retry(task: &crate::models::AgentTask) -> bool {
    task.attempt < task.max_attempts
}

// ── Stop decision table (PLANO §2.3) ───────────────────────────────────────

/// The worker's git-state at end-of-turn (the `Stop` hook fired).
#[derive(Debug, Clone, Copy)]
pub struct WorkerSignals {
    /// `ADE_TASK_DONE` present in the last assistant message.
    pub marker_done: bool,
    /// Worktree has no uncommitted changes.
    pub tree_clean: bool,
    /// Worktree has commits ahead of the base branch.
    pub commits_ahead: bool,
}

/// What to do when the worker stops for a turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopOutcome {
    /// Work is committed → move to gates. `forgot_marker` flags that the worker
    /// produced commits but omitted the `ADE_TASK_DONE` protocol line.
    ToVerifying { forgot_marker: bool },
    /// Dirty tree or no commits yet → stay in `working` (silence > stall_timeout
    /// later triggers `diagnose_stall`).
    StayWorking,
}

/// Decide the post-`Stop` move from git-state alone (no transcript bytes parsed
/// beyond the marker bool, per D3). Clean tree + commits ahead ⇒ verifying,
/// whether or not the worker remembered the marker; anything else ⇒ stay.
pub fn decide_on_stop(s: &WorkerSignals) -> StopOutcome {
    if s.tree_clean && s.commits_ahead {
        StopOutcome::ToVerifying {
            forgot_marker: !s.marker_done,
        }
    } else {
        StopOutcome::StayWorking
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AgentTask;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn pool_with_task() -> DbPool {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("INSERT INTO workspace (id, name, slug, root_path, created_at) VALUES ('w1','W','w','/tmp','t')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO board_column (id, workspace_id, name, position) VALUES ('c1','w1','Doing',0)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO card (id, workspace_id, column_id, title, position, source, created_at, updated_at) VALUES ('card1','w1','c1','T',1.0,'local','t','t')").execute(&pool).await.unwrap();
        let t = AgentTask {
            id: "task1".into(),
            workspace_id: "w1".into(),
            card_id: "card1".into(),
            state: "queued".into(),
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
            created_at: "t".into(),
            updated_at: "t".into(),
        };
        repo::insert_agent_task(&pool, &t).await.unwrap();
        pool
    }

    /// A board with all five columns and a card starting in Backlog, so the D13
    /// projection has a column to land each state in.
    async fn pool_with_board() -> DbPool {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("INSERT INTO workspace (id, name, slug, root_path, created_at) VALUES ('w1','W','w','/tmp','t')").execute(&pool).await.unwrap();
        for (i, name) in ["Backlog", "Doing", "Paused", "PR", "Done"]
            .iter()
            .enumerate()
        {
            sqlx::query(
                "INSERT INTO board_column (id, workspace_id, name, position) VALUES (?, 'w1', ?, ?)",
            )
            .bind(format!("col{i}"))
            .bind(name)
            .bind(i as i64)
            .execute(&pool)
            .await
            .unwrap();
        }
        sqlx::query("INSERT INTO card (id, workspace_id, column_id, title, position, source, created_at, updated_at) VALUES ('card1','w1','col0','T',1.0,'local','t','t')").execute(&pool).await.unwrap();
        let t = AgentTask {
            id: "task1".into(),
            workspace_id: "w1".into(),
            card_id: "card1".into(),
            state: "queued".into(),
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
            created_at: "t".into(),
            updated_at: "t".into(),
        };
        repo::insert_agent_task(&pool, &t).await.unwrap();
        pool
    }

    async fn card_col(db: &DbPool, card_id: &str) -> String {
        sqlx::query_scalar::<_, String>("SELECT column_id FROM card WHERE id = ?")
            .bind(card_id)
            .fetch_one(db)
            .await
            .unwrap()
    }

    #[test]
    fn happy_path_edges_are_legal() {
        use TaskState::*;
        let path = [
            Queued,
            Preparing,
            Working,
            Verifying,
            Reviewing,
            Pushing,
            PrOpen,
            CiWait,
            ReadyToMerge,
            Merging,
            Merged,
            Cleanup,
            Done,
        ];
        for w in path.windows(2) {
            assert!(can_transition(w[0], w[1]), "{:?}→{:?}", w[0], w[1]);
        }
    }

    #[test]
    fn illegal_and_terminal_edges_rejected() {
        use TaskState::*;
        assert!(!can_transition(Queued, Done));
        assert!(!can_transition(Verifying, Pushing));
        assert!(!can_transition(Done, Working)); // terminal is a dead end
        assert!(!can_transition(Failed, Working));
        // failed/aborted reachable from any non-terminal
        assert!(can_transition(Working, Failed));
        assert!(can_transition(Reviewing, Aborted));
        assert!(!can_transition(Done, Failed));
    }

    #[tokio::test]
    async fn transition_persists_and_records_event() {
        let db = pool_with_task().await;
        transition(&db, "task1", TaskState::Preparing, None)
            .await
            .unwrap();
        let t = transition(&db, "task1", TaskState::Working, None)
            .await
            .unwrap();
        assert_eq!(t.state, "working");
        assert!(t.started_at.is_some());

        let feed = repo::agent_events_for_workspace(&db, "w1", 10)
            .await
            .unwrap();
        assert_eq!(feed.len(), 2);
        assert!(feed.iter().all(|e| e.kind == "task_transition"));
    }

    #[tokio::test]
    async fn illegal_transition_errors_and_does_not_mutate() {
        let db = pool_with_task().await;
        let err = transition(&db, "task1", TaskState::Done, None)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("illegal"));
        let t = repo::agent_task_by_id(&db, "task1").await.unwrap().unwrap();
        assert_eq!(t.state, "queued"); // untouched
        assert!(repo::agent_events_for_workspace(&db, "w1", 10)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn needs_fixes_retry_increments_attempt() {
        let db = pool_with_task().await;
        for s in [
            TaskState::Preparing,
            TaskState::Working,
            TaskState::Verifying,
            TaskState::NeedsFixes,
        ] {
            transition(&db, "task1", s, None).await.unwrap();
        }
        let t = transition(&db, "task1", TaskState::Working, Some("gate red"))
            .await
            .unwrap();
        assert_eq!(t.attempt, 2);
        assert!(can_retry(&t));
    }

    #[tokio::test]
    async fn failed_records_reason_and_finishes() {
        let db = pool_with_task().await;
        let t = transition(&db, "task1", TaskState::Failed, Some("boom"))
            .await
            .unwrap();
        assert_eq!(t.state, "failed");
        assert_eq!(t.fail_reason.as_deref(), Some("boom"));
        assert!(t.finished_at.is_some());
    }

    #[test]
    fn column_projection_map() {
        use TaskState::*;
        assert_eq!(column_for(Queued), "Doing");
        assert_eq!(column_for(Working), "Doing");
        assert_eq!(column_for(NeedsFixes), "Doing");
        assert_eq!(column_for(AwaitingInput), "Paused");
        assert_eq!(column_for(Failed), "Paused");
        assert_eq!(column_for(Aborted), "Paused");
        assert_eq!(column_for(PrOpen), "PR");
        assert_eq!(column_for(Merging), "PR");
        assert_eq!(column_for(Done), "Done");
    }

    #[tokio::test]
    async fn transition_projects_card_onto_board() {
        let db = pool_with_board().await;
        // queued→preparing→working ⇒ Doing (col1)
        transition(&db, "task1", TaskState::Preparing, None)
            .await
            .unwrap();
        transition(&db, "task1", TaskState::Working, None)
            .await
            .unwrap();
        assert_eq!(card_col(&db, "card1").await, "col1");

        // working→awaiting_input ⇒ Paused (col2)
        transition(&db, "task1", TaskState::AwaitingInput, None)
            .await
            .unwrap();
        assert_eq!(card_col(&db, "card1").await, "col2");

        // …→pushing ⇒ PR (col3)
        for s in [
            TaskState::Working,
            TaskState::Verifying,
            TaskState::Reviewing,
            TaskState::Pushing,
        ] {
            transition(&db, "task1", s, None).await.unwrap();
        }
        assert_eq!(card_col(&db, "card1").await, "col3");

        // terminal failure ⇒ Paused (needs a human)
        transition(&db, "task1", TaskState::Failed, Some("x"))
            .await
            .unwrap();
        assert_eq!(card_col(&db, "card1").await, "col2");
    }

    #[test]
    fn stop_decision_table() {
        // marker + clean + commits → verifying
        assert_eq!(
            decide_on_stop(&WorkerSignals {
                marker_done: true,
                tree_clean: true,
                commits_ahead: true
            }),
            StopOutcome::ToVerifying {
                forgot_marker: false
            }
        );
        // no marker but clean + commits → verifying (forgot protocol)
        assert_eq!(
            decide_on_stop(&WorkerSignals {
                marker_done: false,
                tree_clean: true,
                commits_ahead: true
            }),
            StopOutcome::ToVerifying {
                forgot_marker: true
            }
        );
        // dirty → stay
        assert_eq!(
            decide_on_stop(&WorkerSignals {
                marker_done: true,
                tree_clean: false,
                commits_ahead: true
            }),
            StopOutcome::StayWorking
        );
        // no commits → stay
        assert_eq!(
            decide_on_stop(&WorkerSignals {
                marker_done: false,
                tree_clean: true,
                commits_ahead: false
            }),
            StopOutcome::StayWorking
        );
    }
}
