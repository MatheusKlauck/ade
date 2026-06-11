# DECISIONS — implementer's log

Append-only. One entry per deviation/ambiguity resolution. Format:

```
## <date> — <task id>
**What:** <the deviation or choice>
**Why:** <one or two lines>
**Where:** <files / CONTRACTS section updated>
```

## 2026-06-10 — plan review (pre-M0), patch #1
**What:** Migrações são append-only. `last_attempt_at` (outbox) entra em
`0002_outbox_last_attempt.sql`; a flag `labels_ensured` (sync_state) entra em
`0003_sync_labels_flag.sql`. Proibido editar um arquivo de migração já aplicado.
**Why:** M5-T3 dizia "add column via migration 0002 if M2-T6 didn't already create it";
`sqlx::migrate!` valida checksums e travaria o startup ("previously applied but has been
modified") em todo DB de dev existente.
**Where:** CONTRACTS §4 (nota append-only), M2.md (M2-T6), M5.md (M5-T3).

## 2026-06-10 — plan review (pre-M0), patch #2
**What:** `card_promote` passa a aplicar o label `kanban:*` da coluna atual quando a
coluna ≠ Backlog, logo após criar a issue.
**Why:** A issue criada não tinha nenhum label kanban; assim que `updated_at` mudasse, o
reconcile §12 linha 7 movia o card promovido (Doing/Paused/PR) silenciosamente para
Backlog, pois a coluna nunca era representada no remoto.
**Where:** CONTRACTS §7 (card_promote), M5.md (M5-T5 steps + DoD).

## 2026-06-10 — plan review (pre-M0), patch #3
**What:** Removido `If-None-Match`/304 do fetch incremental. `sync_state.list_etag` fica
reservado/sem uso em v1.
**Why:** `since` avança a cada ciclo → a URL muda → o ETag armazenado nunca casa. A
otimização de 304 nunca dispararia em produção; só passava no teste isolado.
**Where:** CONTRACTS §11 (incremental), M2.md (M2-T7 DoD (d) trocado por teste de
`body_preview` 280 chars multibyte).

## 2026-06-10 — plan review (pre-M0), patch #4
**What:** Drop de intent no outbox passa a depender de mudança de coluna, não de qualquer
`updated_at`. Payload do outbox ganha `from_column_name`. Sender compara
`desired_column(remote_now)` com `from_column`: igual ⇒ prossegue; diferente ⇒ drop +
`INTENT_DROPPED`.
**Why:** A regra antiga descartava o move do usuário por qualquer toque remoto não
relacionado (um comentário bumpava `updated_at`). "Remote wins" agora vale só em conflito
real de coluna.
**Where:** CONTRACTS §4 (payload), §13 (enqueue + sender passo 1), M2.md (M2-T6 enqueue,
M2-T8 cenário 3 + 2ª asserção).

## 2026-06-10 — plan review (pre-M0), patch #5
**What:** `PRAGMA busy_timeout=5000` adicionado junto do WAL na abertura do pool.
**Why:** Worker de sync + handlers IPC escrevem concorrentemente; o lock de escritor único
do SQLite apareceria como `SQLITE_BUSY` intermitente sem busy timeout.
**Where:** CONTRACTS §4 (nota), M0.md (M0-T3 steps).

## 2026-06-10 — M0-T6
**What:** Adicionado `keyring-core = "1.0.0"` como dependência direta. O `keyring` v4.0.1
mudou a API: Entry vive em `keyring_core` com métodos `set_password`, `get_password`,
`delete_credential`. `delete_password` não existe.
**Why:** As funções livres `keyring::set_password` / `get_password` / `delete_password`
não existem em v4.0.1; os métodos Entry estão em `keyring-core`.
**Where:** `Cargo.toml` (keyring-core), `src/ipc/github.rs`.

## 2026-06-10 — M2-T4
**What:** `card_delete` added to CONTRACTS §7 table.
**Why:** The command was implemented in M2-T1 (board.rs) and registered in lib.rs but was missing from the IPC surface table.
**Where:** CONTRACTS §7.

## 2026-06-10 — M2-T6
**What:** Added `last_attempt_at` column to outbox table via migration 0002.
**Why:** Backoff calculation needs the timestamp of the most recent failure attempt; CONTRACTS §13 specifies "from created_at+last attempt time" for delay calculation. Added as a new migration (append-only policy).
**Where:** migrations/0002_outbox_last_attempt.sql, CONTRACTS §4.

## 2026-06-11 — M2-T7
**What:** Added `reqwest = "0.12" (features: json)` as a direct dependency. Moved `RemoteIssue`, `SyncAction`, `ColumnName` from `sync/engine.rs` to `gh/types.rs`.
**Why:** GitHub client needs injectable base URL for wiremock testing. `octocrab` doesn't expose a way to override the base URL easily; `reqwest` is already a transitive dep (via octocrab/tauri) and is the standard HTTP client for Rust. Making it a direct dep allows `GitHubClient` to use it with custom base URLs. Types moved per CONTRACTS §2 layout (RemoteIssue → gh/types.rs, §5 serde derives).
**Where:** Cargo.toml (reqwest added), CONTRACTS §1 (reqwest added), gh/types.rs (new), sync/engine.rs (imports changed).

## 2026-06-10 — M2-T8
**What:** Em `run_cycle`, o descarte de intent em conflito de coluna passou a ocorrer
**antes** de `reconcile` (drop-before-reconcile), não depois. A detecção (§13 passo 1)
compara `desired_column(remote)` com `from_column_name`; havendo conflito real, o intent é
deletado do outbox (na transação) e removido do mapa de pendências em memória, então
`reconcile` vê `pending = None` e a §12 Row 7 move o card para a coluna remota no mesmo
ciclo. A notificação `INTENT_DROPPED` continua adiada para depois do `tx.commit()`.
**Why:** §13 manda "reconcile card to remote state" no ato do descarte. Na ordem anterior
(reconcile→drop), a Row 4 retornava `Ignore` por causa do intent pendente e o card só
seria movido no ciclo seguinte. Também: o fixture dos testes do worker passou a emitir JSON
no formato da API do GitHub (labels como `[{"name":...}]`, assignee `{"login":...}`) em vez
de serializar `RemoteIssue`, pois `gh::client::map_issue` descarta labels-string no
round-trip.
**Where:** `src-tauri/src/sync/worker.rs` (run_cycle + helper `parse_column_name` + fixture
`issue_json`).

## 2026-06-11 — M4-T2
**What:** card_move trigger uses direct DB queries for workspace/column lookup; sync moves use a separate internal function that cannot reach this trigger (by design, per §16). The trigger fires only when the target column name is "Doing". For linked cards (source=github with issue number), it uses `new_issue_window` with env vars and runs `prepare_branch`. For local cards, it uses `new_app_window` with a renamed window. Re-focus of existing terminal_window_id is handled by checking `tmux::window_alive` first. After trigger, `terminal_window_id` is persisted on the card and `evt:terminal_focus` is emitted.
**Why:** Per CONTRACTS §16, the auto-launch trigger must only fire on user drag (not sync moves). The card_move IPC handler is the only entry point for user drags.
**Where:** `src-tauri/src/ipc/board.rs` (card_move), `src-tauri/src/gitlocal.rs` (prepare_branch).