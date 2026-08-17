/**
 * COSTURA DO MCP DO PLANEJADOR COM O CONTEXTO DO MAIN.
 *
 * `guiPlannerMcp.ts` é o motor puro (token, flags, limpeza) e não conhece o
 * `MainContext` — é o que o mantém compilável sozinho na suíte
 * `test:gui-planner-mcp`. Este módulo é a única ponte entre os dois, e existe
 * porque DOIS caminhos precisam armar exatamente do mesmo jeito:
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
 * nascimento — pane de missão de PLANEJAMENTO, e nada mais.
 */
import { app } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { armGuiPlannerMcp, type GuiPlannerMcp, type GuiPlannerMcpDeps } from './guiPlannerMcp'
import { guiMissionRoleOf, missionShortId, missionTypeOf } from './guiMissionContracts'
import type { GuiPaneSpawn } from './guiSessions'
import type { MainContext } from './mainContext'

/** Motivo pelo qual um pane NÃO recebeu ferramentas. Enum fechado: cada valor
 *  aparece no diário e responde sozinho "por que este chat está sem tools?". */
export type GuiPlannerArmRefusal =
  | 'server-down'
  | 'not-a-planner'
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
 */
export function rearmGuiPlannerMcp(
  ctx: MainContext,
  spawn: GuiPaneSpawn
): GuiPlannerMcp | undefined {
  const refuse = (reason: GuiPlannerArmRefusal): undefined => {
    ctx.blackbox.record({
      cat: 'pane',
      event: 'gui-planner-arm-refused',
      actor: 'harness',
      ids: { paneId: spawn.paneId, projectId: spawn.projectId },
      detail: { reason, cli: spawn.cli }
    })
    return undefined
  }

  // O servidor ainda não subiu: apontar para uma porta morta seria pior do que
  // nascer sem ferramenta (mesma decisão do nascimento, em guiPlannerMcp).
  if (ctx.mcpPort === 0) return refuse('server-down')

  const mission = missionOfPane(ctx, spawn.projectId, spawn.paneId)
  if (!mission || missionTypeOf(mission) !== 'planejamento') return refuse('not-a-planner')

  let armed: GuiPlannerMcp | undefined
  try {
    armed = armGuiPlannerMcp(
      {
        paneId: spawn.paneId,
        projectId: spawn.projectId,
        cwd: spawn.cwd,
        cli: spawn.cli,
        missionId: mission.id,
        // O seat da CONVERSA VIVA, não o do nascimento da missão: o dono pode
        // ter trocado a conta, e a identidade tem de refletir quem está falando.
        ...(spawn.seatId ? { seatId: spawn.seatId } : {})
      },
      guiPlannerMcpDepsFor(ctx)
    )
  } catch {
    // Disco cheio, permissão negada, userData somindo: o motivo bruto pode
    // carregar a árvore do usuário e não entra no diário.
    return refuse('write-failed')
  }
  if (!armed) return refuse('server-down')

  // A PROVA, e é ela que torna a falha de 2026-08-17 impossível de ser muda: o
  // claude recebe `--mcp-config <arquivo>` e morre com exit 1 se o arquivo não
  // existir. Conferir aqui nomeia o pane no diário; deixar passar devolveria ao
  // dono um erro cru do CLI sobre um caminho que ele nunca viu.
  if (spawn.cli === 'claude') {
    const file = ctx.paneMcpFiles.get(spawn.paneId)
    if (!file || !existsSync(file)) return refuse('config-file-missing')
  }
  return armed
}
