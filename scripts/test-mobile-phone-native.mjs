import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

test('real phone windows expose the restricted preload and enforce native presentation boundaries', { timeout: 45_000 }, async t => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const directory = await mkdtemp(resolve('.tmp/mobile-phone-native-'))
  for (const name of ['profile', 'session-data', 'logs']) await mkdir(join(directory, name))
  await writeFile(join(directory, 'fixture.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'unsafe-inline\'; frame-src \'self\'"><title>Synthetic phone boundary fixture</title><body style="margin:0;background:transparent"></body></html>')
  await Promise.all([
    build({ entryPoints: ['src/preload/index.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22',
      outfile: join(directory, 'preload.cjs'), external: ['electron'], logLevel: 'silent' }),
    build({ entryPoints: ['scripts/fixtures/mobile-phone-qa/main.mjs'], bundle: true, platform: 'node', format: 'cjs', target: 'node22',
      outfile: join(directory, 'main.cjs'), external: ['electron'], logLevel: 'silent' })
  ])
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(createRequire(import.meta.url)('electron'), [join(directory, 'main.cjs'), directory], {
    cwd: resolve('.'), env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let output = ''
  const capture = chunk => { output = (output + chunk.toString()).slice(-64 * 1024) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
  await writeFile(join(directory, 'result.log'), output)
  assert.equal(code, 0, output)
  assert.match(output, /MOBILE_PHONE_NATIVE_PASS/u)
  console.log(output.trim())
  console.log(`Isolated evidence: ${directory}`)
})
