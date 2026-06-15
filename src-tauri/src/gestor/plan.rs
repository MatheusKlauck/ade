// plan.rs (#38): the intake border (PLANO §1 PLANEJAR, §2.1, D1/D8/D9). A brief
// becomes repo-grounded issue proposals: the LLM reads (repo, read-only tools),
// organizes, chains (depends_on), specifies (acceptance), prioritizes. Creation
// stays deterministic — proposals are persisted `proposed` and a human approves a
// batch, which creates local Backlog cards. The LLM judges; the FSM/board execute.
//
// ponytail: invoked via the gestor_plan IPC (#56 surfaces it); allow until wired.
#![allow(dead_code)]

use crate::db::DbPool;
use crate::error::AdeError;
use crate::gestor::jobs;
use crate::gestor::provider::{GestorProvider, JobKind};
use crate::models::{GestorJob, IssueProposal};
use serde::Deserialize;
use std::path::Path;

/// Read-only intake tools — the planner inspects the repo, never mutates (D9).
pub const PLAN_TOOLS: &[&str] = &["Read", "Glob", "Grep"];

#[derive(Debug, Deserialize)]
pub struct Proposal {
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub depends_on: Vec<serde_json::Value>,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default)]
    pub priority: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PlanOutput {
    pub proposals: Vec<Proposal>,
}

/// Build the intake prompt. The brief is untrusted content (D9) — it reaches the
/// model as data via the provider's argv, never a shell string.
pub fn build_plan_prompt(brief: &str) -> String {
    format!(
        "You are planning work for this repository. Read the codebase (read-only) and turn the \
         brief into concrete, repo-grounded issue proposals.\n\n\
         ## Brief\n{brief}\n\n\
         ## Rules\n\
         - Ground each proposal in what the repo actually contains (cite files/areas in the body).\n\
         - Chain dependencies via `depends_on` (ordinals of earlier proposals).\n\
         - Specify `acceptance` as concrete, checkable criteria.\n\
         - Prioritize: `priority` ∈ high|medium|low.\n\n\
         ## Output\nReturn ONLY JSON matching exactly:\n\
         {{\"proposals\": [{{\"title\": str, \"body\": str, \"labels\": [str], \
         \"depends_on\": [int], \"acceptance\": [str], \"priority\": \"high|medium|low\"}}]}}"
    )
}

/// Run plan_issues for a brief and persist each proposal as `proposed`. Returns
/// the job and the stored proposals. Schema failures are handled by the harness
/// (1 retry → notification); this returns the error so the caller can surface it.
pub async fn plan_issues<P: GestorProvider>(
    db: &DbPool,
    provider: &P,
    workspace_id: &str,
    brief: &str,
    cwd: &Path,
) -> Result<(GestorJob, Vec<IssueProposal>), AdeError> {
    let prompt = build_plan_prompt(brief);
    let input = serde_json::json!({ "brief": brief }).to_string();

    let (job, out): (GestorJob, PlanOutput) = jobs::run_gestor_job(
        db,
        provider,
        workspace_id,
        JobKind::PlanIssues,
        prompt,
        cwd,
        PLAN_TOOLS,
        input,
    )
    .await?;

    let mut stored = Vec::with_capacity(out.proposals.len());
    for (i, p) in out.proposals.iter().enumerate() {
        let row = IssueProposal {
            id: uuid::Uuid::new_v4().to_string(),
            job_id: job.id.clone(),
            workspace_id: workspace_id.to_string(),
            ord: i as i64,
            title: p.title.clone(),
            body: p.body.clone(),
            labels_json: Some(serde_json::to_string(&p.labels).unwrap_or_default()),
            depends_on_json: Some(serde_json::to_string(&p.depends_on).unwrap_or_default()),
            acceptance_json: Some(serde_json::to_string(&p.acceptance).unwrap_or_default()),
            priority: p.priority.clone(),
            status: "proposed".into(),
            card_id: None,
        };
        crate::repo::insert_issue_proposal(db, &row).await?;
        stored.push(row);
    }
    Ok((job, stored))
}

/// Human batch approval: create a local Backlog card for each approved proposal
/// and mark it `created` (deterministic creation — the LLM never creates). The
/// existing sync pipeline pushes local cards to GitHub when the workspace has a
/// remote. Returns the new card ids. Proposals not in `approved_ids` are left as-is.
pub async fn approve_proposals(
    db: &DbPool,
    workspace_id: &str,
    approved_ids: &[String],
) -> Result<Vec<String>, AdeError> {
    let backlog: Option<String> = sqlx::query_scalar(
        "SELECT id FROM board_column WHERE workspace_id = ? AND name = 'Backlog'",
    )
    .bind(workspace_id)
    .fetch_optional(db)
    .await
    .map_err(AdeError::Db)?;
    let backlog =
        backlog.ok_or_else(|| AdeError::Other("workspace has no Backlog column".into()))?;

    let mut created = Vec::new();
    for id in approved_ids {
        let Some(p) = crate::repo::proposal_by_id(db, id).await? else {
            continue;
        };
        let card_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let pos: f64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(position), 0.0) + 1.0 FROM card WHERE workspace_id = ?",
        )
        .bind(workspace_id)
        .fetch_one(db)
        .await
        .map_err(AdeError::Db)?;

        sqlx::query(
            "INSERT INTO card (id, workspace_id, column_id, title, body_preview, position, source, labels_json, created_at, updated_at) VALUES (?,?,?,?,?,?,'local',?,?,?)",
        )
        .bind(&card_id)
        .bind(workspace_id)
        .bind(&backlog)
        .bind(&p.title)
        .bind(render_body(&p))
        .bind(pos)
        .bind(&p.labels_json)
        .bind(&now)
        .bind(&now)
        .execute(db)
        .await
        .map_err(AdeError::Db)?;

        crate::repo::update_proposal_status(db, id, "created", Some(&card_id)).await?;
        created.push(card_id);
    }
    Ok(created)
}

/// Render a proposal body with its acceptance criteria appended as a checklist.
fn render_body(p: &IssueProposal) -> String {
    let acceptance: Vec<String> = p
        .acceptance_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();
    if acceptance.is_empty() {
        p.body.clone()
    } else {
        let checklist = acceptance
            .iter()
            .map(|a| format!("- [ ] {a}"))
            .collect::<Vec<_>>()
            .join("\n");
        format!("{}\n\n## Acceptance\n{}", p.body, checklist)
    }
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
                cost_usd: Some(0.05),
                num_turns: Some(3),
                duration_ms: Some(900),
            })
        }
        fn probe(&self) -> Result<ProviderInfo, AdeError> {
            Ok(ProviderInfo {
                version: "fake".into(),
            })
        }
    }

    async fn pool() -> DbPool {
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
        sqlx::query("INSERT INTO board_column (id, workspace_id, name, position) VALUES ('bl','w1','Backlog',0)").execute(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn brief_becomes_persisted_proposals() {
        let db = pool().await;
        let p = FakeProvider(Mutex::new(vec![r#"{"proposals":[
            {"title":"Add view","body":"in App.tsx","labels":["ui"],"depends_on":[],"acceptance":["renders"],"priority":"high"},
            {"title":"Wire store","body":"settings.ts","labels":[],"depends_on":[0],"acceptance":["persists"],"priority":"medium"}
        ]}"#.into()]));

        let (job, stored) = plan_issues(&db, &p, "w1", "add a config view", Path::new("."))
            .await
            .unwrap();
        assert_eq!(stored.len(), 2);
        assert_eq!(job.state, "done");

        let from_db = repo::proposals_for_job(&db, &job.id).await.unwrap();
        assert_eq!(from_db.len(), 2);
        assert_eq!(from_db[0].title, "Add view");
        assert_eq!(from_db[0].status, "proposed");
        assert_eq!(from_db[0].priority.as_deref(), Some("high"));
        assert!(from_db[1].depends_on_json.as_deref().unwrap().contains('0'));
    }

    #[tokio::test]
    async fn bad_schema_fails_without_persisting() {
        let db = pool().await;
        let p = FakeProvider(Mutex::new(vec!["not json".into(), "still not".into()]));
        let res = plan_issues(&db, &p, "w1", "brief", Path::new(".")).await;
        assert!(res.is_err());
        // the failed job exists but no proposals were stored
        let jobs = repo::gestor_jobs_for_workspace(&db, "w1").await.unwrap();
        assert_eq!(jobs[0].state, "failed");
        assert!(repo::proposals_for_job(&db, &jobs[0].id)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn approval_creates_backlog_cards() {
        let db = pool().await;
        let p = FakeProvider(Mutex::new(vec![
            r#"{"proposals":[{"title":"P1","body":"b","acceptance":["a1","a2"]}]}"#.into(),
        ]));
        let (_, stored) = plan_issues(&db, &p, "w1", "brief", Path::new("."))
            .await
            .unwrap();

        let created = approve_proposals(&db, "w1", &[stored[0].id.clone()])
            .await
            .unwrap();
        assert_eq!(created.len(), 1);

        let card = repo::card_by_id(&db, &created[0]).await.unwrap().unwrap();
        assert_eq!(card.title, "P1");
        assert_eq!(card.column_id, "bl");
        assert_eq!(card.source, "local");
        assert!(card.body_preview.as_deref().unwrap().contains("- [ ] a1"));

        let prop = repo::proposal_by_id(&db, &stored[0].id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(prop.status, "created");
        assert_eq!(prop.card_id.as_deref(), Some(created[0].as_str()));
    }
}
