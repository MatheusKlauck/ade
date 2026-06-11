import { useState, useEffect, useRef } from "react";
import type { Card as CardType, Workspace, CardDetail as CardDetailType, IssueComment } from "../lib/ipc";
import { cardUpdate, cardDelete, cardDetail as fetchCardDetail, cardPromote } from "../lib/ipc";

interface CardDetailProps {
  card: CardType | null;
  workspace: Workspace | null;
  onClose: () => void;
  onDeleted: () => void;
}

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
      <div
        style={{
          width: 320,
          minWidth: 320,
          padding: 16,
          background: "var(--panel)",
          color: "var(--fg)",
          borderLeft: "1px solid var(--border, #333)",
          fontSize: 14,
        }}
      >
        Select a card
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
      <div
        style={{
          width: 360,
          minWidth: 360,
          padding: 16,
          background: "var(--panel)",
          color: "var(--fg)",
          borderLeft: "1px solid var(--border, #333)",
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
          position: "relative",
        }}
      >
        {toast && (
          <div
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              padding: "6px 10px",
              borderRadius: 4,
              background: "#c0392b",
              color: "#fff",
              fontSize: 12,
              zIndex: 10,
            }}
          >
            {toast}
          </div>
        )}
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ flex: 1, fontSize: 15, fontWeight: 600, paddingRight: 8 }}>
            {card.title}
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "var(--fg)",
              opacity: 0.5,
              fontSize: 18,
              cursor: "pointer",
              padding: "0 0 0 8px",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Source badge */}
        <div style={{ marginBottom: 12 }}>
          <span
            style={{
              fontSize: 10,
              padding: "2px 8px",
              borderRadius: 10,
              background: "#8250df",
              color: "#fff",
            }}
          >
            #{card.github_issue_number}
          </span>
        </div>

        {/* Labels */}
        {parseLabels(card.labels_json).length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 12 }}>
            {parseLabels(card.labels_json).map((label, i) => (
              <span
                key={i}
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 10,
                  background: "var(--accent)",
                  color: "#fff",
                }}
              >
                {label}
              </span>
            ))}
          </div>
        )}

        {/* Assignee */}
        {card.assignee && (
          <div style={{ fontSize: 12, color: "var(--fg)", opacity: 0.7, marginBottom: 12 }}>
            Assignee: {card.assignee}
          </div>
        )}

        {detailLoading && (
          <div style={{ fontSize: 13, color: "var(--fg)", opacity: 0.5, marginBottom: 8 }}>
            Loading details…
          </div>
        )}

        {/* Body */}
        {detail && detail.body && (
          <div
            style={{
              padding: 12,
              background: "var(--bg)",
              borderRadius: 4,
              fontSize: 13,
              whiteSpace: "pre-wrap",
              marginBottom: 12,
              flex: "0 1 auto",
            }}
          >
            {detail.body}
          </div>
        )}

        {/* Comments */}
        {detail && detail.comments.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, opacity: 0.7 }}>
              Comments
            </div>
            {detail.comments.map((c: IssueComment) => (
              <div
                key={c.id}
                style={{
                  padding: "8px 10px",
                  background: "var(--bg)",
                  borderRadius: 4,
                  marginBottom: 4,
                  fontSize: 12,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 2 }}>
                  {c.user}{" "}
                  <span style={{ fontWeight: 400, opacity: 0.5, fontSize: 11 }}>
                    {formatDate(c.created_at)}
                  </span>
                </div>
                <div style={{ whiteSpace: "pre-wrap" }}>{c.body}</div>
              </div>
            ))}
          </div>
        )}

        {/* Open on GitHub */}
        {githubUrl && (
          <div style={{ marginTop: 4, fontSize: 12 }}>
            <span style={{ opacity: 0.7 }}>GitHub: </span>
            <span
              style={{
                userSelect: "all",
                cursor: "text",
                wordBreak: "break-all",
                color: "var(--accent)",
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
            paddingTop: 12,
            borderTop: "1px solid var(--border, #333)",
            fontSize: 11,
            opacity: 0.5,
          }}
        >
          <div style={{ marginBottom: 4 }}>Created: {formatDate(card.created_at)}</div>
          <div>Updated: {formatDate(card.updated_at)}</div>
        </div>
      </div>
    );
  }

  // ---- Local card (in linked or local workspace) ----
  return (
    <div
      style={{
        width: 320,
        minWidth: 320,
        padding: 16,
        background: "var(--panel)",
        color: "var(--fg)",
        borderLeft: "1px solid var(--border, #333)",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        position: "relative",
      }}
    >
      {toast && (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            padding: "6px 10px",
            borderRadius: 4,
            background: "#c0392b",
            color: "#fff",
            fontSize: 12,
            zIndex: 10,
          }}
        >
          {toast}
        </div>
      )}

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <input
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          style={{
            flex: 1,
            background: "var(--bg)",
            border: "1px solid var(--border, #444)",
            borderRadius: 4,
            color: "var(--fg)",
            padding: "6px 8px",
            fontSize: 14,
            fontWeight: 600,
          }}
        />
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "var(--fg)",
            opacity: 0.5,
            fontSize: 18,
            cursor: "pointer",
            padding: "0 0 0 8px",
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>

      {/* Source badge */}
      <div style={{ marginBottom: 12 }}>
        <span
          style={{
            fontSize: 10,
            padding: "2px 8px",
            borderRadius: 10,
            background: "#6e7781",
            color: "#fff",
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
        placeholder="Add a description..."
        style={{
          flex: 1,
          background: "var(--bg)",
          border: "1px solid var(--border, #444)",
          borderRadius: 4,
          color: "var(--fg)",
          padding: "8px",
          fontSize: 13,
          resize: "vertical",
          minHeight: 100,
          fontFamily: "inherit",
        }}
      />

      {/* Promote button for cards in linked workspaces */}
      {isLinkedWorkspace && (
        <button
          onClick={handlePromote}
          disabled={promoting}
          style={{
            marginTop: 12,
            padding: "8px 12px",
            background: promoting ? "var(--accent, #888)" : "#8250df",
            border: "none",
            borderRadius: 4,
            color: "#fff",
            fontSize: 13,
            cursor: promoting ? "wait" : "pointer",
            opacity: promoting ? 0.7 : 1,
          }}
        >
          {promoting ? "Creating issue…" : "Create GitHub issue"}
        </button>
      )}

      {/* Meta info */}
      <div
        style={{
          marginTop: 16,
          paddingTop: 12,
          borderTop: "1px solid var(--border, #333)",
          fontSize: 11,
          opacity: 0.5,
        }}
      >
        <div style={{ marginBottom: 4 }}>Created: {formatDate(card.created_at)}</div>
        <div style={{ marginBottom: 8 }}>Updated: {formatDate(card.updated_at)}</div>
      </div>

      {/* Delete button */}
      <button
        onClick={handleDelete}
        style={{
          marginTop: 8,
          padding: "8px 12px",
          background: "#c0392b",
          border: "none",
          borderRadius: 4,
          color: "#fff",
          fontSize: 13,
          cursor: "pointer",
        }}
      >
        Delete card
      </button>
    </div>
  );
}