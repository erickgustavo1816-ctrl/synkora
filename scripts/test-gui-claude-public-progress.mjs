import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { GuiEventRing, GuiSessionRegistry } from '../.tmp/gui-sessions-test/main/guiSessions.js'
import { MaestroSession } from '../.tmp/gui-sessions-test/main/maestroSession.js'
import { GuiOwnerReplyDebt } from '../.tmp/gui-sessions-test/main/guiOwnerReplyDebt.js'
import { GuiClaudePublicProgress, withClaudePublicProgressHook, CLAUDE_PROGRESS_TOOLS,
  CLAUDE_PROGRESS_SILENCE_MS } from '../.tmp/gui-sessions-test/main/guiClaudePublicProgress.js'
import { guiOwnerDebtHookSettings, mergeClaudeSettings } from '../.tmp/gui-sessions-test/main/guiOwnerDebtHook.js'

function progress() {
  let now = 1000
  const files = new Map()
  let writes = 0
  const tracker = new GuiClaudePublicProgress('pane.progress.txt', {
    now: () => now, write: (path, text) => { files.set(path, text); writes++ }, remove: path => files.delete(path)
  })
  return { tracker, files, advance: ms => { now += ms }, writes: () => writes }
}

test('commentary publica a fala original na conversa certa, no replay e no controle de silêncio', () => {
  const h = progress(), live = [], debt = new GuiOwnerReplyDebt()
  const gui = new GuiSessionRegistry({ push: event => live.push(event), systemPromptFile: () => undefined, replyDebt: debt })
  let alive = true
  const session = Object.create(MaestroSession.prototype)
  session.capabilities = []
  Object.defineProperties(session, { alive: { get: () => alive }, turnActive: { get: () => true } })
  session.kill = () => { alive = false }
  session.waitCaps = async () => ({ commands: [], models: [] })
  gui.spawnSession = (_spawn, sink) => {
    session.emit = event => { h.tracker.observe(event); sink(event) }
    sink({ type: 'ready', caps: { commands: [], models: [] } })
    return session
  }
  const identity = { paneId: 'synthetic-commentary', projectId: 'project-a' }
  assert.equal(gui.create({ ...identity, cli: 'claude', cwd: process.cwd(), configDir: 'synthetic' }).ok, true)
  for (let i = 0; i < CLAUDE_PROGRESS_TOOLS; i++) h.tracker.observe({ type: 'tool' })
  debt.arm(identity.paneId, ['synthetic owner message'])
  const message = 'Encontrei a causa. Vou validar o ajuste.'
  assert.equal(gui.commentary({ ...identity, projectId: 'project-b' }, message).ok, false)
  assert.equal(gui.commentary({ ...identity, paneId: 'other-pane' }, message).ok, false)
  for (const invalid of ['', '   ', 'x'.repeat(2001), null]) assert.equal(gui.commentary(identity, invalid).ok, false)
  assert.equal(h.files.size, 1)
  assert.deepEqual(gui.commentary(identity, message), { ok: true })
  assert.equal(h.files.size, 0, 'a fala escrita pelo agente quita o lembrete')
  assert.equal(debt.pending(identity.paneId), null, 'a resposta chega ao mesmo caminho das falas nativas')
  assert.deepEqual(gui.state(identity.paneId).events.filter(e => e.evt.type === 'text').map(e => e.evt.text), [message])
  assert.equal(live.some(e => e.evt.type === 'text' && e.evt.text === message), true)
  alive = false
  assert.equal(gui.commentary(identity, message).ok, false)
})

test('uma sequência sem fala pede uma atualização pública sem bloquear ferramentas', () => {
  const h = progress()
  h.tracker.observe({ type: 'text', text: 'Vou conferir.' })
  for (let i = 0; i < CLAUDE_PROGRESS_TOOLS - 1; i++) h.tracker.observe({ type: 'tool' })
  assert.equal(h.files.size, 0)
  h.tracker.observe({ type: 'tool' })
  const payload = JSON.parse(h.files.get('pane.progress.txt'))
  assert.match(payload.hookSpecificOutput.additionalContext, /visible assistant text/)
  assert.deepEqual(Object.keys(payload.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName'])
  assert.equal(payload.decision, undefined)
  assert.equal(payload.continue, undefined)
  assert.equal(h.writes(), 1)
  h.tracker.observe({ type: 'tool' })
  assert.equal(h.writes(), 1, 'não regrava a mesma orientação a cada ferramenta')
  h.tracker.observe({ type: 'thinking', text: 'synthetic-private' })
  h.tracker.observe({ type: 'tool-result', text: 'synthetic-output' })
  h.tracker.observe({ type: 'text', text: ' ' })
  assert.equal(h.files.size, 1, 'pensamento e resultado de ferramenta não são fala pública')
  h.tracker.observe({ type: 'delta', text: 'Encontrei a causa.' })
  assert.equal(h.files.size, 0, 'a fala pública desarma imediatamente')
})

test('silêncio prolongado arma na próxima ferramenta e encerramento limpa a orientação', () => {
  const h = progress()
  h.advance(CLAUDE_PROGRESS_SILENCE_MS)
  h.tracker.observe({ type: 'tool' })
  assert.equal(h.files.size, 1)
  for (const type of ['result', 'fatal', 'closed']) {
    h.tracker.observe({ type })
    assert.equal(h.files.size, 0)
    h.advance(CLAUDE_PROGRESS_SILENCE_MS)
    h.tracker.observe({ type: 'tool' })
  }
})

test('atividades de filhos não armam nem quitam a comunicação do pai', () => {
  const h = progress()
  for (let i = 0; i < 10; i++) h.tracker.observe({ type: 'tool', parentToolUseId: 'child' })
  assert.equal(h.files.size, 0)
  h.advance(CLAUDE_PROGRESS_SILENCE_MS)
  h.tracker.observe({ type: 'tool' })
  h.tracker.observe({ type: 'text', text: 'fala do filho', parentToolUseId: 'child' })
  assert.equal(h.files.size, 1)
})

test('hook preserva permissões e fast mode e não instala decisões de bloqueio', () => {
  const prior = { ...guiOwnerDebtHookSettings('C:/synthetic/debt.txt'), fastMode: true }
  prior.hooks.PostToolUse = [{ matcher: 'Read', hooks: [{ type: 'command', command: 'true', timeout: 1 }] }]
  const snapshot = structuredClone(prior)
  const next = mergeClaudeSettings(withClaudePublicProgressHook(prior, 'C:/synthetic/pane.progress.txt'))
  assert.deepEqual(prior, snapshot)
  assert.equal(next.fastMode, true)
  assert.deepEqual(next.hooks.PreToolUse, prior.hooks.PreToolUse)
  assert.deepEqual(next.hooks.PostToolUse[0], prior.hooks.PostToolUse[0])
  assert.equal(next.hooks.PostToolUse.length, 2)
  assert.equal(next.hooks.PostToolUse[1].matcher, '*')
})

test('falha de disco no lembrete não encerra a conversa nem lança erro', () => {
  const tracker = new GuiClaudePublicProgress('synthetic', {
    now: () => 0, write: () => { throw new Error('disk unavailable') }, remove: () => { throw new Error('unavailable') }
  })
  assert.doesNotThrow(() => {
    for (let i = 0; i < 10; i++) tracker.observe({ type: 'tool' })
    tracker.observe({ type: 'closed' })
  })
})

test('o lembrete registra apenas contagem e silêncio e limita o ruído de falha', () => {
  const records = []
  let unavailable = true
  const tracker = new GuiClaudePublicProgress('synthetic', {
    now: () => 500, write: () => { if (unavailable) throw new Error('synthetic-sensitive-detail') }, remove() {}
  }, notice => records.push(notice))
  for (let i = 0; i < 9; i++) tracker.observe({ type: 'tool' })
  assert.deepEqual(records, [{ status: 'unavailable', tools: 4, silenceMs: 0 }])
  unavailable = false
  tracker.observe({ type: 'tool' })
  assert.deepEqual(records[1], { status: 'reminded', tools: 10, silenceMs: 0 })
  assert.doesNotMatch(JSON.stringify(records), /sensitive|synthetic/)
})

test('arquivos de lembrete são isolados por pane e não guardam conteúdo da conversa', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synkora-public-progress-'))
  try {
    const a = join(dir, 'a.txt'), b = join(dir, 'b.txt')
    const first = new GuiClaudePublicProgress(a), second = new GuiClaudePublicProgress(b)
    for (let i = 0; i < CLAUDE_PROGRESS_TOOLS; i++) {
      first.observe({ type: 'tool' }); second.observe({ type: 'tool' })
    }
    first.observe({ type: 'text', text: 'synthetic-conversation-content' })
    assert.equal(existsSync(a), false)
    assert.equal(existsSync(b), true)
    assert.doesNotMatch(readFileSync(b, 'utf8'), /synthetic-conversation-content/)
    new GuiClaudePublicProgress(b)
    assert.equal(existsSync(b), false, 'um processo novo não herda lembretes velhos')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('o primeiro lembrete funciona antes de existir a pasta de bandeiras', () => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-progress-first-'))
  try {
    const flag = join(root, 'owner-debt', 'pane.progress.txt')
    const tracker = new GuiClaudePublicProgress(flag)
    for (let i = 0; i < CLAUDE_PROGRESS_TOOLS; i++) tracker.observe({ type: 'tool' })
    assert.equal(existsSync(flag), true)
    tracker.observe({ type: 'closed' })
    assert.equal(existsSync(flag), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('renderer mostra falas entre comandos ao vivo e depois de reabrir um turno longo', () => {
  const source = buildSync({ stdin: { contents: "export { useStore, EMPTY_GUI_PANE } from './src/renderer/src/store';",
    resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs',
    write: false, external: ['react', 'zustand'] }).outputFiles[0].text
  const loaded = { exports: {} }, storage = new Map()
  new Function('require', 'module', 'exports', 'document', 'window', 'localStorage', source)(
    createRequire(import.meta.url), loaded, loaded.exports,
    { documentElement: { style: { setProperty() {} } } }, { synkora: {}, setTimeout, clearTimeout },
    { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  )
  const { useStore, EMPTY_GUI_PANE } = loaded.exports
  const pane = 'synthetic-public-progress', ring = new GuiEventRing()
  const reset = () => useStore.setState({ guiPanes: { [pane]: { ...EMPTY_GUI_PANE, ready: true, status: 'working' } } })
  const feed = evt => useStore.getState().handleGuiLive(pane, evt)
  const live = evt => { ring.push(evt); feed(evt) }
  const spoken = () => useStore.getState().guiPanes[pane].items.filter(i => i.kind === 'assistant').map(i => i.text)
  reset()
  live({ type: 'delta', text: 'Vou conferir o arquivo.' })
  live({ type: 'text', text: 'Vou conferir o arquivo.' })
  for (let i = 0; i < 700; i++) live({ type: 'thinking' })
  live({ type: 'tool', name: 'Read', input: { file_path: 'synthetic.txt' }, toolUseId: 'read-1' })
  live({ type: 'tool-result', toolUseId: 'read-1', text: 'synthetic', isError: false })
  live({ type: 'delta', text: 'Encontrei a causa.' })
  live({ type: 'text', text: 'Encontrei a causa.' })
  for (let i = 0; i < 700; i++) live({ type: 'thinking' })
  const expected = ['Vou conferir o arquivo.', 'Encontrei a causa.']
  assert.deepEqual(spoken(), expected)
  reset()
  for (const event of ring.snapshot()) feed(event)
  assert.deepEqual(spoken(), expected, 'trocar de aba não transforma o chat numa lista só de comandos')
  assert.equal(useStore.getState().guiPanes[pane].thinking, true)
  assert.equal(useStore.getState().guiPanes[pane].items.some(i => i.kind === 'tool'), true)
})
