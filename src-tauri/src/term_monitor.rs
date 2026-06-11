//! Per-window terminal completion monitor.
//!
//! ADE wants to notify when a command (or a TUI app) inside a tmux window
//! finishes. The catch: the frontend's xterm only ever sees tmux's *re-rendered*
//! output (through the viewer client), and tmux swallows application-level OSC
//! sequences like OSC 133. So detection has to read the *raw* program output,
//! which `tmux pipe-pane` gives us — and, crucially, it does so server-side,
//! independent of whether a viewer is attached. That means a single monitor per
//! window keeps working across workspace switches and even while the workspace
//! is in the background, which is exactly where "tell me when the build is done"
//! matters most.
//!
//! Pipeline: `pipe-pane` writes the pane's raw bytes into a FIFO; a reader thread
//! scans the stream for completion / bell / app-notification markers and emits an
//! `evt:terminal-alert` for the frontend to (focus-gate and) accumulate on the
//! workspace pill. The thread self-terminates on EOF (the pane died), so there's
//! no lifecycle bookkeeping beyond a dedup set of monitored window ids.

use std::collections::HashSet;
use std::io::Read;
use std::process::Command;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};

/// Window ids that already have a live monitor — guards against starting a
/// second pipe-pane + reader when a window is reattached (every workspace
/// switch reattaches). A monitor removes its id here when its thread exits.
pub type Monitors = Arc<Mutex<HashSet<String>>>;

/// A detected terminal event worth surfacing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Alert {
    /// A shell command finished. Carries the exit code string when known.
    Completed(Option<String>),
    /// A standalone BEL (program rang the terminal bell).
    Bell,
    /// An app-emitted notification (OSC 9 / OSC 777 notify). Carries the text.
    App(String),
}

/// Streaming scanner over raw pane bytes. Kept as a tiny state machine so OSC
/// sequences and bells split across `pipe-pane` read chunks are handled
/// correctly. Pure and fully unit-tested — all the tmux plumbing lives below it.
pub struct Scanner {
    state: St,
    osc: Vec<u8>,
}

#[derive(PartialEq)]
enum St {
    Normal,
    Esc,
    Osc,
    OscEsc,
}

/// Cap on a single OSC payload; a runaway `ESC]` with no terminator is dropped
/// rather than buffered forever.
const MAX_OSC: usize = 8192;

impl Default for Scanner {
    fn default() -> Self {
        Self::new()
    }
}

impl Scanner {
    pub fn new() -> Self {
        Scanner {
            state: St::Normal,
            osc: Vec::new(),
        }
    }

    /// Feed a chunk of raw bytes; invoke `emit` for every alert found.
    pub fn feed(&mut self, bytes: &[u8], mut emit: impl FnMut(Alert)) {
        for &b in bytes {
            match self.state {
                St::Normal => match b {
                    0x1b => self.state = St::Esc,
                    0x07 => emit(Alert::Bell),
                    _ => {}
                },
                St::Esc => match b {
                    b']' => {
                        self.state = St::Osc;
                        self.osc.clear();
                    }
                    0x1b => {} // consecutive ESC — stay, wait for ']'
                    _ => self.state = St::Normal,
                },
                St::Osc => match b {
                    0x07 => {
                        self.finish_osc(&mut emit);
                        self.state = St::Normal;
                    }
                    0x1b => self.state = St::OscEsc,
                    _ => {
                        if self.osc.len() < MAX_OSC {
                            self.osc.push(b);
                        } else {
                            // Overlong / malformed OSC — abandon it.
                            self.osc.clear();
                            self.state = St::Normal;
                        }
                    }
                },
                St::OscEsc => {
                    if b == b'\\' {
                        // ST terminator (ESC \).
                        self.finish_osc(&mut emit);
                        self.state = St::Normal;
                    } else {
                        // Not a terminator after all — fold the ESC back in.
                        if self.osc.len() + 2 <= MAX_OSC {
                            self.osc.push(0x1b);
                            self.osc.push(b);
                            self.state = St::Osc;
                        } else {
                            self.osc.clear();
                            self.state = St::Normal;
                        }
                    }
                }
            }
        }
    }

    fn finish_osc(&mut self, emit: &mut impl FnMut(Alert)) {
        let payload = String::from_utf8_lossy(&self.osc);
        if let Some(rest) = payload.strip_prefix("133;") {
            // OSC 133;D[;<exit>] — command finished.
            if let Some(after) = rest.strip_prefix('D') {
                let code = after.strip_prefix(';').map(|c| c.to_string());
                emit(Alert::Completed(code));
            }
        } else if let Some(text) = payload.strip_prefix("9;") {
            // OSC 9;<text> is an iTerm-style notification. ConEmu reuses OSC 9
            // for progress ("9;4;..") — skip that numeric sub-command form.
            let is_progress = {
                let mut it = text.chars();
                matches!(it.next(), Some(c) if c.is_ascii_digit())
                    && matches!(it.next(), Some(';'))
            };
            if !is_progress && !text.is_empty() {
                emit(Alert::App(clip(text)));
            }
        } else if let Some(rest) = payload.strip_prefix("777;notify;") {
            // OSC 777;notify;<title>;<body>
            let body = rest.replace(';', " — ");
            emit(Alert::App(clip(&body)));
        }
        self.osc.clear();
    }
}

/// Trim a notification message to a sane length.
fn clip(s: &str) -> String {
    s.chars().take(200).collect()
}

/// Sanitize a tmux window id (e.g. `@5`) into a filename-safe token.
fn fifo_token(window_id: &str) -> String {
    window_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// Start monitoring a window's output, unless one is already running for it.
/// Idempotent per `window_id`: safe to call on every `terminal_open` (new and
/// reattach). Cheap and non-blocking — all tmux/IO work happens on the spawned
/// thread so the async command path never stalls.
pub fn ensure(app: AppHandle, monitors: Monitors, workspace_id: String, window_id: String) {
    {
        let mut set = match monitors.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        if !set.insert(window_id.clone()) {
            return; // already monitored
        }
    }

    std::thread::spawn(move || {
        run_monitor(&app, &workspace_id, &window_id);
        if let Ok(mut set) = monitors.lock() {
            set.remove(&window_id);
        }
    });
}

fn run_monitor(app: &AppHandle, workspace_id: &str, window_id: &str) {
    let path = std::env::temp_dir().join(format!("ade-mon-{}.fifo", fifo_token(window_id)));

    // Fresh FIFO (drop any stale one from a previous run at the same path).
    let _ = std::fs::remove_file(&path);
    let mk = Command::new("mkfifo").arg(&path).status();
    if !matches!(mk, Ok(s) if s.success()) {
        return;
    }

    // Tee the pane's raw output into the FIFO. The `cat` runs server-side and
    // outlives viewers, so this keeps feeding us across detach/reattach.
    let pipe = Command::new("tmux")
        .arg("pipe-pane")
        .arg("-t")
        .arg(window_id)
        .arg(format!("cat > '{}'", path.display()))
        .status();
    if !matches!(pipe, Ok(s) if s.success()) {
        let _ = std::fs::remove_file(&path);
        return;
    }

    // Opening the read end unblocks the server-side `cat` (which is blocked
    // opening the write end), then we stream until the pane dies (EOF).
    if let Ok(mut f) = std::fs::File::open(&path) {
        let mut scanner = Scanner::new();
        let mut buf = [0u8; 8192];
        loop {
            match f.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => scanner.feed(&buf[..n], |alert| emit(app, workspace_id, window_id, alert)),
            }
        }
    }

    // Pane is gone: stop piping (best-effort; the pane may already be dead) and
    // drop the FIFO.
    let _ = Command::new("tmux")
        .arg("pipe-pane")
        .arg("-t")
        .arg(window_id)
        .status();
    let _ = std::fs::remove_file(&path);
}

fn emit(app: &AppHandle, workspace_id: &str, window_id: &str, alert: Alert) {
    let (kind, detail) = match alert {
        Alert::Completed(code) => ("completed", code.unwrap_or_default()),
        Alert::Bell => ("bell", String::new()),
        Alert::App(msg) => ("app", msg),
    };
    let _ = app.emit(
        "evt:terminal-alert",
        serde_json::json!({
            "workspace_id": workspace_id,
            "window_id": window_id,
            "kind": kind,
            "detail": detail,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(chunks: &[&[u8]]) -> Vec<Alert> {
        let mut sc = Scanner::new();
        let mut out = Vec::new();
        for c in chunks {
            sc.feed(c, |a| out.push(a));
        }
        out
    }

    #[test]
    fn completion_with_exit_code() {
        let out = collect(&[b"\x1b]133;D;0\x07"]);
        assert_eq!(out, vec![Alert::Completed(Some("0".into()))]);
    }

    #[test]
    fn completion_nonzero_exit() {
        let out = collect(&[b"done\x1b]133;D;1\x07"]);
        assert_eq!(out, vec![Alert::Completed(Some("1".into()))]);
    }

    #[test]
    fn completion_without_exit_code() {
        let out = collect(&[b"\x1b]133;D\x07"]);
        assert_eq!(out, vec![Alert::Completed(None)]);
    }

    #[test]
    fn osc_terminating_bell_is_not_a_bell() {
        // The BEL that ends the OSC must not also count as a standalone bell.
        let out = collect(&[b"\x1b]133;D;0\x07"]);
        assert_eq!(out, vec![Alert::Completed(Some("0".into()))]);
    }

    #[test]
    fn standalone_bell() {
        let out = collect(&[b"ring\x07ring"]);
        assert_eq!(out, vec![Alert::Bell]);
    }

    #[test]
    fn completion_split_across_chunks() {
        let out = collect(&[b"\x1b]13", b"3;D;", b"0\x07"]);
        assert_eq!(out, vec![Alert::Completed(Some("0".into()))]);
    }

    #[test]
    fn st_terminated_osc() {
        // OSC 133;D terminated by ST (ESC \) instead of BEL.
        let out = collect(&[b"\x1b]133;D;0\x1b\\"]);
        assert_eq!(out, vec![Alert::Completed(Some("0".into()))]);
    }

    #[test]
    fn osc9_notification() {
        let out = collect(&[b"\x1b]9;Build finished\x07"]);
        assert_eq!(out, vec![Alert::App("Build finished".into())]);
    }

    #[test]
    fn osc9_progress_is_ignored() {
        // ConEmu progress form OSC 9;4;.. must not be treated as a message.
        let out = collect(&[b"\x1b]9;4;50\x07"]);
        assert_eq!(out, Vec::<Alert>::new());
    }

    #[test]
    fn osc777_notify() {
        let out = collect(&[b"\x1b]777;notify;Title;Body\x07"]);
        assert_eq!(out, vec![Alert::App("Title — Body".into())]);
    }

    #[test]
    fn title_osc_is_ignored() {
        // OSC 0/2 (window title) must not produce alerts.
        let out = collect(&[b"\x1b]0;my title\x07\x1b]2;other\x07"]);
        assert_eq!(out, Vec::<Alert>::new());
    }

    #[test]
    fn mixed_stream() {
        let out = collect(&[b"\x1b]0;title\x07npm run build\r\n\x1b]133;D;0\x07\x07"]);
        assert_eq!(
            out,
            vec![Alert::Completed(Some("0".into())), Alert::Bell]
        );
    }
}
