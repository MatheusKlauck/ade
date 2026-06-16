import { useCallback, useEffect, useState } from "react";
import { settingGet, settingSet } from "../lib/ipc";

// Gestor config (#57/#50/#55): the per-workspace knobs the runtime reads from
// workspace_setting. Self-contained — loads each key on mount, saves on change.
// Mirrors the Rust defaults in dispatch.rs / autonomy.rs so the UI shows what the
// loop actually uses when a key is unset.

const AUTONOMY = [
  {
    value: "L0",
    label: "L0 · Manual",
    desc: "Presente, mas manual — você move cada card; o loop não age.",
  },
  {
    value: "L1",
    label: "L1 · Copiloto",
    desc: "Roda jobs sob demanda; nunca move card nem abre terminal.",
  },
  {
    value: "L2",
    label: "L2 · Supervisionado",
    desc: "Liga o loop autônomo: despacha workers + gate humano de merge.",
  },
  { value: "L3", label: "L3 · Autônomo", desc: "Tudo de L2 + auto-merge." },
];

type Saved = "idle" | "saving" | "ok" | "err";

export default function GestorSettings({
  workspaceId,
}: {
  workspaceId: string | null;
}) {
  const [level, setLevel] = useState("L0");
  const [baseBranch, setBaseBranch] = useState("main");
  const [maxParallel, setMaxParallel] = useState("1");
  const [maxAttempts, setMaxAttempts] = useState("3");
  const [stallSecs, setStallSecs] = useState("600");
  const [requireCi, setRequireCi] = useState(false);
  const [l3Skip, setL3Skip] = useState(false);
  const [gateCommands, setGateCommands] = useState(""); // one per line
  const [stageSkills, setStageSkills] = useState(""); // raw JSON
  const [stageErr, setStageErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved>("idle");

  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    const get = (k: string) => settingGet(workspaceId, k).catch(() => null);
    (async () => {
      const [lv, bb, mp, ma, ss, ci, sk, gc, st] = await Promise.all([
        get("autonomy_level"),
        get("base_branch"),
        get("max_parallel_workers"),
        get("max_attempts"),
        get("stall_timeout_secs"),
        get("require_ci"),
        get("l3_skip_permissions"),
        get("gate_commands"),
        get("stage_skills"),
      ]);
      if (!alive) return;
      setLevel(lv ?? "L0");
      setBaseBranch(bb ?? "main");
      setMaxParallel(mp ?? "1");
      setMaxAttempts(ma ?? "3");
      setStallSecs(ss ?? "600");
      setRequireCi(ci === "true");
      setL3Skip(sk === "true");
      setGateCommands(parseJsonLines(gc));
      setStageSkills(st ?? "");
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  const save = useCallback(
    async (key: string, value: string) => {
      if (!workspaceId) return;
      setSaved("saving");
      try {
        await settingSet(workspaceId, key, value);
        setSaved("ok");
      } catch (e) {
        console.error(`settingSet ${key} failed`, e);
        setSaved("err");
      }
    },
    [workspaceId],
  );

  function saveStageSkills(raw: string) {
    const trimmed = raw.trim();
    if (trimmed && !isValidJson(trimmed)) {
      setStageErr("JSON inválido — não salvo.");
      return;
    }
    setStageErr(null);
    save("stage_skills", trimmed);
  }

  if (!workspaceId) {
    return (
      <p style={muted}>Selecione um workspace para configurar o Gestor.</p>
    );
  }

  return (
    <div style={{ maxWidth: 560, display: "grid", gap: 18 }}>
      <Row
        label="Nível de autonomia"
        hint={AUTONOMY.find((a) => a.value === level)?.desc}
      >
        <select
          data-testid="gestor-autonomy"
          value={level}
          onChange={(e) => {
            setLevel(e.target.value);
            save("autonomy_level", e.target.value);
          }}
          style={field}
        >
          {AUTONOMY.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </Row>

      <Row
        label="Branch base"
        hint="Branch de onde os worktrees saem e pra onde os PRs vão."
      >
        <input
          value={baseBranch}
          onChange={(e) => setBaseBranch(e.target.value)}
          onBlur={() => save("base_branch", baseBranch.trim() || "main")}
          style={{ ...field, width: 200 }}
        />
      </Row>

      <Row
        label="Workers paralelos"
        hint="Quantas tasks o loop despacha ao mesmo tempo."
      >
        <NumInput
          value={maxParallel}
          setValue={setMaxParallel}
          min={1}
          onCommit={(v) => save("max_parallel_workers", v)}
        />
      </Row>

      <Row
        label="Tentativas máximas"
        hint="Quantas vezes uma task tenta consertar antes de escalar pra humano."
      >
        <NumInput
          value={maxAttempts}
          setValue={setMaxAttempts}
          min={1}
          onCommit={(v) => save("max_attempts", v)}
        />
      </Row>

      <Row
        label="Timeout de stall (s)"
        hint="Silêncio do worker além disso dispara diagnose_stall."
      >
        <NumInput
          value={stallSecs}
          setValue={setStallSecs}
          min={30}
          onCommit={(v) => save("stall_timeout_secs", v)}
        />
      </Row>

      <Row
        label="Exigir CI verde"
        hint="Espera os checks do GitHub passarem antes de poder mergear."
      >
        <input
          type="checkbox"
          checked={requireCi}
          onChange={(e) => {
            setRequireCi(e.target.checked);
            save("require_ci", String(e.target.checked));
          }}
        />
      </Row>

      <Row
        label="L3: pular permissões"
        hint="Só em L3 — workers rodam com bypassPermissions (sempre dentro do worktree)."
      >
        <input
          type="checkbox"
          checked={l3Skip}
          onChange={(e) => {
            setL3Skip(e.target.checked);
            save("l3_skip_permissions", String(e.target.checked));
          }}
        />
      </Row>

      <div>
        <label style={lbl}>Comandos de gate (build/test) — um por linha</label>
        <textarea
          data-testid="gestor-gate-commands"
          value={gateCommands}
          onChange={(e) => setGateCommands(e.target.value)}
          onBlur={() => save("gate_commands", linesToJson(gateCommands))}
          rows={3}
          placeholder={"cargo test\nbun run test"}
          style={{ ...field, width: "100%", fontFamily: "var(--font-mono)" }}
        />
      </div>

      <div>
        <label style={lbl}>stage_skills (JSON avançado)</label>
        <textarea
          data-testid="gestor-stage-skills"
          value={stageSkills}
          onChange={(e) => setStageSkills(e.target.value)}
          onBlur={() => saveStageSkills(stageSkills)}
          rows={4}
          placeholder={
            '{"verify":[{"skill":"review","required":true,"runs":3}]}'
          }
          style={{ ...field, width: "100%", fontFamily: "var(--font-mono)" }}
        />
        {stageErr && <p style={errText}>{stageErr}</p>}
      </div>

      <div style={{ height: 16, fontSize: 12, color: "var(--muted)" }}>
        {saved === "saving" && "Salvando…"}
        {saved === "ok" && "Salvo ✓"}
        {saved === "err" && (
          <span style={{ color: "var(--danger, #d35a5a)" }}>
            Falha ao salvar
          </span>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span style={{ fontSize: 13 }}>{label}</span>
        {children}
      </div>
      {hint && (
        <span style={{ fontSize: 11, color: "var(--muted)" }}>{hint}</span>
      )}
    </div>
  );
}

function NumInput({
  value,
  setValue,
  min,
  onCommit,
}: {
  value: string;
  setValue: (v: string) => void;
  min: number;
  onCommit: (v: string) => void;
}) {
  return (
    <input
      type="number"
      min={min}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        const n = Math.max(min, parseInt(value, 10) || min);
        setValue(String(n));
        onCommit(String(n));
      }}
      style={{ ...field, width: 90 }}
    />
  );
}

function isValidJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

// JSON array of strings → newline-joined text (and back). Tolerant of junk.
export function parseJsonLines(raw: string | null): string {
  if (!raw) return "";
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.join("\n") : "";
  } catch {
    return "";
  }
}
export function linesToJson(text: string): string {
  return JSON.stringify(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

const field: React.CSSProperties = {
  background: "var(--input-bg, #232329)",
  color: "var(--fg)",
  border: "1px solid var(--input-border, #33333a)",
  borderRadius: 4,
  padding: "6px 8px",
  font: "inherit",
};
const lbl: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "var(--muted)",
  marginBottom: 6,
};
const muted: React.CSSProperties = { fontSize: 13, color: "var(--muted)" };
const errText: React.CSSProperties = {
  margin: "6px 0 0",
  fontSize: 11,
  color: "var(--danger, #d35a5a)",
};
