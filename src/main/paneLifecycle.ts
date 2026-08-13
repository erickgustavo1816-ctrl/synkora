/**
 * PANE LIFECYCLE — armamento, estado vivo e encerramento de panes (fase 1,
 * commit 7a).
 *
 * Corpo movido VERBATIM do closure do whenReady em index.ts (cirurgia do
 * índice, docs/FASE1_MAPA_PANELIFECYCLE.md). O estado vivo de pane
 * (livePaneSpecs, closingPaneIds, paneEverSpawned, pendingPtyPreparations,
 * testServerPanes) nasce AQUI; o index expõe aliases e os getters do
 * MainContext seguem textualmente intactos.
 *
 * Contratos que este módulo NÃO pode quebrar:
 * - ORDEM OBRIGATÓRIA de construção: paneLifecycle → mission → maestro →
 *   phase. O phaseEngine desestrutura ctx.livePaneSpecs/ctx.closingPaneIds
 *   NA CONSTRUÇÃO — nascer depois dele é TDZ de boot, não erro de typecheck.
 * - A corrida armPane×cleanPaneMcpFile: armPane grava paneMcpFiles; o
 *   pty:create RE-GRAVA o arquivo MCP no spawn (idempotente); pty:kill NUNCA
 *   desarma — o desarme vive no onExit sob guard de geração. Os três moram
 *   em módulos diferentes desde o commit 7; o invariante é o conjunto.
 * - phaseWatches é lido em CALL TIME via ctx (o alias nasce no phaseEngine,
 *   construído depois) — nunca desestruturar na construção.
 * - unregisterPane/cleanPaneMcpFile/paneTokens/paneMcpFiles FICAM no index
 *   (cross-domain: codeIntelligence, skill leases, mcpApi/helpers) — o
 *   engine os lê via ctx.
 */
import { app } from 'electron'
import { join, resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import {
  claudeMcpArgs,
  codexMcpArgs,
  ensurePlaywrightCmd,
  ensurePlaywrightTestCmd,
  resolveProjectPlaywrightTest,
  writeClaudeMcpConfig
} from './mcpServer'
import {
  codexGateMcpDisableArgs,
  codexGateMcpPolicyArgs,
  effectiveSensitiveAccess,
  paneAccessProfile,
  paneBrowserAvailable,
  paneExternalMcpCapabilities,
  panePermissionArgs,
  type PaneAccessProfile
} from './panePermissions'
import {
  codexMcpProtocolArgs,
  getCodexMcpProtocolStatus,
  prewarmCodexMcpProtocol
} from './mcpProtocol'
import { isMethodGovernedPaneRole } from './codexSkillIsolation'
import { activeQaRuntimes, stopQaRuntime } from './qaRuntime'
import { decorateBrowserLaunchArgs, qaCdpReservations } from './qaCdp'
import { parsePortFromUrl, type PortUseEntry } from './portMap'
import type { PaneStartupDescriptor } from './paneStartupMetrics'
import type { PaneKind } from './pty'
import type { SeatCli } from './seats'
import type { PaneIdentity } from './hub'
import type { DevPaneSpec } from './phaseTypes'
import type { HelperOpenWatchdog } from './helperOpenWatchdog'
import type { HelperRecoveryRecord, HelperRecoveryStatus } from './helperRecovery'
import type { MainContext } from './mainContext'

export interface PaneRequest {
  id: string
  cwd: string
  kind: PaneKind
  seatId?: string
  taskId?: string
  initialPrompt?: string
  model?: string
  cliArgs?: string[]
  appendSystemPrompt?: string
  cols?: number
  rows?: number
  logFile?: string
}

// Só o watchdog de helper lê a graça — const de módulo (era do poller do index).
const HELPER_OPEN_GRACE_MS = 30_000

/**
 * Dependências do closure do index que o domínio de pane consome e que ainda
 * não migraram — todas declaradas ANTES do ponto de construção (nenhuma
 * arrow late-bound; o paneLifecycle nasce PRIMEIRO entre os engines).
 */
export interface PaneLifecycleExtras {
  /** Pré-aceite de bypass + trust do cwd no config do seat claude. */
  ensureBypassAccepted(configDir: string, trustCwd?: string): void
  /** Trust do projeto + sandbox do Windows no config.toml do seat codex. */
  ensureCodexTrust(configDir: string, projectPath: string): void
  /** Carimbo de status no transcript durável do ajudante (helperRecovery). */
  updateStoredHelperStatus(
    projectId: string,
    paneId: string,
    status: HelperRecoveryStatus,
    statusAt?: string
  ): HelperRecoveryRecord | undefined
  /** Escopo de módulo do index — compartilhado com mcpApi/helpers. */
  helperOpenWatchdog: HelperOpenWatchdog
}

export type PaneLifecycleEngine = ReturnType<typeof createPaneLifecycle>

export function createPaneLifecycle(ctx: MainContext, extras: PaneLifecycleExtras) {
  const {
    projects,
    tasks,
    maestro,
    settings,
    ptys,
    blackbox,
    helperCompletions,
    paneTokens,
    paneMcpFiles,
    paneSessions,
    syncBoard,
    externalPlaywrightForPane,
    bypassOn,
    unregisterPane,
    cleanPaneMcpFile
  } = ctx
  // hub é atribuído UMA vez, antes de o engine nascer — capturar é seguro.
  const hub = ctx.hub
  const { ensureBypassAccepted, ensureCodexTrust, updateStoredHelperStatus, helperOpenWatchdog } =
    extras

  /** Classificação allowlisted da abertura do pane. Não inclui cwd, modelo,
   *  argumentos, token, prompt ou qualquer conteúdo do terminal. */
  function paneStartupDescriptor(req: PaneRequest): PaneStartupDescriptor {
    const identity = hub.identityByPane(req.id)
    const rawArgs = req.cliArgs ?? []
    const strict =
      req.kind === 'claude'
        ? rawArgs.includes('--strict-mcp-config')
        : rawArgs.some((arg) => arg.includes('mcp_servers.playwright.command='))
    const allowsBrowser = identity?.role !== 'review'
    const allowsTestRunner =
      identity?.role !== 'review' && identity?.role !== 'qa'
    const externalMcpCount = strict
      ? Number(allowsBrowser && Boolean(externalPlaywrightForPane())) +
        Number(allowsTestRunner && Boolean(resolveProjectPlaywrightTest(req.cwd)))
      : 0
    const mode: PaneStartupDescriptor['mode'] =
      req.kind === 'shell'
        ? 'shell'
        : identity?.role === 'maestro'
          ? 'maestro'
          : strict
            ? 'estrito'
            : 'livre'
    return {
      kind: req.kind,
      ...(identity ? { role: identity.role } : {}),
      mode,
      externalMcpCount,
      hasInitialPrompt: Boolean(req.initialPrompt)
    }
  }

  /** Flags de MCP do pane (claude: arquivo de config; codex: overrides -c). */
  function mcpPaneArgs(
    cli: SeatCli,
    paneId: string,
    token: string,
    strict: boolean,
    cwd?: string,
    configDir?: string,
    accessProfile: PaneAccessProfile = 'write',
    sensitive = false,
    paneRole?: string,
    taskId?: string
  ): string[] {
    if (ctx.mcpPort === 0) return [] // servidor ainda subindo (raro): pane nasce sem tools
    // Dev/ajudante recebem browser + runner. Gates recebem somente
    // Synkora/code_*: o Playwright MCP bruto não é uma fronteira segura.
    const external = paneExternalMcpCapabilities(accessProfile)
    const configuredBrowser = externalPlaywrightForPane()
    const browserBase = paneBrowserAvailable(accessProfile, {
      sensitive,
      sensitiveAutoOk: false,
      strict,
      mcpReady: ctx.mcpPort !== 0,
      browserConfigured: Boolean(configuredBrowser)
    })
      ? configuredBrowser
      : undefined
    // Decoração POR PANE dos args do playwright numa fonte única (qaCdp):
    // --output-dir <cwd>/.playwright-mcp (evidência nunca nasce git-visível,
    // caso real 2026-08-06) e, para o pane de QA de card Electron com porta
    // CDP reservada, --cdp-endpoint (Fase 4 — o QA dirige o app REAL). O
    // wrapper codex é fingerprinted por args — cada cwd/porta ganha o seu.
    // A regravação anti-corrida do pty:create usa o MESMO decorador.
    const browser = browserBase
      ? {
          ...browserBase,
          args: decorateBrowserLaunchArgs(browserBase.args, { cwd, role: paneRole, taskId })
        }
      : browserBase
    const testRunner =
      strict && !sensitive && external.testRunner ? resolveProjectPlaywrightTest(cwd) : undefined
    if (cli === 'claude') {
      // panes de EXECUÇÃO (strict) ganham também o Playwright MCP — browser
      // de teste que funciona em qualquer seat (Chrome ext. é por conta).
      const file = writeClaudeMcpConfig(
        join(app.getPath('userData'), 'mcp'),
        paneId,
        ctx.mcpPort,
        token,
        browser,
        testRunner
      )
      paneMcpFiles.set(paneId, file)
      return claudeMcpArgs(file, strict)
    }
    // panes codex de EXECUÇÃO (mesmo critério do claude) ganham o Playwright
    // MCP via wrapper .cmd — QA/dev/ajudante codex abrem browser de verdade
    const protocolStatus = getCodexMcpProtocolStatus(configDir)
    if (protocolStatus.state !== 'ready') void prewarmCodexMcpProtocol(configDir)
    const protocolArgs = protocolStatus.state === 'ready'
      ? codexMcpProtocolArgs(settings.get().mcpProtocolMode, {
          checkedAt: protocolStatus.checkedAt ?? 0,
          version: protocolStatus.version,
          featurePresent: protocolStatus.featurePresent,
          featureEnabled: protocolStatus.featureEnabled,
          capability: protocolStatus.capability,
          reason: protocolStatus.reason ?? 'feature-output-invalid'
        })
      : []
    const args = codexMcpArgs(
      ctx.mcpPort,
      browser ? ensurePlaywrightCmd(join(app.getPath('userData'), 'mcp'), browser) : undefined,
      testRunner ? ensurePlaywrightTestCmd(join(app.getPath('userData'), 'mcp'), testRunner) : undefined,
      protocolArgs
    )
    if (accessProfile !== 'write') {
      args.push(...codexGateMcpPolicyArgs())
      if (browser) {
        args.push('-c', 'mcp_servers.playwright.default_tools_approval_mode="approve"')
      }
      if (testRunner) {
        args.push('-c', 'mcp_servers.playwright-test.default_tools_approval_mode="approve"')
      }
    }
    return args
  }

  /** Registra um pane no hub e devolve os cliArgs de MCP + permissões dele. */
  function armPane(
    identity: Omit<PaneIdentity, 'paneId'> & { paneId?: string },
    cli: SeatCli,
    opts: { strictMcp?: boolean; configDir?: string; sensitive?: boolean } = {}
  ): { paneId: string; cliArgs: string[] } {
    const paneId = identity.paneId ?? randomUUID()
    const methodGoverned = isMethodGovernedPaneRole(identity.role)
    if (cli === 'codex' && methodGoverned && !opts.configDir) {
      throw new Error('Codex method-governed pane requires an isolated config directory')
    }
    const token = randomUUID()
    hub.registerPane(token, { ...identity, paneId })
    paneTokens.set(paneId, token)
    try {
    const bypass = bypassOn(identity.projectId)
    const accessProfile = paneAccessProfile(identity.role)
    // OVERRIDE DO DONO (por projeto, decisão do usuário 2026-08-04): em domínio
    // onde TODA missão cita PII/fiscal (ex.: app de PER/DCOMP fala CPF/CNPJ em
    // qualquer goal), a classificação de superfície sensível degeneraria para
    // "sempre" e mataria a automação do projeto inteiro. Com o switch ligado,
    // o toggle de bypass volta a mandar; cada uso fica auditado na caixa-preta.
    // O padrão continua protegido (override desligado).
    const sensitiveOverride =
      opts.sensitive === true && maestro.get(identity.projectId).sensitiveAutoOk === true
    const sensitive = effectiveSensitiveAccess(opts.sensitive === true, sensitiveOverride)
    const effectiveStrictMcp = sensitive ? true : (opts.strictMcp ?? true)
    const args: string[] = []
    args.push(
      ...panePermissionArgs(cli, bypass, accessProfile, {
        sensitive,
        receiptGoverned: methodGoverned
      })
    )
    if (sensitive && accessProfile === 'write' && bypass) {
      blackbox.record({
        cat: 'pane',
        event: 'automatic-bypass-suppressed',
        actor: 'harness',
        ids: {
          paneId,
          projectId: identity.projectId,
          missionId: identity.missionId,
          taskId: identity.taskId,
          role: identity.role,
          seatId: identity.seatId
        },
        reason: 'superfície sensível detectada; o pane escritor exige autorização interativa'
      })
    }
    if (sensitiveOverride) {
      blackbox.record({
        cat: 'pane',
        event: 'sensitive-bypass-override',
        actor: 'harness',
        ids: {
          paneId,
          projectId: identity.projectId,
          missionId: identity.missionId,
          taskId: identity.taskId,
          role: identity.role,
          seatId: identity.seatId
        },
        reason:
          'superfície sensível detectada, mas o usuário liberou bypass para este projeto (switch no board)'
      })
    }
    if (cli === 'claude') {
      // aceite de bypass + trust do cwd — TODO pane claude, inclusive gates
      // read-only e sensíveis (caso real 2026-08-06: QA claude nasceu PRESO no
      // "trust this folder" do worktree do card porque este pré-trust só
      // cobria accessProfile 'write'; dev codex + QA claude no mesmo worktree
      // era o caso descoberto). O trust do ROOT do projeto vai junto, em
      // grafia UTF-8 correta — entrada mojibake antiga ("GESTÃƒO") nunca casa
      // com o path real e não conta como cobertura.
      if (opts.configDir) {
        ensureBypassAccepted(opts.configDir, identity.cwd)
        const project = projects.get(identity.projectId)
        if (project && project.path !== identity.cwd)
          ensureBypassAccepted(opts.configDir, project.path)
      }
    } else {
      // trust/sandbox pré-gravados SEMPRE (o onboarding do codex 0.145+
      // aparece mesmo com a flag de bypass); o trust vale para o ROOT do
      // repo, então cobre também os worktrees em userData.
      const project = projects.get(identity.projectId)
      if (opts.configDir && project) ensureCodexTrust(opts.configDir, project.path)
      // Gates Codex must not inherit arbitrary MCP servers from the seat's
      // persistent CODEX_HOME. The ephemeral Synkora server is appended below.
      if (opts.configDir && (methodGoverned || accessProfile !== 'write' || sensitive)) {
        const configFile = join(opts.configDir, 'config.toml')
        args.push(
          ...codexGateMcpDisableArgs(
            existsSync(configFile) ? readFileSync(configFile, 'utf-8') : ''
          )
        )
      }
    }
    args.push(
      ...mcpPaneArgs(
        cli,
        paneId,
        token,
        effectiveStrictMcp,
        identity.cwd,
        opts.configDir,
        accessProfile,
        sensitive,
        identity.role,
        identity.taskId
      )
    )
    // Caixa-preta: papel/CLI/perfil solicitados + se a config MCP saiu de
    // verdade (ctx.mcpPort 0 = pane nasce sem tools; isso precisa aparecer).
    blackbox.record({
      cat: 'mcp',
      event: 'pane-armed',
      ids: {
        projectId: identity.projectId,
        missionId: identity.missionId,
        taskId: identity.taskId,
        paneId,
        phase: identity.phase,
        role: identity.role,
        seatId: identity.seatId
      },
      detail: {
        cli,
        accessProfile,
        strictMcp: effectiveStrictMcp,
        sensitive,
        sensitiveOverridden: sensitiveOverride || undefined,
        mcpPort: ctx.mcpPort,
        mcpConfigured: ctx.mcpPort !== 0,
        argCount: args.length
      },
      err: ctx.mcpPort === 0 ? 'servidor MCP interno ainda não estava de pé' : undefined
    })
      return { paneId, cliArgs: args }
    } catch (error) {
      hub.unregisterPane(paneId)
      paneTokens.delete(paneId)
      cleanPaneMcpFile(paneId)
      throw error
    }
  }

  // ESCALONADOR DE SPAWN (CHECK 1 adendo, 2026-08-07): abrir o projeto pedia
  // TODOS os orquestradores + PM no MESMO segundo (medido: 4 claudes às
  // 15:12:20 + 4 skill syncs + stall de 2,1s — "saio clicando as missões e
  // fica lagando"). Espaçar as respostas de paneSpec em ~350ms desfaz a
  // rajada sem mudar a decisão "orquestradores sempre vivos".
  let paneSpecStaggerUntil = 0
  async function staggerPaneSpawn(): Promise<void> {
    const MIN_GAP_MS = 350
    const now = Date.now()
    const wait = Math.max(0, paneSpecStaggerUntil - now)
    paneSpecStaggerUntil = Math.max(now, paneSpecStaggerUntil) + MIN_GAP_MS
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  }

  // SERVIDOR DE TESTE DO DONO (pedido do usuário, 2026-08-06: "quero um botão
  // que sobe o servidor pra eu testar — eu escolho a porta"): abre um PANE
  // SHELL no worktree da MISSÃO (testar a branch isolada) ou da VERSÃO
  // (testar o conjunto já integrado) com o script de runtime detectado já
  // digitado. O pane dá log visível e morte limpa (job object mata a árvore
  // ao fechar); integração/release fecham o server daquele worktree ANTES do
  // merge (processo com cwd no worktree segura arquivos no Windows).
  // 2.0 (onda C): o mesmo registro guarda o TERMINAL avulso da missão
  // (missions:shellSpec — o botão "terminal" do trilho de entrega). Ele não
  // roda script nem ocupa porta; entra aqui porque o que importa é a segunda
  // metade do contrato acima: pane com cwd DENTRO do worktree tem de morrer
  // antes do merge/release. `purpose` mantém os dois honestos — só o servidor
  // de teste aparece no mapa de portas e só ele tem comando a digitar.
  const testServerPanes = new Map<
    string,
    {
      projectId: string
      cwd: string
      command?: string
      port?: number
      label?: string
      purpose?: 'test-server' | 'mission-shell'
    }
  >()
  // Mapa de portas do harness (decisão do dono, 2026-08-07): QA e modal do
  // ▶ testar veem as MESMAS entradas — runtime de QA com a porta REAL da URL
  // anunciada; servidor de teste com a porta PEDIDA (produto pinado pode ter
  // ido para outra — o flag 'requested' mantém a honestidade).
  function harnessPortsInUse(projectId: string): PortUseEntry[] {
    const entries: PortUseEntry[] = []
    for (const runtime of activeQaRuntimes()) {
      const task = tasks.get(runtime.taskId)
      if (task && task.projectId !== projectId) continue
      entries.push({
        port: parsePortFromUrl(runtime.url),
        owner: `QA do card "${task?.title?.slice(0, 48) ?? runtime.taskId.slice(0, 8)}"`
      })
    }
    for (const [paneId, srv] of testServerPanes) {
      if (srv.projectId !== projectId) continue
      // Terminal avulso da missão não sobe servidor nenhum: anunciá-lo como
      // "porta desconhecida" seria mentira no mapa que o QA e o dono leem.
      if (srv.purpose === 'mission-shell') continue
      if (!ptys.has(paneId)) continue
      entries.push({
        port: srv.port,
        requested: srv.port !== undefined,
        owner: `servidor de teste do dono${srv.label ? ` (${srv.label.slice(0, 40)})` : ''}`
      })
    }
    // Portas CDP reservadas (Fase 4): entram no mapa mesmo antes de o app
    // subir — o pane de QA já nasceu apontando para elas, então ninguém mais
    // pode usá-las (dono×QA e QA×QA na mesma régua do resto do mapa).
    for (const { taskId, port } of qaCdpReservations()) {
      const task = tasks.get(taskId)
      if (task && task.projectId !== projectId) continue
      entries.push({
        port,
        owner: `CDP do QA do card "${task?.title?.slice(0, 48) ?? taskId.slice(0, 8)}"`
      })
    }
    return entries
  }
  function closeTestServersUnder(pathPrefix: string): void {
    const prefix = pathPrefix.toLowerCase()
    for (const [paneId, entry] of [...testServerPanes]) {
      if (!entry.cwd.toLowerCase().startsWith(prefix)) continue
      testServerPanes.delete(paneId)
      if (!ptys.has(paneId)) continue
      ptys.kill(paneId)
      ctx.pushAll('panes:closeById', entry.projectId, paneId)
      blackbox.record({
        cat: 'pane',
        event: 'test-server-closed',
        actor: 'harness',
        ids: { projectId: entry.projectId, paneId },
        reason:
          entry.purpose === 'mission-shell'
            ? 'terminal da missão fechado antes do merge/release do worktree'
            : 'servidor de teste fechado antes do merge/release do worktree'
      })
    }
  }

  // TODAS as fases rodam em PANES TUI REAIS (decisão do usuário): dev, revisão
  // e QA são o CLI de verdade, ao vivo. A orquestração é por ARQUIVOS: o dev
  // cria <id>.done ao concluir; cada gate cria <id>.<fase>.verdict contendo
  // "aprovada" ou "reprovada: motivo". O main vigia, abre/fecha os panes das
  // fases, devolve feedback ao pane do dev nos retries e faz o merge no final.
  // RunPhase / DevPaneSpec / PhaseWatch moram em phaseTypes.ts (commit 0).
  const livePaneSpecs = new Map<
    string,
    { projectId: string; taskId: string; spec: DevPaneSpec }
  >()

  // Um processo em fechamento não pode reaparecer num snapshot durante o
  // pequeno intervalo entre kill() e onExit().
  const closingPaneIds = new Set<string>()
  // Panes cujo PTY chegou a EXISTIR nesta sessão. O pty:kill TARDIO do
  // renderer (que chega depois de o main já ter matado o processo no
  // pós-report do ajudante) não pode ser confundido com "pane fechado antes
  // de iniciar" — o aviso falso "ajudante X não conseguiu abrir" chegava 1s
  // DEPOIS da conclusão entregue (bug real, diário de 2026-08-03).
  // Append-only por sessão: paneIds são UUIDs, o custo é desprezível.
  const paneEverSpawned = new Set<string>()

  /** Reverte um armamento que nunca chegou a produzir um PTY. Arquivos,
   * worktree e sessões permanecem; apenas a afirmação "está rodando" cai. */
  function rollbackFailedPaneSpawn(paneId: string, reason: string): void {
    helperOpenWatchdog.acknowledge(paneId)
    pendingPtyPreparations.delete(paneId)
    const identity = hub.identityByPane(paneId)
    livePaneSpecs.delete(paneId)
    closingPaneIds.delete(paneId)
    unregisterPane(paneId)
    paneTokens.delete(paneId)
    cleanPaneMcpFile(paneId)
    if (!identity) return

    if (identity.role === 'ajudante') {
      helperCompletions.discard(paneId)
      updateStoredHelperStatus(identity.projectId, paneId, 'interrupted')
      if (identity.delegatorPaneId) {
        hub.notifyPane(
          identity.delegatorPaneId,
          `ajudante ${paneId.slice(0, 8)} não conseguiu abrir (${reason}); nenhum processo ficou rodando`
        )
      }
    } else if (
      identity.taskId &&
      (identity.role === 'dev' || identity.role === 'review' || identity.role === 'qa')
    ) {
      const watch = ctx.phaseWatches.get(identity.taskId)
      if (watch?.paneId === paneId && watch.phase === identity.role) {
        ctx.phaseWatches.delete(identity.taskId)
        const task = tasks.get(identity.taskId)
        if (task && task.status !== 'done') {
          tasks.update(identity.taskId, {
            status: identity.role === 'qa' ? 'qa' : identity.role === 'review' ? 'execucao' : 'backlog',
            activePhase: identity.role,
            phaseState: 'interrupted',
            phaseStartedAt: undefined,
            feedback: `fase ${identity.role} não abriu (${reason}) — trabalho e conversa foram preservados para retomar o mesmo card`
          })
          hub.publish({
            projectId: identity.projectId,
            missionId: identity.missionId,
            kind: 'error',
            text: `não consegui abrir o pane ${identity.role} de "${task.title}"; retome somente esta fase do mesmo card`,
            actor: 'harness'
          })
          syncBoard(identity.projectId)
        }
      }
    }
    ctx.pushAll('panes:closeById', identity.projectId, paneId)
    ctx.pushAll('tasks:changed', identity.projectId)
  }

  /** Limpa um pane já armado que nunca ganhou PTY, sem alterar o estado do card. */
  function discardUnstartedPane(paneId: string): void {
    if (ptys.has(paneId)) return
    helperOpenWatchdog.acknowledge(paneId)
    pendingPtyPreparations.delete(paneId)
    livePaneSpecs.delete(paneId)
    closingPaneIds.delete(paneId)
    unregisterPane(paneId)
    paneTokens.delete(paneId)
    cleanPaneMcpFile(paneId)
  }

  /** Encerra um pane pelo id mesmo quando o registro do Hub ja se perdeu. */
  function terminatePaneNow(projectId: string, paneId: string): void {
    helperOpenWatchdog.acknowledge(paneId)
    pendingPtyPreparations.delete(paneId)
    const terminatingIdentity = hub.identityByPane(paneId)
    const terminatingSpec = livePaneSpecs.get(paneId)
    const terminatingTaskId = terminatingIdentity?.taskId ?? terminatingSpec?.taskId
    const terminatingRole = terminatingIdentity?.role ?? terminatingSpec?.spec.role
    if (terminatingRole === 'qa' && terminatingTaskId) stopQaRuntime(terminatingTaskId)
    const hadPty = ptys.has(paneId)
    unregisterPane(paneId)
    livePaneSpecs.delete(paneId)
    if (hadPty) {
      closingPaneIds.add(paneId)
      ptys.kill(paneId)
    } else {
      closingPaneIds.delete(paneId)
      paneTokens.delete(paneId)
      cleanPaneMcpFile(paneId)
    }
    paneSessions.delete(paneId)
    ctx.pushAll('panes:closeById', projectId, paneId)
  }

  /** Helpers pertencem ao ciclo de vida do DEV que os delegou. Se esse DEV
   * morre, não deixe escritores órfãos bloquearem ou alterarem a retomada. */
  function terminateTaskHelpers(projectId: string, taskId: string, reason: string): void {
    const helpers = hub
      .panesOf(projectId)
      .filter((pane) => pane.role === 'ajudante' && pane.taskId === taskId)
    for (const helper of helpers) {
      helperCompletions.discard(helper.paneId)
      updateStoredHelperStatus(projectId, helper.paneId, 'interrupted')
      blackbox.record({
        cat: 'pane',
        event: 'task-helper-terminated',
        actor: 'harness',
        ids: { projectId, taskId, paneId: helper.paneId },
        reason
      })
      terminatePaneNow(projectId, helper.paneId)
    }
  }

  // Um modal pode ser fechado enquanto o seed assíncrono do seat ainda está
  // em andamento. O ticket impede que a continuação abra um processo órfão.
  const pendingPtyPreparations = new Map<string, symbol>()

  /** Poller de 3s (a parte do WATCHDOG DE HELPER; fases e missões têm os
   * ticks próprios nos engines delas). panes:open é push sem ACK — uma
   * notificação perdida não pode criar escritor fantasma no Hub. */
  function tickHelperOpenWatchdog(): void {
    // Helper tambem nasce por `panes:open`, que e um push sem ACK. Uma
    // notificacao perdida nao pode criar um escritor fantasma no Hub e ocupar
    // para sempre o unico slot de delegacao do card. Reenvie uma vez; sem PTY
    // depois da segunda janela, reverta todo o armamento de forma auditada.
    for (const pending of helperOpenWatchdog.due(Date.now(), HELPER_OPEN_GRACE_MS)) {
      const identity = hub.identityByPane(pending.paneId)
      const live = livePaneSpecs.get(pending.paneId)
      if (ptys.has(pending.paneId) || paneEverSpawned.has(pending.paneId)) {
        helperOpenWatchdog.acknowledge(pending.paneId)
        continue
      }
      if (!identity || identity.role !== 'ajudante' || !live) {
        helperOpenWatchdog.acknowledge(pending.paneId)
        if (identity) rollbackFailedPaneSpawn(pending.paneId, 'armamento do ajudante perdeu a spec')
        continue
      }
      const delegatorAlive =
        !identity.delegatorPaneId || Boolean(hub.identityByPane(identity.delegatorPaneId))
      // Guard de destino: sem renderer vivo o retry seria um push para o vazio
      // gastando a única janela — o rollback auditado do fallback é o desfecho
      // certo. (F3-c2 troca este guard pelo predicado da VIEW de panes.)
      if (
        pending.action === 'retry' &&
        delegatorAlive &&
        ctx.uiSender &&
        !ctx.uiSender.isDestroyed()
      ) {
        ctx.pushAll('panes:open', live.projectId, live.taskId, live.spec)
        blackbox.record({
          cat: 'pane',
          event: 'helper-open-retried',
          actor: 'harness',
          ids: {
            projectId: identity.projectId,
            missionId: identity.missionId,
            taskId: identity.taskId,
            paneId: pending.paneId,
            role: 'ajudante'
          },
          reason: 'ajudante armado nao criou PTY apos o primeiro push; panes:open reenviado uma vez'
        })
        continue
      }
      blackbox.record({
        cat: 'pane',
        event: 'helper-open-expired',
        actor: 'harness',
        ids: {
          projectId: identity.projectId,
          missionId: identity.missionId,
          taskId: identity.taskId,
          paneId: pending.paneId,
          role: 'ajudante'
        },
        reason: delegatorAlive
          ? 'ajudante nao criou PTY depois de duas tentativas'
          : 'delegador encerrou antes de o ajudante criar PTY'
      })
      rollbackFailedPaneSpawn(
        pending.paneId,
        delegatorAlive
          ? 'o pedido de abertura se perdeu duas vezes'
          : 'o pane delegador encerrou antes do inicio'
      )
    }
  }

  return {
    // ——— estado vivo (aliases do index → getters do MainContext) ———
    livePaneSpecs,
    closingPaneIds,
    paneEverSpawned,
    pendingPtyPreparations,
    testServerPanes,
    // ——— armamento ———
    armPane,
    paneStartupDescriptor,
    staggerPaneSpawn,
    // ——— encerramento ———
    rollbackFailedPaneSpawn,
    discardUnstartedPane,
    terminatePaneNow,
    terminateTaskHelpers,
    // ——— servidor de teste do dono ———
    harnessPortsInUse,
    closeTestServersUnder,
    // ——— fatia do poller de 3s ———
    tickHelperOpenWatchdog
  }
}
