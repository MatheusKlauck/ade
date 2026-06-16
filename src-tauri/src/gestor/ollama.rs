// ollama.rs (#51): a second GestorProvider — Ollama Cloud (PLANO D2). Unlike
// ClaudeCli (an agent that reads the repo + runs tools), Ollama is a *model*: it
// only sees the prompt, so ADE must supply repo context itself (git + gbrain)
// when routing a job here. `format:"json"` makes the cloud enforce JSON so the
// jobs harness can validate it. Signed auth doesn't bill via the API, so cost is
// unknown — we record duration instead (PLANO §2.1).
//
// Verified API (context7, ollama.com/api/chat): Bearer auth, non-streaming,
// response carries message.content + total_duration(ns) + eval_count.
//
// ponytail: selectable as a provider once routing (#50) wires it; allow until then.
#![allow(dead_code)]

use crate::error::AdeError;
use crate::gestor::provider::{GestorProvider, JobKind, JobResult, ProviderInfo};
use serde::Deserialize;
use std::path::Path;

const OLLAMA_CLOUD: &str = "https://ollama.com";

/// The recommended Ollama Cloud model per job kind (#52 decision; review_diff is
/// the benchmark). The high-value reasoning edges (review/plan) get the strong
/// model; diagnose_stall/release_notes tolerate a cheaper one. `format` JSON
/// (structured output) is confirmed on gpt-oss Cloud (context7, #51). These are
/// defaults — each is overridable per workspace via `ollama_model[_<kind>]`.
pub fn recommended_model(kind: JobKind) -> &'static str {
    match kind {
        JobKind::ReviewDiff | JobKind::PlanIssues => "gpt-oss:120b",
        JobKind::DiagnoseStall | JobKind::ReleaseNotes => "gpt-oss:20b",
    }
}

/// Resolve the Ollama model for a job: per-kind override
/// (`ollama_model_<kind>`) → workspace default (`ollama_model`) → recommendation.
pub async fn load_model_for(db: &crate::db::DbPool, workspace_id: &str, kind: JobKind) -> String {
    let per_kind = format!("ollama_model_{}", kind.as_str());
    if let Some(m) =
        crate::ipc::settings::workspace_setting_value(db, workspace_id, &per_kind).await
    {
        return m;
    }
    if let Some(m) =
        crate::ipc::settings::workspace_setting_value(db, workspace_id, "ollama_model").await
    {
        return m;
    }
    recommended_model(kind).to_string()
}

pub struct OllamaCloud {
    base_url: String,
    api_key: String,
    model: String,
    http: reqwest::Client,
}

impl OllamaCloud {
    pub fn new(api_key: impl Into<String>, model: impl Into<String>) -> Self {
        Self::with_base_url(OLLAMA_CLOUD, api_key, model)
    }

    /// Override the base URL (tests point this at a wiremock server).
    pub fn with_base_url(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            api_key: api_key.into(),
            model: model.into(),
            http: reqwest::Client::new(),
        }
    }
}

#[derive(Deserialize)]
struct ChatResponse {
    message: ChatMessage,
    total_duration: Option<u64>,
}

#[derive(Deserialize)]
struct ChatMessage {
    content: String,
}

impl GestorProvider for OllamaCloud {
    async fn run_job(
        &self,
        _kind: JobKind,
        prompt: String,
        _cwd: &Path, // Ollama is a model: no repo access; context is in the prompt.
        _allowed_tools: &[&str], // ditto — no tools.
    ) -> Result<JobResult, AdeError> {
        let url = format!("{}/api/chat", self.base_url);
        let body = serde_json::json!({
            "model": self.model,
            "messages": [{ "role": "user", "content": prompt }],
            "stream": false,
            "format": "json",
        });

        let resp = self
            .http
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&body)
            .send()
            .await
            .map_err(|e| AdeError::Other(format!("ollama request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AdeError::Other(format!(
                "ollama HTTP {}: {}",
                status.as_u16(),
                text.chars().take(200).collect::<String>()
            )));
        }

        let parsed: ChatResponse = resp
            .json()
            .await
            .map_err(|e| AdeError::Other(format!("ollama response parse failed: {e}")))?;

        Ok(JobResult {
            output: parsed.message.content,
            cost_usd: None, // not billed via signed API auth
            num_turns: None,
            duration_ms: parsed.total_duration.map(|ns| (ns / 1_000_000) as i64),
        })
    }

    fn probe(&self) -> Result<ProviderInfo, AdeError> {
        if self.api_key.trim().is_empty() {
            return Err(AdeError::ProviderMissing(
                "no Ollama API key configured".into(),
            ));
        }
        Ok(ProviderInfo {
            version: format!("ollama-cloud:{}", self.model),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn recommended_models_by_kind() {
        assert_eq!(recommended_model(JobKind::ReviewDiff), "gpt-oss:120b");
        assert_eq!(recommended_model(JobKind::PlanIssues), "gpt-oss:120b");
        assert_eq!(recommended_model(JobKind::DiagnoseStall), "gpt-oss:20b");
        assert_eq!(recommended_model(JobKind::ReleaseNotes), "gpt-oss:20b");
    }

    #[tokio::test]
    async fn model_override_precedence() {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(":memory:")
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("INSERT INTO workspace (id, name, slug, root_path, created_at) VALUES ('w1','W','w','/tmp','t')").execute(&pool).await.unwrap();

        // no settings → recommendation
        assert_eq!(
            load_model_for(&pool, "w1", JobKind::ReviewDiff).await,
            "gpt-oss:120b"
        );
        // workspace default overrides recommendation
        sqlx::query("INSERT INTO workspace_setting (workspace_id, key, value) VALUES ('w1','ollama_model','qwen3')").execute(&pool).await.unwrap();
        assert_eq!(
            load_model_for(&pool, "w1", JobKind::DiagnoseStall).await,
            "qwen3"
        );
        // per-kind override wins over the default
        sqlx::query("INSERT INTO workspace_setting (workspace_id, key, value) VALUES ('w1','ollama_model_review_diff','deepseek-r1')").execute(&pool).await.unwrap();
        assert_eq!(
            load_model_for(&pool, "w1", JobKind::ReviewDiff).await,
            "deepseek-r1"
        );
    }

    #[test]
    fn probe_requires_key() {
        assert!(OllamaCloud::new("", "gpt-oss:120b").probe().is_err());
        assert!(OllamaCloud::new("k", "gpt-oss:120b").probe().is_ok());
    }

    #[tokio::test]
    async fn run_job_posts_and_parses() {
        let server = MockServer::start().await;
        let resp = serde_json::json!({
            "model": "m",
            "message": { "role": "assistant", "content": "{\"verdict\":\"approve\"}" },
            "done": true,
            "total_duration": 2_000_000_000u64, // 2s in ns
            "eval_count": 12,
        });
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .and(header("Authorization", "Bearer secret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&resp))
            .mount(&server)
            .await;

        let provider = OllamaCloud::with_base_url(server.uri(), "secret", "m");
        let res = provider
            .run_job(
                JobKind::ReviewDiff,
                "review this".into(),
                Path::new("."),
                &[],
            )
            .await
            .expect("run_job ok");

        assert_eq!(res.output, "{\"verdict\":\"approve\"}");
        assert_eq!(res.duration_ms, Some(2000));
        assert!(res.cost_usd.is_none());
    }

    #[tokio::test]
    async fn http_error_is_reported() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
            .mount(&server)
            .await;

        let provider = OllamaCloud::with_base_url(server.uri(), "bad", "m");
        let err = provider
            .run_job(JobKind::ReviewDiff, "x".into(), Path::new("."), &[])
            .await
            .unwrap_err();
        assert!(err.to_string().contains("401"));
    }
}
