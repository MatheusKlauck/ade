// GestorProvider (PLANO §2.2, D2): the LLM-at-the-edges boundary. v1 impl is
// `ClaudeCli` — `claude -p --output-format json` invoked by argv (never a shell
// string: brief and issue text are untrusted, D9). The job layer (#43) builds
// the prompt + allowed_tools per JobKind and validates the output schema; this
// layer only runs the process and reports the raw result + cost/turns/duration.

use crate::error::AdeError;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// The four typed jobs the LLM resolves (PLANO §2.1). `ClaudeCli` runs whatever
/// prompt/tools the caller built; `kind` is carried for audit/logging.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    PlanIssues,
    ReviewDiff,
    DiagnoseStall,
    ReleaseNotes,
}

impl JobKind {
    /// The DB / wire string (matches the `gestor_job.kind` CHECK and serde).
    pub fn as_str(&self) -> &'static str {
        match self {
            JobKind::PlanIssues => "plan_issues",
            JobKind::ReviewDiff => "review_diff",
            JobKind::DiagnoseStall => "diagnose_stall",
            JobKind::ReleaseNotes => "release_notes",
        }
    }
}

/// Raw result of one provider run. The model's text output plus whatever metrics
/// the provider reported — signature auth can report 0/absent cost, so all three
/// metrics are optional (PLANO §2.1: record num_turns/duration_ms regardless).
#[derive(Debug, Clone)]
pub struct JobResult {
    pub output: String,
    pub cost_usd: Option<f64>,
    pub num_turns: Option<i64>,
    pub duration_ms: Option<i64>,
}

/// What `probe` learns at boot.
#[derive(Debug, Clone)]
pub struct ProviderInfo {
    pub version: String,
}

#[allow(async_fn_in_trait)]
pub trait GestorProvider {
    /// Run one typed job. `cwd` scopes repo access; `allowed_tools` is passed
    /// straight to the provider (read-only sets for plan/review, see PLANO).
    async fn run_job(
        &self,
        kind: JobKind,
        prompt: String,
        cwd: &Path,
        allowed_tools: &[&str],
    ) -> Result<JobResult, AdeError>;

    /// Cheap boot check: provider present and new enough. Failure disables only
    /// the gestor (`GESTOR_PROVIDER_MISSING`), never the rest of the app.
    fn probe(&self) -> Result<ProviderInfo, AdeError>;
}

/// Minimum `claude` version we rely on (JSON output + `--allowedTools`).
// ponytail: conservative floor; the exact pin belongs in CONTRACTS.
const MIN_CLAUDE_VERSION: (u32, u32) = (1, 0);

pub struct ClaudeCli {
    bin: String,
}

impl ClaudeCli {
    pub fn new() -> Self {
        Self {
            bin: "claude".into(),
        }
    }

    /// Override the binary path (tests point this at a fake `claude`).
    pub fn with_bin(bin: impl Into<String>) -> Self {
        Self { bin: bin.into() }
    }
}

impl Default for ClaudeCli {
    fn default() -> Self {
        Self::new()
    }
}

/// Shape of `claude -p --output-format json`. Cost field name has drifted across
/// versions; accept both. Unknown fields ignored.
#[derive(Deserialize)]
struct ClaudeJson {
    result: Option<String>,
    #[serde(alias = "cost_usd")]
    total_cost_usd: Option<f64>,
    num_turns: Option<i64>,
    duration_ms: Option<i64>,
    is_error: Option<bool>,
}

impl GestorProvider for ClaudeCli {
    async fn run_job(
        &self,
        _kind: JobKind,
        prompt: String,
        cwd: &Path,
        allowed_tools: &[&str],
    ) -> Result<JobResult, AdeError> {
        let mut cmd = tokio::process::Command::new(&self.bin);
        cmd.arg("-p")
            .arg(&prompt) // argv, not shell — untrusted text stays inert (D9)
            .arg("--output-format")
            .arg("json")
            .current_dir(cwd);
        if !allowed_tools.is_empty() {
            cmd.arg("--allowedTools").arg(allowed_tools.join(","));
        }

        let out = cmd
            .output()
            .await
            .map_err(|e| AdeError::Other(format!("claude spawn failed: {e}")))?;

        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(AdeError::Other(format!(
                "claude exited with {}: {}",
                out.status,
                stderr.trim()
            )));
        }

        let parsed: ClaudeJson = serde_json::from_slice(&out.stdout)
            .map_err(|e| AdeError::Other(format!("claude json parse failed: {e}")))?;

        if parsed.is_error == Some(true) {
            return Err(AdeError::Other(format!(
                "claude reported error: {}",
                parsed.result.unwrap_or_default()
            )));
        }

        Ok(JobResult {
            output: parsed.result.unwrap_or_default(),
            cost_usd: parsed.total_cost_usd,
            num_turns: parsed.num_turns,
            duration_ms: parsed.duration_ms,
        })
    }

    fn probe(&self) -> Result<ProviderInfo, AdeError> {
        let out = std::process::Command::new(&self.bin)
            .arg("--version")
            .output()
            .map_err(|_| AdeError::ProviderMissing(format!("`{}` not found", self.bin)))?;

        if !out.status.success() {
            return Err(AdeError::ProviderMissing(format!(
                "`{} --version` failed",
                self.bin
            )));
        }

        let stdout = String::from_utf8_lossy(&out.stdout);
        let (major, minor) = parse_version(&stdout)?;
        if (major, minor) < MIN_CLAUDE_VERSION {
            return Err(AdeError::ProviderMissing(format!(
                "claude {}.{} required, found {}.{}",
                MIN_CLAUDE_VERSION.0, MIN_CLAUDE_VERSION.1, major, minor
            )));
        }
        Ok(ProviderInfo {
            version: stdout.trim().to_string(),
        })
    }
}

/// Parse the leading `MAJOR.MINOR` from `claude --version` output, e.g.
/// "1.2.3 (Claude Code)" -> (1, 2).
fn parse_version(output: &str) -> Result<(u32, u32), AdeError> {
    let s = output.trim();
    let digits: String = s
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = digits.split('.');
    let major = parts
        .next()
        .and_then(|p| p.parse::<u32>().ok())
        .ok_or_else(|| AdeError::ProviderMissing(format!("unrecognized version: {s}")))?;
    let minor = parts
        .next()
        .and_then(|p| p.parse::<u32>().ok())
        .unwrap_or(0);
    Ok((major, minor))
}

/// Probe at boot, emitting `GESTOR_PROVIDER_MISSING` on failure. Returns whether
/// the provider is usable; callers gate the gestor runtime on it (wired in #45).
// ponytail: standalone helper, not yet called from setup() — there's no gestor
// runtime to disable until #45, and notifying about an unrunnable feature is noise.
#[allow(dead_code)]
pub fn probe_or_notify(app: &tauri::AppHandle, provider: &impl GestorProvider) -> bool {
    match provider.probe() {
        Ok(_) => true,
        Err(e) => {
            crate::notify::emit_notify(app, "warning", e.code(), &e.to_string());
            false
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// Write a fake `claude` that answers `--version` and records its argv for
    /// the JSON path. Returns (bin_path, argv_log_path).
    fn fake_claude(dir: &Path, version: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let bin = dir.join("claude");
        let argv_log = dir.join("argv.txt");
        let script = format!(
            "#!/bin/sh\n\
             if [ \"$1\" = \"--version\" ]; then echo '{version}'; exit 0; fi\n\
             printf '%s\\n' \"$@\" > '{log}'\n\
             echo '{{\"result\":\"hello\",\"total_cost_usd\":0.01,\"num_turns\":2,\"duration_ms\":42,\"is_error\":false}}'\n",
            version = version,
            log = argv_log.display(),
        );
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        (bin, argv_log)
    }

    #[test]
    fn probe_reads_version() {
        let dir = tempfile::tempdir().unwrap();
        let (bin, _) = fake_claude(dir.path(), "1.5.0 (Claude Code)");
        let info = ClaudeCli::with_bin(bin.to_string_lossy()).probe().unwrap();
        assert!(info.version.starts_with("1.5.0"));
    }

    #[test]
    fn probe_rejects_old_version() {
        let dir = tempfile::tempdir().unwrap();
        let (bin, _) = fake_claude(dir.path(), "0.4.0");
        let err = ClaudeCli::with_bin(bin.to_string_lossy())
            .probe()
            .unwrap_err();
        assert_eq!(err.code(), "GESTOR_PROVIDER_MISSING");
    }

    #[test]
    fn probe_missing_binary() {
        let err = ClaudeCli::with_bin("/nonexistent/claude-xyz")
            .probe()
            .unwrap_err();
        assert_eq!(err.code(), "GESTOR_PROVIDER_MISSING");
    }

    #[tokio::test]
    async fn run_job_parses_metrics_and_passes_prompt_as_one_argv() {
        let dir = tempfile::tempdir().unwrap();
        let (bin, argv_log) = fake_claude(dir.path(), "1.5.0");
        let cli = ClaudeCli::with_bin(bin.to_string_lossy());

        // Prompt loaded with shell metacharacters — must arrive as a single,
        // inert argv token (D9), never expanded by a shell.
        let nasty = r#"plan this; rm -rf / $(touch pwned) `id`"#;
        let res = cli
            .run_job(
                JobKind::PlanIssues,
                nasty.to_string(),
                dir.path(),
                &["Read", "Grep"],
            )
            .await
            .unwrap();

        assert_eq!(res.output, "hello");
        assert_eq!(res.cost_usd, Some(0.01));
        assert_eq!(res.num_turns, Some(2));
        assert_eq!(res.duration_ms, Some(42));

        let argv = std::fs::read_to_string(&argv_log).unwrap();
        let lines: Vec<&str> = argv.lines().collect();
        // -p <prompt> --output-format json --allowedTools Read,Grep
        assert_eq!(lines[0], "-p");
        assert_eq!(lines[1], nasty); // intact, one token
        assert!(lines.contains(&"Read,Grep"));
        assert!(!dir.path().join("pwned").exists());
    }
}
