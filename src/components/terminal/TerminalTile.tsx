import { useRef, useState, useEffect, type CSSProperties } from "react";
import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { terminalWrite } from "../../lib/ipc";
import type { OpenTerminal } from "../../store/terminals";

export interface TerminalTileProps {
  pane: OpenTerminal;
  style: CSSProperties;
  hidden: boolean;
  children: React.ReactNode;
  onReorder: (draggedWin: string, targetWin: string, edge: "before" | "after") => void;
  entering: boolean;
  onEntered: () => void;
}

/** One tile: an absolutely-positioned wrapper that is also a drop target for
 * pane-reorder drags. It owns the little edge indicator shown while another
 * pane's header is dragged over it. */
export default function TerminalTile({
  pane,
  style,
  hidden,
  children,
  onReorder,
  entering,
  onEntered,
}: TerminalTileProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [edge, setEdge] = useState<"before" | "after" | null>(null);
  // True while a skill from the SkillsSidebar is dragged over this tile.
  const [skillOver, setSkillOver] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      canDrop: ({ source }) =>
        (typeof source.data.termWindowId === "string" &&
          source.data.termWindowId !== pane.windowId) ||
        typeof source.data.skillCommand === "string",
      onDrag: ({ source, location }) => {
        if (typeof source.data.skillCommand === "string") {
          setSkillOver(true);
          return;
        }
        const rect = el.getBoundingClientRect();
        setEdge(
          location.current.input.clientX < rect.left + rect.width / 2
            ? "before"
            : "after"
        );
      },
      onDragLeave: () => {
        setEdge(null);
        setSkillOver(false);
      },
      onDrop: ({ source, location }) => {
        if (typeof source.data.skillCommand === "string") {
          setSkillOver(false);
          // Type the slash command into the pane, no Enter — the user can add
          // arguments and submit it themselves.
          terminalWrite(pane.paneId, source.data.skillCommand).catch(() => {});
          return;
        }
        const rect = el.getBoundingClientRect();
        const e =
          location.current.input.clientX < rect.left + rect.width / 2
            ? "before"
            : "after";
        setEdge(null);
        onReorder(source.data.termWindowId as string, pane.windowId, e);
      },
    });
  }, [pane.windowId, pane.paneId, onReorder]);

  return (
    <div
      ref={ref}
      id={`terminal-pane-${pane.windowId}`}
      style={style}
      className={entering ? "ade-pane-enter" : undefined}
      onAnimationEnd={(e) => {
        // Only the tile's own entrance — ignore animationend bubbling up from
        // a child (e.g. the focus-glow on the pane).
        if (e.target === e.currentTarget) onEntered();
      }}
    >
      {skillOver && !hidden && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            border: "2px solid var(--accent)",
            borderRadius: 4,
            zIndex: 25,
            pointerEvents: "none",
          }}
        />
      )}
      {edge && !hidden && (
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            [edge === "before" ? "left" : "right"]: 0,
            width: 3,
            background: "var(--accent)",
            zIndex: 25,
            pointerEvents: "none",
          }}
        />
      )}
      {children}
    </div>
  );
}
