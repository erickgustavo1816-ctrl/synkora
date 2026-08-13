import { Notification, type BrowserWindow } from 'electron'

// Notificações de desktop do Synkora 2.0 (onda D): avisam o dono quando o app
// não está em foco — missão esperando você (permissão/pergunta no chat GUI),
// conflito na fila, merge concluído, fila pronta pro ⇪. Com o app em foco os
// pulsos internos bastam; notificar por cima seria ruído.

export type DesktopNotifyKind = 'attention' | 'conflict' | 'merged' | 'queue-ready'

export interface DesktopNotifyInput {
  kind: DesktopNotifyKind
  title: string
  body: string
  /** Chave de throttle/dedupe (paneId ou missionId). */
  key: string
  /** Navegação ao clicar (além do foco na janela, que é automático). */
  onClick?: () => void
}

const THROTTLE_MS: Record<DesktopNotifyKind, number> = {
  attention: 30_000,
  conflict: 15_000,
  merged: 5_000,
  'queue-ready': 30_000,
}

const lastShownAt = new Map<string, number>()

/** Regra pura de throttle — exportada para teste. */
export function shouldNotify(kind: DesktopNotifyKind, key: string, now: number): boolean {
  const mapKey = `${kind}:${key}`
  const last = lastShownAt.get(mapKey) ?? 0
  if (now - last < THROTTLE_MS[kind]) return false
  lastShownAt.set(mapKey, now)
  return true
}

export function __resetNotifyThrottleForTests(): void {
  lastShownAt.clear()
}

let getWindow: () => BrowserWindow | null = () => null

/** O index registra o acessor da janela principal uma vez no boot. */
export function initDesktopNotifications(accessor: () => BrowserWindow | null): void {
  getWindow = accessor
}

export function notifyDesktop(input: DesktopNotifyInput): void {
  try {
    if (!Notification.isSupported()) return
    const win = getWindow()
    // Janela em foco = o dono está olhando; os sinais internos cobrem.
    if (win && !win.isDestroyed() && win.isFocused()) return
    if (!shouldNotify(input.kind, input.key, Date.now())) return

    const notification = new Notification({
      title: input.title,
      body: input.body,
      silent: false,
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
