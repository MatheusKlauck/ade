import { create } from "zustand";
import type { Channel } from "@tauri-apps/api/core";
import { uiStateGet, uiStateSet } from "../lib/ipc";
import type { TerminalPreset } from "./settings";

export interface OpenTerminal {
  paneId: string;
  windowId: string;
  workspaceId: string;
  channel: Channel<unknown>;
}

interface TerminalsState {
  // All open panes across all workspaces
  panes: OpenTerminal[];
  // windowId of the pane that should receive a visual highlight
  highlightedWindowId: string | null;
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
const presetWinKey = (workspaceId: string) =>
  `terminal-presets-by-window:${workspaceId}`;

export const useTerminalsStore = create<TerminalsState>((set, get) => ({
  panes: [],
  highlightedWindowId: null,
  focusedWindowId: null,
  lockedByWorkspace: {},
  namesByWorkspace: {},
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