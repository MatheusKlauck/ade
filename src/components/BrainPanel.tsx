import { useEffect, useState } from "react";
import {
  gbrainHealth,
  gbrainIdentity,
  gbrainLiveness,
  gbrainRecentPages,
  gbrainRestart,
  gbrainSources,
  gbrainSync,
  type GbrainHealth,
  type GbrainIdentity,
  type GbrainLiveness,
  type GbrainPage,
  type GbrainSource,
  type GbrainStatus,
} from "../lib/ipc";
import { useModalFocus } from "../lib/useModalFocus";
import BrainSearchBody from "./BrainSearch";

// Which expansion to show. Derived from the polled status: no serve → offline;
// any source past "fresh" → stale; otherwise the explore (search) view.
type BrainState = "offline" | "stale" | "fresh";

function brainState(s: GbrainStatus | null): BrainState {
  if (!s || !s.healthy) return "offline";
  if (s.staleness && s.staleness !== "fresh") return "stale";
  return "fresh";
}

// Relative "Nm ago" formatter for ISO sync timestamps; "" when unparseable.
function ago(iso?: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

function stalenessColor(c?: string): string {
  if (c === "fresh") return "var(--status-success)";
  if (c === "aging") return "var(--accent-cyan)";
  return "var(--status-error)"; // stale / unknown
}

/**
 * The brain pill's expansion. Content is state-specific: offline shows a
 * liveness diagnostic plus retry/restart; stale shows per-source sync state plus
 * "sync now"; fresh shows brain stats, search, and a browse list. `onRefresh`
 * re-polls the pill status so an action's effect shows without waiting for the
 * 30s poll.
 */
export default function BrainPanel({
  status,
  onClose,
  onRefresh,
}: {
  status: GbrainStatus | null;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const { panelRef, handleKeyDown } = useModalFocus(onClose);
  const state = brainState(status);

  return (
    <>
      {/* Scrim — click outside closes. Transparent so the app stays visible. */}
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 40 }} aria-hidden />
      <div
        ref={panelRef}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-label="Brain"
        tabIndex={-1}
        style={{
          position: "fixed",
          left: "var(--space-md)",
          bottom: 36,
          width: 420,
          maxHeight: 460,
          display: "flex",
          flexDirection: "column",
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
          boxShadow: "0 8px 28px rgba(0,0,0,0.35)",
          zIndex: 41,
          overflow: "hidden",
        }}
      >
        <BrainHeader status={status} state={state} />
        {state === "offline" && <OfflineBody onRetry={onRefresh} />}
        {state === "stale" && <StaleBody status={status} onRefresh={onRefresh} />}
        {state === "fresh" && <FreshBody />}
      </div>
    </>
  );
}

/** Status summary common to every state: dot + counts + version + update badge. */
function BrainHeader({ status, state }: { status: GbrainStatus | null; state: BrainState }) {
  const [id, setId] = useState<GbrainIdentity | null>(null);
  useEffect(() => {
    let alive = true;
    gbrainIdentity()
      .then((v) => alive && setId(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const dot =
    state === "offline"
      ? "var(--status-error)"
      : state === "stale"
        ? stalenessColor(status?.staleness)
        : "var(--status-success)";
  const counts =
    status?.pages != null
      ? `${status.pages} pages${status.chunks != null ? ` · ${status.chunks} chunks` : ""}`
      : state === "offline"
        ? "serve not answering"
        : "—";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 12px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flexShrink: 0 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
        <span style={{ color: "var(--fg)", fontSize: 12.5, fontWeight: 600, fontFamily: "var(--font-sans)" }}>
          Brain {id?.version ? <span style={{ color: "var(--muted)", fontWeight: 400 }}>v{id.version}</span> : null}
        </span>
        <span style={{ color: "var(--muted)", fontSize: 11, fontFamily: "var(--font-sans)" }}>{counts}</span>
      </div>
      {id?.update_available && (
        <span
          title={id.latest_version ? `Update available: v${id.latest_version}` : "Update available"}
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            color: "var(--accent-cyan)",
            border: "1px solid var(--accent-cyan)",
            borderRadius: "var(--radius-sm)",
            padding: "1px 6px",
          }}
        >
          update
        </span>
      )}
    </div>
  );
}

/** Offline: probe liveness + health, explain, and offer retry / restart. */
function OfflineBody({ onRetry }: { onRetry: () => void }) {
  const [live, setLive] = useState<GbrainLiveness | null>(null);
  const [probing, setProbing] = useState(true);
  const [action, setAction] = useState<string | null>(null);

  const probe = () => {
    setProbing(true);
    gbrainLiveness()
      .then(setLive)
      .catch(() => setLive({ reachable: false }))
      .finally(() => setProbing(false));
  };
  useEffect(probe, []);

  const restart = async () => {
    setAction("restarting…");
    try {
      await gbrainRestart();
      // Give the child a moment to bind before re-probing / re-polling.
      setTimeout(() => {
        probe();
        onRetry();
        setAction(null);
      }, 1500);
    } catch (e) {
      setAction(errMsg(e, "restart failed"));
    }
  };

  return (
    <div style={bodyStyle}>
      <p style={textStyle}>
        The brain’s search index isn’t answering. The shared <code>gbrain serve</code> is supervised by the app and
        restarts on crash — give it a moment, or nudge it below.
      </p>
      <div style={diagBox}>
        <DiagRow
          label="Port :7777"
          ok={live?.reachable}
          pending={probing}
          value={live?.reachable ? "listening" : "no response"}
        />
        <DiagRow
          label="Serve health"
          ok={live?.status === "ok"}
          pending={probing}
          value={live?.reachable ? live?.status ?? "starting up" : "—"}
        />
        {live?.version && <DiagRow label="Version" ok value={`v${live.version}`} />}
      </div>
      <div style={actionRow}>
        <button type="button" style={btn} onClick={() => { probe(); onRetry(); }}>
          Retry
        </button>
        <button type="button" style={btnPrimary} onClick={restart} disabled={!!action}>
          Restart serve
        </button>
        {action && <span style={{ ...textStyle, color: "var(--muted)" }}>{action}</span>}
      </div>
    </div>
  );
}

/** Stale: per-source sync state + a "sync now" action that re-polls after. */
function StaleBody({ status, onRefresh }: { status: GbrainStatus | null; onRefresh: () => void }) {
  const [sources, setSources] = useState<GbrainSource[] | null>(null);
  const [action, setAction] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    gbrainSources()
      .then((s) => alive && setSources(s))
      .catch(() => alive && setSources([]));
    return () => {
      alive = false;
    };
  }, []);

  const syncNow = async () => {
    setAction("queuing…");
    try {
      await gbrainSync(false);
      setAction("sync queued");
      // Re-poll a few times so the pill turns fresh once the job lands.
      [3000, 8000, 15000].forEach((d) => setTimeout(onRefresh, d));
      setTimeout(() => setAction(null), 4000);
    } catch (e) {
      setAction(errMsg(e, "sync failed"));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ ...bodyStyle, borderBottom: "1px solid var(--border)" }}>
        <div style={actionRow}>
          <button type="button" style={btnPrimary} onClick={syncNow} disabled={action === "queuing…"}>
            Sync now
          </button>
          {action && <span style={{ ...textStyle, color: "var(--muted)" }}>{action}</span>}
          {!action && status?.last_sync_at && (
            <span style={{ ...textStyle, color: "var(--muted)" }}>last sync {ago(status.last_sync_at)}</span>
          )}
        </div>
        {!!status?.unacknowledged_failures && (
          <p style={{ ...textStyle, color: "var(--status-error)" }}>
            {status.unacknowledged_failures} unacknowledged sync failure
            {status.unacknowledged_failures === 1 ? "" : "s"}.
          </p>
        )}
      </div>
      <div style={{ overflowY: "auto" }}>
        {sources == null && <div style={hint}>loading sources…</div>}
        {sources?.length === 0 && <div style={hint}>no sources</div>}
        {sources?.map((s) => (
          <div key={s.id} style={sourceRow}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <span style={{ color: "var(--fg)", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>{s.id}</span>
              {s.staleness && (
                <span style={{ fontSize: 10, color: stalenessColor(s.staleness) }}>{s.staleness}</span>
              )}
              <span style={{ flex: 1 }} />
              {s.last_sync_at && <span style={{ color: "var(--muted)", fontSize: 10 }}>{ago(s.last_sync_at)}</span>}
            </div>
            <div style={{ color: "var(--muted)", fontSize: 10.5, marginTop: 2 }}>
              {s.pages ?? 0} pages
              {s.chunks != null ? ` · ${s.chunks} chunks` : ""}
              {s.embedding_coverage_pct != null ? ` · ${s.embedding_coverage_pct}% embedded` : ""}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Fresh: search + a browse list of recent pages, so exploring needs no query. */
function FreshBody() {
  const [recent, setRecent] = useState<GbrainPage[] | null>(null);
  const [health, setHealth] = useState<GbrainHealth | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    gbrainRecentPages(12)
      .then((p) => alive && setRecent(p))
      .catch(() => alive && setRecent([]));
    gbrainHealth()
      .then((h) => alive && setHealth(h))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const copySlug = (slug: string) => {
    navigator.clipboard?.writeText(slug).catch(() => {});
    setCopied(slug);
    setTimeout(() => setCopied((c) => (c === slug ? null : c)), 1200);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <BrainSearchBody />
      <div style={{ borderTop: "1px solid var(--border)", overflowY: "auto", maxHeight: 200 }}>
        <div style={sectionLabel}>
          Recent
          {health?.brain_score != null && (
            <span style={{ color: "var(--muted)", fontWeight: 400 }}> · brain score {health.brain_score}/10</span>
          )}
        </div>
        {recent == null && <div style={hint}>loading…</div>}
        {recent?.length === 0 && <div style={hint}>no pages yet</div>}
        {recent?.map((p) => (
          <button
            key={p.slug}
            type="button"
            onClick={() => copySlug(p.slug)}
            title={`Copy slug: ${p.slug}`}
            style={hitStyle}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span
                style={{
                  color: "var(--fg)",
                  fontSize: 12,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {p.title || p.slug}
              </span>
              {p.kind && <span style={{ color: "var(--muted)", fontSize: 10 }}>{p.kind}</span>}
              {copied === p.slug && <span style={{ color: "var(--status-success)", fontSize: 10 }}>copied</span>}
              <span style={{ flex: 1 }} />
              {p.updated_at && <span style={{ color: "var(--muted)", fontSize: 10 }}>{ago(p.updated_at)}</span>}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function DiagRow({
  label,
  value,
  ok,
  pending,
}: {
  label: string;
  value?: string;
  ok?: boolean;
  pending?: boolean;
}) {
  const color = pending ? "var(--muted)" : ok ? "var(--status-success)" : "var(--status-error)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, fontFamily: "var(--font-sans)" }}>
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span style={{ flex: 1 }} />
      <span style={{ color: "var(--fg)" }}>{pending ? "checking…" : value}</span>
    </div>
  );
}

function errMsg(e: unknown, fallback: string): string {
  return typeof e === "object" && e && "message" in e
    ? String((e as { message: unknown }).message)
    : fallback;
}

const bodyStyle: React.CSSProperties = {
  padding: "12px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const textStyle: React.CSSProperties = {
  margin: 0,
  color: "var(--fg)",
  fontFamily: "var(--font-sans)",
  fontSize: 11.5,
  lineHeight: 1.5,
};

const diagBox: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "8px 10px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg)",
};

const actionRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};

const btn: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 11.5,
  color: "var(--fg)",
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  padding: "4px 12px",
  cursor: "pointer",
};

const btnPrimary: React.CSSProperties = {
  ...btn,
  borderColor: "var(--accent-cyan)",
  color: "var(--accent-cyan)",
};

const hint: React.CSSProperties = {
  padding: "10px 12px",
  color: "var(--muted)",
  fontFamily: "var(--font-sans)",
  fontSize: 11.5,
};

const sectionLabel: React.CSSProperties = {
  padding: "8px 12px 4px",
  color: "var(--fg)",
  fontFamily: "var(--font-sans)",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const sourceRow: React.CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid var(--border)",
};

const hitStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "transparent",
  border: "none",
  borderBottom: "1px solid var(--border)",
  padding: "7px 12px",
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
};
