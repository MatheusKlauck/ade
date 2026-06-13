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
  /** Optional: hand this issue to an agent terminal. When provided, the action
   * bar shows a "Hand to agent →" button; when omitted the button is hidden
   * (no dead control). Wire this from a mount site that can spawn a terminal. */
  onHandToAgent?: (card: CardType) => void;
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

/** OPEN / CLOSED status pill for a GitHub issue. Green = open, purple = closed
 * (mirrors GitHub's own state colours, using theme tokens). */
function StatePill({ closed }: { closed: boolean }) {
  const color = closed ? "var(--source-github)" : "var(--status-success)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        letterSpacing: "0.06em",
        color: closed ? "color-mix(in srgb, var(--source-github) 70%, #fff)" : "var(--status-success)",
        padding: "2px 8px",
        borderRadius: "var(--radius-pill)",
        border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: color }} />
      {closed ? "CLOSED" : "OPEN"}
    </span>
  );
}

/** A row of shimmering skeleton bars used while issue detail loads. */
function Skeleton({ widths }: { widths: string[] }) {
  return (
    <>
      {widths.map((w, i) => (
        <div key={i} className="cd-skel" style={{ width: w, marginBottom: 9 }} />
      ))}
    </>
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

// The panel is a flex column with a fixed header and a fixed action bar; only
// the middle region scrolls. Padding lives on the regions, not the panel.
const panelStyle: CSSProperties = {
  background: "var(--panel)",
  color: "var(--fg)",
  padding: 0,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  position: "relative",
};

const headerStyle: CSSProperties = {
  background: "var(--surface-raised)",
  borderBottom: "1px solid var(--border)",
  padding: "var(--space-md) var(--space-lg) var(--space-sm)",
  flexShrink: 0,
};

const scrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "var(--space-md) var(--space-lg)",
  display: "flex",
  flexDirection: "column",
};

// A hairline-separated content block (the look that defines this direction).
const sectionStyle: CSSProperties = {
  borderBottom: "1px solid var(--border)",
  paddingBottom: "var(--space-md)",
  marginBottom: "var(--space-md)",
};

const actionBarStyle: CSSProperties = {
  background: "var(--surface-raised)",
  borderTop: "1px solid var(--border)",
  padding: "var(--space-sm) var(--space-lg)",
  display: "flex",
  alignItems: "center",
  gap: "var(--space-sm)",
  flexWrap: "wrap",
  flexShrink: 0,
};

// Left mono "spine" label for body sections.
const spineLabelStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: "var(--muted)",
  flex: "0 0 56px",
  paddingTop: 2,
};

const btnPrimaryStyle: CSSProperties = {
  background: "var(--accent)",
  color: "var(--accent-ink)",
  border: "1px solid transparent",
  borderRadius: "var(--radius-sm)",
  padding: "6px 12px",
  fontFamily: "var(--font-sans)",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const btnGhostStyle: CSSProperties = {
  background: "none",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  padding: "6px 12px",
  color: "var(--muted)",
  fontFamily: "var(--font-sans)",
  fontSize: 12.5,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const btnCyanStyle: CSSProperties = {
  background: "color-mix(in srgb, var(--accent-cyan) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--accent-cyan) 40%, transparent)",
  borderRadius: "var(--radius-sm)",
  padding: "6px 12px",
  color: "var(--accent-cyan)",
  fontFamily: "var(--font-sans)",
  fontSize: 12.5,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const metaTextStyle: CSSProperties = {
  marginLeft: "auto",
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  color: "var(--muted)",
  textAlign: "right",
  lineHeight: 1.5,
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

export default function CardDetail({ card, workspace, onClose, onDeleted, modal, onHandToAgent }: CardDetailProps) {
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
    ? // Bounded height so the header/action bar stay pinned and only the middle
      // region scrolls (the modal wrapper otherwise lets the whole card scroll).
      { ...panelStyle, borderRadius: "var(--radius-md)", maxHeight: "85vh" }
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
    const closed = card.github_state === "closed";

    return (
      <div style={containerStyle}>
        {toast && <div style={toastStyle}>{toast}</div>}

        {/* Header (fixed) */}
        <div style={headerStyle}>
          <div
            style={{
              display: "flex",
              alignItems: editing ? "center" : "baseline",
              gap: "var(--space-sm)",
              marginBottom: "var(--space-sm)",
            }}
          >
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--accent-cyan)", flexShrink: 0 }}>
              #{card.github_issue_number}
            </span>
            {editing ? (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  letterSpacing: "0.06em",
                  color: "var(--accent)",
                  padding: "2px 8px",
                  borderRadius: "var(--radius-pill)",
                  border: "1px solid color-mix(in srgb, var(--accent) 40%, transparent)",
                  background: "color-mix(in srgb, var(--accent) 8%, transparent)",
                }}
              >
                EDITING
              </span>
            ) : (
              <StatePill closed={closed} />
            )}
            <span style={{ flex: 1 }} />
            <button onClick={onClose} style={closeButtonStyle}>
              ✕
            </button>
          </div>
          {editing ? (
            <input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              autoFocus
              style={{
                width: "100%",
                boxSizing: "border-box",
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
            <div style={{ fontFamily: "var(--font-sans)", fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>
              {card.title}
            </div>
          )}
        </div>

        {/* Scrollable body */}
        <div style={scrollStyle}>
          {/* Labels + assignee */}
          {(labelChips.length > 0 || card.assignee) && (
            <div style={{ ...sectionStyle, display: "flex", alignItems: "center", gap: "var(--space-md)", flexWrap: "wrap" }}>
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

          {editing ? (
            <textarea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              placeholder="Issue body (Markdown)…"
              style={{
                width: "100%",
                boxSizing: "border-box",
                flex: 1,
                minHeight: 220,
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
          ) : detailLoading && !detail ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)", marginBottom: "var(--space-md)", fontSize: 12.5, color: "var(--muted)" }}>
                <span className="cd-spin" /> Loading details…
              </div>
              <div style={{ ...sectionStyle, border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "var(--space-md)" }}>
                <Skeleton widths={["92%", "88%", "60%"]} />
                <div style={{ height: 6 }} />
                <Skeleton widths={["72%", "82%"]} />
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "var(--space-sm)" }}>
                Comments
              </div>
              {[0, 1].map((i) => (
                <div key={i} style={{ display: "flex", gap: "var(--space-sm)", marginBottom: "var(--space-md)" }}>
                  <div style={{ width: 26, height: 26, borderRadius: "50%", flexShrink: 0, background: "var(--surface-input)" }} />
                  <div style={{ flex: 1 }}>
                    <Skeleton widths={["38%", "90%", "64%"]} />
                  </div>
                </div>
              ))}
            </>
          ) : (
            <div style={sectionStyle}>
              <div style={{ display: "flex", gap: "var(--space-md)" }}>
                <span style={spineLabelStyle}>Body</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {detail && detail.body ? (
                    <MarkdownBody onImageClick={onImageClick}>{detail.body}</MarkdownBody>
                  ) : (
                    <span style={{ fontSize: 13, fontStyle: "italic", color: "var(--muted)" }}>No description.</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Comments */}
          {!editing && detail && (
            <div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "var(--space-sm)" }}>
                Comments · {detail.comments.length}
              </div>
              {detail.comments.length === 0 ? (
                <div style={{ border: "1px dashed var(--border)", borderRadius: "var(--radius-sm)", padding: "var(--space-lg)", textAlign: "center", color: "var(--muted)", fontSize: 12.5 }}>
                  No comments yet.
                </div>
              ) : (
                <div className="cd-thread" style={{ paddingLeft: 14 }}>
                  {detail.comments.map((c) => (
                    <div key={c.id} style={{ display: "flex", gap: "var(--space-sm)", marginBottom: "var(--space-md)", position: "relative" }}>
                      {c.user_avatar_url ? (
                        <img src={c.user_avatar_url} width={26} height={26} alt="" style={{ borderRadius: "50%", flexShrink: 0, alignSelf: "flex-start", zIndex: 1 }} />
                      ) : (
                        <div style={{ width: 26, height: 26, borderRadius: "50%", background: "var(--surface-input)", flexShrink: 0, zIndex: 1 }} />
                      )}
                      <div style={{ flex: 1, minWidth: 0, border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)", padding: "6px 10px", borderBottom: "1px solid var(--border)", background: "var(--surface-input)", borderRadius: "var(--radius-sm) var(--radius-sm) 0 0" }}>
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
                  {closed && (
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)", position: "relative" }}>
                      <span
                        style={{
                          width: 26,
                          height: 26,
                          borderRadius: "50%",
                          flexShrink: 0,
                          zIndex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 13,
                          color: "color-mix(in srgb, var(--source-github) 70%, #fff)",
                          background: "color-mix(in srgb, var(--source-github) 18%, transparent)",
                          border: "1px solid color-mix(in srgb, var(--source-github) 50%, transparent)",
                        }}
                      >
                        ✓
                      </span>
                      <span style={{ fontSize: 12.5, color: "var(--muted)" }}>This issue is closed.</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Action bar (fixed) */}
        <div style={actionBarStyle}>
          {editing ? (
            <>
              <button onClick={handleSaveGithubEdit} disabled={savingEdit} style={{ ...btnPrimaryStyle, cursor: savingEdit ? "wait" : "pointer" }}>
                {savingEdit ? "Saving…" : "Save to GitHub"}
              </button>
              <button onClick={() => setEditing(false)} disabled={savingEdit} style={btnGhostStyle}>
                Cancel
              </button>
              <span style={{ ...metaTextStyle, fontSize: 10.5 }}>Markdown · pushes to GitHub</span>
            </>
          ) : (
            <>
              {detail && (
                <button onClick={startEdit} style={btnPrimaryStyle}>
                  Edit
                </button>
              )}
              {onHandToAgent && (
                <button onClick={() => onHandToAgent(card)} style={btnCyanStyle}>
                  Hand to agent →
                </button>
              )}
              {githubUrl && (
                <button onClick={() => openUrl(githubUrl).catch(() => {})} style={btnGhostStyle}>
                  Open on GitHub ↗
                </button>
              )}
              <span style={metaTextStyle}>
                Created {formatDate(card.created_at)}
                <br />
                {closed ? "Closed" : "Updated"} {formatDate(card.updated_at)}
              </span>
            </>
          )}
        </div>
        {lightbox && <Lightbox img={lightbox} onClose={() => setLightbox(null)} />}
      </div>
    );
  }


  // ---- Local card (in linked or local workspace) ----
  return (
    <div style={containerStyle}>
      {toast && <div style={toastStyle}>{toast}</div>}

      {/* Header (fixed): local badge + editable title */}
      <div style={headerStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)", marginBottom: "var(--space-sm)" }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontWeight: 500,
              padding: "2px 8px",
              borderRadius: "var(--radius-pill)",
              background: "var(--source-local)",
              color: "var(--on-accent)",
            }}
          >
            local
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={closeButtonStyle}>
            ✕
          </button>
        </div>
        <input
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "var(--input-bg)",
            border: "1px solid var(--input-border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--fg)",
            padding: "var(--space-xs) var(--space-sm)",
            fontFamily: "var(--font-sans)",
            fontSize: 15,
            fontWeight: 600,
          }}
        />
      </div>

      {/* Scrollable body: editable description */}
      <div style={scrollStyle}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "var(--space-xs)" }}>
          Description
        </div>
        <textarea
          value={body}
          onChange={(e) => handleBodyChange(e.target.value)}
          onBlur={handleBodyBlur}
          placeholder="Add a description…"
          style={{
            flex: 1,
            minHeight: 160,
            width: "100%",
            boxSizing: "border-box",
            background: "var(--input-bg)",
            border: "1px solid var(--input-border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--fg)",
            padding: "var(--space-sm)",
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            lineHeight: 1.5,
            resize: "vertical",
          }}
        />
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--muted)", marginTop: "var(--space-xs)" }}>
          Auto-save · local card until promoted to a GitHub issue
        </div>
      </div>

      {/* Action bar (fixed): promote + delete */}
      <div style={actionBarStyle}>
        {isLinkedWorkspace && (
          <button
            onClick={handlePromote}
            disabled={promoting}
            style={{
              ...btnPrimaryStyle,
              background: "var(--source-github)",
              color: "var(--on-accent)",
              cursor: promoting ? "wait" : "pointer",
            }}
          >
            {promoting ? "Creating issue…" : "Create GitHub issue"}
          </button>
        )}
        <button
          onClick={handleDelete}
          style={{
            ...btnGhostStyle,
            borderColor: "color-mix(in srgb, var(--status-error-deep) 50%, transparent)",
            color: "var(--status-error-text)",
          }}
        >
          Delete card
        </button>
        <span style={metaTextStyle}>
          Created {formatDate(card.created_at)}
          <br />
          Updated {formatDate(card.updated_at)}
        </span>
      </div>
    </div>
  );
}
