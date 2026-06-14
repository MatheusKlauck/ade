import { useEffect, useRef, useState } from "react";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { Card as CardType, BoardColumn } from "../lib/ipc";
import type { TerminalPreset } from "../store/settings";
import { useSettingsStore } from "../store/settings";
import { useContextMenu } from "./ContextMenu";
import CardContextMenu from "./CardContextMenu";
import type { Attention } from "../store/ledger";
import {
  COL_BACKLOG,
  COL_DOING,
  COL_DONE,
  COL_PAUSED,
  COL_PR,
} from "../lib/columns";

/*
 * One dense hairline row in the ledger — an issue (or an ad-hoc shell) rendered
 * as a single line:
 *
 *   #42 ● fix orphaned tmux   ⎇ issue-42  [Doing]  input needed · 2m  ● waiting you  12m
 *   └#  └dot └title           └branch     └badge   └activity          └stat          └age
 *
 * Clicking a row with a live terminal expands it inline (the terminal panel
 * renders below, owned by the Ledger so the pane is never unmounted). The row
 * is draggable with the same payload the old Kanban Card carried so dropping it
 * on a terminal still injects the task. The badge moves the card between
 * columns; right-click runs a preset. Ad-hoc shells skip all card affordances.
 */

export interface LedgerRowProps {
  card: CardType;
  columnName: string;
  attention?: Attention;
  hasPane: boolean;
  isExpanded: boolean;
  isAdHocShell?: boolean;
  selected?: boolean; // keyboard cursor is on this row
  columns: BoardColumn[];
  onToggleExpand: () => void;
  onOpenDetail: (cardId: string) => void;
  onMove: (card: CardType, toColumnId: string) => void;
  onRunWithPreset: (card: CardType, preset: TerminalPreset) => void;
  onDelete: (card: CardType) => void;
  // Drop another card onto THIS row's terminal (works even when collapsed,
  // since the row itself — not the hidden pane — is the drop target).
  onCardDrop?: (
    dragged: {
      cardId: string;
      columnId: string;
      cardTitle: string;
      cardBodyPreview: string | null;
    },
    targetWindowId: string
  ) => void;
}

const HAIR_GRID = "48px 14px 1fr 104px 84px 1.4fr 104px 48px";

function badgeStyle(columnName: string): { color: string; background: string } {
  switch (columnName) {
    case COL_DOING:
      return {
        color: "var(--accent)",
        background: "color-mix(in srgb, var(--accent) 14%, transparent)",
      };
    case COL_PR:
      return {
        color: "var(--source-github)",
        background: "color-mix(in srgb, var(--source-github) 14%, transparent)",
      };
    case COL_PAUSED:
      return {
        color: "var(--status-warning)",
        background: "color-mix(in srgb, var(--status-warning) 14%, transparent)",
      };
    case COL_DONE:
      return {
        color: "var(--status-success)",
        background: "color-mix(in srgb, var(--status-success) 14%, transparent)",
      };
    default: // Backlog
      return { color: "var(--muted)", background: "var(--surface-input)" };
  }
}

/** The left status bullet: accent when waiting on you, green when live,
 * amber when paused, muted otherwise. */
function leftDotColor(
  attention: Attention | undefined,
  hasPane: boolean,
  columnName: string
): string {
  if (attention?.kind === "input") return "var(--accent)";
  if (attention?.kind === "failed") return "var(--status-error)";
  if (hasPane) return "var(--status-success)";
  if (columnName === COL_PAUSED) return "var(--status-warning)";
  return "var(--muted)";
}

function formatAge(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h`;
  const d = h / 24;
  if (d < 7) return `${Math.floor(d)}d`;
  return `${Math.floor(d / 7)}w`;
}

function formatSince(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

function activityText(
  columnName: string,
  attention: Attention | undefined,
  hasPane: boolean,
  isAdHocShell: boolean
): { text: string; dim: boolean } {
  if (attention?.kind === "input")
    return { text: `input needed · ${formatSince(attention.since)}`, dim: false };
  if (attention?.kind === "failed")
    return {
      text: `failed${attention.detail ? ` · exit ${attention.detail}` : ""}`,
      dim: false,
    };
  if (attention?.kind === "done")
    return { text: `finished · ${formatSince(attention.since)}`, dim: false };
  if (isAdHocShell) return { text: "shell session", dim: true };
  if (hasPane) return { text: "running", dim: true };
  if (columnName === COL_PAUSED) return { text: "window detached", dim: true };
  if (columnName === COL_BACKLOG)
    return { text: "no terminal — ▸ Doing to start", dim: true };
  return { text: "—", dim: true };
}

function statChip(
  columnName: string,
  attention: Attention | undefined,
  hasPane: boolean
): { dot: string; label: string; color: string } | null {
  if (attention?.kind === "input")
    return { dot: "var(--accent)", label: "waiting you", color: "var(--accent)" };
  if (attention?.kind === "failed")
    return { dot: "var(--status-error)", label: "failed", color: "var(--status-error)" };
  if (attention?.kind === "done")
    return { dot: "var(--status-success)", label: "done", color: "var(--muted)" };
  if (hasPane)
    return { dot: "var(--status-success)", label: "running", color: "var(--muted)" };
  if (columnName === COL_PR)
    return { dot: "var(--source-github)", label: "PR", color: "var(--muted)" };
  if (columnName === COL_PAUSED)
    return { dot: "var(--status-warning)", label: "detached", color: "var(--muted)" };
  return null;
}

export default function LedgerRow({
  card,
  columnName,
  attention,
  hasPane,
  isExpanded,
  isAdHocShell = false,
  selected = false,
  columns,
  onToggleExpand,
  onOpenDetail,
  onMove,
  onRunWithPreset,
  onDelete,
  onCardDrop,
}: LedgerRowProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const presets = useSettingsStore((s) => s.presets);
  // Disambiguate a single click (expand) from a double click (open detail).
  const clickTimer = useRef<number | null>(null);

  const cardMenu = useContextMenu();

  useEffect(() => {
    const el = ref.current;
    if (!el || isAdHocShell) return; // shells carry no card payload
    return draggable({
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
  }, [card.id, card.column_id, card.title, card.body_preview, isAdHocShell]);

  // Drop target: dropping another card here injects its task into THIS row's
  // terminal (and starts the dropped card). Registered on the row, which is
  // always laid out, so it works even when the terminal is collapsed.
  useEffect(() => {
    const el = ref.current;
    const wid = card.terminal_window_id;
    if (!el || !hasPane || !wid || !onCardDrop) return;
    return dropTargetForElements({
      element: el,
      canDrop: ({ source }) =>
        typeof source.data.cardTitle === "string" &&
        source.data.cardId !== card.id,
      onDragEnter: () => setDropOver(true),
      onDragLeave: () => setDropOver(false),
      onDrop: ({ source }) => {
        setDropOver(false);
        onCardDrop(
          {
            cardId: source.data.cardId as string,
            columnId: source.data.columnId as string,
            cardTitle: source.data.cardTitle as string,
            cardBodyPreview: (source.data.cardBodyPreview ?? null) as
              | string
              | null,
          },
          wid
        );
      },
    });
  }, [hasPane, onCardDrop, card.terminal_window_id, card.id]);

  useEffect(
    () => () => {
      if (clickTimer.current != null) window.clearTimeout(clickTimer.current);
    },
    []
  );

  const num = card.github_issue_number != null ? `#${card.github_issue_number}` : "—";
  const branch =
    card.github_issue_number != null ? `⎇ issue-${card.github_issue_number}` : "—";
  const badge = badgeStyle(columnName);
  const activity = activityText(columnName, attention, hasPane, isAdHocShell);
  const chip = statChip(columnName, attention, hasPane);
  const dotColor = leftDotColor(attention, hasPane, columnName);

  const handleClick = () => {
    if (!hasPane) return; // nothing to expand
    if (clickTimer.current != null) return; // a second click → let dblclick win
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null;
      onToggleExpand();
    }, 200);
  };
  const handleDoubleClick = () => {
    if (clickTimer.current != null) {
      window.clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    if (!isAdHocShell) onOpenDetail(card.id);
  };

  return (
    <>
      <div
        ref={ref}
        data-ledger-row={card.terminal_window_id ?? card.id}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={(e) => {
          if (isAdHocShell) return;
          e.preventDefault();
          cardMenu.open(e.clientX, e.clientY);
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={
          isAdHocShell
            ? "Click to expand the terminal"
            : "Click to expand · double-click to open · drag onto a terminal to run"
        }
        style={{
          display: "grid",
          gridTemplateColumns: HAIR_GRID,
          gap: "0 12px",
          alignItems: "center",
          padding: "5px 16px",
          borderBottom: "1px solid var(--border)",
          borderLeft: isExpanded
            ? "2px solid var(--accent)"
            : "2px solid transparent",
          outline: selected ? "1px solid var(--accent)" : "none",
          outlineOffset: -1,
          background: dragging
            ? "var(--surface-input)"
            : isExpanded
            ? "color-mix(in srgb, var(--accent) 6%, transparent)"
            : hover
            ? "var(--surface-raised)"
            : "transparent",
          opacity: dragging ? 0.5 : 1,
          boxShadow: dropOver ? "inset 0 0 0 1px var(--accent)" : "none",
          cursor: hasPane ? "pointer" : isAdHocShell ? "default" : "grab",
          flexShrink: 0,
          transition: "background var(--dur-instant) var(--ease-out-quart)",
        }}
      >
        {/* issue number */}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--accent-cyan)",
          }}
        >
          {num}
        </span>

        {/* left status dot */}
        <span
          aria-hidden
          style={{
            justifySelf: "center",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: dotColor,
          }}
        />

        {/* title */}
        <span
          style={{
            fontSize: 12,
            color: "var(--fg)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {card.title}
        </span>

        {/* branch */}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: branch === "—" ? "var(--muted)" : "var(--accent-cyan)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {branch}
        </span>

        {/* state badge / shell tag */}
        {isAdHocShell ? (
          <span
            style={{
              justifySelf: "start",
              fontSize: 9,
              fontWeight: 600,
              borderRadius: 4,
              padding: "2px 7px",
              color: "var(--muted)",
              background: "var(--surface-input)",
            }}
          >
            Shell
          </span>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              cardMenu.open(r.left, r.bottom + 2);
            }}
            title="Move to another column"
            style={{
              justifySelf: "start",
              fontSize: 9,
              fontWeight: 600,
              borderRadius: 4,
              padding: "2px 7px",
              border: "none",
              cursor: "pointer",
              color: badge.color,
              background: badge.background,
              whiteSpace: "nowrap",
            }}
          >
            {columnName === COL_PR && card.github_issue_number != null
              ? `PR #${card.github_issue_number}`
              : columnName}
          </button>
        )}

        {/* activity line */}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: activity.dim ? "var(--muted)" : "var(--fg)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {activity.text}
        </span>

        {/* stat chip */}
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            fontSize: 9,
            color: chip?.color ?? "var(--muted)",
            minWidth: 0,
          }}
        >
          {chip && (
            <>
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  flexShrink: 0,
                  background: chip.dot,
                }}
              />
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {chip.label}
              </span>
            </>
          )}
        </span>

        {/* age */}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--muted)",
            textAlign: "right",
          }}
        >
          {isAdHocShell ? "" : formatAge(card.updated_at)}
        </span>
      </div>

      {cardMenu.menu && (
        <CardContextMenu
          position={cardMenu.menu}
          onClose={cardMenu.close}
          card={card}
          columnName={columnName}
          columns={columns}
          presets={presets}
          onOpen={onOpenDetail}
          onRunWithPreset={onRunWithPreset}
          onMove={onMove}
          onDelete={onDelete}
        />
      )}
    </>
  );
}
