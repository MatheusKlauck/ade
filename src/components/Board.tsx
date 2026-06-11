import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { ElementDropTargetEventBasePayload } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { boardGet, cardCreate, cardMove, subscribeBoard } from "../lib/ipc";
import { useBoardStore } from "../store/board";
import { useTerminalsStore } from "../store/terminals";
import { useWorkspacesStore } from "../store/workspaces";
import Card from "./Card";
import CardDetail from "./CardDetail";

export const COLUMN_ORDER = ["Backlog", "Doing", "Paused", "PR", "Done"];

// M6-T3: Cap rendered cards per column at 100; show "show more" for overflow.
const MAX_CARDS_PER_COLUMN = 100;

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
  // Track which columns have "show more" expanded
  const [expandedColumns, setExpandedColumns] = useState<Set<string>>(new Set());

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

  // Clear expanded columns when workspace changes
  useEffect(() => {
    setExpandedColumns(new Set());
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
    <div style={{ display: "flex", flex: 1 }}>
      <div
        style={{
          display: "flex",
          gap: "var(--space-md)",
          padding: "var(--space-lg)",
          overflowX: "auto",
          flex: 1,
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
            expanded={expandedColumns.has(col.id)}
            onToggleExpand={() => {
              setExpandedColumns((prev) => {
                const next = new Set(prev);
                if (next.has(col.id)) {
                  next.delete(col.id);
                } else {
                  next.add(col.id);
                }
                return next;
              });
            }}
          />
        ))}
      </div>
      {selectedCardId && (
        <CardDetail
          card={selectedCard}
          workspace={activeWorkspace}
          onClose={() => setSelectedCardId(null)}
          onDeleted={() => setSelectedCardId(null)}
        />
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
  expanded,
  onToggleExpand,
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
  expanded: boolean;
  onToggleExpand: () => void;
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

  // Cap rendered cards at MAX_CARDS_PER_COLUMN unless expanded
  const overflowCount = cards.length > MAX_CARDS_PER_COLUMN ? cards.length - MAX_CARDS_PER_COLUMN : 0;
  const visibleCards = expanded ? cards : cards.slice(0, MAX_CARDS_PER_COLUMN);

  const moreButtonStyle: CSSProperties = {
    width: "100%",
    padding: "var(--space-xs) var(--space-sm)",
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    fontWeight: 500,
    color: "var(--accent)",
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    cursor: "pointer",
    marginTop: "var(--space-xs)",
  };

  return (
    <div
      ref={ref}
      style={{
        minWidth: 260,
        maxWidth: 320,
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
      <div style={{ flex: 1 }}>
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
          />
        ))}
        {overflowCount > 0 && !expanded && (
          <button onClick={onToggleExpand} style={moreButtonStyle}>
            Show {overflowCount} more card{overflowCount !== 1 ? "s" : ""}
          </button>
        )}
        {expanded && cards.length > MAX_CARDS_PER_COLUMN && (
          <button onClick={onToggleExpand} style={moreButtonStyle}>
            Show fewer
          </button>
        )}
      </div>
      {showNewCardInput && (
        <div style={{ marginTop: "var(--space-sm)" }}>
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