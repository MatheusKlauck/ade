import { create } from "zustand";
import type { Channel } from "@tauri-apps/api/core";

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
  addPane: (pane: OpenTerminal) => void;
  removePane: (paneId: string) => void;
  // Remove all panes for a workspace (called when switching away)
  removePanesForWorkspace: (workspaceId: string) => OpenTerminal[];
  // Get panes for a specific workspace
  getPanesForWorkspace: (workspaceId: string) => OpenTerminal[];
  // Signal that a specific window should be highlighted
  focusWindow: (windowId: string) => void;
  clearHighlight: () => void;
}

export const useTerminalsStore = create<TerminalsState>((set, get) => ({
  panes: [],
  highlightedWindowId: null,
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
}));