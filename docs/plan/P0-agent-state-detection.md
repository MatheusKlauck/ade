# P0 — Detecção de estado do agente no terminal

Plano de feature derivado da avaliação do competidor **Herdr** (terminal multiplexer
para agentes de IA, https://herdr.dev). O gap identificado: o ADE conhece o estado
da **task** (FSM em `agent_task.state`), mas não o estado do **agente dentro do
tmux** — não sabe distinguir `working` de `blocked` (esperando aprovação/pergunta)
sem polling grosseiro. O Herdr resolve isso com manifests TOML + regra de autoridade
entre lifecycle hooks e snapshot do bottom-buffer do PTY.

Este plano replica o **núcleo funcional** do modelo do Herdr, no contexto do ADE
(Tauri + Rust core + SQLite + tmux, sem virar multiplexer). Detach/reattach, remote
SSH attach, server/client split e layout tree declarativo ficam **fora de escopo**
(competem com a aposta desktop-first do PRODUCT.md).

---

## Premissas (sujeitas a validação humana)

1. **O gap é real.** Hoje o ADE detecta `awaiting_input` apenas por timeout
   (`stall_timeout_secs`, 10 min de silêncio no `events.jsonl`). Isso confunde
   "agente pensando 12 min" com "agente bloqueado". P0 troca silêncio por sinal
   positivo: o PTY do agente mostra um prompt de aprovação conhecido.
2. **Claude Code é o único worker no escopo.** Tier B (aider/codex/opencode) fica
   para G6, como no plano-gestor. Manifests são desenhados para extensão, mas P0
   shippa só o manifest do `claude`.
3. **Não inventamos nomes.** Estados do agente no PTY usam o vocabulário do
   `CONTEXT.md` + um novo termo **`agent_signal`** (abaixo). FSM da task
   (`agent_task.state`) não muda; `agent_signal` é uma camada **observacional**
   que alimenta `awaiting_input` sem substituir a FSM.
4. **SQLite continua source of truth.** `agent_signal` é efêmero (tabela
   `agent_signal` com replace-by-window_id), só alimenta projeção de badge e o
   disparo de `awaiting_input`. Persistência é para auditoria, não para decisões
   de FSM que já vivem em `agent_task`.
5. **Sem nova dependência.** Tail do PTY já existe (G2 faz tail JSONL); P0
   reusa o canal. Regex de manifest é `regex` crate (já no lockfile).

---

## Objetivo mensurável (DoD)

- Um worker Claude Code pedindo permissão (`--permission-mode acceptEdits` sem
  whitelist do tool) → badge do card passa a `awaiting_input` em **< 3 s** do
  prompt aparecer no PTY, **sem** esperar `stall_timeout_secs`.
- Mesmo worker imprimindo código ativo por 15 min → badge permanece `working`
  (falso positivo de `awaiting_input` = 0 em 10 runs de QA).
- Matar o ADE e reabrir → último `agent_signal` conhecido é reposto sem
  duplicar evento nem reabrir tmux.
- `claude` CLI ausente no boot → feature degrada com notificação
  `GESTOR_PROVIDER_MISSING` (canal existente), sem crash.
- Manifest do `claude` editável em `app_data_dir/agent-detection/claude.toml`
  com override local vencendo o bundled.

---

## Arquitetura

```
┌─────────────────────────────────────────────────────────────────┐
│  tmux window (window_id) ── PTY do worker (claude)              │
│       │                                                          │
│       │  (1) tail do PTY (canal já existente do G2)              │
│       ▼                                                          │
│  gestor::signal::Sampler (Rust, spawn_blocking)                  │
│       │  mantém ring buffer dos últimos N bytes do bottom-buffer │
│       │  (default 4 KB, configurável por workspace)              │
│       ▼                                                          │
│  gestor::signal::Detector                                        │
│       │  carrega manifest do `claude` (bundled → remote → local) │
│       │  aplica regras em ordem de prioridade                    │
│       ▼                                                          │
│  agent_signal { window_id, signal, evidence, ts }                │
│       │  (tabela nova, replace por window_id)                    │
│       │  (event: evt:agent_signal)                               │
│       ▼                                                          │
│  Projeção:                                                       │
│   • FSM transition working→awaiting_input quando signal=blocked  │
│   • Badge do card segue o signal (Data Cyan / warning)           │
│   • Notification center recebe signal=blocked                    │
└─────────────────────────────────────────────────────────────────┘
```

**Autoridade (copia Herdr com adaptação):** lifecycle hooks > screen manifest >
fallback `unknown`. Para o Claude Code, P0 shippa **só screen manifest** (não
instalamos lifecycle hooks neste slice — eles são uma extensão natural quando
o `worker_adapter` do G6 existir). `unknown` → sinal `working` (nunca
`blocked`, evita falso positivo).

---

## Modelo de dados

**`0008_agent_signal.sql`** (append-only, segue padrão §5 do plano-gestor):

```sql
CREATE TABLE agent_signal (
  window_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES agent_task(id) ON DELETE CASCADE,
  signal TEXT NOT NULL CHECK (signal IN ('working','blocked','idle','done','unknown')),
  evidence TEXT,
  manifest_version TEXT,
  detected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_signal_ws ON agent_signal(workspace_id, signal);
```

`evidence` = trecho (até 256 chars) do bottom-buffer que disparou a regra, para
debug e auditoria no Feed. Não loga prompt completo (risco de segredo, mesmo
princípio do `session-history.json` do Herdr que é opt-in).

Sem nova coluna em `card` — `agent_signal.signal` projeta no badge via join
`card.terminal_window_id = agent_signal.window_id` (caminho já usado pelo G2).

---

## Manifest format

`app_data_dir/agent-detection/claude.toml`:

```toml
agent = "claude"
version = 1

[[rules]]
signal = "blocked"
priority = 10
# regex aplicado contra o bottom-buffer (últimos 4 KB)
pattern = 'Do you want to allow\?|Proceed with|Permission to use .* tool'
# quanto do buffer avaliar (bytes desde o final)
scan_window = 4096

[[rules]]
signal = "blocked"
priority = 9
pattern = '✻ Waiting for your input|Idle for'

[[rules]]
signal = "done"
priority = 5
pattern = '^✻ Task complete|^\[claude\] exit'

[[rules]]
signal = "working"
priority = 1
# fallback: se nada match e houve output recente
pattern = '.'
scan_window = 256
```

**Resolução (ordem):** local override → remote cached → bundled. "Local sempre
vence" (Herdr). Remote fetch é **P1** (não P0) — bundled + local cobrem o
slice. `manifest_version` gravado em `agent_signal` para auditoria.

---

## Superfície IPC & eventos (novos)

| Comando | Faz |
|---|---|
| `signal_get(window_id)` | estado atual do signal p/ aquele PTY |
| `signal_list(workspace_id)` | todos os signals vivos (p/ sidebar) |
| `signal_explain(window_id)` | debug: qual regra matchou, manifest source, evidence (equivalente ao `herdr agent explain`) |

Evento: `evt:agent_signal { window_id, signal, evidence, manifest_version }`.

Sem mutação de FSM por IPC — signal alimenta o `transition()` existente. A
única transição nova que P0 habilita é `working → awaiting_input` quando
`signal=blocked` (já prevista no plano-gestor §3, linha 212).

---

## Interação com a FSM existente

- `signal=blocked` + `state=working` → `transition(awaiting_input)` (imediato,
  sem esperar `stall_timeout_secs`).
- `signal=working` + `state=awaiting_input` → **não** volta sozinho. Humano
  responde no terminal (ou `task_nudge`) e o `state` avança por evento
  existente. Evita oscilação.
- `signal=done` + `state=working` → **não** avança sozinho. Mantém a tabela de
  decisão do Stop (plano-gestor §2.3) como autoridade — signal é **entrada
  adicional**, não substitui marker `ADE_TASK_DONE` nem git-state.
- `signal=unknown` → trata como `working` (fallback conservador).

Esta é a diferença conceptual vs. Herdr: lá o signal **é** o estado. No ADE o
signal **alimenta** a FSM determinística. O Gestor continua dono do loop.

---

## Falhas e degradação

| Falha | Comportamento |
|---|---|
| `claude` CLI ausente | `GESTOR_PROVIDER_MISSING` (canal existente) — feature desligada, app normal |
| Tail do PTY quebra (tmux morto) | `signal=unknown`, `agent_event` level=warn, card mantém último state |
| Manifest bundled inválido (regex não compila) | Ignora regra, loga `agent_event` level=error, não crasha o app |
| Buffer vazio (worker recém-lançado) | `signal=unknown` até primeiro output |
| Regex match ambíguo (2 regras hit) | Maior `priority` vence; empate → primeira declarada |
| Múltiplas janelas mesmo card | `window_id` é PK; cada uma tem signal próprio; projeção do badge pega a do `card.terminal_window_id` |

---

## Tasks (cada uma = 1 commit, gates verdes)

| ID | Task | Arquivos principais |
|---|---|---|
| P0-1 | Migration `0008_agent_signal.sql` + schema migration | `src-tauri/migrations/0008_agent_signal.sql` · `src-tauri/src/gestor/mod.rs` |
| P0-2 | Módulo `gestor::signal` (Sampler + ring buffer 4 KB) | `src-tauri/src/gestor/signal.rs` |
| P0-3 | Detector + loader de manifest (TOML, resolução local>bundled) | `src-tauri/src/gestor/signal/detector.rs` · `src-tauri/agent-detection/claude.toml` |
| P0-4 | Bridge signal→FSM (`signal=blocked` → `awaiting_input`) | `src-tauri/src/gestor/fsm.rs` |
| P0-5 | IPC `signal_get/list/explain` + evento `evt:agent_signal` | `src-tauri/src/ipc/signal.rs` |
| P0-6 | UI: badge do card lê `agent_signal` + sidebar de signals | `src/components/Card/Badge.tsx` · `src/components/Gestor/Signals.tsx` |
| P0-7 | Persistência + reconciliação pós-restart | `src-tauri/src/gestor/signal/persist.rs` |
| P0-8 | QA: teste e2e de "pedir permissão → badge < 3s" | `e2e/agent-signal.spec.ts` |

**Fora de escopo (P1+):** remote manifest fetch, lifecycle-hook authority,
manifests para outros workers (Tier B no G6), `layout.export/apply` do Herdr,
agent-drivable control surface (SKILL.md do ADE), resume de sessão por agente
no restart.

---

## Riscos

| Risco | Mitigação |
|---|---|
| Regex fragil (claude muda wording de prompt) | manifest versionado + override local; usuário/editável; `signal_explain` para debug |
| Falso positivo de `blocked` (regex match em código que o agente imprimiu) | `scan_window` pequeno (4 KB) + regex anchored; QA com 10 runs; `evidence` visível para auditoria |
| Custo de CPU do sampler (polling 4 KB a cada N ms) | poll interval 500 ms default; ring buffer em memória, sem realocação; spawn_blocking |
| Vazar segredo pelo `evidence` | cap 256 chars, não loga prompt completo, opt-in nível workspace futuro |
| Conflito com `stall_timeout` (ainda ativo) | `stall_timeout` vira fallback de segundo nível; signal positivo sempre vence |

---

## Notas

- **Vocabulário:** `agent_signal` (novo) é o estado observado do PTY do agente.
  Distinto de `agent_task.state` (FSM) e de `agent_event` (auditoria). Não
  sobrescreve termos do `CONTEXT.md`; será adicionado lá quando este plano for
  aprovado.
- **Decisão D14 (a registrar):** signal é camada observacional, nunca dono do
  loop. Esta é a divergência intencional vs. Herdr — o Gestor determinístico
  permanece a autoridade de transição.
- **Dependência externa:** nenhuma. `regex` já no `Cargo.lock`. `toml` já no
  lockfile (config do ADE já parseia TOML).