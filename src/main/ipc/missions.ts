/**
 * IPC — domínio missions (fase 1, commit 6f).
 * Missões pelo renderer: CRUD, confirmação/troca de conta do orquestrador,
 * integração (botão ⇪), a spec do pane TUI do orquestrador e — no 2.0 — as
 * duas specs do worktree: o CHAT por papel (guiSpec) e o TERMINAL avulso do
 * dono (shellSpec), que compartilham a mesma prova de isolamento. A mecânica mora
 * no missionEngine (extras.engine); o lado maestro do paneSpec
 * (resume budget/planejamento) vem do maestroEngine pelos extras, e o pane
 * lifecycle (stagger de spawn) segue no index até a obra própria.
 *
 * Corpo movido VERBATIM do whenReady do index.ts. CERCA VIVA da Fase 0:
 * register*Ipc é CHAMADO do whenReady (bloco único antes do createWindow),
 * NUNCA no import. A cerca anti-ressurreição do paneSpec
 * (orchestrator-respawn-refused-integration-in-flight) é o par do kill do
 * orquestrador feito por completeMissionMergeInner no missionEngine — os
 * dois lados vivem em módulos diferentes de propósito; o comentário no
 * handler conta a história da corrida da M02d.
 */
import { app, ipcMain } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { existsSync, unlinkSync } from 'fs'
import {
  ensureSynkoraGitExcludes,
  removeWorktreeAndBranch,
  type MissionCommit,
  type MissionCommitPatch,
  type MissionWorkspaceSummary
} from '../worktree'
import { gitOff } from '../gitAsync'
import { type Mission, type NewMission } from '../missions'
import type { Project } from '../projects'
import {
  GUI_MISSION_ROLES,
  guiMissionFirstPrompt,
  guiMissionPaneId,
  guiSeatNeedsExecutorReset,
  guiPlanningFirstPrompt,
  isGuiMissionPaneId,
  isGuiMissionRole,
  missionTypeOf,
  resumeSessionIdFor,
  routeGuiMissionPane,
  type GuiMissionRole,
  type GuiMissionWorkspace
} from '../guiMissionContracts'
import {
  isGuiPermissionMode,
  rememberedGuiExecutorValue,
  type GuiPaneSpawn,
  type GuiPermissionMode,
  type GuiSessionRegistry
} from '../guiSessions'
import { armGuiPlannerMcp, type GuiPlannerMcpDeps } from '../guiPlannerMcp'
import { armGuiDelegateMcp } from '../guiDelegateMcp'
import { guiPlannerMcpDepsFor } from '../guiPlannerArm'
import {} from '../orchestratorFlow'
import {} from '../maestro'
import {} from '../projectSecurityBaseline'
import { migrateCliSessionBetweenSeats } from '../cliSessionTransplant'
import type {} from '../hub'
import type {} from '../seats'
import type { MainContext } from '../mainContext'
import type { MissionEngine } from '../missionEngine'
import type { MaestroEngine } from '../maestroEngine'

/** Dependências do closure do index ainda não migradas (mesmo padrão dos
 * outros ipc/*). Os dois engines viajam inteiros; o lado maestro do
 * paneSpec (budget de resume + método de planejamento) vem do maestroEngine. */
export interface MissionsIpcExtras {
  engine: MissionEngine
  maestroEngine: Pick<
    MaestroEngine,
    'maestroResumeOverBudget' | 'skipMaestroResume'
  >
  /** `${projectId}--${missionId}` — chave do maestroStore do orquestrador. */
  orchKey(projectId: string, missionId: string): string
  emitBacklogChanged(projectId: string): void
  staggerPaneSpawn(): Promise<void>
  /** Registro das sessões de chat por pane (onda A) — o guiSpec consulta o
   *  resume gravado e a vaga livre do ajudante. */
  guiSessions: GuiSessionRegistry
  /** 2.0: encerra dev/reviewer/ajudantes GUI da missão (fonte única no index). */
  killMissionGuiPanes(missionId: string): void
}

/** Resposta do `missions:guiSpec` (contrato da onda B, §interface partilhada). */
export interface MissionGuiSpecResult {
  ok: boolean
  spawn?: GuiPaneSpawn
  error?: string
  /** 2.0: a missão nasce SEM conta (o modal só pergunta o título) — o chat
   *  mostra o card de escolha em vez de um erro. Herança silenciosa do seat
   *  do Maestro morreu por ordem do dono. */
  needsSeat?: boolean
}

/**
 * Spec do TERMINAL avulso da missão (2.0, onda C — o botão "terminal" do
 * trilho de entrega). É um pane SHELL cru: PowerShell no worktree, sem
 * cliArgs, sem armPane, sem MCP e sem persona — a utilidade do dono, não um
 * agente. Por isso `kind` é literal 'shell' e não há seat nenhum aqui.
 */
export interface MissionShellSpec {
  paneId: string
  kind: 'shell'
  projectId: string
  missionId: string
  cwd: string
  title: string
}

export interface MissionShellSpecResult {
  ok: boolean
  spec?: MissionShellSpec
  error?: string
}

/**
 * Resposta do `missions:workspaceFiles` (2.0, onda D, item 4 — o trilho rico).
 * Leitura PURA: nunca cria nem repara worktree (o trilho consulta com
 * frequência, e criar coisa em caminho de leitura seria efeito colateral
 * escondido). Sem worktree provado, `ok:false` com o motivo.
 */
export interface MissionWorkspaceFilesResult {
  ok: boolean
  summary?: MissionWorkspaceSummary
  error?: string
}

/**
 * Resposta do `missions:commits` — o par do workspaceFiles para o trilho: os
 * commits que a missão adicionou sobre a base, mais novos primeiro. Mesma
 * disciplina de leitura PURA (nunca cria nem repara worktree) e mesma
 * distinção honesta: `ok:true` com lista VAZIA = a missão ainda não commitou;
 * `ok:false` = não deu para ler, e o motivo vai junto.
 */
export interface MissionCommitsResult {
  ok: boolean
  commits?: MissionCommit[]
  error?: string
}

/** Resposta do patch de UM commit já pertencente ao histórico da missão.
 * O worktree é a autoridade; o renderer não pode escolher uma ref arbitrária. */
export type MissionCommitDiffResult = MissionCommitPatch

/** Teto de ajudantes GUI simultâneos por missão — o sufixo do paneId sobe até
 *  achar vaga livre; acima disto o dono fecha um antes de abrir outro. */
const MAX_MISSION_HELPERS = 8

export function registerMissionsIpc(ctx: MainContext, extras: MissionsIpcExtras): void {
  const {
    projects,
    seats,
    missions,
    backlog,
    maestro,
    integrationQueue,
    ptys,
    blackbox,
    hub,
    syncBoard,
    orchPaneId,
    unregisterPane,
  } = ctx
  const {
    engine,
    orchKey,
    emitBacklogChanged,
    staggerPaneSpawn,
    guiSessions,
    killMissionGuiPanes
  } = extras
  const { maestroResumeOverBudget, skipMaestroResume } = extras.maestroEngine
  const {
    missionsWithIntegration,
    createMissionImpl,
    emitMissionsChanged,
    ensureMissionWorktree,
    missionWorkspacePath,
    scheduleIntegrationDrain,
    startMissionIntegration,
    stopMissionExecution,
  } = engine

  /** Costura do MCP do planejador: token por pane, porta viva do ctx, e o
   *  mesmo `paneTokens` que o teardown do chat usa para revogar.
   *  FONTE ÚNICA (guiPlannerArm): o re-arme por spawn do registro de sessões
   *  usa exatamente estas deps — duas cópias foi o que deixou o respawn sem
   *  ferramentas por uma noite inteira. */
  const guiPlannerMcpDeps: GuiPlannerMcpDeps = guiPlannerMcpDepsFor(ctx)

  ipcMain.handle('missions:list', (_e, projectId: string) => missionsWithIntegration(projectId))

  // A tela recebe o mesmo recorte que o motor aceita. Versoes lancadas nunca
  // aparecem como destino de uma missao nova, e a primeira e o padrao atual.
  ipcMain.handle('missions:versionChoices', (_e, projectId: string) =>
    projects.get(projectId)
      ? backlog.missionVersionChoices(projectId)
      : { versions: [], defaultVersionId: undefined }
  )

  /**
   * SYNKORA 2.0 (onda B): missão criada PELO DONO nasce DIRETA — sem
   * orquestrador, sem plano; o chat do dev é o centro. Missão nascida por
   * agente (plano mestre, MCP) segue pelo createMissionImpl com o fluxo
   * legado intacto, e o que já existe no disco não muda de natureza.
   *
   * A CERCA GREENFIELD MORREU AQUI (2026-08-13, ordem do dono: "não consigo
   * criar missão neste projeto"). Este canal é do RENDERER — só o dono chega
   * nele —, e a recusa "missão avulsa bloqueada: este projeto novo ainda
   * segue o plano mestre" era da era F6, quando toda missão de projeto novo
   * tinha de nascer pela mão do Maestro na ordem do roadmap. No 2.0 o dono É
   * o orquestrador: ele cria missão em QUALQUER modo de projeto (greenfield
   * com plano em rascunho inclusive) e nenhum estado de plano mestre o
   * interdita. O caminho de AGENTE (create_mission / start_project_mission em
   * mcpApi/missions.ts) conserva a regra antiga de propósito — lá o roadmap
   * continua sendo a autoridade sobre o que um agente pode abrir sozinho.
   */
  ipcMain.handle('missions:create', (_e, projectId: string, input: NewMission) =>
    createMissionImpl(projectId, { ...input, direct: input.direct ?? true }, 'user')
  )

  /**
   * ISOLAMENTO PROVADO — pré-condição de tudo que abre no espaço da missão
   * (chat de qualquer papel E o terminal avulso do dono). Numa missão de DEV,
   * sem o worktree provado o pane nasceria na branch principal, que é
   * exatamente o que a missão existe para evitar. Fonte única das specs
   * abaixo: as guardas eram idênticas e divergir aqui seria abrir um caminho
   * sem cerca.
   *
   * MISSÃO DE PLANEJAMENTO é a exceção declarada: ela não produz código, então
   * não tem branch nem worktree — chamar `ensureMissionWorktree` aqui criaria
   * uma branch que ninguém jamais mesclaria. Ela roda na RAIZ do projeto, que
   * é onde plano/ mora e onde o produto inteiro pode ser lido.
   */
  function proveMissionWorkspace(
    missionId: string
  ):
    | { ok: true; mission: Mission; project: Project; cwd: string; workspace: GuiMissionWorkspace }
    | { ok: false; error: string } {
    const mission = missions.get(missionId)
    if (!mission) return { ok: false, error: 'missão não encontrada' }
    const project = projects.get(mission.projectId)
    if (!project) return { ok: false, error: 'projeto não encontrado' }
    if (!existsSync(project.path))
      return { ok: false, error: 'a pasta do projeto não existe mais — relocalize o universo' }
    if (mission.status === 'concluida' || mission.status === 'arquivada')
      return { ok: false, error: 'esta missão já foi encerrada' }
    if (mission.status === 'integrando')
      return { ok: false, error: 'a missão está integrando agora — o worktree some no merge' }
    if (missionTypeOf(mission) === 'planejamento')
      return { ok: true, mission, project, cwd: project.path, workspace: 'project-root' }
    const withWorktree = ensureMissionWorktree(missionId) ?? mission
    const cwd = missionWorkspacePath(project.path, withWorktree)
    if (!cwd)
      return {
        ok: false,
        error:
          'não consegui provar o worktree isolado desta missão; nada foi aberto na branch principal'
      }
    return { ok: true, mission: withWorktree, project, cwd, workspace: 'worktree' }
  }

  /**
   * Briefing do 1º turno da MISSÃO DE PLANEJAMENTO. Mesma régua do convite que
   * a coluna "✦ geral" usava (projeto + versão aberta + plano/roadmap.md já
   * existir), somada ao RECORTE que o dono escreveu ao criar a missão — o
   * convite genérico não tinha isso, a missão tem, e abrir o chat ignorando o
   * que ele acabou de pedir seria jogar fora a única instrução que já existe.
   */
  function planningMissionFirstPrompt(mission: Mission, project: Project): string {
    const openVersion = backlog
      .listVersions(mission.projectId)
      .filter((v) => v.status === 'aberta')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
    return guiPlanningFirstPrompt({
      projectName: project.name,
      versionName: openVersion?.name,
      roadmapExists: existsSync(join(project.path, 'plano', 'roadmap.md')),
      focus: [mission.title, mission.goal?.trim()].filter(Boolean).join('\n')
    })
  }

  /**
   * DIFF VIVO DA MISSÃO (2.0, onda D): o cabeçalho do trilho de entrega —
   * commits à frente da base, +N/−M e a lista de arquivos por status. Todo o
   * git viaja pelo gitWorker: é leitura barata, mas é leitura CHAMADA MUITAS
   * VEZES, e nada de git roda no main thread desde a F6.7.
   */
  ipcMain.handle(
    'missions:workspaceFiles',
    async (_e, missionId: string): Promise<MissionWorkspaceFilesResult> => {
      const mission = missions.get(missionId)
      if (!mission) return { ok: false, error: 'missão não encontrada' }
      const project = projects.get(mission.projectId)
      if (!project) return { ok: false, error: 'projeto não encontrado' }
      // Leitura NUNCA cria worktree (nem chama ensureMissionWorktree): missão
      // concluída/arquivada simplesmente não tem mais o que mostrar.
      if (!mission.worktree || !existsSync(mission.worktree))
        return { ok: false, error: 'esta missão não tem worktree aberto' }
      const summary = await gitOff('missionWorkspaceSummary', mission.worktree, mission.baseBranch)
      if (!summary) return { ok: false, error: 'não consegui ler o diff do worktree desta missão' }
      return { ok: true, summary }
    }
  )

  /**
   * COMMITS DA MISSÃO — o histórico que o trilho mostra ao lado do diff vivo:
   * o que esta branch adicionou sobre a base, mais novos primeiro. Irmão do
   * workspaceFiles em tudo (leitura pura, nunca cria worktree, todo o git pelo
   * gitWorker): o `ahead` de lá é o número, isto é a lista por trás dele.
   */
  ipcMain.handle(
    'missions:commits',
    async (_e, missionId: string): Promise<MissionCommitsResult> => {
      const mission = missions.get(missionId)
      if (!mission) return { ok: false, error: 'missão não encontrada' }
      const project = projects.get(mission.projectId)
      if (!project) return { ok: false, error: 'projeto não encontrado' }
      if (!mission.worktree || !existsSync(mission.worktree))
        return { ok: false, error: 'esta missão não tem worktree aberto' }
      const commits = await gitOff('missionCommits', mission.worktree, mission.baseBranch)
      // Lista vazia é resposta BOA (missão sem commit ainda); só `undefined`
      // significa que a leitura falhou — o `!commits` cobriria os dois.
      if (!commits) return { ok: false, error: 'não consegui ler os commits desta missão' }
      return { ok: true, commits }
    }
  )

  /**
   * PATCH DE UM COMMIT DA MISSÃO — somente leitura. O SHA chega do renderer
   * apenas como pedido; o worker exige formato completo, prova que o objeto
   * está em `base..HEAD` desta missão e só então produz o patch contra o
   * primeiro pai. Um SHA de outra branch/repo ou abreviado é recusado.
   */
  ipcMain.handle(
    'missions:commitDiff',
    async (
      _e,
      missionId: string,
      commitSha: string
    ): Promise<MissionCommitDiffResult> => {
      const mission = missions.get(missionId)
      if (!mission) return { ok: false, error: 'missão não encontrada' }
      const project = projects.get(mission.projectId)
      if (!project) return { ok: false, error: 'projeto não encontrado' }
      if (!mission.worktree || !existsSync(mission.worktree))
        return { ok: false, error: 'esta missão não tem worktree aberto' }
      try {
        return await gitOff('missionCommitPatch', mission.worktree, mission.baseBranch, commitSha)
      } catch {
        return { ok: false, error: 'não consegui ler o patch deste commit' }
      }
    }
  )

  /**
   * TERMINAL AVULSO DA MISSÃO (2.0, onda C): o botão "terminal" do trilho de
   * entrega. Pane SHELL cru no worktree — PowerShell e mais nada: sem
   * cliArgs, sem armPane, sem token/identidade no hub, sem config MCP e sem
   * persona. O pty:create reconhece `kind === 'shell'` e nem cobra identidade.
   *
   * O pane entra no registro dos servidores de teste (com purpose próprio):
   * não é para o mapa de portas — é porque processo com cwd DENTRO do
   * worktree segura arquivos no Windows, e `closeTestServersUnder` é quem
   * fecha esses panes antes do merge/release. Terminal esquecido aberto não
   * pode travar a integração da missão.
   */
  ipcMain.handle('missions:shellSpec', (_e, missionId: string): MissionShellSpecResult => {
    const proved = proveMissionWorkspace(missionId)
    if (!proved.ok) return { ok: false, error: proved.error }
    const { mission, cwd } = proved
    const paneId = randomUUID()
    const title = `>_ ${mission.title.slice(0, 26)}`
    ctx.testServerPanes.set(paneId, {
      projectId: mission.projectId,
      cwd,
      label: mission.title,
      purpose: 'mission-shell'
    })
    blackbox.record({
      cat: 'pane',
      event: 'mission-shell-open',
      actor: 'user',
      ids: { projectId: mission.projectId, missionId, paneId },
      reason: `terminal da missão "${mission.title}" aberto em ${cwd}`
    })
    // F3-c3: TODO nascimento de pane viaja por evento do main — as duas views
    // populam a lista (o host como espelho, a view de panes MONTA). O
    // renderer não chama addPane: ele só navega para a aba Panes.
    ctx.pushAll('panes:open-free', mission.projectId, 'shell', {
      id: paneId,
      title,
      cwd,
      missionId
    })
    return {
      ok: true,
      spec: { paneId, kind: 'shell', projectId: mission.projectId, missionId, cwd, title }
    }
  })

  /**
   * SPEC DO PANE GUI DA MISSÃO (2.0 — docs/PLANO_2_0_GUI.md, onda B).
   * Dev, reviewer e ajudante são conversas no MESMO worktree, com contrato
   * curto por papel. O paneId é determinístico (guiMissionContracts) porque é
   * ele que endereça o resume gravado pelo guiSessions — reabrir a missão
   * precisa cair na MESMA conversa, não numa em branco.
   *
   * `permissionMode` (onda D) é o seletor do composer: ausente = a ÚLTIMA
   * escolha gravada para este pane (reabrir a missão mantém o modo do dono),
   * e só depois o padrão do binário.
   *
   * MISSÃO DE PLANEJAMENTO entra pelo MESMO canal e no MESMO endereço
   * (`gui-dev-<id8>` — uma conversa por missão, um resume por missão), só que
   * com o contrato do planejador e a raiz do projeto como cwd. Quem decide é
   * `routeGuiMissionPane`, puro e testado: o handler só obedece.
   */
  ipcMain.handle(
    'missions:guiSpec',
    async (
      _e,
      missionId: string,
      role: GuiMissionRole,
      permissionMode?: GuiPermissionMode
    ): Promise<MissionGuiSpecResult> => {
      if (!isGuiMissionRole(role)) return { ok: false, error: `papel desconhecido: ${String(role)}` }
      if (permissionMode !== undefined && !isGuiPermissionMode(permissionMode))
        return { ok: false, error: `modo de permissão desconhecido: ${String(permissionMode)}` }
      // Mesmo escalonador do paneSpec (F6.10): reabrir a missão pode pedir
      // dev + reviewer + ajudantes na mesma batida, e 4 CLIs no mesmo segundo
      // era a rajada que travava o main. Único await do handler — todo o resto
      // abaixo é síncrono, então não há janela para o estado envelhecer.
      await staggerPaneSpawn()
      const proved = proveMissionWorkspace(missionId)
      if (!proved.ok) return { ok: false, error: proved.error }
      // `mission` já vem com o worktree provado quando é missão de dev; na de
      // planejamento vem como está, porque worktree ela não tem.
      const { mission, project, cwd } = proved
      // Roteamento por TIPO antes de qualquer coisa nascer. Missão de
      // planejamento não abre reviewer nem ajudante — e a recusa chega aqui,
      // sem worktree criado e sem sessão gasta.
      const route = routeGuiMissionPane(mission, role)
      if (!route.ok) return { ok: false, error: route.error }

      // CONTA DA CONVERSA (2.0): missão DIRETA só usa a conta que o dono
      // escolheu PARA ELA — herdar o seat do Maestro em silêncio foi banido
      // (o modal de criação nem pergunta mais). Sem conta o chat não é erro:
      // é o card de escolha (`needsSeat`) no lugar da conversa. Missão LEGADA
      // mantém a cadeia antiga — lá o orquestrador é quem manda.
      const seatId = mission.direct
        ? mission.seatId
        : (mission.seatId ??
          maestro.get(orchKey(mission.projectId, missionId)).seatId ??
          maestro.get(mission.projectId).seatId)
      const seat = seatId ? seats.get(seatId) : undefined
      if (!seat) {
        if (mission.direct)
          return { ok: false, needsSeat: true, error: 'escolha a conta desta conversa' }
        return { ok: false, error: 'escolha uma conta para esta missão antes de abrir o chat' }
      }
      seats.preseed(seat)

      let paneId = guiMissionPaneId(role, missionId)
      if (role === 'helper') {
        // Ajudante é o único papel plural: acha a 1ª vaga livre para não
        // sequestrar a conversa de um ajudante que ainda está trabalhando.
        let index = 1
        while (index <= MAX_MISSION_HELPERS && guiSessions.has(guiMissionPaneId(role, missionId, index)))
          index += 1
        if (index > MAX_MISSION_HELPERS)
          return {
            ok: false,
            error: `esta missão já tem ${MAX_MISSION_HELPERS} ajudantes abertos — feche um antes de abrir outro`
          }
        paneId = guiMissionPaneId(role, missionId, index)
      }

      // Resume: só vale a conversa gravada PARA ESTE pane e no MESMO CLI
      // (sessão claude não se retoma no codex e vice-versa). A régua é a
      // mesma do planejamento — mora em guiMissionContracts.
      const remembered = guiSessions.remembered(paneId)
      const rememberedExecutor = remembered?.cli === seat.cli ? remembered : undefined
      const resumeSessionId = resumeSessionIdFor(rememberedExecutor, seat.cli)
      const effectiveMode = permissionMode ?? remembered?.permissionMode

      // UM KIT POR CHAT, NUNCA OS DOIS (D2). O chat de PLANEJAMENTO recebe o kit
      // de planos; o chat de missão DEV (dev/reviewer/ajudante) recebe o kit de
      // DELEGAÇÃO — a ordem do dono de 18/08: subagente nunca mais vira aba, e a
      // única porta de delegação é o MCP, porque é ele que carimba modelo,
      // effort e conta na lateral. `undefined` nos dois casos = servidor ainda
      // subindo: o chat nasce conversando, sem ferramenta, e reabrir arma.
      const mcpInput = {
        paneId,
        projectId: mission.projectId,
        cwd,
        cli: seat.cli,
        missionId,
        seatId: seat.id
      }
      const mcp =
        route.missionType === 'planejamento'
          ? armGuiPlannerMcp(mcpInput, guiPlannerMcpDeps)
          : armGuiDelegateMcp(mcpInput, guiPlannerMcpDeps)

      const spawn: GuiPaneSpawn = {
        paneId,
        projectId: mission.projectId,
        cli: seat.cli,
        configDir: seats.configDirOf(seat),
        seatId: seat.id,
        cwd,
        // A escolha feita NO CHAT vence a da criação: os seletores do composer
        // gravam modelo/effort por pane, e reabrir tem de cair na última
        // escolha do dono — não na que a missão nasceu.
        model: rememberedGuiExecutorValue(rememberedExecutor, seat.cli, 'model', mission.model),
        effort: rememberedGuiExecutorValue(rememberedExecutor, seat.cli, 'effort', mission.effort),
        systemPrompt: route.systemPrompt,
        resumeSessionId,
        permissionMode: effectiveMode,
        ...(mcp ? { mcp } : {}),
        // Conversa retomada JÁ tem o briefing: repetir o primeiro turno seria
        // re-briefing perseguindo o pane (lição da F6.8i). O briefing é do TIPO
        // da missão: dev/reviewer/ajudante recebem goal + branch do worktree;
        // o planejamento recebe o caderno plano/ e o recorte do dono.
        firstPrompt: resumeSessionId
          ? undefined
          : route.missionType === 'planejamento'
            ? planningMissionFirstPrompt(mission, project)
            : guiMissionFirstPrompt(role, {
                title: mission.title,
                goal: mission.goal,
                scope: mission.scope,
                branch: mission.branch,
                baseBranch: mission.baseBranch
              })
      }
      blackbox.record({
        cat: 'pane',
        event: 'mission-gui-spec',
        actor: 'user',
        ids: { projectId: mission.projectId, missionId, paneId, seatId: seat.id },
        detail: {
          role,
          cli: seat.cli,
          resumed: Boolean(resumeSessionId),
          direct: Boolean(mission.direct),
          missionType: route.missionType,
          workspace: route.workspace,
          permissionMode: effectiveMode ?? 'default',
          plannerTools: route.missionType === 'planejamento' && Boolean(mcp),
          delegateTools: route.missionType !== 'planejamento' && Boolean(mcp)
        }
      })
      return { ok: true, spawn }
    }
  )

  /**
   * CONTA DA CONVERSA (2.0 — ordem do dono: "o seat eu escolho dentro da
   * missão, num card, igual no Claude GUI"). Vale para o card da conversa
   * vazia E para o menu de troca no cabeçalho do chat.
   *
   * Trocar a conta com conversa viva não pode custar o contexto: mesmo CLI →
   * a conversa de CADA pane GUI da missão é TRANSPLANTADA para o config dir
   * novo (mesma prova de 2026-08-04 do reseat do orquestrador); CLI diferente
   * → nada a migrar, o resume já se recusa a atravessar binários. Depois as
   * sessões vivas MORREM (elas falam pela conta antiga) e o renderer reabre
   * pelo guiSpec — que agora resolve o seat novo.
   */
  ipcMain.handle(
    'missions:setChatSeat',
    (e, projectId: string, missionId: string, seatId: string): { ok: boolean; msg?: string } => {
      const mission = missions.get(missionId)
      if (!mission || mission.projectId !== projectId)
        return { ok: false, msg: 'missão não encontrada' }
      if (!mission.direct)
        return { ok: false, msg: 'esta missão é do pipeline antigo — a conta dela é a do orquestrador' }
      if (mission.status !== 'ativa')
        return { ok: false, msg: 'só missão ativa troca a conta da conversa' }
      const nextSeat = seats.get(seatId)
      if (!nextSeat) return { ok: false, msg: 'escolha uma conta válida' }
      const prevSeat = mission.seatId ? seats.get(mission.seatId) : undefined
      if (prevSeat?.id === nextSeat.id) return { ok: true, msg: 'esta conversa já usa essa conta' }

      // Transplante ANTES de matar as sessões: o arquivo de conversa é lido do
      // config dir antigo, e o kill não o apaga — mas fazer na ordem certa
      // mantém o motivo óbvio para quem ler depois.
      const cwd =
        missionTypeOf(mission) === 'planejamento'
          ? projects.get(projectId)?.path
          : (mission.worktree ?? projects.get(projectId)?.path)
      const paneIds = [
        ...GUI_MISSION_ROLES.filter((role) => role !== 'helper').map((role) =>
          guiMissionPaneId(role, missionId)
        ),
        ...Array.from({ length: MAX_MISSION_HELPERS }, (_, i) =>
          guiMissionPaneId('helper', missionId, i + 1)
        )
      ]
      let migrated = 0
      const panesWithoutMigratedHistory: string[] = []
      if (prevSeat && cwd && prevSeat.cli === nextSeat.cli) {
        for (const paneId of paneIds) {
          const remembered = guiSessions.remembered(paneId)
          if (!remembered?.sessionId || remembered.cli !== nextSeat.cli) continue
          const copied = migrateCliSessionBetweenSeats(
            nextSeat.cli,
            prevSeat.id,
            nextSeat.id,
            cwd,
            remembered.sessionId
          )
          if (copied) {
            migrated += 1
          } else {
            // O id aponta para um arquivo ausente no config dir novo. Manter o
            // resume faria o pane nascer quebrado; recomeçar é o fallback honesto.
            panesWithoutMigratedHistory.push(paneId)
          }
        }
      }
      const crossedCli = Boolean(prevSeat && prevSeat.cli !== nextSeat.cli)
      const previousSeatMissing = Boolean(mission.seatId && !prevSeat)
      const resetExecutor = guiSeatNeedsExecutorReset(
        prevSeat,
        nextSeat,
        Boolean(mission.seatId)
      )
      const updated = missions.setExecutorSeat(missionId, nextSeat.id, {
        // gpt-* nunca vaza para Claude, nem sonnet/opus para Codex.
        resetExecutor
      })
      if (!updated) return { ok: false, msg: 'não consegui gravar a conta desta missão' }
      // Só desmonta/muda o registro de resume depois que o seat novo pousou.
      if (crossedCli || previousSeatMissing) {
        // Sem uma identidade anterior comprovável não basta limpar o id: um
        // registro do mesmo CLI reaplicaria também modelo/effort do seat órfão.
        for (const paneId of paneIds) guiSessions.forgetSessionIdentity(paneId)
      } else {
        for (const paneId of panesWithoutMigratedHistory) guiSessions.forgetSession(paneId)
      }
      killMissionGuiPanes(missionId)
      const resetAfterFailedMigration = panesWithoutMigratedHistory.length
      blackbox.record({
        cat: 'user',
        event: 'mission-chat-seat-set',
        actor: 'user',
        ids: { projectId, missionId, seatId: nextSeat.id },
        detail: {
          prevSeatId: prevSeat?.id,
          cli: nextSeat.cli,
          migrated,
          resetAfterFailedMigration,
          crossedCli,
          previousSeatMissing,
          resetExecutor
        }
      })
      emitMissionsChanged(projectId)
      return {
        ok: true,
        msg: resetAfterFailedMigration
          ? `conta trocada para ${nextSeat.name} — ${resetAfterFailedMigration === 1 ? 'uma conversa recomeçou' : `${resetAfterFailedMigration} conversas recomeçaram`} porque não deu para transportar o histórico`
          : migrated
          ? `conta trocada para ${nextSeat.name} — a conversa foi junto`
          : crossedCli
            ? `conta trocada para ${nextSeat.name} — CLI diferente, a conversa recomeça`
            : previousSeatMissing
              ? `conta trocada para ${nextSeat.name} — a conta anterior não existe mais, a conversa recomeça`
            : `conta desta conversa: ${nextSeat.name}`
      }
    }
  )

  // Missão criada pelo PM: o usuário escolhe conta/modelo/effort do
  // orquestrador no modal do board — só então o paneSpec libera o pane
  // (decisão do usuário, 02/08).
  ipcMain.handle(
    'missions:confirmOrchestrator',
    (e, projectId: string, missionId: string, choice: { seatId?: string; model?: string; effort?: string }) => {
      const mission = missions.get(missionId)
      if (!mission || mission.projectId !== projectId || !mission.pendingOrchestrator) return false
      const seatId = choice?.seatId && seats.get(choice.seatId) ? choice.seatId : undefined
      const updated = missions.confirmOrchestrator(missionId, {
        seatId,
        model: choice?.model?.trim() || undefined,
        effort: choice?.effort?.trim() || undefined
      })
      if (!updated) return false
      blackbox.record({
        cat: 'user',
        event: 'orchestrator-confirmed',
        actor: 'user',
        ids: { projectId, missionId, seatId: updated.seatId },
        detail: { model: updated.model, effort: updated.effort }
      })
      emitMissionsChanged(projectId)
      return true
    }
  )

  // Troca de CONTA do orquestrador no meio da missão (decisão do usuário,
  // 2026-08-04: limite estourado nunca pode prender a missão nem custar o
  // contexto). Mesmo CLI → a conversa é TRANSPLANTADA para o seat novo
  // (sondas positivas nos dois CLIs); CLI diferente → renasce e se reergue
  // pelos arquivos duráveis (PLAN.md/board_status), como sempre.
  ipcMain.handle(
    'missions:setOrchestratorSeat',
    (
      e,
      projectId: string,
      missionId: string,
      choice: { seatId: string; model?: string; effort?: string }
    ) => {
      const mission = missions.get(missionId)
      if (!mission || mission.projectId !== projectId) return { ok: false, msg: 'missão não encontrada' }
      if (mission.status !== 'ativa')
        return { ok: false, msg: 'só missão ativa pode trocar a conta do orquestrador' }
      const nextSeat = choice?.seatId ? seats.get(choice.seatId) : undefined
      if (!nextSeat) return { ok: false, msg: 'escolha uma conta válida' }
      const key = orchKey(projectId, missionId)
      const state = maestro.get(key)
      const prevSeatId = mission.seatId ?? state.seatId ?? maestro.get(projectId).seatId
      const prevSeat = prevSeatId ? seats.get(prevSeatId) : undefined
      const paneId = orchPaneId(projectId, missionId)
      if (ptys.has(paneId)) ptys.kill(paneId)
      unregisterPane(paneId)
      // 2.0: as conversas GUI da missão nasceram com o config dir da conta
      // ANTIGA — trocar a conta sem encerrá-las deixaria chats órfãos falando
      // por um seat que a missão não usa mais. Reabrir dá o resume de sempre.
      killMissionGuiPanes(missionId)
      const cwd = mission.worktree ?? projects.get(projectId)?.path
      const migrated = Boolean(
        prevSeat &&
          prevSeat.id !== nextSeat.id &&
          prevSeat.cli === nextSeat.cli &&
          state.tuiSessionId &&
          cwd &&
          migrateCliSessionBetweenSeats(
            nextSeat.cli,
            prevSeat.id,
            nextSeat.id,
            cwd,
            state.tuiSessionId
          )
      )
      // confirmOrchestrator grava seat/model/effort (mesmo caminho do modal
      // de criação); pendingOrchestrator já é undefined em missão rodando.
      missions.confirmOrchestrator(missionId, {
        seatId: nextSeat.id,
        model: choice.model?.trim() || undefined,
        effort: choice.effort?.trim() || undefined
      })
      maestro.update(key, {
        seatId: nextSeat.id,
        sessionId: undefined,
        tuiSessionId: migrated ? state.tuiSessionId : undefined,
        personaSent: false,
        contextWindow: undefined
      })
      blackbox.record({
        cat: 'pane',
        event: 'seat-swap',
        actor: 'user',
        ids: { projectId, missionId, paneId, seatId: nextSeat.id },
        reason: migrated
          ? `orquestrador migrado de ${prevSeat?.name ?? prevSeatId} para ${nextSeat.name} COM a conversa (transplante de sessão)`
          : `orquestrador trocado de ${prevSeat?.name ?? prevSeatId} para ${nextSeat.name} sem migração (CLI diferente ou sem sessão) — reergue por PLAN.md/board_status`
      })
      hub.publish({
        projectId,
        missionId,
        kind: 'info',
        quiet: true,
        text: `orquestrador da missão "${mission.title}" trocou para a conta ${nextSeat.name}${migrated ? ' mantendo a conversa' : ''}`,
        actor: 'harness'
      })
      emitMissionsChanged(projectId)
      return {
        ok: true,
        msg: migrated
          ? 'conta trocada COM a conversa transplantada'
          : 'conta trocada; conversa recomeça e o orquestrador se reergue pelos arquivos da missão'
      }
    }
  )

  ipcMain.handle(
    'missions:update',
    (e, id: string, patch: { title?: string; goal?: string; scope?: string; status?: 'ativa' | 'arquivada' | 'concluida' }) => {
      const mission = missions.get(id)
      if (!mission) return null
      // status transita entre ativa e arquivada pela UI (integração tem caminho
      // próprio; concluída é terminal). EXCEÇÃO (ordem do dono, 2026-08-17):
      // missão de PLANEJAMENTO conclui num clique — sem branch, sem fila e sem
      // merge, "concluir" é só encerrar bonito: a missão sai da coluna, o
      // plano/ fica no repo e a aba do plano segue no mapa. Missão de dev
      // continua concluindo SÓ pela integração.
      if (patch.status && mission.status !== 'ativa' && mission.status !== 'arquivada')
        delete patch.status
      if (patch.status === 'concluida' && missionTypeOf(mission) !== 'planejamento')
        delete patch.status
      if (patch.status && patch.status !== mission.status) {
        if (patch.status === 'arquivada') {
          const queued = integrationQueue.getByMission(mission.id)
          if (queued?.state === 'merging') {
            hub.publish({
              projectId: mission.projectId,
              kind: 'error',
              text: `não arquivei "${mission.title}": ela está no instante de merge da cabeça da fila`,
              actor: 'harness'
            })
            return mission
          }
        }
        if (patch.status === 'arquivada') {
          const queued = integrationQueue.getByMission(mission.id)
          if (queued) {
            integrationQueue.cancel(mission.id)
            scheduleIntegrationDrain(mission.projectId)
          }
          stopMissionExecution(
            mission.projectId,
            mission.id,
            'execução pausada porque a missão foi arquivada; ao reativar, revise o transcript e rode o card novamente'
          )
        }
      }
      const updated = missions.update(id, patch)
      if (updated) {
        // Missão ARQUIVADA não fica com orquestrador vivo (bug real: o pane
        // seguia aberto com o CLI rodando): mata o pty e desarma o hub —
        // reativar respawna via resume (tuiSessionId persiste no maestroStore).
        if (patch.status === 'arquivada' || patch.status === 'concluida') {
          const paneId = orchPaneId(updated.projectId, id)
          if (ptys.has(paneId)) ptys.kill(paneId)
          unregisterPane(paneId)
          // 2.0: dev/reviewer/ajudantes da missão encerram junto (a conversa
          // fica gravada; concluída abre congelada, arquivada reabre no resume).
          killMissionGuiPanes(id)
        }
        // Arquivar/reativar é MARCO — o PM comenta (decisão do usuário: ele
        // fala em concluída/integrada/arquivada, não na rotina).
        if (patch.status && patch.status !== mission.status) {
          hub.publish({
            projectId: updated.projectId,
            kind: 'info',
            text:
              patch.status === 'concluida'
                ? `planejamento "${updated.title}" foi CONCLUÍDO — o plano segue no mapa`
                : patch.status === 'arquivada'
                  ? `missão "${updated.title}" foi ARQUIVADA${updated.branch ? ` (branch ${updated.branch} preservada)` : ''}`
                  : `missão "${updated.title}" foi REATIVADA`,
            actor: 'user'
          })
        }
        emitMissionsChanged(updated.projectId)
        syncBoard(updated.projectId)
      }
      return updated ?? null
    }
  )

  ipcMain.handle('missions:integrate', (e, missionId: string) => {
    return startMissionIntegration(missionId, 'user')
  })

  // Excluir missão: só ARQUIVADA (fluxo: arquivar → excluir). Leva junto as
  // tarefas dela e limpa worktree/branch — a exclusão é deliberada.
  ipcMain.handle('missions:remove', (e, missionId: string) => {
    const mission = missions.get(missionId)
    if (!mission || mission.status !== 'arquivada') return false
    const project = projects.get(mission.projectId)
    if (!project) return false
    try {
      ensureSynkoraGitExcludes(project.path)
    } catch (error) {
      // Guard MUDO era bug real (02/08): .synkora versionado na base fazia o
      // "excluir de vez" morrer sem NENHUMA mensagem — o usuário clicava e
      // nada acontecia. Falha de guard sempre fala.
      hub.publish({
        projectId: mission.projectId,
        kind: 'error',
        text: `não excluí a missão "${mission.title}": ${error instanceof Error ? error.message : String(error)}`,
        actor: 'harness'
      })
      return false
    }
    const queued = integrationQueue.getByMission(missionId)
    if (queued?.state === 'merging') return false
    if (queued) integrationQueue.cancel(missionId)
    stopMissionExecution(
      mission.projectId,
      missionId,
      'execução encerrada porque a missão arquivada foi excluída'
    )
    ptys.kill(orchPaneId(mission.projectId, missionId))
    // 2.0: nenhum chat pode ficar com cwd dentro do worktree que vai sumir.
    killMissionGuiPanes(missionId)
    if (mission.branch && mission.worktree) {
      removeWorktreeAndBranch(project.path, mission.worktree, mission.branch)
    }
    backlog.releaseMissionItems(missionId) // itens não-feitos voltam a pendente
    missions.remove(missionId)
    // Exclusão definitiva, ao contrário de arquivar, remove também resume e
    // fotografia dos chats desta missão.
    guiSessions.forgetWhere((paneId) => isGuiMissionPaneId(paneId, missionId))
    emitBacklogChanged(mission.projectId)
    // rastro da missão some junto: plano, transcript/veredito do gate e o
    // estado do orquestrador no maestroStore
    const short = missionId.slice(0, 8)
    for (const f of [
      join(project.path, '.synkora', 'missions', `${short}.PLAN.md`),
      join(project.path, '.synkora', 'runs', `mission-${short}.md`),
      join(project.path, '.synkora', 'runs', `mission-${short}.verdict`)
    ]) {
      try {
        unlinkSync(f)
      } catch {
        // nunca existiu
      }
    }
    maestro.forget(orchKey(mission.projectId, missionId))
    hub.purgeMissionEvents(mission.projectId, missionId)
    hub.publish({
      projectId: mission.projectId,
      kind: 'info',
      text: `missão "${mission.title}" EXCLUÍDA (tarefas${mission.branch ? ` e branch ${mission.branch}` : ''} removidas)`,
      actor: 'user'
    })
    ctx.pushAll('tasks:changed', mission.projectId)
    emitMissionsChanged(mission.projectId)
    syncBoard(mission.projectId)
    return true
  })

  // O PANE TUI DO ORQUESTRADOR MORREU NA LIMPA F6 (2026-08-17). O handler já
  // recusava para toda missão nascida na era 2.0 (`mission.direct` → null, e
  // `missions:create` carimba `direct: true` por padrão): só um registro
  // pré-2.0 o alcançava. Fica como RECUSA HONESTA em vez de canal ausente —
  // `ipcMain.handle` removido faz o `invoke` do Board legado REJEITAR sem
  // `.catch`. Some junto com o consumidor, do lado do renderer.
  ipcMain.handle('missions:paneSpec', () => null)
}
