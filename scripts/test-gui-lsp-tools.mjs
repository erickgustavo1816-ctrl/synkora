#!/usr/bin/env node
/**
 * AS FERRAMENTAS DE CÓDIGO DOS CHATS (R14, seção L2 do design
 * `.synkora/reports/DESIGN_COPIA_E_LSP_R14_2026-08-19.md`).
 *
 * O motor (onda 1) já tem a suíte dele (`test:lsp-engine`, 36 testes, com um
 * servidor LSP falso falando o protocolo de verdade). Esta suíte prende a
 * OUTRA metade — a borda entre o motor e o agente —, e ela tem duas metades
 * também:
 *
 *  A) O RECIBO. É o único artefato que o agente lê, então cada propriedade dele
 *     é contrato: o formato da linha (`arquivo:linha:coluna severidade código
 *     mensagem`), a posição 1-BASED viajando VERBATIM nos dois sentidos (uma
 *     conversão a mais nesta borda somaria 1 duas vezes e o agente editaria a
 *     linha errada em todo chat do app), o teto dito em voz alta, o filtro de
 *     extensão dito quando derruba alguém, e — a regra que o CLAUDE.md chama de
 *     "beco sem saída é bug" — a frase do motor com a RECEITA chegando inteira,
 *     nunca reescrita.
 *
 *  B) O CATÁLOGO. É a superfície mais perigosa do app: quem enxerga o quê sai de
 *     um retorno antecipado dentro do `buildServer`. A R14 acrescenta uma faixa
 *     NOVA — o papel `ajudante`, que até aqui recebia catálogo VAZIO, passa a
 *     receber o kit de código E SÓ ELE. É a cerca do D1 mudando de natureza: era
 *     ausência de token, vira catálogo sem `delegate`. Um `if` trocado ali
 *     devolve à frota o poder de abrir frota, e é este arquivo que avisa.
 *
 * Tudo roda no código REAL (hub real, servidor HTTP real, cliente MCP real). Os
 * únicos duplos são o `LspManager` (a suíte do motor é quem prova o protocolo) e
 * o `McpApi` do index.ts.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Hub } from '../.tmp/gui-lsp-tools-test/hub.js'
import { startMcpServer } from '../.tmp/gui-lsp-tools-test/mcpServer.js'
import {
  buildGuiLspTools,
  lspExtensionsLabel,
  LSP_DIAGNOSTICS_FILES_MAX,
  LSP_DIAGNOSTICS_ITEM_CAP,
  LSP_TOOL_NAMES
} from '../.tmp/gui-lsp-tools-test/guiLspTools.js'
import { LspError } from '../.tmp/gui-lsp-tools-test/lsp/lspSession.js'

/** O kit de código, literal e ordenado. Ferramenta nova aqui é decisão de
 *  produto e TEM de quebrar este teste — mesmo contrato do PLANNER_TOOLS. */
const LSP_TOOLS = Object.freeze([
  'lsp_definition',
  'lsp_diagnostics',
  'lsp_hover',
  'lsp_references'
])

const PLANNER_TOOLS = Object.freeze([
  'delete_plan',
  'get_plan',
  'list_plans',
  'propose_plan',
  'update_plan'
])
const DELEGATOR_TOOLS = Object.freeze([
  'delegate',
  'helper_cancel',
  'helper_result',
  'helper_resume',
  'helper_send',
  'helpers_status',
  'list_seats'
])
const INTEGRATION_TOOLS = Object.freeze(['integration_run', 'integration_status'])
const RELEASE_TOOLS = Object.freeze(['release_run', 'release_status'])

const sorted = (...groups) => Object.freeze([...groups.flat()].sort())

const ROOT = 'C:/wt/missao-01'
const IDENTITY = Object.freeze({
  paneId: 'gui-dev-abcd1234',
  projectId: 'universo-1',
  role: 'gui-delegator',
  cwd: ROOT,
  missionId: 'missao-1'
})

// ————— A. o recibo —————

/**
 * Dublê do motor. Não sobe processo nenhum: a suíte do motor é quem prova o
 * protocolo, e o que importa AQUI é o que atravessa esta borda — quais arquivos
 * chegaram ao servidor, com que posição, e o que voltou em texto.
 */
function makeToolkit(overrides = {}) {
  const calls = { roots: [], diagnostics: [], definition: [], references: [], hover: [] }
  const logs = []
  const answer = (value, fallback) => (value === undefined ? fallback : value)
  const session = {
    diagnostics: async (files) => {
      calls.diagnostics.push(files)
      const value = answer(overrides.diagnostics, [])
      return typeof value === 'function' ? value(files) : value
    },
    definition: async (file, line, column) => {
      calls.definition.push({ file, line, column })
      return answer(overrides.definition, { ok: true, value: [] })
    },
    references: async (file, line, column) => {
      calls.references.push({ file, line, column })
      return answer(overrides.references, { ok: true, value: [] })
    },
    hover: async (file, line, column) => {
      calls.hover.push({ file, line, column })
      return answer(overrides.hover, { ok: true, value: null })
    }
  }
  const tools = buildGuiLspTools({
    manager: {
      sessionFor: async (root) => {
        calls.roots.push(root)
        if (overrides.sessionError) throw overrides.sessionError
        return session
      }
    },
    ...(overrides.changedFiles ? { changedFiles: overrides.changedFiles } : {}),
    log: (entry) => logs.push(entry)
  })
  return { tools, calls, logs }
}

test('o recibo imprime arquivo:linha:coluna severidade código mensagem, uma linha por problema', async () => {
  const { tools, calls } = makeToolkit({
    diagnostics: [
      {
        file: 'src/a.ts',
        line: 12,
        column: 5,
        severity: 'error',
        code: 'TS2304',
        message: "Cannot find name 'foo'"
      },
      { file: 'src/b.ts', line: 1, column: 1, severity: 'warning', message: 'sem código' }
    ]
  })

  const receipt = await tools.diagnostics(IDENTITY, ['src/a.ts', 'src/b.ts'])
  const lines = receipt.split('\n')
  // 1-BASED VERBATIM: o motor já entrega 1-based, e esta borda não soma nada.
  assert.equal(lines[1], "src/a.ts:12:5 erro TS2304 Cannot find name 'foo'")
  // Sem `code` a linha não ganha campo vazio nem um placeholder inventado.
  assert.equal(lines[2], 'src/b.ts:1:1 aviso sem código')
  assert.match(lines[0], /^2 problema\(s\) em 2 de 2 arquivo\(s\)/u)
  assert.equal(lines.length, 3)

  // Os arquivos chegaram ao servidor como foram pedidos, e a RAIZ saiu do cwd
  // da identidade — nunca de um argumento do agente.
  assert.deepEqual(calls.diagnostics, [['src/a.ts', 'src/b.ts']])
  assert.deepEqual(calls.roots, [ROOT])
})

test('arquivo limpo é resposta afirmativa, não silêncio', async () => {
  const { tools } = makeToolkit({ diagnostics: [] })
  const receipt = await tools.diagnostics(IDENTITY, ['src/a.ts'])
  assert.match(receipt, /^nenhum problema em 1 arquivo\(s\) de C:\/wt\/missao-01: src\/a\.ts\.$/u)
})

test('o TETO de problemas é dito em voz alta, com os dois números', async () => {
  const many = Array.from({ length: LSP_DIAGNOSTICS_ITEM_CAP + 50 }, (_, i) => ({
    file: 'src/a.ts',
    line: i + 1,
    column: 1,
    severity: 'error',
    code: 'TS1',
    message: `problema ${i}`
  }))
  const { tools } = makeToolkit({ diagnostics: many })
  const receipt = await tools.diagnostics(IDENTITY, ['src/a.ts'])
  const lines = receipt.split('\n')
  assert.equal(lines.length, 1 + LSP_DIAGNOSTICS_ITEM_CAP + 1)
  assert.equal(
    lines.at(-1),
    `… mostrei ${LSP_DIAGNOSTICS_ITEM_CAP} de ${many.length} (teto de ${LSP_DIAGNOSTICS_ITEM_CAP} problemas por chamada) — conserte estes e chame de novo para ver o resto.`
  )
})

test('mensagem gigantesca é cortada com … e nunca quebra a linha do recibo', async () => {
  const { tools } = makeToolkit({
    diagnostics: [
      {
        file: 'src/a.ts',
        line: 3,
        column: 9,
        severity: 'error',
        code: 'TS2322',
        message: `${'x'.repeat(5000)}\nsegunda linha`
      }
    ]
  })
  const receipt = await tools.diagnostics(IDENTITY, ['src/a.ts'])
  const lines = receipt.split('\n')
  // Uma mensagem multilinha de 5 000 caracteres viraria dezenas de linhas
  // falsas no recibo — cada uma parecendo um problema novo.
  assert.equal(lines.length, 2)
  assert.match(lines[1], /^src\/a\.ts:3:9 erro TS2322 x+…$/u)
})

test('sem `files` o alvo são os arquivos MODIFICADOS da raiz, e o recibo diz isso', async () => {
  const seen = []
  const { tools, calls } = makeToolkit({
    changedFiles: async (root) => {
      seen.push(root)
      return ['src/a.ts', 'src/b.tsx']
    },
    diagnostics: []
  })
  const receipt = await tools.diagnostics(IDENTITY)
  assert.deepEqual(seen, [ROOT])
  assert.deepEqual(calls.diagnostics, [['src/a.ts', 'src/b.tsx']])
  assert.match(receipt, /MODIFICADO\(S\) de C:\/wt\/missao-01/u)
})

test('o filtro de extensão é DITO quando derruba alguém — e não derruba .mjs/.cjs', async () => {
  const { tools, calls } = makeToolkit({
    changedFiles: async () => [
      'src/a.ts',
      'scripts/test-x.mjs',
      'src/legado.cjs',
      'README.md',
      'package.json'
    ],
    diagnostics: []
  })
  const receipt = await tools.diagnostics(IDENTITY)
  // `.mjs`/`.cjs` são código que o servidor FALA (este repositório é feito de
  // `scripts/*.mjs`): dizer "fora do alcance" sobre eles seria recibo mentiroso.
  assert.deepEqual(calls.diagnostics, [['src/a.ts', 'scripts/test-x.mjs', 'src/legado.cjs']])
  assert.match(receipt, /2 arquivo\(s\) ficaram de fora/u)
  assert.match(receipt, /README\.md, package\.json/u)
  assert.ok(receipt.includes(lspExtensionsLabel()), 'o recibo tem de dizer o que o servidor fala')
})

test('só arquivos que o servidor não fala: a recusa nomeia a receita, e ninguém é acordado', async () => {
  const { tools, calls } = makeToolkit({ changedFiles: async () => ['README.md', 'CHANGELOG.md'] })
  const receipt = await tools.diagnostics(IDENTITY)
  assert.match(receipt, /nenhum dos 2 arquivo\(s\) é de código/u)
  assert.match(receipt, /`files`/u)
  assert.deepEqual(calls.roots, [], 'não vale subir um servidor de linguagem para não perguntar nada')
})

test('nada modificado: a resposta é honesta E nomeia como olhar mesmo assim', async () => {
  const { tools, calls } = makeToolkit({ changedFiles: async () => [] })
  const receipt = await tools.diagnostics(IDENTITY)
  assert.match(receipt, /nenhum arquivo modificado em C:\/wt\/missao-01/u)
  assert.match(receipt, /chame de novo com `files`/u)
  assert.deepEqual(calls.diagnostics, [])
})

test('sem a fonte de arquivos modificados a tool recusa com a receita — nunca finge "limpo"', async () => {
  // O harness ainda não ligou o gitWorker: responder "nenhum problema" aqui
  // seria a pior mentira possível — o agente relataria código limpo ao dono.
  const { tools } = makeToolkit({})
  const receipt = await tools.diagnostics(IDENTITY)
  assert.match(receipt, /não sei quais arquivos você modificou/u)
  assert.match(receipt, /chame de novo com `files`/u)
})

test('o teto de ARQUIVOS por chamada também é dito, com a receita do resto', async () => {
  const files = Array.from({ length: LSP_DIAGNOSTICS_FILES_MAX + 3 }, (_, i) => `src/f${i}.ts`)
  const { tools, calls } = makeToolkit({ changedFiles: async () => files, diagnostics: [] })
  const receipt = await tools.diagnostics(IDENTITY)
  assert.equal(calls.diagnostics[0].length, LSP_DIAGNOSTICS_FILES_MAX)
  assert.match(receipt, /3 arquivo\(s\) ficaram para a próxima/u)
  assert.match(receipt, new RegExp(`teto é de ${LSP_DIAGNOSTICS_FILES_MAX} por chamada`, 'u'))
})

test('as três consultas pontuais recebem a posição 1-BASED VERBATIM', async () => {
  const { tools, calls } = makeToolkit({
    definition: { ok: true, value: [] },
    references: { ok: true, value: [] },
    hover: { ok: true, value: null }
  })
  await tools.definition(IDENTITY, 'src/a.ts', 12, 5)
  await tools.references(IDENTITY, 'src/a.ts', 12, 5)
  await tools.hover(IDENTITY, 'src/a.ts', 12, 5)
  // Uma conversão a mais AQUI somaria 1 duas vezes (o motor já converte na
  // borda dele) e o agente leria o símbolo vizinho em todo chat do app.
  const expected = [{ file: 'src/a.ts', line: 12, column: 5 }]
  assert.deepEqual(calls.definition, expected)
  assert.deepEqual(calls.references, expected)
  assert.deepEqual(calls.hover, expected)
})

test('definição e referências: a lista sai em arquivo:linha:coluna, com a contagem', async () => {
  const { tools } = makeToolkit({
    definition: {
      ok: true,
      value: [{ file: 'src/b.ts', line: 3, column: 14, endLine: 3, endColumn: 20 }]
    },
    references: {
      ok: true,
      value: [
        { file: 'src/a.ts', line: 12, column: 5, endLine: 12, endColumn: 8 },
        { file: 'C:/fora/lib.d.ts', line: 900, column: 2, endLine: 900, endColumn: 9 }
      ]
    }
  })
  assert.equal(
    await tools.definition(IDENTITY, 'src/a.ts', 12, 5),
    '1 definição de src/a.ts:12:5:\nsrc/b.ts:3:14'
  )
  assert.equal(
    await tools.references(IDENTITY, 'src/a.ts', 12, 5),
    '2 referências de src/a.ts:12:5:\nsrc/a.ts:12:5\nC:/fora/lib.d.ts:900:2'
  )
})

test('"olhei e não há nada aqui" nomeia a base 1-based como receita', async () => {
  const { tools } = makeToolkit({
    definition: { ok: true, value: [] },
    hover: { ok: true, value: null }
  })
  const semDefinicao = await tools.definition(IDENTITY, 'src/a.ts', 12, 5)
  assert.match(semDefinicao, /nenhuma definição para src\/a\.ts:12:5/u)
  assert.match(semDefinicao, /1-based/u)
  const semHover = await tools.hover(IDENTITY, 'src/a.ts', 12, 5)
  assert.match(semHover, /nada a dizer sobre src\/a\.ts:12:5/u)
  assert.match(semHover, /1-based/u)
})

test('hover devolve a posição do servidor e o texto achatado', async () => {
  const { tools } = makeToolkit({
    hover: {
      ok: true,
      value: {
        file: 'src/a.ts',
        line: 12,
        column: 3,
        endLine: 12,
        endColumn: 9,
        text: 'const foo: string'
      }
    }
  })
  assert.equal(
    await tools.hover(IDENTITY, 'src/a.ts', 12, 5),
    'src/a.ts:12:3 — const foo: string'
  )
})

test('LspAnswer ok:false viaja VERBATIM: a receita do motor não é reescrita aqui', async () => {
  const reason =
    '"src/outro.ts" não existe em C:\\wt\\missao-01 — confira o caminho relativo à raiz e chame de novo'
  const { tools } = makeToolkit({
    definition: { ok: false, reason },
    references: { ok: false, reason },
    hover: { ok: false, reason }
  })
  assert.equal(await tools.definition(IDENTITY, 'src/outro.ts', 1, 1), reason)
  assert.equal(await tools.references(IDENTITY, 'src/outro.ts', 1, 1), reason)
  assert.equal(await tools.hover(IDENTITY, 'src/outro.ts', 1, 1), reason)
})

test('LspError (fora da raiz, pacote ausente, servidor morto) viaja VERBATIM', async () => {
  const message =
    'o servidor de linguagem "typescript-language-server" não está instalado — rode `npm install` na pasta do Synkora e reabra o chat'
  const { tools } = makeToolkit({ sessionError: new LspError(message) })
  assert.equal(await tools.diagnostics(IDENTITY, ['src/a.ts']), message)
  assert.equal(await tools.definition(IDENTITY, 'src/a.ts', 1, 1), message)
})

test('erro que NÃO é do motor vira texto com receita — nunca -32603 mudo', async () => {
  const { tools } = makeToolkit({ sessionError: new Error('EPERM: acesso negado') })
  const receipt = await tools.hover(IDENTITY, 'src/a.ts', 1, 1)
  assert.match(receipt, /EPERM: acesso negado/u)
  assert.match(receipt, /chame de novo/u)
})

test('conversa sem pasta de trabalho: recusa com receita, e ninguém sobe servidor', async () => {
  const { tools, calls } = makeToolkit({})
  const receipt = await tools.diagnostics({ ...IDENTITY, cwd: '  ' }, ['src/a.ts'])
  assert.match(receipt, /não tem uma pasta de trabalho registrada/u)
  assert.match(receipt, /reabra o chat da missão/u)
  assert.deepEqual(calls.roots, [])
})

test('CAIXA-PRETA: todo evento carrega paneId E a RAIZ (o motor não loga de propósito)', async () => {
  const { tools, logs } = makeToolkit({
    diagnostics: [{ file: 'src/a.ts', line: 1, column: 1, severity: 'error', message: 'x' }],
    hover: { ok: true, value: null }
  })
  await tools.diagnostics(IDENTITY, ['src/a.ts'])
  await tools.hover(IDENTITY, 'src/a.ts', 2, 3)

  assert.deepEqual(
    logs.map((entry) => entry.event),
    ['lsp-diagnostics', 'lsp-hover']
  )
  for (const entry of logs) {
    assert.equal(entry.paneId, 'gui-dev-abcd1234')
    assert.equal(entry.projectId, 'universo-1')
    assert.equal(entry.missionId, 'missao-1')
    // Sem a RAIZ, um journal de missão já integrada não explica nada.
    assert.equal(entry.root, ROOT)
  }
  assert.equal(logs[0].detail.problems, 1)
  assert.equal(logs[0].detail.files, 1)
  assert.deepEqual(logs[1].detail, { file: 'src/a.ts', line: 2, column: 3 })
})

test('CAIXA-PRETA: a recusa também entra no diário, com o motivo', async () => {
  const { tools, logs } = makeToolkit({ sessionError: new LspError('servidor ausente — receita') })
  await tools.diagnostics(IDENTITY, ['src/a.ts'])
  assert.equal(logs.length, 1)
  assert.equal(logs[0].err, 'servidor ausente — receita')
})

test('observador quebrado NUNCA derruba a chamada real', async () => {
  const tools = buildGuiLspTools({
    manager: { sessionFor: async () => ({ diagnostics: async () => [] }) },
    log: () => {
      throw new Error('diário quebrado')
    }
  })
  assert.match(await tools.diagnostics(IDENTITY, ['src/a.ts']), /nenhum problema/u)
})

// ————— B. o catálogo por papel —————

function hubIn(t) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-lsp-tools-'))
  const hub = new Hub({
    projectPathOf: () => root,
    ensureProjectRuntimeWritable: () => {},
    onEvent: () => {}
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { hub, root }
}

async function serverIn(t, hub, { lsp = true } = {}) {
  const served = []
  const calls = []
  const kit = lsp
    ? {
        lsp: {
          diagnostics: async (id, files) => {
            calls.push({ tool: 'lsp_diagnostics', paneId: id.paneId, cwd: id.cwd, files })
            return 'nenhum problema'
          },
          definition: async (id, file, line, column) => {
            calls.push({ tool: 'lsp_definition', paneId: id.paneId, file, line, column })
            return 'src/b.ts:3:14'
          },
          references: async (id, file, line, column) => {
            calls.push({ tool: 'lsp_references', paneId: id.paneId, file, line, column })
            return 'src/a.ts:1:1'
          },
          hover: async (id, file, line, column) => {
            calls.push({ tool: 'lsp_hover', paneId: id.paneId, file, line, column })
            return 'const foo: string'
          }
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
    delegateHelpers: async () => 'abri ajudantes',
    listSeats: async () => 'contas',
    helpersStatus: () => 'nenhum vivo',
    helperResult: async () => 'entrega',
    helperSend: () => 'entregue',
    helperCancel: () => 'descartado',
    helperResume: () => 'retomado',
    integrationStatus: () => 'fila',
    integrationRun: async () => 'INTEGRADA',
    releaseStatus: () => 'release',
    releaseRun: async () => 'SUBIU',
    noteCatalogServed: (id, tools) => served.push({ role: id.role, paneId: id.paneId, tools }),
    ...kit
  })
  t.after(() => handle.close())
  return { url: new URL(`http://127.0.0.1:${handle.port}/mcp`), served, calls }
}

function register(hub, token, identity) {
  hub.registerPane(token, identity)
  return token
}

async function clientFor(t, url, token, label) {
  const client = new Client({ name: `synkora-${label}`, version: '1.0.0' }, { cachePartition: label })
  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: { token: async () => token }
  })
  await client.connect(transport)
  t.after(() => client.close())
  return client
}

async function toolNames(url, token, label) {
  const client = new Client({ name: `synkora-${label}`, version: '1.0.0' }, { cachePartition: label })
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

test('o AJUDANTE recebe o kit de código E SÓ ELE — frota não abre frota, mecanicamente', async (t) => {
  const { hub, root } = hubIn(t)
  const { url, served } = await serverIn(t, hub)
  register(hub, 'token-ajudante', {
    paneId: 'gui-helper-abcd1234-2',
    projectId: 'universo-1',
    role: 'ajudante',
    cwd: root,
    missionId: 'missao-1',
    delegatorPaneId: 'gui-dev-abcd1234'
  })

  const tools = await toolNames(url, 'token-ajudante', 'ajudante')
  assert.deepEqual(tools, LSP_TOOLS)
  for (const forbidden of [...DELEGATOR_TOOLS, ...INTEGRATION_TOOLS, ...RELEASE_TOOLS, ...PLANNER_TOOLS]) {
    assert.equal(tools.includes(forbidden), false, `o ajudante enxergou ${forbidden}`)
  }
  const receipt = served.find((entry) => entry.paneId === 'gui-helper-abcd1234-2')
  assert.equal(receipt?.role, 'ajudante')
  assert.deepEqual([...receipt.tools].sort(), LSP_TOOLS)
})

test('os TRÊS chats ganham o kit de código sem perder o que já tinham', async (t) => {
  const { hub, root } = hubIn(t)
  const { url } = await serverIn(t, hub)
  register(hub, 'token-planner', {
    paneId: 'gui-dev-11111111',
    projectId: 'universo-1',
    role: 'gui-planner',
    cwd: root
  })
  register(hub, 'token-dev', {
    paneId: 'gui-dev-22222222',
    projectId: 'universo-1',
    role: 'gui-delegator',
    cwd: root,
    missionId: 'missao-2'
  })
  register(hub, 'token-reviewer', {
    paneId: 'gui-reviewer-22222222',
    projectId: 'universo-1',
    role: 'gui-delegator',
    cwd: root,
    missionId: 'missao-2'
  })
  register(hub, 'token-release', {
    paneId: 'gui-dev-33333333',
    projectId: 'universo-1',
    role: 'gui-release',
    cwd: root,
    missionId: 'missao-3'
  })

  assert.deepEqual(
    await toolNames(url, 'token-planner', 'kit-planner'),
    sorted(PLANNER_TOOLS, LSP_TOOLS)
  )
  assert.deepEqual(
    await toolNames(url, 'token-dev', 'kit-dev'),
    sorted(DELEGATOR_TOOLS, INTEGRATION_TOOLS, LSP_TOOLS)
  )
  // A cerca do integrador (R9) continua sendo o PAPEL DO ENDEREÇO: o kit de
  // código não pode ter carregado nada mais junto.
  assert.deepEqual(
    await toolNames(url, 'token-reviewer', 'kit-rev'),
    sorted(DELEGATOR_TOOLS, LSP_TOOLS)
  )
  assert.deepEqual(
    await toolNames(url, 'token-release', 'kit-release'),
    sorted(RELEASE_TOOLS, LSP_TOOLS)
  )
})

test('os papéis mortos da era F6 continuam com catálogo VAZIO — o ajudante é a ÚNICA faixa nova', async (t) => {
  const { hub, root } = hubIn(t)
  const { url } = await serverIn(t, hub)
  for (const role of ['maestro', 'dev', 'review', 'qa', 'livre']) {
    register(hub, `token-${role}`, {
      paneId: `pane-${role}`,
      projectId: 'universo-1',
      role,
      cwd: root
    })
    assert.deepEqual(
      await toolNames(url, `token-${role}`, `role-${role}`),
      [],
      `a identidade ${role} não pode enxergar ferramenta nenhuma`
    )
  }
})

test('as quatro tools chegam ao kit com a identidade DESTE pane (a raiz vem do token)', async (t) => {
  const { hub, root } = hubIn(t)
  const { url, calls } = await serverIn(t, hub)
  register(hub, 'token-ajudante', {
    paneId: 'gui-helper-abcd1234-2',
    projectId: 'universo-1',
    role: 'ajudante',
    cwd: root
  })
  const client = await clientFor(t, url, 'token-ajudante', 'chamadas')

  assert.equal(textOf(await client.callTool({ name: 'lsp_diagnostics', arguments: {} })), 'nenhum problema')
  assert.equal(
    textOf(
      await client.callTool({
        name: 'lsp_diagnostics',
        arguments: { files: ['src/a.ts', 'src/b.ts'] }
      })
    ),
    'nenhum problema'
  )
  assert.equal(
    textOf(
      await client.callTool({
        name: 'lsp_definition',
        arguments: { file: 'src/a.ts', line: 12, column: 5 }
      })
    ),
    'src/b.ts:3:14'
  )
  assert.equal(
    textOf(
      await client.callTool({
        name: 'lsp_references',
        arguments: { file: 'src/a.ts', line: 12, column: 5 }
      })
    ),
    'src/a.ts:1:1'
  )
  assert.equal(
    textOf(
      await client.callTool({
        name: 'lsp_hover',
        arguments: { file: 'src/a.ts', line: 12, column: 5 }
      })
    ),
    'const foo: string'
  )

  assert.deepEqual(calls, [
    { tool: 'lsp_diagnostics', paneId: 'gui-helper-abcd1234-2', cwd: root, files: undefined },
    {
      tool: 'lsp_diagnostics',
      paneId: 'gui-helper-abcd1234-2',
      cwd: root,
      files: ['src/a.ts', 'src/b.ts']
    },
    { tool: 'lsp_definition', paneId: 'gui-helper-abcd1234-2', file: 'src/a.ts', line: 12, column: 5 },
    { tool: 'lsp_references', paneId: 'gui-helper-abcd1234-2', file: 'src/a.ts', line: 12, column: 5 },
    { tool: 'lsp_hover', paneId: 'gui-helper-abcd1234-2', file: 'src/a.ts', line: 12, column: 5 }
  ])
})

test('o schema grampeia a base 1-based na PORTA: linha/coluna 0 nem chega ao motor', async (t) => {
  const { hub, root } = hubIn(t)
  const { url, calls } = await serverIn(t, hub)
  register(hub, 'token-ajudante', {
    paneId: 'gui-helper-abcd1234-2',
    projectId: 'universo-1',
    role: 'ajudante',
    cwd: root
  })
  const client = await clientFor(t, url, 'token-ajudante', 'base')

  for (const args of [
    { file: 'src/a.ts', line: 0, column: 1 },
    { file: 'src/a.ts', line: 1, column: 0 },
    { file: 'src/a.ts', line: 1.5, column: 1 }
  ]) {
    const result = await client.callTool({ name: 'lsp_definition', arguments: args })
    assert.equal(result.isError, true, `posição inválida passou: ${JSON.stringify(args)}`)
    assert.match(textOf(result), /Input validation error/u)
  }
  assert.deepEqual(calls, [], 'nenhuma posição inválida podia ter chegado ao motor')
})

test('sem o kit ligado as quatro tools CONTINUAM no catálogo e recusam com a receita', async (t) => {
  const { hub, root } = hubIn(t)
  const { url } = await serverIn(t, hub, { lsp: false })
  register(hub, 'token-ajudante', {
    paneId: 'gui-helper-abcd1234-2',
    projectId: 'universo-1',
    role: 'ajudante',
    cwd: root
  })
  const client = await clientFor(t, url, 'token-ajudante', 'motor-desligado')

  // Tool que SOME do catálogo entre um boot e outro é o pior desfecho: o agente
  // racionaliza a ausência em vez de ler o motivo.
  assert.deepEqual(await toolNames(url, 'token-ajudante', 'lista-desligada'), LSP_TOOLS)
  for (const [name, args] of [
    ['lsp_diagnostics', {}],
    ['lsp_definition', { file: 'src/a.ts', line: 1, column: 1 }],
    ['lsp_references', { file: 'src/a.ts', line: 1, column: 1 }],
    ['lsp_hover', { file: 'src/a.ts', line: 1, column: 1 }]
  ]) {
    const result = await client.callTool({ name, arguments: args })
    assert.notEqual(result.isError, true, `${name} devia responder texto, nunca erro de protocolo`)
    assert.match(textOf(result), /motor de linguagem ainda não está ligado/u)
    assert.match(textOf(result), /não conclua que o código está limpo/u)
  }
})

test('as descrições ENSINAM a base, o confinamento e os tetos reais', async (t) => {
  const { hub, root } = hubIn(t)
  const { url } = await serverIn(t, hub)
  register(hub, 'token-ajudante', {
    paneId: 'gui-helper-abcd1234-2',
    projectId: 'universo-1',
    role: 'ajudante',
    cwd: root
  })
  const client = await clientFor(t, url, 'token-ajudante', 'descricoes')
  const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]))

  assert.deepEqual([...tools.keys()].sort(), LSP_TOOLS)
  // Descrição que mente sobre o próprio limite é pior que descrição ausente: os
  // números saem do módulo que os APLICA.
  const diagnostics = tools.get('lsp_diagnostics')
  assert.match(diagnostics.description, /1-BASED/u)
  assert.ok(diagnostics.description.includes(String(LSP_DIAGNOSTICS_ITEM_CAP)))
  assert.ok(diagnostics.description.includes(String(LSP_DIAGNOSTICS_FILES_MAX)))
  assert.ok(diagnostics.description.includes(lspExtensionsLabel()))
  assert.match(diagnostics.inputSchema.properties.files.description, /relativos à raiz/u)

  for (const name of ['lsp_definition', 'lsp_references', 'lsp_hover']) {
    const schema = tools.get(name).inputSchema.properties
    assert.match(schema.file.description, /RELATIVO à raiz/u)
    assert.match(schema.line.description, /1-BASED/u)
    assert.match(schema.column.description, /1-BASED/u)
  }
})

test('a lista de nomes exportada é a MESMA que o servidor registra', () => {
  // A pré-sanção do claude (`GUI_DELEGATE_CLAUDE_ALLOWED_TOOLS`) deriva daqui:
  // uma lista que divergisse do catálogo devolveria card de permissão ao dono.
  assert.deepEqual([...LSP_TOOL_NAMES].sort(), LSP_TOOLS)
})
