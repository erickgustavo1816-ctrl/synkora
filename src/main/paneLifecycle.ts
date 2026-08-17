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
 * - unregisterPane/cleanPaneMcpFile/paneTokens/paneMcpFiles FICAM no index
 *   (cross-domain com o gui-planner) — o engine os lê via ctx.
 *
 * O ARMAMENTO MORREU NA LIMPA F6 (2026-08-17). `armPane`/`mcpPaneArgs` eram o
 * caminho dos panes TUI de fase (dev/review/qa/ajudante): identidade no hub,
 * perfil de permissão por papel, Playwright/test-runner por pane. Com o
 * pipeline de fases fora, restam duas famílias de pane e NENHUMA passa por
 * aqui para ganhar ferramenta: o chat GUI (missions:guiSpec → guiSessions,
 * cujo único armamento MCP é o do gui-planner, em guiPlannerMcp.ts) e o pane
 * SHELL (missions:shellSpec, panes:testServerSpec, login-<seatId>). Este
 * módulo é, hoje, o ciclo de vida do pane shell.
 */
import { resolve } from 'path'
import { isPaneStartupRole, type PaneStartupDescriptor } from './paneStartupMetrics'
import type { PaneKind } from './pty'
import type { PortUseEntry } from './portMap'
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

/**
 * Descrição de um pane que o main mandou o renderer abrir. Morava em
 * `phaseTypes.ts` com o resto da máquina de fases; sobrevive porque
 * `livePaneSpecs` — o registro de "o que está aberto agora" — é lido pelo
 * ipc/panes (panes:live), pelo ipc/history (rótulo da sessão) e pelo
 * ipc/pty (remount). O espelho no preload é `DevPaneSpec` lá também.
 */
export interface DevPaneSpec {
  /** id do pane definido pelo MAIN (o hub conhece cada pane pelo id) */
  paneId: string
  kind: 'claude' | 'codex'
  seatId: string
  model?: string
  cwd: string
  cliArgs?: string[]
  initialPrompt: string
  appendSystemPrompt?: string
  logFile: string
  title: string
  role: 'dev' | 'review' | 'qa' | 'ajudante'
  /** missão dona do pane */
  missionId?: string
  /** pane que delegou (ajudante) */
  delegatorPaneId?: string
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
   *  argumentos, token, prompt ou qualquer conteúdo do terminal.
   *  A contagem de MCP externo (Playwright/test-runner por pane) saiu na
   *  limpa F6 junto com o armamento — pane shell não recebe ferramenta. */
  function paneStartupDescriptor(req: PaneRequest): PaneStartupDescriptor {
    const identity = hub.identityByPane(req.id)
    return {
      kind: req.kind,
      // Papel de PTY apenas: identidade de chat (gui-planner) não mede partida
      // de pane — e o descritor prefere OMITIR a inventar um papel de terminal.
      ...(isPaneStartupRole(identity?.role) ? { role: identity.role } : {}),
      mode: req.kind === 'shell' ? 'shell' : 'livre',
      externalMcpCount: 0,
      hasInitialPrompt: Boolean(req.initialPrompt)
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
  // Mapa de portas do harness (decisão do dono, 2026-08-07): o modal do
  // ▶ testar mostra quem já ocupa porta — servidor de teste com a porta
  // PEDIDA (produto pinado pode ter ido para outra; o flag 'requested'
  // mantém a honestidade). As duas outras fontes do mapa original — runtime
  // de QA e reserva de porta CDP — morreram com o pipeline de fases.
  function harnessPortsInUse(projectId: string): PortUseEntry[] {
    const entries: PortUseEntry[] = []
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
    // ——— partida ———
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
