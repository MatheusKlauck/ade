use crate::error::AdeError;
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

#[tauri::command]
pub async fn terminal_open(
    workspace_id: String,
    window_id: Option<String>,
    channel: Channel<InvokeResponseBody>,
    state: State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<TerminalOpenResult, AdeError> {
    tmux::check_version()?;

    let (slug, root_path) = tmux::dev_workspace()?;
    tmux::ensure_base_session(&slug, &root_path)?;

    let window_id = match window_id {
        Some(w) => w,
        None => tmux::new_app_window(&slug, &root_path)?,
    };

    let viewer = tmux::viewer_session(&slug, &uuid::Uuid::new_v4().to_string()[..8]);

    let pane = pty::spawn(
        &slug,
        workspace_id,
        window_id.clone(),
        viewer.clone(),
        root_path,
        move |bytes| {
            let _ = channel.send(InvokeResponseBody::Raw(bytes));
        },
    )?;

    let pane_id = pane.id.clone();

    tmux::viewer_status_off(&viewer)?;

    {
        let mut reg = state.pty.lock().map_err(|e| AdeError::Pty(e.to_string()))?;
        reg.insert(pane_id.clone(), pane);
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
    // Manual tests only for M1-T3 (requires running Tauri app)
}
