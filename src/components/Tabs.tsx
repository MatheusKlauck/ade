import { type MouseEvent, useEffect, useRef, useState } from "react";
import { useWorkspacesStore } from "../store/workspaces";
import { useBoardStore } from "../store/board";
import { useTerminalsStore } from "../store/terminals";
import { boardGet, pickDirectory, type Workspace } from "../lib/ipc";
import ConfirmDialog from "./ConfirmDialog";
import { CheckIcon, CloseIcon, PlusIcon } from "./icons";

export default function Tabs() {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId);
  const terminalAlerts = useWorkspacesStore((s) => s.terminalAlerts);
  const busyWindows = useWorkspacesStore((s) => s.busyWindows);
  const terminalVeils = useWorkspacesStore((s) => s.terminalVeils);
  const claudeWaitingWindows = useWorkspacesStore((s) => s.claudeWaitingWindows);
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
  const [pendingClose, setPendingClose] = useState<{
    workspace: Workspace;
    paneCount: number;
  } | null>(null);

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

  const doClose = async (workspaceId: string) => {
    // Drop the workspace's terminal panes from the UI; the backend close kills
    // its tmux session, so any pane-close calls during unmount just no-op.
    removePanesForWorkspace(workspaceId);
    await closeWorkspace(workspaceId);
    // Keep the board store's active workspace in sync if we closed the active tab.
    setActiveWorkspace(useWorkspacesStore.getState().activeWorkspaceId);
  };

  const requestClose = (e: MouseEvent<HTMLButtonElement>, ws: Workspace) => {
    e.stopPropagation();
    // Closing kills the tmux session — irreversible only when something is
    // actually running. Guard that case; an empty workspace closes cheaply and
    // reopens by re-adding its folder, so don't nag for it.
    const paneCount = useTerminalsStore
      .getState()
      .getPanesForWorkspace(ws.id).length;
    if (paneCount > 0) {
      setPendingClose({ workspace: ws, paneCount });
    } else {
      doClose(ws.id);
    }
  };

  const handleAddWorkspace = async () => {
    if (creating) return;
    try {
      const selected = await pickDirectory();
      if (!selected) return;
      setCreating(true);
      try {
        await addWorkspace(selected);
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
    <>
      <div style={{ display: "flex", alignItems: "stretch", height: "100%", width: "100%" }}>
        {workspaces.map((ws) => {
          const active = ws.id === activeWorkspaceId;
          const alerts = terminalAlerts[ws.id];
          // Surface background activity on a non-focused tab whenever there's at
          // least one other workspace whose panes aren't currently visible (>1).
          const showEffects = !active && workspaces.length > 1;
          const busy = showEffects && (busyWindows[ws.id]?.size ?? 0) > 0;
          const waiting =
            showEffects && (claudeWaitingWindows[ws.id]?.size ?? 0) > 0;
          const veilKey = terminalVeils[ws.id] ?? 0;
          return (
            <div
              key={ws.id}
              role="presentation"
              className={
                [
                  busy && "ade-comet ade-term-visible ade-term-working",
                  waiting && "ade-term-waiting-tab",
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                height: "100%",
                flex: 1,
                minWidth: 0,
                borderBottom: active
                  ? "2px solid var(--accent)"
                  : "2px solid transparent",
                background: active ? "var(--surface-raised)" : "transparent",
                // The comet ring (::after, inset:0) and the veil sweep (200% child)
                // both need a positioned, clipping host. overflow:hidden keeps the
                // inside comet variant and the oversized veil within the pill.
                position: "relative",
                overflow: showEffects ? "hidden" : undefined,
                borderRadius: busy ? "var(--radius-sm)" : undefined,
              }}
            >
              {showEffects && veilKey > 0 && (
                <span className="ade-term-done-veil" key={veilKey} />
              )}
              <button
                type="button"
                onClick={() => handleTabClick(ws.id)}
                data-testid={`workspace-tab-${ws.slug}`}
                data-active={active}
                aria-current={active ? "page" : undefined}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  flex: 1,
                  minWidth: 0,
                  height: "100%",
                  paddingLeft: "var(--space-md)",
                  paddingRight: "var(--space-xs)",
                  border: "none",
                  background: "transparent",
                  color: active ? "var(--fg)" : "var(--muted)",
                  fontSize: 13,
                  fontWeight: active ? 600 : 400,
                  whiteSpace: "nowrap",
                  cursor: "pointer",
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
                {alerts && alerts.count > 0 && (
                  <span
                    title={alerts.messages.join("\n")}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                      flexShrink: 0,
                      height: 16,
                      padding: "0 5px",
                      fontSize: 10,
                      fontWeight: 600,
                      lineHeight: "16px",
                      borderRadius: "var(--radius-pill)",
                      background: "var(--accent)",
                      color: "var(--on-accent)",
                    }}
                  >
                    <CheckIcon size={10} />
                    {alerts.count > 99 ? "99+" : alerts.count}
                  </span>
                )}
              </button>
              <button
                className="ade-tab-close"
                onClick={(e) => requestClose(e, ws)}
                aria-label={`Close ${ws.name}`}
                title="Close workspace"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 18,
                  height: 18,
                  marginRight: "var(--space-xs)",
                  padding: 0,
                  flexShrink: 0,
                  border: "none",
                  background: "transparent",
                  borderRadius: "var(--radius-sm)",
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
          data-testid="workspace-add"
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
      {pendingClose && (
        <ConfirmDialog
          title={`Close ${pendingClose.workspace.name}?`}
          message={`${pendingClose.paneCount} terminal${pendingClose.paneCount > 1 ? "s" : ""
            } running here will be closed and the tmux session ended. This can't be undone.`}
          confirmLabel="Close workspace"
          cancelLabel="Keep open"
          destructive
          onConfirm={() => {
            const id = pendingClose.workspace.id;
            setPendingClose(null);
            doClose(id);
          }}
          onCancel={() => setPendingClose(null)}
        />
      )}
    </>
  );
}