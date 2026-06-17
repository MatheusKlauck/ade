import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

export interface ResizeDividerProps {
  orientation: "row" | "col";
  rectStyle: CSSProperties;
  onPointerDown: (e: ReactPointerEvent) => void;
}

/** A draggable gutter between two tiles or two rows. Invisible until hovered. */
export default function ResizeDivider({
  orientation,
  rectStyle,
  onPointerDown,
}: ResizeDividerProps) {
  return (
    <div
      className="term-divider"
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        zIndex: 15,
        cursor: orientation === "row" ? "row-resize" : "col-resize",
        ...rectStyle,
      }}
    />
  );
}
