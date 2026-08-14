import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  FileActionResult,
  FileActionScope,
  FileActionTreeEntry
} from '../../../preload/index'
import FileActionModal from './FileActionModal'
import FileContextMenu from './FileContextMenu'
import {
  actionsForFileTreeNode,
  type FileTreeAction,
  type FileTreeChange,
  type FileTreeNode
} from './fileTreeTypes'

interface Props {
  scope: FileActionScope
  activePath?: string | null
  onOpenFile?(entry: FileActionTreeEntry): void
  onChanged?(change: FileTreeChange): void
}

interface MenuState {
  node: FileTreeNode
  x: number
  y: number
  opener: HTMLElement
}

interface ModalState {
  action: FileTreeAction
  node: FileTreeNode
  opener: HTMLElement
}

function sameScope(left: FileActionScope, right: FileActionScope): boolean {
  return left.projectId === right.projectId && left.missionId === right.missionId
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function rootNode(scope: FileActionScope): FileTreeNode {
  return {
    path: '',
    parentPath: '',
    name: scope.missionId ? 'worktree da missão' : 'raiz do projeto',
    kind: 'directory',
    depth: 0,
    size: 0,
    mtime: 0,
    root: true
  }
}

export default function FileTree({
  scope,
  activePath,
  onOpenFile,
  onChanged
}: Props): React.JSX.Element {
  const [entries, setEntries] = useState<FileActionTreeEntry[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))
  const [focusPath, setFocusPath] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [modal, setModal] = useState<ModalState | null>(null)
  const requestRef = useRef(0)
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())

  const load = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current
    setLoading(true)
    setError(null)
    try {
      const snapshot = await window.synkora.files.tree(scope)
      if (request !== requestRef.current) return
      if (!snapshot.ok) {
        setEntries([])
        setTruncated(false)
        setError(snapshot.error ?? 'Não foi possível carregar a árvore.')
      } else {
        setEntries(snapshot.entries)
        setTruncated(snapshot.truncated)
      }
    } catch {
      if (request === requestRef.current) {
        setEntries([])
        setTruncated(false)
        setError('Não foi possível carregar a árvore.')
      }
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [scope])

  useEffect(() => {
    setExpanded(new Set(['']))
    setFocusPath('')
    setMenu(null)
    setModal(null)
    void load()
    return () => {
      requestRef.current += 1
    }
  }, [load])

  useEffect(
    () => window.synkora.files.onChanged((changedScope) => {
      if (sameScope(scope, changedScope)) void load()
    }),
    [load, scope]
  )

  const root = useMemo(() => rootNode(scope), [scope])
  const childrenByParent = useMemo(() => {
    const result = new Map<string, FileTreeNode[]>()
    for (const entry of entries) {
      const siblings = result.get(entry.parentPath) ?? []
      siblings.push(entry)
      result.set(entry.parentPath, siblings)
    }
    for (const siblings of result.values()) {
      siblings.sort((left, right) => {
        const leftRank = left.kind === 'directory' ? 0 : left.kind === 'file' ? 1 : 2
        const rightRank = right.kind === 'directory' ? 0 : right.kind === 'file' ? 1 : 2
        return leftRank - rightRank || left.name.localeCompare(right.name, 'pt-BR', {
          sensitivity: 'base',
          numeric: true
        })
      })
    }
    return result
  }, [entries])

  const visibleNodes = useMemo(() => {
    const result: FileTreeNode[] = [root]
    const append = (directoryPath: string): void => {
      if (!expanded.has(directoryPath)) return
      for (const child of childrenByParent.get(directoryPath) ?? []) {
        result.push(child)
        if (child.kind === 'directory') append(child.path)
      }
    }
    append('')
    return result
  }, [childrenByParent, expanded, root])

  useEffect(() => {
    if (!visibleNodes.some((node) => node.path === focusPath)) setFocusPath('')
  }, [focusPath, visibleNodes])

  const focusNode = (path: string): void => {
    setFocusPath(path)
    requestAnimationFrame(() => itemRefs.current.get(path)?.focus({ preventScroll: true }))
  }

  const toggle = (node: FileTreeNode): void => {
    if (node.kind !== 'directory') return
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(node.path)) next.delete(node.path)
      else next.add(node.path)
      return next
    })
  }

  const openMenu = (
    node: FileTreeNode,
    opener: HTMLElement,
    point?: { x: number; y: number }
  ): void => {
    const actions = actionsForFileTreeNode(node)
    if (actions.length === 0) return
    const rect = opener.getBoundingClientRect()
    setMenu({
      node,
      opener,
      x: point?.x ?? Math.min(rect.right, window.innerWidth - 8),
      y: point?.y ?? Math.min(rect.bottom, window.innerHeight - 8)
    })
  }

  const closeMenu = useCallback((restoreFocus: boolean): void => {
    setMenu((current) => {
      if (restoreFocus && current?.opener.isConnected) current.opener.focus()
      return null
    })
  }, [])

  const closeModal = (): void => {
    setModal((current) => {
      if (current?.opener.isConnected) current.opener.focus()
      else focusNode(focusPath)
      return null
    })
  }

  const runAction = async (
    action: FileTreeAction,
    node: FileTreeNode,
    name: string
  ): Promise<FileActionResult> => {
    let result: FileActionResult
    switch (action) {
      case 'create-file':
        result = await window.synkora.files.createFile(scope, node.path, name)
        break
      case 'create-folder':
        result = await window.synkora.files.createFolder(scope, node.path, name)
        break
      case 'rename':
        result = await window.synkora.files.rename(scope, node.path, name)
        break
      case 'trash':
        result = await window.synkora.files.trash(scope, node.path)
        break
      case 'copy-path':
        result = await window.synkora.files.copyPath(scope, node.path)
        break
      case 'download-zip':
        result = await window.synkora.files.downloadZip(scope, node.path)
        break
    }

    if (result.ok) {
      if (action === 'rename' && result.path && result.previousPath) {
        const renamedPath = result.path
        const previousPath = result.previousPath
        setExpanded((current) => {
          const next = new Set<string>()
          for (const path of current) {
            if (path === previousPath) next.add(renamedPath)
            else if (path.startsWith(`${previousPath}/`)) {
              next.add(`${renamedPath}${path.slice(previousPath.length)}`)
            } else next.add(path)
          }
          return next
        })
        setFocusPath(result.path)
      } else if (action === 'trash') {
        setFocusPath(parentPath(result.previousPath ?? node.path))
      } else if (action === 'create-file' || action === 'create-folder') {
        setExpanded((current) => new Set(current).add(node.path))
        if (result.path) setFocusPath(result.path)
      }
      if (action !== 'copy-path' && action !== 'download-zip') await load()
      onChanged?.({ action, path: result.path, previousPath: result.previousPath })
    }
    return result
  }

  return (
    <section className="file-tree-shell" aria-label="Árvore de arquivos">
      <div className="file-tree-head">
        <span>arquivos</span>
        <button
          type="button"
          className="term-btn ghost-dim"
          aria-label="Recarregar árvore de arquivos"
          data-tip="Recarregar árvore"
          disabled={loading}
          onClick={() => void load()}
        >
          ↻
        </button>
      </div>

      {error && (
        <div className="file-tree-message error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn ghost tiny" onClick={() => void load()}>
            tentar de novo
          </button>
        </div>
      )}

      <div
        className={`file-tree${loading ? ' loading' : ''}`}
        role="tree"
        aria-label={scope.missionId ? 'Arquivos do worktree da missão' : 'Arquivos do projeto'}
        aria-busy={loading}
      >
        {visibleNodes.map((node, index) => {
          const isDirectory = node.kind === 'directory'
          const isExpanded = isDirectory && expanded.has(node.path)
          const blocked = node.kind === 'blocked'
          const isActive = activePath === node.path
          return (
            <div
              key={node.root ? '__root__' : node.path}
              className={`file-tree-row${isActive ? ' active' : ''}${blocked ? ' blocked' : ''}`}
              style={{ '--file-depth': node.depth } as React.CSSProperties}
            >
              <button
                ref={(element) => {
                  if (element) itemRefs.current.set(node.path, element)
                  else itemRefs.current.delete(node.path)
                }}
                type="button"
                role="treeitem"
                className="file-tree-item"
                tabIndex={focusPath === node.path ? 0 : -1}
                aria-level={node.depth + 1}
                aria-expanded={isDirectory ? isExpanded : undefined}
                aria-selected={isActive}
                aria-disabled={blocked || undefined}
                aria-label={blocked ? `${node.name}, link indisponível` : node.name}
                title={blocked ? `${node.path} — link indisponível` : node.path || node.name}
                onFocus={() => setFocusPath(node.path)}
                onClick={() => {
                  if (blocked) return
                  if (isDirectory) toggle(node)
                  else onOpenFile?.(node)
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  if (!blocked) openMenu(node, event.currentTarget, { x: event.clientX, y: event.clientY })
                }}
                onKeyDown={(event) => {
                  const currentIndex = visibleNodes.findIndex((candidate) => candidate.path === node.path)
                  if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
                    event.preventDefault()
                    openMenu(node, event.currentTarget)
                  } else if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    focusNode(visibleNodes[Math.min(currentIndex + 1, visibleNodes.length - 1)].path)
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    focusNode(visibleNodes[Math.max(currentIndex - 1, 0)].path)
                  } else if (event.key === 'Home') {
                    event.preventDefault()
                    focusNode(visibleNodes[0].path)
                  } else if (event.key === 'End') {
                    event.preventDefault()
                    focusNode(visibleNodes.at(-1)?.path ?? '')
                  } else if (event.key === 'ArrowRight' && isDirectory) {
                    event.preventDefault()
                    if (!isExpanded) toggle(node)
                    else focusNode(childrenByParent.get(node.path)?.[0]?.path ?? node.path)
                  } else if (event.key === 'ArrowLeft') {
                    event.preventDefault()
                    if (isDirectory && isExpanded) toggle(node)
                    else focusNode(node.root ? '' : node.parentPath)
                  } else if ((event.key === 'Enter' || event.key === ' ') && !blocked) {
                    event.preventDefault()
                    if (isDirectory) toggle(node)
                    else onOpenFile?.(node)
                  } else if (event.key === 'F2' && !node.root && !blocked) {
                    event.preventDefault()
                    setModal({ action: 'rename', node, opener: event.currentTarget })
                  } else if (event.key === 'Delete' && !node.root && !blocked) {
                    event.preventDefault()
                    setModal({ action: 'trash', node, opener: event.currentTarget })
                  }
                }}
              >
                <span className="file-tree-chevron" aria-hidden="true">
                  {isDirectory ? (isExpanded ? '⌄' : '›') : blocked ? '×' : '·'}
                </span>
                <span className="file-tree-kind" aria-hidden="true">
                  {isDirectory ? '▱' : blocked ? '↗' : '□'}
                </span>
                <span className="file-tree-name">{node.name}</span>
              </button>
              {!blocked && (
                <button
                  type="button"
                  className="file-tree-actions"
                  aria-label={`Ações de ${node.name}`}
                  title={`Ações de ${node.name}`}
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation()
                    openMenu(node, event.currentTarget)
                  }}
                >
                  ···
                </button>
              )}
            </div>
          )
        })}

        {!error && !loading && entries.length === 0 && (
          <p className="file-tree-empty">Esta pasta está vazia. Use o menu da raiz para criar algo.</p>
        )}
      </div>

      {loading && <div className="file-tree-loading" role="status">carregando árvore…</div>}
      {truncated && (
        <div className="file-tree-message" role="status">
          A árvore atingiu o limite de exibição. As ações continuam restritas aos itens visíveis.
        </div>
      )}
      <div className="file-tree-hint">botão direito · Shift+F10 · F2 renomeia · Del envia à Lixeira</div>

      {menu && (
        <FileContextMenu
          node={menu.node}
          actions={actionsForFileTreeNode(menu.node)}
          x={menu.x}
          y={menu.y}
          onDismiss={closeMenu}
          onChoose={(action) => {
            setModal({ action, node: menu.node, opener: menu.opener })
            setMenu(null)
          }}
        />
      )}
      {modal && (
        <FileActionModal
          action={modal.action}
          node={modal.node}
          onRun={runAction}
          onClose={closeModal}
        />
      )}
    </section>
  )
}
