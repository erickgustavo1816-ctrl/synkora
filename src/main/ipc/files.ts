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
import { ipcMain, shell } from 'electron'
import { basename, join, resolve } from 'path'
import { readFileSync, readdirSync, statSync } from 'fs'
import {
  findTerminalFileLinks,
  readProjectMarkdown,
  resolveTerminalFile,
  terminalFileOpenKind,
  type TerminalFileRoot
} from '../terminalFileLinks'
import type { MainContext } from '../mainContext'

export function registerFilesIpc(ctx: MainContext): void {
  const {
    projects,
    missions,
    maestro,
    hub
  } = ctx
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
        return {
          ok: true,
          action: 'markdown' as const,
          paneId,
          root: resolvedFile.root,
          path: resolvedFile.relativePath,
          name: basename(resolvedFile.absolutePath),
          displayPath: candidate
        }
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
