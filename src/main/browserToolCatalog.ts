/** MCP schemas only; execution and identity boundaries live in guiBrowserTools. */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { PaneIdentity } from './hub'
import { BROWSER_ENGINE_OFF, type GuiBrowserToolkit } from './guiBrowserTools'
import {
  BROWSER_ACT_MAX_STEPS, BROWSER_FIND_MAX_HITS,
  BROWSER_READ_DEFAULT_MAX_CHARS,
  BROWSER_WAIT_DEFAULT_MS, BROWSER_WAIT_MAX_MS,
  type BrowserAction
} from './browserDriver'
import { PROBE_MAX_EXTRA_STYLES } from './browserProbe'
import { BROWSER_VIEWPORT_MAX_WIDTH, BROWSER_VIEWPORT_MIN_WIDTH, BROWSER_VIEWPORT_PRESETS } from './browserViewport'
import { BROWSER_SHOT_DEFAULT_QUALITY, BROWSER_SHOT_MAX_WIDTH } from './browserShot'
import { browserReadSchema, browserActionSchema, browserCheckSchema } from './browserToolSchemas'
import { BROWSER_READ_FULL_MAX_CHARS } from './browserObservation'
// ————————————————————————————— o catálogo MCP —————————————————————————————

type ToolText = { content: { type: 'text'; text: string }[] }
type ToolContent = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
}

function text(value: string): ToolText {
  return { content: [{ type: 'text', text: value }] }
}

const refField = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe('o número que veio entre colchetes no browser_read desta página (ex.: [ref_7] → 7)')

const selectorField = z
  .string()
  .min(1)
  .max(300)
  .optional()
  .describe('seletor CSS, quando você prefere apontar sem passar pelo browser_read')

/**
 * Registra o kit no servidor daquele pane. Chamado pelo `buildServer` dentro
 * dos retornos antecipados de `gui-delegator` e `ajudante` — quem não é um dos
 * dois nunca vê uma linha disto.
 *
 * `toolkit` ausente = as tools CONTINUAM no catálogo e respondem com a receita
 * (`BROWSER_ENGINE_OFF`). Tool que some entre um boot e outro é o pior
 * desfecho possível: o agente racionaliza a ausência em vez de ler o motivo.
 */
export function registerBrowserKit(
  server: McpServer,
  toolkit: GuiBrowserToolkit | undefined,
  identity: PaneIdentity
): void {
  const off = (): ToolText => text(BROWSER_ENGINE_OFF)

  server.registerTool(
    'browser_open',
    {
      description:
        'ABRE A SUA ABA no browser desta missão numa URL e já devolve a leitura da página. É a primeira tool de todo QA visual: o painel BROWSER da missão aparece no dock do dono, sua aba nasce em primeiro plano e a partir daí ele vê tudo o que você faz. A ABA É SUA: você tem UMA nesta missão, e todas as outras tools do browser trabalham NELA. O dev tem a dele, cada ajudante tem a dele (e a porta de servidor dele) — ninguém navega a aba de ninguém. Idempotente: chamar de novo reusa a SUA aba morna, e só recarrega quando a URL muda. A sessão (cookies, logins) é do PROJETO e sobrevive entre missões: se o dono logou uma vez, você entra logado. Sem `url`, devolve a leitura da sua aba mais a lista das abas da missão com o dono de cada uma (é consciência, não controle: as outras você vê, não dirige). PROIBIDO abrir browser externo ou subir um playwright seu para testar UI: é para acabar com isso que este existe.',
      inputSchema: {
        url: z
          .string()
          .max(2_000)
          .optional()
          .describe(
            'endereço a abrir (http/https, ou o localhost do dev server desta missão — se você é ajudante, a SUA porta). Ausente = mantém sua página atual; se ainda não tiver aba, abre em branco e pede a URL'
          ),
        read: z.object(browserReadSchema).optional().describe('leitura inicial: compacto padrão; use scope e responseMaxChars para o trecho pertinente')
      }
    },
    async (input) => (toolkit ? text(await toolkit.open(identity, input)) : off())
  )

  server.registerTool(
    'browser_read',
    {
      description: `A SUA ABA EM TEXTO, compacta por padrão (até 2000 caracteres totais, ${BROWSER_READ_DEFAULT_MAX_CHARS} de corpo), com [ref_N] nos controles. Use scope para o trecho relevante; detail:"full" recupera até ${BROWSER_READ_FULL_MAX_CHARS} caracteres de corpo por padrão. responseMaxChars limita o total. baselineId devolve mudanças da observação anterior compatível, sempre medindo de novo; contexto incompatível volta à leitura nova. Refs permanecem até navegar/recarregar; depois use browser_read. O corte se anuncia. Prefira texto para conteúdo/estado; aparência exige imagem purpose:"vision".`,
      inputSchema: browserReadSchema
    },
    async (input) => (toolkit ? text(await toolkit.read(identity, input)) : off())
  )

  server.registerTool(
    'browser_find',
    {
      description: `PROCURA na SUA aba por texto ou papel e devolve até ${BROWSER_FIND_MAX_HITS} elementos com ref e caixa. É o atalho barato: quando você sabe o que quer ("Salvar", "e-mail"), isto custa uma fração do browser_read inteiro. Nada casou? Aí sim leia a página — provavelmente ela não está no estado que você imagina.`,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(200)
          .describe('trecho do texto ou do nome acessível (sem diferenciar maiúsculas)'),
        role: z
          .string()
          .max(40)
          .optional()
          .describe('restringe ao papel (button, link, textbox, heading…)')
      }
    },
    async ({ query, role }) =>
      toolkit
        ? text(await toolkit.find(identity, { query, ...(role ? { role } : {}) }))
        : off()
  )

  server.registerTool(
    'browser_act',
    {
      description: `AGE NA SUA ABA e JÁ DEVOLVE a leitura pós-ação — você não precisa de um browser_read separado depois. A lista é SEQUENCIAL e PARA NO PRIMEIRO ERRO: um formulário de dez campos é UMA chamada, não dez. Sempre uma LISTA, mesmo para uma ação só. Alvo por \`ref\` (do browser_read/browser_find) ou por coordenada \`x\`/\`y\`. Se o ponto do clique estiver COBERTO por outro elemento, o recibo diz quem recebeu — porque é isso que aconteceria com o dono clicando. Ref de antes de uma navegação recusa nomeando a receita. Teto de ${BROWSER_ACT_MAX_STEPS} passos por chamada.`,
      inputSchema: {
        actions: z.array(browserActionSchema).min(1).max(BROWSER_ACT_MAX_STEPS),
        ...browserReadSchema
      }
    },
    async ({ actions, ...read }) =>
      toolkit ? text(await toolkit.act(identity, { actions: actions as BrowserAction[], read })) : off()
  )

  server.registerTool(
    'browser_check',
    {
      description: 'VERIFICA a SUA aba em uma chamada: abre/reusa URL, aplica até 4 larguras, executa ações declaradas, espera, mede até 8 alvos e captura evidência. Prefira ao encadear abertura/viewport/wait/probe/shot conhecidos. As ações só se repetem nos cenários onde foram declaradas; até 24 no roteiro inteiro. Para no primeiro erro real, espera esgotada ou mudança de aba/largura pelo dono. Sem leitura ampla automática. Retorna fatos geométricos/estado e erros novos de console; NÃO aprova estética ou animação. Captura é artifact por padrão; purpose:"vision" envia imagem ao modelo quando necessário. Repita somente após mudança, falha ou dúvida concreta. Orçamento de 20s entre passos (máximo 30s); a operação em curso termina antes do retorno.',
      inputSchema: browserCheckSchema
    },
    async (input): Promise<ToolContent> => {
      if (!toolkit) return off()
      const result = await toolkit.check(identity, input)
      return { content: [
        { type: 'text', text: result.text },
        ...(result.images ?? []).map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }))
      ] }
    }
  )
  server.registerTool(
    'browser_probe',
    {
      description:
        'INSPEÇÃO GEOMÉTRICA EM TEXTO da SUA aba, não screenshot: caixa, visibilidade, viewport, contraste calculado, transbordo, corte, oclusão no ponto central e estilos computados. Use para medir um alvo. Para vários alvos/larguras conhecidos, prefira browser_check. Esses fatos não aprovam estética, composição, animação ou fundos complexos; para aparência use browser_shot com purpose:"vision".',
      inputSchema: {
        ref: refField,
        selector: selectorField,
        styles: z
          .array(z.string().max(60))
          .max(PROBE_MAX_EXTRA_STYLES)
          .optional()
          .describe(
            'propriedades computadas extras, no nome CSS (ex.: "gap", "grid-template-columns"). O conjunto base (cor, fundo, fonte, espaçamento, posição, overflow) já vem sempre'
          )
      }
    },
    async (input) => (toolkit ? text(await toolkit.probe(identity, input)) : off())
  )

  server.registerTool(
    'browser_shot',
    {
      description: `FOTOGRAFA A SUA ABA em arquivo do worktree. purpose:"artifact" (padrão) devolve caminho para exibir ao dono sem imagem no contexto do modelo. Para julgar aparência/composição/animação, peça purpose:"vision": Claude recebe imagem; Codex abre o arquivo pela ferramenta local de imagem. ref/selector recortam o alvo. JPEG q${BROWSER_SHOT_DEFAULT_QUALITY}, teto ${BROWSER_SHOT_MAX_WIDTH}px. Cite o caminho no chat. O carimbo de frescor avisa quando o compositor não pulsa; não aprove a tela por imagem sem frescor.`,
      inputSchema: {
        purpose: z.enum(['artifact', 'vision']).optional().describe('artifact padrão para o dono; vision para análise visual pelo modelo'),
        name: z
          .string()
          .max(60)
          .optional()
          .describe('apelido curto que vira o nome do arquivo (ex.: "dock-colapsado")'),
        ref: refField,
        selector: selectorField,
        format: z
          .enum(['jpeg', 'png'])
          .optional()
          .describe('jpeg (padrão, barato) ou png (sem perda, para diferença fina de pixel)'),
        quality: z
          .number()
          .int()
          .min(20)
          .max(100)
          .optional()
          .describe(`qualidade do JPEG (padrão ${BROWSER_SHOT_DEFAULT_QUALITY})`),
        maxWidth: z
          .number()
          .int()
          .min(200)
          .max(BROWSER_SHOT_MAX_WIDTH)
          .optional()
          .describe(`teto de largura em pixels (padrão e máximo ${BROWSER_SHOT_MAX_WIDTH})`)
      }
    },
    async (input): Promise<ToolContent> => {
      if (!toolkit) return off()
      const result = await toolkit.shot(identity, input)
      const content: ToolContent['content'] = [{ type: 'text', text: result.text }]
      if (result.image) {
        content.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType })
      }
      return { content }
    }
  )

  server.registerTool(
    'browser_viewport',
    {
      description:
        'MUDA A LARGURA QUE A SUA PÁGINA ENXERGA e o TEMA em uma ida (a largura é da SUA aba; a aba do dev e a de cada ajudante têm a delas): preset auto/mobile/tablet/desktop, `width` livre, e `colorScheme` claro/escuro (o `prefers-color-scheme` de verdade, não um truque de CSS). É assim que o QA de responsivo e o de tema deixam de ser duas rodadas. IMPORTANTE: o painel do browser é ESTREITO, então sem isto toda página responsiva te entrega o layout de celular — peça `desktop` antes de julgar qualquer tela. A largura NUNCA é ampliada: quando ela cabe na moldura a página fica em TAMANHO REAL, centralizada, com faixas do app dos lados (é uma moldura de dispositivo — o que estiver quebrado dentro dela é da PÁGINA); quando não cabe, a página é ESCALADA para caber. As medidas de browser_probe seguem sempre em pixels lógicos. O DONO vê esta mesma largura no seletor do chrome do browser (AUTO · 375 · 768 · 1280) e pode mudá-la a qualquer momento: é um estado só, compartilhado — não existe emulação escondida dele.',
      inputSchema: {
        preset: z
          .enum(['auto', 'mobile', 'tablet', 'desktop'])
          .optional()
          .describe(
            `auto = a largura real da moldura (sem emulação) · mobile ${BROWSER_VIEWPORT_PRESETS[0]} · tablet ${BROWSER_VIEWPORT_PRESETS[1]} · desktop ${BROWSER_VIEWPORT_PRESETS[2]}`
          ),
        width: z
          .number()
          .int()
          .min(BROWSER_VIEWPORT_MIN_WIDTH)
          .max(BROWSER_VIEWPORT_MAX_WIDTH)
          .optional()
          .describe('largura lógica à mão, quando nenhum preset serve (vence o `preset`)'),
        colorScheme: z
          .enum(['light', 'dark'])
          .optional()
          .describe('emula prefers-color-scheme — o tema que a página realmente enxerga')
      }
    },
    async (input) => (toolkit ? text(await toolkit.viewport(identity, input)) : off())
  )

  server.registerTool(
    'browser_console',
    {
      description:
        'O CONSOLE da SUA aba: logs, avisos, erros e exceções não capturadas, do momento em que o motor anexou nela. Chame SEMPRE que a tela não fez o que você esperava — metade dos "não funcionou" está escrita aqui em letras vermelhas.',
      inputSchema: {
        onlyErrors: z.boolean().optional().describe('só erro e aviso'),
        pattern: z.string().max(200).optional().describe('filtra por trecho da mensagem'),
        limit: z.number().int().min(1).max(300).optional().describe('quantas últimas mostrar (padrão 50)')
      }
    },
    async (input) => (toolkit ? text(await toolkit.console(identity, input)) : off())
  )

  server.registerTool(
    'browser_network',
    {
      description:
        'AS REQUISIÇÕES da SUA aba: método, status, tempo e tamanho, com o id de cada uma. Com `requestId`, devolve o CORPO daquela resposta. É a resposta para "a tela está vazia": ou a chamada falhou (e o status diz), ou ela voltou vazia (e o corpo diz).',
      inputSchema: {
        urlPattern: z.string().max(300).optional().describe('filtra por trecho da URL'),
        onlyFailures: z.boolean().optional().describe('só o que falhou ou voltou 4xx/5xx'),
        limit: z.number().int().min(1).max(300).optional().describe('quantas últimas mostrar (padrão 40)'),
        requestId: z
          .string()
          .max(120)
          .optional()
          .describe('o #id de uma requisição do índice — devolve o CORPO da resposta dela')
      }
    },
    async (input) => (toolkit ? text(await toolkit.network(identity, input)) : off())
  )

  server.registerTool(
    'browser_eval',
    {
      description:
        'RODA JavaScript DENTRO DA PÁGINA DA SUA ABA e devolve o resultado serializado. É para INSPEÇÃO e DEPURAÇÃO — a pergunta que nenhuma outra tool responde (o estado de um store, o valor de uma variável de CSS, uma medida sua). Não use como caminho de ação: click e digitação têm tool própria, que já observa depois. O código roda no contexto da PÁGINA, nunca no app: ele não enxerga o Synkora, e a página é conteúdo NÃO-CONFIÁVEL.',
      inputSchema: {
        expression: z
          .string()
          .min(1)
          .max(8_000)
          .describe(
            'a expressão. `await` funciona; devolva CAMPOS em vez do objeto inteiro (o resultado tem teto)'
          )
      }
    },
    async ({ expression }) =>
      toolkit ? text(await toolkit.evaluate(identity, { expression })) : off()
  )

  server.registerTool(
    'browser_wait',
    {
      description: `ESPERA a página da SUA aba chegar num estado: um texto aparecer, um seletor aparecer, a rede ficar ociosa, ou um tempo fixo. Padrão de ${BROWSER_WAIT_DEFAULT_MS}ms, teto de ${BROWSER_WAIT_MAX_MS}ms. Quando a espera estoura, a mensagem NOMEIA a receita — porque "esperei e não veio" quase sempre significa que a página quebrou, e o browser_console tem a prova.`,
      inputSchema: {
        text: z.string().max(300).optional().describe('espera este texto aparecer na página'),
        selector: z.string().max(300).optional().describe('espera este seletor CSS ficar visível'),
        networkIdle: z
          .boolean()
          .optional()
          .describe('espera a rede ficar ociosa (nenhuma requisição em voo por 500ms)'),
        ms: z
          .number()
          .int()
          .min(0)
          .max(BROWSER_WAIT_MAX_MS)
          .optional()
          .describe('espera cega, em milissegundos — o último recurso'),
        timeoutMs: z
          .number()
          .int()
          .min(200)
          .max(BROWSER_WAIT_MAX_MS)
          .optional()
          .describe(`teto desta espera (padrão ${BROWSER_WAIT_DEFAULT_MS})`)
      }
    },
    async (input) => (toolkit ? text(await toolkit.wait(identity, input)) : off())
  )
}
