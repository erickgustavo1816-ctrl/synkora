import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'

/**
 * Verificação proporcional da fotografia combinada de uma missão.
 *
 * Este módulo não conhece Electron, stores, missões nem Git. O chamador é
 * responsável por persistir o resultado e por confirmar que o HEAD verificado
 * continua sendo o atual antes de concluir/integrar. A separação deixa a
 * detecção, o runner e a comparação baseline/final testáveis sem subir o app.
 */

export type VerificationExecutionMode = 'fast' | 'standard' | 'deep'
export type VerificationRiskLevel = 'low' | 'medium' | 'high'
export type VerificationCommandKind = 'typecheck' | 'test' | 'lint' | 'build' | 'check'
type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export interface VerificationBudget {
  maxCommands: number
  perCommandTimeoutMs: number
  totalTimeoutMs: number
  maxOutputChars: number
}

export interface VerificationCommand {
  /** Identidade estável usada para comparar baseline e verificação final. */
  id: string
  kind: VerificationCommandKind
  label: string
  command: string
  args: string[]
  cwd: string
  source: string
  timeoutMs: number
  /** Motivo persistivel para um check declarado que nao pode ser executado com
   * seguranca. Ele continua no contrato e produz `unavailable`, nunca
   * `not_required`. */
  blockedReason?: string
  /** Prova da definição semântica (ex.: corpo + hooks transitivos do script). */
  definitionHash?: string
}

export interface DetectVerificationCommandsOptions {
  root: string
  mode: VerificationExecutionMode
  risk?: VerificationRiskLevel
  platform?: NodeJS.Platform
  /** Auditoria/revalidação pode pedir a lista completa; execução normal usa
   * o teto proporcional de verificationBudget. */
  maxCommands?: number
}

export type VerificationCommandStatus =
  | 'passed'
  | 'failed'
  | 'timed_out'
  | 'unavailable'
  | 'cancelled'

export interface VerificationCommandResult {
  commandId: string
  label: string
  status: VerificationCommandStatus
  exitCode: number | null
  signal: NodeJS.Signals | null
  durationMs: number
  stdoutTail: string
  stderrTail: string
  /** SHA-256 da saída normalizada + exit code. Ausente se nada foi executado. */
  signature?: string
}

export type VerificationBatchStatus = VerificationCommandStatus | 'not_required'

export interface VerificationBatchResult {
  status: VerificationBatchStatus
  startedAt: string
  finishedAt: string
  durationMs: number
  results: VerificationCommandResult[]
}

export interface RunVerificationOptions {
  totalTimeoutMs?: number
  maxOutputChars?: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  platform?: NodeJS.Platform
  /** Somente para testes ou runtimes com PATH controlado. */
  resolveEnv?: NodeJS.ProcessEnv
}

export interface ResolvedVerificationInvocation {
  command: string
  args: string[]
}

export interface ResolveVerificationInvocationOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

export type VerificationComparisonStatus =
  | 'passed'
  | 'passed_with_baseline_failures'
  | 'blocked'
  | 'not_required'

export interface VerificationComparisonItem {
  commandId: string
  label: string
  verdict: 'passed' | 'unchanged_failure' | 'blocked'
  detail: string
}

export interface VerificationComparison {
  status: VerificationComparisonStatus
  items: VerificationComparisonItem[]
}

export type PersistedVerificationStatus = 'pending' | 'running' | VerificationBatchStatus

export interface VerificationCheckpoint {
  status: PersistedVerificationStatus
  startedAt?: string
  finishedAt?: string
  interruptedAt?: string
  lastError?: string
}

interface RankedCommand {
  rank: number
  order: number
  command: Omit<VerificationCommand, 'timeoutMs'>
}

const SAFE_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/
const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g
const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})\b/g
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const MAX_NORMALIZED_SIGNATURE_CHARS = 1_000_000

const GO_CONTROL_ENVIRONMENT = new Set([
  'cgo_enabled',
  'cc',
  'cxx',
  'godebug',
  'goenv',
  'goflags',
  'goarch',
  'gomod',
  'gomodcache',
  'gonoproxy',
  'gonosumdb',
  'gopath',
  'goprivate',
  'goproxy',
  'goroot',
  'goos',
  'gosumdb',
  'gotmpdir',
  'gotoolchain',
  'gotraceback',
  'gowork'
])

/** Variaveis herdadas capazes de trocar binario, configuracao, alvo ou
 * semantica dos validadores suportados. */
function inheritedVerificationEnvironmentIsUnsafe(key: string): boolean {
  const normalized = key.toLowerCase()
  return (
    normalized === 'node_options' ||
    normalized === 'node_path' ||
    normalized === 'init_cwd' ||
    normalized === 'npm_execpath' ||
    normalized === 'npm_node_execpath' ||
    normalized === 'npm_command' ||
    normalized === 'npm_lifecycle_event' ||
    normalized === 'npm_lifecycle_script' ||
    normalized.startsWith('npm_config_') ||
    normalized.startsWith('yarn_') ||
    normalized.startsWith('pnpm_') ||
    normalized.startsWith('bun_') ||
    normalized.startsWith('corepack_') ||
    normalized.startsWith('python') ||
    normalized.startsWith('pytest_') ||
    normalized.startsWith('cargo_') ||
    normalized === 'rustc_wrapper' ||
    normalized === 'rustc_workspace_wrapper' ||
    normalized === 'rustflags' ||
    normalized === 'rustdocflags' ||
    normalized === 'rustc_bootstrap' ||
    normalized === 'rustup_toolchain' ||
    normalized === 'cargo_encoded_rustflags' ||
    GO_CONTROL_ENVIRONMENT.has(normalized) ||
    normalized === 'java_tool_options' ||
    normalized === 'jdk_java_options' ||
    normalized === '_java_options' ||
    normalized === 'classpath' ||
    normalized === 'java_opts' ||
    normalized.startsWith('maven_') ||
    normalized.startsWith('gradle_') ||
    normalized.startsWith('dotnet_') ||
    normalized.startsWith('msbuild')
  )
}

/** Dentro de um package script, PATH/COMSPEC e os modos CI tambem sao parte
 * da semantica do check e nao podem ser reescritos antes de um comando filho. */
function scriptVerificationEnvironmentIsUnsafe(key: string): boolean {
  const normalized = key.toLowerCase()
  return (
    inheritedVerificationEnvironmentIsUnsafe(normalized) ||
    normalized === 'path' ||
    normalized === 'pathext' ||
    normalized === 'comspec' ||
    normalized === 'systemroot' ||
    normalized === 'node_env' ||
    normalized === 'ci'
  )
}

const SCRIPT_ENVIRONMENT_MUTATIONS = [
  /(?:^|[\s;&|()])(?:export|readonly|declare|typeset|env)\s+["']?([A-Za-z_][A-Za-z0-9_]*)\s*\+?=/gi,
  /(?:^|[\s;&|()])(?:set|setx)\s+(?:["']\s*)?([A-Za-z_][A-Za-z0-9_]*)(?:\s+|\+?=)/gi,
  /(?:^|[\s;&|()])unset\s+([A-Za-z_][A-Za-z0-9_]*)\b/gi,
  /(?:^|[\s;&|()])([A-Za-z_][A-Za-z0-9_]*)\s*\+?=/gi,
  /\$env:([A-Za-z_][A-Za-z0-9_]*)\s*\+?=/gi,
  /\$\{([A-Za-z_][A-Za-z0-9_]*)\s*:?=/gi,
  /(?:SetEnvironmentVariable\s*\(\s*|(?:Set-Item|New-Item)\s+(?:-Path\s+)?["']?Env:)["']?([A-Za-z_][A-Za-z0-9_]*)/gi
] as const

function mutatedVerificationEnvironment(body: string): string | undefined {
  for (const pattern of SCRIPT_ENVIRONMENT_MUTATIONS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(body))) {
      const key = match[1]
      if (key && scriptVerificationEnvironmentIsUnsafe(key)) return key
    }
  }
  return undefined
}

export function verificationBudget(
  mode: VerificationExecutionMode,
  risk: VerificationRiskLevel = 'medium'
): VerificationBudget {
  if (mode === 'fast') {
    const highRisk = risk === 'high'
    return {
      maxCommands: highRisk ? 2 : 1,
      perCommandTimeoutMs: 90_000,
      totalTimeoutMs: highRisk ? 180_000 : 90_000,
      maxOutputChars: 48_000
    }
  }
  if (mode === 'deep') {
    return {
      maxCommands: 4,
      perCommandTimeoutMs: 300_000,
      totalTimeoutMs: 600_000,
      maxOutputChars: 96_000
    }
  }
  return {
    maxCommands: 3,
    perCommandTimeoutMs: 180_000,
    totalTimeoutMs: 300_000,
    maxOutputChars: 64_000
  }
}

function readJsonObject(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function safeDirectoryEntries(directory: string): string[] {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}

function packageManagerOf(root: string, pkg: Record<string, unknown>): PackageManager {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) return 'bun'
  if (existsSync(join(root, 'package-lock.json')) || existsSync(join(root, 'npm-shrinkwrap.json')))
    return 'npm'
  const declared = typeof pkg.packageManager === 'string'
    ? pkg.packageManager.split('@', 1)[0]?.trim().toLowerCase()
    : ''
  return declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm'
    ? declared
    : 'npm'
}

const MAX_LOCAL_MANAGER_CONFIG_BYTES = 256 * 1024

function localManagerConfigFiles(manager: PackageManager): string[] {
  if (manager === 'npm') return ['.npmrc']
  if (manager === 'pnpm') return ['.npmrc', 'pnpm-workspace.yaml']
  if (manager === 'yarn') return ['.yarnrc.yml', '.yarnrc', '.env.yarn']
  return ['bunfig.toml']
}

/** `undefined` significa ausente; `null`, presente mas impossivel de auditar. */
function readLocalManagerConfig(root: string, name: string): string | null | undefined {
  const file = join(root, name)
  if (!existsSync(file)) return undefined
  try {
    const stats = statSync(file)
    if (!stats.isFile() || stats.size > MAX_LOCAL_MANAGER_CONFIG_BYTES) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function managerConfigDefinition(root: string, manager: PackageManager): Array<[string, string]> {
  const result: Array<[string, string]> = []
  for (const name of localManagerConfigFiles(manager)) {
    const contents = readLocalManagerConfig(root, name)
    if (contents === undefined) continue
    result.push([
      name,
      contents === null
        ? 'unreadable'
        : createHash('sha256').update(contents).digest('hex')
    ])
  }
  return result
}

function iniRedirectsExecution(contents: string): boolean {
  const dangerous = new Set([
    'workspace',
    'workspaces',
    'script-shell',
    'userconfig',
    'globalconfig',
    'prefix',
    'location',
    'ignore-scripts',
    'node-options',
    'shell-emulator',
    'enable-pre-post-scripts',
    'manage-package-manager-versions',
    'node-version',
    'use-node-version',
    'execution-env'
  ])
  return contents.split(/\r?\n/).some((rawLine) => {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) {
      return false
    }
    const separator = line.indexOf('=')
    if (separator <= 0) return false
    const key = line
      .slice(0, separator)
      .trim()
      .replace(/^--/, '')
      .replace(/\[\]$/, '')
      .replace(/_/g, '-')
      .toLowerCase()
    return dangerous.has(key)
  })
}

function yamlRedirectsExecution(contents: string, dangerous: Set<string>): boolean {
  return contents.split(/\r?\n/).some((line) => {
    const match = /^\s*["']?([A-Za-z][A-Za-z0-9_-]*)["']?\s*:/.exec(line)
    return !!match && dangerous.has(match[1].toLowerCase())
  })
}

function yarnClassicRedirectsExecution(contents: string): boolean {
  return contents.split(/\r?\n/).some((rawLine) => {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) return false
    const match = /^(?:--)?([A-Za-z][A-Za-z0-9._-]*)\s+/.exec(line)
    const key = match?.[1].toLowerCase()
    return key === 'yarn-path' || key === 'script-shell'
  })
}

function yarnEnvironmentRedirectsExecution(contents: string): boolean {
  return contents.split(/\r?\n/).some((rawLine) => {
    const line = rawLine.trim().replace(/^export\s+/, '')
    if (!line || line.startsWith('#')) return false
    const key = line.split('=', 1)[0]?.trim()
    return !!key && scriptVerificationEnvironmentIsUnsafe(key)
  })
}

function bunConfigRedirectsExecution(contents: string): boolean {
  let section = ''
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line)
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase()
      continue
    }
    const key = /^([A-Za-z][A-Za-z0-9_-]*)\s*=/.exec(line)?.[1].toLowerCase()
    if (key === 'preload') return true
    if (section === 'run' && (key === 'shell' || key === 'bun')) return true
  }
  return false
}

function dangerousPackageManagerConfiguration(root: string, manager: PackageManager): boolean {
  for (const name of localManagerConfigFiles(manager)) {
    const contents = readLocalManagerConfig(root, name)
    if (contents === undefined) continue
    if (contents === null) return true
    if (name === '.npmrc' && iniRedirectsExecution(contents)) return true
    if (
      name === 'pnpm-workspace.yaml' &&
      yamlRedirectsExecution(
        contents,
        new Set([
          'scriptshell',
          'shellemulator',
          'enableprepostscripts',
          'managepackagemanagerversions',
          'executionenv',
          'nodeversion',
          'usenodeversion'
        ])
      )
    ) return true
    if (
      name === '.yarnrc.yml' &&
      yamlRedirectsExecution(
        contents,
        new Set(['yarnpath', 'plugins', 'injectenvironmentfiles', 'scriptshell'])
      )
    ) return true
    if (name === '.yarnrc' && yarnClassicRedirectsExecution(contents)) return true
    if (name === '.env.yarn' && yarnEnvironmentRedirectsExecution(contents)) return true
    if (name === 'bunfig.toml' && bunConfigRedirectsExecution(contents)) return true
  }
  return false
}

function ignoredPackageScript(name: string, body: string): boolean {
  if (!SAFE_SCRIPT_NAME.test(name)) return true
  const normalizedName = name.toLowerCase()
  const normalizedBody = body.toLowerCase()
  if (/(?:^|:)(?:watch|dev|start|serve)(?::|$)/.test(normalizedName)) return true
  if (/\b(?:--watch(?:all)?|watch|serve)\b/.test(normalizedBody)) return true
  if (
    /(?:error:\s*no test specified|no tests? specified|not implemented|todo:\s*add tests?)/.test(
      normalizedBody
    )
  )
    return true
  return false
}

const MUTATING_PACKAGE_SCRIPT = [
  /\b(?:deploy|publish|release|promote|rollback|destroy)\b/i,
  /\bgit\s+push\b/i,
  /\bgh\s+pr\s+(?:create|merge|close|reopen|edit|ready)\b/i,
  /\bterraform\s+(?:apply|destroy|import)\b/i,
  /\bkubectl\s+(?:apply|create|delete|replace|patch|scale|rollout)\b/i,
  /\bhelm\s+(?:install|upgrade|uninstall|rollback)\b/i,
  /\b(?:vercel|netlify|flyctl|wrangler|firebase)\s+(?:deploy|publish)\b/i,
  /\b(?:npx|bunx|pnx|pnpx)\b/i,
  /\b(?:pnpm|pn|yarn|yarnpkg)\s+dlx\b/i,
  /\bcorepack\b/i,
  /(?:\$\{?(?:npm_execpath|npm_node_execpath)\}?|%(?:npm_execpath|npm_node_execpath)%|\$env:(?:npm_execpath|npm_node_execpath))/i,
  /\bcurl\b[^\r\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b/i
] as const

function benignManagerOption(
  manager: PackageManager,
  word: string | undefined,
  position: 'manager' | 'run'
): boolean {
  const option = word?.toLowerCase()
  if (!option) return false
  if (manager === 'npm') {
    return option === '--silent' || option === '-s' ||
      (position === 'run' && option === '--if-present')
  }
  // Formas curtas variam entre versões; só o nome longo inequívoco entra.
  if (manager === 'pnpm' || manager === 'yarn') return option === '--silent'
  return false
}

function normalizedPackageManagerToken(word: string): PackageManager | undefined {
  const normalized = word.replace(/\.cmd$/i, '').toLowerCase()
  if (normalized === 'pn') return 'pnpm'
  if (normalized === 'yarnpkg') return 'yarn'
  return PACKAGE_MANAGERS.has(normalized) ? (normalized as PackageManager) : undefined
}

function packageManagerWords(segment: string): string[] | undefined {
  const words = segment.trim().match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+/g) ?? []
  const normalized: string[] = []
  for (const word of words) {
    if ((word.startsWith('"') && word.endsWith('"')) ||
        (word.startsWith("'") && word.endsWith("'"))) {
      normalized.push(word.slice(1, -1))
    } else if (/["']/.test(word)) {
      return undefined
    } else {
      normalized.push(word)
    }
  }
  return normalized
}

function calledPackageScripts(
  body: string,
  scripts: Record<string, unknown>
): string[] | undefined {
  const called: string[] = []
  const segments = body.split(/&&|\|\||[;|\r\n]/)
  const managerPattern = /\b(npm|pnpm|pn|bun|yarnpkg|yarn)(?:\.cmd)?\b/gi
  for (const segment of segments) {
    const matches = [...segment.matchAll(managerPattern)]
    if (matches.length === 0) continue
    if (matches.length !== 1 || matches[0].index === undefined) return undefined
    const prefix = segment.slice(0, matches[0].index).trim()
    if (prefix) return undefined
    const words = packageManagerWords(segment.slice(matches[0].index))
    if (!words || words.length < 2) return undefined
    const manager = normalizedPackageManagerToken(words[0])
    if (!manager) return undefined
    let at = 1
    while (benignManagerOption(manager, words[at], 'manager')) at += 1
    const action = words[at]?.toLowerCase()
    const explicitRun =
      action === 'run' ||
      (action === 'run-script' && (manager === 'npm' || manager === 'pnpm'))
    if (!explicitRun) return undefined
    at += 1
    while (benignManagerOption(manager, words[at], 'run')) at += 1
    const script = words[at]
    if (!script || !SAFE_SCRIPT_NAME.test(script)) return undefined
    at += 1
    // Nada depois do nome é aceito: alguns gerenciadores encaminham esses
    // tokens ao script e mudam o comportamento que foi analisado.
    if (at !== words.length) return undefined

    if (typeof scripts[script] !== 'string') return undefined
    called.push(script)
  }
  return called
}

function packageScriptDefinition(
  name: string,
  scripts: Record<string, unknown>,
  visiting = new Set<string>(),
  collected = new Map<string, string>()
): Map<string, string> | undefined {
  if (visiting.has(name)) return undefined
  const body = scripts[name]
  if (typeof body !== 'string') return undefined
  collected.set(name, body)
  const next = new Set(visiting)
  next.add(name)
  const called = calledPackageScripts(body, scripts)
  if (!called) return undefined
  for (const related of [`pre${name}`, `post${name}`, ...called]) {
    if (!(related in scripts)) continue
    if (!packageScriptDefinition(related, scripts, next, collected)) return undefined
  }
  return collected
}

/** Hash persistível daquilo que um comando realmente executa. Para scripts
 * Node inclui o corpo, pre/post hooks e scripts locais chamados em cadeia. */
export function verificationCommandDefinitionHash(
  command: Pick<VerificationCommand, 'id' | 'command' | 'args' | 'cwd' | 'blockedReason'>
): string {
  const executable = basename(command.command)
    .replace(/\.(?:cmd|bat|exe|com)$/i, '')
    .toLowerCase()
  const manager = normalizedPackageManagerToken(executable)
  const scriptName =
    manager && command.args[0]?.toLowerCase() === 'run'
      ? command.args[1]
      : undefined
  let definition: Record<string, unknown> = {
    id: command.id,
    command: executable,
    args: command.args,
    blockedReason: command.blockedReason,
    ...(manager
      ? { packageManagerConfiguration: managerConfigDefinition(command.cwd, manager) }
      : {})
  }
  if (scriptName && SAFE_SCRIPT_NAME.test(scriptName)) {
    const pkg = readJsonObject(join(command.cwd, 'package.json'))
    const scripts =
      pkg?.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)
        ? (pkg.scripts as Record<string, unknown>)
        : undefined
    const collected = scripts
      ? packageScriptDefinition(scriptName, scripts)
      : undefined
    definition = {
      ...definition,
      packageManager: typeof pkg?.packageManager === 'string' ? pkg.packageManager : undefined,
      workspaces: pkg?.workspaces,
      packageScripts: collected
        ? [...collected.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'))
        : {
            status: 'missing-or-unsafe',
            rootBody: scripts && typeof scripts[scriptName] === 'string'
              ? scripts[scriptName]
              : undefined
          }
    }
  }
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex')
}

/** Um teste/build pode executar código do próprio projeto, mas o contrato não
 * aceita scripts declaradamente remotos/mutantes nem lifecycle hooks ocultos. */
function safePackageVerificationScript(
  name: string,
  scripts: Record<string, unknown>,
  visiting = new Set<string>()
): boolean {
  if (visiting.has(name)) return false
  const body = scripts[name]
  if (typeof body !== 'string' || ignoredPackageScript(name, body)) return false
  if (mutatedVerificationEnvironment(body)) return false
  if (MUTATING_PACKAGE_SCRIPT.some((pattern) => pattern.test(body))) return false
  const next = new Set(visiting)
  next.add(name)
  const called = calledPackageScripts(body, scripts)
  if (!called) return false
  for (const related of [
    `pre${name}`,
    `post${name}`,
    ...called
  ]) {
    if (!(related in scripts)) continue
    if (!safePackageVerificationScript(related, scripts, next)) return false
  }
  return true
}

function firstUsableScript(
  scripts: Record<string, unknown>,
  names: string[]
): { name: string; body: string } | undefined {
  for (const name of names) {
    const body = scripts[name]
    if (typeof body !== 'string' || !safePackageVerificationScript(name, scripts)) continue
    return { name, body }
  }
  return undefined
}

function firstDeclaredScript(
  scripts: Record<string, unknown>,
  names: string[]
): { name: string; body?: string } | undefined {
  for (const name of names) {
    if (!Object.hasOwn(scripts, name)) continue
    const body = scripts[name]
    return {
      name,
      ...(typeof body === 'string' ? { body } : {})
    }
  }
  return undefined
}

function packageArgs(manager: 'npm' | 'pnpm' | 'yarn' | 'bun', script: string): string[] {
  return manager === 'npm' ? ['run', script] : ['run', script]
}

function addNodeCommands(root: string, ranked: RankedCommand[]): void {
  const file = join(root, 'package.json')
  if (!existsSync(file)) return
  const pkg = readJsonObject(file)
  if (!pkg) return
  const rawScripts = pkg.scripts
  if (!rawScripts || typeof rawScripts !== 'object' || Array.isArray(rawScripts)) return
  const scripts = rawScripts as Record<string, unknown>
  const manager = packageManagerOf(root, pkg)
  const managerConfigurationBlocked = dangerousPackageManagerConfiguration(root, manager)
  const specs: Array<{
    kind: VerificationCommandKind
    names: string[]
    rank: number
  }> = [
    {
      kind: 'typecheck',
      names: ['typecheck', 'type-check', 'check:types', 'check-types', 'check'],
      rank: 10
    },
    { kind: 'test', names: ['test:unit', 'test', 'tests', 'test:ci'], rank: 20 },
    { kind: 'lint', names: ['lint'], rank: 30 },
    { kind: 'build', names: ['build'], rank: 40 }
  ]
  for (const spec of specs) {
    const selected = firstUsableScript(scripts, spec.names)
    const declared = firstDeclaredScript(scripts, spec.names)
    if (!selected && !declared) continue
    const script = selected?.name ?? declared!.name
    const blockedReason = managerConfigurationBlocked
      ? `configuracao local de ${manager} pode redirecionar o check declarado "${script}"`
      : selected
        ? undefined
        : `check declarado "${script}" contem script, hook ou ambiente inseguro ou nao analisavel`
    ranked.push({
      rank: spec.rank,
      order: ranked.length,
      command: {
        id: `node:${script}`,
        kind: script === 'check' ? 'check' : spec.kind,
        label: `${manager} run ${script}`,
        command: manager,
        args: packageArgs(manager, script),
        cwd: root,
        source: 'package.json',
        ...(blockedReason ? { blockedReason } : {})
      }
    })
  }
}

function addCommand(
  ranked: RankedCommand[],
  input: Omit<VerificationCommand, 'timeoutMs'>,
  rank = 20
): void {
  ranked.push({ rank, order: ranked.length, command: input })
}

function addEcosystemCommands(root: string, platform: NodeJS.Platform, ranked: RankedCommand[]): void {
  const entries = safeDirectoryEntries(root)
  const has = (name: string): boolean => existsSync(join(root, name))

  const pythonManifest =
    has('pyproject.toml') || has('requirements.txt') || has('setup.py') || has('setup.cfg')
  const pythonTests =
    has('pytest.ini') || has('tox.ini') || safeDirectoryEntries(join(root, 'tests')).length > 0
  if (pythonManifest && pythonTests) {
    addCommand(ranked, {
      id: 'python:pytest',
      kind: 'test',
      label: 'python -m pytest',
      command: platform === 'win32' ? 'python' : 'python3',
      args: ['-m', 'pytest'],
      cwd: root,
      source: 'configuração Python'
    })
  }

  if (has('Cargo.toml')) {
    addCommand(ranked, {
      id: 'rust:cargo-test',
      kind: 'test',
      label: 'cargo test',
      command: 'cargo',
      args: ['test'],
      cwd: root,
      source: 'Cargo.toml'
    })
  }
  if (has('go.mod')) {
    addCommand(ranked, {
      id: 'go:test',
      kind: 'test',
      label: 'go test ./...',
      command: 'go',
      args: ['test', './...'],
      cwd: root,
      source: 'go.mod'
    })
  }

  const dotnetProject = entries.find((entry) => /\.(?:sln|csproj|fsproj)$/i.test(entry))
  if (dotnetProject) {
    addCommand(ranked, {
      id: 'dotnet:test',
      kind: 'test',
      label: `dotnet test ${dotnetProject}`,
      command: 'dotnet',
      args: ['test', dotnetProject, '--nologo'],
      cwd: root,
      source: dotnetProject
    })
  }

  if (has('pom.xml')) {
    const wrapper = platform === 'win32' ? join(root, 'mvnw.cmd') : join(root, 'mvnw')
    addCommand(ranked, {
      id: 'java:maven-test',
      kind: 'test',
      label: 'mvn test',
      command: existsSync(wrapper) ? wrapper : 'mvn',
      args: ['test'],
      cwd: root,
      source: 'pom.xml'
    })
  } else if (has('build.gradle') || has('build.gradle.kts')) {
    const wrapper = platform === 'win32' ? join(root, 'gradlew.bat') : join(root, 'gradlew')
    addCommand(ranked, {
      id: 'java:gradle-test',
      kind: 'test',
      label: 'gradle test',
      command: existsSync(wrapper) ? wrapper : 'gradle',
      args: ['test'],
      cwd: root,
      source: has('build.gradle.kts') ? 'build.gradle.kts' : 'build.gradle'
    })
  }
}

/**
 * Escolhe comandos locais que o projeto já declarou. Não instala dependências,
 * não usa npx e nunca escolhe dev server/watch. O mesmo resultado deve ser
 * usado no baseline e no final para que a comparação seja honesta.
 */
export function detectVerificationCommands(
  options: DetectVerificationCommandsOptions
): VerificationCommand[] {
  const root = resolve(options.root)
  const platform = options.platform ?? process.platform
  const budget = verificationBudget(options.mode, options.risk)
  const ranked: RankedCommand[] = []
  addNodeCommands(root, ranked)
  addEcosystemCommands(root, platform, ranked)
  const seen = new Set<string>()
  return ranked
    .sort((left, right) => left.rank - right.rank || left.order - right.order)
    .filter(({ command }) => {
      if (seen.has(command.id)) return false
      seen.add(command.id)
      return true
    })
    .slice(
      0,
      options.maxCommands === undefined
        ? budget.maxCommands
        : Math.max(0, Math.floor(options.maxCommands))
    )
    .map(({ command }) => ({
      ...command,
      timeoutMs: budget.perCommandTimeoutMs,
      definitionHash: verificationCommandDefinitionHash(command)
    }))
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const exact = env[key]
  if (exact !== undefined) return exact
  const found = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase())
  return found ? env[found] : undefined
}

function isUsableFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (platform !== 'win32') accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function executableCandidates(command: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32' || extname(command)) return [command]
  return [`${command}.exe`, `${command}.com`, `${command}.cmd`, `${command}.bat`, command]
}

function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string | undefined {
  if (!command || /[\u0000\r\n]/.test(command)) return undefined
  const hasSeparator = /[\\/]/.test(command)
  const roots = hasSeparator || isAbsolute(command)
    ? ['']
    : (envValue(env, 'PATH') ?? '')
        .split(platform === 'win32' ? ';' : ':')
        .map((entry) => entry.replace(/^"|"$/g, '').trim())
        .filter(Boolean)
  for (const root of roots) {
    for (const candidate of executableCandidates(command, platform)) {
      const file = root ? join(root, candidate) : candidate
      if (isUsableFile(file, platform)) return resolve(file)
    }
  }
  return undefined
}

function packageManagerName(file: string): 'npm' | 'pnpm' | 'yarn' | 'bun' | undefined {
  const name = basename(file).replace(/\.(?:cmd|bat|exe|com)$/i, '').toLowerCase()
  return normalizedPackageManagerToken(name)
}

function packageManagerCliCandidates(
  manager: 'npm' | 'pnpm' | 'yarn' | 'bun',
  shim: string
): string[] {
  const root = dirname(shim)
  if (manager === 'npm') {
    return [
      join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      join(root, 'node_modules', 'corepack', 'dist', 'npm.js')
    ]
  }
  if (manager === 'pnpm') {
    return [
      join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      join(root, 'node_modules', 'corepack', 'dist', 'pnpm.js')
    ]
  }
  if (manager === 'yarn') {
    return [
      join(root, 'node_modules', 'yarn', 'bin', 'yarn.js'),
      join(root, 'node_modules', 'corepack', 'dist', 'yarn.js')
    ]
  }
  return []
}

function trustedWindowsCommandShell(env: NodeJS.ProcessEnv): string | undefined {
  const systemRoots = [
    envValue(process.env, 'SystemRoot'),
    envValue(env, 'SystemRoot')
  ]
  for (const rawRoot of systemRoots) {
    const root = rawRoot?.replace(/^"|"$/g, '').trim()
    if (!root || !isAbsolute(root)) continue
    const candidate = resolve(root, 'System32', 'cmd.exe')
    if (isUsableFile(candidate, 'win32')) return candidate
  }

  const comSpecs = [envValue(process.env, 'ComSpec'), envValue(env, 'ComSpec')]
  for (const rawComSpec of comSpecs) {
    const candidate = rawComSpec?.replace(/^"|"$/g, '').trim()
    if (
      candidate &&
      isAbsolute(candidate) &&
      basename(candidate).toLowerCase() === 'cmd.exe' &&
      isUsableFile(candidate, 'win32')
    ) return resolve(candidate)
  }
  return undefined
}

function knownJavaBatchInvocation(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv
): ResolvedVerificationInvocation | undefined {
  const name = basename(executable).toLowerCase()
  const knownWrapper = name === 'mvnw.cmd' || name === 'gradlew.bat'
  if (!knownWrapper || !isAbsolute(executable)) return undefined
  if (args.length !== 1 || args[0] !== 'test') return undefined
  // `call` sofre expansao pelo cmd. Recusamos todo caractere de controle ou
  // metacaractere no caminho em vez de tentar uma escapada parcial.
  if (/[\u0000\r\n"%!^&|<>()]/.test(executable)) return undefined
  const shell = trustedWindowsCommandShell(env)
  if (!shell) return undefined
  return {
    command: shell,
    args: ['/d', '/s', '/c', 'call', executable, 'test']
  }
}

/**
 * Resolve uma invocação que possa ser entregue diretamente a spawn com
 * `shell:false`. Em Windows, shims npm/pnpm/yarn `.cmd` são convertidos em
 * `node.exe <cli.js> ...`; batch genérico falha fechado em vez de interpolar
 * argumentos num shell.
 */
export function resolveVerificationInvocation(
  spec: Pick<VerificationCommand, 'command' | 'args'>,
  options: ResolveVerificationInvocationOptions = {}
): ResolvedVerificationInvocation | undefined {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (spec.args.some((arg) => typeof arg !== 'string' || arg.includes('\u0000'))) return undefined
  const executable = resolveExecutable(spec.command, env, platform)
  if (!executable) return undefined
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(executable)) {
    return { command: executable, args: [...spec.args] }
  }
  const javaWrapper = knownJavaBatchInvocation(executable, spec.args, env)
  if (javaWrapper) return javaWrapper
  const manager = packageManagerName(executable)
  if (!manager || manager === 'bun') return undefined
  const cli = packageManagerCliCandidates(manager, executable).find((candidate) => existsSync(candidate))
  const node = resolveExecutable('node', env, platform)
  if (!cli || !node || /\.(?:cmd|bat)$/i.test(node)) return undefined
  return { command: node, args: [cli, ...spec.args] }
}

function replacePath(text: string, path: string): string {
  const variants = new Set([path, path.replace(/\\/g, '/'), path.replace(/\//g, '\\')])
  let result = text
  for (const variant of variants) {
    if (!variant) continue
    result = result.split(variant).join('<cwd>')
    result = result.split(variant.toLowerCase()).join('<cwd>')
  }
  return result
}

/** Remove apenas ruído comprovadamente volátil; diferenças reais falham fechado. */
export function normalizeVerificationOutput(output: string, cwd?: string): string {
  let normalized = output.replace(ANSI_ESCAPE, '').replace(/\r\n?/g, '\n').replace(ISO_TIMESTAMP, '<timestamp>')
  if (cwd) normalized = replacePath(normalized, resolve(cwd))
  return normalized
    .split('\n')
    .map((line) => line.replace(/[\t ]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function createVerificationSignature(input: {
  exitCode: number | null
  stdout: string
  stderr: string
  cwd?: string
}): string {
  const normalized = JSON.stringify({
    exitCode: input.exitCode,
    stdout: normalizeVerificationOutput(input.stdout, input.cwd),
    stderr: normalizeVerificationOutput(input.stderr, input.cwd)
  })
  return createHash('sha256').update(normalized).digest('hex')
}

function appendTail(current: string, chunk: Buffer | string, maxChars: number): string {
  const next = current + chunk.toString()
  return next.length <= maxChars ? next : next.slice(next.length - maxChars)
}

function unavailableToolOutput(stdout: string, stderr: string): boolean {
  const output = `${stdout}\n${stderr}`.toLowerCase()
  return (
    /no module named ['"]?pytest/.test(output) ||
    /(?:tsc|eslint|jest|vitest|pytest|cargo|dotnet|mvn|gradle)(?:\.cmd)?(?:\s|:).{0,100}(?:not found|not recognized|não é reconhecido)/s.test(
      output
    )
  )
}

function terminateProcess(child: ChildProcess, platform: NodeJS.Platform): void {
  if (!child.pid) return
  if (platform === 'win32') {
    try {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.once('error', () => {
        try {
          child.kill('SIGTERM')
        } catch {
          // processo já saiu
        }
      })
      killer.unref()
      return
    } catch {
      // cai no kill direto
    }
  }
  try {
    child.kill('SIGTERM')
  } catch {
    // processo já saiu
  }
}

/** Arquivos de config npm VAZIOS e distintos (user/global) — cache por
 *  processo; null = tmp indisponível (o chamador remove a variável). */
const EMPTY_NPM_CONFIG_FILES = new Map<string, string | null>()
function ensureEmptyNpmConfigFile(kind: 'user' | 'global'): string | null {
  const cached = EMPTY_NPM_CONFIG_FILES.get(kind)
  if (cached !== undefined) return cached
  try {
    const file = join(tmpdir(), `synkora-verification-npmrc-${kind}`)
    writeFileSync(file, '', 'utf8')
    EMPTY_NPM_CONFIG_FILES.set(kind, file)
    return file
  } catch {
    EMPTY_NPM_CONFIG_FILES.set(kind, null)
    return null
  }
}

function sanitizedVerificationEnvironment(
  input: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...input }
  const windowsShell = platform === 'win32' ? trustedWindowsCommandShell(env) : undefined
  for (const key of Object.keys(env)) {
    const normalized = key.toLowerCase()
    if (normalized === 'comspec' || inheritedVerificationEnvironmentIsUnsafe(normalized)) {
      delete env[key]
    }
  }

  // Neutraliza redirecionamento de config do npm SEM quebrá-lo: apontar user
  // e global para o MESMO null device fazia o npm ABORTAR no boot com
  // "double-loading config .../NUL as global, previously loaded as user"
  // (caso real 2026-08-04: typecheck/test/lint da M01 morriam em ~120ms e a
  // verificação conjunta reprovava um produto comprovadamente verde). Dois
  // arquivos VAZIOS e DISTINTOS têm o mesmo efeito, sem a colisão; se o tmp
  // falhar, a variável é REMOVIDA (npm lê a config real da máquina — o
  // redirecionamento local já é barrado por dangerousPackageManagerConfiguration).
  const emptyUserConfig = ensureEmptyNpmConfigFile('user')
  const emptyGlobalConfig = ensureEmptyNpmConfigFile('global')
  if (emptyUserConfig) env.npm_config_userconfig = emptyUserConfig
  else delete env.npm_config_userconfig
  if (emptyGlobalConfig) env.npm_config_globalconfig = emptyGlobalConfig
  else delete env.npm_config_globalconfig
  if (platform === 'win32') {
    if (windowsShell) {
      env.ComSpec = windowsShell
      env.npm_config_script_shell = windowsShell
    }
  } else {
    env.npm_config_script_shell = '/bin/sh'
  }
  env.npm_config_workspaces = 'false'
  env.npm_config_ignore_scripts = 'false'
  env.YARN_IGNORE_PATH = '1'
  return env
}

async function runVerificationCommand(
  command: VerificationCommand,
  options: RunVerificationOptions,
  timeoutMs: number
): Promise<VerificationCommandResult> {
  const started = Date.now()
  const platform = options.platform ?? process.platform
  const rawEnv = { ...process.env, ...(options.env ?? {}) }
  const env = sanitizedVerificationEnvironment(rawEnv, platform)
  const unavailable = (detail: string): VerificationCommandResult => ({
    commandId: command.id,
    label: command.label,
    status: 'unavailable',
    exitCode: null,
    signal: null,
    durationMs: Math.max(0, Date.now() - started),
    stdoutTail: '',
    stderrTail: detail
  })
  if (command.blockedReason) {
    return unavailable(`check declarado bloqueado: ${command.blockedReason}`)
  }
  const manager = packageManagerName(command.command)
  if (platform === 'win32' && manager && !trustedWindowsCommandShell(env)) {
    return unavailable(`shell Windows absoluto indisponivel para: ${command.label}`)
  }
  if (manager && dangerousPackageManagerConfiguration(command.cwd, manager)) {
    return unavailable(`configuracao local pode redirecionar: ${command.label}`)
  }
  const invocation = resolveVerificationInvocation(command, {
    env: sanitizedVerificationEnvironment(options.resolveEnv ?? env, platform),
    platform
  })
  if (!invocation) {
    return unavailable(`executável direto indisponível para: ${command.label}`)
  }
  if (options.signal?.aborted) {
    return {
      ...unavailable('verificação cancelada antes de iniciar'),
      status: 'cancelled'
    }
  }

  const maxOutputChars = options.maxOutputChars ?? 64_000
  return await new Promise<VerificationCommandResult>((resolveResult) => {
    let stdoutTail = ''
    let stderrTail = ''
    let stdoutForSignature = ''
    let stderrForSignature = ''
    let signatureOverflow = false
    const stdoutRawHash = createHash('sha256')
    const stderrRawHash = createHash('sha256')
    let timedOut = false
    let cancelled = false
    let settled = false
    let forceTimer: NodeJS.Timeout | undefined
    let child: ChildProcess

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      spawnError?: Error
    ): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (forceTimer) clearTimeout(forceTimer)
      options.signal?.removeEventListener('abort', abort)
      const durationMs = Math.max(0, Date.now() - started)
      if (spawnError) {
        resolveResult(unavailable(spawnError.message))
        return
      }
      const status: VerificationCommandStatus = cancelled
        ? 'cancelled'
        : timedOut
          ? 'timed_out'
          : exitCode === 0
            ? 'passed'
            : unavailableToolOutput(stdoutTail, stderrTail)
              ? 'unavailable'
              : 'failed'
      const signature =
        status === 'failed' || status === 'passed'
          ? signatureOverflow
            ? createHash('sha256')
                .update(
                  JSON.stringify({
                    exitCode,
                    stdoutHash: stdoutRawHash.digest('hex'),
                    stderrHash: stderrRawHash.digest('hex')
                  })
                )
                .digest('hex')
            : createVerificationSignature({
                exitCode,
                stdout: stdoutForSignature,
                stderr: stderrForSignature,
                cwd: command.cwd
              })
          : undefined
      resolveResult({
        commandId: command.id,
        label: command.label,
        status,
        exitCode,
        signal,
        durationMs,
        stdoutTail,
        stderrTail,
        ...(signature ? { signature } : {})
      })
    }

    const abort = (): void => {
      cancelled = true
      terminateProcess(child, platform)
      forceTimer = setTimeout(() => finish(null, null), 2_000)
      forceTimer.unref()
    }

    const timeout = setTimeout(() => {
      timedOut = true
      terminateProcess(child, platform)
      forceTimer = setTimeout(() => finish(null, null), 2_000)
      forceTimer.unref()
    }, Math.max(1, timeoutMs))
    timeout.unref()

    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: command.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      finish(null, null, error instanceof Error ? error : new Error(String(error)))
      return
    }
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutRawHash.update(chunk)
      if (stdoutForSignature.length < MAX_NORMALIZED_SIGNATURE_CHARS) {
        const text = chunk.toString()
        const room = MAX_NORMALIZED_SIGNATURE_CHARS - stdoutForSignature.length
        stdoutForSignature += text.slice(0, room)
        if (text.length > room) signatureOverflow = true
      } else {
        signatureOverflow = true
      }
      stdoutTail = appendTail(stdoutTail, chunk, maxOutputChars)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrRawHash.update(chunk)
      if (stderrForSignature.length < MAX_NORMALIZED_SIGNATURE_CHARS) {
        const text = chunk.toString()
        const room = MAX_NORMALIZED_SIGNATURE_CHARS - stderrForSignature.length
        stderrForSignature += text.slice(0, room)
        if (text.length > room) signatureOverflow = true
      } else {
        signatureOverflow = true
      }
      stderrTail = appendTail(stderrTail, chunk, maxOutputChars)
    })
    child.once('error', (error) => finish(null, null, error))
    child.once('close', (code, signal) => finish(code, signal))
    options.signal?.addEventListener('abort', abort, { once: true })
    // Cobre a janela entre a checagem antes do spawn e o registro do listener.
    if (options.signal?.aborted) abort()
  })
}

function skippedResult(
  command: VerificationCommand,
  status: 'timed_out' | 'cancelled',
  detail: string
): VerificationCommandResult {
  return {
    commandId: command.id,
    label: command.label,
    status,
    exitCode: null,
    signal: null,
    durationMs: 0,
    stdoutTail: '',
    stderrTail: detail
  }
}

function batchStatus(results: VerificationCommandResult[]): VerificationBatchStatus {
  if (results.length === 0) return 'not_required'
  if (results.some((result) => result.status === 'cancelled')) return 'cancelled'
  if (results.some((result) => result.status === 'timed_out')) return 'timed_out'
  if (results.some((result) => result.status === 'failed')) return 'failed'
  if (results.some((result) => result.status === 'unavailable')) return 'unavailable'
  return 'passed'
}

/** Executa em sequência para não disputar CPU/memória com os panes. */
export async function runVerificationCommands(
  commands: VerificationCommand[],
  options: RunVerificationOptions = {}
): Promise<VerificationBatchResult> {
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  const results: VerificationCommandResult[] = []
  const inferredTotal = commands.reduce((total, command) => total + command.timeoutMs, 0)
  const totalTimeoutMs = Math.max(1, options.totalTimeoutMs ?? (inferredTotal || 1))
  for (const command of commands) {
    if (options.signal?.aborted) {
      results.push(skippedResult(command, 'cancelled', 'verificação cancelada'))
      continue
    }
    const remaining = totalTimeoutMs - (Date.now() - started)
    if (remaining <= 0) {
      results.push(
        skippedResult(command, 'timed_out', 'orçamento total de verificação esgotado')
      )
      continue
    }
    let result = await runVerificationCommand(
      command,
      options,
      Math.min(command.timeoutMs, remaining)
    )
    // spawn EPERM transitório (CHECK 4, caso real 2026-08-06: o Windows/AV
    // recusou abrir esbuild/workers do Vitest recém-gravados pelo npm ci e o
    // gate inteiro virou "bloqueada" por ambiente). UMA re-tentativa após
    // 3s cobre a janela de scan do antivírus; falha repetida é falha real.
    if (
      result.status === 'failed' &&
      /spawn EPERM/i.test(`${result.stdoutTail}\n${result.stderrTail}`) &&
      !options.signal?.aborted
    ) {
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      const retryRemaining = totalTimeoutMs - (Date.now() - started)
      if (retryRemaining > 0) {
        result = await runVerificationCommand(
          command,
          options,
          Math.min(command.timeoutMs, retryRemaining)
        )
      }
    }
    results.push(result)
  }
  const finished = Date.now()
  return {
    status: batchStatus(results),
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: Math.max(0, finished - started),
    results
  }
}

/**
 * Baseline vermelho não paralisa o desenvolvimento. No final, porém, só é
 * aceito se a MESMA falha reproduzir a mesma assinatura; timeout, ferramenta
 * ausente e cancelamento nunca contam como evidência comparável.
 */
export function compareVerificationEvidence(
  baseline: VerificationBatchResult | undefined,
  final: VerificationBatchResult
): VerificationComparison {
  if (
    final.status === 'not_required' &&
    final.results.length === 0 &&
    (baseline?.results.length ?? 0) === 0
  ) {
    return { status: 'not_required', items: [] }
  }
  const baselineById = new Map(
    (baseline?.results ?? []).map((result) => [result.commandId, result] as const)
  )
  const items: VerificationComparisonItem[] = final.results.map((result) => {
    if (result.status === 'passed') {
      return {
        commandId: result.commandId,
        label: result.label,
        verdict: 'passed',
        detail: 'comando aprovado na fotografia final'
      }
    }
    const before = baselineById.get(result.commandId)
    if (
      result.status === 'failed' &&
      before?.status === 'failed' &&
      !!result.signature &&
      before.signature === result.signature
    ) {
      return {
        commandId: result.commandId,
        label: result.label,
        verdict: 'unchanged_failure',
        detail: 'a mesma falha já existia no baseline e não mudou'
      }
    }
    return {
      commandId: result.commandId,
      label: result.label,
      verdict: 'blocked',
      detail:
        result.status === 'failed'
          ? before?.status === 'passed'
            ? 'o comando passou no baseline e falhou no final'
            : 'a falha final não corresponde ao baseline'
          : result.status === 'timed_out'
            ? 'a verificação excedeu o tempo permitido'
            : result.status === 'unavailable'
              ? 'a ferramenta necessária não estava disponível'
              : 'a verificação foi cancelada'
      }
  })
  const finalIds = new Set(final.results.map((result) => result.commandId))
  for (const before of baseline?.results ?? []) {
    if (finalIds.has(before.commandId)) continue
    items.push({
      commandId: before.commandId,
      label: before.label,
      verdict: 'blocked',
      detail: 'o comando existente no baseline não foi executado na fotografia final'
    })
  }
  if (items.some((item) => item.verdict === 'blocked')) return { status: 'blocked', items }
  return {
    status: items.some((item) => item.verdict === 'unchanged_failure')
      ? 'passed_with_baseline_failures'
      : 'passed',
    items
  }
}

/** Uma queda nunca transforma `running` em aprovação; o boot reprograma o run. */
export function recoverInterruptedVerification<T extends VerificationCheckpoint>(
  checkpoint: T,
  now = new Date().toISOString()
): T {
  if (checkpoint.status !== 'running') return { ...checkpoint }
  return {
    ...checkpoint,
    status: 'pending',
    interruptedAt: now,
    finishedAt: undefined,
    lastError: 'verificação interrompida pelo fechamento do aplicativo; será retomada'
  }
}
