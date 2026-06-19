import { create } from "zustand";
import type { Channel } from "@tauri-apps/api/core";
import { uiStateGet, uiStateSet } from "../lib/ipc";
import type { TerminalPreset } from "./settings";

export interface OpenTerminal {
  paneId: string;
  windowId: string;
  workspaceId: string;
  channel: Channel<unknown>;
  // True only for a bare-shell pane (manual "New terminal", no preset). Every
  // other pane auto-launches an app (claude via preset/card/resume/reattach), so
  // the keystrokes the user types are app input — `/compact`, an NL prompt — not
  // shell commands, and must not feed the quick-command frequency bar.
  captureCommands?: boolean;
}

// A single terminal inside a row. `weight` is a flex-grow ratio within its row
// (only ratios matter, not absolute values), so the divider math can grow one
// tile while shrinking its neighbour without touching the others.
export interface LayoutTile {
  windowId: string;
  weight: number;
}

// A horizontal band of tiles. `weight` is the flex-grow ratio of the row within
// the stack of rows.
export interface LayoutRow {
  weight: number;
  tiles: LayoutTile[];
}

export type TerminalLayout = LayoutRow[];

// Default number of tiles placed side-by-side before a new row is started when
// auto-placing freshly-opened terminals the saved layout doesn't mention.
const DEFAULT_COLS = 2;

// Reconcile a (possibly stale or empty) layout against the live set of open
// windows: drop tiles whose window is gone, drop emptied rows, de-dupe, repair
// non-positive weights, and append any open window the layout doesn't place
// yet. Pure + idempotent, so the render path can normalise on every pass and
// the persistence effect can compare in/out to decide whether to write.
export function normalizeLayout(
  layout: TerminalLayout,
  windowIds: string[]
): TerminalLayout {
  const present = new Set(windowIds);
  const seen = new Set<string>();
  const rows: LayoutRow[] = [];

  for (const row of layout) {
    const tiles: LayoutTile[] = [];
    for (const tile of row.tiles) {
      if (!present.has(tile.windowId) || seen.has(tile.windowId)) continue;
      seen.add(tile.windowId);
      tiles.push({
        windowId: tile.windowId,
        weight: tile.weight > 0 ? tile.weight : 1,
      });
    }
    if (tiles.length > 0) {
      rows.push({ weight: row.weight > 0 ? row.weight : 1, tiles });
    }
  }

  for (const windowId of windowIds) {
    if (seen.has(windowId)) continue;
    seen.add(windowId);
    const last = rows[rows.length - 1];
    if (last && last.tiles.length < DEFAULT_COLS) {
      last.tiles.push({ windowId, weight: 1 });
    } else {
      rows.push({ weight: 1, tiles: [{ windowId, weight: 1 }] });
    }
  }

  return rows;
}

// Move `draggedId` next to `targetId`, inserting before or after it within the
// target's row. Removes the dragged tile from its old spot first (dropping the
// row if it empties), preserving its weight. No-op if either id is missing or
// they're the same tile.
export function reorderLayout(
  layout: TerminalLayout,
  draggedId: string,
  targetId: string,
  edge: "before" | "after"
): TerminalLayout {
  if (draggedId === targetId) return layout;
  const hasDragged = layout.some((r) => r.tiles.some((t) => t.windowId === draggedId));
  const hasTarget = layout.some((r) => r.tiles.some((t) => t.windowId === targetId));
  if (!hasDragged || !hasTarget) return layout;

  let rows: LayoutRow[] = layout.map((r) => ({
    weight: r.weight,
    tiles: r.tiles.map((t) => ({ ...t })),
  }));

  let dragged: LayoutTile | null = null;
  for (const row of rows) {
    const i = row.tiles.findIndex((t) => t.windowId === draggedId);
    if (i >= 0) {
      dragged = row.tiles.splice(i, 1)[0];
      break;
    }
  }
  rows = rows.filter((r) => r.tiles.length > 0);
  if (!dragged) return layout;

  for (const row of rows) {
    const i = row.tiles.findIndex((t) => t.windowId === targetId);
    if (i >= 0) {
      row.tiles.splice(edge === "after" ? i + 1 : i, 0, dragged);
      break;
    }
  }
  return rows;
}

interface TerminalsState {
  // All open panes across all workspaces
  panes: OpenTerminal[];
  // windowId of the pane that should receive a visual highlight
  highlightedWindowId: string | null;
  // Live agent-activity per terminal window, driven by output bursts (see
  // TerminalPane.markActivity). `working` is true while output is actively
  // arriving — the orbiting comet spins; `veil` is a counter bumped when a burst
  // finishes, retriggering the attention sweep. Kept in the store (not just the
  // pane's local state) so a minimized terminal's tray chip can mirror the same
  // affordances even though its TerminalPane is display:none. In-memory only.
  // `waiting` is the "Claude finished its turn and wants you" pulse, set from
  // the Notification hook (see claude_hooks.rs). `claude` latches once any Claude
  // hook fires for the window, so the per-pane output-cadence tracker stops
  // driving `working`/`veil` and lets the (authoritative) hooks own them.
  activityByWindow: Record<
    string,
    { working: boolean; veil: number; waiting: boolean; claude: boolean }
  >;
  // Set a window's "agent working" flag (no-op if unchanged, to avoid churn).
  setTerminalWorking: (windowId: string, working: boolean) => void;
  // Bump a window's veil counter to replay the attention sweep once.
  bumpTerminalVeil: (windowId: string) => void;
  // Set a window's "waiting for input" pulse.
  setTerminalWaiting: (windowId: string, waiting: boolean) => void;
  // Latch a window as Claude-managed (hooks own its working/veil from now on).
  markTerminalClaude: (windowId: string) => void;
  // The Claude session UUID each window is running, learned from the Claude
  // hook markers (see App.tsx terminal-alert handler). Lets the title resolve
  // per-window instead of sharing the workspace's newest session. In-memory.
  sessionIdByWindow: Record<string, string>;
  setWindowSession: (windowId: string, sessionId: string) => void;
  // Drop a window's activity entry (on pane unmount / close).
  clearTerminalActivity: (windowId: string) => void;
  // windowId of the terminal that currently holds keyboard focus (null if none).
  // Used to suppress completion alerts for the terminal you're actively watching.
  focusedWindowId: string | null;
  // Locked terminals, keyed by workspace → windowIds. A locked terminal can't
  // be closed from the UI until it's unlocked. Keyed by the stable windowId
  // (not paneId, which is regenerated on reattach) and persisted per-workspace
  // to ui_state so the lock survives workspace switches and app restarts.
  lockedByWorkspace: Record<string, string[]>;
  // Custom terminal names, keyed by workspace → windowId → name. A custom name
  // overrides the title derived from the linked card. Keyed by the stable
  // windowId (not paneId, which is regenerated on reattach) and persisted per
  // workspace to ui_state so the name survives workspace switches and restarts.
  namesByWorkspace: Record<string, Record<string, string>>;
  addPane: (pane: OpenTerminal) => void;
  removePane: (paneId: string) => void;
  // Remove all panes for a workspace (called when switching away)
  removePanesForWorkspace: (workspaceId: string) => OpenTerminal[];
  // Get panes for a specific workspace
  getPanesForWorkspace: (workspaceId: string) => OpenTerminal[];
  // Signal that a specific window should be highlighted
  focusWindow: (windowId: string) => void;
  clearHighlight: () => void;
  // Record which terminal window currently has focus (null when none does).
  setFocusedWindow: (windowId: string | null) => void;
  // Toggle a terminal's locked state (and persist it for the workspace).
  toggleLock: (workspaceId: string, windowId: string) => void;
  // Load persisted lock state for a workspace from ui_state.
  loadLocked: (workspaceId: string) => Promise<void>;
  // Set (or clear, when name is empty) a terminal's custom name and persist it.
  setTerminalName: (workspaceId: string, windowId: string, name: string) => void;
  // Load persisted custom names for a workspace from ui_state.
  loadNames: (workspaceId: string) => Promise<void>;
  // Split layout per workspace: how the open terminals are arranged into rows
  // and columns plus their drag-resized weights. Keyed by the stable windowId
  // (like locks) and persisted to ui_state so the arrangement survives workspace
  // switches and restarts. `undefined` means "not loaded yet" — the render path
  // shows a default arrangement but won't persist over it until loadLayout runs.
  layoutByWorkspace: Record<string, TerminalLayout | undefined>;
  // Replace a workspace's layout. `persist` defaults to true; pass false for the
  // transient frames emitted while a divider is being dragged, then persist once
  // on pointer-up so a drag is a single write, not hundreds.
  setLayout: (
    workspaceId: string,
    layout: TerminalLayout,
    persist?: boolean
  ) => void;
  // Load persisted layout for a workspace from ui_state. Always records an entry
  // (possibly []) so the render path can tell "loaded, empty" from "not loaded".
  loadLayout: (workspaceId: string) => Promise<void>;
  // Preset that launched each terminal window, keyed by workspace → windowId →
  // presetId. Used on manual close (×) to run that preset's closeCommands.
  // Keyed by the stable windowId and persisted per-workspace to ui_state so the
  // association survives workspace switches and restarts.
  presetByWorkspace: Record<string, Record<string, string>>;
  // Record (or clear, when presetId is empty) the preset a window was opened
  // with, and persist it.
  setPresetForWindow: (
    workspaceId: string,
    windowId: string,
    presetId: string
  ) => void;
  clearPresetForWindow: (workspaceId: string, windowId: string) => void;
  getPresetForWindow: (
    workspaceId: string,
    windowId: string
  ) => string | undefined;
  // Load persisted window→preset associations for a workspace from ui_state.
  loadPresetWindows: (workspaceId: string) => Promise<void>;
  // Preset chosen via a card's "Run with…" menu, held by card id until the
  // matching terminal_focus event fires so the launch sequence can pick it up.
  // In-memory only: a launch that never happens just leaves a harmless stale
  // entry until it's overwritten or read. Bridges Board (sets it, then moves the
  // card to Doing) and App (reads it when the new terminal opens).
  pendingPresetByCardId: Record<string, TerminalPreset>;
  setPendingPreset: (cardId: string, preset: TerminalPreset) => void;
  // Read-and-clear the preset chosen for a card (undefined if none was set).
  takePendingPreset: (cardId: string) => TerminalPreset | undefined;
}

const lockKey = (workspaceId: string) => `locked-terminals:${workspaceId}`;
const namesKey = (workspaceId: string) => `terminal-names:${workspaceId}`;
const layoutKey = (workspaceId: string) => `terminal-layout:${workspaceId}`;
const presetWinKey = (workspaceId: string) =>
  `terminal-presets-by-window:${workspaceId}`;

export const useTerminalsStore = create<TerminalsState>((set, get) => ({
  panes: [],
  highlightedWindowId: null,
  activityByWindow: {},
  setTerminalWorking: (windowId, working) =>
    set((s) => {
      const cur = s.activityByWindow[windowId];
      if ((cur?.working ?? false) === working) return s;
      return {
        activityByWindow: {
          ...s.activityByWindow,
          [windowId]: {
            working,
            veil: cur?.veil ?? 0,
            waiting: cur?.waiting ?? false,
            claude: cur?.claude ?? false,
          },
        },
      };
    }),
  bumpTerminalVeil: (windowId) =>
    set((s) => {
      const cur = s.activityByWindow[windowId];
      return {
        activityByWindow: {
          ...s.activityByWindow,
          [windowId]: {
            working: cur?.working ?? false,
            veil: (cur?.veil ?? 0) + 1,
            waiting: cur?.waiting ?? false,
            claude: cur?.claude ?? false,
          },
        },
      };
    }),
  setTerminalWaiting: (windowId, waiting) =>
    set((s) => {
      const cur = s.activityByWindow[windowId];
      if ((cur?.waiting ?? false) === waiting) return s;
      return {
        activityByWindow: {
          ...s.activityByWindow,
          [windowId]: {
            working: cur?.working ?? false,
            veil: cur?.veil ?? 0,
            waiting,
            claude: cur?.claude ?? false,
          },
        },
      };
    }),
  markTerminalClaude: (windowId) =>
    set((s) => {
      const cur = s.activityByWindow[windowId];
      if (cur?.claude) return s;
      return {
        activityByWindow: {
          ...s.activityByWindow,
          [windowId]: {
            working: cur?.working ?? false,
            veil: cur?.veil ?? 0,
            waiting: cur?.waiting ?? false,
            claude: true,
          },
        },
      };
    }),
  sessionIdByWindow: {},
  setWindowSession: (windowId, sessionId) =>
    set((s) =>
      s.sessionIdByWindow[windowId] === sessionId
        ? s
        : {
            sessionIdByWindow: { ...s.sessionIdByWindow, [windowId]: sessionId },
          }
    ),
  clearTerminalActivity: (windowId) =>
    set((s) => {
      const hadActivity = windowId in s.activityByWindow;
      const hadSession = windowId in s.sessionIdByWindow;
      if (!hadActivity && !hadSession) return s;
      const activity = { ...s.activityByWindow };
      delete activity[windowId];
      const session = { ...s.sessionIdByWindow };
      delete session[windowId];
      return { activityByWindow: activity, sessionIdByWindow: session };
    }),
  focusedWindowId: null,
  lockedByWorkspace: {},
  namesByWorkspace: {},
  layoutByWorkspace: {},
  presetByWorkspace: {},
  pendingPresetByCardId: {},
  addPane: (pane) => set((s) => ({ panes: [...s.panes, pane] })),
  removePane: (paneId) =>
    set((s) => ({ panes: s.panes.filter((p) => p.paneId !== paneId) })),
  removePanesForWorkspace: (workspaceId) => {
    const removed = get().panes.filter((p) => p.workspaceId === workspaceId);
    set((s) => ({ panes: s.panes.filter((p) => p.workspaceId !== workspaceId) }));
    return removed;
  },
  getPanesForWorkspace: (workspaceId) =>
    get().panes.filter((p) => p.workspaceId === workspaceId),
  focusWindow: (windowId) => set({ highlightedWindowId: windowId }),
  clearHighlight: () => set({ highlightedWindowId: null }),
  setFocusedWindow: (windowId) => set({ focusedWindowId: windowId }),
  toggleLock: (workspaceId, windowId) => {
    const current = get().lockedByWorkspace[workspaceId] ?? [];
    const next = current.includes(windowId)
      ? current.filter((w) => w !== windowId)
      : [...current, windowId];
    set((s) => ({
      lockedByWorkspace: { ...s.lockedByWorkspace, [workspaceId]: next },
    }));
    // Persistence is best-effort: a failed write only loses the lock on the
    // next restart, never breaks the in-memory state the UI reads from.
    uiStateSet(lockKey(workspaceId), JSON.stringify(next)).catch(() => {});
  },
  loadLocked: async (workspaceId) => {
    try {
      const stored = await uiStateGet(lockKey(workspaceId));
      const list: string[] = stored ? JSON.parse(stored) : [];
      set((s) => ({
        lockedByWorkspace: {
          ...s.lockedByWorkspace,
          [workspaceId]: Array.isArray(list) ? list : [],
        },
      }));
    } catch {
      // No stored state or malformed JSON — leave the workspace unlocked.
    }
  },
  setTerminalName: (workspaceId, windowId, name) => {
    const current = get().namesByWorkspace[workspaceId] ?? {};
    const next = { ...current };
    const trimmed = name.trim();
    // An empty name clears the override so the title falls back to the card.
    if (trimmed) next[windowId] = trimmed;
    else delete next[windowId];
    set((s) => ({
      namesByWorkspace: { ...s.namesByWorkspace, [workspaceId]: next },
    }));
    // Best-effort persistence: a failed write only loses the name on the next
    // restart, never breaks the in-memory state the UI reads from.
    uiStateSet(namesKey(workspaceId), JSON.stringify(next)).catch(() => {});
  },
  loadNames: async (workspaceId) => {
    try {
      const stored = await uiStateGet(namesKey(workspaceId));
      const map: Record<string, string> = stored ? JSON.parse(stored) : {};
      set((s) => ({
        namesByWorkspace: {
          ...s.namesByWorkspace,
          [workspaceId]:
            map && typeof map === "object" && !Array.isArray(map) ? map : {},
        },
      }));
    } catch {
      // No stored state or malformed JSON — leave names empty.
    }
  },
  setPresetForWindow: (workspaceId, windowId, presetId) => {
    const current = get().presetByWorkspace[workspaceId] ?? {};
    const next = { ...current };
    if (presetId) next[windowId] = presetId;
    else delete next[windowId];
    set((s) => ({
      presetByWorkspace: { ...s.presetByWorkspace, [workspaceId]: next },
    }));
    // Best-effort persistence: a failed write only loses the association on the
    // next restart, never breaks the in-memory state.
    uiStateSet(presetWinKey(workspaceId), JSON.stringify(next)).catch(() => {});
  },
  clearPresetForWindow: (workspaceId, windowId) => {
    const current = get().presetByWorkspace[workspaceId];
    if (!current || !(windowId in current)) return;
    const next = { ...current };
    delete next[windowId];
    set((s) => ({
      presetByWorkspace: { ...s.presetByWorkspace, [workspaceId]: next },
    }));
    uiStateSet(presetWinKey(workspaceId), JSON.stringify(next)).catch(() => {});
  },
  getPresetForWindow: (workspaceId, windowId) =>
    get().presetByWorkspace[workspaceId]?.[windowId],
  loadPresetWindows: async (workspaceId) => {
    try {
      const stored = await uiStateGet(presetWinKey(workspaceId));
      const map: Record<string, string> = stored ? JSON.parse(stored) : {};
      set((s) => ({
        presetByWorkspace: {
          ...s.presetByWorkspace,
          [workspaceId]:
            map && typeof map === "object" && !Array.isArray(map) ? map : {},
        },
      }));
    } catch {
      // No stored state or malformed JSON — leave associations empty.
    }
  },
  setLayout: (workspaceId, layout, persist = true) => {
    set((s) => ({
      layoutByWorkspace: { ...s.layoutByWorkspace, [workspaceId]: layout },
    }));
    if (persist) {
      uiStateSet(layoutKey(workspaceId), JSON.stringify(layout)).catch(() => {});
    }
  },
  loadLayout: async (workspaceId) => {
    let layout: TerminalLayout = [];
    try {
      const stored = await uiStateGet(layoutKey(workspaceId));
      const parsed = stored ? JSON.parse(stored) : [];
      if (Array.isArray(parsed)) layout = parsed as TerminalLayout;
    } catch {
      // No stored state or malformed JSON — start from an empty layout, which
      // the render path fills with the default arrangement.
    }
    set((s) => ({
      layoutByWorkspace: { ...s.layoutByWorkspace, [workspaceId]: layout },
    }));
  },
  setPendingPreset: (cardId, preset) =>
    set((s) => ({
      pendingPresetByCardId: { ...s.pendingPresetByCardId, [cardId]: preset },
    })),
  takePendingPreset: (cardId) => {
    const preset = get().pendingPresetByCardId[cardId];
    if (preset) {
      set((s) => {
        const next = { ...s.pendingPresetByCardId };
        delete next[cardId];
        return { pendingPresetByCardId: next };
      });
    }
    return preset;
  },
}));