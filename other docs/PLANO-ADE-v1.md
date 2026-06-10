# Plano — Clone do BridgeSpace (ADE) — v1

> Workspace agentic de desenvolvimento para macOS. Foco em performance nativa.
> Stack travada: **Tauri 2 (Rust core + web UI)**. Escopo: 6 features. GitHub: **sync bidirecional**.
> Data: 2026-06-10

---

## 1. O que estamos copiando (e o que NÃO)

O BridgeSpace é um "Agentic Development Environment": junta terminais multi-pane, Kanban,
agentes de IA em paralelo (BridgeSwarm), editor e um grafo de memória (BridgeMemory).

A sua v1 corta a parte mais cara (orquestração de agentes de IA, memória, editor) e foca no
**esqueleto do workspace**: tarefas → terminais → projetos. Decisão correta — é a fundação sobre
a qual o resto (agentes) encaixa depois sem retrabalho.

**Dentro da v1 (6 features):**
1. Kanban totalmente funcional
2. Vínculo GitHub — issues no backlog (sync bidirecional)
3. Multi-terminal com tmux
4. Multi-workspaces (vários projetos ao mesmo tempo)
5. Comando customizável executado ao iniciar qualquer terminal
6. Mover card para "Doing" dispara terminal referenciando a issue

**Fora da v1 (mas a arquitetura deve deixar espaço):** agentes de IA, editor de código,
grafo de memória, voz.

---

## 2. Decisão de arquitetura

### Por que Tauri (e o que isso implica)

Tauri usa o **WKWebView do sistema** (não embute Chromium), então o binário fica ~10 MB e o
uso de RAM é baixo — o oposto de Electron. O core roda em **Rust**, ideal para I/O de PTY,
sync de rede e acesso a SQLite sem travar a UI.

O ponto crítico de performance num app assim é **streaming de saída do terminal**. O padrão
validado em produção (ex.: terminal Terax, ~7 MB, mesmo stack) é:

```
PTY (Rust, portable-pty)  ──►  Tauri Channel<PtyEvent>  ──►  xterm.js + addon WebGL (canvas)
```

Isso evita serializar JSON por chunk e mantém 60fps mesmo com saída pesada (`cat` de arquivo
grande, build verboso). É o caminho que adotamos.

### Camadas

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend (WKWebView)  — React + TS + Vite                  │
│  • xterm.js (+ addon-webgl, addon-fit) por pane             │
│  • Kanban: pragmatic-drag-and-drop (Atlassian)              │
│  • Estado: Zustand                                          │
│  • Layout multi-pane/workspace                              │
└───────────────▲─────────────────────────────┬───────────────┘
                │  Channel<PtyEvent> (bytes)   │  commands (invoke)
                │  events (kanban/sync)        ▼
┌───────────────┴─────────────────────────────────────────────┐
│  Core (Rust / Tauri 2)                                       │
│  • Terminal: portable-pty  +  cliente tmux control-mode(-CC) │
│  • Git local: git2 (libgit2)                                 │
│  • GitHub API: octocrab (REST + GraphQL)                     │
│  • Persistência: SQLite via sqlx                             │
│  • Sync worker: tokio (polling + ETag)                       │
│  • Config: TOML em app_data_dir                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Componentes — abordagem técnica por feature

### 3.1 Multi-terminal com tmux (feature 3) — núcleo do app

Você já tem tmux instalado e quer tmux como multiplexer. A forma "certa" (e a que o iTerm2 usa)
é **tmux control mode (`tmux -CC`)**: o tmux deixa de desenhar a tela e passa a falar um
**protocolo de texto** estruturado (`%output`, `%window-add`, `%layout-change`, `%begin/%end`).
O app vira um cliente desse protocolo e renderiza cada pane do tmux como uma instância xterm.js.

Ganhos disso:
- Sessões **reais** do tmux → sobrevivem ao fechamento do app (reanexa e tudo está lá).
- Gerenciamento de janelas/panes nativo do tmux, de graça.
- Uma única conexão por sessão.

**Risco:** implementar o parser de control-mode é a parte mais difícil da v1 (o iTerm2 levou
esforço considerável aqui). **Mitigação / fallback:** se o control-mode atrasar a v1, começamos
com **PTY direto** (`portable-pty` → shell do usuário, um PTY por pane) e usamos tmux por
**comandos** (`tmux new-window`, `send-keys`) para as features 5 e 6. Migra-se para control-mode
em seguida sem mexer no frontend (a interface Channel<PtyEvent> é a mesma).

> Recomendação: **começar pelo PTY direto** (entrega terminais rápidos já no Milestone 1) e
> introduzir control-mode no Milestone 4, quando multi-workspace e auto-launch já estiverem de pé.

Detalhes de performance: xterm.js com `@xterm/addon-webgl`, coalescing de writes via
`requestAnimationFrame`, e envio de bytes crus pelo Channel (sem base64/JSON por chunk).

### 3.2 Multi-workspaces (feature 4)

Um **workspace = projeto**: diretório raiz + sessão(ões) tmux próprias + board kanban próprio +
repo GitHub vinculado + config de comando de startup. Na UI, workspaces são **abas/rooms** no
topo; trocar de aba troca o board, os terminais e o contexto sem rebuildar nada (o estado vive
no Rust + SQLite).

Cada workspace mapeia para uma sessão tmux nomeada (ex.: `ade_<slug-do-projeto>`), o que dá
isolamento natural e persistência por projeto.

### 3.3 Kanban (feature 1)

Colunas configuráveis; default **Backlog → Doing → Paused → PR → Done**. Drag-and-drop com
**pragmatic-drag-and-drop** (mais performático que dnd-kit para listas grandes). Tudo persistido em
SQLite por workspace. Mover card emite um evento no Rust que dispara os gatilhos (sync GitHub
e/ou auto-launch).

**Dois tipos de card (`source`):**
- **Local** — criado direto no board, vive só no SQLite. Tem um botão discreto **"Open in GitHub"**
  que, ao ser clicado, cria a issue correspondente no repo do workspace e converte o card em
  *vinculado*.
- **Vinculado** — espelha uma issue do GitHub (puxada na sync ou promovida via "Open in GitHub").

**Criar tarefa:** sempre nasce como card **local**. Criar card **não** abre issue automaticamente —
só o botão "Open in GitHub" faz isso (decisão).

**Detalhe do card:** **double-click** abre um painel com todos os detalhes. Para card vinculado,
busca a issue completa (corpo, comentários, assignee, labels, milestone) via `octocrab`; para card
local, mostra os campos locais.

**Regra (feature 6):** **todo** card movido para Doing abre um terminal (decidido). Card vinculado
ganha branch + `ISSUE_*`; card local abre o terminal sem contexto de issue (cd no repo + comando de
startup, sem branch nomeada).

### 3.4 Vínculo GitHub — bidirecional (feature 2)

**Leitura (issues → backlog):** `octocrab` puxa **todas as issues abertas** do repo vinculado para a
coluna Backlog (sem filtro na v1 — decisão). Sync por **polling com ETag** (desktop não tem endpoint
público p/ webhooks) — um worker tokio a cada N segundos, respeitando rate limit. *(Se o volume
incomodar em repos grandes, adicionar filtro por assignee/label é uma evolução pós-v1.)*

**Escrita (board → GitHub): via labels (decidido).** Cada coluna corresponde a uma label de
status, e a label é **exclusiva** (mover de coluna remove a label antiga e põe a nova):

| Coluna | Ação no GitHub |
|---|---|
| Backlog | sem label de status (estado default da issue aberta) |
| Doing | label `kanban:doing` — **dispara o terminal** (feature 6) |
| Paused | label `kanban:paused` |
| PR | label `kanban:pr` |
| Done | `issue.state = closed` (e remove labels de status) |

A label de status é **exclusiva**: mover de coluna remove a anterior e aplica a nova. Reabrir card
(Done → outra coluna) = `reopen` + aplica a label da coluna destino. As labels `kanban:*` são
criadas automaticamente no repo na primeira sync, com cores próprias. (Descartado na v1: GitHub
Projects v2 — exigiria GraphQL e adiciona complexidade sem ganho p/ o seu fluxo.)

> **Nota sobre a coluna PR:** na v1 ela é manual (label `kanban:pr`). Uma evolução natural pós-v1
> é o app **detectar automaticamente** quando um PR referencia a issue (ex.: "Closes #123") e mover
> o card pra PR sozinho — encaixa bem no fluxo Doing → branch → PR → Done.

**Fonte da verdade: GitHub, por card (decidido).** A regra vale **apenas para cards vinculados** —
para esses, o GitHub é sempre a autoridade. Cards **locais** vivem só no SQLite e não têm fonte
remota até serem promovidos via "Open in GitHub". Isso elimina merge ou UI de conflito:

- Mudanças locais (mover card, fechar) são **intenções** enviadas ao GitHub via outbox; só viram
  estado "real" depois que o GitHub confirma. Se a escrita falhar, o card **reverte** para o que o
  GitHub diz — sem estado fantasma.
- Em qualquer divergência, o board se reconcilia para o estado do GitHub no próximo ciclo de sync,
  silenciosamente (sem notificação de conflito).
- Snapshot `updated_at`/ETag por issue continua servindo para detectar mudança remota e evitar
  escrita redundante, mas a regra de desempate é trivial: **remoto vence, sempre**.

Trade-off aceito: offline, uma mudança local pode parecer "desfeita" por um instante até o GitHub
aceitar a escrita.

Autenticação: **GitHub OAuth Device Flow** ou **PAT** colado nas settings (PAT é mais rápido p/
v1; guardar no Keychain do macOS via `keyring` crate, nunca em texto plano).

### 3.5 Comando de startup customizável (feature 5)

Config por workspace (sobrescreve um default global), em TOML. Ao criar qualquer pane/terminal,
o comando é injetado antes de devolver o controle ao usuário:
- PTY direto: escreve o comando no PTY logo após o spawn do shell.
- tmux: `send-keys` no pane recém-criado (ou `set-hook` de sessão).

Ex.: `nvm use && source .env && clear`.

### 3.6 Auto-launch ao mover para "Doing" (feature 6)

Quando um card entra em **Doing**, o Rust:
1. Garante a sessão tmux do workspace.
2. Cria uma **nova janela/pane** nomeada com a issue (ex.: `#123-fix-login`).
3. `cd` na raiz do repo do workspace.
4. (Opcional, configurável) cria/checa branch: `git checkout -b issue-123` via `git2`.
5. Exporta contexto: `ISSUE_NUMBER`, `ISSUE_TITLE`, `ISSUE_URL` como env vars no pane.
6. Roda o comando de startup (feature 5).
7. Foca o pane na UI.

Tudo isso é configurável (criar branch sim/não, padrão de nome, etc.) nas settings do workspace.
Cards **locais** disparam o terminal igual (decidido — **tudo** que entra em Doing abre terminal),
porém sem os passos 2/4/5 (sem issue → sem branch nomeada nem `ISSUE_*`).

### 3.7 Onboarding / primeiro uso (decidido)

App abre com **workspace vazio**. Ação principal: **selecionar uma pasta** para trabalhar. Ao
selecionar:
- Se a pasta tiver **`.git`**, o app lê o `remote origin`, infere `owner/repo` do GitHub e **tenta
  vincular automaticamente** (pedindo o token se ainda não houver).
- Se não tiver `.git`, cria o workspace mesmo assim (só terminais + kanban local, sem sync).

Sem fluxo de setup pesado — espelha o `bridgespace .` do original ("abra uma pasta e comece").

### 3.8 Settings (decidido — começar pelo tema)

Tela de preferências. **v1 entrega tema** (claro/escuro + acento). Estrutura preparada para crescer
(fonte do terminal, intervalo de sync, token GitHub, comando de startup global). Persistido em
`setting` (SQLite) + TOML; token sempre no Keychain.

### 3.9 Notificações / erros (decidido — notificar quando relevante)

Camada única de notificação que **surfacea todo tipo de erro/aviso**: falha de sync, rate-limit,
token inválido, tmux ausente/incompatível, falha ao criar branch, escrita ao GitHub rejeitada.
Erros do Rust sobem como `events` para o frontend, que mostra um toast + um histórico acessível.
Nada falha em silêncio.

### 3.10 Persistência: dois sentidos diferentes

Há duas "persistências entre sessões" e elas usam mecanismos distintos — não confundir:

**(a) Estado da sessão/UI (v1, nativo).** Qual workspace estava aberto, arranjo dos panes, estado do
board, scroll. É **serialização pura**: tabelas SQLite (board, cards, workspaces) + um snapshot de
layout (linha `setting` ou JSON). Restaurado no boot. Terminais reanexam via sessão tmux nomeada.
**gbrain/agentmemory NÃO servem aqui** — é estado estruturado, não memória semântica.

**(b) Memória do agente (pós-v1).** Conhecimento que se acumula entre sessões (decisões, contexto).
É aqui que entram **gbrain** ou **agentmemory** — memória semântica/grafo. Mas a v1 **não tem
agentes**, então nada escreve nessa camada ainda; ela só passa a fazer sentido quando a orquestração
de agentes for adicionada.

- **gbrain** (Garry Tan): grafo de markdown auto-conectado, MCP-native, local-first — é o equivalente
  direto do BridgeMemory. **Recomendado** quando os agentes entrarem, por alinhar com o produto-alvo.
- **agentmemory** (elizaOS): memória vetorial via ChromaDB/Postgres. Alternativa mais "banco vetorial".

> Integração: ambos são Python/Postgres. Num app Tauri/Rust, plugam via **MCP server / CLI**, não
> como crate Rust. Decisão de qual usar fica para o épico de agentes (fora do escopo v1).

---

## 4. Modelo de dados (SQLite)

```sql
workspace(id, name, slug, root_path, github_repo, startup_command,
          tmux_session, created_at)

board_column(id, workspace_id, name, position, wip_limit)

card(id, workspace_id, column_id, title, body, position,
     source,                 -- 'local' | 'github'
     github_issue_number,    -- nullable
     github_node_id,         -- p/ GraphQL, nullable
     remote_updated_at,      -- snapshot p/ detecção de conflito
     etag,                   -- nullable
     created_at, updated_at)

outbox(id, card_id, action, payload_json, status, attempts, created_at)
       -- fila de escrita p/ GitHub (resiliente a offline/erro)

setting(key, value)         -- config global (tema, comando default, intervalo de sync…)

ui_state(key, value_json)   -- snapshot de layout p/ restaurar sessão: workspace ativo,
                            -- arranjo de panes, coluna/scroll do board (persistência 3.10a)
```

Config sensível (PAT/token) **não** vai no SQLite — vai no **Keychain** (crate `keyring`).

---

## 5. Estratégia de performance (resumo prático)

- **Terminal:** bytes crus por `Channel`, xterm.js WebGL, batching por rAF. Meta: sem queda de
  frame em saída pesada.
- **Rust faz o trabalho pesado** (PTY, sync, git, SQLite) em tasks tokio → UI nunca bloqueia.
- **SQLite com WAL** + índices em `(workspace_id, column_id, position)` p/ board instantâneo.
- **Sync GitHub** com ETag/`If-None-Match` → respostas 304 não contam quase nada no rate limit.
- **Lazy mount** de panes: xterm.js de workspaces não-ativos fica desmontado; reanexa ao trocar.
- Binário Tauri ~10–15 MB; cold start abaixo de ~1s.

---

## 6. Roadmap por milestones

Ordem pensada p/ ter algo usável cedo e empurrar o risco (control-mode, bidirecional) p/ depois.

**M0 — Fundação (scaffold)**
Projeto Tauri 2 + React/Vite + Zustand. SQLite/sqlx com migrations. Janela, settings TOML,
Keychain. *Entrega: app abre, persiste config.*

**M1 — Terminal que presta**
PTY direto (`portable-pty`) → Channel → xterm.js WebGL. Um terminal funcional e rápido, com
resize e o comando de startup (feature 5). *Entrega: features 3 (parcial) + 5.*

**M2 — Kanban local**
Board, colunas configuráveis, drag-and-drop, persistência. Cards locais. *Entrega: feature 1.*

**M3 — Multi-workspace + onboarding**
Abas de projeto, board+terminais por workspace, sessão tmux nomeada por projeto. Onboarding:
workspace vazio → selecionar pasta → detectar `.git` e inferir o repo. *Entrega: feature 4 + 3.7.*

**M4 — tmux control-mode + auto-launch**
Cliente `-CC` (ou, se atrasar, panes via comandos tmux). Gatilho "Doing → terminal" com
branch + env + startup (cards vinculados) e terminal simples (cards locais).
*Entrega: feature 6 + feature 3 completa.*

**M5 — GitHub bidirecional**
Auth (PAT→Keychain), pull de **todas** as issues p/ backlog, "Open in GitHub" (local→issue),
double-click → detalhe da issue, outbox + sync por labels. *Entrega: feature 2 + detalhe do card.*

**M6 — Settings, notificações & polish**
Tela de settings (tema primeiro), camada de notificações (todos os erros), lazy mount, WAL/índices,
cold start, auto-update (Tauri updater), empacotar `.app` assinado/notarizado p/ macOS.
*Entrega: 3.8 + 3.9 + performance pass.*

> Não estimei horas porque depende muito da sua disponibilidade e familiaridade com Rust.
> O caminho crítico de risco é **M4 (control-mode)** e **M5 (conflito bidirecional)** — se quiser,
> dá pra entregar uma v1 sólida com tmux-por-comandos e sync "remoto vence" e refinar depois.

---

## 7. Riscos & mitigações

| Risco | Impacto | Mitigação |
|---|---|---|
| Parser tmux control-mode (`-CC`) é trabalhoso | Atrasa M4 | Começar com PTY direto + tmux por comandos; mesma interface de Channel, migração sem tocar UI |
| Sync bidirecional gerar conflitos/perda | Dados | GitHub = fonte da verdade (decidido): remoto sempre vence, sem merge; outbox p/ resiliência de escrita |
| Sem webhooks no desktop | Sync atrasada | Polling com ETag (304 barato); intervalo configurável |
| Throughput de IPC no terminal | Performance | Channel com bytes crus + WebGL + batching rAF (padrão já validado) |
| Rate limit GitHub | Sync trava | ETag/condicionais, backoff, um worker por conta |
| Segurança do token | Vazamento | Keychain (crate `keyring`), nunca em SQLite/TOML |

---

## 8. Dependências concretas

**Rust (core):** `tauri` 2, `portable-pty`, `tokio`, `sqlx` (sqlite), `octocrab`, `git2`,
`keyring`, `serde`/`serde_json`, `toml`.

**Frontend:** `react`, `typescript`, `vite`, `@xterm/xterm`, `@xterm/addon-webgl`,
`@xterm/addon-fit`, `@atlaskit/pragmatic-drag-and-drop`, `zustand`.

**Sistema:** tmux (já instalado), Xcode Command Line Tools (p/ assinar/notarizar o `.app`).

---

## 9. Próximo passo sugerido

Posso, a partir deste plano: (a) gerar o scaffold do M0 (projeto Tauri + Vite + SQLite migrations)
já rodando, ou (b) detalhar o M1 (terminal PTY→Channel→xterm.js) com o código real. Diga qual e eu
começo.

---

### Fontes
- [BridgeSpace — página do produto](https://www.bridgemind.ai/products/bridgespace)
- [iTerm2 — tmux Integration (control mode)](https://iterm2.com/documentation-tmux-integration.html)
- [tmux Wiki — Control Mode](https://github.com/tmux/tmux/wiki/Control-Mode)
- [tauri-plugin-pty (Tauri 2 + xterm.js + portable-pty)](https://github.com/Tnze/tauri-plugin-pty)
- [Terax — terminal Tauri ~7MB (Channel<PtyEvent> + WebGL)](https://starlog.is/articles/developer-tools/crynta-terax-ai)
