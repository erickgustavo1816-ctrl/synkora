/**
 * CONTRATOS DO PANE GUI DE MISSÃO (Synkora 2.0, onda B — docs/PLANO_2_0_GUI.md).
 *
 * Missão DIRETA não tem orquestrador nem maquinaria de plano: o dono abre a
 * missão e fala com o DEV; revisar é uma conversa LIMPA sobre o diff entregue;
 * ajudante é outro chat no MESMO worktree. Aqui moram as duas coisas que os
 * dois lados precisam concordar:
 *
 * 1. A CONVENÇÃO DE paneId — endereço estável do resume. O guiSessions grava
 *    `paneId → {sessionId, cli}`; se o id mudasse a cada abertura, reabrir a
 *    missão nasceria com a conversa em branco. Por isso dev/reviewer têm id
 *    determinístico e só o ajudante ganha sufixo (são vários no mesmo card).
 * 2. Os CONTRATOS de sistema de cada papel — curtos de propósito: contrato
 *    longo vira constituição e o modelo passa a temer o próprio juízo.
 *
 * A onda C acrescentou o terceiro habitante da mesma convenção: a sessão de
 * PLANEJAMENTO do universo (`gui-plan-<id8>`), que ocupou o lugar do PM
 * permanente em projeto sem missão legada viva.
 *
 * Módulo PURO (nada de electron/fs/git): é o que deixa a convenção testável
 * sem subir o app.
 */

export type GuiMissionRole = 'dev' | 'reviewer' | 'helper'

export const GUI_MISSION_ROLES: readonly GuiMissionRole[] = ['dev', 'reviewer', 'helper']

export function isGuiMissionRole(value: unknown): value is GuiMissionRole {
  return typeof value === 'string' && (GUI_MISSION_ROLES as readonly string[]).includes(value)
}

/** Os 8 primeiros chars do id — a mesma régua do branch mission/<id8>. */
export function missionShortId(missionId: string): string {
  return missionId.slice(0, 8)
}

/**
 * `gui-<papel>-<id8>` (ajudante: `gui-helper-<id8>-<n>`, n ≥ 1). Papel ANTES
 * do id porque é assim que o chrome do pane lê o endereço de relance.
 */
export function guiMissionPaneId(
  role: GuiMissionRole,
  missionId: string,
  index?: number
): string {
  const base = `gui-${role}-${missionShortId(missionId)}`
  if (role !== 'helper') return base
  const n = Number.isFinite(index) && (index as number) >= 1 ? Math.floor(index as number) : 1
  return `${base}-${n}`
}

/** Todo pane GUI desta missão (dev, reviewer e ajudantes) — usado no ceifar. */
export function isGuiMissionPaneId(paneId: string, missionId: string): boolean {
  const short = missionShortId(missionId)
  return (
    paneId === `gui-dev-${short}` ||
    paneId === `gui-reviewer-${short}` ||
    paneId.startsWith(`gui-helper-${short}-`)
  )
}

/** Papel de um paneId da convenção (undefined = não é pane GUI de missão). */
export function guiMissionRoleOf(paneId: string): GuiMissionRole | undefined {
  for (const role of GUI_MISSION_ROLES) {
    if (paneId.startsWith(`gui-${role}-`)) return role
  }
  return undefined
}

// ————— contratos de sistema (EN; o agente responde em PT-BR) —————

const DEV_CONTRACT = `You are the DEVELOPER of this mission inside Synkora.
- You work ONLY inside this worktree: it is an isolated git branch created for this mission. Never touch another repository or the owner's main checkout.
- Before any large piece of work, post a MINI-PLAN of at most 5 lines and WAIT for the owner's approval. A small, obvious edit does not need one — just do it.
- Implement, then run the checks that cover what you touched (typecheck, lint, the tests of those files). Never claim something works on unverified work.
- Commit as you go, with clear messages in English. Never end a round with a dirty branch.
- The OWNER of this mission is the orchestrator here: they decide scope, priority and when to integrate. Ask them instead of inventing requirements.
- When a round ends, close with 3-5 lines: what changed, what you verified, what is still open.
- If the integration hits a conflict, the app tells you here: bring the target branch into this one, resolve, test, commit, and tell the owner.
- Anything the owner should see (a report, a decision record) goes in the repo, never only in this chat.
- Always answer in PT-BR. Code, identifiers and commit messages stay in English.`

const REVIEWER_CONTRACT = `You are the REVIEWER of this mission inside Synkora, reading it on a CLEAN context.
- Read the delivered diff in this worktree and judge it against the mission goal you were given. That goal is the whole contract; nothing else is in scope.
- YOU REVIEW WHAT WAS DELIVERED, YOU NEVER LEGISLATE WHAT SHOULD EXIST. Demanding capability the mission never promised (migrations, rollback/backup, telemetry, feature flags, hardening) is at most a non-blocking suggestion.
- Every finding is concrete: file:line, what is wrong, why it matters. No vague taste, no rewrite-it-my-way.
- Verify cheap factual claims yourself before reporting them. Character-level claims (quotes, dashes, encoding) require byte-authoritative reading — garbled text is usually YOUR reading channel, not the file.
- You do NOT edit the product and you do not run the app: you read and you report.
- Close with a verdict — APROVADO or REPROVADO — plus the complete list, ordered by severity. On a later round the list only shrinks: your own prescriptions bind you.
- Always answer in PT-BR. Quote code and identifiers as they are.`

const HELPER_CONTRACT = `You are a HELPER working next to the mission developer, in the SAME worktree.
- Do exactly the slice you were asked for. Do not widen the scope and do not refactor around it.
- Another agent is editing this same tree right now: touch only the files of your slice and never revert someone else's change.
- Run the checks that cover what you touched, then report in 3-5 lines: what you changed, what you verified, what is left.
- Do not commit unless you were explicitly told to — the developer integrates and signs the work.
- Always answer in PT-BR. Code and identifiers stay in English.`

export function guiMissionSystemPrompt(role: GuiMissionRole): string {
  if (role === 'reviewer') return REVIEWER_CONTRACT
  if (role === 'helper') return HELPER_CONTRACT
  return DEV_CONTRACT
}

export interface GuiMissionBriefing {
  title: string
  goal?: string
  scope?: string
  /** branch da missão (origem do diff). */
  branch?: string
  /** branch de onde a missão nasceu (base do diff do reviewer). */
  baseBranch?: string
}

/**
 * Primeiro turno de cada papel. É o único briefing que o pane recebe: o dono
 * conversa a partir daqui, não existe re-briefing perseguindo o pane.
 */
export function guiMissionFirstPrompt(
  role: GuiMissionRole,
  mission: GuiMissionBriefing
): string {
  const head = [
    `MISSION: ${mission.title}`,
    mission.goal?.trim() ? `GOAL:\n${mission.goal.trim()}` : undefined,
    mission.scope?.trim() ? `SCOPE: ${mission.scope.trim()}` : undefined
  ]
    .filter(Boolean)
    .join('\n')
  if (role === 'reviewer') {
    const base = mission.baseBranch?.trim() || 'main'
    return `${head}

You are reviewing what was DELIVERED for this mission. Start by reading the diff in this worktree:

    git diff ${base}...HEAD

Judge that diff against the GOAL above and nothing else. Report concrete findings (file:line) ordered by severity and close with APROVADO or REPROVADO. Never demand capability the mission did not promise. Answer in PT-BR.`
  }
  if (role === 'helper') {
    return `${head}

You are a helper on this mission and you share the worktree with the developer. Introduce yourself in ONE line (PT-BR) and wait for the specific slice you are supposed to do — do not start touching files before that instruction arrives.`
  }
  return `${head}

This worktree${mission.branch ? ` (branch ${mission.branch})` : ''} is yours for this mission. Your VERY FIRST output — before any tool call — is a 2-3 line note in PT-BR restating the goal as you understood it. Then study what already exists here; if the work is large, post a mini-plan of at most 5 lines and wait for the owner's go before implementing.`
}

// ————— PLANEJAMENTO do universo (2.0, onda C) —————
//
// O PM/Maestro permanente deixou de nascer em projeto sem missão legada viva:
// no lugar dele a coluna "✦ geral" abre uma sessão de PLANEJAMENTO — one-off,
// que entrevista o dono e ESCREVE o roadmap no repo. As missões continuam
// sendo criadas PELO DONO no app a partir desses arquivos; o planejador nunca
// executa produto nem abre missão sozinho.

/** `gui-plan-<id8 do projeto>` — endereço estável do resume, como os de missão. */
export function guiPlanningPaneId(projectId: string): string {
  return `gui-plan-${projectId.slice(0, 8)}`
}

/** O pane de planejamento DESTE projeto (usado no ceifar por projeto). */
export function isGuiPlanningPaneId(paneId: string, projectId: string): boolean {
  return paneId === guiPlanningPaneId(projectId)
}

const PLANNING_CONTRACT = `You are the PLANNING ARCHITECT of this project inside Synkora, running as a ONE-OFF planning session.
- You do NOT execute product work: no feature, no refactor, no fix. Reading the repository to understand it is expected; changing it is not.
- Interview the owner BRIEFLY in PT-BR: a couple of sharp questions at a time, never a questionnaire. Stop asking the moment you can propose something concrete.
- Propose, in plain PT-BR the owner can judge without reading code: the SCOPE OF THE NEXT VERSION and a SMALL breakdown into missions.
- ONE DELIVERABLE PER MISSION. A title with "e" in it is two missions. A mission the owner cannot accept in one sitting is too big.
- Each mission must stand on its own: name what it depends on instead of swallowing the dependency.
- Never invent scope the owner did not ask for, and say out loud what you are deliberately leaving out.
- WAIT for the owner to agree with the breakdown. Agreement is explicit; silence is not consent.
- Once they agree, WRITE the plan into the repository: plano/roadmap.md with the version scope and the ordered mission list, plus one file per mission at plano/NNN-slug.md (NNN = 001, 002, … in execution order).
- Every mission file has exactly these sections, with these names, in this order: Objetivo / Fora de escopo / Critério de pronto / Tier / Contexto.
- "Critério de pronto" is binary and observable — something the owner can check with their own eyes, never "ficou bom".
- "Tier" is the size of the work in one word (pequeno / médio / grande) plus one line saying why.
- "Contexto" points at the files, screens and decisions that already exist and matter for that mission.
- Missions are CREATED BY THE OWNER in the app, from these files. You never create, start or run a mission yourself.
- When the files are written, close with a short PT-BR summary: which files you wrote and what the owner does next.
- Always answer in PT-BR. Section names stay exactly as specified above; code, identifiers and file names stay in English.`

export function guiPlanningSystemPrompt(): string {
  return PLANNING_CONTRACT
}

export interface GuiPlanningBriefing {
  projectName: string
  /** versão aberta corrente — escopo natural do plano, quando existe. */
  versionName?: string
  /** plano/roadmap.md JÁ existe no repo: retomar em vez de recomeçar. */
  roadmapExists?: boolean
}

/**
 * Primeiro turno do planejador. Só sai em conversa NOVA (retomada já tem o
 * briefing) e nomeia o caderno do repo — "o plano não existe" soa como
 * briefing perdido; "ainda não existe, normal" é a verdade.
 */
export function guiPlanningFirstPrompt(input: GuiPlanningBriefing): string {
  const head = [
    `PROJECT: ${input.projectName}`,
    input.versionName?.trim() ? `VERSION IN PROGRESS: ${input.versionName.trim()}` : undefined
  ]
    .filter(Boolean)
    .join('\n')
  const roadmap = input.roadmapExists
    ? 'This project ALREADY has plano/roadmap.md. Read it first, together with the plano/NNN-*.md files next to it, and continue from there: state in PT-BR what is already planned and what is still open before proposing anything new.'
    : 'This project has no plano/roadmap.md yet — normal for a first planning session. Say exactly that in PT-BR, never something that sounds like a lost plan.'
  return `${head}

${roadmap}

Your VERY FIRST output — before any tool call — is a 2-3 line note in PT-BR: that you are the planning session for this universe, that you plan and write the roadmap but never execute the work, and the ONE question that unblocks the plan. Only then study what already exists here.`
}

/**
 * Guarda do resume (2.0): conversa gravada só vale no MESMO CLI. Sessão do
 * claude não se retoma no codex e vice-versa — trocar a conta do universo/da
 * missão para outro CLI faria o spawn nascer pedindo uma sessão que aquele
 * binário não conhece. Fonte ÚNICA das duas specs (missão e planejamento).
 */
export function resumeSessionIdFor(
  remembered: { sessionId?: string; cli?: string } | undefined,
  seatCli: string
): string | undefined {
  if (!remembered?.sessionId) return undefined
  return remembered.cli === seatCli ? remembered.sessionId : undefined
}

/**
 * Receita do conflito de integração ENTREGUE NA CONVERSA do dev (2.0: não há
 * orquestrador para triar — quem resolve é quem escreveu). `detail` já vem da
 * fila com os arquivos/causa; a receita diz o movimento.
 */
export function missionConflictRecipe(input: {
  missionTitle: string
  detail: string
  targetBranch?: string
  sourceBranch?: string
}): string {
  const target = input.targetBranch?.trim() || 'a branch de destino'
  const source = input.sourceBranch?.trim() || 'a branch desta missão'
  return [
    `[synkora] a integração de "${input.missionTitle}" PAROU: ${input.detail}`,
    '',
    `RECEITA: traga ${target} para dentro de ${source} no seu worktree, resolva os conflitos, rode os testes que cobrem o que mudou, commite e avise o dono — a fila retoma na mesma posição quando ele aprovar de novo.`
  ].join('\n')
}
