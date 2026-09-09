/**
 * O RASTRO DO HARNESS DA MISSÃO (Skills 3.0 — ADR-0010,
 * .synkora/reports/DESIGN_HARNESS_DO_MODELO_2026-09-08.md §5.B).
 *
 * A skill que o agente puxa é EFÊMERA: vive no worktree e morre com ele, com o
 * `skill_discard` ou com a conclusão do planejamento. O que FICA é o rastro —
 * nota no fio, linha no diário e este arquivo: `.synkora/harness.json` da
 * conversa, a lista do que esta missão puxou, com procedência (repo @ sha) para
 * o dono poder dizer depois "guarda essa na biblioteca" (R2) no MESMO sha.
 *
 * REGRAS QUE VALEM COMO CONTRATO:
 * - NUNCA LANÇA. Arquivo ausente (missão nova), ilegível ou com lixo dentro é
 *   harness VAZIO: o pull de uma skill não pode derrubar o turno do agente por
 *   causa de um byte torto num arquivo de rastro.
 * - ENTRADA NÃO CONFIÁVEL. O arquivo mora no worktree em que um agente escreve
 *   o dia inteiro: id passa por `isSkillId`, texto é truncado, lista tem teto.
 * - ESCRITA ATÔMICA sem `.bak` (não é o jsonStore da casa de propósito): este
 *   arquivo é RE-DERIVÁVEL do disco de skills + do diário, e um `.bak` seria
 *   lixo permanente dentro do worktree do dono.
 * - O DESCARTE NÃO APAGA A LINHA: ele carimba `discardedAt`. "Puxei e descartei"
 *   é história que o dono precisa ler; some só quando o worktree some.
 *
 * Sem Electron, sem rede: só fs + o `isSkillId` do skillsKit (a mesma régua de
 * pasta que o resto do subsistema usa).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isSkillId } from './skillsKit'

/** O arquivo, relativo ao cwd da conversa (`.synkora/` já é git-invisível). A
 *  barra é literal de propósito: é assim que o contrato o nomeia, e o `path` do
 *  Windows aceita `/` como separador. */
export const SKILL_HARNESS_FILE = '.synkora/harness.json'

/** A skill AUTORAL da missão (ADR-0009): o playbook que o agente escreve e que
 *  vai a todo ajudante. Ela abre o briefing porque é a única que fala DESTA
 *  missão. */
export const MISSION_PLAYBOOK_ID = 'mission-playbook'

/** De onde a skill veio: catálogo da casa, biblioteca da máquina, URL do GitHub
 *  ou a pena do próprio agente. */
export type SkillHarnessOrigin = 'catalog' | 'library' | 'url' | 'authored'

export interface SkillHarnessEntry {
  id: string
  origin: SkillHarnessOrigin
  /** owner/repo (catalog/url) */
  repo?: string
  /** subpasta da skill na fonte (catalog/url) */
  path?: string
  /** sha do commit pinado — é ele que faz "guardar na biblioteca" ser exato */
  sha?: string
  description?: string
  pulledAt: string
  /** quem puxou: paneId do chat, ou o id do ajudante */
  by: string
  /** presente = já descartada (a linha fica, a pasta não) */
  discardedAt?: string
}

export interface SkillHarness {
  version: 1
  entries: SkillHarnessEntry[]
}

/** Tetos: o arquivo é entrada não confiável e uma lista infinita não pode virar
 *  briefing infinito no prompt de todo ajudante. */
const MAX_ENTRIES = 64
const MAX_TEXT = 300
const MAX_SHORT = 140

const ORIGINS: readonly SkillHarnessOrigin[] = ['catalog', 'library', 'url', 'authored']

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (!collapsed) return undefined
  return collapsed.length > max ? `${collapsed.slice(0, max).trimEnd()}…` : collapsed
}

function isoOf(value: unknown): string | undefined {
  const text = cleanText(value, 40)
  if (!text) return undefined
  const at = new Date(text)
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
}

function sanitizeEntry(value: unknown): SkillHarnessEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<SkillHarnessEntry>
  if (!isSkillId(candidate.id)) return null
  const origin = ORIGINS.find((known) => known === candidate.origin) ?? 'url'
  const repo = cleanText(candidate.repo, MAX_SHORT)
  const path = cleanText(candidate.path, MAX_SHORT)
  const sha = cleanText(candidate.sha, 64)
  const description = cleanText(candidate.description, MAX_TEXT)
  const discardedAt = isoOf(candidate.discardedAt)
  return {
    id: candidate.id,
    origin,
    ...(repo ? { repo } : {}),
    ...(path ? { path } : {}),
    ...(sha ? { sha } : {}),
    ...(description ? { description } : {}),
    pulledAt: isoOf(candidate.pulledAt) ?? new Date(0).toISOString(),
    by: cleanText(candidate.by, MAX_SHORT) ?? 'desconhecido',
    ...(discardedAt ? { discardedAt } : {})
  }
}

function emptyHarness(): SkillHarness {
  return { version: 1, entries: [] }
}

function harnessFile(cwd: string): string {
  return join(cwd, SKILL_HARNESS_FILE)
}

/** O harness de uma conversa. Ausente, podre ou de outra versão = vazio. */
export function readSkillHarness(cwd: string): SkillHarness {
  if (!cwd) return emptyHarness()
  let text: string
  try {
    text = readFileSync(harnessFile(cwd), 'utf8')
  } catch {
    return emptyHarness()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyHarness()
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyHarness()
  const candidate = parsed as Partial<SkillHarness>
  if (candidate.version !== 1 || !Array.isArray(candidate.entries)) return emptyHarness()
  const entries: SkillHarnessEntry[] = []
  const seen = new Set<string>()
  for (const raw of candidate.entries.slice(0, MAX_ENTRIES)) {
    const entry = sanitizeEntry(raw)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }
  return { version: 1, entries }
}

/** Escrita atômica (tmp + rename). Falha de disco é silenciosa POR DECISÃO: o
 *  rastro é acessório da ação, e a ação (a skill no worktree) já aconteceu. */
function writeSkillHarness(cwd: string, harness: SkillHarness): SkillHarness {
  const file = harnessFile(cwd)
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(harness, null, 2)}\n`, 'utf8')
    renameSync(temporary, file)
  } catch {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // temporário nunca criado ou já promovido
    }
  }
  return harness
}

export type SkillPullRecord = Omit<SkillHarnessEntry, 'pulledAt' | 'discardedAt'> & {
  pulledAt?: string
}

/**
 * PUXOU: upsert por id. Re-puxar REVIVE a linha (limpa o `discardedAt` e
 * atualiza sha/origem/descrição) em vez de criar uma segunda — o harness é a
 * lista do que está VALENDO, e a história de quantas vezes o agente hesitou
 * mora no diário.
 */
export function recordSkillPull(cwd: string, entry: SkillPullRecord): SkillHarness {
  const harness = readSkillHarness(cwd)
  if (!cwd) return harness
  const sanitized = sanitizeEntry({ ...entry, pulledAt: entry.pulledAt ?? new Date().toISOString() })
  if (!sanitized) return harness
  const entries = harness.entries.filter((current) => current.id !== sanitized.id)
  entries.push(sanitized)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  return writeSkillHarness(cwd, { version: 1, entries })
}

/** DESCARTOU: a linha FICA, carimbada. Id que nunca foi puxado não inventa
 *  linha nenhuma — o rastro conta o que aconteceu, não o que foi pedido. */
export function recordSkillDiscard(cwd: string, id: string, at?: string): SkillHarness {
  const harness = readSkillHarness(cwd)
  if (!cwd || !isSkillId(id)) return harness
  const discardedAt = isoOf(at) ?? new Date().toISOString()
  let touched = false
  const entries = harness.entries.map((entry) => {
    if (entry.id !== id || entry.discardedAt) return entry
    touched = true
    return { ...entry, discardedAt }
  })
  if (!touched) return harness
  return writeSkillHarness(cwd, { version: 1, entries })
}

/** O que está VALENDO agora (o playbook da missão primeiro, e o resto na ordem
 *  em que foi puxado). */
export function liveHarnessEntries(harness: SkillHarness): SkillHarnessEntry[] {
  const live = harness.entries.filter((entry) => !entry.discardedAt)
  const playbook = live.filter((entry) => entry.id === MISSION_PLAYBOOK_ID)
  const rest = live.filter((entry) => entry.id !== MISSION_PLAYBOOK_ID)
  return [...playbook, ...rest]
}

function sha7(entry: SkillHarnessEntry): string | undefined {
  return entry.sha ? entry.sha.slice(0, 7) : undefined
}

/** A NOTA NO FIO — a linha que o dono vê quando o agente monta o harness dele.
 *  Sempre nomeia a procedência que existe: rastro sem repo/sha é rastro pela
 *  metade, mas mentir sobre um sha seria pior. */
export function skillPullNoteText(entry: SkillHarnessEntry): string {
  if (entry.origin === 'authored') {
    return `❖ playbook da missão escrito pelo agente: ${entry.id}`
  }
  if (entry.origin === 'library') {
    return `❖ skill puxada da biblioteca: ${entry.id}`
  }
  const short = sha7(entry)
  const trail = entry.repo ? (short ? `${entry.repo} @ ${short}` : entry.repo) : short
  return `❖ skill puxada pelo agente: ${entry.id}${trail ? ` · ${trail}` : ''}`
}

export function skillDiscardNoteText(id: string): string {
  return `❖ skill descartada: ${id}`
}

/**
 * O BLOCO DO AJUDANTE (EN, porque vai no prompt de um CLI): o que ESTA missão já
 * puxou, para o ajudante carregar por nome em vez de puxar de novo. O playbook
 * da missão vem primeiro e é anunciado como o que se lê ANTES de tudo (ADR-0009).
 *
 * `undefined` = a missão não puxou nada (e aí o briefing não ganha bloco vazio).
 */
export function missionHarnessBriefing(cwd: string): string | undefined {
  const live = liveHarnessEntries(readSkillHarness(cwd))
  if (live.length === 0) return undefined
  const lines = live.map((entry) => {
    const description = entry.description ? ` — ${entry.description}` : ''
    if (entry.id === MISSION_PLAYBOOK_ID) {
      return `- ${entry.id}${description} (the mission's own playbook: read it FIRST)`
    }
    const short = sha7(entry)
    const trail = entry.repo ? (short ? ` (${entry.repo} @ ${short})` : ` (${entry.repo})`) : ''
    return `- ${entry.id}${description}${trail}`
  })
  return [
    'SKILLS THIS MISSION ALREADY PULLED — they are in your skills folder, load them by name:',
    ...lines
  ].join('\n')
}
