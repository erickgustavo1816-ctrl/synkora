import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  FileActionResult,
  FileActionScope,
  FileActionTreeEntry
} from '../../../preload/index'
import FileActionModal from './FileActionModal'
import FileContextMenu from './FileContextMenu'
import { useFileTree } from './useFileTree'
import {
  actionsForFileTreeNode,
  type FileTreeAction,
  type FileTreeChange,
  type FileTreeNode
} from './fileTreeTypes'

interface Props {
  scope: FileActionScope
  activePath?: string | null
  sourceControl: ReactNode
  sourceNotice?: ReactNode
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

/** Só o que muda o DESENHO do glifo. Nunca altera permissão nem ação. */
type GlyphKind = 'directory' | 'directory-open' | 'blocked' | 'markdown' | 'code' | 'image' | 'file'

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'css', 'scss', 'html', 'py',
  'rs', 'go', 'java', 'rb', 'php', 'sh', 'ps1', 'yml', 'yaml', 'toml', 'sql', 'c', 'h', 'cpp'
])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'])

function glyphKindFor(node: FileTreeNode, expanded: boolean): GlyphKind {
  if (node.kind === 'blocked') return 'blocked'
  if (node.kind === 'directory') return expanded ? 'directory-open' : 'directory'
  const extension = node.name.split('.').at(-1)?.toLowerCase() ?? ''
  if (extension === 'md' || extension === 'mdx') return 'markdown'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  return 'file'
}

/** Traço mono do app: sem emoji, sem preenchimento, sempre currentColor. */
function TreeGlyph({ kind }: { kind: GlyphKind }): React.JSX.Element {
  if (kind === 'directory') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M2.75 5.75h5l1.5 1.75h8v7.75h-14.5z" />
      </svg>
    )
  }
  if (kind === 'directory-open') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M2.75 15.25v-9.5h5l1.5 1.75h6.25v2" />
        <path d="M4.5 15.25 6.5 9.5h11l-2 5.75z" />
      </svg>
    )
  }
  if (kind === 'blocked') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5.25 2.75h6l3.5 3.5v11h-9.5z" />
        <path d="m7.25 12.75 5.5-5.5m-5.5 0 5.5 5.5" />
      </svg>
    )
  }
  if (kind === 'markdown') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5.25 2.75h6l3.5 3.5v11h-9.5z" />
        <path d="M11.25 2.75v3.5h3.5" />
        <path d="M7.5 10.5h5M7.5 13h3.25" />
      </svg>
    )
  }
  if (kind === 'code') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5.25 2.75h6l3.5 3.5v11h-9.5z" />
        <path d="M11.25 2.75v3.5h3.5" />
        <path d="m9.25 9.75-1.5 1.75 1.5 1.75m2-3.5 1.5 1.75-1.5 1.75" />
      </svg>
    )
  }
  if (kind === 'image') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5.25 2.75h6l3.5 3.5v11h-9.5z" />
        <path d="M11.25 2.75v3.5h3.5" />
        <path d="m7 14 2.5-3 1.75 2 1-1.25 1.5 2.25z" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5.25 2.75h6l3.5 3.5v11h-9.5z" />
      <path d="M11.25 2.75v3.5h3.5" />
    </svg>
  )
}

function Chevron({ expanded }: { expanded: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d={expanded ? 'm4.5 6 3.5 3.5L11.5 6' : 'm6 4.5 3.5 3.5L6 11.5'} />
    </svg>
  )
}

function PlusIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path d="M9 3.5v11M3.5 9h11" />
    </svg>
  )
}

function ReloadIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path d="M14.25 6.25V2.9m0 0H10.9m3.35 0-2.1 2.1a5.6 5.6 0 1 0 1.15 6.05" />
    </svg>
  )
}

function MoreIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="4" cy="9" r="1" />
      <circle cx="9" cy="9" r="1" />
      <circle cx="14" cy="9" r="1" />
    </svg>
  )
}

export default function FileTree({
  scope,
  activePath,
  sourceControl,
  sourceNotice,
  onOpenFile,
  onChanged
}: Props): React.JSX.Element {
  const { entries, directories, loading, error, loadDirectory, refresh: load } = useFileTree(scope)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))
  const [focusPath, setFocusPath] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [modal, setModal] = useState<ModalState | null>(null)
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())

  useEffect(() => {
    setExpanded(new Set(['']))
    setFocusPath('')
    setMenu(null)
    setModal(null)
  }, [scope])

  useEffect(() => {
    for (const entry of entries) {
      if (entry.kind === 'directory' && expanded.has(entry.path)) void loadDirectory(entry.path)
    }
  }, [entries, expanded, loadDirectory])

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
    const result: FileTreeNode[] = []
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
    if (visibleNodes.some((node) => node.path === focusPath)) return
    setFocusPath(visibleNodes[0]?.path ?? '')
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

  const directoryStatus = (path: string): ReactNode => {
    const page = directories[path]
    if (!page || (!page.loading && !page.error && page.nextOffset === undefined)) return null
    return (
      <div className="files-nav-message" role="status">
        {page.loading ? <span>carregando…</span> : page.error ? (
          <>
            <span>{page.error}</span>
            <button type="button" className="btn ghost tiny"
              onClick={() => void loadDirectory(path, page.nextOffset === undefined ? 'retry' : 'more')}>
              tentar de novo
            </button>
          </>
        ) : (
          <button type="button" className="btn ghost tiny"
            aria-label={`Mostrar mais arquivos de ${path || 'raiz do projeto'}`}
            onClick={() => void loadDirectory(path, 'more')}>
            mostrar mais
          </button>
        )}
      </div>
    )
  }

  return (
    <section className="files-nav" aria-label="Árvore de arquivos">
      <header className="files-nav-header">
        <div className="files-nav-heading">
          <span className="files-nav-title">Arquivos</span>
          <span className="files-nav-count">
            {loading
              ? 'lendo…'
              : `${entries.length} ${entries.length === 1 ? 'item' : 'itens'} carregados`}
          </span>
        </div>
        <div className="files-nav-tools">
          <button
            type="button"
            className="files-nav-tool"
            aria-label="Criar arquivo ou pasta"
            data-tip="Criar arquivo ou pasta"
            onClick={(event) => openMenu(root, event.currentTarget)}
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            className="files-nav-tool"
            aria-label="Recarregar arquivos"
            data-tip="Recarregar arquivos"
            disabled={loading}
            onClick={() => void load()}
          >
            <ReloadIcon />
          </button>
        </div>
      </header>

      <div className="files-nav-source">{sourceControl}</div>
      {sourceNotice}

      {error && entries.length === 0 && (
        <div className="files-nav-message error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn ghost tiny" onClick={() => void load()}>
            tentar de novo
          </button>
        </div>
      )}

      <div
        className={`files-nav-tree${loading ? ' loading' : ''}`}
        role="tree"
        aria-label={scope.missionId ? 'Arquivos do worktree da missão' : 'Arquivos do projeto'}
        aria-busy={loading}
      >
        {visibleNodes.map((node, index) => {
          const isDirectory = node.kind === 'directory'
          const isExpanded = isDirectory && expanded.has(node.path)
          const blocked = node.kind === 'blocked'
          const hasActions = actionsForFileTreeNode(node).length > 0
          const isActive = activePath === node.path
          // Dotfolder/dotfile é infraestrutura: fica legível, mas nunca disputa
          // a leitura com o código do produto.
          const dotted = node.name.startsWith('.')
          return (
            <Fragment key={node.path}>
              <div
                className={`files-nav-row${isActive ? ' active' : ''}${blocked ? ' blocked' : ''}${dotted ? ' dotted' : ''}`}
                data-kind={node.kind}
                style={{ '--file-depth': node.depth } as React.CSSProperties}
              >
                <button
                  ref={(element) => {
                    if (element) itemRefs.current.set(node.path, element)
                    else itemRefs.current.delete(node.path)
                  }}
                  type="button"
                  role="treeitem"
                  className="files-nav-item"
                  tabIndex={focusPath === node.path ? 0 : -1}
                  aria-level={node.depth + 1}
                  aria-expanded={isDirectory ? isExpanded : undefined}
                  aria-selected={isActive}
                  aria-disabled={blocked || undefined}
                  aria-label={blocked ? `${node.name}, link indisponível` : node.name}
                  title={blocked ? `${node.path} — link indisponível` : `${node.path}${node.readOnly ? ' — somente leitura' : ''}`}
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
                      else if (visibleNodes.some((candidate) => candidate.path === node.parentPath)) {
                        focusNode(node.parentPath)
                      }
                    } else if ((event.key === 'Enter' || event.key === ' ') && !blocked) {
                      event.preventDefault()
                      if (isDirectory) toggle(node)
                      else onOpenFile?.(node)
                    } else if (event.key === 'F2' && !node.root && hasActions) {
                      event.preventDefault()
                      setModal({ action: 'rename', node, opener: event.currentTarget })
                    } else if (event.key === 'Delete' && !node.root && hasActions) {
                      event.preventDefault()
                      setModal({ action: 'trash', node, opener: event.currentTarget })
                    }
                  }}
                >
                  <span className="files-nav-chevron" aria-hidden="true">
                    {isDirectory ? <Chevron expanded={isExpanded} /> : null}
                  </span>
                  <span className="files-nav-kind" aria-hidden="true">
                    <TreeGlyph kind={glyphKindFor(node, isExpanded)} />
                  </span>
                  <span className="files-nav-name">{node.name}</span>
                </button>
                {hasActions && (
                  <button
                    type="button"
                    className="files-nav-actions"
                    aria-label={`Ações de ${node.name}`}
                    title={`Ações de ${node.name}`}
                    tabIndex={-1}
                    onClick={(event) => {
                      event.stopPropagation()
                      openMenu(node, event.currentTarget)
                    }}
                  >
                    <MoreIcon />
                  </button>
                )}
              </div>
              {isExpanded && directoryStatus(node.path)}
            </Fragment>
          )
        })}

        {!error && !loading && entries.length === 0 && (
          <div className="files-nav-empty">
            <TreeGlyph kind="directory-open" />
            <span>esta raiz está vazia — nada foi escrito aqui ainda</span>
            <button type="button" onClick={(event) => openMenu(root, event.currentTarget)}>
              criar o primeiro item
            </button>
          </div>
        )}
      </div>

      {(!error || entries.length > 0) && directoryStatus('')}

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
