// Repository layer: the canonical SELECT column lists and fetch helpers for
// the card / workspace / board_column tables, so the 15-field card SELECT
// isn't copy-pasted across every IPC handler and sync pass.
//
// The column lists are macros (not consts) so queries can be assembled with
// `concat!` into `&'static str` literals, which sqlx 0.9 requires (SqlSafeStr).

/// The full card column list, in `Card` field order.
macro_rules! card_cols {
    () => {
        "id, workspace_id, column_id, title, body_preview, position, source, github_issue_number, github_state, assignee, labels_json, remote_updated_at, terminal_window_id, created_at, updated_at"
    };
}

/// The full workspace column list, in `Workspace` field order.
macro_rules! workspace_cols {
    () => {
        "id, name, slug, root_path, github_owner, github_repo, startup_command, created_at"
    };
}

pub(crate) use workspace_cols;

/// The full agent_task column list, in `AgentTask` field order.
macro_rules! agent_task_cols {
    () => {
        "id, workspace_id, card_id, state, attempt, max_attempts, branch, worktree_path, window_id, events_file, fail_reason, last_event_at, started_at, finished_at, created_at, updated_at"
    };
}

/// The full agent_event column list, in `AgentEvent` field order.
macro_rules! agent_event_cols {
    () => {
        "id, workspace_id, task_id, job_id, ts, kind, level, payload_json, cost_usd, num_turns, duration_ms"
    };
}

/// The full gestor_job column list, in `GestorJob` field order.
macro_rules! gestor_job_cols {
    () => {
        "id, workspace_id, kind, state, input_json, output_json, error, cost_usd, num_turns, duration_ms, created_at, finished_at"
    };
}

/// The full issue_proposal column list, in `IssueProposal` field order.
macro_rules! issue_proposal_cols {
    () => {
        "id, job_id, workspace_id, ord, title, body, labels_json, depends_on_json, acceptance_json, priority, status, card_id"
    };
}

use crate::db::DbPool;
use crate::error::AdeError;
use crate::models::{
    AgentEvent, AgentTask, BoardColumn, Card, GestorJob, IssueProposal, Workspace,
};

/// Fetch a card by id, or `None` if it doesn't exist.
pub async fn card_by_id(db: &DbPool, card_id: &str) -> Result<Option<Card>, AdeError> {
    sqlx::query_as::<_, Card>(concat!("SELECT ", card_cols!(), " FROM card WHERE id = ?"))
        .bind(card_id)
        .fetch_optional(db)
        .await
        .map_err(AdeError::Db)
}

/// Fetch a card by id, erroring (sqlx `RowNotFound`) if it doesn't exist.
pub async fn card_by_id_required(db: &DbPool, card_id: &str) -> Result<Card, AdeError> {
    sqlx::query_as::<_, Card>(concat!("SELECT ", card_cols!(), " FROM card WHERE id = ?"))
        .bind(card_id)
        .fetch_one(db)
        .await
        .map_err(AdeError::Db)
}

/// Fetch all cards for a workspace, ordered by position.
pub async fn cards_for_workspace(db: &DbPool, workspace_id: &str) -> Result<Vec<Card>, AdeError> {
    sqlx::query_as::<_, Card>(concat!(
        "SELECT ",
        card_cols!(),
        " FROM card WHERE workspace_id = ? ORDER BY position"
    ))
    .bind(workspace_id)
    .fetch_all(db)
    .await
    .map_err(AdeError::Db)
}

/// Fetch a workspace by id, erroring (sqlx `RowNotFound`) if it doesn't exist.
pub async fn workspace_by_id(db: &DbPool, workspace_id: &str) -> Result<Workspace, AdeError> {
    sqlx::query_as::<_, Workspace>(concat!(
        "SELECT ",
        workspace_cols!(),
        " FROM workspace WHERE id = ?"
    ))
    .bind(workspace_id)
    .fetch_one(db)
    .await
    .map_err(AdeError::Db)
}

/// Fetch a workspace by id, or `None` if it doesn't exist.
pub async fn workspace_by_id_opt(
    db: &DbPool,
    workspace_id: &str,
) -> Result<Option<Workspace>, AdeError> {
    sqlx::query_as::<_, Workspace>(concat!(
        "SELECT ",
        workspace_cols!(),
        " FROM workspace WHERE id = ?"
    ))
    .bind(workspace_id)
    .fetch_optional(db)
    .await
    .map_err(AdeError::Db)
}

/// Fetch all board columns for a workspace, ordered by position.
pub async fn columns_for_workspace(
    db: &DbPool,
    workspace_id: &str,
) -> Result<Vec<BoardColumn>, AdeError> {
    sqlx::query_as::<_, BoardColumn>(
        "SELECT id, workspace_id, name, position FROM board_column WHERE workspace_id = ? ORDER BY position",
    )
    .bind(workspace_id)
    .fetch_all(db)
    .await
    .map_err(AdeError::Db)
}

// ponytail: the agent_task / agent_event repo API. Wired by the Gestor spine
// slices (#43 jobs, #44 fsm, #45 runtime); unused until then, hence allow.
#[allow(dead_code)]
pub async fn insert_agent_task(db: &DbPool, t: &AgentTask) -> Result<(), AdeError> {
    sqlx::query(concat!(
        "INSERT INTO agent_task (",
        agent_task_cols!(),
        ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ))
    .bind(&t.id)
    .bind(&t.workspace_id)
    .bind(&t.card_id)
    .bind(&t.state)
    .bind(t.attempt)
    .bind(t.max_attempts)
    .bind(&t.branch)
    .bind(&t.worktree_path)
    .bind(&t.window_id)
    .bind(&t.events_file)
    .bind(&t.fail_reason)
    .bind(&t.last_event_at)
    .bind(&t.started_at)
    .bind(&t.finished_at)
    .bind(&t.created_at)
    .bind(&t.updated_at)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(AdeError::Db)
}

/// Fetch an agent_task by id, or `None` if it doesn't exist.
#[allow(dead_code)]
pub async fn agent_task_by_id(db: &DbPool, id: &str) -> Result<Option<AgentTask>, AdeError> {
    sqlx::query_as::<_, AgentTask>(concat!(
        "SELECT ",
        agent_task_cols!(),
        " FROM agent_task WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(db)
    .await
    .map_err(AdeError::Db)
}

/// Update an agent_task's mutable lifecycle fields.
#[allow(dead_code)]
pub async fn update_agent_task(db: &DbPool, t: &AgentTask) -> Result<(), AdeError> {
    sqlx::query(
        "UPDATE agent_task SET state=?, attempt=?, branch=?, worktree_path=?, window_id=?, events_file=?, fail_reason=?, last_event_at=?, started_at=?, finished_at=?, updated_at=? WHERE id=?",
    )
    .bind(&t.state)
    .bind(t.attempt)
    .bind(&t.branch)
    .bind(&t.worktree_path)
    .bind(&t.window_id)
    .bind(&t.events_file)
    .bind(&t.fail_reason)
    .bind(&t.last_event_at)
    .bind(&t.started_at)
    .bind(&t.finished_at)
    .bind(&t.updated_at)
    .bind(&t.id)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(AdeError::Db)
}

/// Fetch all agent_tasks for a workspace, newest first.
#[allow(dead_code)]
pub async fn agent_tasks_for_workspace(
    db: &DbPool,
    workspace_id: &str,
) -> Result<Vec<AgentTask>, AdeError> {
    sqlx::query_as::<_, AgentTask>(concat!(
        "SELECT ",
        agent_task_cols!(),
        " FROM agent_task WHERE workspace_id = ? ORDER BY created_at DESC"
    ))
    .bind(workspace_id)
    .fetch_all(db)
    .await
    .map_err(AdeError::Db)
}

/// Append an agent_event (D8 audit feed). `id` is autoincrement; the returned
/// value is the new rowid.
#[allow(dead_code)]
pub async fn insert_agent_event(db: &DbPool, e: &AgentEvent) -> Result<i64, AdeError> {
    sqlx::query(
        "INSERT INTO agent_event (workspace_id, task_id, job_id, ts, kind, level, payload_json, cost_usd, num_turns, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(&e.workspace_id)
    .bind(&e.task_id)
    .bind(&e.job_id)
    .bind(&e.ts)
    .bind(&e.kind)
    .bind(&e.level)
    .bind(&e.payload_json)
    .bind(e.cost_usd)
    .bind(e.num_turns)
    .bind(e.duration_ms)
    .execute(db)
    .await
    .map(|r| r.last_insert_rowid())
    .map_err(AdeError::Db)
}

/// Fetch agent_events with id greater than `after_id`, oldest first. The runtime
/// uses this to emit `evt:feed` for rows written since the last tick.
#[allow(dead_code)]
pub async fn agent_events_after(
    db: &DbPool,
    workspace_id: &str,
    after_id: i64,
    limit: i64,
) -> Result<Vec<AgentEvent>, AdeError> {
    sqlx::query_as::<_, AgentEvent>(concat!(
        "SELECT ",
        agent_event_cols!(),
        " FROM agent_event WHERE workspace_id = ? AND id > ? ORDER BY id ASC LIMIT ?"
    ))
    .bind(workspace_id)
    .bind(after_id)
    .bind(limit)
    .fetch_all(db)
    .await
    .map_err(AdeError::Db)
}

/// Fetch the latest agent_events for a workspace, newest first.
#[allow(dead_code)]
pub async fn agent_events_for_workspace(
    db: &DbPool,
    workspace_id: &str,
    limit: i64,
) -> Result<Vec<AgentEvent>, AdeError> {
    sqlx::query_as::<_, AgentEvent>(concat!(
        "SELECT ",
        agent_event_cols!(),
        " FROM agent_event WHERE workspace_id = ? ORDER BY ts DESC, id DESC LIMIT ?"
    ))
    .bind(workspace_id)
    .bind(limit)
    .fetch_all(db)
    .await
    .map_err(AdeError::Db)
}

/// Insert a new gestor_job row.
#[allow(dead_code)]
pub async fn insert_gestor_job(db: &DbPool, j: &GestorJob) -> Result<(), AdeError> {
    sqlx::query(concat!(
        "INSERT INTO gestor_job (",
        gestor_job_cols!(),
        ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    ))
    .bind(&j.id)
    .bind(&j.workspace_id)
    .bind(&j.kind)
    .bind(&j.state)
    .bind(&j.input_json)
    .bind(&j.output_json)
    .bind(&j.error)
    .bind(j.cost_usd)
    .bind(j.num_turns)
    .bind(j.duration_ms)
    .bind(&j.created_at)
    .bind(&j.finished_at)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(AdeError::Db)
}

/// Update a gestor_job's mutable fields (state/output/error/metrics/finished_at).
#[allow(dead_code)]
pub async fn update_gestor_job(db: &DbPool, j: &GestorJob) -> Result<(), AdeError> {
    sqlx::query(
        "UPDATE gestor_job SET state=?, output_json=?, error=?, cost_usd=?, num_turns=?, duration_ms=?, finished_at=? WHERE id=?",
    )
    .bind(&j.state)
    .bind(&j.output_json)
    .bind(&j.error)
    .bind(j.cost_usd)
    .bind(j.num_turns)
    .bind(j.duration_ms)
    .bind(&j.finished_at)
    .bind(&j.id)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(AdeError::Db)
}

/// Fetch a gestor_job by id, or `None` if it doesn't exist.
#[allow(dead_code)]
pub async fn gestor_job_by_id(db: &DbPool, id: &str) -> Result<Option<GestorJob>, AdeError> {
    sqlx::query_as::<_, GestorJob>(concat!(
        "SELECT ",
        gestor_job_cols!(),
        " FROM gestor_job WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(db)
    .await
    .map_err(AdeError::Db)
}

/// Fetch all gestor_jobs for a workspace, newest first.
#[allow(dead_code)]
pub async fn gestor_jobs_for_workspace(
    db: &DbPool,
    workspace_id: &str,
) -> Result<Vec<GestorJob>, AdeError> {
    sqlx::query_as::<_, GestorJob>(concat!(
        "SELECT ",
        gestor_job_cols!(),
        " FROM gestor_job WHERE workspace_id = ? ORDER BY created_at DESC"
    ))
    .bind(workspace_id)
    .fetch_all(db)
    .await
    .map_err(AdeError::Db)
}

/// Insert an issue_proposal row.
#[allow(dead_code)]
pub async fn insert_issue_proposal(db: &DbPool, p: &IssueProposal) -> Result<(), AdeError> {
    sqlx::query(concat!(
        "INSERT INTO issue_proposal (",
        issue_proposal_cols!(),
        ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    ))
    .bind(&p.id)
    .bind(&p.job_id)
    .bind(&p.workspace_id)
    .bind(p.ord)
    .bind(&p.title)
    .bind(&p.body)
    .bind(&p.labels_json)
    .bind(&p.depends_on_json)
    .bind(&p.acceptance_json)
    .bind(&p.priority)
    .bind(&p.status)
    .bind(&p.card_id)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(AdeError::Db)
}

/// All proposals for a job, in proposal order.
#[allow(dead_code)]
pub async fn proposals_for_job(db: &DbPool, job_id: &str) -> Result<Vec<IssueProposal>, AdeError> {
    sqlx::query_as::<_, IssueProposal>(concat!(
        "SELECT ",
        issue_proposal_cols!(),
        " FROM issue_proposal WHERE job_id = ? ORDER BY ord"
    ))
    .bind(job_id)
    .fetch_all(db)
    .await
    .map_err(AdeError::Db)
}

/// Fetch one proposal by id.
#[allow(dead_code)]
pub async fn proposal_by_id(db: &DbPool, id: &str) -> Result<Option<IssueProposal>, AdeError> {
    sqlx::query_as::<_, IssueProposal>(concat!(
        "SELECT ",
        issue_proposal_cols!(),
        " FROM issue_proposal WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(db)
    .await
    .map_err(AdeError::Db)
}

/// Set a proposal's status (and optionally its created card id).
#[allow(dead_code)]
pub async fn update_proposal_status(
    db: &DbPool,
    id: &str,
    status: &str,
    card_id: Option<&str>,
) -> Result<(), AdeError> {
    sqlx::query("UPDATE issue_proposal SET status = ?, card_id = ? WHERE id = ?")
        .bind(status)
        .bind(card_id)
        .bind(id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(AdeError::Db)
}

/// Move a card to the named board column of its workspace (e.g. "PR"). No-op if
/// the column doesn't exist. Returns whether the card was moved.
#[allow(dead_code)]
pub async fn move_card_to_column(
    db: &DbPool,
    card_id: &str,
    workspace_id: &str,
    column_name: &str,
    now: &str,
) -> Result<bool, AdeError> {
    let col: Option<String> =
        sqlx::query_scalar("SELECT id FROM board_column WHERE workspace_id = ? AND name = ?")
            .bind(workspace_id)
            .bind(column_name)
            .fetch_optional(db)
            .await
            .map_err(AdeError::Db)?;
    let Some(column_id) = col else {
        return Ok(false);
    };
    sqlx::query("UPDATE card SET column_id = ?, updated_at = ? WHERE id = ?")
        .bind(&column_id)
        .bind(now)
        .bind(card_id)
        .execute(db)
        .await
        .map_err(AdeError::Db)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn test_pool() -> DbPool {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    async fn seed_card(db: &DbPool) {
        sqlx::query("INSERT INTO workspace (id, name, slug, root_path, created_at) VALUES ('w1','W','w','/tmp','t')").execute(db).await.unwrap();
        sqlx::query("INSERT INTO board_column (id, workspace_id, name, position) VALUES ('c1','w1','Doing',0)").execute(db).await.unwrap();
        sqlx::query("INSERT INTO card (id, workspace_id, column_id, title, position, source, created_at, updated_at) VALUES ('card1','w1','c1','T',1.0,'local','t','t')").execute(db).await.unwrap();
    }

    fn task() -> AgentTask {
        AgentTask {
            id: "task1".into(),
            workspace_id: "w1".into(),
            card_id: "card1".into(),
            state: "queued".into(),
            attempt: 1,
            max_attempts: 3,
            branch: Some("feat/x".into()),
            worktree_path: None,
            window_id: None,
            events_file: None,
            fail_reason: None,
            last_event_at: None,
            started_at: None,
            finished_at: None,
            created_at: "t".into(),
            updated_at: "t".into(),
        }
    }

    #[tokio::test]
    async fn move_card_to_pr_column() {
        let db = test_pool().await;
        seed_card(&db).await; // card1 in column c1 ("Doing")
        sqlx::query(
            "INSERT INTO board_column (id, workspace_id, name, position) VALUES ('pr','w1','PR',3)",
        )
        .execute(&db)
        .await
        .unwrap();

        let moved = move_card_to_column(&db, "card1", "w1", "PR", "now")
            .await
            .unwrap();
        assert!(moved);
        let card = card_by_id(&db, "card1").await.unwrap().unwrap();
        assert_eq!(card.column_id, "pr");

        // unknown column is a no-op
        assert!(!move_card_to_column(&db, "card1", "w1", "Nope", "now")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn agent_task_round_trip() {
        let db = test_pool().await;
        seed_card(&db).await;

        insert_agent_task(&db, &task()).await.unwrap();

        let got = agent_task_by_id(&db, "task1").await.unwrap().unwrap();
        assert_eq!(got.state, "queued");
        assert_eq!(got.max_attempts, 3);
        assert_eq!(got.branch.as_deref(), Some("feat/x"));
        assert!(got.worktree_path.is_none());

        let list = agent_tasks_for_workspace(&db, "w1").await.unwrap();
        assert_eq!(list.len(), 1);
        assert!(agent_task_by_id(&db, "nope").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn agent_event_records_metrics_and_nulls() {
        let db = test_pool().await;
        seed_card(&db).await;

        let with_metrics = AgentEvent {
            id: 0,
            workspace_id: "w1".into(),
            task_id: Some("task1".into()),
            job_id: None,
            ts: "2026-01-01T00:00:01Z".into(),
            kind: "job_done".into(),
            level: "info".into(),
            payload_json: Some(r#"{"out":"ok"}"#.into()),
            cost_usd: Some(0.42),
            num_turns: Some(7),
            duration_ms: Some(1234),
        };
        let na = AgentEvent {
            id: 0,
            ts: "2026-01-01T00:00:00Z".into(),
            kind: "task_queued".into(),
            cost_usd: None,
            num_turns: None,
            duration_ms: None,
            payload_json: None,
            ..with_metrics.clone()
        };

        insert_agent_event(&db, &na).await.unwrap();
        let id2 = insert_agent_event(&db, &with_metrics).await.unwrap();
        assert!(id2 > 0);

        let feed = agent_events_for_workspace(&db, "w1", 10).await.unwrap();
        assert_eq!(feed.len(), 2);
        // newest ts first
        assert_eq!(feed[0].kind, "job_done");
        assert_eq!(feed[0].cost_usd, Some(0.42));
        assert_eq!(feed[0].num_turns, Some(7));
        assert!(feed[1].cost_usd.is_none());
        assert!(feed[1].num_turns.is_none());
    }
}
