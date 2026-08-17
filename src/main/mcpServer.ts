import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
  type McpRequestContext
} from '@modelcontextprotocol/server'
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler
} from '@modelcontextprotocol/node'
import { z } from 'zod'
import { createHash } from 'crypto'
import { createRequire } from 'module'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join, relative, sep } from 'path'
import type { Hub, PaneIdentity } from './hub'
import type { PlanPatch } from './plans'
import type { CodeQuery } from './codeIntelligence/types'
import type { SecurityReviewInput } from './securityReview'
import type { GateVerificationEvidence } from './gateVerificationEvidence'
import type { PhaseWatch } from './phaseTypes'
import type {
  MissionExecutionMode,
  MissionRiskLevel,
  MissionRiskSurface,
  TaskDelegationMode,
  TaskDeliverableKind
} from './orchestratorFlow'

// Servidor MCP local do Synkora: é por AQUI que os agentes falam com o app.
// Cada pane nasce com um bearer token próprio; o token identifica QUEM chama
// (maestro/dev/review/qa/ajudante, de qual projeto/tarefa/worktree) e as
// ferramentas agem no contexto certo. HTTP em 127.0.0.1, porta aleatória.

const DEPARTMENTS = [
  'front',
  'back',
  'qa',
  'design',
  'research',
  'copy',
  'cyber',
  'data'
] as const

// Mantido local porque os testes MCP executam este arquivo diretamente com o
// strip de TypeScript do Node, que não resolve imports TS de valor sem extensão.
// `satisfies` mantém cada opção presa ao contrato do classificador.
const PLAN_RISK_SURFACES = [
  'authentication',
  'authorization',
  'tenant_boundary',
  'payments',
  'secrets',
  'personal_data',
  'destructive_data',
  'data_migration',
  'public_contract',
  'concurrency',
  'release_infrastructure',
  'file_upload',
  'admin_support',
  'ai_agents',
  'external_integration',
  'abuse_controls',
  'logging_errors',
  'security_configuration',
  'supply_chain',
  'cryptography',
  'data_exposure'
] as const satisfies readonly MissionRiskSurface[]
type AssertNoMissingRiskSurface<T extends never> = T
type PlanRiskSurfaceCoverage = AssertNoMissingRiskSurface<
  Exclude<MissionRiskSurface, (typeof PLAN_RISK_SURFACES)[number]>
>

const requireFromMain = createRequire(
  typeof __filename === 'string' ? __filename : join(process.cwd(), 'package.json')
)

export interface DelegateOpts {
  prompt: string
  dept?: (typeof DEPARTMENTS)[number]
  seatId?: string
  model?: string
  effort?: string
  title?: string
  /** skills da biblioteca a injetar no workspace deste ajudante (ids de list_skills) */
  skills?: string[]
  affectsUi?: boolean
  /** SUBAGENTE especializado da biblioteca: o ajudante nasce COM essa persona
   *  (id de list_skills com tipo=subagente; ausente = ajudante genérico) */
  agent?: string
}

export interface TaskPatch {
  status?: 'backlog' | 'execucao' | 'qa' | 'done'
  title?: string
  description?: string
  effort?: 'leve' | 'pesada'
  briefing?: string
  gates?: ('review' | 'qa')[]
  quests?: string[]
  skills?: string[]
  affectsUi?: boolean
  agents?: string[]
  delegation?: TaskDelegationMode
  deliverable?: TaskDeliverableKind
  /** Notas do orquestrador anexadas ao PROMPT do gate no spawn — instrução de
   *  gate viaja no briefing, nunca perseguindo o pane (regra do usuário). */
  gateNotes?: { review?: string; qa?: string }
}

export interface NewTaskInput {
  department: (typeof DEPARTMENTS)[number]
  type?: 'feature' | 'bug'
  effort?: 'leve' | 'pesada'
  title: string
  description?: string
  briefing?: string
  gates?: ('review' | 'qa')[]
  quests?: string[]
  skills?: string[]
  affectsUi?: boolean
  agents?: string[]
  delegation?: TaskDelegationMode
  deliverable: TaskDeliverableKind
  /** IDs de cards anteriores do mesmo plano. */
  dependsOn?: string[]
  /** Item estável do grafo aprovado em create_plan. */
  planItemId?: string
}

export interface NewMissionInput {
  title: string
  goal?: string
  scope?: string
  /** nome da VERSÃO do app a que a missão pertence (ex.: "v1.1") */
  version?: string
  skillApplications: string[]
}

export interface ProjectPlanScopeInput {
  in: string[]
  out: string[]
}

export interface ProjectPlanVersionInput {
  id?: string
  name: string
  theme?: string
  goal?: string
}

export interface ProjectPlanWaveInput {
  id: string
  name?: string
}

export interface ProjectPlanMissionInput {
  id: string
  title: string
  objective: string
  wave: ProjectPlanWaveInput
  dependsOn?: string[]
  scope?: Partial<ProjectPlanScopeInput>
  acceptanceCriteria?: string[]
  version?: ProjectPlanVersionInput
}

export interface ProjectPlanRoadmapMetaInput {
  expectedCount?: number
  complete: boolean
}

export interface SaveProjectPlanInput {
  projectName?: string
  problem?: string
  audience?: string
  vision?: string
  successCriteria?: string[]
  constraints?: string[]
  scope?: Partial<ProjectPlanScopeInput>
  decisions?: string[]
  listMode?: 'merge' | 'replace'
  roadmapMode?: 'merge' | 'replace'
  roadmap?: ProjectPlanMissionInput[]
  roadmapMeta?: ProjectPlanRoadmapMetaInput
  planningStage: PlanningSkillStage
  planningContribution: string
  skillApplications: string[]
}

export type PlanningSkillStage = 'discovery' | 'scope' | 'decisions' | 'roadmap' | 'review'

/** F5.7 — card de PLANO da missão (proposta do orquestrador). */
export interface PlanLaneInput {
  dept: (typeof DEPARTMENTS)[number]
  notes?: string
  seatId?: string
  model?: string
  effort?: string
}

export interface NewPlanInput {
  title: string
  summary: string
  lanes: PlanLaneInput[]
  executionMode: MissionExecutionMode
  risk: MissionRiskLevel
  riskSurfaces: MissionRiskSurface[]
  sizingReason: string
  expectedCards: number
  workItems: Array<{
    id: string
    title: string
    department: (typeof DEPARTMENTS)[number]
    deliverable: TaskDeliverableKind
    waveId: string
    dependsOn: string[]
  }>
  /** Receipt obrigatório do método de planejamento desta rodada. */
  skillApplications: string[]
}

/** Implementada em index.ts — as tools delegam para o harness real. */
export interface McpApi {
  hub: Hub
  boardStatus: (id: PaneIdentity) => string
  createTasks: (id: PaneIdentity, items: NewTaskInput[]) => string
  archiveMission: (id: PaneIdentity, query: string) => string
  updateTask: (
    id: PaneIdentity,
    taskId: string,
    patch: TaskPatch & { ownerOrder?: string }
  ) => string
  /** AUTONOMIA (ordem do dono 2026-08-10): o orquestrador conclui card AUTO
   *  por juízo próprio — motivo auditado, gates faltantes viram 'waived';
   *  cercas restantes = verificação conjunta do plano + ⇪ do dono. */
  completeTask: (id: PaneIdentity, taskId: string, reason: string) => string
  /** AUTORIDADE PLENA SOBRE OS PANES DA MISSÃO (ordem do dono 2026-08-12):
   *  o gêmeo do complete_task — PARA a fase deliberadamente, preserva o
   *  trabalho e devolve o card ao backlog; motivo auditado verbatim. */
  stopTask: (id: PaneIdentity, taskId: string, reason: string) => string
  report: (
    id: PaneIdentity,
    content: string,
    summary?: string,
    securityReview?: SecurityReviewInput,
    suggestedPatch?: string,
    skillApplications?: string[],
    verificationEvidence?: GateVerificationEvidence,
    devSnapshot?: PhaseWatch['devSnapshot']
  ) => string | Promise<string>
  /** Entrega somente a instrucao ja selecionada pelo receipt deste pane. */
  activateSkill: (id: PaneIdentity, receiptId: string) => Promise<string>
  /** Gate review lê somente o spool SHA-pinado da própria rodada. */
  readReviewEvidence: (
    id: PaneIdentity,
    offset: number,
    maxBytes?: number
  ) => string | Promise<string>
  /** Inteligência de código compartilhada; erros viram fallback compacto em
   *  vez de falha de protocolo, para o pane continuar utilizável sem LSP. */
  codeQuery: (id: PaneIdentity, query: CodeQuery) => Promise<string>
  /** Guard do report(done): `blocked` traz a mensagem curta que o bloqueia;
   *  sem `blocked`, o report pode seguir e `devSnapshot` carrega a fotografia
   *  POR VALOR até o advancePhase (F2-c5b, §7.10 — dois guards concorrentes
   *  deixam de contaminar a decisão um do outro pelo campo compartilhado). */
  codeReportGuard: (
    id: PaneIdentity
  ) => Promise<{ blocked?: string; devSnapshot?: PhaseWatch['devSnapshot'] }>
  /** um OU vários ajudantes numa chamada (lote = uma rodada de modelo só) */
  delegateMany: (id: PaneIdentity, list: DelegateOpts[]) => Promise<string>
  /** biblioteca pesquisável; nunca despeja o catálogo inteiro no contexto. */
  listSkills: (
    id: PaneIdentity,
    filter?: {
      query?: string
      kind?: 'skill' | 'agent'
      department?: (typeof DEPARTMENTS)[number]
      installedOnly?: boolean
      limit?: number
    }
  ) => string
  notifyMaestro: (id: PaneIdentity, text: string) => string
  /** Maestro/orquestrador → pergunta dirigida ao USUÁRIO: a aba do board
   *  correspondente pulsa até o dono abrir (pergunta em prosa não tem sinal
   *  visual nenhum — caso real 2026-08-06, PM no vácuo). */
  askUser: (id: PaneIdentity, question: string) => string
  /** Maestro/orquestrador → allowlist de RUNTIME do produto (T9 2026-08-10):
   *  arquivos rastreados que o app grava ao rodar; sujeira de gate composta
   *  só deles é restaurada ao commit julgado em vez de descartar o veredito. */
  declareRuntimePaths: (id: PaneIdentity, paths: string[]) => string
  /** Maestro/orquestrador → documentação automática de sessão (2026-08-10):
   *  destila aprendizado durável num tópico de .synkora/maestro/ — a estante
   *  da memória escalável que alimenta as sessões futuras. */
  recordLearnings: (id: PaneIdentity, topic: string, content: string) => string
  /** Qualquer agente → frase curta "o que estou fazendo agora" para o radar
   *  de andamento do dono (2026-08-06: ele acompanha sem abrir o app). */
  statusNote: (id: PaneIdentity, note: string) => string
  /** QA → agência sobre o runtime que o HARNESS possui (capacidade antes de
   *  escalação, 2026-08-06): status/restart(porta)/stop, sem shell. */
  runtimeControl: (
    id: PaneIdentity,
    action: 'status' | 'restart' | 'stop',
    port?: number
  ) => Promise<string>
  /** Maestro/orquestrador → linha direta no terminal de um pane do escopo
   *  (ex.: responder o plano de delegação de um dev). */
  notifyPane: (
    id: PaneIdentity,
    target: { paneId?: string; taskId?: string; role?: 'dev' | 'review' | 'qa' },
    text: string
  ) => Promise<string>
  /** Maestro/orquestrador enxerga os panes do próprio escopo (paneId, papel,
   *  card, estado) — é a lista de com quem o notify_pane pode falar. */
  listPanes: (id: PaneIdentity) => string
  // ——— kit do CHAT de planejamento (2.0, onda D — role 'gui-planner') ———
  /** Todos os planos do universo com o progresso derivado das missões. */
  listPlans: (id: PaneIdentity) => string
  /** Um plano inteiro, com o `updatedAt` que o CAS do update exige. */
  getPlan: (id: PaneIdentity, planId: string) => string
  /** APRESENTA um plano novo ao dono no chat. NUNCA cria — o clique cria. */
  proposePlan: (id: PaneIdentity, draft: unknown) => string
  /** Edita um plano existente (execução direta; CAS por updatedAt). */
  updatePlan: (
    id: PaneIdentity,
    planId: string,
    patch: PlanPatch,
    expectedUpdatedAt?: string
  ) => string
  /** Arquiva (soft) um plano. Exclusão definitiva é gesto do dono no mapa. */
  deletePlan: (id: PaneIdentity, planId: string, expectedUpdatedAt?: string) => string
  generateImage: (id: PaneIdentity, prompt: string, fileName?: string) => Promise<string>
  createMission: (id: PaneIdentity, input: NewMissionInput) => string
  /** PM persiste/revisa o mapa macro do projeto sem criar missões reais. */
  saveProjectPlan: (id: PaneIdentity, input: SaveProjectPlanInput) => string
  /** Registra o aval explícito do usuário para o roadmap atual. */
  approveProjectPlan: (id: PaneIdentity) => string
  /** Abre uma missão pronta da onda autorizada do roadmap aprovado. */
  startProjectMission: (id: PaneIdentity, itemId: string) => string
  /** PM decide a estratégia de um conflito da fila e a persiste para o orquestrador executar.
   *  directResolution=true: o PM JÁ resolveu mecanicamente na branch da missão — re-lacra e retoma sem card. */
  guideIntegrationResolution: (
    id: PaneIdentity,
    missionId: string,
    instruction: string,
    directResolution?: boolean
  ) => string
  /** orquestrador propõe o card de PLANO da missão (substitui enquanto não aprovado) */
  createPlan: (id: PaneIdentity, input: NewPlanInput) => Promise<string>
  /** orquestrador encerra o plano: conclusão vai para o card, status done */
  concludePlan: (id: PaneIdentity, conclusion: string) => Promise<string>
  /** orquestrador dispara a execução de um card (plano aprovado = autonomia) */
  runTask: (
    id: PaneIdentity,
    taskId: string,
    phase?: 'review' | 'qa' | 'finalize',
    adjustment?: string
  ) => Promise<string>
  /** orquestrador remove um card AUTO que não será feito (limpeza do plano) */
  deleteTask: (id: PaneIdentity, taskId: string) => string
  integrateMission: (id: PaneIdentity, missionId?: string) => string
  /** instrumentação CHECK 14: o app registra qual catálogo cada identidade
   *  recebeu (dedupe por pane no app — mudança de catálogo é o alarme) */
  noteCatalogServed?: (id: PaneIdentity, tools: string[]) => void
  /** CHECK 15: correio do pane p/ entrega de carona (bloco formatado ou undefined) */
  drainInboxFor?: (id: PaneIdentity, tool: string) => string | undefined
  /** CHECK 15: drenagem explícita via tool check_messages */
  checkMessages: (id: PaneIdentity) => string
  /** F5-F3 (long-poll): resolve true assim que o correio do pane tiver
   *  mensagem (imediato se já houver), false no teto — check_messages segura
   *  a resposta em vez de devolver "vazio" na hora. */
  waitForMail?: (id: PaneIdentity, timeoutMs: number) => Promise<boolean>
  /** troca seat/modelo/effort do executor de uma fase — SÓ por ordem explícita do dono */
  setPhaseExecutor: (
    id: PaneIdentity,
    taskId: string,
    seat: string,
    ownerOrder: string,
    model?: string,
    effort?: string
  ) => Promise<string> | string
  /** PM coloca várias missões prontas na mesma fila antes de iniciar o worker. */
  queueMissions: (id: PaneIdentity, missionIds: string[]) => string
  releaseVersion: (id: PaneIdentity, versionName: string) => string | Promise<string>
  setReleaseHold: (id: PaneIdentity, on: boolean, reason?: string) => string
  /** PM remove item de backlog aberto (versão não sobe com pendência) */
  removeBacklogItem: (id: PaneIdentity, query: string) => string
  /** agente LIVRE registra o que fez direto na base: missão "direta" (nasce
   *  concluída, só história — sem cards/orquestrador) */
  registerDirectMission: (id: PaneIdentity, title: string, points: string[]) => string
  listSeats: () => Promise<string>
  /** controle dos ajudantes abertos pelo chamador (via delegate) */
  listHelpers: (id: PaneIdentity) => string
  helperOutput: (id: PaneIdentity, paneId: string, chars?: number) => string
  helperSend: (id: PaneIdentity, paneId: string, message: string) => string
  helperClose: (id: PaneIdentity, paneId: string) => string
}

function text(s: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: s }] }
}

const codePath = z
  .string()
  .min(1)
  .max(2048)
  .describe('Caminho relativo à worktree do pane; absoluto, URI e saída por .. são recusados.')
const codeLine = z.number().int().min(1).max(10_000_000).describe('Linha em base 1.')
const codeColumn = z
  .number()
  .int()
  .min(1)
  .max(1_000_000)
  .describe('Coluna UTF-16 em base 1.')
const codeLimit = z.number().int().min(1).max(200).optional()
const codeOffset = z.number().int().min(0).max(100_000).optional()

const securityTriageSchema = z.object({
  gate: z.enum([
    'origin',
    'scope',
    'authorization',
    'evidence',
    'runtime',
    'server_control',
    'privacy',
    'business_impact',
    'correction_safety'
  ]),
  status: z.enum(['confirmed', 'refuted', 'unknown', 'not_applicable']),
  evidence: z.string().max(1_000)
})

const securityFindingSchema = z.object({
  id: z.string().max(100).optional(),
  lane: z.enum(['fix_now', 'monitor', 'human_validation', 'false_positive', 'needs_context']),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  confidence: z.enum(['low', 'medium', 'high']),
  title: z.string().min(1).max(240),
  evidence: z
    .array(
      z.object({
        path: z.string().min(1).max(500),
        location: z.string().max(300).optional(),
        note: z.string().min(1).max(1_000)
      })
    )
    .max(20),
  missingContext: z.array(z.string().max(500)).max(20),
  missingTests: z.array(z.string().max(500)).max(20),
  businessImpact: z.string().min(1).max(1_200),
  recommendedAction: z.string().min(1).max(1_200),
  triage: z.array(securityTriageSchema).max(30),
  falsePositiveBasis: z.string().max(1_200).optional()
})

const securityReviewSchema = z.object({
  reviewedFlows: z.array(z.string().min(1).max(500)).min(1).max(30),
  findings: z.array(securityFindingSchema).max(50),
  missingTests: z.array(z.string().max(500)).max(30),
  recommendedNextStep: z.string().min(1).max(1_200)
})

const gateVerificationEvidenceSchema = z
  .object({
    summary: z.string().min(8).max(2000),
    surfaces: z.array(z.string().min(1).max(240)).min(1).max(24).optional(),
    states: z.array(z.string().min(1).max(240)).min(1).max(24).optional(),
    viewports: z.array(z.string().min(1).max(120)).min(1).max(12).optional(),
    observations: z.array(z.string().min(1).max(600)).min(1).max(32)
  })
  .strict()

function buildServer(api: McpApi, identity: PaneIdentity): McpServer {
  // SEM cacheHints de tools/list (CHECK 14, 2026-08-07): o hint de cache da
  // spec 2026-07-28 estava anunciado sem nenhum cliente validado usando — e
  // no mistério "runtime_control sumiu SÓ em pane resumado" um cliente
  // recém-atualizado honrando TTL de catálogo é gatilho plausível. Custo de
  // remover: um tools/list por boot de pane. Só re-anunciar com sonda.
  const server = new McpServer({ name: 'synkora', version: '1.0.0' })

  // F5-F3: teto do long-poll do check_messages — DENTRO do provado em sonda
  // nos dois CLIs (R13: claude segura 45s no perfil exato do gate; W2–W4:
  // codex segura 75s+ sem config, e os panes codex ganham
  // tool_timeout_sec=300 de folga). Subir além disso exige re-sonda.
  const CHECK_MESSAGES_LONGPOLL_MS = 45_000

  // INSTRUMENTAÇÃO DO CATÁLOGO (CHECK 14): coleciona os nomes registrados
  // NESTA construção e avisa o app (dedupe por pane lá) — a caixa-preta
  // passa a registrar QUAL catálogo cada identidade recebeu; a próxima
  // anomalia de tool sumida se explica sozinha no journal.
  const servedTools: string[] = []
  const originalRegisterTool = server.registerTool.bind(server)
  // check_messages devolve o próprio correio; report abre a janela de
  // silêncio pós-veredito dos gates — nos dois a carona atrapalharia.
  const PIGGYBACK_EXCLUDED = new Set(['check_messages', 'report'])
  server.registerTool = ((name: string, ...rest: unknown[]) => {
    servedTools.push(name)
    const handlerIndex = rest.length - 1
    const handler = rest[handlerIndex]
    if (typeof handler === 'function' && !PIGGYBACK_EXCLUDED.has(name)) {
      // ENTREGA DE CARONA (CHECK 15 F1, 2026-08-07): mensagens pendentes do
      // pane chegam DENTRO do resultado que o agente já vai ler — payload
      // nunca mais viaja pelo teclado do terminal.
      rest[handlerIndex] = async (...handlerArgs: unknown[]) => {
        const result = await (handler as (...call: unknown[]) => unknown)(...handlerArgs)
        try {
          const inbox = api.drainInboxFor?.(identity, name)
          if (inbox) {
            const content = (result as { content?: unknown[] } | undefined)?.content
            if (Array.isArray(content)) content.push({ type: 'text', text: inbox })
          }
        } catch {
          // o correio nunca derruba a tool real
        }
        return result
      }
    }
    return (originalRegisterTool as (...args: unknown[]) => unknown)(name, ...rest)
  }) as typeof server.registerTool
  const finishCatalog = (): McpServer => {
    api.noteCatalogServed?.(identity, servedTools)
    return server
  }

  // ————— CHAT DE PLANEJAMENTO (2.0, onda D) — catálogo PRÓPRIO e FECHADO —————
  //
  // O pane GUI de planejamento é o primeiro chat da era 2.0 com ferramentas
  // Synkora, e ele recebe SÓ o kit de planos. O retorno antecipado é a cerca:
  // as tools abaixo são registradas dentro deste bloco, então nenhum outro
  // papel — inclusive os gates read-only — pode enxergá-las, e este papel não
  // enxerga uma linha do catálogo legado.
  if (identity.role === 'gui-planner') {
    server.registerTool(
      'list_plans',
      {
        description:
          'Os planos deste universo, com o progresso real de cada missão vinculada. Chame antes de propor qualquer coisa: propor de novo o que já está planejado é retrabalho.'
      },
      async () => text(api.listPlans(identity))
    )

    server.registerTool(
      'get_plan',
      {
        description:
          'Um plano inteiro: descrição, missões, objetivo/critérios/tier/contexto de cada uma e o updatedAt que o update_plan exige.',
        inputSchema: {
          planId: z.string().min(1).max(120).describe('id do plano (vem do list_plans)')
        }
      },
      async ({ planId }) => text(api.getPlan(identity, planId))
    )

    server.registerTool(
      'propose_plan',
      {
        description:
          'APRESENTA um plano novo ao dono, como card dentro desta conversa. NUNCA cria nada: quem cria é o clique dele. Chame só depois que ele concordar com o recorte em palavras — e então ENCERRE o turno e espere. Silêncio não é consentimento. Cada item é UMA missão entregável; os campos espelham as seções que você já escreve em plano/NNN-slug.md.',
        inputSchema: {
          title: z.string().min(1).max(120).describe('nome do plano, em PT-BR'),
          description: z
            .string()
            .max(4_000)
            .optional()
            .describe('o recorte em prosa que o dono julga sem ler código'),
          kind: z
            .enum(['mestre', 'livre'])
            .optional()
            .describe(
              "'mestre' = o plano de fundo do universo (só UM ativo); 'livre' (padrão) = um recorte que atravessa versões"
            ),
          items: z
            .array(
              z.object({
                key: z
                  .string()
                  .max(60)
                  .optional()
                  .describe('apelido curto desta missão, usado por outras em dependsOn'),
                title: z.string().min(1).max(120).describe('UMA entrega — título com "e" são duas missões'),
                objective: z.string().min(1).max(2_000).describe('seção Objetivo'),
                outOfScope: z.string().max(2_000).optional().describe('seção Fora de escopo'),
                doneCriteria: z
                  .array(z.string().max(400))
                  .max(10)
                  .optional()
                  .describe('seção Critério de pronto: binário e observável, nunca "ficou bom"'),
                tier: z.enum(['pequeno', 'medio', 'grande']).optional().describe('seção Tier'),
                context: z.string().max(2_000).optional().describe('seção Contexto'),
                dependsOn: z
                  .array(z.string().max(60))
                  .max(12)
                  .optional()
                  .describe('keys de missões ANTERIORES desta mesma lista'),
                docPath: z
                  .string()
                  .max(240)
                  .optional()
                  .describe("brief em prosa no repo, ex.: 'plano/003-fila.md'")
              })
            )
            .min(1)
            .max(24)
        }
      },
      async (draft) => text(api.proposePlan(identity, draft))
    )

    server.registerTool(
      'update_plan',
      {
        description:
          'Edita um plano que JÁ existe — isto executa na hora (editar é reversível). Mande o updatedAt que veio do get_plan: se o plano mudou nesse meio-tempo, a alteração é recusada em vez de sobrescrever o que o dono viu. O estado "concluida" e o vínculo com a missão são derivados da missão real e não se escrevem aqui. A designação de plano mestre não passa por aqui — ela é um gesto do dono no mapa.',
        inputSchema: {
          planId: z.string().min(1).max(120),
          expectedUpdatedAt: z
            .string()
            .max(64)
            .optional()
            .describe('o updatedAt lido no get_plan'),
          title: z.string().min(1).max(120).optional(),
          description: z.string().max(4_000).nullable().optional(),
          status: z.enum(['ativo', 'concluido', 'arquivado']).optional(),
          items: z
            .array(
              z.object({
                id: z.string().min(1).max(120).describe('id do item (vem do get_plan)'),
                title: z.string().min(1).max(120).optional(),
                objective: z.string().min(1).max(2_000).optional(),
                outOfScope: z.string().max(2_000).nullable().optional(),
                doneCriteria: z.array(z.string().max(400)).max(10).optional(),
                tier: z.enum(['pequeno', 'medio', 'grande']).nullable().optional(),
                context: z.string().max(2_000).nullable().optional(),
                dependsOn: z.array(z.string().max(120)).max(12).optional(),
                docPath: z.string().max(240).nullable().optional(),
                status: z
                  .enum(['planejada', 'em_andamento', 'descartada'])
                  .optional()
                  .describe('"concluida" não entra: ela vem da missão vinculada')
              })
            )
            .max(24)
            .optional(),
          addItems: z
            .array(
              z.object({
                key: z.string().max(60),
                title: z.string().min(1).max(120),
                objective: z.string().min(1).max(2_000),
                outOfScope: z.string().max(2_000).optional(),
                doneCriteria: z.array(z.string().max(400)).max(10),
                tier: z.enum(['pequeno', 'medio', 'grande']).optional(),
                context: z.string().max(2_000).optional(),
                dependsOn: z.array(z.string().max(120)).max(12),
                docPath: z.string().max(240).optional()
              })
            )
            .max(24)
            .optional(),
          removeItemIds: z
            .array(z.string().max(120))
            .max(24)
            .optional()
            .describe('item que já virou missão não sai: marque status descartada')
        }
      },
      async ({ planId, expectedUpdatedAt, ...patch }) =>
        text(api.updatePlan(identity, planId, patch as PlanPatch, expectedUpdatedAt))
    )

    server.registerTool(
      'delete_plan',
      {
        description:
          'ARQUIVA um plano (reversível): a aba some do mapa e o conteúdo fica. Exclusão definitiva não existe por ferramenta — é gesto do dono no mapa.',
        inputSchema: {
          planId: z.string().min(1).max(120),
          expectedUpdatedAt: z.string().max(64).optional()
        }
      },
      async ({ planId, expectedUpdatedAt }) =>
        text(api.deletePlan(identity, planId, expectedUpdatedAt))
    )

    return finishCatalog()
  }

  server.registerTool(
    'board_status',
    {
      description:
        'Estado atual do board do projeto: tarefas por status, execuções ativas e panes abertos. Use antes de responder sobre andamento.'
    },
    async () => text(api.boardStatus(identity))
  )

  // Somente o ORQUESTRADOR da missão altera o contrato do board. PM,
  // executores, reviewers e ajudantes entregam por suas ferramentas próprias.
  const isMissionOrchestrator = identity.role === 'maestro' && Boolean(identity.missionId)
  if (isMissionOrchestrator)
    server.registerTool(
    'create_tasks',
    {
      description:
        'Cria os cards previstos pelo plano aprovado. O backend aplica o orçamento do perfil: rápido = exatamente 1 card e zero ajudantes; equilibrado = até 4; aprofundado = até 12. Checklist não autoriza delegação. Declare deliverable; código preserva validação e non_code de risco alto recebe review.',
      inputSchema: {
        tasks: z
          .array(
            z.object({
              department: z.enum(DEPARTMENTS),
              type: z.enum(['feature', 'bug']).optional().describe('padrão: feature'),
              effort: z
                .enum(['leve', 'pesada'])
                .optional()
                .describe('peso da tarefa — decide o modelo que executa (padrão: leve)'),
              title: z
                .string()
                .max(60)
                .describe('CURTO e padronizado: "[TAG] descrição" (TAG: FRONT/BACK/DESIGN/QA/FIX/AJUSTE…), ≤40 chars, PT-BR'),
              description: z
                .string()
                .optional()
                .describe('2-4 frases terminando nos critérios de aceite'),
              briefing: z
                .string()
                .max(6000)
                .optional()
                .describe(
                  'YOU write the executor prompt, IN ENGLISH: instruct the dev like a tech lead — project context, what to do, what NOT to do, acceptance criteria. Becomes the literal pane prompt. Mention tools (generate_image, delegate) ONLY if this task needs them.'
                ),
              deliverable: z
                .enum(['code', 'non_code'])
                .describe(
                  'code = altera comportamento/configuração executável e mantém validação; non_code = documento, relatório, brief ou asset sem execução (zero gates em risco baixo/médio; review em risco alto)'
                ),
              dependsOn: z
                .array(z.string().uuid())
                .max(12)
                .optional()
                .describe(
                  'IDs de cards anteriores do MESMO plano que precisam terminar antes deste. Use somente para dependencia real entre ondas.'
                ),
              planItemId: z
                .string()
                .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/)
                .optional()
                .describe(
                  'ID estável do item correspondente no grafo de create_plan. Obrigatório nos planos novos; o backend deriva as dependências dele.'
                ),
              delegation: z
                .enum(['none', 'parallel'])
                .describe(
                  'OBRIGATÓRIO. none = o orquestrador decidiu execução direta; parallel = o orquestrador provou blocos longos e independentes, o backend roteia a persona e exige conclusão de ajudante. FAST força none.'
                ),
              gates: z
                .array(z.enum(['review', 'qa']))
                .optional()
                .describe(
                  'quality gates after dev. Código: omita para review+qa; redução só quando risco/critério justificar e nunca [] no código. non_code comum vira []; non_code de risco alto força review. Código de risco alto sempre força review+qa.'
                ),
              quests: z
                .array(z.string().max(200))
                .max(12)
                .optional()
                .describe(
                  'checklist do card (PT-BR). Vários itens continuam sendo um checklist; não significam ajudantes nem ondas.'
                ),
              affectsUi: z
                .boolean()
                .optional()
                .describe('REQUIRED for every code card, regardless of department: true when it changes any user-visible surface (including SSR/HTML/CSS); false for purely technical work. Omit only for non_code.'),
              skills: z
                .array(z.string())
                .max(1)
                .optional()
                .describe(
                  'at most ONE concrete technical method for this card, using an exact installed id from list_skills. UI direction is routed automatically; never stamp aesthetic stacks.'
                ),
              agents: z
                .array(z.string())
                .max(1)
                .optional()
                .describe(
                  'manual override of at most ONE installed specialist persona. Only valid with delegation=parallel; normally omit it because Synkora deterministically routes the best compatible persona from the card text.'
                )
            })
          )
          .min(1)
          .max(12)
      }
    },
    async ({ tasks }) => text(api.createTasks(identity, tasks))
  )

  if (isMissionOrchestrator)
    server.registerTool(
    'update_task',
    {
      description:
        'Ajusta briefing e conteúdo de um card desta missão (em backlog ou EM ANDAMENTO — patch em card rodando vale para as fases futuras; o pane atual não relê o briefing). Para mudar GATES contra o piso de risco, inclua ownerOrder com a ordem VERBATIM do dono.',
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        effort: z.enum(['leve', 'pesada']).optional(),
        ownerOrder: z
          .string()
          .max(600)
          .optional()
          .describe(
            'ordem VERBATIM do dono (ex.: resposta do ask_user) autorizando mudança de gates contra o piso de risco — sem ela o piso vale; auditada na caixa-preta'
          ),
        briefing: z
          .string()
          .max(6000)
          .optional()
          .describe('novo briefing completo do executor (prompt do pane; máximo 6000 caracteres)'),
        gates: z.array(z.enum(['review', 'qa'])).optional(),
        quests: z.array(z.string().max(200)).max(12).optional(),
        affectsUi: z
          .boolean()
          .optional()
          .describe('obrigatorio ao ajustar qualquer card code: declare se altera superficie visivel'),
        skills: z
          .array(z.string())
          .max(1)
          .optional()
          .describe('no máximo uma técnica concreta; direção visual é roteada automaticamente'),
        agents: z
          .array(z.string())
          .max(1)
          .optional()
          .describe('no máximo um especialista para subproblema independente'),
        deliverable: z.enum(['code', 'non_code']).optional(),
        delegation: z.enum(['none', 'optional', 'parallel']).optional(),
        gateNotes: z
          .object({
            review: z.string().max(2000).optional(),
            qa: z.string().max(2000).optional()
          })
          .optional()
          .describe(
            'notas suas anexadas ao PROMPT do gate quando ele abrir (review e/ou qa) — ex.: pontos de atenção do QA, expectativas específicas desta entrega; instrução de gate viaja no briefing, nunca em notify_pane pós-spawn'
          )
      }
    },
    async ({ id, ...patch }) => text(api.updateTask(identity, id, patch))
  )

  server.registerTool(
    'code_diagnostics',
    {
      description:
        'Diagnósticos estruturais TypeScript/JavaScript de um arquivo da sua worktree. Use depois de editar código e antes de report(done); se não houver LSP, a resposta orienta o fallback textual.',
      inputSchema: { path: codePath, limit: codeLimit, offset: codeOffset }
    },
    async ({ path, limit, offset }) =>
      text(await api.codeQuery(identity, { operation: 'diagnostics', path, limit, offset }))
  )

  server.registerTool(
    'code_definition',
    {
      description:
        'Localiza a definição do símbolo em uma posição TypeScript/JavaScript. Prefira antes de buscas textuais amplas.',
      inputSchema: {
        path: codePath,
        line: codeLine,
        column: codeColumn,
        limit: codeLimit,
        offset: codeOffset
      }
    },
    async ({ path, line, column, limit, offset }) =>
      text(
        await api.codeQuery(identity, {
          operation: 'definition',
          path,
          position: { line, column },
          limit,
          offset
        })
      )
  )

  server.registerTool(
    'code_references',
    {
      description:
        'Lista referências do símbolo na posição, ordenadas e paginadas, sempre restritas à worktree.',
      inputSchema: {
        path: codePath,
        line: codeLine,
        column: codeColumn,
        includeDeclaration: z.boolean().optional().describe('Padrão: true.'),
        limit: codeLimit,
        offset: codeOffset
      }
    },
    async ({ path, line, column, includeDeclaration, limit, offset }) =>
      text(
        await api.codeQuery(identity, {
          operation: 'references',
          path,
          position: { line, column },
          includeDeclaration,
          limit,
          offset
        })
      )
  )

  server.registerTool(
    'code_symbols',
    {
      description:
        'Lista os símbolos estruturais de um documento TypeScript/JavaScript, ordenados e paginados.',
      inputSchema: { path: codePath, limit: codeLimit, offset: codeOffset }
    },
    async ({ path, limit, offset }) =>
      text(await api.codeQuery(identity, { operation: 'symbols', path, limit, offset }))
  )

  server.registerTool(
    'code_hover',
    {
      description: 'Mostra tipo e documentação compacta do símbolo na posição indicada.',
      inputSchema: { path: codePath, line: codeLine, column: codeColumn }
    },
    async ({ path, line, column }) =>
      text(
        await api.codeQuery(identity, {
          operation: 'hover',
          path,
          position: { line, column }
        })
      )
  )

  server.registerTool(
    'code_implementations',
    {
      description:
        'Localiza implementações do símbolo na posição, ordenadas e paginadas dentro da worktree.',
      inputSchema: {
        path: codePath,
        line: codeLine,
        column: codeColumn,
        limit: codeLimit,
        offset: codeOffset
      }
    },
    async ({ path, line, column, limit, offset }) =>
      text(
        await api.codeQuery(identity, {
          operation: 'implementations',
          path,
          position: { line, column },
          limit,
          offset
        })
      )
  )

  server.registerTool(
    'code_call_hierarchy',
    {
      description:
        'Mostra chamadas de entrada, saída ou ambas para o símbolo na posição, com resultado limitado e paginado.',
      inputSchema: {
        path: codePath,
        line: codeLine,
        column: codeColumn,
        direction: z.enum(['incoming', 'outgoing', 'both']).optional().describe('Padrão: both.'),
        limit: codeLimit,
        offset: codeOffset
      }
    },
    async ({ path, line, column, direction, limit, offset }) =>
      text(
        await api.codeQuery(identity, {
          operation: 'call_hierarchy',
          path,
          position: { line, column },
          direction,
          limit,
          offset
        })
      )
  )

  server.registerTool(
    'activate_skill',
    {
      description:
        'Ativa UMA skill já selecionada no ACTIVE SKILL PLAN deste pane. Informe somente o receiptId fornecido pelo Synkora; a ferramenta valida pane/fase/rodada e devolve a instrução exata com o playbook escolhido.',
      inputSchema: {
        receiptId: z.string().min(1).max(160)
      }
    },
    async ({ receiptId }) => text(await api.activateSkill(identity, receiptId))
  )

  server.registerTool(
    'read_review_evidence',
    {
      description:
        'Lê um bloco autenticado do patch grande SHA-pinado e privado desta rodada de REVIEW. Comece em offset 0; use nextOffset para consultar blocos adicionais quando necessário e combine com a leitura dos changed paths na árvore entregue. Não aceita path nem acessa evidência de outro pane.',
      inputSchema: {
        offset: z.number().int().min(0).default(0),
        maxBytes: z.number().int().min(1024).max(65536).optional()
      }
    },
    async ({ offset, maxBytes }) => text(await api.readReviewEvidence(identity, offset, maxBytes))
  )

  server.registerTool(
    'report',
    {
      description:
        'Reporta o resultado do seu trabalho ao Synkora. dev/ajudante: status "done" quando 100% concluído; DEV de UI também pode usar "bloqueada" quando o pane não recebeu browser/runtime autorizado, sem fingir evidência visual. revisor/QA: "aprovada" ou "reprovada" com motivo — ou "bloqueada" quando um problema de AMBIENTE do harness impediu a validação. Bloqueio não afirma aplicação das skills. É isto que move a tarefa no pipeline.',
      inputSchema: {
        status: z.enum(['done', 'aprovada', 'reprovada', 'bloqueada']),
        reason: z
          .string()
          .max(4000)
          .optional()
          .describe('obrigatório quando reprovada/bloqueada: lista completa e fechada, sem itens omitidos'),
        summary: z.string().optional().describe('resumo de 1-2 frases do que foi feito'),
        suggestedPatch: z
          .string()
          .max(65536)
          .optional()
          .describe(
            'SÓ gates, junto de "reprovada": unified diff de correções TRIVIAIS/MECÂNICAS (token, atributo, rename, timeout) dos itens que você indicar no motivo. O harness grava em .synkora/reports/ (git-invisível) e o DEV aplica e assume a autoria. Mudança estrutural NUNCA vira patch — continua como item de lista.'
          ),
        skillApplications: z
          .array(z.string().min(1).max(160))
          .max(16)
          .optional()
          .describe(
            'receiptIds REQUIRED do ACTIVE SKILL PLAN que foram ativados e aplicados nesta entrega/veredito. Omita em bloqueada: bloqueio ambiental interrompe a rodada e não afirma aplicação.'
          ),
        verificationEvidence: gateVerificationEvidenceSchema
          .optional()
          .describe(
            'Evidencia estruturada do que foi realmente verificado. Obrigatoria em aprovacao de gate e em entrega/veredito de UI: summary + observations; UI tambem exige surfaces, states e viewports.'
          ),
        securityReview: securityReviewSchema
          .optional()
          .describe(
            'Revisão estruturada obrigatória no gate review quando o card tiver superfícies sensíveis. Não inclua segredos; falso positivo exige premissa refutada e evidência.'
          )
      }
    },
    async ({
      status,
      reason,
      summary,
      securityReview,
      suggestedPatch,
      skillApplications,
      verificationEvidence
    }) => {
      const gate = identity.role === 'review' || identity.role === 'qa'
      if (identity.role === 'maestro') {
        return text('status inválido: o Maestro não conclui trabalho pela tool report')
      }
      if (gate && status === 'done') {
        return text('status inválido: Reviewer/QA só aceitam aprovada, reprovada ou bloqueada')
      }
      if ((status === 'reprovada' || status === 'bloqueada') && !reason?.trim()) {
        return text('status inválido: reprovada/bloqueada precisa informar o motivo')
      }
      if (gate && status !== 'bloqueada' && !verificationEvidence) {
        return text(
          'status inválido: aprovada/reprovada precisa informar verificationEvidence com a evidência realmente verificada'
        )
      }
      if (status === 'bloqueada' && skillApplications?.length) {
        return text(
          'status inválido: bloqueada não aceita skillApplications porque nenhuma aplicação concluída está sendo afirmada'
        )
      }
      const devEnvironmentalBlock = identity.role === 'dev' && status === 'bloqueada'
      if (!gate && status !== 'done' && !devEnvironmentalBlock) {
        return text('status inválido: ajudante só aceita done; DEV aceita bloqueada apenas por falta de capacidade visual')
      }
      let guardSnapshot: PhaseWatch['devSnapshot']
      if (status === 'done') {
        const guard = await api.codeReportGuard(identity)
        if (guard.blocked) return text(guard.blocked)
        guardSnapshot = guard.devSnapshot
      }
      const content = status === 'done' ? 'done' : reason ? `${status}: ${reason}` : status
      return text(
        await api.report(
          identity,
          content,
          summary,
          securityReview,
          suggestedPatch,
          skillApplications,
          verificationEvidence,
          guardSnapshot
        )
      )
    }
  )

  server.registerTool(
    'check_messages',
    {
      description:
        'Drena sua caixa de mensagens do Synkora (avisos do app, do orquestrador e de outros agentes — mesmo vocabulário das linhas "[synkora]" do terminal). As mensagens também chegam SOZINHAS de carona no resultado das suas outras tools. LONG-POLL: com a caixa vazia esta tool SEGURA a resposta por até ~45s e retorna na hora em que algo chegar — UMA chamada é uma espera barata. Veio vazia e você segue só esperando? ENCERRE O TURNO e fique parado: custa zero contexto e o app te acorda com uma linha "[synkora] 📬" quando algo chegar (NUNCA chame em loop por minutos — cada chamada vazia queima contexto à toa).'
    },
    async () => {
      // F5-F3 (sondas R13 claude 45s+ · W2–W4 codex 75s+ e
      // tool_timeout_sec=300 de folga nos panes codex): caixa vazia NÃO
      // devolve vazio na hora — segura até chegar mensagem ou até o teto.
      // É o "acordar sem input" dos gates read-only (sem shell) e de todo
      // pane codex (que não tem waiter de background pós-turno — sonda W5).
      await api.waitForMail?.(identity, CHECK_MESSAGES_LONGPOLL_MS)
      return text(api.checkMessages(identity))
    }
  )

  if (identity.role === 'qa') {
    server.registerTool(
      'runtime_control',
      {
        description:
          'SÓ QA: comanda o runtime do produto que o HARNESS possui — o que uma pessoa faria sozinha, sem escalar. "restart" derruba e sobe de novo o dev server do worktree (opcionalmente numa PORTA sua escolha — ferramentas que aceitam recebem a flag certa; a convenção PORT= vai no ambiente); "status" mostra URL/estado; "stop" derruba. Runtime falhou? TENTE VOCÊ MESMO (restart, talvez com outra porta) ANTES de reportar "bloqueada" — bloqueada é para quando a ferramenta não alcança; escalar ao orquestrador/dono é o ÚLTIMO degrau.',
        inputSchema: {
          action: z.enum(['status', 'restart', 'stop']),
          port: z
            .number()
            .int()
            .min(1)
            .max(65535)
            .optional()
            .describe('porta desejada no restart (opcional)')
        }
      },
      async ({ action, port }) => text(await api.runtimeControl(identity, action, port))
    )
  }

  // Gates são principals somente leitura. O catálogo é a ACL: nenhuma tool
  // de delegação, imagem, helper, planejamento, integração ou escrita chega
  // sequer a ser anunciada ao Reviewer/QA. `report` é a única mutação e move
  // apenas o estado do pipeline, nunca arquivos do projeto.
  if (identity.role === 'review' || identity.role === 'qa') return finishCatalog()

  server.registerTool(
    'list_seats',
    {
      description:
        'Lista os seats (contas de CLI) e os MODELOS reais de cada um, com dicas de uso. Consulte ANTES de delegar para escolher deliberadamente o executor certo (modelo forte p/ raciocínio, rápido/barato p/ trabalho mecânico).'
    },
    async () => text(await api.listSeats())
  )

  server.registerTool(
    'list_skills',
    {
      description:
        'Pesquisa a BIBLIOTECA do Synkora sem despejar o catálogo inteiro: filtre por função, tipo ou texto. Retorna ids exatos, quando usar e estado de instalação para seleção deliberada.',
      inputSchema: {
        query: z.string().trim().max(120).optional().describe('necessidade ou termo curto, ex.: acessibilidade, postgres, planejamento'),
        kind: z.enum(['skill', 'agent']).optional().describe('skill ou subagente especializado'),
        department: z.enum(DEPARTMENTS).optional().describe('função do trabalho'),
        installedOnly: z.boolean().optional().describe('padrão true; use false apenas para descobrir algo que o usuário pode instalar'),
        limit: z.number().int().min(1).max(20).optional().describe('padrão 16; refine a consulta em vez de ampliar contexto')
      }
    },
    async ({ query, kind, department, installedOnly, limit }) =>
      text(api.listSkills(identity, { query, kind, department, installedOnly, limit }))
  )

  server.registerTool(
    'delegate',
    {
      description:
        'Abre ajudante(s) para blocos independentes autorizados pelo plano. FAST não abre; STANDARD permite até 2 e DEEP até 4. Todos trabalham no MESMO diretório, usam o mesmo tier do DEV e você supervisiona/integra. Quando o ACTIVE SKILL PLAN selecionar uma persona, omitir agent usa automaticamente essa persona; não invente outra.',
      inputSchema: {
        affectsUi: z
          .boolean()
          .optional()
          .describe('true somente se o subproblema altera uma superficie visivel'),
        prompt: z
          .string()
          .optional()
          .describe('instrução completa para o único ajudante'),
        dept: z
          .enum(DEPARTMENTS)
          .optional()
          .describe('usa a política de seat/modelo do departamento (opcional)'),
        seatId: z.string().optional().describe('seat escolhido (veja list_seats)'),
        model: z
          .string()
          .optional()
          .describe('modelo escolhido — case com o trabalho (ex.: barato p/ varredura/copy)'),
        effort: z
          .string()
          .optional()
          .describe('effort de raciocínio do ajudante (ex.: low p/ mecânico, high p/ difícil)'),
        title: z.string().optional().describe('título curto do pane'),
        skills: z
          .array(z.string())
          .max(1)
          .optional()
          .describe('no máximo uma técnica concreta; o roteador completa o contrato da fase quando aplicável'),
        agent: z
          .string()
          .optional()
          .describe(
            'SUBAGENTE especializado da biblioteca (id do list_skills com tipo=subagente): o ajudante nasce com essa persona no lugar do genérico — use quando o trabalho casa com um especialista (siga o conselho do orquestrador)'
          ),
        helpers: z
          .array(
            z.object({
              affectsUi: z
                .boolean()
                .optional()
                .describe('true somente se este subproblema altera uma superficie visivel'),
              prompt: z.string().describe('instrução completa deste ajudante'),
              dept: z.enum(DEPARTMENTS).optional().describe('política de seat/modelo do departamento'),
              seatId: z.string().optional().describe('seat escolhido (veja list_seats)'),
              model: z.string().optional().describe('modelo escolhido'),
              effort: z.string().optional().describe('effort de raciocínio'),
              title: z.string().optional().describe('título curto do pane'),
              skills: z
                .array(z.string())
                .max(1)
                .optional()
                .describe('no máximo uma técnica concreta para este ajudante'),
              agent: z
                .string()
                .optional()
                .describe('subagente especializado da biblioteca para este ajudante (tipo=subagente)')
            })
          )
          .min(1)
          .max(1)
          .optional()
          .describe(
            'Formato alternativo para um único ajudante; arrays com mais de um item são recusados'
          )
      }
    },
    async (opts) => {
      const list: DelegateOpts[] = opts.helpers?.length
        ? opts.helpers
        : opts.prompt
          ? [
              {
                prompt: opts.prompt,
                dept: opts.dept,
                seatId: opts.seatId,
                model: opts.model,
                effort: opts.effort,
                title: opts.title,
                affectsUi: opts.affectsUi,
                skills: opts.skills,
                agent: opts.agent
              }
            ]
          : []
      if (!list.length)
        return text('informe "prompt" ou "helpers" com exatamente um ajudante')
      return text(await api.delegateMany(identity, list))
    }
  )

  // CONTROLE dos ajudantes: o delegador enxerga o estado, lê a saída, digita
  // respostas (destravar prompts/escolher opções) e encerra quando precisar.
  server.registerTool(
    'list_helpers',
    {
      description:
        'Lista os ajudantes que VOCÊ abriu via delegate: paneId, estado (rodando/esperando/morto) e última linha da saída. Use para acompanhar; combine com helper_output/helper_send/helper_close.'
    },
    async () => text(api.listHelpers(identity))
  )

  server.registerTool(
    'helper_output',
    {
      description:
        'Lê o TRANSCRIPT de um ajudante seu (limpo e em ordem; ~2s de atraso do vivo). Funciona até depois do pane fechar — e quando você lê o transcript COMPLETO de um ajudante já encerrado, o arquivo se apaga sozinho (sem lixo na pasta).',
      inputSchema: {
        paneId: z.string().describe('paneId do ajudante (veja list_helpers)'),
        chars: z.number().optional().describe('quantos caracteres do final (padrão 3000)')
      }
    },
    async ({ paneId, chars }) => text(api.helperOutput(identity, paneId, chars))
  )

  server.registerTool(
    'helper_send',
    {
      description:
        'Digita uma linha no pane de um ajudante seu e ENVIA (Enter). Use para responder perguntas dele, escolher opção por número em prompts, ou dar instrução extra. Texto vazio = só Enter.',
      inputSchema: {
        paneId: z.string().describe('paneId do ajudante (veja list_helpers)'),
        message: z.string().max(2000).describe('o que digitar (ex.: "1", "y", instrução curta)')
      }
    },
    async ({ paneId, message }) => text(api.helperSend(identity, paneId, message))
  )

  server.registerTool(
    'helper_close',
    {
      description:
        'ENCERRA o pane de um ajudante seu (trabalho cancelado/duplicado/travado). O transcript fica em .synkora/runs/helper-*.md.',
      inputSchema: {
        paneId: z.string().describe('paneId do ajudante (veja list_helpers)')
      }
    },
    async ({ paneId }) => text(api.helperClose(identity, paneId))
  )

  server.registerTool(
    'generate_image',
    {
      description:
        'Gera uma imagem com o provedor configurado no Synkora e salva no projeto. Retorna o caminho do arquivo.',
      inputSchema: {
        prompt: z.string().describe('descrição detalhada da imagem'),
        fileName: z.string().optional().describe('nome do arquivo de saída (sem extensão)')
      }
    },
    async ({ prompt, fileName }) => text(await api.generateImage(identity, prompt, fileName))
  )

  // F5.7 — tools do ORQUESTRADOR (maestro COM missão): a missão é dirigida por
  // PLANO. create_plan propõe o card que o usuário lê/aprova; run_task dá ao
  // orquestrador o gatilho de execução (antes era o ▶ do usuário);
  // conclude_plan fecha o ciclo com a conclusão no card.
  if (identity.role === 'maestro' && identity.missionId) {
    server.registerTool(
      'create_plan',
      {
        description:
          'Cria (ou substitui antes da aprovação) o plano proporcional da missão. Você DEVE classificar tamanho e risco separadamente. fast: 1 lane, 1 card, sem ondas/ajudantes; standard: até 4 cards; deep: até 12 e ondas somente por dependência. Se a realidade exceder o orçamento, reclassifique e peça nova aprovação — nunca esconda cards extras.',
        inputSchema: {
          title: z
            .string()
            .max(60)
            .describe('título curto do plano, PT-BR (ex.: "Plano — tela de login")'),
          summary: z
            .string()
            .max(8000)
            .describe(
              'markdown PT-BR em LINGUAGEM LEIGA (o usuário não é programador): explique de forma simples o que vai mudar e por quê — o que a pessoa vai VER/sentir de diferente, em que ordem. Sem jargão técnico (z-index, DOM, IIFE, refactor…); termo técnico inevitável = explique em palavras comuns na mesma frase. Parágrafos curtos e listas.'
            ),
          executionMode: z
            .enum(['fast', 'standard', 'deep'])
            .describe('fast=1 área/1 card; standard=feature comum até 4 cards; deep=dependências/ondas até 12'),
          risk: z
            .enum(['low', 'medium', 'high'])
            .describe('classificação declarada; o backend aplica pisos proporcionais às superfícies e sinais concretos'),
          riskSurfaces: z
            .array(z.enum(PLAN_RISK_SURFACES))
            .max(PLAN_RISK_SURFACES.length)
            .default([])
            .describe(
              'superfícies tipadas realmente presentes no escopo. Não marque por palavra solta; o backend também inspeciona o texto e pode elevar o risco.'
            ),
          sizingReason: z
            .string()
            .min(10)
            .max(300)
            .describe('uma frase concreta explicando por que este tamanho e risco são proporcionais'),
          expectedCards: z
            .number()
            .int()
            .min(1)
            .max(12)
            .describe('orçamento total de cards deste plano, incluindo ondas futuras'),
          workItems: z
            .array(
              z.object({
                id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
                title: z.string().min(1).max(100),
                department: z.enum(DEPARTMENTS),
                deliverable: z.enum(['code', 'non_code']),
                waveId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/),
                dependsOn: z.array(z.string().max(80)).max(12).default([])
              })
            )
            .min(1)
            .max(12)
            .describe(
              'Grafo completo e tipado dos cards: uma entrada por card previsto. Cards da mesma onda são independentes; dependências apontam somente para IDs de ondas anteriores.'
            ),
          lanes: z
            .array(
              z.object({
                dept: z.enum(DEPARTMENTS),
                notes: z
                  .string()
                  .max(200)
                  .optional()
                  .describe('1 linha, PT-BR: o que essa função fará neste plano'),
                seatId: z.string().optional().describe('seat sugerido (veja list_seats)'),
                model: z
                  .string()
                  .optional()
                  .describe('model ID sugerido (nunca display name)'),
                effort: z.string().optional().describe('effort sugerido (ex.: medium, high)')
              })
            )
            .min(1)
            .max(8)
            .describe('funções que trabalharão no plano — inclua "qa" para customizar os gates'),
          skillApplications: z
            .array(z.string().min(1).max(160))
            .length(1)
            .describe('receiptId obrigatório do ACTIVE PLANNING METHOD ativado nesta rodada')
        }
      },
      async (input) => text(await api.createPlan(identity, input))
    )

    server.registerTool(
      'run_task',
      {
        description:
          'DISPARA a execução de um card desta missão (pipeline real: dev → gates → merge na branch da missão). Só funciona com o plano APROVADO — é você quem inicia os cards, nunca o usuário. Recusa por limite de execuções paralelas = aguarde um evento de conclusão e tente de novo. Com phase:"review"/"qa", REABRE APENAS aquele gate sobre o worktree existente. Com phase:"finalize", RE-TENTA somente a integração de um card já APROVADO cujo merge foi bloqueado (reparo de integração — resolva antes a causa no destino; nenhuma fase é repetida). Com adjustment, uma correção pequena pós-entrega reabre ESTE MESMO card em rodada QUICK (ajuste rápido do dono): protocolo cortado — dev faz só o delta com checks/evidência proporcionais, review vira olhada-relâmpago só no diff, QA não abre; skills e barra de qualidade seguem INTEIRAS. Pedido pequeno do dono (copy, formatação, máscara, espaçamento, um elemento) = adjustment, sempre.',
        inputSchema: {
          id: z.string().describe('id do card (create_tasks devolve; board_status lista)'),
          phase: z
            .enum(['review', 'qa', 'finalize'])
            .optional()
            .describe('review/qa: reabre SÓ este gate sobre o worktree existente — não repete o dev. finalize: re-tenta SÓ o merge de um card aprovado com integração bloqueada'),
          adjustment: z
            .string()
            .trim()
            .min(1)
            .max(1200)
            .optional()
            .describe('correção pequena pedida pelo usuário APÓS a entrega; reabre este MESMO card em FAST e não pode ser combinada com phase')
        }
      },
      async ({ id, phase, adjustment }) =>
        text(await api.runTask(identity, id, phase, adjustment))
    )

    server.registerTool(
      'delete_task',
      {
        description:
          'Remove um card AUTO desta missão que NÃO será feito (replanejamento/duplicado). Só cards criados por você no modo plano, nunca em execução/QA. Cards do usuário não se removem por aqui.',
        inputSchema: {
          id: z.string().describe('id do card a remover')
        }
      },
      async ({ id }) => text(api.deleteTask(identity, id))
    )

    server.registerTool(
      'conclude_plan',
      {
        description:
          'INICIA o encerramento verificável do plano. Chame quando TODO o trabalho estiver entregue: o backend confere a quantidade/grafo, evidências read-only dos gates e roda checks proporcionais na branch da missão já reunida. O card só vira done após essa fotografia passar; falha mantém o plano aberto e devolve correção ao orquestrador. A PRIMEIRA integração continua exigindo aval explícito. Na retomada da fila, a autorização original é reutilizada automaticamente depois da nova verificação.',
        inputSchema: {
          conclusion: z
            .string()
            .max(8000)
            .describe(
              'markdown PT-BR em LINGUAGEM LEIGA: o que mudou do ponto de vista de quem USA (o que ficou diferente na tela/comportamento), o que foi criado, decisões e o que ficou de fora — tudo explicado simples, sem jargão; arquivos podem ser citados, mas diga o que cada um é em palavras comuns'
            )
        }
      },
      async ({ conclusion }) => text(await api.concludePlan(identity, conclusion))
    )
  }

  // create_mission é do PM (maestro sem missão); integrate_mission vale para
  // o PM (informando o id) e para o orquestrador (a própria missão).
  if (identity.role === 'maestro' && !identity.missionId) {
    const projectPlanScopeSchema = z.object({
      in: z.array(z.string().max(300)).max(80),
      out: z.array(z.string().max(300)).max(80)
    })
    const projectPlanVersionSchema = z.object({
      id: z.string().max(120).optional(),
      name: z.string().min(1).max(40),
      theme: z.string().max(160).optional(),
      goal: z.string().max(800).optional()
    })
    const projectPlanWaveSchema = z.object({
      id: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/)
        .describe('id estável da onda, ex.: O01-fundacao'),
      name: z.string().min(1).max(100).optional().describe('nome legível da onda')
    })

    server.registerTool(
      'save_project_plan',
      {
        description:
          'Salva ou revisa, inclusive PARCIALMENTE durante a descoberta, o PLANO MESTRE de um projeto do zero em .synkora/PROJECT_PLAN.json + PROJECT_PLAN.md. Envie somente os campos decididos nesta rodada; os demais permanecem como estavam. Listas e roadmap usam merge seguro por padrão; replace só após uma revisão explícita do conjunto/mapa inteiro. Itens já ligados a missões reais nunca são reescritos/apagados. Isto não abre missões.',
        inputSchema: {
          projectName: z.string().max(100).optional(),
          problem: z.string().max(3000).optional().describe('problema real que o produto resolve'),
          audience: z.string().max(2000).optional().describe('para quem o produto é construído'),
          vision: z.string().max(4000).optional().describe('norte e resultado desejado do produto'),
          successCriteria: z
            .array(z.string().min(1).max(500))
            .max(50)
            .optional()
            .describe('sinais verificáveis de que o projeto deu certo'),
          constraints: z
            .array(z.string().min(1).max(500))
            .max(50)
            .optional()
            .describe('limites técnicos, de negócio, prazo ou orçamento já decididos'),
          scope: projectPlanScopeSchema.partial().optional(),
          decisions: z
            .array(z.string().min(1).max(800))
            .max(100)
            .optional()
            .describe('decisões aprovadas e motivos que não podem se perder'),
          listMode: z
            .enum(['merge', 'replace'])
            .optional()
            .describe('merge (padrão) acrescenta sem apagar listas anteriores; replace troca por inteiro somente as listas enviadas'),
          roadmapMode: z
            .enum(['merge', 'replace'])
            .optional()
            .describe('merge (padrão) atualiza/insere por id sem apagar omitidos; replace troca somente itens ainda sem missão real'),
          roadmapMeta: z
            .object({
              expectedCount: z
                .number()
                .int()
                .min(1)
                .max(200)
                .optional()
                .describe('quantidade total esperada de missões no mapa completo'),
              complete: z
                .boolean()
                .describe('true somente quando o roadmap inteiro foi salvo e revisado; false durante os lotes')
            })
            .optional(),
          roadmap: z
            .array(
              z.object({
                id: z
                  .string()
                  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/)
                  .describe('id estável e curto, ex.: M01-fundacao'),
                title: z.string().min(1).max(80),
                objective: z.string().min(1).max(3000),
                wave: projectPlanWaveSchema.describe(
                  'onda obrigatória; missões prontas da mesma onda podem ser abertas em paralelo'
                ),
                dependsOn: z.array(z.string().max(40)).max(30).optional(),
                scope: projectPlanScopeSchema.partial().optional(),
                acceptanceCriteria: z
                  .array(z.string().min(1).max(600))
                  .min(1)
                  .max(30),
                version: projectPlanVersionSchema.optional()
              })
            )
            .max(200)
            .optional()
            .describe(
              'missões futuras em ordem lógica, agrupadas em ondas; até 200 por chamada. Para mapas de 50–150 missões, prefira lotes com roadmapMode=merge e roadmapMeta.complete=false até o lote final'
            ),
          planningStage: z
            .enum(['discovery', 'scope', 'decisions', 'roadmap', 'review'])
            .describe('etapa concreta desta gravação do plano'),
          planningContribution: z
            .string()
            .min(1)
            .max(1000)
            .describe('resultado concreto que o método produziu nesta revisão'),
          skillApplications: z
            .array(z.string().min(1).max(160))
            .length(1)
            .describe('receiptId obrigatório do ACTIVE PLANNING METHOD ativado nesta rodada')
        }
      },
      async (input) => text(api.saveProjectPlan(identity, input))
    )

    server.registerTool(
      'approve_project_plan',
      {
        description:
          'SOLICITA ao dono a aprovação do plano mestre. Esta tool NUNCA aprova o roadmap: o status só muda quando o usuário abre o Mapa e clica em “aprovar roadmap”.',
        inputSchema: {}
      },
      async () => text(api.approveProjectPlan(identity))
    )

    server.registerTool(
      'start_project_mission',
      {
        description:
          'SOLICITA ao dono a abertura de UMA missão pronta do roadmap. Esta tool NUNCA cria a missão: cada item só abre quando o usuário confirma o alvo específico no Mapa.',
        inputSchema: {
          itemId: z.string().min(1).max(40).describe('id do item do roadmap, ex.: M01-fundacao')
        }
      },
      async ({ itemId }) => text(api.startProjectMission(identity, itemId))
    )

    server.registerTool(
      'guide_integration_resolution',
      {
        description:
          'SÓ depois de a fila de integração registrar um CONFLITO: persiste a estratégia decidida pelo Maestro. Dois modos: (1) padrão — a estratégia vai ao orquestrador da missão num card de sincronização com gates; (2) directResolution=true — para conflito MECÂNICO (dep/lockfile/grafia, zero lógica nova) que VOCÊ mesmo já resolveu na branch da missão (merge do destino + commit ANTES de chamar): o ticket é re-lacrado no head novo e a fila retoma sozinha com o aval original do dono, sem card. A régua mecânico×semântico é seu julgamento e fica auditada verbatim; na dúvida, use o fluxo com card. O usuário só participa se existir uma decisão real de produto — não por mecânica de Git.',
        inputSchema: {
          missionId: z.string().min(1).max(120).describe('id da missão bloqueada na fila'),
          instruction: z
            .string()
            .min(1)
            .max(8000)
            .describe(
              'orientação concreta e executável: intenção a preservar, arquivos/choques relevantes, estratégia escolhida e verificações exigidas (no modo direto: o que você resolveu e por que é mecânico)'
            ),
          directResolution: z
            .boolean()
            .optional()
            .describe(
              'true = você JÁ resolveu o conflito mecanicamente na branch da missão e commitou; o harness valida (árvore limpa + destino contido), re-lacra e retoma a fila sem card'
            )
        }
      },
      async ({ missionId, instruction, directResolution }) =>
        text(api.guideIntegrationResolution(identity, missionId, instruction, directResolution))
    )

    server.registerTool(
      'queue_missions',
      {
        description:
          'Coloca VÁRIAS missões concluídas na fila FIFO de integração em uma única operação, preservando a ordem informada. Use quando o usuário autorizar integrar uma onda/lote inteiro. Cada missão continua sendo validada; nenhuma entra se seu plano/cards ainda estiverem abertos. Exige aval explícito do usuário.',
        inputSchema: {
          missionIds: z
            .array(z.string().min(1).max(120))
            .min(1)
            .max(50)
            .describe('ids das missões, na ordem desejada para a fila')
        }
      },
      async ({ missionIds }) => text(api.queueMissions(identity, missionIds))
    )

    server.registerTool(
      'create_mission',
      {
        description:
          'Cria uma MISSÃO PONTUAL: fluxo com orquestrador próprio, tarefas próprias e (com git) branch/worktree isolados. Em projeto EXISTENTE, use para feature/bug/melhoria focada. Em projeto GREENFIELD com plano mestre, a sequência planejada usa start_project_mission — nunca crie o roadmap inteiro por aqui.',
        inputSchema: {
          title: z.string().max(60).describe('título curto, em PT-BR'),
          goal: z.string().optional().describe('objetivo em 1-3 frases (PT-BR)'),
          scope: z
            .string()
            .optional()
            .describe('escopo declarado: áreas/paths que a missão vai tocar'),
          version: z
            .string()
            .optional()
            .describe('nome da VERSÃO do app (ex.: "v1.1") — a missão integra na branch da versão, não na main'),
          skillApplications: z
            .array(z.string().min(1).max(160))
            .length(1)
            .describe('receiptId obrigatório do ACTIVE PLANNING METHOD ativado nesta rodada')
        }
      },
      async (input) => text(api.createMission(identity, input))
    )

    server.registerTool(
      'release_version',
      {
        description:
          'SOLICITA ao dono o release de uma versão. Esta tool NUNCA faz merge nem publica: o release só acontece quando o usuário abre a versão e confirma “subir agora” no aplicativo.',
        inputSchema: {
          version: z.string().describe('nome da versão a subir (ex.: "v1.1")')
        }
      },
      async ({ version }) => text(await api.releaseVersion(identity, version))
    )

    server.registerTool(
      'set_release_hold',
      {
        description:
          'Liga/desliga o HOLD de release do projeto. Com hold ativo NENHUMA versão sobe para a main (nem pelo botão do usuário). Use ANTES de qualquer verificação longa na linha de dev (testes, auditoria da branch da versão) e desligue ao terminar — o hold protege a sua verificação de um release no meio dela.',
        inputSchema: {
          on: z.boolean().describe('true = segurar releases; false = liberar'),
          reason: z
            .string()
            .max(200)
            .optional()
            .describe('obrigatório ao ligar: o que está sendo verificado')
        }
      },
      async ({ on, reason }) => text(api.setReleaseHold(identity, on, reason))
    )

    server.registerTool(
      'remove_backlog_item',
      {
        description:
          'SOLICITA ao dono a remoção de um item aberto. Esta tool NUNCA apaga: o item só sai quando o usuário confirma o alvo específico na aba Versões.',
        inputSchema: {
          item: z.string().describe('id do item OU trecho do título (único)')
        }
      },
      async ({ item }) => text(api.removeBacklogItem(identity, item))
    )

    server.registerTool(
      'archive_mission',
      {
        description:
          'ARQUIVA uma missão ativa (superada por outra decisão, travada, abandonada): mata o pane do orquestrador e tira a missão do board — a BRANCH fica preservada (reativável na aba Versões). Faça VOCÊ MESMO quando uma decisão do usuário supera uma missão; NUNCA peça para o humano "arquivar pelo board". Informe o id ou um trecho único do título.',
        inputSchema: {
          mission: z.string().describe('id da missão (ou trecho único do título)')
        }
      },
      async ({ mission }) => text(api.archiveMission(identity, mission))
    )

    // set_default_skills não existe: kit persistente mistura métodos entre
    // tarefas. O roteador escolhe uma técnica por fase e por necessidade.
  }

  server.registerTool(
    'integrate_mission',
    {
      description:
        'REGISTRA A INTENÇÃO de integrar a missão — o merge NUNCA acontece por esta tool: com a missão pronta, o botão ⇪ dela pulsa no board e SÓ O CLIQUE DO DONO coloca a missão na fila FIFO de integração (porteira mecânica; ausência do dono NUNCA é consentimento — se ele demorar, ask_user e ESPERE). A fila processa uma missão por vez contra a base (ou branch da versão) mais recente, sem gate extra porque o trabalho já passou por review, QA e aceite. A fila é a única dona do card operacional de sincronização/conflito: não crie outro em paralelo. Se o item da frente conflitar, a fila pausa, preserva a branch e pede ao Maestro uma estratégia; após o orquestrador executar o card, passar os checks e chamar conclude_plan, o backend retoma automaticamente a autorização original sem uma segunda chamada nem novo aval. Orquestrador: só a própria missão (não passe id). PM: informe missionId.',
      inputSchema: {
        missionId: z.string().optional().describe('id da missão (PM); orquestrador omite')
      }
    },
    async ({ missionId }) => text(api.integrateMission(identity, missionId))
  )

  server.registerTool(
    'set_phase_executor',
    {
      description:
        'SOLICITA ao dono uma troca de conta/modelo/effort para uma fase. A tool NUNCA altera o executor nem respawna o pane: a mudança só acontece pelo controle humano do próprio card. Sem ordem explícita, use ask_user e espere.',
      inputSchema: {
        taskId: z.string().describe('id do card'),
        seat: z.string().describe('conta destino: NOME exato do list_seats (ou id)'),
        ownerOrder: z
          .string()
          .max(600)
          .describe('a ordem do dono, VERBATIM (vai para a auditoria — sem ela a tool recusa)'),
        model: z.string().optional().describe('modelo (id, nunca display name); omita para manter'),
        effort: z.string().optional().describe('effort; omita para manter o carimbo atual')
      }
    },
    async ({ taskId, seat, ownerOrder, model, effort }) =>
      text(await api.setPhaseExecutor(identity, taskId, seat, ownerOrder, model, effort))
  )

  server.registerTool(
      'notify_maestro',
      {
        description:
          'Envia um aviso curto para cima na hierarquia: executor/reviewer/ajudante de uma missão → ORQUESTRADOR da missão; o próprio orquestrador ou um agente sem missão → Maestro/PM do projeto. Aparece no terminal de destino com o SEU paneId de origem. Use também para pedir CONSELHO DE DELEGAÇÃO: diga quantos ajudantes quer e o que cada um fará — a resposta volta ao SEU terminal.',
      inputSchema: { text: z.string().max(1200) }
    },
    async ({ text: t }) => text(api.notifyMaestro(identity, t))
  )

  server.registerTool(
    'ask_user',
    {
      description:
        'SÓ Maestro/orquestrador: registra uma pergunta dirigida ao USUÁRIO (o dono). Escreva a pergunta completa no seu terminal E chame esta tool com a mesma pergunta em 1 linha — a aba correspondente do board PULSA até o usuário abrir; sem isto, uma pergunta em prosa pode ficar sem ser vista indefinidamente (o usuário não olha todas as abas). OBRIGATÓRIA em toda escalação ao usuário (inclusive a escada anti-loop). Depois de chamar, AGUARDE a resposta no seu terminal.',
      inputSchema: {
        question: z.string().max(500).describe('a pergunta, em 1 linha PT-BR')
      }
    },
    async ({ question }) => text(api.askUser(identity, question))
  )

  server.registerTool(
    'declare_runtime_paths',
    {
      description:
        'SÓ Maestro/orquestrador: declara os caminhos de RUNTIME do produto — arquivos RASTREADOS que o app GRAVA ao rodar (ex.: ["data"]). Com a allowlist declarada, sujeira de gate composta SÓ de modificação nesses caminhos é RESTAURADA ao commit julgado pelo harness e o veredito SOBREVIVE (mata o loop "QA roda o app → árvore suja → veredito descartado → volta ao dev sem defeito"). Envie a lista COMPLETA (substitui a anterior; [] limpa). A correção definitiva continua sendo o produto gravar runtime FORA de caminho rastreado — declare E crie o card.',
      inputSchema: {
        paths: z
          .array(z.string().max(200))
          .max(12)
          .describe('caminhos relativos ao repo (ex.: ["data"]); lista completa, substitui a anterior')
      }
    },
    async ({ paths }) => text(api.declareRuntimePaths(identity, paths))
  )

  // AUTONOMIA (ordem do dono 2026-08-10): registrado APÓS o corte de catálogo
  // dos gates (finishCatalog) — gate read-only nunca VÊ ferramenta de
  // autoridade; a cerca é de catálogo, não só de guard na api.
  server.registerTool(
    'complete_task',
    {
      description:
        'SÓ Maestro/orquestrador — SUA AUTORIDADE sobre os cards AUTO do seu plano: conclui um card DIRETO, sem rodar fase nenhuma, quando A SEU JUÍZO o trabalho já existe e está validado (ex.: entrega já commitada e conferida, gate já aprovou o mesmo commit em rodada descartada, estado que só falta carimbar). O harness encerra panes/esperas/runtime do card, marca done e registra gates faltantes como "waived" COM O SEU MOTIVO — juízo auditado verbatim na caixa-preta, nunca evidência fabricada. NÃO mescla a branch task/<id8> do card na branch da missão: se a entrega ainda vive só lá, o merge é seu (git merge --no-ff — sua branch, sua autoridade). Use com honestidade: a verificação conjunta do conclude_plan e o clique ⇪ do dono continuam sendo as cercas do merge. reason é OBRIGATÓRIO (1-2 frases com a sua evidência).',
      inputSchema: {
        id: z.string().describe('id do card'),
        reason: z
          .string()
          .max(600)
          .describe('por que o trabalho já está pronto/validado — auditado verbatim')
      }
    },
    async ({ id, reason }) => text(api.completeTask(identity, id, reason))
  )

  server.registerTool(
    'stop_task',
    {
      description:
        'SÓ Maestro/orquestrador — SUA AUTORIDADE sobre os panes da sua missão (o gêmeo do complete_task): PARA deliberadamente a fase em execução de um card — fecha o pane, preserva TODO o trabalho (worktree, commits e a conversa para resume futuro) e devolve o card ao BACKLOG como interrompido, SEM contar ciclo. Use quando um executor não deve continuar agora (ex.: test card que só roda depois do aceite do dono; retrabalho vindo; pane rodando à toa). NÃO fabrica veredito: parar um gate encerra a rodada SEM veredito e run_task {id, phase} reabre depois. run_task {id} retoma o card quando você decidir. reason é OBRIGATÓRIO (auditado verbatim).',
      inputSchema: {
        id: z.string().describe('id do card'),
        reason: z
          .string()
          .max(600)
          .describe('por que está parando este card agora — auditado verbatim')
      }
    },
    async ({ id, reason }) => text(api.stopTask(identity, id, reason))
  )

  server.registerTool(
    'record_learnings',
    {
      description:
        'SÓ Maestro/orquestrador — DOCUMENTAÇÃO AUTOMÁTICA DE SESSÃO: destila o que esta missão/sessão ENSINOU num tópico durável de .synkora/maestro/ (a estante que alimenta as sessões futuras: decisões de arquitetura, pegadinhas, contratos criados, pedras que derrubaram missão). Envie o CONTEÚDO COMPLETO do tópico reescrito (5-15 linhas destiladas; LEIA o tópico atual antes de reescrever — a tool guarda um .bak de um nível). NÃO grave o que o board_status/git já respondem (estado consultável nunca vira prosa); grave o que só quem viveu a sessão sabe. Chame no FECHAMENTO da missão (conclude_plan) e em qualquer decisão durável no meio do caminho.',
      inputSchema: {
        topic: z
          .string()
          .max(48)
          .describe('nome curto do tópico em kebab-case (ex.: "telas", "dados-runtime", "licoes")'),
        content: z
          .string()
          .max(8000)
          .describe('o tópico REESCRITO por inteiro, destilado (5-15 linhas; nunca um log)')
      }
    },
    async ({ topic, content }) => text(api.recordLearnings(identity, topic, content))
  )

  server.registerTool(
    'status_note',
    {
      description:
        'Registra UMA frase curta (PT-BR, ≤120 chars) de "o que estou fazendo agora" no radar de andamento do dono — ele acompanha o Synkora sem abrir o app. Chame ao COMEÇAR cada etapa distinta (ler código, escrever testes, corrigir itens da revisão, aguardar algo) e quando o quadro mudar. Sobrescreve a nota anterior; barata, nunca bloqueia, disponível a todo papel.',
      inputSchema: {
        text: z.string().max(200).describe('a frase, em 1 linha PT-BR')
      }
    },
    async ({ text: t }) => text(api.statusNote(identity, t))
  )

  server.registerTool(
    'register_direct_mission',
    {
      description:
        'Registra trabalho feito DIRETO na base (agente livre): cria uma missão "direta" — nasce concluída, sem cards nem orquestrador, só a história — para o PM saber o que mudou. Chame UMA vez ao fim de uma sessão de mudanças relacionadas, com os pontos do que foi mexido.',
      inputSchema: {
        title: z.string().max(60).describe('título curto do trabalho (PT-BR)'),
        points: z
          .array(z.string().max(200))
          .min(1)
          .max(20)
          .describe('pontos do que foi arrumado/mudado, um por linha')
      }
    },
    async ({ title, points }) => text(api.registerDirectMission(identity, title, points))
  )

  server.registerTool(
    'notify_pane',
    {
      description:
        'SÓ Maestro/orquestrador: envia uma linha direta para o TERMINAL de qualquer pane do seu escopo — dev, review, QA (reforçar escopo, responder plano de delegação, corrigir rumo). NUNCA ajudante: quem fala com ajudante é o dev que o abriu. ENDEREÇO ESTÁVEL: prefira {taskId, role} — o app resolve o pane VIVO daquele card+papel (paneIds morrem com o pane; o card não). paneId sozinho também funciona: se estiver morto, o app reencaminha ao pane atual do mesmo card+papel quando existir.',
      inputSchema: {
        paneId: z
          .string()
          .optional()
          .describe('paneId de destino (evento pane-open ou list_panes) — opcional com taskId+role'),
        taskId: z
          .string()
          .optional()
          .describe('id do card — endereço estável; com role, o app resolve o pane vivo'),
        role: z
          .enum(['dev', 'review', 'qa'])
          .optional()
          .describe('papel do pane do card (junto com taskId)'),
        text: z.string().max(1200).describe('a mensagem — curta e acionável')
      }
    },
    async ({ paneId, taskId, role, text: t }) =>
      text(await api.notifyPane(identity, { paneId, taskId, role }, t))
  )

  server.registerTool(
    'list_panes',
    {
      description:
        'SÓ Maestro/orquestrador: lista os panes vivos do seu escopo (missão inteira para o orquestrador; projeto para o PM) com paneId, papel (dev/review/qa/ajudante), card e estado. É a lista de com quem o notify_pane pode falar.'
    },
    async () => text(api.listPanes(identity))
  )

  return finishCatalog()
}

export interface McpServerHandle {
  port: number
  close: () => Promise<void>
}

type AuthenticatedIncomingMessage = IncomingMessage & { auth?: AuthInfo }

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice(7).trim()
  return token && !/\s/u.test(token) ? token : null
}

function isMcpPath(url: string | undefined): boolean {
  if (!url) return false
  try {
    return new URL(url, 'http://127.0.0.1').pathname === '/mcp'
  } catch {
    return false
  }
}

function isPath(url: string | undefined, pathname: string): boolean {
  if (!url) return false
  try {
    return new URL(url, 'http://127.0.0.1').pathname === pathname
  } catch {
    return false
  }
}

function identityForRequest(api: McpApi, context: McpRequestContext): PaneIdentity {
  const authInfo = context.authInfo
  const identity = authInfo ? api.hub.identityByToken(authInfo.token) : undefined
  if (!identity || identity.paneId !== authInfo?.clientId) {
    throw new Error('authenticated Synkora pane is unavailable')
  }
  return identity
}

/** Sobe o servidor MCP dual-era, stateless por request. */
export function startMcpServer(api: McpApi, preferredPort = 0): Promise<McpServerHandle> {
  const validateHost = localhostHostValidation()
  const validateOrigin = localhostOriginValidation()
  const mcpHandler = createMcpHandler(
    (context) => buildServer(api, identityForRequest(api, context)),
    {
      legacy: 'stateless',
      responseMode: 'auto',
      onerror: () => console.warn('[mcp] request failed')
    }
  )
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror: () => console.warn('[mcp] HTTP adapter failed')
  })
  const httpServer = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end()
      else if (!res.writableEnded) res.end()
    })
  })

  // F5-F3b — WAITER de background (R12): GET /mail-wait segura a resposta até
  // o correio do pane receber mensagem (ou até o teto). Um pane claude COM
  // shell arma `curl` disto em background e ENCERRA o turno; quando a
  // resposta volta, a notificação de background task ACORDA o agente com zero
  // digitação — ele então drena via check_messages. As respostas penduradas
  // são rastreadas para o close() do app não esperar o teto.
  const MAIL_WAIT_LONGPOLL_MS = 600_000
  const pendingMailWaits = new Set<ServerResponse>()
  async function handleMailWait(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      res.writeHead(405).end()
      return
    }
    const token = bearerToken(req.headers.authorization)
    const identity = token ? api.hub.identityByToken(token) : undefined
    if (!token || !identity) {
      res.writeHead(401).end('token do Synkora inválido ou pane encerrado')
      return
    }
    pendingMailWaits.add(res)
    res.once('close', () => pendingMailWaits.delete(res))
    const arrived = (await api.waitForMail?.(identity, MAIL_WAIT_LONGPOLL_MS)) ?? false
    pendingMailWaits.delete(res)
    if (res.writableEnded) return
    if (arrived) {
      res
        .writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        .end('MAIL — você tem mensagem nova: chame a tool mcp__synkora__check_messages agora')
    } else {
      res
        .writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        .end('TIMEOUT — nenhuma mensagem no intervalo; re-arme o waiter se continuar esperando')
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return
    if (isPath(req.url, '/mail-wait')) {
      await handleMailWait(req, res)
      return
    }
    if (!isMcpPath(req.url)) {
      res.writeHead(404).end()
      return
    }
    const token = bearerToken(req.headers.authorization)
    const identity = token ? api.hub.identityByToken(token) : undefined
    if (!token || !identity) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'token do Synkora inválido ou pane encerrado' },
          id: null
        })
      )
      return
    }

    const authenticatedRequest = req as AuthenticatedIncomingMessage
    authenticatedRequest.auth = {
      token,
      clientId: identity.paneId,
      scopes: ['synkora:pane'],
      // A factory ignora o snapshot e revalida o token diretamente no Hub.
      extra: { identity }
    } satisfies AuthInfo
    await nodeHandler(authenticatedRequest, res)
  }

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(preferredPort, '127.0.0.1', () => {
      const addr = httpServer.address()
      if (!addr || typeof addr !== 'object') {
        void mcpHandler.close()
        reject(new Error('porta do MCP indisponível'))
        return
      }

      let closePromise: Promise<void> | null = null
      resolve({
        port: addr.port,
        close: () => {
          if (closePromise) return closePromise
          // long-polls pendurados (/mail-wait) seguram o httpServer.close até
          // o teto de 10min — responde e encerra todos antes de fechar.
          for (const pending of [...pendingMailWaits]) {
            try {
              if (!pending.writableEnded) pending.writeHead(200).end('TIMEOUT — o app está fechando')
            } catch {
              // resposta já morta
            }
          }
          pendingMailWaits.clear()
          const closeHttp = new Promise<void>((resolveClose, rejectClose) => {
            httpServer.close((error) => {
              if (error) rejectClose(error)
              else resolveClose()
            })
          })
          closePromise = Promise.all([closeHttp, mcpHandler.close()]).then(() => undefined)
          return closePromise
        }
      })
    })
  })
}

// ————— injeção da config MCP por CLI —————

export interface McpStdioLaunch {
  command: string
  args: string[]
  env?: Record<string, string>
  version?: string
}

/** Resolve o MCP de browser empacotado pelo Synkora. Nunca consulta registry.
 *  Ausência degrada para pane sem esse servidor; não impede o terminal. */
export function resolveBundledPlaywrightMcp(): McpStdioLaunch | undefined {
  try {
    const packageFile = requireFromMain.resolve('@playwright/mcp/package.json')
    const manifest = JSON.parse(readFileSync(packageFile, 'utf-8')) as {
      name?: string
      version?: string
      bin?: Record<string, string> | string
    }
    if (manifest.name !== '@playwright/mcp') return undefined
    const bin =
      typeof manifest.bin === 'string'
        ? manifest.bin
        : manifest.bin?.['playwright-mcp'] ?? 'cli.js'
    const cli = unpackedRuntimePath(join(dirname(packageFile), bin))
    if (!existsSync(cli)) return undefined
    return electronNodeLaunch(cli, [], manifest.version)
  } catch {
    return undefined
  }
}

/** Resolve SOMENTE uma dependência declarada e instalada pela worktree. O
 *  caminho direto impede subir para o Playwright transitivo do Synkora; no
 *  layout pnpm, a resolução parte do @playwright/test já validado. Nunca
 *  executa gerenciador de pacotes. */
export function resolveProjectPlaywrightTest(cwd: string | undefined): McpStdioLaunch | undefined {
  if (!cwd) return undefined
  try {
    const root = realpathSync.native(cwd)
    const packageFile = join(root, 'package.json')
    if (!existsSync(packageFile)) return undefined
    const project = JSON.parse(readFileSync(packageFile, 'utf-8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    const all = { ...project.dependencies, ...project.devDependencies, ...project.optionalDependencies }
    const declaresTest = Boolean(all['@playwright/test'])
    const declaresPlaywright = Boolean(all.playwright)
    if (!declaresTest && !declaresPlaywright) return undefined

    let cli: string | undefined
    let version: string | undefined
    let playwrightPackageFile: string
    if (declaresTest) {
      const logicalTestPackageFile = join(root, 'node_modules', '@playwright', 'test', 'package.json')
      if (!existsSync(logicalTestPackageFile)) return undefined
      const testPackageFile = realpathSync.native(logicalTestPackageFile)
      if (!pathInside(root, testPackageFile)) return undefined
      const testManifest = JSON.parse(readFileSync(testPackageFile, 'utf-8')) as {
        name?: string
        version?: string
        bin?: Record<string, string> | string
      }
      if (testManifest.name !== '@playwright/test') return undefined
      const testBin =
        typeof testManifest.bin === 'string'
          ? testManifest.bin
          : testManifest.bin?.playwright ?? 'cli.js'
      const logicalCli = join(dirname(testPackageFile), testBin)
      if (!existsSync(logicalCli)) return undefined
      cli = realpathSync.native(logicalCli)
      if (!pathInside(root, cli)) return undefined
      // Parte do layout pnpm pode não publicar root/node_modules/playwright.
      // Resolver a partir do pacote explicitamente instalado encontra apenas a
      // dependência dele, inclusive no store do gerenciador.
      playwrightPackageFile = realpathSync.native(
        createRequire(testPackageFile).resolve('playwright/package.json')
      )
      if (!pathInside(root, playwrightPackageFile)) return undefined
      version = testManifest.version
    } else {
      // Caminho lógico direto: não sobe para o Playwright transitivo do app.
      const logicalPlaywrightPackageFile = join(root, 'node_modules', 'playwright', 'package.json')
      if (!existsSync(logicalPlaywrightPackageFile)) return undefined
      playwrightPackageFile = realpathSync.native(logicalPlaywrightPackageFile)
      if (!pathInside(root, playwrightPackageFile)) return undefined
    }
    const manifest = JSON.parse(readFileSync(playwrightPackageFile, 'utf-8')) as {
      name?: string
      version?: string
      bin?: Record<string, string> | string
    }
    if (manifest.name !== 'playwright') return undefined
    if (!declaresTest) {
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.playwright ?? 'cli.js'
      const logicalCli = join(dirname(playwrightPackageFile), bin)
      if (!existsSync(logicalCli)) return undefined
      cli = realpathSync.native(logicalCli)
      if (!pathInside(root, cli)) return undefined
      version = manifest.version
    }
    const logicalProgram = join(dirname(playwrightPackageFile), 'lib', 'program.js')
    if (!existsSync(logicalProgram)) return undefined
    const program = realpathSync.native(logicalProgram)
    if (!pathInside(root, program)) return undefined
    if (!readFileSync(program, 'utf-8').includes('run-test-mcp-server')) return undefined
    if (!cli) return undefined
    return electronNodeLaunch(cli, ['run-test-mcp-server'], version ?? manifest.version)
  } catch {
    return undefined
  }
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function electronNodeLaunch(entrypoint: string, args: string[], version?: string): McpStdioLaunch {
  return {
    command: process.execPath,
    args: [entrypoint, ...args],
    ...(process.versions.electron ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}),
    ...(version ? { version } : {})
  }
}

function unpackedRuntimePath(file: string): string {
  const marker = `${sep}app.asar${sep}`
  if (!file.includes(marker)) return file
  const unpacked = file.replace(marker, `${sep}app.asar.unpacked${sep}`)
  return existsSync(unpacked) ? unpacked : file
}

function stdioConfig(launch: McpStdioLaunch): Record<string, unknown> {
  return {
    command: launch.command,
    args: launch.args,
    ...(launch.env ? { env: launch.env } : {})
  }
}

/** claude: config JSON por pane (arquivo evita o inferno de quoting no shell). */
export function writeClaudeMcpConfig(
  baseDir: string,
  paneId: string,
  port: number,
  token: string,
  /** Browser independente de conta, resolvido da dependência fixada do app. */
  browser?: McpStdioLaunch,
  /** Test runner da worktree; ausente quando o projeto não o instalou. */
  testRunner?: McpStdioLaunch
): string {
  mkdirSync(baseDir, { recursive: true })
  // paneId vira nome de arquivo — sanitiza qualquer caractere proibido no
  // Windows (`:` etc.) para o write nunca derrubar o spawn do pane.
  const file = join(baseDir, `${paneId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  const servers: Record<string, unknown> = {
    synkora: {
      type: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { Authorization: `Bearer ${token}` }
    }
  }
  if (browser) servers['playwright'] = stdioConfig(browser)
  if (testRunner) servers['playwright-test'] = stdioConfig(testRunner)
  writeFileSync(file, JSON.stringify({ mcpServers: servers }), 'utf-8')
  return file
}

export function claudeMcpArgs(configFile: string, strict: boolean): string[] {
  const args = ['--mcp-config', configFile]
  if (strict) args.push('--strict-mcp-config')
  return args
}

/** Wrapper do Playwright MCP para o CODEX (sondado 2026-07-29): o array TOML
 *  `args=[…]` NÃO sobrevive à linha do PowerShell (as aspas internas caem e o
 *  codex vê string — "expected a sequence"); um .cmd de uma linha reduz a
 *  config a UMA string. Path com forward slashes: TOML basic string trata
 *  `\U` como escape unicode — barra normal é válida e o Windows aceita.
 *  Rust ≥1.77 (codex) spawna .cmd via cmd automaticamente. Validado:
 *  `codex -c mcp_servers.playwright.command="<path>" mcp list` → enabled. */
export function ensurePlaywrightCmd(baseDir: string, launch: McpStdioLaunch): string {
  return ensureMcpCmd(baseDir, 'playwright', launch)
}

/** Wrapper do MCP `playwright-test` para o CODEX. O target já foi resolvido e
 *  validado dentro da worktree; o wrapper nunca consulta npm nem o registry. */
export function ensurePlaywrightTestCmd(baseDir: string, launch: McpStdioLaunch): string {
  return ensureMcpCmd(baseDir, 'playwright-test', launch)
}

function ensureMcpCmd(baseDir: string, label: string, launch: McpStdioLaunch): string {
  const envEntries = Object.entries(launch.env ?? {}).sort(([a], [b]) => a.localeCompare(b))
  for (const [key, value] of envEntries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('nome de env inválido para wrapper MCP')
    if (/[\r\n"]/u.test(value)) throw new Error('valor de env inválido para wrapper MCP')
  }
  const values = [launch.command, ...launch.args]
  if (values.some((value) => /[\r\n"]/u.test(value))) throw new Error('caminho inválido para wrapper MCP')

  mkdirSync(baseDir, { recursive: true })
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([launch.command, launch.args, launch.env ?? {}]))
    .digest('hex')
    .slice(0, 12)
  const file = join(baseDir, `${label}-${fingerprint}.cmd`)
  const unicodeLaunch = [...values, ...envEntries.flat()].some((value) => /[^\x00-\x7f]/u.test(value))
  if (unicodeLaunch) {
    // cmd.exe interpreta .cmd pela code page OEM, então paths Unicode seriam
    // corrompidos. O batch permanece 100% ASCII e delega apenas esse caso raro
    // a um script PowerShell com BOM. `%~dp0` preserva o diretório Unicode sem
    // gravá-lo no arquivo, e -File repassa stdin/stdout/stderr e `%*`.
    const scriptName = `${label}-${fingerprint}.ps1`
    const scriptFile = join(baseDir, scriptName)
    const psLines = ["$ErrorActionPreference = 'Stop'"]
    for (const [key, value] of envEntries) {
      psLines.push(
        `[Environment]::SetEnvironmentVariable(${powershellLiteral(key)}, ${powershellLiteral(value)}, 'Process')`
      )
    }
    psLines.push(`$mcpCommand = ${powershellLiteral(launch.command)}`)
    psLines.push(`$fixedArgs = @(${launch.args.map(powershellLiteral).join(', ')})`)
    psLines.push('$allArgs = $fixedArgs + @($args)')
    psLines.push('& $mcpCommand @allArgs')
    psLines.push('exit $LASTEXITCODE')
    writeFileSync(scriptFile, `\ufeff${psLines.join('\r\n')}\r\n`, 'utf-8')

    const lines = [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0${scriptName}" %*`,
      'exit /b %errorlevel%'
    ]
    writeFileSync(file, `${lines.join('\r\n')}\r\n`, 'utf-8')
    return file.replace(/\\/g, '/')
  }

  const lines = ['@echo off', 'setlocal DisableDelayedExpansion']
  for (const [key, value] of envEntries) lines.push(`set "${key}=${value.replace(/%/g, '%%')}"`)
  lines.push(`${values.map((value) => `"${value.replace(/%/g, '%%')}"`).join(' ')} %*`)
  lines.push('exit /b %errorlevel%')
  writeFileSync(file, `${lines.join('\r\n')}\r\n`, 'utf-8')
  return file.replace(/\\/g, '/')
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** codex: override por linha de comando — não suja o config.toml do seat.
 *  O token vai pelo env SYNKORA_TOKEN (bearer_token_env_var). */
export function codexMcpArgs(
  port: number,
  browserCmd?: string,
  testRunnerCmd?: string,
  protocolArgs: readonly string[] = []
): string[] {
  const args = [
    ...protocolArgs,
    '-c',
    `mcp_servers.synkora.url="http://127.0.0.1:${port}/mcp"`,
    '-c',
    'mcp_servers.synkora.bearer_token_env_var="SYNKORA_TOKEN"',
    // "MCP startup interrupted" (visto em ajudante codex, 2026-07-29): o
    // timeout de startup default do codex é 10s — num localhost com o server
    // já de pé, estourar isso é o event loop do main ocupado na tempestade de
    // boot de panes, não rede. Folga tripla.
    '-c',
    'mcp_servers.synkora.startup_timeout_sec=30',
    // F5-F3: folga para o LONG-POLL do check_messages (o servidor segura a
    // resposta com a caixa vazia). Sonda W4 (2026-08-08) provou o knob no
    // codex 0.147; o default já aguentava 75s+ — isto é cinto, não cura.
    '-c',
    'mcp_servers.synkora.tool_timeout_sec=300'
  ]
  if (browserCmd) {
    // browser de teste também nos panes codex de execução (pedido do usuário:
    // "QA de codex não tá abrindo um chrome") — mesmo Playwright MCP do claude
    args.push('-c', `mcp_servers.playwright.command=${tomlLiteral(browserCmd)}`)
    args.push('-c', 'mcp_servers.playwright.startup_timeout_sec=60')
  }
  if (testRunnerCmd) {
    // Hífen é válido em bare keys TOML e preserva o nome/prefixo que os
    // agentes oficiais usam (`mcp__playwright-test__*`).
    args.push('-c', `mcp_servers.playwright-test.command=${tomlLiteral(testRunnerCmd)}`)
    args.push('-c', 'mcp_servers.playwright-test.startup_timeout_sec=60')
  }
  return args
}

/** Literal TOML sem aspas duplas quando possível. Isso evita a reinterpretação
 *  de `"` pelo PowerShell 5.1 em paths com espaço. O fallback codifica todos
 *  os code points, portanto também não contém whitespace para o quote nativo. */
function tomlLiteral(value: string): string {
  if (!/[\u0000-\u001f\u007f']/u.test(value)) return `'${value}'`
  const encoded = [...value]
    .map((char) => {
      const code = char.codePointAt(0)!
      return code <= 0xffff
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : `\\U${code.toString(16).padStart(8, '0')}`
    })
    .join('')
  // O espaço TOML após `=` é intencional: faz o quote do PTY preservar
  // as aspas duplas no PowerShell 5.1. Sem ele o Codex receberia `\\u...`
  // literalmente em paths com apóstrofo.
  return ` "${encoded}"`
}
