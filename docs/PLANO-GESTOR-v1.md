# Plano — ADE Gestor (orquestração agêntica) — v1

> O modelo gestor que coordena o fluxo completo do ADE: brief → issues → despacho →
> execução por agentes (Claude Code e similares) → verificação → PR → merge → shipped.
> Stack: a existente (Tauri 2, Rust core, React/TS, SQLite, tmux). Data: 2026-06-12.
> Contexto: uso solo, repos próprios. Pré-requisito: v0.1.0 (falta só M6-T5).

**Premissa.** O plano v2 cortou explicitamente "agentes de IA" do escopo com o racional:
*"a orquestração de agentes só tem valor sobre um esqueleto tarefas→terminais→projetos
estável; construir o esqueleto primeiro evita retrabalho quando os agentes entrarem."*
O esqueleto existe e está estável (M0–M6). Este plano é a fase que aquele corte reservou.

**O que já existe e é reaproveitado (não reconstruir):**

| Capacidade | Onde | Papel no Gestor |
|---|---|---|
| Card→Doing abre janela tmux + branch + env `ISSUE_*` | `ipc/card_lifecycle.rs::on_moved_to_doing` | vira o passo "lançar worker" do despacho |
| Injeção de prompt (bracketed paste + CR, strip de ESC) | `App.tsx::injectTaskPrompt` | canal de entrega da tarefa ao worker |
| Presets (`openCommands`, `closeCommands`, `delaySecs`, `injectTask`) | `store/settings.ts` | base do WorkerAdapter (como lançar cada ferramenta) |
| `tmux::send_keys` para janela sem viewer aberto | `tmux.rs` (usado em `on_moved_to_done`) | nudge/feedback programático ao worker |
| Outbox + sync bidirecional + decision table | `sync/`, tabela `outbox` | único caminho de escrita de issues (criação em lote do gestor) |
| GitHub client próprio, wiremock-testável, token no Keychain | `gh/client.rs` | ganha endpoints de PR/checks |
| `git2` (branch, status, slugify) | `gitlocal.rs` | ganha worktree + push autenticado |
| Notificações + workers tokio por workspace | `notify.rs`, sync worker | padrão do runtime do gestor |
| Skills (`.claude/skills` scan) + sidebar fechável | `ipc/skills.rs`, `SkillsSidebar.tsx` | precedente de UI para o Painel do Gestor |

---

**Decisões da v1:**

| # | Decisão | Racional / alternativa rejeitada |
|---|---|---|
| D1 | O gestor é uma **máquina de estados determinística no core Rust**; o LLM entra como **job tipado e pontual** (planejar, revisar, diagnosticar, redigir) | Um "agente chat" de longa duração dono do loop viola *state is never a guess*, é inauditável e caro. LLM nas bordas (julgamento), FSM no centro (controle). |
| D2 | Provider do gestor v1 = **Claude Code headless (`claude -p --output-format json`)** atrás do trait `GestorProvider` | Zero superfície nova de auth (usa o login existente), o job de planejamento precisa **ler o repo** (ganha as tools de graça), custo/turnos vêm no JSON de resultado. API Anthropic direta = provider futuro (exigiria API key e billing separados). |
| D3 | Workers continuam **interativos em tmux** (identidade do produto), instrumentados por **hooks do Claude Code → JSONL por task → tail no core** | Parsear bytes do terminal é frágil; hooks (`Stop`, `Notification`, `SessionEnd`) são o sinal de ciclo de vida confiável. Arquivo JSONL: sem servidor HTTP, sem dep nova, sobrevive a restart do ADE. Headless workers = pós-v1. |
| D4 | Paralelismo via **`git worktree` por task** (git2 já suporta); modo sequencial sem worktree continua existindo (`max_parallel=1`, fluxo atual) | Dois cards em Doing hoje disputam o checkout do mesmo diretório. Worktree isola; o custo (deps por worktree) é mitigado por `worktree_setup_commands` e pelo modo sequencial. |
| D5 | PRs/checks entram no **GitHub client próprio** (REST); **push é feito pelo ADE** (git2 + token do Keychain), nunca pelo worker | Consistente com o client existente e testável com wiremock; sem dependência do `gh` CLI logado. Worker commita, ADE publica: o privilégio de rede fica no orquestrador, não no agente. |
| D6 | **Autonomia em 4 níveis por workspace** (L0 off · L1 copiloto · L2 supervisionado · L3 autônomo), default **L2** | O dial é o contrato de confiança do produto. Gates humanos (aprovar plano de issues, aprovar merge) são o default; L3 é opt-in explícito com guardrails obrigatórios. |
| D7 | As **5 colunas fixas permanecem**; o estado agêntico é uma camada no card (`agent_status` + badge), não colunas novas | Mantém D4 do plano v2 e o mapeamento de labels do sync. A coluna diz *onde a tarefa está no fluxo*; o badge diz *o que o agente está fazendo*. |
| D8 | **Toda ação do gestor é um `agent_event` auditável** com feed na UI; jobs LLM gravam input, output, custo e duração | *Nada acontece em silêncio* é o que torna L2/L3 confiáveis. O feed é a caixa-preta do voo. |
| D9 | Texto de issue continua **input não-confiável** (CONTRACTS §9); worker não recebe o token GitHub; merge/push sempre mediados pelo ADE | O gestor amplifica o risco de prompt injection (issue → prompt → execução). Sanitização existente + worktree + allowedTools por nível + publicação centralizada limitam o raio de dano. |
| D10 | Criação de issues do gestor **reusa o outbox**; operações de PR têm retry próprio no runner de jobs (volume baixo, gestor-iniciado) | Outbox já resolve ordenação/retry/revert para issues. Esticá-lo para PRs agora adicionaria estados sem ganho. |

---

## 1. Visão & escopo

### O loop completo

```
 brief do usuário
      │
      ▼
 [PLANEJAR]  gestor_job plan_issues (claude -p lê o repo) → proposals
      │            aprovação humana (L1/L2) ─ edita/rejeita/aprova
      ▼
 [BACKLOG]   issues criadas via outbox → cards (Backlog, ready, deps)
      │
      ▼
 [DESPACHAR] scheduler: card ready + slot livre → worktree + branch
      │            + janela tmux + worker (preset/adapter) + prompt injetado
      ▼
 [EXECUTAR]  worker interativo; hooks → events.jsonl → FSM da task
      │            awaiting_input / stalled → notificação (humano no loop)
      ▼
 [VERIFICAR] tree clean + commits → gates (build/test) → review_diff (LLM)
      │            reprovado → feedback reinjetado no worker (retry ≤ N)
      ▼
 [PUBLICAR]  ADE push (git2+token) → PR criado → card→PR → CI polling
      │            L2: humano clica merge · L3: auto-merge com CI verde
      ▼
 [SHIPPED]   merge → issue fechada → card→Done → worktree limpo
                   release notes (job) quando solicitado/milestone
```

### Dentro da v1 do gestor

1. **Planejamento**: brief → proposals de issues fundadas no código → aprovação em lote → criação (GitHub ou local).
2. **Despacho automático** com limite de paralelismo, dependências entre cards e worktrees.
3. **Instrumentação do worker** (Claude Code Tier A): estado vivo no card, needs-input, detecção de travamento.
4. **Verificação**: gates configuráveis por workspace + review de diff por LLM + ciclo de retry com feedback.
5. **PR & merge**: push, criação de PR, CI polling, merge supervisionado (L2) ou automático (L3), fila de merge serializada.
6. **Auditoria**: feed de atividade completo com custo por job/task.
7. **Autonomia L0–L3** + guardrails (budget, allowedTools, max attempts).
8. **Tier B mínimo** para outras ferramentas (aider, codex, …): lançar + injetar via preset, ciclo de vida degradado por git-state/silêncio.

### Fora (a arquitetura deixa espaço)

Chat conversacional com o gestor (o painel + brief cobre a v1) · workers headless sem
terminal · GitHub Projects v2 · versionamento/release automation completos (a v1 para em
release notes + tag opcional) · múltiplos repos por task · memória de longo prazo do
gestor · grooming contínuo do backlog por conta própria · integração profunda (hooks) com
ferramentas não-Claude.

---

## 2. Arquitetura

```
┌────────────────────────────────────────────────────────────────────┐
│ Frontend (React/TS)                                                │
│  Painel Gestor (feed, aprovações, brief) · badges agent_status     │
│  Board/Terminais existentes (inalterados no essencial)             │
└────────────▲─────────────────────────────────────┬─────────────────┘
             │ evt:gestor_job · evt:agent_task     │ invoke (gestor_*,
             │ evt:feed · evt:board (existente)    ▼  task_*, pr_merge…)
┌────────────┴────────────────────────────────────────────────────────┐
│ Core (Rust)                                                         │
│  gestor/                                                            │
│   ├─ runtime.rs    1 loop tokio por workspace (como o sync worker): │
│   │                tick do scheduler + tail dos events.jsonl        │
│   ├─ fsm.rs        máquina de estados de agent_task (única fonte    │
│   │                de transição; toda transição grava agent_event)  │
│   ├─ jobs.rs       fila de gestor_job (plan/review/diagnose/notes)  │
│   ├─ provider.rs   trait GestorProvider · impl ClaudeCli (claude -p)│
│   ├─ worker.rs     trait WorkerAdapter · Tier A Claude / Tier B     │
│   └─ prompts/      templates editáveis (app_data_dir/prompts/*.md)  │
│  gh/client.rs      + create_pr/get_pr/merge_pr/list_checks/         │
│                      update_branch                                  │
│  gitlocal.rs       + worktree_add/remove · push autenticado (git2   │
│                      credentials callback, token nunca em argv)     │
│  [existentes] tmux · pty · sync/outbox · notify · settings          │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.1 LLM nas bordas, FSM no centro

O loop de controle (quando despachar, quando verificar, quando publicar) é código
determinístico sobre SQLite — testável sem rede e sem modelo. O LLM resolve apenas o que
exige julgamento, em **4 jobs tipados**:

| Job | Entrada | Saída (JSON validado por serde) | Quando roda |
|---|---|---|---|
| `plan_issues` | brief + contexto do repo (claude -p com cwd no repo, tools read-only) | lista de proposals `{title, body, labels, depends_on, acceptance[]}` | usuário envia brief |
| `review_diff` | diff da branch + issue + acceptance | `{verdict: approve\|needs_fixes, feedback}` | task em `verifying` com gates verdes |
| `diagnose_stall` | tail do transcript + git status do worktree | `{action: nudge\|escalate, text}` | silêncio > `stall_timeout` |
| `release_notes` | PRs merged desde a última tag | markdown | sob demanda / fim de milestone |

Regras dos jobs: saída fora do schema → 1 retry com o erro anexado → falhou, vira
notificação (nunca trava o loop); todo job grava `input_json`, `output_json`, `cost_usd`
(quando a auth é assinatura o CLI pode reportar 0 — registrar também `num_turns` e
`duration_ms`), e um `agent_event` de início/fim.

### 2.2 GestorProvider (D2)

```rust
trait GestorProvider {
    async fn run_job(&self, kind: JobKind, prompt: String, cwd: &Path,
                     allowed_tools: &[&str]) -> Result<JobResult, AdeError>;
    fn probe(&self) -> Result<ProviderInfo, AdeError>; // versão, auth ok
}
```

`ClaudeCli` v1: `claude -p <prompt> --output-format json --allowedTools <lista>`
(planejamento/review rodam **read-only**: `Read,Glob,Grep` + `Bash(git diff:*)` no review).
Probe no boot igual ao check do tmux ≥ 3.2: `claude --version` + versão mínima pinada no
CONTRACTS; ausência/versão velha → notificação `GESTOR_PROVIDER_MISSING`, gestor
desabilitado, resto do app intacto. Invocação por argv (`Command::arg`), nunca string de
shell — o brief do usuário e texto de issue passam como argumento.

### 2.3 Instrumentação do worker (D3)

No despacho, o ADE escreve no worktree um `.claude/settings.local.json` (escopo por
task; worktree é checkout novo, sem colisão; não versionado) com hooks `Stop`,
`Notification` e `SessionEnd` cujo comando é um append do stdin (o payload JSON do hook)
em `app_data_dir/tasks/<task_id>/events.jsonl` — caminho absoluto embutido no comando,
sem interpolação de input não-confiável. O runtime faz tail por polling (1 s, mtime) —
sem dep nova, e o arquivo sobrevive a restart do ADE e a relaunch manual do `claude`
naquela janela.

**Tabela de decisão no `Stop`** (o hook dispara ao fim de cada turno — i.e. "worker parou
e espera input"):

| Sinais (no worktree) | Transição |
|---|---|
| marker `ADE_TASK_DONE` na última mensagem do transcript **e** tree clean + commits à frente da base | → `verifying` |
| sem marker, mas tree clean + commits à frente | → `verifying` (worker esqueceu o protocolo; review decide) |
| tree dirty ou sem commits | permanece `working`; silêncio > `stall_timeout` → `diagnose_stall` |
| `Notification` (permissão/idle) | → `awaiting_input` (badge warning + notificação; humano responde no próprio terminal) |

O prompt injetado instrui o protocolo: *commite ao concluir; **não** faça push; termine a
resposta final com a linha `ADE_TASK_DONE`*. Injeção reusa o mecanismo existente
(bracketed paste + strip de ESC); feedback de retry e nudges entram por
`tmux::send_keys` na janela (funciona sem viewer aberto).

### 2.4 WorkerAdapter (D3/Tier B)

```rust
trait WorkerAdapter {
    fn launch_commands(&self, task: &TaskCtx) -> Vec<String>; // ex.: ["claude --permission-mode acceptEdits"]
    fn instrumentation(&self) -> Tier;  // A: hooks · B: nenhum
    fn inject(&self, prompt: &str) -> InjectSpec; // bracketed paste (default)
}
```

- **Tier A — Claude Code**: hooks + transcript + flags de permissão por nível de autonomia.
- **Tier B — genérico** (aider, codex, shell): lança via comandos do adapter (seed = preset
  default do workspace), injeta o prompt, e infere ciclo de vida por **git-state polling**
  (commits/clean) + silêncio do processo. Sem `awaiting_input` confiável — documentado.

Presets continuam sendo a superfície humana ("abrir terminal com…"); o adapter é a
superfície do gestor. O adapter Claude compõe flags por nível (L1/L2:
`--permission-mode acceptEdits` + `allowedTools` do workspace; L3: ver §4).

---

## 3. Ciclo de vida da task

`agent_task.state` (FSM única; toda transição = `agent_event` + `evt:agent_task`):

```
queued → preparing → working ⇄ awaiting_input
                      │  ▲
                      │  └─ needs_fixes (feedback reinjetado, attempt+1 ≤ max_attempts)
                      ▼
                  verifying (gates) → reviewing (LLM) → pushing → pr_open → ci_wait
                                                                      │
                      failed ◄── qualquer estágio (motivo gravado)    ▼
                      aborted ◄── task_abort                 ready_to_merge → merging
                                                                      ▼
                                                            merged → cleanup → done
```

| Fase | Coluna do card | Quem age |
|---|---|---|
| `queued`…`reviewing`, `needs_fixes` | Doing | gestor + worker |
| `awaiting_input` / `stalled` | Doing (badge warning + notificação; **não** troca coluna por estado transitório) | humano |
| `pr_open`…`ready_to_merge` | PR | gestor (CI poll) / humano (merge L2) |
| `merged`…`done` | Done | gestor (cleanup, close issue via outbox) |
| `failed` / `aborted` | Paused | humano (retry/abort/assumir manualmente) |

Detalhes que valem contrato:

- **Despacho** (`queued→preparing→working`): worktree `app_data_dir/worktrees/<slug>/<branch>`
  + branch a partir de `base_branch` (auto-detectada, configurável) + `worktree_setup_commands`
  (ex.: `npm install`) + janela tmux com cwd no worktree (reusa `on_moved_to_doing`,
  generalizado para aceitar cwd ≠ root) + settings de hooks + injeção do prompt enriquecido
  (issue + acceptance + protocolo + gates que vão rodar). O movimento de card do gestor
  equivale ao "drag do usuário" para fins do trigger D2 do plano v2; a regra "reconciliação
  remota nunca abre terminal" permanece.
- **Gates**: lista de comandos por workspace (`gate_commands`, ex.: `npm run build`,
  `npm test`), executados no worktree com timeout; saída anexada ao feedback quando falham.
  Gate vermelho → `needs_fixes` sem gastar LLM.
- **Fila de merge serializada**: 1 merge por vez por workspace; antes do merge,
  `update_branch` (API) ou rebase local; conflito → `needs_fixes` com prompt de resolução
  reinjetado no worker da task.
- **Retomada após restart do app**: `agent_task` é persistente; no boot o runtime
  reconcilia — janela tmux viva? events.jsonl tem eventos novos? task em `pushing`/`merging`
  re-verifica idempotente (branch no remoto? PR existe? merged?) antes de repetir.
- **CI**: polling de check-runs do head SHA (intervalo = `sync_interval_secs`); workspace
  sem checks → `require_ci=false` trata como verde após grace period.

---

## 4. Autonomia & guardrails

| Nível | O gestor pode | Gates humanos | Permissões do worker (Claude) |
|---|---|---|---|
| **L0** off | nada (ADE de hoje) | — | — |
| **L1** copiloto | rodar jobs sob demanda (plan, review, notes); **nunca** move card nem abre terminal | tudo | — (workers são lançados manualmente como hoje) |
| **L2** supervisionado *(default)* | despachar, mover cards, verificar, abrir PR | aprovar proposals · aprovar merge | `--permission-mode acceptEdits` + `allowedTools` do workspace |
| **L3** autônomo | tudo de L2 + merge automático (CI verde + review approve) | aprovar proposals (configurável até isso) | opcional `--dangerously-skip-permissions`, **só** com worktree ativo + opt-in explícito com aviso |

Guardrails transversais (workspace settings, todos com default seguro):
`max_parallel_workers` (2) · `max_attempts` por task (3) · `stall_timeout` (10 min) ·
`budget_daily` (jobs/dia e, quando reportado, USD; estourou → gestor pausa + notificação
`GESTOR_BUDGET_EXCEEDED`) · branch base protegida (worker nunca recebe token; push/merge
só pelo core, D9) · sanitização §9 em todo texto que entra em terminal.

---

## 5. Modelo de dados (migrations append-only, 0006+)

**`0006_gestor_core.sql`**

```sql
CREATE TABLE gestor_job (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('plan_issues','review_diff','diagnose_stall','release_notes')),
  state TEXT NOT NULL CHECK (state IN ('queued','running','done','failed')),
  input_json TEXT NOT NULL, output_json TEXT, error TEXT,
  cost_usd REAL, num_turns INTEGER, duration_ms INTEGER,
  created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE issue_proposal (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES gestor_job(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL, ord INTEGER NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, labels_json TEXT, depends_on_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected','created')),
  card_id TEXT
);
CREATE TABLE agent_task (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, card_id TEXT NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, max_attempts INTEGER NOT NULL,
  branch TEXT, worktree_path TEXT, window_id TEXT, events_file TEXT,
  fail_reason TEXT, last_event_at TEXT, started_at TEXT, finished_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE agent_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL,
  task_id TEXT, job_id TEXT, ts TEXT NOT NULL,
  kind TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'info', payload_json TEXT
);
CREATE INDEX idx_event_ws_ts ON agent_event(workspace_id, ts DESC);
CREATE INDEX idx_task_ws_state ON agent_task(workspace_id, state);
```

**`0007_card_agent.sql`** — `ALTER TABLE card ADD COLUMN`: `agent_status TEXT`,
`ready INTEGER NOT NULL DEFAULT 0`, `depends_on_json TEXT`, `pr_number INTEGER`,
`pr_url TEXT`, `pr_state TEXT`, `ci_status TEXT`. (Deps vivem no ADE e são renderizadas
no corpo da issue como `Depends on #N` — sobrevivem ao sync sem schema remoto.)

**`workspace_setting`** (KV livre, sem migration): `gestor_enabled`, `autonomy_level`,
`max_parallel_workers`, `worktree_mode`, `worktree_setup_commands`, `gate_commands`,
`allowed_tools_json`, `budget_daily_jobs`, `budget_daily_usd`, `stall_timeout_secs`,
`max_attempts`, `base_branch`, `require_ci`, `worker_adapter`, `gestor_provider`.

---

## 6. Superfície IPC & eventos (novos)

| Comando | Faz |
|---|---|
| `gestor_plan(workspace_id, brief)` | enfileira job `plan_issues`; retorna `job_id` |
| `gestor_job_get(job_id)` / `gestor_jobs_list(workspace_id)` | estado/resultado de jobs |
| `proposal_list(job_id)` · `proposal_update(id, patch)` · `proposal_approve(job_id, ids[])` | revisão e criação em lote (cards locais ou issues via outbox) |
| `task_list(workspace_id)` · `task_get(task_id)` | tasks + estado |
| `task_retry(task_id)` · `task_abort(task_id)` · `task_nudge(task_id, text)` | controle manual |
| `pr_merge(card_id)` | gate humano do L2 (executa a fila de merge) |
| `feed_list(workspace_id, before_ts?, limit)` | página do feed |
| `gestor_release_notes(workspace_id)` | job `release_notes` |
| `dispatch_tick(workspace_id)` | força um tick do scheduler (debug/QA) |

Eventos: `evt:gestor_job {job}` · `evt:agent_task {task}` · `evt:feed {event}`.
Mutações de board continuam chegando por `evt:board`; notificações por `evt:notify`.
Config entra pelos comandos existentes (`setting_set`/`workspace_setting_value`).
Erros novos: `GESTOR_PROVIDER_MISSING`, `GESTOR_BUDGET_EXCEEDED`, `WORKTREE_FAILED`,
`GATES_FAILED`, `PR_CREATE_FAILED`, `MERGE_CONFLICT`, `TASK_STALLED`.

---

## 7. UI (PRODUCT.md/DESIGN.md valem integralmente)

- **Painel Gestor** — sidebar direita fechável (precedente: SkillsSidebar). Três blocos:
  (1) status: nível de autonomia, workers `2/3`, gasto do dia, em mono;
  (2) **aprovações pendentes**: proposals em lote (editar inline, checkbox, "Criar N issues")
  e merges aguardando (L2) — um clique;
  (3) **feed**: `agent_event` stream, timestamp mono, kind + resumo de uma linha,
  expandível para payload; custo por job na própria linha.
- **Brief composer** no topo do painel: textarea + "Planejar" → `gestor_plan`.
- **Badge `agent_status` no card** — redundante (cor + ícone + label, regra do
  SyncIndicator): `working` = Data Cyan (é exatamente o "live/in-progress data" sancionado),
  `awaiting_input`/`stalled` = warning, `review`/`pr` = info, `failed` = error,
  `done` = success. Magenta segue reservado a ação/seleção.
- **Settings › Gestor**: dial de autonomia (L0–L3, com texto do que cada nível pode),
  limites, gates, allowedTools, budget. L3 exige confirmação explícita.
- **Notification center**: aprovações pendentes, `TASK_STALLED`, budget — já existe, só
  recebe os novos kinds.

---

## 8. Roadmap

Pré-requisito: **M6-T5** (QA final + tag v0.1.0) antes do G2 — G0/G1 não tocam terminal e
podem andar em paralelo ao QA. Regras de trabalho do AGENTS.md valem (1 task = 1 commit,
gates verdes, CONTRACTS vence).

| Mil. | Entrega | Tasks principais | DoD (mensurável) |
|---|---|---|---|
| **G0 — Fundações** | esquema + runtime vazio + feed | migrations 0006/0007 · módulo `gestor/` (runtime por workspace, FSM esqueleto) · `GestorProvider` trait + probe do `claude` no boot · settings novos + Settings›Gestor (só L0/L1) · `agent_event` + `evt:feed` + painel com feed read-only | gates verdes; com `claude` ausente o app degrada com notificação; eventos sintéticos aparecem no feed em <1 s |
| **G1 — Planejar (L1)** | brief → issues | job `plan_issues` (read-only tools, schema serde, 1 retry) · templates em `app_data_dir/prompts/` · `issue_proposal` + UI de revisão/edição/aprovação · criação via outbox (label `ade:gestor`) · custo no feed | brief de 3 linhas neste repo gera ≥5 proposals citando arquivos reais; aprovar 3 cria 3 issues no GitHub + cards no Backlog; rejeitadas não criam nada; tudo no feed com custo |
| **G2 — Worker instrumentado** | estado vivo de 1 task | hooks injection (settings.local.json no cwd da janela) · tail JSONL · FSM `queued→…→verifying` · tabela de decisão do Stop · badge no card · `awaiting_input`/stall + `diagnose_stall` · `task_retry`/`task_abort`/`task_nudge` · retomada pós-restart | mover card p/ Doing → badge `working` em <2 s do lançamento; pedir permissão no worker → badge warning + notificação; matar o ADE e reabrir → estado correto sem duplicar janela; 10 min de silêncio → nudge ou escalada registrados |
| **G3 — Verificar & publicar** | Doing→PR→merge→Done de 1 task | `gate_commands` runner (timeout, log no feed) · `review_diff` · `needs_fixes` com feedback reinjetado (≤ `max_attempts`) · push git2 autenticado · PR endpoints no `gh/client.rs` (wiremock) · CI polling · `pr_merge` UI · close issue + Done + cleanup | task feliz: do `ADE_TASK_DONE` ao card em PR sem toque; gate vermelho reinjeta a falha no worker; merge pelo painel move a Done, fecha a issue e remove a branch; tudo idempotente sob restart |
| **G4 — Despacho & paralelismo (L2)** | scheduler + worktrees | `ready`/deps no card e na UI · scheduler tick (prioridade = ordem do Backlog, deps satisfeitas, slot livre) · `git worktree` add/remove + setup commands · `max_parallel` · fila de merge serializada + update-branch/rebase · L2 ponta-a-ponta | aprovar 3 issues independentes → 3 workers em worktrees distintos sem conflito de checkout; com `max_parallel=2` a 3ª espera; 3 PRs mergeados em sequência sem conflito de fila; modo sequencial (worktree off) preserva o fluxo atual |
| **G5 — L3 + shipping** | autonomia plena | auto-merge (CI verde + review approve) · enforcement de budget · `release_notes` + tag opcional · hardening de permissões L3 · teste de aceite ponta-a-ponta | num repo de teste: brief → N issues → merged → release notes **sem teclado**, com cada decisão visível no feed; estourar budget pausa o gestor comprovadamente |
| **G6 — Tier B + polimento** | outras ferramentas | `WorkerAdapter` genérico sobre presets · ciclo de vida por git-state/silêncio · docs (README + guia de autonomia) · QA final | uma ferramenta não-Claude completa uma task até PR no modo degradado; documentação cobre níveis, custos e riscos |

Riscos por milestone seguem o padrão do plano v2: o de maior incerteza técnica é o G2
(semântica dos hooks/transcript) — por isso vem antes de qualquer automação de despacho,
no espírito do "spike de sync no M2".

---

## 9. Riscos & mitigações

| Risco | Mitigação |
|---|---|
| Prompt injection (issue → prompt → execução autônoma) | sanitizador §9 · tools read-only nos jobs do gestor · allowedTools no worker · worker sem token/sem push · merge sempre mediado · L3 opt-in |
| Detecção de conclusão errada (Stop a cada turno) | tabela de decisão §2.3 (marker + git-state) · gates + review antes de publicar · `max_attempts` |
| Custo descontrolado | budget diário (jobs e USD quando reportado) · attempts limitados · custo por job visível no feed |
| Worktree caro/quebrado (deps, submodules) | `worktree_setup_commands` · modo sequencial sem worktree · `WORKTREE_FAILED` → Paused, nunca silêncio |
| Drift de versão do Claude CLI (flags/hooks) | probe no boot com mínimo pinado no CONTRACTS · Tier B (git-state) como fallback até para o Claude |
| Merges paralelos conflitantes | fila serializada + update-branch antes do merge · conflito → `needs_fixes` no worker da task |
| Gestor × sync remoto | moves do gestor usam `card_move` existente (outbox/labels) · "reconciliação remota nunca abre terminal" inalterada |
| Loop do gestor degradar a UI | tudo em spawn_blocking/worker tokio (padrão já usado) · FSM só faz I/O fora da thread de IPC |

---

## 10. Dependências

**Nenhum crate novo obrigatório** (tokio, git2, reqwest, sqlx, serde cobrem tudo; tail por
polling dispensa notify). Binários externos: `tmux ≥ 3.2` (já exigido) e `claude` CLI
(versão mínima a pinar no CONTRACTS; probe no boot, ausência degrada para L0/Tier B).
`gh` CLI **não** é dependência (D5).

## 11. Critérios de aceite da v1 (o "pronto" do projeto)

1. Brief → issues aprovadas → cards prontos em < 5 min de interação.
2. Uma task feliz vai de Backlog a PR **sem** intervenção; merge em 1 clique (L2).
3. Em L3, repo de teste completa brief→merge→notes sem teclado.
4. Zero ação do gestor fora do feed (auditoria total); custo por task consultável.
5. Matar e reabrir o app em qualquer fase não duplica janela, push nem PR.
6. Com gestor desligado (L0), o ADE de hoje permanece byte-a-byte o mesmo fluxo.

## 12. Questões em aberto (não bloqueiam G0/G1)

1. Nome na UI: "Gestor" vs "Manager" vs "Pilot"?
2. Worktrees em `app_data_dir` (proposto) ou irmão do repo (`<root>-worktrees/`)?
3. L3 deve poder pular também a aprovação de proposals, ou esse gate é inegociável?
4. Qual segunda ferramenta priorizar no Tier B (aider? codex? opencode?)?
5. Defaults de budget: 50 jobs/dia? USD quando a auth for API?

## 13. Próximo passo

Validar D1–D10 e as questões §12 → explodir este plano no padrão da casa:
`plan/00-CONTRACTS-GESTOR.md` (tipos, schema final, IPC, prompts, decision tables) +
`plan/G0.md … G6.md` + `PROGRESS.md`, e seguir o AGENTS.md task a task.
