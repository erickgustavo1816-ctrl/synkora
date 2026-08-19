import { Buffer } from 'node:buffer'

/**
 * JSON-RPC 2.0 sobre stdio com framing `Content-Length` — a camada mais BAIXA
 * do motor LSP da era 2.0 (R14). Sem dependência nova de protocolo: o motor
 * valida forma minimamente e nada mais.
 *
 * O que esta camada garante e o resto do motor pode assumir:
 * - o fluxo de bytes NÃO respeita mensagem: um `data` pode trazer meio
 *   cabeçalho, três quadros grudados ou um corpo partido no meio de um
 *   caractere UTF-8 — o parser acumula e só entrega quadro inteiro;
 * - cabeçalho é case-INSENSITIVE (`content-length` é tão válido quanto
 *   `Content-Length`), e `Content-Length` conta BYTES, não caracteres;
 * - lixo entre quadros é RUÍDO, não morte: vira aviso em `onProtocolError` e o
 *   parser tenta re-sincronizar no próximo cabeçalho válido;
 * - todo pedido tem teto de espera, e todo pedido do SERVIDOR recebe resposta
 *   (servidor que espera resposta que nunca vem trava a sessão inteira).
 *
 * Quem mata o processo é a sessão (`lspSession.ts`), nunca esta camada:
 * `dispose()` derruba os pedidos em voo com um motivo em voz alta e para de
 * escutar — o cano continua sendo de quem o abriu.
 */

/** Teto padrão por pedido. Consulta pontual em projeto grande custa segundos,
 *  não minutos: passar disso é sinal de servidor travado, não de projeto lento. */
export const LSP_REQUEST_TIMEOUT_MS = 20_000

/** Cabeçalho sem fim é fluxo corrompido — a partir daqui o parser desiste do
 *  que juntou e tenta re-sincronizar. */
const MAX_HEADER_BYTES = 64 * 1024

/** Corpo maior que isto é `Content-Length` mentiroso: o fluxo já dessincronizou
 *  e esperar o resto seria esperar para sempre. */
const MAX_BODY_BYTES = 64 * 1024 * 1024

const HEADER_END = Buffer.from('\r\n\r\n', 'ascii')

/**
 * Erro do motor LSP. TODA recusa nasce aqui e TODA mensagem nomeia a RECEITA —
 * a ação que destrava (qual raiz vale, qual comando instala, chamar de novo).
 * Beco sem saída é bug: o agente do outro lado precisa saber o próximo passo.
 */
export class LspError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LspError'
  }
}

/** O par de canos do servidor. Tipado por FORMA (e não como `ChildProcess`)
 *  para que o teste de framing possa ligar dois `PassThrough` e provar o
 *  parser sem processo nenhum no meio. */
export interface LspRpcStreams {
  stdin: { write(chunk: string): unknown }
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
}

export interface LspRpcOpts {
  streams: LspRpcStreams
  /** Teto por pedido (default `LSP_REQUEST_TIMEOUT_MS`). */
  requestTimeoutMs?: number
  /** Quadro malformado, lixo no cano, corpo que não é JSON. Nunca derruba a
   *  sessão — é diagnóstico para quem estiver olhando. */
  onProtocolError?: (message: string) => void
}

/** Trata um pedido VINDO do servidor (`workspace/configuration`,
 *  `client/registerCapability`, …). O retorno vira o `result`. */
export type LspRequestHandler = (params: unknown) => unknown | Promise<unknown>

export type LspNotificationListener = (params: unknown) => void

interface WireMessage {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class LspRpc {
  private readonly streams: LspRpcStreams
  private readonly requestTimeoutMs: number
  private readonly onProtocolError: (message: string) => void
  private readonly pending = new Map<number, PendingRequest>()
  private readonly notificationListeners = new Map<string, Set<LspNotificationListener>>()
  private readonly requestHandlers = new Map<string, LspRequestHandler>()
  private buffer: Buffer = Buffer.alloc(0)
  private nextId = 1
  private disposed = false

  constructor(opts: LspRpcOpts) {
    this.streams = opts.streams
    this.requestTimeoutMs = opts.requestTimeoutMs ?? LSP_REQUEST_TIMEOUT_MS
    this.onProtocolError = opts.onProtocolError ?? ((): void => {})
    this.streams.stdout.on('data', (chunk: Buffer) => this.consume(chunk))
  }

  /** Um pedido ao servidor. Rejeita com `LspError` em erro do servidor, em
   *  teto de espera e quando a sessão cai com pedido em voo. */
  request<T = unknown>(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number }
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(
        new LspError(
          `a sessão do servidor de linguagem já foi encerrada (pedido "${method}") — chame de novo: a próxima chamada sobe um servidor novo`
        )
      )
    }
    const id = this.nextId++
    const timeoutMs = opts?.timeoutMs ?? this.requestTimeoutMs
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(
          new LspError(
            `o servidor de linguagem não respondeu "${method}" em ${timeoutMs}ms — chame de novo, ou aponte um arquivo menor`
          )
        )
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Uma notificação ao servidor (sem resposta, sem espera). */
  notify(method: string, params?: unknown): void {
    if (this.disposed) return
    this.send({ jsonrpc: '2.0', method, params })
  }

  /** Escuta notificações do servidor. Devolve o cancelador. */
  onNotification(method: string, listener: LspNotificationListener): () => void {
    const listeners = this.notificationListeners.get(method) ?? new Set<LspNotificationListener>()
    listeners.add(listener)
    this.notificationListeners.set(method, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.notificationListeners.delete(method)
    }
  }

  /** Responde a um pedido VINDO do servidor. Sem handler registrado o pedido
   *  ainda recebe resposta (`-32601`) — servidor esperando resposta que nunca
   *  chega é sessão travada, não sessão silenciosa. */
  onRequest(method: string, handler: LspRequestHandler): () => void {
    this.requestHandlers.set(method, handler)
    return () => {
      if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method)
    }
  }

  /** Derruba os pedidos em voo com o motivo em voz alta e para de escutar. Não
   *  mata processo: o cano é de quem o abriu. Idempotente. */
  dispose(reason?: string): void {
    if (this.disposed) return
    this.disposed = true
    const message =
      reason ??
      'a sessão do servidor de linguagem foi encerrada — chame de novo: a próxima chamada sobe um servidor novo'
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new LspError(`${message} (pedido "${pending.method}")`))
    }
    this.pending.clear()
    this.notificationListeners.clear()
    this.requestHandlers.clear()
    this.buffer = Buffer.alloc(0)
  }

  // ————— internos —————

  private send(message: WireMessage): void {
    const body = JSON.stringify(message)
    const length = Buffer.byteLength(body, 'utf-8')
    try {
      this.streams.stdin.write(`Content-Length: ${length}\r\n\r\n${body}`)
    } catch (e) {
      this.onProtocolError(
        `não foi possível escrever no servidor de linguagem: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  /** Acumula bytes e entrega quadro INTEIRO. Chunk pode trazer meio cabeçalho,
   *  vários quadros grudados ou um corpo partido — todos os três caem aqui. */
  private consume(chunk: Buffer): void {
    if (this.disposed) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_END)
      if (headerEnd < 0) {
        if (this.buffer.length > MAX_HEADER_BYTES) {
          this.onProtocolError(
            `cabeçalho sem fim depois de ${this.buffer.length} bytes — o fluxo do servidor de linguagem foi descartado até o próximo quadro`
          )
          this.buffer = Buffer.alloc(0)
        }
        return
      }
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const length = contentLengthOf(header, this.onProtocolError)
      if (length === null) {
        this.onProtocolError(`quadro sem Content-Length descartado: ${preview(header)}`)
        this.buffer = this.buffer.subarray(headerEnd + HEADER_END.length)
        continue
      }
      if (length > MAX_BODY_BYTES) {
        this.onProtocolError(
          `Content-Length de ${length} bytes é maior que o teto — o fluxo do servidor de linguagem foi descartado`
        )
        this.buffer = Buffer.alloc(0)
        return
      }
      const start = headerEnd + HEADER_END.length
      // Quadro parcial: devolver ao acumulador e esperar o resto do cano.
      if (this.buffer.length < start + length) return
      const body = this.buffer.subarray(start, start + length).toString('utf-8')
      this.buffer = this.buffer.subarray(start + length)
      this.dispatch(body)
    }
  }

  private dispatch(body: string): void {
    let message: WireMessage
    try {
      message = JSON.parse(body) as WireMessage
    } catch {
      this.onProtocolError(`corpo de quadro não é JSON: ${preview(body)}`)
      return
    }
    if (typeof message.method === 'string') {
      if (message.id === undefined || message.id === null) this.deliverNotification(message)
      else this.answerServerRequest(message.id, message.method, message.params)
      return
    }
    if (message.id === undefined || message.id === null) {
      this.onProtocolError(`quadro sem method e sem id ignorado: ${preview(body)}`)
      return
    }
    this.settleResponse(message)
  }

  private deliverNotification(message: WireMessage): void {
    const listeners = this.notificationListeners.get(message.method as string)
    if (!listeners) return
    for (const listener of [...listeners]) {
      try {
        listener(message.params)
      } catch (e) {
        this.onProtocolError(
          `ouvinte de "${message.method}" falhou: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
  }

  private answerServerRequest(id: number | string, method: string, params: unknown): void {
    const handler = this.requestHandlers.get(method)
    if (!handler) {
      this.send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `o Synkora não trata "${method}"` }
      })
      return
    }
    Promise.resolve()
      .then(() => handler(params))
      .then(
        (result) => this.send({ jsonrpc: '2.0', id, result: result ?? null }),
        (e: unknown) =>
          this.send({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: e instanceof Error ? e.message : String(e) }
          })
      )
  }

  private settleResponse(message: WireMessage): void {
    const id = typeof message.id === 'number' ? message.id : Number(message.id)
    if (!Number.isFinite(id)) {
      this.onProtocolError(`resposta com id inválido: ${String(message.id)}`)
      return
    }
    const pending = this.pending.get(id)
    // Resposta atrasada de pedido que já estourou o teto: o chamador já foi
    // embora com a receita, e reabrir a promessa seria mentir sobre o tempo.
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (message.error) {
      pending.reject(
        new LspError(
          `o servidor de linguagem recusou "${pending.method}": ${message.error.message ?? 'sem motivo declarado'}`
        )
      )
      return
    }
    pending.resolve(message.result)
  }
}

/** `Content-Length` case-INSENSITIVE. Com lixo grudado antes do quadro o
 *  cabeçalho verdadeiro é o ÚLTIMO — por isso o último vence. */
function contentLengthOf(header: string, onProtocolError: (message: string) => void): number | null {
  let length: number | null = null
  for (const raw of header.split('\r\n')) {
    const line = raw.trim()
    if (!line) continue
    const match = /^content-length:\s*(\d+)$/i.exec(line)
    if (match) {
      length = Number(match[1])
      continue
    }
    // Content-Type e afins são legítimos; qualquer outra coisa é ruído no cano.
    if (!/^[A-Za-z0-9-]+:/.test(line)) onProtocolError(`lixo antes do quadro descartado: ${preview(line)}`)
  }
  return length
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
}
