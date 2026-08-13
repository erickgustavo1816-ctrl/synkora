import assert from 'node:assert/strict'
import test from 'node:test'
import { GUI_RING_CAP, GuiEventRing, GuiSessionRegistry } from '../.tmp/gui-sessions-test/guiSessions.js'

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

test('estourar o teto descarta os MAIS ANTIGOS e mantém a janela cheia', () => {
  const ring = new GuiEventRing(3)
  for (const text of ['a', 'b', 'c', 'd', 'e']) ring.push({ type: 'delta', text })

  assert.equal(ring.size, 3)
  assert.deepEqual(
    ring.snapshot().map((e) => e.text),
    ['c', 'd', 'e']
  )
})

test('teto inválido cai no padrão do contrato', () => {
  for (const cap of [0, -10]) {
    const ring = new GuiEventRing(cap)
    for (let i = 0; i < GUI_RING_CAP + 5; i += 1) ring.push(i)
    assert.equal(ring.size, GUI_RING_CAP)
  }
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

test('pane sem sessão responde honesto em vez de fingir', () => {
  const gui = registry()

  assert.deepEqual(gui.send('fantasma', 'oi'), {
    ok: false,
    error: 'este pane não tem sessão aberta'
  })
  assert.equal(gui.permission('fantasma', 'req-1', 'allow').ok, false)
  assert.equal(gui.interrupt('fantasma').ok, false)
  assert.deepEqual(gui.state('fantasma'), { events: [] })
  // kill de pane que já não existe é sucesso: fechar duas vezes não é erro.
  assert.deepEqual(gui.kill('fantasma'), { ok: true })
})

test('sem documento de resume, lembrar é no-op (nada de disco em teste)', () => {
  const gui = registry()
  assert.equal(gui.remembered('p1'), undefined)
})
