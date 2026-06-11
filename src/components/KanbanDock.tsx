import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useBoardStore } from "../store/board";
import Board, { COLUMN_ORDER } from "./Board";
import { ChevronIcon } from "./icons";

interface KanbanDockProps {
  workspaceId: string | null;
}

// Spatial budget for the inline split. The board panel pushes the terminals up
// instead of overlaying them, so it must never starve the terminal area.
const COLLAPSED_H = 56; // the always-visible peek strip
const HANDLE_H = 8; // resize grip between terminals and board
const MIN_OPEN_H = 200; // smallest useful board panel (incl. strip + handle)
const TERMINAL_MIN_H = 220; // terminals always keep at least this much height
const DEFAULT_OPEN_H = 380;

function clampHeight(h: number): number {
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const max = Math.max(MIN_OPEN_H, vh - TERMINAL_MIN_H);
  return Math.min(max, Math.max(MIN_OPEN_H, h));
}

// Bottom dock: a slim peek strip (per-column counts + "Doing" chips) that
// expands into an inline board panel. Expanding pushes the terminal area up so
// board and terminals stay visible and usable at the same time — no modal scrim.
export default function KanbanDock({ workspaceId }: KanbanDockProps) {
  const boards = useBoardStore((s) => s.boards);
  const [open, setOpen] = useState(false);
  const [dockHeight, setDockHeight] = useState(DEFAULT_OPEN_H);
  const draggingRef = useRef(false);

  const board = workspaceId ? boards[workspaceId] : undefined;
  const columns = [...(board?.columns || [])].sort(
    (a, b) => COLUMN_ORDER.indexOf(a.name) - COLUMN_ORDER.indexOf(b.name)
  );
  const cardsByColumn = board?.cardsByColumn || {};

  const doing = columns.find((c) => c.name === "Doing");
  const doingCards = doing ? cardsByColumn[doing.id] || [] : [];

  // Esc collapses the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Re-clamp when the window shrinks so the panel never crushes the terminals.
  useEffect(() => {
    if (!open) return;
    const onResize = () => setDockHeight((h) => clampHeight(h));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = dockHeight;
    draggingRef.current = true;
    const move = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      // Dragging up grows the board (and shrinks the terminals).
      setDockHeight(clampHeight(startH + (startY - ev.clientY)));
    };
    const up = () => {
      draggingRef.current = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onHandleKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setDockHeight((h) => clampHeight(h + 40));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setDockHeight((h) => clampHeight(h - 40));
    }
  };

  const effHeight = open ? clampHeight(dockHeight) : COLLAPSED_H;

  return (
    <div
      style={{
        flexShrink: 0,
        height: effHeight,
        display: "flex",
        flexDirection: "column",
        background: "var(--panel)",
        overflow: "hidden",
      }}
    >
      {open && (
        <div
          className="ade-resize-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize board panel"
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={onHandleKey}
          style={{
            height: HANDLE_H,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "row-resize",
            borderTop: "1px solid var(--border)",
            touchAction: "none",
          }}
        >
          <span className="ade-resize-grip" aria-hidden />
        </div>
      )}

      {open && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            overflow: "auto",
            borderTop: "1px solid var(--border)",
          }}
        >
          <Board workspaceId={workspaceId} />
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? "Collapse board" : "Open board"}
        style={{
          height: COLLAPSED_H,
          flexShrink: 0,
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-md)",
          padding: "0 var(--space-md)",
          borderTop: "1px solid var(--border)",
          background: "var(--panel)",
          color: "var(--fg)",
          font: "inherit",
          textAlign: "left",
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
                  background: "var(--surface-raised)",
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
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            color: "var(--accent)",
            whiteSpace: "nowrap",
          }}
        >
          Board
          <ChevronIcon
            size={14}
            style={{
              transform: open ? "none" : "rotate(180deg)",
              transition: "transform var(--dur-state) var(--ease-out-quart)",
            }}
          />
        </span>
      </button>
    </div>
  );
}
