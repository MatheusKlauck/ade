// worker.rs (#46, D3): worker instrumentation. At dispatch the ADE writes a
// per-task `.claude/settings.local.json` into the worktree with Stop /
// Notification / SessionEnd hooks that append each event to an absolute
// `app_data_dir/tasks/<id>/events.jsonl` (PLANO §2.3). The runtime tails that
// file (S5). The WorkerAdapter trait (Tier B, §2.4) is #59.
//
// ponytail: pre-wired by dispatch (#47); allow until then.
#![allow(dead_code)]

use crate::error::AdeError;
use std::path::{Path, PathBuf};

// ── WorkerAdapter (PLANO §2.4, #59) ─────────────────────────────────────────

/// How the gestor learns a worker's lifecycle.
#[derive(Debug, PartialEq, Eq)]
pub enum Tier {
    /// Claude Code: Stop/Notification/SessionEnd hooks → events.jsonl (precise,
    /// includes reliable `awaiting_input`).
    A,
    /// Generic worker (aider/codex/shell): NO hooks — lifecycle is inferred by
    /// polling git-state (commits/clean) + process silence. There is no reliable
    /// `awaiting_input` signal (documented limitation).
    B,
}

/// How to inject the prompt into the worker's terminal.
#[derive(Debug, PartialEq, Eq)]
pub struct InjectSpec {
    pub text: String,
    /// Send as a bracketed paste (default) so a multi-line prompt isn't executed
    /// line-by-line.
    pub bracketed_paste: bool,
}

/// The gestor's surface for launching + driving a worker (PLANO §2.4). Presets
/// remain the *human* surface ("open a terminal with…"); the adapter is the
/// *gestor* surface.
pub trait WorkerAdapter {
    fn launch_commands(&self) -> Vec<String>;
    fn instrumentation(&self) -> Tier;
    fn inject(&self, prompt: &str) -> InjectSpec;
}

/// Tier A — Claude Code. Composes permission/tool flags by autonomy level.
pub struct ClaudeAdapter {
    pub permission_mode: String,
    pub allowed_tools: Vec<String>,
}

impl WorkerAdapter for ClaudeAdapter {
    fn launch_commands(&self) -> Vec<String> {
        let mut cmd = format!("claude --permission-mode {}", self.permission_mode);
        if !self.allowed_tools.is_empty() {
            cmd.push_str(&format!(
                " --allowedTools '{}'",
                self.allowed_tools.join(",")
            ));
        }
        vec![cmd]
    }
    fn instrumentation(&self) -> Tier {
        Tier::A
    }
    fn inject(&self, prompt: &str) -> InjectSpec {
        InjectSpec {
            text: prompt.to_string(),
            bracketed_paste: true,
        }
    }
}

/// Tier B — generic worker launched from a preset's commands (seed = workspace
/// default preset). No hooks; the runtime infers lifecycle from git-state.
pub struct GenericAdapter {
    pub launch: Vec<String>,
}

impl WorkerAdapter for GenericAdapter {
    fn launch_commands(&self) -> Vec<String> {
        self.launch.clone()
    }
    fn instrumentation(&self) -> Tier {
        Tier::B
    }
    fn inject(&self, prompt: &str) -> InjectSpec {
        InjectSpec {
            text: prompt.to_string(),
            bracketed_paste: true,
        }
    }
}

/// Pick the adapter for a workspace. `worker_adapter` setting: "claude" (default,
/// Tier A) or "generic" (Tier B, using `generic_launch`).
pub fn select_adapter(
    worker_adapter: Option<&str>,
    permission_mode: String,
    allowed_tools: Vec<String>,
    generic_launch: Vec<String>,
) -> Box<dyn WorkerAdapter> {
    match worker_adapter {
        Some("generic") => Box::new(GenericAdapter {
            launch: generic_launch,
        }),
        _ => Box::new(ClaudeAdapter {
            permission_mode,
            allowed_tools,
        }),
    }
}

/// Absolute path of a task's event log, under the persistent app data dir so it
/// survives an ADE restart and a manual `claude` relaunch in the same window.
pub fn events_file_path(app_data_dir: &Path, task_id: &str) -> PathBuf {
    app_data_dir
        .join("tasks")
        .join(task_id)
        .join("events.jsonl")
}

/// The shell command for one hook. It wraps the hook's stdin payload in an
/// envelope carrying a `hook_event_name` *we* set — so the runtime's parser never
/// depends on Claude's internal payload field names — and appends one JSON line
/// to the absolute event log. Only the (trusted, ADE-derived) `events_file` path
/// is embedded; the untrusted payload is appended as data, never interpolated
/// into the command (D9).
fn hook_command(event: &str, events_file: &str) -> String {
    format!(
        "{{ printf '{{\"hook_event_name\":\"{event}\",\"payload\":'; cat; printf '}}\\n'; }} >> '{events_file}'"
    )
}

/// Build the `.claude/settings.local.json` contents instrumenting the three
/// lifecycle hooks. Pure (no filesystem) so the schema is testable.
pub fn build_settings(events_file: &str) -> serde_json::Value {
    let entry = |event: &str| {
        serde_json::json!({
            "hooks": [{ "type": "command", "command": hook_command(event, events_file) }]
        })
    };
    serde_json::json!({
        "hooks": {
            "Stop": [entry("Stop")],
            "Notification": [entry("Notification")],
            "SessionEnd": [entry("SessionEnd")],
        }
    })
}

/// Write the instrumentation into a freshly-checked-out worktree, creating the
/// `.claude/` dir and the event log's parent dir. Idempotent (overwrites).
pub fn write_instrumentation(worktree: &Path, events_file: &Path) -> Result<(), AdeError> {
    let claude_dir = worktree.join(".claude");
    std::fs::create_dir_all(&claude_dir)?;
    if let Some(parent) = events_file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let settings = build_settings(&events_file.to_string_lossy());
    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| AdeError::Other(format!("settings serialize: {e}")))?;
    std::fs::write(claude_dir.join("settings.local.json"), json)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_adapter_is_tier_a_with_flags() {
        let a = ClaudeAdapter {
            permission_mode: "acceptEdits".into(),
            allowed_tools: vec!["Read".into(), "Edit".into()],
        };
        assert_eq!(a.instrumentation(), Tier::A);
        let cmd = &a.launch_commands()[0];
        assert!(cmd.contains("--permission-mode acceptEdits"));
        assert!(cmd.contains("--allowedTools 'Read,Edit'"));
        assert!(a.inject("hi").bracketed_paste);
    }

    #[test]
    fn generic_adapter_is_tier_b_no_hooks() {
        let g = GenericAdapter {
            launch: vec!["aider --model gpt-4o".into()],
        };
        assert_eq!(g.instrumentation(), Tier::B); // git-state lifecycle, no awaiting_input
        assert_eq!(
            g.launch_commands(),
            vec!["aider --model gpt-4o".to_string()]
        );
    }

    #[test]
    fn select_adapter_routes_by_setting() {
        let claude = select_adapter(Some("claude"), "acceptEdits".into(), vec![], vec![]);
        assert_eq!(claude.instrumentation(), Tier::A);
        let generic = select_adapter(
            Some("generic"),
            "acceptEdits".into(),
            vec![],
            vec!["codex".into()],
        );
        assert_eq!(generic.instrumentation(), Tier::B);
        // default (None / unknown) → Claude
        assert_eq!(
            select_adapter(None, "acceptEdits".into(), vec![], vec![]).instrumentation(),
            Tier::A
        );
    }

    #[test]
    fn events_path_is_absolute_and_under_data_dir() {
        let p = events_file_path(Path::new("/data/ade"), "task-123");
        assert_eq!(p, Path::new("/data/ade/tasks/task-123/events.jsonl"));
    }

    #[test]
    fn settings_have_three_hooks_with_absolute_path() {
        let s = build_settings("/data/ade/tasks/t1/events.jsonl");
        let hooks = &s["hooks"];
        for event in ["Stop", "Notification", "SessionEnd"] {
            let cmd = hooks[event][0]["hooks"][0]["command"].as_str().unwrap();
            assert!(cmd.contains("/data/ade/tasks/t1/events.jsonl"));
            assert!(cmd.contains(&format!("\"hook_event_name\":\"{event}\"")));
            assert!(cmd.contains(">>")); // append, never truncate
        }
    }

    #[test]
    fn write_creates_valid_settings_file() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path().join("wt");
        std::fs::create_dir_all(&worktree).unwrap();
        let events = dir.path().join("data/tasks/t1/events.jsonl");

        write_instrumentation(&worktree, &events).unwrap();

        let written =
            std::fs::read_to_string(worktree.join(".claude/settings.local.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&written).unwrap();
        assert!(v["hooks"]["Stop"][0]["hooks"][0]["command"].is_string());
        // event log parent dir was created
        assert!(events.parent().unwrap().exists());
    }

    // The hook command must produce a line the runtime's tail parser accepts —
    // cross-checks S6 (writer) against S5 (reader) through a real shell.
    #[cfg(unix)]
    #[test]
    fn hook_output_is_parseable_by_runtime() {
        use crate::gestor::runtime::{parse_hook_line, HookEvent};
        let dir = tempfile::tempdir().unwrap();
        let events = dir.path().join("events.jsonl");
        let cmd = hook_command("Stop", &events.to_string_lossy());

        // Pipe a realistic Claude payload into the hook command.
        let full =
            format!("printf '%s' '{{\"session_id\":\"abc\",\"transcript_path\":\"/x\"}}' | {cmd}");
        let status = std::process::Command::new("sh")
            .arg("-c")
            .arg(&full)
            .status()
            .unwrap();
        assert!(status.success());

        let contents = std::fs::read_to_string(&events).unwrap();
        let line = contents.lines().next_back().unwrap();
        // valid JSON, and the runtime recognizes the event
        let _: serde_json::Value = serde_json::from_str(line).unwrap();
        assert_eq!(parse_hook_line(line), Some(HookEvent::Stop));
    }
}
