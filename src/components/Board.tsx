import { useEffect, useRef, useState } from "react";
import {
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { boardGet, cardCreate, cardMove, subscribeBoard } from "../lib/ipc";
import { useBoardStore } from "../store/board";
import Card from "./Card";
import CardDetail from "./CardDetail";

const COLUMN_ORDER = ["Backlog", "Doing", "Paused", "PR", "Done"];

export default function Board() {
  const columns = useBoardStore((s) => s.columns);
  const cardsByColumn = useBoardStore((s) => s.cardsByColumn);
  const setBoard = useBoardStore((s) => s.setBoard);
  const optimisticMove = useBoardStore((s) => s.optimisticMove);

  const [newTitle, setNewTitle] = useState("");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);

  useEffect(() => {
    boardGet("dev").then((res) => {
      setBoard(res.columns, res.cards);
    });
  }, [setBoard]);

  useEffect(() => {
    const unsub = subscribeBoard((payload) => {
      setBoard(payload.columns, payload.cards);
    });
    return () => {
      unsub.then((u) => u());
    };
  }, [setBoard]);

  const handleDropOnColumn = (columnId: string, draggedCardId: string) => {
    const currentCards = cardsByColumn[columnId] || [];
    const lastCard = currentCards[currentCards.length - 1];
    optimisticMove(draggedCardId, columnId, undefined, lastCard?.id);
    cardMove(draggedCardId, columnId, undefined, lastCard?.id).catch(() => {});
  };

  const handleDropBeforeCard = (
    draggedCardId: string,
    beforeCardId: string
  ) => {
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
    optimisticMove(draggedCardId, targetColumnId, beforeCardId, afterCardId);
    cardMove(draggedCardId, targetColumnId, beforeCardId, afterCardId).catch(() => {});
  };

  const handleCreateCard = () => {
    if (!newTitle.trim()) return;
    const backlog = columns.find((c) => c.name === "Backlog");
    if (!backlog) return;
    cardCreate("dev", backlog.id, newTitle.trim()).then(() => {
      setNewTitle("");
      boardGet("dev").then((res) => setBoard(res.columns, res.cards));
    });
  };

  const sortedColumns = [...columns].sort(
    (a, b) => COLUMN_ORDER.indexOf(a.name) - COLUMN_ORDER.indexOf(b.name)
  );

  const selectedCard = selectedCardId
    ? Object.values(cardsByColumn)
        .flat()
        .find((c) => c.id === selectedCardId) || null
    : null;

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
          />
        ))}
      </div>
      {selectedCardId && (
        <CardDetail
          card={selectedCard}
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
        {cards.map((card) => (
          <Card
            key={card.id}
            card={card}
            onDropBefore={onDropBeforeCard}
            onDoubleClick={() => onCardDoubleClick(card.id)}
          />
        ))}
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
              border: "1px solid #ccc",
              fontSize: 13,
            }}
          />
        </div>
      )}
    </div>
  );
}
