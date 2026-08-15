import assert from 'node:assert/strict'
import test from 'node:test'
import { GuiAlertSequencer } from '../src/main/guiNotices.ts'
import {
  canShowDesktopNotification,
  resetNotifyThrottleForTests,
  shouldNotify,
  WINDOWS_APP_USER_MODEL_ID,
  WINDOWS_TOAST_ACTIVATOR_CLSID,
  windowsNotificationShortcutSpec
} from '../src/main/desktopNotificationPolicy.ts'
import {
  GUI_READY_CLEAR_MS,
  GUI_WINDOW_READY_TITLE,
  GUI_WINDOW_TITLE,
  GuiPaneVisibilityRegistry,
  GuiWindowReadyController
} from '../src/main/guiWindowReady.ts'

test('alerta canônico cobre atenção, término, fila e falha sem anunciar cancelamento', () => {
  const alerts = new GuiAlertSequencer()
  let seq = 0
  const accept = (event) => alerts.accept(event, ++seq)
  assert.equal(accept({ type: 'permission' }), 'needs-you')
  assert.equal(accept({ type: 'question' }), 'needs-you')
  assert.equal(accept({ type: 'plan-review' }), 'needs-you')
  assert.equal(accept({ type: 'tool-result', isError: true }), null)

  assert.equal(accept({ type: 'result', isError: false }), null)
  const finishedSeq = seq
  assert.equal(alerts.presented(finishedSeq + 1), null, 'cursor arbitrário não adianta o aviso')
  assert.equal(alerts.presented(finishedSeq), 'finished')
  assert.equal(alerts.presented(finishedSeq), null, 'ACK repetido é idempotente')

  assert.equal(accept({ type: 'result', isError: false, outcome: 'cancelled' }), null)
  assert.equal(alerts.presented(seq), null)

  assert.equal(accept({ type: 'result', isError: false, continues: true }), null)
  assert.equal(alerts.presented(seq), null, 'resultado intermediário nunca é terminal visual')
  assert.equal(accept({ type: 'tool-result', toolUseId: 'subagent-a', isError: false }), null)
  assert.equal(accept({ type: 'tool-result', toolUseId: 'subagent-b', isError: false }), null)
  assert.equal(alerts.presented(seq), null, 'atividade terminal de filhos nunca toca o aviso')
  assert.equal(accept({ type: 'turn-continuation', continues: false }), null)
  assert.equal(alerts.presented(seq), 'finished')

  assert.equal(accept({ type: 'result', isError: true, continues: true }), null)
  assert.equal(accept({ type: 'result', isError: false, outcome: 'cancelled' }), null)
  assert.equal(alerts.presented(seq), 'failed')

  assert.equal(accept({ type: 'result', isError: false, continues: true }), null)
  assert.equal(accept({ type: 'result', isError: false, outcome: 'cancelled' }), null)
  assert.equal(alerts.presented(seq), null)
})

// ————— um plim por turno lógico, com subagente em background —————
// O `result` raiz do Claude não diz UMA palavra sobre tarefas de fundo: quem
// sabe é o registro do motor (guiClaudeTasks), que carimba `continues` no
// terminal. Estes casos fixam o contrato que o motor precisa honrar — e o preço
// de quebrá-lo (o plim precoce, que era a regressão de 2026-08-14).

/** Roda uma conversa inteira pelo sequenciador e devolve os avisos publicados,
 *  já com o ACK de apresentação que o renderer manda a cada terminal. */
function noticesFor(events) {
  const alerts = new GuiAlertSequencer()
  const notices = []
  let seq = 0
  for (const event of events) {
    seq += 1
    const immediate = alerts.accept(event, seq)
    if (immediate) notices.push(immediate)
    if (event.type === 'result' || event.type === 'turn-continuation') {
      const presented = alerts.presented(seq)
      if (presented) notices.push(presented)
    }
  }
  return notices
}

test('result raiz com subagente vivo não toca o aviso; o último ciclo toca uma vez', () => {
  const dispatched = {
    type: 'tool-result',
    toolUseId: 'tool-1',
    isError: false,
    agentStatus: 'launched',
    agentTaskId: 'task-1'
  }
  const settled = {
    type: 'tool-result',
    toolUseId: 'tool-1',
    isError: false,
    outcome: 'completed',
    agentStatus: 'settled',
    agentTaskId: 'task-1'
  }

  assert.deepEqual(
    noticesFor([
      { type: 'turn-started' },
      { type: 'tool', name: 'Agent' },
      dispatched,
      // Turno raiz que só DESPACHOU: o agente segue trabalhando.
      { type: 'result', isError: false, continues: true },
      settled,
      // Ciclo autônomo que o CLI abre a cada conclusão, agora sem ninguém vivo.
      { type: 'result', isError: false, continues: false }
    ]),
    ['finished'],
    'exatamente um aviso, e só depois do último subagente'
  )

  // O preço de errar o `continues`: com o terminal se declarando final logo no
  // despacho, o aviso sai com o agente ainda trabalhando — e sai de novo no
  // ciclo seguinte. Era isso que tocava dois plins.
  assert.deepEqual(
    noticesFor([
      { type: 'turn-started' },
      dispatched,
      { type: 'result', isError: false, continues: false },
      settled,
      { type: 'result', isError: false, continues: false }
    ]),
    ['finished', 'finished']
  )
})

test('vários subagentes fora de ordem ainda produzem um único aviso', () => {
  const launch = (n) => ({
    type: 'tool-result',
    toolUseId: `tool-${n}`,
    isError: false,
    agentStatus: 'launched',
    agentTaskId: `task-${n}`
  })
  const settle = (n, outcome = 'completed') => ({
    type: 'tool-result',
    toolUseId: `tool-${n}`,
    isError: outcome === 'failed',
    outcome,
    agentStatus: 'settled',
    agentTaskId: `task-${n}`
  })

  assert.deepEqual(
    noticesFor([
      { type: 'turn-started' },
      launch(1),
      launch(2),
      launch(3),
      { type: 'result', isError: false, continues: true },
      settle(3),
      { type: 'result', isError: false, continues: true },
      // Subagente que falha é achado do trabalho, não falha do turno: o desfecho
      // do turno continua vindo do `result` raiz (decisão de produto).
      settle(2, 'failed'),
      { type: 'result', isError: false, continues: true },
      settle(1),
      { type: 'result', isError: false, continues: false }
    ]),
    ['finished']
  )
})

test('interrupção e queda com subagente vivo não deixam aviso pendurado nem duplicado', () => {
  const launched = {
    type: 'tool-result',
    toolUseId: 'tool-1',
    isError: false,
    agentStatus: 'launched',
    agentTaskId: 'task-1'
  }
  const cancelled = {
    type: 'tool-result',
    toolUseId: 'tool-1',
    isError: false,
    outcome: 'cancelled',
    agentStatus: 'settled',
    agentTaskId: 'task-1'
  }

  // Parada pedida pelo dono: os agentes são cancelados ANTES do terminal e
  // cancelamento nunca vira anúncio.
  assert.deepEqual(
    noticesFor([
      { type: 'turn-started' },
      launched,
      { type: 'result', isError: false, continues: true },
      cancelled,
      { type: 'result', isError: false, outcome: 'cancelled', continues: false }
    ]),
    []
  )

  // Queda do processo com agente vivo: uma falha só, mesmo com fatal + closed.
  const alerts = new GuiAlertSequencer()
  assert.equal(alerts.accept({ type: 'turn-started' }, 1), null)
  assert.equal(alerts.accept(launched, 2), null)
  assert.equal(alerts.accept({ type: 'result', isError: false, continues: true }, 3), null)
  assert.equal(alerts.presented(3), null, 'terminal intermediário não libera aviso')
  assert.equal(alerts.accept(cancelled, 4), null)
  assert.equal(alerts.accept({ type: 'fatal', text: 'caiu' }, 5), null)
  assert.equal(alerts.accept({ type: 'closed', code: 1 }, 6), null)
  assert.equal(alerts.presented(5), 'failed')
  assert.equal(alerts.presented(5), null)
})

test('fatal seguido de closed produz uma falha; uma nova geração rearma o alerta', () => {
  const alerts = new GuiAlertSequencer()
  assert.equal(alerts.accept({ type: 'fatal', text: 'caiu' }, 1), null)
  assert.equal(alerts.accept({ type: 'closed', code: 1 }, 2), null)
  assert.equal(alerts.presented(1), 'failed')
  alerts.accept({ type: 'turn-started' }, 3)
  assert.equal(alerts.accept({ type: 'closed', code: 1 }, 4), null)
  assert.equal(alerts.presented(4), 'failed')
  assert.equal(alerts.accept({ type: 'closed', code: 0 }, 5), null)
})

test('toast do chat pode aparecer com a janela em foco sem mudar avisos gerais', () => {
  assert.equal(canShowDesktopNotification({ supported: false, windowFocused: false }), false)
  assert.equal(canShowDesktopNotification({ supported: true, windowFocused: false }), true)
  assert.equal(canShowDesktopNotification({ supported: true, windowFocused: true }), false)
  assert.equal(
    canShowDesktopNotification({
      supported: true,
      windowFocused: true,
      showWhenFocused: true
    }),
    true
  )
})

test('Windows registra identidade e atalho coerentes no pacote e no desenvolvimento', () => {
  const packaged = windowsNotificationShortcutSpec({
    isPackaged: true,
    execPath: 'C:\\Apps\\Synkora\\Synkora.exe',
    appPath: 'C:\\Apps\\Synkora\\resources\\app.asar'
  })
  assert.equal(packaged.appUserModelId, WINDOWS_APP_USER_MODEL_ID)
  assert.equal(packaged.shortcutName, 'Synkora.lnk')
  assert.equal(packaged.args, '')
  assert.equal(packaged.cwd, 'C:\\Apps\\Synkora')
  assert.equal(packaged.toastActivatorClsid, WINDOWS_TOAST_ACTIVATOR_CLSID)

  const development = windowsNotificationShortcutSpec({
    isPackaged: false,
    execPath: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
    appPath: 'C:\\repo'
  })
  assert.equal(development.appUserModelId, development.target)
  assert.equal(development.shortcutName, 'Synkora (desenvolvimento).lnk')
  assert.equal(development.args, '"C:\\repo"')
  assert.equal(development.cwd, 'C:\\repo')
  assert.match(development.toastActivatorClsid, /^\{[0-9A-F-]{36}\}$/u)
})

test('dedupe usa tipo e pane independentes numa janela exata de vinte segundos', () => {
  resetNotifyThrottleForTests()
  assert.equal(shouldNotify('chat-finished', 'pane-a', 0), true)
  assert.equal(shouldNotify('chat-finished', 'pane-a', 19_999), false)
  assert.equal(shouldNotify('chat-finished', 'pane-a', 20_000), true)
  assert.equal(shouldNotify('chat-failed', 'pane-a', 20_001), true)
  assert.equal(shouldNotify('chat-finished', 'pane-b', 20_001), true)
})

function readyHarness() {
  let focused = true
  const active = new Set()
  let title = GUI_WINDOW_TITLE
  let nextTimerId = 0
  const timers = new Map()
  const controller = new GuiWindowReadyController({
    setTitle: (value) => { title = value },
    isFocused: () => focused,
    isPaneActive: (paneId) => active.has(paneId),
    setTimer: (callback, delayMs) => {
      const handle = ++nextTimerId
      timers.set(handle, { callback, delayMs })
      return handle
    },
    clearTimer: (handle) => { timers.delete(handle) }
  })
  return {
    controller,
    active,
    title: () => title,
    focus: () => { focused = true; controller.onWindowFocus() },
    blur: () => { focused = false; controller.onWindowBlur() },
    runTimers: () => {
      const pending = [...timers.values()]
      timers.clear()
      for (const timer of pending) timer.callback()
    },
    delays: () => [...timers.values()].map((timer) => timer.delayMs)
  }
}

test('mesmo pane visível não marca; outra aba limpa dois segundos depois de voltar', () => {
  const harness = readyHarness()
  harness.active.add('pane-a')
  harness.controller.noteFinished('pane-a')
  assert.equal(harness.title(), GUI_WINDOW_TITLE)

  harness.controller.noteFinished('pane-b')
  assert.equal(harness.title(), GUI_WINDOW_READY_TITLE)
  assert.deepEqual(harness.delays(), [])
  harness.active.add('pane-b')
  harness.controller.onPaneActiveChanged('pane-b')
  assert.deepEqual(harness.delays(), [GUI_READY_CLEAR_MS])
  harness.runTimers()
  assert.equal(harness.title(), GUI_WINDOW_TITLE)
})

test('segundo plano persiste, blur cancela a limpeza e múltiplos panes são independentes', () => {
  const harness = readyHarness()
  harness.blur()
  harness.controller.noteFinished('pane-a')
  harness.controller.noteFinished('pane-b')
  assert.equal(harness.title(), GUI_WINDOW_READY_TITLE)

  harness.focus()
  assert.deepEqual(harness.delays(), [GUI_READY_CLEAR_MS, GUI_READY_CLEAR_MS])
  harness.blur()
  assert.deepEqual(harness.delays(), [])
  assert.equal(harness.title(), GUI_WINDOW_READY_TITLE)

  harness.focus()
  harness.runTimers()
  assert.deepEqual(harness.controller.pendingPaneIds(), [])
  assert.equal(harness.title(), GUI_WINDOW_TITLE)
})

test('registro de visibilidade isola renderers e conserva um pane ativo enquanto houver dono', () => {
  const visibility = new GuiPaneVisibilityRegistry()
  visibility.report(1, 'pane-a', true)
  visibility.report(2, 'pane-a', true)
  visibility.report(2, 'pane-b', true)
  assert.equal(visibility.isActive('pane-a'), true)
  assert.deepEqual(visibility.dropSender(1), ['pane-a'])
  assert.equal(visibility.isActive('pane-a'), true)
  assert.deepEqual(new Set(visibility.dropSender(2)), new Set(['pane-a', 'pane-b']))
  assert.equal(visibility.isActive('pane-a'), false)
})
