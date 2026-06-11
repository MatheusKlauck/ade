import { useState, type CSSProperties } from "react";
import TerminalPane from "./TerminalPane";
import { useBoardStore } from "../store/board";
import { useTerminalsStore } from "../store/terminals";
import { ChevronIcon, LockIcon } from "./icons";
import type { OpenTerminal } from "../store/terminals";

interface TerminalAreaProps {
  panes: OpenTerminal[];
  onNewTerminal: () => void;
  onRemovePane: (paneId: string) => void;
  highlightedWindowId: string | null;
  onHighlightDone: () => void;
}

export default function TerminalArea({
  panes,
  onNewTerminal,
  onRemovePane,
  highlightedWindowId,
  onHighlightDone,
}: TerminalAreaProps) {
  const boards = useBoardStore((s) => s.boards);
  const lockedByWorkspace = useTerminalsStore((s) => s.lockedByWorkspace);
  const toggleLock = useTerminalsStore((s) => s.toggleLock);
  const [minimized, setMinimized] = useState<Record<string, boolean>>({});
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null);

  const isLocked = (pane: OpenTerminal): boolean =>
    (lockedByWorkspace[pane.workspaceId] ?? []).includes(pane.windowId);

  // Title from the linked card/issue, e.g. "#123 | Fix login". Falls back to
  // "Terminal" for ad-hoc shells with no linked card.
  const titleFor = (pane: OpenTerminal): string => {
    const board = boards[pane.workspaceId];
    if (board) {
      for (const colId of Object.keys(board.cardsByColumn)) {
        const card = board.cardsByColumn[colId].find(
          (c) => c.terminal_window_id === pane.windowId
        );
        if (card) {
          return card.github_issue_number != null
            ? `#${card.github_issue_number} | ${card.title}`
            : card.title;
        }
      }
    }
    return "Terminal";
  };

  // A maximized pane only counts while it is still open.
  const maxId =
    maximizedPaneId && panes.some((p) => p.paneId === maximizedPaneId)
      ? maximizedPaneId
      : null;

  const toggleMinimize = (paneId: string) => {
    setMinimized((m) => ({ ...m, [paneId]: !m[paneId] }));
    // A pane can't be both minimized and maximized.
    setMaximizedPaneId((id) => (id === paneId ? null : id));
  };

  const toggleMaximize = (paneId: string) => {
    setMinimized((m) => (m[paneId] ? { ...m, [paneId]: false } : m));
    setMaximizedPaneId((id) => (id === paneId ? null : paneId));
  };

  const restore = (paneId: string) => {
    setMinimized((m) => ({ ...m, [paneId]: false }));
  };

  const handleRemove = (paneId: string) => {
    // Locked terminals can't be closed. The header's close button is already
    // disabled when locked; this guards every other path into removal too.
    const pane = panes.find((p) => p.paneId === paneId);
    if (pane && isLocked(pane)) return;
    setMinimized((m) => {
      const next = { ...m };
      delete next[paneId];
      return next;
    });
    setMaximizedPaneId((id) => (id === paneId ? null : id));
    onRemovePane(paneId);
  };

  // Panes shown as chips in the minimized tray (hidden from the grid). When a
  // pane is maximized, the tray is suppressed to keep focus on it.
  const minimizedPanes = maxId ? [] : panes.filter((p) => minimized[p.paneId]);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--muted)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Terminals{panes.length > 0 ? ` · ${panes.length}` : ""}
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={onNewTerminal}
          style={{
            padding: "4px 12px",
            background: "var(--accent)",
            color: "var(--accent-ink)",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          New terminal
        </button>
      </div>
      {panes.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            color: "var(--muted)",
          }}
        >
          <span style={{ fontSize: 13 }}>No terminals open</span>
          <button
            onClick={onNewTerminal}
            style={{
              padding: "8px 20px",
              background: "var(--accent)",
              color: "var(--accent-ink)",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Open terminal
          </button>
        </div>
      ) : (
        <>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              position: "relative",
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
              gridAutoRows: "minmax(0, 1fr)",
              gap: 8,
              padding: 8,
              overflow: "auto",
            }}
          >
            {panes.map((pane) => {
              const isMax = maxId === pane.paneId;
              // When something is maximized, every other pane is hidden;
              // otherwise minimized panes are hidden (shown in the tray below).
              // Hidden panes stay mounted (display:none) so their PTY keeps
              // running and the terminal refits when shown again.
              const isHidden = maxId ? !isMax : !!minimized[pane.paneId];
              const locked = isLocked(pane);
              // Locked panes get an accented, ringed border so they stand out
              // from the freely-closeable ones.
              const borderColor = locked ? "var(--accent)" : "var(--border)";
              const lockedRing: CSSProperties = locked
                ? { boxShadow: "0 0 0 1px var(--accent)" }
                : {};
              const wrapperStyle: CSSProperties = isMax
                ? {
                    position: "absolute",
                    inset: 0,
                    zIndex: 20,
                    border: `1px solid ${borderColor}`,
                    ...lockedRing,
                    borderRadius: 4,
                    overflow: "hidden",
                    background: "var(--bg)",
                  }
                : isHidden
                ? { display: "none" }
                : {
                    minHeight: 200,
                    minWidth: 0,
                    border: `1px solid ${borderColor}`,
                    ...lockedRing,
                    borderRadius: 4,
                    overflow: "hidden",
                  };
              return (
                <div
                  key={pane.paneId}
                  id={`terminal-pane-${pane.windowId}`}
                  style={wrapperStyle}
                >
                  <TerminalPane
                    pane={pane}
                    title={titleFor(pane)}
                    maximized={isMax}
                    locked={locked}
                    onToggleLock={() => toggleLock(pane.workspaceId, pane.windowId)}
                    onRemove={() => handleRemove(pane.paneId)}
                    onToggleMinimize={() => toggleMinimize(pane.paneId)}
                    onToggleMaximize={() => toggleMaximize(pane.paneId)}
                    highlighted={highlightedWindowId === pane.windowId}
                    onHighlightDone={onHighlightDone}
                  />
                </div>
              );
            })}
          </div>
          {minimizedPanes.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                padding: "6px 8px",
                borderTop: "1px solid var(--border)",
                background: "var(--bg)",
              }}
            >
              {minimizedPanes.map((pane) => (
                <button
                  key={pane.paneId}
                  onClick={() => restore(pane.paneId)}
                  title="Restore terminal"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    maxWidth: 240,
                    padding: "4px 10px",
                    fontSize: 12,
                    color: "var(--muted)",
                    background: "var(--panel)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                  }}
                >
                  <ChevronIcon size={12} style={{ transform: "rotate(-90deg)" }} />
                  {isLocked(pane) && (
                    <LockIcon size={12} style={{ color: "var(--accent)" }} />
                  )}
                  <span
                    style={{ overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    {titleFor(pane)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
