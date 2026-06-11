import { type MouseEvent, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkspacesStore } from "../store/workspaces";
import { useBoardStore } from "../store/board";
import { useTerminalsStore } from "../store/terminals";
import { boardGet } from "../lib/ipc";
import SyncIndicator from "./SyncIndicator";
import { CloseIcon, PlusIcon } from "./icons";

export default function Tabs() {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId);
  const setActive = useWorkspacesStore((s) => s.setActive);
  const addWorkspace = useWorkspacesStore((s) => s.addWorkspace);
  const closeWorkspace = useWorkspacesStore((s) => s.closeWorkspace);
  const setBoard = useBoardStore((s) => s.setBoard);
  const setActiveWorkspace = useBoardStore((s) => s.setActiveWorkspace);
  const removePanesForWorkspace = useTerminalsStore(
    (s) => s.removePanesForWorkspace
  );

  const loadedRef = useRef<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  const handleTabClick = (workspaceId: string) => {
    setActive(workspaceId);
    setActiveWorkspace(workspaceId);
    // If we haven't loaded this board yet, fetch it
    if (!loadedRef.current.has(workspaceId)) {
      boardGet(workspaceId).then((res) => {
        setBoard(workspaceId, res.columns, res.cards);
        loadedRef.current.add(workspaceId);
      });
    }
  };

  const handleCloseWorkspace = async (
    e: MouseEvent<HTMLButtonElement>,
    workspaceId: string
  ) => {
    e.stopPropagation();
    // Drop the workspace's terminal panes from the UI; the backend close kills
    // its tmux session, so any pane-close calls during unmount just no-op.
    removePanesForWorkspace(workspaceId);
    await closeWorkspace(workspaceId);
    // Keep the board store's active workspace in sync if we closed the active tab.
    setActiveWorkspace(useWorkspacesStore.getState().activeWorkspaceId);
  };

  const handleAddWorkspace = async () => {
    if (creating) return;
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected) return;
      setCreating(true);
      try {
        await addWorkspace(selected as string);
      } finally {
        setCreating(false);
      }
    } catch (e) {
      // Dialog plugin error (e.g. missing permission) — surface instead of
      // dropping it as an unhandled rejection that looks like a dead button.
      console.error("Failed to open folder picker:", e);
    }
  };

  // Load boards for all workspaces on mount
  useEffect(() => {
    async function loadAll() {
      for (const ws of workspaces) {
        if (!loadedRef.current.has(ws.id)) {
          try {
            const res = await boardGet(ws.id);
            setBoard(ws.id, res.columns, res.cards);
            loadedRef.current.add(ws.id);
          } catch {
            // Board may not exist yet for new workspaces
          }
        }
      }
    }
    if (workspaces.length > 0) {
      loadAll();
    }
  }, [workspaces, setBoard]);

  if (workspaces.length === 0) return null;

  return (
    <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
      {workspaces.map((ws) => {
        const active = ws.id === activeWorkspaceId;
        return (
          <div
            key={ws.id}
            style={{
              display: "inline-flex",
              alignItems: "center",
              height: "100%",
              maxWidth: 240,
              paddingLeft: "var(--space-md)",
              paddingRight: "var(--space-xs)",
              gap: "var(--space-xs)",
              borderBottom: active
                ? "2px solid var(--accent)"
                : "2px solid transparent",
              background: active ? "var(--surface-raised)" : "transparent",
            }}
          >
            <button
              onClick={() => handleTabClick(ws.id)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                minWidth: 0,
                padding: 0,
                border: "none",
                background: "transparent",
                color: active ? "var(--fg)" : "var(--muted)",
                fontSize: 13,
                fontWeight: active ? 600 : 400,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {ws.name}
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: ws.github_owner
                    ? "var(--source-github)"
                    : "var(--source-local)",
                  fontFamily: "var(--font-mono)",
                  flexShrink: 0,
                  maxWidth: 120,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {ws.github_owner ? `${ws.github_owner}/${ws.github_repo}` : "local"}
              </span>
              <SyncIndicator workspaceId={ws.id} />
            </button>
            <button
              onClick={(e) => handleCloseWorkspace(e, ws.id)}
              aria-label={`Close ${ws.name}`}
              title="Close workspace"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 18,
                height: 18,
                padding: 0,
                flexShrink: 0,
                border: "none",
                background: "transparent",
                borderRadius: "var(--radius-sm)",
                color: "var(--muted)",
                cursor: "pointer",
              }}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        );
      })}
      <button
        onClick={handleAddWorkspace}
        disabled={creating}
        aria-label="Add workspace"
        title="Add workspace"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          alignSelf: "center",
          width: 30,
          height: 28,
          marginLeft: "var(--space-xs)",
          padding: 0,
          border: "none",
          background: "transparent",
          color: "var(--muted)",
          cursor: creating ? "not-allowed" : "pointer",
          opacity: creating ? 0.5 : 1,
        }}
      >
        <PlusIcon size={16} />
      </button>
    </div>
  );
}