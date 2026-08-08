import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { HelperSpawnReservationRegistry } from '../src/main/helperSpawnReservations.ts'
import { HelperOpenWatchdog } from '../src/main/helperOpenWatchdog.ts'
import { ptyPreparationCanContinue } from '../src/main/ptyPreparationGuard.ts'
import { RuntimeOwnershipRegistry } from '../src/main/runtimeOwnership.ts'
import { validateGateVerificationEvidence } from '../src/main/gateVerificationEvidence.ts'
import {
  buildReviewEvidenceChunkManifest,
  readAuthenticatedReviewEvidenceChunk
} from '../src/main/reviewEvidence.ts'
import { SkillRuntime } from '../src/main/skillRuntime.ts'

const root = resolve(import.meta.dirname, '..')
const indexPath = join(root, 'src', 'main', 'index.ts')
const indexSource = readFileSync(indexPath, 'utf8')
const projectsSource = readFileSync(join(root, 'src', 'main', 'projects.ts'), 'utf8')

test('evidencia estruturada impede aprovacao vazia e prova matriz visual', () => {
  assert.equal(
    validateGateVerificationEvidence({
      status: 'aprovada',
      phase: 'qa',
      uiWork: true
    }).ok,
    false
  )
  assert.equal(
    validateGateVerificationEvidence({
      status: 'done',
      phase: 'dev',
      uiWork: true,
      evidence: {
        summary: 'Fluxo renderizado sem overflow.',
        surfaces: ['histórico'],
        states: ['conteúdo longo'],
        viewports: ['390x844', '1440x900'],
        observations: ['screenshot ui-history-long.png; CTA e filtros visíveis']
      }
    }).ok,
    true
  )
  assert.equal(
    validateGateVerificationEvidence({
      status: 'bloqueada',
      phase: 'qa',
      uiWork: true
    }).ok,
    true
  )
})

test('reader privado autentica cada bloco, preserva UTF-8 e avanca cursor linear', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'synkora-review-evidence-'))
  const path = join(directory, 'evidence.patch')
  const body = `${'a'.repeat(32 * 1024 - 1)}ç\n${'b'.repeat(40 * 1024)}`
  writeFileSync(path, body, 'utf8')
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  const bytes = readFileSync(path).byteLength
  const chunks = buildReviewEvidenceChunkManifest(path, bytes)
  assert.ok(chunks.length >= 2)
  assert.equal(chunks[0].offset, 0)
  assert.equal(chunks.at(-1).offset + chunks.at(-1).bytes, bytes)
  const artifact = {
    privatePath: path,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    bytes,
    chunks,
    servedUntil: 0
  }

  assert.match(readAuthenticatedReviewEvidenceChunk(artifact, 1), /fora de sequência/)
  assert.equal(artifact.servedUntil, 0)
  const first = readAuthenticatedReviewEvidenceChunk(artifact, 0)
  assert.match(first, /nextOffset/)
  assert.doesNotMatch(first, /�/)
  const afterFirst = artifact.servedUntil
  assert.equal(afterFirst, chunks[0].bytes)
  assert.equal(readAuthenticatedReviewEvidenceChunk(artifact, 0), first)
  assert.equal(artifact.servedUntil, afterFirst)

  const original = readFileSync(path)
  const changed = Buffer.from(original)
  changed[afterFirst] = changed[afterFirst] === 0x62 ? 0x63 : 0x62
  writeFileSync(path, changed)
  assert.match(
    readAuthenticatedReviewEvidenceChunk(artifact, afterFirst),
    /hash do bloco mudou/
  )
  assert.equal(artifact.servedUntil, afterFirst)
  writeFileSync(path, original)

  let calls = 1
  while (artifact.servedUntil < artifact.bytes) {
    const output = readAuthenticatedReviewEvidenceChunk(artifact, artifact.servedUntil)
    assert.doesNotMatch(output, /recusada/)
    calls++
  }
  assert.equal(calls, chunks.length)
  assert.equal(artifact.servedUntil, bytes)
})

test('callback tardio de runtime antigo nunca remove a geracao nova', () => {
  const registry = new RuntimeOwnershipRegistry()
  const first = { guardName: registry.nextGuardName('qa-runtime', 'task-1') }
  const second = { guardName: registry.nextGuardName('qa-runtime', 'task-1') }
  assert.notEqual(first.guardName, second.guardName)
  registry.set('task-1', first)
  registry.set('task-1', second)
  assert.equal(registry.deleteIfCurrent('task-1', first), false)
  assert.equal(registry.get('task-1'), second)
  assert.equal(registry.deleteIfCurrent('task-1', second), true)
  assert.equal(registry.get('task-1'), undefined)

  const runtimeSource = readFileSync(join(root, 'src', 'main', 'qaRuntime.ts'), 'utf8')
  assert.match(runtimeSource, /releaseQaRuntimeEntry\(taskId, entry, false\)/)
  assert.match(runtimeSource, /releaseQaRuntimeEntry\(taskId, entry, true\)/)
  assert.doesNotMatch(runtimeSource, /unguard\(guardNameOf\(taskId\)\)/)
  assert.doesNotMatch(runtimeSource, /runtimes\.delete\(taskId\)/)
})

test('autor e helpers morrem depois do snapshot aceito e antes do gate', () => {
  const advance = namedImplementation('advancePhaseInner')
  const persisted = advance.indexOf('tasks.update(watch.taskId', advance.indexOf('latestBeforeGate'))
  const receiptInSameCommit = advance.indexOf('skillUsage: acceptance.skillUsage', persisted)
  const runtimeStamp = advance.indexOf('commitRuntimeAcceptance()', persisted)
  const closeHelpers = advance.indexOf('terminateTaskHelpers(', persisted)
  const closeDev = advance.indexOf("terminateTaskPhasePane(watch.projectId, watch.taskId, 'dev')", closeHelpers)
  const openGate = advance.indexOf('if (next) void openGatePane', closeDev)
  assert.ok(persisted >= 0 && persisted < receiptInSameCommit)
  assert.ok(receiptInSameCommit < runtimeStamp)
  assert.ok(persisted < closeHelpers && closeHelpers < closeDev && closeDev < openGate)

  const retry = namedImplementation('retryOrBacklog')
  assert.match(retry, /task\.phaseSessions\?\.dev \|\| cycles < retryLimit/)
  assert.match(retry, /preparePhasePane\([\s\S]*'dev'/)
})

test('veredito e receipts pousam juntos antes do stamp efemero e do fechamento', () => {
  const advance = namedImplementation('advancePhaseInner')
  const recordStart = advance.indexOf('const recordGate = (')
  const recordEnd = advance.indexOf('\n    if (!readonly)', recordStart)
  const recordGate = advance.slice(recordStart, recordEnd)
  const patch = recordGate.indexOf('const workTaskPatch: TaskUpdatePatch')
  const receipt = recordGate.indexOf('skillUsage: acceptance.skillUsage', patch)
  const evidence = recordGate.indexOf('gateHistory:', patch)
  const round = recordGate.indexOf('nextGateRound', patch)
  const atomicSecurityCommit = recordGate.indexOf('tasks.updateMany([', evidence)
  const securityAudit = recordGate.indexOf("event: 'security-gate-validated'", atomicSecurityCommit)
  const runtime = recordGate.indexOf('commitRuntimeAcceptance()', atomicSecurityCommit)
  assert.ok(patch >= 0)
  assert.ok(receipt > patch && evidence > patch && round > patch)
  assert.ok(atomicSecurityCommit > receipt && atomicSecurityCommit > evidence)
  assert.ok(securityAudit > atomicSecurityCommit, 'blackbox de segurança só nasce após o commit')
  assert.ok(runtime > atomicSecurityCommit && runtime > securityAudit)

  const reportStart = indexSource.indexOf('report: (')
  const reportEnd = indexSource.indexOf('\n    delegateMany:', reportStart)
  const report = indexSource.slice(reportStart, reportEnd)
  assert.match(report, /prepareSkillUsageAcceptance/)
  assert.match(report, /try\s*\{[\s\S]*advancePhase\(/)
  assert.match(report, /catch \(error\)[\s\S]*phaseWatches\.set\(watch\.taskId, watch\)/)
})

test('activate_skill entrega o pacote somente depois do ledger e do stamp transacionais', () => {
  const start = indexSource.indexOf('activateSkill: async (id, receiptId) => {')
  const end = indexSource.indexOf('\n    readReviewEvidence:', start)
  const handler = indexSource.slice(start, end)
  const resolve = handler.indexOf('skillRuntime.resolve(input)')
  const materialize = handler.indexOf('materializeActivationTree(', resolve)
  const ledgerValidation = handler.indexOf("ledgerReceipt.status === 'planned'", materialize)
  const transaction = handler.indexOf('skillRuntime.activateAfterDurableCommit(input', ledgerValidation)
  const audit = handler.indexOf("event: 'skill-activated'", transaction)
  const delivery = handler.indexOf('`SKILL ACTIVATED', audit)

  assert.ok(resolve >= 0 && resolve < materialize)
  assert.ok(materialize < ledgerValidation && ledgerValidation < transaction)
  assert.ok(transaction < audit && audit < delivery)
  assert.doesNotMatch(
    handler.slice(0, transaction),
    /skillRuntime\.activate\(input\)/,
    'o runtime não pode ser carimbado antes do commit durável'
  )
})

test('bloqueio ambiental interrompe a rodada sem falsificar receipts aplicados', () => {
  const reportStart = indexSource.indexOf('report: (')
  const reportEnd = indexSource.indexOf('\n    delegateMany:', reportStart)
  assert.notEqual(reportStart, -1)
  assert.notEqual(reportEnd, -1)
  const report = indexSource.slice(reportStart, reportEnd)
  const blockedStart = report.indexOf("/^\\s*bloqueada\\b/i.test(content)")
  const blockedEnd = report.indexOf("let normalizedSecurityReview", blockedStart)
  const blocked = report.slice(blockedStart, blockedEnd)
  assert.doesNotMatch(blocked, /acceptSkillUsage\(\)/)
  assert.match(blocked, /terminateTaskPhasePane/)
})

test('evidencia verificada e sanitizada atravessa advancePhase e persiste no card', () => {
  const reportStart = indexSource.indexOf('report: (')
  const reportEnd = indexSource.indexOf('\n    delegateMany:', reportStart)
  const report = indexSource.slice(reportStart, reportEnd)
  const advance = namedImplementation('advancePhaseInner')
  assert.match(report, /sanitizedVerificationEvidence/)
  assert.match(report, /advancePhase\([\s\S]*sanitizedVerificationEvidence/)
  assert.match(advance, /dev:\s*\{[\s\S]*verificationEvidence/)
  assert.match(advance, /const gateEvidence:[\s\S]*verificationEvidence/)
  assert.match(advance, /gateHistory:\s*\[\.\.\.\(verification\.gateHistory \?\? \[\]\), gateEvidence\]\.slice\(-24\)/)
  assert.match(advance, /\[watch\.phase\]: gateEvidence/)
})

test('QA aprovada com securityReview é recusada antes de alterar plano, gate ou receipt', () => {
  const reportStart = indexSource.indexOf('report: (')
  const reportEnd = indexSource.indexOf('\n    delegateMany:', reportStart)
  const report = indexSource.slice(reportStart, reportEnd)
  const qaBoundary = report.indexOf(
    "securityReview &&\n        (id.role !== 'review' || id.phase !== 'review' || watch.phase !== 'review')"
  )
  const refusal = report.indexOf(
    'Nenhum receipt, veredito ou plano foi alterado.',
    qaBoundary
  )
  const skillScope = report.indexOf('const skillScope =', qaBoundary)
  const normalization = report.indexOf('let normalizedSecurityReview', qaBoundary)
  const phaseAdvance = report.indexOf('advanced = advancePhase(', qaBoundary)

  assert.ok(qaBoundary >= 0, 'a fronteira MCP deve rejeitar securityReview vindo do QA')
  assert.ok(refusal > qaBoundary)
  assert.ok(qaBoundary < skillScope && qaBoundary < normalization && qaBoundary < phaseAdvance)

  const advance = namedImplementation('advancePhaseInner')
  const internalBoundary = advance.indexOf("if (securityReview && watch.phase !== 'review')")
  const artifactWrite = advance.indexOf('persistSecurityReview(', internalBoundary)
  assert.ok(internalBoundary >= 0 && internalBoundary < artifactWrite)
  assert.match(
    advance,
    /if \(watch\.phase === 'review' && readonly && securityReview\.verdict === 'approved'\)/
  )
  assert.doesNotMatch(
    advance,
    /tasks\.update\(securityPlanTask\.id/,
    'o plano jamais pode ser aprovado numa escrita lateral fora da transação do gate'
  )
})

test('runtime_control recusa pane QA stale e revalida depois do spawn', () => {
  const runtimeStart = indexSource.indexOf('runtimeControl: async (id, action, port) => {')
  const runtimeEnd = indexSource.indexOf('\n    askUser:', runtimeStart)
  assert.notEqual(runtimeStart, -1)
  assert.notEqual(runtimeEnd, -1)
  const runtime = indexSource.slice(runtimeStart, runtimeEnd)
  assert.match(runtime, /currentWatch\?\.phase\s*===\s*'qa'/)
  assert.match(runtime, /currentWatch\.paneId\s*===\s*id\.paneId/)
  assert.match(runtime, /paneBrowserAvailable/)
  const start = runtime.indexOf('await startQaRuntime')
  assert.ok(start >= 0)
  assert.ok(runtime.indexOf('if (!isCurrentQaRound())', start) > start)
  assert.match(runtime.slice(start), /stopQaRuntime\(id\.taskId\)/)
})

test('preparacao assincrona de PTY falha fechada quando a geracao muda', () => {
  const identity = {}
  const spec = {}
  const baseline = {
    ticketMatches: true,
    senderAlive: true,
    closing: false,
    requiresPaneGeneration: true,
    capturedIdentity: identity,
    currentIdentity: identity,
    capturedToken: 'token-1',
    currentToken: 'token-1',
    capturedSpec: spec,
    currentSpec: spec,
    phaseStillActive: true
  }
  assert.equal(ptyPreparationCanContinue(baseline), true)
  assert.equal(ptyPreparationCanContinue({ ...baseline, ticketMatches: false }), false)
  assert.equal(ptyPreparationCanContinue({ ...baseline, currentIdentity: {} }), false)
  assert.equal(ptyPreparationCanContinue({ ...baseline, currentToken: 'token-2' }), false)
  assert.equal(ptyPreparationCanContinue({ ...baseline, currentSpec: {} }), false)
  assert.equal(ptyPreparationCanContinue({ ...baseline, phaseStillActive: false }), false)
})

test('encerramento invalida ticket antes do retorno de seats.prepare', () => {
  const terminate = namedImplementation('terminatePaneNow')
  const handlerStart = indexSource.indexOf("ipcMain.handle('pty:create'")
  const handlerEnd = indexSource.indexOf("ipcMain.on('pty:write'", handlerStart)
  assert.notEqual(handlerStart, -1)
  assert.notEqual(handlerEnd, -1)
  const handler = indexSource.slice(handlerStart, handlerEnd)
  assert.match(terminate, /pendingPtyPreparations\.delete\(paneId\)/)
  assert.match(handler, /ptyPreparationCanContinue/)
  assert.match(handler, /currentIdentity:\s*hub\.identityByPane\(req\.id\)/)
  assert.match(handler, /currentToken:\s*paneTokens\.get\(req\.id\)/)
  assert.match(handler, /currentSpec:\s*livePaneSpecs\.get\(req\.id\)/)
  assert.match(handler, /watch\.paneId\s*===\s*req\.id/)
})

test('helper sem PTY recebe um unico retry e depois perde todo o armamento', () => {
  const watchdog = new HelperOpenWatchdog()
  watchdog.arm('helper-1', 1_000)
  assert.deepEqual(watchdog.due(30_999, 30_000), [])
  assert.deepEqual(watchdog.due(31_000, 30_000), [
    { paneId: 'helper-1', action: 'retry' }
  ])
  assert.equal(watchdog.has('helper-1'), true)
  assert.deepEqual(watchdog.due(60_999, 30_000), [])
  assert.deepEqual(watchdog.due(61_000, 30_000), [
    { paneId: 'helper-1', action: 'expire' }
  ])
  assert.equal(watchdog.has('helper-1'), false)

  watchdog.arm('helper-2', 0)
  watchdog.acknowledge('helper-2')
  assert.deepEqual(watchdog.due(90_000, 30_000), [])

  const armedAt = indexSource.indexOf('helperOpenWatchdog.arm(armed.paneId)')
  const openedAt = indexSource.indexOf("uiSender.send('panes:open'", armedAt)
  assert.ok(armedAt >= 0 && openedAt > armedAt)
  assert.match(indexSource, /helperOpenWatchdog\.due[\s\S]*helper-open-retried[\s\S]*helper-open-expired[\s\S]*rollbackFailedPaneSpawn/)
})

test('duas delegacoes concorrentes disputam atomicamente um unico slot', async () => {
  const reservations = new HelperSpawnReservationRegistry()
  const attempt = async () => {
    if (!reservations.tryAcquire('task:card-1')) return false
    try {
      await new Promise((resolve) => setImmediate(resolve))
      return true
    } finally {
      reservations.release('task:card-1')
    }
  }

  const results = await Promise.all([attempt(), attempt()])
  assert.equal(results.filter(Boolean).length, 1)
  assert.equal(reservations.has('task:card-1'), false)
})

test('spawn de helper revalida delegador e card depois dos awaits', () => {
  const delegateStart = indexSource.indexOf('delegateMany: async (id, list) => {')
  const delegateEnd = indexSource.indexOf('\n    listSeats:', delegateStart)
  assert.notEqual(delegateStart, -1)
  assert.notEqual(delegateEnd, -1)
  const delegate = indexSource.slice(delegateStart, delegateEnd)
  const finalAwait = delegate.indexOf('await prepareSkillPlanInputs')
  const parentCheck = delegate.indexOf('if (!helperParentStillActive())', finalAwait)
  const arm = delegate.indexOf('armed = armPane', finalAwait)
  const secondCheck = delegate.indexOf('if (!helperParentStillActive())', parentCheck + 1)
  const publish = delegate.indexOf('hub.publish', arm)

  assert.match(delegate, /helperSpawnReservations\.tryAcquire/)
  assert.match(delegate, /helperSpawnReservations\.release/)
  assert.ok(finalAwait < parentCheck && parentCheck < arm)
  assert.ok(arm < secondCheck && secondCheck < publish)
  assert.match(delegate, /current\.taskId\s*!==\s*id\.taskId/)
  assert.match(delegate, /task\.status\s*!==\s*'done'/)
  assert.match(delegate, /activeDevWatch\?\.phase\s*!==\s*'dev'/)
  assert.match(delegate, /activeDevWatch\.paneId\s*!==\s*id\.paneId/)
  assert.match(delegate, /watch\?\.phase\s*===\s*'dev'/)
  assert.match(delegate, /watch\.paneId\s*===\s*id\.paneId/)
  assert.match(delegate, /const plannedAgentId = parentScope\?\.agentIds\[0\]/)
  assert.match(delegate, /const requestedAgentId = opts\.agent \?\? plannedAgentId/)
  assert.match(delegate, /skillsLib\.agentBody\(requestedAgentId\)/)
})

/** Encontra o fim de um bloco sem ser enganado por strings ou comentarios. */
function balancedBlock(source, openingBrace) {
  assert.equal(source[openingBrace], '{', 'inicio de bloco invalido')
  let depth = 0
  let quote = ''
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = openingBrace; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index++
      }
      continue
    }
    if (quote) {
      if (!escaped && char === quote) quote = ''
      escaped = !escaped && char === '\\'
      if (char !== '\\') escaped = false
      continue
    }
    if (char === '/' && next === '/') {
      lineComment = true
      index++
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      index++
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      escaped = false
      continue
    }
    if (char === '{') depth++
    if (char === '}' && --depth === 0) return source.slice(openingBrace, index + 1)
  }
  assert.fail('bloco sem fechamento')
}

function namedImplementation(name) {
  const functionPattern = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const declared = functionPattern.exec(indexSource)
  let start = declared?.index ?? -1
  let assignment = false
  if (start < 0) {
    const assignmentPattern = new RegExp(`\\b${name}\\s*=\\s*(?:async\\s*)?\\(`)
    start = assignmentPattern.exec(indexSource)?.index ?? -1
    assignment = start >= 0
  }
  assert.notEqual(start, -1, `implementacao ${name} nao encontrada`)
  // Uma assinatura TypeScript pode conter objetos e callbacks, por exemplo
  // `{ commitRuntime: () => boolean }`. Para assignments, encontre somente a
  // seta que abre um bloco; a primeira chave depois do nome pode ser do tipo.
  const tail = indexSource.slice(start)
  const bodyMatch = assignment
    ? /=>\s*\{/.exec(tail)
    : /\)\s*(?::\s*[^={;]+)?\s*\{/.exec(tail)
  assert.ok(bodyMatch, `inicio do corpo de ${name} nao encontrado`)
  const openingBrace = start + bodyMatch.index + bodyMatch[0].lastIndexOf('{')
  assert.notEqual(openingBrace, -1, `corpo de ${name} nao encontrado`)
  return balancedBlock(indexSource, openingBrace)
}

function mcpApiImplementation(name) {
  const marker = new RegExp(`\\n\\s{4}${name}:\\s*(?:async\\s*)?\\(`)
  const match = marker.exec(indexSource)
  assert.ok(match, `metodo MCP ${name} nao encontrado`)
  const arrow = indexSource.indexOf('=>', match.index)
  const openingBrace = indexSource.indexOf('{', arrow)
  assert.notEqual(openingBrace, -1, `corpo MCP ${name} nao encontrado`)
  return balancedBlock(indexSource, openingBrace)
}

function ipcHandler(channel) {
  const marker = `ipcMain.handle('${channel}'`
  const start = indexSource.indexOf(marker)
  assert.notEqual(start, -1, `handler IPC ${channel} nao encontrado`)
  const arrow = indexSource.indexOf('=>', start)
  const openingBrace = indexSource.indexOf('{', arrow)
  assert.notEqual(openingBrace, -1, `corpo do handler IPC ${channel} nao encontrado`)
  return balancedBlock(indexSource, openingBrace)
}

function compileTaskStoreHarness(directory) {
  const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  const compiled = spawnSync(
    process.execPath,
    [
      compiler,
      '--outDir',
      directory,
      '--rootDir',
      join(root, 'src', 'main'),
      '--target',
      'ES2022',
      '--module',
      'Node16',
      '--moduleResolution',
      'Node16',
      '--esModuleInterop',
      '--skipLibCheck',
      '--types',
      'node',
      join(root, 'src', 'main', 'tasks.ts'),
      join(root, 'src', 'main', 'jsonStore.ts'),
      join(root, 'src', 'main', 'securityRedaction.ts')
    ],
    { cwd: root, encoding: 'utf8', windowsHide: true }
  )
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)

  const electronDirectory = join(directory, 'node_modules', 'electron')
  mkdirSync(electronDirectory, { recursive: true })
  writeFileSync(
    join(electronDirectory, 'index.js'),
    [
      "'use strict'",
      'exports.app = {',
      '  getPath(name) {',
      "    if (name !== 'userData') throw new Error('unexpected Electron path: ' + name)",
      "    if (!process.env.SYNKORA_TASK_STORE_TEST_USER_DATA) throw new Error('test userData missing')",
      '    return process.env.SYNKORA_TASK_STORE_TEST_USER_DATA',
      '  }',
      '}',
      ''
    ].join('\n'),
    'utf8'
  )
  return createRequire(import.meta.url)(join(directory, 'tasks.js'))
}

function skillRun({ phase, phaseRun, runStatus, receiptId, version, fingerprint, status }) {
  return {
    phase,
    phaseRun,
    updatedAt: `2026-08-07T12:00:0${phaseRun.at(-1)}.000Z`,
    runStatus,
    skills: [
      {
        receiptId,
        id: phase === 'qa' ? 'synkora-ui-qa' : 'synkora-frontend-standard',
        operation: phase === 'qa' ? 'verify' : 'implement',
        version,
        fingerprint,
        status
      }
    ]
  }
}

test('TaskStore persiste o livro-caixa de skills por rodada sem sobrescrever fases anteriores', (t) => {
  const harnessDirectory = mkdtempSync(join(tmpdir(), 'synkora-task-store-contract-'))
  const userData = join(harnessDirectory, 'user-data')
  mkdirSync(userData, { recursive: true })
  process.env.SYNKORA_TASK_STORE_TEST_USER_DATA = userData
  t.after(() => {
    delete process.env.SYNKORA_TASK_STORE_TEST_USER_DATA
    const safeRoot = resolve(tmpdir()).toLocaleLowerCase('en-US')
    const safeTarget = resolve(harnessDirectory).toLocaleLowerCase('en-US')
    if (safeTarget.startsWith(`${safeRoot}\\`)) {
      rmSync(harnessDirectory, { recursive: true, force: true })
    }
  })

  const { TaskStore } = compileTaskStoreHarness(harnessDirectory)
  const store = new TaskStore()
  const [created] = store.createMany('project-1', [
    {
      department: 'front',
      type: 'feature',
      effort: 'leve',
      title: 'Interface rastreavel',
      description: 'Contrato de teste',
      origin: 'maestro'
    }
  ])
  const dev = skillRun({
    phase: 'dev',
    phaseRun: 'run-1',
    runStatus: 'completed',
    receiptId: 'receipt-dev',
    version: 'git:dev-v1',
    fingerprint: 'sha256:dev-v1',
    status: 'applied'
  })
  store.update(created.id, { skillUsage: { ...dev, history: [dev] } })

  const qa = skillRun({
    phase: 'qa',
    phaseRun: 'run-2',
    runStatus: 'active',
    receiptId: 'receipt-qa',
    version: 'builtin:ui-qa-v1',
    fingerprint: 'sha256:ui-qa-v1',
    status: 'activated'
  })
  const visualEvidence = {
    summary: 'Histórico renderizado sem overflow.',
    surfaces: ['histórico'],
    states: ['conteúdo longo'],
    viewports: ['390x844', '1440x900'],
    observations: ['screenshot ui-history-long.png']
  }
  store.update(created.id, {
    skillUsage: { ...qa, history: [dev, qa] },
    verification: {
      contractVersion: 1,
      dev: {
        reportedAt: '2026-08-07T12:00:00.000Z',
        verificationEvidence: visualEvidence
      },
      qa: {
        phase: 'qa',
        verdict: 'approved',
        startedAt: '2026-08-07T12:00:01.000Z',
        finishedAt: '2026-08-07T12:00:02.000Z',
        readonly: true,
        verificationEvidence: visualEvidence
      }
    }
  })

  const reloaded = new TaskStore().get(created.id)
  assert.ok(reloaded?.skillUsage)
  assert.deepEqual(reloaded.verification?.dev?.verificationEvidence, visualEvidence)
  assert.deepEqual(reloaded.verification?.qa?.verificationEvidence, visualEvidence)
  assert.equal(reloaded.skillUsage.phaseRun, 'run-2')
  assert.deepEqual(reloaded.skillUsage.history, [dev, qa])
  assert.deepEqual(
    reloaded.skillUsage.history.map((run) => ({
      phase: run.phase,
      phaseRun: run.phaseRun,
      receiptId: run.skills[0].receiptId,
      version: run.skills[0].version,
      fingerprint: run.skills[0].fingerprint,
      status: run.runStatus
    })),
    [
      {
        phase: 'dev',
        phaseRun: 'run-1',
        receiptId: 'receipt-dev',
        version: 'git:dev-v1',
        fingerprint: 'sha256:dev-v1',
        status: 'completed'
      },
      {
        phase: 'qa',
        phaseRun: 'run-2',
        receiptId: 'receipt-qa',
        version: 'builtin:ui-qa-v1',
        fingerprint: 'sha256:ui-qa-v1',
        status: 'active'
      }
    ]
  )
})

test('TaskStore nunca publica em memoria uma mutacao que o disco recusou', (t) => {
  const harnessDirectory = mkdtempSync(join(tmpdir(), 'synkora-task-store-atomic-'))
  const userData = join(harnessDirectory, 'user-data')
  mkdirSync(userData, { recursive: true })
  process.env.SYNKORA_TASK_STORE_TEST_USER_DATA = userData
  t.after(() => {
    delete process.env.SYNKORA_TASK_STORE_TEST_USER_DATA
    rmSync(harnessDirectory, { recursive: true, force: true })
  })

  const { TaskStore } = compileTaskStoreHarness(harnessDirectory)
  const store = new TaskStore()
  const [created] = store.createMany('project-atomic', [
    {
      department: 'front',
      type: 'feature',
      effort: 'leve',
      title: 'Fotografia anterior',
      description: 'Deve sobreviver à falha',
      origin: 'maestro'
    }
  ])
  const dataFile = join(userData, 'tasks.json')
  rmSync(dataFile, { force: true })
  mkdirSync(dataFile)

  assert.throws(() => store.update(created.id, { title: 'Não pode vazar' }))
  assert.equal(store.get(created.id)?.title, 'Fotografia anterior')
  assert.throws(() =>
    store.createMany('project-atomic', [
      {
        department: 'back',
        type: 'bug',
        effort: 'leve',
        title: 'Também não entra',
        description: 'Falha antes do commit vivo',
        origin: 'maestro'
      }
    ])
  )
  assert.equal(store.list('project-atomic').length, 1)
})

test('falha do TaskStore mantém receipt planned, recusa report e permite retry da ativação', (t) => {
  const harnessDirectory = mkdtempSync(join(tmpdir(), 'synkora-skill-activation-atomic-'))
  const userData = join(harnessDirectory, 'user-data')
  mkdirSync(userData, { recursive: true })
  process.env.SYNKORA_TASK_STORE_TEST_USER_DATA = userData
  t.after(() => {
    delete process.env.SYNKORA_TASK_STORE_TEST_USER_DATA
    rmSync(harnessDirectory, { recursive: true, force: true })
  })

  const { TaskStore } = compileTaskStoreHarness(harnessDirectory)
  const runtime = new SkillRuntime({
    receiptId: () => 'receipt-activation-1',
    now: () => new Date('2026-08-07T19:00:00.000Z')
  })
  const scope = { paneId: 'pane-activation', phase: 'dev', phaseRun: 'run-activation' }
  const planned = runtime.planPane({
    ...scope,
    skills: [
      {
        skillId: 'frontend-standard',
        operation: 'apply',
        version: 'builtin:v1',
        fingerprint: 'sha256:frontend-v1',
        reason: 'ui.contract',
        required: true
      }
    ]
  })
  assert.equal(planned.ok, true)
  const receiptId = planned.plan.receipts[0].receiptId
  const store = new TaskStore()
  const [task] = store.createMany('project-activation', [
    {
      department: 'front',
      type: 'feature',
      effort: 'leve',
      title: 'Ativar contrato visual',
      description: 'Receipt deve depender do ledger durável',
      origin: 'maestro'
    }
  ])
  store.update(task.id, {
    skillUsage: {
      phase: 'dev',
      phaseRun: scope.phaseRun,
      updatedAt: '2026-08-07T18:59:00.000Z',
      runStatus: 'active',
      skills: [
        {
          receiptId,
          id: 'frontend-standard',
          operation: 'apply',
          version: 'builtin:v1',
          fingerprint: 'sha256:frontend-v1',
          status: 'planned'
        }
      ]
    }
  })

  const activate = () => {
    const before = store.get(task.id)?.skillUsage
    assert.ok(before)
    const updatedAt = '2026-08-07T19:00:00.000Z'
    const skills = before.skills.map((skill) =>
      skill.receiptId === receiptId ? { ...skill, status: 'activated' } : skill
    )
    const after = { ...before, updatedAt, skills }
    return runtime.activateAfterDurableCommit(
      { ...scope, receiptId },
      {
        commit: () => {
          if (!store.update(task.id, { skillUsage: after })) throw new Error('task missing')
        },
        rollback: () => {
          if (!store.update(task.id, { skillUsage: before })) throw new Error('task missing')
        }
      }
    )
  }

  const dataFile = join(userData, 'tasks.json')
  rmSync(dataFile, { force: true })
  mkdirSync(dataFile)
  const failed = activate()
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'durable_commit_failed')
  assert.equal(store.get(task.id)?.skillUsage?.skills[0].status, 'planned')
  assert.equal(runtime.resolve({ ...scope, receiptId }).idempotent, false)
  const refusedReport = runtime.guardReport({ ...scope, skillApplications: [receiptId] })
  assert.equal(refusedReport.ok, false)
  assert.deepEqual(refusedReport.missingActivated, [receiptId])

  rmSync(dataFile, { recursive: true, force: true })
  const retried = activate()
  assert.equal(retried.ok, true)
  assert.equal(retried.idempotent, false)
  assert.equal(store.get(task.id)?.skillUsage?.skills[0].status, 'activated')
  assert.deepEqual(runtime.guardReport({ ...scope, skillApplications: [receiptId] }), {
    ok: true,
    skillApplications: [receiptId],
    requiredReceipts: [receiptId]
  })
})

test('falha no commit de segurança não aprova plano sem veredito e receipt do gate', (t) => {
  const harnessDirectory = mkdtempSync(join(tmpdir(), 'synkora-security-gate-atomic-'))
  const userData = join(harnessDirectory, 'user-data')
  mkdirSync(userData, { recursive: true })
  process.env.SYNKORA_TASK_STORE_TEST_USER_DATA = userData
  t.after(() => {
    delete process.env.SYNKORA_TASK_STORE_TEST_USER_DATA
    rmSync(harnessDirectory, { recursive: true, force: true })
  })

  const { TaskStore } = compileTaskStoreHarness(harnessDirectory)
  const store = new TaskStore()
  const [planTask, workTask] = store.createMany('project-security-atomic', [
    {
      department: 'produto',
      type: 'feature',
      effort: 'pesada',
      title: 'Plano sensível',
      description: 'Plano cuja validação começa pendente',
      origin: 'maestro',
      kind: 'plan',
      plan: {
        risk: 'high',
        manualSecurityValidationRequired: true,
        manualSecurityValidation: { required: true, status: 'pending' }
      }
    },
    {
      department: 'back',
      type: 'feature',
      effort: 'pesada',
      title: 'Alterar autorização',
      description: 'Card sujeito ao gate de segurança',
      origin: 'maestro',
      kind: 'work',
      planId: 'plan-security'
    }
  ])
  const beforePlan = structuredClone(store.get(planTask.id))
  const beforeWork = structuredClone(store.get(workTask.id))
  const dataFile = join(userData, 'tasks.json')
  rmSync(dataFile, { force: true })
  mkdirSync(dataFile)

  assert.throws(() =>
    store.updateMany([
      {
        id: workTask.id,
        patch: {
          skillUsage: {
            phase: 'review',
            phaseRun: 'review-run-1',
            updatedAt: '2026-08-07T18:00:00.000Z',
            runStatus: 'completed',
            skills: [
              {
                receiptId: 'receipt-security-review',
                id: 'security-review',
                operation: 'review',
                status: 'applied'
              }
            ]
          },
          verification: {
            contractVersion: 1,
            review: {
              phase: 'review',
              verdict: 'approved',
              startedAt: '2026-08-07T17:55:00.000Z',
              finishedAt: '2026-08-07T18:00:00.000Z',
              readonly: true,
              reason: 'escopo aprovado'
            },
            gateHistory: [
              {
                phase: 'review',
                verdict: 'approved',
                startedAt: '2026-08-07T17:55:00.000Z',
                finishedAt: '2026-08-07T18:00:00.000Z',
                readonly: true,
                reason: 'escopo aprovado'
              }
            ]
          }
        }
      },
      {
        id: planTask.id,
        patch: {
          plan: {
            ...planTask.plan,
            manualSecurityValidation: {
              required: true,
              status: 'approved',
              actor: 'security-gate',
              resolvedAt: '2026-08-07T18:00:00.000Z',
              evidence: 'mesma transação do gate e receipt'
            }
          }
        }
      }
    ])
  )

  assert.deepEqual(store.get(planTask.id), beforePlan, 'aprovação do plano não pode sobreviver')
  assert.deepEqual(store.get(workTask.id), beforeWork, 'gate e receipt não podem sobreviver')
  assert.equal(store.get(planTask.id)?.plan?.manualSecurityValidation?.status, 'pending')
  assert.equal(store.get(workTask.id)?.verification?.review, undefined)
  assert.equal(store.get(workTask.id)?.skillUsage, undefined)
})

test('sanitizador do renderer aceita somente campos humanos e falha fechado para estado do harness', (t) => {
  const harnessDirectory = mkdtempSync(join(tmpdir(), 'synkora-renderer-patch-contract-'))
  const userData = join(harnessDirectory, 'user-data')
  mkdirSync(userData, { recursive: true })
  process.env.SYNKORA_TASK_STORE_TEST_USER_DATA = userData
  t.after(() => {
    delete process.env.SYNKORA_TASK_STORE_TEST_USER_DATA
    const safeRoot = resolve(tmpdir()).toLocaleLowerCase('en-US')
    const safeTarget = resolve(harnessDirectory).toLocaleLowerCase('en-US')
    if (safeTarget.startsWith(`${safeRoot}\\`)) {
      rmSync(harnessDirectory, { recursive: true, force: true })
    }
  })
  const { sanitizeRendererTaskPatch } = compileTaskStoreHarness(harnessDirectory)
  assert.equal(typeof sanitizeRendererTaskPatch, 'function')

  const accepted = sanitizeRendererTaskPatch(
    {
      title: 'Novo titulo',
      description: 'Descricao',
      department: 'front',
      type: 'bug',
      effort: 'pesada',
      status: 'backlog'
    },
    { hasActivePane: false }
  )
  assert.equal(accepted.ok, true)
  assert.deepEqual(accepted.patch, {
    title: 'Novo titulo',
    description: 'Descricao',
    department: 'front',
    type: 'bug',
    effort: 'pesada',
    status: 'backlog'
  })

  for (const forbidden of [
    'skillUsage',
    'verification',
    'activePhase',
    'phaseState',
    'phaseStartedAt',
    'phaseResume',
    'phaseSessions',
    'integrationReceipt',
    'gateRound',
    'auto',
    'kind',
    'plan'
  ]) {
    const rejected = sanitizeRendererTaskPatch(
      { title: 'Campo legitimo', [forbidden]: { forged: true } },
      { hasActivePane: false }
    )
    assert.equal(rejected.ok, false, `${forbidden} nao pode atravessar o IPC do renderer`)
  }

  assert.equal(
    sanitizeRendererTaskPatch({ title: 'Edicao concorrente' }, { hasActivePane: true }).ok,
    false
  )
  assert.equal(
    sanitizeRendererTaskPatch({ status: 'done' }, { hasActivePane: true }).ok,
    false
  )
})

test('interrupcao fecha apenas a rodada ativa e conserva receipts das fases anteriores', (t) => {
  const harnessDirectory = mkdtempSync(join(tmpdir(), 'synkora-skill-interruption-contract-'))
  const userData = join(harnessDirectory, 'user-data')
  mkdirSync(userData, { recursive: true })
  process.env.SYNKORA_TASK_STORE_TEST_USER_DATA = userData
  t.after(() => {
    delete process.env.SYNKORA_TASK_STORE_TEST_USER_DATA
    const safeRoot = resolve(tmpdir()).toLocaleLowerCase('en-US')
    const safeTarget = resolve(harnessDirectory).toLocaleLowerCase('en-US')
    if (safeTarget.startsWith(`${safeRoot}\\`)) {
      rmSync(harnessDirectory, { recursive: true, force: true })
    }
  })
  const { interruptActiveSkillUsage } = compileTaskStoreHarness(harnessDirectory)
  assert.equal(typeof interruptActiveSkillUsage, 'function')

  const completed = skillRun({
    phase: 'dev',
    phaseRun: 'run-1',
    runStatus: 'completed',
    receiptId: 'receipt-dev',
    version: 'git:dev-v1',
    fingerprint: 'sha256:dev-v1',
    status: 'applied'
  })
  const active = skillRun({
    phase: 'qa',
    phaseRun: 'run-2',
    runStatus: 'active',
    receiptId: 'receipt-qa',
    version: 'builtin:ui-qa-v1',
    fingerprint: 'sha256:ui-qa-v1',
    status: 'activated'
  })
  const usage = { ...active, history: [completed, active] }
  const interrupted = interruptActiveSkillUsage(usage, '2026-08-07T13:00:00.000Z')

  assert.notEqual(interrupted, usage)
  assert.equal(interrupted.runStatus, 'interrupted')
  assert.deepEqual(interrupted.history[0], completed)
  assert.deepEqual(interrupted.history[1], {
    ...active,
    updatedAt: '2026-08-07T13:00:00.000Z',
    runStatus: 'interrupted'
  })
  assert.equal(interrupted.history[1].skills[0].receiptId, 'receipt-qa')
  assert.equal(interrupted.history[1].skills[0].version, 'builtin:ui-qa-v1')
  assert.equal(interrupted.history[1].skills[0].fingerprint, 'sha256:ui-qa-v1')
  assert.equal(interruptActiveSkillUsage(interrupted), interrupted)
})

test('handler tasks:update usa o sanitizador e nunca encaminha o patch bruto', () => {
  const handler = ipcHandler('tasks:update')
  assert.match(handler, /sanitizeRendererTaskPatch\s*\(/)
  assert.match(handler, /hasActivePane/)
  assert.doesNotMatch(handler, /tasks\.update\s*\(\s*id\s*,\s*patch\s*\)/)
})

test('create e update recusam mais de uma técnica ou persona antes de persistir', () => {
  const createStart = indexSource.indexOf('createTasks: (id, items) => {')
  const updateStart = indexSource.indexOf('updateTask: (id, taskId, patch: TaskPatch) => {')
  assert.notEqual(createStart, -1)
  assert.notEqual(updateStart, -1)
  const create = indexSource.slice(createStart, updateStart)
  const update = indexSource.slice(updateStart, indexSource.indexOf('\n    runTask:', updateStart))

  assert.match(create, /item\.skills\?\.length[\s\S]*>\s*1/)
  assert.match(create, /item\.agents\?\.length[\s\S]*>\s*1/)
  assert.match(create, /item\.deliverable\s*===\s*'code'[\s\S]*typeof item\.affectsUi\s*!==\s*'boolean'/)
  assert.ok(create.indexOf('overloadedSkillPlans') < create.indexOf('tasks.createMany'))
  assert.match(create, /item\.briefing\?\.length[\s\S]*>\s*6000/)
  assert.match(update, /patch\.skills\?\.length[\s\S]*>\s*1/)
  assert.match(update, /patch\.agents\?\.length[\s\S]*>\s*1/)
  assert.match(update, /requestedDeliverable\s*===\s*'code'[\s\S]*typeof \(patch\.affectsUi \?\? t0\.affectsUi\)\s*!==\s*'boolean'/)
  assert.ok(update.indexOf('patch.skills?.length') < update.indexOf('tasks.update(taskId'))
  assert.match(update, /patch\.briefing\?\.length[\s\S]*>\s*6000/)

  const prepare = namedImplementation('preparePhasePaneInner')
  assert.match(prepare, /routedExplicitSkillIds\.length\s*>\s*1/)
  assert.match(prepare, /routedExplicitAgentIds\.length\s*>\s*1/)
  assert.match(prepare, /card legado possui mais de uma skill técnica ou persona/)
})

test('planejamento novo falha fechado e somente execução legada marcada pode criar cards', () => {
  const approve = ipcHandler('tasks:planApprove')
  const evidenceGuard = approve.indexOf('isVerifiedTaskPlanPlanningMethod(task.plan)')
  const approvalMutation = approve.indexOf("tasks.update(taskId, { status: 'execucao', plan })")
  assert.notEqual(evidenceGuard, -1)
  assert.notEqual(approvalMutation, -1)
  assert.ok(evidenceGuard < approvalMutation, 'receipt precisa ser validado antes de aprovar')
  assert.match(approve, /planningEvidenceRequired:\s*true/)
  assert.match(
    approve,
    /planningEvidenceState\s*===\s*'legacy_unverified'[\s\S]*Boolean\(task\.plan\.approvedAt\)/
  )

  const createStart = indexSource.indexOf('createTasks: (id, items) => {')
  const updateStart = indexSource.indexOf('updateTask: (id, taskId, patch: TaskPatch) => {')
  assert.notEqual(createStart, -1)
  assert.notEqual(updateStart, -1)
  const create = indexSource.slice(createStart, updateStart)
  const legacyGuard = create.indexOf("planningEvidenceState === 'legacy_unverified'")
  const verifiedGuard = create.indexOf('isVerifiedTaskPlanPlanningMethod(approvedPlan.plan)')
  const createMutation = create.indexOf('tasks.createMany')
  assert.notEqual(legacyGuard, -1)
  assert.notEqual(verifiedGuard, -1)
  assert.notEqual(createMutation, -1)
  assert.ok(legacyGuard < createMutation)
  assert.ok(verifiedGuard < createMutation)
  assert.match(create, /legacyPlanningPlan[\s\S]*!approvedPlan\.plan\.planningMethod/)
  assert.match(
    create,
    /!isVerifiedTaskPlanPlanningMethod\(approvedPlan\.plan\)\s*&&\s*!legacyPlanningPlan/
  )
})

test('create_plan relê estado após awaits e reaproveita o mesmo card sem grafo antigo', () => {
  const createPlan = mcpApiImplementation('createPlan')
  const asynchronousCatalog = createPlan.indexOf('await agentModelPool')
  const receipt = createPlan.indexOf('preparePlanningArtifactEvidence')
  const rereadMission = createPlan.indexOf('const currentMission = missions.get', receipt)
  const rereadPlans = createPlan.indexOf('const currentExisting = tasks', rereadMission)
  const linkedCardsCas = createPlan.indexOf('currentLinkedCardState !== initialLinkedCardState')
  const linkedCardsGuard = createPlan.indexOf('currentLinkedCards.some', linkedCardsCas)
  const target = createPlan.indexOf('currentRunningPlan ?? currentExisting.find', linkedCardsGuard)
  const mutation = createPlan.indexOf('tasks.update(proposed.id', target)
  const create = createPlan.indexOf('tasks.createMany', mutation)

  assert.ok(asynchronousCatalog >= 0)
  assert.ok(receipt > asynchronousCatalog)
  assert.ok(rereadMission > receipt && rereadPlans > rereadMission)
  assert.ok(linkedCardsCas > rereadPlans && linkedCardsGuard > linkedCardsCas)
  assert.ok(target > linkedCardsGuard && mutation > target && create > mutation)
  assert.match(createPlan, /currentPlanState\s*!==\s*initialPlanState/)
  assert.match(createPlan, /status:\s*'backlog'[\s\S]*title:\s*input\.title[\s\S]*plan/)
  assert.doesNotMatch(
    createPlan,
    /tasks\.update\(runningPlan\.id,\s*\{\s*status:\s*'backlog'/,
    'a pausa não pode ser um commit separado antes do upsert'
  )
})

test('grandfathering do plano mestre depende de marker one-shot fora do workspace', () => {
  const migrationLoop = indexSource.indexOf('for (const project of projects.list())')
  const planLoad = indexSource.indexOf('const plan = loadProjectPlan(project.path)', migrationLoop)
  const stamp = indexSource.indexOf('projects.migratePlanningTrust(project.id, legacyApproval)', planLoad)
  assert.ok(migrationLoop >= 0 && planLoad > migrationLoop && stamp > planLoad)
  assert.match(indexSource.slice(migrationLoop, stamp + 100), /planningTrustVersion/)

  const validationCalls = [...indexSource.matchAll(/requireTrustedEvidence:\s*true/g)]
  assert.ok(validationCalls.length >= 4)
  assert.ok(
    validationCalls.every((match) =>
      indexSource.slice(match.index, match.index + 180).includes('trustedLegacyApproval')
    ),
    'toda fronteira de produção precisa cruzar o legacy com o control-plane'
  )

  const setEvidenceStart = projectsSource.indexOf('setPlanningEvidence(')
  const setEvidenceEnd = projectsSource.indexOf('\n  migratePlanningTrust(', setEvidenceStart)
  const setEvidence = projectsSource.slice(setEvidenceStart, setEvidenceEnd)
  assert.match(setEvidence, /else delete updated\.legacyPlanningApproval/)
  const migrateStart = projectsSource.indexOf('migratePlanningTrust(')
  const migrateEnd = projectsSource.indexOf('\n  remove(', migrateStart)
  const migrate = projectsSource.slice(migrateStart, migrateEnd)
  assert.match(migrate, /planningTrustVersion[\s\S]*>=\s*PROJECT_PLAN_TRUST_CONTRACT_VERSION/)
  assert.ok(
    migrate.indexOf('persistJsonStore(this.file, next)') < migrate.indexOf('this.projects = next'),
    'o marker control-plane precisa pousar no disco antes de virar autoridade em memória'
  )
})

test('TaskStore migra evidência de planejamento sem promover proposta nova inválida', (t) => {
  const harnessDirectory = mkdtempSync(join(tmpdir(), 'synkora-planning-evidence-migration-'))
  const userData = join(harnessDirectory, 'user-data')
  mkdirSync(userData, { recursive: true })
  process.env.SYNKORA_TASK_STORE_TEST_USER_DATA = userData
  t.after(() => {
    delete process.env.SYNKORA_TASK_STORE_TEST_USER_DATA
    rmSync(harnessDirectory, { recursive: true, force: true })
  })

  const receipt = {
    contractVersion: 1,
    receiptId: 'receipt-planning-verified',
    skillId: 'synkora-planning-standard',
    operation: 'plan',
    version: 'bundled:test',
    fingerprint: 'sha256:planning-test',
    phaseRun: 'planning-run-test',
    appliedAt: '2026-08-07T12:00:00.000Z'
  }
  writeFileSync(
    join(userData, 'tasks.json'),
    `${JSON.stringify([
      {
        id: 'plan-new-invalid',
        projectId: 'project-planning',
        missionId: 'mission-planning',
        title: 'Proposta sem receipt',
        status: 'backlog',
        kind: 'plan',
        plan: { summary: 'Nova proposta', lanes: [] }
      },
      {
        id: 'plan-running-legacy',
        projectId: 'project-planning',
        missionId: 'mission-planning',
        title: 'Plano legado em execução',
        status: 'execucao',
        kind: 'plan',
        plan: { summary: 'Execução anterior ao contrato', lanes: [] }
      },
      {
        id: 'plan-paused-legacy',
        projectId: 'project-planning',
        missionId: 'mission-planning',
        title: 'Plano legado pausado depois da aprovação',
        status: 'backlog',
        kind: 'plan',
        plan: {
          summary: 'Plano anteriormente aprovado',
          lanes: [],
          approvedAt: '2026-08-01T10:00:00.000Z'
        }
      },
      {
        id: 'plan-new-verified',
        projectId: 'project-planning',
        missionId: 'mission-planning',
        title: 'Proposta com receipt',
        status: 'backlog',
        kind: 'plan',
        plan: { summary: 'Nova proposta governada', lanes: [], planningMethod: receipt }
      }
    ], null, 2)}\n`,
    'utf8'
  )

  const { TaskStore, isVerifiedTaskPlanPlanningMethod } = compileTaskStoreHarness(harnessDirectory)
  const store = new TaskStore()
  const invalid = store.get('plan-new-invalid')
  const legacy = store.get('plan-running-legacy')
  const pausedLegacy = store.get('plan-paused-legacy')
  const verified = store.get('plan-new-verified')
  assert.equal(invalid?.plan?.planningEvidenceState, 'receipt_required')
  assert.equal(legacy?.plan?.planningEvidenceState, 'legacy_unverified')
  assert.equal(pausedLegacy?.plan?.planningEvidenceState, 'legacy_unverified')
  assert.equal(verified?.plan?.planningEvidenceState, 'verified')
  assert.equal(isVerifiedTaskPlanPlanningMethod(invalid?.plan), false)
  assert.equal(isVerifiedTaskPlanPlanningMethod(legacy?.plan), false)
  assert.equal(isVerifiedTaskPlanPlanningMethod(pausedLegacy?.plan), false)
  assert.equal(isVerifiedTaskPlanPlanningMethod(verified?.plan), true)
})

test('receipts stale, foreign ou não ativados são recusados antes de qualquer artefato', () => {
  const guard = namedImplementation('preparePlanningArtifactEvidence')
  assert.match(guard, /hub\.identityByPane\(id\.paneId\)/)
  assert.match(guard, /scope\.projectId\s*!==\s*id\.projectId/)
  assert.match(guard, /scope\.missionId\s*!==\s*id\.missionId/)
  assert.match(guard, /phaseRun:\s*scope\.phaseRun/)
  assert.match(guard, /skillRuntime\.guardReport/)
  assert.match(guard, /receipt\.skillId\s*!==\s*SYNKORA_PLANNING_STANDARD_ID/)
  assert.match(guard, /receipt\.operation\s*!==\s*'plan'/)
  assert.match(guard, /!receipt\.activatedAt/)

  for (const [method, firstMutation] of [
    ['createPlan', /tasks\.(?:update|createMany)\s*\(/],
    ['saveProjectPlan', /saveProjectPlanDraft\s*\(/],
    ['createMission', /createMissionImpl\s*\(/]
  ]) {
    const body = mcpApiImplementation(method)
    const preparation = body.indexOf('preparePlanningArtifactEvidence')
    const refusal = body.indexOf('if (!planningEvidence.ok)')
    const mutation = body.search(firstMutation)
    assert.notEqual(preparation, -1, `${method} não prepara evidence`)
    assert.notEqual(refusal, -1, `${method} não falha fechado`)
    assert.notEqual(mutation, -1, `${method} não contém mutação esperada`)
    assert.ok(preparation < refusal, `${method} testa erro antes de preparar evidence`)
    assert.ok(refusal < mutation, `${method} pode mutar antes de recusar receipt inválido`)
  }
})

test('lista fechada de reprovação nunca é truncada silenciosamente', () => {
  const advance = namedImplementation('advancePhaseInner')
  assert.doesNotMatch(advance, /trim\(\)\.slice\(0,\s*(?:1500|2000)\)/)
  const mcpSource = readFileSync(join(root, 'src', 'main', 'mcpServer.ts'), 'utf8')
  const reportSchema = mcpSource.slice(
    mcpSource.indexOf("server.registerTool(\n    'report'"),
    mcpSource.indexOf("server.registerTool(\n    'status_note'")
  )
  assert.match(reportSchema, /reason:\s*z[\s\S]*?\.max\(4000\)/)
})

test('nova rodada de skill anexa recibos completos e conserva o historico anterior', () => {
  const body = namedImplementation('preparePhasePaneInner')
  assert.match(body, /receiptId\s*:\s*receipt\.receiptId/)
  assert.match(body, /version\s*:\s*receipt\.version/)
  assert.match(body, /fingerprint\s*:\s*receipt\.fingerprint/)
  assert.match(body, /history\s*:\s*\[[\s\S]*\.\.\.priorHistory[\s\S]*usageRun[\s\S]*\]/)
  assert.match(body, /run\.phaseRun\s*!==\s*phaseRun/)
})

test('release do plano ativo persiste interrupted na rodada exata antes de apagar receipts', () => {
  const body = namedImplementation('releasePaneSkillPlan')
  assert.match(body, /scope\.taskId/)
  assert.match(body, /tasks\.update\s*\(/)
  assert.match(body, /phaseRun/)
  assert.match(body, /interruptActiveSkillUsage\s*\(/)
  assert.ok(
    body.indexOf('tasks.update') < body.indexOf('skillRuntime.release'),
    'interrupcao deve ser persistida antes de o ledger volatil ser liberado'
  )
})

test('panes vivos recebem receipts novos e o bloco renovado antes de cada novo report', () => {
  const renew = namedImplementation('renewLivePaneSkillRun')
  const retry = namedImplementation('retryOrBacklog')
  const gate = namedImplementation('openGatePane')

  assert.match(renew, /const phaseRun = randomUUID\(\)/)
  assert.match(renew, /skillRuntime\.replacePanePlan/)
  assert.match(renew, /commit:[\s\S]*tasks\.update\(taskId,[\s\S]*skillUsage/)
  assert.doesNotMatch(renew, /skillRuntime\.release[\s\S]*skillRuntime\.planPane/)
  assert.match(renew, /receiptId:\s*receipt\.receiptId/)
  assert.match(renew, /version:\s*receipt\.version/)
  assert.match(renew, /fingerprint:\s*receipt\.fingerprint/)
  assert.match(retry, /renewLivePaneSkillRun[\s\S]*renewedSkillsBlock/)
  assert.match(gate, /renewLivePaneSkillRun[\s\S]*buildGateRecyclePrompt\(\{[\s\S]*renewedSkillsBlock/)
  const renewalCall = gate.indexOf('await renewLivePaneSkillRun')
  const waitRelease = gate.indexOf('liveGateWaits.delete(watch.taskId)', renewalCall)
  assert.ok(
    renewalCall >= 0 && waitRelease > renewalCall,
    'o wait antigo permanece autoritativo ate a troca duravel da rodada terminar'
  )
})

test('persona selecionada exige conclusao do helper na mesma phaseRun', () => {
  assert.match(indexSource, /const plannedHelperAssignments = new Map/)
  assert.match(indexSource, /const completedPlannedAgentsByPhaseRun = new Map/)
  assert.match(
    indexSource,
    /plannedHelperAssignments\.set\(armed\.paneId,[\s\S]*parentPhaseRun:\s*parentScope\.phaseRun[\s\S]*agentId:\s*agentDef\.id/
  )
  assert.match(
    indexSource,
    /acceptedHelperReport[\s\S]*completedPlannedAgentsByPhaseRun\.set/
  )
  assert.match(
    indexSource,
    /requiredAgentId[\s\S]*completedPlannedAgentsByPhaseRun[\s\S]*nenhum ajudante com essa persona concluiu/
  )
})

test('renovacao revalida o pane depois do await e nunca ressuscita receipt ativo', () => {
  const renew = namedImplementation('renewLivePaneSkillRun')
  const retry = namedImplementation('retryOrBacklog')
  const cleanupAwait = renew.search(/await\s+gitOff\(\s*['"]removePrivateSkillPlan['"]/)
  const identityCheckpoint = renew.indexOf('const renewedIdentity = hub.identityByPane')
  const replacement = renew.indexOf('skillRuntime.replacePanePlan')
  const persistence = renew.indexOf('tasks.update(taskId', replacement)

  assert.notEqual(cleanupAwait, -1)
  assert.notEqual(identityCheckpoint, -1)
  assert.notEqual(persistence, -1)
  assert.ok(persistence < cleanupAwait, 'a fotografia nova deve ser durável antes do swap/cleanup')
  assert.ok(cleanupAwait < identityCheckpoint, 'checkpoint deve ocorrer depois do await vulneravel')
  assert.doesNotMatch(renew, /const interruptedUsage = interruptActiveSkillUsage/)
  assert.match(renew, /!ptys\.has\(paneId\)/)
  assert.match(renew, /renewedScope\?\.phaseRun\s*!==\s*phaseRun/)
  assert.match(renew, /releasePaneSkillPlan\(paneId\)/)
  assert.match(retry, /renewedPlanDelivery[\s\S]*===\s*'dead'[\s\S]*preparePhasePane/)
})

test('remocao encerra/desregistra panes antes de apagar task e worktree', () => {
  const remove = namedImplementation('removeTaskCascade')
  const terminate = namedImplementation('terminateTaskPhasePane')
  const terminateNow = namedImplementation('terminatePaneNow')
  const terminatePosition = remove.indexOf('terminateTaskPhasePane')
  const stateRemovalPosition = remove.indexOf('tasks.remove')
  const worktreeRemovalPosition = remove.indexOf('removeWorktreeAndBranch')

  assert.notEqual(terminatePosition, -1, 'removeTaskCascade precisa encerrar as fases')
  assert.notEqual(stateRemovalPosition, -1)
  assert.notEqual(worktreeRemovalPosition, -1)
  assert.ok(terminatePosition < stateRemovalPosition, 'pane deve cair antes do estado')
  assert.ok(stateRemovalPosition < worktreeRemovalPosition, 'estado deve cair antes do worktree')
  assert.match(remove, /liveGateWaits/)
  assert.match(remove, /candidate\.taskId\s*===\s*task\.id/)
  assert.match(remove, /pane\.role\s*===\s*'ajudante'[\s\S]*helperCompletions\.discard/)
  assert.match(remove, /pane\.role\s*===\s*'ajudante'[\s\S]*terminatePaneNow/)
  assert.match(terminate, /terminatePaneNow\s*\(/)
  assert.ok(
    terminateNow.indexOf('unregisterPane') < terminateNow.indexOf('ptys.kill'),
    'desregistro deve preceder o kill para onExit nao simular crash'
  )
})

test('reconciliador de watch obsoleto encerra tambem o PTY que ainda estiver vivo', () => {
  const conditionStart = indexSource.indexOf(
    'if (!task || (task.status !== activeStatus && !existsSync(watch.marker)))'
  )
  assert.notEqual(conditionStart, -1, 'ramo de reconciliacao de watch obsoleto nao encontrado')
  const openingBrace = indexSource.indexOf('{', conditionStart)
  const staleBranch = balancedBlock(indexSource, openingBrace)
  assert.match(
    staleBranch,
    /terminate(?:TaskPhasePane|PaneNow)\s*\(/,
    'watch obsoleto com PTY vivo precisa encerrar a fase, nao apenas esquecer o registro'
  )
})

test('crash do dev encerra o helper do mesmo card antes da retomada', () => {
  const terminateHelpers = namedImplementation('terminateTaskHelpers')
  assert.match(terminateHelpers, /pane\.role\s*===\s*'ajudante'/)
  assert.match(terminateHelpers, /pane\.taskId\s*===\s*taskId/)
  assert.match(terminateHelpers, /helperCompletions\.discard/)
  assert.match(terminateHelpers, /updateStoredHelperStatus[\s\S]*'interrupted'/)
  assert.match(terminateHelpers, /terminatePaneNow/)

  const crashBranch = indexSource.slice(
    indexSource.indexOf("if (watch.phase === 'review' || watch.phase === 'qa')"),
    indexSource.indexOf("if (!sender.isDestroyed()) sender.send('tasks:changed'", 0)
  )
  assert.match(crashBranch, /else\s*\{[\s\S]*terminateTaskHelpers[\s\S]*status:\s*'backlog'/)
})

test('encerramento deliberado de QA sempre derruba o runtime separado', () => {
  const terminateNow = namedImplementation('terminatePaneNow')
  const terminatePhase = namedImplementation('terminateTaskPhasePane')
  const closeWait = namedImplementation('closeLiveGateWait')
  const remove = namedImplementation('removeTaskCascade')

  assert.match(terminateNow, /terminatingRole\s*===\s*'qa'[\s\S]*stopQaRuntime/)
  assert.ok(
    terminateNow.indexOf('stopQaRuntime') < terminateNow.indexOf('unregisterPane'),
    'runtime deve cair antes de a identidade do QA ser apagada'
  )
  assert.match(terminatePhase, /role\s*===\s*'qa'[\s\S]*stopQaRuntime\(taskId\)/)
  assert.match(closeWait, /wait\.phase\s*===\s*'qa'[\s\S]*stopQaRuntime\(taskId\)/)
  assert.match(remove, /\['dev', 'review', 'qa'\][\s\S]*terminateTaskPhasePane/)
  const prepare = namedImplementation('preparePhasePaneInner')
  assert.match(
    prepare,
    /blockForMissingFrontendStandard[\s\S]*phase\s*===\s*'qa'[\s\S]*stopQaRuntime\(taskId\)/
  )
  assert.match(
    prepare,
    /phase-prepare-cancelled[\s\S]*return null/
  )
})

test('ruling publicado durante o preparo reconstrói o prompt antes de armar o gate', () => {
  const prepare = namedImplementation('preparePhasePaneInner')
  assert.match(
    prepare,
    /const assemblePhasePrompt[\s\S]*gateNotes:\s*currentGateNotes[\s\S]*buildPhasePrompt/
  )
  assert.match(
    prepare,
    /currentTaskBeforeArm\.gateNotes[\s\S]*prompt\s*=\s*assemblePhasePrompt\([\s\S]*currentTaskBeforeArm\.gateNotes/
  )
  assert.ok(
    prepare.indexOf("event: 'phase-prompt-refreshed'") < prepare.indexOf('armed = armPane('),
    'o refresh da decisão precisa ocorrer antes de publicar a identidade do pane'
  )
  assert.match(
    prepare,
    /latestBase\s*===\s*latestDelivered\?\.head[\s\S]*!latestRulingChanged[\s\S]*return null/
  )
})

test('recovery de boot fecha usage ativa porque receipts em memoria nao sobrevivem ao crash', () => {
  const recoveryStart = indexSource.indexOf('// RECUPERAÇÃO PÓS-FECHAMENTO/CRASH')
  assert.notEqual(recoveryStart, -1)
  const recoveryEnd = indexSource.indexOf('for (const m of missions.list', recoveryStart)
  assert.notEqual(recoveryEnd, -1)
  const recovery = indexSource.slice(recoveryStart, recoveryEnd)
  assert.match(recovery, /interruptActiveSkillUsage\(t\.skillUsage\)/)
  assert.match(recovery, /tasks\.update\(t\.id, \{ skillUsage: recoveredSkillUsage \}\)/)
})
