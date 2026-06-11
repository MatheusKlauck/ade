import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  terminalClose,
  terminalResize,
  terminalWrite,
} from "../lib/ipc";
import type { OpenTerminal } from "../store/terminals";

interface TerminalPaneProps {
  pane: OpenTerminal;
  onRemove: () => void;
  highlighted?: boolean;
  onHighlightDone?: () => void;
}

export default function TerminalPane({ pane, onRemove, highlighted, onHighlightDone }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<{ dispose: () => void } | null>(null);
  const flushRef = useRef<number | null>(null);
  const chunkBufRef = useRef<Uint8Array[]>([]);

  useEffect(() => {
    const term = new Terminal({ cursorBlink: true });
    termRef.current = term;

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);

    // Try WebGL renderer; fallback to canvas is automatic.
    import("@xterm/addon-webgl")
      .then((mod) => {
        const webgl = new mod.WebglAddon();
        webglRef.current = webgl;
        term.loadAddon(webgl);
      })
      .catch(() => {
        // canvas fallback is built-in
      });

    if (containerRef.current) {
      term.open(containerRef.current);
      fit.fit();
    }

    // Data from user typing
    term.onData((data) => {
      terminalWrite(pane.paneId, data).catch(() => {});
    });

    // Wire channel
    pane.channel.onmessage = (msg: unknown) => {
      const buf = msg as ArrayBuffer;
      const bytes = new Uint8Array(buf);
      chunkBufRef.current.push(bytes);

      if (flushRef.current == null) {
        flushRef.current = requestAnimationFrame(() => {
          const t = termRef.current;
          if (t) {
            for (const chunk of chunkBufRef.current) {
              t.write(chunk);
            }
          }
          chunkBufRef.current = [];
          flushRef.current = null;
        });
      }
    };

    // Resize observer
    const ro = new ResizeObserver(() => {
      fit.fit();
      const dims = fit.proposeDimensions();
      if (dims) {
        terminalResize(
          pane.paneId,
          Math.floor(dims.cols),
          Math.floor(dims.rows)
        ).catch(() => {});
      }
    });
    if (containerRef.current) {
      ro.observe(containerRef.current);
    }

    return () => {
      ro.disconnect();
      if (flushRef.current != null) {
        cancelAnimationFrame(flushRef.current);
        flushRef.current = null;
      }
      if (webglRef.current) {
        try {
          webglRef.current.dispose();
        } catch {}
        webglRef.current = null;
      }
      term.dispose();
      termRef.current = null;
      // Close the PTY viewer (kills viewer process, tmux window survives)
      terminalClose(pane.paneId).catch(() => {});
    };
  }, [pane.paneId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Highlight effect: scroll into view and add brief glow
  useEffect(() => {
    if (!highlighted) return;
    // Scroll the pane into view
    containerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    // Clear highlight after 1 second
    const timer = setTimeout(() => {
      onHighlightDone?.();
    }, 1000);
    return () => clearTimeout(timer);
  }, [highlighted, onHighlightDone]);

  return (
    <div
      className={highlighted ? "terminal-pane-highlight" : undefined}
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
    >
      <div style={{ display: "flex", justifyContent: "flex-end", padding: 4 }}>
        <button onClick={onRemove}>Close</button>
      </div>
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, background: "#000" }}
      />
    </div>
  );
}