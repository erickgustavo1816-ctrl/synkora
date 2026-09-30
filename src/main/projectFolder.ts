/**
 * A PASTA DO UNIVERSO — perguntas sobre o diretório do projeto, e só isso.
 *
 * Nasceu do expurgo F6 (2026-08-17, costura S1): `isEffectivelyEmptyProject`
 * morava dentro de `projectPlan.ts` por acidente de vizinhança — ela não é
 * sobre PLANO nenhum, é sobre "esta pasta já tem produto dentro?". O motor do
 * roadmap por ondas morre; esta pergunta continua viva e com dono próprio.
 *
 * Consumidor vivo: o GITHUB NO NASCIMENTO (2.0, onda D) — `ipc/projects.ts`
 * decide CLONAR (pasta vazia: o universo É o repositório remoto) × PUBLICAR
 * (pasta com conteúdo: init + origin + push) por esta função.
 *
 * Sem estado, sem Electron, sem escrita: só `fs` de leitura.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ProjectFolderInspection } from '../shared/projectVersioning'

export function inspectProjectFolder(projectRoot: string): ProjectFolderInspection {
  return {
    exists: existsSync(projectRoot),
    hasGit: existsSync(resolve(projectRoot, '.git')),
    empty: isEffectivelyEmptyProject(projectRoot)
  }
}

/**
 * Metadados que Git, Synkora e os runtimes dos agentes criam sozinhos. O
 * CONTEÚDO desses diretórios é deliberadamente ignorado: ele não representa
 * implementação do produto, e uma injeção de skills não pode fazer uma pasta
 * vazia parecer um projeto existente.
 */
const IGNORED_EMPTY_PROJECT_ENTRIES = new Set([
  '.git',
  '.synkora',
  '.agents',
  '.claude',
  '.codex',
  '.ds_store',
  'desktop.ini'
])

/**
 * Um projeto novo continua "vazio" quando só contém metadados criados pelo
 * Git, Synkora ou pelos runtimes dos agentes. Pasta inexistente conta como
 * vazia (é o caso do clone, que ainda vai criá-la); arquivo solto no lugar de
 * um diretório NÃO conta.
 */
export function isEffectivelyEmptyProject(projectRoot: string): boolean {
  const root = resolve(projectRoot)
  if (!existsSync(root)) return true
  if (!statSync(root).isDirectory()) return false
  return readdirSync(root).every((entry) =>
    IGNORED_EMPTY_PROJECT_ENTRIES.has(entry.toLocaleLowerCase('en-US'))
  )
}
