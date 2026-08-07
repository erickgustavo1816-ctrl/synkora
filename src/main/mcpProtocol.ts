import { execFile } from 'child_process'
import { resolve } from 'path'
import { freshWindowsPath } from './winPath'

export const CODEX_MCP_2026_FEATURE = 'mcp_2026_07_28'
export const CODEX_MCP_2026_MIN_VERSION = '0.147.0-alpha.1'
export const CODEX_MCP_PROTOCOL_CACHE_TTL_MS = 10 * 60_000

const DEFAULT_PROBE_TIMEOUT_MS = 15_000
const MAX_PROBE_OUTPUT_BYTES = 256 * 1024

export type CodexMcpProtocolMode = 'auto' | 'legacy' | 'modern-experimental'
export type CodexMcpEffectiveProtocol = 'legacy' | 'modern'
export type CodexMcpProbeReason =
  | 'ready'
  | 'codex-unavailable'
  | 'version-unrecognized'
  | 'version-too-old'
  | 'features-unavailable'
  | 'feature-missing'
  | 'feature-output-invalid'

export interface CodexProbeCommand {
  command: 'codex'
  args: string[]
  env: Record<string, string>
  timeoutMs: number
  windowsHide: true
}

export interface CodexProbeCommandResult {
  ok: boolean
  /** Kept only for parsing inside the probe; never copied to status. */
  output: string
}

export type CodexProbeRunner = (
  command: CodexProbeCommand
) => Promise<CodexProbeCommandResult>

export interface CodexMcpProtocolProbe {
  checkedAt: number
  version: string | null
  featurePresent: boolean
  featureEnabled: boolean | null
  capability: boolean
  reason: CodexMcpProbeReason
}

export interface CodexMcpProtocolDecision {
  requestedMode: CodexMcpProtocolMode
  effectiveProtocol: CodexMcpEffectiveProtocol
  args: string[]
  probe: CodexMcpProtocolProbe
}

export interface CodexMcpProtocolStatus {
  state: 'idle' | 'probing' | 'ready' | 'expired'
  checkedAt: number | null
  expiresAt: number | null
  version: string | null
  featurePresent: boolean
  featureEnabled: boolean | null
  capability: boolean
  reason?: CodexMcpProbeReason
}

export interface CodexMcpProtocolDetectorOptions {
  runner?: CodexProbeRunner
  now?: () => number
  timeoutMs?: number
  ttlMs?: number
}

interface Semver {
  raw: string
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

interface FeatureResult {
  present: boolean
  enabled: boolean | null
  valid: boolean
}

interface CacheEntry {
  value?: CodexMcpProtocolProbe
  expiresAt: number
  inFlight?: Promise<CodexMcpProtocolProbe>
}

function defaultRunner(command: CodexProbeCommand): Promise<CodexProbeCommandResult> {
  return new Promise((resolveResult) => {
    execFile(
      command.command,
      command.args,
      {
        env: command.env,
        encoding: 'utf-8',
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        shell: process.platform === 'win32',
        timeout: command.timeoutMs,
        windowsHide: command.windowsHide
      },
      (error, stdout, stderr) => {
        resolveResult({
          ok: !error,
          output: `${stdout ?? ''}\n${stderr ?? ''}`.slice(0, MAX_PROBE_OUTPUT_BYTES)
        })
      }
    )
  })
}

function parseSemver(raw: string): Semver | null {
  const match = raw.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
  )
  if (!match) return null
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some((part) => !part || (/^\d+$/.test(part) && part.length > 1 && part[0] === '0'))) {
    return null
  }
  return {
    raw,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease
  }
}

function versionFromOutput(output: string): Semver | null {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(
      /^\s*codex(?:-cli)?\s+v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\s*$/i
    )
    if (match) return parseSemver(match[1])
  }
  return null
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0
    return left.length === 0 ? 1 : -1
  }
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined || b === undefined) {
      if (a === b) return 0
      return a === undefined ? -1 : 1
    }
    if (a === b) continue
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return a < b ? -1 : 1
  }
  return 0
}

function semverAtLeast(actual: Semver, minimum: Semver): boolean {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (actual[key] !== minimum[key]) return actual[key] > minimum[key]
  }
  return comparePrerelease(actual.prerelease, minimum.prerelease) >= 0
}

function featureFromOutput(output: string): FeatureResult {
  const matching = output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((tokens) => tokens[0] === CODEX_MCP_2026_FEATURE)
  if (matching.length === 0) return { present: false, enabled: null, valid: false }
  if (matching.length !== 1) return { present: true, enabled: null, valid: false }
  const enabledToken = matching[0][matching[0].length - 1]
  if (enabledToken !== 'true' && enabledToken !== 'false') {
    return { present: true, enabled: null, valid: false }
  }
  return { present: true, enabled: enabledToken === 'true', valid: true }
}

function cacheKey(configDir?: string): string {
  if (!configDir) return '<default>'
  const normalized = resolve(configDir)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function emptyStatus(state: CodexMcpProtocolStatus['state']): CodexMcpProtocolStatus {
  return {
    state,
    checkedAt: null,
    expiresAt: null,
    version: null,
    featurePresent: false,
    featureEnabled: null,
    capability: false
  }
}

/** Pure mode policy. Unknown or unsupported capability always stays legacy. */
export function codexMcpProtocolDecision(
  requestedMode: CodexMcpProtocolMode,
  probe: CodexMcpProtocolProbe
): CodexMcpProtocolDecision {
  const modern = requestedMode === 'modern-experimental'
    ? probe.capability
    : requestedMode === 'auto' && probe.capability && probe.featureEnabled === true
  const args = modern
    ? requestedMode === 'modern-experimental'
      ? ['--enable', CODEX_MCP_2026_FEATURE]
      : []
    : probe.capability
      ? ['--disable', CODEX_MCP_2026_FEATURE]
      : []
  return {
    requestedMode,
    effectiveProtocol: modern ? 'modern' : 'legacy',
    args,
    probe
  }
}

export function codexMcpProtocolArgs(
  requestedMode: CodexMcpProtocolMode,
  probe: CodexMcpProtocolProbe
): string[] {
  return [...codexMcpProtocolDecision(requestedMode, probe).args]
}

export class CodexMcpProtocolDetector {
  private readonly runner: CodexProbeRunner
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly ttlMs: number
  private readonly cache = new Map<string, CacheEntry>()

  constructor(options: CodexMcpProtocolDetectorOptions = {}) {
    this.runner = options.runner ?? defaultRunner
    this.now = options.now ?? Date.now
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
    this.ttlMs = Math.max(1_000, options.ttlMs ?? CODEX_MCP_PROTOCOL_CACHE_TTL_MS)
  }

  probe(configDir?: string): Promise<CodexMcpProtocolProbe> {
    const key = cacheKey(configDir)
    const existing = this.cache.get(key)
    const now = this.now()
    if (existing?.value && now < existing.expiresAt) return Promise.resolve(existing.value)
    if (existing?.inFlight) return existing.inFlight

    const entry: CacheEntry = { expiresAt: 0 }
    const inFlight = this.probeUncached(configDir).then((value) => {
      if (this.cache.get(key) === entry) {
        entry.value = value
        entry.expiresAt = value.checkedAt + this.ttlMs
        entry.inFlight = undefined
      }
      return value
    })
    entry.inFlight = inFlight
    this.cache.set(key, entry)
    return inFlight
  }

  async decision(
    requestedMode: CodexMcpProtocolMode,
    configDir?: string
  ): Promise<CodexMcpProtocolDecision> {
    return codexMcpProtocolDecision(requestedMode, await this.probe(configDir))
  }

  prewarm(configDir?: string): Promise<CodexMcpProtocolProbe> {
    return this.probe(configDir)
  }

  /** With no configDir, invalidates every seat/default probe. */
  invalidate(configDir?: string): void {
    if (configDir === undefined) this.cache.clear()
    else this.cache.delete(cacheKey(configDir))
  }

  /** No config path, command output, environment or subprocess error is exposed. */
  status(configDir?: string): CodexMcpProtocolStatus {
    const entry = this.cache.get(cacheKey(configDir))
    if (!entry) return emptyStatus('idle')
    if (entry.inFlight) return emptyStatus('probing')
    if (!entry.value) return emptyStatus('idle')
    return {
      state: this.now() < entry.expiresAt ? 'ready' : 'expired',
      checkedAt: entry.value.checkedAt,
      expiresAt: entry.expiresAt,
      version: entry.value.version,
      featurePresent: entry.value.featurePresent,
      featureEnabled: entry.value.featureEnabled,
      capability: entry.value.capability,
      reason: entry.value.reason
    }
  }

  private async probeUncached(configDir?: string): Promise<CodexMcpProtocolProbe> {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: freshWindowsPath()
    }
    if (configDir) env['CODEX_HOME'] = configDir
    const run = (args: string[]): Promise<CodexProbeCommandResult> =>
      this.runner({
        command: 'codex',
        args,
        env: { ...env },
        timeoutMs: this.timeoutMs,
        windowsHide: true
      }).catch(() => ({ ok: false, output: '' }))
    const [versionCommand, featuresCommand] = await Promise.all([
      run(['--version']),
      run(['features', 'list'])
    ])
    const checkedAt = this.now()
    const version = versionCommand.ok ? versionFromOutput(versionCommand.output) : null
    const feature = featuresCommand.ok
      ? featureFromOutput(featuresCommand.output)
      : { present: false, enabled: null, valid: false }
    const minimum = parseSemver(CODEX_MCP_2026_MIN_VERSION)!
    const versionCompatible = version ? semverAtLeast(version, minimum) : false
    const capability = Boolean(versionCompatible && feature.present && feature.valid)
    let reason: CodexMcpProbeReason = 'ready'
    if (!versionCommand.ok) reason = 'codex-unavailable'
    else if (!version) reason = 'version-unrecognized'
    else if (!featuresCommand.ok) reason = 'features-unavailable'
    else if (!versionCompatible) reason = 'version-too-old'
    else if (!feature.present) reason = 'feature-missing'
    else if (!feature.valid) reason = 'feature-output-invalid'
    return {
      checkedAt,
      version: version?.raw ?? null,
      featurePresent: feature.present,
      featureEnabled: feature.enabled,
      capability,
      reason
    }
  }
}

const defaultDetector = new CodexMcpProtocolDetector()

export function resolveCodexMcpProtocol(
  requestedMode: CodexMcpProtocolMode,
  configDir?: string
): Promise<CodexMcpProtocolDecision> {
  return defaultDetector.decision(requestedMode, configDir)
}

export function prewarmCodexMcpProtocol(configDir?: string): Promise<CodexMcpProtocolProbe> {
  return defaultDetector.prewarm(configDir)
}

export function invalidateCodexMcpProtocol(configDir?: string): void {
  defaultDetector.invalidate(configDir)
}

export function getCodexMcpProtocolStatus(configDir?: string): CodexMcpProtocolStatus {
  return defaultDetector.status(configDir)
}
