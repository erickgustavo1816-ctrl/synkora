#!/usr/bin/env node
/**
 * A VOLTA COMPLETA DA IDENTIDADE DO CHAT DE PLANEJAMENTO.
 *
 * Por que esta suíte existe (R-11 da limpa F6): depois da purga, o `Hub` deixou
 * de ser "a mecânica de correio do F6" e passou a ser um componente VIVO da era
 * 2.0 — é o registro de identidade que autentica o único pane com ferramentas
 * MCP no app. As duas suítes que exercitavam o hub (mailbox-delivery,
 * helper-completion) morrem com a era; sem esta, o registro ficaria
 * carregando-o-app-inteiro e sem teste nenhum.
 *
 * E a auditoria de 08-15 já errou exatamente aqui: ela afirma que
 * `hub.registerPane` tem um chamador só (`paneLifecycle.armPane`, que morre).
 * Tem dois — `guiPlannerMcp.ts` é o segundo, e é o que embarca o `propose_plan`.
 * Quem seguir a auditoria ao pé da letra apaga o hub e leva o planejamento
 * junto. `test:gui-sessions` não pega: ele só COMPILA o guiPlannerMcp, nunca
 * exercita o registro.
 *
 * O que fica preso aqui, ponta a ponta, no código REAL (hub real, servidor HTTP
 * real, cliente MCP real):
 *   arm → token → registerPane → identityForRequest → catálogo → teardown.
 *
 * A CERCA é o retorno antecipado do `buildServer`. Ela foi provada VERMELHA:
 * trocando `identity.role === 'gui-planner'` por `true` no fonte, o caso do
 * catálogo vazio quebra na hora ("uma identidade que não é o planejador
 * recebeu 5 ferramentas").
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Hub } from '../.tmp/gui-planner-mcp-test/main/hub.js'
import { GUI_PLANNER_TOKEN_ENV } from '../.tmp/gui-planner-mcp-test/main/guiPlannerMcp.js'
import { armGuiDelegateMcp } from '../.tmp/gui-planner-mcp-test/main/guiDelegateMcp.js'
import { startMcpServer } from '../.tmp/gui-planner-mcp-test/main/mcpServer.js'

// O ARM DO PLANEJADOR (2026-08-30): a trilha própria (`armGuiPlannerMcp`)
// morreu quando o planejador entrou no regime da delegação — ele arma pelo
// MESMO encanamento dos outros chats, com o papel `gui-planner`. O wrapper
// mantém a suíte lendo como sempre leu.
const armGuiPlannerMcp = (input, deps) => armGuiDelegateMcp(input, deps, 'gui-planner')

/** O kit de PLANOS. Lista literal de propósito: ferramenta nova aqui é decisão
 *  de produto e tem que quebrar o teste. */
const PLAN_TOOLS = Object.freeze([
  'delete_plan',
  'get_plan',
  'list_plans',
  'propose_plan',
  'update_plan'
])

/** O kit de CÓDIGO (R14): as quatro perguntas ao servidor de linguagem. É o
 *  único kit COMPARTILHADO do app — os três chats e o ajudante o recebem —,
 *  porque ler código não é autoridade sobre nada. */
const LSP_TOOLS = Object.freeze([
  'lsp_definition',
  'lsp_diagnostics',
  'lsp_hover',
  'lsp_references'
])

/** O kit de AJUDANTES, que o planejador passou a enxergar em 2026-08-30
 *  (ordem do dono: "coloque os ajudantes também para eu selecionar"). A lista
 *  canônica dele vive em `test:gui-delegate-mcp`; aqui ela aparece porque o
 *  catálogo do planejador passou a incluí-la. */
const HELPER_TOOLS = Object.freeze([
  'delegate',
  'helper_cancel',
  'helper_result',
  'helper_resume',
  'helper_send',
  'helpers_status',
  'list_seats'
])

/** O kit de SKILLS (2026-09-08, Skills 3.0 — fatia 5.D): o planejador MONTA
 *  harness como o dev, porque o método do planejamento (ADR-0011) sai do mesmo
 *  cardápio. A lista canônica vive em `test:gui-delegate-mcp`. */
const SKILL_TOOLS = Object.freeze(['skill_discard', 'skill_pull', 'skill_search'])
const CONTEXT_READ = ['context_read', 'context_search', 'context_status']
const CONTEXT_WRITE = [...CONTEXT_READ, 'context_record']

/** O que o pane de PLANEJAMENTO enxerga hoje, inteiro: planos + ajudantes +
 *  código + skills — e NADA de integração, release ou browser. */
const PLANNER_TOOLS = Object.freeze(
  ['commentary', ...PLAN_TOOLS, ...HELPER_TOOLS, ...LSP_TOOLS, ...SKILL_TOOLS, ...CONTEXT_WRITE].sort()
)

/** Hub REAL com as dependências mínimas que ele exige (o registro de
 *  identidade não usa nenhuma delas — é justamente o ponto).
 *
 *  O hub NÃO tem mais timer: a fila de digitação morreu com o pipeline de
 *  fases (2026-08-17), e com ela o `dispose()`. Construir e largar é seguro —
 *  o que o teste precisa fechar é o servidor HTTP, não o hub. */
function hubIn(t) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-planner-mcp-'))
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

/** Deps do arm: espelham ipc/missions.ts (porta, userData/mcp, ctx.paneTokens
 *  e o mapa que o teardown do ipc/gui.ts consome). */
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

/** Servidor MCP real + o registro de qual catálogo cada identidade recebeu
 *  (o mesmo gancho que alimenta mcp/catalog-served na caixa-preta). */
async function serverIn(t, hub) {
  const served = []
  const calls = []
  const api = {
    hub,
    listPlans: (id) => {
      calls.push({ tool: 'list_plans', paneId: id.paneId, projectId: id.projectId })
      return 'nenhum plano ainda'
    },
    getPlan: () => 'plano',
    proposePlan: () => 'apresentada ao dono',
    updatePlan: () => 'plano atualizado',
    deletePlan: () => 'plano arquivado',
    noteCatalogServed: (id, tools) => served.push({ role: id.role, paneId: id.paneId, tools })
  }
  const handle = await startMcpServer(api)
  t.after(() => handle.close())
  return { handle, url: new URL(`http://127.0.0.1:${handle.port}/mcp`), served, calls }
}

async function connect(url, token, label) {
  const client = new Client({ name: `synkora-${label}`, version: '1.0.0' }, { cachePartition: label })
  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: { token: async () => token }
  })
  await client.connect(transport)
  return client
}

async function toolNames(url, token, label) {
  const client = await connect(url, token, label)
  try {
    return (await client.listTools()).tools.map((tool) => tool.name).sort()
  } finally {
    await client.close()
  }
}

/** JSON-RPC cru: o -32001 de token inválido é resposta do handler HTTP, ABAIXO
 *  da camada do cliente — só se vê falando com o socket. */
async function rawList(url, token) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  })
  const text = await response.text()
  return { status: response.status, text }
}

// ————— 1. a volta completa: arm → token → hub → request —————

test('o arm emite o token, registra a identidade no hub e o servidor a resolve', async (t) => {
  const { hub, root } = hubIn(t)
  const { url, served } = await serverIn(t, hub)
  const { deps, remembered } = armDeps(hub, root, 4242)

  const armed = armGuiPlannerMcp(
    {
      paneId: 'gui-planejamento-1',
      projectId: 'universo-1',
      cwd: root,
      cli: 'claude',
      missionId: 'missao-planejamento',
      seatId: 'seat-a'
    },
    deps
  )
  assert.ok(armed, 'o arm devia devolver as flags do spawn')

  const token = remembered[0].token
  const identity = hub.identityByToken(token)
  assert.equal(identity?.role, 'gui-planner')
  assert.equal(identity?.paneId, 'gui-planejamento-1')
  assert.equal(identity?.projectId, 'universo-1')
  assert.equal(identity?.missionId, 'missao-planejamento')
  assert.equal(identity?.seatId, 'seat-a')

  // o mesmo token, agora atravessando o servidor HTTP de verdade
  assert.deepEqual(await toolNames(url, token, 'planner'), PLANNER_TOOLS)
  const receipt = served.find((entry) => entry.paneId === 'gui-planejamento-1')
  assert.equal(receipt?.role, 'gui-planner')
  assert.deepEqual([...receipt.tools].sort(), PLANNER_TOOLS)
})

test('a config do claude leva a porta e o bearer; o codex leva os -c e o env', async (t) => {
  const { hub, root } = hubIn(t)
  const claude = armDeps(hub, root, 5151)
  const armedClaude = armGuiPlannerMcp(
    { paneId: 'pane-claude', projectId: 'p', cwd: root, cli: 'claude' },
    claude.deps
  )
  assert.ok(armedClaude.args.includes('--strict-mcp-config'), 'o planejador não herda MCP do seat')
  const configFile = claude.remembered[0].mcpFile
  const config = JSON.parse(readFileSync(configFile, 'utf-8'))
  assert.equal(config.mcpServers.synkora.url, 'http://127.0.0.1:5151/mcp')
  assert.equal(
    config.mcpServers.synkora.headers.Authorization,
    `Bearer ${claude.remembered[0].token}`
  )
  assert.deepEqual(Object.keys(config.mcpServers), ['synkora'], 'catálogo fechado: nenhum MCP extra')

  const codex = armDeps(hub, root, 5151)
  const armedCodex = armGuiPlannerMcp(
    { paneId: 'pane-codex', projectId: 'p', cwd: root, cli: 'codex' },
    codex.deps
  )
  assert.equal(armedCodex.env[GUI_PLANNER_TOKEN_ENV], codex.remembered[0].token)
  assert.ok(armedCodex.args.some((arg) => arg.includes('mcp_servers.synkora.url=http://127.0.0.1:5151/mcp')))
  assert.equal(codex.remembered[0].mcpFile, undefined, 'o codex não grava arquivo de config')
})

test('re-armar o MESMO pane reusa o token — o processo vivo leu o antigo', (t) => {
  const { hub, root } = hubIn(t)
  const { deps, remembered } = armDeps(hub, root, 4242)
  const input = { paneId: 'gui-remontado', projectId: 'p', cwd: root, cli: 'claude' }
  armGuiPlannerMcp(input, deps)
  armGuiPlannerMcp(input, deps)
  assert.equal(remembered.length, 2)
  assert.equal(
    remembered[0].token,
    remembered[1].token,
    'token novo deixaria o arquivo de config e o processo em desacordo'
  )
  assert.equal(hub.identityByToken(remembered[0].token)?.paneId, 'gui-remontado')
})

test('sem servidor de pé (porta 0) o chat nasce SEM ferramentas, nunca apontando para o vazio', (t) => {
  const { hub, root } = hubIn(t)
  const { deps, remembered } = armDeps(hub, root, 0)
  const armed = armGuiPlannerMcp(
    { paneId: 'gui-sem-porta', projectId: 'p', cwd: root, cli: 'claude' },
    deps
  )
  assert.equal(armed, undefined)
  assert.equal(remembered.length, 0)
  assert.equal(hub.identityByPane('gui-sem-porta'), undefined)
})

// ————— 2. a cerca: o catálogo é do planejador, e de mais ninguém —————

test('QUALQUER outra identidade recebe um servidor VAZIO — não um erro', async (t) => {
  const { hub, root } = hubIn(t)
  const { url, served } = await serverIn(t, hub)

  // os papéis do catálogo legado, um a um: nenhum enxerga uma linha do kit.
  // ('ajudante' saiu desta lista na R14 e ganhou o caso próprio abaixo — ele
  // deixou de ser um papel morto e passou a ser o AJUDANTE de verdade.)
  for (const role of ['maestro', 'dev', 'review', 'qa', 'livre']) {
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
  // e o servidor RESPONDE a todas: catálogo vazio é resposta honesta, não
  // falha. (O servidor é STATELESS — `buildServer` roda por REQUEST, então o
  // mesmo pane aparece mais de uma vez no registro; o que importa é que
  // nenhuma dessas construções serviu ferramenta alguma.)
  assert.deepEqual(
    [...new Set(served.map((entry) => entry.paneId))].sort(),
    ['pane-dev', 'pane-livre', 'pane-maestro', 'pane-qa', 'pane-review']
  )
  for (const entry of served) assert.deepEqual(entry.tools, [])
})

test('R14: o AJUDANTE recebe o kit de CÓDIGO e nenhuma linha do kit de planos', async (t) => {
  const { hub, root } = hubIn(t)
  const { url } = await serverIn(t, hub)
  hub.registerPane('token-ajudante', {
    paneId: 'gui-helper-abcd1234-1',
    projectId: 'universo-1',
    role: 'ajudante',
    cwd: root
  })
  const tools = await toolNames(url, 'token-ajudante', 'ajudante')
  // BROWSER EMBUTIDO (2026-08-29): o ajudante também verifica a própria tela —
  // o QA delegado é o caso real do design. A lista canônica das doze vive em
  // `test:gui-delegate-mcp`; esta suíte tinha ficado para trás (achado de
  // 2026-08-30, na rodada que deu delegação ao planejador).
  const browserTools = tools.filter((tool) => tool.startsWith('browser_'))
  assert.equal(browserTools.length, 12, 'o ajudante perdeu o kit do browser')
  assert.equal(tools.filter(tool => tool.startsWith('mobile_')).length, 6, 'o ajudante perdeu o kit Mobile')
  // SKILLS 3.0 (2026-09-08): o ajudante também PUXA skill — o briefing dele já
  // lista o que a missão puxou, e uma fatia que precisa de outro playbook não
  // pode depender de o delegador adivinhar.
  assert.deepEqual(
    tools.filter((tool) => !tool.startsWith('browser_') && !tool.startsWith('mobile_')),
    [...LSP_TOOLS, ...SKILL_TOOLS, ...CONTEXT_READ].sort()
  )
  // A cerca do ajudante mudou de NATUREZA (era ausência de token, virou
  // catálogo) mas não de tamanho: plano continua fora do alcance dele.
  for (const forbidden of PLAN_TOOLS) {
    assert.equal(tools.includes(forbidden), false, `o ajudante enxergou ${forbidden}`)
  }
})

test('a tool de plano recebe a identidade REAL do pane — escopo por universo', async (t) => {
  const { hub, root } = hubIn(t)
  const { url, calls } = await serverIn(t, hub)
  const { deps, remembered } = armDeps(hub, root, 1)
  armGuiPlannerMcp(
    { paneId: 'gui-a', projectId: 'universo-a', cwd: root, cli: 'claude' },
    deps
  )
  const client = await connect(url, remembered[0].token, 'escopo')
  t.after(() => client.close())
  const result = await client.callTool({ name: 'list_plans', arguments: {} })
  assert.equal(result.content[0].text, 'nenhum plano ainda')
  // a tool recebeu a identidade REAL do pane: é o escopo por universo
  assert.deepEqual(calls, [{ tool: 'list_plans', paneId: 'gui-a', projectId: 'universo-a' }])
})

// ————— 3. autenticação e revogação —————

test('sem bearer, ou com token desconhecido, o servidor recusa com -32001', async (t) => {
  const { hub } = hubIn(t)
  const { url } = await serverIn(t, hub)

  for (const token of [undefined, 'token-que-nunca-existiu']) {
    const { status, text } = await rawList(url, token)
    assert.equal(status, 401)
    assert.equal(JSON.parse(text).error.code, -32001)
  }
})

test('o teardown do pane REVOGA o token — a conversa fechada não fala mais', async (t) => {
  const { hub, root } = hubIn(t)
  const { url } = await serverIn(t, hub)
  const { deps, remembered } = armDeps(hub, root, 1)
  armGuiPlannerMcp(
    { paneId: 'gui-descartado', projectId: 'p', cwd: root, cli: 'claude' },
    deps
  )
  const token = remembered[0].token
  assert.deepEqual(await toolNames(url, token, 'antes'), PLANNER_TOOLS)

  // exatamente o que ipc/gui.ts faz no onPaneDisposed
  const dropped = hub.unregisterPane('gui-descartado')
  assert.equal(dropped?.role, 'gui-planner')
  assert.equal(hub.identityByToken(token), undefined)

  const { status, text } = await rawList(url, token)
  assert.equal(status, 401)
  assert.equal(JSON.parse(text).error.code, -32001)
})

test('o token de um pane não vale para outro: cada conversa fala por si', async (t) => {
  const { hub, root } = hubIn(t)
  await serverIn(t, hub)
  const a = armDeps(hub, root, 1)
  const b = armDeps(hub, root, 1)
  armGuiPlannerMcp({ paneId: 'gui-a', projectId: 'universo-a', cwd: root, cli: 'claude' }, a.deps)
  armGuiPlannerMcp({ paneId: 'gui-b', projectId: 'universo-b', cwd: root, cli: 'claude' }, b.deps)

  assert.notEqual(a.remembered[0].token, b.remembered[0].token)
  assert.equal(hub.identityByToken(a.remembered[0].token).projectId, 'universo-a')
  assert.equal(hub.identityByToken(b.remembered[0].token).projectId, 'universo-b')

  hub.unregisterPane('gui-a')
  assert.equal(hub.identityByToken(a.remembered[0].token), undefined)
  assert.equal(
    hub.identityByToken(b.remembered[0].token)?.paneId,
    'gui-b',
    'fechar uma conversa não pode derrubar a outra'
  )
})
