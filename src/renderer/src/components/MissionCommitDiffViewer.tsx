import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  COMMIT_DIFF_LINES_PER_FILE,
  commitDiffInitialOpen,
  commitFileKindView,
  commitFilePathLabel,
  ellipsizeMiddle,
  takeCommitDiffLines,
  type CommitDiffFile,
  type CommitDiffLine,
  type CommitDiffSummary
} from '../guiDiffPresentation'
import type { MissionCommit } from '../missionHistory'

// VISUALIZADOR DE COMMIT — a superfície LARGA do histórico da missão.
//
// O trilho tem ~200px: ali cabe o resumo, não o diff. Aqui é o contrário — a
// janela ocupa a tela para o que o dono pediu ("pensa numa forma melhor da
// gente ver o commit"): um arquivo de cada vez, cabeçalho grudado no topo
// enquanto se rola, linha adicionada em verde com `+`, removida em vermelho
// com `−`, contexto neutro, e o `@@` como marco discreto em vez de ruído.
//
// SOMENTE LEITURA, sem exceção: não existe aqui nenhum botão de stage, commit,
// reverter ou aplicar. A janela lê o patch que o main já provou pertencer a
// `base..HEAD` desta missão e desenha — nada mais.
//
// TETO DE RENDER: o patch chega cortado em 200KB pelo main, mas mesmo 200KB de
// texto viram milhares de <div>. Cada arquivo desenha no máximo
// COMMIT_DIFF_LINES_PER_FILE linhas e oferece "… +N linhas"; arquivos além do
// orçamento inicial nascem recolhidos. Nenhum corte é silencioso.

/** Corte do caminho no índice lateral (240px de coluna, mono de 10,5px). */
const INDEX_PATH_CHARS = 34

const DATE_FORMAT = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})

function formatFullDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : DATE_FORMAT.format(date)
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => !element.closest('[inert]'))
}

const SIGN: Record<CommitDiffLine['kind'], string> = {
  add: '+',
  remove: '−',
  context: ' ',
  note: '\\'
}

const SPOKEN: Record<CommitDiffLine['kind'], string> = {
  add: 'linha adicionada: ',
  remove: 'linha removida: ',
  context: '',
  note: 'recado do git: '
}

function DiffLineRow({ line }: { line: CommitDiffLine }): React.JSX.Element {
  return (
    <div className={`cdv-line ${line.kind}`}>
      <span className="cdv-num" aria-hidden="true">
        {line.oldNumber ?? ''}
      </span>
      <span className="cdv-num" aria-hidden="true">
        {line.newNumber ?? ''}
      </span>
      <span className="cdv-sign" aria-hidden="true">
        {SIGN[line.kind]}
      </span>
      {SPOKEN[line.kind] && <span className="gui-sr-only">{SPOKEN[line.kind]}</span>}
      <code>{line.text || ' '}</code>
    </div>
  )
}

function FileSection({
  file,
  index,
  open,
  full,
  onToggle,
  onExpandLines,
  registerRef
}: {
  file: CommitDiffFile
  index: number
  open: boolean
  full: boolean
  onToggle: (index: number) => void
  onExpandLines: (index: number) => void
  registerRef: (index: number, node: HTMLElement | null) => void
}): React.JSX.Element {
  const kind = commitFileKindView(file.kind)
  const label = commitFilePathLabel(file)
  // Recolhido não fatia nada: num commit de 40 arquivos, montar 400 linhas por
  // arquivo que ninguém vai ver é exatamente o custo que o teto veio evitar.
  const view = useMemo(
    () =>
      open
        ? takeCommitDiffLines(file, full ? Number.POSITIVE_INFINITY : COMMIT_DIFF_LINES_PER_FILE)
        : { hunks: [], hidden: 0 },
    [file, full, open]
  )
  return (
    <section
      className="cdv-file"
      ref={(node) => registerRef(index, node)}
      aria-label={`Diff de ${label}`}
    >
      <header className="cdv-file-head">
        <button
          type="button"
          className="cdv-file-toggle"
          aria-expanded={open}
          data-tip={`${label}\n(clique para ${open ? 'recolher' : 'abrir'} este arquivo)`}
          onClick={() => onToggle(index)}
        >
          <span className="cdv-chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <i className={`cdv-kind ${kind.cls}`} aria-hidden="true">
            {kind.glyph}
          </i>
          <span className="cdv-file-path">{label}</span>
        </button>
        <span className="cdv-file-kind">{kind.label}</span>
        <span className="cdv-file-score">
          <b className="cdv-plus">+{file.insertions}</b>
          <b className="cdv-minus">−{file.deletions}</b>
        </span>
      </header>
      {open && file.note && <p className="cdv-note">{file.note}</p>}
      {open && view.hunks.length > 0 && (
        <div className="cdv-code">
          {view.hunks.map((hunk, hunkIndex) => (
            <div className="cdv-hunk" key={`${hunk.header}:${hunkIndex}`}>
              <div className="cdv-hunk-head">
                <span className="cdv-hunk-range">{hunk.range}</span>
                {hunk.section && <span className="cdv-hunk-section">{hunk.section}</span>}
              </div>
              {hunk.lines.map((line, lineIndex) => (
                <DiffLineRow key={`${hunkIndex}:${lineIndex}`} line={line} />
              ))}
            </div>
          ))}
        </div>
      )}
      {open && view.hidden > 0 && (
        <button
          type="button"
          className="cdv-more"
          data-tip="Desenha o resto deste arquivo nesta janela"
          onClick={() => onExpandLines(index)}
        >
          … +{view.hidden} {view.hidden === 1 ? 'linha' : 'linhas'}
        </button>
      )}
    </section>
  )
}

/**
 * A janela em si. Ela é DONA do Esc enquanto está de pé (`role="dialog"` +
 * `.overlay` são exatamente o que o `guiEscape` procura antes de mandar o Esc
 * para o chat), devolve o foco a quem a abriu e nunca deixa o Tab escapar.
 */
export default function MissionCommitDiffViewer({
  commit,
  summary,
  focusPath,
  onClose
}: {
  commit: MissionCommit
  summary: CommitDiffSummary
  /** Arquivo que o clique no trilho pediu: abre e rola até ele. */
  focusPath?: string
  onClose: () => void
}): React.JSX.Element {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef(new Map<number, HTMLElement>())
  const files = summary.files
  const focusIndex = focusPath ? files.findIndex((file) => file.path === focusPath) : -1

  const [open, setOpen] = useState<boolean[]>(() => {
    const initial = commitDiffInitialOpen(files)
    if (focusIndex >= 0) initial[focusIndex] = true
    return initial
  })
  const [full, setFull] = useState<boolean[]>(() => files.map(() => false))

  const registerRef = useCallback((index: number, node: HTMLElement | null): void => {
    if (node) sectionRefs.current.set(index, node)
    else sectionRefs.current.delete(index)
  }, [])

  const toggleFile = useCallback((index: number): void => {
    setOpen((current) => current.map((value, at) => (at === index ? !value : value)))
  }, [])

  const expandLines = useCallback((index: number): void => {
    setFull((current) => current.map((value, at) => (at === index ? true : value)))
  }, [])

  const jumpTo = useCallback((index: number): void => {
    setOpen((current) => current.map((value, at) => (at === index ? true : value)))
    sectionRefs.current.get(index)?.scrollIntoView({ block: 'start' })
  }, [])

  // Foco, Esc e Tab presos à janela — mesmo contrato do lightbox de anexo.
  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusTimer = window.setTimeout(() => {
      const dialog = dialogRef.current
      if (!dialog) return
      focusableElements(dialog)[0]?.focus()
    }, 0)

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = focusableElements(dialogRef.current)
      if (focusable.length === 0) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault()
        first?.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.clearTimeout(focusTimer)
      document.body.style.overflow = previousOverflow
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [onClose])

  // Abrir por um arquivo específico: a janela nasce olhando para ele.
  useEffect(() => {
    if (focusIndex < 0) return
    const timer = window.setTimeout(() => {
      sectionRefs.current.get(focusIndex)?.scrollIntoView({ block: 'start' })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [focusIndex])

  return createPortal(
    <div
      className="overlay cdv-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="term-window cdv-window" ref={dialogRef} tabIndex={-1}>
        <div className="term-titlebar cdv-head">
          <span className="dots mac" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="cdv-heading">
            <strong id={titleId}>{commit.subject || '(sem assunto)'}</strong>
            <span className="cdv-meta">
              <code data-tip={`SHA completo: ${commit.sha}`}>{commit.sha.slice(0, 12)}</code>
              <span>{commit.author || 'autor do Git'}</span>
              <time dateTime={commit.at}>{formatFullDate(commit.at)}</time>
              <span className="cdv-readonly">somente leitura</span>
            </span>
          </span>
          <span className="cdv-score">
            <b className="cdv-plus">+{summary.insertions}</b>
            <b className="cdv-minus">−{summary.deletions}</b>
            <span>
              {files.length} {files.length === 1 ? 'arquivo' : 'arquivos'}
            </span>
          </span>
          <button
            type="button"
            className="term-btn cdv-close"
            data-tip="Fechar (Esc)"
            onClick={onClose}
          >
            fechar
          </button>
        </div>

        <div className="cdv-body">
          {files.length > 1 && (
            <nav className="cdv-index" aria-label="Arquivos deste commit">
              {files.map((file, index) => {
                const kind = commitFileKindView(file.kind)
                const label = commitFilePathLabel(file)
                return (
                  <button
                    type="button"
                    key={`${index}:${file.path}`}
                    className="cdv-index-item"
                    data-tip={`${kind.label}: ${label}`}
                    onClick={() => jumpTo(index)}
                  >
                    <i className={`cdv-kind ${kind.cls}`} aria-hidden="true">
                      {kind.glyph}
                    </i>
                    <span className="cdv-index-path">{ellipsizeMiddle(file.path, INDEX_PATH_CHARS)}</span>
                    <span className="cdv-index-score">
                      <b className="cdv-plus">+{file.insertions}</b>
                      <b className="cdv-minus">−{file.deletions}</b>
                    </span>
                  </button>
                )
              })}
            </nav>
          )}
          <div className="cdv-scroll">
            {summary.truncated && (
              <p className="cdv-warning">
                o patch chegou cortado no teto de leitura — o commit continua inteiro no worktree
              </p>
            )}
            {summary.unreadable && (
              <p className="cdv-warning">
                não deu para separar este patch por arquivo; abra o commit no terminal da missão
              </p>
            )}
            {files.map((file, index) => (
              <FileSection
                key={`${index}:${file.path}`}
                file={file}
                index={index}
                open={open[index] ?? false}
                full={full[index] ?? false}
                onToggle={toggleFile}
                onExpandLines={expandLines}
                registerRef={registerRef}
              />
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
