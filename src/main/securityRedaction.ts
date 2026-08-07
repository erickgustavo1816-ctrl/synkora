/**
 * Redaction and child-process environment boundaries shared by every local
 * persistence surface. This module deliberately has no Electron dependency so
 * it can be exercised by small, deterministic tests.
 */

const MARKER_PREFIX = '[redigido:'

export type RedactionKind =
  | 'campo'
  | 'autorizacao'
  | 'cookie'
  | 'credencial-url'
  | 'jwt'
  | 'chave-privada'
  | 'token'

export function redactionMarker(kind: RedactionKind): string {
  return `${MARKER_PREFIX}${kind}]`
}

function normalizedKeyParts(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .split('_')
    .filter(Boolean)
}

const SENSITIVE_SINGLE_KEY_PARTS = new Set([
  'authorization',
  'bearer',
  'cookie',
  'credential',
  'credentials',
  'jwt',
  'passwd',
  'password',
  'secret',
  'token'
])

/** Key-name matching is segment based, so innocent names such as `monkey` or
 * `tokenizer` are not hidden while apiKey/github_token/private-key are. */
export function isSensitiveKey(key: string): boolean {
  const parts = normalizedKeyParts(key)
  if (parts.some((part) => SENSITIVE_SINGLE_KEY_PARTS.has(part))) return true
  const has = (part: string): boolean => parts.includes(part)
  const providerKey =
    has('key') &&
    parts.some((part) =>
      ['anthropic', 'aws', 'azure', 'github', 'google', 'openai', 'openrouter', 'stripe'].includes(
        part
      )
    )
  return (
    providerKey ||
    (has('api') && has('key')) ||
    (has('access') && has('key')) ||
    (has('private') && has('key')) ||
    (has('client') && has('secret')) ||
    (has('webhook') && has('secret')) ||
    (has('session') && (has('id') || has('key') || has('token') || has('cookie'))) ||
    (has('auth') && (has('header') || has('token') || has('value'))) ||
    ((has('encryption') || has('signing')) && has('key')) ||
    (has('connection') && has('string')) ||
    ((has('database') || has('redis') || has('mongo') || has('mongodb')) &&
      (has('url') || has('uri')))
  )
}

const PRIVATE_KEY_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/gi
const URL_CREDENTIAL_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@\x1b]+)@/gi
const AUTH_HEADER_RE =
  /(^|[\r\n])(\s*(?:proxy-)?authorization\s*:\s*)[^\r\n\x1b]+/gi
const COOKIE_HEADER_RE = /(^|[\r\n])(\s*(?:set-)?cookie\s*:\s*)[^\r\n\x1b]+/gi
const BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi
const BASIC_RE = /\bbasic\s+[A-Za-z0-9+/]{12,}={0,2}/gi
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*(?![A-Za-z0-9_-])/g

const COMMON_TOKEN_PATTERNS: readonly RegExp[] = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bdckr_pat_[A-Za-z0-9_-]{20,}\b/g,
  /\bdop_v1_[A-Fa-f0-9]{32,}\b/g,
  /\bhf_[A-Za-z0-9]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bpypi-[A-Za-z0-9_-]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bwhsec_[A-Za-z0-9]{20,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bSG\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{20,}\b/g
]

const NAMED_SECRET =
  '(?:(?:[a-z][a-z0-9]*[-_ ]*)?(?:token|secret|password|passwd)|' +
  'api[-_ ]?key|access[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|session[-_ ]?token|' +
  'client[-_ ]?secret|webhook[-_ ]?secret|private[-_ ]?key|password|passwd|' +
  'authorization|cookie|github[-_ ]?token|openrouter[-_ ]?key|' +
  'openai[-_ ]?api[-_ ]?key|database[-_ ]?url|connection[-_ ]?string)'
const NAMED_ASSIGNMENT_RE = new RegExp(
  `(["']?${NAMED_SECRET}["']?\\s*[:=]\\s*)(?!\\[redigido:)(?:"[^"\\r\\n\\x1b]*"|'[^'\\r\\n\\x1b]*'|[^\\s,;&\\x1b]+)`,
  'gi'
)
const NAMED_FLAG_RE = new RegExp(
  `(\\-\\-${NAMED_SECRET}(?:=|\\s+))(?!\\[redigido:)(?:"[^"\\r\\n\\x1b]*"|'[^'\\r\\n\\x1b]*'|[^\\s,;&\\x1b]+)`,
  'gi'
)

/**
 * Removes values while keeping enough shape to diagnose what kind of datum was
 * hidden. It is idempotent and never returns the original secret as part of the
 * marker.
 */
export function redactSensitiveText(input: string): string {
  if (!input) return input
  let value = input.replace(PRIVATE_KEY_RE, redactionMarker('chave-privada'))
  value = value.replace(
    URL_CREDENTIAL_RE,
    (_match, scheme: string) => `${scheme}${redactionMarker('credencial-url')}@`
  )
  value = value.replace(
    AUTH_HEADER_RE,
    (_match, lineStart: string, header: string) =>
      `${lineStart}${header}${redactionMarker('autorizacao')}`
  )
  value = value.replace(
    COOKIE_HEADER_RE,
    (_match, lineStart: string, header: string) =>
      `${lineStart}${header}${redactionMarker('cookie')}`
  )
  value = value.replace(BEARER_RE, redactionMarker('autorizacao'))
  value = value.replace(BASIC_RE, redactionMarker('autorizacao'))
  value = value.replace(JWT_RE, redactionMarker('jwt'))
  for (const pattern of COMMON_TOKEN_PATTERNS) {
    value = value.replace(pattern, redactionMarker('token'))
  }
  value = value.replace(
    NAMED_ASSIGNMENT_RE,
    (_match, prefix: string) => `${prefix}${redactionMarker('campo')}`
  )
  value = value.replace(
    NAMED_FLAG_RE,
    (_match, prefix: string) => `${prefix}${redactionMarker('campo')}`
  )
  return value
}

type StreamingCandidateKind = 'line' | 'private-key'

interface StreamingCandidate {
  index: number
  kind: StreamingCandidateKind
}

const STREAM_TOKEN_CANDIDATES: readonly RegExp[] = [
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]*$/i,
  /\bgithub_pat_[A-Za-z0-9_]*$/i,
  /\bgh[pousr]_[A-Za-z0-9]*$/i,
  /\bglpat-[A-Za-z0-9_-]*$/i,
  /\bdckr_pat_[A-Za-z0-9_-]*$/i,
  /\bdop_v1_[A-Fa-f0-9]*$/i,
  /\b(?:hf_|npm_|pypi-|xox[baprs]-|sk-ant-|sk-(?:proj-)?|whsec_)[A-Za-z0-9_-]*$/i,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]*$/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]*$/,
  /\bAIza[0-9A-Za-z_-]*$/,
  /\bSG\.[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*)?$/,
  /\beyJ[A-Za-z0-9_.-]*$/
]

const STREAM_NAMED_ASSIGNMENT_RE = new RegExp(
  `(?:["']?${NAMED_SECRET}["']?\\s*[:=]\\s*)(?:"[^"\\r\\n]*|'[^'\\r\\n]*|[^\\s,;&]*)$`,
  'i'
)
const STREAM_NAMED_FLAG_RE = new RegExp(
  `\\-\\-${NAMED_SECRET}(?:=|\\s+)(?:"[^"\\r\\n]*|'[^'\\r\\n]*|[^\\s,;&]*)$`,
  'i'
)

function streamingCandidate(input: string): StreamingCandidate | undefined {
  let best: StreamingCandidate | undefined
  const consider = (match: RegExpExecArray | null, kind: StreamingCandidateKind): void => {
    if (!match) return
    // JavaScript `$` also matches immediately before a final newline. A newline
    // is the delimiter we were waiting for, so only retain a match that reaches
    // the true end of the current buffer.
    if (match.index + match[0].length !== input.length) return
    const candidate = { index: match.index, kind }
    if (!best || candidate.index < best.index) best = candidate
  }

  const privateStart = input.search(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/i)
  if (privateStart >= 0) {
    const tail = input.slice(privateStart)
    if (!/-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/i.test(tail)) {
      best = { index: privateStart, kind: 'private-key' }
    }
  }

  consider(/\b(?:proxy-)?authorization\s*:\s*[^\r\n]*$/i.exec(input), 'line')
  consider(/\b(?:set-)?cookie\s*:\s*[^\r\n]*$/i.exec(input), 'line')
  // Uma URL comum no fim do chunk deve aparecer imediatamente (login e links
  // dependem disso). Só seguramos authority com `:`: é quando um user:password
  // pode estar chegando dividido antes do `@`.
  consider(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]*$/i.exec(input), 'line')
  consider(STREAM_NAMED_ASSIGNMENT_RE.exec(input), 'line')
  consider(STREAM_NAMED_FLAG_RE.exec(input), 'line')
  for (const pattern of STREAM_TOKEN_CANDIDATES) consider(pattern.exec(input), 'line')
  return best
}

/**
 * Stateful redactor for the renderer boundary. Terminal output is arbitrarily
 * chunked, so redacting each chunk independently can expose a token split
 * between two writes. This class remembers only a short sanitized context and
 * withholds a candidate secret until its delimiter arrives. It never persists
 * the raw candidate.
 */
export class StreamingSensitiveRedactor {
  private context = ''
  private carry = ''
  private carryKind: StreamingCandidateKind | null = null
  private carryFromContext = false
  private dropping: StreamingCandidateKind | null = null
  private readonly maxCandidate = 64 * 1024
  private readonly contextLength = 160

  private remember(value: string): void {
    this.context = (this.context + value).slice(-this.contextLength)
  }

  push(input: string): string {
    if (!input) return ''
    if (this.dropping) {
      if (this.dropping === 'private-key') {
        const end = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/i.exec(input)
        if (!end) return ''
        this.dropping = null
        return this.push(input.slice(end.index + end[0].length))
      }
      const end = input.search(/[\r\n]/)
      if (end < 0) return ''
      this.dropping = null
      return this.push(input.slice(end))
    }

    if (this.carry && this.carryFromContext) {
      const combined = this.carry + input
      const end =
        this.carryKind === 'private-key'
          ? /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/i.exec(combined)
          : /[\r\n]/.exec(combined)
      if (!end) {
        if (combined.length > this.maxCandidate) {
          this.carry = ''
          this.carryFromContext = false
          this.dropping = this.carryKind ?? 'line'
          this.carryKind = null
          return redactionMarker(this.dropping === 'private-key' ? 'chave-privada' : 'token')
        }
        this.carry = combined
        return ''
      }
      const marker = redactionMarker(
        this.carryKind === 'private-key' ? 'chave-privada' : 'token'
      )
      const remainderStart = end.index + (this.carryKind === 'private-key' ? end[0].length : 0)
      const remainder = combined.slice(remainderStart)
      this.carry = ''
      this.carryKind = null
      this.carryFromContext = false
      return marker + this.push(remainder)
    }

    const hadCarry = this.carry.length > 0
    const prefix = hadCarry ? '' : this.context
    const combined = (hadCarry ? this.carry : prefix) + input
    const currentOffset = hadCarry ? 0 : prefix.length
    const candidate = streamingCandidate(combined)
    if (candidate) {
      const visibleStart = Math.max(currentOffset, candidate.index)
      const safeRaw = combined.slice(currentOffset, visibleStart)
      const safe = redactSensitiveText(safeRaw)
      this.carryFromContext = candidate.index < currentOffset
      this.carry = combined.slice(this.carryFromContext ? currentOffset : candidate.index)
      this.carryKind = candidate.kind
      this.remember(safe)
      if (this.carry.length > this.maxCandidate) {
        this.carry = ''
        this.carryKind = null
        this.carryFromContext = false
        this.dropping = candidate.kind
        return `${safe}${redactionMarker(candidate.kind === 'private-key' ? 'chave-privada' : 'token')}`
      }
      return safe
    }

    const raw = hadCarry ? combined : input
    this.carry = ''
    const previousKind = this.carryKind
    this.carryKind = null
    this.carryFromContext = false
    const safe = redactSensitiveText(raw)
    if (hadCarry && safe === raw) {
      // A candidate shorter than a provider's normal token length is still
      // secret-shaped at this boundary. Do not reveal it merely because the
      // process ended the line before reaching that provider-specific length.
      const newline = raw.search(/[\r\n]/)
      const remainder = newline >= 0 ? raw.slice(newline) : ''
      return `${redactionMarker(previousKind === 'private-key' ? 'chave-privada' : 'token')}${remainder}`
    }
    this.remember(safe)
    return safe
  }

  /** Drops an unterminated candidate instead of revealing it on process exit. */
  finish(): string {
    if (!this.carry && !this.dropping) return ''
    const kind = this.dropping ?? this.carryKind ?? streamingCandidate(this.carry)?.kind ?? 'line'
    this.carry = ''
    this.carryKind = null
    this.carryFromContext = false
    this.dropping = null
    return redactionMarker(kind === 'private-key' ? 'chave-privada' : 'token')
  }
}

export interface PersistedRedactionLimits {
  maxString?: number
  maxArray?: number
  maxDepth?: number
}

/** JSON-safe deep redaction used before local persistence or diagnostic export. */
export function redactPersistedValue(
  input: unknown,
  limits: PersistedRedactionLimits = {}
): unknown {
  const maxString = Math.max(32, limits.maxString ?? 600)
  const maxArray = Math.max(1, limits.maxArray ?? 20)
  const maxDepth = Math.max(1, limits.maxDepth ?? 5)
  const seen = new WeakSet<object>()

  const visit = (value: unknown, depth: number): unknown => {
    if (value === null || value === undefined) return value
    if (typeof value === 'string') {
      const redacted = redactSensitiveText(value)
      return redacted.length > maxString
        ? `${redacted.slice(0, maxString)}…[+${redacted.length - maxString}]`
        : redacted
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'bigint') return value.toString()
    if (typeof value !== 'object') return String(value)
    if (depth >= maxDepth) return '[profundidade]'
    if (seen.has(value)) return '[ciclo]'
    seen.add(value)
    try {
      if (Array.isArray(value)) {
        const head = value.slice(0, maxArray).map((item) => visit(item, depth + 1))
        return value.length > maxArray ? [...head, `…+${value.length - maxArray}`] : head
      }
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        out[key] = isSensitiveKey(key) ? redactionMarker('campo') : visit(item, depth + 1)
      }
      return out
    } finally {
      seen.delete(value)
    }
  }

  return visit(input, 0)
}

/**
 * Redige somente valores textuais de uma estrutura JSON sem truncar, remover
 * itens ou interpretar nomes de campos. É o formato adequado para stores de
 * domínio: preserva integralmente o contrato e troca apenas segredos concretos.
 */
export function redactSensitiveStrings<T>(input: T): T {
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return redactSensitiveText(value)
    if (Array.isArray(value)) return value.map(visit)
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]))
    }
    return value
  }
  return visit(input) as T
}

const SENSITIVE_ENVIRONMENT_EXACT = new Set([
  'aws_profile',
  'aws_default_profile',
  'docker_auth_config',
  'git_askpass',
  'github_token',
  'gh_token',
  'google_application_credentials',
  'gpg_agent_info',
  'kubeconfig',
  'netrc',
  'node_auth_token',
  'npm_token',
  'ssh_askpass',
  'ssh_auth_sock'
])

export function isSensitiveEnvironmentKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return SENSITIVE_ENVIRONMENT_EXACT.has(normalized) || isSensitiveKey(key)
}

/** True when passing a value unchanged would expose a recognizable credential. */
export function containsSensitiveValue(value: string): boolean {
  return redactSensitiveText(value) !== value
}

/**
 * Compatibility-first process boundary for interactive CLIs.
 *
 * A total allowlist proved too risky for login/network/toolchain compatibility
 * across Windows, macOS, Linux, enterprise proxies and custom shells. Instead,
 * inherited variables are denied by sensitive name or recognizable credential
 * value. Backend-generated `explicit` values are applied afterwards; callers
 * must only use them for scoped runtime data such as CODEX_HOME,
 * CLAUDE_CONFIG_DIR and the per-pane SYNKORA_TOKEN.
 */
export function sanitizedPaneEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  explicit: Readonly<Record<string, string>> = {}
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (typeof value !== 'string') continue
    if (isSensitiveEnvironmentKey(key) || containsSensitiveValue(value)) continue
    result[key] = value
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\u0000]/.test(value)) continue
    result[key] = value
  }
  return result
}
