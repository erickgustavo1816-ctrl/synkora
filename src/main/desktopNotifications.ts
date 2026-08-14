import { Notification, type BrowserWindow } from 'electron'
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
  /** Navegação ao clicar (além do foco na janela, que é automático). */
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

/** O index registra o acessor da janela principal uma vez no boot. */
export function initDesktopNotifications(accessor: () => BrowserWindow | null): void {
  getWindow = accessor
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
    notification.on('click', () => {
      const target = getWindow()
      if (target && !target.isDestroyed()) {
        if (target.isMinimized()) target.restore()
        target.show()
        target.focus()
      }
      try {
        input.onClick?.()
      } catch {
        // navegação é cortesia; o foco já aconteceu
      }
    })
    notification.show()
  } catch {
    // notificação nunca derruba o main
  }
}
