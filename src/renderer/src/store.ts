import { create } from 'zustand'

export interface Project {
  id: string
  name: string
  path: string
  createdAt: string
}

export type SeatCli = 'claude' | 'codex'
export type SeatStatus = 'logado' | 'pendente'

export interface Seat {
  id: string
  name: string
  cli: SeatCli
  createdAt: string
  status: SeatStatus
  configDir: string
}

export type PaneKind = 'shell' | 'claude' | 'codex'

export type Department = 'front' | 'back' | 'qa' | 'design' | 'research'
export type TaskStatus = 'backlog' | 'analise' | 'execucao' | 'qa' | 'done'
export type TaskType = 'feature' | 'bug'
export type TaskEffort = 'leve' | 'pesada'

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
  runSeat?: string
  runModel?: string
  cycles?: number
  feedback?: string
}

export interface PolicySlot {
  seatId: string
  model: string
}

export interface DeptPolicy {
  heavy?: PolicySlot
  light?: PolicySlot
}

export type ProjectPolicies = Partial<Record<Department, DeptPolicy>>

export interface CatalogModel {
  id: string
  label: string
  efforts?: string[]
  defaultEffort?: string
}

export interface Catalog {
  models: CatalogModel[]
  efforts: string[]
}

export interface MaestroEvent {
  kind: 'cmd' | 'log' | 'ok' | 'err' | 'say' | 'tool' | 'out' | 'ask'
  tag?: Department | 'maestro'
  text: string
  detail?: string
}

export type PermissionChoice = 'allow' | 'allow-always' | 'deny'

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
}

export interface MaestroCaps {
  commands: CliCommand[]
  models: CliModel[]
  account?: { email?: string; subscriptionType?: string }
}

export interface MaestroPermRequest {
  requestId: string
  toolName: string
  description: string
  inputPretty: string
  reason?: string
  canAlways: boolean
}

export type MaestroLiveEvent =
  | { type: 'delta'; text: string }
  | { type: 'flush' }
  | { type: 'thinking' }
  | ({ type: 'permission' } & MaestroPermRequest)
  | { type: 'permission-cancel'; requestId: string }
  | { type: 'turn-end'; status?: 'done' | 'error' }
  | { type: 'phase'; phase: 'dev' | 'review' | 'qa' }
  | { type: 'exit' }

// Execução headless de uma tarefa (F3): espelho do executor no board.
export interface TaskRunView {
  status: 'running' | 'done' | 'error'
  phase: 'dev' | 'review' | 'qa'
  events: MaestroEvent[]
  stream: string
  perm: MaestroPermRequest | null
}

export interface Pane {
  id: string
  kind: PaneKind
  n: number
  title: string
  seatId?: string
  taskId?: string
  initialPrompt?: string
  model?: string
  cliArgs?: string[]
  /** cwd próprio (ex.: worktree da tarefa assumida) — padrão: pasta do projeto */
  cwd?: string
  /** transcript (tee do PTY) — o Maestro lê o que acontece no pane */
  logFile?: string
  /** fase do pipeline que este pane executa (dev/review/qa) */
  role?: 'dev' | 'review' | 'qa'
}

export interface PaneOptions {
  seatId?: string
  taskId?: string
  title?: string
  initialPrompt?: string
  model?: string
  cliArgs?: string[]
  cwd?: string
  logFile?: string
  role?: 'dev' | 'review' | 'qa'
}

export interface DevPaneSpec {
  kind: 'claude' | 'codex'
  seatId: string
  model?: string
  cwd: string
  cliArgs?: string[]
  initialPrompt: string
  logFile: string
  title: string
  role: 'dev' | 'review' | 'qa'
}

interface SynkoraState {
  projects: Project[]
  seats: Seat[]
  openProjectId: string | null
  panesByProject: Record<string, Pane[]>
  tasks: Task[]
  maestroBusy: boolean
  maestroLog: MaestroEvent[]
  maestroCtx: number | null
  maestroCtxLimit: number | null
  maestroCtxWindow: number | null
  maestroSessionId: string | null
  maestroModel: string | null
  maestroEffort: string | null
  maestroStream: string
  maestroThinking: boolean
  maestroPerm: MaestroPermRequest | null
  maestroAutopilot: boolean
  toggleAutopilot: (projectId: string, on: boolean) => Promise<void>
  maestroCaps: MaestroCaps | null
  maestroCapsLoading: boolean
  maestroCapsKey: string | null
  loadMaestroCaps: (projectId: string, seatId?: string) => Promise<MaestroCaps | null>
  taskRuns: Record<string, TaskRunView>
  loadTaskRuns: (projectId: string) => Promise<void>
  runTask: (projectId: string, taskId: string, seatId: string, model?: string) => Promise<void>
  openDevPane: (projectId: string, taskId: string, spec: DevPaneSpec) => void
  closeTaskPane: (projectId: string, taskId: string, role: 'dev' | 'review' | 'qa') => void
  applyTaskFeedback: (projectId: string, taskId: string, text: string, spec: DevPaneSpec) => void
  /** pane de tarefa pediu aprovação → card pulsa até o usuário interagir */
  taskAttention: Record<string, boolean>
  setTaskAttention: (taskId: string) => void
  clearTaskAttention: (taskId: string) => void
  handleRunEvent: (taskId: string, evt: MaestroEvent) => void
  handleRunLive: (taskId: string, evt: MaestroLiveEvent) => void
  answerRunPerm: (taskId: string, choice: PermissionChoice) => Promise<void>
  sendToRun: (taskId: string, message: string) => Promise<void>
  interruptRun: (taskId: string) => Promise<void>
  handoffRun: (projectId: string, taskId: string) => Promise<void>
  closeRun: (taskId: string) => Promise<void>
  handleMaestroLive: (evt: MaestroLiveEvent) => void
  sendMaestro: (projectId: string, message: string, seatId?: string) => Promise<void>
  answerMaestroPerm: (projectId: string, choice: PermissionChoice) => Promise<void>
  interruptMaestro: (projectId: string) => Promise<void>
  setMaestroCtxLimit: (limit: number | null) => void
  appendMaestroEvent: (evt: MaestroEvent) => void
  setMaestroCtx: (tokens: number | null) => void
  clearMaestroLog: () => void
  loadMaestroLog: (projectId: string) => Promise<void>
  surveyMaestro: (projectId: string, seatId?: string) => Promise<void>
  policies: ProjectPolicies
  loadPolicies: (projectId: string) => Promise<void>
  setPolicy: (projectId: string, dept: Department, policy: DeptPolicy) => Promise<void>
  catalogByCli: Record<string, Catalog>
  loadCatalog: (cli: SeatCli, seatId?: string) => Promise<void>

  loadProjects: () => Promise<void>
  createProject: (name: string, path: string) => Promise<void>
  removeProject: (id: string) => Promise<void>
  loadSeats: () => Promise<void>
  createSeat: (name: string, cli: SeatCli) => Promise<void>
  removeSeat: (id: string) => Promise<void>
  openProject: (id: string | null) => void
  universeTab: 'board' | 'panes'
  setUniverseTab: (tab: 'board' | 'panes') => void
  addPane: (projectId: string, kind: PaneKind, opts?: PaneOptions) => void
  closePane: (projectId: string, paneId: string) => void
  loadTasks: (projectId: string) => Promise<void>
  createTask: (
    projectId: string,
    department: Department,
    title: string,
    description: string
  ) => Promise<void>
  updateTask: (id: string, patch: Partial<Task>) => Promise<void>
  removeTask: (id: string) => Promise<void>
}

const KIND_LABEL: Record<PaneKind, string> = {
  shell: 'Terminal',
  claude: 'Claude',
  codex: 'Codex'
}

export const useStore = create<SynkoraState>((set, get) => ({
  projects: [],
  seats: [],
  openProjectId: null,
  panesByProject: {},
  tasks: [],
  maestroBusy: false,
  maestroLog: [],

  maestroCtx: null,
  maestroCtxLimit: null,
  maestroCtxWindow: null,
  maestroSessionId: null,
  maestroModel: null,
  maestroEffort: null,
  maestroStream: '',
  maestroThinking: false,
  maestroPerm: null,
  maestroAutopilot: false,

  toggleAutopilot: async (projectId, on) => {
    set({ maestroAutopilot: on })
    await window.synkora.harness.setAutopilot(projectId, on)
  },
  maestroCaps: null,
  maestroCapsLoading: false,
  maestroCapsKey: null,

  // Comandos/modelos REAIS do painel de fundo (spawna se preciso, sem tokens).
  // Cache por projeto+seat: trocar de seat recarrega do config certo.
  loadMaestroCaps: async (projectId, seatId) => {
    const key = `${projectId}:${seatId ?? ''}`
    const s = get()
    if (s.maestroCaps && s.maestroCapsKey === key) return s.maestroCaps
    if (s.maestroCapsLoading) return null
    set({ maestroCapsLoading: true })
    try {
      const caps = await window.synkora.maestro.capabilities(projectId, seatId)
      set({ maestroCaps: caps, maestroCapsKey: key, maestroCapsLoading: false })
      return caps
    } catch {
      set({ maestroCapsLoading: false })
      return null
    }
  },

  appendMaestroEvent: (evt) => set((s) => ({ maestroLog: [...s.maestroLog, evt] })),
  setMaestroCtx: (tokens) => set({ maestroCtx: tokens }),
  setMaestroCtxLimit: (limit) => set({ maestroCtxLimit: limit }),
  clearMaestroLog: () =>
    set({
      maestroLog: [],
      maestroCtx: null,
      maestroSessionId: null,
      maestroStream: '',
      maestroThinking: false,
      maestroPerm: null
    }),

  // Espelho dos eventos ao vivo do painel de fundo: o chat "bonito" renderiza
  // exatamente o que o processo real está fazendo agora.
  handleMaestroLive: (evt) => {
    switch (evt.type) {
      // delta/thinking/permission também LIGAM o busy: com steering e fila,
      // um turno novo pode começar depois de um turn-end sem send() nosso.
      case 'delta':
        set((s) => ({
          maestroStream: s.maestroStream + evt.text,
          maestroThinking: false,
          maestroBusy: true
        }))
        break
      case 'flush':
        set({ maestroStream: '' })
        break
      case 'thinking':
        set({ maestroThinking: true, maestroBusy: true })
        break
      case 'permission': {
        const { type: _type, ...perm } = evt
        set({ maestroPerm: perm, maestroThinking: false, maestroBusy: true })
        break
      }
      case 'permission-cancel':
        set((s) =>
          s.maestroPerm?.requestId === evt.requestId ? { maestroPerm: null } : {}
        )
        break
      case 'turn-end':
      case 'exit': {
        set({ maestroStream: '', maestroThinking: false, maestroBusy: false, maestroPerm: null })
        const pid = get().openProjectId
        if (pid) {
          void window.synkora.maestro.getState(pid).then((st) => {
            set({
              maestroSessionId: st.sessionId,
              maestroModel: st.model,
              maestroEffort: st.effort,
              maestroCtxWindow: st.contextWindow,
              maestroCtxLimit: st.contextLimit
            })
          })
        }
        break
      }
    }
  },

  taskRuns: {},

  loadTaskRuns: async (projectId) => {
    const snaps = await window.synkora.tasks.runState(projectId)
    const runs: Record<string, TaskRunView> = {}
    for (const s of snaps) {
      runs[s.taskId] = { status: s.status, phase: s.phase, events: s.events, stream: '', perm: null }
    }
    set({ taskRuns: runs })
  },

  // Dev roda num PANE TUI DE VERDADE: o main prepara worktree+transcript e
  // devolve a spec; o pane abre na aba Panes com o CLI real ao vivo.
  runTask: async (projectId, taskId, seatId, model) => {
    const spec = await window.synkora.tasks.run(projectId, taskId, seatId, model)
    if (!spec) return
    get().openDevPane(projectId, taskId, spec)
    await get().loadTasks(projectId)
  },

  openDevPane: (projectId, taskId, spec) => {
    const panes = get().panesByProject[projectId] ?? []
    if (panes.some((p) => p.taskId === taskId && p.role === spec.role)) return // já aberto
    get().addPane(projectId, spec.kind, {
      seatId: spec.seatId,
      taskId,
      cwd: spec.cwd,
      model: spec.model,
      cliArgs: spec.cliArgs,
      initialPrompt: spec.initialPrompt,
      logFile: spec.logFile,
      role: spec.role,
      title: spec.title
    })
    get().setUniverseTab('panes')
  },

  // Fase terminou → o main manda fechar o pane daquela fase.
  closeTaskPane: (projectId, taskId, role) => {
    const panes = get().panesByProject[projectId] ?? []
    const pane = panes.find((p) => p.taskId === taskId && p.role === role)
    if (pane) get().closePane(projectId, pane.id)
  },

  taskAttention: {},
  setTaskAttention: (taskId) =>
    set((s) => ({ taskAttention: { ...s.taskAttention, [taskId]: true } })),
  clearTaskAttention: (taskId) =>
    set((s) => {
      if (!s.taskAttention[taskId]) return {}
      const next = { ...s.taskAttention }
      delete next[taskId]
      return { taskAttention: next }
    }),

  // Feedback de reprovação: digitado DIRETO no pane vivo do dev; se o pane
  // foi fechado, reabre um novo já com o feedback no prompt.
  applyTaskFeedback: (projectId, taskId, text, spec) => {
    const panes = get().panesByProject[projectId] ?? []
    const pane = panes.find((p) => p.taskId === taskId && (p.role ?? 'dev') === 'dev')
    if (pane) {
      window.synkora.pty.write(pane.id, text.replace(/\s+/g, ' ').trim() + '\r')
    } else {
      get().openDevPane(projectId, taskId, spec)
    }
  },

  handleRunEvent: (taskId, evt) =>
    set((s) => {
      const run =
        s.taskRuns[taskId] ??
        ({ status: 'running', phase: 'dev', events: [], stream: '', perm: null } as TaskRunView)
      return {
        taskRuns: {
          ...s.taskRuns,
          [taskId]: { ...run, events: [...run.events, evt].slice(-400) }
        }
      }
    }),

  handleRunLive: (taskId, evt) =>
    set((s) => {
      const run =
        s.taskRuns[taskId] ??
        ({ status: 'running', phase: 'dev', events: [], stream: '', perm: null } as TaskRunView)
      if (evt.type === 'phase') {
        return { taskRuns: { ...s.taskRuns, [taskId]: { ...run, phase: evt.phase, status: 'running' } } }
      }
      switch (evt.type) {
        case 'delta':
          return { taskRuns: { ...s.taskRuns, [taskId]: { ...run, stream: run.stream + evt.text } } }
        case 'flush':
          return { taskRuns: { ...s.taskRuns, [taskId]: { ...run, stream: '' } } }
        case 'permission': {
          const { type: _t, ...perm } = evt
          return { taskRuns: { ...s.taskRuns, [taskId]: { ...run, perm } } }
        }
        case 'permission-cancel':
          return run.perm?.requestId === evt.requestId
            ? { taskRuns: { ...s.taskRuns, [taskId]: { ...run, perm: null } } }
            : {}
        case 'turn-end':
          return {
            taskRuns: {
              ...s.taskRuns,
              [taskId]: { ...run, stream: '', perm: null, status: evt.status ?? run.status }
            }
          }
        default:
          return {}
      }
    }),

  answerRunPerm: async (taskId, choice) => {
    const perm = get().taskRuns[taskId]?.perm
    if (!perm) return
    set((s) => ({
      taskRuns: { ...s.taskRuns, [taskId]: { ...s.taskRuns[taskId], perm: null } }
    }))
    await window.synkora.tasks.runPermission(taskId, perm.requestId, choice)
  },

  sendToRun: async (taskId, message) => {
    set((s) => ({
      taskRuns: { ...s.taskRuns, [taskId]: { ...s.taskRuns[taskId], status: 'running' } }
    }))
    await window.synkora.tasks.runSend(taskId, message)
  },

  interruptRun: async (taskId) => {
    await window.synkora.tasks.runInterrupt(taskId)
  },

  // ▣ assumir no terminal: mata o headless e abre um TUI REAL na mesma
  // conversa (resume) dentro do worktree da tarefa — / à vontade.
  handoffRun: async (projectId, taskId) => {
    const info = await window.synkora.tasks.runHandoff(taskId)
    if (!info) return
    set((s) => {
      const runs = { ...s.taskRuns }
      delete runs[taskId]
      return { taskRuns: runs }
    })
    get().addPane(projectId, info.kind, {
      seatId: info.seatId,
      taskId,
      cwd: info.cwd,
      cliArgs: info.cliArgs.length ? info.cliArgs : undefined,
      title: `▣ ${info.title.slice(0, 30)}${info.title.length > 30 ? '…' : ''}`
    })
    get().setUniverseTab('panes')
  },

  closeRun: async (taskId) => {
    await window.synkora.tasks.runClose(taskId)
    set((s) => {
      const runs = { ...s.taskRuns }
      delete runs[taskId]
      return { taskRuns: runs }
    })
  },

  sendMaestro: async (projectId, message, seatId) => {
    // Steering: mandar DURANTE um turno não pode apagar o stream em andamento.
    const wasBusy = get().maestroBusy
    set(
      wasBusy
        ? { maestroBusy: true }
        : { maestroBusy: true, maestroStream: '', maestroThinking: true }
    )
    try {
      await window.synkora.maestro.send(projectId, message, seatId)
    } catch (e) {
      get().appendMaestroEvent({
        kind: 'err',
        text: e instanceof Error ? e.message : String(e)
      })
      set({ maestroBusy: false, maestroThinking: false })
    }
  },

  answerMaestroPerm: async (projectId, choice) => {
    const perm = get().maestroPerm
    if (!perm) return
    set({ maestroPerm: null })
    await window.synkora.maestro.permission(projectId, perm.requestId, choice)
  },

  interruptMaestro: async (projectId) => {
    await window.synkora.maestro.interrupt(projectId)
  },

  loadMaestroLog: async (projectId) => {
    const state = await window.synkora.maestro.getState(projectId)
    set({
      maestroLog: state.log,
      maestroCtx: state.contextTokens,
      maestroCtxLimit: state.contextLimit,
      maestroCtxWindow: state.contextWindow,
      maestroSessionId: state.sessionId,
      maestroModel: state.model,
      maestroEffort: state.effort,
      maestroAutopilot: state.autopilot
    })
  },

  policies: {},
  catalogByCli: {},

  // Cache POR SEAT (config dir próprio = lista própria); o main já cacheia a
  // consulta ao CLI, então recarregar aqui é barato.
  loadCatalog: async (cli, seatId) => {
    const key = `${cli}:${seatId ?? ''}`
    if (get().catalogByCli[key]) return
    const catalog = await window.synkora.catalog.get(cli, seatId)
    set((s) => ({ catalogByCli: { ...s.catalogByCli, [key]: catalog } }))
  },

  loadPolicies: async (projectId) => {
    const policies = await window.synkora.policies.get(projectId)
    set({ policies })
  },

  setPolicy: async (projectId, dept, policy) => {
    await window.synkora.policies.set(projectId, dept, policy)
    set((s) => ({ policies: { ...s.policies, [dept]: policy } }))
  },

  surveyMaestro: async (projectId, seatId) => {
    set({ maestroBusy: true })
    try {
      await window.synkora.maestro.survey(projectId, seatId)
    } catch (e) {
      get().appendMaestroEvent({
        kind: 'err',
        text: e instanceof Error ? e.message : String(e)
      })
    } finally {
      set({ maestroBusy: false })
    }
  },

  loadProjects: async () => {
    const projects = await window.synkora.projects.list()
    set({ projects })
  },

  createProject: async (name, path) => {
    await window.synkora.projects.create(name, path)
    await get().loadProjects()
  },

  removeProject: async (id) => {
    await window.synkora.projects.remove(id)
    await get().loadProjects()
  },

  loadSeats: async () => {
    const seats = await window.synkora.seats.list()
    set({ seats })
  },

  createSeat: async (name, cli) => {
    await window.synkora.seats.create(name, cli)
    await get().loadSeats()
  },

  removeSeat: async (id) => {
    await window.synkora.seats.remove(id)
    await get().loadSeats()
  },

  openProject: (id) =>
    set({
      openProjectId: id,
      tasks: [],
      maestroLog: [],
      maestroCaps: null,
      maestroCapsKey: null,
      taskRuns: {},
      universeTab: 'board'
    }),

  universeTab: 'board',
  setUniverseTab: (tab) => set({ universeTab: tab }),

  loadTasks: async (projectId) => {
    const tasks = await window.synkora.tasks.list(projectId)
    set({ tasks })
  },

  createTask: async (projectId, department, title, description) => {
    await window.synkora.tasks.create(projectId, {
      department,
      type: 'feature',
      effort: 'leve',
      title,
      description,
      origin: 'manual'
    })
    await get().loadTasks(projectId)
  },

  updateTask: async (id, patch) => {
    const updated = await window.synkora.tasks.update(id, patch)
    if (updated) set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? updated : t)) }))
  },

  removeTask: async (id) => {
    await window.synkora.tasks.remove(id)
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }))
  },

  addPane: (projectId, kind, opts = {}) =>
    set((s) => {
      const panes = s.panesByProject[projectId] ?? []
      // Menor número livre por projeto e por tipo: fechar o "Claude · 1"
      // libera o 1 para o próximo pane, em vez de contar para sempre.
      const used = new Set(panes.filter((p) => p.kind === kind).map((p) => p.n))
      let n = 1
      while (used.has(n)) n++
      const seat = opts.seatId ? s.seats.find((x) => x.id === opts.seatId) : undefined
      const pane: Pane = {
        id: crypto.randomUUID(),
        kind,
        n,
        seatId: opts.seatId,
        taskId: opts.taskId,
        initialPrompt: opts.initialPrompt,
        model: opts.model,
        cliArgs: opts.cliArgs,
        cwd: opts.cwd,
        logFile: opts.logFile,
        role: opts.role,
        title:
          opts.title ?? (seat ? `${seat.name} · ${n}` : `${KIND_LABEL[kind]} · ${n}`)
      }
      return {
        panesByProject: { ...s.panesByProject, [projectId]: [...panes, pane] }
      }
    }),

  closePane: (projectId, paneId) =>
    set((s) => {
      const pane = (s.panesByProject[projectId] ?? []).find((p) => p.id === paneId)
      const attention = { ...s.taskAttention }
      if (pane?.taskId) delete attention[pane.taskId]
      return {
        taskAttention: attention,
        panesByProject: {
          ...s.panesByProject,
          [projectId]: (s.panesByProject[projectId] ?? []).filter((p) => p.id !== paneId)
        }
      }
    })
}))
