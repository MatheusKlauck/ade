<!-- /autoplan restore point: /Users/mk/.gstack/projects/MatheusKlauck-ade/main-autoplan-restore-20260618-082741.md -->
# P0 — Detecção heurística de estado de agente (multi-agente, zero-config)

> **VEREDITO: PULADO (2026-06-18).** O badge de estado vivo que o herdr dá
> (blocked/working/done/idle) **já está implementado no Ade para o Claude Code**,
> e melhor: via hooks → `events.jsonl` → FSM (semântico, não palpite), com coluna
> do board + badge no card + notificação, testado (29 testes em
> `fsm`/`runtime`/`dispatch`/`worker`). O herdr é heurística sobre bytes; o Ade
> tem o sinal confiável. P0 só estendia isso a CLIs não-Claude via regex — exatamente
> o que o CEO review marcou como premissa não validada (o usuário roda outros CLIs
> no Ade?). Como a resposta é "só Claude Code", o valor do herdr já está coberto.
> **Próximo: P1 (API de auto-orquestração — agente lead dirige panes + lê estado de
> sub-agentes).** Dois caveats fora do escopo de P0: (1) o tail vivo só roda em L2+;
> em L0 manual o badge não atualiza live — fix pequeno separado; (2) estado vivo de
> agentes não-Claude segue ausente (Tier B é stub).

## Contexto e premissa

O concorrente **herdr** ganha numa coisa só: dá badge de estado vivo
(blocked/working/done/idle) para **15+ CLIs de agente** (Codex, Copilot CLI,
Cursor, Droid, OpenCode…) **sem instrumentar nada** — só nome do processo em
foreground + heurística do output do terminal.

O Ade hoje só enxerga estado vivo do **Claude Code**, e de forma profunda
(hooks `Stop`/`Notification` → `events.jsonl` → FSM). Qualquer outro agente cai
no Tier B (`GenericAdapter`), que infere ciclo por git-state + silêncio e
**não tem `awaiting_input` confiável** (`worker.rs:188`, documentado). Esse é o
buraco exato que o herdr explora.

**Premissa central:** a exposição do Ade é ser monogâmico com Claude Code. O
mercado roda vários CLIs. Fechar o buraco do Tier B com um detector heurístico
de output captura quase todo o valor do herdr — sem virar produto novo.

## O que JÁ existe (DRY — não reconstruir)

| Peça | Arquivo | Estado |
|------|---------|--------|
| FSM com `Working` / `AwaitingInput` / etc. | `gestor/fsm.rs:22-40` | pronto |
| Caminho único de transição + projeção no board | `gestor/fsm.rs:145-224` | pronto |
| `WorkerAdapter` trait + `GenericAdapter` (Tier B) | `gestor/worker.rs:39-111` | trait pronto, **stub** |
| `select_adapter()` (escolhe Tier A/B) | `gestor/worker.rs:96-111` | existe, **não cabeado** (dispatch força Claude em `dispatch.rs:203`) |
| Scanner `pipe-pane` lendo output do pane | `claude_hooks.rs` / `term_monitor` | existe (hoje só lê marcadores OSC) |
| Timer de silêncio (stall) | `gestor/stall.rs:29-83` | pronto |
| Loop runtime que consome eventos e transiciona | `gestor/runtime.rs:313-348` | pronto |
| Feed → store frontend → badge no card | `runtime.rs:128-143`, `src/store/agentStatus.ts` | pronto |

Ou seja: o substrato multi-agente está quase todo no chão. O Tier B já existe.
Falta o sinal de estado heurístico que alimente o loop do mesmo jeito que os
hooks do Claude alimentam.

## O buraco (o que construir)

Um **detector heurístico** que, para tasks Tier B (agente ≠ claude), produz
`working` / `awaiting_input` / `idle` a partir de:

1. **Nome do processo em foreground** no pane → identifica o `agent_kind`
   (codex, copilot, cursor, aider, opencode, …; fallback `unknown`).
2. **Cauda do output do pane** (já piped via `pipe-pane`) → casa contra uma
   tabela pequena de regex:
   - prompt de permissão/confirmação (`(y/n)`, `Allow?`, `Approve`, `Continue?`,
     `[y/N]`, `Press enter`…) → `awaiting_input`
   - output recente que não é prompt → `working`
   - silêncio por N s (reusa o timer do `stall.rs`) → `idle`/`done`

O sinal entra no `runtime.rs` pelo mesmo ponto que `HookEvent`, virando uma
transição FSM. Nada de novo caminho de mutação.

## Mudanças concretas (shortest diff)

1. **`select_adapter()` cabeado de verdade** — `dispatch.rs:203` para de forçar
   `ClaudeAdapter`; escolhe Tier A se o comando é `claude`, Tier B caso
   contrário. (~poucas linhas)
2. **Coluna `agent_kind TEXT` em `agent_task`** — migração nova; default
   `'claude'` para tasks existentes. Uma coluna.
3. **`HeuristicScanner`** — sobre o `pipe-pane` existente, lê a cauda do pane e
   classifica via tabela de regex. ponytail: **uma tabela de regex** com default
   genérico; upgrade para plugins de integração por-agente só se a taxa de
   falso-positivo doer.
4. **Ponte para o runtime** — o scanner emite o mesmo tipo de sinal que
   `parse_hook_line`, consumido em `runtime.rs:313-348`. Reusa stall timer para
   `idle`.
5. **Badge mostra o `agent_kind`** — o store (`agentStatus.ts`) passa a carregar
   `kind` junto de `state`; o card mostra qual agente está rodando.

## Fora de escopo (defer — não é P0)

- **API/socket de auto-orquestração** (agente lead dirige panes) — isso é P1.
- **Comparar N agentes na mesma task lado a lado** — fora do modelo
  um-card-uma-branch. YAGNI.
- **Integrações oficiais por-agente / state reporting semântico** — o herdr tem,
  mas é o upgrade-path da tabela de regex, não o MVP.

## Critério de sucesso

Rodar `codex` (ou `aider`, `cursor`) num card em Doing → badge mostra `working`
em < 2 s; pedir permissão no CLI → badge vira `awaiting_input` + notificação,
sem nenhuma config nem hook. Matar e reabrir o Ade → estado reconstruído do
pane sem duplicar janela. Falso-positivo de `awaiting_input` documentado e
limitado a uma tabela de regex editável.

## Riscos conhecidos

- **Falso-positivo de prompt** — regex de "(y/n)" pode casar com output normal.
  Mitigação: só dispara `awaiting_input` se o prompt está na última linha não
  vazia E o processo está quieto há > X ms (cursor parado no prompt).
- **Identificar foreground process com tmux** — precisa de `tmux display-message
  -p '#{pane_current_command}'` ou ler `/proc`/`ps` da PID do pane. Validar no
  eng review.

---

## Review findings (autoplan — Codex ausente, voz única Claude subagent)

### Correções de viabilidade (Eng) — várias afirmações de DRY estão erradas
- **C1 (crítico):** o scanner `pipe-pane` (`term_monitor.rs:90-181`) é máquina de
  estado OSC/BEL — **descarta todo texto imprimível** (`_ => {}` em `St::Normal`).
  Não existe "cauda do pane" capturada em lugar nenhum. Caminho honesto:
  **polling de `tmux capture-pane -p -S -<n>`** no loop runtime (`tmux.rs:545`
  já tem `capture_pane`). É código novo, não "cabeamento".
- **C2 (crítico):** o scanner emite `evt:terminal-alert` pro frontend; o loop
  runtime taila `events_file` (JSONL). **Não há seam compartilhado** — "mesmo
  ponto que HookEvent" não existe. Ponte: heurística escreve no `events_file`
  por-task (reusa `TailCursor`) OU novo ramo no loop chamando `fsm::transition`.
- **C3 (crítico):** o monitor só é iniciado quando o humano abre o viewer
  (`ipc/terminal.rs:66`); dispatch nunca inicia. Logo a detecção tem que ser
  dirigida pelo loop runtime, não pelo `term_monitor`.
- **H3:** **não existe estado `Idle`**, e `Done` é terminal (só via `Cleanup→Done`).
  A heurística só pode emitir `working`/`awaiting_input`. Silêncio→idle/done sai
  do escopo (git-state + `stall.rs` já são donos disso) e racearia com o stall.
- **H1/H2:** `select_adapter` está morto (dispatch força Claude); `agent_kind`
  precisa passar por migração + `models::AgentTask` + repo + IPC (não "uma coluna").
  `pane_current_command` não existe; `claude` é função shell e `aider` roda via
  `python`/`node` → precisa de tabela kind ciente de interpretador.
- **M1/M3:** regex precisa de strip de ANSI/CSI (spinner/cursor) antes de casar;
  zero testes no plano; risco de ping-pong Working↔Paused sem debounce;
  `max_parallel` default é **1** (não 2).

### Design — "State is never a guess" (DECISÃO-ESPINHA)
Heurística é, por definição, um palpite. Hoje um `awaiting_input` heurístico
renderiza **idêntico** a um confirmado por hook. Fix obrigatório: **confiança como
eixo visual** — ponto sólido (confirmado/Tier A) vs **ponto vazado/anel**
(inferido/Tier B). Shape, não brilho (sobrevive a daltonismo e grayscale).
Pulso calmo (`ade-pulse`) para inferido-atenção, nunca `ade-pulse-attn`.
`agent_kind` só no tooltip/detalhe (e on-face só para não-claude), não vira 3º chip.

### DX — extensibilidade, observabilidade, escape hatch
- "Zero-config" só vale para agentes na tabela; agente novo = recompilar Rust.
  Fix: defaults compilados **+ merge de `~/.ade/agent-patterns.toml`** (`toml` já
  está na árvore). Tabela é dado, não lógica.
- Sem observabilidade: persistir o **padrão que casou** (`reason`) no sinal →
  `events.jsonl` + tooltip. Auto-diagnóstico em vez de bug report.
- Sem escape hatch: bool `heuristic_detection=false` (cai pro Tier B git-state) +
  override manual clicando no badge (novo sinal no caminho único da FSM).
- `unknown` tem que ser valor exibível de primeira classe; documentar vocabulário
  de `agent_kind` em `CONTEXT.md` (regra do AGENTS.md).

### CEO — desafio de premissa (vai pro gate, não auto-decidido)
- **F1 (crítico):** frame errado? Competir no badge-de-N-CLIs é lutar no eixo do
  herdr (onde ele é forte e o Ade fraco). Moat do Ade = loop board+GitHub+Gestor.
  P0 só é estratégico se tornar agentes Tier B **dispatcháveis pelo Gestor** (G6),
  não se só pintar badge.
- **F2 (crítico):** premissa não validada — o usuário (solo, único) **roda mesmo**
  codex/cursor/aider no Ade hoje? Se não, P0 resolve hipótese.
- **F4:** parsear bytes do terminal é exatamente o que o D3 do Gestor **rejeitou**
  como frágil. Contradição interna: frágil pra dirigir FSM = frágil pra notificar.
- **F6:** treadmill de manutenção — solo dev mantendo regex de 15 CLIs perde pra
  integrações oficiais do herdr.

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | Eng | Trocar reuse-do-scanner por polling `capture-pane -p` no loop runtime | Mechanical | P5 explícito | Scanner OSC descarta texto; capture-pane é o caminho honesto e pequeno | Reusar term_monitor (impossível, descarta texto) |
| 2 | Eng | Heurística emite só `working`/`awaiting_input` | Mechanical | P5 | Não há `Idle`; `Done` é terminal e git-state é dono | Inventar Idle/Done state |
| 3 | Eng | `agent_kind` threaded por migração+models+repo+IPC; classificar no dispatch | Mechanical | P1 completude | Coluna sozinha não chega à UI | "uma coluna" |
| 4 | Design | Confiança = ponto sólido vs vazado (shape, não hue/brilho) | Taste→auto | P1+P5 | Honra "state is never a guess" + daltonismo | Render idêntico confirmado/inferido |
| 5 | Design | Pulso calmo para inferido-atenção | Mechanical | P5 | Não gritar urgência sobre um palpite | `ade-pulse-attn` em heurística |
| 6 | DX | Tabela de padrões = defaults + merge `~/.ade/agent-patterns.toml` | Taste→auto | P2+P4 | `toml` já na árvore; dado não lógica; tira gargalo de recompile | Hardcode puro em Rust |
| 7 | DX | Off-switch + override manual via caminho único da FSM | Mechanical | P1 | Palpite sem silenciar/corrigir < nenhum badge | Sem escape hatch |
| 8 | DX | Persistir padrão-que-casou em `events.jsonl` + tooltip | Mechanical | P1 | Observabilidade = auto-diagnóstico | Guess opaco |
