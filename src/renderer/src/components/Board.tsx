import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import PaneChrome, { ZERO_STATS } from './PaneChrome'
import TerminalPane from './TerminalPane'
import ProjectGeneral from './ProjectGeneral'
import NewMissionModal from './NewMissionModal'
import { TestServerModal } from './TestServerModal'
import { ModelSelect } from './ModelSelect'
import Select from './Select'
import {
  TERMINAL_DEFAULT_FONT_FAMILY,
  TERMINAL_DEFAULT_FONT_SIZE,
  TERMINAL_DEFAULT_LINE_HEIGHT,
  TERMINAL_NATIVE_SCROLLBAR_WIDTH,
  TERMINAL_SCROLLBAR_WIDTH,
  terminalFallbackForHost,
  terminalMinColsForBox
} from '../terminalGeometry'
import {
  useStore,
  type Department,
  type Mission,
  type Pane,
  type PlanLane,
  type Task,
  type TaskStatus,
  type TaskType,
  type Version
} from '../store'
import { DEPARTMENTS, DEPT_BY_KEY, deptHueVar, STATUS_LABEL, STATUS_ORDER } from '../departments'

// Spec do pane TUI do Maestro (tipo vem da bridge do preload).
type MaestroPaneSpec = NonNullable<Awaited<ReturnType<typeof window.synkora.maestro.paneSpec>>>

function integrationQueueLabel(mission: Mission): string | undefined {
  const integration = mission.integration
  if (!integration) return undefined
  if (integration.state === 'merging') return 'integrando agora'
  if (integration.state === 'blocked')
    return integration.owner === 'orchestrator'
      ? 'fila pausada — reparo seguro do destino pendente'
      : 'fila pausada — Maestro decidindo'
  if (integration.state === 'sync_required') return 'sincronizando antes de integrar'
  return `fila de integração #${integration.position} de ${integration.total}`
}

const EXECUTION_MODE_LABEL = {
  fast: 'rápida',
  standard: 'padrão',
  deep: 'profunda'
} as const

const RISK_LABEL = {
  low: 'risco baixo',
  medium: 'risco médio',
  high: 'risco alto'
} as const

function manualValidationForPlan(
  plan: NonNullable<Task['plan']>
): NonNullable<NonNullable<Task['plan']>['manualSecurityValidation']> {
  if (plan.manualSecurityValidation) return plan.manualSecurityValidation
  return plan.manualSecurityValidationRequired
    ? { required: true, status: 'pending' }
    : { required: false, status: 'not_required' }
}

const PHASE_META = {
  dev: { label: 'implementação', step: '1/3' },
  review: { label: 'revisão', step: '2/3' },
  qa: { label: 'QA', step: '3/3' }
} as const

type WorkPhase = keyof typeof PHASE_META

function taskPhaseView(
  task: Task,
  pane?: Pick<Pane, 'role'>
): { phase: WorkPhase; label: string; interrupted: boolean } | undefined {
  if (task.status === 'done') return undefined
  const panePhase =
    pane?.role === 'dev' || pane?.role === 'review' || pane?.role === 'qa'
      ? pane.role
      : undefined
  const phase = task.activePhase ?? panePhase ?? (task.status === 'qa' ? 'qa' : undefined)
  if (!phase) return undefined
  const interrupted = task.phaseState === 'interrupted'
  const meta = PHASE_META[phase]
  return {
    phase,
    label: `${meta.label} ${meta.step}${interrupted ? ' · interrompida' : ''}`,
    interrupted
  }
}

function planWorkState(workTasks: Task[]): string | undefined {
  const phases = workTasks
    .map((task) => taskPhaseView(task))
    .filter((phase): phase is NonNullable<typeof phase> => Boolean(phase))
  const interrupted = phases.find((phase) => phase.interrupted)
  if (interrupted) return `⏸ ${interrupted.label}`
  if (phases.length === 1) return `▶ ${phases[0].label}`
  if (phases.length > 1) {
    const labels = [...new Set(phases.map((phase) => phase.label))].join(' + ')
    return `▶ ${phases.length} cards ativos · ${labels}`
  }
  return undefined
}

function PlanContract({
  plan,
  compact = false
}: {
  plan: NonNullable<Task['plan']>
  compact?: boolean
}): React.JSX.Element {
  const mode = plan.executionMode
  const risk = plan.risk
  const manualValidation = manualValidationForPlan(plan)
  const budget =
    plan.expectedCards == null
      ? 'orçamento não informado'
      : `até ${plan.expectedCards} ${plan.expectedCards === 1 ? 'card' : 'cards'}`
  return (
    <div className={`plan-contract${compact ? ' compact' : ''}`}>
      <div className="plan-contract-chips">
        <span
          className={`plan-contract-chip mode-${mode ?? 'legacy'}`}
          data-tip={mode ? 'Perfil proporcional escolhido pelo orquestrador' : 'Plano anterior ao fluxo proporcional'}
        >
          {mode ? `perfil ${EXECUTION_MODE_LABEL[mode]}` : 'perfil legado'}
        </span>
        <span className={`plan-contract-chip risk-${risk ?? 'unknown'}`}>
          {risk ? RISK_LABEL[risk] : 'risco não informado'}
        </span>
        <span className="plan-contract-chip budget" data-tip="Limite de cards aprovado neste plano">
          {budget}
        </span>
        {plan.securityPolicyVersion != null && (
          <span
            className="plan-contract-chip security-policy"
            data-tip="Política nativa do Synkora: escopo autorizado, segredos protegidos, evidência e testes por correção"
          >
            política v{plan.securityPolicyVersion} aplicada
          </span>
        )}
        {manualValidation.required && (
          <span
            className={`plan-contract-chip manual-security ${manualValidation.status}`}
            data-tip={
              manualValidation.status === 'pending'
                ? plan.riskReasons?.join(' · ') ||
                  'Este plano toca uma área sensível e precisa de uma decisão humana antes da conclusão.'
                : `${manualValidation.status === 'approved' ? 'Confirmada' : 'Dispensada'} em ${new Date(manualValidation.resolvedAt).toLocaleString('pt-BR')}: ${manualValidation.evidence}`
            }
          >
            {manualValidation.status === 'pending'
              ? 'validação pendente'
              : manualValidation.status === 'approved'
                ? 'validação confirmada'
                : 'validação dispensada'}
          </span>
        )}
      </div>
      {(plan.sizingReason || !compact) && (
        <div
          className="plan-contract-reason"
          data-tip={compact ? plan.sizingReason : undefined}
        >
          <b>Por que este tamanho:</b>{' '}
          {plan.sizingReason ?? 'plano legado sem justificativa de tamanho registrada'}
        </div>
      )}
    </div>
  )
}

/** Cards que pertencem a ESTE plano: carimbados com o id dele (planId); card
 *  LEGADO sem carimbo só conta no plano ATIVO e se nasceu DEPOIS da aprovação
 *  (bug real: cards concluídos do plano anterior vazavam para o plano novo). */
function belongsToPlan(t: Task, planTask: Task): boolean {
  if (t.planId) return t.planId === planTask.id
  if (planTask.status === 'done') return false
  const approved = planTask.plan?.approvedAt
  return !approved || t.createdAt >= approved
}

/** Effort da lane do plano: mesmas opções reais do catálogo (o ModelSelect ao
 *  lado já carregou o par cli:seat — aqui só lê o cache). */
function LaneEffortSelect({
  lane,
  cli,
  onChange
}: {
  lane: PlanLane
  cli: 'claude' | 'codex'
  onChange: (v: string) => void
}): React.JSX.Element {
  const catalog = useStore((s) => s.catalogByCli[`${cli}:${lane.seatId ?? ''}`])
  const opts =
    catalog?.models.find((m) => m.id === (lane.model ?? ''))?.efforts ?? catalog?.efforts ?? []
  return (
    <Select
      className="exec-effort"
      tip="Effort (raciocínio) do executor desta função"
      value={lane.effort ?? ''}
      disabled={!lane.seatId}
      options={[{ value: '', label: 'effort padrão' }, ...opts.map((ef) => ({ value: ef, label: ef }))]}
      onChange={onChange}
    />
  )
}

/** F5.7 — modal do CARD DE PLANO: o usuário lê o que vai acontecer, ajusta
 *  seat/modelo/effort por função se quiser, e aprova. Depois disso a missão é
 *  do orquestrador (cards auto, run_task) até a conclusão pousar aqui. */
function PlanModal({
  task,
  workTasks,
  onClose
}: {
  task: Task
  /** cards de trabalho da missão (sem o plano) — progresso e lista visual */
  workTasks: Task[]
  onClose: () => void
}): React.JSX.Element {
  const seats = useStore((s) => s.seats)
  const approvePlan = useStore((s) => s.approvePlan)
  const stopPlan = useStore((s) => s.stopPlan)
  const resolvePlanSecurityValidation = useStore((s) => s.resolvePlanSecurityValidation)
  const removeTask = useStore((s) => s.removeTask)
  const plan = task.plan
  const manualValidation = plan ? manualValidationForPlan(plan) : null
  const [lanes, setLanes] = useState<PlanLane[]>(plan?.lanes ?? [])
  const [manualEvidence, setManualEvidence] = useState('')
  const [manualError, setManualError] = useState('')
  const [manualBusy, setManualBusy] = useState(false)
  // CAS da aprovação: o orquestrador re-propôs enquanto o usuário lia — a
  // aprovação foi recusada e o modal precisa ser reaberto na versão nova.
  const [stalePlan, setStalePlan] = useState(false)
  const [planningEvidenceRequired, setPlanningEvidenceRequired] = useState(false)
  const editable = task.status === 'backlog'
  const securityWaiverAllowed =
    plan?.risk !== 'high' && (plan?.riskSurfaces?.length ?? 0) === 0
  const completedPlanCards = workTasks.filter((candidate) => candidate.status === 'done').length
  const manualValidationReady =
    task.status === 'execucao' &&
    workTasks.length > 0 &&
    completedPlanCards === workTasks.length &&
    (plan?.expectedCards === undefined || workTasks.length >= plan.expectedCards)

  async function resolveManualValidation(decision: 'approved' | 'waived'): Promise<void> {
    if (!manualValidationReady) {
      setManualError(
        'A validação fica disponível depois que todos os cards previstos estiverem concluídos.'
      )
      return
    }
    setManualBusy(true)
    setManualError('')
    try {
      await resolvePlanSecurityValidation(task.id, decision, manualEvidence)
      setManualEvidence('')
    } catch (error) {
      setManualError(error instanceof Error ? error.message : String(error))
    } finally {
      setManualBusy(false)
    }
  }

  const summaryHtml = useMemo(() => {
    if (!plan?.summary) return ''
    const raw = marked.parse(plan.summary, { async: false, gfm: true, breaks: false })
    return DOMPurify.sanitize(raw)
  }, [plan?.summary])
  const conclusionHtml = useMemo(() => {
    if (!plan?.conclusion) return ''
    const raw = marked.parse(plan.conclusion, { async: false, gfm: true, breaks: false })
    return DOMPurify.sanitize(raw)
  }, [plan?.conclusion])

  const done = workTasks.filter((t) => t.status === 'done').length
  const liveWorkState = planWorkState(workTasks)
  // Seleção de texto que TERMINA fora do modal não pode fechá-lo: o click
  // dispara no overlay quando o mouseup cai lá — só fecha se o gesto COMEÇOU
  // no próprio overlay (senão copiar um trecho longo fechava o plano).
  const downOnOverlay = useRef(false)

  function patchLane(i: number, patch: Partial<PlanLane>): void {
    setLanes((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }

  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => {
        downOnOverlay.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (downOnOverlay.current && e.target === e.currentTarget) onClose()
      }}
    >
      <div className="task-modal plan-modal" onClick={(e) => e.stopPropagation()}>
        <div className="task-modal-head">
          <span className="plan-badge">◆ plano da missão</span>
          {task.status === 'backlog' && (
            <span className="lock-badge plan-wait-badge">
              {plan?.approvedAt ? '⏸ pausado — re-aprove para retomar' : '🖐 aguardando sua aprovação'}
            </span>
          )}
          {task.status === 'execucao' && (
            <span className="lock-badge run-running">
              {liveWorkState ?? '▶ preparando o primeiro card'} · {done}/
              {workTasks.length || plan?.expectedCards || '…'}
            </span>
          )}
          {task.status === 'done' && <span className="lock-badge run-done">✓ concluído</span>}
          <button className="pane-close dark-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="task-modal-title readonly">{task.title}</div>

        {plan && <PlanContract plan={plan} />}

        {manualValidation?.required && (
          <section className={`plan-security-validation ${manualValidation.status}`}>
            <div className="plan-security-validation-head">
              <div>
                <div className="plan-sec-label">validação humana de segurança</div>
                <p>
                  {manualValidation.status === 'pending'
                    ? manualValidationReady
                      ? 'Normalmente o gate especialista (review de segurança) preenche isto sozinho ao aprovar a fotografia. Se ficou pendente, o review não produziu um securityReview aprovado — confirme manualmente com evidência ou reabra o review.'
                      : 'Em modo estrito, o gate especialista de segurança resolve isto sozinho durante o review; este painel só pede ação se aquele caminho não concluir.'
                    : manualValidation.status === 'approved'
                      ? manualValidation.actor === 'security-gate'
                        ? 'Validação confirmada pelo GATE ESPECIALISTA de segurança (securityReview aprovado sobre a fotografia imutável) — sem ação humana.'
                        : 'Validação confirmada pelo usuário.'
                      : 'Validação dispensada pelo usuário com justificativa (modo leve).'}
                </p>
              </div>
              <span className="plan-security-validation-status">
                {manualValidation.status === 'pending'
                  ? 'pendente'
                  : manualValidation.status === 'approved'
                    ? 'confirmada'
                    : 'dispensada'}
              </span>
            </div>
            {manualValidation.status === 'pending' && manualValidationReady ? (
              <>
                <textarea
                  className="plan-security-validation-evidence"
                  value={manualEvidence}
                  maxLength={1200}
                  placeholder="Registre o fluxo, o ambiente sintético/local usado e o resultado observado. Não cole tokens nem dados reais."
                  onChange={(event) => setManualEvidence(event.target.value)}
                />
                {manualError && <div className="plan-security-validation-error">{manualError}</div>}
                <div className="plan-security-validation-actions">
                  {securityWaiverAllowed && (
                    <button
                      className="btn ghost"
                      disabled={manualBusy || manualEvidence.trim().length < 20}
                      onClick={() => void resolveManualValidation('waived')}
                    >
                      dispensar com justificativa
                    </button>
                  )}
                  <button
                    className="btn accent"
                    disabled={manualBusy || manualEvidence.trim().length < 20}
                    onClick={() => void resolveManualValidation('approved')}
                  >
                    {manualBusy ? 'salvando…' : 'confirmar validação'}
                  </button>
                </div>
              </>
            ) : manualValidation.status === 'pending' ? (
              <div className="plan-security-validation-waiting">
                {task.status !== 'execucao'
                  ? 'Aprove e execute o plano primeiro.'
                  : `${completedPlanCards}/${plan?.expectedCards ?? (workTasks.length || '…')} cards concluídos — o formulário abre ao fim da entrega.`}
              </div>
            ) : (
              <div className="plan-security-validation-record">
                <b>{new Date(manualValidation.resolvedAt).toLocaleString('pt-BR')}</b>
                <span>{manualValidation.evidence}</span>
              </div>
            )}
          </section>
        )}

        {task.status === 'done' && conclusionHtml && (
          <div className="plan-conclusion">
            <div className="plan-sec-label">✓ conclusão do orquestrador — o que mudou</div>
            <article className="md-view plan-md" dangerouslySetInnerHTML={{ __html: conclusionHtml }} />
          </div>
        )}

        {task.status === 'done' ? (
          <details className="task-briefing">
            <summary>◆ o plano aprovado</summary>
            <article className="md-view plan-md" dangerouslySetInnerHTML={{ __html: summaryHtml }} />
          </details>
        ) : (
          <article className="md-view plan-md" dangerouslySetInnerHTML={{ __html: summaryHtml }} />
        )}

        <div className="plan-lanes">
          <div className="plan-sec-label">
            {editable
              ? 'funções e executores — ajuste se precisar; aprovado, vira contrato'
              : 'funções e executores (contrato aprovado)'}
          </div>
          {lanes.map((lane, i) => {
            const d = DEPT_BY_KEY[lane.dept]
            const laneCli = seats.find((s) => s.id === lane.seatId)?.cli ?? 'claude'
            return (
              <div key={i} className="plan-lane" style={{ ['--dept-hue' as string]: deptHueVar(d.key) }}>
                <span className="task-dept">
                  {d.icon} {d.name}
                </span>
                {editable ? (
                  <>
                    <Select
                      value={lane.seatId ?? ''}
                      placeholder="— seat —"
                      options={seats.map((s) => ({ value: s.id, label: s.name, cli: s.cli }))}
                      onChange={(v) =>
                        patchLane(i, { seatId: v, model: undefined, effort: undefined })
                      }
                    />
                    <ModelSelect
                      cli={laneCli}
                      seatId={lane.seatId || undefined}
                      value={lane.model ?? ''}
                      disabled={!lane.seatId}
                      onChange={(m) => patchLane(i, { model: m || undefined, effort: undefined })}
                    />
                    <LaneEffortSelect
                      lane={lane}
                      cli={laneCli}
                      onChange={(v) => patchLane(i, { effort: v || undefined })}
                    />
                  </>
                ) : (
                  <span className="plan-lane-ro">
                    {seats.find((s) => s.id === lane.seatId)?.name ?? lane.seatId ?? 'política do dept'}
                    {' · '}
                    {lane.model || 'modelo padrão'}
                    {lane.effort ? ` · ${lane.effort}` : ''}
                  </span>
                )}
                {lane.notes && <div className="plan-lane-notes">{lane.notes}</div>}
              </div>
            )
          })}
        </div>

        {task.status !== 'backlog' && workTasks.length > 0 && (
          <div className="plan-progress">
            <div className="plan-sec-label">cards do plano (visuais — o orquestrador opera)</div>
            {workTasks.map((t) => (
              <div key={t.id} className={`plan-progress-line ${t.status}`}>
                {t.status === 'done' ? '▣' : t.status === 'backlog' ? '▢' : '▶'} [
                {DEPT_BY_KEY[t.department].name}] {t.title} —{' '}
                {taskPhaseView(t)?.label ?? STATUS_LABEL[t.status]}
              </div>
            ))}
          </div>
        )}

        {stalePlan && (
          <div className="plan-progress" style={{ color: 'var(--err)' }}>
            ⚠ o orquestrador ATUALIZOU a proposta enquanto você lia — feche e reabra o
            plano para ler a versão nova antes de aprovar.
          </div>
        )}
        {planningEvidenceRequired && (
          <div className="plan-progress" style={{ color: 'var(--err)' }}>
            ⚠ esta proposta veio de uma versão antiga do fluxo e não comprova o método
            de planejamento. Peça ao orquestrador para reapresentá-la antes de aprovar.
          </div>
        )}
        <div className="task-modal-actions">
          {task.status === 'backlog' && (
            <>
              <button
                className="btn ghost danger"
                data-tip="Descarta a proposta — combine o replanejamento com o orquestrador no painel da missão"
                onClick={() => {
                  void removeTask(task.id)
                  onClose()
                }}
              >
                excluir
              </button>
              <span className="task-modal-meta">
                proposto em {new Date(task.createdAt).toLocaleString('pt-BR')}
              </span>
              <button
                className="btn accent"
                data-tip="Aprova o plano com as lanes acima — o orquestrador cria e executa os cards sozinho a partir daqui"
                onClick={() => {
                  // CAS: manda a revisão que o usuário está LENDO — se o
                  // orquestrador re-propôs no meio, o main recusa e o modal
                  // avisa em vez de aprovar um contrato desatualizado.
                  void approvePlan(task.id, lanes, task.updatedAt).then((r) => {
                    if (r && 'staleRevision' in r) {
                      setStalePlan(true)
                      return
                    }
                    if (r && 'planningEvidenceRequired' in r) {
                      setPlanningEvidenceRequired(true)
                      return
                    }
                    onClose()
                  })
                }}
              >
                ▶ aprovar e executar
              </button>
            </>
          )}
          {task.status === 'execucao' && (
            <>
              <span className="task-modal-meta">
                aprovado em{' '}
                {plan?.approvedAt ? new Date(plan.approvedAt).toLocaleString('pt-BR') : '—'}
              </span>
              <button
                className="btn ghost"
                data-tip="Pausa o plano: o orquestrador para de disparar novos cards (os em andamento terminam a fase). Re-aprovar retoma de onde parou."
                onClick={() => void stopPlan(task.id)}
              >
                ⏸ pausar plano
              </button>
            </>
          )}
          {task.status === 'done' && (
            <button className="btn" onClick={onClose}>
              fechar
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

function TaskModal({
  task,
  projectId,
  livePane,
  missionClosed,
  onNewMissionFrom,
  onClose
}: {
  task: Task
  projectId: string
  livePane: Pane | null
  /** missão da tarefa já concluída/arquivada/excluída — reabrir não faz
   *  sentido (o worktree/branch dela nem existem mais; o trabalho está na
   *  main); o caminho é uma NOVA missão referenciando este card */
  missionClosed: boolean
  onNewMissionFrom: () => void
  onClose: () => void
}): React.JSX.Element {
  const updateTask = useStore((s) => s.updateTask)
  const removeTask = useStore((s) => s.removeTask)
  const seats = useStore((s) => s.seats)
  const policies = useStore((s) => s.policies)
  const runTask = useStore((s) => s.runTask)
  const missionTitle = useStore((s) =>
    task.missionId ? s.missions.find((m) => m.id === task.missionId)?.title : undefined
  )

  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [department, setDepartment] = useState<Department>(task.department)
  const [type, setType] = useState<TaskType>(task.type)
  const [effort, setEffort] = useState(task.effort)
  const [status, setStatus] = useState(task.status)
  const phaseView = taskPhaseView(task, livePane ?? undefined)
  const skillStatusLabel = {
    planned: 'selecionada',
    activated: 'carregada',
    applied: 'declarada na entrega'
  } as const
  const skillRuns = task.skillUsage
    ? task.skillUsage.history?.length
      ? task.skillUsage.history
      : [task.skillUsage]
    : []
  const latestSkillRunByPhase = new Map<string, (typeof skillRuns)[number]>()
  for (const run of skillRuns) latestSkillRunByPhase.set(run.phase, run)
  const visibleSkillRuns = [...latestSkillRunByPhase.values()]
  const skillUsageLine = visibleSkillRuns.some((run) => run.skills.length)
    ? visibleSkillRuns
        .map(
          (run) =>
            `${run.phase.toUpperCase()} · ${run.skills
              .map((skill) => `${skill.id} (${skill.operation} · ${skillStatusLabel[skill.status]})`)
              .join(' · ')}`
        )
        .join(' | ')
    : [
        ...(task.skills ?? []).map((skill) => `${skill} (carimbada)`),
        ...(task.agents ?? []).map((agent) => `⬡ ${agent}`)
      ].join(' · ')
  const skillUsageTip = task.skillUsage
    ? `Rastreio por rodada: ${skillRuns
        .map(
          (run) =>
            `${run.phase.toUpperCase()} ${run.runStatus ?? 'legado'} — ${run.skills
              .map(
                (skill) =>
                  `${skill.id}@${skill.version?.slice(0, 10) ?? 'legado'} (${skillStatusLabel[skill.status]})`
              )
              .join(', ')}`
        )
        .join(' | ')}. A qualidade é julgada separadamente pelo QA.`
    : 'Preferências carimbadas no card; a seleção efetiva aparece quando a fase começa.'

  const dept = DEPT_BY_KEY[department]
  const dirty =
    title !== task.title ||
    description !== task.description ||
    department !== task.department ||
    type !== task.type ||
    effort !== task.effort ||
    status !== task.status

  // Política do departamento resolve seat+modelo pelo peso; o usuário pode
  // sobrescrever nos controles abaixo antes de executar.
  const slot = effort === 'pesada' ? policies[department]?.heavy : policies[department]?.light
  const [execSeat, setExecSeat] = useState(slot?.seatId ?? seats.find((x) => x.cli === 'claude')?.id ?? '')
  const [execModel, setExecModel] = useState(slot?.model ?? '')
  const [execEffort, setExecEffort] = useState('')
  const policyApplied = Boolean(slot?.seatId)
  // Efforts reais do CLI/modelo escolhidos (mesmo catálogo do ModelSelect).
  const execCli = seats.find((x) => x.id === execSeat)?.cli ?? 'claude'
  const execCatalog = useStore((s) => s.catalogByCli[`${execCli}:${execSeat}`])
  const effortOpts =
    execCatalog?.models.find((m) => m.id === execModel)?.efforts ?? execCatalog?.efforts ?? []

  useEffect(() => {
    const fresh = effort === 'pesada' ? policies[department]?.heavy : policies[department]?.light
    if (fresh?.seatId) setExecSeat(fresh.seatId)
    if (fresh !== undefined) setExecModel(fresh.model ?? '')
  }, [effort, department, policies])

  async function save(): Promise<void> {
    if (!title.trim()) return
    await updateTask(task.id, {
      title: title.trim(),
      description,
      department,
      type,
      effort,
      status
    })
    onClose()
  }

  function execute(): void {
    const seat = seats.find((x) => x.id === execSeat)
    if (!seat) return
    // Dev roda num pane TUI DE VERDADE na aba Panes; a conclusão (marcador)
    // dispara os gates automáticos de revisão/QA/merge.
    void runTask(projectId, task.id, seat.id, execModel.trim() || undefined, execEffort || undefined)
    onClose()
  }

  // Tarefa CONCLUÍDA: modal de RESUMO, não de edição — o que foi feito, por
  // quem, com quais gates; reabrir manda de volta ao backlog.
  if (task.status === 'done' && !livePane) {
    const gates = task.gates ?? ['review', 'qa']
    return createPortal(
      <div className="overlay" onClick={onClose}>
        <div
          className="task-modal done-modal"
          style={{ ['--dept-hue' as string]: deptHueVar(dept.key) }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="task-modal-head">
            <span className="task-dept">
              {dept.icon} {dept.name}
            </span>
            <span className="lock-badge run-done">✓ concluída</span>
            {task.version && <span className="task-origin">◈ {task.version}</span>}
            <button className="pane-close dark-close" onClick={onClose}>
              ×
            </button>
          </div>
          <div className="task-modal-title readonly">{task.title}</div>
          {task.description && <div className="task-modal-desc readonly">{task.description}</div>}
          {task.quests && task.quests.length > 0 && (
            <div className="task-quests modal">
              {task.quests.map((q, i) => (
                <div key={i} className="quest-line done">
                  ▣ {q}
                </div>
              ))}
            </div>
          )}
          {skillUsageLine && (
            <div className="task-skills-line" data-tip={skillUsageTip}>
              ⚡ {skillUsageLine}
            </div>
          )}
          <div className="done-meta">
            {task.runSeat && (
              <span>
                ⚙ executada por {task.runSeat} · {task.runModel ?? 'modelo padrão'}
              </span>
            )}
            <span>
              gates: {gates.length ? gates.join(' + ') : 'nenhum (trivial)'}
              {task.cycles ? ` · ${task.cycles} retry(s)` : ''}
            </span>
            <span>concluída em {new Date(task.updatedAt).toLocaleString('pt-BR')}</span>
            <span className="done-transcript">transcript: .synkora/runs/{task.id}.md</span>
          </div>
          {task.briefing && (
            <details className="task-briefing">
              <summary>🎯 briefing do Maestro</summary>
              <pre>{task.briefing}</pre>
            </details>
          )}
          <div className="task-modal-actions">
            {missionClosed ? (
              <button
                className="btn ghost"
                data-tip="A missão deste card já foi integrada na main — reabrir não existe. Cria uma NOVA missão com este card como referência (ajustar/evoluir o que foi feito)."
                onClick={() => {
                  onNewMissionFrom()
                  onClose()
                }}
              >
                🚀 nova missão a partir deste card
              </button>
            ) : task.auto ? (
              <span
                className="task-origin"
                data-tip="Card do orquestrador (modo plano) — para refazer algo, fale com ele no painel da missão"
              >
                ⟡ gerido pelo orquestrador
              </span>
            ) : (
              <button
                className="btn ghost"
                data-tip="Reabre a tarefa no backlog (novo ciclo de execução)"
                onClick={() => {
                  void updateTask(task.id, { status: 'backlog' })
                  onClose()
                }}
              >
                ↩ reabrir
              </button>
            )}
            <button className="btn" onClick={onClose}>
              fechar
            </button>
          </div>
        </div>
      </div>,
      document.body
    )
  }

  if (livePane) {
    return createPortal(
      <div className="overlay" onClick={onClose}>
        <div
          className="task-modal"
          style={{ ['--dept-hue' as string]: deptHueVar(dept.key) }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="task-modal-head">
            <span className="task-dept">
              {dept.icon} {dept.name}
            </span>
            <span className={`lock-badge task-phase-badge phase-${phaseView?.phase ?? 'dev'}`}>
              ▶ {phaseView?.label ?? 'implementação 1/3'}
            </span>
            <button className="pane-close dark-close" onClick={onClose}>
              ×
            </button>
          </div>
          <div className="task-modal-title readonly">{task.title}</div>
          <div className="task-modal-desc readonly">{task.description || 'sem descrição'}</div>
          <div className="lock-note">
            Esta tarefa está vinculada ao pane <b>{livePane.title}</b>. O orquestrador
            conduz esta fase; abra a aba Panes somente se quiser acompanhar o terminal.
          </div>
          {skillUsageLine && (
            <div className="task-skills-line" data-tip={skillUsageTip}>
              ⚡ {skillUsageLine}
            </div>
          )}
        </div>
      </div>,
      document.body
    )
  }

  // Estado de QA sem pane vivo: após reinício/crash, o orquestrador precisa
  // retomar somente este gate. Não confundir o QA da tarefa com a fila serial
  // de integração da missão, que só existe depois de o plano inteiro concluir.
  if (task.status === 'qa') {
    return createPortal(
      <div className="overlay" onClick={onClose}>
        <div
          className="task-modal"
          style={{ ['--dept-hue' as string]: deptHueVar(dept.key) }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="task-modal-head">
            <span className="task-dept">
              {dept.icon} {dept.name}
            </span>
            <span className="lock-badge task-phase-badge interrupted">
              ⏸ {phaseView?.label ?? 'QA 3/3 · interrompida'}
            </span>
            <button className="pane-close dark-close" onClick={onClose}>
              ×
            </button>
          </div>
          <div className="task-modal-title readonly">{task.title}</div>
          <div className="task-modal-desc readonly">{task.description || 'sem descrição'}</div>
          {skillUsageLine && (
            <div className="task-skills-line" data-tip={skillUsageTip}>
              ⚡ {skillUsageLine}
            </div>
          )}
          <div className="lock-note">
            Esta tarefa parou no gate de QA. O orquestrador reabre somente a validação
            {task.feedback ? ` (${task.feedback})` : ''}; depois ela conclui ou volta para
            correção. A fila de integração da missão ainda é uma etapa separada.
          </div>
        </div>
      </div>,
      document.body
    )
  }

  // F5.7 — card AUTO (criado pelo orquestrador em modo plano): apenas VISUAL.
  // O usuário acompanha aqui; quem executa, move e corrige é o orquestrador.
  if (task.auto) {
    return createPortal(
      <div className="overlay" onClick={onClose}>
        <div
          className="task-modal"
          style={{ ['--dept-hue' as string]: deptHueVar(dept.key) }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="task-modal-head">
            <span className="task-dept">
              {dept.icon} {dept.name}
            </span>
            {task.type === 'bug' && <span className="type-badge">🐛 bug</span>}
            {phaseView && (
              <span
                className={`lock-badge task-phase-badge phase-${phaseView.phase}${
                  phaseView.interrupted ? ' interrupted' : ''
                }`}
              >
                {phaseView.interrupted ? '⏸' : '▶'} {phaseView.label}
              </span>
            )}
            <span
              className="task-origin"
              data-tip="Card criado e gerido pelo ORQUESTRADOR (plano aprovado) — ele dispara a execução e move o card sozinho"
            >
              ⟡ orquestrador
            </span>
            <button className="pane-close dark-close" onClick={onClose}>
              ×
            </button>
          </div>
          <div className="task-modal-title readonly">{task.title}</div>
          {task.feedback && (
            <div className="task-feedback-block">
              ✗ último feedback: {task.feedback}
              {task.cycles ? ` · ${task.cycles} ciclo(s) automático(s)` : ''}
            </div>
          )}
          <div className="task-modal-desc readonly">{task.description || 'sem descrição'}</div>
          {task.quests && task.quests.length > 0 && (
            <div className="task-quests modal">
              {task.quests.map((q, i) => (
                <div key={i} className="quest-line">
                  ▢ {q}
                </div>
              ))}
            </div>
          )}
          {skillUsageLine && (
            <div className="task-skills-line" data-tip={skillUsageTip}>
              ⚡ {skillUsageLine}
            </div>
          )}
          {task.briefing && (
            <details className="task-briefing">
              <summary>🎯 briefing do orquestrador (prompt literal do executor)</summary>
              <pre>{task.briefing}</pre>
            </details>
          )}
          <div className="lock-note">
            Card do PLANO em modo autônomo — apenas visual: o orquestrador executa, corrige e
            conclui sozinho. Para mudar o rumo, fale com ele no painel da missão (ou pause o
            plano no card ◆).
          </div>
        </div>
      </div>,
      document.body
    )
  }

  return createPortal(
    <div className="overlay" onClick={onClose}>
      <div
        className="task-modal"
        style={{ ['--dept-hue' as string]: deptHueVar(dept.key) }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="task-modal-head">
          <span className="task-dept">
            {dept.icon} {dept.name}
          </span>
          {task.type === 'bug' && <span className="type-badge">🐛 bug</span>}
          {missionTitle && (
            <span className="task-origin" data-tip="Missão dona desta tarefa">
              🚀 {missionTitle}
            </span>
          )}
          {task.origin === 'maestro' && (
            <span className="task-origin" data-tip="Criada pelo Maestro">
              🎯 maestro
            </span>
          )}
          <button className="pane-close dark-close" onClick={onClose}>
            ×
          </button>
        </div>

        <input
          className="task-modal-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        {task.feedback && (
          <div className="task-feedback-block">
            ✗ último feedback de reprovação: {task.feedback}
            {task.cycles ? ` · ${task.cycles} ciclo(s) automático(s) gasto(s)` : ''}
          </div>
        )}
        <textarea
          className="task-modal-desc"
          rows={8}
          placeholder="Descrição, critérios de aceite…"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {task.quests && task.quests.length > 0 && (
          <div className="task-quests modal">
            {task.quests.map((q, i) => (
              <div key={i} className="quest-line">
                ▢ {q}
              </div>
            ))}
          </div>
        )}
        {skillUsageLine && (
          <div className="task-skills-line" data-tip={skillUsageTip}>
            ⚡ {skillUsageLine}
          </div>
        )}
        {task.briefing && (
          <details className="task-briefing">
            <summary>🎯 briefing do Maestro (prompt literal do executor)</summary>
            <pre>{task.briefing}</pre>
          </details>
        )}

        <div className="task-modal-row four">
          <label>
            departamento
            <Select
              value={department}
              options={DEPARTMENTS.map((d) => ({ value: d.key, label: `${d.icon} ${d.name}` }))}
              onChange={(v) => setDepartment(v as Department)}
            />
          </label>
          <label>
            tipo
            <Select
              value={type}
              options={[
                { value: 'feature', label: '✨ feature' },
                { value: 'bug', label: '🐛 bug' }
              ]}
              onChange={(v) => setType(v as TaskType)}
            />
          </label>
          <label>
            esforço
            <Select
              value={effort}
              options={[
                { value: 'leve', label: '▽ leve' },
                { value: 'pesada', label: '▲ pesada' }
              ]}
              onChange={(v) => setEffort(v as Task['effort'])}
            />
          </label>
          <label>
            status
            <Select
              value={status}
              options={STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
              onChange={(v) => setStatus(v as Task['status'])}
            />
          </label>
        </div>

        <div className="task-modal-exec">
          <span className="exec-label">
            {policyApplied ? 'política do dept:' : 'sem política — manual:'}
          </span>
          <Select
            value={execSeat}
            placeholder={seats.length === 0 ? 'adicione uma conta nas configurações' : undefined}
            options={seats.map((s) => ({ value: s.id, label: s.name, cli: s.cli }))}
            onChange={(v) => {
              setExecSeat(v)
              setExecModel('')
            }}
          />
          <ModelSelect
            cli={seats.find((s) => s.id === execSeat)?.cli ?? 'claude'}
            seatId={execSeat || undefined}
            value={execModel}
            disabled={!execSeat}
            onChange={(m) => {
              setExecModel(m)
              setExecEffort('')
            }}
          />
          <Select
            className="exec-effort"
            tip="Effort (raciocínio) do executor"
            value={execEffort}
            disabled={!execSeat}
            options={[
              { value: '', label: 'effort padrão' },
              ...effortOpts.map((ef) => ({ value: ef, label: ef }))
            ]}
            onChange={(v) => setExecEffort(v)}
          />
          <button className="btn" disabled={!execSeat} onClick={execute}>
            ▶ executar
          </button>
        </div>

        <div className="task-modal-actions">
          <button
            className="btn ghost danger"
            onClick={() => {
              void removeTask(task.id)
              onClose()
            }}
          >
            excluir
          </button>
          <span className="task-modal-meta">
            criada em {new Date(task.createdAt).toLocaleDateString('pt-BR')}
          </span>
          <button className="btn accent" disabled={!dirty || !title.trim()} onClick={() => void save()}>
            salvar
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function DeptStats({
  dept,
  tasks,
  paneCount
}: {
  dept: Department
  tasks: Task[]
  paneCount: number
}): React.JSX.Element {
  const d = DEPT_BY_KEY[dept]
  const count = (st: TaskStatus): number => tasks.filter((t) => t.status === st).length
  const total = tasks.length
  const done = count('done')
  const pct = total ? Math.round((done / total) * 100) : 0
  const blocks = 24
  const filled = Math.round((pct / 100) * blocks)

  return (
    <div className="dept-view" style={{ ['--dept-hue' as string]: deptHueVar(d.key) }}>
      <div className="dept-head">
        <span className="dept-big-icon">{d.icon}</span>
        <div className="dept-id">
          <div className="dept-big-name">/{d.name}</div>
          <div className="dept-desc">{d.desc}</div>
        </div>
        <div className="dept-progress">
          <span className="dept-bar">
            <b>{'▓'.repeat(filled)}</b>
            {'░'.repeat(blocks - filled)}
          </span>
          <span className="dept-pct">
            {done}/{total} concluídas · {pct}%
          </span>
        </div>
      </div>
      <div className="dept-stats">
        <div className="stat-tile hot">
          <span className="stat-num">{count('execucao')}</span>
          <span className="stat-label">em execução</span>
        </div>
        <div className="stat-tile">
          <span className="stat-num">{count('backlog')}</span>
          <span className="stat-label">no backlog</span>
        </div>
        <div className="stat-tile">
          <span className="stat-num">{count('qa')}</span>
          <span className="stat-label">no QA</span>
        </div>
        <div className="stat-tile ok">
          <span className="stat-num">{done}</span>
          <span className="stat-label">concluídas</span>
        </div>
        <div className="stat-tile">
          <span className="stat-num">{paneCount}</span>
          <span className="stat-label">panes abertos</span>
        </div>
      </div>
      <div className="dept-skills">
        <span className="dept-skills-label">skills do departamento:</span>
        {d.skills.map((s) => (
          <span key={s} className="skill-chip">
            /{s}
          </span>
        ))}
        <span className="dept-skills-note">
          política de modelos e skills configuram-se na aba ✦ geral
        </span>
      </div>
    </div>
  )
}

interface Props {
  projectId: string
}

const NO_PANES: never[] = []
const NO_ASK_QUESTIONS: Record<string, string> = {}

export default function Board({ projectId }: Props): React.JSX.Element {
  const tasks = useStore((s) => s.tasks)
  const seats = useStore((s) => s.seats)
  const settings = useStore((s) => s.settings)
  const missions = useStore((s) => s.missions)
  const loadMissions = useStore((s) => s.loadMissions)
  const archiveMission = useStore((s) => s.archiveMission)
  const deleteMission = useStore((s) => s.deleteMission)
  const integrateMission = useStore((s) => s.integrateMission)
  const missionTab = useStore((s) => s.missionTabByProject[projectId] ?? null)
  const setMissionTab = useStore((s) => s.setMissionTab)
  // /estudar em andamento NESTE projeto (o boolean global punha spinner e
  // botão travado no PM de OUTRO universo)
  const maestroBusy = useStore((s) => s.surveyBusyByProject[projectId] ?? false)
  const maestroModel = useStore((s) => s.maestroModel)
  const maestroEffort = useStore((s) => s.maestroEffort)
  const panes = useStore((s) => s.panesByProject[projectId] ?? NO_PANES)
  const closePane = useStore((s) => s.closePane)
  const paneCount = panes.length
  const loadTasks = useStore((s) => s.loadTasks)
  const createTask = useStore((s) => s.createTask)
  const updateTask = useStore((s) => s.updateTask)
  const removeTask = useStore((s) => s.removeTask)
  const surveyMaestro = useStore((s) => s.surveyMaestro)
  const loadMaestroLog = useStore((s) => s.loadMaestroLog)
  const maestroSeatId = useStore((s) => s.maestroSeatId)
  const setSeatGateOpen = useStore((s) => s.setSeatGateOpen)
  const paneStats = useStore((s) => s.paneStats)
  const paneEffort = useStore((s) => s.paneEffort)
  const paneModel = useStore((s) => s.paneModel)
  const paneActivity = useStore((s) => s.paneActivity)
  const resetPaneTelemetry = useStore((s) => s.resetPaneTelemetry)
  // Vários universos ficam montados ao mesmo tempo (troca estilo Discord) —
  // efeitos que mexem em estado global/processos só rodam no projeto ATIVO.
  const isActive = useStore((s) => s.openProjectId === projectId)
  const projectFlow = useStore((s) => s.projects.find((p) => p.id === projectId))
  const greenfieldLocked =
    projectFlow?.mode === 'greenfield' && projectFlow.planStatus !== 'done'

  const [deptFilter, setDeptFilter] = useState<Department | 'all'>('all')
  const [doneExpanded, setDoneExpanded] = useState(false)
  const [quickTitle, setQuickTitle] = useState('')
  const [quickDept, setQuickDept] = useState<Department>('front')
  const [quickError, setQuickError] = useState<string | null>(null)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  // Spec do pane TUI do Maestro/PM (terminal real; persona + MCP + resume).
  const [maestroSpec, setMaestroSpec] = useState<MaestroPaneSpec | null>(null)
  // Specs dos ORQUESTRADORES por missão — panes ficam MONTADOS (display:none
  // fora da aba ativa), como tudo que roda CLI de verdade.
  const [missionSpecs, setMissionSpecs] = useState<Record<string, MaestroPaneSpec>>({})
  const [newMissionOpen, setNewMissionOpen] = useState(false)
  // Troca de CONTA do orquestrador no meio da missão (limite estourou):
  // mesmo CLI = a conversa é transplantada junto (sondas 2026-08-04).
  const [reseatOpen, setReseatOpen] = useState(false)
  const [testServerOpen, setTestServerOpen] = useState(false)
  // Perguntas do Maestro/orquestrador dirigidas ao USUÁRIO (tool ask_user):
  // a aba correspondente pulsa até ser aberta. O estado agora é GLOBAL no
  // store (App assina e reidrata) — rail e abas do universo pulsam de
  // qualquer lugar; aqui só se lê e se dispensa ao visitar.
  const askPulse = useStore((s) => s.askQuestions[projectId] ?? NO_ASK_QUESTIONS)
  const clearAskQuestion = useStore((s) => s.clearAskQuestion)
  const uniTab = useStore((s) => s.universeTabByProject[projectId] ?? 'board')
  // Missão criada pelo PM aguardando a escolha do orquestrador no modal;
  // "depois" marca dismissed e o placeholder da aba da missão reabre.
  const [pendingOrchDismissed, setPendingOrchDismissed] = useState<Record<string, boolean>>({})
  const pendingOrchMission = missions.find((m) => m.status === 'ativa' && m.pendingOrchestrator)
  // "nova missão a partir deste card" (card done de missão já integrada):
  // abre o MESMO modal com título/goal pré-preenchidos referenciando o card.
  const [missionPrefill, setMissionPrefill] = useState<{ title: string; goal: string } | null>(
    null
  )
  const [missionMsg, setMissionMsg] = useState<string | null>(null)
  useEffect(() => {
    if (!greenfieldLocked) return
    setNewMissionOpen(false)
    setMissionPrefill(null)
  }, [greenfieldLocked])
  const [missionCopied, setMissionCopied] = useState(false)
  // Confirmação de exclusão NOSSA (window.confirm nativo do Electron quebra o
  // foco da janela no Windows — cliques morriam depois dele — e era feio).
  const [confirmDeleteMission, setConfirmDeleteMission] = useState(false)
  // Versões do app (chip ◈ na missão + tooltip das abas).
  const [versionsList, setVersionsList] = useState<Version[]>([])
  useEffect(() => {
    if (!window.synkora.backlog) return
    void window.synkora.backlog.listVersions(projectId).then(setVersionsList)
    return window.synkora.backlog.onChanged((pid) => {
      if (pid === projectId) void window.synkora.backlog.listVersions(projectId).then(setVersionsList)
    })
  }, [projectId])
  const versionName = (vid?: string): string | undefined =>
    vid ? versionsList.find((v) => v.id === vid)?.name : undefined

  const winRef = useRef<HTMLDivElement>(null)
  const maestroTerminalRef = useRef<HTMLDivElement>(null)
  const [maestroTerminalBox, setMaestroTerminalBox] = useState({ w: 0, h: 0 })
  const resizeCleanupRef = useRef<(() => void) | null>(null)

  // Pointer capture normalmente entrega pointerup, mas troca de projeto,
  // unmount ou perda da janela podem interromper o gesto antes disso.
  useLayoutEffect(
    () => () => {
      resizeCleanupRef.current?.()
    },
    []
  )

  // A largura salva é uma PREFERÊNCIA, não a largura física obrigatória. O CSS
  // limita essa preferência pela caixa real do board e sempre reserva espaço
  // para a coluna clara. Quando a janela volta a crescer, a preferência reaparece
  // sem ter sido sobrescrita pelo tamanho temporariamente menor.
  useLayoutEffect(() => {
    const el = winRef.current
    if (!el) return
    const saved = Number(localStorage.getItem('synkora.maestroWidth.v3'))
    const half = Math.round(window.innerWidth * 0.5)
    const preferred = Number.isFinite(saved) && saved >= 420 ? saved : half
    el.style.setProperty('--maestro-preferred-width', `${Math.round(preferred)}px`)
  }, [])

  // Maestro e orquestradores usam exatamente a mesma geometria responsiva do
  // canvas. Medir o corpo real evita reaproveitar 120x30 quando a coluna esta
  // estreita (causa da borda direita cortada nos TUIs oficiais).
  useLayoutEffect(() => {
    const el = maestroTerminalRef.current
    if (!el) return
    const measure = (): void => {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      // O ref aponta para .maestro-body. A caixa útil do host fica DENTRO do
      // padding; usar o border-box superestimava as colunas em panes estreitos.
      const width =
        rect.width - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
      const height =
        rect.height - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0)
      if (width <= 0 || height <= 0) return
      setMaestroTerminalBox((current) =>
        Math.round(current.w) === Math.round(width) &&
        Math.round(current.h) === Math.round(height)
          ? current
          : { w: width, h: height }
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [])

  // Arrasto da alça do Maestro. Delta INVERTIDO de propósito (row-reverse:
  // arrastar para a ESQUERDA alarga). Mesma clamp do layout inicial; a
  // persistência ocorre só no fim DESTE gesto. Um ResizeObserver gravava também
  // a largura temporariamente limitada por 72vw ao encolher a janela, fazendo o
  // Maestro continuar pequeno quando a janela crescia de novo.
  function onResizeStart(e: React.PointerEvent<HTMLDivElement>): void {
    const el = winRef.current
    if (!el || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
    // Um segundo pointerdown não pode deixar listeners/trava do gesto anterior.
    resizeCleanupRef.current?.()
    e.preventDefault()
    const startX = e.clientX
    const startW = el.offsetWidth
    const handle = e.currentTarget
    const pointerId = e.pointerId
    try {
      handle.setPointerCapture(pointerId)
    } catch {
      return
    }
    handle.classList.add('dragging')
    let raf = 0
    let next = startW
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      const available = el.parentElement?.clientWidth ?? window.innerWidth
      // Reserva 420px para o conteúdo e 12px para o gap. O limite usa a caixa
      // real do split (sem rail/paddings), nunca a largura global da janela.
      const max = Math.max(420, Math.min(available * 0.72, available - 432))
      next = Math.min(Math.max(startW + (startX - ev.clientX), 420), max)
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        el.style.setProperty('--maestro-preferred-width', `${next}px`)
      })
    }
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      el.style.setProperty('--maestro-preferred-width', `${next}px`)
      handle.classList.remove('dragging')
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onCancel)
      handle.removeEventListener('lostpointercapture', onLostCapture)
      window.removeEventListener('blur', onCancel)
      if (handle.hasPointerCapture(pointerId)) {
        try {
          handle.releasePointerCapture(pointerId)
        } catch {
          // A captura já pode ter sido liberada pelo browser.
        }
      }
      if (next >= 420) localStorage.setItem('synkora.maestroWidth.v3', String(Math.round(next)))
      if (resizeCleanupRef.current === finish) resizeCleanupRef.current = null
    }
    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId === pointerId) finish()
    }
    const onCancel = (ev?: Event): void => {
      if (ev && 'pointerId' in ev && (ev as PointerEvent).pointerId !== pointerId) return
      finish()
    }
    const onLostCapture = (ev: PointerEvent): void => {
      if (ev.pointerId === pointerId) finish()
    }
    resizeCleanupRef.current = finish
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onCancel)
    handle.addEventListener('lostpointercapture', onLostCapture)
    window.addEventListener('blur', onCancel)
  }

  const loadPolicies = useStore((s) => s.loadPolicies)
  const taskAttention = useStore((s) => s.taskAttention)
  const maestroBypass = useStore((s) => s.maestroBypass)
  const toggleBypass = useStore((s) => s.toggleBypass)
  const sensitiveBypassOk = useStore((s) => s.sensitiveBypassOk)
  const toggleSensitiveBypass = useStore((s) => s.toggleSensitiveBypass)

  useEffect(() => {
    void loadTasks(projectId)
    void loadMaestroLog(projectId)
    void loadPolicies(projectId)
    void loadMissions(projectId)
  }, [projectId, loadTasks, loadMaestroLog, loadPolicies, loadMissions])

  // Missões mudaram no main (criada pelo PM, integrada, sync…) → recarrega.
  useEffect(() => {
    if (!window.synkora.missions) return
    return window.synkora.missions.onChanged((pid) => {
      if (pid === projectId && useStore.getState().openProjectId === projectId) {
        void loadMissions(projectId)
        void loadTasks(projectId)
      }
    })
  }, [projectId, loadMissions, loadTasks])

  // O main avisa quando o Maestro cria tarefas — o board ATIVO recarrega na
  // hora (boards escondidos não podem sobrescrever o estado global de tasks).
  useEffect(() => {
    return window.synkora.tasks.onChanged((pid) => {
      if (pid === projectId && useStore.getState().openProjectId === projectId)
        void loadTasks(projectId)
    })
  }, [projectId, loadTasks])

  const maestroStateLoaded = useStore((s) => s.maestroStateLoaded)

  // Seat escolhido (gate) → busca a spec do pane TUI do Maestro. Só busca
  // quando FALTA spec ou o seat mudou: paneSpec RESPAWNA o processo no main,
  // e o pane vivo deve sobreviver à troca de projeto (universos montados).
  // GUARD maestroStateLoaded: ao VOLTAR para o projeto, o maestroSeatId
  // global ainda é o do projeto anterior por um instante — sem o guard o
  // Board achava que o seat mudou e respawnava o Maestro à toa.
  const maestroSpecBump = useStore((s) => s.maestroSpecBumpByProject[projectId] ?? 0)
  const lastBumpRef = useRef(maestroSpecBump)
  useEffect(() => {
    if (!isActive || !maestroStateLoaded) return
    let stale = false
    if (!maestroSeatId) {
      setMaestroSpec(null)
      return
    }
    // bump = usuário redefiniu seat/modelo/effort no gate (o main já matou o
    // pane) — busca spec nova mesmo com o seat igual
    const bumped = lastBumpRef.current !== maestroSpecBump
    if (maestroSpec && maestroSpec.seatId === maestroSeatId && !bumped) return
    lastBumpRef.current = maestroSpecBump
    void window.synkora.maestro.paneSpec(projectId).then((spec) => {
      if (!stale) setMaestroSpec(spec)
    })
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, maestroSeatId, isActive, maestroStateLoaded, maestroSpec?.seatId, maestroSpecBump])

  // Missão selecionada (aba). SÓ missão VIVA vale: com selMission apontando para
  // uma missão concluída/arquivada a aba 🚀 dela desaparecia da fila mas nenhuma
  // aba ficava ativa — a página ✦ geral não renderizava e o terminal do PM
  // continuava montado e ESCONDIDO, deixando o usuário sem terminal nenhum.
  const liveMissions = missions.filter(
    (m) => m.projectId === projectId && (m.status === 'ativa' || m.status === 'integrando')
  )
  const selMission = missionTab ? liveMissions.find((m) => m.id === missionTab) : undefined

  // ask_user: reidrata as pendências deste projeto (a assinatura de perguntas
  // novas é GLOBAL, no App). Visitar a aba marca a pergunta como vista — mas
  // SÓ com o board realmente VISÍVEL: um Board montado-e-escondido (outro
  // projeto aberto, ou usuário na aba Panes) dispensava a pergunta sem
  // ninguém ver (bug achado na varredura do mapa, 2026-08-06).
  const loadAskQuestions = useStore((s) => s.loadAskQuestions)
  useEffect(() => {
    void loadAskQuestions(projectId)
  }, [projectId, loadAskQuestions])
  useEffect(() => {
    if (!isActive || uniTab !== 'board') return
    const key = selMission?.id ?? 'geral'
    if (!askPulse[key]) return
    void window.synkora.maestro.questionSeen?.(projectId, key)
    clearAskQuestion(projectId, key)
  }, [projectId, selMission?.id, askPulse, isActive, uniTab, clearAskQuestion])
  // Rede de segurança do ask_user (heurística, melhor esforço): pane de
  // PM/orquestrador AQUIETADO com a última linha terminando em "?" e a aba
  // escondida = provavelmente esperando o dono. Falso positivo custa um pulso
  // discreto; visitar a aba dispensa AQUELA pergunta (linha igual não re-pulsa).
  const paneLastLines = useStore((s) => s.paneLastLines)
  const [dismissedQ, setDismissedQ] = useState<Record<string, string>>({})
  const heurPulse = useMemo(() => {
    const out: Record<string, string> = {}
    const check = (paneId: string, key: string): void => {
      const lines = paneLastLines[paneId]
      if (!lines?.length) return
      const last = [...lines].reverse().find((l) => l.trim())?.trim()
      if (!last || !last.endsWith('?')) return
      if (paneActivity[paneId] === 'run') return
      if (dismissedQ[key] === last) return
      out[key] = last
    }
    check(`maestro-${projectId}`, 'geral')
    for (const m of liveMissions) check(`maestro-${projectId}--${m.id}`, m.id)
    return out
  }, [paneLastLines, paneActivity, dismissedQ, projectId, liveMissions])
  useEffect(() => {
    const key = selMission?.id ?? 'geral'
    if (heurPulse[key]) setDismissedQ((p) => ({ ...p, [key]: heurPulse[key] }))
  }, [selMission?.id, heurPulse])
  // ask_user (tool) tem prioridade sobre a heurística no rótulo do tooltip
  const tabPulse = { ...heurPulse, ...askPulse }

  // Orquestradores rodam EM SEGUNDO PLANO desde a criação da missão (decisão
  // do usuário): TODA missão viva do projeto ativo ganha spec/pane na hora —
  // trocar de aba já encontra o orquestrador pronto. paneSpec RESPAWNA o
  // processo, então só busca quando FALTA; a trava de voo evita o fetch duplo
  // (o efeito redispara enquanto o 1º resolve — dava banner duplicado).
  const missionSpecInFlight = useRef<Set<string>>(new Set())
  // Mortes recentes por missão: pane que morre NO SPAWN virava loop infinito
  // de respawn (33 ciclos em 02/08 — persona acima do teto de argv do
  // Windows). 3 mortes em 30s = para de ressuscitar e avisa; o merge-falhou
  // legítimo (mortes com minutos de intervalo) nunca atinge a janela.
  const missionDeaths = useRef<Record<string, number[]>>({})
  const [missionHalted, setMissionHalted] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (!isActive || !window.synkora.missions) return
    for (const m of missions) {
      if (m.status !== 'ativa' && m.status !== 'integrando') continue
      // aguardando o modal de escolha do orquestrador — o paneSpec recusaria
      if (m.pendingOrchestrator) continue
      const current = missionSpecs[m.id]
      if (current && paneActivity[current.paneId] === 'dead') {
        // Um merge pode falhar depois da pré-checagem e depois de o Windows
        // exigir o fechamento do processo que segurava o worktree. Soltar a
        // spec força um orquestrador novo a nascer para executar a decisão do
        // Maestro; branch, transcript e fila continuam preservados.
        const now = Date.now()
        const deaths = (missionDeaths.current[m.id] ??= [])
        deaths.push(now)
        while (deaths.length > 5) deaths.shift()
        if (deaths.filter((t) => now - t < 30_000).length >= 3) {
          setMissionHalted((prev) => (prev[m.id] ? prev : { ...prev, [m.id]: true }))
        }
        resetPaneTelemetry(current.paneId)
        setMissionSpecs((prev) => {
          if (prev[m.id]?.paneId !== current.paneId) return prev
          const next = { ...prev }
          delete next[m.id]
          return next
        })
        continue
      }
      // Integração em voo: o main fechou o pane DE PROPÓSITO antes do merge
      // (um cwd no worktree travaria a limpeza — caso real M02d 06/08) e o
      // paneSpec recusaria de qualquer forma. O respawn volta sozinho no
      // desfecho: falha → 'ativa' + missions:changed; sucesso → 'concluida'.
      if (m.status === 'integrando') continue
      if (missionHalted[m.id]) continue
      if (current || missionSpecInFlight.current.has(m.id)) continue
      const mid = m.id
      missionSpecInFlight.current.add(mid)
      void window.synkora.missions
        .paneSpec(projectId, mid)
        .then((spec) => {
          if (spec) setMissionSpecs((prev) => ({ ...prev, [mid]: spec }))
        })
        .finally(() => missionSpecInFlight.current.delete(mid))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, isActive, missions, missionSpecs, paneActivity, missionHalted, resetPaneTelemetry])

  // Missão concluída/arquivada → o main já matou o pane do orquestrador;
  // solta a spec para o slot sumir. ATENÇÃO: missão AUSENTE da lista NÃO
  // conta — `missions` é global e vira a lista de OUTRO projeto quando o
  // usuário troca de universo (apagar aqui matava o PTY e causava o respawn
  // ao voltar).
  useEffect(() => {
    setMissionSpecs((prev) => {
      let changed = false
      const next = { ...prev }
      for (const id of Object.keys(next)) {
        const m = missions.find((x) => x.id === id)
        if (m && (m.status === 'concluida' || m.status === 'arquivada')) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [missions])

  // Missão saiu de VIVA (integrada/arquivada) com a aba dela aberta → volta para
  // ✦ geral. Sem isso a aba 🚀 desaparecia da fila e nenhuma aba ficava ativa:
  // board sem conteúdo e sem terminal. Guardas: só no projeto ATIVO e só quando
  // a missão EXISTE na lista e mudou de status — `missions` é global e vira a
  // lista de OUTRO projeto ao trocar de universo (resetar nesse instante apagaria
  // a seleção do usuário, mesmo risco do efeito acima).
  useEffect(() => {
    if (!isActive || !missionTab) return
    const m = missions.find((x) => x.id === missionTab)
    if (m && m.status !== 'ativa' && m.status !== 'integrando') setMissionTab(projectId, null)
  }, [isActive, missionTab, missions, projectId, setMissionTab])

  // avisos ficam até o usuário fechar no × (decisão do usuário)
  async function onIntegrate(): Promise<void> {
    if (!selMission) return
    setMissionMsg(await integrateMission(selMission.id))
  }

  // Tarefa travada = há um pane executando ela agora.
  const paneByTask = new Map(panes.filter((p) => p.taskId).map((p) => [p.taskId as string, p]))
  // Tarefa travada = há um pane executando ela AGORA. Pane cujo PROCESSO morreu
  // (/exit, ^C^C, crash, login vencido) não executa mais nada: sem este filtro o
  // card ficava preso para sempre com badge ▶, setas mortas e modal read-only —
  // inclusive depois de o main já tê-lo devolvido ao backlog. Fechar o pane no ×
  // era a única saída, e o usuário não tinha como saber disso.
  const livePaneOf = (taskId: string): Pane | undefined => {
    const p = paneByTask.get(taskId)
    return p && paneActivity[p.id] !== 'dead' ? p : undefined
  }

  const maestroSeat = seats.find((x) => x.id === maestroSeatId)
  const selSpec = selMission ? missionSpecs[selMission.id] : undefined
  const selSeat = selSpec ? seats.find((x) => x.id === selSpec.seatId) : undefined
  const measuredMaestroBox = maestroTerminalBox.w > 0 ? maestroTerminalBox : undefined
  const maestroTerminalFont = settings?.terminalFontSize ?? TERMINAL_DEFAULT_FONT_SIZE
  const maestroTerminalLineHeight =
    settings?.terminalLineHeight ?? TERMINAL_DEFAULT_LINE_HEIGHT
  const maestroTerminalFontFamily =
    settings?.terminalFontFamily ?? TERMINAL_DEFAULT_FONT_FAMILY
  const maestroTerminalFallbackFor = (kind: Pane['kind']): { cols: number; rows: number } =>
    terminalFallbackForHost(
      measuredMaestroBox,
      maestroTerminalFont,
      maestroTerminalLineHeight,
      kind === 'claude' ? TERMINAL_NATIVE_SCROLLBAR_WIDTH : TERMINAL_SCROLLBAR_WIDTH
    )
  const maestroSizeGroup = measuredMaestroBox
    ? `board:${projectId}:${Math.round(measuredMaestroBox.w)}x${Math.round(measuredMaestroBox.h)}:${maestroTerminalFont}:${maestroTerminalLineHeight}:${maestroTerminalFontFamily}`
    : `board:${projectId}:fallback`


  async function quickAdd(): Promise<void> {
    if (!quickTitle.trim()) return
    // Tarefa manual nasce na aba onde foi criada (missão selecionada ou Geral).
    const created = await createTask(projectId, quickDept, quickTitle.trim(), '', selMission?.id)
    if (created) {
      setQuickTitle('')
      setQuickError(null)
    } else {
      setQuickError(
        greenfieldLocked
          ? 'Projeto novo ainda está no plano mestre. Volte ao Maestro e siga a próxima missão indicada.'
          : 'Não foi possível criar a tarefa. Atualize o board e tente novamente.'
      )
    }
  }

  function move(task: Task, delta: number): void {
    const idx = STATUS_ORDER.indexOf(task.status) + delta
    const status = STATUS_ORDER[idx] as TaskStatus | undefined
    if (status) void updateTask(task.id, { status })
  }

  // A aba de missão fatia o board: Geral = tarefas sem missão.
  const missionTasks = tasks.filter((t) =>
    selMission ? t.missionId === selMission.id : !t.missionId
  )
  // F5.7: o card de PLANO é da missão inteira, não de uma função — fica
  // sempre visível (ignora o filtro de dept) e fora das contagens de
  // trabalho. Plano ATIVO (proposto/pausado/em execução) também esconde o
  // quick-add: nessa missão quem cria card é o orquestrador.
  const workTasks = missionTasks.filter((t) => t.kind !== 'plan')
  const missionPlan = selMission
    ? missionTasks.find((t) => t.kind === 'plan' && t.status !== 'done')
    : undefined
  // Integrar só libera com TODAS as tarefas da missão concluídas (o main
  // também bloqueia — aqui é anti-clique acidental).
  const missionAllDone =
    missionTasks.some((t) => t.kind === 'plan' && t.status === 'done') &&
    missionTasks.every((t) => t.status === 'done')
  // Filtro de funções SÓ com card (decisão do usuário): chips das funções
  // presentes no recorte atual; filtro apontando para função que sumiu do
  // recorte cai em "all" sozinho.
  const deptsWithCards = DEPARTMENTS.filter((d) =>
    workTasks.some((t) => t.department === d.key)
  )
  const effFilter =
    deptFilter !== 'all' && deptsWithCards.some((d) => d.key === deptFilter) ? deptFilter : 'all'
  const byDept =
    effFilter === 'all'
      ? missionTasks
      : missionTasks.filter((t) => t.kind === 'plan' || t.department === effFilter)
  const visible = byDept
  // Aba geral virou a casa do PO: kanban só aparece numa MISSÃO (ou se ainda
  // existirem tarefas soltas legadas para não sumir com dado do usuário).
  const showKanban = Boolean(selMission) || missionTasks.length > 0


  return (
    <div className="board">
      {/* Abas de MISSÃO: cada missão tem orquestrador, tarefas e (com git)
          branch próprios. "Geral" = o PM do universo + tarefas soltas. */}
      <div className="mission-bar">
        {/* NAVEGAÇÃO — onde você está trabalhando */}
        <div className="mission-tabs">
          <button
            className={`mission-tab ${!selMission ? 'active' : ''}${tabPulse['geral'] ? ' asking' : ''}`}
            data-tip={
              tabPulse['geral']
                ? `❓ O MAESTRO PERGUNTOU A VOCÊ:\n${tabPulse['geral']}`
                : 'PM do universo: conversa geral, cria missões e tarefas soltas'
            }
            onClick={() => setMissionTab(projectId, null)}
          >
            <span className="mt-glyph">{tabPulse['geral'] ? '❓' : '✦'}</span>
            <span className="mt-label">geral</span>
          </button>
          {liveMissions.map((m) => {
            const count = tasks.filter((t) => t.missionId === m.id && t.kind !== 'plan').length
            const doneCount = tasks.filter(
              (t) => t.missionId === m.id && t.kind !== 'plan' && t.status === 'done'
            ).length
            // Hover ENXUTO (o goal virou briefing gigante escrito pelo PM —
            // despejá-lo aqui cobria a tela): 1ª linha do goal truncada +
            // versão/branch/progresso. O briefing completo vive no plano.
            const goalLine = (m.goal ?? '').split('\n')[0].trim()
            const goalTip =
              goalLine && goalLine !== m.title
                ? goalLine.length > 110
                  ? `${goalLine.slice(0, 110)}…`
                  : goalLine
                : ''
            const metaTip = [
              versionName(m.versionId) ? `◈ ${versionName(m.versionId)}` : '',
              m.branch ?? '',
              integrationQueueLabel(m) ?? '',
              count > 0 ? `▣ ${doneCount}/${count} cards` : ''
            ]
              .filter(Boolean)
              .join(' · ')
            return (
              <button
                key={m.id}
                className={`mission-tab ${selMission?.id === m.id ? 'active' : ''}${
                  m.status === 'integrando' ? ' integrating' : ''
                }${tabPulse[m.id] || m.pendingIntegrationApproval ? ' asking' : ''}`}
                data-tip={
                  tabPulse[m.id]
                    ? `❓ O ORQUESTRADOR PERGUNTOU A VOCÊ:\n${tabPulse[m.id]}`
                    : m.pendingIntegrationApproval
                      ? `⇪ INTEGRAÇÃO AGUARDA SEU AVAL:\no agente pediu para integrar "${m.title}" — abra a missão e confirme no botão ⇪ (nada mergeia sem você)`
                      : [m.title, goalTip, metaTip].filter(Boolean).join('\n')
                }
                onClick={() => setMissionTab(projectId, m.id)}
              >
                <span className="mt-glyph">
                  {tabPulse[m.id] ? '❓' : m.pendingIntegrationApproval ? '⇪' : '🚀'}
                </span>
                <span className="mt-label">{m.title}</span>
                {count > 0 && (
                  <span className="mt-count">
                    {doneCount}/{count}
                  </span>
                )}
                {m.integration && m.integration.state !== 'merging' && (
                  <span
                    className={`mt-queue ${m.integration.state}`}
                    aria-label={integrationQueueLabel(m)}
                  >
                    {m.integration.state === 'blocked'
                      ? m.integration.owner === 'orchestrator'
                        ? '! reparo'
                        : '! Maestro'
                      : m.integration.state === 'sync_required'
                        ? '↻ sync'
                        : `fila #${m.integration.position}`}
                  </span>
                )}
                {m.status === 'integrando' && <span className="mt-merging" aria-hidden="true" />}
              </button>
            )
          })}
          <button
            className="mission-tab add"
            disabled={greenfieldLocked}
            title={
              greenfieldLocked
                ? 'Projeto novo: as missões nascem pelo Maestro, na ordem do plano mestre.'
                : undefined
            }
            data-tip={
              greenfieldLocked
                ? 'Projeto novo: as missões nascem pelo Maestro, na ordem do plano mestre.'
                : 'Nova missão: um fluxo de trabalho com orquestrador e branch próprios'
            }
            onClick={() => {
              if (!greenfieldLocked) setNewMissionOpen(true)
            }}
          >
            <span className="mt-glyph">+</span>
            <span className="mt-label">missão</span>
          </button>
        </div>

        {/* CONTROLE DO UNIVERSO — não é navegação, então mora do outro lado da
            divisória. O bypass é um INTERRUPTOR: ele tem dois estados fixos e
            o usuário precisa saber em qual está sem ler o texto. */}
        <div className="mission-bar-tools">
          <span className="bar-div" aria-hidden="true" />
          <button
            className={`perm-switch ${maestroBypass ? 'bypass' : 'guard'}`}
            role="switch"
            aria-checked={maestroBypass}
            data-tip={
              maestroBypass
                ? 'Permissões em BYPASS: os agentes seguem reto, sem pedir aprovação. Clique para religar as aprovações.'
                : 'Aprovações RELIGADAS: os agentes pedem permissão. Clique para voltar ao fluxo reto (bypass).'
            }
            onClick={() => void toggleBypass(projectId, !maestroBypass)}
          >
            <span className="ps-track">
              <span className="ps-knob">{maestroBypass ? '⏩' : '🛡'}</span>
            </span>
            <span className="ps-text">{maestroBypass ? 'bypass' : 'aprovações'}</span>
          </button>
          {/* Override do DONO para missão SENSÍVEL (classificador de risco):
              sem ele, projeto de domínio fiscal/PII perde o bypass em TODO
              pane escritor. Só faz sentido com bypass ligado. */}
          {maestroBypass && (
            <button
              className={`perm-switch ${sensitiveBypassOk ? 'bypass' : 'guard'}`}
              role="switch"
              aria-checked={sensitiveBypassOk}
              data-tip={
                sensitiveBypassOk
                  ? 'Missões SENSÍVEIS (dados pessoais/fiscais, pagamentos…) também seguem em bypass — sua escolha, auditada na caixa-preta. Clique para voltar à proteção.'
                  : 'Missões classificadas como SENSÍVEIS pedem aprovação mesmo com bypass. Num projeto cujo domínio é fiscal/PII isso trava tudo — clique para liberar o bypass nelas.'
              }
              onClick={() => void toggleSensitiveBypass(projectId, !sensitiveBypassOk)}
            >
              <span className="ps-track">
                <span className="ps-knob">{sensitiveBypassOk ? '⏩' : '🔒'}</span>
              </span>
              <span className="ps-text">{sensitiveBypassOk ? 'sensível ok' : 'sensível'}</span>
            </button>
          )}
        </div>
      </div>

      {missionMsg && (
        <div className="mission-msg">
          {missionMsg}
          <button className="mission-msg-close" data-tip="Fechar aviso" onClick={() => setMissionMsg(null)}>
            ×
          </button>
        </div>
      )}

      {/* Linha principal em row-reverse: o maestro (1º filho) vira COLUNA
          LATERAL DIREITA de altura total; o conteúdo fica à esquerda.
          O Maestro/orquestrador é um PANE CLI DE VERDADE. TODOS ficam
          montados (display:none fora da aba) — trocar de aba não mata nada. */}
      <div className="board-main">
      {/* Só a cabeça da fila fica bloqueada durante os poucos instantes em que
          o Git altera a branch de destino. Não existe reviewer extra aqui. */}
      {selMission?.status === 'integrando' && (
        <div className="integrating-overlay">
          <div className="integrating-card">
            <span className="spinner" />
            <b>⇪ integrando "{selMission.title}"…</b>
            <span>
              chegou a vez desta missão na fila; o Synkora está juntando a branch dela ao
              destino. A próxima posição só começa depois que esta terminar.
            </span>
          </div>
        </div>
      )}
      <div className="term-window maestro-window" ref={winRef}>
        <PaneChrome
          role={selMission ? 'orquestrador' : 'maestro'}
          kind={selMission ? (selSpec?.kind ?? maestroSeat?.cli ?? 'claude') : (maestroSeat?.cli ?? 'claude')}
          seatName={selMission ? selSeat?.name : maestroSeat?.name}
          // valor VIVO do TUI (pty:model/pty:effort, muda na hora da troca via
          // /model) > configurado
          model={
            selMission
              ? ((selSpec ? paneModel[selSpec.paneId] : undefined) ??
                selSpec?.model ??
                selMission.model)
              : ((maestroSpec ? paneModel[maestroSpec.paneId] : undefined) ??
                maestroModel ??
                undefined)
          }
          effort={
            selMission
              ? ((selSpec ? paneEffort[selSpec.paneId] : undefined) ?? selMission.effort)
              : ((maestroSpec ? paneEffort[maestroSpec.paneId] : undefined) ??
                maestroEffort ??
                undefined)
          }
          // sem repetição: o chip de papel já diz MAESTRO/ORQUESTRADOR — o
          // título é SÓ o nome da missão (PM fica sem título)
          title={selMission ? selMission.title : ''}
          stats={
            selMission
              ? selSpec
                ? (paneStats[selSpec.paneId] ?? ZERO_STATS)
                : undefined
              : maestroSpec
                ? (paneStats[maestroSpec.paneId] ?? ZERO_STATS)
                : undefined
          }
          pinStats={Boolean(selMission)}
          activity={
            selMission
              ? selSpec
                ? paneActivity[selSpec.paneId]
                : undefined
              : maestroSpec
                ? paneActivity[maestroSpec.paneId]
                : undefined
          }
          priorityDetails={
            selMission ? (
              <>
                {selMission.versionId && (
                  <span
                    className="stat-chip version-chip mission-version-chip"
                    data-tip="Versão do app desta missão — ela integra na branch da versão, não na main"
                  >
                    {versionName(selMission.versionId) ?? 'versão'}
                  </span>
                )}
                <button
                  className={`stat-chip model code-chip mission-ref-chip${
                    missionCopied ? ' copied' : ''
                  }`}
                  data-tip={`Código da missão — clique para copiar e enviar ao Maestro: ${selMission.id}${
                    selMission.branch
                      ? ` · branch ${selMission.branch} (base: ${selMission.baseBranch ?? '?'})`
                      : ''
                  }`}
                  aria-label={`Copiar código da missão ${selMission.id}`}
                  onClick={() => {
                    void navigator.clipboard.writeText(selMission.id)
                    setMissionCopied(true)
                    window.setTimeout(() => setMissionCopied(false), 1500)
                  }}
                >
                  {missionCopied ? '✓ copiado' : `#${selMission.id.slice(0, 8)}`}
                </button>
                {selMission.status === 'integrando' && (
                  <span className="pane-task-badge run-running">⇪ integrando…</span>
                )}
                {selMission.integration && selMission.status !== 'integrando' && (
                  <span
                    className={`pane-task-badge integration-${selMission.integration.state}`}
                    data-tip={selMission.integration.lastError}
                  >
                    {selMission.integration.state === 'blocked'
                      ? selMission.integration.owner === 'orchestrator'
                        ? '⚠ reparo do destino pendente'
                        : '⚠ Maestro decidindo'
                      : selMission.integration.state === 'sync_required'
                        ? '↻ sincronizando'
                        : `⇪ fila #${selMission.integration.position}/${selMission.integration.total}`}
                  </span>
                )}
                {selMission.status === 'concluida' && (
                  <span className="pane-task-badge run-done">✓ integrada</span>
                )}
              </>
            ) : undefined
          }
        >
          {!selMission && maestroBusy && <span className="spinner" />}
          {!selMission && (
            <>
              <button
                className="term-btn ghost-dim"
                disabled={maestroBusy || !maestroSeatId}
                data-tip="Mapeia o projeto com um agente dedicado e salva o dossiê em .synkora/CONTEXT.md (o Maestro renasce lendo ele)"
                onClick={() => void surveyMaestro(projectId, maestroSeatId ?? undefined)}
              >
                📚<span className="btn-label">estudar</span>
              </button>
              <button
                className="term-btn ghost-dim"
                data-tip="Trocar o seat do Maestro (reinicia a sessão dele)"
                onClick={() => setSeatGateOpen(true)}
              >
                ⇄<span className="btn-label">seat</span>
              </button>
              <button
                className="term-btn ghost-dim"
                data-tip="Limpar o lixo de .md do .synkora: transcripts de tarefas que não existem mais, arquivos de missões concluídas/excluídas, marcadores e helpers órfãos"
                onClick={() =>
                  void window.synkora.maestro.cleanup(projectId).then(setMissionMsg)
                }
              >
                🧹<span className="btn-label">limpar</span>
              </button>
            </>
          )}
        </PaneChrome>
        <div className="maestro-body maestro-terminal" ref={maestroTerminalRef}>
          {/* PM (Geral) — sempre montado */}
          {/* visibilidade pelo missionTab (per-projeto, nunca stale) e NÃO pelo
              selMission, que depende da lista global assíncrona de missões: ao
              trocar de universo o terminal do PM piscava no lugar do
              orquestrador por um instante */}
          <div
            className={`maestro-slot${missionTab ? '' : ' is-active'}`}
            aria-hidden={missionTab ? true : undefined}
            inert={missionTab ? true : undefined}
          >
            {maestroSpec ? (
              <TerminalPane
                key={`${maestroSpec.seatId}:${maestroSpec.kind}`}
                paneId={maestroSpec.paneId}
                cwd={maestroSpec.cwd}
                kind={maestroSpec.kind}
                projectId={projectId}
                seatId={maestroSpec.seatId}
                model={maestroSpec.model}
                cliArgs={maestroSpec.cliArgs}
                initialPrompt={maestroSpec.initialPrompt}
                appendSystemPrompt={maestroSpec.appendSystemPrompt}
                imagePasteProjectId={projectId}
                fontSize={maestroTerminalFont}
                lineHeight={maestroTerminalLineHeight}
                fontFamily={maestroTerminalFontFamily}
                minCols={terminalMinColsForBox(
                  maestroSpec.kind,
                  maestroTerminalFallbackFor(maestroSpec.kind)
                )}
                minRows={maestroSpec.kind === 'claude' ? 12 : 6}
                fallbackSize={maestroTerminalFallbackFor(maestroSpec.kind)}
                sizeGroup={`${maestroSizeGroup}:${maestroSpec.kind}`}
                voiceLabel="Maestro"
              />
            ) : (
              <div className="maestro-empty">
                // escolha o seat do Maestro para abrir o terminal do orquestrador
              </div>
            )}
          </div>
          {/* Orquestradores das missões já abertas — montados, escondidos */}
          {Object.values(missionSpecs).map((spec) => (
            <div
              key={spec.paneId}
              className={`maestro-slot${spec.missionId === missionTab ? ' is-active' : ''}`}
              aria-hidden={spec.missionId === missionTab ? undefined : true}
              inert={spec.missionId === missionTab ? undefined : true}
            >
              <TerminalPane
                key={`${spec.seatId}:${spec.kind}`}
                paneId={spec.paneId}
                cwd={spec.cwd}
                kind={spec.kind}
                projectId={projectId}
                seatId={spec.seatId}
                model={spec.model}
                cliArgs={spec.cliArgs}
                initialPrompt={spec.initialPrompt}
                appendSystemPrompt={spec.appendSystemPrompt}
                imagePasteProjectId={projectId}
                fontSize={maestroTerminalFont}
                lineHeight={maestroTerminalLineHeight}
                fontFamily={maestroTerminalFontFamily}
                minCols={terminalMinColsForBox(spec.kind, maestroTerminalFallbackFor(spec.kind))}
                minRows={spec.kind === 'claude' ? 12 : 6}
                fallbackSize={maestroTerminalFallbackFor(spec.kind)}
                sizeGroup={`${maestroSizeGroup}:${spec.kind}`}
                voiceLabel={`Orquestrador · ${
                  missions.find((mission) => mission.id === spec.missionId)?.title ?? 'missão'
                }`}
              />
            </div>
          ))}
          {selMission &&
            !missionSpecs[selMission.id] &&
            (selMission.pendingOrchestrator ? (
              <div className="maestro-empty">
                <div style={{ display: 'grid', gap: 10, justifyItems: 'center' }}>
                  <span>// o Maestro criou esta missão — falta escolher o orquestrador</span>
                  <button
                    className="term-btn"
                    onClick={() =>
                      setPendingOrchDismissed((prev) => {
                        const next = { ...prev }
                        delete next[selMission.id]
                        return next
                      })
                    }
                  >
                    ▶ escolher orquestrador
                  </button>
                </div>
              </div>
            ) : missionHalted[selMission.id] ? (
              <div className="maestro-empty">
                <div style={{ display: 'grid', gap: 10, justifyItems: 'center' }}>
                  <span>
                    // o orquestrador desta missão morreu 3× seguidas ao abrir — a causa está no
                    diário da caixa-preta (clis ▾ → ◉ exportar diagnóstico)
                  </span>
                  <button
                    className="term-btn"
                    onClick={() => {
                      missionDeaths.current[selMission.id] = []
                      setMissionHalted((prev) => {
                        const next = { ...prev }
                        delete next[selMission.id]
                        return next
                      })
                    }}
                  >
                    ⟳ tentar de novo
                  </button>
                </div>
              </div>
            ) : (
              <div className="maestro-empty">// abrindo o orquestrador da missão…</div>
            ))}
        </div>
        {/* ÚLTIMO filho de propósito: inserir a alça antes do .maestro-body
            deslocaria os índices dos filhos não-keyados e o React remontaria o
            body → TerminalPane remontado → PTY do Maestro MORTO. */}
        <div className="maestro-resizer" onPointerDown={onResizeStart} />
      </div>

      <div className="board-content">
      {/* Aba GERAL = página de configurações do projeto (identidade + funções) */}
      {!selMission && <ProjectGeneral projectId={projectId} />}

      {(showKanban || selMission) && (
      <div className="dept-filter">
        {showKanban && (
          <>
            <button
              className={`dept-chip ${effFilter === 'all' ? 'active' : ''}`}
              onClick={() => setDeptFilter('all')}
            >
              Todos <span className="dept-count">{missionTasks.length}</span>
            </button>
            {/* SÓ funções com card no recorte atual (decisão do usuário) */}
            {deptsWithCards.map((d) => (
              <button
                key={d.key}
                className={`dept-chip ${effFilter === d.key ? 'active' : ''}`}
                style={{ ['--dept-hue' as string]: deptHueVar(d.key) }}
                onClick={() => setDeptFilter(effFilter === d.key ? 'all' : d.key)}
              >
                {d.icon} {d.name}{' '}
                <span className="dept-count">
                  {missionTasks.filter((t) => t.department === d.key).length}
                </span>
              </button>
            ))}
          </>
        )}
        {/* ações da missão: primeira linha à esquerda; filtros logo abaixo */}
        {selMission && (
          <div className="mission-actions">
            {selMission.status === 'ativa' && !selMission.integration && (
              <button
                className={`btn tiny mission-action-btn mission-integrate${
                  selMission.pendingIntegrationApproval ? ' approve-pending' : ''
                }`}
                disabled={!missionAllDone}
                data-tip={
                  selMission.pendingIntegrationApproval
                    ? 'O agente pediu a integração — o merge SÓ anda com o SEU clique (porteira mecânica)'
                    : missionAllDone
                      ? 'Colocar a missão na fila serial de integração do projeto'
                      : 'Entrar na fila só libera quando TODAS as tarefas da missão estiverem concluídas'
                }
                onClick={() => void onIntegrate()}
              >
                {selMission.pendingIntegrationApproval ? '⇪ aprovar integração' : '⇪ entrar na fila'}
              </button>
            )}
            {selMission.status === 'ativa' && selMission.integration && (
              <button
                className="btn tiny mission-action-btn mission-integrate"
                disabled={
                  selMission.integration.state !== 'sync_required' || !missionAllDone
                }
                data-tip={selMission.integration.lastError ?? integrationQueueLabel(selMission)}
                onClick={() => void onIntegrate()}
              >
                {selMission.integration.state === 'blocked'
                  ? selMission.integration.owner === 'orchestrator'
                    ? '⚠ reparo pendente'
                    : '⚠ Maestro decidindo'
                  : selMission.integration.state === 'sync_required'
                    ? missionAllDone
                      ? '↻ retomar fila'
                      : '↻ sincronizando'
                    : `⇪ fila #${selMission.integration.position}`}
              </button>
            )}
            {selMission.status === 'ativa' && (
              <button
                className="btn tiny mission-action-btn"
                data-tip={
                  'Trocar a CONTA do orquestrador (ex.: limite estourou).\nMesma família de CLI = a conversa vai junto (transplante de sessão).'
                }
                onClick={() => setReseatOpen(true)}
              >
                ⇄ conta
              </button>
            )}
            {selMission.status === 'ativa' &&
              (() => {
                const testPane = panes.find((p) => p.testServer && p.missionId === selMission.id)
                return testPane ? (
                  <button
                    className="btn tiny mission-action-btn mission-archive"
                    data-tip={'Derrubar o servidor de teste desta missão (fecha o pane e a árvore de processos).'}
                    onClick={() => closePane(projectId, testPane.id)}
                  >
                    ■ derrubar teste
                  </button>
                ) : (
                  <button
                    className="btn tiny mission-action-btn"
                    data-tip={
                      'Subir o servidor DESTA branch num terminal para você testar.\nVocê escolhe a porta; fechar o pane (ou este botão) derruba o servidor.'
                    }
                    onClick={() => setTestServerOpen(true)}
                  >
                    ▶ testar
                  </button>
                )
              })()}
            {(selMission.status === 'ativa' || selMission.status === 'arquivada') && (
              <button
                className={`btn tiny mission-action-btn ${
                  selMission.status === 'ativa' ? 'mission-archive' : 'mission-reactivate'
                }`}
                data-tip={
                  selMission.status === 'ativa'
                    ? 'Arquivar a missão (branch preservada)'
                    : 'Reativar a missão'
                }
                onClick={() => void archiveMission(selMission.id, selMission.status === 'ativa')}
              >
                {selMission.status === 'ativa' ? '⊟ arquivar' : '↩ reativar'}
              </button>
            )}
            {selMission.status === 'arquivada' && (
              <button
                className="btn ghost tiny danger"
                data-tip="EXCLUIR a missão arquivada — tarefas e branch dela somem de vez"
                onClick={() => setConfirmDeleteMission(true)}
              >
                🗑 excluir
              </button>
            )}
          </div>
        )}
      </div>
      )}

      {showKanban && effFilter !== 'all' && (
        <DeptStats
          dept={effFilter}
          tasks={visible.filter((t) => t.kind !== 'plan')}
          paneCount={paneCount}
        />
      )}

      {showKanban && (
      <div className={`board-columns${effFilter !== 'all' ? ' focused' : ''}`}>
        {STATUS_ORDER.map((status) => {
          const all = visible.filter((t) => t.status === status)
          // Concluídas: mais recentes primeiro e coluna CAPADA (com centenas
          // de tarefas o board viraria um paredão) — "+N anteriores" expande.
          const isDone = status === 'done'
          // Card de PLANO sempre no TOPO da coluna (é o contrato da missão) —
          // também na Concluída, onde a ordem cronológica o afogava no meio
          // dos cards de dev (pedido do usuário: separação visual).
          const sorted = isDone
            ? [...all].sort(
                (a, b) =>
                  Number(b.kind === 'plan') - Number(a.kind === 'plan') ||
                  b.updatedAt.localeCompare(a.updatedAt)
              )
            : [...all].sort((a, b) => Number(b.kind === 'plan') - Number(a.kind === 'plan'))
          const column = isDone && !doneExpanded ? sorted.slice(0, 20) : sorted
          const hidden = sorted.length - column.length
          return (
            <div key={status} className={`board-col ${status}`}>
              <div className="col-head">
                <span className="col-title">{STATUS_LABEL[status]}</span>
                <span className="col-count">{all.length}</span>
              </div>
              <div className="col-body">
                {column.map((task) => {
                  // F5.7 — card de PLANO: visual próprio, sem controles de
                  // tarefa (aprovação/pausa vivem no modal). Progresso conta
                  // SÓ os cards DESTE plano (planId; card antigo sem carimbo
                  // conta apenas no plano ativo).
                  if (task.kind === 'plan') {
                    const planTasks = workTasks.filter((t) => belongsToPlan(t, task))
                    const planDone = planTasks.filter((t) => t.status === 'done').length
                    const workState = planWorkState(planTasks)
                    const st =
                      task.status === 'backlog'
                        ? task.plan?.approvedAt
                          ? '⏸ pausado — abra para re-aprovar'
                          : '🖐 aguardando sua aprovação'
                        : task.status === 'execucao'
                          ? `${workState ?? '▶ preparando o primeiro card'} · ${planDone}/${
                              planTasks.length || task.plan?.expectedCards || '…'
                            }`
                          : '✓ concluído — conclusão no card'
                    return (
                      <div
                        key={task.id}
                        className={`task-card plan-card clickable${
                          task.status === 'backlog' && !task.plan?.approvedAt ? ' plan-wait' : ''
                        }`}
                        onClick={() => setOpenTaskId(task.id)}
                      >
                        <div className="task-top">
                          <span className="plan-badge">◆ plano da missão</span>
                        </div>
                        <div className="task-title">{task.title}</div>
                        {task.plan && <PlanContract plan={task.plan} compact />}
                        {task.plan && task.plan.lanes.length > 0 && (
                          <div className="plan-lane-chips">
                            {task.plan.lanes.map((l, i) => {
                              const d = DEPT_BY_KEY[l.dept]
                              return (
                                <span
                                  key={i}
                                  className="plan-lane-chip"
                                  style={{ ['--dept-hue' as string]: deptHueVar(d.key) }}
                                  data-tip={`${d.name}${l.model ? ` · ${l.model}` : ''}${l.effort ? ` · ${l.effort}` : ''}${l.notes ? `\n${l.notes}` : ''}`}
                                >
                                  {d.icon} {d.name}
                                </span>
                              )
                            })}
                          </div>
                        )}
                        <div className="plan-state">{st}</div>
                      </div>
                    )
                  }
                  const dept = DEPT_BY_KEY[task.department]
                  const live = livePaneOf(task.id)
                  const phaseView = taskPhaseView(task, live)
                  // atenção de pane morto não pisca mais: ninguém vai responder à
                  // aprovação de um processo encerrado
                  const attention = Boolean(taskAttention[task.id]) && live !== undefined
                  const locked = live !== undefined
                  return (
                    <div
                      key={task.id}
                      className={`task-card clickable${locked ? ' locked' : ''}${attention ? ' needs-perm' : ''}`}
                      style={{ ['--dept-hue' as string]: deptHueVar(dept.key) }}
                      onClick={() => setOpenTaskId(task.id)}
                    >
                      <div className="task-top">
                        <span className="task-dept">
                          {dept.icon} {dept.name}
                        </span>
                        {task.type === 'bug' && <span className="type-badge">🐛</span>}
                        {task.effort === 'pesada' && (
                          <span className="effort-badge" data-tip="Tarefa pesada — modelo forte pela política">
                            ▲
                          </span>
                        )}
                        {(locked || phaseView?.interrupted) && phaseView && (
                          <span
                            className={`lock-badge task-phase-badge phase-${phaseView.phase}${
                              phaseView.interrupted ? ' interrupted' : ''
                            }`}
                            data-tip={
                              phaseView.interrupted
                                ? 'Esta fase foi interrompida; o orquestrador retoma somente daqui'
                                : 'Fase atual — clique no card para ver os detalhes'
                            }
                          >
                            {phaseView.interrupted ? '⏸' : '▶'} {phaseView.label}
                          </span>
                        )}
                        {locked && !phaseView && (
                          <span className="lock-badge" data-tip="Executor rodando — clique para acompanhar">
                            ▶
                          </span>
                        )}
                        {task.auto ? (
                          <span
                            className="task-origin"
                            data-tip="Card do orquestrador (plano aprovado) — apenas visual: ele executa e move sozinho"
                          >
                            ⟡
                          </span>
                        ) : (
                          task.origin === 'maestro' && (
                            <span className="task-origin" data-tip="Criada pelo Maestro">
                              🎯
                            </span>
                          )
                        )}
                        {!task.auto && (
                          <button
                            className="task-remove"
                            data-tip={locked ? 'Excluir (encerra o executor e fecha o pane)' : 'Excluir tarefa'}
                            onClick={(e) => {
                              e.stopPropagation()
                              void removeTask(task.id)
                            }}
                          >
                            ×
                          </button>
                        )}
                      </div>
                      <div className="task-title">{task.title}</div>
                      {task.description && (
                        <div className="task-desc" data-tip={task.description}>
                          {task.description}
                        </div>
                      )}
                      {task.quests && task.quests.length > 0 && (
                        <div className="task-quests">
                          {task.quests.slice(0, 4).map((q, i) => (
                            <div key={i} className="quest-line" data-tip={q}>
                              ▢ {q}
                            </div>
                          ))}
                          {task.quests.length > 4 && (
                            <div className="quest-line more">+{task.quests.length - 4} quests…</div>
                          )}
                        </div>
                      )}
                      {/* metadados da execução — nada de adivinhar */}
                      {(task.runSeat || task.feedback) && (
                        <div className="task-runmeta">
                          {task.runSeat && (
                            <span
                              data-tip={`Executor: seat ${task.runSeat} · modelo ${task.runModel ?? 'padrão'} · política ${task.effort === 'pesada' ? 'pesadas' : 'leves'}${task.cycles ? ` · ${task.cycles} retry(s) de gate` : ''}`}
                            >
                              ⚙ {task.runSeat} · {task.runModel ?? 'padrão'}
                              {task.cycles ? ` · ciclo ${task.cycles}` : ''}
                            </span>
                          )}
                          {task.feedback && task.status === 'backlog' && (
                            <span className="task-feedback" data-tip={task.feedback}>
                              ✗ {task.feedback}
                            </span>
                          )}
                        </div>
                      )}
                      {!task.auto && (
                        <div className="task-actions">
                          <button
                            className="task-move"
                            disabled={locked || status === STATUS_ORDER[0]}
                            onClick={(e) => {
                              e.stopPropagation()
                              move(task, -1)
                            }}
                          >
                            ←
                          </button>
                          <button
                            className="task-move"
                            disabled={locked || status === STATUS_ORDER[STATUS_ORDER.length - 1]}
                            onClick={(e) => {
                              e.stopPropagation()
                              move(task, 1)
                            }}
                          >
                            →
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}

                {isDone && hidden > 0 && (
                  <button className="done-more" onClick={() => setDoneExpanded(true)}>
                    + {hidden} anteriores
                  </button>
                )}
                {isDone && doneExpanded && sorted.length > 20 && (
                  <button className="done-more" onClick={() => setDoneExpanded(false)}>
                    recolher
                  </button>
                )}

                {status === 'backlog' && !selMission && !missionPlan && !greenfieldLocked && (
                  <div className="quick-add">
                    <input
                      placeholder="+ tarefa manual"
                      value={quickTitle}
                      onChange={(e) => {
                        setQuickTitle(e.target.value)
                        setQuickError(null)
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && void quickAdd()}
                    />
                    {quickTitle.trim() && (
                      <div className="quick-add-row">
                        <Select
                          value={quickDept}
                          options={DEPARTMENTS.map((d) => ({
                            value: d.key,
                            label: `${d.icon} ${d.name}`
                          }))}
                          onChange={(v) => setQuickDept(v as Department)}
                        />
                        <button className="btn" onClick={() => void quickAdd()}>
                          Criar
                        </button>
                      </div>
                    )}
                    {quickError && <div className="task-inline-error">{quickError}</div>}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      )}

      </div>
      </div>

      {openTaskId &&
        (() => {
          const task = tasks.find((t) => t.id === openTaskId)
          if (task?.kind === 'plan')
            return (
              <PlanModal
                key={task.updatedAt}
                task={task}
                // SÓ os cards DESTE plano: 2 planos na mesma missão não se
                // misturam (bug real: plano concluído listava os cards em
                // execução do plano seguinte — e cards legados do plano velho
                // vazavam no novo; belongsToPlan corta pelos dois lados).
                workTasks={tasks.filter(
                  (t) =>
                    t.missionId === task.missionId && t.kind !== 'plan' && belongsToPlan(t, task)
                )}
                onClose={() => setOpenTaskId(null)}
              />
            )
          return task ? (
            <TaskModal
              key={task.updatedAt}
              task={task}
              projectId={projectId}
              livePane={livePaneOf(task.id) ?? null}
              missionClosed={
                !!task.missionId &&
                (() => {
                  const m = missions.find((x) => x.id === task.missionId)
                  return !m || m.status === 'concluida' || m.status === 'arquivada'
                })()
              }
              onNewMissionFrom={() => {
                if (greenfieldLocked) {
                  setOpenTaskId(null)
                  setMissionMsg(
                    'Este projeto ainda segue o plano mestre. Peça ao Maestro para revisar o mapa ou abrir a próxima missão planejada.'
                  )
                  return
                }
                const m = missions.find((x) => x.id === task.missionId)
                setMissionPrefill({
                  title: `Ajustar: ${task.title}`.slice(0, 60),
                  goal:
                    `REFERÊNCIA: card "${task.title}"${m ? ` da missão "${m.title}"` : ''} (já integrada na main).\n` +
                    `O que foi feito lá: ${task.description || task.title}\n\n` +
                    `O que ajustar/evoluir agora: (descreva)`
                })
                setNewMissionOpen(true)
              }}
              onClose={() => setOpenTaskId(null)}
            />
          ) : null
        })()}

      {confirmDeleteMission &&
        selMission &&
        createPortal(
          <div className="overlay" onClick={() => setConfirmDeleteMission(false)}>
            <div className="task-modal confirm-modal" onClick={(e) => e.stopPropagation()}>
              <div className="task-modal-head">
                <span className="task-dept">🗑 excluir missão</span>
                <button
                  className="pane-close dark-close"
                  onClick={() => setConfirmDeleteMission(false)}
                >
                  ×
                </button>
              </div>
              <p className="confirm-text">
                Excluir <b>“{selMission.title}”</b> de vez?
              </p>
              <p className="confirm-sub">
                As tarefas da missão{selMission.branch ? ` e a branch ${selMission.branch}` : ''}{' '}
                serão removidas. Não dá para desfazer.
              </p>
              <div className="task-modal-actions">
                <button className="btn ghost" onClick={() => setConfirmDeleteMission(false)}>
                  cancelar
                </button>
                <span className="task-modal-meta" />
                <button
                  className="btn danger-solid"
                  onClick={() => {
                    setConfirmDeleteMission(false)
                    void deleteMission(selMission.id)
                  }}
                >
                  🗑 excluir de vez
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* troca de conta do orquestrador: mesmo modal, campos travados, só
          conta/modelo/effort — mesmo CLI transplanta a conversa junto */}
      {reseatOpen && selMission && selMission.status === 'ativa' && (
        <NewMissionModal
          key={`reseat-${selMission.id}`}
          projectId={projectId}
          reseatMission={selMission}
          onClose={() => setReseatOpen(false)}
        />
      )}

      {/* servidor de teste do dono: sobe a branch da missão num pane shell */}
      {testServerOpen && selMission && (
        <TestServerModal
          projectId={projectId}
          target={{ missionId: selMission.id }}
          label={`missão "${selMission.title.slice(0, 32)}"`}
          onClose={() => setTestServerOpen(false)}
        />
      )}

      {newMissionOpen && !greenfieldLocked && (
        <NewMissionModal
          projectId={projectId}
          initialTitle={missionPrefill?.title}
          initialGoal={missionPrefill?.goal}
          onClose={() => {
            setNewMissionOpen(false)
            setMissionPrefill(null)
          }}
          onCreated={(m) => setMissionTab(projectId, m.id)}
        />
      )}

      {/* Missão criada pelo PM aguardando a escolha do orquestrador: o mesmo
          modal, com título/goal/versão travados — só conta/modelo/effort
          (decisão do usuário, 02/08). "depois" fecha; o placeholder da aba
          da missão reabre. */}
      {isActive && pendingOrchMission && !pendingOrchDismissed[pendingOrchMission.id] && (
        <NewMissionModal
          key={pendingOrchMission.id}
          projectId={projectId}
          confirmMission={pendingOrchMission}
          onClose={() =>
            setPendingOrchDismissed((prev) => ({ ...prev, [pendingOrchMission.id]: true }))
          }
        />
      )}
    </div>
  )
}
