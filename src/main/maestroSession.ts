import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { freshWindowsPath } from './winPath'
import type { GuiAttachmentDescriptor } from './guiAttachments'
import { guiToolResultDetails } from './guiToolResults'
import {
  GuiProtocolStream,
  isGuiClaudeProtocolEnvelope,
  parseGuiProtocolLine
} from './guiProtocolLine'
import { limitGuiToolInput } from './guiToolInput'
import { terminateGuiProcessTree } from './guiProcessTree'
import {
  guiClaudeTaskId,
  GuiClaudeTaskRegistry,
  type GuiClaudeTask
} from './guiClaudeTasks'
import {
  advanceGuiTurn,
  enqueueGuiTurn,
  GUI_ACTIVE_TURN_SILENCE_TIMEOUT,
  shouldArmGuiTurnWatchdog
} from './guiTurnQueue'
import {
  chatPermissionRuleLabel,
  resolveChatPermissionSuggestions
} from './chatPermissions'
import type { PlanDraft } from './planDraft'

// Sessão PERSISTENTE do Maestro: um processo `claude` vivo em stream-json
// bidirecional — o mesmo motor do TUI, rodando como "painel de fundo".
// O chat estruturado do board é só um espelho bonito dos eventos daqui:
// texto ao vivo, ferramentas com input real, pedidos de permissão do CLI
// (via --permission-prompt-tool stdio) respondidos pelo usuário na UI.

export interface MaestroSessionOpts {
  cwd: string
  configDir?: string
  /** Claude: trusted persona/policy injected above the user turn. */
  systemPromptFile?: string
  resumeSessionId?: string
  model?: string
  effort?: string
  /** codex: política de aprovação (untrusted | on-request | never), override por turno */
  approvalPolicy?: string
  /** claude: fast mode via settings {"fastMode":true} — o /fast do TUI headless */
  fastMode?: boolean
  /** codex: SandboxMode do thread/start (ex.: 'read-only' para o /estudar) */
  sandbox?: string
  /** claude: --permission-mode (ex.: 'acceptEdits' nos executores de tarefa) */
  permissionMode?: string
  /** Teto de silêncio do CLI antes de encerrar a sessão. Ausente = os 10 min
   *  de sempre (todo chamador existente); 0 DESLIGA o relógio — é o que o pane
   *  GUI usa: chat aberto não morre por tédio (docs/GUI_PANE_CONTRACT.md). */
  idleTimeoutMs?: number
  /** Flags extras da linha de comando (2.0 onda D: as do servidor MCP do chat
   *  de planejamento). Já vêm prontas de `guiPlannerMcp` — nada é montado aqui. */
  extraArgs?: string[]
  /** Env extra do processo filho (codex lê o bearer token daqui). */
  extraEnv?: Record<string, string>
}

// Capacidades REAIS do CLI, vindas do handshake `initialize`: a mesma lista
// de comandos e de modelos que o TUI mostra — nada curado na mão.
export interface CliCommand {
  name: string
  description: string
  argumentHint?: string
}

export interface CliModel {
  value: string
  resolvedModel?: string
  displayName: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
  /** R11 (sonda probe-fast, 2026-08-18): o claude publica por modelo — só
   *  Opus 5 hoje. Modelo sem a marca fica off em silêncio ao ligar fast. */
  supportsFastMode?: boolean
}

export interface CliCaps {
  commands: CliCommand[]
  models: CliModel[]
  account?: { email?: string; subscriptionType?: string }
}

// ————— janela de contexto por modelo —————
// A janela REAL é medição do CLI, não chute nosso: ela vem em
// `result.modelUsage[<modelo>].contextWindow` (ver claudeReportedContextWindow).
// A tabela abaixo é só o PISO até o primeiro `result` do processo, porque o
// `init` acontece antes de existir qualquer medição.
//
// SONDADO em scripts/probe-claude-caps-context.mjs (claude 2.1.233, 2026-08-15):
// o handshake `initialize` NÃO informa janela nenhuma por modelo — as entradas
// têm só value/resolvedModel/displayName/description/supports*. Por isso a
// tabela existe, e por isso ela é curada à mão.
//
// A HEURÍSTICA ANTIGA (`model.includes('[1m]') ? 1M : 200k`) estava ERRADA: o
// `model` do system/init traz o modelo RESOLVIDO e ele nem sempre carrega o
// sufixo — `--model claude-fable-5[1m]` chega como `claude-fable-5`, e Fable 5
// é 1M. Era esse o "Fable 5 com 200k" que o dono via.
//
// Catálogo de referência (Anthropic, cache 2026-06): fable/mythos/opus (5, 4.8,
// 4.7, 4.6, 4.5) e sonnet (5, 4.6) = 1M; haiku 4.5 = 200K.
//
// REGRA DE RE-SONDA: toda vez que um CLI atualizar ou uma família nova de
// modelo aparecer, rodar a probe de novo — nunca editar esta tabela de memória.
export const CLAUDE_CONTEXT_WINDOW_1M = 1_000_000
export const CLAUDE_CONTEXT_WINDOW_DEFAULT = 200_000

/**
 * CONTEXTO VIVO A PARTIR DO USO DE UMA MENSAGEM.
 *
 * A régua certa é a de UMA chamada de API: `input + cache_creation + cache_read`
 * é literalmente o prompt que o modelo acabou de ler, e `output` é o que ele
 * escreveu e que a próxima chamada vai reler. A soma dos quatro é a ocupação da
 * janela neste instante.
 *
 * POR QUE NÃO O `usage` DO `result` (o bug que isto conserta, 2026-08-17): ele
 * é o AGREGADO do turno — a soma de todas as chamadas. Um turno com 12 idas ao
 * modelo conta o mesmo contexto cacheado 12 vezes. Medido no journal do dono:
 * quatro turnos agregaram 841.305 / 799.980 / 821.296 / 528.703 tokens enquanto
 * o contexto real crescia monotonicamente 109.626 → 145.669 → 174.485 →
 * 176.669. O popover mostrava "53% da janela" no momento em que o próprio
 * `/context` do CLI respondia "176.3k / 1m (18%)". Agregado dividido por janela
 * não é porcentagem de nada — e passa de 100% com facilidade.
 *
 * `undefined` = não houve medição (mensagem sintética de comando local vem com
 * tudo zerado, e zero NÃO é uma medição: publicá-lo apagava o medidor).
 */
export function claudeMessageContextTokens(
  usage:
    | {
        input_tokens?: number
        output_tokens?: number
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
      }
    | undefined
): number | undefined {
  if (!usage) return undefined
  const part = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  const prompt =
    part(usage.input_tokens) +
    part(usage.cache_creation_input_tokens) +
    part(usage.cache_read_input_tokens)
  // Sem prompt não houve chamada de verdade: um `usage` todo zerado é a
  // assinatura da mensagem sintética (aviso de limite, saída de comando local).
  if (prompt === 0) return undefined
  return prompt + part(usage.output_tokens)
}

/**
 * CUSTO ACUMULADO DESTE PROCESSO DO CLI.
 *
 * `total_cost_usd` é cumulativo, não do turno: no journal do dono a mesma
 * conversa reportou 3,125724 → 6,290976 → 8,993965 → 9,650348 em quatro turnos,
 * e caiu para valores menores exatamente quando um processo novo nasceu
 * (respawn/retomada zeram a contagem do CLI). É por isso que a UI o chama de
 * acumulado da sessão, e não de custo da pergunta.
 *
 * `undefined` para qualquer coisa que não seja um valor positivo: turno de
 * comando local (`/usage`, `/context`) fecha com `total_cost_usd: 0` e esse
 * zero, publicado, APAGAVA o acumulado verdadeiro do medidor.
 */
export function claudeSessionCostUsd(total: unknown): number | undefined {
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return undefined
  return total
}

/** Piso curado por família. Função PURA — o teste cobre cada ramo. */
export function claudeCuratedContextWindow(model: string): number {
  const id = model.toLowerCase()
  // Marcador explícito do CLI ganha de tudo: quando ele aparece, é 1M por
  // definição (e continua valendo para família que a tabela não conheça).
  if (id.includes('[1m]')) return CLAUDE_CONTEXT_WINDOW_1M
  // Haiku é a exceção de 200K DENTRO das famílias atuais — testar antes do
  // resto para nunca cair no ramo de 1M por engano.
  if (/haiku/.test(id)) return CLAUDE_CONTEXT_WINDOW_DEFAULT
  if (/fable|mythos|opus|sonnet/.test(id)) return CLAUDE_CONTEXT_WINDOW_1M
  // Desconhecido: 200K é o piso conservador — nunca prometer janela que o
  // modelo pode não ter. O primeiro `result` corrige com a medição real.
  return CLAUDE_CONTEXT_WINDOW_DEFAULT
}

/** Janela AUTORITATIVA informada pelo próprio CLI no `result`. A chave do
 *  `modelUsage` bate literalmente com o `model` do system/init (com ou sem
 *  `[1m]` — sondado nas duas formas); o mapa também traz modelos de tarefas
 *  auxiliares, então a leitura é SEMPRE indexada pelo modelo da conversa. */
export function claudeReportedContextWindow(
  modelUsage: Record<string, { contextWindow?: number }> | undefined,
  model: string | null
): number | undefined {
  if (!modelUsage || !model) return undefined
  const window = modelUsage[model]?.contextWindow
  return typeof window === 'number' && Number.isSafeInteger(window) && window > 0
    ? window
    : undefined
}

// ————— pergunta estruturada (AskUserQuestion → card de opções no chat GUI) —————
// Formas FIXADAS no contrato 2.0 (Anexo A do CONTRATO_CHAT_2_0) — o renderer
// copia VERBATIM. O input chega no can_use_tool e a resposta viaja no
// updatedInput do MESMO control_response da permissão.

export interface GuiQuestionOption {
  label: string
  description?: string
}

export interface GuiQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: GuiQuestionOption[]
}

export const GUI_QUESTION_MAX_COUNT = 8
export const GUI_QUESTION_OPTION_MAX_COUNT = 12
export const GUI_PLAN_MAX_CHARS = 64 * 1024

/**
 * R7-E — a palavra HONESTA do terminal interrompido, nos DOIS motores (o Codex
 * a importa daqui). Ela ocupa o lugar onde o claude não põe nada e o harness
 * carimbava 'erro sem detalhe'. Quem pinta a tela não a usa (o fio tem a nota
 * neutra e o card tem a palavra do dono): ela existe para todo consumidor que
 * lê `errorText` cru — caixa-preta, diagnóstico, replay antigo — nunca ler uma
 * falha onde houve uma decisão do dono.
 */
export const GUI_OWNER_INTERRUPT_LABEL = 'interrompido pelo dono'

function boundedGuiText(value: unknown, cap: number): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.length <= cap ? value : value.slice(0, Math.max(0, cap - 1)) + '…'
}

/** Parse DEFENSIVO do input do AskUserQuestion. Qualquer coisa fora do molde
 *  devolve undefined e o pedido segue como permissão genérica — pergunta
 *  ilegível nunca some muda. */
export function parseGuiQuestions(input: Record<string, unknown>): GuiQuestion[] | undefined {
  const raw = input['questions']
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const questions: GuiQuestion[] = []
  for (const item of raw.slice(0, GUI_QUESTION_MAX_COUNT)) {
    if (!item || typeof item !== 'object') return undefined
    const q = item as Record<string, unknown>
    const questionText = boundedGuiText(q['question'], 2_000)
    if (!questionText?.trim()) return undefined
    const rawOptions = q['options']
    if (!Array.isArray(rawOptions) || rawOptions.length === 0) return undefined
    const options: GuiQuestionOption[] = []
    for (const opt of rawOptions.slice(0, GUI_QUESTION_OPTION_MAX_COUNT)) {
      if (!opt || typeof opt !== 'object') return undefined
      const o = opt as Record<string, unknown>
      const label = boundedGuiText(o['label'], 240)
      if (!label?.trim()) return undefined
      const description = boundedGuiText(o['description'], 1_000)
      options.push({
        label,
        ...(description ? { description } : {})
      })
    }
    const header = boundedGuiText(q['header'], 160)
    questions.push({
      question: questionText,
      ...(header ? { header } : {}),
      ...(typeof q['multiSelect'] === 'boolean' ? { multiSelect: q['multiSelect'] } : {}),
      options
    })
  }
  return questions
}

export type SessionEvent =
  | {
      type: 'init'
      model: string
      sessionId: string
      permissionMode: string
      toolCount: number
      contextWindow?: number
    }
  | { type: 'delta'; text: string }
  /** `text` = delta do raciocínio quando o backend o entrega (aditivo: quem
   *  só acende um spinner continua funcionando sem ler o campo). */
  | { type: 'thinking'; text?: string }
  | { type: 'turn-started' }
  | { type: 'turn-continuation'; continues: boolean }
  | {
      type: 'session-restarted'
      ready: boolean
      /** R12: a geração nova retomou a MESMA conversa (`sameConversation` no
       *  registro). Ausente/false = geração nova (troca de conta/CLI, sessão
       *  nova). Quem apresenta usa o carimbo para não piscar "abrindo" numa
       *  conversa que nunca saiu do lugar. */
      resumed?: boolean
      /** Fotografia canônica já persistida para a mesma conversa. */
      contextTokens?: number | null
      contextWindow?: number | null
    }
  /** /clear explícito: zera somente o fio desta conversa no renderer. */
  | { type: 'conversation-cleared' }
  /** Estado silencioso do composer. `null` significa usar o padrão do CLI. */
  | { type: 'executor-changed'; model: string | null; effort: string | null }
  | {
      type: 'user-message'
      id: string
      text: string
      /** Anexos já validados pelo main; o transcript mostra chips, nunca paths
       * despejados dentro da fala do usuário. */
      attachments?: GuiAttachmentDescriptor[]
      at: number
    }
  | { type: 'text'; text: string }
  | {
      type: 'tool'
      name: string
      input: Record<string, unknown>
      toolUseId?: string
      /** Relação explícita do stream-json do Claude. É metadado opaco de
       *  protocolo: a apresentação nunca tenta deduzi-la pelo nome da tool. */
      parentToolUseId?: string
    }
  | {
      type: 'tool-result'
      text: string
      isError: boolean
      /** `interrupted` (R6.1, 2026-08-18) não vem de CLI nenhum: é o desfecho
       *  que o harness sintetiza no card de um AJUDANTE parado de forma
       *  preservadora — ele não terminou (`completed`), não caiu (`failed`) e
       *  não foi jogado fora (`cancelled`); dele se volta. */
      outcome?: 'completed' | 'failed' | 'denied' | 'cancelled' | 'interrupted'
      toolUseId?: string
      /** Metadados do output INTEIRO, calculados antes do preview capado. */
      lineCount?: number
      truncated?: boolean
      /** Ciclo de vida de subagente em background (Claude). 'launched' = recibo de
       *  despacho (async_launched) — o agente segue vivo; 'settled' = terminal factual
       *  (task_notification ou reconciliação). Ausente em tool-result comum e no Codex. */
      agentStatus?: 'launched' | 'settled'
      /** task_id do CLI (== agentId do ACK). Presente sempre que agentStatus existir. */
      agentTaskId?: string
    }
  | {
      type: 'permission'
      requestId: string
      toolUseId?: string
      toolName: string
      description: string
      inputPretty: string
      reason?: string
      permissionRule?: string
      canAlways: boolean
    }
  | { type: 'permission-cancel'; requestId: string }
  | {
      type: 'interaction-resolved'
      requestId: string
      resolution:
        | {
            kind: 'permission'
            toolUseId?: string
            toolName: string
            behavior: PermissionChoice
          }
        | { kind: 'question'; entries: { question: string; answer: string }[] }
        | { kind: 'plan'; approve: boolean }
        /** Proposta de plano: aprovada = o Plan nasceu (id no eco). */
        | { kind: 'plan-proposal'; approve: boolean; planId?: string; planTitle?: string }
        | { kind: 'stale' }
    }
  /** AskUserQuestion virou card de opções (2.0): a resposta volta por
   *  answerQuestion, no mesmo canal de control_response da permissão. */
  | { type: 'question'; requestId: string; questions: GuiQuestion[] }
  /** ExitPlanMode (modo plano): o plano em markdown para o dono aprovar
   *  (answerPlanReview) — construir = allow, revisar = deny. */
  | { type: 'plan-review'; requestId: string; plan: string }
  /**
   * PROPOSTA DE PLANO (2.0, onda D). Único evento desta união que NÃO nasce do
   * CLI: o pane de planejamento chama a tool `propose_plan` e o HARNESS
   * sintetiza o evento no anel daquele pane (guiSessions.proposePlan). Por
   * isso ele também não bloqueia o turno — a tool responde na hora, o agente
   * encerra, e o card sobrevive ao `result` esperando o clique do dono.
   */
  | { type: 'plan-proposal'; requestId: string; draft: PlanDraft }
  | { type: 'session-id'; sessionId: string }
  | { type: 'ready'; caps: CliCaps }
  | { type: 'command-output'; text: string }
  /** Medição canônica do contexto vivo; `null` significa que o backend não a informou. */
  | { type: 'context-usage'; contextTokens: number | null; contextWindow: number | null }
  | { type: 'command-completed'; isError: boolean; continues: boolean; errorText?: string }
  | { type: 'limit'; text: string }
  | {
      type: 'result'
      isError: boolean
      outcome?: 'completed' | 'failed' | 'cancelled'
      /**
       * R7-E (2026-08-18) — INTERROMPIDO NÃO É "FALHOU ERRO SEM DETALHE".
       * Presente (e só `true`) quando o ■ DO DONO passou por ESTE motor para
       * ESTE turno: o terminal que chegou é aquela interrupção, não um desfecho
       * qualquer. Campo ADITIVO (espelho declarado em guiApi.ts). Quando ele
       * existe o motor já normalizou o resto — `isError: false`,
       * `outcome: 'cancelled'`, `errorText` com a palavra honesta —, e a
       * BANDEIRA ainda ganha do resto lá na frente: quem a lê decide antes de
       * olhar `isError`. Ausente = desfecho comum, lido exatamente como antes.
       */
      interrupted?: true
      /** Outra mensagem já foi aceita pelo stream e continua trabalhando. */
      continues?: boolean
      errorText?: string
      /* texto final do turno — comandos locais (ex.: /usage) respondem por
         mensagem assistant SINTÉTICA e o texto só aparece aqui, não em
         <local-command-stdout> (sondado 2026-07-23) */
      resultText?: string
      contextTokens?: number
      contextWindow?: number
      fastModeState?: string
      costUsd?: number
    }
  | { type: 'fatal'; text: string }
  | { type: 'closed'; code: number | null }

// ————— O LIMITE FALA A VERDADE (R21, print do dono 2026-08-19) —————
//
// Queixa dele, com a correção ao vivo: "tá avisando toda hora que o limite
// acabou… não acabou, porque ele tá rodando ainda — deve ser um aviso de que
// tá ACABANDO e a gente tá entendendo que ACABOU. Tem que ter essa distinção".
// O `status` do `rate_limit_event` é o campo ESTRUTURAL que separa os dois:
// `allowed_warning` é AVISADO-E-AINDA-PERMITIDO (no print as edições seguem
// passando ✓ depois de cada card) e só os outros status não-allowed param de
// verdade. Nada aqui lê PALAVRA de texto nenhum — a régua da casa proíbe
// heurística de conteúdo; o gatilho é sempre o campo do protocolo.

export interface GuiRateLimitInfo {
  status?: string
  resetsAt?: number
}

/** A RECEITA, em UMA voz (R21.3): o beco sem saída é bug de primeira classe,
 *  então toda fala do limite termina dizendo o que destrava — e que trocar não
 *  custa a conversa (o `missions:setChatSeat` transplanta e retoma). */
export const GUI_LIMIT_RECIPE =
  'troque a conta no cabeçalho do chat: a conversa continua na conta nova'

/** Só o STATUS diz se parou. `allowed` e `allowed_warning` continuam passando;
 *  pintá-los de bloqueio é exatamente a mentira que o dono viu. */
export function guiRateLimitBlocks(status: string | undefined): boolean {
  return Boolean(status) && status !== 'allowed' && status !== 'allowed_warning'
}

function guiLimitClock(resetsAt: number | undefined): string {
  return resetsAt ? new Date(resetsAt * 1000).toLocaleTimeString('pt-BR') : ''
}

/** Chave de ESTADO do limite: o CLI emite o evento a CADA request, e repetir o
 *  mesmo carimbo a cada lote foi o "avisando toda hora". Um carimbo por
 *  mudança — mudou o status ou o horário, é estado novo e fala de novo. */
function guiRateLimitKey(status: string, resetsAt: number | undefined): string {
  return `${status}|${resetsAt ?? ''}`
}

export interface GuiRateLimitTranslation {
  /** Evento a publicar; ausente = nada mudou (ou o limite passou). */
  event?: SessionEvent
  /** Estado já ANUNCIADO, para o chamador guardar e devolver no próximo. */
  key: string | null
}

/**
 * A tradução `rate_limit_event → SessionEvent`, PURA (o teste prova
 * comportamento sem processo nenhum): aviso vira NOTA e o turno segue;
 * bloqueio de verdade vira ERRO com a receita; o mesmo estado não re-emite.
 */
export function translateGuiRateLimit(
  info: GuiRateLimitInfo | undefined,
  lastKey: string | null
): GuiRateLimitTranslation {
  const status = info?.status
  // Evento sem status não é fato: não fala e não mexe no que já foi dito.
  if (!status) return { key: lastKey }
  // Liberado de novo: esquece o carimbo para o próximo aviso poder falar.
  if (status === 'allowed') return { key: null }
  const key = guiRateLimitKey(status, info?.resetsAt)
  if (key === lastKey) return { key }
  const clock = guiLimitClock(info?.resetsAt)
  if (!guiRateLimitBlocks(status)) {
    return {
      key,
      event: {
        type: 'command-output',
        text: `aviso: o limite do plano está se APROXIMANDO (${status}) — nada parou${
          clock ? ` · renova ${clock}` : ''
        }`
      }
    }
  }
  return {
    key,
    event: {
      type: 'limit',
      text: `rate limit do plano atingido (${status})${
        clock ? ` · libera ${clock}` : ''
      } — ${GUI_LIMIT_RECIPE}`
    }
  }
}

/**
 * UMA VOZ PARA O LIMITE (R21.3, 2º print do dono): quando o motor JÁ sabe que
 * a janela está bloqueada, o card do result fala PT-BR com a receita no lugar
 * do inglês cru do CLI ("You've hit your session limit"). O gatilho é o ESTADO
 * armado pelo `rate_limit_event` — jamais as palavras do erro.
 * `undefined` = não vestir (deixa o texto do CLI passar intacto), inclusive
 * quando a janela anunciada JÁ venceu: dizer "limite" depois do horário de
 * liberação seria mentir na direção oposta.
 */
export function guiLimitResultText(
  blocked: GuiRateLimitInfo | null,
  now = Date.now()
): string | undefined {
  if (!blocked?.status) return undefined
  if (blocked.resetsAt && blocked.resetsAt * 1000 <= now) return undefined
  const clock = guiLimitClock(blocked.resetsAt)
  return `o turno parou no limite do plano (${blocked.status})${
    clock ? ` · libera ${clock}` : ''
  } — ${GUI_LIMIT_RECIPE}`
}

/**
 * A QUEDA DO PROVEDOR fala PT-BR (pedido do dono, print 2026-08-19: "API
 * Error: 500 Internal server error…" cru no card — "foi porque o Claude caiu;
 * dá pra deixar mais bonitinho").
 *
 * A assinatura casada é o WRAPPER do próprio CLI (`API Error: 5xx…`) — o mesmo
 * precedente SONDADO do matcher transitório dos ajudantes
 * (`GUI_HELPER_TRANSIENT_SIGNATURES`, guiHelperSessions.ts): assinatura de
 * protocolo do CLI, nunca heurística sobre as palavras do modelo. Só a família
 * 5xx entra (erro do LADO DE LÁ, geralmente passageiro); 4xx é problema desta
 * conta/pedido e vestir esconderia o motivo real. `undefined` = passa cru.
 */
export function guiProviderOutageText(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const wrapper = /^API Error:?\s*(5\d\d)\b/iu.exec(raw.trim())
  if (!wrapper) return undefined
  return (
    `o provedor do Claude falhou do lado de LÁ (API ${wrapper[1]} — erro do servidor, ` +
    'geralmente passageiro) · mande a mensagem de novo: a conversa continua daqui'
  )
}

export type PermissionChoice = 'allow' | 'allow-always' | 'deny'

interface PendingPermission {
  toolUseId?: string
  toolName: string
  description: string
  input: Record<string, unknown>
  suggestions: unknown[]
}

interface StreamLine {
  type?: string
  subtype?: string
  /** `null` é o valor normal das mensagens da raiz; filhos carregam o id da
   *  tool de delegação. O valor só atravessa a fronteira depois do narrow. */
  parent_tool_use_id?: string | null
  request_id?: string
  fast_mode_state?: string
  total_cost_usd?: number
  response?: {
    subtype?: string
    request_id?: string
    error?: string
    response?: {
      commands?: CliCommand[]
      models?: CliModel[]
      account?: { email?: string; subscriptionType?: string }
    }
  }
  model?: string
  session_id?: string
  permissionMode?: string
  tools?: string[]
  result?: string
  is_error?: boolean
  // ————— tarefas de fundo (subagentes do Claude), todas sob type 'system' —————
  /** task_started / task_updated / task_progress / task_notification. */
  task_id?: string
  /** task_started e task_notification são os ÚNICOS que unem os dois espaços de id. */
  tool_use_id?: string
  /** Enum ABERTO do CLI no task_notification. */
  status?: string
  summary?: string
  output_file?: string
  subagent_type?: string
  task_type?: string
  description?: string
  patch?: { status?: string; end_time?: number }
  /** background_tasks_changed: fotografia COMPLETA das tarefas vivas. Com o
   *  conjunto vazio a chave é OMITIDA — ausência é conjunto vazio. */
  tasks?: { task_id?: string; task_type?: string; description?: string }[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  /** Mapa POR MODELO do `result` com a janela REAL medida pelo CLI. A chave é o
   *  mesmo id que o system/init anuncia. Enum ABERTO: modelos de tarefas
   *  auxiliares (ex.: haiku de título) aparecem aqui sem serem o da conversa. */
  modelUsage?: Record<string, { contextWindow?: number }>
  rate_limit_info?: { status?: string; resetsAt?: number }
  request?: {
    subtype?: string
    tool_use_id?: string
    tool_name?: string
    display_name?: string
    description?: string
    input?: Record<string, unknown>
    permission_suggestions?: unknown[]
    decision_reason?: string
  }
  event?: {
    type?: string
    delta?: { type?: string; text?: string }
  }
  message?: {
    role?: string
    /** Uso da MENSAGEM (uma chamada de API). É o único lugar do stream que
     *  mede contexto — o `usage` do `result` é a SOMA do turno inteiro. */
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
    content?:
      | string
      | {
          type?: string
          id?: string
          tool_use_id?: string
          text?: string
          name?: string
          input?: Record<string, unknown>
          content?: unknown
          is_error?: boolean
        }[]
  }
  /** O ACK do Agent traz o recibo estruturado: `AgentOutput` do sdk-tools é
   *  união discriminada por `status` ('completed' | 'async_launched' |
   *  'remote_launched') — tratar como enum ABERTO. */
  tool_use_result?: {
    stdout?: string
    stderr?: string
    isAsync?: boolean
    status?: string
    agentId?: string
  }
}

/** O stream-json mistura mensagens da conversa raiz e dos agentes filhos.
 *  Somente a raiz pode alimentar texto/animação/terminal do chat; o id do pai
 *  continua sendo propagado nas ferramentas para a lateral acompanhar o filho. */
export function guiClaudeParentToolUseId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    ? value
    : undefined
}

const IDLE_TIMEOUT = 600_000 // 10 min sem NENHUM evento (permissão pendente pausa)
const INTERRUPT_CONFIRM_TIMEOUT = 10_000
const INIT_CONFIRM_TIMEOUT = 20_000
const DETAIL_MAX = 2000

function firstLines(text: string, max: number): string {
  const sliced = text.slice(0, Math.max(0, max) + 1).trim()
  return sliced.length <= max ? sliced : sliced.slice(0, max) + '…'
}

function prettyGuiInput(input: Record<string, unknown>): string {
  try {
    return firstLines(JSON.stringify(limitGuiToolInput(input), null, 2), DETAIL_MAX)
  } catch {
    return '{ pedido indisponível para visualização }'
  }
}

function toolResultEvent(
  raw: string,
  isError: boolean,
  toolUseId?: string
): Extract<SessionEvent, { type: 'tool-result' }> {
  const details = guiToolResultDetails(raw)
  return {
    type: 'tool-result',
    text: details.text,
    isError,
    outcome: isError ? 'failed' : 'completed',
    toolUseId,
    lineCount: details.lineCount,
    truncated: details.truncated
  }
}

/** Recibo de DESPACHO de subagente: o card continua ABERTO. `outcome` fica
 *  OMITIDO de propósito — presença de desfecho é o que a apresentação lê como
 *  terminal, e o agente acabou de começar. */
function agentLaunchedEvent(
  raw: string,
  toolUseId: string,
  agentTaskId: string
): Extract<SessionEvent, { type: 'tool-result' }> {
  const details = guiToolResultDetails(raw)
  return {
    type: 'tool-result',
    text: details.text,
    isError: false,
    toolUseId,
    lineCount: details.lineCount,
    truncated: details.truncated,
    agentStatus: 'launched',
    agentTaskId
  }
}

/** Terminal FACTUAL do subagente (task_notification, reconciliação, cancelamento). */
function agentSettledEvent(
  raw: string,
  toolUseId: string,
  agentTaskId: string,
  outcome: 'completed' | 'failed' | 'cancelled',
  isError: boolean
): Extract<SessionEvent, { type: 'tool-result' }> {
  const details = guiToolResultDetails(raw)
  return {
    type: 'tool-result',
    text: details.text,
    isError,
    outcome,
    toolUseId,
    lineCount: details.lineCount,
    truncated: details.truncated,
    agentStatus: 'settled',
    agentTaskId
  }
}

export class MaestroSession {
  readonly opts: MaestroSessionOpts
  personaSent = false
  readyAnnounced = false
  fastWarned = false
  caps: CliCaps | null = null
  private child: ChildProcessWithoutNullStreams
  private emit: (evt: SessionEvent) => void
  private protocol = new GuiProtocolStream()
  private stderrTail = ''
  private announced = false
  private killed = false
  private closed = false
  private initTimer: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private turnSilenceTimer: NodeJS.Timeout | null = null
  private pending = new Map<string, PendingPermission>()
  private initReqId = randomUUID()
  private capsWaiters: ((caps: CliCaps | null) => void)[] = []
  private controlWaiters = new Map<string, (ok: boolean) => void>
  /** Tarefas de fundo desta sessão; morre com o processo (nunca é retomada). */
  private claudeTasks = new GuiClaudeTaskRegistry()
  private turnGeneration = 0
  private pendingTurnGenerations: number[] = []
  private activeTurnGeneration: number | null = null
  private interruptGeneration: number | null = null
  private interruptRequestId: string | null = null
  private interruptTimer: NodeJS.Timeout | null = null
  /** Modelo anunciado pelo último `system/init`: é a chave do `modelUsage` no
   *  `result`. Trocar de modelo reemite init, então este campo acompanha. */
  private initModel: string | null = null
  /** Janela REAL já medida pelo CLI para `initModel` neste processo. Existe
   *  porque o `init` REPETE a cada turno carregando o piso curado: sem esta
   *  memória, cada volta rebaixaria a medição de volta ao piso — e o piso
   *  acabava PERSISTIDO como se fosse medição. */
  private measuredWindow: number | undefined = undefined
  /** Contexto medido na ÚLTIMA chamada de API deste turno — ver
   *  `claudeMessageContextTokens`. Zerado a cada `result` para que um turno sem
   *  chamada nenhuma (comando local) não republique a medição do turno anterior
   *  como se fosse dele. */
  private turnContextTokens: number | undefined = undefined
  /** Último estado de limite JÁ anunciado (R21.1) — a dedução da repetição
   *  mora aqui: o CLI reemite o evento a cada request. */
  private rateLimitKey: string | null = null
  /** Limite que está BLOQUEANDO agora (R21.3). `null` = nada armado: o erro do
   *  result passa com o texto do próprio CLI. */
  private rateLimitBlocked: GuiRateLimitInfo | null = null

  /**
   * RÉGUA ÚNICA DA JANELA deste processo. A medição do CLI manda
   * (`claudeReportedContextWindow` no `result`, memorizada em `measuredWindow`);
   * o piso curado só cobre o intervalo até o primeiro `result` deste modelo.
   *
   * O `init` e o `context-usage` ao vivo (R20.1) leem DAQUI de propósito: com
   * uma régua só, a janela anunciada no meio do turno e a do fecho do turno não
   * têm como contar histórias diferentes.
   */
  private contextWindowNow(): number {
    return this.measuredWindow ?? claudeCuratedContextWindow(this.initModel ?? '')
  }

  constructor(opts: MaestroSessionOpts, emit: (evt: SessionEvent) => void) {
    this.opts = opts
    this.emit = emit

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: freshWindowsPath()
    }
    // App lançado de dentro de uma sessão do Claude Code: os marcadores
    // CLAUDE_CODE_*/CLAUDECODE herdados fazem o CLI filho rodar como "child
    // session" SEM salvar transcript (sondado no 2.1.218) — o que mata o
    // --resume e a telemetria. Limpar sempre, como o pty.ts faz.
    for (const k of Object.keys(env)) {
      if (/^CLAUDE_CODE_/i.test(k)) delete env[k]
    }
    delete env['CLAUDECODE']
    if (opts.configDir) env['CLAUDE_CONFIG_DIR'] = opts.configDir
    // Depois da higiene: o env do chamador é intencional e não pode ser comido
    // pela varredura de marcadores herdados acima.
    for (const [key, value] of Object.entries(opts.extraEnv ?? {})) env[key] = value

    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      // Permissões chegam como control_request na stream e o usuário decide
      // na UI — nada de auto-negar escondido.
      '--permission-prompt-tool',
      'stdio'
    ]
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId)
    if (opts.systemPromptFile)
      args.push('--append-system-prompt-file', opts.systemPromptFile)
    if (opts.model) args.push('--model', opts.model)
    if (opts.effort) args.push('--effort', opts.effort)
    if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode)
    if (opts.fastMode) {
      // O comando /fast é bloqueado em modo SDK, mas a CHAVE de settings liga
      // o fast mode de verdade (validado: result.fast_mode_state=on). Com
      // shell no Windows, o JSON precisa da camada extra de aspas.
      const settings = JSON.stringify({ fastMode: true })
      args.push('--settings', process.platform === 'win32' ? JSON.stringify(settings) : settings)
    }
    if (opts.extraArgs?.length) args.push(...opts.extraArgs)

    // claude é shim .cmd no Windows — precisa de shell.
    this.child = spawn('claude', args, {
      cwd: opts.cwd,
      env,
      shell: process.platform === 'win32'
    })

    this.child.stdout.on('data', (d: Buffer) => {
      const chunk = this.protocol.push(d)
      for (const line of chunk.lines) {
        this.handleLine(line)
        if (!this.alive) return
      }
      if (chunk.overflow) {
        this.emit({ type: 'fatal', text: 'o Claude excedeu o limite de uma mensagem de protocolo' })
        this.kill()
        return
      }
      this.resetIdle()
    })
    this.child.stderr.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-1000)
    })
    this.child.on('error', (e) => {
      this.closed = true
      this.clearInitGuard()
      this.clearIdle()
      this.clearTurnSilence()
      this.clearInterruptGuard()
      this.cancelPendingInteractions()
      this.cancelLiveAgents()
      this.pendingTurnGenerations = []
      this.activeTurnGeneration = null
      this.emit({ type: 'fatal', text: e.message })
    })
    // Handshake: a resposta traz comandos, modelos e conta REAIS do CLI.
    this.write({
      type: 'control_request',
      request_id: this.initReqId,
      request: { subtype: 'initialize' }
    })
    this.initTimer = setTimeout(() => {
      if (!this.alive || this.caps) return
      this.emit({ type: 'fatal', text: 'o Claude não confirmou a abertura da conversa' })
      this.kill()
    }, INIT_CONFIRM_TIMEOUT)

    this.child.on('close', (code) => {
      const failedBeforeClose = this.closed
      this.closed = true
      this.clearInitGuard()
      const final = this.protocol.end()
      for (const line of final.lines) this.handleLine(line)
      this.clearIdle()
      this.clearTurnSilence()
      this.clearInterruptGuard()
      this.cancelPendingInteractions()
      // Agente de fundo morre com o processo: cancela ANTES do terminal, para
      // o card nunca ficar preso em "trabalhando" depois da conversa fechar.
      this.cancelLiveAgents()
      this.pendingTurnGenerations = []
      this.activeTurnGeneration = null
      for (const w of this.capsWaiters.splice(0)) w(this.caps)
      if (!this.killed && !failedBeforeClose) {
        const err = this.stderrTail.trim()
        this.emit({
          type: 'fatal',
          text: `o painel de fundo encerrou (exit ${code})${err ? ` · ${firstLines(err, 300)}` : ''}`
        })
      }
      this.emit({ type: 'closed', code })
    })
  }

  get alive(): boolean {
    return !this.killed && !this.closed && this.child.exitCode === null && this.child.signalCode === null
  }

  /** Mesmo destino de spawn? (mudar seat/modelo/effort/fast exige processo novo) */
  matches(opts: MaestroSessionOpts): boolean {
    return (
      this.opts.cwd === opts.cwd &&
      (this.opts.configDir ?? '') === (opts.configDir ?? '') &&
      (this.opts.systemPromptFile ?? '') === (opts.systemPromptFile ?? '') &&
      (this.opts.model ?? '') === (opts.model ?? '') &&
      (this.opts.effort ?? '') === (opts.effort ?? '') &&
      Boolean(this.opts.fastMode) === Boolean(opts.fastMode)
    )
  }

  send(text: string): void {
    const generation = ++this.turnGeneration
    this.pendingTurnGenerations = enqueueGuiTurn(this.pendingTurnGenerations, generation)
    this.activeTurnGeneration = this.pendingTurnGenerations[0] ?? null
    this.write({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] }
    })
    this.resetIdle()
  }

  /** Responde um pedido de permissão pendente; devolve o que foi decidido para logar. */
  answerPermission(
    requestId: string,
    choice: PermissionChoice
  ): { toolUseId?: string; toolName: string; description: string } | null {
    const req = this.pending.get(requestId)
    if (!req) return null
    this.pending.delete(requestId)
    const response =
      choice === 'deny'
        ? { behavior: 'deny', message: 'negado pelo usuário no painel do Maestro' }
        : {
            behavior: 'allow',
            updatedInput: req.input,
            ...(choice === 'allow-always' && req.suggestions.length > 0
              ? { updatedPermissions: req.suggestions }
              : {})
          }
    this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response }
    })
    this.resetIdle()
    return {
      ...(req.toolUseId ? { toolUseId: req.toolUseId } : {}),
      toolName: req.toolName,
      description: req.description
    }
  }

  /** Responde a AskUserQuestion pendente: allow com as escolhas DENTRO do
   *  updatedInput ({...input, answers}) — formato provado no claudecodeui.
   *  `answers` = { "<texto da pergunta>": "labels unidos por ', '" }; "pular"
   *  é answers {} com allow. Id stale → false, espelhando answerPermission. */
  answerQuestion(requestId: string, answers: Record<string, string>): boolean {
    const req = this.pending.get(requestId)
    if (!req) return false
    this.pending.delete(requestId)
    this.write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { behavior: 'allow', updatedInput: { ...req.input, answers } }
      }
    })
    this.resetIdle()
    return true
  }

  /** Veredito do modo plano (ExitPlanMode): construir = allow (updatedInput é
   *  o próprio input); revisar = deny com a frase que o CLI espera. */
  answerPlanReview(requestId: string, approve: boolean): boolean {
    const req = this.pending.get(requestId)
    if (!req) return false
    this.pending.delete(requestId)
    const response = approve
      ? { behavior: 'allow', updatedInput: req.input }
      : { behavior: 'deny', message: 'User asked to revise the plan' }
    this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response }
    })
    this.resetIdle()
    return true
  }

  interrupt(): boolean {
    if (this.activeTurnGeneration === null) return false
    const generation = this.activeTurnGeneration
    if (
      this.interruptGeneration === generation &&
      this.interruptRequestId !== null &&
      this.interruptTimer !== null
    )
      return true
    this.clearInterruptGuard()
    const requestId = randomUUID()
    this.interruptGeneration = generation
    this.interruptRequestId = requestId
    this.interruptTimer = setTimeout(() => {
      this.failInterrupt(generation, 'o Claude não confirmou a interrupção')
    }, INTERRUPT_CONFIRM_TIMEOUT)
    this.write({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'interrupt' }
    })
    return true
  }

  get turnActive(): boolean {
    return this.activeTurnGeneration !== null || this.pendingTurnGenerations.length > 0
  }

  /** Espera o handshake initialize responder (caps reais do CLI). */
  waitCaps(timeoutMs = 10_000): Promise<CliCaps | null> {
    if (this.caps) return Promise.resolve(this.caps)
    if (!this.alive) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.caps), timeoutMs)
      this.capsWaiters.push((caps) => {
        clearTimeout(timer)
        resolve(caps)
      })
    })
  }

  /** Troca de modelo AO VIVO via protocolo de controle (sem matar a sessão). */
  setModel(model: string): Promise<boolean> {
    if (!this.alive || this.turnActive) return Promise.resolve(false)
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.controlWaiters.delete(id)) return
        this.emit({
          type: 'fatal',
          text: 'o Claude não confirmou a troca de executor; encerrei a sessão para não usar um estado incerto'
        })
        resolve(false)
        this.kill()
      }, 10_000)
      this.controlWaiters.set(id, (ok) => {
        clearTimeout(timer)
        if (ok) this.opts.model = model === 'default' ? undefined : model
        resolve(ok)
      })
      this.write({
        type: 'control_request',
        request_id: id,
        request: { subtype: 'set_model', model }
      })
    })
  }

  kill(): void {
    if (this.killed) return
    this.killed = true
    this.clearInitGuard()
    this.cancelPendingInteractions()
    this.cancelLiveAgents()
    this.pendingTurnGenerations = []
    this.activeTurnGeneration = null
    this.clearIdle()
    this.clearTurnSilence()
    this.clearInterruptGuard()
    for (const waiter of this.capsWaiters.splice(0)) waiter(null)
    for (const waiter of this.controlWaiters.values()) waiter(false)
    this.controlWaiters.clear()
    terminateGuiProcessTree(this.child)
  }

  /** Modelo + effort na camada de flags da sessão viva. Um único request
   *  evita sucesso parcial: ou o CLI confirma o par inteiro, ou o chamador
   *  mantém a seleção anterior. `null` remove o override daquela chave. */
  setExecutor(input: { model?: string; effort?: string }): Promise<boolean> {
    if (!this.alive || this.turnActive) return Promise.resolve(false)
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.controlWaiters.delete(id)) return
        this.emit({
          type: 'fatal',
          text: 'o Claude não confirmou a troca; encerrei a sessão para não usar um estado incerto'
        })
        resolve(false)
        this.kill()
      }, 10_000)
      this.controlWaiters.set(id, (ok) => {
        clearTimeout(timer)
        if (ok) {
          this.opts.model = input.model
          this.opts.effort = input.effort
        }
        resolve(ok)
      })
      this.write({
        type: 'control_request',
        request_id: id,
        request: {
          subtype: 'apply_flag_settings',
          settings: {
            model: input.model ?? null,
            effortLevel: input.effort ?? null
          }
        }
      })
    })
  }

  private clearInitGuard(): void {
    if (this.initTimer) clearTimeout(this.initTimer)
    this.initTimer = null
  }

  private write(obj: unknown): void {
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n')
    } catch (e) {
      this.emit({ type: 'fatal', text: e instanceof Error ? e.message : String(e) })
    }
  }

  private resetIdle(): void {
    this.clearIdle()
    this.clearTurnSilence()
    // Permissão pendente = esperando o HUMANO, não o CLI. Sem timeout.
    if (this.pending.size > 0) return
    if (
      shouldArmGuiTurnWatchdog(
        this.opts.idleTimeoutMs,
        this.activeTurnGeneration !== null,
        false
      )
    ) {
      this.turnSilenceTimer = setTimeout(() => {
        if (!this.alive || this.activeTurnGeneration === null || this.pending.size > 0) return
        this.emit({ type: 'fatal', text: 'o Claude ficou sem responder durante o turno' })
        this.kill()
      }, GUI_ACTIVE_TURN_SILENCE_TIMEOUT)
    }
    const timeout = this.opts.idleTimeoutMs ?? IDLE_TIMEOUT
    if (timeout <= 0) return // relógio desligado (pane GUI)
    this.idleTimer = setTimeout(() => {
      this.emit({ type: 'fatal', text: 'sem resposta do CLI há 10 min — sessão encerrada' })
      this.kill()
    }, timeout)
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private clearTurnSilence(): void {
    if (this.turnSilenceTimer) clearTimeout(this.turnSilenceTimer)
    this.turnSilenceTimer = null
  }

  private cancelPendingInteractions(): void {
    const requestIds = [...this.pending.keys()]
    this.pending.clear()
    for (const requestId of requestIds) {
      this.emit({ type: 'permission-cancel', requestId })
    }
  }

  /** Encerra o card do subagente. Sem `tool_use_id` não há card para fechar —
   *  o registro sai do jeito que entrou, só sem prender mais o turno. */
  private emitAgentSettled(
    task: GuiClaudeTask,
    text: string,
    outcome: 'completed' | 'failed' | 'cancelled',
    isError: boolean
  ): void {
    if (!task.toolUseId) return
    this.emit(agentSettledEvent(text, task.toolUseId, task.taskId, outcome, isError))
  }

  /** Interrupção confirmada, `closed`, `fatal` e dispose levam os agentes de
   *  fundo junto: drena o registro e fecha cada card ANTES do terminal
   *  correspondente (com o pane já disposto, o sink descarta — mas o registro
   *  precisa zerar de qualquer forma para o `continues` não mentir). */
  private cancelLiveAgents(): void {
    for (const task of this.claudeTasks.settleAll()) {
      this.emitAgentSettled(task, 'subagente cancelado', 'cancelled', false)
    }
  }

  /** `task_notification` é o ÚNICO terminal que carrega os dois ids. `status` é
   *  enum ABERTO: encerra em QUALQUER valor — pendurar o agente seria pior que
   *  classificá-lo errado. */
  private settleAgentFromNotification(evt: StreamLine): void {
    const taskId = guiClaudeTaskId(evt.task_id)
    const settled = this.claudeTasks.noteSettled(taskId ?? evt.tool_use_id, evt.status)
    const toolUseId = guiClaudeTaskId(evt.tool_use_id) ?? settled?.toolUseId
    const agentTaskId = taskId ?? settled?.taskId
    // Sem os dois ids não há card endereçável; sem registro, a notificação
    // ainda vale (o task_started pode ter se perdido e o card não pode ficar
    // girando para sempre).
    if (!toolUseId || !agentTaskId) return
    const completed = evt.status === 'completed'
    const summary = typeof evt.summary === 'string' && evt.summary.trim() ? evt.summary : ''
    this.emit(
      agentSettledEvent(
        summary || (completed ? 'subagente concluído' : 'subagente falhou'),
        toolUseId,
        agentTaskId,
        completed ? 'completed' : 'failed',
        !completed
      )
    )
  }

  /** Fotografia autoritativa das tarefas vivas. Ela chega ~1ms ANTES do
   *  `task_notification` do mesmo agente, então a decisão espera o chunk
   *  inteiro atravessar o parser: o que ainda estiver vivo no microtask sumiu
   *  SEM terminal e é encerrado por reconciliação. */
  private reconcileAgents(tasks: StreamLine['tasks']): void {
    const missing = this.claudeTasks.reconcile(tasks)
    if (missing.length === 0) return
    queueMicrotask(() => {
      for (const task of missing) {
        const settled = this.claudeTasks.noteSettled(task.taskId)
        if (!settled) continue
        this.emitAgentSettled(
          settled,
          'encerrado (reconciliado sem notificação)',
          'completed',
          false
        )
      }
    })
  }

  /** Recibo de despacho do Agent. Só entra no ciclo de vida quando o PRÓPRIO
   *  recibo se declara assíncrono (`isAsync`/`async_launched`): tool-result
   *  comum nunca toca no registro. Sem os dois ids o card fecha como sempre —
   *  fail-closed, e a fotografia autoritativa ainda reconcilia o que sobrar. */
  private claudeAgentAck(
    block: { tool_use_id?: string; is_error?: boolean },
    result: StreamLine['tool_use_result'],
    raw: string
  ): Extract<SessionEvent, { type: 'tool-result' }> | null {
    if (result?.isAsync !== true && result?.status !== 'async_launched') return null
    const toolUseId = guiClaudeTaskId(block.tool_use_id)
    if (!toolUseId) return null
    const agentId = guiClaudeTaskId(result.agentId)
    if (block.is_error) {
      // Despacho que já nasce em erro encerra o agente na hora — nunca um
      // agente imortal segurando o turno.
      const settled = this.claudeTasks.noteSettled(agentId ?? toolUseId)
      const agentTaskId = agentId ?? settled?.taskId
      if (!agentTaskId) return null
      return agentSettledEvent(raw, toolUseId, agentTaskId, 'failed', true)
    }
    const agentTaskId = agentId ?? this.claudeTasks.taskFor(toolUseId)?.taskId
    if (!agentTaskId) return null
    this.claudeTasks.noteStarted(agentTaskId, toolUseId)
    return agentLaunchedEvent(raw, toolUseId, agentTaskId)
  }

  private clearInterruptGuard(): void {
    if (this.interruptTimer) clearTimeout(this.interruptTimer)
    this.interruptTimer = null
    this.interruptGeneration = null
    this.interruptRequestId = null
  }

  private failInterrupt(generation: number, message: string): void {
    if (
      !this.alive ||
      this.activeTurnGeneration !== generation ||
      this.interruptGeneration !== generation
    )
      return
    this.clearInterruptGuard()
    this.activeTurnGeneration = null
    this.emit({ type: 'fatal', text: message })
    this.kill()
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    const parsed = parseGuiProtocolLine<unknown>(line)
    if (!parsed.ok || !isGuiClaudeProtocolEnvelope(parsed.value)) {
      this.emit({ type: 'fatal', text: 'o Claude enviou uma resposta de protocolo inválida' })
      this.kill()
      return
    }
    const evt = parsed.value as StreamLine

    switch (evt.type) {
      case 'system': {
        if (guiClaudeParentToolUseId(evt.parent_tool_use_id)) break
        if (evt.subtype === 'init' && evt.session_id) {
          // init repete a cada turno — inclusive nos CICLOS AUTÔNOMOS que o CLI
          // roda a cada conclusão de agente, com o MESMO session_id. Anuncia uma
          // vez por processo, mas o session_id sobe sempre (resume pode trocar o
          // id). NUNCA é ponto de reset: zerar tarefas de fundo aqui perderia
          // justamente os agentes que provocaram o ciclo.
          const model = evt.model ?? 'claude'
          // O modelo do init é a CHAVE do modelUsage no `result` — guardar aqui
          // é o que permite ler a janela real do modelo DESTA conversa, e não a
          // de uma tarefa auxiliar que apareça no mesmo mapa.
          // Modelo NOVO invalida a medição do anterior: 1M medido no Fable não
          // vale para o Haiku que acabou de entrar.
          if (model !== this.initModel) this.measuredWindow = undefined
          this.initModel = model
          this.emit({
            type: 'init',
            model,
            sessionId: evt.session_id,
            permissionMode: evt.permissionMode ?? 'default',
            toolCount: evt.tools?.length ?? 0,
            // PISO só enquanto não há medição. Depois do primeiro `result`
            // deste modelo a janela REAL manda — o init repete a cada turno, e
            // reanunciar o piso apagaria a medição a cada volta. A régua é a
            // MESMA do evento vivo (`contextWindowNow`).
            contextWindow: this.contextWindowNow()
          })
          break
        }
        if (evt.subtype === 'task_started') {
          // Único envelope que une os dois espaços de id antes do ACK.
          this.claudeTasks.noteStarted(evt.task_id, evt.tool_use_id, {
            description: evt.description,
            subagentType: evt.subagent_type,
            taskType: evt.task_type
          })
          break
        }
        if (evt.subtype === 'task_updated' || evt.subtype === 'task_progress') {
          // Andamento não é terminal: atualiza o registro e não emite nada.
          this.claudeTasks.noteProgress(evt.task_id, evt.patch?.status ?? evt.status)
          break
        }
        if (evt.subtype === 'task_notification') {
          this.settleAgentFromNotification(evt)
          break
        }
        if (evt.subtype === 'background_tasks_changed') {
          this.reconcileAgents(evt.tasks)
          break
        }
        break
      }

      case 'stream_event': {
        if (guiClaudeParentToolUseId(evt.parent_tool_use_id)) break
        const inner = evt.event
        if (inner?.type === 'content_block_delta') {
          if (inner.delta?.type === 'text_delta' && inner.delta.text) {
            this.emit({ type: 'delta', text: inner.delta.text })
          } else if (inner.delta?.type === 'thinking_delta') {
            this.emit({ type: 'thinking', text: inner.delta.text })
          }
        }
        break
      }

      case 'assistant': {
        const content = evt.message?.content
        if (!Array.isArray(content)) break
        const parentToolUseId = guiClaudeParentToolUseId(evt.parent_tool_use_id)
        // MEDIÇÃO DO CONTEXTO: cada mensagem é uma chamada de API, e a ÚLTIMA
        // do turno é a que diz quanto da janela está ocupado. Sobrescrever a
        // cada mensagem é o certo — o turno pode ter uma dúzia delas.
        // Mensagem de SUBAGENTE fica de fora: ela tem contexto próprio e
        // somá-la aqui inflaria a janela da conversa do dono.
        if (!parentToolUseId) {
          const measured = claudeMessageContextTokens(evt.message?.usage)
          if (measured !== undefined) {
            this.turnContextTokens = measured
            // R20.1 — PARIDADE COM O CODEX: a medição é publicada NO INSTANTE em
            // que nasce, não retida até o `result`. O codex já faz exatamente
            // isto a cada `thread/tokenUsage/updated` (uma chamada de API = um
            // evento); segurar a do claude até o fecho congelava o medidor por
            // todo um turno longo — a queixa do dono. Sem throttle: é a mesma
            // classe de frequência do codex e o anel guarda `context-usage`
            // como STICKY (só a última fica, o transcript não incha).
            // A JANELA sai da régua única (`contextWindowNow`), a mesma que o
            // `result` alimenta com `claudeReportedContextWindow`: evento vivo e
            // fecho do turno nunca anunciam janelas diferentes.
            this.emit({
              type: 'context-usage',
              contextTokens: measured,
              contextWindow: this.contextWindowNow()
            })
          }
        }
        for (const block of content) {
          if (block.type === 'text' && block.text && !parentToolUseId) {
            this.emit({ type: 'text', text: block.text })
          } else if (block.type === 'tool_use' && block.name) {
            this.emit({
              type: 'tool',
              name: block.name,
              input: block.input ?? {},
              toolUseId: block.id,
              ...(parentToolUseId ? { parentToolUseId } : {})
            })
          }
        }
        break
      }

      case 'control_response': {
        const resp = evt.response
        if (!resp?.request_id) break
        if (resp.request_id === this.interruptRequestId) {
          if (resp.subtype === 'success') {
            // Interrupção CONFIRMADA: quem o dono mandou parar inclui os
            // subagentes daquele turno.
            this.cancelLiveAgents()
          } else if (this.interruptGeneration !== null) {
            this.failInterrupt(
              this.interruptGeneration,
              resp.error
                ? 'não deu para interromper o Claude — ' + firstLines(resp.error, 300)
                : 'o Claude recusou a interrupção'
            )
          }
        } else if (resp.request_id === this.initReqId) {
          this.clearInitGuard()
          if (resp.subtype === 'success' && resp.response) {
            this.caps = {
              commands: resp.response.commands ?? [],
              models: resp.response.models ?? [],
              account: resp.response.account
            }
            this.emit({ type: 'ready', caps: this.caps })
          } else {
            const detail = resp.error ? `: ${firstLines(resp.error, 300)}` : ''
            this.emit({ type: 'fatal', text: `handshake do Claude falhou${detail}` })
            for (const w of this.capsWaiters.splice(0)) w(null)
            this.kill()
            break
          }
          for (const w of this.capsWaiters.splice(0)) w(this.caps)
        } else {
          const waiter = this.controlWaiters.get(resp.request_id)
          if (waiter) {
            this.controlWaiters.delete(resp.request_id)
            waiter(resp.subtype === 'success')
          }
        }
        break
      }

      case 'user': {
        // Saída de comando local (/model via controle, etc.) vem como user
        // com content string "<local-command-stdout>…</local-command-stdout>".
        const content = evt.message?.content
        if (typeof content === 'string') {
          const m = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)
          if (m && m[1].trim()) {
            this.emit({ type: 'command-output', text: firstLines(m[1], 600) })
          }
          break
        }
        // Resultado de ferramenta volta como mensagem user com tool_result.
        if (!Array.isArray(content)) break
        for (const block of content) {
          if (block.type !== 'tool_result') continue
          const r = evt.tool_use_result
          const raw =
            r?.stdout || r?.stderr
              ? [r.stdout, r.stderr].filter(Boolean).join('\n')
              : typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? (block.content as { text?: string }[])
                      .map((c) => c.text ?? '')
                      .join('\n')
                  : ''
          // Resultado vazio também FECHA o card: comando silencioso não pode
          // ficar com spinner eterno. A contagem nasce antes do preview capado.
          this.emit(
            this.claudeAgentAck(block, r, raw) ??
              toolResultEvent(raw, Boolean(block.is_error), block.tool_use_id)
          )
        }
        break
      }

      case 'control_request': {
        const req = evt.request
        if (req?.subtype === 'can_use_tool' && evt.request_id && req.tool_name) {
          const input = req.input ?? {}
          const suggestions = resolveChatPermissionSuggestions(
            req.tool_name,
            input,
            req.permission_suggestions
          )
          const permissionRule = chatPermissionRuleLabel(suggestions)
          const toolName = firstLines(req.display_name ?? req.tool_name, 160)
          const description = firstLines(req.description ?? '', 500)
          // Interativo ou não, o pedido mora no MESMO `pending`: a resposta de
          // question/plan-review reusa o control_response da permissão, e o
          // control_cancel_request abaixo cobre os três tipos de graça.
          this.pending.set(evt.request_id, {
            ...(req.tool_use_id ? { toolUseId: req.tool_use_id } : {}),
            toolName,
            description,
            input,
            suggestions
          })
          this.resetIdle() // esperando o humano — nenhum relógio corre
          // PERGUNTA ESTRUTURADA (2.0): AskUserQuestion vira card de opções.
          // GOTCHA documentado no fork (claudecodeui): em acceptEdits/
          // bypassPermissions o caminho de permissão pode resolver ANTES do
          // can_use_tool e a pergunta nem chega (o modelo inventa a resposta)
          // — fora desta rodada; default/plan cobrem o caminho feliz.
          if (req.tool_name === 'AskUserQuestion') {
            const questions = parseGuiQuestions(input)
            if (questions) {
              this.emit({ type: 'question', requestId: evt.request_id, questions })
              break
            }
            // input torto → cai na permissão genérica (nunca engolir o pedido)
          }
          // MODO PLANO: ExitPlanMode carrega o plano em markdown (o fork
          // desfaz o \n escapado — mesma regra aqui).
          if (req.tool_name === 'ExitPlanMode' || req.tool_name === 'exit_plan_mode') {
            const rawPlan = boundedGuiText(input['plan'], GUI_PLAN_MAX_CHARS) ?? ''
            const plan = rawPlan.replace(/\\n/g, '\n')
            this.emit({ type: 'plan-review', requestId: evt.request_id, plan })
            break
          }
          this.emit({
            type: 'permission',
            requestId: evt.request_id,
            ...(req.tool_use_id ? { toolUseId: req.tool_use_id } : {}),
            toolName,
            description,
            inputPretty: prettyGuiInput(input),
            reason: boundedGuiText(req.decision_reason, 500),
            ...(permissionRule ? { permissionRule } : {}),
            canAlways: suggestions.length > 0
          })
        }
        break
      }

      case 'control_cancel_request':
        // Vale para permission E question/plan-review: os três moram no mesmo
        // `pending`, então o permission-cancel com o requestId limpa qualquer
        // um deles no renderer (contrato A.3 — visível nos testes do chat).
        if (evt.request_id && this.pending.delete(evt.request_id)) {
          this.emit({ type: 'permission-cancel', requestId: evt.request_id })
          this.resetIdle()
        }
        break

      case 'rate_limit_event': {
        const info = evt.rate_limit_info
        // A DISTINÇÃO (R21.1): a tradução inteira mora na função pura; aqui só
        // fica a memória de estado (o que já foi anunciado e o que bloqueia).
        const translated = translateGuiRateLimit(info, this.rateLimitKey)
        this.rateLimitKey = translated.key
        if (info?.status) {
          this.rateLimitBlocked = guiRateLimitBlocks(info.status)
            ? { status: info.status, resetsAt: info.resetsAt }
            : null
        }
        if (translated.event) this.emit(translated.event)
        break
      }

      case 'result': {
        if (guiClaudeParentToolUseId(evt.parent_tool_use_id)) break
        this.cancelPendingInteractions()
        const advanced = advanceGuiTurn(this.pendingTurnGenerations)
        const generation = advanced.completed ?? this.activeTurnGeneration
        const interrupted =
          generation !== null && this.interruptGeneration === generation
        this.pendingTurnGenerations = advanced.pending
        this.activeTurnGeneration = advanced.active
        this.clearInterruptGuard()
        // Parar o turno para os agentes de fundo dele também — antes do
        // terminal, e antes de medir o `continues`.
        if (interrupted) this.cancelLiveAgents()
        // A medição vem das MENSAGENS do turno, nunca do `evt.usage` daqui: o
        // `usage` do result é o agregado de todas as chamadas de API do turno e
        // não descreve ocupação de janela nenhuma (ver
        // claudeMessageContextTokens). `undefined` = este turno não mediu
        // nada — comando local, turno interrompido antes da 1ª chamada —, e o
        // medidor mantém a última medição de verdade em vez de zerar.
        const contextTokens = this.turnContextTokens
        this.turnContextTokens = undefined
        if (evt.session_id) {
          // resume/fork pode mudar o id — o result é a palavra final do turno.
          this.emit({ type: 'session-id', sessionId: evt.session_id })
        }
        // R7-E — a INTERRUPÇÃO GANHA do carimbo do CLI. O claude devolve o
        // result da parada como `is_error` com texto NENHUM: sem esta ordem, o
        // ■ do dono virava "falhou · erro sem detalhe" (print do dono,
        // 2026-08-18). O motor sabe quem mandou parar; quem parou a pedido não
        // falhou.
        const outcome = interrupted
          ? 'cancelled'
          : evt.is_error
            ? 'failed'
            : 'completed'
        // A medição vira a verdade do processo para este modelo: a partir daqui
        // o `init` que repete a cada turno anuncia ELA, não o piso curado.
        const measuredWindow = claudeReportedContextWindow(evt.modelUsage, this.initModel)
        if (measuredWindow !== undefined) this.measuredWindow = measuredWindow
        this.emit({
          type: 'result',
          isError: interrupted ? false : Boolean(evt.is_error),
          outcome,
          ...(interrupted ? { interrupted: true as const } : {}),
          // O `result` raiz não diz UMA palavra sobre background (dump completo
          // verificado): agente vivo é o que impede este terminal de virar o
          // desfecho visual — e é isso que dá UM plim por turno lógico.
          continues: this.activeTurnGeneration !== null || this.claudeTasks.size > 0,
          // R21.3 — UMA VOZ para o limite: com o bloqueio ARMADO (fato
          // estrutural do `rate_limit_event`, nunca as palavras do erro), o
          // card fala PT-BR com a receita em vez do inglês cru do CLI.
          // A ORDEM é do mais específico ao cru: limite ARMADO (estado do
          // protocolo) > queda do provedor (assinatura do wrapper do CLI,
          // guiProviderOutageText) > a palavra crua do CLI.
          errorText: interrupted
            ? GUI_OWNER_INTERRUPT_LABEL
            : evt.is_error
              ? (guiLimitResultText(this.rateLimitBlocked) ??
                guiProviderOutageText(evt.result) ??
                evt.result ??
                'erro sem detalhe')
              : undefined,
          resultText: typeof evt.result === 'string' && evt.result.trim() ? evt.result : undefined,
          contextTokens,
          // Janela REAL medida pelo CLI para o modelo desta conversa. Ausente
          // quando o mapa não traz o modelo: aí a janela do init continua
          // valendo (o campo é omitido, nunca zerado).
          contextWindow: measuredWindow,
          fastModeState: evt.fast_mode_state,
          costUsd: claudeSessionCostUsd(evt.total_cost_usd)
        })
        break
      }
    }
  }

  /** Uma vez por processo: o wrapper usa para anunciar "sessão aberta" só no 1º init. */
  announceOnce(): boolean {
    if (this.announced) return false
    this.announced = true
    return true
  }
}
