# HANDOFF — Fase 1 da cirurgia do índice (pós-commits 0/0.5/1)

Escrito 2026-08-07, fim da sessão dos commits 0/0.5/1. A PRÓXIMA SESSÃO lê
este arquivo PRIMEIRO, depois docs/FASE1_MAPA_MAINCONTEXT.md (a receita) e o
bloco ESTADO da Fase 1 em docs/PLANO_NIVEL_5.md.

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
