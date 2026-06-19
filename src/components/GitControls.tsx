import { useEffect, useState } from "react";
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCreateBranch,
  gitDeleteBranch,
  gitStash,
  type GitBranches,
} from "../lib/ipc";
import { ContextMenu, menuItemStyle, useContextMenu } from "./ContextMenu";

interface Props {
  workspaceId: string;
  worktree?: string | null;
  /** Bubbles the live current branch up so the header chip can stay in sync. */
  onCurrentBranch?: (branch: string) => void;
}

/** Compact "agora / 5m / 3h / 2d" from unix seconds. */
function relTime(unix: number): string {
  if (!unix) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (s < 60) return "agora";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "5px 10px",
  background: "transparent",
  border: "none",
  borderRadius: "var(--radius-sm)",
  color: "var(--fg)",
  cursor: "pointer",
  fontSize: 13,
  textAlign: "left",
};

const inputStyle: React.CSSProperties = {
  minWidth: 0,
  fontSize: 12,
  padding: "4px 6px",
  color: "var(--fg)",
  background: "var(--input-bg)",
  border: "1px solid var(--border)",
  borderRadius: 4,
};

/** Git controls popover: switch / fork / delete branches (right-click a branch
 * for its actions), commit, stash — scoped to a pane's repo (its worktree when
 * isolation is on). */
export default function GitControls({
  workspaceId,
  worktree,
  onCurrentBranch,
}: Props) {
  const [data, setData] = useState<GitBranches | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-branch right-click menu + the branch it targets.
  const branchMenu = useContextMenu();
  const [menuTarget, setMenuTarget] = useState<string | null>(null);
  // Fork-in-progress: the base branch and the new name being typed.
  const [forkBase, setForkBase] = useState<string | null>(null);
  const [forkName, setForkName] = useState("");

  const load = () =>
    gitBranches(workspaceId, worktree)
      .then((d) => {
        setData(d);
        onCurrentBranch?.(d.current);
      })
      .catch((e) => setError(String(e)));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, worktree]);

  // Run a git action, then refresh. Errors surface inline and keep the popover
  // open so the user sees why (e.g. "nothing to commit", unmerged branch).
  const run = async (action: Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action;
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const openBranchMenu = (e: React.MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuTarget(name);
    branchMenu.open(e.clientX, e.clientY);
  };
  const closeBranchMenu = () => {
    branchMenu.close();
    setMenuTarget(null);
  };

  const targetIsCurrent = menuTarget != null && menuTarget === data?.current;

  return (
    <div style={{ width: 250, opacity: busy ? 0.7 : 1 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          color: "var(--muted)",
          padding: "2px 10px 4px",
        }}
      >
        Branch <span style={{ fontWeight: 400, textTransform: "none" }}>· clique direito p/ ações</span>
      </div>

      {forkBase && (
        <div style={{ display: "flex", gap: 6, padding: "0 10px 6px" }}>
          <input
            autoFocus
            value={forkName}
            disabled={busy}
            placeholder={`Nova branch de ${forkBase}`}
            onChange={(e) => setForkName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setForkBase(null);
              if (e.key === "Enter" && forkName.trim()) {
                run(gitCreateBranch(workspaceId, forkName.trim(), forkBase, worktree)).then(
                  () => {
                    setForkBase(null);
                    setForkName("");
                  }
                );
              }
            }}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            disabled={busy || !forkName.trim()}
            onClick={() =>
              run(
                gitCreateBranch(workspaceId, forkName.trim(), forkBase, worktree)
              ).then(() => {
                setForkBase(null);
                setForkName("");
              })
            }
            style={{
              flexShrink: 0,
              fontSize: 12,
              padding: "4px 8px",
              borderRadius: 4,
              border: "none",
              background: forkName.trim() ? "var(--accent)" : "var(--input-bg)",
              color: forkName.trim() ? "var(--accent-ink, #1a1a1a)" : "var(--muted)",
              cursor: forkName.trim() && !busy ? "pointer" : "default",
            }}
          >
            Criar
          </button>
        </div>
      )}

      <div style={{ maxHeight: 180, overflowY: "auto" }}>
        {data?.branches.map((b) => {
          const current = b.name === data.current;
          return (
            <button
              key={b.name}
              disabled={busy || current}
              title={current ? "Branch atual" : `Trocar para ${b.name} · clique direito p/ ações`}
              style={{ ...rowStyle, cursor: current ? "default" : "pointer" }}
              onMouseEnter={(e) =>
                !current && (e.currentTarget.style.background = "var(--panel)")
              }
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              onClick={() => run(gitCheckout(workspaceId, b.name, worktree))}
              onContextMenu={(e) => openBranchMenu(e, b.name)}
            >
              <span
                style={{
                  width: 12,
                  flexShrink: 0,
                  color: "var(--accent)",
                  textAlign: "center",
                }}
              >
                {current ? "●" : ""}
              </span>
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: current ? "var(--fg)" : "var(--muted)",
                }}
              >
                {b.name}
              </span>
              <span style={{ flexShrink: 0, fontSize: 10, color: "var(--muted)" }}>
                {relTime(b.updated)}
              </span>
            </button>
          );
        })}
        {data && data.branches.length === 0 && (
          <div style={{ padding: "4px 10px", color: "var(--muted)", fontSize: 12 }}>
            Sem branches locais
          </div>
        )}
      </div>

      <div style={{ height: 1, background: "var(--border)", margin: "6px 0" }} />

      {/* Commit */}
      <div style={{ padding: "0 10px 4px", display: "flex", gap: 6 }}>
        <input
          value={msg}
          disabled={busy}
          placeholder="Mensagem do commit"
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && msg.trim()) {
              run(gitCommit(workspaceId, msg.trim(), worktree)).then(() => setMsg(""));
            }
          }}
          style={{ ...inputStyle, flex: 1 }}
        />
        <button
          disabled={busy || !msg.trim()}
          onClick={() =>
            run(gitCommit(workspaceId, msg.trim(), worktree)).then(() => setMsg(""))
          }
          style={{
            fontSize: 12,
            padding: "4px 10px",
            borderRadius: 4,
            border: "none",
            background: msg.trim() ? "var(--accent)" : "var(--input-bg)",
            color: msg.trim() ? "var(--accent-ink, #1a1a1a)" : "var(--muted)",
            cursor: msg.trim() && !busy ? "pointer" : "default",
          }}
        >
          Commit
        </button>
      </div>

      <button
        disabled={busy}
        style={rowStyle}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        onClick={() => run(gitStash(workspaceId, worktree))}
      >
        Stash (inclui untracked)
      </button>

      {error && (
        <div
          style={{
            padding: "4px 10px",
            color: "var(--status-error, #e74c3c)",
            fontSize: 11,
            whiteSpace: "pre-wrap",
          }}
        >
          {error}
        </div>
      )}

      {branchMenu.menu && menuTarget && (
        <ContextMenu position={branchMenu.menu} onClose={closeBranchMenu} minWidth={180}>
          {(
            [
              {
                label: `Trocar para ${menuTarget}`,
                disabled: targetIsCurrent,
                run: () => run(gitCheckout(workspaceId, menuTarget, worktree)),
              },
              {
                label: "Fork — nova branch a partir desta",
                disabled: false,
                run: () => {
                  setForkBase(menuTarget);
                  setForkName("");
                },
              },
              {
                label: "Copiar nome",
                disabled: false,
                run: () => navigator.clipboard.writeText(menuTarget),
              },
              {
                label: "Excluir",
                disabled: targetIsCurrent,
                run: () => run(gitDeleteBranch(workspaceId, menuTarget, worktree)),
              },
            ] as const
          ).map((item) => (
            <button
              key={item.label}
              disabled={item.disabled}
              style={{
                ...menuItemStyle,
                color: item.disabled ? "var(--muted)" : "var(--fg)",
                cursor: item.disabled ? "default" : "pointer",
              }}
              onMouseEnter={(e) =>
                !item.disabled && (e.currentTarget.style.background = "var(--panel)")
              }
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              onClick={() => {
                Promise.resolve(item.run()).catch((e) =>
                  console.error("git branch action failed", e)
                );
                closeBranchMenu();
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
