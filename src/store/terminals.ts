import { create } from "zustand";
import type { Channel } from "@tauri-apps/api/core";

export interface OpenTerminal {
  paneId: string;
  windowId: string;
  workspaceId: string;
  channel: Channel<unknown>;
}

interface TerminalsState {
  panes: OpenTerminal[];
  addPane: (pane: OpenTerminal) => void;
  removePane: (paneId: string) => void;
}

export const useTerminalsStore = create<TerminalsState>((set) => ({
  panes: [],
  addPane: (pane) => set((s) => ({ panes: [...s.panes, pane] })),
  removePane: (paneId) =>
    set((s) => ({ panes: s.panes.filter((p) => p.paneId !== paneId) })),
}));
