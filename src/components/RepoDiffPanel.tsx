import { useEffect, useMemo, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import {
  openInFinder,
  openInVscode,
  repoAbsPath,
  repoChanges,
  repoFileVersions,
  type ChangedFile,
} from "../lib/ipc";
import { languageFor } from "../lib/monaco";
import { treeRows } from "../lib/repoTree";
import { ContextMenu, menuItemStyle, useContextMenu } from "./ContextMenu";

const STATUS_COLOR: Record<string, string> = {
  M: "var(--status-warning, #f39c12)",
  A: "#3fe07a",
  D: "#e74c3c",
  "?": "#3fe07a",
};

// Untracked is "?" in git, but we show it as a green "A" (new file) to match the
// M/A/D letter convention. Data stays truthful ("?"); only the label changes.
const STATUS_LABEL: Record<string, string> = { "?": "A" };

interface Props {
  workspaceId: string;
  /** When the pane runs in an isolated worktree, diffs target that path. */
  worktree?: string | null;
}

/** Repo view body: changed files as a folder tree; click one to diff it. */
export default function RepoDiffPanel({ workspaceId, worktree }: Props) {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [versions, setVersions] = useState({ original: "", modified: "" });
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();
  const [ctxTarget, setCtxTarget] = useState<{
    type: "dir" | "file";
    path: string;
  } | null>(null);

  const rows = useMemo(() => treeRows(files, collapsed), [files, collapsed]);

  const onRowContextMenu = (
    e: React.MouseEvent,
    type: "dir" | "file",
    path: string
  ) => {
    e.preventDefault();
    setCtxTarget({ type, path });
    openMenu(e.clientX, e.clientY);
  };

  useEffect(() => {
    let live = true;
    setError(null);
    repoChanges(workspaceId, worktree)
      .then((fs) => {
        if (!live) return;
        setFiles(fs);
        setSelected((prev) => prev ?? fs[0]?.path ?? null);
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [workspaceId, worktree]);

  useEffect(() => {
    if (!selected) {
      setVersions({ original: "", modified: "" });
      return;
    }
    let live = true;
    repoFileVersions(workspaceId, selected, worktree)
      .then((v) => live && setVersions(v))
      .catch(
        (e) =>
          live && setVersions({ original: "", modified: `// erro ao ler arquivo\n${e}` })
      );
    return () => {
      live = false;
    };
  }, [workspaceId, selected, worktree]);

  const toggleDir = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  return (
    <div
      // xterm paints its canvas/textarea on stacked z-indexes; without one of
      // our own the overlay sits beneath them and the terminal eats the clicks
      // and wheel events. Lift it above and re-enable pointer events.
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 50,
        pointerEvents: "auto",
        display: "flex",
        background: "var(--panel)",
        fontSize: 11,
      }}
    >
      <div
        style={{
          width: 200,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          overflowY: "auto",
          fontFamily: "var(--font-mono, monospace)",
        }}
      >
        {error ? (
          <div style={{ padding: 10, color: "#e74c3c" }}>{error}</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 10, color: "var(--muted)" }}>Sem alterações</div>
        ) : (
          rows.map((row) =>
            row.type === "dir" ? (
              <button
                key={`d:${row.path}`}
                onClick={() => toggleDir(row.path)}
                onContextMenu={(e) => onRowContextMenu(e, "dir", row.path)}
                title={row.path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  width: "100%",
                  textAlign: "left",
                  padding: "3px 8px",
                  paddingLeft: 8 + row.depth * 12,
                  border: "none",
                  background: "transparent",
                  color: "var(--muted)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 11,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                <span style={{ width: 9, flexShrink: 0 }}>
                  {collapsed.has(row.path) ? "▸" : "▾"}
                </span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {row.label}
                </span>
              </button>
            ) : (
              <button
                key={`f:${row.file.path}`}
                onClick={() => setSelected(row.file.path)}
                onContextMenu={(e) => onRowContextMenu(e, "file", row.file.path)}
                title={row.file.path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  textAlign: "left",
                  padding: "3px 8px",
                  paddingLeft: 8 + row.depth * 12,
                  border: "none",
                  background:
                    selected === row.file.path
                      ? "rgba(240,47,194,0.12)"
                      : "transparent",
                  boxShadow:
                    selected === row.file.path
                      ? "inset 2px 0 0 var(--accent)"
                      : "none",
                  color: "var(--fg)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 11,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                <span
                  style={{
                    width: 10,
                    flexShrink: 0,
                    fontWeight: 700,
                    color: STATUS_COLOR[row.file.status] ?? "var(--muted)",
                  }}
                >
                  {STATUS_LABEL[row.file.status] ?? row.file.status}
                </span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {row.name}
                </span>
              </button>
            )
          )
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {selected && (
          <DiffEditor
            key={selected}
            original={versions.original}
            modified={versions.modified}
            language={languageFor(selected)}
            theme="vs-dark"
            options={{
              readOnly: true,
              renderSideBySide: false, // inline: fits a narrow pane
              automaticLayout: true, // resize with the pane / grid dividers
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 12,
              lineNumbersMinChars: 3,
            }}
          />
        )}
      </div>
      {menu && ctxTarget && (
        <ContextMenu position={menu} onClose={closeMenu} minWidth={190}>
          {(
            [
              ctxTarget.type === "dir"
                ? {
                    label: "Abrir no Finder",
                    run: () => openInFinder(workspaceId, ctxTarget.path, worktree),
                  }
                : {
                    label: "Abrir no VS Code",
                    run: () => openInVscode(workspaceId, ctxTarget.path, worktree),
                  },
              {
                label: "Copiar caminho relativo",
                run: () => navigator.clipboard.writeText(ctxTarget.path),
              },
              {
                label: "Copiar caminho absoluto",
                run: () =>
                  repoAbsPath(workspaceId, ctxTarget.path, worktree).then((abs) =>
                    navigator.clipboard.writeText(abs)
                  ),
              },
            ] as const
          ).map((item) => (
            <button
              key={item.label}
              style={menuItemStyle}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              onClick={() => {
                Promise.resolve(item.run()).catch((e) =>
                  console.error("repo menu action failed", e)
                );
                closeMenu();
              }}
            >
              {item.label}
            </button>
          ))}
        </ContextMenu>
      )}
    </div>
  );
}
