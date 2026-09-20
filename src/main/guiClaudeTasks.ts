// Registro das tarefas de FUNDO do Claude (os subagentes despachados pela tool
// Agent). O CLI 2.1.233 roda agente em background por padrão: o tool_result do
// despacho é só um RECIBO (`status: "async_launched"`) e o terminal factual
// chega muito depois, no `system/task_notification`. Sem este registro o motor
// confunde "despachado" com "concluído" — foi a regressão de 2026-08-14.
//
// Módulo PURO (sem electron, sem I/O): uma instância por sessão viva, zerada em
// todo spawn — tarefa de fundo morre com o processo do CLI, nunca sobrevive a
// respawn. Só os DOIS joins do protocolo registram tarefa (`system/task_started`
// e o ACK `async_launched`); fotografia (`background_tasks_changed`) reconcilia,
// mas nunca adota tarefa desconhecida — sem `tool_use_id` não haveria como
// fechar o card dela.

/** Teto de id do protocolo — o mesmo do validador de hidratação. */
const GUI_CLAUDE_ID_MAX = 256
const GUI_CLAUDE_STATUS_MAX = 64
/** Lembrança de tarefas já encerradas: um `task_started` repetido/tardio nunca
 *  ressuscita agente encerrado (turno que não termina mais é pior que agente
 *  invisível). Fila FIFO — o Set preserva a ordem de inserção. */
const GUI_CLAUDE_SETTLED_MEMORY = 512

export interface GuiClaudeTaskMeta {
  description?: string
  subagentType?: string
  taskType?: string
}

export interface GuiClaudeTask extends GuiClaudeTaskMeta {
  /** `task_id` do CLI — o mesmo valor que o ACK chama de `agentId`. */
  taskId: string
  /** Id da tool de despacho: sem ele não há card para fechar na conversa. */
  toolUseId?: string
  /** Último status conhecido. Enum ABERTO do CLI, guardado como veio. */
  status?: string
}

/** SDKTaskStartedMessage distinguishes local_bash (background commands and
 * persistent Monitor watches) from agents. A live process can outlast a final
 * answer without keeping the model working. Unknown/legacy types retain the
 * conservative agent lifecycle until the CLI supplies stronger evidence.
 * Source: https://code.claude.com/docs/en/agent-sdk/typescript#sdktaskstartedmessage */
export function guiClaudeTaskBlocksTurn(task: GuiClaudeTaskMeta): boolean {
  return task.taskType !== 'local_bash'
}

function guiClaudeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Id de tarefa/ferramenta vindo do protocolo: string não vazia dentro do teto.
 *  Qualquer outra coisa é ausência — nunca uma chave forjada no registro. */
export function guiClaudeTaskId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= GUI_CLAUDE_ID_MAX
    ? value
    : undefined
}

function guiClaudeTaskStatus(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= GUI_CLAUDE_STATUS_MAX
    ? value
    : undefined
}

function withMeta(task: GuiClaudeTask, meta: GuiClaudeTaskMeta): GuiClaudeTask {
  const next = { ...task }
  if (meta.description !== undefined) next.description = meta.description
  if (meta.subagentType !== undefined) next.subagentType = meta.subagentType
  if (meta.taskType !== undefined) next.taskType = meta.taskType
  return next
}

export class GuiClaudeTaskRegistry {
  private readonly tasks = new Map<string, GuiClaudeTask>()
  private readonly byToolUse = new Map<string, string>()
  private readonly settledIds = new Set<string>()
  private readonly settledProcessIds = new Set<string>()

  /** All native background tasks, including long-lived local processes. */
  get size(): number {
    return this.tasks.size
  }

  /** Only native agent work keeps a logical chat turn open after its result. */
  liveAgentTaskIds(): string[] {
    return [...this.tasks.values()].filter(guiClaudeTaskBlocksTurn).map(task => task.taskId)
  }

  isBackgroundProcess(id: unknown): boolean {
    const key = guiClaudeTaskId(id)
    return Boolean(key && (this.taskFor(key)?.taskType === 'local_bash' || this.settledProcessIds.has(key)))
  }

  liveToolUseIds(): string[] {
    const ids: string[] = []
    for (const task of this.tasks.values()) {
      if (task.toolUseId) ids.push(task.toolUseId)
    }
    return ids
  }

  /** Busca sem encerrar: o ACK sem `agentId` legível ainda encontra a tarefa
   *  pelo `tool_use_id` que o `task_started` já registrou. */
  taskFor(id: unknown): GuiClaudeTask | null {
    const key = guiClaudeTaskId(id)
    if (!key) return null
    const taskId = this.tasks.has(key) ? key : this.byToolUse.get(key)
    return (taskId && this.tasks.get(taskId)) || null
  }

  /** Os dois joins do protocolo (`system/task_started` e o ACK
   *  `async_launched`): o que chegar primeiro registra, o segundo completa. */
  noteStarted(taskId: unknown, toolUseId: unknown, meta: GuiClaudeTaskMeta = {}): GuiClaudeTask | null {
    const key = guiClaudeTaskId(taskId)
    if (!key || this.settledIds.has(key)) return null
    const tool = guiClaudeTaskId(toolUseId)
    const current = this.tasks.get(key)
    const record = withMeta(
      { ...(current ?? { taskId: key }), ...(tool ? { toolUseId: tool } : {}) },
      meta
    )
    this.tasks.set(key, record)
    if (record.toolUseId) this.byToolUse.set(record.toolUseId, key)
    return record
  }

  /** Andamento (`task_updated`/`task_progress`): atualiza o status de quem já
   *  está vivo. NUNCA cria nem encerra — esses envelopes não são terminais. */
  noteProgress(id: unknown, status: unknown): GuiClaudeTask | null {
    const task = this.taskFor(id)
    const next = guiClaudeTaskStatus(status)
    if (!task || !next) return task
    const record = { ...task, status: next }
    this.tasks.set(task.taskId, record)
    return record
  }

  /** Terminal factual. Aceita `task_id` OU `tool_use_id`. Idempotente: o
   *  segundo encerramento devolve null — é essa idempotência que resolve a
   *  corrida entre a fotografia e o `task_notification` do mesmo agente. */
  noteSettled(id: unknown, status?: unknown): GuiClaudeTask | null {
    const key = guiClaudeTaskId(id)
    if (!key) return null
    const taskId = this.tasks.has(key) ? key : this.byToolUse.get(key)
    const task = taskId ? this.tasks.get(taskId) : undefined
    if (!taskId || !task) {
      // A terminal can arrive before its delayed start/ACK. Its identity is
      // still authoritative; forgetting it would resurrect completed work.
      this.rememberSettled(key)
      return null
    }
    this.tasks.delete(taskId)
    if (task.toolUseId) this.byToolUse.delete(task.toolUseId)
    this.rememberSettled(taskId, task.taskType)
    const next = guiClaudeTaskStatus(status)
    return next ? { ...task, status: next } : task
  }

  /** `background_tasks_changed` é fotografia COMPLETA e autoritativa das
   *  tarefas vivas. TRAP DO PROTOCOLO: com o conjunto vazio a chave `tasks` é
   *  OMITIDA — ausência (ou payload torto) é conjunto VAZIO, nunca "sem
   *  informação", senão o último agente ficaria imortal.
   *
   *  Devolve os candidatos e NÃO encerra ninguém: o CLI publica a fotografia
   *  ~1ms ANTES do `task_notification` correspondente (triplo atômico medido),
   *  então quem chama decide depois que o chunk inteiro atravessou o parser. */
  reconcile(tasks: unknown): GuiClaudeTask[] {
    const live = new Set<string>()
    if (Array.isArray(tasks)) {
      for (const entry of tasks) {
        const record = guiClaudeRecord(entry)
        const id = guiClaudeTaskId(record?.['task_id'])
        if (id) {
          live.add(id)
          const taskType = guiClaudeTaskStatus(record?.['task_type'])
          // Snapshots enrich only an existing identity. This repairs an
          // earlier untyped shell start without adopting unknown work.
          if (taskType && this.tasks.has(id)) this.noteStarted(id, undefined, { taskType })
        }
      }
    }
    const missing: GuiClaudeTask[] = []
    for (const task of this.tasks.values()) {
      if (!live.has(task.taskId)) missing.push(task)
    }
    return missing
  }

  /** Drena tudo (interrupção confirmada, `closed`, `fatal`, dispose): o
   *  processo levou os agentes junto. */
  settleAll(): GuiClaudeTask[] {
    const drained = [...this.tasks.values()]
    for (const task of drained) this.rememberSettled(task.taskId, task.taskType)
    this.tasks.clear()
    this.byToolUse.clear()
    return drained
  }

  private rememberSettled(taskId: string, taskType?: string): void {
    if (!this.settledIds.has(taskId) && this.settledIds.size >= GUI_CLAUDE_SETTLED_MEMORY) {
      const oldest = this.settledIds.values().next()
      if (!oldest.done) {
        this.settledIds.delete(oldest.value)
        this.settledProcessIds.delete(oldest.value)
      }
    }
    this.settledIds.add(taskId)
    if (taskType === 'local_bash') this.settledProcessIds.add(taskId)
  }
}
