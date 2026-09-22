import { Notification, type BrowserWindow } from 'electron'
import type { BlackboxEventInput } from './blackbox'
import type { ProgressOpenTarget } from './progressNavigation'
import {
  canShowDesktopNotification,
  resetNotifyThrottleForTests,
  shouldNotify,
  type DesktopNotifyFocusMode,
  type DesktopNotifyKind,
  type DesktopNotifySource
} from './desktopNotificationPolicy'

// Notificações de desktop do Synkora 2.0 (onda D): missão esperando você
// (permissão/pergunta no chat GUI), turno concluído ou falho, conflito na
// fila, merge concluído. Fora de foco, avisa tudo. Com o app em foco, sai só o
// que está FORA da tela do dono (ordem de 2026-09-22) — o modo é dele, em
// Ajustes › Avisos.

export type { DesktopNotifyKind } from './desktopNotificationPolicy'

export interface DesktopNotifyInput {
  kind: DesktopNotifyKind
  title: string
  body: string
  /** Chave de throttle/dedupe (paneId ou missionId). */
  key: string
  /** Para ONDE o clique leva (além do foco na janela, que é automático):
   *  a missão/chat do aviso, ou só o projeto quando é integração/release.
   *  Viaja pelo mesmo canal `progress:open-target` do radar de andamento. */
  target?: ProgressOpenTarget
  /** De onde o aviso fala: com a janela em foco, na tela do dono ele cala. */
  source?: DesktopNotifySource
  /** Navegação extra ao clicar, para quem não cabe num alvo. */
  onClick?: () => void
  /** Avisos do chat usam o som próprio do renderer, se habilitado. */
  silent?: boolean
}

/** Quem sabe o que está na tela: o registro de visibilidade do ipc/gui. */
export interface DesktopNotifyPresence {
  focusMode(): DesktopNotifyFocusMode
  isOnScreen(source: DesktopNotifySource | undefined): boolean
}

type DesktopNotifyOutcome = 'shown' | 'muted-on-screen' | 'muted-focused' | 'unsupported' | 'repeated'

export function __resetNotifyThrottleForTests(): void {
  resetNotifyThrottleForTests()
}

export { shouldNotify }

let getWindow: () => BrowserWindow | null = () => null
let navigate: (target: ProgressOpenTarget) => void = () => undefined
let record: (entry: BlackboxEventInput) => void = () => undefined
let presence: DesktopNotifyPresence = {
  focusMode: () => 'off-screen',
  isOnScreen: () => false
}

/** Toasts VIVOS: o Electron só entrega `click` enquanto a instância existe, e
 *  sem referência o GC a recolhia antes do clique do dono — o toast aparecia
 *  e "não fazia nada". Solta no fechamento (clique, dispensa ou expiração). */
const live = new Set<Notification>()

/** O index registra o acessor da janela principal, o navegador (o mesmo
 *  `deliverProgressOpenTarget` do radar) e a caixa-preta uma vez no boot. */
export function initDesktopNotifications(
  accessor: () => BrowserWindow | null,
  navigator?: (target: ProgressOpenTarget) => void,
  recorder?: (entry: BlackboxEventInput) => void
): void {
  getWindow = accessor
  if (navigator) navigate = navigator
  if (recorder) record = recorder
}

/** O ipc/gui liga a presença quando nasce o registro de visibilidade. */
export function setDesktopNotifyPresence(next: DesktopNotifyPresence): void {
  presence = next
}

/** "Por que não avisou?" tem resposta no diário: toda decisão vira evidência. */
function recordDecision(
  input: DesktopNotifyInput,
  outcome: DesktopNotifyOutcome,
  focusMode: DesktopNotifyFocusMode
): void {
  try {
    const projectId = input.target?.projectId
    const missionId = input.source?.missionId ?? input.target?.missionId
    const paneId = input.source?.paneId ?? input.target?.paneId
    record({
      cat: 'app',
      event: 'desktop-notify',
      actor: 'harness',
      ids: {
        ...(projectId ? { projectId } : {}),
        ...(missionId ? { missionId } : {}),
        ...(paneId ? { paneId } : {})
      },
      detail: { kind: input.kind, outcome, focusMode }
    })
  } catch {
    // a caixa-preta nunca derruba um aviso
  }
}

export function notifyDesktop(input: DesktopNotifyInput): void {
  try {
    const win = getWindow()
    const windowFocused = Boolean(win && !win.isDestroyed() && win.isFocused())
    const supported = Notification.isSupported()
    const focusMode = presence.focusMode()
    const sourceOnScreen = windowFocused && presence.isOnScreen(input.source)
    if (!canShowDesktopNotification({ supported, windowFocused, focusMode, sourceOnScreen })) {
      recordDecision(
        input,
        !supported ? 'unsupported' : focusMode === 'never' ? 'muted-focused' : 'muted-on-screen',
        focusMode
      )
      return
    }
    if (!shouldNotify(input.kind, input.key, Date.now())) {
      recordDecision(input, 'repeated', focusMode)
      return
    }

    const notification = new Notification({
      title: input.title,
      body: input.body,
      silent: input.silent ?? false,
    })
    const release = (): void => {
      live.delete(notification)
    }
    notification.on('click', () => {
      release()
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      try {
        if (input.target) navigate(input.target)
        input.onClick?.()
      } catch {
        // navegação é cortesia; o foco já aconteceu
      }
    })
    notification.on('close', release)
    notification.on('failed', release)
    live.add(notification)
    notification.show()
    recordDecision(input, 'shown', focusMode)
  } catch {
    // notificação nunca derruba o main
  }
}
