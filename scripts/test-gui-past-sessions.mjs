// AS CONVERSAS DE UM CHAT (2026-09-28) — a parte PURA: a corrente
// `pastSessions`, o divisor do /new no anel, a lista que o leitor navega (e a
// recusa de um id de fora) e a recuperação por pasta sobre um disco de mentira.
//
// Build: `tsc --outDir .tmp/gui-past-sessions-test --rootDir src ...` (ver o
// cabeçalho de scripts/test-gui-conversation-chain.mjs para o comando inteiro).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  GUI_PAST_SESSIONS_CAP,
  guiDiskSessionId,
  guiPaneConversationFor,
  guiPaneConversations,
  guiPastSessionFields,
  guiPastSessionsOf,
  guiRecoveryWindow
} from '../.tmp/gui-past-sessions-test/main/guiPastSessions.js'
import {
  GuiEventRing,
  eventsSinceConversationStart
} from '../.tmp/gui-past-sessions-test/main/guiSessions.js'
import { listWorkspaceHistorySessions } from '../.tmp/gui-past-sessions-test/main/historySessionReader.js'

const T0 = '2026-09-01T10:00:00.000Z'
const T1 = '2026-09-02T10:00:00.000Z'
const T2 = '2026-09-03T10:00:00.000Z'

// ————— (a) a corrente —————

test('corrente lida do disco: entrada suja sai calada, repetida fica na última posição', () => {
  assert.deepEqual(guiPastSessionsOf(undefined), [])
  assert.deepEqual(guiPastSessionsOf('lixo'), [])
  assert.deepEqual(guiPastSessionsOf({ cli: 'claude' }), [])
  const chain = guiPastSessionsOf([
    null,
    'texto',
    { cli: 'gemini', sessionId: 's-x', endedAt: T0 },
    { cli: 'claude', sessionId: '', endedAt: T0 },
    { cli: 'claude', sessionId: '   ', endedAt: T0 },
    { cli: 'claude', sessionId: 'com\ncontrole', endedAt: T0 },
    { cli: 'claude', sessionId: 'x'.repeat(513), endedAt: T0 },
    { cli: 'claude', sessionId: 's-sem-data', endedAt: 'ontem' },
    { cli: 'claude', sessionId: 's-sem-data-2' },
    { cli: 'claude', sessionId: 's-1', endedAt: T0 },
    { cli: 'codex', sessionId: 'codex-thread:0f0f', endedAt: T0 },
    { cli: 'claude', sessionId: 's-2', endedAt: T1 },
    // O mesmo thread na forma do disco: é a MESMA conversa (dedupe pelo corte).
    { cli: 'codex', sessionId: '0F0F', endedAt: T2 },
    { cli: 'claude', sessionId: ' s-1 ', endedAt: T2, extra: 'ignorado' }
  ])
  assert.deepEqual(chain, [
    { cli: 'claude', sessionId: 's-2', endedAt: T1 },
    { cli: 'codex', sessionId: '0F0F', endedAt: T2 },
    { cli: 'claude', sessionId: 's-1', endedAt: T2 }
  ])
})

test('corrente tem teto e guarda as MAIS NOVAS', () => {
  const raw = Array.from({ length: GUI_PAST_SESSIONS_CAP + 7 }, (_, index) => ({
    cli: 'claude',
    sessionId: `s-${index}`,
    endedAt: new Date(Date.parse(T0) + index * 1000).toISOString()
  }))
  const chain = guiPastSessionsOf(raw)
  assert.equal(chain.length, GUI_PAST_SESSIONS_CAP)
  assert.equal(chain[0].sessionId, 's-7')
  assert.equal(chain.at(-1).sessionId, `s-${GUI_PAST_SESSIONS_CAP + 6}`)
  const next = guiPastSessionFields({ pastSessions: raw }, { cli: 'codex', sessionId: 'novo' }, undefined, T2)
  assert.equal(next.pastSessions.length, GUI_PAST_SESSIONS_CAP)
  assert.deepEqual(next.pastSessions.at(-1), { cli: 'codex', sessionId: 'novo', endedAt: T2 })
})

test('arquivar: a que sai entra no fim; a atual nunca aparece como antiga', () => {
  const first = guiPastSessionFields(undefined, { cli: 'claude', sessionId: 's-1' }, { cli: 'claude', sessionId: 's-2' }, T0)
  assert.deepEqual(first, { pastSessions: [{ cli: 'claude', sessionId: 's-1', endedAt: T0 }], pastSessionsSince: T0 })

  // A marca de início sobrevive às próximas gravações.
  const second = guiPastSessionFields(first, { cli: 'claude', sessionId: 's-2' }, { cli: 'codex' }, T1)
  assert.equal(second.pastSessionsSince, T0)
  assert.deepEqual(second.pastSessions.map(({ sessionId }) => sessionId), ['s-1', 's-2'])

  // Mesma conversa saindo e ficando (respawn-com-resume) não é arquivo.
  const same = guiPastSessionFields(second, { cli: 'claude', sessionId: 's-2' }, { cli: 'claude', sessionId: 's-2' }, T2)
  assert.deepEqual(same.pastSessions.map(({ sessionId }) => sessionId), ['s-1'])

  // Documento sujo que traga a atual na corrente: ela sai da lista.
  const dirty = guiPastSessionFields(
    { pastSessions: [{ cli: 'codex', sessionId: 'codex-thread:abc', endedAt: T0 }], pastSessionsSince: 'quebrado' },
    undefined,
    { cli: 'codex', sessionId: 'abc' },
    T1
  )
  assert.deepEqual(dirty, { pastSessionsSince: T1 })

  // Nada a arquivar e nada guardado: só a marca de início.
  assert.deepEqual(guiPastSessionFields(undefined, undefined, undefined, T0), { pastSessionsSince: T0 })
  // Arquivo com id inválido é ignorado, nunca gravado.
  assert.deepEqual(
    guiPastSessionFields(undefined, { cli: 'claude', sessionId: '' }, undefined, T0),
    { pastSessionsSince: T0 }
  )
})

test('o corte do codex espelha historySessionIdOf', () => {
  assert.equal(guiDiskSessionId('codex-thread:1234'), '1234')
  assert.equal(guiDiskSessionId('  plain-id '), 'plain-id')
})

// ————— (c) o anel: o /new mantém o fio —————

function filledRing(cap, byteCap) {
  const ring = new GuiEventRing(cap, byteCap)
  ring.push({ type: 'init', model: 'm', sessionId: 's-1', permissionMode: 'default', toolCount: 0 })
  ring.push({ type: 'context-usage', contextTokens: 10, contextWindow: 100 })
  ring.push({ type: 'permission', requestId: 'perm-old', toolName: 'Bash', input: {} })
  for (let index = 0; index < 8; index += 1) ring.push({ type: 'command-output', text: `fala ${index}` })
  return ring
}

test('beginNewConversation: fica o fio (itens, poda, cursor); sai o estado da conversa antiga', () => {
  const ring = filledRing(8)
  const evicted = ring.evictedCount
  const cursor = ring.cursor
  assert.ok(evicted > 0, 'o anel pequeno já podou')
  const itemsBefore = ring.snapshot().filter((evt) => evt.type === 'command-output')
  ring.beginNewConversation()
  assert.equal(ring.evictedCount, evicted, 'a poda é do FIO, não da conversa')
  assert.equal(ring.cursor, cursor, 'o cursor segue monotônico')
  assert.deepEqual(ring.snapshot(), itemsBefore, 'sticky e pendências da conversa antiga saem')
  assert.equal(ring.pending('perm-old'), undefined)
  assert.equal(ring.size, itemsBefore.length)
})

test('beginNewConversation zera a contabilidade de bytes do que saiu (sem poda fantasma)', () => {
  const event = { type: 'command-output', text: 'x'.repeat(200) }
  const itemSize = JSON.stringify(event).length
  const sticky = { type: 'context-usage', contextTokens: 1, contextWindow: 2, pad: 'y'.repeat(2_000) }
  const byteCap = itemSize * 4 + JSON.stringify(sticky).length + 50
  const ring = new GuiEventRing(1_000, byteCap)
  ring.push(sticky)
  for (let index = 0; index < 4; index += 1) ring.push({ ...event })
  assert.equal(ring.evictedCount, 0)
  ring.beginNewConversation()
  // Sem o sticky, cabem mais itens: se os bytes dele continuassem contados,
  // estes empurrões podariam falas que cabem de verdade.
  for (let index = 0; index < 4; index += 1) ring.push({ ...event })
  assert.equal(ring.evictedCount, 0)
  assert.equal(ring.size, 8)
})

test('o divisor empurrado (ao vivo ou pela hidratação) encerra o estado da conversa anterior', () => {
  const ring = filledRing(1_000)
  ring.push({ type: 'plan-proposal', requestId: 'plan-old', draft: {} })
  ring.push({ type: 'conversation-cleared' })
  ring.push({ type: 'command-output', text: 'conversa nova' })
  const snapshot = ring.snapshot()
  assert.equal(snapshot.some((evt) => evt.type === 'permission' || evt.type === 'plan-proposal'), false)
  assert.equal(snapshot.some((evt) => evt.type === 'init' || evt.type === 'context-usage'), false)
  assert.equal(snapshot.filter((evt) => evt.type === 'command-output').length, 9, 'o fio antigo fica')
  assert.deepEqual(eventsSinceConversationStart(snapshot), [{ type: 'command-output', text: 'conversa nova' }])
})

test('eventsSinceConversationStart corta no ÚLTIMO divisor e devolve cópia sem divisor', () => {
  const a = { type: 'text', text: 'a' }
  const b = { type: 'text', text: 'b' }
  const c = { type: 'text', text: 'c' }
  const cleared = { type: 'conversation-cleared' }
  const events = [a, b]
  const copy = eventsSinceConversationStart(events)
  assert.deepEqual(copy, [a, b])
  assert.notEqual(copy, events)
  assert.deepEqual(eventsSinceConversationStart([a, cleared, b, cleared, c]), [c])
  assert.deepEqual(eventsSinceConversationStart([a, cleared]), [])
  assert.deepEqual(eventsSinceConversationStart([null, 7, a]), [null, 7, a])
})

// ————— (d) a lista do leitor e a recusa —————

test('lista do chat: antigas por data, a atual por último, recuperadas sem repetir', () => {
  const record = {
    cli: 'claude',
    sessionId: 'atual',
    pastSessions: [
      { cli: 'codex', sessionId: 'codex-thread:thread-a', endedAt: T0 },
      { cli: 'claude', sessionId: 'antiga-b', endedAt: T2 },
      { cli: 'claude', sessionId: 'atual', endedAt: T1 }
    ]
  }
  const conversations = guiPaneConversations(record, [
    { provider: 'claude', sessionId: 'recuperada', updatedAt: T1 },
    { provider: 'claude', sessionId: 'ATUAL', updatedAt: T2 },
    { provider: 'codex', sessionId: 'thread-a', updatedAt: T2 },
    { provider: 'claude', sessionId: 'sem-data', updatedAt: 'nunca' },
    { provider: 'gemini', sessionId: 'outro-cli', updatedAt: T1 }
  ])
  assert.deepEqual(conversations, [
    { sessionId: 'thread-a', provider: 'codex', current: false, source: 'chat', updatedAt: T0 },
    { sessionId: 'recuperada', provider: 'claude', current: false, source: 'recovered', updatedAt: T1 },
    { sessionId: 'antiga-b', provider: 'claude', current: false, source: 'chat', updatedAt: T2 },
    { sessionId: 'atual', provider: 'claude', current: true, source: 'chat' }
  ])
  assert.deepEqual(guiPaneConversations(undefined), [])
  assert.deepEqual(guiPaneConversations({ cli: 'codex' }), [])
})

test('loadForPane só aceita um id DA lista do chat', () => {
  const conversations = guiPaneConversations({
    cli: 'codex',
    sessionId: 'codex-thread:current-thread',
    pastSessions: [{ cli: 'claude', sessionId: 'old-claude', endedAt: T0 }]
  })
  assert.equal(guiPaneConversationFor(conversations, 'old-claude')?.provider, 'claude')
  assert.equal(guiPaneConversationFor(conversations, 'current-thread')?.current, true)
  assert.equal(guiPaneConversationFor(conversations, 'codex-thread:current-thread')?.provider, 'codex')
  assert.equal(guiPaneConversationFor(conversations, 'OLD-CLAUDE')?.sessionId, 'old-claude')
  assert.equal(guiPaneConversationFor(conversations, 'de-outro-chat'), undefined)
  assert.equal(guiPaneConversationFor(conversations, ''), undefined)
  assert.equal(guiPaneConversationFor(conversations, '../../etc/passwd'), undefined)
  assert.equal(guiPaneConversationFor([], 'old-claude'), undefined)
})

test('janela da recuperação: nascimento da missão até a marca da corrente', () => {
  assert.equal(guiRecoveryWindow(undefined, undefined), undefined)
  assert.equal(guiRecoveryWindow('não é data', undefined), undefined)
  assert.deepEqual(guiRecoveryWindow(T0, undefined), { since: Date.parse(T0) })
  assert.deepEqual(guiRecoveryWindow(T0, { pastSessionsSince: 'lixo' }), { since: Date.parse(T0) })
  assert.deepEqual(guiRecoveryWindow(T0, { pastSessionsSince: T2 }), {
    since: Date.parse(T0),
    until: Date.parse(T2)
  })
  // Pane que registra tudo desde antes da missão: nada a recuperar.
  assert.equal(guiRecoveryWindow(T1, { pastSessionsSince: T0 }), undefined)
})

// ————— (e) a recuperação por pasta —————

const DAY = 24 * 60 * 60 * 1000
const SINCE = Date.parse('2026-09-10T00:00:00.000Z')
const UNTIL = Date.parse('2026-09-20T00:00:00.000Z')

function touch(file, at) {
  utimesSync(file, new Date(at), new Date(at))
}

function claudeSlug(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

function rollout(dir, uuid, meta, at) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-2026-09-12T10-00-00-${uuid}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: meta })}\n{"type":"event_msg"}\n`)
  touch(file, at)
  return file
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-recovery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const worktree = join(root, 'worktrees', 'proj', 'mission-abc')
  const claudeA = join(root, 'claude-a')
  const claudeB = join(root, 'claude-b')
  const codexHome = join(root, 'codex')
  const slugDir = (config) => join(config, 'projects', claudeSlug(worktree))
  mkdirSync(slugDir(claudeA), { recursive: true })
  mkdirSync(slugDir(claudeB), { recursive: true })
  const at = (day) => SINCE + day * DAY
  const claudeFile = (config, name, when) => {
    const file = join(slugDir(config), name)
    writeFileSync(file, '{"type":"user"}\n')
    touch(file, when)
  }
  claudeFile(claudeA, 'dentro-1.jsonl', at(1))
  claudeFile(claudeA, 'dentro-2.jsonl', at(3))
  claudeFile(claudeA, 'antes.jsonl', SINCE - DAY)
  claudeFile(claudeA, 'depois.jsonl', UNTIL + DAY)
  claudeFile(claudeA, 'nome inválido!.jsonl', at(2))
  claudeFile(claudeA, 'notas.txt', at(2))
  // Transplante de seat: o mesmo id em duas contas vira UMA conversa (a mais nova).
  claudeFile(claudeB, 'dentro-2.jsonl', at(4))
  // Outra pasta de trabalho na mesma conta: nunca entra.
  mkdirSync(join(claudeA, 'projects', 'C--outro'), { recursive: true })
  writeFileSync(join(claudeA, 'projects', 'C--outro', 'alheia.jsonl'), '{}\n')

  const day = (y, m, d) => join(codexHome, 'sessions', y, m, d)
  const uuid = (n) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`
  rollout(day('2026', '09', '12'), uuid(1), { id: uuid(1), cwd: worktree }, at(2))
  rollout(day('2026', '09', '12'), uuid(2), { id: uuid(2), cwd: join(root, 'outra-pasta') }, at(2))
  rollout(day('2026', '09', '13'), uuid(3), { id: uuid(3), cwd: worktree, source: { subagent: { parent: 'x' } } }, at(3))
  rollout(day('2026', '09', '13'), uuid(4), { id: uuid(4), cwd: worktree, thread_source: 'subagent' }, at(3))
  rollout(day('2026', '08', '01'), uuid(5), { id: uuid(5), cwd: worktree }, SINCE - 30 * DAY)
  rollout(day('2026', '09', '25'), uuid(6), { id: uuid(6), cwd: worktree }, UNTIL + 5 * DAY)
  rollout(
    day('2026', '09', '14'),
    uuid(7),
    { id: uuid(7), cwd: worktree, padding: 'p'.repeat(4_096) },
    at(4)
  )
  // Primeira linha que não é session_meta: irreconhecível, fica de fora.
  const noMeta = join(day('2026', '09', '14'), `rollout-2026-09-14T10-00-00-${uuid(8)}.jsonl`)
  writeFileSync(noMeta, '{"type":"event_msg"}\n')
  touch(noMeta, at(4))
  if (process.platform === 'win32') {
    rollout(day('2026', '09', '15'), uuid(9), { id: uuid(9), cwd: `${worktree.toUpperCase()}\\` }, at(5))
  }
  return { worktree, claudeA, claudeB, codexHome, uuid }
}

test('recuperação claude: slug do worktree, janela [since, until), id seguro, cópia mais nova', async (t) => {
  const f = fixture(t)
  const found = await listWorkspaceHistorySessions({
    provider: 'claude',
    cwd: f.worktree,
    since: SINCE,
    until: UNTIL,
    configDirs: [f.claudeA, f.claudeB, f.claudeA]
  })
  assert.deepEqual(
    found.map(({ sessionId, configDir }) => [sessionId, configDir]),
    [
      ['dentro-1', f.claudeA],
      ['dentro-2', f.claudeB]
    ]
  )
  assert.ok(found.every((session) => session.provider === 'claude'))
  // Sem `until`, o que veio depois entra.
  const open = await listWorkspaceHistorySessions({
    provider: 'claude',
    cwd: f.worktree,
    since: SINCE,
    configDirs: [f.claudeA]
  })
  assert.deepEqual(open.map(({ sessionId }) => sessionId), ['dentro-1', 'dentro-2', 'depois'])
})

test('recuperação codex: pastas de data da janela, cwd do session_meta, sem subagente', async (t) => {
  const f = fixture(t)
  const found = await listWorkspaceHistorySessions({
    provider: 'codex',
    cwd: f.worktree,
    since: SINCE,
    until: UNTIL,
    configDirs: [f.codexHome]
  })
  const expected = [f.uuid(1), f.uuid(7), ...(process.platform === 'win32' ? [f.uuid(9)] : [])]
  assert.deepEqual(found.map(({ sessionId }) => sessionId), expected)
  // Cabeçalho maior que o teto é irreconhecível: falha fechado.
  const tight = await listWorkspaceHistorySessions({
    provider: 'codex',
    cwd: f.worktree,
    since: SINCE,
    until: UNTIL,
    configDirs: [f.codexHome],
    limits: { maxMetaBytes: 1_024 }
  })
  assert.equal(tight.some(({ sessionId }) => sessionId === f.uuid(7)), false)
  assert.ok(tight.some(({ sessionId }) => sessionId === f.uuid(1)))
})

test('recuperação tem tetos e nunca lança', async (t) => {
  const f = fixture(t)
  const capped = await listWorkspaceHistorySessions({
    provider: 'claude',
    cwd: f.worktree,
    since: 0,
    configDirs: [f.claudeA],
    limits: { maxResults: 2 }
  })
  assert.deepEqual(capped.map(({ sessionId }) => sessionId), ['dentro-2', 'depois'], 'as mais novas ficam')
  const oneFile = await listWorkspaceHistorySessions({
    provider: 'claude',
    cwd: f.worktree,
    since: 0,
    configDirs: [f.claudeA],
    limits: { maxFiles: 1 }
  })
  assert.ok(oneFile.length <= 1)
  const aborted = new AbortController()
  aborted.abort()
  assert.deepEqual(
    await listWorkspaceHistorySessions({
      provider: 'codex',
      cwd: f.worktree,
      since: SINCE,
      configDirs: [f.codexHome],
      signal: aborted.signal
    }),
    []
  )
  assert.deepEqual(
    await listWorkspaceHistorySessions({ provider: 'claude', cwd: '', since: SINCE, configDirs: [f.claudeA] }),
    []
  )
  assert.deepEqual(
    await listWorkspaceHistorySessions({ provider: 'claude', cwd: f.worktree, since: Number.NaN, configDirs: [f.claudeA] }),
    []
  )
  assert.deepEqual(
    await listWorkspaceHistorySessions({
      provider: 'codex',
      cwd: f.worktree,
      since: SINCE,
      configDirs: [join(f.codexHome, 'não-existe'), '']
    }),
    []
  )
})
