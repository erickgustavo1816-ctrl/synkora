import { Notification, type BrowserWindow } from 'electron'
import type { ProgressOpenTarget } from './progressNavigation'
import {
  canShowDesktopNotification,
  resetNotifyThrottleForTests,
  shouldNotify,
  type DesktopNotifyKind
} from './desktopNotificationPolicy'

// Notificações de desktop do Synkora 2.0 (onda D): avisam o dono quando o app
// não está em foco — missão esperando você (permissão/pergunta no chat GUI),
// conflito na fila, merge concluído, fila pronta pro ⇪. Com o app em foco os
// pulsos internos bastam; notificar por cima seria ruído.

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
  /** Navegação extra ao clicar, para quem não cabe num alvo. */
  onClick?: () => void
  /** Avisos do chat usam o som próprio do renderer, se habilitado. */
  silent?: boolean
  /** Chat: mostra o toast do sistema mesmo durante o uso do app. */
  showWhenFocused?: boolean
}

export function __resetNotifyThrottleForTests(): void {
  resetNotifyThrottleForTests()
}

export { shouldNotify }

let getWindow: () => BrowserWindow | null = () => null
let navigate: (target: ProgressOpenTarget) => void = () => undefined

/** Toasts VIVOS: o Electron só entrega `click` enquanto a instância existe, e
 *  sem referência o GC a recolhia antes do clique do dono — o toast aparecia
 *  e "não fazia nada". Solta no fechamento (clique, dispensa ou expiração). */
const live = new Set<Notification>()

/** O index registra o acessor da janela principal e o navegador (o mesmo
 *  `deliverProgressOpenTarget` do radar) uma vez no boot. */
export function initDesktopNotifications(
  accessor: () => BrowserWindow | null,
  navigator?: (target: ProgressOpenTarget) => void
): void {
  getWindow = accessor
  if (navigator) navigate = navigator
}

export function notifyDesktop(input: DesktopNotifyInput): void {
  try {
    const win = getWindow()
    const windowFocused = Boolean(win && !win.isDestroyed() && win.isFocused())
    if (!canShowDesktopNotification({
      supported: Notification.isSupported(),
      windowFocused,
      showWhenFocused: input.showWhenFocused
    })) return
    if (!shouldNotify(input.kind, input.key, Date.now())) return

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
  } catch {
    // notificação nunca derruba o main
  }
}
