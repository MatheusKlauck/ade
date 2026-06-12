import { useEffect, useRef, useState } from "react";
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { Card as CardType } from "../lib/ipc";
import { useSettingsStore, type TerminalPreset } from "../store/settings";

interface CardProps {
  card: CardType;
  onDropBefore?: (cardId: string, beforeCardId: string) => void;
  onDoubleClick?: () => void;
  // Launch this card's task with a chosen terminal preset (right-click → Run with…).
  onRunWithPreset?: (card: CardType, preset: TerminalPreset) => void;
}

// Matches the terminal header context menu (TerminalPane.tsx) so card and
// terminal menus read as one system.
const menuItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 10px",
  background: "transparent",
  border: "none",
  borderRadius: "var(--radius-sm)",
  color: "var(--fg)",
  cursor: "pointer",
  fontSize: 13,
  textAlign: "left",
};

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

export default function Card({
  card,
  onDropBefore,
  onDoubleClick,
  onRunWithPreset,
}: CardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState(false);
  // Position of the right-click "Run with…" menu, or null when closed.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const presets = useSettingsStore((s) => s.presets);

  // Dismiss the context menu on Escape (mirrors TerminalPane).
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  // The drop-target effect below only re-runs on [card.id, card.column_id],
  // so its onDrop closure would otherwise capture a stale `onDropBefore`.
  // Keep the latest handler in a ref so the registered onDrop always calls the
  // current one without forcing the drop target to tear down / re-register.
  const onDropBeforeRef = useRef(onDropBefore);
  onDropBeforeRef.current = onDropBefore;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const d = draggable({
      element: el,
      getInitialData: () => ({
        cardId: card.id,
        columnId: card.column_id,
        cardTitle: card.title,
        cardBodyPreview: card.body_preview,
      }),
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
        const handler = onDropBeforeRef.current;
        if (handler && draggedCardId !== card.id) {
          handler(draggedCardId, card.id);
        }
      },
    });

    return () => {
      d();
      dt();
    };
  }, [card.id, card.column_id]);

  const isGithub = card.source === "github";

  return (
    <>
    <div
      ref={ref}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      style={{
        padding: "var(--space-sm) var(--space-md)",
        marginBottom: "var(--space-sm)",
        background: dragging
          ? "var(--surface-input)"
          : over
          ? "var(--drop-target)"
          : "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        cursor: "grab",
        opacity: dragging ? 0.5 : 1,
        transition: "background var(--dur-instant) var(--ease-out-quart)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "var(--space-sm)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            fontWeight: 500,
            lineHeight: 1.4,
            color: "var(--fg)",
            wordBreak: "break-word",
            minWidth: 0,
          }}
        >
          {card.title}
        </span>
        <span
          style={{
            flexShrink: 0,
            fontSize: 10,
            fontWeight: 500,
            lineHeight: 1.2,
            padding: "2px 6px",
            borderRadius: "var(--radius-pill)",
            background: isGithub ? "var(--source-github)" : "var(--source-local)",
            color: "var(--on-accent)",
            fontFamily: "var(--font-mono)",
            whiteSpace: "nowrap",
          }}
        >
          {sourceBadge(card)}
        </span>
      </div>
      {card.assignee && (
        <div
          style={{
            marginTop: "var(--space-xs)",
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: "0.02em",
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {assigneeInitials(card.assignee)}
        </div>
      )}
    </div>

    {menu && (
      <>
        {/* Full-screen backdrop closes the menu on any click/right-click outside it. */}
        <div
          onClick={() => setMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(null);
          }}
          style={{ position: "fixed", inset: 0, zIndex: 1000 }}
        />
        <div
          style={{
            position: "fixed",
            top: menu.y,
            left: menu.x,
            zIndex: 1001,
            minWidth: 170,
            padding: 4,
            background: "var(--surface-raised)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            boxShadow: "0 4px 16px rgba(0, 0, 0, 0.35)",
          }}
        >
          <div
            style={{
              padding: "4px 10px 6px",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--muted)",
            }}
          >
            Run with
          </div>
          {presets.length === 0 ? (
            <div
              style={{
                padding: "6px 10px",
                fontSize: 13,
                color: "var(--muted)",
              }}
            >
              No presets — add one in Settings
            </div>
          ) : (
            presets.map((preset) => (
              <button
                key={preset.id}
                style={menuItemStyle}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--panel)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
                onClick={() => {
                  onRunWithPreset?.(card, preset);
                  setMenu(null);
                }}
              >
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {preset.name}
                </span>
              </button>
            ))
          )}
        </div>
      </>
    )}
    </>
  );
}
