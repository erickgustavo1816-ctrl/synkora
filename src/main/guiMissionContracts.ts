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
