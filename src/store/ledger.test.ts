import { describe, it, expect } from "vitest";
import {
  normalizeStage,
  activateTab,
  moveTabToPanel,
  splitOut,
  locateTab,
  sortRows,
  filterRows,
  rowCounts,
  useLedgerStore,
  MAX_PANELS,
  type StageState,
  type LedgerRowModel,
} from "./ledger";
import type { Card } from "../lib/ipc";

const stage = (panels: StageState["panels"]): StageState => ({ panels });

describe("normalizeStage", () => {
  it("places all windows into one panel when stage is empty", () => {
    const out = normalizeStage(stage([]), ["a", "b"]);
    expect(out.panels).toHaveLength(1);
    expect(out.panels[0].tabs).toEqual(["a", "b"]);
    // The last appended window becomes active so a fresh terminal is visible.
    expect(out.panels[0].active).toBe("b");
  });

  it("returns zero panels when there are no windows", () => {
    const out = normalizeStage(
      stage([{ tabs: ["a"], active: "a" }]),
      []
    );
    expect(out.panels).toEqual([]);
  });

  it("drops stale tabs and emptied panels", () => {
    const out = normalizeStage(
      stage([
        { tabs: ["gone"], active: "gone" },
        { tabs: ["a"], active: "a" },
      ]),
      ["a"]
    );
    expect(out.panels).toEqual([{ tabs: ["a"], active: "a" }]);
  });

  it("dedupes a window that appears in two panels (first wins)", () => {
    const out = normalizeStage(
      stage([
        { tabs: ["a"], active: "a" },
        { tabs: ["a", "b"], active: "b" },
      ]),
      ["a", "b"]
    );
    expect(out.panels[0].tabs).toEqual(["a"]);
    expect(out.panels[1].tabs).toEqual(["b"]);
  });

  it("caps panels at MAX_PANELS, merging overflow into the last", () => {
    const out = normalizeStage(
      stage([
        { tabs: ["a"], active: "a" },
        { tabs: ["b"], active: "b" },
        { tabs: ["c"], active: "c" },
      ]),
      ["a", "b", "c"]
    );
    expect(out.panels).toHaveLength(MAX_PANELS);
    expect(out.panels[1].tabs).toEqual(["b", "c"]);
  });

  it("repairs an active that is not in tabs", () => {
    const out = normalizeStage(
      stage([{ tabs: ["a", "b"], active: "zzz" }]),
      ["a", "b"]
    );
    expect(out.panels[0].active).toBe("a");
  });

  it("appends unknown windows to the smaller panel and activates them", () => {
    const out = normalizeStage(
      stage([
        { tabs: ["a", "b"], active: "a" },
        { tabs: ["c"], active: "c" },
      ]),
      ["a", "b", "c", "new"]
    );
    expect(out.panels[1].tabs).toEqual(["c", "new"]);
    expect(out.panels[1].active).toBe("new");
    expect(out.panels[0].active).toBe("a");
  });

  it("is idempotent", () => {
    const once = normalizeStage(stage([{ tabs: ["b", "a"], active: "a" }]), ["a", "b", "c"]);
    const twice = normalizeStage(once, ["a", "b", "c"]);
    expect(twice).toEqual(once);
  });

  it("survives garbage tab entries", () => {
    const dirty = {
      panels: [{ tabs: ["a", 42 as unknown as string, null as unknown as string], active: "a" }],
    };
    const out = normalizeStage(dirty, ["a"]);
    expect(out.panels).toEqual([{ tabs: ["a"], active: "a" }]);
  });
});

describe("activateTab", () => {
  it("activates a tab within its panel", () => {
    const out = activateTab(stage([{ tabs: ["a", "b"], active: "a" }]), "b");
    expect(out.panels[0].active).toBe("b");
  });

  it("is a no-op for unknown windows and already-active tabs", () => {
    const s = stage([{ tabs: ["a"], active: "a" }]);
    expect(activateTab(s, "zzz")).toBe(s);
    expect(activateTab(s, "a")).toBe(s);
  });
});

describe("moveTabToPanel", () => {
  it("creates the second panel when targeting the next slot", () => {
    const out = moveTabToPanel(stage([{ tabs: ["a", "b"], active: "a" }]), "b", 1);
    expect(out.panels).toHaveLength(2);
    expect(out.panels[0]).toEqual({ tabs: ["a"], active: "a" });
    expect(out.panels[1]).toEqual({ tabs: ["b"], active: "b" });
  });

  it("moves across panels and fixes the source active", () => {
    const out = moveTabToPanel(
      stage([
        { tabs: ["a", "b"], active: "b" },
        { tabs: ["c"], active: "c" },
      ]),
      "b",
      1
    );
    expect(out.panels[0]).toEqual({ tabs: ["a"], active: "a" });
    expect(out.panels[1]).toEqual({ tabs: ["c", "b"], active: "b" });
  });

  it("collapses to one panel when the source empties", () => {
    const out = moveTabToPanel(
      stage([
        { tabs: ["a"], active: "a" },
        { tabs: ["b"], active: "b" },
      ]),
      "a",
      1
    );
    expect(out.panels).toHaveLength(1);
    expect(out.panels[0].tabs).toEqual(["b", "a"]);
    expect(out.panels[0].active).toBe("a");
  });

  it("same-panel move just activates", () => {
    const out = moveTabToPanel(stage([{ tabs: ["a", "b"], active: "a" }]), "b", 0);
    expect(out.panels[0]).toEqual({ tabs: ["a", "b"], active: "b" });
  });

  it("clamps the target index to MAX_PANELS", () => {
    const out = moveTabToPanel(stage([{ tabs: ["a", "b"], active: "a" }]), "b", 99);
    expect(out.panels).toHaveLength(2);
    expect(out.panels[1].tabs).toEqual(["b"]);
  });
});

describe("splitOut", () => {
  it("opens the second panel from a single panel", () => {
    const out = splitOut(stage([{ tabs: ["a", "b"], active: "a" }]), "b");
    expect(out.panels).toHaveLength(2);
    expect(out.panels[1]).toEqual({ tabs: ["b"], active: "b" });
  });

  it("a lone tab cannot split (round-trips to one panel)", () => {
    const out = splitOut(stage([{ tabs: ["a"], active: "a" }]), "a");
    expect(out.panels).toHaveLength(1);
    expect(out.panels[0].tabs).toEqual(["a"]);
  });

  it("crosses over when two panels exist", () => {
    const out = splitOut(
      stage([
        { tabs: ["a", "b"], active: "a" },
        { tabs: ["c"], active: "c" },
      ]),
      "c"
    );
    expect(out.panels).toHaveLength(1);
    expect(out.panels[0].tabs).toEqual(["a", "b", "c"]);
    expect(out.panels[0].active).toBe("c");
  });

  it("is a no-op for unknown windows", () => {
    const s = stage([{ tabs: ["a"], active: "a" }]);
    expect(splitOut(s, "zzz")).toBe(s);
  });
});

describe("locateTab", () => {
  it("finds panel and active flag", () => {
    const s = stage([
      { tabs: ["a"], active: "a" },
      { tabs: ["b", "c"], active: "c" },
    ]);
    expect(locateTab(s, "b")).toEqual({ panelIdx: 1, isActive: false });
    expect(locateTab(s, "c")).toEqual({ panelIdx: 1, isActive: true });
    expect(locateTab(s, "zzz")).toBeNull();
  });
});

// ---- rows ----

function card(id: string, position = 0, column_id = "col"): Card {
  return {
    id,
    workspace_id: "ws",
    column_id,
    title: id,
    body_preview: null,
    position,
    source: "github",
    github_issue_number: 1,
    github_state: null,
    assignee: null,
    labels_json: null,
    remote_updated_at: null,
    terminal_window_id: null,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };
}

const row = (
  id: string,
  columnName: string,
  position = 0,
  attention?: LedgerRowModel["attention"]
): LedgerRowModel => ({ card: card(id, position), columnName, attention });

describe("sortRows", () => {
  it("puts input-needed first (oldest first), then state order, then position", () => {
    const rows = [
      row("backlog", "Backlog"),
      row("doing-2", "Doing", 2),
      row("input-new", "Backlog", 0, { kind: "input", since: 200 }),
      row("doing-1", "Doing", 1),
      row("input-old", "PR", 0, { kind: "input", since: 100 }),
      row("pr", "PR"),
      row("done", "Done"),
      row("paused", "Paused"),
    ];
    expect(sortRows(rows).map((r) => r.card.id)).toEqual([
      "input-old",
      "input-new",
      "doing-1",
      "doing-2",
      "pr",
      "paused",
      "backlog",
      "done",
    ]);
  });

  it("non-input attention does not re-rank", () => {
    const rows = [
      row("doing", "Doing"),
      row("backlog-done-attn", "Backlog", 0, { kind: "done", since: 1 }),
    ];
    expect(sortRows(rows).map((r) => r.card.id)).toEqual([
      "doing",
      "backlog-done-attn",
    ]);
  });
});

describe("filterRows / rowCounts", () => {
  const rows = [
    row("a", "Doing", 0, { kind: "input", since: 1 }),
    row("b", "Doing"),
    row("c", "PR"),
    row("d", "Paused"),
    row("e", "Backlog"),
    row("f", "Done"),
  ];

  it("'all' excludes Done", () => {
    expect(filterRows(rows, "all").map((r) => r.card.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("'input' returns only attention=input rows", () => {
    expect(filterRows(rows, "input").map((r) => r.card.id)).toEqual(["a"]);
  });

  it("state filters match their column", () => {
    expect(filterRows(rows, "doing")).toHaveLength(2);
    expect(filterRows(rows, "pr")).toHaveLength(1);
    expect(filterRows(rows, "paused")).toHaveLength(1);
    expect(filterRows(rows, "backlog")).toHaveLength(1);
    expect(filterRows(rows, "done")).toHaveLength(1);
  });

  it("counts agree with filters", () => {
    const counts = rowCounts(rows);
    expect(counts).toEqual({
      all: 5,
      input: 1,
      doing: 2,
      pr: 1,
      paused: 1,
      backlog: 1,
      done: 1,
    });
  });
});

// ---- attention store ----

describe("attention store", () => {
  it("set, clear and prune", () => {
    const st = useLedgerStore.getState();
    st.setAttention("w1", "input");
    st.setAttention("w2", "failed", "2");
    expect(useLedgerStore.getState().attentionByWindow.w1.kind).toBe("input");
    expect(useLedgerStore.getState().attentionByWindow.w2.detail).toBe("2");

    st.clearAttention("w1");
    expect(useLedgerStore.getState().attentionByWindow.w1).toBeUndefined();

    st.setAttention("w3", "done");
    st.pruneAttention(["w3"]);
    const after = useLedgerStore.getState().attentionByWindow;
    expect(after.w2).toBeUndefined();
    expect(after.w3.kind).toBe("done");
  });

  it("newer attention overwrites older for the same window", () => {
    const st = useLedgerStore.getState();
    st.setAttention("w9", "done");
    st.setAttention("w9", "input");
    expect(useLedgerStore.getState().attentionByWindow.w9.kind).toBe("input");
  });
});
