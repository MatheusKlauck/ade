import { useCallback, useEffect, useState } from "react";
import {
  gestorFeedList,
  gestorPlan,
  gestorTasksList,
  proposalApprove,
  subscribeFeed,
  type AgentEvent,
  type AgentTask,
  type IssueProposal,
} from "../lib/ipc";
import { useModalFocus } from "../lib/useModalFocus";

// The Gestor panel (#56): brief → proposals → approve, plus the live audit feed
// and the task board. A read-only window onto the deterministic loop — every row
// here is an agent_event the core wrote (D8: nada falha em silêncio).

const LEVEL_COLOR: Record<string, string> = {
  error: "var(--danger, #d35a5a)",
  warning: "var(--warning, #d3a72c)",
  info: "var(--muted, #9b9ba3)",
};

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  return `${Math.floor(d / 3600)}h`;
}

export default function GestorPanel({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const { panelRef, handleKeyDown } = useModalFocus(onClose);

  const [brief, setBrief] = useState("");
  const [planning, setPlanning] = useState(false);
  const [proposals, setProposals] = useState<IssueProposal[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [feed, setFeed] = useState<AgentEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [t, f] = await Promise.all([
        gestorTasksList(workspaceId),
        gestorFeedList(workspaceId, 100),
      ]);
      setTasks(t);
      setFeed(f);
    } catch (e) {
      setError(String(e));
    }
  }, [workspaceId]);

  useEffect(() => {
    refresh();
    let un: (() => void) | undefined;
    subscribeFeed((ev) => {
      if (ev.workspace_id !== workspaceId) return;
      setFeed((prev) => [ev, ...prev].slice(0, 100));
    }).then((u) => (un = u));
    return () => un?.();
  }, [workspaceId, refresh]);

  async function plan() {
    if (!brief.trim()) return;
    setPlanning(true);
    setError(null);
    try {
      const ps = await gestorPlan(workspaceId, brief);
      setProposals(ps);
      setSelected(new Set(ps.map((p) => p.id)));
    } catch (e) {
      setError(String(e));
    } finally {
      setPlanning(false);
    }
  }

  async function approve() {
    try {
      await proposalApprove(workspaceId, [...selected]);
      setProposals([]);
      setSelected(new Set());
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        data-testid="gestor-panel"
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(880px, 92vw)",
          maxHeight: "86vh",
          background: "var(--bg, #1b1b1f)",
          color: "var(--fg, #e9e9ec)",
          border: "1px solid var(--border, #33333a)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "12px 16px",
            borderBottom: "1px solid var(--border, #33333a)",
          }}
        >
          <strong>Gestor</strong>
          <button onClick={onClose} aria-label="Fechar" style={btn}>
            ✕
          </button>
        </header>

        <div style={{ padding: 16, overflowY: "auto", display: "grid", gap: 18 }}>
          {error && (
            <div style={{ color: LEVEL_COLOR.error, fontSize: 13 }}>{error}</div>
          )}

          {/* Brief → proposals */}
          <section>
            <label style={lbl}>Brief</label>
            <textarea
              data-testid="gestor-brief"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="Descreva o que quer construir…"
              rows={3}
              style={{
                width: "100%",
                resize: "vertical",
                background: "var(--bg-elev, #232329)",
                color: "inherit",
                border: "1px solid var(--border, #33333a)",
                borderRadius: 6,
                padding: 8,
                font: "inherit",
              }}
            />
            <div style={{ marginTop: 8 }}>
              <button
                data-testid="gestor-plan"
                onClick={plan}
                disabled={planning || !brief.trim()}
                style={{ ...btn, ...primary }}
              >
                {planning ? "Planejando…" : "Planejar"}
              </button>
            </div>
          </section>

          {/* Proposals to approve */}
          {proposals.length > 0 && (
            <section>
              <label style={lbl}>Proposals ({selected.size} selecionadas)</label>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
                {proposals.map((p) => (
                  <li
                    key={p.id}
                    style={{
                      display: "flex",
                      gap: 8,
                      padding: 8,
                      background: "var(--bg-elev, #232329)",
                      borderRadius: 6,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggle(p.id)}
                    />
                    <div>
                      <div style={{ fontWeight: 600 }}>
                        {p.title}
                        {p.priority && (
                          <span style={{ ...chip }}>{p.priority}</span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.7 }}>{p.body}</div>
                    </div>
                  </li>
                ))}
              </ul>
              <div style={{ marginTop: 8 }}>
                <button
                  data-testid="gestor-approve"
                  onClick={approve}
                  disabled={selected.size === 0}
                  style={{ ...btn, ...primary }}
                >
                  Aprovar {selected.size} → Backlog
                </button>
              </div>
            </section>
          )}

          {/* Tasks */}
          <section>
            <label style={lbl}>Tasks</label>
            {tasks.length === 0 ? (
              <div style={{ fontSize: 13, opacity: 0.6 }}>Nenhuma task ativa.</div>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
                {tasks.map((t) => (
                  <li key={t.id} style={{ display: "flex", gap: 8, fontSize: 13 }}>
                    <span style={chip}>{t.state}</span>
                    <span style={{ opacity: 0.8 }}>{t.branch ?? t.card_id}</span>
                    {t.attempt > 1 && (
                      <span style={{ opacity: 0.5 }}>tentativa {t.attempt}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Feed */}
          <section>
            <label style={lbl}>Feed</label>
            <ul
              data-testid="gestor-feed"
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "grid",
                gap: 2,
                fontFamily: "var(--mono, monospace)",
                fontSize: 12,
              }}
            >
              {feed.map((e) => (
                <li key={e.id} style={{ display: "flex", gap: 8 }}>
                  <span style={{ opacity: 0.4, minWidth: 28 }}>{ago(e.ts)}</span>
                  <span style={{ color: LEVEL_COLOR[e.level] ?? "inherit" }}>
                    {e.kind}
                  </span>
                  {e.cost_usd != null && (
                    <span style={{ opacity: 0.5 }}>${e.cost_usd.toFixed(3)}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  background: "var(--bg-elev, #232329)",
  color: "inherit",
  border: "1px solid var(--border, #33333a)",
  borderRadius: 6,
  padding: "6px 12px",
  cursor: "pointer",
  font: "inherit",
};
const primary: React.CSSProperties = {
  background: "var(--accent, #5319e7)",
  borderColor: "transparent",
  color: "#fff",
};
const lbl: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  opacity: 0.6,
  marginBottom: 6,
};
const chip: React.CSSProperties = {
  marginLeft: 6,
  padding: "1px 6px",
  borderRadius: 4,
  background: "var(--bg, #1b1b1f)",
  border: "1px solid var(--border, #33333a)",
  fontSize: 11,
};
