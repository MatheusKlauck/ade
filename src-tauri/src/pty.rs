#![allow(dead_code)]
use crate::error::AdeError;
use crate::tmux;
use portable_pty::{CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

pub struct PtyPane {
    pub id: String,
    pub workspace_id: String,
    pub window_id: String,
    pub viewer: String,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

pub type PtyRegistry = Arc<Mutex<HashMap<String, PtyPane>>>;

impl PtyPane {
    pub fn write(&self, data: &[u8]) -> Result<(), AdeError> {
        let mut w = self
            .writer
            .lock()
            .map_err(|e| AdeError::Pty(e.to_string()))?;
        w.write_all(data)
            .map_err(|e| AdeError::Pty(e.to_string()))?;
        w.flush().map_err(|e| AdeError::Pty(e.to_string()))?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), AdeError> {
        self.master
            .resize(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AdeError::Pty(e.to_string()))
    }

    pub fn close(self) -> Result<(), AdeError> {
        let mut child = self
            .child
            .lock()
            .map_err(|e| AdeError::Pty(e.to_string()))?;
        let _ = child.kill();
        let _ = child.wait();
        let _ = tmux::kill_viewer(&self.viewer);
        Ok(())
    }
}

pub fn spawn(
    slug: &str,
    workspace_id: String,
    window_id: String,
    viewer: String,
    root_path: String,
    on_data: impl Fn(Vec<u8>) + Send + 'static,
) -> Result<PtyPane, AdeError> {
    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AdeError::Pty(e.to_string()))?;

    let base = tmux::base_session(slug);
    let argv = tmux::viewer_attach_argv(&base, &viewer, &window_id);
    // argv is a full argv per CONTRACTS §8 (argv[0] == "tmux"). The program name
    // must NOT be re-added as an argument, or tmux runs `tmux tmux new-session …`
    // and prints "unknown command: tmux".
    let mut cmd = CommandBuilder::new(&argv[0]);
    for a in &argv[1..] {
        cmd.arg(a);
    }
    cmd.cwd(&root_path);
    // The bundled .app is launched by launchd/Finder with a minimal environment
    // that has no TERM, so the tmux client inside the PTY can't resolve a terminfo
    // entry and dies with "open terminal failed: terminal does not support clear".
    // The PTY is rendered by xterm.js on the frontend, so xterm-256color is the
    // correct, always-present type. Set it explicitly so behavior doesn't depend
    // on how the app was launched (dev shell vs. Finder).
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AdeError::Pty(e.to_string()))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AdeError::Pty(e.to_string()))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| AdeError::Pty(e.to_string()))?;

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => on_data(buf[..n].to_vec()),
            }
        }
    });

    let pane_id = format!("{}__{}", workspace_id, window_id);

    Ok(PtyPane {
        id: pane_id,
        workspace_id,
        window_id,
        viewer,
        writer: Mutex::new(writer),
        master: pair.master,
        child: Mutex::new(child),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    #[ignore = "needs-tmux"]
    fn pty_spawn_write_read_close() {
        let (slug, root) = tmux::dev_workspace().unwrap();
        tmux::ensure_base_session(&slug, &root).unwrap();
        let win = tmux::new_app_window(&slug, &root).unwrap();
        let viewer = tmux::viewer_session(&slug, "test1234");

        let output = Arc::new(Mutex::new(Vec::new()));
        let output2 = output.clone();

        let pane = spawn(
            &slug,
            "ws-test".into(),
            win.clone(),
            viewer.clone(),
            root.clone(),
            move |bytes| output2.lock().unwrap().extend(bytes),
        )
        .unwrap();

        // Give shell a moment to settle, then write command
        std::thread::sleep(std::time::Duration::from_millis(300));
        pane.write(b"echo hi\r").unwrap();

        // Wait up to 5 seconds for output to contain "hi"
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut found = false;
        while std::time::Instant::now() < deadline {
            let buf = output.lock().unwrap();
            if String::from_utf8_lossy(&buf).contains("hi") {
                found = true;
                break;
            }
            drop(buf);
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(found, "expected output to contain 'hi'");

        // Clean up
        pane.close().unwrap();
        let base = tmux::base_session(&slug);
        let _ = Command::new("tmux")
            .arg("kill-session")
            .arg("-t")
            .arg(&base)
            .output();
    }
}
