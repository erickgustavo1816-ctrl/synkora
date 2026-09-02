/**
 * COSTURA DOS MCPs DE CHAT COM O CONTEXTO DO MAIN.
 *
 * Cada pane com direito a ferramenta recebe UM papel, pela régua única
 * `guiPaneToolKind` — e desde 2026-08-30 todos armam pelo MESMO encanamento
 * (`armGuiDelegateMcp`), com o papel decidindo o catálogo no servidor:
 * `gui-delegator` (kit de ajudantes), `gui-release` (release_*) e
 * `gui-planner` (kit de planos + ajudantes — ordem do dono: o planejador
 * delega pesquisa, com a mesma lateral e o mesmo pino D8 da missão).
 *
 * O motor é puro (token, flags, limpeza) e não conhece o `MainContext` — é o
 * que o mantém compilável sozinho nas suítes `test:gui-planner-mcp` e
 * `test:gui-delegate-mcp`. Este módulo é a única ponte entre ele e o main, e
 * existe porque DOIS caminhos precisam armar exatamente do mesmo jeito:
 *
 *  1. `missions:guiSpec` — o nascimento do chat de planejamento;
 *  2. o RE-ARME por spawn do `GuiSessionRegistry` — todo respawn (troca de modo
 *     de permissão, `/clear`, entrega da fila com modo novo) passa pelo mesmo
 *     teardown que revoga o token e apaga o arquivo de config.
 *
 * Ter duas cópias das deps era exatamente a divergência que produziu o bug de
 * 2026-08-17: o caminho 1 armava, o caminho 2 nem sabia que precisava.
 *
 * AUTORIDADE: quem pode ter ferramenta Synkora é decidido AQUI, pelo estado do
 * main, nunca pelo que o renderer mandou no spawn. O `spawn.mcp` que chega do
 * renderer é só o eco do que este main entregou; a régua é a mesma do
 * nascimento — pane de MISSÃO deste universo, no papel que o tipo dela dita.
 */
import { app } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { GuiPlannerMcp, GuiPlannerMcpDeps } from './guiPlannerMcp'
import { armGuiDelegateMcp, guiPaneToolKind } from './guiDelegateMcp'
import { guiMissionRoleOf, missionShortId } from './guiMissionContracts'
import type { GuiPaneSpawn } from './guiSessions'
import type { MainContext } from './mainContext'

/** Motivo pelo qual um pane NÃO recebeu ferramentas. Enum fechado: cada valor
 *  aparece no diário e responde sozinho "por que este chat está sem tools?".
 *  Desde 2026-08-30 sobrou UM valor: o pane sem direito a kit nenhum — as
 *  outras recusas (porta, disco, arquivo) são da trilha única da delegação
 *  (`GuiDelegateArmRefusal`), por onde o planejador também arma. */
export type GuiPlannerArmRefusal = 'not-a-planner'

/** O mesmo enum, para a trilha do DELEGADOR. Separado de propósito: o diário
 *  precisa distinguir "este chat não é planejador" de "este chat não é de
 *  missão dev" — as duas frases apontam para bugs diferentes. */
export type GuiDelegateArmRefusal =
  | 'server-down'
  | 'not-a-dev-mission'
  | 'write-failed'
  | 'config-file-missing'

/**
 * Deps do arm ligadas ao contexto vivo: porta do servidor MCP, `userData/mcp` e
 * os DOIS mapas que o teardown do `ipc/gui.ts` consome para revogar.
 */
export function guiPlannerMcpDepsFor(ctx: MainContext): GuiPlannerMcpDeps {
  return {
    hub: ctx.hub,
    port: () => ctx.mcpPort,
    configRoot: () => join(app.getPath('userData'), 'mcp'),
    tokenOf: (paneId) => ctx.paneTokens.get(paneId),
    remember: (paneId, { token, mcpFile }) => {
      ctx.paneTokens.set(paneId, token)
      if (mcpFile) ctx.paneMcpFiles.set(paneId, mcpFile)
    }
  }
}

/**
 * Missão dona de um pane GUI pela convenção `gui-<papel>-<id8>`.
 * `undefined` = o endereço não aponta para missão nenhuma deste universo.
 */
function missionOfPane(
  ctx: MainContext,
  projectId: string,
  paneId: string
): { missionType?: string; id: string; seatId?: string } | undefined {
  if (!guiMissionRoleOf(paneId)) return undefined
  const short = paneId.split('-')[2] ?? ''
  if (!short) return undefined
  return ctx.missions.list(projectId).find((candidate) => missionShortId(candidate.id) === short)
}

/**
 * Re-materializa as ferramentas deste pane para o processo que vai nascer.
 *
 * Idempotente por construção: o caminho do arquivo e as flags saem do paneId e
 * da porta, então re-armar não muda a linha de comando (e portanto não muda o
 * fingerprint do spawn). O token é novo quando o teardown revogou o anterior —
 * o arquivo é reescrito com ele na mesma passada, então processo e servidor
 * nunca discordam.
 *
 * `undefined` = este pane sai SEM ferramentas, com o motivo no diário. É a
 * saída honesta: um chat sem tools continua conversando; um chat apontando
 * para um arquivo apagado morre no boot do CLI.
 *
 * ROTEADOR do re-arme por spawn: os TRÊS papéis com kit (planejador, missão
 * dev, release) re-armam pelo MESMO arm da delegação — o papel do token decide
 * o catálogo no servidor (desde 2026-08-30 o planejador arma planos+ajudantes
 * num papel só). A régua (`guiPaneToolKind`) é a MESMA do nascimento em
 * `missions:guiSpec`, de propósito: duas cópias da decisão foi exatamente o
 * que produziu o chat mudo de 2026-08-17.
 *
 * Quem não é nenhum dos três recusa com `not-a-planner` — o mesmo diário de
 * sempre para um pane que pediu ferramenta sem ter direito a ela.
 */
export function rearmGuiPaneTools(
  ctx: MainContext,
  spawn: GuiPaneSpawn
): GuiPlannerMcp | undefined {
  const mission = missionOfPane(ctx, spawn.projectId, spawn.paneId)
  const kind = guiPaneToolKind(spawn.paneId, mission)
  // O release usa o MESMO arm da delegação com o papel próprio (R10). Cair num
  // braço que não conhece o papel deixava o pane DESARMADO em todo spawn
  // (incidente de 2026-08-20): o gancho de re-arme nasceu na R14 e o roteador
  // aprende cada papel novo AQUI, num lugar só.
  if (kind === 'none') {
    ctx.blackbox.record({
      cat: 'pane',
      event: 'gui-planner-arm-refused',
      actor: 'harness',
      ids: { paneId: spawn.paneId, projectId: spawn.projectId },
      detail: { reason: 'not-a-planner' satisfies GuiPlannerArmRefusal, cli: spawn.cli }
    })
    return undefined
  }
  return rearmGuiDelegateMcp(ctx, spawn)
}

/**
 * Re-materializa o MCP do chat — a ÚNICA trilha de re-arme desde 2026-08-30
 * (planejador incluso, com o papel dele). A ordem de guardas e a prova final
 * existem pela mesma falha de sempre: um processo nascendo com `--mcp-config`
 * apontando para um arquivo que o teardown acabou de apagar.
 */
export function rearmGuiDelegateMcp(
  ctx: MainContext,
  spawn: GuiPaneSpawn
): GuiPlannerMcp | undefined {
  const refuse = (reason: GuiDelegateArmRefusal): undefined => {
    ctx.blackbox.record({
      cat: 'pane',
      event: 'gui-delegate-arm-refused',
      actor: 'harness',
      ids: { paneId: spawn.paneId, projectId: spawn.projectId },
      detail: { reason, cli: spawn.cli }
    })
    return undefined
  }

  if (ctx.mcpPort === 0) return refuse('server-down')

  const mission = missionOfPane(ctx, spawn.projectId, spawn.paneId)
  const kind = guiPaneToolKind(spawn.paneId, mission)
  if (!mission || kind === 'none') return refuse('not-a-dev-mission')
  // O papel do token decide o early-return do catálogo no servidor: release
  // ganha release_status/release_run; dev ganha o kit da delegação; o
  // planejador (2026-08-30) ganha o kit de planos MAIS o de ajudantes.
  const role =
    kind === 'release'
      ? ('gui-release' as const)
      : kind === 'planner'
        ? ('gui-planner' as const)
        : ('gui-delegator' as const)

  let armed: GuiPlannerMcp | undefined
  try {
    armed = armGuiDelegateMcp(
      {
        paneId: spawn.paneId,
        projectId: spawn.projectId,
        cwd: spawn.cwd,
        cli: spawn.cli,
        missionId: mission.id,
        // O seat da CONVERSA VIVA, não o do nascimento da missão: o dono pode
        // ter trocado a conta, e a identidade tem de refletir quem está falando
        // (é ela que resolve a conta do ajudante quando o pedido não diz).
        ...(spawn.seatId ? { seatId: spawn.seatId } : {})
      },
      guiPlannerMcpDepsFor(ctx),
      role
    )
  } catch {
    // Disco cheio, permissão negada, userData somindo: o motivo bruto pode
    // carregar a árvore do usuário e não entra no diário.
    return refuse('write-failed')
  }
  if (!armed) return refuse('server-down')

  if (spawn.cli === 'claude') {
    const file = ctx.paneMcpFiles.get(spawn.paneId)
    if (!file || !existsSync(file)) return refuse('config-file-missing')
  }
  return armed
}

// `rearmGuiPlannerMcp` morava aqui: a trilha própria do kit de planos. Ela
// MORREU em 2026-08-30, quando o planejador entrou no regime da delegação
// (planos + ajudantes num papel só) e passou a re-armar pelo
// `rearmGuiDelegateMcp` com o papel `gui-planner` — a prova do arquivo de
// config e a ordem de guardas são as MESMAS, então duas cópias delas seriam
// exatamente a divergência que este módulo existe para impedir. A recusa
// `not-a-planner` (pane sem direito a kit nenhum) continua viva no roteador
// `rearmGuiPaneTools`, com o mesmo evento de diário de sempre.
