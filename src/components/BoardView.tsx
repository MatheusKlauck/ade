import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import TerminalArea from "./TerminalArea";
import KanbanFull from "./KanbanFull";
import type { OpenTerminal } from "../store/terminals";
import type { TerminalPreset } from "../store/settings";

interface BoardViewProps {
  workspaceId: string | null;
  panes: OpenTerminal[];
  onNewTerminal: (preset?: TerminalPreset) => void;
  onRemovePane: (paneId: string) => void;
  highlightedWindowId: string | null;
  onHighlightDone: () => void;
  // When false, the lower Kanban panel (and its seam) collapse, handing the full
  // area to the terminal stage. Toggled from the status bar.
  open: boolean;
}

// Vertical split budget: the board sits below the terminal stage and can be
// dragged taller/shorter, but neither half may starve the other.
const HANDLE_H = 8;
const MIN_BOARD_H = 140;
const MIN_TERMINAL_H = 200;
const DEFAULT_BOARD_H = 300;

function clampBoardHeight(h: number): number {
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  // Reserve the app bar (40) + status bar (28) + handle, then keep the terminal
  // stage above its minimum.
  const max = Math.max(MIN_BOARD_H, vh - 40 - 28 - HANDLE_H - MIN_TERMINAL_H);
  return Math.min(max, Math.max(MIN_BOARD_H, h));
}

/**
 * The board view body: the terminal stage on top, an always-visible Kanban board
 * below, separated by a draggable seam. The bottom status strip is rendered by
 * App so it can span the full window width (under the skills rail too).
 */
export default function BoardView({
  workspaceId,
  panes,
  onNewTerminal,
  onRemovePane,
  highlightedWindowId,
  onHighlightDone,
  open,
}: BoardViewProps) {
  const [boardHeight, setBoardHeight] = useState(DEFAULT_BOARD_H);
  const draggingRef = useRef(false);

  // Re-clamp on window resize so neither half is crushed.
  useEffect(() => {
    const onResize = () => setBoardHeight((h) => clampBoardHeight(h));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = boardHeight;
    draggingRef.current = true;
    const move = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      // Dragging up grows the board (shrinks the terminal stage).
      setBoardHeight(clampBoardHeight(startH + (startY - ev.clientY)));
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
      setBoardHeight((h) => clampBoardHeight(h + 40));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setBoardHeight((h) => clampBoardHeight(h - 40));
    }
  };

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Terminal stage — fills the space above the board. */}
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <TerminalArea
          variant="board"
          panes={panes}
          onNewTerminal={onNewTerminal}
          onRemovePane={onRemovePane}
          highlightedWindowId={highlightedWindowId}
          onHighlightDone={onHighlightDone}
        />
      </div>

      {open && (
        <>
          {/* Draggable seam between the terminal stage and the board. */}
          <div
            className="ade-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize board"
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

          {/* The board itself — a fixed (resizable) slice of the bottom. */}
          <div
            style={{
              height: clampBoardHeight(boardHeight),
              flexShrink: 0,
              display: "flex",
              minHeight: 0,
              borderTop: "1px solid var(--border)",
              background: "var(--bg)",
            }}
          >
            <KanbanFull workspaceId={workspaceId} />
          </div>
        </>
      )}
    </div>
  );
}
