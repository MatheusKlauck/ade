import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type CSSProperties,
} from "react";
import { useSettingsStore, type TerminalPreset } from "../store/settings";
import { useWorkspacesStore } from "../store/workspaces";

interface SettingsProps {
  onClose: () => void;
  onSaved: (login: string) => void;
}

/** Shared input styling for the terminal-preset editor rows. */
const presetInputStyle: CSSProperties = {
  boxSizing: "border-box",
  padding: "6px 10px",
  fontSize: 13,
  background: "var(--input-bg)",
  border: "1px solid var(--input-border)",
  borderRadius: 4,
  color: "var(--fg)",
};

/** Multi-line command list inside a preset row. */
const presetTextareaStyle: CSSProperties = {
  ...presetInputStyle,
  width: "100%",
  minHeight: 52,
  resize: "vertical",
  fontFamily: "var(--font-mono)",
};

/** Label wrapping a preset command textarea. */
const presetFieldLabelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "var(--muted)",
};

/** Normalize anything thrown across the IPC boundary into a readable string.
 * Tauri rejects with the serialized `AdeError` (`{ code, message }`), a plain
 * string, or — for JS-side failures — a real Error. Show the code so the cause
 * (TOKEN_INVALID vs INTERNAL/keychain vs SYNC_WRITE_FAILED) is obvious. */
function formatTokenError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    const obj = e as { code?: string; message?: string };
    const code = obj.code ? `${obj.code}: ` : "";
    return `${code}${obj.message ?? "unknown error"}`;
  }
  return "Failed to validate token";
}

export default function Settings({ onClose, onSaved }: SettingsProps) {
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeWorkspaceName =
    workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? "";
  const theme = useSettingsStore((s) => s.theme);
  const accent = useSettingsStore((s) => s.accent);
  const syncInterval = useSettingsStore((s) => s.syncInterval);
  const presets = useSettingsStore((s) => s.presets);
  const defaultPresetId = useSettingsStore((s) => s.defaultPresetId);
  const ghTokenDisplay = useSettingsStore((s) => s.ghTokenDisplay);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setAccent = useSettingsStore((s) => s.setAccent);
  const setSyncInterval = useSettingsStore((s) => s.setSyncInterval);
  const setPresets = useSettingsStore((s) => s.setPresets);
  const setDefaultPreset = useSettingsStore((s) => s.setDefaultPreset);
  const setGhToken = useSettingsStore((s) => s.setGhToken);

  const [localSyncInterval, setLocalSyncInterval] = useState(syncInterval);
  const [localPresets, setLocalPresets] = useState<TerminalPreset[]>(presets);
  const [newToken, setNewToken] = useState("");
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Modal focus management: pull focus into the dialog on open, return it to
  // whatever was focused before (the gear button) on close.
  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    (first ?? panel)?.focus();
    return () => restoreFocusRef.current?.focus?.();
  }, []);

  // Esc closes; Tab is trapped so keyboard focus can't escape behind the scrim.
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = panel.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  // Sync local state from store on mount
  useEffect(() => {
    setLocalSyncInterval(syncInterval);
    setLocalPresets(presets);
  }, [syncInterval, presets]);

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

  // Persist the given preset list (and mirror it locally). Best-effort: an IPC
  // failure in dev mode is non-fatal, matching the other setting handlers.
  const commitPresets = useCallback(
    async (next: TerminalPreset[]) => {
      setLocalPresets(next);
      try {
        await setPresets(next);
      } catch {
        // non-fatal
      }
    },
    [setPresets]
  );

  // Edit a field locally while typing (persisted on blur via commitPresets).
  const editPreset = useCallback(
    (id: string, patch: Partial<TerminalPreset>) => {
      setLocalPresets((list) =>
        list.map((p) => (p.id === id ? { ...p, ...patch } : p))
      );
    },
    []
  );

  const addPreset = useCallback(() => {
    const preset: TerminalPreset = {
      id: crypto.randomUUID(),
      name: "",
      openCommands: [],
      closeCommands: [],
      delaySecs: 0,
      injectTask: false,
    };
    commitPresets([...localPresets, preset]);
  }, [localPresets, commitPresets]);

  const removePreset = useCallback(
    (id: string) => {
      commitPresets(localPresets.filter((p) => p.id !== id));
      // Drop the default pointer if it referenced the removed preset.
      if (id === defaultPresetId) setDefaultPreset(null);
    },
    [localPresets, commitPresets, defaultPresetId, setDefaultPreset]
  );

  // The token input is shown either on first-time setup (no stored token yet)
  // or when the user clicks "Replace". The Save button follows the same rule.
  const tokenInputVisible = !ghTokenDisplay || showTokenInput;

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
      // Surface the real backend error. AdeError crosses the IPC boundary as a
      // plain object `{ code, message }` (NOT a JS Error), so `e instanceof
      // Error` is false and we'd otherwise show a useless generic string.
      console.error("token validation failed:", e);
      setError(formatTokenError(e));
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
        zIndex: "var(--z-modal)",
      }}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
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
          outline: "none",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          id="settings-title"
          style={{
            margin: 0,
            marginBottom: 4,
            fontSize: 16,
            color: "var(--fg)",
          }}
        >
          Settings
        </h3>
        <p
          style={{
            margin: 0,
            marginBottom: 20,
            fontSize: 12,
            color: "var(--muted)",
          }}
        >
          {activeWorkspaceName
            ? `Per-workspace · ${activeWorkspaceName}`
            : "Per-workspace settings"}
        </p>

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
                color: theme === "dark" ? "var(--accent-ink)" : "var(--fg)",
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
                color: theme === "light" ? "var(--accent-ink)" : "var(--fg)",
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

        {/* Terminal presets */}
        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: "block",
              fontSize: 13,
              color: "var(--muted)",
              marginBottom: 8,
            }}
          >
            Terminal Presets
          </label>
          <p
            style={{
              margin: "0 0 8px",
              fontSize: 11,
              color: "var(--muted)",
            }}
          >
            Named launch configs in the “New terminal” dropdown. Each runs its
            open commands (in order) after its own delay, and its close commands
            when the terminal is closed. The default preset is used for
            card-driven terminals: its open commands run when a card moves to
            Doing, its close commands when it moves to Done.
          </p>
          {localPresets.length === 0 && (
            <p
              style={{
                margin: "0 0 8px",
                fontSize: 12,
                color: "var(--muted)",
              }}
            >
              No presets yet.
            </p>
          )}
          {localPresets.map((preset) => (
            <div
              key={preset.id}
              style={{
                border: "1px solid var(--input-border)",
                borderRadius: 4,
                padding: 10,
                marginBottom: 8,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="text"
                  value={preset.name}
                  onChange={(e) =>
                    editPreset(preset.id, { name: e.target.value })
                  }
                  onBlur={() => commitPresets(localPresets)}
                  placeholder="Name (e.g. claude)"
                  style={{ ...presetInputStyle, flex: 1 }}
                />
                <button
                  onClick={() => removePreset(preset.id)}
                  title="Remove preset"
                  style={{
                    padding: "0 10px",
                    fontSize: 13,
                    background: "var(--input-bg)",
                    border: "1px solid var(--input-border)",
                    borderRadius: 4,
                    color: "var(--status-error)",
                    cursor: "pointer",
                  }}
                >
                  Remove
                </button>
              </div>
              <label style={presetFieldLabelStyle}>
                Open commands (one per line)
                <textarea
                  value={preset.openCommands.join("\n")}
                  onChange={(e) =>
                    editPreset(preset.id, {
                      openCommands: e.target.value.split("\n"),
                    })
                  }
                  onBlur={() => commitPresets(localPresets)}
                  placeholder={"e.g.\nnvm use 20\nnpm run dev"}
                  rows={2}
                  style={presetTextareaStyle}
                />
              </label>
              <label style={presetFieldLabelStyle}>
                Close commands (one per line)
                <textarea
                  value={preset.closeCommands.join("\n")}
                  onChange={(e) =>
                    editPreset(preset.id, {
                      closeCommands: e.target.value.split("\n"),
                    })
                  }
                  onBlur={() => commitPresets(localPresets)}
                  placeholder={"e.g.\ngit stash"}
                  rows={2}
                  style={presetTextareaStyle}
                />
              </label>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12,
                    color: "var(--muted)",
                  }}
                >
                  Delay
                  <input
                    type="number"
                    min={0}
                    value={preset.delaySecs}
                    onChange={(e) =>
                      editPreset(preset.id, {
                        delaySecs: Math.max(
                          0,
                          parseInt(e.target.value, 10) || 0
                        ),
                      })
                    }
                    onBlur={() => commitPresets(localPresets)}
                    style={{ ...presetInputStyle, width: 70 }}
                  />
                  s
                </label>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12,
                    color: "var(--muted)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={preset.injectTask}
                    onChange={(e) =>
                      commitPresets(
                        localPresets.map((p) =>
                          p.id === preset.id
                            ? { ...p, injectTask: e.target.checked }
                            : p
                        )
                      )
                    }
                  />
                  Inject task prompt
                </label>
              </div>
            </div>
          ))}
          <button
            onClick={addPreset}
            style={{
              padding: "6px 14px",
              fontSize: 13,
              background: "var(--input-bg)",
              border: "1px solid var(--input-border)",
              borderRadius: 4,
              color: "var(--fg)",
              cursor: "pointer",
            }}
          >
            + Add preset
          </button>
          {localPresets.length > 0 && (
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 12,
                fontSize: 12,
                color: "var(--muted)",
              }}
            >
              Default preset
              <select
                value={defaultPresetId ?? ""}
                onChange={(e) => setDefaultPreset(e.target.value || null)}
                style={{ ...presetInputStyle, flex: 1 }}
              >
                <option value="">None</option>
                {localPresets
                  .filter((p) => p.name.trim())
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
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
                  fontFamily: "var(--font-mono)",
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
              color: "var(--status-error)",
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
          {tokenInputVisible && (
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
                color: saving || !newToken.trim() ? "var(--muted)" : "var(--accent-ink)",
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