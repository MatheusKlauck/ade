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

/// One ADE hook command: emit the marker to the pane tty, best-effort (a hook
/// must never fail or stall the turn).
fn osc_command(state: &str) -> String {
    format!("printf '\\033]9;ade:claude:{state}\\007' > /dev/tty 2>/dev/null || true")
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
