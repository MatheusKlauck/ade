import { useEffect, useRef, useState } from "react";
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { Card as CardType } from "../lib/ipc";
import { useSettingsStore, type TerminalPreset } from "../store/settings";
import { ContextMenu, menuItemStyle, useContextMenu } from "./ContextMenu";

interface CardProps {
  card: CardType;
  onDropBefore?: (cardId: string, beforeCardId: string) => void;
  onDoubleClick?: () => void;
  // Launch this card's task with a chosen terminal preset (right-click → Run with…).
  onRunWithPreset?: (card: CardType, preset: TerminalPreset) => void;
  /** True while this card is animating in (new to its column). */
  entering?: boolean;
  onEntered?: () => void;
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

export default function Card({
  card,
  onDropBefore,
  onDoubleClick,
  onRunWithPreset,
  entering,
  onEntered,
}: CardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState(false);
  // Right-click "Run with…" menu; Escape-to-dismiss is built into the hook.
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  const presets = useSettingsStore((s) => s.presets);

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
      className={entering ? "ade-card-enter" : undefined}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) onEntered?.();
      }}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY);
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
        // Picked-up: a touch smaller, reading as "lifted away". Drop target: an
        // accent inset ring (state, not resting decoration — stays flat at rest).
        transform: dragging ? "scale(0.98)" : "scale(1)",
        boxShadow: over ? "inset 0 0 0 1px var(--accent)" : "none",
        transition:
          "background var(--dur-instant) var(--ease-out-quart)," +
          " transform var(--dur-instant) var(--ease-out-quart)," +
          " box-shadow var(--dur-instant) var(--ease-out-quart)," +
          " opacity var(--dur-instant) var(--ease-out-quart)",
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
      <ContextMenu position={menu} onClose={closeMenu} minWidth={170}>
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
                  closeMenu();
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
      </ContextMenu>
    )}
    </>
  );
}
