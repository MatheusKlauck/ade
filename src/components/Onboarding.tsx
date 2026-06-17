import { useState, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import { useWorkspacesStore } from "../store/workspaces";
import { pickDirectory, type Workspace } from "../lib/ipc";

const screenStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: "100vh",
  background: "var(--bg)",
  color: "var(--fg)",
  fontFamily: "var(--font-sans)",
  padding: "var(--space-xl)",
  boxSizing: "border-box",
};

const kbdStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--muted)",
  background: "var(--surface-input)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  padding: "2px 6px",
  lineHeight: 1,
};

function Spinner() {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 14,
        height: 14,
        border: "2px solid var(--muted)",
        borderTopColor: "var(--on-accent)",
        borderRadius: "50%",
        animation: "spin 0.6s linear infinite",
      }}
    />
  );
}

function FolderIcon() {
  return (
    <svg
      aria-hidden
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}

export default function Onboarding() {
  const addWorkspace = useWorkspacesStore((s) => s.addWorkspace);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Workspace | null>(null);

  const handleOpen = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const selected = await pickDirectory();
      if (!selected) {
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
  }, [addWorkspace]);

  // Keyboard-first: ⌘O / Ctrl+O (or Enter) opens the folder picker.
  useEffect(() => {
    if (created) return;
    const onKey = (e: KeyboardEvent) => {
      if (loading) return;
      const openCombo = (e.key === "o" || e.key === "O") && (e.metaKey || e.ctrlKey);
      if (openCombo || e.key === "Enter") {
        e.preventDefault();
        handleOpen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleOpen, loading, created]);

  if (created) {
    const repoLabel =
      created.github_owner && created.github_repo
        ? `${created.github_owner}/${created.github_repo}`
        : "local only";

    return (
      <div style={screenStyle}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 32, fontWeight: 600, letterSpacing: "-0.02em" }}>
            {created.name}
          </h2>
          <span
            style={{
              marginTop: "var(--space-xs)",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              color: "var(--muted)",
            }}
          >
            {repoLabel}
          </span>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-sm)",
              marginTop: "var(--space-lg)",
              fontSize: 13,
              color: "var(--muted)",
            }}
          >
            <Spinner />
            Opening workspace…
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={screenStyle}>
      {/* Wordmark + tagline */}
      <h1 style={{ margin: 0, fontSize: 44, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1 }}>
        ADE
      </h1>
      <p style={{ margin: "var(--space-sm) 0 0", fontSize: 15, color: "var(--muted)" }}>
        The control room for your repos
      </p>

      {/* Primary action */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-md)",
          marginTop: "var(--space-xl)",
        }}
      >
        <button
          onClick={handleOpen}
          disabled={loading}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--space-sm)",
            padding: "11px 22px",
            fontFamily: "var(--font-sans)",
            fontSize: 14,
            fontWeight: 500,
            background: loading ? "var(--input-bg)" : "var(--accent)",
            color: loading ? "var(--muted)" : "var(--accent-ink)",
            border: "none",
            borderRadius: "var(--radius-md)",
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? <Spinner /> : <FolderIcon />}
          {loading ? "Creating workspace…" : "Open a folder…"}
        </button>
        {!loading && <kbd style={kbdStyle}>⌘O</kbd>}
      </div>

      {/* What happens next */}
      <div
        style={{
          marginTop: "var(--space-xl)",
          display: "grid",
          gridTemplateColumns: "auto auto",
          columnGap: "var(--space-md)",
          rowGap: "var(--space-xs)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--muted)",
          lineHeight: 1.5,
        }}
      >
        <span>Git repo</span>
        <span>→ board synced to GitHub issues</span>
        <span>No git</span>
        <span>→ local board + terminals</span>
      </div>

      {error && (
        <p
          style={{
            fontSize: 13,
            color: "var(--status-error-text)",
            marginTop: "var(--space-lg)",
            maxWidth: 340,
            textAlign: "center",
            lineHeight: 1.5,
          }}
        >
          {error}
        </p>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
