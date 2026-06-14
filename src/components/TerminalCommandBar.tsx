import { useEffect, useMemo, type CSSProperties } from "react";
import { terminalWrite } from "../lib/ipc";
import { topCommands, useCommandFreqStore } from "../store/commandFrequency";

/*
 * TerminalCommandBar: a thin row of chips under a grid terminal showing the
 * commands run most often in this workspace. Clicking a chip writes the command
 * to the PTY followed by Enter — so it's injected AND executed — then refocuses
 * the terminal. The ranking is driven by what's actually typed into the pane
 * (see TerminalPane's onData → useCommandFreqStore.record), so the bar stays
 * empty until a few commands have been run.
 */

const barStyle: CSSProperties = {
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  gap: 5,
  padding: "4px 8px",
  borderTop: "1px solid var(--border)",
  background: "var(--panel)",
  // Horizontal scroll keeps the bar one row tall when commands overflow,
  // rather than wrapping and stealing terminal height.
  overflowX: "auto",
  overflowY: "hidden",
};

const chipStyle: CSSProperties = {
  flexShrink: 0,
  maxWidth: 180,
  padding: "2px 9px",
  fontSize: 10,
  fontFamily: "var(--font-mono)",
  color: "var(--fg)",
  background: "var(--surface-raised)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  cursor: "pointer",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

export interface TerminalCommandBarProps {
  paneId: string;
  workspaceId: string;
  // Refocus the xterm after a chip runs so the next keystroke lands in the
  // terminal, not the button.
  onInject?: () => void;
  // How many chips to surface. Defaults to a handful — enough to be useful
  // without crowding a narrow tile.
  max?: number;
}

export default function TerminalCommandBar({
  paneId,
  workspaceId,
  onInject,
  max = 8,
}: TerminalCommandBarProps) {
  const load = useCommandFreqStore((s) => s.load);
  const map = useCommandFreqStore((s) => s.freqByWorkspace[workspaceId]);

  useEffect(() => {
    load(workspaceId);
  }, [workspaceId, load]);

  const top = useMemo(() => topCommands(map, max), [map, max]);

  // Nothing learned yet — don't reserve a row for an empty bar.
  if (top.length === 0) return null;

  return (
    <div style={barStyle} role="toolbar" aria-label="Frequently used commands">
      {top.map(({ cmd, count }) => (
        <button
          key={cmd}
          style={chipStyle}
          title={`${cmd}  ·  used ${count}×  ·  click to run`}
          // The header above is the pane's drag handle; keep a chip drag from
          // being swallowed by it and stop the click from bubbling to focus
          // handlers that might steal it.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            terminalWrite(paneId, cmd + "\r").catch(() => {});
            onInject?.();
          }}
        >
          {cmd}
        </button>
      ))}
    </div>
  );
}
