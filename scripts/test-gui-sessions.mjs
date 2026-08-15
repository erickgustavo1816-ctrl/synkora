import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  GUI_PERMISSION_MODES,
  GUI_RING_BYTE_CAP,
  GUI_RING_CAP,
  GUI_TRANSCRIPT_STORE_BYTE_CAP,
  GUI_TRANSCRIPT_STORE_PANE_CAP,
  GuiEventRing,
  GuiSessionRegistry,
  GUI_PROMPT_MAX_CHARS,
  guiMessageIdProblem,
  guiQueuedDeliveryProblem,
  guiPromptProblem,
  guiPermissionProfile,
  rememberedGuiExecutorValue,
  guiSessionWithoutIdentity,
  guiSessionWithoutResume,
  inheritedResumeSessionId,
  isGuiPersistedEvent,
  isGuiPermissionMode,
  pruneGuiTranscripts,
  spawnFingerprint
} from '../.tmp/gui-sessions-test/guiSessions.js'
import { MaestroSession } from '../.tmp/gui-sessions-test/maestroSession.js'
import { CodexSession } from '../.tmp/gui-sessions-test/codexSession.js'
import { GuiClaudeTaskRegistry } from '../.tmp/gui-sessions-test/guiClaudeTasks.js'
import {
  GUI_CODEX_AGENT_TOOL_PREFIX,
  GuiCodexAgentRegistry,
  guiCodexAgentName,
  guiCodexAgentToolUseId
} from '../.tmp/gui-sessions-test/guiCodexAgents.js'
import {
  guiChildNeedsTermination,
  guiTreeKillCommand
} from '../.tmp/gui-sessions-test/guiProcessTree.js'
import {
  GUI_ATTACHMENT_MAX_BYTES,
  GUI_ATTACHMENT_MAX_BASE64_CHARS,
  GUI_ATTACHMENT_MAX_FILES,
  GUI_ATTACHMENT_MAX_TOTAL_BYTES,
  GUI_ATTACHMENT_IMAGE_MAX_DIMENSION,
  GUI_ATTACHMENT_IMAGE_MAX_PIXELS,
  attachPayloadProblem,
  attachmentBase64Problem,
  attachmentTooLargeError,
  base64ByteLength,
  guiAttachmentKindForName,
  guiAttachmentMediaType,
  guiAttachmentOpenProblem,
  guiSafeImageInfo,
  isGuiAttachmentDescriptor,
  safeAttachmentName,
  stripDataUrlPrefix,
  uniqueAttachmentPath,
  withGuiAttachmentReferences
} from '../.tmp/gui-sessions-test/guiAttachments.js'
import {
  chatPermissionRuleLabel,
  fallbackBashPermissionRule,
  resolveChatPermissionSuggestions
} from '../.tmp/gui-sessions-test/chatPermissions.js'
import {
  prepareGuiAttachmentDirectory,
  resolveGuiExternalFolderReference,
  resolveGuiFolderReference,
  validateGuiAttachmentReferences,
  writeGuiAttachmentExclusive
} from '../.tmp/gui-sessions-test/guiAttachmentStorage.js'
import { GuiAttachmentCapabilityStore } from '../.tmp/gui-sessions-test/guiAttachmentCapabilities.js'
import { closePendingGuiTools } from '../src/renderer/src/guiTerminalTools.ts'

test('permissão permanente mostra e grava apenas a regra Bash estreita', () => {
  assert.equal(
    fallbackBashPermissionRule('Bash', { command: 'git commit -m "ok"' }),
    'Bash(git commit:*)'
  )
  assert.deepEqual(
    resolveChatPermissionSuggestions('Bash', { command: 'git commit -m "ok"' }, []),
    [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'git commit:*' }],
        behavior: 'allow',
        destination: 'localSettings'
      }
    ]
  )
  assert.deepEqual(
    resolveChatPermissionSuggestions('Bash', { command: 'git status' }, [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }],
        behavior: 'allow',
        destination: 'localSettings'
      }
    ]),
    [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }],
        behavior: 'allow',
        destination: 'localSettings'
      }
    ],
    'sugestão do CLI vence o fallback'
  )
  assert.equal(
    chatPermissionRuleLabel([
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'git commit:*' }],
        behavior: 'allow',
        destination: 'localSettings'
      }
    ]),
    'Bash(git commit:*)',
    'o card consegue mostrar a regra antes do clique'
  )
  assert.deepEqual(
    resolveChatPermissionSuggestions('Write', { file_path: 'fora.txt' }, []),
    [],
    'ferramenta fora da família Bash não recebe uma regra inventada'
  )
  assert.equal(
    fallbackBashPermissionRule('Bash', { command: 'git && commit' }),
    undefined,
    'metacaracteres de shell não entram no fallback'
  )
})

// Anel de eventos — é ele que faz a remontagem do pane GUI não nascer vazia
// enquanto a sessão segue viva (docs/GUI_PANE_CONTRACT.md, gui:state).

test('o anel preserva a ordem e devolve uma cópia', () => {
  const ring = new GuiEventRing(4)
  ring.push({ type: 'init' })
  ring.push({ type: 'delta', text: 'a' })

  assert.equal(ring.size, 2)
  assert.deepEqual(ring.snapshot(), [{ type: 'init' }, { type: 'delta', text: 'a' }])

  const taken = ring.snapshot()
  taken.push({ type: 'intruso' })
  assert.equal(ring.size, 2, 'mexer no snapshot nunca muda o anel')
})

test('cursor monotônico compacta deltas sem perder chunks repetidos', () => {
  const ring = new GuiEventRing(4)
  const first = ring.push({ type: 'delta', text: 'a' })
  const second = ring.push({ type: 'delta', text: 'a' })
  assert.equal(second, first + 1)
  assert.equal(ring.cursor, second)
  assert.deepEqual(ring.sequencedSnapshot(), [
    { seq: second, evt: { type: 'delta', text: 'aa' } }
  ])
})

test('nova geração substitui o executor sticky da conta anterior', () => {
  const ring = new GuiEventRing()
  ring.push({ type: 'executor-changed', model: 'opus', effort: 'high' })
  ring.push({ type: 'session-restarted', ready: false })
  ring.push({ type: 'executor-changed', model: null, effort: null })
  assert.deepEqual(ring.snapshot(), [
    { type: 'session-restarted', ready: false },
    { type: 'executor-changed', model: null, effort: null }
  ])
})

test('barreira de resume não deixa medição de contexto antiga sobreviver sozinha', () => {
  const ring = new GuiEventRing(2)
  ring.push({ type: 'context-usage', contextTokens: 120_000, contextWindow: 258_400 })
  ring.push({ type: 'session-restarted', ready: true })
  ring.push({ type: 'command-output', text: 'nova geração' })
  ring.push({ type: 'command-output', text: 'continua' })

  // O redutor recebe primeiro a medida antiga e logo a barreira, que a limpa.
  // Sem reter essa barreira, um replay posterior mostraria contexto do processo morto.
  assert.deepEqual(
    ring.snapshot().filter((event) => event.type === 'context-usage' || event.type === 'session-restarted'),
    [
      { type: 'context-usage', contextTokens: 120_000, contextWindow: 258_400 },
      { type: 'session-restarted', ready: true }
    ]
  )
})

test('limpeza explícita esvazia o fio sem reciclar seq do listener vivo', () => {
  const ring = new GuiEventRing()
  ring.push({ type: 'text', text: 'antiga' })
  const before = ring.cursor
  ring.clear(true)
  const cleared = ring.push({ type: 'conversation-cleared' })
  assert.equal(cleared, before + 1)
  assert.deepEqual(ring.snapshot(), [{ type: 'conversation-cleared' }])
})

test('hidratação aceita só eventos completos do contrato conhecido', () => {
  assert.equal(
    isGuiPersistedEvent({
      type: 'ready',
      caps: {
        commands: [{ name: '/status', description: 'mostra o estado' }],
        models: [{ value: 'opus', displayName: 'Opus' }]
      }
    }),
    true
  )
  assert.equal(
    isGuiPersistedEvent({
      type: 'permission',
      requestId: 'req-1',
      toolName: 'Bash',
      description: 'npm test',
      inputPretty: '{}',
      canAlways: false
    }),
    true
  )
  assert.equal(
    isGuiPersistedEvent({
      type: 'context-usage',
      contextTokens: 1_312,
      contextWindow: 258_400
    }),
    true
  )
  assert.equal(
    isGuiPersistedEvent({ type: 'context-usage', contextTokens: 1_312 }),
    false,
    'fotografia parcial não pode reintroduzir uma janela estimada'
  )
  assert.equal(isGuiPersistedEvent({ type: 'delta', text: 7 }), false)
  assert.equal(isGuiPersistedEvent({ type: 'ready', caps: { commands: {}, models: [] } }), false)
  assert.equal(isGuiPersistedEvent({ type: 'inventado', text: 'não hidratar' }), false)
})

test('documento limita globalmente panes e bytes, preservando a foto recém-salva', () => {
  const transcript = (updatedAt, text) => ({
    events: [{ type: 'text', text }],
    cursor: 1,
    updatedAt
  })
  const byCount = {
    old: transcript('2026-08-01T00:00:00.000Z', 'a'),
    middle: transcript('2026-08-02T00:00:00.000Z', 'b'),
    current: transcript('2026-08-03T00:00:00.000Z', 'c')
  }
  assert.deepEqual(
    pruneGuiTranscripts(byCount, 'old', Number.MAX_SAFE_INTEGER, 2),
    ['middle']
  )
  assert.deepEqual(Object.keys(byCount).sort(), ['current', 'old'])

  const byBytes = {
    old: transcript('2026-08-01T00:00:00.000Z', 'a'.repeat(200)),
    current: transcript('2026-08-03T00:00:00.000Z', 'b'.repeat(200))
  }
  assert.deepEqual(pruneGuiTranscripts(byBytes, 'current', 1, 10), ['old', 'current'])
  assert.deepEqual(Object.keys(byBytes), [], 'nem o pane atual pode furar o teto duro')
  assert.equal(GUI_TRANSCRIPT_STORE_BYTE_CAP, 32 * 1024 * 1024)
  assert.equal(GUI_TRANSCRIPT_STORE_PANE_CAP, 64)
})

test('estourar o teto descarta os MAIS ANTIGOS e mantém a janela cheia', () => {
  const ring = new GuiEventRing(3)
  for (const text of ['a', 'b', 'c', 'd', 'e']) ring.push({ type: 'command-output', text })

  assert.equal(ring.size, 3)
  assert.deepEqual(
    ring.snapshot().map((e) => e.text),
    ['c', 'd', 'e']
  )
})

test('o anel também respeita orçamento agregado de bytes', () => {
  const ring = new GuiEventRing(20, 180)
  ring.push({ type: 'tool', input: { content: 'a'.repeat(90) } })
  ring.push({ type: 'tool', input: { content: 'b'.repeat(90) } })
  assert.equal(ring.size, 1)
  assert.match(ring.snapshot()[0].input.content, /^b+$/u)

  const oversized = new GuiEventRing(20, 8)
  oversized.push({ type: 'fatal', text: 'o evento terminal mais novo sobrevive' })
  assert.equal(oversized.size, 1)
  assert.equal(GUI_RING_BYTE_CAP, 4 * 1024 * 1024)
})

test('metadados essenciais sobrevivem à evicção e remontam a sessão pronta', () => {
  const ring = new GuiEventRing(30, 900)
  ring.push({ type: 'init', model: 'claude', sessionId: 's-1' })
  ring.push({ type: 'ready', caps: { commands: [], models: [] } })
  for (let index = 0; index < 20; index += 1) {
    ring.push({ type: 'tool', input: { content: String(index).repeat(120) } })
  }
  const replay = ring.snapshot()
  assert.equal(replay[0].type, 'init')
  assert.equal(replay[1].type, 'ready')
  assert.ok(replay.some((event) => event.type === 'tool'))
})

test('teto inválido cai no padrão do contrato', () => {
  for (const cap of [0, -10]) {
    const ring = new GuiEventRing(cap)
    for (let i = 0; i < GUI_RING_CAP + 5; i += 1) ring.push(i)
    assert.equal(ring.size, GUI_RING_CAP)
  }
})

test('interacoes pendentes sobrevivem ao trafego e saem por requestId ou terminal', () => {
  const ring = new GuiEventRing(4, 900)
  ring.push({ type: 'result', text: 'turno anterior', isError: false })
  ring.push({ type: 'permission', requestId: 'req-a', toolName: 'Bash' })
  ring.push({ type: 'question', requestId: 'req-b', questions: [] })
  for (let index = 0; index < 8; index += 1) {
    ring.push({ type: 'delta', text: String(index).repeat(90) })
  }

  let replay = ring.snapshot()
  assert.deepEqual(
    replay.filter((event) => event.type === 'permission' || event.type === 'question'),
    [
      { type: 'permission', requestId: 'req-a', toolName: 'Bash' },
      { type: 'question', requestId: 'req-b', questions: [] }
    ]
  )
  assert.deepEqual(replay.slice(-2).map((event) => event.requestId), ['req-a', 'req-b'])

  ring.push({ type: 'interaction-resolved', requestId: 'req-a', resolution: { kind: 'stale' } })
  replay = ring.snapshot()
  assert.equal(replay.some((event) => event.requestId === 'req-a' && event.type === 'permission'), false)
  assert.equal(replay.some((event) => event.requestId === 'req-a' && event.type === 'interaction-resolved'), true)
  assert.equal(replay.some((event) => event.requestId === 'req-b' && event.type === 'question'), true)

  ring.push({ type: 'result', text: '', isError: false })
  replay = ring.snapshot()
  assert.equal(replay.some((event) => event.requestId === 'req-b' && event.type === 'question'), false)
  assert.equal(replay.at(-1).type, 'result')
})

test('clear zera o replay', () => {
  const ring = new GuiEventRing()
  ring.push({ type: 'text', text: 'oi' })
  ring.clear()
  assert.deepEqual(ring.snapshot(), [])
})

// Guardas do registro que NÃO spawnam processo: spawn inválido é recusado com
// texto de UI em PT-BR, e pane sem sessão nunca finge estar vivo.

const registry = () =>
  new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined
  })

test('decisões interativas entram no replay canônico com o requestId correto', () => {
  const gui = registry()
  const ring = new GuiEventRing()
  const session = Object.create(MaestroSession.prototype)
  session.answerPermission = () => ({
    toolUseId: 'tool-a',
    toolName: 'Bash',
    description: 'npm test'
  })
  session.answerQuestion = () => true
  session.answerPlanReview = () => true
  const sink = (evt) => ring.push(evt)
  gui.panes.set('p-canonico', {
    spawn: {
      paneId: 'p-canonico',
      projectId: 'proj',
      cli: 'claude',
      configDir: 'c',
      cwd: '/tmp'
    },
    fingerprint: 'teste',
    session,
    ring,
    token: { alive: true },
    sink
  })

  assert.equal(gui.permission('p-canonico', 'req-perm', 'deny').ok, true)
  assert.equal(
    gui.answerQuestion('p-canonico', 'req-question', { 'Qual opção?': 'A' }).ok,
    true
  )
  assert.equal(gui.answerPlan('p-canonico', 'req-plan', false).ok, true)

  assert.deepEqual(ring.snapshot(), [
    {
      type: 'interaction-resolved',
      requestId: 'req-perm',
      resolution: {
        kind: 'permission',
        toolUseId: 'tool-a',
        toolName: 'Bash',
        behavior: 'deny'
      }
    },
    {
      type: 'interaction-resolved',
      requestId: 'req-question',
      resolution: {
        kind: 'question',
        entries: [{ question: 'Qual opção?', answer: 'A' }]
      }
    },
    {
      type: 'interaction-resolved',
      requestId: 'req-plan',
      resolution: { kind: 'plan', approve: false }
    }
  ])
})

test('todo envio anuncia início de turno no replay antes de tocar no backend', () => {
  const gui = registry()
  const ring = new GuiEventRing()
  const sent = []
  const session = { alive: true, send: (text) => sent.push(text) }
  const sink = (evt) => ring.push(evt)
  gui.panes.set('p-send', {
    spawn: {
      paneId: 'p-send',
      projectId: 'proj',
      cli: 'claude',
      configDir: 'c',
      cwd: '/tmp'
    },
    fingerprint: 'teste',
    session,
    ring,
    token: { alive: true },
    sink
  })

  assert.equal(gui.send('p-send', 'mensagem', 'g-test').ok, true)
  assert.equal(gui.send('p-send', 'mensagem duplicada', 'g-test').ok, true)
  assert.deepEqual(sent, ['mensagem'])
  const replay = ring.snapshot()
  assert.equal(replay.length, 2)
  assert.deepEqual(
    { ...replay[0], at: typeof replay[0].at },
    { type: 'user-message', id: 'g-test', text: 'mensagem', at: 'number' }
  )
  assert.deepEqual(replay[1], { type: 'turn-started' })
})

test('modelo e effort mudam em voo sem respawn nem linha visual no transcript', async () => {
  const gui = registry()
  const ring = new GuiEventRing()
  ring.push({ type: 'text', text: 'fio preservado' })
  const applied = []
  const session = {
    alive: true,
    turnActive: false,
    caps: {
      commands: [],
      models: [
        {
          value: 'opus',
          displayName: 'Opus',
          supportedEffortLevels: ['low', 'high']
        }
      ]
    },
    setExecutor: async (input) => {
      applied.push(input)
      return true
    }
  }
  const spawn = {
    paneId: 'p-executor-live',
    projectId: 'proj',
    cli: 'claude',
    configDir: 'c',
    cwd: '/tmp',
    model: 'opus',
    effort: 'high'
  }
  gui.panes.set(spawn.paneId, {
    spawn,
    fingerprint: spawnFingerprint(spawn),
    session,
    ring,
    token: { alive: true },
    sink: (event) => ring.push(event)
  })
  assert.deepEqual(await gui.configureExecutor(spawn.paneId, { effort: 'low' }), {
    ok: true,
    model: 'opus',
    effort: 'low'
  })
  assert.deepEqual(applied, [{ model: 'opus', effort: 'low' }])
  assert.deepEqual(ring.snapshot(), [
    { type: 'text', text: 'fio preservado' },
    { type: 'executor-changed', model: 'opus', effort: 'low' }
  ])
  assert.equal(gui.panes.get(spawn.paneId).session, session, 'o backend vivo é o mesmo')
  assert.equal(gui.remembered(spawn.paneId).effort, 'low')

  assert.equal((await gui.configureExecutor(spawn.paneId, { effort: null })).ok, true)
  assert.equal(gui.remembered(spawn.paneId).effort, null, 'padrão explícito fica persistido')
  assert.deepEqual(ring.snapshot(), [
    { type: 'text', text: 'fio preservado' },
    { type: 'executor-changed', model: 'opus', effort: null }
  ])
})

test('fila aplica permissao e executor do bilhete antes de enviar, com retry idempotente', async () => {
  const sent = []
  const applied = []
  const spawns = []
  let generation = 0
  const gui = registry()
  gui.spawnSession = (spawn, sink) => {
    spawns.push({ ...spawn })
    generation += 1
    const caps = {
      commands: [],
      models: [
        {
          value: 'opus',
          displayName: 'Opus',
          supportedEffortLevels: ['high']
        }
      ]
    }
    sink({
      type: 'init',
      model: 'opus',
      sessionId: `queued-session-${generation}`,
      permissionMode: spawn.permissionMode ?? 'default',
      toolCount: 0
    })
    sink({ type: 'ready', caps })
    return {
      alive: true,
      turnActive: false,
      caps,
      waitCaps: async () => caps,
      setExecutor: async (options) => {
        applied.push(options)
        return true
      },
      send: (text) => sent.push(text),
      kill: () => undefined
    }
  }
  const spawn = {
    paneId: 'p-queued-delivery',
    projectId: 'proj',
    cli: 'claude',
    configDir: 'c',
    cwd: '/tmp',
    permissionMode: 'default'
  }
  assert.equal(gui.create(spawn).ok, true)
  const input = {
    id: 'queued-once',
    text: 'envie com a fotografia',
    at: Date.now(),
    options: { model: 'opus', effort: 'high', permissionMode: 'plan' },
    attachments: []
  }
  assert.equal(guiQueuedDeliveryProblem(input), null)
  const [firstDelivery, concurrentDelivery] = await Promise.all([
    gui.deliverQueued(spawn.paneId, input),
    gui.deliverQueued(spawn.paneId, input)
  ])
  assert.deepEqual(firstDelivery, { ok: true })
  assert.deepEqual(concurrentDelivery, { ok: true })
  assert.equal(spawns.length, 2)
  assert.equal(spawns[1].permissionMode, 'plan')
  assert.equal(spawns[1].resumeSessionId, 'queued-session-1')
  assert.deepEqual(applied, [{ model: 'opus', effort: 'high' }])
  assert.deepEqual(sent, ['envie com a fotografia'])

  assert.deepEqual(await gui.deliverQueued(spawn.paneId, input), { ok: true })
  assert.equal(spawns.length, 2, 'ACK perdido nao respawna novamente')
  assert.deepEqual(sent, ['envie com a fotografia'], 'o mesmo id nunca executa duas vezes')
})

test('recibo da fila sobrevive ao restart mesmo depois de o evento sair do replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-queued-receipt-'))
  const storeFile = join(root, 'gui-sessions.json')
  const sent = []
  const spawn = {
    paneId: 'p-queued-restart',
    projectId: 'proj',
    cli: 'claude',
    configDir: 'c',
    cwd: '/tmp',
    permissionMode: 'default'
  }
  const caps = { commands: [], models: [] }
  const makeRegistry = () => {
    const gui = new GuiSessionRegistry({
      push: () => undefined,
      systemPromptFile: () => undefined,
      storeFile
    })
    gui.spawnSession = (_spawn, sink) => {
      sink({
        type: 'init',
        model: 'default',
        sessionId: 'queued-restart-session',
        permissionMode: 'default',
        toolCount: 0
      })
      sink({ type: 'ready', caps })
      return {
        alive: true,
        turnActive: false,
        caps,
        waitCaps: async () => caps,
        setExecutor: async () => true,
        send: (text) => sent.push(text),
        kill: () => undefined
      }
    }
    return gui
  }
  const input = {
    id: 'queued-durable-receipt',
    text: 'execute uma vez',
    at: Date.now(),
    options: { model: null, effort: null, permissionMode: 'default' },
    attachments: []
  }

  try {
    const first = makeRegistry()
    assert.equal(first.create(spawn).ok, true)
    assert.deepEqual(await first.deliverQueued(spawn.paneId, input), { ok: true })
    assert.deepEqual(sent, ['execute uma vez'])

    const persisted = JSON.parse(readFileSync(storeFile, 'utf8'))
    persisted.transcripts = {}
    writeFileSync(storeFile, JSON.stringify(persisted), 'utf8')

    const reopened = makeRegistry()
    assert.equal(reopened.create(spawn).ok, true)
    assert.deepEqual(await reopened.deliverQueued(spawn.paneId, input), { ok: true })
    assert.deepEqual(sent, ['execute uma vez'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('envelope da fila falha fechado antes de tocar na sessao', () => {
  assert.match(
    guiQueuedDeliveryProblem({
      id: 'queued-bad',
      text: 'mensagem',
      at: Date.now(),
      options: { model: null, effort: null, permissionMode: 'superuser' },
      attachments: []
    }),
    /permissao|permissão/u
  )
  assert.match(
    guiQueuedDeliveryProblem({
      id: 'queued-empty',
      text: '',
      at: Date.now(),
      options: { model: null, effort: null, permissionMode: 'default' },
      attachments: []
    }),
    /vazia/u
  )
})

test('padrão explícito do executor não volta a herdar a missão ao reabrir', () => {
  const remembered = {
    cli: 'claude',
    projectId: 'proj',
    updatedAt: '2026-08-14T00:00:00.000Z',
    model: null,
    effort: null
  }
  assert.equal(rememberedGuiExecutorValue(remembered, 'claude', 'model', 'opus'), undefined)
  assert.equal(rememberedGuiExecutorValue(remembered, 'claude', 'effort', 'high'), undefined)
  assert.equal(
    rememberedGuiExecutorValue({ ...remembered, model: 'sonnet' }, 'claude', 'model', 'opus'),
    'sonnet'
  )
  assert.equal(
    rememberedGuiExecutorValue(undefined, 'claude', 'model', 'opus'),
    'opus',
    'sem escolha do chat a missão continua sendo o fallback'
  )
})

test('effort continua disponível quando o modelo usa o padrão da conta', async () => {
  const gui = registry()
  const applied = []
  const session = {
    alive: true,
    turnActive: false,
    caps: {
      commands: [],
      models: [
        {
          value: 'default',
          resolvedModel: 'claude-opus-4-8[1m]',
          displayName: 'Default (recommended)',
          supportedEffortLevels: ['low', 'high']
        }
      ]
    },
    setExecutor: async (input) => {
      applied.push(input)
      return true
    }
  }
  const spawn = {
    paneId: 'p-default-effort',
    projectId: 'proj',
    cli: 'claude',
    configDir: 'c',
    cwd: '/tmp'
  }
  gui.panes.set(spawn.paneId, {
    spawn,
    fingerprint: spawnFingerprint(spawn),
    session,
    ring: new GuiEventRing(),
    token: { alive: true },
    sink: () => undefined
  })

  assert.equal((await gui.configureExecutor(spawn.paneId, { effort: 'high' })).ok, true)
  assert.deepEqual(applied, [{ model: undefined, effort: 'high' }])
})

test('/model usa a troca canônica e limpa effort incompatível', async () => {
  const gui = registry()
  const applied = []
  const session = Object.create(MaestroSession.prototype)
  session.killed = false
  session.closed = false
  session.child = { exitCode: null, signalCode: null }
  session.activeTurnGeneration = null
  session.pendingTurnGenerations = []
  session.caps = {
    commands: [],
    models: [
      { value: 'opus', displayName: 'Opus', supportedEffortLevels: ['high'] },
      { value: 'haiku', displayName: 'Haiku', supportedEffortLevels: ['low'] }
    ]
  }
  session.setExecutor = async (input) => {
    applied.push(input)
    return true
  }
  const spawn = {
    paneId: 'p-slash-model',
    projectId: 'proj',
    cli: 'claude',
    configDir: 'c',
    cwd: '/tmp',
    model: 'opus',
    effort: 'high'
  }
  const ring = new GuiEventRing()
  gui.panes.set(spawn.paneId, {
    spawn,
    fingerprint: spawnFingerprint(spawn),
    session,
    ring,
    token: { alive: true },
    sink: (event) => ring.push(event)
  })

  assert.equal(gui.send(spawn.paneId, '/model haiku', 'g-slash-model').ok, true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(applied, [{ model: 'haiku', effort: undefined }])
  assert.equal(spawn.model, 'haiku')
  assert.equal(spawn.effort, undefined)
  assert.ok(
    ring.snapshot().some(
      (event) =>
        event.type === 'executor-changed' && event.model === 'haiku' && event.effort === null
    )
  )
})

test('troca recusada ou durante turno falha fechada e conserva a escolha', async () => {
  const gui = registry()
  let calls = 0
  const session = {
    alive: true,
    turnActive: false,
    caps: {
      commands: [],
      models: [
        {
          value: 'opus',
          displayName: 'Opus',
          supportedEffortLevels: ['low', 'high']
        }
      ]
    },
    setExecutor: async () => {
      calls += 1
      return false
    }
  }
  const spawn = {
    paneId: 'p-executor-closed',
    projectId: 'proj',
    cli: 'claude',
    configDir: 'c',
    cwd: '/tmp',
    model: 'opus',
    effort: 'high'
  }
  gui.panes.set(spawn.paneId, {
    spawn,
    fingerprint: spawnFingerprint(spawn),
    session,
    ring: new GuiEventRing(),
    token: { alive: true },
    sink: () => undefined
  })

  assert.equal((await gui.configureExecutor(spawn.paneId, { effort: 'low' })).ok, false)
  assert.equal(spawn.effort, 'high')
  assert.equal(calls, 1)

  session.turnActive = true
  assert.match(
    (await gui.configureExecutor(spawn.paneId, { effort: 'low' })).error,
    /resposta atual terminar/u
  )
  session.turnActive = false
  assert.equal(calls, 1, 'turno ativo é recusado antes de tocar no backend')

  assert.match(
    (await gui.configureExecutor(spawn.paneId, { effort: 'max' })).error,
    /não está disponível/u
  )
  assert.equal(calls, 1, 'valor fora das caps também não toca no backend')
})

test('Claude aplica modelo e effort num único control_request confirmado', async () => {
  const session = Object.create(MaestroSession.prototype)
  session.opts = { cwd: '/tmp', model: 'opus', effort: 'high' }
  session.killed = false
  session.closed = false
  session.child = { exitCode: null, signalCode: null }
  session.activeTurnGeneration = null
  session.pendingTurnGenerations = []
  session.controlWaiters = new Map()
  let request
  session.write = (message) => {
    request = message
    queueMicrotask(() => session.controlWaiters.get(message.request_id)?.(true))
  }

  assert.equal(await session.setExecutor({ model: 'opus', effort: 'low' }), true)
  assert.deepEqual(request.request, {
    subtype: 'apply_flag_settings',
    settings: { model: 'opus', effortLevel: 'low' }
  })
  assert.equal(session.opts.effort, 'low')
})

test('timeout da troca Claude encerra o estado ambíguo antes do próximo turno', async () => {
  const session = Object.create(MaestroSession.prototype)
  session.opts = { cwd: '/tmp', model: 'opus', effort: 'high' }
  session.killed = false
  session.closed = false
  session.child = { exitCode: null, signalCode: null }
  session.activeTurnGeneration = null
  session.pendingTurnGenerations = []
  session.controlWaiters = new Map()
  session.write = () => undefined
  const events = []
  session.emit = (event) => events.push(event)
  let killed = false
  session.kill = () => {
    killed = true
    session.killed = true
  }

  let timeout
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (callback) => {
    timeout = callback
    return 1
  }
  try {
    const pending = session.setExecutor({ model: 'sonnet', effort: 'low' })
    assert.equal(typeof timeout, 'function')
    timeout()
    assert.equal(await pending, false)
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }

  assert.equal(killed, true)
  assert.equal(session.controlWaiters.size, 0, 'ACK tardio não encontra mais waiter')
  assert.equal(session.opts.model, 'opus', 'UI/opções antigas não são carimbadas como sucesso')
  assert.match(events.at(-1).text, /estado incerto/u)
})

test('/model não contorna o bloqueio enquanto uma resposta está em curso', async () => {
  const claude = Object.create(MaestroSession.prototype)
  claude.opts = { cwd: '/tmp', model: 'opus' }
  claude.killed = false
  claude.closed = false
  claude.child = { exitCode: null, signalCode: null }
  claude.activeTurnGeneration = 1
  claude.pendingTurnGenerations = []
  let writes = 0
  claude.write = () => {
    writes += 1
  }
  assert.equal(await claude.setModel('sonnet'), false)
  assert.equal(writes, 0)
  assert.equal(claude.opts.model, 'opus')

  const codex = Object.create(CodexSession.prototype)
  codex.opts = { cwd: '/tmp', model: 'gpt-5.6' }
  codex.killed = false
  codex.closed = false
  codex.child = { exitCode: null, signalCode: null }
  codex.turnId = 'turn-running'
  codex.pendingTurnStart = null
  codex.pendingSendOperations = new Set()
  assert.equal(await codex.setModel('gpt-5.6-mini'), false)
  assert.equal(codex.opts.model, 'gpt-5.6')
})

test('spawn inválido é recusado antes de qualquer processo nascer', () => {
  const gui = registry()
  const base = { paneId: 'p1', projectId: 'proj', cli: 'claude', configDir: 'c', cwd: '/tmp' }

  assert.deepEqual(gui.create({ ...base, paneId: '' }), {
    ok: false,
    error: 'pane sem identificador'
  })
  assert.deepEqual(gui.create({ ...base, cwd: '' }), {
    ok: false,
    error: 'pane sem pasta de trabalho'
  })
  assert.equal(gui.create({ ...base, cli: 'gemini' }).ok, false)
  assert.equal(gui.has('p1'), false, 'recusa não deixa entrada pendurada no Map')
})

test('mensagens e prompts grandes falham antes do processo e do IPC', () => {
  const atLimit = 'a'.repeat(GUI_PROMPT_MAX_CHARS)
  assert.equal(guiPromptProblem(atLimit), null)
  assert.match(guiPromptProblem(`${atLimit}a`), /grande demais/u)
  assert.match(guiPromptProblem(''), /vazia/u)
  assert.match(guiPromptProblem(false), /formato inválido/u)
  assert.equal(guiMessageIdProblem('g-1'), null)
  assert.match(guiMessageIdProblem('../quebrado'), /identificador/u)

  const gui = registry()
  const base = { paneId: 'p-limite', projectId: 'proj', cli: 'claude', configDir: 'c', cwd: '/tmp' }
  assert.match(gui.create({ ...base, firstPrompt: `${atLimit}a` }).error, /grande demais/u)
  assert.equal(gui.has('p-limite'), false)
})

test('encerramento do chat mata a árvore inteira no Windows', () => {
  assert.deepEqual(guiTreeKillCommand('win32', 4321), {
    file: 'taskkill.exe',
    args: ['/pid', '4321', '/t', '/f']
  })
  assert.equal(guiTreeKillCommand('linux', 4321), null)
  assert.equal(guiTreeKillCommand('win32', undefined), null)
  assert.equal(guiChildNeedsTermination(null, null), true)
  assert.equal(guiChildNeedsTermination(0, null), false)
  assert.equal(guiChildNeedsTermination(null, 'SIGTERM'), false)
})

test('processo encerrado por sinal nunca continua vivo no registro', () => {
  for (const Session of [MaestroSession, CodexSession]) {
    const session = Object.create(Session.prototype)
    session.killed = false
    session.closed = false
    session.child = { exitCode: null, signalCode: 'SIGTERM' }
    assert.equal(session.alive, false)
    session.child.signalCode = null
    assert.equal(session.alive, true)
    session.closed = true
    assert.equal(session.alive, false)
  }
})

test('initialize recusado pelo Claude falha fechado e libera os waiters', () => {
  const session = Object.create(MaestroSession.prototype)
  const events = []
  let waited = 'pendente'
  let killed = 0
  session.initReqId = 'init-1'
  session.interruptRequestId = null
  session.initTimer = null
  session.caps = null
  session.capsWaiters = [(caps) => (waited = caps)]
  session.emit = (event) => events.push(event)
  session.kill = () => {
    killed += 1
  }

  session.handleLine(
    JSON.stringify({
      type: 'control_response',
      response: { request_id: 'init-1', subtype: 'error', error: 'recusado' }
    })
  )
  assert.equal(killed, 1)
  assert.equal(waited, null)
  assert.equal(events[0].type, 'fatal')
  assert.match(events[0].text, /handshake do Claude falhou/u)
})

test('Claude propaga parent_tool_use_id e replay preserva dois pais intercalados', () => {
  const session = Object.create(MaestroSession.prototype)
  const events = []
  session.emit = (event) => events.push(event)
  const assistant = (toolUseId, name, input, parentToolUseId = null) =>
    session.handleLine(
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: parentToolUseId,
        message: { content: [{ type: 'tool_use', id: toolUseId, name, input }] }
      })
    )
  const result = (toolUseId, text, isError = false) =>
    session.handleLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }]
        }
      })
    )

  assistant('parent-a', 'Agent', { prompt: 'A' })
  assistant('parent-b', 'Agent', { prompt: 'B' })
  assistant('child-a', 'Grep', { pattern: 'alpha' }, 'parent-a')
  assistant('child-b', 'Read', { file_path: 'beta.ts' }, 'parent-b')
  result('child-b', 'B pronto')
  result('child-a', 'A pronto')
  result('parent-b', 'B falhou', true)
  result('parent-a', 'A pronto')

  assert.deepEqual(
    events.filter((event) => event.type === 'tool'),
    [
      { type: 'tool', name: 'Agent', input: { prompt: 'A' }, toolUseId: 'parent-a' },
      { type: 'tool', name: 'Agent', input: { prompt: 'B' }, toolUseId: 'parent-b' },
      {
        type: 'tool',
        name: 'Grep',
        input: { pattern: 'alpha' },
        toolUseId: 'child-a',
        parentToolUseId: 'parent-a'
      },
      {
        type: 'tool',
        name: 'Read',
        input: { file_path: 'beta.ts' },
        toolUseId: 'child-b',
        parentToolUseId: 'parent-b'
      }
    ]
  )
  assert.deepEqual(
    events.filter((event) => event.type === 'tool-result').map((event) => event.toolUseId),
    ['child-b', 'child-a', 'parent-b', 'parent-a']
  )

  const ring = new GuiEventRing()
  for (const event of events) ring.push(event)
  const replay = ring.sequencedSnapshot()
  assert.equal(replay.length, events.length)
  assert.equal(replay[2].evt.parentToolUseId, 'parent-a')
  assert.equal(replay[3].evt.parentToolUseId, 'parent-b')
  assert.equal(isGuiPersistedEvent(replay[2].evt), true)
  assert.equal(
    isGuiPersistedEvent({ ...replay[2].evt, parentToolUseId: 42 }),
    false,
    'linhagem forjada não entra na hidratação'
  )
  assert.equal(
    isGuiPersistedEvent({ ...replay[2].evt, parentToolUseId: 'x'.repeat(257) }),
    false,
    'id de pai não contorna o teto do protocolo'
  )

  session.handleLine(
    JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: { forged: true },
      message: {
        content: [{ type: 'tool_use', id: 'generic', name: 'Read', input: {} }]
      }
    })
  )
  assert.deepEqual(events.at(-1), {
    type: 'tool',
    name: 'Read',
    input: {},
    toolUseId: 'generic'
  })
})

test('Claude mantém texto e terminal de subagente fora da resposta principal', () => {
  const session = Object.create(MaestroSession.prototype)
  const events = []
  session.emit = (event) => events.push(event)

  session.handleLine(JSON.stringify({
    type: 'stream_event',
    parent_tool_use_id: 'agent-parent',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'parcial do filho' } }
  }))
  session.handleLine(JSON.stringify({
    type: 'assistant',
    parent_tool_use_id: 'agent-parent',
    message: {
      content: [
        { type: 'text', text: 'resposta do filho' },
        { type: 'tool_use', id: 'child-tool', name: 'WebSearch', input: { query: 'teste' } }
      ]
    }
  }))
  session.handleLine(JSON.stringify({
    type: 'result',
    parent_tool_use_id: 'agent-parent',
    is_error: false,
    result: 'fim do filho'
  }))

  assert.deepEqual(events, [{
    type: 'tool',
    name: 'WebSearch',
    input: { query: 'teste' },
    toolUseId: 'child-tool',
    parentToolUseId: 'agent-parent'
  }])
})

// ————— ciclo de vida de subagente em background (Claude) —————
// Formas capturadas ao vivo no CLI 2.1.233: a tool Agent roda em SEGUNDO PLANO
// por padrão, então o tool_result do despacho é só um recibo
// (`status: "async_launched"`) e o terminal factual chega muito depois, no
// `system/task_notification` — inclusive DEPOIS de um `result` raiz.

function claudeAgentSession() {
  const session = Object.create(MaestroSession.prototype)
  const events = []
  session.emit = (event) => events.push(event)
  session.claudeTasks = new GuiClaudeTaskRegistry()
  session.pending = new Map()
  session.pendingTurnGenerations = []
  session.activeTurnGeneration = null
  session.interruptGeneration = null
  session.interruptRequestId = null
  session.interruptTimer = null
  return {
    session,
    events,
    line: (envelope) => session.handleLine(JSON.stringify(envelope))
  }
}

/** ACK do Agent como o CLI entrega: o `AgentOutput` mora no `tool_use_result`
 *  (união discriminada por `status`, tratada como enum ABERTO). */
function agentOutput(toolUseId, result, { isError = false, text = 'Agent launched' } = {}) {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [{ type: 'text', text }],
          ...(isError ? { is_error: true } : {})
        }
      ]
    },
    ...(result ? { tool_use_result: result } : {})
  }
}

const asyncLaunch = (agentId) => ({
  isAsync: true,
  status: 'async_launched',
  agentId,
  description: 'investigar',
  outputFile: '/tmp/agent.md'
})

test('despacho de subagente é recibo, não conclusão: o card nasce sem desfecho', () => {
  const { session, events, line } = claudeAgentSession()

  line({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-1',
    tool_use_id: 'tool-1',
    subagent_type: 'general-purpose',
    task_type: 'background',
    description: 'investigar'
  })
  assert.deepEqual(events, [], 'task_started é só registro: nada aparece na conversa')

  line(agentOutput('tool-1', asyncLaunch('task-1')))

  assert.deepEqual(events, [
    {
      type: 'tool-result',
      text: 'Agent launched',
      isError: false,
      toolUseId: 'tool-1',
      lineCount: 1,
      truncated: false,
      agentStatus: 'launched',
      agentTaskId: 'task-1'
    }
  ])
  assert.equal(
    Object.hasOwn(events[0], 'outcome'),
    false,
    'desfecho é o que a apresentação lê como terminal — o agente acabou de começar'
  )
  assert.equal(session.claudeTasks.size, 1)
  assert.deepEqual(session.claudeTasks.liveToolUseIds(), ['tool-1'])
})

test('task_notification é o terminal factual e traz o resumo para o card', () => {
  const { session, events, line } = claudeAgentSession()
  line({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'tool-1' })
  line(agentOutput('tool-1', asyncLaunch('task-1')))
  events.length = 0

  line({
    type: 'system',
    subtype: 'task_updated',
    task_id: 'task-1',
    patch: { status: 'completed', end_time: 1 }
  })
  assert.deepEqual(events, [], 'andamento nunca fecha o card')

  line({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-1',
    tool_use_id: 'tool-1',
    status: 'completed',
    summary: 'achei a causa raiz',
    output_file: '/tmp/agent.md',
    usage: { total_tokens: 1 }
  })

  assert.deepEqual(events, [
    {
      type: 'tool-result',
      text: 'achei a causa raiz',
      isError: false,
      outcome: 'completed',
      toolUseId: 'tool-1',
      lineCount: 1,
      truncated: false,
      agentStatus: 'settled',
      agentTaskId: 'task-1'
    }
  ])
  assert.equal(session.claudeTasks.size, 0)

  events.length = 0
  line({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-1',
    tool_use_id: 'tool-1',
    status: 'completed',
    summary: 'achei a causa raiz'
  })
  assert.equal(session.claudeTasks.size, 0, 'segundo terminal do mesmo agente não ressuscita nada')
})

test('status de tarefa é enum ABERTO: valor desconhecido encerra em vez de pendurar', () => {
  const { session, events, line } = claudeAgentSession()
  line({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'tool-1' })
  line({ type: 'system', subtype: 'task_started', task_id: 'task-2', tool_use_id: 'tool-2' })
  line(agentOutput('tool-1', asyncLaunch('task-1')))
  line(agentOutput('tool-2', asyncLaunch('task-2')))
  events.length = 0

  line({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-1',
    tool_use_id: 'tool-1',
    status: 'status_que_ainda_nao_existe'
  })
  assert.deepEqual(events.at(-1), {
    type: 'tool-result',
    text: 'subagente falhou',
    isError: true,
    outcome: 'failed',
    toolUseId: 'tool-1',
    lineCount: 1,
    truncated: false,
    agentStatus: 'settled',
    agentTaskId: 'task-1'
  })
  assert.equal(session.claudeTasks.size, 1)

  // Terminal de um agente que o registro nunca viu (task_started perdido)
  // continua fechando o card: pendente eterno é pior que classificação torta.
  events.length = 0
  line({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-3',
    tool_use_id: 'tool-3',
    status: 'completed'
  })
  assert.equal(events.at(-1).toolUseId, 'tool-3')
  assert.equal(events.at(-1).agentStatus, 'settled')

  // Recibo que já nasce em erro nunca deixa um agente imortal.
  events.length = 0
  line(agentOutput('tool-2', asyncLaunch('task-2'), { isError: true, text: 'não consegui abrir' }))
  assert.deepEqual(events.at(-1), {
    type: 'tool-result',
    text: 'não consegui abrir',
    isError: true,
    outcome: 'failed',
    toolUseId: 'tool-2',
    lineCount: 1,
    truncated: false,
    agentStatus: 'settled',
    agentTaskId: 'task-2'
  })
  assert.equal(session.claudeTasks.size, 0)
})

test('fotografia de tarefas reconcilia sem atropelar a notificação e trata `tasks` omitido', async () => {
  const { session, events, line } = claudeAgentSession()
  for (const n of [1, 2]) {
    line({ type: 'system', subtype: 'task_started', task_id: `task-${n}`, tool_use_id: `tool-${n}` })
    line(agentOutput(`tool-${n}`, asyncLaunch(`task-${n}`)))
  }
  events.length = 0

  // Triplo atômico real: a fotografia perde a tarefa ~1ms ANTES do terminal
  // dela. O resumo verdadeiro tem de vencer a reconciliação.
  line({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'task-2', task_type: 'background', description: 'investigar' }]
  })
  line({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-1',
    tool_use_id: 'tool-1',
    status: 'completed',
    summary: 'relatório pronto'
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(events, [
    {
      type: 'tool-result',
      text: 'relatório pronto',
      isError: false,
      outcome: 'completed',
      toolUseId: 'tool-1',
      lineCount: 1,
      truncated: false,
      agentStatus: 'settled',
      agentTaskId: 'task-1'
    }
  ])
  assert.equal(session.claudeTasks.size, 1)

  // TRAP do protocolo: com o conjunto vazio a chave `tasks` some do envelope.
  // Ausência é conjunto VAZIO — senão o último agente ficaria imortal.
  events.length = 0
  line({ type: 'system', subtype: 'background_tasks_changed', session_id: 's1' })
  assert.deepEqual(events, [], 'a reconciliação espera o chunk inteiro atravessar o parser')
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(events, [
    {
      type: 'tool-result',
      text: 'encerrado (reconciliado sem notificação)',
      isError: false,
      outcome: 'completed',
      toolUseId: 'tool-2',
      lineCount: 1,
      truncated: false,
      agentStatus: 'settled',
      agentTaskId: 'task-2'
    }
  ])
  assert.equal(session.claudeTasks.size, 0)
})

test('result raiz continua enquanto houver subagente vivo', () => {
  const { session, events, line } = claudeAgentSession()
  line({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'tool-1' })
  line(agentOutput('tool-1', asyncLaunch('task-1')))
  events.length = 0

  // O `result` raiz não diz UMA palavra sobre background: sem o registro, este
  // terminal viraria o desfecho visual (e o plim) com o agente trabalhando.
  line({ type: 'result', is_error: false, result: 'disparei os agentes' })
  assert.equal(events.at(-1).type, 'result')
  assert.equal(events.at(-1).continues, true)
  assert.equal(events.at(-1).outcome, 'completed')

  line({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-1',
    tool_use_id: 'tool-1',
    status: 'completed',
    summary: 'ok'
  })
  line({ type: 'result', is_error: false, result: 'síntese final' })
  assert.equal(events.at(-1).continues, false, 'sem agente vivo o último ciclo fecha o turno')

  // A fila de mensagens do usuário continua mandando sozinha no `continues`.
  session.pendingTurnGenerations = [7, 8]
  session.activeTurnGeneration = 7
  line({ type: 'result', is_error: false })
  assert.equal(events.at(-1).continues, true)
})

test('envelope de tarefa fora do contrato é no-op silencioso e texto raiz segue raiz', () => {
  const { session, events, line } = claudeAgentSession()
  let killed = 0
  session.kill = () => {
    killed += 1
  }

  // `task_notification` CRU (fora de `system`) não existe no contrato: passa
  // pelo guard de envelope e não pode virar fatal nem texto.
  line({ type: 'task_notification', task_id: 'task-1', status: 'completed' })
  line({ type: 'system', subtype: 'task_progress', task_id: 'task-1' })
  line({ type: 'system', subtype: 'assunto_que_ainda_nao_existe', task_id: 'task-1' })
  assert.deepEqual(events, [])
  assert.equal(killed, 0)
  assert.equal(session.claudeTasks.size, 0, 'andamento nunca inventa tarefa que não foi despachada')

  // Ciclo autônomo: a cada conclusão o CLI abre um turno raiz novo (init com o
  // MESMO session_id) e responde de verdade. Esse texto é RAIZ legítima e
  // continua no fio — o que se corrigiu foi ciclo de vida, não a fala.
  line({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude' })
  line({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'a busca terminou' }] }
  })
  assert.deepEqual(events.at(-1), { type: 'text', text: 'a busca terminou' })
  assert.equal(events.at(-2).type, 'init')
})

test('interrupção e encerramento cancelam os agentes antes do terminal', () => {
  const { session, events, line } = claudeAgentSession()
  session.activeTurnGeneration = 3
  session.pendingTurnGenerations = [3]
  session.interruptGeneration = 3
  session.interruptRequestId = 'req-int'
  for (const n of [1, 2]) {
    line({ type: 'system', subtype: 'task_started', task_id: `task-${n}`, tool_use_id: `tool-${n}` })
    line(agentOutput(`tool-${n}`, asyncLaunch(`task-${n}`)))
  }
  events.length = 0

  line({ type: 'control_response', response: { subtype: 'success', request_id: 'req-int' } })
  assert.deepEqual(
    events.map((event) => [event.type, event.toolUseId, event.outcome, event.agentStatus]),
    [
      ['tool-result', 'tool-1', 'cancelled', 'settled'],
      ['tool-result', 'tool-2', 'cancelled', 'settled']
    ]
  )
  assert.equal(events[0].isError, false, 'parada pedida pelo dono não é falha')
  assert.equal(session.claudeTasks.size, 0)

  events.length = 0
  line({ type: 'result', is_error: false })
  assert.equal(events.at(-1).type, 'result')
  assert.equal(events.at(-1).outcome, 'cancelled')
  assert.equal(events.at(-1).continues, false)

  // Encerrar a sessão leva junto o que estava rodando: o card nunca fica
  // preso em "trabalhando" depois da conversa fechar.
  line({ type: 'system', subtype: 'task_started', task_id: 'task-9', tool_use_id: 'tool-9' })
  line(agentOutput('tool-9', asyncLaunch('task-9')))
  events.length = 0
  session.killed = false
  session.initTimer = null
  session.idleTimer = null
  session.turnSilenceTimer = null
  session.capsWaiters = []
  session.controlWaiters = new Map()
  session.child = { exitCode: 0, signalCode: null }
  session.kill()
  assert.deepEqual(events, [
    {
      type: 'tool-result',
      text: 'subagente cancelado',
      isError: false,
      outcome: 'cancelled',
      toolUseId: 'tool-9',
      lineCount: 1,
      truncated: false,
      agentStatus: 'settled',
      agentTaskId: 'task-9'
    }
  ])
  assert.equal(session.claudeTasks.size, 0)
})

test('ciclo de vida de subagente atravessa a hidratação sem afrouxar o contrato', () => {
  const launched = {
    type: 'tool-result',
    text: 'Agent launched',
    isError: false,
    toolUseId: 'tool-1',
    lineCount: 1,
    truncated: false,
    agentStatus: 'launched',
    agentTaskId: 'task-1'
  }
  const settled = { ...launched, outcome: 'completed', agentStatus: 'settled' }

  assert.equal(isGuiPersistedEvent(launched), true)
  assert.equal(isGuiPersistedEvent(settled), true)
  assert.equal(
    isGuiPersistedEvent({ type: 'tool-result', text: 'saída', isError: false }),
    true,
    'tool-result sem os campos novos hidrata exatamente como antes'
  )
  assert.equal(
    isGuiPersistedEvent({ ...launched, agentStatus: 'running' }),
    false,
    'estado fora do contrato nunca entra pela porta do disco'
  )
  assert.equal(isGuiPersistedEvent({ ...launched, agentTaskId: 42 }), false)
  assert.equal(isGuiPersistedEvent({ ...launched, agentTaskId: '' }), false)
  assert.equal(isGuiPersistedEvent({ ...launched, agentTaskId: 'x'.repeat(257) }), false)
})

/** Sessão Codex montada sobre o prototype: os testes exercitam o INGEST puro
 *  (`handleNotification`), sem processo, sem RPC e sem timers. `child.exitCode`
 *  já encerrado deixa `kill()` seguro (nenhum taskkill de verdade). */
function codexAgentSession({ threadId = 'thread-root', turnId = 'turn-root' } = {}) {
  const session = Object.create(CodexSession.prototype)
  const events = []
  session.emit = (event) => events.push(event)
  session.killed = false
  session.closed = false
  session.child = { exitCode: 0, signalCode: null }
  session.threadId = threadId
  session.turnId = turnId
  session.pendingTurnStart = null
  session.pendingSendOperations = new Set()
  session.terminalReconcilePending = false
  session.activeCollabParentIds = new Set()
  session.collabParentByThreadId = new Map()
  session.startedCollabToolIds = new Set()
  session.deferredCollabResult = null
  session.codexAgents = new GuiCodexAgentRegistry()
  session.approvals = new Map()
  session.pending = new Map()
  session.idleTimer = null
  session.turnSilenceTimer = null
  session.turnStartTimer = null
  session.interruptTimer = null
  session.interruptedTurnId = null
  session.turnErrorTimer = null
  return {
    session,
    events,
    note: (method, params) => session.handleNotification(method, params)
  }
}

test('Claude e Codex nunca compartilham inferência de ciclo de vida', async () => {
  const { session, events, line } = claudeAgentSession()
  line({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'tool-1' })
  line(agentOutput('tool-1', asyncLaunch('task-1')))
  events.length = 0

  // Ferramenta comum (e Agent SÍNCRONO, sem o recibo assíncrono) segue com o
  // tool-result de sempre: nenhum campo novo, terminal na hora.
  line(
    agentOutput('tool-comum', { stdout: 'ok' }, { text: 'ignorado quando há stdout' })
  )
  line(agentOutput('tool-sync', { status: 'completed', agentId: 'task-sync' }, { text: 'pronto' }))
  assert.deepEqual(events, [
    {
      type: 'tool-result',
      text: 'ok',
      isError: false,
      outcome: 'completed',
      toolUseId: 'tool-comum',
      lineCount: 1,
      truncated: false
    },
    {
      type: 'tool-result',
      text: 'pronto',
      isError: false,
      outcome: 'completed',
      toolUseId: 'tool-sync',
      lineCount: 1,
      truncated: false
    }
  ])
  assert.equal(session.claudeTasks.size, 1, 'nada disso mexeu no agente vivo')

  // O Codex tem ciclo de vida PRÓPRIO (o pai só ganha result no fim factual):
  // os eventos dele nunca carregam os campos do registro Claude. A cerca vale
  // para os DOIS caminhos: o legado `collabAgentToolCall` e o wire real
  // (`subAgentActivity` + `turn/completed` do thread filho).
  const { session: codex, events: codexEvents, note } = codexAgentSession()

  const spawnItem = {
    type: 'collabAgentToolCall',
    id: 'spawn-1',
    tool: 'spawn_agent',
    status: 'completed',
    newThreadId: 'thread-legacy',
    prompt: 'pesquise',
    agentStatus: { status: 'running' }
  }
  note('item/started', { threadId: 'thread-root', item: spawnItem })
  note('item/completed', { threadId: 'thread-root', item: spawnItem })
  const waitItem = {
    type: 'collabAgentToolCall',
    id: 'wait-1',
    tool: 'wait',
    status: 'completed',
    receiverThreadId: 'thread-legacy',
    agentStatus: { status: 'completed', message: 'pesquisa concluída' }
  }
  note('item/started', { threadId: 'thread-root', item: waitItem })
  note('item/completed', { threadId: 'thread-root', item: waitItem })

  const activity = {
    type: 'subAgentActivity',
    id: 'activity-1',
    kind: 'started',
    agentThreadId: 'thread-child',
    agentPath: '/root/pesquisa'
  }
  note('item/started', { threadId: 'thread-root', item: activity })
  note('turn/completed', {
    threadId: 'thread-child',
    turn: { id: 'turn-child', status: 'completed', items: [] }
  })
  await new Promise((resolve) => setImmediate(resolve))

  const codexResults = codexEvents.filter((event) => event.type === 'tool-result')
  assert.ok(codexResults.length >= 2)
  for (const event of codexResults) {
    assert.equal(Object.hasOwn(event, 'agentStatus'), false)
    assert.equal(Object.hasOwn(event, 'agentTaskId'), false)
    assert.equal(event.outcome, 'completed', 'o pai Codex fecha pelo fim factual dele')
  }
  assert.equal(codex.claudeTasks, undefined, 'o registro do Claude não existe no Codex')
  assert.equal(session.codexAgents, undefined, 'e o registro do Codex não existe no Claude')
})

test('registro publica terminal depois dos tool-results do mesmo chunk e mantém órfão honesto', async () => {
  const gui = registry()
  let emit
  const spawn = {
    paneId: 'p-tool-terminal-order',
    projectId: 'proj',
    cli: 'claude',
    configDir: 'c',
    cwd: '/tmp'
  }
  gui.spawnSession = (_input, sink) => {
    emit = sink
    return {
      alive: true,
      turnActive: false,
      waitCaps: async () => ({ commands: [], models: [] }),
      send: () => undefined,
      kill: () => undefined
    }
  }
  assert.equal(gui.create(spawn).ok, true)

  // Simula exatamente o lote que gerava o falso erro: o `result` chega antes
  // dos dois tool-results, incluindo a ferramenta filha de um subagente.
  emit({ type: 'tool', name: 'Agent', input: {}, toolUseId: 'parent' })
  emit({
    type: 'tool',
    name: 'WebSearch',
    input: { query: 'teste' },
    toolUseId: 'child',
    parentToolUseId: 'parent'
  })
  emit({ type: 'result', isError: false, outcome: 'completed' })
  emit({
    type: 'tool-result',
    text: 'resultado filho',
    isError: false,
    outcome: 'completed',
    toolUseId: 'child'
  })
  emit({
    type: 'tool-result',
    text: 'resultado pai',
    isError: false,
    outcome: 'completed',
    toolUseId: 'parent'
  })
  await new Promise((resolve) => setImmediate(resolve))

  const events = gui.state(spawn.paneId).events.map(({ evt }) => evt)
  const tail = events.slice(-5)
  assert.deepEqual(
    tail.map((event) => event.type),
    ['tool', 'tool', 'tool-result', 'tool-result', 'result'],
    'o ring conserva os resultados correlacionados antes do terminal'
  )
  assert.equal(tail[3].toolUseId, 'parent')
  assert.equal(tail[4].type, 'result')

  // Sem tool-result, o terminal continua sendo um órfão real: o fechamento
  // visual mantém falha, em vez de suprimir o diagnóstico.
  const orphan = closePendingGuiTools(
    [{ id: 'orphan', kind: 'tool', name: 'WebSearch', summary: 'sem retorno', toolUseId: 'orphan' }],
    { type: 'result', isError: false, outcome: 'completed' }
  )
  assert.equal(orphan[0].result.isError, true)
  assert.equal(orphan[0].result.status, 'failed')
})

test('firstPrompt nunca sai quando o handshake não produziu capacidades', async () => {
  const gui = registry()
  const ring = new GuiEventRing()
  let sent = 0
  const session = {
    alive: true,
    waitCaps: async () => null,
    send: () => {
      sent += 1
    }
  }
  gui.panes.set('p-first', {
    spawn: { paneId: 'p-first', projectId: 'proj', cli: 'claude', configDir: 'c', cwd: '/tmp' },
    fingerprint: 'teste',
    session,
    ring,
    token: { alive: true },
    sink: (event) => ring.push(event)
  })
  gui.sendFirstPrompt('p-first', { alive: true }, 'não enviar')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(sent, 0)
  assert.equal(ring.size, 0)
})

test('interrupt repetido do Codex é idempotente no mesmo turno', () => {
  const session = Object.create(CodexSession.prototype)
  session.threadId = 'thread-1'
  session.turnId = 'turn-1'
  session.interruptedTurnId = null
  session.interruptTimer = null
  let requests = 0
  session.request = async () => {
    requests += 1
    return {}
  }
  assert.equal(session.interrupt(), true)
  assert.equal(session.interrupt(), true)
  assert.equal(requests, 1)
  session.clearInterruptGuard()
})

test('Codex repassa somente o contexto vivo, nunca o acumulado da sessão', () => {
  const session = Object.create(CodexSession.prototype)
  const events = []
  session.emit = (event) => events.push(event)

  // Quatro mensagens curtas já podem ter processado centenas de milhares de
  // tokens cumulativos. A tela só pode usar `last`, a fotografia vigente.
  session.handleNotification('thread/tokenUsage/updated', {
    tokenUsage: {
      total: { totalTokens: 356_000 },
      last: { totalTokens: 1_312 },
      modelContextWindow: 258_400
    }
  })
  assert.deepEqual(events, [
    { type: 'context-usage', contextTokens: 1_312, contextWindow: 258_400 }
  ])
  assert.equal(Math.min(100, Math.round((356_000 / 258_400) * 100)), 100)
  assert.equal(Math.round((events[0].contextTokens / events[0].contextWindow) * 100), 1)

  // Sem `last`/janela, não há uma régua honesta: não reutiliza a medida velha
  // nem cai no `total` só porque ele continua disponível.
  events.length = 0
  session.handleNotification('thread/tokenUsage/updated', {
    tokenUsage: { total: { totalTokens: 400_000 } }
  })
  assert.deepEqual(events, [{ type: 'context-usage', contextTokens: null, contextWindow: null }])
  assert.equal(session.lastTokens, undefined)
  assert.equal(session.lastWindow, undefined)

  // Compactar também invalida a fotografia até o protocolo publicar uma nova.
  session.lastTokens = 20_000
  session.lastWindow = 258_400
  events.length = 0
  session.handleNotification('thread/compacted', {})
  assert.deepEqual(events, [
    { type: 'context-usage', contextTokens: null, contextWindow: null },
    { type: 'command-output', text: 'contexto da thread compactado' }
  ])
})

test('Codex projeta collabAgentToolCall na lateral e só encerra após o último subagente', async () => {
  const { session, events } = codexAgentSession()

  const spawn = {
    type: 'collabAgentToolCall',
    id: 'spawn-1',
    tool: 'spawn_agent',
    status: 'completed',
    newThreadId: 'thread-child',
    prompt: 'pesquise a causa',
    model: 'gpt-5.6-luna',
    agentStatus: { status: 'running' }
  }
  session.handleNotification('item/started', { threadId: 'thread-root', item: spawn })
  session.handleNotification('item/completed', { threadId: 'thread-root', item: spawn })

  session.handleNotification('item/agentMessage/delta', {
    threadId: 'thread-child',
    delta: 'texto interno que não pertence ao chat principal'
  })
  session.handleNotification('turn/completed', {
    threadId: 'thread-root',
    turn: { status: 'completed' }
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(events, [{
    type: 'tool',
    name: 'spawn_agent',
    input: {
      name: 'subagente Codex',
      agent_type: 'codex',
      model: 'gpt-5.6-luna',
      prompt: 'pesquise a causa'
    },
    toolUseId: 'spawn-1'
  }])
  assert.equal(session.turnActive, true)
  assert.equal(session.deferredCollabResult?.type, 'result')

  const wait = {
    type: 'collabAgentToolCall',
    id: 'wait-1',
    tool: 'wait',
    status: 'completed',
    receiverThreadId: 'thread-child',
    agentStatus: { status: 'completed', message: 'pesquisa concluída' }
  }
  session.handleNotification('item/started', { threadId: 'thread-root', item: wait })
  session.handleNotification('item/completed', { threadId: 'thread-root', item: wait })

  assert.deepEqual(events.map((event) => event.type), [
    'tool',
    'tool',
    'tool-result',
    'tool-result',
    'result'
  ])
  assert.equal(events.at(-2).toolUseId, 'spawn-1')
  assert.equal(events.at(-2).outcome, 'completed')
  assert.equal(events.at(-1).continues, false)
  assert.equal(session.turnActive, false)
})

// ————— sub-agentes do Codex: o wire REAL —————
// Formas capturadas ao vivo no `codex app-server` 0.147 (sonda ×3 +
// schema gerado pelo próprio binário): NÃO existe notificação collab dedicada.
// O spawn é um `subAgentActivity {kind:"started", agentThreadId, agentPath}` no
// thread RAIZ; o trabalho do filho chega em frames com o threadId DELE; e o
// terminal factual é o `turn/completed` do filho — `subAgentActivity` não tem
// kind terminal e `closeAgent` nunca apareceu.

/** Par started/completed do spawn, como o app-server entrega (payload IDÊNTICO
 *  com ~1ms de diferença). */
function noteCodexSpawn(note, agentThreadId, agentPath, { itemId = `activity-${agentThreadId}` } = {}) {
  const item = { type: 'subAgentActivity', id: itemId, kind: 'started', agentThreadId, agentPath }
  note('item/started', { threadId: 'thread-root', turnId: 'turn-root', item })
  note('item/completed', { threadId: 'thread-root', turnId: 'turn-root', item })
}

test('Codex: subAgentActivity é o único sinal de spawn e o par started/completed vira UM card', () => {
  const { session, events, note } = codexAgentSession()

  // O frame de status do filho chega ANTES do spawn, com a thread ainda
  // desconhecida: não pode virar nada nem envenenar a conversa da raiz.
  note('thread/status/changed', { threadId: 'thread-child', status: { type: 'active' } })
  assert.deepEqual(events, [])

  noteCodexSpawn(note, 'thread-child', '/root/calculo')

  assert.deepEqual(events, [
    {
      type: 'tool',
      name: 'spawn_agent',
      input: { name: 'calculo', agent_type: 'codex', path: '/root/calculo' },
      toolUseId: 'codex-agent:thread-child'
    }
  ])
  assert.equal(session.codexAgents.size, 1, 'o par started/completed é UM agente só')

  // `interacted` é andamento, não spawn nem terminal.
  note('item/started', {
    threadId: 'thread-root',
    item: {
      type: 'subAgentActivity',
      id: 'activity-2',
      kind: 'interacted',
      agentThreadId: 'thread-child',
      agentPath: '/root/calculo'
    }
  })
  // Kind que o enum ainda não tem nunca registra nem encerra.
  note('item/started', {
    threadId: 'thread-root',
    item: {
      type: 'subAgentActivity',
      id: 'activity-3',
      kind: 'kind_que_ainda_nao_existe',
      agentThreadId: 'thread-outro',
      agentPath: '/root/outro'
    }
  })
  assert.equal(events.length, 1)
  assert.equal(session.codexAgents.size, 1)
})

test('Codex: trabalho do filho vira atividade do card e o turn/completed dele encerra', () => {
  const { session, events, note } = codexAgentSession()
  noteCodexSpawn(note, 'thread-child', '/root/calculo')
  events.length = 0

  note('item/started', {
    threadId: 'thread-child',
    turnId: 'turn-child',
    item: { type: 'commandExecution', id: 'cmd-1', command: 'npm test', cwd: '/w' }
  })
  assert.deepEqual(events.at(-1), {
    type: 'tool',
    name: 'Bash',
    input: { command: 'npm test', cwd: '/w' },
    toolUseId: 'cmd-1',
    parentToolUseId: 'codex-agent:thread-child'
  })

  note('item/completed', {
    threadId: 'thread-child',
    item: {
      type: 'commandExecution',
      id: 'cmd-1',
      status: 'completed',
      exitCode: 0,
      aggregatedOutput: 'tudo verde'
    }
  })
  assert.deepEqual(events.at(-1), {
    type: 'tool-result',
    text: 'tudo verde',
    isError: false,
    outcome: 'completed',
    toolUseId: 'cmd-1',
    lineCount: 1,
    truncated: false
  })

  // Terminal FACTUAL: o `turn/completed` do thread do filho, com a resposta
  // final dele virando o texto do card do pai.
  note('turn/completed', {
    threadId: 'thread-child',
    turn: {
      id: 'turn-child',
      status: 'completed',
      items: [
        { type: 'reasoning', id: 'r1' },
        { type: 'agentMessage', id: 'm1', phase: 'final_answer', text: 'achei a causa raiz' }
      ]
    }
  })
  assert.deepEqual(events.at(-1), {
    type: 'tool-result',
    text: 'achei a causa raiz',
    isError: false,
    outcome: 'completed',
    toolUseId: 'codex-agent:thread-child',
    lineCount: 1,
    truncated: false
  })
  assert.equal(Object.hasOwn(events.at(-1), 'agentStatus'), false, 'cerca A10: campo do Claude nunca no Codex')
  assert.equal(Object.hasOwn(events.at(-1), 'agentTaskId'), false)
  assert.equal(session.codexAgents.size, 0)

  // Terminal repetido do mesmo filho não ressuscita nem reabre o card.
  events.length = 0
  note('turn/completed', { threadId: 'thread-child', turn: { status: 'completed', items: [] } })
  assert.deepEqual(events, [])
})

test('Codex: result raiz espera o filho vivo e drena no último settle, fora de ordem', async () => {
  const { session, events, note } = codexAgentSession()
  noteCodexSpawn(note, 'thread-a', '/root/um')
  noteCodexSpawn(note, 'thread-b', '/root/dois')
  events.length = 0

  note('turn/completed', { threadId: 'thread-root', turn: { id: 'turn-root', status: 'completed' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, [], 'terminal do turno não anuncia nada com filho trabalhando')
  assert.equal(session.deferredCollabResult?.type, 'result')
  assert.equal(session.turnActive, true)

  // O segundo spawn conclui PRIMEIRO — a ordem do wire não é a da lateral.
  note('turn/completed', {
    threadId: 'thread-b',
    turn: { status: 'failed', error: { message: 'o subagente estourou' }, items: [] }
  })
  assert.deepEqual(events.at(-1), {
    type: 'tool-result',
    text: 'o subagente estourou',
    isError: true,
    outcome: 'failed',
    toolUseId: 'codex-agent:thread-b',
    lineCount: 1,
    truncated: false
  })
  assert.equal(events.filter((event) => event.type === 'result').length, 0, 'ainda há um filho vivo')
  assert.equal(session.turnActive, true)

  note('turn/completed', {
    threadId: 'thread-a',
    turn: { status: 'statusQueAindaNaoExiste', items: [] }
  })
  const results = events.filter((event) => event.type === 'result')
  assert.equal(results.length, 1, 'o último settle drena o terminal retido')
  assert.equal(events.at(-1).type, 'result')
  assert.equal(events.at(-1).continues, false)
  assert.equal(session.turnActive, false)
  assert.equal(session.deferredCollabResult, null)
})

test('Codex: fala do filho nunca entra no fio principal nem move o turno da raiz', () => {
  const { session, events, note } = codexAgentSession()
  noteCodexSpawn(note, 'thread-child', '/root/calculo')
  events.length = 0

  note('turn/started', { threadId: 'thread-child', turn: { id: 'turn-child' } })
  note('item/started', {
    threadId: 'thread-child',
    item: { type: 'reasoning', id: 'r1', content: [], summary: [] }
  })
  note('item/agentMessage/delta', { threadId: 'thread-child', itemId: 'm1', delta: 'rascunho do filho' })
  note('item/reasoning/textDelta', { threadId: 'thread-child', delta: 'pensando' })
  note('item/completed', {
    threadId: 'thread-child',
    item: { type: 'agentMessage', id: 'm1', phase: 'final_answer', text: 'resposta do filho' }
  })
  note('thread/tokenUsage/updated', {
    threadId: 'thread-child',
    tokenUsage: { last: { totalTokens: 99_000 }, modelContextWindow: 100_000 }
  })
  note('thread/status/changed', { threadId: 'thread-child', status: { type: 'idle' } })

  assert.deepEqual(events, [], 'nada de texto, delta, raciocínio ou contexto de filho')
  assert.equal(session.turnId, 'turn-root', 'o turno da conversa do dono continua o dele')
  assert.equal(session.lastTokens, undefined, 'a régua de contexto é da raiz, nunca do filho')
  assert.equal(session.codexAgents.size, 1, 'e o agente segue vivo até o turn/completed dele')
})

test('Codex: ferramenta do filho sem retorno fecha junto com o subagente', () => {
  const { session, events, note } = codexAgentSession()
  noteCodexSpawn(note, 'thread-child', '/root/calculo')
  note('item/started', {
    threadId: 'thread-child',
    item: { type: 'webSearch', id: 'search-1', query: 'causa raiz' }
  })
  events.length = 0

  note('turn/completed', {
    threadId: 'thread-child',
    turn: { status: 'completed', items: [] }
  })
  // Card filho pendente faria o terminal do turno inventar o erro de órfão:
  // ele fecha ANTES do card do pai, na mesma passada.
  assert.deepEqual(
    events.map((event) => [event.type, event.toolUseId, event.outcome]),
    [
      ['tool-result', 'search-1', 'cancelled'],
      ['tool-result', 'codex-agent:thread-child', 'completed']
    ]
  )
  assert.equal(events[0].isError, false, 'ferramenta sem retorno não é falha de ninguém')
  assert.equal(events[1].text, 'subagente concluído', 'sem resposta final, rótulo neutro')
  assert.equal(session.codexAgents.size, 0)
})

test('Codex: interrupção e encerramento cancelam os sub-agentes antes do terminal', async () => {
  const { session, events, note } = codexAgentSession()
  noteCodexSpawn(note, 'thread-child', '/root/calculo')
  events.length = 0

  const interrupted = {
    type: 'subAgentActivity',
    id: 'activity-int',
    kind: 'interrupted',
    agentThreadId: 'thread-child',
    agentPath: '/root/calculo'
  }
  note('item/started', { threadId: 'thread-root', item: interrupted })
  assert.deepEqual(events, [
    {
      type: 'tool-result',
      text: 'subagente cancelado',
      isError: false,
      outcome: 'cancelled',
      toolUseId: 'codex-agent:thread-child',
      lineCount: 1,
      truncated: false
    }
  ])
  assert.equal(session.codexAgents.size, 0)

  // O par started/completed do MESMO envelope não pode cancelar duas vezes, e
  // um spawn tardio do mesmo thread nunca ressuscita o agente morto.
  note('item/completed', { threadId: 'thread-root', item: interrupted })
  noteCodexSpawn(note, 'thread-child', '/root/calculo', { itemId: 'activity-tardio' })
  assert.equal(events.length, 1)
  assert.equal(session.codexAgents.size, 0)

  // Turno raiz interrompido leva os filhos junto: o terminal nunca fica refém
  // de um agente que ninguém mais vai encerrar.
  events.length = 0
  session.turnId = 'turn-root'
  noteCodexSpawn(note, 'thread-outro', '/root/dois')
  note('turn/completed', { threadId: 'thread-root', turn: { status: 'interrupted' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(
    events.map((event) => [event.type, event.toolUseId ?? null, event.outcome]),
    [
      ['tool', 'codex-agent:thread-outro', undefined],
      ['tool-result', 'codex-agent:thread-outro', 'cancelled'],
      ['result', null, 'cancelled']
    ]
  )
  assert.equal(session.codexAgents.size, 0)

  // Encerrar a sessão fecha o que sobrou, ANTES do terminal da conversa.
  events.length = 0
  session.turnId = 'turn-root'
  noteCodexSpawn(note, 'thread-final', '/root/tres')
  events.length = 0
  session.kill()
  assert.deepEqual(events, [
    {
      type: 'tool-result',
      text: 'subagente cancelado',
      isError: false,
      outcome: 'cancelled',
      toolUseId: 'codex-agent:thread-final',
      lineCount: 1,
      truncated: false
    }
  ])
  assert.equal(session.codexAgents.size, 0)
})

test('Codex: thread desconhecida continua descartada e a raiz não se registra como filha', () => {
  const { session, events, note } = codexAgentSession()

  note('item/agentMessage/delta', { threadId: 'thread-fantasma', delta: 'não pode aparecer' })
  note('item/started', {
    threadId: 'thread-fantasma',
    item: { type: 'commandExecution', id: 'cmd-x', command: 'ls' }
  })
  note('turn/completed', { threadId: 'thread-fantasma', turn: { status: 'completed' } })
  assert.deepEqual(events, [])
  assert.equal(session.turnId, 'turn-root', 'terminal de thread estranha não fecha o turno do dono')

  // Auto-referência (raiz anunciada como sub-agente de si mesma) esconderia a
  // conversa inteira atrás do roteador de filhos.
  noteCodexSpawn(note, 'thread-root', '/root')
  assert.deepEqual(events, [])
  assert.equal(session.codexAgents.size, 0)
})

test('Codex: CollabAgentStatus é enum ABERTO — notFound encerra, pendingInit não', () => {
  const { session, events } = codexAgentSession()
  const spawn = (status) => ({
    type: 'collabAgentToolCall',
    id: 'spawn-legacy',
    tool: 'spawn_agent',
    status: 'completed',
    newThreadId: 'thread-legacy',
    agentStatus: { status }
  })
  session.handleNotification('item/started', {
    threadId: 'thread-root',
    item: spawn('pendingInit')
  })
  session.handleNotification('item/completed', {
    threadId: 'thread-root',
    item: spawn('pendingInit')
  })
  assert.deepEqual(events.map((event) => event.type), ['tool'], 'nascendo ainda não é desfecho')
  assert.equal(session.activeCollabParentIds.size, 1)

  session.handleNotification('item/completed', { threadId: 'thread-root', item: spawn('notFound') })
  assert.deepEqual(events.at(-1), {
    type: 'tool-result',
    text: 'subagente falhou',
    isError: true,
    outcome: 'failed',
    toolUseId: 'spawn-legacy',
    lineCount: 1,
    truncated: false
  })
  assert.equal(session.activeCollabParentIds.size, 0, 'agente que sumiu nunca pendura o card')
})

test('registro de sub-agente do Codex: id sintético, nome do agentPath e memória de encerrados', () => {
  // O id do card pai é SINTÉTICO: não existe tool_use de spawn no wire do Codex.
  assert.equal(GUI_CODEX_AGENT_TOOL_PREFIX, 'codex-agent:')
  assert.equal(guiCodexAgentToolUseId('abc'), 'codex-agent:abc')
  assert.equal(guiCodexAgentName('/root/calculo'), 'calculo')
  assert.equal(guiCodexAgentName('/root/calculo/'), 'calculo', 'barra final não é nome')
  assert.equal(guiCodexAgentName('/root'), 'root')
  assert.equal(guiCodexAgentName(''), undefined)
  assert.equal(guiCodexAgentName(42), undefined)

  const registry = new GuiCodexAgentRegistry()
  assert.equal(registry.noteStarted('', '/root/x'), null, 'id torto nunca vira chave')
  assert.equal(registry.noteStarted('x'.repeat(201), '/root/x'), null, 'id acima do teto de hidratação')

  const agent = registry.noteStarted('t1', '/root/um')
  assert.deepEqual(agent, {
    agentThreadId: 't1',
    toolUseId: 'codex-agent:t1',
    name: 'um',
    agentPath: '/root/um',
    openToolUseIds: []
  })
  assert.equal(registry.noteStarted('t1', '/root/um'), null, 'segundo frame do par não duplica')
  assert.equal(registry.has('t1'), true)
  assert.equal(registry.toolUseIdFor('t1'), 'codex-agent:t1')

  assert.equal(registry.noteChildTool('t1', 'cmd-1'), 'codex-agent:t1')
  assert.equal(registry.noteChildTool('desconhecida', 'cmd-2'), undefined, 'filho de agente que não existe não tem linhagem')
  assert.deepEqual(registry.agentFor('t1').openToolUseIds, ['cmd-1'])
  assert.equal(registry.noteChildToolDone('t1', 'cmd-1'), 'codex-agent:t1')
  assert.deepEqual(registry.agentFor('t1').openToolUseIds, [])

  assert.equal(registry.noteSettled('t1')?.toolUseId, 'codex-agent:t1')
  assert.equal(registry.noteSettled('t1'), null, 'segundo terminal é no-op')
  assert.equal(registry.noteStarted('t1', '/root/um'), null, 'encerrado nunca ressuscita')
  assert.equal(registry.size, 0)

  registry.noteStarted('t2', '/root/dois')
  registry.noteStarted('t3', '/root/tres')
  assert.deepEqual(registry.settleAll().map((entry) => entry.agentThreadId), ['t2', 't3'])
  assert.equal(registry.size, 0)
  assert.deepEqual(registry.settleAll(), [])
})

test('resultado Codex tardio reconcilia somente depois que todos os envios assentam', () => {
  const session = Object.create(CodexSession.prototype)
  const events = []
  session.killed = false
  session.closed = false
  session.child = { exitCode: null, signalCode: null }
  session.pendingTurnStart = null
  session.turnId = null
  session.pendingSendOperations = new Set([2, 3])
  session.terminalReconcilePending = false
  session.emit = (event) => events.push(event)

  session.emitTurnResult({ type: 'result', isError: true, errorText: 'B falhou' }, 2)
  assert.equal(events.at(-1).continues, true)
  assert.equal(session.terminalReconcilePending, true)

  session.pendingSendOperations.delete(2)
  session.reconcileTerminalContinuation()
  assert.equal(events.length, 1, 'C ainda sem destino conserva o turno visual ativo')

  session.pendingSendOperations.delete(3)
  session.reconcileTerminalContinuation()
  assert.deepEqual(events.at(-1), { type: 'turn-continuation', continues: false })
  assert.equal(session.terminalReconcilePending, false)
})

test('interrupt repetido do Claude reutiliza a mesma solicitação do turno', () => {
  const session = Object.create(MaestroSession.prototype)
  session.activeTurnGeneration = 7
  session.interruptGeneration = null
  session.interruptRequestId = null
  session.interruptTimer = null
  let requests = 0
  session.write = () => {
    requests += 1
  }

  assert.equal(session.interrupt(), true)
  const requestId = session.interruptRequestId
  assert.equal(session.interrupt(), true)
  assert.equal(requests, 1)
  assert.equal(session.interruptRequestId, requestId)
  session.clearInterruptGuard()
})

test('pane sem sessão responde honesto em vez de fingir', () => {
  const gui = registry()

  assert.deepEqual(gui.send('fantasma', 'oi'), {
    ok: false,
    error: 'este pane não tem sessão aberta'
  })
  assert.equal(gui.permission('fantasma', 'req-1', 'allow').ok, false)
  assert.equal(gui.interrupt('fantasma').ok, false)
  assert.deepEqual(gui.state('fantasma'), {
    events: [],
    cursor: 0,
    exists: false,
    alive: false
  })
  // kill de pane que já não existe é sucesso: fechar duas vezes não é erro.
  assert.deepEqual(gui.kill('fantasma'), { ok: true })
})

test('sem documento de resume, lembrar é no-op (nada de disco em teste)', () => {
  const gui = registry()
  assert.equal(gui.remembered('p1'), undefined)
})

test('histórico visual persiste no fechamento e reabre sem duplicar eventos', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-gui-history-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const storeFile = join(root, 'gui-sessions.json')
  const spawn = {
    paneId: 'gui-dev-history1',
    projectId: 'proj-history',
    cli: 'claude',
    configDir: 'c',
    cwd: '/tmp'
  }

  let emitFirst
  const first = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    storeFile
  })
  first.spawnSession = (_input, sink) => {
    emitFirst = sink
    return {
      alive: true,
      turnActive: false,
      waitCaps: async () => ({ commands: [], models: [] }),
      send: () => undefined,
      kill: () => undefined
    }
  }
  assert.equal(first.create(spawn).ok, true)
  emitFirst({
    type: 'init',
    model: 'claude',
    sessionId: 'session-history',
    permissionMode: 'default',
    toolCount: 0,
    contextWindow: 200_000
  })
  emitFirst({ type: 'ready', caps: { commands: [], models: [] } })
  assert.equal(first.send(spawn.paneId, 'Guarde isto', 'msg-history-1').ok, true)
  emitFirst({ type: 'delta', text: 'Resposta ' })
  emitFirst({ type: 'delta', text: 'guardada' })
  emitFirst({ type: 'text', text: 'Resposta guardada' })
  emitFirst({
    type: 'result',
    isError: false,
    outcome: 'completed',
    contextTokens: 4_200
  })
  assert.deepEqual(
    {
      contextTokens: first.remembered(spawn.paneId).contextTokens,
      contextWindow: first.remembered(spawn.paneId).contextWindow,
      contextSessionId: first.remembered(spawn.paneId).contextSessionId
    },
    {
      contextTokens: 4_200,
      contextWindow: 200_000,
      contextSessionId: 'session-history'
    },
    'o último contexto canônico fica no registro da mesma sessão'
  )
  assert.equal(first.kill(spawn.paneId).ok, true)

  const afterClose = first.state(spawn.paneId)
  assert.equal(afterClose.exists, true)
  assert.equal(afterClose.alive, false)
  assert.equal(
    afterClose.events.filter(({ evt }) => evt.type === 'user-message').length,
    1
  )
  assert.equal(
    afterClose.events.filter(({ evt }) => evt.type === 'delta').length,
    1,
    'deltas do mesmo bloco ficam compactados na fotografia'
  )

  const second = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    storeFile
  })
  const beforeCreate = second.state(spawn.paneId)
  assert.equal(beforeCreate.exists, true, 'novo processo encontra o fio salvo')
  assert.equal(beforeCreate.alive, false)
  assert.equal(second.remembered(spawn.paneId).sessionId, 'session-history')
  assert.equal(second.remembered(spawn.paneId).contextTokens, 4_200)
  assert.equal(second.remembered(spawn.paneId).contextWindow, 200_000)

  second.spawnSession = (_input, sink) => {
    sink({
      type: 'init',
      model: 'claude',
      sessionId: 'session-history',
      permissionMode: 'default',
      toolCount: 0,
      contextWindow: 200_000
    })
    sink({ type: 'ready', caps: { commands: [], models: [] } })
    return { alive: true, turnActive: false, kill: () => undefined }
  }
  assert.equal(
    second.create({ ...spawn, resumeSessionId: second.remembered(spawn.paneId).sessionId }).ok,
    true
  )

  const reopened = second.state(spawn.paneId)
  assert.equal(reopened.alive, true)
  assert.equal(
    reopened.events.filter(({ evt }) => evt.type === 'user-message').length,
    1,
    'hidratação + eventos vivos não duplicam a mensagem do dono'
  )
  assert.equal(
    reopened.events.filter(({ evt }) => evt.type === 'text' && evt.text === 'Resposta guardada').length,
    1
  )
  assert.ok(
    reopened.events
      .filter(({ seq }) => seq > beforeCreate.cursor)
      .some(({ evt }) => evt.type === 'session-restarted'),
    'a geração retomada fica depois do cursor entregue ao renderer'
  )
  assert.deepEqual(
    reopened.events.find(({ evt }) => evt.type === 'session-restarted')?.evt,
    {
      type: 'session-restarted',
      ready: true,
      contextTokens: 4_200,
      contextWindow: 200_000
    },
    'o restart carrega o contexto antes de qualquer nova mensagem'
  )
})

test('contexto não atravessa troca de identidade mesmo com transcript antigo', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-gui-context-identity-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const storeFile = join(root, 'gui-sessions.json')
  const paneId = 'gui-context-identity'
  writeFileSync(
    storeFile,
    JSON.stringify({
      panes: {
        [paneId]: {
          sessionId: 'claude-old',
          cli: 'claude',
          projectId: 'proj-context',
          updatedAt: new Date().toISOString(),
          permissionMode: 'default',
          contextTokens: 88_000,
          contextWindow: 200_000,
          contextSessionId: 'claude-old'
        }
      },
      transcripts: {
        [paneId]: {
          events: [
            {
              type: 'init',
              model: 'claude',
              sessionId: 'claude-old',
              permissionMode: 'default',
              toolCount: 0,
              contextWindow: 200_000
            },
            { type: 'context-usage', contextTokens: 88_000, contextWindow: 200_000 }
          ],
          cursor: 2,
          updatedAt: new Date().toISOString()
        }
      }
    }),
    'utf8'
  )
  const gui = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    storeFile
  })
  gui.spawnSession = (_input, sink) => {
    sink({
      type: 'init',
      model: 'claude',
      sessionId: 'claude-new',
      permissionMode: 'default',
      toolCount: 0,
      contextWindow: 200_000
    })
    return { alive: true, kill: () => undefined }
  }
  assert.equal(
    gui.create({
      paneId,
      projectId: 'proj-context',
      cli: 'claude',
      configDir: 'new-seat',
      cwd: '/tmp'
    }).ok,
    true
  )
  const restarted = gui.state(paneId).events.find(({ evt }) => evt.type === 'session-restarted')
  assert.deepEqual(
    restarted?.evt,
    { type: 'session-restarted', ready: false },
    'sem resume da identidade persistida a foto antiga é descartada'
  )
  assert.equal(gui.remembered(paneId).contextTokens, undefined)
  assert.equal(gui.remembered(paneId).contextWindow, 200_000)
})

test('documento adulterado não injeta eventos desconhecidos no replay', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-gui-hydrate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const storeFile = join(root, 'gui-sessions.json')
  writeFileSync(
    storeFile,
    JSON.stringify({
      panes: {},
      transcripts: {
        'p-hydrate': {
          events: [
            { type: 'user-message', id: 'msg-1', text: 'válida', at: 1 },
            { type: 'delta', text: 42 },
            { type: 'evento-inventado', payload: { perigoso: true } }
          ],
          cursor: 9,
          updatedAt: '2026-08-14T00:00:00.000Z'
        },
        'p-record-invalido': {
          events: 'não é lista',
          cursor: 1,
          updatedAt: 'ontem'
        }
      }
    }),
    'utf8'
  )
  const gui = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    storeFile
  })
  const state = gui.state('p-hydrate')
  assert.equal(state.cursor, 9, 'eventos descartados não fazem o cursor voltar')
  assert.deepEqual(state.events, [
    { seq: 9, evt: { type: 'user-message', id: 'msg-1', text: 'válida', at: 1 } }
  ])
  assert.equal(gui.state('p-record-invalido').exists, false)
  const repaired = JSON.parse(readFileSync(storeFile, 'utf8'))
  assert.equal(repaired.transcripts['p-record-invalido'], undefined)
})

test('carga repara no disco um documento acima do teto global de panes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-gui-budget-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const storeFile = join(root, 'gui-sessions.json')
  const transcripts = Object.fromEntries(
    Array.from({ length: GUI_TRANSCRIPT_STORE_PANE_CAP + 2 }, (_, index) => [
      `p-${String(index).padStart(2, '0')}`,
      {
        events: [{ type: 'text', text: String(index) }],
        cursor: 1,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
      }
    ])
  )
  writeFileSync(storeFile, JSON.stringify({ panes: {}, transcripts }), 'utf8')
  new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    storeFile
  })
  const repaired = JSON.parse(readFileSync(storeFile, 'utf8'))
  assert.equal(Object.keys(repaired.transcripts).length, GUI_TRANSCRIPT_STORE_PANE_CAP)
  assert.equal(repaired.transcripts['p-00'], undefined)
  assert.equal(repaired.transcripts['p-01'], undefined)
})

test('/clear troca o backend, apaga fio e resume; kill sozinho preserva até exclusão', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-gui-clear-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const storeFile = join(root, 'gui-sessions.json')
  const live = []
  const spawns = []
  const sinks = []
  const gui = new GuiSessionRegistry({
    push: (payload) => live.push(payload),
    systemPromptFile: () => undefined,
    storeFile
  })
  gui.spawnSession = (input, sink) => {
    spawns.push({ ...input })
    sinks.push(sink)
    const generation = spawns.length
    sink({
      type: 'init',
      model: 'claude',
      sessionId: `session-${generation}`,
      permissionMode: 'default',
      toolCount: 0,
      contextWindow: 200_000
    })
    sink({ type: 'ready', caps: { commands: [], models: [] } })
    return {
      alive: true,
      turnActive: false,
      waitCaps: async () => ({ commands: [], models: [] }),
      send: () => undefined,
      kill: () => undefined
    }
  }
  const spawn = {
    paneId: 'gui-dev-clear12',
    projectId: 'proj-clear',
    cli: 'claude',
    configDir: 'c',
    cwd: '/tmp',
    firstPrompt: 'briefing inicial'
  }
  assert.equal(gui.create(spawn).ok, true)
  assert.equal(gui.send(spawn.paneId, 'mensagem antiga', 'msg-old').ok, true)
  sinks[0]({ type: 'text', text: 'resposta antiga' })
  sinks[0]({ type: 'result', isError: false, contextTokens: 3_200 })
  assert.equal(gui.remembered(spawn.paneId).contextTokens, 3_200)
  const cursorBeforeClear = gui.state(spawn.paneId).cursor

  assert.equal(gui.send(spawn.paneId, '/clear', 'msg-clear').ok, true)
  assert.equal(spawns.length, 2)
  assert.equal(spawns[1].resumeSessionId, undefined)
  assert.equal(spawns[1].firstPrompt, undefined, 'briefing não persegue a conversa nova')
  assert.equal(gui.remembered(spawn.paneId).sessionId, 'session-2')
  assert.equal(gui.remembered(spawn.paneId).contextTokens, undefined)
  assert.equal(gui.remembered(spawn.paneId).contextWindow, 200_000)
  assert.ok(
    live.some(
      ({ seq, evt }) => evt.type === 'conversation-cleared' && seq > cursorBeforeClear
    ),
    'o listener montado recebe um marco posterior ao cursor antigo'
  )
  const cleared = gui.state(spawn.paneId)
  assert.equal(cleared.events.some(({ evt }) => evt.type === 'user-message'), false)
  assert.equal(cleared.events.some(({ evt }) => evt.type === 'text'), false)
  assert.equal(
    cleared.events.filter(({ evt }) => evt.type === 'conversation-cleared').length,
    1
  )

  assert.equal(gui.kill(spawn.paneId).ok, true)
  assert.equal(gui.state(spawn.paneId).exists, true, 'arquivar/fechar conserva o fio')
  assert.equal(
    gui.forgetWhere((_paneId, record) => record?.projectId === spawn.projectId),
    1
  )
  assert.equal(gui.state(spawn.paneId).exists, false, 'exclusão definitiva purga o fio')
  assert.equal(gui.remembered(spawn.paneId), undefined)
})

// MODO DE PERMISSÃO POR CONVERSA (onda D — item 3 do docs/PLANO_2_0_GUI.md).
// O vocabulário é ÚNICO no app; cada CLI recebe a tradução dele. Se este
// mapeamento escorregar, o pane nasce com poder que o dono não escolheu.

test('o vocabulário de modos é fechado', () => {
  assert.deepEqual([...GUI_PERMISSION_MODES], ['default', 'acceptEdits', 'bypass', 'plan'])
  for (const mode of GUI_PERMISSION_MODES) assert.equal(isGuiPermissionMode(mode), true)
  for (const junk of ['bypassPermissions', 'yolo', '', null, undefined, 7])
    assert.equal(isGuiPermissionMode(junk), false)
})

test('claude traduz o modo para a chave --permission-mode', () => {
  assert.deepEqual(guiPermissionProfile('claude', undefined), {})
  assert.deepEqual(guiPermissionProfile('claude', 'default'), {})
  assert.deepEqual(guiPermissionProfile('claude', 'acceptEdits'), { permissionMode: 'acceptEdits' })
  // o nome da flag do binário é bypassPermissions, NUNCA o rótulo do app
  assert.deepEqual(guiPermissionProfile('claude', 'bypass'), {
    permissionMode: 'bypassPermissions'
  })
  assert.deepEqual(guiPermissionProfile('claude', 'plan'), { permissionMode: 'plan' })
})

test('codex separa o que PODE (sandbox) de quando PERGUNTA (approvalPolicy)', () => {
  assert.deepEqual(guiPermissionProfile('codex', 'default'), {})
  assert.deepEqual(guiPermissionProfile('codex', 'acceptEdits'), { sandbox: 'workspace-write' })
  assert.deepEqual(guiPermissionProfile('codex', 'bypass'), {
    sandbox: 'danger-full-access',
    approvalPolicy: 'never'
  })
  // plano = LÊ e não pergunta: sem o approvalPolicy o pane travaria num
  // diálogo de aprovação que o chat não tem como mostrar.
  assert.deepEqual(guiPermissionProfile('codex', 'plan'), {
    sandbox: 'read-only',
    approvalPolicy: 'never'
  })
})

test('nenhum modo entrega poder de escrita sem escolha explícita', () => {
  for (const cli of ['claude', 'codex']) {
    const profile = guiPermissionProfile(cli, 'default')
    assert.deepEqual(profile, {}, `${cli}: o padrão nunca carimba flag nenhuma`)
  }
  assert.equal(guiPermissionProfile('codex', 'plan').sandbox, 'read-only')
})

// TROCAR O MODO RESPAWNA — E O RESPAWN NÃO PODE PERDER A CONVERSA.
// As flags do modo moram no SPAWN do processo, então mudar de modo exige
// processo novo; o que não pode acontecer é o processo novo nascer em branco.

const baseSpawn = {
  paneId: 'gui-dev-abcd1234',
  projectId: 'proj',
  cli: 'claude',
  configDir: 'c',
  cwd: '/w'
}

test('o modo entra na identidade do spawn (troca = processo novo)', () => {
  const padrao = spawnFingerprint(baseSpawn)
  assert.equal(padrao, spawnFingerprint({ ...baseSpawn, permissionMode: 'default' }))
  for (const mode of ['acceptEdits', 'bypass', 'plan']) {
    assert.notEqual(
      spawnFingerprint({ ...baseSpawn, permissionMode: mode }),
      padrao,
      `${mode} tem de forçar respawn`
    )
  }
  // e modos diferentes nunca colidem entre si
  const todos = new Set(
    GUI_PERMISSION_MODES.map((m) => spawnFingerprint({ ...baseSpawn, permissionMode: m }))
  )
  assert.equal(todos.size, GUI_PERMISSION_MODES.length, 'cada modo é um spawn distinto')
})

test('o respawn herda a conversa gravada quando o chamador não a manda', () => {
  const remembered = { cli: 'claude', sessionId: 'sess-viva' }
  const previous = { cli: 'claude', resumeSessionId: 'sess-antiga' }

  // pedido explícito vence tudo
  assert.equal(
    inheritedResumeSessionId({ cli: 'claude', resumeSessionId: 'pedida' }, remembered, previous),
    'pedida'
  )
  // sem pedido: o documento tem o id MAIS FRESCO (gravado no init/session-id)
  assert.equal(inheritedResumeSessionId({ cli: 'claude' }, remembered, previous), 'sess-viva')
  // sem documento: cai no spawn anterior
  assert.equal(inheritedResumeSessionId({ cli: 'claude' }, undefined, previous), 'sess-antiga')
  // nada em lugar nenhum: conversa nova mesmo
  assert.equal(inheritedResumeSessionId({ cli: 'claude' }, undefined, undefined), undefined)
})

test('conversa de OUTRO cli nunca é herdada', () => {
  assert.equal(
    inheritedResumeSessionId(
      { cli: 'codex' },
      { cli: 'claude', sessionId: 'sess-claude' },
      { cli: 'claude', resumeSessionId: 'sess-claude' }
    ),
    undefined,
    'sessão do claude não se retoma no codex'
  )
})

test('entrada morta preserva replay e o create abre um único processo novo', () => {
  const gui = registry()
  const spawn = {
    paneId: 'p-retry',
    projectId: 'proj',
    cli: 'claude',
    configDir: 'c',
    cwd: '/tmp'
  }
  const ring = new GuiEventRing()
  ring.push({ type: 'fatal', text: 'falha transitória' })
  ring.push({ type: 'closed', code: 1 })
  const oldSession = { alive: false, kill: () => undefined }
  gui.panes.set(spawn.paneId, {
    spawn,
    fingerprint: spawnFingerprint(spawn),
    session: oldSession,
    ring,
    token: { alive: true },
    sink: (event) => ring.push(event)
  })

  assert.equal(gui.state(spawn.paneId).exists, true)
  assert.equal(gui.state(spawn.paneId).alive, false)

  let spawned = 0
  gui.spawnSession = (_input, sink) => {
    spawned += 1
    sink({ type: 'init', model: 'novo' })
    sink({ type: 'ready', caps: { commands: [], models: [] } })
    return { alive: true, kill: () => undefined }
  }
  assert.equal(gui.create(spawn).ok, true)
  assert.equal(gui.create(spawn).ok, true)
  assert.equal(spawned, 1)
  assert.equal(gui.state(spawn.paneId).alive, true)
  assert.deepEqual(
    gui.state(spawn.paneId).events.map(({ evt }) => evt.type),
    ['fatal', 'closed', 'init', 'ready', 'session-restarted', 'executor-changed'],
    'uma segunda remontagem reaplica o terminal antigo antes da nova geração viva'
  )
  assert.deepEqual(gui.state(spawn.paneId).events.at(-2).evt, {
    type: 'session-restarted',
    ready: true
  })
  assert.deepEqual(gui.state(spawn.paneId).events.at(-1).evt, {
    type: 'executor-changed',
    model: null,
    effort: null
  })
  assert.match(gui.state(spawn.paneId).events[0].evt.text, /falha transitória/u)
})

test('registro publica alertas somente no sink vivo e nunca durante replay', () => {
  const observed = []
  const live = []
  const gui = new GuiSessionRegistry({
    push: (payload) => live.push(payload),
    systemPromptFile: () => undefined,
    onChatAlert: (alert) => observed.push(alert)
  })
  let emit
  gui.spawnSession = (_input, sink) => {
    emit = sink
    return { alive: true, kill: () => undefined }
  }
  const spawn = {
    paneId: 'p-alerta',
    projectId: 'proj-alerta',
    cli: 'claude',
    configDir: 'c',
    cwd: '/tmp'
  }
  assert.equal(gui.create(spawn).ok, true)

  emit({ type: 'plan-review', requestId: 'plan-1', plan: 'Plano' })
  emit({ type: 'result', isError: false, continues: true })
  emit({ type: 'turn-continuation', continues: false })
  assert.deepEqual(observed.map((alert) => alert.kind), ['needs-you'])
  assert.equal(gui.presented(spawn.paneId, live.at(-1).seq).ok, true)
  assert.deepEqual(observed.map((alert) => alert.kind), ['needs-you', 'finished'])

  emit({ type: 'fatal', text: 'caiu' })
  const fatalSeq = live.at(-1).seq
  emit({ type: 'closed', code: 1 })
  assert.equal(observed.length, 2, 'falha também aguarda a apresentação')
  assert.equal(gui.presented(spawn.paneId, fatalSeq).ok, true)
  assert.deepEqual(observed.map((alert) => alert.kind), ['needs-you', 'finished', 'failed'])
  assert.ok(observed.every((alert) => alert.paneId === spawn.paneId))

  gui.state(spawn.paneId)
  gui.state(spawn.paneId)
  assert.equal(observed.length, 3, 'replay nunca republica alerta')
})

test('teardown canônico limpa o pane em respawn, kill direto e kill em lote', () => {
  const disposed = []
  const gui = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    onPaneDisposed: (entry) => disposed.push(entry)
  })
  gui.spawnSession = () => ({ alive: true, kill: () => undefined })

  const spawn = {
    paneId: 'p-teardown',
    projectId: 'proj-teardown',
    cli: 'claude',
    configDir: 'c',
    cwd: '/tmp'
  }
  assert.equal(gui.create(spawn).ok, true)
  assert.equal(gui.create({ ...spawn, permissionMode: 'plan' }).ok, true)
  assert.equal(gui.kill(spawn.paneId).ok, true)

  assert.equal(gui.create({ ...spawn, paneId: 'p-batch-a' }).ok, true)
  assert.equal(gui.create({ ...spawn, paneId: 'p-batch-b' }).ok, true)
  assert.equal(gui.killWhere((paneId) => paneId.startsWith('p-batch-')), 2)

  assert.deepEqual(
    disposed.map(({ paneId, reason }) => [paneId, reason]),
    [
      ['p-teardown', 'respawn'],
      ['p-teardown', 'kill'],
      ['p-batch-a', 'kill-batch'],
      ['p-batch-b', 'kill-batch']
    ]
  )
  assert.ok(disposed.every(({ projectId }) => projectId === spawn.projectId))
})

test('seat sem identidade limpa conversa e executor, mas preserva a permissão', () => {
  const remembered = {
    sessionId: 'sessao-do-seat-removido',
    cli: 'claude',
    projectId: 'proj',
    updatedAt: '2026-08-13T00:00:00.000Z',
    permissionMode: 'acceptEdits',
    model: 'opus',
    effort: 'high'
  }
  assert.deepEqual(guiSessionWithoutIdentity(remembered), {
    cli: 'claude',
    projectId: 'proj',
    updatedAt: '2026-08-13T00:00:00.000Z',
    permissionMode: 'acceptEdits'
  })
  assert.deepEqual(remembered, {
    sessionId: 'sessao-do-seat-removido',
    cli: 'claude',
    projectId: 'proj',
    updatedAt: '2026-08-13T00:00:00.000Z',
    permissionMode: 'acceptEdits',
    model: 'opus',
    effort: 'high'
  })
})

test('transplante falho apaga só o resume e preserva escolhas do pane', () => {
  const remembered = {
    sessionId: 'sess-antiga',
    cli: 'codex',
    projectId: 'proj',
    updatedAt: '2026-08-13T00:00:00.000Z',
    permissionMode: 'plan',
    model: 'gpt-5.6',
    effort: 'high'
  }
  assert.deepEqual(guiSessionWithoutResume(remembered), {
    cli: 'codex',
    projectId: 'proj',
    updatedAt: '2026-08-13T00:00:00.000Z',
    permissionMode: 'plan',
    model: 'gpt-5.6',
    effort: 'high'
  })
  assert.equal(remembered.sessionId, 'sess-antiga', 'a transformação não muta o registro')
})

// ANEXOS DO COMPOSER (gui:attach). O destino sai do REGISTRO, nunca do
// renderer; o resto são as três decisões puras: nome seguro, caminho único e
// o teto de tamanho.

test('o destino do anexo vem do pane; pane desconhecido não tem cwd', () => {
  const gui = registry()
  assert.equal(gui.cwdOf('fantasma'), undefined, 'sem sessão, nada de adivinhar pasta')
})

test('nome de anexo nunca vira travessia de diretório nem caractere ilegal', () => {
  assert.equal(safeAttachmentName('print.png'), 'print.png')
  // separadores das duas famílias: fica só o último segmento
  assert.equal(safeAttachmentName('../../etc/passwd'), 'passwd')
  assert.equal(safeAttachmentName('C:\\Windows\\System32\\drivers\\etc\\hosts'), 'hosts')
  // ilegais do Windows viram hífen, e o nome nunca sai vazio
  assert.equal(safeAttachmentName('re:latório<v2>?.pdf'), 're-latório-v2--.pdf')
  for (const junk of ['', '   ', '...', '/', '\\']) {
    assert.equal(safeAttachmentName(junk), 'anexo', `"${junk}" precisa de fallback`)
  }
  // dispositivo reservado do Windows (grava no NADA em qualquer extensão)
  assert.equal(safeAttachmentName('nul.png'), 'nul-anexo.png')
  assert.equal(safeAttachmentName('COM1.txt'), 'COM1-anexo.txt')
  // arquivo que é só extensão continua com nome
  assert.equal(safeAttachmentName('.env'), 'env')
})

test('nome gigante é cortado no MIOLO, preservando a extensão', () => {
  const name = safeAttachmentName(`${'a'.repeat(400)}.png`)
  assert.ok(name.length <= 120, `nome cortado (${name.length})`)
  assert.ok(name.endsWith('.png'), 'a extensão sobrevive ao corte')
})

test('anexo NUNCA sobrescreve anexo: colisão ganha sufixo', () => {
  const dir = join('C:', 'w', '.synkora', 'attachments')
  const taken = new Set([join(dir, 'print.png'), join(dir, 'print-1.png')])
  const exists = (p) => taken.has(p)

  assert.equal(uniqueAttachmentPath(dir, 'livre.png', exists), join(dir, 'livre.png'))
  assert.equal(uniqueAttachmentPath(dir, 'print.png', exists), join(dir, 'print-2.png'))
  // o caminho devolvido é sempre ABSOLUTO (o prompt do agente cita ele)
  assert.ok(uniqueAttachmentPath(dir, 'print.png', exists).startsWith(dir))
  // e o nome é saneado ANTES de procurar vaga
  assert.equal(uniqueAttachmentPath(dir, '../print.png', exists), join(dir, 'print-2.png'))
})

test('o tamanho do base64 é medido sem alocar o buffer', () => {
  // 'oi' = 2 bytes → 'b2k=' (uma casa de padding)
  assert.equal(base64ByteLength(Buffer.from('oi').toString('base64')), 2)
  assert.equal(base64ByteLength(Buffer.from('a').toString('base64')), 1)
  assert.equal(base64ByteLength(Buffer.from('abc').toString('base64')), 3)
  assert.equal(base64ByteLength(''), 0)
  // quebras de linha do transporte não contam como conteúdo
  const grande = Buffer.alloc(9_000).toString('base64')
  assert.equal(base64ByteLength(grande), 9_000)
  assert.equal(base64ByteLength(grande.replace(/(.{76})/g, '$1\n')), 9_000)
})

test('o teto de 10 MB recusa em PT-BR e nomeia o limite', () => {
  assert.equal(GUI_ATTACHMENT_MAX_BYTES, 10 * 1024 * 1024)
  const msg = attachmentTooLargeError(12.5 * 1024 * 1024)
  assert.match(msg, /12,5 MB/, 'tamanho do arquivo com vírgula decimal')
  assert.match(msg, /10,0 MB/, 'a mensagem diz qual é o limite')
  assert.match(msg, /grande demais/, 'texto de UI em PT-BR, não jargão em inglês')
})

test('MIME de imagem vem da assinatura e dimensões absurdas não chegam ao decoder', () => {
  const valid = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x03, 0x00
  ])
  assert.deepEqual(guiAttachmentMediaType('enganosa.txt', valid), {
    kind: 'image',
    mime: 'image/png'
  })

  const bomb = Buffer.from(valid)
  bomb.writeUInt32BE(GUI_ATTACHMENT_IMAGE_MAX_DIMENSION, 16)
  bomb.writeUInt32BE(Math.ceil(GUI_ATTACHMENT_IMAGE_MAX_PIXELS / GUI_ATTACHMENT_IMAGE_MAX_DIMENSION) + 1, 20)
  assert.equal(guiSafeImageInfo(bomb), undefined)
  assert.deepEqual(guiAttachmentMediaType('bomba.png', bomb), {
    kind: 'file',
    mime: 'application/octet-stream'
  })
  assert.match(guiAttachmentOpenProblem('script.svg', 'application/octet-stream'), /só pode ser baixado/u)
  assert.equal(guiAttachmentOpenProblem('relatorio.pdf', 'application/pdf'), undefined)
})

test('data URL não vira bytes corrompidos', () => {
  assert.equal(stripDataUrlPrefix('data:image/png;base64,QUJD'), 'QUJD')
  assert.equal(stripDataUrlPrefix('data:;base64,QUJD'), 'QUJD')
  assert.equal(stripDataUrlPrefix('  QUJD  '), 'QUJD')
})

test('payload torto é recusado antes de tocar o disco', () => {
  assert.equal(attachPayloadProblem({ kind: 'clipboard-image' }), undefined)
  assert.equal(attachPayloadProblem({ kind: 'file', name: 'a.png', bytesBase64: 'QUJD' }), undefined)

  assert.equal(attachPayloadProblem(undefined), 'anexo sem conteúdo')
  assert.equal(
    attachPayloadProblem({ kind: 'file', name: ' ', bytesBase64: 'QUJD' }),
    'anexo sem nome'
  )
  assert.equal(
    attachPayloadProblem({ kind: 'file', name: 'a.png', bytesBase64: '' }),
    'anexo sem conteúdo'
  )
  assert.match(attachPayloadProblem({ kind: 'pasta' }), /desconhecido/)
  assert.doesNotMatch(
    attachPayloadProblem({ kind: 'C:\\Users\\Pessoa\\segredo' }),
    /Users|Pessoa|segredo/u,
    'valor IPC adulterado nunca é refletido como caminho na UI'
  )
  assert.match(
    attachmentBase64Problem('!'.repeat(GUI_ATTACHMENT_MAX_BASE64_CHARS + 257)),
    /codificado grande demais/u,
    'lixo enorme é barrado pelo tamanho bruto antes de qualquer decoder'
  )
  assert.match(
    attachPayloadProblem({ kind: 'file', name: 'a.png', bytesBase64: 'QU?D' }),
    /base64 inválido/u
  )
})

test('pasta de anexos recusa junction e criação exclusiva não sobrescreve', () => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-attach-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'synkora-attach-outside-'))
  try {
    symlinkSync(outside, join(root, '.synkora'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(
      () => prepareGuiAttachmentDirectory(root),
      /link simbólico|junction/u,
      'junction nunca pode redirecionar bytes para fora do worktree'
    )
    rmSync(join(root, '.synkora'), { recursive: true, force: true })

    const dir = prepareGuiAttachmentDirectory(root)
    const first = writeGuiAttachmentExclusive(dir, 'nota.txt', Buffer.from('primeiro'))
    const second = writeGuiAttachmentExclusive(dir, 'nota.txt', Buffer.from('segundo'))
    assert.notEqual(first, second)
    assert.equal(readFileSync(first, 'utf8'), 'primeiro')
    assert.equal(readFileSync(second, 'utf8'), 'segundo')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('capacidade de arquivo, imagem e pasta externa sobrevive reload e falha fechada', () => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-attach-reference-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'synkora-attach-reference-outside-'))
  try {
    const folder = join(root, 'referencias')
    mkdirSync(folder)
    const dir = prepareGuiAttachmentDirectory(root)
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03
    ])
    assert.deepEqual(guiSafeImageInfo(png), { mime: 'image/png', width: 2, height: 3 })
    const image = writeGuiAttachmentExclusive(dir, 'print.png', png)
    const text = writeGuiAttachmentExclusive(dir, 'nota.txt', Buffer.from('nota'))
    const capabilityFile = join(outside, 'capabilities.json')
    const capabilities = new GuiAttachmentCapabilityStore(capabilityFile)
    const imageMedia = guiAttachmentMediaType('print.png', png)
    const textMedia = guiAttachmentMediaType('nota.txt', Buffer.from('nota'))
    assert.throws(
      () =>
        capabilities.issue('pane-capability', {
          kind: 'image',
          path: image,
          size: png.length,
          mime: 'application/pdf'
        }),
      /metadados públicos/u
    )
    const input = [
      capabilities.issue('pane-capability', {
        kind: imageMedia.kind,
        path: image,
        size: png.length,
        mime: imageMedia.mime
      }),
      capabilities.issue('pane-capability', {
        kind: textMedia.kind,
        path: text,
        size: 4,
        mime: textMedia.mime
      }),
      capabilities.issue('pane-capability', {
        kind: 'folder',
        path: outside,
        size: null,
        mime: null
      })
    ]
    const checked = validateGuiAttachmentReferences(root, 'pane-capability', input, capabilities)
    assert.equal(checked.ok, true)
    assert.equal(GUI_ATTACHMENT_MAX_FILES, 20)
    assert.equal(GUI_ATTACHMENT_MAX_TOTAL_BYTES, 50 * 1024 * 1024)
    if (!checked.ok) throw new Error(checked.error)
    assert.deepEqual(
      checked.attachments.map((attachment) => attachment.kind),
      ['image', 'file', 'folder']
    )
    assert.ok(checked.attachments.every(isGuiAttachmentDescriptor))
    assert.ok(checked.attachments.every((attachment) => !('path' in attachment)))
    assert.equal(
      isGuiAttachmentDescriptor({ ...input[2], name: 'C:\\Users\\Pessoa\\segredo' }),
      false,
      'nome adulterado nunca vira caminho visível'
    )
    assert.equal(guiAttachmentKindForName('foto.WEBP'), 'image')
    assert.equal(guiAttachmentKindForName('relatorio.pdf'), 'file')
    const prompt = withGuiAttachmentReferences('veja isto', checked.resolved)
    assert.match(prompt, /\[Anexos desta mensagem/u)
    assert.match(prompt, /\[\/Anexos\]/u)
    assert.match(prompt, new RegExp(image.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'), 'u'))

    // O registro é durável: a mesma capacidade continua válida depois de uma
    // nova instância (reload/app restart) e pode atravessar a fila do renderer.
    const reloadedCapabilities = new GuiAttachmentCapabilityStore(capabilityFile)
    const afterReload = validateGuiAttachmentReferences(
      root,
      'pane-capability',
      input,
      reloadedCapabilities
    )
    assert.equal(afterReload.ok, true)

    assert.equal(resolveGuiFolderReference(root, folder).ok, true)
    const escape = resolveGuiFolderReference(root, outside)
    assert.equal(escape.ok, false)
    if (!escape.ok) assert.match(escape.error, /dentro da pasta de trabalho/u)

    // O anexo do composer usa o diálogo nativo e pode referenciar qualquer
    // pasta local; o alvo ainda precisa ser um diretório físico real.
    const external = resolveGuiExternalFolderReference(outside)
    assert.equal(external.ok, true)
    if (external.ok) assert.equal(external.path, outside)

    const folderLink = join(root, 'link-fora')
    symlinkSync(outside, folderLink, process.platform === 'win32' ? 'junction' : 'dir')
    const link = resolveGuiFolderReference(root, folderLink)
    assert.equal(link.ok, false)
    if (!link.ok) assert.match(link.error, /link simbólico|junction/u)
    const externalLink = resolveGuiExternalFolderReference(folderLink)
    assert.equal(externalLink.ok, false)
    if (!externalLink.ok) assert.match(externalLink.error, /link simbólico|junction/u)

    const nestedFolder = join(folder, 'aninhada')
    mkdirSync(nestedFolder)
    const internalLink = join(root, 'atalho-interno')
    symlinkSync(folder, internalLink, process.platform === 'win32' ? 'junction' : 'dir')
    const throughInternalLink = resolveGuiFolderReference(root, join(internalLink, 'aninhada'))
    assert.equal(throughInternalLink.ok, false, 'link interno também falha fechado')
    const throughExternalLink = resolveGuiExternalFolderReference(join(internalLink, 'aninhada'))
    assert.equal(
      throughExternalLink.ok,
      false,
      'pasta externa aninhada também não pode atravessar junction/symlink'
    )

    const forged = validateGuiAttachmentReferences(
      root,
      'pane-capability',
      [
        {
          id: 'fora',
          capability: `gui-cap-v1-${'A'.repeat(43)}`,
          kind: 'folder',
          name: 'pasta-existente',
          mime: null,
          size: null,
          path: outside
        }
      ],
      reloadedCapabilities
    )
    assert.equal(forged.ok, false)
    if (!forged.ok) assert.doesNotMatch(forged.error, /segredo|outside|root/u)

    const wrongPane = validateGuiAttachmentReferences(
      root,
      'outro-pane',
      [input[2]],
      reloadedCapabilities
    )
    assert.equal(wrongPane.ok, false, 'a capacidade é vinculada ao pane emissor')

    // Mesmo uma pasta legitimamente escolhida deixa de valer se for trocada
    // por junction/symlink depois da emissão.
    const swappable = join(root, 'pasta-trocavel')
    const original = join(root, 'pasta-trocavel-original')
    mkdirSync(swappable)
    const swappableDescriptor = capabilities.issue('pane-capability', {
      kind: 'folder',
      path: swappable,
      size: null,
      mime: null
    })
    renameSync(swappable, original)
    symlinkSync(outside, swappable, process.platform === 'win32' ? 'junction' : 'dir')
    const swapped = validateGuiAttachmentReferences(
      root,
      'pane-capability',
      [swappableDescriptor],
      capabilities
    )
    assert.equal(swapped.ok, false, 'alvo trocado por link falha fechado')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
