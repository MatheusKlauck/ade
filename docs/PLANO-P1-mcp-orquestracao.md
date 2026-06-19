# P1 — MCP de orquestração: agente lead dirige o Gestor

## Contexto e premissa

O herdr deixa um **agente lead dirigir a orquestração sozinho** via socket Unix
(`herdr pane split-right`, `herdr agent read`, `herdr agent wait`). O Ade tem o
**motor** de orquestração inteiro (Gestor FSM, dispatch, autonomia, feed, merge),
maduro e testado — mas é **dirigido pelo app** (loop runtime / drag no board),
não chamável pelo agente.

**Premissa:** um agente lead (Claude Code) deveria poder, de dentro de uma sessão,
planejar→enfileirar→despachar sub-tasks (plan/code/review/QA), ler o estado de cada
uma e esperar transições — sem o humano arrastar card. Isso aproveita o moat do Ade
(loop board+GitHub+Gestor) em vez de competir no eixo de badge do herdr.

## Decisão de interface: MCP **stdio**, não HTTP

O usuário escolheu MCP. O caminho lazy-correto é **stdio**, não um servidor HTTP:

- Este repo **já roda gbrain como local-stdio** (CLAUDE.md: `Mode: local-stdio`).
  Precedente direto. O Claude Code registra MCP stdio trivialmente.
- Stdio = **sem crate HTTP novo** (não há axum/hyper/tower no `Cargo.toml`), **sem
  porta, sem bearer token, sem supervisor** (o Claude Code gerencia o ciclo de vida
  do processo filho). Toda a camada que o map de substrato chamou de "net-new
  pesado" some.
- HTTP fica como **upgrade-path** documentado: só se precisar de lead remoto /
  multi-máquina. ponytail: stdio agora, HTTP quando throughput remoto exigir.

## Decisão de arquitetura: enfileirar, não re-despachar

O `ade mcp-serve` **não re-implementa dispatch**. Ele:
1. **Escreve** no mesmo SQLite do app (enfileira uma task `queued` via
   `enqueue_card`; bump de `autonomy_level` p/ ≥L2 quando o lead quer despacho,
   espelhando `gestor_build_feature` em `ipc/gestor.rs:63-82`).
2. **Lê** estado e feed (`agent_tasks_for_workspace`, `agent_task_by_id`,
   `agent_events_after`).

O **loop runtime do app** (já existente, `start_runtime`) faz o dispatch real
(worktree + tmux + worker) e dirige a FSM. O MCP server é um **DB-writer + poller
fino**. Sem segundo caminho de mutação, sem duplicar `dispatch_task`.

> Pré-condição: o app Ade precisa estar rodando (é ele que despacha e taila). Com
> o app fechado, o MCP enfileira mas nada roda — documentar e retornar estado
> `queued` honesto, não fingir dispatch.

## O que JÁ existe (DRY — não reconstruir)

| Op | Função | Arquivo | Reuso |
|----|--------|---------|-------|
| Enfileirar card | `enqueue_card` | `gestor/dispatch.rs:95-131` | chamar direto (idempotente) |
| Planejar brief→proposals | `plan_issues` | `gestor/plan.rs:62+` | chamar direto (argv, não shell — D9) |
| Aprovar proposals→cards | `approve_proposals` | `ipc/gestor.rs:41-47` | chamar direto |
| Listar tasks | `agent_tasks_for_workspace` | `repo.rs:187-200` | read |
| Get task | `agent_task_by_id` | `repo.rs:149-159` | read |
| Feed após id | `agent_events_after` | `repo.rs:242-259` | base do wait_for_state |
| FSM + estados | `transition`, `TaskState` | `gestor/fsm.rs:21-224` | só leitura pelo MCP |
| Gate de autonomia | `autonomy::load`, `can_dispatch` | `gestor/autonomy.rs:12-80` | gate do dispatch |
| Merge/CI | `merge_task`, `process_ci` | `gestor/merge.rs:51-130` | tool L2+/L3 |

## Tools MCP (mínimo viável)

`plan`, `approve`, `enqueue`, `list_tasks`, `get_task`, `list_feed`,
`wait_for_state`. (`merge` opcional, gated L2+.) Cada tool: `workspace_id`
obrigatório, params específicos, erro JSON-RPC (não exceção).

`wait_for_state(task_id, target, timeout)` = loop sobre `agent_events_after`
filtrando `kind=="task_transition"` com `payload.to==target`, com timeout. Não há
canal de broadcast externo (o `tokio::Notify` é interno ao app) — polling é o
contrato, intervalo ~1-2 s.

## Segurança

- **stdio local = sem superfície de rede.** Mesmo usuário, mesmo processo-pai. Sem
  token. (Esse é metade do motivo de escolher stdio.)
- **Dispatch é superfície de execução de código.** O gate é a autonomia: o MCP só
  consegue *fazer rodar* uma task se a workspace está ≥L2 (ou se o lead pedir o
  bump explicitamente — decisão a confirmar no review). L0/L1 → enfileira mas não
  despacha; retorna `queued`.
- **Worktree isola** o worker; sem token de GitHub no worker (D9). MCP herda esse
  modelo, não o afrouxa.
- Brief/prompt chega ao modelo por **argv, nunca shell** (D9) — preservar.

## Fora de escopo (defer)

- **Servidor HTTP / lead remoto / bearer auth** — upgrade-path, não MVP.
- **Dirigir panes diretamente** (`split-right` estilo herdr) — o modelo do Ade é
  card→task→worktree, não pane livre. O lead orquestra *tasks*, não *panes*.
- **Comparar N agentes na mesma task** — fora do modelo um-card-uma-branch.
- **State vivo de agente não-Claude** (P0, pulado).

## Critério de sucesso

De uma sessão Claude Code com `ade mcp-serve` registrado: `plan("add X")` →
`approve` → `enqueue` → app despacha → `wait_for_state(id, "awaiting_input")`
retorna quando o sub-agente pede input; `wait_for_state(id, "pr_open")` retorna
quando abre PR. Tudo sem o humano tocar o board. App fechado → tools de leitura
funcionam, dispatch retorna `queued` com mensagem honesta.

## Riscos conhecidos

- **Concorrência SQLite** app ↔ mcp-serve: precisa de WAL e writes pequenos
  (enqueue = 1 insert). Validar no eng review se o pool do app está em WAL e se um
  segundo processo escrevendo conflita (lição do lock single-writer do gbrain/PGLite).
- **App precisa estar rodando** pra despachar — descoberta/erro claro se não está.
- **Crate de MCP server em Rust**: usar SDK oficial (`rmcp`) ou hand-roll JSON-RPC
  sobre stdio (pequeno). AGENTS.md restringe deps novas — pesar no review.
- **`wait_for_state` longo** num stdio MCP: timeout obrigatório; não segurar a
  sessão do lead pendurada.

---

## Review findings (autoplan — Codex ausente, voz única Claude subagent)

UI scope ~nulo (única peça: tag de task spawned-by-MCP no board → coberto por
DX#6e); Design dobrado no DX. CEO + Eng + DX independentes convergiram.

### DOIS problemas de fundo (vão pro gate, não auto-decididos)

**A) Premissa contestada (CEO, crítico).**
- O `gestor-flow`/PLANO §14 reframou: *o board É a FSM, uma só superfície de ação*.
  E o **D1 proíbe** explicitamente um agente de chat de longa duração dono do loop
  (inauditável, caro). P1 reintroduz exatamente isso um nível acima — terceiro
  operador + caminho de controle paralelo ao board.
- Usuário errado? PRODUCT.md = solo dev arrastando card. "Lead agent despachando
  sub-agentes sem tocar o board" é gestão de frota — e o L3 do board já entrega
  "brief→merge sem teclado". Dirigir de dentro de um chat = **mais passos** que
  arrastar um card na superfície glanceable que foi feita pra isso.
- Validação barata antes de construir: um **CLI fino** sobre a IPC existente +
  dogfood de uma semana. Se o autor não pegar, MCP morre.

**B) Arquitetura quebrada como escrita (Eng+DX, crítico — e o precedente está invertido).**
- **O "precedente gbrain stdio" é FALSO neste repo.** MEMORY.md/`wiring.rs`: o gbrain
  é **HTTP** justamente porque o lock single-writer forçou *o app a dono de um
  `gbrain serve --http` compartilhado*, com token. O precedente real é o **oposto**
  do que o plano citou: app dono do writer, processo-separado-stdio foi o modo de
  falha. (Bom: o SQLite do app está em **WAL** (`db.rs:24`) → multi-processo de
  *leitura* é seguro, diferente do PGLite. É o *write* duplo que é o risco.)
- **O self-bump de autonomia é gate falso E mecanicamente morto.** (DX#6) agente que
  sobe o próprio privilégio p/ L2 = sem gate. (Eng#3) e mesmo escrevendo L2 no DB de
  um processo separado, **o loop do app nunca observa** — `spawn_gestor_for_workspace`
  só dispara dentro do `setting_set` IPC (`settings.rs:71-83`); row solta = beco sem
  saída silencioso (task fica `queued` pra sempre). O critério de sucesso headline
  falha calado em qualquer workspace que não estava L2+ no boot do app.
- **`ade mcp-serve` não tem casa:** não existe CLI hoje (`main.rs` = 5 linhas → Tauri).
  Ade é `.app`, não binário no `$PATH`. Como o Claude Code spawna isso? Indefinido (Eng#5).
- **Sem liveness:** o runtime não grava heartbeat/pid; um processo externo **não tem
  como** saber se o app está rodando → o "erro honesto app-not-running" prometido é
  **não-implementável** como está (DX#3). Também: `app_data_dir` só resolve via
  AppHandle; processo solo pode abrir um SQLite vazio irmão e "não há tasks" mascara
  "DB errado" (Eng#2).

→ A resolução lazy-correta empurra pro **MCP server in-app** (dentro do Tauri, onde já
há AppState/AppHandle/dono do writer), exposto em loopback HTTP + token via o mesmo
`wiring.rs` que já reescreve o Claude Code pro gbrain. Isso resolve writer-único +
trigger de dispatch + liveness + path de uma vez. **Custo:** precisa de crate de
server HTTP — e **AGENTS.md proíbe deps novas** (Eng#6; `rmcp` também proibido). Ou
hand-roll sobre `TcpListener`/`serde_json`. Esse é o trade central do gate.

### Correções auto-decididas (SE prosseguir, valem em qualquer arquitetura)
- **MCP read-only em `autonomy_level`** — nunca escreve; humano disca no app. (mata DX#6a + Eng#3-bump)
- **`wait_for_state` = single-poll limitado** retornando estado intermediário + short-circuit em `Failed`/`Aborted`, não bloqueio até timeout. (DX#4 + Eng#4)
- **Verbo `build(brief)`** que faz plan→approve→enqueue in-process (espelha `gestor_build_feature`); manter os granulares p/ inspeção. Renomear `approve`→`approve_proposals`, `enqueue`→`queue_task` (colisão com merge-gate/`despacho`). (DX#2)
- **Heartbeat** `(workspace_id,last_seen_at,pid)` por tick → tools de dispatch retornam erro estruturado `app_not_running`. (DX#3)
- **Cap por workspace de tasks MCP-despachadas + tag de profundidade (depth=1, sem recursão) + `abort_task` + tag visível no board.** (DX#6b-e)
- **`get_task` expõe `fail_reason`/`attempt`; `awaiting_input` é desfecho observado**, não hang. (DX#5)
- **Pool 2º processo** (se separado): replicar pragmas (`busy_timeout` é por-conexão) e abrir **sem** `migrate!`. (Eng#1)
- **Hand-roll JSON-RPC** sobre `serde_json` (sem `rmcp`); orçar testes unitários. (Eng#6)

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classificação | Princípio | Racional | Rejeitado |
|---|-------|----------|---------------|-----------|----------|-----------|
| 1 | Security | MCP read-only em autonomy_level | Mechanical | P1 | Self-bump = sem gate; e DB-write não acorda o loop | Self-bump p/ L2 |
| 2 | Eng/DX | wait_for_state single-poll + short-circuit terminal | Mechanical | P5 | Não congelar o turno do lead; falha não gasta timeout | Bloqueio até timeout |
| 3 | DX | Verbo build() + rename approve_proposals/queue_task | Taste→auto | P3 | 3 round-trips→1; mata colisão de domínio | plan→approve→enqueue cru |
| 4 | DX | Heartbeat + erro app_not_running | Mechanical | P1 | Sem liveness o "erro honesto" é impossível | "retornar queued honesto" (não-implementável) |
| 5 | DX | Cap + depth=1 + abort_task + tag no board | Mechanical | P1 segurança | Agente-spawna-agente sem cap/kill é runaway | sem escape hatch |
| 6 | Eng | Hand-roll JSON-RPC, sem rmcp; pool sem migrate! | Mechanical | P4/P5 | AGENTS.md proíbe dep nova; race de migração | rmcp SDK |
| — | Premise+Arch | Existir? stdio-separado vs in-app-HTTP vs CLI | **GATE** | — | CEO contesta premissa; arquitetura escrita quebra | — |
