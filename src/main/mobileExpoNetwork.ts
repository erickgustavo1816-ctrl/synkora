import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { isAbsolute, join } from 'node:path'
import { mobileError } from './mobileCommands'
import { expoRealRoot } from './mobileExpoProject'
import { MobileProcessError } from './mobileProcess'

export interface MobileExpoResponse {
  status: number
  headers: Record<string, string | undefined>
  body: AsyncIterable<Uint8Array>
  close?(): void
}
export interface MobileExpoRequest { signal: AbortSignal; timeoutMs: number }
export type MobileExpoTransport = (url: URL, request: MobileExpoRequest) => Promise<MobileExpoResponse>
const MAX_APK_BYTES = 350 * 1024 * 1024
const APK_TIMEOUT_MS = 180_000
const VERSION_METADATA_URL = 'https://exp.host/--/api/v2/versions'
const cancelled = (signal: AbortSignal): void => { if (signal.aborted) throw new MobileProcessError('cancelled') }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

/** GET only; no cookies, authorization, environment proxy or redirect behavior is inherited. */
export const expoTransport: MobileExpoTransport = (url, options) => new Promise((resolve, reject) => {
  if (options.signal.aborted) { reject(new MobileProcessError('cancelled')); return }
  const request = (url.protocol === 'https:' ? httpsGet : httpGet)(url, { agent: false, signal: options.signal,
    headers: { 'User-Agent': 'Synkora-Mobile-Expo', Accept: 'application/json, application/octet-stream, text/plain' } }, response => {
    response.once('close', () => clearTimeout(timer))
    resolve({ status: response.statusCode ?? 0, headers: Object.fromEntries(Object.entries(response.headers)
      .map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value])), body: response, close: () => response.destroy() })
  })
  const timer = setTimeout(() => request.destroy(new MobileProcessError('timeout')), Math.max(1, options.timeoutMs))
  request.once('error', () => { clearTimeout(timer); reject(new MobileProcessError(options.signal.aborted ? 'cancelled' : 'failed')) })
})

function validHttps(url: URL): boolean {
  return url.protocol === 'https:' && (!url.port || url.port === '443') && !url.username && !url.password && !url.hash
}
export function expoDownloadUrlAllowed(url: URL, redirected: boolean): boolean {
  if (!validHttps(url)) return false
  if (url.hostname === 'github.com') return !url.search && /^\/expo\/expo-go-releases\/releases\/download\/Expo-Go-\d{1,3}\.\d{1,4}\.\d{1,4}(?:-[A-Za-z0-9.-]{1,80})?\/Expo-Go-\d{1,3}\.\d{1,4}\.\d{1,4}(?:-[A-Za-z0-9.-]{1,80})?\.apk$/u.test(url.pathname)
  if (url.hostname === 'd1ahtucjixef4r.cloudfront.net') return !url.search && /^\/Exponent-\d{1,3}\.\d{1,4}\.\d{1,4}\.apk$/u.test(url.pathname)
  // This host is GitHub's signed release-asset CDN, accepted only after an official release URL.
  return redirected && url.hostname === 'release-assets.githubusercontent.com' && /^\/github-production-release-asset\/[0-9]+\/[A-Za-z0-9-]+$/u.test(url.pathname)
}
function contentLength(response: MobileExpoResponse, maxBytes: number): void {
  const value = response.headers['content-length']
  if (value !== undefined && (!/^\d{1,12}$/u.test(value) || Number(value) > maxBytes)) {
    response.close?.(); mobileError('O download excede o limite permitido. Confira a versão do Expo Go e tente novamente pelo painel Mobile.')
  }
}
async function permittedResponse(url: URL, allowed: (url: URL, redirected: boolean) => boolean, options: {
  transport: MobileExpoTransport; signal: AbortSignal; timeoutMs: number; maxBytes: number
}): Promise<MobileExpoResponse> {
  const deadline = Date.now() + options.timeoutMs
  for (let redirects = 0; redirects <= 4; redirects++) {
    cancelled(options.signal)
    if (!allowed(url, redirects > 0)) mobileError('A origem do download do Expo Go não foi validada. Use Instalar Expo Go novamente após conferir o SDK do projeto.')
    if (Date.now() >= deadline) throw new MobileProcessError('timeout')
    const response = await options.transport(url, { signal: options.signal, timeoutMs: deadline - Date.now() })
    try { cancelled(options.signal) } catch (error) { response.close?.(); throw error }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location; response.close?.()
      if (!location || location.length > 4096) throw new MobileProcessError('failed')
      try { url = new URL(location, url) } catch { throw new MobileProcessError('failed') }
      continue
    }
    if (response.status !== 200) { response.close?.(); throw new MobileProcessError('failed') }
    contentLength(response, options.maxBytes)
    return response
  }
  throw new MobileProcessError('limit')
}
async function bytes(response: MobileExpoResponse, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0
  try {
    for await (const chunk of response.body) {
      cancelled(signal); size += chunk.byteLength
      if (size > maxBytes) throw new MobileProcessError('limit')
      chunks.push(Buffer.from(chunk))
    }
    cancelled(signal); return Buffer.concat(chunks, size)
  } finally { response.close?.() }
}
async function jsonMetadata(url: URL, options: { transport: MobileExpoTransport; signal: AbortSignal }): Promise<unknown> {
  const initial = url.href
  const response = await permittedResponse(url, candidate => candidate.href === initial && validHttps(candidate),
    { ...options, timeoutMs: 15_000, maxBytes: 1024 * 1024 })
  try { return JSON.parse((await bytes(response, 1024 * 1024, options.signal)).toString('utf8')) as unknown }
  catch (error) { if (options.signal.aborted) throw error; throw new MobileProcessError('failed') }
}
export function validateExpoOpenResponse(value: unknown, address: string, port: number): boolean {
  if (!object(value) || value.runtime !== 'expo' || typeof value.url !== 'string' || value.url.length > 2048) return false
  try {
    const url = new URL(value.url)
    return url.protocol === 'exp:' && url.hostname === address && url.port === String(port) && !url.username && !url.password &&
      !url.search && !url.hash && (url.pathname === '' || url.pathname === '/')
  } catch { return false }
}

/** Both requests stay on this exact local port; stdout is never considered a readiness signal. */
export async function probeExpoServer(port: number, address: string, signal: AbortSignal, transport: MobileExpoTransport = expoTransport): Promise<boolean> {
  const origin = `http://127.0.0.1:${port}`
  let statusReady = false
  try {
    const response = await transport(new URL(`${origin}/status`), { signal, timeoutMs: 1500 })
    contentLength(response, 4096)
    statusReady = response.status === 200 && (await bytes(response, 4096, signal)).toString('utf8').trim() === 'packager-status:running'
    if (!statusReady) response.close?.()
  } catch (error) { cancelled(signal); if (error instanceof MobileProcessError && error.reason === 'limit') throw error }
  if (!statusReady) return false
  let response: MobileExpoResponse
  try { response = await transport(new URL(`${origin}/_expo/open?platform=android&runtime=expo`), { signal, timeoutMs: 1500 }) }
  catch { cancelled(signal); return false }
  // Older supported CLIs expose /status but predate the introspection endpoint.
  if (response.status === 404) { response.close?.(); return true }
  if (response.status !== 200) { response.close?.(); return false }
  contentLength(response, 16 * 1024)
  let value: unknown
  try { value = JSON.parse((await bytes(response, 16 * 1024, signal)).toString('utf8')) }
  catch { return mobileError('O CLI Expo retornou um endpoint inválido. Pare e reinicie Expo pelo painel Mobile.') }
  if (!validateExpoOpenResponse(value, address, port)) mobileError('O link informado pelo CLI Expo não corresponde à rede e à porta desta missão. Pare e reinicie Expo pelo painel Mobile.')
  return true
}

interface ExpoAsset { url: URL; digest?: string; size?: number }
function sha256(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/iu.test(value)) mobileError('O checksum oficial do Expo Go é inválido. Tente Instalar Expo Go novamente mais tarde.')
  return value.replace(/^sha256:/iu, '').toLowerCase()
}
async function officialAsset(sdkVersion: string, options: { transport: MobileExpoTransport; signal: AbortSignal }): Promise<ExpoAsset> {
  if (!/^\d{1,3}\.0\.0$/u.test(sdkVersion)) mobileError('Não foi possível identificar o SDK Expo instalado. Instale as dependências do projeto e reinicie Expo.')
  const metadata = await jsonMetadata(new URL(VERSION_METADATA_URL), options)
  const versions = object(metadata) ? metadata.sdkVersions : undefined
  const sdk = object(versions) ? versions[sdkVersion] : undefined
  if (!object(sdk) || typeof sdk.androidClientUrl !== 'string' || sdk.androidClientUrl.length > 2048) mobileError('Não há APK oficial de Expo Go para este SDK. Confira a versão do projeto ou use um development build local.')
  let url: URL
  try { url = new URL(sdk.androidClientUrl) } catch { throw new MobileProcessError('failed') }
  if (!expoDownloadUrlAllowed(url, false)) mobileError('Os metadados oficiais indicaram uma origem não permitida para o APK. Tente Instalar Expo Go novamente mais tarde.')
  const declaredDigest = sha256(sdk.androidClientSha256)
  if (url.hostname !== 'github.com') return { url, digest: declaredDigest }
  const parts = url.pathname.split('/'), tag = parts[5], assetName = parts[6]
  const release = await jsonMetadata(new URL(`https://api.github.com/repos/expo/expo-go-releases/releases/tags/${tag}`), options)
  const assets = object(release) && Array.isArray(release.assets) ? release.assets : []
  const matching = assets.filter(asset => object(asset) && asset.name === assetName && asset.browser_download_url === url.href)
  if (matching.length !== 1 || !object(matching[0])) mobileError('Não foi possível confirmar o APK no release oficial do Expo Go. Tente instalar novamente mais tarde.')
  const asset = matching[0], digest = sha256(asset.digest)
  if (declaredDigest && digest && declaredDigest !== digest) mobileError('Os checksums oficiais do Expo Go divergem. Aguarde a correção do release e tente novamente.')
  if (!Number.isSafeInteger(asset.size) || Number(asset.size) < 4 || Number(asset.size) > MAX_APK_BYTES) mobileError('O tamanho oficial do APK não é suportado. Confira o SDK e tente novamente.')
  return { url, digest: digest ?? declaredDigest, size: Number(asset.size) }
}
async function cachedDigest(path: string, expected: string, expectedSize: number | undefined, signal: AbortSignal): Promise<boolean> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_APK_BYTES || (expectedSize !== undefined && stat.size !== expectedSize)) return false
    const hash = createHash('sha256'); let size = 0
    for await (const chunk of createReadStream(path, { signal })) {
      cancelled(signal); size += (chunk as Buffer).length
      if (size > MAX_APK_BYTES) return false
      hash.update(chunk as Buffer)
    }
    return hash.digest('hex') === expected
  } catch { cancelled(signal); return false }
}

/** This API accepts an installed SDK version, never a caller-supplied URL or filename. */
export async function downloadExpoGo(sdkVersion: string, cacheRoot: string, input: { signal: AbortSignal; transport?: MobileExpoTransport }): Promise<string> {
  if (!isAbsolute(cacheRoot)) mobileError('Configure o cache privado do Expo Go nas preferências do aplicativo e tente novamente.')
  const abort = new AbortController(), cancel = (): void => abort.abort()
  input.signal.addEventListener('abort', cancel, { once: true })
  if (input.signal.aborted) abort.abort()
  const timer = setTimeout(cancel, APK_TIMEOUT_MS), options = { signal: abort.signal, transport: input.transport ?? expoTransport }
  let partial: string | undefined
  try {
    const asset = await officialAsset(sdkVersion, options); cancelled(options.signal)
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
    const root = await expoRealRoot(cacheRoot)
    const expectedName = asset.digest ? `expo-go-${sdkVersion}-${asset.digest}.apk` : undefined
    if (expectedName && await cachedDigest(join(root, expectedName), asset.digest!, asset.size, options.signal)) return expectedName
    const response = await permittedResponse(asset.url, expoDownloadUrlAllowed, { ...options, timeoutMs: APK_TIMEOUT_MS, maxBytes: MAX_APK_BYTES })
    const candidate = join(root, `expo-go-${randomUUID()}.partial`)
    let file: Awaited<ReturnType<typeof open>>
    try { file = await open(candidate, 'wx', 0o600); partial = candidate }
    catch (error) { response.close?.(); throw error }
    const hash = createHash('sha256')
    let size = 0, signature = Buffer.alloc(0)
    try {
      for await (const chunk of response.body) {
        cancelled(options.signal); size += chunk.byteLength
        if (size > MAX_APK_BYTES || (asset.size !== undefined && size > asset.size)) throw new MobileProcessError('limit')
        if (signature.length < 4) signature = Buffer.concat([signature, Buffer.from(chunk).subarray(0, 4 - signature.length)])
        hash.update(chunk)
        // FileHandle.write may perform a partial write; retry until this bounded chunk is persisted.
        let offset = 0
        while (offset < chunk.byteLength) {
          cancelled(options.signal)
          const written = await file.write(chunk, offset, chunk.byteLength - offset)
          if (!written.bytesWritten) throw new MobileProcessError('failed')
          offset += written.bytesWritten
        }
      }
    } finally { response.close?.(); await file.close() }
    cancelled(options.signal)
    const actualDigest = hash.digest('hex')
    if (!signature.equals(Buffer.from([80, 75, 3, 4])) || (asset.size !== undefined && asset.size !== size) || (asset.digest && asset.digest !== actualDigest)) {
      mobileError('A integridade do APK baixado não foi confirmada. Use Instalar Expo Go para tentar um novo download oficial.')
    }
    // Canonical root is revalidated before making the complete artifact visible to the runtime.
    if (await realpath(cacheRoot) !== root) throw new MobileProcessError('cancelled')
    const name = `expo-go-${sdkVersion}-${actualDigest}.apk`, target = join(root, name)
    try { if ((await lstat(target)).isSymbolicLink()) throw new MobileProcessError('failed') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await rename(partial, target); partial = undefined
    return name
  } finally {
    clearTimeout(timer); input.signal.removeEventListener('abort', cancel)
    if (partial) await unlink(partial).catch(() => {})
  }
}
