# Gestor — smoke E2E ao vivo (L2)

Roda o loop inteiro de verdade uma vez: `Backlog → worker → gates → review →
push → PR → merge`. L2 = o Gestor faz tudo **menos o merge**; você aprova o
merge no fim. Use um **repo descartável** — o worker commita código real.

Pré-requisitos: `claude` no PATH (`claude --version`), `tmux` instalado, um
token GitHub (classic, escopo `repo`).

---

## 0. Repo descartável

```bash
gh repo create ade-smoke --private --clone   # ou crie no site e clone
cd ade-smoke
printf "# ade-smoke\n" > README.md
git add . && git commit -m "init" && git push -u origin main
```

Deixe um alvo trivial pro worker: um README pedindo uma função, ou um teste
que falta. Quanto menor a tarefa, mais rápido o loop fecha.

## 1. Sobe o app

```bash
cd /Users/mk/dev/ade
bun run tauri:dev
```

## 2. Adiciona o workspace

Aponte o app pra pasta `ade-smoke` (botão de adicionar workspace → escolhe a
pasta). O owner/repo do GitHub são **auto-detectados** do remote — confirme
que o workspace aparece como GitHub-linked.

## 3. Token do GitHub

Settings → conta/GitHub → cola o token. Ele é validado contra `/user` e
guardado no Keychain **por workspace**. Sem token, o loop trava em `pushing`.

> O worker **nunca** recebe o token (D9) — só o core empurra/abre PR/merge.

## 4. Liga o Gestor (Settings → aba Gestor)

| Campo | Valor | Por quê |
|---|---|---|
| Gestor ligado | ✅ | liga o loop |
| Nível de autonomia | **L2** | despacha worker, **merge humano** |
| Branch base | `main` | de onde sai o worktree / pra onde vai o PR |
| Workers paralelos | `1` | um worker, mais fácil de observar |
| Tentativas máximas | `2` | escala pra você rápido se travar |
| Exigir CI verde | ⬜ (ou ✅ se o repo tem Actions) | espera os checks |
| Comandos de gate | ex. `cargo test` / vazio | build/test antes do review |

Ligar o "Gestor ligado" **aplica na hora** — o loop sobe assim que você marca
o toggle (sem reiniciar). Desligar derruba o loop.

## 5. Dá trabalho pro loop

Crie um card no **Backlog** descrevendo a tarefa (ou use "Enviar para o
Gestor" no menu de um card). Em L2 a ponte autônoma puxa cards do Backlog
sozinha a cada tick (~3s).

## 6. Observa o loop andar

O badge do card + o painel do Gestor mostram o estado. Caminho esperado:

```
queued → preparing → working → verifying → reviewing → pushing → pr_open
       → ci_wait → ready_to_merge  ⟵ PARA AQUI em L2
```

- **working**: tem uma janela tmux com o `claude` mexendo no worktree. Pode
  anexar pra ver: `tmux attach -t <slug>` (procure a window da task).
- **verifying**: rodando os `gate_commands` no worktree.
- **reviewing**: job headless julga o diff contra o issue.
- **ready_to_merge**: o PR está aberto no GitHub. **Você** clica merge (ou a
  ação de merge na UI). Em L3 isso seria automático.

## 7. Fecha

Aprove o merge → o card vai pra `merged → cleanup → done`, o worktree e a
janela tmux somem. Confirme no GitHub que o PR mergeou.

---

## Escape hatches

- **Trava em `awaiting_input`**: estourou `max_attempts` ou o worker pediu
  ajuda. Olhe `fail_reason` no painel; é o gate ou o review reprovando.
- **Trava em `pushing`**: token ausente/sem escopo `repo`, ou owner/repo não
  detectado. Cheque o passo 3.
- **Nada sai de `queued`**: autonomia < L2 (a ponte autônoma só puxa do Backlog
  em L2+).
- **Worker não sobe (`failed` no dispatch)**: `tmux`/`claude` fora do PATH do
  app — veja `ensure_path_env` em `src-tauri/src/lib.rs`.
- **Aborta tudo**: baixe pra L0 na aba Gestor e reinicie; ou feche o
  workspace. Como é repo descartável, `gh repo delete ade-smoke` no fim.

## O que isto valida que o unit não pega

A metade GitHub real: push autenticado, abertura de PR, poll de CI e o gate
de merge humano em L2 — tudo que precisa de remote+token e por isso fica de
fora do smoke headless (`loop_local_half_walks_working_to_pushing_on_real_git`).
