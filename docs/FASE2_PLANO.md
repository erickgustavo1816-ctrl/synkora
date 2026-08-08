# PLANO FORMAL — FASE 2: veredito sem barreira síncrona (CHECK 1 núcleo)

Escrito 2026-08-08, branch `nivel5-fase1` (HEAD `2ac4ad6`). **Nenhuma linha de
código foi alterada — este plano aguarda a aprovação do dono antes de qualquer
corte** (régua da Fase 1, em dobro: cirurgia de COMPORTAMENTO, não de
movimentação).

Insumos, ambos revisados por amostragem contra o código antes da aceitação:

- `docs/FASE2_MAPA_VEREDITO.md` — caminhada completa do `advancePhaseInner`
  (git/fs síncronos, mutações em ordem, 5 desfechos do gate, transação do
  report, 13 riscos R1–R13).
- `docs/FASE2_MAPA_CONCORRENTES.md` — 66 sites de `phaseWatches` em 12
  módulos, mecânica anti-corrida atual do poller, boot/recovery, 11 classes de
  interleaving (§7), tabela de decisão de 22 entrantes (§7.12).

---

## 1. Objetivo e critério de pronto

**Objetivo em uma frase**: o veredito de fase deixa de segurar o main thread
(stalls medidos de 1,2–2,1s em TODA transição done→gate, 4/4 em 2026-08-06,
crescendo com a carga) — o git viaja ao worker e a atomicidade passa a ser
garantida por **serialização por card**, não por sincronicidade.

**Critério de pronto (mensurável)**:

1. Cada commit verde: typecheck node+web + as 5 suítes de hoje
   (orchestrator-flow 39 · mission-verification 25 · integration-queue 14 ·
   pane-permissions 14 · stall-attribution 8) + as 2 suítes novas
   (`test:phase-transition-lock`, `test:phase-verdict-races`) a partir do
   commit que as cria.
2. A matriz de corrida completa (§6.3, 13 casos) verde — inclusive com o
   `gitAsync` forçado ao fallback síncrono (R9).
3. Validação ao vivo do dono: uma missão com gates atravessando
   dev→review→QA; no journal, `advancePhase:*` **desaparece do ranking de
   culpados** dos stalls (a Fase 0 prova o antes/depois com
   `node scripts/bbwatch.mjs --grep stall`); zero anomalia
   `phase-advance-without-lock`; contenções de lock raras e explicadas.
4. A régua de crash-safety do mapa (§4.5) preservada: **queda no meio de um
   veredito custa no máximo uma rodada repetida, nunca corrupção** — e o lock
   NÃO introduz estado novo em disco (nenhum caso novo de reconciliação de
   boot).

---

## 2. A verdade de hoje (o que a cirurgia renegocia)

- `advancePhase` é SYNC POR CONTRATO em 4 lugares (tipo no `PhaseApi`,
  cabeçalho do phaseEngine, comentário-âncora :3424, cabeçalho do report.ts) —
  a cicatriz do "[object Promise]" de 2026-08-05.
- O que a barreira protege NÃO é "git no main": é a janela
  **re-confirmar → gravar**. O `codeReportGuard` (async, caro) já tira a
  fotografia e re-checa; o `advancePhaseInner` re-confirma os mesmos 4 fatos
  git e grava. A conversão é segura na medida em que NENHUMA outra transição
  do mesmo card entre nessa janela.
- Call sites reais de `advancePhase`: **3** — report.ts:439 (artefato
  inválido, SEM rollback/try-catch — buraco pré-existente), report.ts:748
  (transação principal: detach → unlink → advance → rollback no throw) e o
  poller de marcadores (:4061, retorno ignorado).
- A idempotência atual ("quem chega primeiro deleta o watch") é: detach
  síncrono + re-check de identidade POR REFERÊNCIA no poller +
  `phaseMarkersProcessing`. O achado estrutural do mapa: o primeiro ato da
  transação é o detach, então **durante a janela o card parece OCIOSO para o
  app inteiro** (~20 guards leem `phaseWatches.has()`). Hoje inofensivo
  (janela de zero ticks); com awaits, mentira de segundos.
- Infra já pronta (verificado): o registry do gitWorker é spread de TODO o
  worktree.ts (zero entradas novas para as 8 funções git do veredito);
  `mainStalls.wrap` já fecha Promise no settle; `McpApi.report` já aceita
  `Promise<string>` e o handler MCP já faz `await`; o proxy de instrumentação
  já trata Promise. `gitAsync` tem fallback síncrono se o worker não subir —
  comportamento nunca pior que hoje (R9, declarado).

---

## 3. O desenho: `PhaseTransitionLock` (lock de transição por card)

### 3.1 A primitiva

Módulo novo **`src/main/phaseTransitionLock.ts`** (puro, sem electron, ~100
linhas, irmão do `phaseLaunchGuard.ts` — o molde do `reserve` síncrono com
token Symbol), com suíte própria `scripts/test-phase-transition-lock.mjs`:

```
acquire(taskId, { label, projectId }): PhaseTransitionToken | undefined
    // try-lock SÍNCRONO (a reserva entra ANTES do primeiro await — a lição
    // gravada no phaseLaunchGuard). Token = Symbol, prova de dono.
waitAndAcquire(taskId, { label, projectId }): Promise<PhaseTransitionToken>
    // fila FIFO para quem deve ESPERAR (ordem do dono), nunca sumir.
owns(taskId, token) · release(taskId, token)   // release só do dono, idempotente
isLocked(taskId) · holderLabel(taskId)         // o estado CONSULTÁVEL
lockedCount(projectId)                         // para as contagens de capacidade
```

Observabilidade: callback `onContention` → evento blackbox
`phase-transition-contention` (só quando alguém realmente espera/é recusado —
é exatamente a corrida que o lock existe para pegar) + span
`advancePhase:lock-wait` no `mainStalls` em quem espera (senão fila viraria
"duração de advancePhase" e poluiria o ranking da Fase 0).

**Sem estado em disco.** O lock é memória; crash = lock some junto com o
registry, e a reconciliação de boot continua exatamente a de hoje (§4.5 do
mapa). Exposto no `MainContext` como `ctx.phaseTransitions` (nasce no
phaseEngine, como o `phaseWatches`).

### 3.2 As três regras de ouro

1. **Aquisição SÓ nos pontos de entrada** (fontes de evento), NUNCA no grafo
   interno do engine — é o que elimina deadlock por re-aquisição. As
   continuações (`openGatePane`/`retryOrBacklog`/`finalizeTask`) rodam SOB o
   token de quem entrou; o release acontece no settle da cadeia inteira
   (`finally`).
2. **Ordem síncrona sagrada, sem await entre os passos**:
   `acquire → phaseWatches.detach → unlinkSync(marker)` — e só a partir daí
   pode haver await. O detach continua sendo o primeiro ato observável
   (é ele que torna inofensivos o `onExit`, o segundo report e o
   `pty:create`, §5.5/§7.2/§5.11 do mapa); o lock resolve o problema OPOSTO —
   dizer ao resto do app que "sem watch" não significa "livre".
3. **"Quem SEGURA O LOCK deleta o watch"**: o re-check de identidade por
   referência do poller (que o rollback de mesmo-objeto quebra — §7.1, 🔴 já
   possível HOJE em janela estreita) é substituído por posse de token. Quem
   não conseguiu `acquire` não detacha, não unlinka, não avança.

Tripwire de contrato: `advancePhaseInner` afere
`phaseTransitions.owns(taskId, token)` na entrada (token vira parâmetro);
chamada sem posse = evento `phase-advance-without-lock` na caixa-preta
(anomalia que o critério de pronto exige zerada — nunca um throw que
brickaria veredito).

### 3.3 Tabela de decisão dos entrantes (consolidada dos dois mapas)

| Entrante | Ação | Nota |
|---|---|---|
| tool MCP `report` — veredito (call sites A e B) | **ADQUIRIR** (síncrono, na entrada do caminho de veredito) | falha de acquire = "a rodada anterior está fechando; aguarde o evento" |
| `report` — os 2 blocos `bloqueada` (gate e dev-UI) | **ADQUIRIR** | hoje ficam FORA do advancePhase e fazem transição de card — sem o lock, ele protege metade |
| poller — ramo do marcador `.done` | **ADQUIRIR** (substitui o re-check por referência) | `phaseMarkersProcessing` continua (dedupe poller×poller) |
| continuações `openGatePane`/`retryOrBacklog`/`finalizeTask` | **herdam o token** do veredito; release no settle da cadeia | `finalizeTask` mata panes SEM desregistrar (:2465) — corrigir para o padrão `terminatePaneNow` na mesma obra |
| `recoverFinalizingTask` (boot `void` + `run_task {finalize}`) | **ADQUIRIR** | muta o card com watch SINTÉTICO que nunca entra no registry — por isso o lock é chaveado por `taskId`, nunca por watch |
| `setPhaseExecutorImpl` (⇄ / `set_phase_executor`) | **ESPERAR** (`waitAndAcquire`) | é ordem do dono — nunca recusar; mensagem honesta "a rodada está sendo fechada; a troca entra em seguida" |
| `respawnInterruptedPhase` (drain ao abrir projeto) | **ADQUIRIR** | já tem `phaseLaunches`; soma o lock |
| `run_task` (todas as formas, incl. `finalize`) | **RECUSAR** com receita | fecha §7.5 e §7.9 (dois merges do mesmo card — 🟠 já possível hoje) |
| `removeTaskCascade` / `stopMissionExecution` / `projects:relocate` | **RECUSAR** com receita | §7.11: hoje o throw pós-remoção vira watch fantasma eterno |
| `tasks:update` do renderer | lock tomado ⇒ `hasActivePane = true` | fecha o kanban movendo card no meio do veredito (§5.12) |
| poller — ramos `phase-watch-released` / `pane-open-lost` | **PULAR** card com lock | o released mata pane (`terminatePaneNow`) — com rollback de `createdAt` vencido seria fogo amigo (§7.4) |
| contagens `MAX_PARALLEL_RUNS` (4 sites) | **SOMAR** `lockedCount(projectId)` | senão cada veredito em voo fura o teto em 1 (§7.6) |
| `sweepProjectFiles` | preservar marcador também quando `isLocked` | §8.4 |
| `onExit` do PTY | **CONSULTAR e não mutar** (registrar evento) | as guardas de hoje (identity desregistrada, watch detached) continuam a 1ª linha |
| watchdogs, `rollbackFailedPaneSpawn`, `pty:create`, `completeMissionMerge`, `planStop`, `recordGateDeath`, helpers/QA re-checks | **ORTOGONAIS** | justificativas célula a célula no mapa §5/§7.12 |

Toda recusa nasce com rota de saída sancionada (regra de projeto F6.8b):
receita "aguarde segundos e repita" + o lock SEMPRE solta no settle + crash
zera memória — beco sem saída é bug, não rigor.

---

## 4. A conversão do `advancePhaseInner` (o corte de comportamento)

### 4.1 Git consolidado — viagens, não sequência de swaps

Conversão 1:1 viraria 6-7 round-trips serializados no worker único
(compartilhado com spawn/skills/merges) — trocaria stall por latência de fila
(R10). Em vez disso, **funções novas de pacote em `worktree.ts`** (mesmo
racional que criou o `snapshotProblemFor`: "uma viagem ao worker em vez de
cinco"):

- `devDeliveryFacts(...)` → head/tree/clean/fingerprint (+ branch base e
  changedPaths quando pedidos) numa viagem — cobre o ramo dev inteiro
  (1 viagem; hoje até 7 chamadas). O `gitVisibleWorktreeFingerprint` que hoje
  roda DENTRO do objeto de patch do `tasks.update` (:3375) passa a vir
  pré-calculado do pacote — nunca "no meio" da gravação.
- `gateVerdictFacts(...)` → fingerprint final + snapshotProblem + head numa
  viagem — cobre o preâmbulo do gate.
- `quarantineAndRevalidate(...)` → quarentena + re-fingerprint +
  re-snapshotProblem numa segunda viagem, SÓ quando a quarentena dispara.

O registry do worker não muda para nada disso (spread de worktree.ts).
`snapshotProblemFor` (pura) continua existindo — é o corpo que roda no worker.

### 4.2 `reviewArtifactProblem` sai do main (R11)

O sha256 do patch privado (o artefato existe para reviews de ~120k) é o único
I/O pesado do veredito SEM caminho para o worker — mora no closure do engine.
Extração do cálculo (`reviewArtifactIdentity`) para `reviewEvidence.ts`
(módulo já puro) + `reviewEvidence` entra no spread do registry (1 linha no
`gitWorker.ts` + o tipo no `gitAsync.ts`). O engine passa o path/expected por
valor e aguarda o worker. Sem isso, o stall sobrevive à Fase 2 nos reviews
grandes.

### 4.3 Regras de frescor (o que os awaits mudam nas leituras)

- **Releitura única**: o card é relido UMA vez após o último await de git e
  essa fotografia vale até o commit (`recordGate` deixa de reler por conta
  própria — R4; hoje são 4 releituras que enxergam o mesmo estado por sorte
  síncrona).
- **`rejectingGate` por parâmetro**: `retryOrBacklog` deixa de re-consultar
  `liveGateWaits` (um `onExit` no meio apagaria a espera e a evidência do
  gate reprovado NÃO seria zerada → a memoização por head poderia "aprovar" o
  que reprovou — bug latente §6.1, o pior achado do mapa). O gate reprovador
  é calculado dentro do lock e viaja como argumento.
- **`planTask` é leitura TARDIA obrigatória** (comentário-âncora): a pausa do
  dono no meio do veredito tem que continuar sendo lida DEPOIS dos awaits
  (§7.8) — "otimizar" lendo no topo ignoraria o "pare AGORA".
- **`devSnapshot` vira VALOR**: `codeReportGuard` devolve a fotografia e ela
  viaja guard → report → advancePhase como argumento — mata a escrita
  concorrente do mesmo campo do mesmo objeto por dois caminhos (§7.10, 🟠 já
  possível hoje). O guard em si fica FORA do lock (diagnósticos de segundos;
  o veredito re-confirma os fatos dentro do lock de qualquer forma).
- **Rollbacks renovam `createdAt`** (§7.4) — cinto duplo com o "pular card
  com lock" do poller.

### 4.4 Correções de transação embutidas (defeitos que o async agrava)

- **R7 — commit antes dos efeitos destrutivos**: nos 5 desfechos do gate, o
  `recordGate` passa a vir ANTES de `cleanupReviewArtifact`/
  `terminateTaskPhasePane` (hoje só a reprovação (c) faz assim; no desfecho
  `!readonly`, um throw no commit deixa artefato apagado e pane morto com a
  promessa "tente novamente" quebrada).
- **R8 — desfecho (b) numa gravação só**: veredito ilegível hoje faz DOIS
  `tasks.update` em sequência; colapsar num patch único (um await no meio
  criaria estado intermediário persistido observável).
- **Call site A do report ganha a MESMA transação do B**: detach → advance →
  rollback no throw (hoje não tem try/catch — throw perde o watch).
- **`finally` do lock**: se a cadeia abortar por exceção fora dos ramos
  conhecidos com o watch não-reindexado, `cleanupReviewArtifact` roda — o
  `.diff` privado não vaza até o boot (§8.3).
- **R2 — rollback tardio não destrói o artefato da rodada nova**: o
  `phaseWatches.set` de rollback só re-indexa se o registry não tiver ganhado
  um watch NOVO do mesmo card nesse meio (checagem por posse do token — com o
  lock cobrindo as continuações, o caso vira impossível por construção; o
  teste 10 da matriz prova).

### 4.5 O contrato de tipos como enforcement

`PhaseApi.advancePhase` → `Promise<boolean>` (+ o parâmetro do token). O
typecheck FORÇA cada call site a mudar — a classe de bug da cicatriz
("Promise tratada como valor") vira erro de compilação nos pontos de
atribuição. Os 4 comentários-cicatriz (mainContext, phaseEngine ×2, report) +
o do worktree.ts:86 são REESCRITOS, nunca apagados: a verdade nova é
"atomicidade por SERIALIZAÇÃO (lock por card)", com a cicatriz citada — o
modo de falha volta a ser possível a cada await esquecido.

---

## 5. Testes (a prova substitui o achismo)

### 5.1 Suíte do lock — `test:phase-transition-lock`

Módulo puro em node cru: serialização FIFO, try-acquire síncrono, release só
do dono, release no throw, isLocked/holderLabel/lockedCount, contention
callback, cards distintos em paralelo.

### 5.2 Harness de corrida contra o engine REAL — `test:phase-verdict-races`

O phaseEngine importa electron (linha 23) — node cru não o importa direto. O
harness usa os DOIS precedentes já validados do repo:

- compilação tsc → CJS + stub de `electron` via `Module._load`
  (`test-store-atomicity.mjs`);
- fixture git REAL em tmpdir (`test-mission-worktree.mjs`).

`createPhaseEngine(ctx, extras)` recebe um ctx MÍNIMO: TaskStore real sobre
userData temporário, worktree/fixture git real, stubs de
hub/blackbox/ptys/uiSender/syncBoard, `mainStalls` real (é puro). O `gitAsync`
é stubado por `Module._load` com um gate controlável — é ele que permite
**pausar o veredito em cada ponto de await** e injetar o concorrente.

**Aviso honesto de esforço**: montar a superfície fake do ctx é o maior custo
da fase (o mapa do veredito lista os membros realmente usados). Se na
implementação a superfície se provar inadministrável, o recuo sancionado é:
harness cobre o protocolo da transação (lock + detach + commit/rollback com
efeitos injetados) em vez do engine inteiro, e a validação ao vivo compensa —
decisão levada ao dono com o custo na mesa, nunca silenciosa.

O harness nasce ANTES da conversão, com baseline dos fluxos ATUAIS (dev done
aprovado · gate reprovado · review→qa) — prova o harness antes de provar a
mudança.

### 5.3 Matriz de corrida (13 casos, união dos dois mapas)

1. report × report no mesmo card → exatamente UM avanço; o segundo recebe
   "sua rodada já FECHOU".
2. poller × report com rollback no meio (§7.1) → o poller NÃO executa o
   segundo advancePhase mesmo com o objeto restaurado (posse de token).
3. `run_task` durante o veredito → recusa com receita; nenhum
   `phase-prepare-cancelled` gerado (§7.5).
4. `onExit` do pane no meio → nenhuma mutação de card; `gateDeathLog` NÃO
   incrementa (§7.7 + regressão barata do §6.2).
5. plano pausado no meio → veredito grava, card estaciona, nenhum pane novo
   nasce (§7.8).
6. `removeTaskCascade` no meio → recusado; nenhum watch fantasma (§7.11).
7. **veredito × boot**: morte simulada em CADA ponto de await (gate do stub
   de gitAsync) → o estado persistido cai no inventário reconciliável do
   §4.5 (dev → backlog + re-entrega `redelivery-accepted`; gate →
   `gate-preserved`; finalizing → `recoverFinalizingTask` executado DE
   VERDADE no harness) — sem worktree órfão, sem receipt inconsistente.
8. veredito × `codeReportGuard` de re-entrega sancionada no mesmo card.
9. throw forçado no `recordGate` → watch restaurado E artefato/pane intactos
   (prova a correção R7).
10. reciclo de gate novo começando com veredito anterior pendente → o
    artefato da rodada nova sobrevive (prova R2).
11. **tudo acima com `gitAsync` no fallback síncrono** (R9).
12. regressão: `MAX_PARALLEL_RUNS` conta locks tomados (§7.6).
13. dois vereditos de cards DIFERENTES em paralelo → nunca se serializam
    entre si (o lock é por card, não global — o paralelismo é lei).

---

## 6. Fatiamento de commits (cada um verde e reversível)

| # | Commit | Conteúdo | Comportamento muda? |
|---|---|---|---|
| F2-c1 | `fase2: phaseTransitionLock puro + suite` | módulo + `test:phase-transition-lock` | não (sem consumidor) |
| F2-c2 | `fase2: harness de corrida do veredito (baseline sync)` | tsc+stub+ctx fake+fixture git; baseline dos fluxos atuais; `test:phase-verdict-races` | não |
| F2-c3 | `fase2: pacotes de fatos git no worktree + artefato de review elegivel ao worker` | `devDeliveryFacts`/`gateVerdictFacts`/`quarantineAndRevalidate` + extração `reviewArtifactIdentity` → reviewEvidence.ts + registry | não (sem consumidor) |
| F2-c4 | `fase2: SERIALIZAR - lock em todos os entrantes, advancePhase ainda sync` | tabela §3.3 inteira ligada (acquire/esperar/recusar/somar/pular/consultar) | **não** (seções sync nunca contendem) — mas recusas/contagens já testáveis |
| F2-c5 | `fase2: DESSINCRONIZAR - advancePhaseInner async via gitOff` | §4 completo: pacotes de fatos, frescor, R7/R8/§6.1/§7.4/§7.10, PhaseApi `Promise<boolean>`, report async, poller await, cicatrizes reescritas; matriz de corrida liga | **SIM** — o corte da fase |
| — | Validação ao vivo do dono | missão com gates + `bbwatch --grep stall` | critério de pronto §1.3 |

Se o diff do c5 crescer além do revisável, o corte sancionado é c5a (ramo
gate) / c5b (ramo dev + devSnapshot-por-valor), cada um verde — nunca
meio-fazer dentro de um ramo.

**Rollback**: revert do c5 restaura o contrato sync integral (c1–c4 são
inofensivos em volta de seções síncronas); cada commit é independente.

Regras vivas da obra (inalteradas da Fase 1): app parado para editar src
(checar processo antes de cada edit — a prova expira) · commits `fase2:` sem
acentos · git add por caminho explícito · agentes Opus sob liberação por
sessão · scripts por âncora, nunca número de linha · higiene de imports por
diff de órfãos · nunca "aproveitar e refatorar" fora do mapa.

---

## 7. Riscos residuais (aceitos e declarados)

- **R9**: com o worker morto, o fallback síncrono devolve o comportamento de
  hoje (stall volta, corretude fica). Declarado; caso 11 da matriz cobre.
- **Fila do worker**: o veredito passa a competir com spawn/skills/merge no
  worker único. Mitigado pela consolidação (1-2 viagens por veredito); se a
  validação ao vivo mostrar fila, a evolução natural (worker dedicado de
  leitura) é obra futura, não desta.
- **Poller `false` no marcador**: já hoje o retorno é ignorado e o `.done`
  consumido — o card espera nova entrega (`redelivery-accepted` cobre).
  Comportamento preservado, agora documentado.
- **Divergência doc×código achada na varredura**: `phase-watch-repaired` não
  existe mais em src (o ponto CANCELA via `phase-prepare-cancelled`). O plano
  não assume o cinto; corrigir CLAUDE.md/MAPA_RETOMADA é higiene de docs à
  parte.

## 8. Fora de escopo (não tocar nesta fase)

`completeMissionMerge`/fila de integração (ortogonais — worker serializa +
revalidação de fotografia própria) · partição do missionEngine e do
pty:create (débitos registrados da Fase 1) · overlays/verificação de plano ·
qualquer refatoração fora do mapa · Fases 3–5 do plano do nível 5.

---

**Aprovação**: com o OK do dono, a execução começa pelo F2-c1. Sem OK, nada
é cortado.
