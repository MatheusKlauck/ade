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
  // False until the first load() settles. The shell uses this to tell "still
  // hydrating" apart from "genuinely no workspaces", so a returning user never
  // flashes the onboarding screen on cold start.
  loaded: boolean;
  syncStatus: Record<string, SyncStatusEntry>;
  terminalAlerts: Record<string, TerminalAlerts>;
  // Viewer-INDEPENDENT activity, driven by the backend term_monitor's
  // started/completed events (not the frontend xterm heuristic, which dies when
  // a workspace's panes unmount on switch). Lets a background workspace's tab
  // surface that its agents are still working / just finished.
  // workspaceId → set of window ids currently between a "started" and its
  // "completed". The tab's comet shows while this set is non-empty.
  busyWindows: Record<string, Set<string>>;
  // workspaceId → monotonically increasing counter, bumped on each completion.
  // Used as a React key on the tab's veil element so a bump replays the sweep.
  terminalVeils: Record<string, number>;
  load: () => Promise<void>;
  setActive: (id: string) => void;
  addWorkspace: (path: string) => Promise<Workspace | null>;
  closeWorkspace: (id: string) => Promise<void>;
  updateSyncStatus: (workspaceId: string, status: string, lastSync?: string) => void;
  pushTerminalAlert: (workspaceId: string, message: string) => void;
  clearTerminalAlerts: (workspaceId: string) => void;
  // A window started a command — mark it busy for its workspace.
  markTerminalStarted: (workspaceId: string, windowId: string) => void;
  // A window finished a command — clear its busy flag and bump the veil counter.
  markTerminalDone: (workspaceId: string, windowId: string) => void;
  // Reconcile busy state when a window goes away without a completion (killed
  // mid-command). Omit windowId to clear the whole workspace.
  clearTerminalBusy: (workspaceId: string, windowId?: string) => void;
}

const MAX_ALERT_MESSAGES = 20;

export const useWorkspacesStore = create<WorkspacesState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  loaded: false,
  syncStatus: {},
  terminalAlerts: {},
  busyWindows: {},
  terminalVeils: {},

  load: async () => {
    try {
      const workspaces = await workspaceList();
      set({ workspaces });
      // If there's an active workspace from a previous session, restore it.
      // Otherwise default to the first workspace.
      const current = get().activeWorkspaceId;
      if (!current && workspaces.length > 0) {
        set({ activeWorkspaceId: workspaces[0].id });
      }
    } catch (e) {
      // Never reject — callers fire-and-forget this, so a thrown error would
      // surface as an unhandled rejection. Log and fall through to `loaded`.
      console.error("workspace list failed", e);
    } finally {
      // Always settle: even if the list fails, mark hydrated so the shell can
      // fall through to the onboarding screen (its folder-open path is the
      // recovery) instead of hanging on the loading shell forever.
      set({ loaded: true });
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
      const busyWindows = { ...s.busyWindows };
      delete busyWindows[id];
      const terminalVeils = { ...s.terminalVeils };
      delete terminalVeils[id];
      return { workspaces: remaining, activeWorkspaceId, busyWindows, terminalVeils };
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

  markTerminalStarted: (workspaceId: string, windowId: string) => {
    set((s) => {
      const cur = s.busyWindows[workspaceId];
      if (cur?.has(windowId)) return s; // already busy — avoid a needless render
      const next = new Set(cur);
      next.add(windowId);
      return { busyWindows: { ...s.busyWindows, [workspaceId]: next } };
    });
  },

  markTerminalDone: (workspaceId: string, windowId: string) => {
    set((s) => {
      // Clear the busy flag (drop the key when the workspace goes idle) and bump
      // the veil counter so the tab replays the attention sweep once.
      const busyWindows = { ...s.busyWindows };
      const cur = busyWindows[workspaceId];
      if (cur?.has(windowId)) {
        const next = new Set(cur);
        next.delete(windowId);
        if (next.size === 0) delete busyWindows[workspaceId];
        else busyWindows[workspaceId] = next;
      }
      return {
        busyWindows,
        terminalVeils: {
          ...s.terminalVeils,
          [workspaceId]: (s.terminalVeils[workspaceId] ?? 0) + 1,
        },
      };
    });
  },

  clearTerminalBusy: (workspaceId: string, windowId?: string) => {
    set((s) => {
      const cur = s.busyWindows[workspaceId];
      if (!cur) return s;
      const busyWindows = { ...s.busyWindows };
      if (windowId === undefined) {
        delete busyWindows[workspaceId];
      } else {
        if (!cur.has(windowId)) return s;
        const next = new Set(cur);
        next.delete(windowId);
        if (next.size === 0) delete busyWindows[workspaceId];
        else busyWindows[workspaceId] = next;
      }
      return { busyWindows };
    });
  },
}));