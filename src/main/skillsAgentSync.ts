/**
 * O HARNESS DA MISSÃO NO WORKTREE (Skills 3.0 — ADR-0009/0010,
 * .synkora/reports/DESIGN_HARNESS_DO_MODELO_2026-09-08.md §5.B).
 *
 * O que o AGENTE puxa (`skill_pull`) ou ESCREVE (o `mission-playbook`) vive nas
 * MESMAS pastas-alvo do kit do dono — porque são as pastas que os dois CLIs
 * leem (sonda PROBE_SKILLS_CWD_2026-08-29) — e é distinguido pela ORIGEM na
 * entrada do manifesto (`origin: 'agent'`). Palavras do dono: "ir lá, ler a
 * skill, utilizar a skill naquela missão e depois descartar".
 *
 * Este módulo nasceu SEPARADO de skillsSync.ts por regra da casa (arquivo
 * cruzando ~1000 linhas se divide na hora): lá mora o sync do kit e a mecânica
 * de árvore/manifesto, que este importa como interno declarado. Nenhuma das
 * leis de lá é reinventada aqui — em especial:
 *
 * - SÓ A IMPRESSÃO DIGITAL AUTORIZA DESTRUIR. O manifesto do worktree é entrada
 *   NÃO CONFIÁVEL (um agente escreve ali o dia inteiro): uma entrada que se diz
 *   `agent` não é licença para apagar pasta nenhuma. Quando o conteúdo diverge,
 *   a pasta FICA e a recusa nomeia a rota real — o agente tem ferramentas de
 *   arquivo no próprio worktree; beco sem saída é bug.
 * - PASTA DO DONO NUNCA É TOCADA. Sem entrada no manifesto, a pasta é dele (ou
 *   autoral do agente) e nem o pull nem o discard a alcançam.
 * - LINK NÃO SE ATRAVESSA: tudo passa por `probeTree`, que recusa symlink/junção
 *   antes de qualquer cópia ou remoção (armadilha permanente do Windows).
 * - id NUNCA vira caminho sem `isSkillId` — `.`, `..`, `/` e `\` morrem na porta.
 *
 * Sem Electron e sem rede: a rede é do skillsInstall (download pinado), e quem
 * costura os dois é o guiSkillTools (fatia D).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { isSkillId } from './skillsKit'
import { parseSkillFrontmatter } from './skillsLibraryScan'
import {
  TARGET_DIRS,
  compareText,
  fingerprintTree,
  materialize,
  probeTree,
  readManifest,
  removeManaged,
  witnessOf,
  writeManifest,
  type SkillSyncOrigin,
  type TreeSnapshot
} from './skillsSync'

/** Uma pasta viva na prateleira do worktree, como o agente a vê no skill_search.
 *  `user` = ninguém do Synkora escreveu (o dono, ou o próprio agente com as
 *  ferramentas dele) — a pasta que nunca é tocada. */
export interface WorktreeSkill {
  id: string
  origin: SkillSyncOrigin | 'user'
  /** pastas-alvo em que ela está (`.claude/skills`, `.agents/skills`) */
  targets: string[]
  description: string
}

export type AgentSkillWrite =
  | { ok: true; targets: string[]; replaced: boolean }
  | { ok: false; error: string }

export type MirrorSkillResult =
  | { ok: true; id: string; targets: string[] }
  | { ok: false; error: string }

export type DiscardSkillResult = { ok: true; removed: string[] } | { ok: false; error: string }

const MAX_DESCRIPTION = 200

const ID_RECIPE =
  'o id de uma skill usa minúsculas, dígitos e hífen simples (ex.: "systematic-debugging") — é ele que dá nome à pasta'

function truncate(text: string): string {
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION).trimEnd()}…` : text
}

/** A descrição que o cardápio do CLI vai mostrar — degradada, nunca ausente. */
function describeSkill(dir: string): string {
  let text: string
  try {
    text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  } catch {
    return 'sem SKILL.md legível nesta pasta'
  }
  const description = parseSkillFrontmatter(text).description
  return description ? truncate(description) : 'sem "description:" no frontmatter'
}

/** As pastas de skill de um alvo (só diretórios com id legal; a `.synkora-kit.json`
 *  é arquivo e nunca aparece aqui). */
function skillFoldersOf(targetDir: string): string[] {
  try {
    return readdirSync(targetDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSkillId(entry.name))
      .map((entry) => entry.name)
  } catch {
    // alvo inexistente = prateleira vazia naquele alvo, nunca exceção
    return []
  }
}

/**
 * A PRATELEIRA VIVA do worktree: a união dos dois alvos, com a origem de cada
 * pasta. É o que o `skill_search` mostra na primeira camada — "o que já está
 * aqui" — e o que o painel de contexto poderá listar depois.
 *
 * Origem em conflito entre alvos (raro: o dono pôs à mão num, o pull escreveu
 * no outro) resolve pelo que o MANIFESTO afirma, com `agent` na frente: a
 * pergunta que o agente faz é "isto é meu, posso descartar?".
 */
export function listWorktreeSkills(cwd: string): WorktreeSkill[] {
  if (!cwd) return []
  const found = new Map<string, WorktreeSkill>()
  for (const target of TARGET_DIRS) {
    const targetDir = join(cwd, target)
    const managed = readManifest(targetDir)
    for (const id of skillFoldersOf(targetDir)) {
      const origin: SkillSyncOrigin | 'user' = managed.has(id)
        ? (managed.get(id)?.origin ?? 'kit')
        : 'user'
      const current = found.get(id)
      if (!current) {
        found.set(id, {
          id,
          origin,
          targets: [target],
          description: describeSkill(join(targetDir, id))
        })
        continue
      }
      current.targets.push(target)
      if (origin === 'agent' || (origin === 'kit' && current.origin === 'user')) {
        current.origin = origin
      }
      if (current.description.startsWith('sem ')) {
        current.description = describeSkill(join(targetDir, id))
      }
    }
  }
  return [...found.values()].sort((left, right) => compareText(left.id, right.id))
}

// ————— escrita nos alvos —————

type TargetPlan =
  | { kind: 'write'; targetDir: string; target: string }
  | { kind: 'replace'; targetDir: string; target: string }
  /** já está lá e é idêntica à fonte: só a origem/testemunha é re-carimbada */
  | { kind: 'same'; targetDir: string; target: string }
  /** a própria pasta-fonte (mirrorLocalSkill): existe, e nunca é tocada */
  | { kind: 'source'; targetDir: string; target: string }

function ownerFolderRefusal(id: string, target: string, reason: string): string {
  return `"${id}" já existe em ${target}/ e essa pasta não é minha (${reason}) — eu nunca sobrescrevo pasta que não escrevi. Renomeie (ou apague) ${target}/${id} com as suas ferramentas e chame skill_pull de novo, ou puxe outra skill.`
}

function editedFolderRefusal(id: string, target: string): string {
  return `"${id}" está em ${target}/ mas foi EDITADA depois de puxada — não jogo fora o que você escreveu. Se quer a versão da fonte, apague ${target}/${id} (as edições são suas: salve o que importa antes) e chame skill_pull de novo; skill_discard também para de gerenciá-la e diz onde ela ficou.`
}

/**
 * O miolo compartilhado por `materializeAgentSkill` e `mirrorLocalSkill`:
 * PRÉ-VOO em todos os alvos e só depois escrita. É pré-voo por decisão de
 * projeto — meio-caminho (um alvo com a skill nova, o outro com a antiga) seria
 * um cardápio diferente por CLI na mesma missão, e a recusa por pasta do dono é
 * previsível.
 */
function writeAgentSkill(
  cwd: string,
  sourceDir: string,
  snapshot: TreeSnapshot,
  id: string
): AgentSkillWrite {
  const sourceFingerprint = fingerprintTree(sourceDir, snapshot)
  if (!sourceFingerprint) {
    return { ok: false, error: `não consegui ler a pasta de "${id}" para copiá-la` }
  }
  const sourceResolved = resolve(sourceDir)
  const plans: TargetPlan[] = []
  for (const target of TARGET_DIRS) {
    const targetDir = join(cwd, target)
    const destination = join(targetDir, id)
    if (resolve(destination) === sourceResolved) {
      plans.push({ kind: 'source', targetDir, target })
      continue
    }
    const probe = probeTree(destination)
    if (probe.kind === 'absent') {
      plans.push({ kind: 'write', targetDir, target })
      continue
    }
    if (probe.kind === 'foreign') {
      return { ok: false, error: ownerFolderRefusal(id, target, probe.reason) }
    }
    const entry = readManifest(targetDir).get(id)
    if (!entry) {
      return {
        ok: false,
        error: ownerFolderRefusal(id, target, 'não foi o skill_pull que a escreveu')
      }
    }
    const destFingerprint = fingerprintTree(destination, probe.snapshot)
    if (destFingerprint !== entry.fingerprint) {
      return { ok: false, error: editedFolderRefusal(id, target) }
    }
    plans.push({
      kind: destFingerprint === sourceFingerprint ? 'same' : 'replace',
      targetDir,
      target
    })
  }

  const targets: string[] = []
  let replaced = false
  for (const plan of plans) {
    const destination = join(plan.targetDir, id)
    if (plan.kind === 'replace') {
      const removal = removeManaged(destination)
      if (removal) return { ok: false, error: `${plan.target}: ${removal}` }
      replaced = true
    }
    if (plan.kind === 'write' || plan.kind === 'replace') {
      const error = materialize(cwd, sourceDir, snapshot, destination)
      if (error) return { ok: false, error: `${plan.target}: ${error}` }
    }
    targets.push(plan.target)
    // A pasta-fonte do agente NÃO entra no manifesto: ela é dele, e o discard
    // não pode apagar o que ele escreveu à mão (a `listWorktreeSkills` a mostra
    // como `agent` pelo espelho do outro alvo).
    if (plan.kind === 'source') continue
    const written = probeTree(destination)
    if (written.kind !== 'tree') continue
    const entries = [...readManifest(plan.targetDir).values()].filter(
      (candidate) => candidate.id !== id
    )
    entries.push({
      id,
      fingerprint: sourceFingerprint,
      dest: witnessOf(written.snapshot),
      source: witnessOf(snapshot),
      origin: 'agent'
    })
    writeManifest(plan.targetDir, entries)
  }
  return { ok: true, targets, replaced }
}

/**
 * PUXOU: promove uma pasta baixada (staging do `downloadSkillFolder`, ou uma
 * pasta da biblioteca da máquina) para os dois alvos do worktree, com
 * `origin: 'agent'`. A pasta-fonte não é tocada — quem a apaga é quem a criou.
 */
export function materializeAgentSkill(
  cwd: string,
  sourceDir: string,
  id: string
): AgentSkillWrite {
  if (!cwd) return { ok: false, error: 'esta conversa não tem pasta de trabalho' }
  if (!isSkillId(id)) return { ok: false, error: `"${String(id)}" não é um id de skill — ${ID_RECIPE}` }
  const probe = probeTree(sourceDir)
  if (probe.kind === 'absent') {
    return { ok: false, error: `a pasta de "${id}" desapareceu antes de eu copiá-la — puxe de novo` }
  }
  if (probe.kind === 'foreign') {
    return { ok: false, error: `a pasta de "${id}" não pôde ser copiada: ${probe.reason}` }
  }
  if (!probe.snapshot.files.some((file) => file.rel === 'SKILL.md')) {
    return {
      ok: false,
      error: `a pasta de "${id}" não tem SKILL.md na raiz — sem ele nenhum CLI lista a skill`
    }
  }
  return writeAgentSkill(cwd, sourceDir, probe.snapshot, id)
}

/**
 * ESCREVEU: o agente criou uma skill autoral no worktree (o `mission-playbook`
 * do ADR-0009) e quer que os DOIS CLIs a listem. A pasta que ele escreveu fica
 * onde está; o que este caminho faz é espelhá-la no alvo que não a tem.
 *
 * `relativeFolder` é caminho DENTRO do cwd — dado do agente, nunca autoridade:
 * `..`, raiz e letra de unidade morrem antes de virar caminho.
 */
export function mirrorLocalSkill(cwd: string, relativeFolder: string): MirrorSkillResult {
  if (!cwd) return { ok: false, error: 'esta conversa não tem pasta de trabalho' }
  const raw = typeof relativeFolder === 'string' ? relativeFolder.trim() : ''
  const parts = raw.replace(/\\/g, '/').split('/').filter((part) => part.length > 0)
  const recipe =
    'aponte a PASTA da skill dentro deste worktree (ex.: ".claude/skills/mission-playbook")'
  if (
    parts.length === 0 ||
    /^[A-Za-z]:$/.test(parts[0]) ||
    raw.startsWith('/') ||
    raw.startsWith('\\') ||
    parts.some((part) => part === '.' || part === '..')
  ) {
    return { ok: false, error: `caminho inválido — ${recipe}` }
  }
  const sourceDir = resolve(cwd, ...parts)
  const root = resolve(cwd)
  if (sourceDir !== root && !sourceDir.startsWith(root + sep)) {
    return { ok: false, error: `essa pasta está fora do worktree desta missão — ${recipe}` }
  }
  const folder = parts[parts.length - 1]

  const probe = probeTree(sourceDir)
  if (probe.kind === 'absent') {
    return { ok: false, error: `não achei a pasta "${parts.join('/')}" neste worktree — ${recipe}` }
  }
  if (probe.kind === 'foreign') {
    return { ok: false, error: `essa pasta não pôde ser copiada: ${probe.reason}` }
  }
  if (!existsSync(join(sourceDir, 'SKILL.md'))) {
    return {
      ok: false,
      error: `"${parts.join('/')}" não tem SKILL.md — uma skill é a pasta com o SKILL.md dentro (frontmatter com "name:" e "description:")`
    }
  }
  const bytes = readFileSync(join(sourceDir, 'SKILL.md'))
  // BOM na frente quebra o parse de frontmatter do codex (sonda 2026-08-29):
  // espelhar assim entregaria uma skill que só metade da casa lê.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return {
      ok: false,
      error: `o SKILL.md de "${folder}" começa com BOM (EF BB BF) e o codex rejeita o frontmatter assim — grave o arquivo em UTF-8 SEM BOM e chame de novo`
    }
  }
  const name = parseSkillFrontmatter(bytes.toString('utf8')).name?.trim().toLowerCase()
  if (!name || !isSkillId(name)) {
    return {
      ok: false,
      error: `o SKILL.md de "${folder}" não tem um "name:" válido no frontmatter (achei: "${name ?? '—'}") — ${ID_RECIPE}`
    }
  }
  if (name !== folder.toLowerCase()) {
    return {
      ok: false,
      error: `a pasta chama "${folder}" e o frontmatter diz name: "${name}" — os dois CLIs exigem pasta igual ao name; renomeie a pasta para "${name}" (ou corrija o "name:") e chame de novo`
    }
  }
  const written = writeAgentSkill(cwd, sourceDir, probe.snapshot, name)
  if (!written.ok) return { ok: false, error: written.error }
  return { ok: true, id: name, targets: written.targets }
}

// ————— descarte —————

interface DiscardPass {
  /** alvos de onde a pasta SAIU */
  removed: string[]
  /** alvos em que ela ficou, com o motivo (a recusa nomeia a rota) */
  kept: { target: string; reason: string }[]
  /** havia entrada `agent` para este id em algum alvo */
  managed: boolean
}

/**
 * O descarte de UM id, alvo por alvo. Destrói SÓ o que a impressão digital
 * prova ser a pasta que o pull escreveu; qualquer divergência deixa a pasta de
 * pé e some com a entrada do manifesto (paramos de gerenciá-la), porque o
 * manifesto do worktree é entrada não confiável e a alternativa seria um `rm`
 * comandado por arquivo.
 */
function discardOne(cwd: string, id: string): DiscardPass {
  const pass: DiscardPass = { removed: [], kept: [], managed: false }
  for (const target of TARGET_DIRS) {
    const targetDir = join(cwd, target)
    const managed = readManifest(targetDir)
    const entry = managed.get(id)
    if (!entry || entry.origin !== 'agent') {
      if (existsSync(join(targetDir, id))) {
        pass.kept.push({
          target,
          reason: entry
            ? 'ela veio do kit do dono (o sync a gerencia)'
            : 'não foi o skill_pull que a escreveu'
        })
      }
      continue
    }
    pass.managed = true
    const destination = join(targetDir, id)
    const probe = probeTree(destination)
    const stopManaging = (): void => {
      writeManifest(
        targetDir,
        [...managed.values()].filter((candidate) => candidate.id !== id)
      )
    }
    if (probe.kind === 'absent') {
      // Já não existe (o dono apagou à mão): o descarte só acerta o registro.
      stopManaging()
      pass.removed.push(target)
      continue
    }
    if (probe.kind === 'foreign') {
      stopManaging()
      pass.kept.push({ target, reason: probe.reason })
      continue
    }
    if (fingerprintTree(destination, probe.snapshot) !== entry.fingerprint) {
      stopManaging()
      pass.kept.push({ target, reason: 'foi editada depois de puxada' })
      continue
    }
    const removal = removeManaged(destination)
    if (removal) {
      pass.kept.push({ target, reason: removal })
      continue
    }
    stopManaging()
    pass.removed.push(target)
  }
  return pass
}

/**
 * DESCARTOU: tira do worktree a skill que o agente puxou. `removed` são as
 * PASTAS-ALVO limpas (o recibo do chat fala em alvos, não em ids).
 */
export function discardAgentSkill(cwd: string, id: string): DiscardSkillResult {
  if (!cwd) return { ok: false, error: 'esta conversa não tem pasta de trabalho' }
  if (!isSkillId(id)) return { ok: false, error: `"${String(id)}" não é um id de skill — ${ID_RECIPE}` }
  const pass = discardOne(cwd, id)
  if (pass.removed.length > 0) return { ok: true, removed: pass.removed }
  if (pass.kept.length > 0) {
    const named = pass.kept.map((kept) => `${kept.target}/${id} (${kept.reason})`).join(', ')
    return {
      ok: false,
      error: `não apaguei nada: ${named}. Não removo pasta que não seja comprovadamente a que eu escrevi — apague-a com as suas ferramentas se ela for sua, ou deixe-a e siga.`
    }
  }
  return {
    ok: false,
    error: `"${id}" não está entre as skills que este worktree puxou — use skill_search para ver a prateleira viva desta missão.`
  }
}

/**
 * A LIMPEZA DA MISSÃO: todo `origin: 'agent'` de uma vez (conclusão de missão de
 * planejamento, ADR-0010). `removed`/`kept` são IDS aqui — é a varredura, e o
 * que interessa é quais skills saíram. Nunca lança.
 */
export function discardAgentSkills(cwd: string): { removed: string[]; kept: string[] } {
  const removed: string[] = []
  const kept: string[] = []
  if (!cwd) return { removed, kept }
  const ids = new Set<string>()
  for (const target of TARGET_DIRS) {
    for (const entry of readManifest(join(cwd, target)).values()) {
      if (entry.origin === 'agent') ids.add(entry.id)
    }
  }
  for (const id of [...ids].sort(compareText)) {
    let pass: DiscardPass
    try {
      pass = discardOne(cwd, id)
    } catch {
      kept.push(id)
      continue
    }
    // Saiu de PELO MENOS um alvo = descartada (o alvo que ficou já foi nomeado
    // no `kept` daquele id pelo caminho de um id só, e o registro parou lá).
    if (pass.removed.length > 0) removed.push(id)
    else kept.push(id)
  }
  return { removed, kept }
}
