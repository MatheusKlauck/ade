import { useState, useEffect } from "react";
import { subscribeNotify, boardGet, subscribeBoard, terminalOpen } from "./lib/ipc";
import TerminalPane from "./components/TerminalPane";
import Board from "./components/Board";
import Tabs from "./components/Tabs";
import { useTerminalsStore, type OpenTerminal } from "./store/terminals";
import { useWorkspacesStore } from "./store/workspaces";
import { useBoardStore } from "./store/board";
import Onboarding from "./components/Onboarding";

export default function App() {
  const [toast, setToast] = useState<{
    level: string;
    code: string;
    message: string;
  } | null>(null);

  const panes = useTerminalsStore((s) => s.panes);
  const addPane = useTerminalsStore((s) => s.addPane);
  const removePane = useTerminalsStore((s) => s.removePane);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const loadWorkspaces = useWorkspacesStore((s) => s.load);
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId);
  const setBoard = useBoardStore((s) => s.setBoard);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    subscribeNotify((payload) => {
      setToast(payload);
      setTimeout(() => setToast(null), 6000);
    }).then((u) => {
      unsub = u;
    });
    return () => {
      if (unsub) unsub();
    };
  }, []);

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

  // When active workspace changes, fetch its board (if not cached)
  useEffect(() => {
    if (!activeWorkspaceId) return;
    // Fetch board for active workspace
    boardGet(activeWorkspaceId).then((res) => {
      setBoard(activeWorkspaceId, res.columns, res.cards);
    }).catch(() => {});
  }, [activeWorkspaceId, setBoard]);

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

  // Show onboarding when no workspaces exist
  if (workspaces.length === 0) {
    return (
      <div style={{ position: "relative", minHeight: "100vh" }}>
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

  return (
    <div style={{ position: "relative", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
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
      <div style={{ flex: 1, display: "flex" }}>
        <Board workspaceId={activeWorkspaceId} />
      </div>
      <div style={{ padding: 8 }}>
        <button onClick={handleNewTerminal}>New terminal</button>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
          {panes
            .filter((p) => p.workspaceId === activeWorkspaceId)
            .map((pane) => (
              <div
                key={pane.paneId}
                style={{
                  width: "48%",
                  height: 300,
                  border: "1px solid #333",
                  borderRadius: 4,
                  overflow: "hidden",
                }}
              >
                <TerminalPane
                  pane={pane}
                  onRemove={() => handleRemove(pane.paneId)}
                />
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}