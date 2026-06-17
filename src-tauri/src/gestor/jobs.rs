// jobs.rs (#43): the generic gestor_job runner — the harness #38/#39 consume.
// Runs one typed job through the provider, validates the output against a serde
// schema, retries once with the error appended, and on terminal failure records
// it (gestor_job=failed + agent_event level=error) and returns Err so the loop
// can move on (PLANO §2.1, D8: nada falha em silêncio, mas nada trava o loop).
//
// ponytail: whole module is pre-wired API; the runtime (#45) is its only
// non-test caller. Drop this allow when that lands.
#![allow(dead_code)]

use super::provider::{GestorProvider, JobKind};
use crate::db::DbPool;
use crate::error::AdeError;
use crate::models::{AgentEvent, GestorJob};
use crate::repo;
use serde::de::DeserializeOwned;
use std::path::Path;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Run one gestor_job to completion. Returns the persisted job + parsed output on
/// success; on failure the job row is marked `failed`, a `job_failed` event is
/// recorded, and an `AdeError` is returned (the caller, e.g. the runtime, decides
/// whether to surface a toast — see `run_and_notify`).
#[allow(clippy::too_many_arguments)]
pub async fn run_gestor_job<P, T>(
    db: &DbPool,
    provider: &P,
    workspace_id: &str,
    kind: JobKind,
    prompt: String,
    cwd: &Path,
    allowed_tools: &[&str],
    input_json: String,
) -> Result<(GestorJob, T), AdeError>
where
    P: GestorProvider,
    T: DeserializeOwned,
{
    let mut job = GestorJob {
        id: new_id(),
        workspace_id: workspace_id.to_string(),
        kind: kind.as_str().to_string(),
        state: "running".into(),
        input_json,
        output_json: None,
        error: None,
        cost_usd: None,
        num_turns: None,
        duration_ms: None,
        created_at: now(),
        finished_at: None,
    };
    repo::insert_gestor_job(db, &job).await?;
    record_job_event(db, &job, "job_started", "info", None).await?;

    let mut prompt = prompt;
    let mut last_err = String::new();
    // Two attempts: the original + one retry with the validation error appended.
    for attempt in 0..2 {
        let res = match provider
            .run_job(kind, prompt.clone(), cwd, allowed_tools)
            .await
        {
            Ok(r) => r,
            // Provider/exec failure is terminal (no schema retry to make).
            Err(e) => return Err(finalize_failed(db, &mut job, e.to_string()).await),
        };

        job.cost_usd = sum_opt(job.cost_usd, res.cost_usd);
        job.num_turns = sum_opt(job.num_turns, res.num_turns);
        job.duration_ms = sum_opt(job.duration_ms, res.duration_ms);

        match parse_output::<T>(&res.output) {
            Ok(parsed) => {
                job.state = "done".into();
                job.output_json = Some(res.output.clone());
                job.finished_at = Some(now());
                repo::update_gestor_job(db, &job).await?;
                record_job_event(db, &job, "job_done", "info", Some(res.output)).await?;
                return Ok((job, parsed));
            }
            Err(e) => {
                last_err = e;
                if attempt == 0 {
                    prompt = format!(
                        "{prompt}\n\n[validation error] Your previous output failed schema \
                         validation: {last_err}\nReturn ONLY valid JSON matching the requested \
                         schema, with no surrounding prose."
                    );
                }
            }
        }
    }

    Err(finalize_failed(
        db,
        &mut job,
        format!("schema validation failed: {last_err}"),
    )
    .await)
}

/// As `run_gestor_job`, plus a user-facing toast on failure. Thin glue over the
/// pure runner (which the tests exercise directly).
#[allow(clippy::too_many_arguments)]
pub async fn run_and_notify<P, T>(
    app: &tauri::AppHandle,
    db: &DbPool,
    provider: &P,
    workspace_id: &str,
    kind: JobKind,
    prompt: String,
    cwd: &Path,
    allowed_tools: &[&str],
    input_json: String,
) -> Result<(GestorJob, T), AdeError>
where
    P: GestorProvider,
    T: DeserializeOwned,
{
    let r = run_gestor_job(
        db,
        provider,
        workspace_id,
        kind,
        prompt,
        cwd,
        allowed_tools,
        input_json,
    )
    .await;
    if let Err(ref e) = r {
        crate::notify::emit_notify(app, "error", e.code(), &e.to_string());
    }
    r
}

async fn finalize_failed(db: &DbPool, job: &mut GestorJob, err: String) -> AdeError {
    job.state = "failed".into();
    job.error = Some(err.clone());
    job.finished_at = Some(now());
    // Best-effort persistence: never lose the original failure to a DB hiccup.
    let _ = repo::update_gestor_job(db, job).await;
    let _ = record_job_event(db, job, "job_failed", "error", Some(err.clone())).await;
    AdeError::Other(format!(
        "gestor job {} ({}) failed: {err}",
        job.id, job.kind
    ))
}

async fn record_job_event(
    db: &DbPool,
    job: &GestorJob,
    kind: &str,
    level: &str,
    payload_json: Option<String>,
) -> Result<(), AdeError> {
    let ev = AgentEvent {
        id: 0,
        workspace_id: job.workspace_id.clone(),
        task_id: None,
        job_id: Some(job.id.clone()),
        ts: now(),
        kind: kind.into(),
        level: level.into(),
        payload_json,
        cost_usd: job.cost_usd,
        num_turns: job.num_turns,
        duration_ms: job.duration_ms,
    };
    repo::insert_agent_event(db, &ev).await.map(|_| ())
}

/// Parse a provider's raw text output into the job's schema `T`, tolerating a
/// markdown code fence around the JSON.
fn parse_output<T: DeserializeOwned>(raw: &str) -> Result<T, String> {
    serde_json::from_str::<T>(&strip_fence(raw)).map_err(|e| e.to_string())
}

fn strip_fence(raw: &str) -> String {
    let s = raw.trim();
    let s = s
        .strip_prefix("```json")
        .or_else(|| s.strip_prefix("```"))
        .unwrap_or(s);
    let s = s.strip_suffix("```").unwrap_or(s);
    s.trim().to_string()
}

fn sum_opt<T: std::ops::Add<Output = T>>(a: Option<T>, b: Option<T>) -> Option<T> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x + y),
        (Some(x), None) => Some(x),
        (None, b) => b,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gestor::provider::{JobResult, ProviderInfo};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

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
        sqlx::query("INSERT INTO workspace (id, name, slug, root_path, created_at) VALUES ('w1','W','w','/tmp','t')")
            .execute(&pool).await.unwrap();
        pool
    }

    struct FakeProvider {
        outputs: Mutex<VecDeque<Result<String, String>>>,
        calls: AtomicUsize,
    }
    impl FakeProvider {
        fn new(outputs: Vec<Result<String, String>>) -> Self {
            Self {
                outputs: Mutex::new(outputs.into_iter().collect()),
                calls: AtomicUsize::new(0),
            }
        }
    }
    impl GestorProvider for FakeProvider {
        async fn run_job(
            &self,
            _kind: JobKind,
            _prompt: String,
            _cwd: &Path,
            _tools: &[&str],
        ) -> Result<JobResult, AdeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            match self.outputs.lock().unwrap().pop_front() {
                Some(Ok(s)) => Ok(JobResult {
                    output: s,
                    cost_usd: Some(0.01),
                    num_turns: Some(1),
                    duration_ms: Some(5),
                }),
                Some(Err(e)) => Err(AdeError::Other(e)),
                None => Err(AdeError::Other("no canned response".into())),
            }
        }
        fn probe(&self) -> Result<ProviderInfo, AdeError> {
            Ok(ProviderInfo {
                version: "fake".into(),
            })
        }
    }

    #[derive(serde::Deserialize, PartialEq, Debug)]
    struct Verdict {
        verdict: String,
    }

    async fn run(db: &DbPool, p: &FakeProvider) -> Result<(GestorJob, Verdict), AdeError> {
        run_gestor_job(
            db,
            p,
            "w1",
            JobKind::ReviewDiff,
            "prompt".into(),
            Path::new("."),
            &["Read"],
            "{}".into(),
        )
        .await
    }

    #[tokio::test]
    async fn success_first_try() {
        let db = test_pool().await;
        let p = FakeProvider::new(vec![Ok(r#"{"verdict":"approve"}"#.into())]);
        let (job, v) = run(&db, &p).await.unwrap();

        assert_eq!(v.verdict, "approve");
        assert_eq!(p.calls.load(Ordering::SeqCst), 1);
        let stored = repo::gestor_job_by_id(&db, &job.id).await.unwrap().unwrap();
        assert_eq!(stored.state, "done");
        assert_eq!(stored.cost_usd, Some(0.01));
        let feed = repo::agent_events_for_workspace(&db, "w1", 10)
            .await
            .unwrap();
        let kinds: Vec<_> = feed.iter().map(|e| e.kind.as_str()).collect();
        assert!(kinds.contains(&"job_started") && kinds.contains(&"job_done"));
    }

    #[tokio::test]
    async fn retry_then_succeed() {
        let db = test_pool().await;
        let p = FakeProvider::new(vec![
            Ok("not json at all".into()),
            Ok(r#"{"verdict":"needs_fixes"}"#.into()),
        ]);
        let (job, v) = run(&db, &p).await.unwrap();

        assert_eq!(v.verdict, "needs_fixes");
        assert_eq!(p.calls.load(Ordering::SeqCst), 2);
        let stored = repo::gestor_job_by_id(&db, &job.id).await.unwrap().unwrap();
        assert_eq!(stored.state, "done");
        // metrics accumulate across both attempts
        assert_eq!(stored.cost_usd, Some(0.02));
        assert_eq!(stored.num_turns, Some(2));
    }

    #[tokio::test]
    async fn fails_after_retry_and_records_notification() {
        let db = test_pool().await;
        let p = FakeProvider::new(vec![Ok("garbage".into()), Ok("still garbage".into())]);
        let err = run(&db, &p).await.unwrap_err();

        assert_eq!(p.calls.load(Ordering::SeqCst), 2);
        // loop não trava: we got an Err back, not a panic
        let jobs = repo::gestor_jobs_for_workspace(&db, "w1").await.unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].state, "failed");
        assert!(jobs[0].error.is_some());
        let _ = err;
        // the failure is on the feed at error level (nada falha em silêncio)
        let feed = repo::agent_events_for_workspace(&db, "w1", 10)
            .await
            .unwrap();
        assert!(feed
            .iter()
            .any(|e| e.kind == "job_failed" && e.level == "error"));
    }

    #[tokio::test]
    async fn provider_error_is_terminal() {
        let db = test_pool().await;
        let p = FakeProvider::new(vec![Err("claude crashed".into())]);
        let err = run(&db, &p).await.unwrap_err();

        assert_eq!(p.calls.load(Ordering::SeqCst), 1); // no schema retry
        assert!(err.to_string().contains("claude crashed"));
        let jobs = repo::gestor_jobs_for_workspace(&db, "w1").await.unwrap();
        assert_eq!(jobs[0].state, "failed");
    }

    #[test]
    fn strip_fence_handles_json_block() {
        assert_eq!(strip_fence("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(strip_fence("  {\"a\":1}  "), "{\"a\":1}");
    }
}
