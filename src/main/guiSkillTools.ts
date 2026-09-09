/**
 * O KIT `skill` DOS CHATS — as três ferramentas com que o AGENTE monta o harness
 * da missão (Skills 3.0, fatia 5.D do design vinculante
 * `.synkora/reports/DESIGN_HARNESS_DO_MODELO_2026-09-08.md`; ADRs 0008–0011).
 *
 * Ordem do dono (2026-09-08, verbatim na intenção): "não quero mais algo fixo.
 * Quero que a IA decida qual é a melhor opção para ela ali naquele momento, e
 * ela vá atrás, ela busque, ela pegue e ela faça. O harness que o próprio
 * modelo cria é melhor do que um harness bruto que já vem e nem sempre vai
 * servir pra tudo." E, sobre a skill achada na internet: "ir lá, ler a skill,
 * utilizar a skill naquela missão e depois descartar."
 *
 * Este módulo é a metade que o AGENTE vê. Ele é o IRMÃO EXATO do
 * `guiBrowserTools.ts`, e a doutrina é a mesma: o `mcpServer.ts` REGISTRA o
 * catálogo nos papéis que o recebem, este arquivo IMPLEMENTA o produto, e o
 * motor (catálogo curado, download pinado, materialização no worktree, rastro)
 * mora nos módulos da fatia 5.B — nenhuma linha de mecânica é reinventada aqui.
 *
 * CINCO CERCAS DE CONTRATO, ditas aqui porque é aqui que elas mordem:
 *
 * 1. **O QUE SE PUXA VIVE SÓ NESTA MISSÃO** (ADR-0010). Os dois alvos do
 *    worktree, `origin: 'agent'` no manifesto, e a biblioteca da máquina NUNCA
 *    cresce por aqui: promover uma skill é clique do dono (R2), nunca do agente.
 *
 * 2. **RASTRO OBRIGATÓRIO.** Todo pull bem-sucedido escreve
 *    `.synkora/harness.json`, acende uma NOTA no fio (o dono lê `repo @ sha7`) e
 *    entra no diário. Sem isso o dono descobriria uma skill de terceiro no
 *    worktree dele lendo o disco.
 *
 * 3. **RECUSA É RESULTADO, nunca erro de protocolo**, e sempre nomeia a receita
 *    (`SKILLS_ENGINE_OFF` diz em letras maiúsculas que NADA foi puxado). Um
 *    agente que racionalizasse "puxei e falhou" contaria ao dono um harness que
 *    não existe.
 *
 * 4. **A RECARGA NÃO É PRÉ-CONDIÇÃO** (sonda `PROBE_SKILL_RELOAD_MIDTURN`, §9 do
 *    design): a pasta materializada NO MEIO do turno não entra no catálogo
 *    nativo daquele turno em CLI nenhum. Então o recibo entrega o caminho do
 *    SKILL.md ("leia com Read se precisar agora") e o harness pede, pelo
 *    bastidor, o `/reload-skills` que vale do turno seguinte em diante.
 *
 * 5. **A BUSCA É SOBRE A QUERY DO AGENTE**, nunca sobre o conteúdo do fio
 *    (heurística de conteúdo é proibida na casa, e no harness ela seria o app
 *    escolhendo no lugar do modelo — exatamente o que a ADR-0009 revoga).
 */
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { PaneIdentity } from './hub'
import {
  catalogEntry,
  searchSkillsCatalog,
  skillSourceVeto,
  type SkillCatalogEntry
} from './skillsCatalog'
import { downloadSkillFolder, parseSkillFolderUrl, type SkillDownload } from './skillsInstall'
import { parseSkillFrontmatter, scanSkillsLibrary } from './skillsLibraryScan'
import { TARGET_DIRS } from './skillsSync'
import {
  discardAgentSkill,
  listWorktreeSkills,
  materializeAgentSkill,
  mirrorLocalSkill,
  type WorktreeSkill
} from './skillsAgentSync'
import {
  recordSkillDiscard,
  recordSkillPull,
  skillDiscardNoteText,
  skillPullNoteText,
  type SkillHarnessEntry,
  type SkillHarnessOrigin
} from './skillsHarness'
import {
  SKILL_AGENT_PULL_OFF_REFUSAL,
  SKILL_NO_CWD_REFUSAL,
  SKILL_PULL_INPUT_REFUSAL,
  SKILL_URL_PARSE_REFUSAL,
  skillAlreadyHereReceipt,
  skillDiscardReceipt,
  skillPullReceipt,
  skillSearchText,
  skillUnknownIdRefusal,
  skillVetoRefusal,
  type GuiSkillToolkit,
  type SkillPullReceipt
} from './guiSkillKit'

/**
 * A SUPERFÍCIE DO §5.D, re-exportada. O catálogo MCP e os textos moram no módulo
 * FOLHA `guiSkillKit.ts` (ver o cabeçalho dele: importá-los daqui arrastaria as
 * 270 entradas do catálogo curado para seis compilações de suíte), mas o design
 * nomeia `guiSkillTools` como a casa das três tools — e é aqui que quem seguir o
 * documento vai procurar.
 */
export {
  SKILLS_ENGINE_OFF,
  SKILL_TOOL_NAMES,
  registerSkillsKit,
  type GuiSkillToolkit
} from './guiSkillKit'

export interface GuiSkillToolsDeps {
  /** worktree do pane / raiz do projeto no planejador / worktree do ajudante */
  cwdOf(identity: PaneIdentity): string | undefined
  /** o interruptor do dono (`settings.skillsAgentPull`) — rede só com ele ligado */
  agentPullEnabled(): boolean
  libraryRoot(): string
  /** injeção para teste: sem isto, o `globalThis.fetch` do processo */
  fetch?: typeof globalThis.fetch
  /** a linha que o DONO vê no fio (registry.note) */
  note(paneId: string, text: string): void
  /** o `/reload-skills` pelo bastidor (registry.reloadSkills) */
  reloadSkills(paneId: string): Promise<{ ok: boolean; detail?: string }>
  record(event: {
    event: string
    ids: Record<string, string | undefined>
    reason?: string
    detail?: Record<string, unknown>
    err?: string
  }): void
}

/** Pouso dos downloads DENTRO do worktree: `.synkora/` já é git-invisível, e a
 *  varredura recursiva dessa pasta é do sync do kit — as operações do agente
 *  removem o pouso individual, nunca a pasta inteira (um `rmSync` dela no meio
 *  de outro download apagaria o pacote de outra ficha). */
const STAGING_DIR = ['.synkora', 'skills-sync-tmp']

/** Quantas irmãs de `requires` uma skill pode arrastar. O catálogo fecha em 6
 *  hoje; o teto existe para um dado torto não virar uma frota de downloads. */
const MAX_SIBLINGS = 8

const SHELF_ORIGIN_LABEL: Record<WorktreeSkill['origin'], string> = {
  kit: 'prateleira do dono',
  agent: 'puxada nesta missão',
  user: 'sua ou do dono (o Synkora não a gerencia)'
}

/** O que foi materializado, pronto para virar rastro + recibo. */
interface PulledSkill {
  id: string
  origin: SkillHarnessOrigin
  repo?: string
  path?: string
  sha?: string
  targets: string[]
  replaced: boolean
  description?: string
}

type PullStep =
  | { ok: true; pulled: PulledSkill }
  | { ok: false; error: string; reason: string }

/** `<repo>/<path>` — a fonte PINÁVEL da entrada. O `catalogSourceUrl` é para
 *  EXIBIR (ele chuta `main`); quem baixa usa repo/path/ref do dado. */
function catalogSource(entry: SkillCatalogEntry): string {
  return entry.path ? `${entry.repo}/${entry.path}` : entry.repo
}

/**
 * A descrição REAL da skill já materializada, lida do frontmatter. Não sai da
 * `listWorktreeSkills` de propósito: ela degrada a linha ausente numa frase
 * nossa ("sem description…"), e gravar essa frase no rastro faria o briefing de
 * todo ajudante repetir um aviso de leitura como se fosse o ensino da skill.
 */
function describeMaterialized(cwd: string, id: string): string | undefined {
  for (const target of TARGET_DIRS) {
    let text: string
    try {
      text = readFileSync(join(cwd, target, id, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }
    const description = parseSkillFrontmatter(text).description?.replace(/\s+/gu, ' ').trim()
    if (description) return description
  }
  return undefined
}

function sha7(sha: string | undefined): string | undefined {
  return sha ? sha.slice(0, 7) : undefined
}

function trailOf(pulled: PulledSkill): string {
  if (pulled.origin === 'authored') return 'escrita por VOCÊ neste worktree (sem fonte externa)'
  if (pulled.origin === 'library') return 'da biblioteca da máquina do dono (sem rede)'
  const short = sha7(pulled.sha)
  if (pulled.repo && short) return `${pulled.repo} @ ${short}`
  return pulled.repo ?? 'fonte sem procedência declarada'
}

export function buildGuiSkillTools(deps: GuiSkillToolsDeps): GuiSkillToolkit {
  /** Os ids do diário. Nunca caminho absoluto (§7 do design): o worktree do dono
   *  não vira linha de log. */
  const idsOf = (identity: PaneIdentity): Record<string, string | undefined> => ({
    paneId: identity.paneId,
    projectId: identity.projectId,
    ...(identity.missionId ? { missionId: identity.missionId } : {})
  })

  /**
   * QUEM VÊ A NOTA. O ajudante é headless e não tem fio: a linha vai para o pane
   * do DELEGADOR, que é quem o dono está assistindo. E é o mesmo motivo pelo
   * qual ele não pede recarga (ver `reloadFor`).
   */
  const noteTargetOf = (identity: PaneIdentity): string =>
    identity.role === 'ajudante' && identity.delegatorPaneId
      ? identity.delegatorPaneId
      : identity.paneId

  /**
   * A RECARGA (sonda §9). No chat, o `/reload-skills` vai pelo bastidor e liga o
   * catálogo nativo do turno seguinte. No AJUDANTE, não: ele é uma sessão
   * headless de um turno, o stdin dele é o canal de steering do delegador e
   * mandar um slash por ali seria uma fala no meio do trabalho dele. A rota do
   * ajudante é a que sempre vale — ler o SKILL.md —, e o recibo dele diz isso.
   */
  const reloadFor = async (identity: PaneIdentity): Promise<SkillPullReceipt['reload']> => {
    if (identity.role === 'ajudante') return 'helper-skipped'
    const asked = await deps.reloadSkills(identity.paneId)
    deps.record({
      event: 'skill-reload',
      ids: idsOf(identity),
      detail: { ok: asked.ok, ...(asked.detail ? { detail: asked.detail } : {}) }
    })
    return asked.ok ? 'asked' : { failed: asked.detail ?? 'o CLI não confirmou a recarga' }
  }

  const refuse = (identity: PaneIdentity, reason: string, error: string, detail?: Record<string, unknown>): string => {
    deps.record({
      event: 'skill-pull-refused',
      ids: idsOf(identity),
      reason,
      ...(detail ? { detail } : {})
    })
    return error
  }

  /** O pouso do download é do CHAMADOR (contrato do `downloadSkillFolder`):
   *  sucesso ou falha, ele sai daqui — sobra de `.dl-*` no worktree do dono é
   *  lixo que ninguém mais reivindica. */
  const materializeFromStaging = (
    cwd: string,
    download: SkillDownload,
    id: string
  ): { ok: true; targets: string[]; replaced: boolean } | { ok: false; error: string } => {
    try {
      return materializeAgentSkill(cwd, download.dir, id)
    } finally {
      try {
        rmSync(download.dir, { recursive: true, force: true })
      } catch {
        // pouso já removido pelo próprio motor: nada a fazer
      }
    }
  }

  /** O campo só existe quando há descrição de verdade: `description: undefined`
   *  no rastro viraria uma chave morta no `harness.json` do dono. */
  const described = (value: string | undefined): { description?: string } =>
    value ? { description: value } : {}

  const fromLibrary = (cwd: string, id: string, fallback?: string): PullStep => {
    const written = materializeAgentSkill(cwd, join(deps.libraryRoot(), id), id)
    if (!written.ok) return { ok: false, error: written.error, reason: 'pasta-do-dono' }
    return {
      ok: true,
      pulled: {
        id,
        origin: 'library',
        targets: written.targets,
        replaced: written.replaced,
        ...described(describeMaterialized(cwd, id) ?? fallback)
      }
    }
  }

  const fromCatalog = async (cwd: string, entry: SkillCatalogEntry): Promise<PullStep> => {
    const veto = skillSourceVeto({ id: entry.id, repo: entry.repo })
    if (veto) {
      return { ok: false, error: skillVetoRefusal(veto.value, veto.reason), reason: 'veto' }
    }
    if (!deps.agentPullEnabled()) {
      return { ok: false, error: SKILL_AGENT_PULL_OFF_REFUSAL, reason: 'interruptor' }
    }
    const downloaded = await downloadSkillFolder(
      { repo: entry.repo, path: entry.path, ...(entry.ref ? { ref: entry.ref } : {}) },
      {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        staging: join(cwd, ...STAGING_DIR),
        // A CURADORIA INSTALA PELO NAME: 13 das 270 entradas apontam pastas cujo
        // nome upstream difere do id (skills/taste-skill → design-taste-frontend).
        // Sem `expectId` a régua "pasta == name" recusaria skills boas — entre
        // elas as duas direções estéticas que o dono citou.
        expectId: entry.id
      }
    )
    if (!downloaded.ok) return { ok: false, error: downloaded.error, reason: 'download' }
    const written = materializeFromStaging(cwd, downloaded.download, entry.id)
    if (!written.ok) return { ok: false, error: written.error, reason: 'pasta-do-dono' }
    return {
      ok: true,
      pulled: {
        id: entry.id,
        origin: 'catalog',
        repo: entry.repo,
        path: entry.path,
        sha: downloaded.download.sha,
        targets: written.targets,
        replaced: written.replaced,
        ...described(describeMaterialized(cwd, entry.id) ?? downloaded.download.description)
      }
    }
  }

  const fromUrl = async (cwd: string, url: string): Promise<PullStep> => {
    const source = parseSkillFolderUrl(url)
    if (!source) return { ok: false, error: SKILL_URL_PARSE_REFUSAL, reason: 'parse' }
    const repoVeto = skillSourceVeto({ repo: source.repo })
    if (repoVeto) {
      return { ok: false, error: skillVetoRefusal(repoVeto.value, repoVeto.reason), reason: 'veto' }
    }
    if (!deps.agentPullEnabled()) {
      return { ok: false, error: SKILL_AGENT_PULL_OFF_REFUSAL, reason: 'interruptor' }
    }
    const downloaded = await downloadSkillFolder(source, {
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      staging: join(cwd, ...STAGING_DIR)
    })
    if (!downloaded.ok) return { ok: false, error: downloaded.error, reason: 'download' }
    // O VETO POR NOME só pode ser conferido DEPOIS do download: o id nasce do
    // `name:` do frontmatter, e é justamente o nome que sombrearia um comando do
    // dono (`/security-review`). O pouso sai antes da recusa.
    const nameVeto = skillSourceVeto({ id: downloaded.download.id })
    if (nameVeto) {
      try {
        rmSync(downloaded.download.dir, { recursive: true, force: true })
      } catch {
        // pouso já removido
      }
      return {
        ok: false,
        error: skillVetoRefusal(nameVeto.value, nameVeto.reason),
        reason: 'veto'
      }
    }
    const id = downloaded.download.id
    const written = materializeFromStaging(cwd, downloaded.download, id)
    if (!written.ok) return { ok: false, error: written.error, reason: 'pasta-do-dono' }
    return {
      ok: true,
      pulled: {
        id,
        origin: 'url',
        repo: source.repo,
        path: source.path,
        sha: downloaded.download.sha,
        targets: written.targets,
        replaced: written.replaced,
        ...described(describeMaterialized(cwd, id) ?? downloaded.download.description)
      }
    }
  }

  const fromPath = (cwd: string, relative: string): PullStep => {
    const mirrored = mirrorLocalSkill(cwd, relative)
    if (!mirrored.ok) return { ok: false, error: mirrored.error, reason: 'pasta-autoral' }
    return {
      ok: true,
      pulled: {
        id: mirrored.id,
        origin: 'authored',
        targets: mirrored.targets,
        replaced: false,
        ...described(describeMaterialized(cwd, mirrored.id))
      }
    }
  }

  /** RASTRO + NOTA + DIÁRIO de UMA skill que já está no disco. */
  const remember = (identity: PaneIdentity, cwd: string, pulled: PulledSkill): void => {
    const harness = recordSkillPull(cwd, {
      id: pulled.id,
      origin: pulled.origin,
      ...(pulled.repo ? { repo: pulled.repo } : {}),
      ...(pulled.path ? { path: pulled.path } : {}),
      ...(pulled.sha ? { sha: pulled.sha } : {}),
      ...described(pulled.description),
      by: identity.paneId
    })
    const entry: SkillHarnessEntry =
      harness.entries.find((candidate) => candidate.id === pulled.id) ?? {
        id: pulled.id,
        origin: pulled.origin,
        ...(pulled.repo ? { repo: pulled.repo } : {}),
        ...(pulled.sha ? { sha: pulled.sha } : {}),
        pulledAt: new Date().toISOString(),
        by: identity.paneId
      }
    deps.note(noteTargetOf(identity), skillPullNoteText(entry))
    deps.record({
      // O PLAYBOOK TEM EVENTO PRÓPRIO (§7): "o agente escreveu o harness desta
      // missão" é uma história diferente de "o agente baixou uma skill", e o
      // diário do dono precisa distinguir as duas sem ler o detalhe.
      event: pulled.origin === 'authored' ? 'skill-authored' : 'skill-pulled',
      ids: idsOf(identity),
      detail: {
        id: pulled.id,
        origin: pulled.origin,
        ...(pulled.repo ? { repo: pulled.repo } : {}),
        ...(sha7(pulled.sha) ? { sha7: sha7(pulled.sha) } : {}),
        targets: pulled.targets,
        ...(pulled.replaced ? { replaced: true } : {})
      }
    })
  }

  return {
    search(identity, query) {
      const cwd = deps.cwdOf(identity)
      const shelf = cwd ? listWorktreeSkills(cwd) : []
      const shelfIds = new Set(shelf.map((skill) => skill.id))
      const library = scanSkillsLibrary(deps.libraryRoot()).filter(
        (entry) => !shelfIds.has(entry.id)
      )
      const trimmed = typeof query === 'string' ? query : ''
      const catalog = trimmed.trim() ? searchSkillsCatalog(trimmed, 12) : []
      deps.record({
        event: 'skill-search',
        ids: idsOf(identity),
        detail: {
          query: trimmed.slice(0, 120),
          shelf: shelf.length,
          library: library.length,
          catalog: catalog.length
        }
      })
      return skillSearchText({
        query: trimmed,
        shelf: shelf.map((skill) => ({
          id: skill.id,
          origin: SHELF_ORIGIN_LABEL[skill.origin],
          description: skill.description
        })),
        library: library.map((entry) => ({ id: entry.id, description: entry.description })),
        catalog: catalog.map((hit) => ({
          id: hit.entry.id,
          group: hit.entry.group,
          summary: hit.entry.summary,
          hint: hit.entry.hint,
          source: catalogSource(hit.entry)
        }))
      })
    },

    async pull(identity, input) {
      const cwd = deps.cwdOf(identity)
      if (!cwd) return refuse(identity, 'sem-pasta', SKILL_NO_CWD_REFUSAL)
      const id = typeof input.id === 'string' ? input.id.trim() : ''
      const url = typeof input.url === 'string' ? input.url.trim() : ''
      const path = typeof input.path === 'string' ? input.path.trim() : ''
      const chosen = [id, url, path].filter((value) => value.length > 0)
      if (chosen.length !== 1) return refuse(identity, 'entrada', SKILL_PULL_INPUT_REFUSAL)

      let step: PullStep
      const siblings: string[] = []
      const siblingFailures: string[] = []

      if (path) {
        step = fromPath(cwd, path)
      } else if (url) {
        step = await fromUrl(cwd, url)
      } else {
        // O id percorre as camadas na ORDEM da doutrina: prateleira (já está
        // aqui) → biblioteca da máquina (sem rede) → catálogo da casa (rede
        // pinada). Puxar o que já está no disco seria gastar cota por nada.
        const here = listWorktreeSkills(cwd).find((skill) => skill.id === id)
        if (here) {
          return skillAlreadyHereReceipt(
            here.id,
            here.targets,
            here.description,
            SHELF_ORIGIN_LABEL[here.origin]
          )
        }
        const inLibrary = scanSkillsLibrary(deps.libraryRoot()).find((entry) => entry.id === id)
        if (inLibrary) {
          step = fromLibrary(cwd, id, inLibrary.description)
        } else {
          const entry = catalogEntry(id)
          if (!entry) {
            // O VETO FALA ANTES DO "NÃO ACHEI": ids vetados são excluídos do
            // dado, e "não achei docx" mandaria o agente procurar na web
            // exatamente a skill que a licença proíbe.
            const veto = skillSourceVeto({ id })
            if (veto) {
              return refuse(identity, 'veto', skillVetoRefusal(veto.value, veto.reason), { id })
            }
            return refuse(identity, 'id-desconhecido', skillUnknownIdRefusal(id), { id })
          }
          step = await fromCatalog(cwd, entry)
          if (step.ok) {
            // AS IRMÃS DO ROTEADOR (o `requires` do catálogo fecha DENTRO dele:
            // zero soltos, medido pelo agente A). Irmã que falha é NOMEADA e
            // nunca derruba a principal — o playbook central já está no disco.
            for (const need of (entry.requires ?? []).slice(0, MAX_SIBLINGS)) {
              if (listWorktreeSkills(cwd).some((skill) => skill.id === need)) continue
              const sibling = catalogEntry(need)
              if (!sibling) {
                siblingFailures.push(`${need}: não está no catálogo`)
                continue
              }
              const pulledSibling = await fromCatalog(cwd, sibling)
              if (!pulledSibling.ok) {
                siblingFailures.push(`${need}: ${pulledSibling.error}`)
                continue
              }
              remember(identity, cwd, pulledSibling.pulled)
              siblings.push(need)
            }
          }
        }
      }

      if (!step.ok) return refuse(identity, step.reason, step.error, { ...(id ? { id } : {}) })
      remember(identity, cwd, step.pulled)
      const reload = await reloadFor(identity)
      return skillPullReceipt({
        id: step.pulled.id,
        targets: step.pulled.targets,
        ...(step.pulled.description ? { description: step.pulled.description } : {}),
        trail: trailOf(step.pulled),
        ...(step.pulled.replaced ? { replaced: true } : {}),
        ...(siblings.length > 0 ? { siblings } : {}),
        ...(siblingFailures.length > 0 ? { siblingFailures } : {}),
        reload
      })
    },

    async discard(identity, id) {
      const cwd = deps.cwdOf(identity)
      if (!cwd) return SKILL_NO_CWD_REFUSAL
      const removed = discardAgentSkill(cwd, typeof id === 'string' ? id.trim() : '')
      if (!removed.ok) {
        deps.record({
          event: 'skill-discard-refused',
          ids: idsOf(identity),
          detail: { id: typeof id === 'string' ? id.slice(0, 80) : '' }
        })
        // A recusa do motor JÁ nomeia a rota real (apagar com as ferramentas do
        // agente, ou deixar de pé): reescrevê-la aqui perderia o detalhe do alvo.
        return removed.error
      }
      recordSkillDiscard(cwd, id)
      deps.note(noteTargetOf(identity), skillDiscardNoteText(id))
      deps.record({
        event: 'skill-discarded',
        ids: idsOf(identity),
        detail: { id, removed: removed.removed }
      })
      return skillDiscardReceipt(id, removed.removed)
    }
  }
}
