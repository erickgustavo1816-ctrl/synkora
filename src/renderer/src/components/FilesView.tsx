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
import Select, { type SelectOption } from './Select'
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

  const selectedRootValue =
    selectedRoot.kind === 'project' ? 'project' : selectedRoot.missionId

  // Mesmo padrão do ModelSelect: a lista chega por IPC, então o valor já
  // escolhido (missão vinda da prop) ganha uma opção provisória em vez de o
  // gatilho cair no placeholder e parecer que a origem se perdeu.
  const rootOptions = useMemo<SelectOption[]>(() => {
    const options: SelectOption[] = [
      { value: 'project', label: 'raiz do projeto', hint: 'repositório' }
    ]
    for (const mission of missionOptions) {
      options.push({
        value: mission.id,
        label: mission.title,
        hint: mission.branch ?? 'missão'
      })
    }
    if (selectedRootValue !== 'project' && !options.some((o) => o.value === selectedRootValue)) {
      options.push({
        value: selectedRootValue,
        label: 'worktree da missão',
        hint: 'carregando…'
      })
    }
    return options
  }, [missionOptions, selectedRootValue])

  const changeRoot = useCallback((value: string): void => {
    setSelectedRoot(
      value === 'project' ? { kind: 'project' } : { kind: 'mission', missionId: value }
    )
    setSelectedPath(null)
    setTerminalDoc(null)
    setPreview(null)
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

  return (
    <div className="files-view files-view-tree">
      <aside className="files-tree-pane">
        <ActionFileTree
          scope={scope}
          activePath={selectedPath}
          sourceControl={(
            <span className="files-root-picker">
              <span className="files-root-picker-label">origem</span>
              <Select
                className="files-root-select"
                tip="Origem dos arquivos"
                value={selectedRootValue}
                options={rootOptions}
                onChange={changeRoot}
              />
            </span>
          )}
          sourceNotice={terminalDoc ? (
            <div className="files-terminal-source" data-tip={terminalDoc.path}>
              <span aria-hidden="true">↳</span>
              <span>aberto pelo terminal</span>
            </div>
          ) : null}
          onOpenFile={(entry: FileActionTreeEntry) => {
            setTerminalDoc(null)
            setSelectedPath(entry.path)
            setRevision((value) => value + 1)
          }}
          onChanged={handleTreeChange}
        />
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
