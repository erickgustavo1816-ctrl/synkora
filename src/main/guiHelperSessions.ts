/**
 * MOTOR DOS AJUDANTES SEM ABA (Synkora 2.0 — D1 do design vinculante
 * `.synkora/reports/DESIGN_SUBAGENTES_SEM_ABA_2026-08-18.md`).
 *
 * Ordem do dono (18/08): "ele NUNCA MAIS vai abrir subagentes dele — ele vai
 * abrir subagentes via MCP. Porque via MCP eu vejo na lateral o MODELO e o
 * EFFORT que subiu". Este módulo é o lado do harness dessa ordem: um ajudante é
 * uma sessão HEADLESS do CLI, dona de um pane delegador, que recebe um prompt,
 * trabalha, entrega o texto final e MORRE. Ele nunca vira aba, nunca vira
 * terminal, e todo fato que a lateral mostra (modelo, effort, conta, atividade,
 * contexto, desfecho) nasce aqui.
 *
 * O QUE ESTE MÓDULO NÃO SABE, DE PROPÓSITO:
 * - não conhece `MaestroSession`/`CodexSession`: os dois motores entram por
 *   ADAPTADOR injetado (`spawnClaude`/`spawnCodex`). O que o motor precisa de um
 *   CLI cabe em quatro linhas — mandar prompt, receber eventos, dirigir, matar —
 *   e é só isso que o adaptador promete;
 * - não conhece `SeatStore`: a conta chega por `resolveSeat`, que é quem sabe
 *   quais estão logadas;
 * - não conhece electron, disco nem rede. É por isso que a máquina de estados, o
 *   backstop, o long-poll e o AVISO de longa duração são provados em node puro
 *   (`test:gui-helper-sessions`) em vez de conferidos no olho com o app aberto.
 *
 * - não sabe ESCREVER a entrega: o arquivo canônico de cada ajudante nasce pelo
 *   `deliver` injetado (2026-08-18, ordem do dono: "todo ajudante sempre entrega
 *   em modelo de ARQUIVO"). O motor só decide QUANDO gravar e guarda o caminho.
 *
 * SEM CADEIA (cerca dura do D1): o `GuiHelperSpawnRequest` NÃO tem campo de
 * ferramenta. Ajudante nasce sem o MCP de delegação — quem delega é o chat do
 * dono, e uma frota que abre frota é justamente o laço que o backstop existe
 * para conter. Acrescentar `mcp`/`extraArgs` aqui reabriria a cadeia.
 *
 * FATOS MEDIDOS QUE VIRARAM CÓDIGO (sondas de 2026-08-18, no scratchpad:
 * probe-helper-matrix, probe-claude-fence, probe-codex-fence):
 * - claude em `-p` é FIRE-AND-FORGET: entrega o `result` e morre sozinho com
 *   exit 0 (§2.6). Por isso `closed` é DESFECHO neste motor, não ruído;
 * - o `app-server` do codex NUNCA encerra sozinho ao fim do turno (§6). Por isso
 *   todo desfecho chama `dispose()` — o kill é do motor, não do chamador;
 * - a tool MCP do claude é cortada em EXATOS 60s por default e o codex ABANDONA
 *   a espera sem cancelar o HTTP (S3). Por isso o teto do long-poll é do
 *   SERVIDOR: 45s de padrão, 240s de máximo, sempre grampeado aqui;
 * - modelo sem `supportsEffort` (haiku) engole `--effort` sem avisar (§2.4), e
 *   effort variado numa frota claude estoura o prompt-cache (§2.3, 3,7× medido).
 *   As duas armadilhas viraram função pura, para o aviso existir antes do gasto.
 *
 * O CICLO REDONDO (R6-A, 2026-08-18 à noite — ordem do dono: "não faz só um
 * remendo, faz um planejamento por trás"). O MVP da não-persistência MORREU:
 * - `interrupted` é a parada PRESERVADORA (o ■ do dono, o app fechando). O
 *   processo morre, o registro fica, e é o ÚNICO estado de onde se volta;
 * - os registros pousam num `store` INJETADO (userData/gui-helpers.json no app,
 *   memória nas suítes). Boot marca quem estava vivo como `interrupted` — "o app
 *   fechou" é interrupção, nunca descarte;
 * - o `sessionId` de cada ajudante é carimbado no instante em que o CLI o
 *   anuncia: é a matéria-prima do resume (a conversa em si já persiste de graça
 *   no disco do próprio CLI);
 * - a frota parte ESCALONADA (~2s entre processos — a spec literal do dono), e
 *   uma queda claramente passageira (529/overloaded/rate-limit) na PARTIDA ganha
 *   UMA re-tentativa automática.
 */
import { randomUUID } from 'node:crypto'

export type GuiHelperCli = 'claude' | 'codex'

/**
 * `spawning` = pedido aceito, processo nascendo (ou esperando a vez na fila de
 * partida); `working` = o CLI deu o primeiro sinal de vida.
 *
 * `interrupted` (R6.1) é o quarto desfecho e o único de MÃO DUPLA: parada
 * preservadora, com registro, sessionId e entrega parcial intactos. `cancelled`
 * é descarte ("não quero mais nada"), `failed` é queda, `done` é entrega.
 */
export type GuiHelperState =
  | 'spawning'
  | 'working'
  | 'done'
  | 'failed'
  | 'interrupted'
  | 'cancelled'

/** O fim da linha — `interrupted` NÃO entra aqui de propósito: dele se volta. */
export const GUI_HELPER_TERMINAL_STATES: readonly GuiHelperState[] = [
  'done',
  'failed',
  'cancelled'
]

/**
 * ASSENTADO = não está mais vivo. Escrito pela negativa (nem `spawning` nem
 * `working`) porque é isso que o motor pergunta: quem espera no long-poll acorda,
 * quem conta o backstop não conta, e o processo já foi descartado. Um estado novo
 * de PARADA entra sozinho na regra certa; um estado novo de vida obriga a mexer
 * aqui, que é exatamente onde se deve pensar.
 */
export function isGuiHelperSettled(state: GuiHelperState): boolean {
  return state !== 'spawning' && state !== 'working'
}

/** Só o interrompido se retoma: os outros três desfechos são finais. */
export function isGuiHelperResumable(state: GuiHelperState): boolean {
  return state === 'interrupted'
}

/** Fim da linha de verdade: nem se retoma, nem se descarta — já acabou. */
export function isGuiHelperTerminal(state: GuiHelperState): boolean {
  return GUI_HELPER_TERMINAL_STATES.includes(state)
}

// ————— tetos —————

/** Briefing de ajudante é recorte de trabalho, não anexo: acima disto RECUSA.
 *  Truncar um briefing é pior que recusá-lo — o ajudante trabalharia sobre meia
 *  instrução sem ninguém saber qual metade sumiu. */
export const GUI_HELPER_PROMPT_MAX_CHARS = 64 * 1024

/**
 * Teto da ENTREGA guardada EM MEMÓRIA, aviso incluído (o corte nunca empurra o
 * aviso para fora). Ele não é mais o fim da linha: desde 2026-08-18 o texto
 * INTEIRO vai para o arquivo canônico do worktree (ver `deliver` nas deps), e
 * este teto passou a governar só a cópia que o motor carrega para responder na
 * hora.
 */
export const GUI_HELPER_RESULT_MAX_CHARS = 64 * 1024

export const GUI_HELPER_RESULT_TRUNCATION_NOTICE =
  '\n\n[synkora] entrega cortada no teto de 64KB — o texto inteiro está no arquivo da entrega. Abra o arquivo, nunca peça o texto de novo ao ajudante.'

/**
 * BACKSTOP ANTI-RUNAWAY — NUNCA UMA COTA.
 *
 * Ordem do dono (18/08): "não precisa ter um teto — ele quiser delegar vinte,
 * trinta, o problema é dele". Cem ajudantes VIVOS no mesmo chat está muito acima
 * de qualquer uso real; este número existe só para um bug em laço (delegação que
 * se chama sozinha) não derrubar a máquina — o mesmo papel do teto de 1000
 * agentes do Workflow. A recusa nomeia o cenário de bug, e nunca fala em quota.
 */
export const GUI_HELPER_RUNAWAY_BACKSTOP = 100

/**
 * Quantos ENCERRADOS um pane lembra. Tem de ser MAIOR que o backstop: se
 * coubessem menos encerrados do que ajudantes vivos, uma frota no teto perderia
 * o resultado dos primeiros antes de o delegador conseguir lê-los — o motor
 * comeria o próprio trabalho.
 */
export const GUI_HELPER_SETTLED_MEMORY = 2 * GUI_HELPER_RUNAWAY_BACKSTOP

/** Espera padrão do `helper_result` (o corte de 60s do claude é o limite duro
 *  do outro lado; 45s deixa margem para latência — sonda S3/D4). */
export const GUI_HELPER_WAIT_DEFAULT_SECONDS = 45

/** Teto do SERVIDOR. O codex desiste sem cancelar o HTTP (probe-codex-fence
 *  §B.3): quem espera precisa de relógio próprio, nunca do cliente. */
export const GUI_HELPER_WAIT_MAX_SECONDS = 240

/**
 * AVISO DE LONGA DURAÇÃO — NUNCA UMA MORTE (R19, 2026-08-19).
 *
 * Ordem do dono, com o caso na tela (o teto derrubou um ajudante de trabalho
 * real aos 30 min): "o subagente pode ficar o tempo que for, não tem sentido
 * derrubar depois de 30 minutos". O NÚMERO continua o mesmo; o VERBO mudou —
 * aos 30 min o motor AVISA, uma vez por vida, e o ajudante segue trabalhando.
 *
 * A régua da casa diz a mesma coisa mecanicamente: guarda dura só protege
 * autoridade/verificabilidade, e "deve ter travado" é JULGAMENTO — que vira
 * advisory auditado, com as saídas sancionadas intactas (■ do dono,
 * `helper_cancel`, fechar o app).
 */
export const GUI_HELPER_LONGRUN_NOTICE_MS = 30 * 60 * 1000

/**
 * O TEXTO DO ADVISORY, e ele NOMEIA AS SAÍDAS. Um aviso que só diz "está
 * demorando" empurra quem lê a inventar uma saída (matar o processo por fora,
 * abrir outro ajudante por cima); dizendo os dois verbos, a decisão continua
 * sendo do dono e do delegador, que é de quem ela é. Os minutos saem do próprio
 * teto — prosa com número fixo mente no dia em que alguém mexe na constante.
 */
export const GUI_HELPER_LONGRUN_ADVISORY =
  `ajudante passou de ${Math.round(GUI_HELPER_LONGRUN_NOTICE_MS / 60_000)} min e SEGUE VIVO — ` +
  'trabalhar muito não é falha, e o motor nunca derruba por relógio. Quem decide parar é o dono ' +
  'ou o delegador: o ■ interrompe PRESERVANDO (helper_resume retoma de onde parou) e o ' +
  'helper_cancel DESCARTA (registro e entrega vão fora).'

/** A lateral mostra o RESUMO da última ferramenta; anunciar cada linha viraria
 *  enxurrada de card sintetizado no anel do delegador. */
export const GUI_HELPER_ACTIVITY_THROTTLE_MS = 2_000

/**
 * ESCALONADOR DE PARTIDA — spec LITERAL do dono (R6.4): "abre um, espera dois
 * segundos, abre o outro".
 *
 * O caso real: cinco ajudantes disparados no mesmo instante tomaram 529 do
 * provedor, e a re-tentativa manual do agente numa conta alternativa tomou 529 de
 * novo. Rajada é a causa; espaçar é o remédio. Precedente da casa: o escalonador
 * de panes da F6.10 (~350ms) matou a mesma classe.
 *
 * O que escalona é a PARTIDA DO PROCESSO — o recibo do `delegate` continua
 * voltando na hora para a frota inteira, e quem ainda não partiu aparece na ficha
 * como `spawning`.
 */
export const GUI_HELPER_SPAWN_INTERVAL_MS = 2_000

/** Respiro antes da única re-tentativa automática (R6.4). Curto o bastante para
 *  o dono não achar que travou, longo o bastante para a sobrecarga passar. */
export const GUI_HELPER_RETRY_DELAY_MS = 20_000

/**
 * Janela em que uma queda ainda conta como falha DE PARTIDA. Passado isto — ou
 * havendo qualquer trabalho já feito — a re-tentativa está proibida: o motor não
 * sabe desfazer o que o ajudante escreveu no worktree, e recomeçar por cima é
 * pior que a falha honesta.
 */
export const GUI_HELPER_RETRY_STARTUP_WINDOW_MS = 60_000

/** Registro assentado mais velho que isto não volta do disco: é história, e a
 *  entrega dele já mora no arquivo canônico do worktree. */
export const GUI_HELPER_STORE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Gravações de rotina (nascimento, 1º sinal de vida, sessionId) se juntam nesta
 *  janela. O DESFECHO nunca espera — ele é descarregado na hora. */
export const GUI_HELPER_PERSIST_DEBOUNCE_MS = 250

// ————— o contrato do adaptador (o mínimo que um CLI precisa prometer) —————

/**
 * O que o motor consome de uma sessão. É um SUBCONJUNTO do `SessionEvent` dos
 * dois motores, traduzido pela costura da onda 2 — de propósito: quanto menos o
 * motor souber do protocolo, menos ele quebra quando um CLI atualiza.
 */
export type GuiHelperEvent =
  /** Pedaço do texto do agente; o motor acumula. */
  | { type: 'text'; text: string }
  /** Resumo curto do que ele está fazendo agora (nome de ferramenta, arquivo). */
  | { type: 'activity'; summary: string }
  /**
   * A conversa deste ajudante ganhou endereço no disco do CLI (claude: session
   * id; codex: `codex-thread:<uuid>`). É o que torna a interrupção RETOMÁVEL —
   * guardado CRU, porque quem traduz para cada binário é o adaptador.
   */
  | { type: 'session'; sessionId: string }
  /** Contexto vivo medido pelo CLI; `null` = o backend não informou. */
  | { type: 'context'; contextTokens: number | null }
  /** Fim do turno. `text` ausente = usa o acumulado. */
  | { type: 'result'; isError: boolean; text?: string; errorText?: string }
  /** Queda do próprio canal (binário sumiu, protocolo quebrou). */
  | { type: 'fatal'; text: string }
  /** O processo morreu. NO CLAUDE ISSO É O DESFECHO NORMAL (sonda §2.6). */
  | { type: 'closed'; code?: number | null }

export interface GuiHelperProcess {
  /** Steering no ajudante vivo — os dois motores aceitam mensagem em turno. */
  send(text: string): void
  /** Encerra o processo. TEM de ser idempotente: o motor descarta em todo
   *  desfecho, e o claude pode já ter morrido sozinho antes. */
  dispose(): void
}

/** A conta que vai rodar o ajudante, já resolvida por quem conhece o SeatStore. */
export interface GuiHelperSeat {
  seatId: string
  /** CLAUDE_CONFIG_DIR / CODEX_HOME — o isolamento da conta. */
  configDir: string
  name?: string
}

/**
 * Tudo que o adaptador recebe para nascer. NENHUM campo de ferramenta, e isso é
 * cerca, não esquecimento (ver SEM CADEIA no cabeçalho).
 */
export interface GuiHelperSpawnRequest {
  helperId: string
  projectId: string
  /** Pane dono deste ajudante — o ciclo de vida é amarrado a ele. */
  delegatorPaneId: string
  /** Worktree da missão: o ajudante trabalha ao lado do dev, no mesmo lugar. */
  cwd: string
  cli: GuiHelperCli
  /** R11 — fast pinado no nascimento (claude: fastMode; codex: tier). */
  fast?: boolean
  model: string
  /** Já passou pela régua do `helperEffortDecision`: ausente = não mandar flag. */
  effort?: string
  seat: GuiHelperSeat
  prompt: string
  /** Modo de permissão do delegador — o ajudante herda a mão do dono. */
  permissionMode?: string
  /**
   * RETOMAR A MESMA CONVERSA (R6.2), no id CRU do registro: o adaptador do
   * claude o passa ao `--resume`, o do codex tira o prefixo `codex-thread:` e
   * abre por `thread/resume`.
   *
   * O motor ainda não preenche este campo — o verbo `helper_resume` é da onda
   * R6-B. Ele nasce aqui porque o CONTRATO do adaptador é desta camada: a onda
   * seguinte carimba o valor, sem reabrir a costura dos dois CLIs.
   */
  resumeSessionId?: string
}

export type GuiHelperSpawnAdapter = (
  request: GuiHelperSpawnRequest,
  emit: (event: GuiHelperEvent) => void
) => GuiHelperProcess

// ————— o registro —————

export interface GuiHelperActivity {
  at: number
  summary: string
}

export interface GuiHelperRecord {
  helperId: string
  delegatorPaneId: string
  projectId: string
  /** Apelido dado pelo delegador — é o rótulo do card na lateral. */
  name?: string
  /** Worktree onde o ajudante trabalhou (o MESMO do delegador). Mora no
   *  registro porque é onde a ENTREGA EM ARQUIVO pousa: quem escreve o arquivo
   *  recebe o registro, não o pedido de spawn, que já morreu no nascimento. */
  cwd: string
  cli: GuiHelperCli
  model: string
  /** O que a UI pode carimbar HONESTAMENTE (ausente = o CLI não recebeu nível). */
  effort?: string
  seatId: string
  seatName?: string
  prompt: string
  /**
   * A MÃO QUE O DELEGADOR TINHA no nascimento. Persistido porque o resume (R6.2)
   * reconstrói o pedido do REGISTRO: sem ele, um ajudante nascido num chat de
   * bypass renasceria em modo `default` e morreria no primeiro pedido de
   * permissão — beco, porque sessão headless não tem ninguém para responder.
   */
  permissionMode?: string
  /** R11 — nasceu em modo FAST (pinado; nunca toggla em vida). O resume reusa. */
  fast?: boolean
  state: GuiHelperState
  startedAt: number
  settledAt?: number
  lastActivity?: GuiHelperActivity
  contextTokens?: number
  /** Presente só em `done` — já cortado no teto. */
  result?: string
  resultTruncated?: boolean
  /** ARQUIVO canônico da entrega, relativo ao worktree — o endereço que o
   *  delegador abre. Ausente = o disco recusou (ver `deliveryError`). */
  resultPath?: string
  /** Por que a entrega não virou arquivo. Silêncio aqui faria o delegador
   *  procurar um arquivo que nunca existiu. */
  deliveryError?: string
  /** Motivo de `failed`/`interrupted`/`cancelled`, na voz de quem encerrou. */
  failure?: string
  /**
   * A CONVERSA deste ajudante no disco do CLI (claude: session id; codex:
   * `codex-thread:<uuid>`). É o que faz `interrupted` ser retomável — sem ele o
   * ajudante interrompido só pode recomeçar do zero.
   */
  sessionId?: string
  /** Quando o motor re-tentou sozinho (R6.4). Presente = a cota de UMA
   *  re-tentativa já foi gasta; nunca há uma segunda. */
  retriedAt?: number
  /** Em PT-BR e curto, para a ficha do dono: "sobrecarga do provedor". */
  retryReason?: string
  /**
   * Quando o delegador o RETOMOU (R6.2). Presente = este ajudante está na
   * segunda vida: o `startedAt` re-arma no instante da volta (o cronômetro do
   * dono conta o trabalho, não o tempo em que ele esteve parado) e este campo é
   * o que impede a ficha de mentir que ele nasceu agora.
   */
  resumedAt?: number
  /**
   * Quando o AVISO de longa duração saiu (R19). Presente = já avisado — é este
   * carimbo que faz o advisory sair UMA vez por vida em vez de a cada varredura
   * (e a varredura roda no começo de toda operação pública). O `helper_resume` o
   * apaga junto com o `startedAt`: a segunda vida re-arma o aviso, porque o
   * processo é outro e o cronômetro conta do zero.
   */
  longRunNoticedAt?: number
}

// ————— o disco (R6.1) —————

export const GUI_HELPER_STORE_VERSION = 1

/** A fotografia inteira, como ela pousa em `userData/gui-helpers.json`. */
export interface GuiHelperStoreDoc {
  version: number
  helpers: GuiHelperRecord[]
}

/**
 * O DISCO, INJETADO. O motor decide O QUE e QUANDO gravar; onde e como é da
 * costura com o main (`createGuiHelperStore`, sobre o `jsonStore` atômico da
 * casa). Ausente = nada persiste — é assim que as suítes rodam sem tocar disco,
 * e é a mesma disciplina do `deliver`.
 */
export interface GuiHelperStore {
  load(): GuiHelperRecord[]
  save(records: readonly GuiHelperRecord[]): void
}

export function isGuiHelperStoreDoc(value: unknown): value is GuiHelperStoreDoc {
  if (typeof value !== 'object' || value === null) return false
  const doc = value as { helpers?: unknown }
  return Array.isArray(doc.helpers)
}

/**
 * O QUE VAI AO DISCO: tudo, MENOS a entrega inline.
 *
 * O texto já está no arquivo canônico do worktree (`resultPath`) — guardá-lo de
 * novo faria uma frota de cem ajudantes reescrever megabytes a cada mudança de
 * estado, e o `helper_result` pós-boot passa a ENDEREÇAR o arquivo em vez de
 * fingir que tem a entrega em mãos. É a mesma regra do design: o arquivo é a
 * entrega.
 */
export function persistableGuiHelperRecord(record: GuiHelperRecord): GuiHelperRecord {
  const { result: _result, ...rest } = record
  return rest
}

const GUI_HELPER_STATES: readonly string[] = [
  'spawning',
  'working',
  'done',
  'failed',
  'interrupted',
  'cancelled'
]

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * O arquivo é do DISCO DO DONO: ele pode estar truncado por uma queda, editado à
 * mão ou vindo de uma versão anterior do app. Registro que não passa nesta régua
 * é DESCARTADO — um motor que morre no boot por causa de uma linha estragada
 * levaria junto a frota inteira que ele existe para recuperar.
 */
export function sanitizeGuiHelperRecord(value: unknown): GuiHelperRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const helperId = optionalString(raw['helperId'])
  const delegatorPaneId = optionalString(raw['delegatorPaneId'])
  const projectId = optionalString(raw['projectId'])
  const cwd = optionalString(raw['cwd'])
  const cli = raw['cli']
  const model = optionalString(raw['model'])
  const seatId = optionalString(raw['seatId'])
  const state = raw['state']
  const startedAt = optionalNumber(raw['startedAt'])
  if (!helperId || !delegatorPaneId || !projectId || !cwd || !model || !seatId) return undefined
  if (cli !== 'claude' && cli !== 'codex') return undefined
  if (typeof state !== 'string' || !GUI_HELPER_STATES.includes(state)) return undefined
  if (typeof raw['prompt'] !== 'string' || startedAt === undefined) return undefined
  const activity = raw['lastActivity']
  const lastActivity =
    typeof activity === 'object' && activity !== null
      ? (() => {
          const entry = activity as Record<string, unknown>
          const at = optionalNumber(entry['at'])
          const summary = optionalString(entry['summary'])
          return at !== undefined && summary ? { at, summary } : undefined
        })()
      : undefined
  const name = optionalString(raw['name'])
  const seatName = optionalString(raw['seatName'])
  const effort = optionalString(raw['effort'])
  const settledAt = optionalNumber(raw['settledAt'])
  const contextTokens = optionalNumber(raw['contextTokens'])
  const resultPath = optionalString(raw['resultPath'])
  const deliveryError = optionalString(raw['deliveryError'])
  const failure = optionalString(raw['failure'])
  const sessionId = optionalString(raw['sessionId'])
  const retriedAt = optionalNumber(raw['retriedAt'])
  const retryReason = optionalString(raw['retryReason'])
  const permissionMode = optionalString(raw['permissionMode'])
  const fast = raw['fast'] === true
  const resumedAt = optionalNumber(raw['resumedAt'])
  // Esta régua é ALVEJADA (só o que está escrito aqui volta do disco): campo que
  // ninguém reconstrói some em silêncio no round-trip. O carimbo do advisory
  // (R19) volta de propósito — ele é história honesta do ajudante, e sumir na
  // travessia faria a ficha de um encerrado mentir que nunca passou dos 30 min.
  const longRunNoticedAt = optionalNumber(raw['longRunNoticedAt'])
  return {
    helperId,
    delegatorPaneId,
    projectId,
    ...(name ? { name } : {}),
    cwd,
    cli,
    model,
    ...(effort ? { effort } : {}),
    seatId,
    ...(seatName ? { seatName } : {}),
    prompt: raw['prompt'],
    ...(permissionMode ? { permissionMode } : {}),
    ...(fast ? { fast: true } : {}),
    state: state as GuiHelperState,
    startedAt,
    ...(settledAt !== undefined ? { settledAt } : {}),
    ...(lastActivity ? { lastActivity } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(raw['resultTruncated'] === true ? { resultTruncated: true } : {}),
    ...(resultPath ? { resultPath } : {}),
    ...(deliveryError ? { deliveryError } : {}),
    ...(failure ? { failure } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(retriedAt !== undefined ? { retriedAt } : {}),
    ...(retryReason ? { retryReason } : {}),
    ...(resumedAt !== undefined ? { resumedAt } : {}),
    ...(longRunNoticedAt !== undefined ? { longRunNoticedAt } : {})
  }
}

/**
 * O QUE VAI PARA O DISCO no desfecho — o texto INTEIRO, antes do teto de 64KB.
 *
 * Ordem do dono (2026-08-18, 5º teste ao vivo): "todo ajudante sempre entrega em
 * modelo de ARQUIVO". A persona pede isso ao ajudante (cinto), mas persona não é
 * mecanismo: um ajudante que despeje 200KB no texto final continuaria custando o
 * contexto do delegador. Este é o suspensório — o harness grava SEMPRE, e o que
 * viaja inline vira um começo com o caminho na frente.
 */
export interface GuiHelperDelivery {
  /** Fotografia do registro JÁ encerrado (state/settledAt/failure preenchidos). */
  record: GuiHelperRecord
  /** Entrega inteira, sem teto: o arquivo é onde nada se perde. */
  text: string
}

export type GuiHelperDeliveryOutcome =
  | { ok: true; path: string }
  | { ok: false; error: string }

/**
 * A fotografia do `helpers_status`: estado, decorrido, última atividade e
 * contexto. SEM o texto da entrega — cem ajudantes × 64KB numa chamada de
 * status seria a resposta mais cara do catálogo, e para ler a entrega existe o
 * `helper_result`.
 */
export interface GuiHelperSnapshot {
  helperId: string
  name?: string
  cli: GuiHelperCli
  model: string
  effort?: string
  seatId: string
  seatName?: string
  state: GuiHelperState
  startedAt: number
  elapsedMs: number
  settledAt?: number
  lastActivity?: GuiHelperActivity
  contextTokens?: number
  hasResult: boolean
  /** O arquivo da entrega — a fotografia diz ONDE ler, nunca O QUE foi escrito. */
  resultPath?: string
  failure?: string
  /** Re-tentativa automática já gasta (R6.4): com `spawning`, é o respiro em
   *  curso; depois, a marca honesta de que este ajudante nasceu duas vezes. */
  retriedAt?: number
  retryReason?: string
  /** Retomado pelo delegador (R6.2): o decorrido conta da VOLTA, e é este campo
   *  que explica por que ele é curto num ajudante que já trabalhou meia hora. */
  resumedAt?: number
}

// ————— o pedido —————

/** O chat que delega: o ajudante o CLONA quando o pedido não diz o contrário. */
export interface GuiHelperDelegator {
  paneId: string
  projectId: string
  cwd: string
  cli: GuiHelperCli
  model: string
  effort?: string
  seatId: string
  permissionMode?: string
}

export interface GuiHelperRequest {
  prompt: string
  /** Ausente = o modelo do delegador. É ele que decide o CLI (ver resolveHelperCli). */
  model?: string
  effort?: string
  /** R11 — modo FAST, pinado no NASCIMENTO (a lição do prompt-cache: togglar
   *  fast quebra o cache; ajudante nasce e morre num modo só). Nunca herdado:
   *  ausente = off. */
  fast?: boolean
  /** Conta pedida explicitamente — o delegador escolhe onde gastar limite. */
  seatId?: string
  name?: string
}

export type GuiHelperReceipt =
  | {
      ok: true
      helperId: string
      name?: string
      cli: GuiHelperCli
      model: string
      effort?: string
      /** Por que o effort pedido não chegou ao CLI — silêncio aqui seria mentira. */
      effortDropped?: string
      seatId: string
      seatName?: string
    }
  | { ok: false; name?: string; error: string }

export interface GuiHelperSpawnOutcome {
  receipts: GuiHelperReceipt[]
  /** Aviso de custo da frota (ver `fleetEffortWarning`). */
  warning?: string
}

export type GuiHelperCommandResult = { ok: true } | { ok: false; error: string }

/**
 * O ✕ DA FROTA — o desfecho do gesto do DONO (R27F3, mockup rightdock-2).
 *
 * Duas maneiras de dar certo, e a diferença importa para quem chamou: `discarded`
 * = o motor acabou de jogar fora (registro + entrega); `gone` = já não havia nada
 * para jogar fora — ficha fantasma de um ajudante que o motor não conhece mais
 * (app reiniciado, registro envelhecido, descarte que já tinha acontecido).
 *
 * As duas autorizam a lateral a tirar a linha da tela; só a primeira apagou
 * alguma coisa. Um `ok:false` seria um beco sem saída para a segunda — o dono
 * ficaria com uma ficha que ele não tem como remover.
 */
export type GuiHelperOwnerDismissResult =
  | { ok: true; state: 'discarded' | 'gone' }
  | { ok: false; error: string }

export interface GuiHelperResultView {
  helperId: string
  state: GuiHelperState
  /** `true` = ainda trabalhando; o delegador re-chama. */
  pending: boolean
  waitedMs: number
  result?: string
  truncated?: boolean
  /** Onde a entrega INTEIRA está — é o que a resposta cita primeiro. */
  resultPath?: string
  /** Disco recusou: a resposta degrada para o texto inline COM o motivo. */
  deliveryError?: string
  failure?: string
  settledAt?: number
  snapshot: GuiHelperSnapshot
}

export type GuiHelperResultOutcome =
  | ({ ok: true } & GuiHelperResultView)
  | { ok: false; error: string }

// ————— observação (a lateral e o diário) —————

/**
 * `resumed` (R6.2) é o nascimento de uma SEGUNDA VIDA: o card do interrompido já
 * fechou na lateral, e no renderer um card fechado nunca mais aceita resultado.
 * Sem este aviso próprio, o ajudante que voltou entregaria no vazio.
 */
export type GuiHelperChangeKind = 'spawned' | 'activity' | 'settled' | 'resumed'

export interface GuiHelperChange {
  kind: GuiHelperChangeKind
  record: GuiHelperRecord
}

export type GuiHelperLogEvent =
  | 'helper-spawned'
  | 'helper-refused'
  | 'helper-settled'
  /**
   * ADVISORY AUDITADO (R19): o ajudante passou dos 30 min e SEGUE VIVO. Não é
   * desfecho, não é queda e não precede nenhuma morte — o motor não derruba por
   * relógio. Sai UMA vez por vida do ajudante, com o decorrido e as saídas
   * sancionadas no texto.
   */
  | 'helper-longrun'
  | 'helper-fleet-effort'
  /** Uma re-tentativa automática de falha passageira (R6.4). */
  | 'helper-retry'
  /** O delegador retomou um interrompido (R6.2) — a mesma conversa, de volta. */
  | 'helper-resumed'
  /** DESCARTE explícito: o registro encerra e a entrega sai do disco (R6.2). */
  | 'helper-discarded'
  /** O boot reencontrou um ajudante vivo da sessão anterior e o marcou como
   *  interrompido — o rastro de que o app fechou por cima de trabalho. */
  | 'helper-restored'
  /**
   * R22.2 — O RECIBO DA CARONA: a mensagem do dono saiu do pote e foi anexada a
   * um resultado de tool da delegação. É o carimbo de ENTREGA (paneId, quantas
   * mensagens e o tamanho que viajou); sem ele, "o app entregou?" seria uma
   * pergunta sem resposta mecânica — exatamente o buraco do print de 19/08.
   */
  | 'owner-mail-ride'
  /**
   * R32 — A COBRANÇA DA DÍVIDA DE RESPOSTA: uma tool de delegação foi RECUSADA
   * porque a fala do dono entregue pela carona seguia sem resposta (o caso do
   * transcript de 23/08: o modelo leu "FALE COM ELE JÁ" e voltou ao long-poll
   * mudo, duas vezes). O carimbo distingue "o agente falou por vontade" de
   * "falou porque a casa cobrou".
   */
  | 'owner-reply-enforced'

export interface GuiHelperLogEntry {
  event: GuiHelperLogEvent
  paneId: string
  helperId?: string
  detail?: Record<string, unknown>
}

export interface GuiHelperSeatQuery {
  cli: GuiHelperCli
  /** Ausente = a primeira conta LOGADA daquele CLI (caso cross-CLI). */
  preferredSeatId?: string
}

export interface GuiHelperCatalogQuery {
  cli: GuiHelperCli
  model: string
}

export interface GuiHelperEngineDeps {
  spawnClaude: GuiHelperSpawnAdapter
  spawnCodex: GuiHelperSpawnAdapter
  /**
   * GRAVA A ENTREGA EM ARQUIVO no desfecho (`done`/`failed`). Injetado porque o
   * motor não conhece disco — quem sabe escrever é a costura com o main.
   *
   * É SÍNCRONO por contrato: o caminho tem de estar no registro ANTES de os
   * long-polls acordarem e antes de o card `settled` sair, senão o delegador
   * receberia a entrega citando um arquivo que ainda não existe. Ausente = o
   * motor segue como antes, só com a cópia em memória (é assim que a suíte do
   * motor roda sem tocar em disco).
   */
  deliver?(delivery: GuiHelperDelivery): GuiHelperDeliveryOutcome
  /**
   * APAGA a entrega canônica — o outro lado do `deliver`, e a metade mecânica do
   * DESCARTE (R6.2: "helper_cancel apaga o arquivo de entrega").
   *
   * Injetado pelo mesmo motivo: o motor decide QUANDO jogar fora, o wiring sabe
   * ONDE. Falhar aqui nunca derruba o descarte — um arquivo que resistiu é lixo
   * no worktree, e um registro que não encerra é um card preso para sempre.
   * Ausente = o motor só esquece o caminho (é como as suítes rodam).
   */
  discardDelivery?(record: GuiHelperRecord): void
  /**
   * O DISCO (R6.1). Ausente = nada persiste e o boot não reencontra nada — é
   * como as suítes do motor rodam. Presente, ele é lido UMA vez no nascimento
   * (marcando como `interrupted` quem estava vivo) e reescrito a cada mudança
   * que importa.
   */
  store?: GuiHelperStore
  /** `undefined` = não há conta logada daquele CLI: o motor RECUSA em vez de
   *  abrir na conta errada. */
  resolveSeat(query: GuiHelperSeatQuery): GuiHelperSeat | undefined
  /** Catálogo real do CLI. `undefined` = catálogo não carregado (ver
   *  `helperEffortDecision`: ausência NÃO é "não suporta"). */
  modelSupportsEffort?(query: GuiHelperCatalogQuery): boolean | undefined
  now?(): number
  newId?(): string
  /** Injetável para o teste do long-poll ser determinístico. */
  setTimer?(ms: number, fn: () => void): () => void
  /** Cadência da fila de partida. `0` desliga o escalonamento (a bancada do
   *  motor usa isso para falar da máquina de estados sem ruído de relógio). */
  spawnIntervalMs?: number
  /** Respiro da re-tentativa automática. */
  retryDelayMs?: number
  onChange?(change: GuiHelperChange): void
  log?(entry: GuiHelperLogEntry): void
}

// ————— funções puras (as reguas que o wiring também usa) —————

/**
 * MODELO → CLI. `gpt-*` é codex; alias/id claude e qualquer outra coisa é
 * claude. É o que torna cross-CLI cidadão de primeira classe: um chat claude
 * pedindo `gpt-5.6-sol` abre um helper codex sem nenhuma cerimônia.
 *
 * O palpite nunca é silencioso — o recibo carimba `cli`, então uma resolução
 * errada aparece no primeiro uso em vez de virar mistério.
 */
export function resolveHelperCli(model: string): GuiHelperCli {
  return /^gpt-/i.test(model.trim()) ? 'codex' : 'claude'
}

/**
 * O teto da espera é do MOTOR. `undefined` = o padrão; número = grampeado em
 * [0, 240]. Nunca confiar no cancelamento do cliente: o codex abandona a espera
 * e deixa o servidor segurando a requisição (probe-codex-fence §B.3).
 */
export function clampHelperWaitSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return GUI_HELPER_WAIT_DEFAULT_SECONDS
  return Math.min(Math.max(Math.floor(value), 0), GUI_HELPER_WAIT_MAX_SECONDS)
}

/**
 * Corta a entrega no teto COM aviso — e o aviso cabe DENTRO do teto, senão quem
 * recortasse em 64KB do outro lado comeria justamente a linha que explica o
 * corte.
 */
export function capGuiHelperResult(text: string): { text: string; truncated: boolean } {
  if (text.length <= GUI_HELPER_RESULT_MAX_CHARS) return { text, truncated: false }
  const room = GUI_HELPER_RESULT_MAX_CHARS - GUI_HELPER_RESULT_TRUNCATION_NOTICE.length
  return { text: text.slice(0, room) + GUI_HELPER_RESULT_TRUNCATION_NOTICE, truncated: true }
}

export interface GuiHelperEffortInput {
  cli: GuiHelperCli
  delegatorCli: GuiHelperCli
  model: string
  /** Pedido EXPLÍCITO do delegador — vence tudo. */
  requested?: string
  delegatorEffort?: string
  /** Do catálogo do CLI; `undefined` = catálogo ainda não carregado. */
  supportsEffort?: boolean
}

export interface GuiHelperEffortDecision {
  /** O que vai ao CLI; ausente = nenhuma flag. */
  send?: string
  /** O que a UI pode carimbar; ausente = "não informado". */
  applied?: string
  /** Por que caiu. Queda de effort NUNCA é silenciosa. */
  dropped?: string
}

/**
 * O EFFORT DO AJUDANTE, com as duas armadilhas medidas.
 *
 * 1. Pedido explícito manda, sempre. Sem pedido, o ajudante CLONA o delegador
 *    (regra F6: ajudante clona o dev, salvo ordem em contrário) — mas SÓ dentro
 *    do mesmo CLI. As escalas são diferentes (claude vai até `max`; o codex
 *    trabalha com minimal/low/medium/high), então herdar entre binários manda um
 *    nível que o outro lado não conhece. Cross-CLI sem pedido = padrão da conta,
 *    com o motivo registrado.
 * 2. Modelo que o catálogo declara SEM effort não recebe o flag: o claude engole
 *    `--effort` sem aviso nenhum (sonda 2026-08-18 §2.4) e a lateral exibiria
 *    "haiku · low" como se o nível tivesse efeito. Catálogo AUSENTE não é "não
 *    suporta" — derrubar o effort de toda frota claude por catálogo não
 *    carregado seria um estrago maior que um rótulo otimista.
 */
export function helperEffortDecision(input: GuiHelperEffortInput): GuiHelperEffortDecision {
  const requested = cleanEffort(input.requested)
  const inherited = cleanEffort(input.delegatorEffort)
  if (!requested && inherited && input.cli !== input.delegatorCli) {
    return {
      dropped: `o effort "${inherited}" do delegador não viaja para o ${input.cli}: cada CLI tem a própria escala — o ajudante roda no padrão da conta`
    }
  }
  const candidate = requested ?? inherited
  if (!candidate) return {}
  if (input.supportsEffort === false) {
    return {
      dropped: `o modelo ${input.model} não aceita effort no catálogo do ${input.cli}: mandar o flag não quebra, mas carimbar "${input.model} · ${candidate}" na lateral seria mentira`
    }
  }
  return { send: candidate, applied: candidate }
}

/**
 * AVISO DE CUSTO DA FROTA (sonda §2.3, medida direta): no claude o effort entra
 * na CHAVE DO PROMPT-CACHE. Dois helpers do MESMO modelo com efforts diferentes
 * não compartilham cache, e o segundo paga cache-creation cheia — 3,7× o custo
 * no experimento controlado.
 *
 * O alarme é ESTREITO de propósito: só dentro de um mesmo modelo claude, porque
 * modelos diferentes nunca compartilhariam cache e avisar ali seria ruído. E a
 * equivalência `default ≡ low` observada no `claude-sonnet-5` NÃO foi codificada:
 * um modelo, um build — generalizá-la seria over-fitting da sonda.
 */
export function fleetEffortWarning(
  helpers: readonly { cli: GuiHelperCli; model: string; effort?: string }[]
): string | undefined {
  const byModel = new Map<string, Set<string>>()
  for (const helper of helpers) {
    if (helper.cli !== 'claude') continue
    const bucket = byModel.get(helper.model) ?? new Set<string>()
    bucket.add(cleanEffort(helper.effort) ?? 'padrão')
    byModel.set(helper.model, bucket)
  }
  const mixed: string[] = []
  for (const [model, efforts] of byModel) {
    if (efforts.size < 2) continue
    mixed.push(`${model}: ${[...efforts].join(', ')}`)
  }
  if (mixed.length === 0) return undefined
  return (
    `frota claude com efforts diferentes no MESMO modelo (${mixed.join('; ')}) — ` +
    'cada variação paga cache de prompt cheio (medido em 2026-08-18: 3,7× o mesmo pedido). ' +
    'Effort uniforme por modelo sai materialmente mais barato.'
  )
}

/**
 * FALHA PASSAGEIRA — a régua da re-tentativa automática (R6.4), deliberadamente
 * ESTREITA.
 *
 * O caso do dono (18/08): cinco ajudantes na mesma rajada, 529 do provedor, e a
 * re-tentativa manual do agente em outra conta tomou 529 também. Só entram aqui
 * assinaturas em que esperar RESOLVE — sobrecarga do lado de lá e limite de
 * requisições. Tudo o mais (conta sem crédito, binário fora do PATH, permissão,
 * processo que morreu sem falar) é definitivo: re-tentar seria queimar limite e
 * esconder o problema do dono por mais 20 segundos. A queda por TEMPO saiu desta
 * lista porque saiu do motor (R19): nenhum ajudante é derrubado por relógio, e a
 * assinatura antiga nunca mais nasce.
 *
 * As assinaturas são as do CLI, em inglês; os motivos que o PRÓPRIO motor
 * escreve são PT-BR e nunca casam aqui — o que é proposital, porque nenhum deles
 * é passageiro.
 */
const GUI_HELPER_TRANSIENT_SIGNATURES: readonly { re: RegExp; label: string }[] = [
  { re: /\b529\b/u, label: 'sobrecarga do provedor' },
  { re: /overloaded/iu, label: 'sobrecarga do provedor' },
  { re: /\b(?:503|502)\b/u, label: 'provedor indisponível' },
  { re: /\b429\b/u, label: 'limite de requisições' },
  { re: /rate[\s_-]?limit/iu, label: 'limite de requisições' },
  { re: /too many requests/iu, label: 'limite de requisições' }
]

/** O motivo curto, em PT-BR, quando a queda é passageira; `undefined` quando ela
 *  é definitiva. */
export function transientHelperFailure(text: string | undefined): string | undefined {
  if (typeof text !== 'string' || !text.trim()) return undefined
  for (const signature of GUI_HELPER_TRANSIENT_SIGNATURES) {
    if (signature.re.test(text)) return signature.label
  }
  return undefined
}

/** Texto opcional do pedido: string vazia é AUSÊNCIA, nunca valor. Sem isto um
 *  `model: ""` viraria modelo de verdade e o ajudante nasceria sem executor. */
function trimmedOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const cleanEffort = trimmedOrUndefined

// ————— o motor —————

interface LiveHelper {
  record: GuiHelperRecord
  process?: GuiHelperProcess
  /** O pedido EXATO com que este ajudante nasce — guardado porque a partida é
   *  ADIADA (fila do R6.4) e porque a re-tentativa o reusa inteiro (mesma conta,
   *  mesmo modelo, mesmo effort: o pino do nascimento vale). */
  spawnRequest?: GuiHelperSpawnRequest
  /** Texto acumulado dos eventos `text` — a entrega quando o `result` não a traz. */
  text: string
  /** Long-polls esperando o desfecho deste ajudante. */
  waiters: (() => void)[]
  activityNotifiedAt: number
  /** Ordem MONOTÔNICA de encerramento, e não o relógio: `settledAt` tem
   *  resolução de milissegundo, e uma frota inteira encerra no mesmo tick com
   *  facilidade. Empate no relógio faria a poda cair de volta na ordem de
   *  NASCIMENTO — que é exatamente o que ela não pode usar. */
  settledSeq?: number
}

/** O que o boot escreve em quem estava vivo quando o app fechou (R6.1: fechar o
 *  app é INTERRUPÇÃO, nunca descarte). */
export const GUI_HELPER_BOOT_INTERRUPTION =
  'o app fechou com o ajudante trabalhando — o processo morreu, mas a conversa dele ficou guardada e dá para retomar de onde parou'

export class GuiHelperEngine {
  private readonly deps: GuiHelperEngineDeps
  private readonly helpers = new Map<string, LiveHelper>()
  /** Índice por pane, em ORDEM DE CRIAÇÃO: é ele que dá a ordem estável da
   *  lateral (card que pula de lugar sozinho é o bug que a era dos panes já
   *  pagou) e a poda por pane. */
  private readonly byPane = new Map<string, string[]>()
  private readonly now: () => number
  private readonly newId: () => string
  private readonly setTimer: (ms: number, fn: () => void) => () => void
  private readonly spawnIntervalMs: number
  private readonly retryDelayMs: number
  private sweeping = false
  private settleCounter = 0
  /** FILA GLOBAL DE PARTIDA (R6.4): ids esperando a vez de virar processo. É
   *  global, e não por pane, porque quem se sobrecarrega é o PROVEDOR — dois
   *  chats delegando ao mesmo tempo fariam a mesma rajada. */
  private readonly spawnQueue: string[] = []
  private cancelSpawnTimer?: () => void
  private lastSpawnStartedAt = Number.NEGATIVE_INFINITY
  private cancelPersistTimer?: () => void
  /** Profundidade do encerramento em massa e se ele sujou a fotografia — juntos,
   *  transformam N gravações síncronas do mesmo arquivo em uma. */
  private bulkDepth = 0
  private bulkDirty = false

  constructor(deps: GuiHelperEngineDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? randomUUID
    this.setTimer =
      deps.setTimer ??
      ((ms, fn) => {
        const handle = setTimeout(fn, ms)
        // Ajudante pendurado nunca segura o encerramento do app.
        handle.unref?.()
        return () => clearTimeout(handle)
      })
    this.spawnIntervalMs = deps.spawnIntervalMs ?? GUI_HELPER_SPAWN_INTERVAL_MS
    this.retryDelayMs = deps.retryDelayMs ?? GUI_HELPER_RETRY_DELAY_MS
    this.restore()
  }

  /**
   * O BOOT (R6.1). Quem estava `spawning`/`working` na fotografia do disco vira
   * `interrupted` — o processo daquele boot não existe mais, mas o registro, o
   * `sessionId` e a entrega parcial ficam, e a conversa que reabrir pode retomar.
   *
   * Nada volta VIVO daqui: ressuscitar processo no boot seria abrir frota sem o
   * dono pedir. E a fotografia é re-gravada já marcada, para um segundo crash não
   * reencontrar o mesmo "vivo" de novo.
   */
  private restore(): void {
    const store = this.deps.store
    if (!store) return
    let raw: unknown[] = []
    try {
      raw = store.load() ?? []
    } catch {
      // Disco ilegível é frota vazia, nunca um app que não abre.
      return
    }
    if (!Array.isArray(raw)) return
    const now = this.now()
    const restored: GuiHelperRecord[] = []
    for (const entry of raw) {
      const record = sanitizeGuiHelperRecord(entry)
      if (!record) continue
      const interrupted = !isGuiHelperSettled(record.state)
      if (interrupted) {
        record.state = 'interrupted'
        record.settledAt = now
        record.failure = GUI_HELPER_BOOT_INTERRUPTION
      }
      // Retenção: o que já é história não volta — a entrega dele mora no arquivo
      // canônico do worktree, que ninguém apaga por passar de sete dias.
      if (now - (record.settledAt ?? record.startedAt) > GUI_HELPER_STORE_RETENTION_MS) continue
      restored.push(record)
      if (interrupted) {
        this.journal({
          event: 'helper-restored',
          paneId: record.delegatorPaneId,
          helperId: record.helperId,
          detail: { state: 'interrupted', model: record.model, cli: record.cli }
        })
      }
    }
    // A ordem de ENCERRAMENTO é o que a poda usa, e ela não sobrevive ao disco:
    // reconstruímos pelo relógio de assentamento, preservando a ordem de CRIAÇÃO
    // (a do arquivo) para a lateral.
    const bySettle = [...restored].sort(
      (a, b) => (a.settledAt ?? a.startedAt) - (b.settledAt ?? b.startedAt)
    )
    const seqOf = new Map(bySettle.map((record, index) => [record.helperId, index + 1]))
    this.settleCounter = bySettle.length
    for (const record of restored) {
      this.remember({
        record,
        text: '',
        waiters: [],
        activityNotifiedAt: 0,
        settledSeq: seqOf.get(record.helperId) ?? 0
      })
    }
    for (const paneId of this.byPane.keys()) this.prune(paneId)
    this.persistNow()
  }

  /** Registros conhecidos (vivos + os encerrados ainda lembrados). */
  get size(): number {
    return this.helpers.size
  }

  liveCount(paneId?: string): number {
    let count = 0
    for (const live of this.pick(paneId)) {
      if (!isGuiHelperSettled(live.record.state)) count += 1
    }
    return count
  }

  /**
   * Abre a frota. NUNCA bloqueia: devolve o recibo de cada item na hora — é o
   * que deixa a tool `delegate` responder e o chat seguir conversando enquanto
   * os ajudantes trabalham.
   */
  spawn(
    delegator: GuiHelperDelegator,
    requests: readonly GuiHelperRequest[]
  ): GuiHelperSpawnOutcome {
    this.sweep()
    const receipts: GuiHelperReceipt[] = []
    const fleet: { cli: GuiHelperCli; model: string; effort?: string }[] = []

    for (const request of requests) {
      const name = trimmedOrUndefined(request.name)
      const named = name ? { name } : {}
      const refuse = (error: string): void => {
        receipts.push({ ok: false, ...named, error })
        this.journal({
          event: 'helper-refused',
          paneId: delegator.paneId,
          detail: { error }
        })
      }

      const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : ''
      if (!prompt) {
        refuse('o pedido do ajudante veio vazio — descreva a fatia de trabalho dele')
        continue
      }
      if (prompt.length > GUI_HELPER_PROMPT_MAX_CHARS) {
        refuse(
          `o pedido tem ${prompt.length} caracteres e o teto é ${GUI_HELPER_PROMPT_MAX_CHARS} — ` +
            'ponha o material longo num arquivo do worktree e aponte o caminho'
        )
        continue
      }
      // BACKSTOP: recontado a cada item, então um lote grande demais é cortado
      // no ponto certo em vez de passar inteiro por ter começado abaixo do teto.
      if (this.liveCount(delegator.paneId) >= GUI_HELPER_RUNAWAY_BACKSTOP) {
        refuse(
          `trava de segurança: este chat já tem ${GUI_HELPER_RUNAWAY_BACKSTOP} ajudantes vivos ao mesmo tempo. ` +
            'Isso não é teto de delegação — é o piso de um laço de bug (delegação que se chama sozinha). ' +
            'Cancele os que ficaram (helper_cancel) ou espere encerrarem.'
        )
        continue
      }

      const model = trimmedOrUndefined(request.model) ?? delegator.model
      const cli = resolveHelperCli(model)
      const supportsEffort = this.deps.modelSupportsEffort?.({ cli, model })
      const effort = helperEffortDecision({
        cli,
        delegatorCli: delegator.cli,
        model,
        ...(request.effort ? { requested: request.effort } : {}),
        ...(delegator.effort ? { delegatorEffort: delegator.effort } : {}),
        ...(supportsEffort === undefined ? {} : { supportsEffort })
      })

      // Mesmo CLI ⇒ a conta do delegador; CLI cruzado ⇒ o resolvedor escolhe a
      // primeira LOGADA daquele binário (a conta do delegador é de outro CLI).
      const preferredSeatId =
        trimmedOrUndefined(request.seatId) ?? (cli === delegator.cli ? delegator.seatId : undefined)
      const seat = this.deps.resolveSeat({
        cli,
        ...(preferredSeatId ? { preferredSeatId } : {})
      })
      if (!seat) {
        refuse(
          `não há conta ${cli} logada para abrir este ajudante (o modelo pedido foi ${model}) — ` +
            `entre numa conta ${cli} ou peça um modelo do outro CLI`
        )
        continue
      }

      const helperId = this.newId()
      const record: GuiHelperRecord = {
        helperId,
        delegatorPaneId: delegator.paneId,
        projectId: delegator.projectId,
        ...named,
        cwd: delegator.cwd,
        cli,
        model,
        ...(effort.applied ? { effort: effort.applied } : {}),
        seatId: seat.seatId,
        ...(seat.name ? { seatName: seat.name } : {}),
        prompt,
        // O modo do delegador é PINO de nascimento: é ele que o resume reusa,
        // inclusive depois de um boot em que o chat nem esteja aberto.
        ...(delegator.permissionMode ? { permissionMode: delegator.permissionMode } : {}),
        // R11: fast NUNCA é herdado — só o pedido explícito (tool/painel) liga.
        ...(request.fast === true ? { fast: true } : {}),
        state: 'spawning',
        startedAt: this.now()
      }
      const live: LiveHelper = {
        record,
        spawnRequest: {
          helperId,
          projectId: delegator.projectId,
          delegatorPaneId: delegator.paneId,
          cwd: delegator.cwd,
          cli,
          model,
          ...(effort.send ? { effort: effort.send } : {}),
          seat,
          prompt,
          ...(request.fast === true ? { fast: true } : {}),
          ...(delegator.permissionMode ? { permissionMode: delegator.permissionMode } : {})
        },
        text: '',
        waiters: [],
        activityNotifiedAt: 0
      }
      this.remember(live)
      // O card nasce ANTES do processo: assim a ordem publicada é sempre
      // spawned → … → settled, inclusive quando o spawn morre no nascimento.
      this.notify({ kind: 'spawned', record: { ...record } })

      fleet.push({ cli, model, ...(effort.applied ? { effort: effort.applied } : {}) })
      this.journal({
        event: 'helper-spawned',
        paneId: delegator.paneId,
        helperId,
        detail: {
          cli,
          model,
          seatId: seat.seatId,
          ...(effort.applied ? { effort: effort.applied } : {}),
          ...(effort.dropped ? { effortDropped: effort.dropped } : {})
        }
      })

      // A PARTIDA ENTRA NA FILA (R6.4). O `pump` derruba o primeiro AQUI DENTRO
      // quando a fila estava vazia e o intervalo já venceu — e é só por isso que
      // uma queda de spawn ainda pode virar recibo recusado: o recibo recusa o
      // que se sabe NA HORA. Os seguintes partem depois, e a queda deles chega
      // pelo card e pelo correio, como qualquer outro desfecho.
      this.spawnQueue.push(helperId)
      this.pumpSpawnQueue()
      if (live.record.state === 'failed') {
        refuse(live.record.failure ?? 'o ajudante não subiu')
        continue
      }

      receipts.push({
        ok: true,
        helperId,
        ...named,
        cli,
        model,
        ...(effort.applied ? { effort: effort.applied } : {}),
        ...(effort.dropped ? { effortDropped: effort.dropped } : {}),
        seatId: seat.seatId,
        ...(seat.name ? { seatName: seat.name } : {})
      })
    }

    const warning = fleetEffortWarning(fleet)
    if (warning) {
      this.journal({
        event: 'helper-fleet-effort',
        paneId: delegator.paneId,
        detail: { warning }
      })
    }
    // Uma gravação para o LOTE inteiro: cem ajudantes num pedido não podem virar
    // cem reescritas do arquivo.
    this.persistSoon()
    return { receipts, ...(warning ? { warning } : {}) }
  }

  /** A fotografia do pane, em ordem de criação. */
  status(paneId: string): GuiHelperSnapshot[] {
    this.sweep()
    return this.pick(paneId).map((live) => this.snapshot(live))
  }

  /** Cópia do registro — o chamador nunca escreve no estado do motor. */
  get(helperId: string): GuiHelperRecord | undefined {
    this.sweep()
    const live = this.helpers.get(helperId)
    return live ? { ...live.record } : undefined
  }

  /**
   * LONG-POLL com teto do próprio motor. Resolve NA HORA em que o ajudante
   * encerra; estourado o teto, devolve "ainda trabalhando" com a fotografia — e
   * isso é resposta, nunca erro: o delegador re-chama.
   */
  async result(helperId: string, waitSeconds?: number): Promise<GuiHelperResultOutcome> {
    this.sweep()
    const live = this.helpers.get(helperId)
    if (!live) return { ok: false, error: helperNotFound(helperId) }

    const seconds = clampHelperWaitSeconds(waitSeconds)
    const pollStartedAt = this.now()
    if (!isGuiHelperSettled(live.record.state) && seconds > 0) {
      await new Promise<void>((resolve) => {
        let finished = false
        let cancelTimer: (() => void) | undefined
        const finish = (): void => {
          if (finished) return
          finished = true
          cancelTimer?.()
          const index = live.waiters.indexOf(waiter)
          if (index >= 0) live.waiters.splice(index, 1)
          resolve()
        }
        const waiter = (): void => finish()
        live.waiters.push(waiter)
        cancelTimer = this.setTimer(seconds * 1000, finish)
      })
      // A espera pode ter atravessado o AVISO de longa duração (R19): varrer
      // antes de responder deixa a auditoria em dia. O ESTADO não muda por
      // relógio aqui — quem entrou vivo nesta espera sai vivo dela, e é isso que
      // a resposta diz.
      this.sweep()
    }
    return { ok: true, ...this.view(live, this.now() - pollStartedAt) }
  }

  /**
   * O DESPERTAR POR PANE (R22.3) — o long-poll acorda porque o DONO falou.
   *
   * O `settle` já acorda os waiters do ajudante que encerrou; este é o outro
   * motivo legítimo de interromper a espera: chegou mensagem do dono no pote
   * (`guiOwnerMail`), e ela viaja de carona no PRÓXIMO resultado de tool. Sem
   * isto, um `helper_result` com 240s de espera seguraria a fala dele por até
   * quatro minutos — com a frota inteira andando no rumo errado.
   *
   * O que ele NÃO faz: mudar estado. Ninguém encerra, ninguém falha — o waiter
   * resolve e o `result` responde "ainda trabalhando" com a fotografia de
   * sempre; a novidade viaja no bloco que a costura anexa. Por isso também não
   * varre: o próprio `result` varre antes de responder.
   *
   * Devolve quantas ESPERAS foram acordadas (0 = ninguém estava esperando, que é
   * o caso comum e não é notícia).
   */
  wakePane(paneId: string): number {
    let woken = 0
    for (const live of this.pick(paneId)) {
      if (live.waiters.length === 0) continue
      woken += live.waiters.length
      for (const waiter of live.waiters.splice(0)) waiter()
    }
    return woken
  }

  /** Steering: dirige o ajudante VIVO, como se fosse um subagente nativo. */
  send(helperId: string, text: string): GuiHelperCommandResult {
    this.sweep()
    const live = this.helpers.get(helperId)
    if (!live) return { ok: false, error: helperNotFound(helperId) }
    if (isGuiHelperSettled(live.record.state)) {
      return { ok: false, error: alreadySettled(live.record.state) }
    }
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: 'a mensagem veio vazia — diga o que mudar' }
    }
    if (!live.process) return { ok: false, error: 'o ajudante ainda não tem processo vivo' }
    live.process.send(text)
    return { ok: true }
  }

  /**
   * RETOMAR (R6.2) — o verbo que fecha o ciclo redondo.
   *
   * A MESMA conversa volta, no MESMO executor: o pedido é reconstruído a partir
   * do REGISTRO, nunca de estado em memória. Não é economia — o registro que
   * volta do disco depois de um boot jamais terá um `spawnRequest`, e um resume
   * que dependesse dele funcionaria na sessão e quebraria exatamente no caso que
   * o dono pediu ("fechar o app e voltar os subagentes voltarem").
   *
   * O pino do nascimento vale: modelo, effort e modo de permissão são os de
   * origem, e a CONTA se re-resolve pelo `seatId` guardado (a de origem pode ter
   * saído do login desde então). Trocar executor não é retomar — é descartar e
   * abrir outro.
   */
  resume(helperId: string): GuiHelperCommandResult {
    this.sweep()
    const live = this.helpers.get(helperId)
    if (!live) return { ok: false, error: helperNotFound(helperId) }
    const record = live.record
    if (!isGuiHelperResumable(record.state)) {
      return { ok: false, error: notResumable(record.state) }
    }
    // SEM ENDEREÇO DA CONVERSA não há retomada: o nudge é curto porque a
    // conversa carrega o briefing, e sem ela ele chegaria a um ajudante em
    // branco — "continue de onde parou" sem nenhum "onde".
    const sessionId = trimmedOrUndefined(record.sessionId)
    if (!sessionId) return { ok: false, error: RESUME_WITHOUT_CONVERSATION }
    const seat = this.deps.resolveSeat({ cli: record.cli, preferredSeatId: record.seatId })
    if (!seat) {
      return {
        ok: false,
        error:
          `não há conta ${record.cli} logada para retomar este ajudante — ` +
          `entre na conta ${record.seatName ?? record.seatId} ou descarte-o e abra outro com delegate`
      }
    }

    const at = this.now()
    live.spawnRequest = {
      helperId,
      projectId: record.projectId,
      delegatorPaneId: record.delegatorPaneId,
      cwd: record.cwd,
      cli: record.cli,
      model: record.model,
      ...(record.effort ? { effort: record.effort } : {}),
      ...(record.fast === true ? { fast: true } : {}),
      seat,
      prompt: GUI_HELPER_RESUME_NUDGE,
      ...(record.permissionMode ? { permissionMode: record.permissionMode } : {}),
      resumeSessionId: sessionId
    }
    record.state = 'spawning'
    // O CRONÔMETRO RE-ARMA (R6.2): o dono conta o trabalho, não o tempo em que o
    // ajudante ficou parado. O `resumedAt` é o que impede a ficha de mentir que
    // ele nasceu agora, e o AVISO de longa duração (R19) volta a contar da volta
    // — que é o certo, porque o processo é outro: a segunda vida tem direito aos
    // seus trinta minutos antes de ser notada de novo.
    record.startedAt = at
    record.resumedAt = at
    delete record.longRunNoticedAt
    record.seatId = seat.seatId
    if (seat.name) record.seatName = seat.name
    else delete record.seatName
    delete record.settledAt
    delete record.failure
    // A entrega PARCIAL sai do registro: quem retomou vai entregar de novo, e o
    // arquivo canônico é reescrito no desfecho seguinte.
    delete record.result
    delete record.resultTruncated
    delete record.deliveryError
    record.lastActivity = { at, summary: 'retomado — continuando de onde parou' }
    live.settledSeq = undefined
    live.text = ''
    live.activityNotifiedAt = at
    // O PROCESSO MORTO SAI DE CENA. Ele ficou pendurado no registro desde a
    // interrupção (o `settle` descarta, mas não solta a referência), e a fila de
    // partida trata "já tem processo" como "não precisa nascer" — sem esta
    // linha o resume seria aceito e nenhum CLI subiria.
    live.process = undefined
    this.journal({
      event: 'helper-resumed',
      paneId: record.delegatorPaneId,
      helperId,
      detail: { cli: record.cli, model: record.model, seatId: seat.seatId, sessionId }
    })
    // O card da SEGUNDA VIDA nasce antes do processo, como no `spawn`: a ordem
    // publicada é sempre nascimento → … → desfecho.
    this.notify({ kind: 'resumed', record: { ...record } })
    this.persistSoon()
    // PELA FILA, como qualquer partida (R6.4): retomar cinco de uma vez é a
    // mesma rajada que o escalonador existe para espaçar.
    this.spawnQueue.push(helperId)
    this.pumpSpawnQueue()
    return { ok: true }
  }

  /**
   * DESCARTAR (R6.2). "Não quero mais nada": mata o processo se ele vive, apaga
   * a entrega canônica e encerra o registro de vez.
   *
   * O INTERROMPIDO entra aqui — e é o ponto do par de verbos: quem parou pode
   * voltar (`resume`) ou ser jogado fora, e só o segundo é irreversível. Quem
   * já ENCERROU não: descartar um `done` apagaria justamente o produto do
   * trabalho.
   *
   * Honestidade de escopo (R6.2): isto cobre o registro e a entrega canônica. O
   * que o ajudante escreveu no worktree COMPARTILHADO é do delegador desfazer
   * pelo git quando o dono pedir — atribuir arquivo a ajudante seria adivinhação.
   */
  cancel(helperId: string, reason?: string): GuiHelperCommandResult {
    this.sweep()
    const live = this.helpers.get(helperId)
    if (!live) return { ok: false, error: helperNotFound(helperId) }
    const state = live.record.state
    if (isGuiHelperResumable(state)) {
      this.discard(live, cancelReason(reason))
      return { ok: true }
    }
    if (isGuiHelperSettled(state)) return { ok: false, error: alreadySettled(state) }
    this.settle(live, 'cancelled', { failure: cancelReason(reason) })
    return { ok: true }
  }

  /**
   * O ✕ DA FROTA (R27F3) — ordem literal do dono, 2026-08-22: "quando o
   * subagente deu interrompido, eu quero algum X pra eu tirar dali, porque eu já
   * entendi". Até aqui só o AGENTE descartava (`helper_cancel` pelo MCP); este é
   * o canal MECÂNICO do dono para a mesma decisão.
   *
   * Ele NÃO é um segundo descarte: o trabalho é feito pelo `cancel` acima, o
   * mesmo do agente — o que muda é a CERCA, porque o gesto é outro. Um clique
   * numa ficha só pode jogar fora quem já parou:
   *
   * · TRABALHANDO não se descarta por aqui. O ✕ do dono nasce na ficha PARADA, e
   *   uma ficha viva na tela é sempre o botão errado — quem para a frota viva é o
   *   ■ da conversa, que interrompe PRESERVANDO. A recusa nomeia esse caminho;
   * · quem já ENTREGOU também não: apagar a entrega é apagar o produto do
   *   trabalho (a mesma régua do `cancel`, dita na voz do dono);
   * · ajudante que o motor NÃO CONHECE mais devolve `gone` em vez de erro. O
   *   card mora no anel da conversa e sobrevive ao processo: depois de um
   *   restart (ou de um descarte que já aconteceu) a ficha na tela é história, e
   *   recusá-la deixaria o dono preso a uma linha que ele não tem como tirar.
   */
  ownerDismiss(helperId: string): GuiHelperOwnerDismissResult {
    this.sweep()
    const live = this.helpers.get(helperId)
    if (!live) return { ok: true, state: 'gone' }
    const state = live.record.state
    // Já descartado é o MESMO destino que o dono está pedindo: idempotente.
    if (state === 'cancelled') return { ok: true, state: 'gone' }
    if (!isGuiHelperResumable(state)) return { ok: false, error: ownerDismissRefusal(state) }
    const outcome = this.cancel(helperId, GUI_HELPER_OWNER_DISMISS_REASON)
    return outcome.ok ? { ok: true, state: 'discarded' } : outcome
  }

  /** Dispose do pane delegador: os ajudantes dele morrem junto. Os REGISTROS
   *  ficam — a lateral continua mostrando o desfecho de cada card. */
  cancelPane(paneId: string, reason?: string): number {
    this.sweep()
    return this.bulk(() => {
      let count = 0
      for (const live of this.pick(paneId)) {
        if (isGuiHelperSettled(live.record.state)) continue
        this.settle(live, 'cancelled', { failure: cancelReason(reason) })
        count += 1
      }
      return count
    })
  }

  /** O pane sumiu de vez (chat fechado, projeto trocado): cancela E esquece.
   *  Sem isto a memória de encerrados de um pane morto ficaria para sempre. */
  forgetPane(paneId: string, reason?: string): number {
    const cancelled = this.cancelPane(paneId, reason)
    for (const helperId of this.byPane.get(paneId) ?? []) this.helpers.delete(helperId)
    this.byPane.delete(paneId)
    this.persistSoon()
    return cancelled
  }

  /**
   * O ■ DO DONO (R6.3): a frota do pane PARA PRESERVANDO. Processo morto,
   * registro/`sessionId`/entrega parcial intactos, e cada um retomável.
   *
   * A diferença para o `cancelPane` é a intenção, e ela é do dono: interromper é
   * "para agora"; cancelar é "não quero mais nada" — e só o segundo é descarte.
   */
  interruptPane(paneId: string, reason?: string): number {
    this.sweep()
    return this.bulk(() => {
      let count = 0
      for (const live of this.pick(paneId)) {
        if (isGuiHelperSettled(live.record.state)) continue
        this.stopPreserving(live, reason)
        count += 1
      }
      return count
    })
  }

  /**
   * O QUIT. Ordem do dono (R6.1): "fechar o app" é INTERRUPÇÃO, nunca descarte —
   * "fechar o app e voltar os subagentes voltarem". Os processos morrem (o
   * app-server do codex nunca encerra sozinho), os registros vão ao disco como
   * `interrupted`, e a conversa que reabrir pode retomá-los.
   */
  interruptAll(reason?: string): number {
    this.sweep()
    return this.bulk(() => {
      let count = 0
      for (const live of this.helpers.values()) {
        if (isGuiHelperSettled(live.record.state)) continue
        this.stopPreserving(live, reason)
        count += 1
      }
      return count
    })
  }

  /**
   * A PARADA PRESERVADORA, num lugar só. O que o ajudante conseguiu escrever até
   * aqui vira a entrega PARCIAL dele — registro e arquivo —, porque é exatamente
   * isso que separa interromper de cancelar. Texto vazio não vira entrega vazia:
   * a ficha diria "entrega pronta" sobre nada.
   */
  private stopPreserving(live: LiveHelper, reason?: string): void {
    this.settle(live, 'interrupted', {
      failure: interruptReason(reason),
      ...(live.text.trim() ? { text: live.text } : {})
    })
  }

  /**
   * O DESCARTE de quem já estava parado. Ele não passa pelo `settle` de
   * propósito: aquele caminho é a barreira do "encerra uma vez só" e recusaria
   * um registro que JÁ está assentado. Aqui a transição é legítima e é a única
   * que existe entre dois desfechos — interrompido → cancelado, por ordem do
   * delegador.
   */
  private discard(live: LiveHelper, failure: string): void {
    const record = live.record
    record.state = 'cancelled'
    record.settledAt = this.now()
    record.failure = failure
    this.dropDelivery(live)
    try {
      // O processo já morreu na interrupção; descartar é idempotente por
      // contrato, então isto é cinto, não expectativa.
      live.process?.dispose()
    } catch {
      /* processo que já se foi é o caso NORMAL aqui */
    }
    live.process = undefined
    live.spawnRequest = undefined
    live.text = ''
    // Quem esperava no long-poll acorda: o ajudante dele acabou de virar
    // história, e segurar a espera até o teto seria mentir por 240 segundos.
    for (const waiter of live.waiters.splice(0)) waiter()
    this.persistNow()
    this.notify({ kind: 'settled', record: { ...record } })
    this.journal({
      event: 'helper-discarded',
      paneId: record.delegatorPaneId,
      helperId: record.helperId,
      detail: { from: 'interrupted', reason: failure }
    })
  }

  /**
   * Tira a entrega do registro E do disco. O caminho sai do registro ANTES do
   * apagar: se o disco recusar, o pior caso é um arquivo órfão no worktree —
   * nunca um card apontando para um arquivo que já não existe.
   */
  private dropDelivery(live: LiveHelper): void {
    const record = live.record
    delete record.result
    delete record.resultTruncated
    delete record.deliveryError
    const resultPath = record.resultPath
    if (!resultPath) return
    delete record.resultPath
    try {
      this.deps.discardDelivery?.({ ...record, resultPath })
    } catch {
      /* apagar arquivo nunca é pré-condição de encerrar registro */
    }
  }

  /**
   * A VARREDURA. Roda no começo de toda operação pública e também por um relógio
   * do wiring — o chat ABANDONADO também tem de ser auditado, mesmo sem ninguém
   * perguntando por ele.
   *
   * O QUE MORREU AQUI (R19, ordem do dono de 2026-08-19 com o caso na tela: o
   * teto derrubou um ajudante de trabalho real aos 30 min): NENHUM ajudante é
   * assentado por relógio, nunca mais. Matar por tempo é JULGAMENTO — "deve ter
   * travado" —, e pela régua da casa julgamento vira advisory auditado; guarda
   * dura só protege autoridade e verificabilidade, e tempo não é nem uma nem
   * outra. Zumbi de verdade (processo mudo que nunca mais fala) fica VISÍVEL: o
   * cronômetro da lateral cresce e o `helpers_status` mostra o decorrido. A
   * decisão de matar é do DONO ou do DELEGADOR, pelas saídas sancionadas, que
   * continuam inteiras — ■ interrompe preservando (e o `helper_resume` retoma),
   * `helper_cancel` descarta, fechar o app interrompe.
   *
   * O que sobrou de real: o AVISO de longa duração, uma vez por vida de cada
   * ajudante. Devolve quem acabou de CRUZÁ-LO — nunca mais "quem morreu".
   */
  sweep(): GuiHelperRecord[] {
    // Guarda de reentrância: o diário é de fora, e um sink que consulte o motor
    // de volta (qualquer operação pública varre) cairia aqui no meio do laço.
    if (this.sweeping) return []
    this.sweeping = true
    try {
      const now = this.now()
      const noticed: GuiHelperRecord[] = []
      for (const live of this.helpers.values()) {
        const record = live.record
        if (isGuiHelperSettled(record.state)) continue
        // O CARIMBO é o que faz o advisory ser UM, e não um por varredura: sem
        // ele, um chat conversando despejaria o mesmo aviso a cada tool.
        if (record.longRunNoticedAt !== undefined) continue
        const elapsedMs = now - record.startedAt
        if (elapsedMs < GUI_HELPER_LONGRUN_NOTICE_MS) continue
        record.longRunNoticedAt = now
        this.journal({
          event: 'helper-longrun',
          paneId: record.delegatorPaneId,
          helperId: record.helperId,
          detail: { elapsedMs, advisory: GUI_HELPER_LONGRUN_ADVISORY }
        })
        noticed.push({ ...record })
      }
      // O carimbo vai ao disco pela BATIDA, não na hora: ele não é desfecho, e
      // uma frota inteira cruzando os 30 min no mesmo varrer não pode virar N
      // reescritas síncronas do mesmo arquivo no main.
      if (noticed.length > 0) this.persistSoon()
      return noticed
    } finally {
      this.sweeping = false
    }
  }

  // ————— internos —————

  private pick(paneId?: string): LiveHelper[] {
    if (paneId === undefined) return [...this.helpers.values()]
    const list: LiveHelper[] = []
    for (const helperId of this.byPane.get(paneId) ?? []) {
      const live = this.helpers.get(helperId)
      if (live) list.push(live)
    }
    return list
  }

  private remember(live: LiveHelper): void {
    this.helpers.set(live.record.helperId, live)
    const ids = this.byPane.get(live.record.delegatorPaneId) ?? []
    ids.push(live.record.helperId)
    this.byPane.set(live.record.delegatorPaneId, ids)
  }

  // ————— a fila de partida (R6.4) —————

  /**
   * Deixa partir quem pode, e agenda o próximo. A cadeia é sempre a mesma: o
   * primeiro de uma fila vazia com o intervalo já vencido parte AQUI DENTRO (o
   * dono aperta e vê algo acontecer), e cada seguinte espera a sua vez.
   *
   * A fila é varrida de quem já não deve partir — cancelado, interrompido ou que
   * de alguma forma já ganhou processo —, porque entre entrar na fila e chegar a
   * vez o mundo muda.
   */
  private pumpSpawnQueue(): void {
    while (this.spawnQueue.length > 0) {
      // A guarda mora DENTRO do laço: ela cobre a entrada (já há partida
      // agendada) e a reentrada (uma queda no `startHelper` que agende a
      // re-tentativa). Duas bombas correndo juntas deixariam um temporizador
      // órfão e duas partidas no mesmo instante — a rajada de volta.
      if (this.cancelSpawnTimer) return
      const helperId = this.spawnQueue[0] as string
      const live = this.helpers.get(helperId)
      if (!live || isGuiHelperSettled(live.record.state) || live.process || !live.spawnRequest) {
        this.spawnQueue.shift()
        continue
      }
      const wait = this.spawnIntervalMs - (this.now() - this.lastSpawnStartedAt)
      if (wait > 0) {
        this.cancelSpawnTimer = this.setTimer(wait, () => {
          this.cancelSpawnTimer = undefined
          this.pumpSpawnQueue()
        })
        return
      }
      this.spawnQueue.shift()
      this.startHelper(live)
    }
  }

  private startHelper(live: LiveHelper): void {
    const request = live.spawnRequest
    if (!request) return
    const helperId = live.record.helperId
    // O relógio anda ANTES da tentativa: um spawn que estoura também consumiu a
    // vez com o provedor, e é justamente essa rajada que se está espaçando.
    this.lastSpawnStartedAt = this.now()
    try {
      const adapter = request.cli === 'codex' ? this.deps.spawnCodex : this.deps.spawnClaude
      live.process = adapter(request, (event) => this.consume(helperId, event))
      // O adaptador pode ter emitido o desfecho DENTRO do próprio spawn: aí o
      // descarte já rodou sem processo nenhum em mãos, e sem esta linha o
      // processo devolvido viveria para sempre sem dono.
      if (isGuiHelperSettled(live.record.state)) live.process.dispose()
    } catch (error) {
      // O registro FICA (failed ou re-tentando): sumir sem rastro esconderia a
      // queda do dono, que veria a lateral vazia e nenhum motivo.
      this.fail(live, `o ajudante não subiu: ${errorText(error)}`)
    }
  }

  // ————— o disco (R6.1) —————

  /** Rotina (nascimento, 1º sinal de vida, sessionId, respiro): junta na janela
   *  do debounce. Uma frota de cem não pode virar cem reescritas do arquivo. */
  private persistSoon(): void {
    if (!this.deps.store || this.cancelPersistTimer) return
    this.cancelPersistTimer = this.setTimer(GUI_HELPER_PERSIST_DEBOUNCE_MS, () => {
      this.cancelPersistTimer = undefined
      this.persistNow()
    })
  }

  /** DESFECHO e boot: descarrega na hora. O que o dono acabou de ver mudar tem de
   *  estar no disco antes de a próxima queda do app apagar a diferença. */
  private persistNow(): void {
    const store = this.deps.store
    if (!store) return
    // VARREDURA EM LOTE (o ■ do dono, o quit, a vassoura): a frota inteira
    // encerra no mesmo instante, e gravar por ajudante seria N reescritas
    // SÍNCRONAS do mesmo arquivo no main — a classe de travada que esta casa
    // paga caro. Quem abriu o lote descarrega uma vez, no fim.
    if (this.bulkDepth > 0) {
      this.bulkDirty = true
      return
    }
    this.cancelPersistTimer?.()
    this.cancelPersistTimer = undefined
    try {
      store.save([...this.helpers.values()].map((live) => persistableGuiHelperRecord(live.record)))
    } catch {
      // Disco cheio ou arquivo travado não pode derrubar um motor que segura
      // processos de CLI vivos: a próxima gravação tenta de novo.
    }
  }

  /** Segura as gravações de um encerramento em massa numa só. */
  private bulk<T>(fn: () => T): T {
    this.bulkDepth += 1
    try {
      return fn()
    } finally {
      this.bulkDepth -= 1
      if (this.bulkDepth === 0 && this.bulkDirty) {
        this.bulkDirty = false
        this.persistNow()
      }
    }
  }

  private consume(helperId: string, event: GuiHelperEvent): void {
    const live = this.helpers.get(helperId)
    // Evento atrasado de ajudante já encerrado NUNCA ressuscita: um turno que
    // volta a abrir depois do desfecho deixaria o card aberto para sempre.
    if (!live || isGuiHelperSettled(live.record.state)) return
    // O PRIMEIRO SINAL DE VIDA vai ao disco (uma vez por ajudante, não a cada
    // evento): é a diferença entre um registro que o boot reencontra como "nunca
    // chegou a rodar" e um que ele reencontra como trabalho interrompido.
    if (live.record.state === 'spawning') {
      live.record.state = 'working'
      this.persistSoon()
    }

    if (event.type === 'text') {
      live.text += event.text
      return
    }
    if (event.type === 'activity') {
      const at = this.now()
      live.record.lastActivity = { at, summary: event.summary }
      if (at - live.activityNotifiedAt >= GUI_HELPER_ACTIVITY_THROTTLE_MS) {
        live.activityNotifiedAt = at
        this.notify({ kind: 'activity', record: { ...live.record } })
      }
      return
    }
    if (event.type === 'context') {
      if (typeof event.contextTokens === 'number' && event.contextTokens > 0) {
        live.record.contextTokens = Math.floor(event.contextTokens)
      }
      return
    }
    // O ENDEREÇO DA CONVERSA (R6.1). Vale o ÚLTIMO: no claude ele sobe a cada
    // `result` e um resume pode trocá-lo. Vazio nunca apaga o que já se sabia —
    // perder o id é perder a única saída de um ajudante interrompido.
    if (event.type === 'session') {
      const sessionId = trimmedOrUndefined(event.sessionId)
      if (sessionId && sessionId !== live.record.sessionId) {
        live.record.sessionId = sessionId
        this.persistSoon()
      }
      return
    }
    if (event.type === 'result') {
      if (event.isError) {
        this.fail(live, event.errorText?.trim() || 'o turno do ajudante falhou sem motivo declarado')
        return
      }
      this.settle(live, 'done', { text: event.text ?? live.text })
      return
    }
    if (event.type === 'fatal') {
      this.fail(live, event.text)
      return
    }
    // PROCESSO ENCERRADO É DESFECHO (sonda §2.6): o `claude -p` entrega o
    // resultado e morre sozinho com exit 0. Esperar um desligamento explícito
    // deixaria todo helper claude com o card aberto para sempre.
    if (live.text.trim()) {
      this.settle(live, 'done', { text: live.text })
      return
    }
    const code = typeof event.code === 'number' ? `código ${event.code}` : 'sem código de saída'
    this.fail(live, `o processo do CLI encerrou (${code}) sem entregar resultado`)
  }

  /**
   * A QUEDA, com a válvula da R6.4: assinatura claramente passageira NA PARTIDA
   * ganha UMA re-tentativa automática; o resto encerra como sempre.
   *
   * Devolve `true` quando encerrou de fato — é o que deixa o `spawn` saber se
   * ainda pode transformar a queda em recibo recusado.
   */
  private fail(live: LiveHelper, failure: string): boolean {
    const reason = this.retryReasonFor(live, failure)
    if (reason) {
      this.scheduleRetry(live, reason, failure)
      return false
    }
    this.settle(live, 'failed', { failure })
    return true
  }

  /**
   * Quando vale re-tentar. TRÊS cercas, e todas necessárias:
   * - UMA VEZ SÓ. Depois disso a inteligência do agente assume (trocar de conta,
   *   esperar, desistir) — laço de re-tentativa é como se queima limite dormindo.
   * - SÓ NA PARTIDA. Passada a janela, ou havendo QUALQUER trabalho já feito
   *   (uma ferramenta usada, um pedaço de texto), o ajudante já mexeu no worktree
   *   compartilhado: recomeçar por cima é pior que a falha honesta.
   * - SÓ ASSINATURA PASSAGEIRA (`transientHelperFailure`).
   */
  private retryReasonFor(live: LiveHelper, failure: string): string | undefined {
    if (live.record.retriedAt !== undefined) return undefined
    if (isGuiHelperSettled(live.record.state)) return undefined
    if (this.now() - live.record.startedAt > GUI_HELPER_RETRY_STARTUP_WINDOW_MS) return undefined
    if (live.record.lastActivity || live.text.trim()) return undefined
    return transientHelperFailure(failure)
  }

  private scheduleRetry(live: LiveHelper, reason: string, failure: string): void {
    const at = this.now()
    const helperId = live.record.helperId
    live.record.retriedAt = at
    live.record.retryReason = reason
    live.record.state = 'spawning'
    // A ficha do dono conta o que está acontecendo pela MESMA linha de sempre —
    // sem inventar um tipo de card novo para a lateral aprender.
    live.record.lastActivity = { at, summary: `re-tentando · ${reason}` }
    live.activityNotifiedAt = at
    live.text = ''
    try {
      live.process?.dispose()
    } catch {
      // Processo que já morreu é o caso NORMAL aqui.
    }
    live.process = undefined
    this.journal({
      event: 'helper-retry',
      paneId: live.record.delegatorPaneId,
      helperId,
      detail: { reason, failure, delayMs: this.retryDelayMs }
    })
    this.notify({ kind: 'activity', record: { ...live.record } })
    this.persistSoon()
    this.setTimer(this.retryDelayMs, () => {
      const current = this.helpers.get(helperId)
      // Cancelado/interrompido durante o respiro nunca vira processo.
      if (!current || isGuiHelperSettled(current.record.state) || current.process) return
      this.spawnQueue.push(helperId)
      this.pumpSpawnQueue()
    })
  }

  private settle(
    live: LiveHelper,
    state: 'done' | 'failed' | 'interrupted' | 'cancelled',
    payload: { text?: string; failure?: string }
  ): void {
    if (isGuiHelperSettled(live.record.state)) return
    live.record.state = state
    live.record.settledAt = this.now()
    live.settledSeq = (this.settleCounter += 1)
    if (payload.text !== undefined) {
      const capped = capGuiHelperResult(payload.text)
      live.record.result = capped.text
      if (capped.truncated) live.record.resultTruncated = true
    }
    if (payload.failure !== undefined) live.record.failure = payload.failure

    // A ENTREGA EM ARQUIVO vem AQUI, entre o registro e o anúncio: o caminho
    // precisa existir antes de os long-polls acordarem, do card `settled` sair e
    // do correio ser postado — os três citam o arquivo. `cancelled` é o
    // contrário: DESCARTE apaga a entrega (R6.2), e um cancelamento de ajudante
    // vivo não tem arquivo nenhum para apagar (nada foi gravado antes).
    // `interrupted` ENTRA: o que ele conseguiu escrever é justamente o que a
    // parada preservadora existe para não perder.
    if (state === 'cancelled') this.dropDelivery(live)
    else this.persist(live, payload.text ?? live.text)

    // O KILL É DO MOTOR: o app-server do codex nunca encerra sozinho ao fim do
    // turno (sonda §6). Descartar em TODO desfecho é o que impede órfão — e o
    // `dispose` é idempotente, então o claude que já morreu não se importa.
    try {
      live.process?.dispose()
    } catch {
      // Descarte que falha não pode impedir o desfecho de ser publicado: o card
      // ficaria aberto para sempre por causa de um processo que já se foi.
    }
    // O pedido de nascimento morre com o desfecho — de propósito, e não por
    // economia: o registro que volta do DISCO nunca terá um, então um resume que
    // dependesse dele funcionaria na mesma sessão e quebraria depois do boot. Quem
    // retomar reconstrói do registro (a onda R6-B), que é a única fonte que existe
    // nos dois casos.
    live.spawnRequest = undefined
    for (const waiter of live.waiters.splice(0)) waiter()
    this.prune(live.record.delegatorPaneId)
    // O DESFECHO NÃO ESPERA A BATIDA: é o estado que o dono acabou de ver mudar.
    this.persistNow()
    this.notify({ kind: 'settled', record: { ...live.record } })
    this.journal({
      event: 'helper-settled',
      paneId: live.record.delegatorPaneId,
      helperId: live.record.helperId,
      detail: {
        state,
        elapsedMs: (live.record.settledAt ?? 0) - live.record.startedAt,
        ...(live.record.resultTruncated ? { truncated: true } : {}),
        ...(live.record.resultPath ? { resultPath: live.record.resultPath } : {}),
        ...(live.record.deliveryError ? { deliveryError: live.record.deliveryError } : {})
      }
    })
  }

  /**
   * Grava a entrega e carimba o caminho — ou o motivo de não ter gravado.
   *
   * Falha de disco NUNCA derruba o desfecho: o registro continua com o texto em
   * memória e o `deliveryError` viaja junto para o delegador ler o que voltou
   * inline e saber por que não há arquivo. Perder a entrega porque o disco
   * encheu seria trocar um problema pequeno por um irreversível.
   */
  private persist(live: LiveHelper, text: string): void {
    if (!this.deps.deliver) return
    try {
      const outcome = this.deps.deliver({ record: { ...live.record }, text })
      if (outcome.ok) live.record.resultPath = outcome.path
      else live.record.deliveryError = outcome.error
    } catch (error) {
      live.record.deliveryError = errorText(error)
    }
  }

  /**
   * Poda a memória de ENCERRADOS do pane. Vivo nunca sai.
   *
   * A vítima é o mais antigo A ENCERRAR, nunca o mais antigo a NASCER: o
   * delegador lê os resultados na ordem em que eles chegam, e é a ordem de
   * encerramento que garante que o desfecho recém-publicado jamais seja o
   * evictado — um ajudante que nasceu primeiro e entregou por último teria o
   * resultado comido no mesmo instante em que ficou pronto.
   */
  private prune(paneId: string): void {
    const ids = this.byPane.get(paneId)
    if (!ids) return
    const settled: { helperId: string; seq: number }[] = []
    for (const helperId of ids) {
      const live = this.helpers.get(helperId)
      if (live && isGuiHelperSettled(live.record.state)) {
        settled.push({ helperId, seq: live.settledSeq ?? 0 })
      }
    }
    if (settled.length <= GUI_HELPER_SETTLED_MEMORY) return
    settled.sort((a, b) => a.seq - b.seq)
    const doomed = new Set(
      settled.slice(0, settled.length - GUI_HELPER_SETTLED_MEMORY).map((entry) => entry.helperId)
    )
    for (const helperId of doomed) this.helpers.delete(helperId)
    // O índice também solta id que outra poda já removeu: ele é a ordem da
    // lateral e não pode apontar para registro que não existe mais.
    this.byPane.set(
      paneId,
      ids.filter((helperId) => !doomed.has(helperId) && this.helpers.has(helperId))
    )
  }

  private snapshot(live: LiveHelper): GuiHelperSnapshot {
    const record = live.record
    return {
      helperId: record.helperId,
      ...(record.name ? { name: record.name } : {}),
      cli: record.cli,
      model: record.model,
      ...(record.effort ? { effort: record.effort } : {}),
      seatId: record.seatId,
      ...(record.seatName ? { seatName: record.seatName } : {}),
      state: record.state,
      startedAt: record.startedAt,
      elapsedMs: (record.settledAt ?? this.now()) - record.startedAt,
      ...(record.settledAt !== undefined ? { settledAt: record.settledAt } : {}),
      ...(record.lastActivity ? { lastActivity: record.lastActivity } : {}),
      ...(record.contextTokens !== undefined ? { contextTokens: record.contextTokens } : {}),
      hasResult: record.result !== undefined,
      ...(record.resultPath ? { resultPath: record.resultPath } : {}),
      ...(record.failure ? { failure: record.failure } : {}),
      ...(record.retriedAt !== undefined ? { retriedAt: record.retriedAt } : {}),
      ...(record.retryReason ? { retryReason: record.retryReason } : {}),
      ...(record.resumedAt !== undefined ? { resumedAt: record.resumedAt } : {})
    }
  }

  private view(live: LiveHelper, waitedMs: number): GuiHelperResultView {
    const record = live.record
    return {
      helperId: record.helperId,
      state: record.state,
      pending: !isGuiHelperSettled(record.state),
      waitedMs,
      ...(record.result !== undefined ? { result: record.result } : {}),
      ...(record.resultTruncated ? { truncated: true } : {}),
      ...(record.resultPath ? { resultPath: record.resultPath } : {}),
      ...(record.deliveryError ? { deliveryError: record.deliveryError } : {}),
      ...(record.failure ? { failure: record.failure } : {}),
      ...(record.settledAt !== undefined ? { settledAt: record.settledAt } : {}),
      snapshot: this.snapshot(live)
    }
  }

  // Observador e diário são de FORA: um erro deles não pode derrubar o motor que
  // segura processos de CLI vivos.
  private notify(change: GuiHelperChange): void {
    try {
      this.deps.onChange?.(change)
    } catch {
      /* a lateral que quebra não mata o ajudante */
    }
  }

  private journal(entry: GuiHelperLogEntry): void {
    try {
      this.deps.log?.(entry)
    } catch {
      /* diário indisponível nunca interrompe o ciclo de vida */
    }
  }
}

function helperNotFound(helperId: string): string {
  return `ajudante ${helperId} não encontrado neste chat — confira o id no helpers_status`
}

/**
 * INTERROMPIDO NÃO É ENCERRADO. A recusa de quem tenta dirigir um ajudante
 * parado precisa dizer a única coisa que muda o desfecho: dele se volta — e,
 * desde a R6-B, com o NOME dos dois verbos, porque uma saída que o agente não
 * consegue nomear é uma saída que ele não usa.
 */
function alreadySettled(state: GuiHelperState): string {
  if (state === 'interrupted') {
    return (
      'o ajudante está INTERROMPIDO: o processo dele parou, mas a conversa ficou guardada — ' +
      'dá para RETOMAR de onde parou com helper_resume, ou descartar com helper_cancel'
    )
  }
  return `o ajudante já encerrou (${state}) — abra outro com delegate se ainda falta trabalho`
}

/**
 * O NUDGE DA RETOMADA (R6.2). Curto por obrigação: a conversa retomada JÁ tem o
 * briefing inteiro, e repeti-lo seria o re-briefing perseguindo o pane que a era
 * F6 aprendeu a não fazer (lição F6.8i). Ele diz só o que a conversa não sabe —
 * que houve uma parada e que ela acabou.
 */
export const GUI_HELPER_RESUME_NUDGE =
  '[synkora] você foi interrompido e está sendo RETOMADO agora: continue de onde parou. ' +
  'Não recomece do zero nem repita o que já fez — se o trabalho já estava pronto, ' +
  'entregue o resultado final agora, no formato de sempre (arquivo + resumo curto).'

/** Só o interrompido volta. A recusa nomeia o ESTADO e o verbo que serve para
 *  ele: mandar o agente "tentar de novo" sem dizer o quê é como se queima turno. */
function notResumable(state: GuiHelperState): string {
  if (state === 'spawning' || state === 'working') {
    return (
      'o ajudante ainda está trabalhando — não há o que retomar. ' +
      'Dirija com helper_send, acompanhe com helpers_status ou descarte com helper_cancel.'
    )
  }
  if (state === 'done') {
    return 'o ajudante já entregou — leia a entrega com helper_result; retomar não acrescenta nada.'
  }
  if (state === 'cancelled') {
    return 'o ajudante foi DESCARTADO (o registro e a entrega dele já foram jogados fora) — abra outro com delegate.'
  }
  return (
    'o ajudante FALHOU: retomar não desfaz a queda. Leia o motivo no helpers_status e ' +
    'abra outro com delegate, com o briefing corrigido.'
  )
}

/** Sem `sessionId` não existe conversa a retomar (o CLI caiu antes de anunciar o
 *  endereço dela). Recomeçar em silêncio seria pior: o nudge é curto e chegaria
 *  a um ajudante que nunca ouviu falar do trabalho. */
const RESUME_WITHOUT_CONVERSATION =
  'este ajudante parou antes de o CLI anunciar o endereço da conversa dele: não há de onde retomar. ' +
  'Descarte com helper_cancel e abra outro com delegate, repetindo o briefing.'

/** O motivo que fica no registro e no diário quando o descarte veio do ✕. Ele
 *  nomeia QUEM decidiu: uma auditoria futura precisa distinguir o gesto do dono
 *  do `helper_cancel` do agente, e os dois passam pelo mesmo caminho. */
export const GUI_HELPER_OWNER_DISMISS_REASON = 'descartado pelo dono no ✕ da frota'

/**
 * A recusa do ✕, na voz do DONO (nunca a do agente): ela nomeia a alavanca que
 * ele tem na mão, e não uma tool de MCP que ele não chama. Beco sem saída é bug
 * — toda recusa aqui aponta para o gesto que resolve.
 */
function ownerDismissRefusal(state: GuiHelperState): string {
  if (state === 'spawning' || state === 'working') {
    return (
      'este ajudante ainda está TRABALHANDO — o ✕ só descarta quem já parou. ' +
      'Interrompa a frota no ■ da conversa (ela para preservando) e então descarte a ficha parada.'
    )
  }
  if (state === 'done') {
    return (
      'este ajudante já ENTREGOU — descartar apagaria a entrega dele, que é o produto do ' +
      'trabalho. Leia a entrega pelo arquivo citado na ficha.'
    )
  }
  return `este ajudante já encerrou (${state}) — não há entrega parcial nem conversa a jogar fora.`
}

function cancelReason(reason?: string): string {
  const clean = typeof reason === 'string' ? reason.trim() : ''
  return clean || 'cancelado pelo delegador'
}

function interruptReason(reason?: string): string {
  const clean = typeof reason === 'string' ? reason.trim() : ''
  return clean || 'interrompido — o trabalho dele ficou guardado'
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}
