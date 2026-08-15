// Registro dos SUB-AGENTES do Codex vivos nesta sessão. O `codex app-server`
// 0.147 não tem notificação dedicada de colaboração: tudo viaja nos frames
// genéricos `item/started|completed`. O ÚNICO sinal de spawn é o item
// `subAgentActivity {kind:"started", agentThreadId, agentPath}` publicado no
// thread RAIZ, e o terminal FACTUAL é o `turn/completed` do thread do FILHO —
// `subAgentActivity` não tem kind terminal e `closeAgent` nunca foi observado
// ao vivo (sonda 2026-08-15 ×3 + schema gerado pelo próprio binário instalado).
// Quem esperar por um "close" vaza card para sempre.
//
// Módulo PURO (sem electron, sem I/O): uma instância por sessão, morta com o
// processo — sub-agente não sobrevive a respawn e nunca é retomado. Como não
// existe tool_use de spawn no wire, o card do pai usa um id SINTÉTICO derivado
// do thread do filho (`codex-agent:<agentThreadId>`): estável entre frames,
// sem colisão com id de item do protocolo.
//
// Este registro é do Codex e SÓ do Codex. O ciclo de vida do Claude mora em
// `guiClaudeTasks.ts` e os dois NUNCA compartilham inferência: evento emitido a
// partir daqui jamais carrega `agentStatus`/`agentTaskId` (esses campos são do
// contrato Claude, onde "pai tem result" ainda não é terminal; aqui é).

/** Prefixo do id sintético do card pai. */
export const GUI_CODEX_AGENT_TOOL_PREFIX = 'codex-agent:'
/** Teto do thread id: com o prefixo o id sintético ainda cabe nos 256 chars que
 *  os validadores de hidratação (vivo e disco) aceitam. */
const GUI_CODEX_THREAD_ID_MAX = 200
const GUI_CODEX_AGENT_PATH_MAX = 512
const GUI_CODEX_AGENT_NAME_MAX = 120
/** Sub-agentes vivos ao mesmo tempo. Servidor com defeito não vira registro
 *  infinito: acima do teto o spawn é ignorado (sem card, sem turno preso). */
const GUI_CODEX_AGENT_CAP = 64
/** Cards de ferramenta do filho rastreados por agente. Acima do teto a
 *  linhagem continua (o card sai do fio principal), só o fechamento no settle
 *  deixa de ser rastreado — o terminal do turno ainda o fecha no renderer. */
const GUI_CODEX_CHILD_TOOL_CAP = 64
/** Lembrança de agentes já encerrados: um `subAgentActivity` repetido/tardio
 *  nunca ressuscita agente morto (turno que não termina mais é pior que agente
 *  invisível). Fila FIFO — o Set preserva a ordem de inserção. */
const GUI_CODEX_SETTLED_MEMORY = 512

export interface GuiCodexAgent {
  /** Thread do FILHO — a identidade do sub-agente em todo o wire. */
  agentThreadId: string
  /** Id sintético do card pai (`codex-agent:<agentThreadId>`). */
  toolUseId: string
  /** Nome humano: último segmento do `agentPath` (`/root/calculo` → `calculo`). */
  name?: string
  agentPath?: string
  /** Cards de ferramenta do filho ainda sem resultado, na ordem de abertura. */
  openToolUseIds: string[]
}

interface GuiCodexAgentEntry {
  agentThreadId: string
  toolUseId: string
  name?: string
  agentPath?: string
  openTools: Set<string>
}

/** Id opaco vindo do protocolo (thread do filho ou item de ferramenta): string
 *  não vazia dentro do teto. Qualquer outra coisa é ausência — nunca uma chave
 *  forjada no registro. */
function guiCodexBoundedId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= GUI_CODEX_THREAD_ID_MAX
    ? value
    : undefined
}

export function guiCodexAgentThreadId(value: unknown): string | undefined {
  return guiCodexBoundedId(value)
}

/** Id do card pai. Sintético por necessidade: o spawn do Codex não tem
 *  tool_use próprio no wire. */
export function guiCodexAgentToolUseId(agentThreadId: string): string {
  return `${GUI_CODEX_AGENT_TOOL_PREFIX}${agentThreadId}`
}

/** Único nome humano que o protocolo oferece: o último segmento do `agentPath`
 *  (`model`, `agentNickname` e `agentRole` chegam null em todo frame collab). */
export function guiCodexAgentName(agentPath: unknown): string | undefined {
  if (typeof agentPath !== 'string') return undefined
  const path = agentPath.slice(0, GUI_CODEX_AGENT_PATH_MAX)
  for (const segment of path.split('/').reverse()) {
    const name = segment.trim()
    if (name) return name.slice(0, GUI_CODEX_AGENT_NAME_MAX)
  }
  return undefined
}

function guiCodexAgentPath(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, GUI_CODEX_AGENT_PATH_MAX)
    : undefined
}

export class GuiCodexAgentRegistry {
  private readonly agents = new Map<string, GuiCodexAgentEntry>()
  private readonly settledIds = new Set<string>()

  /** Quantos sub-agentes continuam vivos — é o que segura o terminal do turno
   *  raiz (o `result` fica retido enquanto houver filho trabalhando). */
  get size(): number {
    return this.agents.size
  }

  has(agentThreadId: unknown): boolean {
    const key = guiCodexAgentThreadId(agentThreadId)
    return Boolean(key && this.agents.has(key))
  }

  toolUseIdFor(agentThreadId: unknown): string | undefined {
    const key = guiCodexAgentThreadId(agentThreadId)
    return key ? this.agents.get(key)?.toolUseId : undefined
  }

  agentFor(agentThreadId: unknown): GuiCodexAgent | null {
    const key = guiCodexAgentThreadId(agentThreadId)
    const entry = key ? this.agents.get(key) : undefined
    return entry ? snapshot(entry) : null
  }

  /** Spawn. IDEMPOTENTE por desenho: `item/started` e `item/completed` chegam
   *  com payload IDÊNTICO ~1ms depois um do outro, então só a PRIMEIRA
   *  registra (e só ela devolve o agente para o card nascer uma vez). */
  noteStarted(agentThreadId: unknown, agentPath?: unknown): GuiCodexAgent | null {
    const key = guiCodexAgentThreadId(agentThreadId)
    if (!key || this.settledIds.has(key) || this.agents.has(key)) return null
    if (this.agents.size >= GUI_CODEX_AGENT_CAP) return null
    const path = guiCodexAgentPath(agentPath)
    const name = guiCodexAgentName(path)
    const entry: GuiCodexAgentEntry = {
      agentThreadId: key,
      toolUseId: guiCodexAgentToolUseId(key),
      ...(name ? { name } : {}),
      ...(path ? { agentPath: path } : {}),
      openTools: new Set<string>()
    }
    this.agents.set(key, entry)
    return snapshot(entry)
  }

  /** Ferramenta aberta pelo filho. Devolve o id do card PAI para a emissão
   *  carimbar `parentToolUseId` (é isso que tira o card do fio principal e o
   *  põe na linha de atividade da lateral). */
  noteChildTool(agentThreadId: unknown, toolUseId: unknown): string | undefined {
    const key = guiCodexAgentThreadId(agentThreadId)
    const entry = key ? this.agents.get(key) : undefined
    if (!entry) return undefined
    const tool = guiCodexBoundedId(toolUseId)
    if (tool && entry.openTools.size < GUI_CODEX_CHILD_TOOL_CAP) entry.openTools.add(tool)
    return entry.toolUseId
  }

  /** Ferramenta do filho que reportou sozinha: sai da lista de pendentes para
   *  o settle não fechar duas vezes o mesmo card. */
  noteChildToolDone(agentThreadId: unknown, toolUseId: unknown): string | undefined {
    const key = guiCodexAgentThreadId(agentThreadId)
    const entry = key ? this.agents.get(key) : undefined
    if (!entry) return undefined
    const tool = guiCodexBoundedId(toolUseId)
    if (tool) entry.openTools.delete(tool)
    return entry.toolUseId
  }

  /** Terminal factual (o `turn/completed` do filho) ou cancelamento.
   *  IDEMPOTENTE: o segundo encerramento devolve null — o card do pai fecha
   *  uma vez só, e um frame tardio nunca reabre o turno. */
  noteSettled(agentThreadId: unknown): GuiCodexAgent | null {
    const key = guiCodexAgentThreadId(agentThreadId)
    const entry = key ? this.agents.get(key) : undefined
    if (!key || !entry) return null
    this.agents.delete(key)
    this.rememberSettled(key)
    return snapshot(entry)
  }

  /** `subAgentActivity {kind:"interrupted"}` — mesmo encerramento, nome do
   *  sinal que o produziu (quem chama decide o desfecho visível). */
  noteInterrupted(agentThreadId: unknown): GuiCodexAgent | null {
    return this.noteSettled(agentThreadId)
  }

  /** Drena tudo (interrupção confirmada do turno raiz, `closed`, `fatal`,
   *  dispose): o processo levou os filhos junto. */
  settleAll(): GuiCodexAgent[] {
    const drained = [...this.agents.values()].map(snapshot)
    for (const agent of drained) this.rememberSettled(agent.agentThreadId)
    this.agents.clear()
    return drained
  }

  private rememberSettled(agentThreadId: string): void {
    if (this.settledIds.size >= GUI_CODEX_SETTLED_MEMORY) {
      const oldest = this.settledIds.values().next()
      if (!oldest.done) this.settledIds.delete(oldest.value)
    }
    this.settledIds.add(agentThreadId)
  }
}

function snapshot(entry: GuiCodexAgentEntry): GuiCodexAgent {
  return {
    agentThreadId: entry.agentThreadId,
    toolUseId: entry.toolUseId,
    ...(entry.name ? { name: entry.name } : {}),
    ...(entry.agentPath ? { agentPath: entry.agentPath } : {}),
    openToolUseIds: [...entry.openTools]
  }
}
