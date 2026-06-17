//! Supervise the single, app-owned `gbrain serve --http`.
//!
//! The app is the host: it reaps any stray stdio `gbrain serve` (e.g. one
//! Claude Code spawned, which holds the exclusive PGLite lock), then starts and
//! keeps alive one `gbrain serve --http`. Other clients (Claude Code, this app's
//! own [`super::mcp`] reads) connect to it over HTTP. Process handling mirrors
//! the std-process style used in `tmux.rs`, with a tokio supervisor that
//! restarts the child on crash and a sync `kill()` for the app's exit handler.

use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Fixed loopback port for the local serve. Loopback-only + bearer auth; not
/// meant to be reachable off-box.
pub const DEFAULT_PORT: u16 = 7777;

/// Serve origin (no `/mcp` suffix).
pub fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Resolve the `gbrain` binary. GUI launches inherit a minimal PATH that omits
/// `~/.bun/bin` (where `bun`-installed gbrain lives) and Homebrew, so probe the
/// usual spots before falling back to bare `gbrain` (PATH lookup).
pub fn gbrain_bin() -> String {
    if let Some(p) = std::env::var_os("GBRAIN_BIN") {
        let p = std::path::PathBuf::from(p);
        if p.is_file() {
            return p.to_string_lossy().into_owned();
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        for rel in [".bun/bin/gbrain", ".local/bin/gbrain"] {
            let p = std::path::Path::new(&home).join(rel);
            if p.is_file() {
                return p.to_string_lossy().into_owned();
            }
        }
    }
    for abs in ["/opt/homebrew/bin/gbrain", "/usr/local/bin/gbrain"] {
        if std::path::Path::new(abs).is_file() {
            return abs.to_string();
        }
    }
    "gbrain".to_string()
}

/// Decide whether a `ps` row is a stray serve we must reap to own the PGLite
/// lock: any stdio serve (e.g. one Claude Code spawned), and any *orphaned*
/// `--http` serve (PPID 1) left over from a previous app session. Our own
/// supervised `--http` child has the app as parent, so it's never matched.
fn should_reap(ppid: &str, args: &str) -> bool {
    if !(args.contains("gbrain") && args.contains("serve")) {
        return false;
    }
    if args.contains("--http") {
        ppid == "1" // orphan only; leave our supervised child (and foreground ones)
    } else {
        true
    }
}

/// Kill stray `gbrain serve` processes that would fight us for the exclusive
/// PGLite lock — stdio serves and orphaned `--http` serves (see [`should_reap`]).
/// The assertive "reap on startup" the app uses to take ownership of the brain
/// lock. Returns how many were signaled.
pub fn reap_orphan_serves() -> usize {
    let Ok(out) = Command::new("ps")
        .args(["-axo", "pid=,ppid=,args="])
        .output()
    else {
        return 0;
    };
    let listing = String::from_utf8_lossy(&out.stdout);
    let mut reaped = 0;
    for line in listing.lines() {
        let mut it = line.split_whitespace();
        let (Some(pid_str), Some(ppid_str)) = (it.next(), it.next()) else {
            continue;
        };
        if should_reap(ppid_str, line) {
            if let Ok(pid) = pid_str.parse::<u32>() {
                if Command::new("kill").arg(pid.to_string()).status().is_ok() {
                    reaped += 1;
                }
            }
        }
    }
    reaped
}

/// A running, supervised `gbrain serve --http`. Dropping the handle does not
/// stop the serve — call [`ServeHandle::kill`] (the app's exit handler does).
pub struct ServeHandle {
    port: u16,
    shutdown: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
    _supervisor: tokio::task::JoinHandle<()>,
}

impl ServeHandle {
    /// Stop supervising and terminate the child. Safe to call from a sync
    /// context (the Tauri `RunEvent::Exit` handler).
    pub fn kill(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut c) = guard.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }

    /// Restart the serve in place: kill the current child and spawn a fresh one
    /// into the same slot, leaving supervision running (unlike [`kill`], which
    /// stops it). User-triggered recovery from the "offline" panel — and a way
    /// to pick up a freed PGLite lock or a new gbrain binary. Errors if the
    /// respawn fails (the supervisor will then keep retrying on its own).
    pub fn restart(&self) -> std::io::Result<()> {
        let mut guard = self
            .child
            .lock()
            .map_err(|_| std::io::Error::other("serve child lock poisoned"))?;
        if let Some(mut c) = guard.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        *guard = Some(spawn_child(self.port)?);
        Ok(())
    }
}

fn spawn_child(port: u16) -> std::io::Result<Child> {
    Command::new(gbrain_bin())
        .args(["serve", "--http", "--port", &port.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

/// Start the serve and a tokio supervisor that restarts it on crash (capped
/// exponential backoff). The child is held in a shared slot so the exit handler
/// can kill it synchronously.
pub fn spawn_supervised(port: u16) -> ServeHandle {
    let shutdown = Arc::new(AtomicBool::new(false));
    let child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let sd = shutdown.clone();
    let ch = child.clone();

    let supervisor = tokio::spawn(async move {
        let mut backoff = 1u64;
        loop {
            if sd.load(Ordering::SeqCst) {
                break;
            }
            // Decide whether a (re)spawn is needed, and do it while holding the
            // lock briefly — never across the await below.
            let respawned = {
                let mut guard = ch.lock().unwrap();
                let running = match guard.as_mut() {
                    Some(c) => matches!(c.try_wait(), Ok(None)),
                    None => false,
                };
                if running {
                    false
                } else {
                    match spawn_child(port) {
                        Ok(c) => {
                            *guard = Some(c);
                        }
                        Err(e) => eprintln!("gbrain serve --http spawn failed: {e}"),
                    }
                    true
                }
            };
            let wait = if respawned { backoff } else { 2 };
            tokio::time::sleep(Duration::from_secs(wait)).await;
            backoff = if respawned { (backoff * 2).min(30) } else { 1 };
        }
        if let Ok(mut guard) = ch.lock() {
            if let Some(mut c) = guard.take() {
                let _ = c.kill();
            }
        }
    });

    ServeHandle {
        port,
        shutdown,
        child,
        _supervisor: supervisor,
    }
}

/// Poll the serve's `/mcp` until it answers an MCP `initialize` or attempts run
/// out. Returns true once ready. Used after spawn so the status pill doesn't
/// flash "offline" during the serve's startup window.
pub async fn wait_until_ready(port: u16, token: &str, attempts: u32) -> bool {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap_or_default();
    let client = super::mcp::McpClient::with_client(&base_url(port), token, http);
    for _ in 0..attempts {
        if client.ping().await.is_ok() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_has_no_mcp_suffix() {
        assert_eq!(base_url(7777), "http://127.0.0.1:7777");
    }

    #[test]
    fn should_reap_targets_strays_not_our_child() {
        let stdio = "/Users/mk/.bun/bin/gbrain serve";
        let http = "bun /Users/mk/.bun/bin/gbrain serve --http --port 7777";
        assert!(should_reap("4242", stdio)); // stdio: any parent
        assert!(should_reap("1", http)); // orphaned http: reap
        assert!(!should_reap("4242", http)); // our supervised child: leave it
        assert!(!should_reap("1", "bun /some/other serve --http")); // not gbrain
    }

    #[test]
    fn gbrain_bin_falls_back_to_path_lookup() {
        // With GBRAIN_BIN unset and no known install in the test env, we still
        // get a usable command string (bare "gbrain" for PATH resolution).
        let bin = gbrain_bin();
        assert!(bin.ends_with("gbrain"));
    }
}
