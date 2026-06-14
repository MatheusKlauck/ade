import { useEffect, useMemo, useRef, useState } from "react";
import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { skillsList, type SkillInfo } from "../lib/ipc";
import { ChevronIcon } from "./icons";

const SPINE_W = 54; // category rail (always visible)
const REVEAL_W = 248; // skill list panel
const OPEN_W = SPINE_W + REVEAL_W;

// How many lines of the description to show before clamping. Double-clicking a
// row toggles between this compact view and the full description.
const DESC_CLAMP_LINES = 2;

// Recents are local-only: the last few skill commands dragged onto a terminal,
// surfaced as a quick-launch tray so the common ones are one drag away from
// anywhere. No backend involved.
const RECENTS_KEY = "ade.skills.recents";
const RECENTS_MAX = 8;

// Pseudo-tabs that live alongside the real skill categories on the spine.
const RECENT = "Recent";
const ALL = "All";

// Spine order: hand-picked families first (matching how people reach for them),
// then anything else alphabetically, with "Other" last. Recent/All are pinned
// separately by the spine itself.
const CATEGORY_ORDER = [
  "Plan",
  "Design",
  "Review",
  "QA",
  "Debug",
  "Ship",
  "Docs",
  "Research",
  "Browser",
  "Setup",
  "iOS",
];

function loadRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter((x): x is string => typeof x === "string").slice(0, RECENTS_MAX)
      : [];
  } catch {
    return [];
  }
}

function persistRecents(next: string[]) {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next.slice(0, RECENTS_MAX)));
  } catch {
    // localStorage can throw in private mode; recents are a nicety, so swallow.
  }
}

// 17px line glyphs, keyed by category. Unmatched families get a neutral hash.
function CategoryGlyph({ name, size = 17 }: { name: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case RECENT:
      return (
        <svg {...common}>
          <path d="M12 2l2.9 6.3 6.9.7-5.1 4.6 1.4 6.8L12 17.8 5.9 20.4l1.4-6.8L2.2 9l6.9-.7Z" />
        </svg>
      );
    case ALL:
      return (
        <svg {...common}>
          <line x1="4" y1="6" x2="20" y2="6" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="18" x2="20" y2="18" />
        </svg>
      );
    case "Plan":
      return (
        <svg {...common}>
          <path d="M9 11H3v10h6V11Z" />
          <path d="M21 3h-6v18h6V3Z" />
        </svg>
      );
    case "Design":
      return (
        <svg {...common}>
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "Review":
      return (
        <svg {...common}>
          <path d="M9 11l3 3 8-8" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      );
    case "QA":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case "Debug":
      return (
        <svg {...common}>
          <rect x="8" y="6" width="8" height="14" rx="4" />
          <path d="M12 2v4M5 9H2m3 5H2m3 5H3m18-10h-3m3 5h-3m2 5h-2M9 4 7 2m8 2 2-2" />
        </svg>
      );
    case "Ship":
      return (
        <svg {...common}>
          <path d="M12 19V5" />
          <path d="m5 12 7-7 7 7" />
        </svg>
      );
    case "Docs":
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
          <path d="M14 2v6h6" />
        </svg>
      );
    case "Research":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3-3" />
        </svg>
      );
    case "Browser":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" />
        </svg>
      );
    case "Setup":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.6 7" />
        </svg>
      );
    case "iOS":
      return (
        <svg {...common}>
          <rect x="7" y="2" width="10" height="20" rx="2" />
          <path d="M11 18h2" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <line x1="4" y1="9" x2="20" y2="9" />
          <line x1="4" y1="15" x2="20" y2="15" />
          <line x1="10" y1="3" x2="8" y2="21" />
          <line x1="16" y1="3" x2="14" y2="21" />
        </svg>
      );
  }
}

/** One skill row: "/name - description", draggable onto a terminal pane. The
 * drop side reads `skillCommand` from the drag payload and types it into the
 * pane's PTY. Dragging also records the skill as recent. */
function SkillRow({ skill, onUse }: { skill: SkillInfo; onUse: (name: string) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return draggable({
      element: el,
      getInitialData: () => ({ skillCommand: `/${skill.name} ` }),
      onDragStart: () => {
        setDragging(true);
        onUse(skill.name);
      },
      onDrop: () => setDragging(false),
    });
  }, [skill.name, onUse]);

  return (
    <div
      ref={ref}
      onDoubleClick={() => setExpanded((e) => !e)}
      title={`/${skill.name}${skill.description ? ` - ${skill.description}` : ""}\nDouble-click to ${expanded ? "collapse" : "expand"} · drag onto a terminal to insert the command.`}
      style={{
        padding: "7px 12px",
        borderBottom: "1px solid var(--border)",
        cursor: "grab",
        opacity: dragging ? 0.5 : 1,
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--accent)",
          display: "block",
          overflowWrap: "anywhere",
        }}
      >
        /{skill.name}
      </span>
      {skill.description && (
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            color: "var(--muted)",
            marginTop: 2,
            display: expanded ? "block" : "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: expanded ? "unset" : DESC_CLAMP_LINES,
            overflow: expanded ? "visible" : "hidden",
            overflowWrap: "anywhere",
          }}
        >
          {skill.description}
        </span>
      )}
    </div>
  );
}

/** A compact recent-skill pill, draggable like a row. */
function SkillPill({ name, onUse }: { name: string; onUse: (name: string) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return draggable({
      element: el,
      getInitialData: () => ({ skillCommand: `/${name} ` }),
      onDragStart: () => {
        setDragging(true);
        onUse(name);
      },
      onDrop: () => setDragging(false),
    });
  }, [name, onUse]);

  return (
    <div
      ref={ref}
      title={`/${name} · drag onto a terminal to insert the command.`}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 600,
        color: "var(--accent)",
        background: "var(--surface-raised)",
        border: dragging ? "1px dashed var(--accent)" : "1px solid var(--border)",
        borderRadius: 20,
        padding: "3px 10px",
        cursor: "grab",
        opacity: dragging ? 0.55 : 1,
        whiteSpace: "nowrap",
      }}
    >
      /{name}
    </div>
  );
}

function SpineButton({
  label,
  active,
  accent,
  onClick,
}: {
  label: string;
  active: boolean;
  accent: string; // CSS var for the active indicator (magenta or cyan)
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 3,
        padding: "9px 0",
        border: "none",
        background: "transparent",
        color: active ? accent : "var(--muted)",
        cursor: "pointer",
      }}
    >
      {active && (
        <span
          style={{
            position: "absolute",
            left: 0,
            top: 5,
            bottom: 5,
            width: 3,
            borderRadius: 2,
            background: accent,
          }}
        />
      )}
      <CategoryGlyph name={label} />
      <span
        style={{
          fontSize: 8,
          fontWeight: 700,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
    </button>
  );
}

// Closable side panel listing the skills available to the open project — the
// project's own (.claude/skills) plus the global Claude Code library
// (~/.claude/skills). Two-tier: a category spine on the edge picks a family,
// and the reveal panel shows that family's skills, a search box that overrides
// the family filter, and a tray of recently-dragged commands for quick re-use.
export default function SkillsSidebar({ workspaceId }: { workspaceId: string | null }) {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<string[]>(() => loadRecents());
  // Default to Recent once the user has some; otherwise land them on All so the
  // first-ever open isn't an empty panel.
  const [tab, setTab] = useState<string>(() => (loadRecents().length ? RECENT : ALL));

  // (Re)scan when the workspace changes and on every expand, so newly added
  // skills show up without restarting the app.
  useEffect(() => {
    if (!workspaceId) {
      setSkills([]);
      return;
    }
    let stale = false;
    skillsList(workspaceId)
      .then((list) => {
        if (!stale) setSkills(list);
      })
      .catch(() => {
        if (!stale) setSkills([]);
      });
    return () => {
      stale = true;
    };
  }, [workspaceId, open]);

  const recordUse = useMemo(
    () => (name: string) => {
      setRecents((prev) => {
        const next = [name, ...prev.filter((n) => n !== name)].slice(0, RECENTS_MAX);
        persistRecents(next);
        return next;
      });
    },
    [],
  );

  // Categories that actually exist among the scanned skills, ordered.
  const categories = useMemo(() => {
    const present = new Set(skills.map((s) => s.category || "Other"));
    const ordered = CATEGORY_ORDER.filter((c) => present.has(c));
    const extras = [...present].filter((c) => !CATEGORY_ORDER.includes(c) && c !== "Other").sort();
    if (present.has("Other")) extras.push("Other");
    return [...ordered, ...extras];
  }, [skills]);

  const byName = useMemo(() => new Map(skills.map((s) => [s.name, s])), [skills]);

  // What the reveal list shows: search wins over the spine tab (global
  // override); otherwise the active tab decides.
  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (q) {
      return skills.filter(
        (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
      );
    }
    if (tab === RECENT) {
      return recents.map((n) => byName.get(n)).filter((s): s is SkillInfo => !!s);
    }
    if (tab === ALL) return skills;
    return skills.filter((s) => (s.category || "Other") === tab);
  }, [q, tab, skills, recents, byName]);

  // The quick-launch pill tray: shown above the list when not searching and not
  // already on the Recent tab (where it would duplicate the rows).
  const showTray = !q && tab !== RECENT && recents.length > 0;

  const sectionLabel = q ? `Results · ${visible.length}` : `${tab} · ${visible.length}`;

  // Clicking a group opens the reveal panel on it; clicking the group that's
  // already open collapses the panel. The spine never hides, so the groups stay
  // visible and reachable directly.
  const selectTab = (t: string) => {
    if (open && tab === t) {
      setOpen(false);
      return;
    }
    setTab(t);
    setQuery("");
    setOpen(true);
  };

  return (
    <div
      style={{
        flexShrink: 0,
        width: open ? OPEN_W : SPINE_W,
        display: "flex",
        background: "var(--panel)",
        borderRight: "1px solid var(--border)",
        overflow: "hidden",
      }}
    >
      {/* Category spine — always visible so the groups are reachable directly */}
      <nav
        style={{
          width: SPINE_W,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          background: "var(--bg)",
          borderRight: open ? "1px solid var(--border)" : "none",
          paddingTop: 6,
          overflowY: "auto",
        }}
      >
        <SpineButton
          label={RECENT}
          active={open && tab === RECENT}
          accent="var(--accent-cyan)"
          onClick={() => selectTab(RECENT)}
        />
        <span style={{ height: 1, background: "var(--border)", margin: "5px 9px" }} />
        {categories.map((c) => (
          <SpineButton
            key={c}
            label={c}
            active={open && tab === c}
            accent="var(--accent)"
            onClick={() => selectTab(c)}
          />
        ))}
        <SpineButton
          label={ALL}
          active={open && tab === ALL}
          accent="var(--accent)"
          onClick={() => selectTab(ALL)}
        />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? "Collapse skills" : "Open skills"}
          title={open ? "Collapse panel" : "Open panel"}
          style={{
            marginTop: "auto",
            padding: "10px 0",
            border: "none",
            borderTop: "1px solid var(--border)",
            background: "transparent",
            color: "var(--muted)",
            cursor: "pointer",
          }}
        >
          <ChevronIcon
            size={14}
            style={{
              transform: open ? "rotate(90deg)" : "rotate(-90deg)",
              transition: "transform var(--dur-state) var(--ease-out-quart)",
            }}
          />
        </button>
      </nav>

      {open && (
        <div
          style={{
            width: REVEAL_W,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "10px 10px 9px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                background: "var(--surface-input)",
                border: "1px solid var(--input-border)",
                borderRadius: 6,
                padding: "7px 10px",
              }}
            >
              <svg
                width={13}
                height={13}
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--muted)"
                strokeWidth={2}
                style={{ flexShrink: 0 }}
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3-3" />
              </svg>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search all skills…"
                aria-label="Search skills"
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  fontFamily: "var(--font-sans)",
                  fontSize: 12,
                  color: "var(--fg)",
                }}
              />
            </div>
          </div>

          {showTray && (
            <div style={{ padding: "0 12px 9px", borderBottom: "1px solid var(--border)" }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: "var(--accent-cyan)",
                  padding: "0 0 6px",
                }}
              >
                Recent
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {recents.map((n) => (
                  <SkillPill key={n} name={n} onUse={recordUse} />
                ))}
              </div>
            </div>
          )}

          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--muted)",
              padding: "8px 12px 6px",
            }}
          >
            {sectionLabel}
          </div>

          <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
            {visible.length === 0 ? (
              <span
                style={{
                  display: "block",
                  fontFamily: "var(--font-sans)",
                  fontSize: 12,
                  color: "var(--muted)",
                  padding: "4px 12px",
                  lineHeight: 1.5,
                }}
              >
                {skills.length === 0
                  ? "No skills found (.claude/skills/*/SKILL.md in this project or ~/.claude/skills)."
                  : tab === RECENT
                    ? "No recent skills yet. Drag a skill onto a terminal and it shows up here."
                    : q
                      ? `No skills match “${query.trim()}”.`
                      : "No skills in this category."}
              </span>
            ) : (
              visible.map((s) => <SkillRow key={s.name} skill={s} onUse={recordUse} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}
