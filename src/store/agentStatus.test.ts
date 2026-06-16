import { describe, it, expect, beforeEach } from "vitest";
import { useAgentStatusStore } from "./agentStatus";
import type { AgentTask } from "../lib/ipc";

function task(
  card_id: string,
  state: string,
  fail_reason: string | null = null,
): AgentTask {
  return { id: card_id + "-t", card_id, state, fail_reason } as AgentTask;
}

describe("agentStatus store", () => {
  beforeEach(() => useAgentStatusStore.setState({ byCard: {} }));

  it("keys active tasks by card_id", () => {
    useAgentStatusStore
      .getState()
      .setTasks([task("c1", "working"), task("c2", "verifying")]);
    expect(useAgentStatusStore.getState().byCard).toEqual({
      c1: { state: "working", reason: undefined },
      c2: { state: "verifying", reason: undefined },
    });
  });

  it("drops only shipped (done); keeps failed/aborted so Paused explains itself", () => {
    useAgentStatusStore
      .getState()
      .setTasks([
        task("c1", "done"),
        task("c2", "failed", "dispatch failed: no main branch"),
        task("c3", "aborted"),
        task("c4", "reviewing"),
      ]);
    expect(useAgentStatusStore.getState().byCard).toEqual({
      c2: { state: "failed", reason: "dispatch failed: no main branch" },
      c3: { state: "aborted", reason: undefined },
      c4: { state: "reviewing", reason: undefined },
    });
  });

  it("prefers the live transition reason over fail_reason", () => {
    useAgentStatusStore
      .getState()
      .setTasks([task("c1", "awaiting_input")], {
        "c1-t": "worker requested input",
      });
    expect(useAgentStatusStore.getState().byCard.c1).toEqual({
      state: "awaiting_input",
      reason: "worker requested input",
    });
  });
});
