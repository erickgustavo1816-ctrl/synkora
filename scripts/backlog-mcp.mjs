// MCP DO BACKLOG (stdio, feito à mão — 2026-08-21, ordem do dono).
//
// JSON-RPC 2.0 por linha em stdin/stdout, sem dependência nenhuma: o SDK v2
// do repo é HTTP-first e um tool de projeto não pode exigir servidor de pé.
// O Claude Code sobe este processo sob demanda via .mcp.json (raiz do repo).
//
// Toda mutação re-renderiza docs/backlog-synkora.html (a fonte do artifact);
// republicar o artifact continua sendo gesto do orquestrador. Mexidas do DONO
// (console local) ficam no diário — backlog_inbox é o "o que ele mexeu".
import {
  LANES,
  addItem,
  appendJournal,
  findItem,
  listBacklog,
  loadBacklog,
  moveItem,
  removeItem,
  renderBacklog,
  saveBacklog,
  updateItem
} from './backlog.mjs'

const TOOLS = [
  {
    name: 'backlog_list',
    description:
      'O backlog vivo do Synkora, trilho a trilho (agora/fila/candidatas/dividas/feito), com ids. Leia antes de qualquer mutação.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'backlog_inbox',
    description:
      'O DIÁRIO das mexidas recentes — principalmente as do DONO no console local (adicionou, moveu, mandou "vamos fazer"). Leia no começo da sessão: é assim que o dono te avisa.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'máximo de entradas (default 20)' } },
      additionalProperties: false
    }
  },
  {
    name: 'backlog_add',
    description: 'Adiciona um item num trilho. O HTML do artifact é re-renderizado; republicar é seu gesto.',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'string', enum: LANES },
        title: { type: 'string' },
        desc: { type: 'string' },
        refs: { type: 'array', items: { type: 'string' } },
        badge: { type: 'string' }
      },
      required: ['lane', 'title'],
      additionalProperties: false
    }
  },
  {
    name: 'backlog_move',
    description: 'Move um item para outro trilho (posição 1-based opcional). Mover para "feito" carimba o dia.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        lane: { type: 'string', enum: LANES },
        position: { type: 'number' }
      },
      required: ['id', 'lane'],
      additionalProperties: false
    }
  },
  {
    name: 'backlog_update',
    description: 'Edita campos de um item (title/desc/badge/day/refs). Campo com string vazia é removido.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        desc: { type: 'string' },
        badge: { type: 'string' },
        day: { type: 'string' },
        refs: { type: 'array', items: { type: 'string' } }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'backlog_remove',
    description: 'Remove um item de vez (feito não é remoção — mova para "feito").',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'backlog_render',
    description: 'Re-renderiza o HTML do artifact a partir do JSON, sem mudar dado nenhum.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
]

function callTool(name, args) {
  const doc = loadBacklog()
  if (name === 'backlog_list') return listBacklog(doc)
  if (name === 'backlog_inbox') {
    const limit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : 20
    const entries = (doc.journal ?? []).slice(-limit).reverse()
    if (entries.length === 0) return 'diário vazio — nenhuma mexida registrada.'
    return entries
      .map((entry) => `${entry.at} · ${entry.by}: ${entry.action} ${entry.id ?? ''} ${entry.detail ?? ''}`.trim())
      .join('\n')
  }
  if (name === 'backlog_add') {
    const item = addItem(doc, args.lane, args)
    appendJournal(doc, { by: 'orquestrador', action: 'add', id: item.id, detail: `→ ${args.lane}` })
    saveBacklog(doc)
    return `adicionado em ${args.lane}: ${item.id} — lembre de republicar o artifact.`
  }
  if (name === 'backlog_move') {
    moveItem(doc, args.id, args.lane, args.position)
    appendJournal(doc, { by: 'orquestrador', action: 'move', id: args.id, detail: `→ ${args.lane}` })
    saveBacklog(doc)
    return `movido: ${args.id} → ${args.lane} — lembre de republicar o artifact.`
  }
  if (name === 'backlog_update') {
    updateItem(doc, args.id, args)
    appendJournal(doc, { by: 'orquestrador', action: 'update', id: args.id })
    saveBacklog(doc)
    return `atualizado: ${args.id} — lembre de republicar o artifact.`
  }
  if (name === 'backlog_remove') {
    if (!findItem(doc, args.id)) return `item não encontrado: ${args.id}`
    removeItem(doc, args.id)
    appendJournal(doc, { by: 'orquestrador', action: 'remove', id: args.id })
    saveBacklog(doc)
    return `removido: ${args.id} — lembre de republicar o artifact.`
  }
  if (name === 'backlog_render') {
    return `renderizado: ${renderBacklog(doc)}`
  }
  throw new Error(`tool desconhecida: ${name}`)
}

// ————— transporte stdio (JSON-RPC por linha) —————
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) handleMessage(line)
  }
})

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function handleMessage(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = message
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'synkora-backlog', version: '1.0.0' }
      }
    })
    return
  }
  if (method === 'notifications/initialized' || id === undefined) return
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    try {
      const text = callTool(params?.name, params?.arguments ?? {})
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true
        }
      })
    }
    return
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `método desconhecido: ${method}` } })
}
