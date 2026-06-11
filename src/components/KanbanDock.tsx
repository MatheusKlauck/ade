import { useEffect, useState } from "react";
import { useBoardStore } from "../store/board";
import Board, { COLUMN_ORDER } from "./Board";

interface KanbanDockProps {
  workspaceId: string | null;
}

// Slim bottom strip: per-column card counts + "Doing" card chips.
// Clicking it opens a drawer with the full Board over the terminal area.
export default function KanbanDock({ workspaceId }: KanbanDockProps) {
  const boards = useBoardStore((s) => s.boards);
  const [open, setOpen] = useState(false);

  const board = workspaceId ? boards[workspaceId] : undefined;
  const columns = [...(board?.columns || [])].sort(
    (a, b) => COLUMN_ORDER.indexOf(a.name) - COLUMN_ORDER.indexOf(b.name)
  );
  const cardsByColumn = board?.cardsByColumn || {};

  const doing = columns.find((c) => c.name === "Doing");
  const doingCards = doing ? cardsByColumn[doing.id] || [] : [];

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

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
          gap: 12,
          padding: "0 12px",
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
              fontSize: 11,
              color: "var(--muted)",
              whiteSpace: "nowrap",
            }}
          >
            {col.name}{" "}
            <strong style={{ color: "var(--fg)" }}>
              {(cardsByColumn[col.id] || []).length}
            </strong>
          </span>
        ))}
        <div
          style={{
            width: 1,
            alignSelf: "stretch",
            margin: "12px 0",
            background: "var(--border)",
          }}
        />
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            gap: 6,
            overflowX: "auto",
          }}
        >
          {doingCards.length === 0 ? (
            <span style={{ fontSize: 11, color: "var(--muted)" }}>
              Nothing in Doing
            </span>
          ) : (
            doingCards.map((c) => (
              <span
                key={c.id}
                style={{
                  fontSize: 11,
                  padding: "3px 10px",
                  borderRadius: 10,
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
            fontSize: 11,
            color: "var(--accent)",
            whiteSpace: "nowrap",
          }}
        >
          Board ▴
        </span>
      </div>
      {open && (
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            height: "60vh",
            zIndex: 1500,
            background: "var(--bg)",
            borderTop: "1px solid var(--border)",
            boxShadow: "0 -8px 24px rgba(0, 0, 0, 0.35)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "6px 12px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600 }}>Board</span>
            <button
              onClick={() => setOpen(false)}
              style={{
                padding: "4px 10px",
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: 4,
                color: "var(--muted)",
                cursor: "pointer",
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
      )}
    </>
  );
}
