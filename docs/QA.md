# QA — rodando o gstack contra a app inteira

Como expor o ADE para o **gstack** dirigir a aplicação **real** (terminais tmux,
sync GitHub, webview de verdade) via **WebDriver**, e o que isso cobre.

> TL;DR: o gstack roda o **binário real** num runner **Linux** sob `tauri-driver`.
> Dados mockados *não* entram aqui — o objetivo é testar a app de verdade, então o
> backend roda inteiro. Um único bolsão fica de fora da automação: o chrome nativo
> **exclusivo do macOS** (traffic lights + arraste de janela entre telas), que vira
> checklist manual num Mac.

## Por que Linux + WebDriver (e não macOS)

A automação do binário Tauri usa `tauri-driver`, que envolve o WebDriver nativo da
plataforma. Pela [doc oficial](https://v2.tauri.app/develop/tests/webdriver):

> "On desktop, only Windows and Linux are supported due to macOS not having a
> WKWebView driver tool available."

Ou seja: **nenhuma** ferramenta dirige o app nativo do macOS via WebDriver. O bom é
que o backend do ADE é cross-platform (`portable-pty` + `tmux`, `sqlx`/SQLite,
`octocrab`), então no Linux a app roda **inteira de verdade** — terminais reais,
sync real. O gstack opera no Linux; o macOS só precisa do checklist manual abaixo.

## Matriz de cobertura

| Área | Automação (Linux/WebDriver) | Observação |
|---|---|---|
| Kanban: colunas, cards, paginação 10/col, DnD, detalhe | ✅ | precisa do seed determinístico |
| Workspaces: abas, troca, multi-workspace | ✅ | |
| Settings, Notification Center, tema dark/light | ✅ | |
| Chip de sync (idle / syncing / error) + re-sync | ✅ | seed/estado controlado |
| Onboarding / empty state | ✅ | DB vazio |
| **Terminais reais (tmux/PTY)** | ✅ | tmux instalado no runner |
| **Sync GitHub** | ✅ | apontar p/ repo de teste ou mock de API |
| Auto-updater | ⚠️ | só faz sentido em build empacotado/assinado |
| Traffic lights + arraste de janela entre telas (macOS) | ❌ manual | sem WebDriver no macOS; checklist manual |

## Componentes da solução

1. **Harness WebDriver** — `e2e/` (pasta isolada, `package.json` próprio, não toca
   o build do app). Config WebdriverIO + `tauri-driver`, adaptada do exemplo
   oficial do Tauri. Já incluído.
2. **Runner Linux** — `.github/workflows/e2e.yml`. Instala `webkit2gtk` +
   `WebKitWebDriver` + `tmux` + `xvfb`, compila o app (`tauri build --debug
   --no-bundle`), sobe o `tauri-driver` e roda as specs sob display virtual.
   Serve tanto como CI quanto como **especificação executável do ambiente** que o
   gstack precisa replicar. Já incluído.
3. **Selectors estáveis** — `data-testid` nos elementos dinâmicos/estruturais
   (abas, colunas, cards, paginação, chip de sync, panes de terminal, etc.).
   _Próximo incremento_ — sem isso a suíte do gstack fica frágil.
4. **Seed determinístico de QA** — estende o `seed_dev_workspace()` existente
   (`src-tauri/src/lib.rs`), gated por `ADE_QA_SEED=1`: insere workspace + colunas
   + ~15 cards canônicos (exercita a paginação). _Próximo incremento._
5. **Checklist manual macOS** — abaixo.

## Como o gstack roda (Linux)

Pré-requisitos no runner:

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev webkit2gtk-driver libgtk-3-dev \
  librsvg2-dev libayatana-appindicator3-dev tmux xvfb
cargo install tauri-driver --locked
```

Build + execução:

```bash
npm ci                       # deps do app
npm --prefix e2e install     # deps do harness (WebdriverIO)
ADE_QA_SEED=1 xvfb-run -a npm --prefix e2e test
```

O harness:
- compila o binário real com `tauri build --debug --no-bundle`
  (binário em `src-tauri/target/debug/ade`; sobrescreva com `ADE_BINARY=...` se o
  nome diferir),
- sobe o `tauri-driver` em `127.0.0.1:4444`,
- roda as specs em `e2e/specs/**/*.e2e.mjs`.

A suíte completa o gstack escreve contra os `data-testid` (item 3). O `smoke.e2e.mjs`
incluído só prova que o pipeline conecta (driver → webview → DOM).

## Checklist manual (macOS — o que a automação não alcança)

Rodar num Mac real, no binário de produção (`npm run tauri build`):

- [ ] Arrastar a janela pela barra de título (áreas vazias) e **mover para outro monitor**.
- [ ] Clicar abas, ×, sino, engrenagem, chip de sync — todos respondem (não "engolidos" pela região de arraste).
- [ ] Traffic lights (fechar/minimizar/zoom) na posição correta e funcionais.
- [ ] Tema dark/light reflete no chrome.

## Pendências (próximo incremento)

- [ ] `data-testid` nos componentes (selectors estáveis).
- [ ] `ADE_QA_SEED` no backend (board/cards determinísticos).
- [ ] Repo GitHub de teste **ou** mock de API p/ exercitar o sync de forma determinística.
- [ ] Confirmar o nome real do binário no runner (`ls src-tauri/target/debug/`).
