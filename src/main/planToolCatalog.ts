import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { PaneIdentity } from './hub'
import type { McpApi } from './mcpServer'
import type { PlanPatch } from './plans'

export const PLAN_TOOL_NAMES = ['list_plans', 'get_plan', 'propose_plan', 'update_plan', 'delete_plan'] as const

const PLAN_ITEM_CONTEXT_DESCRIBE =
  'seção Contexto — o MAPA DA FATIA: arquivos/módulos que importam, o que JÁ existe neles, o que será criado e onde NÃO mexer quando isso desenha a fronteira. Ele viaja VERBATIM para o briefing do dev desta missão: item sem mapa obriga o dev a re-derivar sozinho o repositório que você acabou de estudar.'

export function registerPlanKit(server: McpServer, api: Pick<McpApi, 'listPlans' | 'getPlan' | 'proposePlan' | 'updatePlan' | 'deletePlan'>, identity: PaneIdentity): void {
  const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })
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
}
