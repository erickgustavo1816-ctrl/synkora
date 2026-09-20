import { randomBytes, timingSafeEqual } from 'node:crypto'
import { open } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { GuiFileResolver, GuiResolvedFile } from './guiFileResolver'
import { GUI_ARTIFACT_PREVIEW_PREFIX } from './guiFileBrowserUrl'

export const GUI_ARTIFACT_PREVIEW_MAX_BYTES = 64 * 1024 * 1024
export const GUI_ARTIFACT_PREVIEW_MAX_LEASES = 12
export const GUI_ARTIFACT_PREVIEW_MAX_READS = 8
export const GUI_ARTIFACT_PREVIEW_TTL_MS = 30 * 60 * 1000

/** No JSON, source maps, source code, directory listing or app-server routes.
 * Renderable entries use the resolver's MIME map; these are static assets a
 * standalone page may load from its own directory. */
const ASSET_MIME = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.m4a', 'audio/mp4'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.ogv', 'video/ogg']
])

const PRIVATE_SEGMENTS = new Set([
  'credentials', 'secrets', 'private', 'node_modules', 'vendor'
])

const DOCUMENT_CSP = [
  "default-src 'none'",
  "script-src 'self' https: 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' https: 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "font-src 'self' https: data:",
  "media-src 'self' https: data: blob:",
  "connect-src 'self' https:",
  'frame-src https:',
  "object-src 'none'",
  "worker-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  'sandbox allow-scripts allow-same-origin'
].join('; ')

export interface GuiArtifactPreviewLease {
  /** Main-only capability; never persist or journal this URL. */
  url: string
  alive(): boolean
  close(): void
}

export type GuiArtifactPreviewResult =
  | { ok: true; lease: GuiArtifactPreviewLease }
  | { ok: false; error: string }

interface Options {
  resolver: Pick<GuiFileResolver, 'resolve'>
  entryMime: ReadonlyMap<string, string>
  ttlMs?: number
  maxLeases?: number
  maxBytes?: number
  maxReads?: number
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => process.platform === 'win32'
    ? resolve(value).toLowerCase() : resolve(value)
  return normalize(left) === normalize(right)
}

function allowedSegments(segments: string[]): boolean {
  return segments.every(segment => segment.length > 0 &&
    segment !== '.' && segment !== '..' && !segment.startsWith('.') &&
    !PRIVATE_SEGMENTS.has(segment.toLowerCase()) && !/[\\/:\u0000-\u001f\u007f]/u.test(segment))
}

function requestPath(raw: string | undefined, token: string): string[] | null {
  if (!raw || raw.length > 8192) return null
  const prefix = `${GUI_ARTIFACT_PREVIEW_PREFIX}${token}/`
  const path = raw.split('?')[0]
  if (!path.startsWith(prefix)) return null
  try {
    const segments = path.slice(prefix.length).split('/').map(segment => decodeURIComponent(segment))
    // Reject encoded separators and double-encoded traversal before any path
    // normalization. Never let the URL parser erase a `..` before the guard.
    if (!allowedSegments(segments) || segments.some(segment => /%[0-9a-f]{2}/iu.test(segment))) return null
    return segments
  } catch { return null }
}

function byteRange(header: string | undefined, size: number): { start: number; end: number } | null | false {
  if (header === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header)
  if (!match || (!match[1] && !match[2]) || size === 0) return false
  const suffix = match[1] === ''
  const first = Number(suffix ? match[2] : match[1])
  const last = match[2] && !suffix ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) ||
    (suffix && first <= 0) || (!suffix && (first >= size || last < first))) return false
  return { start: suffix ? Math.max(0, size - first) : first, end: Math.min(last, size - 1) }
}

function reply(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Connection': 'close'
  })
  response.end(body)
}

/** A separate loopback origin per selected artifact avoids granting one page
 * another pane's capability via same-origin scripting. Every access repeats
 * the existing physical resolver, pins its root, and checks the open handle
 * before reading bytes. Only the selected directory is mounted, not cwd. */
export class GuiArtifactPreviewServer {
  private readonly leases = new Set<GuiArtifactPreviewLease>()
  private activeReads = 0
  private readonly options: Options

  constructor(options: Options) { this.options = options }

  close(): void {
    for (const lease of this.leases) lease.close()
  }

  async open(file: GuiResolvedFile, authorized: () => boolean): Promise<GuiArtifactPreviewResult> {
    const { resolver, entryMime } = this.options
    const maxBytes = this.options.maxBytes ?? GUI_ARTIFACT_PREVIEW_MAX_BYTES
    if (!entryMime.has(extname(file.name).toLowerCase()) || !allowedSegments(file.path.split('/'))) {
      return { ok: false, error: 'este arquivo não tem visualização no browser; use abrir no app' }
    }
    if (this.leases.size >= (this.options.maxLeases ?? GUI_ARTIFACT_PREVIEW_MAX_LEASES)) {
      return { ok: false, error: 'feche uma prévia do browser antes de abrir outra' }
    }
    const initial = resolver.resolve(file.rootPath, file.path, file.path)
    if (!initial.ok || !samePath(initial.file.rootRealPath, file.rootRealPath) || !authorized()) {
      return { ok: false, error: 'este arquivo não está mais disponível nesta conversa; abra o arquivo novamente' }
    }
    let initialHandle: Awaited<ReturnType<typeof open>> | undefined
    try {
      initialHandle = await open(file.absolutePath, 'r')
      const stat = await initialHandle.stat()
      if (!stat.isFile() || stat.size > maxBytes) {
        return { ok: false, error: 'arquivo grande demais para esta prévia; use o menu para abrir no programa padrão' }
      }
    } catch {
      return { ok: false, error: 'não consegui abrir este arquivo; tente novamente pelo link' }
    } finally { await initialHandle?.close().catch(() => {}) }

    // In-flight opens reserve a slot before binding, so simultaneous clicks
    // cannot bypass the resource bound while listen() is pending.
    if (this.leases.size >= (this.options.maxLeases ?? GUI_ARTIFACT_PREVIEW_MAX_LEASES)) {
      return { ok: false, error: 'feche uma prévia do browser antes de abrir outra' }
    }
    const token = randomBytes(24).toString('hex')
    const tokenBytes = Buffer.from(token)
    const folder = dirname(file.absolutePath)
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let host = ''
    let server: Server
    const lease: GuiArtifactPreviewLease = {
      url: '',
      alive: () => !closed,
      close: () => {
        if (closed) return
        closed = true
        if (timer) clearTimeout(timer)
        this.leases.delete(lease)
        server?.closeAllConnections()
        server?.close()
      }
    }
    const refresh = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => lease.close(), this.options.ttlMs ?? GUI_ARTIFACT_PREVIEW_TTL_MS)
      timer.unref?.()
    }
    const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      if (closed || !authorized()) { reply(response, 410, 'Prévia encerrada. Abra o arquivo novamente no chat.'); lease.close(); return }
      const origin = `http://${host}`
      if (request.headers.host !== host ||
        (request.headers.origin !== undefined && request.headers.origin !== origin) ||
        request.headers['sec-fetch-site'] === 'cross-site') {
        reply(response, 403, 'Requisição recusada.'); return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD')
        reply(response, 405, 'Esta prévia é somente leitura.'); return
      }
      const offered = request.url?.slice(GUI_ARTIFACT_PREVIEW_PREFIX.length).split('/')[0] ?? ''
      const offeredBytes = Buffer.from(offered)
      if (offeredBytes.length !== tokenBytes.length || !timingSafeEqual(offeredBytes, tokenBytes)) {
        reply(response, 404, 'Arquivo não disponível nesta prévia.'); return
      }
      const segments = requestPath(request.url, token)
      if (!segments) { reply(response, 404, 'Arquivo não disponível nesta prévia.'); return }
      const target = resolve(folder, ...segments)
      const extension = extname(target).toLowerCase()
      const entryType = entryMime.get(extension)
      // The selected page is the only HTML capability. A page may
      // load its static images/styles/scripts, not browse neighboring reports.
      const mime = samePath(target, file.absolutePath) ? entryType :
        ASSET_MIME.get(extension) ?? (entryType?.startsWith('image/') ? entryType : undefined)
      if (!mime) { reply(response, 404, 'Formato não disponível nesta prévia.'); return }
      const selectedPath = relative(file.rootPath, target).split(sep).join('/')
      const validated = resolver.resolve(file.rootPath, selectedPath, selectedPath)
      if (!validated.ok || !samePath(validated.file.rootRealPath, file.rootRealPath)) {
        reply(response, 404, 'Arquivo não disponível nesta prévia.'); return
      }
      if (this.activeReads >= (this.options.maxReads ?? GUI_ARTIFACT_PREVIEW_MAX_READS)) {
        reply(response, 503, 'Aguarde os arquivos terminarem de carregar e recarregue a prévia.'); return
      }
      this.activeReads += 1
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(validated.file.absolutePath, 'r')
        const stat = await handle.stat()
        // The pathname is revalidated AFTER opening. A replaced root or link
        // fails before reading from the handle, including a file-to-link race.
        const again = resolver.resolve(file.rootPath, selectedPath, selectedPath)
        if (!again.ok || !samePath(again.file.rootRealPath, file.rootRealPath) ||
          !samePath(again.file.absolutePath, validated.file.absolutePath) || !authorized()) {
          reply(response, 404, 'Arquivo não disponível nesta prévia.'); return
        }
        const namedHandle = await open(again.file.absolutePath, 'r')
        let namedStat
        try { namedStat = await namedHandle.stat() } finally { await namedHandle.close() }
        if (!stat.isFile() || !namedStat.isFile() || stat.dev !== namedStat.dev || stat.ino !== namedStat.ino) {
          reply(response, 404, 'Arquivo não disponível nesta prévia.'); return
        }
        if (stat.size > maxBytes) { reply(response, 413, 'Arquivo grande demais para esta prévia.'); return }
        const range = byteRange(request.headers.range, stat.size)
        if (range === false) {
          response.setHeader('Content-Range', `bytes */${stat.size}`)
          reply(response, 416, 'Trecho de arquivo inválido.'); return
        }
        response.setHeader('Content-Type', mime)
        response.setHeader('Content-Disposition', 'inline')
        response.setHeader('Cache-Control', 'no-store')
        response.setHeader('Referrer-Policy', 'no-referrer')
        response.setHeader('X-Content-Type-Options', 'nosniff')
        response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
        response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
        response.setHeader('Accept-Ranges', 'bytes')
        if (extension === '.html' || extension === '.htm' || extension === '.xhtml' || extension === '.svg') {
          response.setHeader('Content-Security-Policy', DOCUMENT_CSP)
        }
        const length = range ? range.end - range.start + 1 : stat.size
        response.setHeader('Content-Length', length)
        if (range) response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`)
        response.statusCode = range ? 206 : 200
        refresh()
        if (request.method === 'HEAD' || length === 0) { response.end(); return }
        await pipeline(handle.createReadStream({ autoClose: false, start: range?.start ?? 0,
          end: range?.end ?? stat.size - 1 }), response)
      } catch {
        if (!response.headersSent) reply(response, 404, 'Arquivo não disponível nesta prévia.')
        else response.destroy()
      } finally {
        await handle?.close().catch(() => {})
        this.activeReads -= 1
      }
    }
    server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
      void serve(request, response).catch(() => {
        if (!response.headersSent) reply(response, 500, 'Não foi possível abrir a prévia.')
        else response.destroy()
      })
    })
    server.maxConnections = 16
    server.headersTimeout = 5000
    server.requestTimeout = 15000
    server.keepAliveTimeout = 1000
    server.on('clientError', (_error, socket) => socket.destroy())
    this.leases.add(lease)
    try {
      await new Promise<void>((resolveReady, reject) => {
        const onError = (error: Error): void => reject(error)
        server.once('error', onError)
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolveReady() })
      })
      server.on('error', () => lease.close())
      server.unref()
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('preview bind unavailable')
      host = `127.0.0.1:${address.port}`
      lease.url = `http://${host}${GUI_ARTIFACT_PREVIEW_PREFIX}${token}/${encodeURIComponent(basename(file.absolutePath))}`
      refresh()
      return { ok: true, lease }
    } catch {
      lease.close()
      return { ok: false, error: 'não consegui iniciar a prévia local; tente abrir o arquivo novamente' }
    }
  }
}
