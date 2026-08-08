import { createHash } from 'node:crypto'

/**
 * O conteúdo é a versão das skills embutidas. O fingerprint evita que uma
 * instalação antiga fique congelada depois de atualizar o aplicativo.
 */
export function bundledBodySha(body: string): string {
  return `bundled:${createHash('sha256').update(body, 'utf8').digest('hex')}`
}

/**
 * A versao de um pacote embutido cobre a arvore inteira, nao apenas o arquivo
 * raiz. Caminho e tamanho entram no hash para que duas concatenacoes
 * diferentes nunca produzam a mesma identidade por ambiguidade.
 */
export function bundledPackageSha(
  body: string,
  files: Record<string, string> = {},
  rootEntry = 'SKILL.md'
): string {
  const hash = createHash('sha256')
  const entries = [[rootEntry, body] as const, ...Object.entries(files).sort(([a], [b]) => a.localeCompare(b))]
  for (const [path, content] of entries) {
    hash.update(path, 'utf8')
    hash.update('\0', 'utf8')
    hash.update(String(Buffer.byteLength(content, 'utf8')), 'utf8')
    hash.update('\0', 'utf8')
    hash.update(content, 'utf8')
    hash.update('\0', 'utf8')
  }
  return `bundled:${hash.digest('hex')}`
}

export function selectStaleBundledIds(
  defs: {
    id: string
    kind?: 'skill' | 'agent'
    bundledBody?: string
    bundledFiles?: Record<string, string>
  }[],
  states: { id: string; installed: boolean; sha?: string }[],
  packageMatches: (id: string) => boolean = () => true
): string[] {
  const byId = new Map(states.map((state) => [state.id, state]))
  return defs
    .filter((def) => {
      const state = byId.get(def.id)
      return (
        !state?.installed ||
        state.sha !==
          bundledPackageSha(
            def.bundledBody ?? '',
            def.bundledFiles,
            def.kind === 'agent' ? 'agent.md' : 'SKILL.md'
          ) ||
        !packageMatches(def.id)
      )
    })
    .map((def) => def.id)
}
