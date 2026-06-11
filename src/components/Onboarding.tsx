import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkspacesStore } from "../store/workspaces";
import type { Workspace } from "../lib/ipc";

export default function Onboarding() {
  const addWorkspace = useWorkspacesStore((s) => s.addWorkspace);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Workspace | null>(null);

  const handleOpen = async () => {
    setError(null);
    setLoading(true);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected || typeof selected !== "string") {
        setLoading(false);
        return;
      }
      const ws = await addWorkspace(selected);
      if (ws) {
        setCreated(ws);
      } else {
        setError("Failed to create workspace. Please try again.");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "An unexpected error occurred.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  if (created) {
    const repoLabel =
      created.github_owner && created.github_repo
        ? `${created.github_owner}/${created.github_repo}`
        : "local only";

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          background: "var(--bg)",
          color: "var(--fg)",
        }}
      >
        <h2 style={{ fontSize: 24, marginBottom: 8 }}>{created.name}</h2>
        <p style={{ fontSize: 14, color: "var(--muted)", marginBottom: 24 }}>{repoLabel}</p>
        <p style={{ fontSize: 13, color: "var(--muted)" }}>Opening workspace…</p>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        background: "var(--bg)",
        color: "var(--fg)",
      }}
    >
      <h2 style={{ fontSize: 24, marginBottom: 16 }}>Welcome to ADE</h2>
      <p style={{ fontSize: 14, marginBottom: 24, color: "var(--muted)" }}>
        Open a folder to create your first workspace.
      </p>
      <button
        onClick={handleOpen}
        disabled={loading}
        style={{
          padding: "10px 24px",
          fontSize: 14,
          background: loading ? "var(--input-bg)" : "var(--accent)",
          color: loading ? "var(--muted)" : "#fff",
          border: "none",
          borderRadius: 6,
          cursor: loading ? "not-allowed" : "pointer",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {loading && (
          <span
            style={{
              display: "inline-block",
              width: 14,
              height: 14,
              border: "2px solid #666",
              borderTopColor: "#fff",
              borderRadius: "50%",
              animation: "spin 0.6s linear infinite",
            }}
          />
        )}
        {loading ? "Creating workspace…" : "Open a folder…"}
      </button>
      {error && (
        <p style={{ fontSize: 13, color: "#e74c3c", marginTop: 16, maxWidth: 320, textAlign: "center" }}>
          {error}
        </p>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}