# Auditoria da Codebase ADE

Data: 2026-06-17

---

## CRÍTICO (corrigir imediatamente)

| # | Arquivo | Problema |
|---|---------|----------|
| 1 | `gestor/gates.rs:30-45` | **Shell injection** — usa `sh -c <cmd>` com dados do SQLite, violando a regra hard do AGENTS.md. Refatorar para argv arrays. |
| 2 | `tauri.conf.json:25` | **CSP null** — sem Content Security Policy, WebView aceita qualquer script/origem. Definir CSP restritivo para produção. |
| 3 | `tauri.conf.json:48` | **Updater pubkey vazio** — atualizações sem verificação de assinatura = entrega de código arbitrário. Gerar keypair e configurar. |

---

## ALTO (corrigir logo)

| # | Arquivo | Problema |
|---|---------|----------|
| 4 | `pty.rs:78-81`, `tmux.rs:48`, `db.rs:157`, `sync/notifier.rs:20-23` | **`unwrap()`/`expect()` em produção** — viola regra hard do AGENTS.md. Substituir por `AdeError` propagation. |
| 5 | `term_monitor.rs:120-140` | **Shell injection** — constrói `sh -c 'tmux pipe-pane ...'` por interpolação de strings. Usar argv. |
| 6 | `ipc/board.rs`, `ipc/card.rs`, `ipc/workspace.rs` | **IPC sem validação de input** — `workspace_id`, `card_id` chegam como `String`/`i64` brutos, gerando erros confusos no DB. Adicionar validation layer. |
| 7 | `lib.rs:40-50` | **`std::sync::Mutex` sobre `.await`** — `gbrain` field pode causar deadlock no runtime tokio se lock atravessar `.await`. Auditar call sites ou trocar para `tokio::sync::Mutex`. |
| 8 | `.github/workflows/` | **Sem CI para unit tests** — só existe workflow E2E. PRs podem mergear com testes quebrados. Adicionar `test.yml` com `cargo test` + `npm test`. |
| 9 | `ipc/card_lifecycle.rs` | **Zero testes** para `card_promote` — path crítico que cria issues no GitHub, adiciona labels e muta o DB. |

---

## MÉDIO (planejar correção)

| # | Arquivo | Problema |
|---|---------|----------|
| 10 | `gh/client.rs:100+` | Paginação GitHub sequencial — centenas de issues = 10s+ de bloqueio. Stream ou paralelizar. |
| 11 | `sync/worker.rs:50-70` | Lock per-workspace + I/O de rede = bloqueio indefinido se rede travar. Adicionar timeout. |
| 12 | `lib.rs` ~200 linhas | `run()` mistura setup, IPC registration e teardown. Extrair em `init_db`, `init_sync`, `init_gestor`, etc. |
| 13 | `db.rs` | Pool sem `max_connections` explícito; `card_lifecycle.rs` usa `unwrap_or_default()` que engole erros de DB. |
| 14 | `src/lib/ipc.ts` | Apenas 2 testes (terminalOpen mapping). `claudeSessions` tem snake_case→camelCase mapping sem cobertura, mesma classe de bug BUG-001. |
| 15 | `src/store/commandFrequency.ts` | Store com lógica de sanitize/prune/topCommands **sem nenhum teste**. |
| 16 | 3 arquivos de teste Rust | `test_pool()` duplicado com divergência — `outbox_tests.rs` cria tabelas via SQL bruto em vez de `sqlx::migrate!()`. |
| 17 | `Cargo.toml` | `tokio = { features = ["full"] }` — features desnecessárias aumentam compile time e binary size. |
| 18 | `scripts/release.sh:49` | `mktemp` sem `-d` gera path de arquivo, não de diretório — quebra o `--sign` mode. |
| 19 | `e2e/specs/smoke.e2e.mjs` | Só testa que `#root` existe. Zero cobertura funcional de board, terminal, sync. |

---

## BAIXO (melhorias futuras)

| # | Problema |
|---|---------|
| 20 | `pty.rs` tem `#![allow(dead_code)]` crate-level que esconde warnings reais |
| 21 | Mensagens de erro misturam PT/EN em `AdeError::Other` |
| 22 | `vite.config.ts`: `strictPort: false` pode causar Tauri conectando ao Vite errado |
| 23 | Migration `agent_event.task_id` sem FK constraint; `issue_proposal.card_id` idem |
| 24 | `src/store/store.test.ts` é placeholder `expect(true).toBe(true)` |
| 25 | `mockBackend.ts` (684 linhas) sem testes |
| 26 | `notify.rs` descarta erros de `app.emit()` silenciosamente |
| 27 | `release.sh` tem versão hardcoded no nome do DMG |

---

## Top 3 ações recomendadas

1. **Eliminar shell injection** — `gates.rs` e `term_monitor.rs` são o risco de segurança mais urgente
2. **Adicionar CI de unit tests** — sem ele, qualquer PR quebra gate em silêncio
3. **Remover `unwrap()`/`expect()` de produção** — violação direta da regra hard do AGENTS.md