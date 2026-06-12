import { useWorkspacesStore, type SyncStatusEntry } from "../store/workspaces";

export default function SyncIndicator({ workspaceId }: { workspaceId: string }) {
  const entry = useWorkspacesStore((s) => s.syncStatus[workspaceId]) as
    | SyncStatusEntry
    | undefined;

  if (!entry) return null;

  const { status } = entry;

  if (status === "syncing") {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 11,
          color: "var(--accent-cyan)",
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            border: "1.5px solid var(--accent-cyan)",
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
          color: "var(--status-error-text)",
        }}
        title="Sync error"
      >
        ⚠ Sync error
      </span>
    );
  }

  // status === "idle": the "✓ Synced just now" pill was visual noise beside the
  // tab title. The AppBar's AggregateSyncStatus already reports the all-quiet
  // state globally, so per-tab we surface only the in-flight / error signal.
  return null;
}