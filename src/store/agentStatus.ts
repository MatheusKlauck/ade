import { useEffect } from "react";
import { create } from "zustand";
import { gestorTasksList, subscribeFeed, type AgentTask } from "../lib/ipc";

// Card-level Gestor status for the board badge. Keyed by card_id → FSM state,
// holding only non-terminal tasks (a shipped/failed task shows no badge). Fed by
// gestor_tasks_list and refreshed on every evt:feed (cheap: in-memory SQLite).

const TERMINAL = new Set(["done", "failed", "aborted"]);

interface AgentStatusState {
  byCard: Record<string, string>;
  setTasks: (tasks: AgentTask[]) => void;
}

export const useAgentStatusStore = create<AgentStatusState>((set) => ({
  byCard: {},
  setTasks: (tasks) => {
    const byCard: Record<string, string> = {};
    for (const t of tasks) {
      if (!TERMINAL.has(t.state)) byCard[t.card_id] = t.state;
    }
    set({ byCard });
  },
}));

/** Mount once (e.g. in App) with the active workspace to keep badges live. */
export function useAgentStatusSync(workspaceId: string | null) {
  const setTasks = useAgentStatusStore((s) => s.setTasks);
  useEffect(() => {
    if (!workspaceId) {
      setTasks([]);
      return;
    }
    let un: (() => void) | undefined;
    const load = () =>
      gestorTasksList(workspaceId)
        .then(setTasks)
        .catch(() => {});
    load();
    subscribeFeed((ev) => {
      if (ev.workspace_id === workspaceId) load();
    }).then((u) => (un = u));
    return () => un?.();
  }, [workspaceId, setTasks]);
}
