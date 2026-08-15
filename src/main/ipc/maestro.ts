/**
 * IPC — domínio maestro (fase 1, commit 6c).
 * O que o renderer da era 2.0 ainda pede ao PM: o estado persistido, a spec do
 * pane TUI e as perguntas do ask_user. A mecânica de sessão mora no
 * maestroEngine (extras.engine); pane lifecycle (armPane/stagger) e overlay
 * de ANDAMENTO seguem no index por extras até as obras próprias.
 *
 * Corpo movido VERBATIM do whenReady do index.ts. CERCA VIVA da Fase 0:
 * register*Ipc é CHAMADO do whenReady (bloco único antes do createWindow),
 * NUNCA no import — instrumentIpcMain só cobre handlers registrados depois
 * dele. uiSender/máquina de fases são lidos via ctx a cada uso.
 */
import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import { gitOff } from '../gitAsync'
import { buildIdleWaiterHint } from '../phasePrompts'
import { ensureProjectSecurityBaseline } from '../projectSecurityBaseline'
import { ensureGreenfieldProjectPlan } from '../projectPlan'
import { redactSensitiveText } from '../securityRedaction'
import { maestroProjectPersona } from '../maestro'
import type { PaneIdentity } from '../hub'
import type { SeatCli } from '../seats'
import type { MainContext } from '../mainContext'
import type { MaestroBackend, MaestroEngine } from '../maestroEngine'

/** Dependências do closure do index ainda não migradas (mesmo padrão dos
 * outros ipc/*). O engine viaja inteiro: os handlers são a casca fina dele. */
export interface MaestroIpcExtras {
  engine: MaestroEngine
  sweepProjectFiles(projectId: string, opts?: { preserveInterruptedHelpers?: boolean }): number
  killMaestroSession(projectId: string): void
  beginProgressMaestroTurn(projectId: string, session: MaestroBackend): void
  finishProgressMaestroTurn(projectId: string, session: MaestroBackend, force?: boolean): void
  beginProgressHeadlessActivity(projectId: string, kind: 'conversation' | 'survey'): number
  endProgressHeadlessActivity(projectId: string, kind: 'conversation' | 'survey', token?: number): void
  surveySystemPromptFile: string | undefined
  staggerPaneSpawn(): Promise<void>
  armPane(
    identity: Omit<PaneIdentity, 'paneId'> & { paneId?: string },
    cli: SeatCli,
    opts?: { strictMcp?: boolean; configDir?: string; sensitive?: boolean }
  ): { paneId: string; cliArgs: string[] }
  /** Late-bound: let do index. */
  releasePaneSkillPlan(paneId: string): void
  projectLifecycleOf(projectId: string): string
}

export function registerMaestroIpc(ctx: MainContext, extras: MaestroIpcExtras): void {
  const {
    projects,
    seats,
    missions,
    maestro,
    ptys,
    blackbox,
    hub,
    projectModeOf,
    projectPlanOf,
    maestroPaneId,
    unregisterPane,
    releasePaneSkillLease,
    scheduleProgressSnapshot
  } = ctx
  const { engine, staggerPaneSpawn, armPane, releasePaneSkillPlan, projectLifecycleOf } = extras
  const {
    maestroResumeOverBudget,
    skipMaestroResume,
    preparePlanningRun,
    pendingUserQuestions,
    persistUserQuestions
  } = engine

  ipcMain.handle('maestro:getState', (e, projectId: string) => {
    const state = maestro.get(projectId)
    return {
      log: state.log,
      contextTokens: state.contextTokens ?? null,
      contextLimit: state.contextLimit ?? null,
      contextWindow: state.contextWindow ?? null,
      model: state.model ?? null,
      effort: state.effort ?? null,
      sessionId: state.sessionId ?? null,
      bypass: !state.bypassOff,
      sensitiveBypassOk: state.sensitiveAutoOk === true,
      seatId: state.seatId ?? null,
      version: state.version ?? null
    }
  })

  ipcMain.handle('maestro:paneSpec', async (e, projectId: string) => {
    await staggerPaneSpawn()
    const project = projects.get(projectId)
    if (!project) return null
    // pasta sumiu (renomeada/movida fora do app): spawnar aqui derrubaria o
    // pty:create — a Home oferece a relocação
    if (!existsSync(project.path)) return null
    // Projeto ABERTO pelo usuário (o Board ativo pede a spec do PM): hora de
    // respawnar as fases que o reinício interrompeu — o renderer está de pé.
    // Roda ANTES da cerca abaixo DE PROPÓSITO: card de tarefa solta (sem
    // missão) também tem fase para retomar, e ela não pode depender de o PM
    // nascer.
    ctx.phase.drainPendingRespawns(projectId)
    // SYNKORA 2.0 (onda C): o PM permanente NÃO nasce mais por hábito. Ele
    // existe para o ecossistema LEGADO — orquestrador, plano, fila, correio
    // MCP —, então só nasce enquanto há missão legada VIVA neste universo.
    // Sem nenhuma, a coluna "✦ geral" abre a sessão de PLANEJAMENTO
    // (projects:planningGuiSpec) e ninguém paga um CLI permanente à toa.
    // Esta é a cerca AUTORITATIVA do main: o renderer já nem pede a spec, mas
    // nenhum caminho legado pode ressuscitar um pane que o universo não quer.
    // NÃO afeta /estudar nem o catálogo: aqueles usam sessões headless
    // (ensureSession/survey), que não passam por aqui.
    const liveLegacyMissions = missions
      .list(projectId)
      .filter((m) => (m.status === 'ativa' || m.status === 'integrando') && !m.direct)
    if (liveLegacyMissions.length === 0) {
      blackbox.record({
        cat: 'pane',
        event: 'pm-pane-suppressed-no-legacy',
        actor: 'harness',
        ids: { projectId, paneId: maestroPaneId(projectId) },
        reason:
          'nenhuma missão legada viva neste universo: o Maestro permanente não nasce — o planejamento 2.0 ocupa a coluna geral'
      })
      return null
    }
    try {
      // Fora do main (triagem 2026-08-08): os 2 gits do excludes pesavam
      // ~junto com o baseline no stall de abertura (ipc:maestro:paneSpec
      // ~194ms no journal). O handler já é async; a viagem é barata.
      await gitOff('ensureSynkoraGitExcludes', project.path)
    } catch {
      return null
    }
    const projectMode = projectModeOf(projectId)
    try {
      ensureProjectSecurityBaseline(project.path, {
        installRepositoryAdapters: projectMode === 'greenfield',
        projectName: project.name
      })
    } catch (error) {
      // App novo não inicia sem conseguir materializar a política. Projetos
      // existentes preservam compatibilidade e seguem sob o system prompt.
      if (projectMode === 'greenfield') {
        hub.publish({
          projectId,
          kind: 'error',
          text: `não abri o Maestro: não foi possível preparar a política local de segurança (${redactSensitiveText(error instanceof Error ? error.message : String(error))})`,
          actor: 'harness',
          urgent: true
        })
        return null
      }
    }
    if (projectMode === 'greenfield') {
      try {
        ensureGreenfieldProjectPlan(project.path, { projectName: project.name })
      } catch {
        /* a persona/tool reporta o plano inválido sem impedir o pane */
      }
    }
    const projectPlan = projectPlanOf(projectId)
    const basePersona = maestroProjectPersona(projectMode, projectPlan?.status)
    let state = maestro.get(projectId)
    const seat = state.seatId ? seats.get(state.seatId) : undefined
    if (!seat) return null
    const projectLifecycle = projectLifecycleOf(projectId)
    if (state.projectLifecycle !== projectLifecycle) {
      maestro.update(projectId, { projectLifecycle })
      state = maestro.get(projectId)
    }
    seats.preseed(seat)
    const paneId = maestroPaneId(projectId)
    // Conversa acima do teto de custo: não retoma — o PM "nunca morre" e a
    // conversa dele só cresce; nasce fresco com o caderno MAESTRO.md.
    const resumeOverBudget = maestroResumeOverBudget(projectId)
    if (resumeOverBudget !== undefined) {
      skipMaestroResume(projectId, resumeOverBudget, { projectId, paneId })
      state = maestro.get(projectId)
    }
    // pane antigo ainda vivo (reload do renderer): mata para renascer limpo
    if (ptys.has(paneId)) ptys.kill(paneId)
    unregisterPane(paneId)
    const planningRun = await preparePlanningRun({ paneId, projectId, cwd: project.path })
    if (!planningRun.ok) {
      hub.publish({
        projectId,
        kind: 'error',
        text: `não abri o Maestro: ${planningRun.message}`,
        actor: 'harness',
        urgent: true
      })
      return null
    }
    const personaWithPlanning = `${basePersona}${planningRun.skillBlock}${buildIdleWaiterHint(seat.cli)}`
    let armed: ReturnType<typeof armPane>
    try {
      armed = armPane(
        { paneId, projectId, role: 'maestro', cwd: project.path, seatId: seat.id },
        seat.cli,
        { strictMcp: true, configDir: seats.configDirOf(seat) }
      )
    } catch {
      releasePaneSkillLease(paneId)
      releasePaneSkillPlan(paneId)
      hub.publish({
        projectId,
        kind: 'error',
        text: 'não abri o Maestro: falha ao armar o pane com o método de planejamento',
        actor: 'harness',
        urgent: true
      })
      return null
    }
    const cliArgs = [...armed.cliArgs]
    // Effort do Maestro (escolhido no gate, persistido): claude --effort;
    // codex -c global — PRECISA vir antes do subcomando resume.
    if (state.effort) {
      if (seat.cli === 'claude') cliArgs.push('--effort', state.effort)
      else cliArgs.push('-c', `model_reasoning_effort="${state.effort}"`)
    }
    let initialPrompt: string | undefined
    let appendSystemPrompt: string | undefined
    // Pós-skip de resume por custo: o PM se apresenta explicando a economia e
    // se reergue pelos arquivos duráveis — sem isso o pane nasceria mudo e
    // "sem memória" aos olhos do usuário.
    const resumeSkippedIntro =
      resumeOverBudget !== undefined
        ? `Your previous conversation was NOT resumed on purpose (~${Math.round(resumeOverBudget / 1000)}k tokens of context — replaying it would burn a real slice of the account limit; deliberate economy, no work lost). Your VERY FIRST output — before ANY tool call — is a 2-3 line PT-BR note telling the user exactly that. THEN rebuild your working memory from the durable files: read .synkora/MAESTRO.md (your own notebook) if it exists, .synkora/BOARD.md, .synkora/PROJECT_PLAN.md when present, and call board_status. Summarize where the project stands in 2-3 PT-BR lines and continue. Do NOT re-ask questions the user already answered; if .synkora/MAESTRO.md does not exist yet, say "o caderno MAESTRO.md ainda não existe — vou criá-lo agora" and write it after reading the state.`
        : undefined
    if (seat.cli === 'claude') {
      appendSystemPrompt = personaWithPlanning
      if (state.tuiSessionId) cliArgs.push('--resume', state.tuiSessionId)
      else initialPrompt = resumeSkippedIntro
    } else {
      // Persona pelo PROFILE por pane (F5, sonda P1–P3): appendSystemPrompt →
      // developer_instructions do profile no ipc/pty (maestro é
      // method-governed). Mata o teto de argv do -c inline; como o -c, o
      // profile sobrevive a /new e vale ao retomar uma thread existente.
      appendSystemPrompt = personaWithPlanning
      if (state.tuiSessionId) {
      // flags globais (-p) podem vir antes do subcomando resume
      cliArgs.push('resume', state.tuiSessionId)
    } else {
      const discoveryStarted = Boolean(
        projectPlan &&
          (projectPlan.problem ||
            projectPlan.audience ||
            projectPlan.vision ||
            projectPlan.successCriteria.length ||
            projectPlan.constraints.length ||
            projectPlan.scope.in.length ||
            projectPlan.scope.out.length ||
            projectPlan.decisions.length ||
            projectPlan.roadmap.length)
      )
      const intro =
        projectMode === 'greenfield'
          ? projectPlan?.status === 'done'
            ? 'Read .synkora/PROJECT_PLAN.md and call board_status. Introduce yourself in PT-BR, explain that the original roadmap is complete and that this is now a ready project: ask what focused improvement, feature or bug the user wants to handle next. Do not reopen the master roadmap.'
            : projectPlan?.status === 'awaiting_release'
              ? 'Read .synkora/PROJECT_PLAN.md and call board_status. Introduce yourself in PT-BR, explain that every planned mission is integrated but the project is NOT complete yet: show which version still awaits the user’s final acceptance and explicit release to the base. Do not open another mission or release it silently.'
            : discoveryStarted
            ? 'Read .synkora/PROJECT_PLAN.md and call board_status. Introduce yourself in PT-BR, resume the product discovery or roadmap at the exact saved point, and say clearly: where we are, what is already decided, what is still missing, and what the single next logical step is. Ask only that next question. Do not create a mission unless the user explicitly authorizes the next approved roadmap item.'
            : 'Read .synkora/PROJECT_PLAN.md and call board_status. Introduce yourself in PT-BR, explain in one short sentence that you detected a new empty project and ask what product the user wants to build. Begin collaborative discovery; do not create any mission yet.'
          : 'Introduce yourself in one line (in PT-BR) and ask what the user wants to do.'
      initialPrompt = resumeSkippedIntro ?? intro
      }
    }
    return {
      paneId,
      kind: seat.cli,
      seatId: seat.id,
      cwd: project.path,
      cliArgs,
      initialPrompt,
      appendSystemPrompt,
      // modelo escolhido no gate (--model no spawn; sessão preservada)
      model: state.model
    }
  })

  ipcMain.handle('maestro:pendingQuestions', (e, projectId: string) => {
    // PODA PREGUIÇOSA: pergunta de projeto removido ou de missão que deixou de
    // estar viva não tem aba para pulsar — resíduo sai do arquivo aqui mesmo.
    let pruned = false
    for (const [key, q] of [...pendingUserQuestions]) {
      const projectAlive = Boolean(projects.get(q.projectId))
      const mission = q.missionKey !== 'geral' ? missions.get(q.missionKey) : undefined
      const missionAlive =
        q.missionKey === 'geral' ||
        (mission && (mission.status === 'ativa' || mission.status === 'integrando'))
      if (!projectAlive || !missionAlive) {
        pendingUserQuestions.delete(key)
        pruned = true
      }
    }
    if (pruned) persistUserQuestions()
    return [...pendingUserQuestions.values()].filter((q) => q.projectId === projectId)
  })

  ipcMain.handle('maestro:questionSeen', (e, projectId: string, missionKey: string) => {
    if (pendingUserQuestions.delete(`${projectId}--${missionKey}`)) {
      persistUserQuestions()
      scheduleProgressSnapshot()
    }
    return true
  })

}
