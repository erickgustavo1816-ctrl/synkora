#!/usr/bin/env node
/**
 * O MOTOR LSP DA ERA 2.0, PRESO NO PROTOCOLO DE VERDADE (R14 — L1).
 *
 * O que esta suíte protege, e por que cada peça está aqui:
 *
 * - **Framing.** O cano é de BYTES: `Content-Length` conta bytes (não
 *   caracteres), o chunk pode trazer meio cabeçalho ou três quadros grudados, e
 *   o servidor pode cuspir lixo. Os testes de `LspRpc` escrevem os quadros na
 *   mão, em pedaços escolhidos — inclusive cortando NO MEIO de um caractere
 *   UTF-8 — porque é exatamente assim que o cano se comporta em produção.
 * - **A borda 1-based.** O protocolo conta de ZERO e a API do motor conta de
 *   UM. O dublê responde com ARITMÉTICA sobre a posição que recebeu (ver o
 *   roteiro em `fake-lsp-server.mjs`), então cada asserção fixa NÚMEROS
 *   EXATOS: um `+1` a menos em qualquer sentido quebra a suíte na hora.
 * - **A janela de assentamento.** O dublê publica em rajadas como o tsserver
 *   (a primeira vazia, a real depois). Sem espera, `diagnostics` devolveria a
 *   rajada VAZIA — que é o pior resultado possível: "nenhum problema" mentiroso.
 * - **As recusas.** Caminho fora da raiz, arquivo que não existe, servidor que
 *   morre no meio: cada mensagem tem que nomear a RECEITA. Beco sem saída é bug.
 * - **O gerente.** Cache por raiz, ociosidade (relógio INJETADO — o teste não
 *   espera cinco minutos), invalidate, disposeAll, e a sessão morta que sai do
 *   cache para a próxima chamada subir um servidor novo.
 * - **O lançador de produção.** `tsServerLaunch` é provado com a resolução
 *   MASCARADA: a suíte não pode depender de `typescript-language-server`
 *   instalado (é dependência de runtime, e o gate roda antes do npm install).
 *
 * Nada aqui é mock: o dublê é um processo node de verdade falando LSP de
 * verdade por stdio de verdade.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { LspRpc, LspError } from '../.tmp/lsp-engine-test/lspRpc.js'
import { LspSession } from '../.tmp/lsp-engine-test/lspSession.js'
import { LspManager, tsServerLaunch } from '../.tmp/lsp-engine-test/lspManager.js'

const FAKE = fileURLToPath(new URL('./fake-lsp-server.mjs', import.meta.url))

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** O arquivo do roteiro: as marcas `@@` viram diagnóstico com posição EXATA.
 *  Índices 0-based das linhas: 2 = a marca de erro, 4 = a marca de aviso. */
const FIXTURE = [
  '// o arquivo da missão',
  'const alpha = 1',
  '  @@E2304:nome nao encontrado',
  'const beta = 2',
  '   @@W:cuidado com a ação',
  ''
].join('\n')

/** Uma raiz de missão com o fixture dentro, mais o desmonte na ordem certa:
 *  processos morrem ANTES da pasta sumir (no Windows, processo com cwd na
 *  pasta segura a exclusão). A falha de remoção é engolida de propósito —
 *  pasta temporária presa não é motivo para reprovar o motor. */
function labIn(t) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-lsp-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), FIXTURE, 'utf-8')
  writeFileSync(join(root, 'src', 'limpo.ts'), 'export const ok = 1\n', 'utf-8')
  const sessions = []
  const managers = []
  const logs = []
  t.after(async () => {
    for (const manager of managers) manager.disposeAll()
    for (const session of sessions) session.dispose()
    await delay(120)
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      /* pasta temporária presa no Windows não reprova o motor */
    }
  })
  const logFile = () => {
    const file = join(tmpdir(), `synkora-lsp-log-${logs.length}-${process.pid}.jsonl`)
    logs.push(file)
    t.after(() => {
      try {
        rmSync(file, { force: true })
      } catch {
        /* idem */
      }
    })
    return file
  }
  const launch = (extra = []) => ({ command: process.execPath, args: [FAKE, ...extra] })
  const session = (extra = [], opts = {}) => {
    const live = new LspSession({
      root,
      launch: launch(extra),
      settleMs: 120,
      ceilingMs: 3000,
      requestTimeoutMs: 5000,
      ...opts
    })
    sessions.push(live)
    return live
  }
  const manager = (opts = {}) => {
    const live = new LspManager({ launcherFor: () => launch(opts.extra ?? []), ...opts })
    managers.push(live)
    return live
  }
  return { root, logFile, launch, session, manager }
}

function readLog(file) {
  try {
    return readFileSync(file, 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

// ————— 1. o cano: framing de bytes, não de mensagens —————

/** Um `LspRpc` ligado a canos de mentira: o teste ESCREVE os quadros na mão,
 *  nos pedaços que quiser. É a única forma de provar quadro partido. */
function rpcIn(t, opts = {}) {
  const fromServer = new PassThrough()
  const written = []
  const problems = []
  const rpc = new LspRpc({
    streams: { stdin: { write: (chunk) => written.push(chunk) }, stdout: fromServer },
    requestTimeoutMs: 300,
    onProtocolError: (message) => problems.push(message),
    ...opts
  })
  t.after(() => rpc.dispose())
  return { rpc, fromServer, written, problems }
}

function frameOf(message) {
  const body = JSON.stringify(message)
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n${body}`, 'utf-8')
}

test('o quadro que sai leva Content-Length em BYTES, não em caracteres', (t) => {
  const { rpc, written } = rpcIn(t)
  void rpc.request('textDocument/hover', { texto: 'ação e coração' }).catch(() => undefined)
  const [frame] = written
  const [header, body] = frame.split('\r\n\r\n')
  const declared = Number(/content-length:\s*(\d+)/i.exec(header)[1])
  assert.equal(declared, Buffer.byteLength(body, 'utf-8'))
  assert.notEqual(declared, body.length, 'com acento, byte e caractere DIVERGEM — é o ponto do teste')
  assert.equal(JSON.parse(body).method, 'textDocument/hover')
})

test('quadro partido em três pedaços — inclusive NO MEIO de um caractere UTF-8', async (t) => {
  const { rpc, fromServer } = rpcIn(t)
  const pending = rpc.request('textDocument/hover')
  const frame = frameOf({ jsonrpc: '2.0', id: 1, result: { texto: 'ação' } })
  // O 'ç' ocupa dois bytes: o corte cai entre eles.
  const cut = frame.indexOf(Buffer.from('ç', 'utf-8')) + 1
  assert.ok(cut > 0, 'o fixture precisa ter um caractere multibyte para o corte valer')
  fromServer.write(frame.subarray(0, 12))
  await delay(5)
  fromServer.write(frame.subarray(12, cut))
  await delay(5)
  fromServer.write(frame.subarray(cut))
  assert.deepEqual(await pending, { texto: 'ação' })
})

test('dois quadros GRUDADOS num write só chegam como dois', async (t) => {
  const { rpc, fromServer } = rpcIn(t)
  const first = rpc.request('um')
  const second = rpc.request('dois')
  fromServer.write(
    Buffer.concat([
      frameOf({ jsonrpc: '2.0', id: 1, result: 'a' }),
      frameOf({ jsonrpc: '2.0', id: 2, result: 'b' })
    ])
  )
  assert.deepEqual(await Promise.all([first, second]), ['a', 'b'])
})

test('cabeçalho é case-insensitive e Content-Type extra não atrapalha', async (t) => {
  const { rpc, fromServer } = rpcIn(t)
  const pending = rpc.request('um')
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' })
  fromServer.write(
    `content-length: ${Buffer.byteLength(body, 'utf-8')}\r\ncontent-type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n${body}`
  )
  assert.equal(await pending, 'ok')
})

test('lixo no cano vira AVISO e o parser re-sincroniza no quadro seguinte', async (t) => {
  const { rpc, fromServer, problems } = rpcIn(t)
  const pending = rpc.request('um')
  fromServer.write('ruído inicial do servidor\r\nlixo: sim\r\n\r\n')
  fromServer.write(frameOf({ jsonrpc: '2.0', id: 1, result: 'sobrevivi' }))
  assert.equal(await pending, 'sobrevivi')
  assert.ok(
    problems.some((message) => /Content-Length/.test(message)),
    `o lixo tinha que virar aviso; vieram: ${JSON.stringify(problems)}`
  )
})

test('pedido sem resposta estoura o teto NOMEANDO a receita', async (t) => {
  const { rpc } = rpcIn(t)
  await assert.rejects(rpc.request('textDocument/hover'), (e) => {
    assert.equal(e.name, 'LspError')
    assert.match(e.message, /não respondeu "textDocument\/hover" em 300ms/)
    assert.match(e.message, /chame de novo, ou aponte um arquivo menor/)
    return true
  })
})

test('dispose derruba o pedido em voo com o motivo em voz alta', async (t) => {
  const { rpc } = rpcIn(t)
  const pending = rpc.request('textDocument/hover')
  rpc.dispose('o worktree sumiu')
  await assert.rejects(pending, (e) => {
    assert.match(e.message, /o worktree sumiu/)
    assert.match(e.message, /textDocument\/hover/)
    return true
  })
})

test('pedido DO SERVIDOR sempre recebe resposta — mudo travaria a sessão', async (t) => {
  const { rpc, fromServer, written } = rpcIn(t)
  fromServer.write(frameOf({ jsonrpc: '2.0', id: 7, method: 'workspace/configuration', params: {} }))
  await delay(10)
  const semHandler = JSON.parse(written.at(-1).split('\r\n\r\n')[1])
  assert.equal(semHandler.id, 7)
  assert.equal(semHandler.error.code, -32601)

  rpc.onRequest('workspace/configuration', (params) => params.items.map(() => null))
  fromServer.write(
    frameOf({ jsonrpc: '2.0', id: 8, method: 'workspace/configuration', params: { items: [{}, {}] } })
  )
  await delay(10)
  const comHandler = JSON.parse(written.at(-1).split('\r\n\r\n')[1])
  assert.deepEqual(comHandler.result, [null, null])
})

test('notificação chega aos ouvintes e o cancelador desliga', async (t) => {
  const { rpc, fromServer } = rpcIn(t)
  const heard = []
  const off = rpc.onNotification('textDocument/publishDiagnostics', (params) => heard.push(params))
  fromServer.write(frameOf({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'a' } }))
  await delay(10)
  off()
  fromServer.write(frameOf({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'b' } }))
  await delay(10)
  assert.deepEqual(heard, [{ uri: 'a' }])
})

// ————— 2. o handshake: ordem, e ordem provada pelo TEMPO —————

test('o initialized só sai DEPOIS da resposta do initialize', async (t) => {
  const lab = labIn(t)
  const log = lab.logFile()
  // initialize demora 200ms de propósito: se o motor não esperasse, o
  // `initialized` chegaria antes — e o intervalo no diário denunciaria.
  const session = lab.session(['--log', log, '--slow', 'initialize=200'])
  await session.ready()
  await session.hover('src/a.ts', 2, 7)
  const entries = readLog(log).filter((entry) => entry.method)
  const order = entries.map((entry) => entry.method)
  assert.deepEqual(order.slice(0, 3), ['initialize', 'initialized', 'textDocument/didOpen'])
  const gap = entries[1].at - entries[0].at
  assert.ok(gap >= 150, `o initialized saiu ${gap}ms depois do initialize — não esperou a resposta`)
  assert.ok(
    order.indexOf('textDocument/didOpen') > order.indexOf('initialized'),
    'nenhum documento pode abrir antes do handshake fechar'
  )
})

test('as initializationOptions do lançador viajam no handshake', async (t) => {
  const lab = labIn(t)
  const log = lab.logFile()
  const session = new LspSession({
    root: lab.root,
    launch: {
      ...lab.launch(['--log', log]),
      initializationOptions: { tsserver: { path: 'C:/ws/node_modules/typescript/lib/tsserver.js' } }
    },
    settleMs: 60
  })
  t.after(() => session.dispose())
  await session.ready()
  const anotado = readLog(log).find((entry) => entry.event === 'initializationOptions')
  assert.deepEqual(anotado.value, {
    tsserver: { path: 'C:/ws/node_modules/typescript/lib/tsserver.js' }
  })
})

test('o motor responde aos pedidos do servidor durante o handshake', async (t) => {
  const lab = labIn(t)
  const log = lab.logFile()
  const session = lab.session(['--log', log, '--probe-request'])
  await session.ready()
  await delay(120)
  const resposta = readLog(log).find((entry) => entry.event === 'resposta-do-cliente')
  assert.ok(resposta, 'o servidor perguntou e ficou sem resposta — sessão travada')
})

// ————— 3. diagnóstico: a poeira baixa antes de responder —————

test('diagnostics espera a poeira baixar e devolve linha/coluna 1-BASED', async (t) => {
  const lab = labIn(t)
  const session = lab.session(['--bursts', '2', '--burst-gap', '60'], { settleMs: 150 })
  const comecou = Date.now()
  const found = await session.diagnostics(['src/a.ts'])
  const levou = Date.now() - comecou
  assert.ok(levou >= 150, `voltou em ${levou}ms: não esperou a janela e pegaria a rajada VAZIA`)
  assert.deepEqual(found, [
    {
      file: 'src/a.ts',
      // a marca está na 3ª linha do arquivo (índice 2 no fio) e na 3ª coluna
      // (índice 2 no fio): os dois +1 da borda estão presos aqui.
      line: 3,
      column: 3,
      severity: 'error',
      code: '2304',
      message: 'nome nao encontrado'
    },
    {
      file: 'src/a.ts',
      line: 5,
      column: 4,
      severity: 'warning',
      message: 'cuidado com a ação'
    }
  ])
})

test('arquivo sem problema nenhum devolve lista VAZIA (e não uma espera eterna)', async (t) => {
  const lab = labIn(t)
  const session = lab.session([], { settleMs: 80 })
  assert.deepEqual(await session.diagnostics(['src/limpo.ts']), [])
  assert.deepEqual(await session.diagnostics([]), [], 'lista vazia nem chega a falar com o servidor')
})

test('servidor que NUNCA cala é cortado pelo teto duro, com o que já publicou', async (t) => {
  const lab = labIn(t)
  const session = lab.session(['--never-settle', '--burst-gap', '15'], {
    settleMs: 400,
    ceilingMs: 350
  })
  const comecou = Date.now()
  const found = await session.diagnostics(['src/a.ts'])
  const levou = Date.now() - comecou
  assert.ok(levou < 2000, `o teto duro não cortou: ${levou}ms`)
  assert.equal(found.length, 2, 'o teto entrega o que já publicou, não uma lista vazia')
  assert.equal(found[0].line, 3)
})

test('re-chamar RELÊ o disco: o motor não guarda cópia velha do arquivo', async (t) => {
  const lab = labIn(t)
  const session = lab.session([], { settleMs: 100 })
  assert.equal((await session.diagnostics(['src/a.ts'])).length, 2)
  writeFileSync(join(lab.root, 'src', 'a.ts'), 'const so = 1\n@@E9:sozinho\n', 'utf-8')
  const found = await session.diagnostics(['src/a.ts'])
  assert.deepEqual(found, [
    { file: 'src/a.ts', line: 2, column: 1, severity: 'error', code: '9', message: 'sozinho' }
  ])
})

// ————— 4. as recusas: cada uma nomeia a receita —————

test('caminho fora da raiz é RECUSA que nomeia a raiz que vale', async (t) => {
  const lab = labIn(t)
  const session = lab.session()
  for (const fora of ['../vizinho/x.ts', join(dirname(lab.root), 'vizinho.ts'), '..']) {
    await assert.rejects(session.diagnostics([fora]), (e) => {
      assert.equal(e.name, 'LspError')
      assert.match(e.message, /está fora da raiz desta sessão/)
      assert.ok(e.message.includes(lab.root), `a recusa tem que dizer qual raiz vale: ${e.message}`)
      return true
    })
  }
  await assert.rejects(session.hover('../vizinho/x.ts', 2, 2), (e) =>
    e.message.includes(lab.root)
  )
})

test('arquivo inexistente é RESPOSTA (com receita), nunca exceção', async (t) => {
  const lab = labIn(t)
  const session = lab.session([], { settleMs: 80 })
  const found = await session.diagnostics(['src/fantasma.ts', 'src/a.ts'])
  const fantasma = found.find((entry) => entry.file === 'src/fantasma.ts')
  assert.equal(fantasma.line, 1)
  assert.equal(fantasma.column, 1)
  assert.equal(fantasma.severity, 'error')
  assert.match(fantasma.message, /não existe em/)
  assert.match(fantasma.message, /confira o caminho relativo à raiz/)
  assert.equal(found.length, 3, 'o arquivo que existe continua sendo analisado')

  const answer = await session.definition('src/fantasma.ts', 2, 2)
  assert.equal(answer.ok, false)
  assert.match(answer.reason, /não existe em/)
  const hover = await session.hover('src/fantasma.ts', 2, 2)
  assert.equal(hover.ok, false)
})

test('posição 0 é recusada nomeando a base 1-based', async (t) => {
  const lab = labIn(t)
  const session = lab.session()
  await assert.rejects(session.definition('src/a.ts', 0, 3), (e) => {
    assert.match(e.message, /1-based/)
    assert.match(e.message, /primeira linha é 1/)
    return true
  })
})

test('servidor que morre NO MEIO da chamada responde com a receita', async (t) => {
  const lab = labIn(t)
  const session = lab.session(['--die-on', 'textDocument/didOpen'], { ceilingMs: 4000 })
  await assert.rejects(session.diagnostics(['src/a.ts']), (e) => {
    assert.equal(e.name, 'LspError')
    assert.match(e.message, /encerrou \(código 9/)
    assert.match(e.message, /a próxima chamada sobe um servidor novo/)
    return true
  })
  assert.equal(session.alive, false)
})

test('lançador que não existe vira frase com receita, não exceção solta', async (t) => {
  const lab = labIn(t)
  const session = new LspSession({
    root: lab.root,
    launch: { command: join(lab.root, 'binario-que-nunca-existiu.exe'), args: [] }
  })
  t.after(() => session.dispose())
  await assert.rejects(session.ready(), (e) => {
    assert.match(e.message, /não foi possível executar/)
    assert.match(e.message, /a próxima chamada sobe um servidor novo/)
    return true
  })
})

// ————— 5. consultas pontuais: os DOIS sentidos da conversão —————

test('definition/references/hover convertem 1-based nos dois sentidos', async (t) => {
  const lab = labIn(t)
  const session = lab.session()

  // pedido em (5,7) → fio (4,6) → o dublê responde [linha+2, caractere+3]
  const definicao = await session.definition('src/a.ts', 5, 7)
  assert.deepEqual(definicao, {
    ok: true,
    value: [{ file: 'src/a.ts', line: 7, column: 10, endLine: 7, endColumn: 15 }]
  })

  const referencias = await session.references('src/a.ts', 5, 7)
  assert.deepEqual(referencias.value, [
    { file: 'src/a.ts', line: 5, column: 7, endLine: 5, endColumn: 11 },
    { file: 'src/a.ts', line: 15, column: 8, endLine: 15, endColumn: 12 }
  ])

  const hover = await session.hover('src/a.ts', 5, 7)
  assert.equal(
    hover.value.text,
    'sym@4:6',
    'o dublê ecoa a posição do FIO: 1-based virou 0-based na saída do motor'
  )
  assert.deepEqual(
    { line: hover.value.line, column: hover.value.column, file: hover.value.file },
    { line: 5, column: 7, file: 'src/a.ts' }
  )
})

test('"não há nada aqui" é ok:true com vazio — não é erro', async (t) => {
  const lab = labIn(t)
  const session = lab.session()
  assert.deepEqual(await session.definition('src/a.ts', 1, 3), { ok: true, value: [] })
  assert.deepEqual(await session.references('src/a.ts', 1, 3), { ok: true, value: [] })
  assert.deepEqual(await session.hover('src/a.ts', 1, 3), { ok: true, value: null })
})

test('definição FORA da raiz volta com caminho absoluto — mentir a raiz seria pior', async (t) => {
  const lab = labIn(t)
  const session = lab.session()
  const answer = await session.definition('src/a.ts', 5, 1)
  assert.equal(answer.ok, true)
  assert.match(answer.value[0].file, /fora-da-raiz\/lib\.d\.ts$/)
  assert.equal(answer.value[0].line, 2)
})

test('resposta lenta estoura o teto por pedido com a receita', async (t) => {
  const lab = labIn(t)
  const session = lab.session(['--slow', 'textDocument/hover=600'], { requestTimeoutMs: 150 })
  await assert.rejects(session.hover('src/a.ts', 5, 7), (e) => {
    assert.match(e.message, /não respondeu "textDocument\/hover" em 150ms/)
    return true
  })
})

test('framing de verdade sobrevive a quadro partido E a quadros colados', async (t) => {
  const lab = labIn(t)
  const partido = lab.session(['--split-writes'], { settleMs: 100 })
  assert.equal((await partido.diagnostics(['src/a.ts'])).length, 2)
  const colado = lab.session(['--join-writes'], { settleMs: 100 })
  assert.equal((await colado.diagnostics(['src/a.ts'])).length, 2)
  const sujo = lab.session(['--garbage'], { settleMs: 100 })
  assert.equal((await sujo.diagnostics(['src/a.ts'])).length, 2)
})

// ————— 6. o gerente: cache, ociosidade, invalidate, disposeAll —————

/** Relógio de mentira: o teste da ociosidade não espera cinco minutos. */
function fakeClock() {
  let now = 0
  let pending = null
  return {
    now: () => now,
    schedule: (fn, ms) => {
      pending = { fn, at: now + ms }
      return () => {
        pending = null
      }
    },
    advance: (ms) => {
      now += ms
      if (pending && pending.at <= now) {
        const due = pending
        pending = null
        due.fn()
      }
    },
    armed: () => pending !== null
  }
}

test('a mesma raiz reusa a sessão; raízes diferentes não se misturam', async (t) => {
  const lab = labIn(t)
  const manager = lab.manager()
  const primeira = await manager.sessionFor(lab.root)
  const segunda = await manager.sessionFor(lab.root)
  assert.equal(primeira, segunda, 'duas chamadas na mesma raiz não podem subir dois servidores')
  assert.deepEqual(manager.openRoots().length, 1)

  const outra = mkdtempSync(join(tmpdir(), 'synkora-lsp-outra-'))
  t.after(() => {
    try {
      rmSync(outra, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      /* idem */
    }
  })
  const terceira = await manager.sessionFor(outra)
  assert.notEqual(terceira, primeira)
  assert.equal(manager.openRoots().length, 2)
})

test('a ociosidade derruba a sessão (relógio injetado) e a seguinte sobe outra', async (t) => {
  const lab = labIn(t)
  const clock = fakeClock()
  const log = lab.logFile()
  const manager = lab.manager({ clock, idleMs: 1000, extra: ['--log', log] })
  const primeira = await manager.sessionFor(lab.root)
  assert.equal(manager.openRoots().length, 1)
  assert.ok(clock.armed(), 'com sessão viva a varredura tem que estar armada')

  clock.advance(999)
  assert.equal(manager.openRoots().length, 1, 'antes do prazo ninguém morre')

  clock.advance(1)
  assert.deepEqual(manager.openRoots(), [])
  assert.equal(primeira.alive, false)
  await delay(150)
  assert.ok(
    readLog(log).some((entry) => entry.event === 'exit'),
    'a derrubada tem que pedir tchau pelo protocolo (o servidor derruba os próprios filhos)'
  )

  const segunda = await manager.sessionFor(lab.root)
  assert.notEqual(segunda, primeira)
  assert.equal(manager.openRoots().length, 1)
})

test('uso recente ADIA a ociosidade', async (t) => {
  const lab = labIn(t)
  const clock = fakeClock()
  const manager = lab.manager({ clock, idleMs: 1000 })
  await manager.sessionFor(lab.root)
  clock.advance(900)
  await manager.sessionFor(lab.root)
  clock.advance(200)
  assert.equal(manager.openRoots().length, 1, 'a sessão foi usada há 200ms: não é ociosa')
})

test('invalidate mata a raiz que sumiu; disposeAll fecha tudo e fecha a porta', async (t) => {
  const lab = labIn(t)
  const manager = lab.manager()
  const session = await manager.sessionFor(lab.root)
  manager.invalidate(lab.root)
  assert.deepEqual(manager.openRoots(), [])
  assert.equal(session.alive, false)

  const outra = await manager.sessionFor(lab.root)
  assert.equal(manager.openRoots().length, 1)
  manager.disposeAll()
  assert.deepEqual(manager.openRoots(), [])
  assert.equal(outra.alive, false)
  await assert.rejects(manager.sessionFor(lab.root), (e) => {
    assert.match(e.message, /reabra o chat/)
    return true
  })
})

test('sessão que MORREU sai do cache: a próxima chamada sobe um servidor novo', async (t) => {
  const lab = labIn(t)
  const manager = lab.manager({ extra: ['--die-on', 'textDocument/didOpen'] })
  const primeira = await manager.sessionFor(lab.root)
  await assert.rejects(primeira.diagnostics(['src/a.ts']), /a próxima chamada sobe um servidor novo/)
  await delay(50)
  assert.deepEqual(manager.openRoots(), [], 'servidor morto não pode ficar no cache')
  const segunda = await manager.sessionFor(lab.root)
  assert.notEqual(segunda, primeira)
})

test('lançador que recusa (pacote faltando) não deixa sessão fantasma no cache', async (t) => {
  const lab = labIn(t)
  const manager = new LspManager({
    launcherFor: () => {
      throw new LspError('o servidor de linguagem não está instalado — rode `npm install`')
    }
  })
  t.after(() => manager.disposeAll())
  await assert.rejects(manager.sessionFor(lab.root), /npm install/)
  assert.deepEqual(manager.openRoots(), [])
})

// ————— 7. o lançador de produção, com a resolução MASCARADA —————

function pacoteFalso(t, bin) {
  const dir = mkdtempSync(join(tmpdir(), 'synkora-tsls-'))
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'typescript-language-server', version: '5.0.0', bin }),
    'utf-8'
  )
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* idem */
    }
  })
  return dir
}

test('tsServerLaunch: Electron em modo node, --stdio e o typescript do WORKSPACE', (t) => {
  const pacote = pacoteFalso(t, { 'typescript-language-server': './lib/cli.mjs' })
  const launch = tsServerLaunch('C:/missoes/wt-1', {
    serverPackageDir: () => pacote,
    workspaceTsServer: () => 'C:/missoes/wt-1/node_modules/typescript/lib/tsserver.js',
    execPath: 'C:/apps/Synkora.exe'
  })
  assert.equal(launch.command, 'C:/apps/Synkora.exe')
  assert.deepEqual(launch.args, [join(pacote, 'lib', 'cli.mjs'), '--stdio'])
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(launch.cwd, 'C:/missoes/wt-1')
  assert.deepEqual(launch.initializationOptions, {
    tsserver: { path: 'C:/missoes/wt-1/node_modules/typescript/lib/tsserver.js' }
  })
})

test('sem typescript no workspace o servidor usa o que ele embarca', (t) => {
  const pacote = pacoteFalso(t, './lib/cli.mjs')
  const launch = tsServerLaunch('C:/missoes/wt-2', {
    serverPackageDir: () => pacote,
    workspaceTsServer: () => null,
    execPath: 'C:/apps/Synkora.exe'
  })
  assert.deepEqual(launch.args, [join(pacote, 'lib', 'cli.mjs'), '--stdio'])
  assert.equal(launch.initializationOptions, undefined)
})

test('pacote do servidor ausente vira frase que NOMEIA o comando que instala', () => {
  assert.throws(
    () => tsServerLaunch('C:/missoes/wt-3', { serverPackageDir: () => null }),
    (e) => {
      assert.equal(e.name, 'LspError')
      assert.match(e.message, /typescript-language-server/)
      assert.match(e.message, /npm install/)
      assert.match(e.message, /reabra o chat/)
      return true
    }
  )
})

test('pacote sem executável declarado também nomeia a receita', (t) => {
  const pacote = pacoteFalso(t, undefined)
  assert.throws(() => tsServerLaunch('C:/missoes/wt-4', { serverPackageDir: () => pacote }), (e) => {
    assert.match(e.message, /não declara executável/)
    assert.match(e.message, /npm install typescript-language-server/)
    return true
  })
})
