import { useEffect, useRef, useState } from "react";
import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { skillsList, type SkillInfo } from "../lib/ipc";
import { ChevronIcon } from "./icons";

const COLLAPSED_W = 28; // the always-visible peek strip
const OPEN_W = 260;

/** One skill row: "/name - description", draggable onto a terminal pane.
 * The drop side reads `skillCommand` from the drag payload and types it
 * into the pane's PTY. */
function SkillRow({ skill }: { skill: SkillInfo }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return draggable({
      element: el,
      getInitialData: () => ({ skillCommand: `/${skill.name} ` }),
      onDragStart: () => setDragging(true),
      onDrop: () => setDragging(false),
    });
  }, [skill.name]);

  return (
    <div
      ref={ref}
      title={`/${skill.name}${skill.description ? ` - ${skill.description}` : ""}\nDrag onto a terminal to insert the command.`}
      style={{
        padding: "6px 10px",
        borderRadius: 4,
        border: "1px solid var(--border)",
        background: "var(--surface-raised)",
        cursor: "grab",
        opacity: dragging ? 0.5 : 1,
        overflow: "hidden",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--accent)",
          whiteSpace: "nowrap",
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
            display: "block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {skill.description}
        </span>
      )}
    </div>
  );
}

// Closable side panel listing the open project's skills (SKILL.md files),
// ordered by name. Collapsed it is a slim vertical strip, mirroring the
// KanbanDock peek pattern; expanding pushes the terminal grid aside.
export default function SkillsSidebar({ workspaceId }: { workspaceId: string | null }) {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);

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

  return (
    <div
      style={{
        flexShrink: 0,
        width: open ? OPEN_W : COLLAPSED_W,
        display: "flex",
        background: "var(--panel)",
        borderRight: "1px solid var(--border)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? "Collapse skills" : "Open skills"}
        style={{
          width: COLLAPSED_W,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
          padding: "10px 0",
          border: "none",
          borderRight: open ? "1px solid var(--border)" : "none",
          background: "var(--panel)",
          color: "var(--accent)",
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
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            writingMode: "vertical-rl",
            whiteSpace: "nowrap",
          }}
        >
          Skills{skills.length > 0 ? ` · ${skills.length}` : ""}
        </span>
      </button>

      {open && (
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: 8,
            overflowY: "auto",
          }}
        >
          {skills.length === 0 ? (
            <span
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 12,
                color: "var(--muted)",
                padding: "4px 2px",
              }}
            >
              No skills found in this project (.claude/skills/*/SKILL.md).
            </span>
          ) : (
            skills.map((s) => <SkillRow key={s.name} skill={s} />)
          )}
        </div>
      )}
    </div>
  );
}
