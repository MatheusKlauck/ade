# Como solucionar as falhas de teste do M2-T8

`cargo test` → **54 passaram, 2 falharam, 4 ignorados**. Este documento explica a
causa-raiz de cada falha e como corrigir. **Nada foi alterado no código** — é só diagnóstico.

Falhas:
- `sync::worker::tests::scenario_2_echo_suppression`
- `sync::worker::tests::scenario_3_remote_change_beats_queued_move`

Passam: `scenario_1`, `intent_in_backoff_suspends_reconcile`, e os 12 testes puros do
`engine`. Isso é a pista que aponta a causa.

---

## Causa-raiz 1 — labels não sobrevivem ao round-trip JSON (bug de fixture de teste)

**Afeta:** `scenario_2` (totalmente) e parte de `scenario_3`.

### O que acontece

`RemoteIssue.labels` é `Vec<String>` (nomes apenas). Os testes do worker constroem um
`RemoteIssue` com `make_issue(...)` e o serializam para alimentar o wiremock:

```rust
let echo_issue = make_issue(10, "open", &["kanban:doing"], "2025-01-02T00:00:00Z");
let body = serde_json::to_string(&vec![echo_issue]).expect("json");
```

Isso produz `"labels":["kanban:doing"]` — um **array de strings**.

Mas o `GitHubClient` consome **JSON cru da API do GitHub**, e `gh/client.rs::map_issue`
lê labels como **array de objetos** `{"name": ...}`:

```rust
let labels = item.get("labels").and_then(|l| l.as_array()).map(|arr| {
    arr.iter().filter_map(|l| l.get("name").and_then(|n| n.as_str()).map(...))...
});
```

Para o elemento string `"kanban:doing"`, `l.get("name")` é `None` → o label é
**silenciosamente descartado**. Depois do round-trip, `labels` chega **vazio** ao
`reconcile`.

### Por que produz exatamente o erro observado

- `scenario_2`: sem labels, `desired_column(open, [])` = **Backlog**, mas o card está em
  **Doing** → `reconcile` cai na Row 7 e **move o card para Backlog**. O teste esperava
  "stay in Doing". O `left` do panic (`a497...`) é o id da coluna **Backlog**, não Doing.
- `scenario_3` (card A): `#55` perde o `kanban:doing` → `desired_now` = Backlog =
  `from_column` → o passo de conflito **não dispara** (acha que foi só um comentário) → o
  intent não é descartado e o card fica em Backlog. (Falha também a asserção de
  `INTENT_DROPPED`.)

`scenario_1` passa porque a issue está **closed** (`desired = Done` independe de label).
`intent_in_backoff` passa porque a issue **não tem label** de propósito (o bug não muda nada).

> Importante: **isto não é bug de produção.** Em produção o cliente recebe JSON real do
> GitHub, onde labels já são `[{"name": "..."}]`. O defeito está apenas no fixture de teste,
> que serializa `RemoteIssue` em vez de emitir o formato da API.

### Como solucionar

Nos testes do worker, parar de serializar `RemoteIssue` e emitir **JSON no formato da API
do GitHub**, como `gh::client::tests::issue_json` já faz. Em vez de `make_issue` +
`serde_json::to_string`, usar um helper que devolva, por issue:

```json
{
  "number": 10,
  "title": "Issue #10",
  "state": "open",
  "updated_at": "2025-01-02T00:00:00Z",
  "assignee": null,
  "labels": [{ "name": "kanban:doing" }],
  "html_url": "https://github.com/testowner/testrepo/issues/10",
  "body": null
}
```

Pontos de atenção ao escrever o helper:
- `labels` → array de **objetos** com chave `name`.
- `assignee` → `null` ou objeto `{"login": "..."}` (nunca string nua), porque `map_issue`
  lê `assignee.login`.
- PR → incluir a chave `"pull_request": {}` (o `is_pull_request` serializado **não** é lido
  pelo cliente; ele detecta PR pela presença da chave `pull_request`).

Depois dessa correção, `scenario_2` passa. `scenario_3` ainda falha — ver Causa-raiz 2.

---

## Causa-raiz 2 — o descarte de intent não reconcilia o card no mesmo ciclo (bug de lógica)

**Afeta:** `scenario_3` (asserção "card A should be moved to Doing").

### O que acontece

A ordem atual em `run_cycle` é: **(a)** chamar `reconcile` → com intent pendente, a Row 4
retorna `Ignore` (não move); **(b)** depois, no passo 7, detectar o conflito de coluna e
**apagar o intent** — mas **sem aplicar** o estado remoto ao card.

Resultado: no conflito genuíno, o intent é descartado, porém o card só seria movido para a
coluna remota **no ciclo seguinte** (quando `reconcile` já não vê pendência). O
`scenario_3` espera que o card A vá para **Doing no mesmo ciclo**, conforme §13
("drop intent ... reconcile card to remote state").

### Como solucionar

Inverter a ordem: **detectar o conflito e descartar o intent ANTES de chamar `reconcile`**
para aquela issue. Assim, ao reconciliar, a pendência já não existe → a Row 7 dispara
naturalmente e move o card para `desired_column(remote)`, dentro da mesma transação.

Esboço da reestruturação do laço (por issue):

1. Se há intent pendente para o card, calcular `desired_column(remote)` vs `from_column`.
2. Se **diferem** (conflito real): remover o intent do mapa de pendências **e** do banco
   (`DELETE ... outbox`), e enfileirar `INTENT_DROPPED`.
3. Chamar `reconcile(remote, snapshot, pending)` — agora `pending` é `None` para os casos
   descartados, então a Row 7 produz `MoveCard`; para os não-conflitantes, `pending`
   continua `Some` e a Row 4 mantém `Ignore`.

Isso preserva os outros casos:
- `scenario_3` card B (só comentário, `desired == from`): sem conflito → pendência mantida
  → Row 4 `Ignore` → fica em Backlog, intent permanece. ✔
- `intent_in_backoff` (sem label, `desired == from`): idem, fica em Paused. ✔
- `scenario_2` (sem pendência): inalterado, Row 6 `RefreshCardFields`. ✔

> Alternativa de menor esforço (se preferir não mexer na lógica agora): ajustar a
> expectativa do `scenario_3` para que o card A só apareça em Doing **no ciclo seguinte**
> (rodar `run_cycle` duas vezes). Mas isso diverge da §13, que manda reconciliar o card no
> ato do descarte — a correção de lógica é a fiel ao contrato.

---

## Warnings do compilador (não bloqueiam testes)

Todos esperados para um spike ainda não conectado à aplicação; não são erros.

- `unused variable: from_col_str` (`worker.rs:181`): na closure que monta `PendingIntent`,
  `from_col_str` é extraído mas nunca usado (só `to_col` é). **Solução:** remover a linha ou
  renomear para `_from_col_str`.
- `trait Notifier / NoopNotifier / CaptureNotifier / run_cycle is never used`: nada na app
  chama `run_cycle` ainda — é o spike do M2-T8. **Solução:** silenciar com
  `#[allow(dead_code)]` (consistente com o resto do arquivo) até o M5-T3 fiar o worker no
  builder do Tauri; nesse momento os warnings somem sozinhos.

---

## Ordem sugerida e verificação

1. Corrigir o fixture (Causa-raiz 1) → `scenario_2` passa.
2. Reestruturar o descarte/reconcile (Causa-raiz 2) → `scenario_3` passa.
3. Limpar `from_col_str` e (opcional) os `dead_code`.
4. `cargo test` deve fechar com **56 passaram, 4 ignorados, 0 falharam**.
5. Só então marcar `M2-T8` em `plan/PROGRESS.md` e registrar a decisão em
   `plan/DECISIONS.md` (os 4 ignorados são `needs-tmux`/`needs-keychain`, esperados sem
   ambiente).
