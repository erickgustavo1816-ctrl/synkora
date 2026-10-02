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
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const COMPILED = join(import.meta.dirname, '..', '.tmp', 'mission-creation-test', 'main')

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
// ——— stub do gitAsync: o gitWorker sem worker (rodada 7, adendo C2) ———
//
// O motor manda TODO git para fora do main thread por `gitOff('<export de
// worktree.ts>', …)`, e o worker real faz literalmente `registry[fn](...args)`
// sobre `{...worktree}`. Aqui o despacho é o MESMO, só que em processo: o
// arquivo de entrada do worker não é emitido por este tsc (nada o importa), e
// levantar uma Worker thread para provar decisão de missão seria testar o
// carteiro, não a carta. Assim as chamadas ficam observáveis (ordem inclusive)
// e o git que roda é o de verdade, contra repositórios temporários.
const gitOffCalls = []
/** Cada teste pode trocar o comportamento (ex.: falha dura do git). */
let gitOffOverride = null
/** Fotografia tirada NO INSTANTE da chamada — prova de ordem do seam. */
let gitOffProbe = null
let executingWorkerGit = false
const gitAsyncStub = {
  GIT_CHECKPOINT_MARKER: '__SYNKORA_GIT_CHECKPOINT__',
  gitOff: async (fn, ...args) => {
    gitOffCalls.push({ fn, args, probe: gitOffProbe ? gitOffProbe() : undefined })
    if (gitOffOverride) return gitOffOverride(fn, args)
    executingWorkerGit = true
    try { return worktreeApi[fn](...args) }
    finally { executingWorkerGit = false }
  },
  gitOffWithCheckpoint: async () => {
    throw new Error('gitOffWithCheckpoint não participa da criação de missão')
  }
}

const loadModule = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  if (/(^|[\\/])gitAsync(\.js)?$/.test(request)) return gitAsyncStub
  // O STORE DA FILA É O REAL, e este desvio de UMA linha é o que torna isso
  // possível: `integrationQueue.ts` importa `./jsonStore.ts` COM extensão (o
  // strip-types do node exige), e o `tsc` copia o especificador verbatim para o
  // CJS — o require cairia num arquivo que não existe em .tmp. Trocar a fila
  // por um duplo aqui deixaria a decisão de integração sendo provada contra uma
  // fila de mentira; é exatamente o que este arquivo não pode fazer.
  if (/jsonStore\.ts$/.test(request))
    return loadModule.call(this, join(COMPILED, 'jsonStore.js'), parent, isMain)
  return loadModule.call(this, request, parent, isMain)
}

const { registerMissionsIpc } = require(join(COMPILED, 'ipc', 'missions.js'))
const { createMissionEngine } = require(join(COMPILED, 'missionEngine.js'))
const { BacklogStore } = require(join(COMPILED, 'backlog.js'))
const worktreeApi = require(join(COMPILED, 'worktree.js'))

/**
 * Registra o IPC real com o MÍNIMO que o `registerMissionsIpc` desestrutura na
 * construção e devolve o handler de `missions:create` + os espiões.
 *
 * O plano MESTRE F6 e a classificação greenfield×existente saíram do app na
 * limpa F6 (2026-08-17): não há mais o que espionar neste caminho.
 */
function createHarness({
  versionChoices = { versions: [], defaultVersionId: undefined },
  configure = () => {}
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
  configure(ctx, extras)
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
      // Versão sintética sem branch/worktree: a conferência de base da rodada 7
      // consulta o registro e não tem o que sincronizar — que é o caso comum de
      // uma versão que ainda não abriu isolamento.
      getVersion: (id) => versionChoices.versions.find((version) => version.id === id),
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

// O motor virou ASSÍNCRONO na rodada 7 (adendo C2): antes de derivar a
// branch/worktree da missão ele confere a base da versão contra a principal,
// e essa viagem sai do main thread pelo gitWorker. O canal sempre foi `invoke`
// — quem espera a Promise agora é o teste, como o renderer já fazia.
test('o motor persiste a versao elegivel escolhida pelo dono', async () => {
  const { create, createdInputs, defaultEnsures } = createMissionEngineHarness({
    versions: [
      { id: 'version-current', projectId: 'proj-1', name: 'V1.2', status: 'aberta' },
      { id: 'version-selected', projectId: 'proj-1', name: 'V2.0', status: 'aberta' }
    ],
    defaultVersionId: 'version-current'
  })

  const mission = await create(
    'proj-1',
    { title: 'Levar o checkout para V2', versionId: 'version-selected', direct: true },
    'user'
  )

  assert.equal(mission?.versionId, 'version-selected')
  assert.equal(createdInputs.length, 1)
  assert.equal(createdInputs[0].versionId, 'version-selected')
  assert.equal(defaultEnsures(), 0, 'uma escolha explicita nunca cai no default')
})

test('o motor usa o default atual quando nenhuma versao e escolhida', async () => {
  const { create, createdInputs, defaultEnsures } = createMissionEngineHarness({
    versions: [{ id: 'version-current', projectId: 'proj-1', name: 'V1.2', status: 'aberta' }],
    defaultVersionId: 'version-current'
  })

  const mission = await create('proj-1', { title: 'Missao sem escolha explicita', direct: true }, 'user')

  assert.equal(mission?.versionId, 'version-current')
  assert.equal(createdInputs[0].versionId, 'version-current')
  assert.equal(defaultEnsures(), 1)
})

test('o motor recusa versao lancada ou estrangeira antes de persistir', async () => {
  const { create, createdInputs, defaultEnsures } = createMissionEngineHarness({
    versions: [{ id: 'version-open', projectId: 'proj-1', name: 'V2.0', status: 'aberta' }],
    defaultVersionId: 'version-open'
  })

  assert.equal(
    await create('proj-1', { title: 'Nao pode ir para lancada', versionId: 'version-released' }, 'user'),
    null
  )
  assert.equal(
    await create('proj-1', { title: 'Nao pode ir para outro projeto', versionId: 'version-foreign' }, 'user'),
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

// The real UI entry points must survive the persisted release transition,
// which removes the version branch/worktree while its conversation stays open.
function releaseWorkspaceHarness(cli = 'codex', contextBriefing, configure = () => {}) {
  const backlogFile = join(userData, `release-reopen-${randomUUID()}.json`)
  const backlog = new BacklogStore(backlogFile)
  const project = { id: 'release-project', name: 'Synthetic project', path: userData }
  const version = backlog.createVersion(project.id, { name: 'V0.1.3' })
  backlog.setVersionBranch(version.id, 'version/synthetic', join(userData, 'removed-version'))
  const seat = { id: 'release-seat', cli }
  const mission = {
    id: randomUUID(), projectId: project.id, versionId: version.id,
    title: 'Synthetic release', missionType: 'release', status: 'ativa',
    direct: true, seatId: seat.id
  }
  const paneId = `gui-dev-${mission.id.slice(0, 8)}`
  const remembered = {
    cli, sessionId: 'synthetic-existing-session', permissionMode: 'default'
  }
  const sessionReads = []
  const identities = new Map()
  const opened = []
  let liveBacklog = backlog
  createHarness({ configure: (ctx, extras) => {
    ctx.projects = { get: (id) => id === project.id ? project : undefined }
    ctx.missions = { get: (id) => id === mission.id ? mission : undefined }
    ctx.backlog = { getVersion: (id) => liveBacklog.getVersion(id) }
    ctx.seats = {
      get: (id) => id === seat.id ? seat : undefined,
      preseed: () => {}, configDirOf: () => userData
    }
    ctx.mcpPort = 43210 // Args only: no server, CLI or network is started.
    ctx.paneTokens = new Map()
    ctx.paneMcpFiles = new Map()
    ctx.hub = {
      registerPane: (token, identity) => identities.set(token, identity),
      identityByToken: (token) => identities.get(token)
    }
    ctx.testServerPanes = new Map()
    ctx.pushAll = (...args) => opened.push(args)
    extras.guiSessions = {
      remembered: (id) => {
        sessionReads.push(id)
        return id === paneId ? remembered : undefined
      }
    }
    extras.engine.ensureMissionWorktree = () => assert.fail('release must not recreate a worktree')
    extras.projectContextBriefing = contextBriefing
    configure(ctx, extras, mission)
  } })
  return {
    project, version, backlog, mission, paneId, remembered, sessionReads, identities, opened,
    gui: (role = 'dev') => handlers.get('missions:guiSpec')({}, mission.id, role),
    shell: () => handlers.get('missions:shellSpec')({}, mission.id),
    launchAndReload: () => {
      backlog.markVersionReleased(version.id)
      liveBacklog = new BacklogStore(backlogFile)
      const persisted = liveBacklog.getVersion(version.id)
      assert.equal(persisted.status, 'lancada')
      assert.equal(persisted.worktree, undefined)
      assert.equal(persisted.branch, undefined)
    }
  }
}

for (const cli of ['codex', 'claude']) {
  test(`release GUI reopens the same ${cli} conversation after persisted worktree cleanup`, async () => {
    const h = releaseWorkspaceHarness(cli)
    const before = await h.gui()
    assert.equal(before.ok, true, before.error)
    h.launchAndReload()

    const reopened = await h.gui()
    assert.equal(reopened.ok, true, reopened.error)
    assert.equal(reopened.spawn.paneId, before.spawn.paneId)
    assert.equal(reopened.spawn.paneId, h.paneId)
    assert.equal(reopened.spawn.cwd, h.project.path)
    assert.equal(reopened.spawn.resumeSessionId, h.remembered.sessionId)
    assert.equal(reopened.spawn.firstPrompt, undefined, 'do not repeat the initial briefing')
    assert.equal(reopened.spawn.permissionMode, h.remembered.permissionMode)
    assert.deepEqual(h.sessionReads, [h.paneId, h.paneId])
    assert.deepEqual([...h.identities.values()].map(({ role, cwd, missionId }) => ({ role, cwd, missionId })), [
      { role: 'gui-release', cwd: h.project.path, missionId: h.mission.id }
    ])
    assert.equal(h.mission.status, 'ativa')
  })
}

test('mission resume refreshes project orientation without repeating the initial briefing', async () => {
  let state = 'em desenvolvimento'
  const calls = []
  const h = releaseWorkspaceHarness('codex', (projectId, missionId) => {
    calls.push({ projectId, missionId })
    return `PROJECT CONTEXT: ${state}`
  })
  const before = await h.gui()
  assert.match(before.spawn.systemPrompt, /PROJECT CONTEXT: em desenvolvimento/u)
  h.launchAndReload()
  state = 'lançada'
  const resumed = await h.gui()
  assert.match(resumed.spawn.systemPrompt, /PROJECT CONTEXT: lançada/u)
  assert.doesNotMatch(resumed.spawn.systemPrompt, /PROJECT CONTEXT: em desenvolvimento/u)
  assert.equal(resumed.spawn.firstPrompt, undefined)
  assert.deepEqual(calls, Array.from({ length: 2 }, () => ({ projectId: h.project.id, missionId: h.mission.id })))
})

test('release shell reopens in the project after persisted worktree cleanup', async () => {
  const h = releaseWorkspaceHarness()
  h.launchAndReload()
  const result = await h.shell()
  assert.equal(result.ok, true, result.error)
  assert.equal(result.spec.cwd, h.project.path)
  assert.equal(result.spec.missionId, h.mission.id)
  assert.equal(h.opened.length, 1)
  assert.equal(h.opened[0][2], 'shell')
})

test('release workspace still refuses closed missions and mismatched versions', async () => {
  const h = releaseWorkspaceHarness()
  const foreign = h.backlog.createVersion('another-project', { name: 'V0.1.3' })
  h.launchAndReload()
  for (const status of ['concluida', 'arquivada', 'integrando']) {
    h.mission.status = status
    assert.equal((await h.gui()).ok, false)
    assert.equal((await h.shell()).ok, false)
  }
  h.mission.status = 'ativa'
  for (const versionId of ['missing-version', foreign.id]) {
    h.mission.versionId = versionId
    assert.equal((await h.gui()).ok, false)
    assert.equal((await h.shell()).ok, false)
  }
  assert.deepEqual(h.sessionReads, [])
  assert.equal(h.identities.size, 0)
  assert.deepEqual(h.opened, [])
})

test('release workspace still requires version isolation before launch', async () => {
  const h = releaseWorkspaceHarness()
  h.backlog.setVersionBranch(h.version.id, undefined, undefined)
  const result = await h.gui()
  assert.equal(result.ok, false)
  assert.match(result.error, /a versão ainda não tem worktree/u)
  assert.equal((await h.shell()).ok, false)
  assert.deepEqual(h.sessionReads, [])
  assert.equal(h.identities.size, 0)
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

// ————— A BASE NUNCA FICA PARA TRÁS (rodada 7, adendo C2) —————
//
// CASO REAL (2026-08-18): a main de um projeto do dono andou 50 commits POR
// FORA do Synkora e a branch da VERSÃO — a base de onde toda missão nova é
// derivada — ficou no commit inicial. A missão nasceu num worktree quase vazio,
// o agente mergeou a main, e a ENTREGA contabilizou o repo inteiro (+50k
// linhas, 187 arquivos). Aqui o motor REAL roda contra um repositório de
// verdade: o que se prova é a decisão (avança só quando é fast-forward), a
// ORDEM (a base é conferida ANTES de a missão derivar worktree) e o rastro
// (caixa-preta + aviso ao dono), inclusive quando o git falha.

const gitCli = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()

/** Motor REAL sobre um repositório temporário com versão isolada em worktree —
 *  o mesmo arranjo do caso real (a branch da versão CHECADA na pasta dela). */
function createEngineOnRealRepository(t, { freshProject = false, withoutGit = false } = {}) {
  const projectPath = mkdtempSync(join(tmpdir(), 'synkora-base-create-'))
  const worktreesRoot = mkdtempSync(join(tmpdir(), 'synkora-base-create-wt-'))
  t.after(() => {
    rmSync(worktreesRoot, { recursive: true, force: true })
    rmSync(projectPath, { recursive: true, force: true })
  })
  writeFileSync(join(projectPath, 'base.txt'), 'base\n', 'utf8')
  if (!withoutGit) {
    gitCli(projectPath, ['init'])
    gitCli(projectPath, ['config', 'user.name', 'Synkora Test'])
    gitCli(projectPath, ['config', 'user.email', 'synkora-test@example.invalid'])
    gitCli(projectPath, ['add', '-A'])
    gitCli(projectPath, ['commit', '-m', 'commit inicial'])
  }
  const mainBranch = withoutGit ? undefined : gitCli(projectPath, ['branch', '--show-current'])

  const isolation = freshProject ? undefined : worktreeApi.createVersionWorktree(projectPath, worktreesRoot, 'V1.0', 'versaobase')
  if (!freshProject) assert.ok(isolation, 'a versão precisa nascer isolada, como no caso real')
  const version = {
    id: freshProject ? randomUUID() : 'versaobase',
    projectId: 'proj-1',
    name: 'V1.0',
    status: 'aberta',
    deliveries: [],
    branch: isolation?.branch,
    worktree: isolation?.dir,
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z'
  }

  const missionsStore = new Map()
  const published = []
  const audited = []
  const signals = []
  const ctx = {
    projects: { get: (id) => (id === 'proj-1' ? { id: 'proj-1', path: projectPath } : undefined) },
    missions: {
      create: (projectId, input, reservedId) => {
        const mission = {
          // Id ÚNICO por harness: o `userData` do stub é compartilhado por
          // todos os testes do arquivo e o worktree da missão se endereça pelos
          // 8 primeiros caracteres — ids repetidos cairiam na pasta de outro
          // repositório temporário e o isolamento seria (corretamente) negado.
          id: reservedId ?? randomUUID(),
          projectId,
          status: 'ativa',
          ...input,
          createdAt: '2026-08-18T12:00:00.000Z',
          updatedAt: '2026-08-18T12:00:00.000Z'
        }
        missionsStore.set(mission.id, mission)
        return mission
      },
      get: (id) => missionsStore.get(id),
      list: (projectId) => [...missionsStore.values()].filter(mission => mission.projectId === projectId),
      update: (id, patch) => {
        const current = missionsStore.get(id)
        if (!current) return undefined
        const next = { ...current, ...patch }
        missionsStore.set(id, next)
        return next
      }
    },
    backlog: {
      missionVersionChoices: () => ({ versions: [version], defaultVersionId: version.id }),
      getVersion: (id) => (id === version.id ? version : undefined),
      ensureDefaultVersion: () => version,
      setVersionBranch: (id, branch, dir) => {
        if (id !== version.id) return
        version.branch = branch
        version.worktree = dir
      }
    },
    tasks: {},
    integrationQueue: { listPending: () => [] },
    maestro: { update: () => {} },
    ptys: {},
    blackbox: { record: (event) => audited.push(event) },
    mainStalls: {},
    hub: { publish: (event) => published.push(event) },
    pushAll: (...args) => signals.push(args),
    syncBoard: () => {},
    scheduleProgressSnapshot: () => {},
    orchPaneId: (projectId, missionId) => `${projectId}--${missionId}`,
    unregisterPane: () => {}
  }
  const engine = createMissionEngine(ctx, {
    orchKey: (projectId, missionId) => `${projectId}--${missionId}`,
    // Mesma régua do index: só um worktree version/* canônico é isolamento.
    versionIsolationIsValid: (path, candidate) =>
      Boolean(
        candidate.branch &&
          candidate.worktree &&
          worktreeApi.isExpectedVersionWorktree(path, candidate.worktree, candidate.branch)
      ),
    // R18.3: o espelho assíncrono, com a MESMA régua — no index é a metade pura
    // + `gitOff('isExpectedVersionWorktree', …)`; aqui, o mesmo pelo stub.
    versionIsolationProbe: (path, candidate) =>
      candidate.branch && candidate.worktree
        ? gitAsyncStub.gitOff('isExpectedVersionWorktree', path, candidate.worktree, candidate.branch)
        : Promise.resolve(false),
    emitBacklogChanged: () => {},
    sweepProjectFiles: () => 0,
    closeTestServersUnder: () => {},
    deliverToGuiPane: () => false,
    killMissionGuiPanes: () => {}
  })

  gitOffCalls.length = 0
  gitOffOverride = null
  gitOffProbe = null
  t.after(() => {
    gitOffOverride = null
    gitOffProbe = null
  })

  const advanceMainOutsideSynkora = (count) => {
    for (let index = 1; index <= count; index += 1) {
      writeFileSync(join(projectPath, `fora-${index}.txt`), `trabalho externo ${index}\n`, 'utf8')
      gitCli(projectPath, ['add', '-A'])
      gitCli(projectPath, ['commit', '-m', `fora ${index}`])
    }
    return gitCli(projectPath, ['rev-parse', 'HEAD'])
  }
  const versionSha = () => gitCli(projectPath, ['rev-parse', `refs/heads/${version.branch}`])

  return {
    engine,
    projectPath,
    mainBranch,
    version,
    published,
    audited,
    signals,
    advanceMainOutsideSynkora,
    versionSha,
    missionOf: (id) => missionsStore.get(id),
    updateMission: (id, patch) => ctx.missions.update(id, patch),
    /** Quantas missões JÁ derivaram worktree — a régua de ordem do seam. */
    missionsWithWorktree: () =>
      [...missionsStore.values()].filter((mission) => mission.worktree).length
  }
}

for (const withoutGit of [false, true]) test(`first mission creation keeps every Git operation off the main thread (withoutGit=${withoutGit})`, async (t) => {
  const h = createEngineOnRealRepository(t, { freshProject: true, withoutGit })
  const mainThreadGit = []
  worktreeApi.setGitObserver(({ args }) => {
    if (!executingWorkerGit) mainThreadGit.push(args[0])
  })
  t.after(() => worktreeApi.setGitObserver(null))
  const mission = await h.engine.createMissionImpl('proj-1', { title: 'Synthetic first mission', direct: true }, 'user')
  assert.ok(mission?.worktree, 'first mission must have its own workspace')
  assert.ok(h.version.worktree, 'first version must have its own workspace')
  assert.deepEqual(mainThreadGit, [], 'Git checkout must not block the Electron main thread')
  assert.ok(gitOffCalls.some(call => call.fn === 'createVersionWorktree'))
  assert.ok(gitOffCalls.some(call => call.fn === 'createMissionWorktree'))
  if (withoutGit) assert.ok(gitOffCalls.some(call => call.fn === 'initGitRepo'))
})

function registerEngineWorkspaceHarness(h) {
  createHarness({ configure: (ctx, extras) => {
    ctx.projects = { get: () => ({ id: 'proj-1', path: h.projectPath }) }
    ctx.missions = { get: id => h.missionOf(id) }
    ctx.integrationQueue = { getByMission: () => undefined }
    ctx.testServerPanes = new Map()
    ctx.pushAll = () => {}
    extras.engine = h.engine
    ctx.seats = { list: () => [] }
    extras.guiSessions = { remembered: () => undefined }
  } })
}

test('reopening a mission prepares and proves its workspace off the main thread', async (t) => {
  const h = createEngineOnRealRepository(t)
  const mission = await h.engine.createMissionImpl('proj-1', { title: 'Synthetic reopen', direct: true }, 'user')
  const mainThreadGit = []
  worktreeApi.setGitObserver(({ args }) => {
    if (!executingWorkerGit) mainThreadGit.push(args[0])
  })
  t.after(() => worktreeApi.setGitObserver(null))
  registerEngineWorkspaceHarness(h)
  const result = await handlers.get('missions:guiSpec')({}, mission.id, 'dev')
  assert.equal(result.needsSeat, true, result.error)
  const shell = await handlers.get('missions:shellSpec')({}, mission.id)
  assert.equal(shell.spec.cwd, mission.worktree)
  assert.deepEqual(mainThreadGit, [], 'selecting the project must not run synchronous Git')
})

test('simultaneous first missions share one version and keep separate workspaces', async (t) => {
  const h = createEngineOnRealRepository(t, { freshProject: true })
  const [first, second] = await Promise.all(['First', 'Second'].map(title =>
    h.engine.createMissionImpl('proj-1', { title, direct: true }, 'user')))
  assert.ok(first?.worktree)
  assert.ok(second?.worktree)
  assert.notEqual(first.worktree, second.worktree)
  assert.equal(first.baseBranch, h.version.branch)
  assert.equal(second.baseBranch, h.version.branch)
  assert.equal(gitOffCalls.filter(call => call.fn === 'createVersionWorktree').length, 1)
})

test('recovering mission metadata refreshes the project card after reopening', async (t) => {
  const h = createEngineOnRealRepository(t)
  const mission = await h.engine.createMissionImpl('proj-1', { title: 'Synthetic recovery', direct: true }, 'user')
  h.updateMission(mission.id, { branch: undefined })
  h.signals.length = 0
  registerEngineWorkspaceHarness(h)
  const result = await handlers.get('missions:guiSpec')({}, mission.id, 'dev')
  assert.equal(result.needsSeat, true, result.error)
  assert.equal(h.missionOf(mission.id).branch, mission.branch)
  assert.ok(h.signals.some(([channel, projectId]) => channel === 'missions:changed' && projectId === 'proj-1'))
})

test('repeated project clicks join pending preparation and allow retry after worker failure', async (t) => {
  const h = createEngineOnRealRepository(t)
  const mission = await h.engine.createMissionImpl('proj-1', { title: 'Synthetic pending', direct: true }, 'user')
  let rejectWorker
  const workerReply = new Promise((_resolve, reject) => { rejectWorker = reject })
  let enterWorker
  const entered = new Promise(resolve => { enterWorker = resolve })
  gitOffOverride = (fn, args) => {
    if (fn === 'ensureWorktreeEnvironment') { enterWorker(); return workerReply }
    return worktreeApi[fn](...args)
  }
  const first = h.engine.ensureMissionWorktree(mission.id)
  assert.equal(typeof first?.then, 'function')
  await entered
  const second = h.engine.ensureMissionWorktree(mission.id)
  assert.equal(second, first, 'repeated selection must reuse the pending preparation')
  await new Promise(resolve => setImmediate(resolve))
  const rejection = assert.rejects(first, /synthetic worker failure/)
  rejectWorker(new Error('synthetic worker failure'))
  await rejection
  gitOffOverride = null
  assert.equal((await h.engine.ensureMissionWorktree(mission.id)).worktree, mission.worktree)
})

test('archiving during workspace proof prevents both chat and shell from opening', async (t) => {
  const h = createEngineOnRealRepository(t)
  const mission = await h.engine.createMissionImpl('proj-1', { title: 'Synthetic archive race', direct: true }, 'user')
  registerEngineWorkspaceHarness(h)
  let finishProof
  const proof = new Promise(resolve => { finishProof = resolve })
  let enterProof
  const entered = new Promise(resolve => { enterProof = resolve })
  gitOffOverride = (fn, args) => {
    if (fn === 'resolveMissionWorkspace') { enterProof(); return proof }
    return worktreeApi[fn](...args)
  }
  const opening = handlers.get('missions:guiSpec')({}, mission.id, 'dev')
  await entered
  h.updateMission(mission.id, { status: 'arquivada' })
  finishProof(mission.worktree)
  const result = await opening
  assert.equal(result.ok, false)
  assert.equal(result.needsSeat, undefined, 'the stale proof must not reach chat selection')
  assert.match(result.error, /mudou durante a preparação/)
  assert.equal((await handlers.get('missions:shellSpec')({}, mission.id)).ok, false)
})

test('reabrir uma missão existente repõe env ausente e preserva configuração própria', async (t) => {
  const h = createEngineOnRealRepository(t)
  const mission = await h.engine.createMissionImpl('proj-1', { title: 'Synthetic local environment', direct: true }, 'user')
  assert.ok(mission?.worktree)
  writeFileSync(join(h.projectPath, '.env'), 'SYNTHETIC_MODE=project\n')
  writeFileSync(join(h.projectPath, '.env.local'), 'SYNTHETIC_PORT=4200\n')
  writeFileSync(join(h.projectPath, '.env.staging.local'), 'SYNTHETIC_MODE=staging\n')
  await h.engine.ensureMissionWorktree(mission.id)
  assert.equal(readFileSync(join(mission.worktree, '.env'), 'utf8'), 'SYNTHETIC_MODE=project\n')
  assert.equal(readFileSync(join(mission.worktree, '.env.staging.local'), 'utf8'), 'SYNTHETIC_MODE=staging\n')
  writeFileSync(join(mission.worktree, '.env'), 'SYNTHETIC_MODE=mission\n')
  unlinkSync(join(mission.worktree, '.env.local'))
  await h.engine.ensureMissionWorktree(mission.id)
  assert.equal(readFileSync(join(mission.worktree, '.env'), 'utf8'), 'SYNTHETIC_MODE=mission\n')
  assert.equal(readFileSync(join(mission.worktree, '.env.local'), 'utf8'), 'SYNTHETIC_PORT=4200\n')
  assert.equal(gitCli(mission.worktree, ['status', '--porcelain']), '')
})

test('missão nova nunca nasce de base atrasada: a versão é adiantada antes do worktree', async (t) => {
  const harness = createEngineOnRealRepository(t)
  const initial = harness.versionSha()
  const mainSha = harness.advanceMainOutsideSynkora(3)
  assert.notEqual(initial, mainSha)

  // Fotografia tirada DENTRO da chamada de git: prova que a base é conferida
  // antes de a missão derivar qualquer worktree (depois seria tarde).
  gitOffProbe = () => ({ missoesComWorktree: harness.missionsWithWorktree() })

  const mission = await harness.engine.createMissionImpl(
    'proj-1',
    { title: 'Missão depois do trabalho externo', direct: true },
    'user'
  )
  assert.ok(mission, 'a missão tem de nascer')

  const sync = gitOffCalls.find((call) => call.fn === 'syncVersionBaseWithMain')
  assert.ok(sync, 'a criação precisa conferir a base da versão')
  assert.deepEqual(sync.args, [harness.projectPath, harness.version.branch])
  assert.equal(sync.probe.missoesComWorktree, 0, 'a base é conferida ANTES de derivar o worktree')

  // A base andou até a main…
  assert.equal(harness.versionSha(), mainSha)
  // …a missão foi derivada DELA…
  const stored = harness.missionOf(mission.id)
  assert.equal(stored.baseBranch, harness.version.branch)
  assert.ok(stored.worktree, 'a missão precisa de worktree isolado')
  // …e o worktree da missão nasce COM o trabalho externo: é exatamente isto que
  // faltava quando a entrega contabilizou +50 mil linhas.
  assert.equal(gitCli(stored.worktree, ['rev-parse', 'HEAD']), mainSha)
  assert.ok(existsSync(join(stored.worktree, 'fora-3.txt')))

  const audit = harness.audited.find((event) => event.event === 'version-base-fastforwarded')
  assert.ok(audit, 'o avanço da base é evento de caixa-preta')
  assert.equal(audit.cat, 'git')
  assert.equal(audit.prev, initial.slice(0, 12))
  assert.equal(audit.next, mainSha.slice(0, 12))
  assert.equal(audit.detail.behind, 3)
  assert.equal(audit.ids.projectId, 'proj-1')
  assert.equal(audit.ids.missionId, mission.id, 'a caixa-preta correlaciona o avanço com a missão que o pediu')

  const aviso = harness.published.find((event) => /ADIANTADA/u.test(event.text))
  assert.ok(aviso, 'o dono precisa VER que a base andou')
  assert.match(aviso.text, /V1\.0/u)
  assert.match(aviso.text, /3 commit/u)
})

test('base DIVERGIDA vira advisory com as duas saídas — a missão nasce assim mesmo', async (t) => {
  const harness = createEngineOnRealRepository(t)
  // A versão andou por conta própria…
  writeFileSync(join(harness.version.worktree, 'da-versao.txt'), 'entrega da versão\n', 'utf8')
  gitCli(harness.version.worktree, ['add', '-A'])
  gitCli(harness.version.worktree, ['commit', '-m', 'trabalho da versão'])
  const divergido = harness.versionSha()
  // …e a main também, por outro caminho.
  harness.advanceMainOutsideSynkora(2)

  const mission = await harness.engine.createMissionImpl(
    'proj-1',
    { title: 'Missão sobre base divergente', direct: true },
    'user'
  )

  assert.ok(mission, 'divergência NUNCA recusa a missão do dono')
  assert.equal(harness.versionSha(), divergido, 'nada se move quando não é fast-forward')
  assert.equal(harness.missionOf(mission.id).baseBranch, harness.version.branch)

  const audit = harness.audited.find((event) => event.event === 'version-base-diverged')
  assert.ok(audit, 'advisory é AUDITADO, não silencioso')
  assert.equal(audit.detail.ahead, 1)
  assert.equal(audit.detail.behind, 2)

  const advisory = harness.published.find((event) => /DIVERGIU/u.test(event.text))
  assert.ok(advisory, 'o dono precisa ser avisado da divergência')
  // As DUAS saídas sancionadas, nomeadas: fila de integração ou acerto manual.
  assert.match(advisory.text, /FILA|⇪/u)
  assert.match(advisory.text, /à mão/u)
  assert.equal(
    harness.audited.some((event) => event.event === 'version-base-fastforwarded'),
    false
  )
})

test('base em dia não gera barulho, e missão de planejamento nem consulta o git', async (t) => {
  const harness = createEngineOnRealRepository(t)
  const head = harness.versionSha()

  const mission = await harness.engine.createMissionImpl(
    'proj-1',
    { title: 'Missão com a base em dia', direct: true },
    'user'
  )
  assert.ok(mission)
  assert.equal(harness.versionSha(), head)
  assert.equal(
    harness.audited.some((event) => String(event.event).startsWith('version-base-')),
    false,
    'base em dia é o caso comum — barulho de rotina esconde o aviso que importa'
  )
  assert.equal(
    harness.published.some((event) => /base da versão/u.test(event.text)),
    false
  )

  const sincronias = gitOffCalls.filter((call) => call.fn === 'syncVersionBaseWithMain').length
  assert.equal(sincronias, 1, 'base em dia é SILÊNCIO, não ausência de conferência')
  await harness.engine.createMissionImpl(
    'proj-1',
    { title: 'Planejar a próxima onda', direct: true, missionType: 'planejamento' },
    'user'
  )
  assert.equal(
    gitOffCalls.filter((call) => call.fn === 'syncVersionBaseWithMain').length,
    sincronias,
    'planejamento não tem branch nem base — nada a sincronizar'
  )
})

test('falha de git na sincronia é auditada e JAMAIS impede o dono de criar a missão', async (t) => {
  const harness = createEngineOnRealRepository(t)
  harness.advanceMainOutsideSynkora(1)
  const antes = harness.versionSha()
  gitOffOverride = (fn, args) => {
    if (fn === 'syncVersionBaseWithMain')
      throw new Error('git worker encerrou no meio de uma operação')
    return worktreeApi[fn](...args)
  }

  const mission = await harness.engine.createMissionImpl(
    'proj-1',
    { title: 'Missão apesar do git quebrado', direct: true },
    'user'
  )

  assert.ok(mission, 'problema de sincronia nunca pode travar a criação')
  const stored = harness.missionOf(mission.id)
  assert.ok(stored.worktree, 'a missão continua nascendo isolada, na base como está')
  assert.equal(harness.versionSha(), antes)
  const audit = harness.audited.find((event) => event.event === 'version-base-sync-failed')
  assert.ok(audit, 'a falha fica auditada')
  assert.match(audit.err ?? '', /git worker/u)
})

// ————— RODADA 9 (2026-08-19): O ⇪ ENTREGA, O AGENTE INTEGRA —————
//
// Ordem do dono, verbatim: "quando eu clico em subir, o certo é avisar o agente
// — 'tá pronto pra subir' — e o AGENTE sobe. Ele vê via MCP se tem alguém na
// fila na frente dele; se é o próximo, ELE integra. Qualquer erro, ELE arruma."
//
// Até aqui o ⇪ enfileirava e o DRENO mesclava sozinho num timer de 150ms; o
// agente só ouvia falar quando dava conflito. Estes testes rodam o motor REAL
// contra repositórios de verdade e provam a inversão inteira: o clique estimula
// (nota no fio + texto pelos bastidores), NADA mescla sozinho, e o merge só
// acontece quando `integration_run` é chamado — pela missão que é a cabeça.

const { IntegrationQueueStore } = require(join(COMPILED, 'integrationQueue.js'))
const { guiMissionPaneId } = require(join(COMPILED, 'guiMissionContracts.js'))

/**
 * Motor REAL + fila REAL sobre um repositório de verdade com versão isolada.
 * As únicas coisas dubladas são as bordas que não são git nem fila: o registro
 * de missões, o backlog e as DUAS superfícies do chat (a nota que o dono lê e o
 * estímulo que o modelo recebe) — que aqui viram espiões, porque são
 * justamente o que esta rodada inventou.
 */
function createIntegrationHarness(t, extras = {}) {
  const projectPath = mkdtempSync(join(tmpdir(), 'synkora-r9-'))
  const worktreesRoot = join(userData, 'worktrees', 'proj-1')
  const queueFile = join(mkdtempSync(join(tmpdir(), 'synkora-r9-queue-')), 'queue.json')
  t.after(() => rmSync(projectPath, { recursive: true, force: true }))
  gitCli(projectPath, ['init'])
  gitCli(projectPath, ['config', 'user.name', 'Synkora Test'])
  gitCli(projectPath, ['config', 'user.email', 'synkora-test@example.invalid'])
  writeFileSync(join(projectPath, 'base.txt'), 'base\n', 'utf8')
  gitCli(projectPath, ['add', '-A'])
  gitCli(projectPath, ['commit', '-m', 'commit inicial'])

  const isolation = worktreeApi.createVersionWorktree(
    projectPath,
    worktreesRoot,
    'V1.0',
    `ver${randomUUID().slice(0, 8)}`
  )
  assert.ok(isolation, 'a versão precisa nascer isolada')
  const version = {
    id: isolation.branch.replace('version/', 'id-'),
    projectId: 'proj-1',
    name: 'V1.0',
    status: 'aberta',
    deliveries: [],
    branch: isolation.branch,
    worktree: isolation.dir,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z'
  }
  const versions = [version]

  const missionsStore = new Map()
  const published = []
  const audited = []
  const notes = []
  const stimuli = []
  /** Panes com CONVERSA VIVA. Fora deste conjunto, entregar devolve false — é o
   *  estado real de um chat fechado, e o que força o caminho re-derivável. */
  const livePanes = new Set()
  const integrationQueue = new IntegrationQueueStore(queueFile)
  const ctx = {
    projects: { get: (id) => (id === 'proj-1' ? { id: 'proj-1', path: projectPath } : undefined) },
    missions: {
      create: (projectId, input, reservedId) => {
        const mission = {
          id: reservedId ?? randomUUID(),
          projectId,
          status: 'ativa',
          ...input,
          createdAt: '2026-08-19T12:00:00.000Z',
          updatedAt: '2026-08-19T12:00:00.000Z'
        }
        missionsStore.set(mission.id, mission)
        return mission
      },
      get: (id) => missionsStore.get(id),
      list: (projectId) =>
        [...missionsStore.values()].filter((mission) => mission.projectId === projectId),
      update: (id, patch) => {
        const current = missionsStore.get(id)
        if (!current) return undefined
        const next = { ...current, ...patch }
        missionsStore.set(id, next)
        return next
      }
    },
    backlog: {
      missionVersionChoices: () => ({ versions, defaultVersionId: version.id }),
      getVersion: (id) => versions.find(candidate => candidate.id === id),
      ensureDefaultVersion: () => version,
      setVersionBranch: () => {},
      completeMissionItems: () => 0,
      addDelivery: (versionId, missionId, title) => {
        versions.find(candidate => candidate.id === versionId).deliveries.push({ missionId, title })
        return true
      }
    },
    tasks: {},
    integrationQueue,
    maestro: { update: () => {} },
    ptys: { kill: () => {}, has: () => false },
    blackbox: { record: (event) => audited.push(event) },
    // O wrapper de stall da Fase 0 é fino de propósito; aqui ele é a identidade.
    mainStalls: { wrap: (_label, _key, run) => run(), begin: () => () => {} },
    hub: { publish: (event) => published.push(event), purgeMissionEvents: () => {} },
    pushAll: () => {},
    syncBoard: () => {},
    scheduleProgressSnapshot: () => {},
    orchPaneId: (projectId, missionId) => `${projectId}--${missionId}`,
    unregisterPane: () => {},
    livePaneSpecs: new Map()
  }
  const engine = createMissionEngine(ctx, {
    orchKey: (projectId, missionId) => `${projectId}--${missionId}`,
    versionIsolationIsValid: (path, candidate) =>
      Boolean(
        candidate.branch &&
          candidate.worktree &&
          worktreeApi.isExpectedVersionWorktree(path, candidate.worktree, candidate.branch)
      ),
    // R18.3: o mesmo isolamento pelo gitWorker — é ELE que o caminho assíncrono
    // (resolução do destino, conferência de identidade no merge) passa a usar.
    versionIsolationProbe: (path, candidate) =>
      candidate.branch && candidate.worktree
        ? gitAsyncStub.gitOff('isExpectedVersionWorktree', path, candidate.worktree, candidate.branch)
        : Promise.resolve(false),
    emitBacklogChanged: () => {},
    sweepProjectFiles: () => 0,
    closeTestServersUnder: () => {},
    deliverToGuiPane: () => false,
    noteInGuiPane: (paneId, text) => {
      notes.push({ paneId, text })
      return livePanes.has(paneId)
    },
    announceToGuiPane: (paneId, text) => {
      stimuli.push({ paneId, text })
      return livePanes.has(paneId)
    },
    killMissionGuiPanes: () => {},
    ...extras
  })

  gitOffCalls.length = 0
  gitOffOverride = null
  gitOffProbe = null
  t.after(() => {
    gitOffOverride = null
    gitOffProbe = null
  })

  /** Cria a missão de verdade (worktree isolado) e commita uma entrega nela. */
  const missionWithDelivery = async (title, file, content) => {
    const mission = await engine.createMissionImpl('proj-1', { title, direct: true }, 'user')
    assert.ok(mission?.worktree, `${title}: a missão precisa de worktree isolado`)
    livePanes.add(guiMissionPaneId('dev', mission.id))
    writeFileSync(join(mission.worktree, file), content, 'utf8')
    gitCli(mission.worktree, ['add', '-A'])
    gitCli(mission.worktree, ['commit', '-m', `entrega de ${title}`])
    return missionsStore.get(mission.id)
  }

  return {
    engine,
    projectPath,
    version,
    versions,
    integrationQueue,
    published,
    audited,
    notes,
    stimuli,
    livePanes,
    missionWithDelivery,
    devPaneOf: (mission) => guiMissionPaneId('dev', mission.id),
    missionOf: (id) => missionsStore.get(id),
    updateMission: (id, patch) => ctx.missions.update(id, patch),
    targetSha: () => gitCli(projectPath, ['rev-parse', `refs/heads/${version.branch}`]),
    /** A versão anda por fora, como outra missão integrando antes desta. */
    advanceTarget: (content) => {
      writeFileSync(join(version.worktree, 'base.txt'), content, 'utf8')
      gitCli(version.worktree, ['add', '-A'])
      gitCli(version.worktree, ['commit', '-m', 'trabalho na versão'])
      return gitCli(version.worktree, ['rev-parse', 'HEAD'])
    },
    notesOf: (paneId) => notes.filter((note) => note.paneId === paneId).map((note) => note.text),
    stimuliOf: (paneId) =>
      stimuli.filter((entry) => entry.paneId === paneId).map((entry) => entry.text)
  }
}

test('a reassigned mission integrates into its chosen version and preserves its Git origin', async (t) => {
  const h = createIntegrationHarness(t)
  const mission = await h.missionWithDelivery('Synthetic version transfer', 'transfer.txt', 'synthetic work\n')
  const originHead = h.targetSha()
  const isolation = worktreeApi.createVersionWorktree(h.projectPath, join(userData, 'worktrees', 'proj-1'), 'V2.0', randomUUID())
  assert.ok(isolation)
  const target = { ...h.version, id: 'synthetic-target', name: 'V2.0', branch: isolation.branch, worktree: isolation.dir, deliveries: [] }
  h.versions.push(target)
  h.updateMission(mission.id, { versionId: target.id })

  await h.engine.startMissionIntegration(mission.id, 'user')
  const ticket = h.integrationQueue.getByMission(mission.id)
  assert.equal(ticket.versionId, target.id)
  assert.equal(ticket.targetBranch, target.branch)
  assert.equal(h.missionOf(mission.id).baseBranch, h.version.branch)
  assert.match(await h.engine.runMissionIntegration('proj-1', mission.id), /INTEGRADA/u)
  assert.equal(readFileSync(join(target.worktree, 'transfer.txt'), 'utf8').replace(/\r\n/gu, '\n'), 'synthetic work\n')
  assert.equal(h.targetSha(), originHead)
  assert.equal(h.version.deliveries.length, 0)
  assert.equal(target.deliveries[0].missionId, mission.id)
})

for (const actor of ['user', 'dev']) test(`changing version during integration preparation rejects stale ${actor} intent`, async (t) => {
  const h = createIntegrationHarness(t)
  const mission = await h.missionWithDelivery('Synthetic transfer race', 'race.txt', 'synthetic work\n')
  let release, enter
  const waiting = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { enter = resolve })
  t.after(() => release())
  gitOffOverride = async (fn, args) => {
    const pause = actor === 'user'
      ? fn === 'gitHead' && args[0] === h.version.worktree
      : fn === 'isWorktreeClean' && args[0] === mission.worktree
    if (pause) { enter(); await waiting }
    return worktreeApi[fn](...args)
  }
  const preparing = h.engine.startMissionIntegration(mission.id, actor)
  await entered
  h.updateMission(mission.id, { versionId: 'synthetic-other-version' })
  release()
  const result = await preparing
  assert.equal(h.integrationQueue.getByMission(mission.id), undefined, 'stale integration must not enter the queue')
  assert.notEqual(h.missionOf(mission.id).pendingIntegrationApproval, true, 'stale agent preparation must not create approval intent')
  assert.match(result, /mudou|alterad/iu)
  assert.equal(h.missionOf(mission.id).versionId, 'synthetic-other-version')
  assert.equal(existsSync(join(mission.worktree, 'race.txt')), true)
})

test('o ⇪ do dono ENTREGA a subida ao agente — e NADA mescla sozinho', async (t) => {
  const h = createIntegrationHarness(t)
  const mission = await h.missionWithDelivery('Rail da fila', 'rail.txt', 'entrega\n')
  const pane = h.devPaneOf(mission)
  const targetAntes = h.targetSha()

  const msg = await h.engine.startMissionIntegration(mission.id, 'user')

  // 1. O CORAÇÃO DA RODADA, e por isso a PRIMEIRA asserção: passada a janela do
  // dreno antigo (150ms de agrupamento + o merge), o destino NÃO andou e a
  // missão continua ativa. Antes desta rodada a máquina já teria mesclado aqui,
  // sem o agente saber de nada — foi exatamente isso que o vermelho mostrou.
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(h.targetSha(), targetAntes, 'nada pode ser mesclado sem o agente')
  assert.equal(h.missionOf(mission.id).status, 'ativa')

  // 2. a porteira do dono continua criando o ticket, como sempre
  const ticket = h.integrationQueue.getByMission(mission.id)
  assert.ok(ticket, 'o ⇪ do dono continua sendo quem cria o ticket')
  assert.equal(ticket.state, 'queued')
  assert.equal(ticket.isHead, true)
  assert.match(msg, /entregue ao agente/u, 'a resposta do clique nomeia quem vai subir')

  // 3. a NOTA que o dono lê no fio
  assert.equal(h.notesOf(pane).length, 1)
  assert.match(h.notesOf(pane)[0], /^⇪ subir para .* — entregue ao agente/u)

  // 4. o ESTÍMULO que o modelo recebe pelos bastidores
  assert.equal(h.stimuliOf(pane).length, 1)
  assert.match(h.stimuliOf(pane)[0], /VOCÊ é o integrador/u)
  assert.match(h.stimuliOf(pane)[0], /integration_run/u)

  // 5. e o rastro na caixa-preta
  const audit = h.audited.find((event) => event.event === 'mission-integration-stimulus')
  assert.ok(audit, 'o estímulo é evento de caixa-preta')
  assert.equal(audit.detail.origin, 'user-gesture')
  assert.equal(audit.detail.delivered, true)
  assert.equal(audit.detail.head, true)
})

test('⇪ com o chat fechado não se perde: abrir a conversa re-estimula pelo TICKET', async (t) => {
  const h = createIntegrationHarness(t)
  const mission = await h.missionWithDelivery('Rail da fila', 'rail.txt', 'entrega\n')
  const pane = h.devPaneOf(mission)
  // o dono clicou com a conversa FECHADA
  h.livePanes.delete(pane)
  await h.engine.startMissionIntegration(mission.id, 'user')
  assert.equal(
    h.audited.find((event) => event.event === 'mission-integration-stimulus')?.detail.delivered,
    false,
    'sem sessão viva o estímulo não chega — e isso tem de ficar no diário'
  )

  // a conversa abre: o motor re-deriva do ticket, sem nada persistido a mais
  h.livePanes.add(pane)
  h.engine.restimulateIntegrationOnOpen(pane, 'proj-1')
  assert.equal(h.stimuliOf(pane).length, 2)
  assert.match(h.stimuliOf(pane)[1], /AINDA ESPERA/u)
  assert.match(h.notesOf(pane)[1], /⇪ pendente para/u)
  const reopened = h.audited.filter(
    (event) => event.event === 'mission-integration-stimulus' && event.detail.origin === 'pane-open'
  )
  assert.equal(reopened.length, 1)
  assert.equal(reopened[0].detail.delivered, true)

  // e nenhum vizinho é acordado por engano
  h.engine.restimulateIntegrationOnOpen(guiMissionPaneId('dev', randomUUID()), 'proj-1')
  h.engine.restimulateIntegrationOnOpen(guiMissionPaneId('reviewer', mission.id), 'proj-1')
  assert.equal(h.stimuliOf(pane).length, 2, 'o reviewer da mesma missão não é o integrador')
  assert.equal(h.stimuli.length, 2)
})

test('sem ticket, integration_status e integration_run nomeiam o ⇪ do DONO', async (t) => {
  const h = createIntegrationHarness(t)
  const mission = await h.missionWithDelivery('Rail da fila', 'rail.txt', 'entrega\n')

  const status = await h.engine.missionIntegrationStatus('proj-1', mission.id)
  assert.match(status, /NÃO tem ticket na fila/u)
  assert.match(status, /Só o ⇪ do DONO/u)
  assert.match(status, /nunca se enfileira sozinho/u)

  const run = await h.engine.runMissionIntegration('proj-1', mission.id)
  assert.match(run, /NÃO está na fila/u)
  assert.match(run, /Só o ⇪ do DONO cria o ticket/u)
  assert.equal(h.integrationQueue.getByMission(mission.id), undefined, 'a tool não enfileira nada')
})

test('quem não é a cabeça é recusado com a posição, quem falta e a ordem de esperar', async (t) => {
  const h = createIntegrationHarness(t)
  const first = await h.missionWithDelivery('Primeira entrega', 'a.txt', 'a\n')
  const second = await h.missionWithDelivery('Segunda entrega', 'b.txt', 'b\n')
  await h.engine.startMissionIntegration(first.id, 'user')
  await h.engine.startMissionIntegration(second.id, 'user')

  const status = await h.engine.missionIntegrationStatus('proj-1', second.id)
  assert.match(status, /posição #2 de 2/u)
  assert.match(status, /NA SUA FRENTE: "Primeira entrega" \(queued\)/u)
  assert.match(status, /ainda NÃO é a sua vez/u)

  const targetAntes = h.targetSha()
  const run = await h.engine.runMissionIntegration('proj-1', second.id)
  assert.match(run, /ainda NÃO é a vez/u)
  assert.match(run, /#2 de 2/u)
  assert.match(run, /Primeira entrega/u)
  assert.equal(h.targetSha(), targetAntes, 'furar a fila jamais mescla')
  assert.equal(h.integrationQueue.getByMission(second.id)?.state, 'queued')

  // e o estímulo que o segundo recebeu já dizia isso
  assert.match(h.stimuliOf(h.devPaneOf(second))[0], /Ainda NÃO é a sua vez/u)
})

test('árvore suja é recusa COM receita, e o ticket continua na cabeça', async (t) => {
  const h = createIntegrationHarness(t)
  const mission = await h.missionWithDelivery('Rail da fila', 'rail.txt', 'entrega\n')
  await h.engine.startMissionIntegration(mission.id, 'user')
  writeFileSync(join(mission.worktree, 'rail.txt'), 'mexido depois do aval\n', 'utf8')

  const status = await h.engine.missionIntegrationStatus('proj-1', mission.id)
  assert.match(status, /ÁRVORE DA MISSÃO: SUJA/u)
  assert.match(status, /commite \(ou limpe\)/u)

  const run = await h.engine.runMissionIntegration('proj-1', mission.id)
  assert.match(run, /NÃO rodou/u)
  assert.match(run, /alterações não commitadas/u)
  assert.match(run, /RECEITA: commite/u)
  const ticket = h.integrationQueue.getByMission(mission.id)
  assert.equal(ticket.state, 'queued', 'recusa não pode congelar o ticket')
  assert.equal(ticket.isHead, true)
  assert.ok(ticket.lastError)
})

test('integration_run INTEGRA de verdade e a fila anda: o próximo agente é estimulado', async (t) => {
  const h = createIntegrationHarness(t)
  const first = await h.missionWithDelivery('Primeira entrega', 'a.txt', 'a\n')
  const second = await h.missionWithDelivery('Segunda entrega', 'b.txt', 'b\n')
  await h.engine.startMissionIntegration(first.id, 'user')
  await h.engine.startMissionIntegration(second.id, 'user')
  const sourceHead = gitCli(first.worktree, ['rev-parse', 'HEAD'])

  const run = await h.engine.runMissionIntegration('proj-1', first.id)

  assert.match(run, /INTEGRADA/u)
  assert.match(run, new RegExp(sourceHead.slice(0, 12), 'u'), 'o desfecho carrega os shas')
  assert.match(run, /CONTE AO DONO/u)
  // o merge é REAL: o arquivo da missão está na branch da versão
  assert.equal(existsSync(join(h.version.worktree, 'a.txt')), true)
  assert.equal(h.missionOf(first.id).status, 'concluida')
  assert.equal(h.integrationQueue.getByMission(first.id), undefined, 'o ticket saiu da fila')

  // A FILA ANDOU: o segundo vira cabeça e é estimulado pelo MESMO canal do ⇪
  const nextTicket = h.integrationQueue.getByMission(second.id)
  assert.equal(nextTicket.position, 1)
  assert.equal(nextTicket.isHead, true)
  const secondPane = h.devPaneOf(second)
  assert.equal(h.stimuliOf(secondPane).length, 2, 'o próximo da fila precisa saber que chegou a vez')
  assert.match(h.stimuliOf(secondPane)[1], /CABEÇA da fila: chame integration_run agora/u)
  const avanco = h.audited.filter(
    (event) =>
      event.event === 'mission-integration-stimulus' && event.detail.origin === 'queue-advance'
  )
  assert.equal(avanco.length, 1)
})

test('integração aguarda os previews antes do merge e novamente antes da limpeza adiada', async (t) => {
  const stages = []
  const replies = []
  let closing = 0
  const h = createIntegrationHarness(t, {
    closeTestServersUnder: async () => {
      const generation = ++closing
      stages.push(`closing-${generation}`)
      await new Promise((resolve) => setImmediate(resolve))
      stages.push(`closed-${generation}`)
    },
    afterIntegrationReply: (_id, _text, finish) => replies.push(finish)
  })
  const mission = await h.missionWithDelivery('Preview separado', 'preview.txt', 'entrega\n')
  await h.engine.startMissionIntegration(mission.id, 'user')
  gitOffProbe = () => [...stages]
  const result = await h.engine.runMissionIntegration('proj-1', mission.id)
  assert.match(result, /MERGE GRAVADO/u)
  assert.doesNotMatch(result, /^INTEGRADA/u, 'o agente não pode anunciar a integração antes de a pasta ser liberada')
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(gitOffCalls.find(({ fn }) => fn === 'mergeTaskWorktree').probe.includes('closed-1'), 'o primeiro fechamento precisa terminar antes de mesclar')
  assert.equal(existsSync(join(mission.worktree, '.git')), true)
  assert.equal(replies.length, 1)
  const finish = await replies[0]()
  assert.match(finish, /INTEGRADA/u)
  assert.equal(closing, 2, 'um preview iniciado durante o recibo também é fechado')
  assert.ok(gitOffCalls.find(({ fn }) => fn === 'removeWorktreeAndBranch').probe.includes('closed-2'), 'não remove arquivos enquanto o preview está encerrando')
  assert.equal(h.missionOf(mission.id).status, 'concluida')
  assert.equal(h.integrationQueue.getByMission(mission.id), undefined)
})

test('boot aguarda o preview da missão já integrada e preserva a origem se o encerramento falhar', async (t) => {
  let recovering = false
  let failClosing = true
  const closedRoots = []
  let releaseClosing
  const waiting = new Promise(resolve => { releaseClosing = resolve })
  const h = createIntegrationHarness(t, {
    afterIntegrationReply: () => {},
    closeTestServersUnder: async root => {
      if (!recovering) return
      closedRoots.push(root)
      if (failClosing) throw new Error('synthetic preview close failure')
      await waiting
    }
  })
  const mission = await h.missionWithDelivery('Preview no boot', 'boot.txt', 'entrega\n')
  await h.engine.startMissionIntegration(mission.id, 'user')
  await h.engine.runMissionIntegration('proj-1', mission.id)
  const integrated = h.targetSha()
  const intentFile = join(h.projectPath, '.synkora', 'integrations', `${mission.id}.intent`)
  recovering = true
  await h.engine.recoverMissionIntegrationIntents('proj-1')
  assert.equal(closedRoots.length, 1)
  assert.equal(existsSync(join(mission.worktree, '.git')), true)
  assert.equal(existsSync(intentFile), true)
  assert.notEqual(h.missionOf(mission.id).status, 'concluida')
  failClosing = false
  const recovery = h.engine.recoverMissionIntegrationIntents('proj-1')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(existsSync(join(mission.worktree, '.git')), true, 'aguarda a confirmação antes de remover')
  releaseClosing()
  await recovery
  assert.deepEqual(closedRoots, [mission.worktree, mission.worktree])
  assert.equal(existsSync(join(mission.worktree, '.git')), false)
  assert.equal(existsSync(intentFile), false)
  assert.equal(h.missionOf(mission.id).status, 'concluida')
  assert.equal(h.targetSha(), integrated, 'recuperação não faz outro merge')
  assert.equal(h.integrationQueue.getByMission(mission.id), undefined)
})

test('boot reprova o destino alterado durante a espera do preview antes de remover a origem', async (t) => {
  let recovering = false
  const h = createIntegrationHarness(t, {
    afterIntegrationReply: () => {},
    closeTestServersUnder: async () => {
      if (!recovering) return
      await new Promise(resolve => setImmediate(resolve))
      writeFileSync(join(h.version.worktree, 'base.txt'), 'edição sintética durante a espera\n')
    }
  })
  const mission = await h.missionWithDelivery('Destino em movimento', 'boot-race.txt', 'entrega\n')
  await h.engine.startMissionIntegration(mission.id, 'user')
  await h.engine.runMissionIntegration('proj-1', mission.id)
  recovering = true
  await h.engine.recoverMissionIntegrationIntents('proj-1')
  assert.equal(existsSync(join(mission.worktree, '.git')), true)
  assert.equal(existsSync(join(h.projectPath, '.synkora', 'integrations', `${mission.id}.intent`)), true)
  assert.notEqual(h.missionOf(mission.id).status, 'concluida')
  assert.equal(h.integrationQueue.getByMission(mission.id).block.code, 'target_repair_pending')
  assert.match(h.published.at(-1).text, /mudou durante o encerramento/u)
})

test('integration waits for managed Mobile and Expo cleanup before merging or deleting the source', async (t) => {
  let release, started
  const cleanup = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { started = resolve })
  t.after(() => release())
  const h = createIntegrationHarness(t, { killMissionGuiPanes: async () => { started(); await cleanup } })
  const mission = await h.missionWithDelivery('Mobile cleanup', 'mobile-cleanup.txt', 'synthetic delivery\n')
  await h.engine.startMissionIntegration(mission.id, 'user')
  const run = h.engine.runMissionIntegration('proj-1', mission.id)
  await entered
  assert.equal(existsSync(join(h.version.worktree, 'mobile-cleanup.txt')), false, 'merge must wait for the process to release its cwd')
  assert.equal(existsSync(join(mission.worktree, '.git')), true, 'source remains available until cleanup completes')
  release()
  await run
  assert.equal(existsSync(join(h.version.worktree, 'mobile-cleanup.txt')), true)
  assert.equal(existsSync(mission.worktree), false)
})

test('completed mission deletion uses the same cleanup as an archived mission', async (t) => {
  const projectPath = mkdtempSync(join(tmpdir(), 'synkora-completed-removal-'))
  t.after(() => rmSync(projectPath, { recursive: true, force: true }))
  const mission = { id: 'completed-synthetic', projectId: 'proj-1', title: 'Synthetic completed mission', status: 'concluida' }
  const effects = []
  createHarness({ configure: (ctx, extras) => {
    ctx.projects.get = () => ({ id: 'proj-1', path: projectPath })
    ctx.missions = { get: () => mission, remove: () => effects.push('removed') }
    ctx.integrationQueue = { getByMission: () => undefined }
    ctx.ptys.kill = () => {}
    ctx.backlog.releaseMissionItems = () => effects.push('backlog')
    ctx.maestro.forget = () => effects.push('maestro')
    ctx.hub.purgeMissionEvents = () => effects.push('events')
    ctx.pushAll = () => {}
    extras.guiSessions.forgetWhere = () => effects.push('chats')
    extras.killMissionGuiPanes = async () => {
      await new Promise(resolve => setImmediate(resolve))
      effects.push('closed')
    }
  } })
  assert.deepEqual(await handlers.get('missions:remove')({}, mission.id), { ok: true })
  assert.deepEqual(effects, ['closed', 'backlog', 'removed', 'chats', 'maestro', 'events'])
})

test('mission discard confirmation rejects an untrusted renderer before lifecycle access', async () => {
  let accessed = false
  createHarness({ configure: (ctx, extras) => {
    extras.assertAppRendererSender = () => { throw new Error('Janela não autorizada.') }
    ctx.missions.get = () => { accessed = true; return undefined }
  } })
  await assert.rejects(async () => handlers.get('missions:remove')({}, 'synthetic', {
    discardToken: 'synthetic-token', confirmTitle: 'Synthetic mission'
  }), /janela não autorizada/iu)
  assert.equal(accessed, false)
})

test('mission discard transport validates authority and preserves an unknown mission', async () => {
  let checked = 0
  createHarness({ configure: (ctx, extras) => {
    extras.assertAppRendererSender = () => { checked++ }
    ctx.missions.get = () => undefined
  } })
  const result = await handlers.get('missions:remove')({}, 'synthetic', {
    discardToken: 'synthetic-token', confirmTitle: 'Synthetic mission'
  })
  assert.equal(result.ok, false)
  assert.ok(checked > 0)
})

for (const scenario of ['uncommitted changes', 'wrong branch']) {
test(`mission deletion preserves the record and worktree with ${scenario}`, async (t) => {
  const h = createIntegrationHarness(t)
  const mission = await h.missionWithDelivery('Uncommitted deletion', 'keep-changes.txt', 'synthetic delivery\n')
  mission.status = 'arquivada'
  if (scenario === 'uncommitted changes') writeFileSync(join(mission.worktree, 'keep-changes.txt'), 'uncommitted owner changes\n')
  else mission.branch = 'mission/wrong-synthetic-branch'
  let removed = 0
  createHarness({ configure: (ctx, extras) => {
    ctx.projects.get = () => ({ id: 'proj-1', path: h.projectPath })
    ctx.missions = { get: () => mission, remove: () => { removed++ } }
    ctx.integrationQueue = { getByMission: () => undefined }
    ctx.ptys.kill = () => {}
    ctx.backlog.releaseMissionItems = () => {}
    ctx.maestro.forget = () => {}
    ctx.hub.purgeMissionEvents = () => {}
    ctx.pushAll = () => {}
    extras.guiSessions.forgetWhere = () => {}
  } })
  const result = await handlers.get('missions:remove')({}, mission.id)
  assert.equal(result.ok, false)
  assert.match(result.error, scenario === 'uncommitted changes' ? /alterações locais/iu : /pasta.*missão/iu)
  assert.equal(removed, 0)
  assert.equal(readFileSync(join(mission.worktree, 'keep-changes.txt'), 'utf8'),
    scenario === 'uncommitted changes' ? 'uncommitted owner changes\n' : 'synthetic delivery\n')
})
}

test('mission deletion rechecks archived state after awaiting Mobile and Expo cleanup', async (t) => {
  const h = createIntegrationHarness(t)
  const mission = await h.missionWithDelivery('Mobile deletion race', 'keep-source.txt', 'synthetic delivery\n')
  mission.status = 'arquivada'
  let release, entered, removed = 0
  const cleanup = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  t.after(() => release())
  createHarness({ configure: (ctx, extras) => {
    ctx.projects.get = () => ({ id: 'proj-1', path: h.projectPath })
    ctx.missions = { get: () => mission, remove: () => { removed++ } }
    ctx.integrationQueue = { getByMission: () => undefined }
    ctx.ptys.kill = () => {}
    ctx.backlog.releaseMissionItems = () => {}
    ctx.maestro.forget = () => {}
    ctx.hub.purgeMissionEvents = () => {}
    ctx.pushAll = () => {}
    extras.guiSessions.forgetWhere = () => {}
    extras.killMissionGuiPanes = async () => { entered(); await cleanup }
  } })
  const deleting = handlers.get('missions:remove')({}, mission.id)
  await started
  mission.status = 'ativa'
  release()
  const result = await deleting
  assert.equal(result.ok, false)
  assert.match(result.error, /mudou/iu)
  assert.equal(removed, 0)
  assert.equal(existsSync(join(mission.worktree, '.git')), true)
})

test('integration_run entrega o resultado antes de matar o dev e limpar a origem', async (t) => {
  const kills = []
  const replies = []
  const h = createIntegrationHarness(t, {
    killMissionGuiPanes: (id, keepPaneId) => kills.push({ id, keepPaneId }),
    afterIntegrationReply: (id, text, finish) => replies.push({ id, text, finish })
  })
  const mission = await h.missionWithDelivery('Resultado antes da limpeza', 'reply.txt', 'entrega\n')
  const second = await h.missionWithDelivery('Proxima entrega', 'next.txt', 'proxima\n')
  await h.engine.startMissionIntegration(mission.id, 'user')
  await h.engine.startMissionIntegration(second.id, 'user')

  const run = await h.engine.runMissionIntegration('proj-1', mission.id)
  assert.equal(kills.some((call) => call.id === mission.id && !call.keepPaneId), false,
    'o dev não pode morrer esperando o retorno da própria ferramenta')
  assert.equal(replies.length, 1)
  assert.match(run, /MERGE GRAVADO/u)
  assert.match(run, /encerre o turno/iu, 'a receita do fecho adiado continua na resposta')
  assert.equal(existsSync(join(h.version.worktree, 'reply.txt')), true)
  assert.equal(existsSync(join(mission.worktree, '.git')), true, 'a origem vive até o recibo')
  assert.equal(h.integrationQueue.getByMission(mission.id).state, 'merging')
  assert.equal(h.engine.integrationDraining.has('proj-1'), true)
  assert.match(await h.engine.runMissionIntegration('proj-1', second.id), /em andamento/u)

  const final = await replies[0].finish()
  assert.match(final, /INTEGRADA/u)
  assert.equal(h.missionOf(mission.id).status, 'concluida')
  assert.equal(existsSync(mission.worktree), false)
  assert.equal(h.integrationQueue.getByMission(mission.id), undefined)
  assert.equal(h.integrationQueue.getByMission(second.id).isHead, true)
  assert.equal(h.engine.integrationDraining.has('proj-1'), false)
  assert.equal(kills.at(-1).keepPaneId, undefined)
})

test('falha antes do merge mantém o dev vivo e o mesmo ticket pronto para corrigir', async (t) => {
  const kills = []
  const replies = []
  const h = createIntegrationHarness(t, {
    killMissionGuiPanes: (id, keepPaneId) => kills.push({ id, keepPaneId }),
    afterIntegrationReply: (...args) => replies.push(args)
  })
  const mission = await h.missionWithDelivery('Falha sintetica', 'failure.txt', 'entrega\n')
  await h.engine.startMissionIntegration(mission.id, 'user')
  const before = h.targetSha()
  const ticketId = h.integrationQueue.getByMission(mission.id).id
  gitOffOverride = (fn, args) => fn === 'mergeTaskWorktree'
    ? { ok: false, detail: 'destino mudou antes do CAS' }
    : worktreeApi[fn](...args)
  const run = await h.engine.runMissionIntegration('proj-1', mission.id)
  assert.match(run, /NÃO rodou/u)
  assert.equal(h.targetSha(), before)
  assert.equal(h.integrationQueue.getByMission(mission.id).state, 'queued')
  assert.equal(h.integrationQueue.getByMission(mission.id).id, ticketId)
  assert.equal(kills.some((call) => !call.keepPaneId), false)
  assert.equal(replies.length, 0)
  assert.equal(h.engine.integrationDraining.has('proj-1'), false)
})

test('committed failure waits for the MCP receipt before attempting recovery', async (t) => {
  const replies = []
  const kills = []
  const h = createIntegrationHarness(t, {
    afterIntegrationReply: (id, text, finish) => replies.push({ id, text, finish }),
    killMissionGuiPanes: (id, keepPaneId) => kills.push({ id, keepPaneId })
  })
  const mission = await h.missionWithDelivery('Post-commit failure', 'committed.txt', 'delivery\n')
  await h.engine.startMissionIntegration(mission.id, 'user')
  gitOffOverride = (fn, args) => {
    const result = worktreeApi[fn](...args)
    return fn === 'mergeTaskWorktree'
      ? { ...result, ok: false, detail: 'synthetic failure after the commit' }
      : result
  }
  await h.engine.runMissionIntegration('proj-1', mission.id)
  assert.equal(replies.length, 1)
  assert.equal(kills.some(call => !call.keepPaneId), false)
  assert.equal(existsSync(join(mission.worktree, '.git')), true)
  const merged = h.targetSha()
  gitOffOverride = null
  assert.match(await replies[0].finish(), /INTEGRADA/u)
  assert.equal(h.targetSha(), merged)
  assert.equal(gitOffCalls.filter(({ fn }) => fn === 'mergeTaskWorktree').length, 1)
})

test('repair guiSpec reopens at the project root without recreating a partial worktree', async () => {
  const h = releaseWorkspaceHarness('codex', undefined, (ctx, _extras, mission) => {
    mission.missionType = 'dev'
    mission.worktree = join(userData, 'partially-removed-source')
    mission.branch = 'mission/synthetic'
    ctx.integrationQueue = { getByMission: () => ({ state: 'blocked', block: {
      owner: 'orchestrator', code: 'target_repair_pending', detail: 'synthetic cleanup failure'
    } }) }
    ctx.plans = { list: () => [] }
  })
  const result = await h.gui()
  assert.equal(result.ok, true, result.error)
  assert.equal(result.spawn.cwd, h.project.path)
  assert.equal(result.spawn.resumeSessionId, h.remembered.sessionId)
  assert.equal(existsSync(h.mission.worktree), false)
})

test('agent finalizes the approved repair ticket and keeps its recovery chat alive', async (t) => {
  const replies = []
  const kills = []
  const h = createIntegrationHarness(t, {
    afterIntegrationReply: (id, text, finish, recovery) => replies.push({ id, text, finish, recovery }),
    killMissionGuiPanes: (id, keepPaneId) => kills.push({ id, keepPaneId }),
    paneCwd: () => h.projectPath
  })
  const mission = await h.missionWithDelivery('Repair by agent', 'agent-repair.txt', 'delivery\n')
  const next = await h.missionWithDelivery('Next delivery', 'after-repair.txt', 'next\n')
  await h.engine.startMissionIntegration(mission.id, 'user')
  await h.engine.startMissionIntegration(next.id, 'user')
  await h.engine.runMissionIntegration('proj-1', mission.id)
  const merged = h.targetSha()
  const ticketId = h.integrationQueue.getByMission(mission.id).id
  gitOffOverride = (fn, args) => fn === 'removeWorktreeAndBranch' ? false : worktreeApi[fn](...args)
  await replies[0].finish()
  gitOffOverride = null
  assert.equal(typeof replies[0].recovery, 'function', 'failed cleanup must resume the agent')
  assert.equal(replies[0].recovery(), h.projectPath, 'repair runs outside the folder being removed')
  h.livePanes.add(guiMissionPaneId('dev', mission.id))
  assert.match(await h.engine.runMissionIntegration('another-project', mission.id), /não encontrei/u)
  const nextTicket = h.integrationQueue.getByMission(next.id)
  h.integrationQueue.requireTargetRepair(next.id, 'synthetic second repair')
  assert.match(await h.engine.runMissionIntegration('proj-1', next.id), /aguarde a vez/u)
  assert.equal(h.integrationQueue.getByMission(next.id).id, nextTicket.id)
  const status = await h.engine.missionIntegrationStatus('proj-1', mission.id)
  assert.match(status, /chame integration_run/u)
  assert.doesNotMatch(status, /peça ao dono para clicar/u)
  gitOffOverride = (fn, args) => fn === 'gitCommitReached' ? false : worktreeApi[fn](...args)
  assert.match(await h.engine.runMissionIntegration('proj-1', mission.id), /o Git ainda não prova/u)
  assert.equal(h.integrationQueue.getByMission(mission.id).id, ticketId)
  assert.equal(existsSync(join(mission.worktree, '.git')), true, 'the agent cannot clean up without proof')
  gitOffOverride = null
  rmSync(join(mission.worktree, '.git'))
  const before = gitOffCalls.length
  const result = await h.engine.runMissionIntegration('proj-1', mission.id)
  assert.match(result, /finalização concluída/u)
  assert.equal(h.targetSha(), merged)
  assert.equal(h.missionOf(mission.id).status, 'concluida')
  assert.equal(h.integrationQueue.getByMission(mission.id), undefined)
  assert.equal(h.integrationQueue.getByMission(next.id).isHead, true)
  assert.equal(h.missionOf(next.id).status, 'ativa')
  assert.equal(existsSync(next.worktree), true)
  assert.equal(kills.at(-1).keepPaneId, guiMissionPaneId('dev', mission.id))
  assert.equal(gitOffCalls.slice(before).some(({ fn }) => ['mergeTaskWorktree', 'createMissionWorktree'].includes(fn)), false)
  assert.equal(h.audited.find(event => event.event === 'mission-finalization-retry')?.actor, 'agent')
  assert.equal(replies[0].recovery(), undefined, 'finished/cancelled tickets never resurrect the agent')
  assert.ok(ticketId)
})

test('reopening a repair ticket wakes the agent with finalization instructions', async (t) => {
  const h = createIntegrationHarness(t)
  const mission = await h.missionWithDelivery('Reopen repair', 'reopen.txt', 'delivery\n')
  await h.engine.startMissionIntegration(mission.id, 'user')
  h.integrationQueue.requireTargetRepair(mission.id, 'synthetic cleanup failure')
  const paneId = guiMissionPaneId('dev', mission.id)
  h.livePanes.add(paneId)
  const before = h.stimuli.length
  const notesBefore = h.notesOf(paneId).length
  h.engine.restimulateIntegrationOnOpen(paneId, 'proj-1')
  assert.equal(h.stimuli.length, before + 1)
  assert.match(h.stimuli.at(-1).text, /integration_run/u)
  assert.match(h.stimuli.at(-1).text, /[Nn]ão.*merge/u)
  assert.match(h.stimuli.at(-1).text, /que VOCÊ iniciou/u, 'a receita nomeia a causa comum: processo do próprio agente')
  assert.doesNotMatch(h.stimuli.at(-1).text, /peça ao dono para clicar/u)
  // Reabrir (inclusive a retomada automática na raiz) não escreve nota de
  // máquina no fio: o dono já leu a nota do fecho; o agente fala em seguida.
  assert.equal(h.notesOf(paneId).length, notesBefore, 'a reabertura não duplica a nota do fecho')
})

test('agent still in the source receives the retry reply before finalization closes it', async (t) => {
  const replies = []
  const kills = []
  const h = createIntegrationHarness(t, {
    afterIntegrationReply: (id, text, finish, recovery, phase) => replies.push({ id, text, finish, recovery, phase }),
    killMissionGuiPanes: (id, keepPaneId) => kills.push({ id, keepPaneId })
  })
  const mission = await h.missionWithDelivery('Retry receipt', 'retry-receipt.txt', 'delivery\n')
  await h.engine.startMissionIntegration(mission.id, 'user')
  await h.engine.runMissionIntegration('proj-1', mission.id)
  gitOffOverride = (fn, args) => fn === 'removeWorktreeAndBranch' ? false : worktreeApi[fn](...args)
  await replies[0].finish()
  gitOffOverride = null
  const merged = h.targetSha()
  const before = kills.length
  const reply = await h.engine.runMissionIntegration('proj-1', mission.id)
  assert.match(reply, /Encerre o turno/u)
  assert.equal(kills.length, before, 'the MCP caller stays alive until the reply')
  assert.equal(replies.length, 2)
  assert.equal(replies[1].phase, 'finalization')
  assert.equal(h.engine.integrationDraining.has('proj-1'), true)
  assert.match(await replies[1].finish(), /finalização concluída/u)
  assert.equal(h.targetSha(), merged)
  assert.equal(h.engine.integrationDraining.has('proj-1'), false)
  assert.equal(gitOffCalls.filter(({ fn }) => fn === 'mergeTaskWorktree').length, 1)
})

test('retomar finalização recupera a origem sem .git e libera a fila sem repetir o merge', async (t) => {
  const replies = []
  let retrying = false
  let releaseClosing, enteredClosing
  const closing = new Promise(resolve => { releaseClosing = resolve })
  const entered = new Promise(resolve => { enteredClosing = resolve })
  const h = createIntegrationHarness(t, {
    afterIntegrationReply: (id, text, finish) => replies.push({ id, text, finish }),
    closeTestServersUnder: async () => {
      if (retrying) { enteredClosing(); await closing }
    }
  })
  const mission = await h.missionWithDelivery('Finalizacao pendente', 'retry.txt', 'entrega\n')
  const next = await h.missionWithDelivery('Aguardando finalizacao', 'next.txt', 'proxima\n')
  await h.engine.startMissionIntegration(mission.id, 'user')
  await h.engine.startMissionIntegration(next.id, 'user')
  await h.engine.runMissionIntegration('proj-1', mission.id)
  const merged = h.targetSha()
  gitOffOverride = (fn, args) => fn === 'removeWorktreeAndBranch' ? false : worktreeApi[fn](...args)
  await replies[0].finish()
  gitOffOverride = null
  rmSync(join(mission.worktree, '.git'))
  const creations = gitOffCalls.filter(call => call.fn === 'createMissionWorktree').length
  assert.equal(h.integrationQueue.getByMission(mission.id).block.code, 'target_repair_pending')
  gitOffOverride = (fn, args) => fn === 'gitCommitReached' ? false : worktreeApi[fn](...args)
  assert.match(await h.engine.startMissionIntegration(mission.id, 'user'), /o Git ainda não prova/u)
  assert.equal(existsSync(mission.worktree), true, 'sem prova do merge não limpa nem rearma a integração')
  assert.equal(h.integrationQueue.getByMission(mission.id).state, 'blocked')
  gitOffOverride = null
  retrying = true
  const retried = h.engine.startMissionIntegration(mission.id, 'user')
  await entered
  try {
    assert.match(await h.engine.startMissionIntegration(mission.id, 'user'), /já está em andamento/u)
    assert.match(await h.engine.runMissionIntegration('proj-1', next.id), /em andamento/u)
  } finally { releaseClosing() }
  assert.match(await retried, /finalização concluída/u)
  assert.equal(h.missionOf(mission.id).status, 'concluida')
  assert.equal(h.integrationQueue.getByMission(mission.id), undefined)
  assert.equal(h.integrationQueue.getByMission(next.id).isHead, true)
  assert.equal(h.missionOf(next.id).status, 'ativa')
  assert.equal(existsSync(next.worktree), true)
  assert.equal(existsSync(mission.worktree), false)
  assert.equal(h.targetSha(), merged)
  assert.equal(gitOffCalls.filter(call => call.fn === 'mergeTaskWorktree').length, 1)
  assert.equal(gitOffCalls.filter(call => call.fn === 'createMissionWorktree').length, creations)
  assert.equal(h.engine.integrationDraining.has('proj-1'), false)
  assert.match(await h.engine.startMissionIntegration(mission.id, 'user'), /já integrada/u)
  assert.equal(h.targetSha(), merged)
})

test('retomar finalização preserva a origem quando o ticket muda durante a espera do preview', async (t) => {
  const replies = []
  let cancelDuringRetry = false
  let mission
  const h = createIntegrationHarness(t, {
    afterIntegrationReply: (id, text, finish) => replies.push({ id, text, finish }),
    closeTestServersUnder: async () => {
      if (cancelDuringRetry) {
        await new Promise(resolve => setImmediate(resolve))
        h.integrationQueue.cancel(mission.id)
      }
    }
  })
  mission = await h.missionWithDelivery('Ticket alterado', 'ticket.txt', 'entrega\n')
  await h.engine.startMissionIntegration(mission.id, 'user')
  await h.engine.runMissionIntegration('proj-1', mission.id)
  gitOffOverride = (fn, args) => fn === 'removeWorktreeAndBranch' ? false : worktreeApi[fn](...args)
  await replies[0].finish()
  gitOffOverride = null
  const removals = gitOffCalls.filter(call => call.fn === 'removeWorktreeAndBranch').length
  const merged = h.targetSha()
  cancelDuringRetry = true
  assert.match(await h.engine.startMissionIntegration(mission.id, 'user'), /finalização continua pendente/u)
  assert.notEqual(h.missionOf(mission.id).status, 'concluida')
  assert.equal(existsSync(mission.worktree), true)
  assert.equal(gitOffCalls.filter(call => call.fn === 'removeWorktreeAndBranch').length, removals)
  assert.equal(h.targetSha(), merged)
  assert.equal(h.engine.integrationDraining.has('proj-1'), false)
})

test('origem alterada depois do recibo é preservada e a falha de limpeza não repete o merge', async (t) => {
  const replies = []
  const h = createIntegrationHarness(t, {
    afterIntegrationReply: (id, text, finish) => replies.push({ id, text, finish }),
    paneCwd: () => h.projectPath
  })
  const mission = await h.missionWithDelivery('Origem preservada', 'kept.txt', 'entrega\n')
  await h.engine.startMissionIntegration(mission.id, 'user')
  await h.engine.runMissionIntegration('proj-1', mission.id)
  const merged = h.targetSha()
  writeFileSync(join(mission.worktree, 'kept.txt'), 'edicao tardia\n', 'utf8')
  const final = await replies[0].finish()
  // A NOTA DO FECHO ADIADO É PARA O DONO (print de 2026-09-16): a receita do
  // agente viaja pelo bastidor (estímulo), nunca pelo fio.
  assert.match(final, /pasta da missão ainda está presa/u)
  assert.doesNotMatch(final, /integration_run|Consulte|JÁ FOI GRAVADO|intent preservado/u)
  assert.doesNotMatch(final, /arquivos do destino|processo que está segurando/u)
  assert.equal(h.integrationQueue.getByMission(mission.id).block.code, 'target_repair_pending')
  assert.equal(existsSync(join(mission.worktree, '.git')), true)
  assert.equal(h.engine.integrationDraining.has('proj-1'), false)
  assert.match(await h.engine.runMissionIntegration('proj-1', mission.id), /finalização continua pendente/u)
  assert.match(await h.engine.startMissionIntegration(mission.id, 'user'), /finalização continua pendente/u)
  assert.notEqual(h.missionOf(mission.id).status, 'concluida')
  assert.equal(readFileSync(join(mission.worktree, 'kept.txt'), 'utf8'), 'edicao tardia\n')
  assert.equal(h.targetSha(), merged)
  assert.equal(gitOffCalls.filter((call) => call.fn === 'mergeTaskWorktree').length, 1)
})

test('exceção ao armar o recibo depois do merge falha fechada e libera a trava', async (t) => {
  const h = createIntegrationHarness(t, {
    afterIntegrationReply: () => { throw new Error('synthetic reply registration failure') }
  })
  const mission = await h.missionWithDelivery('Recibo indisponivel', 'receipt.txt', 'entrega\n')
  await h.engine.startMissionIntegration(mission.id, 'user')
  const run = await h.engine.runMissionIntegration('proj-1', mission.id)
  assert.match(run, /merge foi GRAVADO/u)
  assert.equal(h.integrationQueue.getByMission(mission.id).block.code, 'target_repair_pending')
  assert.equal(h.engine.integrationDraining.has('proj-1'), false)
  assert.equal(existsSync(join(mission.worktree, '.git')), true)
})

test('CONFLITO volta ao agente com a receita — e o ticket NUNCA vira blocked', async (t) => {
  const h = createIntegrationHarness(t)
  const mission = await h.missionWithDelivery('Rail da fila', 'base.txt', 'lado da missao\n')
  await h.engine.startMissionIntegration(mission.id, 'user')
  // o destino andou por fora, tocando o MESMO arquivo
  h.advanceTarget('lado da versao\n')
  const targetAntes = h.targetSha()

  const run = await h.engine.runMissionIntegration('proj-1', mission.id)

  assert.match(run, /PAROU/u)
  assert.match(run, /CONFLITO com o destino/u)
  // O veredito do git chega como o git DESTA máquina o escreveu: o arquivo é
  // garantido; as linhas informativas ("CONFLICT (content): …") são OPCIONAIS
  // conforme a versão do git — amarrar o teste a elas quebrava em máquina cuja
  // saída do merge-tree traz só os caminhos. O passthrough verbatim das linhas,
  // quando existem, está preso na função PURA (test-gui-mission-contracts.mjs,
  // "o veredito do merge-tree atravessa VERBATIM").
  assert.match(run, /CONFLITO, COMO O GIT REPORTOU:/u)
  assert.match(run, /· base\.txt/u)
  assert.match(run, /integration_run de novo/u)
  assert.match(run, /decisão de produto/u)
  assert.equal(h.targetSha(), targetAntes, 'conflito não toca no destino')

  // O CONTRATO DA RODADA: o ticket fica na CABEÇA com o motivo — nada de card
  // parado esperando decisão de máquina.
  const ticket = h.integrationQueue.getByMission(mission.id)
  assert.equal(ticket.state, 'queued')
  assert.equal(ticket.isHead, true)
  assert.equal(ticket.block, undefined)
  assert.match(ticket.lastError, /CONFLITO/u)
  assert.equal(h.missionOf(mission.id).status, 'ativa')
  assert.ok(h.audited.some((event) => event.event === 'mission-integration-conflict'))
})

test('resolver o conflito e rodar de novo INTEGRA — com o re-lacre auditado', async (t) => {
  const h = createIntegrationHarness(t)
  const mission = await h.missionWithDelivery('Rail da fila', 'base.txt', 'lado da missao\n')
  await h.engine.startMissionIntegration(mission.id, 'user')
  const lacreOriginal = h.integrationQueue.getByMission(mission.id).sourceHead
  h.advanceTarget('lado da versao\n')
  await h.engine.runMissionIntegration('proj-1', mission.id)

  // O AGENTE RESOLVE, no worktree DELE, exatamente como a receita manda.
  gitCli(mission.worktree, ['merge', '-X', 'ours', '--no-edit', h.version.branch])
  const lacreNovo = gitCli(mission.worktree, ['rev-parse', 'HEAD'])
  assert.notEqual(lacreNovo, lacreOriginal, 'resolver conflito MUDA o commit da entrega')

  const run = await h.engine.runMissionIntegration('proj-1', mission.id)
  assert.match(run, /INTEGRADA/u)
  assert.equal(h.missionOf(mission.id).status, 'concluida')

  // O ⇪ autorizou a INTENÇÃO, não um sha: o lacre acompanhou, e o par
  // velho→novo virou evento + nota no fio (transparência, não segunda porteira).
  const reseal = h.audited.find((event) => event.event === 'mission-integration-resealed')
  assert.ok(reseal, 'o re-lacre precisa ser auditado')
  assert.equal(reseal.prev, lacreOriginal.slice(0, 12))
  assert.equal(reseal.next, lacreNovo.slice(0, 12))
  assert.ok(
    h.notesOf(h.devPaneOf(mission)).some((note) => /re-lacrado/u.test(note)),
    'o dono lê o re-lacre no fio'
  )
})

test('ticket congelado pela era da máquina é REABERTO pelo agente em vez de virar beco', async (t) => {
  const h = createIntegrationHarness(t)
  const mission = await h.missionWithDelivery('Rail da fila', 'rail.txt', 'entrega\n')
  await h.engine.startMissionIntegration(mission.id, 'user')
  // exatamente o que a era anterior deixava no disco
  h.integrationQueue.block(mission.id, {
    code: 'merge_conflict',
    owner: 'maestro',
    detail: 'a estratégia precisava do Maestro'
  })

  assert.match(
    await h.engine.missionIntegrationStatus('proj-1', mission.id),
    /congelado por uma era anterior/u
  )
  const run = await h.engine.runMissionIntegration('proj-1', mission.id)
  assert.match(run, /INTEGRADA/u)
  assert.ok(h.audited.some((event) => event.event === 'mission-integration-reclaimed'))
})

// ————— R17 (2026-08-19): O ⇪ SOBE SEM TRAVAR O APP —————
//
// O dono mediu com os sensores armados: 809ms de main thread parado no instante
// do clique, 1546ms no meio do run, e NENHUM git individual acima de 200ms. A
// rajada de gits baratos e SÍNCRONOS é que virava o estol (no Windows cada
// spawn custa ~100-180ms de imposto do Defender). A cura é TRANSPORTE: as
// mesmas perguntas, na mesma ordem, dentro do gitWorker.
//
// Aqui a missão tem VERSÃO ISOLADA — o destino não é a base, é a branch da
// versão —, então este é justamente o trecho que o teste da fila (destino base)
// não cobre: a IDENTIDADE DO DESTINO também precisa viajar.

test('R17: o ⇪ de uma missão com VERSÃO manda a rajada inteira para o gitWorker', async (t) => {
  const h = createIntegrationHarness(t)
  const mission = await h.missionWithDelivery('Rail da fila', 'rail.txt', 'entrega\n')
  // O nascimento da missão tem git próprio (base da versão, worktree); o que
  // este teste mede é o CLIQUE, e só ele.
  gitOffCalls.length = 0

  const msg = await h.engine.startMissionIntegration(mission.id, 'user')

  assert.match(msg, /fila de integração/u, msg)
  assert.deepEqual(
    gitOffCalls.map((call) => call.fn),
    [
      'hasGitCommit', //             ensureMissionWorktree: o repo tem commit?
      'ensureSynkoraGitExcludes', // ensureMissionWorktree: .synkora invisível
      'isExpectedWorktree', //       ensureMissionWorktree: worktree DESTA missão
      'ensureWorktreeEnvironment', // configurações locais ausentes, sem sobrescrita
      'hasGitCommit', //             projeto git? (sem git não há merge)
      'resolveMissionWorkspace', //  o worktree isolado, provado
      'isExpectedVersionWorktree', // R18.3: o ISOLAMENTO da versão (era o
      //                              predicado síncrono, ~5 spawns no main)
      'isExpectedWorktree', //       IDENTIDADE DO DESTINO: a branch da versão
      'isWorktreeClean', //          a árvore da entrega está limpa
      'gitHead', //                  lacre da ORIGEM
      'gitHead' //                   fotografia do DESTINO
    ],
    'a rajada do ⇪ tem de viajar inteira, na ordem exata das porteiras'
  )
  // E o ticket nasceu igual: transporte não mexeu em nenhuma decisão.
  const ticket = h.integrationQueue.getByMission(mission.id)
  assert.equal(ticket.state, 'queued')
  assert.equal(ticket.targetBranch, h.version.branch)
})

// ————— R18 (2026-08-19): OS RESÍDUOS DO ESTOL —————

test('R18: a resolução do destino pergunta o isolamento da versão pelo gitWorker', async (t) => {
  const h = createIntegrationHarness(t)
  const mission = await h.missionWithDelivery('Rail da fila', 'rail.txt', 'entrega\n')
  gitOffCalls.length = 0

  await h.engine.startMissionIntegration(mission.id, 'user')

  // O probe entra EXATAMENTE no lugar do predicado antigo: logo depois de
  // provar o workspace da missão e logo ANTES da identidade do destino — a
  // ordem é parte do lacre (cada resposta decide a pergunta seguinte).
  const nomes = gitOffCalls.map((call) => call.fn)
  const probe = nomes.indexOf('isExpectedVersionWorktree')
  assert.ok(probe >= 0, `o isolamento da versão não viajou: ${nomes.join(' → ')}`)
  assert.equal(nomes[probe - 1], 'resolveMissionWorkspace')
  assert.equal(nomes[probe + 1], 'isExpectedWorktree')
  // e ele é perguntado sobre o worktree/branch DA VERSÃO, não sobre a missão
  assert.deepEqual(gitOffCalls[probe].args, [
    h.projectPath,
    h.version.worktree,
    h.version.branch
  ])
})

// (R18.4 — o twin no criar missão — foi entregue, MEDIDO e revertido no
// review: missão recém-nascida nunca casa o atalho saudável e o caminho
// síncrono rodava inteiro do mesmo jeito; o teste saiu junto com a linha.)
