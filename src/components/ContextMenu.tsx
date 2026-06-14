import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

/** Shared row treatment for context-menu items — the card "Run with…" menu and
 * the terminal header menu use the exact same style so they read as one system. */
export const menuItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 10px",
  background: "transparent",
  border: "none",
  borderRadius: "var(--radius-sm)",
  color: "var(--fg)",
  cursor: "pointer",
  fontSize: 13,
  textAlign: "left",
};

/** Block variant for dropdown menus that ellipsize long labels (the
 * "New terminal" preset menu). */
export const menuItemBlockStyle: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "6px 10px",
  fontSize: 13,
  background: "transparent",
  border: "none",
  borderRadius: 4,
  color: "var(--fg)",
  cursor: "pointer",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

export interface ContextMenuPosition {
  x: number;
  y: number;
}

/** Right-click menu state: `menu` is the open position ({x, y}) or null when
 * closed; `open`/`close` flip it. Escape dismisses while open. */
export function useContextMenu() {
  const [menu, setMenu] = useState<ContextMenuPosition | null>(null);
  const open = useCallback((x: number, y: number) => setMenu({ x, y }), []);
  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  return { menu, open, close };
}

/** Fixed-position context menu with a full-screen backdrop that swallows the
 * next click/right-click so the menu closes when you act anywhere outside it. */
export function ContextMenu({
  position,
  onClose,
  minWidth,
  children,
}: {
  position: ContextMenuPosition;
  onClose: () => void;
  minWidth?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Start at the click point, then nudge inward once we can measure the menu so
  // it never spills past the right/bottom edge (and never lands off-screen when
  // opened from near the corner).
  const [coords, setCoords] = useState(position);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    const maxX = window.innerWidth - width - margin;
    const maxY = window.innerHeight - height - margin;
    setCoords({
      x: Math.max(margin, Math.min(position.x, maxX)),
      y: Math.max(margin, Math.min(position.y, maxY)),
    });
  }, [position.x, position.y]);

  return (
    <>
      <div
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
        style={{ position: "fixed", inset: 0, zIndex: 1000 }}
      />
      <div
        ref={ref}
        style={{
          position: "fixed",
          top: coords.y,
          left: coords.x,
          zIndex: 1001,
          minWidth,
          maxHeight: "calc(100vh - 16px)",
          overflowY: "auto",
          padding: 4,
          background: "var(--surface-raised)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
          boxShadow: "0 4px 16px rgba(0, 0, 0, 0.35)",
        }}
      >
        {children}
      </div>
    </>
  );
}
