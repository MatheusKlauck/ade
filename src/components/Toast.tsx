import { useEffect } from "react";
import { CloseIcon } from "./icons";

export interface ToastData {
  level: string;
  code: string;
  message: string;
}

// A toast in the on-screen stack: its data plus a stable id used as the React
// key and the dismissal handle.
export interface ToastItem extends ToastData {
  id: number;
}

// Non-error toasts linger, then auto-dismiss. Errors persist until the user
// dismisses them — nothing should fail silently, or vanish silently.
const AUTO_DISMISS_MS: Record<string, number> = {
  info: 6000,
  warn: 8000,
};

// Each level gets a distinct, legible pairing. Warning uses dark ink because
// white on amber fails contrast; error/info carry white on a deep surface.
function toastColors(level: string): { bg: string; ink: string } {
  switch (level) {
    case "error":
      return { bg: "var(--status-error-deep)", ink: "var(--on-accent)" };
    case "warn":
      return { bg: "var(--status-warning)", ink: "var(--accent-ink)" };
    default:
      return { bg: "var(--status-info)", ink: "var(--on-accent)" };
  }
}

interface ToastProps {
  toast: ToastItem;
  onDismiss: (id: number) => void;
}

/**
 * Fixed top-right container for the toast stack. Newest sits at the bottom of
 * the column. `pointerEvents: none` lets clicks fall through the empty gaps to
 * the app behind; each toast re-enables pointer events for its own controls.
 */
export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: "var(--z-toast)",
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

export default function Toast({ toast, onDismiss }: ToastProps) {
  const isError = toast.level === "error";

  // Errors stay until dismissed; everything else auto-dismisses. Keyed on the
  // toast object (stable per id) so a re-render doesn't reset the timer.
  // onDismiss must be stable.
  useEffect(() => {
    if (isError) return;
    const ms = AUTO_DISMISS_MS[toast.level] ?? 6000;
    const timer = setTimeout(() => onDismiss(toast.id), ms);
    return () => clearTimeout(timer);
  }, [toast, isError, onDismiss]);

  const { bg, ink } = toastColors(toast.level);

  return (
    <div
      className="ade-toast"
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        maxWidth: 380,
        padding: "12px 14px",
        borderRadius: "var(--radius-md)",
        background: bg,
        color: ink,
        boxShadow: "0 6px 20px rgba(0, 0, 0, 0.35)",
        pointerEvents: "auto",
      }}
    >
      <div style={{ fontSize: 13, lineHeight: 1.4, minWidth: 0 }}>
        <strong style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
          {toast.code}
        </strong>
        <span style={{ opacity: 0.5, margin: "0 6px" }} aria-hidden>
          ·
        </span>
        {toast.message}
      </div>
      <button
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        title="Dismiss"
        style={{
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 20,
          height: 20,
          marginTop: -1,
          padding: 0,
          border: "none",
          borderRadius: "var(--radius-sm)",
          background: "transparent",
          color: "currentColor",
          opacity: 0.85,
          cursor: "pointer",
        }}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
}
