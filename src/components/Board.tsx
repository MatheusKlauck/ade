import { useEffect, useRef, useState } from "react";
import {
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { boardGet, cardCreate, cardMove, subscribeBoard } from "../lib/ipc";
import { useBoardStore } from "../store/board";
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

  const handleDropOnColumn = (columnId: string, draggedCardId: string) => {
    if (!workspaceId) return;
    const currentCards = cardsByColumn[columnId] || [];
    const lastCard = currentCards[currentCards.length - 1];
    optimisticMove(workspaceId, draggedCardId, columnId, undefined, lastCard?.id);
    cardMove(draggedCardId, columnId, undefined, lastCard?.id).catch(() => {});
  };

  const handleDropBeforeCard = (
    draggedCardId: string,
    beforeCardId: string
  ) => {
    if (!workspaceId) return;
    let targetColumnId = "";
    for (const colId of Object.keys(cardsByColumn)) {
      if (cardsByColumn[colId].some((c) => c.id === beforeCardId)) {
        targetColumnId = colId;
        break;
      }
    }
    if (!targetColumnId) return;
    const list = cardsByColumn[targetColumnId];
    const idx = list.findIndex((c) => c.id === beforeCardId);
    const afterCardId = idx > 0 ? list[idx - 1].id : undefined;
    optimisticMove(workspaceId, draggedCardId, targetColumnId, beforeCardId, afterCardId);
    cardMove(draggedCardId, targetColumnId, beforeCardId, afterCardId).catch(() => {});
  };

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
    return <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#666" }}>Select a workspace</div>;
  }

  return (
    <div style={{ display: "flex", flex: 1 }}>
      <div style={{ display: "flex", gap: 12, padding: 16, overflowX: "auto", flex: 1 }}>
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
      onDrop: (args) => {
        setOver(false);
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

  return (
    <div
      ref={ref}
      style={{
        minWidth: 260,
        maxWidth: 320,
        background: over ? "#f0f6ff" : "#f5f5f5",
        borderRadius: 8,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        transition: "background 0.1s",
      }}
    >
      <h3 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600 }}>{column.name}</h3>
      <div style={{ flex: 1 }}>
        {visibleCards.map((card) => (
          <Card
            key={card.id}
            card={card}
            onDropBefore={onDropBeforeCard}
            onDoubleClick={() => onCardDoubleClick(card.id)}
          />
        ))}
        {overflowCount > 0 && !expanded && (
          <button
            onClick={onToggleExpand}
            style={{
              width: "100%",
              padding: "6px 8px",
              fontSize: 12,
              color: "var(--accent, #4a90d9)",
              background: "transparent",
              border: "1px dashed #ccc",
              borderRadius: 4,
              cursor: "pointer",
              marginTop: 4,
            }}
          >
            Show {overflowCount} more card{overflowCount !== 1 ? "s" : ""}
          </button>
        )}
        {expanded && cards.length > MAX_CARDS_PER_COLUMN && (
          <button
            onClick={onToggleExpand}
            style={{
              width: "100%",
              padding: "6px 8px",
              fontSize: 12,
              color: "var(--accent, #4a90d9)",
              background: "transparent",
              border: "1px dashed #ccc",
              borderRadius: 4,
              cursor: "pointer",
              marginTop: 4,
            }}
          >
            Show fewer
          </button>
        )}
      </div>
      {showNewCardInput && (
        <div style={{ marginTop: 8 }}>
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCreateCard();
            }}
            placeholder="New card..."
            style={{
              width: "100%",
              padding: "6px 8px",
              borderRadius: 4,
              border: "1px solid var(--border)",
              fontSize: 13,
            }}
          />
        </div>
      )}
    </div>
  );
}