import { useEffect, useState } from "react";
import { useBoardStore } from "../store/board";
import Board, { COLUMN_ORDER } from "./Board";

interface KanbanDockProps {
  workspaceId: string | null;
  forceOpen?: boolean;
  onCloseDrawer?: () => void;
}

// Slim bottom strip: per-column card counts + "Doing" card chips.
// Clicking it opens a drawer with the full Board over the terminal area.
export default function KanbanDock({ workspaceId, forceOpen, onCloseDrawer }: KanbanDockProps) {
  const boards = useBoardStore((s) => s.boards);
  const [open, setOpen] = useState(false);

  // External control (DevNav)
  const effectiveOpen = forceOpen ?? open;
  const handleClose = () => {
    setOpen(false);
    onCloseDrawer?.();
  };

  const board = workspaceId ? boards[workspaceId] : undefined;
  const columns = [...(board?.columns || [])].sort(
    (a, b) => COLUMN_ORDER.indexOf(a.name) - COLUMN_ORDER.indexOf(b.name)
  );
  const cardsByColumn = board?.cardsByColumn || {};

  const doing = columns.find((c) => c.name === "Doing");
  const doingCards = doing ? cardsByColumn[doing.id] || [] : [];

  useEffect(() => {
    if (!effectiveOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [effectiveOpen]);

  return (
    <>
      <div
        onClick={() => setOpen(true)}
        title="Open board"
        style={{
          height: 56,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: "var(--space-md)",
          padding: "0 var(--space-md)",
          borderTop: "1px solid var(--border)",
          background: "var(--panel)",
          cursor: "pointer",
          overflow: "hidden",
        }}
      >
        {columns.map((col) => (
          <span
            key={col.id}
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              color: "var(--muted)",
              whiteSpace: "nowrap",
            }}
          >
            {col.name}{" "}
            <strong
              style={{ color: "var(--fg)", fontFamily: "var(--font-mono)", fontWeight: 600 }}
            >
              {(cardsByColumn[col.id] || []).length}
            </strong>
          </span>
        ))}
        <div
          style={{
            width: 1,
            alignSelf: "stretch",
            margin: "var(--space-md) 0",
            background: "var(--border)",
          }}
        />
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            gap: "var(--space-sm)",
            overflowX: "auto",
          }}
        >
          {doingCards.length === 0 ? (
            <span
              style={{ fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--muted)" }}
            >
              Nothing in Doing
            </span>
          ) : (
            doingCards.map((c) => (
              <span
                key={c.id}
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 11,
                  color: "var(--fg)",
                  padding: "3px 10px",
                  borderRadius: "var(--radius-pill)",
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  whiteSpace: "nowrap",
                  maxWidth: 180,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {c.title}
              </span>
            ))
          )}
        </div>
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            color: "var(--accent)",
            whiteSpace: "nowrap",
          }}
        >
          Board ▴
        </span>
      </div>
      {effectiveOpen && (
        <>
          <div
            onClick={handleClose}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: "var(--z-modal-scrim)",
              background: "rgba(0, 0, 0, 0.6)",
            }}
          />
          <div
            style={{
              position: "fixed",
              left: 0,
              right: 0,
              bottom: 0,
              height: "60vh",
              zIndex: "var(--z-modal)",
              background: "var(--bg)",
              borderTop: "1px solid var(--border)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "var(--space-sm) var(--space-md)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--fg)",
                }}
              >
                Board
              </span>
              <button
                onClick={handleClose}
                style={{
                  padding: "var(--space-xs) 10px",
                  background: "transparent",
                  border: "1px solid var(--input-border)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--muted)",
                  cursor: "pointer",
                  fontFamily: "var(--font-sans)",
                  fontSize: 12,
                }}
              >
                ✕ Close
              </button>
            </div>
            <div
              style={{ flex: 1, minHeight: 0, display: "flex", overflow: "auto" }}
            >
              <Board workspaceId={workspaceId} />
            </div>
          </div>
        </>
      )}
    </>
  );
}
