export type DesktopNotifyKind =
  | 'attention'
  | 'conflict'
  | 'merged'
  | 'queue-ready'
  | 'chat-needs-you'
  | 'chat-finished'
  | 'chat-failed'

/** Identidade estável do executável instalado e do ativador de toast. */
export const WINDOWS_APP_USER_MODEL_ID = 'dev.synkora.app'
export const WINDOWS_TOAST_ACTIVATOR_CLSID = '{F17A5C94-352E-4D88-85B1-96CA864E4CDA}'

export interface WindowsNotificationShortcutSpec {
  appUserModelId: string
  shortcutName: string
  target: string
  args: string
  cwd: string
  toastActivatorClsid: string
}

/**
 * O Windows entrega toast apenas a uma identidade registrada no Menu Iniciar.
 * No app instalado usamos o appId do pacote; em desenvolvimento o Electron
 * exige a identidade do próprio electron.exe e um atalho que o abra com a
 * pasta do app como argumento.
 */
export function windowsNotificationShortcutSpec(input: {
  isPackaged: boolean
  execPath: string
  appPath: string
}): WindowsNotificationShortcutSpec {
  const appUserModelId = input.isPackaged ? WINDOWS_APP_USER_MODEL_ID : input.execPath
  return {
    appUserModelId,
    shortcutName: input.isPackaged ? 'Synkora.lnk' : 'Synkora (desenvolvimento).lnk',
    target: input.execPath,
    args: input.isPackaged ? '' : `"${input.appPath}"`,
    cwd: input.isPackaged ? input.execPath.replace(/[\\/][^\\/]+$/u, '') : input.appPath,
    toastActivatorClsid: WINDOWS_TOAST_ACTIVATOR_CLSID
  }
}

const THROTTLE_MS: Record<DesktopNotifyKind, number> = {
  attention: 30_000,
  conflict: 15_000,
  merged: 5_000,
  'queue-ready': 30_000,
  'chat-needs-you': 20_000,
  'chat-finished': 20_000,
  'chat-failed': 20_000
}

const lastShownAt = new Map<string, number>()

/**
 * Avisos gerais continuam silenciosos com a janela em foco; o chat pode pedir
 * explicitamente um toast tambem durante o uso do app.
 */
export function canShowDesktopNotification(input: {
  supported: boolean
  windowFocused: boolean
  showWhenFocused?: boolean
}): boolean {
  return input.supported && (!input.windowFocused || input.showWhenFocused === true)
}

/** Regra pura de throttle; a identidade efetiva é `<tipo>:<paneId>`. */
export function shouldNotify(kind: DesktopNotifyKind, key: string, now: number): boolean {
  const mapKey = `${kind}:${key}`
  const last = lastShownAt.get(mapKey)
  if (last !== undefined && now - last < THROTTLE_MS[kind]) return false
  lastShownAt.set(mapKey, now)
  return true
}

export function resetNotifyThrottleForTests(): void {
  lastShownAt.clear()
}

// ————— O TEXTO DO TOAST (2026-09-21) —————
// Ordem do dono: título e corpo DIRETOS. O título é o ASSUNTO ("<missão> ·
// <projeto>", ou "Planejamento · <projeto>" no chat de planejamento) e o corpo
// é UMA frase que diz o que aconteceu e, quando cabe, o que fazer. Nada de
// prefixo "Synkora —": o Windows já mostra o nome do app no cabeçalho do toast.

export interface DesktopNotifySubject {
  /** título da missão; ausente = chat de planejamento do projeto */
  missionTitle?: string
  projectName?: string
}

export type DesktopChatNoticeKind = 'needs-you' | 'finished' | 'failed'

export function desktopNotifyTitle(subject: DesktopNotifySubject): string {
  const scope = subject.missionTitle?.trim() || 'Planejamento'
  const project = subject.projectName?.trim()
  return project ? `${scope} · ${project}` : scope
}

/** Quem falou, quando não é o dev da missão: o dev é o padrão e fica implícito. */
function chatSubject(role: string | undefined): string | null {
  if (role === 'reviewer') return 'O revisor'
  if (role === 'helper') return 'Um ajudante'
  return null
}

export function desktopChatNoticeBody(kind: DesktopChatNoticeKind, role?: string): string {
  const who = chatSubject(role)
  if (kind === 'finished') return who ? `${who} terminou o turno` : 'Terminou o turno'
  if (kind === 'failed') return who ? `${who} falhou. Veja o erro no chat` : 'Falhou. Veja o erro no chat'
  return who ? `${who} precisa de você` : 'Precisa de você'
}

export function desktopConflictBody(input: {
  conflictFiles?: number
  detail: string
}): string {
  const files = input.conflictFiles ?? 0
  if (files > 0) return `Integração parou: ${files} ${files === 1 ? 'arquivo' : 'arquivos'} em conflito`
  const detail = input.detail.trim().slice(0, 120)
  return detail ? `Integração parou: ${detail}` : 'Integração parou'
}

export function desktopMergedBody(target: string): string {
  return `Integrada na ${target}`
}
