import { create } from "zustand";
import { workspaceList, workspaceCreate, workspaceClose } from "../lib/ipc";
import type { Workspace } from "../lib/ipc";

export interface SyncStatusEntry {
  status: "idle" | "syncing" | "error";
  lastSync?: string;
}

// Unseen terminal completions for a workspace, shown as a badge on its pill.
export interface TerminalAlerts {
  count: number;
  messages: string[];
}

interface WorkspacesState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  syncStatus: Record<string, SyncStatusEntry>;
  terminalAlerts: Record<string, TerminalAlerts>;
  load: () => Promise<void>;
  setActive: (id: string) => void;
  addWorkspace: (path: string) => Promise<Workspace | null>;
  closeWorkspace: (id: string) => Promise<void>;
  updateSyncStatus: (workspaceId: string, status: string, lastSync?: string) => void;
  pushTerminalAlert: (workspaceId: string, message: string) => void;
  clearTerminalAlerts: (workspaceId: string) => void;
}

const MAX_ALERT_MESSAGES = 20;

export const useWorkspacesStore = create<WorkspacesState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  syncStatus: {},
  terminalAlerts: {},

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
    // Visiting a workspace means you've seen its completions — drop the badge.
    get().clearTerminalAlerts(id);
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

  pushTerminalAlert: (workspaceId: string, message: string) => {
    set((s) => {
      const cur = s.terminalAlerts[workspaceId] ?? { count: 0, messages: [] };
      const messages = [message, ...cur.messages].slice(0, MAX_ALERT_MESSAGES);
      return {
        terminalAlerts: {
          ...s.terminalAlerts,
          [workspaceId]: { count: cur.count + 1, messages },
        },
      };
    });
  },

  clearTerminalAlerts: (workspaceId: string) => {
    set((s) => {
      if (!s.terminalAlerts[workspaceId]) return s;
      const next = { ...s.terminalAlerts };
      delete next[workspaceId];
      return { terminalAlerts: next };
    });
  },
}));