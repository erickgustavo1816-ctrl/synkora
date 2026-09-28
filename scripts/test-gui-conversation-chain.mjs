// AS CONVERSAS DE UM CHAT (2026-09-28) — a parte do REGISTRO: todo caminho
// que troca ou apaga o `sessionId` arquiva o anterior (`pastSessions`), o /new
// mantém o fio com um divisor, e nada de antes do divisor vaza como estado da
// conversa nova (pendência do progresso, integration_run sem resposta).
//
// Este arquivo usa SÓ a API pública que já existia antes da mudança
// (GuiSessionRegistry), para poder rodar contra um build ANTIGO e provar que
// falha nele: `SYNKORA_CHAIN_BUILD=<pasta do build> node --test <este arquivo>`.
//
// Build padrão:
//   tsc --outDir .tmp/gui-past-sessions-test --rootDir src --target ES2022 \
//     --module Node16 --moduleResolution Node16 --esModuleInterop --skipLibCheck \
//     --types node src/main/guiSessions.ts src/main/guiPastSessions.ts \
//     src/main/historySessionReader.ts
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const build = resolve(repoRoot, process.env.SYNKORA_CHAIN_BUILD ?? '.tmp/gui-past-sessions-test')
const { GuiSessionRegistry } = await import(pathToFileURL(join(build, 'main', 'guiSessions.js')).href)

const T0 = '2026-09-01T10:00:00.000Z'

function harness(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-chain-'))
  const storeFile = options.persist === false ? undefined : join(root, 'sessions.json')
  if (storeFile && options.doc) writeFileSync(storeFile, JSON.stringify(options.doc), 'utf8')
  const spawns = []
  const gui = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    ...(storeFile ? { storeFile } : {})
  })
  gui.spawnSession = (spawn, sink) => {
    const backend = {
      alive: true,
      turnActive: false,
      send: () => undefined,
      waitCaps: async () => ({ commands: [], models: [] }),
      kill() {
        this.alive = false
      }
    }
    spawns.push({ spawn: { ...spawn }, sink, backend })
    return backend
  }
  t.after(() => {
    gui.killAll()
    rmSync(root, { recursive: true, force: true })
  })
  const reopen = () =>
    new GuiSessionRegistry({ push: () => undefined, systemPromptFile: () => undefined, storeFile })
  return { gui, spawns, root, storeFile, reopen }
}

function init(sink, sessionId) {
  sink({ type: 'init', model: 'm', sessionId, permissionMode: 'default', toolCount: 0 })
}

function chainOf(gui, paneId) {
  const past = gui.remembered(paneId)?.pastSessions
  assert.ok(Array.isArray(past), 'o registro guarda a corrente de conversas antigas')
  for (const entry of past) assert.ok(Number.isFinite(Date.parse(entry.endedAt)), 'endedAt é ISO')
  return past.map(({ cli, sessionId }) => `${cli}:${sessionId}`)
}

function spawnOf(root, paneId, cli = 'claude') {
  return { paneId, projectId: 'proj-chain', cli, configDir: root, cwd: root }
}

// ————— (b) arquivar a conversa que sai —————

test('/new, /reset e /clear arquivam o id da conversa que sai, em ordem', (t) => {
  const h = harness(t)
  const spawn = spawnOf(h.root, 'gui-dev-chain001')
  assert.equal(h.gui.create(spawn).ok, true)
  init(h.spawns[0].sink, 's-1')
  assert.equal(h.gui.send(spawn.paneId, '/new', 'cmd-1').ok, true)
  init(h.spawns[1].sink, 's-2')
  assert.equal(h.gui.send(spawn.paneId, '/reset', 'cmd-2').ok, true)
  init(h.spawns[2].sink, 's-3')
  assert.equal(h.gui.send(spawn.paneId, '/clear', 'cmd-3').ok, true)
  init(h.spawns[3].sink, 's-4')
  assert.equal(h.gui.remembered(spawn.paneId).sessionId, 's-4')
  assert.deepEqual(chainOf(h.gui, spawn.paneId), ['claude:s-1', 'claude:s-2', 'claude:s-3'])
  // Sobrevive ao disco.
  assert.deepEqual(chainOf(h.reopen(), spawn.paneId), ['claude:s-1', 'claude:s-2', 'claude:s-3'])
})

test('troca de CLI arquiva a conversa do CLI anterior (nos dois sentidos)', (t) => {
  const h = harness(t)
  const spawn = spawnOf(h.root, 'gui-dev-chain002')
  assert.equal(h.gui.create(spawn).ok, true)
  init(h.spawns[0].sink, 'claude-1')
  assert.equal(h.gui.create({ ...spawn, cli: 'codex' }).ok, true)
  assert.equal(h.gui.remembered(spawn.paneId).cli, 'codex')
  assert.equal(h.gui.remembered(spawn.paneId).sessionId, undefined)
  assert.deepEqual(chainOf(h.gui, spawn.paneId), ['claude:claude-1'])
  h.spawns[1].sink({ type: 'session-id', sessionId: 'codex-thread:thread-1' })
  assert.equal(h.gui.create(spawn).ok, true)
  assert.deepEqual(chainOf(h.gui, spawn.paneId), ['claude:claude-1', 'codex:codex-thread:thread-1'])
})

test('resume que caiu numa thread nova arquiva a anterior; respawn-com-resume carrega a corrente', (t) => {
  const h = harness(t)
  const spawn = spawnOf(h.root, 'gui-dev-chain003')
  assert.equal(h.gui.create(spawn).ok, true)
  init(h.spawns[0].sink, 's-1')
  h.spawns[0].sink({ type: 'session-id', sessionId: 's-fork' })
  assert.equal(h.gui.remembered(spawn.paneId).sessionId, 's-fork')
  assert.deepEqual(chainOf(h.gui, spawn.paneId), ['claude:s-1'])
  // Trocar o modo respawna e REESCREVE o record inteiro: a corrente atravessa.
  assert.equal(h.gui.create({ ...spawn, permissionMode: 'acceptEdits' }).ok, true)
  assert.equal(h.spawns[1].spawn.resumeSessionId, 's-fork')
  assert.deepEqual(chainOf(h.gui, spawn.paneId), ['claude:s-1'])
})

test('conta esquecida (transplante falho, identidade perdida) arquiva em vez de apagar', (t) => {
  const h = harness(t)
  const spawn = spawnOf(h.root, 'gui-dev-chain004')
  assert.equal(h.gui.create(spawn).ok, true)
  init(h.spawns[0].sink, 's-1')
  h.gui.forgetSession(spawn.paneId)
  assert.equal(h.gui.remembered(spawn.paneId).sessionId, undefined)
  assert.deepEqual(chainOf(h.gui, spawn.paneId), ['claude:s-1'])
  h.spawns[0].sink({ type: 'session-id', sessionId: 's-2' })
  h.gui.forgetSessionIdentity(spawn.paneId)
  assert.equal(h.gui.remembered(spawn.paneId).sessionId, undefined)
  assert.deepEqual(chainOf(h.gui, spawn.paneId), ['claude:s-1', 'claude:s-2'])
})

test('corrente suja no disco não derruba o chat e é limpa na próxima gravação', (t) => {
  const paneId = 'gui-dev-chain005'
  const h = harness(t, {
    doc: {
      panes: {
        [paneId]: {
          cli: 'claude',
          projectId: 'proj-chain',
          updatedAt: T0,
          sessionId: 's-9',
          pastSessions: ['lixo', { cli: 'claude', sessionId: 's-8', endedAt: T0 }, { cli: 'x' }, null]
        }
      },
      transcripts: {}
    }
  })
  const spawn = spawnOf(h.root, paneId)
  assert.equal(h.gui.create(spawn).ok, true)
  assert.equal(h.spawns[0].spawn.resumeSessionId, undefined, 'create explícito sem resume')
  h.spawns[0].sink({ type: 'session-id', sessionId: 's-10' })
  assert.deepEqual(chainOf(h.gui, paneId), ['claude:s-8', 'claude:s-9'])
  const persisted = JSON.parse(readFileSync(h.storeFile, 'utf8')).panes[paneId]
  assert.deepEqual(persisted.pastSessions.map(({ sessionId }) => sessionId), ['s-8', 's-9'])
})

// ————— (c) o /new mantém o fio, e o fio antigo não vira estado novo —————

test('/new mantém o fio antigo (e a poda dele) acima do divisor', (t) => {
  const h = harness(t, { persist: false })
  const spawn = spawnOf(h.root, 'gui-dev-chain006')
  assert.equal(h.gui.create(spawn).ok, true)
  init(h.spawns[0].sink, 's-1')
  // Mais falas do que o anel guarda: a poda começa.
  for (let index = 0; index < 520; index += 1) h.spawns[0].sink({ type: 'text', text: `fala ${index}` })
  const before = h.gui.state(spawn.paneId)
  assert.equal(before.events[0].evt.type, 'history-pruned')
  assert.equal(h.gui.send(spawn.paneId, '/new', 'cmd-new').ok, true)
  init(h.spawns[1].sink, 's-2')
  const after = h.gui.state(spawn.paneId)
  assert.equal(after.events[0].evt.type, 'history-pruned', 'o fio segue dizendo que o começo saiu da tela')
  assert.ok(after.events[0].evt.evicted >= before.events[0].evt.evicted)
  const divider = after.events.findIndex(({ evt }) => evt.type === 'conversation-cleared')
  assert.ok(divider > 0)
  assert.ok(after.events.slice(0, divider).some(({ evt }) => evt.type === 'text' && evt.text === 'fala 519'))
  assert.equal(after.events.slice(divider).some(({ evt }) => evt.type === 'text'), false)
})

test('integration_run sem resposta ANTES do divisor não arma o fecho da conversa nova', (t) => {
  const paneId = 'gui-dev-chain007'
  const control = 'gui-dev-chain008'
  const old = { type: 'tool', name: 'mcp__synkora__integration_run', input: {}, toolUseId: 'integration-old' }
  const h = harness(t, {
    doc: {
      panes: {
        [paneId]: { cli: 'claude', projectId: 'proj-chain', updatedAt: T0 },
        [control]: { cli: 'claude', projectId: 'proj-chain', updatedAt: T0 }
      },
      transcripts: {
        [paneId]: {
          events: [old, { type: 'conversation-cleared' }, { type: 'text', text: 'conversa nova' }],
          cursor: 3,
          updatedAt: T0
        },
        [control]: { events: [old], cursor: 1, updatedAt: T0 }
      }
    }
  })
  const armed = []
  h.gui.integrationReply.arm = (_generation, toolUseId) => armed.push(toolUseId)
  h.gui.integrationReply.disposed = () => undefined
  h.gui.afterIntegrationReply(control, 'INTEGRADA', async () => 'ok')
  h.gui.afterIntegrationReply(paneId, 'INTEGRADA', async () => 'ok')
  assert.deepEqual(armed, ['integration-old', undefined])
})

test('pergunta pendente de ANTES do divisor não volta como pendência da conversa nova', (t) => {
  const paneId = 'gui-dev-chain009'
  const question = {
    type: 'question',
    requestId: 'q-old',
    questions: [{ question: 'Qual caminho?', options: [{ label: 'A' }] }],
    blocking: false,
    asynchronous: true
  }
  const h = harness(t, {
    doc: {
      panes: { [paneId]: { cli: 'claude', projectId: 'proj-chain', updatedAt: T0 } },
      transcripts: {
        [paneId]: {
          events: [question, { type: 'conversation-cleared' }, { type: 'text', text: 'conversa nova' }],
          cursor: 3,
          updatedAt: T0
        }
      }
    }
  })
  assert.equal(h.gui.create(spawnOf(h.root, paneId)).ok, true)
  const progress = h.gui.progress().find((pane) => pane.paneId === paneId)
  assert.equal(progress.pendingCount, 0)
  assert.equal(
    h.gui.state(paneId).events.some(({ evt }) => evt.type === 'question'),
    false,
    'o card da conversa encerrada não renasce'
  )
})

test('card de ajudante aberto ACIMA do divisor fecha com o motivo do /new, não "o app fechou"', (t) => {
  const h = harness(t)
  const spawn = spawnOf(h.root, 'gui-dev-chain010')
  assert.equal(h.gui.create(spawn).ok, true)
  init(h.spawns[0].sink, 's-1')
  h.spawns[0].sink({ type: 'tool', name: 'helper:ajudante-1', input: {}, toolUseId: 'card-1' })
  assert.equal(h.gui.send(spawn.paneId, '/new', 'cmd-new').ok, true)
  const events = h.gui.state(spawn.paneId).events.map(({ evt }) => evt)
  const divider = events.findIndex((evt) => evt.type === 'conversation-cleared')
  const closed = events.filter((evt) => evt.type === 'tool-result' && evt.toolUseId === 'card-1')
  assert.equal(closed.length, 1, 'o card antigo não fica "trabalhando" para sempre')
  assert.equal(closed[0].outcome, 'cancelled')
  assert.match(closed[0].text, /começou outra conversa/u)
  assert.ok(events.indexOf(closed[0]) > divider, 'o fecho chega com a geração nova')
})
