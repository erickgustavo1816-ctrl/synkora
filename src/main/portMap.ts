/**
 * Mapa de portas em uso pelos processos do PRÓPRIO harness (decisão do dono,
 * 2026-08-07: visibilidade nas duas pontas — o QA nasce sabendo o mapa e o
 * modal do ▶ testar mostra o mesmo mapa; "não tem que engessar sempre em
 * uma"). Fonte da verdade: runtimes de QA (URL real anunciada) e servidores
 * de teste registrados — nunca varredura de sistema.
 */

export interface PortUseEntry {
  /** porta real (parseada da URL anunciada) ou pedida (servidor de teste) */
  port?: number
  /** true quando a porta é a PEDIDA e o produto pode ter pinado outra */
  requested?: boolean
  /** dono humano: 'QA do card "…"' · 'servidor de teste da missão "…"' */
  owner: string
}

export function parsePortFromUrl(url?: string): number | undefined {
  if (!url) return undefined
  const match = /:(\d{2,5})(?:\/|$)/.exec(url)
  if (!match) return undefined
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined
}

/** Linha humana do mapa — mesma string no prompt do QA e no modal do dono. */
export function formatPortMap(entries: PortUseEntry[]): string {
  const named = entries.filter((e) => e.port || e.owner)
  if (named.length === 0) return ''
  return named
    .map((e) =>
      e.port
        ? `${e.port}${e.requested ? ' (pedida)' : ''} = ${e.owner}`
        : `porta desconhecida = ${e.owner}`
    )
    .join(' · ')
}
