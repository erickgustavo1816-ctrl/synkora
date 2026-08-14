import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  formatGuiElapsed,
  guiActivityLabel,
  transitionGuiStartedAt
} from '../src/renderer/src/guiActivity.ts'
import {
  guiEscapeAction,
  shouldInterruptGuiOnEscape
} from '../src/renderer/src/guiEscape.ts'
import { nextGuiWordEnd } from '../src/renderer/src/guiStreamReveal.ts'
import {
  appendGuiPresentationSeq,
  isGuiPresentationTerminal,
  isGuiTranscriptPresented
} from '../src/renderer/src/guiPresentation.ts'
import {
  guiContextUsagePresentation,
  guiModelForSelection,
  guiModelLabel,
  guiModelShortName
} from '../src/renderer/src/guiComposerPresentation.ts'
import {
  completeSlashCommand,
  isSlashQueryDismissed,
  slashDismissalAt,
  slashQueryAt
} from '../src/renderer/src/guiSlashAutocomplete.ts'
import {
  completeFileMention,
  escapeMentionOverlayText,
  fileMentionQueryAt,
  filterFileMentions,
  isFileMentionQueryDismissed,
  mentionDismissalAt,
  mentionParts,
  renderMentionOverlayMarkup,
  syncInputOverlayScroll
} from '../src/renderer/src/guiFileMentions.ts'
import {
  appendGuiAttachmentReferences,
  base64FromDataUrl,
  guiAttachmentSizeProblem,
  planGuiAttachmentBatch
} from '../src/renderer/src/guiComposerAttachments.ts'
import { shouldBlurGuiComposerOnOutsidePointerDown } from '../src/renderer/src/guiComposerFocus.ts'
import { closePendingGuiTools, guiClosedLine } from '../src/renderer/src/guiTerminalTools.ts'
import {
  GuiRequestEpoch,
  withoutMissionGuiSlots
} from '../src/renderer/src/guiRequestEpoch.ts'
import {
  countGuiOutputLines,
  denyLatestPendingGuiTool,
  groupConsecutiveGuiTools,
  guiToolGroupPreview,
  guiToolResultTargetIndex,
  isGuiShellTool,
  lastPendingGuiToolActivity
} from '../src/renderer/src/guiToolPresentation.ts'
import { nestGuiSubagentTools } from '../src/renderer/src/guiSubagentPresentation.ts'
import { guiSubagentStatusView } from '../src/renderer/src/guiSubagentStatus.ts'
import { asGuiEvent } from '../src/renderer/src/guiApi.ts'
import {
  GUI_DIFF_MAX_CHARS,
  guiToolDiffInputSummary,
  normalizeGuiToolDiff,
  renderGuiFileDiff
} from '../src/renderer/src/guiToolDiff.ts'
import {
  GUI_DIFF_HISTORY_MAX_CHARS,
  GUI_DIFF_HISTORY_MAX_ITEMS,
  pruneGuiDiffHistory
} from '../src/renderer/src/guiDiffHistory.ts'
import {
  GUI_TOOL_INPUT_MAX_CHARS,
  GUI_TOOL_INPUT_MAX_FILES,
  GUI_TOOL_INPUT_TRUNCATED,
  limitGuiToolInput
} from '../src/main/guiToolInput.ts'
import {
  guiMarkdownToPlainText,
  guiMessageCopyPayload,
  writeGuiMessageCopy
} from '../src/renderer/src/guiMessageCopy.ts'
import { isGuiFinalAssistantMessage } from '../src/renderer/src/guiMessageCopyPresentation.ts'
import {
  guiToolGroupOutcomeView,
  guiToolOutcomeView
} from '../src/renderer/src/guiToolOutcome.ts'
import {
  beginGuiSendBatch,
  canSendGuiMessage,
  guiBackendReadyStatus,
  guiCommandCompletionStatus,
  guiSessionRestartState,
  guiTransportFailureStatus,
  isSameGuiTurn,
  shouldApplyGuiBufferedEvent,
  shouldCreateGuiSession,
  settleGuiActionFailure,
  settleGuiRespawnStream,
  settleGuiSendBatch
} from '../src/renderer/src/guiTransport.ts'
import {
  enqueueGuiInteraction,
  removeGuiInteraction,
  settleGuiInteractionFailure
} from '../src/renderer/src/guiInteractionQueue.ts'
import { guiToolResultDetails } from '../src/main/guiToolResults.ts'
import {
  GUI_PROTOCOL_LINE_MAX_CHARS,
  GuiProtocolStream,
  isGuiClaudeProtocolEnvelope,
  isGuiCodexProtocolEnvelope,
  parseGuiProtocolLine
} from '../src/main/guiProtocolLine.ts'
import {
  guiCodexErrorWillRetry,
  guiCodexToolCompletion,
  guiCodexTurnOutcome,
  isGuiCodexToolType
} from '../src/main/guiCodexTools.ts'
import {
  advanceGuiTurn,
  canFlushGuiTurnResult,
  enqueueGuiTurn,
  ownsFailedGuiSteer,
  shouldArmGuiTurnWatchdog
} from '../src/main/guiTurnQueue.ts'
import {
  findGuiFileTokens,
  guiInlineCodeFileToken
} from '../src/renderer/src/guiFileTokens.ts'

import {
  GuiWorkspaceFileIndex,
  scanGuiWorkspaceFiles
} from '../src/main/guiWorkspaceFiles.ts'

const tool = (id, name = 'Read', summary = `${id}.ts`) => ({
  id,
  kind: 'tool',
  name,
  summary,
  at: 1
})

const note = (id, text = 'marco') => ({ id, kind: 'note', text, at: 1 })

test('chat reconhece arquivos sem capturar HTTPS, versao ou email', () => {
  const text =
    'Veja src/main/app.ts, foo.ts e README. Versão 2.0; me@example.com; https://example.com/docs/site.ts.'
  assert.deepEqual(
    findGuiFileTokens(text).map((token) => token.value),
    ['src/main/app.ts', 'foo.ts', 'README']
  )
  assert.equal(
    guiInlineCodeFileToken('C:\\Work tree\\src\\app.ts'),
    'C:\\Work tree\\src\\app.ts'
  )
  assert.equal(guiInlineCodeFileToken('const file = "app.ts"'), null)

  const markdown = readFileSync(
    new URL('../src/renderer/src/components/GuiMarkdown.tsx', import.meta.url),
    'utf8'
  )
  assert.match(markdown, /linkifyGuiFileReferences\(routeChatLinksExternally\(sanitized\)\)/u)
  assert.match(markdown, /parent\.closest\('a, button, pre'\)/u)
  assert.match(markdown, /guiApi\.fileOpen\(paneId, reference, selectedPath\)/u)
})

test('autocomplete slash fecha a conclusao e so reabre para outra consulta valida', () => {
  const draft = 'ajuste /mo depois'
  const cursor = 'ajuste /mo'.length
  const command = { name: 'model' }
  const staleCursor = 'ajuste /model'.length

  for (const trigger of ['mouse', 'Tab', 'Enter']) {
    const completion = completeSlashCommand(draft, cursor, command)
    assert.ok(completion, `${trigger} conclui uma consulta valida`)
    assert.equal(completion.text, 'ajuste /model  depois')
    assert.equal(completion.cursor, 'ajuste /model '.length)
    assert.equal(slashQueryAt(completion.text, completion.cursor), null)

    const staleQuery = slashQueryAt(completion.text, staleCursor)
    assert.deepEqual(staleQuery, { at: 'ajuste '.length, query: 'model' })
    assert.equal(
      isSlashQueryDismissed(completion.dismissal, completion.text, staleQuery),
      true,
      `${trigger} nao reabre pelo cursor antigo dentro do comando inserido`
    )
  }

  const escapedText = '/model'
  const escapedQuery = slashQueryAt(escapedText, escapedText.length)
  const escapedDismissal = slashDismissalAt(escapedText, escapedQuery?.at ?? -1)
  assert.equal(isSlashQueryDismissed(escapedDismissal, escapedText, escapedQuery), true)

  const freshText = `${escapedText} /help`
  const freshQuery = slashQueryAt(freshText, freshText.length)
  assert.deepEqual(freshQuery, { at: '/model '.length, query: 'help' })
  assert.equal(isSlashQueryDismissed(escapedDismissal, freshText, freshQuery), false)

  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const menu = readFileSync(
    new URL('../src/renderer/src/components/GuiSlashMenu.tsx', import.meta.url),
    'utf8'
  )
  assert.match(menu, /onClick=\{\(\) => onPick\(command\)\}/u)
  assert.match(pane, /e\.key === 'Tab' \|\| e\.key === 'Enter'/u)
  assert.match(pane, /onPick=\{pickCommand\}/u)
  assert.match(pane, /onSelect=\{\(e\) => \{/u)
  assert.doesNotMatch(pane, /setDraft\(\(text\) => `\$\{text\} `\)/u)
})

test('menções @arquivo filtram, escapam, selecionam sem enviar e cacheiam a árvore', () => {
  const draft = 'veja @src/ui'
  const query = fileMentionQueryAt(draft, draft.length)
  assert.deepEqual(query, { at: 5, cursor: draft.length, query: 'src/ui' })
  assert.deepEqual(filterFileMentions(['README.md', 'src/ui/App.tsx', 'src/api.ts'], 'ui'), [
    'src/ui/App.tsx'
  ])
  assert.deepEqual(completeFileMention(draft, draft.length, 'src/ui/App.tsx'), {
    text: 'veja @src/ui/App.tsx ',
    cursor: 'veja @src/ui/App.tsx '.length
  })
  assert.equal(completeFileMention('@src/ui', '@src/ui'.length, '../outside.txt'), null)
  assert.deepEqual(filterFileMentions(['../outside.txt', 'src/ui/App.tsx'], ''), ['src/ui/App.tsx'])
  const dismissedQuery = fileMentionQueryAt('@src/u', '@src/u'.length)
  const dismissal = mentionDismissalAt('@src/u', dismissedQuery?.at ?? 0)
  assert.equal(isFileMentionQueryDismissed(dismissal, '@src/u', dismissedQuery), true)
  assert.deepEqual(mentionParts('x <raw> @src/ui/App.tsx', ['src/ui/App.tsx']), [
    { text: 'x <raw> ', mentioned: false },
    { text: '@src/ui/App.tsx', mentioned: true }
  ])
  assert.equal(escapeMentionOverlayText('<script>&"\''), '&lt;script&gt;&amp;&quot;&#39;')
  assert.match(
    renderMentionOverlayMarkup('<raw> @src/ui/App.tsx', ['src/ui/App.tsx']),
    /&lt;raw&gt;.*gui-mention-token/u
  )
  const overlay = { scrollTop: 0, scrollLeft: 0, style: { transform: '' } }
  syncInputOverlayScroll({ scrollTop: 18, scrollLeft: 4 }, overlay)
  assert.deepEqual(overlay, {
    scrollTop: 18,
    scrollLeft: 4,
    style: { transform: 'translate(-4px, -18px)' }
  })

  const root = join(tmpdir(), `synkora-p5-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  try {
    mkdirSync(join(root, 'src', 'ui'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, 'README.md'), 'readme')
    writeFileSync(join(root, 'src', 'ui', 'App.tsx'), 'app')
    writeFileSync(join(root, 'src', 'ui', 'Button.tsx'), 'button')
    writeFileSync(join(root, '.env'), 'synthetic=not-a-secret')
    writeFileSync(join(root, 'private.pem'), 'synthetic')
    writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'ignored')
    let linked = false
    try {
      symlinkSync(join(root, 'src'), join(root, 'linked-src'), 'junction')
      linked = true
    } catch {
      // Symlinks podem estar bloqueados pela política do Windows do runner;
      // os asserts de caminho relativo abaixo continuam cobrindo traversal.
    }

    const index = new GuiWorkspaceFileIndex()
    const first = index.list(root)
    assert.equal(first.ok, true)
    assert.equal(first.cached, false)
    assert.deepEqual(first.files, ['README.md', 'src/ui/App.tsx', 'src/ui/Button.tsx'])
    assert.equal(first.files?.some((file) => file.includes('..') || file.startsWith('/')), false)
    assert.equal(first.files?.some((file) => file.startsWith('node_modules/')), false)
    assert.equal(first.files?.includes('.env'), false)
    assert.equal(first.files?.includes('private.pem'), false)
    if (linked) assert.equal(first.files?.some((file) => file.startsWith('linked-src/')), false)

    writeFileSync(join(root, 'new.ts'), 'new')
    const cached = index.list(root)
    assert.equal(cached.cached, true)
    assert.equal(cached.files?.includes('new.ts'), false)
    index.invalidate(root)
    const refreshed = index.list(root)
    assert.equal(refreshed.cached, false)
    assert.equal(refreshed.files?.includes('new.ts'), true)

    const limited = scanGuiWorkspaceFiles(root, { maxFiles: 2 })
    assert.equal(limited.truncated, true)
    assert.equal(limited.files.length, 2)
    assert.equal(scanGuiWorkspaceFiles(join(root, 'missing')).files.length, 0)
    assert.equal(existsSync(join(root, 'new.ts')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  const ipc = readFileSync(new URL('../src/main/ipc/gui.ts', import.meta.url), 'utf8')
  assert.match(pane, /useGuiFileMentions\(paneId, draft, slashCursor, slashOpen\)/u)
  assert.match(pane, /if \(slashOpen\) \{/u)
  assert.match(pane, /if \(e\.key === 'Tab' \|\| e\.key === 'Enter'\)/u)
  assert.match(pane, /fileMentions\.complete\(path, cursor\)/u)
  assert.match(pane, /syncInputOverlayScroll\(input, mentionOverlayRef\.current\)/u)
  assert.match(css, /\.gui-mention-overlay\s*\{/u)
  assert.match(css, /\.gui-mention-token\s*\{[^}]*hsl\(var\(--hue-back\)/su)
  assert.match(preload, /ipcRenderer\.invoke\('gui:workspaceFiles', paneId\)/u)
  assert.match(ipc, /registry\.cwdOf\(paneId\)/u)
  assert.match(ipc, /workspaceFileIndex\.list\(cwd\)/u)
})

test('composer reduz modelo à identidade e só mostra contexto medido', () => {
  assert.equal(
    guiModelShortName({ value: 'opus[1m]', displayName: 'Opus (1M context)' }),
    'Opus'
  )
  assert.equal(
    guiModelShortName({ value: 'default', displayName: 'Default (recommended)' }),
    'Default'
  )
  assert.equal(
    guiModelShortName({ value: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' }),
    'GPT-5.6 Sol'
  )
  const models = [
    {
      value: 'opus[1m]',
      resolvedModel: 'claude-opus-5',
      displayName: 'Opus (1M context)'
    },
    { value: 'sonnet', displayName: 'Sonnet' }
  ]
  assert.equal(guiModelForSelection(models, 'opus[1m]')?.value, 'opus[1m]')
  assert.equal(guiModelForSelection(models, 'claude-opus-5')?.value, 'opus[1m]')
  assert.equal(guiModelLabel(models, 'claude-opus-5', 'fallback'), 'Opus 5')
  assert.equal(guiModelLabel(models, 'desconhecido', 'Personalizado'), 'Personalizado')
  assert.deepEqual(guiContextUsagePresentation(51_000, 200_000), {
    percent: 26,
    label: '26% contexto',
    title: '51.0 mil de 200 mil tokens usados'
  })
  assert.equal(guiContextUsagePresentation(10, null), null)
  assert.equal(guiContextUsagePresentation(Number.NaN, 200_000), null)
})

test('anexos entram no rascunho sem enviar e respeitam o teto local', () => {
  assert.equal(base64FromDataUrl('data:text/plain;base64,YWJj'), 'YWJj')
  assert.equal(base64FromDataUrl('YWJj'), null)
  assert.equal(guiAttachmentSizeProblem('foto.png', 10 * 1024 * 1024), null)
  assert.match(guiAttachmentSizeProblem('video.mov', 10 * 1024 * 1024 + 1) ?? '', /10 MB/u)
  const batch = planGuiAttachmentBatch([
    ...Array.from({ length: 20 }, (_, index) => ({ name: `${index}.txt`, size: 1 })),
    { name: 'extra.txt', size: 1 }
  ])
  assert.equal(batch.accepted.length, 20)
  assert.match(batch.errors[0], /no máximo 20/u)
  assert.equal(
    appendGuiAttachmentReferences('Confira isto:', ['C:\\work\\foto.png', '']),
    'Confira isto:\nAnexo disponível em: C:\\work\\foto.png'
  )
})

test('revelação grande avança exatamente uma palavra por passo', () => {
  const text = Array.from({ length: 500 }, (_, i) => `palavra${i}`).join(' ')
  let cursor = 0
  for (let expected = 1; expected <= 12; expected += 1) {
    cursor = nextGuiWordEnd(text, cursor)
    assert.equal(text.slice(0, cursor).trim().split(/\s+/u).length, expected)
  }
})

test('espaços iniciais e finais acompanham a palavra sem criar rajada', () => {
  const text = '  uma   duas\ntrês'
  const first = nextGuiWordEnd(text, 0)
  assert.equal(text.slice(0, first), '  uma   ')
  const second = nextGuiWordEnd(text, first)
  assert.equal(text.slice(0, second), '  uma   duas\n')
})

test('deltas a cada 10 ms não reiniciam o relógio nem revelam rajada', () => {
  let buffer = ''
  let shown = 0
  let ticks = 0
  for (let elapsed = 0; elapsed <= 520; elapsed += 2) {
    if (elapsed % 10 === 0) buffer += ` palavra${elapsed / 10}`
    if (elapsed > 0 && elapsed % 52 === 0) {
      const before = buffer.slice(0, shown).trim().split(/\s+/u).filter(Boolean).length
      shown = nextGuiWordEnd(buffer, shown)
      const after = buffer.slice(0, shown).trim().split(/\s+/u).filter(Boolean).length
      assert.ok(after - before <= 1, `tick ${elapsed} revelou mais de uma palavra`)
      ticks += 1
    }
  }
  assert.equal(ticks, 10)
  assert.equal(buffer.slice(0, shown).trim().split(/\s+/u).length, 10)
  assert.ok(shown < buffer.length, 'a fila continua independente do transporte')
})

test('aviso terminal espera o texto visível, mas conserva fatal e closed separados', () => {
  assert.equal(isGuiPresentationTerminal({ type: 'result' }), true)
  assert.equal(isGuiPresentationTerminal({ type: 'fatal' }), true)
  assert.equal(isGuiPresentationTerminal({ type: 'closed' }), true)
  assert.equal(
    isGuiPresentationTerminal({ type: 'turn-continuation', continues: false }),
    true
  )
  assert.equal(
    isGuiPresentationTerminal({ type: 'turn-continuation', continues: true }),
    false
  )

  let pending = appendGuiPresentationSeq([], 10)
  pending = appendGuiPresentationSeq(pending, 11)
  pending = appendGuiPresentationSeq(pending, 11)
  assert.deepEqual(pending, [10, 11])

  assert.equal(
    isGuiTranscriptPresented([
      { kind: 'assistant', text: 'resposta completa', live: false, animateFrom: 8 }
    ]),
    false
  )
  assert.equal(
    isGuiTranscriptPresented([
      { kind: 'assistant', text: 'resposta completa', live: false, animateFrom: 17 },
      { kind: 'tool', live: true }
    ]),
    true
  )
})

test('troca de seat invalida uma guiSpec antiga antes de ela resolver', async () => {
  const epochs = new GuiRequestEpoch()
  const captured = epochs.capture('missao-1')
  let applied = false
  const oldRequest = Promise.resolve().then(() => {
    if (epochs.isCurrent('missao-1', captured)) applied = true
  })
  epochs.invalidate('missao-1')
  await oldRequest
  assert.equal(applied, false)
})

test('primeira escolha de seat acorda a abertura mesmo sem slots anteriores', () => {
  const empty = {}
  const next = withoutMissionGuiSlots(empty, 'missao-1')
  assert.notEqual(next, empty)
  assert.deepEqual(next, {})

  const populated = { 'missao-1': [{ paneId: 'antigo' }], outra: [{ paneId: 'vivo' }] }
  assert.deepEqual(withoutMissionGuiSlots(populated, 'missao-1'), {
    outra: [{ paneId: 'vivo' }]
  })
})

test('atividade preserva o início no turno e zera só ao encerrar', () => {
  assert.equal(transitionGuiStartedAt(null, 'working', 1_000), 1_000)
  assert.equal(transitionGuiStartedAt(1_000, 'working', 9_000), 1_000)
  assert.equal(transitionGuiStartedAt(1_000, 'waiting-you', 9_000), 1_000)
  assert.equal(transitionGuiStartedAt(1_000, 'idle', 9_000), null)
  assert.equal(transitionGuiStartedAt(1_000, 'dead', 9_000), null)
})

test('atividade gira a cada quatro segundos e fato do backend sempre vence', () => {
  assert.equal(guiActivityLabel(0), 'pensando')
  assert.equal(guiActivityLabel(4_000), 'analisando')
  assert.equal(guiActivityLabel(8_000), 'trabalhando')
  assert.equal(guiActivityLabel(12_000), 'raciocinando')
  assert.equal(guiActivityLabel(16_000), 'pensando')
  assert.equal(guiActivityLabel(99_000, 'Bash · npm test'), 'Bash · npm test')
  assert.equal(formatGuiElapsed(65_999), '1:05')
  assert.equal(formatGuiElapsed(3_661_000), '1:01:01')
})

test('Esc respeita pergunta e menu antes de interromper', () => {
  assert.equal(
    shouldInterruptGuiOnEscape('Escape', { working: true, questionOpen: false, menuOpen: false }),
    true
  )
  assert.equal(
    shouldInterruptGuiOnEscape('Escape', { working: true, questionOpen: true, menuOpen: false }),
    false
  )
  assert.equal(
    shouldInterruptGuiOnEscape('Escape', { working: true, questionOpen: false, menuOpen: true }),
    false
  )
  assert.equal(
    shouldInterruptGuiOnEscape('Escape', { working: false, questionOpen: false, menuOpen: false }),
    false
  )
  assert.equal(
    guiEscapeAction('Escape', { working: true, questionOpen: false, menuOpen: true }),
    'dismiss-menu'
  )
  assert.equal(
    guiEscapeAction('Escape', { working: true, questionOpen: true, menuOpen: false }),
    'none'
  )
})

test('uma tool fica crua; duas iguais viram grupo sem mutar o estado', () => {
  const single = [tool('a')]
  assert.deepEqual(groupConsecutiveGuiTools(single), single)

  const items = [tool('a'), tool('b'), note('n'), tool('c')]
  const snapshot = structuredClone(items)
  const rendered = groupConsecutiveGuiTools(items)
  assert.equal(rendered[0].kind, 'tool-group')
  assert.equal(rendered[0].items.length, 2)
  assert.equal(guiToolGroupPreview(rendered[0]), 'a.ts, b.ts')
  assert.equal(rendered[1].kind, 'note', 'item visível quebra a sequência')
  assert.equal(rendered[2].kind, 'tool', 'tool isolada continua crua')
  assert.deepEqual(items, snapshot, 'transformação de render nunca toca no store')

  const paths = groupConsecutiveGuiTools([
    tool('p1', 'Read', 'C:\\repo\\src\\a.ts'),
    tool('p2', 'Read', 'C:\\repo\\src\\b.ts'),
    tool('p3', 'Read', 'C:\\repo\\src\\c.ts')
  ])
  assert.equal(guiToolGroupPreview(paths[0]), 'a.ts, b.ts, +1')
})

test('nome diferente e ferramenta interativa quebram o agrupamento', () => {
  const different = groupConsecutiveGuiTools([tool('a'), tool('b', 'Grep'), tool('c')])
  assert.deepEqual(different.map((item) => item.kind), ['tool', 'tool', 'tool'])

  const interactive = groupConsecutiveGuiTools([
    tool('a'),
    tool('q', 'AskUserQuestion'),
    tool('b')
  ])
  assert.deepEqual(interactive.map((item) => item.kind), ['tool', 'tool', 'tool'])

  const hiddenReasoning = groupConsecutiveGuiTools([
    tool('a'),
    { id: 'thinking-1', kind: 'invisible' },
    tool('b')
  ])
  assert.equal(hiddenReasoning.length, 1)
  assert.equal(hiddenReasoning[0].kind, 'tool-group')
  assert.equal(hiddenReasoning[0].items.length, 2)
})

test('família de terminal é classificada por token', () => {
  for (const name of ['Bash', 'shell_command', 'ExecCommand', 'run-terminal']) {
    assert.equal(isGuiShellTool(name), true, name)
  }
  for (const name of ['Read', 'Truncate', 'WebSearch']) {
    assert.equal(isGuiShellTool(name), false, name)
  }
})

test('linha de comando conhece output inteiro antes do preview capado', () => {
  assert.equal(countGuiOutputLines('a\r\nb\r\nc\r\n'), 3)
  assert.equal(countGuiOutputLines(''), 0)

  const full = Array.from({ length: 80 }, (_, i) => `linha-${i}`).join('\n')
  const details = guiToolResultDetails(full, 40)
  assert.equal(details.lineCount, 80)
  assert.equal(details.truncated, true)
  assert.ok(details.text.endsWith('…'))

  assert.deepEqual(guiToolResultDetails('\r\n', 40), {
    text: '',
    lineCount: 0,
    truncated: false
  })
  const manyLines = `${'x\n'.repeat(100_000)}fim`
  assert.deepEqual(guiToolResultDetails(manyLines, 3), {
    text: 'x\nx…',
    lineCount: 100_001,
    truncated: true
  })
})

test('JSONL inválido é erro de protocolo em vez de sumir e prender o turno', () => {
  assert.deepEqual(parseGuiProtocolLine('{"type":"result"}'), {
    ok: true,
    value: { type: 'result' }
  })
  assert.deepEqual(parseGuiProtocolLine('{quebrado'), { ok: false })
  assert.deepEqual(parseGuiProtocolLine('x'.repeat(GUI_PROTOCOL_LINE_MAX_CHARS + 1)), {
    ok: false
  })
  assert.equal(isGuiClaudeProtocolEnvelope({}), false)
  assert.equal(isGuiClaudeProtocolEnvelope({ type: 'result' }), true)
  assert.equal(isGuiCodexProtocolEnvelope({}), false)
  assert.equal(isGuiCodexProtocolEnvelope({ id: 1, result: {} }), true)
  assert.equal(isGuiCodexProtocolEnvelope({ method: 'turn/started' }), true)

  const stream = new GuiProtocolStream(32)
  const utf8 = Buffer.from('ação\nfim')
  assert.deepEqual(stream.push(utf8.subarray(0, 2)), { lines: [], overflow: false })
  assert.deepEqual(stream.push(utf8.subarray(2)), { lines: ['ação'], overflow: false })
  assert.deepEqual(stream.end(), { lines: ['fim'], overflow: false })
  assert.deepEqual(new GuiProtocolStream(3).push(Buffer.from('abcd')), {
    lines: [],
    overflow: true
  })

  for (const file of ['codexSession.ts', 'maestroSession.ts']) {
    const source = readFileSync(new URL(`../src/main/${file}`, import.meta.url), 'utf8')
    assert.match(source, /parseGuiProtocolLine/u)
    assert.match(source, /new GuiProtocolStream\(\)/u)
    assert.match(source, /resposta de protocolo inválida/u)
    assert.match(source, /this\.kill\(\)/u)
  }
})

test('fim de comando local não encerra um turno nem um pedido humano', () => {
  assert.equal(guiCommandCompletionStatus('working', true, false), 'working')
  assert.equal(guiCommandCompletionStatus('working', false, false), 'idle')
  assert.equal(guiCommandCompletionStatus('working', false, true), 'waiting-you')
  assert.equal(guiCommandCompletionStatus('dead', true, true), 'dead')

  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  const sessions = readFileSync(new URL('../src/main/guiSessions.ts', import.meta.url), 'utf8')
  const codex = readFileSync(new URL('../src/main/codexSession.ts', import.meta.url), 'utf8')
  assert.match(store, /case 'command-completed'/u)
  assert.match(sessions, /type: 'command-completed'/u)
  assert.match(codex, /private beginTurnStart\(operationId: number \| null\)/u)
  assert.match(codex, /if \(pending\.operationId !== null\)/u)
})

test('resultado Codex espera steer tardio e reconcilia quando ele assenta', () => {
  assert.equal(canFlushGuiTurnResult(1, false), false)
  assert.equal(canFlushGuiTurnResult(0, false), true)
  assert.equal(canFlushGuiTurnResult(1, true), true)
  assert.equal(ownsFailedGuiSteer('turn-a', 'turn-a'), true)
  assert.equal(ownsFailedGuiSteer('turn-b', 'turn-a'), false)
  assert.equal(ownsFailedGuiSteer(null, 'turn-a'), false)

  const codex = readFileSync(new URL('../src/main/codexSession.ts', import.meta.url), 'utf8')
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  assert.match(codex, /private terminalReconcilePending = false/u)
  assert.match(
    codex,
    /this\.pendingSendOperations\.delete\(operationId\)[\s\S]*this\.reconcileTerminalContinuation\(\)/u
  )
  assert.match(codex, /type: 'turn-continuation'/u)
  assert.match(store, /case 'turn-continuation'/u)
})

test('replay usa cursor, preserva deltas iguais e recria somente pane ausente', () => {
  assert.equal(shouldApplyGuiBufferedEvent(8, 7), true)
  assert.equal(shouldApplyGuiBufferedEvent(7, 7), false)
  assert.equal(shouldApplyGuiBufferedEvent(null, 7), true)
  assert.equal(shouldCreateGuiSession(true, true), false)
  assert.equal(shouldCreateGuiSession(true, false), true)
  assert.equal(shouldCreateGuiSession(false, false), true)
  assert.equal(guiBackendReadyStatus('dead'), 'dead')
  assert.equal(guiBackendReadyStatus('starting'), 'idle')
  assert.equal(guiBackendReadyStatus('working'), 'working')
  assert.deepEqual(guiSessionRestartState(true, false), { ready: false, status: 'starting' })
  assert.deepEqual(guiSessionRestartState(true, true), { ready: true, status: 'idle' })
  assert.deepEqual(guiSessionRestartState(false, true), { ready: false, status: 'starting' })

  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(pane, /replayOverlap|JSON\.stringify\(replay/u)
  assert.match(pane, /event\.seq, replay\.cursor/u)
  assert.match(pane, /replay\.exists && !replay\.alive/u)
  assert.match(pane, /shouldCreateGuiSession\(replay\.exists, replay\.alive\)/u)
  assert.match(store, /case 'session-restarted'/u)
  assert.match(store, /case 'user-message'/u)
})

test('respawn fecha resposta parcial antes de aceitar deltas da geração nova', () => {
  const partial = settleGuiRespawnStream(
    [
      { id: 'user-1', kind: 'user', text: 'pergunta' },
      { id: 'assistant-1', kind: 'assistant', text: 'resposta par', live: true }
    ],
    'assistant-1',
    false
  )
  assert.deepEqual(partial, {
    items: [
      { id: 'user-1', kind: 'user', text: 'pergunta' },
      { id: 'assistant-1', kind: 'assistant', text: 'resposta par', live: false }
    ],
    stream: '',
    activeAssistantId: null,
    turnHadText: true
  })
})

test('firstPrompt espera a cadeia completa de initialize e capacidades', () => {
  const sessions = readFileSync(new URL('../src/main/guiSessions.ts', import.meta.url), 'utf8')
  assert.match(sessions, /const READY_TIMEOUT_MS = 45_000/u)
  assert.match(sessions, /\.then\(\(caps\) => \{[\s\S]*if \(!caps/u)
})

test('duas mensagens Claude mantêm gerações FIFO após o primeiro resultado', () => {
  let pending = enqueueGuiTurn([], 41)
  pending = enqueueGuiTurn(pending, 42)
  assert.deepEqual(pending, [41, 42])
  const first = advanceGuiTurn(pending)
  assert.deepEqual(first, { completed: 41, active: 42, pending: [42] })
  assert.deepEqual(advanceGuiTurn(first.pending), {
    completed: 42,
    active: null,
    pending: []
  })

  const claude = readFileSync(
    new URL('../src/main/maestroSession.ts', import.meta.url),
    'utf8'
  )
  assert.match(claude, /continues: this\.activeTurnGeneration !== null/u)
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  assert.match(store, /status === 'idle' && evt\.continues \? 'working' : status/u)
  assert.equal(shouldArmGuiTurnWatchdog(0, true, false), true)
  assert.equal(shouldArmGuiTurnWatchdog(0, true, true), false)
  assert.equal(shouldArmGuiTurnWatchdog(600_000, true, false), false)
})

test('resultado fora de ordem conserva a atividade factual ainda pendente', () => {
  const items = [
    tool('a', 'Read', 'a.ts'),
    {
      ...tool('b', 'Read', 'b.ts'),
      result: { text: '', isError: false, lineCount: 0, truncated: false }
    }
  ]
  assert.equal(lastPendingGuiToolActivity(items), 'Read · a.ts')
})

test('resultado de tool encontra o card pelo id, inclusive fora de ordem', () => {
  const items = [
    { ...tool('a'), toolUseId: 'call-a' },
    { ...tool('b'), toolUseId: 'call-b' }
  ]
  assert.equal(guiToolResultTargetIndex(items, 'call-a'), 0)
  assert.equal(guiToolResultTargetIndex(items, 'call-b'), 1)
  assert.equal(guiToolResultTargetIndex(items, 'desconhecida'), -1)
  assert.equal(guiToolResultTargetIndex(items), 1, 'replay legado usa só o último pendente')
})

test('result, fatal e closed encerram tools pendentes sem tocar nas concluídas', () => {
  const completed = {
    ...tool('pronta', 'Read', 'pronta.ts'),
    result: {
      text: 'ok',
      isError: false,
      status: 'completed',
      lineCount: 1,
      truncated: false
    }
  }
  const cases = [
    {
      event: { type: 'result', isError: false, outcome: 'cancelled' },
      status: 'cancelled',
      isError: false
    },
    {
      event: { type: 'fatal', text: 'ponte caiu' },
      status: 'failed',
      isError: true
    },
    {
      event: { type: 'closed', code: 9 },
      status: 'failed',
      isError: true
    }
  ]

  for (const sample of cases) {
    const pending = tool(`pendente-${sample.event.type}`, 'Bash', 'npm test')
    const items = closePendingGuiTools([pending, completed], sample.event)
    assert.equal(items[0].result.status, sample.status)
    assert.equal(items[0].result.isError, sample.isError)
    assert.equal(items[1], completed, 'resultado autoritativo é preservado')
    assert.equal(pending.result, undefined, 'o estado de entrada continua cru')
  }
  assert.deepEqual(guiClosedLine(7), {
    kind: 'error',
    text: 'a sessão encerrou com código 7'
  })
  assert.deepEqual(guiClosedLine(0), { kind: 'note', text: 'sessão encerrada' })
  assert.deepEqual(guiClosedLine(0, true), {
    kind: 'error',
    text: 'a sessão encerrou antes de receber o resultado de uma ferramenta'
  })

  const orphan = closePendingGuiTools(
    [tool('orfã', 'Patch', 'src/a.ts')],
    { type: 'result', isError: false, outcome: 'completed' }
  )
  assert.equal(orphan[0].result.status, 'failed')
  assert.equal(orphan[0].result.isError, true)
})

test('resultado terminal antes do tool-result reconcilia por ID sem esconder órfão', () => {
  const lateTool = { ...tool('late', 'WebSearch', 'consulta'), toolUseId: 'late-call' }
  const terminal = closePendingGuiTools([lateTool], {
    type: 'result',
    isError: false,
    outcome: 'completed'
  })
  assert.equal(terminal[0].result.provisional, true)
  assert.equal(
    guiToolResultTargetIndex(terminal, 'late-call'),
    0,
    'o resultado tardio ainda encontra o card pelo toolUseId'
  )

  const completed = {
    ...terminal[0],
    result: {
      text: 'resultado WebSearch',
      isError: false,
      status: 'completed',
      lineCount: 1,
      truncated: false
    }
  }
  assert.equal(completed.result.provisional, undefined)
  assert.equal(
    guiToolResultTargetIndex([completed], 'late-call'),
    -1,
    'card já autoritativo não aceita uma segunda conclusão'
  )

  const genuineOrphan = closePendingGuiTools(
    [{ ...tool('orphan', 'WebSearch', 'sem retorno'), toolUseId: 'orphan-call' }],
    { type: 'result', isError: false, outcome: 'completed' }
  )
  assert.equal(genuineOrphan[0].result.status, 'failed')
  assert.equal(genuineOrphan[0].result.isError, true)
  assert.equal(genuineOrphan[0].result.provisional, true)
})

test('lote de envios só fecha o turno depois que todos falham', () => {
  let batch = beginGuiSendBatch(null, 'lote-1', 'envio-a', 7, true)
  batch = beginGuiSendBatch(batch, 'lote-1', 'envio-b', 7, false)

  const first = settleGuiSendBatch(batch, 'lote-1', 'envio-a', false, 7)
  assert.equal(first.closeTurn, false)
  assert.deepEqual(first.batch?.requestIds, ['envio-b'])

  const last = settleGuiSendBatch(first.batch, 'lote-1', 'envio-b', false, 7)
  assert.equal(last.closeTurn, true)
  assert.equal(last.batch, null)
  assert.equal(guiTransportFailureStatus('working', 'este pane não tem sessão aberta'), 'dead')
  assert.equal(guiTransportFailureStatus('working', 'falha temporária'), 'idle')
})

test('envio aceito ou evento novo impede falha atrasada de fechar o turno', () => {
  let accepted = beginGuiSendBatch(null, 'lote-ok', 'envio-a', 3, true)
  accepted = beginGuiSendBatch(accepted, 'lote-ok', 'envio-b', 3, false)
  const first = settleGuiSendBatch(accepted, 'lote-ok', 'envio-a', true, 3)
  const last = settleGuiSendBatch(first.batch, 'lote-ok', 'envio-b', false, 3)
  assert.equal(last.closeTurn, false, 'um aceite torna o turno real')

  const stale = beginGuiSendBatch(null, 'lote-velho', 'envio-c', 10, true)
  assert.equal(
    settleGuiSendBatch(stale, 'lote-velho', 'envio-c', false, 11).closeTurn,
    false,
    'evento do backend troca a identidade do turno'
  )
})

test('envio depois de evento real nasce em lote novo, sem herdar Promises antigas', () => {
  let oldBatch = beginGuiSendBatch(null, 'lote-antigo', 'envio-a', 20, true)
  oldBatch = beginGuiSendBatch(oldBatch, 'lote-antigo', 'envio-b', 20, false)

  const current = beginGuiSendBatch(oldBatch, 'lote-novo', 'envio-c', 21, true)
  assert.equal(current.id, 'lote-novo')
  assert.deepEqual(current.requestIds, ['envio-c'])
  assert.equal(current.eventRevision, 21)
  assert.equal(current.accepted, false)

  const failed = settleGuiSendBatch(current, 'lote-novo', 'envio-c', false, 21)
  assert.equal(failed.closeTurn, true, 'C fecha somente o working que C abriu')
  assert.equal(
    settleGuiSendBatch(current, 'lote-antigo', 'envio-a', true, 21).batch,
    current,
    'resposta antiga não toca no lote novo'
  )
})

test('composer espera ready e interrupção atrasada não rebaixa turno novo', () => {
  assert.equal(canSendGuiMessage('starting', true), false)
  assert.equal(canSendGuiMessage('idle', false), false)
  assert.equal(canSendGuiMessage('dead', true), false)
  assert.equal(canSendGuiMessage('idle', true), true)
  assert.equal(canSendGuiMessage('working', true), true)

  const captured = { eventRevision: 8, startedAt: 1_000 }
  assert.equal(isSameGuiTurn(captured, captured), true)
  assert.equal(isSameGuiTurn({ ...captured, eventRevision: 9 }, captured), false)
  assert.equal(isSameGuiTurn({ ...captured, startedAt: 2_000 }, captured), false)
})

test('Codex fecha todas as famílias de tool e não pinta falha como sucesso', () => {
  for (const type of ['commandExecution', 'fileChange', 'webSearch', 'mcpToolCall']) {
    assert.equal(isGuiCodexToolType(type), true)
    assert.deepEqual(guiCodexToolCompletion({ type, status: 'completed' }), {
      text: '',
      isError: false,
      outcome: 'completed'
    })
  }
  assert.deepEqual(
    guiCodexToolCompletion({ type: 'mcpToolCall', status: 'failed', error: 'sem conexão' }),
    { text: 'sem conexão', isError: true, outcome: 'failed' }
  )
  assert.deepEqual(
    guiCodexToolCompletion({ type: 'commandExecution', exitCode: 2, aggregatedOutput: 'boom' }),
    { text: 'boom', isError: true, outcome: 'failed' }
  )
  assert.deepEqual(guiCodexToolCompletion({ type: 'fileChange', status: 'declined' }), {
    text: '',
    isError: false,
    outcome: 'denied'
  })
  assert.deepEqual(guiCodexToolCompletion({ type: 'webSearch', status: 'cancelled' }), {
    text: '',
    isError: false,
    outcome: 'cancelled'
  })
  const boundedResult = guiCodexToolCompletion({
    type: 'mcpToolCall',
    status: 'completed',
    result: { payload: 'x'.repeat(GUI_TOOL_INPUT_MAX_CHARS + 50_000) }
  })
  assert.equal(boundedResult.text, '[resultado estruturado]')
  assert.equal(guiCodexTurnOutcome('completed'), 'completed')
  assert.equal(guiCodexTurnOutcome('failed'), 'failed')
  assert.equal(guiCodexTurnOutcome('interrupted'), 'cancelled')
  assert.equal(guiCodexTurnOutcome('canceled'), 'cancelled')
  assert.equal(guiCodexErrorWillRetry({ willRetry: true, error: { message: 'rede' } }), true)
  assert.equal(guiCodexErrorWillRetry({ error: { message: 'rede', willRetry: true } }), true)
  assert.equal(guiCodexErrorWillRetry({ willRetry: false, error: { message: 'fatal' } }), false)
  const codex = readFileSync(new URL('../src/main/codexSession.ts', import.meta.url), 'utf8')
  assert.match(codex, /if \(!guiCodexErrorWillRetry\(p\)\)[\s\S]*this\.armTurnErrorGuard/u)
})

test('Edit e Write viram diffs limitados sem consultar o disco', () => {
  const edit = normalizeGuiToolDiff('Edit', {
    file_path: 'src/recurso.ts',
    old_string: 'const a = 1\r\nconst b = 2',
    new_string: 'const a = 1\r\nconst b = 3'
  })
  assert.equal(edit?.length, 1)
  assert.equal(edit?.[0].format, 'before-after')
  assert.equal(edit?.[0].oldText, 'const a = 1\nconst b = 2')
  const rendered = renderGuiFileDiff(edit[0])
  assert.equal(rendered.additions, 1)
  assert.equal(rendered.removals, 1)
  assert.equal(rendered.lines.filter((line) => line.kind === 'context').length, 1)
  assert.equal(rendered.simplified, false)

  const write = normalizeGuiToolDiff('Write', {
    file_path: 'src/novo.ts',
    content: 'um\ndois'
  })
  assert.equal(write?.[0].format, 'before-after')
  assert.equal(write?.[0].oldText, null, 'Write não inventa nem lê estado anterior')
  assert.equal(renderGuiFileDiff(write[0]).additions, 2)
  assert.equal(normalizeGuiToolDiff('Read', { file_path: 'src/segredo.ts' }), undefined)
})

test('Patch aceita vários arquivos e conserva operação, caminho e sinais', () => {
  const codex = normalizeGuiToolDiff('Patch', {
    changes: [
      {
        path: 'src/a.ts',
        kind: 'add',
        diff: '@@ -0,0 +1,2 @@\n+um\n+dois'
      },
      {
        path: 'src/antigo.ts',
        move_path: 'src/novo.ts',
        kind: 'move',
        diff: '@@ -1 +1 @@\n-antigo\n+novo'
      }
    ]
  })
  assert.deepEqual(codex?.map((part) => [part.operation, part.path]), [
    ['add', 'src/a.ts'],
    ['move', 'src/antigo.ts']
  ])
  assert.equal(
    guiToolDiffInputSummary({ changes: [
      { path: 'src/a.ts', diff: 'x'.repeat(200_000) },
      { path: 'src/antigo.ts', diff: 'y'.repeat(200_000) }
    ] }),
    'src/a.ts, src/antigo.ts'
  )
  assert.equal(
    guiToolDiffInputSummary({
      patch: `*** Begin Patch\n*** Update File: src/resumo.ts\n${'x'.repeat(300_000)}`
    }),
    'src/resumo.ts'
  )
  assert.equal(codex?.[1].movePath, 'src/novo.ts')
  assert.deepEqual(
    codex?.map((part) => {
      const diff = renderGuiFileDiff(part)
      return [diff.additions, diff.removals]
    }),
    [[2, 0], [1, 1]]
  )

  const applyPatch = normalizeGuiToolDiff('ApplyPatch', {
    patch:
      '*** Begin Patch\n*** Update File: src/a.ts\n@@ -1 +1 @@\n-a\n+b\n' +
      '*** Add File: src/b.ts\n+novo\n*** End Patch'
  })
  assert.deepEqual(applyPatch?.map((part) => [part.operation, part.path]), [
    ['update', 'src/a.ts'],
    ['add', 'src/b.ts']
  ])
})

test('diff gigante respeita o teto e cai em comparação linear honesta', () => {
  const huge = 'x'.repeat(GUI_DIFF_MAX_CHARS + 10_000)
  const write = normalizeGuiToolDiff('Write', { file_path: 'grande.txt', content: huge })
  assert.ok(write[0].newText.length <= GUI_DIFF_MAX_CHARS)
  assert.equal(write[0].truncated, true)

  const oldText = Array.from({ length: 300 }, (_, index) => `antes-${index}`).join('\n')
  const newText = Array.from({ length: 300 }, (_, index) => `depois-${index}`).join('\n')
  const edit = normalizeGuiToolDiff('Edit', {
    file_path: 'grande.ts',
    old_string: oldText,
    new_string: newText
  })
  const rendered = renderGuiFileDiff(edit[0])
  assert.equal(rendered.simplified, true)
  assert.equal(rendered.additions, 300)
  assert.equal(rendered.removals, 300)
})

test('input de tool é limitado antes do replay/IPC e sinaliza o corte ao card', () => {
  const rawContent = 'x'.repeat(GUI_TOOL_INPUT_MAX_CHARS + 20_000)
  const raw = {
    file_path: 'src/grande.ts',
    content: rawContent,
    changes: Array.from({ length: GUI_TOOL_INPUT_MAX_FILES + 8 }, (_, index) => ({
      path: `src/${index}.ts`,
      diff: '+linha'
    }))
  }
  const limited = limitGuiToolInput(raw)
  assert.equal(raw.content, rawContent, 'o input privado do backend permanece integral')
  assert.equal(limited[GUI_TOOL_INPUT_TRUNCATED], true)
  assert.ok(limited.content.length <= GUI_TOOL_INPUT_MAX_CHARS)
  assert.ok(limited.changes.length <= GUI_TOOL_INPUT_MAX_FILES)

  const diff = normalizeGuiToolDiff('Write', limited)
  assert.equal(diff[0].truncated, true, 'o renderer explica que o corte nasceu antes do IPC')

  const sessions = readFileSync(
    new URL('../src/main/guiSessions.ts', import.meta.url),
    'utf8'
  )
  assert.match(sessions, /evt\.type === 'tool' \? \{ \.\.\.evt, input: limitGuiToolInput\(evt\.input\) \} : evt/u)
  assert.match(sessions, /ring\.push\(visibleEvt\)/u)
})

test('histórico de diff tem orçamento agregado e conserva os cards-resumo', () => {
  const items = Array.from({ length: 20 }, (_, index) => ({
    ...tool(`diff-${index}`, 'Write', `src/${index}.ts`),
    fileDiffs: [
      {
        format: 'before-after',
        operation: 'write',
        path: `src/${index}.ts`,
        oldText: null,
        newText: String(index).repeat(100_000),
        truncated: false
      }
    ]
  }))
  const pruned = pruneGuiDiffHistory(items)
  const kept = pruned.filter((item) => item.fileDiffs?.length)
  const chars = kept.reduce((sum, item) => sum + item.fileDiffs[0].newText.length, 0)
  assert.ok(kept.length <= GUI_DIFF_HISTORY_MAX_ITEMS)
  assert.ok(chars <= GUI_DIFF_HISTORY_MAX_CHARS)
  assert.equal(pruned.at(-1).fileDiffs?.length, 1, 'o diff mais recente sempre sobrevive')
  assert.equal(pruned[0].fileDiffs, undefined)
  assert.equal(pruned[0].summary, 'src/0.ts', 'nome e desfecho do card antigo sobrevivem')

  const component = readFileSync(
    new URL('../src/renderer/src/components/GuiToolDiffCard.tsx', import.meta.url),
    'utf8'
  )
  assert.match(component, /expanded \? sources\.map\(renderGuiFileDiff\) : \[\]/u)
  assert.match(component, /\{expanded && \(\s*<div className="gui-diff-files">/u)
})

test('card de permissão expõe a regra permanente antes do clique', () => {
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const claude = readFileSync(new URL('../src/main/maestroSession.ts', import.meta.url), 'utf8')
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  assert.match(pane, /sempre vai gravar: <code>\{perm\.permissionRule\}<\/code>/u)
  assert.match(claude, /resolveChatPermissionSuggestions\(/u)
  assert.match(claude, /permissionRule/u)
  assert.match(store, /permissionRule: evt\.permissionRule/u)
})

test('negação fecha só a ferramenta pendente correspondente', () => {
  const bash = { ...tool('bash-a', 'Bash', 'npm test'), toolUseId: 'call-a' }
  const sibling = { ...tool('bash-b', 'Bash', 'npm build'), toolUseId: 'call-b' }
  const items = denyLatestPendingGuiTool([bash, sibling], 'comando Bash', 'call-a')
  assert.equal(items[0].result?.status, 'denied')
  assert.equal(items[0].result?.isError, false)
  assert.equal(items[1].result, undefined)
  assert.equal(bash.result, undefined, 'entrada permanece imutável')
  assert.equal(
    guiToolResultTargetIndex(items, 'call-b'),
    1,
    'o resultado posterior do irmão continua pareado ao card certo'
  )

  assert.deepEqual(guiToolOutcomeView(items[0].result), {
    tone: 'denied',
    compactLabel: 'negado',
    statusLabel: 'negado'
  })
  assert.equal(
    guiToolOutcomeView({ text: 'primeira falha\ndetalhe', isError: true, status: 'failed' })?.tone,
    'err'
  )
  assert.equal(
    guiToolOutcomeView({ text: '', isError: false, status: 'cancelled' })?.statusLabel,
    'cancelado'
  )
  assert.deepEqual(
    guiToolGroupOutcomeView([
      { text: '', isError: false, status: 'completed' },
      { text: 'boom', isError: true, status: 'failed' },
      undefined
    ]),
    { tone: 'err', compactLabel: 'falhou', statusLabel: 'falhou' }
  )
})

test('fila interativa conserva retry e resolve somente o requestId alvo', () => {
  const captured = { eventRevision: 4, startedAt: 1_000 }
  assert.deepEqual(
    settleGuiActionFailure({ ...captured, status: 'working' }, captured, 'falha temporária'),
    { sameTurn: true, status: 'idle' }
  )
  assert.deepEqual(
    settleGuiActionFailure(
      { eventRevision: 5, startedAt: 2_000, status: 'working' },
      captured,
      'sessão encerrou'
    ),
    { sameTurn: false, status: 'working' }
  )
  const a = { requestId: 'req-a', kind: 'permission' }
  const b = { requestId: 'req-b', kind: 'question' }
  let queue = enqueueGuiInteraction([], a)
  queue = enqueueGuiInteraction(queue, b)
  assert.deepEqual(queue, [a, b])
  assert.deepEqual(
    enqueueGuiInteraction(queue, { ...a, kind: 'permission-atualizada' }),
    [{ ...a, kind: 'permission-atualizada' }, b],
    'retransmissão atualiza no lugar sem furar a fila'
  )
  assert.deepEqual(
    settleGuiInteractionFailure(queue, 'req-a', true),
    [a, b],
    'falha de entrega mantém o card recuperável mesmo se outro evento chegou'
  )
  assert.deepEqual(removeGuiInteraction(queue, 'req-a'), [b])
  assert.deepEqual(settleGuiInteractionFailure(queue, 'req-a', false), [b])

  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  for (const action of ['permission', 'answerQuestion', 'answerPlan']) {
    assert.match(store, new RegExp(`const result = await guiApi\\.${action}\\(`, 'u'))
  }
  assert.ok((store.match(/if \(!result\.ok\)/gu) ?? []).length >= 3)
  assert.match(store, /case 'interaction-resolved'/u)
  assert.match(store, /evt\.resolution\.toolUseId/u)
  assert.match(store, /settleGuiInteractionFailure\(/u)

  const sessions = readFileSync(new URL('../src/main/guiSessions.ts', import.meta.url), 'utf8')
  assert.ok(
    (sessions.match(/type: 'interaction-resolved'/gu) ?? []).length >= 3,
    'as três decisões entram no anel canônico para sobreviver à remontagem'
  )
})

test('cópia markdown é literal e texto remove sintaxe sem perder código', async () => {
  const raw = '  # Título\r\n\r\n```ts\r\nconst x = `*_[]`;\r\n```  '
  assert.equal(guiMessageCopyPayload(raw, 'markdown'), raw)

  const fenced =
    '```ts\nconst x = `*`;\n\nconsole.log(x)\n```\n\n' +
    '~~~js\nlet y = "_"\n~~~\n\n    bloco *cru*'
  assert.equal(
    guiMarkdownToPlainText(fenced),
    'const x = `*`;\n\nconsole.log(x)\n\nlet y = "_"\n\nbloco *cru*'
  )
  assert.equal(
    guiMarkdownToPlainText('**forte e _ênfase_** + `*_[ ]` + \\*literal\\*'),
    'forte e ênfase + *_[ ] + *literal*'
  )

  const written = []
  await writeGuiMessageCopy(async (text) => written.push(text), '**olá**', 'text')
  assert.deepEqual(written, ['olá'])
  await writeGuiMessageCopy(
    async (text) => written.push(text),
    '1. primeiro\n2. segundo\n\n- [x] feito\n- [ ] falta\n\n![diagrama](imagem.png)',
    'text'
  )
  assert.equal(
    written.at(-1),
    '1. primeiro\n2. segundo\n\n• ☑ feito\n• ☐ falta\n\ndiagrama'
  )
  await assert.rejects(
    writeGuiMessageCopy(async () => Promise.reject(new Error('sem clipboard')), 'x', 'markdown'),
    /sem clipboard/u
  )
})

test('texto copiado conserva rótulos, listas e tabelas, mas não destinos ou tags', () => {
  const markdown =
    '# Cabeçalho\n\n' +
    '[rótulo](https://exemplo.com/a_(b)) e [referência][id] e <https://openai.com> ' +
    '![diagrama](imagem.png)\n\n' +
    '- [x] feito\n- [ ] falta\n  1. filho\n\n' +
    '| A | B |\n|---|---|\n| 1 | 2 |\n\n' +
    '<b>seguro &amp; claro</b><script>COMANDO-OCULTO</script>mostrado\n\n' +
    'antes <span hidden>SEGREDO-HIDDEN</span> depois\n\n' +
    '<div style="display:none"><b>SEGREDO-CSS</b></div>visível\n\n' +
    '<template>SEGREDO-TEMPLATE</template><span aria-hidden="true">SEGREDO-ARIA</span>\n\n' +
    '[id]: https://destino.invalid'
  const text = guiMarkdownToPlainText(markdown)
  assert.match(text, /^Cabeçalho/u)
  assert.match(text, /rótulo e referência e https:\/\/openai\.com diagrama/u)
  assert.doesNotMatch(text, /exemplo\.com|destino\.invalid|imagem\.png|<b>|<script>/u)
  assert.match(text, /• ☑ feito\n• ☐ falta\n  1\. filho/u)
  assert.match(text, /A \| B\n1 \| 2/u)
  assert.match(text, /seguro & claromostrado/u)
  assert.match(text, /antes SEGREDO-HIDDEN depois/u)
  assert.match(text, /SEGREDO-CSSvisível/u)
  assert.match(text, /SEGREDO-ARIA/u)
  assert.doesNotMatch(
    text,
    /COMANDO-OCULTO|SEGREDO-TEMPLATE/u
  )
  assert.equal(
    guiMarkdownToPlainText(
      '<span class="gui-sr-only">classe removida</span>' +
        '<details><summary>resumo</summary>corpo visível após sanitizar</details>'
    ),
    'classe removidaresumocorpo visível após sanitizar'
  )
  assert.equal(
    guiMarkdownToPlainText('<script>\n\nSEGREDO-MULTIBLOCO\n\n</script>depois'),
    'depois',
    'a pilha de HTML oculto atravessa tokens de bloco'
  )
  for (const tag of [
    'annotation-xml', 'audio', 'colgroup', 'desc', 'foreignObject', 'head', 'iframe',
    'math', 'mi', 'mn', 'mo', 'ms', 'mtext', 'noembed', 'noframes', 'noscript',
    'plaintext', 'script', 'selectedcontent', 'style', 'svg', 'template', 'title',
    'video', 'xmp'
  ]) {
    assert.doesNotMatch(
      guiMarkdownToPlainText(`<${tag}>HIDDEN-${tag}</${tag}>VISIBLE`),
      /HIDDEN-/u,
      `${tag} segue a politica de conteudo removido do sanitizer`
    )
  }
  const deep = `${'<div>'.repeat(5_000)}fim${'</div>'.repeat(5_000)}`
  assert.equal(guiMarkdownToPlainText(deep), 'fim', 'HTML profundo continua linear e sem recursão')
  assert.equal(
    guiMarkdownToPlainText('```html\n<script>isto é código visível</script>\n```'),
    '<script>isto é código visível</script>'
  )
  assert.doesNotThrow(() => guiMarkdownToPlainText('**aberto [link]('))
  assert.match(guiMarkdownToPlainText('**aberto [link]('), /aberto|link/u)
  assert.equal(guiMarkdownToPlainText(''), '')
})

test('cópia final oferece uma única ação discreta e sempre escreve texto limpo', () => {
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const copy = readFileSync(
    new URL('../src/renderer/src/components/GuiMessageCopy.tsx', import.meta.url),
    'utf8'
  )
  const error = readFileSync(
    new URL('../src/renderer/src/components/GuiErrorLine.tsx', import.meta.url),
    'utf8'
  )
  const markdown = readFileSync(
    new URL('../src/renderer/src/components/GuiMarkdown.tsx', import.meta.url),
    'utf8'
  )
  const streamBranch = pane.indexOf('<GuiStreamText')
  const staticBranch = pane.indexOf('<GuiMessageCopy')
  assert.ok(streamBranch >= 0 && staticBranch > streamBranch)
  assert.match(pane, /<GuiMessageCopy markdown=\{item\.text\} \/>/u)
  assert.doesNotMatch(pane, /innerText/u)
  assert.match(pane, /if \(item\.kind === 'error'\) return <GuiErrorLine/u)
  assert.match(copy, /className=\{`gui-copy-action \$\{feedback\.kind\}`\}/u)
  assert.match(copy, /aria-label=\{buttonLabel\}/u)
  assert.match(copy, /<CopyGlyph \/>/u)
  assert.match(copy, /writeGuiMessageCopy\(writer, markdown, 'text'\)/u)
  assert.doesNotMatch(copy, /copiar markdown|copy\('markdown'\)|GuiMessageCopyFormat/iu)
  assert.match(copy, /disabled=\{copying\}/u)
  assert.match(copy, /role=\{feedback\.kind === 'error' \? 'alert' : 'status'\}/u)
  assert.match(copy, /requestRef\.current !== request/u, 'feedback antigo não pode vencer')
  assert.match(markdown, /ALLOWED_TAGS: GUI_MARKDOWN_TAGS/u)
  assert.match(markdown, /ALLOWED_ATTR: GUI_MARKDOWN_ATTRS/u)
  assert.doesNotMatch(markdown, /'class'|'style'|'hidden'/u)
  assert.match(error, /<details className="gui-error-line" role="alert">/u)
  assert.doesNotMatch(error, /<details[^>]+open/u)
})

test('links do chat têm hover, foco e tentativa de abertura sem tomar a navegação', () => {
  const markdown = readFileSync(
    new URL('../src/renderer/src/components/GuiMarkdown.tsx', import.meta.url),
    'utf8'
  )
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')

  assert.match(markdown, /return url\.protocol === 'https:' \? url\.href : null/u)
  assert.match(markdown, /link\.target = '_blank'/u)
  assert.match(markdown, /link\.rel = 'noopener noreferrer'/u)
  assert.match(markdown, /onClickCapture=\{handleLinkOpenAttempt\}/u)
  assert.match(markdown, /setOpeningLinkLabel\('Abrindo link externo…'\)/u)
  assert.match(markdown, /window\.setTimeout\(/u)
  assert.match(markdown, /window\.clearTimeout\(/u)
  assert.match(markdown, /clearOpeningLink\(false\)/u)
  assert.match(markdown, /const openingLinkRef = useRef<HTMLAnchorElement \| null>\(null\)/u)
  assert.match(markdown, /const openingTimerRef = useRef<number \| null>\(null\)/u)
  assert.match(markdown, /clearOpeningLink\(false\)[\s\S]*openingLinkRef\.current = link/u)
  assert.doesNotMatch(markdown, /window\.open\(/u)
  assert.doesNotMatch(markdown, /preventDefault\(/u)

  assert.match(css, /\.gui-md a:hover/u)
  assert.match(css, /\.gui-md a:focus-visible/u)
  assert.match(css, /\.gui-md a\.gui-link-opening/u)
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.gui-md a \{\s*transition: none;/u
  )
})

test('cópia só aparece na fala assistente que fecha o turno', () => {
  const assistant = {
    id: 'assistant-final',
    kind: 'assistant',
    text: 'Resposta final',
    at: 2,
    live: false,
    animateFrom: 14
  }
  const base = {
    assistantId: assistant.id,
    stream: '',
    thinking: false,
    awaitingInteraction: false
  }

  assert.equal(
    isGuiFinalAssistantMessage({
      ...base,
      items: [{ id: 'user-1', kind: 'user', text: 'Pergunta', at: 1 }, assistant],
      status: 'idle'
    }),
    true,
    'a última fala revelada depois de um resultado recebe a ação'
  )
  assert.equal(
    isGuiFinalAssistantMessage({
      ...base,
      items: [assistant, { ...assistant, id: 'assistant-continuation', at: 3 }],
      status: 'working'
    }),
    false,
    'uma fala intermediária antes da continuação não abre uma faixa de cópia'
  )
  assert.equal(
    isGuiFinalAssistantMessage({
      ...base,
      items: [
        assistant,
        { id: 'tool-1', kind: 'tool', name: 'Read', summary: 'src/a.ts', at: 3 }
      ],
      status: 'working'
    }),
    false,
    'uma fala antes de ferramenta não recebe a ação terminal'
  )
  assert.equal(
    isGuiFinalAssistantMessage({
      ...base,
      items: [{ ...assistant, live: true, animateFrom: 0 }],
      status: 'working',
      stream: 'Resposta em fluxo'
    }),
    false,
    'stream ainda aberto não oferece cópia'
  )
})

test('interrupção sem confirmação e troca durante turno falham fechadas', () => {
  const codex = readFileSync(
    new URL('../src/main/codexSession.ts', import.meta.url),
    'utf8'
  )
  const claude = readFileSync(
    new URL('../src/main/maestroSession.ts', import.meta.url),
    'utf8'
  )
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const toolCard = readFileSync(
    new URL('../src/renderer/src/components/GuiToolCard.tsx', import.meta.url),
    'utf8'
  )
  assert.match(codex, /INTERRUPT_CONFIRM_TIMEOUT/u)
  assert.match(codex, /this\.failInterrupt\(interruptedTurnId/u)
  assert.match(codex, /this\.emit\(\{ type: 'fatal', text: message \}\)/u)
  assert.match(codex, /RPC_TIMEOUT/u)
  assert.match(codex, /private pendingTurnStart: PendingTurnStart \| null/u)
  assert.match(codex, /this\.interruptedStartGeneration = generation/u)
  assert.match(codex, /this\.clearTurnStartGuard\(pending\.generation\)/u)
  assert.match(codex, /queueMicrotask\(\(\) =>/u)
  assert.match(codex, /this\.pendingSendOperations\.size > 0/u)
  assert.match(codex, /if \(resp\.error \|\| !thread\?\.id\)[\s\S]*this\.kill\(\)/u)
  assert.match(claude, /INTERRUPT_CONFIRM_TIMEOUT/u)
  assert.match(claude, /if \(this\.activeTurnGeneration === null\) return false/u)
  assert.match(
    claude,
    /this\.interruptGeneration === generation[\s\S]*this\.interruptRequestId !== null[\s\S]*this\.interruptTimer !== null[\s\S]*return true/u
  )
  assert.match(claude, /resp\.request_id === this\.interruptRequestId/u)
  assert.match(claude, /this\.failInterrupt\(generation, 'o Claude não confirmou a interrupção'\)/u)
  assert.match(claude, /this\.emit\(\{ type: 'fatal', text: message \}\)/u)
  assert.match(claude, /this\.interruptGeneration === generation[\s\S]*this\.clearInterruptGuard\(\)/u)
  assert.match(
    pane,
    /const spawnChangeLocked =\s*dead \|\| turnOpen \|\| attaching \|\| Boolean\(busyMenu\) \|\| Boolean\(gui\.queued\)/u
  )
  assert.ok((pane.match(/disabled=\{spawnChangeLocked\}/gu) ?? []).length >= 3)
  assert.match(toolCard, /guiToolGroupOutcomeView/u)
  assert.match(toolCard, /gui-tool-group-out/u)

  const ipc = readFileSync(new URL('../src/main/ipc/gui.ts', import.meta.url), 'utf8')
  assert.match(ipc, /typeof approve !== 'boolean'/u)
  assert.doesNotMatch(ipc, /answerPlan\(paneId, requestId, Boolean\(approve\)\)/u)
})

test('troca de seat reabre pelo efeito canônico, sem closure do pane morto', () => {
  const board = readFileSync(
    new URL('../src/renderer/src/components/Board.tsx', import.meta.url),
    'utf8'
  )
  const start = board.indexOf('async function chooseChatSeat')
  const end = board.indexOf('/** Fecha UMA conversa', start)
  assert.ok(start >= 0 && end > start, 'função de troca não encontrada')
  const body = board.slice(start, end)
  assert.doesNotMatch(body, /openMissionGuiRole\s*\(/u)
  assert.match(body, /withoutMissionGuiSlots\(prev, missionId\)/u)
  assert.match(body, /efeito canônico de slots vazios/u)
  assert.match(board, /seatError=\{missionGuiError\[mid\]\}/u, 'erro precisa aparecer no chat vivo')

  const missionIpc = readFileSync(
    new URL('../src/main/ipc/missions.ts', import.meta.url),
    'utf8'
  )
  assert.match(missionIpc, /rememberedExecutor = remembered\?\.cli === seat\.cli/u)
  assert.match(missionIpc, /guiSessions\.forgetSession\(paneId\)/u)
  assert.match(missionIpc, /resetExecutor/u)
  assert.match(board, /missionGuiEpoch\.current\.invalidate\(missionId\)/u)
  assert.match(board, /useRef<Map<string, number>>/u, 'trava em voo precisa conhecer a geração')
})

test('texto final conserva o item vivo até o revelador terminar', () => {
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  const stream = readFileSync(
    new URL('../src/renderer/src/components/GuiStreamText.tsx', import.meta.url),
    'utf8'
  )
  assert.match(store, /activeAssistantId/u)
  assert.match(store, /function finalizeGuiStream/u)
  assert.match(store, /animateFrom: Math\.min\(item\.animateFrom, evt\.text\.length\)/u)
  assert.match(stream, /nextGuiWordEnd\(textRef\.current, current\)/u)
  assert.match(stream, /setInterval/u)
  assert.match(stream, /\}, \[\]\)/u, 'o relógio não pode reiniciar a cada delta')
  assert.doesNotMatch(stream, /speed\s*=\s*Math\.max/u)
})

test('Esc global atravessa host e WebContentsView por relay autenticado', () => {
  const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
  const panesApp = readFileSync(new URL('../src/renderer/src/PanesApp.tsx', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  const main = readFileSync(new URL('../src/main/panesView.ts', import.meta.url), 'utf8')
  assert.match(app, /panesView\.guiEscape\(\)/u)
  assert.match(app, /preferRelay/u, 'a view visível vence o pane escondido do host')
  assert.match(panesApp, /onGuiEscape/u)
  assert.match(preload, /ipcRenderer\.send\('panes-view:gui-escape'\)/u)
  assert.match(main, /guardHost\(e, 'panes-view:gui-escape'\)/u)
  assert.match(main, /lastLayout\?\.visible/u)
})

test('atividade e comando anunciam estado sem narrar o cronômetro', () => {
  const activity = readFileSync(
    new URL('../src/renderer/src/components/GuiActivityBar.tsx', import.meta.url),
    'utf8'
  )
  const toolCard = readFileSync(
    new URL('../src/renderer/src/components/GuiToolCard.tsx', import.meta.url),
    'utf8'
  )
  assert.match(activity, /role="status" aria-live="polite"/u)
  assert.match(activity, /aria-keyshortcuts="Escape"/u)
  const liveStart = activity.indexOf('<span className="gui-live"')
  const liveEnd = activity.indexOf('</span>', liveStart)
  assert.ok(liveStart >= 0 && liveEnd > liveStart)
  assert.doesNotMatch(activity.slice(liveStart, liveEnd), /formatGuiElapsed/u)
  assert.match(toolCard, /gui-command-status running" role="status"/u)
  assert.match(toolCard, /gui-command-status \$\{outcome\?\.tone/u)
})

test('composer usa trilho plano do app, anexos e contexto no rodapé', () => {
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const slashMenu = readFileSync(
    new URL('../src/renderer/src/components/GuiSlashMenu.tsx', import.meta.url),
    'utf8'
  )
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')
  const board = readFileSync(
    new URL('../src/renderer/src/components/Board.tsx', import.meta.url),
    'utf8'
  )
  const guiApi = readFileSync(new URL('../src/renderer/src/guiApi.ts', import.meta.url), 'utf8')
  const guiIpc = readFileSync(new URL('../src/main/ipc/gui.ts', import.meta.url), 'utf8')
  const attachmentChips = readFileSync(
    new URL('../src/renderer/src/components/GuiAttachmentChips.tsx', import.meta.url),
    'utf8'
  )
  const attachmentLightbox = readFileSync(
    new URL('../src/renderer/src/components/GuiAttachmentLightbox.tsx', import.meta.url),
    'utf8'
  )
  const attachmentMedia = readFileSync(
    new URL('../src/main/guiAttachmentMedia.ts', import.meta.url),
    'utf8'
  )
  const surfaceRule = css.match(/\.gui-composer-surface\s*\{[^}]*\}/su)?.[0] ?? ''
  const focusRule = css.match(/\.gui-composer-surface:focus-within\s*\{[^}]*\}/su)?.[0] ?? ''
  const slashRule = css.match(/\.gui-slash-menu\s*\{[^}]*\}/su)?.[0] ?? ''
  const menuRule = css.match(/\.gui-mode-menu\s*\{[^}]*\}/su)?.[0] ?? ''

  assert.match(
    pane,
    /<div\s+className="gui-composer-surface"[\s\S]*?ref=\{composerSurfaceRef\}/u
  )
  assert.match(
    css,
    /\.gui-composer-surface\s*\{[^}]*border: 1px solid var\(--gui-line-strong\)[^}]*border-radius: 7px[^}]*background: var\(--card\)/su,
    'a base usa o traço neutro padrão do app'
  )
  assert.match(
    css,
    /\.gui-composer-surface:focus-within\s*\{[^}]*border-color: color-mix\(in srgb, var\(--accent\) 54%, var\(--gui-line-strong\)\)/su,
    'o foco mostra um accent discreto somente no composer inteiro'
  )
  assert.doesNotMatch(surfaceRule, /box-shadow/u)
  assert.doesNotMatch(focusRule, /box-shadow/u)
  assert.match(
    css,
    /\.gui-composer-surface \.gui-input:focus\s*\{[^}]*border: 0[^}]*outline: none[^}]*box-shadow: none/su,
    'o textarea nunca ganha uma segunda borda interna'
  )
  assert.match(
    css,
    /textarea\.synvoice-target:not\(\.gui-input\)/u,
    'o destaque de voz não pode atingir o textarea do composer'
  )
  assert.match(
    css,
    /\.gui-input\.synvoice-target\s*\{[^}]*border: 0[^}]*outline: none[^}]*box-shadow: none/su,
    'o destino do SynVoice mantém o input neutro em base, foco e blur'
  )
  assert.doesNotMatch(surfaceRule, /overflow\s*:/u, 'menus absolutos não podem ser recortados')
  assert.match(css, /\.gui-mode-menu\s*\{[^}]*bottom: calc\(100% \+ 8px\)/su)
  assert.match(
    css,
    /\.gui-composer-inner\s*\{[^}]*display: grid[^}]*"input input input input input input input"[^}]*"attach mode spacer context model effort send"/su
  )
  assert.match(
    css,
    /\.gui-composer-inner:has\(\.gui-composer-attachments\)\s*\{[^}]*"attachments attachments attachments attachments attachments attachments attachments"/su
  )
  assert.match(pane, /className="gui-input"[\s\S]*rows=\{1\}/u)
  assert.ok(
    pane.indexOf('className="gui-input"') < pane.indexOf('gui-composer-attach') &&
      pane.indexOf('gui-composer-attach') < pane.indexOf('gui-composer-mode'),
    'DOM e Tab seguem a mesma ordem visual: escrever antes dos controles'
  )
  assert.match(css, /\.gui-input\s*\{[^}]*grid-area: input[^}]*min-height: 46px/su)
  assert.match(
    css,
    /\.gui-composer-surface \.gui-input:focus\s*\{[^}]*border: 0[^}]*outline: none[^}]*box-shadow: none/su,
    'o foco do textarea não pode pintar um segundo retângulo dentro do composer'
  )
  assert.doesNotMatch(pane, /GuiActivityBar/u, 'o cronômetro não ocupa mais o rodapé do composer')
  assert.doesNotMatch(css, /grid-area:\s*activity/u)
  assert.match(css, /\.gui-input\s*\{[^}]*background: transparent[^}]*border: 0/su)
  assert.match(css, /\.gui-send\s*\{[^}]*border-radius: 50%/su)
  assert.match(pane, /aria-label="Adicionar anexo"/u)
  assert.match(pane, /type="file"[\s\S]*multiple/u)
  assert.match(pane, /guiApi\.attach\(paneId, \{[\s\S]*kind: 'file'/u)
  assert.doesNotMatch(
    pane,
    /Imagem copiada|attachClipboardImage|kind: 'clipboard-image'/u,
    'o menu de anexos não oferece mais uma ação redundante para imagem copiada'
  )
  assert.match(pane, /guiApi\.attachFolder\(paneId\)/u)
  assert.match(pane, /<b>Pasta<\/b>/u)
  assert.doesNotMatch(pane, /Pasta do projeto/u)
  assert.match(pane, /onPaste=\{/u)
  assert.match(pane, /onDrop=\{/u)
  assert.match(pane, /<GuiAttachmentChips[\s\S]*onRemove=/u)
  assert.match(attachmentChips, /aria-label="Anexos"/u)
  assert.match(attachmentChips, /aria-label=\{`Remover anexo \$\{attachment\.name\}`\}/u)
  assert.match(attachmentChips, /guiApi\.attachmentPreview\(paneId, attachment, 'thumbnail'\)/u)
  assert.match(attachmentChips, /new IntersectionObserver/u)
  assert.match(attachmentChips, /rootMargin: '160px'/u)
  assert.match(attachmentChips, /data:image\/png;base64,/u)
  assert.match(attachmentChips, /<img src=\{thumbnail\}/u)
  assert.doesNotMatch(attachmentChips, /file:\/\/|attachment\.path/u)
  assert.match(attachmentChips, /guiApi\.attachmentAction\(paneId, action, attachment\)/u)
  assert.match(attachmentChips, /\bAbrir\b/u)
  assert.match(attachmentChips, /\bBaixar\b/u)
  assert.match(attachmentLightbox, /role="dialog"/u)
  assert.match(attachmentLightbox, /aria-modal="true"/u)
  assert.match(attachmentLightbox, /event\.key === 'Escape'/u)
  assert.match(attachmentLightbox, /previousFocus\.focus\(\{ preventScroll: true \}\)/u)
  assert.match(attachmentLightbox, /event\.key !== 'Tab'/u)
  assert.match(css, /\.gui-attachment-chip\s*\{[^}]*min-width: 0[^}]*max-width:/su)
  assert.match(css, /\.gui-attachment-remove:focus-visible\s*\{/u)
  const finishAttachmentBlock = pane.slice(
    pane.indexOf('const finishAttachments'),
    pane.indexOf('const attachFiles')
  )
  assert.match(finishAttachmentBlock, /setAttachments/u)
  assert.doesNotMatch(finishAttachmentBlock, /send\(/u, 'selecionar anexo nunca envia sozinho')
  assert.match(guiApi, /attach: \(paneId: string, payload: GuiAttachPayload\)/u)
  assert.match(guiApi, /api\.attach\(paneId, payload\)/u)
  assert.match(guiApi, /async attachFolder\(paneId: string\)/u)
  assert.match(guiApi, /error: 'não consegui abrir o seletor de pasta'/u)
  assert.match(guiApi, /error: 'não consegui preparar a prévia'/u)
  assert.match(guiApi, /error: 'não consegui concluir a ação do anexo'/u)
  assert.match(guiIpc, /ipcMain\.handle\('gui:attachFolder'/u)
  assert.match(guiIpc, /'gui:attachmentPreview'/u)
  assert.match(guiIpc, /'gui:attachmentAction'/u)
  assert.match(guiIpc, /validateGuiAttachmentReferences/u)
  assert.match(guiIpc, /renderGuiAttachmentPreview\(attachment\.bytes, attachment\.mime, purpose\)/u)
  assert.match(attachmentMedia, /nativeImage\.createFromBuffer\(Buffer\.from\(source\)\)/u)
  assert.match(attachmentMedia, /\.toPNG\(\)/u)
  assert.match(attachmentMedia, /thumbnail: 512 \* 1024/u)
  assert.doesNotMatch(attachmentMedia, /readFileSync|pathToFileURL/u)
  assert.doesNotMatch(guiIpc, /detail: \{[^}]*path/u)
  assert.match(guiIpc, /dialog\.showOpenDialog/u)
  assert.match(guiIpc, /resolveGuiExternalFolderReference/u)
  assert.match(guiIpc, /detail: \{ kind: payload\.kind, ok: result\.ok \}/u)
  assert.match(pane, /guiContextUsagePresentation\(gui\.contextTokens, gui\.contextWindow\)/u)
  assert.match(pane, /className="gui-composer-context"/u)
  assert.match(css, /\.gui-composer-context\s*\{[^}]*color: var\(--ink-2\)/su)
  assert.match(css, /\.gui-input::placeholder\s*\{[^}]*color: var\(--ink-2\)/su)
  assert.doesNotMatch(board, /stageCtxPct|key="ctx"/u)
  for (const rule of [slashRule, menuRule]) {
    assert.match(rule, /overflow-y: auto/u)
    assert.match(rule, /scrollbar-width: none/u)
    assert.doesNotMatch(rule, /overflow:\s*hidden/u)
    assert.doesNotMatch(rule, /box-shadow/u)
  }
  assert.match(css, /\.gui-slash-menu::-webkit-scrollbar\s*\{\s*display: none/su)
  assert.match(css, /\.gui-mode-menu::-webkit-scrollbar\s*\{\s*display: none/su)
  assert.match(css, /@container pane \(max-width: 350px\)/u)
  assert.match(
    pane,
    /className="gui-mode-btn mode-model"[\s\S]*?aria-label=\{`Modelo desta conversa:/u
  )
  assert.match(
    pane,
    /className="gui-mode-btn mode-effort"[\s\S]*?aria-label=\{`Esforço de raciocínio desta conversa:/u
  )
  assert.match(pane, /guiModelLabel\(modelOptions, selectedModel/u)
  assert.match(pane, /guiModelForSelection\(modelOptions, selectedModel\)/u)
  assert.match(board, /guiModelLabel\(directGui\?\.caps\?\.models \?\? \[\], stageModel/u)
  assert.match(pane, /<b>\{optionLabel\}<\/b>/u)
  assert.doesNotMatch(pane, /option\.description && <span>/u)
  assert.match(pane, /label: 'acesso completo'/u)
  assert.match(pane, /a qualquer arquivo no seu computador/u)
  assert.doesNotMatch(pane, /label: 'bypass'/u)
  assert.match(
    css,
    /\.gui-composer-model \.gui-mode-menu,[\s\S]*?\.gui-composer-effort \.gui-mode-menu\s*\{[^}]*right: 0;[^}]*left: auto;/u
  )
  assert.match(
    css,
    /@container pane \(max-width: 430px\)[\s\S]*?\.gui-mode-menu\s*\{[^}]*width: min\(240px, calc\(100cqw - 40px\)\);[^}]*min-width: 0;/u
  )
  assert.match(pane, /activityRunning \? ' stop' : ''/u)
  assert.match(pane, /aria-label=\{\s*activityRunning\s*\? 'Parar resposta'/u)
  assert.match(pane, /aria-keyshortcuts=\{activityRunning \? 'Escape' : undefined\}/u)
  assert.match(pane, /onClick=\{activityRunning \? \(\) => void interruptGuiPane\(paneId\) : submit\}/u)
  assert.match(pane, /activityRunning \? <StopGlyph \/> : <SendGlyph \/>/u)
  assert.match(css, /\.gui-send-stop-icon\s*\{[^}]*width: 8px[^}]*height: 8px/su)
  assert.match(css, /\.gui-send\.stop\s*\{[^}]*background: color-mix\(in srgb, var\(--accent\) 7%, var\(--card\)\)/su)
  assert.match(css, /\.gui-send\.stop:hover:not\(:disabled\)\s*\{[^}]*border-color: var\(--accent\)/su)
  assert.match(css, /\.gui-send\.stop:focus-visible\s*\{[^}]*outline: 2px solid/su)
  assert.match(pane, /role="combobox"/u)
  assert.match(pane, /aria-controls=\{slashOpen \? slashMenuId : undefined\}/u)
  assert.match(pane, /`\$\{slashMenuId\}-option-\$\{slashIndex\}`/u)
  assert.match(slashMenu, /<div id=\{id\} className="gui-slash-menu" role="listbox"/u)
  assert.match(slashMenu, /id=\{`\$\{id\}-option-\$\{i\}`\}/u)
  assert.match(slashMenu, /tabIndex=\{-1\}/u)
  assert.ok(
    (pane.match(/disabled=\{seatChanging \|\| busyMenu !== null \|\| attaching \|\| turnOpen\}/gu) ?? [])
      .length >= 2,
    'seat não pode substituir o pane durante troca de executor/anexo/turno'
  )
  assert.match(
    pane,
    /disabled=\{dead \|\| opening \|\| attaching \|\| submitPending \|\| busyMenu !== null\}/u
  )
})

test('composer libera o foco ao clicar no papel externo e o conserva dentro', () => {
  const textarea = { nodeType: 1 }
  const control = { nodeType: 1 }
  const external = { nodeType: 1 }
  const surface = {
    contains(node) {
      return node === textarea || node === control
    }
  }

  assert.equal(
    shouldBlurGuiComposerOnOutsidePointerDown(surface, textarea, external),
    true,
    'um clique em área externa não focável desfaz o foco que o navegador manteria'
  )
  assert.equal(
    shouldBlurGuiComposerOnOutsidePointerDown(surface, textarea, control),
    false,
    'o textarea continua focado enquanto o gesto fica no composer'
  )
  assert.equal(
    shouldBlurGuiComposerOnOutsidePointerDown(surface, control, textarea),
    false,
    'um controle interno mantém foco acessível para teclado e mouse'
  )
  assert.equal(
    shouldBlurGuiComposerOnOutsidePointerDown(surface, external, textarea),
    false,
    'foco fora do composer nunca é tocado'
  )
})

test('modelo e effort usam troca viva, confirmada e sem status no transcript', () => {
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const main = readFileSync(new URL('../src/main/guiSessions.ts', import.meta.url), 'utf8')
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  const board = readFileSync(
    new URL('../src/renderer/src/components/Board.tsx', import.meta.url),
    'utf8'
  )
  assert.match(pane, /const applyExecutorChange = useCallback/u)
  assert.match(pane, /guiApi\.configureExecutor\(paneId, patch\)/u)
  assert.match(pane, /if \(!res\.ok\)[\s\S]*setLiveModel\(nextModel\)/u)
  const executorBlock = pane.slice(
    pane.indexOf('const applyExecutorChange'),
    pane.indexOf('const changeMode')
  )
  assert.doesNotMatch(executorBlock, /guiApi\.create/u)
  assert.doesNotMatch(executorBlock, /command-output/u)
  assert.match(main, /entry\.sink\(\{[\s\S]*?type: 'executor-changed'/u)
  assert.match(store, /case 'executor-changed':[\s\S]*?executorModel: evt\.model/u)
  assert.match(store, /case 'session-restarted':[\s\S]*?executorKnown: false/u)
  assert.match(board, /directGui\?\.executorKnown[\s\S]*?directGui\.executorModel/u)
  assert.match(
    pane,
    /const canSubmit =[\s\S]*canSend && busyMenu === null && !attaching && !submitPending/u
  )
  assert.match(pane, /return sendGuiMessage\(paneId, message, undefined, attachments\)/u)
  assert.match(
    pane,
    /guiComposerClearPlan\([\s\S]*?if \(clear\.draft\) clearDraft\(\)[\s\S]*?if \(clear\.attachments\) clearAttachments\(\)/u
  )
  assert.match(
    pane,
    /disabled=\{\s*activityRunning\s*\?\s*false\s*:\s*\(!draft\.trim\(\) && attachments\.length === 0\) \|\| !canSubmit\s*\}/u
  )
})

test('avisos do chat têm som apenas no host, visibilidade real e ajustes acessíveis', () => {
  const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
  const panesApp = readFileSync(new URL('../src/renderer/src/PanesApp.tsx', import.meta.url), 'utf8')
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const settings = readFileSync(
    new URL('../src/renderer/src/components/ChatNoticeSettings.tsx', import.meta.url),
    'utf8'
  )
  const main = readFileSync(new URL('../src/main/ipc/gui.ts', import.meta.url), 'utf8')
  const board = readFileSync(
    new URL('../src/renderer/src/components/Board.tsx', import.meta.url),
    'utf8'
  )
  const panes = readFileSync(
    new URL('../src/renderer/src/components/PanesView.tsx', import.meta.url),
    'utf8'
  )

  assert.match(app, /guiApi\.onAlert/u)
  assert.match(app, /chatSoundsEnabled === false/u)
  assert.doesNotMatch(panesApp, /from ['"]\.\/notify['"]/u)
  assert.match(pane, /guiApi\.visibility\(paneId, active\)/u)
  assert.match(pane, /guiApi\.visibility\(paneId, false\)/u)
  assert.match(board, /appPage === 'workspace'[\s\S]*uniTab === 'board'[\s\S]*mid === missionTab/u)
  assert.match(panes, /active=\{visible && isActive && panesViewShown\}/u)
  assert.match(main, /ctx\.pushBoard\('gui:alert'/u)
  assert.match(main, /readyTitle\.noteFinished\(paneId\)/u)
  assert.match(pane, /guiApi\.presented\(paneId, seq\)/u)
  assert.match(pane, /!active \|\| !documentVisible \|\| transcriptPresented/u)
  assert.match(settings, /role="switch"/u)
  assert.match(settings, /aria-checked=\{checked\}/u)
  for (const label of ['Precisa de você', 'Turno concluído', 'Turno falhou', 'Sons de atenção']) {
    assert.match(settings, new RegExp(label, 'u'))
  }
})

test('subagentes usam somente linhagem explícita e preservam o transcript cru', () => {
  const parentA = {
    ...tool('parent-a', 'Agent', 'investigue o fluxo A'),
    toolUseId: 'parent-a'
  }
  const parentB = {
    ...tool('parent-b', 'Agent', 'investigue o fluxo B'),
    toolUseId: 'parent-b'
  }
  const childA1 = {
    ...tool('child-a-1', 'Grep', 'padrão A1'),
    toolUseId: 'child-a-1',
    parentToolUseId: 'parent-a'
  }
  const childB = {
    ...tool('child-b', 'Read', 'arquivo B'),
    toolUseId: 'child-b',
    parentToolUseId: 'parent-b'
  }
  const childA2 = {
    ...tool('child-a-2', 'Grep', 'padrão A2'),
    toolUseId: 'child-a-2',
    parentToolUseId: 'parent-a'
  }
  const codexNamedAgent = {
    ...tool('codex-generic', 'Agent', 'nome não é metadado'),
    toolUseId: 'codex-generic'
  }
  const orphan = {
    ...tool('orphan', 'Read', 'pai fora da janela'),
    toolUseId: 'orphan',
    parentToolUseId: 'evicted-parent'
  }
  const raw = [parentA, parentB, childA1, childB, childA2, codexNamedAgent, orphan]
  const identities = [...raw]
  const presented = nestGuiSubagentTools(raw)

  assert.deepEqual(raw, identities, 'a projeção não reordena nem remove a verdade crua')
  assert.equal(raw.length, 7)
  assert.deepEqual(presented.map((item) => item.id), [
    'subagent:parent-a',
    'subagent:parent-b',
    'codex-generic',
    'orphan'
  ])
  const boxA = presented[0]
  const boxB = presented[1]
  assert.equal(boxA.kind, 'subagent')
  assert.equal(boxB.kind, 'subagent')
  assert.deepEqual(boxA.children.map((item) => item.id), ['child-a-1', 'child-a-2'])
  assert.deepEqual(boxB.children.map((item) => item.id), ['child-b'])
  assert.equal(groupConsecutiveGuiTools(boxA.children)[0].kind, 'tool-group', 'P8 continua dentro da caixa')
  assert.equal(presented[2].kind, 'tool', 'nome Agent sem parentToolUseId continua genérico')
  assert.equal(presented[3].kind, 'tool', 'filho cujo pai saiu do replay degrada sem sumir')

  const orphanBranch = nestGuiSubagentTools([
    orphan,
    {
      ...tool('orphan-grandchild', 'Grep', 'também não aninhar'),
      toolUseId: 'orphan-grandchild',
      parentToolUseId: 'orphan'
    }
  ])
  assert.deepEqual(
    orphanBranch.map((item) => item.kind),
    ['tool', 'tool'],
    'uma raiz órfã não captura descendentes numa caixa aparentemente válida'
  )
  assert.equal(
    asGuiEvent({
      type: 'tool',
      name: 'Read',
      input: {},
      toolUseId: 'child',
      parentToolUseId: 42
    }),
    null,
    'payload vivo com linhagem torta não chega ao store'
  )
})

test('resultados intercalados fecham o filho exato e a caixa conta desfechos terminais', () => {
  const items = [
    { ...tool('parent-a', 'Agent', 'prompt A'), toolUseId: 'parent-a' },
    { ...tool('parent-b', 'Agent', 'prompt B'), toolUseId: 'parent-b' },
    {
      ...tool('child-a', 'Grep', 'alpha'),
      toolUseId: 'child-a',
      parentToolUseId: 'parent-a'
    },
    {
      ...tool('child-b', 'Read', 'beta'),
      toolUseId: 'child-b',
      parentToolUseId: 'parent-b'
    }
  ]
  const settle = (toolUseId, text, isError = false) => {
    const index = guiToolResultTargetIndex(items, toolUseId)
    assert.notEqual(index, -1)
    items[index] = {
      ...items[index],
      result: {
        text,
        isError,
        status: isError ? 'failed' : 'completed',
        lineCount: 1,
        truncated: false
      }
    }
  }

  // B termina antes de A; o resultado não pode fechar o último card por posição.
  settle('child-b', 'resultado B')
  settle('child-a', 'resultado A')
  settle('parent-b', 'falhou B', true)
  settle('parent-a', 'feito A')

  const [boxA, boxB] = nestGuiSubagentTools(items)
  assert.equal(boxA.kind, 'subagent')
  assert.equal(boxB.kind, 'subagent')
  assert.equal(boxA.children[0].result.text, 'resultado A')
  assert.equal(boxB.children[0].result.text, 'resultado B')
  assert.equal(
    guiSubagentStatusView(boxA.parent, boxA.children, {
      tone: 'ok',
      statusLabel: 'concluído'
    }).label,
    'concluído (1 ferramenta)'
  )
  const failed = guiSubagentStatusView(boxB.parent, boxB.children, {
    tone: 'err',
    statusLabel: 'falhou'
  })
  assert.equal(failed.label, 'falhou (1 ferramenta)')
  assert.equal(failed.tone, 'err')

  const duplicate = [
    { ...tool('dup-1'), toolUseId: 'duplicado' },
    {
      ...tool('dup-2'),
      toolUseId: 'duplicado',
      result: {
        text: 'já fechado',
        isError: false,
        status: 'completed',
        lineCount: 1,
        truncated: false
      }
    }
  ]
  assert.equal(guiToolResultTargetIndex(duplicate, 'duplicado'), -1, 'id ambíguo falha fechado')
})

test('atividade de subagente mostra só a ferramenta ainda realmente pendente', () => {
  const parent = { ...tool('parent', 'Agent', 'verifique o contrato'), toolUseId: 'parent' }
  const pending = {
    ...tool('pending', 'Grep', 'parent_tool_use_id'),
    toolUseId: 'pending',
    parentToolUseId: 'parent'
  }
  const completed = {
    ...tool('completed', 'Read', 'arquivo já lido'),
    toolUseId: 'completed',
    parentToolUseId: 'parent',
    result: {
      text: 'ok',
      isError: false,
      status: 'completed',
      lineCount: 1,
      truncated: false
    }
  }
  const view = guiSubagentStatusView(parent, [pending, completed], null)
  assert.equal(view.currentActivity, 'Grep / parent_tool_use_id')
  assert.equal(view.label, 'agora: Grep / parent_tool_use_id')
})

test('terminal de erro encerra pai e filhos sem deixar a caixa pulsando', () => {
  const parent = { ...tool('parent', 'Agent', 'prompt terminal'), toolUseId: 'parent' }
  const child = {
    ...tool('child', 'Read', 'arquivo'),
    toolUseId: 'child',
    parentToolUseId: 'parent'
  }
  const closed = closePendingGuiTools([parent, child], {
    type: 'fatal',
    text: 'transporte encerrado'
  })
  const [box] = nestGuiSubagentTools(closed)
  assert.equal(box.kind, 'subagent')
  assert.equal(box.parent.result.status, 'failed')
  assert.equal(box.children[0].result.status, 'failed')
  const view = guiSubagentStatusView(
    box.parent,
    box.children,
    guiToolOutcomeView(box.parent.result)
  )
  assert.equal(view.label, 'falhou (1 ferramenta)')
  assert.equal(view.currentActivity, null)
  assert.equal(view.tone, 'err')
})
