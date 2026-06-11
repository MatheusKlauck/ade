import { create } from "zustand";

// Notification codes from CONTRACTS §7 (exhaustive)
export type NotifyCode =
  | "TMUX_MISSING"
  | "TMUX_TOO_OLD"
  | "TOKEN_INVALID"
  | "TOKEN_SCOPE"
  | "RATE_LIMITED"
  | "SYNC_WRITE_FAILED"
  | "INTENT_DROPPED"
  | "BRANCH_DIRTY_WORKTREE"
  | "BRANCH_EXISTS_REUSED"
  | "ISSUE_LIST_LARGE"
  | "REMOTE_NOT_GITHUB"
  | "DB_ERROR"
  | "INTERNAL";

export type NotifyLevel = "info" | "warn" | "error";

export interface Notification {
  level: NotifyLevel;
  code: NotifyCode;
  message: string;
  timestamp: number; // Date.now()
}

const MAX_HISTORY = 200;

interface NotificationsState {
  history: Notification[];
  unread: number;

  push: (level: NotifyLevel, code: NotifyCode, message: string) => void;
  markAllRead: () => void;
  clear: () => void;
}

export const useNotificationsStore = create<NotificationsState>((set) => ({
  history: [],
  unread: 0,

  push: (level, code, message) =>
    set((state) => {
      const entry: Notification = {
        level,
        code,
        message,
        timestamp: Date.now(),
      };
      const history = [entry, ...state.history];
      // Cap at MAX_HISTORY
      if (history.length > MAX_HISTORY) {
        history.length = MAX_HISTORY;
      }
      return { history, unread: state.unread + 1 };
    }),

  markAllRead: () => set({ unread: 0 }),

  clear: () => set({ history: [], unread: 0 }),
}));