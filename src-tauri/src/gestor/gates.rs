// gates.rs (#48): the deterministic verification step (PLANO §1 verificar, §2).
// When a task enters `verifying`, its workspace gate commands (build/test) run in
// the worktree. Green → `reviewing` (LLM review_diff, #39). Red → `needs_fixes`
// with the gate output reinjected, bounded by max_attempts — no LLM spent. Empty
// gate list = green (workspaces without gates skip straight to review).
//
// ponytail: wired into the runtime loop (not spawned from setup() yet); allow.
#![allow(dead_code)]

use crate::db::DbPool;
use crate::error::AdeError;
use crate::gestor::fsm::{self, TaskState};
use crate::models::AgentTask;
use std::path::Path;
use std::time::Duration;

/// Default per-gate timeout. ponytail: constant for slice-1; promote to a
/// workspace setting if a gate legitimately needs longer.
pub const GATE_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, PartialEq, Eq)]
pub enum GateOutcome {
    Passed,
    Failed { command: String, output: String },
}

/// Run each gate command in `worktree`, in order, stopping at the first failure.
/// A non-zero exit or a timeout is a red gate carrying the captured output.
pub async fn run_gates(worktree: &Path, commands: &[String], timeout: Duration) -> GateOutcome {
    for cmd in commands {
        let fut = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .current_dir(worktree)
            .output();
        let out = match tokio::time::timeout(timeout, fut).await {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => {
                return GateOutcome::Failed {
                    command: cmd.clone(),
                    output: format!("failed to spawn: {e}"),
                }
            }
            Err(_) => {
                return GateOutcome::Failed {
                    command: cmd.clone(),
                    output: format!("timed out after {}s", timeout.as_secs()),
                }
            }
        };
        if !out.status.success() {
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            return GateOutcome::Failed {
                command: cmd.clone(),
                output: combined.trim().to_string(),
            };
        }
    }
    GateOutcome::Passed
}

/// Run the gates for a task in `verifying` and drive the FSM: green → `reviewing`;
/// red → `needs_fixes`, then retry into `working` (reinjecting the gate output to
/// the worker) while attempts remain, else escalate to `awaiting_input`.
pub async fn process_verifying(
    db: &DbPool,
    task: &AgentTask,
    worktree: &Path,
    window_id: Option<&str>,
    gates: &[String],
    timeout: Duration,
) -> Result<(), AdeError> {
    match run_gates(worktree, gates, timeout).await {
        GateOutcome::Passed => {
            fsm::transition(db, &task.id, TaskState::Reviewing, None).await?;
        }
        GateOutcome::Failed { command, output } => {
            let feedback = format!("Gate `{command}` failed:\n{output}");
            fsm::transition(db, &task.id, TaskState::NeedsFixes, Some(&feedback)).await?;

            let current = crate::repo::agent_task_by_id(db, &task.id)
                .await?
                .ok_or_else(|| AdeError::Other("task vanished".into()))?;
            if fsm::can_retry(&current) {
                if let Some(win) = window_id {
                    let _ = crate::tmux::send_keys(win, &retry_message(&feedback));
                }
                fsm::transition(
                    db,
                    &task.id,
                    TaskState::Working,
                    Some("gate feedback reinjected"),
                )
                .await?;
            } else {
                fsm::transition(
                    db,
                    &task.id,
                    TaskState::AwaitingInput,
                    Some("gates still failing after max attempts"),
                )
                .await?;
            }
        }
    }
    Ok(())
}

fn retry_message(feedback: &str) -> String {
    format!(
        "{feedback}\n\nFix the above so the gate passes, then commit. \
         Do NOT push. End your final message with ADE_TASK_DONE."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn pool_with_verifying_task(max_attempts: i64) -> DbPool {
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
            state: "verifying".into(),
            attempt: 1,
            max_attempts,
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

    #[tokio::test]
    async fn passing_and_failing_gates() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            run_gates(dir.path(), &["true".into()], GATE_TIMEOUT).await,
            GateOutcome::Passed
        );
        assert_eq!(
            run_gates(dir.path(), &[], GATE_TIMEOUT).await,
            GateOutcome::Passed // no gates = green
        );
        match run_gates(dir.path(), &["echo boom >&2; false".into()], GATE_TIMEOUT).await {
            GateOutcome::Failed { output, .. } => assert!(output.contains("boom")),
            _ => panic!("expected failure"),
        }
        // stops at the first red — second gate (which would pass) never matters
        match run_gates(dir.path(), &["false".into(), "true".into()], GATE_TIMEOUT).await {
            GateOutcome::Failed { command, .. } => assert_eq!(command, "false"),
            _ => panic!("expected failure"),
        }
    }

    #[tokio::test]
    async fn green_gate_moves_to_reviewing() {
        let db = pool_with_verifying_task(3).await;
        let task = repo::agent_task_by_id(&db, "task1").await.unwrap().unwrap();
        let dir = tempfile::tempdir().unwrap();
        process_verifying(&db, &task, dir.path(), None, &["true".into()], GATE_TIMEOUT)
            .await
            .unwrap();
        let t = repo::agent_task_by_id(&db, "task1").await.unwrap().unwrap();
        assert_eq!(t.state, "reviewing");
    }

    #[tokio::test]
    async fn red_gate_retries_then_escalates() {
        let db = pool_with_verifying_task(2).await; // 2 attempts allowed
        let dir = tempfile::tempdir().unwrap();
        let gates = vec!["false".into()];

        // attempt 1 fails → needs_fixes → working (attempt 2)
        let task = repo::agent_task_by_id(&db, "task1").await.unwrap().unwrap();
        process_verifying(&db, &task, dir.path(), None, &gates, GATE_TIMEOUT)
            .await
            .unwrap();
        let t = repo::agent_task_by_id(&db, "task1").await.unwrap().unwrap();
        assert_eq!(t.state, "working");
        assert_eq!(t.attempt, 2);

        // worker commits again → verifying; attempt 2 fails, attempt==max → escalate
        fsm::transition(&db, "task1", TaskState::Verifying, None)
            .await
            .unwrap();
        let task = repo::agent_task_by_id(&db, "task1").await.unwrap().unwrap();
        process_verifying(&db, &task, dir.path(), None, &gates, GATE_TIMEOUT)
            .await
            .unwrap();
        let t = repo::agent_task_by_id(&db, "task1").await.unwrap().unwrap();
        assert_eq!(t.state, "awaiting_input");
    }
}
