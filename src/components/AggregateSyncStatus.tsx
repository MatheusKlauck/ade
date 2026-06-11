import { useWorkspacesStore } from "../store/workspaces";
import { useBoardStore } from "../store/board";

// Global sync summary across ALL GitHub-backed workspaces, shown in the AppBar so
// a sync error/run in an inactive workspace is visible without switching tabs.
// Redundantly coded (color + glyph + label) per DESIGN.md. When something needs
// attention it's a button that focuses the offending workspace; when all is
// quiet it's a plain status. Local-only sessions have no sync state → renders nothing.
export default function AggregateSyncStatus() {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const syncStatus = useWorkspacesStore((s) => s.syncStatus);
  const setActive = useWorkspacesStore((s) => s.setActive);
  const setActiveWorkspace = useBoardStore((s) => s.setActiveWorkspace);

  const tracked = workspaces.filter((w) => w.github_owner);
  if (tracked.length === 0) return null;

  const errored = tracked.filter((w) => syncStatus[w.id]?.status === "error");
  const syncing = tracked.filter((w) => syncStatus[w.id]?.status === "syncing");

  const baseStyle = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    fontFamily: "var(--font-sans)",
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
  };

  if (errored.length > 0) {
    const target = errored[0].id;
    const focus = () => {
      setActive(target);
      setActiveWorkspace(target);
    };
    return (
      <button
        onClick={focus}
        title="Go to the workspace with a sync error"
        style={{
          ...baseStyle,
          color: "var(--status-error)",
          background: "transparent",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-pill)",
          padding: "3px 10px",
          cursor: "pointer",
        }}
      >
        <span aria-hidden>⚠</span>
        {errored.length} sync {errored.length > 1 ? "errors" : "error"}
      </button>
    );
  }

  if (syncing.length > 0) {
    const target = syncing[0].id;
    const focus = () => {
      setActive(target);
      setActiveWorkspace(target);
    };
    return (
      <button
        onClick={focus}
        title="Go to the syncing workspace"
        style={{
          ...baseStyle,
          color: "var(--accent)",
          background: "transparent",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-pill)",
          padding: "3px 10px",
          cursor: "pointer",
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            border: "1.5px solid var(--accent)",
            borderTopColor: "transparent",
            borderRadius: "50%",
            animation: "ade-spin 0.6s linear infinite",
          }}
        />
        Syncing…
      </button>
    );
  }

  return (
    <span style={{ ...baseStyle, color: "var(--muted)" }} title="All workspaces synced">
      <span aria-hidden>✓</span>
      All synced
    </span>
  );
}
