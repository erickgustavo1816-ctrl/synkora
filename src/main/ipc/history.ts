/** IPC da paleta: pesquisa e montagem segura de históricos locais. */
import {  ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import {  resolve } from 'path'
import type { MainContext } from '../mainContext'
import type { GuiSessionRegistry } from '../guiSessions'
import {
  guiMissionPaneId,
  guiPlanningPaneId
} from '../guiMissionContracts'
import {
  loadLocalHistoryTranscript,
  localHistoryLocatorIsSafe,
  searchLocalHistory,
  type HistoryProviderRoot,
  type HistorySessionBinding,
  type HistoryWorkspaceScope,
  type LocalHistoryLocator
} from '../historySearch'
import type {
  HistoryLoadResult,
  HistorySearchInput,
  HistorySearchResult
} from '../../shared/commandPalette'

export interface HistoryIpcDeps {
  assertAppRendererSender(event: IpcMainInvokeEvent | IpcMainEvent): void
  guiSessions: GuiSessionRegistry
}

interface StoredSelection {
  locator: LocalHistoryLocator
  expiresAt: number
  projectId?: string
  missionId?: string
  paneId?: string
  canMount: boolean
}

const REQUEST_ID_RE = /^[A-Za-z0-9:_-]{1,160}$/u
const SEARCH_QUERY_MAX = 240
const SELECTION_TTL_MS = 10 * 60_000
const SELECTION_CAP = 640
const GUI_HELPER_INDEX_CAP = 8

function addBinding(
  bindings: Map<string, HistorySessionBinding>,
  input: HistorySessionBinding
): void {
  if (!input.sessionId || input.sessionId.length > 512) return
  const previous = bindings.get(input.sessionId)
  if (
    !previous ||
    (!previous.paneId && input.paneId) ||
    (!previous.missionId && input.missionId) ||
    (!previous.canMount && input.canMount)
  ) {
    bindings.set(input.sessionId, input)
  }
}

function uniqueRoots(ctx: MainContext): HistoryProviderRoot[] {
  const seen = new Set<string>()
  const roots: HistoryProviderRoot[] = []
  for (const seat of ctx.seats.list()) {
    const configDir = ctx.seats.configDirOf(seat)
    const key = `${seat.cli}:${resolve(configDir).toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    roots.push({ provider: seat.cli, configDir })
  }
  return roots
}

function historyIndex(
  ctx: MainContext,
  guiSessions: GuiSessionRegistry,
  projectFilter?: string
): { workspaces: HistoryWorkspaceScope[]; bindings: HistorySessionBinding[] } {
  const projects = ctx.projects
    .list()
    .filter((project) => projectFilter === undefined || project.id === projectFilter)
  const projectIds = new Set(projects.map((project) => project.id))
  const workspaces: HistoryWorkspaceScope[] = []
  const bindings = new Map<string, HistorySessionBinding>()

  for (const project of projects) {
    const planningPaneId = guiPlanningPaneId(project.id)
    workspaces.push({
      cwd: project.path,
      projectId: project.id,
      label: project.name
    })
    const planning = guiSessions.remembered(planningPaneId)
    if (planning?.sessionId) {
      addBinding(bindings, {
        sessionId: planning.sessionId,
        projectId: project.id,
        paneId: planningPaneId,
        // O canal legado de planejamento está dormente no renderer: indexar
        // ajuda a encontrar, mas prometer um GuiPane inexistente seria falso.
        label: `${project.name} · planejamento`
      })
    }

    const maestroState = ctx.maestro.get(project.id)
    const maestroSessionId = maestroState.tuiSessionId ?? maestroState.sessionId
    if (maestroSessionId) {
      addBinding(bindings, {
        sessionId: maestroSessionId,
        projectId: project.id,
        paneId: ctx.maestroPaneId(project.id),
        label: `${project.name} · geral`
      })
    }

    for (const mission of ctx.missions.list(project.id)) {
      const missionCwd = mission.worktree?.trim()
      if (missionCwd && resolve(missionCwd) !== resolve(project.path)) {
        workspaces.push({
          cwd: missionCwd,
          projectId: project.id,
          missionId: mission.id,
          label: mission.title
        })
      }
      for (const role of ['dev', 'reviewer'] as const) {
        const paneId = guiMissionPaneId(role, mission.id)
        const remembered = guiSessions.remembered(paneId)
        if (!remembered?.sessionId) continue
        const naturallyMounted =
          role === 'dev' &&
          mission.direct === true &&
          (mission.status === 'ativa' || mission.status === 'integrando')
        addBinding(bindings, {
          sessionId: remembered.sessionId,
          projectId: project.id,
          missionId: mission.id,
          paneId,
          label: mission.title,
          canMount: naturallyMounted
        })
      }
      for (let index = 1; index <= GUI_HELPER_INDEX_CAP; index += 1) {
        const paneId = guiMissionPaneId('helper', mission.id, index)
        const remembered = guiSessions.remembered(paneId)
        if (!remembered?.sessionId) continue
        addBinding(bindings, {
          sessionId: remembered.sessionId,
          projectId: project.id,
          missionId: mission.id,
          paneId,
          label: `${mission.title} · ajudante ${index}`
        })
      }
      const orchestrator = ctx.maestro.get(`${project.id}--${mission.id}`)
      const orchestratorSessionId = orchestrator.tuiSessionId ?? orchestrator.sessionId
      if (orchestratorSessionId) {
        addBinding(bindings, {
          sessionId: orchestratorSessionId,
          projectId: project.id,
          missionId: mission.id,
          paneId: ctx.orchPaneId(project.id, mission.id),
          label: `${mission.title} · orquestrador`
        })
      }
    }
  }

  // Pane vivo é a evidência mais precisa: session -> pane + identidade real.
  for (const [paneId, sessionId] of ctx.paneSessions) {
    const identity = ctx.hub.identityByPane(paneId)
    const live = ctx.livePaneSpecs.get(paneId)
    const projectId = identity?.projectId ?? live?.projectId
    if (!projectId || !projectIds.has(projectId)) continue
    addBinding(bindings, {
      sessionId,
      projectId,
      ...(identity?.missionId ? { missionId: identity.missionId } : {}),
      paneId,
      label: live?.spec.title
    })
  }

  return { workspaces, bindings: [...bindings.values()] }
}

function emptySearch(input: Partial<HistorySearchInput>, error?: string): HistorySearchResult {
  return {
    ok: !error,
    requestId: typeof input.requestId === 'string' ? input.requestId : '',
    hits: [],
    cancelled: false,
    truncated: false,
    scannedFiles: 0,
    scannedBytes: 0,
    ...(error ? { error } : {})
  }
}

export function registerHistoryIpc(ctx: MainContext, deps: HistoryIpcDeps): void {
  const controllers = new Map<string, AbortController>()
  const selections = new Map<string, StoredSelection>()
  const watchedSenders = new Set<number>()

  const controllerKey = (senderId: number, requestId: string): string => `${senderId}:${requestId}`
  const pruneSelections = (): void => {
    const now = Date.now()
    for (const [id, selection] of selections) {
      if (selection.expiresAt <= now) selections.delete(id)
    }
    while (selections.size > SELECTION_CAP) {
      const oldest = selections.keys().next().value
      if (oldest === undefined) break
      selections.delete(oldest)
    }
  }
  const watchSender = (event: IpcMainInvokeEvent): void => {
    if (watchedSenders.has(event.sender.id)) return
    const senderId = event.sender.id
    watchedSenders.add(senderId)
    event.sender.once('destroyed', () => {
      watchedSenders.delete(senderId)
      for (const [key, controller] of controllers) {
        if (!key.startsWith(`${senderId}:`)) continue
        controller.abort()
        controllers.delete(key)
      }
    })
  }

  ipcMain.on('history:cancel', (event, requestId: string) => {
    try {
      deps.assertAppRendererSender(event)
    } catch {
      return
    }
    if (!REQUEST_ID_RE.test(requestId)) return
    controllers.get(controllerKey(event.sender.id, requestId))?.abort()
  })

  ipcMain.handle(
    'history:search',
    async (event, raw: HistorySearchInput): Promise<HistorySearchResult> => {
      deps.assertAppRendererSender(event)
      watchSender(event)
      if (!raw || typeof raw !== 'object') return emptySearch({}, 'busca inválida')
      if (!REQUEST_ID_RE.test(raw.requestId)) return emptySearch(raw, 'identificador de busca inválido')
      if (typeof raw.query !== 'string' || raw.query.length > SEARCH_QUERY_MAX) {
        return emptySearch(raw, 'consulta inválida')
      }
      const query = raw.query.trim()
      if (query.length < 2) return emptySearch(raw)
      if (
        raw.projectId !== undefined &&
        (typeof raw.projectId !== 'string' ||
          raw.projectId.length === 0 ||
          raw.projectId.length > 512 ||
          !ctx.projects.get(raw.projectId))
      ) {
        return emptySearch(raw, 'universo não encontrado')
      }

      const key = controllerKey(event.sender.id, raw.requestId)
      controllers.get(key)?.abort()
      const controller = new AbortController()
      controllers.set(key, controller)
      const { workspaces, bindings } = historyIndex(ctx, deps.guiSessions, raw.projectId)
      try {
        const result = await searchLocalHistory({
          query,
          roots: uniqueRoots(ctx),
          workspaces,
          sessionBindings: bindings,
          signal: controller.signal
        })
        pruneSelections()
        const hits = (result.cancelled ? [] : result.hits).map((hit) => {
          const selectionId = randomUUID()
          selections.set(selectionId, {
            locator: hit.locator,
            expiresAt: Date.now() + SELECTION_TTL_MS,
            ...(hit.projectId ? { projectId: hit.projectId } : {}),
            ...(hit.missionId ? { missionId: hit.missionId } : {}),
            ...(hit.paneId ? { paneId: hit.paneId } : {}),
            canMount: hit.canMount
          })
          return {
            selectionId,
            provider: hit.provider,
            sessionId: hit.sessionId,
            messageId: hit.messageId,
            cursor: hit.cursor,
            role: hit.role,
            snippet: hit.snippet,
            ...(hit.at ? { at: hit.at } : {}),
            ...(hit.projectId ? { projectId: hit.projectId } : {}),
            ...(hit.missionId ? { missionId: hit.missionId } : {}),
            ...(hit.paneId ? { paneId: hit.paneId } : {}),
            ...(hit.label ? { label: hit.label } : {}),
            canMount: hit.canMount
          }
        })
        pruneSelections()
        return {
          ok: true,
          requestId: raw.requestId,
          hits,
          cancelled: result.cancelled,
          truncated: result.truncated,
          ...(result.limitReason ? { limitReason: result.limitReason } : {}),
          scannedFiles: result.scannedFiles,
          scannedBytes: result.scannedBytes
        }
      } catch {
        return {
          ...emptySearch(raw, 'não consegui pesquisar os históricos locais agora'),
          cancelled: controller.signal.aborted
        }
      } finally {
        if (controllers.get(key) === controller) controllers.delete(key)
      }
    }
  )

  ipcMain.handle(
    'history:load',
    async (event, selectionId: string): Promise<HistoryLoadResult> => {
      deps.assertAppRendererSender(event)
      if (!REQUEST_ID_RE.test(selectionId)) {
        return { ok: false, selectionId: '', error: 'seleção de histórico inválida' }
      }
      pruneSelections()
      const selection = selections.get(selectionId)
      if (!selection) {
        return {
          ok: false,
          selectionId,
          error: 'essa seleção expirou — pesquise a mensagem novamente'
        }
      }
      if (!(await localHistoryLocatorIsSafe(selection.locator))) {
        selections.delete(selectionId)
        return {
          ok: false,
          selectionId,
          error: 'o arquivo dessa conversa não está mais num local permitido'
        }
      }
      const result = await loadLocalHistoryTranscript(selection.locator)
      let canMount = false
      if (selection.canMount && selection.projectId && selection.paneId) {
        const current = historyIndex(ctx, deps.guiSessions, selection.projectId).bindings.find(
          (binding) => binding.sessionId === selection.locator.sessionId
        )
        canMount = Boolean(
          current?.canMount &&
            current.projectId === selection.projectId &&
            current.paneId === selection.paneId &&
            current.missionId === selection.missionId
        )
      }
      return {
        selectionId,
        ...result,
        ...(selection.projectId ? { projectId: selection.projectId } : {}),
        ...(selection.missionId ? { missionId: selection.missionId } : {}),
        ...(selection.paneId ? { paneId: selection.paneId } : {}),
        canMount
      }
    }
  )
}
