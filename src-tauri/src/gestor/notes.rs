// notes.rs (#54): the release_notes job (PLANO §2.1). On demand / end of
// milestone, the LLM turns the commit log since the last tag into markdown
// release notes. Free-text output is wrapped as `{notes}` JSON so it rides the
// same harness (serde validation + 1 retry + audit) as the other jobs.
//
// ponytail: invoked via the gestor_release_notes IPC (#56); allow until wired.
#![allow(dead_code)]

use crate::db::DbPool;
use crate::error::AdeError;
use crate::gestor::jobs;
use crate::gestor::provider::{GestorProvider, JobKind};
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Deserialize)]
pub struct ReleaseNotes {
    pub notes: String,
}

pub fn build_notes_prompt(commit_log: &str) -> String {
    format!(
        "Write concise, user-facing release notes (markdown) from these merged changes.\n\n\
         ## Changes\n{commit_log}\n\n\
         ## Output\nReturn ONLY JSON: {{\"notes\": \"<markdown release notes>\"}}\n\
         Group related changes, lead with the most user-visible. Skip noise (merge commits, \
         formatting-only changes)."
    )
}

/// Generate release notes for a repo from its commit log since the last tag.
/// Returns the markdown. Schema/provider failures are handled by the harness and
/// surfaced as an error (the loop never depends on this job).
pub async fn release_notes<P: GestorProvider>(
    db: &DbPool,
    provider: &P,
    workspace_id: &str,
    repo_path: &str,
) -> Result<String, AdeError> {
    let log = crate::gitlocal::log_since_last_tag(repo_path);
    if log.trim().is_empty() {
        return Ok("_No changes since the last tag._".into());
    }
    let prompt = build_notes_prompt(&log);
    let input = serde_json::json!({ "commit_count": log.lines().count() }).to_string();

    let (_, out): (_, ReleaseNotes) = jobs::run_gestor_job(
        db,
        provider,
        workspace_id,
        JobKind::ReleaseNotes,
        prompt,
        Path::new(repo_path),
        &["Read", "Glob", "Grep"],
        input,
    )
    .await?;
    Ok(out.notes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gestor::provider::{JobResult, ProviderInfo};
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
        pool
    }

    #[tokio::test]
    async fn produces_markdown_notes() {
        let db = pool().await;
        // a real repo so log_since_last_tag returns something
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_str().unwrap();
        for args in [
            vec!["-C", p, "init", "-q"],
            vec![
                "-C",
                p,
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "--allow-empty",
                "-m",
                "feat: thing",
            ],
        ] {
            assert!(std::process::Command::new("git")
                .args(&args)
                .status()
                .unwrap()
                .success());
        }

        let prov = FakeProvider(Mutex::new(vec![r#"{"notes":"Highlights - thing"}"#.into()]));
        let notes = release_notes(&db, &prov, "w1", p).await.unwrap();
        assert!(notes.contains("Highlights"));
    }

    #[tokio::test]
    async fn empty_history_short_circuits() {
        let db = pool().await;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_str().unwrap();
        assert!(std::process::Command::new("git")
            .args(["-C", p, "init", "-q"])
            .status()
            .unwrap()
            .success());
        // no commits → no provider call needed
        let prov = FakeProvider(Mutex::new(vec![]));
        let notes = release_notes(&db, &prov, "w1", p).await.unwrap();
        assert!(notes.contains("No changes"));
    }
}
