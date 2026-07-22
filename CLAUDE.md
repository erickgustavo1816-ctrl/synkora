# Synkora

ADE (Agentic Development Environment) desktop: projetos como "universos" com departamentos
(PM/Front/Back/QA), orquestradores que delegam tarefas via harness automático para múltiplas
contas de CLIs de IA ("seats").

**Sempre responda ao usuário em PT-BR.**

## Documentos de referência (ler antes de mudanças grandes)

- `docs/PLANO.md` — plano completo v1.1: conceito, stack, domínio, cadeia de comando, roadmap F0–F5, decisões confirmadas.
- `docs/SKILLS.md` — curadoria da biblioteca de skills por departamento (F4).

## Stack e estrutura

Electron + electron-vite + React 19 + TypeScript (strict). Vite fixado em ^7 (electron-vite 5 não suporta Vite 8).

- `src/main/` — main process: janela, IPC, `ProjectStore`, `SeatStore` e `TaskStore` (JSON em userData — decisão consciente: sem SQLite para evitar build nativo; trocar só se a escala pedir), `PtyManager` (@lydell/node-pty, prebuilt, sem node-gyp), `maestroSession.ts` (PAINEL DE FUNDO do Maestro: um processo `claude` PERSISTENTE por projeto em stream-json bidirecional — `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose --permission-prompt-tool stdio` — o chat estruturado do board é só um espelho bonito dos eventos reais: deltas de texto ao vivo, tool_use com input completo, tool_result, e permissões chegam como `control_request can_use_tool` que a UI responde com allow/allow-always (`updatedPermissions` = ecoar `permission_suggestions`)/deny via `control_response`; interrupt = `control_request {subtype:'interrupt'}`; timeout de 10 min de inatividade PAUSA enquanto há permissão pendente; handshake `initialize` (control_request) devolve as CAPS REAIS do CLI — lista de comandos slash (nome/descrição/argumentHint), lista de modelos IGUAL ao seletor do TUI (displayName, descrição, supportsEffort, supportedEffortLevels por modelo) e conta/plano — cacheadas na sessão e expostas via IPC `maestro:capabilities` (ensureSession spawna sem custo: handshake não gasta tokens); troca de modelo é AO VIVO via `control_request {subtype:'set_model'}` (sessão preservada, confirmação real vem como `<local-command-stdout>`); qualquer `/comando` não-Synkora vai CRU como mensagem user e executa de verdade (/usage, /compact, skills…) — sem persona na frente; trocar effort/seat mata o processo e o próximo envio respawna com `--resume`; /fast do claude: o COMANDO é bloqueado em modo SDK ("not available in the Agent SDK"), mas a chave de settings `{"fastMode":true}` via `--settings` LIGA o fast mode real (validado: result.fast_mode_state=on) — o main intercepta /fast, alterna maestroStore.fastMode e respawna com --resume; no Windows o JSON do --settings precisa de dupla serialização por causa do shell; trocar de SEAT reseta model/effort/contextWindow (senão um modelo gpt vaza para o claude)), `codexSession.ts` (mesmo papel para seats CODEX: `codex app-server` persistente, JSON-RPC v2 via stdio — `initialize`+`initialized`, `thread/start` com persona em `developerInstructions`, `thread/resume` (sessionId salvo como `codex-thread:<id>`), `turn/start` com model/effort como OVERRIDES POR TURNO (trocar não exige respawn), eventos `item/agentMessage/delta`, `item/started|completed` (commandExecution/fileChange→tool), `thread/tokenUsage/updated`, `turn/completed`; aprovações chegam como REQUESTS JSON-RPC do servidor (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`) e a UI responde `{decision: accept|acceptForSession|decline}`; caps via `model/list`+`account/read`; interrupt = `turn/interrupt {threadId,turnId}`; comandos slash do codex via `runSlash` — cada um mapeado ao RPC real: /status, /usage (rateLimitsByLimitId), /compact (thread/compact/start), /review (review/start target uncommittedChanges, roda como turno normal), /diff (git local), /init (turno com prompt canônico), /permissions (opts.approvalPolicy → override no turn/start: untrusted|on-request|never), /rename (thread/name/set), /goal (thread/goal/set|get), /mcp, /skills, /fast (REAL: toggle do serviceTier 'priority' no turn/start — "1.5x speed, increased usage", confirmado no catálogo embutido do binário; o TUI ganhou /fast em versão recente); comandos de UI do TUI (theme, vim, pets, quit…) respondem com explicação+alternativa via CODEX_TUI_ONLY/CODEX_UI_COMMANDS — a lista veio do slash_command.rs da versão instalada. STEERING: mensagem enviada DURANTE um turno entra no turno ativo — codex via turn/steer {expectedTurnId} (fallback turn/start); claude enfileira pela própria stream; a UI nunca bloqueia o input (busy também religa por delta/thinking/permission)), ambos implementam a MESMA interface de eventos (`SessionEvent`) e o main trata via união `MaestroBackend`, `maestro.ts` (persona PERSONA/PERSONA_DEV, parseTasks, toolLabel, `survey()` = /estudar one-shot que grava `<projeto>/.synkora/CONTEXT.md` (em seats codex: `surveyViaCodex` no index — CodexSession dedicada com sandbox 'read-only' + approvalPolicy 'never'; /estudar SEMPRE mata o painel do projeto e reseta sessionId/personaSent para a próxima conversa ler o dossiê novo); claude precisa de shell no Windows por ser shim .cmd), persona no 1º turno via mensagem (claude) ou developerInstructions (codex); cria tarefas SÓ quando a resposta contém bloco `<tasks>{json}</tasks>`, `maestroStore.ts` (persistência por projeto de sessão+modelo+log da conversa em userData/maestro.json — sair e voltar do projeto retoma tudo; sessão é presa ao seat, trocar de seat reabre sessão), `winPath.ts` (PATH fresco do registro no Windows). IPC do Maestro: `maestro:send` (claude E codex; fire-and-forget, turno termina com evento live `turn-end`), `maestro:permission`, `maestro:interrupt`; canal `maestro:event` = log persistido (kinds cmd/log/ok/err/say/tool/out/ask, `detail` carrega o input JSON da tool), canal `maestro:live` = efêmero (delta/flush/thinking/permission/turn-end).
- Seats (F1): cada conta = config dir isolado em `userData/seats/<id>`; o main injeta `CLAUDE_CONFIG_DIR` (Claude) ou `CODEX_HOME` (Codex) no env do PTY. Status "logado" = heurística de arquivo de credencial no config dir.
- `src/preload/` — bridge `window.synkora` (contextBridge); tipos em `index.d.ts`.
- `src/renderer/src/` — React: `screens/Home` (projetos + `components/SeatRail`), `screens/Universe` (abas Board/Panes; panes ficam montados ao trocar de aba — display:none, nunca desmontar, senão mata as sessões), `components/Board` (kanban + barra do Maestro), `components/PanesView`, `components/TerminalPane`, `store.ts` (zustand), `departments.ts` (departamentos/status), `util.ts`, `devMock.ts` (preview da UI em browser puro).

## Comandos

- `npm run dev` — roda o app (electron-vite dev, HMR no renderer).
- `npm run typecheck` — checa main/preload (tsconfig.node.json) e renderer (tsconfig.web.json).
- `npm run build` — build de produção em `out/`.

## Linguagem visual (decisão do usuário, 2026-07-21 — NÃO voltar ao tema escuro futurista)

Tema "papel & painel", inspirado em loops.overclock.sh: fundo papel quente (`--paper #efe9dc`),
tipografia 100% mono (Cascadia/Consolas), botões com borda ink e uppercase, e painéis de
terminal escuros (`--panel #26241f`) com bolinhas de janela (`.term-window`/`.term-titlebar`/`.dots`).
Acento laranja `#d96c3f`; sucesso verde `#3e9b5f`; erro `#c4453a`. Departamentos por matiz:
front 21 (laranja), back 210 (azul), qa 145 (verde). Logs estilo `[tag] texto` com `$` prompt.
Todo painel que "roda algo" (panes, maestro, login) usa o padrão .term-window.

## Fluxo de execução de tarefa (F3 COMPLETA em 2026-07-21 — EXECUÇÃO HEADLESS)

PIPELINE 100% EM PANES TUI REAIS (decisão do usuário 2026-07-21: ver o CLI de verdade ao
vivo em TODAS as fases; espelho headless descartado — o código do espelho segue no repo,
dormente): `preparePhasePane(phase)` cria worktree+transcript e devolve a spec; o
renderer abre TerminalPane no worktree (Pane tem role dev|review|qa; claude com
--permission-mode acceptEdits). ORQUESTRAÇÃO POR ARQUIVOS (poller 3s): dev cria
.synkora/runs/<id>.done → abre pane 🧐 review; gates criam <id>.<fase>.verdict com
"aprovada" ou "reprovada: motivo" → main parseia, FECHA o pane do gate ('panes:close') e
avança: review ok → pane 🔎 QA (status qa); QA ok → fecha pane dev + merge --no-ff
(`worktree.ts`; conflito → branch preservada) → done. REPROVAÇÃO: com autopilot e ciclos
< MAX_RETRY_CYCLES(2), o feedback é DIGITADO no pane vivo do dev via evento
'tasks:feedback' (pty.write; pane fechado → reabre com feedback no prompt) e
task.cycles++; sem ciclos → análise com task.feedback. Gates usam política do dept 'qa'
(fallback seat do dev). PTY faz tee da saída (ANSI limpo, flush 1,5s, dedupe) para o
transcript E detecta prompts de aprovação por heurística (ATTENTION_RE em pty.ts) →
evento 'tasks:attention' → card e pane pulsam (needs-perm) até o usuário digitar no pane.
Card mostra runSeat/runModel/cycles/feedback (campos novos na Task). Dispatcher abre
panes via 'panes:open'; mover o card para fora da fase solta o watch. Gates usam a política do dept 'qa'
(fallback: seat do dev) e rodam NO MESMO cwd/worktree do dev. Reprovação em qualquer gate
→ tarefa volta para análise com o motivo. DISPATCHER: `dispatch()` roda quando autopilot
(maestroStore.autopilot, toggle 🤖 no board, IPC harness:setAutopilot) está ligado — pega
backlog por ordem de criação, resolve política por dept+effort, pula tarefa sem política,
1 run por seat, MAX_PARALLEL_RUNS=3; re-dispara em toda mutação de tarefa e fim de run.
Custo por fase: evento result carrega costUsd (claude total_cost_usd) + contextTokens →
linha "fase X: ~Nk tokens · ~$Y acumulado" no espelho/transcript. APROVAÇÃO PENDENTE:
card e pane-espelho pulsam (classe needs-perm, keyframes perm-pulse). HANDOFF ▣ terminal
(`tasks:runHandoff`): mata o headless e abre um TUI REAL na MESMA conversa e no MESMO
worktree (claude `--resume <sid>`; codex `resume <threadId>`; Pane ganhou cwd próprio) —
o pipeline automático PARA para aquela tarefa (humano assume; card fica preso ao pane).

Execução é dirigida por POLÍTICA DE MODELOS (`policies.ts` + editor no painel do
departamento): humano define política (seat+modelo por peso), Maestro classifica `effort`,
harness aplica. "▶ executar" NÃO abre mais pane TUI: cria um TaskRun no main (`tasks:run`)
— uma sessão headless dedicada por tarefa (MaestroSession/CodexSession, os mesmos backends
do painel do Maestro) com `permissionMode: 'acceptEdits'` (claude) e `sandbox:
'workspace-write'` (codex): edits pré-aprovados, o resto pede aprovação NA UI. O modal da
tarefa vira o ESPELHO do executor: stream ao vivo, ferramentas, PermPicker de aprovação
(canais `taskrun:event`/`taskrun:live`), input de steering (`tasks:runSend`), ⏹ parar
(`tasks:runInterrupt`). Card mostra 🖐 piscando quando há aprovação pendente. Runs também
aparecem na aba PANES como panes-espelho (RunPanel compartilhado em
`components/RunPanel.tsx` com MaestroLine/PermPicker; executor fala como "executor>").
GATE 2 AUTOMÁTICO: dev concluiu → tarefa vai para QA e `startQaRun` troca a sessão por um
QA (seat/modelo da política do dept 'qa', fallback seat do dev) que lê o transcript, revisa
e TERMINA com `<verdict>aprovada</verdict>` ou `<verdict>reprovada: motivo</verdict>` — o
main parseia (tag some do espelho): aprovada → done; reprovada → volta para análise com o
motivo no log do Maestro; sem veredito → fica em QA manual.
Transcript de cada run em `<projeto>/.synkora/runs/<taskId>.md`; board em tempo real em
`.synkora/BOARD.md` (syncBoard em toda mutação de tarefa/run) — a PERSONA manda o Maestro
ler esses arquivos para responder sobre andamento (nunca presumir). Sem "claude padrão":
tudo roda em seats. Medidor de contexto: teto AUTOMÁTICO pela janela real do modelo
(claude: sufixo `[1m]` → 1M, senão 200k; codex: `modelContextWindow` do tokenUsage) —
`/context <n>` fixa manual, `/context auto` volta ao automático.

## Imagens, pickers e comandos do Maestro (2026-07-21)

- O Maestro é SÓ o chat espelho (o TUI embutido foi REMOVIDO em 2026-07-21, decisão do
  usuário: com a paridade claude+codex ele ficou redundante). Não recriar sem pedir.
- Ctrl+V com imagem no painel do Maestro: main salva PNG em `<projeto>/.synkora/attachments/`
  e o path entra no prompt (o agente lê a imagem pelo caminho). IPC `clipboard:hasImage`
  (sendSync) e `clipboard:saveImage`.
- Ctrl+V com imagem nos panes TUI de execução: TerminalPane detecta via
  attachCustomKeyEventHandler e repassa o byte 0x16 ao PTY — o CLI lê o clipboard nativo.
- /model e /effort usam as CAPS do painel de fundo nos DOIS CLIs (lista idêntica ao TUI,
  descrição, ✓ no atual, "effort não suportado" p/ modelos sem reasoning); claude troca ao
  vivo via set_model, codex via override por turno. Digitar "/" abre autocomplete com os
  comandos reais (claude: todos do CLI + passthrough; codex: /status /usage /compact /mcp
  /skills via RPCs reais + os locais do Synkora).
- Catálogo `catalog.ts` (IPC `catalog:get`) alimenta ModelSelect (política de execução e
  modal ▶ executar) e o fallback de efforts. Claude: lista REAL via handshake initialize
  do stream-json com o config do seat (spawn efêmero, sem tokens; fallback = aliases
  curados); Codex: `codex debug models`. Cache renderer POR cli+seat (`catalogByCli`
  chaveado `cli:seatId`); ModelSelect só cai em texto livre se a lista JÁ carregou e o
  valor salvo não está nela (ou "outro…").
- Effort persistido por projeto (maestroStore.effort): claude `--effort <x>` no spawn;
  codex `effort` no turn/start.
- PTYs nascem com cols/rows reais do xterm (spawn em 80x24 + resize embaralhava o render).

## Convenções

- TypeScript strict em tudo; sem `any` salvo interop inevitável.
- Renderer nunca importa Electron/Node — só fala com o main via `window.synkora`.
- Sem StrictMode no React: o double-mount de dev mataria/recriaria PTYs reais.
- No `TerminalPane`, assinar `onData` ANTES de `pty.create` (senão perde output inicial).
- Seletores zustand devem retornar referências estáveis (nunca `?? []` inline — loop de re-render).
- Dropdowns/overlays: cuidado com stacking context (animações com transform); header tem z-index próprio e overlays vão via portal para o body.
- Mudanças em `src/main`/`src/preload` exigem reiniciar o `npm run dev` (HMR só cobre o renderer).
- UI em PT-BR; código e identificadores em inglês.
- Roadmap: nunca construir a fase N+1 sem a fase N estar em uso (gates no PLANO.md).
