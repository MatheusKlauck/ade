import { useBoardStore } from "../store/board";
import { useTerminalsStore } from "../store/terminals";
import { useWorkspacesStore } from "../store/workspaces";
import { COL_DOING } from "../lib/columns";
import { BranchIcon, ChevronIcon, ColumnsIcon } from "./icons";

// Relative "Nm ago" / "Nh ago" formatter for the last-sync timestamp. Accepts
// the ISO string the backend stamps on sync events; returns "" when unparseable.
function syncedAgo(lastSync?: string): string {
  if (!lastSync) return "";
  const t = Date.parse(lastSync);
  if (Number.isNaN(t)) return "";
  const diff = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

interface SyncView {
  color: string;
  label: string;
}

function syncView(
  status: "idle" | "syncing" | "error" | undefined,
  lastSync: string | undefined,
  isTracked: boolean
): SyncView {
  if (!isTracked) return { color: "var(--source-local)", label: "local only" };
  if (status === "error") return { color: "var(--status-error)", label: "sync error" };
  if (status === "syncing") return { color: "var(--accent-cyan)", label: "syncing…" };
  const ago = syncedAgo(lastSync);
  return { color: "var(--status-success)", label: ago ? `synced ${ago}` : "synced" };
}

/**
 * The board view's footer: sync state, branch, and workspace on the left;
 * terminal/doing counts on the right — the mockup's bottom strip.
 */
export default function StatusBar({
  workspaceId,
  boardOpen,
  onToggleBoard,
}: {
  workspaceId: string | null;
  boardOpen: boolean;
  onToggleBoard: () => void;
}) {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const syncStatus = useWorkspacesStore((s) => s.syncStatus);
  const boards = useBoardStore((s) => s.boards);
  const panes = useTerminalsStore((s) => s.panes);

  const ws = workspaceId ? workspaces.find((w) => w.id === workspaceId) ?? null : null;
  const board = workspaceId ? boards[workspaceId] : undefined;

  const doingCol = board?.columns.find((c) => c.name === COL_DOING);
  const doingCount = doingCol ? (board?.cardsByColumn[doingCol.id] || []).length : 0;
  const terminalCount = workspaceId
    ? panes.filter((p) => p.workspaceId === workspaceId).length
    : 0;

  const entry = workspaceId ? syncStatus[workspaceId] : undefined;
  const isTracked = !!ws?.github_owner;
  const sync = syncView(entry?.status, entry?.lastSync, isTracked);

  const itemStyle = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontFamily: "var(--font-sans)" as const,
    fontSize: 11,
    color: "var(--muted)",
    whiteSpace: "nowrap" as const,
  };

  return (
    <div
      style={{
        flexShrink: 0,
        height: 28,
        display: "flex",
        alignItems: "center",
        gap: "var(--space-md)",
        padding: "0 var(--space-md)",
        borderTop: "1px solid var(--border)",
        background: "var(--panel)",
      }}
    >
      {/* Sync state — colour dot + label. */}
      <span style={itemStyle}>
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: sync.color,
          }}
        />
        <span style={{ color: "var(--fg)" }}>{sync.label}</span>
      </span>

      {/* Branch (best-effort: the workspace slug — no git branch over IPC yet). */}
      {ws?.slug && (
        <span style={itemStyle}>
          <BranchIcon size={11} />
          {ws.slug}
        </span>
      )}

      <span style={itemStyle}>workspace: {ws?.name ?? "—"}</span>

      <div style={{ flex: 1 }} />

      <span style={itemStyle}>
        {terminalCount} terminal{terminalCount === 1 ? "" : "s"} · {doingCount} doing
      </span>

      {/* Collapse / expand the board panel — same status-bar visual language as
          the items to its left. */}
      <button
        type="button"
        onClick={onToggleBoard}
        aria-expanded={boardOpen}
        aria-label={boardOpen ? "Hide board" : "Show board"}
        title={boardOpen ? "Hide board" : "Show board"}
        style={{
          ...itemStyle,
          padding: "2px 8px",
          height: 20,
          background: "transparent",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          color: "var(--muted)",
          cursor: "pointer",
        }}
      >
        <ColumnsIcon size={12} />
        <span>Board</span>
        <ChevronIcon
          size={12}
          style={{
            transform: boardOpen ? "none" : "rotate(180deg)",
            transition: "transform var(--dur-state) var(--ease-out-quart)",
          }}
        />
      </button>
    </div>
  );
}
