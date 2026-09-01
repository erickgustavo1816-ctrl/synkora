# HANDOFF — Sessão 2026-09-01 (browser: ABA POR IDENTIDADE + PORTA POR AJUDANTE)

Orquestrador + frota Opus (3 agentes, fronteiras disjuntas, mesma árvore).
Design vinculante: `.synkora/reports/DESIGN_BROWSER_ABAS_POR_IDENTIDADE_2026-09-01.md`
(reports por fatia em `.synkora/reports/browser-tabs-agent-{A,B,C}-report.md`,
provas de vermelho `*-red-proof.txt`, prova visual `browser-tabs-agent-C-*.png`).

## A pergunta do dono e o que foi MEDIDO

"Os ajudantes têm acesso às skills? Têm usado? Por que não usam o browser?
Queria cada um na sua aba, na sua porta." Medido nas transcrições reais dos
CLIs (a caixa-preta não atribui):

- Skills: o ajudante herda a pasta do worktree (`.claude/skills`/`.agents/skills`)
  e a persona com o cardápio + a lei. Uso: claude 7 de 107 ajudantes chamaram a
  tool Skill; codex 22 de 91 leram SKILL.md (20 dos 23 recentes). Ponto cego:
  `skill-entered` só existe para chat codex; ajudante não tem sinal nenhum.
- Browser: desde 29/08, 1 de 72 ajudantes claude dirigiu o browser; 0 de 91
  codex (chats codex: 371 chamadas). O único que dirigiu colidiu com o dev na
  MESMA aba (missão 86a05c06: portas 8791 × 8159/8148/8163 alternando na aba
  e49ffcb2; 3 leituras do ajudante caíram na página do dev; cancelado aos 20 min).
  Nenhuma tool sobe servidor; porta não é reservada; `browser-open` no diário
  saía sem `paneId`.

## O que foi ENTREGUE (branch `browser-helper-tabs`)

- **D1/D2 — aba por identidade** (`browserPane.ts` + `browserTabOwner.ts` +
  `guiBrowserTools.ts`): toda aba tem dono (`user`/`dev`/`helper`/`agent`);
  `ensureTab(…, owner)` reusa/cria A aba da identidade (nasce ativa; navegar
  depois não rouba a vista do dono); `tabOf`, `closeTabsOf`, ⚡ por aba;
  `captureReadiness`/`setViewportMode`/`viewportOf` com `tabId`; teto 8 → 12;
  `browser_open` perdeu `tabId` e lista as abas com o dono de cada; toda tool
  opera SÓ na aba da identidade (recusa nomeia `browser_open`).
- **D3 — a aba do ajudante morre com ele**: `onHelperDisposed` no dispose do
  processo → `closeTabsOf(helper-mcp-<id>)` (fiado em `index.ts`).
- **D4 — porta por ajudante** (`guiHelperPorts.ts` + `guiDelegationWiring.ts`):
  pool determinístico 47100..47499 (FNV do helperId; idempotente; salta
  reservadas), reservada ANTES do spawn, no env (`SYNKORA_HELPER_PORT` + `PORT`),
  na persona (linha própria só quando reservada) e no mapa do "▶ testar"
  (`paneLifecycle.harnessPortsInUse`); liberada no dispose.
- **D6 — autoria no diário**: `browser-open`/`browser-tab-open` com `ids.paneId`
  e `detail.owner`; evento novo `browser-owner-tabs-closed`.
- **Personas**: `EMBEDDED_BROWSER_ORDER` reescrito ("a aba é SUA"; ajudante com
  aba e porta próprias; lista é consciência, não volante). Tetos: contrato
  13300 → 14500; bloco do browser 2500 → 3100.
- **Renderer** (`BrowserChrome.tsx`, `dockBrowserModel.ts`, preload): ficha do
  dono em caixa alta por aba (DEV / nome do ajudante), ⚡ por aba, resumo da
  seção nomeia quem dirige, piso de 176px mantém só a identidade; validado em
  tela real com o CSS real (Electron offscreen, app do dono nunca aberto).
- **Cortes da regra das ~1000 linhas**: `browserPane.ts` 1369 → 1221 com quatro
  irmãos novos (`browserPaneContracts.ts` 288, `browserPaneGestures.ts` 224,
  `browserPaneUrl.ts` 105, `browserTabOwner.ts` 110).
- **Gate**: suítes novas `test:gui-helper-ports` e `test:dock-browser-tabs` no
  `test:gui-system`; `test:browser-pane` 98, `test:browser-driver` 39,
  `test:gui-delegation-wiring` 112, `test:gui-mission-contracts` 77,
  `test:gui-delegation-defaults` 24, `test:gui-helper-ports` 9,
  `test:dock-browser-tabs` 7 — todas com prova de vermelho no código velho.

## POUSO (o que a próxima sessão precisa saber)

- A árvore principal (`nivel5-fase1`) tinha 35 arquivos SEM COMMIT (delegação do
  planejador + vigia de versão dos CLIs). Esta branch nasceu de um SNAPSHOT
  desse WIP (commit `wip: snapshot…`), então o commit da feature aplica limpo
  por cima dele. A sessão paralela do conserto dos ajudantes que fechavam como
  `failed` (branch `claude/beautiful-austin-4153ff`) fez o MESMO (commit
  `a12ed70` = espelho do WIP + `6e896ee` fix). Receita: commitar o WIP em
  `nivel5-fase1` UMA vez; depois `git cherry-pick` do commit de feature de cada
  branch (o snapshot de cada uma NÃO se cherry-picka).
- `.synkora/` é ignorado pelo git: design, reports e PNGs desta rodada foram
  copiados para `.synkora/reports/` da árvore principal. O worktree
  `Synkora-wt-browser-tabs` tem junction de `node_modules` — remover a junction
  com `rmdir` SEM recursão antes de `git worktree remove`.
- **Main/preload novos exigem derrubar e resubir o `npm run dev`** (o app do
  dono estava de pé com ajudantes vivos durante a rodada; restart não foi feito).

## PENDÊNCIAS NOMEADAS

- Chip de skill/browser na FICHA do ajudante (lateral) + sinal `skill-entered`
  de ajudante no diário: exigem `guiHelperSessions.ts` (motor), em obra na
  sessão paralela — próxima rodada.
- `browserPane.ts` em 1221 linhas: o closure do motor (~950) só desce com
  refatoração (contexto injetado para geometria/ciclo de aba), não com movimento.
- Apelido do ajudante no mapa de portas: `GuiHelperSpawnRequest` não carrega
  `name` (mora no `GuiHelperRecord`); o mapa mostra o id curto até o motor
  carregar o apelido no pedido (uma linha em `reserveGuiHelperPort`).
- `taken` do pool não é alimentado com o mapa do harness (evita ciclo com
  `paneLifecycle`); risco remoto (faixa 47100+ × portas 3000/4200/5173/8xxx).
- Sondagem real de porta livre (`net.listen(0)`) só se o pool colidir na prática.
- Validação AO VIVO (dev + 2 ajudantes abrindo abas próprias, ⚡ por aba, porta
  no mapa do "▶ testar") depende do restart.
