import { describe, it, expect } from "vitest";
import { useBoardStore } from "../store/board";
import type { Card, BoardColumn } from "../lib/ipc";

// Reset the store between tests
function resetStore() {
  useBoardStore.setState({
    boards: {},
    activeWorkspaceId: null,
  });
}

const col1: BoardColumn = { id: "col-1", workspace_id: "ws-1", name: "Backlog", position: 0 };
const col2: BoardColumn = { id: "col-2", workspace_id: "ws-1", name: "Doing", position: 1 };
const col3: BoardColumn = { id: "col-3", workspace_id: "ws-2", name: "Backlog", position: 0 };
const col4: BoardColumn = { id: "col-4", workspace_id: "ws-2", name: "Done", position: 4 };

const cardA: Card = {
  id: "card-a",
  workspace_id: "ws-1",
  column_id: "col-1",
  title: "Task A",
  body_preview: null,
  position: 1024,
  source: "local",
  github_issue_number: null,
  github_state: null,
  assignee: null,
  labels_json: null,
  remote_updated_at: null,
  terminal_window_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const cardB: Card = {
  id: "card-b",
  workspace_id: "ws-2",
  column_id: "col-3",
  title: "Task B",
  body_preview: null,
  position: 1024,
  source: "local",
  github_issue_number: null,
  github_state: null,
  assignee: null,
  labels_json: null,
  remote_updated_at: null,
  terminal_window_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("board store (per-workspace)", () => {
  it("keeps per-workspace card maps separate", () => {
    resetStore();
    const { setBoard } = useBoardStore.getState();

    setBoard("ws-1", [col1, col2], [cardA]);
    setBoard("ws-2", [col3, col4], [cardB]);

    const state = useBoardStore.getState();
    const ws1Cards = state.boards["ws-1"]?.cardsByColumn["col-1"] || [];
    const ws2Cards = state.boards["ws-2"]?.cardsByColumn["col-3"] || [];

    expect(ws1Cards).toHaveLength(1);
    expect(ws1Cards[0].id).toBe("card-a");
    expect(ws2Cards).toHaveLength(1);
    expect(ws2Cards[0].id).toBe("card-b");
  });

  it("does not mix cards between workspaces", () => {
    resetStore();
    const { setBoard } = useBoardStore.getState();

    setBoard("ws-1", [col1, col2], [cardA]);
    setBoard("ws-2", [col3, col4], [cardB]);

    const state = useBoardStore.getState();

    // ws-1 should NOT have col-3 (which belongs to ws-2)
    expect(state.boards["ws-1"]?.cardsByColumn["col-3"]).toBeUndefined();
    // ws-2 should NOT have col-1 (which belongs to ws-1)
    expect(state.boards["ws-2"]?.cardsByColumn["col-1"]).toBeUndefined();
  });

  it("optimisticMove is scoped to the correct workspace", () => {
    resetStore();
    const { setBoard, optimisticMove } = useBoardStore.getState();

    setBoard("ws-1", [col1, col2], [cardA]);
    setBoard("ws-2", [col3, col4], [cardB]);

    // Move card-a from Backlog to Doing in ws-1
    optimisticMove("ws-1", "card-a", "col-2", undefined, undefined);

    const state = useBoardStore.getState();

    // ws-1: card-a moved to Doing
    expect(state.boards["ws-1"]?.cardsByColumn["col-2"]).toHaveLength(1);
    expect(state.boards["ws-1"]?.cardsByColumn["col-1"]).toHaveLength(0);

    // ws-2: unaffected
    expect(state.boards["ws-2"]?.cardsByColumn["col-3"]).toHaveLength(1);
    expect(state.boards["ws-2"]?.cardsByColumn["col-3"]?.[0]?.id).toBe("card-b");
  });

  it("setBoard replaces the workspace's cards without touching other workspaces", () => {
    resetStore();
    const { setBoard } = useBoardStore.getState();

    setBoard("ws-1", [col1, col2], [cardA]);
    setBoard("ws-2", [col3, col4], [cardB]);

    // Update ws-1 with new data
    const cardA2: Card = { ...cardA, title: "Task A Updated" };
    setBoard("ws-1", [col1, col2], [cardA2]);

    const state = useBoardStore.getState();

    // ws-1 updated
    expect(state.boards["ws-1"]?.cardsByColumn["col-1"]?.[0]?.title).toBe("Task A Updated");
    // ws-2 untouched
    expect(state.boards["ws-2"]?.cardsByColumn["col-3"]?.[0]?.title).toBe("Task B");
  });
});