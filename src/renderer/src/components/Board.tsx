import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import RunPanel, { MaestroLine, PermPicker } from './RunPanel'
import {
  useStore,
  type Department,
  type MaestroEvent,
  type Task,
  type TaskStatus,
  type TaskType
} from '../store'
import { DEPARTMENTS, DEPT_BY_KEY, STATUS_LABEL, STATUS_ORDER } from '../departments'

// Janela padrão exibida (modelos 200k) e teto absoluto (Fable/Sonnet 1M).
const CONTEXT_WINDOW = 200_000
const CONTEXT_MAX = 1_000_000

// Comandos do próprio Synkora; todo o resto de "/" vai cru para o painel de
// fundo e executa como no TUI (a lista real vem do handshake do CLI).
const LOCAL_COMMANDS = [
  { name: 'help', description: 'como o painel do Maestro funciona', argumentHint: '' },
  {
    name: 'estudar',
    description: 'mapeia o projeto e salva o dossiê (.synkora/CONTEXT.md)',
    argumentHint: ''
  },
  { name: 'model', description: 'modelos reais do painel — troca ao vivo', argumentHint: '[nome]' },
  { name: 'effort', description: 'nível de raciocínio do modelo atual', argumentHint: '[nível]' },
  {
    name: 'context',
    description: 'sem arg: uso real · <n> fixa o teto do medidor · auto = janela do modelo',
    argumentHint: '[n|auto]'
  },
  { name: 'clear', description: 'reinicia a conversa do Maestro', argumentHint: '' }
]

function ModelSelect({
  cli,
  seatId,
  value,
  onChange,
  disabled
}: {
  cli: 'claude' | 'codex'
  seatId?: string
  value: string
  onChange: (model: string) => void
  disabled?: boolean
}): React.JSX.Element {
  // Lista REAL do seat: claude via handshake do CLI, codex via debug models —
  // cacheada por cli+seat. Nada de digitar modelo na mão, salvo "outro…".
  const key = `${cli}:${seatId ?? ''}`
  const catalog = useStore((s) => s.catalogByCli[key])
  const loadCatalog = useStore((s) => s.loadCatalog)

  useEffect(() => {
    if (!disabled) void loadCatalog(cli, seatId)
  }, [key, cli, seatId, loadCatalog, disabled])

  const loaded = Boolean(catalog)
  const options = [
    { value: '', label: loaded ? 'padrão do seat' : 'carregando modelos…' },
    ...(catalog?.models ?? []).map((m) => ({ value: m.id, label: m.label }))
  ]
  const [custom, setCustom] = useState(false)

  useEffect(() => {
    // Só cai no texto livre quando a lista JÁ carregou e o valor não está nela
    // (valor antigo/manual). Enquanto carrega, mostra o select com o valor.
    setCustom(!disabled && loaded && value !== '' && !options.some((o) => o.value === value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, value, loaded, disabled])

  // Sem seat escolhido não há de onde puxar modelos — trava até escolher.
  if (disabled) {
    return (
      <select className="model-select" disabled>
        <option>— escolha o seat primeiro —</option>
      </select>
    )
  }

  if (custom) {
    return (
      <input
        className="model-input"
        autoFocus
        placeholder="id do modelo…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (!value.trim()) setCustom(false)
        }}
      />
    )
  }
  return (
    <select
      className="model-select"
      value={value}
      onChange={(e) => {
        if (e.target.value === '__custom__') {
          setCustom(true)
          onChange('')
        } else {
          onChange(e.target.value)
        }
      }}
    >
      {/* valor salvo ainda fora da lista (carregando): opção provisória para
          o select não renderizar vazio */}
      {value !== '' && !options.some((o) => o.value === value) && (
        <option value={value}>{value}</option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      <option value="__custom__">outro…</option>
    </select>
  )
}

function fmtK(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}

function CtxMeter({
  tokens,
  limit,
  window
}: {
  tokens: number | null
  limit: number | null
  window: number | null
}): React.JSX.Element | null {
  // Teto: override manual (/context <n>) > janela REAL do modelo > 200k.
  const cap = limit ?? window ?? CONTEXT_WINDOW
  if (tokens === null && limit === null && window === null) return null
  const used = tokens ?? 0
  const pct = Math.min(100, Math.round((used / cap) * 100))
  const blocks = 10
  const filled = Math.max(pct > 0 ? 1 : 0, Math.round((pct / 100) * blocks))
  const level = pct >= 75 ? 'crit' : pct >= 45 ? 'warn' : 'ok'
  const capSource = limit
    ? 'seu limite manual — /context auto volta ao automático'
    : window
      ? 'janela real do modelo atual'
      : 'padrão 200k (janela chega no 1º turno)'
  return (
    <span
      className={`ctx-meter ${level}`}
      title={`contexto da sessão: ~${fmtK(used)} de ${fmtK(cap)} (${capSource}) · /context <n> fixa um teto · /clear zera`}
    >
      ctx <b>{'▓'.repeat(filled)}</b>
      {'░'.repeat(blocks - filled)} {fmtK(used)}/{fmtK(cap)} · {pct}%
    </span>
  )
}

function TaskModal({
  task,
  projectId,
  lockedByPane,
  onClose
}: {
  task: Task
  projectId: string
  lockedByPane: string | null
  onClose: () => void
}): React.JSX.Element {
  const updateTask = useStore((s) => s.updateTask)
  const removeTask = useStore((s) => s.removeTask)
  const seats = useStore((s) => s.seats)
  const policies = useStore((s) => s.policies)
  const run = useStore((s) => s.taskRuns[task.id])
  const runTask = useStore((s) => s.runTask)
  const handoffRun = useStore((s) => s.handoffRun)

  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [department, setDepartment] = useState<Department>(task.department)
  const [type, setType] = useState<TaskType>(task.type)
  const [effort, setEffort] = useState(task.effort)
  const [status, setStatus] = useState(task.status)

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
  const policyApplied = Boolean(slot?.seatId)

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
    void runTask(projectId, task.id, seat.id, execModel.trim() || undefined)
    onClose()
  }

  // Execução em andamento (ou terminada e ainda aberta): o modal é o espelho
  // do executor — tudo que ele faz aparece aqui, aprovações incluídas.
  if (run) {
    const statusBadge =
      run.status === 'running'
        ? run.phase === 'qa'
          ? '🔎 QA validando'
          : run.phase === 'review'
            ? '🧐 em revisão'
            : '▶ executando'
        : run.status === 'done'
          ? '✓ concluída'
          : '✗ falhou'
    return createPortal(
      <div className="overlay" onClick={onClose}>
        <div
          className="task-modal run-modal"
          style={{ ['--dept-hue' as string]: dept.hue }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="task-modal-head">
            <span className="task-dept">
              {dept.icon} {dept.name}
            </span>
            <span className={`lock-badge run-${run.status}`}>{statusBadge}</span>
            <button
              className="btn ghost"
              title="Assumir no TERMINAL DE VERDADE: abre o CLI na mesma conversa, dentro do worktree — digite e use / à vontade (o pipeline automático para)"
              onClick={() => {
                void handoffRun(projectId, task.id)
                onClose()
              }}
            >
              ▣ terminal
            </button>
            <button className="pane-close dark-close" onClick={onClose}>
              ×
            </button>
          </div>
          <div className="task-modal-title readonly">{task.title}</div>
          <RunPanel taskId={task.id} />
        </div>
      </div>,
      document.body
    )
  }

  if (lockedByPane) {
    return createPortal(
      <div className="overlay" onClick={onClose}>
        <div
          className="task-modal"
          style={{ ['--dept-hue' as string]: dept.hue }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="task-modal-head">
            <span className="task-dept">
              {dept.icon} {dept.name}
            </span>
            <span className="lock-badge">▶ em execução</span>
            <button className="pane-close dark-close" onClick={onClose}>
              ×
            </button>
          </div>
          <div className="task-modal-title readonly">{task.title}</div>
          <div className="task-modal-desc readonly">{task.description || 'sem descrição'}</div>
          <div className="lock-note">
            Esta tarefa está vinculada ao pane <b>{lockedByPane}</b> — ajustes vão direto nele.
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
        style={{ ['--dept-hue' as string]: dept.hue }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="task-modal-head">
          <span className="task-dept">
            {dept.icon} {dept.name}
          </span>
          {task.type === 'bug' && <span className="type-badge">🐛 bug</span>}
          {task.origin === 'maestro' && (
            <span className="task-origin" title="Criada pelo Maestro">
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

        <div className="task-modal-row four">
          <label>
            departamento
            <select
              value={department}
              onChange={(e) => setDepartment(e.target.value as Department)}
            >
              {DEPARTMENTS.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.icon} {d.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            tipo
            <select value={type} onChange={(e) => setType(e.target.value as TaskType)}>
              <option value="feature">✨ feature</option>
              <option value="bug">🐛 bug</option>
            </select>
          </label>
          <label>
            esforço
            <select
              value={effort}
              onChange={(e) => setEffort(e.target.value as Task['effort'])}
            >
              <option value="leve">▽ leve</option>
              <option value="pesada">▲ pesada</option>
            </select>
          </label>
          <label>
            status
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as Task['status'])}
            >
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="task-modal-exec">
          <span className="exec-label">
            {policyApplied ? 'política do dept:' : 'sem política — manual:'}
          </span>
          <select
            value={execSeat}
            onChange={(e) => {
              setExecSeat(e.target.value)
              setExecModel('')
            }}
          >
            {seats.length === 0 && <option value="">crie um seat na home</option>}
            {seats.map((s) => (
              <option key={s.id} value={s.id}>
                {s.cli === 'claude' ? '✦' : '⌁'} {s.name}
              </option>
            ))}
          </select>
          <ModelSelect
            cli={seats.find((s) => s.id === execSeat)?.cli ?? 'claude'}
            seatId={execSeat || undefined}
            value={execModel}
            disabled={!execSeat}
            onChange={setExecModel}
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

function PolicyRow({
  label,
  slot,
  onChange
}: {
  label: string
  slot: { seatId: string; model: string } | undefined
  onChange: (slot: { seatId: string; model: string }) => void
}): React.JSX.Element {
  const seats = useStore((s) => s.seats)
  // Estado local evita corrida: alterar seat e modelo em sequência não pode
  // sobrescrever um com o valor antigo do outro vindo do store.
  const [seatId, setSeatId] = useState(slot?.seatId ?? '')
  const [model, setModel] = useState(slot?.model ?? '')

  useEffect(() => {
    setSeatId(slot?.seatId ?? '')
    setModel(slot?.model ?? '')
  }, [slot?.seatId, slot?.model])

  return (
    <div className="policy-row">
      <span className="policy-label">{label}</span>
      <select
        value={seatId}
        onChange={(e) => {
          // Trocar de seat zera o modelo — a lista é do CLI do seat novo.
          setSeatId(e.target.value)
          setModel('')
          onChange({ seatId: e.target.value, model: '' })
        }}
      >
        <option value="">— seat —</option>
        {seats.map((s) => (
          <option key={s.id} value={s.id}>
            {s.cli === 'claude' ? '✦' : '⌁'} {s.name}
          </option>
        ))}
      </select>
      <ModelSelect
        cli={seats.find((s) => s.id === seatId)?.cli ?? 'claude'}
        seatId={seatId || undefined}
        value={model}
        disabled={!seatId}
        onChange={(m) => {
          setModel(m)
          onChange({ seatId, model: m })
        }}
      />
    </div>
  )
}

function DeptStats({
  dept,
  tasks,
  paneCount,
  projectId
}: {
  dept: Department
  tasks: Task[]
  paneCount: number
  projectId: string
}): React.JSX.Element {
  const d = DEPT_BY_KEY[dept]
  const policies = useStore((s) => s.policies)
  const setPolicy = useStore((s) => s.setPolicy)
  const policy = policies[dept]
  const count = (st: TaskStatus): number => tasks.filter((t) => t.status === st).length
  const total = tasks.length
  const done = count('done')
  const pct = total ? Math.round((done / total) * 100) : 0
  const blocks = 24
  const filled = Math.round((pct / 100) * blocks)

  return (
    <div className="dept-view" style={{ ['--dept-hue' as string]: d.hue }}>
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
          <span className="stat-num">{count('analise')}</span>
          <span className="stat-label">em análise</span>
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
      </div>
      <div className="dept-policy">
        <span className="dept-skills-label" title="Quem executa cada peso de tarefa — o Maestro classifica o peso, sua política decide o executor">
          política de modelos:
        </span>
        <PolicyRow
          label="▲ pesadas"
          slot={policy?.heavy}
          onChange={(slot) => void setPolicy(projectId, dept, { ...policy, heavy: slot })}
        />
        <PolicyRow
          label="▽ leves"
          slot={policy?.light}
          onChange={(slot) => void setPolicy(projectId, dept, { ...policy, light: slot })}
        />
      </div>
    </div>
  )
}

interface Props {
  projectId: string
}

const NO_PANES: never[] = []

export default function Board({ projectId }: Props): React.JSX.Element {
  const tasks = useStore((s) => s.tasks)
  const seats = useStore((s) => s.seats)
  const maestroBusy = useStore((s) => s.maestroBusy)
  const maestroLog = useStore((s) => s.maestroLog)
  const maestroCtx = useStore((s) => s.maestroCtx)
  const maestroCtxLimit = useStore((s) => s.maestroCtxLimit)
  const maestroCtxWindow = useStore((s) => s.maestroCtxWindow)
  const maestroStream = useStore((s) => s.maestroStream)
  const maestroThinking = useStore((s) => s.maestroThinking)
  const maestroPerm = useStore((s) => s.maestroPerm)
  const answerMaestroPerm = useStore((s) => s.answerMaestroPerm)
  const interruptMaestro = useStore((s) => s.interruptMaestro)
  const setMaestroCtxLimit = useStore((s) => s.setMaestroCtxLimit)
  const panes = useStore((s) => s.panesByProject[projectId] ?? NO_PANES)
  const paneCount = panes.length
  const loadTasks = useStore((s) => s.loadTasks)
  const createTask = useStore((s) => s.createTask)
  const updateTask = useStore((s) => s.updateTask)
  const removeTask = useStore((s) => s.removeTask)
  const sendMaestro = useStore((s) => s.sendMaestro)
  const surveyMaestro = useStore((s) => s.surveyMaestro)
  const appendMaestroEvent = useStore((s) => s.appendMaestroEvent)
  const clearMaestroLog = useStore((s) => s.clearMaestroLog)
  const loadMaestroLog = useStore((s) => s.loadMaestroLog)

  const [request, setRequest] = useState('')
  const [seatId, setSeatId] = useState('')
  const [composerOpen, setComposerOpen] = useState(false)
  const [picker, setPicker] = useState<{
    kind: 'model' | 'effort'
    title: string
    options: { value: string; label: string; desc?: string; current?: boolean }[]
    index: number
  } | null>(null)
  const [sugIndex, setSugIndex] = useState(0)
  const [sugHidden, setSugHidden] = useState(false)
  const [deptFilter, setDeptFilter] = useState<Department | 'all'>('all')
  const [quickTitle, setQuickTitle] = useState('')
  const [quickDept, setQuickDept] = useState<Department>('front')
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)

  const logRef = useRef<HTMLDivElement>(null)
  const winRef = useRef<HTMLDivElement>(null)

  // Altura do painel do Maestro persiste entre projetos/sessões: aplica a
  // salva no mount e grava (com debounce) a cada redimensionada do usuário.
  useEffect(() => {
    const el = winRef.current
    if (!el) return
    const saved = Number(localStorage.getItem('synkora.maestroHeight'))
    if (Number.isFinite(saved) && saved >= 280) {
      el.style.height = `${Math.min(saved, Math.round(window.innerHeight * 0.82))}px`
    }
    let timer: number | undefined
    const obs = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (el.offsetHeight >= 280) {
          localStorage.setItem('synkora.maestroHeight', String(el.offsetHeight))
        }
      }, 300)
    })
    obs.observe(el)
    return () => {
      obs.disconnect()
      window.clearTimeout(timer)
    }
  }, [])

  const loadPolicies = useStore((s) => s.loadPolicies)
  const maestroModel = useStore((s) => s.maestroModel)
  const maestroEffort = useStore((s) => s.maestroEffort)
  const maestroCaps = useStore((s) => s.maestroCaps)
  const maestroCapsLoading = useStore((s) => s.maestroCapsLoading)
  const loadMaestroCaps = useStore((s) => s.loadMaestroCaps)

  const taskRuns = useStore((s) => s.taskRuns)
  const loadTaskRuns = useStore((s) => s.loadTaskRuns)
  const taskAttention = useStore((s) => s.taskAttention)
  const maestroAutopilot = useStore((s) => s.maestroAutopilot)
  const toggleAutopilot = useStore((s) => s.toggleAutopilot)

  useEffect(() => {
    void loadTasks(projectId)
    void loadMaestroLog(projectId)
    void loadPolicies(projectId)
    void loadTaskRuns(projectId)
  }, [projectId, loadTasks, loadMaestroLog, loadPolicies, loadTaskRuns])

  // O main avisa quando o Maestro cria tarefas — o board recarrega na hora.
  useEffect(() => {
    return window.synkora.tasks.onChanged((pid) => {
      if (pid === projectId) void loadTasks(projectId)
    })
  }, [projectId, loadTasks])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [maestroLog, maestroStream, maestroThinking])

  // Sem "claude padrão": o Maestro sempre roda num seat seu (Claude ou Codex).
  useEffect(() => {
    if (!seatId && seats.length > 0) {
      setSeatId((seats.find((x) => x.cli === 'claude') ?? seats[0]).id)
    }
  }, [seatId, seats])

  // Tarefa travada = há um pane executando ela agora.
  const paneByTask = new Map(panes.filter((p) => p.taskId).map((p) => [p.taskId as string, p]))

  function handleCommand(raw: string): void {
    const [cmd, ...rest] = raw.split(/\s+/)
    const arg = rest.join(' ').trim()

    // Qualquer comando que não é do Synkora vai CRU para o painel de fundo:
    // claude executa o comando slash de verdade; codex mapeia para o RPC real
    // (runSlash no main). Se não existir, o main responde com erro.
    const isLocal = LOCAL_COMMANDS.some((c) => `/${c.name}` === cmd)
    if (!isLocal) {
      void sendMaestro(projectId, raw, seatId)
      return
    }

    appendMaestroEvent({ kind: 'cmd', text: raw })
    switch (cmd) {
      case '/help':
        appendMaestroEvent({
          kind: 'say',
          text: `este chat é o espelho ao vivo de um painel claude rodando de fundo: digite / para ver TODOS os comandos reais dele (↑↓ + Enter) — /usage, /compact, skills, tudo executa de verdade e a saída aparece aqui. Comandos do Synkora: /estudar (dossiê do projeto) · /model (troca ao vivo, modelos reais) · /effort (níveis do modelo atual) · /context <n> (limite do medidor; sem número mostra o uso real) · /clear (reinicia a conversa) · ⏹ parar interrompe o turno.${maestroCaps ? ` O painel tem ${maestroCaps.commands.length} comandos disponíveis.` : ''}`
        })
        break
      case '/estudar':
        void surveyMaestro(projectId, seatId || undefined)
        break
      case '/clear':
        clearMaestroLog()
        void window.synkora.maestro.reset(projectId)
        appendMaestroEvent({ kind: 'ok', text: 'conversa reiniciada' })
        break
      case '/model':
        if (arg) {
          void window.synkora.maestro
            .setModel(projectId, arg)
            .then(() => loadMaestroLog(projectId))
        } else {
          // Espelho do seletor do TUI: modelos REAIS do painel de fundo
          // (claude: handshake initialize; codex: model/list), com descrição
          // e ✓ no atual. No claude a troca é ao vivo (set_model); no codex
          // vira override por turno.
          void (async () => {
            const caps = await loadMaestroCaps(projectId, seatId || undefined)
            if (!caps || caps.models.length === 0) {
              appendMaestroEvent({
                kind: 'err',
                text: 'painel de fundo indisponível — não deu para listar os modelos'
              })
              return
            }
            const hasDefault = caps.models.some((m) => m.value === 'default')
            const current = maestroModel ?? (hasDefault ? 'default' : '')
            const options = [
              ...(hasDefault
                ? []
                : [{ value: '', label: 'padrão do seat', current: !maestroModel }]),
              ...caps.models.map((m) => ({
                value: m.value,
                label: m.displayName,
                desc: m.description,
                current: m.value === current
              }))
            ]
            setPicker({
              kind: 'model',
              title: 'modelo do painel — sessão preservada',
              options,
              index: Math.max(0, options.findIndex((o) => o.current))
            })
          })()
        }
        break
      case '/effort':
        if (arg) {
          void window.synkora.maestro
            .setEffort(projectId, arg)
            .then(() => loadMaestroLog(projectId))
        } else {
          // Níveis de effort do MODELO ATUAL, direto do painel de fundo
          // (inclusive "não suportado", como o TUI mostra para o Haiku).
          void (async () => {
            const caps = await loadMaestroCaps(projectId, seatId || undefined)
            const current = maestroModel ?? 'default'
            const model =
              caps?.models.find((m) => m.value === current) ??
              (maestroModel ? undefined : caps?.models[0])
            if (model && model.supportsEffort === false) {
              appendMaestroEvent({
                kind: 'say',
                text: `effort não é suportado para ${model.displayName} — troque de modelo com /model`
              })
              return
            }
            const levels = model?.supportedEffortLevels?.length
              ? model.supportedEffortLevels
              : (
                  await window.synkora.catalog.get(
                    selectedSeat?.cli ?? 'claude',
                    seatId || undefined
                  )
                ).efforts
            setPicker({
              kind: 'effort',
              title: `effort de ${model?.displayName ?? 'modelo atual'}`,
              options: [
                { value: '', label: 'padrão do modelo', current: !maestroEffort },
                ...levels.map((ef) => ({ value: ef, label: ef, current: ef === maestroEffort }))
              ],
              index: 0
            })
          })()
        }
        break
      case '/context': {
        if (!arg) {
          // Sem argumento: o /context REAL do painel (uso por categoria).
          if (selectedSeat?.cli === 'claude') {
            void sendMaestro(projectId, '/context', seatId)
          } else {
            appendMaestroEvent({
              kind: 'say',
              text: `teto atual: ${maestroCtxLimit ? `${fmtK(maestroCtxLimit)} (manual)` : maestroCtxWindow ? `${fmtK(maestroCtxWindow)} (janela real do modelo)` : `${fmtK(CONTEXT_WINDOW)} (padrão)`} · /context <n> fixa · /context auto volta ao automático`
            })
          }
          break
        }
        if (arg.toLowerCase() === 'auto') {
          setMaestroCtxLimit(null)
          void window.synkora.maestro.setContextLimit(projectId, 0)
          break
        }
        const m = arg.match(/^(\d+)\s*k?$/i)
        const parsed = m ? Number(m[1]) * (/k$/i.test(arg.trim()) ? 1000 : 1) : NaN
        if (!Number.isFinite(parsed) || parsed < 10_000) {
          appendMaestroEvent({
            kind: 'err',
            text: 'uso: /context <n> fixa o teto (ex.: /context 100k, mín. 10k) · /context auto usa a janela do modelo'
          })
          break
        }
        const limit = Math.min(parsed, CONTEXT_MAX)
        if (limit < parsed) {
          appendMaestroEvent({
            kind: 'log',
            tag: 'maestro',
            text: `teto absoluto é ${fmtK(CONTEXT_MAX)} — limitando a isso`
          })
        }
        setMaestroCtxLimit(limit)
        void window.synkora.maestro.setContextLimit(projectId, limit)
        break
      }
    }
  }

  async function onPasteImage(e: React.ClipboardEvent): Promise<void> {
    const hasImg = Array.from(e.clipboardData.items).some((i) => i.type.startsWith('image/'))
    if (!hasImg) return
    e.preventDefault()
    const path = await window.synkora.clipboard.saveImage(projectId)
    if (path) {
      setRequest((r) => `${r}${r && !r.endsWith('\n') ? '\n' : ''}(veja a imagem: ${path})\n`)
      setComposerOpen(true)
      appendMaestroEvent({
        kind: 'log',
        tag: 'maestro',
        text: `imagem anexada: ${path.split(/[\\/]/).pop()}`
      })
    }
  }

  const selectedSeat = seats.find((x) => x.id === seatId)

  // Autocomplete de "/" com a lista REAL de comandos do painel de fundo.
  const slashPrefix =
    request.startsWith('/') && !request.includes(' ') && !request.includes('\n')
      ? request.slice(1).toLowerCase()
      : null

  useEffect(() => {
    // Primeiro "/" digitado: busca as caps reais (spawna o painel; sem tokens).
    if (slashPrefix !== null && selectedSeat) {
      void loadMaestroCaps(projectId, seatId || undefined)
    }
  }, [slashPrefix !== null, selectedSeat?.cli, projectId, seatId, loadMaestroCaps]) // eslint-disable-line react-hooks/exhaustive-deps

  const suggestions = useMemo(() => {
    if (slashPrefix === null) return []
    const cliCmds = maestroCaps?.commands ?? []
    const merged = [
      ...LOCAL_COMMANDS,
      ...cliCmds.filter((c) => !LOCAL_COMMANDS.some((l) => l.name === c.name))
    ]
    return merged.filter((c) => c.name.toLowerCase().startsWith(slashPrefix)).slice(0, 12)
  }, [slashPrefix, maestroCaps])

  useEffect(() => {
    setSugIndex(0)
    setSugHidden(false)
  }, [request])

  const showSug = suggestions.length > 0 && !sugHidden && !picker && !maestroPerm

  function choosePicker(value: string): void {
    const kind = picker?.kind ?? 'model'
    setPicker(null)
    const apply =
      kind === 'effort'
        ? window.synkora.maestro.setEffort(projectId, value)
        : window.synkora.maestro.setModel(projectId, value)
    void apply.then(() => loadMaestroLog(projectId))
  }

  // Teclas do seletor de modelo (↑↓ Enter Esc) — capturadas antes do input.
  function pickerKeyDown(e: React.KeyboardEvent): boolean {
    if (!picker) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setPicker((p) =>
        p ? { ...p, index: (p.index + delta + p.options.length) % p.options.length } : p
      )
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choosePicker(picker.options[picker.index].value)
    } else if (e.key === 'Escape') {
      setPicker(null)
    } else {
      return false
    }
    return true
  }

  function runRaw(raw: string): void {
    if (!raw) return
    if (raw.startsWith('/')) {
      handleCommand(raw)
      return
    }
    if (!seatId) {
      appendMaestroEvent({
        kind: 'err',
        text: 'o maestro precisa de um seat — crie um na home'
      })
      return
    }
    void sendMaestro(projectId, raw, seatId)
  }

  async function askMaestro(): Promise<void> {
    const raw = request.trim()
    if (!raw) return
    setRequest('')
    runRaw(raw)
  }

  // Teclas do autocomplete de comandos (↑↓ Tab Enter Esc).
  function sugKeyDown(e: React.KeyboardEvent): boolean {
    if (!showSug) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setSugIndex((i) => (i + delta + suggestions.length) % suggestions.length)
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      setRequest(`/${suggestions[sugIndex].name} `)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const name = suggestions[sugIndex].name
      setRequest('')
      runRaw(`/${name}`)
    } else if (e.key === 'Escape') {
      setSugHidden(true)
    } else {
      return false
    }
    return true
  }

  async function quickAdd(): Promise<void> {
    if (!quickTitle.trim()) return
    await createTask(projectId, quickDept, quickTitle.trim(), '')
    setQuickTitle('')
  }

  function move(task: Task, delta: number): void {
    const idx = STATUS_ORDER.indexOf(task.status) + delta
    const status = STATUS_ORDER[idx] as TaskStatus | undefined
    if (status) void updateTask(task.id, { status })
  }

  const visible = deptFilter === 'all' ? tasks : tasks.filter((t) => t.department === deptFilter)

  return (
    <div className="board">
      <div className="term-window maestro-window" ref={winRef}>
        <div className="term-titlebar">
          <span className="dots">
            <i />
            <i />
            <i />
          </span>
          <span className="term-title">maestro — run</span>
          <select
            className="maestro-seat titlebar-seat"
            value={seatId}
            disabled={maestroBusy}
            onChange={(e) => setSeatId(e.target.value)}
            title="Seat que o Maestro usa"
          >
            {seats.length === 0 && <option value="">sem seats</option>}
            {seats.map((s) => (
              <option key={s.id} value={s.id}>
                {s.cli === 'claude' ? '✦' : '⌁'} {s.name}
              </option>
            ))}
          </select>
          <span
            className="maestro-status"
            title="Modelo e effort atuais do Maestro — /model e /effort mudam"
          >
            [{maestroModel ?? 'padrão'} · {maestroEffort ?? 'effort padrão'}]
          </span>
          <CtxMeter tokens={maestroCtx} limit={maestroCtxLimit} window={maestroCtxWindow} />
          {maestroBusy && <span className="spinner" />}
        </div>
        <div className="maestro-body">
          <div className="maestro-log" ref={logRef}>
            {maestroLog.length === 0 && !maestroBusy && (
              <div className="m-line muted">
                // converse com o maestro: tire dúvidas, peça features · /estudar faz ele
                mapear o projeto · /help para comandos
              </div>
            )}
            {maestroLog.map((evt, i) => (
              <MaestroLine key={i} evt={evt} />
            ))}
            {maestroStream && (
              <div className="m-line say">
                <span className="say-tag">maestro&gt;</span>{' '}
                {maestroStream.split('<tasks>')[0]}
                <span className="stream-cursor">▍</span>
              </div>
            )}
            {maestroBusy && !maestroStream && !maestroPerm && (
              <div className="m-line muted blink">
                {maestroThinking ? 'pensando… ▍' : '▍'}
              </div>
            )}
          </div>
          {maestroPerm && (
            <PermPicker
              perm={maestroPerm}
              onChoose={(choice) => void answerMaestroPerm(projectId, choice)}
            />
          )}
          {picker && (
            <div className="model-picker">
              <div className="m-line muted">// {picker.title} — ↑↓ e Enter · Esc cancela</div>
              {picker.options.map((o, i) => (
                <button
                  key={o.value || '_default'}
                  className={`picker-item${i === picker.index ? ' active' : ''}`}
                  onClick={() => choosePicker(o.value)}
                  onMouseEnter={() => setPicker((p) => (p ? { ...p, index: i } : p))}
                >
                  {i === picker.index ? '❯ ' : '  '}
                  {o.label}
                  {o.current ? ' ✓' : ''}
                  {o.desc && <span className="sug-desc"> · {o.desc}</span>}
                </button>
              ))}
            </div>
          )}
          {showSug && (
            <div className="model-picker cmd-suggest">
              <div className="m-line muted">
                // comandos — ↑↓ · Tab completa · Enter roda · Esc fecha
                {maestroCapsLoading ? ' · carregando a lista real do painel…' : ''}
              </div>
              {suggestions.map((c, i) => (
                <button
                  key={c.name}
                  className={`picker-item${i === sugIndex ? ' active' : ''}`}
                  onClick={() => {
                    setRequest('')
                    runRaw(`/${c.name}`)
                  }}
                  onMouseEnter={() => setSugIndex(i)}
                >
                  {i === sugIndex ? '❯ ' : '  '}/{c.name}
                  {c.argumentHint ? <span className="sug-hint"> {c.argumentHint}</span> : null}
                  {c.description && (
                    <span className="sug-desc">
                      {' '}
                      · {c.description.length > 90 ? c.description.slice(0, 90) + '…' : c.description}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className={`maestro-prompt${composerOpen ? ' expanded' : ''}`}>
            <span className="prompt-char">$</span>
            {composerOpen ? (
              <textarea
                className="maestro-composer"
                autoFocus
                rows={7}
                placeholder={
                  maestroBusy
                    ? 'turno em andamento — Ctrl+Enter manda a instrução para ele (steering)'
                    : 'prompt grande: cole textos, caminhos de imagens/arquivos… (Ctrl+Enter envia · Shift+Tab volta)'
                }
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                onPaste={(e) => void onPasteImage(e)}
                onKeyDown={(e) => {
                  if (pickerKeyDown(e)) return
                  if (sugKeyDown(e)) return
                  if (e.key === 'Enter' && e.ctrlKey) void askMaestro()
                  if (e.key === 'Tab' && e.shiftKey) {
                    e.preventDefault()
                    setComposerOpen(false)
                  }
                }}
              />
            ) : (
              <input
                className="maestro-input"
                placeholder={
                  maestroBusy
                    ? 'turno em andamento — Enter manda a instrução para ele (steering)'
                    : 'converse com o maestro… (/help · Shift+Tab expande)'
                }
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                onPaste={(e) => void onPasteImage(e)}
                onKeyDown={(e) => {
                  if (pickerKeyDown(e)) return
                  if (sugKeyDown(e)) return
                  if (e.key === 'Enter') void askMaestro()
                  if (e.key === 'Tab' && e.shiftKey) {
                    e.preventDefault()
                    setComposerOpen(true)
                  }
                }}
              />
            )}
            <button
              className="term-btn ghost-dim"
              title={composerOpen ? 'Reduzir (Shift+Tab)' : 'Expandir compositor (Shift+Tab)'}
              onClick={() => setComposerOpen((v) => !v)}
            >
              {composerOpen ? '⌄' : '⤢'}
            </button>
            {maestroBusy && (
              <button
                className="term-btn ghost-dim"
                title="Interrompe o turno atual do painel de fundo"
                onClick={() => void interruptMaestro(projectId)}
              >
                ⏹ parar
              </button>
            )}
            <button
              className="term-btn"
              disabled={!request.trim()}
              title={maestroBusy ? 'Manda a instrução para o turno em andamento (steering)' : undefined}
              onClick={() => void askMaestro()}
            >
              [ enviar ]
            </button>
          </div>
        </div>
      </div>

      <div className="dept-filter">
        <button
          className={`dept-chip ${deptFilter === 'all' ? 'active' : ''}`}
          onClick={() => setDeptFilter('all')}
        >
          Todos <span className="dept-count">{tasks.length}</span>
        </button>
        {DEPARTMENTS.map((d) => (
          <button
            key={d.key}
            className={`dept-chip ${deptFilter === d.key ? 'active' : ''}`}
            style={{ ['--dept-hue' as string]: d.hue }}
            onClick={() => setDeptFilter(deptFilter === d.key ? 'all' : d.key)}
          >
            {d.icon} {d.name}{' '}
            <span className="dept-count">
              {tasks.filter((t) => t.department === d.key).length}
            </span>
          </button>
        ))}
        <button
          className={`dept-chip harness-chip ${maestroAutopilot ? 'active' : ''}`}
          title={
            maestroAutopilot
              ? 'Harness automático LIGADO: tarefas do backlog com política são despachadas sozinhas (dev → revisão → QA → merge). Clique para desligar.'
              : 'Ligar o harness automático: o backlog com política roda sozinho pelo pipeline dev → revisão → QA → merge.'
          }
          onClick={() => void toggleAutopilot(projectId, !maestroAutopilot)}
        >
          🤖 harness {maestroAutopilot ? 'auto' : 'manual'}
        </button>
      </div>

      {deptFilter !== 'all' && (
        <DeptStats
          dept={deptFilter}
          tasks={visible}
          paneCount={paneCount}
          projectId={projectId}
        />
      )}

      <div className={`board-columns${deptFilter !== 'all' ? ' focused' : ''}`}>
        {STATUS_ORDER.map((status) => {
          const column = visible.filter((t) => t.status === status)
          return (
            <div key={status} className={`board-col ${status}`}>
              <div className="col-head">
                <span className="col-title">{STATUS_LABEL[status]}</span>
                <span className="col-count">{column.length}</span>
              </div>
              <div className="col-body">
                {column.map((task) => {
                  const dept = DEPT_BY_KEY[task.department]
                  const run = taskRuns[task.id]
                  const attention = Boolean(run?.perm) || Boolean(taskAttention[task.id])
                  const locked = paneByTask.has(task.id) || run?.status === 'running'
                  return (
                    <div
                      key={task.id}
                      className={`task-card clickable${locked ? ' locked' : ''}${attention ? ' needs-perm' : ''}`}
                      style={{ ['--dept-hue' as string]: dept.hue }}
                      onClick={() => setOpenTaskId(task.id)}
                    >
                      <div className="task-top">
                        <span className="task-dept">
                          {dept.icon} {dept.name}
                        </span>
                        {task.type === 'bug' && <span className="type-badge">🐛</span>}
                        {task.effort === 'pesada' && (
                          <span className="effort-badge" title="Tarefa pesada — modelo forte pela política">
                            ▲
                          </span>
                        )}
                        {attention && (
                          <span
                            className="perm-badge"
                            title="O executor está pedindo aprovação — abra o pane e responda"
                          >
                            🖐
                          </span>
                        )}
                        {locked && (
                          <span className="lock-badge" title="Executor rodando — clique para acompanhar">
                            ▶
                          </span>
                        )}
                        {task.origin === 'maestro' && (
                          <span className="task-origin" title="Criada pelo Maestro">
                            🎯
                          </span>
                        )}
                        {!locked && (
                          <button
                            className="task-remove"
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
                        <div className="task-desc" title={task.description}>
                          {task.description}
                        </div>
                      )}
                      {/* metadados da execução — nada de adivinhar */}
                      {(task.runSeat || task.feedback) && (
                        <div className="task-runmeta">
                          {task.runSeat && (
                            <span
                              title={`Executor: seat ${task.runSeat} · modelo ${task.runModel ?? 'padrão'} · política ${task.effort === 'pesada' ? 'pesadas' : 'leves'}${task.cycles ? ` · ${task.cycles} retry(s) de gate` : ''}`}
                            >
                              ⚙ {task.runSeat} · {task.runModel ?? 'padrão'}
                              {task.cycles ? ` · ciclo ${task.cycles}` : ''}
                            </span>
                          )}
                          {task.feedback && task.status === 'analise' && (
                            <span className="task-feedback" title={task.feedback}>
                              ✗ {task.feedback}
                            </span>
                          )}
                        </div>
                      )}
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
                    </div>
                  )
                })}

                {status === 'backlog' && (
                  <div className="quick-add">
                    <input
                      placeholder="+ tarefa manual"
                      value={quickTitle}
                      onChange={(e) => setQuickTitle(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && void quickAdd()}
                    />
                    {quickTitle.trim() && (
                      <div className="quick-add-row">
                        <select
                          value={quickDept}
                          onChange={(e) => setQuickDept(e.target.value as Department)}
                        >
                          {DEPARTMENTS.map((d) => (
                            <option key={d.key} value={d.key}>
                              {d.icon} {d.name}
                            </option>
                          ))}
                        </select>
                        <button className="btn" onClick={() => void quickAdd()}>
                          Criar
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {openTaskId &&
        (() => {
          const task = tasks.find((t) => t.id === openTaskId)
          return task ? (
            <TaskModal
              key={task.updatedAt}
              task={task}
              projectId={projectId}
              lockedByPane={paneByTask.get(task.id)?.title ?? null}
              onClose={() => setOpenTaskId(null)}
            />
          ) : null
        })()}
    </div>
  )
}
