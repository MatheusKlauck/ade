import {
  useEffect,
  useRef,
  useCallback,
  useId,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

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
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => restoreFocusRef.current?.focus?.();
  }, []);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
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
    [onCancel]
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.6)",
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
