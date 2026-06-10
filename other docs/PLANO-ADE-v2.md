# Plano — Clone do BridgeSpace (ADE) — v2

> Workspace agentic de desenvolvimento para macOS. Performance nativa.
> Stack: **Tauri 2 (Rust core + web UI)**. Escopo: 6 features. GitHub: sync bidirecional.
> Contexto: **uso solo, repos próprios**. Data: 2026-06-10.
> Substitui a v1. Mudanças derivadas da avaliação adversarial (`REVIEW-ADE-v1.md`).

**Decisões da v2 (vs. v1):**

| # | Decisão | Substitui na v1 |
|---|---|---|
| D1 | Terminal via **nested tmux attach** desde o M1; control-mode (`-CC`) vira otimização opcional | "PTY direto + migração transparente p/ -CC" (incoerente — A1/A2 da review) |
| D2 | Feature 6 dispara **só por drag do usuário**; reconciliação remota nunca abre terminal | "todo card movido para Doing" (ambíguo — A5) |
| D3 | Sync incremental com **`state=all` + `since`**; sem ETag por card | Polling de lista de issues abertas (cego p/ fechamentos — A4) |
| D4 | Colunas **fixas** na v1 (Backlog/Doing/Paused/PR/Done) | "colunas configuráveis" × mapeamento fixo de labels (B3) |
| D5 | **Spike de sync** GitHub no M2, antes do multi-workspace | Risco bidirecional só no penúltimo milestone (B8) |
| D6 | Pull completo do backlog (paginado); aviso se >500 issues | Igual à v1, agora explícito |

---

## 1. Escopo

**Dentro da v1 do produto (6 features):**
1. Kanban funcional (colunas fixas nesta versão)
2. Vínculo GitHub — issues no backlog, sync bidirecional
3. Multi-terminal com tmux
4. Multi-workspaces
5. Comando customizável ao iniciar qualquer terminal
6. Card → "Doing" (drag do usuário) dispara terminal referenciando a issue

**Fora (arquitetura deixa espaço):** agentes de IA, editor, grafo de memória, voz,
colunas customizáveis, GitHub Projects v2, detecção automática de PR→coluna.

Racional do corte: a orquestração de agentes é a parte mais cara do BridgeSpace e só tem
valor sobre um esqueleto tarefas→terminais→projetos estável. Construir o esqueleto primeiro
evita retrabalho quando os agentes entrarem.

---

## 2. Arquitetura

### Camadas

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend (WKWebView) — React + TS + Vite                    │
│  • xterm.js (+ addon-webgl c/ fallback canvas, addon-fit)    │
│  • Kanban: pragmatic-drag-and-drop                           │
│  • Zustand = cache derivado (ver 2.2)                        │
└───────────────▲─────────────────────────────┬───────────────┘
                │  Channel (bytes crus do PTY) │  invoke (mutações)
                │  events (board/sync/erros)   ▼
┌───────────────┴─────────────────────────────────────────────┐
│  Core (Rust / Tauri 2)                                       │
│  • Terminal: portable-pty → `tmux attach` (nested, ver 3.1)  │
│  • Git local: git2 · GitHub: octocrab · SQLite: sqlx (WAL)   │
│  • Sync worker: tokio — `since` incremental + outbox (3.4)   │
│  • Config: TOML em app_data_dir · token no Keychain          │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 Terminal: nested attach (decisão D1)

Cada pane do app é um PTY (`portable-pty`) rodando um **cliente tmux** anexado à sessão do
workspace. O fluxo de bytes continua cru — PTY → `Channel` → xterm.js WebGL — então a
estratégia de performance vale integralmente. O que muda vs. PTY puro: o conteúdo é o tmux
desenhando, e com isso ganhamos **de graça e desde o M1**:

- Persistência real: fechar o app não mata nada; reabrir reanexa.
- Janelas criadas por fora (feature 6, CLI do usuário) aparecem na sessão.
- Base correta para `-CC` depois, se valer a pena.

**Mecânica (requer tmux ≥ 3.2; verificado no boot, erro vira notificação):**
- Sessão base por workspace: `ade_<slug>`.
- Cada pane do app anexa via **sessão agrupada** pinada numa janela (clientes na mesma
  sessão compartilham a janela corrente; sessões agrupadas resolvem isso):
  `tmux new-session -A -t ade_<slug> -s ade_<slug>__v<n>` + `select-window`.
- Nas sessões viewer: `status off`; `window-size latest` para o cliente focado mandar no resize.

**Control-mode (`-CC`) é explicitamente pós-v1/opcional.** Não é uma troca transparente: a
saída vem como `%output` com escapes octais (não bytes crus), há flow control próprio
(`%pause`/`%continue`) e input via `send-keys` — um backend distinto atrás de um trait
`TerminalBackend`, com contrato e benchmark próprios. Só entra se o nested attach mostrar
limite real de performance.

### 2.2 Dono do estado (novo — resolvia bug latente da v1)

**SQLite é a verdade.** Toda mutação (drag, criar card, renomear) vai por `invoke` → Rust
valida, persiste, emite evento → Zustand atualiza como **cache derivado**. Update otimista é
só visual e é confirmado/revertido pelo evento. Frontend nunca escreve estado canônico.

---

## 3. Componentes por feature

### 3.1 Multi-terminal (feature 3)

Como em 2.1. Performance: bytes crus pelo Channel (sem JSON/base64 por chunk), WebGL com
**fallback automático para canvas** e dispose correto do addon no lazy unmount (context loss).
Meta de 60fps em saída pesada é validada por **benchmark próprio no M1** (`cat` de arquivo
de 100 MB, build verboso), não por analogia com outros apps.

### 3.2 Multi-workspaces (feature 4)

Workspace = projeto: diretório raiz + sessão tmux `ade_<slug>` + board + repo GitHub +
startup command. Abas no topo; trocar de aba troca board e terminais sem rebuild (estado no
Rust/SQLite). Panes de workspaces inativos ficam desmontados (lazy mount) — a sessão tmux
segue viva por baixo.

### 3.3 Kanban (feature 1)

Colunas **fixas na v1**: Backlog → Doing → Paused → PR → Done (D4; customização é pós-v1 e
exigirá mapeamento coluna→label configurável). Drag-and-drop com pragmatic-drag-and-drop.
Ordenação por **fractional indexing** (`position` é string; sem re-index em massa por drag —
importa com backlog grande).

**Dois tipos de card (`source`):**
- **Local** — vive só no SQLite. Botão **"Criar issue no GitHub"** (renomeado; a ação cria,
  não navega) promove o card a vinculado.
- **Vinculado** — espelha uma issue. Badge visual distingue os dois; card vinculado exibe
  número e assignee (campos sincronizados no card, ver schema).

Criar card nunca abre issue automaticamente. Double-click abre painel de detalhe: vinculado
busca corpo/comentários/labels sob demanda via octocrab; local mostra campos locais.

### 3.4 Vínculo GitHub bidirecional (feature 2)

**Leitura — incremental com `since` (D3):**
- *Seed* (primeira sync): pagina `state=open` (100/página). **Filtra PRs** — o endpoint de
  issues retorna pull requests; descarta itens com campo `pull_request`. Se >500 issues,
  notifica e segue (uso solo: pull completo, D6).
- *Incremental:* `state=all&since=<último sync>` → só o que mudou, **incluindo fechamentos e
  reaberturas remotas** (o ponto cego da v1). Salva `last_sync` por workspace.
- ETag de lista (`If-None-Match`) como economia extra de rate limit quando nada mudou —
  válido só com request autenticada (condição da doc do GitHub). Octocrab tem cobertura
  parcial de conditional requests; usar os métodos crus (`_get`) se necessário. **Sem ETag
  por issue** — a v1 tinha a coluna no schema sem fluxo que a usasse.

**Escrita — via labels (mantido):** label de status exclusiva por coluna.

| Coluna | GitHub |
|---|---|
| Backlog | sem label de status |
| Doing | `kanban:doing` |
| Paused | `kanban:paused` |
| PR | `kanban:pr` (manual na v1) |
| Done | `state=closed` + remove labels de status |

Labels `kanban:*` criadas na primeira sync. Done→outra coluna = reopen + label destino.

**Protocolo de reconciliação (novo — fecha as corridas da v1):**

GitHub é a fonte da verdade **para cards vinculados**; cards locais nem entram no sync.
Regras na ordem:

1. **Outbox colapsado e idempotente:** no máximo **uma intent pendente por card** (mover o
   card 3× substitui a intent, não enfileira 3). Cada intent grava o
   `base_remote_updated_at` da issue no momento do enfileiramento.
2. **Escrita pendente suspende reconciliação:** card com intent no outbox é **excluído** do
   ciclo de reconciliação (evita o ping-pong revert→apply da v1).
3. **Intent obsoleta é descartada:** antes de enviar, se `remote_updated_at` atual difere do
   `base` da intent, a intent é dropada, o card reconcilia para o remoto e o usuário é
   notificado ("issue #123 mudou no GitHub; seu movimento foi descartado"). Nunca
   sobrescrevemos mudança remota com intenção velha — "remoto vence" de verdade.
4. **Supressão de eco:** mudança remota cujo estado já coincide com o local só atualiza
   `remote_updated_at` (a maioria dos "diffs" do poll é a escrita do próprio app voltando).
5. Falha de escrita → retry com backoff (`attempts`, `last_error`); após N falhas, card
   reverte ao estado remoto + notificação. Nada falha em silêncio.
6. **Rate budget global por token:** um coordenador único distribui o orçamento entre os
   workers de todos os workspaces (rate limit é por conta, não por repo).

Trade-off mantido e agora honesto: offline, um movimento local pode ficar pendente por
horas e ser descartado se a issue mudar remotamente nesse meio tempo — com notificação.

Autenticação: PAT nas settings (mais rápido p/ v1; Device Flow depois). Token no Keychain
(`keyring`), nunca em SQLite/TOML. Fluxo de erro definido para token sem escopo / repo
inacessível: notificação acionável, workspace segue funcionando em modo local.

### 3.5 Comando de startup (feature 5)

Por workspace (sobrescreve default global), TOML. Injetado em toda janela/pane nova via
`send-keys` (o comando é autorado pelo usuário — confiável). Ex.: `nvm use && source .env && clear`.

### 3.6 Auto-launch ao mover para "Doing" (feature 6)

**Gatilho: somente drag explícito do usuário (D2).** Movimento por reconciliação remota
nunca abre terminal. Regras de borda:
- Card já tem janela viva (`terminal_window_id` no schema) → **foca** em vez de criar.
- Revert pelo outbox (3.4.5) **não fecha** o terminal — só notifica.

Sequência (card vinculado):
1. Garante sessão `ade_<slug>`.
2. `tmux new-window -t ade_<slug> -n <slug-sanitizado> -c <repo_root> -e ISSUE_NUMBER=… -e ISSUE_TITLE=… -e ISSUE_URL=…`
3. (Configurável) branch: se `issue-<n>` existe → checkout simples; se worktree sujo → **não
   troca de branch**, abre o terminal e notifica; senão `checkout -b` via git2.
4. Roda o startup command (3.5). 5. Foca o pane na UI.

Card **local** em Doing: mesma sequência **sem** env `ISSUE_*` e sem branch (janela nomeada
pelo título do card, sanitizado).

**Segurança (corrige injeção da v1):** título de issue é input não confiável (bots,
terceiros). Env vars entram **só** via `-e` no `new-window` (sem interpolação em linha de
shell); nomes de janela e branch passam por sanitização `[a-z0-9-]`, máx. 40 chars. Nunca
montar string de shell com texto vindo do GitHub.

### 3.7 Onboarding

App abre vazio → ação principal: selecionar pasta. Com `.git`: lê `remote origin` —
**parser cobre SSH (`git@github.com:o/r.git`) e HTTPS** — infere `owner/repo`, tenta
vincular (pede token se não houver; falha de escopo → notificação, workspace fica local).
Sem `.git`: workspace só com terminais + kanban local.

### 3.8 Settings

v1 entrega **tema** (claro/escuro + acento). Estrutura preparada p/ fonte do terminal,
intervalo de sync, token, startup global. SQLite (`setting`) + TOML; token no Keychain.

### 3.9 Notificações / erros

Camada única: falha de sync, rate limit, token inválido, **tmux ausente ou < 3.2**, branch
não criada (worktree sujo), intent descartada (3.4.3), escrita rejeitada. Eventos Rust →
toast + histórico. Nada falha em silêncio.

### 3.10 Persistência: dois sentidos

**(a) Estado de UI/sessão (v1):** SQLite (board, cards, workspaces) + snapshot de layout em
`ui_state`. Terminais reanexam via sessão tmux — **funciona desde o M1** com nested attach
(na v1 do plano isso só era verdade após o control-mode). gbrain/agentmemory não servem aqui.

**(b) Memória de agente (pós-v1):** gbrain (grafo markdown, MCP-native, local-first —
candidato preferido) ou agentmemory (vetorial). Ambos plugam via MCP/CLI, não como crate.
Decisão fica para o épico de agentes.

---

## 4. Modelo de dados (SQLite, WAL)

```sql
workspace(id, name, slug, root_path,
          github_owner, github_repo,        -- separados (parser SSH/HTTPS)
          startup_command, tmux_session, created_at)

board_column(id, workspace_id, name, position)
          -- 5 colunas fixas na v1, seed na criação do workspace; sem wip_limit
          -- (a v1 tinha wip_limit órfão no schema, sem feature)

card(id, workspace_id, column_id, title, body_preview, position,
          -- position TEXT: fractional index
     source,                  -- 'local' | 'github'
     github_issue_number,     -- nullable
     github_state,            -- 'open' | 'closed' | NULL  (Done ≠ closed p/ card local)
     assignee, labels_json,   -- exibidos no card sem re-fetch
     remote_updated_at,       -- base p/ detecção de mudança remota e eco
     terminal_window_id,      -- janela tmux viva do card (foco em vez de duplicar)
     created_at, updated_at)

outbox(card_id PRIMARY KEY,   -- 1 intent por card (colapsa, não enfileira)
       intent, payload_json,
       base_remote_updated_at,-- p/ descartar intent obsoleta (3.4.3)
       attempts, last_error, created_at)

sync_state(workspace_id PRIMARY KEY, last_sync, list_etag)

setting(key, value)
ui_state(key, value_json)
```

Índices: `card(workspace_id, column_id, position)`. Token **só** no Keychain.

Removido vs. v1: `card.etag` (sem fluxo que o usasse), `github_node_id` (Projects v2 fora),
`wip_limit`. Adicionado: `github_state`, `assignee/labels_json`, `terminal_window_id`,
`base_remote_updated_at`, `sync_state`.

---

## 5. Performance

- Bytes crus por Channel + xterm WebGL (fallback canvas) + batching rAF. **Benchmark próprio
  no M1** é critério de aceitação, não citação externa.
- Rust faz PTY, sync, git e SQLite em tasks tokio; UI nunca bloqueia.
- SQLite WAL + índices; fractional indexing evita re-index em drag.
- Sync: `since` + ETag de lista; 304 autenticado não consome rate limit; budget global por token.
- Lazy mount de panes inativos (com dispose correto do WebGL).
- Binário ~10–15 MB; cold start < 1 s.

---

## 6. Roadmap

**M0 — Fundação.** Tauri 2 + React/Vite + Zustand, sqlx + migrations, TOML, Keychain.
*Aceite: app abre, persiste config, lê/grava token no Keychain.*

**M1 — Terminal que presta (nested attach).** PTY → `tmux attach` (sessões agrupadas,
status off, window-size latest) → Channel → xterm WebGL. Resize, startup command, check de
versão do tmux. *Aceite: benchmark de saída pesada sem frame drop; fechar/reabrir o app
reanexa a sessão. Features 3 + 5.*

**M2 — Kanban local + spike de sync (D5).** Board fixo, drag-and-drop, fractional index,
cards locais, contrato invoke/eventos (2.2). **Em paralelo: spike do sync** — seed + `since`
+ outbox + reconciliação (regras 1–4 de 3.4) contra repo de teste, validando o protocolo
antes de qualquer UI de sync. *Aceite: feature 1; spike demonstra fechamento remoto
refletido no board e intent obsoleta descartada.*

**M3 — Multi-workspace + onboarding.** Abas, sessão tmux por projeto, lazy mount, seleção
de pasta + parser de remote (SSH/HTTPS). *Aceite: feature 4 + 3.7; dois workspaces com
terminais vivos alternando sem rebuild.*

**M4 — Auto-launch (feature 6).** Doing→terminal com `-e`/`-c`, branch com regras de
worktree sujo, foco de janela existente, sanitização. Não depende de control-mode.
*Aceite: feature 6 nas três variantes (vinculado, local, re-entrada).*

**M5 — GitHub bidirecional completo.** Integra o spike: pull completo + incremental,
"Criar issue no GitHub", detalhe da issue, escrita por labels, notificações de sync.
*Aceite: feature 2; teste de reconciliação (eco, revert, obsoleta) automatizado.*

**M6 — Settings, notificações & polish.** Tema, camada de notificações completa,
performance pass, auto-update, `.app` assinado/notarizado.
*Aceite: 3.8 + 3.9; checklist de erros de 3.9 todos observáveis.*

**Pós-v1 (épicos):** tmux control-mode (backend novo atrás de trait, com benchmark próprio);
colunas customizáveis (mapeamento coluna→label); PR→coluna automático ("Closes #123");
filtros de pull (assignee/label); Device Flow; agentes + gbrain.

> Sem estimativas de horas (dependem de disponibilidade e familiaridade com Rust). O risco
> técnico concentrado da v1 (parser `-CC`) saiu do caminho crítico; o risco restante
> (protocolo de sync) é atacado cedo, no spike do M2.

---

## 7. Riscos & mitigações

| Risco | Impacto | Mitigação |
|---|---|---|
| Nested attach: peculiaridades de sessões agrupadas (resize, status, mouse) | UX do terminal | Regras explícitas em 2.1 (status off, window-size latest); tmux ≥ 3.2 verificado no boot |
| Corridas sync × outbox | Estado incoerente no board | Protocolo 3.4 (intent única, supressão de reconciliação, descarte de obsoleta, eco) + testes no spike M2 |
| Injeção via título de issue | Execução de código no shell do usuário | Env só via `-e`; sanitização de nomes; nunca interpolar texto remoto em shell |
| Sem webhooks no desktop | Sync atrasada | `since` incremental + ETag de lista; intervalo configurável |
| Rate limit por conta com N workspaces | Sync trava | Coordenador global de budget por token; backoff |
| Throughput IPC do terminal | Performance | Bytes crus + WebGL + rAF; benchmark de aceite no M1 |
| Token | Vazamento | Keychain; nunca SQLite/TOML |
| Backlog gigante (repo com milhares de issues) | UI/ruído | Pull paginado + aviso >500; filtros são pós-v1 |

---

## 8. Dependências

**Rust:** `tauri` 2, `portable-pty`, `tokio`, `sqlx` (sqlite), `octocrab` (métodos crus p/
conditional requests), `git2`, `keyring`, `serde`/`serde_json`, `toml`.
**Frontend:** `react`, `typescript`, `vite`, `@xterm/xterm`, `@xterm/addon-webgl`,
`@xterm/addon-fit`, `@atlaskit/pragmatic-drag-and-drop`, `zustand`.
**Sistema:** tmux ≥ 3.2 (checado no boot), Xcode CLT (assinar/notarizar).

---

## 9. Próximo passo

(a) Scaffold do M0 rodando, ou (b) M1 detalhado com código (PTY→attach→Channel→xterm).

---

### Fontes
- [iTerm2 — tmux Integration](https://iterm2.com/documentation-tmux-integration.html) · [tmux Wiki — Control Mode](https://github.com/tmux/tmux/wiki/Control-Mode)
- [GitHub REST — best practices (conditional requests/304)](https://docs.github.com/rest/guides/best-practices-for-using-the-rest-api) · [Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [BridgeSpace (produto-alvo)](https://www.bridgemind.ai/products/bridgespace) — referência de escopo, não evidência técnica
