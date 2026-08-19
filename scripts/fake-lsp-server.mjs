#!/usr/bin/env node
/**
 * SERVIDOR DE LINGUAGEM FALSO — node puro, protocolo DE VERDADE.
 *
 * É um dublê de teste, mas nada aqui é simulado: framing `Content-Length` real,
 * JSON-RPC 2.0 real, handshake real, `publishDiagnostics` real por stdio real.
 * A suíte `test:lsp-engine` prova o motor contra ESTE binário porque
 * `typescript-language-server` é dependência de RUNTIME: o gate não pode
 * depender de ter o pacote instalado, e o motor não pode ser provado com um
 * mock que "responde promessa" sem passar por byte nenhum.
 *
 * As duas convenções (o roteiro) — desenhadas para o teste afirmar POSIÇÃO
 * EXATA e assim prender a conversão 0-based → 1-based da borda do motor:
 *
 * 1. DIAGNÓSTICO sai do CONTEÚDO. Toda linha que contiver `@@` vira um
 *    problema na coluna onde o `@@` começa:
 *        @@E2304:nome não encontrado   → erro, código 2304
 *        @@W:cuidado                   → aviso, sem código
 *    Letras: E=erro W=aviso I=informação H=dica.
 *
 * 2. CONSULTA PONTUAL é aritmética sobre a posição pedida (em coordenadas de
 *    FIO, 0-based), para que o teste confira os dois sentidos da conversão:
 *        linha 0            → "não há nada aqui" (null / lista vazia)
 *        definition         → [linha+2, caractere+3] .. [linha+2, caractere+8]
 *        definition, col 0  → um alvo FORA da raiz (o caso do lib.d.ts)
 *        references         → [linha, caractere] e [linha+10, caractere+1]
 *        hover              → texto "sym@<linha>:<caractere>" (do FIO)
 *
 * Bandeiras (todas para provar um comportamento do motor, nenhuma decorativa):
 *   --log <arquivo>        diário JSONL do que chegou (ordem do handshake)
 *   --bursts <n>           rajadas de publishDiagnostics por sincronização; as
 *                          n-1 primeiras vêm VAZIAS (é o que o tsserver faz:
 *                          passada sintática antes da semântica)
 *   --burst-gap <ms>       intervalo entre rajadas
 *   --never-settle         publica para sempre (prova o teto duro da espera)
 *   --die-on <method>      morre ao receber este método (morte no meio)
 *   --garbage              cospe lixo antes do primeiro quadro (re-sincronização)
 *   --split-writes         parte cada quadro em dois pedaços (quadro parcial)
 *   --join-writes          gruda os quadros num write só (quadros colados)
 *   --slow <method=ms>     demora para responder (prova o teto por pedido)
 *   --probe-request        manda um PEDIDO do servidor ao cliente e anota a
 *                          resposta (cliente mudo travaria um servidor real)
 */
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)

function flag(name) {
  return argv.includes(`--${name}`)
}

function option(name, fallback) {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback
}

const LOG = option('log', null)
const BURSTS = Number(option('bursts', '2'))
const BURST_GAP = Number(option('burst-gap', '25'))
const NEVER_SETTLE = flag('never-settle')
const DIE_ON = option('die-on', null)
const GARBAGE = flag('garbage')
const SPLIT_WRITES = flag('split-writes')
const JOIN_WRITES = flag('join-writes')
const PROBE_REQUEST = flag('probe-request')
const SLOW = new Map(
  argv
    .filter((_, index) => argv[index - 1] === '--slow')
    .map((entry) => {
      const [method, ms] = entry.split('=')
      return [method, Number(ms)]
    })
)

const SEVERITY_BY_LETTER = { E: 1, W: 2, I: 3, H: 4 }

/** Texto de cada documento aberto, por uri. */
const documents = new Map()
/** Timers de rajada por uri — sincronização nova cancela a anterior. */
const bursting = new Map()
let rootPath = process.cwd()
let joinQueue = []
let joinTimer = null
let probeId = 9001

function log(entry) {
  if (!LOG) return
  appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), ...entry })}\n`, 'utf-8')
}

// ————— escrita: framing de verdade, com as maldades opcionais —————

function writeFrame(message) {
  const body = JSON.stringify(message)
  const frame = `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n${body}`
  if (JOIN_WRITES) {
    joinQueue.push(frame)
    if (!joinTimer) {
      joinTimer = setTimeout(() => {
        const joined = joinQueue.join('')
        joinQueue = []
        joinTimer = null
        process.stdout.write(joined)
      }, 5)
    }
    return
  }
  if (SPLIT_WRITES) {
    // O corte cai DENTRO do cabeçalho: quadro parcial de verdade, não corpo
    // partido só no fim.
    const cut = 10
    process.stdout.write(frame.slice(0, cut))
    setTimeout(() => process.stdout.write(frame.slice(cut)), 3)
    return
  }
  process.stdout.write(frame)
}

function respond(id, result) {
  writeFrame({ jsonrpc: '2.0', id, result })
}

function notify(method, params) {
  writeFrame({ jsonrpc: '2.0', method, params })
}

// ————— leitura: o mesmo framing, do outro lado —————

let buffer = Buffer.alloc(0)

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const header = buffer.subarray(0, headerEnd).toString('ascii')
    const match = /content-length:\s*(\d+)/i.exec(header)
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }
    const length = Number(match[1])
    const start = headerEnd + 4
    if (buffer.length < start + length) return
    const body = buffer.subarray(start, start + length).toString('utf-8')
    buffer = buffer.subarray(start + length)
    try {
      handle(JSON.parse(body))
    } catch (e) {
      log({ event: 'corpo-invalido', message: String(e) })
    }
  }
})

function handle(message) {
  // Resposta do CLIENTE ao nosso pedido: o motor tem que responder, senão um
  // servidor de verdade ficaria esperando para sempre.
  if (message.method === undefined) {
    log({ event: 'resposta-do-cliente', id: message.id, result: message.result ?? null, error: message.error ?? null })
    return
  }
  log({ method: message.method })
  if (DIE_ON && message.method === DIE_ON) {
    log({ event: 'morrendo', method: message.method })
    process.exit(9)
  }
  const delay = SLOW.get(message.method)
  if (delay) {
    setTimeout(() => dispatch(message), delay)
    return
  }
  dispatch(message)
}

function dispatch(message) {
  switch (message.method) {
    case 'initialize':
      return onInitialize(message)
    case 'initialized':
      if (PROBE_REQUEST) {
        writeFrame({ jsonrpc: '2.0', id: probeId++, method: 'window/workDoneProgress/create', params: { token: 'x' } })
      }
      return
    case 'textDocument/didOpen': {
      const doc = message.params.textDocument
      documents.set(doc.uri, doc.text)
      return publishBursts(doc.uri)
    }
    case 'textDocument/didChange': {
      const uri = message.params.textDocument.uri
      documents.set(uri, message.params.contentChanges.at(-1).text)
      return publishBursts(uri)
    }
    case 'textDocument/didClose':
      documents.delete(message.params.textDocument.uri)
      return
    case 'textDocument/definition':
      return respond(message.id, definitionAt(message.params))
    case 'textDocument/references':
      return respond(message.id, referencesAt(message.params))
    case 'textDocument/hover':
      return respond(message.id, hoverAt(message.params))
    case 'shutdown':
      return respond(message.id, null)
    case 'exit':
      log({ event: 'exit' })
      process.exit(0)
      return
    default:
      if (message.id !== undefined) {
        writeFrame({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `o dublê não trata "${message.method}"` }
        })
      }
  }
}

function onInitialize(message) {
  const uri = message.params?.rootUri
  if (typeof uri === 'string') rootPath = fileURLToPath(uri)
  log({ event: 'initializationOptions', value: message.params?.initializationOptions ?? null })
  if (GARBAGE) {
    // Sem `Content-Length` e com fim de cabeçalho: o parser do motor tem que
    // largar este bloco e re-sincronizar no quadro seguinte.
    process.stdout.write('ruído inicial do servidor\r\nlixo: sim\r\n\r\n')
  }
  respond(message.id, {
    capabilities: {
      textDocumentSync: 1,
      definitionProvider: true,
      referencesProvider: true,
      hoverProvider: true
    },
    serverInfo: { name: 'fake-lsp-server', version: '1.0.0' }
  })
}

// ————— diagnóstico derivado do conteúdo —————

function diagnosticsOf(uri) {
  const text = documents.get(uri) ?? ''
  const found = []
  text.split(/\r?\n/).forEach((line, index) => {
    const at = line.indexOf('@@')
    if (at < 0) return
    const match = /^@@([EWIH])([^:]*):(.*)$/.exec(line.slice(at))
    if (!match) return
    const diagnostic = {
      range: { start: { line: index, character: at }, end: { line: index, character: line.length } },
      severity: SEVERITY_BY_LETTER[match[1]],
      message: match[3].trim()
    }
    if (match[2]) diagnostic.code = match[2]
    found.push(diagnostic)
  })
  return found
}

function publishBursts(uri) {
  clearTimeout(bursting.get(uri))
  const real = diagnosticsOf(uri)
  let burst = 0
  const fire = () => {
    burst += 1
    const last = burst >= BURSTS
    notify('textDocument/publishDiagnostics', { uri, diagnostics: last ? real : [] })
    if (last && !NEVER_SETTLE) return
    bursting.set(uri, setTimeout(fire, BURST_GAP))
  }
  fire()
}

// ————— consultas pontuais: aritmética sobre a posição do FIO —————

function definitionAt(params) {
  const { line, character } = params.position
  if (line === 0) return null
  if (character === 0) {
    // Definição FORA da raiz: o caso do `lib.d.ts` do typescript.
    const outside = join(dirname(rootPath), 'fora-da-raiz', 'lib.d.ts')
    return [
      {
        uri: pathToFileURL(outside).href,
        range: { start: { line: 1, character: 1 }, end: { line: 1, character: 6 } }
      }
    ]
  }
  return [
    {
      uri: params.textDocument.uri,
      range: {
        start: { line: line + 2, character: character + 3 },
        end: { line: line + 2, character: character + 8 }
      }
    }
  ]
}

function referencesAt(params) {
  const { line, character } = params.position
  if (line === 0) return []
  return [
    {
      uri: params.textDocument.uri,
      range: { start: { line, character }, end: { line, character: character + 4 } }
    },
    {
      uri: params.textDocument.uri,
      range: {
        start: { line: line + 10, character: character + 1 },
        end: { line: line + 10, character: character + 5 }
      }
    }
  ]
}

function hoverAt(params) {
  const { line, character } = params.position
  if (line === 0) return null
  return {
    contents: { kind: 'markdown', value: `sym@${line}:${character}` },
    range: { start: { line, character }, end: { line, character: character + 4 } }
  }
}
