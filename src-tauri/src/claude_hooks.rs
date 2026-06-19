//! ADE's Claude Code hooks, kept in an ADE-owned settings file — never the
//! user's `~/.claude/settings.json`.
//!
//! Each hook runs a `printf` that writes an `OSC 9;ade:claude:<state>` marker to
//! the controlling tty (the tmux pane). `term_monitor`'s `pipe-pane` scanner
//! reads the pane's raw bytes, recognises the marker, and emits an
//! `evt:terminal-alert` with kind `"claude"` — driving the pane's comet / veil /
//! waiting-pulse.
//!
//! Delivery is non-invasive: ADE writes this file and the injected shell
//! integration (see `tmux::SHELL_INTEGRATION`) defines a `claude` shell function
//! that adds `--settings <this file>` to every invocation. `--settings` hooks
//! *accumulate* with the user's own hooks (they are not replaced), and the file
//! lives only in ADE's tmux panes — so the user's global config, auth and MCP
//! are untouched and there's nothing to clean up.

use std::path::PathBuf;

/// Stable path of the ADE-owned Claude settings file (referenced by the shell
/// function in `tmux::SHELL_INTEGRATION`). Keep in sync with that snippet.
pub fn settings_path() -> PathBuf {
    std::env::temp_dir().join("ade-claude-settings.json")
}

/// One ADE hook command: emit the marker to the pane's pty, best-effort (a hook
/// must never fail or stall the turn).
///
/// Writes to `$ADE_TTY`, exported by the `claude` shell wrapper (see
/// `tmux::claude_wrapper_snippet`). Claude Code runs hooks WITHOUT a controlling
/// terminal, so a bare `/dev/tty` is "not a tty" and the marker is lost — the
/// explicit pane pty path is what `tmux pipe-pane` actually captures.
///
/// The hook JSON arrives on stdin; we pull `session_id` out of it and append it
/// to the marker (`ade:claude:<state>:<sid>`), so `term_monitor` — which already
/// reads each pane's stream per `window_id` — can map window→session for titles.
/// An empty sid (extraction failed) just yields a trailing `:` the scanner drops.
fn osc_command(state: &str) -> String {
    format!(
        "sid=$(sed -n 's/.*\"session_id\":\"\\([^\"]*\\)\".*/\\1/p' | head -1); \
         printf '\\033]9;ade:claude:{state}:%s\\007' \"$sid\" > \"${{ADE_TTY:-/dev/tty}}\" 2>/dev/null || true"
    )
}

/// Write the ADE settings file containing just our hooks. Best-effort: any IO
/// failure simply means the visual states won't fire. Overwrites each call so
/// the hooks stay current with the running build.
pub fn ensure() {
    let settings = serde_json::json!({
        "hooks": {
            "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": osc_command("turn-start") }] }],
            "Stop": [{ "hooks": [{ "type": "command", "command": osc_command("turn-end") }] }],
            // No matcher: any Notification (idle_prompt, permission_prompt, …)
            // means Claude wants the user — exactly the "waiting" pulse.
            "Notification": [{ "hooks": [{ "type": "command", "command": osc_command("waiting") }] }],
        }
    });

    let path = settings_path();
    let Ok(body) = serde_json::to_string_pretty(&settings) else {
        return;
    };
    if std::fs::write(&path, &body).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_command_targets_ade_tty_not_bare_dev_tty() {
        // Regression: Claude runs hooks with no controlling terminal, so writing
        // to a bare /dev/tty silently drops the marker. The command must target
        // $ADE_TTY (exported by the shell wrapper) for pipe-pane to capture it.
        let cmd = osc_command("turn-start");
        assert!(cmd.contains("${ADE_TTY"), "must write to $ADE_TTY: {cmd}");
        assert!(cmd.contains("ade:claude:turn-start"));
        // The marker carries the session id so window→session mapping works.
        assert!(cmd.contains("session_id"), "must extract session_id: {cmd}");
        assert!(cmd.contains(":%s"), "marker must append the sid: {cmd}");
        assert!(
            !cmd.contains("> /dev/tty "),
            "bare /dev/tty target regressed: {cmd}"
        );
    }
}
