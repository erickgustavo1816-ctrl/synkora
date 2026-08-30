/**
 * O MARCADOR DE USO DE SKILL DO CODEX — as duas superfícies TIPADAS que existem.
 *
 * Sonda de 2026-08-30 (`.synkora/reports/PROBE_SKILL_USE_2026-08-30.md`, frames
 * crus em `.tmp/probe-skill-use/codex-frames.jsonl`, codex-cli 0.151.0):
 * o app-server NÃO tem evento de uso de skill. As 19 variantes de `ThreadItem`
 * do schema do próprio binário (`generate-json-schema --experimental`) não
 * incluem nenhuma; `skills/changed` é invalidação de watcher e
 * `CommandExecutionSource` não tem valor de skill. O que existe é isto:
 *
 *  (a) `input-echo` (FORTE) — `userMessage` com `content[] {type:'skill',
 *      name, path}`: a `SkillUserInput` que o CLIENTE declara volta ecoada nos
 *      dois lados do par started/completed, com nome E caminho.
 *  (b) `file-read` (BEST-EFFORT, o único caminho quando o MODELO decide
 *      sozinho) — `commandExecution` com `commandActions[] {type:'read', path}`
 *      caindo em `<raiz sincronizada>/<nome>/SKILL.md`. `commandActions` não é
 *      o comando cru: é a leitura TIPADA que o próprio binário faz dele. O
 *      casamento é campo tipado contra uma pasta que o SYNKORA escreveu — não
 *      é heurística sobre saída de modelo, que é proibida nesta casa.
 *
 * Se o campo tipado sumir num update, o sinal some e a suíte fica vermelha —
 * nunca há queda para casamento de texto ("Launching skill: …", string de
 * comando). Re-sondar com `node scripts/probe-skill-use-signal.mjs`.
 *
 * Módulo node PURO de propósito: ele é lido pelo `codexSession`, que roda sem
 * electron nas suítes.
 */
import { join } from 'node:path'

/**
 * ESPELHO DECLARADO de `SKILL_SYNC_TARGETS.codex` (`src/main/skillsSync.ts`).
 * Não importamos de lá porque `skillsSync` puxa `skillsKit`/`skillsLibraryScan`,
 * que importam `electron` — e este módulo precisa rodar em node puro. O par
 * está declarado nos DOIS lados: mudou a pasta que o sync escreve, muda aqui.
 */
const CODEX_SKILLS_DIR = '.agents/skills'

/** O arquivo que define uma skill. Ler qualquer outro arquivo da pasta não é
 *  entrar com a skill. */
const SKILL_FILE = 'SKILL.md'

/**
 * ESPELHO DECLARADO do nome da tool de skill do CLAUDE (o `tools[]` do
 * `system/init` traz `Skill`, e o `tool_use` viaja com `input.skill`). O codex
 * é normalizado para a MESMA forma, e é isso que deixa UM caminho de
 * apresentação servir os dois CLIs. O par do renderer está em
 * `src/renderer/src/guiSkillUse.ts`.
 */
export const GUI_SKILL_TOOL_NAME = 'Skill'

/** Teto de varredura: o item vem do CLI, e lista sem fim não pode virar
 *  trabalho sem fim. Uma mensagem carrega um punhado de blocos. */
const MAX_SCANNED_ENTRIES = 32

/** De onde veio a confiança — o chip pode graduá-la, e o diário audita. */
export type CodexSkillSource = 'input-echo' | 'file-read'

export interface CodexSkillSignal {
  skill: string
  source: CodexSkillSource
}

/** A forma do item que este módulo lê. Espelha os campos de `CodexItem`
 *  (`codexSession.ts`) usados aqui — nada além deles é tocado. */
export interface CodexSkillItem {
  type?: string
  content?: unknown
  commandActions?: unknown
}

/** A pasta que o sync DESTE app escreveu no worktree do pane codex. */
export function codexSkillsRoot(cwd: string): string {
  return join(cwd, ...CODEX_SKILLS_DIR.split('/'))
}

function segments(path: string): string[] {
  return path.split(/[\\/]+/u).filter(Boolean)
}

/** Windows não distingue caixa em caminho, e o CLI ecoa o que o modelo digitou:
 *  comparar sensível a caixa deixaria `.Agents` passar por outra pasta. */
function sameSegment(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase()
}

/**
 * `<raiz>/<nome>/SKILL.md` e NADA MAIS: nem mais fundo, nem outro arquivo, nem
 * "começa com a raiz". A forma exata é o que impede uma leitura comum de virar
 * chip — e `.`/`..` jamais viram nome de skill.
 *
 * O nome sai do caminho REAL (a caixa que o disco tem), não do comparado.
 */
export function skillNameUnderSkillsRoot(path: string, root: string): string | undefined {
  if (typeof path !== 'string' || !path) return undefined
  const rootParts = segments(root)
  if (rootParts.length === 0) return undefined
  const parts = segments(path)
  if (parts.length !== rootParts.length + 2) return undefined
  for (let index = 0; index < rootParts.length; index += 1) {
    if (!sameSegment(parts[index], rootParts[index])) return undefined
  }
  const name = parts[rootParts.length]
  if (!name || name === '.' || name === '..') return undefined
  return sameSegment(parts[rootParts.length + 1], SKILL_FILE) ? name : undefined
}

function scannable(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, MAX_SCANNED_ENTRIES) : []
}

function entryRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** (a) A entrada tipada ecoada: `content[] {type:'skill', name}`. */
function skillsFromUserMessage(content: unknown): CodexSkillSignal[] {
  const found: CodexSkillSignal[] = []
  for (const raw of scannable(content)) {
    const entry = entryRecord(raw)
    if (!entry || entry['type'] !== 'skill') continue
    const skill = trimmedString(entry['name'])
    if (skill) found.push({ skill, source: 'input-echo' })
  }
  return found
}

/** (b) A leitura tipada do comando, casada contra a pasta conhecida. */
function skillsFromCommandActions(actions: unknown, skillsRoot: string): CodexSkillSignal[] {
  const found: CodexSkillSignal[] = []
  for (const raw of scannable(actions)) {
    const action = entryRecord(raw)
    if (!action || action['type'] !== 'read') continue
    const path = trimmedString(action['path'])
    if (!path) continue
    const skill = skillNameUnderSkillsRoot(path, skillsRoot)
    if (skill) found.push({ skill, source: 'file-read' })
  }
  return found
}

/** Todo sinal de skill que ESTE item carrega. Item de outro tipo devolve vazio:
 *  ausência de sinal é ausência de chip, nunca um palpite. */
export function codexSkillSignals(item: CodexSkillItem, skillsRoot: string): CodexSkillSignal[] {
  if (item.type === 'userMessage') return skillsFromUserMessage(item.content)
  if (item.type === 'commandExecution')
    return skillsFromCommandActions(item.commandActions, skillsRoot)
  return []
}
