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
import type { ManualSecurityValidation } from './manualSecurityValidation'
import type { SecurityReviewRecord } from './securityReview'
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
  verdict: 'approved' | 'rejected' | 'invalid'
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
  }
  activeGate?: {
    phase: 'review' | 'qa'
    startedAt: string
    baselineFingerprint?: string
  }
  review?: TaskGateEvidence
  qa?: TaskGateEvidence
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
    | 'briefing'
    | 'gates'
    | 'version'
    | 'missionId'
    | 'quests'
    | 'skills'
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
      return {
        ...t,
        status: t.status === 'analise' ? 'backlog' : t.status,
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
        createdAt: now,
        updatedAt: now
      }
    })
    this.tasks.push(...created)
    this.persist()
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
    const task = this.tasks.find((t) => t.id === id)
    if (!task) return undefined
    const prev = { ...task }
    Object.assign(task, redactSensitiveStrings(patch), { updatedAt: new Date().toISOString() })
    this.persist()
    try {
      this.onMutation?.(prev, task)
    } catch {
      // observador nunca interrompe o store
    }
    return task
  }

  /** Aplica um pequeno conjunto relacionado em uma única persistência. Se
   * qualquer id estiver ausente ou repetido, nada é alterado. */
  updateMany(updates: readonly { id: string; patch: TaskUpdatePatch }[]): Task[] | undefined {
    const ids = new Set(updates.map((update) => update.id))
    if (ids.size !== updates.length) return undefined
    const targets = updates.map((update) => this.tasks.find((task) => task.id === update.id))
    if (targets.some((task) => !task)) return undefined
    const now = new Date().toISOString()
    const previous = targets.map((target) => ({ ...(target as Task) }))
    for (const [index, target] of targets.entries()) {
      Object.assign(target as Task, redactSensitiveStrings(updates[index].patch), { updatedAt: now })
    }
    this.persist()
    try {
      for (const [index, target] of targets.entries()) {
        this.onMutation?.(previous[index], target as Task)
      }
    } catch {
      // observador nunca interrompe o store
    }
    return targets as Task[]
  }

  remove(id: string): void {
    const removed = this.tasks.find((t) => t.id === id)
    this.tasks = this.tasks.filter((t) => t.id !== id)
    this.persist()
    if (removed) {
      try {
        this.onRemove?.(removed)
      } catch {
        // observador nunca interrompe o store
      }
    }
  }
}
