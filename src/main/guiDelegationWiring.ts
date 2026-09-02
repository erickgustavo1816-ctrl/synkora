/**
 * A COSTURA DOS AJUDANTES SEM ABA COM O MAIN (onda 2 do design vinculante
 * `.synkora/reports/DESIGN_SUBAGENTES_SEM_ABA_2026-08-18.md`).
 *
 * O motor (`guiHelperSessions.ts`) é puro por decisão: ele não conhece
 * `MaestroSession`/`CodexSession`, não conhece `SeatStore` e não conhece
 * electron. Este módulo é o ÚNICO lugar onde essas três coisas encostam nele —
 * e é por isso que ele também não importa electron: tudo que vem do main entra
 * por injeção, e a suíte roda em node puro.
 *
 * O que mora aqui:
 *  1. os dois ADAPTADORES (claude e codex), com as cercas do D5 nos args;
 *  2. `resolveSeat` e `modelSupportsEffort` sobre o catálogo REAL do CLI;
 *  3. a ENTREGA EM ARQUIVO (2026-08-18): o único ponto do caminho que toca
 *     disco, e por isso o único que pode gravar `.synkora/helpers/<id>.md`;
 *  4. a implementação das tools de delegação do `McpApi` — texto legível,
 *     sempre em PT-BR, com o recibo por ajudante e o CORREIO de carona.
 *
 * SEM CADEIA (cerca dura do D1): o `GuiHelperSpawnRequest` continua SEM campo de
 * ferramenta — o chamador não pede catálogo, não escolhe catálogo e não tem por
 * onde passar um. Frota que abre frota segue impossível.
 *
 * O QUE MUDOU NA R14 (seção L3 do design `DESIGN_COPIA_E_LSP_R14_2026-08-19`):
 * o MOTOR passou a armar, por ajudante, um kit MCP SÓ-LSP derivado do registro
 * dele (id, projeto, delegador, worktree) — `guiHelperLspMcp.ts`. A cerca não
 * afrouxou: o papel `ajudante` não tem `delegate` no servidor, o token nasce no
 * spawn e MORRE no desfecho, e nada disso passa pelo pedido.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_NATIVE_AGENT_FENCE } from './guiDelegateMcp'
import {
  armGuiHelperLspMcp,
  disarmGuiHelperLspMcp,
  type GuiHelperLspDeps,
  type GuiHelperLspKit
} from './guiHelperLspMcp'
import type { GuiHelperPortRegistry } from './guiHelperPorts'
import { CodexSession, type CodexSessionOpts } from './codexSession'
import { MaestroSession, type MaestroSessionOpts, type SessionEvent } from './maestroSession'
import { getCatalog } from './catalog'
import { loadJsonStore, persistJsonStore } from './jsonStore'
import { getSeatUsage, type SeatUsageInfo } from './seatUsage'
import { guiPermissionProfile, isGuiPermissionMode } from './guiSessions'
import {
  GUI_HELPER_STORE_VERSION,
  GuiHelperEngine,
  isGuiHelperStoreDoc,
  type GuiHelperCli,
  type GuiHelperDelegator,
  type GuiHelperDelivery,
  type GuiHelperDeliveryOutcome,
  type GuiHelperEvent,
  type GuiHelperLogEntry,
  type GuiHelperProcess,
  type GuiHelperReceipt,
  type GuiHelperRecord,
  type GuiHelperRequest,
  type GuiHelperSeat,
  type GuiHelperSnapshot,
  type GuiHelperSpawnRequest,
  type GuiHelperState,
  type GuiHelperStore,
  type GuiHelperStoreDoc,
  type GuiHelperChange,
  type GuiHelperResultOutcome,
  resolveHelperCli
} from './guiHelperSessions'
import { GuiHelperInbox, guiHelperInbox, guiHelperInboxBlock } from './guiHelperCards'
import { GuiOwnerMailbox, guiOwnerMailBlock, guiOwnerMailbox } from './guiOwnerMail'
import {
  GuiOwnerReplyDebt,
  guiOwnerReplyDebt,
  guiOwnerReplyRefusal
} from './guiOwnerReplyDebt'
import type { GuiDelegationDefaults } from './guiSessions'
import type { McpHelperRequestInput } from './mcpServer'

/** A conta como o main a conhece (SeatStore + configDir já resolvido). */
export interface GuiDelegationSeat {
  id: string
  name: string
  cli: GuiHelperCli
  status: string
  configDir: string
}

/**
 * PERSONA DO AJUDANTE — curta de propósito (D1). Ele não conversa: recebe uma
 * fatia, trabalha e entrega no TEXTO FINAL. Em inglês, como todo prompt de
 * agente desta casa; a resposta ao dono é sempre PT-BR.
 *
 * A LINHA DO DESTINO (rodada 7, achado 3): no teste ao vivo os seis relatórios
 * de uma frota de PESQUISA acabaram commitados em `reports/`, numa missão cuja
 * entrega pedida era uma resposta no chat. Aqui mora a metade do ajudante —
 * pesquisa/consulta escreve em `.synkora/` (git-invisível), arquivo versionado
 * só quando a TAREFA é mudar código. A outra metade é a ordem permanente do
 * delegador (`DELEGATION_STANDING_ORDER`, no guiMissionContracts), que manda ler
 * a entrega como insumo e não commitá-la.
 */
export const GUI_HELPER_PERSONA = [
  'You are a Synkora helper: a headless worker opened by another agent through the internal MCP.',
  'You have no tab, no terminal and no human on the other side.',
  '',
  'RULES:',
  '- Do the slice of work you were given, end to end.',
  '- ALWAYS DELIVER IN FILE MODE: the work product goes into a FILE inside this worktree (the file',
  '  the task names, or .synkora/reports/<slug>.md), and your FINAL message is a SHORT summary —',
  '  a handful of lines — that names that path. Never paste a long deliverable back as text.',
  '- RESEARCH AND CONSULTATION ARE EPHEMERAL: a report, a study, an investigation goes under',
  '  .synkora/, which git ignores — NEVER into a versioned folder (docs/, plano/, reports/, src/).',
  '  You write a versioned file only when the TASK you were given is to CHANGE CODE, and then that',
  '  file IS the change.',
  '- The harness saves your final message to .synkora/helpers/<yourId>.md no matter what, so a wall',
  '  of text there is context your delegator pays for twice and reads once.',
  '- NEVER ask questions and never wait for approval: nobody can answer you. If something is',
  '  genuinely blocked, say what is blocked and why, in your final message, and stop.',
  '- NEVER open subagents of your own (no Task/Agent, no collab, no delegation of any kind).',
  '- Answer the delegator in Brazilian Portuguese (PT-BR).'
].join('\n')

/**
 * A LINHA DO LSP (R14, L3) — UMA, e só quando o kit existe de verdade.
 *
 * Ela não mora no array acima de propósito: o kit depende do servidor MCP estar
 * no ar (`armGuiHelperLspMcp` devolve `undefined` com a porta em 0), e prometer
 * quatro ferramentas a um ajudante que não as tem seria a persona mentindo — ele
 * queimaria o turno chamando tool inexistente. A régua da casa é a mesma das
 * descrições de tool: descrição que mente sobre o próprio limite é pior que
 * ausente.
 */
export const GUI_HELPER_LSP_PERSONA_LINE =
  '- LSP TOOLS ARE ON (lsp_diagnostics, lsp_definition, lsp_references, lsp_hover): ask the language ' +
  'server for the EXACT file:line of an error, of a definition or of every caller BEFORE you edit — ' +
  'grep guesses, the compiler knows.'

/**
 * A LINHA DA PORTA (D4 do design ABAS POR IDENTIDADE, 2026-09-01) — UMA, e só
 * quando a reserva existe de verdade.
 *
 * Mesma régua da linha do LSP, e pela mesma razão: persona que promete porta sem
 * reserva é persona mentindo — o ajudante subiria servidor numa porta que o
 * mapa do dono não conhece, que é exatamente o hábito medido (missão 86a05c06:
 * ajudante servindo em 8791 enquanto o dev servia em 8159/8148/8163, os dois na
 * mesma aba).
 *
 * O vocabulário do COMO é o da casa: `portInvocation` (runtimeScripts.ts) já
 * decidiu, por ferramenta, que vite/astro querem `--port N --strictPort`, next
 * quer `-p N` e o resto lê `PORT` do ambiente. Repetir aqui a MESMA receita
 * evita o ajudante inventar a dele — e é o que o `--strictPort` garante: ou ele
 * sobe na porta reservada, ou ele SABE que não subiu.
 */
export function GUI_HELPER_PORT_PERSONA_LINE(port: number): string {
  return (
    `- PORT ${port} IS RESERVED FOR YOU ALONE (the mission developer and every other helper have ` +
    'their own): when your slice needs the product RUNNING, serve it on THIS port, in the background — ' +
    `vite and astro take \`--port ${port} --strictPort\`, next takes \`-p ${port}\`, and anything else ` +
    `that is PORT-aware reads PORT, already set to ${port} in your environment (SYNKORA_HELPER_PORT ` +
    'carries the same number). Then LOOK at the page in the house browser with browser_open: that tab ' +
    'is yours alone and nobody else navigates it. If the port is already taken, take the next one up ' +
    'and SAY which one you used — and never touch a port you see someone else using.'
  )
}

/**
 * A persona que ESTE ajudante recebe. Sem kit e sem porta ela é a de sempre,
 * palavra por palavra; cada linha extra só entra quando a coisa que ela promete
 * EXISTE. Uma função porque a resposta muda por PROCESSO, não por build: o mesmo
 * app arma o kit num ajudante e não arma no seguinte se o servidor caiu no meio,
 * e a porta só existe quando o registro do D4 está fiado.
 */
export function guiHelperPersonaFor(lspArmed: boolean, port?: number): string {
  const lines = [GUI_HELPER_PERSONA]
  if (lspArmed) lines.push(GUI_HELPER_LSP_PERSONA_LINE)
  if (port !== undefined) lines.push(GUI_HELPER_PORT_PERSONA_LINE(port))
  return lines.join('\n')
}

// ————— A ENTREGA EM ARQUIVO (ordem do dono, 2026-08-18 à noite) —————

/**
 * Onde a entrega de cada ajudante pousa, RELATIVO ao worktree do delegador.
 *
 * `.synkora/` já é git-invisível em qualquer produto (ensureSynkoraGitExcludes),
 * então a entrega nunca suja a branch da missão nem entra num commit por
 * distração — a mesma razão pela qual o transcript e a evidência de browser
 * moram lá desde a era F6.
 */
export const GUI_HELPER_DELIVERY_DIR = '.synkora/helpers'

/** Trecho da entrega que viaja INLINE no `helper_result`. O resto é o arquivo:
 *  o começo existe para o delegador decidir se abre o arquivo agora, não para
 *  substituí-lo. */
export const GUI_HELPER_RESULT_HEAD_CHARS = 2_000

/**
 * OS ESTADOS EM PT-BR. Eles aparecem no documento da entrega, na ficha do
 * `helpers_status` e no card — três lugares que o DONO lê. `interrupted` cru
 * seria a única palavra em inglês da tela, e justamente a que carrega a decisão
 * dele (retomar ou descartar).
 */
const HELPER_OUTCOME_LABEL: Record<GuiHelperState, string> = {
  spawning: 'abrindo',
  working: 'trabalhando',
  done: 'concluído',
  failed: 'falhou',
  interrupted: 'interrompido',
  cancelled: 'cancelado'
}

/** O mapa é EXAUSTIVO por tipo: um estado novo na união quebra o typecheck aqui,
 *  que é onde alguém tem de escolher a palavra que o dono vai ler. */
function helperStateLabel(state: GuiHelperState): string {
  return HELPER_OUTCOME_LABEL[state]
}

/** O id vira NOME DE ARQUIVO: a mesma régua do `writeClaudeMcpConfig` (paneId
 *  com `:` derrubava o spawn no Windows). Nada de caractere que o sistema de
 *  arquivos recuse, e nada que escape da pasta. */
export function guiHelperDeliveryPath(helperId: string): string {
  const safe = helperId.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 120) || 'ajudante'
  return `${GUI_HELPER_DELIVERY_DIR}/${safe}.md`
}

function isoOrUnknown(at: number | undefined): string {
  return typeof at === 'number' && Number.isFinite(at) ? new Date(at).toISOString() : '—'
}

/**
 * O DOCUMENTO: cabeçalho + entrega. Ele é lido por três leitores diferentes — o
 * agente delegador, o dono na aba Arquivos e o próprio Synkora numa rodada
 * futura —, então diz de quem é, em que executor rodou, como terminou e quando.
 * Sem isso, uma pasta com dez arquivos de uuid não conta nada a ninguém.
 */
export function guiHelperDeliveryDocument(record: GuiHelperRecord, text: string): string {
  const outcome = helperStateLabel(record.state)
  const executor = [record.model, record.effort, record.seatName ?? record.seatId, record.cli]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
  const body = text.trim()
  return [
    `# ajudante ${record.name ? `${record.name} — ` : ''}${record.helperId}`,
    '',
    `- executor: ${executor}`,
    `- desfecho: ${outcome}`,
    `- começou: ${isoOrUnknown(record.startedAt)}`,
    `- encerrou: ${isoOrUnknown(record.settledAt)}`,
    ...(record.failure ? [`- motivo: ${record.failure}`] : []),
    '',
    '## briefing',
    '',
    record.prompt.trim() || '—',
    '',
    '## entrega',
    '',
    body || '_(o ajudante encerrou sem texto)_',
    ''
  ].join('\n')
}

/**
 * GRAVA a entrega. É o SUSPENSÓRIO da ordem do dono ("todo ajudante sempre
 * entrega em modelo de ARQUIVO"): a persona pede ao ajudante, isto acontece
 * sempre — inclusive quando ele desobedece e despeja 200KB no texto final.
 *
 * Falha aqui NUNCA é fatal: o motor guarda o motivo e o texto continua voltando
 * inline. Perder a entrega porque o disco recusou seria trocar um problema
 * pequeno por um irreversível.
 */
export function writeGuiHelperDelivery(delivery: GuiHelperDelivery): GuiHelperDeliveryOutcome {
  const { record } = delivery
  const cwd = record.cwd?.trim()
  if (!cwd) {
    return { ok: false, error: 'o ajudante não tem worktree registrado — a entrega ficou só em memória' }
  }
  // O caminho publicado é RELATIVO e com barras normais: é o que o agente
  // escreve num Read e o que o dono lê no card. O join do sistema só existe do
  // lado do disco (lição da era F6: caminho absoluto com acento morria no
  // PowerShell do gate).
  const relative = guiHelperDeliveryPath(record.helperId)
  const file = relative.slice(GUI_HELPER_DELIVERY_DIR.length + 1)
  try {
    const dir = join(cwd, '.synkora', 'helpers')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, file), guiHelperDeliveryDocument(record, delivery.text), 'utf-8')
    return { ok: true, path: relative }
  } catch (error) {
    return { ok: false, error: `não deu para gravar ${relative}: ${helperErrorText(error)}` }
  }
}

/**
 * APAGA a entrega canônica — o DESCARTE do R6.2 ("helper_cancel apaga o arquivo
 * de entrega"), e o par exato do `writeGuiHelperDelivery`.
 *
 * O caminho é RECONSTRUÍDO pelo helperId, nunca lido do `resultPath` do
 * registro: é a mesma função que escreveu, então os dois lados não podem
 * divergir, e um id hostil já sai saneado dela — um `resultPath` vindo de um
 * arquivo de disco editado à mão jamais vira `rm` fora da pasta de ajudantes.
 *
 * Arquivo ausente é o caso NORMAL (ajudante cancelado antes de qualquer
 * gravação): erro nenhum sobe daqui, porque o motor não pode depender do disco
 * para encerrar um registro.
 */
export function discardGuiHelperDelivery(record: GuiHelperRecord): void {
  const cwd = record.cwd?.trim()
  if (!cwd) return
  const relative = guiHelperDeliveryPath(record.helperId)
  try {
    rmSync(join(cwd, ...relative.split('/')), { force: true })
  } catch {
    // Arquivo travado por outro processo vira lixo no worktree — nunca um
    // descarte que não acontece.
  }
}

function helperErrorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

/** Sem silêncio: um pedido de permissão numa sessão headless nunca é respondido. */
const HELPER_PERMISSION_DEAD_END =
  'o ajudante parou pedindo permissão e não há ninguém para responder por ele — ' +
  'troque o modo desta conversa para edições/bypass antes de delegar trabalho que escreve'

/** Teto da espera pelos limites das contas no `list_seats`: cache quente responde
 *  na hora; conta fria não pode segurar a tool até o corte do CLI. */
const SEAT_USAGE_WAIT_MS = 8_000

// ————— tradução dos eventos do CLI para o vocabulário do motor —————

function toolActivitySummary(evt: SessionEvent & { type: 'tool' }): string {
  const input = evt.input ?? {}
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) {
      return `${evt.name} · ${value.replace(/\s+/gu, ' ').trim().slice(0, 120)}`
    }
  }
  return evt.name
}

/**
 * O MESMO tradutor serve aos dois CLIs: `MaestroSession` e `CodexSession`
 * implementam a mesma união `SessionEvent`, e o motor consome um subconjunto
 * dela. Quanto menos protocolo o motor conhecer, menos ele quebra num update.
 */
export function guiHelperEventFor(evt: SessionEvent): GuiHelperEvent | null {
  switch (evt.type) {
    case 'text':
      return { type: 'text', text: evt.text }
    case 'tool':
      return { type: 'activity', summary: toolActivitySummary(evt) }
    case 'context-usage':
      return { type: 'context', contextTokens: evt.contextTokens }
    // O ENDEREÇO DA CONVERSA (R6.1): claude manda o session id em todo `result`,
    // codex manda o thread no `thread/start` (já com o prefixo da casa). Viaja
    // CRU — quem traduz para cada binário é o adaptador, no instante do resume.
    case 'session-id':
      return { type: 'session', sessionId: evt.sessionId }
    case 'result':
      // `continues` = o turno lógico ainda não acabou (agente de fundo vivo).
      // Encerrar aqui mataria um ajudante em pleno trabalho — mas o motor
      // PRECISA saber que o CLI fechou uma resposta: ela viaja como `held`, e
      // é o cinto que transforma "o processo caiu depois" em entrega, não em
      // "falhou" (caso real 2026-08-31: relatório pronto, ajudante `failed`).
      return {
        type: 'result',
        isError: evt.isError,
        ...(evt.continues === true ? { held: true as const } : {}),
        ...(evt.resultText ? { text: evt.resultText } : {}),
        ...(evt.errorText ? { errorText: evt.errorText } : {})
      }
    case 'fatal':
      return { type: 'fatal', text: evt.text }
    case 'closed':
      return { type: 'closed', code: evt.code }
    // Sessão headless não tem quem responda: pedido de interação é BECO, e beco
    // vira desfecho com receita NA HORA. Desde a R19 isto é ainda mais vital:
    // nenhum relógio derruba ajudante nenhum (o teto de 30 min virou aviso), e
    // sem esta linha o pedido de permissão ficaria pendurado para sempre — até o
    // dono reparar na lateral e apertar o ■.
    case 'permission':
      return { type: 'fatal', text: `${HELPER_PERMISSION_DEAD_END} (${evt.toolName})` }
    case 'question':
    case 'plan-review':
      return { type: 'fatal', text: HELPER_PERMISSION_DEAD_END }
    default:
      return null
  }
}

// ————— os adaptadores —————

/**
 * O DIÁRIO DO KIT LSP. Canal PRÓPRIO porque a união `GuiHelperLogEvent` é do
 * MOTOR (guiHelperSessions.ts) e não conhece LSP — e o motor está fora desta
 * onda. `paneId` é o do DELEGADOR (é por ele que o dono acha a conversa no
 * diário) e `helperId` é a ficha; os dois juntos são a correlação da casa.
 */
export type GuiHelperLspJournalEvent =
  /** O ajudante nasceu com as quatro tools e um bearer só dele. */
  | 'helper-lsp-armed'
  /** O bearer morreu com o processo (desfecho, cancelamento, interrupção). */
  | 'helper-lsp-revoked'
  /** Servidor fora do ar ou config recusada: ele nasceu SEM as tools. */
  | 'helper-lsp-unavailable'

export interface GuiHelperLspJournalEntry {
  event: GuiHelperLspJournalEvent
  /** Pane do DELEGADOR — a correlação com a conversa que abriu o ajudante. */
  paneId: string
  helperId: string
  detail?: Record<string, unknown>
}

export interface GuiHelperAdapterDeps {
  /** Materializa a persona do claude em arquivo (teto de argv no Windows). */
  systemPromptFile(name: string, content: string): string | undefined
  /** Prepara o config dir do seat antes do spawn (sandbox do codex). */
  prepareSeat?(seat: GuiHelperSeat, cli: GuiHelperCli): void
  /**
   * O KIT SÓ-LSP por ajudante (R14/L3). AUSENTE = ajudante sem ferramenta
   * nenhuma, exatamente como antes da R14 — é assim que as suítes rodam sem hub
   * nem servidor. Note o que NÃO está aqui: nada que o CHAMADOR do `delegate`
   * possa influenciar. O kit sai do registro do ajudante, e só.
   */
  lsp?: GuiHelperLspDeps
  /** Caixa-preta do kit. Ausente = arma e revoga em silêncio (as suítes). */
  journalLsp?(entry: GuiHelperLspJournalEntry): void
  /**
   * O REGISTRO DE PORTAS (D4, 2026-09-01). AUSENTE = ajudante sem porta
   * reservada, exatamente como antes — é assim que as suítes rodam, e é o que
   * mantém a persona honesta: sem registro não há linha de porta.
   *
   * A instância de produção é o singleton `guiHelperPorts`, fiado no index.
   */
  ports?: GuiHelperPortRegistry
  /**
   * O DESFECHO DO AJUDANTE VISTO DE FORA — hoje, quem fecha as ABAS dele no
   * browser embutido (D3). Fica aqui e não no motor porque o motor não conhece
   * electron; e é opcional porque nada do ciclo de vida pode depender dela.
   */
  onHelperDisposed?(helperId: string): void
}

/**
 * A PORTA DESTE AJUDANTE, reservada ANTES do processo nascer.
 *
 * Antes é obrigatório: o número viaja no ARGV/ENV, que o CLI lê na partida —
 * reservar depois seria entregar a porta a um processo que já perdeu a chance de
 * ouvi-la (a mesma armadilha do catálogo de tools montado por request).
 *
 * A meta sai do REGISTRO do ajudante, nunca do pedido do chamador (cerca do D1).
 * O APELIDO não viaja no `GuiHelperSpawnRequest` — ele mora no `GuiHelperRecord`
 * do motor, que está em obra em outra sessão —, então o mapa do dono cai no id
 * curto até o pedido carregá-lo; o registro já aceita `name` para o dia em que
 * carregar.
 */
function reserveGuiHelperPort(
  deps: GuiHelperAdapterDeps,
  request: GuiHelperSpawnRequest
): number | undefined {
  if (!deps.ports) return undefined
  return deps.ports.reserve(request.helperId, {
    projectId: request.projectId,
    delegatorPaneId: request.delegatorPaneId
  })
}

/**
 * Devolve a porta à faixa e avisa quem cuida da aba. UMA passagem, e NUNCA
 * lança: as duas coisas acontecem no desfecho, e um desfecho que estoura porque
 * uma aba se recusou a fechar deixaria o registro do ajudante pendurado.
 */
function releaseGuiHelperPort(deps: GuiHelperAdapterDeps, helperId: string): void {
  try {
    deps.ports?.release(helperId)
  } catch {
    /* soltar porta é limpeza, nunca pré-condição do desfecho */
  }
  try {
    deps.onHelperDisposed?.(helperId)
  } catch {
    /* fechar aba é limpeza, nunca pré-condição do desfecho */
  }
}

/**
 * O AMBIENTE DA PORTA. Dois nomes de propósito: `SYNKORA_HELPER_PORT` é o nome
 * DA CASA (o ajudante sabe de onde veio, e um script do produto não o
 * sobrescreve por acidente) e `PORT` é a convenção que o `portInvocation` já usa
 * para produto PORT-aware — sem ela, metade dos runtimes ignoraria a reserva.
 */
export function guiHelperPortEnv(port: number | undefined): Record<string, string> {
  if (port === undefined) return {}
  return { SYNKORA_HELPER_PORT: String(port), PORT: String(port) }
}

/** O env que vai ao processo: o do KIT primeiro (o bearer é o que não pode
 *  sumir), a porta depois. Vazio = nenhuma chave `extraEnv` no spawn, que é o
 *  mundo de antes do D4. */
function helperSpawnEnv(
  kit: GuiHelperLspKit | undefined,
  port: number | undefined
): Record<string, string> | undefined {
  const env = { ...(kit?.env ?? {}), ...guiHelperPortEnv(port) }
  return Object.keys(env).length > 0 ? env : undefined
}

/**
 * Arma o kit deste ajudante e registra o que aconteceu. `undefined` sem `deps.lsp`
 * é o mundo pré-R14 (nada a dizer); `undefined` COM `deps.lsp` é notícia — o
 * ajudante partiu cego e o diário tem de saber por quê.
 *
 * TODO campo sai do `request` — que é o REGISTRO do ajudante montado pelo motor.
 * É esta função que faz a cerca do D1 continuar verdadeira depois da R14: não há
 * argumento por onde um chamador de `delegate` influencie o kit.
 *
 * Exportada para a suíte: o adaptador real instancia processo de CLI, e o ciclo
 * de vida do bearer tem de ser provável sem subir binário nenhum.
 */
export function armGuiHelperKit(
  deps: GuiHelperAdapterDeps,
  request: GuiHelperSpawnRequest
): GuiHelperLspKit | undefined {
  if (!deps.lsp) return undefined
  const kit = armGuiHelperLspMcp(
    {
      helperId: request.helperId,
      projectId: request.projectId,
      delegatorPaneId: request.delegatorPaneId,
      cwd: request.cwd,
      cli: request.cli,
      ...(request.seat.seatId ? { seatId: request.seat.seatId } : {})
    },
    deps.lsp
  )
  deps.journalLsp?.({
    event: kit ? 'helper-lsp-armed' : 'helper-lsp-unavailable',
    paneId: request.delegatorPaneId,
    helperId: request.helperId,
    detail: {
      cli: request.cli,
      root: request.cwd,
      ...(kit ? { mcpPaneId: kit.paneId } : { reason: 'servidor MCP fora do ar ou config recusada' })
    }
  })
  return kit
}

/** Revoga UMA vez, aconteça o que acontecer com o processo. */
function disarmHelperLsp(
  deps: GuiHelperAdapterDeps,
  request: GuiHelperSpawnRequest,
  kit: GuiHelperLspKit | undefined
): void {
  if (!kit || !deps.lsp) return
  disarmGuiHelperLspMcp(kit, deps.lsp)
  deps.journalLsp?.({
    event: 'helper-lsp-revoked',
    paneId: request.delegatorPaneId,
    helperId: request.helperId,
    detail: { mcpPaneId: kit.paneId }
  })
}

/** Flags do helper CLAUDE. A cerca de 13 nomes vem do guiDelegateMcp — fonte
 *  única — e é a MESMA que o chat do delegador usa (S1, sondada). */
export function claudeHelperArgs(): string[] {
  return ['--disallowedTools', CLAUDE_NATIVE_AGENT_FENCE.join(',')]
}

/** Flags do helper CODEX: o CINTO da cerca anti-nativo, no formato que
 *  sobrevive ao `shell: true` (S2). O suspensório é `suppressNativeAgents`. */
export function codexHelperArgs(): string[] {
  return ['-c', 'features.multi_agent=false']
}

function permissionProfileFor(
  cli: GuiHelperCli,
  permissionMode: string | undefined
): { permissionMode?: string; sandbox?: string; approvalPolicy?: string } {
  return guiPermissionProfile(cli, isGuiPermissionMode(permissionMode) ? permissionMode : undefined)
}

/**
 * O id do thread como o `thread/resume` o quer: CRU.
 *
 * O evento `session-id` do codex publica `codex-thread:<uuid>` (a convenção da
 * casa, que distingue thread de session id do claude no mesmo campo). Precedente
 * exato: `guiSessions.spawnSession`, que faz o mesmo corte no respawn dos chats.
 */
export function codexHelperThreadId(sessionId: string | undefined): string | undefined {
  const clean = sessionId?.trim()
  if (!clean) return undefined
  return clean.startsWith('codex-thread:') ? clean.slice('codex-thread:'.length) : clean
}

/**
 * AS OPÇÕES DO HELPER CLAUDE — função pura de propósito.
 *
 * O adaptador só sabe instanciar; a decisão (cerca, conta, worktree, resume) vive
 * aqui, onde a suíte a lê sem subir um processo de CLI. É o que torna o contrato
 * do R6.2 provável hoje, com o verbo `helper_resume` ainda na onda seguinte.
 *
 * O KIT (R14/L3) entra pelo 3º parâmetro, e ele vem do ARMADOR, nunca do pedido:
 * ausente = o ajudante de sempre, sem token e sem config de MCP.
 *
 * ORDEM NO FIO (armadilha do CLAUDE.md — "o claude monta o catálogo POR REQUEST
 * e o prompt de argv sai ANTES do handshake MCP"): aqui ela NÃO morde, e a razão
 * é estrutural. O `MaestroSession` sobe o claude em `-p --input-format
 * stream-json` (maestroSession.ts): NENHUM prompt viaja no argv — o `--mcp-config`
 * está na linha de comando, lido na partida do processo, e o briefing do ajudante
 * só entra depois, como mensagem de usuário no stdin. A primeira requisição do
 * ajudante é essa mensagem; o kit já estava lá quando o processo nasceu.
 */
export function claudeHelperSessionOptions(
  request: GuiHelperSpawnRequest,
  systemPromptFile?: string,
  kit?: GuiHelperLspKit,
  /** A PORTA reservada (D4). Ausente = o spawn de antes de 2026-09-01. */
  port?: number
): MaestroSessionOpts {
  const extraEnv = helperSpawnEnv(kit, port)
  return {
    cwd: request.cwd,
    configDir: request.seat.configDir || undefined,
    model: request.model,
    ...(request.effort ? { effort: request.effort } : {}),
    // R11: fast pinado no NASCIMENTO (togglar quebra o prompt-cache).
    ...(request.fast ? { fastMode: true } : {}),
    ...permissionProfileFor('claude', request.permissionMode),
    ...(systemPromptFile ? { systemPromptFile } : {}),
    // RETOMAR A MESMA CONVERSA (R6.2): o `--resume` headless do claude. Ausente
    // em ajudante novo — retomar é sempre um pedido explícito.
    ...(request.resumeSessionId ? { resumeSessionId: request.resumeSessionId } : {}),
    // A CERCA PRIMEIRO, o kit depois: `--disallowedTools` e `--allowedTools`
    // convivem no mesmo spawn (medido), e a ordem é a da leitura — o que o
    // ajudante NÃO pode fazer é a primeira coisa dita.
    extraArgs: [...claudeHelperArgs(), ...(kit?.args ?? [])],
    // No claude o bearer mora no ARQUIVO de config, então até o D4 não havia env
    // nenhum aqui. A porta é a primeira coisa que ele leva no ambiente — e a
    // fusão é a mesma dos dois CLIs, para o dia em que o kit ganhar env.
    ...(extraEnv ? { extraEnv } : {})
  }
}

/** As opções do helper CODEX, com a cerca DUPLA do D5 e o thread já sem prefixo.
 *  O kit (R14/L3) segue a mesma regra do claude: vem do armador, e sem ele nada
 *  muda. No codex a ordem é garantida pelo protocolo — o `app-server` responde o
 *  `initialize` (com os `mcp_servers` do argv já lidos) antes de qualquer
 *  `thread/start`, então o briefing nunca chega antes do catálogo. */
export function codexHelperSessionOptions(
  request: GuiHelperSpawnRequest,
  kit?: GuiHelperLspKit,
  /** A PORTA reservada (D4). Ela ENTRA no env do kit, nunca por cima dele: o
   *  bearer do codex mora justamente ali, e perdê-lo é o ajudante nascer mudo. */
  port?: number
): CodexSessionOpts {
  const threadId = codexHelperThreadId(request.resumeSessionId)
  const extraEnv = helperSpawnEnv(kit, port)
  return {
    cwd: request.cwd,
    configDir: request.seat.configDir || undefined,
    model: request.model,
    ...(request.effort ? { effort: request.effort } : {}),
    ...(request.fast ? { serviceTier: 'priority' as const } : {}),
    ...permissionProfileFor('codex', request.permissionMode),
    // Cerca DUPLA do D5: cinto nos args do app-server, suspensório no
    // thread/start — e o MESMO `base` do codexSession leva a cerca ao
    // thread/resume, então retomar não reabre a porta do subagente nativo.
    ...(threadId ? { resumeSessionId: threadId } : {}),
    extraArgs: [...codexHelperArgs(), ...(kit?.args ?? [])],
    ...(extraEnv ? { extraEnv } : {}),
    suppressNativeAgents: true
  }
}

/**
 * O DESCARTE COM REVOGAÇÃO — o único caminho de saída dos dois adaptadores.
 *
 * O motor chama `dispose()` em TODO desfecho (settle de done/failed/interrupted/
 * cancelled, o discard do interrompido, a re-tentativa e o descarte imediato de
 * um processo que já nasceu assentado), e por contrato ele pode chamar mais de
 * uma vez. Então esta é a costura certa para o token morrer: uma passagem só,
 * kill antes de revogar (bearer cortado embaixo de um pedido em voo devolveria
 * 401 ao ajudante em vez de silêncio) e revogação garantida mesmo se o kill
 * estourar.
 *
 * DESDE O D4 (2026-09-01) a mesma passagem devolve a PORTA à faixa e avisa quem
 * cuida das ABAS do ajudante (D3: a aba dele morre com ele). Os três são
 * limpeza do MESMO desfecho: separá-los em ganchos diferentes seria apostar que
 * todos os caminhos do motor se lembram de chamar os três.
 */
export function guiHelperKitDisposer(
  deps: GuiHelperAdapterDeps,
  request: GuiHelperSpawnRequest,
  kit: GuiHelperLspKit | undefined,
  kill: () => void
): () => void {
  let revoked = false
  return () => {
    try {
      kill()
    } finally {
      if (!revoked) {
        revoked = true
        disarmHelperLsp(deps, request, kit)
        releaseGuiHelperPort(deps, request.helperId)
      }
    }
  }
}

export function createClaudeHelperAdapter(deps: GuiHelperAdapterDeps) {
  return (request: GuiHelperSpawnRequest, emit: (event: GuiHelperEvent) => void): GuiHelperProcess => {
    deps.prepareSeat?.(request.seat, 'claude')
    // O KIT E A PORTA ANTES DO PROCESSO: as flags entram no argv e a porta no
    // env, e os dois são lidos no nascimento — depois do spawn não há mais onde
    // encaixar ferramenta nem endereço.
    const port = reserveGuiHelperPort(deps, request)
    const kit = armGuiHelperKit(deps, request)
    const persona = guiHelperPersonaFor(kit !== undefined, port)
    const file = deps.systemPromptFile(`helper-${request.helperId}.system.md`, persona)
    let session: MaestroSession
    try {
      session = new MaestroSession(
        claudeHelperSessionOptions(request, file, kit, port),
        (evt) => {
          const translated = guiHelperEventFor(evt)
          if (translated) emit(translated)
        }
      )
    } catch (error) {
      // Processo que não nasceu nunca devolve `dispose` ao motor: sem esta
      // revogação o bearer ficaria válido para sempre, sem dono — e a porta
      // ficaria reservada para um ajudante que nunca existiu.
      disarmHelperLsp(deps, request, kit)
      releaseGuiHelperPort(deps, request.helperId)
      throw error
    }
    // A persona por arquivo pode falhar (disco cheio, userData sumindo): o
    // contrato então viaja COLADO no pedido — nunca some em silêncio.
    session.send(file ? request.prompt : `${persona}\n\n---\n\n${request.prompt}`)
    return {
      send: (text) => session.send(text),
      dispose: guiHelperKitDisposer(deps, request, kit, () => session.kill())
    }
  }
}

export function createCodexHelperAdapter(deps: GuiHelperAdapterDeps) {
  return (request: GuiHelperSpawnRequest, emit: (event: GuiHelperEvent) => void): GuiHelperProcess => {
    deps.prepareSeat?.(request.seat, 'codex')
    const port = reserveGuiHelperPort(deps, request)
    const kit = armGuiHelperKit(deps, request)
    let session: CodexSession
    try {
      session = new CodexSession(
        codexHelperSessionOptions(request, kit, port),
        guiHelperPersonaFor(kit !== undefined, port),
        (evt) => {
          const translated = guiHelperEventFor(evt)
          if (translated) emit(translated)
        }
      )
    } catch (error) {
      disarmHelperLsp(deps, request, kit)
      releaseGuiHelperPort(deps, request.helperId)
      throw error
    }
    session.send(request.prompt)
    return {
      send: (text) => session.send(text),
      // O `app-server` do codex NUNCA encerra sozinho ao fim do turno (sonda
      // probe-helper-matrix §6): o kill é obrigatório em todo desfecho — e é
      // nele que o bearer deste ajudante morre.
      dispose: guiHelperKitDisposer(deps, request, kit, () => session.kill())
    }
  }
}

// ————— catálogo: o effort só viaja quando o modelo o aceita —————

/**
 * `modelSupportsEffort` do motor é SÍNCRONO (ele decide na hora do spawn) e o
 * catálogo do CLI é assíncrono. A ponte é este cache: resposta imediata quando
 * já se sabe, `undefined` quando ainda não — e `undefined` NÃO é "não suporta"
 * (o motor manda o effort assim mesmo; derrubar o nível de toda frota por
 * catálogo frio seria um estrago maior que um rótulo otimista).
 */
export class GuiHelperCatalogCache {
  private readonly efforts = new Map<string, Map<string, boolean>>()
  private readonly loading = new Set<string>()
  private readonly configDirOf: (cli: GuiHelperCli) => string | undefined

  constructor(configDirOf: (cli: GuiHelperCli) => string | undefined) {
    this.configDirOf = configDirOf
  }

  supportsEffort(query: { cli: GuiHelperCli; model: string }): boolean | undefined {
    const table = this.efforts.get(query.cli)
    if (!table) {
      this.load(query.cli)
      return undefined
    }
    return table.get(query.model.trim().toLowerCase())
  }

  private load(cli: GuiHelperCli): void {
    if (this.loading.has(cli)) return
    this.loading.add(cli)
    void getCatalog(cli, this.configDirOf(cli))
      .then((catalog) => {
        const table = new Map<string, boolean>()
        for (const model of catalog.models) {
          // `efforts` ausente = o catálogo não disse nada sobre este modelo;
          // vazio = ele DECLARA que não aceita nível (o caso do haiku, §2.4).
          if (model.efforts === undefined) continue
          table.set(model.id.trim().toLowerCase(), model.efforts.length > 0)
        }
        this.efforts.set(cli, table)
      })
      .catch(() => undefined)
      .finally(() => this.loading.delete(cli))
  }
}

// ————— a conta —————

/**
 * MESMO CLI → a conta do delegador (o pedido explícito vence). CLI CRUZADO → a
 * primeira conta LOGADA daquele binário. Nenhuma → `undefined`, e o motor
 * produz a recusa legível.
 *
 * Conta pedida que existe mas é do OUTRO CLI cai na regra do cruzado em vez de
 * recusar: o delegador pediu um modelo, e o modelo é quem manda no binário. O
 * recibo carimba a conta que de fato abriu, então a escolha nunca é muda.
 */
export function resolveGuiHelperSeat(
  seats: readonly GuiDelegationSeat[],
  query: { cli: GuiHelperCli; preferredSeatId?: string }
): GuiHelperSeat | undefined {
  const asSeat = (seat: GuiDelegationSeat): GuiHelperSeat => ({
    seatId: seat.id,
    configDir: seat.configDir,
    ...(seat.name ? { name: seat.name } : {})
  })
  if (query.preferredSeatId) {
    const wanted = seats.find((seat) => seat.id === query.preferredSeatId)
    if (wanted && wanted.cli === query.cli) return asSeat(wanted)
  }
  const logged = seats.find((seat) => seat.cli === query.cli && seat.status === 'logado')
  return logged ? asSeat(logged) : undefined
}

// ————— o disco da frota (R6.1) —————

/** O arquivo, em `userData`. O índice compõe o caminho; o nome mora aqui para os
 *  dois lados falarem do MESMO arquivo. */
export const GUI_HELPERS_STORE_FILE = 'gui-helpers.json'

/**
 * O `GuiHelperStore` de PRODUÇÃO, sobre o `jsonStore` atômico da casa — o mesmo
 * que guarda as conversas (`gui-sessions.json`): escrita por rename, backup `.bak`
 * reparável e leitura que cai no backup quando o principal está estragado.
 *
 * O motor não conhece disco (é o que mantém a suíte dele em node puro); esta é a
 * única costura entre os dois, e ela é minúscula de propósito.
 */
export function createGuiHelperStore(file: string): GuiHelperStore {
  return {
    load: () =>
      loadJsonStore<GuiHelperStoreDoc>(
        file,
        () => ({ version: GUI_HELPER_STORE_VERSION, helpers: [] }),
        isGuiHelperStoreDoc
      ).helpers,
    save: (records) =>
      persistJsonStore(file, { version: GUI_HELPER_STORE_VERSION, helpers: records })
  }
}

export interface GuiHelperEngineWiring extends GuiHelperAdapterDeps {
  seats(): GuiDelegationSeat[]
  /**
   * `userData/gui-helpers.json` — ausente DESLIGA a persistência (é como as
   * suítes rodam sem tocar disco, a mesma convenção do `GuiSessionDeps`).
   *
   * Com ele, a frota sobrevive ao fechamento do app: quem estava trabalhando
   * volta como `interrupted` e a conversa que reabrir pode retomá-lo (R6.1).
   */
  storeFile?: string
  onChange(change: GuiHelperChange): void
  log(entry: GuiHelperLogEntry): void
}

/**
 * O DIÁRIO DA DELEGAÇÃO É O DO MOTOR. Quem monta o motor já ligou `log` à
 * caixa-preta, e a API precisa do MESMO destino para auditar o que o motor não
 * enxerga: o desvio do PINO nasce na cadeia do D8, que mora aqui e não lá
 * dentro. Reencontrá-lo pelo próprio motor evita pedir ao chamador uma segunda
 * costura que ele já fez uma vez — e evita um diário que existe no teste e não
 * existe no app.
 */
const engineJournals = new WeakMap<GuiHelperEngine, (entry: GuiHelperLogEntry) => void>()

export function createGuiHelperEngine(wiring: GuiHelperEngineWiring): GuiHelperEngine {
  const catalog = new GuiHelperCatalogCache(
    (cli) => wiring.seats().find((seat) => seat.cli === cli && seat.status === 'logado')?.configDir
  )
  const engine = new GuiHelperEngine({
    spawnClaude: createClaudeHelperAdapter(wiring),
    spawnCodex: createCodexHelperAdapter(wiring),
    resolveSeat: (query) => resolveGuiHelperSeat(wiring.seats(), query),
    modelSupportsEffort: (query) => catalog.supportsEffort(query),
    // A FROTA SOBREVIVE AO APP (R6.1). Ler o disco é a PRIMEIRA coisa que o motor
    // faz no nascimento: quem estava vivo no boot anterior volta `interrupted`.
    ...(wiring.storeFile ? { store: createGuiHelperStore(wiring.storeFile) } : {}),
    // A ENTREGA EM ARQUIVO é do motor de PRODUÇÃO, não uma opção do chamador: a
    // ordem do dono ("todo ajudante sempre entrega em modelo de ARQUIVO") não
    // pode depender de um índice se lembrar de ligá-la.
    deliver: (delivery) => writeGuiHelperDelivery(delivery),
    // E o outro lado dela (R6.2): descartar um ajudante tira a entrega do disco.
    // Também não é opção do chamador — "descartei" com o arquivo ainda lá seria
    // a UI mentindo sobre o que o dono acabou de mandar fazer.
    discardDelivery: (record) => discardGuiHelperDelivery(record),
    onChange: wiring.onChange,
    log: wiring.log
  })
  engineJournals.set(engine, wiring.log)
  return engine
}

// ————— A CADEIA DO PADRÃO (D8): explícito > painel do dono > clone —————

/**
 * De onde saiu cada valor do ajudante. É o que o recibo carimba: sem isso o
 * dono lê "opus · high" e não sabe se aquilo foi escolha do agente, pino dele
 * no painel ou herança da conversa — três coisas que ele julga de formas
 * diferentes.
 */
export type GuiDelegationOrigin = 'explicito' | 'painel' | 'herdado'

/**
 * O fast tem uma cadeia PRÓPRIA porque ele não herda: sem pedido e sem pino ele
 * não fica "herdado da conversa", fica DESLIGADO. `explicito` cobre as duas
 * palavras do agente — o `true` que liga e o `false` que desliga por cima do
 * pino —, que é o que um desvio-do-pino futuro vai precisar enxergar.
 */
export type GuiFastOrigin = 'explicito' | 'painel' | 'desligado'

export interface GuiHelperOrigins {
  model: GuiDelegationOrigin
  effort: GuiDelegationOrigin
  fast: GuiFastOrigin
}

export interface GuiHelperRequestPlan {
  request: GuiHelperRequest
  origins: GuiHelperOrigins
}

const ORIGIN_LABEL: Record<GuiDelegationOrigin, string> = {
  explicito: 'explícito',
  painel: 'painel',
  herdado: 'herdado'
}

/** String vazia é AUSÊNCIA, nunca valor (a mesma régua do motor). */
function asked(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * TRADUZ o pedido da tool no pedido do motor, aplicando a cadeia do D8.
 *
 * A ordem é a do dono: o que o agente escreveu na chamada VENCE (ele está
 * decidindo aquela fatia), depois o pino do PAINEL ("como padrão vai vir eles")
 * e, por último, o clone do delegador — que é a regra da onda 1 e continua
 * inteira embaixo desta: quando NADA foi carimbado, o motor herda modelo e (só
 * dentro do mesmo CLI) o effort da conversa.
 *
 * Um valor do painel viaja como pedido EXPLÍCITO para o motor de propósito: o
 * dono escolheu aquele nível PARA AQUELE MODELO no painel (que filtra effort
 * pelo CLI do modelo), então ele não pode cair na regra do cruzado, que existe
 * para a herança silenciosa da conversa.
 *
 * O FAST (R12) entra na mesma cadeia com uma diferença: ele não tem degrau de
 * herança. O que o agente escreveu vence — `true` liga, `false` DESLIGA mesmo
 * com o painel carimbado —, depois o pino do dono, e o fundo é desligado. A
 * R11 dizia "fast só explícito na tool, nunca do painel"; a queixa 2 do dono
 * (19/08) REVOGOU essa metade: o painel passou a ser um pedido dele, e pedido
 * do dono é exatamente o que autoriza o modo caro. O que continua valendo é o
 * resto da lição do prompt-cache: fast NUNCA se herda da conversa.
 *
 * Aqui também mora a tradução `seat` → `seatId`: a tool publica `seat` (é o que
 * o `list_seats` devolve) e o motor lê `seatId`.
 */
export function planGuiHelperRequests(
  helpers: readonly McpHelperRequestInput[],
  defaults: GuiDelegationDefaults | undefined
): GuiHelperRequestPlan[] {
  const pinnedModel = asked(defaults?.model)
  const pinnedEffort = asked(defaults?.effort)
  const pinnedFast = defaults?.fast === true
  return helpers.map((helper) => {
    const model = asked(helper.model)
    const effort = asked(helper.effort)
    const chosenModel = model ?? pinnedModel
    const chosenEffort = effort ?? pinnedEffort
    // Só `boolean` é palavra do agente: um `fast: 'sim'` do wire é ausência, e
    // ausência devolve a decisão ao pino do dono.
    const askedFast = typeof helper.fast === 'boolean' ? helper.fast : undefined
    const chosenFast = askedFast ?? pinnedFast
    const seatId = asked(helper.seat)
    const name = asked(helper.name)
    return {
      request: {
        prompt: typeof helper.prompt === 'string' ? helper.prompt : '',
        ...(chosenModel ? { model: chosenModel } : {}),
        ...(chosenEffort ? { effort: chosenEffort } : {}),
        ...(seatId ? { seatId } : {}),
        ...(chosenFast ? { fast: true } : {}),
        ...(name ? { name } : {})
      },
      origins: {
        model: model ? 'explicito' : pinnedModel ? 'painel' : 'herdado',
        effort: effort ? 'explicito' : pinnedEffort ? 'painel' : 'herdado',
        fast: askedFast !== undefined ? 'explicito' : chosenFast ? 'painel' : 'desligado'
      }
    }
  })
}

// ————— O PINO É A PALAVRA DO DONO: o advisory auditado —————

/**
 * Um ajudante que abriu FORA do padrão carimbado, e o que ele levou no lugar.
 * Só entra aqui quem o agente escreveu na chamada (origem `explicito`): valor
 * herdado ou vindo do próprio painel nunca é desvio.
 */
export interface GuiPinDeviation {
  helperId: string
  name?: string
  /** modelo que o agente escolheu por cima do pino (ausente = só o effort desviou) */
  model?: string
  effort?: string
}

/** Rótulo de modelo/effort é identificador de UI: espaço e caixa não contam. */
function samePin(chosen: string | undefined, pinned: string): boolean {
  return (chosen ?? '').trim().toLowerCase() === pinned.trim().toLowerCase()
}

/**
 * O DESVIO DO PINO (2026-08-18, 2º teste ao vivo do dono).
 *
 * Caso real: painel carimbado em "opus[1m] · high", pedido "abre 5 subagentes"
 * sem citar modelo, e o chat abriu 4 opus + 1 gpt-5.6-luna porque o `list_seats`
 * mostrava folga numa conta codex. Palavras dele: "eu não especifiquei que eu
 * queria luna — ele teria que abrir os cinco do padrão que eu mandei".
 *
 * A entrega NÃO é recusada: "abre 2 lunas" é ordem legítima do dono e chega à
 * tool exatamente igual à invenção do agente — a camada mecânica não sabe quem
 * falou (memória feedback-guardas-nao-capam-inteligencia). Então esta função é
 * a metade CONTÁVEL da régua: ela nomeia quem saiu do padrão para o recibo
 * cobrar e o diário registrar; a proibição mora na persona.
 *
 * O EFFORT só se compara DENTRO do CLI do pino: as escalas não se traduzem
 * (claude vai a max, codex a xhigh) e o motor já derruba o herdado no cruzado —
 * cobrar o nível do outro binário contra o pino seria inventar uma comparação.
 * Quem atravessou o CLI já é desvio pelo MODELO, que é o que importa.
 *
 * O FAST fica FORA desta conta na R12 (anotado como futuro): `origins.fast`
 * já distingue o `false` explícito do agente do simples desligado, então o dia
 * em que o desvio cobrar o ⚡ o sinal está aqui — hoje quem proíbe a invenção é
 * a persona.
 */
export function guiPinDeviations(
  plans: readonly GuiHelperRequestPlan[],
  receipts: readonly GuiHelperReceipt[],
  pin: GuiDelegationDefaults | undefined,
  delegatorCli: GuiHelperCli
): GuiPinDeviation[] {
  const pinnedModel = asked(pin?.model)
  const pinnedEffort = asked(pin?.effort)
  if (!pinnedModel && !pinnedEffort) return []
  // Sem modelo carimbado, o pino do effort pertence à escala da conversa: é o
  // CLI em que o painel o ofereceu.
  const pinnedCli = pinnedModel ? resolveHelperCli(pinnedModel) : delegatorCli
  const deviations: GuiPinDeviation[] = []
  plans.forEach((plan, index) => {
    // Um recibo por pedido, na ordem (contrato do `spawn`). Ajudante que NÃO
    // abriu não é desvio: não há o que cancelar nem o que reabrir.
    const receipt = receipts[index]
    if (!receipt?.ok) return
    const model =
      pinnedModel && plan.origins.model === 'explicito' && !samePin(plan.request.model, pinnedModel)
        ? plan.request.model
        : undefined
    const effort =
      pinnedEffort &&
      plan.origins.effort === 'explicito' &&
      receipt.cli === pinnedCli &&
      !samePin(plan.request.effort, pinnedEffort)
        ? plan.request.effort
        : undefined
    if (!model && !effort) return
    deviations.push({
      helperId: receipt.helperId,
      ...(receipt.name ? { name: receipt.name } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {})
    })
  })
  return deviations
}

/**
 * O aviso que viaja no recibo. Ele nomeia as TRÊS coisas sem as quais o agente
 * não consegue agir: o padrão do dono, quem saiu dele e o movimento de desfazer.
 * E deixa a porta legítima aberta — se o dono pediu aquilo ali, o certo é seguir
 * e dizer isso na resposta, não cancelar trabalho bom.
 */
export function guiPinDeviationText(
  pin: GuiDelegationDefaults | undefined,
  deviations: readonly GuiPinDeviation[]
): string | undefined {
  if (deviations.length === 0) return undefined
  const pinned = [asked(pin?.model), asked(pin?.effort)]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
  const list = deviations
    .map((deviation) => {
      const chose = [deviation.model, deviation.effort]
        .filter((part): part is string => Boolean(part))
        .join(' · ')
      const who = deviation.name ? `${deviation.name} (${deviation.helperId})` : deviation.helperId
      return `${who} abriu com ${chose}`
    })
    .join('; ')
  return (
    `O DONO CARIMBOU no painel deste chat: ${pinned}. Fora do padrão: ${list}. ` +
    'Pedido dele SEM modelo/effort = o padrão do painel, para a frota INTEIRA — escolher outro por conta ' +
    'própria (a conta com mais folga, um palpite de custo) é decidir no lugar dele. ' +
    'Se ele não pediu esses valores AQUI, nesta conversa: cancele esses ajudantes com helper_cancel e ' +
    'reabra no padrão. Se pediu, siga e diga na sua resposta que abriu fora do padrão a pedido dele.'
  )
}

// ————— o texto que o delegador lê —————

function stamped(
  value: string | undefined,
  origin: GuiDelegationOrigin | undefined
): string | undefined {
  if (!value) return undefined
  return origin ? `${value} (${ORIGIN_LABEL[origin]})` : value
}

function receiptLine(receipt: GuiHelperReceipt, origins?: GuiHelperOrigins): string {
  if (!receipt.ok) {
    return `✗ ${receipt.name ? `${receipt.name}: ` : ''}${receipt.error}`
  }
  // Modelo vazio = o delegador roda no padrão da conta e o card não pode
  // inventar um nome; a linha simplesmente não mostra o campo. Effort que o
  // motor derrubou também não aparece — e o motivo vem logo abaixo.
  const parts = [
    stamped(receipt.model, origins?.model),
    stamped(receipt.effort, origins?.effort),
    receipt.seatName ?? receipt.seatId,
    receipt.cli
  ].filter((part): part is string => Boolean(part))
  const head = `✓ ${receipt.name ? `${receipt.name} — ` : ''}${receipt.helperId}`
  const dropped = receipt.effortDropped ? `\n    · ${receipt.effortDropped}` : ''
  return `${head}\n    ${parts.join(' · ')}${dropped}`
}

export function guiHelperSpawnText(
  receipts: readonly GuiHelperReceipt[],
  /** Avisos do lote, cada um com o próprio ⚠. São independentes — o custo da
   *  frota (motor) e o desvio do pino (D8) podem cair na mesma chamada, e
   *  costurá-los num parágrafo só faria o segundo passar por detalhe do
   *  primeiro. String continua valendo: é como os chamadores antigos chamam. */
  warning?: string | readonly (string | undefined)[],
  /** Uma entrada por recibo, NA MESMA ORDEM (o motor devolve um recibo por
   *  pedido, na ordem em que recebeu). Ausente = recibo sem carimbo de origem,
   *  que é o que os chamadores antigos continuam vendo. */
  origins?: readonly GuiHelperOrigins[]
): string {
  const opened = receipts.filter((receipt) => receipt.ok).length
  const head =
    opened === 0
      ? 'nenhum ajudante abriu'
      : opened === 1
        ? '1 ajudante aberto (trabalhando agora, em sessão própria)'
        : `${opened} ajudantes abertos (trabalhando agora, cada um em sessão própria)`
  const body = receipts.map((receipt, index) => receiptLine(receipt, origins?.[index])).join('\n')
  const tail =
    opened > 0
      ? '\n\nEles NÃO bloqueiam você: siga conversando. Acompanhe por helpers_status, ' +
        'colha com helper_result (long-poll), dirija com helper_send, retome um parado com ' +
        'helper_resume e jogue fora com helper_cancel (que DESCARTA: registro e entrega somem).'
      : ''
  const notes = (typeof warning === 'string' ? [warning] : (warning ?? []))
    .filter((note): note is string => Boolean(note && note.trim()))
    .map((note) => `\n\n⚠ ${note}`)
    .join('')
  return `${head}:\n${body}${notes}${tail}`
}

function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 90) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  return `${minutes}min`
}

export function guiHelperStatusText(snapshots: readonly GuiHelperSnapshot[]): string {
  if (snapshots.length === 0) {
    return 'nenhum ajudante neste chat — abra com delegate quando quiser paralelizar.'
  }
  const lines = snapshots.map((snapshot) => {
    const head = `${snapshot.name ? `${snapshot.name} — ` : ''}${snapshot.helperId}`
    const meta = [snapshot.model, snapshot.effort, snapshot.seatName ?? snapshot.seatId].filter(
      (part): part is string => Boolean(part)
    )
    // SEGUNDA VIDA (R6.2): o decorrido conta da VOLTA, e sem esta marca um
    // ajudante que já trabalhou meia hora pareceria recém-nascido.
    const vida = snapshot.resumedAt !== undefined ? ' (retomado)' : ''
    const detail: string[] = [
      `${helperStateLabel(snapshot.state)}${vida} há ${elapsedText(snapshot.elapsedMs)}`
    ]
    // RE-TENTATIVA EM CURSO (R6.4): enquanto o respiro corre, o card diz por que
    // ele ainda não partiu — "abrindo há 20s" sozinho pareceria travado.
    if (snapshot.retriedAt !== undefined && snapshot.state === 'spawning') {
      detail.push(`re-tentando · ${snapshot.retryReason ?? 'falha passageira na partida'}`)
    }
    if (snapshot.lastActivity) detail.push(`agora: ${snapshot.lastActivity.summary}`)
    if (snapshot.contextTokens) detail.push(`contexto ~${Math.round(snapshot.contextTokens / 1000)}k`)
    // O ARQUIVO é o endereço da entrega; o helper_result devolve o mesmo
    // caminho e é o que sobra quando o disco recusou.
    if (snapshot.resultPath) detail.push(`entrega: ${snapshot.resultPath}`)
    else if (snapshot.hasResult) detail.push('entrega pronta (helper_result)')
    if (snapshot.failure) detail.push(snapshot.failure)
    return `- ${head}\n    ${meta.join(' · ')}\n    ${detail.join(' · ')}`
  })
  const live = snapshots.filter((snapshot) => snapshot.state === 'spawning' || snapshot.state === 'working')
  // A RECEITA DOS PARADOS vem UMA vez, no fim: repeti-la por ajudante seria
  // contexto pago em toda linha de uma frota de vinte.
  const parados = snapshots.filter((snapshot) => snapshot.state === 'interrupted').length
  const receita =
    parados > 0
      ? `\n\n${parados} interrompido(s): retome com helper_resume (volta de onde parou) ou ` +
        'descarte com helper_cancel — na dúvida, pergunte ao dono qual dos dois ele quer.'
      : ''
  return `${snapshots.length} ajudante(s) neste chat · ${live.length} vivo(s):\n${lines.join('\n')}${receita}`
}

/**
 * A RESPOSTA DO `helper_result` — CAMINHO PRIMEIRO, texto depois.
 *
 * Ordem do dono (2026-08-18): "todo ajudante sempre entrega em modelo de
 * ARQUIVO". Então o que esta resposta faz é ENDEREÇAR: o arquivo abre a
 * mensagem, um começo da entrega vem junto para o delegador decidir se abre
 * agora, e o resto fica onde está. A memória feedback-agente-saida-em-arquivo é
 * o porquê — um payload inline gigante já queimou uma rodada de 35 minutos.
 *
 * Sem arquivo (disco recusou) a resposta DEGRADA para o texto inteiro inline com
 * o motivo colado: honesta, e nunca uma entrega perdida.
 */
export function guiHelperResultText(outcome: GuiHelperResultOutcome): string {
  if (!outcome.ok) return outcome.error
  if (outcome.pending) {
    const activity = outcome.snapshot.lastActivity?.summary
    return (
      `ainda trabalhando (${helperStateLabel(outcome.snapshot.state)} há ${elapsedText(outcome.snapshot.elapsedMs)}` +
      `${activity ? `, agora: ${activity}` : ''}). ` +
      'Esperei o que pedi e devolvi a fotografia — chame de novo quando quiser, ' +
      'ou siga com outra coisa: o ajudante não para porque você saiu.'
    )
  }
  // INTERROMPIDO NÃO É DESFECHO (R6.1). Dizer "encerrou" aqui apagaria a única
  // saída que este ajudante tem: a conversa dele está guardada e ele volta de
  // onde parou. O verbo da retomada chega na onda R6-B; a honestidade, agora.
  if (outcome.state === 'interrupted') {
    const head =
      `o ajudante ${outcome.helperId} está INTERROMPIDO: ${outcome.failure ?? 'parado sem motivo declarado'}. ` +
      'O processo dele morreu, mas a conversa ficou guardada — dá para RETOMAR com helper_resume ' +
      '(ele volta de onde parou, na mesma conversa) ou descartar com helper_cancel. ' +
      'Se não estiver claro o que o dono quer, pergunte a ele antes.'
    return outcome.resultPath
      ? `${head}\n\nO que ele chegou a escrever está em ${outcome.resultPath}.`
      : head
  }
  if (outcome.state !== 'done') {
    const head = `o ajudante ${outcome.helperId} encerrou como ${helperStateLabel(outcome.state)}: ${outcome.failure ?? 'sem motivo declarado'}`
    return outcome.resultPath
      ? `${head}\n\nO registro (com o que ele chegou a escrever) está em ${outcome.resultPath}.`
      : head
  }
  const full = outcome.result ?? ''
  if (!outcome.resultPath) {
    const why = outcome.deliveryError ? `\n[synkora] a entrega NÃO virou arquivo: ${outcome.deliveryError}` : ''
    return `entrega do ajudante ${outcome.helperId}${outcome.truncated ? ' (cortada no teto)' : ''}:${why}\n\n${full}`
  }
  // DEPOIS DO BOOT a cópia inline não existe (o disco guarda o registro, nunca a
  // entrega — ela já está no arquivo). Anunciar "a entrega, inteira" seguida de
  // nada seria a resposta mais enganosa do catálogo.
  if (!full.trim()) {
    return `entrega do ajudante ${outcome.helperId}: está inteira no arquivo ${outcome.resultPath} — abra ele.`
  }
  const cut = full.length > GUI_HELPER_RESULT_HEAD_CHARS
  const head = cut ? `${full.slice(0, GUI_HELPER_RESULT_HEAD_CHARS)}…` : full
  return [
    `entrega do ajudante ${outcome.helperId}: o texto COMPLETO está no arquivo ${outcome.resultPath} — abra ele.`,
    '',
    cut ? 'começo da entrega:' : 'a entrega, inteira:',
    '',
    head,
    ...(cut
      ? ['', `[synkora] daqui em diante só no arquivo ${outcome.resultPath} — não peça o texto de novo ao ajudante.`]
      : [])
  ].join('\n')
}

function usageText(info: SeatUsageInfo | null | undefined, now: number): string {
  if (!info) return 'limites não consultados agora'
  const age = Math.max(0, Math.round((now - info.at) / 60_000))
  const meters = info.meters
    .map((meter) => `${meter.label}: ${meter.pct}% ${meter.mode === 'used' ? 'usado' : 'restante'}`)
    .join(' · ')
  const head = meters || info.lines.slice(0, 2).join(' · ') || 'sem medidor reconhecido'
  return `${head}${age > 0 ? ` (leitura de ${age}min atrás)` : ''}`
}

export function guiHelperSeatsText(
  seats: readonly GuiDelegationSeat[],
  usage: ReadonlyMap<string, SeatUsageInfo | null>,
  now: number
): string {
  if (seats.length === 0) return 'nenhuma conta cadastrada neste app.'
  const lines = seats.map((seat) => {
    const plan = usage.get(seat.id)?.plan
    return (
      `- ${seat.name} [${seat.id}] · ${seat.cli}${plan ? ` ${plan}` : ''} · ${seat.status}\n` +
      `    ${usageText(usage.get(seat.id), now)}`
    )
  })
  return (
    'contas deste app (use o id em delegate.seat para escolher onde gastar limite):\n' +
    `${lines.join('\n')}\n\n` +
    'Frota grande: distribua pelas contas com mais folga — o modelo decide o CLI ' +
    '(gpt-* = codex; o resto = claude) e a conta segue o modelo.'
  )
}

// ————— as tools do McpApi —————

export interface GuiDelegationApiDeps {
  engine: GuiHelperEngine
  /** O chat vivo do pane (modelo/effort/conta atuais) — `undefined` = sem sessão. */
  delegator(paneId: string): GuiHelperDelegator | undefined
  /** Abre/fecha a janela do lote no anel do delegador (a costura de correlação). */
  beginBatch(paneId: string): string | undefined
  endBatch(paneId: string): void
  /** O PINO DO DONO no painel deste chat (D8). Ausente/vazio = os ajudantes
   *  clonam a conversa, que é o comportamento da onda 1. */
  defaults?(paneId: string): GuiDelegationDefaults | undefined
  /** Diário do desvio do pino. Ausente = o do MOTOR que veio em `engine`
   *  (`createGuiHelperEngine` já o registrou) — passar um aqui é como a suíte
   *  observa a auditoria sem subir processo de CLI nenhum. */
  log?(entry: GuiHelperLogEntry): void
  /** O CORREIO dos ajudantes. Ausente = o de produção, que é o MESMO pote em
   *  que o correlacionador de cards posta os encerramentos. */
  inbox?: GuiHelperInbox
  /** O POTE DO DONO (R22). Ausente = o de produção (`guiOwnerMailbox`), que é o
   *  MESMO em que a rota de envio (`guiSessions.send`) guarda a fala do dono
   *  quando ela chega com o turno aberto. A injeção existe para a suíte não
   *  dividir um pote global entre duas bancadas do mesmo paneId. */
  ownerMail?: GuiOwnerMailbox
  /** A DÍVIDA DE RESPOSTA (R32). Ausente = a de produção (`guiOwnerReplyDebt`),
   *  a MESMA que o pump do `guiSessions` quita quando o agente fala. */
  replyDebt?: GuiOwnerReplyDebt
  seats(): GuiDelegationSeat[]
  seatUsage?(seat: GuiDelegationSeat): Promise<SeatUsageInfo | null>
  now?(): number
}

/** Identidade mínima que as tools consomem (o `PaneIdentity` do hub cabe aqui). */
export interface GuiDelegationIdentity {
  paneId: string
  role: string
  projectId: string
  cwd: string
}

const NOT_A_DELEGATOR = 'esta conversa não delega ajudantes'
const NO_SESSION = 'o chat deste pane não está aberto'

function helperOfPane(
  deps: GuiDelegationApiDeps,
  identity: GuiDelegationIdentity,
  helperId: string
): { ok: true } | { ok: false; error: string } {
  const record = deps.engine.get(helperId)
  // Escopo por pane, e é cerca: um chat nunca lê, dirige ou cancela o ajudante
  // de outro. O id é opaco, mas opacidade não é autorização.
  if (!record || record.delegatorPaneId !== identity.paneId) {
    return {
      ok: false,
      error: `ajudante ${helperId} não é deste chat — confira o id no helpers_status`
    }
  }
  return { ok: true }
}

export function buildGuiDelegationApi(deps: GuiDelegationApiDeps): {
  delegateHelpers(id: GuiDelegationIdentity, helpers: McpHelperRequestInput[]): Promise<string>
  listSeats(id: GuiDelegationIdentity): Promise<string>
  helpersStatus(id: GuiDelegationIdentity): string
  helperResult(id: GuiDelegationIdentity, helperId: string, waitSeconds?: number): Promise<string>
  helperSend(id: GuiDelegationIdentity, helperId: string, text: string): string
  helperCancel(id: GuiDelegationIdentity, helperId: string): string
  helperResume(id: GuiDelegationIdentity, helperId: string): string
} {
  const now = deps.now ?? Date.now
  /**
   * O PORTÃO dos sete verbos: papel primeiro, DÍVIDA DE RESPOSTA depois (R32).
   *
   * A dívida nasce na carona (`withOwnerMail`, logo abaixo) e é guarda DURA de
   * autoridade: o caso do transcript de 23/08 provou que persona + ordem no
   * bloco não bastam — o modelo leu "FALE COM ELE JÁ" e voltou ao long-poll
   * mudo. Enquanto o dono não ouvir resposta, nenhuma tool de delegação anda;
   * a recusa re-cita a fala dele e nomeia a única saída (falar no chat), e o
   * pump do `guiSessions` quita no primeiro texto do assistente. A recusa NÃO
   * drena correio nenhum de propósito: recusar não consome nada.
   */
  const guard = (id: GuiDelegationIdentity): string | null => {
    // DOIS papéis delegam desde 2026-08-30: o chat de missão e o PLANEJADOR
    // (ordem do dono: pesquisa é trabalho dele, com a mesma lateral e o mesmo
    // pino). A cerca de autoridade continua a mesma: ajudante, release e
    // qualquer outra identidade ficam fora.
    if (id.role !== 'gui-delegator' && id.role !== 'gui-planner') return NOT_A_DELEGATOR
    const owed = replyDebt.pending(id.paneId)
    if (!owed) return null
    journal({
      event: 'owner-reply-enforced',
      paneId: id.paneId,
      detail: { messages: owed.length }
    })
    return guiOwnerReplyRefusal(owed)
  }
  // Diário indisponível ou quebrado nunca derruba uma entrega que já aconteceu:
  // a mesma disciplina do `journal` do motor.
  const journal = (entry: GuiHelperLogEntry): void => {
    try {
      ;(deps.log ?? engineJournals.get(deps.engine))?.(entry)
    } catch {
      /* auditoria é registro, não pré-condição */
    }
  }

  /**
   * O CORREIO DE CARONA — a correção do 5º teste do dono (18/08).
   *
   * O caso real: dois ajudantes encerraram enquanto o delegador estava DENTRO do
   * turno, esperando um terceiro no long-poll. O despertador segurou o aviso (e
   * fez certo: turno vivo não se interrompe), e o agente — cego lá dentro —
   * disse ao dono "nenhum terminou" com a lateral mostrando três rodando.
   * Palavras dele: "cada ajudante que terminar, avisar o orquestrador que
   * terminou e entregar via MCP, pra não poluir o chat".
   *
   * Então TODA resposta de tool deste catálogo carrega as novidades pendentes.
   * É o padrão do correio F6 (o bloco `[synkora inbox]` que viajava nos
   * resultados de tool, CLAUDE.md F6.10), agora no escopo da delegação — e no
   * lugar certo: aqui, e não no transporte do `mcpServer`, que não sabe nada de
   * ajudante e serve outros papéis.
   *
   * `except` existe para o `helper_result` não ecoar o ajudante que ele acabou
   * de entregar: a leitura JÁ é a entrega daquele, e repeti-la faria o agente
   * pensar que houve um segundo fim.
   */
  const inbox = deps.inbox ?? guiHelperInbox
  const ownerMail = deps.ownerMail ?? guiOwnerMailbox
  const replyDebt = deps.replyDebt ?? guiOwnerReplyDebt

  /**
   * A CARONA DO DONO (R22.2) — a MESMA costura, com a outra carga.
   *
   * O caso do print (19/08): o delegador em laço de `helper_result` e a fala do
   * dono presa na fila interna do CLI até o turno fechar (horas, pós-R19). Como
   * o único canal que alcança o modelo no meio do turno é o resultado de tool,
   * a fala dele viaja aqui — no fim do bloco, que é o último lugar que o modelo
   * lê antes de decidir o próximo passo.
   *
   * Drenar É a entrega, então drenar É o recibo: o diário carimba paneId e
   * tamanho. Se um dia a resposta se perder no transporte, é este carimbo que
   * distingue "o app não entregou" de "o agente ignorou".
   */
  const withOwnerMail = (paneId: string, body: string): string => {
    // R39 D2 — a carona NÃO leva correio de HANDOFF. Essa fala parou o turno (o
    // `interrupt` já saiu) e pertence ao TURNO NOVO que vai nascer do fecho:
    // entregá-la aqui a colocaria dentro do turno que está sendo cortado, e o
    // modelo a leria e a perderia no mesmo passo. Ela sai pelo flush, com o
    // envelope de retomada. O correio sem marca continua viajando como sempre.
    const mail = ownerMail.drain(paneId, { skipHandoff: true })
    if (mail.length === 0) return body
    const block = guiOwnerMailBlock(mail)
    // R32 — entregar ARMA a dívida: a partir daqui, os verbos deste catálogo
    // recusam até o agente falar com o dono (o guard cobra, o pump quita).
    replyDebt.arm(
      paneId,
      mail.map((entry) => entry.text)
    )
    journal({
      event: 'owner-mail-ride',
      paneId,
      detail: { messages: mail.length, chars: block.length, replyDebtArmed: true }
    })
    return `${body}\n\n${block}`
  }

  const withInbox = (paneId: string, body: string, except?: string): string => {
    const entries = inbox.drain(paneId, except)
    if (entries.length === 0) return withOwnerMail(paneId, body)
    let stillWorking = 0
    try {
      stillWorking = deps.engine.liveCount(paneId)
    } catch {
      // Contar quem sobrou é informação, nunca pré-condição da entrega.
    }
    // O DONO POR ÚLTIMO, sempre: a novidade dos ajudantes é relatório, a fala
    // dele é ordem — e ordem se lê depois do relatório, nunca antes.
    return withOwnerMail(paneId, `${body}\n\n${guiHelperInboxBlock(entries, { stillWorking })}`)
  }

  return {
    async delegateHelpers(id, helpers) {
      const refusal = guard(id)
      if (refusal) return refusal
      const delegator = deps.delegator(id.paneId)
      if (!delegator) return NO_SESSION
      if (!Array.isArray(helpers) || helpers.length === 0) {
        return 'mande ao menos um ajudante em `helpers` — cada item é uma fatia de trabalho.'
      }
      // A CADEIA DO D8 mora AQUI, e não no motor: o motor recebe valores já
      // decididos (é o que o mantém puro e testável), e quem conhece o pino do
      // dono é a costura com o main.
      const pin = deps.defaults?.(id.paneId)
      const plans = planGuiHelperRequests(helpers, pin)
      // A JANELA DO LOTE envolve o spawn INTEIRO: os avisos `spawned` chegam
      // dentro dele, e é o lote aberto que os liga à chamada `delegate` que o
      // CLI publicou. Sem o try/finally, uma exceção deixaria a janela aberta e
      // o lote seguinte herdaria os ajudantes deste.
      deps.beginBatch(id.paneId)
      let outcome
      try {
        outcome = deps.engine.spawn(
          delegator,
          plans.map((plan) => plan.request)
        )
      } finally {
        deps.endBatch(id.paneId)
      }
      // O PINO É A PALAVRA DO DONO (2026-08-18): a frota já abriu — o desvio
      // vira aviso com receita, nunca recusa, porque "abre 2 lunas" é ordem
      // legítima e daqui não se distingue da invenção do agente.
      const deviations = guiPinDeviations(plans, outcome.receipts, pin, delegator.cli)
      if (deviations.length > 0) {
        const pinnedModel = asked(pin?.model)
        const pinnedEffort = asked(pin?.effort)
        // A união de eventos do motor é dele: o desvio entra pelo evento de
        // ADVERTÊNCIA DE LOTE que já existe, e `detail.kind` é o que separa os
        // dois na caixa-preta.
        journal({
          event: 'helper-fleet-effort',
          paneId: id.paneId,
          detail: {
            kind: 'pin-deviation',
            ...(pinnedModel ? { pinnedModel } : {}),
            ...(pinnedEffort ? { pinnedEffort } : {}),
            helpers: deviations
          }
        })
      }
      // Um recibo por pedido, na ordem (contrato do `spawn`): é o que deixa a
      // origem viajar por índice sem inventar um id de correlação novo.
      const spawnText = guiHelperSpawnText(
        outcome.receipts,
        [outcome.warning, guiPinDeviationText(pin, deviations)],
        plans.map((plan) => plan.origins)
      )
      // R32 (queixa do dono, 23/08: "abriu dois subagentes e não falou por
      // quê"): o recibo empurra a fala NO MOMENTO exato — advisory, nunca
      // recusa; a lateral mostra os cards, mas só o agente sabe o plano.
      return withInbox(
        id.paneId,
        `${spawnText}\n\nAVISE O DONO no chat, agora, em uma linha: o que esta frota vai fazer e por quê — ele vê os cards na lateral, não o seu plano.`
      )
    },

    async listSeats(id) {
      const refusal = guard(id)
      if (refusal) return refusal
      const seats = deps.seats()
      const usage = new Map<string, SeatUsageInfo | null>()
      if (deps.seatUsage) {
        // Cache quente responde na hora; conta fria spawna um processo efêmero.
        // O teto é do SERVIDOR: melhor a lista sem limites do que a tool cortada.
        const deadline = new Promise<null>((resolve) => {
          const timer = setTimeout(() => resolve(null), SEAT_USAGE_WAIT_MS)
          timer.unref?.()
        })
        await Promise.all(
          seats.map(async (seat) => {
            const info = await Promise.race([
              deps.seatUsage?.(seat).catch(() => null) ?? Promise.resolve(null),
              deadline
            ])
            usage.set(seat.id, info ?? null)
          })
        )
      }
      return withInbox(id.paneId, guiHelperSeatsText(seats, usage, now()))
    },

    helpersStatus(id) {
      const refusal = guard(id)
      if (refusal) return refusal
      return withInbox(id.paneId, guiHelperStatusText(deps.engine.status(id.paneId)))
    },

    async helperResult(id, helperId, waitSeconds) {
      const refusal = guard(id)
      if (refusal) return refusal
      const owned = helperOfPane(deps, id, helperId)
      if (!owned.ok) return owned.error
      // O CORREIO É COLHIDO DEPOIS DA ESPERA, de propósito: o long-poll segue
      // esperando o ajudante PEDIDO (contrato intacto) e quem encerrou no meio
      // do caminho é contado na volta — a cegueira do 5º teste morre aqui.
      const body = guiHelperResultText(await deps.engine.result(helperId, waitSeconds))
      return withInbox(id.paneId, body, helperId)
    },

    helperSend(id, helperId, text) {
      const refusal = guard(id)
      if (refusal) return refusal
      const owned = helperOfPane(deps, id, helperId)
      if (!owned.ok) return owned.error
      const sent = deps.engine.send(helperId, text)
      return withInbox(
        id.paneId,
        sent.ok ? `mensagem entregue ao ajudante ${helperId} — ela entra no turno dele.` : sent.error
      )
    },

    helperCancel(id, helperId) {
      const refusal = guard(id)
      if (refusal) return refusal
      const owned = helperOfPane(deps, id, helperId)
      if (!owned.ok) return owned.error
      const cancelled = deps.engine.cancel(helperId, 'descartado pelo chat que o abriu')
      return withInbox(
        id.paneId,
        cancelled.ok
          ? `ajudante ${helperId} DESCARTADO: a sessão morreu e o arquivo de entrega dele saiu do ` +
              'worktree. O que ele chegou a MUDAR no código continua lá — desfazer isso é git, e é ' +
              'seu: peça ao dono antes de mexer.'
          : cancelled.error
      )
    },

    /**
     * RETOMAR (R6.2) — o verbo que fecha o ciclo. Recusa do motor viaja
     * VERBATIM: ela é que nomeia o estado real e o verbo certo, e reescrevê-la
     * aqui seria uma segunda verdade sobre o mesmo ajudante.
     */
    helperResume(id, helperId) {
      const refusal = guard(id)
      if (refusal) return refusal
      const owned = helperOfPane(deps, id, helperId)
      if (!owned.ok) return owned.error
      const resumed = deps.engine.resume(helperId)
      return withInbox(
        id.paneId,
        resumed.ok
          ? `ajudante ${helperId} RETOMADO: mesma conversa, mesmo executor, continuando de onde ` +
              'parou. Acompanhe por helpers_status e colha a entrega com helper_result.'
          : resumed.error
      )
    }
  }
}
