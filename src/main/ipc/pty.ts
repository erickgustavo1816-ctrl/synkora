/**
 * IPC — domínio pty (fase 1, commit 7b).
 * O ciclo de vida do PROCESSO do pane: pty:create (a máquina de estado de
 * spawn/morte — onExit com efeitos cross-domain, onCommand//clear,
 * onResumeFail, onStats/selo do teto de resume), write/resize/kill e as
 * métricas de startup. A mecânica de armamento/estado mora no paneLifecycle
 * (extras.engine).
 *
 * Corpo movido VERBATIM do whenReady do index.ts. Contratos:
 * - pty:create NUNCA se fatia em sub-funções: onResumeFail/onCommand/onExit/
 *   onStats capturam token/statsWatchHandle/preparationTicket/lastMaestroCtx
 *   do corpo do handler (guard de geração do onExit incluso).
 * - A corrida armPane×cleanPaneMcpFile: o RE-GRAVE do arquivo MCP no spawn
 *   vive aqui; pty:kill NUNCA desarma (remount ≠ pane fechado) — o desarme é
 *   só no onExit sob guard de geração.
 * - O selo `maestro-<key>` (stampMaestroContext/onSession/onCommand/
 *   onResumeFail) escreve o teto de resume que o maestroEngine lê pelo
 *   maestroStore — nunca tocar nas strings 'maestro-'.
 * - CERCA VIVA da Fase 0: register*Ipc é CHAMADO do whenReady (bloco único
 *   antes do createWindow), NUNCA no import.
 */
import { ipcMain, app } from 'electron'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'
import { ptyPreparationCanContinue } from '../ptyPreparationGuard'
import { resolveProjectPlaywrightTest, writeClaudeMcpConfig } from '../mcpServer'
import { paneAccessProfile, paneExternalMcpCapabilities } from '../panePermissions'
import { stopQaRuntime } from '../qaRuntime'
import { decorateBrowserLaunchArgs } from '../qaCdp'
import type { StatsWatchHandle } from '../sessionStats'
import type { PaneIdentity } from '../hub'
import type { HelperOpenWatchdog } from '../helperOpenWatchdog'
import type { HelperRecoveryRecord, HelperRecoveryStatus } from '../helperRecovery'
import type { PaneLifecycleEngine, PaneRequest } from '../paneLifecycle'
import type { MainContext } from '../mainContext'

/** Dependências do closure do index ainda não migradas (mesmo padrão dos
 * outros ipc/*). recordGateDeath/emitMissionsChanged são referências dos
 * engines de fase/missão — entregues no bloco de registro, onde todos já
 * existem (zero arrow late-bound). */
export interface PtyIpcExtras {
  engine: PaneLifecycleEngine
  /** helperRecovery — carimbo + caminho do transcript do ajudante. */
  updateStoredHelperStatus(
    projectId: string,
    paneId: string,
    status: HelperRecoveryStatus,
    statusAt?: string
  ): HelperRecoveryRecord | undefined
  helperTranscriptPath(projectId: string, paneId: string): string | undefined
  helperOpenWatchdog: HelperOpenWatchdog
  /** Escopo de módulo do index — perfil de skills isolado do codex. */
  paneCodexSkillProfiles: Map<string, string>
  /** Watchdog de 1º contato MCP do gate. */
  armGateMcpWatchdog(identity: PaneIdentity, paneId: string): void
  /** Overlay de ANDAMENTO (escopo de módulo do index). */
  scheduleProgressLiveSnapshot(paneId: string): void
  refreshProgressLiveSnapshot(): unknown
  progressLiveIdleTimers: Map<string, NodeJS.Timeout>
  /** missionEngine — gate de integração fechado sem veredito. */
  emitMissionsChanged(projectId: string): void
  /** phaseEngine — breaker de crash-loop de gate. */
  recordGateDeath(taskId: string): { looping: boolean; deaths: number }
}

export function registerPtyIpc(ctx: MainContext, extras: PtyIpcExtras): void {
  const {
    projects,
    seats,
    tasks,
    missions,
    maestro,
    ptys,
    blackbox,
    sessionStats,
    helperCompletions,
    paneTokens,
    paneMcpFiles,
    paneSessions,
    helperReported,
    helperSeen,
    expiredSeats,
    syncBoard,
    ensureProjectRuntimeWritable,
    externalPlaywrightForPane,
    unregisterPane,
    cleanPaneMcpFile,
    hub
  } = ctx
  const {
    engine,
    updateStoredHelperStatus,
    helperTranscriptPath,
    helperOpenWatchdog,
    paneCodexSkillProfiles,
    armGateMcpWatchdog,
    scheduleProgressLiveSnapshot,
    refreshProgressLiveSnapshot,
    progressLiveIdleTimers,
    emitMissionsChanged,
    recordGateDeath
  } = extras
  const {
    livePaneSpecs,
    closingPaneIds,
    paneEverSpawned,
    pendingPtyPreparations,
    testServerPanes,
    paneStartupDescriptor,
    rollbackFailedPaneSpawn,
    terminateTaskHelpers
  } = engine

  ipcMain.on('pty:startup-request', (_e, paneId: string) => {
    if (typeof paneId !== 'string' || paneId.length > 200 || ptys.has(paneId)) return
    ctx.paneStartupMetrics?.request(paneId)
  })

  ipcMain.on('pty:first-frame', (_e, paneId: string) => {
    if (typeof paneId !== 'string' || paneId.length > 200) return
    ctx.paneStartupMetrics?.mark(paneId, 'terminal_first_frame')
  })

  ipcMain.handle('pty:create', async (e, req: PaneRequest) => {
    const pendingIdentity = hub.identityByPane(req.id)
    const token = paneTokens.get(req.id)
    const cached = livePaneSpecs.get(req.id)
    // O terminal isolado de login não é um pane do Hub e, portanto, não possui
    // identity/token. Ele continua sendo autorizado de forma estrita: o id
    // precisa apontar para o próprio seat e o CLI solicitado deve ser o mesmo
    // cadastrado nessa conta. Sem esta exceção o handler retornava `false` em
    // silêncio e o overlay ficava apenas com uma tela preta.
    const requestedSeat = req.seatId ? seats.get(req.seatId) : undefined
    const isSeatLogin =
      requestedSeat != null &&
      req.id === `login-${requestedSeat.id}` &&
      req.kind === requestedSeat.cli &&
      req.cwd === '' &&
      req.taskId == null &&
      req.initialPrompt == null &&
      req.model == null &&
      req.cliArgs == null &&
      req.appendSystemPrompt == null &&
      req.logFile == null &&
      pendingIdentity == null &&
      token == null &&
      cached == null
    if (req.kind !== 'shell' && !isSeatLogin) {
      const identityMismatch =
        !pendingIdentity ||
        !token ||
        closingPaneIds.has(req.id) ||
        resolve(req.cwd).toLocaleLowerCase('en-US') !==
          resolve(pendingIdentity.cwd).toLocaleLowerCase('en-US') ||
        req.taskId !== pendingIdentity.taskId ||
        req.seatId !== pendingIdentity.seatId ||
        (cached != null &&
          (cached.spec.kind !== req.kind ||
            cached.spec.cwd !== req.cwd ||
            cached.spec.seatId !== req.seatId ||
            cached.taskId !== (req.taskId ?? '')))
      if (identityMismatch) {
        const projectId = pendingIdentity?.projectId ?? cached?.projectId
        if (pendingIdentity || cached) {
          rollbackFailedPaneSpawn(req.id, 'armamento ausente, encerrando ou divergente')
        } else {
          paneTokens.delete(req.id)
          cleanPaneMcpFile(req.id)
        }
        // pushAll: o pane nasceu na lista das DUAS views via panes:open — a
        // falha de armamento precisa removê-lo do espelho do host também.
        if (projectId) ctx.pushAll('panes:closeById', projectId, req.id)
        return false
      }
    }
    if (pendingIdentity?.role === 'ajudante' && pendingIdentity.taskId) {
      const owner = tasks.get(pendingIdentity.taskId)
      if (
        !owner ||
        owner.status !== 'execucao' ||
        owner.activePhase !== 'dev' ||
        (owner.phaseState !== 'pending' && owner.phaseState !== 'running')
      ) {
        unregisterPane(req.id)
        paneTokens.delete(req.id)
        cleanPaneMcpFile(req.id)
        ctx.pushAll('panes:closeById', pendingIdentity.projectId, req.id)
        return false
      }
    }
    const reusedPty = ptys.has(req.id)
    if (!reusedPty) ctx.paneStartupMetrics?.begin(req.id, paneStartupDescriptor(req))
    const seat = requestedSeat
    const extraEnv: Record<string, string> = {}
    let effectiveCliArgs = req.cliArgs ? [...req.cliArgs] : undefined
    if (seat) {
      const dir = seats.configDirOf(seat)
      const preparationTicket = Symbol(req.id)
      pendingPtyPreparations.set(req.id, preparationTicket)
      await seats.prepare(seat)
      const phaseStillActive = (): boolean => {
        if (reusedPty || !pendingIdentity?.taskId) return true
        const owner = tasks.get(pendingIdentity.taskId)
        if (pendingIdentity.role === 'ajudante') {
          return Boolean(
            owner &&
              owner.status === 'execucao' &&
              owner.activePhase === 'dev' &&
              (owner.phaseState === 'pending' || owner.phaseState === 'running')
          )
        }
        if (
          pendingIdentity.role === 'dev' ||
          pendingIdentity.role === 'review' ||
          pendingIdentity.role === 'qa'
        ) {
          const watch = ctx.phaseWatches.get(pendingIdentity.taskId)
          return Boolean(
            owner &&
              owner.status !== 'done' &&
              owner.activePhase === pendingIdentity.role &&
              (owner.phaseState === 'pending' || owner.phaseState === 'running') &&
              watch?.phase === pendingIdentity.role &&
              watch.paneId === req.id
          )
        }
        return true
      }
      const preparationCanContinue = (): boolean =>
        ptyPreparationCanContinue({
          ticketMatches: pendingPtyPreparations.get(req.id) === preparationTicket,
          senderAlive: !e.sender.isDestroyed(),
          closing: closingPaneIds.has(req.id),
          requiresPaneGeneration: req.kind !== 'shell' && !isSeatLogin,
          capturedIdentity: pendingIdentity,
          currentIdentity: hub.identityByPane(req.id),
          capturedToken: token,
          currentToken: paneTokens.get(req.id),
          capturedSpec: cached,
          currentSpec: livePaneSpecs.get(req.id),
          phaseStillActive: phaseStillActive()
        })
      if (!preparationCanContinue()) {
        if (pendingPtyPreparations.get(req.id) === preparationTicket) {
          pendingPtyPreparations.delete(req.id)
        }
        return false
      }
      if (!reusedPty && seat.cli === 'codex' && req.appendSystemPrompt) {
        // O contrato invisível do pane codex viaja por -c inline. O profile
        // isolado por pane morreu com o catálogo de skills (limpa F6): sem
        // biblioteca não há catálogo do seat para esconder do agente.
        // A guarda de argv dá erro legível se estourar; nunca descarte
        // silencioso de contrato.
        effectiveCliArgs = [
          ...(effectiveCliArgs ?? []),
          '-c',
          `developer_instructions=${JSON.stringify(req.appendSystemPrompt)}`
        ]
      }
      pendingPtyPreparations.delete(req.id)
      if (seat.cli === 'claude') extraEnv['CLAUDE_CONFIG_DIR'] = dir
      else extraEnv['CODEX_HOME'] = dir
    }
    // Pane registrado no hub → bearer token do MCP vai pelo env (codex lê
    // via bearer_token_env_var; inofensivo para os demais).
    if (token) extraEnv['SYNKORA_TOKEN'] = token
    // F5-F3b — WAITER de background (R12, claude-only): o agente arma um
    // `curl` deste endpoint em background e o término (mensagem chegou)
    // ACORDA o turno com zero digitação. A URL vai no env de todo pane com
    // token (inofensivo onde não usada; codex espera via long-poll do
    // check_messages — sonda W5: lá não existe acordar pós-turno).
    if (token && ctx.mcpPort) {
      extraEnv['SYNKORA_MAIL_WAIT_URL'] = `http://127.0.0.1:${ctx.mcpPort}/mail-wait`
    }
    // CORRIDA REAL (maestro da Luma nasceu com "MCP config file not found"):
    // remount do pane reusa o MESMO id — o kill do pty antigo roda
    // cleanPaneMcpFile e apaga o arquivo que o armPane acabou de (re)gravar
    // para o pty novo. Regrava aqui, na hora do spawn: idempotente, o nome é
    // derivado do paneId e o conteúdo só depende de porta+token.
    if (req.kind === 'claude' && token && req.cliArgs?.includes('--mcp-config')) {
      const strict = req.cliArgs.includes('--strict-mcp-config')
      // Remount precisa reproduzir EXATAMENTE o perfil decidido em armPane.
      // Sem identidade comprovada, falha fechado sem MCP externo.
      const external = pendingIdentity
        ? paneExternalMcpCapabilities(paneAccessProfile(pendingIdentity.role))
        : { browser: false, testRunner: false }
      const browserBase = strict && external.browser ? externalPlaywrightForPane() : undefined
      // MESMO decorador do armPane (qaCdp): esta regravação vinha CRUA e
      // dropava o --output-dir no remount (a lição F6.8i só valia no primeiro
      // caminho); com o --cdp-endpoint da Fase 4 a divergência deixaria o QA
      // de Electron cego ao app real — fonte única, nunca separar de novo.
      const browser = browserBase
        ? {
            ...browserBase,
            args: decorateBrowserLaunchArgs(browserBase.args, {
              cwd: req.cwd || undefined,
              role: pendingIdentity?.role,
              taskId: pendingIdentity?.taskId
            })
          }
        : undefined
      const testRunner =
        strict && external.testRunner
          ? resolveProjectPlaywrightTest(req.cwd)
          : undefined
      const file = writeClaudeMcpConfig(
        join(app.getPath('userData'), 'mcp'),
        req.id,
        ctx.mcpPort,
        token,
        browser,
        testRunner
      )
      paneMcpFiles.set(req.id, file)
    }
    const sender = e.sender
    const cwd = req.cwd || app.getPath('home')
    let statsWatchHandle: StatsWatchHandle | undefined
    if (!reusedPty) ctx.paneStartupMetrics?.mark(req.id, 'pty_spawn_started')
    let ptyCreated: boolean
    try {
      ptyCreated = ptys.create(sender, {
      id: req.id,
      // cwd vazio = login/uso fora de projeto: roda na home do usuário.
      cwd,
      kind: req.kind,
      extraEnv,
      initialPrompt: req.initialPrompt,
      model: req.model,
      cliArgs: effectiveCliArgs,
      // Codex NUNCA recebe appendSystemPrompt no spawn (a flag
      // --append-system-prompt é do claude): pane method-governed levou o
      // contrato pelo PROFILE acima; um spec codex fora desse ramo com
      // appendSystemPrompt cai no -c inline abaixo (fallback auditável pela
      // guarda de argv — nunca descarte silencioso).
      appendSystemPrompt: req.kind === 'codex' ? undefined : req.appendSystemPrompt,
      cols: req.cols,
      rows: req.rows,
      logFile: req.logFile,
      canWriteLog: req.logFile
        ? () => {
            if (!pendingIdentity) return false
            ensureProjectRuntimeWritable(pendingIdentity.projectId)
            return true
          }
        : undefined,
      // Pane de tarefa pedindo aprovação → o card correspondente pulsa.
      // Com BYPASS ligado o CLI não pede nada — a heurística só dava falso
      // positivo (mãozinha apitando à toa); o estado do pane (●/◌/■) cobre.
      onAttention: req.taskId
        ? () => {
            const identity = hub.identityByPane(req.id)
            const paneHasAutomaticBypass =
              req.cliArgs?.includes('--dangerously-bypass-approvals-and-sandbox') === true ||
              req.cliArgs?.includes('bypassPermissions') === true
            if (identity && paneHasAutomaticBypass) return
            // manda o PANE junto: dev, ajudantes e gate dividem o MESMO taskId,
            // então só com o taskId o 🖐 acendia (e piscava) em todos eles
            // broadcast: o 🖐 pulsa no chrome das DUAS views (card do Board,
            // rail, Home e o pane no canvas) — o sender capturado só cobria uma.
            ctx.pushAll('tasks:attention', req.taskId, req.id)
          }
        : undefined,
      // Janela REAL de contexto do banner do TUI → teto do medidor do pane.
      onCtxWindow: (tokens) => sessionStats.setWindowHint(req.id, tokens),
      onOutput: () => {
        ctx.paneStartupMetrics?.observeOutput(req.id)
        if (hub.identityByPane(req.id)?.role === 'maestro') {
          scheduleProgressLiveSnapshot(req.id)
        }
      },
      onSubmit: () => ctx.paneStartupMetrics?.markFirstMessage(req.id),
      onSecurityDecision: (decision) => {
        const identity = hub.identityByPane(req.id)
        blackbox.record({
          cat: 'user',
          event:
            decision.action === 'human-authorized'
              ? 'terminal-sensitive-action-authorized'
              : 'terminal-sensitive-action-blocked',
          actor: decision.action === 'human-authorized' ? 'user' : 'harness',
          ids: {
            paneId: req.id,
            projectId: identity?.projectId,
            missionId: identity?.missionId,
            taskId: identity?.taskId,
            role: identity?.role
          },
          reason: decision.action === 'allow' ? undefined : decision.reason,
          detail:
            decision.action === 'allow'
              ? undefined
              : {
                  category: decision.category,
                  commandName: decision.commandName,
                  rawCommandPersisted: false
                }
        })
      },
      // --resume recusado (sessão sem transcript no disco): invalida o id
      // persistido — o PtyManager já respawna o pane sem o --resume sozinho.
      onResumeFail: () => {
        paneSessions.delete(req.id)
        sessionStats.noteReset(req.id)
        if (req.id.startsWith('maestro-')) {
          maestro.update(req.id.slice('maestro-'.length), {
            tuiSessionId: undefined,
            tuiContextTokens: undefined
          })
        }
        const identity = hub.identityByPane(req.id)
        if (identity?.taskId && (identity.role === 'dev' || identity.role === 'review' || identity.role === 'qa')) {
          const task = tasks.get(identity.taskId)
          if (task) {
            const phaseSessions = { ...(task.phaseSessions ?? {}) }
            delete phaseSessions[identity.role]
            tasks.update(identity.taskId, {
              phaseSessions,
              ...(task.phaseResume?.phase === identity.role ? { phaseResume: undefined } : {})
            })
          }
        }
      },
      // /clear (claude) e /new|/fork (codex) começam conversa NOVA no TUI, mas o
      // arquivo de sessão novo só nasce na 1ª mensagem seguinte — se o app
      // fechar antes, o --resume persistido traria a conversa velha de volta
      // (bug real). Detecta o comando na hora e invalida o resume.
      onCommand: (cmd) => {
        const c = cmd.split(/\s+/)[0].toLowerCase()
        // O TUI completa slash commands internamente: o PTY ve "/fo" + Tab +
        // Enter, nao o sufixo "rk" pintado na tela. Prefixos com 2+ letras sao
        // univocos para estes tres comandos e cobrem esse caminho real.
        const completed = (full: string): boolean =>
          c === full || (c.length >= 3 && full.startsWith(c))
        const resets =
          req.kind === 'claude'
            ? completed('/clear')
            : completed('/new') || completed('/fork')
        if (!resets) return
        paneSessions.delete(req.id)
        // só ESTE pane pode migrar para o arquivo de sessão novo — sem isso
        // o /clear de um pane roubava o arquivo para os vizinhos de cwd
        sessionStats.noteReset(req.id)
        // avisa o xterm: /clear (ou /new) deve limpar TAMBÉM o scrollback, senão
        // a conversa "apagada" continua acessível rolando para cima. Sinal LIMPO
        // (o usuário digitou o comando de fato) — nada de adivinhar por texto.
        // Com o conpty.dll o backend também é limpo de verdade (clear() =
        // ConptyClearPseudoConsole): sem isso o buffer do ConPTY ainda guarda a
        // conversa velha e a devolve na primeira repintura.
        // /fork cria outro rollout, mas preserva a tela/historico visual do
        // Codex. /clear e /new continuam limpando backend + scrollback.
        if (c !== '/fork') {
          ptys.clear(req.id)
          if (!sender.isDestroyed()) sender.send('pty:reset', req.id)
        }
        if (req.id.startsWith('maestro-')) {
          maestro.update(req.id.slice('maestro-'.length), {
            tuiSessionId: undefined,
            tuiContextTokens: undefined
          })
        }
        const identity = hub.identityByPane(req.id)
        if (identity?.taskId && (identity.role === 'dev' || identity.role === 'review' || identity.role === 'qa')) {
          const task = tasks.get(identity.taskId)
          if (task) {
            const phaseSessions = { ...(task.phaseSessions ?? {}) }
            delete phaseSessions[identity.role]
            tasks.update(identity.taskId, {
              phaseSessions,
              ...(task.phaseResume?.phase === identity.role ? { phaseResume: undefined } : {})
            })
          }
        }
      },
      // "Login expired" na saída → seat marcado como expirado no rail + hub.
      onLoginExpired: seat
        ? () => {
            if (!expiredSeats.has(seat.id)) {
              expiredSeats.set(seat.id, Date.now())
              const identity = hub.identityByPane(req.id)
              if (identity) {
                hub.publish({
                  projectId: identity.projectId,
                  kind: 'error',
                  text: `login do seat ${seat.name} EXPIROU — refaça em Configurações › Minhas contas`,
                  actor: 'harness'
                })
              }
            }
            ctx.pushAll('seats:changed')
          }
        : undefined,
      onExit: (exitCode, outputTail) => {
        // GERAÇÃO DO ARMAMENTO: remount reusa o MESMO paneId, e o armPane do
        // paneSpec já criou token/identidade/arquivo MCP para o pty que vai
        // nascer. Se o token corrente não é mais o que ESTE processo recebeu no
        // spawn, este exit é do processo VELHO: não pode desarmar o pane novo,
        // roubar o watcher dele nem mover o pipeline (tarefa→backlog,
        // missão→ativa). O token é a prova de dono (pane shell não tem token:
        // undefined === undefined e o fluxo segue normal).
        if (paneTokens.get(req.id) !== token) return
        testServerPanes.delete(req.id)
        ctx.paneStartupMetrics?.end(req.id)
        if (statsWatchHandle != null) sessionStats.unwatch(req.id, statsWatchHandle)
        // remount reusa paneId: o first-contact do processo MORTO não pode
        // valer como prova de conexão do processo novo
        ctx.mcpPaneFirstContact.delete(req.id)
        const identity = unregisterPane(req.id)
        blackbox.record({
          cat: 'pane',
          event: 'exit',
          ids: identity
            ? {
                projectId: identity.projectId,
                missionId: identity.missionId,
                taskId: identity.taskId,
                paneId: req.id,
                phase: identity.phase,
                role: identity.role,
                seatId: identity.seatId
              }
            : { paneId: req.id },
          // exitCode + últimas linhas: a morte em spawn do orquestrador de
          // 02/08 foi invisível no diário ("caixa-preta SEM EXCEÇÕES").
          detail: { kind: req.kind, exitCode, outputTail }
        })
        livePaneSpecs.delete(req.id)
        closingPaneIds.delete(req.id)
        paneTokens.delete(req.id)
        cleanPaneMcpFile(req.id)
        if (!identity) return
        if (identity.role === 'maestro') {
          const idleTimer = progressLiveIdleTimers.get(req.id)
          if (idleTimer) clearTimeout(idleTimer)
          progressLiveIdleTimers.delete(req.id)
          refreshProgressLiveSnapshot()
        }
        // pushAll substitui o fallback `ctx.uiSender ?? sender` (F3-c0): a
        // lista de panes vive nas DUAS views e o exit precisa limpar ambas.
        ctx.pushAll('panes:closeById', identity.projectId, req.id)
        // Ajudante que morreu SEM reportar done (crash/fechado): o delegador
        // é avisado na hora — controle total sobre os ajudantes (pedido do
        // usuário). SEM ruído: com report, com helper_close deliberado ou com
        // a saída já lida (helper_output), avisar atrapalha em vez de ajudar.
        if (identity.role === 'ajudante' && identity.delegatorPaneId) {
          const reported = helperReported.delete(identity.paneId)
          const seen = helperSeen.delete(identity.paneId)
          if (!reported) helperCompletions.discard(identity.paneId)
          if (!reported) updateStoredHelperStatus(identity.projectId, identity.paneId, 'interrupted')
          if (!reported && !seen) {
            const helperPath = helperTranscriptPath(identity.projectId, identity.paneId)
            const project = projects.get(identity.projectId)
            const relativePath = helperPath && project
              ? helperPath.slice(project.path.length + 1).replace(/\\/g, '/')
              : `.synkora/runs/helper-${identity.paneId}.md`
            hub.notifyPane(
              identity.delegatorPaneId,
              `ajudante ${identity.paneId.slice(0, 8)} ENCERROU SEM reportar done — helper_output ainda lê o final da saída; transcript em ${relativePath}`,
              {
                sourcePaneId: identity.paneId,
                kind: 'feedback',
                correlationId: randomUUID()
              }
            )
          }
        }
        // FASE ATIVA morreu junto com o pane (usuário fechou/crash): solta o
        // watch, devolve a tarefa para o backlog com o motivo e avisa o
        // orquestrador AO VIVO — nada fica preso em "execução" fantasma.
        if (identity.taskId) {
          // O runtime do QA vive e morre com o PANE do QA (gate vivo em
          // espera mantém os dois; morte por qualquer motivo derruba a
          // árvore do dev server — nada de Electron/vite órfão).
          if (identity.role === 'qa') stopQaRuntime(identity.taskId)
          // Gate VIVO em espera fechado na mão: só higiene do mapa — o
          // reciclo seguinte detecta o pane morto e abre um gate novo.
          const gateWait = ctx.liveGateWaits.get(identity.taskId)
          if (gateWait && gateWait.paneId === identity.paneId)
            ctx.liveGateWaits.delete(identity.taskId)
          const watch = ctx.phaseWatches.get(identity.taskId)
          // F2-c4 (§7.7 do mapa da Fase 2): com o veredito do card em
          // processamento (lock tomado — ex.: rollback re-indexou o watch com
          // a continuação em voo), o onExit só REGISTRA e deixa a decisão
          // para o dono do lock; mutar aqui devolveria o card ao backlog por
          // baixo de um report que respondeu "preservado".
          if (
            watch &&
            watch.phase === identity.phase &&
            ctx.phaseTransitions.isLocked(identity.taskId)
          ) {
            blackbox.record({
              cat: 'pane',
              event: 'pane-exit-during-transition',
              actor: 'harness',
              ids: {
                projectId: identity.projectId,
                missionId: identity.missionId,
                taskId: identity.taskId,
                paneId: identity.paneId,
                phase: identity.phase,
                role: identity.role
              },
              reason: `pane morreu com o card em transição sob ${
                ctx.phaseTransitions.holderLabel(identity.taskId) ?? '?'
              } — nenhuma mutação; o dono do lock decide o desfecho`
            })
          } else if (watch && watch.phase === identity.phase) {
            ctx.phaseWatches.delete(identity.taskId)
            const task = tasks.get(identity.taskId)
            if (task && task.status !== 'done') {
              if (watch.phase === 'review' || watch.phase === 'qa') {
                // GATE morreu sem veredito: o trabalho do dev está INTACTO no
                // worktree — voltar ao backlog custava uma rodada inteira de
                // dev (caso real 2026-07-30). O card fica onde está e o
                // orquestrador reabre SÓ o gate.
                // BREAKER DE CRASH-LOOP (caso real 05/08 16:59: review morreu
                // 3× em 33s e cada morte foi reaberta às cegas — precedente do
                // Board: 3 mortes/30s param de ressuscitar).
                const { looping, deaths } = recordGateDeath(identity.taskId)
                tasks.update(identity.taskId, {
                  status: watch.phase === 'qa' ? 'qa' : 'execucao',
                  activePhase: watch.phase,
                  phaseState: 'interrupted',
                  ...(task.feedback
                    ? {}
                    : {
                        feedback: `gate ${watch.phase} interrompido (pane fechado) — o desenvolvimento está preservado`
                      })
                })
                hub.publish({
                  projectId: identity.projectId,
                  missionId: identity.missionId,
                  kind: 'error',
                  text: looping
                    ? `gate ${watch.phase} de "${task.title}" morreu ${deaths}× em 1 minuto SEM veredito — reabertura automática SUSPENSA por 5 minutos. NÃO re-rode em reflexo: leia as últimas linhas no evento pane/exit da caixa-preta, avalie trocar o seat/modelo do gate (config do reviewer ou lane) e só então reabra com run_task {id: "${identity.taskId}", phase: "${watch.phase}"}`
                    : `gate ${watch.phase} de "${task.title}" fechou SEM veredito — o trabalho do dev está intacto; reabra só o gate com run_task {id: "${identity.taskId}", phase: "${watch.phase}"}`,
                  actor: 'harness'
                })
              } else {
                terminateTaskHelpers(
                  identity.projectId,
                  identity.taskId,
                  'pane dev encerrou antes de concluir a fase'
                )
                tasks.update(identity.taskId, {
                  status: 'backlog',
                  ...(task.feedback
                    ? {}
                    : {
                        feedback: `fase ${watch.phase} interrompida (pane fechado) — transcript .synkora/runs/${identity.taskId}.md registra o que já foi feito`
                      }),
                  activePhase: 'dev',
                  phaseState: 'interrupted'
                })
                hub.publish({
                  projectId: identity.projectId,
                  missionId: identity.missionId,
                  kind: 'error',
                  text: `pane ${identity.role} de "${task.title}" FECHOU no meio da fase ${watch.phase} — worktree, briefing e transcript foram preservados; retome o MESMO card com run_task {id: "${identity.taskId}"}. Atualize o briefing somente se o escopo real tiver mudado`,
                  actor: 'harness'
                })
              }
              ctx.pushAll('tasks:changed', identity.projectId)
              syncBoard(identity.projectId)
            }
          }
        } else if (identity.missionId && identity.role === 'review') {
          // gate de INTEGRAÇÃO fechado sem veredito
          const mw = ctx.missionWatches.get(identity.missionId)
          if (mw && mw.paneId === identity.paneId) {
            ctx.missionWatches.delete(identity.missionId)
            missions.update(identity.missionId, { status: 'ativa' })
            hub.publish({
              projectId: identity.projectId,
              missionId: identity.missionId,
              kind: 'error',
              text: 'o gate de integração fechou sem veredito — chame integrate_mission de novo quando quiser',
              actor: 'harness'
            })
            emitMissionsChanged(identity.projectId)
          }
        }
        if (identity.role !== 'maestro') {
          hub.publish({
            projectId: identity.projectId,
            missionId: identity.missionId,
            kind: 'pane-close',
            text: `pane ${identity.role} encerrado${identity.taskId ? ` (tarefa ${tasks.get(identity.taskId)?.title ?? identity.taskId})` : ''}`,
            actor: identity.role,
            // QUIET (decisão 2026-07-28, coerente com o PM silencioso):
            // abrir pane manual nunca avisou — fechar avisar era assimétrico
            // e ruído ("pane livre encerrado" → PM responde "Ok."). O ciclo
            // de vida cru de pane fica em EVENTS.md/UI; o que IMPORTA já tem
            // evento próprio: fase interrompida (error), ajudante morto sem
            // report (notifyPane) e missão direta do agente livre.
            quiet: true
          })
        }
      }
      })
    } catch (error) {
      ctx.paneStartupMetrics?.fail(req.id)
      blackbox.record({
        cat: 'pane',
        event: 'spawn-failed',
        ids: { paneId: req.id, taskId: req.taskId, seatId: req.seatId },
        detail: { kind: req.kind, cwd },
        err: error instanceof Error ? error.message : String(error)
      })
      rollbackFailedPaneSpawn(
        req.id,
        error instanceof Error ? error.message : String(error)
      )
      throw error
    }
    if (ptyCreated) {
      paneEverSpawned.add(req.id)
      helperOpenWatchdog.acknowledge(req.id)
      // Servidor de teste do dono: o pane shell nasce cru — o comando entra
      // digitado (inject fatiado) assim que o prompt do PowerShell assentar.
      // 2.0: o terminal avulso da missão entra no MESMO registro (para morrer
      // antes do merge) mas nasce sem comando — nada a digitar, o dono usa.
      const testSrv = testServerPanes.get(req.id)
      const testSrvCommand = testSrv?.command?.trim()
      if (req.kind === 'shell' && testSrvCommand) {
        setTimeout(() => {
          if (ptys.has(req.id)) ptys.inject(req.id, testSrvCommand)
        }, 1200)
      }
      const spawnIdentity = hub.identityByPane(req.id)
      if (
        spawnIdentity &&
        (spawnIdentity.role === 'review' || spawnIdentity.role === 'qa') &&
        spawnIdentity.taskId
      ) {
        armGateMcpWatchdog(spawnIdentity, req.id)
      }
      // DEV SEM MCP NUNCA É SILENCIOSO (caso real 04/08 23:28: dev codex
      // trabalhou a fase INTEIRA sem nenhuma requisição autenticada —
      // notify_pane não alcançava e ninguém sabia). Irmão SOFT do watchdog de
      // gate: 120s sem 1º contato → evento informativo ao orquestrador; nada
      // é morto (o done ainda chega pelo marcador .done).
      if (spawnIdentity && spawnIdentity.role === 'dev' && spawnIdentity.taskId) {
        const devIdentity = spawnIdentity
        const devPaneId = req.id
        const soft = setTimeout(() => {
          if (!ptys.has(devPaneId)) return
          if (ctx.mcpPaneFirstContact.has(devPaneId)) return
          const stillSame = hub.identityByPane(devPaneId)
          if (!stillSame || stillSame.role !== 'dev' || stillSame.taskId !== devIdentity.taskId)
            return
          blackbox.record({
            cat: 'mcp',
            event: 'dev-mcp-silent',
            actor: 'harness',
            ids: {
              projectId: devIdentity.projectId,
              missionId: devIdentity.missionId,
              taskId: devIdentity.taskId,
              paneId: devPaneId,
              phase: 'dev',
              role: 'dev'
            },
            reason: 'nenhuma requisição MCP autenticada em 120s — pane possivelmente degradado'
          })
          hub.publish({
            projectId: devIdentity.projectId,
            missionId: devIdentity.missionId,
            kind: 'info',
            text: `o dev do card ${devIdentity.taskId?.slice(0, 8)} está SEM MCP nesta sessão (nenhuma requisição em 120s) — notify_pane pode não alcançar e o done virá por marcador; se precisar corrigir rumo, use update_task + respawn (run_task)`,
            actor: 'harness'
          })
        }, 120_000)
        soft.unref?.()
      }
      blackbox.record({
        cat: 'pane',
        event: reusedPty ? 'remount' : 'spawn',
        ids: spawnIdentity
          ? {
              projectId: spawnIdentity.projectId,
              missionId: spawnIdentity.missionId,
              taskId: spawnIdentity.taskId,
              paneId: req.id,
              phase: spawnIdentity.phase,
              role: spawnIdentity.role,
              seatId: spawnIdentity.seatId
            }
          : { paneId: req.id, taskId: req.taskId, seatId: req.seatId },
        detail: {
          kind: req.kind,
          model: req.model,
          cwd,
          resume: req.cliArgs?.includes('--resume') || req.cliArgs?.includes('resume') || false,
          hasInitialPrompt: Boolean(req.initialPrompt)
        }
      })
      closingPaneIds.delete(req.id)
      ctx.paneStartupMetrics?.mark(req.id, 'pty_spawn_completed')
      if (req.initialPrompt) ctx.paneStartupMetrics?.markFirstMessage(req.id)
      const identity = hub.identityByPane(req.id)
      if (
        identity?.taskId &&
        (identity.role === 'dev' || identity.role === 'review' || identity.role === 'qa')
      ) {
        const task = tasks.get(identity.taskId)
        const watch = ctx.phaseWatches.get(identity.taskId)
        if (
          task?.phaseState === 'pending' &&
          watch?.paneId === req.id &&
          watch.phase === identity.role
        ) {
          tasks.update(identity.taskId, {
            phaseState: 'running',
            phaseStartedAt: new Date().toISOString()
          })
          ctx.pushAll('tasks:changed', identity.projectId)
          syncBoard(identity.projectId)
        }
      }
    }
    // Badges ao vivo: tokens/contexto lidos do JSONL que o próprio CLI grava.
    if (ptyCreated && req.kind !== 'shell') {
      // Pane RESUMADO conhece a própria sessão (--resume <sid> / resume <tid>
      // nos cliArgs) — adoção exata no watcher, imune a vizinhos de cwd.
      let sessionHint: string | undefined
      const rawArgs = req.cliArgs ?? []
      const resumeIdx = rawArgs.indexOf(req.kind === 'claude' ? '--resume' : 'resume')
      if (resumeIdx >= 0 && rawArgs[resumeIdx + 1] && !rawArgs[resumeIdx + 1].startsWith('-')) {
        sessionHint = rawArgs[resumeIdx + 1]
      }
      // TETO DE CUSTO DO RESUME (2026-08-06): carimba o contexto vivo da fase
      // no card para o próximo respawn decidir resume × fresco. Throttle por
      // delta (25k) — gravar a cada tick seria churn no tasks.json.
      let lastStampedCtx = 0
      const stampPhaseContext = (contextTokens: number | null): void => {
        if (contextTokens == null) return
        const identity = hub.identityByPane(req.id)
        const phase = identity?.phase
        if (!identity?.taskId || !phase) return
        if (Math.abs(contextTokens - lastStampedCtx) < 25_000) return
        const task = tasks.get(identity.taskId)
        const entry = task?.phaseSessions?.[phase]
        if (!entry) return
        lastStampedCtx = contextTokens
        tasks.update(identity.taskId, {
          phaseSessions: {
            ...task!.phaseSessions,
            [phase]: { ...entry, lastContextTokens: contextTokens }
          }
        })
      }
      // TETO DE CUSTO DO RESUME DO PM/ORQUESTRADOR (pedido do usuário,
      // 2026-08-06: "eles não podem ter que reler a conversa toda"): mesmo
      // carimbo da fase, gravado no maestroStore para o próximo paneSpec
      // decidir resume × fresco. Throttle 25k — churn no maestro.json.
      let lastMaestroCtx = 0
      const stampMaestroContext = (contextTokens: number | null): void => {
        if (contextTokens == null || !req.id.startsWith('maestro-')) return
        if (Math.abs(contextTokens - lastMaestroCtx) < 25_000) return
        lastMaestroCtx = contextTokens
        maestro.update(req.id.slice('maestro-'.length), { tuiContextTokens: contextTokens })
      }
      statsWatchHandle = sessionStats.watch(req.id, {
        cli: req.kind,
        configDir: seat ? seats.configDirOf(seat) : undefined,
        cwd,
        sessionHint,
        // o JSONL não carrega o [1m] — o teto real vem do modelo do spawn
        modelHint: req.model,
        onStats: (stats) => {
          // broadcast: os medidores dos chips vivem no chrome das DUAS views
          // (Board lê PM/orquestrador, canvas lê execução — e vice-versa).
          ctx.pushAll('panes:stats', req.id, stats)
          stampPhaseContext(stats.contextTokens)
          stampMaestroContext(stats.contextTokens)
        },
        onSession: (sessionId) => {
          paneSessions.set(req.id, sessionId)
          // Pane do Maestro: persiste a sessão para o --resume/resume na
          // próxima abertura do projeto/app. Sessão DIFERENTE da persistida =
          // conversa nova — o carimbo de contexto da antiga não pode vetar o
          // resume barato da nova (o stamp recomeça com os stats dela).
          if (req.id.startsWith('maestro-')) {
            const key = req.id.slice('maestro-'.length)
            const prevSession = maestro.get(key).tuiSessionId
            maestro.update(key, {
              tuiSessionId: sessionId,
              ...(prevSession !== sessionId ? { tuiContextTokens: undefined } : {})
            })
          }
          const identity = hub.identityByPane(req.id)
          if (
            identity?.taskId &&
            (identity.role === 'dev' || identity.role === 'review' || identity.role === 'qa')
          ) {
            const task = tasks.get(identity.taskId)
            if (task && task.status !== 'done' && req.seatId) {
              const rawArgs = req.cliArgs ?? []
              const effortFromArgs =
                req.kind === 'claude'
                  ? (() => {
                      const at = rawArgs.indexOf('--effort')
                      return at >= 0 ? rawArgs[at + 1] : undefined
                    })()
                  : rawArgs
                      .find((arg) => arg.startsWith('model_reasoning_effort='))
                      ?.replace(/^model_reasoning_effort=["']?|["']$/g, '')
              const phaseSession = {
                phase: identity.role,
                sessionId,
                seatId: req.seatId,
                cli: req.kind === 'claude' ? 'claude' as const : 'codex' as const,
                model: req.model,
                effort:
                  task.phaseSessions?.[identity.role]?.effort ??
                  (task.phaseResume?.phase === identity.role
                    ? task.phaseResume.effort
                    : effortFromArgs),
                capturedAt: new Date().toISOString()
              }
              tasks.update(identity.taskId, {
                phaseSessions: {
                  ...(task.phaseSessions ?? {}),
                  [identity.role]: phaseSession
                },
                ...(task.activePhase === identity.role ? { phaseResume: phaseSession } : {})
              })
            }
          }
        }
      })
    } else if (!ptyCreated && req.kind !== 'shell') {
      // Remount do renderer: o PTY e o watcher continuam vivos. Reenvia o
      // snapshot porque TerminalPane zerou o store local antes de pty:create.
      sessionStats.replay(req.id)
    }
    return true
  })

  ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) =>
    ptys.resize(id, cols, rows)
  )
  ipcMain.on('pty:kill', (_e, id: string) => {
    pendingPtyPreparations.delete(id)
    // Este canal chega a CADA REMOUNT do TerminalPane (cliArgs novos de um
    // paneSpec, troca de seat) — "remount" NÃO é "pane fechado". Desarmar aqui
    // apagava o token, a identidade no hub e o userData/mcp/<paneId>.json que o
    // armPane tinha ACABADO de gravar para o pty que ia nascer: o Maestro subia
    // com --mcp-config apontando para arquivo inexistente e SEM NENHUMA tool
    // synkora (create_mission/board_status/delegate), até reiniciar o app.
    // O desarmamento vive no onExit do pty:create, com guard de geração.
    if (!ptys.has(id) && livePaneSpecs.has(id)) {
      if (!paneEverSpawned.has(id)) {
        closingPaneIds.add(id)
        rollbackFailedPaneSpawn(id, 'pane fechado antes de iniciar')
        paneSessions.delete(id)
        return
      }
      // O pane JÁ viveu e morreu (ex.: o main matou o PTY no pós-report e o
      // renderer só desmontou depois): é limpeza de registro, nunca "não
      // conseguiu abrir" — o aviso falso confundia o delegador (bug real,
      // 2026-08-03).
      livePaneSpecs.delete(id)
      closingPaneIds.delete(id)
      paneSessions.delete(id)
      return
    }
    ptys.kill(id)
    paneSessions.delete(id)
  })
}
