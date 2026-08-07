# FASE 1 — mapa do MainContext (agente Opus, 2026-08-07)

Varredura completa do src/main/index.ts (19.448 linhas na época) para a
modularização. Âncoras: bindUiSender :464 · mcpPaneArgs :4002 · armPane :4076
· syncBoard :10295 · preparePhasePane :10986 · retryOrBacklog :12186 ·
finalizeTask :12669 · openGatePane :13017 · advancePhase :13206 · poller
:13829 · mcpApi :15259 · installInternalMcp :19013. Geografia: 1–306 imports ·
307–2437 escopo de módulo · 2438–19436 corpo do whenReady (~17k linhas).

## ACHADO DE OURO — código MORTO (commit 0.5)

`taskRuns` (Map, :10282) NUNCA recebe `.set()` — a máquina de run HEADLESS
(espelho descartado na F3.5) está morta: `runEmit` :10380, `runLive` :10398,
`runSink` :10402, `startGateRun` :10571 (ciclo fechado) e o bloco 10340–10680
(~340 linhas), mais os handlers no-op `tasks:runPermission` :14172,
`tasks:runInterrupt` :14185, `tasks:runSend` :14190, `tasks:runHandoff`
:14202, `tasks:runClose` :14234, `tasks:runState` :14245. Bug latente
inalcançável em :10503 (`preparePhasePane` sem await mandaria Promise pelo
IPC). Remoção derruba ~400 linhas e tira `taskRuns`/`killRunSessions` do
MainContext. Referências a limpar: :4414 (projects:relocate), :10283–10285,
:10944–10946, :14176–14248. `TaskRun` type :10262 morre junto.

## Estado que o MainContext precisa expor

**Referência estável (`readonly`, atribuídos 1× antes de qualquer consumidor):**
projects :430/:2469 · seats :431/:2470 · tasks :432/:2471 · missions :2472 ·
integrationQueue :2533 · backlog :2536 · maestro :2537 · policies :2538 ·
settings :2539 · ptys :317 · mailbox :3699 · skillsLib :3318 ·
helperSkillLeases :3374 · synVoice :2694 · blackbox :2247 · mainStalls :2325 ·
sessionStats :340 · helperCompletions :338 · maestroSessions :437 · e todos os
Maps/Sets: paneTokens :346 · paneMcpFiles :349 · paneSessions :342 ·
paneStatusNotes :328 · helperReported :331 · helperSeen :335 · livePaneSpecs
:10742 · closingPaneIds :10748 · paneEverSpawned :10755 ·
pendingPtyPreparations :14488 · phaseWatches :10756 · liveGateWaits :12001 ·
gateDeathLog :12005 · gateCooldownUntil :12008 · phaseLaunches :10757 ·
phaseLaunchCapacity :10758 · phaseMarkersProcessing :13825 ·
bootRespawnsPending :12092 · missionWatches :6379 · integrationDrainTimers
:6380 · integrationDraining :6381 · baselineVerificationRuns :4668 ·
finalVerificationRuns :4669 · materializedPlanningSkillsByProject :3366 ·
pendingUserQuestions :10766 (+persistUserQuestions :10776) · testServerPanes
:9846 · voiceRequests :2780 · surveyAborts :9381 · expiredSeats :4220 ·
mcpCatalogServedByPane :15258 · mcpPaneFirstContact :18833 · seenMcpTokens
:18834.

**GETTERS OBRIGATÓRIOS (variável reatribuída em runtime):** uiSender :454
(reatribuído :486/:1076) · mainWindow :455 · mcpPort :362 (:2398/:19019/
:19027) · mcpServerHandle :363 · codeIntelligence :365 · internalMcpState
:18821 (lido por blackbox:tail :3544 e services:get :19109 — cruza fronteira)
· paneStartupMetrics :364 · **hub :361** (atribuído 1× em :3710 — RECOMENDADO
getter para quebrar o ciclo Hub↔contexto; as HubDeps :3711–3812 capturam
projects/ptys/mailbox/blackbox/uiSender/orchPaneId/maestroPaneId).
Callbacks late-bound viram MÉTODOS (nunca campo copiado): killRunSessions ·
abortVoiceRequests · releasePaneSkillLease.

**Funções de closure que toda extração arrasta:** syncBoard :10295 · emitLog
:9060 · scheduleProgressSnapshot :1917 · ensureProjectRuntimeWritable :2642 ·
projectModeOf :2649 · projectPlanOf :2542 · externalPlaywrightForPane :2684
(encapsula 3 lets) · bypassOn :3817 · maestroPaneId :3655 · orchPaneId :3662 ·
unregisterPane :406 · cleanPaneMcpFile :350 · codeIntelligenceSession :414.

**Tipos presos no closure (commit 0 = phaseTypes.ts, risco zero):** RunPhase
:10685 · DevPaneSpec :10686 · PhaseWatch :10706 · PendingUserQuestion :10764 ·
LiveGateWait :11991 · MissionWatch :6372 · (TaskRun :10262 morre no 0.5).
qaRuntime NÃO precisa entrar (singleton próprio em qaRuntime.ts).

**Armadilha:** tasks.onMutation/onCreate/onRemove (:2475–2532) são atribuídos
pós-construção — módulos que recebem ctx.tasks NÃO podem reatribuí-los.

## Acoplamento dos 4 alvos (contagens por grep)

**(a) Máquina de fases (10742–14031, ~3.290 linhas):** preparePhasePaneInner
952L (uiSender=8, seats=8, tasks=8, blackbox=7, hub=6, phaseWatches=5…) ·
retryOrBacklog 225L (tasks=10, backlog=6, uiSender=6, hub=5) · finalizeTask
348L (tasks=14, hub=10) · openGatePane 189L (tasks=10, uiSender=9) ·
advancePhase 619L (tasks=16, hub=15, uiSender=12) · poller 192L
(phaseWatches=9). Chamadores EXTERNOS (contrato obrigatório):
removeTaskCascade :4564 · tasks:setPhaseSeat :9650 · projects:relocate :4416 ·
stopMissionExecution :10936 · onExit do PTY :14862/:15067 ·
mcpApi.codeReportGuard/runTask/report/archiveMission.

**(b) mcpApi (15259–18815, 3.557 linhas, 44 membros):** maestro=70 · tasks=46
· hub=40 · uiSender=34 · seats=28 · backlog=27 · ptys=22 · missions=19.
`report` (16902–17281, ~380L) é O BLOCO MAIS ENTRELAÇADO do arquivo (veredito
+ snapshot + gates vivos + QA runtime + advancePhase) — commit próprio. Corte
por domínio: mailbox → code → board (pesado) → skills → helpers → panes →
missions → images. A montagem final DEVE continuar um objeto único
literal-compatível com McpApi (mcpServer.ts :223–339); spread de módulos ok.

**(c) IPC por prefixo (148 registros):** ilhas primeiro — skills (10, só
skillsLib, PERFEITA) · voice (26, ilha quase perfeita) · seats/settings/
policies/catalog/cli/services/clipboard/files/attachments/dialog (mínimos) ·
backlog (25×) · projects (24×) · tasks/missions/maestro (médios, dependem do
phaseEngine) · **pty POR ÚLTIMO** (6 handlers, ~760L, 27 membros de contexto;
corrida armPane×cleanPaneMcpFile documentada em :14585/:15207; merece módulo
próprio paneLifecycle.ts).

**(d) armPane/mcpPaneArgs (4002–4206):** mcpPort=7 (reatribuída!) ·
paneMcpFiles · settings · hub.registerPane · paneTokens · blackbox. Chamadores
:8938/:10048/:10165/:11832/:17462/:14781/:14585.

## Ordem recomendada (revisão da ordem do plano)

0. **phaseTypes.ts** (tipos do closure → módulo; risco zero; desbloqueio real)
0.5. **matar a máquina headless morta** (~400 linhas, ver acima)
1. **MainContext** (interface + createMainContext logo após :3710; zero
   movimentação) — incluir sub-objeto `ctx.phase` com as assinaturas de
   preparePhasePane/advancePhase/retryOrBacklog/openGatePane/finalizeTask/
   openPhasePane/closePhasePane/terminateTaskPhasePane preenchido no whenReady
   (permite extrair mcpApi antes OU depois do phaseEngine sem retrabalho)
2. **phasePrompts.ts** (FEITO pelo agente; solda em FASE1_SOLDA_PHASEPROMPTS.md)
3. **phaseEngine.ts ANTES do mcpApi** (divergência JUSTIFICADA do plano:
   mcpApi.report/runTask chamam advancePhase/preparePhasePane/openPhasePane e
   mexem em phaseWatches/liveGateWaits direto — :17077/:17101/:17113/:17219/
   :16755) — OU manter a ordem do plano com o ctx.phase acima. Riscos:
   advancePhase SYNC POR CONTRATO (âncora :13472; nunca Promise<boolean>) ·
   MAX_PARALLEL_RUNS :14031 declarado DEPOIS do poller (hoisting — TDZ ao
   virar import) · o poller de 3s mistura fases + missionWatches (cortar em
   tickPhaseWatches/tickMissionWatches) · gateDeathLog escrito no onExit do
   PTY (:14882) — expor phaseEngine.recordGateDeath(taskId), não o Map.
4. **mcpApi/ por domínio** (report em commit próprio)
5. **ipc/<dominio>.ts** (ilhas→pesados; pty por último como paneLifecycle.ts)

## Cercas transversais

- instrumentIpcMain :2326 cobre só handlers registrados DEPOIS dele: módulos
  de IPC exportam `register<X>Ipc(ctx)` CHAMADOS do whenReady — NUNCA
  registrar no import (senão a Fase 0 morre em silêncio).
- Guards de sender (:790–850) + bindUiSender :464 → ipc/guards.ts único.
- uiSender é o campo mais tocado (~150 call sites no padrão
  `if (uiSender && !uiSender.isDestroyed()) uiSender.send(...)`) — expor
  `ctx.push(channel, ...args)` e converter; a blindagem do CHECK 17 ganha
  ponto único.
