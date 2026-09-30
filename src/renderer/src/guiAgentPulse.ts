import type { GuiItem } from './store'
import type { GuiThinkingPhase } from './guiThinkingPresentation'

// ————————————————————————————————————————————————————————————————————————
// O PULSO DO AGENTE (mockup aprovado pelo dono em 2026-09-16).
//
// Uma linha no rabo do fio que responde de relance "o app não travou? a IA não
// parou?": um GESTO por ação (o movimento diz o que acontece antes de o olho
// ler), o VERBO do que acontece agora, o alvo (arquivo/página), o rastro do
// passado imediato ("— leu …") e o relógio desde o último SINAL PÚBLICO do
// agente. O silêncio muda a FORMA antes da cor (moldura tracejada ao 1º
// minuto; --err + receita aos 3). Nada aqui lê conteúdo: só o tipo da
// ferramenta, o campo de arquivo já orçado (`progressTarget`) e o desfecho.
//
// MÓDULO PURO (só TIPOS entram por import, como o `missionPresentation`): a
// fase vem de `guiThinkingPresentation` pelo chamador, o texto do relógio é
// do componente — e é por isso que a suíte o importa direto, sem bundle.
// ————————————————————————————————————————————————————————————————————————

/** Um gesto por ação — o vocabulário de movimento vive em GuiAgentPulse.css. */
export type GuiPulseAction =
  | 'thinking'
  | 'reading'
  | 'editing'
  | 'running'
  | 'searching'
  | 'responding'
  | 'compacting'
  | 'browsing'
  | 'skill'
  | 'helpers'
  | 'integrating'
  | 'waiting'

export type GuiPulseTier = 'live' | 'quiet' | 'stalled'

/** Silêncio público (nenhuma fala ou atividade visível do pai) que muda a
 *  forma da linha. O lembrete do harness ao modelo dispara aos 45 s; um minuto
 *  sem sinal já é notícia, três é alarme. */
export const GUI_PULSE_QUIET_MS = 60_000
export const GUI_PULSE_STALLED_MS = 180_000
/** Abaixo disto o relógio nem aparece: "há 1 s" é ruído. */
export const GUI_PULSE_CLOCK_MIN_MS = 2_000

export const GUI_PULSE_STALLED_HINT =
  'pode ser uma chamada longa · ■ interrompe o turno · o que você escrever entra na conversa dele agora'

/** `since` = "há N s" (vivo); `silence` = "sem sinal há m:ss" (quieto/alarme). */
export interface GuiPulseClock {
  kind: 'since' | 'silence'
  ms: number
}

export interface GuiAgentPulse {
  action: GuiPulseAction
  /** o que acontece AGORA: "lendo", "pensando", "respondendo"… */
  verb: string
  /** o alvo da ferramenta em curso (arquivo, página, nome da tool genérica) */
  target?: string
  /** o passado imediato, apagado: "— leu src/x.ts", "— o comando falhou" */
  trail?: string
  clock?: GuiPulseClock
  tier: GuiPulseTier
  /** a receita do dono no alarme */
  hint?: string
}

export interface GuiAgentPulseInput {
  /** a fase factual do turno do pai (`guiThinkingPresentation`); null = sem pulso */
  phase: GuiThinkingPhase | null
  items: readonly GuiItem[]
  publicSilenceSince?: number | null
  now: number
}

interface PulseVerb {
  action: GuiPulseAction
  now: string
  past: string
  fail: string
}

const reading: PulseVerb = { action: 'reading', now: 'lendo', past: 'leu', fail: 'falhou ao ler' }
const editing: PulseVerb = { action: 'editing', now: 'editando', past: 'editou', fail: 'falhou ao editar' }
const writing: PulseVerb = { action: 'editing', now: 'escrevendo', past: 'escreveu', fail: 'falhou ao escrever' }
const running: PulseVerb = { action: 'running', now: 'rodando um comando', past: 'rodou um comando', fail: 'o comando falhou' }
const helpers: PulseVerb = {
  action: 'helpers', now: 'consultando os ajudantes', past: 'consultou os ajudantes', fail: 'a consulta aos ajudantes falhou'
}
const GENERIC: PulseVerb = { action: 'waiting', now: 'usando', past: 'usou', fail: 'falhou' }

/** Só o TIPO da ferramenta decide o verbo; nomes de arquivo/comando nunca entram aqui. */
const VERBS: Record<string, PulseVerb> = {
  read: reading, read_file: reading, notebookread: reading,
  edit: editing, apply_patch: editing, notebookedit: editing, multiedit: editing,
  write: writing, write_file: writing,
  grep: { action: 'searching', now: 'buscando no projeto', past: 'buscou no projeto', fail: 'a busca falhou' },
  glob: { action: 'searching', now: 'buscando arquivos', past: 'buscou arquivos', fail: 'a busca falhou' },
  bash: running, shell: running, exec_command: running, powershell: running,
  write_stdin: { action: 'running', now: 'consultando o terminal', past: 'consultou o terminal', fail: 'a consulta ao terminal falhou' },
  skill: { action: 'skill', now: 'consultando uma skill', past: 'consultou uma skill', fail: 'a skill falhou' },
  mcp__synkora__browser_open: { action: 'browsing', now: 'abrindo a página', past: 'abriu a página', fail: 'a página não abriu' },
  mcp__synkora__browser_eval: { action: 'browsing', now: 'inspecionando a página', past: 'inspecionou a página', fail: 'a inspeção da página falhou' },
  mcp__synkora__browser_shot: { action: 'browsing', now: 'capturando a página', past: 'capturou a página', fail: 'a captura da página falhou' },
  mcp__synkora__browser_check: { action: 'browsing', now: 'verificando a página', past: 'verificou a página', fail: 'a verificação da página falhou' },
  mcp__synkora__delegate: { action: 'helpers', now: 'despachando ajudantes', past: 'despachou ajudantes', fail: 'o despacho dos ajudantes falhou' },
  mcp__synkora__helper_result: helpers, mcp__synkora__helpers_status: helpers,
  mcp__synkora__helper_send: helpers, mcp__synkora__helper_resume: helpers,
  mcp__synkora__integration_run: { action: 'integrating', now: 'integrando a missão', past: 'integrou a missão', fail: 'a integração parou' },
  mcp__synkora__integration_status: { action: 'integrating', now: 'consultando a fila', past: 'consultou a fila', fail: 'a consulta à fila falhou' }
}

function toolKey(name: string): string {
  return name.split('.').at(-1)?.toLowerCase() ?? ''
}

export function guiPulseVerbFor(name: string): PulseVerb {
  return VERBS[toolKey(name)] ?? GENERIC
}

type WorkTool = Extract<GuiItem, { kind: 'tool' }>

/** Só o trabalho do PAI conta: ajudantes têm atividade própria na lateral e a
 *  fala pública (commentary) não é ferramenta.
 *
 *  Cópia deliberada de `isGuiCommentaryTool` (guiToolPresentation): as suítes
 *  carregam este módulo com type-stripping do node, que não resolve import de
 *  irmão sem extensão — um import de VALOR aqui derrubaria os testes. */
function isWorkTool(item: GuiItem): item is WorkTool {
  return (
    item.kind === 'tool' &&
    !item.parentToolUseId &&
    !item.subagent &&
    !item.name.startsWith('helper:') &&
    !['commentary', 'mcp__synkora__commentary'].includes(toolKey(item.name))
  )
}

function targetOf(tool: WorkTool, verb: PulseVerb): string | undefined {
  return tool.progressTarget ?? (verb.action === 'waiting' ? tool.name : undefined)
}

/** O rastro do passado imediato. Desfecho vem do sinal estrutural do resultado,
 *  nunca do texto dele. */
export function guiPulseTrail(tool: WorkTool): string {
  const verb = guiPulseVerbFor(tool.name)
  const target = targetOf(tool, verb)
  const withTarget = (head: string): string => (target ? `${head} ${target}` : head)
  const result = tool.result
  if (!result) return withTarget(verb.now)
  if (result.provisional) return `${withTarget(verb.now)} · sem resultado confirmado`
  if (result.status === 'interrupted') return `${withTarget(verb.now)} · interrompido`
  if (result.status === 'cancelled') return `${withTarget(verb.now)} · cancelado`
  if (result.status === 'denied') return `${withTarget(verb.now)} · não autorizado`
  if (result.isError || result.status === 'failed') return withTarget(verb.fail)
  if (result.agentStatus === 'launched') return `${withTarget(verb.now)} · em andamento`
  return withTarget(verb.past)
}

export function guiAgentPulsePresentation(input: GuiAgentPulseInput): GuiAgentPulse | null {
  const phase = input.phase
  if (!phase) return null
  // Sem relógio: o texto correndo (ou a compactação) já é o sinal.
  if (phase === 'compacting') return { action: 'compacting', verb: 'compactando contexto', tier: 'live' }
  if (phase === 'responding') return { action: 'responding', verb: 'respondendo', tier: 'live' }

  let latest: WorkTool | undefined
  let pending: WorkTool | undefined
  for (let index = input.items.length - 1; index >= 0; index--) {
    const item = input.items[index]
    // O rastro é da conversa ATUAL (2026-09-28): acima do divisor do /new o
    // trabalho é de outra conversa, que o agente nem lembra.
    if (item.kind === 'divider') break
    if (!isWorkTool(item)) continue
    latest ??= item
    if (!item.result) {
      pending = item
      break
    }
  }

  let pulse: GuiAgentPulse
  if (pending) {
    // Ferramenta pendente é o fato mais forte: é ELA que está acontecendo.
    const verb = guiPulseVerbFor(pending.name)
    const target = targetOf(pending, verb)
    pulse = { action: verb.action, verb: verb.now, ...(target ? { target } : {}), tier: 'live' }
  } else if (phase === 'tool') {
    // O backend diz que há ferramenta sem resultado, mas ela saiu da janela.
    pulse = { action: 'waiting', verb: 'esperando a ferramenta', tier: 'live' }
  } else {
    pulse = {
      action: 'thinking',
      verb: phase === 'thinking' ? 'pensando' : 'preparando a resposta',
      ...(latest ? { trail: `— ${guiPulseTrail(latest)}` } : {}),
      tier: 'live'
    }
  }

  const elapsed = input.publicSilenceSince == null ? 0 : Math.max(0, input.now - input.publicSilenceSince)
  if (elapsed >= GUI_PULSE_STALLED_MS)
    return { ...pulse, tier: 'stalled', clock: { kind: 'silence', ms: elapsed }, hint: GUI_PULSE_STALLED_HINT }
  if (elapsed >= GUI_PULSE_QUIET_MS) return { ...pulse, tier: 'quiet', clock: { kind: 'silence', ms: elapsed } }
  if (elapsed >= GUI_PULSE_CLOCK_MIN_MS) return { ...pulse, clock: { kind: 'since', ms: elapsed } }
  return pulse
}
