/**
 * BIBLIOTECA DE SKILLS NO DISCO (Skills 2.0 — ADR-0007).
 *
 * A lib é da MÁQUINA, não do projeto: `%APPDATA%\synkora\skills\lib\<id>\SKILL.md`
 * (mesma resolução do instalador F6, que morreu no commit d43a3b4). Este módulo
 * é o ÚNICO dono dos caminhos e do `manifest.json` — o instalador e a poda
 * entram por aqui para que a forma do manifest tenha uma fonte só.
 *
 * NADA de rede aqui (ADR-0007: rede só em skillsInstall.ts) e nada derruba a
 * lista: pasta sem SKILL.md, frontmatter ilegível ou arquivo com BOM entram
 * DEGRADADOS — a tela precisa mostrar o problema, não sumir com a linha.
 *
 * Única dependência de Electron: `app.getPath('userData')`, avaliado só quando
 * a raiz é pedida sem argumento — é o que deixa a suíte rodar em node puro.
 */
import { app } from 'electron'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from 'fs'
import { join } from 'path'
import { persistJsonStore } from './jsonStore'

/** Uma pasta da lib, como a tela de gestão a vê. */
export interface SkillsLibraryEntry {
  /** pasta = `name:` do frontmatter */
  id: string
  /** 1ª descrição do frontmatter, colapsada e truncada (~200 chars) */
  description: string
  /** SKILL.md com BOM: o codex rejeita o frontmatter (sonda 2026-08-29; o
   *  claude de hoje tolera — a regra segue UTF-8 sem BOM, basta um recusar) */
  hasBom: boolean
}

/** Entrada do manifest. Campos extras do F6 (`supplyChain`, `etag`) viajam
 *  intactos: quem reescreve o arquivo nunca apaga o que não entende. */
export interface SkillsManifestEntry {
  /** sha pinado da instalação */
  sha: string
  installedAt: string
  [extra: string]: unknown
}

export interface SkillsManifest {
  installed: Record<string, SkillsManifestEntry>
  /** sha novo visto no último check (id → sha) — herdado do F6 */
  updates?: Record<string, string>
  [extra: string]: unknown
}

export interface SkillsManifestRead {
  /** false = o arquivo EXISTE e não é JSON legível. Ninguém escreve por cima:
   *  um manifest de 400 skills não morre por causa de um byte torto. */
  ok: boolean
  manifest: SkillsManifest
}

/**
 * Frontmatter parseado SEM dependência de YAML (leitura linha a linha, como o
 * F6 fazia). A única esperteza é o escalar de bloco (`description: >-` com o
 * texto nas linhas indentadas abaixo): 43 das 298 skills da lib do dono usam
 * essa forma, e o parser antigo devolvia vazio para todas elas.
 */
export function parseSkillFrontmatter(md: string): { name?: string; description?: string } {
  const text = md.charCodeAt(0) === 0xfeff ? md.slice(1) : md
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return {}
  const lines = fm[1].split(/\r?\n/)
  return { name: frontmatterValue(lines, 'name'), description: frontmatterValue(lines, 'description') }
}

function frontmatterValue(lines: string[], key: 'name' | 'description'): string | undefined {
  const head = new RegExp(`^${key}:[ \\t]*(.*)$`)
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(head)
    if (!match) continue
    let value = match[1].trim()
    if (!value || /^[|>][-+]?\d*$/.test(value)) {
      const parts: string[] = []
      for (let next = index + 1; next < lines.length; next++) {
        const line = lines[next]
        if (!line.trim()) continue
        // volta à coluna zero = a chave seguinte; o bloco acabou
        if (!/^\s/.test(line)) break
        parts.push(line.trim())
      }
      value = parts.join(' ')
    }
    const clean = value.replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '')
    return clean || undefined
  }
  return undefined
}

/** `%APPDATA%\synkora\skills` — a casa da biblioteca e do manifest. */
export function skillsBaseDir(): string {
  return join(app.getPath('userData'), 'skills')
}

/** `%APPDATA%\synkora\skills\lib` — uma pasta por skill. */
export function skillsLibraryRoot(base = skillsBaseDir()): string {
  return join(base, 'lib')
}

export function skillsManifestFile(base = skillsBaseDir()): string {
  return join(base, 'manifest.json')
}

const FRONTMATTER_HEAD_BYTES = 8 * 1024
const MAX_DESCRIPTION = 200

function readHead(file: string, bytes = FRONTMATTER_HEAD_BYTES): Buffer | null {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read)
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // descritor já fechado pelo erro acima
      }
    }
  }
}

function hasUtf8Bom(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
}

function truncate(text: string): string {
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION).trimEnd()}…` : text
}

/**
 * A lib inteira, ordenada por id. Só o CABEÇALHO de cada SKILL.md é lido
 * (8KB): são ~400 pastas, e o frontmatter mora no topo por especificação.
 */
export function scanSkillsLibrary(root = skillsLibraryRoot()): SkillsLibraryEntry[] {
  let names: string[]
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    // lib inexistente (máquina nova) é uma biblioteca VAZIA, não um erro
    return []
  }
  const out: SkillsLibraryEntry[] = []
  for (const id of names) {
    const file = join(root, id, 'SKILL.md')
    const head = readHead(file)
    if (!head) {
      // 108 das 406 pastas do dono são SUBAGENTES da era F6 (agent.md): não
      // são skills, e a linha diz isso em vez de fingir um erro de leitura.
      const isAgent = existsSync(join(root, id, 'agent.md'))
      out.push({
        id,
        description: isAgent
          ? 'subagente da era F6 (agent.md) — não é uma skill'
          : 'sem SKILL.md legível nesta pasta',
        hasBom: false
      })
      continue
    }
    const hasBom = hasUtf8Bom(head)
    const description = parseSkillFrontmatter(head.toString('utf8')).description
    out.push({
      id,
      description: description ? truncate(description) : 'sem "description:" no frontmatter',
      hasBom
    })
  }
  return out.sort((left, right) => left.id.localeCompare(right.id, 'en'))
}

export function readSkillsManifest(file = skillsManifestFile()): SkillsManifestRead {
  if (!existsSync(file)) return { ok: true, manifest: { installed: {} } }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, manifest: { installed: {} } }
    }
    const manifest = parsed as SkillsManifest
    if (typeof manifest.installed !== 'object' || manifest.installed === null) {
      // arquivo legível sem a chave que importa: tratável, começa vazio
      return { ok: true, manifest: { ...manifest, installed: {} } }
    }
    return { ok: true, manifest }
  } catch {
    return { ok: false, manifest: { installed: {} } }
  }
}

/** Escrita atômica com .bak (padrão jsonStore da casa). */
export function writeSkillsManifest(manifest: SkillsManifest, file = skillsManifestFile()): void {
  persistJsonStore(file, manifest)
}

/** Mensagem única de recusa quando o manifest existe e está ilegível. */
export const SKILLS_MANIFEST_UNREADABLE =
  'o manifest.json da biblioteca existe mas não é JSON legível — não escrevo por cima; restaure o manifest.json.bak (ao lado dele) ou apague o arquivo para começar do zero'
