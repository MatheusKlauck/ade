import { useState } from "react";
import { useWorkspacesStore } from "../store/workspaces";
import { useBoardStore } from "../store/board";
import { syncNow } from "../lib/ipc";
import { RefreshIcon } from "./icons";

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
  const [hovered, setHovered] = useState(false);

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
          color: "var(--accent-cyan)",
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
            border: "1.5px solid var(--accent-cyan)",
            borderTopColor: "transparent",
            borderRadius: "50%",
            animation: "ade-spin 0.6s linear infinite",
          }}
        />
        Syncing…
      </button>
    );
  }

  // All quiet — but make it a re-sync trigger. Hover reveals the affordance
  // (pill border + cyan tint + refresh glyph); clicking notifies every tracked
  // worker, which immediately flips this chip into the "Syncing…" branch above.
  const resyncAll = () => {
    for (const w of tracked) syncNow(w.id).catch(() => {});
  };
  return (
    <button
      onClick={resyncAll}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title="Re-sync all workspaces"
      aria-label="Re-sync all workspaces"
      style={{
        ...baseStyle,
        color: hovered ? "var(--accent-cyan)" : "var(--status-success)",
        background: "transparent",
        border: `1px solid ${hovered ? "var(--border)" : "transparent"}`,
        borderRadius: "var(--radius-pill)",
        padding: "3px 10px",
        cursor: "pointer",
        transition:
          "color var(--dur-state) var(--ease-out-quart), border-color var(--dur-state) var(--ease-out-quart)",
      }}
    >
      {/* Fixed-width leading slot so the ✓ → ⟳ swap never nudges the neighbours. */}
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 12,
          height: 12,
        }}
      >
        {hovered ? <RefreshIcon size={12} /> : "✓"}
      </span>
      All synced
    </button>
  );
}
