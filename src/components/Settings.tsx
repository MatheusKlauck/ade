import { useState, useEffect, useCallback } from "react";
import { useSettingsStore } from "../store/settings";

interface SettingsProps {
  onClose: () => void;
  onSaved: (login: string) => void;
}

export default function Settings({ onClose, onSaved }: SettingsProps) {
  const theme = useSettingsStore((s) => s.theme);
  const accent = useSettingsStore((s) => s.accent);
  const startupCommand = useSettingsStore((s) => s.startupCommand);
  const syncInterval = useSettingsStore((s) => s.syncInterval);
  const ghTokenDisplay = useSettingsStore((s) => s.ghTokenDisplay);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setAccent = useSettingsStore((s) => s.setAccent);
  const setStartupCommand = useSettingsStore((s) => s.setStartupCommand);
  const setSyncInterval = useSettingsStore((s) => s.setSyncInterval);
  const setGhToken = useSettingsStore((s) => s.setGhToken);

  const [localStartupCommand, setLocalStartupCommand] = useState(startupCommand);
  const [localSyncInterval, setLocalSyncInterval] = useState(syncInterval);
  const [newToken, setNewToken] = useState("");
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync local state from store on mount
  useEffect(() => {
    setLocalStartupCommand(startupCommand);
    setLocalSyncInterval(syncInterval);
  }, [startupCommand, syncInterval]);

  const handleThemeChange = useCallback(
    async (newTheme: string) => {
      try {
        await setTheme(newTheme);
      } catch {
        // IPC failure in dev mode is non-fatal
      }
    },
    [setTheme]
  );

  const handleAccentChange = useCallback(
    async (color: string) => {
      try {
        await setAccent(color);
      } catch {
        // IPC failure in dev mode is non-fatal
      }
    },
    [setAccent]
  );

  const handleStartupCommandBlur = useCallback(async () => {
    try {
      await setStartupCommand(localStartupCommand);
    } catch {
      // IPC failure in dev mode is non-fatal
    }
  }, [localStartupCommand, setStartupCommand]);

  const handleSyncIntervalBlur = useCallback(async () => {
    const val = parseInt(localSyncInterval, 10);
    if (isNaN(val) || val < 10) {
      setError("Sync interval must be at least 10 seconds");
      return;
    }
    setError(null);
    try {
      await setSyncInterval(String(val));
    } catch {
      // IPC failure in dev mode is non-fatal
    }
  }, [localSyncInterval, setSyncInterval]);

  const handleTokenReplace = async () => {
    if (!newToken.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const login = await setGhToken(newToken);
      setNewToken("");
      setShowTokenInput(false);
      onSaved(login);
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
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 24,
          minWidth: 420,
          maxWidth: 500,
          color: "var(--fg)",
          maxHeight: "85vh",
          overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          style={{
            margin: 0,
            marginBottom: 20,
            fontSize: 16,
            color: "var(--fg)",
          }}
        >
          Settings
        </h3>

        {/* Theme */}
        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: "block",
              fontSize: 13,
              color: "var(--muted)",
              marginBottom: 8,
            }}
          >
            Theme
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => handleThemeChange("dark")}
              style={{
                padding: "6px 16px",
                fontSize: 13,
                background:
                  theme === "dark" ? "var(--accent)" : "var(--input-bg)",
                color: theme === "dark" ? "#fff" : "var(--fg)",
                border:
                  theme === "dark"
                    ? "1px solid var(--accent)"
                    : "1px solid var(--input-border)",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              Dark
            </button>
            <button
              onClick={() => handleThemeChange("light")}
              style={{
                padding: "6px 16px",
                fontSize: 13,
                background:
                  theme === "light" ? "var(--accent)" : "var(--input-bg)",
                color: theme === "light" ? "#fff" : "var(--fg)",
                border:
                  theme === "light"
                    ? "1px solid var(--accent)"
                    : "1px solid var(--input-border)",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              Light
            </button>
          </div>
        </div>

        {/* Accent color */}
        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: "block",
              fontSize: 13,
              color: "var(--muted)",
              marginBottom: 8,
            }}
          >
            Accent Color
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="color"
              value={accent}
              onChange={(e) => handleAccentChange(e.target.value)}
              style={{
                width: 40,
                height: 32,
                padding: 0,
                border: "1px solid var(--input-border)",
                borderRadius: 4,
                background: "var(--input-bg)",
                cursor: "pointer",
              }}
            />
            <span style={{ fontSize: 13, color: "var(--fg)" }}>{accent}</span>
          </div>
        </div>

        {/* Global startup command */}
        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: "block",
              fontSize: 13,
              color: "var(--muted)",
              marginBottom: 8,
            }}
          >
            Global Startup Command
          </label>
          <input
            type="text"
            value={localStartupCommand}
            onChange={(e) => setLocalStartupCommand(e.target.value)}
            onBlur={handleStartupCommandBlur}
            placeholder="e.g. nvim"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "8px 12px",
              fontSize: 13,
              background: "var(--input-bg)",
              border: "1px solid var(--input-border)",
              borderRadius: 4,
              color: "var(--fg)",
              outline: "none",
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleStartupCommandBlur();
            }}
          />
        </div>

        {/* Sync interval */}
        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: "block",
              fontSize: 13,
              color: "var(--muted)",
              marginBottom: 8,
            }}
          >
            Sync Interval (seconds, min 10)
          </label>
          <input
            type="number"
            min={10}
            value={localSyncInterval}
            onChange={(e) => setLocalSyncInterval(e.target.value)}
            onBlur={handleSyncIntervalBlur}
            style={{
              width: 120,
              padding: "8px 12px",
              fontSize: 13,
              background: "var(--input-bg)",
              border: "1px solid var(--input-border)",
              borderRadius: 4,
              color: "var(--fg)",
              outline: "none",
              boxSizing: "border-box",
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSyncIntervalBlur();
            }}
          />
        </div>

        {/* GitHub token */}
        <div style={{ marginBottom: 8 }}>
          <label
            style={{
              display: "block",
              fontSize: 13,
              color: "var(--muted)",
              marginBottom: 8,
            }}
          >
            GitHub Personal Access Token
          </label>
          {ghTokenDisplay ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span
                style={{
                  fontSize: 13,
                  color: "var(--fg)",
                  fontFamily: "monospace",
                  padding: "8px 12px",
                  background: "var(--input-bg)",
                  border: "1px solid var(--input-border)",
                  borderRadius: 4,
                  flex: 1,
                }}
              >
                {ghTokenDisplay}
              </span>
              <button
                onClick={() => setShowTokenInput(true)}
                style={{
                  padding: "6px 16px",
                  fontSize: 13,
                  background: "var(--input-bg)",
                  border: "1px solid var(--input-border)",
                  borderRadius: 4,
                  color: "var(--fg)",
                  cursor: "pointer",
                }}
              >
                Replace
              </button>
            </div>
          ) : (
            <div>
              <input
                type="password"
                value={newToken}
                onChange={(e) => setNewToken(e.target.value)}
                placeholder="ghp_..."
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "8px 12px",
                  fontSize: 13,
                  background: "var(--input-bg)",
                  border: "1px solid var(--input-border)",
                  borderRadius: 4,
                  color: "var(--fg)",
                  outline: "none",
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleTokenReplace();
                }}
              />
            </div>
          )}
          {showTokenInput && ghTokenDisplay && (
            <div style={{ marginTop: 8 }}>
              <input
                type="password"
                value={newToken}
                onChange={(e) => setNewToken(e.target.value)}
                placeholder="New token…"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "8px 12px",
                  fontSize: 13,
                  background: "var(--input-bg)",
                  border: "1px solid var(--input-border)",
                  borderRadius: 4,
                  color: "var(--fg)",
                  outline: "none",
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleTokenReplace();
                }}
              />
            </div>
          )}
        </div>

        {error && (
          <p
            style={{
              fontSize: 12,
              color: "#ff6b6b",
              marginTop: 8,
              marginBottom: 0,
            }}
          >
            {error}
          </p>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginTop: 16,
            gap: 8,
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: "6px 16px",
              fontSize: 13,
              background: "transparent",
              border: "1px solid var(--input-border)",
              borderRadius: 4,
              color: "var(--muted)",
              cursor: "pointer",
            }}
          >
            Close
          </button>
          {showTokenInput && ghTokenDisplay && (
            <button
              onClick={handleTokenReplace}
              disabled={saving || !newToken.trim()}
              style={{
                padding: "6px 16px",
                fontSize: 13,
                background:
                  saving || !newToken.trim()
                    ? "var(--input-bg)"
                    : "var(--accent)",
                color: saving || !newToken.trim() ? "#666" : "#fff",
                border: "none",
                borderRadius: 4,
                cursor:
                  saving || !newToken.trim() ? "not-allowed" : "pointer",
              }}
            >
              {saving ? "Saving…" : "Save Token"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}