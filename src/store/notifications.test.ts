import { describe, it, expect } from "vitest";
import { useNotificationsStore } from "../store/notifications";

function resetStore() {
  useNotificationsStore.setState({ history: [], unread: 0 });
}

describe("notifications store", () => {
  it("pushes a notification and increments unread", () => {
    resetStore();
    const { push } = useNotificationsStore.getState();
    push("error", "TMUX_TOO_OLD", "tmux 2.9a is too old");
    const state = useNotificationsStore.getState();
    expect(state.history).toHaveLength(1);
    expect(state.history[0].code).toBe("TMUX_TOO_OLD");
    expect(state.history[0].message).toBe("tmux 2.9a is too old");
    expect(state.unread).toBe(1);
  });

  it("increments unread for each push", () => {
    resetStore();
    const { push } = useNotificationsStore.getState();
    push("warn", "TOKEN_INVALID", "bad token");
    push("info", "BRANCH_EXISTS_REUSED", "branch reused");
    const state = useNotificationsStore.getState();
    expect(state.history).toHaveLength(2);
    expect(state.unread).toBe(2);
  });

  it("markAllRead resets unread to 0", () => {
    resetStore();
    const { push, markAllRead } = useNotificationsStore.getState();
    push("error", "DB_ERROR", "db fail");
    expect(useNotificationsStore.getState().unread).toBe(1);
    markAllRead();
    expect(useNotificationsStore.getState().unread).toBe(0);
    // History is preserved
    expect(useNotificationsStore.getState().history).toHaveLength(1);
  });

  it("clear empties history and resets unread", () => {
    resetStore();
    const { push, clear } = useNotificationsStore.getState();
    push("warn", "INTENT_DROPPED", "dropped");
    push("error", "TOKEN_INVALID", "invalid");
    clear();
    const state = useNotificationsStore.getState();
    expect(state.history).toHaveLength(0);
    expect(state.unread).toBe(0);
  });

  it("caps history at 200", () => {
    resetStore();
    const { push } = useNotificationsStore.getState();
    for (let i = 0; i < 210; i++) {
      push("info", "INTERNAL", `msg ${i}`);
    }
    const state = useNotificationsStore.getState();
    expect(state.history).toHaveLength(200);
    // Most recent should be first
    expect(state.history[0].message).toBe("msg 209");
    // Oldest kept should be msg 10 (210 - 200)
    expect(state.history[199].message).toBe("msg 10");
  });
});