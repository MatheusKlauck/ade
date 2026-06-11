import { useState, useRef, useEffect } from "react";
import { useNotificationsStore } from "../store/notifications";
import type { NotifyLevel } from "../store/notifications";
import { BellIcon } from "./icons";

function relativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function levelIcon(level: NotifyLevel): string {
  switch (level) {
    case "error":
      return "✖";
    case "warn":
      return "⚠";
    case "info":
      return "ℹ";
  }
}

function levelColor(level: NotifyLevel): string {
  switch (level) {
    case "error":
      return "var(--status-error)";
    case "warn":
      return "var(--status-warning)";
    case "info":
      return "var(--focus-ring)";
  }
}

export default function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const history = useNotificationsStore((s) => s.history);
  const unread = useNotificationsStore((s) => s.unread);
  const markAllRead = useNotificationsStore((s) => s.markAllRead);
  const clear = useNotificationsStore((s) => s.clear);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function handleToggle() {
    const next = !open;
    if (next) {
      markAllRead();
    }
    setOpen(next);
  }

  return (
    <div style={{ position: "relative" }} ref={panelRef}>
      <button
        onClick={handleToggle}
        title="Notifications"
        aria-label="Notifications"
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          padding: 0,
          flexShrink: 0,
          background: "transparent",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          color: "var(--muted)",
          cursor: "pointer",
        }}
      >
        <BellIcon />
        {unread > 0 && (
          <span
            style={{
              position: "absolute",
              top: -4,
              right: -4,
              background: "var(--status-error)",
              color: "var(--on-accent)",
              fontSize: 10,
              fontWeight: 600,
              lineHeight: "16px",
              minWidth: 16,
              textAlign: "center",
              borderRadius: 8,
              padding: "0 4px",
            }}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: 4,
            width: 380,
            maxHeight: 480,
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
            display: "flex",
            flexDirection: "column",
            zIndex: "var(--z-dropdown)",
            color: "var(--fg)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "10px 14px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600 }}>Notifications</span>
            {history.length > 0 && (
              <button
                onClick={() => {
                  clear();
                }}
                style={{
                  fontSize: 12,
                  background: "transparent",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  color: "var(--muted)",
                  cursor: "pointer",
                  padding: "2px 8px",
                }}
              >
                Clear
              </button>
            )}
          </div>

          <div
            style={{
              overflowY: "auto",
              flex: 1,
              padding: "4px 0",
            }}
          >
            {history.length === 0 && (
              <div
                style={{
                  padding: "24px 14px",
                  textAlign: "center",
                  color: "var(--muted)",
                  fontSize: 13,
                }}
              >
                No notifications
              </div>
            )}
            {history.map((n) => (
              <div
                key={n.timestamp + "-" + n.code}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "8px 14px",
                  borderBottom: "1px solid var(--border)",
                  fontSize: 13,
                }}
              >
                <span
                  style={{
                    color: levelColor(n.level),
                    fontSize: 14,
                    lineHeight: "18px",
                    flexShrink: 0,
                  }}
                >
                  {levelIcon(n.level)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>{n.code}</div>
                  <div
                    style={{
                      color: "var(--fg)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {n.message}
                  </div>
                </div>
                <span
                  style={{
                    color: "var(--muted)",
                    fontSize: 11,
                    flexShrink: 0,
                    whiteSpace: "nowrap",
                  }}
                >
                  {relativeTime(n.timestamp)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}