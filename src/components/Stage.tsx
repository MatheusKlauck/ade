import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import TerminalPane from "./TerminalPane";
import { terminalWrite } from "../lib/ipc";
import type { OpenTerminal } from "../store/terminals";
import {
  useLedgerStore,
  locateTab,
  activateTab,
  moveTabToPanel,
  splitOut,
  type StageState,
  type Attention,
} from "../store/ledger";

/*
 * Stage: the terminal half of the ledger.
 *
 *   ┌ panel 0 ──────────────────┬ panel 1 (optional) ───────┐
 *   │ [tab][tab]   quick-replies│ [tab]              ⧉      │   ← TabStrip (TABS_H)
 *   │ ┌───────────────────────┐ │ ┌──────────────────────┐  │
 *   │ │ TerminalPane (active) │ │ │ TerminalPane (active)│  │   ← absolutely positioned
 *   │ └───────────────────────┘ │ └──────────────────────┘  │
 *   └───────────────────────────┴───────────────────────────┘
 *
 * Every TerminalPane is a direct child of the ONE relative container and is
 * never re-parented: switching tabs / splitting panels only flips position
 * styles (display:none for inactive), so React never unmounts a pane and its
 * PTY survives. Positions are pure CSS percentages — no measuring.
 */

const TABS_H = 34;
const PAD = 6;

export interface StageProps {
  panes: OpenTerminal[]; // all open panes of the active workspace
  stage: StageState; // already normalized against `panes`
  onStageChange: (next: StageState) => void;
  titleFor: (pane: OpenTerminal) => string;
  lockedFor: (pane: OpenTerminal) => boolean;
  hasCustomName: (pane: OpenTerminal) => boolean;
  attentionByWindow: Record<string, Attention>;
  onToggleLock: (pane: OpenTerminal) => void;
  onRename: (pane: OpenTerminal, name: string) => void;
  onRemove: (pane: OpenTerminal) => void; // already lock-guarded by the caller
  highlightedWindowId: string | null;
  onHighlightDone: () => void;
}

const QUICK_KEYS: { label: string; data: string; title: string }[] = [
  { label: "1", data: "1", title: "Send 1 to the agent" },
  { label: "2", data: "2", title: "Send 2 to the agent" },
  { label: "3", data: "3", title: "Send 3 to the agent" },
  { label: "↩", data: "\r", title: "Send Enter" },
  { label: "esc", data: "\x1b", title: "Send Escape (interrupt)" },
];

function attentionDotColor(attention: Attention | undefined): string {
  if (attention?.kind === "input") return "var(--accent)";
  if (attention?.kind === "failed") return "var(--status-error, #e74c3c)";
  return "var(--status-success, #3fe07a)";
}

/** One tab button: click to activate, drag (termWindowId) to another panel. */
function Tab({
  pane,
  title,
  active,
  attention,
  onActivate,
}: {
  pane: OpenTerminal;
  title: string;
  active: boolean;
  attention?: Attention;
  onActivate: () => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return draggable({
      element: el,
      getInitialData: () => ({ termWindowId: pane.windowId }),
    });
  }, [pane.windowId]);

  return (
    <button
      ref={ref}
      onClick={onActivate}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        maxWidth: 220,
        padding: "5px 12px",
        fontSize: 11,
        fontFamily: "var(--font-sans)",
        fontWeight: active ? 600 : 400,
        color: active ? "var(--fg)" : "var(--muted)",
        background: active ? "var(--bg)" : "var(--surface-input)",
        border: `1px solid ${
          active && attention?.kind === "input" ? "var(--accent)" : "var(--border)"
        }`,
        borderBottom: active ? "1px solid var(--bg)" : "1px solid var(--border)",
        borderRadius: "6px 6px 0 0",
        cursor: "pointer",
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          flexShrink: 0,
          background: attentionDotColor(attention),
        }}
      />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
    </button>
  );
}

/** Tab strip for one panel; also a drop target that pulls a dragged terminal
 * (tab or pane header — both carry termWindowId) into this panel. */
function TabStrip({
  panelIdx,
  stage,
  panes,
  titleFor,
  attentionByWindow,
  onStageChange,
  quickReplyPane,
  canSplit,
  onSplit,
}: {
  panelIdx: number;
  stage: StageState;
  panes: Map<string, OpenTerminal>;
  titleFor: (pane: OpenTerminal) => string;
  attentionByWindow: Record<string, Attention>;
  onStageChange: (next: StageState) => void;
  quickReplyPane: OpenTerminal | null;
  canSplit: boolean;
  onSplit: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [over, setOver] = useState(false);
  const panel = stage.panels[panelIdx];

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      canDrop: ({ source }) => typeof source.data.termWindowId === "string",
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: ({ source }) => {
        setOver(false);
        const windowId = source.data.termWindowId as string;
        onStageChange(moveTabToPanel(stage, windowId, panelIdx));
      },
    });
    // stage/panelIdx in deps: the handler closes over the current stage value.
  }, [stage, panelIdx, onStageChange]);

  const quickBtn: CSSProperties = {
    padding: "2px 9px",
    fontSize: 10,
    fontWeight: 600,
    fontFamily: "var(--font-mono)",
    color: "var(--fg)",
    background: "var(--surface-raised)",
    border: "1px solid var(--border)",
    borderRadius: 5,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };

  return (
    <div
      ref={ref}
      style={{
        height: TABS_H,
        flexShrink: 0,
        display: "flex",
        alignItems: "flex-end",
        gap: 4,
        padding: `${PAD}px ${PAD + 4}px 0`,
        boxShadow: over ? "inset 0 0 0 1px var(--accent)" : "none",
        overflow: "hidden",
      }}
    >
      {panel.tabs.map((windowId) => {
        const pane = panes.get(windowId);
        if (!pane) return null;
        return (
          <Tab
            key={windowId}
            pane={pane}
            title={titleFor(pane)}
            active={panel.active === windowId}
            attention={attentionByWindow[windowId]}
            onActivate={() => onStageChange(activateTab(stage, windowId))}
          />
        );
      })}
      <div style={{ flex: 1 }} />
      {quickReplyPane && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            paddingBottom: 4,
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: "var(--accent)",
              fontFamily: "var(--font-sans)",
              whiteSpace: "nowrap",
            }}
          >
            ● input
          </span>
          {QUICK_KEYS.map((k) => (
            <button
              key={k.label}
              style={{
                ...quickBtn,
                borderColor: k.label === "1" ? "var(--accent)" : "var(--border)",
              }}
              title={k.title}
              onClick={() => {
                terminalWrite(quickReplyPane.paneId, k.data).catch(() => {});
              }}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
      {canSplit && (
        <button
          onClick={onSplit}
          title="Move active terminal to the other half"
          aria-label="Split terminal to other panel"
          style={{
            ...quickBtn,
            fontFamily: "var(--font-sans)",
            marginBottom: 4,
            color: "var(--muted)",
          }}
        >
          ⧉
        </button>
      )}
    </div>
  );
}

export default function Stage({
  panes,
  stage,
  onStageChange,
  titleFor,
  lockedFor,
  hasCustomName,
  attentionByWindow,
  onToggleLock,
  onRename,
  onRemove,
  highlightedWindowId,
  onHighlightDone,
}: StageProps) {
  const fullscreenWindowId = useLedgerStore((s) => s.fullscreenWindowId);
  const setFullscreen = useLedgerStore((s) => s.setFullscreen);

  const paneByWin = new Map(panes.map((p) => [p.windowId, p]));
  const panelCount = stage.panels.length;

  // Fullscreen only counts while its window is still open in this workspace.
  const fsId =
    fullscreenWindowId && paneByWin.has(fullscreenWindowId)
      ? fullscreenWindowId
      : null;

  const totalTabs = stage.panels.reduce((n, p) => n + p.tabs.length, 0);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        display: "flex",
        background: "var(--panel)",
      }}
    >
      {/* Panel chrome (tab strips + body placeholders) */}
      {stage.panels.map((panel, idx) => {
        const activePane = panel.active ? paneByWin.get(panel.active) : undefined;
        const needsInput =
          activePane &&
          attentionByWindow[activePane.windowId]?.kind === "input";
        return (
          <div
            key={idx}
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              borderLeft: idx > 0 ? "1px solid var(--border)" : "none",
            }}
          >
            <TabStrip
              panelIdx={idx}
              stage={stage}
              panes={paneByWin}
              titleFor={titleFor}
              attentionByWindow={attentionByWindow}
              onStageChange={onStageChange}
              quickReplyPane={needsInput && activePane ? activePane : null}
              canSplit={totalTabs > 1 && !!panel.active}
              onSplit={() => {
                if (panel.active) onStageChange(splitOut(stage, panel.active));
              }}
            />
            <div style={{ flex: 1 }} />
          </div>
        );
      })}

      {/* Panes overlay — every pane stays mounted; only position styles flip. */}
      {panes.map((pane) => {
        const loc = locateTab(stage, pane.windowId);
        const isFs = fsId === pane.windowId;
        const visible = isFs || (fsId == null && !!loc?.isActive);
        const locked = lockedFor(pane);
        const attention = attentionByWindow[pane.windowId];
        const borderColor =
          attention?.kind === "input"
            ? "var(--accent)"
            : locked
            ? "var(--accent)"
            : "var(--border)";

        const wrapperStyle: CSSProperties = isFs
          ? {
              position: "absolute",
              inset: PAD,
              zIndex: 20,
              border: `1px solid ${borderColor}`,
              borderRadius: 6,
              overflow: "hidden",
              background: "var(--bg)",
            }
          : !visible || !loc
          ? { display: "none" }
          : {
              position: "absolute",
              top: TABS_H,
              bottom: PAD,
              left:
                panelCount === 2
                  ? `calc(${loc.panelIdx * 50}% + ${PAD + 4}px)`
                  : PAD + 4,
              width:
                panelCount === 2
                  ? `calc(50% - ${(PAD + 4) * 1.5}px)`
                  : `calc(100% - ${(PAD + 4) * 2}px)`,
              border: `1px solid ${borderColor}`,
              borderRadius: "0 6px 6px 6px",
              overflow: "hidden",
              background: "var(--bg)",
            };

        return (
          <div key={pane.paneId} id={`terminal-pane-${pane.windowId}`} style={wrapperStyle}>
            <TerminalPane
              pane={pane}
              title={titleFor(pane)}
              maximized={isFs}
              locked={locked}
              hasCustomName={hasCustomName(pane)}
              onToggleLock={() => onToggleLock(pane)}
              onRename={(name) => onRename(pane, name)}
              onRemove={() => onRemove(pane)}
              // In the tab model "minimize" means: show the panel's next tab.
              onToggleMinimize={() => {
                const l = locateTab(stage, pane.windowId);
                if (!l) return;
                const tabs = stage.panels[l.panelIdx].tabs;
                if (tabs.length < 2) return;
                const next = tabs[(tabs.indexOf(pane.windowId) + 1) % tabs.length];
                onStageChange(activateTab(stage, next));
              }}
              onToggleMaximize={() =>
                setFullscreen(isFs ? null : pane.windowId)
              }
              highlighted={highlightedWindowId === pane.windowId}
              onHighlightDone={onHighlightDone}
            />
          </div>
        );
      })}
    </div>
  );
}
