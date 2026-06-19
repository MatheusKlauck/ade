# Relatório de Qualidade — ADE

> Data da análise: 2026-06-17
> Escopo: codebase Rust (`src-tauri/src/`) + TypeScript (`src/`) + documentação do projeto
> Metodologia: inspeção estática, execução dos gates (`cargo fmt`, `cargo clippy`, `cargo test`, `npm run build`, `npm test`) e grep por padrões de risco.

## 1. Resumo executivo

A arquitetura geral do ADE é sólida: Kanban + tmux/PTY + sync GitHub + Gestor de agentes estão implementados e os testes passam. No entanto, **os gates de qualidade do Rust não passam no working tree atual** e há violações reais das hard rules do projeto (`unwrap`/`expect` em produção e shell strings concatenadas).

Os principais riscos são:
1. Commits bloqueados pelos gates (`cargo fmt` e `cargo clippy`).
2. Hard crashes possíveis em caminhos de inicialização e sincronização.
3. Strings shell construídas a partir de input do usuário/admin.
4. Documentação desatualizada (`AGENTS.md` aponta para arquivos deletados; `README.md` é template Tauri).

## 2. Estado dos gates

| Gate | Resultado |
|---|---|
| `cargo fmt --check` | Falha — 5 arquivos desformatados |
| `cargo clippy --all-targets -- -D warnings` | Falha — 6 erros |
| `cargo test` | Passa (250 tests, 5 ignorados) |
| `npm run build` | Passa |
| `npm test` | Passa (102 tests) |

## 3. Bugs críticos — hard rules violadas

### 3.1 `unwrap()` / `expect()` / `panic!()` fora de `#[cfg(test)]`

A regra do projeto proíbe explicitamente. Encontramos **7 ocorrências reais**:

| Arquivo | Linha | Trecho | Risco |
|---|---|---|---|
| `src/lib.rs` | 303 | `let pool = db::init_db(&handle).await.expect("db init failed");` | App dá panic se o banco falhar no startup |
| `src/board_pos.rs` | 33 | `sorted.sort_by(\|a, b\| a.1.partial_cmp(&b.1).unwrap());` | Panic se posição for NaN |
| `src/sync/engine.rs` | 68 | `let local = local.expect("local must exist after row 2 & 3");` | Hard crash em sync |
| `src/ipc/card_lifecycle.rs` | 502 | `.expect("open non-Backlog columns have a kanban label")` | Hard crash em lifecycle de card |
| `src/sync/notifier.rs` | 30, 36 | `self.events.lock().expect("lock")` / `.push(...)` | Poisoned mutex crash |
| `src/gbrain/serve.rs` | 159 | `let mut guard = ch.lock().unwrap();` | Poisoned mutex crash |

### 3.2 Shell command strings por concatenação

| Arquivo | Linha | Problema |
|---|---|---|
| `src/gestor/dispatch.rs` | 163 | `Command::new("sh").arg("-c").arg(cmd)` com `worktree_setup_commands` |
| `src/gestor/gates.rs` | 31 | `Command::new("sh").arg("-c").arg(cmd)` com `gate_commands` |
| `src/term_monitor.rs` | 235 | `.arg(format!("cat > '{}'", path.display()))` |
| `src/gestor/worker.rs` | 128 | `hook_command` interpola `events_file` em string shell |

`worktree_setup_commands` e `gate_commands` vêm de configuração do workspace, portanto são **input não confiável** sob a ótica da regra.

## 4. Erros de clippy pendentes

| Arquivo | Linha | Erro | Correção |
|---|---|---|---|
| `src/gestor/jobs.rs` | 31 | `run_gestor_job` tem 8 argumentos | Agrupar em struct de contexto ou `#[allow(...)]` |
| `src/gestor/jobs.rs` | 111 | `run_and_notify` tem 9 argumentos | Agrupar em struct de contexto ou `#[allow(...)]` |
| `src/ipc/claude_sessions.rs` | 257 | `sort_by` desnecessário | Usar `sort_by_key` |
| `src/gh/client_tests.rs` | 491 | borrow desnecessário | `set_body_json(json!(...))` |
| `src/gh/client_tests.rs` | 504 | borrow desnecessário | `set_body_json(json!(...))` |

## 5. Problemas de arquitetura e manutenção

### 5.1 Dead code permitido em massa
Quase todos os módulos de `src/gestor/` usam `#![allow(dead_code)]`, assim como `src/pty.rs`, partes de `src/sync/`, `src/repo.rs` e `src/gitlocal.rs`. Isso indica subsistemas pré-conectados cuja superfície real de uso não está clara.

### 5.2 Módulos grandes demais

**Rust:**
- `src/gestor/runtime.rs` — ~740 linhas
- `src/ipc/card_lifecycle.rs` — ~541 linhas
- `src/gestor/fsm.rs` — ~559 linhas
- `src/gestor/dispatch.rs` — ~455 linhas

**TypeScript:**
- `src/components/TerminalPane.tsx` — 1072 linhas
- `src/components/TerminalArea.tsx` — ~899 linhas
- `src/components/CardDetail.tsx` — 863 linhas
- `src/components/Ledger.tsx` — 780 linhas
- `src/components/SkillsSidebar.tsx` — 773 linhas

### 5.3 Duplicações
- `FakeProvider` idêntico copiado em 6 arquivos de teste do gestor.
- Setup de banco SQLite in-memory repetido em ~8 arquivos de teste.
- Configuração do workspace (`workspace_setting_value`) lida e parseada manualmente em vários lugares.
- `Board.tsx` e `KanbanFull.tsx` compartilham lógica quase idêntica de drag-and-drop.

### 5.4 Estado no frontend
- `Board.tsx` lê o board inteiro, causando re-render de todas as colunas quando um card muda.
- `useTerminalsStore` acumula muitas responsabilidades (panes, layout, presets, atividade, foco).
- `App.tsx` centraliza ~15 subscriptions diferentes.

## 6. Documentação

| Item | Estado |
|---|---|
| `README.md` | Desatualizado — ainda é o template padrão do Tauri |
| `plan/00-CONTRACTS.md` | Deletado no commit `43146b3` |
| `plan/PROGRESS.md` | Deletado no commit `43146b3` |
| `plan/DECISIONS.md` | Deletado no commit `43146b3` |
| `AGENTS.md` | Atualizado, mas ainda referencia `plan/00-CONTRACTS.md` e `plan/PROGRESS.md` |
| `docs/PLANO-GESTOR-v1.md` | Existe; parece ter substituído os arquivos de `plan/` |

## 7. Recomendações priorizadas

### 7.1 Prioridade 1 — Fazer os gates passarem
1. `cd src-tauri && cargo fmt`
2. Corrigir os 6 erros do clippy listados acima.
3. Re-rodar `cargo test`, `npm run build`, `npm test`.

### 7.2 Prioridade 2 — Eliminar unwrap/expect reais
- `src/lib.rs:303` → propagar `Result` do startup.
- `src/board_pos.rs:33` → tratar `partial_cmp` fallible.
- `src/sync/engine.rs:68` → retornar erro se `local` for `None`.
- `src/ipc/card_lifecycle.rs:502` → retornar `AdeError::BoardColumnNotFound`.
- `src/sync/notifier.rs` e `src/gbrain/serve.rs` → tratar `Mutex` poison sem unwrap.

### 7.3 Prioridade 3 — Resolver shell strings
- Avaliar se `worktree_setup_commands` e `gate_commands` são intencionalmente scripts shell ou deveriam ser argv arrays.
- Para `term_monitor.rs`, usar escaping rigoroso de single-quote no path.
- Para `worker.rs`, preferir variável de ambiente `EVENTS_FILE` ao interpolar path.

### 7.4 Prioridade 4 — Corrigir documentação
- Restaurar `plan/` do histórico git **ou** atualizar `AGENTS.md` para apontar para `docs/PLANO-GESTOR-v1.md` e criar equivalentes de `CONTRACTS.md` / `PROGRESS.md` / `DECISIONS.md` em `docs/`.
- Reescrever `README.md` para refletir o produto ADE.

### 7.5 Prioridade 5 — Refatoração de qualidade
- Extrair subcomponentes de `TerminalPane.tsx` e `TerminalArea.tsx`.
- Quebrar `gestor/runtime.rs` em handlers por estado.
- Criar helpers compartilhados de fixture de banco para testes.
- Consolidar `FakeProvider` em um único módulo de testes.

## 8. Próximos passos sugeridos

1. Começar pela frente mecânica: `cargo fmt` + clippy.
2. Em seguida, corrigir os 7 unwrap/expect reais.
3. Decidir o destino da documentação (`plan/` vs `docs/`).
4. Só então atacar shell strings e refatorações maiores.

---

## Apêndice — Contagens

- Arquivos Rust: 62
- Arquivos `.tsx`: 39
- Arquivos `.ts`: 42
- Testes Rust passando: 250 (5 ignorados)
- Testes TypeScript passando: 102
- `unwrap/expect/panic` reais fora de testes: 7
- Erros clippy pendentes: 6
- Arquivos desformatados: 5