# PLANO NÍVEL 5 — cirurgia de desempenho e modularização (para aprovação do dono)

Escrito 2026-08-07 (sessão dos níveis 4/5). REGRA VIGENTE (memória
`projeto-refatoracao-index-18k`): este plano precisa do teu OK antes de
qualquer código. Nada abaixo foi implementado.

## A dor, com evidência

- Relato do dono (2026-08-07, ao vivo): "quando eu abro o Synkora e vou
  clicando nas missões, os panes vão abrindo e vai dando umas lagadas" — e o
  binário em uso JÁ TEM o escalonador de spawn do F6.10 (paneSpec espaçados
  ~350ms). A mitigação não bastou.
- Medições acumuladas: stalls de 1,2–2,6s em TODA transição done→gate (4/4 em
  2026-08-06, cresce com a carga); journal de 2026-08-07: 22 `event-loop-stall`,
  12 `slow-skill-sync`, 5 `slow-task-worktree`; boot de 18:41Z stallou já aos
  4s de uptime com 0 panes.
- Estrutura: `src/main/index.ts` = **18.896 linhas / 829KB / 120 handlers IPC**.

Duas classes de travamento, com culpados diferentes:

1. **Main process bloqueado** (event-loop-stall): barreira síncrona do
   veredito, resíduos síncronos de fs/git, tempestade de boot — quando o main
   trava, NENHUM clique responde (todo IPC espera).
2. **Renderer saturado**: um único renderer parseia todos os `pty:data`,
   pinta todos os xterms e divide 12 contextos WebGL — a UI laga mesmo com o
   main livre.

O relato do clique-nas-missões tem cara das duas somadas: cada aba de missão
monta o orquestrador (spawn + skill sync + catálogo) no main E acrescenta um
xterm vivo no renderer.

## Fase 0 — instrumentação de ATRIBUIÇÃO (pré-requisito; 1 janela curta)

`event-loop-stall` hoje diz "travou 1,2s" sem dizer QUEM. Antes de cortar
qualquer coisa: um rastreador barato de "operação em curso no main" (marcar
início/fim de paneSpec, spawn, skill sync, veredito/fotografia, syncBoard,
merge; no stall, logar a pilha de operações abertas). Um dia de uso normal do
dono devolve o ranking REAL dos culpados — a cirurgia corta pelo dado, não
pelo palpite (memória `feedback-instrumentar-antes-de-teorizar`).

ESTADO (2026-08-07): **FASE 0 CONCLUÍDA E LIGADA** (janela de app fechado;
typecheck + test:stall-attribution 8/8 + orchestrator-flow 35/35 +
mission-verification 25/25 verdes). O que entrou:
- `src/main/stallAttribution.ts` novo (módulo puro, sem electron; suíte
  própria): tracker de operações abertas + ring das recém-fechadas ≥120ms;
  blame(lag) devolve o que intersecta a janela do stall.
- index.ts: instrumentIpcMain cobre os ~120 handlers (`ipc:<canal>` /
  `ipc-on:<canal>`); o watchdog anexa `culprits` ao event-loop-stall;
  wrappers finos (padrão wrapper→Inner, zero mudança de comportamento) em
  preparePhasePane, advancePhase (contrato SYNC do veredito intacto — wrap
  sync devolve sync), completeMissionMerge, syncBoard; e toda tool MCP vira
  `mcp:<tool>` dentro do instrumentMcpApi.
Validação em produção: um dia de uso normal do dono; todo event-loop-stall
no journal passa a vir com a lista de culpados. Leitor:
`node scripts/bbwatch.mjs --grep stall`. O ranking decide o corte das Fases
1–2.

RODADA 2 (mesma data, após o 1º boot medido): o stall de boot (~1,9s aos 3s,
0 panes) veio com `culprits: []` — sensor ATIVO e culpado FORA do
instrumentado, ou seja, no caminho de PARTIDA. Entraram: `boot:stores`
(cargas síncronas dos 8 stores), `boot:project-sweep` (vassoura/repair/
syncBoard por projeto), `boot:createWindow`, `boot:progressSnapshot`,
`boot:cli-skills-kickoff` (trecho sync do tick de 2,5s). E o limiar do
watchdog caiu 1000→500ms — as "travadinhas" de clique que eram invisíveis
viram dado com culpado. Se o próximo boot AINDA vier vazio, a leitura por
eliminação é overhead do modo dev/GC — registrar e seguir para a Fase 1.

## Fase 1 (5a parte 1) — MainContext + extração por menor acoplamento

> ESTADO (2026-08-07, branch `nivel5-fase1`): **primeiro corte FEITO** — o
> passo 2 (phasePrompts.ts) foi executado por agentes Opus com prova de
> equivalência (5810 comparações, 0 divergências) e soldado (commit 647f711;
> typecheck + 68 asserções verdes; index 19448→19324 linhas). Mapas da obra
> em docs/FASE1_MAPA_MAINCONTEXT.md (inclui a ordem REVISADA: commit 0
> phaseTypes → 0.5 remoção do headless morto ~400 linhas → 1 MainContext com
> ctx.phase → 3 phaseEngine antes do mcpApi) e
> docs/FASE1_SOLDA_PHASEPROMPTS.md. Pendência cosmética anotada: comentários
> PT-BR duplicados entre index e phasePrompts (podar nos commits da região).
>
> ESTADO 2 (2026-08-07, mesma data): **commits 0 e 0.5 FEITOS**. Commit 0
> (b6784ce): `src/main/phaseTypes.ts` novo — RunPhase, DevPaneSpec,
> PhaseWatch, MissionWatch, PendingUserQuestion e LiveGateWait saem do
> closure (docstrings junto; zero comportamento). Commit 0.5 (a1899d2): a
> máquina HEADLESS morta caiu INTEIRA — o mapa contava ~400 linhas olhando
> só o main; o fecho transitivo real levou preload (API tasks.run*,
> onRunEvent/onRunLive/onFeedback, TaskRunSnapshot) e renderer
> (RunPanel.tsx deletado, taskRuns do store, espelhos `run:<taskId>` em
> Board/PanesView/panesNodes/ConstellationMap/Universe, devMock): **−1108
> linhas** em 11 arquivos (main −439), corte do renderer por agente Opus
> com revisão linha a linha. Vivos preservados: badge de fase via
> taskPhaseView, setPhaseSeat, celebrações por hub:event/paneActivity, e o
> canal `tasks:feedback` morreu junto (único emissor era o runSink morto).
> Verde nos dois commits: typecheck (node+web) + orchestrator-flow 35 +
> mission-verification 25 + integration-queue 14 + pane-permissions 11 +
> stall-attribution 8. index 19324→18832 linhas. Resto anotado e NÃO
> removido: CSS órfão do espelho em global.css (.run-modal/.perm-picker…,
> separar do vivo exige varredura própria) e `cursorPush` não-lido no
> ConstellationMap (pré-existente, provado por stash).
> ESTADO 3 (2026-08-07, mesma data): **commit 1 FEITO** (d0b48ea).
> `src/main/mainContext.ts` novo — interface MainContext com o contrato
> completo (19 stores/serviços, 8 reatribuíveis, 31 Maps/Sets, 16 funções
> de closure, ctx.push) + PhaseApi com as 8 assinaturas da máquina de
> fases (advancePhase SYNC POR CONTRATO gravado no tipo). O objeto ctx
> nasce no index logo após o hub (varredura de declarações por agente
> Opus): getter para reatribuível e para const declarada DEPOIS do ponto
> de construção (referência direta daria TDZ), delegação arrow para
> função e para ctx.phase — zero movimentação, zero comportamento; o
> typecheck valida os shapes todos. Consumidor nenhum ainda (`void ctx`).
> Verde: typecheck (node+web) + as 5 suítes (35+25+14+11+8).
> PRÓXIMO PASSO: commit 3 do mapa — phaseEngine.ts ANTES do mcpApi
> (riscos mapeados: advancePhase sync, TDZ do MAX_PARALLEL_RUNS, poller
> misto, gateDeathLog via recordGateDeath) — OU commit 4 (mcpApi/ por
> domínio) usando ctx.phase; o mapa sanciona as duas ordens.
> HANDOFF da sessão em **docs/HANDOFF_FASE1.md** — a próxima sessão lê
> ELE primeiro (pendências não-código: boot de validação do dono, push
> dos 5 commits locais, mão alheia em bundledSkillRevision/skillsLibrary).
>
> ESTADO 4 (2026-08-08): **checkpoint da frente paralela + commit 3 FEITOS**.
> Checkpoint (885c054): a frente paralela (skills/evidence/harness) deixou
> ~12,5k linhas não commitadas ENTRELAÇADAS com o index — separada em commit
> próprio, não revisado por esta obra, para o commit 3 nascer reversível
> (a regra "não commitar a família skills" valia com a sessão paralela
> VIVA; com ela fechada, misturar as frentes no mesmo commit era o mal
> maior). Commit 3 (685a77b): `src/main/phaseEngine.ts` novo —
> createPhaseEngine(ctx, extras) com o corpo movido VERBATIM por range de
> linha (script de corte com âncoras regex por borda; zero redigitação):
> preparePhasePane/Inner, advancePhase/Inner (SYNC POR CONTRATO),
> retryOrBacklog, finalizeTask, openGatePane, open/closePhasePane,
> terminateTaskPhasePane, recoverFinalizingTask, gates vivos, boot
> respawns, artefato de review e o tick de fases (tickPhaseWatches; o
> setInterval fica no index com helper watchdog + missionWatches). Estado
> de fase nasce NO ENGINE; o index mantém aliases desestruturados (call
> sites e getters do ctx textualmente intactos). Riscos do mapa pagos:
> MAX_PARALLEL_RUNS export declarado antes de todo consumidor,
> recordGateDeath(taskId) no onExit (nunca o Map cru), codeReportGuard
> late-bound por arrow (mcpApi nasce depois). Fixes de contrato:
> PhaseApi.advancePhase com a arity REAL de 5 params (o tipo do commit 1
> dropava verificationEvidence/acceptance em silêncio — gap achado na
> re-varredura) e ctx.phaseWatches tipado com detach() (estrutural, sem
> ciclo de import). DIVERGÊNCIA JUSTIFICADA do handoff: livePaneSpecs/
> closingPaneIds/paneEverSpawned FICARAM no index — são ciclo de vida de
> pane genérico (helpers/delegateMany/helperClose/pty) e pertencem ao
> futuro paneLifecycle.ts. index 21783→17988 linhas (a frente paralela
> tinha devolvido ~2,8k). Verde: typecheck node+web + orchestrator-flow
> 39 + mission-verification 25 + integration-queue 14 + pane-permissions
> 14 + stall-attribution 8 (as suítes cresceram na frente paralela).
> PRÓXIMO: commit 4 (mcpApi/ por domínio; report em commit próprio) —
> boot de validação do dono segue pendente, agora cobrindo TAMBÉM o
> checkpoint da frente paralela.
>
> ESTADO 5 (2026-08-08, mesma data): **BOOT DE VALIDAÇÃO FEITO pelo dono**
> (npm run dev limpo com os commits 0–3 + checkpoint; claude atualizou
> 2.1.224→2.1.226 no boot — re-sondar CHECK 14/MCP quando a M02c voltar a
> rodar) e **COMMIT 4 COMPLETO em 4 partes**, todas verdes (typecheck
> node+web + 39/25/14/14/8):
> - 4a (6ba29fc): PhaseApi ganha reviewArtifactProblem/cleanupReviewArtifact/
>   readReviewArtifactChunk/taskIntegrationMarker/recoverFinalizingTask —
>   com a superfície no contrato, os módulos de domínio não precisam de
>   entradas de fase nas extras.
> - 4b (86c4ea1): nasce src/main/mcpApi/ — images (0 extras), mailbox
>   (0 extras), code, skills, panes. Factories buildXxxApi(ctx, extras?) →
>   Pick<McpApi, …> (contextual typing preservado); o literal do index vira
>   spreads + membros restantes. Armadilha paga: mcpPaneFirstContact nasce
>   DEPOIS do literal — nos módulos vai por ctx.* em call time, nunca
>   desestruturado (TDZ).
> - 4c (7ce43eb): missions (12 membros), helpers (6), board (8). Sets de
>   handshake humano (humanProjectPlanApprovals/humanProjectMissionStarts)
>   POR REFERÊNCIA — os IPCs projectPlan:* continuam donos da escrita.
> - 4d (547082e): report + readReviewEvidence em módulo PRÓPRIO (ordem do
>   mapa). Transação do veredito conferida no diff: detach → advancePhase
>   síncrono → rollback por phaseWatches.set, tudo via ctx.phase.
> A varredura Opus do mcpApi provou ZERO chamadas cruzadas entre membros —
> os 9 módulos são independentes, sem late-binding entre eles (o único
> late-bound do desenho segue sendo o codeReportGuard do phaseEngine).
> index.ts 17988→13420 linhas (−31% na sessão; 19448 pré-obra → −31%).
> PRÓXIMO: commit 5 — ipc/<domínio>.ts (ilhas → pesados; pty POR ÚLTIMO
> como paneLifecycle.ts, levando livePaneSpecs/closingPaneIds/
> paneEverSpawned). Cerca viva: register<X>Ipc(ctx) chamados do whenReady,
> NUNCA no import (senão a instrumentação da Fase 0 morre em silêncio).
>
> ESTADO 6 (2026-08-08, mesma data): **COMMIT 5 FEITO em 5 fatias**
> (afd600e/ee61115/aa21558/d2e90cf/69a9260), todas verdes (typecheck
> node+web + 39/25/14/14/8). Nasce src/main/ipc/ com 12 módulos e 100 dos
> 138 handlers extraídos: skills (ilha perfeita, zero extras) + misc
> (catalog/cli/policies/seats/blackbox/clipboard/attachments/dialog) →
> voice (26 + banquinho de histórico privado) + progress → files/settings/
> services/harness/projectPlan → projects/backlog → tasks. Descoberta da
> varredura que virou a espinha do desenho: o renderer (único cliente de
> ipcMain) só nasce no boot:createWindow — um BLOCO ÚNICO de registro
> imediatamente antes dele é funcionalmente idêntico à ordem antiga e
> zera TODO risco de TDZ; a cerca da Fase 0 está gravada no comentário do
> bloco. Padrões novos: extras.state com getters/setters para lets do
> closure que handlers LEEM E ESCREVEM (voice/progress/settings — escrita
> textual `state.x = v` aciona o setter, corpo verbatim); mcpApi LAZY via
> getMcpApi() no projectPlan; tipos locais do overlay exportados do index
> (type-only import de '../index'). PhaseApi cresceu 2× na rodada:
> closeLiveGateWait + drainPendingRespawns (5e). Guards
> (bindUiSender/asserts) FICARAM no index passados por extras — o
> ipc/guards.ts do mapa fica para a obra do paneLifecycle, dona real do
> sender-binding. DECISÃO DE ESCOPO: ipc/maestro (18) e ipc/missions (8)
> ficam para a EXTRAÇÃO DOS ENGINES de maestro/missões — as extras deles
> (22/21 entradas com preparePlanningRun/MaestroBackend/ensureSession)
> seriam refeitas por inteiro; extrair junto é o caminho sem retrabalho.
> panes/pty (10, ~1000L) reservado ao paneLifecycle.ts; crash/perf (2,
> module scope) ficam por desenho. index.ts 13420→11768 na rodada;
> **19448 (pré-obra) → 11768 = −39%**. Restam no index: 38 registros de
> IPC + boot/recovery + engines de missão/maestro + pty/paneLifecycle.
> PRÓXIMO: extração dos engines de missão/maestro (leva ipc/maestro e
> ipc/missions junto) OU paneLifecycle.ts (pty + guards.ts) — as duas
> ordens funcionam; o boot de validação do dono cobre esta rodada antes.
>
> ESTADO 7 (2026-08-08, sessão seguinte): **ENGINES DE MISSÃO/MAESTRO
> EXTRAÍDOS em 6 commits** (6a a0f541f · 6b 423ac81 · 6c 1951d33 ·
> 6d eac1547 · 6e 55ca27e · 6f 277c50b), todos verdes (typecheck node+web
> + 39/25/14/14/8). Varredura por DOIS agentes Opus em paralelo (mapas
> novos: docs/FASE1_MAPA_MISSIONENGINE.md e
> docs/FASE1_MAPA_MAESTROENGINE.md — âncoras conferidas 1× por grep) →
> corte por script com localização 100% POR ÂNCORA (números de linha nunca
> entraram nos scripts; scratchpad cut-maestro-engine/cut-ipc-maestro/
> cut-mission-engine/cut-ipc-missions.mjs). Módulos novos:
> cliSessionTransplant.ts (73L, módulo PURO — tira o transplante da
> MaestroApi e desacopla setPhaseExecutorImpl do engine) ·
> maestroEngine.ts (555L: sessão de fundo/emissores/sessionSink/
> ensureSession, /estudar, teto de resume, preparePlanningRun, perguntas
> do ask_user) · ipc/maestro.ts (641L, 18 handlers, engine viaja nas
> extras) · missionEngine.ts (2.247L: região contígua de missões + fila
> de integração + stopMissionExecution + tickMissionWatches) ·
> ipc/missions.ts (610L, 8 handlers). ACHADOS das varreduras que valem
> reler: ZERO crossings maestro→missão (a costura real é toda nos IPC,
> concentrada no missions:paneSpec — 3 membros do maestroEngine via
> extras); PhaseApi NÃO cresceu e mainContext.ts NÃO mudou nesta rodada
> inteira; missionWatches está MORTO (nenhum .set() em src/main — resíduo
> do gate de integração aposentado na F6.1; movido como está, remoção é
> card de higiene separado); ordem de construção obrigatória
> mission → maestro → phase (PhaseEngineExtras consome
> missionWorkspacePath/ensureMissionWorktree). Armadilhas pagas:
> maestroSessions/killMaestroSession FICAM no index (window-all-closed
> fora do whenReady); teto de resume é ESCRITO no pty:create e LIDO no
> engine (costura por chave `maestro-<key>` — anotada no cabeçalho);
> shadowing de `ctx` em maestroResumeOverBudget exigiu destructure em vez
> de substituição; versionIsolation*/releaseVersionImpl ficam (domínio
> VERSÃO, extras do ipc/backlog); staggerPaneSpawn/armPane ficam
> (paneLifecycle futuro). Higiene: 19 imports órfãos criados pela rodada
> removidos (diff de órfãos contra bb4a02e — sujeira pré-existente NÃO
> foi tocada). index.ts 11768→8225 na rodada; **19448 (pré-obra) → 8225 =
> −58%**. Restam no index: 15 registros de IPC (pty/panes + crash/perf)
> + boot/recovery + armPane/mcpPaneArgs + verificação de plano + overlays
> + helpers de projeto. DÉBITO REGISTRADO: missionEngine nasce com ~2,2k
> linhas (acima da régua de código limpo; partição futura sugerida:
> missionLifecycle × integrationQueueEngine — costura fina já mapeada no
> doc da varredura). PRÓXIMO: paneLifecycle.ts (pty:create 793L + guards
> + livePaneSpecs/closingPaneIds/paneEverSpawned + ipc/panes) — último
> grande corte da Fase 1; boot de validação do dono cobre 6a–6f antes.
>
> ESTADO 8 (2026-08-08, mesma sessão, pós-boot de validação dos 6a–6f):
> **PANELIFECYCLE EXTRAÍDO em 3 commits** (7a 757ecd3 · 7b 4a29e4a ·
> 7c e55a57d), todos verdes (typecheck node+web + 39/25/14/14/8).
> Varredura Opus única (docs/FASE1_MAPA_PANELIFECYCLE.md) com o ACHADO
> ESTRUTURAL que mudou o desenho: o domínio de pane é FUNDAÇÃO, não folha
> — phase/mission/mcpApi/ipc consomem 8 símbolos dele e ele consome só 4
> de volta (todos dentro de handlers IPC). Separando engine × IPC, a
> ordem de construção virou **paneLifecycle → mission → maestro → phase**
> com ZERO arrow late-bound no engine. Módulos novos: paneLifecycle.ts
> (687L: armPane/mcpPaneArgs, estado vivo, encerramento, servidor de
> teste, tickHelperOpenWatchdog) · ipc/pty.ts (954L: pty:create INTEIRO —
> as 4 closures token/statsWatchHandle/preparationTicket/lastMaestroCtx
> proíbem fatiar — + write/resize/kill/startup) · ipc/panes.ts (244L).
> Risco 🔴 pago: o phaseEngine desestrutura ctx.livePaneSpecs/
> closingPaneIds NA CONSTRUÇÃO — o paneLifecycle nasce ANTES de todos
> (comentário-âncora no index e no cabeçalho do módulo; TDZ seria crash
> de boot, não erro de typecheck). Invariantes preservados verbatim: a
> corrida armPane×cleanPaneMcpFile (re-grave no spawn + pty:kill nunca
> desarma + desarme só no onExit sob guard de geração — agora em 3
> módulos, comentários contam a história) e o selo `maestro-<key>` (os 4
> escritores viajaram juntos no ipc/pty; o leitor no maestroEngine não
> mudou). ipc/guards.ts do mapa antigo foi DESCARTADO por ora
> (bindUiSender escreve uiSender — exigiria state-accessor — e é extra de
> 11 módulos; os asserts pertencem ao futuro corte de overlays). Lição
> mecânica nova: substituição regex em corpo verbatim QUEBRA shorthand de
> objeto (`mcpPort,` → `ctx.mcpPort,`) — conferir todo `{ ...shorthand }`
> e argumento posicional após o subst. Higiene: 35 imports órfãos novos
> removidos (diff contra 0cd958b). index.ts 8225→6658;
> **19448 (pré-obra) → 6658 = −66%**. MARCO: todos os 136 handlers de
> IPC vivem em src/main/ipc/ — no index ficam só crash:renderer/
> perf:renderer-stall (module scope, por desenho). Restam no index:
> boot/recovery · overlays (SynVoice/ANDAMENTO) + asserts de sender ·
> verificação de plano · helpers de projeto/closure compartilhados ·
> construção dos engines/ctx/mcpApi. DÉBITO: ipc/pty.ts ~950L dominado
> por um handler (partição futura do pty:create em obra própria);
> restante do débito do ESTADO 7 segue. PRÓXIMO: boot de validação do
> dono cobrindo 7a–7c; depois a Fase 1 entra em cortes MENORES
> (overlays/verificação de plano) ou encerra e abre a Fase 2 (veredito
> sem barreira síncrona) — decisão do dono.
>
> ESTADO 9 (2026-08-08): **FASE 1 CONCLUÍDA — decisão do dono após o boot
> de validação dos 7a–7c ("boot limpo, pode fechar")**. Placar final da
> cirurgia: index.ts 19.448 → **6.658 linhas (−66%)** em 19 commits de
> código verdes + registros, TODOS com typecheck node+web + as 5 suítes
> (39/25/14/14/8) e ZERO regressão de comportamento reportada nos 3 boots
> de validação (pós-commit 3, pós-6a–6f, pós-7a–7c). Módulos nascidos na
> obra: phaseTypes · mainContext (MainContext + PhaseApi) · phasePrompts ·
> phaseEngine (4.114L) · mcpApi/ (9 módulos) · ipc/ (16 módulos, 136
> handlers = TODOS os de renderer) · cliSessionTransplant · maestroEngine
> · missionEngine (2.253L) · paneLifecycle — mais a máquina headless morta
> removida (−1.108L, commit 0.5). O que o index AINDA é (por desenho, não
> por dívida): boot/recovery, overlays (SynVoice/ANDAMENTO) + asserts de
> sender, verificação de plano, helpers compartilhados do closure e a
> COSTURA de construção (ctx → paneLifecycle → mission → maestro → phase →
> mcpApi → registro de IPC → createWindow) — a ordem é contrato, com
> comentários-âncora. DÉBITOS que ficam para obras próprias (registrados,
> nunca "aproveitar e refatorar"): partição do missionEngine
> (missionLifecycle × integrationQueueEngine) · partição do pty:create
> dentro do ipc/pty · corte de overlays + asserts (ipc/guards.ts renasce
> lá, se fizer sentido) · verificação de plano · missionWatches morto
> (card de higiene) · sujeira de imports pré-obra anotada. PRÓXIMA OBRA
> DO NÍVEL 5: **Fase 2 — veredito sem barreira síncrona (CHECK 1
> núcleo)**, agora com o terreno preparado: advancePhase vive no
> phaseEngine com contrato SYNC explícito no PhaseApi, e a conversão a
> lock-por-card tem os call sites todos mapeados pelos módulos. Exige
> plano próprio + teste novo de corrida (2 vereditos simultâneos + 
> veredito × boot) antes de qualquer linha.

Âncoras reais (index.ts de hoje): bindUiSender :463 · mcpPaneArgs :3988 ·
armPane :4062 · recovery de boot :6797–6943 · completeMissionMerge :7344 ·
syncBoard :10263 · preparePhasePane :10949 · construtores de prompt
(devContract :11539, atomicRoundRule :11616) · retryOrBacklog :12078 ·
finalizeTask :12561 · openGatePane :12909 · advancePhase :13098 · poller
:13709 · mcpApi :15139 · startMcpServer :18894.

Commits pequenos, revisáveis, suítes verdes a cada um:

1. **`MainContext`** (interface explícita: ptys, hub, tasks, missions,
   projects, seats, backlog, maestro, blackbox, settings, uiSender,
   phaseWatches, liveGateWaits…) — commit 1, zero movimentação de código.
2. **Construtores de PROMPT das fases** → `phasePrompts.ts` (funções puras;
   devContract/atomicRoundRule/prompt-delta/recovery). Menor acoplamento do
   arquivo, maior densidade de texto.
3. **`mcpApi`** (~15139 até o fim, o maior bloco) → pasta `mcpApi/` por
   domínio (board/tasks/missions/helpers/gates/imagens), cada módulo
   recebendo MainContext.
4. **Máquina de fases** → `phaseEngine.ts` (preparePhasePane, advancePhase,
   retryOrBacklog, openGatePane, finalizeTask, poller, liveGateWaits,
   gateDeathLog, phaseWatches).
5. **Grupos de IPC por domínio** → `ipc/<dominio>.ts` (voice 25, maestro 14,
   tasks 11, skills 10, projects 7, …).

Critério de pronto por commit: `npm run typecheck` + suítes da área
(orchestrator-flow 35, mission-verification 25, integration-queue,
pane-permissions, pty-transcript) + boot de validação TEU ao fim de cada
bloco. Nunca "aproveitar e refatorar" fora do mapa.

## Fase 2 (5a parte 2) — veredito sem barreira síncrona (CHECK 1 núcleo)

> ESTADO 1 (2026-08-08): **PLANO FORMAL ESCRITO — aguarda aprovação do dono
> antes de qualquer código.** Varredura por 2 agentes Opus em paralelo com
> revisão por amostragem (4/4 checagens de cada mapa conferidas no código):
> `docs/FASE2_MAPA_VEREDITO.md` (caminhada do advancePhaseInner, 5 desfechos,
> transação do report, riscos R1–R13) e `docs/FASE2_MAPA_CONCORRENTES.md`
> (66 sites de phaseWatches em 12 módulos, poller/boot, 11 interleavings,
> tabela de 22 entrantes). O plano em **docs/FASE2_PLANO.md**: primitiva
> `PhaseTransitionLock` (try-acquire síncrono + fila de espera, token Symbol,
> sem estado em disco), 3 regras de ouro (aquisição só em ponto de entrada;
> acquire→detach→unlink síncronos; quem SEGURA O LOCK deleta o watch),
> conversão com git CONSOLIDADO em 1-2 viagens ao worker (devDeliveryFacts/
> gateVerdictFacts — nunca 1:1, R10), 5 correções de transação embutidas
> (R7/R8/§6.1/§7.4/§7.10), harness de corrida contra o engine REAL
> (precedentes store-atomicity + mission-worktree), matriz de 13 casos
> (incl. 2 vereditos simultâneos + veredito × boot + fallback síncrono) e
> fatiamento em 5 commits (c4 SERIALIZA sem mudar comportamento; c5
> DESSINCRONIZA). Achados que mudaram o desenho: os 2 blocos `bloqueada` do
> report ficam FORA do advancePhase e entram no lock; `recoverFinalizingTask`
> muta o card com watch sintético (lock por taskId, nunca por watch); 3
> buracos JÁ existentes hoje (§7.1/§7.9/§7.10); bug latente da memoização ×
> onExit (§6.1); divergência doc×código: `phase-watch-repaired` não existe
> mais em src.
>
> ESTADO 2 (2026-08-08): **PLANO APROVADO pelo dono ("Vamos para a F2") e
> F2-c1 FEITO** (5f43b80): src/main/phaseTransitionLock.ts (puro, molde do
> phaseLaunchGuard — try-acquire síncrono com token Symbol, fila FIFO com
> TRANSFERÊNCIA de posse no mesmo tick do release, isLocked/holderLabel/
> lockedCount(projectId)/snapshot, onContention que nunca lança) + suíte
> test:phase-transition-lock (9 asserções). Verde: typecheck node+web +
> 39/25/14/14/8 + 9. ESPIGA DO F2-c2 POSITIVA na mesma data: o fecho de
> imports do phaseEngine (65 módulos) compila limpo com
> `tsc --noCheck --module node16` para .tmp/ — o harness de corrida usa esse
> emit + stub de electron E de ./gitAsync via Module._load (precedente
> test-store-atomicity; o stub do gitAsync é o gate controlável que pausa o
> veredito em cada await). PRÓXIMO: F2-c2 — ctx fake mínimo + fixture git +
> baseline dos fluxos atuais. Fora da fase, mesma data: patch do empacotado
> portado da main (e944325 — userData próprio %LOCALAPPDATA%\Synkora +
> origem file:/// do microfone, sondada em probe-file-media-origin +
> aviso de captura negada); o SynVoice do instalado foi validado pelo dono.
>
> ESTADO 3 (2026-08-08): **F2-c2 FEITO** (59c961f):
> scripts/test-phase-verdict-races.mjs — o engine REAL roda em node cru
> (fecho de 65 módulos via tsc --noCheck; stubs de electron E ./gitAsync por
> Module._load — o stub do gitAsync tem gate `beforeCall` pronto para as
> corridas do c5), ctx fake mínimo (só o que o createPhaseEngine
> desestrutura na construção) com TaskStore REAL (commit atômico de
> produção) e fixture git REAL em tmpdir. 6 baselines dos fluxos ATUAIS:
> dev done→review · drift de fotografia (false re-indexa o watch) ·
> reprovada limpa · aprovada→qa · gate-que-escreveu invalidado · sentinela
> de rejeição órfã das continuações `void` (zerada). DESCOBERTA do baseline
> que vira asserção permanente: o PREFIXO SÍNCRONO do retryOrBacklog
> (disparado com `void` de dentro do veredito) zera verification.dev e a
> evidência do gate reprovador ANTES de o advancePhase retornar — é a
> ordem exata que o §6.1 do plano protege na conversão async. Verde:
> typecheck + 39/25/14/14/8 + 9 + 6. PRÓXIMO: F2-c3 — pacotes de fatos git
> no worktree.ts (devDeliveryFacts/gateVerdictFacts/quarantineAndRevalidate)
> + extração do reviewArtifactIdentity para reviewEvidence.ts + registry.
>
> ESTADO 4 (2026-08-08): **F2-c3 FEITO** (646fe98): worktree.ts ganha os 3
> pacotes de fatos do veredito (gateVerdictFacts · quarantineAndRevalidate —
> fingerprint/snapshotProblem só valem com moved>0 · devDeliveryFacts — com
> a divergência DOCUMENTADA: fotografia incompleta conta como drift, mais
> estrito que o inline antigo); reviewArtifactIdentity movido do closure do
> phaseEngine para reviewEvidence.ts (import síncrono, comportamento
> idêntico) e reviewEvidence entra no registry do gitWorker + GitApi +
> fallback síncrono do gitAsync. Sem consumidor via gitOff até o c5.
> Órfãos do corte removidos (closeSync/openSync/readSync/createHash do
> phaseEngine). Testes: mission-worktree 24→27 (os 3 pacotes com fixture
> git real) e phase-verdict-races 6→7 (identidade sha256 via módulo
> compilado). Verde: typecheck + 39/25/14/14/8 + 9 + 7 + 27. PRÓXIMO:
> F2-c4 — SERIALIZAR: lock ligado em todos os entrantes da tabela §3.3 do
> plano com advancePhase AINDA sync (comportamento idêntico; recusas e
> contagens já testáveis).
>
> ESTADO 5 (2026-08-08): **F2-c4 FEITO** (c18afd7) — SERIALIZAR: a tabela
> §3.3 INTEIRA ligada com advancePhase ainda SYNC. O engine cria o
> PhaseTransitionLock (onContention → blackbox `phase-transition-contention`)
> e o expõe em ctx.phaseTransitions + `phaseOccupancy(projectId, exclude?)`
> (watches + locks sem watch — §7.6, sem dupla contagem). Entrantes:
> report adquire SÍNCRONO (sites A/B, ordem acquire→detach→unlink; blocos
> `bloqueada` gate/dev com try/finally próprio; falha = recusa com receita);
> poller adquire após o guard (posse cobre rodada EM VOO; o re-check por
> referência FICA para rodada já fechada — decisão documentada no código:
> remover no c4 seria regressão) e PULA card locked nos ramos stale/
> pane-open-lost; setPhaseExecutorImpl ESPERA (waitAndAcquire + span
> `advancePhase:lock-wait`, padrão wrapper→Locked com guards baratos
> pré-lock); recoverFinalizingTask e respawnInterruptedPhase adquirem;
> run_task/delete_task/removeTaskCascade/projects:relocate recusam com
> receita; arquivar/excluir missão pré-checa com a LISTA dos cards e o
> stopMissionExecution pula card locked como cinto; tasks:update trata lock
> como hasActivePane; sweepProjectFiles preserva marcador (§8.4); onExit só
> consulta (`pane-exit-during-transition`, §7.7). POSSE DO RELEASE (desenho
> cravado): advancePhase é o dono a partir da chamada — release imediato nos
> desfechos sem continuação (incluindo throw: no c4 o rollback do call site
> roda na MESMA pilha; a ordem set→release do §8.2 revisita no c5) e no
> SETTLE da cadeia via `chainContinuation` (as 7 disparadas `void` viraram
> chainContinuation — o prefixo síncrono do retryOrBacklog intacto);
> tripwire `phase-advance-without-lock` no Inner (token vira 6º parâmetro
> opcional do PhaseApi). BÔNUS da tabela: finalizeTask agora mata panes via
> terminatePaneNow (o kill cru deixava a identidade viva para o onExit).
> JANELA NOVA JÁ NO C4: o lock vive do acquire até o settle da continuação
> (openGatePane ~1-4s, finalize ~4s) — run_task/remoções nesse meio recusam
> (fecha §7.5/§7.9 de graça); baseline 1 do harness PROVA isLocked=true logo
> após o retorno sync e false pós-settle. Harness: baselines entram como
> entrante real (acquire+token) e 2 testes novos (recusa+contenção+anomalia
> sem posse · phaseOccupancy) — races 7→9. Verde: typecheck node+web +
> 39/25/14/14/8 + 9 + 9 + 27. PRÓXIMO: **F2-c5 — DESSINCRONIZAR** (§4 do
> plano, o corte real): advancePhaseInner async via gitOff com os pacotes de
> fatos do c3, regras de frescor (§4.3), R7/R8/§6.1/§7.4/§7.10, PhaseApi
> `Promise<boolean>`, report async, poller await, cicatrizes reescritas e a
> matriz de 13 corridas ligada no harness (gate beforeCall do stub).
>
> ESTADO 6 (2026-08-08, mesma sessão): **F2-c5a + F2-c5b FEITOS** (a28503c ·
> f0eb122) — **O CORTE DA FASE: a barreira síncrona do veredito morreu.**
> c5a (ramo GATE + infra async): PhaseApi.advancePhase → Promise<boolean>
> (typecheck forçou os call sites); o preâmbulo do gate viaja ao worker em
> UMA viagem (gateVerdictFacts) + quarentena numa 2ª só quando dispara
> (quarantineAndRevalidate) + sha256 do artefato via
> gitOff('reviewArtifactIdentity') (R11); RELEITURA ÚNICA pós-awaits
> (latestForSnapshot alimenta recordGate/prevRound/gateNotes/qaEvidence —
> R4); rejectingGate por PARÂMETRO até o retryOrBacklog (§6.1);
> comentário-âncora de leitura TARDIA do planTask (§7.8);
> reindexWatchForRollback (renova createdAt §7.4 + cede ao watch novo R2 com
> phase-rollback-superseded e limpeza do artefato velho); R7 (recordGate
> ANTES dos efeitos destrutivos nos desfechos inválido/ilegível) e R8
> (ilegível numa gravação só via extraPatch do recordGate); call site A do
> report ganhou a transação do B; POSSE NO THROW: o advancePhase NÃO solta —
> o call site re-indexa e SÓ ENTÃO solta (rollbackVerdictTransaction no
> PhaseApi, §8.2), poller incluído (catch + evento
> phase-marker-verdict-failed); report.ts async ponta a ponta; as 5
> cicatrizes REESCRITAS (mainContext, phaseEngine ×2, report.ts,
> worktree.ts). c5b (ramo DEV + §7.10): devDeliveryFacts numa viagem (eram
> até 7 chamadas git síncronas — o stall de toda entrega); fingerprint do
> patch PRÉ-calculado; releitura única latestDelivery; devSnapshot POR VALOR
> — codeReportGuard devolve { blocked?, devSnapshot? } e a fotografia viaja
> guard → report/poller → advancePhase como argumento (o campo compartilhado
> virou fallback; guards concorrentes não contaminam mais a decisão um do
> outro). Verde nos dois: typecheck + 39/25/14/14/8 + 9 + 9 + 27 +
> mcp-protocol 5 + mcp-dual-era 32 clients (stub do dual-era atualizado ao
> contrato novo do guard). EM VOO (delegado a 2 agentes Opus, liberados pelo
> dono nesta sessão): matriz §5.3 de corridas no harness (gate beforeCall) +
> revisão adversarial do diff c5a+c5b contra o plano — desfecho no próximo
> ESTADO. Depois: validação AO VIVO do dono (critério §1.3: advancePhase:*
> some do ranking de stalls no bbwatch).
>
> ESTADO 7 (2026-08-08, mesma sessão): **F2-c5c + F2-c5d FEITOS** (0cc0535 ·
> a1ada85) — os dois agentes Opus entregaram e o resultado foi integrado.
> c5c (MATRIZ §5.3, escrita por agente em worktree isolado e integrada após
> conferência): phase-verdict-races 9→18 — `pauseGitTrip` pausa a n-ésima
> viagem gitOff (filtrada por cwd) e injeta o concorrente NA janela do
> await; casos 1+2 (2º entrante recusado durante a pausa), 5 (pausa do
> plano no meio — leitura tardia honrada), 6 (card removido → throw +
> rollback), 6.1 do mapa (COM contraprova viva do bug latente sem o
> parâmetro rejectingGate), 7 parcial (zero commits na pausa; veredito = UM
> commit), 9 (R7 com artefato REAL em disco), 10 (R2 superseded), 11 (R9
> fallback síncrono), 13 (cards diferentes nunca se serializam). Fidelidade
> do harness consertada pelo agente: realGitApi ganhou reviewEvidence (sem
> ele TODO gate com artefato era invalidado por acidente do stub) e o
> fixture roda ensureSynkoraGitExcludes como a produção. Casos 3/4/8 NÃO
> alcançáveis pelo fecho compilado (moram em mcpApi/board, ipc/pty,
> mcpApi/code) — cobertos pela validação ao vivo; mapa de cobertura no
> cabeçalho do arquivo. c5d (REVISÃO ADVERSARIAL — veredito APPROVED WITH
> FIXES; 7/7 equivalências semânticas conferidas, zero await esquecido,
> zero vazamento de lock): F1 🔴 o await novo do sha256 (R11) abria janela
> ANTES do acquire no report — re-check de vigência pós-await (a defesa do
> poller, agora simétrica); F3 as 2 cicatrizes sobreviventes que mentiam
> (engine + index) reescritas; F4 o retryOrBacklog da rodada vazia agora é
> AGUARDADO dentro da cadeia do token; F5 o prefixo do finalizeTask tira
> fingerprint + status --porcelain do main (senão advancePhase:finalize
> seguiria no ranking e o critério §1.3 daria falso negativo); + higienes
> (acceptance à prova de throw pós-acquire, releitura do securityReview na
> fotografia única, ordem sagrada no poller, TDZ do code.ts, leitura
> pré-await de gates documentada). DÉBITOS REGISTRADOS (fora do gate da
> fase): test-harness-lifecycle VERMELHO (26 falhas) — dano PRÉ-EXISTENTE
> da Fase 1 (âncoras apontam para index.ts; implementações migraram) que
> inclui as âncoras que guardavam a ordem R7/R8 — re-apontar ou aposentar,
> decisão com o dono; gateVerdictFacts faz 2 varreduras de árvore por
> viagem (fingerprint explícito + o interno do snapshotProblemFor) — R10
> cumprido em viagens, não em custo de worker; probes antigos usam o
> contrato velho do codeReportGuard (sondas descartáveis). **O QUE FALTA
> PARA FECHAR A FASE 2**: validação AO VIVO do dono — uma missão com gates
> atravessando dev→review→QA e `node scripts/bbwatch.mjs --grep stall`
> provando que advancePhase:* sumiu do ranking (critério §1.3), zero
> `phase-advance-without-lock`, contenções raras e explicadas. PUSH segue
> pendente (decisão do dono).
>
> ESTADO 8 (2026-08-08, mesma sessão): **FASE 2 CONCLUÍDA — VALIDAÇÃO AO
> VIVO POSITIVA do dono** ("o aplicativo subiu, eu testei, melhorou
> bastante; nada se compara ao que estava antes"). Nota de incidente da
> sessão: o node_modules do checkout principal foi esvaziado pela remoção
> do worktree do agente (junction atravessada) — recuperado na hora com
> npm ci + node_modules/electron/install.js; lição gravada em memória
> (feedback-worktree-junction-node-modules). RESIDUAL RELATADO pelo dono:
> "leve travadinha ao clicar no projeto" — isso NÃO é o veredito: é a
> ABERTURA do projeto (spawn escalonado de panes/maestro, paneSpec,
> renderer/WebGL — a família do CHECK 2, cuja solução de fundo é a FASE 3
> multi-renderer, Vertente B já decidida pelo dono). A 1ª tarefa da próxima
> sessão é a TRIAGEM BARATA desse residual: `node scripts/bbwatch.mjs
> --grep stall` no journal do uso de hoje NOMEIA o culpado (a Fase 0
> instrumentou boot:*, ipc:*, mcp:* e os wrappers) — e de quebra confirma o
> critério §1.3 formal (advancePhase:* fora do ranking, zero
> phase-advance-without-lock, contenções raras). Se o culpado do clique for
> renderer/WebGL/spawn → vira EVIDÊNCIA da Fase 3, não conserto manual; se
> for algo barato e nomeado → card pequeno.
>
> ESTADO 9 (2026-08-08, sessão seguinte): **TRIAGEM DO RESIDUAL FEITA —
> critério §1.3 formal FECHADO**: `advancePhase:*` AUSENTE de todos os
> culprits (0 ocorrências nos journals de 02–08/08), zero
> `phase-advance-without-lock`, zero `phase-transition-contention`. A
> Fase 2 está limpa no journal. **A travadinha do clique tem culpado
> NOMEADO** (journal dev, 2026-08-07 19:31:12Z, boot 942c3b6f, uptime 11s,
> stall ~1457ms): `ipc:missions:paneSpec` ×3 (~474+457+445ms) +
> `ipc:maestro:paneSpec` (~194ms). Leitura do código: missions:paneSpec
> roda GIT SÍNCRONO no main por missão — `ensureMissionWorktree`
> (missionEngine.ts:191: hasGitCommit + isExpectedWorktree +
> ensureSynkoraGitExcludes, todos execFileSync de worktree.ts) +
> ensureProjectSecurityBaseline; abrir projeto com N missões ativas =
> N×~450ms de main parado (o escalonador de 350ms espaça os SPAWNS, não o
> custo síncrono de cada spec). NÃO é evidência da Fase 3 (nenhum culpado
> renderer/WebGL). **CARD PEQUENO registrado**: caminho de LEITURA do
> paneSpec viaja por gitOff (o registry do gitWorker já tem worktree.ts e
> missions:paneSpec já é async); mutação de estado fica no main com guarda
> anti-janela-de-await — mesmo padrão da cópia de skills (F6.8). Observação
> menor: os 15 stalls de 08/08 são todos de BOOT (~1,6–1,8s, uptime 3–6s) —
> culprits nomeados somam só ~200–900ms (boot:progressSnapshot ~190ms +
> syncBoard em rajada 5×~125ms); o resto é overhead de partida
> não-instrumentado (dev/GC por eliminação, hipótese da Fase 0 rodada 2). O
> INSTALADO (userData próprio) registrou 2 boots com ZERO stalls.

- Hoje `advancePhase` é SYNC POR CONTRATO (comentário-âncora em :10855; a
  cicatriz do "[object Promise]"): a fotografia atômica é garantida por
  sincronicidade, e o git síncrono no main é o stall de toda transição.
- Desenho proposto: **lock de transição por card** (fila serializada
  taskId→Promise) + `snapshotProblemFor` viajando pelo gitWorker (gitOff) +
  estado transitório do card durante a validação (nenhuma segunda transição
  entra enquanto o lock vive; poller e report respeitam o lock — a
  idempotência "quem chega primeiro deleta o watch" passa a ser "quem SEGURA O
  LOCK deleta o watch"). O contrato (nenhum veredito com fotografia velha)
  fica preservado por SERIALIZAÇÃO, não por sincronicidade.
- Risco alto: call sites do advancePhase viram await; teste novo obrigatório
  de corrida (2 vereditos simultâneos no mesmo card + veredito × boot).

## Fase 3 (5b) — multi-renderer (CHECK 2; sessão própria)

- Sonda positiva de 2026-08-06 (probe-webcontentsview-webgl): WebContentsView
  = renderer PRÓPRIO por view, 16 contextos WebGL POR view, ~107MB/view.
  Decisão do dono já tomada: Vertente B ("meu PC tem 32GB").
- Corte 1: Board (PM+orquestradores) numa view, canvas de Panes noutra —
  dobra o orçamento WebGL e divide o parse dos streams por 2 processos de
  renderer. `pty:data` é limpo (o main roteia por webContents).
- Custos mapeados: drag ENTRE views = migração de processo (recriar xterm +
  SIGWINCH repinta — sondar codex antes); store zustand por renderer
  (sincronizar via push do main, que já é o padrão); portais/overlays por
  view.
- Complemento posterior: pool WebGL por visibilidade.

## Fase 4 (5c) — QA de Electron com app real via CDP (1 janela + validação)

- `@playwright/mcp` aceita `--cdp-endpoint` (sondado 2026-08-07). qaRuntime
  detecta produto Electron → sobe o app real com
  `--remote-debugging-port=<porta livre do mapa>` → o wrapper playwright do
  pane QA ganha `--cdp-endpoint http://127.0.0.1:<porta>` → QA testa
  preload/IPC REAIS (o duplo de bridge morre).
- Conferir na implementação: árvore do Electron do produto sob o guardião
  (guardExternalPid no filho real), e o ciclo da janela do produto na tela do
  dono durante o QA (prompts já mandam fechar ao fim da rodada).

## Fase 5 — correio MCP até o fim: ZERO digitação entre agentes (ordem do dono, 2026-08-07)

Ordem literal: "não quero mais NADA sendo enviado por texto e mandando Enter —
pode me atrapalhar na hora que eu estiver escrevendo; quero a conversa entre
eles extremamente rápida" (memória `feedback-zero-digitacao-entre-agentes`).

- Pré-condição (regra do handoff): validar o F1 ao vivo primeiro —
  mailbox-post/mailbox-delivered no journal, agentes reagindo ao bloco
  "[synkora inbox]", nudge não poluindo. Acontece no uso normal com missões.
- **F2**: correlationId fim-a-fim (HubDeps.inject ganha meta; coalescência por
  FATO no lugar do dedup por texto) + migrar TODOS os injetores diretos
  restantes para o correio.
- **F3**: aposentar a digitação de payload por completo — `delivery-injected`
  no journal vira exceção registrada como anomalia.
- DESENHO DO ACORDAR-SEM-INPUT (ideia do DONO, SONDADA em binário real
  2026-08-07, probe R12/R13 no claude 2.1.224 — o limite físico caiu):
  (1) pane COM shell (dev/orquestrador/ajudante) arma um WAITER em background
  ao entrar em espera — comando que long-polla a mailbox; quando ele termina
  (mensagem chegou), o CLI acorda o agente com a notificação de background
  task, ZERO input (R12: WAITING → turno encerrado → 25s → WOKE-UP sem
  digitação); (2) gate read-only (sem shell, de propósito) usa LONG-POLL na
  própria tool check_messages — o servidor segura a resposta até ter mensagem
  (R13: tool call segurada 45s no perfil exato do gate, sem timeout; calibrar
  o teto por ciclo de re-poll na implementação). Digitação sobra como último
  recurso AUDITADO (anomalia no journal) — nunca remover a rede inteira.
  Sondar o equivalente no codex antes de generalizar (background/long-poll).
- Encaixe: pode rodar ANTES da Fase 3 (multi-renderer) se a validação do F1
  vier limpa — é menor que qualquer fase da cirurgia e independe dela; a
  Fase 1 (extração do mcpApi/hub) deixa o terreno mais limpo para o F2.

> ESTADO F5-1 (2026-08-08): **SONDA CODEX FEITA**
> (scripts/probe-codex-mailbox-wait.mjs; resultado em
> .tmp/probe-codex-mailbox-wait.json; codex 0.147.0, gpt-5.6-luna, servidor
> MCP REAL do app com api stub, perfil exato do gate codex):
> **(a) LONG-POLL POSITIVO** — o cliente MCP do codex espera a resposta de
> uma tool call segurada por 45s E 75s SEM nenhuma config (W2/W3
> long-poll-ok; o marcador voltou ao modelo); o knob por servidor
> `mcp_servers.synkora.tool_timeout_sec` existe e funciona (W4 com 300s).
> O R13 do claude tem equivalente codex PROVADO: gates/panes codex podem
> esperar correio via check_messages long-poll.
> **(b) WAITER BACKGROUND NEGATIVO** — com `--enable unified_exec` o
> catálogo ganha functions.exec + functions.wait (W5a), mas processo
> background que TERMINA não acorda o agente pós-turno (W5 TUI real via
> PowerShell -EncodedCommand: WAITING confirmado no ROLLOUT, 180s de espera,
> nunca WOKE-UP). A espera do codex é DENTRO do turno (functions.wait /
> tool MCP segurada) — o waiter pós-turno R12 fica EXCLUSIVO do claude; o
> caminho universal codex é o long-poll do check_messages.
> Pegadinhas cravadas na sonda: perfil de gate codex exige
> codexGateMcpPolicyArgs (default_tools_approval_mode="approve") — sem ela
> AUTO-NEGA ("user cancelled MCP tool call"), bypass indiferente; e detectar
> resposta de TUI codex pela TELA dá falso positivo (eco do prompt) — só o
> rollout vale (mesma lição do R7 claude).
>
> ESTADO F5-2 (2026-08-08, mesma sessão): **F2 COMEÇOU — correio entrega de
> verdade** (docs/FASE5_INVENTARIO_INJETORES.md é o mapa completo; 4 bugs do
> F1 achados na varredura). c1: a decisão de correio SUBIU para o hub
> (HubDeps.hasMailbox/deliverToMailbox) — entrega de correio é IMEDIATA
> (guardas composer/inFlight/gap são de TECLADO e não se aplicam), desfecho
> auditado novo `mailboxed` (o journal grava `mailbox-post` com meta causal;
> `delivery-injected` volta a significar SÓ digitação real — o falso
> positivo do F1 morreu), nudge 📬 AUDITADO (evento `mailbox-nudge`
> typed/throttled/skipped-composer-busy) e respeitando o composer, mailbox
> com meta causal fim-a-fim (sourcePaneId/kind/correlationId) e coalescência
> por FATO (dedupKey = key da fila do hub). c2: `helper_send` curto (picker)
> vai por TECLADO CRU (bug real do F1: resposta de picker ia para a mailbox
> e a seleção nunca acontecia; pelo hub ainda ganharia prefixo "[synkora]")
> com evento auditado `helper-send-raw-keystroke`; retornos de notify_pane/
> helper_send agora dizem a VIA REAL da entrega. Suíte nova
> test:mailbox-delivery (9). Pendente: validação ao vivo do F1+F2 na
> próxima missão real (nenhuma missão rodou desde F6.10 — journals 07-08
> zerados de mailbox-*), e o F3 (aposentar o nudge via waiter claude +
> long-poll check_messages, agora com os dois lados sondados).
>
> ESTADO F5-3 (2026-08-08, mesma sessão, após "bora, continua" do dono):
> **TRAVADINHA DA ABERTURA APLICADA** — `missionWorkspaceReadout`
> (worktree.ts, no registry do gitWorker) agrupa excludes + hasGitCommit +
> isExpectedWorktree numa viagem única; missions:paneSpec usa com guarda
> anti-janela-de-await e maestro:paneSpec manda o excludes por gitOff
> (suíte mission-worktree 27→29). **F3a APLICADO** — check_messages vira
> LONG-POLL (PaneMailbox.waitFor + McpApi.waitForMail; teto 45s dentro do
> provado; tool_timeout_sec=300 nos panes codex; prompts ensinam o ciclo;
> prefixo [synkora] embutido removido de 11 textos). **F3b APLICADO** —
> endpoint GET /mail-wait (auth bearer, teto 10min, close() drena
> pendurados) + env SYNKORA_MAIL_WAIT_URL + buildIdleWaiterHint(cli) no
> devContract/orquestrador/PM (claude = waiter curl em background; codex =
> loop de check_messages). **VALIDADO em sonda**: W6 com codex REAL =
> `longpoll-mail-read` (check_messages segurada 12s, mensagem chegou no
> meio, o modelo leu); smoke do curl exato do prompt = pendurado até o post
> e MAIL na hora. Suítes novas: test:mail-wait (2) + mailbox-delivery (10).
> O NUDGE 📬 CONTINUA como rede (auditado; "nunca remover a rede inteira")
> — aposentá-lo é decisão do dono APÓS a validação ao vivo de
> waiter+long-poll numa missão real.

## Nota de estado — spec MCP 2026-07-28 (verificado em sonda, 2026-08-07)

- claude 2.1.224: propõe protocolo 2025-11-25 no initialize e REJEITA
  2026-07-28 quando o servidor a oferece (handshake para; sonda R11). A
  string "2026-07-28" existe no binário = código em preparação, não suporte.
- codex 0.147.0: flag `mcp_2026_07_28` presente e DESLIGADA de fábrica
  ("under development"). O app já liga por pane (`--enable mcp_2026_07_28`)
  quando settings.mcpProtocolMode = 'modern-experimental'; em 'auto' espera a
  OpenAI ligar de fábrica. Servidor do Synkora já é dual-era — nada a
  construir do nosso lado; re-sondar a cada update de CLI.

## Ordem e cercas

- Fase 0 → 1 → 2 → 3 → 4, sem sobreposição ("nunca meio-fazer").
- Toda edição de src SÓ com app parado (checagem de processo imediatamente
  antes de cada edit — a prova expira).
- Cada commit reversível e verde; regressão de suíte = parar e voltar.
- Janelas estimadas: F0 = 1 curta · F1 = 2–4 · F2 = 1–2 + validação ao vivo ·
  F3 = sessão própria · F4 = 1 + missão de QA real.

## Pendências que este plano NÃO cobre (ficam onde estão)

- Fix do CHECK 14 (prompt de resume por arquivo) — já desenhado na sessão dos
  níveis 4, entra na primeira janela de app parado, ANTES da Fase 0.
- Correio MCP F2/F3 — depois do F1 assentar em produção (handoff).
