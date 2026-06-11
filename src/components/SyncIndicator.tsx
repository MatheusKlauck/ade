import { useWorkspacesStore, type SyncStatusEntry } from "../store/workspaces";

function formatTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString();
}

export default function SyncIndicator({ workspaceId }: { workspaceId: string }) {
  const entry = useWorkspacesStore((s) => s.syncStatus[workspaceId]) as
    | SyncStatusEntry
    | undefined;

  if (!entry) return null;

  const { status, lastSync } = entry;

  if (status === "syncing") {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 11,
          color: "var(--accent, #4a9eff)",
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            border: "1.5px solid var(--accent, #4a9eff)",
            borderTopColor: "transparent",
            borderRadius: "50%",
            animation: "sync-spin 0.6s linear infinite",
          }}
        />
        Syncing…
        <style>{`@keyframes sync-spin { to { transform: rotate(360deg); } }`}</style>
      </span>
    );
  }

  if (status === "error") {
    return (
      <span
        style={{
          fontSize: 11,
          color: "#e74c3c",
        }}
        title="Sync error"
      >
        ⚠ Sync error
      </span>
    );
  }

  // status === "idle"
  return (
    <span
      style={{
        fontSize: 11,
        color: "var(--fg, #999)",
      }}
      title={lastSync ? `Last synced: ${new Date(lastSync).toLocaleString()}` : "Synced"}
    >
      ✓ Synced{lastSync ? ` ${formatTime(lastSync)}` : ""}
    </span>
  );
}