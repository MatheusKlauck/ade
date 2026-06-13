import { describe, it, expect } from "vitest";
import {
  normalizeExpanded,
  toggleExpanded,
  withExpanded,
  sanitizeExpanded,
  sortRows,
  filterRows,
  rowCounts,
  useLedgerStore,
  DEFAULT_ACCORDION_HEIGHT,
  type LedgerRowModel,
} from "./ledger";
import type { Card } from "../lib/ipc";

describe("normalizeExpanded", () => {
  it("drops windowIds that are no longer open", () => {
    const out = normalizeExpanded(new Set(["a", "b", "gone"]), ["a", "b"]);
    expect([...out].sort()).toEqual(["a", "b"]);
  });

  it("keeps every still-live window", () => {
    const out = normalizeExpanded(new Set(["a", "b"]), ["a", "b", "c"]);
    expect([...out].sort()).toEqual(["a", "b"]);
  });

  it("is idempotent", () => {
    const once = normalizeExpanded(new Set(["a", "b"]), ["a", "b"]);
    const twice = normalizeExpanded(once, ["a", "b"]);
    expect([...twice]).toEqual([...once]);
  });

  it("returns a new Set (never mutates its input)", () => {
    const src = new Set(["a"]);
    expect(normalizeExpanded(src, ["a"])).not.toBe(src);
  });
});

describe("toggleExpanded", () => {
  it("adds when absent", () => {
    expect([...toggleExpanded(new Set(["a"]), "b")].sort()).toEqual(["a", "b"]);
  });

  it("removes when present", () => {
    expect([...toggleExpanded(new Set(["a", "b"]), "b")]).toEqual(["a"]);
  });

  it("returns a new Set", () => {
    const s = new Set(["a"]);
    expect(toggleExpanded(s, "b")).not.toBe(s);
  });
});

describe("withExpanded", () => {
  it("adds when absent", () => {
    expect([...withExpanded(new Set(["a"]), "b")].sort()).toEqual(["a", "b"]);
  });

  it("is identity-stable when already present (no render churn)", () => {
    const s = new Set(["a"]);
    expect(withExpanded(s, "a")).toBe(s);
  });
});

describe("sanitizeExpanded", () => {
  it("falls back on garbage", () => {
    expect(sanitizeExpanded("nope")).toEqual({
      expanded: [],
      accordionHeight: DEFAULT_ACCORDION_HEIGHT,
    });
  });

  it("filters non-string entries and clamps a bad height", () => {
    expect(
      sanitizeExpanded({ expanded: ["a", 7, null], accordionHeight: -5 })
    ).toEqual({ expanded: ["a"], accordionHeight: DEFAULT_ACCORDION_HEIGHT });
  });

  it("passes through a well-formed payload", () => {
    expect(
      sanitizeExpanded({ expanded: ["a", "b"], accordionHeight: 300 })
    ).toEqual({ expanded: ["a", "b"], accordionHeight: 300 });
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

// ---- expansion store actions ----

describe("expansion store", () => {
  it("toggles, expands idempotently, and persists height in state", () => {
    const st = useLedgerStore.getState();
    st.setExpanded("ws-x", new Set(), false);

    st.toggleExpandedWindow("ws-x", "w1");
    expect([...useLedgerStore.getState().expandedByWorkspace["ws-x"]!]).toEqual([
      "w1",
    ]);

    st.expandWindow("ws-x", "w1"); // already there — stays a single entry
    expect([...useLedgerStore.getState().expandedByWorkspace["ws-x"]!]).toEqual([
      "w1",
    ]);

    st.expandWindow("ws-x", "w2");
    expect(
      [...useLedgerStore.getState().expandedByWorkspace["ws-x"]!].sort()
    ).toEqual(["w1", "w2"]);

    st.toggleExpandedWindow("ws-x", "w1");
    expect([...useLedgerStore.getState().expandedByWorkspace["ws-x"]!]).toEqual([
      "w2",
    ]);

    st.setAccordionHeight("ws-x", 420);
    expect(useLedgerStore.getState().accordionHeightByWorkspace["ws-x"]).toBe(
      420
    );
  });
});
