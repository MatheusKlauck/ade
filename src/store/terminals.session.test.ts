import { describe, it, expect, beforeEach } from "vitest";
import { useTerminalsStore } from "./terminals";

beforeEach(() => {
  useTerminalsStore.setState({ activityByWindow: {}, sessionIdByWindow: {} });
});

describe("window→session mapping survives a workspace switch", () => {
  it("clearTerminalActivity drops the comet but keeps the session id", () => {
    const s = useTerminalsStore.getState();
    s.setWindowSession("@146", "sess-abc");
    s.bumpTerminalVeil("@146");

    // A workspace switch unmounts the pane, which calls clearTerminalActivity.
    // The tmux window survives, so the session mapping must survive too —
    // otherwise the title reverts to the neutral "Terminal @ @146".
    s.clearTerminalActivity("@146");

    expect(useTerminalsStore.getState().activityByWindow["@146"]).toBeUndefined();
    expect(useTerminalsStore.getState().sessionIdByWindow["@146"]).toBe("sess-abc");
  });
});
