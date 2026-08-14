/**
 * IPC — domínio files (fase 1, commit 5).
 * Aba Arquivos e links de terminal — ilha limpa: o estado privado
 * (interface DocFile + terminalFileRoots) viaja em bloco.
 *
 * Corpo movido VERBATIM do whenReady do index.ts. CERCA VIVA da Fase 0:
 * register*Ipc é CHAMADO do whenReady (bloco único antes do createWindow),
 * NUNCA no import — instrumentIpcMain só cobre handlers registrados depois
 * dele. uiSender/mainWindow/mcpPort e afins são lidos via ctx a cada uso.
 */
import {
  clipboard,
  dialog,
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type SaveDialogOptions
} from 'electron'
import { basename, join, resolve } from 'path'
import { readFileSync, readdirSync, statSync } from 'fs'
import {
  findTerminalFileLinks,
  readProjectMarkdown,
  resolveTerminalFile,
  terminalFileOpenKind,
  type TerminalFileRoot
} from '../terminalFileLinks'
import {
  FileActionError,
  FileActionService,
  parseFileActionRelativePath,
  type FileActionResult,
  type FileActionScope
} from '../fileActions'
import { archiveDirectoryToNewFileOffMain } from '../fileArchiveAsync'
import type { MainContext } from '../mainContext'
import {
  listReadOnlyFileTree,
  readReadOnlyFilePreview,
  type FileTreeRoot
} from '../filePreview'

export interface FilesIpcExtras {
  /** Host ou canvas: ambos são renderers empacotados e autenticados. */
  assertAppRendererSender(event: IpcMainInvokeEvent | IpcMainEvent): void
}

export function registerFilesIpc(ctx: MainContext, extras: FilesIpcExtras): void {
  const {
    projects,
    missions,
    maestro,
    hub
  } = ctx
  const fileActions = new FileActionService(
    {
      project: (id) => projects.get(id),
      mission: (id) => missions.get(id)
    },
    {
      trashItem: async (absolutePath) => {
        if (typeof shell.trashItem !== 'function') {
          throw new FileActionError('trash-unavailable')
        }
        await shell.trashItem(absolutePath)
      },
      writeClipboard: (text) => clipboard.writeText(text),
      archiveDirectory: archiveDirectoryToNewFileOffMain
    }
  )

  const auditFileAction = (
    action: string,
    scope: FileActionScope,
    result: FileActionResult
  ): void => {
    // Nunca registrar nome, caminho ou erro de filesystem.
    const knownProject = typeof scope?.projectId === 'string'
      ? projects.get(scope.projectId)
      : undefined
    const knownMission = typeof scope?.missionId === 'string'
      ? missions.get(scope.missionId)
      : undefined
    ctx.blackbox.record({
      cat: 'user',
      event: `file-action-${action}`,
      actor: 'user',
      detail: {
        projectId: knownProject?.id.slice(0, 8) ?? 'invalid',
        mission: Boolean(knownMission && knownMission.projectId === knownProject?.id),
        ok: result.ok
      }
    })
  }

  const finishFileAction = (
    action: string,
    scope: FileActionScope,
    result: FileActionResult,
    changed = false
  ): FileActionResult => {
    auditFileAction(action, scope, result)
    if (result.ok && changed) ctx.pushAll('files:changed', scope)
    return result
  }

  // ————— Árvore + ações P26 —————
  ipcMain.handle('files:tree', (event, scope: FileActionScope) => {
    extras.assertAppRendererSender(event)
    return fileActions.listTree(scope)
  })

  ipcMain.handle(
    'files:createFile',
    async (event, scope: FileActionScope, parentPath: unknown, name: unknown) => {
      extras.assertAppRendererSender(event)
      return finishFileAction(
        'create-file',
        scope,
        await fileActions.createFile(scope, parentPath, name),
        true
      )
    }
  )

  ipcMain.handle(
    'files:createFolder',
    async (event, scope: FileActionScope, parentPath: unknown, name: unknown) => {
      extras.assertAppRendererSender(event)
      return finishFileAction(
        'create-folder',
        scope,
        await fileActions.createFolder(scope, parentPath, name),
        true
      )
    }
  )

  ipcMain.handle(
    'files:rename',
    async (event, scope: FileActionScope, relativePath: unknown, name: unknown) => {
      extras.assertAppRendererSender(event)
      return finishFileAction(
        'rename',
        scope,
        await fileActions.rename(scope, relativePath, name),
        true
      )
    }
  )

  ipcMain.handle(
    'files:trash',
    async (event, scope: FileActionScope, relativePath: unknown) => {
      extras.assertAppRendererSender(event)
      return finishFileAction(
        'trash',
        scope,
        await fileActions.moveToTrash(scope, relativePath),
        true
      )
    }
  )

  ipcMain.handle(
    'files:copyPath',
    async (event, scope: FileActionScope, relativePath: unknown) => {
      extras.assertAppRendererSender(event)
      return finishFileAction(
        'copy-path',
        scope,
        await fileActions.copyPath(scope, relativePath)
      )
    }
  )

  ipcMain.handle(
    'files:downloadZip',
    async (event, scope: FileActionScope, relativePath: unknown): Promise<FileActionResult> => {
      extras.assertAppRendererSender(event)
      let parsed
      try {
        parsed = parseFileActionRelativePath(relativePath)
      } catch (error) {
        const result = {
          ok: false,
          error: error instanceof FileActionError
            ? error.message
            : 'O caminho informado é inválido.'
        }
        return finishFileAction('download-zip', scope, result)
      }
      const leaf = parsed.segments.at(-1) ?? 'pasta'
      const options: SaveDialogOptions = {
        title: 'Baixar pasta como ZIP',
        defaultPath: `${leaf}.zip`,
        filters: [{ name: 'Arquivo ZIP', extensions: ['zip'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      }
      const selected = ctx.mainWindow && !ctx.mainWindow.isDestroyed()
        ? await dialog.showSaveDialog(ctx.mainWindow, options)
        : await dialog.showSaveDialog(options)
      if (selected.canceled || !selected.filePath) {
        return { ok: false, cancelled: true }
      }
      return finishFileAction(
        'download-zip',
        scope,
        await fileActions.archiveFolder(
          scope,
          parsed.normalized,
          selected.filePath,
          basename(selected.filePath)
        )
      )
    }
  )
  // ————— Arquivos do projeto (aba Arquivos + viewer de markdown) —————
  // Lista os .md que interessam (planos do maestro, dossiê, docs, transcripts)
  // e serve o conteúdo para o viewer renderizar bonito dentro do Synkora.
  interface DocFile {
    /** caminho relativo ao projeto, com / */
    path: string
    name: string
    group: 'projeto' | 'docs' | 'synkora' | 'transcripts'
    mtime: number
    size: number
  }

  const terminalFileRoots = (projectId: string, paneId: string): TerminalFileRoot[] => {
    const project = projects.get(projectId)
    const identity = hub.identityByPane(paneId)
    if (!project || !identity || identity.projectId !== projectId) return []
    const roots: TerminalFileRoot[] = [{ id: 'project', path: project.path }]
    if (resolve(identity.cwd).toLowerCase() !== resolve(project.path).toLowerCase()) {
      roots.push({ id: 'pane', path: identity.cwd })
    }
    return roots
  }

  /**
   * Resolve the logical root in the main process. The renderer can submit only
   * a project/mission ID here; it never gets to choose an absolute root path.
   * Mission worktrees are authoritative state owned by MissionStore. The
   * read-only helper performs the second, physical containment check.
   */
  const readOnlyRootPath = (
    projectId: unknown,
    rawRoot: unknown
  ): { kind: FileTreeRoot['kind']; path: string } | null => {
    if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 256) return null
    const project = projects.get(projectId)
    if (!project || typeof project.path !== 'string') return null
    if (!rawRoot || typeof rawRoot !== 'object') return null
    const root = rawRoot as { kind?: unknown; missionId?: unknown }
    if (root.kind === 'project') return { kind: 'project', path: project.path }
    if (root.kind !== 'mission' || typeof root.missionId !== 'string' || root.missionId.length > 256) {
      return null
    }
    const mission = missions.get(root.missionId)
    if (!mission || mission.projectId !== projectId) return null
    return {
      kind: 'mission',
      path: typeof mission.worktree === 'string' && mission.worktree ? mission.worktree : project.path
    }
  }

  ipcMain.handle('files:listTree', (_e, projectId: unknown, rawRoot: unknown) => {
    const root = readOnlyRootPath(projectId, rawRoot)
    if (!root) return { entries: [], truncated: false, skipped: 0, error: 'raiz de arquivos indisponível' }
    return listReadOnlyFileTree(root.path)
  })

  ipcMain.handle(
    'files:preview',
    (_e, projectId: unknown, rawRoot: unknown, relativePath: unknown) => {
      const root = readOnlyRootPath(projectId, rawRoot)
      if (!root || typeof relativePath !== 'string') return null
      return readReadOnlyFilePreview(root.path, relativePath)
    }
  )

  ipcMain.handle('files:listDocs', (_e, projectId: string): DocFile[] => {
    const project = projects.get(projectId)
    if (!project) return []
    const out: DocFile[] = []
    const push = (abs: string, rel: string, group: DocFile['group']): void => {
      try {
        const st = statSync(abs)
        out.push({
          path: rel.replace(/\\/g, '/'),
          name: rel.split(/[\\/]/).pop() ?? rel,
          group,
          mtime: st.mtimeMs,
          size: st.size
        })
      } catch {
        // sumiu no meio do scan
      }
    }
    const scanDir = (dir: string, relBase: string, group: DocFile['group'], depth: number): void => {
      let entries: import('fs').Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const ent of entries) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue
        const abs = join(dir, ent.name)
        const rel = relBase ? `${relBase}/${ent.name}` : ent.name
        if (ent.isDirectory()) {
          if (depth > 0) scanDir(abs, rel, group, depth - 1)
        } else if (/\.md$/i.test(ent.name)) {
          push(abs, rel, group)
        }
      }
    }
    scanDir(project.path, '', 'projeto', 0) // .md da raiz (README, CLAUDE.md…)
    scanDir(join(project.path, 'docs'), 'docs', 'docs', 3)
    scanDir(join(project.path, '.synkora'), '.synkora', 'synkora', 0)
    scanDir(join(project.path, '.synkora', 'missions'), '.synkora/missions', 'synkora', 0)
    scanDir(join(project.path, '.synkora', 'reports'), '.synkora/reports', 'synkora', 0)
    scanDir(join(project.path, '.synkora', 'runs'), '.synkora/runs', 'transcripts', 0)
    return out.sort((a, b) => b.mtime - a.mtime)
  })

  ipcMain.handle(
    'files:readDoc',
    (_e, projectId: string, relPath: string): { content: string; mtime: number } | null => {
      const project = projects.get(projectId)
      if (!project) return null
      return readProjectMarkdown(project.path, relPath)
    }
  )

  ipcMain.handle(
    'files:terminalLinks',
    (_e, projectId: string, paneId: string, text: string) => {
      if (typeof text !== 'string' || text.length > 16_384) return []
      return findTerminalFileLinks(text, terminalFileRoots(projectId, paneId))
        .map(({ start, length, text: label }) => ({ start, length, text: label }))
    }
  )

  ipcMain.handle(
    'files:openTerminalFile',
    async (_e, projectId: string, paneId: string, candidate: string) => {
      if (typeof candidate !== 'string') return { ok: false, error: 'caminho inválido' }
      const resolvedFile = resolveTerminalFile(
        candidate,
        terminalFileRoots(projectId, paneId)
      )
      if (!resolvedFile) return { ok: false, error: 'arquivo não encontrado ou fora do projeto' }

      const openKind = terminalFileOpenKind(resolvedFile.absolutePath)
      if (openKind === 'markdown') {
        const result = {
          ok: true,
          action: 'markdown' as const,
          paneId,
          root: resolvedFile.root,
          path: resolvedFile.relativePath,
          name: basename(resolvedFile.absolutePath),
          displayPath: candidate
        }
        // F3-c4: quem abre a aba Arquivos é o HOST — o desfecho viaja por push
        // (um caminho só para clique vindo do host ou da view de panes; o
        // registro módulo-level do renderer não cruza processos).
        ctx.pushBoard('files:navigate', projectId, result)
        return result
      }
      if (openKind === 'reveal') {
        shell.showItemInFolder(resolvedFile.absolutePath)
        return { ok: true, action: 'reveal' as const }
      }

      const error = await shell.openPath(resolvedFile.absolutePath)
      return error
        ? { ok: false, error }
        : { ok: true, action: 'external' as const }
    }
  )

  ipcMain.handle(
    'files:readTerminalDoc',
    (
      _e,
      projectId: string,
      paneId: string,
      rootId: TerminalFileRoot['id'],
      relPath: string
    ): { content: string; mtime: number } | null => {
      if (typeof relPath !== 'string' || !/\.md$/i.test(relPath)) return null
      const project = projects.get(projectId)
      const root = rootId === 'project' && project
        ? { id: 'project' as const, path: project.path }
        : terminalFileRoots(projectId, paneId).find((item) => item.id === rootId)
      if (!root) return null
      const resolvedFile = resolveTerminalFile(relPath, [root])
      if (!resolvedFile || !/\.md$/i.test(resolvedFile.absolutePath)) return null
      try {
        const st = statSync(resolvedFile.absolutePath)
        if (st.size > 2 * 1024 * 1024) {
          return { content: '_arquivo grande demais para o viewer (>2MB)_', mtime: st.mtimeMs }
        }
        return { content: readFileSync(resolvedFile.absolutePath, 'utf-8'), mtime: st.mtimeMs }
      } catch {
        return null
      }
    }
  )
}
