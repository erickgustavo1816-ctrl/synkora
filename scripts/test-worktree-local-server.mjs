import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { probeWorktreePreviewProcesses, stopProbedWorktreePreviewProcesses, stopWorktreePreviewProcesses }
  from '../.tmp/worktree-preview-processes-test/main/worktreePreviewProcesses.js'

test('Windows: a custom loopback proxy is closed by workspace ownership, without a framework name', {
  skip: process.platform !== 'win32', timeout: 60_000
}, async () => {
  const base = mkdtempSync(join(tmpdir(), 'synkora-local-preview-'))
  const root = join(base, 'mission')
  const sibling = `${root}-sibling`
  for (const folder of [root, sibling]) mkdirSync(folder)
  const children = []
  const program = `import net from 'node:net';
const server = net.createServer();
server.listen(0, process.argv[2] ?? '127.0.0.1', () => process.stdout.write('ready\\n'));
process.on('message', folder => { process.chdir(folder); process.send('moved') });
`
  for (const folder of [root, sibling]) writeFileSync(join(folder, 'custom-proxy.mjs'), program)
  writeFileSync(join(root, 'background-job.mjs'), "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)")
  async function launch(args, cwd = root) {
    const child = spawn(process.execPath, args, { cwd, detached: true, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    children.push(child)
    await Promise.race([
      once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) }),
      once(child, 'error').then(([error]) => { throw error }),
      once(child, 'exit').then(() => { throw new Error('synthetic server exited before ready') })
    ])
    return child
  }
  const alive = child => child.exitCode === null && child.signalCode === null
  try {
    const proxy = await launch(['custom-proxy.mjs'])
    const moved = await launch(['custom-proxy.mjs'])
    const otherMission = await launch(['custom-proxy.mjs'], sibling)
    const externalScript = await launch([join(sibling, 'custom-proxy.mjs')])
    const publicListener = await launch(['custom-proxy.mjs', '0.0.0.0'])
    const job = await launch(['background-job.mjs'])
    const proof = await probeWorktreePreviewProcesses(root)
    assert.equal(proof.failed, 0)
    assert.deepEqual(proof.processes.map(p => p.pid).sort(), [proxy.pid, moved.pid].sort(),
      'the custom proxy holding this worktree must be found without matching its filename')
    assert.ok(proof.processes.every(p => p.loopbackPorts.length === 1 && p.argv.length === 2))
    const proxyProof = proof.processes.find(p => p.pid === proxy.pid)
    const wrongPort = proxyProof.loopbackPorts[0] === 65535 ? 65534 : proxyProof.loopbackPorts[0] + 1
    assert.deepEqual(await stopProbedWorktreePreviewProcesses(root, [{ ...proxyProof, loopbackPorts: [wrongPort] }]),
      { stopped: 0, failed: 1 }, 'the listener must still match the captured proof')
    assert.equal(alive(proxy), true)
    const movedProof = proof.processes.find(p => p.pid === moved.pid)
    const movedReceipt = once(moved, 'message')
    moved.send(sibling)
    await movedReceipt
    assert.deepEqual(await stopProbedWorktreePreviewProcesses(root, [movedProof]), { stopped: 0, failed: 1 })
    assert.equal(alive(moved), true)
    const exited = once(proxy, 'exit')
    assert.deepEqual(await stopWorktreePreviewProcesses(root), { stopped: 1, failed: 0 })
    await exited
    for (const child of [moved, otherMission, externalScript, publicListener, job]) assert.equal(alive(child), true)
    assert.deepEqual(await stopWorktreePreviewProcesses(root), { stopped: 0, failed: 0 })
  } finally {
    await Promise.all(children.filter(alive).map(async child => {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }))
    const inside = relative(resolve(tmpdir()), resolve(base))
    assert.ok(inside && !inside.startsWith('..' + sep) && !inside.includes(sep))
    // Verify the directory is no longer held, then remove only this fixture.
    const renamed = join(base, 'released')
    renameSync(root, renamed)
    rmSync(base, { recursive: true, force: true })
  }
})
