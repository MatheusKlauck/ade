import { useState, useEffect, useRef } from "react";
import type { Card as CardType } from "../lib/ipc";
import { cardUpdate, cardDelete } from "../lib/ipc";

interface CardDetailProps {
  card: CardType | null;
  onClose: () => void;
  onDeleted: () => void;
}

export default function CardDetail({ card, onClose, onDeleted }: CardDetailProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (card) {
      setTitle(card.title);
      setBody(card.body_preview || "");
    }
  }, [card?.id]);

  if (!card) {
    return (
      <div
        style={{
          width: 320,
          minWidth: 320,
          padding: 16,
          background: "#1e1e1e",
          color: "#ccc",
          borderLeft: "1px solid #333",
          fontSize: 14,
        }}
      >
        Select a card
      </div>
    );
  }

  const isGithub = card.source === "github";

  const handleTitleChange = (newTitle: string) => {
    setTitle(newTitle);
    cardUpdate(card.id, newTitle, undefined);
  };

  const handleBodyChange = (newBody: string) => {
    setBody(newBody);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      cardUpdate(card.id, undefined, newBody);
    }, 600);
  };

  const handleBodyBlur = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    cardUpdate(card.id, undefined, body);
  };

  const handleDelete = async () => {
    await cardDelete(card.id);
    onDeleted();
  };

  const formatDate = (s: string) => {
    const d = new Date(s);
    return d.toLocaleString();
  };

  return (
    <div
      style={{
        width: 320,
        minWidth: 320,
        padding: 16,
        background: "#1e1e1e",
        color: "#e0e0e0",
        borderLeft: "1px solid #333",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <input
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          style={{
            flex: 1,
            background: "#2a2a2a",
            border: "1px solid #444",
            borderRadius: 4,
            color: "#e0e0e0",
            padding: "6px 8px",
            fontSize: 14,
            fontWeight: 600,
          }}
        />
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "#999",
            fontSize: 18,
            cursor: "pointer",
            padding: "0 0 0 8px",
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>

      {/* Source badge */}
      <div style={{ marginBottom: 12 }}>
        <span
          style={{
            fontSize: 10,
            padding: "2px 8px",
            borderRadius: 10,
            background: isGithub ? "#8250df" : "#6e7781",
            color: "#fff",
          }}
        >
          {isGithub && card.github_issue_number
            ? `#${card.github_issue_number}`
            : "local"}
        </span>
      </div>

      {/* Body / GitHub notice */}
      {isGithub ? (
        <div
          style={{
            padding: 12,
            background: "#2a2a2a",
            borderRadius: 4,
            fontSize: 13,
            color: "#999",
            flex: 1,
          }}
        >
          Linked card — details in M5
        </div>
      ) : (
        <textarea
          value={body}
          onChange={(e) => handleBodyChange(e.target.value)}
          onBlur={handleBodyBlur}
          placeholder="Add a description..."
          style={{
            flex: 1,
            background: "#2a2a2a",
            border: "1px solid #444",
            borderRadius: 4,
            color: "#e0e0e0",
            padding: "8px",
            fontSize: 13,
            resize: "vertical",
            minHeight: 100,
            fontFamily: "inherit",
          }}
        />
      )}

      {/* Meta info */}
      <div
        style={{
          marginTop: 16,
          paddingTop: 12,
          borderTop: "1px solid #333",
          fontSize: 11,
          color: "#888",
        }}
      >
        <div style={{ marginBottom: 4 }}>
          Created: {formatDate(card.created_at)}
        </div>
        <div style={{ marginBottom: 8 }}>
          Updated: {formatDate(card.updated_at)}
        </div>
        {card.assignee && (
          <div style={{ marginBottom: 8 }}>
            Assignee: {card.assignee}
          </div>
        )}
      </div>

      {/* Delete button */}
      <button
        onClick={handleDelete}
        style={{
          marginTop: 8,
          padding: "8px 12px",
          background: "#c0392b",
          border: "none",
          borderRadius: 4,
          color: "#fff",
          fontSize: 13,
          cursor: "pointer",
        }}
      >
        Delete card
      </button>
    </div>
  );
}
