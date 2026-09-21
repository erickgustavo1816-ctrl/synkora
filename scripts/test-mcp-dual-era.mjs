#!/usr/bin/env node
/**
 * O SERVIDOR MCP DO SYNKORA FALA AS DUAS ERAS DO PROTOCOLO.
 *
 * A suíte antiga com este nome media o mesmo, mas o fixture dela ERA o catálogo
 * legado: ela stubava um `McpApi` de 45 membros (createTasks, report,
 * delegateMany, saveProjectPlan…). Aquilo morreu com a era F6. O que NÃO morreu
 * é o transporte: `startMcpServer` continua servindo `legacy: 'stateless'` e é
 * a única porta de entrada de ferramentas do app. Sem esta suíte, a superfície
 * MCP viva ficaria com ZERO teste de protocolo.
 *
 * Reescrita, então, sobre o catálogo que sobrou — o kit do chat de
 * planejamento. Cada asserção abaixo foi SONDADA contra o servidor real antes
 * de virar teste (nada aqui é suposição sobre o cliente):
 *
 *   legacy  (2025-11-25) → handshake de SESSÃO: initialize +
 *                          notifications/initialized, depois tools/list;
 *                          cabeçalho mcp-protocol-version, sem mcp-method.
 *   modern  (2026-07-28) → STATELESS: nenhum initialize; server/discover e
 *                          tools/list, cada requisição carimbada com
 *                          mcp-method (o Mcp-Method da spec nova).
 *
 * E a propriedade que dá nome ao arquivo: as duas eras recebem EXATAMENTE o
 * mesmo catálogo e a mesma identidade. Um CLI que atualize de era não ganha
 * nem perde ferramenta.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Hub } from '../.tmp/mcp-dual-era-test/main/hub.js'
import { startMcpServer } from '../.tmp/mcp-dual-era-test/main/mcpServer.js'

const LEGACY_VERSION = '2025-11-25'
const MODERN_VERSION = '2026-07-28'
const PLAN_TOOLS = Object.freeze([
  'delete_plan',
  'get_plan',
  'list_plans',
  'propose_plan',
  'update_plan'
])
/** R14: o kit de CÓDIGO entra no catálogo dos três chats. Ele aparece aqui
 *  porque a propriedade medida neste arquivo é "as duas eras recebem o MESMO
 *  catálogo" — e o catálogo cresceu. */
const LSP_TOOLS = Object.freeze([
  'lsp_definition',
  'lsp_diagnostics',
  'lsp_hover',
  'lsp_references'
])
/** 2026-08-30: o planejador entrou no regime da delegação — o catálogo dele
 *  ganhou as sete de ajudante. A propriedade DESTE arquivo continua a mesma
 *  (as duas eras recebem o MESMO catálogo); a lista canônica por papel vive
 *  em `test:gui-delegate-mcp`. */
const HELPER_TOOLS = Object.freeze([
  'delegate',
  'helper_cancel',
  'helper_result',
  'helper_resume',
  'helper_send',
  'helpers_status',
  'list_seats'
])
/** SKILLS 3.0 (2026-09-08 — fatia 5.D): as três de skill entram no catálogo do
 *  planejador junto com o resto. Mesma razão do bloco acima: a propriedade
 *  medida aqui é "as duas eras recebem o MESMO catálogo", e ele cresceu. */
const SKILL_TOOLS = Object.freeze(['skill_discard', 'skill_pull', 'skill_search'])
const CONTEXT_TOOLS = ['context_read', 'context_record', 'context_search', 'context_status']
const PLANNER_TOOLS = Object.freeze(
  ['commentary', ...PLAN_TOOLS, ...HELPER_TOOLS, ...LSP_TOOLS, ...SKILL_TOOLS, ...CONTEXT_TOOLS].sort()
)

const ERAS = Object.freeze([
  { era: 'legacy', mode: 'legacy', version: LEGACY_VERSION },
  { era: 'modern', mode: { pin: MODERN_VERSION }, version: MODERN_VERSION }
])

/** Servidor real + hub real. O `api` é só o kit de planos: os cinco métodos
 *  que o catálogo vivo expõe, nada mais. */
async function serverIn(t) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-dual-era-'))
  const hub = new Hub({
    projectPathOf: () => root,
    ensureProjectRuntimeWritable: () => {},
    onEvent: () => {}
  })
  const calls = []
  const handle = await startMcpServer({
    hub,
    listPlans: (id) => {
      calls.push({ tool: 'list_plans', paneId: id.paneId })
      return `planos de ${id.projectId}`
    },
    getPlan: (id, planId) => `plano ${planId} de ${id.paneId}`,
    proposePlan: () => 'apresentada ao dono',
    updatePlan: () => 'plano atualizado',
    deletePlan: () => 'plano arquivado'
  })
  t.after(async () => {
    await handle.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { hub, root, calls, url: new URL(`http://127.0.0.1:${handle.port}/mcp`) }
}

function planner(hub, root, suffix) {
  const token = `token-${suffix}`
  hub.registerPane(token, {
    paneId: `gui-${suffix}`,
    projectId: `universo-${suffix}`,
    role: 'gui-planner',
    cwd: root
  })
  return token
}

/** fetch instrumentado: registra método e cabeçalhos de protocolo de cada
 *  requisição e, UMA vez, segura o primeiro `tools/call` (o catálogo do
 *  planejador responde em microssegundos — sem isso não existe pedido em voo
 *  para cancelar). O sinal de abort é honrado aqui como o faria uma rede real,
 *  e é justamente por isso que a rejeição tem de ser IMEDIATA: se o SDK não
 *  repassasse o AbortSignal ao transporte, este atraso rodaria inteiro. */
function tracedFetch(log, holdFirst) {
  let held = false
  return async (input, init) => {
    let method = '(stream)'
    try {
      method = JSON.parse(init.body).method
    } catch {
      /* GET do canal de eventos não tem corpo */
    }
    const headers = new Headers(init.headers ?? {})
    log.push({
      method,
      protocolVersion: headers.get('mcp-protocol-version'),
      mcpMethod: headers.get('mcp-method')
    })
    if (holdFirst && !held && method === 'tools/call') {
      held = true
      await new Promise((resolvePending, rejectPending) => {
        const timer = setTimeout(resolvePending, holdFirst.ms)
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          rejectPending(new DOMException('Aborted', 'AbortError'))
        })
      })
    }
    return fetch(input, init)
  }
}

async function openClient(url, token, mode, label, options = {}) {
  const log = []
  const client = new Client(
    { name: `synkora-dual-era-${label}`, version: '1.0.0' },
    { versionNegotiation: { mode }, cachePartition: label }
  )
  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: { token: async () => token },
    fetch: tracedFetch(log, options.holdFirstCall)
  })
  await client.connect(transport)
  return { client, log }
}

function textOf(result) {
  const block = result.content?.find((item) => item.type === 'text')
  assert.ok(block, 'a tool devia responder com um bloco de texto')
  return block.text
}

// ————— 1. cada era faz o seu aperto de mão, e o servidor atende os dois —————

test('a era legada abre SESSÃO: initialize, initialized e só então tools/list', async (t) => {
  const { hub, root, url } = await serverIn(t)
  const token = planner(hub, root, 'legacy')
  const { client, log } = await openClient(url, token, 'legacy', 'legacy')
  t.after(() => client.close())

  assert.equal(client.getProtocolEra(), 'legacy')
  assert.equal(client.getNegotiatedProtocolVersion(), LEGACY_VERSION)
  assert.deepEqual(log.slice(0, 2).map((entry) => entry.method), [
    'initialize',
    'notifications/initialized'
  ])

  await client.listTools()
  const list = log.find((entry) => entry.method === 'tools/list')
  assert.equal(list.protocolVersion, LEGACY_VERSION)
  assert.equal(list.mcpMethod, null, 'Mcp-Method é carimbo da spec nova, não da antiga')
})

test('a era nova é STATELESS: nenhum initialize, e cada request se anuncia no cabeçalho', async (t) => {
  const { hub, root, url } = await serverIn(t)
  const token = planner(hub, root, 'modern')
  const { client, log } = await openClient(url, token, { pin: MODERN_VERSION }, 'modern')
  t.after(() => client.close())

  assert.equal(client.getProtocolEra(), 'modern')
  assert.equal(client.getNegotiatedProtocolVersion(), MODERN_VERSION)
  assert.equal(
    log.some((entry) => entry.method === 'initialize'),
    false,
    'a era nova removeu o handshake — sessão é o que ela deixou de exigir'
  )

  await client.listTools()
  for (const entry of log) {
    assert.equal(entry.protocolVersion, MODERN_VERSION)
    assert.equal(entry.mcpMethod, entry.method, 'Mcp-Method espelha o método do corpo')
  }
})

// ————— 2. a propriedade que dá nome ao arquivo —————

test('as duas eras recebem EXATAMENTE o mesmo catálogo e a mesma identidade', async (t) => {
  const { hub, root, url, calls } = await serverIn(t)
  const observed = []
  for (const { era, mode } of ERAS) {
    const token = planner(hub, root, era)
    const { client } = await openClient(url, token, mode, `catalog-${era}`)
    t.after(() => client.close())
    observed.push((await client.listTools()).tools.map((tool) => tool.name).sort())
    assert.equal(textOf(await client.callTool({ name: 'list_plans', arguments: {} })), `planos de universo-${era}`)
  }
  assert.deepEqual(observed[0], PLANNER_TOOLS)
  assert.deepEqual(observed[1], PLANNER_TOOLS, 'trocar de era do protocolo não muda o kit')
  assert.deepEqual(calls, [
    { tool: 'list_plans', paneId: 'gui-legacy' },
    { tool: 'list_plans', paneId: 'gui-modern' }
  ])
})

test('a cerca do catálogo não depende da era: identidade não-planejadora fica vazia nas duas', async (t) => {
  const { hub, root, url } = await serverIn(t)
  for (const { era, mode } of ERAS) {
    hub.registerPane(`token-dev-${era}`, {
      paneId: `pane-dev-${era}`,
      projectId: 'u',
      role: 'dev',
      cwd: root
    })
    const { client } = await openClient(url, `token-dev-${era}`, mode, `dev-${era}`)
    t.after(() => client.close())
    assert.deepEqual((await client.listTools()).tools, [], `a era ${era} não abre exceção na cerca`)
  }
})

test('o argumento chega íntegro nas duas eras (o schema zod vale igual)', async (t) => {
  const { hub, root, url } = await serverIn(t)
  for (const { era, mode } of ERAS) {
    const token = planner(hub, root, `args-${era}`)
    const { client } = await openClient(url, token, mode, `args-${era}`)
    t.after(() => client.close())
    const ok = await client.callTool({ name: 'get_plan', arguments: { planId: 'plano-7' } })
    assert.equal(textOf(ok), `plano plano-7 de gui-args-${era}`)
    // e o schema recusa o que não obedece — em qualquer era
    const bad = await client
      .callTool({ name: 'get_plan', arguments: { planId: '' } })
      .catch((error) => ({ isError: true, error }))
    assert.equal(bad.isError, true, 'planId vazio tinha que ser recusado')
  }
})

// ————— 3. cancelamento e desconexão —————

test('pedido em voo cancelado pelo cliente rejeita, e a conexão sobrevive', async (t) => {
  const { hub, root, url } = await serverIn(t)
  const token = planner(hub, root, 'abort')
  const { client } = await openClient(url, token, { pin: MODERN_VERSION }, 'abort', {
    holdFirstCall: { ms: 5_000 }
  })
  t.after(() => client.close())

  const controller = new AbortController()
  const started = Date.now()
  const pending = client.callTool(
    { name: 'list_plans', arguments: {} },
    { signal: controller.signal, timeout: 10_000 }
  )
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(pending, (error) =>
    error?.name === 'AbortError' || /abort/i.test(String(error?.message))
  )
  // O atraso é de 5s; a rejeição sai em milissegundos SÓ porque o AbortSignal
  // atravessa o SDK até o transporte. Se algum dia parar de atravessar, este
  // número explode e o teste conta o porquê.
  assert.ok(Date.now() - started < 1_000, 'o cancelamento tem de chegar ao transporte')

  // o MESMO cliente continua servindo: cancelar um pedido não derruba o canal
  const after = await client.callTool({ name: 'update_plan', arguments: { planId: 'p1' } })
  assert.equal(textOf(after), 'plano atualizado')
})

test('vários clientes das duas eras ao mesmo tempo: catálogo idêntico, identidade de cada um', async (t) => {
  const { hub, root, url } = await serverIn(t)
  const opened = await Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      const { era, mode } = ERAS[index % 2]
      const token = planner(hub, root, `c8-${index}`)
      const { client } = await openClient(url, token, mode, `c8-${index}`)
      const tools = (await client.listTools()).tools.map((tool) => tool.name).sort()
      const mine = textOf(await client.callTool({ name: 'list_plans', arguments: {} }))
      return { client, era, tools, mine, index }
    })
  )
  t.after(() => Promise.all(opened.map((entry) => entry.client.close())))
  for (const entry of opened) {
    assert.deepEqual(entry.tools, PLANNER_TOOLS)
    assert.equal(entry.mine, `planos de universo-c8-${entry.index}`, 'cada cliente fala pelo SEU pane')
  }
})
