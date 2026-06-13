import { useEffect, useRef, useState } from "react";
import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { Card as CardType, BoardColumn } from "../lib/ipc";
import type { TerminalPreset } from "../store/settings";
import { useSettingsStore } from "../store/settings";
import { ContextMenu, menuItemStyle, useContextMenu } from "./ContextMenu";
import { CheckIcon } from "./icons";
import type { Attention } from "../store/ledger";
import {
  COL_BACKLOG,
  COL_DOING,
  COL_DONE,
  COL_PAUSED,
  COL_PR,
  COLUMN_ORDER,
} from "../lib/columns";

/*
 * One dense hairline row in the ledger — an issue rendered as a single line:
 *
 *   #42  ● fix orphaned tmux        [Doing]  input needed · 2m   ● needs you   3h
 *   └num └title + source dot        └badge   └activity           └stat        └age
 *
 * The row is draggable with the SAME payload the old Kanban Card carried
 * (cardId / columnId / cardTitle / cardBodyPreview), so dropping it on a live
 * TerminalPane still injects the task and moves the card to Doing. The state
 * badge is a button: clicking it opens a menu to move the card between columns;
 * right-clicking the row opens the "Run with…" preset menu.
 */

export interface LedgerRowProps {
  card: CardType;
  columnName: string;
  attention?: Attention;
  hasPane: boolean;
  columns: BoardColumn[];
  active: boolean; // its terminal is the visible tab somewhere on the stage
  onOpenDetail: (cardId: string) => void;
  onMove: (card: CardType, toColumnId: string) => void;
  onRunWithPreset: (card: CardType, preset: TerminalPreset) => void;
}

const HAIR_GRID = "52px 1fr 84px 1.5fr 96px 52px";

function badgeStyle(columnName: string): { color: string; background: string } {
  switch (columnName) {
    case COL_DOING:
      return { color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 14%, transparent)" };
    case COL_PR:
      return {
        color: "var(--source-github)",
        background: "color-mix(in srgb, var(--source-github) 14%, transparent)",
      };
    case COL_PAUSED:
      return {
        color: "var(--status-warn, #f39c12)",
        background: "color-mix(in srgb, var(--status-warn, #f39c12) 14%, transparent)",
      };
    case COL_DONE:
      return {
        color: "var(--status-success, #3fe07a)",
        background: "color-mix(in srgb, var(--status-success, #3fe07a) 14%, transparent)",
      };
    default: // Backlog
      return { color: "var(--muted)", background: "var(--surface-input)" };
  }
}

/** Coarse "Xs/Xm/Xh/Xd/Xw" age from an ISO timestamp. */
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

/** Coarse age from an epoch-ms instant (attention.since). */
function formatSince(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.floor(s)}m`.replace(/^0m$/, "now");
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

/** The mid-row activity line: what the agent/terminal is doing right now. */
function activityText(
  columnName: string,
  attention: Attention | undefined,
  hasPane: boolean
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
  if (hasPane) return { text: "running", dim: true };
  if (columnName === COL_PAUSED) return { text: "window detached", dim: true };
  if (columnName === COL_BACKLOG)
    return { text: "no terminal — drag to a pane to start", dim: true };
  return { text: "—", dim: true };
}

/** Small status chip on the right: dot + word. */
function statChip(
  columnName: string,
  attention: Attention | undefined,
  hasPane: boolean
): { dot: string; label: string; color: string } | null {
  if (attention?.kind === "input")
    return { dot: "var(--accent)", label: "needs you", color: "var(--accent)" };
  if (attention?.kind === "failed")
    return { dot: "var(--status-error, #e74c3c)", label: "failed", color: "var(--status-error, #e74c3c)" };
  if (attention?.kind === "done")
    return { dot: "var(--status-success, #3fe07a)", label: "done", color: "var(--muted)" };
  if (hasPane) return { dot: "var(--status-success, #3fe07a)", label: "live", color: "var(--muted)" };
  if (columnName === COL_PR)
    return { dot: "var(--source-github)", label: "PR", color: "var(--muted)" };
  if (columnName === COL_PAUSED)
    return { dot: "var(--status-warn, #f39c12)", label: "detached", color: "var(--muted)" };
  return null;
}

export default function LedgerRow({
  card,
  columnName,
  attention,
  hasPane,
  columns,
  active,
  onOpenDetail,
  onMove,
  onRunWithPreset,
}: LedgerRowProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);
  const presets = useSettingsStore((s) => s.presets);

  // Two independent menus: the badge "move to column" menu and the right-click
  // "Run with…" preset menu.
  const moveMenu = useContextMenu();
  const runMenu = useContextMenu();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
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
  }, [card.id, card.column_id, card.title, card.body_preview]);

  const isGithub = card.source === "github";
  const num = card.github_issue_number != null ? `#${card.github_issue_number}` : "—";
  const badge = badgeStyle(columnName);
  const activity = activityText(columnName, attention, hasPane);
  const chip = statChip(columnName, attention, hasPane);

  const sortedCols = [...columns].sort(
    (a, b) => COLUMN_ORDER.indexOf(a.name) - COLUMN_ORDER.indexOf(b.name)
  );

  return (
    <>
      <div
        ref={ref}
        onDoubleClick={() => onOpenDetail(card.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          runMenu.open(e.clientX, e.clientY);
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title="Double-click to open · drag onto a terminal to run"
        style={{
          display: "grid",
          gridTemplateColumns: HAIR_GRID,
          gap: "0 12px",
          alignItems: "center",
          padding: "5px 16px",
          borderBottom: "1px solid var(--border)",
          borderLeft: active
            ? "2px solid var(--accent)"
            : "2px solid transparent",
          background: dragging
            ? "var(--surface-input)"
            : hover
            ? "var(--surface-raised)"
            : "transparent",
          opacity: dragging ? 0.5 : 1,
          cursor: "grab",
          flexShrink: 0,
          transition: "background var(--dur-instant) var(--ease-out-quart)",
        }}
      >
        {/* issue number */}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--accent-cyan, #2fdce4)",
          }}
        >
          {num}
        </span>

        {/* title + source dot */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            minWidth: 0,
            fontSize: 12,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              flexShrink: 0,
              background: isGithub
                ? "var(--source-github)"
                : "var(--source-local)",
            }}
          />
          <span
            style={{
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              color: "var(--fg)",
            }}
          >
            {card.title}
          </span>
        </div>

        {/* state badge — click to move */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            moveMenu.open(r.left, r.bottom + 2);
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
          {columnName === COL_PR && card.github_state === "open"
            ? "PR"
            : columnName}
        </button>

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
          {formatAge(card.updated_at)}
        </span>
      </div>

      {moveMenu.menu && (
        <ContextMenu position={moveMenu.menu} onClose={moveMenu.close} minWidth={160}>
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
            Move to
          </div>
          {sortedCols.map((col) => {
            const current = col.name === columnName;
            return (
              <button
                key={col.id}
                style={menuItemStyle}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--panel)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
                onClick={() => {
                  if (!current) onMove(card, col.id);
                  moveMenu.close();
                }}
              >
                <span style={{ width: 14, display: "inline-flex" }}>
                  {current && <CheckIcon size={13} />}
                </span>
                <span>{col.name}</span>
              </button>
            );
          })}
        </ContextMenu>
      )}

      {runMenu.menu && (
        <ContextMenu position={runMenu.menu} onClose={runMenu.close} minWidth={170}>
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
            <div style={{ padding: "6px 10px", fontSize: 13, color: "var(--muted)" }}>
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
                  onRunWithPreset(card, preset);
                  runMenu.close();
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
