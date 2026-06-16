// review.rs (#39): the review_diff border (PLANO §1, §2.1). A task whose gates are
// green enters `reviewing`; the LLM judges the branch diff against the issue and
// returns {verdict: approve|needs_fixes, feedback}. approve → pushing (publish,
// S9). needs_fixes → reinjected feedback, bounded retry (like a red gate). The
// LLM only judges — the FSM owns the transitions. Read-only tool set (D9).
//
// ponytail: wired into the runtime loop (not spawned from setup() yet); allow.
#![allow(dead_code)]

use crate::db::DbPool;
use crate::error::AdeError;
use crate::gestor::fsm::{self, TaskState};
use crate::gestor::jobs;
use crate::gestor::provider::{GestorProvider, JobKind};
use crate::gestor::stage_skills::{self, CombinedDecision, GateResult, SkillGate};
use crate::models::{AgentTask, Card};
use serde::Deserialize;
use std::path::Path;

/// Read-only tools the reviewer may use (PLANO §2.2): inspect the repo + the diff,
/// never mutate.
pub const REVIEW_TOOLS: &[&str] = &["Read", "Glob", "Grep", "Bash(git diff:*)"];

#[derive(Debug, Deserialize)]
pub struct Verdict {
    pub verdict: String, // "approve" | "needs_fixes"
    #[serde(default)]
    pub feedback: Option<String>,
}

/// Build the review prompt: the issue, the diff, and the JSON contract.
pub fn build_review_prompt(card: &Card, diff: &str) -> String {
    let body = card.body_preview.as_deref().unwrap_or("");
    format!(
        "Review this code change against its issue. You are a strict reviewer.\n\n\
         ## Issue\n{}\n\n{}\n\n\
         ## Diff (branch vs base)\n```diff\n{}\n```\n\n\
         ## Output\nReturn ONLY JSON matching exactly:\n\
         {{\"verdict\": \"approve\" | \"needs_fixes\", \"feedback\": \"<short reason; required when needs_fixes>\"}}\n\
         Approve only if the change correctly and completely implements the issue.",
        card.title, body, diff
    )
}

/// Run review_diff for a task in `reviewing` and drive the FSM. The diff is passed
/// in (gathered by the caller via git) so this is testable with a fake provider.
pub async fn process_reviewing<P: GestorProvider>(
    db: &DbPool,
    provider: &P,
    workspace_id: &str,
    task: &AgentTask,
    cwd: &Path,
    diff: &str,
) -> Result<(), AdeError> {
    let card = crate::repo::card_by_id_required(db, &task.card_id).await?;
    let prompt = build_review_prompt(&card, diff);
    let input = serde_json::json!({ "card_id": card.id, "title": card.title }).to_string();

    let verdict: Verdict = match jobs::run_gestor_job::<_, Verdict>(
        db,
        provider,
        workspace_id,
        JobKind::ReviewDiff,
        prompt,
        cwd,
        REVIEW_TOOLS,
        input,
    )
    .await
    {
        Ok((_, v)) => v,
        // Review couldn't produce a verdict (already retried + recorded by the
        // harness) → hand to a human rather than guess.
        Err(_) => {
            fsm::transition(
                db,
                &task.id,
                TaskState::AwaitingInput,
                Some("review_diff failed to produce a verdict"),
            )
            .await?;
            return Ok(());
        }
    };

    if verdict.verdict != "approve" {
        let feedback = verdict
            .feedback
            .unwrap_or_else(|| "review requested changes".into());
        return apply_needs_fixes(db, task, &feedback).await;
    }

    // Built-in review approved → run the workspace's configured `verify` gates
    // (#50). Each is a headless skill job with an adversarial quorum; any required
    // gate that blocks sends the task back for fixes. No gates configured (default)
    // → straight to pushing, unchanged.
    let gates = stage_skills::load(db, workspace_id).await.verify;
    let context = gate_context(&card, diff);
    match run_verify_gates(db, provider, workspace_id, &gates, cwd, &context).await {
        CombinedDecision::Approve => {
            fsm::transition(db, &task.id, TaskState::Pushing, Some("review approved")).await?;
        }
        CombinedDecision::NeedsFixes(feedback) => {
            apply_needs_fixes(db, task, &feedback).await?;
        }
    }
    Ok(())
}

/// Context handed to each verify gate: the issue + the branch diff (the gate's own
/// prompt appends the verdict contract).
fn gate_context(card: &Card, diff: &str) -> String {
    let body = card.body_preview.as_deref().unwrap_or("");
    format!(
        "## Issue\n{}\n{}\n\n## Diff (branch vs base)\n```diff\n{}\n```",
        card.title, body, diff
    )
}

/// Run each configured `verify` gate as a headless skill job, repeated `runs` times
/// for adversarial quorum, and combine the results. A required gate that produces
/// no verdict (the job failed) blocks rather than silently passing.
async fn run_verify_gates<P: GestorProvider>(
    db: &DbPool,
    provider: &P,
    workspace_id: &str,
    gates: &[SkillGate],
    cwd: &Path,
    context: &str,
) -> CombinedDecision {
    let mut results = Vec::new();
    for gate in gates {
        let tools: Vec<&str> = if gate.allowed_tools.is_empty() {
            REVIEW_TOOLS.to_vec()
        } else {
            gate.allowed_tools.iter().map(|s| s.as_str()).collect()
        };
        let mut verdicts = Vec::new();
        for _ in 0..gate.runs.max(1) {
            let prompt = stage_skills::gate_prompt(&gate.skill, context);
            let input = serde_json::json!({ "skill": gate.skill }).to_string();
            if let Ok((_, v)) = jobs::run_gestor_job::<_, Verdict>(
                db,
                provider,
                workspace_id,
                JobKind::ReviewDiff,
                prompt,
                cwd,
                &tools,
                input,
            )
            .await
            {
                verdicts.push(v);
            }
        }
        let (approved, feedback) = if verdicts.is_empty() {
            (false, format!("gate '{}' failed to run", gate.skill))
        } else {
            stage_skills::resolve_runs(&verdicts, gate.quorum)
        };
        results.push(GateResult {
            skill: gate.skill.clone(),
            required: gate.required,
            approved,
            feedback,
        });
    }
    stage_skills::combine(&results).0
}

/// The shared needs_fixes outcome: record it, then retry (reinject feedback to the
/// worker) while attempts remain, else escalate to a human.
async fn apply_needs_fixes(db: &DbPool, task: &AgentTask, feedback: &str) -> Result<(), AdeError> {
    fsm::transition(db, &task.id, TaskState::NeedsFixes, Some(feedback)).await?;
    let current = crate::repo::agent_task_by_id(db, &task.id)
        .await?
        .ok_or_else(|| AdeError::Other("task vanished".into()))?;
    if fsm::can_retry(&current) {
        if let Some(win) = task.window_id.as_deref() {
            let _ = crate::tmux::send_keys(win, &retry_message(feedback));
        }
        fsm::transition(
            db,
            &task.id,
            TaskState::Working,
            Some("review feedback reinjected"),
        )
        .await?;
    } else {
        fsm::transition(
            db,
            &task.id,
            TaskState::AwaitingInput,
            Some("review still rejecting after max attempts"),
        )
        .await?;
    }
    Ok(())
}

fn retry_message(feedback: &str) -> String {
    format!(
        "Code review requested changes:\n{feedback}\n\nAddress the feedback, then commit. \
         Do NOT push. End your final message with ADE_TASK_DONE."
    )
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
            let out = self.0.lock().unwrap().remove(0);
            Ok(JobResult {
                output: out,
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

    async fn pool_reviewing(max_attempts: i64) -> DbPool {
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
            state: "reviewing".into(),
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
    async fn approve_moves_to_pushing() {
        let db = pool_reviewing(3).await;
        let p = FakeProvider(Mutex::new(vec![r#"{"verdict":"approve"}"#.into()]));
        let task = repo::agent_task_by_id(&db, "task1").await.unwrap().unwrap();
        process_reviewing(&db, &p, "w1", &task, Path::new("."), "diff")
            .await
            .unwrap();
        let t = repo::agent_task_by_id(&db, "task1").await.unwrap().unwrap();
        assert_eq!(t.state, "pushing");
    }

    #[tokio::test]
    async fn needs_fixes_retries() {
        let db = pool_reviewing(3).await;
        let p = FakeProvider(Mutex::new(vec![
            r#"{"verdict":"needs_fixes","feedback":"missing tests"}"#.into(),
        ]));
        let task = repo::agent_task_by_id(&db, "task1").await.unwrap().unwrap();
        process_reviewing(&db, &p, "w1", &task, Path::new("."), "diff")
            .await
            .unwrap();
        let t = repo::agent_task_by_id(&db, "task1").await.unwrap().unwrap();
        assert_eq!(t.state, "working");
        assert_eq!(t.attempt, 2);
    }

    #[tokio::test]
    async fn verify_gate_blocks_an_approved_review() {
        let db = pool_reviewing(3).await;
        // Configure a required verify gate (#50).
        sqlx::query("INSERT INTO workspace_setting (workspace_id, key, value) VALUES ('w1','stage_skills','{\"verify\":[{\"skill\":\"sec\",\"required\":true}]}')")
            .execute(&db)
            .await
            .unwrap();
        // Built-in review approves, then the verify gate rejects → needs_fixes.
        let p = FakeProvider(Mutex::new(vec![
            r#"{"verdict":"approve"}"#.into(),
            r#"{"verdict":"needs_fixes","feedback":"unsafe call"}"#.into(),
        ]));
        let task = repo::agent_task_by_id(&db, "task1").await.unwrap().unwrap();
        process_reviewing(&db, &p, "w1", &task, Path::new("."), "diff")
            .await
            .unwrap();
        let t = repo::agent_task_by_id(&db, "task1").await.unwrap().unwrap();
        // Approved review + blocking gate → retry (working, attempt 2), NOT pushing.
        assert_eq!(t.state, "working");
        assert_eq!(t.attempt, 2);
    }

    #[tokio::test]
    async fn unparseable_verdict_escalates() {
        let db = pool_reviewing(3).await;
        // both attempts garbage → job fails → awaiting_input
        let p = FakeProvider(Mutex::new(vec!["nope".into(), "still nope".into()]));
        let task = repo::agent_task_by_id(&db, "task1").await.unwrap().unwrap();
        process_reviewing(&db, &p, "w1", &task, Path::new("."), "diff")
            .await
            .unwrap();
        let t = repo::agent_task_by_id(&db, "task1").await.unwrap().unwrap();
        assert_eq!(t.state, "awaiting_input");
    }
}
