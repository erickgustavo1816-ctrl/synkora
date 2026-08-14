import {
  countGuiOutputLines,
  guiToolGroupPreview,
  isGuiShellTool,
  type GuiToolGroup,
  type GuiToolItem
} from '../guiToolPresentation'
import { guiToolGroupOutcomeView, guiToolOutcomeView } from '../guiToolOutcome'
import GuiToolDiffCard from './GuiToolDiffCard'

function toolGlyph(name: string): string {
  const normalized = name.toLowerCase()
  if (/(edit|write|notebook|create|update)/u.test(normalized)) return '✎'
  if (/(read|cat|view|notebookread)/u.test(normalized)) return '▤'
  if (isGuiShellTool(name)) return '❯'
  if (/(grep|glob|search|find)/u.test(normalized)) return '⌕'
  if (/(web|fetch|http|url)/u.test(normalized)) return '⇗'
  if (/(task|agent|delegate|helper)/u.test(normalized)) return '✦'
  if (/(todo|plan)/u.test(normalized)) return '☰'
  return '▪'
}

function GuiCommandCard({ item }: { item: GuiToolItem }): React.JSX.Element {
  const result = item.result
  const outcome = guiToolOutcomeView(result)
  const lineCount = result?.lineCount ?? (result ? countGuiOutputLines(result.text) : 0)
  const hasOutput = Boolean(result?.text)
  const row = (
    <>
      <span className={`gui-command-chevron${hasOutput ? '' : ' empty'}`} aria-hidden="true">›</span>
      <span className="gui-command-dollar" aria-hidden="true">$</span>
      <span className="gui-command-text">{item.summary || item.name}</span>
      {!result ? (
        <span className="gui-command-status running" role="status" aria-live="polite">rodando</span>
      ) : (
        <span className={`gui-command-status ${outcome?.tone ?? 'ok'}`} role="status" aria-live="polite">
          {outcome?.statusLabel ?? 'concluído'}
        </span>
      )}
      {result && (
        <span className="gui-command-lines">
          {lineCount} {lineCount === 1 ? 'linha' : 'linhas'}
        </span>
      )}
    </>
  )

  const tone = outcome?.tone
  if (!hasOutput) return <div className={`gui-command${tone ? ` ${tone}` : ''}`}>{row}</div>
  return (
    <details className={`gui-command${tone ? ` ${tone}` : ''}`}>
      <summary>{row}</summary>
      <pre className="gui-command-output">{result?.text}</pre>
      {result?.truncated && (
        <span className="gui-command-truncated">saída resumida · {lineCount} linhas no total</span>
      )}
    </details>
  )
}

function GuiGenericToolCard({ item }: { item: GuiToolItem }): React.JSX.Element {
  const outcome = guiToolOutcomeView(item.result)
  const row = (
    <>
      <span className={`gui-tool-icon${item.result ? '' : ' run'}`} aria-hidden="true">
        {item.result ? toolGlyph(item.name) : '◌'}
      </span>
      <b className="gui-tool-name">{item.name}</b>
      {item.summary && <span className="gui-tool-sep">·</span>}
      <span className="gui-tool-summary">{item.summary}</span>
      {outcome && (
        <span className={`gui-tool-out ${outcome.tone}`} role="status" aria-live="polite">
          {outcome.compactLabel}
        </span>
      )}
    </>
  )
  if (!item.result?.text)
    return <div className={`gui-tool${outcome ? ` ${outcome.tone}` : ''}`}>{row}</div>
  return (
    <details className={`gui-tool${outcome ? ` ${outcome.tone}` : ''}`}>
      <summary>{row}</summary>
      <pre className="gui-tool-detail">{item.result.text}</pre>
    </details>
  )
}

export function GuiToolCard({ item }: { item: GuiToolItem }): React.JSX.Element {
  if (item.fileDiffs?.length) return <GuiToolDiffCard item={item} />
  return isGuiShellTool(item.name) ? <GuiCommandCard item={item} /> : <GuiGenericToolCard item={item} />
}

export function GuiToolGroupCard({ group }: { group: GuiToolGroup }): React.JSX.Element {
  const preview = guiToolGroupPreview(group)
  const outcome = guiToolGroupOutcomeView(group.items.map((item) => item.result))
  return (
    <details className={`gui-tool-group${outcome ? ` ${outcome.tone}` : ''}`}>
      <summary>
        <span className="gui-tool-group-chevron" aria-hidden="true">›</span>
        <span className="gui-tool-icon" aria-hidden="true">{toolGlyph(group.name)}</span>
        <b>{group.name}</b>
        <span className="gui-tool-group-count">×{group.items.length}</span>
        {preview && (
          <>
            <span className="gui-tool-sep" aria-hidden="true">·</span>
            <span className="gui-tool-group-preview">{preview}</span>
          </>
        )}
        {outcome && (
          <span className={`gui-tool-group-out ${outcome.tone}`} role="status" aria-live="polite">
            {outcome.compactLabel}
          </span>
        )}
      </summary>
      <div className="gui-tool-group-items">
        {group.items.map((item) => <GuiToolCard key={item.id} item={item} />)}
      </div>
    </details>
  )
}
