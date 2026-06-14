import { useEffect, useRef, useState } from "react";
import { gbrainQuery, type GbrainHit } from "../lib/ipc";
import { useModalFocus } from "../lib/useModalFocus";

// Debounce so a fast typist doesn't fire a query per keystroke; the brain query
// is a network round-trip to the local serve plus a hybrid search.
const DEBOUNCE_MS = 250;
const MIN_CHARS = 2;

/**
 * Brain-search popover anchored above the StatusBar pill. Read-only: it queries
 * the shared gbrain serve and lists hits; clicking a hit copies its slug (a
 * deeper "open the page/card" action is a later slice).
 */
export default function BrainSearch({ onClose }: { onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { panelRef, handleKeyDown } = useModalFocus(onClose, inputRef);

  const [q, setQ] = useState("");
  const [hits, setHits] = useState<GbrainHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Debounced search. A monotonic token guards against out-of-order responses
  // (a slow earlier query resolving after a faster later one).
  const reqId = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (term.length < MIN_CHARS) {
      setHits([]);
      setLoading(false);
      setError(null);
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    const t = setTimeout(() => {
      gbrainQuery(term, 8)
        .then((res) => {
          if (id !== reqId.current) return;
          setHits(res);
          setError(null);
        })
        .catch((e: unknown) => {
          if (id !== reqId.current) return;
          setHits([]);
          setError(
            typeof e === "object" && e && "message" in e
              ? String((e as { message: unknown }).message)
              : "search failed"
          );
        })
        .finally(() => {
          if (id === reqId.current) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  const copySlug = (slug: string) => {
    navigator.clipboard?.writeText(slug).catch(() => {});
    setCopied(slug);
    setTimeout(() => setCopied((c) => (c === slug ? null : c)), 1200);
  };

  return (
    <>
      {/* Scrim — click outside closes. Transparent so the app stays visible. */}
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 40 }}
        aria-hidden
      />
      <div
        ref={panelRef}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-label="Brain search"
        style={{
          position: "fixed",
          left: "var(--space-md)",
          bottom: 36,
          width: 420,
          maxHeight: 360,
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
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search the brain…"
          spellCheck={false}
          style={{
            border: "none",
            borderBottom: "1px solid var(--border)",
            background: "transparent",
            color: "var(--fg)",
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            padding: "10px 12px",
            outline: "none",
          }}
        />
        <div style={{ overflowY: "auto", flex: 1 }}>
          {loading && (
            <div style={hintStyle}>searching…</div>
          )}
          {!loading && error && (
            <div style={{ ...hintStyle, color: "var(--status-error)" }}>{error}</div>
          )}
          {!loading && !error && q.trim().length >= MIN_CHARS && hits.length === 0 && (
            <div style={hintStyle}>no matches</div>
          )}
          {!loading && q.trim().length < MIN_CHARS && (
            <div style={hintStyle}>type at least {MIN_CHARS} characters</div>
          )}
          {hits.map((h) => (
            <button
              key={h.slug || h.title}
              type="button"
              onClick={() => copySlug(h.slug)}
              title={`Copy slug: ${h.slug}`}
              style={hitStyle}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span
                  style={{
                    color: "var(--fg)",
                    fontSize: 12.5,
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {h.title || h.slug || "untitled"}
                </span>
                {h.source && (
                  <span style={{ color: "var(--muted)", fontSize: 10 }}>{h.source}</span>
                )}
                {copied === h.slug && (
                  <span style={{ color: "var(--status-success)", fontSize: 10 }}>copied</span>
                )}
              </div>
              {h.snippet && (
                <div
                  style={{
                    color: "var(--muted)",
                    fontSize: 11,
                    marginTop: 2,
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {h.snippet}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

const hintStyle: React.CSSProperties = {
  padding: "12px",
  color: "var(--muted)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
};

const hitStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "transparent",
  border: "none",
  borderBottom: "1px solid var(--border)",
  padding: "8px 12px",
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
};
