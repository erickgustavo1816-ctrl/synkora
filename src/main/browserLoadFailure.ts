/**
 * AS PALAVRAS DO BROWSER PARA O DONO (lei 8 do mockup
 * `docs/mockups/browser-chrome-2026-09-29.html`, §6 "Cada erro com a sua UI").
 * Puro, sem Electron: o motor (`./browserPane`) só escolhe QUAL frase vale.
 *
 * Toda frase sai de SINAL ESTRUTURAL — o nome do erro de rede do Chromium
 * (`ERR_…`), o motivo do `render-process-gone`, o nome da permissão, os
 * dispositivos do pedido — e nunca de ler texto livre. O código cru vai para
 * `code` (letra miúda do cartão, diagnóstico); a frase de gente não o repete,
 * nem nomeia permissão crua ("media") ou tool de agente ("browser_wait").
 */
import type { BrowserNotice, BrowserTabFailure } from './browserPaneContracts'

/** A nota antes do carimbo: `at` e `count` são do motor (identidade e repetição). */
export type BrowserNoticeCopy = Omit<BrowserNotice, 'at' | 'count'>

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/** O nome do erro como o Electron o monta: a descrição do `did-fail-load` é o
 *  próprio nome, e a mensagem da rejeição do `loadURL` COMEÇA por ele. */
const NET_ERROR_NAME = /^(?:net::)?(ERR_[A-Z0-9_]+)/u

/** O que a rejeição do `loadURL` (ou o `did-fail-load`) carrega de estrutural. */
export interface BrowserNetError {
  /** `ERR_…` — `code` do erro do Electron, ou a descrição do `did-fail-load` */
  code?: unknown
  /** o número do Chromium (`-102`), quando não há nome */
  errno?: unknown
  message?: unknown
}

/** O erro cru → o nome do Chromium (`ERR_ABORTED`) e o número, quando existem. */
export function browserNetError(error: unknown): { name?: string; errno?: number } {
  const source: BrowserNetError = error && typeof error === 'object' ? (error as BrowserNetError) : { message: error }
  const named = [source.code, source.message]
    .map((value) => (typeof value === 'string' ? NET_ERROR_NAME.exec(value.trim())?.[1] : undefined))
    .find((name) => name !== undefined)
  const errno = typeof source.errno === 'number' && Number.isFinite(source.errno) ? source.errno : undefined
  return { ...(named ? { name: named } : {}), ...(errno !== undefined ? { errno } : {}) }
}

/** Nome exato → causa e saída. Os grupos (`ERR_CERT_*`…) vêm logo abaixo. */
const NET_PHRASES: Record<string, string> = {
  ERR_CONNECTION_REFUSED: 'o servidor recusou a conexão — confira o endereço ou tente de novo daqui a pouco',
  ERR_CONNECTION_FAILED: 'não deu para conectar ao servidor — confira o endereço ou tente de novo daqui a pouco',
  ERR_NAME_NOT_RESOLVED: 'o nome do site não foi encontrado — confira se o endereço está escrito certo',
  ERR_NAME_RESOLUTION_FAILED: 'o nome do site não foi encontrado — confira se o endereço está escrito certo',
  ERR_INTERNET_DISCONNECTED: 'o computador está sem internet — confira a rede e recarregue',
  ERR_NETWORK_CHANGED: 'a rede mudou no meio do carregamento — recarregue',
  ERR_TIMED_OUT: 'o servidor demorou demais para responder — recarregue daqui a pouco',
  ERR_CONNECTION_TIMED_OUT: 'o servidor demorou demais para responder — recarregue daqui a pouco',
  ERR_CONNECTION_RESET: 'a conexão caiu no meio do caminho — recarregar costuma resolver',
  ERR_CONNECTION_CLOSED: 'a conexão caiu no meio do caminho — recarregar costuma resolver',
  ERR_CONNECTION_ABORTED: 'a conexão caiu no meio do caminho — recarregar costuma resolver',
  ERR_ADDRESS_UNREACHABLE: 'esse endereço não é alcançável desta rede — confira o endereço e a rede',
  ERR_EMPTY_RESPONSE: 'o servidor respondeu vazio — confira se ele está de pé e recarregue',
  ERR_TOO_MANY_REDIRECTS: 'a página entrou num laço de redirecionamentos — confira a configuração do site',
  ERR_FILE_NOT_FOUND: 'esse arquivo não existe no caminho pedido — confira o endereço',
  ERR_UNSAFE_PORT: 'o navegador barra essa porta por segurança — suba o servidor em outra porta'
}

const NET_GROUPS: [prefix: string, phrase: string][] = [
  ['ERR_CERT_', 'o certificado de segurança do site não é válido — confira o endereço ou o certificado do servidor'],
  ['ERR_SSL_', 'a conexão segura (https) falhou — confira se o endereço não deveria ser http'],
  ['ERR_BLOCKED_BY_', 'o carregamento foi barrado por uma regra de segurança — se precisar da página, abra no seu browser']
]

/** A página que não carregou: a causa e a saída, sem a URL (o cartão já a
 *  mostra) e sem o código (que vai cru em `code`). */
export function browserLoadFailure(url: string, error: unknown): BrowserTabFailure {
  const { name, errno } = browserNetError(error)
  const code = name ?? (errno !== undefined ? String(errno) : undefined)
  return { kind: 'load-failed', title: 'a página não carregou', text: loadFailureText(url, name), ...(code ? { code } : {}) }
}

function loadFailureText(url: string, name: string | undefined): string {
  if (!name) return 'o carregamento falhou'
  if (name === 'ERR_CONNECTION_REFUSED') {
    try {
      const target = new URL(url)
      if (['http:', 'https:'].includes(target.protocol) && LOOPBACK_HOSTS.includes(target.hostname)) {
        const port = target.port || (target.protocol === 'https:' ? '443' : '80')
        return `a prévia local na porta ${port} recusou a conexão — aguarde o servidor iniciar ou reinicie a prévia`
      }
    } catch { /* URL que não se lê cai na frase do servidor remoto. */ }
  }
  return NET_PHRASES[name] ?? NET_GROUPS.find(([prefix]) => name.startsWith(prefix))?.[1] ?? 'o carregamento falhou'
}

/** `RenderProcessGoneDetails.reason` → o que aconteceu, sempre com a saída. */
const CRASH_TEXTS: Record<string, string> = {
  oom: 'o processo da página terminou (sem memória) — recarregar traz ela de volta',
  crashed: 'o processo da página quebrou — recarregar traz ela de volta',
  killed: 'o processo da página foi encerrado por fora — recarregar traz ela de volta',
  'abnormal-exit': 'o processo da página saiu com erro — recarregar traz ela de volta',
  'clean-exit': 'o processo da página se encerrou — recarregar traz ela de volta',
  'memory-eviction': 'o sistema tirou a página da memória para liberar espaço — recarregar traz ela de volta',
  'launch-failed': 'o processo da página não conseguiu iniciar — tente recarregar; se repetir, reinicie o Synkora',
  'integrity-failure': 'uma checagem de integridade do sistema derrubou o processo da página — reinicie o Synkora'
}

export function browserCrashFailure(reason: unknown): BrowserTabFailure {
  const code = typeof reason === 'string' && reason.trim() ? reason.trim() : undefined
  const text = (code && CRASH_TEXTS[code]) || 'o processo da página terminou de repente — tente recarregar'
  return { kind: 'crashed', title: 'a página caiu', text, ...(code ? { code } : {}) }
}

export function browserUnresponsiveFailure(): BrowserTabFailure {
  return {
    kind: 'unresponsive',
    title: 'a página parou de responder',
    text: 'algum script dela está preso — espere mais um pouco ou recarregue'
  }
}

/** Nome da permissão do Electron → o que a página pediu, pronto para
 *  "a página pediu …". `media` depende dos dispositivos do pedido. */
const PERMISSION_PHRASES: Record<string, string> = {
  geolocation: 'a sua localização',
  notifications: 'para mandar notificações',
  'display-capture': 'para capturar a tela',
  'clipboard-read': 'para ler a área de transferência',
  'clipboard-sanitized-write': 'para escrever na área de transferência',
  midi: 'acesso a instrumentos MIDI',
  midiSysex: 'controle total de instrumentos MIDI',
  pointerLock: 'para prender o ponteiro do mouse',
  keyboardLock: 'para prender o teclado',
  fullscreen: 'tela cheia',
  openExternal: 'para abrir um programa fora do browser',
  hid: 'acesso a um dispositivo conectado ao computador',
  devices: 'acesso a um dispositivo conectado ao computador',
  serial: 'acesso a uma porta serial',
  usb: 'acesso a um dispositivo USB',
  'idle-detection': 'para saber quando você está ausente',
  'window-management': 'para controlar as janelas e as telas',
  // Logins e vídeos embutidos pedem estas em silêncio e em laço — é o caso que
  // a coalescência (×N) do motor existe para dobrar numa linha só.
  'storage-access': 'acesso aos cookies de um conteúdo embutido de outro site',
  'top-level-storage-access': 'acesso aos cookies de outro site',
  'speaker-selection': 'para escolher o alto-falante',
  mediaKeySystem: 'para tocar vídeo protegido contra cópia',
  fileSystem: 'acesso aos seus arquivos'
}

export function browserPermissionPhrase(permission: string, mediaTypes?: readonly string[]): string {
  if (permission === 'media') {
    const video = mediaTypes?.includes('video') ?? false
    const audio = mediaTypes?.includes('audio') ?? false
    if (video && audio) return 'a câmera e o microfone'
    if (video) return 'a câmera'
    if (audio) return 'o microfone'
    return 'a câmera ou o microfone'
  }
  return Object.hasOwn(PERMISSION_PHRASES, permission) ? PERMISSION_PHRASES[permission] : 'uma permissão do navegador'
}

export function browserPermissionNotice(permission: string, mediaTypes?: readonly string[]): BrowserNoticeCopy {
  return {
    kind: 'permission-denied',
    title: `a página pediu ${browserPermissionPhrase(permission, mediaTypes)}`,
    text: 'o browser da missão não libera isso por desenho; para testar, abra a página no seu browser'
  }
}

export function browserDownloadNotice(filename: string): BrowserNoticeCopy {
  return {
    kind: 'download-blocked',
    title: `download barrado: ${filename.trim().slice(0, 80) || 'arquivo sem nome'}`,
    text: 'o browser da missão não baixa arquivos; baixe pelo terminal da missão'
  }
}

export function browserTabCapNotice(cap: number): BrowserNoticeCopy {
  return { kind: 'tab-cap', title: `${cap} abas é o teto desta missão`, text: 'feche uma (×) para abrir outra' }
}

export function browserLoadSlowNotice(seconds: number): BrowserNoticeCopy {
  return {
    kind: 'load-slow',
    title: 'a página está demorando',
    text: `mais de ${seconds} s carregando; ela continua tentando`
  }
}

/** Como a nota chama uma aba que já não existe: o título da página, ou o host
 *  do endereço — cortados, nunca uma URL inteira. */
export function browserTabLostLabel(title: string, url: string): string {
  const cleanTitle = title.trim()
  const cleanUrl = url.trim()
  let label = cleanTitle && cleanTitle !== cleanUrl ? cleanTitle : ''
  if (!label) {
    try {
      label = new URL(cleanUrl).host
    } catch { /* endereço que não se lê: fica o nome genérico */ }
  }
  if (!label) return 'sem título'
  return label.length > 60 ? `${label.slice(0, 59)}…` : label
}

export function browserTabLostNotice(title: string, url: string): BrowserNoticeCopy {
  return {
    kind: 'tab-lost',
    title: `a aba "${browserTabLostLabel(title, url)}" fechou sozinha`,
    text: 'a página morreu sem volta'
  }
}
