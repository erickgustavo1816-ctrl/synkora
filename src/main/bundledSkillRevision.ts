import { createHash } from 'node:crypto'

/**
 * O conteúdo é a versão das skills embutidas. O fingerprint evita que uma
 * instalação antiga fique congelada depois de atualizar o aplicativo.
 */
export function bundledBodySha(body: string): string {
  return `bundled:${createHash('sha256').update(body, 'utf8').digest('hex')}`
}

export function selectStaleBundledIds(
  defs: { id: string; bundledBody?: string }[],
  states: { id: string; installed: boolean; sha?: string }[],
  packageMatches: (id: string) => boolean = () => true
): string[] {
  const byId = new Map(states.map((state) => [state.id, state]))
  return defs
    .filter((def) => {
      const state = byId.get(def.id)
      return (
        !state?.installed ||
        state.sha !== bundledBodySha(def.bundledBody ?? '') ||
        !packageMatches(def.id)
      )
    })
    .map((def) => def.id)
}
