import assert from 'node:assert/strict'
import { appendFile, mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  extractVisibleHistoryMessage,
  historyLocatorFingerprint,
  historySessionIdOf,
  loadLocalHistoryTranscript,
  localHistoryLocatorIsSafe,
  searchLocalHistory
} from '../.tmp/command-palette-test/main/historySearch.js'
import {
  loadLocalHistorySessionPage,
  locateHistorySessionFile
} from '../.tmp/command-palette-test/main/historySessionReader.js'

const disposable = new Set()

test.afterEach(async () => {
  await Promise.all([...disposable].map((path) => rm(path, { recursive: true, force: true })))
  disposable.clear()
})

function line(value) {
  return JSON.stringify(value)
}

function claudeSlug(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'synkora-command-palette-'))
  disposable.add(root)
  const cwd = join(root, 'workspace', 'universo-sintetico')
  const claudeConfig = join(root, 'claude-config')
  const codexConfig = join(root, 'codex-config')
  const claudeSessionId = '11111111-1111-4111-8111-111111111111'
  const codexSessionId = '22222222-2222-4222-8222-222222222222'
  const claudeDir = join(claudeConfig, 'projects', claudeSlug(cwd))
  const codexDir = join(codexConfig, 'sessions', '2026', '08', '14')
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(claudeDir, { recursive: true }),
    mkdir(codexDir, { recursive: true })
  ])

  const syntheticToken = `sk-proj-${'SYNTHETIC'.repeat(3)}`
  const claudeFile = join(claudeDir, `${claudeSessionId}.jsonl`)
  await writeFile(
    claudeFile,
    [
      line({
        type: 'user',
        uuid: 'claude-user-1',
        timestamp: '2026-08-14T10:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Procure a constelação violeta no mapa.' }]
        }
      }),
      line({
        type: 'assistant',
        timestamp: '2026-08-14T10:00:01.000Z',
        message: {
          id: 'claude-assistant-1',
          role: 'assistant',
          content: [
            { type: 'text', text: `A constelação está na ponte. api_key=${syntheticToken}` },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'agulha-tool-claude' } }
          ]
        }
      }),
      line({
        type: 'user',
        uuid: 'claude-tool-result',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'agulha-tool-claude' }]
        }
      }),
      '{"type":"assistant","message":{"role":"assistant","content":['
    ].join('\n'),
    'utf8'
  )

  const codexFile = join(codexDir, `rollout-2026-08-14T10-00-00-${codexSessionId}.jsonl`)
  await writeFile(
    codexFile,
    [
      line({
        type: 'session_meta',
        timestamp: '2026-08-14T10:00:00.000Z',
        payload: { id: codexSessionId, cwd, source: 'cli' }
      }),
      line({
        type: 'response_item',
        timestamp: '2026-08-14T10:01:00.000Z',
        payload: {
          type: 'message',
          id: 'codex-user-1',
          role: 'user',
          content: [{ type: 'input_text', text: 'Localize a orquídea prateada.' }]
        }
      }),
      line({
        type: 'response_item',
        timestamp: '2026-08-14T10:01:01.000Z',
        payload: {
          type: 'message',
          id: 'codex-assistant-1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'A orquídea está no arquivo sintético.' }]
        }
      }),
      line({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell',
          arguments: '{"query":"agulha-tool-codex"}'
        }
      }),
      line({
        type: 'response_item',
        payload: { type: 'function_call_output', output: 'agulha-tool-codex' }
      }),
      '{"type":"response_item","payload":{"type":"message"'
    ].join('\n'),
    'utf8'
  )

  return {
    root,
    cwd,
    claudeConfig,
    codexConfig,
    claudeFile,
    codexFile,
    syntheticToken,
    claudeSessionId,
    codexSessionId,
    roots: [
      { provider: 'claude', configDir: claudeConfig },
      { provider: 'codex', configDir: codexConfig }
    ],
    workspaces: [
      {
        cwd,
        projectId: 'project-synthetic',
        missionId: 'mission-synthetic',
        paneId: 'gui-dev-mission',
        label: 'Missão sintética',
        canMount: true
      }
    ]
  }
}

/** Conversa longa de um pane só: é nela que a paginação por bytes se prova. */
async function longClaudeFixture(count = 12) {
  const root = await mkdtemp(join(tmpdir(), 'synkora-history-page-'))
  disposable.add(root)
  const cwd = join(root, 'workspace', 'universo-longo')
  const configDir = join(root, 'claude-config')
  const sessionId = '44444444-4444-4444-8444-444444444444'
  const dir = join(configDir, 'projects', claudeSlug(cwd))
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(dir, { recursive: true })])
  const file = join(dir, `${sessionId}.jsonl`)
  const lines = []
  for (let index = 0; index < count; index += 1) {
    lines.push(
      line({
        type: 'user',
        uuid: `fala-${index}`,
        timestamp: '2026-08-20T10:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: `fala numero ${index}` }] }
      })
    )
  }
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8')
  return { root, cwd, configDir, sessionId, file, count }
}

test('R24.2 — localizador por sessão: claude direto, codex pelo nome, prefixo cortado', async () => {
  const data = await fixture()

  const claude = await locateHistorySessionFile({
    provider: 'claude',
    sessionId: data.claudeSessionId,
    configDirs: [data.claudeConfig, data.codexConfig],
    cwds: [data.cwd]
  })
  assert.equal(claude?.file, data.claudeFile)
  assert.equal(claude?.configDir, data.claudeConfig)
  assert.equal(claude?.sessionId, data.claudeSessionId)

  // O pane do codex guarda `codex-thread:<uuid>`; no disco só existe o uuid.
  assert.equal(historySessionIdOf(`codex-thread:${data.codexSessionId}`), data.codexSessionId)
  const codex = await locateHistorySessionFile({
    provider: 'codex',
    sessionId: `codex-thread:${data.codexSessionId}`,
    configDirs: [data.codexConfig]
  })
  assert.equal(codex?.file, data.codexFile)
  assert.equal(codex?.sessionId, data.codexSessionId)

  assert.equal(
    await locateHistorySessionFile({
      provider: 'claude',
      sessionId: '55555555-5555-4555-8555-555555555555',
      configDirs: [data.claudeConfig],
      cwds: [data.cwd]
    }),
    undefined,
    'conversa que não existe recusa em vez de adivinhar arquivo'
  )
  assert.equal(
    await locateHistorySessionFile({
      provider: 'claude',
      sessionId: '../../escapando',
      configDirs: [data.claudeConfig],
      cwds: [data.cwd]
    }),
    undefined,
    'id fora da forma conhecida nunca vira caminho'
  )
})

test('missão concluída abre o histórico sem conhecer o worktree original', async () => {
  const data = await fixture()
  for (const cwds of [undefined, [join(data.root, 'project-root')]]) {
    const session = await locateHistorySessionFile({
      provider: 'claude',
      sessionId: data.claudeSessionId,
      configDirs: [data.claudeConfig],
      cwds
    })
    assert.equal(session?.file, data.claudeFile)
    assert.equal(await localHistoryLocatorIsSafe(session), true)
    const page = await loadLocalHistorySessionPage(session)
    assert.equal(page.ok, true)
    assert.equal(page.messages[0].text, 'Procure a constelação violeta no mapa.')
  }
})

test('histórico sem worktree escolhe a cópia mais recente entre contas cadastradas', async () => {
  const data = await fixture()
  const secondConfig = join(data.root, 'second-seat')
  const secondDir = join(secondConfig, 'projects', 'old-worktree')
  await mkdir(secondDir, { recursive: true })
  const secondFile = join(secondDir, `${data.claudeSessionId}.jsonl`)
  await writeFile(secondFile, await readFile(data.claudeFile))
  await utimes(data.claudeFile, new Date('2026-01-01'), new Date('2026-01-01'))
  await utimes(secondFile, new Date('2026-02-01'), new Date('2026-02-01'))
  const session = await locateHistorySessionFile({
    provider: 'claude', sessionId: data.claudeSessionId,
    configDirs: [data.claudeConfig, secondConfig]
  })
  assert.equal(session?.file, secondFile)
})

test('histórico sem worktree respeita cancelamento e não segue diretório vinculado', async () => {
  const data = await fixture()
  const linkedConfig = join(data.root, 'linked-seat')
  await mkdir(join(linkedConfig, 'projects'), { recursive: true })
  await symlink(join(data.claudeConfig, 'projects', claudeSlug(data.cwd)),
    join(linkedConfig, 'projects', 'external-worktree'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(await locateHistorySessionFile({
    provider: 'claude', sessionId: data.claudeSessionId, configDirs: [linkedConfig]
  }), undefined)
  assert.equal(await locateHistorySessionFile({
    provider: 'claude', sessionId: data.claudeSessionId, configDirs: [data.claudeConfig],
    signal: AbortSignal.abort()
  }), undefined)
})

test('R24.3 — a conversa completa abre no COMEÇO e pagina por faixa de bytes', async () => {
  const data = await longClaudeFixture(12)
  const session = await locateHistorySessionFile({
    provider: 'claude',
    sessionId: data.sessionId,
    configDirs: [data.configDir],
    cwds: [data.cwd]
  })
  assert.ok(session)

  const limits = { maxTranscriptMessages: 4 }
  const first = await loadLocalHistorySessionPage(session, { limits })
  assert.equal(first.ok, true)
  assert.deepEqual(
    first.messages?.map((message) => message.text),
    ['fala numero 0', 'fala numero 1', 'fala numero 2', 'fala numero 3']
  )
  assert.equal(first.targetMessageId, first.messages?.[0].id)
  assert.equal(first.hasMoreBefore, false, 'a âncora é o COMEÇO: não há nada antes')
  assert.equal(first.hasMoreAfter, true)

  const next = await loadLocalHistorySessionPage(session, {
    limits,
    page: { after: first.messages?.at(-1).cursor }
  })
  assert.equal(next.ok, true)
  assert.equal(next.messages?.[0].text, 'fala numero 4')
  assert.equal(next.hasMoreBefore, true)
  assert.equal(next.hasMoreAfter, true)

  const previous = await loadLocalHistorySessionPage(session, {
    limits,
    page: { before: next.messages?.[0].cursor }
  })
  assert.equal(previous.ok, true)
  assert.equal(previous.messages?.at(-1).text, 'fala numero 3')
  assert.equal(previous.hasMoreAfter, true)

  // A janela de BYTES é real: teto pequeno lê o começo do arquivo e diz que há
  // mais adiante — é o que salva o rollout de 6 MB do codex.
  const clipped = await loadLocalHistorySessionPage(session, {
    limits: { maxBytesPerFile: 420 }
  })
  assert.equal(clipped.ok, true)
  assert.equal(clipped.messages?.[0].text, 'fala numero 0')
  assert.ok((clipped.messages?.length ?? 0) < data.count)
  assert.equal(clipped.hasMoreAfter, true)
  assert.equal(clipped.truncated, true)

  const tail = await loadLocalHistorySessionPage(session, { anchor: 'last' })
  assert.equal(tail.messages?.at(-1).text, `fala numero ${data.count - 1}`)
  assert.equal(tail.hasMoreAfter, false)
})

test('R24 (carona) — binding de codex com prefixo casa o transcript sem prefixo', async () => {
  const data = await fixture()
  const bound = await searchLocalHistory({
    query: 'orquídea prateada',
    roots: [{ provider: 'codex', configDir: data.codexConfig }],
    // Sem workspace nenhum: só o BINDING pode provar de quem é o rollout.
    workspaces: [],
    sessionBindings: [
      {
        sessionId: `codex-thread:${data.codexSessionId}`,
        projectId: 'project-synthetic',
        missionId: 'mission-synthetic',
        paneId: 'gui-dev-mission',
        label: 'Missão sintética',
        canMount: true
      }
    ]
  })
  assert.equal(bound.hits.length, 1)
  assert.equal(bound.hits[0].paneId, 'gui-dev-mission')
  assert.equal(bound.hits[0].missionId, 'mission-synthetic')
  assert.equal(bound.hits[0].canMount, true)
})

test('busca Claude e Codex tolera JSONL parcial e conserva alvo estável', async () => {
  const data = await fixture()
  const claude = await searchLocalHistory({
    query: 'constelacao violeta',
    roots: data.roots,
    workspaces: data.workspaces
  })
  assert.equal(claude.cancelled, false)
  assert.equal(claude.hits.length, 1)
  assert.equal(claude.hits[0].provider, 'claude')
  assert.equal(claude.hits[0].sessionId, data.claudeSessionId)
  assert.equal(claude.hits[0].messageId, 'claude-user-1')
  assert.equal(claude.hits[0].projectId, 'project-synthetic')
  assert.equal(claude.hits[0].paneId, 'gui-dev-mission')
  assert.equal(claude.hits[0].canMount, true)

  const repeated = await searchLocalHistory({
    query: 'constelação violeta',
    roots: data.roots,
    workspaces: data.workspaces
  })
  assert.deepEqual(
    repeated.hits.map(({ provider, sessionId, messageId, cursor }) => ({
      provider,
      sessionId,
      messageId,
      cursor
    })),
    claude.hits.map(({ provider, sessionId, messageId, cursor }) => ({
      provider,
      sessionId,
      messageId,
      cursor
    }))
  )

  const codex = await searchLocalHistory({
    query: 'orquidea prateada',
    roots: data.roots,
    workspaces: data.workspaces
  })
  assert.equal(codex.hits.length, 1)
  assert.equal(codex.hits[0].provider, 'codex')
  assert.equal(codex.hits[0].sessionId, data.codexSessionId)
  assert.equal(codex.hits[0].messageId, 'codex-user-1')
})

test('tool payloads nunca viram resultado e segredos visíveis são redigidos antes do match', async () => {
  const data = await fixture()
  for (const query of ['agulha-tool-claude', 'agulha-tool-codex']) {
    const result = await searchLocalHistory({
      query,
      roots: data.roots,
      workspaces: data.workspaces
    })
    assert.deepEqual(result.hits, [])
  }

  const rawSecret = await searchLocalHistory({
    query: data.syntheticToken,
    roots: data.roots,
    workspaces: data.workspaces
  })
  assert.deepEqual(rawSecret.hits, [])

  const visible = await searchLocalHistory({
    query: 'ponte',
    roots: data.roots,
    workspaces: data.workspaces
  })
  assert.equal(visible.hits.length, 1)
  assert.doesNotMatch(visible.hits[0].snippet, new RegExp(data.syntheticToken, 'u'))
  assert.match(visible.hits[0].snippet, /\[redigido:(?:campo|token)\]/u)

  const transcript = await loadLocalHistoryTranscript(visible.hits[0].locator)
  assert.equal(transcript.ok, true)
  assert.equal(transcript.targetMessageId, visible.hits[0].messageId)
  assert.equal(transcript.targetCursor, visible.hits[0].cursor)
  assert.ok(
    transcript.messages?.some(
      (message) =>
        message.id === visible.hits[0].messageId && message.cursor === visible.hits[0].cursor
    )
  )
  assert.doesNotMatch(JSON.stringify(transcript.messages), new RegExp(data.syntheticToken, 'u'))
})

test('load preserva ID+cursor exatos e falha honestamente se a linha desaparecer', async () => {
  const data = await fixture()
  const found = await searchLocalHistory({
    query: 'ponte',
    roots: data.roots,
    workspaces: data.workspaces
  })
  const hit = found.hits[0]
  await appendFile(
    data.claudeFile,
    `\n${line({
      type: 'assistant',
      message: {
        id: hit.messageId,
        role: 'assistant',
        content: [{ type: 'text', text: 'Uma fotografia posterior e mais longa da mesma fala.' }]
      }
    })}\n`,
    'utf8'
  )

  const exact = await loadLocalHistoryTranscript(hit.locator)
  assert.equal(exact.ok, true)
  assert.equal(exact.targetMessageId, hit.messageId)
  assert.equal(exact.targetCursor, hit.cursor)
  assert.match(
    exact.messages?.find(
      (message) => message.id === hit.messageId && message.cursor === hit.cursor
    )?.text ?? '',
    /constelação está na ponte/u
  )

  await writeFile(
    data.claudeFile,
    `${line({
      type: 'user',
      uuid: 'outra-linha',
      message: { role: 'user', content: [{ type: 'text', text: 'Outro conteúdo.' }] }
    })}\n`,
    'utf8'
  )
  const missing = await loadLocalHistoryTranscript(hit.locator)
  assert.equal(missing.ok, false)
  assert.match(missing.error ?? '', /mensagem exata/u)
})

test('extrator fechado só reconhece falas explícitas de user/assistant', () => {
  assert.equal(
    extractVisibleHistoryMessage(
      'claude',
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'oculto' }] }
      },
      0
    ),
    undefined
  )
  assert.equal(
    extractVisibleHistoryMessage(
      'codex',
      { type: 'response_item', payload: { type: 'function_call_output', output: 'oculto' } },
      0
    ),
    undefined
  )
  assert.equal(
    extractVisibleHistoryMessage(
      'codex',
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'instrução interna' }]
        }
      },
      0
    ),
    undefined
  )
  assert.equal(
    extractVisibleHistoryMessage(
      'claude',
      {
        type: 'assistant',
        isSidechain: true,
        agentId: 'synthetic-helper',
        message: { role: 'assistant', content: [{ type: 'text', text: 'fala interna' }] }
      },
      0
    ),
    undefined
  )
})

test('cancelamento e tetos de arquivo, bytes, tempo e resultados encerram de modo parcial', async () => {
  const data = await fixture()
  const controller = new AbortController()
  controller.abort()
  const cancelled = await searchLocalHistory({
    query: 'constelação',
    roots: data.roots,
    workspaces: data.workspaces,
    signal: controller.signal
  })
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.scannedFiles, 0)

  const secondSession = join(
    data.claudeConfig,
    'projects',
    claudeSlug(data.cwd),
    '33333333-3333-4333-8333-333333333333.jsonl'
  )
  await writeFile(
    secondSession,
    `${line({
      type: 'user',
      uuid: 'second-user',
      message: { role: 'user', content: [{ type: 'text', text: 'constelação duplicada' }] }
    })}\n`,
    'utf8'
  )
  const now = new Date()
  await utimes(secondSession, now, new Date(now.getTime() + 2_000))

  const files = await searchLocalHistory({
    query: 'constelação',
    roots: [{ provider: 'claude', configDir: data.claudeConfig }],
    workspaces: data.workspaces,
    limits: { maxFiles: 1 }
  })
  assert.equal(files.scannedFiles, 1)
  assert.equal(files.truncated, true)
  assert.equal(files.limitReason, 'arquivos')

  const bytes = await searchLocalHistory({
    query: 'constelação',
    roots: [{ provider: 'claude', configDir: data.claudeConfig }],
    workspaces: data.workspaces,
    limits: { maxBytes: 96, maxBytesPerFile: 96 }
  })
  assert.ok(bytes.scannedBytes <= 96)
  assert.equal(bytes.truncated, true)
  assert.equal(bytes.limitReason, 'bytes')

  const results = await searchLocalHistory({
    query: 'constelação',
    roots: [{ provider: 'claude', configDir: data.claudeConfig }],
    workspaces: data.workspaces,
    limits: { maxResults: 1 }
  })
  assert.equal(results.hits.length, 1)
  assert.equal(results.limitReason, 'resultados')

  const realNow = Date.now
  let tick = 0
  Date.now = () => (tick += 2)
  try {
    const timed = await searchLocalHistory({
      query: 'constelação',
      roots: data.roots,
      workspaces: data.workspaces,
      limits: { maxMs: 1 }
    })
    assert.equal(timed.truncated, true)
    assert.equal(timed.limitReason, 'tempo')
  } finally {
    Date.now = realNow
  }
})

test('locator fica sob config conhecida e fingerprint não contém caminho', async () => {
  const data = await fixture()
  const result = await searchLocalHistory({
    query: 'ponte',
    roots: data.roots,
    workspaces: data.workspaces
  })
  const locator = result.hits[0].locator
  assert.equal(await localHistoryLocatorIsSafe(locator), true)
  const fingerprint = historyLocatorFingerprint(locator)
  assert.match(fingerprint, /^[a-f0-9]{16}$/u)
  assert.equal(fingerprint.includes(data.root), false)
})

test('contrato UI instala o atalho numa root só e valida o alvo antes de navegar', async () => {
  const root = new URL('..', import.meta.url)
  const [app, palette, navigation, registry, guiPane, css] = await Promise.all(
    [
      'src/renderer/src/App.tsx',
      'src/renderer/src/components/CommandPalette.tsx',
      'src/renderer/src/commandPaletteNavigation.ts',
      'src/renderer/src/commandPaletteRegistry.ts',
      'src/renderer/src/components/GuiPane.tsx',
      'src/renderer/src/global.css'
    ].map((path) => readFile(new URL(path, root), 'utf8'))
  )

  // A ilha panes-view morreu na purga F6 (2026-08-17): existia uma segunda
  // root ('panes') que encaminhava o alvo ao host por IPC. Agora a paleta é
  // do host e navega ela mesma — mas a VALIDAÇÃO do alvo continua sendo
  // obrigatória, e é isto que as duas asserções abaixo prendem.
  assert.match(app, /<CommandPalette \/>/u)
  assert.doesNotMatch(app, /CommandPalette root=/u)
  assert.doesNotMatch(navigation, /panesView/u)
  assert.match(palette, /isPaletteNavigationTarget\(target\)/u)
  assert.match(palette, /event\.ctrlKey && !event\.metaKey|!event\.ctrlKey && !event\.metaKey/u)
  assert.match(palette, /event\.stopImmediatePropagation\(\)/u)
  assert.match(palette, /bumpHostOverlay\(1\)/u)
  assert.match(palette, /window\.synkora\.history\.cancel\(requestId\)/u)
  assert.match(registry, /export function registerCommandPaletteAction/u)
  assert.match(navigation, /result\.canMount/u)
  assert.match(navigation, /paneId: result\.paneId/u)
  assert.doesNotMatch(navigation, /paneId: target\.paneId/u)
  assert.match(guiPane, /data-history-message-id=\{message\.id\}/u)
  assert.match(guiPane, /message\.cursor === historyTarget\.targetCursor/u)
  // O composer some enquanto o histórico está aberto — a regra não mudou, o
  // predicado é que ganhou um segundo caso (2026-08-15): `inert` cobre tanto
  // este overlay quanto a fotografia congelada de missão encerrada. A cadeia
  // inteira é conferida para o histórico não deixar de gatear em silêncio.
  assert.match(guiPane, /const inert = Boolean\(historyTarget\) \|\| readOnly/u)
  assert.match(guiPane, /!inert && !awaitingCard/u)
  assert.match(css, /operação única `harden`/u)
  assert.match(css, /prefers-reduced-motion: reduce/u)
  assert.match(css, /forced-colors: active/u)
})

test('R24.2 — a rota por pane atravessa main e preload, e o índice normaliza o codex', async () => {
  const root = new URL('..', import.meta.url)
  const [ipc, preload] = await Promise.all(
    ['src/main/ipc/history.ts', 'src/preload/index.ts'].map((path) =>
      readFile(new URL(path, root), 'utf8')
    )
  )

  // A rota nova reusa a MESMA porteira de segurança do `history:load`.
  assert.match(ipc, /ipcMain\.handle\(\s*'history:loadForPane'/u)
  assert.match(ipc, /localHistoryLocatorIsSafe/u)
  assert.match(ipc, /locateHistorySessionFile/u)
  assert.match(ipc, /loadLocalHistorySessionPage/u)
  // Carona: o índice de bindings guarda o id CRU, sem o prefixo do codex —
  // sem isto o hit de codex nunca ganha paneId/canMount (bug latente de 2026-08-20).
  assert.match(ipc, /historySessionIdOf\(input\.sessionId\)/u)
  assert.match(preload, /ipcRenderer\.invoke\('history:loadForPane', paneId, page\)/u)
})
