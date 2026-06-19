use crate::error::AdeError;
use std::process::Command;

const TMUX_BIN: &str = "tmux";
const MIN_VERSION: (u32, u32) = (3, 2);

/// Check tmux version. Returns Ok(()) if >= 3.2, else TmuxTooOld or TmuxMissing.
pub fn check_version() -> Result<(), AdeError> {
    let output = Command::new(TMUX_BIN)
        .arg("-V")
        .output()
        .map_err(|_| AdeError::TmuxMissing)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AdeError::Tmux(stderr.to_string()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let ver = parse_version(&stdout)?;
    if ver < MIN_VERSION {
        return Err(AdeError::TmuxTooOld(format!(
            "tmux {}.{} required, found {}.{}",
            MIN_VERSION.0, MIN_VERSION.1, ver.0, ver.1
        )));
    }
    Ok(())
}

/// Parse version string like "tmux 3.4", "tmux 3.3a", "tmux next-3.5".
/// Returns (major, minor).
fn parse_version(output: &str) -> Result<(u32, u32), AdeError> {
    let s = output.trim();
    // Skip "tmux " prefix
    let rest = s
        .strip_prefix("tmux ")
        .ok_or_else(|| AdeError::Tmux(format!("unrecognized version output: {}", s)))?;

    // Handle "next-3.5" -> "3.5"
    let rest = rest.strip_prefix("next-").unwrap_or(rest);

    // Strip trailing letters (e.g., "3.3a" -> "3.3")
    let cleaned: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();

    let parts: Vec<&str> = cleaned.split('.').collect();
    if parts.len() < 2 {
        return Err(AdeError::Tmux(format!(
            "unrecognized version output: {}",
            s
        )));
    }

    let major = parts[0]
        .parse::<u32>()
        .map_err(|_| AdeError::Tmux(format!("unrecognized version output: {}", s)))?;
    let minor = parts[1]
        .parse::<u32>()
        .map_err(|_| AdeError::Tmux(format!("unrecognized version output: {}", s)))?;

    Ok((major, minor))
}

/// Return the base session name for a workspace slug.
pub fn base_session(slug: &str) -> String {
    format!("ade_{}", slug)
}

/// Return a viewer session name.
pub fn viewer_session(slug: &str, uuid8: &str) -> String {
    format!("ade_{}__v{}", slug, uuid8)
}

/// Create the dev workspace root directory under $TMPDIR.
/// Returns (slug, root_path).
pub fn dev_workspace() -> Result<(String, String), AdeError> {
    let tmp = std::env::temp_dir();
    let root = tmp.join("ade_dev_workspace");
    std::fs::create_dir_all(&root).map_err(AdeError::Io)?;
    Ok(("dev".into(), root.to_string_lossy().into_owned()))
}

/// Return true if a tmux session with the exact given name exists.
pub fn session_exists(session: &str) -> bool {
    Command::new(TMUX_BIN)
        .arg("has-session")
        .arg("-t")
        .arg(format!("={}", session))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Ensure the base tmux session exists.
pub fn ensure_base_session(slug: &str, root_path: &str) -> Result<(), AdeError> {
    let base = base_session(slug);

    let has = Command::new(TMUX_BIN)
        .arg("has-session")
        .arg("-t")
        .arg(format!("={}", base))
        .output()
        .map_err(|e| AdeError::Tmux(e.to_string()))?;

    if has.status.success() {
        return Ok(());
    }

    // Create detached session
    let out = Command::new(TMUX_BIN)
        .arg("new-session")
        .arg("-d")
        .arg("-s")
        .arg(&base)
        .arg("-c")
        .arg(root_path)
        .output()
        .map_err(|e| AdeError::Tmux(e.to_string()))?;

    if !out.status.success() {
        return Err(AdeError::Tmux(
            String::from_utf8_lossy(&out.stderr).to_string(),
        ));
    }

    // Set window-size latest, scoped to this session only — `-g` here would
    // mutate the user's server-global option and affect their own tmux sessions.
    let out = Command::new(TMUX_BIN)
        .arg("set-option")
        .arg("-t")
        .arg(format!("{}:", base))
        .arg("-w")
        .arg("window-size")
        .arg("latest")
        .output()
        .map_err(|e| AdeError::Tmux(e.to_string()))?;

    if !out.status.success() {
        return Err(AdeError::Tmux(
            String::from_utf8_lossy(&out.stderr).to_string(),
        ));
    }

    Ok(())
}

/// Create a new app window in the base session.
/// Returns the window id (e.g., "@7").
pub fn new_app_window(slug: &str, root_path: &str) -> Result<String, AdeError> {
    let base = base_session(slug);
    let out = Command::new(TMUX_BIN)
        .arg("new-window")
        .arg("-t")
        .arg(format!("{}:", base))
        .arg("-c")
        .arg(root_path)
        .arg("-P")
        .arg("-F")
        .arg("#{window_id}")
        .output()
        .map_err(|e| AdeError::Tmux(e.to_string()))?;

    if !out.status.success() {
        return Err(AdeError::Tmux(
            String::from_utf8_lossy(&out.stderr).to_string(),
        ));
    }

    let window_id = String::from_utf8_lossy(&out.stdout).trim().to_string();
    set_window_size_latest(&window_id);
    inject_shell_integration(&window_id);
    Ok(window_id)
}

/// Create a new issue window with env vars.
/// Returns the window id.
pub fn new_issue_window(
    slug: &str,
    root_path: &str,
    winname: &str,
    issue_number: u64,
    title: &str,
    url: &str,
) -> Result<String, AdeError> {
    let base = base_session(slug);
    let out = Command::new(TMUX_BIN)
        .arg("new-window")
        .arg("-t")
        .arg(format!("{}:", base))
        .arg("-n")
        .arg(winname)
        .arg("-c")
        .arg(root_path)
        .arg("-e")
        .arg(format!("ISSUE_NUMBER={}", issue_number))
        .arg("-e")
        .arg(format!("ISSUE_TITLE={}", title))
        .arg("-e")
        .arg(format!("ISSUE_URL={}", url))
        .arg("-P")
        .arg("-F")
        .arg("#{window_id}")
        .output()
        .map_err(|e| AdeError::Tmux(e.to_string()))?;

    if !out.status.success() {
        return Err(AdeError::Tmux(
            String::from_utf8_lossy(&out.stderr).to_string(),
        ));
    }

    let window_id = String::from_utf8_lossy(&out.stdout).trim().to_string();
    set_window_size_latest(&window_id);
    inject_shell_integration(&window_id);
    Ok(window_id)
}

/// Best-effort: size a window to its most recently active client. Applied
/// per-window so ADE never touches the user's global tmux options.
fn set_window_size_latest(window_id: &str) {
    let _ = Command::new(TMUX_BIN)
        .arg("set-option")
        .arg("-t")
        .arg(window_id)
        .arg("-w")
        .arg("window-size")
        .arg("latest")
        .output();
}

/// Shell snippet that makes bash/zsh emit an OSC 133;C marker when an interactive
/// command starts and an OSC 133;D;<exit> marker when it finishes. ADE reads both
/// off the raw pane output (via `pipe-pane`, see `term_monitor`): the start marker
/// drives the per-window "busy" state (the tab comet for background workspaces),
/// the done marker drives completion notifications. Sourced once per freshly
/// created window; the hooks live in the shell process, so they persist across
/// detach/reattach (tmux windows outlive the app's viewers).
const SHELL_INTEGRATION: &str = r#"# ade shell integration — emit OSC 133;C on command start and OSC 133;D;<exit> on finish.
# Ensure UTF-8 locale so emojis and accented characters are accepted.
export LANG="${LANG:-en_US.UTF-8}"
export LC_CTYPE="${LC_CTYPE:-en_US.UTF-8}"
if [ -n "${ZSH_VERSION:-}" ]; then
  autoload -Uz add-zsh-hook 2>/dev/null
  # preexec runs right before the entered command executes: emit the start marker.
  __ade_preexec() { __ade_ran=1; printf '\033]133;C\007' }
  __ade_precmd() {
    local __e=$?
    if [ "${__ade_ran:-0}" = "1" ]; then
      __ade_ran=0
      printf '\033]133;D;%s\007' "$__e"
    fi
  }
  add-zsh-hook preexec __ade_preexec 2>/dev/null
  add-zsh-hook precmd __ade_precmd 2>/dev/null
elif [ -n "${BASH_VERSION:-}" ]; then
  # bash has no native preexec; a DEBUG trap fires before every simple command.
  # An "armed" flag (set at the prompt by __ade_arm, cleared on first fire) emits
  # 133;C once per entered command line rather than once per pipeline element.
  # Skip our own hook functions so PROMPT_COMMAND machinery doesn't consume it.
  __ade_preexec() {
    case "$BASH_COMMAND" in __ade_*) return;; esac
    if [ "${__ade_armed:-0}" = "1" ]; then
      __ade_armed=0
      printf '\033]133;C\007'
    fi
  }
  __ade_precmd() {
    local __e=$?
    if [ "${__ade_last:-}" != "$HISTCMD" ]; then
      __ade_last=$HISTCMD
      printf '\033]133;D;%s\007' "$__e"
    fi
  }
  trap '__ade_preexec' DEBUG
  __ade_last=$HISTCMD
  case ";${PROMPT_COMMAND:-};" in
    *";__ade_precmd;"*) ;;
    # arming runs LAST so the flag survives the rest of PROMPT_COMMAND.
    *) PROMPT_COMMAND="__ade_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND};__ade_armed=1" ;;
  esac
fi
"#;

/// Stable path of the sourced shell-integration script.
fn integration_script_path() -> std::path::PathBuf {
    std::env::temp_dir().join("ade-shell-integration.sh")
}

/// A `claude` shell function that transparently adds `--settings <ade file>` to
/// every invocation, so ADE's turn-state hooks load WITHOUT touching the user's
/// `~/.claude/settings.json`. `--settings` hooks accumulate with the user's own,
/// and this only takes effect inside ADE's panes (where this script is sourced).
/// Falls back to plain `claude` if the file is missing. Works in bash and zsh.
fn claude_wrapper_snippet() -> String {
    let settings = crate::claude_hooks::settings_path();
    format!(
        r#"
# ade: load ADE's Claude turn-state hooks per-session (no global config edit).
claude() {{
  if [ -f '{path}' ]; then
    ADE_TTY="$(tty)" command claude --settings '{path}' "$@"
  else
    command claude "$@"
  fi
}}
"#,
        path = settings.display()
    )
}

/// `pi` and `opencode` shell functions, the analogues of `claude_wrapper_snippet`
/// for the other agents. Both export `$ADE_TTY` (so the turn-state shims can
/// write the OSC marker to the pane pty). pi loads its shim per-invocation via
/// `-e`; opencode's shim is a global plugin gated on `$ADE_TTY`, so the wrapper
/// only needs to export the tty.
fn other_agent_wrapper_snippets() -> String {
    let pi_ext = crate::agent_shims::pi_extension_path();
    format!(
        r#"
# ade: load ADE's pi turn-state extension per-session (no global config edit).
pi() {{
  if [ -f '{pi_ext}' ]; then
    ADE_TTY="$(tty)" command pi -e '{pi_ext}' "$@"
  else
    ADE_TTY="$(tty)" command pi "$@"
  fi
}}
# ade: opencode's turn-state plugin is global but inert unless ADE_TTY is set.
opencode() {{
  ADE_TTY="$(tty)" command opencode "$@"
}}
"#,
        pi_ext = pi_ext.display()
    )
}

/// Write the shell-integration snippet to a stable temp path so new windows can
/// `source` it. Returns the path on success. Best-effort; overwrites each call
/// so the snippet stays current with the running build.
pub fn ensure_integration_script() -> Result<std::path::PathBuf, AdeError> {
    // Make sure each agent's turn-state shim file exists before any window's
    // wrapper function references it.
    crate::claude_hooks::ensure();
    crate::agent_shims::ensure_pi();
    crate::agent_shims::ensure_opencode();
    let path = integration_script_path();
    let body = format!(
        "{SHELL_INTEGRATION}{}{}",
        claude_wrapper_snippet(),
        other_agent_wrapper_snippets()
    );
    std::fs::write(&path, body).map_err(|e| AdeError::Tmux(e.to_string()))?;
    Ok(path)
}

/// Source the shell-integration snippet into a freshly created window's shell.
/// The shell only reads our keys once its rc has finished (it's blocked reading
/// the first prompt line), so our hooks append cleanly on top of the user's
/// PROMPT_COMMAND. Best-effort: a failure only means no completion markers for
/// that window — it must NEVER fail window creation (BUG-001 leak invariant).
pub fn inject_shell_integration(window_id: &str) {
    if let Ok(path) = ensure_integration_script() {
        // Leading space keeps it out of history when HISTCONTROL has ignorespace.
        let _ = send_keys(window_id, &format!(" source '{}'", path.display()));
    }
}

/// Return the argv array for viewer attach (runs inside PTY).
/// CONTRACTS §8: ["tmux","new-session","-A","-t",base,"-s",viewer,";","select-window","-t",win]
pub fn viewer_attach_argv(base: &str, viewer: &str, window_id: &str) -> Vec<String> {
    vec![
        "tmux".into(),
        "new-session".into(),
        "-A".into(),
        "-t".into(),
        base.into(),
        "-s".into(),
        viewer.into(),
        ";".into(),
        "select-window".into(),
        "-t".into(),
        window_id.into(),
    ]
}

/// Turn off status bar in viewer session.
pub fn viewer_status_off(viewer: &str) -> Result<(), AdeError> {
    let out = Command::new(TMUX_BIN)
        .arg("set-option")
        .arg("-t")
        .arg(format!("{}:", viewer))
        .arg("status")
        .arg("off")
        .output()
        .map_err(|e| AdeError::Tmux(e.to_string()))?;

    if !out.status.success() {
        return Err(AdeError::Tmux(
            String::from_utf8_lossy(&out.stderr).to_string(),
        ));
    }
    Ok(())
}

/// Enable mouse mode on the viewer session. tmux runs inside xterm's alternate
/// screen, so without this xterm's "alternate scroll" turns a wheel-up at the
/// shell prompt into cursor-Up keys (shell history recall) instead of scrolling.
/// With mouse on, tmux owns the wheel and scrolls the pane's scrollback. Scoped
/// to the viewer session only — never the user's global tmux options.
pub fn viewer_mouse_on(viewer: &str) -> Result<(), AdeError> {
    let out = Command::new(TMUX_BIN)
        .arg("set-option")
        .arg("-t")
        .arg(format!("{}:", viewer))
        .arg("mouse")
        .arg("on")
        .output()
        .map_err(|e| AdeError::Tmux(e.to_string()))?;

    if !out.status.success() {
        return Err(AdeError::Tmux(
            String::from_utf8_lossy(&out.stderr).to_string(),
        ));
    }
    Ok(())
}

/// Send keys to a window. The command is passed as a single argv element.
pub fn send_keys(window_id: &str, command: &str) -> Result<(), AdeError> {
    let out = Command::new(TMUX_BIN)
        .arg("send-keys")
        .arg("-t")
        .arg(window_id)
        .arg(command)
        .arg("Enter")
        .output()
        .map_err(|e| AdeError::Tmux(e.to_string()))?;

    if !out.status.success() {
        return Err(AdeError::Tmux(
            String::from_utf8_lossy(&out.stderr).to_string(),
        ));
    }
    Ok(())
}

/// Check if a window is alive in the base session.
pub fn window_alive(slug: &str, window_id: &str) -> Result<bool, AdeError> {
    let base = base_session(slug);
    let out = Command::new(TMUX_BIN)
        .arg("list-windows")
        .arg("-t")
        .arg(format!("{}:", base))
        .arg("-F")
        .arg("#{window_id}")
        .output()
        .map_err(|e| AdeError::Tmux(e.to_string()))?;

    if !out.status.success() {
        // Session might not exist, which means no windows.
        return Ok(false);
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    Ok(stdout.lines().any(|line| line.trim() == window_id))
}

/// Kill a tmux window.
pub fn kill_window(window_id: &str) -> Result<(), AdeError> {
    let out = Command::new(TMUX_BIN)
        .arg("kill-window")
        .arg("-t")
        .arg(window_id)
        .output()
        .map_err(|e| AdeError::Tmux(e.to_string()))?;

    if !out.status.success() {
        return Err(AdeError::Tmux(
            String::from_utf8_lossy(&out.stderr).to_string(),
        ));
    }
    Ok(())
}

/// Kill a tmux session by exact name (e.g. a workspace base session).
pub fn kill_session(session: &str) -> Result<(), AdeError> {
    let out = Command::new(TMUX_BIN)
        .arg("kill-session")
        .arg("-t")
        .arg(format!("={}", session))
        .output()
        .map_err(|e| AdeError::Tmux(e.to_string()))?;

    if !out.status.success() {
        return Err(AdeError::Tmux(
            String::from_utf8_lossy(&out.stderr).to_string(),
        ));
    }
    Ok(())
}

/// Kill every detached ADE viewer session (`ade_*__v*` with no attached client).
///
/// Viewer sessions are ephemeral per-view attachments to a workspace's base
/// session. They are normally killed on pane close / workspace close, but a
/// hard app exit (crash, SIGKILL, `tauri dev` HMR restart) bypasses those
/// paths: the PTY client dies, the viewer detaches, and the session lingers in
/// the tmux server forever, accumulating across launches (the viewer leak).
///
/// A *detached* viewer is always disposable — the base session it mirrors is
/// left untouched, so no work is lost. An *attached* viewer belongs to a live
/// client (this or another running instance) and is never touched. Runs at
/// startup to reap leftovers from a previous crash. Best-effort: returns the
/// number of sessions killed, swallowing any list/kill failure (e.g. no server).
pub fn kill_detached_viewers() -> usize {
    let out = match Command::new(TMUX_BIN)
        .arg("list-sessions")
        .arg("-F")
        .arg("#{session_name} #{session_attached}")
        .output()
    {
        Ok(o) if o.status.success() => o,
        // No tmux server running yet, or no sessions — nothing to reap.
        _ => return 0,
    };

    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut killed = 0;
    for line in stdout.lines() {
        // Format is "<name> <attached_count>". Split from the right so a name
        // is never mis-parsed (the attached count is always a trailing number).
        let mut it = line.rsplitn(2, ' ');
        let attached = it.next().unwrap_or("");
        let name = match it.next() {
            Some(n) => n,
            None => continue,
        };
        // Only ADE viewer sessions (`ade_<slug>__v<uuid>`), only when no client
        // is attached. `viewer_session()` is the single source of this shape.
        if name.starts_with("ade_") && name.contains("__v") && attached == "0" {
            let ok = Command::new(TMUX_BIN)
                .arg("kill-session")
                .arg("-t")
                .arg(format!("={}", name))
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if ok {
                killed += 1;
            }
        }
    }
    killed
}

/// Kill a viewer session.
pub fn kill_viewer(viewer: &str) -> Result<(), AdeError> {
    let out = Command::new(TMUX_BIN)
        .arg("kill-session")
        .arg("-t")
        // `=` forces exact-match; bare names fall back to tmux prefix matching.
        .arg(format!("={}", viewer))
        .output()
        .map_err(|e| AdeError::Tmux(e.to_string()))?;

    if !out.status.success() {
        return Err(AdeError::Tmux(
            String::from_utf8_lossy(&out.stderr).to_string(),
        ));
    }
    Ok(())
}

/// Capture the visible content of a pane.
pub fn capture_pane(window_id: &str) -> Result<String, AdeError> {
    let out = Command::new(TMUX_BIN)
        .arg("capture-pane")
        .arg("-p")
        .arg("-t")
        .arg(window_id)
        .output()
        .map_err(|e| AdeError::Tmux(e.to_string()))?;

    if !out.status.success() {
        return Err(AdeError::Tmux(
            String::from_utf8_lossy(&out.stderr).to_string(),
        ));
    }

    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_32_ok() {
        assert_eq!(parse_version("tmux 3.2").unwrap(), (3, 2));
    }

    #[test]
    fn claude_wrapper_exports_pane_tty() {
        // Regression: the wrapper must capture the pane's tty into ADE_TTY so the
        // hooks (which run with no controlling terminal) can write the OSC marker
        // to a real pty that pipe-pane captures. It must also pass --settings.
        let s = claude_wrapper_snippet();
        assert!(
            s.contains("ADE_TTY=\"$(tty)\""),
            "missing ADE_TTY export: {s}"
        );
        assert!(s.contains("--settings"));
        assert!(s.contains("command claude"));
    }

    #[test]
    fn parse_version_33a_ok() {
        assert_eq!(parse_version("tmux 3.3a").unwrap(), (3, 3));
    }

    #[test]
    fn parse_version_next35_ok() {
        assert_eq!(parse_version("tmux next-3.5").unwrap(), (3, 5));
    }

    #[test]
    fn parse_version_31c_fails() {
        let v = parse_version("tmux 3.1c").unwrap();
        assert!(v < MIN_VERSION);
    }

    #[test]
    fn parse_version_29_fails() {
        let v = parse_version("tmux 2.9").unwrap();
        assert!(v < MIN_VERSION);
    }

    #[test]
    fn parse_version_garbage_fails() {
        assert!(parse_version("garbage").is_err());
    }

    #[test]
    fn check_version_on_this_machine() {
        // This is the real version check; it should pass on any dev machine.
        assert!(check_version().is_ok());
    }

    #[test]
    #[ignore = "needs-tmux"]
    fn tmux_end_to_end() {
        let (slug, root) = dev_workspace().unwrap();
        let base = base_session(&slug);

        // Clean up any stale session
        let _ = Command::new(TMUX_BIN)
            .arg("kill-session")
            .arg("-t")
            .arg(&base)
            .output();

        // Ensure base session
        ensure_base_session(&slug, &root).unwrap();

        // Create window
        let win = new_app_window(&slug, &root).unwrap();
        assert!(win.starts_with("@"));

        // Window alive
        assert!(window_alive(&slug, &win).unwrap());

        // Kill window
        kill_window(&win).unwrap();
        assert!(!window_alive(&slug, &win).unwrap());

        // Clean up base
        let _ = Command::new(TMUX_BIN)
            .arg("kill-session")
            .arg("-t")
            .arg(&base)
            .output();
    }

    #[test]
    fn viewer_attach_argv_correct() {
        let argv = viewer_attach_argv("ade_dev", "ade_dev__vabc12345", "@5");
        assert_eq!(
            argv,
            vec![
                "tmux",
                "new-session",
                "-A",
                "-t",
                "ade_dev",
                "-s",
                "ade_dev__vabc12345",
                ";",
                "select-window",
                "-t",
                "@5",
            ]
        );
    }

    #[test]
    fn base_and_viewer_session_names() {
        assert_eq!(base_session("foo"), "ade_foo");
        assert_eq!(viewer_session("foo", "abc12345"), "ade_foo__vabc12345");
    }

    #[test]
    fn dev_workspace_creates_dir() {
        let (slug, root) = dev_workspace().unwrap();
        assert_eq!(slug, "dev");
        assert!(std::path::Path::new(&root).exists());
    }

    #[test]
    #[ignore = "needs-tmux"]
    fn startup_command_injection() {
        let (slug, root) = dev_workspace().unwrap();
        let base = base_session(&slug);
        let _ = Command::new(TMUX_BIN)
            .arg("kill-session")
            .arg("-t")
            .arg(&base)
            .output();
        ensure_base_session(&slug, &root).unwrap();
        let win = new_app_window(&slug, &root).unwrap();
        send_keys(&win, "export ADE_TEST=1").unwrap();
        // wait for shell
        std::thread::sleep(std::time::Duration::from_millis(300));
        send_keys(&win, "echo $ADE_TEST").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let captured = capture_pane(&win).unwrap();
        assert!(
            captured.contains("1"),
            "expected captured pane to contain 1, got: {}",
            captured
        );
        kill_window(&win).unwrap();
        let _ = Command::new(TMUX_BIN)
            .arg("kill-session")
            .arg("-t")
            .arg(&base)
            .output();
    }
}
