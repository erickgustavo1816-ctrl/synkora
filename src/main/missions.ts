import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { loadJsonStore, persistJsonStore } from './jsonStore'
import { redactSensitiveStrings } from './securityRedaction'
import { missionTypeOf, type MissionType } from './guiMissionContracts'

// Missões (F3.8): a unidade de trabalho do universo. Cada missão tem seu
// PRÓPRIO orquestrador (pane TUI), suas tarefas e — com git — sua própria
// branch/worktree (mission/<id8>): durante o desenvolvimento uma missão NUNCA
// enxerga os arquivos da outra; o risco fica concentrado na INTEGRAÇÃO
// (gate de review da missão inteira → merge --no-ff na branch base).

export type MissionStatus = 'ativa' | 'integrando' | 'concluida' | 'arquivada'

export interface Mission {
  id: string
  projectId: string
  title: string
  /** objetivo em 1-3 frases (vira contexto da persona do orquestrador) */
  goal?: string
  /** escopo declarado (áreas/paths) — guardrail suave contra sobreposição */
  scope?: string
  status: MissionStatus
  /** branch mission/<id8> (undefined = projeto sem git, roda direto no dir) */
  branch?: string
  /** worktree da missão — cwd do orquestrador e base das tarefas */
  worktree?: string
  /** branch base do repo na criação (alvo do merge de integração) */
  baseBranch?: string
  /** seat do ORQUESTRADOR (escolhido no modal; ausente = herda o do PM) */
  seatId?: string
  /** modelo do orquestrador (--model no spawn; ausente = padrão do seat) */
  model?: string
  /** effort do orquestrador (claude --effort / codex model_reasoning_effort) */
  effort?: string
  /** 'direta' = registro de trabalho feito por AGENTE LIVRE direto na base:
   *  nasce concluída, sem orquestrador/cards/branch — só a história (goal =
   *  pontos do que foi mexido), para o PM ter noção do que aconteceu */
  kind?: 'direta'
  /** MISSÃO 2.0 (onda B): sem orquestrador e sem maquinaria de plano — o dono
   *  fala direto com o dev no pane GUI e o ⇪ integra pelo caminho direto.
   *  Carimbado no NASCIMENTO e nunca mais: missão legada (sem o campo) segue
   *  com o fluxo de sempre, intacto. */
  direct?: true
  /** NATUREZA da missão (2.0): 'planejamento' = UMA conversa na RAIZ do
   *  projeto que entrevista o dono e escreve plano/ — sem worktree (não há o
   *  que mesclar) e fora da fila de integração. Ausente = 'dev', a missão de
   *  sempre. Carimbo de NASCIMENTO: fora do Pick do `update`, como `direct`,
   *  então missão nenhuma troca de natureza depois de existir. */
  missionType?: MissionType
  /** Missão criada pelo PM aguardando o usuário escolher conta/modelo/effort
   *  do orquestrador no modal (decisão do usuário, 02/08) — enquanto true o
   *  paneSpec recusa abrir o orquestrador. */
  pendingOrchestrator?: boolean
  /** Agente (PM/orquestrador) pediu a integração via MCP com a missão pronta:
   *  a INTENÇÃO fica registrada e o merge SÓ anda com o gesto do dono (botão
   *  ⇪ pulsando no board). Porteira MECÂNICA — persona não é cerca (caso real
   *  2026-08-07: o PM integrou a M04 18min após perguntar, sem resposta). */
  pendingIntegrationApproval?: boolean
  /** versão do backlog a que esta missão pertence (escopo de release) */
  versionId?: string
  /** Momento real da conclusão. `updatedAt` pode mudar depois por manutenção
   *  e não deve fazer uma missão antiga parecer recém-concluída no radar. */
  completedAt?: string
  createdAt: string
  updatedAt: string
}

export interface NewMission {
  title: string
  goal?: string
  scope?: string
  seatId?: string
  model?: string
  effort?: string
  versionId?: string
  pendingOrchestrator?: boolean
  /** Missão 2.0 (sem orquestrador/plano). Só o nascimento decide. */
  direct?: boolean
  /** 2.0: 'planejamento' abre a conversa que escreve plano/ na raiz do
   *  projeto; omitido/'dev' = missão de desenvolvimento. Só o nascimento
   *  decide. */
  missionType?: MissionType
}

export class MissionStore {
  private readonly file = join(app.getPath('userData'), 'missions.json')
  private missions: Mission[] = []

  constructor() {
    this.missions = redactSensitiveStrings(loadJsonStore(
      this.file,
      () => [],
      (value): value is Mission[] =>
        Array.isArray(value) &&
        value.every(
          (mission) =>
            typeof mission === 'object' &&
            mission !== null &&
            typeof (mission as Partial<Mission>).id === 'string' &&
            typeof (mission as Partial<Mission>).projectId === 'string' &&
            typeof (mission as Partial<Mission>).title === 'string'
        )
    ))
  }

  /** O arquivo pousa antes de a fotografia viva mudar. */
  private commit(next: Mission[]): void {
    persistJsonStore(this.file, next)
    this.missions = next
  }

  list(projectId: string): Mission[] {
    return this.missions.filter((m) => m.projectId === projectId)
  }

  get(id: string): Mission | undefined {
    return this.missions.find((m) => m.id === id)
  }

  create(projectId: string, input: NewMission, reservedId?: string): Mission {
    const now = new Date().toISOString()
    input = redactSensitiveStrings(input)
    const mission: Mission = {
      id: reservedId ?? randomUUID(),
      projectId,
      title: input.title,
      goal: input.goal,
      scope: input.scope,
      seatId: input.seatId,
      model: input.model,
      effort: input.effort,
      versionId: input.versionId,
      pendingOrchestrator: input.pendingOrchestrator || undefined,
      // Carimbo de nascimento: `update` não lista `direct` no Pick, então
      // ninguém converte missão legada em 2.0 (nem o contrário) depois.
      direct: input.direct ? true : undefined,
      // Mesma regra para a NATUREZA: só 'planejamento' e 'release' (R10) são
      // persistidos; 'dev' é a ausência do campo (o que todo disco já é hoje).
      missionType: missionTypeOf(input) === 'dev' ? undefined : missionTypeOf(input),
      status: 'ativa',
      createdAt: now,
      updatedAt: now
    }
    this.commit([...this.missions, mission])
    return mission
  }

  /** Missão DIRETA: registro de trabalho de agente livre — já nasce
   *  concluída, sem branch/orquestrador/cards. */
  createDirect(
    projectId: string,
    input: { title: string; points: string[]; versionId?: string }
  ): Mission {
    const now = new Date().toISOString()
    input = redactSensitiveStrings(input)
    const mission: Mission = {
      id: randomUUID(),
      projectId,
      title: input.title,
      goal: input.points.map((p) => `- ${p}`).join('\n'),
      versionId: input.versionId,
      kind: 'direta',
      status: 'concluida',
      completedAt: now,
      createdAt: now,
      updatedAt: now
    }
    this.commit([...this.missions, mission])
    return mission
  }

  /** Escolha do orquestrador feita no modal (missão criada pelo PM): grava
   *  conta/modelo/effort e libera o paneSpec de abrir o pane. */
  confirmOrchestrator(
    id: string,
    choice: { seatId?: string; model?: string; effort?: string }
  ): Mission | undefined {
    const index = this.missions.findIndex((m) => m.id === id)
    if (index < 0) return undefined
    const mission: Mission = {
      ...this.missions[index],
      seatId: choice.seatId,
      model: choice.model,
      effort: choice.effort,
      pendingOrchestrator: undefined,
      updatedAt: new Date().toISOString()
    }
    const next = [...this.missions]
    next[index] = mission
    this.commit(next)
    return mission
  }

  /** Conta da CONVERSA da missão direta (2.0, missions:setChatSeat). Modelo e
   *  effort sobrevivem entre contas do MESMO CLI; ao atravessar Claude/Codex,
   *  o chamador pede reset porque os vocabulários não são portáveis. */
  setExecutorSeat(
    id: string,
    seatId: string,
    options: { resetExecutor?: boolean } = {}
  ): Mission | undefined {
    const index = this.missions.findIndex((m) => m.id === id)
    if (index < 0) return undefined
    const mission: Mission = {
      ...this.missions[index],
      seatId,
      ...(options.resetExecutor ? { model: undefined, effort: undefined } : {}),
      updatedAt: new Date().toISOString()
    }
    const next = [...this.missions]
    next[index] = mission
    this.commit(next)
    return mission
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        Mission,
        | 'title'
        | 'goal'
        | 'scope'
        | 'status'
        | 'branch'
        | 'worktree'
        | 'baseBranch'
        | 'pendingIntegrationApproval'
      >
    >
  ): Mission | undefined {
    const index = this.missions.findIndex((m) => m.id === id)
    if (index < 0) return undefined
    const current = this.missions[index]
    const now = new Date().toISOString()
    const wasCompleted = current.status === 'concluida'
    const previousUpdatedAt = current.updatedAt
    const mission: Mission = {
      ...current,
      ...redactSensitiveStrings(patch),
      updatedAt: now
    }
    if (patch.status === 'concluida' && !wasCompleted) mission.completedAt = now
    else if (mission.status === 'concluida' && !mission.completedAt) {
      mission.completedAt = previousUpdatedAt
    }
    if (patch.status && patch.status !== 'concluida') delete mission.completedAt
    const next = [...this.missions]
    next[index] = mission
    this.commit(next)
    return mission
  }

  remove(id: string): void {
    this.commit(this.missions.filter((m) => m.id !== id))
  }
}
