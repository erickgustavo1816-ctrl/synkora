import { useMemo } from 'react'
import {
  normalizeGuiSubagentSidebar,
  type GuiSubagentSidebarEntry
} from '../guiSubagentSidebar'
import type { GuiItem } from '../store'

/** A leitura de relance do dono: modelo, effort e conta na MESMA fileira. O
 *  nativo aposentado não informa effort nem conta — a etiqueta então some, em
 *  vez de mentir um valor. */
function metaLabel(entry: GuiSubagentSidebarEntry): string {
  const parts = [`Modelo: ${entry.model}`]
  if (entry.effort) parts.push(`Effort: ${entry.effort}`)
  if (entry.seat) parts.push(`Conta: ${entry.seat}`)
  return parts.join(' · ')
}

function SubagentCard({ entry }: { entry: GuiSubagentSidebarEntry }): React.JSX.Element {
  return (
    // Cross-CLI é indistinguível por desenho: o CLI vira CARIMBO (estilo e
    // depuração), nunca mais um texto disputando a fileira de metadados.
    <article
      className={`gui-subagent-row ${entry.status}`}
      data-subagent-id={entry.toolUseId}
      data-subagent-status={entry.status}
      data-subagent-cli={entry.cli ?? undefined}
    >
      <header className="gui-subagent-row-head">
        <span className="gui-subagent-row-dot" aria-hidden="true" />
        <strong>{entry.name}</strong>
        <span className="gui-subagent-row-status" role="status" aria-live="polite">
          {entry.statusLabel}
        </span>
      </header>
      <div className="gui-subagent-row-meta" aria-label={metaLabel(entry)}>
        <span>{entry.model}</span>
        {entry.effort && <span>{entry.effort}</span>}
        {entry.seat && <span>{entry.seat}</span>}
        {entry.type && <span>{entry.type}</span>}
      </div>
      <p className="gui-subagent-row-task" aria-label={`Tarefa: ${entry.task}`} title={entry.task}>
        {entry.task}
      </p>
      {entry.activity && (
        <p className="gui-subagent-row-activity">
          <span>agora</span>
          <span>{entry.activity}</span>
        </p>
      )}
      {entry.outcome && (
        <p className="gui-subagent-row-outcome" aria-label={`Desfecho: ${entry.outcome}`} title={entry.outcome}>
          {entry.outcome}
        </p>
      )}
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
  // A normalização varre a lista inteira do pane; o trilho renderiza a cada
  // delta da conversa, então ela só roda quando os itens realmente mudam.
  const entries = useMemo(() => normalizeGuiSubagentSidebar(items), [items])
  if (entries.length === 0) return null
  return (
    <aside className="gui-subagent-sidebar" aria-label="Subagentes desta conversa">
      <header className="gui-subagent-sidebar-head">
        <span className="gui-subagent-sidebar-title">
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <circle cx="6" cy="6" r="2.25" />
            <circle cx="12.5" cy="11.5" r="2.25" />
            <path d="M7.8 7.35 10.7 10" />
          </svg>
          <span>Subagentes</span>
        </span>
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

