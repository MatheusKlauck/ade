// M3-T4: Full onboarding UI. Minimal stub for M3-T2 compilation.
import { useWorkspacesStore } from "../store/workspaces";

export default function Onboarding() {
  const addWorkspace = useWorkspacesStore((s) => s.addWorkspace);

  const handleOpen = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      await addWorkspace(selected);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        background: "#1a1a1a",
        color: "#ccc",
      }}
    >
      <h2 style={{ fontSize: 24, marginBottom: 16 }}>Welcome to ADE</h2>
      <p style={{ fontSize: 14, marginBottom: 24, color: "#888" }}>
        Open a folder to create your first workspace.
      </p>
      <button
        onClick={handleOpen}
        style={{
          padding: "10px 24px",
          fontSize: 14,
          background: "#4a9eff",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          cursor: "pointer",
        }}
      >
        Open a folder…
      </button>
    </div>
  );
}