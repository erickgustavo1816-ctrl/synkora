import {
  normalizeGuiSubagentSidebar,
  type GuiSubagentSidebarEntry
} from '../guiSubagentSidebar'
import type { GuiItem } from '../store'

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value
}

function SubagentCard({ entry }: { entry: GuiSubagentSidebarEntry }): React.JSX.Element {
  return (
    <article
      className={`gui-subagent-sidebar-card ${entry.status}`}
      data-subagent-id={entry.toolUseId}
      data-subagent-status={entry.status}
    >
      <header className="gui-subagent-sidebar-card-head">
        <span className="gui-subagent-sidebar-dot" aria-hidden="true" />
        <strong>{entry.name}</strong>
        <code title={`id do subagente: ${entry.toolUseId}`}>#{shortId(entry.toolUseId)}</code>
      </header>
      {entry.type && <div className="gui-subagent-sidebar-type">{entry.type}</div>}
      <dl className="gui-subagent-sidebar-facts">
        <div>
          <dt>modelo</dt>
          <dd>{entry.model}</dd>
        </div>
        <div>
          <dt>tarefa</dt>
          <dd title={entry.task}>{entry.task}</dd>
        </div>
        {entry.activity && (
          <div>
            <dt>agora</dt>
            <dd>{entry.activity}</dd>
          </div>
        )}
        <div>
          <dt>estado</dt>
          <dd role="status" aria-live="polite">
            {entry.statusLabel}
          </dd>
        </div>
        {entry.outcome && (
          <div>
            <dt>desfecho</dt>
            <dd title={entry.outcome}>{entry.outcome}</dd>
          </div>
        )}
      </dl>
    </article>
  )
}

/**
 * Seção da lateral de entrega. Sem fichas, não ocupa espaço nem deixa um
 * placeholder barulhento; a lista nasce no primeiro Task/Agent factual.
 */
export default function GuiSubagentSidebar({
  items
}: {
  items: readonly GuiItem[]
}): React.JSX.Element | null {
  const entries = normalizeGuiSubagentSidebar(items)
  if (entries.length === 0) return null
  return (
    <aside className="gui-subagent-sidebar" aria-label="Subagentes desta conversa">
      <header className="gui-subagent-sidebar-head">
        <span>subagentes</span>
        <span className="gui-subagent-sidebar-count" aria-label={`${entries.length} subagentes`}>
          {entries.length}
        </span>
      </header>
      <div className="gui-subagent-sidebar-list">
        {entries.map((entry) => (
          <SubagentCard key={entry.id} entry={entry} />
        ))}
      </div>
    </aside>
  )
}

