/**
 * MCP API — domínio helpers (fase 1, commit 4c).
 * Delegação e ciclo de vida de ajudantes: abrir em lote (seat/modelo/
 * skills/armamento), listar, ler transcript, mandar mensagem e fechar.
 *
 * Corpo movido VERBATIM do literal mcpApi do index.ts. O return é tipado
 * Pick<McpApi, …> para preservar o contextual typing; uiSender/mcpPort e a
 * máquina de fases são lidos via ctx (getters/ctx.phase).
 */
import { app, shell } from 'electron'
import { join, resolve } from 'path'
import { type SeatCli } from '../seats'
import { type Task } from '../tasks'
import { ensureSynkoraGitExcludes } from '../worktree'
import {
  EXECUTION_MODE_LABEL,
  assessMissionRisk,
  helperLimitForExecutionMode,
  normalizeDelegationMode,
  type MissionExecutionMode
} from '../orchestratorFlow'
import { HelperSpawnReservationRegistry } from '../helperSpawnReservations'
import { HelperOpenWatchdog } from '../helperOpenWatchdog'
import { buildSkillsBlock } from '../phasePrompts'
import { type DevPaneSpec } from '../phaseTypes'
import { requiresManualSecurityValidation, securityPromptForRole } from '../securityPolicy'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { Hub, type PaneIdentity } from '../hub'
import { getSeatUsage } from '../seatUsage'
import { type DelegateOpts } from '../mcpServer'
import { type SkillDef } from '../skillsLibrary'
import {
  IMPECCABLE_SKILL_ID,
  SYNKORA_FRONTEND_STANDARD_ID,
  classifyTaskUiWork,
  isVisualMethod,
  missingMandatoryUiPhaseSkills,
  selectPhaseSkillPlan,
  skillCompatibilityIssue,
  type SkillCapability
} from '../skillsRouting'
import { SkillRuntime, type PlannedSkillInput } from '../skillRuntime'
import { formatHelperCompletionNote, helperCompletionNotificationKey } from '../helperCompletion'
import {
  HELPER_RECOVERY_VERSION,
  filterHelperRecoveryRecords,
  formatHelperRecoveryTranscript,
  parseHelperRecoveryTranscript,
  type HelperRecoveryRecord
} from '../helperRecovery'
import {
  effectiveSensitiveAccess,
  paneAccessProfile,
  paneBrowserAvailable
} from '../panePermissions'
import type { MainContext } from '../mainContext'
import type { McpApi } from '../mcpServer'

/** Dependências do closure do index ainda não migradas (mesmo padrão
 * do PhaseEngineExtras). */
export interface HelpersApiExtras {
  armPane(
    identity: Omit<PaneIdentity, 'paneId'> & { paneId?: string },
    cli: SeatCli,
    opts?: { strictMcp?: boolean; configDir?: string; sensitive?: boolean }
  ): { paneId: string; cliArgs: string[] }
  prepareSkillPlanInputs(
    rootIds: string[],
    describe: (id: string) => Pick<PlannedSkillInput, 'operation' | 'reason' | 'required'>
  ): Promise<{ definitions: SkillDef[]; inputs: PlannedSkillInput[]; missing: string[] }>
  syncPaneSkillLease(
    paneId: string,
    cwd: string,
    ids: string[]
  ): Promise<{ injected: SkillDef[]; missing: string[] }>
  releasePaneSkillPlan(paneId: string): void
  terminatePaneNow(projectId: string, paneId: string): void
  executionModeForTask(task: Task): MissionExecutionMode
  storedHelperRecoveries(
    projectId: string
  ): Array<{ file: string; relativePath: string; record: HelperRecoveryRecord }>
  helperTranscriptPath(projectId: string, paneId: string): string | undefined
  isBannedModel(m?: string): boolean
  agentModelPool(seat: { cli: SeatCli; id: string }): Promise<{ id: string; label: string }[]>
  skillRuntime: SkillRuntime
  skillPlanScopes: Map<
    string,
    {
      phase: string
      phaseRun: string
      agentIds: string[]
      taskId?: string
      projectId?: string
      missionId?: string
    }
  >
  helperSpawnReservations: HelperSpawnReservationRegistry
  helperOpenWatchdog: HelperOpenWatchdog
  plannedHelperAssignments: Map<string, { parentPhaseRun: string; agentId: string }>
  codexDeveloperInstructions(value: string): string
  securityWaiverOptions(projectId: string): { sensitiveWaiverAllowed: boolean }
  planTaskForWorkTask(task: Task): Task | undefined
}

export function buildHelpersApi(
  ctx: MainContext,
  extras: HelpersApiExtras
): Pick<McpApi, 'delegateMany' | 'listSeats' | 'listHelpers' | 'helperOutput' | 'helperSend' | 'helperClose'> {
  const {
    tasks,
    seats,
    projects,
    ptys,
    maestro,
    policies,
    skillsLib,
    paneSessions,
    helperCompletions,
    phaseWatches,
    livePaneSpecs,
    closingPaneIds,
    paneTokens,
    helperReported,
    helperSeen,
    ensureProjectRuntimeWritable,
    externalPlaywrightForPane,
    unregisterPane,
    cleanPaneMcpFile,
    releasePaneSkillLease,
    blackbox
  } = ctx
  // hub é atribuído 1× antes do mcpApi nascer — capturar é seguro.
  const hub = ctx.hub
  const {
    armPane,
    prepareSkillPlanInputs,
    syncPaneSkillLease,
    releasePaneSkillPlan,
    terminatePaneNow,
    executionModeForTask,
    storedHelperRecoveries,
    helperTranscriptPath,
    isBannedModel,
    agentModelPool,
    skillRuntime,
    skillPlanScopes,
    helperSpawnReservations,
    helperOpenWatchdog,
    plannedHelperAssignments,
    codexDeveloperInstructions,
    securityWaiverOptions,
    planTaskForWorkTask
  } = extras
  return {
    delegateMany: async (id, list) => {
      if (id.role === 'review' || id.role === 'qa') {
        return 'Reviewer/QA são gates somente leitura e nunca abrem ajudantes'
      }
      if (id.role === 'maestro' && id.missionId && !id.taskId) {
        return 'o orquestrador da missão não abre ajudante escritor fora de um card; ele planeja e encaminha a implementação ao dev do card'
      }
      if (!ctx.uiSender || ctx.uiSender.isDestroyed()) {
        return 'a interface está sendo recarregada; nenhum ajudante foi marcado como ativo. Tente novamente quando os panes reaparecerem'
      }
      // O prompt recomenda proporcionalidade; o backend a torna um contrato.
      // Checklist não autoriza ajudantes e um executor rápido nunca consegue
      // contornar o perfil abrindo panes diretamente pela tool MCP.
      if (id.taskId) {
        const task = tasks.get(id.taskId)
        if (!task) return 'card do delegador não encontrado — nenhum ajudante foi aberto'
        const activeDevWatch = phaseWatches.get(id.taskId)
        if (
          task.activePhase !== 'dev' ||
          (task.phaseState !== 'pending' && task.phaseState !== 'running') ||
          activeDevWatch?.phase !== 'dev' ||
          activeDevWatch.paneId !== id.paneId
        ) {
          return 'este pane não é o DEV ativo da rodada; ajudantes não podem nascer durante review, QA ou retomada interrompida'
        }
        const executionMode = executionModeForTask(task)
        const delegation = normalizeDelegationMode(task.delegation, executionMode)
        const limit = helperLimitForExecutionMode(executionMode)
        if (delegation === 'none' || limit === 0)
          return `este card usa o modo ${EXECUTION_MODE_LABEL[executionMode]} com delegação desativada — execute o checklist diretamente`
        const activeHelpers = hub
          .panesOf(id.projectId)
          .filter((pane) => pane.role === 'ajudante' && pane.taskId === id.taskId).length
        if (activeHelpers + list.length > limit)
          return `o modo ${EXECUTION_MODE_LABEL[executionMode]} permite no máximo ${limit} ajudante(s) simultâneo(s) por card; já há ${activeHelpers} e esta chamada pediu ${list.length}. Reduza para blocos realmente independentes.`
      } else {
        // AGENTE LIVRE paraleliza de verdade (teste real do dono, 2026-08-08:
        // pediu 2 pesquisas em panes diferentes e o teto hardcoded de 1
        // serializou tudo — contradizia a persona "paraleliza igual qualquer
        // agente do sistema" e o próprio delegate em lote). Paridade com o
        // teto do modo deep; os demais panes sem card (PM em tarefa solta)
        // seguem com 1.
        const limit = id.role === 'livre' ? 4 : 1
        const activeHelpers = hub
          .panesOf(id.projectId)
          .filter((pane) => pane.role === 'ajudante' && pane.delegatorPaneId === id.paneId).length
        if (activeHelpers + list.length > limit)
          return limit === 1
            ? 'este pane já possui seu único ajudante; encerre ou aguarde o atual antes de abrir outro'
            : `o agente livre permite no máximo ${limit} ajudantes simultâneos; já há ${activeHelpers} e esta chamada pediu ${list.length}. Para 2+ ajudantes numa tacada, use UMA chamada delegate com o array helpers.`
      }
      const helperReservationKey = id.taskId ? `task:${id.taskId}` : `pane:${id.paneId}`
      if (!helperSpawnReservations.tryAcquire(helperReservationKey))
        return 'um ajudante deste trabalho já está sendo preparado; aguarde o armamento antes de tentar novamente'
      const helperParentStillActive = (): boolean => {
        const current = hub.identityByPane(id.paneId)
        if (
          !current ||
          !ptys.has(id.paneId) ||
          current.projectId !== id.projectId ||
          current.role !== id.role ||
          current.taskId !== id.taskId ||
          current.cwd !== id.cwd
        ) {
          return false
        }
        if (!id.taskId) return true
        const task = tasks.get(id.taskId)
        const watch = phaseWatches.get(id.taskId)
        return Boolean(
          task &&
            task.projectId === id.projectId &&
            task.status !== 'done' &&
            task.activePhase === 'dev' &&
            (task.phaseState === 'pending' || task.phaseState === 'running') &&
            watch?.phase === 'dev' &&
            watch.paneId === id.paneId
        )
      }
      const one = async (opts: DelegateOpts): Promise<{ ok: boolean; msg: string }> => {
        const project = projects.get(id.projectId)
        if (!project) return { ok: false, msg: 'projeto não encontrado' }
        const parentTask = id.taskId ? tasks.get(id.taskId) : undefined
        const helperDepartment = opts.dept ?? parentTask?.department
        const parentPlan = parentTask ? planTaskForWorkTask(parentTask) : undefined
        const helperSecurity = assessMissionRisk({
          declaredRisk: parentPlan?.plan?.risk,
          surfaces: parentPlan?.plan?.riskSurfaces,
          texts: [
            parentTask?.title,
            parentTask?.description,
            parentTask?.briefing,
            opts.title,
            opts.prompt
          ]
        })
        const helperSecurityBlock = securityPromptForRole(
          'helper',
          helperSecurity.surfaces
        )
        const helperSensitiveRuntime =
          helperSecurity.effectiveRisk === 'high' ||
          requiresManualSecurityValidation(helperSecurity.surfaces)
        const helperSensitiveAutoOk = securityWaiverOptions(id.projectId).sensitiveWaiverAllowed
        const helperEffectiveSensitiveRuntime = effectiveSensitiveAccess(
          helperSensitiveRuntime,
          helperSensitiveAutoOk
        )
        const helperBrowserAvailable = paneBrowserAvailable(paneAccessProfile('ajudante'), {
          sensitive: helperSensitiveRuntime,
          sensitiveAutoOk: helperSensitiveAutoOk,
          strict: true,
          mcpReady: ctx.mcpPort !== 0,
          browserConfigured: Boolean(externalPlaywrightForPane())
        })
        const helperCapabilities: SkillCapability[] = [
          'read',
          'write',
          'shell',
          ...(helperBrowserAvailable ? ['browser' as const] : [])
        ]
        try {
          ensureSynkoraGitExcludes(project.path)
        } catch (error) {
          return {
            ok: false,
            msg: error instanceof Error ? error.message : String(error)
          }
        }
        if (isBannedModel(opts.model))
          return {
            ok: false,
            msg: 'o modelo gpt-5.3-codex-spark é BANIDO pelo usuário (fraco demais para qualquer papel) — escolha outro: para mecânico barato use luna (codex) ou sonnet (claude); veja list_seats'
          }
        let seat = opts.seatId ? seats.get(opts.seatId) : undefined
        let model = opts.model
        if (!seat && opts.dept) {
          const pol = policies.get(id.projectId)[opts.dept]
          const slot = pol?.light ?? pol?.heavy
          if (slot?.seatId) {
            seat = seats.get(slot.seatId)
            model = model ?? (slot.model || undefined)
          }
        }
        if (isBannedModel(model)) model = undefined
        if (!seat && id.seatId) seat = seats.get(id.seatId)
        if (!seat)
          return { ok: false, msg: 'sem seat disponível para o ajudante — defina uma política ou informe seatId' }
        // O modelo TEM que existir no catálogo do seat (o orquestrador chegou a
        // aconselhar um id morto, gpt-5.4-mini): id fora do pool é recusado com
        // a lista certa em vez de abrir um pane quebrado.
        if (model) {
          try {
            const pool = await agentModelPool(seat)
            if (pool.length > 0 && !pool.some((m) => m.id === model))
              return {
                ok: false,
                msg: `modelo "${model}" não existe neste seat — use um id EXATO desta lista: ${pool.map((m) => m.id).join(' · ')}`
              }
          } catch {
            // catálogo indisponível — segue com o id informado (o CLI resolve)
          }
        }
        // SUBAGENTE especializado (opts.agent): o ajudante NASCE com a persona
        // do especialista — claude via --append-system-prompt, codex via
        // developer_instructions (os dois caminhos já validados em PTY real).
        let agentDef: SkillDef | undefined
        let agentPersona: string | null = null
        const parentScope = id.taskId ? skillPlanScopes.get(id.paneId) : undefined
        const plannedAgentId = parentScope?.agentIds[0]
        const requestedAgentId = opts.agent ?? plannedAgentId
        if (id.taskId && opts.agent && opts.agent !== plannedAgentId) {
          return {
            ok: false,
            msg: `subagente "${opts.agent}" não pertence ao plano ativo deste pane; use ${plannedAgentId ?? 'nenhum especialista'}`
          }
        }
        if (requestedAgentId) {
          const d = skillsLib.byId(requestedAgentId)
          if (!d || d.kind !== 'agent' || !skillsLib.isSelectable(requestedAgentId))
            return {
              ok: false,
              msg: `subagente "${requestedAgentId}" não existe ou não está instalado — use um id EXATO de list_skills com tipo=subagente e instalado=true (ou peça ao usuário para instalar em Configurações › Subagentes)`
            }
          if (helperDepartment && !d.depts.includes(helperDepartment))
            return {
              ok: false,
              msg: `subagente "${requestedAgentId}" incompativel com a funcao ${helperDepartment}`
            }
          if (id.taskId && (!parentScope || !parentScope.agentIds.includes(requestedAgentId)))
            return {
              ok: false,
              msg: `subagente "${requestedAgentId}" nao pertence ao plano ativo deste pane; use o especialista selecionado no card`
            }
          agentPersona = await skillsLib.agentBody(requestedAgentId)
          if (!agentPersona)
            return { ok: false, msg: `subagente "${requestedAgentId}" está corrompido na biblioteca — reinstale em Configurações › Subagentes` }
          agentDef = d
          const incompatibility = skillCompatibilityIssue(
            agentDef,
            'helper',
            helperCapabilities
          )
          if (incompatibility) {
            return {
              ok: false,
              msg:
                incompatibility.reason === 'phase'
                  ? `subagente "${requestedAgentId}" não permite a fase helper`
                  : `subagente "${requestedAgentId}" exige capacidades indisponíveis: ${incompatibility.missingCapabilities?.join(', ')}`
            }
          }
        }
        seats.preseed(seat)
        try {
          ensureSynkoraGitExcludes(project.path)
        } catch (error) {
          return {
            ok: false,
            msg: error instanceof Error ? error.message : String(error)
          }
        }
        const runsDir = join(project.path, '.synkora', 'runs')
        mkdirSync(runsDir, { recursive: true })
        if (!ctx.uiSender || ctx.uiSender.isDestroyed()) {
          return {
            ok: false,
            msg: 'a interface recarregou antes do spawn; nenhum ajudante foi armado'
          }
        }
        const helperPaneId = randomUUID()
        const helperPhaseRun = randomUUID()
        const helperRoutingText = [opts.title, opts.prompt].filter(Boolean).join('\n')
        const helperUiWork = helperDepartment
          ? classifyTaskUiWork({
              department: helperDepartment,
              title: opts.title,
              description: opts.prompt,
              affectsUi: opts.affectsUi
            })
          : false
        if (
          helperDepartment &&
          opts.affectsUi === false &&
          classifyTaskUiWork({
            department: helperDepartment,
            title: opts.title,
            description: opts.prompt,
            affectsUi: false
          })
        ) {
          return { ok: false, msg: 'affectsUi=false contradiz a superficie visual descrita para o ajudante' }
        }
        const eligibleIds = new Set(skillsLib.installedIds())
        const requestedHelperSkills = [...new Set(opts.skills ?? [])]
        const rejectedHelperSkills = requestedHelperSkills.filter((skillId) => {
          const definition = skillsLib.byId(skillId)
          return (
            !eligibleIds.has(skillId) ||
            !definition ||
            definition.kind !== 'skill' ||
            (helperDepartment !== undefined && !definition.depts.includes(helperDepartment)) ||
            definition.adapter === 'synkora-native' ||
            isVisualMethod(definition)
          )
        })
        if (rejectedHelperSkills.length > 0) {
          return {
            ok: false,
            msg: `skills do ajudante indisponíveis, bloqueadas ou corrompidas: ${rejectedHelperSkills.join(', ')}`
          }
        }
        if (!helperDepartment) {
          const incompatibleUnscoped = requestedHelperSkills
            .map((skillId) => skillsLib.byId(skillId))
            .filter((definition): definition is SkillDef => Boolean(definition))
            .map((definition) =>
              skillCompatibilityIssue(definition, 'helper', helperCapabilities)
            )
            .filter((issue) => issue !== undefined)
          if (incompatibleUnscoped.length > 0) {
            return {
              ok: false,
              msg: `skills do ajudante incompatíveis com a fase/capacidades: ${incompatibleUnscoped.map((issue) => issue.id).join(', ')}`
            }
          }
        }
        const helperSelection = helperDepartment
          ? selectPhaseSkillPlan({
              defs: skillsLib.definitions(),
              isInstalled: (skillId) => eligibleIds.has(skillId),
              department: helperDepartment,
              phase: 'helper',
              taskText: helperRoutingText,
              explicitSkillIds: opts.skills,
              executionMode: 'standard',
              delegationMode: 'none',
              uiCard: helperUiWork,
              availableCapabilities: helperCapabilities
            })
          : {
              skillIds: requestedHelperSkills.slice(0, 1),
              agentIds: [],
              impeccableOperation: undefined,
              uiOperation: undefined,
              incompatibilities: []
            }
        if (helperSelection.incompatibilities.length > 0) {
          const details = helperSelection.incompatibilities.map((issue) =>
            issue.reason === 'phase'
              ? `${issue.id} não permite helper`
              : `${issue.id} exige ${issue.missingCapabilities?.join(', ') || 'capacidade indisponível'}`
          )
          return {
            ok: false,
            msg: `o ajudante não pode aplicar o método selecionado neste ambiente: ${details.join('; ')}`
          }
        }
        const ignoredRequestedHelperSkills = requestedHelperSkills.filter(
          (skillId) => !helperSelection.skillIds.includes(skillId)
        )
        if (ignoredRequestedHelperSkills.length > 0) {
          return {
            ok: false,
            msg: `o roteador nao escolheu a tecnica pedida para este ajudante: ${ignoredRequestedHelperSkills.join(', ')}`
          }
        }
        let preparedHelperSkills: Awaited<ReturnType<typeof prepareSkillPlanInputs>>
        try {
          await syncPaneSkillLease(helperPaneId, id.cwd, [])
          preparedHelperSkills = await prepareSkillPlanInputs(
            helperSelection.skillIds,
            (skillId) => ({
              operation:
                skillId === IMPECCABLE_SKILL_ID || skillId === SYNKORA_FRONTEND_STANDARD_ID
                  ? helperSelection.impeccableOperation ?? 'polish'
                  : 'apply',
              reason:
                skillId === SYNKORA_FRONTEND_STANDARD_ID
                  ? 'ui.contract'
                  : skillId === IMPECCABLE_SKILL_ID
                    ? `ui.${helperSelection.impeccableOperation ?? 'polish'}`
                    : 'helper.technique',
              required: true
            })
          )
        } catch {
          releasePaneSkillLease(helperPaneId)
          return { ok: false, msg: 'falha ao preparar o plano privado do ajudante' }
        }
        const helperMandatoryMissing = helperDepartment
          ? missingMandatoryUiPhaseSkills(
              preparedHelperSkills.definitions.map((skill) => skill.id),
              helperDepartment,
              'dev',
              helperUiWork
            )
          : []
        const helperMissing = [
          ...new Set([...preparedHelperSkills.missing, ...helperMandatoryMissing])
        ]
        if (helperMissing.length > 0) {
          releasePaneSkillLease(helperPaneId)
          return {
            ok: false,
            msg: `plano do ajudante não pôde ser preparado integralmente: ${helperMissing.join(', ')}`
          }
        }
        const helperPlan = skillRuntime.planPane({
          paneId: helperPaneId,
          phase: 'helper',
          phaseRun: helperPhaseRun,
          skills: preparedHelperSkills.inputs
        })
        if (!helperPlan.ok) {
          releasePaneSkillLease(helperPaneId)
          return { ok: false, msg: 'não foi possível registrar o plano rastreável do ajudante' }
        }
        // projectId OBRIGATÓRIO no scope (bug real 2026-08-08, teste do dono):
        // o guard do activate_skill compara scope.projectId — sem o campo,
        // TODO ajudante com skills era recusado ("este pane não possui um
        // plano ativo de skills") e o report(done), que exige os receipts,
        // virava beco sem saída. Fases e maestro sempre gravaram; só o
        // ajudante esquecia.
        skillPlanScopes.set(helperPaneId, {
          phase: 'helper',
          phaseRun: helperPhaseRun,
          agentIds: [],
          projectId: id.projectId,
          missionId: id.missionId
        })
        if (!helperParentStillActive()) {
          releasePaneSkillLease(helperPaneId)
          releasePaneSkillPlan(helperPaneId)
          return {
            ok: false,
            msg: 'o pane delegador ou o card encerrou durante o preparo; nenhum ajudante foi aberto'
          }
        }
        let armed: ReturnType<typeof armPane>
        try {
          armed = armPane(
            {
              paneId: helperPaneId,
              projectId: id.projectId,
              role: 'ajudante',
              taskId: id.taskId,
              cwd: id.cwd,
              seatId: seat.id,
              delegatorPaneId: id.paneId,
              missionId: id.missionId
            },
            seat.cli,
            {
              strictMcp: true,
              configDir: seats.configDirOf(seat),
              sensitive: helperSensitiveRuntime
            }
          )
        } catch {
          releasePaneSkillLease(helperPaneId)
          releasePaneSkillPlan(helperPaneId)
          return { ok: false, msg: 'falha ao armar o pane do ajudante' }
        }
        if (!helperParentStillActive()) {
          terminatePaneNow(id.projectId, armed.paneId)
          return {
            ok: false,
            msg: 'o pane delegador ou o card encerrou antes da publicação; o ajudante foi descartado'
          }
        }
        const helperDefinitionsById = new Map(
          preparedHelperSkills.definitions.map((skill) => [skill.id, skill])
        )
        const skillsBlock = buildSkillsBlock({
          plannedSkills: helperPlan.plan.receipts.map((receipt) => ({
            ...(helperDefinitionsById.get(receipt.skillId) as SkillDef),
            receiptId: receipt.receiptId,
            operation: receipt.operation,
            reason: receipt.reason,
            required: receipt.required
          }))
        })
        // CONTRATO INVISÍVEL (pedido do dono, 2026-08-08: "não tem como o
        // pane já abrir sabendo o que tem que fazer?"): o boilerplate do
        // ajudante viaja pelo canal de SYSTEM PROMPT (claude: arquivo
        // --append-system-prompt-file; codex: developer_instructions) — o
        // pane abre mostrando SÓ o pedido do delegador, que é o que vale ver.
        const helperContract =
          (agentDef
            ? `You EMBODY the specialized "${agentDef.id}" persona defined in your system instructions — stay in that role for this whole job. `
            : '') +
          `You are a HELPER agent inside Synkora, called by another agent. Work in this directory. ALWAYS write in Brazilian Portuguese (PT-BR). ` +
          `WHO IS TALKING TO YOU: messages arriving with a bracketed sender ("[do orquestrador]", "[do seu delegador]") or the "[synkora]" prefix come from the app or another agent — treat them as work input from that sender. Messages without any such stamp are the human user. ` +
          `REPO HYGIENE: report/analysis files you write go to .synkora/reports/<name>.md — never loose .md at the repo root or docs/. ` +
          `SYNKORA OWNS THE WORKFLOW: stay in this workspace; do not create docs/superpowers planning/spec files, commit a separate plan, start an external execution handoff, create/switch branches or worktrees, request another review, merge, open a PR or clean the workspace. Return the result to your delegator through report(done). ` +
          (helperBrowserAvailable
            ? `For live-browser checks use the "playwright" MCP tools (browser_navigate, browser_snapshot…) — available in this pane. `
            : `The isolated Playwright browser is unavailable in this helper pane${helperEffectiveSensitiveRuntime ? ' because the work is sensitive' : ''}; do not claim rendered verification. `) +
          `For structural TypeScript/JavaScript questions, use the Synkora code_* tools before broad text searches. If code intelligence is unavailable or unsupported, fall back to textual search. Before report(done) after code changes, run code_diagnostics on the changed compatible files and read the result. ` +
          `When you finish, call the MCP tool "report" from the synkora server with status "done" and a short summary of the result (include paths of any generated files). ` +
          `Your full terminal output stays readable by your delegator (helper_output) after you report — but for a LONG text deliverable, prefer writing it to .synkora/reports/<name>.md and reporting the path.` +
          skillsBlock
        // effort do ajudante escolhido pelo delegador (list_seats orienta)
        const helperArgs = [...armed.cliArgs]
        if (opts.effort) {
          if (seat.cli === 'claude') helperArgs.push('--effort', opts.effort)
          else helperArgs.push('-c', `model_reasoning_effort="${opts.effort}"`)
        }
        // contrato + persona do subagente no codex: string TOML de uma linha
        // (mesma serialização validada do agente livre)
        if (seat.cli === 'codex') {
          helperArgs.push(
            '-c',
            codexDeveloperInstructions(
              [helperContract, agentPersona, helperSecurityBlock].filter(Boolean).join('\n\n')
            )
          )
        }
        // Criação sempre usa o UUID completo. O fallback curto existe só
        // para LEITURA de transcripts legados e nunca pode receber saída de
        // um helper novo com o mesmo prefixo de oito caracteres.
        const helperLogFile = join(runsDir, `helper-${armed.paneId}.md`)
        const helperCreatedAt = new Date().toISOString()
        try {
          writeFileSync(
            helperLogFile,
            formatHelperRecoveryTranscript({
              version: HELPER_RECOVERY_VERSION,
              paneId: armed.paneId,
              projectId: id.projectId,
              missionId: id.missionId,
              taskId: id.taskId,
              delegatorPaneId: id.paneId,
              title: opts.title ?? agentDef?.id ?? 'ajudante',
              seatId: seat.id,
              model,
              createdAt: helperCreatedAt,
              status: 'running',
              statusAt: helperCreatedAt
            }),
            { encoding: 'utf-8', flag: 'wx' }
          )
        } catch {
          // pane continua funcional; apenas não terá índice de recovery
        }
        const spec: DevPaneSpec = {
          paneId: armed.paneId,
          kind: seat.cli,
          seatId: seat.id,
          model,
          cwd: id.cwd,
          cliArgs: helperArgs,
          appendSystemPrompt:
            seat.cli === 'claude'
              ? [helperContract, agentPersona, helperSecurityBlock].filter(Boolean).join('\n\n')
              : undefined,
          // Só o PEDIDO fica visível — o contrato/skills viajam invisíveis no
          // system prompt (canais acima).
          initialPrompt: opts.prompt,
          logFile: helperLogFile,
          title: `🤝 ${opts.title ?? agentDef?.id ?? 'ajudante'}`,
          role: 'ajudante',
          missionId: id.missionId,
          delegatorPaneId: id.paneId
        }
        livePaneSpecs.set(armed.paneId, {
          projectId: id.projectId,
          taskId: id.taskId ?? '',
          spec
        })
        if (agentDef && parentScope) {
          plannedHelperAssignments.set(armed.paneId, {
            parentPhaseRun: parentScope.phaseRun,
            agentId: agentDef.id
          })
        }
        helperOpenWatchdog.arm(armed.paneId)
        closingPaneIds.delete(armed.paneId)
        if (ctx.uiSender && !ctx.uiSender.isDestroyed())
          ctx.uiSender.send('panes:open', id.projectId, id.taskId ?? '', spec)
        hub.publish({
          projectId: id.projectId,
          missionId: id.missionId,
          kind: 'delegate',
          text: `${id.role} chamou um ajudante${agentDef ? ` ESPECIALISTA (${agentDef.id})` : ''} (seat ${seat.name}${model ? `, ${model}` : ''}): ${opts.title ?? opts.prompt.slice(0, 60)}`,
          actor: id.role,
          // Agente LIVRE = modo prático sem burocracia: abrir ajudante é ciclo
          // de vida de pane, não marco — vai para EVENTS.md/UI mas NÃO injeta
          // no PM (caso real 2026-08-03: 9 standbys = 9 turnos do PM à toa).
          // Precedente: PM silencioso / pane-close quiet (F5.7j).
          quiet: id.role === 'livre'
        })
        return {
          ok: true,
          msg: `ajudante aberto (paneId ${armed.paneId}, seat ${seat.name}${model ? `, modelo ${model}` : ''}${
            agentDef ? `, persona ${agentDef.id}` : ''
          })`
        }
      }
      try {
        const results: string[] = []
        let anyOk = false
        for (let i = 0; i < list.length; i++) {
          const r = await one(list[i])
          anyOk ||= r.ok
          results.push(list.length > 1 ? `${i + 1}. ${r.msg}` : r.msg)
        }
        if (anyOk)
          results.push(
            `Trabalham no mesmo diretório. Você será avisado no seu CORREIO quando cada um reportar done (ou morrer sem reportar). ` +
              `DELEGOU, NÃO ASSISTE (regra do dono, teste real 2026-08-08: um delegador pollou list_helpers/helper_output 23x e queimou ~3M tokens à toa): NÃO fique chamando list_helpers/helper_output em loop para acompanhar — espere SEM digitação (claude: waiter em background no /mail-wait; codex: loop de check_messages, que segura ~45s por chamada) e aja quando o report chegar. ` +
              `helper_output é para DEPOIS do report (ler a entrega) ou diagnóstico pontual de ajudante travado — nunca acompanhamento contínuo. Controle: list_helpers (estado), helper_send (responder prompts/escolher opções), helper_close (encerrar).`
          )
        return results.join('\n')
      } finally {
        helperSpawnReservations.release(helperReservationKey)
      }
    },
    // Catálogo REAL por seat (cacheado no catalog.ts) — o dev escolhe o
    // executor dos ajudantes com consciência, não preso à política. Inclui os
    // LIMITES reais de cada conta (getSeatUsage, cache 5 min): agentes devem
    // preferir a conta com mais folga (pedido do usuário).
    listSeats: async () => {
      const out = await Promise.all(
        seats.list().map(async (seat) => {
          let models: { id: string; label: string }[] = []
          try {
            // id é o que se passa em delegate/model — label é só exibição
            // ("GPT-5.6-Luna" como model dava 400 na API). Só a curadoria
            // top-3 aparece — agente não oferece o que não vê.
            models = await agentModelPool(seat)
          } catch {
            // catálogo indisponível — lista o seat mesmo assim
          }
          const usage = await Promise.race([
            getSeatUsage(seat.id, seat.cli, seats.configDirOf(seat)).catch(() => null),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000))
          ])
          return {
            seatId: seat.id,
            name: seat.name,
            cli: seat.cli,
            status: seat.status,
            models,
            limites: usage?.lines ?? ['sem dados ainda — chame list_seats de novo em ~30s']
          }
        })
      )
      return JSON.stringify(
        {
          seats: out,
          dica: 'a lista traz APENAS os modelos liberados para agentes (claude: sonnet/opus/fable · codex: luna/terra/sol) — use SEMPRE um id EXATO desta lista, NUNCA invente/abrevie/lembre id de cabeça (id fora da lista é recusado; gpt-5.4-mini e gpt-5.3-codex-spark NÃO existem mais). Fronteira (opus/fable, terra) para raciocínio profundo; rápido e barato (sonnet, luna) para mecânico, varredura, copy e testes; effort low p/ mecânico, high p/ difícil. LIMITES: prefira delegar para a conta com mais folga; conta perto de 100% usado (ou "restam" baixos) deve ser evitada.'
        },
        null,
        2
      )
    },
    // ————— controle de ajudantes (delegador enxerga/dirige/encerra) —————
    listHelpers: (id) => {
      const mine = hub
        .panesOf(id.projectId)
        .filter(
          (p) =>
            p.role === 'ajudante' &&
            (id.role === 'maestro'
              ? !id.missionId || p.missionId === id.missionId
              : p.delegatorPaneId === id.paneId || (!!id.taskId && p.taskId === id.taskId))
        )
      const livePaneIds = new Set(mine.map((pane) => pane.paneId))
      const stored = storedHelperRecoveries(id.projectId)
      const filteredRecords = filterHelperRecoveryRecords(
        stored.map((entry) => entry.record),
        id.role === 'maestro'
          ? id.missionId
            ? { projectId: id.projectId, missionId: id.missionId }
            : { projectId: id.projectId }
          : id.taskId
            ? { projectId: id.projectId, taskId: id.taskId }
            : { projectId: id.projectId, delegatorPaneId: id.paneId }
      )
      const storedByPane = new Map(stored.map((entry) => [entry.record.paneId, entry]))
      const rows: Array<Record<string, unknown>> = mine.map((p) => {
        const state = !ptys.has(p.paneId)
          ? 'morto'
          : ptys.isIdle(p.paneId, 4000)
            ? 'esperando (sem saída há 4s+ — pode estar parado num prompt: leia com helper_output)'
            : 'rodando'
        const tail = ptys.outputTail(p.paneId, 220)
        const lastLine = tail.split('\n').filter(Boolean).pop() ?? ''
        return { paneId: p.paneId, seatId: p.seatId, estado: state, ultimaLinha: lastLine }
      })
      for (const record of filteredRecords) {
        if (livePaneIds.has(record.paneId)) continue
        const entry = storedByPane.get(record.paneId)
        rows.push({
          paneId: record.paneId,
          seatId: record.seatId,
          estado:
            record.status === 'done'
              ? 'concluído — saída preservada'
              : 'interrompido — processo encerrado; não reinicia sozinho',
          titulo: record.title,
          transcript: entry?.relativePath
        })
      }
      if (rows.length === 0)
        return 'nenhum ajudante vivo ou interrompido ligado a este trabalho'
      return JSON.stringify(rows, null, 2)
    },
    helperOutput: (id, paneId, chars) => {
      const h = hub.identityByPane(paneId)
      if (h && id.role === 'maestro' && id.missionId && h.missionId !== id.missionId)
        return 'esse ajudante pertence a outra missao'
      if (h && h.role !== 'ajudante') return 'esse pane não é um ajudante'
      if (h && h.delegatorPaneId !== id.paneId && id.role !== 'maestro')
        return 'esse ajudante não é seu'
      const project = projects.get((h ?? id).projectId)
      const file = project ? helperTranscriptPath(project.id, paneId) : undefined
      let storedRecord: HelperRecoveryRecord | undefined
      if (!h && file) {
        try {
          storedRecord = parseHelperRecoveryTranscript(readFileSync(file, 'utf-8').slice(0, 32_768))
        } catch {
          // transcript legado continua acessível pelo paneId conhecido
        }
        if (storedRecord) {
          const allowed =
            id.role === 'maestro'
              ? !id.missionId || storedRecord.missionId === id.missionId
              : storedRecord.delegatorPaneId === id.paneId ||
                (!!id.taskId && storedRecord.taskId === id.taskId)
          if (!allowed) return 'esse ajudante não pertence a este trabalho'
        }
      }
      // delegador LEU a saída → morte posterior não vira aviso de abandono
      if (h) helperSeen.add(h.paneId)
      // Leitura de ajudante VIVO registra o leitor: quem acompanhou a saída
      // (mesmo antes do report) depois recebe só o SINAL de conclusão, nunca
      // o payload repetido no input (bug real, 2026-08-03). Pane morto não
      // gera aviso futuro — registrar seria só vazamento.
      if (h) helperCompletions.noteOutputRead(paneId, id.paneId)
      // Leitura PÓS-report devolve o resumo autoritativo e consome a entrega
      // pendente PARA ESTE LEITOR: o delegador direto e também o maestro/
      // orquestrador (que recebe o publish) — cada um só silencia o aviso
      // destinado a si; os demais destinos continuam recebendo o deles.
      // O tracker também valida o delegador quando o processo do ajudante já
      // saiu e sua identidade viva não está mais no Hub.
      const reportedCompletion = helperCompletions.consumeViaOutput(
        paneId,
        id.paneId,
        id.role === 'maestro'
      )
      if (reportedCompletion) {
        hub.cancelPaneNotification(
          id.paneId,
          helperCompletionNotificationKey(paneId, reportedCompletion.id)
        )
      }
      const withCompletion = (body: string): string =>
        reportedCompletion
          ? `${body}\n\n${formatHelperCompletionNote(reportedCompletion.text)}`
          : body
      const n = chars ?? 3000
      // TRANSCRIPT primeiro (bug real: o tail cru do PTY vem embaralhado
      // pelas repinturas do TUI e a resposta final rola pra fora da janela).
      // O tee em arquivo é ANSI-limpo, deduplicado e cobre a sessão inteira.
      if (project && file) {
        try {
          if (existsSync(file)) {
            const raw = readFileSync(file, 'utf-8')
            const metadata = parseHelperRecoveryTranscript(raw)
            const newline = raw.indexOf('\n')
            const text = (metadata && newline >= 0 ? raw.slice(newline + 1) : raw).trim()
            if (text) {
              const cut = text.length > n
              const body = cut ? `…(cortado; peça mais chars se precisar)\n${text.slice(-n)}` : text
              // SEM LIXO NA PASTA (decisão do usuário): ajudante já morto +
              // transcript entregue POR COMPLETO = arquivo apagado na hora.
              // Cortado ou vivo → fica (releitura/acompanhamento).
              if (!ptys.has(paneId) && !cut) {
                try {
                  ensureProjectRuntimeWritable(id.projectId)
                  unlinkSync(file)
                } catch {
                  // best-effort — o 🧹/limpeza de missão pega depois
                }
                return withCompletion(
                  body + '\n\n[transcript completo — arquivo apagado, nada de lixo na pasta]'
                )
              }
              return withCompletion(
                body + '\n\n[fonte: transcript limpo do ajudante — atraso de até ~2s em relação ao vivo]'
              )
            }
          }
        } catch {
          // transcript ilegível — cai para o tail cru
        }
      }
      const tail = ptys.outputTail(paneId, n)
      return withCompletion(
        tail ||
          'sem saída registrada (pane fechado há muito tempo? o transcript fica em .synkora/runs/helper-*.md)'
      )
    },
    helperSend: (id, paneId, message) => {
      const h = hub.identityByPane(paneId)
      if (h && id.role === 'maestro' && id.missionId && h.missionId !== id.missionId)
        return 'esse ajudante pertence a outra missao'
      if (!h || h.role !== 'ajudante') return 'ajudante não encontrado (veja list_helpers)'
      if (h.delegatorPaneId !== id.paneId && id.role !== 'maestro') return 'esse ajudante não é seu'
      if (!ptys.has(paneId)) return 'o pane desse ajudante já morreu'
      // Origem CARIMBADA (pedido do usuário: "não sei quem mandou isso"):
      // instrução ganha o remetente na frente; resposta curta de picker
      // ("1", "y") vai crua para não quebrar a seleção.
      const from =
        id.role === 'maestro' ? (id.missionId ? 'do orquestrador' : 'do Maestro') : 'do seu delegador'
      const isRawPickerReply = message.trim().length <= 20
      if (isRawPickerReply) {
        // TECLADO CRU obrigatório (F5-F2, bug real do F1): resposta de picker
        // desviada para a mailbox nunca chega ao seletor do TUI — e pelo hub
        // ela ainda ganharia o prefixo "[synkora] ", que também quebra a
        // seleção. É a exceção AUDITADA de digitação entre agentes.
        const submitted = ptys.inject(paneId, message, () => {})
        blackbox.record({
          cat: 'msg',
          event: 'helper-send-raw-keystroke',
          actor: id.role,
          ids: { paneId, projectId: id.projectId, missionId: id.missionId },
          detail: { line: message, sourcePaneId: id.paneId }
        })
        return submitted
          ? 'tecla enviada CRUA ao TUI do ajudante (resposta de picker) — leia a reação com helper_output em alguns segundos'
          : 'o pane desse ajudante morreu durante o envio'
      }
      const delivered = hub.notifyPaneNow(paneId, `[${from}] ${message}`, {
        sourcePaneId: id.paneId,
        kind: 'delegate',
        correlationId: randomUUID()
      })
      if (delivered === 'dead') return 'o pane desse ajudante morreu durante o envio'
      return delivered === 'mailboxed'
        ? 'no correio do ajudante — chega no resultado da próxima tool dele; leia a reação com helper_output'
        : delivered === 'injected'
          ? 'enviado — leia a reação com helper_output em alguns segundos'
          : 'na fila do ajudante — leia a reação com helper_output em alguns segundos'
    },
    helperClose: (id, paneId) => {
      const h = hub.identityByPane(paneId)
      if (h && id.role === 'maestro' && id.missionId && h.missionId !== id.missionId)
        return 'esse ajudante pertence a outra missao'
      if (!h || h.role !== 'ajudante') return 'ajudante não encontrado (veja list_helpers)'
      if (h.delegatorPaneId !== id.paneId && id.role !== 'maestro') return 'esse ajudante não é seu'
      // fechamento DELIBERADO — o onExit não deve avisar "encerrou sem report"
      helperReported.add(paneId)
      helperCompletions.discard(paneId)
      helperOpenWatchdog.acknowledge(paneId)
      unregisterPane(paneId)
      livePaneSpecs.delete(paneId)
      closingPaneIds.add(paneId)
      if (ptys.has(paneId)) {
        ptys.kill(paneId)
      } else {
        closingPaneIds.delete(paneId)
        paneTokens.delete(paneId)
        cleanPaneMcpFile(paneId)
      }
      paneSessions.delete(paneId)
      helperReported.delete(paneId)
      helperSeen.delete(paneId)
      if (ctx.uiSender && !ctx.uiSender.isDestroyed())
        ctx.uiSender.send('panes:closeById', h.projectId, paneId)
      // encerrado de propósito = transcript é lixo (sem lixo na pasta —
      // decisão do usuário); espera o flush final do tee antes de apagar
      const file = helperTranscriptPath(h.projectId, paneId)
      if (file) {
        setTimeout(() => {
          try {
            ensureProjectRuntimeWritable(h.projectId)
            unlinkSync(file)
          } catch {
            // já foi / nunca existiu
          }
        }, 4000)
      }
      return 'ajudante encerrado (transcript descartado)'
    }
  }
}
