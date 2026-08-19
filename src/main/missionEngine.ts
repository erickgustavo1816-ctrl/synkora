/**
 * MISSION ENGINE — ciclo de vida de missões e fila de integração (fase 1,
 * commit 6d).
 *
 * Corpo movido VERBATIM do closure do whenReady em index.ts (cirurgia do
 * índice, docs/FASE1_MAPA_MISSIONENGINE.md). O estado do domínio
 * (integrationDrainTimers, integrationDraining) nasce AQUI; o index expõe
 * aliases para os call sites legados (onExit do PTY, boot recovery) e os
 * getters do MainContext seguem textualmente intactos.
 *
 * Contratos que este módulo NÃO pode quebrar:
 * - startMissionIntegration devolve `Promise<string>` desde a R17 (2026-08-19).
 *   As FRASES de retorno continuam sendo o contrato e NENHUMA mudou; o que
 *   mudou foi o THREAD — o caminho do ⇪ manda cada git pelo gitWorker
 *   (`gitOff`) em vez de travar o main numa rajada de spawns. O único chamador
 *   vivo é o `ipcMain.handle` de `missions:integrate` (o `invoke` do renderer
 *   sempre devolveu Promise); as tools integrate_mission/queue_missions da era
 *   F6 saíram na limpa — se alguma voltar, ela AGUARDA o retorno.
 *   pendingIntegrationApproval: ausência NUNCA é consentimento — só actor
 *   'user' enfileira (F6.9).
 * - completeMissionMerge é wrapper fino da Fase 0
 *   (mainStalls.wrap('completeMissionMerge', …)) — manter par wrapper→Inner
 *   e o rótulo idêntico, senão o ranking de stall perde a série.
 * - missionWatches/handleMissionVerdict/tickMissionWatches — o marcador de
 *   veredito do gate de integração aposentado na F6.1 — saíram na limpa F6
 *   (2026-08-17): o Map nunca teve um `.set()` em src/main.
 * - versionIsolationIsValid/releaseVersionImpl são domínio VERSÃO e ficam
 *   no index (extras) — mover inverteria o acoplamento com ipc/backlog.
 */
import { app } from 'electron'
import { join, resolve } from 'path'
import {
  alignWorktreeFromSnapshot,
  createMissionWorktree,
  createVersionWorktree,
  currentBranch,
  ensureSynkoraGitExcludes,
  gitCommitReached,
  gitHead,
  gitLocalBranchExists,
  hasGitCommit,
  initGitRepo,
  isExpectedWorktree,
  isWorktreeClean,
  missionCommits,
  missionWorkspaceSummary,
  missionWorktreeDescriptor,
  removeWorktreeAndBranch,
  resolveMissionWorkspace,
  type MissionCommit,
  type MissionWorkspaceSummary,
  type VersionBaseSyncResult
} from './worktree'
import {
  missionDeliveryFrom,
  type Mission,
  type MissionDelivery,
  type NewMission
} from './missions'
import {
  guiMissionPaneId,
  guiMissionRoleOf,
  missionConflictRecipe,
  missionIntegrationNote,
  missionIntegrationStimulus,
  missionTypeOf,
  MISSION_PLANNING_NOT_QUEUEABLE,
  MISSION_RELEASE_NOT_QUEUEABLE
} from './guiMissionContracts'
import { notifyDesktop } from './desktopNotifications'
import { type IntegrationQueueTicketView } from './integrationQueue'
import { gitOff } from './gitAsync'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { type Version } from './backlog'
import { type MainContext } from './mainContext'

/**
 * Dependências do closure do index que o domínio de missões consome e que
 * ainda não migraram para módulos próprios — todas funções de delegação,
 * nenhum let mutável (diferente do phaseEngine, nada aqui é late-bound).
 */
export interface MissionEngineExtras {
  /** `${projectId}--${missionId}` — chave do maestroStore do orquestrador. */
  orchKey(projectId: string, missionId: string): string
  /** Domínio VERSÃO — fica no index (também extra do ipc/backlog). */
  versionIsolationIsValid(
    projectPath: string,
    version: Version
  ): version is Version & { branch: string; worktree: string }
  /** Domínio backlog. */
  emitBacklogChanged(projectId: string): void
  /** Vassoura genérica do .synkora. */
  sweepProjectFiles(projectId: string, opts?: { preserveInterruptedHelpers?: boolean }): number
  /** Derruba servidor de teste com cwd sob o prefixo (antes do merge). */
  closeTestServersUnder(pathPrefix: string): void
  /** 2.0: entrega texto na CONVERSA do pane GUI (false = sem sessão viva).
   *  Late-bound no index — o registro do gui nasce depois deste engine. */
  deliverToGuiPane(paneId: string, text: string): boolean
  /** R9: NOTA visível no fio do pane — o que o DONO lê de relance. Nunca vira
   *  bolha de "VOCÊ": é o app anotando o gesto, não o dono falando. */
  noteInGuiPane(paneId: string, text: string): boolean
  /** R9: estímulo pelos BASTIDORES ao modelo do pane (o caminho do `announce`).
   *  false = sem sessão viva; a reabertura do chat re-deriva do ticket. */
  announceToGuiPane(paneId: string, text: string): boolean
  /** 2.0: encerra dev/reviewer/ajudantes GUI da missão (o worktree some). */
  killMissionGuiPanes(missionId: string): void
}

export type MissionEngine = ReturnType<typeof createMissionEngine>

export function createMissionEngine(ctx: MainContext, extras: MissionEngineExtras) {
  const {
    missions,
    projects,
    backlog,
    integrationQueue,
    maestro,
    ptys,
    blackbox,
    mainStalls,
    syncBoard,
    scheduleProgressSnapshot,
    orchPaneId,
    unregisterPane,
  } = ctx
  // hub é atribuído UMA vez, antes de o engine nascer — capturar é seguro.
  const hub = ctx.hub
  const {
    orchKey,
    versionIsolationIsValid,
    emitBacklogChanged,
    sweepProjectFiles,
    closeTestServersUnder,
    deliverToGuiPane,
    noteInGuiPane,
    announceToGuiPane,
    killMissionGuiPanes
  } = extras

  /** Missão 2.0: sem orquestrador e sem plano — o ⇪ tem caminho direto. */
  function isDirectMission(mission: Pick<Mission, 'direct'> | undefined): boolean {
    return mission?.direct === true
  }

  // ————— MISSÕES (F3.8): fluxos de trabalho com orquestrador próprio —————
  // Missão = branch/worktree isolados (com git) + pane orquestrador + tarefas
  // carimbadas. Integração = gate de review do diff completo → merge na base.

  function emitMissionsChanged(projectId: string): void {
    ctx.pushAll('missions:changed', projectId)
    scheduleProgressSnapshot()
  }

  function integrationQueueView(ticket: IntegrationQueueTicketView): {
    state: IntegrationQueueTicketView['state']
    position: number
    total: number
    lastError?: string
    owner?: 'maestro' | 'orchestrator'
  } {
    return {
      state: ticket.state,
      position: ticket.position,
      total: ticket.total,
      lastError: ticket.lastError,
      owner: ticket.block?.owner
    }
  }

  function missionsWithIntegration(projectId: string): Array<
    Mission & { integration?: ReturnType<typeof integrationQueueView> }
  > {
    const byMission = new Map(
      integrationQueue
        .listPending(projectId)
        .map((ticket) => [ticket.missionId, integrationQueueView(ticket)] as const)
    )
    return missions.list(projectId).map((mission) => ({
      ...mission,
      ...(byMission.has(mission.id) ? { integration: byMission.get(mission.id) } : {})
    }))
  }

  /**
   * Projeto sem Git ainda pode operar diretamente. Em projeto Git, porém, uma
   * missão só tem workspace quando branch e worktree formam o isolamento exato
   * que foi persistido; nunca usamos a pasta principal como fallback.
   */
  function missionWorkspacePath(projectPath: string, mission: Mission): string | undefined {
    return resolveMissionWorkspace(
      projectPath,
      mission.id,
      mission.branch,
      mission.worktree
    )
  }

  /**
   * ESPELHO ASSÍNCRONO de `missionWorkspacePath` (R17, 2026-08-19) — o par é
   * declarado: MESMA pergunta, MESMA função (`resolveMissionWorkspace`), só que
   * dentro do gitWorker. Ela sozinha vale ~6 spawns de git (hasGitCommit +
   * isExpectedWorktree), e no caminho do ⇪ isso era main thread PARADO.
   *
   * O espelho síncrono FICA porque quem o chama são costuras síncronas fora
   * desta fronteira (`proveMissionWorkspace` do ipc/missions, o
   * `missionIntegrationStatus` do MCP e a reconciliação de BOOT — boot não é
   * clique). Quem está num caminho async usa ESTE.
   */
  function missionWorkspacePathOffThread(
    projectPath: string,
    mission: Mission
  ): Promise<string | undefined> {
    return gitOff(
      'resolveMissionWorkspace',
      projectPath,
      mission.id,
      mission.branch,
      mission.worktree
    )
  }

  /** Garante branch/worktree da missão — inicializando o GIT do projeto se
   *  preciso (sem git não há isolamento; decisão: o Synkora resolve sozinho e
   *  anuncia). Também promove missões antigas criadas sem branch. */
  function ensureMissionWorktree(missionId: string): Mission | undefined {
    const mission = missions.get(missionId)
    if (!mission) return undefined
    if (mission.status === 'concluida' || mission.status === 'arquivada') return mission
    // MISSÃO DE PLANEJAMENTO (2.0) não produz código: ela roda na RAIZ e
    // entrega escrevendo plano/. Isolamento aqui criaria uma branch que
    // ninguém jamais mesclaria — e o git init automático seria um efeito
    // colateral do nada num projeto que talvez nem queira repo. A cerca fica
    // NESTA função de propósito: é o ponto único por onde todo caminho (o
    // nascimento da missão inclusive) pede worktree.
    if (missionTypeOf(mission) === 'planejamento') return mission
    const project = projects.get(mission.projectId)
    if (!project) return mission
    if (!hasGitCommit(project.path)) {
      if (!initGitRepo(project.path)) {
        hub.publish({
          projectId: mission.projectId,
          missionId: mission.id,
          kind: 'error',
          text: 'não consegui inicializar o Git; a missão foi bloqueada para não executar diretamente na pasta principal',
          actor: 'harness',
          urgent: true
        })
        return undefined
      }
      hub.publish({
        projectId: mission.projectId,
        kind: 'info',
        text: 'repo git inicializado pelo Synkora (.gitignore mínimo + commit inicial) — missões ganham branch própria',
        actor: 'harness',
        quiet: true
      })
    }
    ensureSynkoraGitExcludes(project.path)
    const expectedBranch = `mission/${mission.id.slice(0, 8)}`
    // Branch persistida com outro nome é um conflito de identidade, não uma
    // oportunidade para criar uma segunda linha de trabalho silenciosamente.
    if (mission.branch && mission.branch !== expectedBranch) return mission
    if (
      mission.branch &&
      mission.worktree &&
      isExpectedWorktree(project.path, mission.worktree, mission.branch)
    ) {
      return mission
    }
    // Registro legado sem `branch`, mas com um worktree íntegro: só completa o
    // metadado; não recria nem move a fotografia existente.
    if (
      !mission.branch &&
      mission.worktree &&
      isExpectedWorktree(project.path, mission.worktree, expectedBranch)
    ) {
      missions.update(mission.id, { branch: expectedBranch })
      return missions.get(mission.id)
    }
    if (mission.branch && gitLocalBranchExists(project.path, mission.branch) !== true) {
      // A branch registrada sumiu. Recriá-la do HEAD atual manteria o nome e
      // perderia a origem histórica — bloqueia em vez de fabricar uma.
      return mission
    }
    // Uma pasta existente que não prova a identidade esperada é preservada e
    // bloqueia o fluxo. Criar outra ao lado poderia esconder trabalho real.
    if (mission.worktree && existsSync(mission.worktree)) return mission
    const version = mission.versionId ? backlog.getVersion(mission.versionId) : undefined
    if (mission.versionId && (!version || version.projectId !== mission.projectId)) return mission
    // A branch da versão nasce ANTES da primeira missão. Assim todas as
    // missões abertas na mesma onda partem exatamente do mesmo marco, mesmo
    // quando nenhuma delas integrou ainda.
    let versionBranch: string | undefined
    if (version) {
      if (version.branch || version.worktree) {
        if (!versionIsolationIsValid(project.path, version)) {
          return mission
        }
        versionBranch = version.branch
      } else {
        if (version.deliveries.length > 0) return mission
        const versionHasExecutionHistory = missions
          .list(mission.projectId)
          .some(
            (candidate) =>
              candidate.id !== mission.id &&
              candidate.versionId === version.id &&
              (candidate.status === 'concluida' ||
                candidate.status === 'integrando' ||
                Boolean(candidate.branch) ||
                Boolean(candidate.worktree))
          )
        if (versionHasExecutionHistory) return mission
        const versionWt = createVersionWorktree(
          project.path,
          join(app.getPath('userData'), 'worktrees', mission.projectId),
          version.name,
          version.id
        )
        if (!versionWt) return mission
        backlog.setVersionBranch(version.id, versionWt.branch, versionWt.dir)
        versionBranch = versionWt.branch
      }
    }
    const base = versionBranch ?? currentBranch(project.path)
    const wt = createMissionWorktree(
      project.path,
      join(app.getPath('userData'), 'worktrees', mission.projectId),
      mission.id,
      versionBranch
    )
    if (!wt) return mission
    missions.update(mission.id, { branch: wt.branch, worktree: wt.dir, baseBranch: base })
    // sessão antiga do orquestrador (se houver) era no diretório do projeto —
    // zera para a próxima abertura nascer DENTRO do worktree da missão.
    maestro.update(orchKey(mission.projectId, mission.id), { tuiSessionId: undefined })
    return missions.get(mission.id)
  }

  /**
   * O MESMO `ensureMissionWorktree` PARA O CAMINHO DO ⇪ (R17, 2026-08-19).
   *
   * Medida do dono com os sensores armados: o clique em subir travava o main
   * em rajadas (809ms no estímulo, 1546ms no meio do run) SEM que nenhum git
   * sozinho passasse de 200ms — no Windows cada spawn de git custa ~100-180ms
   * (imposto do Defender) e a sequência SÍNCRONA nunca deixa o event loop
   * respirar. Só a abertura desta função são ~8 spawns (hasGitCommit +
   * excludes + isExpectedWorktree).
   *
   * TRANSPORTE, NÃO LÓGICA: as perguntas e a ORDEM delas são idênticas às do
   * espelho síncrono acima — hasGitCommit → excludes → identidade da branch →
   * worktree esperado. A ordem é parte do lacre: cada resposta decide a
   * pergunta seguinte, e trocar a sequência (ou paralelizar com Promise.all)
   * mudaria a decisão, não só o thread.
   *
   * O QUE NÃO É O ESTADO SAUDÁVEL cai no caminho COMPLETO síncrono de sempre —
   * projeto sem commit (git init), registro legado a promover, worktree a criar
   * ou reparar. É o mesmo padrão do `missionWorkspaceReadout` (worktree.ts):
   * atalho para o caso comum, caminho inteiro e INTOCADO para o raro. Isso
   * também é o que impede um SEGUNDO dono da verdade sobre criação de branch/
   * worktree — a decisão perigosa continua existindo em um lugar só.
   */
  async function ensureMissionWorktreeOffThread(missionId: string): Promise<Mission | undefined> {
    const mission = missions.get(missionId)
    if (!mission) return undefined
    if (mission.status === 'concluida' || mission.status === 'arquivada') return mission
    if (missionTypeOf(mission) === 'planejamento') return mission
    const project = projects.get(mission.projectId)
    if (!project) return mission
    if (await gitOff('hasGitCommit', project.path)) {
      // Recusa do excludes (.synkora versionado) PROPAGA como sempre — o
      // espelho síncrono também não a captura.
      await gitOff('ensureSynkoraGitExcludes', project.path)
      const expectedBranch = `mission/${mission.id.slice(0, 8)}`
      if (mission.branch && mission.branch !== expectedBranch) return mission
      if (
        mission.branch &&
        mission.worktree &&
        (await gitOff('isExpectedWorktree', project.path, mission.worktree, mission.branch))
      ) {
        return mission
      }
    }
    return ensureMissionWorktree(missionId)
  }

  /**
   * A BASE NUNCA FICA PARA TRÁS (rodada 7, adendo C2 — o caso das 50 mil linhas).
   *
   * Roda na CRIAÇÃO da missão, ANTES de a branch/worktree dela ser derivada da
   * base. Se a branch da versão é ancestral da main e está atrás, o motor
   * avança sozinho: fast-forward não pode perder trabalho, então não há decisão
   * a delegar. Se DIVERGIU, o motor nunca escolhe por conta própria — a missão
   * nasce da base como está e o dono recebe um advisory que nomeia as duas
   * saídas sancionadas. Falha de git também não decide nada: a missão continua
   * nascendo, com o tropeço auditado — problema de sincronia jamais impede o
   * dono de trabalhar.
   *
   * Todo o git viaja pelo gitWorker (`gitOff`) — nada de subprocesso no main
   * thread neste caminho, que é o caminho do clique de criar missão.
   */
  async function alignVersionBaseWithMain(
    projectId: string,
    versionId: string | undefined,
    actor: string,
    /** Só CORRELAÇÃO na caixa-preta: o aviso do hub fica no nível do PROJETO de
     *  propósito — a base é do projeto, e carimbá-lo com a missão faria o
     *  `purgeMissionEvents` apagar a história do repositório junto com ela. */
    missionId?: string
  ): Promise<VersionBaseSyncResult | undefined> {
    if (!versionId) return undefined
    const project = projects.get(projectId)
    if (!project) return undefined
    const version = backlog.getVersion(versionId)
    if (!version || version.projectId !== projectId) return undefined
    // Versão SEM isolamento ainda não tem base para atrasar: o worktree dela
    // nasce do HEAD da main na primeira missão, já em dia. E o namespace
    // `version/*` é a mesma cerca do isExpectedVersionWorktree — nome de branch
    // arbitrário nunca é despachado para o git a partir de um registro.
    if (!version.branch?.startsWith('version/') || !version.worktree) return undefined
    let sync: VersionBaseSyncResult
    try {
      sync = await gitOff('syncVersionBaseWithMain', project.path, version.branch)
    } catch (error) {
      blackbox.record({
        cat: 'git',
        event: 'version-base-sync-failed',
        actor,
        ids: { projectId, ...(missionId ? { missionId } : {}) },
        reason: `não consegui comparar a base ${version.branch} com a branch principal`,
        detail: { versionId: version.id, versionName: version.name, baseBranch: version.branch },
        err: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)
      })
      return undefined
    }
    const short = (sha?: string): string => (sha ? sha.slice(0, 12) : '?')
    const ids = { projectId, ...(missionId ? { missionId } : {}) }
    const detail = {
      versionId: version.id,
      versionName: version.name,
      baseBranch: sync.baseBranch,
      mainBranch: sync.mainBranch,
      ahead: sync.ahead,
      behind: sync.behind,
      checkedOut: Boolean(sync.checkedOutIn)
    }
    if (sync.outcome === 'fast-forwarded') {
      blackbox.record({
        cat: 'git',
        event: 'version-base-fastforwarded',
        actor,
        ids,
        prev: short(sync.fromSha),
        next: short(sync.toSha),
        reason: `a base ${sync.baseBranch} estava ${sync.behind ?? 0} commit(s) atrás da ${sync.mainBranch}`,
        detail
      })
      hub.publish({
        projectId,
        kind: 'info',
        text: `base da versão ${version.name} ADIANTADA até a ${sync.mainBranch} (${short(sync.fromSha)} → ${short(sync.toSha)}, ${sync.behind ?? 0} commit(s) que tinham entrado por fora do Synkora) — a missão nova já nasce em dia`,
        actor: 'harness'
      })
      return sync
    }
    if (sync.outcome === 'diverged') {
      blackbox.record({
        cat: 'git',
        event: 'version-base-diverged',
        actor,
        ids,
        prev: short(sync.fromSha),
        next: short(sync.toSha),
        reason: sync.detail ?? 'a base da versão e a branch principal divergiram',
        detail
      })
      hub.publish({
        projectId,
        kind: 'info',
        text: `a base da versão ${version.name} (${sync.baseBranch}) DIVERGIU da ${sync.mainBranch}: ${sync.ahead ?? 0} commit(s) só na base e ${sync.behind ?? 0} só na principal. A missão nasce da base como está — para alinhar, integre pela FILA (⇪) ou acerte a branch da versão à mão; avanço automático só existe quando é fast-forward`,
        actor: 'harness'
      })
      return sync
    }
    if (sync.outcome === 'blocked' || sync.outcome === 'unavailable') {
      blackbox.record({
        cat: 'git',
        event: sync.outcome === 'blocked' ? 'version-base-sync-blocked' : 'version-base-sync-failed',
        actor,
        ids,
        prev: short(sync.fromSha),
        next: short(sync.toSha),
        reason: sync.detail ?? 'não consegui avançar a base da versão',
        detail
      })
      // 'unavailable' pode ser o projeto sem a branch ainda — auditar basta.
      // 'blocked' tem obstáculo REMOVÍVEL pelo dono, então ele precisa ver.
      if (sync.outcome === 'blocked')
        hub.publish({
          projectId,
          kind: 'info',
          text: `não adiantei a base da versão ${version.name} até a ${sync.mainBranch}: ${sync.detail ?? 'o git recusou'} — a missão nasce da base como está`,
          actor: 'harness'
        })
      return sync
    }
    // 'up-to-date'/'skipped': silêncio de propósito — a base em dia é o caso
    // comum de toda missão, e barulho de rotina esconde o aviso que importa.
    return sync
  }

  async function createMissionImpl(
    projectId: string,
    input: NewMission,
    actor: string,
    reservedId?: string
  ): Promise<Mission | null> {
    const project = projects.get(projectId)
    if (!project || !input.title.trim()) return null
    const planning = missionTypeOf(input) === 'planejamento'
    const versionChoices = backlog.missionVersionChoices(projectId)
    const selectedVersion = input.versionId
      ? versionChoices.versions.find((version) => version.id === input.versionId)
      : undefined
    // The renderer only offers this list, but IPC is a trust boundary: an
    // unknown, released, foreign, or planning version must not persist.
    if (input.versionId && (planning || !selectedVersion)) return null
    // Sem versão explícita a missão cai na versão CORRENTE (aberta mais
    // antiga; sem nenhuma, "V1.0" nasce sozinha) — decisão do usuário: a tela
    // de versões precisa fazer sentido sempre; branch da versão segue lazy
    // (criada no 1º merge de missão).
    const versionId = planning
      ? undefined
      : (selectedVersion?.id ?? backlog.ensureDefaultVersion(projectId).id)
    const mission = missions.create(
      projectId,
      { ...input, versionId, title: input.title.trim() },
      reservedId
    )
    // C2 (rodada 7): a base é conferida AQUI, entre o registro da missão e a
    // derivação do worktree dela. Antes seria cedo (a versão só é resolvida
    // acima); depois seria tarde — `ensureMissionWorktree` já teria criado a
    // branch da missão a partir da base atrasada, que é exatamente o incidente.
    // A missão já está persistida: se o app cair no meio deste await, o
    // worktree continua re-derivável pelo caminho de sempre.
    if (versionId) await alignVersionBaseWithMain(projectId, versionId, actor, mission.id)
    // Missão de PLANEJAMENTO sai daqui sem branch por desenho (a cerca mora no
    // próprio ensureMissionWorktree) — nada a isolar quando o entregável é
    // plano/ na raiz.
    ensureMissionWorktree(mission.id)
    const fresh = missions.get(mission.id) ?? mission
    const naturezaNota =
      missionTypeOf(fresh) === 'planejamento'
        ? ' (planejamento: escreve plano/ na raiz do projeto, sem branch)'
        : fresh.branch
          ? ` (branch ${fresh.branch})`
          : ' (projeto sem git — roda direto no diretório)'
    // quiet: quem criou foi o usuário (ou o próprio PM) — o PM não precisa
    // comentar; ele volta a falar nos MARCOS (integrada/reprovada/arquivada).
    hub.publish({
      projectId,
      kind: 'info',
      text: `missão criada: "${fresh.title}"${naturezaNota}${fresh.scope ? ` · escopo: ${fresh.scope}` : ''}`,
      actor,
      quiet: true
    })
    emitMissionsChanged(projectId)
    syncBoard(projectId)
    return fresh
  }

  function ensureMissionVersion(
    projectId: string,
    input?: { id?: string; name?: string; theme?: string; goal?: string }
  ): { versionId?: string; name?: string; error?: string } {
    if (!input?.id && !input?.name?.trim()) return {}
    const byId = input.id ? backlog.getVersion(input.id) : undefined
    const name = input.name?.trim()
    if (byId && name && byId.name.toLocaleLowerCase('pt-BR') !== name.toLocaleLowerCase('pt-BR')) {
      return {
        error: `o id informado pertence a ${byId.name}, não a ${name}; revise a versão-alvo no plano mestre`
      }
    }
    const existing =
      byId ??
      (name
        ? backlog
            .listVersions(projectId)
            .find((version) => version.name.toLowerCase() === name.toLowerCase())
        : undefined)
    if (existing) {
      if (existing.projectId !== projectId)
        return { error: 'a versão indicada pertence a outro projeto' }
      if (existing.status === 'lancada')
        return {
          error: `a versão ${existing.name} já foi LANÇADA (read-only) — revise o roadmap para uma versão aberta`
        }
      if (input.theme || input.goal) {
        backlog.updateVersion(existing.id, {
          ...(input.theme ? { theme: input.theme } : {}),
          ...(input.goal ? { goal: input.goal } : {})
        })
      }
      emitBacklogChanged(projectId)
      return { versionId: existing.id, name: existing.name }
    }
    if (!name) return { error: `a versão id=${input.id} não existe neste projeto` }
    const invalid = backlog.validateNewVersion(projectId, name)
    if (invalid) return { error: invalid }
    const created = backlog.createVersion(projectId, {
      name,
      theme: input.theme,
      goal: input.goal
    })
    emitBacklogChanged(projectId)
    return { versionId: created.id, name: created.name }
  }

  /**
   * Reconcilia todos os registros derivados de uma missão já pousada. É
   * deliberadamente idempotente para poder rodar no clique, no boot e depois
   * de uma queda entre o merge real e a atualização dos arquivos de estado.
   */
  function reconcileConcludedMission(
    projectId: string,
    missionId: string,
    fallbackOutcome: string
  ): { ok: boolean; doneItems: number } {
    const mission = missions.get(missionId)
    if (!mission || mission.projectId !== projectId || mission.status !== 'concluida') {
      return { ok: false, doneItems: 0 }
    }
    try {
      const doneItems = backlog.completeMissionItems(missionId)
      const version = mission.versionId ? backlog.getVersion(mission.versionId) : undefined
      if (mission.versionId && (!version || version.projectId !== mission.projectId)) {
        hub.publish({
          projectId,
          kind: 'error',
          text: `a missão "${mission.title}" aponta para uma versão que não existe mais; preservei a reconciliação pendente para não avançar o mapa sem uma publicação possível`,
          actor: 'harness'
        })
        return { ok: false, doneItems }
      }
      const hadDelivery = Boolean(
        version?.deliveries.some((delivery) => delivery.missionId === missionId)
      )
      if (mission.versionId) {
        const delivered = backlog.addDelivery(mission.versionId, mission.id, mission.title)
        if (!delivered) return { ok: false, doneItems }
      }
      if (doneItems > 0 || (mission.versionId && !hadDelivery)) emitBacklogChanged(projectId)
      syncBoard(projectId)
      return { ok: true, doneItems }
    } catch (error) {
      hub.publish({
        projectId,
        kind: 'error',
        text:
          `a missão "${mission.title}" foi concluída, mas seus registros ainda precisam ser reconciliados: ` +
          (error instanceof Error ? error.message : String(error)),
        actor: 'harness'
      })
      return { ok: false, doneItems: 0 }
    }
  }

  // Missão integrada: os arquivos operacionais dela (transcripts das tarefas,
  // runs/verdicts, PLAN) morrem na hora — o gate acabou de validar o trabalho;
  // a história consolidada vive no CONTEXT.md e nas entregas da versão.
  function cleanupMissionFiles(projectId: string, missionId: string): void {
    const project = projects.get(projectId)
    if (!project) return
    try {
      ensureSynkoraGitExcludes(project.path)
    } catch {
      return
    }
    const short = missionId.slice(0, 8)
    const zap = (full: string): void => {
      try {
        unlinkSync(full)
      } catch {
        // best-effort
      }
    }
    const runsDir = join(project.path, '.synkora', 'runs')
    try {
      for (const ent of readdirSync(runsDir)) {
        if (ent.startsWith(`mission-${short}`)) zap(join(runsDir, ent))
      }
    } catch {
      // sem runs
    }
    zap(join(project.path, '.synkora', 'missions', `${short}.PLAN.md`))
  }

  const integrationDrainTimers = new Map<string, NodeJS.Timeout>()
  const integrationDraining = new Set<string>()

  interface MissionIntegrationTarget {
    kind: 'base' | 'version'
    dir: string
    branch: string
    label: string
    versionId?: string
  }

  /**
   * R17 (2026-08-19): ASSÍNCRONA porque o caminho do ⇪ passa por aqui — os
   * git dela (currentBranch, gitLocalBranchExists, createVersionWorktree,
   * isExpectedWorktree) viajam pelo gitWorker um a um, na MESMA ordem. Todos
   * os chamadores já eram assíncronos (start/run/drain), então nenhuma costura
   * síncrona precisou ser aberta para isso.
   *
   * RESÍDUO CONHECIDO: `versionIsolationIsValid` continua SÍNCRONO (~5 spawns)
   * — ele é um type predicate (`version is …`) e mora no index como extra, e
   * predicado não sobrevive a `async`. Fica para a rodada dele.
   */
  async function resolveMissionIntegrationTarget(
    project: { id: string; path: string },
    mission: Mission
  ): Promise<MissionIntegrationTarget | undefined> {
    const version = mission.versionId ? backlog.getVersion(mission.versionId) : undefined
    if (mission.versionId && (!version || version.projectId !== mission.projectId)) return undefined
    if (!version) {
      // Duas leituras de propósito (era assim antes e é fotografia, não cache).
      return {
        kind: 'base',
        dir: project.path,
        branch: mission.baseBranch ?? (await gitOff('currentBranch', project.path)) ?? 'base',
        label: mission.baseBranch ?? (await gitOff('currentBranch', project.path)) ?? 'base'
      }
    }
    let dir = version.worktree
    let branch = version.branch
    if (!version.branch && !version.worktree) {
      // VERSÃO LEGADA (criada antes de a branch de versão nascer na abertura
      // da missão) e comprovadamente VIRGEM: sem entrega registrada e sem
      // branch version/* física no repo. Criar o destino agora é a própria
      // criação lazy antiga — não existe histórico a esconder. Caso real:
      // missão de 30/07 pronta para integrar com a V1.0 sem isolamento
      // (validação ao vivo, 02/08). Qualquer outro estado segue fail-closed.
      if (version.deliveries.length > 0) return undefined
      if (
        (await gitOff('gitLocalBranchExists', project.path, `version/${version.name}`)) !== false
      ) {
        return undefined
      }
      const versionWt = await gitOff(
        'createVersionWorktree',
        project.path,
        join(app.getPath('userData'), 'worktrees', project.id),
        version.name,
        version.id
      )
      if (!versionWt) return undefined
      backlog.setVersionBranch(version.id, versionWt.branch, versionWt.dir)
      blackbox.record({
        cat: 'merge',
        event: 'version-target-created-legacy',
        ids: { projectId: project.id, missionId: mission.id, ticketId: version.id },
        actor: 'harness',
        reason: `versão legada "${version.name}" sem isolamento e sem entregas — destino criado lazy para a integração`,
        evidence: `branch ${versionWt.branch}`
      })
      hub.publish({
        projectId: project.id,
        missionId: mission.id,
        kind: 'info',
        text: `a versão ${version.name} não tinha branch própria (registro anterior à F6.1) — o destino ${versionWt.branch} foi criado agora, sem entregas anteriores a preservar`,
        actor: 'harness',
        quiet: true
      })
      dir = versionWt.dir
      branch = versionWt.branch
    } else if (!versionIsolationIsValid(project.path, version)) {
      // A integração só usa a branch de versão criada na abertura da missão;
      // reconstruir um destino aqui poderia esconder histórico perdido.
      return undefined
    }
    if (
      !dir ||
      !branch ||
      !branch.startsWith('version/') ||
      !(await gitOff('isExpectedWorktree', project.path, dir, branch))
    ) {
      return undefined
    }
    if (
      branch === mission.branch ||
      (mission.worktree &&
        resolve(dir).toLocaleLowerCase('en-US') ===
          resolve(mission.worktree).toLocaleLowerCase('en-US'))
    ) {
      return undefined
    }
    return {
      kind: 'version',
      dir,
      branch,
      label: `branch da versão ${version.name} (${branch})`,
      versionId: version.id
    }
  }

  // ————— RODADA 9 (2026-08-19): A FILA É COORDENAÇÃO, O AGENTE É O EXECUTOR —————
  //
  // Ordem do dono, verbatim: "quando eu clico em subir, o certo é avisar o
  // agente — 'tá pronto pra subir' — e o AGENTE sobe. Ele vê via MCP se tem
  // alguém na fila na frente dele; se é o próximo, ELE integra. Qualquer erro,
  // ELE arruma. NÃO pode aparecer modal 'essa missão tá sendo integrada': eu
  // preciso VER o que ele tá fazendo no chat."
  //
  // O que NÃO mudou (as cercas de autoridade/verificabilidade continuam duras):
  // só o ⇪ do dono cria ticket, a FIFO por projeto continua sendo a ordem, o
  // merge é a MESMA mecânica provada (precheck + completeMissionMerge via
  // gitWorker) e a árvore limpa/identidade do destino seguem conferidas.
  // O que mudou é QUEM aperta o gatilho: `integration_run`, chamado pelo agente.

  /** O chat de DEV da missão — o único endereço que recebe o ⇪ (o reviewer e os
   *  ajudantes nem enxergam as ferramentas de integração no catálogo). */
  function missionDevPaneId(missionId: string): string {
    return guiMissionPaneId('dev', missionId)
  }

  /** Quem está na FRENTE deste ticket, em texto que o agente lê sem decifrar. */
  function missionsAheadOf(ticket: IntegrationQueueTicketView): string[] {
    return integrationQueue
      .listPending(ticket.projectId)
      .filter((candidate) => candidate.sequence < ticket.sequence)
      .map(
        (candidate) =>
          `"${missions.get(candidate.missionId)?.title ?? candidate.missionId}" (${candidate.state})`
      )
  }

  /**
   * O ESTÍMULO DO ⇪ (I1): nota VISÍVEL no fio + texto ao MODELO pelos
   * bastidores. Nada aqui depende de entrega única — o TICKET é o registro
   * durável, e `restimulateIntegrationOnOpen` re-deriva o estímulo quando a
   * conversa abrir. Pane fechado no clique não perde o gesto: ele o recebe ao
   * reabrir.
   */
  function stimulateMissionIntegrator(
    mission: Mission,
    origin: 'user-gesture' | 'queue-advance' | 'pane-open'
  ): void {
    const ticket = integrationQueue.getByMission(mission.id)
    if (!ticket || ticket.state !== 'queued') return
    const paneId = missionDevPaneId(mission.id)
    const targetLabel = ticket.targetBranch ?? 'o destino da missão'
    const reopened = origin === 'pane-open'
    const noted = noteInGuiPane(
      paneId,
      missionIntegrationNote({
        targetLabel,
        position: ticket.position,
        total: ticket.total,
        reopened
      })
    )
    const delivered = announceToGuiPane(
      paneId,
      missionIntegrationStimulus({
        missionTitle: mission.title,
        targetLabel,
        position: ticket.position,
        total: ticket.total,
        isHead: ticket.isHead,
        ahead: missionsAheadOf(ticket),
        reopened
      })
    )
    blackbox.record({
      cat: 'queue',
      event: 'mission-integration-stimulus',
      actor: 'harness',
      ids: { projectId: mission.projectId, missionId: mission.id, paneId },
      detail: {
        origin,
        position: ticket.position,
        total: ticket.total,
        head: ticket.isHead,
        noted,
        delivered
      },
      reason: delivered
        ? 'o agente da missão recebeu o ⇪ e é o integrador'
        : 'conversa do dev fechada — o ticket segue na fila e a reabertura re-estimula'
    })
  }

  /**
   * A CONVERSA DO DEV ABRIU (I1, cauda): se existe ⇪ pendente para esta missão,
   * o estímulo é re-derivado do ticket. É a metade "re-derivável" da regra da
   * casa — nenhum passo depende de uma entrega única, e aqui não há nada a
   * persistir porque o ticket JÁ é o registro durável.
   *
   * A entrega sai NA HORA, e é seguro: o `announce` do codex AGUARDA a thread
   * nascer (`ensureThread`) e o do claude escreve numa stdin que o CLI só drena
   * depois do próprio init — diferente do prompt em ARGV, que é o caso conhecido
   * de sair antes do handshake MCP. E, mesmo que uma entrega se perca, nada
   * quebra: a nota fica no fio para o dono e o ticket continua na fila para o
   * agente reencontrar com integration_status.
   */
  function restimulateIntegrationOnOpen(paneId: string, projectId: string): void {
    if (guiMissionRoleOf(paneId) !== 'dev') return
    const ticket = integrationQueue
      .listPending(projectId)
      .find((candidate) => missionDevPaneId(candidate.missionId) === paneId)
    if (!ticket || ticket.state !== 'queued') return
    const mission = missions.get(ticket.missionId)
    if (!mission || mission.projectId !== projectId) return
    stimulateMissionIntegrator(mission, 'pane-open')
  }

  /**
   * A FILA ANDOU: retira da cabeça o que não pode mais integrar (missão
   * apagada, já concluída, arquivada) e ESTIMULA o agente da nova cabeça.
   * NUNCA mescla — desde a rodada 9 o único caminho do merge é o
   * `integration_run` chamado pelo agente.
   */
  function advanceIntegrationQueue(projectId: string): void {
    // Uma execução em voo já cuida do próprio avanço no fim (ver runMission-
    // Integration): entrar aqui no meio dela estimularia a cabeça que está
    // exatamente sendo mesclada.
    if (integrationDraining.has(projectId)) return
    let changed = false
    while (true) {
      const ticket = integrationQueue.head(projectId)
      if (!ticket) break
      const mission = missions.get(ticket.missionId)
      if (!mission || mission.projectId !== projectId || mission.status === 'concluida') {
        integrationQueue.cancel(ticket.missionId)
        changed = true
        continue
      }
      if (mission.status === 'arquivada') {
        integrationQueue.cancel(mission.id)
        changed = true
        hub.publish({
          projectId,
          kind: 'info',
          text: `retirei "${mission.title}" da fila porque a missão foi arquivada; nenhuma outra missão foi alterada`,
          actor: 'harness'
        })
        continue
      }
      stimulateMissionIntegrator(mission, 'queue-advance')
      break
    }
    if (changed) {
      emitMissionsChanged(projectId)
      syncBoard(projectId)
    }
  }

  /**
   * A fila mudou de forma (ticket novo, cancelamento, merge concluído). O nome
   * é o de sempre porque os call sites são os de sempre; o CORPO é que deixou
   * de drenar. A janela de 150ms continua agrupando: quando vários gestos caem
   * juntos, todos ganham posição antes de qualquer estímulo sair.
   */
  function scheduleIntegrationDrain(projectId: string): void {
    if (integrationDrainTimers.has(projectId) || integrationDraining.has(projectId)) return
    const timer = setTimeout(() => {
      integrationDrainTimers.delete(projectId)
      advanceIntegrationQueue(projectId)
    }, 150)
    integrationDrainTimers.set(projectId, timer)
  }

  /**
   * O ⇪ DO DONO — assíncrona desde a R17 (2026-08-19) porque TODO git deste
   * caminho passou a viajar pelo gitWorker (`gitOff`), um a um e na ordem
   * exata de antes. Nenhuma porteira mudou de conteúdo nem de lugar: tipo,
   * status, worktree provado, árvore limpa, lacre (heads), identidade do
   * destino e FIFO continuam onde estavam, na mesma sequência — a ORDEM É
   * PARTE DO LACRE (cada resposta decide a pergunta seguinte, e a fotografia
   * lida em sequência é o que o ticket sela). O que mudou é só o thread.
   */
  async function startMissionIntegration(missionId: string, actor: string): Promise<string> {
    let mission = missions.get(missionId)
    if (!mission) return 'missão não encontrada'
    const project = projects.get(mission.projectId)
    if (!project) return 'projeto não encontrado'
    const missionProjectId = mission.projectId
    const missionTitle = mission.title
    // Bloqueio de integração NUNCA é mudo (2026-08-10: o clique do dono no ⇪
    // devolvia só uma string que virava banner — zero rastro no journal e
    // cara de clique morto): todo retorno bloqueante audita na caixa-preta
    // e, quando o gesto é do DONO, o orquestrador recebe o motivo como
    // evento urgente com a receita de destravar.
    const integrateBlocked = (code: string, msg: string): string => {
      blackbox.record({
        cat: 'queue',
        event: 'mission-integrate-blocked',
        actor,
        ids: { projectId: missionProjectId, missionId },
        reason: `${code}: ${msg.slice(0, 400)}`
      })
      if (actor === 'user')
        hub.publish({
          projectId: missionProjectId,
          missionId,
          kind: 'error',
          urgent: true,
          text: `⇪ do dono BLOQUEADO em "${missionTitle}": ${msg}`,
          actor: 'harness'
        })
      return msg
    }
    // MISSÃO DE PLANEJAMENTO (2.0): a porta errada, não um bloqueio. Ela roda
    // na raiz do projeto e entrega ESCREVENDO plano/ — não existe branch para
    // mesclar nem fotografia para lacrar, então a fila não tem o que fazer com
    // ela. Fica ANTES de tudo (inclusive de 'concluida', que reconciliaria uma
    // integração que nunca houve): tipo é o fato mais fundamental da missão.
    if (missionTypeOf(mission) === 'planejamento')
      return integrateBlocked('planning-mission', MISSION_PLANNING_NOT_QUEUEABLE)
    // R10: a missão de RELEASE também é a porta errada — ela sobe a VERSÃO
    // pelas próprias ferramentas; a fila só mescla branch de missão.
    if (missionTypeOf(mission) === 'release')
      return integrateBlocked('release-mission', MISSION_RELEASE_NOT_QUEUEABLE)
    if (mission.status === 'arquivada')
      return 'a missão está ARQUIVADA — reative-a antes de pedir integração'
    if (mission.status === 'integrando') {
      const queued = integrationQueue.getByMission(missionId)
      return queued
        ? `a missão está integrando agora na cabeça da fila (#${queued.position}/${queued.total})`
        : 'a integração desta missão já está em andamento'
    }
    if (mission.status === 'concluida') {
      // Uma queda pode acontecer depois do merge real e antes da gravação do
      // mapa. Repetir integrar é também um comando de reconciliação idempotente.
      const reconciled = reconcileConcludedMission(
        mission.projectId,
        missionId,
        `Missão integrada: ${mission.title}.`
      )
      return reconciled.ok
        ? 'missão já integrada; backlog, versão e plano mestre foram reconciliados'
        : 'missão já integrada; a reconciliação ficou registrada para nova tentativa no próximo boot'
    }
    // A ÚNICA missão que existe é a 2.0: não há plano, validação humana de
    // plano nem verificação conjunta — o contrato é a conversa do dev com o
    // dono e o ⇪ é o aval. O que segue valendo (árvore limpa, heads, lacre,
    // FIFO, identidade do destino, precheck de conflito) está abaixo, e vale
    // igual para um registro pré-2.0 que ainda esteja ativo.
    // R17: as três leituras abaixo eram ~15 spawns de git SÍNCRONOS colados —
    // a rajada que virava o estol de 809ms no instante do clique. Continuam na
    // mesma ordem, sequenciais (a ORDEM é parte do lacre; `Promise.all` aqui
    // seria mudar a lógica), só que dentro do gitWorker.
    mission = (await ensureMissionWorktreeOffThread(missionId)) ?? mission
    const gitProject = await gitOff('hasGitCommit', project.path)
    const missionSource = await missionWorkspacePathOffThread(project.path, mission)
    if (!missionSource) {
      return integrateBlocked(
        'no-worktree',
        'integração bloqueada: não foi possível provar ou reanexar o worktree isolado da missão. A fila e a branch principal permaneceram intactas.'
      )
    }
    // PORTEIRA MECÂNICA DE INTEGRAÇÃO (2026-08-07): merge de missão anda SÓ
    // com gesto do DONO. Chamada de agente chegando aqui = missão validada e
    // pronta; registra a INTENÇÃO, o board pulsa, e o clique no ⇪ (actor
    // 'user') é o único caminho que executa.
    if (actor !== 'user') {
      // A porteira só anuncia "PRONTA" com a fotografia PROVADA (2026-08-10:
      // o agente registrou intenção com o head defasado, o botão pulsou e o
      // clique do dono bateu no bloqueio — botão pulsando para um clique que
      // ia falhar). Árvore suja/head defasado voltam com a receita, sem
      // registrar intenção.
      if (gitProject) {
        if ((await gitOff('isWorktreeClean', missionSource)) !== true)
          return integrateBlocked(
            'agent-dirty-tree',
            'a missão NÃO está pronta para o aval do dono: a branch tem alterações não commitadas depois dos gates — enquadre a árvore (commit auditado ou limpeza) antes de pedir integração'
          )
      }
      if (!missions.get(missionId)?.pendingIntegrationApproval) {
        missions.update(missionId, { pendingIntegrationApproval: true })
        emitMissionsChanged(mission.projectId)
        syncBoard(mission.projectId)
        hub.publish({
          projectId: mission.projectId,
          kind: 'info',
          text: `integração da missão "${mission.title}" registrada como INTENÇÃO — aguarda o AVAL do dono no botão ⇪ da missão (nada mergeia sem o clique dele)`,
          actor,
          quiet: true
        })
      }
      return (
        'a missão está PRONTA e a intenção de integração foi registrada — o botão ⇪ da missão pulsa aguardando o AVAL DO DONO; nada mergeia sem o clique dele. ' +
        'Não re-chame integrate_mission (é no-op); se o dono demorar, pergunte via ask_user e ESPERE a resposta — ausência nunca é consentimento.'
      )
    }
    if (!gitProject) {
      // sem git não há merge: concluir é só marcar.
      // R16: e não há entrega a capturar — sem commits, o `goal` é tudo o que
      // existe. `delivery` fica AUSENTE e o briefing de quem depender desta
      // missão diz isso com todas as letras, em vez de inventar um resumo.
      missions.update(missionId, { status: 'concluida', pendingIntegrationApproval: false })
      reconcileConcludedMission(
        mission.projectId,
        missionId,
        `Missão concluída: ${mission.title}.`
      )
      hub.publish({
        projectId: mission.projectId,
        kind: 'merge',
        text: `missão "${mission.title}" CONCLUÍDA (projeto sem git — sem merge)`,
        actor
      })
      emitMissionsChanged(mission.projectId)
      syncBoard(mission.projectId)
      return 'missão concluída (projeto sem git, sem merge a fazer)'
    }
    if (!mission.branch || !mission.worktree || !missionSource) {
      return integrateBlocked(
        'git-meta',
        'integração bloqueada: metadados do isolamento Git estão incompletos'
      )
    }
    if (existsSync(missionIntegrationIntentPath(project.path, missionId))) {
      return integrateBlocked(
        'intent-journal',
        'integração bloqueada: existe um journal anterior ainda não reconciliado. Reinicie o Synkora para a recuperação segura ou repare o marcador antes de tentar novamente.'
      )
    }
    const target = await resolveMissionIntegrationTarget(project, mission)
    if (!target)
      return integrateBlocked(
        'target',
        'integração bloqueada: não consegui preparar a branch de destino; a missão foi preservada'
      )
    if ((await gitOff('isWorktreeClean', missionSource)) !== true) {
      return integrateBlocked(
        'dirty-tree',
        'integração bloqueada: a branch da missão tem alterações não commitadas depois dos gates — peça ao orquestrador para enquadrar a árvore (commit auditado ou limpeza) e valide essa fotografia antes de entrar na fila'
      )
    }
    // O LACRE é fotografia LIDA EM SEQUÊNCIA: origem primeiro, destino depois,
    // como sempre foi. Duas leituras seriais, nunca em paralelo.
    const sourceHead = await gitOff('gitHead', missionSource)
    const targetHead = await gitOff('gitHead', target.dir)
    if (!sourceHead || !targetHead)
      return integrateBlocked(
        'heads',
        'integração bloqueada: não consegui identificar os commits atuais da missão e do destino'
      )
    // O AVAL do dono só se consome quando o clique ATRAVESSA todas as
    // checagens (2026-08-10: o clear precoce apagava a pulsação do botão
    // mesmo com o clique bloqueado — a intenção do agente se perdia).
    if (missions.get(missionId)?.pendingIntegrationApproval) {
      missions.update(missionId, { pendingIntegrationApproval: false })
    }

    const existing = integrationQueue.getByMission(missionId)
    if (existing?.state === 'blocked') {
      return existing.block?.owner === 'maestro'
        ? `fila pausada na posição #${existing.position}: o Maestro foi acionado e precisa registrar a estratégia de resolução antes de a missão continuar`
        : `fila pausada na posição #${existing.position}: ${existing.lastError ?? 'bloqueio operacional pendente'}`
    }
    if (existing?.state === 'sync_required') {
      if ((await gitOff('gitCommitReached', missionSource, targetHead)) !== true) {
        return `a missão mantém a posição #${existing.position} na fila e ainda precisa concluir o card de sincronização com ${target.branch}`
      }
      integrationQueue.requeueAfterSync(missionId, {
        sourceHead,
        validatedTargetHead: targetHead,
        targetBranch: target.branch,
        targetDir: resolve(target.dir)
      })
    } else if (!existing) {
      integrationQueue.enqueue({
        projectId: mission.projectId,
        missionId,
        requestedBy: actor,
        targetKind: target.kind,
        versionId: target.versionId,
        sourceHead,
        validatedTargetHead: targetHead,
        targetBranch: target.branch,
        targetDir: resolve(target.dir)
      })
      hub.publish({
        projectId: mission.projectId,
        kind: 'info',
        text: `missão "${mission.title}" entrou na fila serial de integração`,
        actor,
        quiet: true
      })
    }

    const queued = integrationQueue.getByMission(missionId)
    emitMissionsChanged(mission.projectId)
    syncBoard(mission.projectId)
    // RODADA 9: aqui morava o `scheduleIntegrationDrain` — o clique enfileirava
    // e a MÁQUINA mesclava sozinha. Agora o gesto ESTIMULA o agente da missão,
    // que enxerga a fila pelo MCP e integra quando for a cabeça. Todas as
    // porteiras acima (tipo, status, worktree, árvore limpa, heads, lacre,
    // destino) continuam exatamente onde estavam: o que mudou é só quem aperta
    // o gatilho depois delas.
    if (queued) stimulateMissionIntegrator(mission, 'user-gesture')
    return queued
      ? `missão "${mission.title}" na fila de integração: posição #${queued.position} de ${queued.total}. O ⇪ foi ENTREGUE ao agente desta missão, que integra quando chegar a vez dela — acompanhe no chat. O desenvolvimento das outras missões continua em paralelo; os merges acontecem um por vez.`
      : 'missão colocada na fila de integração'
  }

  // ————— AS DUAS FERRAMENTAS DO AGENTE INTEGRADOR (I2) —————
  //
  // Elas moram no motor, e não no `mcpApi`, porque são a MESMA mecânica que a
  // fila sempre teve — só que embrulhada num verbo que o agente pode chamar. O
  // catálogo (`mcpServer`) é uma casca fina: nenhuma decisão de integração pode
  // existir em dois lugares.

  /** Um `<sha>` legível, ou o buraco nomeado. */
  function shortSha(sha: string | undefined): string {
    return sha ? sha.slice(0, 12) : '(desconhecido)'
  }

  /**
   * `integration_status` — a FOTOGRAFIA da fila do projeto pelos olhos desta
   * missão: posição, estado, lacre, quem está na frente, o destino e a RECEITA
   * do próximo passo. Sem ticket, ela diz a verdade que protege a porteira: só
   * o ⇪ do dono cria um.
   */
  function missionIntegrationStatus(projectId: string, missionId: string): string {
    const mission = missions.get(missionId)
    const project = projects.get(projectId)
    if (!mission || !project || mission.projectId !== projectId)
      return 'não encontrei esta missão neste universo — nada a informar sobre a fila.'
    const lane = integrationQueue.listPending(projectId)
    const header =
      lane.length === 0
        ? 'FILA DE INTEGRAÇÃO deste universo: vazia.'
        : `FILA DE INTEGRAÇÃO deste universo: ${lane.length} missão(ões) esperando, uma por vez.`
    const ticket = lane.find((candidate) => candidate.missionId === missionId)
    if (!ticket) {
      return [
        header,
        `A missão "${mission.title}" NÃO tem ticket na fila.`,
        'Só o ⇪ do DONO (o botão de subir da missão, no quadro dele) cria um — você nunca se enfileira sozinho e não existe ferramenta que peça o clique por você.',
        'Se a entrega está pronta, DIGA isso a ele aqui no chat e espere: ausência de resposta nunca é consentimento.'
      ].join('\n')
    }
    const missionSource = missionWorkspacePath(project.path, mission)
    const sourceHead = missionSource ? gitHead(missionSource) : undefined
    const clean = missionSource ? isWorktreeClean(missionSource) : undefined
    const sealMoved = Boolean(ticket.sourceHead && sourceHead && sourceHead !== ticket.sourceHead)
    const targetHead = ticket.targetDir ? gitHead(ticket.targetDir) : undefined
    const ahead = missionsAheadOf(ticket)
    const lines = [
      header,
      `SEU TICKET: posição #${ticket.position} de ${ticket.total} · estado ${ticket.state}${ticket.isHead ? ' · você é a CABEÇA' : ''}`,
      `DESTINO: ${ticket.targetBranch ?? '(não registrado)'} · head atual ${shortSha(targetHead)} · head lacrado no ⇪ ${shortSha(ticket.validatedTargetHead)}`,
      `LACRE DA ENTREGA: ${shortSha(ticket.sourceHead)} · a branch da missão está em ${shortSha(sourceHead)}${sealMoved ? ' — MUDOU depois do ⇪ (o integration_run re-lacra e audita o par)' : ''}`,
      `ÁRVORE DA MISSÃO: ${clean === true ? 'limpa' : clean === false ? 'SUJA (há alterações não commitadas)' : 'não foi possível conferir'}`
    ]
    if (ticket.lastError) lines.push(`ÚLTIMA TENTATIVA: ${ticket.lastError}`)
    lines.push(
      ahead.length > 0 ? `NA SUA FRENTE: ${ahead.join(' · ')}` : 'NA SUA FRENTE: ninguém.'
    )
    lines.push(`PRÓXIMO PASSO: ${missionIntegrationNextStep(ticket, clean)}`)
    return lines.join('\n')
  }

  /** A RECEITA — uma frase, sempre acionável. Recusa sem receita é beco. */
  function missionIntegrationNextStep(
    ticket: IntegrationQueueTicketView,
    clean: boolean | undefined
  ): string {
    if (ticket.state === 'merging')
      return 'uma integração desta missão está acontecendo AGORA. Espere o desfecho — ele volta para você.'
    if (ticket.state === 'blocked' && ticket.block?.owner === 'orchestrator')
      return `o merge já está gravado no Git e o destino aguarda REPARO da máquina (${ticket.block.detail}). Não repita a integração: avise o dono para fechar o processo que segura os arquivos e reiniciar o Synkora.`
    if (ticket.state === 'blocked' || ticket.state === 'sync_required')
      return 'este ticket ficou congelado por uma era anterior do app, em que a máquina decidia. Chame integration_run: ele reabre o ticket na MESMA posição e segue com a integração.'
    if (!ticket.isHead)
      return 'ainda NÃO é a sua vez. Não chame integration_run; volte ao trabalho — o app te avisa neste chat quando a vez chegar.'
    if (clean === false)
      return 'a árvore da missão está suja: commite (ou limpe) o que sobrou no worktree e então chame integration_run.'
    return 'é a SUA VEZ: chame integration_run.'
  }

  /**
   * `integration_run` — a MECÂNICA DO DRENO para o ticket DESTA missão, e nada
   * além dele. Todas as recusas nomeiam a receita; o desfecho SEMPRE volta ao
   * agente (sucesso com shas, conflito com arquivos + movimento, ou erro
   * honesto). O ticket nunca congela num `blocked` de máquina esperando alguém:
   * ele volta para a cabeça da fila com o motivo, e quem resolve é o agente.
   */
  async function runMissionIntegration(projectId: string, missionId: string): Promise<string> {
    const project = projects.get(projectId)
    const found = missions.get(missionId)
    if (!found || !project || found.projectId !== projectId)
      return 'não encontrei esta missão neste universo — nada foi integrado.'
    if (integrationDraining.has(projectId))
      return 'já existe uma integração em andamento neste universo agora. Espere o desfecho e chame integration_status; a fila é serial de propósito.'
    const opening = integrationQueue.getByMission(missionId)
    if (!opening)
      return [
        `a missão "${found.title}" NÃO está na fila: não há integração a rodar.`,
        'Só o ⇪ do DONO cria o ticket — você nunca se enfileira sozinho. Se a entrega está pronta, diga a ele aqui no chat e espere o clique dele.'
      ].join(' ')
    if (opening.state === 'blocked' && opening.block?.owner === 'orchestrator')
      return `o merge desta missão JÁ está gravado no Git e o destino aguarda reparo (${opening.block.detail}). Repetir a integração aqui seria perigoso: avise o dono para fechar o processo que segura os arquivos e reiniciar o Synkora.`
    if (opening.state === 'blocked' || opening.state === 'sync_required') {
      // Ticket congelado pela era em que a MÁQUINA decidia a estratégia. A
      // decisão passou a ser do agente; deixá-lo parado seria um beco sem saída.
      try {
        integrationQueue.reclaimForAgent(missionId)
      } catch (error) {
        return `este ticket está num estado que a integração pelo agente não reabre (${opening.state}): ${error instanceof Error ? error.message : String(error)}. Conte ao dono o que você leu aqui em vez de tentar de novo.`
      }
      blackbox.record({
        cat: 'queue',
        event: 'mission-integration-reclaimed',
        actor: 'harness',
        ids: { projectId, missionId },
        prev: opening.state,
        next: 'queued',
        reason: `o agente reabriu um ticket congelado: ${(opening.block?.detail ?? '').slice(0, 200)}`
      })
    }
    const ticket = integrationQueue.getByMission(missionId)
    if (!ticket) return 'o ticket desta missão saiu da fila enquanto eu o lia — chame integration_status.'
    if (!ticket.isHead) {
      const ahead = missionsAheadOf(ticket)
      return [
        `ainda NÃO é a vez desta missão: você está em #${ticket.position} de ${ticket.total} na fila do universo.`,
        ahead.length > 0 ? `Na sua frente: ${ahead.join(' · ')}.` : '',
        'A fila é FIFO e serial. Não insista aqui: volte ao trabalho — o app te avisa neste chat quando a vez chegar.'
      ]
        .filter(Boolean)
        .join(' ')
    }

    integrationDraining.add(projectId)
    try {
      return await runHeadIntegration(project, missionId, ticket)
    } catch (error) {
      // Uma exceção NÃO pode virar erro de protocolo na tool: o agente
      // racionalizaria "integrei e explodiu" e contaria ao dono uma entrega que
      // talvez não tenha acontecido. Aqui ela vira desfecho legível, e o ticket
      // sai do 'merging' para a espera — senão só um reinício o destravaria.
      const detail = error instanceof Error ? error.message : String(error)
      blackbox.record({
        cat: 'queue',
        event: 'mission-integration-run-threw',
        actor: 'harness',
        ids: { projectId, missionId },
        err: detail.slice(0, 400)
      })
      try {
        integrationQueue.noteAttemptFailure(missionId, detail)
      } catch {
        // Ticket já saiu da fila (o merge pode ter fechado antes do erro).
      }
      if (missions.get(missionId)?.status === 'integrando')
        missions.update(missionId, { status: 'ativa' })
      emitMissionsChanged(projectId)
      syncBoard(projectId)
      return [
        `a integração parou com um ERRO inesperado: ${detail}`,
        'Confira o estado com integration_status antes de tentar de novo — e, se o Git já registrou algo, conte ao dono o que você viu em vez de repetir o merge às cegas.'
      ].join('\n')
    } finally {
      // Ticket que SAIU da fila (integrado, cancelado) = a fila andou. O
      // PRÓXIMO agente é estimulado pelo MESMO canal do ⇪ (I2). Sem próximo,
      // silêncio. A leitura vem antes do `delete` porque `advanceIntegration-
      // Queue` recusa entrar enquanto a trava estiver de pé.
      const moved = integrationQueue.getByMission(missionId) === undefined
      integrationDraining.delete(projectId)
      if (moved) advanceIntegrationQueue(projectId)
    }
  }

  async function runHeadIntegration(
    project: { id: string; path: string },
    missionId: string,
    ticket: IntegrationQueueTicketView
  ): Promise<string> {
    const projectId = project.id
    const paneId = missionDevPaneId(missionId)
    const stopped = (detail: string, recipe?: string): string => {
      integrationQueue.noteAttemptFailure(missionId, detail)
      if (missions.get(missionId)?.status === 'integrando')
        missions.update(missionId, { status: 'ativa' })
      emitMissionsChanged(projectId)
      syncBoard(projectId)
      blackbox.record({
        cat: 'queue',
        event: 'mission-integration-run-stopped',
        actor: 'harness',
        ids: { projectId, missionId, paneId },
        reason: detail.slice(0, 400)
      })
      return [
        `a integração NÃO rodou: ${detail}`,
        'Seu ticket continua na CABEÇA da fila (nada foi mesclado).',
        recipe ?? 'Resolva no worktree desta missão e chame integration_run de novo.'
      ].join('\n')
    }

    let mission = missions.get(missionId)
    if (!mission) return 'a missão sumiu do registro no meio da integração — nada foi mesclado.'
    if (mission.status === 'concluida') {
      integrationQueue.cancel(missionId)
      reconcileConcludedMission(projectId, missionId, `Missão integrada: ${mission.title}.`)
      emitMissionsChanged(projectId)
      return 'esta missão JÁ está integrada: retirei o ticket da fila e reconciliei os registros. Conte ao dono que não havia nada pendente.'
    }
    if (mission.status === 'arquivada') {
      integrationQueue.cancel(missionId)
      emitMissionsChanged(projectId)
      return 'esta missão está ARQUIVADA: retirei o ticket da fila e nada foi mesclado. Só o dono reativa a missão.'
    }
    // R17: mesma rajada do ⇪, mesmo remédio — gitWorker, um a um, na ordem.
    mission = (await ensureMissionWorktreeOffThread(missionId)) ?? mission
    const missionSource = await missionWorkspacePathOffThread(project.path, mission)
    if (
      !(await gitOff('hasGitCommit', project.path)) ||
      !mission.branch ||
      !mission.worktree ||
      !missionSource
    )
      return stopped(
        'não consegui provar nem reanexar a branch/worktree isolada desta missão',
        'Confira que o worktree desta missão existe e está no lugar; se ele sumiu, avise o dono — reconstruir isolamento não é decisão sua.'
      )
    if ((await gitOff('isWorktreeClean', missionSource)) !== true)
      return stopped(
        'a branch da missão tem alterações não commitadas',
        'RECEITA: commite (ou limpe) o que está solto neste worktree e chame integration_run de novo.'
      )
    const sourceHead = await gitOff('gitHead', missionSource)
    if (!sourceHead)
      return stopped('não consegui identificar o commit atual da branch desta missão')

    // RE-LACRE AUDITADO (I2): resolver conflito muda o head da missão, e o ⇪ do
    // dono autorizou a INTENÇÃO de subir, não um sha. Em vez de uma segunda
    // porteira (que exigiria um clique novo a cada rodada de conflito), o lacre
    // acompanha e o par velho→novo vira evento + nota no fio que ele lê.
    if (ticket.sourceHead !== sourceHead) {
      integrationQueue.reseal(missionId, { sourceHead })
      blackbox.record({
        cat: 'queue',
        event: 'mission-integration-resealed',
        actor: 'harness',
        ids: { projectId, missionId, paneId },
        prev: shortSha(ticket.sourceHead),
        next: shortSha(sourceHead),
        reason: ticket.lastError
          ? `a entrega avançou depois de uma tentativa: ${ticket.lastError.slice(0, 200)}`
          : 'a entrega avançou depois do ⇪ do dono'
      })
      noteInGuiPane(
        paneId,
        `⇪ re-lacrado: a entrega avançou ${shortSha(ticket.sourceHead)} → ${shortSha(sourceHead)} depois do aval do dono`
      )
    }

    const target = await resolveMissionIntegrationTarget(project, mission)
    const targetHead = target ? await gitOff('gitHead', target.dir) : undefined
    if (!target || !targetHead)
      return stopped(
        'não consegui identificar ou preparar a branch de destino',
        'Isto é estado do universo, não do seu código: conte ao dono o que apareceu aqui.'
      )
    const sameTargetDir =
      !ticket.targetDir ||
      resolve(ticket.targetDir).toLocaleLowerCase('en-US') ===
        resolve(target.dir).toLocaleLowerCase('en-US')
    if (
      ticket.targetKind !== target.kind ||
      (ticket.versionId ?? undefined) !== (target.versionId ?? undefined) ||
      (ticket.targetBranch !== undefined && ticket.targetBranch !== target.branch) ||
      !sameTargetDir
    )
      return stopped(
        `o destino mudou desde o ⇪: esperado ${ticket.targetBranch ?? ticket.targetKind} em ${ticket.targetDir ?? '(caminho legado)'}, encontrado ${target.branch} em ${target.dir}`,
        'O destino é decisão do dono (versão/base da missão): conte a ele o que mudou e espere. Não escolha outro destino sozinho.'
      )

    const targetMoved = ticket.validatedTargetHead !== targetHead
    const targetIncluded = (await gitOff('gitCommitReached', missionSource, targetHead)) === true
    if (targetMoved || !targetIncluded) {
      const pre = await gitOff(
        'missionMergePrecheck',
        project.path,
        { dir: missionSource, branch: mission.branch },
        `mission: ${mission.title}`,
        target.dir,
        sourceHead
      )
      if (!pre.ok) {
        integrationQueue.noteAttemptFailure(missionId, pre.detail)
        if (missions.get(missionId)?.status === 'integrando')
          missions.update(missionId, { status: 'ativa' })
        emitMissionsChanged(projectId)
        syncBoard(projectId)
        blackbox.record({
          cat: 'queue',
          event: 'mission-integration-conflict',
          actor: 'harness',
          ids: { projectId, missionId, paneId },
          reason: pre.detail.slice(0, 400),
          detail: { files: pre.conflictFiles?.length ?? 0 }
        })
        // O ticket fica na CABEÇA, com o motivo. Nada de `blocked`: o dono quer
        // ver o agente trabalhando, não um card esperando decisão de máquina.
        return missionConflictRecipe({
          missionTitle: mission.title,
          detail: pre.detail,
          targetBranch: target.branch,
          sourceBranch: mission.branch,
          files: pre.conflictFiles
        })
      }
      // Destino que ANDOU não vira card de sincronização: o precheck acima
      // acabou de provar que a mescla é limpa contra o destino ATUAL.
    }

    integrationQueue.beginMerge(missionId)
    missions.update(missionId, { status: 'integrando' })
    emitMissionsChanged(projectId)
    syncBoard(projectId)
    const result = await completeMissionMerge(
      projectId,
      missionId,
      target,
      targetHead,
      sourceHead
    )
    const after = missions.get(missionId)
    if (after?.status === 'concluida') {
      integrationQueue.complete(missionId)
      emitMissionsChanged(projectId)
      syncBoard(projectId)
      blackbox.record({
        cat: 'merge',
        event: 'mission-integration-run-completed',
        actor: 'harness',
        ids: { projectId, missionId, paneId },
        prev: shortSha(targetHead),
        evidence: `origem ${shortSha(sourceHead)} → ${target.branch}`
      })
      return [
        `INTEGRADA: "${mission.title}" entrou em ${target.branch}.`,
        `Origem ${shortSha(sourceHead)} sobre o destino ${shortSha(targetHead)} · ${result.detail}`,
        'O worktree e a branch desta missão foram removidos pela finalização — não tente commitar mais nada aqui.',
        'CONTE AO DONO o desfecho, em uma ou duas linhas.'
      ].join('\n')
    }
    missions.update(missionId, { status: 'ativa' })
    if (result.state === 'repair_pending') {
      // Merge JÁ gravado no Git: repetir é perigoso, e isto não é decisão de
      // estratégia — é reparo de arquivos travados no destino. É o único estado
      // que continua sendo da máquina.
      integrationQueue.requireTargetRepair(missionId, result.detail)
      emitMissionsChanged(projectId)
      syncBoard(projectId)
      return [
        `o merge de "${mission.title}" JÁ FOI GRAVADO no Git, mas os arquivos do destino aguardam reparo seguro: ${result.detail}`,
        'NÃO repita a integração. Conte ao dono: ele precisa fechar o processo que está segurando os arquivos do destino e reiniciar o Synkora, que reconcilia sozinho no boot.'
      ].join('\n')
    }
    return stopped(
      result.detail,
      `RECEITA: traga ${target.branch} para dentro de ${mission.branch} no seu worktree, resolva o que aparecer, rode os testes que cobrem o que mudou, commite e chame integration_run de novo.`
    )
  }

  /**
   * O DRENO DA ERA DA MÁQUINA — MORTO-CERCADO na rodada 9 (2026-08-19).
   *
   * Nada mais o chama: o ⇪ estimula o agente e `runMissionIntegration` é o
   * único caminho do merge. Ele fica INTACTO nesta rodada de propósito — é a
   * referência viva da mecânica que o `integration_run` embrulha (mesmas
   * checagens de fotografia, mesma identidade de destino, mesmo precheck) e a
   * rede de segurança de leitura para um estado `merging` legado que chegue de
   * um app anterior. A remoção total é rodada de higiene, não desta.
   */
  async function drainIntegrationQueue(projectId: string): Promise<void> {
    if (integrationDraining.has(projectId)) return
    integrationDraining.add(projectId)
    try {
      while (true) {
        const ticket = integrationQueue.head(projectId)
        if (!ticket || ticket.state !== 'queued') return
        let mission = missions.get(ticket.missionId)
        const project = projects.get(projectId)
        if (!mission || !project || mission.projectId !== projectId) {
          integrationQueue.cancel(ticket.missionId)
          emitMissionsChanged(projectId)
          continue
        }
        if (mission.status === 'concluida') {
          integrationQueue.cancel(mission.id)
          emitMissionsChanged(projectId)
          continue
        }
        if (mission.status === 'arquivada') {
          integrationQueue.cancel(mission.id)
          missions.update(mission.id, { status: 'arquivada' })
          hub.publish({
            projectId,
            kind: 'info',
            text: `retirei "${mission.title}" da fila porque a missão foi arquivada; nenhuma outra missão foi alterada`,
            actor: 'harness'
          })
          emitMissionsChanged(projectId)
          continue
        }
        mission = ensureMissionWorktree(mission.id) ?? mission
        const missionSource = missionWorkspacePath(project.path, mission)
        if (
          !hasGitCommit(project.path) ||
          !mission.branch ||
          !mission.worktree ||
          !missionSource
        ) {
          const detail =
            'a branch/worktree isolada da missão não pôde ser provada ou reanexada; nenhum merge foi tentado'
          const blocked = integrationQueue.block(mission.id, {
            code: 'mission_isolation_unavailable',
            owner: 'maestro',
            detail
          })
          missions.update(mission.id, { status: 'ativa' })
          emitIntegrationBlockForMaestro(blocked, mission, undefined, detail)
          return
        }

        // O ticket é uma fotografia do artefato aprovado. Nada que apareceu
        // depois (plano, card, commit ou arquivo solto) pode entrar escondido.
        // Missão 2.0 não tem plano nem verificação conjunta: o lacre que
        // sobrevive é o COMMIT (ticket.sourceHead) e a árvore limpa — as duas
        // cercas que provam que o que entra é o que o dono aprovou.
        const sourceHead = gitHead(missionSource)
        const snapshotProblems: string[] = []
        if (!ticket.sourceHead || !sourceHead)
          snapshotProblems.push('não foi possível confirmar o commit aprovado')
        else if (sourceHead !== ticket.sourceHead)
          snapshotProblems.push(
            `a branch avançou depois da autorização (${ticket.sourceHead.slice(0, 12)} → ${sourceHead.slice(0, 12)})`
          )
        if (isWorktreeClean(missionSource) !== true)
          snapshotProblems.push('há arquivos não commitados na branch da missão')
        if (snapshotProblems.length > 0) {
          const detail = snapshotProblems.join('; ')
          const blocked = integrationQueue.block(mission.id, {
            code: 'validation_snapshot_changed',
            owner: 'maestro',
            detail
          })
          missions.update(mission.id, { status: 'ativa' })
          emitIntegrationBlockForMaestro(blocked, mission, undefined, detail)
          return
        }

        // R17: o `await` aqui é só o preço de o resolvedor ter virado assíncrono
        // para o caminho do ⇪ — este dreno segue MORTO-CERCADO e síncrono no
        // resto, como a referência viva que ele é.
        const target = await resolveMissionIntegrationTarget(project, mission)
        const targetHead = target ? gitHead(target.dir) : undefined
        if (!target || !sourceHead || !targetHead) {
          integrationQueue.block(mission.id, {
            code: 'target_unavailable',
            owner: 'maestro',
            detail: 'não foi possível identificar ou preparar a branch de destino'
          })
          missions.update(mission.id, { status: 'ativa' })
          emitIntegrationBlockForMaestro(
            integrationQueue.getByMission(mission.id)!,
            mission,
            target,
            'não foi possível identificar ou preparar a branch de destino'
          )
          return
        }

        const sameTargetDir =
          !ticket.targetDir ||
          resolve(ticket.targetDir).toLocaleLowerCase('en-US') ===
            resolve(target.dir).toLocaleLowerCase('en-US')
        if (
          ticket.targetKind !== target.kind ||
          (ticket.versionId ?? undefined) !== (target.versionId ?? undefined) ||
          (ticket.targetBranch !== undefined && ticket.targetBranch !== target.branch) ||
          !sameTargetDir
        ) {
          const detail =
            `o destino mudou desde a autorização: esperado ${ticket.targetBranch ?? ticket.targetKind}` +
            ` em ${ticket.targetDir ?? '(caminho legado)'}, encontrado ${target.branch} em ${target.dir}`
          const blocked = integrationQueue.block(mission.id, {
            code: 'integration_target_changed',
            owner: 'maestro',
            detail
          })
          missions.update(mission.id, { status: 'ativa' })
          emitIntegrationBlockForMaestro(blocked, mission, target, detail)
          return
        }

        const targetMoved = ticket.validatedTargetHead !== targetHead
        const targetIncluded = gitCommitReached(missionSource, targetHead) === true
        if (targetMoved || !targetIncluded) {
          const pre = await gitOff(
            'missionMergePrecheck',
            project.path,
            { dir: missionSource, branch: mission.branch },
            `mission: ${mission.title}`,
            target.dir,
            ticket.sourceHead
          )
          missions.update(mission.id, { status: 'ativa' })
          if (!pre.ok) {
            const blocked = integrationQueue.block(mission.id, {
              code: 'merge_conflict',
              owner: 'maestro',
              detail: pre.detail
            })
            emitIntegrationBlockForMaestro(blocked, mission, target, pre.detail, pre.conflictFiles)
            return
          }
          // Destino que andou NAO vira card de sincronizacao: o precheck
          // acima acabou de provar que a mescla e limpa contra o destino
          // ATUAL. Conflito real parou no bloqueio acima, e a receita chegou
          // na conversa do dev.
        }

        integrationQueue.beginMerge(mission.id)
        missions.update(mission.id, { status: 'integrando' })
        emitMissionsChanged(projectId)
        syncBoard(projectId)
        const result = await completeMissionMerge(
          projectId,
          mission.id,
          target,
          targetHead,
          ticket.sourceHead!
        )
        const after = missions.get(mission.id)
        if (after?.status === 'concluida') {
          integrationQueue.complete(mission.id)
          emitMissionsChanged(projectId)
          continue
        }

        missions.update(mission.id, { status: 'ativa' })
        if (result.state === 'repair_pending') {
          integrationQueue.requireTargetRepair(mission.id, result.detail)
          hub.publish({
            projectId,
            kind: 'error',
            text:
              `FILA DE INTEGRAÇÃO PAUSADA em #${ticket.position}: o merge de "${mission.title}" já foi gravado, ` +
              'mas os arquivos do destino aguardam reparo seguro. Não há conflito para o Maestro decidir e a fila não tentará integrar novamente. Feche o processo que possa estar segurando os arquivos e reinicie o Synkora.',
            actor: 'harness',
            urgent: true
          })
          emitMissionsChanged(projectId)
          syncBoard(projectId)
          return
        }
        const blocked = integrationQueue.block(mission.id, {
          code: 'merge_failed',
          owner: 'maestro',
          detail: result.detail
        })
        emitIntegrationBlockForMaestro(blocked, mission, target, result.detail)
        return
      }
    } finally {
      integrationDraining.delete(projectId)
    }
  }

  function emitIntegrationBlockForMaestro(
    ticket: IntegrationQueueTicketView,
    mission: Mission,
    target: MissionIntegrationTarget | undefined,
    detail: string,
    /** Lista ESTRUTURADA vinda do merge-tree (só o bloqueio de conflito a tem);
     *  serve à notificação de desktop, que não faz parsing de prosa. */
    conflictFiles?: string[]
  ): void {
    // MISSÃO 2.0: o bloqueio volta para QUEM ESCREVEU — não há orquestrador
    // para triar nem Maestro para decidir estratégia. O evento/auditoria de
    // sempre continua saindo (o board e o journal não perdem nada); o que se
    // soma é a receita chegando na conversa viva do dev.
    if (isDirectMission(mission)) {
      const paneId = guiMissionPaneId('dev', mission.id)
      const delivered = deliverToGuiPane(
        paneId,
        missionConflictRecipe({
          missionTitle: mission.title,
          detail,
          targetBranch: target?.branch,
          sourceBranch: mission.branch
        })
      )
      blackbox.record({
        cat: 'queue',
        event: 'direct-mission-block-to-dev',
        actor: 'harness',
        ids: { projectId: mission.projectId, missionId: mission.id, paneId },
        reason: delivered
          ? `receita do bloqueio entregue na conversa do dev: ${detail.slice(0, 300)}`
          : `conversa do dev não está aberta — a receita fica no board: ${detail.slice(0, 300)}`
      })
      // ONDA D: a fila parou e o dono pode estar em outra janela. Com o app em
      // foco os sinais internos bastam — o notifyDesktop só fala fora dele.
      notifyDesktop({
        kind: 'conflict',
        key: mission.id,
        title: 'Synkora — a integração parou',
        body:
          `"${mission.title}" não integrou com ${target?.label ?? 'o destino'}` +
          (conflictFiles?.length
            ? ` · ${conflictFiles.length} arquivo(s) em conflito`
            : `: ${detail.slice(0, 120)}`)
      })
    }
    const behind = integrationQueue
      .listPending(mission.projectId)
      .filter((candidate) => candidate.sequence > ticket.sequence)
      .map((candidate) => missions.get(candidate.missionId)?.title ?? candidate.missionId)
    hub.publish({
      projectId: mission.projectId,
      kind: 'error',
      text:
        `FILA DE INTEGRAÇÃO PAUSADA em #${ticket.position}: "${mission.title}" precisa da decisão do Maestro antes de integrar com ` +
        `${target?.label ?? 'o destino'}. Detalhe: ${detail}. ` +
        `Maestro: inspecione a fotografia aprovada, o estado atual e o destino; depois chame guide_integration_resolution com a estratégia concreta.` +
        (behind.length > 0 ? ` Atrás na fila: ${behind.join(' · ')}.` : ''),
      actor: 'harness',
      urgent: true
    })
    hub.publish({
      projectId: mission.projectId,
      missionId: mission.id,
      kind: 'error',
      text: 'a fila encontrou um conflito ou mudança de segurança e pausou nesta posição. Não escolha uma estratégia sozinho: o Maestro do projeto já recebeu o contexto e enviará uma orientação persistida',
      actor: 'harness',
      urgent: true
    })
    emitMissionsChanged(mission.projectId)
    syncBoard(mission.projectId)
  }

  function missionIntegrationIntentPath(projectPath: string, missionId: string): string {
    return join(projectPath, '.synkora', 'integrations', `${missionId}.intent`)
  }

  interface MissionIntegrationIntent {
    projectId: string
    missionId: string
    sourceHead: string
    targetDir: string
    queueTicketId?: string
    targetHead: string
    targetBranch: string
    createdAt: string
  }

  /** R17: o PONTO SEGURO do merge é gravado no caminho do ⇪ (único chamador:
   *  `completeMissionMergeInner`), e as ~10 rajadas de git dele estavam no
   *  main. Agora viajam pelo gitWorker na MESMA ordem — excludes, workspace,
   *  head da origem, head e branch do destino —, e qualquer recusa continua
   *  virando exceção que o chamador transforma em `failed` sem mesclar nada. */
  async function writeMissionIntegrationIntent(
    projectPath: string,
    mission: Mission,
    targetDir: string
  ): Promise<void> {
    await gitOff('ensureSynkoraGitExcludes', projectPath)
    const sourceDir = await missionWorkspacePathOffThread(projectPath, mission)
    if (!sourceDir || !mission.branch) throw new Error('worktree isolado da missão inválido')
    const sourceHead = await gitOff('gitHead', sourceDir)
    if (!sourceHead) throw new Error('não foi possível identificar o commit da missão')
    const targetHead = await gitOff('gitHead', targetDir)
    const targetBranch = await gitOff('currentBranch', targetDir)
    if (!targetHead || !targetBranch)
      throw new Error('não foi possível identificar a fotografia da branch de destino')
    const file = missionIntegrationIntentPath(projectPath, mission.id)
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
    mkdirSync(join(projectPath, '.synkora', 'integrations'), { recursive: true })
    const intent: MissionIntegrationIntent = {
      projectId: mission.projectId,
      missionId: mission.id,
      sourceHead,
      targetDir: resolve(targetDir),
      queueTicketId: integrationQueue.getByMission(mission.id)?.id,
      targetHead,
      targetBranch,
      createdAt: new Date().toISOString()
    }
    try {
      writeFileSync(temporary, `${JSON.stringify(intent, null, 2)}\n`, 'utf8')
      renameSync(temporary, file)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // temporário nunca criado ou já promovido
      }
      throw error
    }
  }

  function clearMissionIntegrationIntent(projectPath: string, missionId: string): void {
    try {
      ensureSynkoraGitExcludes(projectPath)
      unlinkSync(missionIntegrationIntentPath(projectPath, missionId))
    } catch {
      // nunca iniciou ou já foi reconciliada
    }
  }

  // ————— R16: A ENTREGA DA MISSÃO ATRAVESSA (design de 2026-08-19) —————
  //
  // O que a missão construiu só é legível ENQUANTO branch e worktree existem —
  // a limpeza do merge leva os dois embora no mesmo gesto. Por isso a leitura
  // acontece antes, e o registro pousa junto com a conclusão. Falha de leitura
  // NUNCA segura a conclusão: a entrega é um bônus de conhecimento, não uma
  // pré-condição do merge (missão sem entrega registrada degrada honesta no
  // briefing de quem depende dela, e é isso que o contrato promete).

  /** Traduz a leitura do git na entrega + carimba a caixa-preta. Sem git aqui
   *  de propósito: quem lê é o chamador, no estilo do caminho dele. */
  function missionDeliveryOf(
    mission: Pick<Mission, 'id' | 'projectId'>,
    commits: MissionCommit[] | undefined,
    summary: MissionWorkspaceSummary | undefined
  ): MissionDelivery | undefined {
    const delivery = missionDeliveryFrom({
      capturedAt: new Date().toISOString(),
      commits: (commits ?? []).map((commit) => commit.subject),
      files: (summary?.files ?? []).map((file) => file.path),
      // `ahead` é o total REAL de commits (rev-list --count), enquanto a lista
      // de commits já vem com o teto do próprio leitor.
      totalCommits: summary?.ahead
    })
    if (delivery)
      blackbox.record({
        cat: 'merge',
        event: 'mission-delivery-captured',
        actor: 'harness',
        ids: { projectId: mission.projectId, missionId: mission.id },
        detail: {
          commits: delivery.commits.length,
          files: delivery.files.length,
          truncated: Boolean(delivery.truncated)
        }
      })
    return delivery
  }

  function noteMissionDeliveryFailure(
    mission: Pick<Mission, 'id' | 'projectId'>,
    error: unknown
  ): undefined {
    blackbox.record({
      cat: 'merge',
      event: 'mission-delivery-capture-failed',
      actor: 'harness',
      ids: { projectId: mission.projectId, missionId: mission.id },
      err: (error instanceof Error ? error.message : String(error)).slice(0, 400)
    })
    return undefined
  }

  /** O fecho do MERGE: git fora do main thread, como todo o resto deste caminho. */
  async function captureMissionDelivery(
    mission: Mission,
    workspace: string
  ): Promise<MissionDelivery | undefined> {
    try {
      const commits = await gitOff('missionCommits', workspace, mission.baseBranch)
      const summary = await gitOff('missionWorkspaceSummary', workspace, mission.baseBranch)
      return missionDeliveryOf(mission, commits, summary)
    } catch (error) {
      return noteMissionDeliveryFailure(mission, error)
    }
  }

  /** O fecho do BOOT: a reconciliação inteira é síncrona (o git dela também),
   *  e são poucas missões com marcador pendente. Worktree já removido devolve
   *  `undefined` sozinho — é a ausência honesta que o design previu. */
  function captureMissionDeliveryOnBoot(
    mission: Mission,
    workspace: string
  ): MissionDelivery | undefined {
    try {
      return missionDeliveryOf(
        mission,
        missionCommits(workspace, mission.baseBranch),
        missionWorkspaceSummary(workspace, mission.baseBranch)
      )
    } catch (error) {
      return noteMissionDeliveryFailure(mission, error)
    }
  }

  function recoverMissionIntegrationIntents(projectId: string): void {
    const project = projects.get(projectId)
    if (!project) return
    try {
      ensureSynkoraGitExcludes(project.path)
    } catch {
      return
    }
    const directory = join(project.path, '.synkora', 'integrations')
    let entries: string[] = []
    try {
      entries = readdirSync(directory).filter((entry) => entry.endsWith('.intent'))
    } catch {
      return
    }
    for (const entry of entries) {
      const missionId = entry.slice(0, -'.intent'.length)
      const mission = missions.get(missionId)
      if (!mission || mission.projectId !== projectId) {
        clearMissionIntegrationIntent(project.path, missionId)
        continue
      }
      if (mission.status === 'concluida') {
        const reconciled = reconcileConcludedMission(
          projectId,
          missionId,
          `Missão integrada: ${mission.title}.`
        )
        if (reconciled.ok) {
          clearMissionIntegrationIntent(project.path, missionId)
          integrationQueue.cancel(missionId)
        }
        continue
      }
      let intent: MissionIntegrationIntent | undefined
      try {
        const parsed = JSON.parse(readFileSync(join(directory, entry), 'utf8')) as MissionIntegrationIntent
        if (
          parsed.projectId !== projectId ||
          parsed.missionId !== missionId ||
          !/^[0-9a-f]{40,64}$/i.test(parsed.sourceHead) ||
          !/^[0-9a-f]{40,64}$/i.test(parsed.targetHead) ||
          !parsed.targetBranch?.trim() ||
          !parsed.targetDir
        ) {
          throw new Error('intent inconsistente')
        }
        intent = parsed
      } catch {
        if (integrationQueue.getByMission(missionId)) {
          integrationQueue.requireTargetRepair(
            missionId,
            'o marcador de integração está inválido; é preciso reparar ou auditar o journal antes de qualquer nova tentativa'
          )
        }
        hub.publish({
          projectId,
          kind: 'error',
          text: `o marcador de integração da missão "${mission.title}" está inválido; preservei a missão e não presumi que o merge ocorreu`,
          actor: 'harness'
        })
      }
      if (!intent) continue
      if (mission.status === 'ativa' || mission.status === 'integrando') {
        const version = mission.versionId ? backlog.getVersion(mission.versionId) : undefined
        const versionTarget =
          version &&
          version.projectId === mission.projectId &&
          versionIsolationIsValid(project.path, version)
            ? resolve(version.worktree)
            : undefined
        const expectedTarget =
          mission.versionId && (!version || version.projectId !== mission.projectId)
          ? undefined
          : version
            ? versionTarget
            : resolve(project.path)
        const mergeProven =
          intent &&
          expectedTarget &&
          resolve(intent.targetDir).toLocaleLowerCase('en-US') ===
            expectedTarget.toLocaleLowerCase('en-US') &&
          currentBranch(expectedTarget) === intent.targetBranch &&
          gitCommitReached(expectedTarget, intent.targetHead) === true &&
          gitCommitReached(expectedTarget, intent.sourceHead) === true
        if (!mergeProven) {
          const sourceBeforeMerge = missionWorkspacePath(project.path, mission)
          const safelyStillBeforeMerge = Boolean(
            expectedTarget &&
              resolve(intent.targetDir).toLocaleLowerCase('en-US') ===
                expectedTarget.toLocaleLowerCase('en-US') &&
              currentBranch(expectedTarget) === intent.targetBranch &&
              gitHead(expectedTarget) === intent.targetHead &&
              isWorktreeClean(expectedTarget) === true &&
              sourceBeforeMerge &&
              gitHead(sourceBeforeMerge) === intent.sourceHead &&
              isWorktreeClean(sourceBeforeMerge) === true
          )
          if (safelyStillBeforeMerge) {
            // O app caiu depois de gravar o intent, mas antes do CAS. Remover
            // o marcador libera a MESMA fotografia/ticket para o dreno. Se o
            // journal tinha bloqueado o ticket antes do reparo, rearma esse
            // mesmo sequence somente depois desta prova pre-CAS.
            const ticket = integrationQueue.getByMission(missionId)
            if (ticket?.state === 'blocked') {
              if (
                ticket.block?.owner !== 'orchestrator' ||
                ticket.block.code !== 'target_repair_pending'
              ) {
                continue
              }
              integrationQueue.requeueAfterTargetRepair(missionId)
            } else if (ticket && ticket.state !== 'queued' && ticket.state !== 'merging') {
              continue
            }
            clearMissionIntegrationIntent(project.path, missionId)
            continue
          }
          if (integrationQueue.getByMission(missionId)) {
            integrationQueue.requireTargetRepair(
              missionId,
              'o journal existe, mas o Git não prova nem o estado anterior nem o merge concluído; nova tentativa automática bloqueada'
            )
          }
          if (!mission.worktree || !existsSync(mission.worktree)) {
            hub.publish({
              projectId,
              kind: 'error',
              text: `o worktree da missão "${mission.title}" desapareceu, mas o Git não prova que o commit chegou ao destino; preservei o estado para reparo em vez de marcar uma entrega falsa`,
              actor: 'harness'
            })
          }
          continue
        }
        if (
          isWorktreeClean(expectedTarget) !== true &&
          !alignWorktreeFromSnapshot(expectedTarget, intent!.targetHead)
        ) {
          // O store pode ter restaurado `merging` como `queued` antes de ler o
          // intent. Grave o estado operacional ANTES do aviso/continue para o
          // dreno de boot jamais interpretar este merge já pousado como novo.
          if (integrationQueue.getByMission(missionId)) {
            integrationQueue.requireTargetRepair(
              missionId,
              'o merge está provado no Git, mas os arquivos do destino ainda não puderam ser alinhados com segurança'
            )
          }
          hub.publish({
            projectId,
            kind: 'error',
            text: `o merge da missão "${mission.title}" está provado no Git, mas os arquivos do destino ainda não puderam ser alinhados com segurança. Preservei intent, ticket e branches; feche o processo que possa estar segurando esses arquivos e reinicie o app para tentar o reparo novamente.`,
            actor: 'harness',
            urgent: true
          })
          continue
        }
        const cleanupSource = missionWorktreeDescriptor(
          join(app.getPath('userData'), 'worktrees', projectId),
          missionId
        )
        // R16 — ÚLTIMA janela para ler a entrega: a linha abaixo remove
        // worktree e branch. Se o app caiu depois da limpeza, a leitura devolve
        // ausência e a missão conclui sem entrega registrada (a verdade).
        const delivery = captureMissionDeliveryOnBoot(mission, cleanupSource.dir)
        if (
          !removeWorktreeAndBranch(
            project.path,
            cleanupSource.dir,
            cleanupSource.branch,
            intent.sourceHead
          )
        ) {
          if (integrationQueue.getByMission(missionId)) {
            integrationQueue.requireTargetRepair(
              missionId,
              'o merge está provado, mas a branch/worktree de origem ainda não pôde ser removida'
            )
          }
          hub.publish({
            projectId,
            kind: 'error',
            text: `o merge da missão "${mission.title}" está provado e o destino está alinhado, mas a limpeza da origem ficou pendente. Preservei intent, ticket e metadados para tentar novamente no próximo boot.`,
            actor: 'harness',
            urgent: true
          })
          continue
        }
        missions.update(missionId, {
          status: 'concluida',
          branch: undefined,
          worktree: undefined,
          ...(delivery ? { delivery } : {})
        })
        const reconciled = reconcileConcludedMission(
          projectId,
          missionId,
          `Missão integrada e recuperada após reinício: ${mission.title}.`
        )
        if (reconciled.ok) {
          hub.purgeMissionEvents(projectId, missionId)
          cleanupMissionFiles(projectId, missionId)
          clearMissionIntegrationIntent(project.path, missionId)
          integrationQueue.cancel(missionId)
        }
        emitMissionsChanged(projectId)
        hub.publish({
          projectId,
          kind: 'merge',
          text: `integração da missão "${mission.title}" reconciliada após uma interrupção do aplicativo`,
          actor: 'harness'
        })
      }
    }
  }

  // O MERGE da missão (caminho único da integração): mata o orquestrador,
  // mergeia na base OU na branch da versão, registra entrega, limpa arquivos
  // e avisa as outras missões. O resultado distingue falha real de um merge
  // já gravado cujo worktree ainda precisa ser alinhado; este último nunca
  // pode cair no caminho de conflito nem receber uma segunda tentativa.
  interface MissionMergeCompletion {
    state: 'completed' | 'failed' | 'repair_pending'
    detail: string
  }

  async function completeMissionMerge(
    projectId: string,
    missionId: string,
    target: MissionIntegrationTarget,
    expectedTargetHead: string,
    expectedSourceHead: string
  ): Promise<MissionMergeCompletion> {
    // Fase 0 (atribuição de stall): wrapper fino — o corpo real está no Inner.
    return mainStalls.wrap('completeMissionMerge', missionId.slice(0, 8), () =>
      completeMissionMergeInner(
        projectId,
        missionId,
        target,
        expectedTargetHead,
        expectedSourceHead
      )
    )
  }
  async function completeMissionMergeInner(
    projectId: string,
    missionId: string,
    target: MissionIntegrationTarget,
    expectedTargetHead: string,
    expectedSourceHead: string
  ): Promise<MissionMergeCompletion> {
    const mission = missions.get(missionId)
    const project = projects.get(projectId)
    if (!mission || !project)
      return { state: 'failed', detail: 'missão/projeto não encontrado' }
    // R17: a rajada do MEIO do run (1546ms medidos) começa aqui — workspace,
    // repo, identidade do destino e a fotografia pré-merge, todas em git
    // síncrono colado. Mesma ordem, mesmo conteúdo, agora no gitWorker.
    const missionSource = await missionWorkspacePathOffThread(project.path, mission)
    // Servidor de teste do dono — ou, no 2.0, o TERMINAL avulso da missão —
    // ainda rodando neste worktree seguraria arquivos durante o merge
    // (Windows). Os dois vivem no mesmo registro e caem aqui, antes de mesclar.
    if (mission.worktree) closeTestServersUnder(mission.worktree)
    if (
      !(await gitOff('hasGitCommit', project.path)) ||
      !mission.branch ||
      !mission.worktree ||
      !missionSource
    ) {
      return {
        state: 'failed',
        detail:
          'integração BLOQUEADA: a branch/worktree isolada da missão não pôde ser provada; nada foi mesclado na branch principal'
      }
    }
    // O worker já resolveu e validou este destino. Nunca o recrie pelo nome
    // aqui: renomear uma versão entre as duas etapas não pode mandar o merge
    // para uma segunda branch vazia.
    const version = mission.versionId ? backlog.getVersion(mission.versionId) : undefined
    if (
      target.kind === 'version' &&
      (!version ||
        version.projectId !== mission.projectId ||
        !versionIsolationIsValid(project.path, version) ||
        target.versionId !== version.id)
    )
      return {
        state: 'failed',
        detail: 'integração BLOQUEADA: a identidade da versão mudou depois da validação'
      }
    if (
      (target.kind === 'base' &&
        resolve(target.dir).toLocaleLowerCase('en-US') !==
          resolve(project.path).toLocaleLowerCase('en-US')) ||
      (target.kind === 'version' &&
        !(await gitOff('isExpectedWorktree', project.path, target.dir, target.branch)))
    ) {
      return {
        state: 'failed',
        detail: 'integração BLOQUEADA: o worktree de destino não corresponde ao destino validado'
      }
    }
    // A FOTOGRAFIA do instante anterior ao merge: três leituras SERIAIS, na
    // ordem de sempre (origem → head do destino → branch do destino).
    const currentSourceHead = await gitOff('gitHead', missionSource)
    const currentTargetHead = await gitOff('gitHead', target.dir)
    const currentTargetBranch = await gitOff('currentBranch', target.dir)
    if (
      currentSourceHead !== expectedSourceHead ||
      currentTargetHead !== expectedTargetHead ||
      currentTargetBranch !== target.branch
    ) {
      return {
        state: 'failed',
        detail:
          'integração BLOQUEADA: a fotografia mudou no instante anterior ao merge ' +
          `(origem ${currentSourceHead?.slice(0, 12) ?? 'indisponível'}, destino ${currentTargetHead?.slice(0, 12) ?? 'indisponível'} em ${currentTargetBranch ?? 'branch desconhecida'})`
      }
    }
    const mergeTarget = target.label
    // PRÉ-CHECAGEM antes de qualquer ação irreversível. Se uma corrida mover o
    // destino entre a checagem da fila e este ponto, não tocamos no destino:
    // a fila transforma o retorno em bloqueio e o Maestro decide a estratégia.
    // git PESADO fora do main thread (task #2): o precheck roda merge-tree e
    // commit de pendências — era parte central da "travada" de integrar.
    const pre = await gitOff(
      'missionMergePrecheck',
      project.path,
      { dir: missionSource, branch: mission.branch },
      `mission: ${mission.title}`,
      target.dir,
      expectedSourceHead
    )
    if (!pre.ok) {
      hub.publish({
        projectId,
        kind: 'error',
        text: `integração da missão "${mission.title}" BLOQUEADA: ${pre.detail}`,
        actor: 'harness'
      })
      hub.publish({
        projectId,
        missionId,
        kind: 'error',
        text: `a fila detectou um conflito antes do merge: ${pre.detail}. Não escolha a resolução sozinho; preserve a branch e aguarde a orientação persistida do Maestro`,
        actor: 'harness'
      })
      emitMissionsChanged(projectId)
      return {
        state: 'failed',
        detail: `integração BLOQUEADA: ${pre.detail} — branch preservada para a decisão do Maestro`
      }
    }
    try {
      await writeMissionIntegrationIntent(project.path, mission, target.dir)
    } catch (error) {
      return {
        state: 'failed',
        detail: `integração BLOQUEADA: não consegui gravar o ponto seguro de recuperação (${error instanceof Error ? error.message : String(error)}) — nenhuma mudança foi mesclada`
      }
    }
    // R16 — A ENTREGA É LIDA AQUI, e não lá embaixo: o `mergeTaskWorktree`
    // remove worktree e branch na limpeza dele, então depois do merge não
    // existe mais de onde ler. A fotografia fica na mão e só pousa no registro
    // se o merge pousar (merge falho não deixa entrega de missão que continua
    // viva). O precheck acima já provou origem limpa neste mesmo `sourceHead`.
    const delivery = await captureMissionDelivery(mission, missionSource)
    // merge VAI acontecer: agora sim o orquestrador aposenta — fecha o pane
    // ANTES do merge real (o worktree some na limpeza; um processo com cwd
    // nele travaria a remoção). Na missão 2.0 quem tem cwd lá dentro são os
    // panes GUI (dev, reviewer e ajudantes) — mesmo motivo, mesma hora.
    ptys.kill(orchPaneId(projectId, missionId))
    killMissionGuiPanes(missionId)
    const res = await gitOff(
      'mergeTaskWorktree',
      project.path,
      { dir: missionSource, branch: mission.branch },
      `mission: ${mission.title}`,
      target.dir,
      {
        requireCleanSource: true,
        expectedSourceHead,
        expectedTargetHead,
        expectedTargetBranch: target.branch
      }
    )
    const alignedAfterCommit =
      !res.ok && res.committed === true
        ? await gitOff('alignWorktreeFromSnapshot', target.dir, expectedTargetHead)
        : false
    const cleanedAfterAlignment = alignedAfterCommit
      ? await gitOff(
          'removeWorktreeAndBranch',
          project.path,
          missionSource,
          mission.branch,
          expectedSourceHead
        )
      : false
    const mergeOk = res.ok || (alignedAfterCommit && cleanedAfterAlignment)
    const mergeDetail = alignedAfterCommit
      ? cleanedAfterAlignment
        ? `${res.detail}; destino alinhado e origem limpa na tentativa de reparo`
        : `${res.detail}; destino alinhado, mas a limpeza da origem ficou pendente`
      : res.detail
    if (mergeOk) {
      missions.update(missionId, {
        status: 'concluida',
        branch: undefined,
        worktree: undefined,
        ...(delivery ? { delivery } : {})
      })
      const reconciled = reconcileConcludedMission(
        projectId,
        missionId,
        `Missão integrada: ${mission.title}.`
      )
      const doneItems = reconciled.doneItems
      // eventos da missão viraram lixo operacional — some do EVENTS.md; e a
      // limpeza + vassoura geral de sempre (transcripts/PLAN/helpers órfãos).
      if (reconciled.ok) {
        hub.purgeMissionEvents(projectId, missionId)
        cleanupMissionFiles(projectId, missionId)
        sweepProjectFiles(projectId)
      }
      hub.publish({
        projectId,
        kind: 'merge',
        text: `missão "${mission.title}" INTEGRADA na ${mergeTarget} (${mergeDetail})${doneItems > 0 ? ` · ${doneItems} item(ns) do backlog concluído(s)` : ''}${target.kind === 'version' ? ' — a main só recebe quando o usuário subir a versão' : ''}`,
        actor: 'harness'
      })
      // ONDA D: o merge é o marco que o dono espera de longe — avisa fora do
      // app (dentro dele o blip/board já contam). Missão 2.0 apenas: a legada
      // tem orquestrador e board próprios para narrar o desfecho.
      if (isDirectMission(mission))
        notifyDesktop({
          kind: 'merged',
          key: missionId,
          title: 'Synkora — missão integrada',
          body: `"${mission.title}" foi integrada na ${mergeTarget}`
        })
      if (target.kind === 'version') {
        // versão avançou: só as missões da MESMA versão precisam de sync
        for (const other of missions.list(projectId)) {
          if (other.id === missionId || other.status !== 'ativa' || !other.branch) continue
          if (other.versionId !== mission.versionId) continue
          hub.publish({
            projectId,
            missionId: other.id,
            kind: 'info',
            text: `a branch da versão ${version!.name} avançou (missão "${mission.title}" integrou nela). A fila verificará sua branch quando chegar sua vez e, se necessário, abrirá automaticamente um card de sincronização + testes`,
            actor: 'harness'
          })
        }
      } else {
        // base avançou: as outras missões ativas precisam trazer a base.
        for (const other of missions.list(projectId)) {
          if (other.id === missionId || other.status !== 'ativa' || !other.branch) continue
          hub.publish({
            projectId,
            missionId: other.id,
            kind: 'info',
            text: `a branch base avançou (missão "${mission.title}" foi integrada). A fila verificará sua branch quando chegar sua vez e, se necessário, abrirá automaticamente um card de sincronização + testes`,
            actor: 'harness'
          })
        }
      }
      emitMissionsChanged(projectId)
      syncBoard(projectId)
      if (reconciled.ok) clearMissionIntegrationIntent(project.path, missionId)
      return {
        state: 'completed',
        detail: `missão "${mission.title}" INTEGRADA na ${mergeTarget} (${mergeDetail})`
      }
    }
    if (!res.committed) clearMissionIntegrationIntent(project.path, missionId)
    missions.update(missionId, { status: 'ativa' })
    hub.publish({
      projectId,
      kind: 'error',
      text: res.committed
        ? `merge da missão "${mission.title}" foi gravado no Git, mas a finalização AGUARDA REPARO: ${mergeDetail}`
        : `merge da missão "${mission.title}" FALHOU: ${res.detail}`,
      actor: 'harness'
    })
    hub.publish({
      projectId,
      missionId,
      kind: 'error',
      text: res.committed
        ? `o merge exato já foi gravado, mas destino/limpeza ainda não fecharam: ${mergeDetail}. O intent e as branches foram preservados; não repita o merge`
        : `o merge atômico falhou: ${res.detail}. A branch foi preservada; a fila vai pausar e pedir ao Maestro uma estratégia antes de qualquer correção`,
      actor: 'harness'
    })
    emitMissionsChanged(projectId)
    syncBoard(projectId)
    return res.committed
      ? {
          state: 'repair_pending',
          detail: `merge GRAVADO, mas finalização aguardando reparo: ${mergeDetail} — intent preservado`
        }
      : {
          state: 'failed',
          detail: `merge FALHOU: ${res.detail} — branch preservada para a decisão do Maestro`
        }
  }

  /** Encerra os panes vivos de uma missao. `reason` continua na assinatura
   *  porque os chamadores o usam como rastro do gesto (arquivar, excluir). */
  function stopMissionExecution(projectId: string, missionId: string, reason: string): void {
    void reason
    for (const pane of hub
      .panesOf(projectId)
      .filter((candidate) => candidate.missionId === missionId)) {
      if (ptys.has(pane.paneId)) ptys.kill(pane.paneId)
      unregisterPane(pane.paneId)
      ctx.livePaneSpecs.delete(pane.paneId)
      ctx.pushAll('panes:closeById', projectId, pane.paneId)
    }
    syncBoard(projectId)
  }

  return {
    // ——— estado (nasce aqui; ctx expõe por getter via alias no index) ———
    integrationDrainTimers,
    integrationDraining,
    // ——— ciclo de vida de missão ———
    emitMissionsChanged,
    missionsWithIntegration,
    missionWorkspacePath,
    ensureMissionWorktree,
    alignVersionBaseWithMain,
    createMissionImpl,
    ensureMissionVersion,
    stopMissionExecution,
    // ——— vínculo com o plano mestre (roadmap) ———
    reconcileConcludedMission,
    // ——— fila de integração ———
    resolveMissionIntegrationTarget,
    scheduleIntegrationDrain,
    startMissionIntegration,
    // ——— rodada 9: o AGENTE é o integrador (as duas tools + o re-estímulo) ———
    missionIntegrationStatus,
    runMissionIntegration,
    restimulateIntegrationOnOpen,
    // ——— recuperação (chamada pelo boot) ———
    recoverMissionIntegrationIntents,
    // ——— tick do poller de 3s ———
  }
}
