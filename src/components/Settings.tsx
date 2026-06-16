import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useSettingsStore } from "../store/settings";
import { useWorkspacesStore } from "../store/workspaces";
import { useCommandFreqStore } from "../store/commandFrequency";
import { useModalFocus } from "../lib/useModalFocus";
import GestorSettings from "./GestorSettings";
import AppearanceTab from "./settings/AppearanceTab";
import TerminalAppearanceTab from "./settings/TerminalAppearanceTab";
import PresetsEditor from "./settings/PresetsEditor";
import {
  FieldStatus,
  errorTextStyle,
  fieldStyle,
  sectionLabelStyle,
  type SaveState,
} from "./settings/shared";

interface SettingsProps {
  onClose: () => void;
  onSaved: (login: string) => void;
}

/** The settings modal is split into one tab per concern-domain so the panel
 * never becomes a single scrolling wall of unrelated controls. */
type TabId = "appearance" | "terminal" | "sync" | "account" | "gestor";
const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "sync", label: "Sync" },
  { id: "account", label: "Account" },
  { id: "gestor", label: "Gestor" },
];

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
  const syncInterval = useSettingsStore((s) => s.syncInterval);
  const ghTokenDisplay = useSettingsStore((s) => s.ghTokenDisplay);
  const setSyncInterval = useSettingsStore((s) => s.setSyncInterval);
  const setGhToken = useSettingsStore((s) => s.setGhToken);

  const [activeTab, setActiveTab] = useState<TabId>("appearance");
  const [localSyncInterval, setLocalSyncInterval] = useState(syncInterval);
  const [newToken, setNewToken] = useState("");
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [saving, setSaving] = useState(false);
  // Errors are scoped to their field so a sync-validation message and a token
  // failure can't overwrite each other (each renders beside its own control).
  const [syncError, setSyncError] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  // Single-open accordion for the Terminal tab. Lives here (not in
  // PresetsEditor) so the expanded row survives switching tabs and back.
  const [expandedPresetId, setExpandedPresetId] = useState<string | null>(null);
  // Per-field auto-save confirmation, keyed by control ("theme", "sync", …).
  const [fieldStatus, setFieldStatus] = useState<Record<string, SaveState>>({});

  const contentRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const statusTimers = useRef<Map<string, number>>(new Map());

  // Modal focus management: pull focus into the dialog on open, return it to
  // the gear button on close, Esc closes, and Tab is trapped in the panel.
  const { panelRef, handleKeyDown } = useModalFocus(onClose);

  // Flash a transient "Saved" / "Not saved" beside a field, then clear it.
  // Saved confirmations fade quickly; failures linger so they're not missed.
  const flashStatus = useCallback((field: string, state: SaveState) => {
    setFieldStatus((m) => ({ ...m, [field]: state }));
    const prev = statusTimers.current.get(field);
    if (prev) window.clearTimeout(prev);
    const id = window.setTimeout(
      () => {
        setFieldStatus((m) => {
          const next = { ...m };
          delete next[field];
          return next;
        });
        statusTimers.current.delete(field);
      },
      state === "saved" ? 1800 : 4000,
    );
    statusTimers.current.set(field, id);
  }, []);

  // Cancel any pending status timers if the modal closes mid-flash.
  useEffect(() => {
    const timers = statusTimers.current;
    return () => {
      for (const id of timers.values()) window.clearTimeout(id);
    };
  }, []);

  // Scroll affordance: a fade at the bottom of the scroll region signals there's
  // more content below the fold, so the sticky footer never feels like the end.
  const [showBottomFade, setShowBottomFade] = useState(false);
  const updateFade = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    setShowBottomFade(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  }, []);

  // Sync local state from store on mount
  useEffect(() => {
    setLocalSyncInterval(syncInterval);
  }, [syncInterval]);

  // Recompute the scroll fade whenever the visible content changes (tab switch,
  // token input toggling open). The Terminal tab reports its own reshaping
  // (preset add/remove) through PresetsEditor's onResize.
  useEffect(() => {
    updateFade();
  }, [activeTab, showTokenInput, ghTokenDisplay, updateFade]);

  const handleSyncIntervalBlur = useCallback(async () => {
    const val = parseInt(localSyncInterval, 10);
    if (isNaN(val) || val < 10) {
      setSyncError(
        "Enter 10 seconds or more — faster polling hits GitHub rate limits.",
      );
      return;
    }
    setSyncError(null);
    try {
      await setSyncInterval(String(val));
      flashStatus("sync", "saved");
    } catch {
      flashStatus("sync", "error");
    }
  }, [localSyncInterval, setSyncInterval, flashStatus]);

  // The token input is shown either on first-time setup (no stored token yet)
  // or when the user clicks "Replace".
  const tokenInputVisible = !ghTokenDisplay || showTokenInput;

  const handleTokenReplace = async () => {
    if (!newToken.trim()) return;
    setSaving(true);
    setTokenError(null);
    try {
      const login = await setGhToken(newToken);
      setNewToken("");
      setShowTokenInput(false);
      flashStatus("account", "saved");
      onSaved(login);
    } catch (e: unknown) {
      // Surface the real backend error. AdeError crosses the IPC boundary as a
      // plain object `{ code, message }` (NOT a JS Error), so `e instanceof
      // Error` is false and we'd otherwise show a useless generic string.
      console.error("token validation failed:", e);
      setTokenError(formatTokenError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleTabKeyDown = (
    e: ReactKeyboardEvent<HTMLButtonElement>,
    idx: number,
  ) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const next = (idx + dir + TABS.length) % TABS.length;
    setActiveTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--scrim)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: "var(--z-modal)",
      }}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        data-testid="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        style={{
          display: "flex",
          flexDirection: "column",
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          width: 1000,
          maxWidth: "calc(100vw - 48px)",
          color: "var(--fg)",
          maxHeight: "90vh",
          overflow: "hidden",
          outline: "none",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Sticky header: identity + close + tab nav ───────────────────── */}
        <div style={{ flexShrink: 0, padding: "20px 24px 0" }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div>
              <h3
                id="settings-title"
                style={{ margin: 0, fontSize: 16, color: "var(--fg)" }}
              >
                Settings
              </h3>
              <p
                style={{
                  margin: "2px 0 0",
                  fontSize: 12,
                  color: "var(--muted)",
                }}
              >
                {activeWorkspaceName
                  ? `Per-workspace · ${activeWorkspaceName}`
                  : "Per-workspace settings"}
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close settings"
              style={{
                flexShrink: 0,
                width: 28,
                height: 28,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 16,
                lineHeight: 1,
                background: "transparent",
                border: "none",
                borderRadius: 4,
                color: "var(--muted)",
                cursor: "pointer",
              }}
            >
              ✕
            </button>
          </div>

          <div
            role="tablist"
            aria-label="Settings sections"
            style={{
              display: "flex",
              gap: 2,
              marginTop: 16,
              borderBottom: "1px solid var(--border)",
            }}
          >
            {TABS.map((tab, idx) => {
              const selected = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  ref={(el) => {
                    tabRefs.current[idx] = el;
                  }}
                  role="tab"
                  id={`settings-tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls={`settings-panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(e) => handleTabKeyDown(e, idx)}
                  style={{
                    padding: "8px 12px",
                    fontSize: 13,
                    fontWeight: selected ? 600 : 400,
                    background: "transparent",
                    border: "none",
                    borderBottom: selected
                      ? "2px solid var(--accent)"
                      : "2px solid transparent",
                    marginBottom: -1,
                    color: selected ? "var(--fg)" : "var(--muted)",
                    cursor: "pointer",
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Scrollable body: the active tab panel + a bottom fade ───────── */}
        <div
          style={{
            position: "relative",
            flex: 1,
            minHeight: 0,
            display: "flex",
          }}
        >
          <div
            ref={contentRef}
            onScroll={updateFade}
            style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}
          >
            {/* Appearance: theme + accent */}
            {activeTab === "appearance" && (
              <AppearanceTab
                themeStatus={fieldStatus.theme}
                accentStatus={fieldStatus.accent}
                onSaveResult={flashStatus}
              />
            )}

            {/* Terminal: appearance + presets */}
            {activeTab === "terminal" && (
              <>
                <TerminalAppearanceTab
                  status={fieldStatus.terminalAppearance}
                  onSaveResult={(state) =>
                    flashStatus("terminalAppearance", state)
                  }
                />
                <PresetsEditor
                  saveState={fieldStatus.presets}
                  onSaveResult={(state) => flashStatus("presets", state)}
                  onResize={updateFade}
                  expandedPresetId={expandedPresetId}
                  onExpandedChange={setExpandedPresetId}
                />
                <label style={{ ...sectionLabelStyle, marginTop: 24 }}>
                  Suggested Commands
                  <FieldStatus state={fieldStatus.suggestions} />
                </label>
                <p
                  style={{
                    margin: "0 0 10px",
                    fontSize: 11,
                    lineHeight: 1.5,
                    color: "var(--muted)",
                  }}
                >
                  The quick-command bar learns the commands you run most in{" "}
                  {activeWorkspaceName
                    ? `“${activeWorkspaceName}”`
                    : "this workspace"}
                  . Reset to clear them.
                </p>
                <button
                  onClick={() => {
                    if (!activeWorkspaceId) return;
                    useCommandFreqStore.getState().reset(activeWorkspaceId);
                    flashStatus("suggestions", "saved");
                  }}
                  disabled={!activeWorkspaceId}
                  style={{
                    padding: "6px 16px",
                    fontSize: 13,
                    background: "var(--input-bg)",
                    color: "var(--fg)",
                    border: "1px solid var(--input-border)",
                    borderRadius: 4,
                    cursor: activeWorkspaceId ? "pointer" : "not-allowed",
                  }}
                >
                  Reset Suggested Commands
                </button>
              </>
            )}

            {/* Sync: interval */}
            {activeTab === "sync" && (
              <div
                role="tabpanel"
                id="settings-panel-sync"
                aria-labelledby="settings-tab-sync"
                style={{ maxWidth: 560 }}
              >
                <label style={sectionLabelStyle}>
                  Sync Interval (seconds, min 10)
                  <FieldStatus state={fieldStatus.sync} />
                </label>
                <input
                  type="number"
                  min={10}
                  value={localSyncInterval}
                  onChange={(e) => setLocalSyncInterval(e.target.value)}
                  onBlur={handleSyncIntervalBlur}
                  style={{ ...fieldStyle, width: 120 }}
                  aria-invalid={syncError ? true : undefined}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSyncIntervalBlur();
                  }}
                />
                {syncError && <p style={errorTextStyle}>{syncError}</p>}
              </div>
            )}

            {/* Account: GitHub token */}
            {activeTab === "account" && (
              <div
                role="tabpanel"
                id="settings-panel-account"
                aria-labelledby="settings-tab-account"
                style={{ maxWidth: 560 }}
              >
                <label style={sectionLabelStyle}>
                  GitHub Personal Access Token
                  <FieldStatus state={fieldStatus.account} />
                </label>
                <p
                  style={{
                    margin: "0 0 10px",
                    fontSize: 11,
                    lineHeight: 1.5,
                    color: "var(--muted)",
                  }}
                >
                  Needs the <strong style={{ fontWeight: 600 }}>repo</strong>{" "}
                  scope so ADE can read and update your issues. Generate one in
                  GitHub → Settings → Developer settings → Personal access
                  tokens.
                </p>
                {!tokenInputVisible ? (
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <span
                      aria-label={`Current token, masked: ${ghTokenDisplay}`}
                      style={{
                        ...fieldStyle,
                        flex: 1,
                        fontFamily: "var(--font-mono)",
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
                      placeholder={ghTokenDisplay ? "New token…" : "ghp_..."}
                      aria-label="GitHub personal access token"
                      style={{ ...fieldStyle, width: "100%" }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleTokenReplace();
                      }}
                    />
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "flex-end",
                        gap: 8,
                        marginTop: 8,
                      }}
                    >
                      {ghTokenDisplay && (
                        <button
                          onClick={() => {
                            setShowTokenInput(false);
                            setNewToken("");
                            setTokenError(null);
                          }}
                          style={{
                            padding: "6px 16px",
                            fontSize: 13,
                            background: "transparent",
                            border: "1px solid var(--input-border)",
                            borderRadius: 4,
                            color: "var(--fg)",
                            cursor: "pointer",
                          }}
                        >
                          Cancel
                        </button>
                      )}
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
                          color:
                            saving || !newToken.trim()
                              ? "var(--muted)"
                              : "var(--accent-ink)",
                          border: "none",
                          borderRadius: 4,
                          cursor:
                            saving || !newToken.trim()
                              ? "not-allowed"
                              : "pointer",
                        }}
                      >
                        {saving ? "Saving…" : "Save Token"}
                      </button>
                    </div>
                  </div>
                )}
                {tokenError && <p style={errorTextStyle}>{tokenError}</p>}
              </div>
            )}

            {activeTab === "gestor" && (
              <div
                role="tabpanel"
                id="settings-panel-gestor"
                aria-labelledby="settings-tab-gestor"
              >
                <GestorSettings workspaceId={activeWorkspaceId} />
              </div>
            )}
          </div>

          {showBottomFade && (
            <div
              aria-hidden
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: 24,
                background:
                  "linear-gradient(to bottom, transparent, var(--panel))",
                pointerEvents: "none",
              }}
            />
          )}
        </div>

        {/* ── Sticky footer ──────────────────────────────────────────────── */}
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 24px",
            borderTop: "1px solid var(--border)",
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
              color: "var(--fg)",
              cursor: "pointer",
            }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
