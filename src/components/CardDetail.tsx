import { useState, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { Card as CardType, Workspace, CardDetail as CardDetailType, IssueComment } from "../lib/ipc";
import { cardUpdate, cardDelete, cardDetail as fetchCardDetail, cardPromote } from "../lib/ipc";

interface CardDetailProps {
  card: CardType | null;
  workspace: Workspace | null;
  onClose: () => void;
  onDeleted: () => void;
}

// Docked right-side panel (not a modal): sits beside the board so the columns
// stay visible while reading a card. DESIGN.md: exhaust inline/progressive
// alternatives before reaching for a modal.
const panelStyle: CSSProperties = {
  width: 400,
  minWidth: 400,
  flexShrink: 0,
  alignSelf: "stretch",
  background: "var(--panel)",
  color: "var(--fg)",
  borderLeft: "1px solid var(--border)",
  padding: "var(--space-lg)",
  display: "flex",
  flexDirection: "column",
  overflowY: "auto",
  position: "relative",
};

const closeButtonStyle: CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--fg)",
  opacity: 0.6,
  fontSize: 18,
  cursor: "pointer",
  padding: "0 0 0 var(--space-sm)",
  lineHeight: 1,
};

const toastStyle: CSSProperties = {
  position: "absolute",
  top: "var(--space-sm)",
  right: "var(--space-sm)",
  padding: "var(--space-sm) 10px",
  borderRadius: "var(--radius-sm)",
  background: "var(--status-error-deep)",
  color: "var(--on-accent)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  zIndex: "var(--z-toast)",
};

export default function CardDetail({ card, workspace, onClose, onDeleted }: CardDetailProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [promoting, setPromoting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [detail, setDetail] = useState<CardDetailType | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isLinkedWorkspace = !!(workspace?.github_owner && workspace?.github_repo);
  const isGithubCard = card?.source === "github";

  useEffect(() => {
    if (card) {
      setTitle(card.title);
      setBody(card.body_preview || "");
      setDetail(null);
    }
  }, [card?.id]);

  // Fetch full detail for linked (github) cards
  useEffect(() => {
    if (!card || !isGithubCard) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    fetchCardDetail(card.id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setToast("Failed to load card details");
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [card?.id, isGithubCard]);

  if (!card) {
    return (
      <div style={{ ...panelStyle, alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "contents" }}>
          <div style={{ fontFamily: "var(--font-sans)", fontSize: 13, color: "var(--muted)" }}>
            Select a card
          </div>
        </div>
      </div>
    );
  }

  const handleTitleChange = (newTitle: string) => {
    setTitle(newTitle);
    cardUpdate(card.id, newTitle, undefined);
  };

  const handleBodyChange = (newBody: string) => {
    setBody(newBody);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      cardUpdate(card.id, undefined, newBody);
    }, 600);
  };

  const handleBodyBlur = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    cardUpdate(card.id, undefined, body);
  };

  const handleDelete = async () => {
    await cardDelete(card.id);
    onDeleted();
  };

  const handlePromote = async () => {
    if (promoting) return;
    setPromoting(true);
    try {
      await cardPromote(card.id);
      // The card will be updated via evt:board event
      setToast("Issue created on GitHub");
      setTimeout(() => setToast(null), 3000);
    } catch {
      setToast("Failed to create GitHub issue");
      setTimeout(() => setToast(null), 4000);
    } finally {
      setPromoting(false);
    }
  };

  const formatDate = (s: string) => {
    const d = new Date(s);
    return d.toLocaleString();
  };

  const parseLabels = (labelsJson: string | null): string[] => {
    if (!labelsJson) return [];
    try {
      const parsed = JSON.parse(labelsJson);
      if (Array.isArray(parsed)) return parsed;
      return [];
    } catch {
      return [];
    }
  };

  const githubUrl = (() => {
    if (!isGithubCard || !workspace?.github_owner || !workspace?.github_repo) return null;
    if (!card.github_issue_number) return null;
    return `https://github.com/${workspace.github_owner}/${workspace.github_repo}/issues/${card.github_issue_number}`;
  })();

  // ---- Linked card (source=github): read-only detail view ----
  if (isGithubCard) {
    return (
      <div style={panelStyle}>
        <div style={{ display: "contents" }}>
          {toast && <div style={toastStyle}>{toast}</div>}
          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "var(--space-md)" }}>
            <div
              style={{
                flex: 1,
                fontFamily: "var(--font-sans)",
                fontSize: 16,
                fontWeight: 600,
                lineHeight: 1.3,
                paddingRight: "var(--space-sm)",
              }}
            >
              {card.title}
            </div>
            <button onClick={onClose} style={closeButtonStyle}>
              ✕
            </button>
          </div>

          {/* Source badge */}
          <div style={{ marginBottom: "var(--space-md)" }}>
            <span
              style={{
                fontSize: 10,
                fontWeight: 500,
                padding: "2px 8px",
                borderRadius: "var(--radius-pill)",
                background: "var(--source-github)",
                color: "var(--on-accent)",
                fontFamily: "var(--font-mono)",
              }}
            >
              #{card.github_issue_number}
            </span>
          </div>

          {/* Labels */}
          {parseLabels(card.labels_json).length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-xs)", marginBottom: "var(--space-md)" }}>
              {parseLabels(card.labels_json).map((label, i) => (
                <span
                  key={i}
                  style={{
                    fontSize: 11,
                    padding: "2px 8px",
                    borderRadius: "var(--radius-pill)",
                    border: "1px solid var(--border)",
                    background: "var(--surface-input)",
                    color: "var(--fg)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {label}
                </span>
              ))}
            </div>
          )}

          {/* Assignee */}
          {card.assignee && (
            <div style={{ fontFamily: "var(--font-sans)", fontSize: 12, color: "var(--muted)", marginBottom: "var(--space-md)" }}>
              Assignee: <span style={{ fontFamily: "var(--font-mono)" }}>{card.assignee}</span>
            </div>
          )}

          {detailLoading && (
            <div style={{ fontFamily: "var(--font-sans)", fontSize: 13, color: "var(--muted)", marginBottom: "var(--space-sm)" }}>
              Loading details…
            </div>
          )}

          {/* Body */}
          {detail && detail.body && (
            <div
              style={{
                padding: "var(--space-md)",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                fontFamily: "var(--font-sans)",
                fontSize: 13,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                marginBottom: "var(--space-md)",
                flex: "0 1 auto",
              }}
            >
              {detail.body}
            </div>
          )}

          {/* Comments */}
          {detail && detail.comments.length > 0 && (
            <div style={{ marginBottom: "var(--space-md)" }}>
              <div style={{ fontFamily: "var(--font-sans)", fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "var(--space-sm)" }}>
                Comments
              </div>
              {detail.comments.map((c: IssueComment) => (
                <div
                  key={c.id}
                  style={{
                    padding: "var(--space-sm) 10px",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    marginBottom: "var(--space-xs)",
                    fontFamily: "var(--font-sans)",
                    fontSize: 12,
                  }}
                >
                  <div style={{ marginBottom: 2 }}>
                    <span style={{ fontWeight: 600 }}>{c.user}</span>{" "}
                    <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                      {formatDate(c.created_at)}
                    </span>
                  </div>
                  <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{c.body}</div>
                </div>
              ))}
            </div>
          )}

          {/* Open on GitHub */}
          {githubUrl && (
            <div style={{ marginTop: "var(--space-xs)", fontFamily: "var(--font-sans)", fontSize: 12 }}>
              <span style={{ color: "var(--muted)" }}>GitHub: </span>
              <span
                style={{
                  userSelect: "all",
                  cursor: "text",
                  wordBreak: "break-all",
                  color: "var(--accent)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {githubUrl}
              </span>
            </div>
          )}

          {/* Meta info */}
          <div
            style={{
              marginTop: "auto",
              paddingTop: "var(--space-md)",
              borderTop: "1px solid var(--border)",
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              color: "var(--muted)",
            }}
          >
            <div style={{ marginBottom: "var(--space-xs)" }}>
              Created: <span style={{ fontFamily: "var(--font-mono)" }}>{formatDate(card.created_at)}</span>
            </div>
            <div>
              Updated: <span style={{ fontFamily: "var(--font-mono)" }}>{formatDate(card.updated_at)}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- Local card (in linked or local workspace) ----
  return (
    <div style={panelStyle}>
      <div style={{ display: "contents" }}>
        {toast && <div style={toastStyle}>{toast}</div>}

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-md)" }}>
          <input
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            style={{
              flex: 1,
              background: "var(--input-bg)",
              border: "1px solid var(--input-border)",
              borderRadius: "var(--radius-sm)",
              color: "var(--fg)",
              padding: "var(--space-sm) var(--space-md)",
              fontFamily: "var(--font-sans)",
              fontSize: 14,
              fontWeight: 600,
            }}
          />
          <button onClick={onClose} style={closeButtonStyle}>
            ✕
          </button>
        </div>

        {/* Source badge */}
        <div style={{ marginBottom: "var(--space-md)" }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 500,
              padding: "2px 8px",
              borderRadius: "var(--radius-pill)",
              background: "var(--source-local)",
              color: "var(--on-accent)",
              fontFamily: "var(--font-mono)",
            }}
          >
            local
          </span>
        </div>

        {/* Body textarea */}
        <textarea
          value={body}
          onChange={(e) => handleBodyChange(e.target.value)}
          onBlur={handleBodyBlur}
          placeholder="Add a description…"
          style={{
            flex: 1,
            background: "var(--input-bg)",
            border: "1px solid var(--input-border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--fg)",
            padding: "var(--space-sm)",
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            lineHeight: 1.5,
            resize: "vertical",
            minHeight: 100,
          }}
        />

        {/* Promote button for cards in linked workspaces */}
        {isLinkedWorkspace && (
          <button
            onClick={handlePromote}
            disabled={promoting}
            style={{
              marginTop: "var(--space-md)",
              padding: "var(--space-sm) var(--space-md)",
              background: "var(--source-github)",
              border: "none",
              borderRadius: "var(--radius-sm)",
              color: "var(--on-accent)",
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              cursor: promoting ? "wait" : "pointer",
            }}
          >
            {promoting ? "Creating issue…" : "Create GitHub issue"}
          </button>
        )}

        {/* Meta info */}
        <div
          style={{
            marginTop: "var(--space-lg)",
            paddingTop: "var(--space-md)",
            borderTop: "1px solid var(--border)",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            color: "var(--muted)",
          }}
        >
          <div style={{ marginBottom: "var(--space-xs)" }}>
            Created: <span style={{ fontFamily: "var(--font-mono)" }}>{formatDate(card.created_at)}</span>
          </div>
          <div style={{ marginBottom: "var(--space-sm)" }}>
            Updated: <span style={{ fontFamily: "var(--font-mono)" }}>{formatDate(card.updated_at)}</span>
          </div>
        </div>

        {/* Delete button */}
        <button
          onClick={handleDelete}
          style={{
            marginTop: "var(--space-sm)",
            padding: "var(--space-sm) var(--space-md)",
            background: "var(--status-error-deep)",
            border: "none",
            borderRadius: "var(--radius-sm)",
            color: "var(--on-accent)",
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Delete card
        </button>
      </div>
    </div>
  );
}
