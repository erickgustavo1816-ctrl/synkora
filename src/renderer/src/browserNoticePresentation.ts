import type { BrowserNoticeView, BrowserPanelState, BrowserTabFailure } from '../../preload/index'

// A FORMA DE CADA RECADO DO BROWSER (2026-09-29, seção "6 · Cada erro com a sua
// UI" de `docs/mockups/browser-chrome-2026-09-29.html`): tom, ícone e saída de
// cada linha da faixa e do cartão de erro na página. Tudo decidido pelo `kind`
// — sinal ESTRUTURAL do motor —, nunca pelo texto. Módulo puro e sem import de
// runtime (só `import type`): os gates rodam em node sobre o `.ts` cru.

/** erro (vermelho), política da casa (cinza: não é falha, é regra), situação
 *  que passa (neutro) e leitura falhada (a tela é a última fotografia). */
export type BrowserNoticeTone = 'error' | 'policy' | 'neutral' | 'muted'

/** Os ícones da faixa — nomes do `WorkspaceIcon` (o compilador confere). */
export type BrowserNoticeIcon = 'alert' | 'lock' | 'download' | 'queue' | 'tabs' | 'gone' | 'info'

/** A saída no corpo da linha: RECARREGAR a aba ativa ou REABRIR o endereço
 *  da aba que morreu. */
export type BrowserNoticeAction = { kind: 'reload' } | { kind: 'reopen'; url: string }

export const BROWSER_NOTICE_ACTION_WORDS: Readonly<
  Record<BrowserNoticeAction['kind'], { label: string; title: string }>
> = {
  reload: { label: 'recarregar', title: 'recarregar a página da aba ativa' },
  reopen: { label: 'reabrir', title: 'abrir de novo o mesmo endereço numa aba nova' }
}

export interface BrowserNoticeLook {
  tone: BrowserNoticeTone
  icon: BrowserNoticeIcon
  action: BrowserNoticeAction['kind'] | null
}

const PAGE_FAILURE_LOOK: BrowserNoticeLook = { tone: 'error', icon: 'alert', action: 'reload' }

/** Espécie que o chrome ainda não conhece vira ERRO com alerta: um valor novo
 *  do motor nunca pode passar despercebido nem quebrar a tela. */
const UNKNOWN_NOTICE_LOOK: BrowserNoticeLook = { tone: 'error', icon: 'alert', action: null }

// `Map` e não objeto literal: `kind` vem do motor, e "constructor" num objeto
// devolveria a função do protótipo.
const NOTICE_LOOKS: ReadonlyMap<string, BrowserNoticeLook> = new Map([
  ['permission-denied', { tone: 'policy', icon: 'lock', action: null }],
  ['download-blocked', { tone: 'policy', icon: 'download', action: null }],
  ['load-slow', { tone: 'neutral', icon: 'queue', action: 'reload' }],
  ['tab-cap', { tone: 'neutral', icon: 'tabs', action: null }],
  ['tab-lost', { tone: 'error', icon: 'gone', action: 'reopen' }],
  ['reference-failed', { tone: 'error', icon: 'alert', action: null }],
  ['load-failed', PAGE_FAILURE_LOOK],
  ['crashed', PAGE_FAILURE_LOOK],
  ['unresponsive', PAGE_FAILURE_LOOK]
])

export function browserNoticeLook(kind: string): BrowserNoticeLook {
  return NOTICE_LOOKS.get(kind) ?? UNKNOWN_NOTICE_LOOK
}

/** A frase inteira do recado, como o dono a lê: a cabeça e o complemento. */
export function browserNoticeSentence(notice: Pick<BrowserNoticeView, 'title' | 'text'>): string {
  return notice.title ? `${notice.title} — ${notice.text}` : notice.text
}

export interface BrowserNoticeCount {
  label: string
  title: string
}

/** A página que insiste vira UMA linha com contador; um recado só não conta. */
export function browserNoticeCount(notice: BrowserNoticeView): BrowserNoticeCount | null {
  const count = notice.count
  if (count === undefined || count < 2) return null
  const title = notice.kind === 'permission-denied' ? `a página pediu ${count} vezes` : `o mesmo aviso chegou ${count} vezes`
  return { label: `×${count}`, title }
}

export interface BrowserNoticeRow {
  /** identidade do recado: dispensar vale para ELE, não para os próximos */
  key: string
  source: 'engine' | 'read' | 'gesture' | 'viewport'
  tone: BrowserNoticeTone
  icon: BrowserNoticeIcon
  /** cabeça em negrito; `null` = a linha é só a frase */
  title: string | null
  text: string
  count: BrowserNoticeCount | null
  action: BrowserNoticeAction | null
}

/** Falhas que o motor novo conta POR ABA (o cartão na página). */
const PAGE_FAILURE_KINDS: readonly string[] = ['load-failed', 'crashed', 'unresponsive']

function engineAction(look: BrowserNoticeLook, notice: BrowserNoticeView): BrowserNoticeAction | null {
  if (look.action === 'reload') return { kind: 'reload' }
  // REABRIR sem endereço seria uma aba em branco fingindo ser a que morreu.
  if (look.action === 'reopen' && notice.url) return { kind: 'reopen', url: notice.url }
  return null
}

function hostRow(
  source: 'read' | 'gesture' | 'viewport',
  tone: BrowserNoticeTone,
  icon: BrowserNoticeIcon,
  text: string
): BrowserNoticeRow {
  return { key: `${source}:${text}`, source, tone, icon, title: null, text, count: null, action: null }
}

/**
 * As linhas da faixa, na ordem em que o dono lê. A nota de página falhada do
 * motor NÃO se repete quando ele já conta a falha POR ABA — o cartão diz isso
 * onde o olho está; motor anterior sem `failure` cai na faixa. A recusa do
 * gesto que repete a nota do motor (o teto de abas) vira UMA linha só.
 */
export function browserNoticeRows(
  state: BrowserPanelState,
  host: {
    /** falha de leitura do motor — a fotografia anterior FICA na tela */
    readError: string | null
    /** recusa do gesto que o dono acabou de fazer */
    gesture: string | null
    /** a largura pedida não coube (`browserViewportShortfall`) */
    viewport: string | null
  }
): BrowserNoticeRow[] {
  const rows: BrowserNoticeRow[] = []
  const notice = state.notice
  if (notice && !(PAGE_FAILURE_KINDS.includes(notice.kind) && state.tabs.some((tab) => tab.failure))) {
    const look = browserNoticeLook(notice.kind)
    rows.push({
      // O motor mantém o `at` na repetição coalescida: dispensada, fica dispensada.
      key: `engine:${notice.at || notice.text}`,
      source: 'engine',
      tone: look.tone,
      icon: look.icon,
      title: notice.title ?? null,
      text: notice.text,
      count: browserNoticeCount(notice),
      action: engineAction(look, notice)
    })
  }
  if (host.readError) rows.push(hostRow('read', 'muted', 'queue', host.readError))
  const engineSaid = notice ? [notice.text, browserNoticeSentence(notice)] : []
  if (host.gesture && !engineSaid.includes(host.gesture)) {
    rows.push(hostRow('gesture', 'error', 'alert', host.gesture))
  }
  if (host.viewport) rows.push(hostRow('viewport', 'neutral', 'info', host.viewport))
  return rows
}

/** Dispensar vale enquanto o recado EXISTE: o que sumiu e voltou é recado
 *  novo. Devolve o MESMO conjunto quando nada caiu (sem render à toa). */
export function liveNoticeDismissals(
  dismissed: ReadonlySet<string>,
  rows: readonly BrowserNoticeRow[]
): ReadonlySet<string> {
  if (!dismissed.size) return dismissed
  const live = new Set(rows.map((row) => row.key))
  const kept = [...dismissed].filter((key) => live.has(key))
  return kept.length === dismissed.size ? dismissed : new Set(kept)
}

export interface BrowserFailureLook {
  icon: 'alert' | 'frozen'
  /** a página TRAVADA pode voltar sozinha: o dono escolhe ESPERAR olhando */
  canWait: boolean
}

/** O cartão da página falhada, pela espécie da falha. */
export function browserFailureLook(failure: BrowserTabFailure): BrowserFailureLook {
  if (failure.kind === 'unresponsive') return { icon: 'frozen', canWait: true }
  return { icon: 'alert', canWait: false }
}
