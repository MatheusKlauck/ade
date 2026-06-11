import { useState } from "react";
import { githubSetToken } from "../lib/ipc";

interface SettingsProps {
  onClose: () => void;
  onSaved: (login: string) => void;
}

export default function Settings({ onClose, onSaved }: SettingsProps) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      const result = await githubSetToken(token);
      onSaved(result.login);
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to validate token";
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0, 0, 0, 0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#1e1e1e",
          border: "1px solid #444",
          borderRadius: 8,
          padding: 24,
          minWidth: 380,
          maxWidth: 480,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: 0, marginBottom: 16, color: "#ccc", fontSize: 16 }}>
          Settings
        </h3>
        <label
          style={{ display: "block", fontSize: 13, color: "#999", marginBottom: 6 }}
        >
          GitHub Personal Access Token
        </label>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="ghp_..."
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "8px 12px",
            fontSize: 13,
            background: "#2a2a2a",
            border: "1px solid #444",
            borderRadius: 4,
            color: "#ccc",
            outline: "none",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
          }}
        />
        {error && (
          <p style={{ fontSize: 12, color: "#ff6b6b", marginTop: 8, marginBottom: 0 }}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16, gap: 8 }}>
          <button
            onClick={onClose}
            style={{
              padding: "6px 16px",
              fontSize: 13,
              background: "transparent",
              border: "1px solid #555",
              borderRadius: 4,
              color: "#999",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !token.trim()}
            style={{
              padding: "6px 16px",
              fontSize: 13,
              background: saving || !token.trim() ? "#2a2a2a" : "#4a9eff",
              color: saving || !token.trim() ? "#666" : "#fff",
              border: "none",
              borderRadius: 4,
              cursor: saving || !token.trim() ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}