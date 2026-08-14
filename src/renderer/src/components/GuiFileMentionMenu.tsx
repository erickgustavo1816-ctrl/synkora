import { useEffect, useRef } from 'react'

interface Props {
  id: string
  files: readonly string[]
  index: number
  loading: boolean
  error: string | null
  onPick: (path: string) => void
  onHover: (index: number) => void
}

function basename(path: string): string {
  return path.split('/').at(-1) ?? path
}

/** Menu de @arquivo. O clique preserva o foco/cursor do textarea. */
export default function GuiFileMentionMenu({
  id,
  files,
  index,
  loading,
  error,
  onPick,
  onHover
}: Props): React.JSX.Element {
  const activeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [index])

  return (
    <div id={id} className="gui-file-mention-menu" role="listbox" aria-label="Arquivos do projeto">
      {loading && <div className="gui-file-mention-empty">lendo arquivos do projeto…</div>}
      {!loading && error && <div className="gui-file-mention-empty">{error}</div>}
      {!loading && !error && files.length === 0 && (
        <div className="gui-file-mention-empty">nenhum arquivo encontrado</div>
      )}
      {!loading && !error && files.map((path, itemIndex) => (
        <button
          key={path}
          ref={itemIndex === index ? activeRef : undefined}
          id={`${id}-option-${itemIndex}`}
          className={`gui-file-mention-item${itemIndex === index ? ' active' : ''}`}
          type="button"
          role="option"
          aria-selected={itemIndex === index}
          title={path}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(itemIndex)}
          onClick={() => onPick(path)}
        >
          <span className="gui-file-mention-name">{basename(path)}</span>
          <span className="gui-file-mention-path">{path}</span>
        </button>
      ))}
    </div>
  )
}
