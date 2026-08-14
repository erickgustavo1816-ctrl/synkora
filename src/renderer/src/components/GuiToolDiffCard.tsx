import { useMemo, useState } from 'react'
import {
  guiDiffBasename,
  renderGuiFileDiff,
  type GuiFileDiffOperation,
  type GuiRenderedFileDiff
} from '../guiToolDiff'
import { guiToolOutcomeView } from '../guiToolOutcome'
import type { GuiToolItem } from '../guiToolPresentation'

const OPERATION_LABEL: Record<GuiFileDiffOperation, string> = {
  edit: 'editou',
  write: 'gravou',
  patch: 'aplicou patch',
  add: 'criou',
  update: 'alterou',
  delete: 'removeu',
  move: 'moveu'
}

function DiffLine({ line }: { line: GuiRenderedFileDiff['lines'][number] }): React.JSX.Element {
  const spoken =
    line.kind === 'add'
      ? 'linha adicionada: '
      : line.kind === 'remove'
        ? 'linha removida: '
        : line.kind === 'meta'
          ? 'metadado do diff: '
          : ''
  const sign = line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : line.kind === 'meta' ? '·' : ' '
  return (
    <div className={`gui-diff-line ${line.kind}`}>
      <span className="gui-diff-number" aria-hidden="true">{line.oldNumber ?? ''}</span>
      <span className="gui-diff-number" aria-hidden="true">{line.newNumber ?? ''}</span>
      <span className="gui-diff-sign" aria-hidden="true">{sign}</span>
      {spoken && <span className="gui-sr-only">{spoken}</span>}
      <code>{line.text || ' '}</code>
    </div>
  )
}

function FileDiff({ diff }: { diff: GuiRenderedFileDiff }): React.JSX.Element {
  const movePath = diff.source.format === 'unified' ? diff.source.movePath : undefined
  const path = movePath
    ? `${diff.source.path} → ${movePath}`
    : diff.source.path
  return (
    <section className="gui-file-diff" aria-label={`Diff de ${path}`}>
      <header>
        <span title={path}>{path}</span>
        <span>{OPERATION_LABEL[diff.source.operation]}</span>
        <b className="gui-diff-add">+{diff.additions}</b>
        <b className="gui-diff-remove">−{diff.removals}</b>
      </header>
      {diff.source.format === 'before-after' && diff.source.oldText === null && (
        <p className="gui-diff-note">estado anterior não informado pelo CLI</p>
      )}
      {diff.simplified && (
        <p className="gui-diff-note">comparação simplificada para manter a interface responsiva</p>
      )}
      <div className="gui-diff-code">
        {diff.lines.map((line, index) => (
          <DiffLine key={`${index}:${line.kind}:${line.oldNumber}:${line.newNumber}`} line={line} />
        ))}
      </div>
      {diff.source.truncated && (
        <p className="gui-diff-note">diff resumido por limite de tamanho</p>
      )}
    </section>
  )
}

export default function GuiToolDiffCard({ item }: { item: GuiToolItem }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const sources = item.fileDiffs ?? []
  const diffs = useMemo(
    () => (expanded ? sources.map(renderGuiFileDiff) : []),
    [expanded, item.id, item.fileDiffs]
  )
  const additions = diffs.reduce((sum, diff) => sum + diff.additions, 0)
  const removals = diffs.reduce((sum, diff) => sum + diff.removals, 0)
  const outcome = guiToolOutcomeView(item.result)
  const title =
    sources.length === 1
      ? guiDiffBasename(sources[0].path)
      : `${sources.length} arquivos`
  const operation = sources.length === 1 ? OPERATION_LABEL[sources[0].operation] : 'alterações'
  return (
    <details
      className={`gui-diff-card${outcome ? ` ${outcome.tone}` : ''}`}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span className="gui-diff-chevron" aria-hidden="true">›</span>
        <span className="gui-diff-icon" aria-hidden="true">✎</span>
        <b title={diffs.length === 1 ? diffs[0].source.path : undefined}>{title}</b>
        <span className="gui-diff-operation">{operation}</span>
        {expanded && (
          <span className="gui-diff-totals">
            <b className="gui-diff-add">+{additions}</b>
            <b className="gui-diff-remove">−{removals}</b>
          </span>
        )}
        {!outcome ? (
          <span className="gui-diff-status running" role="status" aria-live="polite">rodando</span>
        ) : (
          <span className={`gui-diff-status ${outcome.tone}`} role="status" aria-live="polite">
            {outcome.statusLabel}
          </span>
        )}
      </summary>
      {expanded && (
        <div className="gui-diff-files">
          {diffs.map((diff, index) => (
            <FileDiff key={`${index}:${diff.source.path}`} diff={diff} />
          ))}
        </div>
      )}
    </details>
  )
}
