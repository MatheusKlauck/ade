import { useCallback, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cardDelete, cardPromote, gestorEnqueueCard } from "../lib/ipc";
import type { Card as CardType, BoardColumn } from "../lib/ipc";
import type { TerminalPreset } from "../store/settings";
import { useWorkspacesStore } from "../store/workspaces";
import { COLUMN_ORDER } from "../lib/columns";
import {
  ContextMenu,
  menuItemStyle,
  type ContextMenuPosition,
} from "./ContextMenu";
import ConfirmDialog from "./ConfirmDialog";
import { CheckIcon } from "./icons";

/*
 * The single right-click menu shared by every card surface (ledger row, classic
 * board card, full Kanban card) so they read as one system: Open · Run with ·
 * Move to · Delete. Each section is omitted when its callback is not provided,
 * which lets a view opt out of an action without restyling the menu.
 */

const sectionHeaderStyle = {
  padding: "4px 10px 6px",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase" as const,
  color: "var(--muted)",
};

const dividerStyle = {
  height: 1,
  margin: "4px 0",
  background: "var(--border)",
};

function hoverable(extra?: CSSProperties): CSSProperties {
  return { ...menuItemStyle, ...extra };
}

/**
 * Centralises the "Delete card?" confirmation so every card surface deletes the
 * same way. Wire `requestDelete` into a CardContextMenu's `onDelete`, and render
 * the returned `dialog` somewhere in the view. The card disappears via the
 * `evt:board` refresh the backend emits after card_delete.
 */
export function useCardDeleteConfirm() {
  const [pending, setPending] = useState<CardType | null>(null);
  const requestDelete = useCallback((card: CardType) => setPending(card), []);

  const dialog = pending ? (
    <ConfirmDialog
      title="Delete card?"
      message={`"${pending.title}" will be permanently deleted. This cannot be undone.`}
      confirmLabel="Delete"
      destructive
      onConfirm={() => {
        const card = pending;
        setPending(null);
        cardDelete(card.id).catch((e) =>
          console.error("card_delete failed", e),
        );
      }}
      onCancel={() => setPending(null)}
    />
  ) : null;

  return { requestDelete, dialog };
}

export interface CardContextMenuProps {
  position: ContextMenuPosition;
  onClose: () => void;
  card: CardType;
  columnName: string;
  columns: BoardColumn[];
  presets: TerminalPreset[];
  onOpen?: (cardId: string) => void;
  onRunWithPreset?: (card: CardType, preset: TerminalPreset) => void;
  onMove?: (card: CardType, toColumnId: string) => void;
  onDelete?: (card: CardType) => void;
}

export default function CardContextMenu({
  position,
  onClose,
  card,
  columnName,
  columns,
  presets,
  onOpen,
  onRunWithPreset,
  onMove,
  onDelete,
}: CardContextMenuProps) {
  const sortedCols = [...columns].sort(
    (a, b) => COLUMN_ORDER.indexOf(a.name) - COLUMN_ORDER.indexOf(b.name),
  );

  // Workspace owns the repo coordinates needed to build the github.com URL.
  const workspace = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === card.workspace_id) ?? null,
  );
  const isGithub = card.github_issue_number != null;
  const githubUrl =
    isGithub && workspace?.github_owner && workspace?.github_repo
      ? `https://github.com/${workspace.github_owner}/${workspace.github_repo}/issues/${card.github_issue_number}`
      : null;
  const isLocal = card.source === "local";

  const enter = (e: MouseEvent<HTMLButtonElement>) =>
    (e.currentTarget.style.background = "var(--panel)");
  const leave = (e: MouseEvent<HTMLButtonElement>) =>
    (e.currentTarget.style.background = "transparent");

  return (
    <ContextMenu position={position} onClose={onClose} minWidth={180}>
      {onOpen && (
        <button
          style={menuItemStyle}
          onMouseEnter={enter}
          onMouseLeave={leave}
          onClick={() => {
            onOpen(card.id);
            onClose();
          }}
        >
          Open
        </button>
      )}

      {githubUrl && (
        <button
          style={menuItemStyle}
          onMouseEnter={enter}
          onMouseLeave={leave}
          onClick={() => {
            openUrl(githubUrl).catch((e) => console.error("openUrl failed", e));
            onClose();
          }}
        >
          Open on GitHub
        </button>
      )}

      {isLocal && (
        <button
          style={menuItemStyle}
          onMouseEnter={enter}
          onMouseLeave={leave}
          onClick={() => {
            cardPromote(card.id).catch((e) =>
              console.error("card_promote failed", e),
            );
            onClose();
          }}
        >
          Promote to GitHub issue
        </button>
      )}

      <button
        style={menuItemStyle}
        data-testid="card-send-gestor"
        onMouseEnter={enter}
        onMouseLeave={leave}
        onClick={() => {
          gestorEnqueueCard(card.workspace_id, card.id).catch((e) =>
            console.error("gestor_enqueue_card failed", e),
          );
          onClose();
        }}
      >
        Enviar para o Gestor
      </button>

      <button
        style={menuItemStyle}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onClick={() => {
          const text = isGithub ? `#${card.github_issue_number}` : card.id;
          navigator.clipboard
            ?.writeText(text)
            .catch((e) => console.error("clipboard write failed", e));
          onClose();
        }}
      >
        {isGithub ? "Copy issue #" : "Copy card ID"}
      </button>

      {onRunWithPreset && (
        <>
          <div style={dividerStyle} />
          <div style={sectionHeaderStyle}>Run with</div>
          {presets.length === 0 ? (
            <div
              style={{
                padding: "6px 10px",
                fontSize: 13,
                color: "var(--muted)",
              }}
            >
              No presets — add one in Settings
            </div>
          ) : (
            presets.map((preset) => (
              <button
                key={preset.id}
                style={hoverable()}
                onMouseEnter={enter}
                onMouseLeave={leave}
                onClick={() => {
                  onRunWithPreset(card, preset);
                  onClose();
                }}
              >
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {preset.name}
                </span>
              </button>
            ))
          )}
        </>
      )}

      {onMove && (
        <>
          <div style={dividerStyle} />
          <div style={sectionHeaderStyle}>Move to</div>
          {sortedCols.map((col) => {
            const current = col.name === columnName;
            return (
              <button
                key={col.id}
                style={menuItemStyle}
                onMouseEnter={enter}
                onMouseLeave={leave}
                onClick={() => {
                  if (!current) onMove(card, col.id);
                  onClose();
                }}
              >
                <span style={{ width: 14, display: "inline-flex" }}>
                  {current && <CheckIcon size={13} />}
                </span>
                <span>{col.name}</span>
              </button>
            );
          })}
        </>
      )}

      {onDelete && (
        <>
          <div style={dividerStyle} />
          <button
            style={hoverable({ color: "var(--status-error, #e5484d)" })}
            onMouseEnter={enter}
            onMouseLeave={leave}
            onClick={() => {
              onDelete(card);
              onClose();
            }}
          >
            Delete
          </button>
        </>
      )}
    </ContextMenu>
  );
}
