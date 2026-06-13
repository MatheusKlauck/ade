import { useState, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Card as CardType, Workspace, CardDetail as CardDetailType } from "../lib/ipc";
import { cardUpdate, cardDelete, cardDetail as fetchCardDetail, cardPromote, cardUpdateGithub } from "../lib/ipc";

interface CardDetailProps {
  card: CardType | null;
  workspace: Workspace | null;
  onClose: () => void;
  onDeleted: () => void;
  modal?: boolean;
}

/** Render a GitHub markdown body safely: GFM (task lists, tables) + sanitize
 * (untrusted issue/comment content). Links open in the system browser via the
 * opener plugin instead of navigating the webview; images are lazy and open in
 * the lightbox on click. Block styling lives in `.md-body` (styles.css). */
function MarkdownBody({
  children,
  onImageClick,
}: {
  children: string;
  onImageClick: (src: string, alt: string) => void;
}) {
  const components: Components = {
    a({ node: _node, href, children, ...props }) {
      return (
        <a
          {...props}
          href={href}
          onClick={(e) => {
            e.preventDefault();
            if (href) openUrl(href).catch(() => {});
          }}
        >
          {children}
        </a>
      );
    },
    img({ node: _node, src, alt, ...props }) {
      const s = typeof src === "string" ? src : "";
      const a = alt ?? "";
      return (
        <img
          {...props}
          src={s}
          alt={a}
          loading="lazy"
          onClick={() => s && onImageClick(s, a)}
        />
      );
    },
  };
  return (
    <div className="md-body">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={components}
      >
        {children}
      </Markdown>
    </div>
  );
}

/** Dark vs light ink for a label's background colour (relative luminance). */
function readableInk(hex: string): string {
  const h = hex.replace("#", "");
  if (h.length < 6) return "#fff";
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? "#0d0b1c" : "#fff";
}

/** A GitHub label chip. Coloured + filled when a colour is known (live fetch),
 * neutral + outlined when only the cached name is available. */
function LabelChip({ name, color }: { name: string; color: string | null }) {
  if (!color) {
    return (
      <span
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
        {name}
      </span>
    );
  }
  return (
    <span
      style={{
        fontSize: 11,
        padding: "2px 8px",
        borderRadius: "var(--radius-pill)",
        background: color,
        color: readableInk(color),
        fontFamily: "var(--font-mono)",
        fontWeight: 600,
      }}
    >
      {name}
    </span>
  );
}

/** Full-screen image preview, click anywhere to dismiss. */
function Lightbox({
  img,
  onClose,
}: {
  img: { src: string; alt: string };
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.82)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        cursor: "zoom-out",
      }}
    >
      <img
        src={img.src}
        alt={img.alt}
        style={{
          maxWidth: "90vw",
          maxHeight: "82vh",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--border)",
        }}
      />
      {img.alt && (
        <div style={{ color: "var(--muted)", fontSize: 12, fontFamily: "var(--font-sans)" }}>
          {img.alt}
        </div>
      )}
    </div>
  );
}

const panelStyle: CSSProperties = {
  background: "var(--panel)",
  color: "var(--fg)",
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

export default function CardDetail({ card, workspace, onClose, onDeleted, modal }: CardDetailProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [promoting, setPromoting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [detail, setDetail] = useState<CardDetailType | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  // GitHub issue edit mode (title + body, pushed to GitHub on save).
  const [editing, setEditing] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isLinkedWorkspace = !!(workspace?.github_owner && workspace?.github_repo);
  const isGithubCard = card?.source === "github";

  const containerStyle: CSSProperties = modal
    ? { ...panelStyle, borderRadius: "var(--radius-md)" }
    : { ...panelStyle, width: 400, minWidth: 400, flexShrink: 0, alignSelf: "stretch", borderLeft: "1px solid var(--border)" };

  useEffect(() => {
    if (card) {
      setTitle(card.title);
      setBody(card.body_preview || "");
      setDetail(null);
      setEditing(false);
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
      <div style={{ ...containerStyle, alignItems: "center", justifyContent: "center" }}>
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

  const startEdit = () => {
    if (!card) return;
    setEditTitle(card.title);
    setEditBody(detail?.body ?? "");
    setEditing(true);
  };

  const handleSaveGithubEdit = async () => {
    if (!card || savingEdit) return;
    if (!editTitle.trim()) {
      setToast("Title can't be empty");
      setTimeout(() => setToast(null), 3000);
      return;
    }
    setSavingEdit(true);
    try {
      await cardUpdateGithub(card.id, editTitle.trim(), editBody);
      // Reflect the saved body locally so the rendered view is up to date; the
      // title refreshes via the evt:board event.
      setDetail((d) => (d ? { ...d, body: editBody } : d));
      setEditing(false);
      setToast("Issue updated on GitHub");
      setTimeout(() => setToast(null), 3000);
    } catch {
      setToast("Failed to update GitHub issue");
      setTimeout(() => setToast(null), 4000);
    } finally {
      setSavingEdit(false);
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

  // ---- Linked card (source=github): rendered detail view ----
  if (isGithubCard) {
    // Coloured chips from the live fetch; fall back to the cached names (no
    // colour) until detail loads or when the live fetch was skipped.
    const labelChips: { name: string; color: string | null }[] =
      detail && detail.labels.length > 0
        ? detail.labels.map((l) => ({ name: l.name, color: l.color ? `#${l.color}` : null }))
        : parseLabels(card.labels_json).map((name) => ({ name, color: null }));
    const assigneeAvatar = detail?.assignee_avatar_url ?? null;
    const onImageClick = (src: string, alt: string) => setLightbox({ src, alt });

    return (
      <div style={containerStyle}>
        <div style={{ display: "contents" }}>
          {toast && <div style={toastStyle}>{toast}</div>}

          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--space-sm)", marginBottom: "var(--space-sm)" }}>
            <div style={{ display: "flex", alignItems: editing ? "center" : "baseline", gap: "var(--space-sm)", flex: 1, minWidth: 0 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--accent-cyan)", flexShrink: 0 }}>
                #{card.github_issue_number}
              </span>
              {editing ? (
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  autoFocus
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: "var(--input-bg)",
                    border: "1px solid var(--input-border)",
                    borderRadius: "var(--radius-sm)",
                    color: "var(--fg)",
                    padding: "var(--space-xs) var(--space-sm)",
                    fontFamily: "var(--font-sans)",
                    fontSize: 16,
                    fontWeight: 600,
                  }}
                />
              ) : (
                <span style={{ fontFamily: "var(--font-sans)", fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>
                  {card.title}
                </span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)", flexShrink: 0 }}>
              {!editing && detail && (
                <button
                  onClick={startEdit}
                  title="Edit issue title and body"
                  style={{
                    background: "none",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    color: "var(--muted)",
                    cursor: "pointer",
                    padding: "2px 10px",
                    fontFamily: "var(--font-sans)",
                    fontSize: 12,
                  }}
                >
                  Edit
                </button>
              )}
              <button onClick={onClose} style={closeButtonStyle}>
                ✕
              </button>
            </div>
          </div>

          {/* Labels + assignee */}
          {(labelChips.length > 0 || card.assignee) && (
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-md)", flexWrap: "wrap", marginBottom: "var(--space-md)" }}>
              {labelChips.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-xs)" }}>
                  {labelChips.map((l, i) => (
                    <LabelChip key={i} name={l.name} color={l.color} />
                  ))}
                </div>
              )}
              {card.assignee && (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {assigneeAvatar && (
                    <img src={assigneeAvatar} width={20} height={20} alt="" style={{ borderRadius: "50%" }} />
                  )}
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--muted)" }}>
                    {card.assignee}
                  </span>
                </div>
              )}
            </div>
          )}

          {detailLoading && (
            <div style={{ fontFamily: "var(--font-sans)", fontSize: 13, color: "var(--muted)", marginBottom: "var(--space-sm)" }}>
              Loading details…
            </div>
          )}

          {/* Body — editor (edit mode) or rendered markdown */}
          {editing ? (
            <div style={{ marginBottom: "var(--space-md)" }}>
              <textarea
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                placeholder="Issue body (Markdown)…"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  minHeight: 180,
                  resize: "vertical",
                  background: "var(--input-bg)",
                  border: "1px solid var(--input-border)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--fg)",
                  padding: "var(--space-sm)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                  lineHeight: 1.55,
                }}
              />
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)", marginTop: "var(--space-sm)" }}>
                <button
                  onClick={handleSaveGithubEdit}
                  disabled={savingEdit}
                  style={{
                    padding: "var(--space-xs) var(--space-md)",
                    background: "var(--accent)",
                    border: "none",
                    borderRadius: "var(--radius-sm)",
                    color: "var(--on-accent)",
                    fontFamily: "var(--font-sans)",
                    fontSize: 13,
                    cursor: savingEdit ? "wait" : "pointer",
                  }}
                >
                  {savingEdit ? "Saving…" : "Save to GitHub"}
                </button>
                <button
                  onClick={() => setEditing(false)}
                  disabled={savingEdit}
                  style={{
                    padding: "var(--space-xs) var(--space-md)",
                    background: "none",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    color: "var(--muted)",
                    fontFamily: "var(--font-sans)",
                    fontSize: 13,
                    cursor: savingEdit ? "default" : "pointer",
                  }}
                >
                  Cancel
                </button>
                <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
                  Markdown · pushes to GitHub
                </span>
              </div>
            </div>
          ) : (
            detail &&
            detail.body && (
              <div
                style={{
                  padding: "var(--space-md)",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  marginBottom: "var(--space-md)",
                  flex: "0 1 auto",
                }}
              >
                <MarkdownBody onImageClick={onImageClick}>{detail.body}</MarkdownBody>
              </div>
            )
          )}

          {/* Comments */}
          {detail && detail.comments.length > 0 && (
            <div style={{ marginBottom: "var(--space-md)" }}>
              <div style={{ fontFamily: "var(--font-sans)", fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "var(--space-sm)" }}>
                Comments · {detail.comments.length}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
                {detail.comments.map((c) => (
                  <div key={c.id} style={{ display: "flex", gap: "var(--space-sm)" }}>
                    {c.user_avatar_url ? (
                      <img
                        src={c.user_avatar_url}
                        width={26}
                        height={26}
                        alt=""
                        style={{ borderRadius: "50%", flexShrink: 0, alignSelf: "flex-start" }}
                      />
                    ) : (
                      <div style={{ width: 26, height: 26, borderRadius: "50%", background: "var(--surface-input)", flexShrink: 0 }} />
                    )}
                    <div
                      style={{
                        flex: 1,
                        minWidth: 0,
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-sm)",
                        background: "var(--bg)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "var(--space-sm)",
                          padding: "6px 10px",
                          borderBottom: "1px solid var(--border)",
                          background: "var(--surface-input)",
                          borderRadius: "var(--radius-sm) var(--radius-sm) 0 0",
                        }}
                      >
                        <span style={{ fontWeight: 600, fontSize: 12.5 }}>{c.user_login}</span>
                        <span style={{ color: "var(--muted)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                          {formatDate(c.created_at)}
                        </span>
                      </div>
                      <div style={{ padding: "4px 10px 8px" }}>
                        <MarkdownBody onImageClick={onImageClick}>{c.body}</MarkdownBody>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Open on GitHub */}
          {githubUrl && (
            <button
              onClick={() => openUrl(githubUrl).catch(() => {})}
              style={{
                alignSelf: "flex-start",
                marginTop: "var(--space-xs)",
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                color: "var(--accent)",
                fontFamily: "var(--font-sans)",
                fontSize: 12,
              }}
            >
              Open on GitHub ↗
            </button>
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
        {lightbox && <Lightbox img={lightbox} onClose={() => setLightbox(null)} />}
      </div>
    );
  }

  // ---- Local card (in linked or local workspace) ----
  return (
    <div style={containerStyle}>
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
