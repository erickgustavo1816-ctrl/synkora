#!/usr/bin/env node
/**
 * A VOLTA COMPLETA DA IDENTIDADE DO CHAT QUE DELEGA (`gui-delegator`).
 *
 * Irmã do `test:gui-planner-mcp`, e pelo mesmo motivo: o catálogo do MCP é a
 * superfície mais perigosa do app — quem enxerga o quê é decidido por um
 * retorno antecipado dentro do `buildServer`, e um `if` trocado ali entrega
 * ferramenta de frota a um papel que nunca deveria tê-la.
 *
 * Aqui a propriedade que dá nome ao arquivo é a CERCA EM TRÊS FAIXAS
 * (design DESIGN_SUBAGENTES_SEM_ABA_2026-08-18.md, D2 e D7):
 *
 *   gui-delegator → EXATAMENTE as 6 ferramentas de ajudante, e nenhum plano;
 *   gui-planner   → EXATAMENTE as 5 de plano, e nenhum ajudante;
 *   qualquer outro (inclusive quem parece ajudante) → catálogo VAZIO.
 *
 * A terceira faixa é o CONTROLE NEGATIVO DO SEM-CADEIA: o ajudante nasce sem o
 * MCP de delegação, e se um dia um token de ajudante chegar ao servidor ele
 * precisa bater numa parede. Frota que abre frota é o laço que o backstop de
 * 100 do motor existe para conter — mas a cerca boa é esta, aqui, no catálogo.
 *
 * Tudo roda no código REAL: hub real, servidor HTTP real, cliente MCP real. O
 * único duplo é o `McpApi` (o harness do index.ts), porque é justamente o
 * contrato entre este catálogo e o motor que a onda 2 está costurando.
 *
 * SONDADO ANTES DE VIRAR TESTE (`.tmp/w2-probe/probe-validation.mjs`, servidor
 * real): violação de schema NÃO é erro de protocolo — ela volta como RESULTADO
 * com `isError: true` e o texto "Input validation error: …". Só tool
 * INEXISTENTE levanta `ProtocolError -32602`. As asserções abaixo usam essa
 * medida, não a intuição.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Hub } from '../.tmp/gui-delegate-mcp-test/hub.js'
import { armGuiPlannerMcp, GUI_PLANNER_TOKEN_ENV } from '../.tmp/gui-delegate-mcp-test/guiPlannerMcp.js'
import {
  armGuiDelegateMcp,
  guiPaneToolKind,
  CLAUDE_NATIVE_AGENT_FENCE,
  GUI_DELEGATE_CLAUDE_TOOL_TIMEOUT_MS,
  GUI_DELEGATE_CODEX_TOOL_TIMEOUT_SEC
} from '../.tmp/gui-delegate-mcp-test/guiDelegateMcp.js'
import { startMcpServer } from '../.tmp/gui-delegate-mcp-test/mcpServer.js'

/** O catálogo do delegador, literal. Ferramenta nova aqui é decisão de produto
 *  e TEM de quebrar este teste — é o mesmo contrato do PLANNER_TOOLS. */
const DELEGATOR_TOOLS = Object.freeze([
  'delegate',
  'helper_cancel',
  'helper_result',
  'helper_send',
  'helpers_status',
  'list_seats'
])

const PLANNER_TOOLS = Object.freeze([
  'delete_plan',
  'get_plan',
  'list_plans',
  'propose_plan',
  'update_plan'
])

/** Hub REAL com o mínimo que ele exige (o registro de identidade não usa nada
 *  disso — é o ponto). Sem timer: o hub perdeu a fila de digitação em 08-17. */
function hubIn(t) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-delegate-mcp-'))
  const hub = new Hub({
    projectPathOf: () => root,
    ensureProjectRuntimeWritable: () => {},
    onEvent: () => {}
  })
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
  })
  return { hub, root }
}

/** Deps do arm: espelham `guiPlannerMcpDepsFor` (porta, userData/mcp,
 *  ctx.paneTokens e o mapa que o teardown do ipc/gui.ts consome). */
function armDeps(hub, root, port) {
  const tokens = new Map()
  const remembered = []
  return {
    tokens,
    remembered,
    deps: {
      hub,
      port: () => port,
      configRoot: () => join(root, 'mcp'),
      tokenOf: (paneId) => tokens.get(paneId),
      remember: (paneId, artifacts) => {
        tokens.set(paneId, artifacts.token)
        remembered.push({ paneId, ...artifacts })
      }
    }
  }
}

/**
 * Servidor MCP real. `engine: false` deixa TODOS os métodos de delegação
 * ausentes — é o estado real do app enquanto o motor não está costurado, e o
 * catálogo tem de continuar de pé com recusa legível em vez de estourar.
 */
async function serverIn(t, hub, { engine = true } = {}) {
  const served = []
  const calls = []
  const delegation = engine
    ? {
        delegateHelpers: async (id, helpers) => {
          calls.push({
            tool: 'delegate',
            paneId: id.paneId,
            projectId: id.projectId,
            role: id.role,
            helpers
          })
          return `abri ${helpers.length} ajudante(s)`
        },
        listSeats: async (id) => {
          calls.push({ tool: 'list_seats', paneId: id.paneId })
          return 'contas do universo'
        },
        helpersStatus: (id) => {
          calls.push({ tool: 'helpers_status', paneId: id.paneId })
          return 'nenhum ajudante vivo'
        },
        helperResult: async (id, helperId, waitSeconds) => {
          calls.push({ tool: 'helper_result', paneId: id.paneId, helperId, waitSeconds })
          return `entrega de ${helperId}`
        },
        helperSend: (id, helperId, text) => {
          calls.push({ tool: 'helper_send', paneId: id.paneId, helperId, text })
          return 'mensagem entregue'
        },
        helperCancel: (id, helperId) => {
          calls.push({ tool: 'helper_cancel', paneId: id.paneId, helperId })
          return 'ajudante encerrado'
        }
      }
    : {}
  const handle = await startMcpServer({
    hub,
    listPlans: () => 'nenhum plano ainda',
    getPlan: () => 'plano',
    proposePlan: () => 'apresentada ao dono',
    updatePlan: () => 'plano atualizado',
    deletePlan: () => 'plano arquivado',
    noteCatalogServed: (id, tools) => served.push({ role: id.role, paneId: id.paneId, tools }),
    ...delegation
  })
  t.after(() => handle.close())
  return { handle, url: new URL(`http://127.0.0.1:${handle.port}/mcp`), served, calls }
}

async function connect(t, url, token, label) {
  const client = new Client(
    { name: `synkora-${label}`, version: '1.0.0' },
    { cachePartition: label }
  )
  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: { token: async () => token }
  })
  await client.connect(transport)
  t.after(() => client.close())
  return client
}

async function toolNames(url, token, label) {
  const client = new Client(
    { name: `synkora-${label}`, version: '1.0.0' },
    { cachePartition: label }
  )
  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: { token: async () => token }
  })
  await client.connect(transport)
  try {
    return (await client.listTools()).tools.map((tool) => tool.name).sort()
  } finally {
    await client.close()
  }
}

function textOf(result) {
  const block = result.content?.find((item) => item.type === 'text')
  assert.ok(block, 'a tool devia responder com um bloco de texto')
  return block.text
}

/** Arma um delegador e devolve o token pronto para falar com o servidor. */
function delegator(hub, root, port, paneId = 'gui-dev-abcd1234') {
  const armed = armDeps(hub, root, port)
  const mcp = armGuiDelegateMcp(
    {
      paneId,
      projectId: 'universo-1',
      cwd: root,
      cli: 'claude',
      missionId: 'missao-dev-1',
      seatId: 'seat-a'
    },
    armed.deps
  )
  return { ...armed, mcp, token: armed.remembered[0]?.token }
}

// ————— 1. o catálogo do delegador, e só ele —————

test('o arm registra a identidade gui-delegator e o servidor serve as SEIS ferramentas', async (t) => {
  const { hub, root } = hubIn(t)
  const { url, served } = await serverIn(t, hub)
  const { mcp, token } = delegator(hub, root, 4242)

  assert.ok(mcp, 'o arm devia devolver as flags do spawn')
  const identity = hub.identityByToken(token)
  assert.equal(identity?.role, 'gui-delegator')
  assert.equal(identity?.paneId, 'gui-dev-abcd1234')
  assert.equal(identity?.projectId, 'universo-1')
  assert.equal(identity?.missionId, 'missao-dev-1')
  assert.equal(identity?.seatId, 'seat-a')

  assert.deepEqual(await toolNames(url, token, 'delegador'), DELEGATOR_TOOLS)
  const receipt = served.find((entry) => entry.paneId === 'gui-dev-abcd1234')
  assert.equal(receipt?.role, 'gui-delegator')
  assert.deepEqual([...receipt.tools].sort(), DELEGATOR_TOOLS)
})

test('nenhum vazamento entre os dois kits: quem delega não planeja e quem planeja não delega', async (t) => {
  const { hub, root } = hubIn(t)
  const { url } = await serverIn(t, hub)

  const dev = delegator(hub, root, 4242, 'gui-dev-11111111')
  const planner = armDeps(hub, root, 4242)
  armGuiPlannerMcp(
    { paneId: 'gui-dev-22222222', projectId: 'universo-1', cwd: root, cli: 'claude' },
    planner.deps
  )

  const devTools = await toolNames(url, dev.token, 'kit-dev')
  const plannerTools = await toolNames(url, planner.remembered[0].token, 'kit-plan')
  assert.deepEqual(devTools, DELEGATOR_TOOLS)
  assert.deepEqual(plannerTools, PLANNER_TOOLS, 'o kit de planos não pode mudar por causa desta onda')
  for (const tool of PLANNER_TOOLS) {
    assert.equal(devTools.includes(tool), false, `o delegador enxergou ${tool}`)
  }
  for (const tool of DELEGATOR_TOOLS) {
    assert.equal(plannerTools.includes(tool), false, `o planejador enxergou ${tool}`)
  }
})

test('SEM CADEIA: identidade de ajudante (ou qualquer outra) recebe catálogo VAZIO', async (t) => {
  const { hub, root } = hubIn(t)
  const { url, served } = await serverIn(t, hub)

  // 'dev'/'ajudante' são os papéis com que um ajudante apareceria se um dia
  // alguém lhe desse identidade. Nenhum deles pode enxergar `delegate`: é a
  // cerca que impede frota abrindo frota (D1 do design).
  for (const role of ['dev', 'ajudante', 'review', 'qa', 'maestro', 'livre']) {
    const token = `token-${role}`
    hub.registerPane(token, {
      paneId: `pane-${role}`,
      projectId: 'universo-1',
      role,
      cwd: root
    })
    assert.deepEqual(
      await toolNames(url, token, `role-${role}`),
      [],
      `a identidade ${role} não pode enxergar ferramenta nenhuma`
    )
  }
  for (const entry of served) {
    if (entry.paneId.startsWith('pane-')) assert.deepEqual(entry.tools, [])
  }
})

// ————— 2. a porta de entrada do delegate —————

test('delegate recusa lote vazio e pedido sem texto — a validação é do schema', async (t) => {
  const { hub, root } = hubIn(t)
  const { url } = await serverIn(t, hub)
  const { token } = delegator(hub, root, 4242)
  const client = await connect(t, url, token, 'validacao')

  const vazio = await client.callTool({ name: 'delegate', arguments: { helpers: [] } })
  assert.equal(vazio.isError, true, 'lote vazio não pode passar')
  assert.match(textOf(vazio), /Input validation error/u)

  const semTexto = await client.callTool({
    name: 'delegate',
    arguments: { helpers: [{ prompt: '' }] }
  })
  assert.equal(semTexto.isError, true, 'ajudante sem tarefa não pode nascer')
  assert.match(textOf(semTexto), /Input validation error/u)
})

test('o teto de 100 é trava anti-laço, nunca cota: 100 ajudantes passam de uma vez', async (t) => {
  const { hub, root } = hubIn(t)
  const { url, calls } = await serverIn(t, hub)
  const { token } = delegator(hub, root, 4242)
  const client = await connect(t, url, token, 'frota')

  // Ordem do dono (18/08): "não precisa ter um teto — ele quiser delegar
  // vinte, trinta, o problema é dele". O 100 existe só para um bug em laço
  // não derrubar a máquina.
  const cem = Array.from({ length: 100 }, (_, i) => ({ prompt: `fatia ${i + 1}` }))
  const ok = await client.callTool({ name: 'delegate', arguments: { helpers: cem } })
  assert.notEqual(ok.isError, true, 'uma frota de 100 é decisão do dono, não erro')
  assert.equal(calls.at(-1).helpers.length, 100)

  const cemEUm = await client.callTool({
    name: 'delegate',
    arguments: { helpers: [...cem, { prompt: 'a gota' }] }
  })
  assert.equal(cemEUm.isError, true, 'acima da trava anti-laço a chamada é recusada')
})

test('delegate entrega o lote VERBATIM ao motor, com a identidade deste pane', async (t) => {
  const { hub, root } = hubIn(t)
  const { url, calls } = await serverIn(t, hub)
  const { token } = delegator(hub, root, 4242)
  const client = await connect(t, url, token, 'lote')

  const result = await client.callTool({
    name: 'delegate',
    arguments: {
      helpers: [
        { prompt: 'revise o diff', model: 'opus[1m]', effort: 'high', name: 'revisor' },
        { prompt: 'escreva os testes', model: 'gpt-5.6-luna', seat: 'seat-codex' }
      ]
    }
  })
  assert.equal(textOf(result), 'abri 2 ajudante(s)')
  assert.deepEqual(calls, [
    {
      tool: 'delegate',
      paneId: 'gui-dev-abcd1234',
      projectId: 'universo-1',
      role: 'gui-delegator',
      helpers: [
        { prompt: 'revise o diff', model: 'opus[1m]', effort: 'high', name: 'revisor' },
        { prompt: 'escreva os testes', model: 'gpt-5.6-luna', seat: 'seat-codex' }
      ]
    }
  ])
})

test('o controle do delegador é total: status, resultado, steering e cancelamento chegam ao motor', async (t) => {
  const { hub, root } = hubIn(t)
  const { url, calls } = await serverIn(t, hub)
  const { token } = delegator(hub, root, 4242)
  const client = await connect(t, url, token, 'controle')

  assert.equal(
    textOf(await client.callTool({ name: 'helpers_status', arguments: {} })),
    'nenhum ajudante vivo'
  )
  assert.equal(
    textOf(await client.callTool({ name: 'list_seats', arguments: {} })),
    'contas do universo'
  )
  assert.equal(
    textOf(await client.callTool({ name: 'helper_result', arguments: { helperId: 'h-1' } })),
    'entrega de h-1'
  )
  assert.equal(
    textOf(
      await client.callTool({ name: 'helper_send', arguments: { helperId: 'h-1', text: 'foca no css' } })
    ),
    'mensagem entregue'
  )
  assert.equal(
    textOf(await client.callTool({ name: 'helper_cancel', arguments: { helperId: 'h-1' } })),
    'ajudante encerrado'
  )

  assert.deepEqual(
    calls.map((call) => call.tool),
    ['helpers_status', 'list_seats', 'helper_result', 'helper_send', 'helper_cancel']
  )
  // waitSeconds ausente = o motor aplica o padrão de 45s; o catálogo não
  // inventa número nenhum no lugar dele.
  assert.equal(calls[2].waitSeconds, undefined)
  assert.equal(calls[3].text, 'foca no css')
  assert.equal(calls[4].helperId, 'h-1')
})

test('helper_result carrega o waitSeconds pedido e o schema grampeia o teto de 240s', async (t) => {
  const { hub, root } = hubIn(t)
  const { url, calls } = await serverIn(t, hub)
  const { token } = delegator(hub, root, 4242)
  const client = await connect(t, url, token, 'longpoll')

  // 240s é o teto PROVADO (S3): claude corta tool MCP em 60s por default e o
  // arm levanta o teto para 300s dos dois lados — o long-poll tem de caber
  // dentro disso com folga.
  const noTeto = await client.callTool({
    name: 'helper_result',
    arguments: { helperId: 'h-2', waitSeconds: 240 }
  })
  assert.notEqual(noTeto.isError, true)
  assert.equal(calls.at(-1).waitSeconds, 240)

  const acima = await client.callTool({
    name: 'helper_result',
    arguments: { helperId: 'h-2', waitSeconds: 241 }
  })
  assert.equal(acima.isError, true, 'acima do teto do servidor a espera é recusada na porta')

  const quebrado = await client.callTool({
    name: 'helper_result',
    arguments: { helperId: 'h-2', waitSeconds: 12.5 }
  })
  assert.equal(quebrado.isError, true, 'espera fracionária não existe')
})

test('sem o motor ligado, as SEIS respondem com recusa LEGÍVEL — nunca erro de protocolo', async (t) => {
  const { hub, root } = hubIn(t)
  const { url } = await serverIn(t, hub, { engine: false })
  const { token } = delegator(hub, root, 4242)
  const client = await connect(t, url, token, 'motor-desligado')

  assert.deepEqual(await toolNames(url, token, 'motor-desligado-lista'), DELEGATOR_TOOLS)

  const chamadas = [
    ['delegate', { helpers: [{ prompt: 'faça algo' }] }],
    ['list_seats', {}],
    ['helpers_status', {}],
    ['helper_result', { helperId: 'h-1' }],
    ['helper_send', { helperId: 'h-1', text: 'oi' }],
    ['helper_cancel', { helperId: 'h-1' }]
  ]
  for (const [name, args] of chamadas) {
    const result = await client.callTool({ name, arguments: args })
    assert.notEqual(result.isError, true, `${name} devia responder, não estourar`)
    assert.match(
      textOf(result),
      /o motor de delegação ainda não está ligado/u,
      `${name} precisa explicar por que não abriu nada`
    )
  }
})

// ————— 3. o spawn: cerca anti-nativo e teto de tool —————

test('claude: config própria, strict, a CERCA de subagente nativo e o teto de tool no env', async (t) => {
  const { hub, root } = hubIn(t)
  const { mcp, remembered } = delegator(hub, root, 5151)

  const configFile = remembered[0].mcpFile
  assert.ok(mcp.args.includes('--mcp-config'), 'o claude fala com o Synkora por arquivo de config')
  assert.ok(mcp.args.includes(configFile))
  assert.ok(mcp.args.includes('--strict-mcp-config'), 'o chat que delega não herda MCP do seat')

  // A cerca é a ordem do dono virada mecânica: subagente NATIVO aposentado.
  // Cerca de 1-2 nomes não basta (sonda: o modelo desviou por RemoteTrigger
  // três vezes) — a lista inteira vai numa flag só.
  const fenceAt = mcp.args.indexOf('--disallowedTools')
  assert.notEqual(fenceAt, -1, 'sem --disallowedTools o chat continua abrindo subagente nativo')
  assert.equal(mcp.args[fenceAt + 1], CLAUDE_NATIVE_AGENT_FENCE.join(','))
  for (const name of ['Task', 'Agent', 'Workflow', 'SendMessage', 'RemoteTrigger', 'ToolSearch']) {
    assert.ok(CLAUDE_NATIVE_AGENT_FENCE.includes(name), `a cerca perdeu ${name}`)
  }
  // O que a cerca NUNCA pode levar junto (sonda probe-claude-fence §2.4).
  for (const survivor of ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Skill', 'TaskCreate']) {
    assert.equal(
      CLAUDE_NATIVE_AGENT_FENCE.includes(survivor),
      false,
      `a cerca não pode remover ${survivor}`
    )
  }

  // 60s é o teto default do claude para tool MCP (medido); o long-poll de 240s
  // não cabe nele. O env levanta para 300s e sobrevive à higiene do spawn.
  assert.equal(mcp.env?.MCP_TOOL_TIMEOUT, String(GUI_DELEGATE_CLAUDE_TOOL_TIMEOUT_MS))
  assert.equal(GUI_DELEGATE_CLAUDE_TOOL_TIMEOUT_MS, 300_000)

  const config = JSON.parse(readFileSync(configFile, 'utf-8'))
  assert.equal(config.mcpServers.synkora.url, 'http://127.0.0.1:5151/mcp')
  assert.equal(
    config.mcpServers.synkora.headers.Authorization,
    `Bearer ${remembered[0].token}`
  )
  assert.deepEqual(Object.keys(config.mcpServers), ['synkora'], 'catálogo fechado: nenhum MCP extra')
})

test('codex: teto de tool por config, cerca multi_agent e nenhum valor com espaço', async (t) => {
  const { hub, root } = hubIn(t)
  const armed = armDeps(hub, root, 5151)
  const mcp = armGuiDelegateMcp(
    { paneId: 'gui-dev-cdcdcdcd', projectId: 'p', cwd: root, cli: 'codex' },
    armed.deps
  )

  assert.ok(mcp, 'o codex também delega')
  assert.equal(mcp.env[GUI_PLANNER_TOKEN_ENV], armed.remembered[0].token)
  assert.equal(armed.remembered[0].mcpFile, undefined, 'o codex não grava arquivo de config')

  const args = mcp.args
  assert.ok(args.some((arg) => arg === `mcp_servers.synkora.url=http://127.0.0.1:5151/mcp`))
  assert.ok(args.some((arg) => arg === `mcp_servers.synkora.bearer_token_env_var=${GUI_PLANNER_TOKEN_ENV}`))
  assert.ok(
    args.some((arg) => arg === `mcp_servers.synkora.tool_timeout_sec=${GUI_DELEGATE_CODEX_TOOL_TIMEOUT_SEC}`),
    'sem tool_timeout_sec o long-poll fica à mercê do default'
  )
  assert.equal(GUI_DELEGATE_CODEX_TOOL_TIMEOUT_SEC, 300)
  assert.ok(
    args.some((arg) => arg === 'features.multi_agent=false'),
    'a cerca mecânica do codex é o cinto do suppressNativeAgents'
  )

  // ARMADILHA MEDIDA: `-c chave=valor` viaja por spawn(shell:true), que não
  // escapa nada — um espaço no valor é picado pelo cmd.exe e o app-server
  // trava no initialize. Nenhum valor desta lista pode ter espaço.
  for (const arg of args) {
    assert.equal(/\s/u.test(arg), false, `valor com espaço morre no shell: ${arg}`)
  }
})

test('re-armar o MESMO pane reusa o token; identidade de outro papel no mesmo id não é reusada', (t) => {
  const { hub, root } = hubIn(t)
  const { deps, remembered } = armDeps(hub, root, 4242)
  const input = {
    paneId: 'gui-dev-eeee1111',
    projectId: 'p',
    cwd: root,
    cli: 'claude'
  }
  armGuiDelegateMcp(input, deps)
  armGuiDelegateMcp(input, deps)
  assert.equal(remembered.length, 2)
  assert.equal(
    remembered[0].token,
    remembered[1].token,
    'token novo deixaria o arquivo de config e o processo vivo em desacordo'
  )

  // O mesmo endereço com papel ANTIGO (o pane era planejador) não pode herdar
  // o token: o catálogo mudaria embaixo de uma identidade que já foi servida.
  const planner = armDeps(hub, root, 4242)
  armGuiPlannerMcp({ ...input, paneId: 'gui-dev-ffff2222' }, planner.deps)
  const reused = armDeps(hub, root, 4242)
  reused.tokens.set('gui-dev-ffff2222', planner.remembered[0].token)
  armGuiDelegateMcp({ ...input, paneId: 'gui-dev-ffff2222' }, reused.deps)
  assert.notEqual(reused.remembered[0].token, planner.remembered[0].token)
  assert.equal(hub.identityByToken(reused.remembered[0].token).role, 'gui-delegator')
})

test('sem servidor de pé (porta 0) o chat de missão nasce SEM ferramentas', (t) => {
  const { hub, root } = hubIn(t)
  const { deps, remembered } = armDeps(hub, root, 0)
  const armed = armGuiDelegateMcp(
    { paneId: 'gui-dev-00000000', projectId: 'p', cwd: root, cli: 'claude' },
    deps
  )
  assert.equal(armed, undefined)
  assert.equal(remembered.length, 0)
  assert.equal(hub.identityByPane('gui-dev-00000000'), undefined)
})

test('o teardown do pane REVOGA o token do delegador', async (t) => {
  const { hub, root } = hubIn(t)
  const { url } = await serverIn(t, hub)
  const { token } = delegator(hub, root, 4242, 'gui-dev-99999999')
  assert.deepEqual(await toolNames(url, token, 'antes-do-teardown'), DELEGATOR_TOOLS)

  const dropped = hub.unregisterPane('gui-dev-99999999')
  assert.equal(dropped?.role, 'gui-delegator')
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  })
  assert.equal(response.status, 401)
  assert.equal(JSON.parse(await response.text()).error.code, -32001)
})

// ————— 4. o roteador: um pane tem UM dos dois kits —————

test('guiPaneToolKind: planejamento planeja, missão dev delega, o resto fica sem nada', () => {
  const dev = { id: 'm1' }
  const planejamento = { id: 'm2', missionType: 'planejamento' }

  assert.equal(guiPaneToolKind('gui-dev-11111111', dev), 'delegator')
  assert.equal(guiPaneToolKind('gui-reviewer-11111111', dev), 'delegator')
  assert.equal(guiPaneToolKind('gui-helper-11111111-2', dev), 'delegator')
  // Missão legada não tem carimbo, e ausência é 'dev' por definição.
  assert.equal(guiPaneToolKind('gui-dev-11111111', { id: 'm3', missionType: undefined }), 'delegator')

  assert.equal(guiPaneToolKind('gui-dev-22222222', planejamento), 'planner')

  // As duas ausências: pane órfão de missão apagada, e endereço que não é de
  // missão nenhuma — o planejamento de PROJETO (`gui-plan-…`, que hoje nasce
  // sem ferramenta) e um shell não podem ganhar kit por vizinhança.
  assert.equal(guiPaneToolKind('gui-dev-11111111', undefined), 'none')
  assert.equal(guiPaneToolKind('gui-plan-33333333', planejamento), 'none')
  assert.equal(guiPaneToolKind('gui-plan-33333333', undefined), 'none')
  assert.equal(guiPaneToolKind('shell-1', dev), 'none')
})

test('o re-arme por spawn roteia pelo tipo da missão e audita a recusa do delegador', () => {
  const arm = readFileSync(new URL('../src/main/guiPlannerArm.ts', import.meta.url), 'utf8')

  // O roteador é UM: quem spawna re-materializa, e o pane de missão dev sai
  // com o MCP de delegação em vez de sair mudo.
  assert.match(arm, /guiPaneToolKind\(/u, 'o roteador precisa da régua compartilhada')
  assert.match(arm, /rearmGuiDelegateMcp\(ctx, spawn\)/u)
  assert.match(arm, /armGuiDelegateMcp\(/u)

  // Mesma prova do planejador, na trilha nova: o arquivo que o claude vai
  // abrir tem de existir AGORA (caso real de 2026-08-17).
  assert.match(arm, /event: 'gui-delegate-arm-refused'/u)
  const delegateArm = arm.slice(arm.indexOf('export function rearmGuiDelegateMcp'))
  assert.ok(delegateArm.length > 0, 'o rearme do delegador sumiu do arquivo')
  assert.match(delegateArm, /if \(!file \|\| !existsSync\(file\)\) return refuse\('config-file-missing'\)/u)
  assert.match(delegateArm, /ctx\.mcpPort === 0/u)
})
