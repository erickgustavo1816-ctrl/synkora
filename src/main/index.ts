import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import { join } from 'path'
import { ProjectStore } from './projects'
import { SeatStore, type SeatCli } from './seats'
import { TaskStore, type NewTask, type Task } from './tasks'
import { parseTasks as parseTasksJson, PERSONA, PERSONA_DEV, survey, SURVEY_PROMPT, toolLabel, type MaestroEvent } from './maestro'
import { MaestroSession, type PermissionChoice, type SessionEvent } from './maestroSession'
import { CodexSession } from './codexSession'
import { MaestroStore } from './maestroStore'
import { createTaskWorktree, hasGitCommit, mergeTaskWorktree, type TaskWorktree } from './worktree'
import { PolicyStore, type DeptPolicy } from './policies'
import { getCatalog } from './catalog'
import type { Department } from './tasks'
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { PtyManager, type PaneKind } from './pty'

const ptys = new PtyManager()
let projects: ProjectStore
let seats: SeatStore
let tasks: TaskStore

// Painéis de fundo do Maestro (um processo persistente por projeto:
// claude stream-json ou codex app-server, mesma interface de eventos).
type MaestroBackend = MaestroSession | CodexSession
const maestroSessions = new Map<string, MaestroBackend>()
// Preenchido no whenReady — mata os executores de tarefa ao fechar o app.
let killRunSessions: () => void = () => {}
// Janela única: o último WebContents que falou com o Maestro recebe os eventos.
let uiSender: Electron.WebContents | null = null

function killMaestroSession(projectId: string): void {
  const s = maestroSessions.get(projectId)
  if (s) {
    maestroSessions.delete(projectId)
    s.kill()
  }
}

interface PaneRequest {
  id: string
  cwd: string
  kind: PaneKind
  seatId?: string
  taskId?: string
  initialPrompt?: string
  model?: string
  cliArgs?: string[]
  cols?: number
  rows?: number
  logFile?: string
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0c0f15',
    title: 'Synkora',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(() => {
  projects = new ProjectStore()
  seats = new SeatStore()
  tasks = new TaskStore()
  const maestro = new MaestroStore()
  const policies = new PolicyStore()

  // Catálogo de modelos/efforts puxado dos PRÓPRIOS CLIs:
  // codex → `codex debug models` (JSON real); claude → help parse + aliases.
  ipcMain.handle('catalog:get', (_e, cli: SeatCli, seatId?: string) => {
    const seat = seatId ? seats.get(seatId) : undefined
    return getCatalog(cli, seat ? seats.configDirOf(seat) : undefined)
  })

  ipcMain.handle('policies:get', (_e, projectId: string) => policies.get(projectId))
  ipcMain.handle(
    'policies:set',
    (_e, projectId: string, dept: Department, policy: DeptPolicy) =>
      policies.set(projectId, dept, policy)
  )

  ipcMain.handle('projects:list', () => projects.list())
  ipcMain.handle('projects:create', (_e, name: string, path: string) =>
    projects.create(name, path)
  )
  ipcMain.handle('projects:remove', (_e, id: string) => projects.remove(id))

  ipcMain.handle('seats:list', () => seats.list())
  ipcMain.handle('seats:create', (_e, name: string, cli: SeatCli) => seats.create(name, cli))
  ipcMain.handle('seats:remove', (_e, id: string) => seats.remove(id))

  ipcMain.handle('tasks:list', (_e, projectId: string) => tasks.list(projectId))
  ipcMain.handle('tasks:create', (_e, projectId: string, item: NewTask) => {
    const created = tasks.createMany(projectId, [item])
    syncBoard(projectId)
    dispatch(projectId)
    return created
  })
  ipcMain.handle('tasks:update', (_e, id: string, patch: Partial<Task>) => {
    const updated = tasks.update(id, patch)
    if (updated) {
      syncBoard(updated.projectId)
      dispatch(updated.projectId)
    }
    return updated
  })
  ipcMain.handle('tasks:remove', (_e, id: string) => {
    const task = tasks.get(id)
    tasks.remove(id)
    if (task) syncBoard(task.projectId)
  })

  function makeEmitter(sender: Electron.WebContents, projectId: string) {
    return (evt: MaestroEvent): void => {
      maestro.appendLog(projectId, evt)
      if (!sender.isDestroyed()) sender.send('maestro:event', evt)
    }
  }

  ipcMain.handle('maestro:getState', (e, projectId: string) => {
    uiSender = e.sender
    const state = maestro.get(projectId)
    return {
      log: state.log,
      contextTokens: state.contextTokens ?? null,
      contextLimit: state.contextLimit ?? null,
      contextWindow: state.contextWindow ?? null,
      model: state.model ?? null,
      effort: state.effort ?? null,
      sessionId: state.sessionId ?? null,
      autopilot: state.autopilot ?? false
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

  // Emissores baseados no uiSender atual: a sessão persistente sobrevive a
  // reloads do renderer, então os eventos vão sempre para a janela mais recente.
  function emitLog(projectId: string, evt: MaestroEvent): void {
    maestro.appendLog(projectId, evt)
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('maestro:event', evt)
  }
  function emitLive(evt: unknown): void {
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('maestro:live', evt)
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
            const created = tasks.createMany(projectId, items)
            for (const t of created)
              emitLog(projectId, { kind: 'log', tag: t.department, text: t.title })
            emitLog(projectId, {
              kind: 'ok',
              text: `${created.length} tarefas criadas no backlog`
            })
            if (uiSender && !uiSender.isDestroyed()) uiSender.send('tasks:changed', projectId)
            syncBoard(projectId)
            dispatch(projectId)
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
          if (evt.contextTokens) {
            maestro.update(projectId, {
              contextTokens: evt.contextTokens,
              ...(evt.contextWindow ? { contextWindow: evt.contextWindow } : {})
            })
            if (uiSender && !uiSender.isDestroyed())
              uiSender.send('maestro:ctx', evt.contextTokens)
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
          if (isCurrent()) {
            emitLog(projectId, { kind: 'err', text: evt.text })
            emitLive({ type: 'turn-end' })
          }
          break
        case 'closed':
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
      fastMode: state.fastMode
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
      if (!isCodex) session.personaSent = Boolean(state.personaSent)
      maestroSessions.set(projectId, session)
    }
    return session
  }

  ipcMain.handle(
    'maestro:send',
    (e, projectId: string, message: string, seatId?: string) => {
      uiSender = e.sender
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
        if (!session.runSlash(message)) {
          emitLog(projectId, {
            kind: 'err',
            text: `o painel codex não tem ${message.trim().split(/\s+/)[0]} — digite / para ver a lista`
          })
          emitLive({ type: 'turn-end' })
        }
        return
      }
      const firstTurn = !session.personaSent && !isSlash
      if (firstTurn) {
        session.personaSent = true
        maestro.update(projectId, { personaSent: true })
      }
      session.send(firstTurn ? PERSONA + message : message)
    }
  )

  // Capacidades reais do painel (comandos, modelos, conta) — spawna o painel
  // se preciso; o handshake não gasta tokens.
  ipcMain.handle('maestro:capabilities', async (e, projectId: string, seatId?: string) => {
    uiSender = e.sender
    const session = ensureSession(projectId, seatId)
    if (!session) return null
    return session.waitCaps()
  })

  ipcMain.handle(
    'maestro:permission',
    (e, projectId: string, requestId: string, choice: PermissionChoice) => {
      uiSender = e.sender
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

  // /estudar roda FORA do painel — o ⏹ precisa de um caminho próprio.
  const surveyAborts = new Map<string, () => void>()

  ipcMain.handle('maestro:interrupt', (e, projectId: string) => {
    uiSender = e.sender
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
        'Você explora repositórios e produz briefs técnicos completos. Responda sempre em PT-BR.',
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

  ipcMain.handle(
    'maestro:survey',
    async (e, projectId: string, seatId?: string) => {
      uiSender = e.sender
      const emit = makeEmitter(e.sender, projectId)
      const project = projects.get(projectId)
      if (!project) {
        emit({ kind: 'err', text: 'projeto não encontrado' })
        return
      }
      const seat = seatId ? seats.get(seatId) : undefined
      const configDir = seat ? seats.configDirOf(seat) : undefined
      if (seat) seats.preseed(seat)
      const state = maestro.get(projectId)

      emit({ kind: 'cmd', text: 'maestro estudar' })
      emit({ kind: 'log', tag: 'maestro', text: `mapeando o projeto… (${seat?.cli ?? 'claude'})` })
      try {
        const brief =
          seat?.cli === 'codex'
            ? await surveyViaCodex(projectId, project.path, configDir, emit)
            : await survey(
                {
                  cwd: project.path,
                  configDir,
                  model: state.model,
                  registerKill: (kill) => surveyAborts.set(projectId, kill)
                },
                emit
              )
        if (!brief.trim()) throw new Error('o brief voltou vazio')
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
      }
    }
  )

  ipcMain.handle('maestro:reset', (_e, projectId: string) => {
    killMaestroSession(projectId)
    maestro.clear(projectId)
  })

  ipcMain.handle('maestro:setModel', async (e, projectId: string, model: string) => {
    uiSender = e.sender
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

  // ————— F3: EXECUÇÃO HEADLESS DE TAREFAS —————
  // "▶ executar" não abre mais um pane TUI: roda uma sessão headless (a mesma
  // infra do painel do Maestro) por tarefa. Aprovações viram UI, o transcript
  // vai para .synkora/runs/<taskId>.md e o board vive em .synkora/BOARD.md —
  // o Maestro lê os dois e sabe TUDO que acontece em cada execução.

  interface TaskRun {
    taskId: string
    projectId: string
    /** null enquanto o dev roda no pane TUI — os gates criam a sessão headless */
    session: MaestroBackend | null
    status: 'running' | 'done' | 'error'
    /** dev = implementando · review = gate 1 (código) · qa = gate 2 (validação) */
    phase: 'dev' | 'review' | 'qa'
    seatId: string
    model?: string
    lastSay: string
    /** onde o executor roda: worktree da tarefa ou o projeto direto (sem git) */
    cwd: string
    worktree: TaskWorktree | null
    costUsd: number
    /** sessão do CLI (claude uuid · codex-thread:<id>) — permite assumir no TUI */
    sessionId?: string
    events: MaestroEvent[]
    logFile: string
  }
  const taskRuns = new Map<string, TaskRun>()
  killRunSessions = () => {
    for (const r of taskRuns.values()) r.session?.kill()
    taskRuns.clear()
  }

  const STATUS_LABEL: Record<string, string> = {
    backlog: 'Backlog',
    analise: 'Em análise',
    execucao: 'Em execução',
    qa: 'QA',
    done: 'Concluída'
  }

  function syncBoard(projectId: string): void {
    const project = projects.get(projectId)
    if (!project) return
    try {
      const dir = join(project.path, '.synkora')
      mkdirSync(dir, { recursive: true })
      const all = tasks.list(projectId)
      const lines: string[] = [
        '# Board do Synkora (gerado automaticamente — NÃO editar)',
        `Atualizado: ${new Date().toISOString()}`,
        ''
      ]
      for (const status of ['execucao', 'qa', 'analise', 'backlog', 'done']) {
        const bucket = all.filter((t) => t.status === status)
        if (bucket.length === 0) continue
        lines.push(`## ${STATUS_LABEL[status]}`)
        for (const t of bucket) {
          const run = taskRuns.get(t.id)
          const runInfo = run
            ? run.status === 'running'
              ? ` — EXECUTOR ATIVO · transcript: .synkora/runs/${t.id}.md`
              : ` — executor ${run.status === 'done' ? 'concluiu' : 'falhou'} · transcript: .synkora/runs/${t.id}.md`
            : ''
          lines.push(
            `- [${t.department}] ${t.title} (${t.type}, ${t.effort})${runInfo}`
          )
          if (t.description) lines.push(`  ${t.description.replace(/\s+/g, ' ').slice(0, 300)}`)
        }
        lines.push('')
      }
      if (all.length === 0) lines.push('(sem tarefas no board)')
      writeFileSync(join(dir, 'BOARD.md'), lines.join('\n'), 'utf-8')
    } catch {
      // board é best-effort — nunca derruba o fluxo
    }
  }

  function appendRunLog(run: TaskRun, line: string): void {
    try {
      appendFileSync(run.logFile, line + '\n', 'utf-8')
    } catch {
      // transcript é best-effort
    }
  }

  function runEmit(run: TaskRun, evt: MaestroEvent): void {
    run.events = [...run.events, evt].slice(-400)
    const prefix =
      evt.kind === 'say'
        ? 'executor> '
        : evt.kind === 'tool'
          ? '[tool] '
          : evt.kind === 'out'
            ? '  ↳ '
            : evt.kind === 'err'
              ? '✗ '
              : evt.kind === 'ask'
                ? '⛭ '
                : ''
    appendRunLog(run, prefix + evt.text)
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('taskrun:event', run.taskId, evt)
  }

  function runLive(run: TaskRun, evt: unknown): void {
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('taskrun:live', run.taskId, evt)
  }

  function runSink(run: TaskRun): (evt: SessionEvent) => void {
    return (evt) => {
      switch (evt.type) {
        case 'init':
          run.sessionId = evt.sessionId
          break
        case 'session-id':
          run.sessionId = evt.sessionId
          break
        case 'delta':
          runLive(run, { type: 'delta', text: evt.text })
          break
        case 'thinking':
          runLive(run, { type: 'thinking' })
          break
        case 'text': {
          runLive(run, { type: 'flush' })
          run.lastSay = evt.text
          // O veredito do QA é protocolo interno — não polui o espelho.
          const clean = evt.text.replace(/<verdict>[\s\S]*?<\/verdict>/i, '').trim()
          if (clean) runEmit(run, { kind: 'say', text: clean })
          break
        }
        case 'tool':
          runEmit(run, {
            kind: 'tool',
            text: toolLabel(evt.name, evt.input),
            detail: JSON.stringify(evt.input, null, 2).slice(0, 2000)
          })
          break
        case 'tool-result':
          runEmit(run, { kind: 'out', text: `${evt.isError ? '✗ ' : ''}${evt.text}` })
          break
        case 'permission':
          // Aprovação do executor: aparece na UI (card/modal) para o humano decidir.
          runLive(run, evt)
          break
        case 'permission-cancel':
          runLive(run, evt)
          break
        case 'limit':
          runEmit(run, { kind: 'err', text: evt.text })
          break
        case 'result': {
          // Custo real por fase (claude reporta USD; contexto vale p/ ambos).
          if (evt.costUsd) run.costUsd += evt.costUsd
          if (evt.contextTokens) {
            runEmit(run, {
              kind: 'out',
              text: `fase ${run.phase}: ~${Math.round(evt.contextTokens / 1000)}k tokens de contexto${run.costUsd ? ` · ~$${run.costUsd.toFixed(2)} acumulado` : ''}`
            })
          }
          if (evt.isError && evt.errorText) runEmit(run, { kind: 'err', text: evt.errorText })
          if (evt.isError) {
            run.status = 'error'
            runLive(run, { type: 'turn-end', status: 'error' })
            syncBoard(run.projectId)
            dispatch(run.projectId)
            break
          }
          const task = tasks.get(run.taskId)
          if (!task) {
            run.status = 'done'
            runLive(run, { type: 'turn-end', status: 'done' })
            break
          }
          if (run.phase === 'dev') {
            // Dev terminou → gate 1: revisão de código.
            runEmit(run, { kind: 'ok', text: 'executor concluiu — gate 1: revisão de código' })
            emitLog(run.projectId, {
              kind: 'log',
              tag: task.department,
              text: `✔ dev terminou "${task.title}" — revisor entrando (transcript: .synkora/runs/${task.id}.md)`
            })
            startGateRun(run, task, 'review')
          } else {
            const m = run.lastSay.match(/<verdict>\s*(aprovada|reprovada)\s*:?\s*([\s\S]*?)<\/verdict>/i)
            const approved = m?.[1]?.toLowerCase() === 'aprovada'
            const reason = m?.[2]?.trim() ?? ''
            if (!m) {
              run.status = 'done'
              runLive(run, { type: 'turn-end', status: 'done' })
              runEmit(run, {
                kind: 'out',
                text: `${run.phase === 'review' ? 'revisor' : 'QA'} terminou sem veredito explícito — decisão manual`
              })
            } else if (!approved) {
              // Reprovada: com harness auto e ciclos sobrando, o feedback
              // volta DIRETO para o dev (no pane vivo, ou num pane novo).
              run.status = 'done'
              runLive(run, { type: 'turn-end', status: 'done' })
              const who = run.phase === 'review' ? 'revisor' : 'QA'
              const cycles = task.cycles ?? 0
              const auto = Boolean(maestro.get(run.projectId).autopilot)
              runEmit(run, { kind: 'err', text: `${who} reprovou: ${reason || 'sem motivo'}` })
              if (auto && cycles < MAX_RETRY_CYCLES) {
                tasks.update(run.taskId, { cycles: cycles + 1, feedback: reason || 'sem motivo' })
                emitLog(run.projectId, {
                  kind: 'log',
                  tag: task.department,
                  text: `↩ ${who} reprovou "${task.title}" — ciclo ${cycles + 1}/${MAX_RETRY_CYCLES}: devolvendo o feedback ao dev`
                })
                const spec = preparePhasePane(
                  run.projectId,
                  run.taskId,
                  'dev',
                  run.seatId,
                  run.model,
                  reason || 'sem motivo'
                )
                if (spec) {
                  const marker = phaseWatches.get(run.taskId)?.marker ?? ''
                  const feedbackMsg =
                    `A tarefa foi REPROVADA no gate (${who}): ${reason || 'sem motivo'}. ` +
                    `Corrija isso e, quando estiver 100% resolvido, recrie o arquivo "${marker}" com o conteúdo done.`
                  if (uiSender && !uiSender.isDestroyed())
                    uiSender.send('tasks:feedback', run.projectId, run.taskId, feedbackMsg, spec)
                }
              } else {
                tasks.update(run.taskId, { status: 'analise', feedback: reason || 'sem motivo' })
                emitLog(run.projectId, {
                  kind: 'err',
                  text: `${who} reprovou "${task.title}": ${reason || 'sem motivo'} — ${auto ? `ciclos esgotados (${MAX_RETRY_CYCLES})` : 'harness manual'} · voltou para análise`
                })
              }
            } else if (run.phase === 'review') {
              // Gate 1 ok → gate 2: QA valida de verdade.
              tasks.update(run.taskId, { status: 'qa' })
              runEmit(run, { kind: 'ok', text: `revisor aprovou${reason ? ` · ${reason}` : ''} — gate 2: QA` })
              emitLog(run.projectId, { kind: 'log', tag: 'maestro', text: `revisor aprovou "${task.title}" — QA validando` })
              startGateRun(run, task, 'qa')
            } else {
              // Gate 2 ok → merge (se worktree) e concluída.
              finishApproved(run, task, reason)
            }
            if (uiSender && !uiSender.isDestroyed())
              uiSender.send('tasks:changed', run.projectId)
          }
          syncBoard(run.projectId)
          if (run.status !== 'running') dispatch(run.projectId)
          break
        }
        case 'fatal':
          run.status = 'error'
          runEmit(run, { kind: 'err', text: evt.text })
          runLive(run, { type: 'turn-end', status: 'error' })
          syncBoard(run.projectId)
          break
        default:
          break
      }
    }
  }

  const DEPT_NAME: Record<string, string> = {
    front: 'front-end',
    back: 'back-end',
    qa: 'QA',
    design: 'design',
    research: 'research'
  }

  // Gates automáticos: review (gate 1, olhar de tech lead no diff) e qa
  // (gate 2, valida critérios + testes) — seat/modelo pela política do dept
  // 'qa' (fallback: seat do dev). Rodam no MESMO cwd do dev (worktree).
  function startGateRun(run: TaskRun, task: Task, gate: 'review' | 'qa'): void {
    run.session?.kill()
    run.phase = gate
    run.status = 'running'
    run.lastSay = ''
    const pol = policies.get(run.projectId)['qa']
    const slot = task.effort === 'pesada' ? pol?.heavy : pol?.light
    const seat = (slot?.seatId ? seats.get(slot.seatId) : undefined) ?? seats.get(run.seatId)
    if (!seat) {
      run.status = 'error'
      runEmit(run, { kind: 'err', text: `sem seat disponível para o gate de ${gate}` })
      runLive(run, { type: 'turn-end', status: 'error' })
      return
    }
    seats.preseed(seat)
    const opts = {
      cwd: run.cwd,
      configDir: seats.configDirOf(seat),
      model: slot?.model || undefined,
      permissionMode: 'acceptEdits',
      sandbox: 'workspace-write'
    }
    const personaShort =
      gate === 'review'
        ? 'Você é o revisor de código deste projeto. Responda em PT-BR.'
        : 'Você é o QA deste projeto. Responda em PT-BR.'
    run.session =
      seat.cli === 'codex'
        ? new CodexSession(opts, personaShort, runSink(run))
        : new MaestroSession(opts, runSink(run))
    if (run.session instanceof MaestroSession) run.session.personaSent = true
    appendRunLog(run, `\n— GATE ${gate.toUpperCase()} —`)
    runEmit(run, { kind: 'cmd', text: `gate ${gate} — ${seat.name}` })
    runLive(run, { type: 'phase', phase: gate })
    const verdictRule =
      'TERMINE sua resposta com exatamente um veredito neste formato: <verdict>aprovada</verdict> ou <verdict>reprovada: motivo curto</verdict>'
    run.session.send(
      gate === 'review'
        ? `Você é o REVISOR de código deste projeto (gate 1). A tarefa "${task.title}" acabou de ser implementada por outro agente neste diretório. ` +
            `Critérios de aceite: ${task.description || 'sem descrição'}. ` +
            `O transcript da implementação está em ${run.logFile} — leia-o e revise as MUDANÇAS (git status/diff no diretório atual, incluindo arquivos novos) com olhar de tech lead: correção, qualidade, aderência aos critérios e ao estilo do projeto. ` +
            `Não rode suites de teste longas (isso é do QA). Reprove só por problema real. ${verdictRule}`
        : `Você é o QA deste projeto (gate 2). A tarefa "${task.title}" foi implementada e já passou na revisão de código. ` +
            `Critérios de aceite: ${task.description || 'sem descrição — use o bom senso'}. ` +
            `O transcript está em ${run.logFile}. Valide de verdade: rode testes/build/lint se o projeto tiver, confira os critérios um a um. ` +
            `Seja criterioso mas justo. ${verdictRule}`
    )
  }

  // Aprovada nos dois gates: integra a branch da tarefa (merge assistido) e conclui.
  function finishApproved(run: TaskRun, task: Task, reason: string): void {
    const project = projects.get(run.projectId)
    run.status = 'done'
    if (run.worktree && project) {
      runEmit(run, { kind: 'cmd', text: `merge — integrando ${run.worktree.branch}` })
      const res = mergeTaskWorktree(project.path, run.worktree, `task: ${task.title}`)
      if (res.ok) {
        tasks.update(run.taskId, { status: 'done' })
        runEmit(run, { kind: 'ok', text: `QA aprovou${reason ? ` · ${reason}` : ''} — ${res.detail} — tarefa CONCLUÍDA` })
        emitLog(run.projectId, { kind: 'ok', text: `"${task.title}" aprovada e integrada (${res.detail})` })
        run.worktree = null
      } else {
        // merge falhou: tarefa fica em QA, branch preservada para o humano.
        runEmit(run, { kind: 'err', text: `QA aprovou, mas o merge falhou: ${res.detail}` })
        emitLog(run.projectId, { kind: 'err', text: `"${task.title}" aprovada, merge falhou: ${res.detail}` })
      }
    } else {
      tasks.update(run.taskId, { status: 'done' })
      runEmit(run, {
        kind: 'ok',
        text: `QA aprovou${reason ? ` · ${reason}` : ''} — tarefa CONCLUÍDA${run.worktree ? '' : ' (sem git: mudanças direto no projeto)'}`
      })
      emitLog(run.projectId, { kind: 'ok', text: `QA aprovou "${task.title}" — concluída` })
    }
    runLive(run, { type: 'turn-end', status: 'done' })
  }

  // Dev roda num PANE TUI REAL (decisão do usuário: ver o CLI de verdade, ao
  // vivo, com / à vontade). O main prepara worktree + transcript e detecta a
  // conclusão por um ARQUIVO-MARCADOR que o executor cria ao terminar — aí os
  // gates automáticos (review/QA/merge) disparam como sessões headless.
  // TODAS as fases rodam em PANES TUI REAIS (decisão do usuário): dev, revisão
  // e QA são o CLI de verdade, ao vivo. A orquestração é por ARQUIVOS: o dev
  // cria <id>.done ao concluir; cada gate cria <id>.<fase>.verdict contendo
  // "aprovada" ou "reprovada: motivo". O main vigia, abre/fecha os panes das
  // fases, devolve feedback ao pane do dev nos retries e faz o merge no final.
  type RunPhase = 'dev' | 'review' | 'qa'
  interface DevPaneSpec {
    kind: 'claude' | 'codex'
    seatId: string
    model?: string
    cwd: string
    cliArgs?: string[]
    initialPrompt: string
    logFile: string
    title: string
    role: RunPhase
  }
  interface PhaseWatch {
    projectId: string
    taskId: string
    phase: RunPhase
    /** seat/modelo do DEV (os gates resolvem o próprio pela política do qa) */
    devSeatId: string
    devModel?: string
    cwd: string
    worktree: TaskWorktree | null
    logFile: string
    marker: string
  }
  const phaseWatches = new Map<string, PhaseWatch>()

  const PHASE_ICON: Record<RunPhase, string> = { dev: '▶', review: '🧐 revisão:', qa: '🔎 QA:' }

  function preparePhasePane(
    projectId: string,
    taskId: string,
    phase: RunPhase,
    devSeatId: string,
    devModel?: string,
    feedback?: string
  ): DevPaneSpec | null {
    const project = projects.get(projectId)
    const task = tasks.list(projectId).find((t) => t.id === taskId)
    if (!project || !task) return null

    // Gates usam a política do dept 'qa' (fallback: seat do dev).
    let seat = seats.get(devSeatId)
    let model = devModel
    if (phase !== 'dev') {
      const pol = policies.get(projectId)['qa']
      const slot = task.effort === 'pesada' ? pol?.heavy : pol?.light
      seat = (slot?.seatId ? seats.get(slot.seatId) : undefined) ?? seat
      model = slot?.model || undefined
    }
    if (!seat) return null
    seats.preseed(seat)

    const runsDir = join(project.path, '.synkora', 'runs')
    mkdirSync(runsDir, { recursive: true })
    const worktree = hasGitCommit(project.path)
      ? createTaskWorktree(
          project.path,
          join(app.getPath('userData'), 'worktrees', projectId),
          taskId
        )
      : null
    const cwd = worktree?.dir ?? project.path
    const logFile = join(runsDir, `${taskId}.md`)
    const marker =
      phase === 'dev' ? join(runsDir, `${taskId}.done`) : join(runsDir, `${taskId}.${phase}.verdict`)
    try {
      unlinkSync(marker)
    } catch {
      // sem marcador antigo
    }

    try {
      appendFileSync(
        logFile,
        `\n— FASE ${phase.toUpperCase()} · ${new Date().toISOString()} · seat ${seat.name} (${seat.cli}) · modelo ${model || 'padrão'}${worktree ? ` · branch ${worktree.branch}` : ''} —\n`,
        'utf-8'
      )
    } catch {
      // transcript é best-effort
    }

    phaseWatches.set(taskId, {
      projectId,
      taskId,
      phase,
      devSeatId,
      devModel,
      cwd,
      worktree,
      logFile,
      marker
    })

    const verdictRule =
      `AO FINAL da sua análise (e só no final), crie o arquivo "${marker}" contendo EXATAMENTE uma única linha: ` +
      `aprovada — OU — reprovada: motivo curto. É esse arquivo que move a tarefa no board do Synkora.`
    const prompt =
      phase === 'dev'
        ? `Você é um dev do departamento "${DEPT_NAME[task.department]}" neste projeto. ` +
          `Execute esta tarefa do board: ${task.title}. ` +
          `Descrição e critérios de aceite: ${task.description || 'sem descrição — use o bom senso'}. ` +
          (feedback
            ? `ATENÇÃO — a rodada anterior foi REPROVADA no gate com este motivo: ${feedback}. Corrija isso antes de tudo. `
            : '') +
          `Ao terminar, resuma o que foi feito e como validar. ` +
          `IMPORTANTE: quando a tarefa estiver 100% concluída, crie o arquivo "${marker}" com o conteúdo done — é esse arquivo que dispara a revisão e o QA automáticos do Synkora.`
        : phase === 'review'
          ? `Você é o REVISOR de código deste projeto (gate 1). A tarefa "${task.title}" acabou de ser implementada por outro agente neste diretório. ` +
            `Critérios de aceite: ${task.description || 'sem descrição'}. ` +
            `O transcript da implementação está em "${logFile}" — leia-o e revise as MUDANÇAS (git status/diff, incluindo arquivos novos) com olhar de tech lead: correção, qualidade, aderência aos critérios. ` +
            `Não rode suites de teste longas (isso é do QA). Reprove só por problema real. ${verdictRule}`
          : `Você é o QA deste projeto (gate 2). A tarefa "${task.title}" foi implementada e aprovada na revisão de código. ` +
            `Critérios de aceite: ${task.description || 'sem descrição — use o bom senso'}. ` +
            `Valide de verdade: rode testes/build/lint se o projeto tiver e confira os critérios um a um. Seja criterioso mas justo. ${verdictRule}`

    if (phase === 'dev') {
      tasks.update(taskId, {
        status: 'execucao',
        runSeat: seat.name,
        runModel: model || 'modelo padrão'
      })
    } else if (phase === 'qa') {
      tasks.update(taskId, { status: 'qa' })
    }
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('tasks:changed', projectId)
    syncBoard(projectId)
    return {
      kind: seat.cli,
      seatId: seat.id,
      model: model || undefined,
      cwd,
      cliArgs: seat.cli === 'claude' ? ['--permission-mode', 'acceptEdits'] : undefined,
      initialPrompt: prompt,
      logFile,
      title: `${PHASE_ICON[phase]} ${task.title.slice(0, 28)}${task.title.length > 28 ? '…' : ''}`,
      role: phase
    }
  }

  function openPhasePane(watchSpec: DevPaneSpec, projectId: string, taskId: string): void {
    if (uiSender && !uiSender.isDestroyed())
      uiSender.send('panes:open', projectId, taskId, watchSpec)
  }

  function closePhasePane(projectId: string, taskId: string, role: RunPhase): void {
    if (uiSender && !uiSender.isDestroyed())
      uiSender.send('panes:close', projectId, taskId, role)
  }

  // Reprovação: com harness auto e ciclos sobrando, o feedback volta DIRETO
  // para o pane do dev (digitado nele, se aberto; senão reabre). Sem ciclos →
  // análise para decisão humana.
  function retryOrAnalise(watch: PhaseWatch, who: string, motivo: string): void {
    const task = tasks.get(watch.taskId)
    if (!task) return
    const cycles = task.cycles ?? 0
    const auto = Boolean(maestro.get(watch.projectId).autopilot)
    if (auto && cycles < MAX_RETRY_CYCLES) {
      tasks.update(watch.taskId, { cycles: cycles + 1, feedback: motivo })
      emitLog(watch.projectId, {
        kind: 'log',
        tag: task.department,
        text: `↩ ${who} reprovou "${task.title}" — ciclo ${cycles + 1}/${MAX_RETRY_CYCLES}: feedback devolvido ao dev`
      })
      const spec = preparePhasePane(
        watch.projectId,
        watch.taskId,
        'dev',
        watch.devSeatId,
        watch.devModel,
        motivo
      )
      if (spec) {
        const marker = phaseWatches.get(watch.taskId)?.marker ?? ''
        const feedbackMsg =
          `A tarefa foi REPROVADA no gate (${who}): ${motivo}. ` +
          `Corrija e, quando estiver 100% resolvido, recrie o arquivo "${marker}" com o conteúdo done.`
        if (uiSender && !uiSender.isDestroyed())
          uiSender.send('tasks:feedback', watch.projectId, watch.taskId, feedbackMsg, spec)
      }
    } else {
      tasks.update(watch.taskId, { status: 'analise', feedback: motivo })
      emitLog(watch.projectId, {
        kind: 'err',
        text: `${who} reprovou "${task.title}": ${motivo} — ${auto ? `ciclos esgotados (${MAX_RETRY_CYCLES})` : 'harness manual'} · voltou para análise`
      })
    }
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('tasks:changed', watch.projectId)
    syncBoard(watch.projectId)
  }

  function onPhaseMarker(watch: PhaseWatch, content: string): void {
    const task = tasks.get(watch.taskId)
    if (!task) return
    if (watch.phase === 'dev') {
      emitLog(watch.projectId, {
        kind: 'log',
        tag: task.department,
        text: `✔ dev sinalizou conclusão de "${task.title}" — 🧐 revisão entrando (pane real)`
      })
      const spec = preparePhasePane(watch.projectId, watch.taskId, 'review', watch.devSeatId, watch.devModel)
      if (spec) openPhasePane(spec, watch.projectId, watch.taskId)
      return
    }
    // review/qa: parse do veredito e fecha o pane do gate.
    closePhasePane(watch.projectId, watch.taskId, watch.phase)
    const m = content.match(/^\s*(aprovada|reprovada)\s*:?\s*([\s\S]*)$/i)
    const approved = m?.[1]?.toLowerCase() === 'aprovada'
    const motivo = (m?.[2] ?? '').trim().slice(0, 300) || 'sem motivo'
    const who = watch.phase === 'review' ? 'revisor' : 'QA'
    if (!m) {
      tasks.update(watch.taskId, { status: 'analise', feedback: `veredito ilegível do ${who}: ${content.slice(0, 120)}` })
      emitLog(watch.projectId, { kind: 'err', text: `veredito ilegível do ${who} em "${task.title}" — voltou para análise` })
    } else if (!approved) {
      retryOrAnalise(watch, who, motivo)
      return
    } else if (watch.phase === 'review') {
      emitLog(watch.projectId, { kind: 'log', tag: 'maestro', text: `🧐 revisor aprovou "${task.title}" — 🔎 QA entrando (pane real)` })
      const spec = preparePhasePane(watch.projectId, watch.taskId, 'qa', watch.devSeatId, watch.devModel)
      if (spec) openPhasePane(spec, watch.projectId, watch.taskId)
      return
    } else {
      // QA aprovou → merge assistido e concluída.
      closePhasePane(watch.projectId, watch.taskId, 'dev')
      const project = projects.get(watch.projectId)
      if (watch.worktree && project) {
        const res = mergeTaskWorktree(project.path, watch.worktree, `task: ${task.title}`)
        if (res.ok) {
          tasks.update(watch.taskId, { status: 'done', feedback: undefined })
          emitLog(watch.projectId, { kind: 'ok', text: `"${task.title}" aprovada nos 2 gates e integrada (${res.detail})` })
        } else {
          emitLog(watch.projectId, { kind: 'err', text: `"${task.title}" aprovada, mas o merge falhou: ${res.detail}` })
        }
      } else {
        tasks.update(watch.taskId, { status: 'done', feedback: undefined })
        emitLog(watch.projectId, { kind: 'ok', text: `QA aprovou "${task.title}" — concluída` })
      }
      dispatch(watch.projectId)
    }
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('tasks:changed', watch.projectId)
    syncBoard(watch.projectId)
  }

  setInterval(() => {
    for (const [taskId, watch] of [...phaseWatches]) {
      const task = tasks.get(taskId)
      const activeStatus = watch.phase === 'qa' ? 'qa' : 'execucao'
      // tarefa sumiu ou foi movida manualmente para fora da fase → solta
      if (!task || (task.status !== activeStatus && !existsSync(watch.marker))) {
        phaseWatches.delete(taskId)
        continue
      }
      if (existsSync(watch.marker)) {
        let content = ''
        try {
          content = readFileSync(watch.marker, 'utf-8')
        } catch {
          continue // ainda sendo escrito — tenta no próximo tick
        }
        try {
          unlinkSync(watch.marker)
        } catch {
          // já sumiu
        }
        phaseWatches.delete(taskId)
        onPhaseMarker(watch, content)
      }
    }
  }, 3000)

  // Dispatcher (harness automático): com o autopilot ligado, tarefas do
  // backlog COM política definida são despachadas sozinhas — 1 run por seat,
  // máx. 3 simultâneos por projeto.
  const MAX_PARALLEL_RUNS = 3
  // Retry automático dev↔gate: quantas vezes o feedback volta sozinho pro dev.
  const MAX_RETRY_CYCLES = 2
  function dispatch(projectId: string): void {
    if (!maestro.get(projectId).autopilot) return
    const running = [...taskRuns.values()].filter(
      (r) => r.projectId === projectId && r.status === 'running'
    )
    const devs = [...phaseWatches.values()].filter((w) => w.projectId === projectId)
    const busySeats = new Set([...running.map((r) => r.seatId), ...devs.map((w) => w.devSeatId)])
    let slots = MAX_PARALLEL_RUNS - running.length - devs.length
    if (slots <= 0) return
    const pol = policies.get(projectId)
    const queue = tasks
      .list(projectId)
      .filter((t) => t.status === 'backlog')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const t of queue) {
      if (slots <= 0) break
      const slot = t.effort === 'pesada' ? pol[t.department]?.heavy : pol[t.department]?.light
      if (!slot?.seatId || busySeats.has(slot.seatId)) continue
      if (phaseWatches.has(t.id)) continue // fase já em andamento
      const spec = preparePhasePane(projectId, t.id, 'dev', slot.seatId, slot.model || undefined)
      if (spec) {
        busySeats.add(slot.seatId)
        slots--
        // O pane TUI é do renderer — manda a spec para ele abrir na aba Panes.
        if (uiSender && !uiSender.isDestroyed())
          uiSender.send('panes:open', projectId, t.id, spec)
        emitLog(projectId, {
          kind: 'log',
          tag: t.department,
          text: `🤖 harness despachou "${t.title}" (${t.effort}) — seat ${seats.get(slot.seatId)?.name ?? '?'}`
        })
      }
    }
  }

  ipcMain.handle('harness:setAutopilot', (e, projectId: string, on: boolean) => {
    uiSender = e.sender
    maestro.update(projectId, { autopilot: on || undefined })
    emitLog(projectId, {
      kind: 'ok',
      text: on
        ? '🤖 harness automático LIGADO — backlog com política é despachado sozinho'
        : 'harness automático desligado — execução volta a ser manual'
    })
    if (on) dispatch(projectId)
  })

  ipcMain.handle(
    'tasks:run',
    (e, projectId: string, taskId: string, seatId: string, model?: string) => {
      uiSender = e.sender
      // Devolve a spec do pane TUI — o renderer abre o terminal de verdade.
      return preparePhasePane(projectId, taskId, 'dev', seatId, model)
    }
  )

  ipcMain.handle(
    'tasks:runPermission',
    (e, taskId: string, requestId: string, choice: PermissionChoice) => {
      uiSender = e.sender
      const run = taskRuns.get(taskId)
      const info = run?.session?.answerPermission(requestId, choice)
      if (run && info) {
        const verdict = choice === 'deny' ? '✗ negado' : '✓ permitido'
        runEmit(run, { kind: 'ask', text: `${verdict} — ${info.toolName} ${info.description}`.trim() })
      }
    }
  )

  ipcMain.handle('tasks:runInterrupt', (e, taskId: string) => {
    uiSender = e.sender
    taskRuns.get(taskId)?.session?.interrupt()
  })

  ipcMain.handle('tasks:runSend', (e, taskId: string, message: string) => {
    uiSender = e.sender
    const run = taskRuns.get(taskId)
    if (!run?.session?.alive) return false
    run.status = 'running'
    runEmit(run, { kind: 'cmd', text: message })
    run.session.send(message)
    return true
  })

  // Assumir no terminal: mata o headless e devolve os dados para o renderer
  // abrir um TUI REAL na MESMA conversa (resume) e no MESMO worktree.
  ipcMain.handle('tasks:runHandoff', (e, taskId: string) => {
    uiSender = e.sender
    const run = taskRuns.get(taskId)
    if (!run) return null
    const seat = seats.get(run.seatId)
    const kind = seat?.cli ?? 'claude'
    run.session?.kill()
    taskRuns.delete(taskId)
    appendRunLog(run, `\n↪ assumido no terminal pelo usuário: ${new Date().toISOString()}`)
    syncBoard(run.projectId)
    const task = tasks.get(taskId)
    emitLog(run.projectId, {
      kind: 'log',
      tag: 'maestro',
      text: `▣ "${task?.title ?? taskId}" assumida no terminal — o pipeline automático parou; mova o card quando terminar`
    })
    let cliArgs: string[] = []
    if (run.sessionId) {
      cliArgs =
        kind === 'codex'
          ? ['resume', run.sessionId.replace('codex-thread:', '')]
          : ['--resume', run.sessionId]
    }
    return {
      cwd: run.cwd,
      kind,
      seatId: run.seatId,
      cliArgs,
      title: task?.title ?? 'tarefa'
    }
  })

  ipcMain.handle('tasks:runClose', (e, taskId: string) => {
    uiSender = e.sender
    const run = taskRuns.get(taskId)
    if (run) {
      run.session?.kill()
      taskRuns.delete(taskId)
      appendRunLog(run, `\nEncerrado: ${new Date().toISOString()}`)
      syncBoard(run.projectId)
    }
  })

  ipcMain.handle('tasks:runState', (e, projectId: string) => {
    uiSender = e.sender
    syncBoard(projectId)
    return [...taskRuns.values()]
      .filter((r) => r.projectId === projectId)
      .map((r) => ({ taskId: r.taskId, status: r.status, phase: r.phase, events: r.events }))
  })

  // Clipboard de imagem: prints colados viram PNG em .synkora/attachments do
  // projeto (o path entra no prompt e o agente lê a imagem pelo caminho).
  ipcMain.on('clipboard:hasImage', (e) => {
    e.returnValue = clipboard.availableFormats().some((f) => f.startsWith('image/'))
  })

  ipcMain.handle('clipboard:saveImage', (_e, projectId: string) => {
    const project = projects.get(projectId)
    if (!project) return null
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const dir = join(project.path, '.synkora', 'attachments')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `clip-${Date.now()}.png`)
    writeFileSync(file, img.toPNG())
    return file
  })

  ipcMain.handle('dialog:pickFolder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('pty:create', (e, req: PaneRequest) => {
    const seat = req.seatId ? seats.get(req.seatId) : undefined
    const extraEnv: Record<string, string> = {}
    if (seat) {
      const dir = seats.configDirOf(seat)
      seats.preseed(seat)
      if (seat.cli === 'claude') extraEnv['CLAUDE_CONFIG_DIR'] = dir
      else extraEnv['CODEX_HOME'] = dir
    }
    const sender = e.sender
    ptys.create(sender, {
      id: req.id,
      // cwd vazio = login/uso fora de projeto: roda na home do usuário.
      cwd: req.cwd || app.getPath('home'),
      kind: req.kind,
      extraEnv,
      initialPrompt: req.initialPrompt,
      model: req.model,
      cliArgs: req.cliArgs,
      cols: req.cols,
      rows: req.rows,
      logFile: req.logFile,
      // Pane de tarefa pedindo aprovação → o card correspondente pulsa.
      onAttention: req.taskId
        ? () => {
            if (!sender.isDestroyed()) sender.send('tasks:attention', req.taskId)
          }
        : undefined
    })
  })
  ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) =>
    ptys.resize(id, cols, rows)
  )
  ipcMain.on('pty:kill', (_e, id: string) => ptys.kill(id))

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  for (const s of maestroSessions.values()) s.kill()
  maestroSessions.clear()
  killRunSessions()
  ptys.killAll()
  app.quit()
})
