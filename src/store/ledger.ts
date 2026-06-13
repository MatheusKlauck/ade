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
 * Ledger view state: the stage (terminal panels + tabs), the per-terminal
 * attention flags, and the row filter.
 *
 *   StageState
 *   ┌─────────────────────────────┬─────────────────────────────┐
 *   │ panel 0                     │ panel 1 (optional)          │
 *   │ tabs: [win-a, win-b]        │ tabs: [win-c]               │
 *   │ active: win-a  ──► visible  │ active: win-c  ──► visible  │
 *   └─────────────────────────────┴─────────────────────────────┘
 *   Inactive tabs stay mounted (display:none) so their PTY survives —
 *   same invariant the old terminal grid kept.
 */

export interface StagePanel {
  tabs: string[]; // windowIds, in tab order
  active: string | null; // the visible tab; must be ∈ tabs (normalize enforces)
}

export interface StageState {
  panels: StagePanel[]; // 0..MAX_PANELS
}

export const MAX_PANELS = 2;

/** Where a window currently lives in the stage, or null when unplaced. */
export function locateTab(
  stage: StageState,
  windowId: string
): { panelIdx: number; isActive: boolean } | null {
  for (let i = 0; i < stage.panels.length; i++) {
    if (stage.panels[i].tabs.includes(windowId)) {
      return { panelIdx: i, isActive: stage.panels[i].active === windowId };
    }
  }
  return null;
}

// Reconcile a (possibly stale or empty) stage against the live set of open
// windows: drop tabs whose window is gone, de-dupe, drop emptied panels, cap
// the panel count, place any window the stage doesn't know yet (it becomes
// the active tab of the smaller panel, so a freshly-opened terminal is
// immediately visible). Pure + idempotent, so the render path can normalise
// on every pass and the persistence effect can compare in/out to decide
// whether to write.
export function normalizeStage(
  stage: StageState,
  windowIds: string[]
): StageState {
  const present = new Set(windowIds);
  const seen = new Set<string>();
  let panels: StagePanel[] = [];

  for (const panel of stage.panels ?? []) {
    const tabs: string[] = [];
    for (const w of panel.tabs ?? []) {
      if (typeof w !== "string" || !present.has(w) || seen.has(w)) continue;
      seen.add(w);
      tabs.push(w);
    }
    if (tabs.length > 0) {
      panels.push({
        tabs,
        active: panel.active && tabs.includes(panel.active) ? panel.active : tabs[0],
      });
    }
  }

  // Cap: merge overflow panels into the last kept one.
  if (panels.length > MAX_PANELS) {
    const kept = panels.slice(0, MAX_PANELS);
    for (const extra of panels.slice(MAX_PANELS)) {
      kept[MAX_PANELS - 1].tabs.push(...extra.tabs);
    }
    panels = kept;
  }

  // Place unknown windows: into the panel with fewer tabs (tie → first), as
  // its active tab so a new terminal shows up instead of hiding behind one.
  for (const windowId of windowIds) {
    if (seen.has(windowId)) continue;
    seen.add(windowId);
    if (panels.length === 0) {
      panels.push({ tabs: [windowId], active: windowId });
      continue;
    }
    let target = panels[0];
    for (const p of panels) {
      if (p.tabs.length < target.tabs.length) target = p;
    }
    target.tabs.push(windowId);
    target.active = windowId;
  }

  return { panels };
}

/** Make `windowId` the visible tab of its panel. No-op when unplaced. */
export function activateTab(stage: StageState, windowId: string): StageState {
  const loc = locateTab(stage, windowId);
  if (!loc || loc.isActive) return stage;
  return {
    panels: stage.panels.map((p, i) =>
      i === loc.panelIdx ? { ...p, active: windowId } : p
    ),
  };
}

/** Move a tab into panel `targetIdx` (creating it when it's the next slot and
 * under the cap) and make it that panel's active tab. Emptied panels drop. */
export function moveTabToPanel(
  stage: StageState,
  windowId: string,
  targetIdx: number
): StageState {
  const panels = stage.panels.map((p) => ({ tabs: [...p.tabs], active: p.active }));
  const t = Math.max(0, Math.min(targetIdx, MAX_PANELS - 1));
  const srcIdx = panels.findIndex((p) => p.tabs.includes(windowId));

  if (srcIdx === t && srcIdx !== -1) return activateTab(stage, windowId);

  if (srcIdx !== -1) {
    const src = panels[srcIdx];
    src.tabs = src.tabs.filter((w) => w !== windowId);
    if (src.active === windowId) src.active = src.tabs[0] ?? null;
  }
  while (panels.length <= t && panels.length < MAX_PANELS) {
    panels.push({ tabs: [], active: null });
  }
  const target = panels[Math.min(t, panels.length - 1)];
  target.tabs.push(windowId);
  target.active = windowId;

  return { panels: panels.filter((p) => p.tabs.length > 0) };
}

/** Send a tab to "the other half": with one panel it opens the second; with
 * two it crosses over. A lone tab in a lone panel is a no-op (nothing to
 * split against). */
export function splitOut(stage: StageState, windowId: string): StageState {
  const loc = locateTab(stage, windowId);
  if (!loc) return stage;
  if (stage.panels.length <= 1) {
    return moveTabToPanel(stage, windowId, 1);
  }
  return moveTabToPanel(stage, windowId, loc.panelIdx === 0 ? 1 : 0);
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

export const DEFAULT_ROWS_HEIGHT = 240;

const stageKey = (workspaceId: string) => `ledger-stage:${workspaceId}`;

interface PersistedStage {
  panels: StagePanel[];
  rowsHeight: number;
}

function sanitizeStage(parsed: unknown): PersistedStage {
  const fallback: PersistedStage = { panels: [], rowsHeight: DEFAULT_ROWS_HEIGHT };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
  const obj = parsed as { panels?: unknown; rowsHeight?: unknown };
  const panels: StagePanel[] = [];
  if (Array.isArray(obj.panels)) {
    for (const p of obj.panels) {
      if (!p || typeof p !== "object") continue;
      const tabs = Array.isArray((p as StagePanel).tabs)
        ? (p as StagePanel).tabs.filter((t) => typeof t === "string")
        : [];
      const active = (p as StagePanel).active;
      panels.push({ tabs, active: typeof active === "string" ? active : null });
    }
  }
  const rowsHeight =
    typeof obj.rowsHeight === "number" && obj.rowsHeight > 0
      ? obj.rowsHeight
      : DEFAULT_ROWS_HEIGHT;
  return { panels, rowsHeight };
}

interface LedgerState {
  // Stage per workspace. `undefined` means "not loaded yet" — the render path
  // shows a normalized default but won't persist over it until loadStage runs
  // (same contract the old terminal layout kept).
  stageByWorkspace: Record<string, StageState | undefined>;
  rowsHeightByWorkspace: Record<string, number>;
  attentionByWindow: Record<string, Attention>;
  filter: LedgerFilter;
  // windowId of the terminal covering the whole ledger area, or null.
  fullscreenWindowId: string | null;

  setStage: (workspaceId: string, stage: StageState, persist?: boolean) => void;
  loadStage: (workspaceId: string) => Promise<void>;
  setRowsHeight: (workspaceId: string, height: number) => void;
  setAttention: (windowId: string, kind: AttentionKind, detail?: string) => void;
  clearAttention: (windowId: string) => void;
  // Drop attention entries for windows that no longer exist.
  pruneAttention: (liveWindowIds: string[]) => void;
  setFilter: (filter: LedgerFilter) => void;
  setFullscreen: (windowId: string | null) => void;
}

function persistStage(workspaceId: string, state: LedgerState) {
  const payload: PersistedStage = {
    panels: state.stageByWorkspace[workspaceId]?.panels ?? [],
    rowsHeight: state.rowsHeightByWorkspace[workspaceId] ?? DEFAULT_ROWS_HEIGHT,
  };
  // Best-effort persistence: a failed write only loses the arrangement on the
  // next restart, never breaks the in-memory state the UI reads from.
  uiStateSet(stageKey(workspaceId), JSON.stringify(payload)).catch(() => {});
}

export const useLedgerStore = create<LedgerState>((set, get) => ({
  stageByWorkspace: {},
  rowsHeightByWorkspace: {},
  attentionByWindow: {},
  filter: "all",
  fullscreenWindowId: null,

  setStage: (workspaceId, stage, persist = true) => {
    set((s) => ({
      stageByWorkspace: { ...s.stageByWorkspace, [workspaceId]: stage },
    }));
    if (persist) persistStage(workspaceId, get());
  },

  loadStage: async (workspaceId) => {
    let loaded: PersistedStage = { panels: [], rowsHeight: DEFAULT_ROWS_HEIGHT };
    try {
      const stored = await uiStateGet(stageKey(workspaceId));
      loaded = sanitizeStage(stored ? JSON.parse(stored) : null);
    } catch {
      // No stored state or malformed JSON — start from the default; the render
      // path normalizes against the open windows.
    }
    set((s) => ({
      stageByWorkspace: {
        ...s.stageByWorkspace,
        [workspaceId]: { panels: loaded.panels },
      },
      rowsHeightByWorkspace: {
        ...s.rowsHeightByWorkspace,
        [workspaceId]: loaded.rowsHeight,
      },
    }));
  },

  setRowsHeight: (workspaceId, height) => {
    set((s) => ({
      rowsHeightByWorkspace: { ...s.rowsHeightByWorkspace, [workspaceId]: height },
    }));
    persistStage(workspaceId, get());
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
