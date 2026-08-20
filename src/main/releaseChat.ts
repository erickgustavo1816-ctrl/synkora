// O CHAT DE RELEASE (R10, 2026-08-19) — a conversa que sobe a VERSÃO para a main.
//
// Desenho aprovado pelo dono na mesma noite do "agente integrador" (R9), e é o
// MESMO modelo um andar acima: o botão "subir pra main" da versão mantém as
// travas de sempre, abre (ou reencontra) a MISSÃO DE RELEASE da versão — uma
// conversa no worktree DELA — e a tela do dono vai direto para lá. O chat nasce
// MUDO (contrato de sempre: o briefing pendente sai colado na primeira mensagem
// dele, depois de conta/modelo/effort escolhidos) e o agente opera a subida
// pelas duas ferramentas do papel `gui-release`.
//
// Este módulo é PURO de propósito (deps injetadas, nada de Electron): a régua
// de reuso da missão, a fotografia do release_status e o embrulho do
// release_run são provados em node puro (`test:release-chat`) sem subir app.

// @ts-expect-error Node strip-types exige a extensão; o bundler também a aceita.
import { missionTypeOf } from './guiMissionContracts.ts'

/** O mínimo de VERSÃO que este módulo lê (espelho do backlog.Version). */
export interface ReleaseChatVersion {
  id: string
  projectId: string
  name: string
  status: 'aberta' | 'lancada'
  branch?: string
  worktree?: string
}

/** O mínimo de MISSÃO que este módulo lê/escreve. */
export interface ReleaseChatMission {
  id: string
  projectId: string
  title: string
  status: string
  missionType?: string
  versionId?: string
}

export interface EnsureReleaseMissionDeps {
  version: ReleaseChatVersion
  /** missões do PROJETO da versão (o filtro é daqui). */
  missions: readonly ReleaseChatMission[]
  /** cria a missão de release e devolve o registro (ou null quando o store
   *  recusou — o chamador transforma em erro legível). */
  create(input: {
    title: string
    goal: string
    versionId: string
    missionType: 'release'
  }): ReleaseChatMission | null
}

export type EnsureReleaseMissionResult =
  | { ok: true; missionId: string; created: boolean }
  | { ok: false; error: string }

/**
 * UMA conversa de release por versão: o botão reencontra a missão de release
 * ATIVA da versão (clicar duas vezes não abre duas conversas) e só cria quando
 * não existe. Versão já lançada não ganha conversa — subiu, acabou.
 */
export function ensureReleaseMission(deps: EnsureReleaseMissionDeps): EnsureReleaseMissionResult {
  const { version } = deps
  if (version.status === 'lancada')
    return { ok: false, error: `a versão ${version.name} já subiu para a main — não há release a operar` }
  if (!version.branch || !version.worktree)
    return {
      ok: false,
      error: `a versão ${version.name} ainda não tem branch/worktree próprios — crie uma missão nela primeiro (o isolamento nasce com a primeira missão)`
    }
  const existing = deps.missions.find(
    (mission) =>
      mission.versionId === version.id &&
      missionTypeOf(mission) === 'release' &&
      mission.status !== 'arquivada' &&
      mission.status !== 'concluida'
  )
  if (existing) return { ok: true, missionId: existing.id, created: false }
  const created = deps.create({
    title: `Subir ${version.name} para a main`,
    goal:
      `Operar o release da versão ${version.name}: conferir as travas, subir a branch da versão ` +
      'para a principal pelas ferramentas de release e contar o desfecho ao dono.',
    versionId: version.id,
    missionType: 'release'
  })
  if (!created) return { ok: false, error: 'não consegui criar a missão de release — tente de novo' }
  return { ok: true, missionId: created.id, created: true }
}

// ————— a fotografia (release_status) —————

export interface ReleaseStatusInput {
  version: ReleaseChatVersion
  /** branch principal do projeto (a MESMA autoridade do release mecânico). */
  mainBranch?: string
  /** heads REAIS, lidos por quem tem git (o index injeta gitHead). */
  versionHead?: string
  mainHead?: string
  /** missões da versão ainda em andamento (a régua do releaseVersionImpl). */
  pendingMissions: readonly { title: string; status: string }[]
  /** itens de backlog abertos na versão. */
  openBacklogItems: readonly { title: string }[]
  /** a mensagem da trava do plano mestre (null = destravado). */
  planLockMessage: string | null
  /** tickets pendentes na fila de integração do projeto. */
  integrationPending: readonly { title: string; state: string }[]
  /** journal de release de uma tentativa anterior ainda no disco. */
  releaseIntentPending: boolean
  /** R28 — o remoto do projeto (origin) e o quanto a base local está à frente
   *  dele. Ausente = projeto sem remoto: a linha nem existe. */
  remote?: { url: string; ahead?: number }
}

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 12) : '(desconhecido)'
}

/** A RECEITA do próximo passo — uma frase, sempre acionável. */
export function releaseNextStep(input: ReleaseStatusInput): string {
  if (input.releaseIntentPending)
    return 'há um journal de release de uma tentativa anterior no disco: peça ao dono para reiniciar o Synkora (o boot reconcilia com segurança) antes de tentar de novo.'
  if (input.integrationPending.length > 0)
    return 'espere a fila de integração esvaziar (missão subindo vem antes da versão) — acompanhe e avise o dono se algo travar.'
  if (input.pendingMissions.length > 0)
    return 'as missões em andamento da versão precisam INTEGRAR (⇪ do dono em cada uma) ou ser arquivadas antes da subida.'
  if (input.openBacklogItems.length > 0)
    return 'os itens de backlog abertos da versão precisam virar missão (e concluir) ou ser excluídos antes da subida.'
  if (input.planLockMessage) return 'a trava do plano mestre está de pé — leia a mensagem dela acima e fale com o dono ("ou eu excluo ou eu faço").'
  return 'tudo livre: chame release_run.'
}

export function releaseStatusText(input: ReleaseStatusInput): string {
  const { version } = input
  const lines = [
    `RELEASE DA VERSÃO ${version.name} → ${input.mainBranch ?? 'a branch principal'}.`,
    `BRANCHES: versão ${version.branch ?? '(sem branch)'} em ${shortSha(input.versionHead)} · principal ${input.mainBranch ?? '?'} em ${shortSha(input.mainHead)}.`
  ]
  lines.push(
    input.integrationPending.length > 0
      ? `FILA DE INTEGRAÇÃO: ${input.integrationPending
          .map((ticket) => `"${ticket.title}" (${ticket.state})`)
          .join(' · ')} — missão subindo vem ANTES da versão.`
      : 'FILA DE INTEGRAÇÃO: vazia.'
  )
  lines.push(
    input.pendingMissions.length > 0
      ? `MISSÕES EM ANDAMENTO NA VERSÃO: ${input.pendingMissions
          .map((mission) => `"${mission.title}" (${mission.status})`)
          .join(' · ')}.`
      : 'MISSÕES EM ANDAMENTO NA VERSÃO: nenhuma.'
  )
  lines.push(
    input.openBacklogItems.length > 0
      ? `BACKLOG ABERTO NA VERSÃO: ${input.openBacklogItems.map((item) => `"${item.title}"`).join(' · ')}.`
      : 'BACKLOG ABERTO NA VERSÃO: nenhum.'
  )
  lines.push(input.planLockMessage ? `TRAVA DO PLANO: ${input.planLockMessage}` : 'TRAVA DO PLANO: destravada.')
  // R28 — o remoto entra na fotografia: o dono configurou um GitHub e o
  // release o ignorava. O push acompanha a subida; aqui só se diz a verdade.
  if (input.remote) {
    const ahead =
      input.remote.ahead === undefined
        ? 'distância desconhecida (remoto nunca buscado)'
        : input.remote.ahead === 0
          ? 'em dia com a base local'
          : `base local ${input.remote.ahead} commit(s) à frente`
    lines.push(`REMOTE: origin ${input.remote.url} · ${ahead} — o push acompanha a subida.`)
  }
  if (input.releaseIntentPending)
    lines.push('ATENÇÃO: existe um journal de release pendente de uma tentativa anterior.')
  lines.push(`PRÓXIMO PASSO: ${releaseNextStep(input)}`)
  return lines.join('\n')
}

// ————— o embrulho do release_run —————

export interface ReleaseRunDeps {
  /** o motor mecânico de sempre (releaseVersionImpl) — TODAS as travas e o
   *  merge com lacres moram nele; a string que volta já é honesta. */
  run(versionId: string, actor: string): Promise<string>
  /** a versão DEPOIS da tentativa — 'lancada' é o sinal estrutural de sucesso
   *  (nunca heurística sobre o texto). */
  versionAfter(versionId: string): ReleaseChatVersion | undefined
  /** conclui a missão de release no sucesso (o worktree da versão se foi). */
  concludeMission(missionId: string): void
}

/**
 * O `release_run` do agente: roda o motor de sempre e, no SUCESSO (provado pelo
 * status da versão, nunca por parsing), conclui a missão de release e avisa que
 * o worktree desta conversa morreu com a subida — a régua do integration_run.
 */
export async function runReleaseForChat(
  deps: ReleaseRunDeps,
  versionId: string,
  missionId: string
): Promise<string> {
  const outcome = await deps.run(versionId, 'agent-release')
  const after = deps.versionAfter(versionId)
  if (after?.status !== 'lancada') return outcome
  deps.concludeMission(missionId)
  return [
    outcome,
    'O worktree e a branch da versão foram removidos pela subida — esta conversa perdeu o chão de propósito: NÃO rode mais nada aqui.',
    'CONTE AO DONO o desfecho em uma ou duas linhas.'
  ].join('\n')
}
