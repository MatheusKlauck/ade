import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import TerminalPane from "./TerminalPane";
import TerminalTile from "./terminal/TerminalTile";
import ResizeDivider from "./terminal/ResizeDivider";
import {
  terminalKillWindow,
  claudeSessions,
  subscribeTerminalAlert,
} from "../lib/ipc";
import { useBoardStore } from "../store/board";
import { useTerminalsStore, normalizeLayout, reorderLayout } from "../store/terminals";
import { useSettingsStore, type TerminalPreset } from "../store/settings";
import { ChevronIcon, LockIcon } from "./icons";
import { useEnterAnimation } from "../lib/useEnterAnimation";
import { menuItemBlockStyle as menuItemStyle } from "./ContextMenu";
import type { OpenTerminal, TerminalLayout } from "../store/terminals";

interface TerminalAreaProps {
  panes: OpenTerminal[];
  onNewTerminal: (preset?: TerminalPreset) => void;
  onRemovePane: (paneId: string) => void;
  highlightedWindowId: string | null;
  onHighlightDone: () => void;
  // "board" drops the top toolbar and renders each pane with the compact stage
  // header from the board mockup (dot + title + branch + close). "classic" keeps
  // the toolbar and the full per-pane button row.
  variant?: "classic" | "board";
}

/** Split "New terminal" control: the main button opens a plain shell, the caret
 * opens a menu of the workspace's terminal presets. Each preset opens a terminal
 * that runs its command (and, when applicable, injects the task prompt). */
function NewTerminalButton({
  onNewTerminal,
}: {
  onNewTerminal: (preset?: TerminalPreset) => void;
}) {
  const presets = useSettingsStore((s) => s.presets);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close the menu on any outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (preset?: TerminalPreset) => {
    setOpen(false);
    onNewTerminal(preset);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        onClick={() => pick()}
        style={{
          padding: "4px 12px",
          background: "var(--accent)",
          color: "var(--accent-ink)",
          border: "none",
          borderRadius: "4px 0 0 4px",
          cursor: "pointer",
          fontSize: 13,
        }}
      >
        New terminal
      </button>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Open with a preset"
        style={{
          padding: "4px 6px",
          background: "var(--accent)",
          color: "var(--accent-ink)",
          border: "none",
          borderLeft: "1px solid var(--accent-ink)",
          borderRadius: "0 4px 4px 0",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
        }}
      >
        <ChevronIcon size={12} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: 200,
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
            zIndex: "var(--z-modal)",
            padding: 4,
            overflow: "hidden",
          }}
        >
          <button role="menuitem" onClick={() => pick()} style={menuItemStyle}>
            Plain shell
          </button>
          {presets.length > 0 && (
            <div
              style={{
                height: 1,
                background: "var(--border)",
                margin: "4px 0",
              }}
            />
          )}
          {presets.length === 0 ? (
            <div
              style={{
                padding: "6px 10px",
                fontSize: 12,
                color: "var(--muted)",
              }}
            >
              No presets — add them in Settings.
            </div>
          ) : (
            presets.map((p) => (
              <button
                key={p.id}
                role="menuitem"
                onClick={() => pick(p)}
                title={p.openCommands.join(" && ") || undefined}
                style={menuItemStyle}
              >
                New with {p.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Gap between tiles (px); PAD is half of it, applied as an inset on every side
// so adjacent tiles and the container edge all show an even gutter.
const GAP = 14;
const PAD = GAP / 2;
// Smallest a tile may be dragged to, so a divider can't collapse a pane to zero.
const MIN_ROW_PX = 110;
const MIN_TILE_PX = 180;

// A minimized terminal shown as a tray chip. It mirrors the live pane's comet +
// veil (read from the store, since the real pane is display:none while
// minimized) so an agent working in a stashed terminal is still visible. The
// comet orbits outside the chip; an inner clip keeps the veil and the label
// ellipsis contained.
function MinimizedChip({
  title,
  locked,
  working,
  veilKey,
  onRestore,
}: {
  title: string;
  locked: boolean;
  working: boolean;
  veilKey: number;
  onRestore: () => void;
}) {
  return (
    <button
      onClick={onRestore}
      title="Restore terminal"
      className={[
        "ade-comet",
        "ade-comet--outside",
        working && "ade-term-visible",
        working && "ade-term-working",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        position: "relative",
        maxWidth: 240,
        padding: 0,
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        cursor: "pointer",
        overflow: "visible",
      }}
    >
      <span
        className="ade-term-clip"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          maxWidth: "100%",
          padding: "4px 10px",
          fontSize: 12,
          color: "var(--muted)",
          borderRadius: 4,
          overflow: "hidden",
          position: "relative",
          whiteSpace: "nowrap",
        }}
      >
        {veilKey > 0 && (
          <span key={veilKey} className="ade-term-done-veil" aria-hidden />
        )}
        <ChevronIcon size={12} style={{ transform: "rotate(-90deg)" }} />
        {locked && <LockIcon size={12} style={{ color: "var(--accent)" }} />}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          {title}
        </span>
      </span>
    </button>
  );
}

type SessionInfo = { title: string; branch: string | null };

// The Claude session each workspace is actively running, by reading the newest
// transcript under the workspace cwd. ponytail: transcripts share the workspace
// cwd, so when several claude sessions run in one workspace we can't map a
// session to a specific window — newest-within-15min wins. Refetch is debounced
// off terminal-alert; add a "newest-only" backend command if scanning all
// transcripts per alert ever shows up in a profile.
function useActiveSessions(panes: OpenTerminal[]): Record<string, SessionInfo | undefined> {
  const [byWs, setByWs] = useState<Record<string, SessionInfo | undefined>>({});
  const wsKey = useMemo(
    () => Array.from(new Set(panes.map((p) => p.workspaceId))).sort().join("|"),
    [panes]
  );
  const debounce = useRef<number | null>(null);

  const refresh = useCallback(() => {
    const now = Date.now() / 1000;
    for (const wsId of wsKey ? wsKey.split("|") : []) {
      claudeSessions(wsId)
        .then((sessions) => {
          const active = sessions.find((s) => now - s.lastActive < 15 * 60);
          setByWs((prev) => ({
            ...prev,
            [wsId]: active ? { title: active.title, branch: active.gitBranch } : undefined,
          }));
        })
        .catch(() => {}); // cwd/serve unavailable — keep the prior value
    }
  }, [wsKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    subscribeTerminalAlert((p) => {
      if (p.kind === "bell" || p.kind === "app") return;
      if (debounce.current) return; // trailing: at most one refetch per 2s
      debounce.current = window.setTimeout(() => {
        debounce.current = null;
        refresh();
      }, 2000);
    }).then((u) => (unsub = u));
    return () => {
      unsub?.();
      if (debounce.current) window.clearTimeout(debounce.current);
    };
  }, [refresh]);

  return byWs;
}

export default function TerminalArea({
  panes,
  onNewTerminal,
  onRemovePane,
  highlightedWindowId,
  onHighlightDone,
  variant = "classic",
}: TerminalAreaProps) {
  const sessionByWs = useActiveSessions(panes);
  const isBoard = variant === "board";
  const boards = useBoardStore((s) => s.boards);
  const lockedByWorkspace = useTerminalsStore((s) => s.lockedByWorkspace);
  const namesByWorkspace = useTerminalsStore((s) => s.namesByWorkspace);
  const toggleLock = useTerminalsStore((s) => s.toggleLock);
  const setTerminalName = useTerminalsStore((s) => s.setTerminalName);
  const layoutByWorkspace = useTerminalsStore((s) => s.layoutByWorkspace);
  const setLayout = useTerminalsStore((s) => s.setLayout);
  // The focused pane gets an accent border (the ADE primary / veil hue).
  const focusedWindowId = useTerminalsStore((s) => s.focusedWindowId);
  // Live output-activity per window, mirrored from the panes so minimized chips
  // can show the same comet + veil.
  const activityByWindow = useTerminalsStore((s) => s.activityByWindow);
  const [minimized, setMinimized] = useState<Record<string, boolean>>({});
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null);

  // The container all panes are absolutely positioned inside. Keeping every
  // TerminalPane a direct child of this one element (never re-parented) is what
  // lets resize and reorder be pure position changes — React reconciles by key,
  // so a pane is never unmounted, so its PTY is never torn down.
  const gridRef = useRef<HTMLDivElement | null>(null);

  // Active divider-drag teardown. Listeners are normally removed on pointerup,
  // but if this component unmounts mid-drag (e.g. workspace switch) the
  // window-level handlers would keep firing against a dead workspace.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      dragCleanupRef.current?.();
    },
    []
  );

  // All active panes belong to the same (active) workspace.
  const workspaceId = panes[0]?.workspaceId ?? null;
  // Entrance for freshly-opened terminals only. Keyed on workspaceId so flipping
  // workspaces re-seeds the set instead of animating every pane back in.
  const { isEntering, onEntered } = useEnterAnimation(
    panes.map((p) => p.paneId),
    workspaceId
  );
  const rawLayout = workspaceId ? layoutByWorkspace[workspaceId] : undefined;
  const winKey = panes.map((p) => p.windowId).join("|");
  // Always render from a normalised layout so a freshly-opened terminal shows up
  // immediately, even before the persistence effect below has written it back.
  const layout = normalizeLayout(rawLayout ?? [], panes.map((p) => p.windowId));

  // Persist the normalised layout whenever it diverges from what's stored —
  // e.g. a terminal was opened (appended) or closed (dropped). Gated on
  // rawLayout being defined so we never clobber the persisted layout with the
  // default arrangement before loadLayout has had a chance to run.
  useEffect(() => {
    if (!workspaceId || rawLayout === undefined) return;
    const norm = normalizeLayout(rawLayout, panes.map((p) => p.windowId));
    if (JSON.stringify(norm) !== JSON.stringify(rawLayout)) {
      setLayout(workspaceId, norm, true);
    }
    // winKey captures the set of open windows; rawLayout captures stored shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, rawLayout, winKey]);

  // Move the dragged pane next to a drop target and persist. Reads the live
  // layout from the store so the handler can stay stable (registered once per
  // drop target) regardless of re-renders mid-drag.
  const doReorder = useCallback(
    (draggedWin: string, targetWin: string, edge: "before" | "after") => {
      if (!workspaceId) return;
      const st = useTerminalsStore.getState();
      const wins = st.panes
        .filter((p) => p.workspaceId === workspaceId)
        .map((p) => p.windowId);
      const base = normalizeLayout(st.layoutByWorkspace[workspaceId] ?? [], wins);
      setLayout(workspaceId, reorderLayout(base, draggedWin, targetWin, edge), true);
    },
    [workspaceId, setLayout]
  );

  const isLocked = (pane: OpenTerminal): boolean =>
    (lockedByWorkspace[pane.workspaceId] ?? []).includes(pane.windowId);

  // A user-given custom name takes precedence over everything else.
  const customNameFor = (pane: OpenTerminal): string | undefined =>
    namesByWorkspace[pane.workspaceId]?.[pane.windowId];

  const sessionFor = (pane: OpenTerminal): SessionInfo | undefined =>
    sessionByWs[pane.workspaceId];

  // Title: custom name if set, else the linked card/issue (e.g. "#123 | Fix
  // login"), else the active Claude session's title, else "Terminal".
  const titleFor = (pane: OpenTerminal): string => {
    const custom = customNameFor(pane);
    if (custom) return custom;
    const board = boards[pane.workspaceId];
    if (board) {
      for (const colId of Object.keys(board.cardsByColumn)) {
        const card = board.cardsByColumn[colId].find(
          (c) => c.terminal_window_id === pane.windowId
        );
        if (card) {
          return card.github_issue_number != null
            ? `#${card.github_issue_number} | ${card.title}`
            : card.title;
        }
      }
    }
    const sess = sessionFor(pane);
    if (sess && sess.title && sess.title !== "(untitled session)") return sess.title;
    return "Terminal";
  };

  // The card linked to this pane's window, scanned across all columns (a pane
  // maps to at most one card via terminal_window_id).
  const cardFor = (pane: OpenTerminal) => {
    const board = boards[pane.workspaceId];
    if (!board) return undefined;
    for (const colId of Object.keys(board.cardsByColumn)) {
      const card = board.cardsByColumn[colId].find(
        (c) => c.terminal_window_id === pane.windowId
      );
      if (card) return card;
    }
    return undefined;
  };

  // Branch: the real git branch the session reports, when known. Falls back to
  // the card's "issue-<n>" worktree convention (card terminals run in a worktree
  // cwd the session scan doesn't cover), else none.
  const branchFor = (pane: OpenTerminal): string | null => {
    const sess = sessionFor(pane);
    if (sess?.branch) return sess.branch;
    const card = cardFor(pane);
    if (card?.github_issue_number != null) return `issue-${card.github_issue_number}`;
    return null;
  };

  // A maximized pane only counts while it is still open.
  const maxId =
    maximizedPaneId && panes.some((p) => p.paneId === maximizedPaneId)
      ? maximizedPaneId
      : null;

  const toggleMinimize = useCallback((paneId: string) => {
    setMinimized((m) => ({ ...m, [paneId]: !m[paneId] }));
    // A pane can't be both minimized and maximized.
    setMaximizedPaneId((id) => (id === paneId ? null : id));
  }, []);

  const toggleMaximize = useCallback((paneId: string) => {
    setMinimized((m) => (m[paneId] ? { ...m, [paneId]: false } : m));
    setMaximizedPaneId((id) => (id === paneId ? null : paneId));
  }, []);

  const restore = (paneId: string) => {
    setMinimized((m) => ({ ...m, [paneId]: false }));
  };

  const handleRemove = useCallback(
    (paneId: string) => {
      // Locked terminals can't be closed. The header's close button is already
      // disabled when locked; this guards every other path into removal too.
      const st = useTerminalsStore.getState();
      const pane = st.panes.find((p) => p.paneId === paneId);
      if (
        pane &&
        (st.lockedByWorkspace[pane.workspaceId] ?? []).includes(pane.windowId)
      ) {
        return;
      }
      setMinimized((m) => {
        const next = { ...m };
        delete next[paneId];
        return next;
      });
      setMaximizedPaneId((id) => (id === paneId ? null : id));
      onRemovePane(paneId);
      // Explicit close ends the session: kill the tmux window (which harvests
      // the Claude transcript into the brain backend-side) instead of leaving it
      // detached. Unmount's terminalClose only drops the viewer. Best-effort.
      if (pane) {
        terminalKillWindow(pane.workspaceId, pane.windowId).catch(() => {});
      }
    },
    [onRemovePane]
  );

  // Per-pane handler bundles, stable across renders so the memoized
  // TerminalPane isn't re-rendered by fresh closures on every divider-drag
  // frame. Rebuilt only when the pane set (or a store action) changes.
  const paneHandlers = useMemo(() => {
    const map = new Map<
      string,
      {
        onToggleLock: () => void;
        onRename: (name: string) => void;
        onRemove: () => void;
        onToggleMinimize: () => void;
        onToggleMaximize: () => void;
      }
    >();
    for (const pane of panes) {
      map.set(pane.paneId, {
        onToggleLock: () => toggleLock(pane.workspaceId, pane.windowId),
        onRename: (name: string) =>
          setTerminalName(pane.workspaceId, pane.windowId, name),
        onRemove: () => handleRemove(pane.paneId),
        onToggleMinimize: () => toggleMinimize(pane.paneId),
        onToggleMaximize: () => toggleMaximize(pane.paneId),
      });
    }
    return map;
  }, [panes, toggleLock, setTerminalName, handleRemove, toggleMinimize, toggleMaximize]);

  // Panes shown as chips in the minimized tray (hidden from the grid). When a
  // pane is maximized, the tray is suppressed to keep focus on it.
  const minimizedPanes = maxId ? [] : panes.filter((p) => minimized[p.paneId]);

  // A pane is hidden from the tiling when maximized-elsewhere or minimized.
  const isHidden = (pane: OpenTerminal): boolean =>
    maxId ? maxId !== pane.paneId : !!minimized[pane.paneId];

  const paneByWin = new Map(panes.map((p) => [p.windowId, p]));

  // --- Geometry: turn the weighted row/tile layout into absolute rectangles in
  // fractional [0..1] coordinates, skipping hidden tiles/rows so the visible
  // ones fill the space. Also collect the draggable boundaries between them. ---
  type Rect = { top: number; left: number; width: number; height: number };
  const rects = new Map<string, Rect>();
  // Divider between two adjacent visible rows (aRi/bRi index into `layout`).
  const rowDividers: { y: number; aRi: number; bRi: number }[] = [];
  // Divider between two adjacent visible tiles within row `ri` (aTi/bTi index
  // into layout[ri].tiles), spanning the row's vertical band y0..y1.
  const colDividers: {
    x: number;
    y0: number;
    y1: number;
    ri: number;
    aTi: number;
    bTi: number;
  }[] = [];

  const visRows = layout
    .map((row, ri) => ({
      ri,
      row,
      vis: row.tiles
        .map((tile, ti) => ({ tile, ti, pane: paneByWin.get(tile.windowId) }))
        .filter(
          (x): x is { tile: (typeof row.tiles)[number]; ti: number; pane: OpenTerminal } =>
            !!x.pane && !isHidden(x.pane)
        ),
    }))
    .filter((r) => r.vis.length > 0);

  const sumRowW = visRows.reduce((s, r) => s + r.row.weight, 0) || 1;
  let y0 = 0;
  visRows.forEach((vr, k) => {
    const h = vr.row.weight / sumRowW;
    const y1 = y0 + h;
    const sumTileW = vr.vis.reduce((s, x) => s + x.tile.weight, 0) || 1;
    let x0 = 0;
    vr.vis.forEach((x, j) => {
      const w = x.tile.weight / sumTileW;
      rects.set(x.tile.windowId, { top: y0, left: x0, width: w, height: h });
      const x1 = x0 + w;
      if (j < vr.vis.length - 1) {
        colDividers.push({
          x: x1,
          y0,
          y1,
          ri: vr.ri,
          aTi: x.ti,
          bTi: vr.vis[j + 1].ti,
        });
      }
      x0 = x1;
    });
    if (k < visRows.length - 1) {
      rowDividers.push({ y: y1, aRi: vr.ri, bRi: visRows[k + 1].ri });
    }
    y0 = y1;
  });

  // Drag a horizontal divider: grow row `aRi`, shrink row `bRi`, others fixed.
  // Convert pixel drag to weight delta via the container's height; persist once
  // on release rather than on every frame.
  const beginRowResize = (e: ReactPointerEvent, aRi: number, bRi: number) => {
    e.preventDefault();
    const cont = gridRef.current;
    if (!cont || !workspaceId) return;
    const H = cont.getBoundingClientRect().height;
    if (H <= 0) return;
    const start = layout;
    const S = start.reduce((s, r) => s + r.weight, 0) || 1;
    const wa = start[aRi].weight;
    const wb = start[bRi].weight;
    const minW = (MIN_ROW_PX / H) * S;
    const lo = -(wa - minW);
    const hi = wb - minW;
    if (lo > hi) return;
    const startY = e.clientY;
    const onMove = (ev: PointerEvent) => {
      const d = Math.max(lo, Math.min(hi, ((ev.clientY - startY) / H) * S));
      const next = start.map((r, i) =>
        i === aRi
          ? { ...r, weight: wa + d }
          : i === bRi
          ? { ...r, weight: wb - d }
          : r
      );
      setLayout(workspaceId, next, false);
    };
    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      dragCleanupRef.current = null;
    };
    const onUp = () => {
      detach();
      const cur = useTerminalsStore.getState().layoutByWorkspace[workspaceId];
      if (cur) setLayout(workspaceId, cur, true);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    dragCleanupRef.current = detach;
  };

  // Drag a vertical divider: grow tile `aTi`, shrink tile `bTi` within row `ri`.
  const beginColResize = (
    e: ReactPointerEvent,
    ri: number,
    aTi: number,
    bTi: number
  ) => {
    e.preventDefault();
    const cont = gridRef.current;
    if (!cont || !workspaceId) return;
    const W = cont.getBoundingClientRect().width;
    if (W <= 0) return;
    const start = layout;
    const tiles = start[ri].tiles;
    const S = tiles.reduce((s, t) => s + t.weight, 0) || 1;
    const wa = tiles[aTi].weight;
    const wb = tiles[bTi].weight;
    const minW = (MIN_TILE_PX / W) * S;
    const lo = -(wa - minW);
    const hi = wb - minW;
    if (lo > hi) return;
    const startX = e.clientX;
    const onMove = (ev: PointerEvent) => {
      const d = Math.max(lo, Math.min(hi, ((ev.clientX - startX) / W) * S));
      const next: TerminalLayout = start.map((r, i) =>
        i === ri
          ? {
              ...r,
              tiles: r.tiles.map((t, j) =>
                j === aTi
                  ? { ...t, weight: wa + d }
                  : j === bTi
                  ? { ...t, weight: wb - d }
                  : t
              ),
            }
          : r
      );
      setLayout(workspaceId, next, false);
    };
    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      dragCleanupRef.current = null;
    };
    const onUp = () => {
      detach();
      const cur = useTerminalsStore.getState().layoutByWorkspace[workspaceId];
      if (cur) setLayout(workspaceId, cur, true);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    dragCleanupRef.current = detach;
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {!isBoard && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--muted)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            Terminals{panes.length > 0 ? ` · ${panes.length}` : ""}
          </span>
          <div style={{ flex: 1 }} />
          <NewTerminalButton onNewTerminal={onNewTerminal} />
        </div>
      )}
      {panes.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            color: "var(--muted)",
          }}
        >
          <span style={{ fontSize: 13 }}>No terminals open</span>
          <button
            onClick={() => onNewTerminal()}
            style={{
              padding: "8px 20px",
              background: "var(--accent)",
              color: "var(--accent-ink)",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Open terminal
          </button>
        </div>
      ) : (
        <>
          <div
            ref={gridRef}
            style={{
              flex: 1,
              minHeight: 0,
              position: "relative",
              overflow: "hidden",
            }}
          >
            {panes.map((pane) => {
              const isMax = maxId === pane.paneId;
              // When something is maximized, every other pane is hidden;
              // otherwise minimized panes are hidden (shown in the tray below).
              // Hidden panes stay mounted (display:none) so their PTY keeps
              // running and the terminal refits when shown again.
              const hide = isHidden(pane);
              const rect = rects.get(pane.windowId);
              const locked = isLocked(pane);
              const isFocusedPane = focusedWindowId === pane.windowId;
              // Locked panes get an accented, ringed border so they stand out
              // from the freely-closeable ones; the focused pane also borders in
              // the accent (the veil hue) to mark where keystrokes are going.
              const borderColor =
                locked || isFocusedPane ? "var(--accent)" : "var(--border)";
              const lockedRing: CSSProperties = locked
                ? { boxShadow: "0 0 0 1px var(--accent)" }
                : {};
              // Every pane is absolutely positioned from the computed geometry,
              // so resize/reorder are pure position changes — the pane element
              // is never re-parented, so React never unmounts it (PTY survives).
              // overflow:visible so the pane's activity comet can orbit just
              // outside this border; the pane clips its own content internally
              // (see .ade-term-clip in TerminalPane).
              const wrapperStyle: CSSProperties = isMax
                ? {
                    position: "absolute",
                    inset: PAD,
                    zIndex: 20,
                    border: `1px solid ${borderColor}`,
                    ...lockedRing,
                    borderRadius: 4,
                    overflow: "visible",
                    background: "var(--bg)",
                  }
                : hide || !rect
                ? { display: "none" }
                : {
                    position: "absolute",
                    top: `calc(${rect.top * 100}% + ${PAD}px)`,
                    left: `calc(${rect.left * 100}% + ${PAD}px)`,
                    width: `calc(${rect.width * 100}% - ${GAP}px)`,
                    height: `calc(${rect.height * 100}% - ${GAP}px)`,
                    border: `1px solid ${borderColor}`,
                    ...lockedRing,
                    borderRadius: 4,
                    overflow: "visible",
                  };
              return (
                <TerminalTile
                  key={pane.paneId}
                  pane={pane}
                  style={wrapperStyle}
                  hidden={!isMax && (hide || !rect)}
                  onReorder={doReorder}
                  entering={isEntering(pane.paneId)}
                  onEntered={() => onEntered(pane.paneId)}
                >
                  <TerminalPane
                    pane={pane}
                    title={titleFor(pane)}
                    cometOutside
                    headerVariant={isBoard ? "board" : "default"}
                    branch={branchFor(pane)}
                    maximized={isMax}
                    locked={locked}
                    hasCustomName={customNameFor(pane) != null}
                    onToggleLock={paneHandlers.get(pane.paneId)?.onToggleLock}
                    onRename={paneHandlers.get(pane.paneId)?.onRename}
                    onRemove={paneHandlers.get(pane.paneId)!.onRemove}
                    onToggleMinimize={paneHandlers.get(pane.paneId)?.onToggleMinimize}
                    onToggleMaximize={paneHandlers.get(pane.paneId)?.onToggleMaximize}
                    highlighted={highlightedWindowId === pane.windowId}
                    onHighlightDone={onHighlightDone}
                  />
                </TerminalTile>
              );
            })}
            {maxId == null &&
              rowDividers.map((d) => (
                <ResizeDivider
                  key={`rd-${d.aRi}-${d.bRi}`}
                  orientation="row"
                  rectStyle={{
                    left: PAD,
                    right: PAD,
                    top: `calc(${d.y * 100}% - ${PAD}px)`,
                    height: GAP,
                  }}
                  onPointerDown={(e) => beginRowResize(e, d.aRi, d.bRi)}
                />
              ))}
            {maxId == null &&
              colDividers.map((d) => (
                <ResizeDivider
                  key={`cd-${d.ri}-${d.aTi}-${d.bTi}`}
                  orientation="col"
                  rectStyle={{
                    top: `calc(${d.y0 * 100}% + ${PAD}px)`,
                    height: `calc(${(d.y1 - d.y0) * 100}% - ${GAP}px)`,
                    left: `calc(${d.x * 100}% - ${PAD}px)`,
                    width: GAP,
                  }}
                  onPointerDown={(e) => beginColResize(e, d.ri, d.aTi, d.bTi)}
                />
              ))}
          </div>
          {minimizedPanes.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                padding: "6px 8px",
                borderTop: "1px solid var(--border)",
                background: "var(--bg)",
              }}
            >
              {minimizedPanes.map((pane) => {
                const act = activityByWindow[pane.windowId];
                return (
                  <MinimizedChip
                    key={pane.paneId}
                    title={titleFor(pane)}
                    locked={isLocked(pane)}
                    working={act?.working ?? false}
                    veilKey={act?.veil ?? 0}
                    onRestore={() => restore(pane.paneId)}
                  />
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
