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
 * Régua única da origem, espelho do main (`resolveFileActionRoot`): só missão
 * VIVA com worktree PRÓPRIO é raiz navegável. Encerrada (arquivada/concluída/
 * integrando) e missão sem worktree não abrem aqui — a raiz do projeto já é a
 * primeira opção da lista. O main recusa de qualquer jeito; o filtro existe
 * para não oferecer um clique que vai virar erro.
 */
function isBrowsableMissionRoot(mission: Mission, projectId: string): boolean {
  return (
    mission.projectId === projectId
    && mission.status === 'ativa'
    && typeof mission.worktree === 'string'
    && mission.worktree.length > 0
  )
}

/**
 * Aba Arquivos: árvore com ações explícitas e preview sempre somente leitura.
 * A main resolve a raiz por IDs; caminhos físicos nunca atravessam esta tela.
 */
export default function FilesView({ projectId, missionId }: Props): React.JSX.Element {
  /** `null` = a lista ainda não chegou (não confundir com projeto sem missão). */
  const [missionOptions, setMissionOptions] = useState<Mission[] | null>(null)
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

  // A lista de origens muda por FORA desta aba (arquivar por agente, integrar,
  // reativar). Sem assinar missions:changed, a pasta encerrada ficaria na tela
  // até a aba remontar — e a missão reativada não voltaria a aparecer.
  useEffect(() => {
    let stale = false
    const refresh = (): void => {
      void window.synkora.missions.list(projectId).then((missions) => {
        if (!stale) setMissionOptions(missions)
      }).catch(() => {
        if (!stale) setMissionOptions([])
      })
    }
    refresh()
    const off = window.synkora.missions?.onChanged?.((changedProjectId: string) => {
      if (changedProjectId === projectId) refresh()
    })
    return () => {
      stale = true
      off?.()
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

  const browsableMissions = useMemo<Mission[]>(
    () => (missionOptions ?? []).filter((mission) => isBrowsableMissionRoot(mission, projectId)),
    [missionOptions, projectId]
  )

  // Mesmo padrão do ModelSelect: a lista chega por IPC, então o valor já
  // escolhido (missão vinda da prop) ganha uma opção provisória em vez de o
  // gatilho cair no placeholder e parecer que a origem se perdeu.
  const rootOptions = useMemo<SelectOption[]>(() => {
    const options: SelectOption[] = [
      { value: 'project', label: 'raiz do projeto', hint: 'repositório' }
    ]
    for (const mission of browsableMissions) {
      options.push({
        value: mission.id,
        label: mission.title,
        hint: mission.branch ?? 'missão'
      })
    }
    if (selectedRootValue !== 'project' && !options.some((o) => o.value === selectedRootValue)) {
      // Missão conhecida e fora da lista = encerrada/sem pasta: dizer
      // "carregando…" ali seria mentira, a origem não vai chegar.
      const closed = (missionOptions ?? []).some((mission) => mission.id === selectedRootValue)
      options.push({
        value: selectedRootValue,
        label: closed ? 'missão encerrada' : 'worktree da missão',
        hint: closed ? 'sem pasta para abrir' : 'carregando…'
      })
    }
    return options
  }, [browsableMissions, missionOptions, selectedRootValue])

  /** Volta para a raiz do projeto limpando leitura e seleção. Serve ao picker e
   *  à saída automática quando a origem aberta deixa de ser navegável. */
  const resetToProjectRoot = useCallback((): void => {
    setSelectedRoot({ kind: 'project' })
    setSelectedPath(null)
    setTerminalDoc(null)
    setPreview(null)
  }, [])

  const changeRoot = useCallback((value: string): void => {
    if (value === 'project') {
      resetToProjectRoot()
      return
    }
    setSelectedRoot({ kind: 'mission', missionId: value })
    setSelectedPath(null)
    setTerminalDoc(null)
    setPreview(null)
  }, [resetToProjectRoot])

  // A missão aberta pode ser arquivada/integrada com a aba na tela. Quando a
  // lista já chegou e a origem selecionada deixou de ser navegável, a aba cai
  // para a raiz do projeto em vez de insistir numa árvore que o main recusa.
  useEffect(() => {
    if (missionOptions === null || selectedRoot.kind !== 'mission') return
    const current = missionOptions.find((mission) => mission.id === selectedRoot.missionId)
    if (current && isBrowsableMissionRoot(current, projectId)) return
    resetToProjectRoot()
  }, [missionOptions, projectId, resetToProjectRoot, selectedRoot])

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
