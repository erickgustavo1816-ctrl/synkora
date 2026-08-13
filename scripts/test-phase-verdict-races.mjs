// HARNESS DE CORRIDA DO VEREDITO — Fase 2 do nível 5 (docs/FASE2_PLANO.md §5.2).
//
// Roda o phaseEngine REAL (fecho de 65 módulos compilado por tsc --noCheck em
// .tmp/phase-verdict-races) em node cru, com DOIS stubs por Module._load:
// - 'electron': app.getPath → userData temporário por harness (precedente
//   test-store-atomicity.mjs);
// - './gitAsync': gate controlável — no baseline delega ao worktree.js real
//   (síncrono embrulhado em Promise); nos testes de corrida do F2-c5 é ele
//   que PAUSA o veredito em cada await para injetar o concorrente.
// O ctx é o MÍNIMO que o createPhaseEngine desestrutura na construção, com
// TaskStore REAL (jsonStore atômico — o commit da transação é o de produção)
// e fixture git REAL em tmpdir (precedente test-mission-worktree.mjs).
//
// F2-c2 = BASELINE dos fluxos ATUAIS: provou o harness antes de provar a
// mudança. Com o F2-c5 aplicado (advancePhase async sob o
// PhaseTransitionLock), os baselines seguem verdes e a MATRIZ DE CORRIDA do
// §5.3 do plano entra abaixo deles — cada caso PAUSA o veredito num await
// real (pauseGitTrip) e injeta o concorrente pela janela.
//
// Cobertura da matriz §5.3 nesta suíte (o que é alcançável pelo fecho
// compilado — que contém o phaseEngine e seus imports, NÃO o mcpApi/, o
// index.ts nem os ipc/):
//   1+2 · 5 · 6 · 7 · 9 · 10 · 11 · 13   → testes `matriz …` abaixo
//   12 (MAX_PARALLEL_RUNS conta locks)   → `c4: phaseOccupancy …`
//   6.1 do MAPA (bug latente da memoização) → `matriz 6.1 …`
//   3 (run_task recusado) · 4 (onExit do pane) · 8 (codeReportGuard)
//     → NÃO alcançáveis daqui: as recusas moram em mcpApi/board.ts,
//       mcpApi/code.ts e ipc/pty.ts, fora do fecho. Ficam para a suíte de
//       fluxo do orquestrador / validação ao vivo.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const COMPILED = join(import.meta.dirname, '..', '.tmp', 'phase-verdict-races')

// ——— stubs por Module._load (instalados ANTES de requerer o engine) ———
let activeUserData = mkdtempSync(join(tmpdir(), 'synkora-verdict-boot-'))
const electronStub = {
  app: {
    getPath: () => activeUserData,
    isPackaged: false,
    getName: () => 'synkora',
    // módulos do fecho registram will-quit/before-quit no require — no-ops
    on: () => electronStub.app,
    once: () => electronStub.app,
    off: () => electronStub.app,
    whenReady: () => Promise.resolve()
  },
  shell: { openExternal: () => {} }
}
// gate do gitAsync: beforeCall permite segurar QUALQUER viagem (F2-c5); no
// baseline é pass-through para as funções reais do worktree/reviewDiff.
const gitGate = { beforeCall: null }
let realGitApi = null
const gitAsyncStub = {
  GIT_CHECKPOINT_MARKER: '__SYNKORA_GIT_CHECKPOINT__',
  gitOff: async (fn, ...args) => {
    if (gitGate.beforeCall) await gitGate.beforeCall(fn, args)
    const target = realGitApi?.[fn]
    if (typeof target !== 'function') throw new Error(`gitOff stub: função desconhecida ${fn}`)
    return target(...args)
  },
  gitOffWithCheckpoint: async (fn, args, onCheckpoint) => {
    if (gitGate.beforeCall) await gitGate.beforeCall(fn, args)
    const target = realGitApi?.[fn]
    if (typeof target !== 'function') throw new Error(`gitOff stub: função desconhecida ${fn}`)
    const substituted = args.map((value) =>
      value === '__SYNKORA_GIT_CHECKPOINT__' ? onCheckpoint : substituteMarker(value, onCheckpoint)
    )
    return target(...substituted)
  }
}
function substituteMarker(value, bridge) {
  if (value === '__SYNKORA_GIT_CHECKPOINT__') return bridge
  if (Array.isArray(value)) return value.map((item) => substituteMarker(item, bridge))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = substituteMarker(item, bridge)
    return out
  }
  return value
}

const originalLoad = Module._load
Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === 'electron') return electronStub
  // skillsRouting usa a extensão .ts no runtime strip-types. Este harness
  // transpila o fecho para CommonJS, portanto liga o mesmo import ao .js
  // emitido sem alterar o caminho exigido pelo app real.
  if (
    request === './agentRouting.ts' &&
    parent?.filename?.includes('phase-verdict-races')
  ) {
    return originalLoad.call(this, join(COMPILED, 'agentRouting.js'), parent, isMain)
  }
  if (
    (request === './gitAsync' || request.endsWith('/gitAsync')) &&
    parent?.filename?.includes('phase-verdict-races')
  ) {
    return gitAsyncStub
  }
  return originalLoad.call(this, request, parent, isMain)
}

const { createPhaseEngine } = require(join(COMPILED, 'phaseEngine.js'))
const worktree = require(join(COMPILED, 'worktree.js'))
const reviewEvidence = require(join(COMPILED, 'reviewEvidence.js'))
const { TaskStore } = require(join(COMPILED, 'tasks.js'))
const { StallAttribution } = require(join(COMPILED, 'stallAttribution.js'))
// Espelha o registry REAL do gitWorker (gitWorker.ts:28 — spread de worktree +
// reviewEvidence, entre outros). Sem reviewEvidence aqui, o
// gitOff('reviewArtifactIdentity') do veredito (R11) cairia no ramo de erro do
// stub e TODO gate com artefato viraria "veredito invalidado" por acidente do
// harness — mascarando exatamente o que os casos 9 e 10 provam.
realGitApi = { ...worktree, ...reviewEvidence }

// rejeições órfãs das continuações `void` viram FALHA explícita do teste que
// as deixou para trás — nunca ruído silencioso.
const orphanRejections = []
process.on('unhandledRejection', (reason) => {
  orphanRejections.push(reason instanceof Error ? reason.message : String(reason))
})

const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))

// ——— injetor de corrida: PAUSA uma viagem do gitOff (F2-c5, §5.3) ———
// Segura a n-ésima chamada de `fn` (filtrada pelo cwd do fixture, para nunca
// pegar a continuação de outro teste) e devolve as alavancas. É o único ponto
// de injeção do harness: com o veredito parado NO await, o concorrente entra.
// SEMPRE registra o desarme no `t.after` — promessa pausada pendurada no fim
// do teste viraria rejeição órfã na sentinela.
function pauseGitTrip(t, fn, opts = {}) {
  const state = { intercepted: 0, paused: false, released: false }
  let openGate = () => {}
  const gatePromise = new Promise((resolve) => {
    openGate = resolve
  })
  const nth = opts.nth ?? 1
  gitGate.beforeCall = async (calledFn, args) => {
    if (calledFn !== fn) return
    if (opts.cwd && args[0] !== opts.cwd) return
    state.intercepted += 1
    if (state.intercepted !== nth) return
    state.paused = true
    await gatePromise
    state.paused = false
  }
  const restore = () => {
    gitGate.beforeCall = null
  }
  const release = () => {
    state.released = true
    openGate()
  }
  t.after(() => {
    restore()
    release()
  })
  return {
    state,
    restore,
    release,
    /** Espera o veredito ENTRAR no await pausado (nunca dormir um valor fixo). */
    async waitPaused(timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs
      while (!state.paused) {
        if (Date.now() > deadline) {
          throw new Error(`harness: a viagem ${fn} não pausou em ${timeoutMs}ms`)
        }
        await settle(10)
      }
    }
  }
}

// ——— artefato imutável de review REAL (R7/R2) ———
// O arquivo TEM que morar sob <userData>/review-evidence: o cleanup do engine
// só apaga por containment de path, e é essa contenção que os casos 9 e 10
// medem. O nome segue a convenção do materializeReviewDiffArtifact.
function makeReviewArtifact(userData, taskId, marca) {
  const dir = join(userData, 'review-evidence')
  mkdirSync(dir, { recursive: true })
  const privatePath = join(
    dir,
    `${taskId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)}-${randomUUID()}.review.patch`
  )
  const content = `diff --git a/app.txt b/app.txt\n+evidência ${marca}\n`
  writeFileSync(privatePath, content, 'utf-8')
  return {
    privatePath,
    sha256: createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex'),
    bytes: Buffer.byteLength(content, 'utf-8'),
    chunks: [],
    servedUntil: 1
  }
}

/** Captura o desfecho SEM deixar rejeição solta no ar entre a criação da
 *  promessa e o assert (a sentinela do fim do arquivo é implacável). */
function settledOutcome(promise) {
  return promise.then(
    (advanced) => ({ advanced }),
    (error) => ({ error })
  )
}

// ——— fixture git real ———
function gitFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-verdict-fixture-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe']
    })
      .toString()
      .trim()
  git('init', '-q')
  // A cerca .synkora do projeto REAL (preparePhasePane chama isto em todo
  // spawn): sem ela, qualquer arquivo de runtime que o próprio harness
  // escreve — SECURITY_POLICY.md da baseline, transcript, marcadores — entra
  // no `git status --untracked-files=all` e move o fingerprint, invalidando
  // fotografia de um card que nada tem a ver com aquela escrita (visto ao
  // vivo na matriz 13: a continuação de um card sujava o outro).
  worktree.ensureSynkoraGitExcludes(root)
  writeFileSync(join(root, 'app.txt'), 'base\n', 'utf-8')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  const baseHead = git('rev-parse', 'HEAD')
  writeFileSync(join(root, 'app.txt'), 'entrega\n', 'utf-8')
  git('add', '.')
  git('commit', '-q', '-m', 'entrega')
  const head = git('rev-parse', 'HEAD')
  const facts = {
    head,
    baseHead,
    tree: worktree.gitTree(root, head),
    fingerprint: worktree.gitVisibleWorktreeFingerprint(root)
  }
  return { root, git, facts }
}

// ——— harness: ctx mínimo + extras stubadas + engine real ———
function createHarness(t, fixture) {
  activeUserData = mkdtempSync(join(tmpdir(), 'synkora-verdict-userdata-'))
  const userData = activeUserData
  t.after(() => rmSync(userData, { recursive: true, force: true }))
  const events = { hub: [], logs: [], blackbox: [], notified: [], terminated: [] }
  const tasks = new TaskStore()
  const projectId = 'proj-1'
  const project = { id: projectId, path: fixture.root, name: 'Fixture' }
  mkdirSync(join(fixture.root, '.synkora', 'runs'), { recursive: true })
  const ctx = {
    tasks,
    seats: { get: () => undefined, list: () => [] },
    projects: { get: (id) => (id === projectId ? project : undefined), list: () => [project] },
    missions: { get: () => undefined, list: () => [] },
    ptys: {
      has: () => false,
      isIdle: () => true,
      kill: () => {},
      reapVisualsOf: () => {},
      inject: () => {},
      flushLogOf: () => {}
    },
    blackbox: { record: (e) => events.blackbox.push(e) },
    maestro: { get: () => ({}), getState: () => ({}) },
    policies: { get: () => undefined },
    skillsLib: {},
    mainStalls: new StallAttribution(),
    paneSessions: new Map(),
    emitLog: (_pid, line) => events.logs.push(line),
    syncBoard: () => {},
    ensureProjectRuntimeWritable: () => {},
    projectModeOf: () => 'leve',
    externalPlaywrightForPane: () => undefined,
    releasePaneSkillLease: () => {},
    orchPaneId: () => 'maestro-proj-1',
    hub: {
      publish: (e) => events.hub.push(e),
      notifyPane: (paneId, text) => {
        events.notified.push({ paneId, text })
        return 'queued'
      },
      notifyPaneNow: (paneId, text) => {
        events.notified.push({ paneId, text })
        return 'injected'
      },
      panesOf: () => [],
      unregisterPane: () => undefined
    },
    livePaneSpecs: new Map(),
    closingPaneIds: new Set(),
    uiSender: null,
    mainWindow: null,
    // Costura da Fase 3 (F3-c0): o engine empurra via ctx.push* em vez de
    // ctx.uiSender.send. uiSender null = sem renderer → push é no-op fiel.
    pushBoard: () => {},
    pushPanes: () => {},
    pushAll: () => {}
  }
  // O plano é MUTÁVEL de fora (caso 5, §7.8): a pausa do dono no MEIO do
  // veredito só vale como prova se o stub puder virar depois do 1º await.
  const planTaskRef = { current: undefined }
  const extras = {
    terminatePaneNow: (pid, paneId) => events.terminated.push(paneId),
    terminateTaskHelpers: () => {},
    discardUnstartedPane: () => {},
    planTaskForWorkTask: () => planTaskRef.current,
    retryLimitForTask: () => 1,
    executionModeForTask: () => 'standard',
    securityWaiverOptions: () => ({ sensitiveWaiverAllowed: true }),
    missionWorkspacePath: () => undefined,
    ensureMissionWorktree: () => undefined,
    timedTaskWorktree: async () => {
      throw new Error('harness: worktree de fase não faz parte do baseline')
    },
    prepareSkillPlanInputs: async () => ({ definitions: [], inputs: [], missing: [] }),
    syncPaneSkillLease: async () => ({ injected: [], missing: [] }),
    renewLivePaneSkillRun: async () => undefined,
    releasePaneSkillPlan: () => {},
    skillRuntime: {},
    skillPlanScopes: new Map(),
    storedHelperRecoveries: () => [],
    harnessPortsInUse: () => [],
    codexDeveloperInstructions: (value) => value,
    armPane: () => ({ paneId: 'pane-stub', cliArgs: [] }),
    // F2-c5b: contrato novo do guard — objeto { blocked?, devSnapshot? }
    codeReportGuard: async () => ({})
  }
  const engine = createPhaseEngine(ctx, extras)
  const createTask = (patch = {}) => {
    const [created] = tasks.createMany(projectId, [
      { title: 'Card de teste', department: 'back', effort: 'leve' }
    ])
    return tasks.update(created.id, {
      deliverable: 'code',
      status: 'execucao',
      activePhase: 'dev',
      phaseState: 'running',
      ...patch
    })
  }
  const watchFor = (task, phase, overrides = {}) => ({
    projectId,
    taskId: task.id,
    phase,
    devSeatId: 'seat-1',
    cwd: fixture.root,
    worktree: { dir: fixture.root, branch: 'mission/fixture' },
    logFile: join(fixture.root, '.synkora', 'runs', `${task.id}.md`),
    marker: join(
      fixture.root,
      '.synkora',
      'runs',
      phase === 'dev' ? `${task.id}.done` : `${task.id}.${phase}.verdict`
    ),
    createdAt: Date.now(),
    ...overrides
  })
  const acceptance = () => ({
    skillUsage: {
      phaseRun: 'run-1',
      runStatus: 'completed',
      updatedAt: new Date().toISOString(),
      skills: [],
      history: []
    },
    commitRuntime: () => true
  })
  // F2-c4: entra na transação como um entrante REAL — ordem sagrada
  // acquire → detach (o set arma o watch antes, como o preparePhasePane).
  const enterTransition = (task, watch, label = 'test:report') => {
    engine.phaseWatches.set(task.id, watch)
    const token = engine.phaseTransitions.acquire(task.id, { label, projectId })
    assert.ok(token, 'harness: acquire do entrante de teste falhou com o card livre')
    engine.phaseWatches.detach(task.id)
    return token
  }
  /** Pausa/retoma o plano DEPOIS que o veredito já entrou (leitura tardia). */
  const setPlanTask = (planTask) => {
    planTaskRef.current = planTask
  }
  const pausedPlan = (id = 'plan-fixture') => ({
    id,
    kind: 'plan',
    status: 'backlog',
    plan: { approvedAt: new Date().toISOString(), lanes: [] }
  })
  return {
    engine,
    ctx,
    tasks,
    events,
    projectId,
    userData,
    createTask,
    watchFor,
    acceptance,
    enterTransition,
    setPlanTask,
    pausedPlan
  }
}

// ——————————————————— BASELINE (fluxos atuais, sync) ———————————————————

test('baseline: dev done com gate review — transação persiste e retorna true', async (t) => {
  const fixture = gitFixture(t)
  const h = createHarness(t, fixture)
  const task = h.createTask({ gates: ['review'] })
  const watch = h.watchFor(task, 'dev', { devSnapshot: { ...fixture.facts } })
  const token = h.enterTransition(task, watch)
  // F2-c5: com o advancePhase AGUARDADO, a continuação (openGatePane) corre
  // antes dos asserts e no harness ela falha por design (ctx fake sem
  // worktree de fase) — a TRANSAÇÃO do dev é provada pela PRIMEIRA gravação.
  const commits = []
  h.tasks.onMutation = (_prev, next) => {
    if (next.id === task.id) {
      commits.push({
        status: next.status,
        activePhase: next.activePhase,
        phaseState: next.phaseState,
        dev: next.verification?.dev
      })
    }
  }

  const advanced = await h.engine.advancePhase(watch, 'done', undefined, undefined, h.acceptance(), token)

  assert.equal(advanced, true)
  const verdictCommit = commits[0]
  assert.equal(verdictCommit.status, 'execucao')
  assert.equal(verdictCommit.activePhase, 'review')
  assert.equal(verdictCommit.phaseState, 'pending')
  assert.equal(verdictCommit.dev.head, fixture.facts.head)
  assert.equal(verdictCommit.dev.baseHead, fixture.facts.baseHead)
  assert.equal(verdictCommit.dev.fingerprint, fixture.facts.fingerprint)
  assert.ok(Array.isArray(verdictCommit.dev.changedPaths))
  assert.ok(h.events.hub.some((e) => e.kind === 'report' && /dev concluiu/.test(e.text)))
  assert.equal(h.engine.phaseWatches.has(task.id), false)
  await settle()
  // release no SETTLE da cadeia: com a continuação já morta, o lock soltou
  assert.equal(h.engine.phaseTransitions.isLocked(task.id), false)
  assert.ok(!h.events.blackbox.some((e) => e.event === 'phase-advance-without-lock'))
})

test('baseline: dev done com fotografia DERIVADA (drift) devolve false e re-indexa o watch', async (t) => {
  const fixture = gitFixture(t)
  const h = createHarness(t, fixture)
  const task = h.createTask({ gates: ['review'] })
  const staleFacts = { ...fixture.facts }
  // a entrega anda depois da fotografia: head novo ≠ snapshot.head
  writeFileSync(join(fixture.root, 'app.txt'), 'mudou depois\n', 'utf-8')
  fixture.git('add', '.')
  fixture.git('commit', '-q', '-m', 'drift')
  const watch = h.watchFor(task, 'dev', { devSnapshot: staleFacts })
  const token = h.enterTransition(task, watch)

  const advanced = await h.engine.advancePhase(watch, 'done', undefined, undefined, undefined, token)

  assert.equal(advanced, false)
  // invariante do mapa do veredito: todo return false re-indexa o watch
  assert.equal(h.engine.phaseWatches.has(task.id), true)
  assert.equal(watch.devSnapshot, undefined)
  // desfecho sem continuação: o wrapper solta o lock ainda na pilha síncrona
  assert.equal(h.engine.phaseTransitions.isLocked(task.id), false)
  const after = h.tasks.get(task.id)
  assert.equal(after.activePhase, 'dev')
  await settle()
})

test('baseline: review REPROVADA limpa (readonly provado) grava gateRound e volta o card ao dev', async (t) => {
  const fixture = gitFixture(t)
  const h = createHarness(t, fixture)
  const task = h.createTask({
    gates: ['review', 'qa'],
    status: 'execucao',
    activePhase: 'review',
    phaseState: 'running',
    verification: { contractVersion: 1, dev: { reportedAt: new Date().toISOString(), ...fixture.facts } }
  })
  const watch = h.watchFor(task, 'review', {
    gateBaselineFingerprint: fixture.facts.fingerprint,
    gateStartedAt: new Date().toISOString()
  })
  const token = h.enterTransition(task, watch)

  const advanced = await h.engine.advancePhase(
    watch,
    'reprovada: falta tratar o caso vazio',
    undefined,
    undefined,
    undefined,
    token
  )

  assert.equal(advanced, true)
  const after = h.tasks.get(task.id)
  assert.equal(after.status, 'backlog')
  assert.equal(after.activePhase, 'dev')
  // COMPORTAMENTO REAL (F6.8i, prefixo síncrono do retryOrBacklog disparado
  // de DENTRO do veredito): a evidência do gate que reprovou é ZERADA na hora
  // — a memoização nunca pode "aprovar" o que reprovou. O registro durável da
  // rodada fica no gateHistory e a lista fechada no gateRound.
  assert.equal(after.verification.review, undefined)
  assert.equal(after.verification.dev, undefined)
  const history = after.verification.gateHistory
  assert.equal(history.length, 1)
  assert.equal(history[0].verdict, 'rejected')
  assert.equal(history[0].readonly, true)
  assert.equal(history[0].baselineFingerprint, fixture.facts.fingerprint)
  assert.equal(after.gateRound.phase, 'review')
  assert.ok(/caso vazio/.test(JSON.stringify(after.gateRound)))
  await settle()
  // o retryOrBacklog (continuação) settlou — o lock soltou com a cadeia
  assert.equal(h.engine.phaseTransitions.isLocked(task.id), false)
})

test('baseline: review APROVADA transiciona para QA na mesma transação', async (t) => {
  const fixture = gitFixture(t)
  const h = createHarness(t, fixture)
  const task = h.createTask({
    gates: ['review', 'qa'],
    status: 'execucao',
    activePhase: 'review',
    phaseState: 'running',
    verification: { contractVersion: 1, dev: { reportedAt: new Date().toISOString(), ...fixture.facts } }
  })
  const watch = h.watchFor(task, 'review', {
    gateBaselineFingerprint: fixture.facts.fingerprint,
    gateStartedAt: new Date().toISOString()
  })
  const token = h.enterTransition(task, watch)
  // F2-c5: com o advancePhase AGUARDADO, a continuação (openGatePane) já
  // corre antes do assert — e no harness ela falha por design (ctx fake sem
  // worktree de fase) e estaciona o card em 'interrupted'. A TRANSAÇÃO do
  // recordGate é provada pela PRIMEIRA gravação persistida do veredito.
  const commits = []
  h.tasks.onMutation = (_prev, next) => {
    if (next.id === task.id) {
      commits.push({
        status: next.status,
        activePhase: next.activePhase,
        phaseState: next.phaseState,
        reviewVerdict: next.verification?.review?.verdict,
        gateRound: next.gateRound
      })
    }
  }

  const advanced = await h.engine.advancePhase(
    watch,
    'aprovada: código coerente com o contrato',
    undefined,
    undefined,
    h.acceptance(),
    token
  )

  assert.equal(advanced, true)
  const verdictCommit = commits[0]
  assert.equal(verdictCommit.reviewVerdict, 'approved')
  assert.equal(verdictCommit.status, 'qa')
  assert.equal(verdictCommit.activePhase, 'qa')
  assert.equal(verdictCommit.phaseState, 'pending')
  assert.equal(verdictCommit.gateRound, undefined)
  const after = h.tasks.get(task.id)
  assert.equal(after.verification.review.verdict, 'approved')
  await settle()
  assert.equal(h.engine.phaseTransitions.isLocked(task.id), false)
})

test('baseline: gate que ESCREVEU (fingerprint divergente) tem o veredito invalidado', async (t) => {
  const fixture = gitFixture(t)
  const h = createHarness(t, fixture)
  const task = h.createTask({
    gates: ['review', 'qa'],
    status: 'execucao',
    activePhase: 'review',
    phaseState: 'running',
    verification: { contractVersion: 1, dev: { reportedAt: new Date().toISOString(), ...fixture.facts } }
  })
  const watch = h.watchFor(task, 'review', {
    gateBaselineFingerprint: fixture.facts.fingerprint,
    gateStartedAt: new Date().toISOString()
  })
  const token = h.enterTransition(task, watch)
  // o "gate" escreve num arquivo RASTREADO — a árvore visível ao git muda e o
  // head deixa de bater (worktree sujo): a fotografia imutável quebra.
  writeFileSync(join(fixture.root, 'app.txt'), 'gate escreveu aqui\n', 'utf-8')

  const advanced = await h.engine.advancePhase(
    watch,
    'aprovada: tudo certo',
    undefined,
    undefined,
    undefined,
    token
  )

  assert.equal(advanced, true)
  const after = h.tasks.get(task.id)
  // o retryOrBacklog zera a evidência do gate invalidado (mesma mecânica da
  // reprovação); o registro durável do veredito 'invalid' fica no gateHistory
  assert.equal(after.verification.review, undefined)
  const history = after.verification.gateHistory
  assert.equal(history.length, 1)
  assert.equal(history[0].verdict, 'invalid')
  assert.equal(history[0].readonly, false)
  assert.equal(after.status, 'backlog')
  assert.equal(after.activePhase, 'dev')
  fixture.git('checkout', '--', '.')
  await settle()
  assert.equal(h.engine.phaseTransitions.isLocked(task.id), false)
})

test('pacote reviewArtifactIdentity (reviewEvidence, worker-elegível) confere sha256 e bytes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'synkora-artifact-identity-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'patch.review.patch')
  const content = 'diff --git a/x b/x\n+linha um\n+linha dois — çãé\n'
  writeFileSync(file, content, 'utf-8')

  const identity = reviewEvidence.reviewArtifactIdentity(file)

  assert.equal(identity.sha256, createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex'))
  assert.equal(identity.bytes, Buffer.byteLength(content, 'utf-8'))
})

// ——————————————————— F2-c4: serialização por card ———————————————————

test('c4: segundo entrante é RECUSADO com contenda auditada; sem posse, advancePhase emite a anomalia e nunca lança', async (t) => {
  const fixture = gitFixture(t)
  const h = createHarness(t, fixture)
  const task = h.createTask({ gates: ['review'] })
  const watch = h.watchFor(task, 'dev', { devSnapshot: { ...fixture.facts } })
  const holder = h.engine.phaseTransitions.acquire(task.id, {
    label: 'test:holder',
    projectId: h.projectId
  })
  assert.ok(holder)
  // try-acquire de um segundo entrante falha e a contenda vai à caixa-preta
  assert.equal(
    h.engine.phaseTransitions.acquire(task.id, { label: 'test:second', projectId: h.projectId }),
    undefined
  )
  assert.ok(
    h.events.blackbox.some(
      (e) => e.event === 'phase-transition-contention' && /test:second/.test(e.reason)
    )
  )
  // tripwire: veredito SEM posse (lock de outro dono) segue funcionando —
  // anomalia auditável, nunca um throw que brickaria o veredito
  h.engine.phaseWatches.set(task.id, watch)
  h.engine.phaseWatches.detach(task.id)
  const advanced = await h.engine.advancePhase(watch, 'done', undefined, undefined, h.acceptance())
  assert.equal(advanced, true)
  assert.ok(h.events.blackbox.some((e) => e.event === 'phase-advance-without-lock'))
  // o dono continua sendo o holder (o wrapper sem token não solta nada)
  assert.equal(h.engine.phaseTransitions.holderLabel(task.id), 'test:holder')
  h.engine.phaseTransitions.release(task.id, holder)
  await settle()
})

test('c4: phaseOccupancy soma card em transição e nunca conta watch+lock em dobro', async (t) => {
  const fixture = gitFixture(t)
  const h = createHarness(t, fixture)
  const task = h.createTask({ gates: ['review'] })
  const watch = h.watchFor(task, 'dev', { devSnapshot: { ...fixture.facts } })
  assert.equal(h.engine.phaseOccupancy(h.projectId), 0)
  // card em transição (lock tomado, watch detached) ocupa 1 vaga do teto
  const token = h.enterTransition(task, watch)
  assert.equal(h.engine.phaseOccupancy(h.projectId), 1)
  // o próprio entrante se exclui da conta (respawn de boot, §7.6)
  assert.equal(h.engine.phaseOccupancy(h.projectId, task.id), 0)
  // watch re-indexado com o lock ainda vivo (rollback): conta UMA vez
  h.engine.phaseWatches.set(task.id, watch)
  assert.equal(h.engine.phaseOccupancy(h.projectId), 1)
  h.engine.phaseWatches.detach(task.id)
  h.engine.phaseTransitions.release(task.id, token)
  assert.equal(h.engine.phaseOccupancy(h.projectId), 0)
  await settle()
})

// ————————— F2-c5: MATRIZ DE CORRIDA (docs/FASE2_PLANO.md §5.3) —————————
// O veredito é PAUSADO num await real (gate do stub de gitAsync) e o
// concorrente entra pela janela — é a prova que a serialização por card
// substituiu a barreira síncrona.

test('matriz 1+2: veredito em voo RECUSA o segundo entrante e o card some do registry (§7.1/§7.2)', async (t) => {
  const fixture = gitFixture(t)
  const h = createHarness(t, fixture)
  const task = h.createTask({ gates: ['review'] })
  const watch = h.watchFor(task, 'dev', { devSnapshot: { ...fixture.facts } })
  const gate = pauseGitTrip(t, 'devDeliveryFacts', { cwd: fixture.root })
  const token = h.enterTransition(task, watch, 'report:dev')

  const verdict = h.engine.advancePhase(watch, 'done', undefined, undefined, h.acceptance(), token)
  await gate.waitPaused()

  // CASO 1 — report × report no mesmo card: o segundo NÃO avança (try-acquire
  // síncrono negado) e a contenda vai à caixa-preta; a receita do call site é
  // "a rodada anterior está fechando; aguarde".
  assert.equal(
    h.engine.phaseTransitions.acquire(task.id, {
      label: 'report:dev#2',
      projectId: h.projectId
    }),
    undefined
  )
  assert.ok(
    h.events.blackbox.some(
      (e) => e.event === 'phase-transition-contention' && /report:dev#2/.test(e.reason)
    )
  )
  // CASO 2 — o achado estrutural do mapa: durante a janela o card PARECE
  // ocioso para os ~20 guards que só leem phaseWatches. Com awaits no meio
  // isso é mentira de segundos — quem pergunta "está livre?" pergunta ao lock.
  assert.equal(h.engine.phaseWatches.get(task.id), undefined)
  assert.equal(h.engine.phaseTransitions.isLocked(task.id), true)
  assert.equal(h.engine.phaseTransitions.holderLabel(task.id), 'report:dev')

  gate.release()
  assert.equal(await verdict, true)
  const after = h.tasks.get(task.id)
  assert.equal(after.verification.dev.head, fixture.facts.head)
  assert.equal(after.verification.dev.fingerprint, fixture.facts.fingerprint)
  await settle()
  assert.equal(h.engine.phaseTransitions.isLocked(task.id), false)
})

test('matriz 5: plano pausado NO MEIO do veredito estaciona a fase e nenhum pane novo nasce (§7.8)', async (t) => {
  const fixture = gitFixture(t)
  const h = createHarness(t, fixture)
  const task = h.createTask({ gates: ['review'] })
  const watch = h.watchFor(task, 'dev', { devSnapshot: { ...fixture.facts } })
  const gate = pauseGitTrip(t, 'devDeliveryFacts', { cwd: fixture.root })
  const token = h.enterTransition(task, watch, 'report:dev')

  const verdict = h.engine.advancePhase(watch, 'done', undefined, undefined, h.acceptance(), token)
  await gate.waitPaused()
  // o dono aperta "pausar" DEPOIS de o veredito entrar: a leitura do plano é
  // TARDIA por contrato (openGatePane, a continuação) — antecipá-la para o
  // topo do veredito ignoraria o "pare AGORA".
  h.setPlanTask(h.pausedPlan())
  gate.release()

  assert.equal(await verdict, true)
  await settle()
  const after = h.tasks.get(task.id)
  // O parking do openGatePane PRESERVA a fase (status/activePhase do gate +
  // interrupted). O "volta ao backlog" é o parking do retryOrBacklog — outro
  // ramo, outro desfecho; aqui o que se prova é que a pausa foi HONRADA.
  assert.equal(after.status, 'execucao')
  assert.equal(after.activePhase, 'review')
  assert.equal(after.phaseState, 'interrupted')
  // o veredito do dev foi GRAVADO mesmo com a pausa chegando no meio
  assert.equal(after.verification.dev.head, fixture.facts.head)
  // nenhum spawn tentado: o ramo da pausa publica o aviso e SAI antes do
  // preparePhasePane — cuja falha gravaria um feedback bem diferente.
  assert.ok(h.events.hub.some((e) => /plano pausado/.test(e.text ?? '')))
  assert.ok(!/não foi possível abrir o gate/.test(after.feedback ?? ''))
  assert.equal(h.engine.phaseTransitions.isLocked(task.id), false)
})

test('matriz 6: card removido no meio do veredito faz o recordGate LANÇAR; o call site rola atrás e solta o lock (§7.11)', async (t) => {
  const fixture = gitFixture(t)
  const h = createHarness(t, fixture)
  const task = h.createTask({
    gates: ['review', 'qa'],
    status: 'execucao',
    activePhase: 'review',
    phaseState: 'running',
    verification: {
      contractVersion: 1,
      dev: { reportedAt: new Date().toISOString(), ...fixture.facts }
    }
  })
  const watch = h.watchFor(task, 'review', {
    gateBaselineFingerprint: fixture.facts.fingerprint,
    gateStartedAt: new Date().toISOString()
  })
  const gate = pauseGitTrip(t, 'gateVerdictFacts', { cwd: fixture.root })
  const token = h.enterTransition(task, watch, 'report:review')

  const outcome = settledOutcome(
    h.engine.advancePhase(
      watch,
      'aprovada: código coerente com o contrato',
      undefined,
      undefined,
      h.acceptance(),
      token
    )
  )
  await gate.waitPaused()
  // removeTaskCascade/stopMissionExecution rodando por fora (hoje RECUSADOS
  // pela tabela §3.3; aqui o pior caso é forçado à mão para provar o desfecho)
  h.tasks.remove(task.id)
  gate.release()

  const settled = await outcome
  assert.ok(settled.error instanceof Error, 'o commit sem card tem que LANÇAR, nunca gravar meio veredito')
  assert.match(settled.error.message, /card desapareceu antes do commit do veredito do gate/)
  // no THROW a posse volta ao call site — exatamente o catch do report.ts
  assert.equal(h.engine.phaseTransitions.isLocked(task.id), true)
  h.engine.rollbackVerdictTransaction(watch, token)
  assert.equal(h.engine.phaseWatches.get(task.id), watch, 'o rollback re-indexa antes de soltar (§8.2)')
  assert.equal(h.engine.phaseTransitions.isLocked(task.id), false)
  await settle()
  assert.deepEqual(orphanRejections, [], 'nenhum watch fantasma e nenhuma rejeição solta')
})

test('matriz 6.1: liveGateWaits apagado no meio NÃO salva a evidência do gate que reprovou (memoização)', async (t) => {
  const fixture = gitFixture(t)
  const h = createHarness(t, fixture)
  const paneId = 'pane-review-vivo'
  // gate VIVO: o pane do reviewer está de pé, então a reprovação limpa
  // registra a espera (liveGateWaits) em vez de fechar o pane.
  h.ctx.ptys.has = (id) => id === paneId
  const task = h.createTask({
    gates: ['review', 'qa'],
    status: 'execucao',
    activePhase: 'review',
    phaseState: 'running',
    verification: {
      contractVersion: 1,
      dev: { reportedAt: new Date().toISOString(), ...fixture.facts }
    }
  })
  const watch = h.watchFor(task, 'review', {
    paneId,
    gateBaselineFingerprint: fixture.facts.fingerprint,
    gateStartedAt: new Date().toISOString()
  })
  // o onExit do PTY (dono fechando o pane assim que vê a reprovação) cai
  // EXATAMENTE na janela apontada pelo §6.1: entre o liveGateWaits.set e o
  // retryOrBacklog. O aviso ao pane é o último ato antes da continuação.
  const baseNotify = h.ctx.hub.notifyPane
  h.ctx.hub.notifyPane = (target, text) => {
    if (/FICA ABERTO em espera/.test(text)) h.engine.liveGateWaits.delete(task.id)
    return baseNotify(target, text)
  }
  const gate = pauseGitTrip(t, 'gateVerdictFacts', { cwd: fixture.root })
  const token = h.enterTransition(task, watch, 'report:review')

  const verdict = h.engine.advancePhase(
    watch,
    'reprovada: falta tratar o caso vazio',
    undefined,
    undefined,
    h.acceptance(),
    token
  )
  await gate.waitPaused()
  // e mais uma limpeza no MEIO dos awaits, para não sobrar caminho
  h.engine.liveGateWaits.delete(task.id)
  gate.release()

  assert.equal(await verdict, true)
  await settle()
  const after = h.tasks.get(task.id)
  // A PROVA: o gate reprovador viaja por PARÂMETRO, calculado dentro do lock.
  // Se o retryOrBacklog voltasse a re-consultar liveGateWaits, a evidência do
  // review sobreviveria e a memoização por head "aprovaria" na entrega
  // seguinte um gate que REPROVOU.
  assert.equal(after.verification.review, undefined)
  assert.equal(after.verification.dev, undefined)
  assert.equal(h.engine.liveGateWaits.has(task.id), false, 'o onExit simulado apagou a espera')
  const history = after.verification.gateHistory
  assert.equal(history[history.length - 1].verdict, 'rejected')
  assert.equal(after.gateRound.phase, 'review')

  // CINTO DIFERENCIAL: o caminho que o fallback antigo realmente cobria era o
  // watch de fase DEV (rodada vazia do openGatePane) — ali `watch.phase` não
  // nomeia gate nenhum e a consulta ao liveGateWaits era a única fonte. Com o
  // mapa VAZIO, só o parâmetro pode zerar a evidência certa.
  const gateAprovadoAntes = () => ({
    phase: 'review',
    verdict: 'approved',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    readonly: true,
    reason: 'aprovada numa rodada anterior',
    snapshotHead: fixture.facts.head
  })
  const cardComEvidencia = () =>
    h.createTask({
      gates: ['review', 'qa'],
      status: 'execucao',
      activePhase: 'dev',
      phaseState: 'interrupted',
      verification: {
        contractVersion: 1,
        dev: { reportedAt: new Date().toISOString(), ...fixture.facts },
        review: gateAprovadoAntes()
      }
    })

  const comParametro = cardComEvidencia()
  assert.equal(h.engine.liveGateWaits.has(comParametro.id), false)
  await h.engine.retryOrBacklog(
    h.watchFor(comParametro, 'dev'),
    'revisor',
    'rodada vazia: o done não trouxe NENHUM commit novo desde o head reprovado',
    'review'
  )
  const comParametroAfter = h.tasks.get(comParametro.id)
  assert.equal(comParametroAfter.verification.review, undefined)
  assert.equal(comParametroAfter.verification.dev, undefined)

  // CONTRAPROVA (a forma ANTIGA, sem parâmetro, com o liveGateWaits vazio): a
  // evidência do review SOBREVIVE — é exatamente o bug latente do §6.1, e é
  // ele que a memoização por head transformaria em "aprovado" na entrega
  // seguinte. Se alguém remover o parâmetro, o bloco de cima passa a se
  // comportar como este e o teste quebra.
  const semParametro = cardComEvidencia()
  await h.engine.retryOrBacklog(
    h.watchFor(semParametro, 'dev'),
    'revisor',
    'rodada vazia: o done não trouxe NENHUM commit novo desde o head reprovado'
  )
  const semParametroAfter = h.tasks.get(semParametro.id)
  assert.equal(semParametroAfter.verification.review?.verdict, 'approved')
})

test('matriz 7: morte no meio do veredito deixa a fotografia PRÉ-veredito (inventário reconciliável do §4.5)', async (t) => {
  const fixture = gitFixture(t)
  const h = createHarness(t, fixture)
  const task = h.createTask({ gates: ['review'] })
  const watch = h.watchFor(task, 'dev', { devSnapshot: { ...fixture.facts } })
  const commits = []
  h.tasks.onMutation = (_prev, next) => {
    if (next.id === task.id) {
      commits.push({
        status: next.status,
        activePhase: next.activePhase,
        phaseState: next.phaseState,
        dev: next.verification?.dev
      })
    }
  }
  const gate = pauseGitTrip(t, 'devDeliveryFacts', { cwd: fixture.root })
  const token = h.enterTransition(task, watch, 'report:dev')

  const verdict = h.engine.advancePhase(watch, 'done', undefined, undefined, h.acceptance(), token)
  await gate.waitPaused()

  // Queda AQUI (crash/kill no await): nada foi gravado. O card persistido
  // continua exatamente na fase dev em execução — o caso que o recovery de
  // boot já conhece (dev → backlog + re-entrega sancionada). O lock é
  // memória: morre junto e não cria caso novo de reconciliação.
  assert.deepEqual(commits, [], 'nenhuma gravação antes do commit único do veredito')
  const midFlight = h.tasks.get(task.id)
  assert.equal(midFlight.status, 'execucao')
  assert.equal(midFlight.activePhase, 'dev')
  assert.equal(midFlight.phaseState, 'running')
  assert.equal(midFlight.verification, undefined)

  gate.release()
  assert.equal(await verdict, true)
  // R8 para o ramo dev: o veredito inteiro é UMA gravação — não existe estado
  // intermediário observável entre a fotografia velha e a nova.
  const verdictCommit = commits[0]
  assert.equal(verdictCommit.status, 'execucao')
  assert.equal(verdictCommit.activePhase, 'review')
  assert.equal(verdictCommit.phaseState, 'pending')
  assert.equal(verdictCommit.dev.head, fixture.facts.head)
  await settle()
})

test('matriz 9: throw no recordGate deixa artefato e pane INTACTOS (prova o commit-antes-do-destrutivo, R7)', async (t) => {
  const fixture = gitFixture(t)
  const h = createHarness(t, fixture)
  const task = h.createTask({
    gates: ['review', 'qa'],
    status: 'execucao',
    activePhase: 'review',
    phaseState: 'running',
    verification: {
      contractVersion: 1,
      dev: { reportedAt: new Date().toISOString(), ...fixture.facts }
    }
  })
  const gatePaneId = 'pane-gate-review'
  // pane do gate DE PÉ: sem isto o terminateTaskPhasePane seria no-op e a
  // asserção "pane intacto" não mediria nada.
  h.ctx.hub.panesOf = (pid) =>
    pid === h.projectId
      ? [{ paneId: gatePaneId, taskId: task.id, role: 'review', projectId: pid }]
      : []
  const artifact = makeReviewArtifact(h.userData, task.id, 'rodada-r7')
  const watch = h.watchFor(task, 'review', {
    paneId: gatePaneId,
    reviewArtifact: artifact,
    gateBaselineFingerprint: fixture.facts.fingerprint,
    gateStartedAt: new Date().toISOString()
  })
  const gate = pauseGitTrip(t, 'gateVerdictFacts', { cwd: fixture.root })
  const token = h.enterTransition(task, watch, 'report:review')

  const outcome = settledOutcome(
    h.engine.advancePhase(
      watch,
      'aprovada: código coerente com o contrato',
      undefined,
      undefined,
      h.acceptance(),
      token
    )
  )
  await gate.waitPaused()
  h.tasks.remove(task.id)
  gate.release()

  const settled = await outcome
  assert.ok(settled.error instanceof Error)
  assert.match(settled.error.message, /card desapareceu antes do commit/)
  h.engine.rollbackVerdictTransaction(watch, token)

  // R7: o COMMIT vem antes de cleanupReviewArtifact/terminateTaskPhasePane —
  // então um throw no commit não pode ter apagado o artefato nem matado o
  // pane; a promessa "tente novamente" continua executável.
  assert.equal(existsSync(artifact.privatePath), true, 'o artefato imutável sobreviveu ao throw')
  assert.deepEqual(h.events.terminated, [], 'nenhum pane foi morto no caminho que falhou')
  // controle do próprio teste: com o pane declarado, o kill REALMENTE dispara
  h.engine.terminateTaskPhasePane(h.projectId, task.id, 'review')
  assert.deepEqual(h.events.terminated, [gatePaneId])
  await settle()
})

test('matriz 10: rodada NOVA no registry vence o rollback tardio e o artefato dela sobrevive (R2)', async (t) => {
  const fixture = gitFixture(t)
  const h = createHarness(t, fixture)
  const task = h.createTask({
    gates: ['review', 'qa'],
    status: 'execucao',
    activePhase: 'review',
    phaseState: 'running',
    verification: {
      contractVersion: 1,
      dev: { reportedAt: new Date().toISOString(), ...fixture.facts }
    }
  })
  const oldArtifact = makeReviewArtifact(h.userData, task.id, 'rodada-velha')
  const oldWatch = h.watchFor(task, 'review', {
    reviewArtifact: oldArtifact,
    gateBaselineFingerprint: fixture.facts.fingerprint,
    gateStartedAt: new Date().toISOString()
  })
  const gate = pauseGitTrip(t, 'gateVerdictFacts', { cwd: fixture.root })
  const token = h.enterTransition(task, oldWatch, 'report:review')

  const outcome = settledOutcome(
    h.engine.advancePhase(
      oldWatch,
      'aprovada: código coerente com o contrato',
      undefined,
      undefined,
      h.acceptance(),
      token
    )
  )
  await gate.waitPaused()
  // reciclo/re-prepare aterrissa DURANTE os awaits: o registry ganha um watch
  // NOVO do mesmo card, com artefato próprio.
  const newArtifact = makeReviewArtifact(h.userData, task.id, 'rodada-nova')
  const newWatch = h.watchFor(task, 'review', {
    reviewArtifact: newArtifact,
    gateBaselineFingerprint: fixture.facts.fingerprint,
    gateStartedAt: new Date().toISOString()
  })
  h.engine.phaseWatches.set(task.id, newWatch)
  h.tasks.remove(task.id)
  gate.release()

  const settled = await outcome
  assert.ok(settled.error instanceof Error)
  h.engine.rollbackVerdictTransaction(oldWatch, token)

  assert.equal(h.engine.phaseWatches.get(task.id), newWatch, 'a rodada NOVA continua indexada')
  assert.ok(
    h.events.blackbox.some((e) => e.event === 'phase-rollback-superseded'),
    'o rollback cedido é auditado, nunca silencioso'
  )
  assert.equal(existsSync(newArtifact.privatePath), true, 'o artefato da rodada NOVA sobreviveu')
  assert.equal(existsSync(oldArtifact.privatePath), false, 'o artefato da rodada velha não vaza')
  assert.equal(h.engine.phaseTransitions.isLocked(task.id), false)
  await settle()
})

test('matriz 11: com o gate do gitAsync DESLIGADO (forma do fallback síncrono, R9) o desfecho é idêntico', async (t) => {
  const fixture = gitFixture(t)
  const h = createHarness(t, fixture)
  // O modo pass-through do stub (beforeCall null) É a forma do fallback
  // síncrono do gitAsync: as MESMAS funções do worktree.ts, resolvidas na
  // hora, sem worker no meio. As 5 baselines já correm assim; este é o cinto
  // explícito exigido pelo caso 11 — com o worker morto o comportamento nunca
  // é pior que o de hoje.
  gitGate.beforeCall = null
  t.after(() => {
    gitGate.beforeCall = null
  })
  const task = h.createTask({ gates: ['review'] })
  const watch = h.watchFor(task, 'dev', { devSnapshot: { ...fixture.facts } })
  const commits = []
  h.tasks.onMutation = (_prev, next) => {
    if (next.id === task.id) {
      commits.push({
        status: next.status,
        activePhase: next.activePhase,
        phaseState: next.phaseState,
        dev: next.verification?.dev
      })
    }
  }
  const token = h.enterTransition(task, watch, 'report:dev')

  const advanced = await h.engine.advancePhase(
    watch,
    'done',
    undefined,
    undefined,
    h.acceptance(),
    token
  )

  assert.equal(advanced, true)
  const verdictCommit = commits[0]
  assert.equal(verdictCommit.status, 'execucao')
  assert.equal(verdictCommit.activePhase, 'review')
  assert.equal(verdictCommit.phaseState, 'pending')
  assert.equal(verdictCommit.dev.head, fixture.facts.head)
  assert.equal(verdictCommit.dev.baseHead, fixture.facts.baseHead)
  assert.equal(verdictCommit.dev.fingerprint, fixture.facts.fingerprint)
  assert.equal(h.engine.phaseWatches.has(task.id), false)
  await settle()
  assert.equal(h.engine.phaseTransitions.isLocked(task.id), false)
  assert.ok(!h.events.blackbox.some((e) => e.event === 'phase-advance-without-lock'))
})

test('matriz 13: vereditos de cards DIFERENTES nunca se serializam entre si (o lock é por card)', async (t) => {
  const fixture = gitFixture(t)
  const h = createHarness(t, fixture)
  const cardA = h.createTask({ gates: ['review'] })
  const cardB = h.createTask({ gates: ['review'] })
  const watchA = h.watchFor(cardA, 'dev', { devSnapshot: { ...fixture.facts } })
  const watchB = h.watchFor(cardB, 'dev', { devSnapshot: { ...fixture.facts } })
  // os dois cards vivem no MESMO worktree do fixture, então o corte é por
  // ORDEM de chamada: só a 1ª viagem (a do card A) fica pausada.
  const gate = pauseGitTrip(t, 'devDeliveryFacts', { cwd: fixture.root, nth: 1 })

  const tokenA = h.enterTransition(cardA, watchA, 'report:dev-A')
  const verdictA = h.engine.advancePhase(
    watchA,
    'done',
    undefined,
    undefined,
    h.acceptance(),
    tokenA
  )
  await gate.waitPaused()
  assert.equal(h.engine.phaseTransitions.isLocked(cardA.id), true)

  // PARALELISMO É LEI: o card B abre a própria transação com o A parado.
  const tokenB = h.enterTransition(cardB, watchB, 'report:dev-B')
  assert.ok(tokenB, 'o lock de outro card nunca bloqueia este')
  assert.equal(
    await h.engine.advancePhase(watchB, 'done', undefined, undefined, h.acceptance(), tokenB),
    true
  )
  const afterB = h.tasks.get(cardB.id)
  assert.equal(afterB.verification.dev.head, fixture.facts.head)
  // B ATRAVESSOU INTEIRO com A ainda parado no await — é a prova do caso 13.
  assert.equal(gate.state.paused, true)
  assert.equal(h.tasks.get(cardA.id).verification, undefined)

  gate.release()
  assert.equal(await verdictA, true)
  assert.equal(h.tasks.get(cardA.id).verification.dev.head, fixture.facts.head)
  await settle()
  assert.equal(h.engine.phaseTransitions.isLocked(cardA.id), false)
  assert.equal(h.engine.phaseTransitions.isLocked(cardB.id), false)
})

test('harness: nenhuma continuação deixou rejeição órfã no ar', async () => {
  await settle(200)
  assert.deepEqual(orphanRejections, [])
})
