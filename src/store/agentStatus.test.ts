import { describe, it, expect, beforeEach } from "vitest";
import { useAgentStatusStore } from "./agentStatus";
import type { AgentTask } from "../lib/ipc";

function task(card_id: string, state: string): AgentTask {
  return { id: card_id + "-t", card_id, state } as AgentTask;
}

describe("agentStatus store", () => {
  beforeEach(() => useAgentStatusStore.setState({ byCard: {} }));

  it("keys non-terminal tasks by card_id", () => {
    useAgentStatusStore
      .getState()
      .setTasks([task("c1", "working"), task("c2", "verifying")]);
    expect(useAgentStatusStore.getState().byCard).toEqual({
      c1: "working",
      c2: "verifying",
    });
  });

  it("drops terminal tasks (no badge once shipped/failed)", () => {
    useAgentStatusStore
      .getState()
      .setTasks([
        task("c1", "done"),
        task("c2", "failed"),
        task("c3", "aborted"),
        task("c4", "reviewing"),
      ]);
    expect(useAgentStatusStore.getState().byCard).toEqual({ c4: "reviewing" });
  });
});
