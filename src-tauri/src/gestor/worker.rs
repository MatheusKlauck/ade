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
