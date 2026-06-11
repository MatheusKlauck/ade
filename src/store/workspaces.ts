import { create } from "zustand";
import { workspaceList, workspaceCreate, workspaceClose } from "../lib/ipc";
import type { Workspace } from "../lib/ipc";

export interface SyncStatusEntry {
  status: "idle" | "syncing" | "error";
  lastSync?: string;
}

interface WorkspacesState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  syncStatus: Record<string, SyncStatusEntry>;
  load: () => Promise<void>;
  setActive: (id: string) => void;
  addWorkspace: (path: string) => Promise<Workspace | null>;
  closeWorkspace: (id: string) => Promise<void>;
  updateSyncStatus: (workspaceId: string, status: string, lastSync?: string) => void;
}

export const useWorkspacesStore = create<WorkspacesState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  syncStatus: {},

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
      // The backend reuses an existing workspace for the same folder (reopening
      // a closed one), so guard against pushing a duplicate when it's already
      // in the list — just focus it.
      set((s) => ({
        workspaces: s.workspaces.some((w) => w.id === ws.id)
          ? s.workspaces
          : [...s.workspaces, ws],
        activeWorkspaceId: ws.id,
      }));
      return ws;
    } catch {
      return null;
    }
  },

  closeWorkspace: async (id: string) => {
    try {
      await workspaceClose(id);
    } catch {
      // Backend failed to close — leave the workspace in place.
      return;
    }
    set((s) => {
      const remaining = s.workspaces.filter((w) => w.id !== id);
      const activeWorkspaceId =
        s.activeWorkspaceId === id
          ? remaining[0]?.id ?? null
          : s.activeWorkspaceId;
      return { workspaces: remaining, activeWorkspaceId };
    });
  },

  updateSyncStatus: (workspaceId: string, status: string, lastSync?: string) => {
    set((s) => ({
      syncStatus: {
        ...s.syncStatus,
        [workspaceId]: { status: status as SyncStatusEntry["status"], lastSync },
      },
    }));
  },
}));