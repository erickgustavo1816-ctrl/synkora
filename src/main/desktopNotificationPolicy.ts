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

// ————— COM O SYNKORA ABERTO (ordem do dono, 2026-09-22) —————
// "Se termina outro projeto o qual não estou com a tela nele, eu queria ser
// notificado." Janela sem foco avisa tudo; em foco, o modo escolhido em
// Ajustes › Avisos decide. O padrão cala SÓ o que o dono já está vendo.

/** Espelho em `preload/index.ts` (`SynkoraPreferences.desktopNotifyWhileFocused`). */
export type DesktopNotifyFocusMode = 'off-screen' | 'always' | 'never'

/** De onde o aviso fala: o chat exato, ou a missão (qualquer chat dela). */
export interface DesktopNotifySource {
  paneId?: string
  missionId?: string
}

export function canShowDesktopNotification(input: {
  supported: boolean
  windowFocused: boolean
  focusMode: DesktopNotifyFocusMode
  sourceOnScreen: boolean
}): boolean {
  if (!input.supported) return false
  if (!input.windowFocused || input.focusMode === 'always') return true
  return input.focusMode === 'off-screen' && !input.sourceOnScreen
}

/**
 * "Na tela" = o chat do aviso está ativo, ou algum chat da missão dona dele.
 * Origem desconhecida nunca cala: na dúvida, o dono é avisado.
 */
export function isDesktopNotifySourceOnScreen(
  source: DesktopNotifySource | undefined,
  presence: {
    isPaneActive(paneId: string): boolean
    missionPaneIds(missionId: string): readonly string[]
  }
): boolean {
  if (!source) return false
  if (source.paneId && presence.isPaneActive(source.paneId)) return true
  if (!source.missionId) return false
  return presence.missionPaneIds(source.missionId).some((paneId) => presence.isPaneActive(paneId))
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
// Ordem do dono: título e corpo DIRETOS. O título é o ASSUNTO ("<projeto> ·
// <missão>", ou "<projeto> · Planejamento" no chat de planejamento — o projeto
// vem PRIMEIRO, escolha dele em 2026-09-21) e o corpo
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
  return project ? `${project} · ${scope}` : scope
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
