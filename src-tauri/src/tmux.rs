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

    // Set window-size latest
    let out = Command::new(TMUX_BIN)
        .arg("set-option")
        .arg("-t")
        .arg(format!("{}:", base))
        .arg("-w")
        .arg("-g")
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

    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
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

    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
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

/// Kill a viewer session.
pub fn kill_viewer(viewer: &str) -> Result<(), AdeError> {
    let out = Command::new(TMUX_BIN)
        .arg("kill-session")
        .arg("-t")
        .arg(viewer)
        .output()
        .map_err(|e| AdeError::Tmux(e.to_string()))?;

    if !out.status.success() {
        return Err(AdeError::Tmux(
            String::from_utf8_lossy(&out.stderr).to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_32_ok() {
        assert_eq!(parse_version("tmux 3.2").unwrap(), (3, 2));
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
}
