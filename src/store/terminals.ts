import { create } from "zustand";
import type { Channel } from "@tauri-apps/api/core";
import { uiStateGet, uiStateSet } from "../lib/ipc";

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
}

const lockKey = (workspaceId: string) => `locked-terminals:${workspaceId}`;

export const useTerminalsStore = create<TerminalsState>((set, get) => ({
  panes: [],
  highlightedWindowId: null,
  focusedWindowId: null,
  lockedByWorkspace: {},
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
}));