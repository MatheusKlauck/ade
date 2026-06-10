# Avaliação adversarial — PLANO-ADE-v1

> Contexto assumido (confirmado): uso solo, repos próprios. Achados ordenados por severidade.
> Objetivo: insumo para a v2. Decisões pendentes no final.

---

## A. Críticos — inconsistências que quebram o design como escrito

### A1. O fallback de tmux é incoerente entre as seções 3.1, 3.2, 3.10a e os milestones

O plano diz três coisas que não podem ser todas verdade ao mesmo tempo:

1. **3.1 (fallback):** "começar com PTY direto (shell do usuário, um PTY por pane) e usar tmux por comandos (`new-window`, `send-keys`) para as features 5 e 6".
2. **3.2 / M3:** "cada workspace mapeia para uma sessão tmux nomeada" já no M3.
3. **3.10a:** "terminais reanexam via sessão tmux nomeada".

Se os panes são PTYs diretos (shell puro, fora do tmux), então: (a) não existe sessão tmux por workspace; (b) nada "reanexa" — fechar o app mata todos os shells; (c) `tmux new-window` da feature 6 cria uma janela numa sessão tmux que **o app não renderiza** — o terminal disparado pelo card simplesmente não aparece na UI. O fallback, como escrito, quebra a feature 6 e a persistência prometida em M3.

**Caminhos possíveis (escolher um na v2):**
- **Nested attach:** cada pane é um PTY direto rodando `tmux attach -t sessão:janela`. Dá persistência e feature 6 desde o M1, ao custo de renderizar o tmux "desenhando" dentro do xterm.js (perde parte do ganho do control-mode, mas funciona e é simples). O `-CC` vira otimização posterior real, porque o modelo "tudo vive no tmux" já está certo.
- **PTY puro até M4:** aceitar explicitamente que até M4 não há persistência nem feature 6, e mover a promessa de "sessão tmux por workspace" do M3 para o M4.

### A2. "Migra-se para control-mode sem mexer no frontend" é otimista demais

A afirmação de que a interface `Channel<PtyEvent>` "é a mesma" esconde diferenças de contrato:

- No `-CC`, a saída não é bytes crus de um PTY: chega como linhas `%output %<pane> <texto com escapes octais>` — exige parse e unescape por chunk, e a "estratégia de performance" da seção 5 (bytes crus, sem serialização) **não se aplica** a esse modo.
- Control mode tem **flow control próprio** (`%pause`/`%continue` em saída pesada) que o cliente precisa tratar — exatamente o cenário "cat de arquivo grande" usado como benchmark na seção 2.
- Resize, ordering entre panes e input (via `send-keys`, não write no PTY) têm semântica diferente.

O frontend pode até sobreviver, mas o core Rust muda substancialmente. A v2 deve tratar `-CC` como um backend distinto com contrato próprio, não como troca transparente — e a meta de 60fps precisa ser re-validada nesse modo.

### A3. "Remoto vence, sempre" + outbox tem corridas não tratadas

O modelo "GitHub é a fonte da verdade, outbox para escrita" elimina UI de conflito, mas o plano não define o protocolo que evita estes três bugs:

1. **Reconciliação atropela escrita pendente:** usuário move card → entra no outbox → o poll roda antes do flush → remoto ainda diz coluna antiga → "remoto vence" reverte o card → depois o outbox aplica a intent → card volta. Ping-pong visível. *Regra necessária: cards com entrada pendente no outbox são excluídos da reconciliação.*
2. **Eco da própria escrita:** o app aplica `kanban:doing` → o próximo poll vê a issue "mudada" (foi o próprio app) → dispara reconciliação/eventos à toa. *Necessário ignorar mudanças cujo estado remoto já coincide com o local, ou marcar writes próprios.*
3. **Intent obsoleta:** offline, intent "mover para Doing" fica na fila; nesse meio tempo a issue é fechada no GitHub; ao voltar, o outbox reabre/rotula uma issue que o remoto fechou — contradizendo "remoto vence". *Necessário invalidar entradas do outbox quando o snapshot remoto muda após o enfileiramento.*

O trade-off declarado ("pode parecer desfeita por um instante") subestima o caso offline: pode ser horas, não um instante.

### A4. Puxar só issues **abertas** torna "remoto vence" cego para o evento mais importante

Se o sync lista apenas `state=open`, uma issue **fechada no GitHub** enquanto o card está em Doing simplesmente **desaparece da resposta** — indistinguível de transferida/deletada. O app não tem como reconciliar o caso mais comum de mudança remota. A seção 3.4 também ignora o mecanismo incremental padrão do GitHub: o parâmetro **`since`** no list de issues, que resolve isso de forma barata (`state=all&since=<último sync>` retorna só o que mudou, incluindo fechamentos). O ETag por issue no schema (ver B2) não compensa, porque o fluxo descrito poll-a a *lista*, não issues individuais.

### A5. O gatilho da feature 6 está subespecificado e conflita com o sync

"**Todo** card movido para Doing abre um terminal" — movido **por quem**?

- Reconciliação remota move o card para Doing (alguém/outra máquina aplicou `kanban:doing`) → abre terminal sozinho?
- Outbox falha e o card **reverte** de Doing (A3) → o terminal já aberto vira órfão. Fecha? Mantém?
- Mover Doing → Doing (reorder na coluna), ou Doing → Paused → Doing duas vezes em um minuto → dois terminais?

*Regra mínima para a v2: só drag explícito do usuário dispara; revert não fecha terminal (apenas notifica); re-entrada em Doing com janela/pane já existente para aquele card foca em vez de criar.*

---

## B. Médios — erros factuais, lacunas de schema e segurança

### B1. `GET /repos/{o}/{r}/issues` retorna **pull requests também**

A API REST do GitHub considera todo PR uma issue. "Puxar todas as issues abertas" sem filtrar o campo `pull_request` enche o Backlog com PRs. Filtro obrigatório, não opcional.

### B2. O `etag` por card no schema não é usado por nenhum fluxo descrito

O sync descrito é polling da **lista** (um ETag só, que invalida com qualquer mudança no repo e re-pagina tudo). O ETag por issue só serviria se o app poll-asse issue a issue — que ninguém propõe. Ou remova a coluna, ou redesenhe o sync (recomendado: `since` incremental, A4; aí `remote_updated_at` basta e `etag` por card sai).

### B3. "Colunas configuráveis" × mapeamento fixo coluna→label

A tabela da 3.4 hardcoda 5 colunas com labels fixas. Se o usuário renomear/adicionar/remover colunas (prometido na feature 1), o que acontece no GitHub? Indefinido. Para a v2: ou (a) colunas **fixas** na v1 (corta "configuráveis"), ou (b) `board_column` ganha `github_label` + flags `is_done_column`/`triggers_terminal`, e a semântica vem da coluna, não do nome.

### B4. Injeção de shell via título da issue

Passo 5 da feature 6 exporta `ISSUE_TITLE` como env var "no pane". Se isso for implementado via `send-keys "export ISSUE_TITLE=\"...\""` (o caminho natural no fallback), um título de issue contendo `$(...)` ou aspas executa código no shell do usuário. Título de issue é input não confiável mesmo em repo próprio (bots, issues abertas por terceiros). *Setar env no spawn do PTY (env do processo) ou `tmux new-window -e VAR=...` — nunca interpolar em linha de comando.* O mesmo vale para o nome da janela (`#123-fix-login`) derivado do título.

### B5. Criação de branch ignora estados reais do git

`git checkout -b issue-123` falha se a branch existe e muda worktree sujo de contexto. Definir: branch existente → reusar (checkout simples); worktree sujo → não trocar de branch, abrir terminal mesmo assim e notificar. Slugificação do título (unicode, tamanho, colisão) precisa de regra.

### B6. Dono do estado indefinido: Zustand × "o estado vive no Rust + SQLite"

As duas afirmações coexistem sem contrato. Quem é a verdade durante um drag? Para a v2: SQLite é a verdade; mutações sempre via `invoke` (Rust valida, persiste, emite evento); Zustand é cache derivado de eventos, com update otimista apenas visual. Sem isso, o bug clássico é board e banco divergirem após erro.

### B7. Lacunas pontuais de schema

- `card` sem `state` (open/closed) — "Done" e "issue fechada" são coisas distintas (card local em Done não tem state remoto).
- `card.position`: estratégia não definida (re-index a cada drag × fractional indexing). Com "todas as issues abertas" num repo grande, importa.
- `outbox` sem chave de idempotência/dedup (mover o mesmo card 3 vezes = 3 entradas? colapsar para a última intent por card).
- Board mostra labels/assignee? Se sim, precisam ser colunas/tabela; se não, o card vinculado fica visualmente igual ao local.
- `wip_limit` existe no schema e em nenhuma feature — corte ou especifique.
- Rate limit é **por conta**, e o plano cria "um worker tokio" por workspace: N workspaces no mesmo PAT precisam de um coordenador global de budget (a tabela de riscos até diz "um worker por conta", contradizendo a 3.4).

### B8. M5 é o segundo maior risco e está quase no fim

O próprio plano aponta M4 e M5 como caminho crítico, mas empilha os dois no final. O sync bidirecional (A3/A4) é onde o design tem mais incógnitas — um **spike** de sync (pull + outbox + reconciliação num repo de teste) caberia já no M2/M3, antes de construir multi-workspace em cima de suposições.

---

## C. Menores

- **"Open in GitHub"** nomeia uma ação destrutiva-criativa (criar issue) como navegação. Renomear: "Create GitHub issue" / "Publicar no GitHub".
- **Feature 6, cards locais:** "sem os passos 2/4/5" — o passo 2 é *criar a janela*; sem ele não há terminal. O texto quis dizer "sem o **nome** baseado em issue". Reescrever.
- **Lazy mount + WebGL:** dispose incorreto do addon WebGL ao desmontar pane causa context loss/leak; prever fallback para renderer canvas.
- **Keychain em build de dev não assinado:** macOS re-pergunta autorização a cada rebuild (assinatura muda). Conviver ou assinar builds de dev.
- **3.7:** parsing do `remote origin` precisa cobrir SSH (`git@github.com:o/r.git`) e HTTPS; e o fluxo de erro "repo privado + token sem escopo" não está descrito.
- **Roadmap sem critério de aceitação nem testes** em nenhum milestone. Mínimo: testes do parser `-CC` (M4) e do protocolo de reconciliação (M5) — as duas peças com mais estados.
- **Fontes fracas como evidência:** a página do produto e o artigo do "Terax" são marketing, não documentação técnica; o plano usa "padrão validado em produção" como argumento de autoridade. As fontes boas (iTerm2, tmux wiki) sustentam o `-CC`, não a claim de performance. A v2 deve sustentar a meta de 60fps com um benchmark próprio no M1, não com link.
- **Tom:** o plano se autoavalia ("Decisão correta") em vez de argumentar. Inofensivo, mas numa v2 prefira registrar o *porquê* (custo de orquestração de agentes ≫ valor na fase de fundação).

---

## D. O que está certo (verificado)

- **ETag/304 não consome rate limit** — confirmado na doc atual do GitHub, **com a condição** (ausente no plano) de a request ser autenticada com header `Authorization`.
- **Caveat octocrab:** tem tipos de etag, mas a cobertura de conditional requests é parcial — espere usar os métodos crus (`_get`) para o sync condicional, não a API tipada.
- Arquitetura geral (Tauri 2 + Rust core + xterm.js WebGL + bytes crus por Channel **no modo PTY direto**) é sólida e adequada à meta.
- Local × vinculado com promoção explícita (e criação de issue nunca automática) é um bom design — preserve.
- Descartar Projects v2 na v1: correto para uso solo.
- 3.10 (separar persistência de UI de memória de agente): distinção correta e bem argumentada.
- Token no Keychain, nunca em SQLite/TOML: correto.

---

## E. Decisões pendentes para a v2

1. **Backend de terminal M1–M3:** nested `tmux attach` desde o início (persistência + feature 6 cedo, `-CC` vira otimização) **ou** PTY puro com persistência só no M4? (resolve A1)
2. **Gatilho da feature 6:** confirmar "só drag do usuário; revert não fecha terminal; re-entrada foca pane existente". (A5)
3. **Mecanismo de sync:** trocar polling de lista por `state=all` + `since` incremental, removendo `etag` por card. (A4/B2)
4. **Colunas:** fixas na v1, ou `github_label` configurável por coluna? (B3)
5. **Reordenar roadmap:** spike de sync GitHub antes/junto do M3? M5 continua depois de M4? (B8)
6. **Cap no pull inicial** (ex.: 200 issues mais recentes) para repos grandes, ou aceitar backlog gigante?

Respondidas as seis, a v2 sai consistente.
