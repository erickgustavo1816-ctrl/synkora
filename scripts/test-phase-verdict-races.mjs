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
// F2-c2 = BASELINE dos fluxos ATUAIS (advancePhase ainda SYNC): prova o
// harness antes de provar a mudança. A matriz de 13 corridas liga no F2-c5.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const { TaskStore } = require(join(COMPILED, 'tasks.js'))
const { StallAttribution } = require(join(COMPILED, 'stallAttribution.js'))
realGitApi = worktree

// rejeições órfãs das continuações `void` viram FALHA explícita do teste que
// as deixou para trás — nunca ruído silencioso.
const orphanRejections = []
process.on('unhandledRejection', (reason) => {
  orphanRejections.push(reason instanceof Error ? reason.message : String(reason))
})

const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))

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
  t.after(() => rmSync(activeUserData, { recursive: true, force: true }))
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
    mainWindow: null
  }
  const extras = {
    terminatePaneNow: (pid, paneId) => events.terminated.push(paneId),
    terminateTaskHelpers: () => {},
    discardUnstartedPane: () => {},
    planTaskForWorkTask: () => undefined,
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
    codeReportGuard: async () => undefined
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
  return { engine, ctx, tasks, events, projectId, createTask, watchFor, acceptance }
}

// ——————————————————— BASELINE (fluxos atuais, sync) ———————————————————

test('baseline: dev done com gate review — transação persiste e retorna true', async (t) => {
  const fixture = gitFixture(t)
  const h = createHarness(t, fixture)
  const task = h.createTask({ gates: ['review'] })
  const watch = h.watchFor(task, 'dev', { devSnapshot: { ...fixture.facts } })
  h.engine.phaseWatches.set(task.id, watch)
  h.engine.phaseWatches.detach(task.id)

  const advanced = h.engine.advancePhase(watch, 'done', undefined, undefined, h.acceptance())

  assert.equal(advanced, true)
  const after = h.tasks.get(task.id)
  assert.equal(after.status, 'execucao')
  assert.equal(after.activePhase, 'review')
  assert.equal(after.phaseState, 'pending')
  assert.equal(after.verification.dev.head, fixture.facts.head)
  assert.equal(after.verification.dev.baseHead, fixture.facts.baseHead)
  assert.equal(after.verification.dev.fingerprint, fixture.facts.fingerprint)
  assert.ok(Array.isArray(after.verification.dev.changedPaths))
  assert.ok(h.events.hub.some((e) => e.kind === 'report' && /dev concluiu/.test(e.text)))
  assert.equal(h.engine.phaseWatches.has(task.id), false)
  await settle()
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
  h.engine.phaseWatches.set(task.id, watch)
  h.engine.phaseWatches.detach(task.id)

  const advanced = h.engine.advancePhase(watch, 'done')

  assert.equal(advanced, false)
  // invariante do mapa do veredito: todo return false re-indexa o watch
  assert.equal(h.engine.phaseWatches.has(task.id), true)
  assert.equal(watch.devSnapshot, undefined)
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
  h.engine.phaseWatches.set(task.id, watch)
  h.engine.phaseWatches.detach(task.id)

  const advanced = h.engine.advancePhase(watch, 'reprovada: falta tratar o caso vazio')

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
  h.engine.phaseWatches.set(task.id, watch)
  h.engine.phaseWatches.detach(task.id)

  const advanced = h.engine.advancePhase(
    watch,
    'aprovada: código coerente com o contrato',
    undefined,
    undefined,
    h.acceptance()
  )

  assert.equal(advanced, true)
  const after = h.tasks.get(task.id)
  assert.equal(after.verification.review.verdict, 'approved')
  assert.equal(after.status, 'qa')
  assert.equal(after.activePhase, 'qa')
  assert.equal(after.phaseState, 'pending')
  assert.equal(after.gateRound, undefined)
  await settle()
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
  h.engine.phaseWatches.set(task.id, watch)
  h.engine.phaseWatches.detach(task.id)
  // o "gate" escreve num arquivo RASTREADO — a árvore visível ao git muda e o
  // head deixa de bater (worktree sujo): a fotografia imutável quebra.
  writeFileSync(join(fixture.root, 'app.txt'), 'gate escreveu aqui\n', 'utf-8')

  const advanced = h.engine.advancePhase(watch, 'aprovada: tudo certo')

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
})

test('pacote reviewArtifactIdentity (reviewEvidence, worker-elegível) confere sha256 e bytes', (t) => {
  const reviewEvidence = require(join(COMPILED, 'reviewEvidence.js'))
  const dir = mkdtempSync(join(tmpdir(), 'synkora-artifact-identity-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'patch.review.patch')
  const content = 'diff --git a/x b/x\n+linha um\n+linha dois — çãé\n'
  writeFileSync(file, content, 'utf-8')

  const identity = reviewEvidence.reviewArtifactIdentity(file)

  assert.equal(identity.sha256, createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex'))
  assert.equal(identity.bytes, Buffer.byteLength(content, 'utf-8'))
})

test('harness: nenhuma continuação deixou rejeição órfã no ar', async () => {
  await settle(200)
  assert.deepEqual(orphanRejections, [])
})
