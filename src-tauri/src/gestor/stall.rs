// stall.rs (#53): the diagnose_stall job — the only self-recovery border (PLANO
// §2.1). When a worker is silent past `stall_timeout` (runtime detects via tail +
// git state), the LLM looks at the worktree state and decides: `nudge` (send a
// message to unstick it, stay working) or `escalate` (hand to a human via
// awaiting_input). Bounded, auditable, never loops forever.
//
// ponytail: wired into the runtime loop (not spawned from setup() yet); allow.
#![allow(dead_code)]

use crate::db::DbPool;
use crate::error::AdeError;
use crate::gestor::fsm::{self, TaskState};
use crate::gestor::jobs;
use crate::gestor::provider::{GestorProvider, JobKind};
use crate::models::AgentTask;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Deserialize)]
pub struct StallDecision {
    pub action: String, // "nudge" | "escalate"
    #[serde(default)]
    pub text: String,
}

/// Build the diagnosis prompt from the worktree's git state. (We deliberately
/// pass git-state rather than transcript bytes — D3 — plus how long it's been
/// silent; the model decides whether a nudge can unstick it.)
pub fn build_stall_prompt(git_summary: &str, silent_secs: u64) -> String {
    format!(
        "A coding worker has been silent for {silent_secs}s. Decide whether a nudge can \
         unstick it or a human is needed.\n\n\
         ## Worktree git state\n{git_summary}\n\n\
         ## Output\nReturn ONLY JSON:\n\
         {{\"action\": \"nudge\" | \"escalate\", \"text\": \"<nudge message to the worker, or reason to escalate>\"}}\n\
         Prefer `nudge` with a concrete next step if the work looks recoverable; `escalate` if it \
         needs a human decision (ambiguous requirements, repeated failure, destructive risk)."
    )
}

/// Run diagnose_stall for a silent worker and act on the verdict. `nudge` sends
/// the text to the worker's tmux window and keeps it `working`; `escalate` moves
/// it to `awaiting_input`. A job failure escalates (don't guess).
pub async fn process_stall<P: GestorProvider>(
    db: &DbPool,
    provider: &P,
    workspace_id: &str,
    task: &AgentTask,
    cwd: &Path,
    git_summary: &str,
    silent_secs: u64,
) -> Result<(), AdeError> {
    let prompt = build_stall_prompt(git_summary, silent_secs);
    let input = serde_json::json!({ "task_id": task.id, "silent_secs": silent_secs }).to_string();

    let decision: StallDecision = match jobs::run_gestor_job::<_, StallDecision>(
        db,
        provider,
        workspace_id,
        JobKind::DiagnoseStall,
        prompt,
        cwd,
        &["Read", "Glob", "Grep"],
        input,
    )
    .await
    {
        Ok((_, d)) => d,
        Err(_) => {
            return escalate(db, task, "diagnose_stall failed to produce a decision").await;
        }
    };

    if decision.action == "nudge" {
        if let Some(win) = task.window_id.as_deref() {
            let _ = crate::tmux::send_keys(win, &decision.text);
        }
        record(db, task, "stall_nudge", "info", &decision.text).await?;
        Ok(())
    } else {
        escalate(db, task, &decision.text).await
    }
}

async fn escalate(db: &DbPool, task: &AgentTask, reason: &str) -> Result<(), AdeError> {
    // From `working`; if already elsewhere this is a no-op-ish illegal transition
    // we just ignore (best-effort recovery).
    let _ = fsm::transition(db, &task.id, TaskState::AwaitingInput, Some(reason)).await;
    Ok(())
}

async fn record(
    db: &DbPool,
    task: &AgentTask,
    kind: &str,
    level: &str,
    text: &str,
) -> Result<(), AdeError> {
    let ev = crate::models::AgentEvent {
        id: 0,
        workspace_id: task.workspace_id.clone(),
        task_id: Some(task.id.clone()),
        job_id: None,
        ts: chrono::Utc::now().to_rfc3339(),
        kind: kind.into(),
        level: level.into(),
        payload_json: Some(serde_json::json!({ "text": text }).to_string()),
        cost_usd: None,
        num_turns: None,
        duration_ms: None,
    };
    crate::repo::insert_agent_event(db, &ev).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gestor::provider::{JobResult, ProviderInfo};
    use crate::repo;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::sync::Mutex;

    struct FakeProvider(Mutex<Vec<String>>);
    impl GestorProvider for FakeProvider {
        async fn run_job(
            &self,
            _k: JobKind,
            _p: String,
            _c: &Path,
            _t: &[&str],
        ) -> Result<JobResult, AdeError> {
            Ok(JobResult {
                output: self.0.lock().unwrap().remove(0),
                cost_usd: None,
                num_turns: None,
                duration_ms: None,
            })
        }
        fn probe(&self) -> Result<ProviderInfo, AdeError> {
            Ok(ProviderInfo {
                version: "fake".into(),
            })
        }
    }

    async fn pool_working() -> (DbPool, AgentTask) {
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
            state: "working".into(),
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
        (pool, t)
    }

    #[tokio::test]
    async fn nudge_keeps_working_and_records() {
        let (db, task) = pool_working().await;
        let p = FakeProvider(Mutex::new(vec![
            r#"{"action":"nudge","text":"run the tests then commit"}"#.into(),
        ]));
        process_stall(
            &db,
            &p,
            "w1",
            &task,
            Path::new("."),
            "clean, 0 commits",
            700,
        )
        .await
        .unwrap();

        let t = repo::agent_task_by_id(&db, "task1").await.unwrap().unwrap();
        assert_eq!(t.state, "working"); // unchanged
        let feed = repo::agent_events_for_workspace(&db, "w1", 10)
            .await
            .unwrap();
        assert!(feed.iter().any(|e| e.kind == "stall_nudge"));
    }

    #[tokio::test]
    async fn escalate_moves_to_awaiting_input() {
        let (db, task) = pool_working().await;
        let p = FakeProvider(Mutex::new(vec![
            r#"{"action":"escalate","text":"requirements ambiguous"}"#.into(),
        ]));
        process_stall(&db, &p, "w1", &task, Path::new("."), "dirty", 700)
            .await
            .unwrap();
        let t = repo::agent_task_by_id(&db, "task1").await.unwrap().unwrap();
        assert_eq!(t.state, "awaiting_input");
    }

    #[tokio::test]
    async fn bad_decision_escalates() {
        let (db, task) = pool_working().await;
        let p = FakeProvider(Mutex::new(vec!["garbage".into(), "garbage2".into()]));
        process_stall(&db, &p, "w1", &task, Path::new("."), "x", 700)
            .await
            .unwrap();
        let t = repo::agent_task_by_id(&db, "task1").await.unwrap().unwrap();
        assert_eq!(t.state, "awaiting_input");
    }
}
