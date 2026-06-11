import type { CSSProperties } from "react";

// Monochrome, stroke-based icon set (lucide-style) replacing system emoji in the
// shell chrome. Same visual family as Onboarding's FolderIcon: 24x24 viewBox,
// currentColor stroke, 1.8 weight, round caps. Tint via the parent's `color`.

interface IconProps {
  size?: number;
  style?: CSSProperties;
}

function svgStyle(size: number, style?: CSSProperties): CSSProperties {
  return { width: size, height: size, display: "block", flexShrink: 0, ...style };
}

const COMMON = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function GearIcon({ size = 16, style }: IconProps) {
  return (
    <svg aria-hidden {...COMMON} style={svgStyle(size, style)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V15Z" />
    </svg>
  );
}

export function BellIcon({ size = 16, style }: IconProps) {
  return (
    <svg aria-hidden {...COMMON} style={svgStyle(size, style)}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

export function CloseIcon({ size = 16, style }: IconProps) {
  return (
    <svg aria-hidden {...COMMON} style={svgStyle(size, style)}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function PlusIcon({ size = 16, style }: IconProps) {
  return (
    <svg aria-hidden {...COMMON} style={svgStyle(size, style)}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

// Down-chevron at rest; rotate via the parent's `style.transform` to point in
// any direction (board toggle, tray restore) so disclosure glyphs share the
// same stroke family as the rest of the chrome instead of text triangles.
export function ChevronIcon({ size = 16, style }: IconProps) {
  return (
    <svg aria-hidden {...COMMON} style={svgStyle(size, style)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

// Checkmark — terminal completion badge on the workspace pill.
export function CheckIcon({ size = 16, style }: IconProps) {
  return (
    <svg aria-hidden {...COMMON} style={svgStyle(size, style)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

// Closed padlock — marks a locked terminal (can't be closed until unlocked).
export function LockIcon({ size = 16, style }: IconProps) {
  return (
    <svg aria-hidden {...COMMON} style={svgStyle(size, style)}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

// Open padlock — the "Unlock" affordance in the terminal header context menu.
export function LockOpenIcon({ size = 16, style }: IconProps) {
  return (
    <svg aria-hidden {...COMMON} style={svgStyle(size, style)}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.5-1.7" />
    </svg>
  );
}

// Circular refresh arrows — the "re-sync" affordance on the aggregate sync chip.
export function RefreshIcon({ size = 16, style }: IconProps) {
  return (
    <svg aria-hidden {...COMMON} style={svgStyle(size, style)}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}
