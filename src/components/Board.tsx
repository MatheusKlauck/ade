import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { ElementDropTargetEventBasePayload } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { boardGet, cardCreate, cardMove, subscribeBoard, terminalWrite } from "../lib/ipc";
import type { Card as CardType } from "../lib/ipc";
import type { TerminalPreset } from "../store/settings";
import { useBoardStore } from "../store/board";
import { useTerminalsStore } from "../store/terminals";
import { useWorkspacesStore } from "../store/workspaces";
import Card from "./Card";
import CardDetail from "./CardDetail";
import { ChevronIcon } from "./icons";

export const COLUMN_ORDER = ["Backlog", "Doing", "Paused", "PR", "Done"];

// Paginate cards per column so a long backlog can't make a column outgrow the
// board panel. One page = PAGE_SIZE cards; the card list also scrolls internally
// as a safety net if a single page is taller than the panel.
const PAGE_SIZE = 10;

interface BoardProps {
  workspaceId: string | null;
}

export default function Board({ workspaceId }: BoardProps) {
  const boards = useBoardStore((s) => s.boards);
  const setBoard = useBoardStore((s) => s.setBoard);
  const optimisticMove = useBoardStore((s) => s.optimisticMove);
  const removePane = useTerminalsStore((s) => s.removePane);

  const board = workspaceId ? boards[workspaceId] : undefined;
  const columns = board?.columns || [];
  const cardsByColumn = board?.cardsByColumn || {};

  const [newTitle, setNewTitle] = useState("");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  // Per-column current page (0-indexed); columns paginate at PAGE_SIZE cards.
  const [pages, setPages] = useState<Record<string, number>>({});

  // Subscribe to board events for the active workspace
  useEffect(() => {
    const unsub = subscribeBoard((payload) => {
      setBoard(payload.workspace_id, payload.columns, payload.cards);
    });
    return () => {
      unsub.then((u) => u());
    };
  }, [setBoard]);

  // Fetch board data when workspace changes
  useEffect(() => {
    if (!workspaceId) return;
    boardGet(workspaceId).then((res) => {
      setBoard(workspaceId, res.columns, res.cards);
    }).catch(() => {});
  }, [workspaceId, setBoard]);

  // Reset pagination when the workspace changes.
  useEffect(() => {
    setPages({});
  }, [workspaceId]);

  // DnD handlers MUST read the *latest* board state, not the render-time
  // `cardsByColumn`. The Card/Column drop targets register their `onDrop`
  // closures in a useEffect whose deps don't include these handlers, so a
  // handler that closed over a stale `cardsByColumn` (e.g. the empty `{}` from
  // first mount) would compute the wrong target and silently no-op. Reading
  // from the store via getState() keeps the handlers stable (only `workspaceId`
  // in deps) while always seeing fresh card data.
  const handleDropOnColumn = useCallback(
    (columnId: string, draggedCardId: string) => {
      if (!workspaceId) return;
      const board = useBoardStore.getState().boards[workspaceId];
      const currentCards = board?.cardsByColumn[columnId] || [];
      const lastCard = currentCards[currentCards.length - 1];
      // Dropping the card onto itself-as-last would be a no-op; skip it.
      if (lastCard?.id === draggedCardId) return;
      optimisticMove(workspaceId, draggedCardId, columnId, undefined, lastCard?.id);
      cardMove(draggedCardId, columnId, undefined, lastCard?.id).catch((e) => {
        // Surface backend failures instead of silently swallowing them — a
        // rejected card_move means the optimistic state and the DB diverge.
        console.error("card_move (column drop) failed", e);
      });
      // Close terminal if card was dropped into Done
      try {
        const targetCol = board?.columns.find((c) => c.id === columnId);
        if (targetCol?.name === "Done") {
          const allCards = Object.values(board?.cardsByColumn || {}).flat();
          const draggedCard = allCards.find((c) => c.id === draggedCardId);
          if (draggedCard?.terminal_window_id) {
            const pane = useTerminalsStore.getState().panes.find(
              (p) => p.windowId === draggedCard.terminal_window_id
            );
            if (pane) removePane(pane.paneId);
          }
        }
      } catch {
        // Non-fatal — don't break the drop
      }
    },
    [workspaceId, optimisticMove, removePane]
  );

  const handleDropBeforeCard = useCallback(
    (draggedCardId: string, beforeCardId: string) => {
      if (!workspaceId) return;
      const board = useBoardStore.getState().boards[workspaceId];
      const cards = board?.cardsByColumn || {};
      let targetColumnId = "";
      for (const colId of Object.keys(cards)) {
        if (cards[colId].some((c) => c.id === beforeCardId)) {
          targetColumnId = colId;
          break;
        }
      }
      if (!targetColumnId) return;
      const list = cards[targetColumnId];
      const idx = list.findIndex((c) => c.id === beforeCardId);
      const afterCardId = idx > 0 ? list[idx - 1].id : undefined;
      optimisticMove(workspaceId, draggedCardId, targetColumnId, beforeCardId, afterCardId);
      cardMove(draggedCardId, targetColumnId, beforeCardId, afterCardId).catch((e) => {
        console.error("card_move (reorder) failed", e);
      });
      // Close terminal if card was dropped into Done
      try {
        const targetCol = board?.columns.find((c) => c.id === targetColumnId);
        if (targetCol?.name === "Done") {
          const allCards = Object.values(cards).flat();
          const draggedCard = allCards.find((c) => c.id === draggedCardId);
          if (draggedCard?.terminal_window_id) {
            const pane = useTerminalsStore.getState().panes.find(
              (p) => p.windowId === draggedCard.terminal_window_id
            );
            if (pane) removePane(pane.paneId);
          }
        }
      } catch {
        // Non-fatal — don't break the drop
      }
    },
    [workspaceId, optimisticMove, removePane]
  );

  const handleCreateCard = () => {
    if (!workspaceId || !newTitle.trim()) return;
    const backlog = columns.find((c) => c.name === "Backlog");
    if (!backlog) return;
    cardCreate(workspaceId, backlog.id, newTitle.trim()).then(() => {
      setNewTitle("");
      boardGet(workspaceId).then((res) => setBoard(workspaceId, res.columns, res.cards));
    });
  };

  // Right-click → "Run with {preset}": launch this card's task with a chosen
  // preset instead of the workspace default.
  const handleRunWithPreset = useCallback(
    (card: CardType, preset: TerminalPreset) => {
      if (!workspaceId) return;
      const board = useBoardStore.getState().boards[workspaceId];
      if (!board) return;
      const doingCol = board.columns.find((c) => c.name === "Doing");
      if (!doingCol) return;

      // If the card already has a live terminal, run the preset's open commands
      // straight into it — moving it to Doing again only re-focuses (the backend
      // won't re-emit a launch event), so a direct write is the only way to act
      // on an already-running session.
      const pane = card.terminal_window_id
        ? useTerminalsStore
            .getState()
            .panes.find((p) => p.windowId === card.terminal_window_id)
        : undefined;
      if (pane) {
        const payload = preset.openCommands
          .map((c) => c.trim())
          .filter(Boolean)
          .join("\n");
        if (payload) terminalWrite(pane.paneId, payload + "\n").catch(() => {});
        return;
      }

      // Otherwise stash the preset and move the card to Doing — same path as a
      // drag-drop onto the column. The backend spawns the terminal and emits
      // terminal_focus(card_id), which App pairs with this pending preset to run
      // its open commands and inject the task prompt.
      useTerminalsStore.getState().setPendingPreset(card.id, preset);
      const doingCards = board.cardsByColumn[doingCol.id] || [];
      const lastCard = doingCards[doingCards.length - 1];
      optimisticMove(workspaceId, card.id, doingCol.id, undefined, lastCard?.id);
      cardMove(card.id, doingCol.id, undefined, lastCard?.id).catch((e) => {
        console.error("card_move (run with preset) failed", e);
      });
    },
    [workspaceId, optimisticMove]
  );

  const sortedColumns = [...columns].sort(
    (a, b) => COLUMN_ORDER.indexOf(a.name) - COLUMN_ORDER.indexOf(b.name)
  );

  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeWorkspace = workspaceId
    ? workspaces.find((w) => w.id === workspaceId) ?? null
    : null;

  const allCards = Object.values(cardsByColumn).flat();
  const selectedCard = selectedCardId
    ? allCards.find((c) => c.id === selectedCardId) || null
    : null;

  useEffect(() => {
    if (!selectedCardId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedCardId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedCardId]);

  if (!workspaceId) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "var(--space-sm)",
          padding: "var(--space-xl)",
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 18,
            fontWeight: 600,
            color: "var(--fg)",
          }}
        >
          No workspace selected
        </div>
        <div
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            lineHeight: 1.5,
            color: "var(--muted)",
            maxWidth: 320,
          }}
        >
          Pick a workspace from the tabs above to open its board and terminals.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          gap: "var(--space-md)",
          padding: "var(--space-lg)",
          overflowX: "auto",
          overflowY: "hidden",
          flex: 1,
          minHeight: 0,
        }}
      >
        {sortedColumns.map((col) => (
          <Column
            key={col.id}
            column={col}
            cards={cardsByColumn[col.id] || []}
            onDropCard={handleDropOnColumn}
            onDropBeforeCard={handleDropBeforeCard}
            showNewCardInput={col.name === "Backlog"}
            newTitle={newTitle}
            setNewTitle={setNewTitle}
            onCreateCard={handleCreateCard}
            onCardDoubleClick={setSelectedCardId}
            onRunWithPreset={handleRunWithPreset}
            page={pages[col.id] || 0}
            onPageChange={(p) =>
              setPages((prev) => ({ ...prev, [col.id]: p }))
            }
          />
        ))}
      </div>

      {selectedCardId && (
        <>
          <div
            onClick={() => setSelectedCardId(null)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.5)",
              zIndex: 200,
            }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              zIndex: 201,
              width: 560,
              maxWidth: "90vw",
              maxHeight: "85vh",
              overflowY: "auto",
              borderRadius: "var(--radius-md)",
              boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
            }}
          >
            <CardDetail
              card={selectedCard}
              workspace={activeWorkspace}
              onClose={() => setSelectedCardId(null)}
              onDeleted={() => setSelectedCardId(null)}
              modal
            />
          </div>
        </>
      )}
    </div>
  );
}

function Column({
  column,
  cards,
  onDropCard,
  onDropBeforeCard,
  showNewCardInput,
  newTitle,
  setNewTitle,
  onCreateCard,
  onCardDoubleClick,
  onRunWithPreset,
  page,
  onPageChange,
}: {
  column: { id: string; name: string };
  cards: import("../lib/ipc").Card[];
  onDropCard: (columnId: string, draggedCardId: string) => void;
  onDropBeforeCard: (draggedCardId: string, beforeCardId: string) => void;
  showNewCardInput: boolean;
  newTitle: string;
  setNewTitle: (s: string) => void;
  onCreateCard: () => void;
  onCardDoubleClick: (cardId: string) => void;
  onRunWithPreset: (card: CardType, preset: TerminalPreset) => void;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const dt = dropTargetForElements({
      element: el,
      getData: () => ({ columnId: column.id }),
      canDrop: (args) => {
        return args.source.data.cardId !== undefined;
      },
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: (args: ElementDropTargetEventBasePayload) => {
        setOver(false);
        // Nested drop targets: when a card is dropped on top of another card,
        // the pointer is over BOTH the inner Card drop target and this Column.
        // pragmatic-dnd fires onDrop on every target under the pointer, ordered
        // innermost-first in `location.current.dropTargets`. If the innermost
        // target is a Card (it carries a `cardId` in its data), the Card already
        // handled the reorder — the Column must NOT also append, or we'd issue
        // two conflicting card_move calls. Only act when WE are the innermost.
        const innermost = args.location.current.dropTargets[0];
        if (innermost && innermost.data.cardId !== undefined) {
          return;
        }
        const draggedCardId = args.source.data.cardId as string;
        if (draggedCardId) {
          onDropCard(column.id, draggedCardId);
        }
      },
    });
    return () => {
      dt();
    };
  }, [column.id, onDropCard]);

  // Paginate at PAGE_SIZE. Clamp the page in case the card list shrank (a move
  // or delete) since it was last set, so we never render an empty page past the
  // end and the controls stay in range.
  const pageCount = Math.max(1, Math.ceil(cards.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const start = safePage * PAGE_SIZE;
  const visibleCards = cards.slice(start, start + PAGE_SIZE);
  const hasPages = cards.length > PAGE_SIZE;

  const pageBtnStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    padding: 0,
    color: "var(--fg)",
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
  };

  return (
    <div
      ref={ref}
      style={{
        minWidth: 260,
        maxWidth: 320,
        minHeight: 0,
        background: over ? "var(--drop-target)" : "var(--surface-raised)",
        borderRadius: "var(--radius-lg)",
        padding: "var(--space-md)",
        display: "flex",
        flexDirection: "column",
        transition: "background var(--dur-instant) var(--ease-out-quart)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "var(--space-sm)",
          marginBottom: "var(--space-md)",
          flexShrink: 0,
        }}
      >
        <h3
          style={{
            margin: 0,
            fontFamily: "var(--font-sans)",
            fontSize: 14,
            fontWeight: 600,
            color: "var(--fg)",
          }}
        >
          {column.name}
        </h3>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--muted)",
          }}
        >
          {cards.length}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {cards.length === 0 && (
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              color: "var(--muted)",
              padding: "var(--space-sm) 0",
            }}
          >
            No cards
          </div>
        )}
        {visibleCards.map((card) => (
          <Card
            key={card.id}
            card={card}
            onDropBefore={onDropBeforeCard}
            onDoubleClick={() => onCardDoubleClick(card.id)}
            onRunWithPreset={onRunWithPreset}
          />
        ))}
      </div>
      {hasPages && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--space-sm)",
            marginTop: "var(--space-sm)",
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => onPageChange(safePage - 1)}
            disabled={safePage === 0}
            aria-label="Previous page"
            style={{
              ...pageBtnStyle,
              opacity: safePage === 0 ? 0.4 : 1,
              cursor: safePage === 0 ? "not-allowed" : "pointer",
            }}
          >
            <ChevronIcon size={14} style={{ transform: "rotate(90deg)" }} />
          </button>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--muted)",
            }}
          >
            {start + 1}–{Math.min(start + PAGE_SIZE, cards.length)} of {cards.length}
          </span>
          <button
            onClick={() => onPageChange(safePage + 1)}
            disabled={safePage >= pageCount - 1}
            aria-label="Next page"
            style={{
              ...pageBtnStyle,
              opacity: safePage >= pageCount - 1 ? 0.4 : 1,
              cursor: safePage >= pageCount - 1 ? "not-allowed" : "pointer",
            }}
          >
            <ChevronIcon size={14} style={{ transform: "rotate(-90deg)" }} />
          </button>
        </div>
      )}
      {showNewCardInput && (
        <div style={{ marginTop: "var(--space-sm)", flexShrink: 0 }}>
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCreateCard();
            }}
            placeholder="New card…"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "var(--space-sm) var(--space-md)",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--input-border)",
              background: "var(--input-bg)",
              color: "var(--fg)",
              fontFamily: "var(--font-sans)",
              fontSize: 13,
            }}
          />
        </div>
      )}
    </div>
  );
}