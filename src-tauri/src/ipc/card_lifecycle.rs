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
use tauri::Emitter;

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

/// Move to Doing: auto-launch a terminal for the card (§16 trigger).
/// Re-focuses an already-alive window, otherwise ensures the base tmux
/// session, spawns an issue/app window, optionally prepares a git branch,
/// and stores the window id on the card.
pub async fn on_moved_to_doing(
    db: &DbPool,
    app: &tauri::AppHandle,
    card: &Card,
) -> Result<(), AdeError> {
    // 2. Look up workspace for this card
    let ws = match crate::repo::workspace_by_id_opt(db, &card.workspace_id).await? {
        Some(ws) => ws,
        None => return Ok(()),
    };
    let slug: String = ws.slug;
    let root_path: String = ws.root_path;
    let github_owner: Option<String> = ws.github_owner;
    let github_repo: Option<String> = ws.github_repo;

    // 3. If card already has a terminal_window_id and it's alive, just re-focus it
    if let Some(ref wid) = card.terminal_window_id {
        let alive = {
            let slug = slug.clone();
            let wid = wid.clone();
            tokio::task::spawn_blocking(move || tmux::window_alive(&slug, &wid).unwrap_or(false))
                .await
                .unwrap_or(false)
        };
        if alive {
            let _ = app.emit(
                "evt:terminal_focus",
                serde_json::json!({
                    "workspace_id": card.workspace_id,
                    "window_id": wid,
                }),
            );
            return Ok(());
        }
    }

    // 4. Ensure base tmux session exists before creating windows.
    // All tmux/git work below runs in spawn_blocking: each call spawns a
    // subprocess (or does git I/O) that would otherwise block a tokio worker
    // and add visible latency to concurrent IPC (e.g. keystrokes).
    let ensure = {
        let slug = slug.clone();
        let root = root_path.clone();
        tokio::task::spawn_blocking(move || tmux::ensure_base_session(&slug, &root))
            .await
            .unwrap_or_else(|e| Err(AdeError::Tmux(e.to_string())))
    };
    if let Err(e) = ensure {
        emit_notify(
            app,
            "warn",
            "TMUX_SESSION_FAILED",
            &format!("failed to create tmux session: {}", e),
        );
        return Ok(());
    }

    // 5. Branch: GitHub-linked card vs local card
    let window_id: String = if let Some(issue_number) =
        card.github_issue_number.filter(|_| card.source == "github")
    {
        // GitHub-linked card
        let fallback = format!("issue-{}", issue_number);
        let winname = format!(
            "{}-{}",
            issue_number,
            gitlocal::slugify(&card.title, &fallback)
        );

        // Construct html_url
        let html_url = match (&github_owner, &github_repo) {
            (Some(owner), Some(repo)) => {
                format!(
                    "https://github.com/{}/{}/issues/{}",
                    owner, repo, issue_number
                )
            }
            _ => format!("https://github.com/issues/{}", issue_number),
        };

        // Create issue window with env vars
        let spawn_result = {
            let slug = slug.clone();
            let root = root_path.clone();
            let winname = winname.clone();
            let title = card.title.clone();
            let html_url = html_url.clone();
            tokio::task::spawn_blocking(move || {
                tmux::new_issue_window(
                    &slug,
                    &root,
                    &winname,
                    issue_number as u64,
                    &title,
                    &html_url,
                )
            })
            .await
            .unwrap_or_else(|e| Err(AdeError::Tmux(e.to_string())))
        };
        let wid = match spawn_result {
            Ok(w) => w,
            Err(e) => {
                emit_notify(
                    app,
                    "warn",
                    "TMUX_WINDOW_FAILED",
                    &format!("failed to create tmux issue window: {}", e),
                );
                return Ok(());
            }
        };

        // Auto-branch: check per-workspace setting (default true)
        let auto_branch: bool =
            crate::ipc::settings::workspace_setting_value(db, &card.workspace_id, "auto_branch")
                .await
                .map(|val| val != "false")
                .unwrap_or(true);

        if auto_branch {
            // The repo may live in a subdirectory of the workspace folder
            // (e.g. `test/` → `test/zkDash`); create the branch there, not
            // at the container root.
            let repo_path =
                gitlocal::find_repo_path(&root_path).unwrap_or_else(|| root_path.clone());
            let branch_result = tokio::task::spawn_blocking(move || {
                gitlocal::prepare_branch(&repo_path, issue_number as u64)
            })
            .await
            .unwrap_or_else(|e| Err(AdeError::Other(e.to_string())));
            match branch_result {
                Ok(gitlocal::BranchOutcome::ReusedExisting) => {
                    emit_notify(
                        app,
                        "info",
                        "BRANCH_EXISTS_REUSED",
                        &format!(
                            "branch issue-{} already exists, checking it out",
                            issue_number
                        ),
                    );
                }
                Ok(gitlocal::BranchOutcome::SkippedDirty) => {
                    emit_notify(
                        app,
                        "warn",
                        "BRANCH_DIRTY_WORKTREE",
                        &format!(
                            "worktree has uncommitted changes; branch issue-{} not created",
                            issue_number
                        ),
                    );
                }
                Ok(gitlocal::BranchOutcome::Created) => {
                    // No notification on success
                }
                Err(e) => {
                    emit_notify(
                        app,
                        "warn",
                        "BRANCH_FAILED",
                        &format!("failed to prepare branch issue-{}: {}", issue_number, e),
                    );
                }
            }
        }

        wid
    } else {
        // Local card: use new_app_window (no env vars, no issue window name)
        let id8 = &card.id[..card.id.len().min(8)];
        let fallback = format!("card-{}", id8);
        let winname = gitlocal::slugify(&card.title, &fallback);

        let spawn_result = {
            let slug = slug.clone();
            let root = root_path.clone();
            let winname = winname.clone();
            tokio::task::spawn_blocking(move || {
                let wid = tmux::new_app_window(&slug, &root)?;
                // Rename the window to the slugified name (new_app_window
                // doesn't accept a name); safe to target by window id.
                let _ = std::process::Command::new("tmux")
                    .arg("rename-window")
                    .arg("-t")
                    .arg(&wid)
                    .arg(&winname)
                    .output();
                Ok::<_, AdeError>(wid)
            })
            .await
            .unwrap_or_else(|e| Err(AdeError::Tmux(e.to_string())))
        };
        match spawn_result {
            Ok(w) => w,
            Err(e) => {
                emit_notify(
                    app,
                    "warn",
                    "TMUX_WINDOW_FAILED",
                    &format!("failed to create tmux app window: {}", e),
                );
                return Ok(());
            }
        }
    };

    // 6. Store terminal_window_id on the card
    sqlx::query("UPDATE card SET terminal_window_id = ? WHERE id = ?")
        .bind(&window_id)
        .bind(&card.id)
        .execute(db)
        .await
        .map_err(AdeError::Db)?;

    // 7. Emit terminal_focus event. This is a window freshly created for a card
    // just moved to Doing, so carry the card id: the frontend injects the task
    // title + description as the agent's prompt *only* for fresh launches. The
    // re-focus/reuse path above intentionally omits card_id so an already-running
    // task is never re-injected.
    let _ = app.emit(
        "evt:terminal_focus",
        serde_json::json!({
            "workspace_id": card.workspace_id,
            "window_id": window_id,
            "card_id": card.id,
        }),
    );

    // 8. Re-emit board (terminal_window_id changed)
    emit_board(app, &card.workspace_id, db).await?;

    Ok(())
}
