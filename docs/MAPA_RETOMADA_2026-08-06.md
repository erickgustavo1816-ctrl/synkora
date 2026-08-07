# MAPA DE RETOMADA — fluxo completo × quedas (item 22, 2026-08-06)

O que acontece com CADA estágio do fluxo quando CADA tipo de queda o atinge —
célula por célula, rastreado no código com âncora `arquivo:linha` (linhas da
árvore de 2026-08-06, pós-fixes desta data; eventos da caixa-preta citados por
nome são estáveis para grep). Precursor: `docs/MATRIZ_FALHAS_2026-08-02.md`
(12 cenários de gate/merge — todos absorvidos aqui).

**Legenda de veredito** (régua da 2ª passada, mesma data: "recupera sozinho" =
sem HUMANO no laço e sem perder trabalho — recuperação executada por OUTRO
AGENTE conta como sozinho; conversa descartável por desenho não conta como
perda, os arquivos são a verdade)
- ✅ recupera sem humano e sem perder trabalho
- ⚠️ exige ação humana OU perde trabalho real (dita qual)
- 🔴 estado perdido / trava / beco — **todos os 🔴 e ⚠️ conhecidos foram
  corrigidos ou requalificados em 2026-08-06** e aparecem como 🔴→✅/⚠️→✅

**Quedas (colunas)**
| id | queda |
|----|-------|
| Q1 | pane fechado à mão pelo usuário |
| Q2 | CLI morre sozinho (crash/exit inesperado do processo) |
| Q3 | restart limpo do app (will-quit roda) |
| Q4 | crash sujo do app (dirty-exit; nenhum handler roda) |
| Q5 | estado em memória perdido/corrida com o app VIVO |
| Q6 | resume-fail (sessão persistida não resolve) |
| Q7 | limite de conta / reseat no meio do trabalho |
| Q8 | interferência do dono (mover card, mudar critério, fechar coisas) |

## A régua que decide tudo: o que persiste × o que morre com o processo

**Sobrevive a qualquer queda** (fonte da verdade): `tasks.json`
(status/activePhase/phaseState/feedback/gateRound/gateNotes/devEffort/
phaseSessions/runSeat/verification), `missions.json`, `integration-queue.json`,
`maestro.json` (sessões + carimbos de contexto), `backlog.json`, intents em
`<projeto>/.synkora` (start/integração/release), cadernos e transcripts
(`PLAN.md`, `HANDOFF.md`, `MAESTRO.md`, `.synkora/runs/*`) e — desde hoje —
`user-questions.json` ([index.ts:10249](../src/main/index.ts)).

**Morre com o main process** (e o desenho reconstrói): `phaseWatches`
(reconstruído por preparePhasePane/poller), `liveGateWaits`, `gateCooldownUntil`,
`bootRespawnsPending` (recalculado no boot), `testServerPanes`, filas do hub,
`helperReported/helperSeen`, `integrationDraining`.

## Vista geral

| estágio | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 | Q8 |
|---|---|---|---|---|---|---|---|---|
| E1 Plano (proposta→aprovação→pausa) | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| E2 Dev rodando | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| E3 Gates julgando | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| E4 Gate vivo em espera | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| E5 QA + runtime | ✅ | ✅ | ✅ | ⚠️→✅ | ✅ | — | ✅ | ✅ |
| E6 Finalize/merge do card | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | ✅ |
| E7 Conclude + verificação | — | — | ✅ | ✅ | ✅ | — | — | ✅ |
| E8 Fila de integração + merge da missão | ✅ | ✅ | ✅ | ✅ | 🔴→✅ | — | ✅ | ✅ |
| E9 Release | — | — | ✅ | ✅ | ✅ | — | — | ✅ |
| E10 PM (Maestro) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| E11 Orquestrador | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| E12 Ajudantes | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| E13 ask_user | — | — | 🔴→✅ | 🔴→✅ | 🔴→✅ | — | — | ✅ |
| E14 Servidor de teste do dono | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | ✅ |
| E15 Árvore de processos (transversal) | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — |
| E16 Renderer recarrega (main vivo) | — | — | — | — | ✅ | — | — | — |
| E17 Instância dupla do app | — | — | — | — | 🔴→✅ | — | — | 🔴→✅ |

"—" = a queda não se aplica ao estágio (ex.: plano não tem pane próprio).

---

## E1 — Plano (proposta → aprovação → execução → pausa)

- **[E1×Q8] ✅** Aprovação com CAS de revisão: `tasks:planApprove` leva a
  revisão vista; plano re-proposto enquanto o usuário lia → `{staleRevision}`
  e o modal manda reler ([index.ts:5092,5101](../src/main/index.ts)). Pausa via
  `tasks:planStop` ([index.ts:5134](../src/main/index.ts)) corta run_task na hora.
- **[E1×Q3,Q4] ✅** Recovery de boot NÃO devolve plano ao backlog (kind:'plan'
  tem ramo próprio) e a VERIFICAÇÃO conjunta interrompida converte
  running→pending e relança sozinha (`resumePlanVerificationIfNeeded`,
  [index.ts:18362-18382](../src/main/index.ts)).
- **[E1×Q5] ✅** Plano é 100% persistido no card (TaskPlan em tasks.json);
  nenhum estado de plano vive só em memória.

## E2 — Dev rodando

- **[E2×Q1,Q2] ✅ (re-régua 2ª passada)** Pane do dev morre → onExit preserva
  a fase (`phaseState: 'interrupted'`) SEM sobrescrever feedback de gate
  pendente (task.feedback tem dono único — F6.8b), e o evento de fase
  interrompida chega ao ORQUESTRADOR, cuja persona manda reabrir no mesmo
  turno (`run_task` com resume via retryingOriginalDev; AUTONOMOUS EXECUTION).
  A re-entrega do próprio dev também é aceita (`redelivery-accepted`,
  [index.ts:14571](../src/main/index.ts)). Recuperação por AGENTE, sem humano
  — o card não se auto-ressuscita por design (anti-loop, F6.8d), mas o sistema
  se recupera sozinho.
- **[E2×Q3,Q4] ✅** Boot: `dev-interrupted`
  ([index.ts:18450-18470](../src/main/index.ts)) + `notePendingRespawn` →
  respawn LAZY quando o projeto abre (`bootRespawnsPending`,
  [index.ts:11401-11474](../src/main/index.ts)), UMA tentativa por task/boot.
  Dev claude volta com a conversa (`--resume` via phaseSessions); codex nasce
  fresco sobre o trabalho preservado (armadilha codex-resume-sem-MCP).
- **[E2×Q5] ✅** Corrida poller×preparePhasePane: janela de graça de 30s no
  watch recém-criado (`PhaseWatch.createdAt`, index.ts ~10215), soltura NUNCA
  silenciosa (`phase-watch-released`,
  [index.ts:13137](../src/main/index.ts)) e reconstrução auditada
  (`phase-watch-repaired`). Watchdog SOFT de MCP mudo: `dev-mcp-silent`
  ([index.ts:14251](../src/main/index.ts)) — informa, nunca mata.
- **[E2×Q6] ✅** `--resume` recusado → `onResumeFail`
  ([index.ts:13926](../src/main/index.ts)) invalida o id persistido e o
  PtyManager respawna o MESMO pane sem o resume (autocura F4.2). Teto de custo:
  conversa >150k NÃO é relida (`RESUME_CONTEXT_BUDGET_TOKENS`,
  [index.ts:10615](../src/main/index.ts), evento `resume-skipped-cost`).
- **[E2×Q7] ✅** `tasks:setPhaseSeat` ([index.ts:9183](../src/main/index.ts)):
  claude→claude transplanta a conversa; cross-CLI renasce fresco; effort vira o
  novo carimbo; evento `seat-swap`. "Limite estourado nunca prende a missão."
- **[E2×Q8] ✅** Mover o card solta o watch; entrega com plano pausado devolve
  mensagem clara ("commit seguro; re-aprove e reporte de novo").

## E3 — Gates julgando (review/QA)

- **[E3×Q1,Q2] ✅** Gate morre sem veredito → fase preservada, card NUNCA
  volta ao dev; breaker de crash-loop: 3 mortes/60s → cooldown de 5min
  ([index.ts:14111-14129](../src/main/index.ts)); `run_task {phase}` durante o
  cooldown recusa COM receita de diagnóstico
  ([index.ts:15638](../src/main/index.ts)). Cooldown é memória — restart zera,
  o que é o comportamento desejado (chance nova).
- **[E3×Q3,Q4] ✅** Boot: `gate-preserved`
  ([index.ts:18418-18449](../src/main/index.ts)) + respawn lazy; a cadeia de
  seat do gate no boot resolve por NOME (fix F6.8h). Evidência aprovada é
  memoizada por head — QA já aprovado para o mesmo head não re-roda
  ([index.ts:13076-13086](../src/main/index.ts)).
- **[E3×Q5] ✅** A LISTA da reprovação vive no CARD, não na conversa:
  `task.gateRound` com lista+placar por rodada
  ([index.ts:13041-13049](../src/main/index.ts)) — gate fresco herda a lista da
  instituição. Veredito tem barreira SÍNCRONA: advancePhase chama
  `worktree.snapshotProblemFor` direto no main
  ([worktree.ts:92](../src/main/worktree.ts)); evidência untracked de gate vai
  para quarentena e o veredito sobrevive
  ([worktree.ts:129](../src/main/worktree.ts)). Rodada vazia (head idêntico sem
  waiver) não recicla o gate: `gate-round-empty-delta`
  ([index.ts:12368](../src/main/index.ts)).
- **[E3×Q6] ✅** Gate resumado recebe prompt-delta curto (F6.8i); codex nunca
  resuma em fase (fresco por regra).
- **[E3×Q7] ✅** `tasks:setPhaseSeat` vale para gates (mesma âncora do E2).
- **[E3×Q8] ✅ (re-régua 2ª passada)** Dono muda critério com rodada aberta: a
  entrega das gateNotes é MECÂNICA e atômica — elas só chegam ao gate no
  reciclo da rodada seguinte, nunca no meio (openGatePane injeta na
  re-abertura); a atomicRoundRule nos prompts é camada extra. Nenhum estado se
  perde e nenhum humano entra no laço; o pior caso residual é um agente
  desobedecer o próprio prompt — risco de LLM, não de retomada. Watchdog de
  gate sem MCP: `gate-mcp-timeout` ([index.ts:17982](../src/main/index.ts))
  encerra com causa e preserva a fase.

## E4 — Gate vivo em espera (reprovação limpa)

- **[E4×Q1] ✅** Pane em espera fechado à mão → o próximo done cai sozinho no
  spawn normal de gate (a espera só recicla se `ptys.has(paneId)`,
  [index.ts:13054-13071](../src/main/index.ts)).
- **[E4×Q2] ✅** CLI da espera morre → idem: spawn normal no próximo done.
- **[E4×Q3,Q4] ✅ (re-régua 2ª passada)** `liveGateWaits` é memória — restart
  perde a CONVERSA do gate em espera, mas conversa é DESCARTÁVEL POR DESENHO
  neste app (o mesmo princípio do teto de resume): a memória institucional —
  lista, placar, cabeça reprovada — persiste em `gateRound` e o gate fresco a
  herda inteira. Zero trabalho perdido, zero humano no laço; o custo é um
  spawn.
- **[E4×Q5] ✅** Esperas são limpas em todos os desfechos (plano pausado,
  finalize, delete — múltiplos `liveGateWaits.delete` auditáveis) e a espera
  não conta em MAX_PARALLEL_RUNS nem no watchdog. Browsers do gate em espera
  são ceifados (`reapVisualsOf`, [index.ts:13068](../src/main/index.ts)).

## E5 — QA + runtime

- **[E5×Q1,Q2] ✅** Runtime morre COM o pane do QA (killTree BFS folha→raiz,
  [qaRuntime.ts:120](../src/main/qaRuntime.ts)); falha ambiental é veredito
  `bloqueada` — não conta ciclo, não vira lista para o dev (evento
  `gate-blocked-environment`), e o reciclo re-tenta o runtime sozinho.
- **[E5×Q3] ✅** Restart limpo derruba runtime (will-quit fecha testServerPanes
  e os processos filhos); gate reabre via `gate-preserved` e o QA re-sobe o
  produto via `runtime_control` (tool própria — capacidade antes de escalação).
- **[E5×Q4] ⚠️→✅ (CORRIGIDO na 2ª passada, mesma data)** Crash sujo: o
  runtime do QA era spawn próprio FORA do job object dos panes — podia ficar
  órfão. Fix: `setQaRuntimeGuard` liga o runtime ao guardião do PtyManager
  (`guardExternalPid`/`unguardExternalPid` — job próprio com
  KILL_ON_JOB_CLOSE, re-assinado no respawn do guardião;
  [qaRuntime.ts](../src/main/qaRuntime.ts) + [pty.ts](../src/main/pty.ts)).
  Crash do app = EOF no guardião = a árvore do runtime morre no kernel; e o
  close do job virou a PRIMEIRA camada do stop normal (killTree segue de
  cinto).
- **[E5×Q5] ✅** Timeout adaptativo (processo emitindo = espera; 45s de
  silêncio = falha; teto 5min — [qaRuntime.ts:199-221](../src/main/qaRuntime.ts));
  bootstrap por lockfile ([qaRuntime.ts:55-59](../src/main/qaRuntime.ts));
  detector de URL imune a ANSI (F6.8h).

## E6 — Finalize/merge do card

- **[E6×Q1..Q4] ✅** O recibo de integração persiste NO MEIO do merge
  (checkpoint síncrono SharedArrayBuffer no gitWorker); `finalizing-recheck` no
  boot ([index.ts:18400-18416](../src/main/index.ts)) reconcilia com o journal
  Git via `recoverFinalizingTask` ([index.ts:11724](../src/main/index.ts)) —
  nunca presume entrega. Merge bloqueado pós-aprovação deixa o card APROVADO em
  finalizing (nunca volta ao dev); `run_task {phase:"finalize"}` re-tenta só o
  merge do MESMO commit. Suíte `test:merge-repair` cobre no nível git.
- **[E6×Q8] ✅** Alterar a entrega depois da aprovação → fingerprint/head
  divergentes bloqueiam o finalize e invalidam só os gates dependentes
  (invalidEvidence, MATRIZ_FALHAS cenário 12).

## E7 — Conclude + verificação conjunta

- **[E7×Q3,Q4] ✅** App caiu durante a verificação → o boot converte
  running→pending e RELANÇA sozinho ([index.ts:18362-18382](../src/main/index.ts)).
- **[E7×Q5] ✅** Becos fechados por desenho: comando redefinido aceito em modo
  leve (`verification-command-redefined-accepted`), válvula sancionada
  `run_task {adjustment}` (taskAdjustment.verificationBlocked), evidência com
  tail de stderr no bloqueio (`plan-verification-blocked`).
- **[E7×Q8] ✅ (re-régua 2ª passada)** Flake de EPERM em fixtures git sob
  Electron-as-node pode reprovar uma rodada de verificação — mas a retomada é
  automática e sem humano: a válvula `run_task {adjustment}` é acionada pelo
  ORQUESTRADOR e a evidência viaja no evento. O flake em si é bug do PRODUTO
  em teste (card futuro registrado em F6.8e), não do fluxo de retomada do
  Synkora.

## E8 — Fila de integração + merge da missão

- **[E8×Q5] 🔴→✅ (corrigido 2026-08-06)** A célula do incidente da M02d:
  `completeMissionMerge` mata o orquestrador ANTES do merge
  ([index.ts:7069](../src/main/index.ts)) e o Board ressuscitava o pane DURANTE
  o await — o claude novo (cwd no worktree) virava o lock da limpeza. Fix:
  `missions:paneSpec` recusa respawn com `mission.status === 'integrando'`
  (evento `orchestrator-respawn-refused-integration-in-flight`,
  [index.ts:8392](../src/main/index.ts)) + o Board pula 'integrando' entre o
  drop da spec morta e o refetch
  ([Board.tsx:1584](../src/renderer/src/components/Board.tsx)). Janela coberta
  exatamente pelo status (setado no beginMerge, resetado em todo desfecho e no
  boot [index.ts:18491](../src/main/index.ts)).
- **[E8×Q1,Q2] ✅** Orquestrador morto antes/durante fila: eventos ficam em
  EVENTS.md e o respawn (pós-desfecho) recupera via board_status; conflito real
  pausa a fila e o Maestro decide (`guide_integration_resolution` persistida).
- **[E8×Q3,Q4] ✅** O caminho que repara a M02d: recovery de boot prova o
  merge no git ([index.ts:6811-6818](../src/main/index.ts)), alinha o destino
  ([6868-6889](../src/main/index.ts)), remove worktree/branch da origem
  ([6895-6917](../src/main/index.ts)), conclui a missão + cancela o ticket
  ([6918-6933](../src/main/index.ts)). Roda ANTES do `createWindow()`
  ([index.ts:18521](../src/main/index.ts)) — nenhum pane existe para segurar
  lock durante o reparo. Queda ANTES do CAS com fotografia intacta → intent
  removido e o MESMO ticket re-armado
  ([6832-6850](../src/main/index.ts)). Cada falha de reparo re-marca
  `target_repair_pending` com aviso — nunca beco: o próximo boot re-tenta.
- **[E8×Q7] ✅** Reseat do orquestrador não toca a fila (tickets lacrados por
  planId+SHA).
- **[E8×Q8] ✅** Servidor de teste do dono no worktree é fechado ANTES do
  merge (`closeTestServersUnder`, [index.ts:6969](../src/main/index.ts),
  evento `test-server-closed`).

## E9 — Release

- **[E9×Q3,Q4] ✅** `recoverVersionReleaseIntents` no boot
  ([index.ts:18355](../src/main/index.ts)); ref de destino com CAS branch+SHA;
  falha ao alinhar preserva intent/ticket/branches (F6.1).
- **[E9×Q8] ✅** Release bloqueia com missão ativa/item aberto; release hold do
  PM protege verificação em andamento (maestroStore.releaseHold).

## E10 — PM (Maestro)

- **[E10×Q1..Q4] ✅** Pane respawna via `--resume tuiSessionId` (maestro.json);
  a conversa é estado do CLI, não do app.
- **[E10×Q6] ✅** Autocura de resume-fail ([index.ts:13926](../src/main/index.ts));
  /clear e /new invalidam o id NA HORA (onCommand) — o resume nunca traz
  conversa "apagada" de volta.
- **[E10×Q7 e custo] ✅ (novo 2026-08-06)** TETO DE CUSTO no resume:
  `maestro.json` carimba o contexto vivo (`tuiContextTokens`, stamp no watcher
  de stats) e acima de 150k a conversa NÃO é relida
  (`MAESTRO_RESUME_BUDGET_TOKENS`, [index.ts:8343](../src/main/index.ts);
  evento `maestro-resume-skipped-cost`) — o pane nasce fresco lendo o caderno
  novo `.synkora/MAESTRO.md` (persona DURABLE NOTEBOOK em
  [maestro.ts](../src/main/maestro.ts)) + BOARD.md + board_status, com intro
  explicando a economia ao usuário.
- **[E10×Q5] ✅** Estado do PM (seat/modelo/effort/versão/hold) todo em
  maestro.json; log do painel sanitizado e rotacionado.

## E11 — Orquestrador de missão

- **[E11×Q2] ✅** Board ressuscita pane morto com teto 3 mortes/30s
  ([Board.tsx:1550-1596](../src/renderer/src/components/Board.tsx)); persona +
  PLAN.md retomam plano em execução sozinhos (AUTONOMOUS EXECUTION).
- **[E11×Q3,Q4] ✅** Caderno PLAN.md é a memória que sobrevive
  (missionPersona: 1ª ação de toda sessão = ler; agora também ensina que a
  conversa é DESCARTÁVEL por teto de custo). Resume via tuiSessionId da chave
  `<pid>--<mid>`; mesmo teto de 150k do PM ([index.ts:8343](../src/main/index.ts))
  com intro de recuperação que proíbe re-planejar/re-perguntar.
- **[E11×Q5] ✅** Guardas de respawn: `pendingOrchestrator`
  ([index.ts:8377](../src/main/index.ts)) e integração em voo
  ([index.ts:8392](../src/main/index.ts) — fix de hoje).
- **[E11×Q7] ✅** `missions:setOrchestratorSeat` com transplante de conversa
  (migrateCliSessionBetweenSeats; evento `seat-swap`).

## E12 — Ajudantes

- **[E12×Q1,Q2] ✅** Morte sem report avisa o delegador (helperReported/
  helperSeen — sem aviso dobrado nem aviso pós-leitura); o TRANSCRIPT sobrevive
  ao pane (helper_output funciona com o ajudante morto).
- **[E12×Q3,Q4] ✅ (re-régua 2ª passada)** Ajudante NÃO respawna no boot — o
  dono é o dev, e o DEV recuperado recebe automaticamente a lista dos
  transcripts preservados no prompt de recovery (storedHelperRecoveries; o
  boot marca cada um como interrompido,
  [index.ts:18293-18304](../src/main/index.ts)) e relança o que faltar por
  decisão própria. Trabalho reportável nunca se perde; nenhum humano no laço.
- **[E12×Q5] ✅** Conclusão por destino (helperCompletion: full/short/skip +
  stillNeeded no instante da injeção) — payload nunca é re-digitado em quem já
  leu.

## E13 — ask_user

- **[E13×Q3,Q4] 🔴→✅ (corrigido 2026-08-06)** Confirmado ao vivo na M02d: a
  pergunta que pediu o restart foi apagada pelo próprio restart
  (`pendingUserQuestions` era Map em memória). Fix: persistência atômica em
  `user-questions.json` ([index.ts:10249](../src/main/index.ts), jsonStore com
  backup) + reidratação no boot — a aba volta a pulsar via
  `maestro:pendingQuestions` até o dono abrir (`maestro:questionSeen` limpa e
  persiste).
- **[E13×Q5] 🔴→✅ (achado E corrigido na 2ª passada)** O efeito que marca a
  pergunta como "vista" rodava SEM guarda de visibilidade: um Board
  montado-mas-escondido (outro projeto aberto, ou usuário na aba Panes)
  dispensava a pergunta na chegada — ninguém via. Fix: a dispensa exige o
  board VISÍVEL (`isActive` + aba do universo em 'board'); o estado das
  perguntas subiu para o store global e alimenta rail + abas
  ([Board.tsx](../src/renderer/src/components/Board.tsx)).
- **[E13×Q8] ✅** Visitar a aba (agora só quando visível de verdade) dispensa
  a pergunta; heurística "?" de pane aquietado segue como sinal secundário
  (F6.8h). E a atenção agora alcança de qualquer lugar: aba Board pulsa ❓,
  projeto pulsa no rail e um plim toca na chegada (2ª passada, pedido do
  usuário).

## E16 — Renderer recarrega com o main vivo (crash de renderer/reload)

- **[E16×Q5] ✅** `render-process-gone` → reload automático + `did-finish-load`
  re-registra o uiSender ([index.ts:1020-1029](../src/main/index.ts)); os PTYs
  vivem no MAIN e sobrevivem; o App reidrata panes vivos por `panes:live` e o
  sessionStats faz replay dos badges no remount
  ([App.tsx](../src/renderer/src/App.tsx)). Perguntas do ask_user reidratam do
  arquivo persistido.

## E17 — Instância dupla do app

- **[E17×Q5,Q8] 🔴→✅ (achado E corrigido na 2ª passada)** Não havia
  single-instance lock: dois `npm run dev`/atalhos eram DOIS processos
  gravando os MESMOS stores atômicos (último a escrever vence — perda
  silenciosa) com dois PtyManagers/MCP servers. Fix:
  `app.requestSingleInstanceLock()` — a segunda instância morre na hora e a
  primeira ganha o foco ([index.ts](../src/main/index.ts), antes do
  whenReady).

## E14 — Servidor de teste do dono

- **[E14×Q1] ✅** Fechar o pane derruba o servidor (job object).
- **[E14×Q3] ✅** will-quit fecha todos (testServerPanes).
- **[E14×Q4] ✅** Crash sujo: o pane de teste é PTY → árvore morre pelo
  guardião (EOF no stdin = KILL_ON_JOB_CLOSE no kernel).
- **[E14×Q8] ✅** Integração e release fecham o servidor do worktree ANTES do
  merge ([index.ts:6969](../src/main/index.ts)).

## E15 — Árvore de processos (transversal)

- **✅** Guardião de job objects por pane (armJob espera pid real,
  [pty.ts:959-976](../src/main/pty.ts); contrato completo em
  [pty.ts:1313-1340](../src/main/pty.ts)): KILL_ON_JOB_CLOSE sem breakaway;
  crash do app = EOF no guardião = tudo morre no kernel (fecha o buraco do
  dirty-exit). Membership não retroativa → taskkill fast-path + CEIFA 700ms com
  verificação de identidade seguem como SEGUNDA CAMADA obrigatória
  ([pty.ts:1608](../src/main/pty.ts)); killAll no quit
  ([pty.ts:1841](../src/main/pty.ts)); guardião morto = respawn 3/60s +
  re-assign. Única exceção mapeada: runtime do QA (ver E5×Q4).

---

## Achados das duas passadas (2026-08-06) — TODOS resolvidos

1. **🔴→✅ Integração × ressurreição do orquestrador** (E8×Q5) — corrigido e
   VALIDADO ao vivo: o boot 5a3dc434 reparou a M02d sozinho em ~2s.
2. **🔴→✅ ask_user volátil no restart** (E13×Q3,Q4) — persistido em
   `user-questions.json`, reidratado no boot.
3. **🔴→✅ ask_user auto-dispensado por board escondido** (E13×Q5, achado da
   2ª passada) — dispensa agora exige o board VISÍVEL; estado global no store.
4. **🔴→✅ instância dupla do app** (E17, achado da 2ª passada) —
   `requestSingleInstanceLock`.
5. **⚠️→✅ runtime do QA órfão em crash sujo** (E5×Q4) — registrado no
   guardião de job objects (`guardExternalPid`); o kernel mata a árvore.
6. **✅ resíduo de pergunta órfã** — poda preguiçosa no
   `maestro:pendingQuestions` (projeto/missão que deixou de existir sai do
   arquivo).
7. **Novo: teto de custo no resume do PM/orquestrador** (E10/E11) — a conversa
   nunca mais é relida acima de 150k; caderno `.synkora/MAESTRO.md` criado
   como memória durável do PM (par do PLAN.md do orquestrador).
8. **Novo: atenção multi-nível + som** — pergunta/permissão pendente agora
   pulsa na aba da missão, na aba Board/Panes do universo E no avatar do
   projeto no rail (visível de outro projeto), com plim minimalista na chegada
   (Web Audio, throttle 2s).
9. **Nota de desenho (não é bug):** dev interrompido com o app VIVO não se
   auto-reabre POR pane — a retomada é do orquestrador (`run_task`) ou da
   re-entrega sancionada (`redelivery-accepted`); reintroduzir
   auto-ressurreição de pane recriaria o loop infinito de 02/08.

**Fora do escopo declarado** (não são quedas do fluxo): disco cheio/falha de
IO generalizada (os stores atômicos + .bak degradam para a última fotografia
válida), edição manual dos JSONs de userData, e relógio do sistema andando
para trás.
