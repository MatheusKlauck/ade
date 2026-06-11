import NotificationCenter from "./NotificationCenter";
import TerminalPane from "./TerminalPane";
import type { OpenTerminal } from "../store/terminals";

interface TerminalAreaProps {
  panes: OpenTerminal[];
  onNewTerminal: () => void;
  onRemovePane: (paneId: string) => void;
  highlightedWindowId: string | null;
  onHighlightDone: () => void;
  onOpenSettings: () => void;
}

export default function TerminalArea({
  panes,
  onNewTerminal,
  onRemovePane,
  highlightedWindowId,
  onHighlightDone,
  onOpenSettings,
}: TerminalAreaProps) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--muted)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Terminals{panes.length > 0 ? ` · ${panes.length}` : ""}
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={onNewTerminal}
          style={{
            padding: "4px 12px",
            background: "var(--accent)",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          New terminal
        </button>
        <NotificationCenter />
        <button
          onClick={onOpenSettings}
          title="Settings"
          style={{
            padding: "4px 8px",
            fontSize: 14,
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--muted)",
            cursor: "pointer",
          }}
        >
          ⚙
        </button>
      </div>
      {panes.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            color: "var(--muted)",
          }}
        >
          <span style={{ fontSize: 13 }}>No terminals open</span>
          <button
            onClick={onNewTerminal}
            style={{
              padding: "8px 20px",
              background: "var(--accent)",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Open terminal
          </button>
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
            gridAutoRows: "minmax(0, 1fr)",
            gap: 8,
            padding: 8,
            overflow: "auto",
          }}
        >
          {panes.map((pane) => (
            <div
              key={pane.paneId}
              id={`terminal-pane-${pane.windowId}`}
              style={{
                minHeight: 200,
                minWidth: 0,
                border: "1px solid var(--border)",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              <TerminalPane
                pane={pane}
                onRemove={() => onRemovePane(pane.paneId)}
                highlighted={highlightedWindowId === pane.windowId}
                onHighlightDone={onHighlightDone}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
