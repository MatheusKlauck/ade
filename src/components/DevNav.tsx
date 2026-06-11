import { useState } from "react";
import type { CSSProperties } from "react";

/**
 * Development-only floating navigator. Lets you jump between app screens
 * without navigating the normal UI flow. Renders only when
 * import.meta.env.DEV is true (Vite dev mode).
 */

interface Screen {
  id: string;
  label: string;
  icon: string;
}

const SCREENS: Screen[] = [
  { id: "onboarding", label: "Onboarding", icon: "⊕" },
  { id: "workspace", label: "Workspace (main)", icon: "⊡" },
  { id: "settings", label: "Settings", icon: "⚙" },
  { id: "board", label: "Board (drawer)", icon: "▦" },
  { id: "card-detail", label: "Card Detail", icon: "◧" },
  { id: "notifications", label: "Notifications", icon: "🔔" },
];

const FAB_STYLE: CSSProperties = {
  position: "fixed",
  bottom: 16,
  left: 16,
  width: 36,
  height: 36,
  borderRadius: "50%",
  border: "1px solid var(--border)",
  background: "var(--panel)",
  color: "var(--muted)",
  fontSize: 16,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9999,
  padding: 0,
  lineHeight: 1,
  transition: "background var(--dur-instant) var(--ease-out-quart)",
};

const PANEL_STYLE: CSSProperties = {
  position: "fixed",
  bottom: 60,
  left: 16,
  width: 200,
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg)",
  padding: "var(--space-sm)",
  zIndex: 9999,
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const ITEM_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-sm)",
  padding: "6px 10px",
  background: "transparent",
  border: "none",
  borderRadius: "var(--radius-sm)",
  color: "var(--fg)",
  fontSize: 12,
  fontFamily: "var(--font-sans)",
  cursor: "pointer",
  textAlign: "left",
  width: "100%",
};

const HEADER_STYLE: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase" as const,
  color: "var(--muted)",
  padding: "4px 10px 6px",
  fontFamily: "var(--font-sans)",
};

export interface DevNavProps {
  onNavigate: (screenId: string) => void;
}

export default function DevNav({ onNavigate }: DevNavProps) {
  const [open, setOpen] = useState(false);

  if (!import.meta.env.DEV) return null;

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        style={FAB_STYLE}
        title="Dev Navigator"
        aria-label="Open dev navigator"
      >
        ⚡
      </button>
      {open && (
        <div style={PANEL_STYLE}>
          <div style={HEADER_STYLE}>Screens</div>
          {SCREENS.map((s) => (
            <button
              key={s.id}
              style={ITEM_STYLE}
              onClick={() => {
                onNavigate(s.id);
                setOpen(false);
              }}
            >
              <span style={{ width: 16, textAlign: "center", flexShrink: 0 }}>
                {s.icon}
              </span>
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}