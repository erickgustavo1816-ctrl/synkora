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

// APOSENTADORIA (2026-08-09, decisao registrada no HANDOFF_FASE2 item 3a e
// executada na fase 5): 26 testes de ANCORA TEXTUAL no src/main/index.ts
// morreram quando a Fase 1 moveu as implementacoes para phaseEngine/mcpApi/
// ipc (a ordem R7/R8 e o rollback do report viraram rollbackVerdictTransaction).
// A cobertura substituta e COMPORTAMENTAL, com o engine real:
// test:phase-verdict-races (18) + test:phase-transition-lock (9) +
// test:orchestrator-flow (39) + test:codex-skill-isolation (7).
// Ficam aqui apenas os testes comportamentais (TaskStore real, reader
// privado, sanitizador, reservas de helper) - nunca reintroduzir grep de
// texto sobre o index como contrato.

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

test('recovery de boot fecha usage ativa porque receipts em memoria nao sobrevivem ao crash', () => {
  const recoveryStart = indexSource.indexOf('// RECUPERAÇÃO PÓS-FECHAMENTO/CRASH')
  assert.notEqual(recoveryStart, -1)
  const recoveryEnd = indexSource.indexOf('for (const m of missions.list', recoveryStart)
  assert.notEqual(recoveryEnd, -1)
  const recovery = indexSource.slice(recoveryStart, recoveryEnd)
  assert.match(recovery, /interruptActiveSkillUsage\(t\.skillUsage\)/)
  assert.match(recovery, /tasks\.update\(t\.id, \{ skillUsage: recoveredSkillUsage \}\)/)
})
