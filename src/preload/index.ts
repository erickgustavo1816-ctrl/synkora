import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

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

export interface NewTask {
  department: Department
  type: TaskType
  effort: TaskEffort
  title: string
  description: string
  origin: 'maestro' | 'manual'
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

export interface MaestroState {
  log: MaestroEvent[]
  contextTokens: number | null
  contextLimit: number | null
  contextWindow: number | null
  model: string | null
  effort: string | null
  sessionId: string | null
  autopilot: boolean
}

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
  /** tool: input real (JSON) para expandir na UI */
  detail?: string
}

export type PermissionChoice = 'allow' | 'allow-always' | 'deny'

// Capacidades REAIS do CLI (handshake initialize do painel de fundo).
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

// Eventos AO VIVO do painel de fundo do Maestro (não persistidos): texto
// digitando, pedidos de permissão do CLI, fim de turno.
export type MaestroLiveEvent =
  | { type: 'delta'; text: string }
  | { type: 'flush' }
  | { type: 'thinking' }
  | {
      type: 'permission'
      requestId: string
      toolName: string
      description: string
      inputPretty: string
      reason?: string
      canAlways: boolean
    }
  | { type: 'permission-cancel'; requestId: string }
  | { type: 'turn-end'; status?: 'done' | 'error' }
  | { type: 'phase'; phase: 'dev' | 'review' | 'qa' }
  | { type: 'exit' }

export interface TaskRunSnapshot {
  taskId: string
  status: 'running' | 'done' | 'error'
  phase: 'dev' | 'review' | 'qa'
  events: MaestroEvent[]
}

/** Spec de um pane TUI de execução (todas as fases rodam no terminal DE VERDADE). */
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

const api = {
  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
    create: (name: string, path: string): Promise<Project> =>
      ipcRenderer.invoke('projects:create', name, path),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('projects:remove', id)
  },
  seats: {
    list: (): Promise<Seat[]> => ipcRenderer.invoke('seats:list'),
    create: (name: string, cli: SeatCli): Promise<Seat> =>
      ipcRenderer.invoke('seats:create', name, cli),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('seats:remove', id)
  },
  tasks: {
    onChanged: (cb: (projectId: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, projectId: string): void => cb(projectId)
      ipcRenderer.on('tasks:changed', listener)
      return () => ipcRenderer.removeListener('tasks:changed', listener)
    },
    list: (projectId: string): Promise<Task[]> => ipcRenderer.invoke('tasks:list', projectId),
    create: (projectId: string, item: NewTask): Promise<Task[]> =>
      ipcRenderer.invoke('tasks:create', projectId, item),
    update: (id: string, patch: Partial<Task>): Promise<Task | undefined> =>
      ipcRenderer.invoke('tasks:update', id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('tasks:remove', id),
    // Execução (F3): dev em pane TUI real; gates headless com eventos ao vivo.
    run: (
      projectId: string,
      taskId: string,
      seatId: string,
      model?: string
    ): Promise<DevPaneSpec | null> =>
      ipcRenderer.invoke('tasks:run', projectId, taskId, seatId, model),
    onPaneOpen: (
      cb: (projectId: string, taskId: string, spec: DevPaneSpec) => void
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        projectId: string,
        taskId: string,
        spec: DevPaneSpec
      ): void => cb(projectId, taskId, spec)
      ipcRenderer.on('panes:open', listener)
      return () => ipcRenderer.removeListener('panes:open', listener)
    },
    onFeedback: (
      cb: (projectId: string, taskId: string, text: string, spec: DevPaneSpec) => void
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        projectId: string,
        taskId: string,
        text: string,
        spec: DevPaneSpec
      ): void => cb(projectId, taskId, text, spec)
      ipcRenderer.on('tasks:feedback', listener)
      return () => ipcRenderer.removeListener('tasks:feedback', listener)
    },
    onPaneClose: (
      cb: (projectId: string, taskId: string, role: 'dev' | 'review' | 'qa') => void
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        projectId: string,
        taskId: string,
        role: 'dev' | 'review' | 'qa'
      ): void => cb(projectId, taskId, role)
      ipcRenderer.on('panes:close', listener)
      return () => ipcRenderer.removeListener('panes:close', listener)
    },
    onAttention: (cb: (taskId: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, taskId: string): void => cb(taskId)
      ipcRenderer.on('tasks:attention', listener)
      return () => ipcRenderer.removeListener('tasks:attention', listener)
    },
    runPermission: (taskId: string, requestId: string, choice: PermissionChoice): Promise<void> =>
      ipcRenderer.invoke('tasks:runPermission', taskId, requestId, choice),
    runInterrupt: (taskId: string): Promise<void> =>
      ipcRenderer.invoke('tasks:runInterrupt', taskId),
    runSend: (taskId: string, message: string): Promise<boolean> =>
      ipcRenderer.invoke('tasks:runSend', taskId, message),
    runHandoff: (
      taskId: string
    ): Promise<{
      cwd: string
      kind: PaneKind
      seatId: string
      cliArgs: string[]
      title: string
    } | null> => ipcRenderer.invoke('tasks:runHandoff', taskId),
    runClose: (taskId: string): Promise<void> => ipcRenderer.invoke('tasks:runClose', taskId),
    runState: (projectId: string): Promise<TaskRunSnapshot[]> =>
      ipcRenderer.invoke('tasks:runState', projectId),
    onRunEvent: (cb: (taskId: string, evt: MaestroEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, taskId: string, evt: MaestroEvent): void =>
        cb(taskId, evt)
      ipcRenderer.on('taskrun:event', listener)
      return () => ipcRenderer.removeListener('taskrun:event', listener)
    },
    onRunLive: (cb: (taskId: string, evt: MaestroLiveEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, taskId: string, evt: MaestroLiveEvent): void =>
        cb(taskId, evt)
      ipcRenderer.on('taskrun:live', listener)
      return () => ipcRenderer.removeListener('taskrun:live', listener)
    }
  },
  maestro: {
    send: (projectId: string, message: string, seatId?: string): Promise<void> =>
      ipcRenderer.invoke('maestro:send', projectId, message, seatId),
    permission: (
      projectId: string,
      requestId: string,
      choice: PermissionChoice
    ): Promise<void> => ipcRenderer.invoke('maestro:permission', projectId, requestId, choice),
    interrupt: (projectId: string): Promise<void> =>
      ipcRenderer.invoke('maestro:interrupt', projectId),
    capabilities: (projectId: string, seatId?: string): Promise<MaestroCaps | null> =>
      ipcRenderer.invoke('maestro:capabilities', projectId, seatId),
    onLive: (cb: (evt: MaestroLiveEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, evt: MaestroLiveEvent): void => cb(evt)
      ipcRenderer.on('maestro:live', listener)
      return () => ipcRenderer.removeListener('maestro:live', listener)
    },
    survey: (projectId: string, seatId?: string): Promise<void> =>
      ipcRenderer.invoke('maestro:survey', projectId, seatId),
    getState: (projectId: string): Promise<MaestroState> =>
      ipcRenderer.invoke('maestro:getState', projectId),
    onCtx: (cb: (tokens: number) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, tokens: number): void => cb(tokens)
      ipcRenderer.on('maestro:ctx', listener)
      return () => ipcRenderer.removeListener('maestro:ctx', listener)
    },
    reset: (projectId: string): Promise<void> => ipcRenderer.invoke('maestro:reset', projectId),
    setModel: (projectId: string, model: string): Promise<void> =>
      ipcRenderer.invoke('maestro:setModel', projectId, model),
    setContextLimit: (projectId: string, limit: number): Promise<void> =>
      ipcRenderer.invoke('maestro:setContextLimit', projectId, limit),
    setEffort: (projectId: string, effort: string): Promise<void> =>
      ipcRenderer.invoke('maestro:setEffort', projectId, effort),
    onEvent: (cb: (evt: MaestroEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, evt: MaestroEvent): void => cb(evt)
      ipcRenderer.on('maestro:event', listener)
      return () => ipcRenderer.removeListener('maestro:event', listener)
    }
  },
  catalog: {
    get: (cli: SeatCli, seatId?: string): Promise<Catalog> =>
      ipcRenderer.invoke('catalog:get', cli, seatId)
  },
  harness: {
    setAutopilot: (projectId: string, on: boolean): Promise<void> =>
      ipcRenderer.invoke('harness:setAutopilot', projectId, on)
  },
  policies: {
    get: (projectId: string): Promise<ProjectPolicies> =>
      ipcRenderer.invoke('policies:get', projectId),
    set: (projectId: string, dept: Department, policy: DeptPolicy): Promise<void> =>
      ipcRenderer.invoke('policies:set', projectId, dept, policy)
  },
  clipboard: {
    hasImage: (): boolean => ipcRenderer.sendSync('clipboard:hasImage') as boolean,
    saveImage: (projectId: string): Promise<string | null> =>
      ipcRenderer.invoke('clipboard:saveImage', projectId)
  },
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),
  pty: {
    create: (opts: {
      id: string
      cwd: string
      kind: PaneKind
      seatId?: string
      taskId?: string
      initialPrompt?: string
      model?: string
      cliArgs?: string[]
      cols?: number
      rows?: number
      logFile?: string
    }): Promise<void> => ipcRenderer.invoke('pty:create', opts),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string): void => ipcRenderer.send('pty:kill', id),
    onData: (cb: (id: string, data: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, id: string, data: string): void => cb(id, data)
      ipcRenderer.on('pty:data', listener)
      return () => ipcRenderer.removeListener('pty:data', listener)
    },
    onExit: (cb: (id: string, exitCode: number) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, id: string, exitCode: number): void =>
        cb(id, exitCode)
      ipcRenderer.on('pty:exit', listener)
      return () => ipcRenderer.removeListener('pty:exit', listener)
    }
  }
}

export type SynkoraApi = typeof api

contextBridge.exposeInMainWorld('synkora', api)
