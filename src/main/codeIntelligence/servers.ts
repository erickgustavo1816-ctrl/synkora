import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodeIntelligenceError, type CodeLanguage, type CodeServerMetadata } from './types'

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_CONFIG_HASH_BYTES = 4 * 1024 * 1024

interface PackageManifest {
  name?: unknown
  version?: unknown
  bin?: unknown
  dependencies?: unknown
  devDependencies?: unknown
  optionalDependencies?: unknown
  peerDependencies?: unknown
}

export interface WorkspaceDescriptor {
  root: string
  key: string
}

export interface ServerDetectionOptions {
  /** Directory used to resolve runtime dependencies in development. */
  appRoot?: string
  /** Packaged Electron app path (including app.asar when applicable). */
  appPath?: string
}

export interface TypeScriptServerDescriptor {
  key: string
  root: string
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  configPath: string | null
  metadata: CodeServerMetadata
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLocaleLowerCase('en-US') : path
}

export function canonicalPath(path: string): string {
  return realpathSync.native(resolve(path))
}

export function isPathInside(parent: string, child: string): boolean {
  const parentKey = pathKey(resolve(parent))
  const childKey = pathKey(resolve(child))
  const rel = relative(parentKey, childKey)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function directoryFor(value: string): string {
  const resolved = canonicalPath(value)
  return statSync(resolved).isDirectory() ? resolved : dirname(resolved)
}

function findGitRoot(cwd: string): string | null {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    env: sanitizedServerEnvironment(),
    windowsHide: true,
    timeout: 2_000,
    maxBuffer: 64 * 1024
  })
  if (result.error || result.status !== 0) return null
  const candidate = String(result.stdout ?? '').trim()
  if (!candidate || !existsSync(candidate)) return null
  try {
    const canonical = canonicalPath(candidate)
    return isPathInside(canonical, cwd) ? canonical : null
  } catch {
    return null
  }
}

function findMarkerRoot(cwd: string): string {
  let current = cwd
  let closestProjectMarker: string | null = null
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    if (!closestProjectMarker && hasProjectMarker(current)) {
      closestProjectMarker = current
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return closestProjectMarker ?? cwd
}

function configNames(directory: string): string[] {
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return []
  }
  return names
    .filter((name) => /^(?:tsconfig|jsconfig)(?:\.[A-Za-z0-9_-]+)*\.json$/i.test(name))
    .sort((left, right) => {
      const leftExact = /^(?:tsconfig|jsconfig)\.json$/i.test(left) ? 0 : 1
      const rightExact = /^(?:tsconfig|jsconfig)\.json$/i.test(right) ? 0 : 1
      return leftExact - rightExact || left.localeCompare(right)
    })
}

function hasProjectMarker(directory: string): boolean {
  return existsSync(join(directory, 'package.json')) || configNames(directory).length > 0
}

export function detectWorkspace(cwd: string): WorkspaceDescriptor {
  if (typeof cwd !== 'string' || cwd.trim() === '' || cwd.includes('\0')) {
    throw new CodeIntelligenceError('INVALID_ARGUMENT', 'workspace directory is invalid')
  }
  let canonicalCwd: string
  try {
    canonicalCwd = directoryFor(cwd)
  } catch {
    throw new CodeIntelligenceError('FILE_NOT_FOUND', 'workspace directory does not exist')
  }
  const root = findGitRoot(canonicalCwd) ?? canonicalPath(findMarkerRoot(canonicalCwd))
  return { root, key: pathKey(root) }
}

export function resolveAuthorizedFile(root: string, relativePath: string): string {
  if (
    typeof relativePath !== 'string' ||
    relativePath.trim() === '' ||
    relativePath.includes('\0') ||
    isAbsolute(relativePath)
  ) {
    throw new CodeIntelligenceError('INVALID_ARGUMENT', 'file path must be relative to the worktree')
  }

  const candidate = resolve(root, relativePath)
  if (!isPathInside(root, candidate)) {
    throw new CodeIntelligenceError('PATH_OUTSIDE_WORKTREE', 'file path leaves the authorized worktree')
  }
  let canonical: string
  try {
    canonical = canonicalPath(candidate)
  } catch {
    throw new CodeIntelligenceError('FILE_NOT_FOUND', 'file does not exist')
  }
  if (!isPathInside(root, canonical)) {
    throw new CodeIntelligenceError('PATH_OUTSIDE_WORKTREE', 'file resolves outside the authorized worktree')
  }
  let stat
  try {
    stat = statSync(canonical)
  } catch {
    throw new CodeIntelligenceError('FILE_NOT_FOUND', 'file does not exist')
  }
  if (!stat.isFile()) throw new CodeIntelligenceError('INVALID_ARGUMENT', 'path is not a file')
  return canonical
}

export function relativeAuthorizedPath(root: string, absolutePath: string): string | null {
  let canonical: string
  try {
    canonical = canonicalPath(absolutePath)
  } catch {
    // LSP results can point at generated/nonexistent files. Do not expose them.
    return null
  }
  if (!isPathInside(root, canonical)) return null
  const rel = relative(root, canonical).replaceAll('\\', '/')
  return rel === '' || rel.startsWith('../') ? null : rel
}

export function relativePathFromUri(root: string, uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return null
  try {
    return relativeAuthorizedPath(root, fileURLToPath(uri))
  } catch {
    return null
  }
}

export function languageForPath(file: string): CodeLanguage {
  const lower = file.toLowerCase()
  if (lower.endsWith('.d.ts') || lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) {
    return 'typescript'
  }
  if (lower.endsWith('.tsx')) return 'typescriptreact'
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript'
  if (lower.endsWith('.jsx')) return 'javascriptreact'
  throw new CodeIntelligenceError(
    'UNSUPPORTED_LANGUAGE',
    'the TypeScript code server does not support this file type'
  )
}

function readManifest(file: string): PackageManifest | null {
  try {
    const stat = statSync(file)
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return null
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as PackageManifest)
      : null
  } catch {
    return null
  }
}

function dependencyRange(manifest: PackageManifest | null, packageName: string): string | null {
  if (!manifest) return null
  for (const field of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies
  ]) {
    if (!field || typeof field !== 'object' || Array.isArray(field)) continue
    const range = (field as Record<string, unknown>)[packageName]
    if (typeof range === 'string' && range.trim() !== '') return range
  }
  return null
}

function findNearestPackage(start: string, root: string): { file: string; manifest: PackageManifest } | null {
  let current = start
  for (;;) {
    const file = join(current, 'package.json')
    const manifest = readManifest(file)
    if (
      manifest &&
      (
        dependencyRange(manifest, 'typescript') ||
        dependencyRange(manifest, 'typescript-language-server')
      )
    ) {
      return { file, manifest }
    }
    if (pathKey(current) === pathKey(root)) return null
    const parent = dirname(current)
    if (parent === current || !isPathInside(root, parent)) return null
    current = parent
  }
}

/**
 * Return a major only for the common single-major dependency forms whose intent
 * is unambiguous without executing package-manager range resolution. Complex
 * unions/ranges fail closed instead of selecting an incompatible bundled server.
 */
function declaredTypeScriptMajor(range: string): number | null {
  const normalized = range.trim().replace(/^workspace:/, '').trim()
  const match = /^(?:[~^]|>=?\s*|>\s*)?v?(\d+)(?:\.(?:\d+|[xX*]))?(?:\.(?:\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?$/.exec(normalized)
  if (!match) return null
  const major = Number(match[1])
  return Number.isSafeInteger(major) ? major : null
}

function installedTypeScriptVersion(packageFile: string, root: string): string | null {
  try {
    const resolvedPackage = canonicalPath(
      createRequire(packageFile).resolve('typescript/package.json')
    )
    if (!isPathInside(root, resolvedPackage)) return null
    const manifest = readManifest(resolvedPackage)
    return typeof manifest?.version === 'string' && /^\d+\./.test(manifest.version)
      ? manifest.version
      : null
  } catch {
    return null
  }
}

function findConfigs(start: string, root: string): string[] {
  let current = start
  for (;;) {
    const found: string[] = []
    for (const name of configNames(current)) {
      try {
        found.push(canonicalPath(join(current, name)))
      } catch {
        // Ignore a config that vanished during detection.
      }
    }
    if (found.length > 0) return found
    if (pathKey(current) === pathKey(root)) return []
    const parent = dirname(current)
    if (parent === current || !isPathInside(root, parent)) return []
    current = parent
  }
}

function configFingerprint(configPaths: string[]): string {
  if (configPaths.length === 0) return 'none'
  const hash = createHash('sha256')
  for (const configPath of configPaths) {
    hash.update(pathKey(configPath)).update('\0')
    try {
      const stat = statSync(configPath)
      if (stat.size <= MAX_CONFIG_HASH_BYTES) hash.update(readFileSync(configPath))
      else hash.update(`${stat.size}:${stat.mtimeMs}`)
    } catch {
      hash.update('missing')
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function unpackedRuntimePath(file: string): string {
  const marker = `${sep}app.asar${sep}`
  const index = file.toLowerCase().indexOf(marker.toLowerCase())
  if (index < 0) return file
  return `${file.slice(0, index)}${sep}app.asar.unpacked${sep}${file.slice(index + marker.length)}`
}

function executableName(): string {
  return process.platform === 'win32' ? 'tsc.exe' : 'tsc'
}

function platformPackageName(): string {
  return `@typescript/typescript-${process.platform}-${process.arch}`
}

function isInsideExpectedRuntime(expected: string, file: string): boolean {
  const expectedCandidates = [expected]
  if (expected.toLowerCase().endsWith(`${sep}app.asar`)) {
    expectedCandidates.push(`${expected}.unpacked`)
  } else {
    const unpacked = unpackedRuntimePath(expected)
    if (unpacked !== expected) expectedCandidates.push(unpacked)
  }
  for (const candidate of expectedCandidates) {
    try {
      if (isPathInside(canonicalPath(candidate), canonicalPath(file))) return true
    } catch {
      // Electron's virtual app.asar tree may not support native realpath; lexical
      // containment is still anchored to the trusted app path supplied by main.
      if (isPathInside(candidate, file)) return true
    }
  }
  return false
}

function resolveNativeTypeScript(
  requireFrom: NodeJS.Require,
  expectedInside?: string
): { command: string; version: string } | null {
  let typescriptPackageFile: string
  try {
    typescriptPackageFile = requireFrom.resolve('typescript/package.json')
  } catch {
    return null
  }
  const manifest = readManifest(typescriptPackageFile)
  const version = typeof manifest?.version === 'string' ? manifest.version : ''
  const major = Number(version.split('.')[0])
  if (!Number.isSafeInteger(major) || major < 7) return null

  if (expectedInside) {
    if (!isInsideExpectedRuntime(expectedInside, typescriptPackageFile)) return null
  }

  let platformFile: string
  try {
    platformFile = createRequire(typescriptPackageFile).resolve(`${platformPackageName()}/package.json`)
  } catch {
    return null
  }
  const platformManifest = readManifest(platformFile)
  if (platformManifest?.version !== version) return null
  if (expectedInside) {
    if (!isInsideExpectedRuntime(expectedInside, platformFile)) return null
  }
  const command = unpackedRuntimePath(join(dirname(platformFile), 'lib', executableName()))
  try {
    if (!statSync(command).isFile()) return null
    if (expectedInside && !isInsideExpectedRuntime(expectedInside, command)) return null
  } catch {
    return null
  }
  return { command, version }
}

function binPath(manifest: PackageManifest, packageFile: string, preferredName: string): string | null {
  const bin = manifest.bin
  let value: unknown
  if (typeof bin === 'string') value = bin
  else if (bin && typeof bin === 'object' && !Array.isArray(bin)) {
    value = (bin as Record<string, unknown>)[preferredName]
  }
  if (typeof value !== 'string' || value.trim() === '') return null
  const candidate = unpackedRuntimePath(resolve(dirname(packageFile), value))
  try {
    return statSync(candidate).isFile() ? candidate : null
  } catch {
    return null
  }
}

function resolveProjectLanguageServer(
  packageFile: string,
  root: string
): { command: string; args: string[]; env: NodeJS.ProcessEnv; version: string } | null {
  let serverPackageFile: string
  try {
    serverPackageFile = createRequire(packageFile).resolve('typescript-language-server/package.json')
  } catch {
    return null
  }
  let canonicalPackage: string
  try {
    canonicalPackage = canonicalPath(serverPackageFile)
  } catch {
    return null
  }
  if (!isPathInside(root, canonicalPackage)) return null
  const manifest = readManifest(serverPackageFile)
  const version = typeof manifest?.version === 'string' ? manifest.version : ''
  const cli = manifest ? binPath(manifest, serverPackageFile, 'typescript-language-server') : null
  if (!cli || !version) return null
  try {
    if (!isPathInside(root, canonicalPath(cli))) return null
  } catch {
    return null
  }
  return {
    command: process.execPath,
    args: [cli, '--stdio'],
    env: sanitizedServerEnvironment(Boolean(process.versions.electron)),
    version
  }
}

function runtimeRequires(
  options: ServerDetectionOptions
): Array<{ requireFrom: NodeJS.Require; expectedInside?: string }> {
  const candidates = [options.appPath, options.appRoot]
  const requires: Array<{ requireFrom: NodeJS.Require; expectedInside?: string }> = []
  for (const candidate of candidates) {
    if (!candidate) continue
    const packageFile = candidate.endsWith('.json') ? candidate : join(candidate, 'package.json')
    try {
      requires.push({
        requireFrom: createRequire(packageFile),
        expectedInside: candidate.endsWith('.json') ? dirname(candidate) : candidate
      })
    } catch {
      // Try the next runtime resolution base.
    }
  }
  const runtimeBase = typeof __filename === 'string'
    ? __filename
    : join(process.cwd(), 'package.json')
  requires.push({ requireFrom: createRequire(runtimeBase) })
  return requires
}

function resolveBundledNativeTypeScript(
  options: ServerDetectionOptions
): { command: string; version: string } | null {
  for (const candidate of runtimeRequires(options)) {
    const resolved = resolveNativeTypeScript(candidate.requireFrom, candidate.expectedInside)
    if (resolved) return resolved
  }
  return null
}

/**
 * Child language servers receive only operating-system essentials. In particular,
 * Synkora/API tokens and credentials from the Electron process are never inherited.
 */
export function sanitizedServerEnvironment(electronRunAsNode = false): NodeJS.ProcessEnv {
  const allow = new Set([
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)',
    'LANG',
    'LC_ALL',
    'NODE_OPTIONS'
  ])
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || !allow.has(key.toUpperCase())) continue
    // NODE_OPTIONS can load arbitrary modules and may contain secrets; keep only benign memory flags.
    if (key.toUpperCase() === 'NODE_OPTIONS' && !/^(?:\s*--max-old-space-size=\d+\s*)?$/.test(value)) {
      continue
    }
    env[key] = value
  }
  if (electronRunAsNode) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

export function detectTypeScriptServer(
  root: string,
  targetFile: string,
  options: ServerDetectionOptions = {}
): TypeScriptServerDescriptor {
  const start = dirname(targetFile)
  const nearestPackage = findNearestPackage(start, root)
  const declaredTypeScript = dependencyRange(nearestPackage?.manifest ?? null, 'typescript')
  const declaredLanguageServer = dependencyRange(
    nearestPackage?.manifest ?? null,
    'typescript-language-server'
  )
  const configPaths = findConfigs(start, root)
  const configPath = configPaths[0] ?? null

  let kind: CodeServerMetadata['kind']
  let name: string
  let version: string
  let command: string
  let args: string[]
  let env: NodeJS.ProcessEnv

  if (declaredTypeScript && nearestPackage) {
    const installedVersion = installedTypeScriptVersion(nearestPackage.file, root)
    const installedMajor = installedVersion ? Number(installedVersion.split('.')[0]) : null
    const declaredMajor = declaredTypeScriptMajor(declaredTypeScript)
    const major = installedMajor ?? declaredMajor

    if (major !== null && major >= 7) {
      let native = installedVersion
        ? resolveNativeTypeScript(createRequire(nearestPackage.file), root)
        : null
      if (!native) {
        const bundled = resolveBundledNativeTypeScript(options)
        const bundledMajor = bundled ? Number(bundled.version.split('.')[0]) : null
        // A worktree commonly has the lockfile/manifest but no node_modules. It
        // may use Synkora's trusted native server only when the major matches.
        if (bundled && bundledMajor === major) native = bundled
      }
      if (!native) {
        throw new CodeIntelligenceError(
          'SERVER_UNAVAILABLE',
          'the project TypeScript native language server is unavailable for the declared major'
        )
      }
      kind = 'typescript-native'
      name = 'TypeScript native LSP'
      version = native.version
      command = native.command
      args = ['--lsp', '--stdio']
      env = sanitizedServerEnvironment()
    } else if (major !== null && major < 7) {
      // Worktree de TASK recém-criado não tem node_modules (caso real
      // 2026-08-04, M02b: 6 code_query em rajada com SERVER_UNAVAILABLE
      // instantâneo — o major DECLARADO era 6, mas este ramo exigia
      // installedVersion e o dev caía em busca textual até instalar deps).
      // O major declarado basta para escolher o tsgo embutido; o local só é
      // procurado quando há instalação de verdade.
      const local = installedVersion
        ? resolveProjectLanguageServer(nearestPackage.file, root)
        : null
      if (local) {
        kind = 'typescript-language-server'
        name = 'typescript-language-server'
        version = `${local.version} (TypeScript ${installedVersion})`
        command = local.command
        args = local.args
        env = local.env
      } else {
        // Projeto TS 5/6 SEM typescript-language-server local — o caso de TODO
        // scaffold greenfield (caso real 2026-08-04: TS 6.0.3 recém-gerado
        // ficava SERVER_UNAVAILABLE estrutural e o dev caía em busca textual;
        // um projeto SEM typescript declarado, ironicamente, ganhava o servidor
        // embutido no ramo final). O tsgo embutido é o port Go do MESMO
        // compilador (semântica 5.x/6.x); para symbols/refs/hover/diagnostics
        // é estritamente melhor que ficar sem servidor. Diagnósticos podem
        // divergir marginalmente da versão instalada — o version anota isso.
        const bundled = resolveBundledNativeTypeScript(options)
        if (!bundled) {
          throw new CodeIntelligenceError(
            'SERVER_UNAVAILABLE',
            'this project requires TypeScript before 7 and has no compatible local language server'
          )
        }
        kind = 'typescript-native'
        name = 'TypeScript native LSP'
        version = `${bundled.version} (fallback embutido para TypeScript ${installedVersion ?? `${declaredTypeScript ?? major} declarado`})`
        command = bundled.command
        args = ['--lsp', '--stdio']
        env = sanitizedServerEnvironment()
      }
    } else {
      throw new CodeIntelligenceError(
        'SERVER_UNAVAILABLE',
        'the project TypeScript version could not be resolved safely'
      )
    }
  } else if (declaredLanguageServer && nearestPackage) {
    const local = resolveProjectLanguageServer(nearestPackage.file, root)
    if (!local) {
      throw new CodeIntelligenceError(
        'SERVER_UNAVAILABLE',
        'the project language server is declared but not installed locally'
      )
    }
    kind = 'typescript-language-server'
    name = 'typescript-language-server'
    version = local.version
    command = local.command
    args = local.args
    env = local.env
  } else {
    const bundled = resolveBundledNativeTypeScript(options)
    if (!bundled) {
      throw new CodeIntelligenceError(
        'SERVER_UNAVAILABLE',
        'the bundled TypeScript 7 native language server is unavailable'
      )
    }
    kind = 'typescript-native'
    name = 'TypeScript native LSP'
    version = bundled.version
    command = bundled.command
    args = ['--lsp', '--stdio']
    env = sanitizedServerEnvironment()
  }

  const config = configPaths.length > 0
    ? configPaths.map((file) => relative(root, file).replaceAll('\\', '/')).join(',')
    : null
  const keyMaterial = JSON.stringify({
    root: pathKey(root),
    kind,
    version,
    command: pathKey(command),
    args,
    config: configFingerprint(configPaths)
  })
  const key = createHash('sha256').update(keyMaterial).digest('hex')
  return {
    key,
    root,
    command,
    args,
    env,
    configPath,
    metadata: { kind, name, version, config }
  }
}
