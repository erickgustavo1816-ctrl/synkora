// CRIAÇÃO DE MISSÃO PELO DONO — o canal `missions:create` do renderer.
//
// Por que este harness existe: até 2026-08-13 o handler carregava uma cerca da
// era F6 que RECUSAVA (`return null`) toda missão criada pelo dono em projeto
// modo `greenfield` cujo plano mestre não estivesse `done` — "missão avulsa
// bloqueada: este projeto novo ainda segue o plano mestre". No 2.0 o dono É o
// orquestrador e cria missão em qualquer projeto, então a cerca saiu. Este é o
// teste que impede a volta dela: o handler REAL roda aqui, com o projeto no
// estado exato que a cerca vigiava (greenfield + plano em rascunho).
//
// Mecânica: `src/main/ipc/missions.ts` é compilado para CJS (fecho de ~69
// módulos por `tsc --noCheck`, precedente test-phase-verdict-races.mjs) e o
// `electron` é trocado por um stub via `Module._load` — `ipcMain.handle` vira
// um registro de handlers que o teste invoca à mão, como o renderer faria.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const COMPILED = join(import.meta.dirname, '..', '.tmp', 'mission-creation-test')

// ——— stub do electron, instalado ANTES de requerer o fecho compilado ———
const userData = mkdtempSync(join(tmpdir(), 'synkora-mission-create-'))
process.on('exit', () => rmSync(userData, { recursive: true, force: true }))

/** canal → handler, preenchido pelo registerMissionsIpc real. */
const handlers = new Map()
const electronStub = {
  app: {
    getPath: () => userData,
    isPackaged: false,
    getName: () => 'synkora',
    getVersion: () => '0.0.0-test',
    // módulos do fecho registram will-quit/before-quit no require — no-ops
    on: () => electronStub.app,
    once: () => electronStub.app,
    off: () => electronStub.app,
    whenReady: () => Promise.resolve()
  },
  ipcMain: {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: () => {},
    removeHandler: (channel) => handlers.delete(channel)
  },
  shell: { openExternal: () => {} },
  dialog: {},
  BrowserWindow: class {},
  Notification: class {
    static isSupported() {
      return false
    }
    on() {}
    show() {}
  },
  clipboard: {},
  nativeImage: {},
  net: {},
  safeStorage: { isEncryptionAvailable: () => false }
}
const loadModule = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  return loadModule.call(this, request, parent, isMain)
}

const { registerMissionsIpc } = require(join(COMPILED, 'ipc', 'missions.js'))
const { createMissionEngine } = require(join(COMPILED, 'missionEngine.js'))

/**
 * Registra o IPC real com o MÍNIMO que o `registerMissionsIpc` desestrutura na
 * construção e devolve o handler de `missions:create` + os espiões.
 *
 * O plano MESTRE F6 e a classificação greenfield×existente saíram do app na
 * limpa F6 (2026-08-17): não há mais o que espionar neste caminho.
 */
function createHarness({
  versionChoices = { versions: [], defaultVersionId: undefined }
} = {}) {
  handlers.clear()
  const calls = []
  const published = []
  const versionChoiceReads = []
  const ctx = {
    projects: { get: (id) => ({ id }) },
    seats: {},
    missions: {},
    tasks: {},
    backlog: {
      missionVersionChoices: (projectId) => {
        versionChoiceReads.push(projectId)
        return versionChoices
      }
    },
    maestro: {},
    integrationQueue: {},
    ptys: {},
    blackbox: { record: () => {} },
    hub: { publish: (event) => published.push(event) },
    syncBoard: () => {},
    orchPaneId: (projectId, missionId) => `${projectId}--${missionId}`,
    unregisterPane: () => {},
    releasePaneSkillLease: () => {}
  }
  const extras = {
    engine: {
      missionsWithIntegration: () => [],
      createMissionImpl: (projectId, input, actor) => {
        calls.push({ projectId, input, actor })
        return { id: `mission-${calls.length}`, projectId, ...input }
      },
      emitMissionsChanged: () => {},
      ensureMissionWorktree: () => undefined,
      missionWorkspacePath: () => undefined,
      scheduleIntegrationDrain: () => {},
      startMissionIntegration: () => undefined,
      stopMissionExecution: () => {}
    },
    maestroEngine: {
      maestroResumeOverBudget: () => false,
      skipMaestroResume: () => {},
      preparePlanningRun: () => undefined
    },
    orchKey: (projectId, missionId) => `${projectId}--${missionId}`,
    emitBacklogChanged: () => {},
    staggerPaneSpawn: () => {},
    armPane: () => {},
    releasePaneSkillPlan: () => {},
    guiSessions: {},
    killMissionGuiPanes: () => {}
  }
  registerMissionsIpc(ctx, extras)
  const create = handlers.get('missions:create')
  assert.ok(create, 'o canal missions:create precisa existir')
  return { create, calls, published, versionChoiceReads }
}

/**
 * Exercises the real engine without creating a git worktree. The persistence
 * double returns a planning mission only so worktree creation stops early;
 * the captured input remains the normal mission payload under test.
 */
function createMissionEngineHarness(versionChoices) {
  const createdInputs = []
  const stored = new Map()
  let defaultEnsures = 0
  const project = { id: 'proj-1', path: 'C:\\projeto-sintetico' }
  const ctx = {
    projects: { get: (id) => (id === project.id ? project : undefined) },
    missions: {
      create: (projectId, input) => {
        const mission = {
          id: `mission-${createdInputs.length + 1}`,
          projectId,
          title: input.title,
          ...input,
          // Avoids git I/O; the captured input above keeps its real nature.
          missionType: 'planejamento',
          status: 'ativa',
          createdAt: '2026-08-14T12:00:00.000Z',
          updatedAt: '2026-08-14T12:00:00.000Z'
        }
        createdInputs.push(input)
        stored.set(mission.id, mission)
        return mission
      },
      get: (id) => stored.get(id)
    },
    backlog: {
      missionVersionChoices: (projectId) =>
        projectId === project.id ? versionChoices : { versions: [], defaultVersionId: undefined },
      ensureDefaultVersion: () => {
        defaultEnsures += 1
        return versionChoices.versions[0]
      }
    },
    tasks: {},
    integrationQueue: {},
    maestro: {},
    ptys: {},
    blackbox: {},
    mainStalls: {},
    skillsLib: {},
    helperCompletions: {},
    helperReported: new Set(),
    helperSeen: new Set(),
    hub: { publish: () => {} },
    pushAll: () => {},
    syncBoard: () => {},
    scheduleProgressSnapshot: () => {},
    orchPaneId: (projectId, missionId) => `${projectId}--${missionId}`,
    unregisterPane: () => {},
    ensureProjectRuntimeWritable: () => true
  }
  const engine = createMissionEngine(ctx, {
    orchKey: (projectId, missionId) => `${projectId}--${missionId}`,
    securityWaiverOptions: () => ({ sensitiveWaiverAllowed: false }),
    currentPlanOf: () => undefined,
    finalVerificationAccepted: () => false,
    versionIsolationIsValid: () => false,
    emitBacklogChanged: () => {},
    sweepProjectFiles: () => 0,
    closeTestServersUnder: () => {},
    deliverToGuiPane: () => false,
    killMissionGuiPanes: () => {}
  })
  return { create: engine.createMissionImpl, createdInputs, defaultEnsures: () => defaultEnsures }
}

test('o dono cria missão DIRETA e nada no projeto pode recusá-la', () => {
  const { create, calls, published } = createHarness()

  const mission = create({}, 'proj-1', { title: 'Ajustar a máscara de CNPJ' })

  // A cerca morta devolvia null aqui. Missão de verdade = cerca enterrada.
  assert.ok(mission, 'missão do dono não pode ser recusada por modo de projeto')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].projectId, 'proj-1')
  assert.equal(calls[0].actor, 'user', 'a autoria é do DONO, nunca de um agente')
  assert.equal(calls[0].input.title, 'Ajustar a máscara de CNPJ')
  // 2.0: missão do dono nasce DIRETA — sem orquestrador, sem plano, chat no centro.
  assert.equal(calls[0].input.direct, true)
  assert.equal(mission.direct, true)

  assert.deepEqual(
    published.filter((event) => event.kind === 'error'),
    [],
    'criar missão não publica erro no hub'
  )
})

test('a criação de missão não consulta mais nenhum estado de projeto', () => {
  // A cerca do plano mestre (greenfield × existente × status do roadmap) saiu
  // do app na limpa F6. O harness já não oferece `projectModeOf` nem
  // `projectPlanOf` no contexto: se o caminho voltar a lê-los, este teste
  // quebra antes de qualquer asserção.
  for (const title of ['missão A', 'missão B', 'missão C']) {
    const { create, calls } = createHarness()
    const mission = create({}, 'proj-1', { title })
    assert.ok(mission, `recusa indevida em "${title}"`)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].input.direct, true)
  }
})

test('o renderer recebe as versoes elegiveis e o padrao da fonte canonica', () => {
  const choices = {
    versions: [
      { id: 'version-current', projectId: 'proj-1', name: 'V1.2', status: 'aberta' },
      { id: 'version-next', projectId: 'proj-1', name: 'V2.0', status: 'aberta' }
    ],
    defaultVersionId: 'version-current'
  }
  const { versionChoiceReads } = createHarness({ versionChoices: choices })
  const readChoices = handlers.get('missions:versionChoices')
  assert.ok(readChoices, 'o canal de escolhas de versao precisa existir')

  assert.strictEqual(readChoices({}, 'proj-1'), choices)
  assert.deepEqual(versionChoiceReads, ['proj-1'])
})

test('o motor persiste a versao elegivel escolhida pelo dono', () => {
  const { create, createdInputs, defaultEnsures } = createMissionEngineHarness({
    versions: [
      { id: 'version-current', projectId: 'proj-1', name: 'V1.2', status: 'aberta' },
      { id: 'version-selected', projectId: 'proj-1', name: 'V2.0', status: 'aberta' }
    ],
    defaultVersionId: 'version-current'
  })

  const mission = create(
    'proj-1',
    { title: 'Levar o checkout para V2', versionId: 'version-selected', direct: true },
    'user'
  )

  assert.equal(mission?.versionId, 'version-selected')
  assert.equal(createdInputs.length, 1)
  assert.equal(createdInputs[0].versionId, 'version-selected')
  assert.equal(defaultEnsures(), 0, 'uma escolha explicita nunca cai no default')
})

test('o motor usa o default atual quando nenhuma versao e escolhida', () => {
  const { create, createdInputs, defaultEnsures } = createMissionEngineHarness({
    versions: [{ id: 'version-current', projectId: 'proj-1', name: 'V1.2', status: 'aberta' }],
    defaultVersionId: 'version-current'
  })

  const mission = create('proj-1', { title: 'Missao sem escolha explicita', direct: true }, 'user')

  assert.equal(mission?.versionId, 'version-current')
  assert.equal(createdInputs[0].versionId, 'version-current')
  assert.equal(defaultEnsures(), 1)
})

test('o motor recusa versao lancada ou estrangeira antes de persistir', () => {
  const { create, createdInputs, defaultEnsures } = createMissionEngineHarness({
    versions: [{ id: 'version-open', projectId: 'proj-1', name: 'V2.0', status: 'aberta' }],
    defaultVersionId: 'version-open'
  })

  assert.equal(
    create('proj-1', { title: 'Nao pode ir para lancada', versionId: 'version-released' }, 'user'),
    null
  )
  assert.equal(
    create('proj-1', { title: 'Nao pode ir para outro projeto', versionId: 'version-foreign' }, 'user'),
    null
  )
  assert.equal(createdInputs.length, 0)
  assert.equal(defaultEnsures(), 0, 'ID invalido nao pode ser trocado silenciosamente pelo default')
})

test('título vazio continua sendo recusado pelo motor, não por política de plano', () => {
  const { create } = createHarness()
  // createMissionImpl real devolve null para título vazio; aqui o espião
  // devolve objeto, então o que se prova é que o HANDLER não filtra nada
  // antes dele — a validação de conteúdo é do motor, caminho único.
  const mission = create({}, 'proj-1', { title: '   ' })
  assert.ok(mission)
})

test('direct explícito é respeitado — o handler não force-flipa a natureza', () => {
  const { create, calls } = createHarness()
  create({}, 'proj-1', { title: 'missão legada', direct: false })
  assert.equal(calls[0].input.direct, false)
})

test('seat removido invalida resume e executor antes de reabrir no mesmo CLI', () => {
  handlers.clear()
  const identityResets = []
  const executorChanges = []
  const killed = []
  const mission = {
    id: 'mission-seat',
    projectId: 'proj-1',
    title: 'Missão sintética',
    goal: 'Validar troca de conta',
    direct: true,
    status: 'ativa',
    seatId: 'seat-que-foi-removido',
    worktree: 'C:\\workspace-sintetico'
  }
  const nextSeat = { id: 'seat-novo', name: 'Conta nova', cli: 'claude' }
  const ctx = {
    projects: { get: () => ({ id: 'proj-1', path: 'C:\\projeto-sintetico' }) },
    seats: { get: (id) => (id === nextSeat.id ? nextSeat : undefined) },
    missions: {
      get: (id) => (id === mission.id ? mission : undefined),
      setExecutorSeat: (id, seatId, options) => {
        executorChanges.push({ id, seatId, options })
        return { ...mission, seatId, model: undefined, effort: undefined }
      }
    },
    tasks: {},
    backlog: {},
    maestro: {},
    integrationQueue: {},
    ptys: {},
    blackbox: { record: () => {} },
    hub: { publish: () => {} },
    syncBoard: () => {},
    orchPaneId: (projectId, missionId) => `${projectId}--${missionId}`,
    unregisterPane: () => {},
    releasePaneSkillLease: () => {}
  }
  const extras = {
    engine: {
      missionsWithIntegration: () => [],
      emitMissionsChanged: () => {},
      ensureMissionWorktree: () => undefined,
      missionWorkspacePath: () => undefined,
      scheduleIntegrationDrain: () => {},
      startMissionIntegration: () => undefined,
      stopMissionExecution: () => {}
    },
    maestroEngine: {
      maestroResumeOverBudget: () => false,
      skipMaestroResume: () => {},
      preparePlanningRun: () => undefined
    },
    orchKey: (projectId, missionId) => `${projectId}--${missionId}`,
    emitBacklogChanged: () => {},
    staggerPaneSpawn: () => {},
    armPane: () => {},
    releasePaneSkillPlan: () => {},
    guiSessions: {
      forgetSessionIdentity: (paneId) => identityResets.push(paneId),
      forgetSession: () => assert.fail('identidade desconhecida exige reset completo')
    },
    killMissionGuiPanes: (missionId) => killed.push(missionId)
  }
  registerMissionsIpc(ctx, extras)

  const setChatSeat = handlers.get('missions:setChatSeat')
  assert.ok(setChatSeat)
  const result = setChatSeat({}, 'proj-1', mission.id, nextSeat.id)

  assert.equal(result.ok, true)
  assert.match(result.msg, /conta anterior não existe mais/u)
  assert.deepEqual(executorChanges, [
    {
      id: mission.id,
      seatId: nextSeat.id,
      options: { resetExecutor: true }
    }
  ])
  assert.equal(identityResets.length, 10, 'dev, reviewer e oito vagas de ajudante')
  assert.ok(identityResets.some((paneId) => paneId.startsWith('gui-dev-')))
  assert.ok(identityResets.some((paneId) => /^gui-helper-.+-8$/u.test(paneId)))
  assert.deepEqual(killed, [mission.id])
})
