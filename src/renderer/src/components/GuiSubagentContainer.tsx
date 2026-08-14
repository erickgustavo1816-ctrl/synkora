import { guiSubagentStatusView } from '../guiSubagentStatus'
import type { GuiSubagentGroup } from '../guiSubagentPresentation'
import {
  groupConsecutiveGuiTools,
  isGuiInteractiveTool
} from '../guiToolPresentation'
import { guiToolOutcomeView } from '../guiToolOutcome'
import { GuiToolCard, GuiToolGroupCard } from './GuiToolCard'

export default function GuiSubagentContainer({
  group
}: {
  group: GuiSubagentGroup
}): React.JSX.Element {
  const outcome = guiToolOutcomeView(group.parent.result)
  const status = guiSubagentStatusView(group.parent, group.children, outcome)
  const childItems = groupConsecutiveGuiTools(group.children)
  const statusLine = (
    <div
      className={`gui-subagent-status ${status.tone}`}
      role="status"
      aria-live="polite"
    >
      {status.tone === 'running' && (
        <i className="gui-subagent-pulse" aria-hidden="true" />
      )}
      <span>{status.label}</span>
    </div>
  )

  return (
    <section
      className={`gui-subagent ${status.tone}`}
      aria-label={`Subagente: ${status.prompt}`}
    >
      <header className="gui-subagent-head">
        <span className="gui-subagent-mark" aria-hidden="true">✦</span>
        <b>subagente</b>
        <span className="gui-subagent-tool">{group.parent.name}</span>
      </header>

      <div className="gui-subagent-prompt">
        <span>prompt</span>
        <p title={status.prompt}>{status.prompt}</p>
      </div>

      {status.tone === 'running' && statusLine}

      <div className="gui-subagent-tools" aria-label="Ferramentas do subagente">
        {childItems.map((item) => {
          if (item.kind === 'tool-group') {
            return <GuiToolGroupCard key={item.id} group={item} />
          }
          if (item.kind !== 'tool' || isGuiInteractiveTool(item.name)) return null
          return <GuiToolCard key={item.id} item={item} />
        })}
      </div>

      {group.parent.result?.text && (
        <details className="gui-subagent-result">
          <summary>resultado do subagente</summary>
          <pre className="gui-tool-detail">{group.parent.result.text}</pre>
        </details>
      )}
      {status.tone !== 'running' && statusLine}
    </section>
  )
}
