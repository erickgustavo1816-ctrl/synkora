/**
 * MAESTRO ENGINE — sessão de fundo do PM, /estudar, teto de resume, método
 * nativo de planejamento e perguntas ao dono (fase 1, commit 6b).
 *
 * Corpo movido VERBATIM do closure do whenReady em index.ts (cirurgia do
 * índice, docs/FASE1_MAPA_MAESTROENGINE.md). surveyAborts e
 * pendingUserQuestions/persistUserQuestions nascem AQUI; o index expõe
 * aliases para os call sites legados e os getters do MainContext seguem
 * textualmente intactos.
 *
 * Contratos que este módulo NÃO pode quebrar:
 * - maestroSessions e killMaestroSession FICAM no index (escopo de módulo:
 *   o window-all-closed itera o Map fora do whenReady) — o engine lê via
 *   ctx.maestroSessions e mata via extras.killMaestroSession.
 * - O teto de resume é ESCRITO pelo pty:create (stampMaestroContext/
 *   onSession/onCommand/onResumeFail) e LIDO aqui — a comunicação é a chave
 *   do maestroStore: o paneId sem o prefixo `maestro-`. Preservar o prefixo
 *   em qualquer refatoração futura do pty:create.
 * - pendingUserQuestions é escrito de FORA pela tool ask_user
 *   (mcpApi/panes.ts) via ctx — a Map continua exposta por
 *   ctx.pendingUserQuestions/persistUserQuestions.
 */
import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  parseTasks as parseTasksJson,
  PERSONA_DEV,
  SURVEY_PROMPT,
  SURVEY_SECURITY_PROMPT,
  toolLabel,
  type MaestroEvent
} from './maestro'
import { MaestroSession, type SessionEvent } from './maestroSession'
import { CodexSession } from './codexSession'
import { assessMissionRisk } from './orchestratorFlow'
import { loadJsonStore, persistJsonStore } from './jsonStore'
import { SYNKORA_PLANNING_STANDARD_ID } from './skillsRouting'
import { SkillRuntime, type PlannedSkillInput } from './skillRuntime'
import type { SkillDef } from './skillsLibrary'
import type { PendingUserQuestion } from './phaseTypes'
import type { MainContext } from './mainContext'

/** Painel de fundo do Maestro: claude stream-json ou codex app-server, mesma
 *  interface de eventos. O Map vive no index (window-all-closed); o tipo mora
 *  aqui para não haver duas declarações divergindo. */
export type MaestroBackend = MaestroSession | CodexSession

/**
 * Dependências do closure do index que o domínio maestro consome e que ainda
 * não migraram para módulos próprios. `releasePaneSkillPlan` é let late-bound
 * no index — arrow no call site, resolvida na chamada.
 */
export interface MaestroEngineExtras {
  /** Escopo de módulo do index — mata o painel de fundo e fecha o turno do overlay. */
  killMaestroSession(projectId: string): void
  /** Escopo de módulo do index — encerra o turno no snapshot de ANDAMENTO. */
  finishProgressMaestroTurn(projectId: string, session: MaestroBackend, force?: boolean): void
  /** Valor const do boot — política de sistema do painel claude (fail closed sem ele). */
  maestroSystemPromptFile: string | undefined
  /** Infra compartilhada de skill runtime — já é extra do phaseEngine. */
  prepareSkillPlanInputs(
    rootIds: string[],
    describe: (id: string) => Pick<PlannedSkillInput, 'operation' | 'reason' | 'required'>
  ): Promise<{ definitions: SkillDef[]; inputs: PlannedSkillInput[]; missing: string[] }>
  syncPaneSkillLease(
    paneId: string,
    cwd: string,
    ids: string[]
  ): Promise<{ injected: SkillDef[]; missing: string[] }>
  /** Late-bound: let do index atribuído depois da construção do engine. */
  releasePaneSkillPlan(paneId: string): void
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
}

export type MaestroEngine = ReturnType<typeof createMaestroEngine>

export function createMaestroEngine(ctx: MainContext, extras: MaestroEngineExtras) {
  const { projects, seats, tasks, maestro, maestroSessions, skillsLib, blackbox, syncBoard } = ctx
  const {
    killMaestroSession,
    finishProgressMaestroTurn,
    maestroSystemPromptFile,
    prepareSkillPlanInputs,
    syncPaneSkillLease,
    releasePaneSkillPlan,
    skillRuntime,
    skillPlanScopes
  } = extras

  const planningPreparationTickets = new Map<string, string>()
  const preparePlanningRun = async (input: {
    paneId: string
    projectId: string
    missionId?: string
    cwd: string
  }): Promise<{ ok: true; phaseRun: string; skillBlock: string } | { ok: false; message: string }> => {
    const ticket = randomUUID()
    planningPreparationTickets.set(input.paneId, ticket)
    let phaseRun: string | undefined
    const stillOwner = (): boolean => planningPreparationTickets.get(input.paneId) === ticket
    const fail = (message: string): { ok: false; message: string } => {
      if (stillOwner()) {
        planningPreparationTickets.delete(input.paneId)
        ctx.releasePaneSkillLease(input.paneId)
        const scope = skillPlanScopes.get(input.paneId)
        if (scope?.phase === 'planning' && (!phaseRun || scope.phaseRun === phaseRun)) {
          releasePaneSkillPlan(input.paneId)
        }
      }
      return { ok: false, message }
    }
    try {
      const planningIds = skillsLib.orchestratorPlanningIds()
      if (
        planningIds.length !== 1 ||
        planningIds[0] !== SYNKORA_PLANNING_STANDARD_ID
      ) {
        return fail('o método nativo synkora-planning-standard não está íntegro e elegível')
      }
      await syncPaneSkillLease(input.paneId, input.cwd, [])
      const prepared = await prepareSkillPlanInputs(planningIds, () => ({
        operation: 'plan',
        reason: 'planning.standard',
        required: true
      }))
      if (!stillOwner()) {
        return { ok: false, message: 'esta abertura foi substituída por uma geração mais nova' }
      }
      if (
        prepared.missing.length > 0 ||
        prepared.inputs.length !== 1 ||
        prepared.definitions.length !== 1
      ) {
        return fail('não foi possível carregar exatamente o método nativo de planejamento')
      }
      phaseRun = randomUUID()
      const planned = skillRuntime.planPane({
        paneId: input.paneId,
        phase: 'planning',
        phaseRun,
        skills: prepared.inputs
      })
      if (!planned.ok) return fail('não foi possível registrar o receipt de planejamento')
      if (!stillOwner()) {
        skillRuntime.release({ paneId: input.paneId, phase: 'planning', phaseRun })
        return { ok: false, message: 'esta abertura foi substituída por uma geração mais nova' }
      }
      skillPlanScopes.set(input.paneId, {
        phase: 'planning',
        phaseRun,
        agentIds: [],
        projectId: input.projectId,
        missionId: input.missionId
      })
      planningPreparationTickets.delete(input.paneId)
      const receipt = planned.plan.receipts[0]
      const definition = prepared.definitions[0]
      return {
        ok: true,
        phaseRun,
        skillBlock:
          `\n\nACTIVE PLANNING METHOD — selected and bound to this exact planning run. ` +
          `Before analysis or any plan mutation, call activate_skill with receiptId ${receipt.receiptId}. ` +
          `Use only the returned method; do not browse, stack, or substitute another planning workflow. ` +
          `Every save_project_plan/create_plan call must pass skillApplications: ["${receipt.receiptId}"]. ` +
          `The backend rejects stale, foreign, unactivated, or omitted receipts.\n` +
          `- ${definition.id} · operation ${receipt.operation} · receiptId ${receipt.receiptId} · REQUIRED: ${definition.hint}`
      }
    } catch {
      return fail('falha ao preparar o método nativo de planejamento')
    }
  }

  // TETO DE CUSTO DO RESUME DO PM/ORQUESTRADOR (pedido do usuário, 2026-08-06:
  // "eles não podem ter que reler a conversa toda — principalmente o maestro,
  // que nunca morre"): mesmo racional do RESUME_CONTEXT_BUDGET_TOKENS da fase
  // dev (F6.8e) — o resume reprocessa a conversa INTEIRA como input no 1º
  // turno. Acima do teto, a conversa não é retomada: o pane nasce fresco e se
  // reergue pelos arquivos duráveis (PM: .synkora/MAESTRO.md + BOARD.md +
  // board_status; orquestrador: caderno PLAN.md + board_status). A conversa é
  // descartável por desenho; o caderno é a memória.
  const MAESTRO_RESUME_BUDGET_TOKENS = 150_000
  function maestroResumeOverBudget(key: string): number | undefined {
    const st = maestro.get(key)
    if (!st.tuiSessionId) return undefined
    const ctx = st.tuiContextTokens ?? 0
    return ctx > MAESTRO_RESUME_BUDGET_TOKENS ? ctx : undefined
  }
  function skipMaestroResume(
    key: string,
    overBudget: number,
    ids: { projectId: string; missionId?: string; paneId: string }
  ): void {
    blackbox.record({
      cat: 'pane',
      event: 'maestro-resume-skipped-cost',
      actor: 'harness',
      ids: { ...ids, role: 'maestro' },
      reason: `conversa com ~${Math.round(overBudget / 1000)}k tokens de contexto — o resume custaria o replay integral; pane nasce fresco sobre o caderno durável`,
      detail: { tuiContextTokens: overBudget, budget: MAESTRO_RESUME_BUDGET_TOKENS }
    })
    maestro.update(key, { tuiSessionId: undefined, tuiContextTokens: undefined })
  }

  function makeEmitter(sender: Electron.WebContents, projectId: string) {
    return (evt: MaestroEvent): void => {
      maestro.appendLog(projectId, evt)
      if (!sender.isDestroyed()) sender.send('maestro:event', evt)
    }
  }

  // Emissores baseados no ctx.uiSender atual: a sessão persistente sobrevive a
  // reloads do renderer, então os eventos vão sempre para a janela mais recente.
  function emitLog(projectId: string, evt: MaestroEvent): void {
    maestro.appendLog(projectId, evt)
    ctx.pushBoard('maestro:event', evt)
  }
  function emitLive(evt: unknown): void {
    ctx.pushBoard('maestro:live', evt)
  }

  // Traduz os eventos crus do painel de fundo em log persistido + live da UI.
  function sessionSink(
    projectId: string,
    box: { session?: MaestroBackend }
  ): (evt: SessionEvent) => void {
    const isCurrent = (): boolean => maestroSessions.get(projectId) === box.session
    return (evt) => {
      switch (evt.type) {
        case 'init':
          maestro.update(projectId, {
            sessionId: evt.sessionId,
            ...(evt.contextWindow ? { contextWindow: evt.contextWindow } : {})
          })
          if (box.session?.announceOnce()) {
            emitLog(projectId, {
              kind: 'log',
              tag: 'maestro',
              text: `sessão aberta · ${evt.model} · modo ${evt.permissionMode} · ${evt.toolCount} ferramentas`
            })
          }
          break
        case 'session-id':
          maestro.update(projectId, { sessionId: evt.sessionId })
          break
        case 'delta':
          emitLive({ type: 'delta', text: evt.text })
          break
        case 'thinking':
          emitLive({ type: 'thinking' })
          break
        case 'text': {
          // Bloco de texto final do turno: extrai <tasks> e persiste a fala.
          const match = evt.text.match(/<tasks>([\s\S]*?)<\/tasks>/)
          const items = match ? parseTasksJson(match[1]) : []
          const text = (match ? evt.text.replace(match[0], '') : evt.text).trim()
          emitLive({ type: 'flush' })
          if (text) emitLog(projectId, { kind: 'say', text })
          if (items.length > 0) {
            const unplannedRisk = assessMissionRisk({
              texts: items.flatMap((item) => [item.title, item.description])
            })
            if (unplannedRisk.surfaces.length > 0) {
              emitLog(projectId, {
                kind: 'err',
                text:
                  `cards legados recusados: o pedido toca ${unplannedRisk.surfaces.join(', ')}. ` +
                  'Trabalho com superfície de risco precisa nascer em uma missão e seguir um plano aprovado; nenhum card avulso foi criado.'
              })
              break
            }
            const created = tasks.createMany(projectId, items)
            for (const t of created)
              emitLog(projectId, { kind: 'log', tag: t.department, text: t.title })
            emitLog(projectId, {
              kind: 'ok',
              text: `${created.length} tarefas criadas no backlog`
            })
            ctx.pushAll('tasks:changed', projectId)
            syncBoard(projectId)
          }
          break
        }
        case 'tool':
          emitLog(projectId, {
            kind: 'tool',
            tag: 'maestro',
            text: toolLabel(evt.name, evt.input),
            detail: JSON.stringify(evt.input, null, 2).slice(0, 2000)
          })
          break
        case 'tool-result':
          emitLog(projectId, {
            kind: 'out',
            text: `${evt.isError ? '✗ ' : ''}${evt.text}`
          })
          break
        case 'permission':
          emitLive(evt)
          break
        case 'permission-cancel':
          emitLive(evt)
          break
        case 'ready':
          // Handshake respondeu: anuncia o painel com os dados REAIS da conta.
          if (box.session && !box.session.readyAnnounced) {
            box.session.readyAnnounced = true
            const acc = evt.caps.account
            const cmds = evt.caps.commands.length
            emitLog(projectId, {
              kind: 'log',
              tag: 'maestro',
              text: `painel de fundo pronto · ${acc?.email ?? 'conta ?'}${acc?.subscriptionType ? ` (${acc.subscriptionType})` : ''}${cmds > 0 ? ` · ${cmds} comandos` : ''} · ${evt.caps.models.length} modelos`
            })
          }
          break
        case 'command-output':
          emitLog(projectId, { kind: 'out', text: evt.text })
          break
        case 'limit':
          emitLog(projectId, { kind: 'err', text: evt.text })
          break
        case 'result':
          if (box.session) finishProgressMaestroTurn(projectId, box.session)
          if (evt.contextTokens) {
            maestro.update(projectId, {
              contextTokens: evt.contextTokens,
              ...(evt.contextWindow ? { contextWindow: evt.contextWindow } : {})
            })
            ctx.pushBoard('maestro:ctx', evt.contextTokens)
          }
          if (evt.isError && evt.errorText)
            emitLog(projectId, { kind: 'err', text: evt.errorText })
          // fast mode ligado mas o CLI reportou off (ex.: modelo sem suporte).
          if (
            evt.fastModeState &&
            evt.fastModeState !== 'on' &&
            maestro.get(projectId).fastMode &&
            box.session instanceof MaestroSession &&
            !box.session.fastWarned
          ) {
            box.session.fastWarned = true
            emitLog(projectId, {
              kind: 'log',
              tag: 'maestro',
              text: `fast mode pedido mas o CLI reporta "${evt.fastModeState}" — só modelos Opus suportam`
            })
          }
          emitLive({ type: 'turn-end' })
          break
        case 'fatal':
          if (box.session) finishProgressMaestroTurn(projectId, box.session)
          if (isCurrent()) {
            emitLog(projectId, { kind: 'err', text: evt.text })
            emitLive({ type: 'turn-end' })
          }
          break
        case 'closed':
          if (box.session) finishProgressMaestroTurn(projectId, box.session)
          // Só reage se ESTA sessão ainda é a atual (kill+respawn dispara
          // 'closed' atrasado da antiga — não pode derrubar a nova).
          if (isCurrent()) {
            maestroSessions.delete(projectId)
            emitLive({ type: 'exit' })
          }
          break
      }
    }
  }

  // Garante o painel de fundo vivo para o projeto+seat (respawn se preciso).
  // Não manda nada — spawn + handshake não gastam tokens.
  function ensureSession(projectId: string, seatId?: string): MaestroBackend | null {
    const project = projects.get(projectId)
    if (!project) return null
    const seat = seatId ? seats.get(seatId) : undefined
    const configDir = seat ? seats.configDirOf(seat) : undefined
    let state = maestro.get(projectId)

    // Sessão pertence ao seat (config dir): trocar de seat exige sessão nova.
    // Modelo/effort são POR CLI — sem reset, um gpt-5.6 vazaria para o claude.
    if (state.sessionId && (state.seatId ?? '') !== (seatId ?? '')) {
      emitLog(projectId, {
        kind: 'log',
        tag: 'maestro',
        text: 'seat trocado — sessão nova (modelo e effort resetados)'
      })
      killMaestroSession(projectId)
      maestro.update(projectId, {
        sessionId: undefined,
        personaSent: false,
        model: undefined,
        effort: undefined,
        contextWindow: undefined,
        seatId
      })
      state = maestro.get(projectId)
    }
    maestro.update(projectId, { seatId })

    if (seat) seats.preseed(seat)
    const isCodex = seat?.cli === 'codex'
    // Claude must receive the same trusted PM contract at system priority as
    // Codex receives through developerInstructions. If the prompt file could
    // not be materialized, fail closed instead of downgrading it to user text.
    if (!isCodex && !maestroSystemPromptFile) return null
    // Threads do codex são gravadas com prefixo próprio para o resume certo.
    const codexThread = state.sessionId?.startsWith('codex-thread:')
      ? state.sessionId.slice('codex-thread:'.length)
      : undefined
    const desired = {
      cwd: project.path,
      configDir,
      resumeSessionId: isCodex ? codexThread : state.sessionId,
      model: state.model,
      effort: state.effort,
      fastMode: state.fastMode,
      systemPromptFile: isCodex ? undefined : maestroSystemPromptFile
    }
    let session = maestroSessions.get(projectId)
    const wrongKind = session && isCodex !== session instanceof CodexSession
    if (!session || wrongKind || !session.alive || !session.matches(desired)) {
      killMaestroSession(projectId)
      const box: { session?: MaestroBackend } = {}
      session = isCodex
        ? new CodexSession(desired, PERSONA_DEV, sessionSink(projectId, box))
        : new MaestroSession(desired, sessionSink(projectId, box))
      box.session = session
      if (!isCodex) {
        session.personaSent = true
        maestro.update(projectId, { personaSent: true })
      }
      maestroSessions.set(projectId, session)
    }
    return session
  }

  // /estudar roda FORA do painel — o ⏹ precisa de um caminho próprio.
  const surveyAborts = new Map<string, () => void>()

  // /estudar num seat CODEX: sessão dedicada do app-server em sandbox
  // read-only e aprovação never — explora à vontade, não escreve nada.
  function surveyViaCodex(
    projectId: string,
    cwd: string,
    configDir: string | undefined,
    onTool: (evt: MaestroEvent) => void
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let last = ''
      let settled = false
      const done = (fn: () => void): void => {
        if (settled) return
        settled = true
        surveyAborts.delete(projectId)
        fn()
        session.kill()
      }
      const session: CodexSession = new CodexSession(
        {
          cwd,
          configDir,
          sandbox: 'read-only',
          approvalPolicy: 'never'
        },
        'Você explora repositórios e produz briefs técnicos completos. Responda sempre em PT-BR.\n\n' +
          SURVEY_SECURITY_PROMPT,
        (evt) => {
          switch (evt.type) {
            case 'tool':
              onTool({
                kind: 'tool',
                tag: 'maestro',
                text: toolLabel(evt.name, evt.input),
                detail: JSON.stringify(evt.input, null, 2).slice(0, 2000)
              })
              break
            case 'text':
              last = evt.text
              break
            case 'permission':
              // não deveria acontecer em read-only — nega para não travar
              session.answerPermission(evt.requestId, 'deny')
              break
            case 'result':
              done(() =>
                evt.isError
                  ? reject(new Error(evt.errorText ?? 'survey falhou'))
                  : resolve(last)
              )
              break
            case 'fatal':
              done(() => reject(new Error(evt.text)))
              break
            default:
              break
          }
        }
      )
      surveyAborts.set(projectId, () => session.interrupt())
      session.send(SURVEY_PROMPT)
    })
  }

  // Perguntas dirigidas ao USUÁRIO (tool ask_user, 2026-08-06): chave
  // `<projectId>--<missionId|geral>` → a aba do board pulsa até o dono abrir.
  // PERSISTIDAS (fix 2026-08-06, célula 🔴 do mapa de retomada confirmada ao
  // vivo na M02d: a pergunta que pediu o restart foi apagada pelo próprio
  // restart) — o boot reidrata e a aba volta a pulsar até o dono ver.
  const userQuestionsFile = join(app.getPath('userData'), 'user-questions.json')
  const pendingUserQuestions = new Map<string, PendingUserQuestion>(
    Object.entries(
      loadJsonStore<Record<string, PendingUserQuestion>>(
        userQuestionsFile,
        () => ({}),
        (v): v is Record<string, PendingUserQuestion> =>
          typeof v === 'object' && v !== null && !Array.isArray(v)
      )
    )
  )
  const persistUserQuestions = (): void => {
    try {
      persistJsonStore(userQuestionsFile, Object.fromEntries(pendingUserQuestions))
    } catch {
      // pergunta viva em memória segue valendo; a próxima mutação re-tenta
    }
  }

  return {
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
  }
}
