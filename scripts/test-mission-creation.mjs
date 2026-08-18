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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const gitAsyncStub = {
  GIT_CHECKPOINT_MARKER: '__SYNKORA_GIT_CHECKPOINT__',
  gitOff: async (fn, ...args) => {
    gitOffCalls.push({ fn, args, probe: gitOffProbe ? gitOffProbe() : undefined })
    if (gitOffOverride) return gitOffOverride(fn, args)
    return worktreeApi[fn](...args)
  },
  gitOffWithCheckpoint: async () => {
    throw new Error('gitOffWithCheckpoint não participa da criação de missão')
  }
}

const loadModule = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  if (/(^|[\\/])gitAsync(\.js)?$/.test(request)) return gitAsyncStub
  return loadModule.call(this, request, parent, isMain)
}

const { registerMissionsIpc } = require(join(COMPILED, 'ipc', 'missions.js'))
const { createMissionEngine } = require(join(COMPILED, 'missionEngine.js'))
const worktreeApi = require(join(COMPILED, 'worktree.js'))

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
function createEngineOnRealRepository(t) {
  const projectPath = mkdtempSync(join(tmpdir(), 'synkora-base-create-'))
  const worktreesRoot = mkdtempSync(join(tmpdir(), 'synkora-base-create-wt-'))
  t.after(() => {
    rmSync(worktreesRoot, { recursive: true, force: true })
    rmSync(projectPath, { recursive: true, force: true })
  })
  gitCli(projectPath, ['init'])
  gitCli(projectPath, ['config', 'user.name', 'Synkora Test'])
  gitCli(projectPath, ['config', 'user.email', 'synkora-test@example.invalid'])
  writeFileSync(join(projectPath, 'base.txt'), 'base\n', 'utf8')
  gitCli(projectPath, ['add', '-A'])
  gitCli(projectPath, ['commit', '-m', 'commit inicial'])
  const mainBranch = gitCli(projectPath, ['branch', '--show-current'])

  const isolation = worktreeApi.createVersionWorktree(projectPath, worktreesRoot, 'V1.0', 'versaobase')
  assert.ok(isolation, 'a versão precisa nascer isolada, como no caso real')
  const version = {
    id: 'versaobase',
    projectId: 'proj-1',
    name: 'V1.0',
    status: 'aberta',
    deliveries: [],
    branch: isolation.branch,
    worktree: isolation.dir,
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z'
  }

  const missionsStore = new Map()
  const published = []
  const audited = []
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
    pushAll: () => {},
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
    advanceMainOutsideSynkora,
    versionSha,
    missionOf: (id) => missionsStore.get(id),
    /** Quantas missões JÁ derivaram worktree — a régua de ordem do seam. */
    missionsWithWorktree: () =>
      [...missionsStore.values()].filter((mission) => mission.worktree).length
  }
}

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
