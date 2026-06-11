import { create } from "zustand";
import { workspaceList, workspaceCreate } from "../lib/ipc";
import type { Workspace } from "../lib/ipc";

interface WorkspacesState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  load: () => Promise<void>;
  setActive: (id: string) => void;
  addWorkspace: (path: string) => Promise<Workspace | null>;
}

export const useWorkspacesStore = create<WorkspacesState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,

  load: async () => {
    const workspaces = await workspaceList();
    set({ workspaces });
    // If there's an active workspace from a previous session, restore it.
    // Otherwise default to the first workspace.
    const current = get().activeWorkspaceId;
    if (!current && workspaces.length > 0) {
      set({ activeWorkspaceId: workspaces[0].id });
    }
  },

  setActive: (id: string) => {
    set({ activeWorkspaceId: id });
  },

  addWorkspace: async (path: string) => {
    try {
      const ws = await workspaceCreate(path);
      set((s) => ({
        workspaces: [...s.workspaces, ws],
        activeWorkspaceId: ws.id,
      }));
      return ws;
    } catch {
      return null;
    }
  },
}));