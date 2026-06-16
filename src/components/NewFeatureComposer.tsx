import { useState } from "react";
import { gestorBuildFeature } from "../lib/ipc";
import { useModalFocus } from "../lib/useModalFocus";

// The hero intake: one input, one button. Type the vision → the Gestor unfolds
// it into Backlog cards that auto-flow to Doing on the board behind this modal.
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
  const [error, setError] = useState<string | null>(null);

  async function build() {
    if (!brief.trim() || building) return;
    setBuilding(true);
    setError(null);
    try {
      await gestorBuildFeature(workspaceId, brief.trim());
      onClose(); // the board (evt:board) takes over from here
    } catch (e) {
      setError(String(e));
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
        <div style={{ fontSize: 13, opacity: 0.65, marginTop: -8 }}>
          Descreva o que quer. O Gestor desdobra em tasks no Backlog e começa a
          tocar — você acompanha no board.
        </div>

        <textarea
          data-testid="new-feature-brief"
          autoFocus
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="ex.: uma view de configuração do Gestor na top bar, com dial de autonomia e gates por workspace"
          rows={5}
          disabled={building}
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
          <span style={{ fontSize: 11, opacity: 0.5 }}>⌘⏎ para construir</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} disabled={building} style={btn}>
              Cancelar
            </button>
            <button
              data-testid="new-feature-build"
              onClick={build}
              disabled={building || !brief.trim()}
              style={{ ...btn, ...primary }}
            >
              {building ? "Desdobrando…" : "Build it"}
            </button>
          </div>
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
  padding: "8px 16px",
  cursor: "pointer",
  font: "inherit",
};
const primary: React.CSSProperties = {
  background: "var(--accent, #5319e7)",
  borderColor: "transparent",
  color: "#fff",
};
