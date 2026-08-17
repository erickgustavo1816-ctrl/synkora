import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { loadJsonStore, persistJsonStore } from './jsonStore'
import type {
  MissionExecutionMode,
  MissionRiskLevel,
  TaskDelegationMode,
  TaskDeliverableKind
} from './orchestratorFlow'
import type {
  VerificationBatchResult,
  VerificationCheckpoint,
  VerificationCommand,
  VerificationComparison
} from './missionVerification'
import type { ProjectAdapterDetection } from './projectAdapters'

/** Veredito estruturado do gate de segurança da era F6 e a validação humana
 *  do plano. As duas máquinas morreram na limpa F6 (2026-08-17); as FORMAS
 *  ficam declaradas porque `tasks.json` do dono ainda as carrega e o store
 *  precisa lê-las sem perder nada. */
type ManualSecurityValidation = Record<string, unknown>
type SecurityReviewRecord = Record<string, unknown>

/** Evidência que um gate F6 anexava ao veredito. O validador morreu com o
 *  pipeline de fases; a FORMA fica declarada aqui porque `tasks.json` do dono
 *  ainda a carrega em cards antigos e o store precisa lê-la sem perder nada. */
export interface GateVerificationEvidence {
  summary: string
  surfaces?: string[]
  states?: string[]
  viewports?: string[]
  observations: string[]
}

import { redactSensitiveStrings } from './securityRedaction'

// Funções enxutas (decisão do usuário, 2026-07-23): só existe função quando
// muda QUEM executa e COMO. mobile→front, devops→back, docs→research.
export type Department =
  | 'front'
  | 'back'
  | 'qa'
  | 'design'
  | 'research'
  | 'copy'
  | 'cyber'
  | 'data'
// 'analise' foi REMOVIDO (decisão do usuário, 2026-07-23): reprovação volta
// para o backlog com o feedback no card — coluna extra não fazia sentido.
export type TaskStatus = 'backlog' | 'execucao' | 'qa' | 'done'
export type TaskType = 'feature' | 'bug'
export type TaskEffort = 'leve' | 'pesada'

// F5.7 — missão dirigida por PLANO: o orquestrador propõe UM card de plano;
// o usuário revisa (pode ajustar seat/modelo/effort por função) e aprova.
// Depois da aprovação o orquestrador toca tudo sozinho: os cards de trabalho
// que ele cria nascem `auto` (apenas visuais no board) e são executados por
// ele via tool run_task — o usuário acompanha, não opera.

/** Uma "lane" do plano: função envolvida + executor que vai atendê-la.
 *  seat/model/effort são a POLÍTICA DO PLANO — o usuário tem a palavra final
 *  no modal de aprovação; depois de aprovado, a lane é contrato. */
export interface PlanLane {
  dept: Department
  /** o que essa função fará neste plano (1 linha, PT-BR) */
  notes?: string
  seatId?: string
  model?: string
  effort?: string
}

/** Grafo aprovado antes da execucao. O texto explica o plano ao usuario;
 * estes campos dizem ao backend qual card existe e o que realmente depende
 * de que entrega. */
export interface PlanWorkItem {
  id: string
  title: string
  department: Department
  deliverable: TaskDeliverableKind
  waveId: string
  dependsOn: string[]
}

export interface TaskPlan {
  /** o plano legível (markdown, PT-BR): o que será feito, ondas, entregas */
  summary: string
  lanes: PlanLane[]
  /** Perfil proporcional escolhido pelo orquestrador; ausente = plano legado. */
  executionMode?: MissionExecutionMode
  /** Classificacao enviada pelo agente antes do piso automatico. */
  declaredRisk?: MissionRiskLevel
  risk?: MissionRiskLevel
  riskSurfaces?: string[]
  riskReasons?: string[]
  /** Versão do contrato nativo usado para planejar/executar este trabalho. */
  securityPolicyVersion?: number
  /** O plano precisa deixar uma validação humana sensível visível no aceite. */
  manualSecurityValidationRequired?: boolean
  /** Estado verificavel da validacao humana; o booleano acima preserva planos legados. */
  manualSecurityValidation?: ManualSecurityValidation
  sizingReason?: string
  /** Orçamento aprovado; criar além dele exige reclassificar e reapresentar. */
  expectedCards?: number
  /** Grafo tipado dos cards/ondas; ausente apenas em planos legados. */
  workItems?: PlanWorkItem[]
  /** conclusão escrita pelo orquestrador quando o plano termina (markdown) */
  conclusion?: string
  /** ISO de quando o usuário aprovou (status backlog→execucao) */
  approvedAt?: string
  /** HEAD da branch da missao que o harness reconhece como produzido apenas
   * por cards. Se o orquestrador editar/commitar direto, a cadeia diverge. */
  executionHead?: string
  /** Evidencia persistida da fotografia inicial e da validacao conjunta. */
  verification?: PlanVerificationState
}

export interface PlanVerificationCheckpoint extends VerificationCheckpoint {
  head?: string
  commands: VerificationCommand[]
  /** CI/PR/segurança/deploy só aparecem quando o próprio projeto os declara. */
  adapters?: ProjectAdapterDetection[]
  result?: VerificationBatchResult
  comparison?: VerificationComparison
  pendingConclusion?: string
}

export interface PlanVerificationState {
  baseline?: PlanVerificationCheckpoint
  final?: PlanVerificationCheckpoint
}

export interface TaskGateEvidence {
  phase: 'review' | 'qa'
  /** 'waived' = dispensado por AUTORIDADE do orquestrador (complete_task,
   *  2026-08-10) — juízo auditado, nunca evidência fabricada; conclude_plan
   *  aceita e a verificação conjunta + ⇪ do dono seguem sendo as cercas. */
  verdict: 'approved' | 'rejected' | 'invalid' | 'waived'
  startedAt: string
  finishedAt: string
  baselineFingerprint?: string
  finalFingerprint?: string
  snapshotHead?: string
  snapshotTree?: string
  readonly: boolean
  reason?: string
  /** Evidência estruturada e sanitizada; opcional em tarefas legadas. */
  securityReview?: SecurityReviewRecord
  /** Matriz/observações realmente verificadas nesta rodada. */
  verificationEvidence?: GateVerificationEvidence
}

/** Livro-caixa tecnico do card: prova a ordem dev -> gates e impede que um
 * reviewer/QA altere o entregavel sem devolve-lo ao desenvolvimento. */
export interface TaskVerification {
  contractVersion: 1
  dev?: {
    reportedAt: string
    /** Commit/árvore imutáveis congelados antes de qualquer gate. */
    head?: string
    tree?: string
    /** Merge-base imutável usado pelo reviewer para enxergar o card inteiro. */
    baseHead?: string
    fingerprint?: string
    changedPaths?: string[]
    /** Evidência visual estruturada da entrega, quando o card toca UI. */
    verificationEvidence?: GateVerificationEvidence
  }
  activeGate?: {
    phase: 'review' | 'qa'
    startedAt: string
    baselineFingerprint?: string
  }
  review?: TaskGateEvidence
  qa?: TaskGateEvidence
  /** Histórico limitado das rodadas; os slots acima são apenas o resumo atual. */
  gateHistory?: TaskGateEvidence[]
}

/** Ponte persistida entre um pane de fase e a conversa real do CLI. O
 * processo do terminal não sobrevive ao fechamento do app, mas esta chave
 * permite reabrir a mesma conversa, no mesmo seat, sobre o worktree intacto. */
export interface TaskPhaseResume {
  phase: 'dev' | 'review' | 'qa'
  sessionId: string
  seatId: string
  cli: 'claude' | 'codex'
  model?: string
  effort?: string
  capturedAt: string
  /** Último contexto vivo medido da conversa (sessionStats). O resume de uma
   * conversa REPROCESSA o histórico inteiro como input no 1º turno — caso
   * real 2026-08-06: retomar um dev Fable com ~700k de janela custou ~10% do
   * limite da conta SÓ para reler o que já estava feito. Acima do teto, o
   * respawn nasce fresco sobre o trabalho preservado (transcript/PLAN). */
  lastContextTokens?: number
}

export interface TaskPhaseSessions {
  dev?: TaskPhaseResume
  review?: TaskPhaseResume
  qa?: TaskPhaseResume
}

export interface TaskIntegrationPreparing {
  version: 1
  stage: 'preparing'
  marker: string
  sourceHead: string
  sourceTree: string
  approvedFingerprint: string
  previousTargetHead: string
  targetBranch: string
  recordedAt: string
}

export interface TaskIntegrationPrepared {
  version: 1
  stage: 'prepared'
  marker: string
  sourceHead: string
  sourceTree: string
  previousTargetHead: string
  targetBranch: string
  committedHead: string
  recordedAt: string
}

export type TaskIntegrationReceipt =
  | TaskIntegrationPreparing
  | TaskIntegrationPrepared

export interface TaskSkillUsageRun {
  phase: 'dev' | 'review' | 'qa'
  phaseRun: string
  updatedAt: string
  runStatus?: 'active' | 'completed' | 'interrupted'
  skills: Array<{
    receiptId?: string
    id: string
    operation: string
    version?: string
    fingerprint?: string
    status: 'planned' | 'activated' | 'applied'
  }>
  /** Persona efetiva roteada para esta rodada. Diferente de task.agents,
   * inclui a seleção automática feita quando o pane conhece capacidades. */
  agents?: Array<{
    id: string
    status: 'planned' | 'completed'
  }>
}

export interface TaskSkillUsage extends TaskSkillUsageRun {
  /** Historico seguro por rodada; nunca inclui corpo, prompt ou path local. */
  history?: TaskSkillUsageRun[]
}

export interface Task {
  id: string
  projectId: string
  department: Department
  type: TaskType
  effort: TaskEffort
  title: string
  description: string
  status: TaskStatus
  origin: 'maestro' | 'manual'
  createdAt: string
  updatedAt: string
  /** metadados da execução — o card mostra tudo, sem adivinhação */
  runSeat?: string
  runModel?: string
  /** effort do EXECUTOR carimbado na 1ª abertura (contrato do usuário via
   *  lane/modal) — toda reabertura reusa; default do modelo nunca substitui
   *  uma escolha explícita (caso real 2026-08-04). */
  devEffort?: string
  /** ciclos de retry automático dev↔gate já gastos */
  cycles?: number
  /** último feedback de reprovação (revisor/QA) */
  feedback?: string
  /** Correção pequena pedida depois da entrega: reabre este mesmo card com
   * perfil FAST, sem fabricar um segundo plano/card para o mesmo trabalho. */
  adjustment?: { reason: string; requestedAt: string }
  /** Rodada QUICK (ajuste rápido — ordem do dono 2026-08-12: "ajustes
   * pequenos são insuportáveis", máscara de input custou 30+ min de rito):
   * protocolo cortado — checks proporcionais + evidência do delta no dev,
   * olhada-relâmpago no review, sem QA. Skills/qualidade NUNCA se cortam.
   * Carimbado pelo run_task: adjustment ⇒ true; dispatch cheio ⇒ false. */
  quickRound?: boolean
  /** briefing escrito pelo MAESTRO para o executor (vira o prompt do dev) */
  briefing?: string
  /** gates a rodar após o dev — ausente = ['review','qa']; [] = nenhum
   *  (somente entregável non_code de risco baixo/médio; non_code sensível
   *  recebe review e código mantém validação) */
  gates?: TaskGate[]
  /** versão do projeto quando a tarefa foi criada (filtro do board) */
  version?: string
  /** missão dona da tarefa — ausente = "Geral" (fora de missão) */
  missionId?: string
  /** checklist de quests: 1 card por área com vários itens (em vez de N cards) */
  quests?: string[]
  /** skills da BIBLIOTECA carimbadas pelo orquestrador para ESTE card — o
   *  harness injeta no workspace do run (F4). Ausente = padrão da função. */
  skills?: string[]
  /** True when the card changes a user-visible surface. Every orchestrated
   * code card declares it; legacy/manual cards use safe inference. */
  affectsUi?: boolean
  /** Plano efetivo escolhido pelo roteador nesta fase, separado dos carimbos
   * do card. Permite ao dono ver planejada -> ativada -> aplicada. */
  skillUsage?: TaskSkillUsage
  /** notas do orquestrador ANEXADAS ao prompt do gate no spawn (review/qa) —
   *  instrução de gate viaja no briefing, nunca perseguindo o pane. */
  gateNotes?: { review?: string; qa?: string }
  /** rodada de gate em aberto: a lista FECHADA da reprovação vigente + placar
   *  por rodada. Sobrevive à morte do pane do gate — um reviewer NOVO herda a
   *  lista em vez de re-legislar (caso real 2026-08-05: o restart das 16:59
   *  matou o gate vivo e a rodada 5 re-auditou tudo com régua nova). Limpa na
   *  aprovação da fase. */
  gateRound?: {
    phase: 'review' | 'qa'
    rejectedHead?: string
    /** lista integral da reprovação (sem o teto do log de exibição) */
    list: string
    round: number
    /** placar declarado pelo gate (detector anti-loop, 2026-08-05) */
    scores?: {
      pendentes: number
      parciais: number
      novos: number
      head?: string
      at: string
    }[]
    /** Evidência sanitizada que originou esta lista fechada. */
    verificationEvidence?: GateVerificationEvidence
    /** Snapshot das notas usado para distinguir waiver novo de delta vazio. */
    gateNotesAtRejection?: string
  }
  /** SUBAGENTES da biblioteca carimbados para este card (dev claude invoca
   *  via Task tool; injetados em .claude/agents do workspace) */
  agents?: string[]
  /** Contrato explícito: checklist não implica ajudantes. */
  delegation?: TaskDelegationMode
  /** Código mantém validação; documento/asset comum pode encerrar sem gates. */
  deliverable?: TaskDeliverableKind
  /** IDs de cards deste mesmo plano que precisam estar concluidos primeiro. */
  dependsOn?: string[]
  /** Evidencias produzidas e conferidas pelo harness. */
  verification?: TaskVerification
  /** Fase persistida para reinício nunca repetir o desenvolvimento por engano. */
  activePhase?: 'dev' | 'review' | 'qa'
  /** pending = próxima fase já decidida mas pane ainda não abriu;
   * finalizing = todos os gates acabaram e só falta integrar/fechar o card. */
  phaseState?: 'pending' | 'running' | 'interrupted' | 'finalizing'
  phaseStartedAt?: string
  /** Conversa retomável da fase. Comando/processo em andamento nunca é
   * considerado vivo depois de um restart; apenas contexto e arquivos voltam. */
  phaseResume?: TaskPhaseResume
  /** Conversas de todas as fases: mantém o dev original enquanto review/QA
   * rodam, para uma eventual reprovação voltar à pessoa certa. */
  phaseSessions?: TaskPhaseSessions
  /** Intenção/receipt gravado antes de mover o ref do destino. Permite
   * distinguir merge ainda não iniciado, já gravado e reparo após reinício. */
  integrationReceipt?: TaskIntegrationReceipt
  /** 'plan' = card de PLANO da missão (proposta do orquestrador; nunca roda o
   *  pipeline de fases). Ausente = tarefa de trabalho normal. */
  kind?: 'plan'
  /** conteúdo do plano (só em kind 'plan') */
  plan?: TaskPlan
  /** true = card criado/gerido pelo ORQUESTRADOR em modo autônomo: no board é
   *  apenas visual (sem mover/executar/editar — quem opera é o orquestrador) */
  auto?: boolean
  /** id do card de PLANO sob o qual este card nasceu — o modal/progresso de
   *  cada plano mostra SÓ os cards dele (2 planos na mesma missão não se
   *  misturam) */
  planId?: string
  /** id estável do item correspondente no grafo aprovado do plano. */
  planItemId?: string
  /** Card operacional criado pelo PRÓPRIO HARNESS (sync da fila de
   *  integração) — fica FORA do contrato de proporcionalidade e do grafo
   *  aprovado. Campo persistente porque o marcador [fila:...] do briefing
   *  morre em reescrita (caso real 2026-08-10). */
  queueSync?: boolean
}

export type TaskGate = 'review' | 'qa'

export interface NewTask {
  department: Department
  type: TaskType
  effort: TaskEffort
  title: string
  description: string
  origin: 'maestro' | 'manual'
  briefing?: string
  gates?: TaskGate[]
  version?: string
  missionId?: string
  quests?: string[]
  skills?: string[]
  affectsUi?: boolean
  agents?: string[]
  delegation?: TaskDelegationMode
  deliverable?: TaskDeliverableKind
  dependsOn?: string[]
  verification?: TaskVerification
  kind?: 'plan'
  plan?: TaskPlan
  auto?: boolean
  planId?: string
  planItemId?: string
  queueSync?: boolean
}

export type TaskUpdatePatch = Partial<
  Pick<
    Task,
    | 'title'
    | 'description'
    | 'status'
    | 'department'
    | 'type'
    | 'effort'
    | 'runSeat'
    | 'runModel'
    | 'cycles'
    | 'feedback'
    | 'adjustment'
    | 'quickRound'
    | 'briefing'
    | 'gates'
    | 'version'
    | 'missionId'
    | 'quests'
    | 'skills'
    | 'affectsUi'
    | 'skillUsage'
    | 'agents'
    | 'delegation'
    | 'deliverable'
    | 'dependsOn'
    | 'verification'
    | 'activePhase'
    | 'phaseState'
    | 'phaseStartedAt'
    | 'phaseResume'
    | 'phaseSessions'
    | 'integrationReceipt'
    | 'gateRound'
    | 'plan'
    | 'auto'
  >
>

export type RendererTaskPatch = Partial<
  Pick<Task, 'title' | 'description' | 'department' | 'type' | 'effort' | 'status'>
>

export type RendererTaskPatchResult =
  | { ok: true; patch: RendererTaskPatch }
  | {
      ok: false
      reason: 'invalid_patch' | 'forbidden_field' | 'invalid_value' | 'active_pane'
    }

const RENDERER_TASK_FIELDS = new Set([
  'title',
  'description',
  'department',
  'type',
  'effort',
  'status'
])
const TASK_DEPARTMENTS = new Set<Department>([
  'front',
  'back',
  'qa',
  'design',
  'research',
  'copy',
  'cyber',
  'data'
])
const TASK_TYPES = new Set<TaskType>(['feature', 'bug'])
const TASK_EFFORTS = new Set<TaskEffort>(['leve', 'pesada'])
const TASK_STATUSES = new Set<TaskStatus>(['backlog', 'execucao', 'qa', 'done'])

/**
 * Fronteira autoritativa do renderer. Campos de verificacao, receipts, fases,
 * automacao e identidade de execucao pertencem ao harness e nunca atravessam
 * o IPC de edicao generico. Um pane vivo exige cancelamento explicito antes
 * de qualquer edicao ou mudanca de coluna.
 */
export function sanitizeRendererTaskPatch(
  value: unknown,
  options: { hasActivePane: boolean }
): RendererTaskPatchResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'invalid_patch' }
  }
  const raw = value as Record<string, unknown>
  const keys = Object.keys(raw)
  if (keys.some((key) => !RENDERER_TASK_FIELDS.has(key))) {
    return { ok: false, reason: 'forbidden_field' }
  }
  if (options.hasActivePane && keys.length > 0) {
    return { ok: false, reason: 'active_pane' }
  }

  const patch: RendererTaskPatch = {}
  if ('title' in raw) {
    if (typeof raw.title !== 'string' || !raw.title.trim()) {
      return { ok: false, reason: 'invalid_value' }
    }
    patch.title = raw.title.trim()
  }
  if ('description' in raw) {
    if (typeof raw.description !== 'string') return { ok: false, reason: 'invalid_value' }
    patch.description = raw.description
  }
  if ('department' in raw) {
    if (typeof raw.department !== 'string' || !TASK_DEPARTMENTS.has(raw.department as Department)) {
      return { ok: false, reason: 'invalid_value' }
    }
    patch.department = raw.department as Department
  }
  if ('type' in raw) {
    if (typeof raw.type !== 'string' || !TASK_TYPES.has(raw.type as TaskType)) {
      return { ok: false, reason: 'invalid_value' }
    }
    patch.type = raw.type as TaskType
  }
  if ('effort' in raw) {
    if (typeof raw.effort !== 'string' || !TASK_EFFORTS.has(raw.effort as TaskEffort)) {
      return { ok: false, reason: 'invalid_value' }
    }
    patch.effort = raw.effort as TaskEffort
  }
  if ('status' in raw) {
    if (typeof raw.status !== 'string' || !TASK_STATUSES.has(raw.status as TaskStatus)) {
      return { ok: false, reason: 'invalid_value' }
    }
    patch.status = raw.status as TaskStatus
  }
  return { ok: true, patch }
}

/** Fecha uma rodada de receipts que perdeu o pane sem fingir conclusao. */
export function interruptActiveSkillUsage(
  usage: TaskSkillUsage | undefined,
  updatedAt = new Date().toISOString()
): TaskSkillUsage | undefined {
  if (!usage || usage.runStatus === 'completed' || usage.runStatus === 'interrupted') {
    return usage
  }
  const currentRun: TaskSkillUsageRun = {
    phase: usage.phase,
    phaseRun: usage.phaseRun,
    updatedAt: usage.updatedAt,
    runStatus: usage.runStatus,
    skills: usage.skills,
    agents: usage.agents
  }
  let matched = false
  const history = (usage.history?.length ? usage.history : [currentRun]).map((run) => {
    if (run.phaseRun !== usage.phaseRun) return run
    matched = true
    return { ...run, updatedAt, runStatus: 'interrupted' as const }
  })
  if (!matched) history.push({ ...currentRun, updatedAt, runStatus: 'interrupted' })
  return { ...usage, updatedAt, runStatus: 'interrupted', history }
}

type StoredTask = Omit<Partial<Task>, 'status'> & {
  id: string
  projectId: string
  title: string
  status: TaskStatus | 'analise'
}

function isStoredTaskArray(value: unknown): value is StoredTask[] {
  if (!Array.isArray(value)) return false
  const statuses = new Set(['backlog', 'execucao', 'qa', 'done', 'analise'])
  return value.every((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return false
    const task = candidate as Partial<StoredTask>
    return (
      typeof task.id === 'string' &&
      task.id.length > 0 &&
      typeof task.projectId === 'string' &&
      task.projectId.length > 0 &&
      typeof task.title === 'string' &&
      typeof task.status === 'string' &&
      statuses.has(task.status)
    )
  })
}

export class TaskStore {
  private file = join(app.getPath('userData'), 'tasks.json')
  private tasks: Task[] = []
  /** Caixa-preta: observadores de mutação (prev é uma cópia rasa fiel). */
  onMutation?: (prev: Task, next: Task) => void
  onCreate?: (created: Task[]) => void
  onRemove?: (removed: Task) => void

  constructor() {
    const raw = loadJsonStore(
      this.file,
      (): StoredTask[] => [],
      isStoredTaskArray
    )
    // Migração leve: tarefas antigas não tinham `type`/`effort`; o status
    // 'analise' foi extinto — vira backlog (feedback continua no card).
    this.tasks = raw.map((stored) => {
      const t = redactSensitiveStrings(stored)
      const status = t.status === 'analise' ? 'backlog' : t.status
      return {
        ...t,
        status,
        type: t.type ?? 'feature',
        effort: t.effort ?? 'leve'
      }
    }) as Task[]
    // Promove a fotografia migrada usando escrita atômica + backup.
    if (raw.length > 0) this.persist()
  }

  private persist(): void {
    persistJsonStore(this.file, this.tasks)
  }

  /** Commit transacional: o arquivo atomico pousa antes de a fotografia viva
   * mudar. Se o disco falhar, leitores e retries continuam vendo o estado
   * anterior em vez de um card meio-avancado apenas na memoria. */
  private commit(next: Task[]): void {
    persistJsonStore(this.file, next)
    this.tasks = next
  }

  list(projectId: string): Task[] {
    return this.tasks.filter((t) => t.projectId === projectId)
  }

  get(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id)
  }

  createMany(projectId: string, items: NewTask[]): Task[] {
    const now = new Date().toISOString()
    const created = items.map((unsafeItem): Task => {
      const item = redactSensitiveStrings(unsafeItem)
      return {
        id: randomUUID(),
        projectId,
        department: item.department,
        type: item.type,
        effort: item.effort,
        title: item.title,
        description: item.description,
        status: 'backlog',
        origin: item.origin,
        briefing: item.briefing,
        gates: item.gates,
        version: item.version,
        missionId: item.missionId,
        quests: item.quests,
        skills: item.skills,
        affectsUi: item.affectsUi,
        agents: item.agents,
        delegation: item.delegation,
        deliverable: item.deliverable,
        dependsOn: item.dependsOn,
        verification: item.verification,
        kind: item.kind,
        plan: item.plan,
        auto: item.auto,
        planId: item.planId,
        planItemId: item.planItemId,
        queueSync: item.queueSync,
        createdAt: now,
        updatedAt: now
      }
    })
    this.commit([...this.tasks, ...created])
    try {
      this.onCreate?.(created)
    } catch {
      // observador nunca interrompe o store
    }
    return created
  }

  update(
    id: string,
    patch: TaskUpdatePatch
  ): Task | undefined {
    const index = this.tasks.findIndex((t) => t.id === id)
    const task = index >= 0 ? this.tasks[index] : undefined
    if (!task) return undefined
    const prev = { ...task }
    const nextTask = {
      ...task,
      ...redactSensitiveStrings(patch),
      updatedAt: new Date().toISOString()
    }
    const next = [...this.tasks]
    next[index] = nextTask
    this.commit(next)
    try {
      this.onMutation?.(prev, nextTask)
    } catch {
      // observador nunca interrompe o store
    }
    return nextTask
  }

  /** Aplica um pequeno conjunto relacionado em uma única persistência. Se
   * qualquer id estiver ausente ou repetido, nada é alterado. */
  updateMany(updates: readonly { id: string; patch: TaskUpdatePatch }[]): Task[] | undefined {
    const ids = new Set(updates.map((update) => update.id))
    if (ids.size !== updates.length) return undefined
    const indexes = updates.map((update) => this.tasks.findIndex((task) => task.id === update.id))
    if (indexes.some((index) => index < 0)) return undefined
    const now = new Date().toISOString()
    const previous = indexes.map((index) => ({ ...this.tasks[index] }))
    const changed = updates.map((update, index) => ({
      ...this.tasks[indexes[index]],
      ...redactSensitiveStrings(update.patch),
      updatedAt: now
    }))
    const next = [...this.tasks]
    indexes.forEach((taskIndex, index) => {
      next[taskIndex] = changed[index]
    })
    this.commit(next)
    try {
      for (const [index, target] of changed.entries()) {
        this.onMutation?.(previous[index], target)
      }
    } catch {
      // observador nunca interrompe o store
    }
    return changed
  }

  remove(id: string): void {
    const removed = this.tasks.find((t) => t.id === id)
    const next = this.tasks.filter((t) => t.id !== id)
    this.commit(next)
    if (removed) {
      try {
        this.onRemove?.(removed)
      } catch {
        // observador nunca interrompe o store
      }
    }
  }
}
