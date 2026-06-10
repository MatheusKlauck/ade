import { useEffect, useRef, useState } from "react";
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { Card as CardType } from "../lib/ipc";

interface CardProps {
  card: CardType;
  onDropBefore?: (cardId: string, beforeCardId: string) => void;
  onDoubleClick?: () => void;
}

function sourceBadge(card: CardType): string {
  if (card.source === "github" && card.github_issue_number) {
    return `#${card.github_issue_number}`;
  }
  return "local";
}

function assigneeInitials(assignee: string | null): string | null {
  if (!assignee) return null;
  return assignee.slice(0, 2).toUpperCase();
}

export default function Card({ card, onDropBefore, onDoubleClick }: CardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const d = draggable({
      element: el,
      getInitialData: () => ({ cardId: card.id, columnId: card.column_id }),
      onDragStart: () => setDragging(true),
      onDrop: () => setDragging(false),
    });

    const dt = dropTargetForElements({
      element: el,
      getData: () => ({ cardId: card.id, columnId: card.column_id }),
      canDrop: (args) => {
        const source = args.source;
        return source.data.cardId !== card.id;
      },
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: (args) => {
        setOver(false);
        const source = args.source;
        const draggedCardId = source.data.cardId as string;
        if (onDropBefore && draggedCardId !== card.id) {
          onDropBefore(draggedCardId, card.id);
        }
      },
    });

    return () => {
      d();
      dt();
    };
  }, [card.id, card.column_id]);

  return (
    <div
      ref={ref}
      onDoubleClick={onDoubleClick}
      style={{
        padding: "8px 12px",
        marginBottom: 8,
        background: dragging ? "#e8e8e8" : over ? "#d0e8ff" : "#fff",
        border: "1px solid #ddd",
        borderRadius: 4,
        cursor: "grab",
        opacity: dragging ? 0.5 : 1,
        transition: "background 0.1s",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13, fontWeight: 500, wordBreak: "break-word" }}>{card.title}</span>
        <span
          style={{
            fontSize: 10,
            padding: "2px 6px",
            borderRadius: 10,
            background: card.source === "github" ? "#8250df" : "#6e7781",
            color: "#fff",
            whiteSpace: "nowrap",
            marginLeft: 8,
          }}
        >
          {sourceBadge(card)}
        </span>
      </div>
      {card.assignee && (
        <div style={{ marginTop: 4, fontSize: 11, color: "#666" }}>
          {assigneeInitials(card.assignee)}
        </div>
      )}
    </div>
  );
}
