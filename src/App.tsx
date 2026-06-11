import { useState, useEffect, useRef, useCallback } from "react";
import {
  subscribeNotify,
  subscribeTerminalFocus,
  subscribeTerminalClose,
  boardGet,
  subscribeBoard,
  subscribeSync,
  subscribeTerminalAlert,
  type TerminalAlertPayload,
  terminalOpen,
  terminalWrite,
  cardDetail,
  uiStateGet,
  uiStateSet,
} from "./lib/ipc";
import AppBar from "./components/AppBar";
import Settings from "./components/Settings";
import TerminalArea from "./components/TerminalArea";
import KanbanDock from "./components/KanbanDock";
import Toast, { type ToastData } from "./components/Toast";
import { useTerminalsStore, type OpenTerminal } from "./store/terminals";
import { useWorkspacesStore } from "./store/workspaces";
import { useBoardStore } from "./store/board";
import { useNotificationsStore, type NotifyCode, type NotifyLevel } from "./store/notifications";
import { useSettingsStore } from "./store/settings";
import Onboarding from "./components/Onboarding";
import { contrastingTextColor } from "./lib/color";

/** Extra settle time (seconds) between the startup command and the task-prompt
 * injection, to give the program the startup command launches (e.g. an agent
 * CLI) a moment to be ready to receive input. */
const TASK_INJECT_SETTLE_SECS = 1;

const paneIsOpen = (paneId: string) =>
  useTerminalsStore.getState().panes.some((p) => p.paneId === paneId);

/**
 * Inject the task's title + full description into the pane as a submitted prompt.
 * Best-effort: a failed lookup or a closed pane simply skips injection.
 *
 * The text is wrapped in a bracketed-paste sequence so multi-line descriptions
 * are inserted as a single block — agent CLIs that honor bracketed paste (Claude
 * Code, readline, …) won't treat the internal newlines as Enter — and a trailing
 * CR then submits it, exactly like pasting a prompt and pressing Enter.
 */
async function injectTaskPrompt(paneId: string, cardId: string) {
  let detail;
  try {
    detail = await cardDetail(cardId);
  } catch {
    return;
  }
  if (!paneIsOpen(paneId)) return; // cardDetail may have awaited a network fetch

  const title = (detail.card.title ?? "").trim();
  const body = (detail.body ?? "").trim();
  // Strip ESC so a description can't break out of the paste / inject control seqs.
  const text = (body ? `${title}\n\n${body}` : title).replace(/\x1b/g, "");
  if (!text) return;

  const PASTE_START = "\x1b[200~";
  const PASTE_END = "\x1b[201~";
  terminalWrite(paneId, `${PASTE_START}${text}${PASTE_END}\r`).catch(() => {});
}

/**
 * Schedule the startup command for a newly-opened pane and, when `injectCardId`
 * is given (a card just moved to Doing), the task-prompt injection right after it.
 */
function scheduleStartupSequence(paneId: string, injectCardId?: string) {
  const { startupCommand, startupDelay } = useSettingsStore.getState();
  const delaySecs = Math.max(0, parseInt(startupDelay, 10) || 0);
  const hasStartup = !!(startupCommand && startupCommand.trim());

  if (hasStartup) {
    setTimeout(() => {
      if (!paneIsOpen(paneId)) return;
      const cmd = startupCommand.replace(/\n?$/, "\n");
      terminalWrite(paneId, cmd).catch(() => {});
    }, delaySecs * 1000);
  }

  if (injectCardId) {
    // Inject after the startup command has been sent (+ settle), or after a
    // short settle when there's no startup command.
    const injectAt = hasStartup
      ? delaySecs + TASK_INJECT_SETTLE_SECS
      : TASK_INJECT_SETTLE_SECS;
    setTimeout(() => {
      if (!paneIsOpen(paneId)) return;
      injectTaskPrompt(paneId, injectCardId);
    }, injectAt * 1000);
  }
}

/** Best-effort label for the terminal window from its linked card, else null. */
function titleForWindow(workspaceId: string, windowId: string): string | null {
  const board = useBoardStore.getState().boards[workspaceId];
  if (!board) return null;
  for (const colId of Object.keys(board.cardsByColumn)) {
    const card = board.cardsByColumn[colId].find(
      (c) => c.terminal_window_id === windowId
    );
    if (card) {
      return card.github_issue_number != null
        ? `#${card.github_issue_number} | ${card.title}`
        : card.title;
    }
  }
  return null;
}

/** Human-readable text for a terminal completion/bell/app alert. */
function formatTerminalAlert(p: TerminalAlertPayload): string {
  const title = titleForWindow(p.workspace_id, p.window_id);
  const who = title ? `${title}: ` : "";
  if (p.kind === "completed") {
    const failed = p.detail && p.detail !== "0";
    return `${who}comando concluído${failed ? ` (exit ${p.detail})` : ""}`;
  }
  if (p.kind === "bell") return `${who}bell`;
  return `${who}${p.detail || "notificação"}`;
}

export default function App() {
  const [toast, setToast] = useState<ToastData | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Stable so the Toast's auto-dismiss timer isn't reset on every App re-render.
  const dismissToast = useCallback(() => setToast(null), []);

  // Apply theme at startup using settings store
  const settingsLoad = useSettingsStore((s) => s.load);
  const settingsTheme = useSettingsStore((s) => s.theme);
  const settingsAccent = useSettingsStore((s) => s.accent);
  const settingsLoaded = useSettingsStore((s) => s.loaded);

  // Apply theme/accent from store whenever they change (and on initial load)
  useEffect(() => {
    if (settingsLoaded) {
      document.documentElement.setAttribute("data-theme", settingsTheme);
      document.documentElement.style.setProperty("--accent", settingsAccent);
      document.documentElement.style.setProperty(
        "--accent-ink",
        contrastingTextColor(settingsAccent)
      );
    }
  }, [settingsTheme, settingsAccent, settingsLoaded]);

  const panes = useTerminalsStore((s) => s.panes);
  const addPane = useTerminalsStore((s) => s.addPane);
  const removePane = useTerminalsStore((s) => s.removePane);
  const removePanesForWorkspace = useTerminalsStore(
    (s) => s.removePanesForWorkspace
  );
  const getPanesForWorkspace = useTerminalsStore(
    (s) => s.getPanesForWorkspace
  );
  const highlightedWindowId = useTerminalsStore((s) => s.highlightedWindowId);
  const focusWindow = useTerminalsStore((s) => s.focusWindow);
  const clearHighlight = useTerminalsStore((s) => s.clearHighlight);
  const loadLocked = useTerminalsStore((s) => s.loadLocked);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const loadWorkspaces = useWorkspacesStore((s) => s.load);
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId);
  const updateSyncStatus = useWorkspacesStore((s) => s.updateSyncStatus);
  const setBoard = useBoardStore((s) => s.setBoard);

  // Track previous workspace to detect tab switches
  const prevWorkspaceRef = useRef<string | null>(null);

  // Persist window IDs to ui_state for a workspace
  const persistWindowIds = useCallback(
    async (workspaceId: string) => {
      const workspacePanes = getPanesForWorkspace(workspaceId);
      const windowIds = workspacePanes.map((p) => p.windowId);
      await uiStateSet(
        `terminals:${workspaceId}`,
        JSON.stringify(windowIds)
      );
    },
    [getPanesForWorkspace]
  );

  const notifyPush = useNotificationsStore((s) => s.push);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    subscribeNotify((payload) => {
      setToast(payload);
      notifyPush(payload.level as NotifyLevel, payload.code as NotifyCode, payload.message);
    }).then((u) => {
      unsub = u;
    });
    return () => {
      if (unsub) unsub();
    };
  }, [notifyPush]);

  // Load workspaces on mount
  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  // Subscribe to board events (keyed by workspace_id)
  useEffect(() => {
    const unsub = subscribeBoard((payload) => {
      setBoard(payload.workspace_id, payload.columns, payload.cards);
    });
    return () => {
      unsub.then((u) => u());
    };
  }, [setBoard]);

  // Subscribe to sync events
  useEffect(() => {
    const unsub = subscribeSync((payload) => {
      updateSyncStatus(payload.workspace_id, payload.status, payload.last_sync);
    });
    return () => {
      unsub.then((u) => u());
    };
  }, [updateSyncStatus]);

  // Subscribe to terminal completion alerts (from the backend monitor). Notify
  // only for terminals you're NOT watching: skip the focused window while the
  // app window itself has focus. A short throttle collapses bursts (e.g. a
  // program ringing the bell repeatedly). Surviving alerts accumulate on the
  // originating workspace's pill.
  const alertThrottle = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const unsub = subscribeTerminalAlert((p) => {
      const { focusedWindowId } = useTerminalsStore.getState();
      if (p.window_id === focusedWindowId && document.hasFocus()) return;

      const key = `${p.window_id}:${p.kind}`;
      const now = Date.now();
      const last = alertThrottle.current.get(key) ?? 0;
      if (now - last < 700) return;
      alertThrottle.current.set(key, now);

      useWorkspacesStore
        .getState()
        .pushTerminalAlert(p.workspace_id, formatTerminalAlert(p));
    });
    return () => {
      unsub.then((u) => u());
    };
  }, []);

  // When the active workspace changes, load its persisted terminal lock state.
  useEffect(() => {
    if (activeWorkspaceId) loadLocked(activeWorkspaceId);
  }, [activeWorkspaceId, loadLocked]);

  // When active workspace changes, fetch its board (if not cached)
  useEffect(() => {
    if (!activeWorkspaceId) return;
    boardGet(activeWorkspaceId)
      .then((res) => {
        setBoard(activeWorkspaceId, res.columns, res.cards);
      })
      .catch(() => {});
  }, [activeWorkspaceId, setBoard]);

  // Settings are per-workspace: (re)load them whenever the active workspace
  // changes so theme/accent/startup command/token reflect the current one.
  useEffect(() => {
    if (activeWorkspaceId) settingsLoad(activeWorkspaceId);
  }, [activeWorkspaceId, settingsLoad]);

  // Subscribe to terminal focus events
  useEffect(() => {
    const unsub = subscribeTerminalFocus(async (payload) => {
      const { workspace_id, window_id } = payload;

      // Check if a pane for this window_id already exists
      const existing = panes.find((p) => p.windowId === window_id);
      if (existing) {
        // Pane exists — highlight it briefly
        focusWindow(window_id);
      } else {
        // No pane — reattach/create a new one
        try {
          const result = await terminalOpen(workspace_id, window_id);
          const pane: OpenTerminal = {
            paneId: result.paneId,
            windowId: result.windowId,
            workspaceId: workspace_id,
            channel: result.channel,
          };
          addPane(pane);
          scheduleStartupSequence(pane.paneId, payload.card_id);
          focusWindow(window_id);
        } catch {
          // Window may no longer exist
        }
      }
    });
    return () => {
      unsub.then((u) => u());
    };
  }, [panes, focusWindow, addPane]);

  // Subscribe to terminal close events (a card moved to Done). The backend has
  // already killed the tmux window; drop the matching pane from the UI.
  useEffect(() => {
    const unsub = subscribeTerminalClose(({ window_id }) => {
      const pane = useTerminalsStore
        .getState()
        .panes.find((p) => p.windowId === window_id);
      if (pane) removePane(pane.paneId);
    });
    return () => {
      unsub.then((u) => u());
    };
  }, [removePane]);

  // Handle workspace switch: persist old workspace's window IDs,
  // remove old panes from store (triggers unmount + terminalClose),
  // then reattach new workspace's terminals.
  useEffect(() => {
    const prevId = prevWorkspaceRef.current;

    if (!activeWorkspaceId) {
      prevWorkspaceRef.current = null;
      return;
    }

    // Persist old workspace's window IDs before switching
    if (prevId && prevId !== activeWorkspaceId) {
      const oldPanes = getPanesForWorkspace(prevId);
      const windowIds = oldPanes.map((p) => p.windowId);
      uiStateSet(`terminals:${prevId}`, JSON.stringify(windowIds)).catch(
        () => {}
      );
      // Remove panes from store — this triggers TerminalPane unmount
      // which calls terminalClose (kills viewer, tmux window survives)
      removePanesForWorkspace(prevId);
    }

    prevWorkspaceRef.current = activeWorkspaceId;

    // Reattach terminals for the new workspace
    async function reattach() {
      if (!activeWorkspaceId) return;
      // Check if we already have panes for this workspace (initial load)
      const existing = getPanesForWorkspace(activeWorkspaceId);
      if (existing.length > 0) return;

      try {
        const stored = await uiStateGet(
          `terminals:${activeWorkspaceId}`
        );
        if (!stored) return;
        const windowIds: string[] = JSON.parse(stored);
        let failed = 0;
        for (const wid of windowIds) {
          try {
            const result = await terminalOpen(activeWorkspaceId, wid);
            const pane: OpenTerminal = {
              paneId: result.paneId,
              windowId: result.windowId,
              workspaceId: activeWorkspaceId,
              channel: result.channel,
            };
            addPane(pane);
          } catch {
            // The tmux window is gone (died/killed since we last saw it). That's
            // silent data loss for the user, so surface it rather than swallow.
            failed++;
          }
        }
        if (failed > 0) {
          // Toast (not the history store): there's no CONTRACTS §7 code for
          // reattach loss, and that enum is exhaustive — so don't invent one.
          setToast({
            level: "warn",
            code: "TERMINALS_NOT_RESTORED",
            message: `${failed} terminal${failed > 1 ? "s" : ""} couldn't be restored — the tmux window${failed > 1 ? "s are" : " is"} gone.`,
          });
        }
        // Clear stored IDs after successful reattach (they'll be re-persisted on next switch)
        await uiStateSet(`terminals:${activeWorkspaceId}`, "[]").catch(
          () => {}
        );
      } catch {
        // No stored terminals, that's fine
      }
    }
    reattach();
  }, [activeWorkspaceId, addPane, getPanesForWorkspace, removePanesForWorkspace]);

  // Persist window IDs when panes change (for current workspace)
  useEffect(() => {
    if (activeWorkspaceId) {
      persistWindowIds(activeWorkspaceId);
    }
  }, [panes, activeWorkspaceId, persistWindowIds]);

  const handleNewTerminal = async () => {
    if (!activeWorkspaceId) return;
    try {
      const result = await terminalOpen(activeWorkspaceId);
      const pane: OpenTerminal = {
        paneId: result.paneId,
        windowId: result.windowId,
        workspaceId: activeWorkspaceId,
        channel: result.channel,
      };
      addPane(pane);
      scheduleStartupSequence(pane.paneId);
    } catch (e) {
      console.error(e);
    }
  };

  const handleRemove = (paneId: string) => {
    removePane(paneId);
  };

  const handleSettingsSaved = (login: string) => {
    setToast({ level: "info", code: "TOKEN_SAVED", message: `GitHub connected as ${login}` });
  };

  // Show onboarding when no workspaces exist
  if (workspaces.length === 0) {
    return (
      <div style={{ position: "relative", minHeight: "100vh", background: "var(--bg)", color: "var(--fg)" }}>
        {/* titleBarStyle: Overlay removes the native title bar, so the window
            needs a drag handle even on the onboarding screen. */}
        <div
          data-tauri-drag-region
          style={{ position: "fixed", top: 0, left: 0, right: 0, height: 40, zIndex: 1 }}
        />
        {toast && <Toast toast={toast} onDismiss={dismissToast} />}
        <Onboarding />
      </div>
    );
  }

  // Only show panes for the active workspace
  const activePanes = panes.filter(
    (p) => p.workspaceId === activeWorkspaceId
  );

  return (
    <div
      style={{
        position: "relative",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color: "var(--fg)",
      }}
    >
      {toast && <Toast toast={toast} onDismiss={dismissToast} />}
      <AppBar onOpenSettings={() => setShowSettings(true)} />
      <TerminalArea
        panes={activePanes}
        onNewTerminal={handleNewTerminal}
        onRemovePane={handleRemove}
        highlightedWindowId={highlightedWindowId}
        onHighlightDone={clearHighlight}
      />
      <KanbanDock workspaceId={activeWorkspaceId} />
      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          onSaved={handleSettingsSaved}
        />
      )}
    </div>
  );
}