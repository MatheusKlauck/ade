import type { CSSProperties } from "react";
import Tabs from "./Tabs";
import NotificationCenter from "./NotificationCenter";
import NewTerminalButton from "./NewTerminalButton";
import type { TerminalPreset } from "../store/settings";
import { GearIcon } from "./icons";

export type ViewMode = "ledger" | "classic";

// macOS uses titleBarStyle: Overlay, so the native traffic lights sit on the
// left of our bar — inset the content past them. Other platforms keep native
// chrome (titleBarStyle is ignored), so no inset is needed there.
const isMac =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh");
const TRAFFIC_INSET = isMac ? 84 : 12;

interface AppBarProps {
  onOpenSettings: () => void;
  onNewTerminal: (preset?: TerminalPreset) => void;
}

const barStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-sm)",
  height: 40,
  flexShrink: 0,
  paddingLeft: TRAFFIC_INSET,
  paddingRight: "var(--space-sm)",
  borderBottom: "1px solid var(--border)",
  background: "var(--bg)",
};

const iconBtnStyle: CSSProperties = {
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
};

export default function AppBar({ onOpenSettings, onNewTerminal }: AppBarProps) {
  return (
    // The whole bar is the window drag handle. Tauri starts a native window drag
    // only when the mousedown target itself carries data-tauri-drag-region, so
    // the tabs/buttons nested inside still receive their own clicks. paddingLeft
    // clears the macOS traffic lights and is itself part of the drag surface.
    <div data-tauri-drag-region style={barStyle}>
      {/* Workspace tabs — shrink + scroll when crowded */}
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          alignSelf: "stretch",
          minWidth: 0,
          overflowX: "auto",
          flex: 1,
        }}
      >
        <Tabs />
      </div>

      <NewTerminalButton onNewTerminal={onNewTerminal} />
      <NotificationCenter />
      <button
        onClick={onOpenSettings}
        title="Settings"
        aria-label="Settings"
        style={iconBtnStyle}
      >
        <GearIcon />
      </button>
    </div>
  );
}
