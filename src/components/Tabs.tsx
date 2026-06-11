import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkspacesStore } from "../store/workspaces";
import { useBoardStore } from "../store/board";
import { boardGet } from "../lib/ipc";
import SyncIndicator from "./SyncIndicator";

export default function Tabs() {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId);
  const setActive = useWorkspacesStore((s) => s.setActive);
  const addWorkspace = useWorkspacesStore((s) => s.addWorkspace);
  const setBoard = useBoardStore((s) => s.setBoard);
  const setActiveWorkspace = useBoardStore((s) => s.setActiveWorkspace);

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

  const handleAddWorkspace = async () => {
    if (creating) return;
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;
    setCreating(true);
    try {
      await addWorkspace(selected as string);
    } finally {
      setCreating(false);
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
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 0,
        borderBottom: "1px solid #333",
        background: "#1a1a1a",
        padding: "0 8px",
      }}
    >
      {workspaces.map((ws) => (
        <button
          key={ws.id}
          onClick={() => handleTabClick(ws.id)}
          style={{
            padding: "8px 16px",
            border: "none",
            borderBottom: ws.id === activeWorkspaceId ? "2px solid #4a9eff" : "2px solid transparent",
            background: ws.id === activeWorkspaceId ? "#252525" : "transparent",
            color: ws.id === activeWorkspaceId ? "#fff" : "#999",
            cursor: "pointer",
            fontSize: 13,
            fontWeight: ws.id === activeWorkspaceId ? 600 : 400,
            whiteSpace: "nowrap",
          }}
        >
          {ws.name}
          {ws.github_owner ? (
            <span style={{ marginLeft: 6, fontSize: 10, color: "#8250df" }}>
              {ws.github_owner}/{ws.github_repo}
            </span>
          ) : (
            <span style={{ marginLeft: 6, fontSize: 10, color: "#6e7781" }}>
              local
            </span>
          )}
          <span style={{ marginLeft: 6 }}>
            <SyncIndicator workspaceId={ws.id} />
          </span>
        </button>
      ))}
      <button
        onClick={handleAddWorkspace}
        disabled={creating}
        style={{
          padding: "8px 16px",
          border: "none",
          borderBottom: "2px solid transparent",
          background: "transparent",
          color: creating ? "#555" : "#999",
          cursor: creating ? "not-allowed" : "pointer",
          fontSize: 16,
          fontWeight: 400,
          whiteSpace: "nowrap",
          opacity: creating ? 0.5 : 1,
          transition: "opacity 0.15s",
        }}
        title="Add workspace"
      >
        +
      </button>
    </div>
  );
}