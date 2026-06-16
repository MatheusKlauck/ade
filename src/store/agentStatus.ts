import { useEffect, useRef } from "react";
import { create } from "zustand";
import { gestorTasksList, subscribeFeed, type AgentTask } from "../lib/ipc";

// Card-level Gestor status for the board badge. Keyed by card_id → { state,
// reason } so the card can show WHY it moved (D8: every move is an auditable
// transition). We keep failed/aborted too — those land in Paused and must
// explain themselves; only `done` (shipped) drops the badge. Reasons come from
// the live feed's task_transition events, falling back to the task's fail_reason.

export interface CardAgentStatus {
  state: string;
  reason?: string;
}

interface AgentStatusState {
  byCard: Record<string, CardAgentStatus>;
  setTasks: (tasks: AgentTask[], reasonByTask?: Record<string, string>) => void;
}

export const useAgentStatusStore = create<AgentStatusState>((set) => ({
  byCard: {},
  setTasks: (tasks, reasonByTask) => {
    const byCard: Record<string, CardAgentStatus> = {};
    for (const t of tasks) {
      if (t.state === "done") continue; // shipped → no badge
      byCard[t.card_id] = {
        state: t.state,
        reason: reasonByTask?.[t.id] ?? t.fail_reason ?? undefined,
      };
    }
    set({ byCard });
  },
}));

/** Mount once (e.g. in App) with the active workspace to keep badges live. */
export function useAgentStatusSync(workspaceId: string | null) {
  const setTasks = useAgentStatusStore((s) => s.setTasks);
  // Latest transition reason per task id, accumulated from the feed.
  const reasons = useRef<Record<string, string>>({});

  useEffect(() => {
    reasons.current = {};
    if (!workspaceId) {
      setTasks([]);
      return;
    }
    let un: (() => void) | undefined;
    const load = () =>
      gestorTasksList(workspaceId)
        .then((tasks) => setTasks(tasks, reasons.current))
        .catch(() => {});
    load();
    subscribeFeed((ev) => {
      if (ev.workspace_id !== workspaceId) return;
      if (ev.kind === "task_transition" && ev.task_id && ev.payload_json) {
        try {
          const r = JSON.parse(ev.payload_json)?.reason;
          if (typeof r === "string" && r) reasons.current[ev.task_id] = r;
        } catch {
          /* malformed payload — ignore; load() still refreshes state */
        }
      }
      load();
    }).then((u) => (un = u));
    return () => un?.();
  }, [workspaceId, setTasks]);
}
