import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  FileActionScope,
  FileActionTreeEntry,
  FilePreviewResult,
  FileTreeRoot,
  Mission,
  TerminalMarkdownTarget
} from '../../../preload/index'
import FilePreviewPanel from './FilePreviewPanel'
import ActionFileTree from '../file-tree/FileTree'
import type { FileTreeChange } from '../file-tree/fileTreeTypes'
import { onMarkdownOpen, takeMarkdownOpen } from '../projectFileNavigation'

interface Props {
  projectId: string
  /** Quando presente, abre a raiz física do worktree desta missão. */
  missionId?: string
}

type TerminalPreview = {
  ok: true
  kind: 'markdown'
  path: string
  name: string
  size: number
  mtime: number
  content: string
}

function terminalMarkdownPreview(
  target: TerminalMarkdownTarget,
  doc: { content: string; mtime: number } | null
): TerminalPreview | null {
  if (!doc) return null
  return {
    ok: true,
    kind: 'markdown',
    path: target.path.replace(/\\/g, '/'),
    name: target.name,
    size: new TextEncoder().encode(doc.content).byteLength,
    mtime: doc.mtime,
    content: doc.content
  }
}

/**
 * Aba Arquivos: árvore com ações explícitas e preview sempre somente leitura.
 * A main resolve a raiz por IDs; caminhos físicos nunca atravessam esta tela.
 */
export default function FilesView({ projectId, missionId }: Props): React.JSX.Element {
  const [missionOptions, setMissionOptions] = useState<Mission[]>([])
  const [selectedRoot, setSelectedRoot] = useState<FileTreeRoot>(
    () => (missionId ? { kind: 'mission', missionId } : { kind: 'project' })
  )
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [terminalDoc, setTerminalDoc] = useState<TerminalMarkdownTarget | null>(null)
  const [preview, setPreview] = useState<FilePreviewResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)

  const root = selectedRoot
  const scope = useMemo<FileActionScope>(() => ({
    projectId,
    ...(selectedRoot.kind === 'mission' ? { missionId: selectedRoot.missionId } : {})
  }), [projectId, selectedRoot])
  const runtimeFiles = window.synkora.files as { tree?: unknown; preview?: unknown }
  const bridgeOk = typeof runtimeFiles.tree === 'function' && typeof runtimeFiles.preview === 'function'

  useEffect(() => {
    setSelectedRoot(missionId ? { kind: 'mission', missionId } : { kind: 'project' })
    setSelectedPath(null)
    setTerminalDoc(null)
    setPreview(null)
  }, [missionId, projectId])

  useEffect(() => {
    let stale = false
    void window.synkora.missions.list(projectId).then((missions) => {
      if (!stale) setMissionOptions(missions)
    }).catch(() => {
      if (!stale) setMissionOptions([])
    })
    return () => {
      stale = true
    }
  }, [projectId])

  const openFromTerminal = useCallback((target: TerminalMarkdownTarget): void => {
    if (target.root === 'project') setSelectedRoot({ kind: 'project' })
    setSelectedPath(target.path.replace(/\\/g, '/'))
    setTerminalDoc(target)
    setPreview(null)
    setRevision((value) => value + 1)
  }, [])

  useEffect(() => {
    const queued = takeMarkdownOpen(projectId)
    if (queued) openFromTerminal(queued)
    return onMarkdownOpen(projectId, openFromTerminal)
  }, [openFromTerminal, projectId])

  useEffect(() => {
    if (!selectedPath || !window.synkora.files) return
    let stale = false
    setLoading(true)
    setPreview(null)

    const request: Promise<FilePreviewResult | null> =
      terminalDoc?.root === 'pane'
        ? window.synkora.files.readTerminalDoc(
            projectId,
            terminalDoc.paneId,
            terminalDoc.root,
            terminalDoc.path
          ).then((doc) => terminalMarkdownPreview(terminalDoc, doc))
        : window.synkora.files.preview(projectId, root, selectedPath)

    void request
      .then((result) => {
        if (stale) return
        setPreview(result)
        setLoading(false)
      })
      .catch(() => {
        if (stale) return
        setPreview({
          ok: false,
          error: 'não foi possível abrir este arquivo agora',
          path: selectedPath
        })
        setLoading(false)
      })
    return () => {
      stale = true
    }
  }, [projectId, revision, root, selectedPath, terminalDoc])

  const handleTreeChange = useCallback((change: FileTreeChange): void => {
    if (!change.previousPath) return
    const previousPath = change.previousPath
    setSelectedPath((current) => {
      if (!current) return current
      const affected = current === previousPath || current.startsWith(`${previousPath}/`)
      if (!affected) return current
      if (change.action === 'rename' && change.path) {
        return `${change.path}${current.slice(previousPath.length)}`
      }
      if (change.action === 'trash') return null
      return current
    })
    if (change.action === 'rename' || change.action === 'trash') {
      setTerminalDoc(null)
      setPreview(null)
    }
  }, [])

  if (!bridgeOk) {
    return (
      <div className="ws-empty">
        <p className="empty-title">Arquivos indisponíveis</p>
        <p className="hint">
          Reinicie o app (<code>npm run dev</code>) para carregar a API de arquivos.
        </p>
      </div>
    )
  }

  const activeMission = selectedRoot.kind === 'mission'
    ? missionOptions.find((mission) => mission.id === selectedRoot.missionId)
    : undefined
  const rootLabel = selectedRoot.kind === 'mission'
    ? activeMission ? `missão · ${activeMission.title}` : 'worktree da missão'
    : 'raiz do projeto'

  return (
    <div className="files-view files-view-tree">
      <aside className="files-list files-tree-pane file-tree-host">
        <div className="files-list-head">
          <div>
            <span className="files-title">arquivos</span>
            <span className="files-root-label">{rootLabel}</span>
          </div>
        </div>
        <label className="files-root-picker">
          <span>origem</span>
          <select
            value={selectedRoot.kind === 'project' ? 'project' : selectedRoot.missionId}
            onChange={(event) => {
              const value = event.currentTarget.value
              setSelectedRoot(
                value === 'project'
                  ? { kind: 'project' }
                  : { kind: 'mission', missionId: value }
              )
              setSelectedPath(null)
              setTerminalDoc(null)
              setPreview(null)
            }}
          >
            <option value="project">raiz do projeto</option>
            {missionOptions.map((mission) => (
              <option key={mission.id} value={mission.id}>
                missão · {mission.title}
              </option>
            ))}
          </select>
        </label>
        <div className="files-readonly-note">prévia somente leitura · ações no menu ⋯</div>
        {terminalDoc && (
          <div className="files-terminal-source" data-tip={terminalDoc.path}>
            <span aria-hidden="true">↳</span>
            <span>aberto do terminal</span>
          </div>
        )}
        <ActionFileTree
          scope={scope}
          activePath={selectedPath}
          onOpenFile={(entry: FileActionTreeEntry) => {
            setTerminalDoc(null)
            setSelectedPath(entry.path)
            setRevision((value) => value + 1)
          }}
          onChanged={handleTreeChange}
        />
        {selectedPath && terminalDoc?.root === 'pane' && (
          <div className="files-tree-terminal-path" data-tip={terminalDoc.path}>
            {terminalDoc.name}
          </div>
        )}
      </aside>
      <FilePreviewPanel
        path={selectedPath}
        preview={preview}
        loading={loading}
        onReload={() => setRevision((value) => value + 1)}
      />
    </div>
  )
}
