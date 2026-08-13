import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GUI_PERMISSION_MODES,
  GUI_RING_CAP,
  GuiEventRing,
  GuiSessionRegistry,
  guiPermissionProfile,
  inheritedResumeSessionId,
  isGuiPermissionMode,
  spawnFingerprint
} from '../.tmp/gui-sessions-test/guiSessions.js'

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
