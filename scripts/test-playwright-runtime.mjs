#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtime = await import(new URL('../src/main/mcpServer.ts', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'synkora-playwright-runtime-'))

try {
  const browser = runtime.resolveBundledPlaywrightMcp()
  assert(browser, 'o MCP Playwright fixado precisa estar resolvível')
  assert.equal(browser.version, '0.0.78')
  assert.equal(existsSync(browser.args[0]), true)
  assert.equal(browser.command.includes('npx'), false)
  assert.equal(browser.args.some((arg) => arg.includes('@latest')), false)
  assert.match(await versionOf(browser.command, [...browser.args, '--version'], browser.env), /0\.0\.78/)

  // O Playwright que chegou transitivamente por @playwright/mcp não pode se
  // passar pelo test runner instalado pelo projeto.
  assert.equal(runtime.resolveProjectPlaywrightTest(ROOT), undefined)

  const validProject = join(temp, 'valid')
  makeProjectFixture(validProject, true)
  const testRunner = runtime.resolveProjectPlaywrightTest(validProject)
  assert(testRunner)
  assert.deepEqual(testRunner.args.slice(1), ['run-test-mcp-server'])
  assert.equal(testRunner.version, '9.9.9-fixture')

  const oldProject = join(temp, 'old')
  makeProjectFixture(oldProject, false)
  assert.equal(runtime.resolveProjectPlaywrightTest(oldProject), undefined)

  // Uma junction dentro de node_modules não autoriza executar um pacote que
  // vive fora da worktree. O realpath precisa continuar contido no projeto.
  const escapedProject = join(temp, 'escaped')
  mkdirSync(join(escapedProject, 'node_modules'), { recursive: true })
  writeFileSync(
    join(escapedProject, 'package.json'),
    JSON.stringify({ name: 'escaped-fixture', dependencies: { playwright: '9.9.9-fixture' } }),
    'utf-8'
  )
  symlinkSync(
    join(validProject, 'node_modules', 'playwright'),
    join(escapedProject, 'node_modules', 'playwright'),
    'junction'
  )
  assert.equal(runtime.resolveProjectPlaywrightTest(escapedProject), undefined)

  // Layout pnpm: @playwright/test é o link público direto, enquanto sua
  // dependência `playwright` existe apenas aninhada ao pacote/store.
  const pnpmProject = join(temp, 'pnpm-layout')
  makePnpmProjectFixture(pnpmProject)
  assert.equal(existsSync(join(pnpmProject, 'node_modules', 'playwright')), false)
  const pnpmRunner = runtime.resolveProjectPlaywrightTest(pnpmProject)
  assert(pnpmRunner)
  assert.equal(pnpmRunner.version, '8.8.8-test-fixture')
  assert.equal(pnpmRunner.args[0], join(pnpmProject, 'node_modules', '@playwright', 'test', 'cli.js'))
  assert.deepEqual(pnpmRunner.args.slice(1), ['run-test-mcp-server'])

  const mcpDir = join(temp, 'mcp')
  const claudeFile = runtime.writeClaudeMcpConfig(
    mcpDir,
    'pane:fixture',
    12345,
    'dummy-token',
    browser,
    testRunner
  )
  const claude = JSON.parse(readFileSync(claudeFile, 'utf-8'))
  assert.deepEqual(Object.keys(claude.mcpServers), ['synkora', 'playwright', 'playwright-test'])
  assert.equal(claude.mcpServers.playwright.command, browser.command)
  assert.deepEqual(claude.mcpServers['playwright-test'].args, testRunner.args)
  assert.equal(JSON.stringify(claude).includes('npx'), false)
  assert.equal(JSON.stringify(claude).includes('@latest'), false)

  const wrapper = runtime.ensurePlaywrightCmd(mcpDir, {
    command: 'C:\\Program Files\\Synkora%fixture%\\Synkora.exe',
    args: ['C:\\Program Files\\Synkora%fixture%\\cli.js'],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  })
  const wrapperText = readFileSync(wrapper, 'utf-8')
  assert.match(wrapperText, /ELECTRON_RUN_AS_NODE=1/)
  assert.match(wrapperText, /Synkora%%fixture%%/)
  assert.equal(wrapperText.includes('npx'), false)
  assert.match(wrapperText, /exit \/b %errorlevel%/)
  assert.equal(existsSync(wrapper.replace(/\.cmd$/i, '.ps1')), false)

  assert.throws(
    () =>
      runtime.ensurePlaywrightCmd(join(temp, 'invalid-env-name'), {
        command: process.execPath,
        args: [],
        env: { 'INVALID-NAME': 'value' }
      }),
    /nome de env inválido/
  )
  assert.throws(
    () =>
      runtime.ensurePlaywrightCmd(join(temp, 'invalid-env-value'), {
        command: process.execPath,
        args: [],
        env: { VALID_NAME: 'uma\nduas' }
      }),
    /valor de env inválido/
  )
  assert.throws(
    () =>
      runtime.ensurePlaywrightCmd(join(temp, 'invalid-env-quote'), {
        command: process.execPath,
        args: [],
        env: { VALID_NAME: 'fecha"o comando' }
      }),
    /valor de env inválido/
  )

  if (process.platform === 'win32') {
    const difficultTarget = join(temp, "target space & (paren) ! percent% apostrophe'")
    const difficultWrapperDir = join(temp, "wrapper space & (paren) ! apostrophe'")
    mkdirSync(difficultTarget, { recursive: true })
    const probe = join(difficultTarget, 'argv-probe.js')
    writeFileSync(
      probe,
      "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: process.env.SYNKORA_WRAPPER_ENV })); process.exitCode = 23\n",
      'utf-8'
    )
    const fixedArgs = ['fixed arg', 'percent%value', 'bang!value', 'amp&value', 'paren(value)', "apostrophe'value"]
    const difficultWrapper = runtime.ensurePlaywrightCmd(difficultWrapperDir, {
      command: process.execPath,
      args: [probe, ...fixedArgs],
      env: { SYNKORA_WRAPPER_ENV: 'env%value!&()' }
    })
    assert.equal(existsSync(difficultWrapper.replace(/\.cmd$/i, '.ps1')), false)
    const wrapperRun = await runCmdWrapper(difficultWrapper, ['forwarded arg', 'forwarded&value'])
    assert.equal(wrapperRun.code, 23, JSON.stringify(wrapperRun))
    assert.equal(wrapperRun.stderr, '')
    assert.deepEqual(JSON.parse(wrapperRun.stdout), {
      argv: [...fixedArgs, 'forwarded arg', 'forwarded&value'],
      env: 'env%value!&()'
    })

    const unicodeTarget = join(temp, 'target-ação-東京')
    const unicodeWrapperDir = join(temp, 'wrapper-ação-東京')
    mkdirSync(unicodeTarget, { recursive: true })
    const unicodeProbe = join(unicodeTarget, 'unicode-probe.js')
    writeFileSync(
      unicodeProbe,
      [
        "let input = ''",
        "process.stdin.setEncoding('utf-8')",
        "process.stdin.on('data', chunk => (input += chunk))",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: process.env.SYNKORA_WRAPPER_ENV, input }))",
        "  process.stderr.write('stderr-ação-東京')",
        '  process.exitCode = 29',
        '})',
        ''
      ].join('\n'),
      'utf-8'
    )
    const unicodeWrapper = runtime.ensurePlaywrightCmd(unicodeWrapperDir, {
      command: process.execPath,
      args: [unicodeProbe, 'fixed-ação', 'fixed-東京'],
      env: { SYNKORA_WRAPPER_ENV: 'env-ação-東京' }
    })
    const unicodeCmd = readFileSync(unicodeWrapper)
    assert.equal([...unicodeCmd].every((byte) => byte <= 0x7f), true)
    assert.match(unicodeCmd.toString('ascii'), /powershell\.exe/)
    assert.match(unicodeCmd.toString('ascii'), /%~dp0/)
    const unicodeScript = unicodeWrapper.replace(/\.cmd$/i, '.ps1')
    assert.equal(existsSync(unicodeScript), true)
    assert.deepEqual([...readFileSync(unicodeScript).subarray(0, 3)], [0xef, 0xbb, 0xbf])
    const unicodeRun = await runCmdWrapper(
      unicodeWrapper,
      ['forwarded-ação', 'forwarded-東京'],
      'stdin-ação-東京'
    )
    assert.equal(unicodeRun.code, 29, JSON.stringify(unicodeRun))
    assert.equal(unicodeRun.stderr, 'stderr-ação-東京')
    assert.deepEqual(JSON.parse(unicodeRun.stdout), {
      argv: ['fixed-ação', 'fixed-東京', 'forwarded-ação', 'forwarded-東京'],
      env: 'env-ação-東京',
      input: 'stdin-ação-東京'
    })
  }

  const codexArgs = runtime.codexMcpArgs(
    12345,
    'C:/Program Files/Synkora/playwright.cmd',
    'C:/Program Files/Synkora/playwright-test.cmd'
  )
  assert(codexArgs.includes("mcp_servers.playwright.command='C:/Program Files/Synkora/playwright.cmd'"))
  assert(
    codexArgs.includes(
      "mcp_servers.playwright-test.command='C:/Program Files/Synkora/playwright-test.cmd'"
    )
  )
  assert.equal(codexArgs.some((arg) => arg.includes('playwright_test')), false)
  const apostropheArgs = runtime.codexMcpArgs(12345, "C:/O'Brien/playwright.cmd")
  const apostropheCommand = apostropheArgs.find((arg) => arg.startsWith('mcp_servers.playwright.command='))
  assert(apostropheCommand?.includes('command= "\\u'))
  assert.equal(apostropheCommand?.includes("O'Brien"), false)

  process.stdout.write('playwright runtime: ok\n')
} finally {
  // Alvo criado acima, dentro do diretório temporário do sistema.
  rmSync(temp, { recursive: true, force: true })
}

function makeProjectFixture(root, hasCapability) {
  const packageDir = join(root, 'node_modules', 'playwright')
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', dependencies: { playwright: '9.9.9-fixture' } }),
    'utf-8'
  )
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: 'playwright', version: '9.9.9-fixture', bin: { playwright: 'cli.js' } }),
    'utf-8'
  )
  writeFileSync(join(packageDir, 'cli.js'), '#!/usr/bin/env node\n', 'utf-8')
  writeFileSync(
    join(packageDir, 'lib', 'program.js'),
    hasCapability ? "program.command('run-test-mcp-server')\n" : "program.command('test')\n",
    'utf-8'
  )
}

function makePnpmProjectFixture(root) {
  const testDir = join(root, 'node_modules', '@playwright', 'test')
  const playwrightDir = join(testDir, 'node_modules', 'playwright')
  mkdirSync(join(playwrightDir, 'lib'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'pnpm-fixture', devDependencies: { '@playwright/test': '8.8.8-test-fixture' } }),
    'utf-8'
  )
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: '@playwright/test',
      version: '8.8.8-test-fixture',
      bin: { playwright: 'cli.js' },
      dependencies: { playwright: '8.8.8-playwright-fixture' }
    }),
    'utf-8'
  )
  writeFileSync(join(testDir, 'cli.js'), '#!/usr/bin/env node\n', 'utf-8')
  writeFileSync(
    join(playwrightDir, 'package.json'),
    JSON.stringify({ name: 'playwright', version: '8.8.8-playwright-fixture' }),
    'utf-8'
  )
  writeFileSync(
    join(playwrightDir, 'lib', 'program.js'),
    "program.command('run-test-mcp-server')\n",
    'utf-8'
  )
}

function runCmdWrapper(wrapper, forwardedArgs, input = '') {
  return new Promise((resolvePromise, rejectPromise) => {
    const nativeWrapper = wrapper.replace(/\//g, '\\')
    // Com /S, cmd.exe exige o par externo de aspas além das aspas do
    // executável. `windowsVerbatimArguments` impede o Node de convertê-las em
    // `\"`, que o cmd trataria como parte literal do nome do arquivo.
    const commandLine = `""${nativeWrapper}" ${forwardedArgs.map(cmdQuote).join(' ')}"`
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      rejectPromise(new Error('timeout ao executar wrapper MCP'))
    }, 15_000)
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf-8')))
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf-8')))
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

function cmdQuote(value) {
  assert.equal(/[\r\n"]/.test(value), false)
  return `"${value.replace(/%/g, '%%')}"`
}

function versionOf(command, args, extraEnv) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      rejectPromise(new Error('timeout ao validar entrypoint Playwright'))
    }, 15_000)
    child.stdout.on('data', (chunk) => (output += chunk.toString('utf-8')))
    child.stderr.on('data', (chunk) => (output += chunk.toString('utf-8')))
    child.once('error', rejectPromise)
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(output)
      else rejectPromise(new Error(`entrypoint Playwright encerrou com ${String(code)}`))
    })
  })
}
