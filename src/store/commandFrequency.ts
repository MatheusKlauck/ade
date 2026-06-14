import { create } from "zustand";
import { uiStateGet, uiStateSet } from "../lib/ipc";

// Tracks how often each command line is run in a terminal, keyed by workspace
// (the closest "project" notion here — every pane carries a workspaceId). The
// counts drive the quick-command bar under each grid terminal, surfacing the
// commands you actually use most so a click re-runs them. Persisted to ui_state
// like the rest of the per-workspace terminal state (locks, names, layout).

const MAX_STORED = 40;
// Below this length a "command" is almost always noise (a stray keystroke, a
// bare "y"); above it, it's usually a one-off long invocation not worth a chip.
const MIN_LEN = 2;
const MAX_LEN = 120;

const freqKey = (workspaceId: string) => `command-freq:${workspaceId}`;

type CountMap = Record<string, number>;

// Keep only the `n` highest-count entries so the stored map can't grow without
// bound as a workspace accumulates one-off commands over its lifetime.
function pruneTop(map: CountMap, n: number): CountMap {
  const entries = Object.entries(map);
  if (entries.length <= n) return map;
  const kept = entries.sort((a, b) => b[1] - a[1]).slice(0, n);
  return Object.fromEntries(kept);
}

// Sanitise a parsed JSON blob into a clean CountMap (drop non-numeric / non-
// positive values), so a corrupt or hand-edited ui_state row can't poison the
// ranking.
function sanitize(raw: unknown): CountMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: CountMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

// The N most-used commands for a workspace, highest first. Ties keep insertion
// order, which is good enough — exact tie-breaking isn't worth the churn.
export function topCommands(
  map: CountMap | undefined,
  n: number
): { cmd: string; count: number }[] {
  if (!map) return [];
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([cmd, count]) => ({ cmd, count }));
}

interface CommandFreqState {
  // workspaceId → (command line → run count).
  freqByWorkspace: Record<string, CountMap>;
  // Workspaces whose persisted counts have been loaded (or are loading), so
  // several panes sharing a workspace don't each fire the ui_state read.
  loaded: Record<string, boolean>;
  // Record one run of `command` in `workspaceId` (increment + persist).
  record: (workspaceId: string, command: string) => void;
  // Load persisted counts for a workspace from ui_state (merging any counts
  // already recorded this session). Idempotent per workspace.
  load: (workspaceId: string) => Promise<void>;
  // Clear all recorded counts for a workspace (in-memory + persisted), emptying
  // its quick-command bar.
  reset: (workspaceId: string) => void;
}

export const useCommandFreqStore = create<CommandFreqState>((set, get) => ({
  freqByWorkspace: {},
  loaded: {},
  record: (workspaceId, command) => {
    const cmd = command.trim();
    if (cmd.length < MIN_LEN || cmd.length > MAX_LEN) return;
    const cur = get().freqByWorkspace[workspaceId] ?? {};
    const next = pruneTop({ ...cur, [cmd]: (cur[cmd] ?? 0) + 1 }, MAX_STORED);
    set((s) => ({
      freqByWorkspace: { ...s.freqByWorkspace, [workspaceId]: next },
    }));
    // Best-effort persistence: a failed write only loses the bump on restart,
    // never breaks the in-memory ranking the bar reads from.
    uiStateSet(freqKey(workspaceId), JSON.stringify(next)).catch(() => {});
  },
  load: async (workspaceId) => {
    if (get().loaded[workspaceId]) return;
    // Mark loaded up front so concurrent panes don't double-read; the merge
    // below preserves anything recorded in the race window.
    set((s) => ({ loaded: { ...s.loaded, [workspaceId]: true } }));
    try {
      const stored = await uiStateGet(freqKey(workspaceId));
      if (!stored) return;
      const fromDisk = sanitize(JSON.parse(stored));
      set((s) => {
        const cur = s.freqByWorkspace[workspaceId] ?? {};
        const merged: CountMap = { ...fromDisk };
        for (const [k, v] of Object.entries(cur)) merged[k] = (merged[k] ?? 0) + v;
        return {
          freqByWorkspace: {
            ...s.freqByWorkspace,
            [workspaceId]: pruneTop(merged, MAX_STORED),
          },
        };
      });
    } catch {
      // No stored state or malformed JSON — start from whatever's in memory.
    }
  },
  reset: (workspaceId) => {
    set((s) => ({
      freqByWorkspace: { ...s.freqByWorkspace, [workspaceId]: {} },
    }));
    uiStateSet(freqKey(workspaceId), JSON.stringify({})).catch(() => {});
  },
}));
