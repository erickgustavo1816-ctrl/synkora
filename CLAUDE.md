# Synkora

ADE (Agentic Development Environment) desktop: projetos como "universos", missões
com dev em CHAT GUI rodando em worktrees isolados sobre múltiplas contas de CLIs
de IA ("seats"). O dono é o orquestrador.

**Sempre responda ao usuário em PT-BR.** Código, identificadores e mensagens de
commit em inglês.

## ERA 2.0 (2026-08-13) — o produto é o CHAT GUI

Decisão do dono: o pane TUI morreu para missões novas; **o GUI mora dentro do
Synkora**. Toda missão criada nasce `Mission.direct`: SEM maestro, SEM
orquestrador, SEM plano/gates — um CHAT (GuiPane) abre no centro do Board com o
dev no worktree da missão; ⇪ vai direto pra fila de integração. O fork
claudecodeui (Desktop/Synkora2) foi REJEITADO como produto (fica como pedreira
de ideias — NUNCA apagar a pasta).

**A LIMPA F6 (ordem de 2026-08-17)**: "suprimir, não demolir" foi REVOGADO — os
subsistemas da era F6 (pipeline de fases/gates, maestro/orquestrador, MCP legado
do TUI, hub mail/inject, skills+subagentes "por enquanto", serviços de
inteligência de código, geração de imagens, plano mestre F6) estão em demolição.
**Cercas do que FICA**: servidor MCP HTTP + buildServer com early-returns
`gui-planner`/`gui-delegator`; MaestroSession/CodexSession (são o MOTOR do chat
GUI, apesar do nome); pty/TerminalPane para os terminais SHELL da missão; fila
de integração + ⇪; plans/PlanStore; SynVoice; seats/catalog/cliUpdate;
blackbox/diagnostics. Missão legada em dados de usuário degrada inerte, nunca
crasha.

## Documentos de referência (ler antes de mudanças grandes)

- `docs/PLANO_2_0_GUI.md` — a virada 2.0 (GUI dentro do Synkora) + ondas A/B/C.
- `docs/GUI_PANE_CONTRACT.md` — contrato do pane GUI (canais, tipos, papéis).
- `docs/MOCKUP_WORKSPACE.md` — O MOCKUP É O CONTRATO visual do workspace
  (aprovado pelo dono; o chat é PAPEL, nunca painel escuro de terminal).
- `docs/PLANO_CHAT_ONDA_2.md` — cardápio do chat escolhido item a item pelo dono.
- `docs/HANDOFF_SESSAO_*.md` — o mais recente é o estado vivo da obra.
- `.synkora/reports/DESIGN_SUBAGENTES_SEM_ABA_2026-08-18.md` — design vinculante
  da delegação (helpers MCP sem aba) + rodadas 5-6 (o ciclo redondo).
- `docs/SKILLS.md` — curadoria da biblioteca de skills (volta com kit mínimo
  quando o dono decidir).

## Delegação (subagentes sem aba — 2026-08-18)

Ordem do dono: chat NUNCA abre subagente nativo (Task/Agent do claude, collab do
codex — cercados mecanicamente); TODA delegação via MCP `gui-delegator`
(delegate / list_seats / helpers_status / helper_result / helper_send /
helper_resume / helper_cancel). Motor `guiHelperSessions.ts` (headless, os dois
CLIs); lateral mostra modelo+effort+conta por ficha; pino de modelo/effort do
dono no painel D8. O CICLO REDONDO (rodadas 5-6): entrega SEMPRE em arquivo
(`.synkora/helpers/<id>.md` escrito pelo harness) + correio `[synkora]
ajudantes:` de carona nos resultados de tools; estado `interrupted` persistido
em `userData/gui-helpers.json` — ■ do dono e fechar o app INTERROMPEM
preservando (helper_resume retoma a mesma conversa; helper_cancel descarta e
apaga a entrega); frota parte escalonada ~2s; 529/rate-limit na partida ganha
UMA re-tentativa automática.

## Stack e estrutura

Electron + electron-vite + React 19 + TypeScript (strict). Vite fixado em ^7
(electron-vite 5 não suporta Vite 8). Persistência em JSON (jsonStore atômico
com .bak) em userData — sem SQLite de propósito (evita build nativo).

- `src/main/` — main process: janela, IPC (`src/main/ipc/`), stores (projects/
  seats/tasks/missions/backlog), `guiSessions.ts` (registro dos chats GUI),
  `guiHelperSessions.ts` + `guiDelegationWiring.ts` + `guiHelperCards.ts`
  (delegação), `guiMissionContracts.ts` (personas dos papéis), `mcpServer.ts`
  (MCP HTTP local, bearer por pane, catálogo por role com early-return),
  `maestroSession.ts`/`codexSession.ts` (motores dos CLIs em stream-json /
  app-server JSON-RPC), `PtyManager` (@lydell/node-pty, prebuilt) para os
  terminais shell, `worktree.ts`/`gitWorker.ts` (git fora do main thread),
  `blackbox.ts` (diário JSONL + `scripts/bbwatch.mjs` para ler).
- `src/preload/` — bridge `window.synkora` (contextBridge); tipos em `index.d.ts`.
- `src/renderer/src/` — React: GuiPane (o chat), guiSubagentSidebar (lateral),
  Board/MissionColumn, store.ts (zustand), global.css (tema papel & painel).
- Seats: cada conta = config dir isolado (`CLAUDE_CONFIG_DIR`/`CODEX_HOME`).

## Comandos

- `npm run dev` — roda o app (HMR SÓ no renderer; mudança em main/preload NÃO
  relança sozinha — provado 2026-08-20: derrubar e resubir o `npm run dev` é
  obrigatório para main/preload novos chegarem ao app).
- `npm run typecheck` — main/preload (tsconfig.node.json) + renderer (web).
- `npm run test:gui-system` — o GATE RAIZ: typecheck + ~26 suítes node puras.
- `npm run build` / `npm run dist` — produção (asarUnpack do node-pty é vital).

## Linguagem visual (decisão do dono — NÃO voltar ao tema escuro futurista)

Tema "papel & painel": fundo papel quente (`--paper #efe9dc`), tipografia 100%
mono (Cascadia/Consolas), botões com borda ink e uppercase, painéis de terminal
escuros (`--panel #26241f`) com o padrão .term-window. Acento laranja `#d96c3f`;
sucesso `#3e9b5f`; erro `--err #b54036` (AA sobre papel). O CHAT é PAPEL.
Departamentos por matiz (front 21, back 210, qa 145). Diferença dita por FORMA
antes de cor; movimento é SINAL, não enfeite.

## Metodologia de trabalho (a que funcionou — replicar)

Sessões grandes: o assistente é ORQUESTRADOR e code reviewer, nunca implementador
direto (exceto ajustes pequenos achados no review). Fases: investigação →
design registrado em doc (.synkora/reports/) → implementação por agentes Opus
max em paralelo (mesma árvore SÓ com fronteiras de arquivos 100% disjuntas;
senão worktrees `Synkora-wt-*` + junction de node_modules criada/removida PELO
ORQUESTRADOR com `rmdir` sem recursão) → integração → code review pessoal no
diff INTEIRO → gate raiz → commit em bloco convencional. Regras duras: teste
novo tem que FALHAR comprovadamente no código velho; agente reporta
filesChanged/deviations; nunca rodar o app do dono; prompts de agente em EN;
heurística sobre conteúdo proibida — só sinal estrutural sondado.

## Convenções e regras duras

- TypeScript strict em tudo; sem `any` salvo interop inevitável.
- Renderer nunca importa Electron/Node — só fala com o main via `window.synkora`
  (contratos duplicados entre main e renderer são espelhos declarados, com
  comentário apontando o par).
- Sem StrictMode no React (double-mount mataria PTYs/sessões reais).
- Feature nova = módulo novo; arquivo cruzando ~1000 linhas se divide na hora.
- Seletores zustand com referências estáveis (nunca `?? []` inline).
- Overlays via portal; nunca `window.confirm`/`alert` (quebra o foco no Windows).
- CSP do renderer: `img-src 'self' data:` (avatar quebrado = olhar CSP primeiro).
- UI em PT-BR; identificadores em inglês. Toda recusa/mensagem de harness ao
  agente nomeia a RECEITA (a tool/ação que destrava) — beco sem saída é bug.
- Nenhum passo do pipeline depende de entrega única: ou a mensagem é DURÁVEL com
  recibo, ou a ação é RE-DERIVÁVEL e um reconciliador a re-executa.
- Guarda dura SÓ protege autoridade/verificabilidade; guarda de julgamento vira
  advisory auditado. Toda guarda nasce com rota de saída sancionada.
- Caixa-preta: eventos relevantes viram `blackbox.record` com ids de correlação;
  ler com `node scripts/bbwatch.mjs`.

## Armadilhas permanentes (pagas caro — não redescobrir)

**PTY/terminal (os panes shell que ficam):**
- `useConptyDll: true` no spawn (ConPTY v2 do node-pty) matou a família inteira
  de repinturas; NUNCA setar `termName` no xterm (o `\e[c` do boot bloquearia).
- O claude roda em ALT-SCREEN (`?1049h`): não existe scrollback para vazar; um
  gesto = UM resize (debounce por estabilidade); nunca redimensionar pane que já
  imprimiu sem esperar o gesto acabar. `CLAUDE_CODE_NO_FLICKER=1` +
  `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1` no env do pane claude.
- WEBGL_BUDGET=12 por processo de renderer (o 17º contexto mata o mais antigo e
  não restaura) — fundos animados são Canvas 2D, NUNCA WebGL.
- Empacotamento: `asarUnpack` de `**/node_modules/@lydell/node-pty*/**` (a DLL
  morre dentro do asar); `npmRebuild: false`.

**Ambiente dos CLIs filhos:**
- Deletar `NO_COLOR`/`FORCE_COLOR`/`CLAUDE_CODE_*` (menos CLAUDE_CONFIG_DIR)/
  `CLAUDECODE` do env de todo filho; `TERM=xterm-256color` + `COLORTERM`.
- PowerShell: `-ExecutionPolicy Bypass` nos args; argv tem teto de 32.767 (env
  var NÃO escapa — o PS expande de volta); prompt >8KB vai por ARQUIVO com BOM
  (PS 5.1 sem BOM decodifica UTF-8 como ANSI — mojibake); `Get-Content` de gate
  precisa `-Encoding utf8`; claims de caractere exigem verificação por BYTES.
- paneId/helperId viram NOME DE ARQUIVO: sem `:` nem `/` (Windows recusa).
- Junctions de node_modules em worktrees: NUNCA `Remove-Item -Recurse` através
  de junction viva — remover a junction com `rmdir` SEM recursão primeiro.

**Comportamento dos CLIs (re-sondar a cada update):**
- claude monta o catálogo de tools POR REQUEST: prompt inicial no argv sai ANTES
  do handshake MCP — prompt de resume vai por ARQUIVO com instrução read-first.
- Effort do claude entra na chave do prompt-cache (frota com efforts variados =
   ~3,7× o custo); haiku não aceita `--effort`.
- Codex app-server nunca morre sozinho (kill pós-resultado é do motor); claude
  `-p` com stdin fechado é fire-and-forget e morre limpo.
- Sondar SEMPRE em binário real antes de afirmar protocolo (probes em scripts/).

## Estado vivo

O handoff mais recente em `docs/` + o design em `.synkora/reports/` contam onde
a obra está. Roadmap curto: RightDock (3º) → browser (4º) do plano do dono.
