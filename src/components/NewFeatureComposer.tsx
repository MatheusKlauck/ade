import { useEffect, useRef, useState } from "react";
import { gestorBuildFeature, type IssueProposal } from "../lib/ipc";
import { useModalFocus } from "../lib/useModalFocus";

// The hero intake: one input, one button. Type the vision → the Gestor unfolds
// it into Backlog cards that auto-flow to Doing on the board. While it plans we
// show what's happening (the model reads the repo and drafts tasks — that takes
// a moment) and then reveal the unfolded tasks before handing off to the board.
// No proposal checkboxes, no Settings trip (gestor_build_feature ensures L2).

export default function NewFeatureComposer({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const { panelRef, handleKeyDown } = useModalFocus(onClose);
  const [brief, setBrief] = useState("");
  const [building, setBuilding] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<IssueProposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef(0);

  // Tick an elapsed counter while planning so the wait never feels frozen.
  useEffect(() => {
    if (!building) return;
    startedAt.current = Date.now();
    setElapsed(0);
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [building]);

  async function build() {
    if (!brief.trim() || building) return;
    setBuilding(true);
    setError(null);
    try {
      const proposals = await gestorBuildFeature(workspaceId, brief.trim());
      setResult(proposals);
    } catch (e) {
      setError(String(e));
    } finally {
      setBuilding(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "14vh",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        data-testid="new-feature-composer"
        onKeyDown={(e) => {
          handleKeyDown(e);
          // ⌘/Ctrl+Enter submits.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") build();
        }}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(620px, 92vw)",
          background: "var(--bg, #1b1b1f)",
          color: "var(--fg, #e9e9ec)",
          border: "1px solid var(--border, #33333a)",
          borderRadius: 12,
          padding: 20,
          display: "grid",
          gap: 14,
          boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600 }}>New feature</div>

        {result ? (
          // Reveal: the brief unfolded into these tasks; the board takes over.
          <>
            <div style={{ fontSize: 13, opacity: 0.7 }}>
              Desdobrei em {result.length}{" "}
              {result.length === 1 ? "task" : "tasks"} no Backlog — já começando a
              tocar:
            </div>
            <ul
              data-testid="new-feature-result"
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "grid",
                gap: 6,
                maxHeight: "44vh",
                overflowY: "auto",
              }}
            >
              {result.map((p) => (
                <li
                  key={p.id}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "baseline",
                    padding: 8,
                    background: "var(--bg-elev, #232329)",
                    borderRadius: 6,
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{p.title}</span>
                  {p.priority && <span style={chip}>{p.priority}</span>}
                </li>
              ))}
            </ul>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                data-testid="new-feature-watch"
                onClick={onClose}
                style={{ ...btn, ...primary }}
              >
                Acompanhar no board →
              </button>
            </div>
          </>
        ) : building ? (
          // Planning progress — what's happening behind the spinner.
          <div
            data-testid="new-feature-progress"
            style={{ display: "grid", gap: 8, padding: "8px 0" }}
          >
            <div style={{ fontSize: 14 }}>Desdobrando sua visão em tasks…</div>
            <div style={{ fontSize: 13, opacity: 0.65 }}>
              O modelo está lendo o repositório e desenhando as tasks. Pode levar
              alguns segundos.
            </div>
            <div
              style={{
                fontSize: 12,
                opacity: 0.5,
                fontFamily: "var(--mono, monospace)",
              }}
            >
              {elapsed}s
            </div>
          </div>
        ) : (
          // Input.
          <>
            <div style={{ fontSize: 13, opacity: 0.65, marginTop: -8 }}>
              Descreva o que quer. O Gestor desdobra em tasks no Backlog e começa
              a tocar — você acompanha no board.
            </div>

            <textarea
              data-testid="new-feature-brief"
              autoFocus
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="ex.: uma view de configuração do Gestor na top bar, com dial de autonomia e gates por workspace"
              rows={5}
              style={{
                width: "100%",
                resize: "vertical",
                background: "var(--bg-elev, #232329)",
                color: "inherit",
                border: "1px solid var(--border, #33333a)",
                borderRadius: 8,
                padding: 12,
                font: "inherit",
                fontSize: 14,
              }}
            />

            {error && (
              <div style={{ color: "var(--danger, #d35a5a)", fontSize: 13 }}>
                {error}
              </div>
            )}

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span style={{ fontSize: 11, opacity: 0.5 }}>
                ⌘⏎ para construir
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={onClose} style={btn}>
                  Cancelar
                </button>
                <button
                  data-testid="new-feature-build"
                  onClick={build}
                  disabled={!brief.trim()}
                  style={{ ...btn, ...primary }}
                >
                  Build it
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  background: "var(--bg-elev, #232329)",
  color: "inherit",
  border: "1px solid var(--border, #33333a)",
  borderRadius: 6,
  padding: "8px 16px",
  cursor: "pointer",
  font: "inherit",
};
const primary: React.CSSProperties = {
  background: "var(--accent, #5319e7)",
  borderColor: "transparent",
  color: "#fff",
};
const chip: React.CSSProperties = {
  padding: "1px 6px",
  borderRadius: 4,
  background: "var(--bg, #1b1b1f)",
  border: "1px solid var(--border, #33333a)",
  fontSize: 11,
  opacity: 0.8,
};
