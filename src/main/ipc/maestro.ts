/**
 * IPC — domínio maestro (fase 1, commit 6c).
 * O painel do PM pelo renderer: estado/efforts/modelo/seat, envio de
 * mensagem ao painel de fundo, permissões, /estudar, reviewer do gate 1,
 * spec do pane TUI e as perguntas do ask_user. A mecânica de sessão mora no
 * maestroEngine (extras.engine); pane lifecycle (armPane/stagger) e overlay
 * de ANDAMENTO seguem no index por extras até as obras próprias.
 *
 * Corpo movido VERBATIM do whenReady do index.ts. CERCA VIVA da Fase 0:
 * register*Ipc é CHAMADO do whenReady (bloco único antes do createWindow),
 * NUNCA no import — instrumentIpcMain só cobre handlers registrados depois
 * dele. uiSender/máquina de fases são lidos via ctx a cada uso.
 */
import { ipcMain } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { ensureSynkoraGitExcludes } from '../worktree'
import { gitOff } from '../gitAsync'
import { buildIdleWaiterHint } from '../phasePrompts'
import { ensureProjectSecurityBaseline } from '../projectSecurityBaseline'
import { ensureGreenfieldProjectPlan } from '../projectPlan'
import { redactSensitiveText } from '../securityRedaction'
import { maestroProjectPersona, survey } from '../maestro'
import { MaestroSession, type PermissionChoice } from '../maestroSession'
import { CodexSession } from '../codexSession'
import { migrateCliSessionBetweenSeats } from '../cliSessionTransplant'
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
    maestroSessions,
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
  const {
    engine,
    sweepProjectFiles,
    killMaestroSession,
    beginProgressMaestroTurn,
    finishProgressMaestroTurn,
    beginProgressHeadlessActivity,
    endProgressHeadlessActivity,
    surveySystemPromptFile,
    staggerPaneSpawn,
    armPane,
    releasePaneSkillPlan,
    projectLifecycleOf
  } = extras
  const {
    emitLog,
    emitLive,
    makeEmitter,
    ensureSession,
    surveyViaCodex,
    surveyAborts,
    maestroResumeOverBudget,
    skipMaestroResume,
    preparePlanningRun,
    pendingUserQuestions,
    persistUserQuestions
  } = engine

  ipcMain.handle('maestro:cleanup', (e, projectId: string) => {
    if (!projects.get(projectId)) return 'projeto não encontrado'
    const removed = sweepProjectFiles(projectId)
    hub.publish({
      projectId,
      kind: 'info',
      text: `limpeza do .synkora: ${removed} arquivo(s) sem uso removido(s)`,
      actor: 'user',
      quiet: true
    })
    return `🧹 ${removed} arquivo(s) sem uso removido(s) do .synkora`
  })

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

  ipcMain.handle('maestro:setEffort', (e, projectId: string, effort: string) => {
    maestro.update(projectId, { effort: effort || undefined })
    // Painel de fundo renasce com o novo --effort no próximo envio (mesma sessão via --resume).
    killMaestroSession(projectId)
    makeEmitter(e.sender, projectId)({
      kind: 'ok',
      text: `effort do maestro: ${effort || 'padrão do modelo'}`
    })
  })

  ipcMain.handle('maestro:setContextLimit', (e, projectId: string, limit: number) => {
    // limit <= 0 = automático: o medidor volta a usar a janela real do modelo.
    maestro.update(projectId, { contextLimit: limit > 0 ? limit : undefined })
    makeEmitter(e.sender, projectId)({
      kind: 'ok',
      text:
        limit > 0
          ? `limite de contexto do maestro: ${Math.round(limit / 1000)}k`
          : 'medidor de contexto no automático (janela real do modelo)'
    })
  })

  ipcMain.handle(
    'maestro:send',
    (e, projectId: string, message: string, seatId?: string) => {
      const project = projects.get(projectId)
      if (!project) {
        emitLog(projectId, { kind: 'err', text: 'projeto não encontrado' })
        emitLive({ type: 'turn-end' })
        return
      }
      emitLog(projectId, { kind: 'cmd', text: message })

      // Garante o painel de fundo vivo (claude ou codex, mesma interface).
      const session = ensureSession(projectId, seatId)
      if (!session) {
        emitLog(projectId, { kind: 'err', text: 'não consegui abrir o painel de fundo' })
        emitLive({ type: 'turn-end' })
        return
      }
      // Comandos / vão CRUS para o painel (como no TUI) — sem persona na frente.
      const isSlash = message.trimStart().startsWith('/')
      // Claude /fast: o comando é bloqueado em modo SDK, mas a CHAVE de
      // settings liga o fast mode real — toggle + respawn com --resume.
      if (isSlash && message.trim() === '/fast' && session instanceof MaestroSession) {
        const fast = !maestro.get(projectId).fastMode
        maestro.update(projectId, { fastMode: fast || undefined })
        killMaestroSession(projectId)
        emitLog(projectId, {
          kind: 'ok',
          text: fast
            ? 'fast mode ATIVADO — vale a partir da próxima mensagem (requer modelo Opus; sessão continua via --resume)'
            : 'fast mode desativado'
        })
        emitLive({ type: 'turn-end' })
        return
      }
      // Codex: comandos slash viram o RPC real correspondente (runSlash).
      if (isSlash && session instanceof CodexSession) {
        beginProgressMaestroTurn(projectId, session)
        let accepted = false
        try {
          accepted = session.runSlash(message)
        } catch (error) {
          finishProgressMaestroTurn(projectId, session)
          throw error
        }
        if (!accepted) {
          finishProgressMaestroTurn(projectId, session)
          emitLog(projectId, {
            kind: 'err',
            text: `o painel codex não tem ${message.trim().split(/\s+/)[0]} — digite / para ver a lista`
          })
          emitLive({ type: 'turn-end' })
        }
        return
      }
      beginProgressMaestroTurn(projectId, session)
      try {
        session.send(message)
      } catch (error) {
        finishProgressMaestroTurn(projectId, session)
        throw error
      }
    }
  )

  // Capacidades reais do painel (comandos, modelos, conta) — spawna o painel
  // se preciso; o handshake não gasta tokens.
  ipcMain.handle('maestro:capabilities', async (e, projectId: string, seatId?: string) => {
    const session = ensureSession(projectId, seatId)
    if (!session) return null
    return session.waitCaps()
  })

  ipcMain.handle(
    'maestro:permission',
    (e, projectId: string, requestId: string, choice: PermissionChoice) => {
      const info = maestroSessions.get(projectId)?.answerPermission(requestId, choice)
      if (info) {
        const verdict =
          choice === 'deny'
            ? '✗ negado'
            : choice === 'allow-always'
              ? '✓ permitido (sempre nesta sessão)'
              : '✓ permitido'
        emitLog(projectId, {
          kind: 'ask',
          text: `${verdict} — ${info.toolName} ${info.description}`.trim()
        })
      }
    }
  )

  ipcMain.handle('maestro:interrupt', (e, projectId: string) => {
    const abortSurvey = surveyAborts.get(projectId)
    if (abortSurvey) {
      emitLog(projectId, { kind: 'log', tag: 'maestro', text: '⏹ interrompendo o /estudar…' })
      abortSurvey()
      return
    }
    const session = maestroSessions.get(projectId)
    if (session?.alive) {
      emitLog(projectId, { kind: 'log', tag: 'maestro', text: '⏹ interrompendo o turno…' })
      session.interrupt()
    } else {
      emitLog(projectId, { kind: 'log', tag: 'maestro', text: 'nada rodando para interromper' })
      emitLive({ type: 'turn-end' })
    }
  })

  ipcMain.handle(
    'maestro:survey',
    async (e, projectId: string, seatId?: string) => {
      const emit = makeEmitter(e.sender, projectId)
      const project = projects.get(projectId)
      if (!project) {
        emit({ kind: 'err', text: 'projeto não encontrado' })
        return
      }
      try {
        ensureSynkoraGitExcludes(project.path)
      } catch (error) {
        emit({ kind: 'err', text: error instanceof Error ? error.message : String(error) })
        return
      }
      const seat = seatId ? seats.get(seatId) : undefined
      const configDir = seat ? seats.configDirOf(seat) : undefined
      if (seat) seats.preseed(seat)
      const state = maestro.get(projectId)

      emit({ kind: 'cmd', text: 'maestro estudar' })
      emit({ kind: 'log', tag: 'maestro', text: `mapeando o projeto… (${seat?.cli ?? 'claude'})` })
      const progressSurveyToken = beginProgressHeadlessActivity(projectId, 'survey')
      try {
        if (seat?.cli !== 'codex' && !surveySystemPromptFile) {
          throw new Error(
            'não foi possível materializar a política de sistema do survey; o /estudar foi bloqueado para não executar com prioridade reduzida'
          )
        }
        const brief =
          seat?.cli === 'codex'
            ? await surveyViaCodex(projectId, project.path, configDir, emit)
            : await survey(
                {
                  cwd: project.path,
                  systemPromptFile: surveySystemPromptFile,
                  configDir,
                  model: state.model,
                  registerKill: (kill) => surveyAborts.set(projectId, kill)
                },
                emit
              )
        if (!brief.trim()) throw new Error('o brief voltou vazio')
        ensureSynkoraGitExcludes(project.path)
        const dir = join(project.path, '.synkora')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'CONTEXT.md'), brief, 'utf-8')
        // Sessão nova (painel incluso) para a próxima conversa nascer lendo o
        // dossiê fresco — sem matar o painel, o contexto antigo continuaria.
        killMaestroSession(projectId)
        maestro.update(projectId, { sessionId: undefined, personaSent: false })
        emit({ kind: 'ok', text: 'dossiê salvo em .synkora/CONTEXT.md · sessão reiniciada com o novo contexto' })
      } catch (err) {
        emit({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
      } finally {
        surveyAborts.delete(projectId)
        endProgressHeadlessActivity(projectId, 'survey', progressSurveyToken)
      }
    }
  )

  ipcMain.handle('maestro:reset', (_e, projectId: string) => {
    killMaestroSession(projectId)
    maestro.clear(projectId)
  })

  // Seat do Maestro é escolhido NA ENTRADA do projeto (gate) e persistido.
  // REVIEWER do gate de integração (página geral): seat+modelo+effort próprios.
  ipcMain.handle('maestro:getReviewer', (_e, projectId: string) => {
    const s = maestro.get(projectId)
    return {
      seatId: s.reviewerSeatId ?? null,
      model: s.reviewerModel ?? null,
      effort: s.reviewerEffort ?? null
    }
  })

  ipcMain.handle(
    'maestro:setReviewer',
    (_e, projectId: string, seatId?: string, model?: string, effort?: string) => {
      maestro.update(projectId, {
        reviewerSeatId: seatId || undefined,
        reviewerModel: model || undefined,
        reviewerEffort: effort || undefined
      })
    }
  )

  // Trocar de seat é ação explícita: mata painel de fundo + pane TUI e zera
  // sessão/modelo/effort (são por CLI — sem isso um modelo gpt vaza p/ claude).
  ipcMain.handle('maestro:setSeat', (e, projectId: string, seatId: string, model?: string, effort?: string) => {
    const state = maestro.get(projectId)
    const prev = state.seatId
    if (prev === seatId) {
      // mesmo seat, modelo/effort podem ter mudado no gate: aplica e mata o
      // pane — ele renasce com --model/--effort novos NA MESMA sessão (resume)
      maestro.update(projectId, { seatId, model: model || undefined, effort: effort || undefined })
      killMaestroSession(projectId)
      ptys.kill(maestroPaneId(projectId))
      return
    }
    killMaestroSession(projectId)
    ptys.kill(maestroPaneId(projectId))
    // Troca de conta MESMO-CLI migra a conversa por padrão (decisão do
    // usuário 2026-08-04: limite estourado nunca pode custar o contexto).
    // Cross-CLI reseta como sempre; quem quiser recomeçar usa /clear depois.
    const prevSeat = prev ? seats.get(prev) : undefined
    const nextSeat = seats.get(seatId)
    const project = projects.get(projectId)
    const migrated = Boolean(
      prevSeat &&
        nextSeat &&
        prevSeat.cli === nextSeat.cli &&
        state.tuiSessionId &&
        project &&
        migrateCliSessionBetweenSeats(
          nextSeat.cli,
          prevSeat.id,
          nextSeat.id,
          project.path,
          state.tuiSessionId
        )
    )
    maestro.update(projectId, {
      seatId,
      sessionId: undefined,
      tuiSessionId: migrated ? state.tuiSessionId : undefined,
      personaSent: false,
      model: model || undefined,
      effort: effort || undefined,
      contextWindow: undefined
    })
    const seat = seats.get(seatId)
    emitLog(projectId, {
      kind: 'ok',
      text: `seat do Maestro: ${seat?.name ?? seatId} (${seat?.cli ?? '?'})${model ? ` · ${model}` : ''}${effort ? ` · effort ${effort}` : ''}${migrated ? ' · conversa transplantada para a conta nova' : ''}`
    })
    blackbox.record({
      cat: 'pane',
      event: 'seat-swap',
      actor: 'user',
      ids: { projectId, seatId },
      reason: migrated
        ? `conversa migrada de ${prevSeat?.name ?? prev} para ${seat?.name ?? seatId} (transplante de sessão)`
        : `seat trocado de ${prevSeat?.name ?? prev} para ${seat?.name ?? seatId} sem migração (CLI diferente ou sem sessão)`
    })
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
    ctx.phase.drainPendingRespawns(projectId)
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

  ipcMain.handle('maestro:setModel', async (e, projectId: string, model: string) => {
    const emit = makeEmitter(e.sender, projectId)
    const session = maestroSessions.get(projectId)
    if (session?.alive) {
      // Troca AO VIVO via protocolo de controle — mesma sessão, sem restart.
      // A confirmação real do CLI chega como <local-command-stdout> no log.
      const ok = await session.setModel(model || 'default')
      if (!ok) {
        emit({ kind: 'err', text: 'o CLI recusou a troca de modelo — veja /model para os nomes válidos' })
        return
      }
    } else {
      killMaestroSession(projectId)
    }
    maestro.update(projectId, { model: model || undefined })
    emit({ kind: 'ok', text: `modelo do maestro: ${model || 'padrão do seat'}` })
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

  // Versão atual do projeto: tarefas novas são carimbadas com ela (filtro do
  // board por versão).
  ipcMain.handle('maestro:setVersion', (e, projectId: string, version: string) => {
    maestro.update(projectId, { version: version.trim() || undefined })
    hub.publish({
      projectId,
      kind: 'info',
      text: version.trim() ? `versão atual do projeto: ${version.trim()}` : 'versão do projeto limpa',
      actor: 'user'
    })
  })
}
