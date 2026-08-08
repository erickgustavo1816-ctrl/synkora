# HANDOFF — Fase 1 da cirurgia do índice (pós-commits 6a–6f: engines de missão/maestro)

Atualizado 2026-08-08 (2ª sessão do dia), fim da sessão que executou o
commit 6 em 6 fatias: engines de missão/maestro + ipc/maestro + ipc/missions.
A PRÓXIMA SESSÃO lê este arquivo PRIMEIRO, depois o ESTADO 7 da Fase 1 em
docs/PLANO_NIVEL_5.md e os mapas das varreduras
(docs/FASE1_MAPA_MISSIONENGINE.md · docs/FASE1_MAPA_MAESTROENGINE.md).

## ONDE A OBRA ESTÁ + PRÓXIMO PASSO (leia isto e os blocos da data)

- index.ts: 19.448 (pré-obra) → **8.225 linhas (−58%)**. Módulos novos desta
  sessão: cliSessionTransplant.ts (73L puro) · maestroEngine.ts (555L) ·
  ipc/maestro.ts (641L, 18 handlers) · missionEngine.ts (2.247L) ·
  ipc/missions.ts (610L, 8 handlers). Commits 6a a0f541f · 6b 423ac81 ·
  6c 1951d33 · 6d eac1547 · 6e 55ca27e · 6f 277c50b — cada um verde
  (typecheck + 39/25/14/14/8).
- O que RESTA no index, por dono: panes/pty (paneLifecycle.ts futuro:
  pty:create 793L + panes:freeSpec/live/portsInUse/testServerSpec +
  livePaneSpecs/closingPaneIds/paneEverSpawned + bindUiSender/asserts +
  armPane/mcpPaneArgs + staggerPaneSpawn) · boot/recovery · overlays
  (SynVoice/ANDAMENTO) · verificação de plano · helpers de projeto ·
  crash/perf (2 handlers de module scope, ficam por desenho).
- **PRÓXIMO PASSO RECOMENDADO: paneLifecycle.ts** (o último grande corte da
  Fase 1) — varredura própria antes do corte, nos moldes das anteriores.
- Fatos das varreduras que a próxima obra precisa saber: ordem de construção
  no index é mission → maestro → phase (PhaseEngineExtras consome
  missionWorkspacePath/ensureMissionWorktree do missionEngine);
  maestroSessions/killMaestroSession FICARAM no index (window-all-closed roda
  fora do whenReady); o teto de resume é escrito no pty:create e lido no
  maestroEngine via chave `maestro-<key>` do maestroStore (preservar o
  prefixo em qualquer refatoração do pty:create); missionWatches está MORTO
  (sem .set() — candidato a card de higiene, nunca dentro da cirurgia);
  missionEngine com ~2,2k linhas é débito registrado (partição futura:
  missionLifecycle × integrationQueueEngine).
- Pendências do dono: PUSH (28 commits locais) e BOOT DE VALIDAÇÃO cobrindo
  os commits 6a–6f (o último boot validado foi pós-commit 5).
- Regras vivas inalteradas: app parado para editar src · cada commit verde
  (typecheck + 5 suítes: orchestrator-flow 39 · mission-verification 25 ·
  integration-queue 14 · pane-permissions 14 · stall-attribution 8) ·
  commits `fase1:` sem acentos · agentes Opus sob liberação do dono por
  sessão · git add por caminho explícito.

## SESSÃO 2 DE 2026-08-08 — como o commit 6 foi feito (para replicar no paneLifecycle)

- **Varredura em 2 agentes Opus PARALELOS** (um por domínio, cada um mapeando
  a fronteira com o outro) → relatórios em docs/ com ranges + âncoras regex
  conferidas 1× + extras tipadas + riscos. Reconciliação: zero conflito de
  faixas; a costura mission↔maestro é toda nos IPC (missions:paneSpec).
- **Scripts de corte por ÂNCORA, nunca por número de linha** (scratchpad da
  sessão: cut-maestro-engine.mjs, cut-ipc-maestro.mjs, cut-mission-engine.mjs,
  cut-ipc-missions.mjs + check-orphan-imports.mjs). Cada script valida toda
  âncora (grep = 1×) e aborta em sobreposição de ranges.
- **Substituições não-verbatim autorizadas** (precedente phaseEngine):
  uiSender→ctx.uiSender · codeIntelligence→ctx.codeIntelligence ·
  releaseSkillLease→ctx.releasePaneSkillLease · drainPendingRespawns→
  ctx.phase.drainPendingRespawns (1×, maestro:paneSpec). Todo o resto
  verbatim; estado nasce nos engines com aliases desestruturados no index.
- **Padrão dos módulos ipc com engine**: extras.engine (o engine inteiro) +
  destructure no registerXxxIpc — corpo dos handlers fica textualmente
  intacto. ipc/missions recebe também `maestroEngine` (Pick de 3 membros).
- **Armadilhas pagas** (não redescobrir): imports do projectPlan têm ALIAS
  (completeProjectMission as completeStoredProjectMission etc.);
  maestroResumeOverBudget tem `const ctx = st.tuiContextTokens ?? 0` que
  SOMBREIA o MainContext — por isso maestro/blackbox são desestruturados no
  factory, nunca substituídos por regex; MaestroSession/CodexSession são
  importados como VALOR no ipc/maestro (instanceof no maestro:send);
  stopMissionExecution lê ctx.phaseWatches/ctx.livePaneSpecs em CALL TIME
  (os aliases nascem no createPhaseEngine, depois do missionEngine — TDZ se
  desestruturar na construção).
- **Higiene de imports por diff de órfãos**: check-orphan-imports.mjs rodado
  no index atual E no index de bb4a02e — só os órfãos NOVOS (19) foram
  removidos; a sujeira pré-existente (basename, nativeImage, GATE_DEATH_LIMIT,
  MAX_PARALLEL_RUNS…) ficou anotada e intocada, fora do mapa desta obra.

## SESSÃO DE 2026-08-08 — o que mudou desde o texto abaixo

- **CHECKPOINT DA FRENTE PARALELA (885c054)**: o working tree chegou com
  ~12,5k linhas NÃO commitadas da outra frente (skills/evidence/harness),
  entrelaçadas com o index (+2,8k nele, incluindo PhaseWatch.reviewArtifact
  — a frente mexeu na própria máquina de fases). Separado em commit próprio
  ANTES do corte, com typecheck + 5 suítes validados verdes naquele ponto.
  A regra "não commitar a família skills" do handoff anterior valia com a
  sessão paralela VIVA; commitar o commit 3 por cima do tree misto seria a
  violação pior (commit irreversível na prática). O dono revisa/reorganiza
  antes do push se quiser — nada foi pushado.
- **COMMIT 3 FEITO (685a77b)**: src/main/phaseEngine.ts com
  createPhaseEngine(ctx, extras). Corte MECÂNICO por range de linha com
  âncoras regex por borda (script; zero redigitação); substituições no corpo
  restritas a uiSender/mcpPort/codeIntelligence → ctx.* (getters reativos) e
  mcpApi.codeReportGuard → extras.codeReportGuard (late-bound por arrow). O
  index mantém ALIASES desestruturados do engine — call sites externos e
  getters do ctx ficaram textualmente intactos. Riscos do mapa todos pagos
  (advancePhase sync, MAX_PARALLEL_RUNS export sem hoisting,
  tickPhaseWatches separado, recordGateDeath no onExit). Fixes de contrato
  no mainContext.ts: advancePhase com arity real de 5 params e phaseWatches
  com detach() estrutural.
- **DIVERGÊNCIA JUSTIFICADA do handoff antigo**: livePaneSpecs/
  closingPaneIds/paneEverSpawned NÃO migraram — a varredura provou que são
  ciclo de vida de pane genérico (pty:create/kill, delegateMany,
  helperClose) e pertencem ao futuro paneLifecycle.ts, não ao engine.
- index.ts: 21.783 (pós-frente-paralela) → **17.988 linhas**. Verde:
  typecheck node+web + orchestrator-flow 39 + mission-verification 25 +
  integration-queue 14 + pane-permissions 14 + stall-attribution 8 (as
  suítes CRESCERAM na frente paralela: 35→39 e 11→14).
- **COMMIT 4 FEITO na mesma data** (2ª rodada da sessão, após o dono validar
  o boot com `npm run dev` limpo): 4a (6ba29fc, PhaseApi +5), 4b (86c4ea1,
  mcpApi/ images+mailbox+code+skills+panes), 4c (7ce43eb,
  missions+helpers+board) e 4d (547082e, report+readReviewEvidence em módulo
  próprio). O literal mcpApi do index é SÓ spreads + hub. Detalhe completo
  no ESTADO 5 do PLANO_NIVEL_5.md. Armadilhas pagas que valem re-ler antes
  do commit 5: mcpPaneFirstContact via ctx.* em call time (nasce depois do
  literal — TDZ na desestruturação); Sets de handshake humano por
  referência; transação do report (detach → advancePhase sync → rollback)
  conferida linha a linha no módulo.
- **COMMIT 5 FEITO na mesma data em 5 fatias** (afd600e/ee61115/aa21558/
  d2e90cf/69a9260): src/main/ipc/ com 12 módulos, 100 dos 138 handlers
  extraídos. Detalhe no ESTADO 6 do PLANO_NIVEL_5.md. O que a PRÓXIMA
  sessão precisa saber antes de continuar:
  1. **Bloco único de registro** antes do `boot:createWindow` — TODA chamada
     `register<X>Ipc(ctx, extras)` mora ali (âncora: comentário "REGISTRO
     DOS MODULOS DE IPC"). O renderer só nasce no createWindow, então
     registrar tarde = registrar cedo, e todo símbolo do closure já foi
     declarado (zero TDZ). NUNCA registrar no import.
  2. **Padrão state-accessor** (voice/progress/settings): lets do closure
     lidos E escritos por handlers viajam como `extras.state` com getters/
     setters no call site — corpo verbatim, escrita `state.x = v` aciona o
     setter. Reusar para qualquer domínio futuro com o mesmo problema.
  3. **PENDENTES DO COMMIT 5, com racional**: ipc/maestro (18 handlers) e
     ipc/missions (8) ficam para a EXTRAÇÃO DOS ENGINES de maestro/missões
     — as extras deles (22/21 entradas: preparePlanningRun, MaestroBackend,
     ensureSession, missionsWithIntegration…) seriam interfaces gigantes
     refeitas por inteiro na extração; fazer junto é o caminho sem
     retrabalho. panes/pty (10 handlers, ~1000L, pty:create com 793L) é do
     **paneLifecycle.ts**, que também leva livePaneSpecs/closingPaneIds/
     paneEverSpawned e o ipc/guards.ts (bindUiSender + asserts — hoje ficam
     no index, passados por extras). crash/perf (2 handlers de module
     scope) ficam onde estão: movê-los mudaria o momento de registro sem
     ganho.
  4. Tipos locais do overlay (SynVoiceOverlayState & cia) estão EXPORTADOS
     do index para import type de '../index' — migram de vez na obra do
     overlay/paneLifecycle.
  5. O script da obra (cut-ipc.mjs, scratchpad da sessão de 2026-08-08) tem
     as três lições mecânicas gravadas: fechamento duplo `})` OU `)` de
     arrow, guard anti-sobreposição de ranges, e inserção no bloco de
     registro APÓS o fechamento da última chamada multiline.
- Nota de ambiente: no boot de validação o claude atualizou 2.1.224→2.1.226
  — a sonda do CHECK 14 (MCP first-turn) foi feita na 2.1.224; re-sondar
  no próximo resume de fase ao vivo.

## Texto da sessão anterior (2026-08-07) — contexto histórico

## Onde a obra está (branch `nivel5-fase1`)

Commits desta sessão, todos verdes (typecheck node+web + orchestrator-flow 35
+ mission-verification 25 + integration-queue 14 + pane-permissions 11 +
stall-attribution 8), NENHUM pushado ainda (5 commits locais à frente de
origin — o dono decide o push):

- `b6784ce` **commit 0** — `src/main/phaseTypes.ts`: RunPhase, DevPaneSpec,
  PhaseWatch, MissionWatch, PendingUserQuestion, LiveGateWait fora do closure.
- `a1899d2` **commit 0.5** — máquina HEADLESS morta removida INTEIRA:
  **−1108 linhas em 11 arquivos** (main −439; preload: API tasks.run*,
  onRunEvent/onRunLive/onFeedback, TaskRunSnapshot; renderer: RunPanel.tsx
  DELETADO, taskRuns do store, espelhos `run:<taskId>` em Board/PanesView/
  panesNodes/ConstellationMap/Universe, devMock). O canal `tasks:feedback`
  morreu junto (único emissor era o runSink morto). Vivos preservados: badge
  de fase via taskPhaseView, setPhaseSeat, celebrações por
  hub:event/paneActivity.
- `d0b48ea` **commit 1** — `src/main/mainContext.ts`: interface MainContext
  (19 stores/serviços, 8 reatribuíveis, 31 Maps/Sets, 16 funções de closure,
  `ctx.push`) + PhaseApi com as 8 assinaturas da máquina de fases
  (**advancePhase SYNC POR CONTRATO gravado no tipo** — `boolean`, nunca
  Promise). O objeto `ctx` nasce no index logo após o `hub = new Hub({...})`;
  regra de construção: referência direta SÓ para o que já existe no ponto;
  getter para reatribuível e para const declarada DEPOIS (referência direta
  daria TDZ); delegação arrow para toda função e para ctx.phase. `void ctx` —
  consumidor nenhum ainda, de propósito.
- `89912db` / `0c0e6bb` — registros de ESTADO no plano.

index.ts: 19.448 (pré-obra) → **18.997 linhas** hoje (o commit 1 devolveu
~165 linhas de construção do ctx — esperado; elas saem de novo quando os
módulos consumirem o contexto).

ÂNCORAS DO MAPA DESLOCARAM: o FASE1_MAPA_MAINCONTEXT.md foi escrito com o
arquivo de 19.448 linhas. Regra desta obra: NUNCA confiar em número de linha
do mapa — re-localizar por grep antes de cada corte (foi assim nos 3 commits).

## Pendências que NÃO são código

1. **BOOT DE VALIDAÇÃO DO DONO** (critério de pronto do plano, ainda não
   feito): um `npm run dev` do dono com os commits 0/0.5/1 — checar boot
   limpo, board abrindo, e que nada do espelho morto faça falta visual.
2. **PUSH**: os 5 commits são locais; o dono decide quando subir.
3. **MÃO ALHEIA NO WORKING TREE — SESSÃO PARALELA ATIVA**: durante esta
   sessão, uma OUTRA sessão do dono trabalhou (e ainda trabalhava no
   fechamento) na família SKILLS: bundledSkillRevision, skillsLibrary,
   skillsBundled, skillsCatalog, skillsRouting, workspaceSkills,
   test-skills-routing, + novos skillRuntime.ts/test-skill-runtime.mjs
   (`bundledPackageSha` multi-arquivo — família do CHECK 11). NÃO TOCAR,
   não commitar, não reverter NADA da família skills; todo commit desta
   obra usa `git add` POR CAMINHO EXPLÍCITO exatamente por isso. Atenção
   cruzada: o mainContext importa `type WorkspaceSkillLeaseRegistry` de
   './workspaceSkills' e `type SkillsLibrary` de './skillsLibrary' — se a
   outra obra renomear algo aí, o typecheck desta branch acusa; é dela a
   frente, sincronizar com o dono antes de "consertar".
4. Cosmética anotada (pagar nos commits da região, nunca à parte):
   comentários PT-BR duplicados entre index e phasePrompts; CSS órfão do
   espelho headless em global.css (.run-modal/.perm-picker/… — separar do
   vivo exige varredura própria; .m-line e .run-done TÊM uso vivo).

## PRÓXIMO PASSO: commit 3 — phaseEngine.ts (ANTES do mcpApi)

Receita no FASE1_MAPA_MAINCONTEXT.md (seções "Acoplamento (a)" e "Ordem
recomendada"). Resumo operacional:

- Mover para `src/main/phaseEngine.ts`, recebendo `MainContext`:
  preparePhasePane/preparePhasePaneInner, advancePhase/advancePhaseInner,
  retryOrBacklog, finalizeTask, openGatePane, openPhasePane, closePhasePane,
  terminateTaskPhasePane, o poller, e o estado de fase (phaseWatches,
  liveGateWaits, gateDeathLog, gateCooldownUntil, livePaneSpecs,
  closingPaneIds, paneEverSpawned, phaseLaunches, phaseLaunchCapacity,
  phaseMarkersProcessing, bootRespawnsPending) — ao migrar o estado, o ctx
  passa a expô-lo A PARTIR do engine (inverter a seta: o index deixa de
  declará-lo).
- **RISCOS JÁ MAPEADOS** (não redescobrir):
  1. advancePhase é SYNC POR CONTRATO (barreira síncrona do veredito) — o
     PhaseApi já trava isso no tipo; qualquer conversão a async é regressão.
  2. `MAX_PARALLEL_RUNS` é declarado DEPOIS do poller no index (funciona por
     hoisting de function declaration) — ao virar módulo com import, vira
     TDZ: declarar a const ANTES no módulo novo.
  3. O poller de 3s mistura fases + missionWatches — cortar em
     tickPhaseWatches (vai pro engine) e tickMissionWatches (fica no index
     até a extração de missões).
  4. gateDeathLog é escrito no onExit do PTY (fora do engine) — expor
     `phaseEngine.recordGateDeath(taskId)`, nunca o Map cru.
  5. Chamadores EXTERNOS que precisam continuar funcionando (re-localizar
     por grep): removeTaskCascade, tasks:setPhaseSeat, projects:relocate,
     stopMissionExecution, onExit do PTY, e no mcpApi:
     codeReportGuard/runTask/report/archiveMission (estes podem passar a
     chamar via `ctx.phase` — o sub-objeto existe exatamente para isso).
- preparePhasePaneInner tem ~950 linhas — se o commit ficar grande demais
  para revisar, é legítimo cortar em dois (engine + estado primeiro,
  preparePhasePane por último), cada um verde.
- Alternativa sancionada pelo mapa: commit 4 primeiro (mcpApi/ por domínio
  usando ctx.phase; `report` em commit próprio — é o bloco mais entrelaçado
  do arquivo). As duas ordens funcionam por causa do ctx.phase.

## Regras vivas da obra (não relaxar)

- TODA edição de src SÓ com app parado — checar processo imediatamente antes
  (a prova expira).
- Cada commit reversível e verde: typecheck + as 5 suítes; regressão = parar
  e voltar.
- Nunca "aproveitar e refatorar" fora do mapa.
- Suítes: `npm run test:orchestrator-flow` (35) · `test:mission-verification`
  (25) · `test:integration-queue` (14) · `test:pane-permissions` (11) ·
  `test:stall-attribution` (8). Formato do reporter: linhas `ℹ pass/fail`.
- Agentes Opus: o dono liberou NESTA sessão para esta obra (varredura e corte
  do renderer foram deles, com revisão linha a linha minha) — confirmar se a
  liberação segue valendo ao abrir a próxima.
- Mensagens de commit: `fase1: ...`, sem acentos, PT-BR.
