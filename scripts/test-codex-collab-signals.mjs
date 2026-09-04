import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CODEX_SYNKORA_MCP_SERVER_NAME,
  CodexSession,
  codexElicitationVerdict
} from '../.tmp/codex-collab-signals-test/codexSession.js'
import { GuiCodexAgentRegistry } from '../.tmp/codex-collab-signals-test/guiCodexAgents.js'

// Sinais de colaboração do `codex app-server` — a forma REAL do 0.147, medida
// na sonda de 2026-08-18 (relatório probe-codex-fence, seções A.1/A.2/A.5):
//
//  1. `subAgentActivity` NUNCA é emitido (zero ocorrências em 6 rodadas vivas
//     com spawn real). Quem anuncia o subagente nativo é o par
//     `item/started|completed` de `collabAgentToolCall` com `tool: "spawnAgent"`,
//     e é o `item/completed` que traz `receiverThreadIds` + `agentsStates`.
//  2. A cerca mecânica é dupla: `-c features.multi_agent=false` no spawn do
//     app-server (cinto, por `extraArgs`) e `config: {features:{multi_agent:
//     false}}` no `thread/start`/`thread/resume` (suspensório, aqui). Prosa não
//     cerca: com proibição absoluta em developer instructions o modelo spawnou
//     assim mesmo.
//
// Tudo abaixo exercita o INGEST puro sobre o prototype: sem processo, sem RPC
// de verdade e sem timer.

const ROOT_THREAD = 'thread-root'
const CHILD_THREAD = 'thread-child'
const SPAWN_ITEM = 'item-spawn'

/** Sessão de mentira para o ingest de notificações. `child.exitCode` já
 *  encerrado deixa qualquer `kill()` seguro (nenhum taskkill de verdade). */
function ingestSession({ suppressNativeAgents } = {}) {
  const session = Object.create(CodexSession.prototype)
  const events = []
  session.opts = { cwd: '/w', ...(suppressNativeAgents ? { suppressNativeAgents } : {}) }
  session.emit = (event) => events.push(event)
  session.killed = false
  session.closed = false
  session.child = { exitCode: 0, signalCode: null }
  session.threadId = ROOT_THREAD
  session.turnId = 'turn-root'
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

/** Sessão de mentira para o handshake da thread: `request` só anota o que
 *  saiu no fio. `openThread` é o único caminho de nascimento de thread. */
function threadSession({ suppressNativeAgents, resumeSessionId, resumeFails = false, interactiveQuestions = true } = {}) {
  const session = Object.create(CodexSession.prototype)
  const calls = []
  session.opts = {
    cwd: '/w',
    sandbox: 'read-only',
    interactiveQuestions,
    ...(resumeSessionId ? { resumeSessionId } : {}),
    ...(suppressNativeAgents === undefined ? {} : { suppressNativeAgents })
  }
  session.persona = 'persona do chat'
  session.emit = () => undefined
  session.killed = false
  session.closed = false
  session.child = { exitCode: 0, signalCode: null }
  session.initDone = Promise.resolve()
  session.request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'thread/resume' && resumeFails) return { error: { message: 'thread sumiu' } }
    return { result: { thread: { id: 'thread-nova' } } }
  }
  return { session, calls }
}

/** O par que o 0.147 entrega no spawn nativo: o `item/started` chega SEM a
 *  identidade do filho (ela só existe depois), e o `item/completed` traz
 *  `receiverThreadIds` + `agentsStates` (o primeiro estado é `pendingInit`,
 *  que não é desfecho). */
function noteNativeSpawn(note, { threadId = CHILD_THREAD, itemId = SPAWN_ITEM } = {}) {
  note('item/started', {
    threadId: ROOT_THREAD,
    item: { type: 'collabAgentToolCall', id: itemId, tool: 'spawnAgent', status: 'inProgress' }
  })
  note('item/completed', {
    threadId: ROOT_THREAD,
    item: {
      type: 'collabAgentToolCall',
      id: itemId,
      tool: 'spawnAgent',
      status: 'completed',
      receiverThreadIds: [threadId],
      agentsStates: { [threadId]: { status: 'pendingInit' } },
      reasoningEffort: 'low',
      model: 'gpt-5.4-mini'
    }
  })
}

// ————— cerca por thread (slot S2 do design) —————

test('a ordem do dono cerca o subagente nativo no thread/start E no thread/resume', async () => {
  const fresh = threadSession({ suppressNativeAgents: true })
  assert.equal(await fresh.session.openThread(), true)
  assert.deepEqual(
    fresh.calls.map((call) => call.method),
    ['thread/start']
  )
  assert.deepEqual(fresh.calls[0].params.config, { features: { multi_agent: false, default_mode_request_user_input: true } })
  assert.equal(fresh.calls[0].params.cwd, '/w', 'a cerca não substitui o resto do pedido')
  assert.equal(fresh.calls[0].params.developerInstructions, 'persona do chat')
  assert.equal(fresh.calls[0].params.sandbox, 'read-only')

  // Thread retomada não pode voltar a poder abrir subagente nativo.
  const resumed = threadSession({ suppressNativeAgents: true, resumeSessionId: 'thread-velha' })
  assert.equal(await resumed.session.openThread(), true)
  assert.deepEqual(
    resumed.calls.map((call) => call.method),
    ['thread/resume']
  )
  assert.deepEqual(resumed.calls[0].params.config, { features: { multi_agent: false, default_mode_request_user_input: true } })
  assert.equal(resumed.calls[0].params.threadId, 'thread-velha')

  // Resume que não resolve abre thread nova — e a nova nasce cercada também.
  const reborn = threadSession({
    suppressNativeAgents: true,
    resumeSessionId: 'thread-velha',
    resumeFails: true
  })
  assert.equal(await reborn.session.openThread(), true)
  assert.deepEqual(
    reborn.calls.map((call) => call.method),
    ['thread/resume', 'thread/start']
  )
  for (const call of reborn.calls) {
    assert.deepEqual(call.params.config, { features: { multi_agent: false, default_mode_request_user_input: true } })
  }
  assert.notEqual(
    fresh.calls[0].params.config,
    reborn.calls[0].params.config,
    'cada thread monta a própria config — nada de constante compartilhada para alguém mutar'
  )
})

test('perguntas são habilitadas sem alterar a escolha de subagentes', async () => {
  for (const opts of [{}, { suppressNativeAgents: false }]) {
    const fresh = threadSession(opts)
    assert.equal(await fresh.session.openThread(), true)
    assert.deepEqual(fresh.calls[0].params.config, { features: { default_mode_request_user_input: true } })

    const resumed = threadSession({ ...opts, resumeSessionId: 'thread-velha' })
    assert.equal(await resumed.session.openThread(), true)
    assert.deepEqual(resumed.calls[0].params.config, { features: { default_mode_request_user_input: true } })
  }
})

test('sessão sem cartão humano não habilita perguntas interativas', async () => {
  const headless = threadSession({ interactiveQuestions: false, suppressNativeAgents: true })
  assert.equal(await headless.session.openThread(), true)
  assert.deepEqual(headless.calls[0].params.config, { features: { multi_agent: false } })
})

// ————— detecção do spawn nativo (a correção do ouvinte morto) —————

test('collabAgentToolCall/spawnAgent registra o subagente nativo do 0.147', async () => {
  const { session, events, note } = ingestSession()

  noteNativeSpawn(note)
  assert.deepEqual(
    events,
    [
      {
        type: 'tool',
        name: 'spawn_agent',
        input: { name: 'subagente Codex', agent_type: 'codex' },
        toolUseId: SPAWN_ITEM
      }
    ],
    'o par started/completed abre UM card só, o do item do protocolo'
  )
  assert.equal(session.codexAgents.has(CHILD_THREAD), true, 'o thread do filho entra no registro')
  assert.equal(session.codexAgents.size, 1)
  assert.equal(session.collabParentByThreadId.get(CHILD_THREAD), SPAWN_ITEM)

  // Com o filho registrado, o trabalho dele deixa de ser descartado: vira
  // atividade PENDURADA no card do pai — que é o item do protocolo, nunca o id
  // sintético do registro (esse card ninguém abriu).
  note('item/started', {
    threadId: CHILD_THREAD,
    item: { type: 'commandExecution', id: 'cmd-1', command: 'npm test', cwd: '/w' }
  })
  assert.deepEqual(events.at(-1), {
    type: 'tool',
    name: 'Bash',
    input: { command: 'npm test', cwd: '/w' },
    toolUseId: 'cmd-1',
    parentToolUseId: SPAWN_ITEM
  })
  note('item/completed', {
    threadId: CHILD_THREAD,
    item: {
      type: 'commandExecution',
      id: 'cmd-1',
      status: 'completed',
      exitCode: 0,
      aggregatedOutput: 'tudo verde'
    }
  })
  assert.equal(events.at(-1).type, 'tool-result')
  assert.equal(events.at(-1).toolUseId, 'cmd-1')

  // Fala do filho continua fora do fio principal.
  note('item/agentMessage/delta', { threadId: CHILD_THREAD, delta: 'rascunho do filho' })
  assert.equal(events.at(-1).type, 'tool-result')

  // Terminal do turno raiz espera o filho (a decisão sai num microtask, depois
  // das respostas RPC do mesmo chunk).
  note('turn/completed', { threadId: ROOT_THREAD, turn: { id: 'turn-root', status: 'completed' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(session.deferredCollabResult?.type, 'result')
  assert.equal(events.at(-1).type, 'tool-result', 'nada de terminal com filho trabalhando')

  note('turn/completed', {
    threadId: CHILD_THREAD,
    turn: {
      id: 'turn-child',
      status: 'completed',
      items: [{ type: 'agentMessage', id: 'm1', phase: 'final_answer', text: 'BANANA' }]
    }
  })
  const closes = events.filter(
    (event) => event.type === 'tool-result' && event.toolUseId === SPAWN_ITEM
  )
  assert.equal(closes.length, 1, 'o card do pai fecha uma vez só')
  assert.equal(closes[0].text, 'BANANA', 'com a resposta final do filho')
  assert.equal(closes[0].outcome, 'completed')
  assert.equal(Object.hasOwn(closes[0], 'agentStatus'), false, 'campo do Claude nunca no Codex')
  assert.equal(session.codexAgents.size, 0)
  assert.equal(events.at(-1).type, 'result', 'e o terminal retido do turno sai atrás')
  assert.equal(session.turnActive, false)
})

test('a cerca armada não muda a detecção — o espelho fica honesto de qualquer jeito', () => {
  const { session, note } = ingestSession({ suppressNativeAgents: true })
  noteNativeSpawn(note)
  assert.equal(
    session.codexAgents.has(CHILD_THREAD),
    true,
    'config que o binário ignore em silêncio nunca deixa o dono cego'
  )
})

test('o veredito do wait fecha o card e o turn/completed tardio do filho não reabre nada', async () => {
  const { session, events, note } = ingestSession()
  noteNativeSpawn(note)

  const wait = {
    type: 'collabAgentToolCall',
    id: 'item-wait',
    tool: 'wait',
    status: 'completed',
    receiverThreadIds: [CHILD_THREAD],
    agentsStates: { [CHILD_THREAD]: { status: 'completed', message: 'BANANA' } }
  }
  note('item/started', { threadId: ROOT_THREAD, item: wait })
  note('item/completed', { threadId: ROOT_THREAD, item: wait })

  assert.deepEqual(
    events.map((event) => [event.type, event.toolUseId, event.parentToolUseId ?? null]),
    [
      ['tool', SPAWN_ITEM, null],
      ['tool', 'item-wait', SPAWN_ITEM],
      ['tool-result', 'item-wait', null],
      ['tool-result', SPAWN_ITEM, null]
    ]
  )
  assert.equal(session.codexAgents.size, 0, 'o registro fecha junto com o card')
  assert.equal(session.collabParentByThreadId.size, 0)

  note('turn/completed', { threadId: ROOT_THREAD, turn: { id: 'turn-root', status: 'completed' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(events.at(-1).type, 'result', 'sem filho pendurado, o terminal sai na hora')

  // O `turn/completed` do filho chega DEPOIS do veredito: sem o encerramento
  // acima ele fecharia um segundo card (o id sintético) e prenderia o turno.
  events.length = 0
  note('turn/completed', {
    threadId: CHILD_THREAD,
    turn: { id: 'turn-child', status: 'completed', items: [] }
  })
  assert.deepEqual(events, [], 'nada de terminal repetido nem de card órfão')
  assert.equal(session.turnActive, false)
})

test('subAgentActivity continua registrando: binário que emita o sinal legado segue visível', () => {
  const { session, events, note } = ingestSession()
  const activity = {
    type: 'subAgentActivity',
    id: 'activity-1',
    kind: 'started',
    agentThreadId: 'thread-legado',
    agentPath: '/root/calculo'
  }
  note('item/started', { threadId: ROOT_THREAD, item: activity })
  note('item/completed', { threadId: ROOT_THREAD, item: activity })

  // Sem item de protocolo para o spawn, o card do pai é o id SINTÉTICO.
  assert.deepEqual(events, [
    {
      type: 'tool',
      name: 'spawn_agent',
      input: { name: 'calculo', agent_type: 'codex', path: '/root/calculo' },
      toolUseId: 'codex-agent:thread-legado'
    }
  ])
  assert.equal(session.codexAgents.size, 1)

  note('item/started', {
    threadId: 'thread-legado',
    item: { type: 'webSearch', id: 'search-1', query: 'causa raiz' }
  })
  assert.equal(events.at(-1).parentToolUseId, 'codex-agent:thread-legado')

  note('turn/completed', {
    threadId: 'thread-legado',
    turn: { status: 'completed', items: [] }
  })
  assert.deepEqual(
    events.slice(-2).map((event) => [event.type, event.toolUseId, event.outcome]),
    [
      ['tool-result', 'search-1', 'cancelled'],
      ['tool-result', 'codex-agent:thread-legado', 'completed']
    ]
  )
  assert.equal(session.codexAgents.size, 0)
})

// ————— mcpServer/elicitation/request (bug ao vivo de 2026-08-18 15:08) —————
//
// O chat de missão codex nasce com permissionMode 'default', e
// `guiPermissionProfile('codex','default')` é `{}` — nem sandbox nem
// approvalPolicy viajam. Sem approvalPolicy explícita o app-server usa o
// DEFAULT DE CONFIG, e o config dir de um seat não define `approval_policy`:
// vale o default embutido do binário, que é `on-request`. Nesse regime o
// 0.147 pede aprovação de CADA chamada de tool MCP pelo request
// server->client `mcpServer/elicitation/request`, e a recusa genérica do
// `handleServerRequest` transformava a nossa PRÓPRIA ferramenta em
// "user rejected MCP tool call".
//
// Payloads abaixo são CÓPIA CRUA do fio (sonda 2026-08-18,
// scratchpad/probe-elicit/raw/{C-seathome-omitted,E-foreign-server}-summary.json).
const PROBED_SYNKORA_ELICITATION = {
  threadId: '01a01577-da32-76c2-bf13-6d3e7d8590ce',
  turnId: '01a01577-dd67-7580-81e4-4e53f6e56bf0',
  serverName: 'synkora',
  mode: 'form',
  _meta: {
    codex_approval_kind: 'mcp_tool_call',
    persist: ['session', 'always'],
    tool_description: 'Lista as contas disponíveis (probe).',
    tool_params: {},
    tool_params_display: []
  },
  message: 'Allow the synkora MCP server to run tool "list_seats"?',
  requestedSchema: { type: 'object', properties: {} }
}
const PROBED_FOREIGN_ELICITATION = {
  ...PROBED_SYNKORA_ELICITATION,
  serverName: 'outro',
  _meta: { ...PROBED_SYNKORA_ELICITATION._meta, tool_description: 'Radar dos ajudantes (probe).' },
  message: 'Allow the outro MCP server to run tool "helpers_status"?'
}

/** Sessão de mentira para requests DO SERVIDOR: guarda o que foi escrito no
 *  stdin (a resposta JSON-RPC) e o que foi emitido para a conversa. */
function serverRequestSession() {
  const session = Object.create(CodexSession.prototype)
  const events = []
  const written = []
  session.opts = { cwd: '/w' }
  session.emit = (event) => events.push(event)
  session.killed = false
  session.closed = false
  session.child = { exitCode: 0, signalCode: null, stdin: { write: (line) => written.push(line) } }
  session.approvals = new Map()
  session.idleTimer = null
  session.turnSilenceTimer = null
  session.turnId = 'turn-root'
  session.pendingTurnStart = null
  return {
    session,
    events,
    ask: (method, params) => {
      session.handleServerRequest(7, method, params)
      return written.map((line) => JSON.parse(line))
    }
  }
}

test('elicitation do NOSSO servidor é aceita em silêncio — a delegação é o caminho sancionado', () => {
  const { events, ask } = serverRequestSession()
  const sent = ask('mcpServer/elicitation/request', PROBED_SYNKORA_ELICITATION)

  // Forma provada na sonda: `{action:'accept'}` completa a chamada de tool.
  assert.deepEqual(sent, [{ jsonrpc: '2.0', id: 7, result: { action: 'accept', content: {} } }])
  // SILÊNCIO: aprovar a própria ferramenta não é notícia para o dono.
  assert.deepEqual(events, [])
})

test('elicitation de servidor DESCONHECIDO segue recusada, com a mensagem de sempre', () => {
  const { events, ask } = serverRequestSession()
  const sent = ask('mcpServer/elicitation/request', PROBED_FOREIGN_ELICITATION)

  assert.deepEqual(sent, [{ jsonrpc: '2.0', id: 7, result: { action: 'decline' } }])
  assert.deepEqual(events, [
    { type: 'limit', text: 'pedido não suportado do codex negado: mcpServer/elicitation/request' }
  ])
})

test('formulário nosso com campo obrigatório sem default é recusado — nunca inventamos resposta', () => {
  const { events, ask } = serverRequestSession()
  const sent = ask('mcpServer/elicitation/request', {
    ...PROBED_SYNKORA_ELICITATION,
    _meta: { persist: ['session'] },
    requestedSchema: {
      type: 'object',
      properties: { ticket: { type: 'string', title: 'número do chamado' } },
      required: ['ticket']
    }
  })

  assert.deepEqual(sent, [{ jsonrpc: '2.0', id: 7, result: { action: 'decline' } }])
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'limit')
})

test('campo com default vira a resposta; campo opcional sem default fica de fora', () => {
  const { events, ask } = serverRequestSession()
  const sent = ask('mcpServer/elicitation/request', {
    ...PROBED_SYNKORA_ELICITATION,
    requestedSchema: {
      type: 'object',
      properties: {
        seguir: { type: 'boolean', default: true },
        observacao: { type: 'string' }
      },
      required: ['seguir']
    }
  })

  assert.deepEqual(sent, [
    { jsonrpc: '2.0', id: 7, result: { action: 'accept', content: { seguir: true } } }
  ])
  assert.deepEqual(events, [])
})

test('modo url (reautenticação) é recusado mesmo sendo nosso — não há navegador aqui', () => {
  const { events, ask } = serverRequestSession()
  const sent = ask('mcpServer/elicitation/request', {
    threadId: 'thread-root',
    serverName: 'synkora',
    mode: 'url',
    elicitationId: 'elic-1',
    message: 'Reautentique o servidor',
    url: 'https://exemplo.invalido/auth'
  })

  assert.deepEqual(sent, [{ jsonrpc: '2.0', id: 7, result: { action: 'decline' } }])
  assert.equal(events.length, 1)
})

test('outros pedidos não suportados seguem exatamente como antes', () => {
  const { events, ask } = serverRequestSession()
  const sent = ask('unknown/request', { threadId: 'thread-root' })

  assert.deepEqual(sent, [{ jsonrpc: '2.0', id: 7, result: { decision: 'decline' } }])
  assert.deepEqual(events, [
    { type: 'limit', text: 'pedido não suportado do codex negado: unknown/request' }
  ])
})

test('o nome do servidor interno é o mesmo que os args de spawn declaram', () => {
  // O outro lado deste par está em scripts/test-gui-delegate-mcp.mjs, que
  // fixa `mcp_servers.synkora.url=` nos args reais. Divergir quebra os dois.
  assert.equal(CODEX_SYNKORA_MCP_SERVER_NAME, 'synkora')
  assert.equal(
    codexElicitationVerdict(PROBED_SYNKORA_ELICITATION).kind,
    'accept'
  )
  assert.equal(codexElicitationVerdict(PROBED_FOREIGN_ELICITATION).kind, 'refuse')
})
