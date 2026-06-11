import { useState, useEffect, useRef, useCallback } from "react";
import {
  subscribeNotify,
  subscribeTerminalFocus,
  boardGet,
  subscribeBoard,
  subscribeSync,
  terminalOpen,
  uiStateGet,
  uiStateSet,
} from "./lib/ipc";
import Tabs from "./components/Tabs";
import Settings from "./components/Settings";
import TerminalArea from "./components/TerminalArea";
import KanbanDock from "./components/KanbanDock";
import { useTerminalsStore, type OpenTerminal } from "./store/terminals";
import { useWorkspacesStore } from "./store/workspaces";
import { useBoardStore } from "./store/board";
import { useNotificationsStore, type NotifyCode, type NotifyLevel } from "./store/notifications";
import { useSettingsStore } from "./store/settings";
import Onboarding from "./components/Onboarding";

export default function App() {
  const [toast, setToast] = useState<{
    level: string;
    code: string;
    message: string;
  } | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Apply theme at startup using settings store
  const settingsLoad = useSettingsStore((s) => s.load);
  const settingsTheme = useSettingsStore((s) => s.theme);
  const settingsAccent = useSettingsStore((s) => s.accent);
  const settingsLoaded = useSettingsStore((s) => s.loaded);

  useEffect(() => {
    settingsLoad();
  }, [settingsLoad]);

  // Apply theme/accent from store whenever they change (and on initial load)
  useEffect(() => {
    if (settingsLoaded) {
      document.documentElement.setAttribute("data-theme", settingsTheme);
      document.documentElement.style.setProperty("--accent", settingsAccent);
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
      setTimeout(() => setToast(null), 6000);
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

  // When active workspace changes, fetch its board (if not cached)
  useEffect(() => {
    if (!activeWorkspaceId) return;
    boardGet(activeWorkspaceId)
      .then((res) => {
        setBoard(activeWorkspaceId, res.columns, res.cards);
      })
      .catch(() => {});
  }, [activeWorkspaceId, setBoard]);

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
            // Window no longer exists, skip it
          }
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
    } catch (e) {
      console.error(e);
    }
  };

  const handleRemove = (paneId: string) => {
    removePane(paneId);
  };

  const handleSettingsSaved = (login: string) => {
    setToast({ level: "info", code: "TOKEN_SAVED", message: `GitHub connected as ${login}` });
    setTimeout(() => setToast(null), 6000);
  };

  // Show onboarding when no workspaces exist
  if (workspaces.length === 0) {
    return (
      <div style={{ position: "relative", minHeight: "100vh", background: "var(--bg)", color: "var(--fg)" }}>
        {toast && (
          <div
            style={{
              position: "fixed",
              top: 16,
              right: 16,
              padding: "12px 16px",
              borderRadius: 6,
              background: toast.level === "error" ? "#c0392b" : "#2980b9",
              color: "#fff",
              zIndex: 9999,
            }}
          >
            <strong>{toast.code}</strong>: {toast.message}
          </div>
        )}
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
      {toast && (
        <div
          style={{
            position: "fixed",
            top: 16,
            right: 16,
            padding: "12px 16px",
            borderRadius: 6,
            background: toast.level === "error" ? "#c0392b" : "#2980b9",
            color: "#fff",
            zIndex: 9999,
          }}
        >
          <strong>{toast.code}</strong>: {toast.message}
        </div>
      )}
      <Tabs />
      <TerminalArea
        panes={activePanes}
        onNewTerminal={handleNewTerminal}
        onRemovePane={handleRemove}
        highlightedWindowId={highlightedWindowId}
        onHighlightDone={clearHighlight}
        onOpenSettings={() => setShowSettings(true)}
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