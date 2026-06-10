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
