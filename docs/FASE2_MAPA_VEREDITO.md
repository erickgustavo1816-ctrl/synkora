# FASE 2 — MAPA DO VEREDITO (varredura READ-ONLY, 2026-08-08)

Insumo para a cirurgia da **Fase 2 do nível 5** (`docs/PLANO_NIVEL_5.md`,
seção "Fase 2 (5a parte 2) — veredito sem barreira síncrona"): converter
`advancePhase` de SYNC POR CONTRATO para assíncrono, trocando a *barreira
síncrona* por um **lock de transição por card** (fila serializada
taskId→Promise) e mandando o git síncrono do caminho do veredito para o
`gitWorker` via `gitOff`.

Nenhum arquivo de código foi alterado nesta varredura.

## Como ler as âncoras

Cada item traz um **trecho greppável** (`grep -F` literal) e, por cortesia, o
número de linha do dia da varredura. **A âncora é o trecho, não o número.**
Todos os trechos foram verificados com contagem: salvo aviso explícito
("N ocorrências"), cada um casa **exatamente uma vez** no arquivo indicado.

Arquivos e tamanhos na data: `phaseEngine.ts` 4114 linhas ·
`mcpApi/report.ts` 767 · `gitAsync.ts` 172 · `gitWorker.ts` 90 ·
`stallAttribution.ts` 162 · `mainContext.ts` 217 · `worktree.ts` 1448.

---

## 0. O contrato hoje, e onde ele está escrito

O contrato SYNC aparece em **quatro** lugares e todos precisam ser tocados
juntos na conversão:

| Onde | Âncora | O que diz |
|---|---|---|
| `mainContext.ts` (~:77-91) | `SYNC POR CONTRATO (barreira síncrona do veredito — a` | tipo `PhaseApi.advancePhase(...): boolean` com o aviso "NUNCA transformar em `Promise<boolean>`" |
| `phaseEngine.ts` (cabeçalho, ~:12) | `advancePhase é SYNC POR CONTRATO (barreira síncrona do` | contrato do módulo |
| `phaseEngine.ts` (:3129-3131) | `do veredito (comentário-âncora no Inner) fica intacto: wrap de função` | justifica o wrapper fino de stall |
| `phaseEngine.ts` (:3424-3427) | `SYNC de propósito: advancePhase é a barreira síncrona do veredito` | o comentário-âncora citado pelos outros três |
| `mcpApi/report.ts` (:11-16) | `report devolve string SÍNCRONO no caminho do veredito — advancePhase é` | contrato do módulo do report |
| `worktree.ts` (:86-91) | `worker via gitOff em vez de cinco, e chamável SÍNCRONA onde o chamador é` | por que `snapshotProblemFor` é pura e síncrona |

**A cicatriz** (2026-08-05): a conversão do gitWorker tornou
`taskSnapshotProblem` async e dois call sites ficaram sem `await`;
`advancePhase` tratou a `Promise` como fotografia inválida e **todo** veredito
de gate foi invalidado. A resposta foi extrair `worktree.snapshotProblemFor`
como função **pura e síncrona** (fonte única) e deixar a variante async
delegar a ela pelo worker.

### O que a barreira síncrona realmente protege

Não é "git no main". É **a janela entre a última verificação de fotografia e a
gravação do estado**. A prova disso está no par
`codeReportGuard` × `advancePhaseInner`:

- `mcpApi/code.ts` — âncora `codeReportGuard: async (id) => {` (:82) — tira a
  fotografia (`watch.devSnapshot = preparedSnapshot`, 2 ocorrências, :195 e
  :223), roda os diagnósticos LSP (segundos, com `await`) e **termina**
  re-checando os mesmos quatro fatos git em `const snapshotDrift = (): string | undefined => {`
  (:197-209): `gitHead` / `gitTree` / `isWorktreeClean` /
  `gitVisibleWorktreeFingerprint`. São 6 call sites de `snapshotDrift()`
  (`grep -c "snapshotDrift()"` = 6), todos como `return` final de um ramo.
- Em seguida, o handler MCP faz `await api.codeReportGuard(identity)` e só
  então chama `api.report(...)`; `advancePhaseInner` **repete os mesmos quatro
  fatos** em `const snapshotStillExact = Boolean(` (:3202-3209).

Ou seja: a checagem cara e demorada já é assíncrona; o que é síncrono é a
**re-confirmação + gravação**. É exatamente esse par (re-confirmar → gravar)
que o lock precisa preservar como região crítica. A conversão é segura na
medida em que **nenhuma outra transição do mesmo card** possa entrar entre a
re-confirmação e o último `tasks.update` da transição.

---

## 1. `advancePhase` / `advancePhaseInner` — caminhada completa

`phaseEngine.ts` :3119-3839 (721 linhas). Âncoras:
`function advancePhase(` (:3119) e `function advancePhaseInner(` (:3136).

O wrapper é fino e nada mais faz do que a atribuição de stall:

```
mainStalls.wrap(`advancePhase:${watch.phase}`, watch.taskId.slice(0, 8), () =>
```

### 1.0 Preâmbulo comum (:3146-3196)

| # | Âncora | Natureza |
|---|---|---|
| 1 | `const task = tasks.get(watch.taskId)` (**3 ocorrências**: :1915 `retryOrBacklog`, :2799 `openGatePane`, :3146 aqui — a deste ramo é a única seguida de `if (!task) return false`) | leitura de store (memória) |
| 2 | `const commitRuntimeAcceptance = (): void =>` (:3149) | closure; ao falhar grava `skill-runtime-post-commit-mismatch` na caixa-preta |
| 3 | `conclusão bloqueada: ainda existe ajudante aberto neste card` (:3186) | **guard dev**: `phaseWatches.set(watch.taskId, watch)` (rollback) + `hub.notifyPane` → `return false` |
| 4 | `const configuredGates = task.gates ?? ['review', 'qa']` (:3191) | puro |
| 5 | `classifyTaskUiWork(task)` (via `skillsRouting`) | puro |

Nada de git/fs aqui. **Primeira mutação possível**: o `phaseWatches.set` de
rollback do item 3.

### 1.1 Ramo DEV — `watch.phase === 'dev'` (:3197-3418)

Ordem exata (G = git síncrono, M = mutação de estado):

| # | Passo | Âncora | Tipo |
|---|---|---|---|
| 1 | fotografia ainda exata? `gitHead` + `gitTree` + `isWorktreeClean` + `gitVisibleWorktreeFingerprint` | `const snapshotStillExact = Boolean(` (:3202) | **G ×4** |
| 2 | drift → invalida fotografia e devolve o watch | `a fotografia mudou depois dos diagnósticos` (:3216); a mutação é `watch.devSnapshot = undefined` (2 ocorrências; esta é a de :3211) + `phaseWatches.set` | **M** → `return false` |
| 3 | `missions.get` / `projects.get` | — | leitura |
| 4 | base do diff — `currentBranch(project.path)` só quando não há missão nem `snapshot.baseHead` | `? currentBranch(project.path)` (:3228) | **G (condicional)** |
| 5 | paths alterados | `const changedPaths = baseRef ? changedWorktreeFiles` (:3230) | **G** |
| 6 | ENTREGA VAZIA (head == base) | `event: 'empty-delivery-blocked'` (:3245) | **M** em bloco: `blackbox.record` → `terminateTaskPhasePane(...,'dev')` → `tasks.update` (backlog/interrupted/feedback) → `hub.publish` urgente → `uiSender.send('tasks:changed')` → `syncBoard` → `return true` |
| 7 | non_code que tocou path executável | `a fotografia non_code não pôde ser provada` (:3289) | **M**: `watch.devSnapshot = undefined` (:3284) + `phaseWatches.set` → `return false` |
| 8 | carimbo de hora | `const reportedAt = new Date().toISOString()` (:3294) | puro |
| 9 | memoização por head (review/qa já aprovados para o MESMO head) | `const reviewMemo =` (:3305) | leitura de `task.verification` |
| 10 | se memoizou | `event: 'gate-skipped-memoized'` (**2 ocorrências**: :3324 no ramo dev, :3809 no ramo review→qa) | **M**: `blackbox.record` + `hub.publish` |
| 11 | re-leitura fresca do card | `const latestBeforeGate` (:3357) | leitura |
| 12 | **A transação principal do dev** | `tasks.update(watch.taskId, {` seguido de `status: next === 'qa' ? 'qa' : 'execucao'` (:3360) | **M** — e **dentro do patch** há um **G**: `fingerprint: snapshot?.fingerprint ?? gitVisibleWorktreeFingerprint(watch.cwd)` (:3375) |
| 13 | consome os receipts de skill | `commitRuntimeAcceptance()` (3 ocorrências do identificador; a chamada nua é a de :3386) | **M** (`skillRuntime.acceptReport`) |
| 14 | evento de progresso | `kind: 'report'` + `dev concluiu "${task.title}"` (:3387-3393) | **M** (EVENTS.md + fila do hub) |
| 15 | log do maestro | `✔ dev sinalizou conclusão de` (:3397) | **M** |
| 16 | mata browser/app do produto do pane do dev | `if (watch.paneId) ptys.reapVisualsOf(watch.paneId)` (:3401 — o identificador tem 2 ocorrências; esta é a com `if (watch.paneId)`) | **M** (processos) |
| 17 | mata helpers | `entrega congelada para gates independentes` (:3402) | **M** |
| 18 | mata o pane do dev | linha **imediatamente após** a âncora `entrega congelada para gates independentes` (:3403). O literal `terminateTaskPhasePane(watch.projectId, watch.taskId, 'dev')` tem **6 ocorrências** no arquivo — ancore pelo vizinho | **M** |
| 19 | próxima fase | `if (next) void openGatePane(watch, next)` (:3404) **ou** `void finalizeTask(` (:3406) | **fire-and-forget** |
| 20 | só quando não há gate | `if (!next) {` + `uiSender.send('tasks:changed', ...)` + `syncBoard` (:3413-3416) | **M** |
| 21 | — | `return true` (:3417) | |

**Janela de atomicidade do dev**: os passos 1 (re-checagem G×4) e 12 (o
`tasks.update`) **precisam continuar no mesmo turno lógico**. Hoje é o mesmo
tick; com o lock, precisam estar dentro do mesmo `await`-livre ou, no mínimo,
dentro do mesmo lock **sem que nada mais toque `watch.cwd`**. Observe que o
passo 12 ainda executa um `gitVisibleWorktreeFingerprint` **dentro do objeto de
patch** — na versão async isso precisa ser pré-calculado antes do `update`,
nunca "no meio" dele.

### 1.2 Ramo GATE — review/qa (:3419-3838)

Preâmbulo do veredito, em ordem:

| # | Passo | Âncora | Tipo |
|---|---|---|---|
| 1 | hora do veredito | `const finishedAt = new Date().toISOString()` (:3420) | puro |
| 2 | fingerprint final da árvore | `let finalFingerprint = gitVisibleWorktreeFingerprint` (:3421) | **G** |
| 3 | baseline do gate (do próprio watch) | `const baselineFingerprint = watch.gateBaselineFingerprint` | leitura do objeto `watch` |
| 4 | card fresco | `const latestForSnapshot = tasks.get(watch.taskId) ?? task` (:3423) | leitura |
| 5 | **fotografia imutável** (5 comandos git internos: merge-base, rev-parse, rev-parse^{tree}, status --porcelain, fingerprint) | `? snapshotProblemFor(watch.cwd, snapFacts, latestForSnapshot.deliverable === 'code')` (:3436) | **G (pesado)** |
| 6 | artefato imutável do review | `const artifactProblem = reviewArtifactProblem(watch)` (:3438) | **FS pesado**: `statSync` + `openSync`/`readSync` em laço de 1 MiB + sha256 do patch inteiro (`function reviewArtifactIdentity`, :264) |
| 7 | **quarentena de evidência** | condição contém `gitHead(watch.cwd) === devFacts?.head` (:3452) e o corpo `quarantineUntrackedNew(` (:3456) | **G** + **FS** (`git status --porcelain -uno`, `git ls-files --others`, renames) |
| 8 | se moveu algo, refaz 2 e 5 | `finalFingerprint = gitVisibleWorktreeFingerprint(watch.cwd)` dentro do bloco de :3467 e `snapshotProblem = snapshotProblemFor(` (:3468) | **G ×2** |
| 9 | auditoria da quarentena | `event: 'gate-evidence-quarantined'` (:3475) | **M**: `blackbox.record` + `hub.publish` quiet |
| 10 | vínculo com a fotografia do dev | `const boundToDevSnapshot = Boolean(` (:3497) | puro |
| 11 | **veredito de imutabilidade** | `const readonly =` (:3502) | puro |
| 12 | guard de escopo | `securityReview recusado: somente o revisor, durante a fase review` (:3510) | **`throw new Error`** |
| 13 | evidência de segurança em disco | `persistSecurityReview(project.path, securityReview)` (:3534) | **FS** (3 escritas atômicas). Falha → `phaseWatches.set` + `notifyPane` → `return false`. Projeto ausente → `phaseWatches.set` → `return false` |
| 14 | pré-cálculo da validação do plano | `let pendingSecurityPlanApproval:` (:3513) e `const approveSecurityPlan = verdict === 'approved' && pendingSecurityPlanApproval` (:3648) | leitura (`planTaskForWorkTask`) |
| 15 | closure de gravação do veredito | `const recordGate = (` (:3580) | ver abaixo |

#### `recordGate` — a transação indivisível do gate (:3580-3684)

- Relê o card (`const latest = tasks.get(watch.taskId)` — **4 ocorrências** no
  arquivo: :2025, :2873, :3088 e :3588; a do `recordGate` é a de :3588, a única
  **sem** `?? task` que está dentro do closure), monta
  `TaskGateEvidence` e o `workTaskPatch` (gateRound, transição
  `dev`|`qa`|`finalize`, `verification.gateHistory` capado em 24).
- **Dois caminhos de commit**:
  - com validação de segurança pendente: `tasks.updateMany([...])` — card de
    trabalho **e** card de plano numa gravação só; se qualquer um sumir,
    `throw` (`aprovação de segurança recusada: card de trabalho ou plano desapareceu antes do commit`).
  - normal: `else if (!tasks.update(watch.taskId, workTaskPatch))` →
    `card desapareceu antes do commit do veredito do gate` (:3681) — **throw**.
- Só depois: `blackbox.record` (`security-gate-validated`) e
  `if (consumeAcceptance) commitRuntimeAcceptance()`.

**Esta é a região crítica real do gate.** Tudo entre o passo 5 (fotografia) e o
commit do `recordGate` define o veredito; se alguém mexer no worktree ou no
card nesse meio, o veredito grava uma verdade velha.

#### Os cinco desfechos do gate

**(a) `!readonly` — veredito INVALIDADO** — âncora `if (!readonly) {` (:3685):

`cleanupReviewArtifact(watch)` (unlinkSync) → `terminateTaskPhasePane` →
`liveGateWaits.delete(watch.taskId)` → **`recordGate('invalid', reason, false, 'dev')`**
(:3696) → `hub.publish` **quiet** (o aviso acionável é o do `retryOrBacklog`) →
`void retryOrBacklog(watch, ...)` (:3709) → `return true`.
**Não** emite `tasks:changed`/`syncBoard` aqui — quem faz é o `retryOrBacklog`
no fim dele.

Note a ordem: o artefato é apagado e o pane é morto **antes** do commit. Um
`throw` dentro do `recordGate` deixa artefato e pane já destruídos — ver
RISCO R7.

**(b) veredito ILEGÍVEL** — âncoras `const m = content.match` (:3712) e
`veredito ilegível: ${content.slice(0, 120)}` (:3724):

`cleanupReviewArtifact` → `terminateTaskPhasePane` → `liveGateWaits.delete` →
`recordGate('invalid', ...)` **sem transição** → **segundo `tasks.update`**
(status/feedback/activePhase/phaseState, :3725-3730) → `emitLog` →
`hub.publish` → cai no epílogo comum (:3836-3838).
São **duas gravações** do mesmo card em sequência — dividi-las por um `await`
cria um estado intermediário observável.

**(c) REPROVADA** — âncora `const prevRound = task.gateRound?.phase === watch.phase` (:3747):

`parseGateScore(motivo)` → monta `nextGateRound` (com um
`tasks.get(watch.taskId)` para congelar `gateNotesAtRejection`) →
`recordGate('rejected', motivo, readonly, 'dev', true, nextGateRound)` (:3764)
→ `cleanupReviewArtifact` → `maybeAlarmGateLoop(watch, task, roundScores)`
(:3766 — publica evento urgente + blackbox) → **gate vivo**: se
`watch.paneId && ptys.has(watch.paneId)` então `liveGateWaits.set(watch.taskId, {`
(:3771) + `hub.notifyPane` + `ptys.reapVisualsOf(watch.paneId)` (:3786);
senão `terminateTaskPhasePane` (:3788) → `hub.publish` (report) →
`void retryOrBacklog(watch, who, motivo)` (:3791) → `return true`.
**Sem** `tasks:changed`/`syncBoard` diretos.

**(d) APROVADA no review, com QA pendente** (:3793-3828):

- sub-ramo memoizado — `const qaAlreadyApproved = Boolean(` (:3797):
  `recordGate('approved', motivo, readonly, 'finalize', true)` (**2
  ocorrências** deste literal: :3803 aqui e :3830 no desfecho (e)) →
  `cleanupReviewArtifact` → `terminateTaskPhasePane` → `liveGateWaits.delete` →
  `blackbox` (`gate-skipped-memoized`) → `hub.publish` → `void finalizeTask` →
  `uiSender` + `syncBoard` → `return true`.
- sub-ramo normal: `recordGate('approved', motivo, readonly, 'qa', true)`
  (:3821) → `cleanupReviewArtifact` → `terminateTaskPhasePane` →
  `liveGateWaits.delete` → `emitLog` → `hub.publish` →
  `void openGatePane(watch, 'qa')` (:3827) → `return true`
  **sem** `tasks:changed`/`syncBoard` (o `openGatePane` cuida).

**(e) APROVADA final** (:3829-3835): `recordGate('approved', ..., 'finalize', true)`
→ `cleanupReviewArtifact` → `terminateTaskPhasePane` → `liveGateWaits.delete` →
`void finalizeTask(watch, task, \`aprovada pelo ${who}\`)` → epílogo comum.

**Epílogo comum** (:3836-3838): `uiSender.send('tasks:changed', ...)` +
`syncBoard(watch.projectId)` + `return true`. Alcançado apenas por (b) e (e).

### 1.3 `'bloqueada'` NÃO passa por aqui

O veredito ambiental é tratado **inteiramente** em `mcpApi/report.ts`, antes de
qualquer chamada a `advancePhase`:

- gate: `if (\n        (watch.phase === 'review' || watch.phase === 'qa') &&` seguido de
  `blockedReport` — âncora `event: 'gate-blocked-environment'` (:548).
  Faz `cleanupReviewArtifact` → **`phaseWatches.delete`** (não `detach`) →
  `unlinkSync(marker)` → `appendFileSync(logFile)` → `stopQaRuntime` →
  `liveGateWaits.delete` → `terminateTaskPhasePane` → `tasks.update`
  (feedback INTOCADO) → `blackbox` → `hub.publish` urgente → `uiSender` →
  `syncBoard`.
- dev de UI sem browser: âncora `event: 'dev-ui-blocked-environment'` (:597),
  mesma forma.

**Consequência para o plano**: os dois blocos `bloqueada` são transições de
card que hoje rodam fora de `advancePhase` e **precisam entrar no mesmo lock**,
senão o lock protege metade das transições.

### 1.4 Inventário consolidado das chamadas git/fs síncronas

| Chamada | Onde (âncora) | O que computa | Já existe no worker? | Veredito de migração |
|---|---|---|---|---|
| `gitHead` ×1 | `const snapshotStillExact = Boolean(` (:3205) | HEAD do worktree | **sim** — `worktree.ts:42 export function gitHead`; o registry do worker é `...worktree` (spread de módulo) | migra como está |
| `gitTree` ×1 | idem (:3206) | árvore do head | sim | migra |
| `isWorktreeClean` ×1 | idem (:3207) | `status --porcelain` limpo | sim (`worktree.ts:275`) | migra |
| `gitVisibleWorktreeFingerprint` ×4 | :3208, :3375, :3421, :3467 | fingerprint da árvore visível ao git (varredura completa — o custo dominante) | sim (`worktree.ts:546`) | migra; **as 4 viagens devem virar 1-2**, ver R10 |
| `currentBranch` ×1 | `? currentBranch(project.path)` (:3228) | branch do projeto | sim (`worktree.ts:935`) | migra |
| `changedWorktreeFiles` ×1 | `const changedPaths = baseRef ? changedWorktreeFiles` (:3230) | diff vs merge-base + untracked | sim (`worktree.ts:482`) | migra |
| `snapshotProblemFor` ×2 | :3436 e :3468 | as 5 checagens da fotografia numa passada | sim (`worktree.ts:92`) — e já existe o wrapper async `taskSnapshotProblem` | **trocar pelas chamadas `await taskSnapshotProblem(...)`/`gitOff('snapshotProblemFor', ...)`** — é a razão de ser da Fase 2 |
| `quarantineUntrackedNew` ×1 | `quarantineUntrackedNew(` (:3456) | move untracked novo p/ quarentena; devolve paths | sim (`worktree.ts:141`) | migra (é git + rename; nada de electron) |
| `isExecutableProjectPath` | :3282 | classificação de path por extensão | é puro (string) | **fica no main** — não vale viagem |
| `reviewArtifactProblem` → `reviewArtifactIdentity` | `const artifactProblem = reviewArtifactProblem(watch)` (:3438) | sha256 + tamanho do patch privado | **não** — mora no closure do `phaseEngine`, usa `reviewEvidenceRoot` (`app.getPath('userData')`) e `openSync/readSync/statSync` | **precisa de entrada nova** num módulo puro (ex.: `reviewEvidence.ts`, que o worker já poderia importar) **ou** aceita ficar no main. Patch grande = sha256 de dezenas de MB no main thread; é um stall real, mas é FS/CPU, não git |
| `persistSecurityReview` | :3534 | 3 escritas atômicas em `.synkora/reports/security` | não (`securityReview.ts` não está no registry) | pode ficar no main (escrita pequena) ou virar módulo do worker; **não é o gargalo** |
| `cleanupReviewArtifact` (`unlinkSync`) | `function cleanupReviewArtifact(watch)` (:400) | apaga o patch privado | não | fica no main (barato) |
| `appendFileSync` / `unlinkSync` / `readFileSync` / `existsSync` | **nenhum dentro de `advancePhaseInner`** — todos vivem no poller (`tickPhaseWatches`, :3956-4059) e no `report.ts` | — | — | fora do escopo do lock |

**Achado importante sobre `gitOff`**: não existe "registry" a manter à mão. O
worker faz `const registry: Record<string, unknown> = { ...worktree, ...reviewDiff, ...workspaceSkills, ...skillPackageSecurity }`
(`gitWorker.ts:27`) e o tipo do `gitOff` é
`type GitApi = typeof worktreeApi & typeof reviewDiffApi & ...` (`gitAsync.ts:16`).
**Qualquer função exportada de `worktree.ts` já é chamável por `gitOff` sem
mudança nenhuma no worker.** Só `reviewArtifactProblem` (que vive no closure)
exigiria extração para um dos quatro módulos.

Bônus de robustez que o plano herda de graça: `gitAsync.ts` tem
**fallback síncrono** (`function loadSyncFallback(): Promise<GitApi>`, :32) —
se o worker não subir, a chamada roda no main e o comportamento é idêntico ao
de hoje, nunca pior.

### 1.5 Mutações em ordem, e as janelas que o lock precisa preservar

Resumo operacional (ordem de execução real, por ramo). "**⟂**" marca uma
chamada git/fs síncrona; tudo entre um **⟂** e a gravação seguinte é uma
janela de atomicidade.

```
DEV:      ⟂G×4 ─────────────────────────────────► tasks.update(⟂G) ► accept ► publish ► emitLog
                                                    ▲ janela 1 (a maior)
          ⟂G(base) ⟂G(changed) ──► [empty-delivery: terminate ► update ► publish ► ui ► sync]
          ... ► reapVisuals ► terminateHelpers ► terminatePane ► void openGatePane|finalizeTask

GATE:     ⟂G(fingerprint) ⟂G(snapshotProblem) ⟂FS(artifact) ⟂G(head) ⟂FS(quarantine)
          [⟂G(fingerprint) ⟂G(snapshotProblem) se quarentenou]
          ► readonly ► [⟂FS persistSecurityReview] ► recordGate(update|updateMany) ► ...
            ▲──────────────── janela 2: da 1ª leitura de fotografia até o commit ────────────▲
```

- **Janela 1 (dev)**: `snapshotStillExact` → `tasks.update`. Entre elas há
  apenas leituras e dois `⟂G` de base/diff. **Precisa** ficar dentro do lock;
  idealmente sem `await` entre a **última** verificação e o `update` (basta
  reordenar: fazer TODO o git numa viagem só, e então gravar).
- **Janela 2 (gate)**: `finalFingerprint` → `recordGate`. É a maior e a mais
  sensível: o valor de `readonly` depende de `baselineFingerprint`,
  `finalFingerprint`, `snapshotProblem` e `artifactProblem` — quatro
  observações do disco que hoje são feitas no mesmo tick e comparadas no
  mesmo tick.
- **Fora das janelas** (podem ficar depois de qualquer `await`, mas dentro do
  lock por higiene): `hub.publish`, `emitLog`, `blackbox.record`,
  `uiSender.send`, `syncBoard`.

### 1.6 Chamadas downstream — sync/async, awaited/void, e se precisam do lock

| Função | Def | Hoje | Disparada como | Toca git? | Toca `phaseWatches`? | Toca `liveGateWaits`? | Dentro ou fora do lock? |
|---|---|---|---|---|---|---|---|
| `retryOrBacklog` | `async function retryOrBacklog(watch: PhaseWatch, who: string, motivo: string)` (:1914) | **async** | `void` — 2 sites diretos (`void retryOrBacklog(watch` ×2: :3709, :3791) + 1 multilinha no `openGatePane` (:2851) | **sim**, indiretamente: `preparePhasePane` (×4 awaits: :1980, :2084, :2124, :2153) + `unlinkSync(marker)` (:2018) | **sim**: `delete` :1973/:2077/:2118, `set` :2052 | lê em :1930, fecha via `closeLiveGateWait` :1942 | **DENTRO** (ou na cauda da mesma fila). Ela **re-registra** o watch dev do mesmo card — isso é uma transição. Não chama `advancePhase`, então pode ser `await`ada dentro de um lock não-reentrante sem deadlock |
| `finalizeTask` | `async function finalizeTask(watch: PhaseWatch, task: Task, approvedBy: string)` (:2450) | **async** | `void` — 3 sites (`void finalizeTask(watch` ×3: :2446 no `recoverFinalizingTask`, :3816, :3834; + o multilinha :3406) | **muito**: `gitVisibleWorktreeFingerprint` sync :2528, `await taskSnapshotProblem` :2529, `gitHead` :2565/:2576/:2599, `currentBranch` :2578, `await gitOff('gitVisibleWorktreeFingerprint')` :2581, `await gitOffWithCheckpoint('mergeTaskWorktree')` :2654 | **não** (nenhuma referência em :2450-2797) | `liveGateWaits.delete(watch.taskId)` :2451 | **FORA** é aceitável (não mexe em `phaseWatches`), mas o merge é longo e mata todos os panes do card — recomendo **dentro**, para o card não aceitar outro report enquanto integra |
| `openGatePane` | `async function openGatePane(watch: PhaseWatch, phase: 'review' \| 'qa'): Promise<boolean>` (:2798) | **async** | `void` — 2 sites (`void openGatePane(watch` ×2: :3404, :3827) | sim: `await gitOff('immutableReviewRangeValid')` :2912, `gitOff('immutableReviewDiff')` :2925, `gitOff('immutableReviewChangedPaths')` :2959, `gitOff('gitVisibleWorktreeFingerprint')` :2979, `await preparePhasePane` :3079 | **sim, muito**: `delete` :2868/:2919/:2944/:2966/:3074, `set` :2985 | `get` :2822, `delete` :2867/:2872/:3076 | **problema de desenho**: é a *próxima* transição do card. Se o lock for por card e ela for `await`ada dentro, ok (ela não chama `advancePhase`); mas ela **chama a si mesma recursivamente** (`return openGatePane(watch, phase)` — **4 ocorrências**: :2870, :2922, :2947, :2969) e chama `retryOrBacklog` (:2851). Recomendo **dentro do mesmo lock, awaitada**, com o lock declarado *reentrante por token* ou com o caminho recursivo saindo por continuação |
| `openPhasePane` | `function openPhasePane(watchSpec: DevPaneSpec, projectId: string, taskId: string): void` (:1706) | **sync** | chamada direta | não | não | não | indiferente; só `uiSender.send('panes:open')` + `hub.publish` |
| `closePhasePane` | `function closePhasePane(projectId: string, taskId: string, role: RunPhase): void` (:1721) | **sync** | direta | não | não | não | indiferente (`uiSender.send('panes:close')`) |
| `terminateTaskPhasePane` | `function terminateTaskPhasePane(` (:451) | **sync** | direta | não | não | não (mas chama `stopQaRuntime`) | **dentro** — é parte do fechamento atômico do gate |
| `terminateTaskHelpers` | `function terminateTaskHelpers(projectId: string, taskId: string, reason: string): void` (`paneLifecycle.ts:575`) | **sync** | direta | não | não | não | **dentro** — o "congelar a entrega" precisa preceder o snapshot dos gates |
| `preparePhasePane` | `async function preparePhasePane(` (:514) | async | via os três acima | sim (worktree, skills, prompts) | `has` :570, `set` :1104, `delete` :1126/:1484/:1520, `get` :1473/:1618 | não | já tem guard próprio (`phaseLaunches.reserve`) — **modelo para o lock**, ver §6 |

**Detalhe crítico do `terminatePaneNow`** (`paneLifecycle.ts:548`): ele chama
`unregisterPane(paneId)` **antes** de `ptys.kill(paneId)`. Por isso o `onExit`
do PTY (`ipc/pty.ts`, âncora `const identity = unregisterPane(req.id)` seguido
de `if (!identity) return`) vira no-op para panes mortos por
`terminateTaskPhasePane`. Isso **desarma** boa parte do risco de reentrância
por evento de PTY durante os `await`s — mas **não** para o `finalizeTask`, que
mata panes com `ptys.kill(pane.paneId)` **sem** desregistrar antes (:2465).

### 1.7 O valor booleano de retorno

`true` = "o pipeline avançou (ou foi deliberadamente encerrado neste passo)";
`false` = "nada avançou e o watch foi devolvido à indexação".

**Todos** os `return false` de `advancePhaseInner` — e são exatamente cinco
além do trivial — re-indexam o watch antes de sair:

| Ramo | Âncora | Re-indexa? |
|---|---|---|
| card sumiu | `const task = tasks.get(watch.taskId)` + `if (!task) return false` (:3146-3147) | **não** (por desenho: o card não existe mais) |
| ajudante aberto | `conclusão bloqueada: ainda existe ajudante aberto neste card` (:3186) | sim |
| drift de fotografia | `a fotografia mudou depois dos diagnósticos` (:3216) | sim |
| non_code executável | `a fotografia non_code não pôde ser provada` (:3289) | sim |
| projeto sumiu (securityReview) | bloco `if (!project) {` com indentação de 6 espaços — âncora `      if (!project) {` (única, :3529); fica dentro de `if (securityReview) {` (âncora única) e imediatamente antes de `persistSecurityReview(project.path, securityReview)` | sim |
| falha ao gravar securityReview | `report preservado: não foi possível gravar a evidência sanitizada` (:3540) | sim |

**Invariante que a conversão não pode quebrar**: *quem devolve `false`
re-indexa o watch* — porque o `report.ts` **não** re-indexa no caminho `false`
(só no `catch`). Se um `return false` novo aparecer sem `phaseWatches.set`, o
card fica órfão e o report seguinte responde "sua rodada já FECHOU".

Consumidores:

1. `mcpApi/report.ts:439` — `const advanced = ctx.phase.advancePhase(` (caminho
   `boundArtifactProblem`): `true` → `veredito invalidado antes de consumir receipts: <problema>`;
   `false` → `artefato imutável inválido e pipeline preservado: <problema>`.
   Na prática esse caminho sempre devolve `true`, porque o `artifactProblem`
   entra em `snapshotProblem`, derruba `readonly` e cai no desfecho (a).
2. `mcpApi/report.ts:748` — `advanced = ctx.phase.advancePhase(` (caminho
   principal): `true` → `report recebido — o pipeline avançou`; `false` →
   `conclusão preservada: o pipeline não avançou; confira o aviso do Synkora, reconcilie ajudantes/arquivos/diagnósticos e reporte done novamente`.
3. `phaseEngine.ts:4061` — `advancePhase(watch, content)` no poller de
   marcadores: **retorno ignorado**. Como o marcador já foi apagado (`unlinkSync`
   logo acima, dentro do bloco iniciado por `phaseWatches.detach(taskId)` :4060),
   um `false` aqui deixa o card parado até o dev escrever outro `.done`.
4. `index.ts:3462` — `advancePhase: (...args) => advancePhase(...args)` — só
   delegação para o `MainContext`.

---

## 2. A transação do report (`mcpApi/report.ts`)

**Fato central para o plano: o arquivo inteiro não tem um único `await` nem uma
única função `async`.** (`grep -n "await\|async " mcpApi/report.ts` → zero
resultados.) O `report` é uma função síncrona de ponta a ponta, do
`content = redactSensitiveText(content)` (:140) até o `return` final.

### 2.1 Onde começa e termina o segmento sync-atômico HOJE

O handler MCP é async (`mcpServer.ts`, âncora `server.registerTool(` seguido de
`'report',` — a definição começa em :798) e faz, **nesta ordem**:

1. validações puras de `status`/`reason`/`verificationEvidence`
   (:846-869) — sem I/O;
2. **`const blocked = await api.codeReportGuard(identity)`** (:871) — o único
   `await` antes do report; é aqui que a fotografia do dev é tirada e os
   diagnósticos LSP rodam;
3. `await api.report(...)` (:876) — e como `api.report` é sync hoje, **todo o
   corpo do report + todo o `advancePhase` executam num único tick**, a partir
   deste ponto.

O tipo já é permissivo: `McpApi.report` (`mcpServer.ts:233-241`) declara
`=> string | Promise<string>`, e `buildReportApi` devolve
`Pick<McpApi, 'readReviewEvidence' | 'report'>`. **Tornar o report async não
quebra o tipo nem o call site** — `text(await api.report(...))` já espera.

O proxy de instrumentação também já é async-safe: `index.ts:6011`
(`mainStalls.wrap(\`mcp:${String(prop)}\``) seguido de
`if (result instanceof Promise) {` :6014, que registra no `then`/`catch`.

### 2.2 Call site A — o caminho `boundArtifactProblem` (:431-448)

```
const boundArtifactProblem = blockedReport ? undefined : ctx.phase.reviewArtifactProblem(watch)   // :431
if (boundArtifactProblem) {
  phaseWatches.detach(watch.taskId)          // :433
  try { unlinkSync(watch.marker) } catch {}  // :435
  const advanced = ctx.phase.advancePhase(watch, content, undefined, sanitizedVerificationEvidence)  // :439
  return advanced ? '…invalidado antes de consumir receipts…' : '…pipeline preservado…'
}
```

Sequência: **detach → unlink marker → advancePhase → return**.
**Não há rollback** (`phaseWatches.set`) neste caminho — nem no `false`, nem em
`throw` (não há `try/catch` em volta do `advancePhase` aqui). Um `throw` de
`recordGate` aqui **perde o watch**. É um buraco pré-existente que a conversão
async torna mais provável de ser exercitado (mais tempo em voo).

O que já rodou antes deste ponto no handler síncrono: sanitização, guards de
role/fase/pane (`watch.phase !== id.phase`, `watch.paneId !== id.paneId`),
validação de `verificationEvidence`, `skillPlanScopes.get(id.paneId)`, e o
guard de `reviewArtifact.servedUntil === 0`.

### 2.3 Call site B — a transação principal (:693-764)

```
phaseWatches.detach(watch.taskId)             // :693   ← início da transação
try { unlinkSync(watch.marker) } catch {}     // :695
… patch sugerido → writeFileSync em .synkora/reports/…-fixes-rN.diff (:715-739)
const acceptance = prepareSkillUsageAcceptance()   // :741
if (!acceptance) { phaseWatches.set(watch.taskId, watch); return '…ledger…' }   // :743  ← rollback 1
let advanced = false                          // :746
try {
  advanced = ctx.phase.advancePhase(watch, content(+patchNote), normalizedSecurityReview,
                                    sanitizedVerificationEvidence, acceptance)   // :748
} catch (error) {
  phaseWatches.set(watch.taskId, watch)       // :759  ← rollback 2
  return 'report preservado: não foi possível persistir a transação da fase (…)'
}
return advanced ? 'report recebido — o pipeline avançou'
                : 'conclusão preservada: o pipeline não avançou; …'
```

O que roda **antes** do detach, ainda no mesmo tick síncrono (e que portanto
hoje é indistinguível do resto, mas na versão async passa a ser "pré-lock"):

`ensureProjectRuntimeWritable` (:509) · os dois blocos `bloqueada` (:520-620) ·
o bloco de `securityReview` do review (:621-670: `assessMissionRisk`,
`requiresManualSecurityValidation`, `normalizeSecurityReview`,
`validateSecurityReview`) · o guard de ajudante aberto (:671-681) ·
`appendFileSync` do summary no transcript (:682-692).

### 2.4 As outras saídas antecipadas que mexem no estado do card

| Caminho | Âncora | O que faz | Chama `advancePhase`? |
|---|---|---|---|
| helper (`role === 'ajudante'`) | `return 'reportado — quando o pane terminar de imprimir` (:323) | `skillRuntime.guardReport/acceptReport`, `helperCompletions.report`, agenda `announce()` por `setTimeout` (tick de 1s até `ptys.isIdle`, teto 90s) | não |
| gate de integração de missão | `handleMissionVerdict(watch, content)` (:350) | `missionWatches.delete` → `unlinkSync(marker)` → `appendFileSync` → `handleMissionVerdict` | não (caminho de missão) |
| gate `bloqueada` | `event: 'gate-blocked-environment'` (:548) | **`phaseWatches.delete`** + `terminateTaskPhasePane` + `tasks.update` + `stopQaRuntime` + `liveGateWaits.delete` | não |
| dev de UI `bloqueada` | `event: 'dev-ui-blocked-environment'` (:597) | `phaseWatches.delete` + `terminateTaskPhasePane` + `tasks.update` | não |
| ledger de skills divergente | `report recucado`… (âncora exata: `o ledger persistido desta rodada não corresponde ao plano ativo`, :744) | rollback do watch | não |

**`detach` × `delete`**: `phaseWatches` é um `PhaseWatchRegistry`
(`class PhaseWatchRegistry extends Map<string, PhaseWatch> {`, :423) cujo
`delete()` **apaga o artefato de review** (`cleanupReviewArtifact`) e cujo
`set()` apaga o artefato do watch **anterior** se o `privatePath` mudou.
`detach()` (:443) remove só a indexação. Os `bloqueada` usam `delete` (fim de
rodada), o report usa `detach` (transação). Existem exatamente **3**
`phaseWatches.detach` em todo o `src`: `report.ts:433`, `report.ts:693`,
`phaseEngine.ts:4060`.

---

## 3. `mainStalls.wrap` — a atribuição de stall sobrevive à conversão

`stallAttribution.ts`, âncora `wrap<T>(kind: string, detail: string | undefined, fn: () => T): T {` (:72):

```
const end = this.begin(kind, detail)
let result: T
try { result = fn() } catch (err) { end(); throw err }
if (result instanceof Promise) { return result.finally(end) as T }   // ← :81-83
end()
return result
```

**Já existe variante async — é a mesma função.** `wrap` detecta a Promise e
fecha a operação no `settle` (sucesso ou rejeição). O comentário do próprio
método diz: *"Envolve fn (sync OU async)"*.

Consequência prática: o wrapper de `advancePhase` **não precisa mudar de
forma**; basta que o `advancePhaseInner` devolva `Promise<boolean>` e o `wrap`
passará a medir a duração completa da transição async (que é o que se quer
medir depois da Fase 2 — o tempo de espera do worker deixa de ser stall do main
e vira duração de operação, ainda atribuída).

Os cinco pontos que hoje usam `wrap` (`grep -n "mainStalls.wrap"`):
`index.ts:5400` (`syncBoard`), `index.ts:6011` (`mcp:<tool>`),
`index.ts:6614/6615/6627` (boot), `phaseEngine.ts:525`
(`preparePhasePane:${phase}` — **já async e já funciona**),
`phaseEngine.ts:3132` (`advancePhase:${watch.phase}`) e
`missionEngine.ts:1866` (`completeMissionMerge`). O padrão
**wrapper→Inner** de `preparePhasePane` é a prova viva de que a conversão
mantém a atribuição: ele devolve `Promise` e a métrica funciona.

Se o lock for introduzido, recomendo **medir o lock separadamente** (ex.:
`mainStalls.begin('advancePhase:lock-wait', taskId8)` fechando na aquisição) —
senão espera de fila vira "duração de advancePhase" e polui o ranking.

---

## 4. `taskSnapshotProblem` (async) × `snapshotProblemFor` (sync)

As duas convivem **de propósito** desde o fix de 2026-08-05.

**A função pura** — `worktree.ts:92`, âncora `export function snapshotProblemFor(`.
Faz cinco checagens numa passada: (1) fotografia completa? (2) base
imutável/ancestral (`gitMergeBase`)? (3) `gitHead` bate? (4) `gitTree` bate?
(5) `isWorktreeClean` — e, se sujo, **nomeia os culpados** com
`git status --porcelain` (6 primeiros, CHECK 16); (6)
`gitVisibleWorktreeFingerprint` bate? Devolve string PT-BR (o texto **vai para
o veredito do usuário**) ou `undefined`.

**O wrapper async** — `phaseEngine.ts:471`, âncora
`async function taskSnapshotProblem`, precedido do comentário-âncora
`(fonte única): aqui viajam ao worker numa chamada só; advancePhase — sync`.
Corpo: `return gitOff('snapshotProblemFor', cwd, {head, tree, fingerprint, baseHead}, task.deliverable === 'code')`.
Recebe `Task`, extrai `verification.dev` e manda **dados puros** (nada de
`Task` viaja pelo `postMessage`).

### Call sites — todos, com o porquê

| Variante | Call site | Âncora | Por que esta variante |
|---|---|---|---|
| **async** | `preparePhasePane`, abertura de gate de código | `const snapshotProblem = await taskSnapshotProblem(task, cwd)` (:795) | contexto já async; é o caminho que o fix criou. Falha → `returnTaskToDevForSnapshotDrift(task, snapshotProblem)` |
| **async** | `finalizeTask`, antes do merge | `const snapshotProblem = await taskSnapshotProblem(latestTask, watch.cwd)` (:2529) | contexto já async |
| **sync** | `advancePhaseInner`, veredito do gate | `? snapshotProblemFor(watch.cwd, snapFacts, latestForSnapshot.deliverable === 'code')` (:3436) | **a barreira** — comentário-âncora imediatamente acima |
| **sync** | `advancePhaseInner`, revalidação pós-quarentena | `snapshotProblem = snapshotProblemFor(` (:3468) | mesmo motivo |

**Nota de precisão em relação ao briefing desta varredura**: o segundo call
site async **não** é o reciclo de gate vivo — é o `finalizeTask`. O reciclo de
gate vivo (dentro de `openGatePane`, bloco `const wait = liveGateWaits.get(watch.taskId)`,
:2822) **não** chama `taskSnapshotProblem`; ele usa outras funções do worker:
`await gitOff('immutableReviewRangeValid', ...)` (:2912),
`await gitOff('immutableReviewDiff', ...)` (:2925),
`await gitOff('immutableReviewChangedPaths', ...)` (:2959) e
`await gitOff('gitVisibleWorktreeFingerprint', watch.cwd)` (:2979).

**Veredito da Fase 2 para este item**: os dois `snapshotProblemFor` síncronos
de `advancePhaseInner` são **exatamente** o que a conversão deve trocar por
`await taskSnapshotProblem(...)` / `await gitOff('snapshotProblemFor', ...)`. A
função pura **continua existindo** (é o corpo que roda no worker) e o
comentário-âncora de :3424-3427 **precisa ser reescrito**, não apagado: a nova
verdade é "a atomicidade vem do lock de transição, não da sincronicidade" — e a
cicatriz do `[object Promise]` deve continuar citada, porque o modo de falha
(Promise tratada como string de problema) permanece possível a cada `await`
esquecido.

---

## 5. RISCOS

### R1 — Duas transições do mesmo card (o risco central; parcialmente já coberto)

A boa notícia: `phaseWatches.detach(watch.taskId)` acontece **antes** de
qualquer `await` no `report.ts` (:693) e nada o desfaz até o desfecho. Um
segundo `report` do mesmo card cai em `const watch = id.taskId ? phaseWatches.get(id.taskId) : undefined`
seguido de `if (!watch)` e recebe
`sua rodada já FECHOU (o veredito foi processado)`. **Esse guard já é um lock
grosseiro e sobrevive à conversão**, desde que o `detach` continue sync-antes.

A má notícia: ele **não** cobre
1. o **poller de marcadores** (`tickPhaseWatches`, :3847): ele lê
   `phaseWatches` a cada 3s e o watch desapareceu — ok; mas o guard próprio dele
   é o `Set` local `const phaseMarkersProcessing = new Set<string>()` (:3841),
   que é **por task e por caminho de marcador**, não compartilhado com o report;
2. o **`codeReportGuard`**, que roda `await` **antes** do detach e pode
   `phaseWatches.set(id.taskId, {` (`mcpApi/code.ts:141`, re-entrega
   sancionada) — dois devs reportando quase juntos podem ver estados
   diferentes;
3. `openGatePane` e `retryOrBacklog`, que **re-registram** o watch depois de
   seus próprios `await`s (`phaseWatches.set` em :2985 e :2052). Hoje esses
   `set` só acontecem **depois** que `advancePhase` retornou; com
   `advancePhase` async, um `void openGatePane(...)` disparado por um veredito
   pode aterrissar seu `set` **enquanto** outra transição do mesmo card ainda
   está em voo.

**Consequência para o desenho**: o lock precisa ser por `taskId` e precisa
cobrir também `openGatePane`, `retryOrBacklog`, os dois blocos `bloqueada` do
`report.ts` e o ramo de marcador do poller.

### R2 — `phaseWatches.set` de rollback pode destruir o artefato da rodada nova

`PhaseWatchRegistry.set` (:424-433) chama `cleanupReviewArtifact(previous)`
quando o `privatePath` do watch anterior difere do novo. Hoje o rollback
(`report.ts:743`, `:759` e os cinco de `advancePhaseInner`) roda no mesmo tick,
então "anterior" é sempre vazio. Em modo async, se `openGatePane` já tiver
registrado o watch da rodada seguinte e então um rollback tardio fizer
`phaseWatches.set(watch.taskId, watchVELHO)`, o `set` **apaga o patch privado
da rodada nova** e o reviewer novo perde a evidência. Teste obrigatório.

### R3 — O objeto `watch` é compartilhado e mutável

`advancePhaseInner` muta o objeto in loco: `watch.devSnapshot = undefined`
(:3211 e :3284). O mesmo objeto está referenciado por: `report.ts` (para o
rollback), pelo `phaseWatches` do poller, e por `codeReportGuard`
(`watch.devSnapshot = preparedSnapshot`, `code.ts:195/:223`). Hoje nenhuma
dessas mutações se cruza porque o segmento é atômico. Em async, um
`watch.devSnapshot = undefined` tardio pode invalidar a fotografia de uma
re-entrega que já foi aceita. O lock resolve **se** cobrir o `codeReportGuard`;
alternativa mais barata: passar a tratar `PhaseWatch` como **imutável** dentro
do veredito (clonar antes de mutar), o que já é o padrão de `openGatePane`
(`phaseWatches.set(watch.taskId, { ...watch, phase, … })`, :2985).

### R4 — `latestForSnapshot` fica velho depois de um `await`

`const latestForSnapshot = tasks.get(watch.taskId) ?? task` (:3423) é lido
**antes** das checagens de fotografia; `recordGate` relê (`const latest = tasks.get(watch.taskId)`),
e há mais duas releituras em pontos distintos (`gateNotesAtRejection`
:3760-3762 e `const qaEvidence = (tasks.get(watch.taskId) ?? task).verification?.qa`
:3796). Hoje as quatro leituras veem **a mesma fotografia**, porque nada grava
entre elas. Com `await`s, cada leitura pode ver um card diferente (o
`ipc/pty.ts` grava `phaseSessions` no `onExit`, o `retryOrBacklog` do gate
anterior grava `cycles`, o `preparePhasePane` grava `phaseState`…).

**Recomendação**: reler o card **uma vez** logo após o último `await` de git e
usar essa fotografia até o commit — nunca reler no meio do bloco de decisão.

### R5 — Reentrância por evento (hub → injeção → nova tool)

`hub.publish` (`hub.ts:215`) é síncrono: escreve `EVENTS.md`, chama
`deps.onEvent` (UI) e enfileira/injeta no pane do orquestrador. A injeção
**não** vira uma chamada de tool no mesmo tick — o `HubDeps.inject`
(`index.ts:3220`) posta no correio MCP (`mailbox.post`) e faz `nudgeMailbox`,
e o `drain()` roda em `setInterval(() => this.drain(), DRAIN_MS)` (`hub.ts:163`).
**Não existe reentrância síncrona.** Porém: uma tool MCP do orquestrador
(`notify_pane`, `run_task`, `update_task`, `delete_task`) chega por HTTP e vira
uma task do event loop — que **pode** ser processada durante um `await` do
`advancePhase`. Hoje isso é impossível. `run_task {phase}` em particular chama
`preparePhasePane`/`openGatePane` e mexe em `phaseWatches`.

### R6 — Evento `onExit` do PTY durante um `await`

`ipc/pty.ts` (âncora `const gateWait = ctx.liveGateWaits.get(identity.taskId)`,
:589) faz, no exit de um pane de fase: `liveGateWaits.delete` +
`phaseWatches.delete` + `tasks.update` + `recordGateDeath` + `hub.publish`.
Mitigação existente: `terminatePaneNow` desregistra a identidade **antes** do
kill, então esse handler vira no-op para panes que o próprio veredito matou
(`if (!identity) return`). **Mas** `finalizeTask` mata panes com
`ptys.kill(pane.paneId)` sem desregistrar (:2465) — e nesse caso o handler
roda com identidade e pode `tasks.update` o card durante o merge. Com
`advancePhase` async e `finalizeTask` disparado por `void`, as duas coisas
passam a poder se sobrepor a uma transição em voo.

### R7 — Falha parcial já existente que o async agrava

No desfecho **(a) `!readonly`**, a ordem é
`cleanupReviewArtifact` → `terminateTaskPhasePane` → `liveGateWaits.delete` →
**`recordGate` (que pode `throw`)**. O `report.ts` reage ao `throw` com
`phaseWatches.set(watch.taskId, watch)` e responde
`report preservado: … tente novamente` — mas o artefato **já foi apagado** e o
pane do gate **já foi morto**. O "report repetível" prometido no comentário do
`catch` (âncora `TaskStore só publica a nova fotografia depois de o JSON atômico`,
`report.ts:756`) não é verdade nesse ramo. A conversão não cria o problema, mas **multiplica a
superfície** (mais tempo entre o efeito colateral e o commit). Vale corrigir na
mesma cirurgia: mover `cleanupReviewArtifact`/`terminate*` para **depois** do
commit em todos os cinco desfechos (hoje só o desfecho (c) já o faz —
`recordGate` na :3764 vem **antes** do `cleanupReviewArtifact` da :3765).

### R8 — Duas gravações consecutivas do mesmo card no desfecho (b)

`recordGate('invalid', …)` (:3724) seguido de `tasks.update(watch.taskId, {…})`
(:3725) — dois `commit()` do `TaskStore`, dois `persistJsonStore`, dois
`onMutation`. Se um `await` for introduzido entre eles, existe um estado
persistido intermediário observável (veredito inválido gravado, feedback
ainda não). Manter as duas colapsadas num único patch é a correção limpa.

### R9 — O fallback síncrono do `gitOff` reintroduz o main thread

`gitAsync.ts:32` (`function loadSyncFallback(): Promise<GitApi>`) e
`gitAsync.ts:78-83` (`workerBroken = true`). Se o worker não subir, **toda** a
Fase 2 vira "as mesmas chamadas síncronas, agora atrás de `await`" — correto
funcionalmente, mas sem ganho de stall e com o lock em cima. Não é um bug; é um
fato a declarar no plano (e um bom motivo para o teste de corrida rodar também
com o worker forçado a `workerBroken`).

### R10 — Multiplicação de viagens ao worker

Hoje o ramo de gate faz **até 6** chamadas git síncronas
(`gitVisibleWorktreeFingerprint` ×3 no pior caso, `snapshotProblemFor` ×2,
`gitHead` ×1) e o ramo dev faz **até 7**. Convertidas 1:1, isso vira 6-7
round-trips de `postMessage` **serializados no worker único** — e o worker é
compartilhado com spawn de fase, skills e merges. Se o objetivo é matar o stall
de 1,2-2,1s, converter sem **consolidar** pode trocar um stall por uma latência
de fila.

Recomendação: criar **uma** função de worker que devolva o pacote inteiro do
veredito (fingerprint + `snapshotProblem` + `gitHead`), num único
`gitOff('gateVerdictFacts', cwd, snapFacts, requireBase)` novo em `worktree.ts`
— é o mesmo padrão que já justificou o `snapshotProblemFor` ("uma viagem ao
worker em vez de cinco", comentário de `worktree.ts:86-91`). E a quarentena,
quando dispara, precisa de uma segunda viagem só para revalidar.

### R11 — `reviewArtifactProblem` continua no main

É o único I/O pesado do caminho do veredito que **não** tem caminho para o
worker (vive no closure do `phaseEngine`, depende de `app.getPath('userData')`).
Para patches grandes (o motivo de o artefato existir é justamente o review de
~120k), o sha256 pode custar mais que o git. Se ficar no main, o stall
sobrevive à Fase 2. Extraí-lo para um módulo puro (`reviewEvidence.ts` já é
importado pelo `phaseEngine` e não toca electron) o torna elegível ao registry
por spread — **sem** mudança no `gitWorker.ts`.

### R12 — Ordem `detach` × lock

O `phaseWatches.detach` (`report.ts:693`) precisa continuar acontecendo
**antes** da aquisição do lock ou **dentro** dela — mas nunca depois de um
`await` de aquisição, senão dois reports concorrentes ambos passam pelo
`if (!watch)`, ambos detacham (o segundo no vazio) e ambos avançam. Como o
`detach` é sync e o `Map.get` também, manter a sequência
`get → guards → detach → acquire → …` preserva o comportamento atual.

### R13 — Testes de corrida obrigatórios (o plano já pede; aqui vai o roteiro concreto)

1. dois `report` do mesmo card no mesmo tick (segundo deve receber
   `sua rodada já FECHOU`);
2. `report` de gate + `run_task {phase}` do orquestrador chegando durante o
   `await` de git;
3. `report` de gate + `onExit` do pane do gate durante o `await`
   (`recordGateDeath` não pode contar morte de pane morto pelo próprio
   veredito);
4. `report` de dev + poller de marcador `.done` no mesmo card;
5. veredito × `codeReportGuard` de re-entrega sancionada no mesmo card;
6. veredito com `throw` forçado no `recordGate` — conferir que o watch volta
   **e** que o artefato/pane não foram destruídos antes;
7. rodada nova de gate (`openGatePane` reciclando o pane vivo) começando
   enquanto o veredito anterior ainda tem `await` pendente — conferir R2;
8. tudo acima com `gitAsync` forçado ao fallback síncrono (R9).

---

## 6. Peças que já existem e servem de molde ao lock

- **`PhaseLaunchGuard`** (`phaseLaunchGuard.ts:14`) — o comentário do módulo
  descreve exatamente o problema da Fase 2: *"Serializa o trecho assíncrono que
  prepara uma fase para a mesma task. `reserve` é intencionalmente síncrono: a
  reserva entra no Map antes que o chamador alcance seu primeiro `await`,
  fechando a janela para dois panes."* API: `reserve(taskId): PhaseLaunchToken | undefined`
  (Symbol como prova de dono), `owns`, `release`. É um **mutex try-lock**, não
  uma fila: quem não consegue reservar **desiste** (`if (!launchToken) return`).
- Para a Fase 2 o plano pede uma **fila** (taskId→Promise), não um try-lock:
  o segundo veredito do mesmo card não pode simplesmente sumir. Mas o
  `PhaseLaunchGuard` mostra o invariante que importa — **a reserva é síncrona,
  antes do primeiro `await`** — e o token opaco por Symbol dá o `release`
  seguro contra dono errado. Um `PhaseTransitionLock` novo, no mesmo arquivo
  ou irmão dele (regra do código limpo: módulo novo, ~80 linhas, suíte
  própria), é o encaixe natural.
- **`PhaseLaunchCapacityGuard`** (`phaseLaunchGuard.ts:51`) mostra o padrão de
  contar reservas pendentes que "o contador de watches ativos sozinho não
  enxerga… paradas em await" — a mesma cegueira vai valer para
  `[...phaseWatches.values()].filter(...)` durante uma transição em voo
  (`respawnInterruptedPhase`, :1850, faz exatamente essa contagem).
- **`preparePhasePane`** (:514) é o precedente vivo de wrapper→Inner async com
  `mainStalls.wrap` (:525) e guard de corrida — copiar a forma.

---

## 7. Resumo do veredito de conversibilidade

| Item | Veredito |
|---|---|
| Tipo `PhaseApi.advancePhase` | muda para `Promise<boolean>`; **3 comentários-âncora precisam ser reescritos**, não removidos |
| `McpApi.report` | **já** aceita `Promise<string>`; o handler MCP **já** faz `await` — zero mudança no `mcpServer.ts` |
| Proxy de instrumentação MCP (`index.ts:6011`) | **já** trata Promise |
| `mainStalls.wrap` | **já** trata Promise (`result.finally(end)`); medir a espera de lock em separado |
| Chamadas git do veredito | **todas** já elegíveis ao `gitOff` por spread de `worktree.ts` — **nenhuma entrada nova no `gitWorker.ts`**; recomendo **consolidar** numa função nova de `worktree.ts` (R10) |
| `reviewArtifactProblem` | **único** I/O pesado sem caminho para o worker — extrair para módulo puro ou aceitar que fica no main (R11) |
| `retryOrBacklog` / `openGatePane` | já async, hoje `void`-fired; **devem ser awaitadas dentro do lock** (ambas mutam `phaseWatches` do mesmo card) |
| `finalizeTask` | já async, `void`-fired; não toca `phaseWatches` — pode ficar fora, mas dentro é mais seguro |
| `openPhasePane` / `closePhasePane` / `terminateTaskPhasePane` / `terminateTaskHelpers` | sync, sem git, sem `phaseWatches` — ficam onde estão |
| `'bloqueada'` (2 blocos em `report.ts`) | **fora** de `advancePhase` hoje; **precisam entrar no lock** |
| Poller de marcador (`phaseEngine.ts:4061`) | `advancePhase(watch, content)` sem `await` e com retorno ignorado — **vira `await`** dentro do `void (async () => {…})` que já o envolve |
| Invariante a preservar | todo `return false` re-indexa o watch (exceto o caso "card sumiu"); `detach` sempre antes do primeiro `await` |
| Reordenação recomendada junto | commit **antes** dos efeitos destrutivos (artefato/pane) nos cinco desfechos (R7); colapsar as duas gravações do desfecho (b) (R8) |
