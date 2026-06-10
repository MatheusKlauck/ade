import { useState, useEffect } from "react";
import { subscribeNotify, terminalOpen } from "./lib/ipc";
import TerminalPane from "./components/TerminalPane";
import Board from "./components/Board";
import { useTerminalsStore, type OpenTerminal } from "./store/terminals";

export default function App() {
  const [toast, setToast] = useState<{
    level: string;
    code: string;
    message: string;
  } | null>(null);

  const panes = useTerminalsStore((s) => s.panes);
  const addPane = useTerminalsStore((s) => s.addPane);
  const removePane = useTerminalsStore((s) => s.removePane);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    subscribeNotify((payload) => {
      setToast(payload);
      setTimeout(() => setToast(null), 6000);
    }).then((u) => {
      unsub = u;
    });
    return () => {
      if (unsub) unsub();
    };
  }, []);

  const handleNewTerminal = async () => {
    try {
      const result = await terminalOpen("dev");
      const pane: OpenTerminal = {
        paneId: result.paneId,
        windowId: result.windowId,
        workspaceId: "dev",
        channel: result.channel,
      };
      addPane(pane);
    } catch (e) {
      console.error(e);
    }
  };

  const handleRemove = (paneId: string) => {
    removePane(paneId);
  };

  return (
    <div style={{ position: "relative", minHeight: "100vh", padding: 16 }}>
      {toast && (
        <div
          style={{
            position: "fixed",
            top: 16,
            right: 16,
            padding: "12px 16px",
            borderRadius: 6,
            background: toast.level === "error" ? "#c0392b" : "#2980b9",
            color: "#fff",
            zIndex: 9999,
          }}
        >
          <strong>{toast.code}</strong>: {toast.message}
        </div>
      )}
      <Board />
      <div style={{ marginTop: 16 }}>
        <button onClick={handleNewTerminal}>New terminal</button>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
          {panes.map((pane) => (
            <div
              key={pane.paneId}
              style={{
                width: "48%",
                height: 300,
                border: "1px solid #333",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              <TerminalPane
                pane={pane}
                onRemove={() => handleRemove(pane.paneId)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
