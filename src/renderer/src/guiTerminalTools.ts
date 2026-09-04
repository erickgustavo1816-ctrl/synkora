import type { GuiItem } from './store'
import type { GuiToolItem } from './guiToolPresentation'

type GuiTerminalEvent =
  | {
      type: 'result'
      isError: boolean
      outcome?: 'completed' | 'failed' | 'cancelled'
      /** R7-E: o ■ do dono parou ESTE turno (espelho do union do main —
       *  maestroSession.ts). A bandeira ganha de `isError`/`outcome`. */
      interrupted?: boolean
      errorText?: string
    }
  | { type: 'fatal'; text: string }
  | { type: 'closed'; code: number | null }

type GuiTerminalToolResult = {
  text: string
  isError: boolean
  /** `interrupted` (R6.1) só nasce no replay de boot, para o card de AJUDANTE
   *  despachado: o motor preservou o registro, e "cancelado" mentiria. */
  status: 'failed' | 'cancelled' | 'completed' | 'interrupted' | 'unconfirmed'
  lineCount: number
  truncated: false
  provisional?: boolean
  agentStatus?: 'settled'
}

/** Recibo de despacho do Agent assíncrono (contrato do tool-result: `launched`
 *  = agente vivo; `settled` = terminal factual).
 *
 *  Cópia deliberada da mesma checagem de `guiToolPresentation`: as suítes
 *  carregam estes módulos com type-stripping do node, que não resolve import de
 *  irmão sem extensão — um import de VALOR aqui derrubaria os testes. */
function isLaunchedSubagent(item: GuiToolItem): boolean {
  return item.result?.agentStatus === 'launched'
}

export function guiClosedLine(code: number | null, hadPendingTool = false): {
  kind: 'note' | 'error'
  text: string
} {
  const failed = hadPendingTool || (code !== null && code !== 0)
  return failed
    ? {
        kind: 'error',
        text: hadPendingTool
          ? 'a sessão encerrou antes de receber o resultado de uma ferramenta'
          : `a sessão encerrou com código ${code}`
      }
    : { kind: 'note', text: 'sessão encerrada' }
}

function terminalToolResult(evt: GuiTerminalEvent): GuiTerminalToolResult {
  if (evt.type === 'fatal') {
    return {
      text: evt.text.trim() || 'a sessão falhou antes de a ferramenta concluir',
      isError: true,
      status: 'failed',
      lineCount: 1,
      truncated: false
    }
  }
  if (evt.type === 'closed') {
    return {
      text:
        evt.code !== null && evt.code !== 0
          ? `a sessão encerrou antes de a ferramenta concluir (código ${evt.code})`
          : 'a sessão encerrou sem entregar o resultado da ferramenta',
      isError: true,
      status: 'failed',
      lineCount: 1,
      truncated: false
    }
  }
  // R7-E — O ■ DO DONO, ANTES DE TUDO. O turno parou porque ele mandou parar: a
  // ferramenta em voo foi CANCELADA junto, e "falhou" seria mentira. A bandeira
  // ganha de `isError`/`outcome` de propósito — a honestidade do card não pode
  // depender de o CLI ter carimbado erro no terminal da parada (o claude
  // carimba, e era isso que pintava o card vermelho no print do dono).
  if (evt.type === 'result' && evt.interrupted === true) {
    return {
      text: 'interrompida pelo dono — o turno foi interrompido',
      isError: false,
      status: 'cancelled',
      lineCount: 1,
      truncated: false
    }
  }
  if (evt.type === 'result' && (evt.isError || evt.outcome === 'failed')) {
    return {
      text: evt.errorText?.trim() || 'o turno falhou antes de a ferramenta concluir',
      isError: true,
      status: 'failed',
      lineCount: 1,
      truncated: false
    }
  }
  if (evt.type === 'result' && evt.outcome !== 'cancelled') {
    return {
      text: 'resultado não confirmado — o turno encerrou sem o recibo da ferramenta',
      isError: false,
      status: 'unconfirmed',
      lineCount: 1,
      truncated: false,
      // O terminal do turno pode preceder o tool-result. Ausência de recibo
      // não prova falha: o card fica neutro, elegível ao pareamento estrito
      // por toolUseId quando o resultado autoritativo chegar.
      provisional: true
    }
  }
  return {
    text: 'o turno terminou antes de a ferramenta concluir',
    isError: false,
    status: 'cancelled',
    lineCount: 1,
    truncated: false
  }
}

/** Agente que foi só DESPACHADO e morre com a sessão: cancelado, nunca falho —
 *  ninguém errou, o processo é que acabou antes do terminal factual. */
function cancelledSubagentResult(): GuiTerminalToolResult {
  return {
    text: 'a sessão encerrou antes de o subagente reportar',
    isError: false,
    status: 'cancelled',
    lineCount: 1,
    truncated: false,
    agentStatus: 'settled'
  }
}

/**
 * O PREFIXO do card sintetizado de AJUDANTE MCP (contrato com o main:
 * `GUI_HELPER_CARD_PREFIX` em guiHelperCards.ts — duplicado aqui porque o
 * renderer nunca importa do main). É ele que separa, no replay de boot, quem
 * foi INTERROMPIDO preservando (helper — o motor persiste o registro retomável)
 * de quem morreu com a sessão (subagente nativo — cancelado, como sempre).
 */
const GUI_HELPER_CARD_ID_PREFIX = 'helper:'

/** AJUDANTE despachado que o boot reencontra: INTERROMPIDO, nunca cancelado
 *  (R6.1 — "fechar o app" é interrupção; o registro dele está no motor,
 *  retomável com helper_resume). */
function interruptedSubagentResult(): GuiTerminalToolResult {
  return {
    text: 'o app fechou com o ajudante trabalhando — interrompido; a conversa dele ficou guardada e dá para retomar (helper_resume) ou descartar (helper_cancel)',
    isError: false,
    status: 'interrupted',
    lineCount: 1,
    truncated: false,
    agentStatus: 'settled'
  }
}

/** Ferramenta do agente cancelado: mesmo desfecho, sem carimbar ciclo de vida
 *  de agente num card que nunca foi um. */
function cancelledSubagentChildResult(): GuiTerminalToolResult {
  return {
    text: 'a sessão encerrou antes de o subagente reportar',
    isError: false,
    status: 'cancelled',
    lineCount: 1,
    truncated: false
  }
}

/** Desfecho neutro do card filho que segue o próprio pai. O protocolo do Claude
 *  nunca entrega tool-result de filho: sem isto o card ficaria pendente para
 *  sempre e a conversa nunca voltaria a `idle`. */
export function guiSubagentChildClosure(): GuiTerminalToolResult {
  return {
    text: 'encerrado com o subagente',
    isError: false,
    status: 'completed',
    lineCount: 1,
    truncated: false,
    provisional: true
  }
}

export function hasPendingGuiTools(items: GuiItem[]): boolean {
  return items.some((item) => item.kind === 'tool' && !item.result)
}

// ————— A FERRAMENTA ÓRFÃ TEM NOME (ordem do dono, 2026-08-28) —————
//
// "esses erros aleatórios, ele não explica nada". O card dizia apenas "o
// turno terminou sem receber o resultado de uma ferramenta": nem qual, nem
// quantas. Sem o nome não há nem o que investigar depois — e a caixa-preta,
// conferida no journal do dia, não guardava evento nenhum de fim de turno.
//
// Estas duas contas são PURAS de propósito: o que a tela diz sobre uma falha
// é exatamente o tipo de coisa que precisa ser provada sem React.

/** Os NOMES das ferramentas que o turno deixou sem resposta, na ordem em que
 *  apareceram e sem repetir — "Bash · Bash" não informa nada além de "Bash". */
export function pendingGuiToolNames(items: readonly GuiItem[]): string[] {
  const nomes: string[] = []
  for (const item of items) {
    if (item.kind !== 'tool' || item.result) continue
    const nome = item.name?.trim()
    if (!nome || nomes.includes(nome)) continue
    nomes.push(nome)
  }
  return nomes
}

/**
 * O EPISODIO da orfa, decidido em UM lugar so: o card que o dono le e o
 * recibo que vai para a caixa-preta nascem desta mesma conta — duas reguas
 * diriam coisas diferentes sobre o mesmo turno.
 *
 * `orphaned` continua sendo a pergunta ANTIGA (existe tool sem result?), e
 * nao a lista de nomes: uma tool sem nome legivel segue sendo orfa, so que
 * anunciada pela frase generica.
 */
export function orphanedTurnTools(
  items: readonly GuiItem[],
  evt: { continues?: boolean; outcome?: string; interrupted?: boolean }
): { orphaned: boolean; names: string[] } {
  const fechou = !evt.continues && evt.interrupted !== true && evt.outcome !== 'cancelled'
  const pendente = items.some((item) => item.kind === 'tool' && !item.result)
  if (!fechou || !pendente) return { orphaned: false, names: [] }
  return { orphaned: true, names: pendingGuiToolNames(items) }
}
/** A linha neutra do aviso. Sem nome legível a lacuna continua genérica:
 *  ausência de recibo não autoriza inventar nome ou desfecho. */
export function orphanedToolText(names: readonly string[]): string {
  const [primeiro, ...resto] = names
  if (!primeiro) return 'resultado não confirmado de uma ferramenta após o fim do turno'
  const cauda = resto.length > 0 ? ` e mais ${resto.length}` : ''
  return `resultado não confirmado de ${primeiro}${cauda} após o fim do turno`
}

/** Pai factual de cada card por identidade de item. Id de pai ambíguo é tratado
 *  como inexistente — replay corrompido não sequestra a árvore de outra tool. */
function guiToolParentByItemId(items: readonly GuiItem[]): Map<string, GuiToolItem> {
  const byToolUseId = new Map<string, GuiToolItem | null>()
  for (const item of items) {
    if (item.kind !== 'tool' || !item.toolUseId) continue
    byToolUseId.set(item.toolUseId, byToolUseId.has(item.toolUseId) ? null : item)
  }
  const parents = new Map<string, GuiToolItem>()
  for (const item of items) {
    if (item.kind !== 'tool' || !item.parentToolUseId) continue
    const parent = byToolUseId.get(item.parentToolUseId)
    if (!parent || parent.id === item.id) continue
    parents.set(item.id, parent)
  }
  return parents
}

/**
 * Eventos terminais são a última palavra sobre o turno. Se o CLI não enviou
 * `tool-result` (comum ao interromper), todo card ainda pendente ganha um
 * desfecho explícito; resultados já pareados permanecem intactos.
 *
 * Um card FILHO segue a árvore do próprio pai: fechado junto, com o mesmo
 * desfecho (agente despachado cancela a árvore inteira). Filho sem herança —
 * raiz fora da janela, pai já resolvido, linhagem cíclica — fecha com o
 * terminal do turno, senão ficaria pendente para sempre.
 */
export function closePendingGuiTools(
  items: GuiItem[],
  evt: GuiTerminalEvent
): GuiItem[] {
  const terminal = terminalToolResult(evt)
  const cancelledParent = cancelledSubagentResult()
  const cancelledChild = cancelledSubagentChildResult()
  const parents = guiToolParentByItemId(items)
  const closures = new Map<string, GuiTerminalToolResult | null>()

  const closureFor = (
    item: GuiToolItem,
    chain: Set<string>
  ): GuiTerminalToolResult | null => {
    const memo = closures.get(item.id)
    if (memo !== undefined) return memo
    // Linhagem cíclica não fecha nada: um ciclo não tem raiz para herdar.
    if (chain.has(item.id)) return null
    chain.add(item.id)
    let closure: GuiTerminalToolResult | null = null
    if (isLaunchedSubagent(item)) closure = cancelledParent
    else if (item.result) closure = null
    else if (!item.parentToolUseId) closure = terminal
    else {
      const parent = parents.get(item.id)
      const inherited = parent ? closureFor(parent, chain) : terminal
      // Pai já resolvido (ou linhagem cíclica) não deixa o filho pendente para
      // sempre: quem não herda desfecho fecha com o terminal do próprio turno —
      // o comportamento de sempre, senão `hasPendingGuiTools` nunca zera e todo
      // turno seguinte re-inventa o erro de órfão.
      closure = inherited === cancelledParent ? cancelledChild : (inherited ?? terminal)
    }
    closures.set(item.id, closure)
    return closure
  }

  let changed = false
  const next = items.map((item) => {
    if (item.kind !== 'tool') return item
    const closure = closureFor(item, new Set())
    if (!closure) return item
    changed = true
    return { ...item, result: closure }
  })
  return changed ? next : items
}

/**
 * Respawn: o processo morreu, então nenhum agente despachado sobreviveu. Só os
 * pais `launched` (e seus filhos) são assentados — o resto do transcript é
 * fotografia e continua intocado.
 */
export function settleLaunchedGuiSubagents(items: GuiItem[]): GuiItem[] {
  const launched = items.some(
    (item) => item.kind === 'tool' && isLaunchedSubagent(item)
  )
  if (!launched) return items
  const parents = guiToolParentByItemId(items)
  const cancelledParent = cancelledSubagentResult()
  const cancelledChild = cancelledSubagentChildResult()

  const descendsFromLaunched = (item: GuiToolItem, chain: Set<string>): boolean => {
    if (chain.has(item.id)) return false
    chain.add(item.id)
    const parent = parents.get(item.id)
    if (!parent) return false
    return isLaunchedSubagent(parent) || descendsFromLaunched(parent, chain)
  }

  const interruptedParent = interruptedSubagentResult()
  return items.map((item) => {
    if (item.kind !== 'tool') return item
    if (isLaunchedSubagent(item)) {
      // AJUDANTE MCP × subagente nativo (R6.1): o helper foi preservado pelo
      // motor no fechamento — o card diz "interrompido" e a lateral o guarda
      // como retomável; o nativo morreu com a sessão e segue cancelado.
      const helper = item.toolUseId?.startsWith(GUI_HELPER_CARD_ID_PREFIX) === true
      return { ...item, result: helper ? interruptedParent : cancelledParent }
    }
    if (item.result) return item
    return descendsFromLaunched(item, new Set())
      ? { ...item, result: cancelledChild }
      : item
  })
}
