import { useCallback, useState, type ReactNode } from 'react'

// RIGHTDOCK (2026-08-22, mockup aprovado = contrato) — o primitivo de SEÇÃO da
// moldura do lado direito: título uppercase, resumo à direita (que continua
// contando a verdade com a seção recolhida) e o colapso persistido — o dock
// lembra como o dono o deixou, por seção, entre sessões.

const STORAGE_PREFIX = 'synkora.dock.section.'

function readCollapsed(id: string): boolean {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + id) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(id: string, collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(STORAGE_PREFIX + id, '1')
    else window.localStorage.removeItem(STORAGE_PREFIX + id)
  } catch {
    // storage indisponível: o colapso vive só nesta sessão — nunca um erro.
  }
}

export default function DockSection({
  id,
  title,
  summary,
  children
}: {
  /** chave da persistência (ex.: 'entrega', 'trabalho', 'frota'). */
  id: string
  title: string
  /** o resumo à direita do título — a verdade compacta da seção. */
  summary?: string
  children: ReactNode
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(id))
  const toggle = useCallback(() => {
    setCollapsed((current) => {
      writeCollapsed(id, !current)
      return !current
    })
  }, [id])

  return (
    <section className="dock-sec">
      <button
        type="button"
        className="dock-sec-head"
        aria-expanded={!collapsed}
        onClick={toggle}
      >
        <span className="dock-sec-tog" aria-hidden="true">
          {collapsed ? '▸' : '▾'}
        </span>
        {title}
        {summary && <span className="dock-sec-sum">{summary}</span>}
      </button>
      {!collapsed && <div className="dock-sec-body">{children}</div>}
    </section>
  )
}
