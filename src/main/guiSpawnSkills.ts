/**
 * O SEAM DO NASCIMENTO — qual CARDÁPIO este pane leva (Skills 2.0, ADR-0002/0003).
 *
 * Ele saiu do `ipc/gui.ts` no mesmo dia em que entrou, e por regra da casa: o
 * IPC já morava acima das ~1000 linhas por dívida antiga, e costura nova não
 * engorda arquivo gordo. Lá ficou o que é IPC (validar o remetente, delegar,
 * empurrar `gui:live`); aqui mora a decisão de KIT e as duas metades dela em
 * volta do `registry.create`.
 *
 * A ORDEM É A REGRA DESTE MÓDULO, e ela é o achado da sonda P4
 * (.synkora/reports/PROBE_SKILLS_CWD_2026-08-29.md): a pasta de skills tem de
 * existir ANTES de o processo nascer (o claude não re-varre o disco depois), e a
 * NOTA no fio só cabe DEPOIS que o pane abriu. É por isso que são duas funções e
 * não uma — `syncSpawnSkills` antes do create, `noteSkillsSync` no `finally`
 * dele — e o handler de `gui:create` chama as duas nessa ordem.
 *
 * NADA AQUI LANÇA: o cardápio é acessório da conversa, então falha de disco vira
 * nota no fio e linha no diário, nunca um chat que o dono não consegue abrir.
 *
 * `guiMissionOf` veio junto porque é a MESMA pergunta que o seam faz ("de que
 * missão é este pane?"); o `ipc/gui.ts` continua usando-a nos rótulos de
 * notificação, agora importando daqui.
 */
import {
  guiMissionRoleOf,
  guiPlanningPaneId,
  missionShortId,
  missionTypeOf
} from './guiMissionContracts'
import type { GuiPaneSpawn, GuiSessionRegistry } from './guiSessions'
import type { MainContext } from './mainContext'
import type { Mission } from './missions'
import type { SkillChatType } from './skillsKit'
import { skillsSyncNoteText, syncPaneSkills, type SkillSyncOutcome } from './skillsSync'

/**
 * Missão dona de um pane GUI, pela convenção `gui-<papel>-<id8>`. undefined =
 * pane de projeto (planejamento avulso) — o plano nasce sem missão de origem.
 */
export function guiMissionOf(
  ctx: MainContext,
  projectId: string,
  paneId: string
): Mission | undefined {
  if (!guiMissionRoleOf(paneId)) return undefined
  const short = paneId.split('-')[2] ?? ''
  return ctx.missions.list(projectId).find((candidate) => missionShortId(candidate.id) === short)
}

/**
 * `gui-plan-` — derivado do PRÓPRIO construtor do id (guiPlanningPaneId), para
 * a convenção não ganhar uma segunda cópia neste arquivo.
 */
const PLANNING_PANE_PREFIX = guiPlanningPaneId('')

export interface SkillChatResolution {
  /** null = kit VAZIO (release, ou pane sem tipo resolvível). */
  chat: SkillChatType | null
  /** por que, em PT-BR, para a caixa-preta. */
  reason: string
  /** o tipo não pôde ser derivado — kit vazio por PRECAUÇÃO, e o diário conta. */
  unresolved?: boolean
}

/**
 * QUAL KIT ESTE PANE LEVA (ADR-0003). O tipo do chat não é um campo do spawn:
 * ele se deriva do paneId + da natureza da missão, que é onde essa verdade já
 * mora. Nada aqui lança — um pane que este main não sabe classificar abre com
 * kit VAZIO e uma linha no diário, nunca com um cardápio adivinhado.
 *
 * Ajudante headless NÃO passa por aqui: ele não nasce pelo `gui:create` e herda
 * a pasta do worktree do delegador (ADR-0002). O reviewer passa, e passa certo:
 * ele divide o worktree com o dev, então o sync dele é o MESMO sync — idempotente.
 */
function skillChatTypeOf(ctx: MainContext, spawn: GuiPaneSpawn): SkillChatResolution {
  if (spawn.paneId.startsWith(PLANNING_PANE_PREFIX)) {
    return { chat: 'planejamento', reason: 'chat de planejamento' }
  }
  const role = guiMissionRoleOf(spawn.paneId)
  if (!role) {
    return {
      chat: null,
      reason: 'paneId fora das convenções de missão e de planejamento',
      unresolved: true
    }
  }
  const mission = guiMissionOf(ctx, spawn.projectId, spawn.paneId)
  if (!mission) {
    return {
      chat: null,
      reason: 'a missão deste pane não foi encontrada no universo',
      unresolved: true
    }
  }
  const missionType = missionTypeOf(mission)
  // Release NÃO tem cardápio por contrato (ADR-0003): kit vazio é a decisão,
  // não uma falha — e o sync ainda passa para LIMPAR o que ficou de outra era.
  if (missionType === 'release') return { chat: null, reason: 'missão de release: sem kit' }
  if (missionType === 'planejamento') {
    return { chat: 'planejamento', reason: `missão de planejamento (papel ${role})` }
  }
  return { chat: 'dev', reason: `missão de dev (papel ${role})` }
}

/**
 * O SYNC DO SPAWN. Roda ANTES do `registry.create` porque o claude só enxerga a
 * pasta de skills que JÁ EXISTIA no boot do processo — provado em binário na
 * sonda (P4, .synkora/reports/PROBE_SKILLS_CWD_2026-08-29.md): criar a pasta
 * depois não é percebido (não há watcher, e o catálogo por request não re-varre
 * o disco). Escrever depois de criar seria um kit que só vale na conversa
 * seguinte, em silêncio.
 *
 * NUNCA lança: o cardápio é um acessório da conversa, e uma falha de disco não
 * pode ser o que impede o dono de abrir o chat dele.
 */
export interface SpawnSkills {
  resolution: SkillChatResolution
  outcome: SkillSyncOutcome
}

export function syncSpawnSkills(ctx: MainContext, spawn: GuiPaneSpawn): SpawnSkills {
  const resolution = skillChatTypeOf(ctx, spawn)
  try {
    return { resolution, outcome: syncPaneSkills(spawn.cwd, resolution.chat) }
  } catch (error) {
    return {
      resolution,
      outcome: {
        ok: false,
        synced: [],
        removed: [],
        userModified: [],
        wrote: false,
        failures: [
          {
            id: 'skills',
            error: error instanceof Error ? error.message : 'falha ao preparar as skills'
          }
        ]
      }
    }
  }
}

/**
 * O EPÍLOGO DO SYNC: a nota no fio + a linha no diário. Roda DEPOIS do
 * `registry.create` porque `note` exige sessão viva — pane sem sessão recusa
 * sozinho, então não há um segundo julgamento aqui sobre o spawn ter dado
 * certo.
 *
 * FALHA DE SYNC NUNCA É MUDA (ADR-0002): a nota nomeia os ids que faltaram e a
 * receita (a tela que resolve). E nada aqui pode escapar: este epílogo roda no
 * `finally` do nascimento, e uma exceção sua transformaria um chat que ABRIU
 * numa falha de IPC.
 */
export function noteSkillsSync(
  ctx: MainContext,
  registry: GuiSessionRegistry,
  spawn: GuiPaneSpawn,
  skills: SpawnSkills
): void {
  try {
    const note = skillsSyncNoteText(skills.outcome)
    const noted = note !== null && registry.note(spawn.paneId, note).ok
    ctx.blackbox.record({
      cat: 'pane',
      event: 'skills-sync',
      actor: 'harness',
      ids: { paneId: spawn.paneId, projectId: spawn.projectId },
      reason: skills.resolution.reason,
      detail: {
        chat: skills.resolution.chat ?? 'sem kit',
        unresolved: skills.resolution.unresolved === true,
        synced: skills.outcome.synced.length,
        removed: skills.outcome.removed.length,
        failures: skills.outcome.failures.length,
        // Pasta do dono divergindo do kit é o sistema funcionando (arquivo
        // local nunca é podado) — mas é aqui, e só aqui, que isso fica
        // investigável depois.
        userModified: skills.outcome.userModified,
        wrote: skills.outcome.wrote,
        // ids, NUNCA caminhos: o `cwd` carrega a árvore/username do dono.
        failed: skills.outcome.failures.map((failure) => failure.id),
        noted
      }
    })
  } catch {
    // O cardápio é acessório do chat: nem o diário nem a nota podem derrubar
    // uma conversa que já nasceu.
  }
}
