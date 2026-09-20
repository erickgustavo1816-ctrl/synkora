import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  isWorktreePreviewProcess,
  probeWorktreePreviewProcesses,
  stopProbedWorktreePreviewProcesses,
  stopWorktreePreviewProcesses
} from '../.tmp/worktree-preview-processes-test/worktreePreviewProcesses.js'
import { createPaneLifecycle } from '../.tmp/worktree-preview-processes-test/paneLifecycle.js'

const root = String.raw`C:\Work\mission ' & $() space`
const executablePath = String.raw`C:\Program Files\nodejs\node.exe`
function candidate(overrides = {}) {
  return {
    pid: 1234,
    creationTime: '133700000000000000',
    executablePath,
    commandHash: 'a'.repeat(64),
    argv: [executablePath, `${root}\\node_modules\\astro\\bin\\astro.mjs`, 'preview', '--port', '4321', '--host', '127.0.0.1'],
    ...overrides
  }
}

test('identifica somente a entrada Astro absoluta da pasta exata, por posição de argv', () => {
  assert.equal(isWorktreePreviewProcess(root, candidate()), true)
  assert.equal(isWorktreePreviewProcess(root + '\\', candidate()), true)
  assert.equal(isWorktreePreviewProcess(root.toUpperCase().replaceAll('\\', '/'), candidate()), true)
  assert.equal(isWorktreePreviewProcess(root, candidate({ argv: ['node', `${root}/node_modules/astro/bin/astro.mjs`, 'dev'] })), true)
  assert.equal(isWorktreePreviewProcess(root, candidate({ argv: ['node.exe', `${root}/node_modules/astro/bin/astro.mjs`, 'preview', '--host', '--port=4321'] })), true)
  assert.equal(isWorktreePreviewProcess(root, candidate({ argv: [executablePath, `${root}/node_modules/astro/bin/astro.mjs`, 'dev', '--host=localhost', '--port', '4321'] })), true)
})

test('não confunde vizinhos, outros scripts, travessia ou menções em prosa', () => {
  for (const script of [
    `${root}-sibling\\node_modules\\astro\\bin\\astro.mjs`,
    `${root}\\nested\\node_modules\\astro\\bin\\astro.mjs`,
    `${root}\\..\\mission ' & $() space\\node_modules\\astro\\bin\\astro.mjs`,
    'node_modules/astro/bin/astro.mjs',
    `${root}\\node_modules\\astro\\bin\\another.mjs`,
    `a mention of ${root}\\node_modules\\astro\\bin\\astro.mjs`,
    `\\\\?\\${root}\\node_modules\\astro\\bin\\astro.mjs`
  ]) {
    assert.equal(isWorktreePreviewProcess(root, candidate({ argv: [executablePath, script, 'preview'] })), false, script)
  }
  for (const invalidRoot of ['', 'C:relative', '\\relative', root + '\\..', 'C:\\', '\\\\?\\' + root]) {
    assert.equal(isWorktreePreviewProcess(invalidRoot, candidate()), false, invalidRoot)
  }
})

test('recusa wrappers Node, executáveis alheios e alterações de raiz ou configuração', () => {
  const script = `${root}\\node_modules\\astro\\bin\\astro.mjs`
  for (const argv of [
    [executablePath, '-e', `import(${JSON.stringify(script)})`, 'preview'],
    [executablePath, '--require', script, 'preview'],
    [executablePath, '--import', script, 'preview'],
    [executablePath, '--', script, 'preview'],
    [executablePath, script, 'build'],
    [executablePath, script, 'Preview'],
    [executablePath, script, 'preview', '--root', 'C:\\another'],
    [executablePath, script, 'dev', '--root=C:\\another'],
    [executablePath, script, 'dev', '-r', root],
    [executablePath, script, 'dev', '--config', 'C:\\another.mjs'],
    [executablePath, script, 'dev', '--port', 'not-a-port'],
    [executablePath, script, 'dev', '--port', '65536'],
    [executablePath, script, 'dev', '--host', '--root=C:\\another'],
    ['powershell.exe', script, 'preview'],
    ['C:\\another\\node.exe', script, 'preview']
  ]) assert.equal(isWorktreePreviewProcess(root, candidate({ argv })), false, JSON.stringify(argv))
  assert.equal(isWorktreePreviewProcess(root, candidate({ executablePath: 'C:\\bin\\electron.exe' })), false)
  assert.equal(isWorktreePreviewProcess(root, candidate({ executablePath: 'node.exe' })), false)
  assert.equal(isWorktreePreviewProcess(root, candidate({ pid: -1 })), false)
  assert.equal(isWorktreePreviewProcess(root, candidate({ creationTime: 'invalid' })), false)
})

test('raiz inválida falha de modo fechado antes de enumerar processos', async () => {
  const result = await stopWorktreePreviewProcesses('C:relative')
  assert.equal(result.stopped, 0)
  assert.equal(result.failed, process.platform === 'win32' ? 1 : 0)
  if (process.platform !== 'win32') assert.equal(result.skipped, true)
})

test('Next dev/start e worker exigem cwd exato, entrada conhecida e flags limitadas', () => {
  const next = argv => candidate({ cwd: root, argv: [executablePath, ...argv] })
  for (const argv of [
    ['node_modules/next/dist/bin/next', 'start', '-p', '3100'],
    [`${root}\\node_modules\\next\\dist\\bin\\next`, 'dev', '--turbopack', '--port=3100'],
    ['node_modules/.bin/../next/dist/bin/next', 'dev', '--hostname', '127.0.0.1'],
    [`${root}\\node_modules\\next\\dist\\server\\lib\\start-server.js`]
  ]) assert.equal(isWorktreePreviewProcess(root, next(argv)), true)
  for (const argv of [
    ['node_modules/next/dist/bin/next', 'build'],
    ['node_modules/next/dist/bin/next', 'start', '../another'],
    ['node_modules/next/dist/bin/next', 'dev', '--config', 'another.js'],
    ['node_modules/next/dist/bin/next', 'dev', '--port', 'invalid'],
    ['node_modules/next/dist/server/lib/start-server.js', 'unexpected'],
    ['-e', 'node_modules/next/dist/bin/next', 'dev']
  ]) assert.equal(isWorktreePreviewProcess(root, next(argv)), false)
  const preview = next(['node_modules/next/dist/bin/next', 'start'])
  assert.equal(isWorktreePreviewProcess(root, { ...preview, cwd: root + '-other' }), false)
  assert.equal(isWorktreePreviewProcess(root, { ...preview, cwd: undefined }), false)
})

test('Windows: prova identidade, encerra e aguarda somente filhos Astro sintéticos da raiz exata', {
  skip: process.platform !== 'win32', timeout: 60_000
}, async () => {
  const base = mkdtempSync(join(tmpdir(), "synkora-preview-' & $()-"))
  const missionRoot = join(base, 'mission with space')
  const siblingRoot = missionRoot + '-sibling'
  const children = []
  const source = 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)\n'
  function scriptIn(directory, name = join('node_modules', 'astro', 'bin', 'astro.mjs')) {
    const script = join(directory, name)
    mkdirSync(dirname(script), { recursive: true })
    writeFileSync(script, source)
    return script
  }
  async function launch(script, args) {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: dirname(script), windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    children.push(child)
    await Promise.race([
      once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) }),
      once(child, 'exit').then(([code]) => { throw new Error(`synthetic child exited before ready (${code})`) }),
      once(child, 'error').then(([error]) => { throw error })
    ])
    return child
  }
  function alive(child) {
    return child.exitCode === null && child.signalCode === null
  }
  try {
    const astroScript = scriptIn(missionRoot)
    const preview = await launch(astroScript, ['preview', '--port', '4321', '--host', '127.0.0.1'])
    const dev = await launch(astroScript, ['dev', '--host', '--port=4322'])
    const sibling = await launch(scriptIn(siblingRoot), ['preview', '--port', '4323'])
    const unrelated = await launch(scriptIn(missionRoot, 'unrelated.mjs'), ['preview', '--host', missionRoot])
    const overriddenRoot = await launch(astroScript, ['dev', '--root', siblingRoot])

    const proof = await probeWorktreePreviewProcesses(missionRoot)
    assert.equal(proof.failed, 0)
    assert.deepEqual(proof.processes.map((p) => p.pid).sort((a, b) => a - b), [preview.pid, dev.pid].sort((a, b) => a - b))
    assert.ok(proof.processes.every((p) => !('commandLine' in p)), 'nenhuma linha de comando bruta retorna')
    const previewProof = proof.processes.find((p) => p.pid === preview.pid)
    const reusedPid = await stopProbedWorktreePreviewProcesses(missionRoot, [{
      ...previewProof, creationTime: String(BigInt(previewProof.creationTime) + 1n)
    }])
    assert.deepEqual(reusedPid, { stopped: 0, failed: 1 })
    assert.equal(alive(preview), true, 'PID com data de criação diferente não é encerrado')

    const changedCommand = await stopProbedWorktreePreviewProcesses(missionRoot, [{
      ...previewProof, commandHash: '0'.repeat(64)
    }])
    assert.deepEqual(changedCommand, { stopped: 0, failed: 1 })
    assert.equal(alive(preview), true, 'comando alterado não é encerrado')

    // O incidente já havia removido parte da pasta; a prova do processo não
    // depende de o arquivo de entrada ainda existir no disco.
    rmSync(astroScript)
    const previewExited = once(preview, 'exit')
    const devExited = once(dev, 'exit')
    const recorded = []
    const lifecycle = createPaneLifecycle({
      ptys: { has: () => false, kill: () => assert.fail('nenhum filho sintético é um pane registrado') },
      blackbox: { record: (event) => recorded.push(event) },
      paneTokens: new Map(), paneSessions: new Map(), hub: {},
      unregisterPane() {}, cleanPaneMcpFile() {}, pushAll() {}
    }, { ensureBypassAccepted() {}, ensureCodexTrust() {} })
    assert.equal(lifecycle.testServerPanes.size, 0, 'previews desacoplados nunca entraram no registro de panes')
    await lifecycle.closeTestServersUnder(missionRoot)
    assert.equal(alive(preview), false)
    assert.equal(alive(dev), false)
    assert.deepEqual(recorded.map(({ event, detail }) => ({ event, stopped: detail?.stopped, failed: detail?.failed })), [
      { event: 'worktree-preview-processes-closed', stopped: 2, failed: 0 }
    ])
    await Promise.all([previewExited, devExited])
    assert.equal(alive(sibling), true)
    assert.equal(alive(unrelated), true)
    assert.equal(alive(overriddenRoot), true, 'override de raiz não pertence à allowlist')
    assert.deepEqual(await stopWorktreePreviewProcesses(missionRoot), { stopped: 0, failed: 0 })
  } finally {
    await Promise.all(children.map(async (child) => {
      if (!alive(child)) return
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }))
    const resolvedBase = resolve(base)
    const withinTemp = relative(resolve(tmpdir()), resolvedBase)
    assert.ok(withinTemp && !withinTemp.startsWith('..' + sep) && !withinTemp.includes(sep), 'limpeza fica na pasta temporária criada por este teste')
    rmSync(resolvedBase, { recursive: true, force: true })
  }
})

test('Windows: Next relativo, dev e worker liberam a pasta; runtime compartilhado e cwd alterado ficam isolados', {
  skip: process.platform !== 'win32', timeout: 60_000
}, async () => {
  const base = mkdtempSync(join(tmpdir(), "synkora-next-' & $()-"))
  const missionRoot = join(base, 'mission with space')
  const siblingRoot = missionRoot + '-sibling'
  const sharedModules = join(base, 'shared', 'node_modules')
  const children = []
  const source = 'process.on("message", directory => { process.chdir(directory); process.send("moved") }); process.stdout.write("ready\\n"); setInterval(() => {}, 1000)\n'
  const cli = join(sharedModules, 'next', 'dist', 'bin', 'next')
  const worker = join(sharedModules, 'next', 'dist', 'server', 'lib', 'start-server.js')
  for (const entry of [cli, worker]) {
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, source)
  }
  for (const directory of [missionRoot, siblingRoot]) {
    mkdirSync(directory)
    symlinkSync(sharedModules, join(directory, 'node_modules'), 'junction')
  }
  const alive = child => child.exitCode === null && child.signalCode === null
  async function launch(args, cwd = missionRoot) {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    children.push(child)
    await Promise.race([
      once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) }),
      once(child, 'exit').then(([code]) => { throw new Error(`synthetic Next exited before ready (${code})`) }),
      once(child, 'error').then(([error]) => { throw error })
    ])
    return child
  }
  try {
    const start = await launch(['node_modules/next/dist/bin/next', 'start', '-p', '3100'])
    const dev = await launch([cli, 'dev', '--turbopack', '--port=3101'])
    const server = await launch([worker])
    const moved = await launch([cli, 'start', '--hostname', '127.0.0.1'])
    const sibling = await launch([cli, 'start', '-p', '3102'], siblingRoot)
    const build = await launch([cli, 'build'])
    const override = await launch([cli, 'dev', '--config', 'another.js'])
    const proof = await probeWorktreePreviewProcesses(missionRoot)
    assert.equal(proof.failed, 0)
    assert.deepEqual(proof.processes.map(p => p.pid).sort(), [start, dev, server, moved].map(p => p.pid).sort())
    assert.ok(proof.processes.every(p => p.cwd.toLowerCase() === missionRoot.toLowerCase()))

    const movedProof = proof.processes.find(p => p.pid === moved.pid)
    const changedDirectory = once(moved, 'message')
    moved.send(siblingRoot)
    await changedDirectory
    assert.deepEqual(await stopProbedWorktreePreviewProcesses(missionRoot, [movedProof]), { stopped: 0, failed: 1 })
    assert.equal(alive(moved), true, 'a pasta é verificada novamente ao encerrar')

    const exited = [start, dev, server].map(child => once(child, 'exit'))
    assert.deepEqual(await stopWorktreePreviewProcesses(missionRoot), { stopped: 3, failed: 0 })
    await Promise.all(exited)
    for (const child of [sibling, moved, build, override]) assert.equal(alive(child), true, 'outros diretórios e comandos permanecem vivos')
    assert.deepEqual(await stopWorktreePreviewProcesses(missionRoot), { stopped: 0, failed: 0 })

    // These rejected fixture commands still intentionally hold the root. Move
    // their cwd by IPC; only the automatic preview cleanup above terminates.
    for (const child of [build, override]) {
      const changed = once(child, 'message')
      child.send(siblingRoot)
      await changed
    }
    renameSync(missionRoot, missionRoot + '-released')
  } finally {
    await Promise.all(children.map(async child => {
      if (!alive(child)) return
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }))
    const resolvedBase = resolve(base)
    const withinTemp = relative(resolve(tmpdir()), resolvedBase)
    assert.ok(withinTemp && !withinTemp.startsWith('..' + sep) && !withinTemp.includes(sep), 'limpeza limitada ao fixture temporário')
    rmSync(resolvedBase, { recursive: true, force: true })
  }
})
