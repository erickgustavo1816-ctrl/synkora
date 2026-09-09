// GERADOR DO CATÁLOGO DA CASA — a curadoria da era F6 virando DADO offline.
//
// Ordem do dono (2026-09-08, ADR-0009): "quero que a IA decida qual é a melhor
// opção pra ela ali naquele momento, e ela vá atrás, ela busque, ela pegue e
// ela faça". Para isso a busca offline precisa de índice, e o índice já existe:
// as 275 skills VERIFICADAS NA FONTE na era F6 (SKILL.md aberto, path e
// frontmatter `name` conferidos — ver docs/SKILLS.md). Elas morreram no código
// com A LIMPA F6, mas sobrevivem em git; este script as ressuscita como dado.
//
// One-off RE-RODÁVEL: leitura só de git (`git show`, sem tocar a árvore) e uma
// escrita só em `src/main/skillsCatalogData.json`. Rodar com:
//
//   node scripts/skills-catalog-from-f6.mjs            (escreve o JSON)
//   node scripts/skills-catalog-from-f6.mjs --dry-run  (só conta, não escreve)
//
// O que ENTRA por entrada: id, repo, path, ref?, group, depts, summary, hint,
// requires?. O que FICA FORA de propósito: `kind: 'agent'` (52 subagentes — a
// era 2.0 não abre subagente nativo), e os campos do motor F6 que não existem
// mais (`defaultFor`, `allowedPhases`, `requiresCapabilities`, `adapter`,
// `manualOnly`): roteamento automático era exatamente a cerca que caiu.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** o último commit em que a curadoria ainda existia (A LIMPA F6 a apagou em d43a3b4) */
const F6_SOURCE = 'd43a3b4^:src/main/skillsCatalog.ts'
const OUT_FILE = join(REPO_ROOT, 'src', 'main', 'skillsCatalogData.json')
const SCRATCH = join(REPO_ROOT, '.tmp', 'skills-catalog-gen')

/** o mesmo padrão de `isSkillId` (src/main/skillsKit.ts) — espelho declarado */
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const isSkillId = (value) =>
  typeof value === 'string' && SKILL_ID_PATTERN.test(value) && !value.includes('--')

// ESPELHO de `SKILL_SOURCE_VETOES` em src/main/skillsCatalog.ts (o par está lá,
// com as razões em PT-BR). Aqui só as CHAVES importam: o gerador exclui do dado
// o que o módulo recusaria na hora do pull. A suíte test-skills-catalog.mjs
// prende os dois lados juntos ("nada vetado sobrou no dado gerado"), então
// esquecer de atualizar este espelho fica VERMELHO, nunca silencioso.
const VETOED_IDS = new Set([
  'docx',
  'pdf',
  'pptx',
  'xlsx',
  'security-review',
  'web-design-guidelines',
  // ensinam o que o app já cerca (subagente nativo / worktree e branch à mão)
  'dispatching-parallel-agents',
  'subagent-driven-development',
  'requesting-code-review',
  'using-git-worktrees',
  'finishing-a-development-branch'
])
const VETOED_REPOS = new Set(['anthropics/claude-plugins-official'])

/** lê o arquivo do histórico e o torna importável (é TS só no tipo) */
async function loadF6Skills() {
  const source = execFileSync('git', ['show', F6_SOURCE], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  const asModule = source
    .replace(/^import type .*$/m, '')
    .replace('export const CURATED_SKILLS: SkillDef[] =', 'export const CURATED_SKILLS =')
  if (!asModule.includes('export const CURATED_SKILLS =')) {
    throw new Error(`${F6_SOURCE}: não achei o array CURATED_SKILLS (o histórico mudou de forma?)`)
  }
  mkdirSync(SCRATCH, { recursive: true })
  const scratchFile = join(SCRATCH, 'f6-curated.mjs')
  writeFileSync(scratchFile, asModule, 'utf8')
  const loaded = await import(`file://${scratchFile.replace(/\\/g, '/')}?t=${Date.now()}`)
  rmSync(scratchFile, { force: true })
  if (!Array.isArray(loaded.CURATED_SKILLS)) throw new Error('CURATED_SKILLS não é array')
  return loaded.CURATED_SKILLS
}

/** nome da pasta upstream (o puller precisa de `expectId` quando difere do id) */
function folderNameOf(path) {
  const parts = String(path ?? '')
    .split('/')
    .filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

function mapEntry(raw) {
  const source = raw.source ?? {}
  const entry = {
    id: raw.id,
    repo: source.repo,
    path: typeof source.path === 'string' ? source.path : ''
  }
  if (typeof source.ref === 'string' && source.ref.length > 0) entry.ref = source.ref
  entry.group = raw.group
  entry.depts = Array.isArray(raw.depts) ? [...raw.depts] : []
  entry.summary = raw.summary
  entry.hint = raw.hint
  if (Array.isArray(raw.requires) && raw.requires.length > 0) entry.requires = [...raw.requires]
  return entry
}

function validate(entry) {
  if (!isSkillId(entry.id)) return `id fora do padrão da casa: ${JSON.stringify(entry.id)}`
  if (typeof entry.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(entry.repo)) {
    return `repo fora de owner/repo: ${JSON.stringify(entry.repo)}`
  }
  for (const field of ['group', 'summary', 'hint']) {
    if (typeof entry[field] !== 'string' || entry[field].trim().length === 0) {
      return `campo "${field}" vazio`
    }
  }
  if (entry.depts.length === 0) return 'depts vazio'
  return undefined
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const curated = await loadF6Skills()
  const counts = { total: curated.length, agents: 0, skillsIn: 0, vetoed: [], rejected: [], out: 0 }
  const byId = new Map()

  for (const raw of curated) {
    if (raw?.kind !== 'skill') {
      counts.agents += 1
      continue
    }
    counts.skillsIn += 1
    const entry = mapEntry(raw)
    const repoKey = String(entry.repo ?? '').toLowerCase()
    if (VETOED_IDS.has(entry.id) || VETOED_REPOS.has(repoKey)) {
      counts.vetoed.push(entry.id)
      continue
    }
    const problem = validate(entry)
    if (problem) {
      counts.rejected.push(`${entry.id ?? '?'}: ${problem}`)
      continue
    }
    if (byId.has(entry.id)) {
      counts.rejected.push(`${entry.id}: id duplicado na curadoria F6`)
      continue
    }
    byId.set(entry.id, entry)
  }

  const entries = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  counts.out = entries.length

  const folderMismatch = entries.filter((entry) => entry.path && folderNameOf(entry.path) !== entry.id)
  const known = new Set(entries.map((entry) => entry.id))
  // Um `requires` que aponta para id VETADO (ou ausente) sai do dado: o puller
  // fecharia o router puxando os irmãos e bateria no veto — melhor o dado já
  // dizer a verdade. O que foi podado fica no relatório.
  const prunedRequires = []
  for (const entry of entries) {
    if (!entry.requires) continue
    const kept = entry.requires.filter((need) => known.has(need))
    for (const need of entry.requires) if (!known.has(need)) prunedRequires.push(`${entry.id} → ${need}`)
    if (kept.length > 0) entry.requires = kept
    else delete entry.requires
  }
  const withRequires = entries.filter((entry) => entry.requires)
  const danglingRequires = prunedRequires

  if (!dryRun) {
    // 2 espaços, LF, UTF-8 SEM BOM (BOM em dado nosso já custou uma sessão)
    const json = `${JSON.stringify(entries, null, 2)}\n`.replace(/\r\n/g, '\n')
    mkdirSync(dirname(OUT_FILE), { recursive: true })
    writeFileSync(OUT_FILE, json, { encoding: 'utf8' })
  }

  const report = [
    `fonte           ${F6_SOURCE}`,
    `entradas F6     ${counts.total} (skills ${counts.skillsIn} · agents descartados ${counts.agents})`,
    `vetadas         ${counts.vetoed.length}${counts.vetoed.length ? ` → ${counts.vetoed.join(', ')}` : ''}`,
    `recusadas       ${counts.rejected.length}${counts.rejected.length ? ` → ${counts.rejected.join(' | ')}` : ''}`,
    `no catálogo     ${counts.out}`,
    `pasta ≠ id      ${folderMismatch.length} (o puller precisa de expectId nessas)`,
    ...folderMismatch.map((entry) => `                · ${entry.path} → ${entry.id}`),
    `com requires    ${withRequires.length}${withRequires.length ? ` → ${withRequires.map((e) => e.id).join(', ')}` : ''}`,
    `requires soltos ${danglingRequires.length}${danglingRequires.length ? ` → ${danglingRequires.join(', ')}` : ''}`,
    `saída           ${dryRun ? '(--dry-run: nada escrito)' : OUT_FILE}`
  ]
  console.log(report.join('\n'))
}

main().catch((error) => {
  console.error(`skills-catalog-from-f6: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
