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
import {
  GUI_DROP_QUIET_MS,
  GuiDropTracker,
  dragTransferHasFiles,
  guiDropZoneLabel
} from '../src/renderer/src/guiDropZone.ts'
import { shouldBlurGuiComposerOnOutsidePointerDown } from '../src/renderer/src/guiComposerFocus.ts'
import {
  closePendingGuiTools,
  guiClosedLine,
  guiSubagentChildClosure,
  hasPendingGuiTools,
  settleLaunchedGuiSubagents
} from '../src/renderer/src/guiTerminalTools.ts'
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
  guiToolStartActivity,
  isGuiShellTool,
  lastPendingGuiToolActivity
} from '../src/renderer/src/guiToolPresentation.ts'
import { nestGuiSubagentTools } from '../src/renderer/src/guiSubagentPresentation.ts'
import { normalizeGuiSubagentSidebar } from '../src/renderer/src/guiSubagentSidebar.ts'
import {
  guiHistoryPageRequest,
  guiPrunedEvicted,
  guiPrunedNoticeText,
  mergeGuiHistoryPage
} from '../src/renderer/src/guiHistoryReader.ts'
import { guiBackgroundWorkPresentation } from '../src/renderer/src/guiBackgroundWorkPresentation.ts'
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
  canComposeGuiMessage,
  canSendGuiMessage,
  guiBackendReadyStatus,
  guiCommandCompletionStatus,
  guiDeadComposerPlaceholder,
  guiSessionRestartState,
  guiTransportFailureStatus,
  isGuiTurnActive,
  isSameGuiTurn,
  needsGuiReviveBeforeSend,
  shouldApplyGuiBufferedEvent,
  shouldCreateGuiSession,
  settleGuiActionFailure,
  settleGuiRespawnStream,
  settleGuiSendBatch
} from '../src/renderer/src/guiTransport.ts'
import {
  enqueueGuiInteraction,
  guiInteractionBlocksTurn,
  guiInteractionSurvivesTurnEnd,
  removeGuiInteraction,
  retainGuiInteractionsAfterTurnEnd,
  settleGuiInteractionFailure
} from '../src/renderer/src/guiInteractionQueue.ts'
import {
  guiAsksForGo,
  guiAwaitingGoDecision,
  guiFinalQuestion
} from '../src/renderer/src/guiAskForGo.ts'
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

// REGRESSÃO 2026-08-15 — "saí do app e voltei, e minha mensagem duplicou".
// O id do item é a chave do React na lista do fio e o messageId do gui:send.
// Cunhado por contador de PROCESSO, ele voltava a zero em todo boot do renderer
// enquanto o transcript persistido continuava guardando os ids da geração
// anterior: a hidratação re-cunhava as MESMAS chaves para itens de assistente/
// ferramenta e a bolha do dono era desenhada duas vezes. Cada import com query
// distinta é uma instância nova do módulo — dois boots do renderer.
test('id de item do chat não se repete entre boots do renderer', async () => {
  const boot1 = await import('../src/renderer/src/guiItemIdentity.ts?boot=1')
  const boot2 = await import('../src/renderer/src/guiItemIdentity.ts?boot=2')

  const fromBoot1 = [boot1.guiItemId(), boot1.guiItemId(), boot1.guiItemId()]
  const fromBoot2 = [boot2.guiItemId(), boot2.guiItemId(), boot2.guiItemId()]

  assert.equal(new Set(fromBoot1).size, 3, 'dentro do mesmo boot os ids são únicos')
  assert.equal(
    new Set([...fromBoot1, ...fromBoot2]).size,
    6,
    'boot novo NUNCA pode re-cunhar um id que a fotografia persistida ainda guarda'
  )
  assert.notEqual(
    boot1.createGuiBootToken(),
    boot2.createGuiBootToken(),
    'cada geração do renderer tem marca própria (vale também para as duas views)'
  )

  // O mesmo id atravessa o IPC como messageId: fora da régua do main, o envio
  // seria recusado e o `user-message` sumiria do disco na hidratação.
  for (const id of [...fromBoot1, ...fromBoot2]) {
    assert.ok(boot1.isGuiItemId(id), `id fora da régua de messageId: ${id}`)
    assert.ok(id.length <= 128)
  }

  // Ids do formato legado (contador puro) continuam no disco do dono: nenhuma
  // geração nova pode colidir com eles.
  const legado = ['g1', 'g17', 'g132', 'g276']
  for (const id of [...fromBoot1, ...fromBoot2]) {
    assert.equal(legado.includes(id), false, `id novo colidiu com o legado: ${id}`)
  }
})

test('id vindo de fora da geração só é aceito quando está livre no fio', async () => {
  const { claimGuiItemId, guiItemId, isGuiItemId } = await import(
    '../src/renderer/src/guiItemIdentity.ts?claim=1'
  )
  const hidratado = [
    { id: 'g132', kind: 'user', text: 'De novo.', at: 1 },
    { id: 'g133', kind: 'assistant', text: 'Pronto', at: 1 }
  ]

  assert.equal(
    claimGuiItemId('g900', hidratado),
    'g900',
    'bilhete da fila com id livre mantém a identidade durável da entrega'
  )

  // O bilhete da fila sobrevive ao restart no localStorage e pode ter sido
  // gravado pelo formato antigo: repetido, viraria chave duplicada aqui e id já
  // entregue no main, que responderia ok e engoliria a mensagem.
  const substituto = claimGuiItemId('g132', hidratado)
  assert.notEqual(substituto, 'g132')
  assert.ok(isGuiItemId(substituto))
  assert.equal(
    hidratado.some((item) => item.id === substituto),
    false,
    'o id de substituição precisa estar livre no fio'
  )

  for (const torto of [undefined, '', 'id com espaço', 'a'.repeat(129), 42]) {
    const minted = claimGuiItemId(torto, hidratado)
    assert.ok(isGuiItemId(minted), `id inválido precisa cair num id novo: ${String(torto)}`)
  }
  assert.ok(isGuiItemId(guiItemId()))
})

test('chat reconhece arquivos sem capturar HTTPS, versao ou email', () => {
  const text =
    'Veja src/main/app.ts, foo.ts, README, preview.xhtml e clip.mp4. Versão 2.0; me@example.com; https://example.com/docs/site.ts.'
  assert.deepEqual(
    findGuiFileTokens(text).map((token) => token.value),
    ['src/main/app.ts', 'foo.ts', 'README', 'preview.xhtml', 'clip.mp4']
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
  assert.match(markdown, /linkifyGuiFileReferences\(routeChatLinksExternally\(sanitized, fileLinks\.references\)\)/u)
  assert.match(markdown, /parent\.closest\('a, button, pre'\)/u)
  assert.ok(markdown.includes('guiApi.fileOpen(paneId, reference, selectedPath, mode)'))
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
  // O espelho é SÓ o scroll do box clipado — transladar a caixa era o bug do
  // paste de 2026-08-20 (overlay pintado por cima do fio).
  const overlay = { scrollTop: 0, scrollLeft: 0, style: { transform: '' } }
  syncInputOverlayScroll({ scrollTop: 18, scrollLeft: 4 }, overlay)
  assert.deepEqual(overlay, {
    scrollTop: 18,
    scrollLeft: 4,
    style: { transform: '' }
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
  assert.equal(guiAttachmentSizeProblem('documento.txt', 10 * 1024 * 1024 + 1), null)
  assert.equal(guiAttachmentSizeProblem('documento.txt', 50 * 1024 * 1024), null)
  assert.match(guiAttachmentSizeProblem('video.mov', 50 * 1024 * 1024 + 1) ?? '', /50 MB/u)
  const largeBatch = planGuiAttachmentBatch([{ name: 'documento.txt', size: 50 * 1024 * 1024 }])
  assert.equal(largeBatch.accepted.length, 1)
  assert.deepEqual(largeBatch.errors, [])
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

test('a zona de soltar acende pelo relógio do arrasto e apaga no silêncio', () => {
  assert.equal(dragTransferHasFiles(['Files']), true)
  assert.equal(dragTransferHasFiles(['text/plain', 'text/uri-list']), false)
  assert.equal(dragTransferHasFiles(undefined), false)

  const timers = new Map()
  let nextHandle = 1
  const phases = []
  const tracker = new GuiDropTracker({
    setTimer: (callback, delayMs) => {
      const handle = nextHandle++
      timers.set(handle, {
        delayMs,
        fire: () => {
          timers.delete(handle)
          callback()
        }
      })
      return handle
    },
    clearTimer: (handle) => timers.delete(handle),
    onChange: (phase) => phases.push(phase)
  })
  assert.equal(tracker.current, 'idle')
  tracker.hover(false)
  assert.equal(tracker.current, 'ready', 'arrasto em qualquer canto da janela = guia')
  tracker.hover(true)
  tracker.hover(true)
  assert.equal(tracker.current, 'over', 'por cima do pane = solte')
  assert.deepEqual(phases, ['ready', 'over'], 'fase repetida não re-renderiza')
  assert.equal(timers.size, 1, 'cada dragover renova UM prazo, nunca acumula')
  const [pending] = timers.values()
  assert.equal(pending.delayMs, GUI_DROP_QUIET_MS)
  assert.ok(GUI_DROP_QUIET_MS > 550, 'o prazo cobre o dragover parado da spec (350 ± 200 ms)')
  // Chromium sem dragleave (arrasto saiu da janela, Esc): o silêncio apaga.
  pending.fire()
  assert.equal(tracker.current, 'idle')
  tracker.hover(true)
  tracker.settle()
  assert.equal(tracker.current, 'idle')
  assert.equal(timers.size, 0, 'soltar desarma o prazo pendente')
  tracker.settle()
  assert.deepEqual(phases, ['ready', 'over', 'idle', 'over', 'idle'])
  assert.match(guiDropZoneLabel('over'), /solte/u)
  assert.match(guiDropZoneLabel('ready'), /traga/u)
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

// PEDIDO DO DONO 2026-09-22 — "o SYNKORA COMMENTARY meio que fica duplicado".
// O main entrega a fala da commentary como mensagem do agente; o card cru da
// tool repetia o mesmo texto logo acima dela.
test('a commentary não vira card nem quebra a sequência de ferramentas', () => {
  const spoken = (id) => ({
    id,
    kind: 'assistant',
    text: 'achei o bug',
    at: 1,
    live: false,
    animateFrom: 0
  })
  for (const name of ['mcp__synkora__commentary', 'commentary']) {
    const thread = [tool('fala-tool', name, '{"message":"achei o bug"}'), spoken('fala')]
    assert.deepEqual(groupConsecutiveGuiTools(thread).map((item) => item.id), ['fala'], name)
  }

  // A recusada some igual: o agente reenvia ou escreve a fala como texto.
  const refused = groupConsecutiveGuiTools([
    tool('a'),
    {
      ...tool('c', 'mcp__synkora__commentary'),
      result: { text: 'recusada', isError: true, lineCount: 1, truncated: false }
    },
    tool('b')
  ])
  assert.equal(refused.length, 1)
  assert.equal(refused[0].kind, 'tool-group')
  assert.deepEqual(refused[0].items.map((item) => item.id), ['a', 'b'])

  const otherSynkoraTool = groupConsecutiveGuiTools([tool('h', 'mcp__synkora__helper_send')])
  assert.deepEqual(otherSynkoraTool.map((item) => item.kind), ['tool'])
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

test('o briefing não abre turno sozinho: nenhuma auto-partida sobrou no motor', () => {
  const sessions = readFileSync(new URL('../src/main/guiSessions.ts', import.meta.url), 'utf8')
  // O PANE NASCE MUDO (ordem do dono): a única partida de turno é a mensagem
  // do dono. Qualquer volta de um `sendFirstPrompt` — ou de um `session.send`
  // pendurado no waitCaps do create — devolveria o chat que fala primeiro.
  assert.ok(!/sendFirstPrompt/u.test(sessions), 'a auto-partida do 1º prompt não existe mais')
  assert.ok(
    !/waitCaps\([\s\S]{0,400}?entry\.session\.send\(/u.test(sessions),
    'nenhum envio pendurado no handshake'
  )
  // READY_TIMEOUT_MS continua vivo — a entrega da fila ainda espera o handshake.
  assert.match(sessions, /const READY_TIMEOUT_MS = 45_000/u)
  assert.match(sessions, /waitCaps\(READY_TIMEOUT_MS\)/u)

  // A costura do briefing pendente: semeado no create (com herança explícita
  // para o respawn), consumido UMA vez colado à mensagem do dono.
  assert.match(sessions, /pendingBriefing\?: string/u)
  assert.match(
    sessions,
    /pendingBriefing: current\?\.pendingBriefing \?\? \(spawn\.firstPrompt\?\.trim\(\) \|\| undefined\)/u
  )
  assert.match(sessions, /entry\.pendingBriefing = undefined/u)
  assert.match(sessions, /guiBriefedPrompt\(/u)
})

test('o chat pronto convida a escrever e diz que o briefing vai junto', () => {
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')

  // O vazio deixou de ser suprimido pela injeção: o pane que nasce mudo tem de
  // dizer o que fazer, senão lê como chat quebrado com um `<details>` em cima.
  assert.match(pane, /const empty =\s*gui\.items\.length === 0 && !gui\.queued && !gui\.stream && !gui\.perm && !awaitingCard/u)
  assert.match(pane, /const briefingPending =/u)
  assert.match(pane, /ambiente pronto — escreva para começar/u)
  assert.match(pane, /o briefing desta missão vai junto com a sua primeira mensagem/u)
  assert.match(pane, /gui-empty-sub/u)
  // O rótulo do `<details>` conta a verdade nos dois tempos.
  assert.match(pane, /vai com a sua primeira mensagem/u)
  assert.match(pane, /enviado com a sua 1ª mensagem/u)
  assert.ok(!/injetada como 1º prompt/u.test(pane), 'a legenda antiga mentia sobre o envio')
  assert.match(css, /\.gui-empty-sub\s*\{/u)
})

// ————— A CERCA DO SPAWN (o campo `mcp` sumiu entre Board e GuiPane) —————
//
// O renderer mantém um ESPELHO À MÃO do `GuiPaneSpawn` do main e o Board
// enumera as props do `<GuiPane>` uma a uma. Campo novo no main atravessa o
// IPC intacto e MORRE nessas duas listas — sem erro de tipo, porque omitir um
// campo opcional num literal novo é legal em TypeScript. Foi assim que o chat
// de planejamento rodou uma noite inteira sem as ferramentas de plano.
//
// Esta cerca lê as três listas do FONTE e exige paridade. Ela não sabe nada
// sobre `mcp`: qualquer campo que o main acrescentar ao spawn amanhã cai aqui.

/** Campos de PRIMEIRO nível de uma `interface X { … }`, sem comentários e sem
 *  as chaves de tipos aninhados (`mcp?: { args: string[] }` é UM campo). */
function interfaceFields(source, name) {
  const body = balancedBody(source, `interface ${name} {`, `interface ${name}`)
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/[^\n]*/gu, '')
  const fields = []
  let depth = 0
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (depth === 0) {
      const match = /^([A-Za-z_$][\w$]*)\??\s*:/u.exec(line)
      if (match) fields.push(match[1])
    }
    for (const ch of line) {
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
  }
  return fields
}

/** Corpo entre a primeira `{` depois da âncora e a `}` que a fecha. */
function balancedBody(source, anchor, label) {
  const at = source.indexOf(anchor)
  assert.notEqual(at, -1, `${label} encontrada no fonte`)
  const open = source.indexOf('{', at)
  assert.notEqual(open, -1, `${label} abre um bloco`)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  assert.fail(`${label} tem bloco sem fechamento`)
  return ''
}

/** O campo aparece como CHAVE do literal (`x:` ou o atalho `x,`). */
function literalHasKey(literal, field) {
  return new RegExp(`(^|[\\s,{])${field}\\s*[:,]`, 'u').test(`${literal},`)
}

test('todo campo do spawn atravessa main → espelho → Board → GuiPane', () => {
  const main = readFileSync(new URL('../src/main/guiSessions.ts', import.meta.url), 'utf8')
  const mirror = readFileSync(new URL('../src/renderer/src/guiApi.ts', import.meta.url), 'utf8')
  const board = readFileSync(
    new URL('../src/renderer/src/components/Board.tsx', import.meta.url),
    'utf8'
  )
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )

  const fields = interfaceFields(main, 'GuiPaneSpawn')
  // Piso de sanidade: se o parser deixar de achar os campos, a cerca não pode
  // passar em silêncio dizendo que zero campos estão todos presentes.
  assert.ok(fields.length >= 12, `o parser leu ${fields.length} campos do spawn`)
  assert.ok(fields.includes('paneId') && fields.includes('cwd'))

  // 1. o espelho do renderer declara TUDO o que o main declara
  assert.deepEqual(
    fields.filter((field) => !interfaceFields(mirror, 'GuiPaneSpawn').includes(field)),
    [],
    'campo do spawn ausente no espelho do renderer (src/renderer/src/guiApi.ts)'
  )

  // 2. o GuiPane ACEITA cada campo como prop
  const props = interfaceFields(pane, 'Props')
  assert.deepEqual(
    fields.filter((field) => !props.includes(field)),
    [],
    'campo do spawn que o GuiPane não recebe como prop'
  )

  // 3. os DOIS literais do spawn no GuiPane carregam cada campo — semente do
  //    useRef e reatribuição por render: um só deles bastaria para a remontagem
  //    reconstruir um spawn pobre.
  for (const [anchor, label] of [
    ['const spawnRef = useRef<GuiPaneSpawn>(', 'a semente do spawnRef'],
    ['spawnRef.current = ', 'a reatribuição do spawnRef']
  ]) {
    const literal = balancedBody(pane, anchor, label)
    assert.deepEqual(
      fields.filter((field) => !literalHasKey(literal, field)),
      [],
      `campo do spawn que ${label} deixa cair`
    )
  }

  // 4. o Board entrega cada campo ao pane da missão. As outras duas montagens
  //    do GuiPane ficam de fora DE PROPÓSITO: o pane livre (PanesView) nunca é
  //    missão de planejamento e já omite seatId/permissionMode, e a fotografia
  //    congelada (ArchivedMissionChat) não pode abrir sessão nenhuma.
  //    `<GuiPane\n` e não `<GuiPane`: o prefixo casaria com o irmão
  //    `<GuiPanelErrorBoundary` que envolve cada montagem.
  const opens = /<GuiPane[\s\n]/u.exec(board)
  assert.ok(opens, 'o Board monta o <GuiPane>')
  const jsx = board.slice(opens.index, board.indexOf('/>', opens.index))
  assert.ok(jsx.includes('paneId='), 'o bloco JSX do GuiPane foi recortado')
  assert.ok(!jsx.includes('<GuiPanelErrorBoundary'), 'o recorte é do <GuiPane>, não do irmão')
  const passed = new Set([...jsx.matchAll(/(?:^|\s)([a-zA-Z][\w]*)=\{/gu)].map((m) => m[1]))
  assert.deepEqual(
    fields.filter((field) => !passed.has(field)),
    [],
    'campo do spawn que o Board não passa ao <GuiPane>'
  )
})

test('planejador armado que chega sem ferramenta deixa recibo no diário', () => {
  const ipc = readFileSync(new URL('../src/main/ipc/gui.ts', import.meta.url), 'utf8')
  // A cerca de paridade é estática; esta é a rede em runtime. O main sabe que
  // armou o planejador (guardou o token); spawn sem `mcp` para um pane armado
  // é falha de costura, e falha de costura nunca é silenciosa nesta casa.
  assert.match(ipc, /if \(!spawn\.mcp && ctx\.paneTokens\.has\(spawn\.paneId\)\)/u)
  assert.match(ipc, /event: 'gui-planner-mcp-dropped'/u)
})

test('a aprovação do plano fala com o agente por announce, nunca por send', () => {
  const ipc = readFileSync(new URL('../src/main/ipc/gui.ts', import.meta.url), 'utf8')
  // `send` escreve uma bolha "VOCÊ" no fio. O recibo do clique é do APP, e a
  // decisão do dono já aparece como nota — duas cópias, uma delas fingindo ser
  // fala dele, era o que o dono via em 2026-08-17.
  assert.match(ipc, /registry\.announce\(\s*paneId,\s*planApprovedReceipt\(/u)
  assert.doesNotMatch(
    ipc,
    /registry\.send\(\s*paneId,\s*`\[synkora\]/u,
    'recibo de plano voltou a nascer como mensagem do dono'
  )
})

test('quem revoga as ferramentas no teardown tem par que as re-materializa no spawn', () => {
  const ipc = readFileSync(new URL('../src/main/ipc/gui.ts', import.meta.url), 'utf8')
  // O teardown do pane apaga o arquivo de config e revoga o token — inclusive
  // quando o "teardown" é só a primeira metade de um RESPAWN (trocar o modo de
  // permissão, `/clear`, entrega da fila com modo novo). Sem o par abaixo, o
  // processo seguinte nascia com `--mcp-config <arquivo apagado>` e o claude
  // saía com exit 1 (caso real de 2026-08-17, duas ocorrências no journal).
  // Os dois ganchos vivem no MESMO literal de deps de propósito: quem mexer em
  // um vê o outro.
  assert.match(ipc, /onPaneDisposed: \(\{ paneId \}\) => \{/u)
  assert.match(ipc, /ctx\.cleanPaneMcpFile\(paneId\)/u)
  // 2026-08-18: o gancho passou a ROTEAR (chat de planejamento → kit de planos;
  // chat de missão dev → MCP de delegação dos ajudantes sem aba). O par
  // teardown↔re-arme continua sendo o que esta cerca protege; só o nome do
  // roteador mudou, e ele segue sendo fonte única em guiPlannerArm.
  assert.match(
    ipc,
    /rearmPaneTools: \(spawn\) => rearmGuiPaneTools\(ctx, spawn\)/u,
    'o teardown ficou sem o par que rearma o pane no spawn seguinte'
  )
  const arm = readFileSync(new URL('../src/main/guiPlannerArm.ts', import.meta.url), 'utf8')
  assert.match(
    arm,
    /export function rearmGuiPaneTools\(/u,
    'o roteador do re-arme sumiu de guiPlannerArm'
  )
  // A autoridade sobre quem tem ferramenta é do main, e ela é RE-PROVADA a
  // cada spawn: o `spawn.mcp` que chega do renderer é só o eco do que este
  // main entregou, nunca a permissão em si. (2026-08-30: a régua virou
  // `guiPaneToolKind` — os três papéis armam pela mesma trilha e SÓ `none`
  // recusa; a prova de tipo por missão mora na régua, não mais no braço.)
  assert.match(arm, /kind === 'none'/u)
  assert.match(arm, /event: 'gui-planner-arm-refused'/u)
  // E a prova final: o arquivo que o claude vai abrir tem de existir AGORA.
  assert.match(arm, /if \(!file \|\| !existsSync\(file\)\) return refuse\('config-file-missing'\)/u)
})

test('a remontagem para respawn não pinta o medidor com contexto de conversa morta', () => {
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')

  // O replay reconstrói o fio a partir dos eventos PERSISTIDOS — inclusive
  // `result`/`context-usage` de uma conversa que talvez nem seja retomada. Só
  // o main decide isso (`sameConversation` → `session-restarted`), e ele só
  // fala depois de esperar o CLI ficar estável. Até lá o medidor mostrava a
  // porcentagem de outra conversa.
  // Recorte do REDUTOR (a interface declara os mesmos nomes bem antes).
  const from = store.indexOf('replayGuiPane: (paneId, events, prepareForRespawn = false) =>')
  const to = store.indexOf('markGuiSpawned: (paneId) =>')
  assert.ok(from !== -1 && to > from, 'o redutor do replay foi recortado')
  const respawn = store.slice(from, to)
  assert.match(respawn, /status: 'starting',\s*ready: false,/u)
  assert.match(respawn, /contextTokens: null,\s*contextWindow: null/u)
})

test('duas mensagens Claude mantêm gerações FIFO após o primeiro resultado', async t => {
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

  const { buildSync } = await import('esbuild')
  const { createRequire } = await import('node:module')
  const compiled = buildSync({
    stdin: { contents: `
      export { MaestroSession } from './src/main/maestroSession';
      export { GuiClaudeTaskRegistry } from './src/main/guiClaudeTasks';
    `, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false
  }).outputFiles[0].text
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', compiled)(
    createRequire(import.meta.url), loaded, loaded.exports
  )
  const { MaestroSession, GuiClaudeTaskRegistry } = loaded.exports
  const events = []
  // Real parser, synthetic process state: no CLI, account or storage is opened.
  const session = Object.create(MaestroSession.prototype)
  Object.assign(session, {
    opts: {}, claudeTasks: new GuiClaudeTaskRegistry(), pending: new Map(),
    pendingTurnGenerations: pending, activeTurnGeneration: 41, turnGeneration: 42,
    interruptGeneration: null, interruptRequestId: null, interruptTimer: null,
    emit: event => events.push(event), resetIdle() {}
  })
  t.after(() => session.clearInterruptGuard())
  session.claudeTasks.noteStarted('preview', 'preview-tool', { taskType: 'local_bash' })
  session.handleLine(JSON.stringify({ type: 'result', is_error: false }))
  assert.deepEqual(session.pendingTurnGenerations, [42])
  assert.equal(session.activeTurnGeneration, 42)
  assert.equal(events.at(-1).type, 'result')
  assert.equal(events.at(-1).continues, true, 'the second queued request remains active')
  session.handleLine(JSON.stringify({ type: 'result', is_error: false }))
  assert.deepEqual(session.pendingTurnGenerations, [])
  assert.equal(session.activeTurnGeneration, null)
  assert.equal(events.at(-1).continues, false, 'a preview alone does not prolong the final result')
  assert.ok(session.claudeTasks.taskFor('preview'), 'the preview remains tracked after both results')
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

test('commentary pendente não é a ferramenta que o turno está esperando', () => {
  const items = [
    tool('a', 'Read', 'a.ts'),
    tool('c', 'mcp__synkora__commentary', '{"message":"lendo"}')
  ]
  assert.equal(lastPendingGuiToolActivity(items), 'Read · a.ts')
  assert.equal(lastPendingGuiToolActivity([tool('c', 'commentary', '{"message":"lendo"}')]), null)

  // Ao COMEÇAR, a fala herda a atividade que já estava de pé.
  assert.equal(
    guiToolStartActivity('mcp__synkora__commentary', '{"message":"lendo"}', 'Read · a.ts'),
    'Read · a.ts'
  )
  assert.equal(guiToolStartActivity('commentary', '{"message":"lendo"}', null), null)
  assert.equal(guiToolStartActivity('Read', 'b.ts', null), 'Read · b.ts')
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  assert.match(
    store,
    /guiToolStartActivity\(evt\.name, summary, base\.activityText\)/u,
    'o applyGuiEvent decide pelo módulo puro'
  )
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
  assert.equal(orphan[0].result.status, 'unconfirmed')
  assert.equal(orphan[0].result.isError, false)
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
  assert.equal(genuineOrphan[0].result.status, 'unconfirmed')
  assert.equal(genuineOrphan[0].result.isError, false)
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

// R23.2 — PANE MORTO RENASCE NO ENVIO. O composer não tranca mais: o
// placeholder diz a verdade com a receita e ENVIAR é o gesto que reabre a MESMA
// conversa. `canSendGuiMessage` continua sendo "dá para enviar AGORA" (é dela
// que o 🧐 do Board depende); quem manda no composer é a pergunta nova.
test('R23.2 — composer do pane morto continua vivo e diz a receita', () => {
  assert.equal(canSendGuiMessage('dead', true), false, 'o transporte morto segue morto')
  assert.equal(canComposeGuiMessage('dead', true), true, 'mas o dono pode escrever e enviar')
  assert.equal(canComposeGuiMessage('starting', true), false, 'abrindo continua barrado')
  assert.equal(canComposeGuiMessage('idle', false), false)
  assert.equal(canComposeGuiMessage('idle', true), true)
  assert.equal(canComposeGuiMessage('working', true), true)

  assert.equal(needsGuiReviveBeforeSend('dead'), true)
  assert.equal(needsGuiReviveBeforeSend('idle'), false)
  assert.equal(needsGuiReviveBeforeSend('starting'), false)
  assert.equal(needsGuiReviveBeforeSend('working'), false)
  assert.equal(needsGuiReviveBeforeSend('waiting-you'), false)

  assert.equal(
    guiDeadComposerPlaceholder(1),
    'a sessão morreu (código 1) — enviar reabre a MESMA conversa'
  )
  assert.equal(
    guiDeadComposerPlaceholder(null),
    'a sessão morreu — enviar reabre a MESMA conversa',
    'sem código provado a nota não inventa número'
  )
})

// O gesto inteiro: submeter num pane morto dispara o respawn-com-resume que JÁ
// existe (o mesmo `guiApi.create` da troca de modo/⚡ — R11/R12, retomada
// QUIETA) e só então a mensagem sai. Nada de botão novo, e revive que falha NÃO
// engole a mensagem: o `false` devolve o rascunho e o motivo entra no fio.
test('R23.2 — enviar no pane morto reabre a conversa e só então manda a mensagem', () => {
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')

  // O composer não tranca mais no morto, e o placeholder é a verdade com receita.
  assert.doesNotMatch(pane, /disabled=\{dead\}/u, 'o textarea do pane morto não tranca')
  assert.doesNotMatch(pane, /feche o pane e abra outro/u, 'o beco sem saída saiu do placeholder')
  assert.match(pane, /guiDeadComposerPlaceholder\(gui\.exitCode\)/u)
  assert.match(pane, /const canCompose = canComposeGuiMessage\(gui\.status, gui\.ready\)/u)
  assert.match(pane, /const canSubmit =\s*canCompose &&/u)

  // O recorte do envio: revive ANTES, mensagem DEPOIS, falha devolvendo false.
  const from = pane.indexOf('const send = useCallback')
  const to = pane.indexOf('const sendQueuedNow = useCallback', from)
  assert.ok(from !== -1 && to > from, 'o envio do composer foi recortado')
  const send = pane.slice(from, to)
  assert.match(send, /needsGuiReviveBeforeSend\(gui\.status\)/u)
  assert.match(send, /await guiApi\.create\(spawnRef\.current\)/u)
  assert.match(send, /if \(!revived\.ok\)[\s\S]{0,400}?return false/u)
  // Reabrir NUNCA troca de assento por baixo: sem conta, o envio recusa com a
  // receita em vez de cair na conta padrão do CLI.
  assert.match(send, /if \(!spawnRef\.current\.configDir\)[\s\S]{0,400}?return false/u)
  assert.match(send, /escolha uma conta no cabeçalho e envie de novo/u)
  // R33: o envio do renascimento leva `outgoing` (mensagem + citações do fio).
  assert.match(send, /sendGuiMessage\(paneId, outgoing, undefined, attachments, true, referenceSnapshot\)/u)
  assert.match(send, /reabrir a conversa/u, 'a falha do renascimento fala, com receita')

  // O código da morte vira ESTADO: sem ele o placeholder não teria o que dizer.
  assert.match(store, /exitCode: number \| null/u)
  assert.match(store, /exitCode: evt\.code/u)
  // E o envio do renascimento atravessa a guarda de transporte — o main é a
  // autoridade e recusa honesto se a sessão não tiver nascido.
  assert.match(store, /revived \|\| canSendGuiMessage\(before\.status, before\.ready\)/u)
  assert.match(store, /revived \|\| canSendGuiMessage\(prev\.status, prev\.ready\)/u)
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
  // A ESCRITA DO CHAT (2026-09-21): a fala é UM componente do primeiro delta à
  // mensagem parada — `GuiStreamText` carrega o botão de copiar; o único
  // container à parte é o card JSON, que só existe com o texto completo.
  const streamBranch = pane.indexOf('<GuiStreamText')
  assert.ok(streamBranch >= 0)
  assert.match(pane, /const jsonCard = revealing \? null : parseGuiJsonCard\(item\.text\)/u)
  assert.match(pane, /<GuiMessageCopy markdown=\{item\.text\} \/>/u)
  const stream = readFileSync(
    new URL('../src/renderer/src/components/GuiStreamText.tsx', import.meta.url),
    'utf8'
  )
  assert.match(stream, /<GuiMessageCopy markdown=\{text\} \/>/u)
  assert.match(stream, /className=\{`gui-msg dev\$\{revealing \? ' stream' : ''\}`\}/u, 'o container é o mesmo do início ao fim')
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

test('interrupção sem confirmação e troca durante turno falham fechadas', async t => {
  const codex = readFileSync(
    new URL('../src/main/codexSession.ts', import.meta.url),
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
  // R23.1 — a queda por interrupção sai SEMPRE com a receita colada.
  assert.match(codex, /text: withGuiInterruptRecipe\(message\)/u)
  assert.match(codex, /RPC_TIMEOUT/u)
  assert.match(codex, /private pendingTurnStart: PendingTurnStart \| null/u)
  assert.match(codex, /this\.interruptedStartGeneration = generation/u)
  assert.match(codex, /this\.clearTurnStartGuard\(pending\.generation\)/u)
  assert.match(codex, /queueMicrotask\(\(\) =>/u)
  assert.match(codex, /this\.pendingSendOperations\.size > 0/u)
  assert.match(codex, /if \(resp\.error \|\| !thread\?\.id\)[\s\S]*this\.kill\(\)/u)
  const { buildSync } = await import('esbuild')
  const { createRequire } = await import('node:module')
  const compiled = buildSync({
    stdin: { contents: `
      export { MaestroSession } from './src/main/maestroSession';
      export { GuiClaudeTaskRegistry } from './src/main/guiClaudeTasks';
      export { GUI_INTERRUPT_ESCALATION_NOTE } from './src/main/guiInterruptEscalation';
    `, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false
  }).outputFiles[0].text
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', compiled)(
    createRequire(import.meta.url), loaded, loaded.exports
  )
  const { MaestroSession, GuiClaudeTaskRegistry, GUI_INTERRUPT_ESCALATION_NOTE } = loaded.exports
  const fixture = (generation = null) => {
    const writes = [], events = []
    const session = Object.create(MaestroSession.prototype)
    Object.assign(session, {
      killed: false, closed: false, child: { exitCode: null, signalCode: null }, opts: {},
      claudeTasks: new GuiClaudeTaskRegistry(), controlWaiters: new Map(),
      pendingTurnGenerations: generation === null ? [] : [generation],
      activeTurnGeneration: generation, turnGeneration: generation ?? 0,
      interruptGeneration: null, interruptRequestId: null, interruptTimer: null,
      write: frame => writes.push(frame), emit: event => events.push(event), resetIdle() {},
      kill() { this.killed = true }
    })
    t.after(() => session.clearInterruptGuard())
    return { session, writes, events }
  }

  const idle = fixture()
  assert.equal(idle.session.interrupt(), false, 'an idle engine has no interrupt to dispatch')
  idle.session.claudeTasks.noteStarted('preview', 'preview-tool', { taskType: 'local_bash' })
  assert.equal(idle.session.interrupt(), false, 'a preview process does not invent agent work')
  assert.equal(idle.writes.length, 0)
  assert.equal(idle.session.killed, false)
  assert.ok(idle.session.claudeTasks.taskFor('preview'))

  const active = fixture(9)
  assert.equal(active.session.interrupt(), true)
  const request = active.writes.at(-1)
  assert.equal(request.request.subtype, 'interrupt')
  assert.ok(active.session.interruptTimer, 'active work arms the confirmation deadline')
  assert.equal(active.session.interrupt(), true)
  assert.equal(active.writes.length, 1, 'duplicate Stop reuses the pending request')
  active.session.handleLine(JSON.stringify({ type: 'control_response',
    response: { subtype: 'success', request_id: 'unrelated-synthetic-request' } }))
  assert.equal(active.session.interruptRequestId, request.request_id, 'unrelated ACK cannot settle Stop')
  // Exercise the real deadline handler directly, without a wall-clock delay or a real process.
  active.session.failInterrupt(active.session.interruptGeneration, GUI_INTERRUPT_ESCALATION_NOTE)
  assert.equal(active.session.killed, true, 'unconfirmed active work retains failure-closed escalation')
  assert.deepEqual(active.events.at(-1), { type: 'fatal', text: GUI_INTERRUPT_ESCALATION_NOTE })
  assert.equal(active.session.interruptTimer, null)

  const background = fixture()
  background.session.claudeTasks.noteStarted('agent', 'agent-tool', { taskType: 'local_agent' })
  assert.equal(background.session.interrupt(), true, 'a live agent remains interruptible after its parent result')
  assert.equal(background.session.turnActive, false, 'background Stop does not invent a parent turn')
  assert.equal(background.session.backgroundActive, true, 'dispatch alone is not confirmation')
  assert.equal(background.session.interrupt(), true)
  assert.equal(background.writes.length, 1)
  background.session.handleLine(JSON.stringify({ type: 'control_response', response: {
    subtype: 'success', request_id: background.writes[0].request_id
  } }))
  assert.equal(background.session.backgroundActive, false)
  assert.equal(background.session.interruptTimer, null, 'matching ACK needs no nonexistent parent result')
  assert.equal(background.session.killed, false)
  assert.equal(background.session.interrupt(), false)
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
  // 2026-09-21: a cadência é adaptativa (palavras inteiras por tique, decididas
  // em guiStreamReveal.ts) e o relógio só depende da cadência escolhida —
  // nunca de `text`, senão cada rajada rearmaria o tique.
  assert.match(stream, /nextGuiRevealShown\(textRef\.current, current, words\)/u)
  assert.match(stream, /guiRevealWordsThisTick\(textRef\.current, current, completeRef\.current, paceRef\.current, tickMs\)/u)
  assert.match(stream, /setInterval/u)
  assert.match(stream, /\}, \[tickMs\]\)/u, 'o relógio não pode reiniciar a cada delta')
  assert.doesNotMatch(stream, /speed\s*=\s*Math\.max/u)
})

test('Esc global pertence ao chat ativo, resolvido dentro do único renderer', () => {
  const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
  const escape = readFileSync(new URL('../src/renderer/src/guiEscape.ts', import.meta.url), 'utf8')
  // A ilha panes-view morreu na purga F6 (2026-08-17). Não existe mais um
  // segundo renderer para quem repassar a tecla: o registry local é a única
  // autoridade, e nenhum relay pode voltar por engano.
  assert.match(app, /installGlobalGuiEscape\(\)/u)
  assert.doesNotMatch(app, /panesView/u)
  assert.doesNotMatch(escape, /options\.relay|preferRelay|requestActiveGuiEscape/u)
  assert.match(escape, /function hasVisibleEscapeOwner/u, 'modal visível é dono do Esc')
  assert.match(escape, /entry\.lastInterruptAt/u, 'Esc repetido não interrompe duas vezes')
  assert.match(escape, /guiEscapeAction\('Escape', entry\.state\(\)\)/u)
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
    /\.gui-composer-inner\s*\{[^}]*display: grid[^}]*"input input input input input input input input"[^}]*"attach mode spacer context model effort fast send"/su
  )
  assert.match(
    css,
    /\.gui-composer-inner:has\(\.gui-composer-attachments\)\s*\{[^}]*"attachments attachments attachments attachments attachments attachments attachments attachments"/su
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
  // O envio entra na fileira do rodapé como os vizinhos: mesma caixa de 30px e
  // o raio de 6px da família. O disco redondo de 38px era a única forma
  // circular do produto e não volta.
  const sendRule = css.slice(css.indexOf('.gui-send {'), css.indexOf('.gui-send-glyph {'))
  assert.match(sendRule, /width: 30px/u)
  assert.match(sendRule, /height: 30px/u)
  assert.match(sendRule, /border-radius: 6px/u)
  assert.doesNotMatch(css, /\.gui-send\s*\{[^}]*border-radius: 50%/su)
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
  // 2026-09-04 — o item SOLTO sobe como File ao preload (o caminho nasce lá,
  // via webUtils); a pasta arrastada deixou de morrer no FileReader, e a placa
  // de soltar mora no composer enquanto o pane inteiro aceita o drop.
  const preloadSource = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  assert.match(pane, /guiApi\.attachDropped\(paneId, file\)/u)
  assert.match(pane, /useGuiDropZone\(paneRef, canAcceptDrop\)/u)
  assert.match(pane, /className="gui-drop-pad"/u)
  assert.match(pane, /className="gui-pane"[\s\S]{0,900}onDrop=\{/u, 'o drop cai na raiz do pane')
  assert.doesNotMatch(
    pane,
    /className="gui-composer-surface"[\s\S]{0,200}onDrop=/u,
    'o composer não é mais o único alvo'
  )
  assert.match(guiApi, /async attachDropped\(paneId: string, file: File\)/u)
  assert.match(
    preloadSource,
    /attachDropped: \(paneId: string, file: File\)[\s\S]{0,700}webUtils\.getPathForFile\(file\)[\s\S]{0,700}'gui:attachDropped'/u
  )
  assert.match(guiIpc, /ipcMain\.handle\(\s*'gui:attachDropped'/u)
  assert.match(guiIpc, /resolveGuiDroppedTarget/u)
  assert.match(css, /\.gui-drop-pad-frame rect\s*\{[^}]*animation: gui-drop-march/su)
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.gui-drop-pad,\s*\.gui-drop-pad-frame rect\s*\{\s*animation: none/su
  )
  assert.match(css, /\.gui-drop-pad\s*\{[^}]*pointer-events: none/su)
  assert.match(pane, /<GuiAttachmentChips[\s\S]*onRemove=/u)
  assert.match(attachmentChips, /aria-label="Anexos"/u)
  assert.match(attachmentChips, /aria-label=\{`Remover anexo \$\{attachment\.name\}`\}/u)
  assert.match(attachmentChips, /guiApi\.attachmentPreview\(paneId, attachment, 'thumbnail'\)/u)
  assert.match(attachmentChips, /new IntersectionObserver/u)
  assert.match(attachmentChips, /rootMargin: '160px'/u)
  assert.match(readFileSync(new URL('../src/renderer/src/guiAttachmentPreview.ts', import.meta.url), 'utf8'), /data:image\/png;base64,/u)
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
  assert.match(pane, /useGuiComposerFit\(composerSurfaceRef, composerVisible\)/u)
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
  // 2026-09-08: a cabeça do palco não repete o modelo — quem o mostra e troca
  // é o composer; a linha fina com modelo/effort morreu.
  assert.doesNotMatch(board, /stageModelLabel|gui-head-model/u)
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
  assert.match(pane, /stopInsteadOfSend \? ' stop' : ''/u)
  assert.match(pane, /aria-label=\{\s*stopInsteadOfSend\s*\? 'Interromper resposta'/u)
  assert.match(pane, /aria-keyshortcuts=\{stopInsteadOfSend \? 'Escape' : undefined\}/u)
  assert.ok(/onClick=\{stopInsteadOfSend \? \(\) => void interruptGuiPane\(paneId\) : \(\) => submit\(\)\}/u.test(pane),
    'botão principal interrompe a resposta atual ou envia com o modo padrão')
  assert.match(pane, /stopInsteadOfSend \? <StopGlyph \/> : <SendGlyph \/>/u)
  // Glifos desenhados à mão na mesma grade de 16: nada de emoji, nada de
  // biblioteca de ícones, e a MESMA caixa nos dois estados — trocar enviar por
  // interromper no meio do turno não pode empurrar o rodapé.
  const sendGlyph = pane.slice(
    pane.indexOf('function SendGlyph'),
    pane.indexOf('function StopGlyph')
  )
  const stopGlyph = pane.slice(
    pane.indexOf('function StopGlyph'),
    pane.indexOf('function readGuiFileBase64')
  )
  for (const glyph of [sendGlyph, stopGlyph]) {
    assert.match(glyph, /<svg[\s\S]*className="gui-send-glyph"/u)
    assert.match(glyph, /viewBox="0 0 16 16"[\s\S]*width="16"[\s\S]*height="16"/u)
    assert.match(glyph, /aria-hidden="true"/u)
  }
  assert.match(sendGlyph, /<path d="M3 8h9" \/>/u)
  assert.match(stopGlyph, /<rect x="4" y="4" width="8" height="8" rx="1\.5" \/>/u)
  assert.doesNotMatch(css, /\.gui-send-stop-icon/u)
  assert.doesNotMatch(css, /\.gui-send\.stop\s*\{[^}]*(?:width|height):/su)
  // Jogo completo de estados no enviar: repouso, hover, pressionado, foco de
  // teclado e desabilitado com o composer vazio.
  assert.match(css, /\.gui-send:hover:not\(:disabled\)\s*\{[^}]*background: var\(--accent-deep\)/su)
  assert.match(css, /\.gui-send:active:not\(:disabled\)\s*\{[^}]*transform: translateY\(1px\)/su)
  assert.match(css, /\.gui-send:focus-visible\s*\{[^}]*outline: 2px solid/su)
  assert.match(css, /\.gui-send:disabled\s*\{[^}]*color: var\(--ink-3\)/su)
  assert.match(
    css,
    /\.gui-send:not\(\.stop\):hover:not\(:disabled\) \.gui-send-glyph\s*\{[^}]*transform: translateX\(1px\)/su,
    'a seta anda um fio ao enviar; o quadrado do interromper nunca anda'
  )
  // Interromper fala pela família do ERRO, em voz baixa: contorno tingido.
  assert.match(css, /\.gui-send\.stop\s*\{[^}]*background: color-mix\(in srgb, var\(--err\) 8%, var\(--card\)\)/su)
  assert.match(css, /\.gui-send\.stop\s*\{[^}]*color: var\(--err\)/su)
  assert.match(css, /\.gui-send\.stop:hover:not\(:disabled\)\s*\{[^}]*border-color: var\(--err\)/su)
  assert.match(css, /\.gui-send\.stop:active:not\(:disabled\)\s*\{[^}]*transform: translateY\(1px\)/su)
  assert.match(css, /\.gui-send\.stop:focus-visible\s*\{[^}]*outline: 2px solid/su)
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]{0,120}?\.gui-send-glyph\s*\{[^}]*transition: none/su,
    'quem pede menos movimento não recebe nudge nem press'
  )
  assert.match(pane, /role="combobox"/u)
  assert.match(pane, /aria-controls=\{slashOpen \? slashMenuId : undefined\}/u)
  assert.match(pane, /`\$\{slashMenuId\}-option-\$\{slashIndex\}`/u)
  assert.match(slashMenu, /<div id=\{id\} className="gui-slash-menu" role="listbox"/u)
  assert.match(slashMenu, /id=\{`\$\{id\}-option-\$\{i\}`\}/u)
  assert.match(slashMenu, /tabIndex=\{-1\}/u)
  // R21.2 — o TURNO SAIU daqui (ver o teste dedicado abaixo): trocar de conta
  // no meio do turno é a fuga do rate limit. Guarda de voo e anexo ficam — e
  // desde 2026-09-08 atravessam o store: o chip de conta mora na cabeça do
  // palco (Board) e não enxerga o composer, então o GuiPane publica o
  // "ocupado" e o Board o entrega ao chip como `locked`.
  const seatChip = readFileSync(
    new URL('../src/renderer/src/components/StageSeatChip.tsx', import.meta.url),
    'utf8'
  )
  assert.match(
    pane,
    /setGuiComposerBusy\(paneId, busyMenu !== null \|\| attaching\)/u,
    'o GuiPane precisa publicar a troca de executor/anexo em voo'
  )
  assert.match(board, /locked=\{directGui\?\.composerBusy \?\? false\}/u)
  assert.ok(
    (seatChip.match(/disabled=\{changing \|\| locked\}/gu) ?? []).length >= 2,
    'seat não pode substituir o pane durante troca de executor/anexo'
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
  // A fatia é SÓ a troca viva (applyExecutorChange): o carimbo do "abrindo"
  // (deferExecutorChange, 2026-08-30) mora logo abaixo e FALA de propósito —
  // ele adia uma ação, e adiar em silêncio seria o clique sumindo.
  const executorBlock = pane.slice(
    pane.indexOf('const applyExecutorChange'),
    pane.indexOf('const deferExecutorChange')
  )
  assert.doesNotMatch(executorBlock, /guiApi\.create/u)
  assert.doesNotMatch(executorBlock, /command-output/u)
  assert.match(main, /entry\.sink\(\{[\s\S]*?type: 'executor-changed'/u)
  assert.match(store, /case 'executor-changed':[\s\S]*?executorModel: evt\.model/u)
  // Restart de geração NOVA continua zerando a escolha de executor; o
  // retomado (R12) preserva — o `executor-changed` de trás segue mandando.
  assert.match(
    store,
    /case 'session-restarted':[\s\S]*?executorKnown: quiet \? state\.executorKnown : false/u
  )
  // O modelo que o card da coluna mostra é o que o CLI CONFIRMOU (executor
  // conhecido), nunca só o pedido. (Era a linha fina do palco até 2026-09-08.)
  assert.match(board, /guiState\?\.executorKnown[\s\S]*?guiState\.executorModel/u)
  // R23.2 — o portão do composer é `canCompose` (o morto escreve e envia); as
  // outras cercas de voo continuam exatamente as mesmas.
  assert.match(
    pane,
    /const canSubmit =[\s\S]*canCompose && busyMenu === null && !attaching && !submitPending/u
  )
  // R33: o caminho direto envia `outgoing` (mensagem + citações) e limpa os
  // chips no sucesso.
  assert.match(pane, /await sendGuiMessage\(paneId, outgoing, undefined, attachments, false, referenceSnapshot\)/u)
  assert.match(
    pane,
    /guiComposerClearPlan\([\s\S]*?if \(clear\.draft\) clearDraft\(\)[\s\S]*?if \(clear\.attachments\) clearAttachments\(\)/u
  )
  assert.match(
    pane,
    /disabled=\{\s*stopInsteadOfSend\s*\?\s*false\s*:\s*\(!draft\.trim\(\) && attachments\.length === 0 && browserReferences\.length === 0\) \|\| !canSubmit\s*\}/u
  )
})

test('todo terminal aberto é pílula do seletor do palco, com missão ou sem', () => {
  const board = readFileSync(
    new URL('../src/renderer/src/components/Board.tsx', import.meta.url),
    'utf8'
  )
  const head = readFileSync(
    new URL('../src/renderer/src/components/MissionStageHead.tsx', import.meta.url),
    'utf8'
  )
  // ONDA D — CHAT ↔ TERMINAL. As abas de terminal nasceram dentro da barra
  // ESCURA do PaneChrome, que é chrome da era legada e vai sair. Esta é a
  // rede que impede a feature de cair de carona com ele: os dois conjuntos
  // (terminal de missão e terminal avulso do ✦ geral) precisam existir como
  // pílula do MESMO seletor, cada uma com seleção e fechamento.
  assert.match(board, /for \(const pane of missionTermPanes\.filter/u)
  assert.match(board, /for \(const pane of generalTermPanes\) \{/u)
  assert.match(
    board,
    /generalTermPanes\)[\s\S]{0,600}?kind: 'terminal'[\s\S]{0,400}?onSelect: \(\) => setGeneralTerm\(pane\.id\)/u,
    'o terminal avulso precisa de pílula própria com seleção'
  )
  assert.match(
    board,
    /generalTermPanes\)[\s\S]{0,900}?onClose: \(\) => window\.synkora\.panes\.requestClose\(projectId, pane\.id\)/u,
    'fechar a pílula derruba o processo do terminal'
  )
  // A cabeça do palco é ÚNICA e em papel: o chrome escuro do PaneChrome saiu
  // com o TUI legado. O ✦ geral com um terminal vivo continua tendo seletor
  // porque as pílulas dele existem. Desde 2026-09-08 a cabeça é UMA fileira
  // (pílulas · estado do turno · conta · botões): a linha fina morreu.
  assert.match(
    board,
    /<MissionStageHead pills=\{stagePills\} status=\{stageStatus\} seat=\{stageSeatChip\}/u
  )
  assert.doesNotMatch(board, /stageMetaParts|stage-meta/u)
  assert.match(board, /leadingAction=\{panelsEnabled \? <WorkspaceSidebarToggle/u, 'o controle da coluna pertence à missão')
  assert.match(board, /actions=\{panelsEnabled \? <WorkspaceToolbar/u, 'o menu de painéis não aparece no Geral')
  assert.match(board, /maestro-window stage-window/u)
  assert.doesNotMatch(board, /term-window/u)
  // As abas do ✦ geral já saíram da barra escura; as de MISSÃO ainda vivem lá
  // porque a missão LEGADA (sem palco 2.0) é a única que ainda as usa — elas
  // caem junto com o chrome dela, e a asserção de ausência entra ali.
  assert.doesNotMatch(board, /generalTermPanes\.map\(\(pane\) => \(/u)
  // O componente da cabeça precisa saber desenhar terminal e fechar pílula.
  assert.match(head, /kind: 'chat' \| 'terminal'/u)
  assert.match(head, /pill\.kind === 'terminal' && <span className="stage-pill-glyph">/u)
  assert.match(head, /stage-pill-close/u)
})

test('avisos do chat têm som apenas no host, visibilidade real e ajustes acessíveis', () => {
  const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
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

  assert.match(app, /guiApi\.onAlert/u)
  assert.match(app, /chatSoundsEnabled === false/u)
  assert.match(pane, /guiApi\.visibility\(paneId, active\)/u)
  assert.match(pane, /guiApi\.visibility\(paneId, false\)/u)
  assert.match(board, /appPage === 'workspace'[\s\S]*uniTab === 'board'[\s\S]*mid === missionTab/u)
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

test('com o Synkora aberto: Ajustes › Avisos escolhe fora da tela, sempre ou nunca', () => {
  const settings = readFileSync(
    new URL('../src/renderer/src/components/ChatNoticeSettings.tsx', import.meta.url),
    'utf8'
  )
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')

  assert.match(settings, /settings\?\.desktopNotifyWhileFocused \?\? 'off-screen'/u)
  assert.match(settings, /patchSettings\(\{ desktopNotifyWhileFocused: choice\.value \}\)/u)
  assert.match(settings, /className="pref-choice"[\s\S]*role="group"/u)
  assert.match(settings, /aria-pressed=\{choice\.value === focusMode\}/u)
  for (const label of ['fora da tela', 'sempre', 'nunca']) {
    assert.match(settings, new RegExp(`label: '${label}'`, 'u'))
  }
  // A escolha segmentada é peça compartilhada (Acessibilidade e Avisos).
  assert.match(css, /\.pref-choice > button\[aria-pressed='true'\]/u)
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

test('resultados intercalados fecham o filho exato e um id ambíguo falha fechado', () => {
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
  assert.equal(boxA.parent.result.text, 'feito A')
  assert.equal(boxB.parent.result.isError, true)

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
  assert.equal(box.children[0].result.status, 'failed', 'o filho segue a árvore do pai')
  assert.equal(guiToolOutcomeView(box.parent.result).tone, 'err')
  assert.equal(hasPendingGuiTools(closed), false)
})

// C1 — o result raiz só reconcilia ferramenta quando o turno LÓGICO acaba: com
// `continues` (fila de mensagens ou subagente vivo) o CLI ainda vai voltar.
test('C1 — result com continues não fecha ferramenta pendente nem inventa órfão', () => {
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  assert.match(store, /const settlesTurn = !evt\.continues/u)
  // 2026-08-28: a conta saiu do meio do reducer e virou `orphanedTurnTools`,
  // pura e compartilhada com o recibo da caixa-preta. O `continues` segue
  // barrado duas vezes: pelo `settlesTurn` aqui e dentro da propria conta.
  assert.match(store, /const orphan = settlesTurn/u)
  assert.match(store, /orphanedTurnTools\(next\.items, evt\)/u)
  assert.match(store, /const orphanedTool = orphan\.orphaned/u)
  assert.match(store, /if \(settlesTurn\) next = \{ \.\.\.next, items: closePendingGuiTools\(next\.items, evt\) \}/u)
  // O terminal do turno lógico continua reconciliando exatamente como antes.
  const pending = [{ ...tool('pendente', 'Bash', 'npm test'), toolUseId: 'bash-1' }]
  const settled = closePendingGuiTools(pending, {
    type: 'result',
    isError: false,
    outcome: 'completed'
  })
  assert.equal(settled[0].result.status, 'unconfirmed')
  assert.equal(settled[0].result.provisional, true)
})

// R7-E — O CASO REAL (print do dono, 2026-08-18): ■ com ferramentas em voo, e o
// fio respondia "! falhou · erro sem detalhe". O terminal que carrega a
// interrupção declarada fecha o card como CANCELADA, com a palavra do dono.
test('R7-E — turno interrompido cancela a ferramenta em voo e não pinta erro', () => {
  const pending = { ...tool('pendente', 'Bash', 'npm test'), toolUseId: 'bash-1' }
  const interrompido = closePendingGuiTools([pending], {
    type: 'result',
    isError: false,
    outcome: 'cancelled',
    interrupted: true,
    errorText: 'interrompido pelo dono'
  })
  assert.equal(interrompido[0].result.status, 'cancelled')
  assert.equal(interrompido[0].result.isError, false)
  assert.equal(
    interrompido[0].result.text,
    'interrompida pelo dono — o turno foi interrompido'
  )
  assert.equal(interrompido[0].result.provisional, undefined, 'parada do dono é definitiva')
  assert.equal(guiToolOutcomeView(interrompido[0].result).tone, 'cancel')
  assert.equal(guiToolOutcomeView(interrompido[0].result).compactLabel, 'cancelada')
  assert.equal(hasPendingGuiTools(interrompido), false)

  // A BANDEIRA GANHA do resto: mesmo que um motor ainda carimbasse is_error
  // (o claude carimba), o card do dono nunca vira vermelho.
  const cinto = closePendingGuiTools([pending], {
    type: 'result',
    isError: true,
    outcome: 'failed',
    interrupted: true,
    errorText: 'erro sem detalhe'
  })
  assert.equal(cinto[0].result.status, 'cancelled')
  assert.equal(cinto[0].result.isError, false)
  assert.equal(cinto[0].result.text, 'interrompida pelo dono — o turno foi interrompido')

  // FALHA DE VERDADE (sem bandeira) continua exatamente como hoje.
  const falhou = closePendingGuiTools([pending], {
    type: 'result',
    isError: true,
    outcome: 'failed',
    errorText: 'o turno explodiu'
  })
  assert.equal(falhou[0].result.status, 'failed')
  assert.equal(falhou[0].result.isError, true)
  assert.equal(falhou[0].result.text, 'o turno explodiu')
  assert.equal(guiToolOutcomeView(falhou[0].result).tone, 'err')
  assert.equal(pending.result, undefined, 'o estado de entrada continua cru')

  // O REDUTOR: a bandeira é lida ANTES de qualquer ramo de erro, e o fio ganha
  // NOTA neutra — nunca item de erro.
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  assert.match(store, /const ownerInterrupted = evt\.interrupted === true/u)
  assert.match(
    store,
    /if \(ownerInterrupted\) \{[\s\S]{0,400}?kind: 'note',\s*\n\s*text: 'turno interrompido'/u
  )
  assert.match(
    store,
    /\} else if \(evt\.isError \|\| evt\.outcome === 'failed' \|\| orphanedTool\) \{/u,
    'o ramo de erro passa a ser o ELSE da interrupção'
  )
  assert.doesNotMatch(store, /kind: 'error',\s*\n\s*text: 'turno interrompido'/u)
})

// C2 — filho nunca é fechado por conta própria e agente vivo não vira falha.
test('C2 — terminal fecha a raiz e cascateia pela árvore, sem trocar o desfecho de hoje', () => {
  const launchedParent = {
    ...tool('agent', 'Agent', 'trabalho longo'),
    toolUseId: 'agent-1',
    result: {
      text: 'agente despachado',
      isError: false,
      status: 'completed',
      lineCount: 1,
      truncated: false,
      agentStatus: 'launched',
      agentTaskId: 'task-1'
    }
  }
  const launchedChild = {
    ...tool('agent-child', 'Read', 'arquivo do agente'),
    toolUseId: 'agent-child',
    parentToolUseId: 'agent-1'
  }
  const rootTool = { ...tool('root', 'Bash', 'npm test'), toolUseId: 'root-1' }
  const closed = closePendingGuiTools([launchedParent, launchedChild, rootTool], {
    type: 'closed',
    code: 0
  })
  assert.equal(closed[0].result.status, 'cancelled', 'despacho vivo é cancelado, nunca falho')
  assert.equal(closed[0].result.agentStatus, 'settled')
  assert.equal(closed[1].result.status, 'cancelled')
  assert.equal(closed[2].result.status, 'failed', 'ferramenta raiz mantém o desfecho de sempre')
  assert.equal(launchedChild.result, undefined, 'o estado de entrada continua cru')

  // Sem os campos novos (Codex, replay antigo) nada muda: pai e filho fecham
  // com o MESMO desfecho terminal que já fechavam.
  const legacyParent = { ...tool('legacy', 'Agent', 'prompt'), toolUseId: 'legacy-1' }
  const legacyChild = {
    ...tool('legacy-child', 'Grep', 'padrão'),
    toolUseId: 'legacy-child',
    parentToolUseId: 'legacy-1'
  }
  const legacy = closePendingGuiTools([legacyParent, legacyChild], {
    type: 'fatal',
    text: 'ponte caiu'
  })
  assert.equal(legacy[0].result, legacy[1].result)
  assert.equal(legacy[0].result.status, 'failed')

  // Respawn assenta só o agente despachado; a fotografia do resto fica.
  const respawn = settleLaunchedGuiSubagents([launchedParent, launchedChild, rootTool])
  assert.equal(respawn[0].result.status, 'cancelled')
  assert.equal(respawn[1].result.status, 'cancelled')
  assert.equal(respawn[2], rootTool)
})

// Regressão do review: filho pendente cujo pai JÁ resolveu não herda nada — e
// mesmo assim fecha no terminal do turno. Sem isso `hasPendingGuiTools` nunca
// zera e todo turno seguinte re-inventa o erro de órfão.
test('filho pendente de pai já resolvido fecha no terminal do turno', () => {
  const resolvedParent = {
    ...tool('sync-agent', 'Agent', 'trabalho síncrono'),
    toolUseId: 'sync-1',
    result: {
      text: 'agente concluiu',
      isError: false,
      status: 'completed',
      lineCount: 1,
      truncated: false
    }
  }
  const strayChild = {
    ...tool('sync-child', 'Read', 'arquivo do agente'),
    toolUseId: 'sync-child',
    parentToolUseId: 'sync-1'
  }
  const closed = closePendingGuiTools([resolvedParent, strayChild], {
    type: 'result',
    isError: false,
    outcome: 'completed'
  })
  assert.equal(closed[0], resolvedParent, 'desfecho real do pai fica intocado')
  assert.equal(closed[1].result.status, 'unconfirmed', 'o filho fecha sem inventar um resultado')
  assert.equal(closed[1].result.provisional, true)
  assert.equal(hasPendingGuiTools(closed), false, 'nenhum card fica pendente para sempre')
})

// C3 (cerca) — o chat esconde a thread inteira do subagente enquanto a lateral
// a mantém: os DOIS lados leem os mesmos itens crus e não podem divergir.
test('C3 — chat esconde o subagente e a lateral continua mostrando quem trabalha', () => {
  const parent = {
    ...tool('parent', 'Agent', 'investigue o fluxo'),
    toolUseId: 'agent-1',
    subagent: { type: 'geral', prompt: 'investigue o fluxo' },
    result: {
      text: 'agente despachado',
      isError: false,
      status: 'completed',
      lineCount: 1,
      truncated: false,
      agentStatus: 'launched',
      agentTaskId: 'task-1'
    }
  }
  const child = {
    ...tool('child', 'Grep', 'padrão do filho'),
    toolUseId: 'child-1',
    parentToolUseId: 'agent-1'
  }
  // Pai evictado pelo cap/replay parcial: o nesting não resolve a caixa.
  const orphan = {
    ...tool('orphan', 'Read', 'arquivo do filho órfão'),
    toolUseId: 'orphan-1',
    parentToolUseId: 'evicted-parent'
  }
  const rootTool = { ...tool('root', 'Bash', 'npm test'), toolUseId: 'root-1' }
  const items = [parent, child, orphan, rootTool]

  const entries = normalizeGuiSubagentSidebar(items)
  assert.deepEqual(entries.map((entry) => entry.toolUseId), ['agent-1'])
  assert.equal(entries[0].activity, 'Grep · padrão do filho')

  const presented = nestGuiSubagentTools(items)
  assert.deepEqual(presented.map((item) => item.kind), ['subagent', 'tool', 'tool'])
  assert.equal(presented[1].parentToolUseId, 'evicted-parent', 'o órfão chega ao chat com linhagem')
  assert.equal(presented[2].id, 'root')

  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  assert.match(pane, /if \(item\.kind === 'subagent'\)[\s\S]*?continue/u)
  assert.match(pane, /if \(item\.kind === 'tool' && item\.subagent\)[\s\S]*?continue/u)
  assert.match(pane, /if \(item\.kind === 'tool' && item\.parentToolUseId\)[\s\S]*?continue/u)
})

// C4 — o ciclo de vida entra pelo canal com validação própria; payload sem os
// campos novos continua atravessando exatamente como antes.
test('C4 — canal aceita o ciclo de vida do subagente e recusa valor torto', () => {
  const launched = asGuiEvent({
    type: 'tool-result',
    text: 'agente despachado',
    isError: false,
    toolUseId: 'agent-1',
    agentStatus: 'launched',
    agentTaskId: 'task-1'
  })
  assert.equal(launched.agentStatus, 'launched')
  assert.equal(launched.agentTaskId, 'task-1')
  assert.equal(
    asGuiEvent({
      type: 'tool-result',
      text: 'resumo',
      isError: false,
      agentStatus: 'settled',
      agentTaskId: 'task-1'
    }).agentStatus,
    'settled'
  )
  for (const torto of [
    { agentStatus: 'running' },
    { agentStatus: true },
    { agentStatus: 'settled', agentTaskId: '' },
    { agentStatus: 'settled', agentTaskId: 42 },
    { agentStatus: 'settled', agentTaskId: 'x'.repeat(257) }
  ]) {
    assert.equal(
      asGuiEvent({ type: 'tool-result', text: '', isError: false, ...torto }),
      null,
      `ciclo de vida torto não vira estado: ${JSON.stringify(torto)}`
    )
  }
  const comum = asGuiEvent({ type: 'tool-result', text: 'ok', isError: false })
  assert.equal(comum.type, 'tool-result')
  assert.equal(comum.agentStatus, undefined)

  const closure = guiSubagentChildClosure()
  assert.equal(closure.isError, false)
  assert.equal(closure.status, 'completed')
  assert.equal(closure.text, 'encerrado com o subagente')
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  assert.match(store, /if \(evt\.agentStatus === 'settled' && item\.toolUseId\)/u)
  assert.match(store, /items: settleLaunchedGuiSubagents\(next\.items\)/u)
})

// C5 — o PRÓPRIO fio mostra que há trabalho correndo. Reclamação do dono: com
// subagentes em segundo plano a conversa parecia terminada (turno raiz fecha com
// `continues`, nada se move na tela). A contagem sai da MESMA normalização da
// lateral — nunca de uma heurística paralela.
test('C5 — indicador de fundo aparece com subagente vivo e some no settled', () => {
  const launchedParent = (id, taskId) => ({
    ...tool(`p-${id}`, 'Agent', `investigação ${id}`),
    toolUseId: id,
    subagent: { type: 'geral', prompt: `investigação ${id}` },
    result: {
      text: 'agente despachado',
      isError: false,
      status: 'completed',
      lineCount: 1,
      truncated: false,
      agentStatus: 'launched',
      agentTaskId: taskId
    }
  })
  const live = (items) => normalizeGuiSubagentSidebar(items)
  const show = (items, status = 'working') =>
    guiBackgroundWorkPresentation({ status, liveSubagents: live(items) })

  // 1 agente vivo: singular correto.
  const um = [launchedParent('agent-1', 'task-1')]
  assert.equal(live(um).length, 1)
  assert.deepEqual(show(um), {
    count: 1,
    label: '1 subagente trabalhando em segundo plano'
  })

  // 2 agentes concorrentes: plural e contagem factual (fichas independentes).
  const dois = [launchedParent('agent-1', 'task-1'), launchedParent('agent-2', 'task-2')]
  assert.equal(show(dois).count, 2)
  assert.equal(show(dois).label, '2 subagentes trabalhando em segundo plano')

  // O último settle apaga o indicador NO ATO — sem timer, sem sobra.
  const meio = [
    { ...dois[0], result: { ...dois[0].result, agentStatus: 'settled', status: 'completed' } },
    dois[1]
  ]
  assert.equal(show(meio).count, 1, 'um assentou, o outro ainda trabalha')
  const assentados = meio.map((item) => ({
    ...item,
    result: { ...item.result, agentStatus: 'settled', status: 'completed' }
  }))
  assert.equal(live(assentados).length, 0)
  assert.equal(show(assentados), null, 'sem agente vivo o fio não pode fingir trabalho')

  // Sem subagente nenhum o indicador simplesmente não existe.
  assert.equal(
    show([tool('t1', 'Read', 'arquivo.ts'), note('n1'), { id: 'u1', kind: 'user', text: 'oi', at: 1 }]),
    null
  )
  assert.equal(show([]), null)

  // Codex chega pela mesma projeção (card sintético `spawn_agent`, sem
  // agentStatus): a derivação é agnóstica de backend por desenho.
  const codex = [
    {
      ...tool('c1', 'spawn_agent', 'cálculo'),
      toolUseId: 'codex-agent:thread-9',
      subagent: { name: 'calculo', type: 'codex' }
    }
  ]
  assert.equal(show(codex).label, '1 subagente trabalhando em segundo plano')
  assert.equal(
    show([{ ...codex[0], result: { text: 'pronto', isError: false, status: 'completed', lineCount: 1, truncated: false } }]),
    null,
    'no Codex o result do pai JÁ é o terminal'
  )

  // Sessão morta nunca pisca vida (sobra de replay depois de closed/fatal).
  assert.equal(show(dois, 'dead'), null)
  // Esperando o dono o trabalho de fundo continua — e continua visível.
  assert.equal(show(dois, 'waiting-you').count, 2)
})

// C5b (cerca) — a superfície: uma fonte de verdade, um indicador vivo por vez,
// e movimento que respeita quem pediu menos movimento.
test('C5b — o fio deriva da lateral, troca o verbo genérico e para no reduced-motion', () => {
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')

  // Fonte única: o fio inteiro (nunca a janela visível, que poda o card do pai).
  assert.match(
    pane,
    /useMemo\(\(\) => normalizeGuiSubagentSidebar\(gui\.items\), \[gui\.items\]\)/u
  )
  assert.match(pane, /guiBackgroundWorkPresentation\(\{ status: gui\.status, liveSubagents \}\)/u)
  assert.doesNotMatch(pane, /liveSubagents = .*visibleItems/u)

  // Parent activity stays visible even while independent helpers are alive:
  // the pulse (2026-09-16) mounts on its own and gates itself on the parent turn.
  assert.match(pane, /<GuiAgentPulse\b[\s\S]{0,300}?active=\{!inert\}/u)
  assert.doesNotMatch(pane, /active=\{!inert && backgroundWork/u)
  assert.match(pane, /\{backgroundWork && \([\s\S]{0,400}?className="gui-background-work"/u)
  assert.match(pane, /data-subagent-count=\{backgroundWork\.count\}/u)
  assert.match(pane, /gui-background-work-label/u)
  assert.match(pane, /\{backgroundWork\.label\}/u)

  // Visual do tema (papel & painel) e movimento no vocabulário que já existe.
  assert.match(css, /\.gui-background-work\s*\{/u)
  assert.match(css, /\.gui-background-work\s*\{[^}]*border-radius: 999px/su)
  assert.match(css, /\.gui-background-work\s*\{[^}]*var\(--accent\)/su)
  assert.doesNotMatch(css, /\.gui-background-work[^}]*(spin|rotate)/su)
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.gui-background-work[\s\S]{0,160}?animation: none/u
  )
})

// ————— PROPOSTA DE PLANO (menu de planejamento, 2026-08-15) —————
// O quarto card interativo do chat. Ele NÃO nasce do CLI: quando a ferramenta
// `propose_plan` chega, o harness injeta o evento no anel da sessão — e a
// criação continua sendo do dono, no clique.

test('proposta de plano entra normalizada pelo validador do vivo', () => {
  const bom = asGuiEvent({
    type: 'plan-proposal',
    requestId: 'req-plan-1',
    draft: {
      title: '  V1.1  ',
      items: [
        { title: 'Fila', objective: 'fechar', doneCriteria: ['a'], tier: 'medio' },
        { title: '', objective: 'sem título' }
      ],
      lixo: 'campo que ninguém declarou'
    }
  })
  assert.equal(bom.type, 'plan-proposal')
  assert.equal(bom.requestId, 'req-plan-1')
  // O redutor e o card recebem o rascunho JÁ aparado: `items` torto ou título
  // gigante nunca viram exceção dentro de um `set` do zustand.
  assert.equal(bom.draft.title, 'V1.1')
  assert.equal(bom.draft.items.length, 1)
  assert.equal(bom.draft.items[0].tier, 'medio')
  assert.ok(!('lixo' in bom.draft))

  assert.equal(asGuiEvent({ type: 'plan-proposal', requestId: '', draft: { title: 'x' } }), null)
  assert.equal(asGuiEvent({ type: 'plan-proposal', draft: { title: 'x' } }), null)
  assert.equal(asGuiEvent({ type: 'plan-proposal', requestId: 'r', draft: 'nada' }), null)
  assert.equal(asGuiEvent({ type: 'plan-proposal', requestId: 'r', draft: {} }), null)
  // `items` inválido com título presente ainda é uma proposta legítima (plano
  // que nasce vazio) — o card diz isso em vez de sumir.
  const semItens = asGuiEvent({ type: 'plan-proposal', requestId: 'r', draft: { title: 'V2' } })
  assert.deepEqual(semItens.draft.items, [])
})

test('a proposta atravessa os cinco espelhos e entra na MESMA fila das decisões', () => {
  const api = readFileSync(new URL('../src/renderer/src/guiApi.ts', import.meta.url), 'utf8')
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')

  // espelhos 2 e 3 (união do renderer + validador do vivo)
  assert.match(api, /\| \{ type: 'plan-proposal'; requestId: string; draft: PlanDraft \}/u)
  assert.match(api, /if \(type === 'plan-proposal'\)/u)
  assert.match(api, /kind: 'plan-proposal'; approve: boolean/u)

  // espelho 5 (redutor da fatia guiPanes): fila por requestId, pulso de espera
  // e o eco factual no fio quando a decisão sai.
  assert.match(store, /case 'plan-proposal': \{/u)
  assert.match(store, /kind: 'plan-proposal',\s*\n\s*requestId: evt\.requestId,\s*\n\s*planProposal/u)
  assert.match(store, /planProposal: active\?\.kind === 'plan-proposal' \? active\.planProposal : null/u)
  assert.match(store, /evt\.resolution\.kind === 'plan-proposal'/u)
  // retirada pelo agente também tem recibo (permission-cancel).
  assert.match(store, /a proposta de plano foi retirada pelo agente/u)

  // a decisão viaja pela mesma cerca de falha das outras três
  assert.match(store, /const result = await guiApi\.answerPlanProposal\(/u)
  assert.match(store, /não deu para responder à proposta de plano/u)
})

test('o card rico substitui o card cru da tool e some na conversa congelada', () => {
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const card = readFileSync(
    new URL('../src/renderer/src/components/GuiPlanProposalCard.tsx', import.meta.url),
    'utf8'
  )

  // O tool card genérico é ocultado: dois desenhos da mesma decisão na tela.
  assert.match(pane, /'propose_plan'/u)
  assert.match(pane, /'mcp__synkora__propose_plan'/u)
  // Mesma cerca das outras decisões: histórico local aberto ou pane read-only
  // NÃO renderiza card vivo (`inert`), e o composer cede a vez ao card.
  // 2026-09-21: as decisões esperam o escritor da vez terminar de escrever o
  // que já recebeu (UM escritor por conversa) — a régua é `guiHeldItems`.
  assert.match(pane, /\{!inert && planProposalCard && !writerBusy && \(/u)
  assert.match(pane, /\{!inert && gui\.question && !writerBusy && \(/u)
  assert.match(pane, /guiThreadRenderItems\(guiHeldItems\(visibleItems, writerBusy\)\)/u)
  assert.match(pane, /const awaitingCard = Boolean\(gui\.question \|\| gui\.planReview \|\| planProposalCard\)/u)
  assert.match(pane, /answerGuiPlanProposal\(projectId, paneId, approve, note\)/u)

  // As duas portas do card: criar (a ÚNICA criação de plano) e ajustar, que
  // devolve o texto do dono ao agente.
  assert.match(card, /✓ criar plano/u)
  assert.match(card, /✎ ajustar/u)
  assert.match(card, /onDecide\(true\)/u)
  assert.match(card, /onDecide\(false, note\.trim\(\)\)/u)
  assert.match(card, /aria-expanded=\{open\}/u)
  // Nada de diálogo nativo nem de title= no card novo.
  assert.ok(!/window\.(confirm|alert)\(|\stitle="/u.test(card))
})

// ————— a proposta sobrevive ao fim do turno (bug do card que sumiu) —————
// Caso real 2026-08-15: propose_plan rodou, o card nasceu no MEIO da fala e
// sumiu quando o `result` chegou. O anel do main já isentava a proposta da
// limpeza terminal (`guiSurvivesTurnEnd`); o redutor do renderer, moldado nos
// irmãos permission/question, limpava a fila INTEIRA. Estes testes prendem a
// PARIDADE DOS DOIS ESPELHOS e a coreografia que o dono decidiu.

const permissionPending = {
  kind: 'permission',
  requestId: 'req-perm',
  perm: { requestId: 'req-perm', toolName: 'Write' }
}
const questionPending = { kind: 'question', requestId: 'req-ask', question: {} }
const planReviewPending = { kind: 'plan', requestId: 'req-plan', planReview: {} }
const proposalPending = {
  kind: 'plan-proposal',
  requestId: 'plan-proposal-1',
  planProposal: { requestId: 'plan-proposal-1', draft: { title: 'V1.0' } }
}

test('só a proposta de plano sobrevive ao fim do turno — as bloqueantes morrem', () => {
  // A regra é a mesma do anel: quem BLOQUEIA o CLI morre com o turno (o backend
  // já desistiu); a proposta não bloqueia nada e continua esperando o dono.
  assert.equal(guiInteractionSurvivesTurnEnd('plan-proposal'), true)
  assert.equal(guiInteractionSurvivesTurnEnd('permission'), false)
  assert.equal(guiInteractionSurvivesTurnEnd('question'), false)
  assert.equal(guiInteractionSurvivesTurnEnd('plan'), false)

  const queue = [permissionPending, proposalPending, questionPending, planReviewPending]
  assert.deepEqual(
    retainGuiInteractionsAfterTurnEnd(queue),
    [proposalPending],
    'o result/fatal/closed varre as bloqueantes e conserva a proposta'
  )
  assert.deepEqual(retainGuiInteractionsAfterTurnEnd([]), [])
  assert.deepEqual(
    retainGuiInteractionsAfterTurnEnd([permissionPending]),
    [],
    'sem proposta pendente a limpeza terminal continua idêntica à de antes'
  )
})

test('proposta pendente NÃO conta como fio parado no meio do turno', () => {
  // `blocksTurn` é o que decide o status enquanto o agente fala. Com a proposta
  // contando como "parado", todo delta seguinte virava `waiting-you` e o card
  // aparecia no meio da resposta — o "bugou e sumiu" que o dono viu.
  assert.equal(guiInteractionBlocksTurn([proposalPending]), false)
  assert.equal(guiInteractionBlocksTurn([]), false)
  assert.equal(guiInteractionBlocksTurn([permissionPending]), true)
  assert.equal(guiInteractionBlocksTurn([questionPending]), true)
  assert.equal(guiInteractionBlocksTurn([planReviewPending]), true)
  assert.equal(
    guiInteractionBlocksTurn([proposalPending, permissionPending]),
    true,
    'uma bloqueante ao lado da proposta ainda para o fio'
  )
})

test('o card da proposta espera a fala terminar e FICA até o dono decidir', () => {
  // Coreografia decidida pelo dono: nada de card no meio da fala. O turno vivo
  // é status `working` OU stream aberto — as duas portas por onde a resposta
  // ainda está sendo escrita.
  assert.equal(isGuiTurnActive('working', ''), true)
  assert.equal(isGuiTurnActive('working', 'escrevendo'), true)
  assert.equal(isGuiTurnActive('waiting-you', 'ainda escrevendo'), true)
  // Turno fechado: é aqui que o card entra, embaixo da resposta pronta.
  assert.equal(isGuiTurnActive('idle', ''), false)
  assert.equal(isGuiTurnActive('waiting-you', ''), false)
  assert.equal(isGuiTurnActive('dead', ''), false)
  assert.equal(isGuiTurnActive('starting', ''), false)
})

test('o redutor espelha a isenção do anel em result, fatal e closed', () => {
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')

  // Nenhum dos três terminais pode voltar a zerar a fila na marra: era esse
  // `guiInteractionPatch([])` que apagava o card do dono.
  assert.ok(
    !/\.\.\.guiInteractionPatch\(\[\]\)/u.test(store),
    'terminal nunca zera a fila às cegas — ele conserva o que sobrevive ao turno'
  )
  assert.equal(
    store.match(/retainGuiInteractionsAfterTurnEnd\(/gu)?.length,
    3,
    'os três terminais (result, fatal, closed) usam a MESMA política'
  )
  // O meio do turno pergunta "bloqueia?", não "a fila está vazia?".
  assert.match(store, /guiInteractionBlocksTurn\(/u)
  // E a chegada da proposta no meio da fala não pode mais fingir fim de turno.
  assert.match(store, /const turnInFlight = state\.status === 'working'/u)
})

/* ————————————————————————————————————————————————————————————————
   A BARRA DE ACEITE INLINE ("esperando você · aprovar · ajustar")

   Regressão do caso real do dono (transcript gui-dev-31ba7077, pane de
   planejamento do PAINEL DE GESTÃO, 2026-08-17): plano JÁ aprovado, já virado
   aba no mapa — e a barra apareceu mesmo assim pedindo aprovação.
   ———————————————————————————————————————————————————————————————— */

/**
 * A fala EXATA que acendeu a barra indevidamente, copiada byte a byte do
 * gui-sessions.json do dono (evento 416 do transcript). O plano já estava
 * aprovado: a palavra "aprovado" aqui AFIRMA um fato, e a pergunta de verdade
 * — a última frase — é um menu aberto, nunca um sim/não.
 */
const OWNER_PLAN_ALREADY_APPROVED =
  'Oi, Erick! Por aqui está tudo encerrado da parte do planejamento: o plano **"V1.0 completa — do visual novo ao QA final"** está aprovado no mapa, com os 13 briefs em `plano/`. Precisa de alguma coisa — ajustar alguma missão, repensar ordem, ou tirar dúvida sobre o plano?'

test('plano já aprovado não acende a barra de aceite (caso do dono)', () => {
  // O detector antigo procurava a marca nos últimos 320 caracteres e achava
  // "aprovado" 148 caracteres ANTES do "?", numa frase que só constata estado.
  assert.equal(
    guiAsksForGo(OWNER_PLAN_ALREADY_APPROVED),
    false,
    'fala que ANUNCIA plano aprovado e termina em pergunta aberta não pede aceite'
  )
  // A pergunta que o dono lê é só a última frase — e ela não pede nada.
  assert.equal(
    guiFinalQuestion(OWNER_PLAN_ALREADY_APPROVED),
    'Precisa de alguma coisa — ajustar alguma missão, repensar ordem, ou tirar dúvida sobre o plano?'
  )
})

test('a sequência persistida do dono não deixa nenhuma decisão na tela', () => {
  // Reprodução da sequência gravada: as DUAS propostas de plano foram
  // resolvidas (a 1ª ajustada, a 2ª aprovada), então nada sobrevive na fila —
  // é o que prova que o card da proposta não é o que estava na tela.
  const queue = []
  const first = { kind: 'plan-proposal', requestId: 'plan-proposal-838b7149' }
  const second = { kind: 'plan-proposal', requestId: 'plan-proposal-e014f6c5' }
  let pending = enqueueGuiInteraction(queue, first)
  pending = removeGuiInteraction(pending, first.requestId) // resolvida: approve=false
  pending = enqueueGuiInteraction(pending, second)
  pending = retainGuiInteractionsAfterTurnEnd(pending) // proposta atravessa o fim do turno
  assert.equal(pending.length, 1, 'a 2ª proposta espera o dono enquanto não é resolvida')
  pending = removeGuiInteraction(pending, second.requestId) // resolvida: approve=true
  assert.deepEqual(pending, [], 'proposta resolvida nunca volta para a fila')

  // Fio como o replay o remonta depois do respawn: "oi" do dono, resposta do
  // agente já revelada por inteiro, turno fechado.
  const items = [
    { id: 'u1', kind: 'user', text: 'oi', at: 1 },
    {
      id: 'a1',
      kind: 'assistant',
      text: OWNER_PLAN_ALREADY_APPROVED,
      at: 2,
      live: false,
      animateFrom: OWNER_PLAN_ALREADY_APPROVED.length
    }
  ]
  assert.equal(
    guiAwaitingGoDecision(items, {
      status: 'idle',
      perm: false,
      stream: false,
      awaitingCard: pending.length > 0
    }),
    false,
    'com tudo resolvido e nenhuma pergunta real, a conversa não está esperando o dono'
  )
})

test('a barra continua acendendo em pedido de aceite de verdade', () => {
  // Cobertura preservada: o que a barra existe para responder.
  for (const text of [
    'Terminei a fundação do visual. Posso seguir para as telas?',
    'O ajuste está pronto — pode seguir?',
    'Fiz do jeito que combinamos. Confirma?',
    'Deixei a paleta nova só no cabeçalho. Segue assim?',
    'Escrevi os 13 briefs. Aprova?',
    'Reorganizei a ordem das missões. Sigo?',
    // "fechado?" só é marca COM o sinal de pergunta — a frase final chega ao
    // detector com o "?" preservado.
    'Deixo o instalador para a última missão. Fechado?'
  ]) {
    assert.equal(guiAsksForGo(text), true, `pedido de aceite deveria acender: ${text}`)
  }
  assert.equal(
    guiFinalQuestion('Fiz o ajuste. Fechado?'),
    'Fechado?',
    'a frase final preserva o sinal de pergunta'
  )
})

test('a marca precisa morar na frase que termina em pergunta', () => {
  // A classe inteira do bug: marca numa frase, pergunta em outra.
  assert.equal(
    guiAsksForGo('O plano está aprovado no mapa. Quer ver os briefs?'),
    false,
    'marca numa frase anterior não transforma pergunta aberta em pedido de aceite'
  )
  assert.equal(
    guiAsksForGo('Posso seguir com isso depois. O que você acha da ordem?'),
    false,
    'nem quando a frase anterior contém a marca inteira'
  )
  // Particípio é forma de AFIRMAR estado, nunca de pedir — vale inclusive
  // quando cai na mesma frase da pergunta (o agente escreve com travessão).
  assert.equal(
    guiAsksForGo('O plano está aprovado — precisa de mais alguma coisa?'),
    false,
    'travessão não faz de "está aprovado" um pedido de aprovação'
  )
  // Fala sem pergunta nenhuma nunca teve barra, e continua sem.
  assert.equal(guiAsksForGo('O plano está aprovado no mapa.'), false)
  assert.equal(guiFinalQuestion('Sem pergunta aqui.'), null)
})

test('a barra só existe com o turno fechado e nada mais na tela', () => {
  const asking = [
    { id: 'a1', kind: 'assistant', text: 'Posso seguir?', at: 1, live: false, animateFrom: 13 }
  ]
  assert.equal(guiAwaitingGoDecision(asking, { status: 'idle' }), true)
  // Cada trava sozinha derruba a barra.
  assert.equal(guiAwaitingGoDecision(asking, { status: 'working' }), false)
  assert.equal(guiAwaitingGoDecision(asking, { status: 'idle', perm: true }), false)
  assert.equal(guiAwaitingGoDecision(asking, { status: 'idle', stream: true }), false)
  assert.equal(guiAwaitingGoDecision(asking, { status: 'idle', awaitingCard: true }), false)
  // Fala ainda sendo revelada não é fala fechada.
  assert.equal(
    guiAwaitingGoDecision(
      [{ id: 'a1', kind: 'assistant', text: 'Posso seguir?', at: 1, live: true, animateFrom: 13 }],
      { status: 'idle' }
    ),
    false
  )
  assert.equal(
    guiAwaitingGoDecision(
      [{ id: 'a1', kind: 'assistant', text: 'Posso seguir?', at: 1, live: false, animateFrom: 4 }],
      { status: 'idle' }
    ),
    false
  )
  // O dono já respondeu: a última voz do fio é dele.
  assert.equal(
    guiAwaitingGoDecision([...asking, { id: 'u1', kind: 'user', text: 'pode', at: 2 }], {
      status: 'idle'
    }),
    false
  )
})

test('GuiPane consome o detector do módulo, sem heurística própria', () => {
  const pane = readFileSync(new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url), 'utf8')
  assert.match(pane, /guiAwaitingGoDecision/u, 'a barra pergunta ao módulo')
  assert.ok(
    !/const ASK_RE\b/u.test(pane),
    'a régua do aceite mora em guiAskForGo.ts — cópia no componente volta a divergir'
  )
})

// ————— AS COSTURAS DO CICLO REDONDO (R6, integração das ondas B×C) —————
//
// A onda C mapeou (relatório r6c-sidebar §5) três furos FORA das fronteiras das
// duas ondas; a integração os fecha aqui. O contrato: card de ajudante
// interrompido carrega result.status 'interrupted' e NÃO é a última palavra —
// helper_cancel o fecha, helper_resume abre a segunda vida, e o boot nunca o
// confunde com um cancelamento.

test('card INTERROMPIDO aceita um segundo desfecho — o descarte fecha a ficha', () => {
  const interrupted = {
    ...tool('h1', 'delegate', 'ajudante parado'),
    toolUseId: 'helper:h-1',
    result: {
      text: 'interrompido',
      isError: false,
      status: 'interrupted',
      lineCount: 1,
      truncated: false,
      agentStatus: 'settled'
    }
  }
  const done = {
    ...tool('h2', 'delegate', 'ajudante entregue'),
    toolUseId: 'helper:h-2',
    result: { text: 'ok', isError: false, status: 'completed', lineCount: 1, truncated: false }
  }
  // O interrompido ainda espera a última palavra (cancel/resume); o concluído
  // não — reabrir um desfecho REAL continua proibido.
  assert.equal(guiToolResultTargetIndex([interrupted, done], 'helper:h-1'), 0)
  assert.equal(guiToolResultTargetIndex([interrupted, done], 'helper:h-2'), -1)
})

test('no replay de boot o AJUDANTE vira interrompido; o subagente nativo, cancelado', () => {
  const helper = {
    ...tool('h1', 'delegate', 'ajudante'),
    toolUseId: 'helper:h-9',
    result: {
      text: 'aberto',
      isError: false,
      status: 'completed',
      lineCount: 1,
      truncated: false,
      agentStatus: 'launched'
    }
  }
  const native = {
    ...tool('n1', 'Agent', 'nativo'),
    toolUseId: 'task-1',
    result: {
      text: 'aberto',
      isError: false,
      status: 'completed',
      lineCount: 1,
      truncated: false,
      agentStatus: 'launched'
    }
  }
  const settled = settleLaunchedGuiSubagents([helper, native])
  assert.equal(settled[0].result.status, 'interrupted', 'o motor preservou o registro — o card não pode dizer cancelado')
  assert.equal(settled[0].result.isError, false, 'interromper não é falhar')
  assert.match(settled[0].result.text, /helper_resume/u, 'o card ensina o verbo da volta')
  assert.equal(settled[1].result.status, 'cancelled', 'o nativo morreu com a sessão, como sempre')
})

// ————————————————————————————————————————————————————————————————————————
// RODADA 9 (2026-08-19) — o ⇪ AVISA o agente; o dono assiste, nunca é travado.
// Ordem do dono, verbatim: "NÃO pode aparecer modal 'essa missão tá sendo
// integrada': eu preciso VER o que ele tá fazendo no chat."
// ————————————————————————————————————————————————————————————————————————

test('o ⇪ não levanta janela nenhuma: o véu do "integrando" morreu', () => {
  const board = readFileSync(
    new URL('../src/renderer/src/components/Board.tsx', import.meta.url),
    'utf8'
  )
  // Uma proibição se mede no que RENDERIZA: o comentário que registra a morte
  // do véu não pode reprovar o arquivo que a obedece.
  const css = readFileSync(
    new URL('../src/renderer/src/global.css', import.meta.url),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//gu, '')

  // O véu que cobria o board inteiro enquanto o Git trabalhava saiu do JSX...
  assert.doesNotMatch(board, /className="integrating-/u, 'o véu do "integrando" voltou ao board')
  assert.doesNotMatch(board, /className="spinner"/u, 'o anel do véu voltou ao board')
  // ...e do CSS junto: regra órfã é convite para o modal renascer.
  assert.doesNotMatch(css, /\.integrating-overlay/u, 'a regra do véu ficou no CSS')
  assert.doesNotMatch(css, /\.integrating-card/u, 'a regra do cartão ficou no CSS')
  assert.doesNotMatch(css, /^\.spinner\s*\{/mu, 'a regra órfã do anel ficou no CSS')
  // Diálogo nativo já é proibido na casa — o ⇪ é onde a tentação mora.
  assert.doesNotMatch(board, /window\.(confirm|alert)\(/u)

  // A RECUSA continua legível, no padrão NÃO-modal da casa: a faixa que o dono
  // fecha no × (planejamento, missão arquivada, árvore suja, fila pausada).
  assert.match(board, /className="mission-msg"/u, 'a faixa de aviso do board sumiu')
  assert.match(board, /className="mission-msg-close"/u)
})

test('o eco do ⇪ vira ESTADO — só a RECUSA sobe para a faixa', () => {
  const board = readFileSync(
    new URL('../src/renderer/src/components/Board.tsx', import.meta.url),
    'utf8'
  )

  const start = board.indexOf('async function onIntegrate')
  const end = board.indexOf('const isDirect =', start)
  assert.ok(start > 0 && end > start, 'o gesto do ⇪ mudou de forma')
  const body = board.slice(start, end)

  // A régua é a FOTOGRAFIA da fila: mudou = o ⇪ atravessou e a tela já conta a
  // história (posição e estado no trilho e no card da coluna); igual = o motor
  // devolveu uma RECUSA, e essa o dono precisa ler.
  assert.match(body, /ticketMark\(/u, 'o clique precisa comparar a fotografia da fila')
  assert.match(body, /useStore\.getState\(\)\.missions/u, 'a comparação lê a missão FRESCA')
  assert.match(
    body,
    /setMissionMsg\(\s*after && after !== before \? null : msg\s*\)/u,
    'recusa engolida é bug: só o ticket que ANDOU cala a faixa'
  )

  // A ordem real da fila desce para o trilho — é ela que substitui o modal.
  assert.match(board, /queueRows=\{integrationRows\}/u, 'o trilho não recebe a ordem da fila')
  assert.match(board, /integrationQueueRows\(/u)
  assert.match(board, /from '\.\.\/integrationQueuePresentation'/u)
})

// ————— O BUG DA ABA ETERNA (19/08, teste ao vivo do dono) —————
//
// "Eu tava clicando em derrubar teste, clicando em fechar a aba e não fechava
// de jeito nenhum." O main matava o processo e ECOAVA panes:closeById — mas
// NINGUÉM no renderer assinava o evento (o listener morreu com a aba PANES da
// onda D). O pane ficava na lista para sempre: aba eterna, botão de derrubar
// eterno, clique visualmente morto.

test('o eco panes:closeById tem OUVINTE: preload expõe e o App fecha o pane', () => {
  const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  assert.match(preload, /'panes:closeById'/u, 'o preload tem de assinar o eco do main')
  assert.match(preload, /onCloseById/u, 'a assinatura precisa de nome na bridge')
  const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /onCloseById/u, 'o App tem de ouvir o eco')
  assert.match(
    app.slice(app.indexOf('onCloseById')),
    /closePane\(/u,
    'o eco tem de terminar no closePane — é ele que tira o pane da lista'
  )
})

test('derrubar teste com o PTY já morto ainda LIMPA o registro do servidor', () => {
  const lifecycle = readFileSync(new URL('../src/main/paneLifecycle.ts', import.meta.url), 'utf8')
  const terminate = lifecycle.slice(lifecycle.indexOf('function terminatePaneNow'))
  assert.match(
    terminate.slice(0, 600),
    /testServerPanes\.delete\(paneId\)/u,
    'o registro do test server tem de morrer no fecho manual, com ou sem PTY vivo'
  )
})

// ————— O TIMER DE RODADA (R11, ordem do dono) —————
//
// "Da primeira mensagem que eu mandei até ele me entregar o resultado final...
// sempre no final de cada rodada eu quero o timer em algum lugar." A régua do
// início/fim JÁ era a do `startedAt` (arma no working, PRESERVA esperando o
// dono, zera no idle) — o selo nasce na transição que zera.

test('a rodada fechada carimba o selo ⏱ — a régua é pura e o store a consome', async () => {
  const { guiRoundClosed, guiRoundStampText, transitionGuiStartedAt } = await import(
    '../src/renderer/src/guiActivity.ts'
  )
  // A régua do início/fim JÁ era a do startedAt: arma no working, PRESERVA
  // esperando o dono (a espera é parte da rodada), zera no idle.
  const armed = transitionGuiStartedAt(null, 'working', 1_000)
  assert.equal(armed, 1_000)
  assert.equal(transitionGuiStartedAt(armed, 'waiting-you', 5_000), 1_000)
  assert.equal(transitionGuiStartedAt(armed, 'idle', 9_000), null)

  // O selo nasce EXATAMENTE na transição que zera para idle — nunca em morte
  // de sessão (dead não é rodada concluída) nem em turno que continua.
  assert.equal(guiRoundClosed(1_000, null, 'idle'), true)
  assert.equal(guiRoundClosed(1_000, 1_000, 'working'), false)
  assert.equal(guiRoundClosed(1_000, null, 'dead'), false)
  assert.equal(guiRoundClosed(null, null, 'idle'), false)
  assert.match(guiRoundStampText(252_000), /^⏱ rodada: 4:12$/u)

  // E o store consome a régua nomeada — nunca uma cópia inline.
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  assert.match(store, /guiRoundClosed\(/u, 'o applyGuiEvent decide pelo módulo puro')
  assert.match(store, /guiRoundStampText\(/u, 'o texto do selo tem fonte única')
})

// ————— R11: o FAST é flag de spawn — as quatro listas e o fingerprint —————

test('o fast atravessa o contrato de spawn inteiro (espelho, literais, Board, fingerprint)', () => {
  const api = readFileSync(new URL('../src/renderer/src/guiApi.ts', import.meta.url), 'utf8')
  assert.match(api, /fast\?: boolean/u, 'o espelho do spawn precisa do campo')
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  assert.equal(
    (pane.match(/fast: fastOn \|\| undefined/gu) ?? []).length,
    2,
    'os DOIS literais do spawn carregam o fast — um só deixaria o respawn voltar ao antigo'
  )
  assert.match(pane, /gui-fast-btn/u, 'o toggle ⚡ existe no composer')
  const board = readFileSync(
    new URL('../src/renderer/src/components/Board.tsx', import.meta.url),
    'utf8'
  )
  assert.match(board, /fast=\{slot\.spawn\.fast\}/u, 'o Board repassa a escolha ao pane')
  const sessions = readFileSync(new URL('../src/main/guiSessions.ts', import.meta.url), 'utf8')
  assert.match(
    sessions,
    /spawn\.fast \? 'fast' : ''/u,
    'fast fora do fingerprint = trocar não respawnaria'
  )
})

// ————— R12: o ⚡ vira INTERRUPTOR quieto (queixa do dono: "cliquei, fica
// selecionado; não precisa mexer na UI inteira") —————

test('restart retomado é quieto: o chrome não se reapresenta a cada clique no ⚡', () => {
  // `status: null` = MANTER o que estava. É o que apaga o flash "abrindo" de
  // um respawn que nem trocou de conversa.
  assert.deepEqual(guiSessionRestartState(true, false, true, 'idle'), {
    ready: false,
    status: null
  })
  assert.deepEqual(guiSessionRestartState(true, true, true, 'working'), {
    ready: true,
    status: null
  })
  // Sem carimbo (geração nova, ou fotografia gravada antes do contrato) o
  // caminho antigo continua inteiro.
  assert.deepEqual(guiSessionRestartState(true, false, false, 'idle'), {
    ready: false,
    status: 'starting'
  })
  assert.deepEqual(guiSessionRestartState(true, false), { ready: false, status: 'starting' })
  // Pane MORTO é a exceção: ali o marco é o boundary de retry que ressuscita o
  // terminal — `guiBackendReadyStatus` recusa init/ready justamente por isso.
  assert.deepEqual(guiSessionRestartState(true, false, true, 'dead'), {
    ready: false,
    status: 'starting'
  })

  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  const from = store.indexOf("case 'session-restarted':")
  const to = store.indexOf("case 'conversation-cleared':", from)
  assert.ok(from !== -1 && to > from, 'o caso do restart foi recortado')
  const restart = store.slice(from, to)
  assert.match(restart, /evt\.resumed === true/u, 'o redutor lê o carimbo do main')
  assert.match(restart, /const quiet = restart\.status === null/u)
  assert.match(restart, /caps: quiet \|\| restart\.ready \? state\.caps : null/u)
  assert.match(restart, /executorModel: quiet \? state\.executorModel : null/u)
  assert.match(restart, /effort: quiet \? state\.effort : null/u)
  // Fotografia AUSENTE não apaga o medidor de uma conversa que continua.
  assert.match(
    restart,
    /contextTokens: evt\.contextTokens \?\? \(quiet \? state\.contextTokens : null\)/u
  )
  assert.match(
    restart,
    /contextWindow: evt\.contextWindow \?\? \(quiet \? state\.contextWindow : null\)/u
  )
  assert.match(
    restart,
    /restart\.status === null \? \{\} : guiStatusPatch\(state, restart\.status\)/u,
    'restart quieto não pode nem tocar no status/relógio da rodada'
  )
  // O envio segue barrado até o `ready` novo: a honestidade fica, o teatro sai.
  assert.match(restart, /ready: restart\.ready/u)

  // E o espelho do evento existe dos dois lados da ponte.
  const sessions = readFileSync(new URL('../src/main/guiSessions.ts', import.meta.url), 'utf8')
  const api = readFileSync(new URL('../src/renderer/src/guiApi.ts', import.meta.url), 'utf8')
  assert.match(sessions, /type: 'session-restarted',\s*ready: replaySawReady,\s*resumed: sameConversation/u)
  assert.match(api, /type: 'session-restarted'[\s\S]{0,320}?resumed\?: boolean/u)
})

test('o ⚡ é interruptor: só o glifo, dica de uma linha e sucesso sem nota no fio', () => {
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const fastFrom = pane.indexOf('gui-mode-btn gui-fast-btn')
  const fastTo = pane.indexOf('</button>', fastFrom)
  assert.ok(fastFrom !== -1 && fastTo > fastFrom, 'o botão ⚡ foi recortado')
  const fastBtn = pane.slice(fastFrom, fastTo)
  // A1 — o rótulo "fast" nascia ao ligar e empurrava os vizinhos. Aceso agora
  // é contorno + aria-pressed, e a largura não muda ao alternar.
  assert.doesNotMatch(fastBtn, /gui-mode-text/u)
  assert.match(fastBtn, /aria-pressed=\{fastOn\}/u)
  // A2 — UMA linha; o parágrafo sobre o respawn saiu da dica. Desde a R25 a
  // dica é COMPOSTA num const (o ⚡ não tem menu onde pendurar a nota da troca
  // cara), então o texto se lê lá — e o botão continua sem prosa nenhuma.
  assert.match(fastBtn, /data-tip=\{fastTip\}/u)
  const fastTip = pane.slice(pane.indexOf('const fastBaseTip'), pane.indexOf('const queuedMessage'))
  assert.match(fastTip, /'desligar o modo fast'/u)
  assert.match(fastTip, /'modo fast — gasta mais limite \(vira Opus 5\)'/u)
  assert.match(fastTip, /'modo fast — gasta mais limite'/u)
  assert.doesNotMatch(fastTip, /A conversa continua de onde está/u)

  // A3 — sucesso silencioso (o botão aceso É o recibo); a FALHA continua
  // falando, e o modo de permissão mantém a nota de sucesso dele.
  const changeFast = pane.slice(pane.indexOf('const changeFast'), pane.indexOf('const changeMode'))
  assert.match(changeFast, /applySpawnChange\('fast', \{ fast: next \|\| undefined \}, null\)/u)
  assert.doesNotMatch(changeFast, /modo fast (?:LIGADO|desligado)/u)
  const spawnChange = pane.slice(
    pane.indexOf('const applySpawnChange'),
    pane.indexOf('const applyExecutorChange')
  )
  assert.match(spawnChange, /okText: string \| null/u)
  assert.match(spawnChange, /if \(okText !== null\)/u)
  assert.match(spawnChange, /type: 'limit'/u, 'falha de troca nunca é silenciosa')
  const changeMode = pane.slice(
    pane.indexOf('const changeMode'),
    pane.indexOf('const changeModel')
  )
  assert.match(changeMode, /`modo de permissão: \$\{PERM_MODE_LABEL\[next\]\}`/u)

  // Sem rótulo, o contorno é o ÚNICO sinal de ligado — e o hover genérico da
  // família (mais específico) o apagava com o ponteiro em cima.
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')
  assert.match(css, /\.gui-mode-btn\.gui-fast-btn\.on:hover:not\(:disabled\)/u)
})

// ————— R13: o ⚡ do tamanho do ícone (queixa do dono: "tá parecendo um
// remendo"). A causa era a CÉLULA, não o estilo: sem `grid-area` a
// auto-colocação jogava o botão no spacer `minmax(_, 1fr)` e o esticava. —————

/** Uma faixa `.gui-composer-inner { … }` por variante, na ordem da folha. */
function composerGridBlocks(css) {
  return [...css.matchAll(/\.gui-composer-inner[^{}]*\{([^}]*)\}/gu)].map((match) => match[1])
}

/** `minmax(8px, 1fr)` é UMA trilha: as vírgulas de dentro não contam. */
function trackCount(value) {
  return value
    .replace(/\([^)]*\)/gu, '()')
    .trim()
    .split(/\s+/u)
    .filter(Boolean).length
}

test('o ⚡ tem célula própria: toda variante da grade do composer conta a mesma coluna', () => {
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')
  const blocks = composerGridBlocks(css)
  assert.ok(
    blocks.length >= 4,
    'as variantes da grade não foram encontradas — o teste passaria sem olhar nada'
  )

  let footerRows = 0
  // Variante que só redefine as colunas herda as áreas da última declarada na
  // ordem da folha; é assim que a de 430px vive.
  let cellsInEffect = 0
  for (const [index, body] of blocks.entries()) {
    const areas = /grid-template-areas:\s*([^;]+);/u.exec(body)
    const columns = /grid-template-columns:\s*([^;]+);/u.exec(body)
    const where = `variante #${index + 1} de .gui-composer-inner`

    if (areas) {
      const rows = (areas[1].match(/"([^"]*)"/gu) ?? []).map((row) =>
        row.slice(1, -1).trim().split(/\s+/u).filter(Boolean)
      )
      assert.ok(rows.length > 0, `${where}: grid-template-areas sem nenhuma fileira`)
      for (const row of rows) {
        assert.equal(
          row.length,
          rows[0].length,
          `${where}: fileiras de tamanhos diferentes desalinham a grade inteira`
        )
      }
      const footer = rows.find((row) => row.includes('send'))
      assert.ok(footer, `${where}: a fileira dos controles sumiu`)
      assert.equal(
        footer.filter((cell) => cell === 'fast').length,
        1,
        `${where}: o ⚡ precisa de UMA célula nomeada, senão cai no spacer e estica`
      )
      assert.deepEqual(
        footer.slice(-3),
        ['effort', 'fast', 'send'],
        `${where}: o ⚡ mora entre o effort e o enviar`
      )
      assert.ok(rows.some(row => row.includes('model')), `${where}: modelo continua acessível`)
      assert.ok(rows.some(row => row.includes('effort')), `${where}: esforço continua acessível`)
      footerRows += 1
      cellsInEffect = rows[0].length
    }

    if (columns) {
      assert.ok(cellsInEffect > 0, `${where}: colunas antes de qualquer área declarada`)
      assert.equal(
        trackCount(columns[1]),
        cellsInEffect,
        `${where}: colunas e áreas em desacordo — a fileira escorrega uma casa`
      )
    }
  }
  assert.ok(footerRows >= 3, 'as fileiras de controle (base, com anexos, pane estreito) sumiram')
})

test('o ⚡ é caixa de ícone: 30px, sem padding, glifo no centro', () => {
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')
  const rule = /^\.gui-fast-btn\s*\{([^}]*)\}/mu.exec(css)
  assert.ok(rule, 'sem regra própria o botão herda o padding da família e vira pílula')
  assert.match(rule[1], /grid-area: fast;/u)
  assert.match(rule[1], /width: 30px;/u, 'a largura fixa é o que barra o stretch da grade')
  assert.match(rule[1], /padding: 0;/u)
  assert.match(rule[1], /justify-content: center;/u)
})

test('o ⚡ aparece na conversa que roda no padrão da conta (o gate lê o modelo efetivo)', () => {
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  assert.match(
    pane,
    /const effectiveModelOption =\s*selectedModelOption \?\? \(modelUsesDefault \? modelDefaultOption : undefined\)/u,
    'sem pino de modelo a ficha que responde pelas capacidades é a do default'
  )
  assert.match(
    pane,
    /\{\(fastOn \|\| effectiveModelOption\?\.supportsFastMode === true\) && \(/u,
    'o gate do botão precisa do modelo efetivo — e `fastOn` continua garantindo o desligar'
  )
  assert.doesNotMatch(
    pane,
    /fastOn \|\| selectedModelOption\?\.supportsFastMode/u,
    'o gate antigo escondia o ⚡ em toda conversa sem pino de modelo'
  )
})

// ————— R14: a CÓPIA volta (ordens do dono: "devolve o botão de copiar na
// mensagem final — agora só fica o tempo" e "seleciono, dou Ctrl+C e não
// funciona") —————
//
// O selo ⏱ da R11 é um item `kind:'note'` empurrado DEPOIS da resposta
// (store.ts) e a régua da cópia exigia que a própria fala fosse o último item
// do fio: com o selo atrás, o botão nunca mais apareceu. E o fio inteiro era
// `user-select: none` (política global do app), então o arrasto que começava
// fora de uma ilha de texto não pintava nada para o Ctrl+C levar.

/** A fala revelada que fecha o turno, na forma que o store guarda. */
const R14_FINAL_ASSISTANT = {
  id: 'assistant-final',
  kind: 'assistant',
  text: 'Resposta final',
  at: 2,
  live: false,
  animateFrom: 14
}

test('o selo da rodada é pós-escrito: a régua da cópia pula as notas do fim', async () => {
  const { guiRoundStampText } = await import('../src/renderer/src/guiActivity.ts')
  // A forma EXATA que o applyGuiEvent empurra ao fechar a rodada (R11).
  const stamp = { id: 'note-stamp', kind: 'note', text: guiRoundStampText(252_000), at: 3 }
  assert.match(stamp.text, /^⏱ rodada: /u, 'o selo mudou de forma — a régua precisa segui-lo')
  const base = {
    assistantId: R14_FINAL_ASSISTANT.id,
    status: 'idle',
    stream: '',
    thinking: false,
    awaitingInteraction: false
  }

  assert.equal(
    isGuiFinalAssistantMessage({
      ...base,
      items: [{ id: 'user-1', kind: 'user', text: 'Pergunta', at: 1 }, R14_FINAL_ASSISTANT, stamp]
    }),
    true,
    'o turno fechou na fala; o selo veio depois e não pode esconder a cópia'
  )
  assert.equal(
    isGuiFinalAssistantMessage({
      ...base,
      items: [
        R14_FINAL_ASSISTANT,
        stamp,
        { id: 'note-mode', kind: 'note', text: 'modo de permissão: aceitar edições', at: 4 }
      ]
    }),
    true,
    'recibo pós-turno é da mesma classe do selo — nenhuma nota move o controle'
  )
  assert.equal(
    isGuiFinalAssistantMessage({ ...base, items: [stamp] }),
    false,
    'fio só de notas não inventa fechamento nenhum'
  )
})

test('o chamador pergunta pela régua: quem fecha o turno é a última fala NÃO-nota', async () => {
  const { guiCopyableAssistantId } = await import(
    '../src/renderer/src/guiMessageCopyPresentation.ts'
  )
  assert.equal(
    typeof guiCopyableAssistantId,
    'function',
    'achar o fechamento é parte da régua: procurar o fim cru no componente era o bug'
  )
  const stamp = { id: 'note-stamp', kind: 'note', text: '⏱ rodada: 4:12', at: 3 }
  const closed = {
    items: [
      { id: 'user-1', kind: 'user', text: 'Pergunta', at: 1 },
      R14_FINAL_ASSISTANT,
      stamp
    ],
    status: 'idle',
    stream: '',
    thinking: false,
    awaitingInteraction: false
  }

  assert.equal(guiCopyableAssistantId(closed), R14_FINAL_ASSISTANT.id)
  // O turno vivo continua sem cópia — a régua não afrouxou, só parou de se
  // perder no pós-escrito.
  assert.equal(guiCopyableAssistantId({ ...closed, status: 'working' }), null)
  assert.equal(guiCopyableAssistantId({ ...closed, stream: 'ainda escrevendo' }), null)
  assert.equal(guiCopyableAssistantId({ ...closed, thinking: true }), null)
  assert.equal(guiCopyableAssistantId({ ...closed, awaitingInteraction: true }), null)
  assert.equal(
    guiCopyableAssistantId({
      ...closed,
      items: [{ ...R14_FINAL_ASSISTANT, live: true, animateFrom: 0 }, stamp]
    }),
    null,
    'revelação incompleta ainda não é fechamento'
  )
  assert.equal(
    guiCopyableAssistantId({
      ...closed,
      items: [
        R14_FINAL_ASSISTANT,
        { id: 'tool-1', kind: 'tool', name: 'Read', summary: 'src/a.ts', at: 4 },
        stamp
      ]
    }),
    null,
    'com ferramenta depois da fala, quem fecha o fio não é ela'
  )

  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  assert.match(pane, /guiCopyableAssistantId\(\{/u, 'o componente consome a régua nomeada')
  assert.doesNotMatch(
    pane,
    /const lastItem = gui\.items\.at\(-1\)/u,
    'o guarda antigo do componente escondia a cópia sempre que o selo entrava atrás'
  )
})

/** A folha como regras { selectors, body } — comentários fora do seletor. */
function cssRules(css) {
  return [...css.matchAll(/([^{}]*)\{([^{}]*)\}/gu)].map((match) => ({
    selectors: match[1]
      .replace(/\/\*[\s\S]*?\*\//gu, ' ')
      .split(',')
      .map((one) => one.trim().replace(/\s+/gu, ' '))
      .filter(Boolean),
    body: match[2]
  }))
}

/** true quando ALGUMA regra do seletor pedido declara aquilo (o grupo pode
 *  ser reagrupado sem quebrar o teste; o que vale é a política em vigor). */
function cssDeclares(rules, selector, declaration) {
  return rules.some(
    (rule) => rule.selectors.includes(selector) && rule.body.includes(declaration)
  )
}

test('o fio é superfície de texto — e os controles dentro dele ficam fora da seleção', () => {
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')
  const rules = cssRules(css)
  assert.ok(rules.length > 100, 'a folha não foi lida como regras — o teste passaria sem olhar nada')

  assert.ok(
    cssDeclares(rules, '.gui-thread', 'user-select: text'),
    'sem isto o arrasto que começa num vão ancora em `none` e o Ctrl+C copia o nada'
  )
  for (const control of ['.gui-thread button', '.gui-thread summary']) {
    assert.ok(
      cssDeclares(rules, control, 'user-select: none'),
      `${control} precisa voltar a none — clicar num controle não pode pintar o rótulo`
    )
  }
  assert.ok(
    cssDeclares(rules, ".gui-thread [aria-hidden='true']", 'user-select: none'),
    'decoração (glifo, chevron, cursor do fluxo, calha do diff) não entra na cópia'
  )
  // A política do resto do app não muda: o desktop segue não-selecionável.
  assert.ok(
    cssDeclares(rules, 'body', 'user-select: none'),
    'a virada é do fio; soltar a seleção no app inteiro seria outra decisão'
  )
})

// ————— R21.2 — A TROCA DE CONTA NUNCA É BECO (print do dono, 2026-08-19) —————
//
// "não consigo trocar o site [a conta]: mouse em cima vira uma bolinha rodando
// eternamente." Eram DOIS becos somados: o `turnOpen` desabilitando o botão em
// todo turno longo e o `cursor: wait` do `:disabled` prometendo um fim que não
// vinha. O main (`missions:setChatSeat`) nunca teve guarda de ocupação: ele
// transplanta a conversa e mata as sessões vivas — quem trancava era o
// renderer.

test('trocar a conta no meio do turno é legítimo — e o :disabled não promete fim', () => {
  // 2026-09-08: a troca de conta mudou de casa — do cabeçalho do GuiPane para
  // o StageSeatChip da cabeça do palco (uma fileira). A regra é a mesma.
  const chip = readFileSync(
    new URL('../src/renderer/src/components/StageSeatChip.tsx', import.meta.url),
    'utf8'
  )
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')

  // O botão E cada item do menu de conta continuam clicáveis com turno aberto:
  // só a troca em voo desabilita.
  assert.ok(
    (chip.match(/disabled=\{changing \|\| locked\}/gu) ?? []).length >= 2,
    'botão e itens do menu de conta perderam as condições de voo (troca de conta/executor/anexo)'
  )
  assert.doesNotMatch(
    chip,
    /disabled=\{[^}]*turnOpen[^}]*\}/u,
    'turno aberto não pode mais desabilitar a troca de conta'
  )

  // O tip diz a VERDADE NOVA no meio do turno (o main mata a sessão e retoma a
  // MESMA conversa quando o CLI é o mesmo).
  assert.match(chip, /turnOpen\s*\?/u, 'o tip é derivado do turno')
  assert.match(
    chip,
    /Trocar interrompe o turno atual e retoma a MESMA conversa na conta nova \(mesmo CLI\)\./u
  )
  assert.match(chip, /Conta desta conversa\. Trocar mantém a conversa quando o CLI é o mesmo\./u)
  assert.match(chip, /data-tip=\{tip\}/u)

  // Cursor de espera é PROMESSA DE FIM; desabilitado é ESTADO. A opacidade
  // continua dizendo "não aceita clique agora".
  const disabledRule = css.match(/\.stage-seat-btn:disabled\s*\{[^}]*\}/su)?.[0] ?? ''
  assert.match(disabledRule, /opacity: 0\.62/u)
  assert.match(disabledRule, /cursor: default/u)
  assert.doesNotMatch(disabledRule, /cursor: wait/u, 'a bolinha eterna morre no :disabled')

  // E o único ocupado REAL da troca continua narrado por rótulo, não por cursor.
  assert.match(chip, /changing \? 'trocando conta…'/u)
})

// ————— R21.3 — UMA VOZ para o limite: a duplicata morre —————
//
// 2º print: "You've hit your session limit · resets 8:20pm" DUAS vezes no mesmo
// fio — linha de fala E card "falhou" —, em inglês cru. O card ganhou a voz da
// casa (com a receita) no motor; aqui morre a repetição.

test('a fala repetida do erro sai do fio e só o card com a receita fica', async () => {
  const { guiResultEchoesSpeech } = await import('../src/renderer/src/guiActivity.ts')

  const said = "You've hit your session limit · resets 8:20pm"
  assert.equal(guiResultEchoesSpeech(said, said), true)
  // Igualdade ESTRUTURAL: espaço em volta não conta; texto diferente não bate.
  assert.equal(guiResultEchoesSpeech(' mesma frase \n', 'mesma frase'), true)
  assert.equal(guiResultEchoesSpeech('a resposta do turno', said), false)
  assert.equal(guiResultEchoesSpeech(undefined, said), false)
  assert.equal(guiResultEchoesSpeech(said, undefined), false)
  assert.equal(guiResultEchoesSpeech('   ', '   '), false, 'fala vazia não duplica nada')

  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  const resultBranch = store.slice(
    store.indexOf("case 'result': {"),
    store.indexOf("case 'command-completed': {")
  )
  assert.match(
    resultBranch,
    /guiResultEchoesSpeech\(spoken\.text, evt\.resultText\)/u,
    'a comparação é com a PALAVRA FINAL do CLI, não com o texto já vestido'
  )
  assert.match(
    resultBranch,
    /spoken\?\.kind === 'assistant'/u,
    'só a última FALA pode ser a duplicata'
  )
  assert.match(
    resultBranch,
    /pushGuiItem\(echoed \? next\.items\.slice\(0, -1\) : next\.items/u,
    'só o card fica — é ele que carrega a receita'
  )
})

// ————— R21.4 — RODADA FANTASMA NÃO GANHA SELO —————
//
// Ainda no 2º print: `⏱ rodada: 0:00` carimbado em cima de results ENCADEADOS
// (o session-limit caindo instantâneo sobre o rejected). O selo de 0:00 é ruído
// que engana — "não colocou quanto tempo dura a rodada".

test('a rodada fantasma dos results encadeados não carimba; a de verdade carimba cheio', async () => {
  const { GUI_ROUND_MIN_ELAPSED_MS, guiRoundClosed, guiRoundEarnsStamp, guiRoundStampText, trackGuiRoundWork } =
    await import('../src/renderer/src/guiActivity.ts')

  // A SEQUÊNCIA DO PRINT, reproduzida evento a evento.
  // (1) A rodada de VERDADE: abre na mensagem do dono, trabalha, roda minutos.
  const realOpen = transitionGuiStartedAt(null, 'working', 100_000)
  let worked = trackGuiRoundWork(null, realOpen, false, true)
  assert.equal(worked, false, 'a rodada NASCE sem trabalho — o evento que a abriu não conta')
  worked = trackGuiRoundWork(realOpen, realOpen, worked, true) // fala do agente
  assert.equal(worked, true)
  worked = trackGuiRoundWork(realOpen, realOpen, worked, false) // espera pelo dono não apaga
  assert.equal(worked, true)
  const realClose = transitionGuiStartedAt(realOpen, 'idle', 352_000) // result rejeitado
  assert.equal(guiRoundClosed(realOpen, realClose, 'idle'), true)
  assert.equal(
    guiRoundEarnsStamp(352_000 - realOpen, worked),
    true,
    'O VERMELHO CENTRAL: a rodada dos minutos continua carimbando'
  )
  assert.match(guiRoundStampText(352_000 - realOpen), /^⏱ rodada: 4:12$/u)
  worked = trackGuiRoundWork(realOpen, realClose, worked, true)
  assert.equal(worked, false, 'fechou: o trabalho zera para a próxima rodada')

  // (2) A rodada FANTASMA: a fala do limite re-arma o relógio e o result
  // encadeado cai instantâneo em cima — nada foi produzido no meio.
  const ghostOpen = transitionGuiStartedAt(realClose, 'working', 352_010)
  worked = trackGuiRoundWork(realClose, ghostOpen, worked, true)
  assert.equal(ghostOpen, 352_010)
  assert.equal(worked, false)
  const ghostClose = transitionGuiStartedAt(ghostOpen, 'idle', 352_040)
  assert.equal(guiRoundClosed(ghostOpen, ghostClose, 'idle'), true, 'a rodada fecha…')
  assert.equal(
    guiRoundEarnsStamp(352_040 - ghostOpen, worked),
    false,
    '…mas 30ms sem trabalho nenhum não ganha selo'
  )

  // O piso: rodada sem item novo mas com tempo mensurável ainda é rodada.
  assert.equal(guiRoundEarnsStamp(GUI_ROUND_MIN_ELAPSED_MS, false), true)
  assert.equal(guiRoundEarnsStamp(GUI_ROUND_MIN_ELAPSED_MS - 1, false), false)
  assert.equal(guiRoundEarnsStamp(0, true), true, 'trabalhou é rodada, mesmo curta')

  // E o store consome as réguas nomeadas — nunca uma cópia inline.
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  assert.match(store, /guiRoundEarnsStamp\(/u, 'o applyGuiEvent decide o selo pelo módulo puro')
  assert.match(store, /trackGuiRoundWork\(/u, 'o trabalho da rodada tem fonte única')
  assert.match(store, /roundWorked: boolean/u, 'o trabalho da rodada é estado do pane')
})

// BUG DO PASTE (vídeo do dono, 2026-08-20 11:55): colar um erro de terminal no
// composer "explodia tudo" — o transform na PRÓPRIA caixa do overlay de menções
// empurrava a camada clipada para CIMA do fio sempre que o textarea tinha
// scroll interno (paste grande no teto de 300px), pintando o texto colado por
// cima da conversa; e o texto transparente do modo menções ficava INVISÍVEL no
// composer — só as ondinhas do corretor apareciam. A caixa NUNCA se move: o
// espelho do scroll é o scrollTop/scrollLeft do próprio box clipado.
test('paste grande não desloca o overlay de menções: a caixa fica, o conteúdo rola', () => {
  const overlay = { scrollTop: 0, scrollLeft: 0, style: { transform: '' } }
  syncInputOverlayScroll({ scrollTop: 480, scrollLeft: 0 }, overlay)
  assert.equal(overlay.scrollTop, 480, 'o conteúdo rola pelo scroll do box')
  assert.equal(overlay.scrollLeft, 0)
  assert.equal(overlay.style.transform, '', 'a caixa clipada NUNCA sai do lugar')

  const overlaySource = readFileSync(
    new URL('../src/renderer/src/components/GuiMentionOverlay.tsx', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(
    overlaySource,
    /translate\(/u,
    'nenhum transform posicional no componente do overlay'
  )

  // Terminal colado não é redação: o corretor não rabisca o composer (os
  // outros inputs do app já desligam o spellcheck; o chat recebe código).
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  assert.match(pane, /spellCheck=\{false\}/u, 'composer sem corretor ortográfico')
})

// R24 — HISTÓRICO COMPLETO. O anel do pane poda por espaço e o fio remontado
// nascia cortado em silêncio ("subo, subo, e acaba"). A linha-verdade do topo
// diz que houve mais antes e abre o LEITOR pelo mesmo GuiHistoryTarget da
// paleta; a leitura pagina por faixa de bytes, sem tocar nos tetos do anel.
test('R24.1 — a linha-verdade do topo só existe com poda e nomeia a receita', () => {
  assert.equal(guiPrunedEvicted({ type: 'history-pruned', evicted: 12 }), 12)
  assert.equal(guiPrunedEvicted({ type: 'history-pruned', evicted: 0 }), null)
  assert.equal(guiPrunedEvicted({ type: 'history-pruned', evicted: -3 }), null)
  assert.equal(guiPrunedEvicted({ type: 'history-pruned', evicted: '12' }), null)
  assert.equal(guiPrunedEvicted({ type: 'history-pruned' }), null)
  assert.equal(guiPrunedEvicted({ type: 'text', text: 'oi' }), null)

  assert.match(guiPrunedNoticeText(12), /começo desta conversa saiu da tela/u)
  assert.match(guiPrunedNoticeText(12), /12 eventos antigos/u)
  assert.match(guiPrunedNoticeText(1), /1 evento antigo/u, 'singular não vira "1 eventos"')

  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  const mirror = readFileSync(new URL('../src/renderer/src/guiApi.ts', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')

  // Espelho declarado main↔renderer do evento sintético.
  assert.match(mirror, /type: 'history-pruned'; evicted: number/u)
  assert.match(store, /prunedEvents: number/u)
  assert.match(store, /prunedEvents: 0/u, 'o pane vazio nasce sem poda')
  assert.match(store, /case 'history-pruned':/u)
  // A linha aparece SÓ com poda — e o pane somente-leitura também a mostra.
  assert.match(pane, /gui\.prunedEvents > 0 &&/u)
  assert.match(pane, /guiPrunedNoticeText\(gui\.prunedEvents\)/u)
  assert.match(pane, /ver conversa completa/u)
  assert.match(css, /\.gui-thread-pruned\b/u)
})

test('R24.3 — a paginação junta páginas sem duplicar e pede a faixa pelo cursor', () => {
  const page = (id, cursor, text) => ({ id, cursor, role: 'user', text })
  const current = [page('b', 200, 'b'), page('c', 300, 'c')]
  const older = [page('a', 100, 'a'), page('b', 200, 'b')]
  assert.deepEqual(
    mergeGuiHistoryPage(current, older).map((message) => message.id),
    ['a', 'b', 'c'],
    'dedupe por id+cursor e ordem pelo cursor (offset de byte da linha)'
  )
  // Mesma id em cursor diferente é outra linha do arquivo: as duas ficam.
  assert.equal(mergeGuiHistoryPage(current, [page('c', 350, 'c bis')]).length, 3)
  assert.equal(mergeGuiHistoryPage([], []).length, 0)

  assert.deepEqual(guiHistoryPageRequest(current, 'before'), { before: 200 })
  assert.deepEqual(guiHistoryPageRequest(current, 'after'), { after: 300 })
  assert.equal(guiHistoryPageRequest([], 'before'), null, 'sem fala não há faixa a pedir')

  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  assert.match(preload, /loadForPane:/u)
  assert.match(store, /appendGuiHistoryPage:/u)
  assert.match(store, /hasMoreBefore\?: boolean/u)
  // O leitor abre pelo MESMO alvo da paleta — nenhum overlay novo.
  assert.match(pane, /showGuiHistoryTarget\(/u)
  assert.match(pane, /carregar mais antigas/u)
  assert.match(pane, /carregar mais novas/u)
})

// ————— R25.1 — O ODÔMETRO ATRAVESSA O ESPELHO (main → renderer) —————
//
// O acumulado é do MAIN de propósito (o renderer remonta a cada troca de aba).
// Aqui fica preso o contrato do outro lado: o evento sticky de context-usage
// carrega o total, o redutor o guarda, e nem a remontagem nem uma fotografia
// sem odômetro (motor sem parcelas) apagam o que já foi medido.

test('R25.1 — o espelho do context-usage carrega o odômetro da conversa', () => {
  const guiApi = readFileSync(new URL('../src/renderer/src/guiApi.ts', import.meta.url), 'utf8')
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')

  // ESPELHO DECLARADO do union do main (maestroSession.ts).
  assert.match(guiApi, /convCalls\?: number/u)
  assert.match(guiApi, /convWeightTokens\?: number/u)
  // A PARCELA de cada chamada é transporte motor→main e não atravessa o IPC:
  // ao renderer vai o TOTAL, que é o que a tela mostra.
  assert.doesNotMatch(guiApi, /inputTokens\?: number/u)

  assert.match(store, /convCalls: number \| null/u)
  assert.match(store, /convWeightTokens: number \| null/u)
  const empty = store.slice(store.indexOf('export const EMPTY_GUI_PANE'))
  assert.match(empty.slice(0, 1200), /convCalls: null/u)
  assert.match(empty.slice(0, 1200), /convWeightTokens: null/u)

  // O redutor NUNCA anda para trás: fotografia sem odômetro (o `null/null` da
  // compactação, um motor sem parcelas) conserva o total já contado.
  const reducer = store.slice(store.indexOf("case 'context-usage':"))
  assert.match(reducer.slice(0, 700), /convCalls: evt\.convCalls \?\? state\.convCalls/u)
  assert.match(
    reducer.slice(0, 700),
    /convWeightTokens: evt\.convWeightTokens \?\? state\.convWeightTokens/u
  )

  // Geração NOVA (restart sem a fotografia da mesma conversa) zera junto com o
  // medidor — odômetro de outra conversa na tela seria mentira.
  const restart = store.slice(store.indexOf("case 'session-restarted':"))
  assert.match(restart.slice(0, 2600), /convCalls: quiet \? state\.convCalls : null/u)
  assert.match(restart.slice(0, 2600), /convWeightTokens: quiet \? state\.convWeightTokens : null/u)
})

// R27 — RELEASE É RELEASE no host das conversas: o Board continua hospedando o
// pane (desmontar mataria a conversa — o Board é o host vivo por design), mas
// o registro de release SOME das superfícies de missão (coluna, retrato) e o
// trilho de missão (fila/arquivar/entrega — os botões sem nexo do incidente)
// dá lugar ao cabeçalho próprio do release.
test('R27 — o board não lista o registro de release e o trilho vira release', () => {
  const board = readFileSync(
    new URL('../src/renderer/src/components/Board.tsx', import.meta.url),
    'utf8'
  )
  assert.match(board, /isReleaseMissionRecord/u, 'a régua única chega ao board')
  assert.match(
    board,
    /surfaceMissions = liveMissions\.filter\(\(m\) => !isReleaseMissionRecord\(m\)\)/u,
    'a coluna e o retrato listam só missões de superfície'
  )
  // Onda B do RIGHTDOCK (2026-08-22): o trilho próprio virou componente
  // (`ReleaseRail`, vestindo a moldura do dock). O destino é o escolhido na
  // versão; não pode ser uma promessa fixa de main enquanto o motor usa dev.
  assert.match(board, /<ReleaseRail/u, 'o release tem trilho próprio')
  const releaseRail = readFileSync(
    new URL('../src/renderer/src/components/ReleaseRail.tsx', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(releaseRail, /dev → main/u)
  assert.match(releaseRail, /targetBranch \?\? 'destino no chat'/u)
  const railGate = board.indexOf('selIsRelease')
  assert.ok(railGate > 0, 'o trilho de missão é condicionado ao registro não ser release')
})

// R27 (conserto pós-estreia): o ✦ de ativas do cabeçalho e o retrato por
// versão contavam o registro do release como missão. O retrato recebe SÓ
// missões de superfície — a régua é a mesma das listas, aplicada na fonte.
test('R27 — o retrato do projeto não conta o registro do release', () => {
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  const stats = store.slice(store.indexOf('loadHomeStats: async'))
  assert.match(
    stats.slice(0, 900),
    /surface = missions\.filter\(\(m\) => !isReleaseMissionRecord\(m\)\)/u,
    'a régua entra na fonte do retrato'
  )
  assert.match(stats.slice(0, 900), /versionPortrait\(versions, surface\)/u)
  assert.match(stats.slice(0, 1200), /missoesAtivas: surface\.filter/u)
})

// R27 (conserto pós-estreia, parte 2): o QUADRO DE ROTA ainda mostrava o
// registro do release como card RODANDO e o contava no "N/M integradas" — o
// 8/9 que o dono viu no mapa. A mesma régua, na fonte da grade.
test('R27 — o quadro de rota não conta nem mostra o registro do release', () => {
  const route = readFileSync(
    new URL('../src/renderer/src/components/MissionRouteBoard.tsx', import.meta.url),
    'utf8'
  )
  assert.match(route, /isReleaseMissionRecord/u, 'a régua única chega ao quadro de rota')
  const mine = route.slice(route.indexOf('const mine = useMemo'))
  assert.match(
    mine.slice(0, 600),
    /!isReleaseMissionRecord\(m\)/u,
    'a grade parte só de missões de superfície'
  )
})

// A MISSÃO DE PLANEJAMENTO NÃO É "SEM VERSÃO" (foto do dono, 2026-08-30): ela
// fica fora de versão por régua de nascimento (escreve plano/ e nunca integra),
// mas o quadro a jogava na linha "sem versão" — e, viva, dentro da versão
// CORRENTE ("é nela que ela vai integrar", falso aqui). Linha própria com
// vocabulário próprio: planejamento CONCLUI, não integra.
test('o quadro de rota dá linha própria ao planejamento — nunca "sem versão"', () => {
  const route = readFileSync(
    new URL('../src/renderer/src/components/MissionRouteBoard.tsx', import.meta.url),
    'utf8'
  )
  assert.match(route, /__planejamento__/u, 'a linha própria do planejamento existe')
  const rows = route.slice(route.indexOf('const rows = useMemo'))
  assert.match(
    rows.slice(0, 2000),
    /missionTypeOf\(m\) === 'planejamento'/u,
    'planejamento é roteado ANTES da régua de versão (corrente/sem versão)'
  )
  assert.match(
    route,
    /row\.planning \? 'concluídas' : 'integradas'/u,
    'a contagem da linha de planejamento fala "concluídas"'
  )
  assert.match(
    route,
    /=== 'planejamento' \? 'concluída' : 'integrada'/u,
    'a ficha encerrada de planejamento diz "concluída", nunca "integrada"'
  )
})

// O CARET NUMA LINHA, A EDIÇÃO NA OUTRA (bug do dono, 2026-08-21, em vídeo):
// com menção ativa o textarea fica transparente e quem pinta o texto é o
// overlay — mas o overlay quebrava linha com `overflow-wrap: anywhere`
// enquanto o textarea usa o padrão de textarea (`break-word`). Palavra longa
// ("image.png") quebrava NO MEIO no overlay e inteira no textarea: dali para
// baixo o texto pintado ficava UMA linha fora do texto real — clique na linha
// que se vê, edição na linha de baixo. A política de quebra é UMA, declarada
// nos DOIS lados do espelho.
test('composer e overlay de menções quebram linha com a MESMA política', () => {
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')
  const ruleOf = (selector) => {
    const start = css.indexOf(`\n${selector} {`)
    assert.notEqual(start, -1, `regra ${selector} sumiu do global.css`)
    return css.slice(start, css.indexOf('}', start))
  }
  const overlay = ruleOf('.gui-mention-overlay')
  const input = ruleOf('.gui-input')
  assert.match(overlay, /overflow-wrap: break-word/u, 'o overlay quebra como textarea quebra')
  assert.doesNotMatch(overlay, /overflow-wrap: anywhere/u, 'anywhere diverge do textarea e desloca o texto pintado')
  assert.match(input, /overflow-wrap: break-word/u, 'o lado do textarea declara a mesma política (espelho declarado)')
})

// O CARET COLADO NA PALAVRA (bug do dono, 2026-08-21, segundo ato): Shift+Enter
// no FIM do rascunho cria a linha em que o caret mora — mas um div pre-wrap
// NÃO renderiza a linha vazia depois do \n final (o textarea renderiza). O
// conteúdo pintado fica uma linha mais curto, o espelho de scroll trava no
// teto menor e o texto pintado fica uma linha atrás do real. A sentinela de
// largura zero no fim materializa a última linha — o truque padrão
// de todo espelho de textarea.
// A geometria de quando usar a sentinela é verificada no browser em
// test-gui-composer-layout; aqui a regra é não esconder caracteres no fonte.
test('o overlay mantém a sentinela de última linha escapada no fonte', () => {
  const overlay = readFileSync(
    new URL('../src/renderer/src/components/GuiMentionOverlay.tsx', import.meta.url),
    'utf8'
  )
  assert.match(
    overlay,
    /'\\u200b'/u,
    'a sentinela de largura zero existe no fim do conteúdo pintado - ESCAPADA (caractere invisível cru em fonte é a armadilha do r24 §7)'
  )
})

// ————— R33: CITAÇÃO DO FIO — selecionar → botão direito → anexar à resposta —————
//
// Pedido do dono (23/08, verbatim): "eu seleciono essa parte da conversa como
// um anexo mesmo na parte do chat ali do input, e aí eu falo sobre essa parte
// que ele falou". A metade pura (clipar/rotular/compor) testa aqui; a fiação
// (menu, chips, grid) é conferida no fonte — a lição R13 (área nomeada no
// grid do composer) vira asserção permanente.

const { GUI_QUOTE_MAX_CHARS, GUI_QUOTE_PROMPT_TAG, guiQuoteChipLabel, guiQuoteFromSelection, guiQuotedPrompt } =
  await import('../src/renderer/src/guiThreadQuote.ts')

test('R33 — a seleção vira citação: apara, recusa vazio e clipa estouro COM reticência', () => {
  assert.equal(guiQuoteFromSelection('  um trecho do fio  '), 'um trecho do fio')
  assert.equal(guiQuoteFromSelection('   '), null)
  assert.equal(guiQuoteFromSelection(null), null)
  const long = 'x'.repeat(GUI_QUOTE_MAX_CHARS + 50)
  const clipped = guiQuoteFromSelection(long)
  assert.equal(clipped.length, GUI_QUOTE_MAX_CHARS + 1, 'clipa no teto')
  assert.ok(clipped.endsWith('…'), 'o corte aparece — nunca é mudo')
})

test('R33 — o rótulo do chip é a primeira linha útil, clipada', () => {
  assert.equal(guiQuoteChipLabel('\n\n  linha útil\nsegunda'), 'linha útil')
  const label = guiQuoteChipLabel('a'.repeat(200))
  assert.ok(label.length <= 49 && label.endsWith('…'))
})

test('R33 — o prompt composto: bloco da casa na frente, mensagem verbatim atrás', () => {
  assert.equal(guiQuotedPrompt([], 'oi'), 'oi', 'sem citação a mensagem passa byte a byte')
  const prompt = guiQuotedPrompt(['linha um\nlinha dois'], 'o que você quis dizer aqui?')
  assert.ok(prompt.startsWith(GUI_QUOTE_PROMPT_TAG), 'a marca da casa abre o bloco')
  assert.match(prompt, /> linha um\n> linha dois/u, 'a citação vira blockquote linha a linha')
  assert.ok(prompt.endsWith('\n\no que você quis dizer aqui?'), 'a mensagem fecha, verbatim')
  const two = guiQuotedPrompt(['a', 'b'], 'msg')
  assert.equal(two.split(GUI_QUOTE_PROMPT_TAG).length, 3, 'cada citação ganha o próprio bloco')
  assert.equal(guiQuotedPrompt(['só citação'], ''), `${GUI_QUOTE_PROMPT_TAG}\n> só citação`)
})

test('R33 — a fiação existe: menu no fio, chips com área nomeada, envio composto', () => {
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const menu = readFileSync(
    new URL('../src/renderer/src/components/GuiSelectionMenu.tsx', import.meta.url),
    'utf8'
  )
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')
  assert.match(pane, /onContextMenu=\{onThreadContextMenu\}/u, 'o fio não escuta o botão direito')
  assert.match(pane, /guiQuotedPrompt\(quotes, message\)/u, 'o envio não compõe as citações')
  assert.match(
    pane,
    /message\.startsWith\('\/'\) \? message : guiQuotedPrompt/u,
    'slash cru não pode carregar citação'
  )
  assert.match(pane, /if \(sent\) setQuotes\(\[\]\)/u, 'envio ok tem de limpar os chips')
  // O menu é ESPELHO do de arquivo: mesmas classes, teclado inteiro.
  assert.match(menu, /file-context-menu gui-selection-menu/u)
  assert.match(menu, /anexar à resposta/u)
  assert.match(menu, /Escape/u)
  // A grade agora é a mesma em todas as larguras; citações seguem nomeadas.
  assert.match(css, /\.gui-composer-quotes \{\r?\n  grid-area: quotes;/u)
  const quoteAreas = css.match(/"quotes(?: quotes){6,7}"/gu) ?? []
  assert.equal(quoteAreas.length, 2, 'a grade compartilhada declara quotes com e sem anexos')
})

// ————— R34: a seleção NÃO briga com o fio —————
//
// Três queixas do dono (23/08, no teste ao vivo da R33): a pintura azul do
// Chromium ("nada a ver com o app"), o arrasto que "começa de baixo pra cima
// aí buga e vem de cima pra baixo" (o acompanhamento do fim movia o conteúdo
// debaixo do ponteiro e invertia a âncora), e o streaming quebrando a
// seleção (a janela avançava e desmontava os nós selecionados). E: sem
// tooltip nas seleções.

test('R34 — o freio da seleção: scroll e janela param enquanto o dono seleciona', () => {
  const hook = readFileSync(
    new URL('../src/renderer/src/useGuiTranscriptWindow.ts', import.meta.url),
    'utf8'
  )
  assert.match(hook, /selectionchange/u, 'o hook não observa a seleção')
  assert.match(
    hook,
    /if \(!pinnedRef\.current \|\| selectionHoldRef\.current\) return/u,
    'o keepPinnedToEnd não respeita o freio'
  )
  assert.match(
    hook,
    /pendingAnchorRef\.current \|\| !pinnedRef\.current \|\| selectionHoldRef\.current\) return/u,
    'o efeito de append ainda puxa o scroll com seleção viva'
  )
  assert.match(
    hook,
    /!selectionHoldRef\.current &&\r?\n\s*currentStart/u,
    'a janela avança por baixo da seleção e desmonta os nós selecionados'
  )
  // O freio solta sozinho: arrasto encerrado E seleção colapsada.
  assert.match(hook, /selectionDragRef\.current \|\| inLog/u)
})

test('R34 — a pintura da seleção é da casa e a margem do fio aceita o arrasto', () => {
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')
  assert.match(
    css,
    /::selection \{\r?\n  background: color-mix\(in srgb, var\(--accent\) 30%, transparent\);\r?\n\}/u,
    'o azul default do Chromium continua pintando a seleção'
  )
  assert.match(
    css,
    /\.gui-log \{[\s\S]{0,700}?user-select: text;\r?\n\}/u,
    'o vão em volta do fio ainda mata o arrasto que começa na margem'
  )
})

test('R34 — sem tooltip nas seleções, e o ❝ consome a seleção pintada', () => {
  const menu = readFileSync(
    new URL('../src/renderer/src/components/GuiSelectionMenu.tsx', import.meta.url),
    'utf8'
  )
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(menu, /data-tip/u, 'o menu da seleção voltou a ter tooltip (ordem do dono)')
  assert.doesNotMatch(
    pane,
    /className="gui-quote-chip"\s+title=/u,
    'o chip de citação voltou a ter tooltip'
  )
  assert.match(
    pane,
    /window\.getSelection\(\)\?\.removeAllRanges\(\)/u,
    'anexar não consome a seleção — ela seguraria o freio do scroll para sempre'
  )
})

// ————— R35: DOM ESTÁVEL NO STREAMING — a seleção sobrevive à máquina de escrever —————
//
// A R34 segurou o SCROLL; faltava o DOM. `GuiStreamText` re-renderiza o
// `GuiMarkdown` a cada tick e o markdown era pintado por
// `dangerouslySetInnerHTML`: string nova ⇒ innerHTML inteiro trocado ⇒ todo nó
// da mensagem em streaming destruído e recriado várias vezes por segundo. A
// seleção do dono morria no tick seguinte ao mouseup. Agora a decisão é uma
// função PURA (o prefixo de filhos de topo que não pode ser tocado) e o efeito
// só aplica.
//
// As chaves do plano carregam a espécie do nó (`e:` elemento, `t:` texto) —
// sondado no pipeline real: `marked` separa os blocos com "\n" e esses viram
// Text nodes IRMÃOS dos `<p>`/`<pre>` no topo. Comparar só elementos
// desalinharia os índices.

const { guiStablePrefixPlan } = await import('../src/renderer/src/guiStableMarkdownPatch.ts')

test('R35 — html idêntico não toca em nada: o prefixo é a lista inteira', () => {
  const frame = ['e:<p>Olá</p>', 't:\n', 'e:<pre><code>x</code></pre>', 't:\n']
  assert.deepEqual(guiStablePrefixPlan(frame, [...frame]), { keep: 4 })
  assert.deepEqual(guiStablePrefixPlan([], []), { keep: 0 }, 'mensagem vazia não inventa filho')
})

test('R35 — dois quadros seguidos do streaming: só o último bloco é volátil', () => {
  // O que o pipeline entrega entre dois ticks: os blocos fechados saem byte a
  // byte iguais e só a última palavra cresce.
  const antes = ['e:<h1>Título</h1>', 't:\n', 'e:<p>uma frase</p>', 't:\n', 'e:<p>o come</p>', 't:\n']
  const depois = ['e:<h1>Título</h1>', 't:\n', 'e:<p>uma frase</p>', 't:\n', 'e:<p>o começo da</p>', 't:\n']
  assert.deepEqual(
    guiStablePrefixPlan(antes, depois),
    { keep: 4 },
    'os quatro filhos já escritos têm de ficar INTACTOS — é neles que a seleção vive'
  )
})

test('R35 — cauda que cresce: bloco novo só APÊNDA, o que já existia fica', () => {
  const antes = ['e:<p>um</p>', 't:\n']
  const depois = ['e:<p>um</p>', 't:\n', 'e:<p>dois</p>', 't:\n']
  assert.deepEqual(guiStablePrefixPlan(antes, depois), { keep: 2 }, 'o velho é prefixo do novo')
})

test('R35 — diferença na primeira posição zera o prefixo (mensagem outra)', () => {
  assert.deepEqual(
    guiStablePrefixPlan(['e:<p>um</p>', 't:\n'], ['e:<p>outro</p>', 't:\n']),
    { keep: 0 },
    'nada a preservar quando o primeiro filho já mudou'
  )
})

test('R35 — html que ENCOLHE mantém o prefixo comum e o resto é removido', () => {
  const antes = ['e:<p>um</p>', 't:\n', 'e:<p>dois</p>', 't:\n', 'e:<p>três</p>']
  const depois = ['e:<p>um</p>', 't:\n']
  assert.deepEqual(guiStablePrefixPlan(antes, depois), { keep: 2 })
  assert.deepEqual(guiStablePrefixPlan(antes, []), { keep: 0 }, 'esvaziar remove tudo')
})

test('R35 — a espécie do nó importa: texto "<p>x</p>" nunca casa com o elemento', () => {
  assert.deepEqual(
    guiStablePrefixPlan(['t:<p>x</p>'], ['e:<p>x</p>']),
    { keep: 0 },
    'sem discriminador, um texto escapado casaria com um elemento e o patch removeria o nó errado'
  )
})

test('R35 — o GuiMarkdown pinta por patch, não por dangerouslySetInnerHTML', () => {
  const md = readFileSync(
    new URL('../src/renderer/src/components/GuiMarkdown.tsx', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(
    md,
    /dangerouslySetInnerHTML=/u,
    'o innerHTML inteiro voltou a ser trocado a cada tick — a seleção morre de novo'
  )
  assert.match(md, /applyGuiStableMarkdown\(container, html\)/u, 'o aplicador do patch não é chamado')
  assert.match(md, /useLayoutEffect/u, 'efeito comum pintaria depois do quadro: a mensagem piscaria vazia')
  assert.match(
    md,
    /<div className="gui-md-content" ref=\{contentRef\} \/>/u,
    'o container do conteúdo precisa ficar SEM filhos declarados (React não pode reconciliar esta subárvore)'
  )
  // O contrato que não pode regredir junto: sanitização e delegação seguem
  // exatamente onde estavam.
  assert.match(md, /DOMPurify\.sanitize\(fileLinks\.html, \{/u, 'a sanitização saiu do caminho')
  assert.match(md, /onClickCapture=\{handleLinkOpenAttempt\}/u, 'a delegação do wrapper sumiu')
  assert.match(md, /aria-live="polite"/u, 'o status do link externo sumiu')
})

// ————— R36: A ENTREGA VISUAL APARECE NO CHAT —————
//
// Caso do dono (print do pane codex): o dev prometeu "demonstração visual", o
// dono perguntou "cadê?" e o modelo jurou que a imagem estava "exibida
// diretamente acima". O `![demo](caminho.png)` ATRAVESSA o sanitizador (img/src
// estão nas listas), mas o CSP do renderer é `img-src 'self' data:` — caminho
// de worktree não é nem 'self' nem data: e a requisição morre MUDA.
//
// A transformação abaixo tira o `src` condenado do caminho do browser e o
// guarda como DADO; a hidratação do GuiMarkdown troca isso pela data URL que o
// main produz dentro do cwd do pane. As três propriedades que os testes
// seguram: (1) caminho local vira placeholder sem src, (2) data:/https passam
// intocadas, (3) DETERMINISMO byte a byte — é ele que deixa o patch de prefixo
// da R35 reconhecer os blocos já escritos durante o streaming.

const {
  decodeGuiAttributeValue,
  isGuiInlineImagePassthrough,
  rewriteGuiInlineImages
} = await import('../src/renderer/src/guiInlineImageHtml.ts')

test('R36 — imagem de caminho local vira placeholder: sem src, referência no data-attr, alt intacto', () => {
  const saida = rewriteGuiInlineImages('<p><img src=".synkora/demo.png" alt="a demo"></p>')
  assert.doesNotMatch(
    saida,
    /\ssrc=/u,
    'sobrou um src de caminho local: o CSP quebra a requisição EM SILÊNCIO e o dono não vê nada'
  )
  assert.match(saida, /data-gui-image="\.synkora\/demo\.png"/u, 'a referência precisa sobreviver para a hidratação')
  assert.match(saida, /alt="a demo"/u, 'o alt do agente é o que o leitor de tela lê — não pode sumir')
  assert.match(saida, /class="gui-md-image"/u, 'sem a classe, a moldura da casa não pega')
  assert.match(
    saida,
    /<button type="button" class="gui-md-image-open" data-gui-image-open="\.synkora\/demo\.png"/u,
    'a imagem é um GESTO (abre "onde abrir"): sem o invólucro de botão, o teclado fica de fora'
  )
  assert.ok(
    saida.startsWith('<p><button ') && saida.endsWith('</button></p>'),
    'o que está em volta da imagem não pode ser remontado'
  )
})

test('R36 — caminho absoluto do Windows e src="" também saem do caminho do browser', () => {
  const windows = rewriteGuiInlineImages('<img src="C:\\Users\\Erick\\shot.png">')
  assert.match(windows, /data-gui-image="C:\\Users\\Erick\\shot\.png"/u)
  assert.doesNotMatch(windows, /\ssrc=/u)
  // src vazio resolveria para a PRÓPRIA página: some o atributo, some a
  // requisição — e não há referência nenhuma a hidratar.
  assert.match(rewriteGuiInlineImages('<img src="" alt="x">'), /Imagem indisponível/u)
})

test('R36 — bitmap data: usa cartão; HTTPS não ganha carregamento direto', () => {
  const dataUrl = '<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="print"></p>'
  assert.match(rewriteGuiInlineImages(dataUrl), /aria-haspopup="dialog"/u)
  const remota = '<p><img src="https://exemplo.test/a.png" alt="remota"></p>'
  assert.doesNotMatch(rewriteGuiInlineImages(remota), /\ssrc=/u, 'HTTPS permanece bloqueado, com estado explícito na hidratação')
  assert.equal(isGuiInlineImagePassthrough('DATA:image/png;base64,x'), true, 'o esquema não é sensível a caixa')
  assert.equal(
    isGuiInlineImagePassthrough('http://exemplo.test/a.png'),
    false,
    'http puro não pinta sob o CSP e nem é https: vira placeholder e a recusa fala'
  )
})

test('R36 — determinismo e idempotência: mesma entrada ⇒ mesmos bytes', () => {
  const html = '<h1>t</h1>\n<p>antes</p>\n<p><img src="fig/a.png" alt="x"></p>\n'
  const um = rewriteGuiInlineImages(html)
  const dois = rewriteGuiInlineImages(html)
  assert.equal(um, dois, 'saída instável faria o patch da R35 remontar bloco já escrito a cada tick')
  assert.ok(
    um.startsWith('<h1>t</h1>\n<p>antes</p>\n'),
    'o que não é <img> tem de sair IDÊNTICO — é isso que segura o prefixo estável'
  )
  assert.equal(um, rewriteGuiInlineImages(um), 'reprocessar o próprio resultado não pode mudar mais nada')
  assert.equal(rewriteGuiInlineImages('<p>sem imagem</p>'), '<p>sem imagem</p>')
})

test('R36 — o scanner não se perde: alt com ">" e com "<img>" literal dentro', () => {
  // O serializador de HTML NÃO escapa `<`/`>` dentro de valor de atributo: uma
  // regex ingênua sobre `<img[^>]*>` fecharia a tag no meio do alt e remontaria
  // a mensagem errada.
  const saida = rewriteGuiInlineImages('<p><img src="fig.png" alt="a > b <img src=nao.png>"><em>fim</em></p>')
  assert.equal(
    (saida.match(/data-gui-image=/gu) ?? []).length,
    1,
    'o <img> escrito DENTRO do alt não é uma imagem — reescrevê-lo é corromper a mensagem'
  )
  assert.match(saida, /alt="a > b <img src=nao\.png>"/u, 'o alt tem de sair verbatim')
  assert.ok(saida.endsWith('<em>fim</em></p>'), 'a cauda depois da imagem não pode ser engolida')
})

test('R36 — tag truncada pelo streaming não corrompe nada', () => {
  // No meio do tick o html pode terminar dentro de uma tag; a transformação
  // copia o que não entende em vez de reinterpretar.
  const meio = '<p>texto <img src="a.png'
  assert.equal(rewriteGuiInlineImages(meio), meio)
  assert.equal(rewriteGuiInlineImages('<p>3 < 4 e img < b</p>'), '<p>3 < 4 e img < b</p>')
})

test('R36 — a referência é DECODIFICADA para decidir e reescapada para o atributo', () => {
  const saida = rewriteGuiInlineImages('<img src="dir/a&amp;b.png" alt="e">')
  assert.match(saida, /data-gui-image="dir\/a&amp;b\.png"/u, 'o valor precisa continuar escapado dentro do atributo')
  assert.equal(decodeGuiAttributeValue('dir/a&amp;b.png'), 'dir/a&b.png', 'é ISSO que a hidratação manda ao main')
  assert.equal(decodeGuiAttributeValue('a&naoexiste;b'), 'a&naoexiste;b', 'entidade desconhecida fica verbatim')
})

test('R36.4 — a entrega vira clique: .htm/.html e as imagens são tokens do fio', () => {
  for (const nome of [
    'demo.htm',
    'demo.html',
    'shot.png',
    'shot.jpg',
    'shot.jpeg',
    'shot.gif',
    'shot.webp',
    'icone.svg'
  ]) {
    assert.deepEqual(
      findGuiFileTokens(`abri o ${nome} pra você`).map((token) => token.value),
      [nome],
      `${nome} precisa virar token clicável — entrega que não abre com um clique não foi entregue`
    )
  }
})

test('R36 — a fiação do renderer: pipeline, cache de hidratação e o guard da ponte', () => {
  const md = readFileSync(
    new URL('../src/renderer/src/components/GuiMarkdown.tsx', import.meta.url),
    'utf8'
  )
  const api = readFileSync(new URL('../src/renderer/src/guiApi.ts', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')

  assert.match(
    md,
    /rewriteGuiInlineImages\(linkifyGuiFileReferences\(routeChatLinksExternally\(sanitized, fileLinks\.references\)\)\)/u,
    'a reescrita saiu do pipeline (ou entrou fora de ordem): a imagem volta a quebrar muda'
  )
  assert.match(
    md,
    /imageCacheRef = useRef<Map<string, GuiInlineImageState>>/u,
    'sem cache por referência, cada tick do streaming pediria a MESMA imagem de novo ao main'
  )
  assert.match(md, /hydrateGuiInlineImages\(container, imageCacheRef\.current\)/u, 'a hidratação não é aplicada')
  assert.match(
    md,
    /useLayoutEffect[\s\S]{0,1400}?paintInlineImages\(\)/u,
    'a pintura do cache tem de acontecer no efeito de LAYOUT, junto com o patch — em efeito comum a imagem pisca'
  )
  assert.match(md, /guiApi\.fileImageData\(paneId, reference\)/u, 'ninguém chama o canal do main')
  assert.match(
    api,
    /if \(!api\?\.fileImageData\) \{/u,
    'o guard de ponte ausente sumiu: sem ele a janela sem canal volta a falhar em silêncio'
  )
  assert.match(
    api,
    /reinicie o app \(npm run dev\)[^']*canal de imagem/u,
    'recusa sem RECEITA é beco sem saída (regra da casa)'
  )
  assert.match(css, /\.gui-md-image \{/u, 'a moldura da casa não existe no CSS')
  assert.match(css, /\.gui-md-image-fail \{/u, 'a linha de recusa não existe no CSS')
})

test('R36 — clique/teclado ampliam a imagem; menu contextual e receita continuam disponíveis', () => {
  const md = readFileSync(
    new URL('../src/renderer/src/components/GuiMarkdown.tsx', import.meta.url),
    'utf8'
  )
  const modulo = readFileSync(
    new URL('../src/renderer/src/guiInlineImageHtml.ts', import.meta.url),
    'utf8'
  )
  assert.match(
    md,
    /openFromPointer\(event, chatTarget\(reference\), image\)/u,
    'o menu contextual da imagem continua oferecendo as ações autorizadas'
  )
  assert.match(md, /openImagePreview\(image, event\)/u, 'o gesto da imagem abre o viewer sem ativar o link ancestral')
  assert.match(
    modulo,
    /<button type="button" class="\$\{GUI_INLINE_IMAGE_OPEN_CLASS\}" /u,
    'sem invólucro de botão, Enter e espaço não ativam a imagem'
  )
  assert.match(
    modulo,
    /gui-file-link/u,
    'o caminho da recusa tem de ser o MESMO token clicável do fio (clique lê aqui, botão direito abre fora)'
  )
  assert.match(modulo, /não deu para mostrar /u, 'a recusa precisa dizer o que aconteceu, em PT-BR')
})

// ————— O ERRO QUE NÃO EXPLICAVA NADA (ordem do dono, 2026-08-28) —————
// "esses erros aleatórios, ele não explica nada, ele não explica por que foi o
// erro". O card dizia só "o turno terminou sem receber o resultado de uma
// ferramenta" — nem QUAL. E a caixa-preta não guardava linha nenhuma sobre o
// episódio: conferido no journal do dia, zero eventos de fim de turno. Aqui
// fica a metade que o dono LÊ; o recibo do diário tem contrato próprio abaixo.

test('a ferramenta órfã é NOMEADA no card, não escondida atrás de "uma ferramenta"', async () => {
  const { pendingGuiToolNames, orphanedToolText } = await import(
    '../src/renderer/src/guiTerminalTools.ts'
  )
  const items = [
    { ...tool('t1', 'Bash'), result: { status: 'completed' } },
    tool('t2', 'Read'),
    note('n1')
  ]
  assert.deepEqual(pendingGuiToolNames(items), ['Read'])
  assert.match(orphanedToolText(['Read']), /Read/u)
})

test('várias órfãs cabem numa linha: a primeira nomeada e a conta do resto', async () => {
  const { pendingGuiToolNames, orphanedToolText } = await import(
    '../src/renderer/src/guiTerminalTools.ts'
  )
  const items = [tool('a', 'Bash'), tool('b', 'Read'), tool('c', 'Bash')]
  // o MESMO nome duas vezes conta uma vez só: "Bash · Bash" não informa nada
  assert.deepEqual(pendingGuiToolNames(items), ['Bash', 'Read'])
  const texto = orphanedToolText(['Bash', 'Read', 'Edit'])
  assert.match(texto, /Bash/u)
  assert.match(texto, /mais 2/u, 'a cauda vira contagem, nunca uma lista sem fim')
})

test('sem nome legível o card mantém a verdade antiga — nunca inventa uma tool', async () => {
  const { orphanedToolText } = await import('../src/renderer/src/guiTerminalTools.ts')
  assert.match(orphanedToolText([]), /uma ferramenta/u)
})

test('a conta do episódio é UMA só, e o turno que continua nunca vira órfão', async () => {
  const { orphanedTurnTools } = await import('../src/renderer/src/guiTerminalTools.ts')
  const pendentes = [tool('t1', 'Bash')]

  assert.deepEqual(orphanedTurnTools(pendentes, { outcome: 'completed' }), {
    orphaned: true,
    names: ['Bash']
  })
  // subagente em background: o turno não fechou, então não há órfão
  assert.equal(orphanedTurnTools(pendentes, { continues: true }).orphaned, false)
  // ■ do dono e cancelamento não são erro (R7-E)
  assert.equal(orphanedTurnTools(pendentes, { interrupted: true }).orphaned, false)
  assert.equal(orphanedTurnTools(pendentes, { outcome: 'cancelled' }).orphaned, false)
  // tool SEM nome legível continua sendo órfã — só que anunciada pela frase antiga
  const semNome = [{ ...tool('t2', 'Bash'), name: '  ' }]
  assert.deepEqual(orphanedTurnTools(semNome, { outcome: 'completed' }), {
    orphaned: true,
    names: []
  })
})

test('o episódio da órfã vira linha na caixa-preta, com o pane para correlacionar', () => {
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  const gui = readFileSync(new URL('../src/main/ipc/gui.ts', import.meta.url), 'utf8')

  // o renderer avisa do lugar que TEM paneId (o reducer segue puro)
  assert.match(store, /noteOrphanedTool\?\.\(paneId/u)
  // e o main grava com correlação, no diário que o bbwatch lê
  assert.match(gui, /gui:noteOrphanedTool/u)
  assert.match(gui, /event: 'turn-orphaned-tool'/u)
  assert.match(gui, /ids: \{ paneId \}/u)
})

// ————— O CHIP DE SKILL (2026-08-30) —————
//
// O dono quer VER quando o chat usa uma skill. A sonda
// (`.synkora/reports/PROBE_SKILL_USE_2026-08-30.md`) provou o sinal: o claude
// emite `tool_use` com `name:'Skill'` e o nome dentro de `input.skill`, e o app
// JÁ o entrega ao renderer como SessionEvent de tool. O codex não tem evento
// nenhum — o main normaliza as duas superfícies dele para a MESMA forma, e é
// por isso que aqui só existe UM caminho de apresentação.
//
// Semântica do marcador (veredito 3 da sonda): "esta skill ENTROU nesta
// conversa" — o segundo uso não emite nada em CLI nenhum. Por isso o chip é
// um marco do fio, não um card de ferramenta com desfecho.

test('o nome da skill sai do campo TIPADO, e só dele', async () => {
  const { guiSkillNameForTool } = await import('../src/renderer/src/guiSkillUse.ts')
  assert.equal(guiSkillNameForTool('Skill', { skill: 'impeccable' }), 'impeccable')
  assert.equal(guiSkillNameForTool('Skill', { skill: '  impeccable  ' }), 'impeccable')
  // Comparação EXATA com 'Skill': tool de MCP nasce `mcp__servidor__tool` e
  // nunca colide; parecido não é igual.
  assert.equal(guiSkillNameForTool('skill', { skill: 'x' }), undefined)
  assert.equal(guiSkillNameForTool('mcp__loja__Skill', { skill: 'x' }), undefined)
  assert.equal(guiSkillNameForTool('Bash', { skill: 'x' }), undefined)
  // input.skill vazio NÃO vira chip anônimo: mudança de protocolo tem que
  // aparecer (o card genérico de sempre), não ser engolida por um chip sem nome.
  assert.equal(guiSkillNameForTool('Skill', {}), undefined)
  assert.equal(guiSkillNameForTool('Skill', { skill: '   ' }), undefined)
  assert.equal(guiSkillNameForTool('Skill', { skill: 42 }), undefined)
  assert.equal(guiSkillNameForTool('Skill', undefined), undefined)
})

test('o evento Skill escolhe o CHIP; toda outra ferramenta segue no card de sempre', async () => {
  const { guiToolCardKind } = await import('../src/renderer/src/guiToolPresentation.ts')
  assert.equal(guiToolCardKind({ ...tool('s1', 'Skill'), skill: 'impeccable' }), 'skill')
  // Sem nome normalizado o card é o genérico — a regressão fica VISÍVEL.
  assert.equal(guiToolCardKind(tool('s2', 'Skill')), 'generic')
  assert.equal(guiToolCardKind(tool('t1', 'Bash', 'npm test')), 'command')
  assert.equal(guiToolCardKind(tool('t2', 'Read')), 'generic')
  assert.equal(
    guiToolCardKind({ ...tool('t3', 'Edit'), fileDiffs: [{ path: 'a.ts', newText: 'x' }] }),
    'diff'
  )
})

test('o chip nunca é engolido pelo agrupamento de ferramentas iguais', async () => {
  const { groupConsecutiveGuiTools } = await import('../src/renderer/src/guiToolPresentation.ts')
  const skill = (id, name) => ({ ...tool(id, 'Skill'), skill: name })
  // Duas entradas seguidas são DOIS marcos do fio: colapsar em "Skill ×2"
  // esconderia justamente o que o dono pediu para ver.
  const dois = groupConsecutiveGuiTools([skill('a', 'impeccable'), skill('b', 'dataviz')])
  assert.deepEqual(dois.map((item) => item.kind), ['tool', 'tool'])
  // E o chip no meio de uma sequência não faz o grupo de Bash desaparecer.
  const misto = groupConsecutiveGuiTools([
    tool('b1', 'Bash', 'npm run typecheck'),
    tool('b2', 'Bash', 'npm test'),
    skill('s', 'impeccable')
  ])
  assert.deepEqual(misto.map((item) => item.kind), ['tool-group', 'tool'])
  // A ferramenta comum continua agrupando exatamente como antes.
  assert.equal(groupConsecutiveGuiTools([tool('r1'), tool('r2')]).length, 1)
})

test('o reducer normaliza o nome da skill no item — o input cru não fica no store', () => {
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  assert.match(store, /guiSkillNameForTool\(evt\.name, evt\.input\)/u)
  assert.match(store, /\.\.\.\(skill \? \{ skill \} : \{\}\)/u)
  // E o fio anuncia o NOME enquanto o card corre, nunca o JSON cru do input:
  // a chave entra por ÚLTIMO, então nenhuma outra ferramenta perde o resumo
  // que já tinha.
  const chaves = store.slice(store.indexOf('const GUI_TOOL_KEYS = ['))
  const lista = chaves.slice(0, chaves.indexOf(']') + 1)
  assert.match(lista, /'description',[\s\S]*'skill'\s*\]/u)
})

test('o chip é papel quieto: forma, sem movimento e sem virar painel', () => {
  const card = readFileSync(
    new URL('../src/renderer/src/components/GuiToolCard.tsx', import.meta.url),
    'utf8'
  )
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')

  // O roteamento mora no módulo puro; o componente só obedece.
  assert.match(card, /guiToolCardKind\(item\)/u)
  assert.match(card, /case 'skill':/u)
  assert.match(card, /gui-skill-chip/u)
  // A frase do dono, em PT-BR, com o nome da skill ao lado do glifo.
  assert.match(card, /entrou na conversa/u)
  assert.match(card, /\{item\.skill\}/u)

  // Estilo com prefixo próprio (nada de vazar em .gui-tool) e sem animação:
  // movimento é SINAL nesta casa, e um marco parado não sinaliza nada.
  assert.ok(css.includes('.gui-skill-chip {'), 'o chip tem regra própria, namespaced')
  const bloco = css.slice(css.indexOf('.gui-skill-chip {'))
  const regra = bloco.slice(0, bloco.indexOf('}') + 1)
  assert.doesNotMatch(regra, /animation:/u, 'o chip não pisca')
  assert.doesNotMatch(regra, /transition:/u)
})

// A JANELA DO "abrindo" (foto do dono, 2026-08-30): o gui:create espera o
// waitForCliStable — no boot frio a checagem de update do CLI segura o spawn
// por MINUTOS — e nesse vão não existe sessão no registro. O composer ficava
// com o menu de modelos vazio, o chip de effort SUMIA, e trocar o modelo
// batia em "este pane não tem sessão aberta": um beco. Três cercas:
//   1. os menus caem no CATÁLOGO real da conta (o mesmo do painel D8);
//   2. o chip de effort não some enquanto as caps não chegam;
//   3. o clique vira CARIMBO com fala no fio, e um reconciliador o aplica
//      pelo caminho vivo assim que a conversa fica de pé e livre.
test('no "abrindo" o composer cai no catálogo e a troca vira carimbo, nunca beco', () => {
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  assert.match(
    pane,
    /const modelOptions = gui\.caps\?\.models \?\? catalogFallbackModels/u,
    'sem o fallback o menu volta a nascer vazio'
  )
  assert.match(pane, /guiComposerCatalogModels\(/u, 'o fallback vem da metade pura')
  assert.match(pane, /void loadCatalog\(cli, seatId\)/u, 'sem pedir o catálogo o fallback fica vazio')
  assert.match(
    pane,
    /effortOptions\.length > 0 \|\| \(!gui\.caps && Boolean\(selectedEffort\)\)/u,
    'o chip de effort não pode sumir no abrindo'
  )
  assert.match(pane, /deferExecutorChange/u, 'o desvio do carimbo sumiu')
  assert.match(
    pane,
    /if \(gui\.status !== 'starting'\) return false/u,
    'o carimbo é SÓ para a janela sem sessão — fora dela o caminho vivo responde'
  )
  assert.match(pane, /carimbei a troca/u, 'o clique carimbado fala no fio, nunca silencia')
  const reconciler = pane.slice(pane.indexOf('O RECONCILIADOR do carimbo'))
  assert.ok(reconciler.length > 100, 'o reconciliador do carimbo sumiu')
  assert.match(
    reconciler.slice(0, 1800),
    /gui\.status === 'starting' \|\| gui\.status === 'working'\) return/u,
    'com turno vivo o reconciliador espera — o main recusaria a troca'
  )
})
