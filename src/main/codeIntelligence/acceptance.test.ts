import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { DocumentStore } from './documents'
import { LspClient, LspTransportError } from './lspClient'
import { CodeIntelligenceManager } from './manager'
import { detectTypeScriptServer, resolveAuthorizedFile } from './servers'
import { CodeIntelligenceError } from './types'

const SOURCE = [
  'export function greet(name: string): string {',
  '  return `hello ${name}`',
  '}',
  '',
  "export const result = greet('Synkora')",
  ''
].join('\n')

async function fixture(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: prefix, private: true }))
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' }, include: ['src'] })
  )
  await writeFile(join(root, 'sample.ts'), SOURCE)
  return root
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  })
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed: ${String(result.stderr || result.stdout).trim()}`
  )
}

function sourceFor(marker: string): string {
  return [
    `export const branchValue = '${marker}' as const`,
    'export function readBranch(): string {',
    '  return branchValue',
    '}',
    ''
  ].join('\n')
}

async function fakeBundledTypeScriptRuntime(container: string): Promise<{
  appRoot: string
  command: string
}> {
  const appRoot = join(container, 'packaged-app')
  const platformRoot = join(
    appRoot,
    'node_modules',
    '@typescript',
    `typescript-${process.platform}-${process.arch}`
  )
  const command = join(platformRoot, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc')
  await Promise.all([
    mkdir(join(appRoot, 'node_modules', 'typescript'), { recursive: true }),
    mkdir(join(platformRoot, 'lib'), { recursive: true })
  ])
  await Promise.all([
    writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: 'packaged-app', private: true })),
    writeFile(
      join(appRoot, 'node_modules', 'typescript', 'package.json'),
      JSON.stringify({ name: 'typescript', version: '7.0.2' })
    ),
    writeFile(
      join(platformRoot, 'package.json'),
      JSON.stringify({
        name: `@typescript/typescript-${process.platform}-${process.arch}`,
        version: '7.0.2'
      })
    ),
    writeFile(command, '')
  ])
  return { appRoot, command }
}

test('shares one native TypeScript server and returns deterministic compact results', async () => {
  const root = await fixture('synkora-lsp-shared-')
  const manager = new CodeIntelligenceManager({
    appRoot: process.cwd(),
    idleTtlMs: 5_000,
    requestTimeoutMs: 5_000
  })
  const first = manager.openWorkspace(root, 'pane-a')
  const second = manager.openWorkspace(root, 'pane-b')
  try {
    const symbols = await first.symbols('sample.ts', { limit: 1 })
    assert.equal(symbols.server.kind, 'typescript-native')
    assert.equal(symbols.server.version, '7.0.2')
    assert.equal(symbols.offset, 0)
    assert.equal(symbols.items.length, 1)
    assert.ok(symbols.total >= 2)
    assert.equal(symbols.truncated, true)

    const next = await second.symbols('sample.ts', { offset: 1, limit: 1 })
    assert.equal(next.total, symbols.total)
    assert.notDeepEqual(next.items, symbols.items)

    const useSite = { line: 5, column: 24 }
    const definition = await second.definition('sample.ts', useSite)
    assert.ok(definition.total >= 1)
    assert.equal(definition.items[0]?.path, 'sample.ts')
    const references = await second.references('sample.ts', useSite)
    assert.ok(references.total >= 2)
    const hover = await second.hover('sample.ts', useSite)
    assert.ok(hover.items[0]?.contents.includes('greet'))
    const implementations = await second.implementations('sample.ts', useSite)
    assert.equal(implementations.operation, 'implementations')
    const calls = await second.callHierarchy('sample.ts', { line: 1, column: 18 })
    assert.equal(calls.operation, 'call_hierarchy')

    const snapshot = manager.snapshot()
    assert.equal(snapshot.processCount, 1)
    assert.equal(snapshot.entries[0]?.owners, 2)
    assert.ok(snapshot.documentBytes > 0)

    first.close()
    assert.equal(manager.snapshot().processCount, 1)

    const missingStatus = await second.diagnosticsStatus()
    assert.equal(missingStatus.state, 'missing')
    assert.equal('errorCount' in missingStatus, false)
    assert.equal('warningCount' in missingStatus, false)
    const missingGuard = await second.diagnosticsGuard('sample.ts')
    assert.equal(missingGuard.state, 'missing')
    assert.equal('errorCount' in missingGuard, false)
    assert.equal('warningCount' in missingGuard, false)

    const diagnostics = await second.diagnostics('sample.ts')
    assert.equal(diagnostics.synchronization.state, 'current')
    assert.equal(diagnostics.items.filter((item) => item.severity === 'error').length, 0)
    const cleanStatus = await second.diagnosticsStatus()
    assert.equal(cleanStatus.state, 'current')
    assert.equal(cleanStatus.errorCount, 0)
    assert.equal(cleanStatus.warningCount, 0)
    const cleanGuard = await second.diagnosticsGuard('sample.ts')
    assert.equal(cleanGuard.state, 'current')
    assert.equal(cleanGuard.errorCount, 0)
    assert.equal(cleanGuard.warningCount, 0)

    await writeFile(join(root, 'sample.ts'), `${SOURCE}\nconst broken: string = 1\n`)
    const staleStatus = await second.diagnosticsStatus()
    assert.equal(staleStatus.state, 'stale')
    assert.equal('errorCount' in staleStatus, false)
    assert.equal('warningCount' in staleStatus, false)
    const staleGuard = await second.diagnosticsGuard('sample.ts')
    assert.equal(staleGuard.state, 'stale')
    assert.equal('errorCount' in staleGuard, false)
    assert.equal('warningCount' in staleGuard, false)

    const brokenDiagnostics = await second.diagnostics('sample.ts')
    const expectedErrors = brokenDiagnostics.items
      .filter((item) => item.severity === 'error')
      .length
    const expectedWarnings = brokenDiagnostics.items
      .filter((item) => item.severity === 'warning')
      .length
    assert.ok(expectedErrors >= 1)
    const brokenStatus = await second.diagnosticsStatus()
    assert.equal(brokenStatus.state, 'current')
    assert.equal(brokenStatus.errorCount, expectedErrors)
    assert.equal(brokenStatus.warningCount, expectedWarnings)
    const brokenGuard = await second.diagnosticsGuard('sample.ts')
    assert.equal(brokenGuard.state, 'current')
    assert.equal(brokenGuard.errorCount, expectedErrors)
    assert.equal(brokenGuard.warningCount, expectedWarnings)

    await assert.rejects(
      second.symbols('../outside.ts'),
      (error: unknown) => error instanceof CodeIntelligenceError
        && error.code === 'PATH_OUTSIDE_WORKTREE'
    )
  } finally {
    second.close()
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
})

// tsgo 7.0.2 monta o programa a partir do fecho de imports dos arquivos
// carregados: sem o priming de dependentes, referências/implementações/
// chamadas vindas de arquivos NUNCA abertos ficavam invisíveis (bug real,
// 2026-08-03 — a fixture de arquivo único jamais exercitava o caso).
test('finds references, implementations and incoming calls across files never opened', async () => {
  const root = await mkdtemp(join(tmpdir(), 'synkora-lsp-cross-file-'))
  const manager = new CodeIntelligenceManager({
    appRoot: process.cwd(),
    idleTtlMs: 10_000,
    requestTimeoutMs: 10_000
  })
  const session = manager.openWorkspace(root, 'cross-file-pane')
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'cross-file', private: true }))
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' }, include: ['**/*.ts'] })
    )
    await writeFile(
      join(root, 'lib.ts'),
      [
        'export interface Greeter {',
        '  greet(name: string): string',
        '}',
        'export function greetEveryone(name: string): string {',
        '  return `hi ${name}`',
        '}',
        ''
      ].join('\n')
    )
    await writeFile(
      join(root, 'consumer.ts'),
      [
        "import { type Greeter, greetEveryone } from './lib'",
        'export class LoudGreeter implements Greeter {',
        '  greet(name: string): string {',
        '    return greetEveryone(name).toUpperCase()',
        '  }',
        '}',
        ''
      ].join('\n')
    )
    await mkdir(join(root, 'nested'))
    await writeFile(
      join(root, 'nested', 'deep.ts'),
      [
        "import { greetEveryone } from '../lib'",
        "export const deepGreeting = greetEveryone('deep')",
        ''
      ].join('\n')
    )

    // consulta SEM nunca abrir consumer.ts/nested/deep.ts — só o lib.ts entra
    const declaration = { line: 4, column: 17 } // greetEveryone em lib.ts
    const references = await session.references('lib.ts', declaration)
    const referencePaths = new Set(references.items.map((item) => item.path))
    assert.ok(
      references.total >= 4,
      `esperava >= 4 referências cross-file, veio ${references.total}`
    )
    assert.ok(referencePaths.has('consumer.ts'), 'faltou referência em consumer.ts')
    assert.ok(referencePaths.has('nested/deep.ts'), 'faltou referência em nested/deep.ts')

    const implementations = await session.implementations('lib.ts', { line: 1, column: 18 })
    assert.ok(
      implementations.items.some((item) => item.path === 'consumer.ts'),
      'faltou implementação de Greeter em consumer.ts'
    )

    const calls = await session.callHierarchy('lib.ts', declaration, { direction: 'incoming' })
    assert.ok(
      calls.items.some((item) => 'from' in item && item.from.path === 'consumer.ts'),
      'faltou chamada de entrada vinda de consumer.ts'
    )
  } finally {
    session.close()
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('does not invent diagnostic counts when no compatible server is available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'synkora-lsp-unavailable-counts-'))
  const manager = new CodeIntelligenceManager({ appRoot: process.cwd() })
  const session = manager.openWorkspace(root, 'unavailable-pane')
  try {
    await writeFile(join(root, 'sample.py'), 'value = 1\n')
    await assert.rejects(
      session.diagnostics('sample.py'),
      (error: unknown) => error instanceof CodeIntelligenceError
        && error.code === 'UNSUPPORTED_LANGUAGE'
    )

    const status = await session.diagnosticsStatus()
    assert.equal(status.state, 'unavailable')
    assert.equal('errorCount' in status, false)
    assert.equal('warningCount' in status, false)

    const guard = await session.diagnosticsGuard('sample.py')
    assert.equal(guard.state, 'unavailable')
    assert.equal('errorCount' in guard, false)
    assert.equal('warningCount' in guard, false)
  } finally {
    session.close()
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('isolates worktrees, invalidates explicitly and expires idle processes', async () => {
  const firstRoot = await fixture('synkora-lsp-worktree-a-')
  const secondRoot = await fixture('synkora-lsp-worktree-b-')
  const manager = new CodeIntelligenceManager({
    appRoot: process.cwd(),
    maxServers: 8,
    idleTtlMs: 120
  })
  const first = manager.openWorkspace(firstRoot, 'worktree-a')
  const second = manager.openWorkspace(secondRoot, 'worktree-b')
  try {
    await Promise.all([first.symbols('sample.ts'), second.symbols('sample.ts')])
    assert.equal(manager.snapshot().processCount, 2)
    assert.equal(manager.invalidateWorktreeNow(firstRoot), 1)
    assert.equal(manager.snapshot().processCount, 1)
    second.close()
    await waitFor(() => manager.snapshot().processCount === 0)
  } finally {
    first.close()
    second.close()
    await manager.close()
    await Promise.all([
      rm(firstRoot, { recursive: true, force: true }),
      rm(secondRoot, { recursive: true, force: true })
    ])
  }
})

test('keeps references and hover isolated across divergent git worktrees', async () => {
  const container = await mkdtemp(join(tmpdir(), 'synkora-lsp-git-worktrees-'))
  const baseRoot = join(container, 'base')
  const branchRoot = join(container, 'feature')
  await mkdir(baseRoot)
  await writeFile(join(baseRoot, 'package.json'), JSON.stringify({ name: 'worktree-isolation' }))
  await writeFile(join(baseRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }))
  await writeFile(join(baseRoot, 'sample.ts'), sourceFor('BASE_ONLY'))
  git(baseRoot, ['init', '-b', 'main'])
  git(baseRoot, ['config', 'user.email', 'synkora-acceptance@example.invalid'])
  git(baseRoot, ['config', 'user.name', 'Synkora Acceptance'])
  git(baseRoot, ['add', '.'])
  git(baseRoot, ['commit', '-m', 'base fixture'])
  git(baseRoot, ['worktree', 'add', '-b', 'feature', branchRoot])
  await writeFile(join(branchRoot, 'sample.ts'), sourceFor('FEATURE_ONLY'))
  git(branchRoot, ['add', 'sample.ts'])
  git(branchRoot, ['commit', '-m', 'diverge feature fixture'])

  const manager = new CodeIntelligenceManager({
    appRoot: process.cwd(),
    idleTtlMs: 5_000,
    requestTimeoutMs: 5_000
  })
  const base = manager.openWorkspace(baseRoot, 'git-base-pane')
  const branch = manager.openWorkspace(branchRoot, 'git-feature-pane')
  const useSite = { line: 3, column: 10 }
  try {
    const [baseHover, branchHover, baseReferences, branchReferences] = await Promise.all([
      base.hover('sample.ts', useSite),
      branch.hover('sample.ts', useSite),
      base.references('sample.ts', useSite),
      branch.references('sample.ts', useSite)
    ])
    assert.match(baseHover.items[0]?.contents ?? '', /BASE_ONLY/)
    assert.doesNotMatch(baseHover.items[0]?.contents ?? '', /FEATURE_ONLY/)
    assert.match(branchHover.items[0]?.contents ?? '', /FEATURE_ONLY/)
    assert.doesNotMatch(branchHover.items[0]?.contents ?? '', /BASE_ONLY/)
    assert.ok(baseReferences.total >= 2)
    assert.ok(branchReferences.total >= 2)
    for (const result of [baseReferences, branchReferences]) {
      assert.ok(result.items.every((item) => item.path === 'sample.ts'))
      assert.ok(result.items.every((item) => !item.path.includes('..') && !/^[A-Za-z]:/.test(item.path)))
    }
    assert.equal(manager.snapshot().processCount, 2)
    assert.equal(manager.snapshot().telemetry.starts, 2)
  } finally {
    base.close()
    branch.close()
    await manager.close()
    await rm(container, { recursive: true, force: true })
  }
})

test('walks past dependency-free package leaves and selects only a compatible server', async () => {
  const container = await mkdtemp(join(tmpdir(), 'synkora-lsp-package-resolution-'))
  const projectRoot = join(container, 'project')
  const leafRoot = join(projectRoot, 'packages', 'leaf')
  const targetFile = join(leafRoot, 'sample.ts')
  try {
    await mkdir(leafRoot, { recursive: true })
    const runtime = await fakeBundledTypeScriptRuntime(container)
    await Promise.all([
      writeFile(
        join(projectRoot, 'package.json'),
        JSON.stringify({ name: 'project', devDependencies: { typescript: '^7.0.0' } })
      ),
      writeFile(join(leafRoot, 'package.json'), JSON.stringify({ name: 'leaf', private: true })),
      writeFile(targetFile, 'export const value = 1\n')
    ])

    const native = detectTypeScriptServer(projectRoot, targetFile, { appRoot: runtime.appRoot })
    assert.equal(native.metadata.kind, 'typescript-native')
    assert.equal(native.metadata.version, '7.0.2')
    assert.equal(native.command, runtime.command)

    await writeFile(
      join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'project', devDependencies: { typescript: '^6.0.0' } })
    )
    assert.throws(
      () => detectTypeScriptServer(projectRoot, targetFile, { appRoot: runtime.appRoot }),
      (error: unknown) => error instanceof CodeIntelligenceError
        && error.code === 'SERVER_UNAVAILABLE'
    )
  } finally {
    await rm(container, { recursive: true, force: true })
  }
})

test('accepts an internal filename beginning with two dots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'synkora-lsp-dot-file-'))
  const file = join(root, '..foo.ts')
  try {
    await writeFile(file, 'export const internal = true\n')
    assert.equal(resolveAuthorizedFile(root, '..foo.ts'), file)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('normalizes a NUL command failure as LspTransportError', async () => {
  await assert.rejects(
    LspClient.start(
      { command: `invalid\0command`, args: [], cwd: process.cwd() },
      process.cwd()
    ),
    (error: unknown) => error instanceof LspTransportError
  )
})

test('shuts down the native TypeScript 7 server with a clean exit', async () => {
  const root = await fixture('synkora-lsp-clean-shutdown-')
  let client: LspClient | null = null
  try {
    const descriptor = detectTypeScriptServer(root, join(root, 'sample.ts'), {
      appRoot: process.cwd()
    })
    client = await LspClient.start(
      {
        command: descriptor.command,
        args: descriptor.args,
        cwd: root,
        env: descriptor.env
      },
      root
    )
    await client.stop()
    const exit = await client.exitPromise
    assert.equal(exit.code, 0)
    assert.equal(exit.signal, null)
  } finally {
    await client?.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps published diagnostics bound to the current document version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'synkora-lsp-diagnostic-version-'))
  const file = join(root, 'sample.ts')
  let publishDiagnostics = (_params: unknown): void => {
    throw new Error('diagnostic listener is not registered')
  }
  const client = {
    workspaceRoot: root,
    onNotification(method: string, listener: (params: unknown) => void): () => void {
      assert.equal(method, 'textDocument/publishDiagnostics')
      publishDiagnostics = listener
      return () => {
        publishDiagnostics = () => {
          throw new Error('diagnostic listener is closed')
        }
      }
    },
    async notify(): Promise<void> {}
  } as unknown as LspClient
  const store = new DocumentStore(client, {
    watchDebounceMs: 10_000,
    workspaceWatchDebounceMs: 10_000
  })
  const diagnostic = {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 }
    },
    severity: 1,
    message: 'fixture diagnostic',
    source: 'acceptance'
  }
  try {
    await writeFile(file, 'export const value = 1\n')
    const first = await store.ensure(file, 'typescript')
    assert.equal(first.version, 1)
    const uri = pathToFileURL(file).href
    publishDiagnostics({ uri, version: 1, diagnostics: [diagnostic] })
    assert.equal(store.getPublishedDiagnostics(uri, 1)?.diagnostics.length, 1)
    assert.equal(store.getPublishedDiagnostics(uri, 2), null)

    await writeFile(file, 'export const value = 2\n')
    const second = await store.ensure(file, 'typescript')
    assert.equal(second.version, 2)
    assert.equal(store.getPublishedDiagnostics(uri, 2), null)

    publishDiagnostics({ uri, version: 1, diagnostics: [diagnostic] })
    assert.equal(store.getPublishedDiagnostics(uri, 2), null)
    publishDiagnostics({ uri, version: 2, diagnostics: [diagnostic] })
    assert.equal(store.getPublishedDiagnostics(uri, 2)?.diagnostics.length, 1)
  } finally {
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
})
