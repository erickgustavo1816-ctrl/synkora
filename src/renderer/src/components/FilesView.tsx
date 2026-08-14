import { useCallback, useEffect, useState } from 'react'
import type {
  FilePreviewResult,
  FileTreeEntry,
  FileTreeRoot,
  Mission,
  TerminalMarkdownTarget
} from '../../../preload/index'
import FilePreviewPanel from './FilePreviewPanel'
import FileTree from './FileTree'
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
 * Aba Arquivos: árvore + preview somente leitura.
 *
 * A lista e a leitura passam pela main; o renderer envia apenas o ID da raiz
 * lógica e o caminho relativo devolvido pela própria árvore. Não há textarea,
 * editor, save, download ou URL local direta nesta superfície.
 */
export default function FilesView({ projectId, missionId }: Props): React.JSX.Element {
  const [missionOptions, setMissionOptions] = useState<Mission[]>([])
  const [selectedRoot, setSelectedRoot] = useState<FileTreeRoot>(
    () => (missionId ? { kind: 'mission', missionId } : { kind: 'project' })
  )
  const root = selectedRoot
  const [entries, setEntries] = useState<FileTreeEntry[]>([])
  const [treeError, setTreeError] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [terminalDoc, setTerminalDoc] = useState<TerminalMarkdownTarget | null>(null)
  const [preview, setPreview] = useState<FilePreviewResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)

  const bridgeOk = typeof window.synkora.files !== 'undefined'

  useEffect(() => {
    setSelectedRoot(missionId ? { kind: 'mission', missionId } : { kind: 'project' })
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

  const refresh = useCallback(async () => {
    if (!window.synkora.files?.listTree) return
    try {
      const result = await window.synkora.files.listTree(projectId, root)
      setEntries(result.entries)
      setTreeError(
        result.error ?? (result.truncated ? 'árvore limitada ao teto de segurança' : null)
      )
      if (!terminalDoc && selectedPath && !result.entries.some((entry) => entry.path === selectedPath)) {
        setSelectedPath(null)
      }
    } catch {
      setEntries([])
      setTreeError('não foi possível carregar a árvore de arquivos')
    }
  }, [projectId, root, selectedPath, terminalDoc])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openFromTerminal = useCallback((target: TerminalMarkdownTarget): void => {
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

  // Se o terminal abriu um arquivo da raiz exibida, deixa a árvore ser a única
  // indicação visual da seleção. Alvos do pane continuam no marcador acima da
  // árvore, sem inventar uma entrada fora da raiz autoritativa.
  useEffect(() => {
    if (
      terminalDoc?.root === 'project' &&
      entries.some((entry) => entry.kind === 'file' && entry.path === terminalDoc.path)
    ) {
      setTerminalDoc(null)
    }
  }, [entries, terminalDoc])

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
        setPreview({ ok: false, error: 'não foi possível abrir este arquivo agora', path: selectedPath })
        setLoading(false)
      })
    return () => {
      stale = true
    }
  }, [projectId, revision, root, selectedPath, terminalDoc])

  if (!bridgeOk) {
    return (
      <div className="ws-empty">
        <p className="empty-title">Arquivos indisponíveis</p>
        <p className="hint">
          Reinicie o app (<code>npm run dev</code>) para carregar a API de leitura.
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
  // displayPath is retained only for the legacy terminal-navigation contract;
  // P25 displays the normalized relative path, never an absolute candidate.
  const activePath = selectedPath

  return (
    <div className="files-view files-view-tree">
      <aside className="files-list files-tree-pane">
        <div className="files-list-head">
          <div>
            <span className="files-title">arquivos</span>
            <span className="files-root-label">{rootLabel}</span>
          </div>
          <button
            type="button"
            className="term-btn ghost-dim"
            data-tip="Recarregar a árvore"
            aria-label="Recarregar a árvore"
            onClick={() => void refresh()}
          >
            ↻
          </button>
        </div>
        <label className="files-root-picker">
          <span>origem da leitura</span>
          <select
            value={selectedRoot.kind === 'project' ? 'project' : selectedRoot.missionId}
            onChange={(event) => {
              const value = event.currentTarget.value
              setSelectedRoot(value === 'project' ? { kind: 'project' } : { kind: 'mission', missionId: value })
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
        <div className="files-readonly-note">somente leitura · sem salvar</div>
        {terminalDoc && (
          <div className="files-terminal-source" data-tip={terminalDoc.path}>
            <span aria-hidden="true">↳</span>
            <span>aberto do terminal</span>
          </div>
        )}
        {treeError && <div className="files-tree-notice">{treeError}</div>}
        <FileTree
          entries={entries}
          selectedPath={selectedPath}
          onSelect={(path) => {
            setTerminalDoc(null)
            setSelectedPath(path)
            setRevision((value) => value + 1)
          }}
        />
        {activePath && terminalDoc?.root === 'pane' && (
          <div className="files-tree-terminal-path" data-tip={terminalDoc.path}>
            {terminalDoc.name}
          </div>
        )}
      </aside>
      <FilePreviewPanel
        path={activePath}
        preview={preview}
        loading={loading}
        onReload={() => setRevision((value) => value + 1)}
      />
    </div>
  )
}
