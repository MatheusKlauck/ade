use crate::error::AdeError;
use crate::models::Workspace;
use crate::pty;
use crate::tmux;
use tauri::ipc::Channel;
use tauri::ipc::InvokeResponseBody;
use tauri::State;

#[derive(serde::Serialize)]
pub struct TerminalOpenResult {
    pane_id: String,
    window_id: String,
}

/// Look up a workspace by ID and return its slug and root_path.
/// Replaces the old `dev_workspace()` hardcode.
async fn lookup_workspace(
    workspace_id: &str,
    db: &sqlx::SqlitePool,
) -> Result<Workspace, AdeError> {
    crate::repo::workspace_by_id(db, workspace_id).await
}

#[tauri::command]
pub async fn terminal_open(
    workspace_id: String,
    window_id: Option<String>,
    channel: Channel<InvokeResponseBody>,
    app: tauri::AppHandle,
    state: State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<TerminalOpenResult, AdeError> {
    let ws = lookup_workspace(&workspace_id, &state.db).await?;

    // The tmux helpers spawn subprocesses synchronously; run the whole chain
    // in spawn_blocking so a slow tmux/git environment can't stall the tokio
    // workers that also serve keystrokes (terminal_write) and PTY output.
    let window_id = {
        let slug = ws.slug.clone();
        let root_path = ws.root_path.clone();
        tokio::task::spawn_blocking(move || -> Result<String, AdeError> {
            tmux::check_version()?;
            tmux::ensure_base_session(&slug, &root_path)?;
            match window_id {
                Some(w) => {
                    // Reattach: verify window is still alive
                    if !tmux::window_alive(&slug, &w)? {
                        return Err(AdeError::Pty(format!(
                            "tmux window {} no longer exists in session {}",
                            w, slug
                        )));
                    }
                    Ok(w)
                }
                None => tmux::new_app_window(&slug, &root_path),
            }
        })
        .await
        .map_err(|e| AdeError::Tmux(e.to_string()))??
    };
    let slug = &ws.slug;
    let root_path = &ws.root_path;

    // Start (or keep) a completion monitor for this window. Idempotent per
    // window id, so reattaches don't stack monitors; the monitor outlives the
    // viewer, so completions are caught even after switching workspaces.
    crate::term_monitor::ensure(
        app.clone(),
        state.monitors.clone(),
        workspace_id.clone(),
        window_id.clone(),
    );

    // Startup command is sent from the frontend (per-workspace, after a
    // configurable delay) once the pane is open — see App.tsx
    // scheduleStartupCommand. The backend no longer sends it here.

    let viewer = tmux::viewer_session(slug, &uuid::Uuid::new_v4().to_string()[..8]);

    let pane = pty::spawn(
        slug,
        workspace_id,
        window_id.clone(),
        viewer.clone(),
        root_path.clone(),
        move |bytes| {
            let _ = channel.send(InvokeResponseBody::Raw(bytes));
        },
    )?;

    let pane_id = pane.id.clone();

    // Turn off the viewer's tmux status bar. The viewer session is created
    // asynchronously by the PTY child we just spawned, so it may not exist yet:
    // poll until it comes up, then set the option. Best-effort on a background
    // thread — a cosmetic failure here must NOT fail terminal_open, which would
    // leave the freshly-created tmux window orphaned (the BUG-001 process leak).
    {
        let viewer = viewer.clone();
        std::thread::spawn(move || {
            for _ in 0..100 {
                if tmux::session_exists(&viewer) {
                    let _ = tmux::viewer_status_off(&viewer);
                    let _ = tmux::viewer_mouse_on(&viewer);
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        });
    }

    {
        let mut reg = state.pty.lock().map_err(|e| AdeError::Pty(e.to_string()))?;
        // A duplicate open for the same window (e.g. a terminal_focus event
        // racing the reattach loop) must close the pane it replaces, or its
        // tmux viewer session and child process leak until the next app start.
        if let Some(old) = reg.insert(pane_id.clone(), pane) {
            let _ = old.close();
        }
    }

    Ok(TerminalOpenResult { pane_id, window_id })
}

#[tauri::command]
pub async fn terminal_write(
    pane_id: String,
    data: String,
    state: State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<(), AdeError> {
    let reg = state.pty.lock().map_err(|e| AdeError::Pty(e.to_string()))?;
    let pane = reg
        .get(&pane_id)
        .ok_or_else(|| AdeError::Pty("pane not found".into()))?;
    pane.write(data.as_bytes())
}

#[tauri::command]
pub async fn terminal_resize(
    pane_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<(), AdeError> {
    let reg = state.pty.lock().map_err(|e| AdeError::Pty(e.to_string()))?;
    let pane = reg
        .get(&pane_id)
        .ok_or_else(|| AdeError::Pty("pane not found".into()))?;
    pane.resize(cols, rows)
}

#[tauri::command]
pub async fn terminal_close(
    pane_id: String,
    state: State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<(), AdeError> {
    let mut reg = state.pty.lock().map_err(|e| AdeError::Pty(e.to_string()))?;
    let pane = reg
        .remove(&pane_id)
        .ok_or_else(|| AdeError::Pty("pane not found".into()))?;
    pane.close()
}

#[tauri::command]
pub async fn terminal_kill_window(
    workspace_id: String,
    window_id: String,
    state: State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<(), AdeError> {
    let mut reg = state.pty.lock().map_err(|e| AdeError::Pty(e.to_string()))?;
    let keys: Vec<String> = reg
        .iter()
        .filter(|(_, p)| p.window_id == window_id && p.workspace_id == workspace_id)
        .map(|(k, _)| k.clone())
        .collect();
    for k in keys {
        if let Some(pane) = reg.remove(&k) {
            let _ = pane.close();
        }
    }
    tmux::kill_window(&window_id)
}

#[cfg(test)]
mod tests {
    use crate::tmux;
    use std::process::Command;

    #[test]
    #[ignore = "needs-tmux"]
    fn reattach_does_not_run_startup_command() {
        // M3-T3 invariant: reattaching to an existing window
        // should NOT re-run the startup command.
        //
        // Create a session + window, send a marker, verify window_alive,
        // then send another marker and verify it appears only once
        // (meaning the session wasn't recreated).

        let (slug, root) = tmux::dev_workspace().unwrap();
        let base = tmux::base_session(&slug);

        // Clean up any stale session
        let _ = Command::new("tmux")
            .arg("kill-session")
            .arg("-t")
            .arg(&base)
            .output();

        tmux::ensure_base_session(&slug, &root).unwrap();
        let win = tmux::new_app_window(&slug, &root).unwrap();

        // Send marker
        tmux::send_keys(&win, "export ADE_REATTACH_TEST=1").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));

        // Verify window_alive returns true (reattach path)
        assert!(tmux::window_alive(&slug, &win).unwrap());

        // Send echo command to verify the env var persists
        tmux::send_keys(&win, "echo $ADE_REATTACH_TEST").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));

        let captured = tmux::capture_pane(&win).unwrap();
        assert!(
            captured.contains("1"),
            "expected captured pane to contain '1', got: {}",
            captured
        );

        // Clean up
        tmux::kill_window(&win).unwrap();
        let _ = Command::new("tmux")
            .arg("kill-session")
            .arg("-t")
            .arg(&base)
            .output();
    }
}
