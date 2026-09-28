// O CHAT DE RELEASE (R10, 2026-08-19) — a conversa que sobe a VERSÃO para a main.
//
// Desenho aprovado pelo dono na mesma noite do "agente integrador" (R9), e é o
// MESMO modelo um andar acima: o botão "subir pra main" da versão mantém as
// travas de sempre, abre (ou reencontra) a MISSÃO DE RELEASE da versão — uma
// conversa que nasceu no worktree DELA e, desde a R27, mora na PASTA DO PROJETO
// (o worktree da versão é o diretório que a própria subida apaga) — e a tela do
// dono vai direto para lá. O chat nasce MUDO (contrato de sempre: o briefing
// pendente sai colado na primeira mensagem dele, depois de conta/modelo/effort
// escolhidos) e o agente opera a subida pelas ferramentas do papel
// `gui-release`.
//
// R38 (2026-08-29): são TRÊS — release_status, release_run e release_done. O
// fecho virou ferramenta porque a subida deixou de fechar sozinha (ver o
// comentário do runReleaseForChat).
//
// Este módulo é PURO de propósito (deps injetadas, nada de Electron): a régua
// de reuso da missão, a fotografia do release_status, o embrulho do release_run
// e a decisão do release_done são provados em node puro (`test:release-chat`)
// sem subir app.

// @ts-expect-error Node strip-types exige a extensão; o bundler também a aceita.
import { missionTypeOf } from './guiMissionContracts.ts'
// @ts-expect-error Node strip-types exige a extensão; o bundler também a aceita.
import { releasePublishStatusLine, type ReleasePublishSignal } from './releasePublish.ts'
import type { ReleaseChangesSignal } from '../shared/releaseChanges'
import type { ReleaseTargetProbe } from './releaseTarget'

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
  directRequest?: { title: string; currentVersionId?: string }
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
  const request = deps.directRequest
  if (request && version.status === 'lancada' && request.currentVersionId !== version.id)
    return { ok: false, error: 'esta versão lançada não é a atual' }
  const existing = deps.missions.find(
    (mission) =>
      mission.projectId === version.projectId &&
      mission.versionId === version.id &&
      missionTypeOf(mission) === 'release' &&
      mission.status !== 'arquivada' &&
      mission.status !== 'concluida'
  )
  if (existing) return { ok: true, missionId: existing.id, created: false }
  if (version.status === 'lancada' && !request)
    return { ok: false, error: `a versão ${version.name} já subiu para a main — não há release a operar` }
  if (version.status === 'aberta' && (!version.branch || !version.worktree))
    return {
      ok: false,
      error: `a versão ${version.name} ainda não tem branch/worktree próprios — crie uma missão nela primeiro (o isolamento nasce com a primeira missão)`
    }
  const created = deps.create({
    title: request?.title.trim() ?? `Publicar ${version.name}`,
    goal:
      request ? `Pedido do dono: ${request.title.trim()}\nVersão ${version.name}. ` +
        (version.status === 'lancada'
          ? 'Fase after-release: corrigir diretamente na PASTA DO PROJETO, sem novo número. Use release_status, release_save, release_push e release_done. O app instalado não recebe esta correção por auto-update; se o dono quiser isso, explique que precisa escolher uma nova versão, nunca escolha por ele.'
          : `Fase before-release: corrigir no WORKTREE DA VERSÃO ${version.worktree}; validar, usar release_save e depois release_run para a subida. Concluir a entrega com release_done.`)
      : `Operar o release da versão ${version.name}: conferir as travas, subir a branch da versão ` +
      'para o destino autorizado pelo dono, usando as ferramentas de release, e conferir a publicação solicitada.',
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
  target?: ReleaseTargetProbe
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
  /** R29 — a sonda de publicação do produto (script `release` + versões).
   *  Ausente = projeto sem package.json: a linha nem existe. */
  publish?: ReleasePublishSignal
  changes?: ReleaseChangesSignal
}

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 12) : '(desconhecido)'
}

/** A RECEITA do próximo passo — uma frase, sempre acionável. */
export function releaseNextStep(input: ReleaseStatusInput): string {
  if (input.releaseIntentPending)
    return 'há uma finalização de release pendente: chame release_run para recuperar a tentativa anterior. O Synkora verifica o Git e continua a limpeza sem repetir uma integração já gravada.'
  if (input.target?.error) return input.target.error
  if (input.changes?.error) return input.changes.error
  if (input.changes?.pending)
    return 'há um recibo de correção pendente: repita release_save com o mesmo requestId e argumentos para reconciliar.'
  if (input.changes?.dirty)
    return 'revise e valide os arquivos locais; registre as correções com release_save (arquivos, resumo, motivo e validação). Artefatos e dados privados devem ficar nas exclusões locais do projeto.'
  if (input.changes?.pendingPush)
    return 'há correções salvas com envio pendente; use release_push antes de encerrar com release_done.'
  if (input.version.status === 'lancada') {
    if (input.remote && input.remote.ahead !== 0)
      return 'a versão já subiu; use release_push para enviar a principal ao origin e conferir o envio.'
    return 'a versão já subiu; confira a entrega, inclusive o instalador quando solicitado, e chame release_done quando tudo estiver concluído.'
  }
  if (input.integrationPending.length > 0)
    return 'espere a fila de integração esvaziar (missão subindo vem antes da versão) — acompanhe e avise o dono se algo travar.'
  if (input.pendingMissions.length > 0)
    return 'as missões em andamento da versão precisam INTEGRAR (⇪ do dono em cada uma) ou ser arquivadas antes da subida.'
  if (input.openBacklogItems.length > 0)
    return 'os itens de backlog abertos da versão precisam virar missão (e concluir) ou ser excluídos antes da subida.'
  if (input.planLockMessage) return 'a trava do plano mestre está de pé — leia a mensagem dela acima e fale com o dono ("ou eu excluo ou eu faço").'
  return input.target?.needsSwitch
    ? `tudo livre: chame release_run; o Synkora abrirá ${input.target.branch} na pasta do projeto antes de integrar e enviar ao origin.`
    : 'tudo livre: chame release_run.'
}

export function releaseStatusText(input: ReleaseStatusInput): string {
  const { version } = input
  const lines = [
    `RELEASE DA VERSÃO ${version.name} → ${input.mainBranch ?? 'a branch principal'}.`,
    `ETAPA: ${version.status === 'lancada' ? 'versão já subida; entrega e correções finais' : 'preparação da subida'}.`,
    `BRANCHES: versão ${version.branch ?? '(sem branch)'} em ${shortSha(input.versionHead)} · principal ${input.mainBranch ?? '?'} em ${shortSha(input.mainHead)}.`
  ]
  if (input.target) lines.push(
    `DESTINO: ${input.target.branch ?? '(não definido)'}. PASTA DO PROJETO: ${input.target.currentBranch ?? '(não comprovada)'}.`,
    `BRANCHES DISPONÍVEIS: ${input.target.branches.join(', ') || '(nenhuma)'}. Para escolher ou alterar o destino autorizado pelo dono, use release_target; não peça uma configuração manual que o app não oferece.`
  )
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
    lines.push(`REMOTE: origin ${input.remote.url} · ${ahead} — ${version.status === 'lancada' ? 'release_push envia a principal sem repetir a subida' : 'o push acompanha a subida'}.`)
  }
  // R29 — a caixa entra na fotografia: o agente sabe ANTES do release_run se
  // a subida termina no push (só código) ou na publicação (pipeline
  // declarado). A frase mora no módulo de publicação, provada em node puro.
  if (input.publish) lines.push(releasePublishStatusLine(input.publish, version.status === 'lancada'))
  if (input.changes?.text) lines.push(input.changes.text)
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
  /** R38 — a sonda ESTRUTURAL da caixa, a MESMA do release_status (script
   *  `release` no package.json do produto). Sem manifesto ou sem script =
   *  false: nenhuma receita de publicação é inventada para quem não publica. */
  publishRequired(): boolean
}

/**
 * O `release_run` do agente: roda o motor de sempre e, no SUCESSO (provado pelo
 * status da versão, nunca por parsing), conta o que a subida MUDOU e o que
 * ainda falta.
 *
 * R38 (2026-08-29) — O FECHO É DO AGENTE. Até aqui esta função CONCLUÍA a
 * missão de release no sucesso e mandava "NÃO rode mais nada aqui" — resíduo da
 * era R10, quando a conversa morava no worktree da versão e perdia o chão junto
 * com ele. Desde a R27 ela opera a PASTA DO PROJETO, e desde a R29 a própria
 * persona diz o contrário (produto com pipeline só termina com a CAIXA). A
 * mecânica contradizia a persona e a mecânica ganhava: o dono pediu subida +
 * instalador, a subida pousou, a missão concluiu, o card sumiu (R30) e o
 * instalador nunca existiu. Palavras dele: "o certo é ele mesmo decidir: ó,
 * terminou aqui, vou fechar". Quem fecha agora é o `release_done`.
 */
export async function runReleaseForChat(
  deps: ReleaseRunDeps,
  versionId: string
): Promise<string> {
  const outcome = await deps.run(versionId, 'agent-release')
  const after = deps.versionAfter(versionId)
  if (after?.status !== 'lancada') return outcome
  return [
    outcome,
    // A verdade honesta que sobrou da frase antiga: o worktree DA VERSÃO morreu
    // mesmo. O que morreu com ele foi a branch, não a conversa — ela mora na
    // pasta do projeto desde a R27 e é lá que o resto do pedido acontece.
    'A branch e o worktree da versão foram removidos pela subida; esta conversa NÃO — ela segue na PASTA DO PROJETO, que é onde o que falta é feito.',
    ...(deps.publishRequired()
      ? [
          'PRÓXIMO PASSO — A CAIXA, na PASTA DO PROJETO: npm install se as dependências mudaram nesta subida, depois o script de release do produto (npm run release). Leia o veredito dele e conte ao dono.'
        ]
      : []),
    'CONTE AO DONO o desfecho em uma ou duas linhas.',
    'Se o pedido inclui PROD, confira o deploy na hospedagem e seu resultado. Enviar código ao origin não comprova publicação em produção, mesmo sem script release no package.json.',
    'Se corrigir código/testes durante a entrega, valide e use release_save para registrar os arquivos; depois release_push. O histórico fica ligado a esta versão, sem commit manual na principal.',
    'A conversa fecha quando VOCÊ chamar release_done, depois de entregar TUDO que o dono pediu.'
  ].join('\n')
}

// ————— o fecho (release_done, R38) —————

/** O ADVISORY auditado da caixa não confirmada — guarda de JULGAMENTO: ela
 *  nunca tranca o fecho, só carimba o recibo e a caixa-preta (regra da casa:
 *  guarda dura só protege autoridade/verificabilidade). */
export const RELEASE_DONE_BOX_ADVISORY =
  'pipeline declarado e caixa não confirmada — se o dono pediu instalável, confirme antes de fechar'

export interface ReleaseDoneInput {
  /** a versão desta conversa (undefined = o registro sumiu). */
  version: ReleaseChatVersion | undefined
  /** o produto declara pipeline de caixa? (o MESMO sinal estrutural do status) */
  publishRequired: boolean
  /**
   * A caixa está CONFIRMADA por algo verificável e BARATO daqui? `undefined` é
   * a resposta honesta de hoje: o veredito do `npm run release` mora no shell
   * do agente e a release publicada mora na rede — nada disso é verificável no
   * main sem inventar heurística. Ausência vira ADVISORY, nunca recusa.
   */
  boxConfirmed?: boolean
  changes?: ReleaseChangesSignal
}

export interface ReleaseDoneDecision {
  /** conclui a missão de release? */
  ok: boolean
  /** o recibo que volta para o agente (recusa SEMPRE nomeia a receita). */
  text: string
  /** o advisory auditado, quando existe (recibo + caixa-preta). */
  advisory?: string
}

/**
 * A DECISÃO do `release_done` — pura, provada em node puro.
 *
 * GUARDA DURA (autoridade verificável): sem a versão `lancada` não há release a
 * encerrar, e a recusa nomeia a RECEITA (`release_run`). É o único NÃO daqui.
 *
 * GUARDA DE JULGAMENTO (a caixa): pipeline declarado e caixa não confirmada
 * NÃO trancam nada — o agente é quem sabe se o dono pediu instalável, e um
 * beco sem saída seria pior que o vazamento. Conclui e CARIMBA o advisory.
 */
export function releaseDoneDecision(input: ReleaseDoneInput): ReleaseDoneDecision {
  const { version } = input
  if (!version)
    return {
      ok: false,
      text: 'esta conversa não está ligada a uma versão — não há release a encerrar.'
    }
  if (version.status !== 'lancada')
    return {
      ok: false,
      text:
        `a versão ${version.name} ainda NÃO subiu para a main — não há release a encerrar. ` +
        'RECEITA: leia release_status e, com a fotografia livre, chame release_run; ' +
        'release_done só fecha uma subida que já pousou.'
    }
  if (input.changes?.error || input.changes?.pending || input.changes?.dirty)
    return {
      ok: false,
      text: input.changes.error ?? (input.changes.pending
        ? 'há um recibo pendente: leia release_status e repita release_save com o mesmo requestId antes de release_done.'
        : 'há alterações locais sem registro: revise/valide, use release_save e release_push; depois repita release_done. Artefatos e dados privados devem ficar nas exclusões locais do projeto.')
    }
  if (input.changes?.pendingPush)
    return { ok: false, text: 'há correções salvas com envio pendente; leia release_status, use release_push e depois repita release_done.' }
  const advisory =
    input.publishRequired && input.boxConfirmed !== true ? RELEASE_DONE_BOX_ADVISORY : undefined
  return {
    ok: true,
    ...(advisory ? { advisory } : {}),
    text: [
      `release da versão ${version.name} ENCERRADO POR VOCÊ: a missão de release conclui e o card sai da coluna.`,
      ...(advisory ? [`ADVISORY (auditado, não bloqueia): ${advisory}.`] : []),
      'Diga ao dono, em uma linha, que a subida terminou e o que foi entregue.'
    ].join('\n')
  }
}
