import { useEffect, useMemo, useRef, useState } from 'react'
import {
  formatGuiSubagentElapsed,
  guiSubagentElapsedMs,
  guiSubagentSidebarEntries,
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

/**
 * UM relógio para a lista INTEIRA (ordem do dono, 18/08: "há quanto tempo ele
 * tá trabalhando"). Um timer por ficha multiplicaria o custo pelo número de
 * ajudantes abertos — e o lote do dono abre cinco de uma vez.
 *
 * O tique é de 1s porque é assim que um cronômetro se lê: contando. Ele só
 * existe enquanto há ficha TRABALHANDO (`active`) — lateral vazia, ou só com
 * frota interrompida, não mantém timer de pé, porque cronômetro congelado não
 * pede tique — e a faxina do efeito o encerra na desmontagem do pane. Cada
 * ficha tem a própria fase (o `at` dela), então o relógio compartilhado nunca é
 * alinhado a todas: a leitura de uma ficha recém-aberta assenta no tique
 * seguinte, e o `setNow` de entrada re-sincroniza quando a seção volta a viver.
 */
function useGuiSubagentClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

function SubagentCard({
  entry,
  elapsedMs
}: {
  entry: GuiSubagentSidebarEntry
  /** `null` = não há tempo trabalhado a mostrar nesta montagem (ficha que já
   *  voltou parada do anel) — a ficha então simplesmente não desenha relógio. */
  elapsedMs: number | null
}): React.JSX.Element {
  // O zero do cronômetro é o carimbo FACTUAL do tool call, nunca a hora em que
  // a ficha apareceu na tela: replay de transcript e re-render não zeram nada.
  const elapsed = elapsedMs === null ? null : formatGuiSubagentElapsed(elapsedMs)
  const working = entry.status === 'running'
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
        {/* Fora da região viva do estado DE PROPÓSITO: um live region que muda
            a cada segundo faria o leitor de tela narrar o relógio para sempre.
            Parado, o verbo vai para o passado — o número é história, não um
            cronômetro que ainda anda. */}
        {elapsed && (
          <time
            className="gui-subagent-row-elapsed"
            aria-label={working ? `Trabalhando há ${elapsed}` : `Trabalhou ${elapsed}`}
          >
            {elapsed}
          </time>
        )}
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
  const entries = useMemo(() => guiSubagentSidebarEntries(items), [items])
  // Antes do retorno vazio: a regra dos hooks não admite chamada condicional —
  // quem desliga o timer é o `active`, não o early return.
  const now = useGuiSubagentClock(entries.some((entry) => entry.status === 'running'))
  // A memória do cronômetro congelado vive por MONTAGEM da lateral: ela guarda
  // a última leitura viva de cada ficha e é dela que a ficha parada lê seu
  // número. Fora de um ref ela seria recriada a cada render e o congelamento
  // viraria um "0:00" novo a cada tique.
  const clockRef = useRef<Map<string, number> | null>(null)
  if (!clockRef.current) clockRef.current = new Map()
  const clock = clockRef.current
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
          <SubagentCard
            key={entry.id}
            entry={entry}
            elapsedMs={guiSubagentElapsedMs(entry, now, clock)}
          />
        ))}
      </div>
    </aside>
  )
}

