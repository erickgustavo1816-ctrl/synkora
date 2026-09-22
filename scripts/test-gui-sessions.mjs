import assert from 'node:assert/strict'
import {
  appendFileSync,
  existsSync,
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
  guiBriefedPrompt,
  guiMessageIdProblem,
  guiQueuedDeliveryProblem,
  guiPromptProblem,
  guiPermissionProfile,
  rememberedGuiExecutorValue,
  guiSkillReloadNote,
  guiSessionWithoutIdentity,
  guiSessionWithoutResume,
  inheritedResumeSessionId,
  isGuiPersistedEvent,
  isGuiPermissionMode,
  pruneGuiTranscripts,
  spawnFingerprint
} from '../.tmp/gui-sessions-test/main/guiSessions.js'
import {
  MaestroSession,
  claudeCuratedContextWindow,
  claudeMessageContextTokens,
  claudeReportedContextWindow,
  claudeSessionCostUsd
} from '../.tmp/gui-sessions-test/main/maestroSession.js'
import { CodexSession } from '../.tmp/gui-sessions-test/main/codexSession.js'
import {
  GUI_HEAVY_CONTEXT_TOKENS,
  guiAddApiCall,
  guiConversationWeightTokens,
  guiHeavyContextMilestone,
  isGuiConversationUsage
} from '../.tmp/gui-sessions-test/main/guiConversationOdometer.js'
import {
  GUI_PLANNER_TOKEN_ENV,
  guiPlannerCodexArgs
} from '../.tmp/gui-sessions-test/main/guiPlannerMcp.js'
import { armGuiDelegateMcp } from '../.tmp/gui-sessions-test/main/guiDelegateMcp.js'

// O ARM DO PLANEJADOR (2026-08-30): a trilha própria morreu — o planejador
// arma pelo mesmo encanamento dos outros chats, com o papel `gui-planner`.
const armGuiPlannerMcp = (input, deps) => armGuiDelegateMcp(input, deps, 'gui-planner')
import { GuiClaudeTaskRegistry } from '../.tmp/gui-sessions-test/main/guiClaudeTasks.js'
import {
  GUI_CODEX_AGENT_TOOL_PREFIX,
  GuiCodexAgentRegistry,
  guiCodexAgentName,
  guiCodexAgentToolUseId
} from '../.tmp/gui-sessions-test/main/guiCodexAgents.js'
import {
  guiChildNeedsTermination,
  guiTreeKillCommand
} from '../.tmp/gui-sessions-test/main/guiProcessTree.js'
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
} from '../.tmp/gui-sessions-test/main/guiAttachments.js'
import {
  chatPermissionRuleLabel,
  fallbackBashPermissionRule,
  resolveChatPermissionSuggestions
} from '../.tmp/gui-sessions-test/main/chatPermissions.js'
import {
  prepareGuiAttachmentDirectory,
  resolveGuiDroppedTarget,
  resolveGuiExternalFolderReference,
  resolveGuiFolderReference,
  validateGuiAttachmentReferences,
  writeGuiAttachmentExclusive
} from '../.tmp/gui-sessions-test/main/guiAttachmentStorage.js'
import { GuiAttachmentCapabilityStore } from '../.tmp/gui-sessions-test/main/guiAttachmentCapabilities.js'
import { closePendingGuiTools } from '../src/renderer/src/guiTerminalTools.ts'
// O POTE DO DONO (módulo NOVO da R22) entra pela porta TOLERANTE: import
// estático de arquivo ausente derrubaria a suíte inteira, e ela deixaria de
// discriminar. Sem o módulo, caem só os testes da rota — e caem dizendo o que
// falta.
const ownerMailModule = await import('../.tmp/gui-sessions-test/main/guiOwnerMail.js').catch(() => ({}))
// R39 — a DÍVIDA (R32) passa a ser armada TAMBÉM no fecho/handoff, e a régua da
// rota mora em módulo NOVO: os dois entram pela mesma porta tolerante.
const ownerDebtModule = await import('../.tmp/gui-sessions-test/main/guiOwnerReplyDebt.js').catch(
  () => ({})
)

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

test('pensamento prolongado não expulsa as falas públicas nem incha o replay', () => {
  const ring = new GuiEventRing(12, 2000)
  const opening = { type: 'text', text: 'Vou conferir o problema.' }
  const progress = { type: 'text', text: 'Encontrei a causa; estou validando.' }
  ring.push(opening)
  for (let step = 0; step < 3; step++) {
    for (let token = 0; token < 1000; token++) ring.push({ type: 'thinking' })
    ring.push({ type: 'tool', name: 'Read', toolUseId: `t-${step}`, input: {} })
    ring.push({ type: 'tool-result', toolUseId: `t-${step}`, text: 'synthetic', isError: false })
  }
  ring.push(progress)
  assert.deepEqual(ring.snapshot().filter(e => e.type === 'text'), [opening, progress])
  assert.equal(ring.snapshot().filter(e => e.type === 'thinking').length, 3)
  assert.equal(ring.evictedCount, 0)
  assert.equal(ring.cursor, 3008, 'o cursor ao vivo continua contando cada evento')
})

test('replay guarda só o sinal de pensamento e preserva fronteiras com falas e ferramentas', () => {
  const ring = new GuiEventRing(10, 300)
  ring.push({ type: 'text', text: 'Antes' })
  ring.push({ type: 'thinking', text: 'private-synthetic'.repeat(500) })
  const last = ring.push({ type: 'thinking', text: 'more-private-synthetic' })
  ring.push({ type: 'text', text: 'Depois' })
  assert.deepEqual(ring.sequencedSnapshot(), [
    { seq: 1, evt: { type: 'text', text: 'Antes' } },
    { seq: last, evt: { type: 'thinking' } },
    { seq: 4, evt: { type: 'text', text: 'Depois' } }
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

  // R12: o carimbo do restart retomado atravessa o disco — e só como boolean.
  assert.equal(isGuiPersistedEvent({ type: 'session-restarted', ready: true, resumed: true }), true)
  assert.equal(
    isGuiPersistedEvent({ type: 'session-restarted', ready: true, resumed: false }),
    true
  )
  assert.equal(
    isGuiPersistedEvent({ type: 'session-restarted', ready: true }),
    true,
    'fotografia gravada antes do contrato novo continua hidratando'
  )
  assert.equal(
    isGuiPersistedEvent({ type: 'session-restarted', ready: true, resumed: 'sim' }),
    false,
    'carimbo torto nunca vira "a conversa continua" no redutor'
  )
  assert.equal(isGuiPersistedEvent({ type: 'session-restarted', resumed: true }), false)
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

// R24.1 — A PODA FALA. O anel descarta os mais antigos desde 2026-08-15 e até
// aqui fazia isso em SILÊNCIO: o fio remontado nascia cortado sem uma linha
// dizendo que houve mais antes (queixa do dono: "subo, subo, e acaba").

test('R24.1 — o anel conta o que a poda descartou e o contador atravessa a hidratação', () => {
  const ring = new GuiEventRing(3)
  for (const text of ['a', 'b', 'c', 'd', 'e']) ring.push({ type: 'command-output', text })
  assert.equal(ring.size, 3)
  assert.equal(ring.evictedCount, 2, 'a poda deixou de ser muda')

  ring.clear()
  assert.equal(ring.evictedCount, 0, 'trocar de conversa não deixa a poda antiga falar pela nova')

  const hydrated = new GuiEventRing(GUI_RING_CAP, GUI_RING_BYTE_CAP, 40, 7)
  assert.equal(hydrated.evictedCount, 7, 'a fotografia do disco devolve o que já tinha saído')
  hydrated.push({ type: 'text', text: 'depois do boot' })
  assert.equal(hydrated.evictedCount, 7, 'push sem poda nunca inventa evicção')
})

test('R24.1 — a poda avisa uma vez ao vivo, sobrevive ao disco e abre o replay', () => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-ring-pruned-'))
  const storeFile = join(root, 'gui-sessions.json')
  const spawn = {
    paneId: 'p-pruned',
    projectId: 'proj',
    cli: 'claude',
    configDir: 'c',
    cwd: '/tmp',
    permissionMode: 'default'
  }
  const caps = { commands: [], models: [] }
  const pushed = []
  let sink = null
  const makeRegistry = () => {
    const gui = new GuiSessionRegistry({
      push: (payload) => pushed.push(payload),
      systemPromptFile: () => undefined,
      storeFile
    })
    gui.spawnSession = (_spawn, emit) => {
      sink = emit
      emit({
        type: 'init',
        model: 'default',
        sessionId: 'pruned-session',
        permissionMode: 'default',
        toolCount: 0
      })
      emit({ type: 'ready', caps })
      return {
        alive: true,
        turnActive: false,
        caps,
        waitCaps: async () => caps,
        setExecutor: async () => true,
        send: () => undefined,
        kill: () => undefined
      }
    }
    return gui
  }

  try {
    const first = makeRegistry()
    assert.equal(first.create(spawn).ok, true)
    // Distinct tool starts fill the ring without a checkpoint on every event.
    // Repeated thinking signals now compact and must not evict real history.
    for (let index = 0; index < GUI_RING_CAP + 20; index += 1) {
      sink({ type: 'tool-start', toolUseId: `synthetic-${index}` })
    }
    sink({ type: 'text', text: 'a fala mais nova' })

    const notices = pushed.filter((payload) => payload?.evt?.type === 'history-pruned')
    assert.equal(notices.length, 1, 'a primeira poda avisa UMA vez — sem relógio novo')
    assert.equal(notices[0].paneId, spawn.paneId)
    assert.ok(notices[0].evt.evicted > 0)

    first.kill(spawn.paneId)
    const persisted = JSON.parse(readFileSync(storeFile, 'utf8'))
    const evicted = persisted.transcripts[spawn.paneId].evicted
    assert.ok(Number.isSafeInteger(evicted) && evicted > 0, 'o contador sobrevive ao disco')

    const reopened = makeRegistry()
    const replay = reopened.state(spawn.paneId)
    assert.equal(replay.exists, true)
    assert.deepEqual(
      replay.events[0].evt,
      { type: 'history-pruned', evicted },
      'a remontagem abre dizendo que o começo saiu da tela'
    )
    assert.equal(
      replay.events.filter((event) => event.evt?.type === 'history-pruned').length,
      1
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
  session.turnGeneration = 0
  session.activeTurnGeneration = null
  session.resetIdle = () => {}
  session.interruptGeneration = null
  session.interruptRequestId = null
  session.interruptTimer = null
  // Memória do limite (R21): estado já anunciado + o que bloqueia agora.
  session.rateLimitKey = null
  session.rateLimitBlocked = null
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
})

test('mensagem no meio do turno é STEERING: não abre geração, e um result só fecha o turno', () => {
  // O claude DOBRA a mensagem no turno em andamento (`queue-operation` com
  // `reason: "absorbed_mid_turn"` no transcript, 2.1.251) e emite UM `result`.
  // Contar geração no steer era esperar um segundo `result` que nunca vem: o
  // turno ficava ativo para sempre e o `continues` mentia — foi o que matou
  // dois ajudantes com o relatório pronto (idle de 10 min, 2026-08-31/09-01).
  const { session, events, line } = claudeAgentSession()
  const writes = []
  session.turnGeneration = 0
  session.write = (obj) => writes.push(obj)
  session.resetIdle = () => {}

  session.send('primeira pergunta')
  assert.deepEqual(session.pendingTurnGenerations, [1])
  assert.equal(session.turnActive, true)

  session.send('corrija o rumo')
  assert.deepEqual(session.pendingTurnGenerations, [1], 'steer não vira turno novo')
  assert.equal(writes.length, 2, 'o texto vai ao stdin do mesmo jeito')
  assert.equal(writes[1].message.content[0].text, 'corrija o rumo')

  line({ type: 'result', is_error: false, result: 'resposta única' })
  assert.equal(events.at(-1).type, 'result')
  assert.equal(events.at(-1).continues, false, 'o único result fecha o turno inteiro')
  assert.equal(session.turnActive, false)

  // Sessão OCIOSA abre geração: o CLI desenfileira a mensagem como turno próprio
  // (`enqueue`+`dequeue` no mesmo milissegundo, no transcript).
  session.send('pergunta nova')
  assert.deepEqual(session.pendingTurnGenerations, [2])
  assert.equal(session.turnActive, true)
  line({ type: 'result', is_error: false })
  assert.equal(events.at(-1).continues, false)
  assert.equal(session.turnActive, false)
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
  assert.equal(events.at(-2).type, 'turn-started')
  assert.equal(events.at(-3).type, 'init')
  assert.equal(session.turnActive, true)
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

// R7-E — O CASO REAL (print do dono, 2026-08-18): ■ com ferramentas em voo, e o
// claude devolve `is_error` com texto NENHUM. O motor SABE que a interrupção foi
// pedida (o ■ passou por ele), então o desfecho é declarado — nunca "erro sem
// detalhe".
test('Claude: result depois do ■ do dono é interrupção declarada, não falha', () => {
  const { session, events, line } = claudeAgentSession()
  session.activeTurnGeneration = 7
  session.pendingTurnGenerations = [7]
  session.interruptGeneration = 7
  session.interruptRequestId = 'req-int'
  events.length = 0

  line({ type: 'result', is_error: true })
  const result = events.at(-1)
  assert.equal(result.type, 'result')
  assert.equal(result.interrupted, true, 'o evento DECLARA a interrupção')
  assert.equal(result.isError, false, 'parada pedida pelo dono não é falha')
  assert.equal(result.outcome, 'cancelled')
  assert.equal(result.errorText, 'interrompido pelo dono')
  assert.notEqual(result.errorText, 'erro sem detalhe')
  assert.equal(result.continues, false)
})

test('Claude: turno que falha de verdade continua falhando com o texto do CLI', () => {
  const semDetalhe = claudeAgentSession()
  semDetalhe.session.activeTurnGeneration = 1
  semDetalhe.session.pendingTurnGenerations = [1]
  semDetalhe.events.length = 0
  semDetalhe.line({ type: 'result', is_error: true })
  const mudo = semDetalhe.events.at(-1)
  assert.equal(mudo.interrupted, undefined, 'sem ■ do dono nada é declarado')
  assert.equal(mudo.isError, true)
  assert.equal(mudo.outcome, 'failed')
  assert.equal(mudo.errorText, 'erro sem detalhe')

  const comTexto = claudeAgentSession()
  comTexto.session.activeTurnGeneration = 1
  comTexto.session.pendingTurnGenerations = [1]
  comTexto.events.length = 0
  comTexto.line({ type: 'result', is_error: true, result: 'o turno explodiu' })
  const falhou = comTexto.events.at(-1)
  assert.equal(falhou.interrupted, undefined)
  assert.equal(falhou.isError, true)
  assert.equal(falhou.errorText, 'o turno explodiu')
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
  // O ingest lê o cwd para saber onde mora a pasta de skills DESTE pane (o chip
  // de skill, 2026-08-30). Fake sem `opts` é fake incompleto, não motor mudo.
  session.opts = { cwd: '/w' }
  session.skillsEntered = new Set()
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

  // Sem tool-result, falta um recibo: o fechamento mantém essa incerteza
  // visível sem contradizer o resultado bem-sucedido informado pelo motor.
  const orphan = closePendingGuiTools(
    [{ id: 'orphan', kind: 'tool', name: 'WebSearch', summary: 'sem retorno', toolUseId: 'orphan' }],
    { type: 'result', isError: false, outcome: 'completed' }
  )
  assert.equal(orphan[0].result.isError, false)
  assert.equal(orphan[0].result.status, 'unconfirmed')
})

// ————— O PANE NASCE MUDO (ordem do dono) —————
//
// O briefing da missão deixou de abrir turno no spawn: ele fica PENDENTE na
// entrada e sai colado na PRIMEIRA mensagem do dono. Assim o dono ajusta
// conta/modelo/effort/permissão num chat parado, e o agente recebe o briefing
// e a pergunta dele no mesmo turno.

/** Registro com sessão de mentira que anota o que foi ENVIADO ao CLI. */
function briefingRegistry() {
  const sent = []
  const spawns = []
  const gui = registry()
  gui.spawnSession = (input, sink) => {
    spawns.push({ ...input })
    sink({
      type: 'init',
      model: 'claude',
      sessionId: `sess-${spawns.length}`,
      permissionMode: input.permissionMode ?? 'default',
      toolCount: 0,
      contextWindow: 200_000
    })
    return {
      alive: true,
      turnActive: false,
      waitCaps: async () => ({ commands: [], models: [] }),
      send: (text) => sent.push(text),
      kill: () => undefined
    }
  }
  return { gui, sent, spawns }
}

const BRIEFED_SPAWN = {
  paneId: 'gui-dev-mudo01',
  projectId: 'proj-mudo',
  cli: 'claude',
  configDir: 'c',
  cwd: '/tmp',
  firstPrompt: 'MISSION: entrar no app'
}

test('replay reports the permission mode of the current session', () => {
  const { gui } = briefingRegistry()
  try {
    gui.create({ ...BRIEFED_SPAWN, permissionMode: 'plan' })
    assert.equal(gui.state(BRIEFED_SPAWN.paneId).permissionMode, 'plan')
    gui.create({ ...BRIEFED_SPAWN, permissionMode: 'default' })
    assert.equal(gui.state(BRIEFED_SPAWN.paneId).permissionMode, 'default')
    gui.kill(BRIEFED_SPAWN.paneId)
    assert.equal(gui.state(BRIEFED_SPAWN.paneId).permissionMode, undefined)
  } finally {
    gui.killAll()
  }
})

test('o briefing fica pendente e o create não abre turno nenhum', async () => {
  const { gui, sent } = briefingRegistry()
  assert.equal(gui.create(BRIEFED_SPAWN).ok, true)
  // O handshake resolve num microtask: é exatamente ali que a auto-partida
  // antiga soltava o briefing sozinha.
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(sent, [], 'nada foi enviado ao CLI no nascimento do pane')
  const kinds = gui.state(BRIEFED_SPAWN.paneId).events.map(({ evt }) => evt.type)
  assert.equal(kinds.includes('turn-started'), false, 'nenhum turno abriu sozinho')
  assert.equal(kinds.includes('user-message'), false)
  assert.equal(gui.panes.get(BRIEFED_SPAWN.paneId).pendingBriefing, 'MISSION: entrar no app')
})

test('o briefing sai colado na 1ª mensagem do dono, uma única vez', () => {
  const { gui, sent } = briefingRegistry()
  assert.equal(gui.create(BRIEFED_SPAWN).ok, true)

  assert.equal(gui.send(BRIEFED_SPAWN.paneId, 'começa pelo login', 'msg-1').ok, true)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /^MISSION: entrar no app\n/u)
  assert.match(sent[0], /A MENSAGEM DO DONO:\ncomeça pelo login$/u)
  // O fio conta a verdade: a bolha do dono tem as PALAVRAS DELE, não o briefing.
  const userMessage = gui
    .state(BRIEFED_SPAWN.paneId)
    .events.map(({ evt }) => evt)
    .find((evt) => evt.type === 'user-message')
  assert.equal(userMessage.text, 'começa pelo login')

  assert.equal(gui.send(BRIEFED_SPAWN.paneId, 'e depois o cadastro', 'msg-2').ok, true)
  assert.equal(sent.length, 2)
  assert.equal(sent[1], 'e depois o cadastro', 'o briefing não persegue as mensagens seguintes')
  assert.equal(gui.panes.get(BRIEFED_SPAWN.paneId).pendingBriefing, undefined)
})

test('respawn antes da 1ª mensagem preserva o briefing pendente', async () => {
  const { gui, sent, spawns } = briefingRegistry()
  assert.equal(gui.create(BRIEFED_SPAWN).ok, true)

  // O dono mexe na PERMISSÃO antes de escrever: fingerprint novo, processo
  // novo — e o spawn herdado zera `firstPrompt` de propósito (conversa
  // retomada já teria o briefing dentro). Sem herdar o PENDENTE, o briefing
  // morreria exatamente aqui.
  assert.equal(gui.create({ ...BRIEFED_SPAWN, permissionMode: 'bypass' }).ok, true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(spawns.length, 2)
  assert.equal(spawns[1].firstPrompt, undefined, 'o spawn herdado não repete o briefing')
  assert.deepEqual(sent, [], 'o respawn também nasce mudo')

  assert.equal(gui.send(BRIEFED_SPAWN.paneId, 'pode começar', 'msg-1').ok, true)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /MISSION: entrar no app/u)
  assert.match(sent[0], /pode começar$/u)
})

test('a 1ª mensagem que é comando não queima o briefing', () => {
  const { gui, sent } = briefingRegistry()
  assert.equal(gui.create(BRIEFED_SPAWN).ok, true)

  // /model é roteado no motor e nunca chega ao modelo: soltar o briefing aqui
  // seria perdê-lo num comando que o agente nem vê.
  assert.equal(gui.send(BRIEFED_SPAWN.paneId, '/model', 'msg-slash').ok, true)
  assert.deepEqual(sent, [])
  assert.equal(gui.panes.get(BRIEFED_SPAWN.paneId).pendingBriefing, 'MISSION: entrar no app')

  assert.equal(gui.send(BRIEFED_SPAWN.paneId, 'agora sim', 'msg-1').ok, true)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /MISSION: entrar no app/u)
})

test('mensagem recusada pelo teto conserva o briefing para a próxima', () => {
  const { gui, sent } = briefingRegistry()
  assert.equal(gui.create(BRIEFED_SPAWN).ok, true)

  const huge = 'x'.repeat(GUI_PROMPT_MAX_CHARS - 10)
  const refused = gui.send(BRIEFED_SPAWN.paneId, huge, 'msg-huge')
  assert.equal(refused.ok, false)
  assert.match(refused.error, /briefing/u, 'o erro nomeia o problema real')
  assert.deepEqual(sent, [])
  // Nem marco fantasma no fio, nem briefing perdido: recusar é não acontecer.
  const kinds = gui.state(BRIEFED_SPAWN.paneId).events.map(({ evt }) => evt.type)
  assert.equal(kinds.includes('user-message'), false)
  assert.equal(kinds.includes('turn-started'), false)
  assert.equal(gui.panes.get(BRIEFED_SPAWN.paneId).pendingBriefing, 'MISSION: entrar no app')

  assert.equal(gui.send(BRIEFED_SPAWN.paneId, 'curta', 'msg-1').ok, true)
  assert.match(sent[0], /MISSION: entrar no app/u)
})

test('o briefing colado é prefixo do texto do dono, nunca uma moldura', () => {
  const owner = 'começa pela tela de login'
  const outbound = guiBriefedPrompt('MISSION: entrar no app', owner)
  assert.match(outbound, /^MISSION: entrar no app\n/u)
  assert.ok(outbound.endsWith(owner), 'a última linha é a do dono, íntegra')
  assert.match(outbound, /A MENSAGEM DO DONO:/u)
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

// R23.1 — O ■ DO DONO SEMPRE VENCE, também no Codex. Mesmo contrato do Claude:
// estourado o timeout de confirmação (o MESMO de 10s que já existia), o
// processo CAI e a nota no fio diz a RECEITA.
test('R23.1 — Codex que não confirma a interrupção é derrubado com a receita no fio', () => {
  const events = []
  let killed = 0
  const session = Object.create(CodexSession.prototype)
  session.killed = false
  session.closed = false
  session.child = { exitCode: null, signalCode: null }
  session.threadId = 'thread-1'
  session.turnId = 'turn-1'
  session.interruptedTurnId = null
  session.interruptTimer = null
  session.emit = (event) => events.push(event)
  session.kill = () => {
    killed += 1
    session.killed = true
  }
  let requests = 0
  session.request = async () => {
    requests += 1
    return {}
  }

  let fire
  let delay
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (callback, ms) => {
    fire = callback
    delay = ms
    return 1
  }
  try {
    assert.equal(session.interrupt(), true)
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
  assert.equal(requests, 1, 'o turn/interrupt saiu uma vez')
  assert.equal(delay, 10_000, 'o gatilho é o timeout de confirmação de sempre — nenhum relógio novo')
  assert.equal(killed, 0, 'antes do estouro ninguém cai')

  fire()

  assert.equal(killed, 1, 'turno que não prova ter parado leva o processo junto')
  assert.equal(session.turnId, null, 'o turno não fica aberto depois da queda')
  assert.equal(session.interruptedTurnId, null, 'a guarda sai junto')
  const note = events.at(-1)
  assert.equal(note.type, 'fatal')
  assert.match(note.text, /não confirmou a interrupção em 10s e foi derrubado/u)
  assert.match(note.text, /enviar reabre a MESMA conversa/u, 'a nota nomeia a receita')
})

// A guarda que o dono paga: o steer que falha zera `turnId` SEM limpar a guarda
// da interrupção (o caminho da mensagem que fura o turno, R22). No código velho
// o estouro achava o turno trocado e saía em SILÊNCIO — o processo encravado
// ficava de pé, e o ■ do dono virava pedido de licença.
test('R23.1 — turno perdido no meio não veta o ■ do Codex: a queda acontece igual', () => {
  const events = []
  let killed = 0
  const session = Object.create(CodexSession.prototype)
  session.killed = false
  session.closed = false
  session.child = { exitCode: null, signalCode: null }
  session.threadId = 'thread-1'
  session.turnId = null
  session.interruptedTurnId = 'turn-1'
  session.interruptTimer = null
  session.emit = (event) => events.push(event)
  session.kill = () => {
    killed += 1
    session.killed = true
  }

  session.failInterrupt('turn-1', 'não deu para interromper o turno: sem resposta')

  assert.equal(killed, 1, 'processo travado não veta a autoridade do dono')
  assert.equal(session.interruptedTurnId, null, 'a guarda sai junto')
  const note = events.at(-1)
  assert.equal(note.type, 'fatal')
  assert.match(note.text, /não deu para interromper o turno: sem resposta/u)
  assert.match(
    note.text,
    /enviar reabre a MESMA conversa/u,
    'toda queda por interrupção ensina a voltar'
  )
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
    { type: 'context-usage', contextTokens: 1_312, contextWindow: 258_400, sample: null }
  ])
  assert.equal(Math.min(100, Math.round((356_000 / 258_400) * 100)), 100)
  assert.equal(Math.round((events[0].contextTokens / events[0].contextWindow) * 100), 1)

  // Sem `last`/janela, não há uma régua honesta: não reutiliza a medida velha
  // nem cai no `total` só porque ele continua disponível.
  events.length = 0
  session.handleNotification('thread/tokenUsage/updated', {
    tokenUsage: { total: { totalTokens: 400_000 } }
  })
  assert.deepEqual(events, [{ type: 'context-usage', contextTokens: null, contextWindow: null, sample: null }])
  assert.equal(session.lastTokens, undefined)
  assert.equal(session.lastWindow, undefined)

  // Compactar também invalida a fotografia até o protocolo publicar uma nova.
  session.lastTokens = 20_000
  session.lastWindow = 258_400
  events.length = 0
  session.handleNotification('thread/compacted', {})
  assert.deepEqual(events, [
    { type: 'context-compaction', active: false },
    { type: 'context-usage', contextTokens: null, contextWindow: null },
    { type: 'command-output', text: 'contexto da thread compactado' }
  ])
})

test('Codex informa início e fim reais da compactação sem misturar threads ou duplicar eventos', () => {
  assert.equal(isGuiPersistedEvent({ type: 'context-compaction', active: true }), true)
  assert.equal(isGuiPersistedEvent({ type: 'context-compaction', active: false }), true)
  assert.equal(isGuiPersistedEvent({ type: 'context-compaction', active: 'true' }), false)
  assert.equal(isGuiPersistedEvent({ type: 'context-compaction' }), false)
  const { session, events } = codexAgentSession()
  session.threadId = 'synthetic-thread'
  session.turnId = 'synthetic-turn'
  session.lastTokens = 200_000
  session.lastWindow = 258_400
  const params = { threadId: session.threadId, turnId: session.turnId,
    item: { type: 'contextCompaction', id: 'synthetic-compaction' } }
  session.handleNotification('item/started', { ...params, threadId: 'another-thread' })
  assert.deepEqual(events, [])
  session.handleNotification('item/started', params)
  session.handleNotification('item/started', params)
  assert.deepEqual(events, [{ type: 'context-compaction', active: true }])
  session.handleNotification('item/completed', { ...params, turnId: 'another-turn' })
  assert.equal(events.length, 1)
  session.handleNotification('item/completed', params)
  assert.deepEqual(events, [
    { type: 'context-compaction', active: true },
    { type: 'context-compaction', active: false },
    { type: 'context-usage', contextTokens: null, contextWindow: null },
    { type: 'command-output', text: 'contexto da thread compactado' }
  ])
  assert.equal(session.lastTokens, undefined)
  assert.equal(session.lastWindow, undefined)
  session.handleNotification('item/completed', params)
  session.handleNotification('thread/compacted', { threadId: session.threadId, turnId: session.turnId })
  assert.equal(events.length, 4, 'notificação legada não duplica conclusão moderna')
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

// R7-E (mesmo contrato pelo caminho do turn/interrupt do Codex): o ■ do dono
// passou pelo motor para ESTE turno, então o desfecho que chegar é aquela
// interrupção — mesmo que o servidor rotule o turno como `failed`.
test('Codex: turno abortado depois do ■ do dono é interrupção declarada', async () => {
  const { session, events, note } = codexAgentSession()
  session.interruptedTurnId = 'turn-root'
  events.length = 0

  note('turn/completed', {
    threadId: 'thread-root',
    turn: { status: 'failed', error: { message: 'turn aborted' } }
  })
  await new Promise((resolve) => setImmediate(resolve))
  const result = events.at(-1)
  assert.equal(result.type, 'result')
  assert.equal(result.interrupted, true)
  assert.equal(result.isError, false, 'parada pedida pelo dono não é falha')
  assert.equal(result.outcome, 'cancelled')
  assert.equal(result.errorText, 'interrompido pelo dono')
  assert.equal(session.interruptedTurnId, null, 'a guarda da interrupção some com o turno')

  // O ■ que chega ANTES do turno abrir fala a mesma língua: o early-return do
  // startTurn (interruptedStartGeneration) também declara a interrupção.
  const codex = readFileSync(new URL('../src/main/codexSession.ts', import.meta.url), 'utf8')
  const preStart = codex.slice(
    codex.indexOf('if (this.interruptedStartGeneration === pending.generation) {')
  )
  assert.ok(preStart, 'o early-return da interrupção pré-turno precisa existir')
  assert.match(preStart.slice(0, 700), /interrupted: true/u)
})

test('Codex: turno que falha sem ■ do dono mantém a falha de hoje', async () => {
  const { session, events, note } = codexAgentSession()
  events.length = 0
  note('turn/completed', {
    threadId: 'thread-root',
    turn: { status: 'failed', error: { message: 'boom' } }
  })
  await new Promise((resolve) => setImmediate(resolve))
  const result = events.at(-1)
  assert.equal(result.interrupted, undefined, 'sem ■ do dono nada é declarado')
  assert.equal(result.isError, true)
  assert.equal(result.outcome, 'failed')
  assert.equal(result.errorText, 'boom')
  assert.equal(session.turnId, null)
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

// R23.1 — O ■ DO DONO SEMPRE VENCE (incidente do dono, 2026-08-19 23:16): o CLI
// encravou com o turno aberto e DOIS ■ ficaram sem confirmação. Estourado o
// timeout de confirmação — o MESMO de 10s que já existia, NENHUM relógio novo —
// o processo encravado CAI e a nota no fio diz a RECEITA. O ACK (R7-E) segue
// exatamente como era: sem queda e sem nota.
test('R23.1 — Claude que não confirma a interrupção é derrubado com a receita no fio', () => {
  const armed = () => {
    const session = Object.create(MaestroSession.prototype)
    session.opts = { cwd: '/tmp' }
    session.killed = false
    session.closed = false
    session.child = { exitCode: null, signalCode: null }
    session.claudeTasks = new GuiClaudeTaskRegistry()
    session.activeTurnGeneration = 5
    session.pendingTurnGenerations = [5]
    session.interruptGeneration = null
    session.interruptRequestId = null
    session.interruptTimer = null
    return session
  }

  const events = []
  let killed = 0
  const writes = []
  const session = armed()
  session.emit = (event) => events.push(event)
  session.kill = () => {
    killed += 1
    session.killed = true
  }
  session.write = (obj) => writes.push(obj)

  let fire
  let delay
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (callback, ms) => {
    fire = callback
    delay = ms
    return 1
  }
  try {
    assert.equal(session.interrupt(), true)
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
  assert.equal(writes.at(-1).request.subtype, 'interrupt')
  assert.equal(delay, 10_000, 'o gatilho é o timeout de confirmação de sempre — nenhum relógio novo')
  assert.equal(killed, 0, 'antes do estouro ninguém cai')

  fire()

  assert.equal(killed, 1, 'processo travado não veta a autoridade do dono: ele CAI')
  assert.equal(session.activeTurnGeneration, null, 'o turno não fica aberto depois da queda')
  assert.equal(session.interruptGeneration, null, 'a guarda sai junto')
  const note = events.at(-1)
  assert.equal(note.type, 'fatal')
  assert.match(note.text, /não confirmou a interrupção em 10s e foi derrubado/u)
  assert.match(note.text, /enviar reabre a MESMA conversa/u, 'a nota nomeia a receita')

  // R7-E INTACTO: com o ACK do Claude nada cai e nada é escrito no fio.
  const confirmedEvents = []
  let confirmedKills = 0
  const confirmed = armed()
  confirmed.emit = (event) => confirmedEvents.push(event)
  confirmed.kill = () => {
    confirmedKills += 1
  }
  confirmed.write = () => undefined
  confirmed.interruptGeneration = 5
  confirmed.interruptRequestId = 'req-ack'
  confirmed.handleLine(
    JSON.stringify({
      type: 'control_response',
      response: { request_id: 'req-ack', subtype: 'success' }
    })
  )
  assert.equal(confirmedKills, 0, 'interrupção confirmada não derruba processo nenhum')
  assert.deepEqual(confirmedEvents, [], 'confirmada não escreve nota nenhuma')
  assert.equal(confirmed.activeTurnGeneration, 5, 'o turno segue até o result do CLI')
})

// A autoridade é estrutural: mesmo com o turno perdido no meio (estado que
// hoje nenhum caminho do claude produz sozinho — o par REAL mora no steer
// falho do codex), a queda acontece. No código velho o estouro achava o turno
// trocado e saía em SILÊNCIO — o processo encravado ficava de pé.
test('R23.1 — turno perdido no meio não veta o ■ do Claude: a queda acontece igual', () => {
  const events = []
  let killed = 0
  const session = Object.create(MaestroSession.prototype)
  session.opts = { cwd: '/tmp' }
  session.killed = false
  session.closed = false
  session.child = { exitCode: null, signalCode: null }
  session.claudeTasks = new GuiClaudeTaskRegistry()
  session.activeTurnGeneration = null
  session.pendingTurnGenerations = []
  session.interruptGeneration = 5
  session.interruptRequestId = 'req-5'
  session.interruptTimer = null
  session.emit = (event) => events.push(event)
  session.kill = () => {
    killed += 1
    session.killed = true
  }

  session.failInterrupt(5, 'o Claude recusou a interrupção')

  assert.equal(killed, 1, 'processo travado não veta a autoridade do dono')
  assert.equal(session.interruptGeneration, null, 'a guarda sai junto')
  const note = events.at(-1)
  assert.equal(note.type, 'fatal')
  assert.match(note.text, /o Claude recusou a interrupção/u)
  assert.match(
    note.text,
    /enviar reabre a MESMA conversa/u,
    'toda queda por interrupção ensina a voltar'
  )
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
      resumed: true,
      contextTokens: 4_200,
      contextWindow: 200_000
    },
    'o restart carrega o contexto antes de qualquer nova mensagem'
  )
})

// REGRESSÃO 2026-08-15 (relato do dono: "saí do app e voltei, e minha mensagem
// duplicou"). O id do item do chat é a chave do React na lista E o messageId do
// gui:send. Ele era cunhado por um contador de PROCESSO no renderer, que voltava
// a zero em todo boot: a hidratação re-cunhava ids que o transcript persistido
// ainda guardava. Este round-trip usa o cunhador REAL do renderer nos dois lados
// do restart — ele é a fronteira que a fotografia atravessa.
test('round-trip de persistência: a mensagem do dono aparece exatamente uma vez após reabrir o app', async (t) => {
  for (const cli of ['claude', 'codex']) {
    // Cada import com query própria é uma INSTÂNCIA nova do cunhador — é assim
    // que se reproduz o boot do renderer, que era exatamente o que zerava a
    // sequência e fazia a geração nova repetir os ids da fotografia.
    const bootA = await import(`../src/renderer/src/guiItemIdentity.ts?pane=${cli}-a`)
    const bootB = await import(`../src/renderer/src/guiItemIdentity.ts?pane=${cli}-b`)
    const root = mkdtempSync(join(tmpdir(), `synkora-gui-dupe-${cli}-`))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const storeFile = join(root, 'gui-sessions.json')
    const spawn = {
      paneId: `gui-dev-dupe-${cli}`,
      projectId: 'proj-dupe',
      cli,
      configDir: 'c',
      cwd: '/tmp'
    }

    // ————— boot 1: o dono manda a mensagem —————
    let emit
    const first = new GuiSessionRegistry({
      push: () => undefined,
      systemPromptFile: () => undefined,
      storeFile
    })
    first.spawnSession = (_input, sink) => {
      emit = sink
      return {
        alive: true,
        turnActive: false,
        waitCaps: async () => ({ commands: [], models: [] }),
        send: () => undefined,
        kill: () => undefined
      }
    }
    assert.equal(first.create(spawn).ok, true)
    emit({
      type: 'init',
      model: cli,
      sessionId: 'sess-dupe',
      permissionMode: 'default',
      toolCount: 0,
      contextWindow: 200_000
    })
    emit({ type: 'ready', caps: { commands: [], models: [] } })

    const firstBootId = bootA.guiItemId()
    assert.equal(
      guiMessageIdProblem(firstBootId),
      null,
      'o id cunhado no renderer precisa passar na régua de messageId do main'
    )
    assert.equal(first.send(spawn.paneId, 'De novo.', firstBootId).ok, true)
    emit({ type: 'delta', text: 'Pronto' })
    emit({ type: 'text', text: 'Pronto' })
    emit({ type: 'result', isError: false, outcome: 'completed' })
    assert.equal(first.kill(spawn.paneId).ok, true)

    // ————— boot 2: processo novo lê a fotografia do disco —————
    const second = new GuiSessionRegistry({
      push: () => undefined,
      systemPromptFile: () => undefined,
      storeFile
    })
    const delivered = []
    second.spawnSession = (_input, sink) => {
      sink({
        type: 'init',
        model: cli,
        sessionId: 'sess-dupe',
        permissionMode: 'default',
        toolCount: 0,
        contextWindow: 200_000
      })
      sink({ type: 'ready', caps: { commands: [], models: [] } })
      return {
        alive: true,
        turnActive: false,
        waitCaps: async () => ({ commands: [], models: [] }),
        send: (prompt) => delivered.push(prompt),
        kill: () => undefined
      }
    }
    assert.equal(
      second.create({ ...spawn, resumeSessionId: second.remembered(spawn.paneId).sessionId }).ok,
      true
    )

    const hydrated = second.state(spawn.paneId)
    const owner = hydrated.events.filter(({ evt }) => evt.type === 'user-message')
    assert.equal(
      owner.length,
      1,
      `[${cli}] a fala do dono não pode voltar duplicada da fotografia`
    )
    assert.equal(owner[0].evt.text, 'De novo.')

    // O id da geração NOVA nunca pode coincidir com o da geração persistida:
    // repetido, ele viraria chave duplicada no React e cairia no messageIds
    // restaurado — o main responderia ok e engoliria a mensagem em silêncio.
    const secondBootId = bootB.guiItemId()
    assert.notEqual(
      secondBootId,
      firstBootId,
      `[${cli}] boot novo não pode re-cunhar o id que a fotografia ainda guarda`
    )
    const persistedIds = new Set(owner.map(({ evt }) => evt.id))
    assert.equal(
      persistedIds.has(secondBootId),
      false,
      `[${cli}] id novo colidindo com o transcript hidratado engole a mensagem seguinte`
    )

    assert.equal(second.send(spawn.paneId, 'Segunda pergunta', secondBootId).ok, true)
    assert.deepEqual(
      delivered,
      ['Segunda pergunta'],
      `[${cli}] a mensagem enviada depois do restart precisa CHEGAR no CLI`
    )
    const afterSecond = second.state(spawn.paneId)
    assert.equal(
      afterSecond.events.filter(({ evt }) => evt.type === 'user-message').length,
      2,
      `[${cli}] duas falas distintas do dono, nenhuma repetida`
    )

    // A idempotência do main continua de pé: o MESMO id não entra duas vezes.
    assert.equal(second.send(spawn.paneId, 'De novo.', firstBootId).ok, true)
    assert.equal(
      second.state(spawn.paneId).events.filter(({ evt }) => evt.type === 'user-message').length,
      2,
      `[${cli}] reenvio do id já entregue continua sendo no-op`
    )
    assert.deepEqual(delivered, ['Segunda pergunta'])
  }
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
    { type: 'session-restarted', ready: false, resumed: false },
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

test('nova conversa — o menu anuncia comandos locais sem duplicar os do CLI', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-new-chat-menu-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const gui = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    storeFile: join(root, 'sessions.json')
  })
  const caps = {
    commands: [
      { name: '/new', description: 'opens another chat' },
      { name: 'clear', description: 'clear the terminal' },
      { name: 'compact', description: 'compact context' },
      { name: 'my-skill', description: 'custom skill' }
    ],
    models: [{ value: 'model-test', displayName: 'Modelo de teste' }]
  }
  gui.spawnSession = (_spawn, sink) => {
    sink({ type: 'ready', caps })
    return { alive: true, kill: () => undefined }
  }
  gui.create({ paneId: 'p-menu', projectId: 'project-test', cli: 'codex', configDir: root, cwd: root })
  const ready = gui.state('p-menu').events.find(({ evt }) => evt.type === 'ready').evt
  const names = ready.caps.commands.map(({ name }) => name.replace(/^\//u, ''))
  for (const name of ['new', 'reset', 'clear']) {
    assert.equal(names.filter((item) => item === name).length, 1)
    assert.match(ready.caps.commands.find((c) => c.name === name).description, /mesm[ao] (missão|chat)/u)
  }
  assert.ok(names.includes('compact'))
  assert.ok(names.includes('my-skill'))
  assert.deepEqual(ready.caps.models, caps.models)
  assert.equal(caps.commands[0].description, 'opens another chat', 'caps do motor não são mutadas')
  gui.kill('p-menu')
  const reopened = new GuiSessionRegistry({
    push: () => undefined, systemPromptFile: () => undefined, storeFile: join(root, 'sessions.json')
  })
  assert.deepEqual(reopened.state('p-menu').events.find(({ evt }) => evt.type === 'ready').evt.caps, ready.caps)
})

test('nova conversa — argumentos, texto multilinha e comandos parecidos não apagam o contexto', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-new-chat-arguments-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let spawns = 0
  const messages = []
  const gui = new GuiSessionRegistry({
    push: () => undefined, systemPromptFile: () => undefined, storeFile: join(root, 'sessions.json')
  })
  gui.spawnSession = (_spawn, sink) => {
    spawns += 1
    sink({ type: 'ready', caps: { commands: [], models: [] } })
    return { alive: true, turnActive: false, send: (text) => messages.push(text), kill: () => undefined }
  }
  gui.create({ paneId: 'p-args', projectId: 'project-test', cli: 'claude', configDir: root, cwd: root })
  for (const text of ['/new chat agora', '/reset agora', '/clear agora', '/new\nchat']) {
    const result = gui.send('p-args', text)
    assert.equal(result.ok, false, 'argumento extra recebe uma receita, não um reset')
    assert.match(result.error, /envie \/new/u)
  }
  for (const text of ['Explique /new chat', '/new-feature', '```\n/new\n```']) {
    assert.equal(gui.send('p-args', text).ok, true)
  }
  assert.equal(spawns, 1)
  assert.deepEqual(messages, ['Explique /new chat', '/new-feature', '```\n/new\n```'])
})

for (const cli of ['codex', 'claude']) {
  for (const command of ['/new', '/new chat', '/reset', '/clear']) {
    test(`nova conversa — ${cli} ${command} reinicia somente o contexto na mesma missão`, (t) => {
      const root = mkdtempSync(join(tmpdir(), 'synkora-new-chat-'))
      t.after(() => rmSync(root, { recursive: true, force: true }))
      const storeFile = join(root, 'sessions.json')
      const projectFile = join(root, 'work-in-progress.txt')
      writeFileSync(projectFile, 'trabalho preservado', 'utf8')
      const spawns = []
      const sinks = []
      const messages = []
      let killed = 0
      const gui = new GuiSessionRegistry({
        push: () => undefined, systemPromptFile: () => undefined, storeFile
      })
      gui.spawnSession = (spawn, sink) => {
        spawns.push({ ...spawn })
        sinks.push(sink)
        sink({ type: 'init', model: cli, sessionId: `session-${spawns.length}`, permissionMode: 'default', toolCount: 0 })
        sink({ type: 'ready', caps: { commands: [], models: [] } })
        return {
          alive: true, turnActive: false,
          send: (text) => messages.push(text), kill: () => { killed += 1 }
        }
      }
      const spawn = {
        paneId: 'gui-dev-newchat', projectId: 'project-test', cli,
        configDir: root, cwd: root, seatId: 'seat-test', model: 'model-test',
        effort: 'high', systemPrompt: 'contrato da missão', permissionMode: 'default', fast: true,
        resumeSessionId: 'session-old', firstPrompt: 'briefing inicial antigo'
      }
      assert.equal(gui.create(spawn).ok, true)
      assert.equal(gui.send(spawn.paneId, 'assunto antigo', 'old-message').ok, true)
      sinks[0]({ type: 'text', text: 'resposta antiga' })
      sinks[0]({ type: 'result', isError: false, contextTokens: 180_000, contextWindow: 200_000 })
      const cursor = gui.state(spawn.paneId).cursor
      assert.equal(gui.send(spawn.paneId, command, 'new-chat-command').ok, true)
      assert.equal(spawns.length, 2, 'abre um novo motor no mesmo pane')
      assert.equal(killed, 1)
      assert.deepEqual(spawns[1], { ...spawn, resumeSessionId: undefined, firstPrompt: undefined })
      assert.equal(gui.remembered(spawn.paneId).sessionId, 'session-2')
      assert.equal(gui.remembered(spawn.paneId).contextTokens, undefined)
      sinks[0]({ type: 'text', text: 'resposta atrasada da conversa anterior' })
      const fresh = gui.state(spawn.paneId)
      assert.ok(fresh.cursor > cursor)
      assert.equal(fresh.events.some(({ evt }) => ['text', 'user-message'].includes(evt.type)), false)
      assert.ok(fresh.events.some(({ evt }) => evt.type === 'command-output' && /Ctrl\+K/u.test(evt.text)), 'explica como consultar o histórico')
      assert.equal(gui.send(spawn.paneId, 'continue pelo arquivo', 'fresh-message').ok, true)
      assert.deepEqual(messages, [guiBriefedPrompt('briefing inicial antigo', 'assunto antigo'), 'continue pelo arquivo'])
      assert.equal(readFileSync(projectFile, 'utf8'), 'trabalho preservado')
      const reopened = new GuiSessionRegistry({ push: () => undefined, systemPromptFile: () => undefined, storeFile })
      assert.equal(reopened.remembered(spawn.paneId).sessionId, 'session-2')
      assert.equal(reopened.state(spawn.paneId).events.some(({ evt }) => evt.type === 'text'), false)
    })
  }
}

test('Codex cancellation needs the matching interrupted terminal and excludes already-read messages', async () => {
  const { session, events, note } = codexAgentSession()
  session.child.exitCode = null
  session.steerTags = new Map([['native-target', 'cancel-target'], ['native-read', 'already-read']])
  session.cancelledSteerIds = new Set()
  session.request = async () => ({ result: {} })
  assert.equal(session.cancelQueuedMessages(), true)
  session.noteOwnerSteerEcho({ type: 'userMessage', clientId: 'native-read' })
  note('turn/completed', { threadId: 'different-thread', turn: { id: 'turn-root', status: 'interrupted' } })
  assert.equal(events.some(event => event.type === 'owner-steer-rejected'), false)
  note('turn/completed', { threadId: 'thread-root', turn: { id: 'earlier-turn', status: 'interrupted' } })
  assert.equal(session.turnId, 'turn-root', 'a previous terminal cannot consume this cancellation')
  assert.equal(session.cancelQueuedTurnId, 'turn-root')
  note('turn/completed', { threadId: 'thread-root', turn: { id: 'turn-root', status: 'interrupted' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events.filter(event => event.type === 'owner-steer-rejected'), [
    { type: 'owner-steer-rejected', tag: 'cancel-target', reason: 'cancelled' }
  ])
  assert.equal(session.steerTags.size, 0)
  assert.equal(session.turnActive, false)
})

test('Codex cannot recreate cancelled guidance when an in-flight steer RPC is rejected late', async () => {
  const { session, events, note } = codexAgentSession()
  session.child.exitCode = null
  session.steerTags = new Map()
  session.cancelledSteerIds = new Set()
  session.resetIdle = () => undefined
  let releaseSteer
  const calls = []
  session.request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'turn/steer') return new Promise(resolve => { releaseSteer = resolve })
    return { result: {} }
  }
  session.pendingSendOperations.add(1)
  const sending = session.startTurn('orientação sintética retirada', 1, 'cancel-target')
  assert.equal(session.cancelQueuedMessages(), true)
  note('turn/completed', { threadId: 'thread-root', turn: { id: 'turn-root', status: 'interrupted' } })
  releaseSteer({ error: { message: 'previous turn ended' } })
  await sending
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.some(call => call.method === 'turn/start'), false, 'late RPC failure cannot replay a cancelled message in a new turn')
  assert.ok(events.some(event => event.type === 'owner-steer-rejected' && event.tag === 'cancel-target'))
  assert.equal(session.pendingSendOperations.size, 0)
})

// RECIBO DO CLIQUE DO DONO CHEGA AO MODELO SEM VIRAR FALA DELE.
//
// O caso real (2026-08-17): aprovar o plano injetava o recibo pelo `send`, e o
// fio ganhava uma bolha "VOCÊ" com "[synkora] o dono APROVOU o plano … (id
// 7941e8da-…)". O dono aparecia dizendo o que nunca disse — e a decisão dele já
// estava no fio como nota.

test('o recibo vai ao modelo e não deixa bolha do dono no fio', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-gui-announce-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sent = []
  const gui = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    storeFile: join(root, 'gui-sessions.json')
  })
  gui.spawnSession = (_input, sink) => {
    sink({ type: 'ready', caps: { commands: [], models: [] } })
    return { alive: true, send: (text) => sent.push(text), kill: () => undefined }
  }
  const paneId = 'gui-dev-receipt1'
  assert.equal(
    gui.create({ paneId, projectId: 'p', cli: 'claude', configDir: 'c', cwd: root }).ok,
    true
  )

  assert.equal(gui.announce(paneId, 'O dono APROVOU o plano "V1.0".').ok, true)
  assert.deepEqual(sent, ['O dono APROVOU o plano "V1.0".'], 'o modelo VÊ o recibo')

  const kinds = gui.state(paneId).events.map(({ evt }) => evt.type)
  assert.equal(
    kinds.includes('user-message'),
    false,
    'recibo do app nunca vira mensagem do dono no transcript'
  )
  assert.equal(kinds.includes('turn-started'), true, 'um turno REAL começa — o composer sabe')
})

test('recibo em pane sem sessão viva é recusado em PT-BR, não some', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-gui-announce-dead-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const gui = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    storeFile: join(root, 'gui-sessions.json')
  })
  assert.deepEqual(gui.announce('gui-dev-ausente', 'oi'), {
    ok: false,
    error: 'este pane não tem sessão aberta'
  })

  gui.spawnSession = (_input, sink) => {
    sink({ type: 'ready', caps: { commands: [], models: [] } })
    return { alive: false, send: () => undefined, kill: () => undefined }
  }
  const paneId = 'gui-dev-receipt2'
  gui.create({ paneId, projectId: 'p', cli: 'claude', configDir: 'c', cwd: root })
  assert.equal(gui.announce(paneId, 'oi').error, 'a sessão deste pane encerrou')
})

// FERRAMENTAS DO PLANEJADOR ATRAVESSAM O RESPAWN (bug ao vivo de 2026-08-17).
//
// O caso real: o dono trocou o chat de planejamento para "acesso completo" e a
// conversa morreu com `Invalid MCP configuration: MCP config file not found`.
// A cadeia: trocar o modo muda o fingerprint → `create` disposa → o teardown
// (ipc/gui.ts) apaga o arquivo de config e revoga o token → o processo novo
// nascia com `--mcp-config <arquivo apagado>` e o claude saía com exit 1.
//
// O harness abaixo espelha os dois lados dessa costura: um teardown que revoga
// de verdade e um re-arme que reescreve de verdade. O que ele prende é o
// INSTANTE DO SPAWN — o que o processo encontraria no disco.

/** Registro com token+arquivo por pane, como o main os mantém de verdade. */
function plannerToolsHarness(t, paneId) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-gui-rearm-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const mcpRoot = join(root, 'mcp')
  mkdirSync(mcpRoot, { recursive: true })
  const configFile = join(mcpRoot, `${paneId}.json`)
  const live = new Map()
  let minted = 0
  /** O mesmo par do armGuiPlannerMcp: token novo + arquivo reescrito nele. */
  const arm = () => {
    const token = `token-${++minted}`
    live.set(paneId, token)
    writeFileSync(configFile, JSON.stringify({ bearer: token }), 'utf8')
    return { args: ['--mcp-config', configFile, '--strict-mcp-config'] }
  }
  /** O mesmo teardown do ipc/gui.ts: revoga o token e apaga o arquivo. */
  const teardown = () => {
    live.delete(paneId)
    rmSync(configFile, { force: true })
  }
  const spawned = []
  /** Fotografia do que o CLI encontraria: existe? o token bate com o vivo? */
  const observeSpawn = (input) => {
    const args = input.mcp?.args ?? []
    const at = args.indexOf('--mcp-config')
    const file = at >= 0 ? args[at + 1] : undefined
    const exists = Boolean(file) && existsSync(file)
    spawned.push({
      hasTools: Boolean(input.mcp),
      file,
      exists,
      tokenMatchesLive:
        exists && JSON.parse(readFileSync(file, 'utf8')).bearer === live.get(paneId)
    })
  }
  return { root, configFile, live, arm, teardown, spawned, observeSpawn }
}

function plannerRegistry(harness, opts = {}) {
  const gui = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    storeFile: join(harness.root, 'gui-sessions.json'),
    onPaneDisposed: () => harness.teardown(),
    ...(opts.withoutRearm ? {} : { rearmPaneTools: () => harness.arm() })
  })
  gui.spawnSession = (input, sink) => {
    harness.observeSpawn(input)
    sink({
      type: 'init',
      model: 'claude',
      sessionId: `session-${harness.spawned.length}`,
      permissionMode: input.permissionMode ?? 'default',
      toolCount: 5,
      contextWindow: 1_000_000
    })
    return {
      alive: true,
      turnActive: false,
      send: () => undefined,
      waitCaps: async () => ({ commands: [], models: [] }),
      kill: () => undefined
    }
  }
  return gui
}

test('trocar o modo de permissão do planejador não deixa o processo novo sem ferramentas', (t) => {
  const paneId = 'gui-dev-planner1'
  const h = plannerToolsHarness(t, paneId)
  const gui = plannerRegistry(h)
  const spawn = {
    paneId,
    projectId: 'proj-planner',
    cli: 'claude',
    configDir: 'seat-a',
    cwd: h.root,
    // o que o renderer devolve: o eco do que o `missions:guiSpec` armou
    mcp: h.arm()
  }

  assert.equal(gui.create(spawn).ok, true)
  assert.equal(h.spawned[0].exists, true, 'o nascimento já vinha certo')

  // O CLIQUE DO DONO: "acesso completo". Mesmo spawn, modo novo.
  assert.equal(gui.create({ ...spawn, permissionMode: 'bypass' }).ok, true)
  assert.equal(h.spawned.length, 2, 'trocar o modo TEM de respawnar')
  assert.equal(h.spawned[1].hasTools, true, 'o pane do planejador não perde o servidor')
  assert.equal(
    h.spawned[1].exists,
    true,
    'o processo novo nunca pode nascer apontando para o arquivo que o teardown apagou'
  )
  assert.equal(
    h.spawned[1].tokenMatchesLive,
    true,
    'o token no arquivo é o que o hub reconhece agora — arquivo velho autenticaria em nada'
  )
  assert.equal(existsSync(h.configFile), true)
})

test('/clear do planejador também renasce com as ferramentas', (t) => {
  const paneId = 'gui-dev-planner2'
  const h = plannerToolsHarness(t, paneId)
  const gui = plannerRegistry(h)
  const spawn = {
    paneId,
    projectId: 'proj-planner',
    cli: 'claude',
    configDir: 'seat-a',
    cwd: h.root,
    mcp: h.arm()
  }
  assert.equal(gui.create(spawn).ok, true)
  assert.equal(gui.send(paneId, '/clear', 'msg-clear').ok, true)
  assert.equal(h.spawned.length, 2, '/clear troca o processo')
  assert.equal(h.spawned[1].exists, true, 'conversa nova, ferramentas de pé')
  assert.equal(h.spawned[1].tokenMatchesLive, true)
})

test('pane que pediu ferramentas e não pôde receber sai anotado, nunca mudo', (t) => {
  const paneId = 'gui-dev-planner3'
  const h = plannerToolsHarness(t, paneId)
  const recorded = []
  // Re-arme que RECUSA (servidor fora do ar / pane que não é o planejador).
  const gui = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    storeFile: join(h.root, 'gui-sessions.json'),
    record: (event, ids, detail) => recorded.push({ event, ...ids, ...detail }),
    onPaneDisposed: () => h.teardown(),
    rearmPaneTools: () => undefined
  })
  gui.spawnSession = (input, sink) => {
    h.observeSpawn(input)
    sink({ type: 'ready', caps: { commands: [], models: [] } })
    return { alive: true, kill: () => undefined, send: () => undefined }
  }
  assert.equal(
    gui.create({
      paneId,
      projectId: 'proj-planner',
      cli: 'claude',
      configDir: 'seat-a',
      cwd: h.root,
      mcp: h.arm()
    }).ok,
    true
  )
  assert.equal(h.spawned[0].hasTools, false, 'sem re-arme o spawn sai limpo, não quebrado')
  assert.equal(
    recorded.some((entry) => entry.event === 'gui-pane-tools-unarmed' && entry.paneId === paneId),
    true,
    'o diário nomeia o pane que ficou sem ferramentas'
  )
})

test('sem o gancho de re-arme o registro não opina sobre as ferramentas do spawn', (t) => {
  const paneId = 'gui-dev-planner4'
  const h = plannerToolsHarness(t, paneId)
  const gui = plannerRegistry(h, { withoutRearm: true })
  const mcp = h.arm()
  assert.equal(
    gui.create({
      paneId,
      projectId: 'proj-planner',
      cli: 'claude',
      configDir: 'seat-a',
      cwd: h.root,
      mcp
    }).ok,
    true
  )
  assert.equal(h.spawned[0].file, mcp.args[1], 'o spawn vai exatamente como veio')
  assert.equal(h.spawned[0].hasTools, true)
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
    ready: true,
    resumed: false
  })
  assert.deepEqual(gui.state(spawn.paneId).events.at(-1).evt, {
    type: 'executor-changed',
    model: null,
    effort: null
  })
  assert.match(gui.state(spawn.paneId).events[0].evt.text, /falha transitória/u)
})

// R12/A4 — o carimbo que deixa o renderer distinguir "a conversa continua" de
// "nasceu outra". O sinal já existia dentro do registro (`sameConversation`, o
// mesmo que deixa a fotografia de contexto atravessar a barreira); sem dizê-lo
// em voz alta, todo respawn — inclusive o clique no ⚡ — se lia como abertura.
test('o restart carimba `resumed`: só a MESMA conversa retomada é quieta', () => {
  const gui = registry()
  const spawn = {
    paneId: 'p-resumed',
    projectId: 'proj-resumed',
    cli: 'claude',
    configDir: 'c',
    cwd: '/tmp'
  }
  gui.spawnSession = (_input, sink) => {
    sink({
      type: 'init',
      model: 'claude',
      sessionId: 'sess-viva',
      permissionMode: 'default',
      toolCount: 0
    })
    sink({ type: 'ready', caps: { commands: [], models: [] } })
    return { alive: true, kill: () => undefined }
  }
  assert.equal(gui.create(spawn).ok, true)
  assert.equal(gui.remembered(spawn.paneId).sessionId, 'sess-viva')

  // O CLIQUE NO ⚡: fast é flag de SPAWN, então o fingerprint muda e o pane
  // respawna herdando a mesma conversa — é exatamente este o restart que não
  // pode reapresentar o chat inteiro.
  assert.equal(gui.create({ ...spawn, fast: true }).ok, true)
  const quiet = gui.state(spawn.paneId).events.filter(({ evt }) => evt.type === 'session-restarted')
  assert.equal(quiet.at(-1).evt.resumed, true)

  // Ter resume não basta: identidade DIFERENTE é geração nova, e ali o
  // renderer tem de reapresentar (caps, executor e medidor zerados).
  assert.equal(gui.create({ ...spawn, fast: true, resumeSessionId: 'sess-de-outra' }).ok, true)
  const fresh = gui.state(spawn.paneId).events.filter(({ evt }) => evt.type === 'session-restarted')
  assert.equal(fresh.at(-1).evt.resumed, false)
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

test('o teto de 50 MB recusa em PT-BR e nomeia o limite', () => {
  assert.equal(GUI_ATTACHMENT_MAX_BYTES, 50 * 1024 * 1024)
  const msg = attachmentTooLargeError(50.5 * 1024 * 1024)
  assert.match(msg, /50,5 MB/, 'tamanho do arquivo com vírgula decimal')
  assert.match(msg, /50,0 MB/, 'a mensagem diz qual é o limite')
  assert.match(msg, /grande demais/, 'texto de UI em PT-BR, não jargão em inglês')
})

test('50 MB text attachment validates transport, persists and resolves only a path for the agent', () => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-attachment-limit-'))
  try {
    const size = 50 * 1024 * 1024
    const bytes = Buffer.alloc(size, 'x')
    const encoded = bytes.toString('base64')
    assert.equal(attachPayloadProblem({ kind: 'file', name: 'synthetic.txt', bytesBase64: encoded }), undefined)
    assert.match(attachmentBase64Problem(`${encoded.slice(0, -1)}A`), /50,0 MB/u,
      'one extra decoded byte is refused even when the base64 string has the same length')
    const dir = prepareGuiAttachmentDirectory(root)
    const path = writeGuiAttachmentExclusive(dir, 'synthetic.txt', bytes)
    const capabilityFile = join(root, 'capabilities.json')
    const capabilities = new GuiAttachmentCapabilityStore(capabilityFile)
    const descriptor = capabilities.issue('large-pane', { path, kind: 'file', mime: 'text/plain', size })
    const reloaded = new GuiAttachmentCapabilityStore(capabilityFile)
    const checked = validateGuiAttachmentReferences(root, 'large-pane', [descriptor], reloaded)
    assert.equal(checked.ok, true, checked.error)
    const prompt = withGuiAttachmentReferences('Confira o documento.', checked.resolved)
    assert.ok(prompt.includes(path))
    assert.ok(prompt.length < 1024, 'the 50 MB file is never expanded into the prompt')
    assert.equal(checked.resolved[0].bytes.length, size)
    assert.equal(validateGuiAttachmentReferences(root, 'other-pane', [descriptor], reloaded).ok, false)
    const tooLarge = { ...descriptor, size: size + 1 }
    assert.equal(isGuiAttachmentDescriptor(tooLarge), false)
    assert.equal(validateGuiAttachmentReferences(root, 'large-pane', [tooLarge], reloaded).ok, false)
    appendFileSync(path, 'x')
    const changed = validateGuiAttachmentReferences(root, 'large-pane', [descriptor], reloaded)
    assert.equal(changed.ok, false)
    assert.match(changed.error, /50/u, 'the send boundary rechecks the physical size')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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

test('TXT em codificações legadas abre sem invalidar anexos já enviados', () => {
  const samples = [
    Buffer.from('|0000|ESCRITURAÇÃO SINTÉTICA|\r\n', 'latin1'),
    Buffer.from([0x93, 0x61, 0x94, 0x20, 0x80, 0x0d, 0x0a]),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Texto sintético\r\n', 'utf16le')]),
    Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('Texto sintético\r\n', 'utf16le').swap16()])
  ]
  const root = mkdtempSync(join(tmpdir(), 'synkora-text-open-'))
  try {
    const directory = prepareGuiAttachmentDirectory(root)
    const storeFile = join(root, 'capabilities.json')
    const capabilities = new GuiAttachmentCapabilityStore(storeFile)
    for (const [index, bytes] of samples.entries()) {
      const path = join(directory, `synthetic-${index}.TXT`)
      writeFileSync(path, bytes)
      const descriptor = capabilities.issue('text-pane', {
        path, kind: 'file', mime: 'application/octet-stream', size: bytes.length
      })
      const restored = new GuiAttachmentCapabilityStore(storeFile)
      const checked = validateGuiAttachmentReferences(root, 'text-pane', [descriptor], restored)
      assert.equal(checked.ok, true)
      assert.deepEqual(checked.attachments, [descriptor], 'metadados persistidos continuam válidos')
      const attachment = checked.resolved[0]
      assert.deepEqual(attachment.bytes, bytes, 'abrir não converte nem regrava o original')
      assert.equal(guiAttachmentOpenProblem(attachment.name, attachment.mime, attachment.bytes), undefined)
      assert.equal(validateGuiAttachmentReferences(root, 'another-pane', [descriptor], restored).ok, false)
      assert.equal(validateGuiAttachmentReferences(root, 'text-pane', [{ ...descriptor, mime: 'text/plain' }], restored).ok, false)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('abrir TXT ainda recusa binários, texto malformado e extensões ativas', () => {
  for (const bytes of [
    Buffer.from([0x4d, 0x5a, 0, 1]), Buffer.from([0x50, 0x4b, 3, 4]),
    Buffer.from([0x61, 0x00, 0x62]), Buffer.from([0x61, 0x81, 0x62]),
    Buffer.from([0xff, 0xfe, 0x61]), Buffer.from([0xff, 0xfe, 0x00, 0xd8]),
    Buffer.from([0xff, 0xfe, 0x00, 0x00])
  ]) assert.ok(guiAttachmentOpenProblem('synthetic.txt', 'application/octet-stream', bytes))
  assert.ok(guiAttachmentOpenProblem('synthetic.txt', 'application/octet-stream'))
  for (const name of ['synthetic.exe', 'synthetic.ps1', 'synthetic.html', 'synthetic.svg', 'synthetic.bin']) {
    assert.ok(guiAttachmentOpenProblem(name, 'application/octet-stream', Buffer.from('Texto sintético', 'latin1')))
  }
  assert.equal(guiAttachmentOpenProblem('synthetic.txt', 'text/plain', Buffer.from('Texto UTF-8')), undefined)
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

// ————— janela de contexto REAL por modelo (Claude) —————
// Sondado em scripts/probe-claude-caps-context.mjs (claude 2.1.233, 2026-08-15):
// o handshake NÃO informa janela por modelo, o `model` do system/init vem
// RESOLVIDO (e `claude-fable-5[1m]` chega como `claude-fable-5`, sem o sufixo),
// e a janela REAL mora em `result.modelUsage[<modelo>].contextWindow`.

// O MEDIDOR DE CONTEXTO MEDE CONTEXTO (bug ao vivo de 2026-08-17).
//
// O dono abriu um chat de planejamento RETOMADO, pediu um plano e leu
// "usados 528.703 · janela 1.000.000 · 53%". No mesmo minuto ele digitou
// /context e o próprio CLI respondeu "176.3k / 1m (18%)".
//
// Os números abaixo são os REAIS do JSONL daquela conversa (seat 9f3b8482,
// sessão f6640086). O último turno teve TRÊS chamadas de API, e a soma delas é
// exatamente 528.703 — era o agregado do `result` que estava sendo dividido
// pela janela. Contexto é o que a ÚLTIMA chamada carregou: 176.669.

/** Uma chamada de API do turno, na forma que o stream entrega. */
function claudeApiCall(line, { cacheRead, cacheCreate, out, parentToolUseId = null }) {
  line({
    type: 'assistant',
    parent_tool_use_id: parentToolUseId,
    message: {
      role: 'assistant',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
        output_tokens: out
      },
      content: [{ type: 'text', text: 'ok' }]
    }
  })
}

function claudeTurnResult(session, line, extra = {}) {
  session.pendingTurnGenerations = [1]
  session.activeTurnGeneration = 1
  line({ type: 'result', subtype: 'success', session_id: 's-ctx', ...extra })
}

test('o medidor lê a ÚLTIMA chamada do turno, nunca a soma do turno inteiro', () => {
  const { session, events, line } = claudeAgentSession()
  claudeApiCall(line, { cacheRead: 174_276, cacheCreate: 335, out: 1_217 })
  claudeApiCall(line, { cacheRead: 174_611, cacheCreate: 1_335, out: 256 })
  claudeApiCall(line, { cacheRead: 175_946, cacheCreate: 387, out: 334 })
  // O `usage` do result é a soma das três — 175.830 + 176.204 + 176.669.
  claudeTurnResult(session, line, {
    usage: {
      input_tokens: 6,
      cache_creation_input_tokens: 2_057,
      cache_read_input_tokens: 524_833,
      output_tokens: 1_807
    },
    total_cost_usd: 9.650348
  })

  const result = events.find((event) => event.type === 'result')
  assert.equal(result.contextTokens, 176_669, 'o contexto é o da última chamada')
  assert.notEqual(result.contextTokens, 528_703, 'o agregado do turno não é ocupação de janela')
  assert.equal(result.costUsd, 9.650348)
})

test('mensagem de subagente não mexe no medidor da conversa do dono', () => {
  const { session, events, line } = claudeAgentSession()
  claudeApiCall(line, { cacheRead: 120_000, cacheCreate: 500, out: 300 })
  // O subagente tem contexto PRÓPRIO: somá-lo aqui inflaria a janela do dono.
  claudeApiCall(line, { cacheRead: 900_000, cacheCreate: 0, out: 10, parentToolUseId: 'toolu_x' })
  claudeTurnResult(session, line, { usage: { input_tokens: 1 } })
  assert.equal(events.find((event) => event.type === 'result').contextTokens, 120_802)
})

test('turno de comando local não zera medidor nem custo acumulado', () => {
  const { session, events, line } = claudeAgentSession()
  claudeApiCall(line, { cacheRead: 175_946, cacheCreate: 387, out: 334 })
  claudeTurnResult(session, line, { usage: { input_tokens: 2 }, total_cost_usd: 9.650348 })
  assert.equal(events.find((event) => event.type === 'result').contextTokens, 176_669)

  // /usage e /context respondem por mensagem SINTÉTICA: usage todo zerado e
  // total_cost_usd: 0. Publicar esses zeros apagava medidor e custo da tela
  // (visto no fio persistido do dono, logo depois da medição boa).
  events.length = 0
  line({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0
      },
      content: [{ type: 'text', text: 'Current session: 48% used' }]
    }
  })
  claudeTurnResult(session, line, { usage: { input_tokens: 0 }, total_cost_usd: 0 })
  const local = events.find((event) => event.type === 'result')
  assert.equal(local.contextTokens, undefined, 'sem medição o campo é ausente, nunca zero')
  assert.equal(local.costUsd, undefined, 'zero de comando local não apaga o acumulado')
})

test('a medição não vaza de um turno para o outro', () => {
  const { session, events, line } = claudeAgentSession()
  claudeApiCall(line, { cacheRead: 100_000, cacheCreate: 0, out: 50 })
  claudeTurnResult(session, line, { usage: { input_tokens: 1 } })
  assert.equal(events.find((event) => event.type === 'result').contextTokens, 100_052)
  // Turno seguinte sem chamada nenhuma: ausente, não a medição do anterior.
  events.length = 0
  claudeTurnResult(session, line, { usage: { input_tokens: 1 } })
  assert.equal(events.find((event) => event.type === 'result').contextTokens, undefined)
})

// ————— R20.1: o medidor anda DURANTE o turno (paridade com o codex) —————
//
// Queixa do dono (2026-08-19): "o contexto não tá atualizando no ao vivo
// conforme o chat vai correndo — igual acontece no Claude Code e no Codex".
// A medição certa JÁ nascia a cada mensagem assistant (bloco acima), mas ficava
// RETIDA no campo privado até o `result`: num turno de minutos com ferramentas
// o medidor congelava a conversa inteira. O codex publica `context-usage` a
// cada chamada de API (`thread/tokenUsage/updated`) — o claude passa a publicar
// na MESMA hora em que a medição nasce.

test('cada chamada de API publica context-usage NA HORA, sem esperar o result', () => {
  const { session, events, line } = claudeAgentSession()
  line({ type: 'system', subtype: 'init', session_id: 's-ctx', model: 'claude-fable-5' })
  events.length = 0

  // As TRÊS chamadas reais do turno do dono (mesmo fixture do JSONL acima).
  claudeApiCall(line, { cacheRead: 174_276, cacheCreate: 335, out: 1_217 })
  claudeApiCall(line, { cacheRead: 174_611, cacheCreate: 1_335, out: 256 })
  claudeApiCall(line, { cacheRead: 175_946, cacheCreate: 387, out: 334 })

  const live = events.filter((event) => event.type === 'context-usage')
  assert.deepEqual(
    live.map((event) => event.contextTokens),
    [175_830, 176_204, 176_669],
    'o medidor acompanha o turno em vez de congelar até o fecho'
  )
  // Nunca o agregado (as três somadas dão 528.703, que não é ocupação de janela).
  assert.deepEqual(
    live.map((event) => event.contextWindow),
    [1_000_000, 1_000_000, 1_000_000]
  )

  // E o `result` continua carregando a fotografia final, exatamente como antes.
  claudeTurnResult(session, line, {
    usage: {
      input_tokens: 6,
      cache_creation_input_tokens: 2_057,
      cache_read_input_tokens: 524_833,
      output_tokens: 1_807
    }
  })
  assert.equal(events.find((event) => event.type === 'result').contextTokens, 176_669)
})

test('mensagem de subagente não publica medição ao vivo', () => {
  const { events, line } = claudeAgentSession()
  const liveTokens = () =>
    events.filter((event) => event.type === 'context-usage').map((event) => event.contextTokens)
  line({ type: 'system', subtype: 'init', session_id: 's-ctx', model: 'claude-fable-5' })
  events.length = 0

  claudeApiCall(line, { cacheRead: 120_000, cacheCreate: 500, out: 300 })
  assert.deepEqual(liveTokens(), [120_802], 'a chamada do dono publica na hora')

  // O subagente tem contexto PRÓPRIO: publicá-lo faria o medidor do dono saltar
  // para a janela de outra conversa no meio do turno.
  claudeApiCall(line, { cacheRead: 900_000, cacheCreate: 0, out: 10, parentToolUseId: 'toolu_x' })
  assert.deepEqual(liveTokens(), [120_802], 'o ajudante não mexe no medidor do dono')
})

test('mensagem sintética de comando local não publica medição ao vivo', () => {
  const { events, line } = claudeAgentSession()
  const liveTokens = () =>
    events.filter((event) => event.type === 'context-usage').map((event) => event.contextTokens)
  line({ type: 'system', subtype: 'init', session_id: 's-ctx', model: 'claude-fable-5' })
  events.length = 0

  claudeApiCall(line, { cacheRead: 175_946, cacheCreate: 387, out: 334 })
  assert.deepEqual(liveTokens(), [176_669])

  // /usage e /context respondem com `usage` todo zerado: zero NÃO é medição, e
  // no redutor o `context-usage` é atribuição direta — publicá-lo APAGARIA o
  // medidor bom no meio do turno.
  line({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0
      },
      content: [{ type: 'text', text: 'Current session: 48% used' }]
    }
  })
  assert.deepEqual(liveTokens(), [176_669], 'medição ausente não vira publicação de zero')
})

test('a janela do evento vivo é a MESMA fonte do result — uma régua só', () => {
  const { session, events, line } = claudeAgentSession()
  const liveWindow = () =>
    events.filter((event) => event.type === 'context-usage').at(-1).contextWindow

  // Modelo que a tabela curada não conhece: enquanto o CLI não mediu vale o
  // piso — e é EXATAMENTE o que o init acabou de anunciar (nunca duas janelas
  // diferentes na mesma tela).
  line({ type: 'system', subtype: 'init', session_id: 's-ctx', model: 'modelo-novo' })
  const initWindow = events.find((event) => event.type === 'init').contextWindow
  assert.equal(initWindow, 200_000)
  claudeApiCall(line, { cacheRead: 10_000, cacheCreate: 0, out: 100 })
  assert.equal(liveWindow(), initWindow)

  // O CLI mede 1M no `result`: a próxima medição viva já anuncia a janela nova.
  claudeTurnResult(session, line, {
    usage: { input_tokens: 1 },
    modelUsage: { 'modelo-novo': { contextWindow: 1_000_000 } }
  })
  assert.equal(events.find((event) => event.type === 'result').contextWindow, 1_000_000)
  events.length = 0
  claudeApiCall(line, { cacheRead: 20_000, cacheCreate: 0, out: 100 })
  assert.equal(liveWindow(), 1_000_000, 'o evento vivo bebe da medição do result')

  // PINO ESTRUTURAL: a régua mora num lugar só e os DOIS emissores bebem dela —
  // divergir exigiria apagar a régua, não apenas editar uma linha distraído.
  const source = readFileSync(new URL('../src/main/maestroSession.ts', import.meta.url), 'utf8')
  assert.equal(
    source.match(/measuredWindow \?\? claudeCuratedContextWindow/gu)?.length,
    1,
    'a janela é resolvida num ponto único do motor'
  )
  const liveEmit = source.slice(source.lastIndexOf("type: 'context-usage',"), -1)
  assert.match(liveEmit.slice(0, 300), /contextWindow: this\.contextWindowNow\(\)/u)
  const initEmit = source.slice(source.lastIndexOf("type: 'init',"), -1)
  assert.match(initEmit.slice(0, 700), /contextWindow: this\.contextWindowNow\(\)/u)
  // E a régua continua alimentada pela medição autoritativa do `result`.
  assert.match(
    source,
    /const measuredWindow = claudeReportedContextWindow\(evt\.modelUsage, this\.initModel\)/u
  )
  assert.match(source, /if \(measuredWindow !== undefined\) this\.measuredWindow = measuredWindow/u)
})

test('custo é o acumulado do processo e só entra quando é positivo', () => {
  assert.equal(claudeSessionCostUsd(9.650348), 9.650348)
  assert.equal(claudeSessionCostUsd(0.000_42), 0.000_42)
  assert.equal(claudeSessionCostUsd(0), undefined)
  assert.equal(claudeSessionCostUsd(-1), undefined)
  assert.equal(claudeSessionCostUsd(Number.NaN), undefined)
  assert.equal(claudeSessionCostUsd('9.65'), undefined)
  assert.equal(claudeSessionCostUsd(undefined), undefined)
})

test('contexto de uma chamada: prompt inteiro mais a resposta; zerado é ausência', () => {
  assert.equal(
    claudeMessageContextTokens({
      input_tokens: 2,
      cache_creation_input_tokens: 387,
      cache_read_input_tokens: 175_946,
      output_tokens: 334
    }),
    176_669
  )
  // Sem prompt não houve chamada: é a assinatura da mensagem sintética.
  assert.equal(claudeMessageContextTokens({ input_tokens: 0, output_tokens: 0 }), undefined)
  assert.equal(claudeMessageContextTokens({ output_tokens: 500 }), undefined)
  assert.equal(claudeMessageContextTokens(undefined), undefined)
  // Campo torto nunca vira medição torta.
  assert.equal(claudeMessageContextTokens({ input_tokens: '10', cache_read_input_tokens: 90 }), 90)
  assert.equal(claudeMessageContextTokens({ input_tokens: Number.NaN }), undefined)
  assert.equal(claudeMessageContextTokens({ cache_read_input_tokens: -5 }), undefined)
})

test('a tabela curada de janela cobre as famílias atuais, o marcador [1m] e o desconhecido', () => {
  // Famílias de 1M (catálogo Anthropic, cache 2026-06).
  for (const model of [
    'claude-fable-5',
    'claude-mythos-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-sonnet-4-6'
  ])
    assert.equal(claudeCuratedContextWindow(model), 1_000_000, `${model} é 1M`)

  // Haiku é a exceção de 200K DENTRO das famílias atuais.
  assert.equal(claudeCuratedContextWindow('claude-haiku-4-5-20251001'), 200_000)

  // O marcador explícito do CLI vale mesmo em família que a tabela não conhece.
  assert.equal(claudeCuratedContextWindow('claude-opus-5[1m]'), 1_000_000)
  assert.equal(claudeCuratedContextWindow('modelo-do-futuro[1m]'), 1_000_000)

  // Desconhecido cai no piso conservador — nunca prometer janela inexistente.
  assert.equal(claudeCuratedContextWindow('claude'), 200_000)
  assert.equal(claudeCuratedContextWindow('modelo-do-futuro'), 200_000)

  // Caixa não decide nada.
  assert.equal(claudeCuratedContextWindow('CLAUDE-FABLE-5'), 1_000_000)
  assert.equal(claudeCuratedContextWindow('Claude-Haiku-4-5'), 200_000)
})

test('a janela do result só vale indexada pelo modelo da conversa', () => {
  // O mapa traz modelos de tarefas auxiliares — ler "o primeiro" pegaria haiku.
  const modelUsage = {
    'claude-haiku-4-5-20251001': { contextWindow: 200_000 },
    'claude-fable-5': { contextWindow: 1_000_000 }
  }
  assert.equal(claudeReportedContextWindow(modelUsage, 'claude-fable-5'), 1_000_000)
  assert.equal(claudeReportedContextWindow(modelUsage, 'claude-haiku-4-5-20251001'), 200_000)

  // Sem modelo, sem mapa, modelo ausente ou número inválido: ausente (nunca 0,
  // nunca chute) — a janela do init continua valendo.
  assert.equal(claudeReportedContextWindow(modelUsage, null), undefined)
  assert.equal(claudeReportedContextWindow(undefined, 'claude-fable-5'), undefined)
  assert.equal(claudeReportedContextWindow(modelUsage, 'claude-opus-5'), undefined)
  assert.equal(claudeReportedContextWindow({ m: {} }, 'm'), undefined)
  assert.equal(claudeReportedContextWindow({ m: { contextWindow: 0 } }, 'm'), undefined)
  assert.equal(claudeReportedContextWindow({ m: { contextWindow: -1 } }, 'm'), undefined)
  assert.equal(claudeReportedContextWindow({ m: { contextWindow: 1.5 } }, 'm'), undefined)
  assert.equal(claudeReportedContextWindow({ m: { contextWindow: '1000000' } }, 'm'), undefined)
})

test('o init anuncia a janela do modelo e a troca de modelo atualiza a janela', () => {
  const { events, line } = claudeAgentSession()
  const windowOf = (model) => {
    events.length = 0
    line({ type: 'system', subtype: 'init', session_id: 's1', model })
    const init = events.find((e) => e.type === 'init')
    assert.ok(init, `init emitido para ${model}`)
    assert.equal(init.model, model)
    return init.contextWindow
  }

  // O caso do dono: Fable 5 chega SEM o sufixo [1m] e é 1M — a heurística
  // antiga (`includes('[1m]')`) dizia 200k aqui.
  assert.equal(windowOf('claude-fable-5'), 1_000_000)
  // Trocar de modelo reemite init: a janela acompanha, nos dois sentidos.
  assert.equal(windowOf('claude-haiku-4-5-20251001'), 200_000)
  assert.equal(windowOf('claude-opus-5[1m]'), 1_000_000)
  assert.equal(windowOf('claude-sonnet-5'), 1_000_000)
})

test('o result substitui a janela do init pela medição real do CLI', () => {
  const { session, events, line } = claudeAgentSession()
  const resultLine = (modelUsage) => {
    session.pendingTurnGenerations = [1]
    session.activeTurnGeneration = 1
    line({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 2, output_tokens: 4 },
      ...(modelUsage ? { modelUsage } : {})
    })
    return events.find((e) => e.type === 'result')
  }

  line({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-fable-5' })
  events.length = 0

  // Medição real do modelo DESTA conversa, mesmo com haiku no mesmo mapa.
  const measured = resultLine({
    'claude-haiku-4-5-20251001': { contextWindow: 200_000 },
    'claude-fable-5': { contextWindow: 1_000_000 }
  })
  assert.equal(measured.contextWindow, 1_000_000)
  // A JANELA vem do result; os TOKENS não. Este turno não teve chamada de API
  // nenhuma no fixture, então não há contexto a publicar — o `usage` do result
  // é o agregado do turno e nunca mais alimenta o medidor (ver o bloco do
  // medidor acima). Antes esta linha esperava `6`, que era 2 de entrada + 4 de
  // saída somados como se fossem ocupação de janela.
  assert.equal(measured.contextTokens, undefined)

  // Sem o modelo da conversa no mapa o campo é OMITIDO (a janela do init
  // sobrevive no redutor via `evt.contextWindow ?? next.contextWindow`).
  events.length = 0
  assert.equal(resultLine({ 'claude-haiku-4-5-20251001': { contextWindow: 200_000 } }).contextWindow, undefined)
  events.length = 0
  assert.equal(resultLine(undefined).contextWindow, undefined)

  // Depois de trocar de modelo, o result passa a medir o modelo NOVO.
  line({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-haiku-4-5-20251001' })
  events.length = 0
  const swapped = resultLine({
    'claude-fable-5': { contextWindow: 1_000_000 },
    'claude-haiku-4-5-20251001': { contextWindow: 200_000 }
  })
  assert.equal(swapped.contextWindow, 200_000)
})

test('o init para de reanunciar o piso depois da primeira medição', () => {
  const { session, events, line } = claudeAgentSession()
  const initWindow = () => events.find((e) => e.type === 'init').contextWindow
  const result = (modelUsage) => {
    session.pendingTurnGenerations = [1]
    session.activeTurnGeneration = 1
    line({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage
    })
  }

  // Modelo que a tabela não conhece: o piso conservador entra primeiro.
  line({ type: 'system', subtype: 'init', session_id: 's1', model: 'modelo-novo' })
  assert.equal(initWindow(), 200_000)

  // O CLI mede: 1M de verdade.
  result({ 'modelo-novo': { contextWindow: 1_000_000 } })

  // O init REPETE a cada turno. Sem a memória da medição ele reanunciaria o
  // piso e o medidor cairia de 1M para 200k a cada volta — o mesmo piso ainda
  // acabava PERSISTIDO como se fosse medição.
  events.length = 0
  line({ type: 'system', subtype: 'init', session_id: 's1', model: 'modelo-novo' })
  assert.equal(initWindow(), 1_000_000, 'a medição do processo manda sobre o piso')
})

test('trocar de modelo descarta a medição do modelo anterior', () => {
  const { session, events, line } = claudeAgentSession()
  const initWindow = () => events.find((e) => e.type === 'init').contextWindow

  line({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-fable-5' })
  session.pendingTurnGenerations = [1]
  session.activeTurnGeneration = 1
  line({
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { 'claude-fable-5': { contextWindow: 1_000_000 } }
  })

  // Modelo NOVO reemite init: a medição do anterior não vale para ele — voltar
  // ao piso do modelo certo é honesto, herdar 1M seria promessa falsa.
  events.length = 0
  line({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-haiku-4-5-20251001' })
  assert.equal(initWindow(), 200_000)
})

test('o result com janela medida sobrevive à persistência e à fotografia do anel', () => {
  // O evento novo precisa atravessar o contrato de persistência, senão a
  // medição some no replay da remontagem.
  assert.equal(
    isGuiPersistedEvent({ type: 'result', isError: false, contextTokens: 6, contextWindow: 1_000_000 }),
    true
  )
  assert.equal(
    isGuiPersistedEvent({ type: 'result', isError: false, contextWindow: -1 }),
    false,
    'janela inválida não entra no fio salvo'
  )
  assert.equal(
    isGuiPersistedEvent({ type: 'init', model: 'claude-fable-5', sessionId: 's1', permissionMode: 'default', toolCount: 0, contextWindow: 1_000_000 }),
    true
  )
})

// ————— PROPOSTA DE PLANO (2.0, onda D) — os espelhos 1 e 4 + o motor —————

/** Rascunho já normalizado, como o `propose_plan` entrega ao motor. */
const planDraftFixture = {
  title: 'Versão 2',
  description: 'a fila de integração fica visível',
  kind: 'livre',
  items: [
    {
      key: 'fundacao',
      title: 'Fundação da fila',
      objective: 'subir a fila',
      doneCriteria: ['a fila responde'],
      dependsOn: []
    },
    {
      key: 'tela',
      title: 'Tela da fila',
      objective: 'mostrar a fila',
      doneCriteria: [],
      tier: 'medio',
      dependsOn: ['fundacao'],
      docPath: 'plano/002-tela.md'
    }
  ]
}

function planProposalPane(gui, paneId) {
  const ring = new GuiEventRing()
  // A proposta é do HARNESS, não do CLI: ela não pergunta nada ao backend, e é
  // por isso que qualquer sessão viva serve — claude e codex reagem igual.
  const session = { alive: true, send: () => undefined }
  gui.panes.set(paneId, {
    spawn: { paneId, projectId: 'proj', cli: 'claude', configDir: 'c', cwd: '/tmp' },
    fingerprint: 'teste',
    session,
    ring,
    token: { alive: true },
    sink: (evt) => ring.push(evt)
  })
  return ring
}

test('a proposta vira card no fio e o rascunho autoritativo sai do anel', () => {
  const woken = []
  const gui = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    onPermissionPending: (input) => woken.push(input)
  })
  const ring = planProposalPane(gui, 'gui-dev-plan0001')

  const presented = gui.proposePlan('gui-dev-plan0001', planDraftFixture)
  assert.equal(presented.ok, true)
  assert.match(presented.requestId, /^plan-proposal-/)

  const [event] = ring.snapshot()
  assert.equal(event.type, 'plan-proposal')
  assert.equal(event.requestId, presented.requestId)
  assert.deepEqual(event.draft, planDraftFixture)
  // o dono é ACORDADO: a conversa parou esperando por ele
  assert.deepEqual(woken, [
    { paneId: 'gui-dev-plan0001', projectId: 'proj', toolName: 'propose_plan', kind: 'question' }
  ])

  // o rascunho que a aprovação materializa vem do ANEL, nunca do renderer
  assert.deepEqual(
    gui.pendingPlanProposal('gui-dev-plan0001', presented.requestId),
    planDraftFixture
  )
  assert.equal(gui.pendingPlanProposal('gui-dev-plan0001', 'outro-id'), undefined)
  assert.equal(gui.pendingPlanProposal('pane-inexistente', presented.requestId), undefined)
})

test('rascunho torto nunca vira card e pane sem sessão recusa em PT-BR', () => {
  const gui = registry()
  planProposalPane(gui, 'gui-dev-plan0002')
  const torto = gui.proposePlan('gui-dev-plan0002', { title: 'sem itens' })
  assert.equal(torto.ok, false)
  assert.equal(torto.error, 'plano em formato inválido')
  const semPane = gui.proposePlan('pane-inexistente', planDraftFixture)
  assert.equal(semPane.ok, false)
  assert.equal(semPane.error, 'este pane não tem sessão aberta')
})

test('a proposta SOBREVIVE ao fim do turno — ela não bloqueia o CLI', () => {
  const gui = registry()
  const ring = planProposalPane(gui, 'gui-dev-plan0003')
  const presented = gui.proposePlan('gui-dev-plan0003', planDraftFixture)

  // pedidos que BLOQUEIAM o backend morrem com o turno; a proposta fica
  ring.push({ type: 'permission', requestId: 'req-perm', toolName: 'Bash' })
  ring.push({ type: 'question', requestId: 'req-question', questions: [] })
  ring.push({ type: 'result', isError: false })

  const types = ring.snapshot().map((evt) => evt.type)
  assert.equal(types.includes('permission'), false, 'permissão morre com o turno')
  assert.equal(types.includes('question'), false, 'pergunta morre com o turno')
  assert.equal(types.filter((type) => type === 'plan-proposal').length, 1)
  assert.deepEqual(
    gui.pendingPlanProposal('gui-dev-plan0003', presented.requestId),
    planDraftFixture,
    'o card continua clicável depois de o agente terminar de falar'
  )
})

// ————— O CARTÃO DE PLANO DO SYNKORA (plan_approval, 2026-09-22) —————
//
// O caso medido: o Claude gravou o mini-plano no canal de RACIOCÍNIO (que o
// chat esconde por decisão do dono) e chamou AskUserQuestion — o dono viu
// "aprova o plano?" sem plano. Aqui o plano viaja DENTRO do pedido e vira uma
// pergunta assíncrona com o plano no corpo, em qualquer CLI.

function planApprovalPane(gui, paneId, cli = 'claude') {
  const ring = new GuiEventRing()
  const sent = []
  const session = { alive: true, turnActive: false, send: (text) => sent.push(text),
    answerQuestion() { throw new Error('o cartão de plano nunca usa o RPC de pergunta bloqueante') } }
  gui.panes.set(paneId, {
    spawn: { paneId, projectId: 'proj', cli, configDir: 'c', cwd: '/tmp' },
    fingerprint: 'teste',
    session,
    ring,
    token: { alive: true },
    sink: (evt) => ring.push(evt)
  })
  return { ring, sent, session }
}

test('plan_approval publica uma pergunta assíncrona com o plano no corpo e acorda o dono', () => {
  const woken = []
  const gui = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    onPermissionPending: (input) => woken.push(input)
  })
  const { ring } = planApprovalPane(gui, 'gui-dev-aprov0001')
  const plan = '1. Ler o motor\n2. Corrigir o cartão\n3. Testar'
  const presented = gui.planApproval({ paneId: 'gui-dev-aprov0001', projectId: 'proj' }, { plan })
  assert.equal(presented.ok, true)
  assert.match(presented.requestId, /^synkora-plan-/u)

  const [event] = ring.snapshot()
  assert.equal(event.type, 'question')
  assert.equal(event.requestId, presented.requestId)
  assert.equal(event.plan, plan, 'o plano é parte do evento — é ele que o cartão mostra')
  assert.equal(event.blocking, false)
  assert.equal(event.asynchronous, true)
  assert.deepEqual(event.questions.map((q) => [q.id, q.question, q.options.map((o) => o.label)]),
    [['plan', 'Aprova este plano?', ['Aprovar', 'Não aprovar']]])
  assert.ok(isGuiPersistedEvent(event), 'o evento com o plano passa pela porteira do anel')
  assert.deepEqual(woken, [
    { paneId: 'gui-dev-aprov0001', projectId: 'proj', toolName: 'plan_approval', kind: 'question' }
  ])
})

test('plan_approval recusa em PT-BR: pedido torto, projeto alheio e conversa fechada', () => {
  const gui = registry()
  const { session } = planApprovalPane(gui, 'gui-dev-aprov0002')
  const torto = gui.planApproval({ paneId: 'gui-dev-aprov0002', projectId: 'proj' }, { plan: '   ' })
  assert.equal(torto.ok, false)
  assert.match(torto.error, /plan/u)
  const alheio = gui.planApproval({ paneId: 'gui-dev-aprov0002', projectId: 'outro' }, { plan: 'x' })
  assert.equal(alheio.ok, false)
  assert.match(alheio.error, /não está aberta/u)
  session.alive = false
  const fechada = gui.planApproval({ paneId: 'gui-dev-aprov0002', projectId: 'proj' }, { plan: 'x' })
  assert.equal(fechada.ok, false)
  assert.match(fechada.error, /cartão de pergunta/u, 'a recusa nomeia a receita')
})

test('o cartão de plano SOBREVIVE ao fim do turno e um novo supera o antigo', () => {
  const gui = registry()
  const { ring } = planApprovalPane(gui, 'gui-dev-aprov0003')
  const first = gui.planApproval({ paneId: 'gui-dev-aprov0003', projectId: 'proj' }, { plan: 'primeiro' })
  ring.push({ type: 'question', requestId: 'req-rpc', questions: [] })
  ring.push({ type: 'result', isError: false })
  assert.deepEqual(ring.pendingIdsOfType('question'), [first.requestId],
    'a pergunta RPC morre com o turno; o cartão de plano fica')

  const second = gui.planApproval({ paneId: 'gui-dev-aprov0003', projectId: 'proj' }, { plan: 'segundo' })
  assert.deepEqual(ring.pendingIdsOfType('question'), [second.requestId])
  const stale = ring.snapshot().find((evt) => evt.type === 'interaction-resolved' && evt.requestId === first.requestId)
  assert.deepEqual(stale?.resolution, { kind: 'stale' })
})

test('a decisão do dono no cartão de plano vira mensagem nova — no Claude e no Codex', () => {
  for (const cli of ['claude', 'codex']) {
    const gui = registry()
    const { ring, sent } = planApprovalPane(gui, `gui-dev-aprov-${cli}`, cli)
    const identity = { paneId: `gui-dev-aprov-${cli}`, projectId: 'proj' }
    const presented = gui.planApproval(identity, { plan: 'o plano', question: 'Sigo assim?' })

    assert.equal(gui.answerQuestion(identity.paneId, presented.requestId, { invented: 'Aprovar' }).ok, false,
      'id de pergunta inventado não vira resposta')
    assert.deepEqual(gui.answerQuestion(identity.paneId, presented.requestId, { plan: 'Aprovar' }), { ok: true })
    assert.equal(sent.length, 1, `${cli}: a resposta é UMA mensagem do dono`)
    assert.match(sent[0], /Sigo assim\?/u)
    assert.match(sent[0], /Aprovar/u)
    const events = ring.snapshot()
    const receipt = events.find((evt) => evt.type === 'interaction-resolved' && evt.requestId === presented.requestId)
    assert.equal(receipt?.resolution.kind, 'question')
    assert.deepEqual(receipt?.resolution.entries, [{ question: 'Sigo assim?', answer: 'Aprovar' }])
    assert.equal(receipt?.resolution.messageId, events.find((evt) => evt.type === 'user-message')?.id)
    assert.deepEqual(ring.pendingIdsOfType('question'), [])
    assert.equal(gui.answerQuestion(identity.paneId, presented.requestId, { plan: 'Aprovar' }).ok, false,
      'entrega única: o cartão respondido não responde de novo')
  }
})

test('o desfecho do card fecha a pendência e o eco nomeia o plano criado', () => {
  const gui = registry()
  const ring = planProposalPane(gui, 'gui-dev-plan0004')
  const presented = gui.proposePlan('gui-dev-plan0004', planDraftFixture)

  const resolved = gui.resolvePlanProposal('gui-dev-plan0004', presented.requestId, {
    approve: true,
    planId: 'plan-1',
    planTitle: 'Versão 2'
  })
  assert.equal(resolved.ok, true)
  assert.deepEqual(ring.snapshot().at(-1), {
    type: 'interaction-resolved',
    requestId: presented.requestId,
    resolution: { kind: 'plan-proposal', approve: true, planId: 'plan-1', planTitle: 'Versão 2' }
  })
  // resolvida uma vez, some do anel: um segundo clique não cria plano nenhum
  assert.equal(gui.pendingPlanProposal('gui-dev-plan0004', presented.requestId), undefined)
  const again = gui.resolvePlanProposal('gui-dev-plan0004', presented.requestId, { approve: true })
  assert.equal(again.ok, false)
  assert.equal(again.error, 'esta proposta não está mais pendente')
  assert.deepEqual(ring.snapshot().at(-1).resolution, { kind: 'stale' })
})

test('o rascunho persistido atravessa a hidratação, e forma incompleta é recusada', () => {
  assert.equal(
    isGuiPersistedEvent({ type: 'plan-proposal', requestId: 'r1', draft: planDraftFixture }),
    true
  )
  assert.equal(
    isGuiPersistedEvent({ type: 'plan-proposal', requestId: 'r1', draft: { title: 'x' } }),
    false,
    'rascunho sem itens não renasce meio pronto'
  )
  assert.equal(
    isGuiPersistedEvent({ type: 'plan-proposal', draft: planDraftFixture }),
    false,
    'sem requestId o card não teria como ser respondido'
  )
  // e o desfecho dele também é contrato de disco
  assert.equal(
    isGuiPersistedEvent({
      type: 'interaction-resolved',
      requestId: 'r1',
      resolution: { kind: 'plan-proposal', approve: true, planId: 'plan-1' }
    }),
    true
  )
  assert.equal(
    isGuiPersistedEvent({
      type: 'interaction-resolved',
      requestId: 'r1',
      resolution: { kind: 'plan-proposal' }
    }),
    false
  )
})

test('armar o MCP do planejador muda a identidade do spawn (respawn com resume)', () => {
  const semTools = spawnFingerprint(baseSpawn)
  const comTools = spawnFingerprint({
    ...baseSpawn,
    mcp: { args: ['--mcp-config', 'C:/x/gui-dev-abcd1234.json', '--strict-mcp-config'] }
  })
  assert.notEqual(comTools, semTools, 'ligar as ferramentas exige processo novo')
  assert.equal(
    spawnFingerprint({ ...baseSpawn, mcp: { args: [] } }),
    semTools,
    'lista vazia é o mesmo que não ter MCP'
  )
  const portaA = spawnFingerprint({
    ...baseSpawn,
    mcp: { args: ['-c', 'mcp_servers.synkora.url=http://127.0.0.1:5555/mcp'] }
  })
  const portaB = spawnFingerprint({
    ...baseSpawn,
    mcp: { args: ['-c', 'mcp_servers.synkora.url=http://127.0.0.1:6666/mcp'] }
  })
  assert.notEqual(portaA, portaB, 'porta nova é linha de comando nova')
})

test('o codex recebe o override do servidor SEM aspas (o shell não escapa nada)', () => {
  const args = guiPlannerCodexArgs(4321)
  assert.deepEqual(args, [
    '-c',
    'mcp_servers.synkora.url=http://127.0.0.1:4321/mcp',
    '-c',
    'mcp_servers.synkora.bearer_token_env_var=SYNKORA_TOKEN',
    '-c',
    'mcp_servers.synkora.startup_timeout_sec=30'
  ])
  assert.equal(
    args.some((arg) => arg.includes('"')),
    false,
    'aspas embutidas seriam comidas pelo cmd.exe e o valor chegaria torto'
  )
})

test('o planejador arma token e config; sem servidor de pé, o chat nasce sem tools', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-planner-mcp-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const registered = []
  const remembered = []
  // Cada chamada aqui é um pane DIFERENTE, então o cache de token nasce vazio:
  // o reuso por remontagem tem teste próprio logo abaixo.
  const deps = (port) => ({
    hub: {
      registerPane: (token, identity) => registered.push({ token, identity }),
      identityByToken: () => undefined
    },
    port: () => port,
    configRoot: () => root,
    tokenOf: () => undefined,
    remember: (paneId, artifacts) => remembered.push({ paneId, ...artifacts })
  })

  const claude = armGuiPlannerMcp(
    {
      paneId: 'gui-dev-plan0005',
      projectId: 'proj',
      cwd: '/tmp/proj',
      cli: 'claude',
      missionId: 'mission-1',
      seatId: 'seat-1'
    },
    deps(4321)
  )
  assert.equal(claude.args[0], '--mcp-config')
  assert.ok(claude.args.includes('--strict-mcp-config'), 'o planejador não herda MCP do seat')
  // 2026-08-30: o planejador entrou no regime da delegação — o arm dele traz a
  // cerca anti-subagente-nativo e a pré-sanção por papel (a lista exata é do
  // `test:gui-delegate-mcp`); o env carrega o teto do long-poll.
  assert.ok(claude.args.includes('--disallowedTools'), 'o planejador nasce cercado')
  assert.ok(claude.args.includes('--allowedTools'), 'sem pré-sanção o kit pediria card')
  assert.equal(typeof claude.env?.MCP_TOOL_TIMEOUT, 'string', 'sem o teto o long-poll morre em 60s')
  assert.equal(registered[0].identity.role, 'gui-planner')
  assert.equal(registered[0].identity.projectId, 'proj')
  assert.equal(registered[0].identity.missionId, 'mission-1')
  assert.equal(remembered[0].token, registered[0].token)
  assert.equal(remembered[0].mcpFile, claude.args[1])
  const config = JSON.parse(readFileSync(claude.args[1], 'utf8'))
  assert.equal(config.mcpServers.synkora.url, 'http://127.0.0.1:4321/mcp')
  assert.equal(config.mcpServers.synkora.headers.Authorization, `Bearer ${registered[0].token}`)
  assert.equal(config.mcpServers.playwright, undefined, 'o planejador não abre browser')

  const codex = armGuiPlannerMcp(
    { paneId: 'gui-dev-plan0006', projectId: 'proj', cwd: '/tmp/proj', cli: 'codex' },
    deps(4321)
  )
  assert.equal(codex.env[GUI_PLANNER_TOKEN_ENV], registered[1].token)
  assert.equal(codex.args[1], 'mcp_servers.synkora.url=http://127.0.0.1:4321/mcp')
  assert.equal(remembered[1].mcpFile, undefined, 'codex não grava arquivo de config')

  // dois panes NUNCA compartilham token
  assert.notEqual(registered[0].token, registered[1].token)

  // porta 0 = servidor ainda subindo: nada é registrado e o pane nasce mudo
  const antes = registered.length
  assert.equal(
    armGuiPlannerMcp(
      { paneId: 'gui-dev-plan0007', projectId: 'proj', cwd: '/tmp/proj', cli: 'claude' },
      deps(0)
    ),
    undefined
  )
  assert.equal(registered.length, antes, 'sem servidor, nenhum token é emitido')
})

test('remontar o chat REUSA o token: o processo vivo leu o arquivo no nascimento', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-planner-idem-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const byToken = new Map()
  const byPane = new Map()
  const tokens = new Map()
  const hub = {
    registerPane: (token, identity) => {
      byToken.set(token, identity)
      byPane.set(identity.paneId, identity)
    },
    identityByToken: (token) => byToken.get(token)
  }
  const deps = {
    hub,
    port: () => 4321,
    configRoot: () => root,
    tokenOf: (paneId) => tokens.get(paneId),
    remember: (paneId, { token }) => tokens.set(paneId, token)
  }
  const input = { paneId: 'gui-dev-plan0008', projectId: 'proj', cwd: '/tmp/proj', cli: 'claude' }

  const first = armGuiPlannerMcp(input, deps)
  const second = armGuiPlannerMcp(input, deps)
  assert.deepEqual(second.args, first.args, 'args iguais = fingerprint igual = sem respawn')
  assert.equal(byToken.size, 1, 'a remontagem não pode acumular token vivo por pane')
  const config = JSON.parse(readFileSync(first.args[1], 'utf8'))
  assert.equal(
    config.mcpServers.synkora.headers.Authorization,
    `Bearer ${tokens.get(input.paneId)}`,
    'o arquivo continua batendo com o token que o processo vivo carrega'
  )

  // token revogado (pane morreu e voltou): identidade nova, token novo
  byToken.clear()
  const third = armGuiPlannerMcp(input, deps)
  assert.equal(byToken.size, 1)
  assert.notEqual(tokens.get(input.paneId), config.mcpServers.synkora.headers.Authorization)
  assert.deepEqual(third.args, first.args, 'o caminho do arquivo é estável por pane')
})

test('propor de novo SUPERA a proposta anterior — nunca dois cards do mesmo plano', () => {
  const gui = registry()
  const ring = planProposalPane(gui, 'gui-dev-plan0009')
  const first = gui.proposePlan('gui-dev-plan0009', planDraftFixture)
  const second = gui.proposePlan('gui-dev-plan0009', {
    ...planDraftFixture,
    title: 'Versão 2 (revisada)'
  })
  assert.equal(second.ok, true)
  assert.notEqual(second.requestId, first.requestId)

  const pending = ring.snapshot().filter((evt) => evt.type === 'plan-proposal')
  assert.equal(pending.length, 1, 'só a proposta mais nova continua clicável')
  assert.equal(pending[0].requestId, second.requestId)
  assert.equal(gui.pendingPlanProposal('gui-dev-plan0009', first.requestId), undefined)
  // e a superação vira eco factual no fio, nunca um card que some sem explicação
  const echo = ring
    .snapshot()
    .find((evt) => evt.type === 'interaction-resolved' && evt.requestId === first.requestId)
  assert.deepEqual(echo.resolution, { kind: 'stale' })
})

/**
 * Rascunho no formato do que o dono viu sumir em 2026-08-15 (evidência em
 * .synkora/reports/evidence-plan-card-vanish-20260815.json): 5 missões com
 * cadeia de dependência, docPath e descrição longa. O que se prova aqui é a
 * TRAVESSIA — proposta no meio da fala, turno fechando por cima dela e um
 * processo NOVO remontando o card do disco.
 */
const ownerPlanDraftFixture = {
  title: 'V1.0 — Lista de tarefas que funciona de ponta a ponta',
  description: `Uma lista de tarefas que funciona do começo ao fim na sua máquina: você adiciona, marca como feita, remove, e o que você digitou continua lá quando reabre o navegador.\n\nHTML, CSS e JavaScript puros — sem npm, sem build, sem servidor.`,
  kind: 'mestre',
  items: [
    {
      key: 'pagina',
      title: 'A página existe e abre',
      objective: 'index.html abre no navegador com o esqueleto da lista',
      doneCriteria: ['abrir o arquivo mostra o título e o campo de digitar'],
      tier: 'pequeno',
      dependsOn: [],
      docPath: 'plano/001-pagina.md'
    },
    {
      key: 'adicionar',
      title: 'Adicionar tarefa',
      objective: 'digitar e dar Enter coloca a tarefa na lista',
      outOfScope: 'edição do texto depois de criado',
      doneCriteria: ['a tarefa aparece na hora', 'campo vazio não cria nada'],
      tier: 'pequeno',
      context: 'decide a estrutura de dados que as outras missões consomem',
      dependsOn: ['pagina'],
      docPath: 'plano/002-adicionar.md'
    },
    {
      key: 'concluir',
      title: 'Marcar como feita',
      objective: 'clicar na tarefa alterna entre feita e pendente',
      doneCriteria: ['a tarefa feita fica riscada'],
      tier: 'pequeno',
      dependsOn: ['adicionar'],
      docPath: 'plano/003-concluir.md'
    },
    {
      key: 'remover',
      title: 'Remover tarefa',
      objective: 'cada tarefa tem um × que a tira da lista',
      doneCriteria: ['remover uma não mexe nas outras'],
      tier: 'pequeno',
      dependsOn: ['adicionar'],
      docPath: 'plano/004-remover.md'
    },
    {
      key: 'persistir',
      title: 'A lista sobrevive ao fechar o navegador',
      objective: 'o estado da lista fica no localStorage e volta no reload',
      doneCriteria: ['recarregar a página mantém tudo como estava'],
      tier: 'medio',
      dependsOn: ['adicionar', 'concluir', 'remover'],
      docPath: 'plano/005-persistir.md'
    }
  ]
}

test('a proposta feita no MEIO da fala sobrevive ao result e volta do disco', (t) => {
  // Reprodução fiel do caso do dono: propose_plan roda, o agente CONTINUA
  // falando, o turno fecha — e só então o card é do dono. Ele não pode se
  // perder em nenhum desses três degraus, nem no boot seguinte.
  const root = mkdtempSync(join(tmpdir(), 'synkora-gui-proposal-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const storeFile = join(root, 'gui-sessions.json')
  const spawn = {
    paneId: 'gui-dev-planlive',
    projectId: 'proj-plan',
    cli: 'claude',
    configDir: 'c',
    cwd: '/tmp'
  }

  let emit
  const first = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    storeFile
  })
  first.spawnSession = (_input, sink) => {
    emit = sink
    return {
      alive: true,
      turnActive: false,
      waitCaps: async () => ({ commands: [], models: [] }),
      send: () => undefined,
      kill: () => undefined
    }
  }
  assert.equal(first.create(spawn).ok, true)
  emit({
    type: 'init',
    model: 'claude',
    sessionId: 'session-plan',
    permissionMode: 'default',
    toolCount: 0,
    contextWindow: 200_000
  })
  emit({ type: 'ready', caps: { commands: [], models: [] } })
  assert.equal(first.send(spawn.paneId, 'monta o plano da V1.0', 'msg-plan-1').ok, true)

  const presented = first.proposePlan(spawn.paneId, ownerPlanDraftFixture)
  assert.equal(presented.ok, true)

  // o agente segue falando DEPOIS de propor — foi aqui que o card piscou
  emit({ type: 'delta', text: 'Funcionou. O card está aí ' })
  emit({ type: 'text', text: 'Funcionou. O card está aí embaixo.' })
  emit({ type: 'result', isError: false, outcome: 'completed' })

  const live = first.state(spawn.paneId)
  const livePending = live.events.filter(({ evt }) => evt.type === 'plan-proposal')
  assert.equal(livePending.length, 1, 'o result não pode levar o card embora')
  assert.equal(
    live.events.some(({ evt }) => evt.type === 'interaction-resolved'),
    false,
    'ninguém resolveu nada: a proposta continua esperando o dono'
  )
  assert.deepEqual(
    first.pendingPlanProposal(spawn.paneId, presented.requestId),
    ownerPlanDraftFixture,
    'o rascunho autoritativo continua clicável depois do fim do turno'
  )
  assert.equal(first.kill(spawn.paneId).ok, true)

  // BOOT NOVO: o card precisa renascer do transcript persistido, inteiro.
  const second = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    storeFile
  })
  const rehydrated = second.state(spawn.paneId)
  assert.equal(rehydrated.exists, true)
  const restored = rehydrated.events.filter(({ evt }) => evt.type === 'plan-proposal')
  assert.equal(restored.length, 1, 'a proposta pendente volta do disco')
  assert.equal(restored[0].evt.requestId, presented.requestId)
  assert.deepEqual(restored[0].evt.draft, ownerPlanDraftFixture)
  // e ela volta DEPOIS do result no replay: um terminal histórico nunca pode
  // apagar o card durante a remontagem.
  const order = rehydrated.events.map(({ evt }) => evt.type)
  assert.ok(
    order.lastIndexOf('plan-proposal') > order.lastIndexOf('result'),
    'a pendência é reproduzida por último'
  )

  second.spawnSession = (_input, sink) => {
    sink({ type: 'ready', caps: { commands: [], models: [] } })
    return { alive: true, turnActive: false, kill: () => undefined }
  }
  assert.equal(second.create({ ...spawn, resumeSessionId: 'session-plan' }).ok, true)
  assert.deepEqual(
    second.pendingPlanProposal(spawn.paneId, presented.requestId),
    ownerPlanDraftFixture,
    'depois do respawn o clique do dono ainda encontra o rascunho autoritativo'
  )
})

// ————— R21.1/R21.3 — O LIMITE FALA A VERDADE (print do dono, 2026-08-19) —————
//
// "tá avisando toda hora que o limite acabou" + a correção dele ao vivo: "não
// acabou, porque ele tá rodando ainda — deve ser um aviso de que tá ACABANDO e
// a gente tá entendendo que ACABOU. Tem que ter essa distinção." O `status` do
// `rate_limit_event` é a distinção; nada aqui lê palavra de texto nenhum.

const limitRules = () => import('../.tmp/gui-sessions-test/main/maestroSession.js')

test('aviso de aproximação é NOTA e o esgotado é ERRO com a receita', async () => {
  const { GUI_LIMIT_RECIPE, guiRateLimitBlocks, translateGuiRateLimit } = await limitRules()
  const resetsAt = 1_800_000_000

  // allowed_warning = AVISADO-E-AINDA-PERMITIDO (no print as edições seguem
  // passando ✓ depois de cada card): NOTA, jamais card de erro.
  const warned = translateGuiRateLimit({ status: 'allowed_warning', resetsAt }, null)
  assert.equal(warned.event.type, 'command-output')
  assert.match(warned.event.text, /Você está perto do limite do plano\./u)
  assert.doesNotMatch(warned.event.text, /allowed_warning|nada parou/u)
  assert.match(warned.event.text, /Renovação prevista às \d{2}:\d{2}\./u)
  assert.doesNotMatch(warned.event.text, /atingido/u)

  // Bloqueio de verdade continua ERRO — e agora nomeia a RECEITA: existe outra
  // conta e a troca preserva a conversa (beco sem saída é bug de 1ª classe).
  const blocked = translateGuiRateLimit({ status: 'rejected', resetsAt }, null)
  assert.equal(blocked.event.type, 'limit')
  assert.match(blocked.event.text, /^rate limit do plano atingido \(rejected\)/u)
  assert.match(blocked.event.text, /libera \d{2}:\d{2}:\d{2}/u)
  assert.ok(blocked.event.text.endsWith(GUI_LIMIT_RECIPE), 'o card termina na receita')

  // Sem horário anunciado a frase não inventa relógio nenhum.
  const noClock = translateGuiRateLimit({ status: 'rejected' }, null)
  assert.doesNotMatch(noClock.event.text, /libera/u)
  assert.ok(noClock.event.text.endsWith(GUI_LIMIT_RECIPE))

  // A régua é o CAMPO do protocolo — nunca as palavras de um texto.
  assert.equal(guiRateLimitBlocks('allowed'), false)
  assert.equal(guiRateLimitBlocks('allowed_warning'), false)
  assert.equal(guiRateLimitBlocks('rejected'), true)
  assert.equal(guiRateLimitBlocks(undefined), false)
})

test('o mesmo estado de limite não re-emite; status/horário novos falam de novo', async () => {
  const { translateGuiRateLimit } = await limitRules()
  const resetsAt = 1_800_000_000
  const first = translateGuiRateLimit({ status: 'allowed_warning', resetsAt }, null)
  assert.ok(first.event, 'o primeiro carimbo do estado fala')

  // O CLI reemite o evento a CADA request — era ISSO que virava "avisando toda
  // hora" no fio do dono. Um carimbo por MUDANÇA de estado.
  const again = translateGuiRateLimit({ status: 'allowed_warning', resetsAt }, first.key)
  assert.equal(again.event, undefined)
  assert.equal(again.key, first.key)

  // Mudou o HORÁRIO: estado novo, fala de novo.
  const later = translateGuiRateLimit(
    { status: 'allowed_warning', resetsAt: resetsAt + 3_600 },
    first.key
  )
  assert.equal(later.event?.type, 'command-output')

  // Mudou o STATUS: o aviso virou bloqueio e o fio PRECISA saber.
  const worse = translateGuiRateLimit({ status: 'rejected', resetsAt }, first.key)
  assert.equal(worse.event?.type, 'limit')

  // Liberado de novo: silêncio, e o carimbo é esquecido — o próximo aviso fala.
  const freed = translateGuiRateLimit({ status: 'allowed', resetsAt }, worse.key)
  assert.equal(freed.event, undefined)
  assert.equal(freed.key, null)
  assert.ok(translateGuiRateLimit({ status: 'allowed_warning', resetsAt }, freed.key).event)

  // Evento sem status não é fato: não fala e não apaga o que já foi dito.
  const noise = translateGuiRateLimit(undefined, worse.key)
  assert.equal(noise.event, undefined)
  assert.equal(noise.key, worse.key)
})

test('a voz da casa veste o erro do result só com o limite ARMADO', async () => {
  const { GUI_LIMIT_RECIPE, guiLimitResultText } = await limitRules()
  const now = Date.UTC(2026, 7, 19, 23, 0)
  const resetsAt = Math.floor(now / 1000) + 1_200

  // 2º print do dono: o card falava o inglês cru do CLI.
  const dressed = guiLimitResultText({ status: 'rejected', resetsAt }, now)
  assert.match(dressed, /^o turno parou no limite do plano \(rejected\)/u)
  assert.match(dressed, /libera \d{2}:\d{2}:\d{2}/u)
  assert.ok(dressed.endsWith(GUI_LIMIT_RECIPE))

  // Sem estado armado o texto do próprio CLI passa intacto...
  assert.equal(guiLimitResultText(null, now), undefined)
  assert.equal(guiLimitResultText({ resetsAt }, now), undefined)
  // ...e a janela VENCIDA desarma: vestir um erro novo com a voz do limite
  // seria mentir na direção oposta.
  assert.equal(
    guiLimitResultText({ status: 'rejected', resetsAt: Math.floor(now / 1000) - 1 }, now),
    undefined
  )
  // Bloqueio sem horário anunciado continua vestindo (não há prova de expiro).
  assert.match(guiLimitResultText({ status: 'session_limit' }, now), /session_limit/u)
})

test('Claude: o aviso de aproximação não para o turno e não se repete a cada lote', () => {
  const { events, line } = claudeAgentSession()
  const resetsAt = Math.floor(Date.now() / 1000) + 3_600

  line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt } })
  const aviso = events.at(-1)
  assert.equal(aviso.type, 'command-output', 'aviso é NOTA — o card de erro dizia que ACABOU')
  assert.match(aviso.text, /perto do limite/u)

  // O CLI reemite o evento a cada request: o fio não recebe mais nada.
  events.length = 0
  for (let i = 0; i < 3; i += 1) {
    line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt } })
  }
  assert.deepEqual(events, [], 'um carimbo por mudança de estado')

  // E o turno que falha por OUTRO motivo continua com o texto do CLI: aviso
  // não é bloqueio, então nada é vestido.
  const outro = claudeAgentSession()
  outro.session.activeTurnGeneration = 1
  outro.session.pendingTurnGenerations = [1]
  outro.line({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed_warning', resetsAt }
  })
  outro.events.length = 0
  outro.line({ type: 'result', is_error: true, result: 'o turno explodiu' })
  assert.equal(outro.events.at(-1).errorText, 'o turno explodiu')
})

test('Claude: bloqueio de verdade vira erro com receita e veste o result seguinte', () => {
  const { session, events, line } = claudeAgentSession()
  session.activeTurnGeneration = 1
  session.pendingTurnGenerations = [1]
  const resetsAt = Math.floor(Date.now() / 1000) + 1_800
  const ingles = 'You have hit your session limit - resets 8:20pm'

  line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt } })
  const card = events.at(-1)
  assert.equal(card.type, 'limit')
  assert.match(card.text, /atingido \(rejected\)/u)
  assert.match(card.text, /troque a conta no cabeçalho do chat/u)

  // O result que cai em cima fala PT-BR com a receita, no lugar do inglês cru.
  events.length = 0
  line({ type: 'result', is_error: true, result: ingles })
  const result = events.at(-1)
  assert.equal(result.type, 'result')
  assert.equal(result.isError, true)
  assert.match(result.errorText, /^o turno parou no limite do plano \(rejected\)/u)
  assert.match(result.errorText, /a conversa continua na conta nova/u)
  assert.doesNotMatch(result.errorText, /session limit/u, 'o inglês cru não é a voz da casa')
  // A palavra final do CLI continua publicada intacta — é ela que o redutor
  // compara com a última fala para matar a duplicata (R21.3, lado renderer).
  assert.equal(result.resultText, ingles)
})

test('Claude: queda do provedor (5xx) fala PT-BR com a receita — e erro comum passa cru', async () => {
  // Caso real do dono (print 2026-08-19): "API Error: 500 Internal server
  // error. This is a server-side issue, usually temporary — try…" cru no card.
  // A assinatura é o WRAPPER do próprio CLI ("API Error: 5xx"), o mesmo
  // precedente sondado do matcher transitório dos ajudantes — nunca as
  // palavras de conteúdo do modelo.
  const motor = await import('../.tmp/gui-sessions-test/main/maestroSession.js')
  assert.equal(
    typeof motor.guiProviderOutageText,
    'function',
    'a voz da queda do provedor mora numa função pura exportada'
  )

  const { session, events, line } = claudeAgentSession()
  session.activeTurnGeneration = 1
  session.pendingTurnGenerations = [1]
  const cru = 'API Error: 500 Internal server error. This is a server-side issue, usually temporary - try again shortly.'
  line({ type: 'result', is_error: true, result: cru })
  const result = events.at(-1)
  assert.equal(result.type, 'result')
  assert.equal(result.isError, true)
  assert.match(result.errorText, /provedor do Claude falhou do lado de L[ÁA] \(API 500/u)
  assert.match(result.errorText, /mande a mensagem de novo/u, 'a receita é obrigatória')
  assert.doesNotMatch(result.errorText, /Internal server error/u, 'o inglês cru não é a voz da casa')
  // A palavra final CRUA continua publicada — o redutor a compara com a última
  // fala para matar a duplicata (R21.3, lado renderer).
  assert.equal(result.resultText, cru)

  // Erro que NÃO é assinatura do wrapper passa intacto: vestir erro comum
  // esconderia o motivo real do dono.
  const { session: s2, events: e2, line: l2 } = claudeAgentSession()
  s2.activeTurnGeneration = 1
  s2.pendingTurnGenerations = [1]
  l2({ type: 'result', is_error: true, result: 'ENOENT: no such file or directory' })
  assert.match(e2.at(-1).errorText, /ENOENT/u)

  // O LIMITE armado VENCE a queda do provedor: mais específico fala primeiro.
  const { session: s3, events: e3, line: l3 } = claudeAgentSession()
  s3.activeTurnGeneration = 1
  s3.pendingTurnGenerations = [1]
  l3({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 1_800 }
  })
  l3({ type: 'result', is_error: true, result: cru })
  assert.match(e3.at(-1).errorText, /^o turno parou no limite do plano/u)
})

test('a tradução do limite tem fonte única e nenhuma heurística de conteúdo', () => {
  const source = readFileSync(new URL('../src/main/maestroSession.ts', import.meta.url), 'utf8')
  assert.match(
    source,
    /translateGuiRateLimit\(info, this\.rateLimitKey\)/u,
    'a tradução do rate_limit_event mora na função pura'
  )
  assert.match(
    source,
    /guiLimitResultText\(this\.rateLimitBlocked\)/u,
    'o result publica a voz da casa a partir do estado armado'
  )
  // Sinal ESTRUTURAL: o gatilho é o estado do protocolo, nunca uma varredura
  // nas PALAVRAS do erro do CLI (heurística de conteúdo é proibida na casa).
  assert.doesNotMatch(source, /evt\.result[^\n]*\.(?:includes|match|search)\(/u)
  // E o ramo do evento não monta texto na mão: era ele que jogava TODO status
  // não-allowed — o aviso inclusive — dentro do card de erro.
  const limitCase = source.slice(
    source.indexOf("case 'rate_limit_event': {"),
    source.indexOf("case 'result': {")
  )
  assert.doesNotMatch(
    limitCase,
    /info\.status !== 'allowed'/u,
    'o ramo antigo tratava allowed_warning como esgotado'
  )
  assert.doesNotMatch(limitCase, /type: 'limit'/u, 'o texto do limite tem fonte única')
})

// ————— R22: A MENSAGEM DO DONO FURA O TURNO-FORTALEZA —————
//
// Queixa do dono com print (19/08): o delegador estava num laço de
// `helper_result` esperando três ajudantes; ele mandou mensagem com "enviar
// agora", a bolha VOCÊ apareceu no fio — e o agente NÃO leu. Mensagem empurrada
// pro stdin no meio de um turno fica na fila INTERNA do CLI até o turno fechar,
// e pós-R19 isso é potencialmente horas. O único canal que alcança o modelo
// DENTRO do turno é o resultado de tool, e a casa já anda nele (o correio dos
// ajudantes). Estes testes provam a ROTA (a decisão é do MAIN) e o
// RECONCILIADOR (nenhum passo depende de entrega única).

const R22_PANE = 'gui-dev-r22'

/**
 * Bancada da rota: um pane DELEGADOR com sessão controlável (turno aberto ou
 * fechado à mão) e o pote INJETADO — nenhuma bancada pode dividir o pote global
 * do processo com outra.
 */
function ownerMailBench(over = {}) {
  assert.ok(
    ownerMailModule.GuiOwnerMailbox,
    'o módulo do pote do dono (guiOwnerMail) não existe — sem ele a fala do dono não tem onde esperar (R22.1)'
  )
  const ownerMail = over.ownerMail ?? new ownerMailModule.GuiOwnerMailbox()
  const journal = []
  const woken = []
  const sent = []
  const gui = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    record: (event, ids, detail) => journal.push({ event, ...ids, detail }),
    ownerMail,
    // A AUTORIDADE DA ROTA é do main: aqui, o duplo do registro de identidade.
    delegatorPane: (paneId) => (over.delegator ?? true) && paneId === R22_PANE
  })
  const interrupts = []
  const tags = []
  const session = {
    alive: true,
    turnActive: false,
    // R39.1 D2' — o STEER carimba a fala com o id da bolha; é por esse id que o
    // motor devolve o RECIBO DE LEITURA (sondado nos dois CLIs em 02/09).
    send: (text, tag) => {
      sent.push(text)
      tags.push(tag ?? null)
    },
    // R39 D1 — a fala com turno aberto PARA o turno: o duplo precisa do verbo,
    // e é ele que os testes contam para provar que a frota fica de fora.
    interrupt: () => {
      interrupts.push('turn')
      return true
    },
    // As duas CAPACIDADES que as sondas de 02/09 mediram (o produto pergunta ao
    // MOTOR, nunca ao nome da classe): o claude ecoa o recibo
    // (`msg_lifecycle_v1`) e preserva a fila no corte (`interrupt_receipt_v1`).
    supportsSteerReceipt: over.supportsSteerReceipt !== false,
    keepsQueuedOnInterrupt: over.keepsQueuedOnInterrupt !== false,
    kill: () => {
      session.alive = false
    }
  }
  let emit = () => undefined
  gui.spawnSession = (_input, sink) => {
    emit = sink
    sink({ type: 'ready', caps: { commands: [], models: [] } })
    return session
  }
  gui.attachHelpers({
    interruptPane: () => 0,
    status: () => [],
    wakePane: (paneId) => {
      woken.push(paneId)
      return 1
    }
  })
  const spawn = {
    paneId: R22_PANE,
    projectId: 'proj-r22',
    cli: 'claude',
    configDir: 'c',
    cwd: '/w',
    ...(over.spawn ?? {})
  }
  assert.equal(gui.create(spawn).ok, true)
  return {
    gui,
    ownerMail,
    session,
    sent,
    woken,
    journal,
    spawn,
    interrupts,
    tags,
    emit: (evt) => emit(evt),
    bubbles: () =>
      gui
        .state(spawn.paneId)
        .events.filter(({ evt }) => evt.type === 'user-message')
        .map(({ evt }) => evt.id)
  }
}

/** O microtask do reconciliador do fecho, drenado. */
const settleTicks = () => new Promise((resolve) => setTimeout(resolve, 0))

test('R22.1/R39.1 — turno ABERTO em pane delegador: a fala VAI ao CLI e uma cópia espera o recibo', () => {
  const bench = ownerMailBench()

  // Turno fechado: caminho de sempre, palavra por palavra.
  assert.equal(bench.gui.send(R22_PANE, 'abre 3 ajudantes', 'msg-1').ok, true)
  assert.deepEqual(bench.sent, ['abre 3 ajudantes'])

  // O TURNO-FORTALEZA: a frota trabalha e o turno não fecha. Pela R39.1 a fala
  // do dono NÃO espera mais o fecho — ela vai AGORA (steer) e o pote guarda a
  // cópia durável até o RECIBO DE LEITURA.
  bench.session.turnActive = true
  assert.equal(bench.gui.send(R22_PANE, 'para tudo: o schema mudou', 'msg-2').ok, true)

  assert.deepEqual(bench.sent, ['abre 3 ajudantes', 'para tudo: o schema mudou'])
  assert.deepEqual(bench.tags, [null, 'msg-2'], 'o steer viaja carimbado com o id da bolha')
  assert.equal(bench.ownerMail.count(R22_PANE), 1, 'a cópia durável não pode faltar')
  assert.equal(bench.ownerMail.peek(R22_PANE)[0].steered, true)
  assert.deepEqual(bench.interrupts, [], 'sem parar: o corte só acontece se o dono FORÇAR')

  // A BOLHA VOCÊ CONTINUA NO FIO: apresentação não é entrega.
  assert.deepEqual(bench.bubbles(), ['msg-1', 'msg-2'])

  // R22.3 — o long-poll da frota deste pane acorda AGORA (sem isto a tool do
  // Synkora em voo seguraria até 240s a fronteira que absorve a fala).
  assert.deepEqual(bench.woken, [R22_PANE])

  const posted = bench.journal.find((entry) => entry.event === 'gui-owner-steer')
  assert.ok(posted, 'a rota não deixou recibo na caixa-preta')
  assert.equal(posted.paneId, R22_PANE)
  assert.equal(posted.detail.messageId, 'msg-2')
})

test('R39.1 D1’ — pane que NÃO delega segue o MESMO desenho (a cerca da R22 caiu)', () => {
  // A R22 cercava a rota no pane DELEGADOR (o turno-fortaleza da frota). O caso
  // medido de 01/09 matou a cerca: a fala presa era num trecho de tools NATIVAS
  // (AskUserQuestion/Bash/Skill), que nenhuma carona alcança. Turno aberto é
  // turno aberto, em QUALQUER pane e QUALQUER CLI.
  const bench = ownerMailBench({ delegator: false })
  bench.session.turnActive = true
  assert.equal(bench.gui.send(R22_PANE, 'segue com isto também', 'msg-1').ok, true)
  assert.deepEqual(bench.sent, ['segue com isto também'])
  assert.equal(bench.ownerMail.count(R22_PANE), 1)
  assert.equal(bench.ownerMail.peek(R22_PANE)[0].steered, true)
  assert.deepEqual(bench.interrupts, [], 'o padrão do dono é sem parar')
})

test('R22.4 — o pote SEM marca (pedido parado) sai no fecho, pelo caminho de sempre', async () => {
  const bench = ownerMailBench()
  bench.session.turnActive = true
  // Permissão pendente = CLI parado esperando o dono: a fala não é steerada,
  // ela ESPERA no pote (rota `hold`) — é o caminho que o reconciliador cobre.
  bench.emit({
    type: 'permission',
    requestId: 'req-p',
    toolName: 'Bash',
    description: 'npm test',
    inputPretty: '{}',
    canAlways: true
  })
  assert.equal(bench.gui.send(R22_PANE, 'inverte a ordem das fatias', 'msg-1').ok, true)
  assert.deepEqual(bench.sent, [])
  assert.equal(bench.ownerMail.peek(R22_PANE)[0].steered, undefined)

  // O agente não chamou mais tool nenhuma: não houve carona, e o turno acaba.
  bench.session.turnActive = false
  bench.emit({ type: 'result', isError: false, outcome: 'completed' })
  await settleTicks()

  assert.equal(bench.sent.length, 1, 'o fecho tem de entregar o pote — a fala do dono nunca se perde')
  assert.match(bench.sent[0], /inverte a ordem das fatias/u, 'a fala do dono viaja VERBATIM')
  assert.equal(bench.ownerMail.count(R22_PANE), 1, 'sending is not a read receipt')
  bench.emit({ type: 'owner-steer-absorbed', tag: 'msg-1' })
  assert.equal(bench.ownerMail.count(R22_PANE), 0)
  // SEM BOLHA NOVA: a bolha saiu no envio, e o fecho é entrega, não fala.
  assert.deepEqual(bench.bubbles(), ['msg-1'])
  const flushed = bench.journal.find((entry) => entry.event === 'gui-owner-mail-flushed')
  assert.ok(flushed, 'o fecho não deixou recibo')
  assert.equal(flushed.detail.messages, 1)
  assert.equal(flushed.detail.reason, 'fecho-de-turno')
})

test('R22.4 — turno ainda VIVO no terminal do sub-resultado não consome o pote', async () => {
  const bench = ownerMailBench()
  bench.session.turnActive = true
  bench.emit({
    type: 'permission',
    requestId: 'req-p',
    toolName: 'Bash',
    description: 'npm test',
    inputPretty: '{}',
    canAlways: true
  })
  assert.equal(bench.gui.send(R22_PANE, 'olha isto agora', 'msg-1').ok, true)

  // `result` com o turno ainda ativo (a frota segura o turno lógico): a carona
  // ainda pode acontecer, e ela é melhor — chega ao modelo sem esperar o fim.
  bench.emit({ type: 'result', isError: false, continues: true })
  await settleTicks()
  assert.deepEqual(bench.sent, [])
  assert.equal(bench.ownerMail.count(R22_PANE), 1, 'o pote foi consumido cedo demais')
})

test('R22.4 — o pote atravessa o BOOT: o que não saiu volta do disco e sai na abertura', () => {
  assert.ok(
    ownerMailModule.createGuiOwnerMailStore,
    'o pote do dono não tem disco — um app que fecha engoliria a fala dele (R22.4)'
  )
  const dir = mkdtempSync(join(tmpdir(), 'synkora-owner-mail-'))
  const file = join(dir, ownerMailModule.GUI_OWNER_MAIL_STORE_FILE)
  try {
    const antes = new ownerMailModule.GuiOwnerMailbox()
    antes.attachStore(ownerMailModule.createGuiOwnerMailStore(file))
    assert.equal(
      antes.post(R22_PANE, {
        messageId: 'msg-1',
        text: 'quando voltar, começa por isto',
        at: Date.now()
      }),
      true
    )

    // BOOT NOVO: pote novo, o MESMO arquivo.
    const depois = new ownerMailModule.GuiOwnerMailbox()
    depois.attachStore(ownerMailModule.createGuiOwnerMailStore(file))
    assert.equal(depois.count(R22_PANE), 1, 'a fala do dono não sobreviveu ao fechamento do app')

    const bench = ownerMailBench({ ownerMail: depois })
    assert.deepEqual(
      bench.sent,
      ['quando voltar, começa por isto'],
      'a abertura do pane tem de entregar o que ficou no pote'
    )
    assert.equal(depois.count(R22_PANE), 1, 'recovered mail stays durable until the new native receipt')
    bench.emit({ type: 'owner-steer-absorbed', tag: 'msg-1' })
    assert.equal(depois.count(R22_PANE), 0)
    assert.equal(
      ownerMailModule.createGuiOwnerMailStore(file).load().length,
      0,
      'entregue, a fala tem de sair do disco também'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R22.4/R39.1 — o ■ do dono não engole a fala DELE: no motor que descarta a fila, o fecho entrega', async () => {
  // A sonda 3b (02/09) mediu o codex: `turn/interrupt` logo depois do steer
  // devolve `turn/completed` no mesmo milissegundo e a fala some. Se a cópia
  // continuasse marcada, as palavras do dono ficariam presas no pote até o pane
  // renascer — perda silenciosa, que é o que a casa não admite.
  const bench = ownerMailBench({ keepsQueuedOnInterrupt: false })
  bench.session.turnActive = true
  assert.equal(bench.gui.send(R22_PANE, 'para tudo e volta pro plano antigo', 'msg-1').ok, true)
  assert.deepEqual(bench.sent, ['para tudo e volta pro plano antigo'])

  assert.equal(bench.gui.interrupt(R22_PANE).ok, true)
  bench.session.turnActive = false
  bench.emit({ type: 'result', isError: false, outcome: 'cancelled', interrupted: true })
  await settleTicks()

  assert.equal(bench.sent.length, 2, 'o corte apagou o steer: o fecho tem de reentregar')
  assert.match(
    bench.sent[1],
    /para tudo e volta pro plano antigo/u,
    'o que o pote guarda são as PALAVRAS do dono — segurá-las seria perdê-las em silêncio'
  )
  const flushed = bench.journal.find((entry) => entry.event === 'gui-owner-hand')
  assert.equal(
    flushed.detail.reason,
    'fecho-por-interrupcao',
    'o diário tem de distinguir o fecho normal do fecho pelo ■'
  )
})

test('R39.1 — no motor que GUARDA a fila, o ■ não reentrega: o CLI já está com a fala', async () => {
  // O claude 2.1.258 lista a fala em `still_queued` e a promove a turno novo
  // sozinho (sonda 2). Reentregar aqui faria o dono falar duas vezes.
  const bench = ownerMailBench()
  bench.session.turnActive = true
  assert.equal(bench.gui.send(R22_PANE, 'muda o rumo', 'msg-1').ok, true)

  assert.equal(bench.gui.interrupt(R22_PANE).ok, true)
  bench.session.turnActive = false
  bench.emit({ type: 'result', isError: false, outcome: 'cancelled', interrupted: true })
  await settleTicks()

  assert.deepEqual(bench.sent, ['muda o rumo'])
  assert.equal(bench.ownerMail.count(R22_PANE), 1, 'a cópia continua sendo cinto até o recibo')
})

test('R22 — slash CRU no meio do turno continua indo ao binário: comando se executa', () => {
  const bench = ownerMailBench()
  bench.session.turnActive = true
  // `/compact` é `raw` no roteador do claude: ele atravessa o registro e é o
  // BINÁRIO que o executa. Guardá-lo no pote viraria texto sobre um comando —
  // o dono veria a bolha e nada aconteceria.
  assert.equal(bench.gui.send(R22_PANE, '/compact', 'msg-1').ok, true)
  assert.deepEqual(bench.sent, ['/compact'])
  assert.equal(bench.ownerMail.count(R22_PANE), 0, 'comando do dono nunca vira citação')
})

test('R22 — briefing pendente nunca vira citação: ele segue pelo caminho de PROMPT', () => {
  const bench = ownerMailBench({ spawn: { firstPrompt: 'CONTRATO DA MISSÃO' } })
  bench.session.turnActive = true
  assert.equal(bench.gui.send(R22_PANE, 'primeira fala', 'msg-1').ok, true)
  assert.equal(
    bench.ownerMail.count(R22_PANE),
    0,
    'o briefing da missão não pode viajar dentro de um resultado de tool'
  )
  assert.deepEqual(bench.sent, [guiBriefedPrompt('CONTRATO DA MISSÃO', 'primeira fala')])
})

// ————— R39 + R39.1: A FALA DO DONO SEM PARAR, E O "LER AGORA" —————
//
// R39 (02/09, manhã): "toda mensagem que eu enviar … ele vai parar, vai ler o
// que eu falei e vai complementar com o que ele tava fazendo". A rodada parava
// o turno SEMPRE.
//
// R39.1 (02/09, à tarde, depois de o dono ver bônus e ônus): "pode ser sem
// parar, puro. Aí minha mensagem vai ficar lá. Só que eu quero que tenha alguma
// coisa, tipo que ela não foi lida ainda… E se eu quiser eu posso forçar, aí
// forçando ele para o turno e lê o que eu quero falar, quando for algo
// urgente." O custo do corte (raciocínio e tool em voo jogados fora) é real, e
// a frota nunca esteve em risco (D1.c). Então:
//
//  - PADRÃO com turno vivo = STEER: a fala vai AGORA ao CLI e uma cópia durável
//    fica no pote, marcada `steered`, até o RECIBO DE LEITURA;
//  - o RECIBO é SONDADO, não presumido (`PROBE_STEER_RECEIPT_2026-09-02.md`):
//    no claude é `command_lifecycle{state:'started'}` do uuid que a casa
//    carimba (3,3 s do envio, medido); no codex é o `item/started` de
//    `userMessage` com o nosso `clientId` (16,5 s). É NELE que a dívida arma —
//    armar antes deixaria um texto já em voo quitar sem ele ter lido;
//  - "LER AGORA" (gesto do dono) corta SÓ o turno. A sonda 2 mediu os dois
//    motores divergindo: o claude PRESERVA a fala enfileirada (a resposta do
//    interrupt traz `still_queued` e o CLI a promove a turno novo 1 ms depois),
//    o codex a DESCARTA (`turn/completed` no mesmo milissegundo, nada depois).
//    Por isso o force pergunta a CAPACIDADE do motor, nunca o nome da classe.

const R39_PANE = 'gui-dev-r39'

/**
 * Bancada da fala do dono: pane sem frota (a cerca da R22 caiu), sessão de
 * verdade no prototype (o `answerQuestion` do registro exige MaestroSession) e
 * o pote, a dívida e o motor de ajudantes injetados — nenhuma bancada divide
 * pote global com outra.
 */
function ownerStopBench(over = {}) {
  assert.ok(ownerMailModule.GuiOwnerMailbox, 'o pote do dono (guiOwnerMail) não existe')
  assert.ok(
    ownerDebtModule.GuiOwnerReplyDebt,
    'a dívida de resposta (guiOwnerReplyDebt) não existe'
  )
  const ownerMail = over.ownerMail ?? new ownerMailModule.GuiOwnerMailbox()
  const replyDebt = new ownerDebtModule.GuiOwnerReplyDebt()
  const journal = []
  const live = []
  const sent = []
  const tags = []
  const interrupts = []
  const fleetInterrupts = []
  const wakes = []
  const answers = []
  const sessions = []
  const gui = new GuiSessionRegistry({
    push: (payload) => live.push(payload),
    systemPromptFile: () => undefined,
    record: (event, ids, detail) => journal.push({ event, ...ids, detail }),
    ownerMail,
    replyDebt,
    delegatorPane: () => over.delegator === true
  })
  const proto = over.cli === 'codex' ? CodexSession.prototype : MaestroSession.prototype
  let emit = () => undefined
  gui.spawnSession = (_input, sink) => {
    emit = sink
    // `alive` e `turnActive` são GETTERS no prototype dos dois motores: escrever
    // por cima estoura em modo estrito. O duplo os sombreia com dados próprios —
    // e as duas capacidades novas (recibo e fila-no-corte) entram pela mesma
    // porta, porque em produção elas também são getters.
    const session = Object.create(proto, {
      alive: { value: true, writable: true },
      turnActive: { value: false, writable: true },
      supportsSteerReceipt: {
        value: over.supportsSteerReceipt ?? true,
        writable: true
      },
      keepsQueuedOnInterrupt: {
        value: over.keepsQueuedOnInterrupt ?? over.cli !== 'codex',
        writable: true
      }
    })
    session.send = (text, tag) => {
      sent.push(text)
      tags.push(tag ?? null)
    }
    session.interrupt = () => {
      interrupts.push('turn')
      return true
    }
    session.answerQuestion = (requestId, map) => {
      answers.push({ requestId, map })
      return true
    }
    session.kill = () => {
      session.alive = false
    }
    sessions.push(session)
    sink({ type: 'ready', caps: { commands: [], models: [] } })
    return session
  }
  gui.attachHelpers({
    interruptPane: (paneId) => {
      fleetInterrupts.push(paneId)
      return 1
    },
    status: () => [],
    wakePane: (paneId) => {
      wakes.push(paneId)
      return 1
    }
  })
  // O ■ do dono descarta as pendências do despertador; nem o steer nem o "ler
  // agora" podem encostar nelas. O espião fica em volta do correlacionador real.
  const discards = []
  const realDiscard = gui.helperCards.discardPending.bind(gui.helperCards)
  gui.helperCards.discardPending = (paneId) => {
    discards.push(paneId)
    return realDiscard(paneId)
  }
  const spawn = {
    paneId: R39_PANE,
    projectId: 'proj-r39',
    cli: over.cli ?? 'claude',
    configDir: 'c',
    cwd: '/w',
    ...(over.spawn ?? {})
  }
  assert.equal(gui.create(spawn).ok, true)
  return {
    gui,
    spawn,
    ownerMail,
    replyDebt,
    journal,
    live,
    sent,
    tags,
    interrupts,
    fleetInterrupts,
    wakes,
    discards,
    answers,
    session: () => sessions[sessions.length - 1],
    emit: (evt) => emit(evt),
    states: (id) =>
      live
        .filter(({ evt }) => evt?.type === 'owner-message-state' && (!id || evt.id === id))
        .map(({ evt }) => evt.state),
    entry: (id) => bench_entry(ownerMail, R39_PANE, id),
    recreate: () => assert.equal(gui.create(spawn).ok, true)
  }
}

function bench_entry(ownerMail, paneId, messageId) {
  return ownerMail.peek(paneId).find((mail) => mail.messageId === messageId) ?? null
}

test("R39.1 D1' — turno aberto: a fala vai AGORA ao CLI e NADA é interrompido", () => {
  const bench = ownerStopBench()
  bench.session().turnActive = true

  assert.equal(bench.gui.send(R39_PANE, 'para tudo: o schema mudou', 'msg-1').ok, true)

  assert.deepEqual(
    bench.sent,
    ['para tudo: o schema mudou'],
    'o padrão do dono é SEM PARAR: a fala entra no turno em andamento'
  )
  assert.deepEqual(bench.tags, ['msg-1'], 'sem o carimbo não há recibo de leitura')
  assert.deepEqual(bench.interrupts, [], 'cortar joga fora raciocínio e tool em voo')
  assert.deepEqual(bench.fleetInterrupts, [], 'a frota só para no ■ do dono (D1.c)')
  assert.deepEqual(bench.discards, [], 'as pendências do despertador não são deste escopo')
  assert.deepEqual(bench.wakes, [R39_PANE], 'o long-poll da frota resolve AGORA (R22.3)')

  // A CÓPIA DURÁVEL fica esperando o recibo — nada depende de entrega única.
  assert.equal(bench.ownerMail.count(R39_PANE), 1)
  assert.equal(bench.entry('msg-1').steered, true)
  assert.equal(bench.entry('msg-1').handoff, undefined, 'steer não é handoff')

  // D6' — a bolha diz a verdade: entregue ao CLI, mas ainda NÃO LIDA.
  assert.deepEqual(bench.states('msg-1'), ['unread'])

  const steer = bench.journal.find((entry) => entry.event === 'gui-owner-steer')
  assert.ok(steer, 'o steer não deixou recibo na caixa-preta')
  assert.equal(steer.paneId, R39_PANE)
  assert.equal(steer.projectId, 'proj-r39')
  assert.equal(steer.detail.messageId, 'msg-1')
  assert.equal(steer.detail.chars, 'para tudo: o schema mudou'.length)
  assert.equal(steer.detail.pending, 1)
})

test("R39.1 D1' — o codex steera pelo MESMO desenho", () => {
  const bench = ownerStopBench({ cli: 'codex' })
  bench.session().turnActive = true
  assert.equal(bench.gui.send(R39_PANE, 'muda o rumo', 'msg-1').ok, true)
  assert.deepEqual(bench.sent, ['muda o rumo'])
  assert.deepEqual(bench.tags, ['msg-1'])
  assert.deepEqual(bench.interrupts, [])
  assert.equal(bench.entry('msg-1').steered, true)
})

test("R39.1 D2' — o RECIBO tira a cópia do pote, carimba LIDA e arma a dívida NESSE instante", () => {
  const bench = ownerStopBench()
  bench.session().turnActive = true
  assert.equal(bench.gui.send(R39_PANE, 'usa o outro schema', 'msg-1').ok, true)
  assert.equal(
    bench.replyDebt.pending(R39_PANE),
    null,
    'antes do recibo não há dívida: ele ainda não leu'
  )

  // O sinal SONDADO: no claude, `command_lifecycle{state:"started"}` do uuid
  // carimbado; no codex, o `item/started` de `userMessage` com o nosso id. Os
  // dois motores traduzem para o MESMO evento do harness.
  bench.emit({ type: 'owner-steer-absorbed', tag: 'msg-1' })

  assert.equal(bench.ownerMail.count(R39_PANE), 0, 'recibo visto = cópia apagada (entrega única)')
  assert.deepEqual(bench.states('msg-1'), ['unread', 'read'])
  assert.deepEqual(
    bench.replyDebt.pending(R39_PANE),
    ['usa o outro schema'],
    'a dívida arma no RECIBO — é aí que ele passou a dever resposta'
  )

  const read = bench.journal.find((entry) => entry.event === 'gui-owner-read')
  assert.ok(read, 'o recibo não deixou marca na caixa-preta')
  assert.equal(read.detail.messageId, 'msg-1')
  assert.equal(read.detail.signal, 'echo', 'sinal sondado, nunca presumido')
  assert.equal(typeof read.detail.msSinceSend, 'number')
})

test("R39.1 D2' — texto que já estava saindo NÃO quita: a dívida nasce só no recibo", () => {
  const bench = ownerStopBench()
  bench.session().turnActive = true
  assert.equal(bench.gui.send(R39_PANE, 'troca o rumo agora', 'msg-1').ok, true)

  // O modelo já estava emitindo esta frase quando a fala chegou ao CLI. Ela não
  // pode virar "respondida" — foi esse o buraco que a R39.1 fecha.
  bench.emit({ type: 'text', text: 'continuando o que eu já estava fazendo' })
  assert.deepEqual(bench.states('msg-1'), ['unread'], 'nada foi lido: nada foi respondido')

  bench.emit({ type: 'owner-steer-absorbed', tag: 'msg-1' })
  assert.deepEqual(bench.replyDebt.pending(R39_PANE), ['troca o rumo agora'])

  // Agora sim: o primeiro texto DEPOIS do recibo quita e carimba.
  bench.emit({ type: 'text', text: 'entendi, troco o schema e sigo daqui' })
  assert.deepEqual(bench.states('msg-1'), ['unread', 'read', 'answered'])
  assert.equal(bench.replyDebt.pending(R39_PANE), null)
})

test("R39.1 D2' — motor SEM eco cai no APROXIMADO: o primeiro tool-result depois do envio", () => {
  const bench = ownerStopBench({ supportsSteerReceipt: false })
  bench.session().turnActive = true
  assert.equal(bench.gui.send(R39_PANE, 'olha isto', 'msg-1').ok, true)
  assert.equal(bench.ownerMail.count(R39_PANE), 1)

  bench.emit({ type: 'tool-result', text: 'ok', toolUseId: 't-1' })

  assert.equal(bench.ownerMail.count(R39_PANE), 0)
  assert.deepEqual(bench.states('msg-1'), ['unread', 'read'])
  const read = bench.journal.find((entry) => entry.event === 'gui-owner-read')
  assert.equal(read.detail.signal, 'approx', 'aproximação declarada — o diário não finge medição')
})

test("R39.1 D2' — no APROXIMADO, o texto que serve de fronteira NÃO conta como resposta", () => {
  const bench = ownerStopBench({ supportsSteerReceipt: false })
  bench.session().turnActive = true
  assert.equal(bench.gui.send(R39_PANE, 'troca o rumo', 'msg-1').ok, true)

  // Sem tool nenhuma, a fronteira que a aproximação enxerga é o texto do modelo
  // — e esse texto já estava saindo quando a fala chegou. Ele PROVA a leitura,
  // mas não pode quitar a dívida que só nasce nesse instante.
  bench.emit({ type: 'text', text: 'seguindo com o que eu já estava fazendo' })
  assert.deepEqual(bench.states('msg-1'), ['unread', 'read'])
  assert.deepEqual(
    bench.replyDebt.pending(R39_PANE),
    ['troca o rumo'],
    'a fronteira não é a resposta: a dívida continua de pé'
  )

  bench.emit({ type: 'text', text: 'entendi, troco agora' })
  assert.deepEqual(bench.states('msg-1'), ['unread', 'read', 'answered'])
  assert.equal(bench.replyDebt.pending(R39_PANE), null)
})

test("R39.1 D2' — com eco disponível, o tool-result NÃO se adianta ao recibo", () => {
  const bench = ownerStopBench()
  bench.session().turnActive = true
  assert.equal(bench.gui.send(R39_PANE, 'olha isto', 'msg-1').ok, true)
  bench.emit({ type: 'tool-result', text: 'ok', toolUseId: 't-1' })
  assert.equal(
    bench.ownerMail.count(R39_PANE),
    1,
    'o eco chega milissegundos depois da fronteira: deixar o approx ganhar mentiria o sinal'
  )
  assert.deepEqual(bench.states('msg-1'), ['unread'])
})

test("R39.1 D3' — o fecho de turno PULA a cópia steerada (o CLI já está com ela)", async () => {
  const bench = ownerStopBench()
  bench.session().turnActive = true
  assert.equal(bench.gui.send(R39_PANE, 'faz do outro jeito', 'msg-1').ok, true)

  bench.session().turnActive = false
  bench.emit({ type: 'result', isError: false, outcome: 'completed' })
  await settleTicks()

  assert.deepEqual(
    bench.sent,
    ['faz do outro jeito'],
    'entregar de novo no fecho faria o dono falar duas vezes'
  )
  assert.equal(bench.ownerMail.count(R39_PANE), 1, 'sem recibo, a cópia continua de pé')
})

test("R39.1 D3' — o RENASCIMENTO entrega a cópia sem recibo (o processo morreu com ela dentro)", () => {
  const bench = ownerStopBench()
  const retiredSink = bench.gui.panes.get(R39_PANE).sink
  bench.session().turnActive = true
  assert.equal(bench.gui.send(R39_PANE, 'para e me responde', 'msg-1').ok, true)

  bench.session().kill()
  bench.emit({ type: 'closed', code: 1 })
  assert.equal(bench.ownerMail.count(R39_PANE), 1, 'a fala não pode morrer com o processo')

  // Enviar reabre a MESMA conversa (R23.2) e o nascimento flusha o pote.
  bench.recreate()
  assert.equal(bench.sent.length, 2)
  assert.match(bench.sent[1], /para e me responde/u)
  assert.equal(bench.ownerMail.count(R39_PANE), 1)
  assert.deepEqual(
    bench.states('msg-1'),
    ['unread', 'unread'],
    'a entrega do renascimento ainda espera seu próprio recibo'
  )

  // O BILHETE morreu com a geração: um recibo tardio da sessão morta não pode
  // carimbar "lida" numa bolha que o renascimento já entregou.
  retiredSink({ type: 'owner-steer-absorbed', tag: 'msg-1' })
  assert.deepEqual(bench.states('msg-1'), ['unread', 'unread'])
  bench.emit({ type: 'owner-steer-absorbed', tag: 'msg-1' })
  assert.deepEqual(bench.states('msg-1'), ['unread', 'unread', 'read'])
  assert.equal(bench.ownerMail.count(R39_PANE), 0)
})

test("R39.1 D4' — \"ler agora\": corta SÓ o turno e manda o envelope curto (motor que guarda a fila)", () => {
  const bench = ownerStopBench()
  bench.session().turnActive = true
  bench.emit({ type: 'tool', name: 'Bash', input: { command: 'npm run test:gui-system' } })
  assert.equal(bench.gui.send(R39_PANE, 'para: usa o outro schema', 'msg-1').ok, true)

  assert.equal(bench.gui.forceOwnerMessage(R39_PANE, 'msg-1').ok, true)

  assert.deepEqual(bench.interrupts, ['turn'], 'o gesto do dono corta o turno')
  assert.deepEqual(bench.fleetInterrupts, [], 'só o turno: a frota segue trabalhando')
  assert.deepEqual(bench.discards, [], 'o despertador não é deste escopo')
  assert.equal(bench.sent.length, 2, 'a fala (steer) + o envelope curto de retomada')
  const envelope = bench.sent[1]
  assert.match(envelope, /FORÇOU/u)
  assert.match(envelope, /Você estava em: Bash — /u, 'o envelope nomeia o passo cortado')
  assert.match(envelope, /npm run test:gui-system/u)
  assert.match(envelope, /Responda PRIMEIRO/u)
  assert.doesNotMatch(
    envelope,
    /para: usa o outro schema/u,
    'o CLI já promove a fala enfileirada a turno novo — repeti-la a entregaria DUAS vezes'
  )

  assert.deepEqual(bench.states('msg-1'), ['unread', 'stopping'])
  const force = bench.journal.find((entry) => entry.event === 'gui-owner-force')
  assert.ok(force, 'o gesto não deixou recibo')
  assert.equal(force.detail.messageId, 'msg-1')
  assert.equal(force.detail.stopped, true)
  assert.equal(force.detail.keptQueued, true)
  assert.match(force.detail.lastStep, /Bash/u)
})

test("R39.1 D4'/D6' — depois do corte, o recibo vira LIDA e o texto vira RESPONDIDA", () => {
  const bench = ownerStopBench()
  bench.session().turnActive = true
  assert.equal(bench.gui.send(R39_PANE, 'olha isto agora', 'msg-1').ok, true)
  assert.equal(bench.gui.forceOwnerMessage(R39_PANE, 'msg-1').ok, true)

  // O CLI promove a fala a TURNO NOVO sozinho (sonda 2: 1 ms depois do result
  // interrompido) e o recibo dela chega como sempre.
  bench.emit({ type: 'result', isError: false, outcome: 'cancelled', interrupted: true })
  bench.emit({ type: 'owner-steer-absorbed', tag: 'msg-1' })
  bench.emit({ type: 'text', text: 'entendi: mudo agora e retomo de onde parei' })

  assert.deepEqual(bench.states('msg-1'), ['unread', 'stopping', 'read', 'answered'])
  assert.equal(bench.ownerMail.count(R39_PANE), 0)
  assert.equal(bench.replyDebt.pending(R39_PANE), null, 'o texto do assistente quita')
})

test("R39.1 D4' — no motor que DESCARTA a fila (codex), o force reentrega com o envelope inteiro", async () => {
  const bench = ownerStopBench({ cli: 'codex' })
  bench.session().turnActive = true
  bench.emit({ type: 'tool', name: 'shell', input: { command: 'npm test' } })
  assert.equal(bench.gui.send(R39_PANE, 'para: o schema mudou', 'msg-1').ok, true)
  assert.equal(bench.gui.forceOwnerMessage(R39_PANE, 'msg-1').ok, true)

  assert.deepEqual(bench.interrupts, ['turn'])
  const force = bench.journal.find((entry) => entry.event === 'gui-owner-force')
  assert.equal(force.detail.keptQueued, false, 'a sonda mediu: no codex o corte apaga o steer')

  bench.session().turnActive = false
  bench.emit({ type: 'result', isError: false, outcome: 'cancelled', interrupted: true })
  await settleTicks()

  assert.equal(bench.sent.length, 2)
  const hand = bench.sent[1]
  assert.match(hand, /para: o schema mudou/u, 'a fala do dono viaja VERBATIM — perder é pior que dobrar')
  assert.match(hand, /você foi PARADO para lê-la/u)
  assert.match(hand, /Você estava em: shell/u)
  assert.deepEqual(bench.replyDebt.pending(R39_PANE), ['para: o schema mudou'])
  assert.deepEqual(bench.states('msg-1'), ['unread', 'stopping', 'delivered'],
    'reenviar após o corte comprova entrega, não leitura pelo Codex')
  assert.equal(bench.ownerMail.count(R39_PANE), 0)
  bench.emit({ type: 'text', text: 'entendi, retomo a tarefa' })
  assert.deepEqual(bench.states('msg-1'), ['unread', 'stopping', 'delivered', 'answered'])
})

test('pergunta do Codex usa o cartão e devolve a resposta pelo mesmo registro', () => {
  const bench = ownerStopBench({ cli: 'codex' })
  bench.session().turnActive = true
  bench.emit({ type: 'question', requestId: 'rpc-question', questions: [
    { id: 'direction', question: 'Qual caminho?', options: [{ label: 'A' }] }
  ] })
  assert.equal(bench.gui.answerQuestion(R39_PANE, 'rpc-question', { direction: 'A' }).ok, true)
  assert.deepEqual(bench.answers, [{ requestId: 'rpc-question', map: { direction: 'A' } }])
  const resolution = bench.live.find(x => x.evt.type === 'interaction-resolved').evt.resolution
  assert.deepEqual(resolution.entries, [{ question: 'Qual caminho?', answer: 'A' }])
})

test('pergunta opcional do Codex não retém uma nova orientação escrita no composer', () => {
  const bench = ownerStopBench({ cli: 'codex' })
  bench.session().turnActive = true
  bench.emit({ type: 'question', requestId: 'rpc-optional', blocking: false, questions: [
    { id: 'direction', question: 'Qual caminho?', allowCustom: false, options: [{ label: 'A' }] }
  ] })
  assert.equal(bench.gui.send(R39_PANE, 'continue com a validação', 'new-guidance').ok, true)
  assert.deepEqual(bench.sent, ['continue com a validação'])
  assert.deepEqual(bench.answers, [])
  assert.deepEqual(bench.states('new-guidance'), ['unread'])
})

test('pergunta livre do Codex preserva identidade e natureza no replay', () => {
  const event = { type: 'question', requestId: 'rpc-free', blocking: false, questions: [
    { id: 'detail', question: 'Qual detalhe?', header: 'Detalhe', allowCustom: true, options: [] }
  ] }
  assert.equal(isGuiPersistedEvent(event), true)
  const ring = new GuiEventRing()
  ring.push(event)
  assert.deepEqual(ring.snapshot(), [event])
  assert.equal(isGuiPersistedEvent({ ...event, blocking: 'false' }), false)
  assert.equal(isGuiPersistedEvent({ ...event, questions: [{ ...event.questions[0], id: 42 }] }), false)
})

test("R39.1 D4' — forçar uma fala JÁ LIDA é no-op, com nota no diário", () => {
  const bench = ownerStopBench()
  bench.session().turnActive = true
  assert.equal(bench.gui.send(R39_PANE, 'a que ele já leu', 'msg-1').ok, true)
  bench.emit({ type: 'owner-steer-absorbed', tag: 'msg-1' })

  assert.equal(bench.gui.forceOwnerMessage(R39_PANE, 'msg-1').ok, true)
  assert.deepEqual(bench.interrupts, [], 'cortar um turno por uma fala já lida seria dano puro')
  assert.equal(bench.sent.length, 1)
  const notes = bench.journal.filter((entry) => entry.event === 'gui-owner-force')
  assert.equal(notes.length, 1)
  assert.equal(notes[0].detail.noop, true)
  assert.deepEqual(bench.states('msg-1'), ['unread', 'read'], 'nenhum carimbo novo')
})

test("R39.1 D1' — duas falas seguidas: as duas viajam, as duas esperam recibo", () => {
  const bench = ownerStopBench()
  bench.session().turnActive = true
  assert.equal(bench.gui.send(R39_PANE, 'primeira ordem', 'msg-1').ok, true)
  assert.equal(bench.gui.send(R39_PANE, 'na verdade, faz assim', 'msg-2').ok, true)

  assert.deepEqual(bench.sent, ['primeira ordem', 'na verdade, faz assim'])
  assert.deepEqual(bench.tags, ['msg-1', 'msg-2'])
  assert.equal(bench.ownerMail.count(R39_PANE), 2)
  assert.deepEqual(bench.states('msg-1'), ['unread'])
  assert.deepEqual(bench.states('msg-2'), ['unread'])

  bench.emit({ type: 'owner-steer-absorbed', tag: 'msg-1' })
  assert.equal(bench.ownerMail.count(R39_PANE), 1, 'o recibo de uma não pode apagar a outra')
  assert.deepEqual(bench.states('msg-2'), ['unread'])
})

test('R39 D5 — pergunta aberta: a fala do dono vira a RESPOSTA, sem interromper nada', () => {
  const bench = ownerStopBench()
  bench.session().turnActive = true
  bench.emit({
    type: 'question',
    requestId: 'req-1',
    questions: [{ question: 'Qual caminho?', options: [{ label: 'A' }, { label: 'B' }] }]
  })

  assert.equal(bench.gui.send(R39_PANE, 'vai pelo B, e só o painel', 'msg-1').ok, true)

  assert.deepEqual(
    bench.answers,
    [{ requestId: 'req-1', map: { 'Qual caminho?': 'vai pelo B, e só o painel' } }],
    'com o CLI parado esperando o dono não há turno a steerar: o texto dele É a resposta'
  )
  assert.deepEqual(bench.interrupts, [])
  assert.equal(bench.ownerMail.count(R39_PANE), 0)
  assert.deepEqual(bench.sent, [])
  assert.deepEqual(bench.states('msg-1'), ['delivered'])
  const resolved = bench.gui
    .state(R39_PANE)
    .events.filter(({ evt }) => evt.type === 'interaction-resolved')
  assert.equal(resolved.length, 1, 'o card tem de fechar no fio')
})

test('R39 D5 — permissão aberta: a fala ESPERA no pote e o carimbo só sai na entrega', async () => {
  const bench = ownerStopBench()
  bench.session().turnActive = true
  bench.emit({
    type: 'permission',
    requestId: 'req-p',
    toolName: 'Bash',
    description: 'npm test',
    inputPretty: '{}',
    canAlways: true
  })

  assert.equal(bench.gui.send(R39_PANE, 'pode rodar sim', 'msg-1').ok, true)
  assert.deepEqual(bench.interrupts, [], 'permissão pendente = CLI parado: não há turno a cortar')
  assert.deepEqual(bench.sent, [], 'nem steer: o CLI não está processando nada')
  assert.equal(bench.ownerMail.count(R39_PANE), 1)
  assert.equal(bench.entry('msg-1').steered, undefined)
  assert.deepEqual(bench.states('msg-1'), [], 'nada foi entregue ainda: carimbar seria mentir')

  bench.session().turnActive = false
  bench.emit({ type: 'result', isError: false, outcome: 'completed' })
  await settleTicks()
  assert.equal(bench.sent.length, 1)
  assert.deepEqual(bench.states('msg-1'), ['unread'])
  bench.emit({ type: 'owner-steer-absorbed', tag: 'msg-1' })
  assert.deepEqual(bench.states('msg-1'), ['unread', 'read'])
})

test('R39 D1 — o ■ do dono continua sendo o único que para a FROTA', () => {
  const bench = ownerStopBench()
  bench.session().turnActive = true
  assert.equal(bench.gui.interrupt(R39_PANE).ok, true)
  assert.deepEqual(bench.interrupts, ['turn'])
  assert.deepEqual(bench.fleetInterrupts, [R39_PANE], 'o ■ para a frota preservando')
  assert.deepEqual(bench.discards, [R39_PANE], 'e descarta as pendências do despertador')
})

// ————— R25 — COTA VISÍVEL (odômetro da conversa) —————
//
// Auditoria de 2026-08-20: a conversa velha da missão 53889719 fez 139 chamadas
// re-lendo ~192k CADA — ~70% da janela de 5h do seat — enquanto o app mostrava
// só a ocupação da janela (7%). A física não estava escondida: faltava medidor.
// Estas suítes prendem o medidor no MAIN (o renderer remonta; o acumulado não
// pode morrer com ele) e a nota com RECEITA quando a conversa fica pesada.

/** Registro de teste com um backend que só devolve o sink. */
function odometerBench({ record, paneId = 'gui-dev-odo1234', spawn = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-gui-odometer-'))
  const sinks = []
  const spawns = []
  const gui = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    storeFile: join(root, 'gui-sessions.json'),
    ...(record ? { record } : {})
  })
  gui.spawnSession = (input, sink) => {
    spawns.push({ ...input })
    sinks.push(sink)
    sink({
      type: 'init',
      model: 'claude',
      sessionId: 'sess-1',
      permissionMode: 'default',
      toolCount: 0,
      contextWindow: 1_000_000
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
  const base = {
    paneId,
    projectId: 'proj-odometer',
    cli: 'claude',
    configDir: 'seat-a',
    cwd: root,
    ...spawn
  }
  assert.equal(gui.create(base).ok, true)
  return {
    gui,
    root,
    paneId,
    base,
    spawns,
    sink: (evt) => sinks.at(-1)(evt),
    /** Uma chamada de API, com as parcelas que o motor passa a carregar. */
    apiCall: ({ input = 3, cacheWrite = 0, cacheRead = 0, output = 0 }) =>
      sinks.at(-1)({
        type: 'context-usage',
        contextTokens: input + cacheWrite + cacheRead + output,
        contextWindow: 1_000_000,
        call: {
          inputTokens: input,
          cacheWriteTokens: cacheWrite,
          cacheReadTokens: cacheRead,
          outputTokens: output
        }
      }),
    lastContext: () =>
      gui
        .state(paneId)
        .events.map(({ evt }) => evt)
        .filter((evt) => evt.type === 'context-usage')
        .at(-1),
    notes: () =>
      gui
        .state(paneId)
        .events.map(({ evt }) => evt)
        .filter((evt) => evt.type === 'command-output')
        .map((evt) => evt.text)
  }
}

test('R25.1 — o motor do claude carrega as PARCELAS de cada chamada de API', () => {
  const { events, line } = claudeAgentSession()
  line({ type: 'system', subtype: 'init', session_id: 's-ctx', model: 'claude-fable-5' })
  events.length = 0

  claudeApiCall(line, { cacheRead: 174_276, cacheCreate: 335, out: 1_217 })

  const usage = events.find((event) => event.type === 'context-usage')
  // A ocupação da janela (o que o R20 já media) continua igual…
  assert.equal(usage.contextTokens, 175_830)
  // …e agora a mesma fotografia carrega o que aquela chamada CUSTOU. Sem isto o
  // main não tem como somar nada: `message.usage` morre dentro do motor.
  assert.deepEqual(usage.call, {
    inputTokens: 2,
    cacheWriteTokens: 335,
    cacheReadTokens: 174_276,
    outputTokens: 1_217
  })

  // E a mesma cerca de sempre continua valendo: `usage` todo zerado é a
  // assinatura da mensagem SINTÉTICA (/usage, /context) — nem medida, nem
  // parcela, senão o odômetro contaria uma chamada de API que não existiu.
  events.length = 0
  line({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0
      },
      content: [{ type: 'text', text: 'Current session: 48% used' }]
    }
  })
  assert.equal(
    events.some((event) => event.type === 'context-usage'),
    false,
    'comando local não é chamada de API — nem medida, nem parcela'
  )
})

test('R25.1 — o codex carrega as parcelas do `last` (nunca do acumulado)', () => {
  const session = Object.create(CodexSession.prototype)
  const events = []
  session.emit = (event) => events.push(event)
  session.turnId = 'turn-1'

  // Frame REAL da sonda de 2026-08-17 (codex app-server 0.147.0): o `last` traz
  // input/cached/cacheWrite/output — as mesmas quatro parcelas do claude.
  const frame = {
    tokenUsage: {
      total: {
        totalTokens: 37_535,
        inputTokens: 37_298,
        cachedInputTokens: 23_808,
        outputTokens: 237
      },
      last: {
        totalTokens: 18_831,
        inputTokens: 18_734,
        cachedInputTokens: 18_304,
        cacheWriteInputTokens: 0,
        outputTokens: 97,
        reasoningOutputTokens: 0
      },
      modelContextWindow: 258_400
    }
  }
  session.handleNotification('thread/tokenUsage/updated', frame)
  assert.equal(events[0].contextTokens, 18_831)
  assert.deepEqual(events[0].call, {
    inputTokens: 430,
    cacheWriteTokens: 0,
    cacheReadTokens: 18_304,
    outputTokens: 97
  })

  // O `thread/resume` REEMITE a mesma fotografia antes de qualquer request novo
  // (frame 7 da sonda, idêntico ao 6): sem turno vivo ela volta como MEDIDA — o
  // medidor do pane retomado acende na hora — e nunca como GASTO.
  events.length = 0
  session.turnId = null
  session.handleNotification('thread/tokenUsage/updated', frame)
  assert.equal(events[0].contextTokens, 18_831, 'a régua do contexto volta no resume')
  assert.equal(
    Object.hasOwn(events[0], 'call'),
    false,
    'replay de retomada não pode cobrar uma chamada que não aconteceu'
  )
})

test('R25.1 — o MAIN acumula por conversa e o acumulado viaja no context-usage', (t) => {
  const bench = odometerBench()
  t.after(() => rmSync(bench.root, { recursive: true, force: true }))

  // Nascimento: escreve o cache do prompt-base inteiro (a conta que o dono viu).
  bench.apiCall({ input: 1_200, cacheWrite: 30_000, cacheRead: 0, output: 400 })
  bench.apiCall({ input: 40, cacheWrite: 900, cacheRead: 31_200, output: 250 })

  // peso = cw×1,25 + cr×0,1 + input×1 + out×5 (aproximação de COTA, não preço)
  const peso = 30_900 * 1.25 + 31_200 * 0.1 + 1_240 + 650 * 5
  const last = bench.lastContext()
  assert.equal(last.convCalls, 2, 'o odômetro conta CHAMADAS, não turnos')
  assert.equal(last.convWeightTokens, Math.round(peso))
  assert.equal(
    Object.hasOwn(last, 'call'),
    false,
    'a parcela é transporte motor→main; ao renderer vai o TOTAL'
  )

  // O documento é a memória: remontar o renderer não pode zerar o odômetro.
  assert.deepEqual(bench.gui.remembered(bench.paneId).conversationUsage, {
    apiCalls: 2,
    cacheWriteTokens: 30_900,
    cacheReadTokens: 31_200,
    inputTokens: 1_240,
    outputTokens: 650
  })
})

test('R25.1 — respawn com resume CONTINUA o acumulado; /clear ZERA', (t) => {
  const bench = odometerBench()
  t.after(() => rmSync(bench.root, { recursive: true, force: true }))

  bench.apiCall({ input: 100, cacheWrite: 20_000, cacheRead: 0, output: 300 })
  assert.equal(bench.gui.remembered(bench.paneId).conversationUsage.apiCalls, 1)

  // Trocar o modo de permissão respawna com resume: a MESMA conversa continua,
  // e o cache que o processo novo re-escreve é justamente o custo que o dono
  // precisa ver somado — não um contador zerado fingindo conversa nova.
  assert.equal(bench.gui.create({ ...bench.base, permissionMode: 'plan' }).ok, true)
  assert.equal(bench.spawns.length, 2)
  bench.apiCall({ input: 50, cacheWrite: 20_500, cacheRead: 0, output: 120 })
  const continued = bench.gui.remembered(bench.paneId).conversationUsage
  assert.equal(continued.apiCalls, 2, 'respawn-com-resume não é conversa nova')
  assert.equal(continued.cacheWriteTokens, 40_500)

  // /clear é troca deliberada de conversa: o odômetro nasce de novo com ela.
  assert.equal(bench.gui.send(bench.paneId, '/clear', 'msg-clear').ok, true)
  assert.equal(bench.gui.remembered(bench.paneId).conversationUsage, undefined)
  assert.equal(
    bench.gui.state(bench.paneId).events.some(({ evt }) => evt.type === 'context-usage'),
    false,
    'o fio zerado não pode replayar o odômetro da conversa anterior'
  )
})

test('R25.1 — compactar NÃO zera o odômetro: o gasto já aconteceu', (t) => {
  const bench = odometerBench()
  t.after(() => rmSync(bench.root, { recursive: true, force: true }))

  bench.apiCall({ input: 100, cacheWrite: 40_000, cacheRead: 120_000, output: 800 })
  // `thread/compacted` do codex invalida a fotografia (context-usage nulo). A
  // janela encolheu; a cota gasta continua gasta.
  bench.sink({ type: 'context-usage', contextTokens: null, contextWindow: null })
  assert.equal(bench.gui.remembered(bench.paneId).conversationUsage.apiCalls, 1)
  assert.equal(bench.lastContext().convCalls, 1, 'a fotografia sem medida ainda carrega o total')
})

test('R25.3b — conversa pesada NÃO fala no fio: o marco vai ao diário e a tela avisa no medidor', async (t) => {
  // Ordem do dono (2026-09-16): a nota no fio "é feia; um aviso em tooltip
  // seria melhor". O marco continua AUDITADO uma vez por degrau; a receita
  // mora no tooltip/painel do medidor de contexto (renderer, guiCostSignals).
  const journal = []
  const bench = odometerBench({
    record: (event, ids, detail) => journal.push({ event, ids, detail })
  })
  t.after(() => rmSync(bench.root, { recursive: true, force: true }))

  bench.apiCall({ input: 10, cacheWrite: 1_000, cacheRead: 140_000, output: 100 })
  await settleTicks()
  assert.deepEqual(bench.notes(), [], 'abaixo do limiar o app não fala nada')

  bench.apiCall({ input: 10, cacheWrite: 1_000, cacheRead: 158_000, output: 100 })
  await settleTicks()
  assert.deepEqual(bench.notes(), [], 'cruzar o marco não escreve nota no fio')

  bench.apiCall({ input: 10, cacheWrite: 1_000, cacheRead: 170_000, output: 100 })
  await settleTicks()
  bench.apiCall({ input: 10, cacheWrite: 1_000, cacheRead: 305_000, output: 100 })
  await settleTicks()
  assert.deepEqual(bench.notes(), [], 'nem o marco seguinte')

  const audited = journal.filter((entry) => entry.event === 'gui-heavy-conversation')
  assert.equal(audited.length, 2, 'todo advisory é AUDITADO na caixa-preta, uma vez por marco')
  assert.equal(audited[0].ids.paneId, bench.paneId)
  assert.equal(audited[0].detail.milestone, 150_000)
  assert.equal(audited[1].detail.milestone, 300_000)
})

test('R25.3 — o aviso é ADVISORY: nada bloqueia, o envio segue livre', async (t) => {
  const bench = odometerBench()
  t.after(() => rmSync(bench.root, { recursive: true, force: true }))
  bench.apiCall({ input: 10, cacheWrite: 1_000, cacheRead: 400_000, output: 100 })
  await settleTicks()
  assert.equal(bench.notes().length, 0)
  assert.equal(
    bench.gui.send(bench.paneId, 'segue assim mesmo', 'msg-heavy').ok,
    true,
    'custo é JULGAMENTO: advisory auditado, nunca guarda dura'
  )
})

test('R25.1 — o odômetro atravessa o disco e volta no replay', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-gui-odometer-disk-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const storeFile = join(root, 'gui-sessions.json')
  const paneId = 'gui-dev-ododisk'
  writeFileSync(
    storeFile,
    JSON.stringify({
      panes: {
        [paneId]: {
          sessionId: 'sess-disk',
          cli: 'claude',
          projectId: 'proj-odometer',
          updatedAt: new Date().toISOString(),
          permissionMode: 'default',
          contextTokens: 190_000,
          contextWindow: 1_000_000,
          contextSessionId: 'sess-disk',
          conversationUsage: {
            apiCalls: 139,
            cacheWriteTokens: 285_000,
            cacheReadTokens: 26_700_000,
            inputTokens: 4_000,
            outputTokens: 114_000
          },
          heavyContextMilestone: 150_000
        }
      },
      transcripts: {
        [paneId]: {
          events: [
            {
              type: 'context-usage',
              contextTokens: 190_000,
              contextWindow: 1_000_000,
              convCalls: 139,
              convWeightTokens: 3_599_250
            }
          ],
          cursor: 1,
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
  const replayed = gui
    .state(paneId)
    .events.map(({ evt }) => evt)
    .find((evt) => evt.type === 'context-usage')
  assert.equal(replayed.convCalls, 139, 'a última fotografia carrega o total: replay de graça')
  assert.equal(replayed.convWeightTokens, 3_599_250)

  let live
  gui.spawnSession = (_input, sink) => {
    live = sink
    sink({
      type: 'init',
      model: 'claude',
      sessionId: 'sess-disk',
      permissionMode: 'default',
      toolCount: 0,
      contextWindow: 1_000_000
    })
    return { alive: true, turnActive: false, send: () => undefined, kill: () => undefined }
  }
  assert.equal(
    gui.create({
      paneId,
      projectId: 'proj-odometer',
      cli: 'claude',
      configDir: 'seat-a',
      cwd: root,
      resumeSessionId: 'sess-disk'
    }).ok,
    true
  )
  // O restart do app re-escreve o cache do contexto inteiro (custo estrutural
  // medido na auditoria): a chamada seguinte SOMA na mesma conversa.
  live({
    type: 'context-usage',
    contextTokens: 191_000,
    contextWindow: 1_000_000,
    call: {
      inputTokens: 10,
      cacheWriteTokens: 190_000,
      cacheReadTokens: 0,
      outputTokens: 300
    }
  })
  await settleTicks()
  const kept = gui.remembered(paneId).conversationUsage
  assert.equal(kept.apiCalls, 140, 'reabrir o app continua a MESMA conversa')
  assert.equal(kept.cacheWriteTokens, 475_000)
  // E o marco já anunciado não volta a falar depois de um restart.
  assert.equal(gui.remembered(paneId).heavyContextMilestone, 150_000)
  assert.equal(
    gui
      .state(paneId)
      .events.some(({ evt }) => evt.type === 'command-output'),
    false,
    'marco já anunciado atravessa o disco: o app não repete a nota a cada restart'
  )
})

test('R25.1 — hidratação valida o odômetro persistido', () => {
  assert.equal(
    isGuiPersistedEvent({
      type: 'context-usage',
      contextTokens: 190_000,
      contextWindow: 1_000_000,
      convCalls: 139,
      convWeightTokens: 3_599_250
    }),
    true
  )
  assert.equal(
    isGuiPersistedEvent({
      type: 'context-usage',
      contextTokens: 1,
      contextWindow: 2,
      convCalls: 'muitas'
    }),
    false,
    'documento adulterado não injeta odômetro inventado'
  )
  assert.equal(
    isGuiPersistedEvent({
      type: 'context-usage',
      contextTokens: 1,
      contextWindow: 2,
      convWeightTokens: -5
    }),
    false
  )
})

// ————— R25.1 — O PESO, EM MÓDULO PURO —————
//
// A constante é APROXIMAÇÃO de COTA, não preço: com assinatura o CLI não
// reporta dinheiro nenhum. Os multiplicadores saem da auditoria de 2026-08-20
// (peso ≈ cw×1,25 + cr×0,1 + input×1 + out×5), que reproduziu 81% da janela de
// 5h a partir dos transcripts reais dos seats.

test('R25.1 — o peso da conversa é a soma ponderada das parcelas', () => {
  const usage = guiAddApiCall(undefined, {
    inputTokens: 1_200,
    cacheWriteTokens: 30_000,
    cacheReadTokens: 0,
    outputTokens: 400
  })
  assert.deepEqual(usage, {
    apiCalls: 1,
    cacheWriteTokens: 30_000,
    cacheReadTokens: 0,
    inputTokens: 1_200,
    outputTokens: 400
  })
  assert.equal(guiConversationWeightTokens(usage), Math.round(30_000 * 1.25 + 1_200 + 400 * 5))

  // A conversa medida na auditoria (missão 53889719, janela das 5h).
  const auditada = {
    apiCalls: 139,
    cacheWriteTokens: 285_000,
    cacheReadTokens: 26_700_000,
    inputTokens: 0,
    outputTokens: 114_000
  }
  const peso = guiConversationWeightTokens(auditada)
  assert.equal(peso, 3_596_250)
  // ~3,3M no relatório (arredondado) — a mesma ordem de grandeza, e ~70% de uma
  // janela de ~4,7M. É este número que o app passa a mostrar.
  assert.ok(peso > 3_000_000 && peso < 4_000_000)

  assert.equal(guiConversationWeightTokens(undefined), 0)
})

test('R25.1 — parcela suja nunca vira gasto inventado', () => {
  const base = { inputTokens: 10, cacheWriteTokens: 20, cacheReadTokens: 30, outputTokens: 40 }
  const usage = guiAddApiCall(undefined, base)
  for (const ruim of [undefined, null, 42, 'parcelas', { inputTokens: 'x' }, { inputTokens: -1 }]) {
    assert.deepEqual(guiAddApiCall(usage, ruim), usage, `parcela inválida: ${String(ruim)}`)
  }
  // Documento adulterado não vira ponto de partida do acumulado.
  assert.equal(isGuiConversationUsage(usage), true)
  assert.equal(isGuiConversationUsage({ ...usage, apiCalls: -3 }), false)
  assert.equal(isGuiConversationUsage({ ...usage, inputTokens: 1.5 }), false)
  assert.equal(isGuiConversationUsage({ apiCalls: 1 }), false)
  assert.equal(isGuiConversationUsage(null), false)
})

test('R25.3 — o marco é de 150k; a receita mora no medidor do renderer (guiCostSignals)', () => {
  assert.equal(GUI_HEAVY_CONTEXT_TOKENS, 150_000)
  assert.equal(guiHeavyContextMilestone(149_999), null)
  assert.equal(guiHeavyContextMilestone(150_000), 150_000)
  assert.equal(guiHeavyContextMilestone(299_999), 150_000)
  assert.equal(guiHeavyContextMilestone(326_000), 300_000)
  assert.equal(guiHeavyContextMilestone(null), null)
  assert.equal(guiHeavyContextMilestone(Number.NaN), null)
})

test('o item solto no chat é revalidado pelo main: pasta vira referência, arquivo volta com tamanho', () => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-dropped-'))
  try {
    const folder = join(root, 'Documentos da Luma')
    mkdirSync(folder)
    const file = join(root, 'nota.txt')
    writeFileSync(file, 'abc')

    // A pasta arrastada do Explorer: a MESMA referência que o diálogo nativo
    // emitiria — o FileReader do renderer nunca mais a vê.
    const dropped = resolveGuiDroppedTarget(folder)
    assert.equal(dropped.ok, true)
    if (dropped.ok) {
      assert.equal(dropped.kind, 'folder')
      assert.equal(dropped.path, folder)
    }
    const droppedFile = resolveGuiDroppedTarget(file)
    assert.deepEqual(droppedFile, { ok: true, kind: 'file', path: file, size: 3 })

    const missing = resolveGuiDroppedTarget(join(root, 'sumiu'))
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.match(missing.error, /não está mais disponível/u)
    const relative = resolveGuiDroppedTarget('Documentos da Luma')
    assert.equal(relative.ok, false)
    if (!relative.ok) assert.match(relative.error, /[+]/u, 'a recusa nomeia a receita (o + do composer)')
    assert.equal(resolveGuiDroppedTarget(undefined).ok, false)
    assert.equal(resolveGuiDroppedTarget({ path: folder }).ok, false)

    const link = join(root, 'atalho')
    symlinkSync(folder, link, process.platform === 'win32' ? 'junction' : 'dir')
    const viaLink = resolveGuiDroppedTarget(link)
    assert.equal(viaLink.ok, false, 'link/junction solto falha fechado como no diálogo')
    if (!viaLink.ok) assert.match(viaLink.error, /link simbólico|junction/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ————— A RECARGA DO CATÁLOGO DE SKILLS (Skills 3.0 — fatia 5.D) —————
//
// SONDADO em 2026-09-08 (`.synkora/reports/PROBE_SKILL_RELOAD_MIDTURN`): o
// `/reload-skills` mandado pelo stdin com o TURNO ABERTO não recarrega no turno
// corrente nem vira fala — fica na fila e executa como MINI-TURNO próprio logo
// depois do `result` do agente (`commands_changed` → `init` → `result` com
// "Reloaded skills: N skills available (1 added)"). Duas propriedades saem daí,
// e as duas moram aqui: (1) o pedido vai pelo BASTIDOR — sem bolha do dono, sem
// briefing consumido, sem turno novo no fio; (2) o `result` do mini-turno é
// RECIBO, não turno do agente: ele nunca fecha um turno que não é dele nem
// aparece como resposta ao dono. Ele vira uma NOTA no fio.
function reloadBench(t, cli) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-skill-reload-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const live = []
  const sent = []
  const sinks = []
  const journal = []
  const gui = new GuiSessionRegistry({
    push: (payload) => live.push(payload),
    systemPromptFile: () => undefined,
    storeFile: join(root, 'gui-sessions.json'),
    record: (event, ids, detail) => journal.push({ event, ids, detail })
  })
  const state = { turnActive: false, alive: true }
  gui.spawnSession = (_input, sink) => {
    sinks.push(sink)
    return {
      get alive() {
        return state.alive
      },
      get turnActive() {
        return state.turnActive
      },
      send: (text) => sent.push(text),
      reloadSkills: () => sent.push('/reload-skills'),
      kill: () => {
        state.alive = false
      }
    }
  }
  const paneId = `gui-dev-reload${cli === 'codex' ? 'c' : 'a'}1`
  assert.equal(
    gui.create({
      paneId,
      projectId: 'proj-reload',
      cli,
      configDir: root,
      cwd: root,
      firstPrompt: 'briefing da missão'
    }).ok,
    true
  )
  return { gui, paneId, live, sent, sinks, journal, state }
}

test('5.D — no claude a recarga vai pelo bastidor e o recibo do CLI vira NOTA, não turno', async (t) => {
  const { gui, paneId, live, sent, sinks, state } = reloadBench(t, 'claude')
  // O `skill_pull` roda DENTRO do turno do agente: é este o estado medido.
  state.turnActive = true
  const before = live.length

  const asked = await gui.reloadSkills(paneId)
  assert.equal(asked.ok, true)
  assert.deepEqual(sent, ['/reload-skills'], 'o comando não chegou cru ao CLI')
  const after = live.slice(before)
  assert.equal(
    after.some(({ evt }) => evt.type === 'user-message'),
    false,
    'a recarga virou fala do DONO no fio'
  )
  assert.equal(
    after.some(({ evt }) => evt.type === 'turn-started'),
    false,
    'a recarga abriu um turno que o CLI não vai executar agora'
  )
  assert.equal(
    gui.state(paneId).events.some(({ evt }) => evt.type === 'user-message'),
    false
  )

  // O turno do AGENTE fecha normalmente…
  sinks[0]({ type: 'text', text: 'terminei a fatia' })
  sinks[0]({
    type: 'result',
    isError: false,
    outcome: 'completed',
    continues: false,
    resultText: 'terminei a fatia'
  })
  state.turnActive = false
  // …e só então o mini-turno da recarga chega (init + result do recibo).
  sinks[0]({
    type: 'init',
    model: 'claude',
    sessionId: 's-reload',
    permissionMode: 'default',
    toolCount: 7
  })
  sinks[0]({
    type: 'result',
    isError: false,
    outcome: 'completed',
    continues: false,
    resultText: 'Reloaded skills: 14 skills available (1 added)',
    localCommand: 'reload-skills'
  })

  const results = live.filter(({ evt }) => evt.type === 'result')
  assert.equal(results.length, 1, 'o recibo da recarga virou um SEGUNDO fim de turno')
  assert.equal(results[0].evt.resultText, 'terminei a fatia')
  const notes = live.filter(({ evt }) => evt.type === 'command-output').map(({ evt }) => evt.text)
  // A linha é a do módulo, não uma frase re-digitada: o texto do CLI viaja
  // dentro dela e o `❖` a põe junto das notas de pull/discard no fio.
  assert.ok(
    notes.includes(guiSkillReloadNote('Reloaded skills: 14 skills available (1 added)', false)),
    `o recibo do CLI não virou nota no fio: ${JSON.stringify(notes)}`
  )
  assert.match(
    guiSkillReloadNote(undefined, true),
    /não recarregou/u,
    'a variante de erro precisa dizer que a recarga NÃO aconteceu'
  )

  // E o turno SEGUINTE do agente segue normal — a marca da recarga não come o
  // `result` de ninguém depois de ter sido consumida.
  sinks[0]({
    type: 'result',
    isError: false,
    outcome: 'completed',
    continues: false,
    resultText: 'segunda resposta'
  })
  assert.equal(live.filter(({ evt }) => evt.type === 'result').length, 2)
})

test('5.D — no codex a recarga é NO-OP dita: a pasta entra no próximo turno', async (t) => {
  const { gui, paneId, sent } = reloadBench(t, 'codex')
  const asked = await gui.reloadSkills(paneId)
  assert.equal(asked.ok, true)
  assert.match(asked.detail ?? '', /próximo turno/u)
  assert.deepEqual(sent, [], 'o codex não tem o que recarregar — mandar slash seria queimar tokens')
})

test('5.D — pane sem sessão ou com sessão morta recusa a recarga sem estourar', async (t) => {
  const { gui, paneId, state } = reloadBench(t, 'claude')
  const ausente = await gui.reloadSkills('gui-dev-nao-existe')
  assert.equal(ausente.ok, false)
  assert.ok(ausente.detail)
  state.alive = false
  const morta = await gui.reloadSkills(paneId)
  assert.equal(morta.ok, false)
  assert.ok(morta.detail)
})
