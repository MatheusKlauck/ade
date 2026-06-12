import { useRef, useId } from "react";
import { useModalFocus } from "../lib/useModalFocus";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Tints the confirm button as a danger action (irreversible). */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// Modal confirmation for actions that can't be undone (e.g. killing a tmux
// session). Mirrors Settings' a11y contract: role=alertdialog, aria-modal,
// Esc-to-cancel, focus trap, and focus restore. Initial focus lands on Cancel
// so a reflexive Enter never triggers the destructive path.
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();

  // Initial focus lands on Cancel so a reflexive Enter never confirms.
  const { panelRef, handleKeyDown } = useModalFocus(onCancel, cancelRef);

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
      onClick={onCancel}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 24,
          minWidth: 360,
          maxWidth: 460,
          color: "var(--fg)",
          outline: "none",
        }}
      >
        <h3
          id={titleId}
          style={{
            margin: 0,
            marginBottom: 8,
            fontSize: 16,
            color: "var(--fg)",
            overflowWrap: "anywhere",
          }}
        >
          {title}
        </h3>
        <p
          id={messageId}
          style={{
            margin: 0,
            marginBottom: 20,
            fontSize: 13,
            lineHeight: 1.5,
            color: "var(--muted)",
          }}
        >
          {message}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            ref={cancelRef}
            onClick={onCancel}
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
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: "6px 16px",
              fontSize: 13,
              background: destructive ? "var(--status-error-deep)" : "var(--accent)",
              color: destructive ? "var(--on-accent)" : "var(--accent-ink)",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
