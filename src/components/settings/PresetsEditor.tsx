import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type CSSProperties,
} from "react";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { useSettingsStore, type TerminalPreset } from "../../store/settings";
import ConfirmDialog from "../ConfirmDialog";
import { ChevronIcon } from "../icons";
import { FieldStatus, sectionLabelStyle, type SaveState } from "./shared";

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

/** Recognition cue for a collapsed preset: the user named it for a *command*,
 * so the header leads with the first open command (the thing they recognize),
 * not a count. `meta` carries the secondary hints (extra-command count, delay,
 * inject). A preset with no commands reads as such instead of "0 cmds". */
function presetHeaderInfo(p: TerminalPreset): {
  firstCmd: string | null;
  meta: string;
} {
  const cmds = p.openCommands.map((c) => c.trim()).filter(Boolean);
  const extra: string[] = [];
  if (cmds.length > 1) extra.push(`+${cmds.length - 1} more`);
  if (p.delaySecs) extra.push(`${p.delaySecs}s`);
  if (p.injectTask) extra.push("injects task");
  return { firstCmd: cmds[0] ?? null, meta: extra.join(" · ") };
}

/** Move `draggedId` to before/after `targetId` within the list. Pure; returns
 * the original list unchanged if either id is missing. */
function movePreset(
  list: TerminalPreset[],
  draggedId: string,
  targetId: string,
  after: boolean
): TerminalPreset[] {
  const dragged = list.find((p) => p.id === draggedId);
  if (!dragged || draggedId === targetId) return list;
  const rest = list.filter((p) => p.id !== draggedId);
  const idx = rest.findIndex((p) => p.id === targetId);
  if (idx === -1) return list;
  rest.splice(after ? idx + 1 : idx, 0, dragged);
  return rest;
}

/** Six-dot drag affordance on a preset row. */
function GripIcon() {
  return (
    <svg
      width="10"
      height="16"
      viewBox="0 0 10 16"
      aria-hidden
      style={{ display: "block", color: "var(--muted)" }}
    >
      {[3, 8, 13].flatMap((cy) =>
        [2, 8].map((cx) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1" fill="currentColor" />
        ))
      )}
    </svg>
  );
}

interface PresetRowProps {
  preset: TerminalPreset;
  isOpen: boolean;
  isDefault: boolean;
  /** Auto-save outcome for the open row — shown inline at the body foot. */
  saveState?: SaveState;
  onToggle: () => void;
  onRemove: () => void;
  onEdit: (patch: Partial<TerminalPreset>) => void;
  onCommit: () => void;
  onInjectToggle: (checked: boolean) => void;
  onReorder: (draggedId: string, targetId: string, after: boolean) => void;
}

/** One preset, as a draggable single-open accordion row. Drag uses the same
 * pragmatic-drag-and-drop "drop before/after target" pattern as the Kanban
 * cards; the grip is the only drag handle so the header stays clickable. */
function PresetRow({
  preset,
  isOpen,
  isDefault,
  saveState,
  onToggle,
  onRemove,
  onEdit,
  onCommit,
  onInjectToggle,
  onReorder,
}: PresetRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const gripRef = useRef<HTMLSpanElement>(null);
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState(false);
  // Keep the latest reorder handler reachable without re-registering the drop
  // target on every list change (its closure would otherwise go stale).
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  useEffect(() => {
    const el = rowRef.current;
    const grip = gripRef.current;
    if (!el || !grip) return;
    const cleanupDrag = draggable({
      element: el,
      dragHandle: grip,
      getInitialData: () => ({ presetId: preset.id }),
      onDragStart: () => setDragging(true),
      onDrop: () => setDragging(false),
    });
    const cleanupDrop = dropTargetForElements({
      element: el,
      getData: () => ({ presetId: preset.id }),
      canDrop: ({ source }) => source.data.presetId !== preset.id,
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: ({ source, location }) => {
        setOver(false);
        const draggedId = source.data.presetId as string;
        if (draggedId === preset.id) return;
        // Drop above or below the target by the pointer's position relative to
        // the row's midpoint — lets a preset reach either end of the list.
        const rect = el.getBoundingClientRect();
        const after = location.current.input.clientY > rect.top + rect.height / 2;
        onReorderRef.current(draggedId, preset.id, after);
      },
    });
    return () => {
      cleanupDrag();
      cleanupDrop();
    };
  }, [preset.id]);

  const named = preset.name.trim();
  const displayName = named || "Untitled preset";
  const { firstCmd, meta } = presetHeaderInfo(preset);

  return (
    <div
      ref={rowRef}
      style={{
        border: "1px solid var(--input-border)",
        borderRadius: 4,
        marginBottom: 8,
        overflow: "hidden",
        background: over ? "var(--drop-target)" : "transparent",
        opacity: dragging ? 0.5 : 1,
        transition: "background var(--dur-instant) var(--ease-out-quart)",
      }}
    >
      <div style={{ display: "flex", alignItems: "stretch" }}>
        <span
          ref={gripRef}
          aria-hidden
          title="Drag to reorder"
          style={{
            display: "flex",
            alignItems: "center",
            padding: "0 4px 0 8px",
            cursor: "grab",
            flexShrink: 0,
          }}
        >
          <GripIcon />
        </span>
        <button
          id={`preset-header-${preset.id}`}
          aria-expanded={isOpen}
          aria-controls={`preset-panel-${preset.id}`}
          onClick={onToggle}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 12px 10px 4px",
            background: "transparent",
            border: "none",
            textAlign: "left",
            color: "var(--fg)",
            cursor: "pointer",
          }}
        >
          <ChevronIcon
            size={14}
            style={{
              flexShrink: 0,
              color: "var(--muted)",
              transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)",
              transition: "transform var(--dur-state) var(--ease-out-quart)",
            }}
          />
          <span
            style={{
              flexShrink: 0,
              fontSize: 13,
              fontWeight: 500,
              color: named ? "var(--fg)" : "var(--muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: 200,
            }}
          >
            {displayName}
          </span>
          {isDefault && (
            <span
              style={{
                flexShrink: 0,
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: "var(--accent)",
                border: "1px solid var(--accent)",
                borderRadius: "var(--radius-pill)",
                padding: "0 5px",
              }}
            >
              Default
            </span>
          )}
          <span
            style={{
              marginInlineStart: "auto",
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              gap: 6,
              overflow: "hidden",
            }}
          >
            {firstCmd ? (
              <span
                title={firstCmd}
                style={{
                  minWidth: 0,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--muted)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {firstCmd}
              </span>
            ) : (
              <span style={{ fontSize: 11, color: "var(--muted)" }}>
                no commands yet
              </span>
            )}
            {meta && (
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 11,
                  color: "var(--muted)",
                  whiteSpace: "nowrap",
                }}
              >
                · {meta}
              </span>
            )}
          </span>
        </button>
        <button
          onClick={onRemove}
          title="Remove preset"
          aria-label={`Remove preset ${displayName}`}
          style={{
            flexShrink: 0,
            margin: "8px 8px 8px 0",
            padding: "0 10px",
            fontSize: 13,
            background: "var(--input-bg)",
            border: "1px solid var(--input-border)",
            borderRadius: 4,
            color: "var(--status-error-text)",
            cursor: "pointer",
          }}
        >
          Remove
        </button>
      </div>

      {isOpen && (
        <div
          id={`preset-panel-${preset.id}`}
          role="region"
          aria-labelledby={`preset-header-${preset.id}`}
          style={{
            padding: "12px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            borderTop: "1px solid var(--input-border)",
          }}
        >
          <label style={presetFieldLabelStyle}>
            Name
            <input
              type="text"
              value={preset.name}
              onChange={(e) => onEdit({ name: e.target.value })}
              onBlur={onCommit}
              placeholder="Name (e.g. claude)"
              style={{ ...presetInputStyle, width: "100%" }}
            />
          </label>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: 12,
            }}
          >
            <label style={presetFieldLabelStyle}>
              Open commands (one per line)
              <textarea
                value={preset.openCommands.join("\n")}
                onChange={(e) =>
                  onEdit({ openCommands: e.target.value.split("\n") })
                }
                onBlur={onCommit}
                placeholder={"e.g.\nnvm use 20\nnpm run dev"}
                rows={3}
                style={presetTextareaStyle}
              />
            </label>
            <label style={presetFieldLabelStyle}>
              Close commands (one per line)
              <textarea
                value={preset.closeCommands.join("\n")}
                onChange={(e) =>
                  onEdit({ closeCommands: e.target.value.split("\n") })
                }
                onBlur={onCommit}
                placeholder={"e.g.\ngit stash"}
                rows={3}
                style={presetTextareaStyle}
              />
            </label>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
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
                  onEdit({
                    delaySecs: Math.max(0, parseInt(e.target.value, 10) || 0),
                  })
                }
                onBlur={onCommit}
                style={{ ...presetInputStyle, width: 70 }}
              />
              s
            </label>
            <label
              title="Prepend the card's task text to the terminal when it launches from a card."
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
                onChange={(e) => onInjectToggle(e.target.checked)}
              />
              Inject task prompt
            </label>
            <span style={{ marginInlineStart: "auto" }}>
              <FieldStatus state={saveState} />
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

interface PresetsEditorProps {
  /** Auto-save outcome for the preset list (flashed by the parent). */
  saveState?: SaveState;
  /** Report a persist outcome so the modal-level status flasher can show it. */
  onSaveResult: (state: SaveState) => void;
  /** Notify the parent that the panel's height may have changed (rows added,
   * removed, expanded…) so the scroll fade can be recomputed. */
  onResize: () => void;
  /** Controlled single-open accordion: the one expanded preset row. Lives in
   * Settings so the expansion survives tab switches (this panel unmounts when
   * another tab is active). */
  expandedPresetId: string | null;
  onExpandedChange: (id: string | null) => void;
}

/** Terminal tab: the preset list editor — draggable accordion rows, add/remove
 * (with confirm), and the default-preset picker. Owns its local working copy
 * of the list; every mutation commits to the store (persisted per-workspace). */
export default function PresetsEditor({
  saveState,
  onSaveResult,
  onResize,
  expandedPresetId,
  onExpandedChange,
}: PresetsEditorProps) {
  const presets = useSettingsStore((s) => s.presets);
  const defaultPresetId = useSettingsStore((s) => s.defaultPresetId);
  const setPresets = useSettingsStore((s) => s.setPresets);
  const setDefaultPreset = useSettingsStore((s) => s.setDefaultPreset);

  const [localPresets, setLocalPresets] = useState<TerminalPreset[]>(presets);
  // Preset id queued for removal — gates the destructive ConfirmDialog.
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);

  // Sync local state from store on mount
  useEffect(() => {
    setLocalPresets(presets);
  }, [presets]);

  // Recompute the parent's scroll fade whenever the list changes shape.
  useEffect(() => {
    onResize();
  }, [localPresets, onResize]);

  // Persist the given preset list (and mirror it locally). Best-effort: an IPC
  // failure in dev mode is non-fatal, matching the other setting handlers.
  const commitPresets = useCallback(
    async (next: TerminalPreset[]) => {
      setLocalPresets(next);
      try {
        await setPresets(next);
        onSaveResult("saved");
      } catch {
        onSaveResult("error");
      }
    },
    [setPresets, onSaveResult]
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
    // A fresh preset is empty, so open it straight away for editing.
    onExpandedChange(preset.id);
  }, [localPresets, commitPresets, onExpandedChange]);

  const removePreset = useCallback(
    (id: string) => {
      commitPresets(localPresets.filter((p) => p.id !== id));
      // Drop the default pointer if it referenced the removed preset.
      if (id === defaultPresetId) setDefaultPreset(null);
      if (expandedPresetId === id) onExpandedChange(null);
    },
    [
      localPresets,
      commitPresets,
      defaultPresetId,
      setDefaultPreset,
      expandedPresetId,
      onExpandedChange,
    ]
  );

  const handleReorder = useCallback(
    (draggedId: string, targetId: string, after: boolean) => {
      commitPresets(movePreset(localPresets, draggedId, targetId, after));
    },
    [localPresets, commitPresets]
  );

  const pendingRemovePreset = pendingRemoveId
    ? localPresets.find((p) => p.id === pendingRemoveId) ?? null
    : null;
  const pendingRemoveLabel = pendingRemovePreset?.name.trim()
    ? `"${pendingRemovePreset.name.trim()}"`
    : "this untitled preset";

  return (
    <div
      role="tabpanel"
      id="settings-panel-terminal"
      aria-labelledby="settings-tab-terminal"
    >
      <label style={sectionLabelStyle}>Terminal Presets</label>
      <p
        style={{
          margin: "0 0 12px",
          fontSize: 11,
          color: "var(--muted)",
          lineHeight: 1.5,
        }}
      >
        Named launch configs for the "New terminal" dropdown. A preset
        runs its open commands in order (after its delay) when a
        terminal opens, and its close commands when it closes. The
        default preset also drives card terminals: open commands run
        when a card moves to Doing, close commands when it reaches Done.
        Turn on "Inject task prompt" to prepend the card's task to that
        terminal on launch.
      </p>
      {localPresets.length === 0 && (
        <p
          style={{
            margin: "0 0 8px",
            fontSize: 12,
            color: "var(--muted)",
          }}
        >
          No presets yet — add one below to define a named launch.
        </p>
      )}
      {localPresets.map((preset) => (
        <PresetRow
          key={preset.id}
          preset={preset}
          isOpen={expandedPresetId === preset.id}
          isDefault={defaultPresetId === preset.id}
          saveState={saveState}
          onToggle={() =>
            onExpandedChange(
              expandedPresetId === preset.id ? null : preset.id
            )
          }
          onRemove={() => setPendingRemoveId(preset.id)}
          onEdit={(patch) => editPreset(preset.id, patch)}
          onCommit={() => commitPresets(localPresets)}
          onInjectToggle={(checked) =>
            commitPresets(
              localPresets.map((p) =>
                p.id === preset.id ? { ...p, injectTask: checked } : p
              )
            )
          }
          onReorder={handleReorder}
        />
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
            {/* Every preset is listed — including unnamed ones, with a
                fallback label — so the default pointer can never go
                dangling/invisible when a preset's name is cleared. */}
            {localPresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name.trim() || "Untitled preset"}
              </option>
            ))}
          </select>
        </label>
      )}

      {pendingRemoveId && (
        <ConfirmDialog
          title="Remove preset?"
          message={`Remove ${pendingRemoveLabel}? Its open and close commands will be lost. This can't be undone.`}
          confirmLabel="Remove"
          cancelLabel="Cancel"
          destructive
          onConfirm={() => {
            removePreset(pendingRemoveId);
            setPendingRemoveId(null);
          }}
          onCancel={() => setPendingRemoveId(null)}
        />
      )}
    </div>
  );
}
