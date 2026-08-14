import { useMemo, useState } from 'react'
import type { FileTreeEntry } from '../../../preload/index'

interface Props {
  entries: readonly FileTreeEntry[]
  selectedPath: string | null
  onSelect: (path: string) => void
}

function parentPaths(path: string): string[] {
  const parts = path.split('/')
  const parents: string[] = []
  for (let i = 1; i < parts.length; i++) parents.push(parts.slice(0, i).join('/'))
  return parents
}

function fileGlyph(entry: FileTreeEntry): string {
  if (entry.kind === 'directory') return '▸'
  if (entry.previewKind === 'markdown') return 'M'
  if (entry.previewKind === 'code') return '{}'
  if (entry.previewKind === 'image') return '◈'
  if (entry.previewKind === 'binary') return '◇'
  return '·'
}

/** Árvore de navegação sem ações de escrita. Pastas só controlam visibilidade. */
export default function FileTree({ entries, selectedPath, onSelect }: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  const visible = useMemo(() => {
    return entries.filter((entry) =>
      parentPaths(entry.path).every((parent) => !collapsed.has(parent))
    )
  }, [collapsed, entries])

  const toggleDirectory = (path: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  if (entries.length === 0) {
    return <div className="file-tree-empty">nenhum arquivo legível nesta raiz</div>
  }

  return (
    <div className="file-tree" role="tree" aria-label="Arquivos do projeto">
      {visible.map((entry) => {
        const isDirectory = entry.kind === 'directory'
        const isSelected = !isDirectory && selectedPath === entry.path
        const isCollapsed = collapsed.has(entry.path)
        return (
          <button
            key={entry.path}
            type="button"
            role="treeitem"
            aria-level={entry.depth + 1}
            aria-expanded={isDirectory ? !isCollapsed : undefined}
            aria-selected={isSelected}
            className={`file-tree-row${isSelected ? ' is-selected' : ''}${isDirectory ? ' is-directory' : ''}`}
            style={{ paddingLeft: `${10 + entry.depth * 15}px` }}
            data-tip={entry.path}
            onClick={() => {
              if (isDirectory) toggleDirectory(entry.path)
              else onSelect(entry.path)
            }}
          >
            <span className="file-tree-glyph" aria-hidden="true">
              {isDirectory ? (isCollapsed ? '▸' : '▾') : fileGlyph(entry)}
            </span>
            <span className="file-tree-name">{entry.name}</span>
            {!isDirectory && entry.size != null && (
              <span className="file-tree-size">{formatSize(entry.size)}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`
}
