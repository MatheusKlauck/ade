// Terminal/git side effects of moving a card, extracted from `card_move` so
// the IPC handler keeps only the position math + outbox enqueue. Both fns
// preserve the original behavior exactly: a failed tmux step emits its notify
// and returns Ok(()) so `card_move` still returns the moved card.

use crate::db::DbPool;
use crate::error::AdeError;
use crate::models::Card;
use crate::notify::emit_notify;
use crate::pty::PtyRegistry;
use crate::{gitlocal, tmux};
use tauri::{Emitter, Manager};

use super::board::emit_board;

/// Move to Done: close the card's terminal. Mirrors the move-to-Doing launch
/// below — the backend owns the terminal lifecycle, so this fires for every
/// move path (drag or programmatic), not just the optimistic UI close in
/// Board.tsx. We kill the tmux window (so the agent process actually stops,
/// not just the viewer), drop any open PTY panes, clear the link, and tell
/// the frontend to remove the pane.
pub async fn on_moved_to_done(
    db: &DbPool,
    app: &tauri::AppHandle,
    pty: &PtyRegistry,
    card: &mut Card,
) -> Result<(), AdeError> {
    // Gestor card: the dispatch path (B) stores the worker window on the
    // agent_task, not card.terminal_window_id. Abort the task — that tears down
    // its worktree+window via cleanup — then re-pin the card to Done so the
    // human's drag wins over the aborted→Paused projection (D13).
    if let Some(t) = crate::repo::agent_tasks_for_workspace(db, &card.workspace_id)
        .await
        .unwrap_or_default()
        .into_iter()
        .find(|t| {
            t.card_id == card.id
                && !crate::gestor::fsm::TaskState::parse(&t.state)
                    .map(|s| s.is_terminal())
                    .unwrap_or(false)
        })
    {
        let _ = crate::gestor::fsm::transition(
            db,
            &t.id,
            crate::gestor::fsm::TaskState::Aborted,
            Some("moved to Done by user"),
        )
        .await;
        if let Ok(ws) = crate::repo::workspace_by_id(db, &card.workspace_id).await {
            let repo_path = gitlocal::find_repo_path(&ws.root_path).unwrap_or(ws.root_path);
            crate::gestor::dispatch::cleanup(db, &repo_path, &t.id).await;
        }
        let now = chrono::Utc::now().to_rfc3339();
        let _ =
            crate::repo::move_card_to_column(db, &card.id, &card.workspace_id, "Done", &now).await;
        emit_board(app, &card.workspace_id, db).await?;
        return Ok(());
    }

    let Some(window_id) = card.terminal_window_id.clone() else {
        return Ok(());
    };

    // Run the default preset's close commands into the still-live tmux
    // window before we tear it down. Best-effort: any failure (no default
    // preset, malformed JSON, tmux gone) just skips to the kill below.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PresetClose {
        id: String,
        #[serde(default)]
        close_commands: Vec<String>,
    }
    let default_id =
        crate::ipc::settings::workspace_setting_value(db, &card.workspace_id, "default_preset_id")
            .await
            .unwrap_or_default();
    if !default_id.is_empty() {
        let raw = crate::ipc::settings::workspace_setting_value(
            db,
            &card.workspace_id,
            "terminal_presets",
        )
        .await
        .unwrap_or_default();
        if let Ok(list) = serde_json::from_str::<Vec<PresetClose>>(&raw) {
            if let Some(p) = list.into_iter().find(|p| p.id == default_id) {
                let cmds: Vec<String> = p
                    .close_commands
                    .into_iter()
                    .map(|c| c.trim().to_string())
                    .filter(|c| !c.is_empty())
                    .collect();
                if !cmds.is_empty() {
                    // One tmux spawn for all commands, off the async
                    // runtime so it can't stall other IPC handlers.
                    let wid = window_id.clone();
                    let joined = cmds.join("; ");
                    let _ =
                        tokio::task::spawn_blocking(move || tmux::send_keys(&wid, &joined)).await;
                    // Give the commands a moment to start before the kill.
                    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                }
            }
        }
    }

    // Drop PTY panes for this window first (kills each viewer process).
    // Scope the lock so it's released before the awaits below.
    {
        if let Ok(mut reg) = pty.lock() {
            let keys: Vec<String> = reg
                .iter()
                .filter(|(_, p)| p.window_id == window_id && p.workspace_id == card.workspace_id)
                .map(|(k, _)| k.clone())
                .collect();
            for k in keys {
                if let Some(pane) = reg.remove(&k) {
                    let _ = pane.close();
                }
            }
        }
    }
    // Kill the tmux window itself. Best-effort: it may already be gone.
    {
        let wid = window_id.clone();
        let _ = tokio::task::spawn_blocking(move || tmux::kill_window(&wid)).await;
    }

    // Clear the link so a later move back to Doing spawns a fresh window.
    sqlx::query("UPDATE card SET terminal_window_id = NULL WHERE id = ?")
        .bind(&card.id)
        .execute(db)
        .await
        .map_err(AdeError::Db)?;
    card.terminal_window_id = None;

    // Tell the frontend to drop the pane from its UI.
    let _ = app.emit(
        "evt:terminal_close",
        serde_json::json!({
            "workspace_id": card.workspace_id,
            "window_id": window_id,
        }),
    );

    // Board changed (terminal_window_id cleared).
    emit_board(app, &card.workspace_id, db).await?;
    Ok(())
}

/// Move to Doing: the single dispatch surface (B/D11). The human dragging a card
/// to Doing runs the SAME enqueue+worker-launch the autonomous loop uses — the
/// gestor owns the card's FSM either way. The worker runs in an isolated worktree
/// with the protocol prompt injected by the backend; we focus its pane WITHOUT a
/// `card_id` so the frontend does not re-inject. Re-dragging an in-flight card
/// just re-focuses its window.
pub async fn on_moved_to_doing(
    db: &DbPool,
    app: &tauri::AppHandle,
    card: &Card,
) -> Result<(), AdeError> {
    let Ok(app_data_dir) = app.path().app_data_dir() else {
        emit_notify(
            app,
            "warn",
            "DISPATCH_FAILED",
            "could not resolve app data dir for dispatch",
        );
        return Ok(());
    };

    match crate::gestor::dispatch::enqueue_and_dispatch(
        db,
        &app_data_dir,
        &card.workspace_id,
        &card.id,
    )
    .await
    {
        Ok(Some(window_id)) => {
            let _ = app.emit(
                "evt:terminal_focus",
                serde_json::json!({
                    "workspace_id": card.workspace_id,
                    "window_id": window_id,
                }),
            );
        }
        Ok(None) => {}
        Err(e) => emit_notify(
            app,
            "warn",
            "DISPATCH_FAILED",
            &format!("failed to dispatch worker: {e}"),
        ),
    }

    // Board changed (card projected to Doing, terminal opened).
    emit_board(app, &card.workspace_id, db).await?;
    Ok(())
}
