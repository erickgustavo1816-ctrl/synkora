import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Módulos externos que podem acrescentar etapas à verificação de uma missão.
 *
 * A detecção é deliberadamente conservadora: ela somente lê arquivos locais
 * conhecidos, não chama Git, provedores, CLIs ou a rede e nunca considera a mera
 * presença de uma dependência como prova de que um módulo está configurado.
 */

export type ProjectAdapterKind = 'ci' | 'pull_request' | 'security' | 'deploy' | 'web_quality'
export type ProjectAdapterState = 'active' | 'not_configured'

export interface ProjectAdapterEvidence {
  /** Caminho relativo, normalizado e pertencente à allowlist deste módulo. */
  path: string
  signal: string
}

export interface ProjectAdapterVerificationCommand {
  id: string
  label: string
  command: 'npm' | 'pnpm' | 'yarn' | 'bun'
  args: string[]
  cwd: string
  sourcePath: 'package.json'
  timeoutMs: number
}

export interface ProjectAdapterDetection {
  kind: ProjectAdapterKind
  state: ProjectAdapterState
  evidence: ProjectAdapterEvidence[]
  /** Sinais necessários que não foram encontrados. Vazio quando `active`. */
  missingSignals: string[]
  /**
   * Apenas scripts locais cujo nome diz check/validate/verify/dry-run e cujo
   * corpo não contém operações de publicação ou mutação remota.
   */
  verificationCommands: ProjectAdapterVerificationCommand[]
}

export interface DetectProjectAdaptersOptions {
  root: string
}

export type ProjectAdapterSelectionMode = 'fast' | 'standard' | 'deep'
export type ProjectAdapterSelectionRisk = 'low' | 'medium' | 'high'

export interface SelectProjectAdapterCommandsOptions {
  detections: ProjectAdapterDetection[]
  mode: ProjectAdapterSelectionMode
  risk: ProjectAdapterSelectionRisk
  riskSurfaces: string[]
  missionText: string
  maxCommands: number
}

const MAX_CONFIG_BYTES = 512 * 1024
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/
const SAFE_DYNAMIC_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:ya?ml)$/i
const SAFE_TEMPLATE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/i

const CI_CONFIG_PATHS = [
  '.buildkite/pipeline.yml',
  '.buildkite/pipeline.yaml',
  '.circleci/config.yml',
  '.circleci/config.yaml',
  '.gitlab-ci.yml',
  '.gitlab-ci.yaml',
  '.travis.yml',
  '.woodpecker.yml',
  '.woodpecker.yaml',
  'Jenkinsfile',
  'azure-pipelines.yml',
  'azure-pipelines.yaml',
  'bitbucket-pipelines.yml'
] as const

const PR_CONFIG_PATHS = [
  '.github/CODEOWNERS',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/labeler.yml',
  '.github/labeler.yaml',
  '.github/pull_request_template.md',
  'CODEOWNERS',
  'PULL_REQUEST_TEMPLATE.md',
  'docs/CODEOWNERS',
  'docs/PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  'pull_request_template.md'
] as const

const SECURITY_CONFIG_PATHS = [
  '.audit-ci.json',
  '.bandit',
  '.github/dependabot.yml',
  '.github/dependabot.yaml',
  '.github/codeql/codeql-config.yml',
  '.github/codeql/codeql-config.yaml',
  '.gitleaks.toml',
  '.semgrep.yml',
  '.semgrep.yaml',
  '.snyk',
  '.trivyignore',
  'audit-ci.json',
  'bandit.yml',
  'bandit.yaml',
  'cargo-deny.toml',
  'codeql-config.yml',
  'codeql-config.yaml',
  'deny.toml',
  'osv-scanner.toml',
  'snyk.yml',
  'snyk.yaml',
  'trivy.yml',
  'trivy.yaml'
] as const

const DEPLOY_CONFIG_PATHS = [
  '.openai/hosting.json',
  'Pulumi.yaml',
  'amplify.yml',
  'amplify.yaml',
  'firebase.json',
  'fly.toml',
  'netlify.toml',
  'railway.json',
  'railway.toml',
  'render.yml',
  'render.yaml',
  'serverless.yml',
  'serverless.yaml',
  'sst.config.js',
  'sst.config.mjs',
  'sst.config.ts',
  'vercel.json',
  'wrangler.json',
  'wrangler.jsonc',
  'wrangler.toml'
] as const

const PUBLIC_UI_CONFIG_PATHS = [
  'angular.json',
  'astro.config.js',
  'astro.config.mjs',
  'astro.config.ts',
  'ember-cli-build.js',
  'gatsby-config.js',
  'gatsby-config.ts',
  'index.html',
  'next.config.js',
  'next.config.cjs',
  'next.config.mjs',
  'next.config.ts',
  'nuxt.config.js',
  'nuxt.config.ts',
  'public/index.html',
  'public/robots.txt',
  'public/sitemap.xml',
  'robots.txt',
  'src/index.html',
  'svelte.config.js',
  'svelte.config.ts',
  'sitemap.xml',
  'vite.config.cjs',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts'
] as const

const WEB_QUALITY_CONFIG_PATHS = [
  '.lighthouserc.js',
  '.lighthouserc.json',
  '.lighthouserc.yml',
  '.lighthouserc.yaml',
  '.pa11yci',
  '.pa11yci.json',
  '.percy.yml',
  '.storybook/main.js',
  '.storybook/main.ts',
  'axe.config.js',
  'axe.config.ts',
  'backstop.json',
  'cypress.config.cjs',
  'cypress.config.js',
  'cypress.config.mjs',
  'cypress.config.ts',
  'lighthouserc.js',
  'lighthouserc.json',
  'next-sitemap.config.js',
  'next-sitemap.config.mjs',
  'pa11y-ci.json',
  'playwright-ct.config.js',
  'playwright-ct.config.cjs',
  'playwright-ct.config.ts',
  'playwright.config.js',
  'playwright.config.cjs',
  'playwright.config.mjs',
  'playwright.config.ts',
  'public/robots.txt',
  'public/sitemap.xml'
] as const

const STATIC_EVIDENCE_PATHS = new Set<string>([
  ...CI_CONFIG_PATHS,
  ...PR_CONFIG_PATHS,
  ...SECURITY_CONFIG_PATHS,
  ...DEPLOY_CONFIG_PATHS,
  ...PUBLIC_UI_CONFIG_PATHS,
  ...WEB_QUALITY_CONFIG_PATHS,
  '.git',
  '.git/config',
  'package.json'
])

function normalizedRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Garante que nenhuma evidência arbitrária ou externa vaze para o relatório. */
export function isAllowlistedAdapterEvidencePath(value: string): boolean {
  const path = normalizedRelativePath(value)
  if (STATIC_EVIDENCE_PATHS.has(path)) return true
  if (path.startsWith('.github/workflows/')) {
    const name = path.slice('.github/workflows/'.length)
    return !name.includes('/') && SAFE_DYNAMIC_FILE.test(name)
  }
  if (path.startsWith('.github/PULL_REQUEST_TEMPLATE/')) {
    const name = path.slice('.github/PULL_REQUEST_TEMPLATE/'.length)
    return !name.includes('/') && SAFE_TEMPLATE_FILE.test(name)
  }
  return false
}

function isInsideRoot(root: string, file: string): boolean {
  const rel = relative(root, file)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function regularFile(file: string): boolean {
  try {
    // Symlinks are intentionally refused: detection must not escape through an
    // apparently allowlisted path.
    return lstatSync(file).isFile()
  } catch {
    return false
  }
}

function allowlistedFile(root: string, relativePath: string): string | undefined {
  const normalized = normalizedRelativePath(relativePath)
  if (!isAllowlistedAdapterEvidencePath(normalized)) return undefined
  const file = resolve(root, ...normalized.split('/'))
  return isInsideRoot(root, file) && regularFile(file) ? file : undefined
}

function readBounded(file: string): string | undefined {
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return undefined
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function existingStaticEvidence(
  root: string,
  paths: readonly string[],
  signal: string
): ProjectAdapterEvidence[] {
  return paths.flatMap((path) =>
    allowlistedFile(root, path) ? [{ path, signal }] : []
  )
}

function directAllowlistedFiles(
  root: string,
  directory: '.github/workflows' | '.github/PULL_REQUEST_TEMPLATE',
  accepted: RegExp
): Array<{ path: string; file: string }> {
  const absoluteDirectory = resolve(root, ...directory.split('/'))
  if (!isInsideRoot(root, absoluteDirectory)) return []
  let names: string[]
  try {
    if (!lstatSync(absoluteDirectory).isDirectory()) return []
    names = readdirSync(absoluteDirectory)
  } catch {
    return []
  }
  return names
    .filter((name) => accepted.test(name))
    .sort((left, right) => left.localeCompare(right, 'en'))
    .flatMap((name) => {
      const path = `${directory}/${name}`
      const file = allowlistedFile(root, path)
      return file ? [{ path, file }] : []
    })
}

function workflowFiles(root: string): Array<{ path: string; file: string }> {
  return directAllowlistedFiles(root, '.github/workflows', SAFE_DYNAMIC_FILE)
}

function pullRequestTemplateFiles(root: string): Array<{ path: string; file: string }> {
  return directAllowlistedFiles(root, '.github/PULL_REQUEST_TEMPLATE', SAFE_TEMPLATE_FILE)
}

function contentMatches(file: string, pattern: RegExp): boolean {
  const content = readBounded(file)
  return content !== undefined && pattern.test(content)
}

function hasRemoteSection(content: string): boolean {
  let insideRemote = false
  for (const line of content.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)]\s*(?:[#;].*)?$/)
    if (section) {
      insideRemote = /^remote\s+"[^"]+"\s*$/i.test(section[1])
      continue
    }
    if (insideRemote && /^\s*url\s*=\s*\S+/i.test(line)) return true
  }
  return false
}

function safeExternalGitFile(file: string): string | undefined {
  // Git worktrees point to metadata outside the checkout. Reading that local
  // metadata is safe, but it is never exposed as evidence or followed further
  // than the explicit gitdir/commondir chain.
  return regularFile(file) ? readBounded(file) : undefined
}

function remoteEvidence(root: string): ProjectAdapterEvidence | undefined {
  const dotGit = resolve(root, '.git')
  try {
    const stat = lstatSync(dotGit)
    if (stat.isDirectory()) {
      const config = join(dotGit, 'config')
      const content = safeExternalGitFile(config)
      return content && hasRemoteSection(content)
        ? { path: '.git/config', signal: 'remote Git configurado' }
        : undefined
    }
    if (!stat.isFile()) return undefined
  } catch {
    return undefined
  }

  const pointer = readBounded(dotGit)?.match(/^\s*gitdir:\s*(.+?)\s*$/im)?.[1]
  if (!pointer) return undefined
  const gitDirectory = resolve(dirname(dotGit), pointer)
  const directConfig = safeExternalGitFile(join(gitDirectory, 'config'))
  if (directConfig && hasRemoteSection(directConfig)) {
    return { path: '.git', signal: 'remote Git configurado no worktree' }
  }
  const commonPointer = safeExternalGitFile(join(gitDirectory, 'commondir'))?.trim()
  if (!commonPointer) return undefined
  const commonConfig = safeExternalGitFile(resolve(gitDirectory, commonPointer, 'config'))
  return commonConfig && hasRemoteSection(commonConfig)
    ? { path: '.git', signal: 'remote Git configurado no repositório comum' }
    : undefined
}

function readPackageScripts(root: string): Record<string, string> {
  const file = allowlistedFile(root, 'package.json')
  if (!file) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const scripts = (parsed as { scripts?: unknown }).scripts
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return {}
    return Object.fromEntries(
      Object.entries(scripts as Record<string, unknown>).filter(
        (entry): entry is [string, string] =>
          SAFE_SCRIPT_NAME.test(entry[0]) && typeof entry[1] === 'string'
      )
    )
  } catch {
    return {}
  }
}

function packageDeclaresPublicUi(root: string): boolean {
  const file = allowlistedFile(root, 'package.json')
  if (!file) return false
  try {
    const content = readBounded(file)
    if (content === undefined) return false
    const parsed: unknown = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const pkg = parsed as Record<string, unknown>
    const dependencyNames = new Set<string>()
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const dependencies = pkg[field]
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue
      for (const name of Object.keys(dependencies)) dependencyNames.add(name.toLowerCase())
    }
    if (
      [
        '@angular/core',
        '@builder.io/qwik',
        '@remix-run/react',
        '@stencil/core',
        '@sveltejs/kit',
        'astro',
        'ember-source',
        'gatsby',
        'next',
        'nuxt',
        'preact',
        'react-dom',
        'solid-js',
        'svelte',
        'vue'
      ].some((name) => dependencyNames.has(name))
    ) return true

    const scripts = pkg.scripts
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return false
    return Object.values(scripts).some(
      (body) =>
        typeof body === 'string' &&
        /(?:^|\s)(?:astro|gatsby|next|nuxt|remix|svelte-kit|vite)(?:\s|$)/i.test(body)
    )
  } catch {
    return false
  }
}

function packageManager(root: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  const candidates: Array<[string, 'npm' | 'pnpm' | 'yarn' | 'bun']> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm']
  ]
  for (const [path, manager] of candidates) {
    if (regularFile(resolve(root, path))) return manager
  }
  try {
    const parsed = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      packageManager?: unknown
    }
    const declared = typeof parsed.packageManager === 'string'
      ? parsed.packageManager.split('@', 1)[0]?.toLowerCase()
      : ''
    if (declared === 'npm' || declared === 'pnpm' || declared === 'yarn' || declared === 'bun') {
      return declared
    }
  } catch {
    // npm is the deterministic fallback for a package.json without a declaration.
  }
  return 'npm'
}

function normalizedScriptName(name: string): string {
  return name.toLowerCase().replace(/_/g, '-').replace(/dryrun/g, 'dry-run')
}

function scriptTokens(name: string): string[] {
  return normalizedScriptName(name).split(/[:.]/).flatMap((part) => part.split('-'))
}

function moduleNamedInScript(name: string, kind: ProjectAdapterKind): boolean {
  const normalized = normalizedScriptName(name)
  const tokens = scriptTokens(name)
  if (kind === 'ci') return tokens.includes('ci')
  if (kind === 'pull_request') {
    return tokens.includes('pr') || /(?:^|[:.])pull-request(?:$|[:.])/.test(normalized)
  }
  if (kind === 'security') {
    return tokens.some((token) =>
      [
        'audit',
        'codeql',
        'cve',
        'dependencies',
        'dependency',
        'deps',
        'gitleaks',
        'osv',
        'reachability',
        'sast',
        'sca',
        'secure',
        'security',
        'semgrep',
        'trivy',
        'vulnerabilities',
        'vulnerability'
      ].includes(token)
    )
  }
  if (kind === 'web_quality') {
    return tokens.some((token) =>
      [
        'a11y',
        'accessibility',
        'animation',
        'axe',
        'backstop',
        'breakpoint',
        'canonical',
        'contrast',
        'cypress',
        'e2e',
        'keyboard',
        'lighthouse',
        'lhci',
        'mobile',
        'motion',
        'pa11y',
        'performance',
        'percy',
        'playwright',
        'responsive',
        'responsiveness',
        'regression',
        'robots',
        'screenreader',
        'seo',
        'sitemap',
        'screenshot',
        'viewport',
        'visual',
        'wcag',
        'web',
        'webvitals'
      ].includes(token)
    ) || /(?:^|[:.])(?:reduced-motion|screen-reader)(?:$|[:.])/.test(normalized)
  }
  return tokens.some((token) => ['deploy', 'deployment', 'hosting'].includes(token))
}

function explicitlyVerificationScript(name: string, kind: ProjectAdapterKind): boolean {
  const normalized = normalizedScriptName(name)
  const tokens = scriptTokens(name)
  const base =
    tokens.some((token) => ['check', 'validate', 'verify'].includes(token)) ||
    normalized.split(/[:.]/).includes('dry-run')
  if (base) return true
  if (kind === 'security') return tokens.includes('audit')
  if (kind !== 'web_quality') return false
  return tokens.some((token) =>
    [
      'a11y',
      'accessibility',
      'animation',
      'audit',
      'axe',
      'backstop',
      'breakpoint',
      'canonical',
      'contrast',
      'cypress',
      'e2e',
      'keyboard',
      'lighthouse',
      'mobile',
      'motion',
      'pa11y',
      'performance',
      'percy',
      'playwright',
      'responsive',
      'regression',
      'robots',
      'screenreader',
      'seo',
      'sitemap',
      'screenshot',
      'test',
      'viewport',
      'visual',
      'wcag'
    ].includes(token)
  ) || /(?:^|[:.])(?:reduced-motion|screen-reader)(?:$|[:.])/.test(normalized)
}

/**
 * Tokeniza apenas o pequeno subconjunto de shell necessário para scripts de
 * verificação. Redirecionamentos, pipes, background, subshells e substituição
 * de comandos são recusados antes mesmo de olhar o nome do executável.
 */
function tokenizeReadOnlyScript(body: string): string[][] | undefined {
  if (
    body.includes('\0') ||
    // A expansão acontece antes de o validador receber os argumentos e poderia
    // injetar `--fix`, `--write` ou até outro comando. A recusa é intencionalmente
    // independente de aspas porque npm usa shells diferentes em cada plataforma.
    /[`<>$%]|![A-Za-z_][A-Za-z0-9_]*!|[<>]\(/.test(body)
  ) {
    return undefined
  }
  const commands: string[][] = []
  let tokens: string[] = []
  let token = ''
  let tokenStarted = false
  let quote: "'" | '"' | undefined
  let requiresCommandAfterAnd = false

  const finishToken = (): void => {
    if (!tokenStarted) return
    tokens.push(token)
    token = ''
    tokenStarted = false
  }
  const finishCommand = (): boolean => {
    finishToken()
    if (tokens.length === 0) return false
    commands.push(tokens)
    tokens = []
    return true
  }

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (quote) {
      if (char === quote) {
        quote = undefined
      } else if (char === '\\' && quote === '"' && index + 1 < body.length) {
        token += body[index + 1]
        tokenStarted = true
        index += 1
      } else {
        token += char
        tokenStarted = true
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      tokenStarted = true
      requiresCommandAfterAnd = false
      continue
    }
    if (/\s/.test(char)) {
      // Uma nova linha executaria o próximo comando mesmo se o anterior falhar
      // e poderia mascarar a verificação. Encadeamento só é aceito com &&.
      if (char === '\n' || char === '\r') return undefined
      finishToken()
      continue
    }
    if (char === '\\') {
      if (index + 1 >= body.length) return undefined
      token += body[index + 1]
      tokenStarted = true
      requiresCommandAfterAnd = false
      index += 1
      continue
    }
    if (char === ';' || char === '|') return undefined
    if (char === '&') {
      if (body[index + 1] !== '&') return undefined
      if (!finishCommand()) return undefined
      requiresCommandAfterAnd = true
      index += 1
      continue
    }
    if (char === '(' || char === ')') return undefined
    token += char
    tokenStarted = true
    requiresCommandAfterAnd = false
  }
  if (quote || requiresCommandAfterAnd) return undefined
  if (tokens.length > 0 || tokenStarted) {
    if (!finishCommand()) return undefined
  }
  return commands.length > 0 ? commands : undefined
}

function normalizedExecutable(value: string): string {
  return value.toLowerCase().replace(/\.(?:cmd|exe)$/i, '')
}

function exactFlag(args: string[], ...flags: string[]): boolean {
  const accepted = new Set(flags.map((flag) => flag.toLowerCase()))
  return args.some((arg) => accepted.has(arg.toLowerCase()))
}

function flagWithValue(args: string[], ...flags: string[]): boolean {
  return args.some((arg) => {
    const lower = arg.toLowerCase()
    return flags.some((flag) => lower === flag || lower.startsWith(`${flag}=`))
  })
}

function forbiddenTestMutation(args: string[]): boolean {
  return flagWithValue(
    args.map((arg) => arg.toLowerCase()),
    '--watch',
    '--watchall',
    '--update-snapshot',
    '--updatesnapshot',
    '--update-snapshots',
    '--ui',
    '--record'
  ) || flagWithValue(args, '-u', '--snapshot-update')
}

function hasSafeSecretRedaction(args: string[]): boolean {
  return args.some((arg) => {
    const lower = arg.toLowerCase()
    return lower === '--redact' || /^--redact=(?:true|[1-9]\d?|100)$/.test(lower)
  })
}

function optionValues(args: string[], ...flags: string[]): string[] | undefined {
  const accepted = flags.map((flag) => flag.toLowerCase())
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const lower = args[index].toLowerCase()
    const exactIndex = accepted.indexOf(lower)
    if (exactIndex >= 0) {
      const value = args[index + 1]
      if (!value || value.startsWith('-')) return undefined
      values.push(value)
      index += 1
      continue
    }
    const flag = accepted.find((candidate) => lower.startsWith(`${candidate}=`))
    if (!flag) continue
    const value = args[index].slice(flag.length + 1)
    if (!value) return undefined
    values.push(value)
  }
  return values
}

function localWebTarget(value: string): boolean {
  try {
    const target = new URL(value)
    return (
      (target.protocol === 'http:' || target.protocol === 'https:') &&
      ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname.toLowerCase()) &&
      !target.username &&
      !target.password
    )
  } catch {
    return false
  }
}

function containsExternalHttpTarget(value: string): boolean {
  const targets = value.match(/https?:\/\/[^\s,;]+/gi) ?? []
  return targets.some((target) => !localWebTarget(target))
}

function safeLocalConfigValue(value: string): boolean {
  const normalized = value.replace(/\\/g, '/')
  if (!normalized || /(?:^|\/)\.\.(?:\/|$)/.test(normalized)) return false
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|\\|[a-z]:[\/\\])/i.test(value)) return false
  return !/^(?:auto|policy|[pr]\/)/i.test(normalized)
}

function directReadOnlyValidator(tokens: string[]): boolean {
  if (tokens.length === 0) return false
  const executable = normalizedExecutable(tokens[0])
  const args = tokens.slice(1)
  const lower = args.map((arg) => arg.toLowerCase())
  if (args.some(containsExternalHttpTarget)) return false

  if (executable === 'actionlint' || executable === 'shellcheck' || executable === 'hadolint') {
    return true
  }
  if (executable === 'node') {
    if (lower[0] === '--check' || lower[0] === '-c') {
      return args.length === 2 && !!args[1] && !args[1].startsWith('-')
    }
    return lower[0] === '--test' && !forbiddenTestMutation(args)
  }
  if (executable === 'tsc') {
    const noEmitIndex = lower.indexOf('--noemit')
    return (
      noEmitIndex >= 0 &&
      lower[noEmitIndex + 1] !== 'false' &&
      !flagWithValue(args, '--watch', '--incremental', '--tsbuildinfofile', '--generatetrace') &&
      !exactFlag(args, '-w')
    )
  }
  if (executable === 'eslint' || executable === 'stylelint') {
    return !flagWithValue(args, '--fix', '--output-file', '--cache', '--cache-location', '--init') &&
      !exactFlag(args, '-o')
  }
  if (executable === 'biome') {
    return lower[0] === 'check' &&
      !flagWithValue(args, '--write', '--fix', '--unsafe')
  }
  if (executable === 'prettier') {
    return exactFlag(args, '--check') &&
      !flagWithValue(args, '--write', '--cache', '--cache-location') &&
      !exactFlag(args, '-w')
  }
  if (executable === 'ruff') {
    const readOnlyMode = lower[0] === 'check' || (lower[0] === 'format' && exactFlag(args, '--check'))
    return readOnlyMode && !flagWithValue(args, '--fix', '--output-file', '--add-noqa')
  }
  if (executable === 'vitest') {
    return (lower[0] === 'run' || exactFlag(args, '--run')) && !forbiddenTestMutation(args)
  }
  if (['jest', 'mocha', 'ava', 'tap', 'uvu'].includes(executable)) {
    return !forbiddenTestMutation(args)
  }
  if (executable === 'playwright') {
    return lower[0] === 'test' && !forbiddenTestMutation(args)
  }
  if (executable === 'cypress') {
    return lower[0] === 'run' && !forbiddenTestMutation(args)
  }
  if (executable === 'pytest') return !forbiddenTestMutation(args)
  if (['python', 'python3', 'py'].includes(executable)) {
    return lower[0] === '-m' && lower[1] === 'pytest' && !forbiddenTestMutation(args.slice(2))
  }
  if (executable === 'cargo') {
    return ['check', 'test', 'clippy'].includes(lower[0] ?? '') &&
      !flagWithValue(args, '--fix') &&
      !forbiddenTestMutation(args)
  }
  if (executable === 'go' || executable === 'dotnet') {
    return lower[0] === 'test' && !forbiddenTestMutation(args)
  }
  if (['mvn', 'mvnw'].includes(executable)) {
    return lower.includes('test') &&
      !lower.some((arg) => /^(?:deploy|install|release(?::|$))/.test(arg)) &&
      !forbiddenTestMutation(args)
  }
  if (['gradle', 'gradlew'].includes(executable)) {
    return lower.some((arg) => /(?:^|:)test(?:[a-z0-9_-]*)$/.test(arg)) &&
      !lower.some((arg) => /(?:^|:)(?:publish|deploy|upload|release)(?:[a-z0-9_-]*)$/.test(arg)) &&
      !forbiddenTestMutation(args)
  }
  if (executable === 'gitleaks') {
    return lower[0] === 'detect' &&
      hasSafeSecretRedaction(args) &&
      !flagWithValue(args, '--report-path', '--report-format')
  }
  if (executable === 'semgrep') {
    const scanArgs = lower[0] === 'scan' ? args.slice(1) : args
    const configs = optionValues(scanArgs, '--config', '-c')
    return lower[0] !== 'ci' &&
      configs !== undefined &&
      configs.length > 0 &&
      configs.every(safeLocalConfigValue) &&
      !flagWithValue(
        scanArgs,
        '--autofix',
        '--output',
        '--json-output',
        '--sarif-output',
        '--text-output'
      ) &&
      !exactFlag(scanArgs, '-o')
  }
  if (executable === 'lighthouse') {
    const outputPaths = optionValues(args, '--output-path')
    return (
      localWebTarget(args[0] ?? '') &&
      outputPaths !== undefined &&
      outputPaths.length === 1 &&
      outputPaths[0].toLowerCase() === 'stdout' &&
      !flagWithValue(args, '--save-assets', '--view', '--upload')
    )
  }
  if (executable === 'pa11y') {
    // A forma mínima não carrega configuração executável nem grava relatório;
    // o resultado segue exclusivamente para stdout.
    return args.length === 1 && localWebTarget(args[0])
  }
  if (executable === 'trivy') {
    return ['config', 'fs'].includes(lower[0] ?? '') &&
      !flagWithValue(args, '--output') &&
      !exactFlag(args, '-o')
  }
  if (executable === 'terraform') {
    if (lower[0] === 'validate') return true
    if (lower[0] !== 'fmt' || !exactFlag(args, '-check', '-check=true')) return false
    return !exactFlag(args, '-write', '-write=true')
  }
  if (executable === 'helm') return lower[0] === 'lint'
  if (executable === 'docker') {
    return lower[0] === 'compose' && lower[1] === 'config' &&
      !flagWithValue(args, '--output') &&
      !exactFlag(args, '-o')
  }
  if (executable === 'docker-compose') {
    return lower[0] === 'config' &&
      !flagWithValue(args, '--output') &&
      !exactFlag(args, '-o')
  }
  return false
}

function calledPackageScript(tokens: string[]): string | undefined {
  const executable = normalizedExecutable(tokens[0] ?? '')
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) return undefined
  if (tokens.length === 3 && tokens[1].toLowerCase() === 'run') return tokens[2]
  return undefined
}

function safeVerificationBody(
  name: string,
  scripts: Record<string, string>,
  visiting = new Set<string>()
): boolean {
  if (visiting.has(name)) return false
  const body = scripts[name]
  if (typeof body !== 'string' || body.trim() === '') return false
  const next = new Set(visiting)
  next.add(name)
  // npm/pnpm/yarn/bun podem executar estes hooks implicitamente, portanto o
  // comando principal somente é seguro quando ambos também são seguros.
  for (const hook of [`pre${name}`, `post${name}`]) {
    if (hook in scripts && !safeVerificationBody(hook, scripts, next)) return false
  }
  const commands = tokenizeReadOnlyScript(body)
  if (!commands) return false
  for (const command of commands) {
    const called = calledPackageScript(command)
    if (called) {
      if (!SAFE_SCRIPT_NAME.test(called) || !safeVerificationBody(called, scripts, next)) return false
      continue
    }
    if (!directReadOnlyValidator(command)) return false
  }
  return true
}

/**
 * Qualidade web automática é deliberadamente mais estreita que testes de
 * projeto comuns. Playwright/Cypress/Vitest e `node --test` executam JavaScript
 * arbitrário do repositório; eles permanecem evidência, mas não são disparados
 * pelo harness. Somente scanners passivos, locais e sem config executável entram.
 */
function safePassiveWebQualityBody(name: string, scripts: Record<string, string>): boolean {
  if (`pre${name}` in scripts || `post${name}` in scripts) return false
  const commands = tokenizeReadOnlyScript(scripts[name] ?? '')
  if (!commands || commands.length !== 1) return false
  const executable = normalizedExecutable(commands[0][0] ?? '')
  if (executable !== 'lighthouse' && executable !== 'pa11y') return false
  return directReadOnlyValidator(commands[0])
}

function verificationCommands(
  root: string,
  kind: ProjectAdapterKind,
  scripts: Record<string, string>
): ProjectAdapterVerificationCommand[] {
  const manager = packageManager(root)
  return Object.keys(scripts)
    .filter(
      (name) =>
        moduleNamedInScript(name, kind) &&
        explicitlyVerificationScript(name, kind) &&
        (kind === 'web_quality'
          ? safePassiveWebQualityBody(name, scripts)
          : safeVerificationBody(name, scripts))
    )
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((name) => ({
      id: `adapter:${kind}:node:${name}`,
      label: `${manager} run ${name}`,
      command: manager,
      args: ['run', name],
      cwd: root,
      sourcePath: 'package.json',
      timeoutMs: 120_000
    }))
}

function uniqueEvidence(evidence: ProjectAdapterEvidence[]): ProjectAdapterEvidence[] {
  const byKey = new Map<string, ProjectAdapterEvidence>()
  for (const item of evidence) {
    if (!isAllowlistedAdapterEvidencePath(item.path)) continue
    byKey.set(`${item.path}\0${item.signal}`, item)
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.path.localeCompare(right.path, 'en') || left.signal.localeCompare(right.signal, 'en')
  )
}

function detection(
  kind: ProjectAdapterKind,
  active: boolean,
  evidence: ProjectAdapterEvidence[],
  missingSignals: string[],
  commands: ProjectAdapterVerificationCommand[]
): ProjectAdapterDetection {
  return {
    kind,
    state: active ? 'active' : 'not_configured',
    evidence: uniqueEvidence(evidence),
    missingSignals: active ? [] : missingSignals,
    verificationCommands: active ? commands : []
  }
}

export function detectProjectAdapters(
  options: DetectProjectAdaptersOptions
): ProjectAdapterDetection[] {
  const root = resolve(options.root)
  const workflows = workflowFiles(root)
  const scripts = readPackageScripts(root)

  const ciEvidence = [
    ...existingStaticEvidence(root, CI_CONFIG_PATHS, 'configuração de CI'),
    ...workflows.map(({ path }) => ({ path, signal: 'workflow de CI' }))
  ]

  const remote = remoteEvidence(root)
  const prEvidence = [
    ...existingStaticEvidence(root, PR_CONFIG_PATHS, 'configuração de pull request'),
    ...pullRequestTemplateFiles(root).map(({ path }) => ({
      path,
      signal: 'template de pull request'
    })),
    ...workflows.flatMap(({ path, file }) =>
      contentMatches(file, /\bpull_request(?:_target)?\b/i)
        ? [{ path, signal: 'workflow acionado por pull request' }]
        : []
    )
  ]
  const prActive = !!remote && prEvidence.length > 0
  const completePrEvidence = remote ? [remote, ...prEvidence] : prEvidence
  const prMissing = [
    ...(!remote ? ['remote_git'] : []),
    ...(prEvidence.length === 0 ? ['pr_template_or_config'] : [])
  ]

  const securityScriptSignal = Object.keys(scripts).some((name) =>
    moduleNamedInScript(name, 'security')
  )
  const securityEvidence = [
    ...existingStaticEvidence(root, SECURITY_CONFIG_PATHS, 'configuração de segurança'),
    ...workflows.flatMap(({ path, file }) =>
      contentMatches(
        file,
        /(?:github\/codeql-action|dependency-review-action|\b(?:snyk|semgrep|trivy|gitleaks|osv-scanner|pip-audit|cargo\s+audit|npm\s+audit|pnpm\s+audit)\b)/i
      )
        ? [{ path, signal: 'verificação de segurança no workflow' }]
        : []
    ),
    ...(securityScriptSignal
      ? [{ path: 'package.json', signal: 'script de segurança declarado' }]
      : [])
  ]

  const deployEvidence = [
    ...existingStaticEvidence(root, DEPLOY_CONFIG_PATHS, 'configuração de hosting/deploy'),
    ...workflows.flatMap(({ path, file }) =>
      contentMatches(
        file,
        /(?:\benvironment\s*:|\bdeployment\b|\bdeploy(?:ment)?\b|vercel-action|netlify|cloudflare|wrangler|flyctl|firebase|railway|render\.com)/i
      )
        ? [{ path, signal: 'workflow de deploy' }]
        : []
    )
  ]

  const publicUiEvidence = [
    ...existingStaticEvidence(root, PUBLIC_UI_CONFIG_PATHS, 'interface web pública configurada'),
    ...(packageDeclaresPublicUi(root)
      ? [{ path: 'package.json', signal: 'framework ou runtime web declarado' }]
      : [])
  ]
  const webQualityScriptSignal = Object.keys(scripts).some((name) =>
    moduleNamedInScript(name, 'web_quality')
  )
  const webQualityEvidence = [
    ...existingStaticEvidence(
      root,
      WEB_QUALITY_CONFIG_PATHS,
      'configuração local de qualidade web'
    ),
    ...workflows.flatMap(({ path, file }) =>
      contentMatches(
        file,
        /\b(?:axe(?:-core)?|pa11y|lighthouse|lhci|playwright|backstop|percy|wcag|accessibility|a11y|reduced[ -]?motion|visual regression|seo)\b/i
      )
        ? [{ path, signal: 'verificação de qualidade web no workflow' }]
        : []
    ),
    ...(webQualityScriptSignal
      ? [{ path: 'package.json', signal: 'script de qualidade web declarado' }]
      : [])
  ]
  const webQualityActive = publicUiEvidence.length > 0 && webQualityEvidence.length > 0
  const webQualityMissing = [
    ...(publicUiEvidence.length === 0 ? ['public_ui'] : []),
    ...(webQualityEvidence.length === 0 ? ['web_quality_script_or_config'] : [])
  ]

  return [
    detection(
      'ci',
      ciEvidence.length > 0,
      ciEvidence,
      ['workflow_or_ci_config'],
      verificationCommands(root, 'ci', scripts)
    ),
    detection(
      'pull_request',
      prActive,
      completePrEvidence,
      prMissing,
      verificationCommands(root, 'pull_request', scripts)
    ),
    detection(
      'security',
      securityEvidence.length > 0,
      securityEvidence,
      ['security_script_or_config'],
      verificationCommands(root, 'security', scripts)
    ),
    detection(
      'deploy',
      deployEvidence.length > 0,
      deployEvidence,
      ['hosting_or_deploy_config'],
      verificationCommands(root, 'deploy', scripts)
    ),
    detection(
      'web_quality',
      webQualityActive,
      [...publicUiEvidence, ...webQualityEvidence],
      webQualityMissing,
      verificationCommands(root, 'web_quality', scripts)
    )
  ]
}

const ADAPTER_PRIORITY: readonly ProjectAdapterKind[] = [
  'security',
  'deploy',
  'ci',
  'pull_request',
  'web_quality'
]

const WEB_QUALITY_PRIORITY: readonly ProjectAdapterKind[] = [
  'security',
  'web_quality',
  'deploy',
  'ci',
  'pull_request'
]

function searchableText(values: string[]): string {
  return values
    .join(' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_/]+/g, '-')
}

function relevantSecuritySurface(searchable: string): boolean {
  return /(?:^|[^a-z0-9])(?:security|seguranca|secure|auth(?:entication|orization)?|autenticacao|autorizacao|login|credential|secret|secrets|payment|payments|pagamento|pagamentos|billing|checkout|tenant-boundary|file-upload|admin-support|ai-agents|external-integration|abuse-controls|logging-errors|security-configuration|supply-chain|public-contract|concurrency|cryptography|criptografia|data-exposure|data-sensitive|sensitive-data|dados-sensiveis|personal-data|destructive-data|data-migration|privacy|privacidade|pii)(?:$|[^a-z0-9])/.test(
    searchable
  )
}

function relevantDeploySurface(searchable: string): boolean {
  return /(?:^|[^a-z0-9])(?:release|deploy(?:ment)?|infra(?:structure|estrutura)?|hosting|production|producao)(?:$|[^a-z0-9])/.test(
    searchable
  )
}

function missionMentionsPullRequest(missionText: string): boolean {
  const searchable = searchableText([missionText])
  return /(?:^|[^a-z0-9])(?:pr|pull(?:-|\s)+request|merge(?:-|\s)+request)(?:$|[^a-z0-9])/.test(
    searchable
  )
}

function missionMentionsWebQuality(missionText: string): boolean {
  const searchable = searchableText([missionText])
  return /(?:^|[^a-z0-9])(?:a11y|acessibilidade|animacao|animation|axe|front-end|frontend|interface (?:do usuario|publica|visual|web)|lighthouse|movimento reduzido|pagina|pa11y|playwright|prefers-reduced-motion|reduced-motion|responsiv(?:a|idade|e)|seo|site|tela|ui|viewport|visual|wcag|web vitals)(?:$|[^a-z0-9])/.test(
    searchable
  )
}

function commandSortKey(command: ProjectAdapterVerificationCommand): string {
  return [
    command.id,
    command.command,
    command.args.join('\0'),
    command.cwd,
    command.label
  ].join('\0')
}

function activeCommandsByKind(
  detections: ProjectAdapterDetection[]
): Map<ProjectAdapterKind, ProjectAdapterVerificationCommand[]> {
  const result = new Map<ProjectAdapterKind, ProjectAdapterVerificationCommand[]>()
  for (const kind of ADAPTER_PRIORITY) {
    const commands = detections
      .filter((detection) => detection.kind === kind && detection.state === 'active')
      .flatMap((detection) => detection.verificationCommands)
      .sort((left, right) => commandSortKey(left).localeCompare(commandSortKey(right), 'en'))
    const unique = new Map<string, ProjectAdapterVerificationCommand>()
    for (const command of commands) unique.set(commandSortKey(command), command)
    if (unique.size > 0) result.set(kind, [...unique.values()])
  }
  return result
}

/**
 * Seleciona somente a parcela proporcional dos adaptadores opcionais.
 *
 * O teto final é imposto aqui: FAST/STANDARD executam no máximo um comando e
 * DEEP no máximo dois. Dentro desse teto, a seleção pega um comando de cada
 * módulo relevante antes de repetir um deles.
 */
export function selectProjectAdapterCommands(
  options: SelectProjectAdapterCommandsOptions
): ProjectAdapterVerificationCommand[] {
  const proportionalCap = options.mode === 'deep' ? 2 : 1
  const maxCommands = Number.isFinite(options.maxCommands)
    ? Math.min(proportionalCap, Math.max(0, Math.floor(options.maxCommands)))
    : 0
  if (maxCommands === 0) return []

  const surfaces = searchableText(options.riskSurfaces)
  const securityRelevant = relevantSecuritySurface(surfaces)
  const deployRelevant = relevantDeploySurface(surfaces)
  const pullRequestRelevant =
    options.mode === 'deep' || missionMentionsPullRequest(options.missionText)
  const webQualityRelevant = missionMentionsWebQuality(options.missionText)
  const ciRelevant = options.mode !== 'fast' || options.risk === 'high'
  const explicitlyRelevant =
    securityRelevant ||
    deployRelevant ||
    missionMentionsPullRequest(options.missionText) ||
    webQualityRelevant

  // FAST não ganha uma etapa opcional por padrão. Ela existe apenas quando o
  // risco alto ou uma superfície citada pela missão justifica o custo.
  if (options.mode === 'fast' && options.risk !== 'high' && !explicitlyRelevant) return []

  const relevance: Record<ProjectAdapterKind, boolean> = {
    security: securityRelevant,
    deploy: deployRelevant,
    ci: ciRelevant,
    pull_request: pullRequestRelevant,
    web_quality: webQualityRelevant
  }
  const moduleLimit = options.mode === 'deep' ? 2 : 1
  const available = activeCommandsByKind(options.detections)
  const priority = webQualityRelevant ? WEB_QUALITY_PRIORITY : ADAPTER_PRIORITY
  const selectedKinds = priority.filter(
    (kind) => relevance[kind] && (available.get(kind)?.length ?? 0) > 0
  ).slice(0, moduleLimit)
  if (selectedKinds.length === 0) return []

  const selected: ProjectAdapterVerificationCommand[] = []
  let round = 0
  while (selected.length < maxCommands) {
    let added = false
    for (const kind of selectedKinds) {
      const command = available.get(kind)?.[round]
      if (!command) continue
      selected.push(command)
      added = true
      if (selected.length >= maxCommands) break
    }
    if (!added) break
    round += 1
  }
  return selected
}
