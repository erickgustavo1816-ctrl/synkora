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
import {} from 'crypto'
import { createRequire } from 'module'
import {  mkdirSync, writeFileSync } from 'fs'
import {   join } from 'path'
import type { Hub, PaneIdentity } from './hub'
import type { PlanPatch } from './plans'
// Os números que o catálogo ENSINA ao agente saem do motor, nunca de uma
// cópia à mão: teto de espera, teto de prompt e a trava anti-laço. Se o motor
// mudar um deles, a descrição da ferramenta muda junto — descrição que mente
// sobre o próprio limite é pior que descrição ausente.
import {
  GUI_HELPER_PROMPT_MAX_CHARS,
  GUI_HELPER_RUNAWAY_BACKSTOP,
  GUI_HELPER_WAIT_DEFAULT_SECONDS,
  GUI_HELPER_WAIT_MAX_SECONDS
} from './guiHelperSessions'
// A régua do PAPEL do pane (dev × reviewer × ajudante) é a mesma que o spawn
// usa — a integração é do DEV, e ela sai do endereço, nunca de um palpite.
import { guiMissionRoleOf } from './guiMissionContracts'
// R14 — o kit de CÓDIGO (design DESIGN_COPIA_E_LSP_R14, seção L2). Mesma
// doutrina do bloco acima: os TETOS que a descrição ensina ao agente saem do
// módulo que os aplica, nunca de uma cópia à mão.
import {
  LSP_DIAGNOSTICS_FILES_MAX,
  LSP_DIAGNOSTICS_ITEM_CAP,
  LSP_LOCATIONS_ITEM_CAP,
  lspExtensionsLabel,
  type GuiLspToolkit
} from './guiLspTools'
import { LSP_DIAGNOSTICS_CEILING_MS } from './lsp/lspSession'

const requireFromMain = createRequire(
  typeof __filename === 'string' ? __filename : join(process.cwd(), 'package.json')
)

// Servidor MCP local do Synkora: é por AQUI que os CHATS da era 2.0 falam com
// o app. Cada pane com identidade nasce com um bearer token próprio; o token
// identifica QUEM chama (a role, o projeto, a missão, o worktree) e as
// ferramentas agem no contexto certo. HTTP em 127.0.0.1, porta aleatória.
//
// Catálogos fechados por retorno antecipado (ver `buildServer`): `gui-planner`
// recebe o kit de PLANOS, `gui-delegator` o de AJUDANTES (+ integração, só no
// chat de dev), `gui-release` o de RELEASE e `ajudante` SÓ o de código. Um pane
// tem UM desses, nunca dois, e qualquer outra identidade recebe um servidor
// VAZIO — nunca um erro. O antigo catálogo por papel (maestro/dev/review/qa)
// morreu com a era F6.
//
// O kit de CÓDIGO (R14) é a única exceção à regra "um papel, um kit": os quatro
// papéis acima o recebem, porque ler código não é autoridade sobre nada — e é
// justamente por isso que ele pode ser o catálogo INTEIRO do ajudante.

/** Implementada em index.ts — as tools delegam para o harness real. */
export interface McpApi {
  hub: Hub
  // ——— kit do CHAT de planejamento (2.0, onda D — role 'gui-planner') ———
  // É o catálogo INTEIRO: nenhuma outra identidade recebe ferramenta nenhuma.
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
  /** instrumentação CHECK 14: o app registra qual catálogo cada identidade
   *  recebeu (dedupe por pane no app — mudança de catálogo é o alarme) */
  noteCatalogServed?: (id: PaneIdentity, tools: string[]) => void

  // ——— kit de DELEGAÇÃO (subagentes sem aba, 2026-08-18 — role
  // 'gui-delegator'; design DESIGN_SUBAGENTES_SEM_ABA_2026-08-18.md D2) ———
  // Opcionais durante a montagem da onda 2: o catálogo guarda com recusa
  // legível quando o harness ainda não ligou o motor. Todos devolvem TEXTO
  // legível (padrão text()); recibos carregam helperId/cli/model/effort/seat.
  /** Abre N helpers headless de uma vez. Devolve os recibos NA HORA. */
  delegateHelpers?: (id: PaneIdentity, helpers: McpHelperRequestInput[]) => Promise<string>
  /** As contas: id/nome, CLI, logada e os limites reais (cache). */
  listSeats?: (id: PaneIdentity) => Promise<string>
  /** Fotografia dos helpers do pane: estado, decorrido, última atividade. */
  helpersStatus?: (id: PaneIdentity) => string
  /** LONG-POLL pelo resultado (teto do SERVIDOR: default 45s, máx 240s). */
  helperResult?: (id: PaneIdentity, helperId: string, waitSeconds?: number) => Promise<string>
  /** Steering: mensagem para o helper VIVO. */
  helperSend?: (id: PaneIdentity, helperId: string, text: string) => string
  /** DESCARTE (R6.2): mata, apaga a entrega e encerra o registro. */
  helperCancel?: (id: PaneIdentity, helperId: string) => string
  /** RETOMAR (R6.2): o interrompido volta à MESMA conversa, de onde parou. */
  helperResume?: (id: PaneIdentity, helperId: string) => string

  // ——— kit do INTEGRADOR (rodada 9, 2026-08-19 — só o chat DEV da missão) ———
  // O ⇪ do dono deixou de drenar e passou a ESTIMULAR: a fila virou coordenação
  // e o executor é o agente. Estes dois métodos são cascas finas sobre o
  // missionEngine — nenhuma decisão de integração mora aqui.
  /** Fotografia da fila do PROJETO pelos olhos desta missão + a receita.
   *  R18.1: Promise porque o git dela viaja pelo gitWorker (o texto é o mesmo). */
  integrationStatus?: (id: PaneIdentity) => Promise<string>
  /** Executa a integração DESTA missão (só com ticket do dono, só na cabeça). */
  integrationRun?: (id: PaneIdentity) => Promise<string>

  // ——— kit do RELEASE (R10, 2026-08-19 — role 'gui-release') ———
  // O botão "subir pra main" da versão abre a conversa; estas cascas finas
  // falam com o releaseChat/index — a mecânica do release mora lá.
  /** A fotografia do release: trava do plano, fila, branches, receita. */
  releaseStatus?: (id: PaneIdentity) => string
  /** Sobe a versão desta conversa para a main (o clique do dono é o mandato). */
  releaseRun?: (id: PaneIdentity) => Promise<string>

  // ——— kit de CÓDIGO (R14, 2026-08-19 — os TRÊS chats e os AJUDANTES) ———
  /**
   * O produto do `buildGuiLspTools`: as quatro perguntas ao servidor de
   * linguagem da raiz do pane. É o ÚNICO membro do `McpApi` que não é função —
   * de propósito: o kit é o mesmo objeto para quatro papéis, e cada método já
   * escreve a própria caixa-preta com a raiz junto (o proxy de instrumentação
   * do index.ts só enxerga membros-função, e um evento de LSP sem a RAIZ não
   * explicaria nada numa missão já integrada).
   *
   * Ausente = as tools continuam no catálogo e respondem com a receita. Tool
   * que some do catálogo entre um boot e outro é o pior desfecho possível: o
   * agente racionaliza a ausência em vez de ler o motivo.
   */
  lsp?: GuiLspToolkit
}

/** Um helper pedido no `delegate` (contrato D2; validação zod no catálogo). */
export interface McpHelperRequestInput {
  prompt: string
  model?: string
  effort?: string
  /** R11: modo fast do ajudante — só por pedido do dono, nunca herdado. */
  fast?: boolean
  seat?: string
  name?: string
}

function text(s: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: s }] }
}

/** Teto do steering. Mensagem de rumo é curta por natureza; o briefing inteiro
 *  já viajou no `prompt` do delegate. */
const HELPER_SEND_MAX_CHARS = 16 * 1024

/**
 * A resposta quando o harness ainda não ligou o motor de ajudantes (os métodos
 * do `McpApi` são opcionais durante a montagem da onda 2). É RESULTADO, não
 * erro de protocolo: o chat continua conversando e o agente lê uma frase que
 * explica o que aconteceu, em vez de um -32603 que ele vai racionalizar como
 * "o ajudante foi aberto e falhou".
 */
const DELEGATION_ENGINE_OFF =
  'o motor de delegação ainda não está ligado — reinicie o app para reabrir esta conversa com as ferramentas de ajudante. NADA foi aberto: não relate ajudante nenhum ao dono.'

/** O par da recusa acima para o kit do INTEGRADOR (R9). Mesma doutrina: é
 *  RESULTADO, não erro de protocolo, e diz em letras maiúsculas que nada foi
 *  mesclado — um agente que racionalizasse "integrei e falhou" contaria ao dono
 *  uma entrega que não aconteceu. */
const INTEGRATION_ENGINE_OFF =
  'o motor de integração ainda não está ligado — reinicie o app para reabrir esta conversa com as ferramentas de integração. NADA foi mesclado e a fila não mudou: não relate integração nenhuma ao dono.'

/** Mesma doutrina para o release (R10): nunca deixar o agente racionalizar um
 *  release que não aconteceu. */
const RELEASE_ENGINE_OFF =
  'o motor de release ainda não está ligado — reinicie o app para reabrir esta conversa com as ferramentas de release. NADA subiu para a main: não relate release nenhum ao dono.'

/** Mesma doutrina para o kit de código (R14): a ausência do motor é RESULTADO
 *  legível, e a frase mata a racionalização "olhei o código e está limpo". */
const LSP_ENGINE_OFF =
  'o motor de linguagem ainda não está ligado — reinicie o app para reabrir esta conversa com as ferramentas de código. NADA foi analisado: não conclua que o código está limpo.'

/**
 * O KIT DE CÓDIGO (R14, seção L2 do design). Ele é o único kit COMPARTILHADO
 * entre papéis: os três chats (`gui-planner`, `gui-delegator`, `gui-release`) e
 * o AJUDANTE recebem exatamente estas quatro tools, e o ajudante NÃO recebe
 * mais nada — frota que abre frota continua impossível MECANICAMENTE, porque o
 * early-return dele não registra `delegate` linha nenhuma.
 *
 * As descrições dizem, em voz alta e sem exceção: a BASE das posições (1-based
 * nos dois sentidos), o CONFINAMENTO à raiz da conversa e os TETOS reais —
 * descrição que mente sobre o próprio limite é pior que descrição ausente.
 */
function registerLspKit(server: McpServer, api: McpApi, identity: PaneIdentity): void {
  const ceilingSeconds = Math.round(LSP_DIAGNOSTICS_CEILING_MS / 1000)

  server.registerTool(
    'lsp_diagnostics',
    {
      description: `Os PROBLEMAS que o servidor de linguagem enxerga no código desta conversa — os mesmos erros e avisos do typecheck, sem rodar build nenhum e sem esperar o gate. Chame DEPOIS de editar e ANTES de dizer que terminou. SEM \`files\`, o alvo são os arquivos MODIFICADOS da raiz desta conversa (o que você mexeu até agora); com \`files\`, os caminhos que você pedir. Cada problema sai numa linha \`arquivo:linha:coluna severidade código mensagem\`, com linha e coluna 1-BASED (a primeira linha é 1) e severidade em erro/aviso/info/dica. Tetos ditos em voz alta e sempre repetidos no recibo quando cortam: ${LSP_DIAGNOSTICS_ITEM_CAP} problemas e ${LSP_DIAGNOSTICS_FILES_MAX} arquivos por chamada, e ${ceilingSeconds}s de espera pelo servidor. Só entra o que o servidor fala (${lspExtensionsLabel()}) — o que sobrar é nomeado no recibo. O disco é RELIDO a cada chamada: salve o arquivo antes de perguntar.`,
      inputSchema: {
        files: z
          .array(z.string().min(1).max(400))
          .max(LSP_DIAGNOSTICS_FILES_MAX)
          .optional()
          .describe(
            'caminhos de ARQUIVO relativos à raiz desta conversa (o worktree da missão). Caminho fora da raiz é recusado, e a recusa diz qual raiz vale. Ausente = os arquivos que você modificou'
          )
      }
    },
    async ({ files }) =>
      api.lsp ? text(await api.lsp.diagnostics(identity, files)) : text(LSP_ENGINE_OFF)
  )

  server.registerTool(
    'lsp_definition',
    {
      description:
        'ONDE o símbolo desta posição foi DEFINIDO. É a pergunta que substitui a caçada por grep: uma resposta exata em vez de trinta ocorrências do mesmo nome. A resposta pode apontar para FORA da raiz (uma definição em node_modules ou num `lib.d.ts` é resposta legítima) e nesse caso o caminho vem absoluto.',
      inputSchema: lspPositionSchema()
    },
    async ({ file, line, column }) =>
      api.lsp ? text(await api.lsp.definition(identity, file, line, column)) : text(LSP_ENGINE_OFF)
  )

  server.registerTool(
    'lsp_references',
    {
      description: `QUEM usa o símbolo desta posição, a declaração incluída. Chame ANTES de renomear ou mudar assinatura: é assim que você descobre o que vai quebrar, sem depender de o build reclamar depois. Teto de ${LSP_LOCATIONS_ITEM_CAP} posições por chamada, dito no recibo quando corta.`,
      inputSchema: lspPositionSchema()
    },
    async ({ file, line, column }) =>
      api.lsp ? text(await api.lsp.references(identity, file, line, column)) : text(LSP_ENGINE_OFF)
  )

  server.registerTool(
    'lsp_hover',
    {
      description:
        'O que o servidor SABE sobre esta posição: o tipo resolvido, a assinatura e a documentação do símbolo. Use para confirmar o tipo REAL antes de escrever contra ele — ler a declaração à mão em três arquivos é o caminho longo para a mesma resposta.',
      inputSchema: lspPositionSchema()
    },
    async ({ file, line, column }) =>
      api.lsp ? text(await api.lsp.hover(identity, file, line, column)) : text(LSP_ENGINE_OFF)
  )
}

/** As três consultas pontuais compartilham a MESMA porta de entrada: um
 *  arquivo dentro da raiz e uma posição 1-based. O `.min(1)` do schema é o que
 *  faz a base ser mecânica e não um pedido educado na descrição. */
function lspPositionSchema(): {
  file: z.ZodString
  line: z.ZodNumber
  column: z.ZodNumber
} {
  return {
    file: z
      .string()
      .min(1)
      .max(400)
      .describe(
        'caminho do arquivo RELATIVO à raiz desta conversa (o worktree da missão). Fora da raiz é recusado, e a recusa nomeia a raiz que vale'
      ),
    line: z.number().int().min(1).describe('linha 1-BASED: a primeira linha do arquivo é 1'),
    column: z
      .number()
      .int()
      .min(1)
      .describe(
        'coluna 1-BASED: a primeira coluna é 1. Aponte para DENTRO do nome do símbolo, não para o espaço antes dele'
      )
  }
}

/**
 * R16 — O `context` DE CADA ITEM É O MAPA DA FATIA (design de 2026-08-19).
 *
 * FONTE ÚNICA das três aparições do campo (propose_plan.items,
 * update_plan.items e update_plan.addItems): o agente lê a MESMA regra
 * onde quer que escreva, e o teste a prende num lugar só.
 *
 * O porquê está dito ao agente de propósito: este texto viaja VERBATIM para o
 * `goal` da missão (planItemMissionGoal) e de lá para o briefing do dev. Item
 * sem mapa condena o dev a re-derivar o repositório que o planejador acabou de
 * estudar — os 10 minutos de estudo que esta rodada existe para matar.
 */
const PLAN_ITEM_CONTEXT_DESCRIBE =
  'seção Contexto — o MAPA DA FATIA: arquivos/módulos que importam, o que JÁ existe neles, o que será criado e onde NÃO mexer quando isso desenha a fronteira. Ele viaja VERBATIM para o briefing do dev desta missão: item sem mapa obriga o dev a re-derivar sozinho o repositório que você acabou de estudar.'

function buildServer(api: McpApi, identity: PaneIdentity): McpServer {
  // SEM cacheHints de tools/list (CHECK 14, 2026-08-07): o hint de cache da
  // spec 2026-07-28 estava anunciado sem nenhum cliente validado usando — e
  // no mistério "runtime_control sumiu SÓ em pane resumado" um cliente
  // recém-atualizado honrando TTL de catálogo é gatilho plausível. Custo de
  // remover: um tools/list por boot de pane. Só re-anunciar com sonda.
  const server = new McpServer({ name: 'synkora', version: '1.0.0' })

  // INSTRUMENTAÇÃO DO CATÁLOGO (CHECK 14): coleciona os nomes registrados
  // NESTA construção e avisa o app (dedupe por pane lá) — a caixa-preta
  // passa a registrar QUAL catálogo cada identidade recebeu; a próxima
  // anomalia de tool sumida se explica sozinha no journal.
  const servedTools: string[] = []
  const originalRegisterTool = server.registerTool.bind(server)
  server.registerTool = ((name: string, ...rest: unknown[]) => {
    servedTools.push(name)
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
          'APRESENTA um plano novo ao dono, como card dentro desta conversa. NUNCA cria nada: quem cria é o clique dele. Chame só depois que ele concordar com o recorte em palavras — e então ENCERRE o turno e espere. Silêncio não é consentimento. Cada item é UMA missão entregável; os campos espelham as seções que você já escreve em plano/NNN-slug.md. DECLARAR DEPENDÊNCIA É PARTE DO PLANEJAMENTO: a missão que precisa de outra PRONTA antes nomeia a key dela em dependsOn — no quadro do dono a tag ganha check quando a dependida conclui, e só então o começar dela destrava. As que ficam sem dependsOn são exatamente as que ele roda EM PARALELO.',
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
                context: z.string().max(2_000).optional().describe(PLAN_ITEM_CONTEXT_DESCRIBE),
                dependsOn: z
                  .array(z.string().max(60))
                  .max(12)
                  .optional()
                  .describe(
                    'keys de missões ANTERIORES desta mesma lista que precisam estar PRONTAS antes desta começar'
                  ),
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
          'Edita um plano que JÁ existe — isto executa na hora (editar é reversível). Mande o updatedAt que veio do get_plan: se o plano mudou nesse meio-tempo, a alteração é recusada em vez de sobrescrever o que o dono viu. O estado "concluida" e o vínculo com a missão são derivados da missão real e não se escrevem aqui. A designação de plano mestre não passa por aqui — ela é um gesto do dono no mapa. MANTER O GRAFO EM DIA É PARTE DA EDIÇÃO: dependsOn é o que o quadro do dono lê para travar o começar de uma missão até a dependida concluir, e para mostrar o que sobra livre para rodar EM PARALELO.',
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
                context: z
                  .string()
                  .max(2_000)
                  .nullable()
                  .optional()
                  .describe(PLAN_ITEM_CONTEXT_DESCRIBE),
                dependsOn: z
                  .array(z.string().max(120))
                  .max(12)
                  .optional()
                  .describe(
                    'ids de itens DESTE plano que precisam estar PRONTOS antes deste começar — a lista mandada SUBSTITUI a anterior'
                  ),
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
                context: z.string().max(2_000).optional().describe(PLAN_ITEM_CONTEXT_DESCRIBE),
                dependsOn: z
                  .array(z.string().max(120))
                  .max(12)
                  .describe(
                    'o que precisa estar PRONTO antes deste item começar: keys de itens novos desta mesma chamada ou ids de itens que já estão no plano'
                  ),
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

    // O planejador também LÊ código (R14): o recorte de um plano nasce melhor
    // quando quem o escreve consegue perguntar onde uma coisa é usada em vez de
    // adivinhar o tamanho da mudança.
    registerLspKit(server, api, identity)
    return finishCatalog()
  }

  // ————— CHAT DE MISSÃO QUE DELEGA (2026-08-18) — o kit de AJUDANTES —————
  //
  // Ordem do dono: "ele NUNCA MAIS vai abrir subagentes dele — ele vai abrir
  // subagentes via MCP. Porque via MCP eu vejo na lateral o MODELO e o EFFORT
  // que subiu". Este bloco é o outro lado dessa ordem: o subagente nativo do
  // CLI é cercado no spawn (guiDelegateMcp) e a capacidade volta AQUI, num
  // caminho que o app enxerga inteiro.
  //
  // O catálogo dá CONTROLE TOTAL, de propósito (ordem do dono: "como se
  // estivesse rodando um subagente nativo — ele consegue fazer qualquer coisa
  // com aquele subagente"): abrir a frota, ver o estado, ler a entrega,
  // dirigir, RETOMAR e descartar. Tirar qualquer um desses verbos deixaria a
  // troca pior do que o nativo que ela aposenta.
  //
  // O PAR DA INTERRUPÇÃO (R6.2) é o que fecha o ciclo redondo: `helper_resume`
  // traz de volta quem parou e `helper_cancel` joga fora. Sem os dois, a parada
  // preservadora do motor não teria saída nenhuma — e "parar" voltaria a
  // significar "perder".
  //
  // Mesma cerca do planejador: retorno antecipado. Quem não é `gui-delegator`
  // não enxerga uma linha disto — inclusive um AJUDANTE, que nasce sem MCP
  // nenhum (frota que abre frota é o laço que o backstop existe para conter).
  if (identity.role === 'gui-delegator') {
    server.registerTool(
      'delegate',
      {
        description:
          'Abre AJUDANTES para você: sessões headless que trabalham no MESMO worktree e devolvem o texto final. Este é o ÚNICO caminho de delegação deste chat — o subagente nativo do seu CLI está desligado aqui, porque só por este caminho o dono vê na lateral o modelo, o effort e a conta de cada ajudante. UMA chamada abre a frota INTEIRA (cinco ajudantes são um `delegate` com cinco itens, nunca cinco chamadas) e ela responde NA HORA com o recibo de cada um: a tool nunca bloqueia. Cross-CLI é normal e esperado — um chat claude abre gpt-*, um chat codex abre opus/fable. O PINO DO PAINEL É LEI: pedido do dono que não nomeia modelo nem effort abre TODOS os ajudantes no padrão que ele carimbou, e só um pedido explícito dele nesta conversa autoriza sair desse padrão. Depois de abrir, o comando é seu: helpers_status para ver, helper_result para ler, helper_send para dirigir, helper_cancel para encerrar.',
        inputSchema: {
          helpers: z
            .array(
              z.object({
                prompt: z
                  .string()
                  .min(1)
                  .max(GUI_HELPER_PROMPT_MAX_CHARS)
                  .describe(
                    'a tarefa COMPLETA deste ajudante. Ele nasce sem o seu contexto, não vê esta conversa e não pode perguntar nada: diga o objetivo, os arquivos, o critério de pronto e o que ele NÃO deve tocar'
                  ),
                model: z
                  .string()
                  .max(120)
                  .optional()
                  .describe(
                    "id do modelo, como o dono o escreve (ex.: 'opus[1m]', 'gpt-5.6-luna'). É ELE que decide o CLI do ajudante. Ausente = o padrão carimbado pelo dono no painel (sem padrão, o seu modelo) — deixe ausente sempre que ele não tiver nomeado um modelo"
                  ),
                effort: z
                  .string()
                  .max(40)
                  .optional()
                  .describe(
                    'nível de raciocínio. Ausente = o padrão do painel do dono e, sem padrão, o seu — quando o CLI é o mesmo (escalas diferentes não se herdam entre CLIs). Numa frota grande, effort UNIFORME é materialmente mais barato: variar quebra o cache de prompt'
                  ),
                fast: z
                  .boolean()
                  .optional()
                  .describe(
                    'modo FAST do ajudante (mais rápido, GASTA MAIS LIMITE). Só quando o DONO pedir — nunca por conta própria. Ausente = o padrão do painel dele (⚡ quando ele carimbou lá; sem carimbo, desligado); `false` explícito DESLIGA mesmo com o painel ligado. Nunca herdado desta conversa: o seu fast não vira o dele. No claude, fast troca o modelo para Opus 5 (comportamento do CLI); modelo sem fast abre normal e o recibo diz'
                  ),
                seat: z
                  .string()
                  .max(120)
                  .optional()
                  .describe(
                    'id da conta que vai rodar este ajudante (vem do list_seats). Ausente = resolução automática: a sua conta no mesmo CLI, ou a primeira logada do CLI cruzado'
                  ),
                name: z
                  .string()
                  .max(80)
                  .optional()
                  .describe('apelido curto — é o rótulo do card deste ajudante na lateral do dono')
              })
            )
            .min(1)
            .max(GUI_HELPER_RUNAWAY_BACKSTOP)
            .describe(
              `um item por ajudante — a frota inteira numa chamada só. NÃO existe cota: se o trabalho pede vinte ajudantes, peça vinte. O teto de ${GUI_HELPER_RUNAWAY_BACKSTOP} é uma trava contra laço de repetição, não um orçamento`
            )
        }
      },
      async ({ helpers }) =>
        api.delegateHelpers
          ? text(await api.delegateHelpers(identity, helpers))
          : text(DELEGATION_ENGINE_OFF)
    )

    server.registerTool(
      'list_seats',
      {
        description:
          'As contas deste app: id, nome, CLI, se está logada e os LIMITES reais de cada uma. Chame ANTES de abrir uma frota grande e distribua os ajudantes pelas contas com mais folga — limite estourado numa conta nunca precisa prender a missão. Também é daqui que sai o `seat` do delegate.'
      },
      async () => (api.listSeats ? text(await api.listSeats(identity)) : text(DELEGATION_ENGINE_OFF))
    )

    server.registerTool(
      'helpers_status',
      {
        description:
          'A fotografia dos SEUS ajudantes: estado, tempo decorrido, última atividade e contexto consumido. Não traz o texto das entregas (para isso existe o helper_result) — é o radar, e é barato de chamar quantas vezes você quiser.'
      },
      () => (api.helpersStatus ? text(api.helpersStatus(identity)) : text(DELEGATION_ENGINE_OFF))
    )

    server.registerTool(
      'helper_result',
      {
        description: `A entrega de UM ajudante. LONG-POLL: esta chamada SEGURA até \`waitSeconds\` (padrão ${GUI_HELPER_WAIT_DEFAULT_SECONDS}s, máximo ${GUI_HELPER_WAIT_MAX_SECONDS}s) e devolve o texto final se ele terminar nesse meio-tempo; senão devolve "ainda trabalhando" com o estado. Re-chamar é BARATO e é o esperado — a leitura é idempotente: o mesmo resultado sai quantas vezes você pedir. Prefira UMA espera longa a um laço de esperas curtas.`,
        inputSchema: {
          helperId: z.string().min(1).max(120).describe('o id que veio no recibo do delegate'),
          waitSeconds: z
            .number()
            .int()
            .min(1)
            .max(GUI_HELPER_WAIT_MAX_SECONDS)
            .optional()
            .describe(
              `quanto segurar esta chamada esperando o desfecho. Ausente = ${GUI_HELPER_WAIT_DEFAULT_SECONDS}s`
            )
        }
      },
      async ({ helperId, waitSeconds }) =>
        api.helperResult
          ? text(await api.helperResult(identity, helperId, waitSeconds))
          : text(DELEGATION_ENGINE_OFF)
    )

    server.registerTool(
      'helper_send',
      {
        description:
          'Manda uma mensagem para um ajudante VIVO: corrigir o rumo, responder uma dúvida que ele levantou, apertar o escopo. É o mesmo comando que você teria sobre um subagente nativo — a diferença é que aqui o dono vê o que está acontecendo.',
        inputSchema: {
          helperId: z.string().min(1).max(120),
          text: z
            .string()
            .min(1)
            .max(HELPER_SEND_MAX_CHARS)
            .describe('a mensagem, direta. O briefing completo já foi no prompt do delegate')
        }
      },
      ({ helperId, text: message }) =>
        api.helperSend ? text(api.helperSend(identity, helperId, message)) : text(DELEGATION_ENGINE_OFF)
    )

    server.registerTool(
      'helper_resume',
      {
        description:
          'RETOMA um ajudante INTERROMPIDO: ele volta para a MESMA conversa e continua de onde parou, no mesmo modelo, effort e conta do nascimento. Um ajudante fica interrompido quando o dono aperta ■ ou quando o app é fechado com ele trabalhando — o processo morre, mas a conversa dele fica guardada no disco do CLI. Só existe sobre `interrompido`: quem está trabalhando se dirige com helper_send, quem entregou se lê com helper_result, e quem falhou ou foi descartado se substitui com delegate. Trocar de modelo/effort NÃO é retomar — para isso, descarte com helper_cancel e abra outro.',
        inputSchema: {
          helperId: z.string().min(1).max(120).describe('o id do ajudante parado (vem do helpers_status)')
        }
      },
      ({ helperId }) =>
        api.helperResume ? text(api.helperResume(identity, helperId)) : text(DELEGATION_ENGINE_OFF)
    )

    server.registerTool(
      'helper_cancel',
      {
        description:
          'DESCARTA um ajudante: mata a sessão se ela ainda vive, APAGA o arquivo de entrega dele e encerra o registro de vez. É o par do helper_resume — sobre um ajudante interrompido, `resume` traz de volta e `cancel` joga fora. Use quando o trabalho dele deixou de fazer sentido (segurar ajudante inútil gasta limite da conta) e nunca como forma de "pausar": pausar é o ■ do dono, e dele se volta. O que o ajudante MUDOU no worktree não é apagado por esta ferramenta — desfazer código é git, e é seu.',
        inputSchema: {
          helperId: z.string().min(1).max(120)
        }
      },
      ({ helperId }) =>
        api.helperCancel ? text(api.helperCancel(identity, helperId)) : text(DELEGATION_ENGINE_OFF)
    )

    // ————— O AGENTE É O INTEGRADOR (rodada 9, 2026-08-19 — design I2) —————
    //
    // Ordem do dono: "quando eu clico em subir, o certo é avisar o agente e o
    // AGENTE sobe. Ele vê via MCP se tem alguém na fila na frente dele; se é o
    // próximo, ELE integra. Qualquer erro, ELE arruma."
    //
    // SÓ O CHAT DE DEV. É uma cerca de mesma natureza que as de cima, e o
    // motivo é concreto: reviewer lê diff e ajudante faz uma fatia — nenhum dos
    // dois é quem responde ao dono pela entrega, e o merge de uma missão não
    // pode ter dois donos dentro do mesmo worktree. Um pane sem `missionId`
    // (endereço órfão de missão apagada) também fica de fora: a integração
    // precisa de um SUJEITO, e um endereço parecido não é um.
    if (guiMissionRoleOf(identity.paneId) === 'dev' && identity.missionId) {
      server.registerTool(
        'integration_status',
        {
          description:
            'A FOTOGRAFIA da fila de integração deste universo pelos olhos DESTA missão: sua posição, o estado do seu ticket, o lacre da entrega, quem está na sua frente, a branch de destino e a RECEITA do próximo passo. Barata de chamar — use sempre que não tiver certeza do que fazer. Quem cria o ticket é o ⇪ do DONO, nunca você: sem ticket, esta ferramenta diz exatamente isso.'
        },
        async () =>
          api.integrationStatus
            ? text(await api.integrationStatus(identity))
            : text(INTEGRATION_ENGINE_OFF)
      )

      server.registerTool(
        'integration_run',
        {
          description:
            'INTEGRA esta missão no destino dela — o merge inteiro numa chamada (confere a fotografia aprovada e a árvore limpa, valida a identidade do destino, faz o precheck de conflito, mescla, conclui a missão e faz a fila andar). Só roda quando o ⇪ do dono já criou o ticket E esta missão é a CABEÇA da fila; fora disso a recusa te diz a posição, quem está na frente e o que falta. O desfecho SEMPRE volta para você: integrada (com os shas), conflito (com os arquivos e o movimento de resolução no SEU worktree) ou o erro honesto. Conflito não congela nada: o ticket continua na cabeça da fila, você resolve aqui, commita e chama de novo — o re-lacre da fotografia é automático e auditado. Depois, conte o desfecho ao dono no chat.'
        },
        async () =>
          api.integrationRun
            ? text(await api.integrationRun(identity))
            : text(INTEGRATION_ENGINE_OFF)
      )
    }

    // R14 — o kit de CÓDIGO. Fica FORA do `if` do dev de propósito: reviewer e
    // ajudante precisam achar o problema exato tanto quanto o dev; o que é do
    // dev é a INTEGRAÇÃO, não a leitura.
    registerLspKit(server, api, identity)
    return finishCatalog()
  }

  // R10 — O CHAT DE RELEASE (role 'gui-release'): a conversa que o botão
  // "subir pra main" da VERSÃO abre. Catálogo mínimo de propósito — subir a
  // versão É o show inteiro; delegação e integração de missão não moram aqui.
  if (identity.role === 'gui-release') {
    server.registerTool(
      'release_status',
      {
        description:
          'A FOTOGRAFIA do release desta versão: a trava do plano mestre (e quem a segura), a fila de integração do universo (missão subindo ainda vem antes), as branches (versão × main) com os heads, e a RECEITA do próximo passo. Leia SEMPRE antes de agir — e sempre que uma tentativa recusar.'
      },
      () => (api.releaseStatus ? text(api.releaseStatus(identity)) : text(RELEASE_ENGINE_OFF))
    )
    server.registerTool(
      'release_run',
      {
        description:
          'SOBE a versão desta conversa para a branch principal do projeto — o release inteiro numa chamada (re-confere a trava do plano, recusa com missão ainda na fila, mescla a branch da versão na main, carimba a versão como atual e avisa as outras missões de que a base andou). Toda recusa NOMEIA o que falta e a receita. O desfecho volta para você: conte ao dono em uma ou duas linhas. O clique dele no botão é o seu mandato — vale para ESTA versão, uma subida por gesto.'
      },
      async () =>
        api.releaseRun ? text(await api.releaseRun(identity)) : text(RELEASE_ENGINE_OFF)
    )
    // R14: a conversa que sobe a versão também lê código — um conflito
    // resolvido às pressas na branch da versão é exatamente o momento de
    // perguntar ao servidor de linguagem se ainda compila.
    registerLspKit(server, api, identity)
    return finishCatalog()
  }

  // ————— O AJUDANTE (R14, seção L2/L3 do design) — catálogo SÓ-LSP —————
  //
  // Até a R14 o ajudante nascia sem MCP nenhum, e a cerca do D1 era a AUSÊNCIA
  // de token. Agora ele ganha um token próprio (emitido pelo MOTOR, nunca pelo
  // chamador) com este papel — e a cerca deixa de ser ausência para virar
  // CATÁLOGO: aqui dentro não existe `delegate`, não existe plano, não existe
  // release e não existe integração. Frota que abre frota continua impossível
  // MECANICAMENTE, e agora por uma linha que se pode ler.
  //
  // O papel é o `ajudante` que JÁ existe no union do hub.ts — a onda 1 falava
  // num papel novo `gui-helper`, mas inventar um papel para dizer o que o
  // existente já diz só duplicaria a régua.
  if (identity.role === 'ajudante') {
    registerLspKit(server, api, identity)
    return finishCatalog()
  }

  // Qualquer OUTRA identidade recebe este servidor com catálogo VAZIO — não
  // um erro: o pane continua conversando, sem ferramenta nenhuma. Era a
  // resposta honesta para um papel que não existe mais (a era F6 registrava
  // aqui os catálogos de maestro/dev/review/qa).
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

  // Caminho ÚNICO: POST /mcp autenticado por bearer. O antigo GET /mail-wait
  // (o waiter de background do correio F6) morreu com o correio.
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return
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

/** claude: config JSON por pane (arquivo evita o inferno de quoting no shell). */
/** Config MCP do pane claude. Depois da limpa F6 o único servidor que entra
 *  aqui é o próprio Synkora — o Playwright e o test-runner por pane morreram
 *  com o armamento das fases, e o gui-planner é o único pane que ganha uma
 *  config. */
export function writeClaudeMcpConfig(
  baseDir: string,
  paneId: string,
  port: number,
  token: string
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
  writeFileSync(file, JSON.stringify({ mcpServers: servers }), 'utf-8')
  return file
}

export function claudeMcpArgs(configFile: string, strict: boolean): string[] {
  const args = ['--mcp-config', configFile]
  if (strict) args.push('--strict-mcp-config')
  return args
}
