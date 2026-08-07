import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import test from 'node:test'
import {
  compareVerificationEvidence,
  createVerificationSignature,
  detectVerificationCommands,
  normalizeVerificationOutput,
  recoverInterruptedVerification,
  resolveVerificationInvocation,
  runVerificationCommands,
  verificationBudget,
  verificationCommandDefinitionHash
} from '../src/main/missionVerification.ts'

function temporaryRoot(t, prefix = 'synkora-mission-verification-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function write(file, content = '') {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
}

function writePackage(root, value) {
  write(join(root, 'package.json'), `${JSON.stringify(value, null, 2)}\n`)
}

function command(root, overrides = {}) {
  return {
    id: 'fixture:command',
    kind: 'test',
    label: 'comando de teste',
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    cwd: root,
    source: 'fixture',
    timeoutMs: 2_000,
    ...overrides
  }
}

function result(commandId, status, overrides = {}) {
  return {
    commandId,
    label: commandId,
    status,
    exitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : null,
    signal: null,
    durationMs: 10,
    stdoutTail: '',
    stderrTail: '',
    ...overrides
  }
}

function batch(status, results = []) {
  return {
    status,
    startedAt: '2026-08-01T10:00:00.000Z',
    finishedAt: '2026-08-01T10:00:01.000Z',
    durationMs: 1_000,
    results
  }
}

test('orçamento é proporcional e FAST de risco alto recebe somente uma proteção extra', () => {
  assert.deepEqual(verificationBudget('fast', 'low'), {
    maxCommands: 1,
    perCommandTimeoutMs: 90_000,
    totalTimeoutMs: 90_000,
    maxOutputChars: 48_000
  })
  assert.equal(verificationBudget('fast', 'high').maxCommands, 2)
  assert.equal(verificationBudget('standard').maxCommands, 3)
  assert.equal(verificationBudget('deep').maxCommands, 4)
  assert.equal(verificationBudget('deep').totalTimeoutMs, 600_000)
})

test('detecta scripts Node na ordem certa e respeita FAST/STANDARD/DEEP', (t) => {
  const root = temporaryRoot(t)
  writePackage(root, {
    scripts: {
      typecheck: 'tsc --noEmit',
      'test:unit': 'vitest run',
      test: 'vitest',
      lint: 'eslint .',
      build: 'vite build',
      dev: 'vite',
      'test:watch': 'vitest --watch'
    }
  })
  write(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')

  assert.deepEqual(
    detectVerificationCommands({ root, mode: 'fast', risk: 'low' }).map((item) => item.id),
    ['node:typecheck']
  )
  assert.deepEqual(
    detectVerificationCommands({ root, mode: 'fast', risk: 'high' }).map((item) => item.id),
    ['node:typecheck', 'node:test:unit']
  )
  assert.deepEqual(
    detectVerificationCommands({ root, mode: 'standard' }).map((item) => item.id),
    ['node:typecheck', 'node:test:unit', 'node:lint']
  )
  const deep = detectVerificationCommands({ root, mode: 'deep' })
  assert.deepEqual(deep.map((item) => item.id), [
    'node:typecheck',
    'node:test:unit',
    'node:lint',
    'node:build'
  ])
  assert(deep.every((item) => item.command === 'pnpm'))
  assert(deep.every((item) => item.timeoutMs === 300_000))
  assert.deepEqual(
    detectVerificationCommands({ root, mode: 'fast', maxCommands: 100 }).map((item) => item.id),
    ['node:typecheck', 'node:test:unit', 'node:lint', 'node:build']
  )
})

test('ignora placeholders, watch e nomes de script inseguros', (t) => {
  const root = temporaryRoot(t)
  writePackage(root, {
    scripts: {
      typecheck: 'tsc --watch',
      test: 'echo "Error: no test specified" && exit 1',
      lint: 'eslint --watch .',
      'bad name; echo owned': 'node safe.js',
      build: 'vite build'
    }
  })
  const detected = detectVerificationCommands({ root, mode: 'deep' })
  assert.deepEqual(detected.map((item) => item.id), [
    'node:typecheck',
    'node:test',
    'node:lint',
    'node:build'
  ])
  assert(detected.slice(0, 3).every((item) => item.blockedReason))
  assert.equal(detected[3].blockedReason, undefined)
})

test('recusa scripts mutantes e lifecycle hooks ocultos antes de executar', (t) => {
  const root = temporaryRoot(t)
  writePackage(root, {
    scripts: {
      typecheck: 'tsc --noEmit',
      test: 'vercel deploy --prod',
      lint: 'eslint .',
      prelint: 'git push origin main',
      build: 'vite build'
    }
  })
  assert.deepEqual(
    detectVerificationCommands({ root, mode: 'deep', maxCommands: 100 }).map((item) => item.id),
    ['node:typecheck', 'node:test', 'node:lint', 'node:build']
  )
  const detected = detectVerificationCommands({ root, mode: 'deep', maxCommands: 100 })
  assert.equal(detected[0].blockedReason, undefined)
  assert.match(detected[1].blockedReason, /inseguro|nao analisavel/)
  assert.match(detected[2].blockedReason, /inseguro|nao analisavel/)
  assert.equal(detected[3].blockedReason, undefined)
})

test('digest semântico muda quando script ou hook transitivo é reescrito', (t) => {
  const root = temporaryRoot(t, 'synkora-verification-definition-')
  writePackage(root, {
    scripts: {
      typecheck: 'npm run check:types',
      'check:types': 'tsc --noEmit',
      'precheck:types': 'node --check tools/config.js'
    }
  })
  const baseline = detectVerificationCommands({ root, mode: 'fast' })[0]
  assert.ok(baseline?.definitionHash)

  writePackage(root, {
    scripts: {
      typecheck: 'npm run check:types',
      'check:types': 'echo ok',
      'precheck:types': 'node --check tools/config.js'
    }
  })
  const changed = detectVerificationCommands({ root, mode: 'fast' })[0]
  assert.equal(changed?.id, baseline.id)
  assert.equal(changed?.command, baseline.command)
  assert.deepEqual(changed?.args, baseline.args)
  assert.notEqual(changed?.definitionHash, baseline.definitionHash)
})

test('npm run-script entra no hash transitivo e não esconde helper mutante', (t) => {
  const root = temporaryRoot(t, 'synkora-verification-run-script-')
  writePackage(root, {
    scripts: {
      typecheck: 'npm --silent run-script --if-present helper',
      helper: 'tsc --noEmit'
    }
  })
  const baseline = detectVerificationCommands({ root, mode: 'fast' })[0]
  assert.ok(baseline?.definitionHash)

  writePackage(root, {
    scripts: {
      typecheck: 'npm --silent run-script --if-present helper',
      helper: 'netlify deploy --prod'
    }
  })
  const blocked = detectVerificationCommands({ root, mode: 'fast' })[0]
  assert.match(blocked?.blockedReason, /inseguro|nao analisavel/)
  assert.notEqual(
    verificationCommandDefinitionHash(baseline),
    baseline.definitionHash
  )

  const yarnRoot = temporaryRoot(t, 'synkora-verification-yarn-run-')
  writePackage(yarnRoot, {
    scripts: {
      typecheck: 'yarn run --silent helper',
      helper: 'tsc --noEmit'
    }
  })
  const yarnBaseline = detectVerificationCommands({ root: yarnRoot, mode: 'fast' })[0]
  assert.ok(yarnBaseline?.definitionHash)
  writePackage(yarnRoot, {
    scripts: {
      typecheck: 'yarn run --silent helper',
      helper: 'netlify deploy --prod'
    }
  })
  const yarnBlocked = detectVerificationCommands({ root: yarnRoot, mode: 'fast' })[0]
  assert.match(yarnBlocked?.blockedReason, /inseguro|nao analisavel/)
  assert.notEqual(
    verificationCommandDefinitionHash(yarnBaseline),
    yarnBaseline.definitionHash
  )
})

test('somente run explícito chama scripts locais e pn é normalizado para pnpm', (t) => {
  const pnpmRoot = temporaryRoot(t, 'synkora-verification-pnpm-explicit-')
  writePackage(pnpmRoot, {
    packageManager: 'pnpm@10.0.0',
    scripts: {
      typecheck: 'pn run helper',
      helper: 'tsc --noEmit'
    }
  })
  assert.equal(
    detectVerificationCommands({ root: pnpmRoot, mode: 'fast' })[0]?.id,
    'node:typecheck'
  )

  const pnpmAliasRoot = temporaryRoot(t, 'synkora-verification-pnpm-run-script-')
  writePackage(pnpmAliasRoot, {
    packageManager: 'pnpm@10.0.0',
    scripts: {
      typecheck: 'pnpm run-script helper',
      helper: 'tsc --noEmit'
    }
  })
  assert.equal(
    detectVerificationCommands({ root: pnpmAliasRoot, mode: 'fast' })[0]?.id,
    'node:typecheck'
  )

  const yarnRoot = temporaryRoot(t, 'synkora-verification-yarnpkg-explicit-')
  writePackage(yarnRoot, {
    packageManager: 'yarn@4.9.1',
    scripts: {
      typecheck: 'yarnpkg run helper',
      helper: 'tsc --noEmit'
    }
  })
  assert.equal(
    detectVerificationCommands({ root: yarnRoot, mode: 'fast' })[0]?.id,
    'node:typecheck'
  )

  for (const body of [
    'npm test',
    'pnpm helper',
    'pnpm i',
    'pnpm t',
    'pnpm tst',
    'yarn logout',
    'bun test',
    'yarn run-script helper',
    'bun run-script helper',
    'pnx helper',
    'pnpx helper',
    'corepack pnpm run helper',
    '$npm_execpath run helper',
    'MODE=safe npm run helper',
    'pnpm -s run helper',
    'yarn run helper --silent',
    'npm run --if-present missing',
    'npm run helper --workspace other',
    'pnpm run helper --filter other',
    'yarn install',
    'yarn add pacote'
  ]) {
    const unsafeRoot = temporaryRoot(t, 'synkora-verification-manager-unsafe-')
    writePackage(unsafeRoot, {
      scripts: {
        typecheck: body,
        helper: 'tsc --noEmit',
        test: 'tsc --noEmit',
        i: 'tsc --noEmit',
        t: 'tsc --noEmit',
        tst: 'tsc --noEmit',
        logout: 'tsc --noEmit',
        'run-script': 'tsc --noEmit',
        install: 'tsc --noEmit',
        add: 'tsc --noEmit'
      }
    })
    const blocked = detectVerificationCommands({ root: unsafeRoot, mode: 'fast' })[0]
    assert.equal(blocked?.id, 'node:typecheck', body)
    assert.match(blocked?.blockedReason, /inseguro|nao analisavel/, body)
  }
})

test('mutacao de ambiente no script ou hook transitivo vira check bloqueado', async (t) => {
  const cases = [
    {
      typecheck: 'set npm_config_ignore_scripts=true&&npm run helper',
      helper: 'echo ok',
      prehelper: 'vitest run'
    },
    {
      typecheck: 'npm run helper',
      helper: 'echo ok',
      prehelper: 'export PATH=./fake:$PATH; vitest run'
    },
    {
      typecheck: 'npm run helper',
      helper: 'echo ok',
      prehelper: '$env:PYTEST_ADDOPTS="--collect-only"; vitest run'
    }
  ]

  for (const scripts of cases) {
    const root = temporaryRoot(t, 'synkora-verification-env-mutation-')
    writePackage(root, { scripts })
    const blocked = detectVerificationCommands({ root, mode: 'fast' })[0]
    assert.equal(blocked?.id, 'node:typecheck')
    assert.match(blocked?.blockedReason, /ambiente inseguro|nao analisavel/)
    const run = await runVerificationCommands([blocked])
    assert.equal(run.status, 'unavailable')
    assert.match(run.results[0].stderrTail, /check declarado bloqueado/)
  }

  const root = temporaryRoot(t, 'synkora-verification-blocked-hash-')
  writePackage(root, {
    scripts: {
      typecheck: 'set npm_config_script_shell=.\\evil.cmd&&npm run helper',
      helper: 'tsc --noEmit'
    }
  })
  const blocked = detectVerificationCommands({ root, mode: 'fast' })[0]
  assert.ok(blocked?.definitionHash)
  assert.notEqual(
    verificationCommandDefinitionHash({
      ...blocked,
      blockedReason: `${blocked.blockedReason} alterado`
    }),
    blocked.definitionHash
  )
})

test('check Node declarado mas nao analisavel nunca vira not_required', async (t) => {
  const root = temporaryRoot(t, 'synkora-verification-declared-blocked-')
  writePackage(root, {
    scripts: {
      test: 'npm-run-all style unit',
      style: 'eslint .',
      unit: 'vitest run'
    }
  })
  const detected = detectVerificationCommands({ root, mode: 'fast' })
  assert.equal(detected.length, 1)
  assert.equal(detected[0].id, 'node:test')
  assert.match(detected[0].blockedReason, /inseguro|nao analisavel/)
  const run = await runVerificationCommands(detected)
  assert.equal(run.status, 'unavailable')
  assert.notEqual(run.status, 'not_required')
})

test('hash inclui a versão do gerenciador e a topologia de workspaces', (t) => {
  const root = temporaryRoot(t, 'synkora-verification-package-metadata-')
  writePackage(root, {
    packageManager: 'pnpm@10.0.0',
    workspaces: ['packages/a'],
    scripts: { typecheck: 'tsc --noEmit' }
  })
  const baseline = detectVerificationCommands({ root, mode: 'fast' })[0]
  assert.ok(baseline?.definitionHash)

  writePackage(root, {
    packageManager: 'pnpm@10.1.0',
    workspaces: ['packages/b'],
    scripts: { typecheck: 'tsc --noEmit' }
  })
  assert.notEqual(verificationCommandDefinitionHash(baseline), baseline.definitionHash)
})

test('usa packageManager declarado quando não existe lockfile', (t) => {
  const root = temporaryRoot(t)
  writePackage(root, {
    packageManager: 'yarn@4.9.1',
    scripts: { check: 'tsc --noEmit' }
  })
  const [detected] = detectVerificationCommands({ root, mode: 'fast' })
  assert.equal(detected.command, 'yarn')
  assert.equal(detected.kind, 'check')
  assert.deepEqual(detected.args, ['run', 'check'])
})

test('bloqueia configurações locais que podem trocar alvo, shell ou binário', async (t) => {
  const cases = [
    ['npm@11.0.0', '.npmrc', 'workspace=packages/other\n'],
    ['npm@11.0.0', '.npmrc', 'script-shell=./tools/redirect.js\n'],
    ['pnpm@10.0.0', 'pnpm-workspace.yaml', 'packages:\n  - packages/*\nscriptShell: ./redirect\n'],
    ['yarn@4.9.1', '.yarnrc.yml', 'yarnPath: ./.yarn/redirect.cjs\n'],
    ['yarn@4.9.1', '.yarnrc.yml', 'plugins:\n  - path: ./redirect.cjs\n'],
    ['yarn@4.9.1', '.env.yarn', 'NPM_CONFIG_WORKSPACE=packages/other\n'],
    ['bun@1.2.0', 'bunfig.toml', 'preload = ["./redirect.ts"]\n'],
    ['bun@1.2.0', 'bunfig.toml', '[run]\nshell = "./redirect"\n']
  ]

  for (const [packageManager, configName, configBody] of cases) {
    const root = temporaryRoot(t, 'synkora-verification-local-config-')
    writePackage(root, {
      packageManager,
      scripts: { typecheck: 'tsc --noEmit' }
    })
    write(join(root, configName), configBody)
    const blocked = detectVerificationCommands({ root, mode: 'fast' })[0]
    assert.equal(blocked?.id, 'node:typecheck', `${packageManager}: ${configName}`)
    assert.match(blocked?.blockedReason, /configuracao local/, `${packageManager}: ${configName}`)
  }

  const root = temporaryRoot(t, 'synkora-verification-config-race-')
  writePackage(root, { scripts: { typecheck: 'tsc --noEmit' } })
  write(join(root, '.npmrc'), 'fund=false\n')
  const baseline = detectVerificationCommands({ root, mode: 'fast' })[0]
  assert.ok(baseline?.definitionHash)
  write(join(root, '.npmrc'), 'audit=false\n')
  assert.notEqual(verificationCommandDefinitionHash(baseline), baseline.definitionHash)

  write(join(root, '.npmrc'), 'script-shell=./redirect\n')
  const blocked = await runVerificationCommands([baseline])
  assert.equal(blocked.status, 'unavailable')
  assert.match(blocked.results[0].stderrTail, /configuracao local pode redirecionar/)
})

test('detecta pytest, Cargo, Go, .NET e wrapper Java sem inventar instalação', (t) => {
  const python = temporaryRoot(t, 'synkora-verification-python-')
  write(join(python, 'pyproject.toml'), '[project]\nname="fixture"\n')
  write(join(python, 'tests', 'test_sample.py'), 'def test_ok(): assert True\n')
  assert.equal(
    detectVerificationCommands({ root: python, mode: 'fast', platform: 'linux' })[0]?.id,
    'python:pytest'
  )

  const rust = temporaryRoot(t, 'synkora-verification-rust-')
  write(join(rust, 'Cargo.toml'), '[package]\nname="fixture"\nversion="0.1.0"\n')
  assert.equal(detectVerificationCommands({ root: rust, mode: 'fast' })[0]?.id, 'rust:cargo-test')

  const go = temporaryRoot(t, 'synkora-verification-go-')
  write(join(go, 'go.mod'), 'module fixture\n')
  assert.equal(detectVerificationCommands({ root: go, mode: 'fast' })[0]?.id, 'go:test')

  const dotnet = temporaryRoot(t, 'synkora-verification-dotnet-')
  write(join(dotnet, 'Fixture.sln'), '')
  assert.equal(detectVerificationCommands({ root: dotnet, mode: 'fast' })[0]?.id, 'dotnet:test')

  const java = temporaryRoot(t, 'synkora-verification-java-')
  write(join(java, 'pom.xml'), '<project/>')
  write(join(java, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw'), '')
  const javaCommand = detectVerificationCommands({ root: java, mode: 'fast' })[0]
  assert.equal(javaCommand?.id, 'java:maven-test')
  assert.equal(javaCommand?.command, join(java, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw'))
})

test('resolve executável direto sem shell e preserva cada argumento', () => {
  const invocation = resolveVerificationInvocation(
    { command: process.execPath, args: ['-e', 'console.log(process.argv[1])', '&& echo owned'] },
    { platform: process.platform }
  )
  assert(invocation)
  assert.equal(invocation.command, process.execPath)
  assert.equal(invocation.args.at(-1), '&& echo owned')
})

test('no Windows converte shim npm conhecido em node + CLI e recusa batch genérico', (t) => {
  const root = temporaryRoot(t, 'synkora-verification-shim-')
  const bin = join(root, 'bin')
  write(join(bin, 'npm.cmd'), '@echo off\n')
  write(join(bin, 'node.exe'), '')
  const cli = join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  write(cli, '')
  write(join(bin, 'custom.cmd'), '@echo off\n')
  const env = { PATH: bin }

  assert.deepEqual(
    resolveVerificationInvocation(
      { command: 'npm', args: ['run', 'test'] },
      { platform: 'win32', env }
    ),
    { command: join(bin, 'node.exe'), args: [cli, 'run', 'test'] }
  )
  assert.equal(
    resolveVerificationInvocation(
      { command: 'custom.cmd', args: ['test'] },
      { platform: 'win32', env }
    ),
    undefined
  )

  const mavenWrapper = join(root, 'mvnw.cmd')
  write(mavenWrapper, '@echo off\r\nexit /b 0\r\n')
  const javaInvocation = resolveVerificationInvocation(
    { command: mavenWrapper, args: ['test'] },
    { platform: 'win32', env }
  )
  assert.ok(javaInvocation)
  assert.equal(isAbsolute(javaInvocation.command), true)
  assert.equal(basename(javaInvocation.command).toLowerCase(), 'cmd.exe')
  assert.deepEqual(javaInvocation.args.slice(0, 4), ['/d', '/s', '/c', 'call'])
  assert.equal(javaInvocation.args[4], mavenWrapper)
  assert.equal(javaInvocation.args[5], 'test')
  assert.equal(
    resolveVerificationInvocation(
      { command: mavenWrapper, args: ['test', '-DskipTests'] },
      { platform: 'win32', env }
    ),
    undefined
  )

  const unsafeWrapper = join(root, 'unsafe&path', 'gradlew.bat')
  write(unsafeWrapper, '@echo off\r\nexit /b 0\r\n')
  assert.equal(
    resolveVerificationInvocation(
      { command: unsafeWrapper, args: ['test'] },
      { platform: 'win32', env }
    ),
    undefined
  )
})

test('wrapper Java conhecido executa via cmd absoluto no Windows', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('contrato executavel especifico do Windows')
    return
  }
  const root = temporaryRoot(t, 'synkora-verification-java-wrapper-')
  const wrapper = join(root, 'mvnw.cmd')
  write(wrapper, [
    '@echo off',
    'if not "%~1"=="test" exit /b 9',
    'exit /b 0',
    ''
  ].join('\r\n'))
  const verification = await runVerificationCommands([
    command(root, {
      id: 'java:maven-test',
      command: wrapper,
      args: ['test']
    })
  ])
  assert.equal(verification.status, 'passed', JSON.stringify(verification.results[0]))
})

test('normaliza somente ruído volátil e produz assinatura estável', (t) => {
  const root = temporaryRoot(t)
  const first = `\u001b[31mERRO\u001b[0m em ${root}\\src\\app.ts\n2026-08-01T10:20:30.123Z\n`
  const second = `ERRO em ${root}\\src\\app.ts\n2026-08-01T11:22:33.999Z\n`
  assert.equal(normalizeVerificationOutput(first, root), normalizeVerificationOutput(second, root))
  assert.equal(
    createVerificationSignature({ exitCode: 1, stdout: first, stderr: '', cwd: root }),
    createVerificationSignature({ exitCode: 1, stdout: second, stderr: '', cwd: root })
  )
  assert.notEqual(
    createVerificationSignature({ exitCode: 1, stdout: first, stderr: '', cwd: root }),
    createVerificationSignature({ exitCode: 1, stdout: `${second}outra falha`, stderr: '', cwd: root })
  )
})

test('runner passa argumentos literalmente e nunca os entrega a um shell', async (t) => {
  const root = temporaryRoot(t)
  const verification = await runVerificationCommands([
    command(root, {
      args: [
        '-e',
        'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
        '&&',
        'echo',
        'owned'
      ]
    })
  ])
  assert.equal(verification.status, 'passed')
  assert.deepEqual(JSON.parse(verification.results[0].stdoutTail), ['&&', 'echo', 'owned'])
  assert.match(verification.results[0].signature, /^[0-9a-f]{64}$/)
})

test('runner remove ambiente capaz de redirecionar gerenciadores e Node', async (t) => {
  const root = temporaryRoot(t)
  write(join(root, 'cmd.exe'), 'nao deve ser selecionado')
  const verification = await runVerificationCommands(
    [
      command(root, {
        args: [
          '-e',
          `process.stdout.write(JSON.stringify({
            nodeOptions: process.env.NODE_OPTIONS ?? null,
            workspace: process.env.NPM_CONFIG_WORKSPACE ?? process.env.npm_config_workspace ?? null,
            yarnPath: process.env.YARN_RC_FILENAME ?? null,
            bunConfig: process.env.BUN_CONFIG ?? null,
            corepack: process.env.COREPACK_HOME ?? null,
            python: process.env.PYTEST_ADDOPTS ?? null,
            cargo: process.env.CARGO_TARGET_DIR ?? null,
            go: process.env.GOFLAGS ?? null,
            java: process.env.JAVA_TOOL_OPTIONS ?? null,
            maven: process.env.MAVEN_OPTS ?? null,
            dotnet: process.env.DOTNET_STARTUP_HOOKS ?? null,
            workspaces: process.env.npm_config_workspaces ?? null,
            scriptShell: process.env.npm_config_script_shell ?? null,
            comSpec: process.env.ComSpec ?? process.env.COMSPEC ?? null,
            userconfig: process.env.npm_config_userconfig ?? null,
            globalconfig: process.env.npm_config_globalconfig ?? null,
            yarnIgnorePath: process.env.YARN_IGNORE_PATH ?? null,
            safe: process.env.SYNKORA_SAFE_TEST ?? null
          }))`
        ]
      })
    ],
    {
      env: {
        NODE_OPTIONS: '--require=./nao-deve-executar.cjs',
        NPM_CONFIG_WORKSPACE: 'packages/other',
        npm_config_script_shell: './redirect',
        YARN_RC_FILENAME: 'redirect.yml',
        BUN_CONFIG: './redirect.toml',
        COREPACK_HOME: './redirect',
        PYTEST_ADDOPTS: '--collect-only',
        CARGO_TARGET_DIR: './redirect-cargo',
        GOFLAGS: '-run=^$',
        JAVA_TOOL_OPTIONS: '-javaagent:redirect.jar',
        MAVEN_OPTS: '-DskipTests',
        DOTNET_STARTUP_HOOKS: './redirect-dotnet.dll',
        SYNKORA_SAFE_TEST: 'preservado'
      }
    }
  )
  assert.equal(verification.status, 'passed')
  const childEnv = JSON.parse(verification.results[0].stdoutTail)
  assert.equal(childEnv.nodeOptions, null)
  assert.equal(childEnv.workspace, null)
  assert.equal(childEnv.yarnPath, null)
  assert.equal(childEnv.bunConfig, null)
  assert.equal(childEnv.corepack, null)
  assert.equal(childEnv.python, null)
  assert.equal(childEnv.cargo, null)
  assert.equal(childEnv.go, null)
  assert.equal(childEnv.java, null)
  assert.equal(childEnv.maven, null)
  assert.equal(childEnv.dotnet, null)
  assert.equal(childEnv.workspaces, 'false')
  if (process.platform === 'win32') {
    assert.equal(isAbsolute(childEnv.scriptShell), true)
    assert.equal(basename(childEnv.scriptShell).toLowerCase(), 'cmd.exe')
    assert.notEqual(childEnv.scriptShell.toLowerCase(), join(root, 'cmd.exe').toLowerCase())
    assert.equal(childEnv.comSpec, childEnv.scriptShell)
  } else {
    assert.equal(childEnv.scriptShell, '/bin/sh')
    assert.equal(childEnv.comSpec, null)
  }
  // user e global apontam para arquivos VAZIOS e DISTINTOS (2026-08-04: os
  // dois no mesmo null device faziam o npm abortar no boot com
  // "double-loading config" — a verificação reprovava produto verde).
  assert.equal(typeof childEnv.userconfig, 'string')
  assert.equal(typeof childEnv.globalconfig, 'string')
  assert.notEqual(childEnv.userconfig, childEnv.globalconfig)
  assert.equal(readFileSync(childEnv.userconfig, 'utf8'), '')
  assert.equal(readFileSync(childEnv.globalconfig, 'utf8'), '')
  assert.equal(childEnv.yarnIgnorePath, '1')
  assert.equal(childEnv.safe, 'preservado')
})

test('runner limita saída, classifica falha e ferramenta ausente', async (t) => {
  const root = temporaryRoot(t)
  const failed = await runVerificationCommands(
    [
      command(root, {
        args: ['-e', 'process.stdout.write("x".repeat(5000)); process.stderr.write("falhou"); process.exit(2)']
      })
    ],
    { maxOutputChars: 80 }
  )
  assert.equal(failed.status, 'failed')
  assert.equal(failed.results[0].exitCode, 2)
  assert(failed.results[0].stdoutTail.length <= 80)
  assert.equal(failed.results[0].stderrTail, 'falhou')

  const missing = await runVerificationCommands([
    command(root, { command: 'synkora-command-that-does-not-exist', args: [] })
  ])
  assert.equal(missing.status, 'unavailable')
  assert.equal(missing.results[0].signature, undefined)
})

test('runner aplica timeout por comando e total sem aprovar o restante', async (t) => {
  const root = temporaryRoot(t)
  const verification = await runVerificationCommands(
    [
      command(root, {
        id: 'slow-1',
        args: ['-e', 'setTimeout(() => process.exit(0), 5000)'],
        timeoutMs: 40
      }),
      command(root, { id: 'slow-2', timeoutMs: 2_000 })
    ],
    { totalTimeoutMs: 20 }
  )
  assert.equal(verification.status, 'timed_out')
  assert.equal(verification.results[0].status, 'timed_out')
  assert.equal(verification.results[1].status, 'timed_out')
})

test('runner vazio registra not_required sem criar processo', async () => {
  const verification = await runVerificationCommands([])
  assert.equal(verification.status, 'not_required')
  assert.deepEqual(verification.results, [])
})

test('compara baseline/final: aceita a mesma falha e bloqueia regressão', () => {
  const baseline = batch('failed', [result('test', 'failed', { signature: 'same' })])
  const same = batch('failed', [result('test', 'failed', { signature: 'same' })])
  const changed = batch('failed', [result('test', 'failed', { signature: 'changed' })])
  const recovered = batch('passed', [result('test', 'passed', { signature: 'green' })])

  assert.equal(
    compareVerificationEvidence(baseline, same).status,
    'passed_with_baseline_failures'
  )
  assert.equal(compareVerificationEvidence(baseline, changed).status, 'blocked')
  assert.equal(compareVerificationEvidence(baseline, recovered).status, 'passed')
  assert.equal(
    compareVerificationEvidence(
      batch('passed', [result('test', 'passed', { signature: 'green' })]),
      changed
    ).items[0].detail,
    'o comando passou no baseline e falhou no final'
  )
  const omitted = compareVerificationEvidence(baseline, batch('not_required'))
  assert.equal(omitted.status, 'blocked')
  assert.match(omitted.items[0].detail, /não foi executado/)
})

test('timeout, cancelamento ou ferramenta ausente nunca viram falha antiga aceitável', () => {
  for (const status of ['timed_out', 'cancelled', 'unavailable']) {
    const evidence = batch(status, [result('test', status)])
    assert.equal(compareVerificationEvidence(evidence, evidence).status, 'blocked')
  }
  assert.equal(compareVerificationEvidence(undefined, batch('not_required')).status, 'not_required')
})

test('restart transforma running em pending sem alterar estados terminais', () => {
  const recovered = recoverInterruptedVerification(
    { status: 'running', startedAt: '2026-08-01T10:00:00.000Z' },
    '2026-08-01T10:01:00.000Z'
  )
  assert.equal(recovered.status, 'pending')
  assert.equal(recovered.interruptedAt, '2026-08-01T10:01:00.000Z')
  assert.match(recovered.lastError, /retomada/)
  assert.deepEqual(
    recoverInterruptedVerification({ status: 'passed', finishedAt: 'fim' }),
    { status: 'passed', finishedAt: 'fim' }
  )
})
