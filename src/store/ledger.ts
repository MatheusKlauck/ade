import { create } from "zustand";
import { uiStateGet, uiStateSet } from "../lib/ipc";
import type { Card } from "../lib/ipc";
import {
  COL_BACKLOG,
  COL_DOING,
  COL_DONE,
  COL_PAUSED,
  COL_PR,
} from "../lib/columns";

/*
 * Ledger view state for the inline-accordion screen: which terminals are
 * expanded (per workspace), the per-terminal attention flags, and the row
 * filter.
 *
 *   The rows list IS the terminal surface. A row whose card has a live
 *   terminal can be EXPANDED to render that terminal inline, full-width,
 *   directly below its header:
 *
 *     #42  fix orphaned tmux        [Doing]  input needed · 2m        12m
 *     ┌ ● terminal — live ──────────────── ↗ full screen   collapse ▴ ┐
 *     │  $ claude … (the live xterm body)                              │
 *     └───────────────────────────────────────────────────────────────┘
 *     #38  terminal presets         [Doing]  running                  41m
 *
 *   Several rows can be expanded at once (the "dual expansion"). Every
 *   TerminalPane stays mounted whenever its pane exists; collapsing only
 *   sets the wrapper height to 0 — the pane is never unmounted, so its PTY
 *   survives. `expandedByWorkspace` holds the set of expanded windowIds.
 */

// ---- expansion model (pure helpers — the unit-test surface) ----

/** Drop expanded entries whose window is no longer open. Pure; new Set. */
export function normalizeExpanded(
  expanded: Set<string>,
  liveWindowIds: string[]
): Set<string> {
  const live = new Set(liveWindowIds);
  const out = new Set<string>();
  for (const w of expanded) if (live.has(w)) out.add(w);
  return out;
}

/** Toggle membership; returns a NEW Set (immutable). */
export function toggleExpanded(
  expanded: Set<string>,
  windowId: string
): Set<string> {
  const out = new Set(expanded);
  if (out.has(windowId)) out.delete(windowId);
  else out.add(windowId);
  return out;
}

/** Add a windowId (idempotent). Returns the SAME set when already present so a
 * no-op auto-expand doesn't churn the render. */
export function withExpanded(
  expanded: Set<string>,
  windowId: string
): Set<string> {
  if (expanded.has(windowId)) return expanded;
  const out = new Set(expanded);
  out.add(windowId);
  return out;
}

// ---- attention (the "input needed" / finished / failed flags) ----

export type AttentionKind = "input" | "done" | "failed";

export interface Attention {
  kind: AttentionKind;
  since: number; // epoch ms
  detail?: string; // e.g. exit code for "failed"
}

// ---- rows: derived model, sorting and filtering (pure) ----

export type LedgerFilter =
  | "all"
  | "input"
  | "doing"
  | "pr"
  | "paused"
  | "backlog"
  | "done";

export interface LedgerRowModel {
  card: Card;
  columnName: string;
  attention?: Attention;
  // True for ad-hoc shells (a terminal with no linked card): rendered as a
  // synthetic row so "New terminal" is visible and expandable. Such a row has
  // no real card, so it isn't draggable / movable / openable as a detail.
  isAdHocShell?: boolean;
}

// Attention-first ordering: terminals waiting on the user outrank everything;
// then work states in urgency order; then the board's own position.
const STATE_ORDER: string[] = [COL_DOING, COL_PR, COL_PAUSED, COL_BACKLOG, COL_DONE];

export function sortRows(rows: LedgerRowModel[]): LedgerRowModel[] {
  return [...rows].sort((a, b) => {
    const ai = a.attention?.kind === "input" ? 0 : 1;
    const bi = b.attention?.kind === "input" ? 0 : 1;
    if (ai !== bi) return ai - bi;
    if (ai === 0) return a.attention!.since - b.attention!.since;
    const as = STATE_ORDER.indexOf(a.columnName);
    const bs = STATE_ORDER.indexOf(b.columnName);
    if (as !== bs) return as - bs;
    return a.card.position - b.card.position;
  });
}

const FILTER_TO_COLUMN: Partial<Record<LedgerFilter, string>> = {
  doing: COL_DOING,
  pr: COL_PR,
  paused: COL_PAUSED,
  backlog: COL_BACKLOG,
  done: COL_DONE,
};

export function filterRows(
  rows: LedgerRowModel[],
  filter: LedgerFilter
): LedgerRowModel[] {
  if (filter === "all") return rows.filter((r) => r.columnName !== COL_DONE);
  if (filter === "input")
    return rows.filter((r) => r.attention?.kind === "input");
  const col = FILTER_TO_COLUMN[filter];
  return rows.filter((r) => r.columnName === col);
}

export function rowCounts(
  rows: LedgerRowModel[]
): Record<LedgerFilter, number> {
  const counts: Record<LedgerFilter, number> = {
    all: 0,
    input: 0,
    doing: 0,
    pr: 0,
    paused: 0,
    backlog: 0,
    done: 0,
  };
  for (const r of rows) {
    if (r.columnName !== COL_DONE) counts.all++;
    if (r.attention?.kind === "input") counts.input++;
    if (r.columnName === COL_DOING) counts.doing++;
    else if (r.columnName === COL_PR) counts.pr++;
    else if (r.columnName === COL_PAUSED) counts.paused++;
    else if (r.columnName === COL_BACKLOG) counts.backlog++;
    else if (r.columnName === COL_DONE) counts.done++;
  }
  return counts;
}

// ---- store ----

export const DEFAULT_ACCORDION_HEIGHT = 360;

const expandedKey = (workspaceId: string) => `ledger-expanded:${workspaceId}`;

interface PersistedExpanded {
  expanded: string[]; // windowIds — Sets don't serialize
  accordionHeight: number;
}

export function sanitizeExpanded(parsed: unknown): PersistedExpanded {
  const fallback: PersistedExpanded = {
    expanded: [],
    accordionHeight: DEFAULT_ACCORDION_HEIGHT,
  };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return fallback;
  const obj = parsed as { expanded?: unknown; accordionHeight?: unknown };
  const expanded = Array.isArray(obj.expanded)
    ? obj.expanded.filter((w): w is string => typeof w === "string")
    : [];
  const accordionHeight =
    typeof obj.accordionHeight === "number" && obj.accordionHeight > 0
      ? obj.accordionHeight
      : DEFAULT_ACCORDION_HEIGHT;
  return { expanded, accordionHeight };
}

interface LedgerState {
  // Expanded terminals per workspace. `undefined` means "not loaded yet" — the
  // render path shows a normalized default but won't persist over it until
  // loadExpanded runs (same contract the old stage kept).
  expandedByWorkspace: Record<string, Set<string> | undefined>;
  accordionHeightByWorkspace: Record<string, number>;
  attentionByWindow: Record<string, Attention>;
  filter: LedgerFilter;
  // windowId of the terminal shown over the whole ledger area, or null.
  fullscreenWindowId: string | null;

  setExpanded: (
    workspaceId: string,
    expanded: Set<string>,
    persist?: boolean
  ) => void;
  loadExpanded: (workspaceId: string) => Promise<void>;
  toggleExpandedWindow: (workspaceId: string, windowId: string) => void;
  expandWindow: (workspaceId: string, windowId: string) => void;
  setAccordionHeight: (workspaceId: string, height: number) => void;
  setAttention: (windowId: string, kind: AttentionKind, detail?: string) => void;
  clearAttention: (windowId: string) => void;
  // Drop attention entries for windows that no longer exist.
  pruneAttention: (liveWindowIds: string[]) => void;
  setFilter: (filter: LedgerFilter) => void;
  setFullscreen: (windowId: string | null) => void;
}

function persistExpanded(workspaceId: string, state: LedgerState) {
  const payload: PersistedExpanded = {
    expanded: [...(state.expandedByWorkspace[workspaceId] ?? new Set<string>())],
    accordionHeight:
      state.accordionHeightByWorkspace[workspaceId] ?? DEFAULT_ACCORDION_HEIGHT,
  };
  // Best-effort persistence: a failed write only loses the arrangement on the
  // next restart, never breaks the in-memory state the UI reads from.
  uiStateSet(expandedKey(workspaceId), JSON.stringify(payload)).catch(() => {});
}

export const useLedgerStore = create<LedgerState>((set, get) => ({
  expandedByWorkspace: {},
  accordionHeightByWorkspace: {},
  attentionByWindow: {},
  filter: "all",
  fullscreenWindowId: null,

  setExpanded: (workspaceId, expanded, persist = true) => {
    set((s) => ({
      expandedByWorkspace: { ...s.expandedByWorkspace, [workspaceId]: expanded },
    }));
    if (persist) persistExpanded(workspaceId, get());
  },

  loadExpanded: async (workspaceId) => {
    let loaded: PersistedExpanded = {
      expanded: [],
      accordionHeight: DEFAULT_ACCORDION_HEIGHT,
    };
    try {
      const stored = await uiStateGet(expandedKey(workspaceId));
      loaded = sanitizeExpanded(stored ? JSON.parse(stored) : null);
    } catch {
      // No stored state or malformed JSON — start from the default; the render
      // path normalizes against the open windows.
    }
    set((s) => ({
      expandedByWorkspace: {
        ...s.expandedByWorkspace,
        [workspaceId]: new Set(loaded.expanded),
      },
      accordionHeightByWorkspace: {
        ...s.accordionHeightByWorkspace,
        [workspaceId]: loaded.accordionHeight,
      },
    }));
  },

  toggleExpandedWindow: (workspaceId, windowId) => {
    set((s) => ({
      expandedByWorkspace: {
        ...s.expandedByWorkspace,
        [workspaceId]: toggleExpanded(
          s.expandedByWorkspace[workspaceId] ?? new Set<string>(),
          windowId
        ),
      },
    }));
    persistExpanded(workspaceId, get());
  },

  expandWindow: (workspaceId, windowId) => {
    const cur = get().expandedByWorkspace[workspaceId] ?? new Set<string>();
    const next = withExpanded(cur, windowId);
    if (next === cur) return; // already expanded — no churn, no write
    set((s) => ({
      expandedByWorkspace: { ...s.expandedByWorkspace, [workspaceId]: next },
    }));
    persistExpanded(workspaceId, get());
  },

  setAccordionHeight: (workspaceId, height) => {
    set((s) => ({
      accordionHeightByWorkspace: {
        ...s.accordionHeightByWorkspace,
        [workspaceId]: height,
      },
    }));
    persistExpanded(workspaceId, get());
  },

  setAttention: (windowId, kind, detail) =>
    set((s) => ({
      attentionByWindow: {
        ...s.attentionByWindow,
        [windowId]: { kind, since: Date.now(), detail },
      },
    })),

  clearAttention: (windowId) =>
    set((s) => {
      if (!(windowId in s.attentionByWindow)) return s;
      const next = { ...s.attentionByWindow };
      delete next[windowId];
      return { attentionByWindow: next };
    }),

  pruneAttention: (liveWindowIds) =>
    set((s) => {
      const live = new Set(liveWindowIds);
      const stale = Object.keys(s.attentionByWindow).filter((w) => !live.has(w));
      if (stale.length === 0) return s;
      const next = { ...s.attentionByWindow };
      for (const w of stale) delete next[w];
      return { attentionByWindow: next };
    }),

  setFilter: (filter) => set({ filter }),

  setFullscreen: (windowId) => set({ fullscreenWindowId: windowId }),
}));
