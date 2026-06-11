import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Workspace } from "../lib/ipc";

// Mock the IPC layer so the store can be exercised without a Tauri backend.
const workspaceCloseMock = vi.fn();
const workspaceCreateMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  workspaceList: vi.fn().mockResolvedValue([]),
  workspaceCreate: (...a: unknown[]) => workspaceCreateMock(...a),
  workspaceClose: (...a: unknown[]) => workspaceCloseMock(...a),
}));

import { useWorkspacesStore } from "./workspaces";

function ws(id: string): Workspace {
  return {
    id,
    name: id,
    slug: id,
    root_path: `/tmp/${id}`,
    github_owner: null,
    github_repo: null,
    startup_command: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function reset(workspaces: Workspace[], activeWorkspaceId: string | null) {
  useWorkspacesStore.setState({ workspaces, activeWorkspaceId, syncStatus: {} });
}

describe("closeWorkspace", () => {
  beforeEach(() => {
    workspaceCloseMock.mockReset().mockResolvedValue(undefined);
  });

  it("removes the workspace and reassigns active when the active tab is closed", async () => {
    reset([ws("a"), ws("b"), ws("c")], "a");
    await useWorkspacesStore.getState().closeWorkspace("a");
    const s = useWorkspacesStore.getState();
    expect(s.workspaces.map((w) => w.id)).toEqual(["b", "c"]);
    expect(s.activeWorkspaceId).toBe("b");
    expect(workspaceCloseMock).toHaveBeenCalledWith("a");
  });

  it("keeps the active tab when closing a different workspace", async () => {
    reset([ws("a"), ws("b")], "a");
    await useWorkspacesStore.getState().closeWorkspace("b");
    const s = useWorkspacesStore.getState();
    expect(s.workspaces.map((w) => w.id)).toEqual(["a"]);
    expect(s.activeWorkspaceId).toBe("a");
  });

  it("sets active to null when the last workspace is closed", async () => {
    reset([ws("a")], "a");
    await useWorkspacesStore.getState().closeWorkspace("a");
    const s = useWorkspacesStore.getState();
    expect(s.workspaces).toEqual([]);
    expect(s.activeWorkspaceId).toBeNull();
  });

  it("leaves state untouched if the backend close fails", async () => {
    workspaceCloseMock.mockRejectedValueOnce(new Error("db locked"));
    reset([ws("a"), ws("b")], "a");
    await useWorkspacesStore.getState().closeWorkspace("a");
    const s = useWorkspacesStore.getState();
    expect(s.workspaces.map((w) => w.id)).toEqual(["a", "b"]);
    expect(s.activeWorkspaceId).toBe("a");
  });
});

describe("addWorkspace dedupe", () => {
  beforeEach(() => {
    workspaceCreateMock.mockReset();
  });

  it("does not push a duplicate when the backend returns an existing workspace", async () => {
    reset([ws("a")], "a");
    workspaceCreateMock.mockResolvedValueOnce(ws("a")); // reopened / same folder
    await useWorkspacesStore.getState().addWorkspace("/tmp/a");
    const s = useWorkspacesStore.getState();
    expect(s.workspaces.map((w) => w.id)).toEqual(["a"]);
    expect(s.activeWorkspaceId).toBe("a");
  });

  it("appends and focuses a genuinely new workspace", async () => {
    reset([ws("a")], "a");
    workspaceCreateMock.mockResolvedValueOnce(ws("b"));
    await useWorkspacesStore.getState().addWorkspace("/tmp/b");
    const s = useWorkspacesStore.getState();
    expect(s.workspaces.map((w) => w.id)).toEqual(["a", "b"]);
    expect(s.activeWorkspaceId).toBe("b");
  });
});
