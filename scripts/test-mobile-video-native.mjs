/** Optional offline proof using a synthetic screenrecord capture supplied by the
 * native test controller. Never launches or contacts an Android device. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { H264AnnexBParser } from '../.tmp/mobile-video-test/main/mobileH264.js'
import { mobileProcessEnvironment } from '../.tmp/mobile-video-test/main/mobileProcess.js'

async function inspect() {
  const { app, BrowserWindow } = await import('electron')
  const directory = process.argv[2]
  app.setPath('userData', join(directory, 'profile'))
  const deadline = setTimeout(() => app.exit(1), 25_000)
  await app.whenReady()
  const window = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true,
    webPreferences: { nodeIntegration: false, sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } })
  try {
    const decoder = await readFile(join(directory, 'decoder.js'), 'utf8')
    const packets = JSON.parse(await readFile(join(directory, 'packets.json'), 'utf8'))
    await writeFile(join(directory, 'fixture.html'), '<!doctype html><title>Synthetic decoder proof</title><div style="position:relative;width:270px;height:600px"><canvas id="video" style="position:absolute"></canvas></div>')
    await window.loadFile(join(directory, 'fixture.html'))
    const result = await window.webContents.executeJavaScript(`(async () => {
      ${decoder}
      const NativeDecoder = window.VideoDecoder;
      let decoded = 0, closedFrames = 0, errors = 0, recoveries = 0, decoderCount = 0;
      const frames = [];
      window.VideoDecoder = class extends NativeDecoder {
        constructor(init) { super({
          output(frame) { decoded++; frames.push(frame); init.output(frame); },
          error(error) { errors++; init.error(error); }
        }); decoderCount++; }
      };
      const canvas = document.getElementById('video');
      const states = [];
      const packets = ${JSON.stringify(packets)};
      let index = 0, consumed = 0, inFlight = 0, maxInFlight = 0, releasedStatic = false;
      let staticTimer, staticState;
      const player = MobileNativeVideoRenderer.createMobileVideoRenderer(canvas, state => states.push(state), {
        onConsumed() {
          consumed++; inFlight--;
          if (consumed === 20 && !releasedStatic) {
            staticTimer = setTimeout(() => {
              staticState = states.at(-1); releasedStatic = true; feed();
            }, 12000);
          } else queueMicrotask(feed);
        },
        onRecovery() { recoveries++; }
      });
      function feed() {
        while (index < packets.length && inFlight < 3 && (releasedStatic || index < 20)) {
          const item = packets[index];
          inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
          player.push({ missionId: 'synthetic-native-proof', sessionId: 'synthetic-native-session',
            streamId: 'offline-capture', codec: item.codec, timestampUs: index * 33333,
            key: item.key, data: Uint8Array.from(atob(item.data), value => value.charCodeAt(0)) });
          index++;
        }
      }
      const started = performance.now();
      feed();
      while (consumed < packets.length && performance.now() - started < 18000) await new Promise(resolve => setTimeout(resolve, 25));
      await new Promise(resolve => setTimeout(resolve, 250));
      clearTimeout(staticTimer);
      const image = canvas.toDataURL('image/png');
      player.dispose();
      for (const frame of frames) { try { frame.allocationSize(); } catch { closedFrames++; } }
      const result = { decoded, closedFrames, errors, width: canvas.width, height: canvas.height,
        states, consumed, maxInFlight, recoveries, decoderCount, staticState, image };
      return result;
    })()`)
    const { image, ...metadata } = result
    assert.equal(result.errors, 0, 'decoder errors')
    assert.equal(result.decoded, packets.length, 'decoded frames')
    assert.equal(result.closedFrames, packets.length, 'closed frames')
    assert.equal(result.consumed, packets.length, 'consumed credits')
    assert.equal(result.maxInFlight, 3)
    assert.equal(result.recoveries, 0)
    assert.equal(result.decoderCount, 1)
    assert.equal(result.staticState, 'playing')
    assert.equal(result.states.at(-1), 'playing')
    assert.ok(result.width > 0 && result.height > 0)
    await writeFile(join(directory, 'decoded.png'), Buffer.from(result.image.split(',')[1], 'base64'))
    console.log(JSON.stringify({ ...metadata, packetCount: packets.length, screenshot: join(directory, 'decoded.png') }))
  } finally {
    clearTimeout(deadline)
    window.destroy()
    app.quit()
  }
}

if (process.versions.electron) {
  inspect().catch(error => { console.error(error.message); process.exit(1) })
} else {
  const capture = resolve('.tmp/mobile-native/screen.h264')
  test('isolated Electron WebCodecs decodes every real synthetic screenrecord access unit', { skip: !existsSync(capture), timeout: 35_000 }, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/mobile-video-native-'))
    await build({ entryPoints: ['src/renderer/src/mobileVideo.ts'], bundle: true, platform: 'browser', format: 'iife',
      globalName: 'MobileNativeVideoRenderer', outfile: join(directory, 'decoder.js') })
    const bytes = await readFile(capture)
    const packets = []
    const parser = new H264AnnexBParser(unit => packets.push({ ...unit, data: Buffer.from(unit.data).toString('base64') }))
    for (let offset = 0; offset < bytes.length; offset += 997) parser.push(bytes.subarray(offset, offset + 997))
    parser.flush()
    assert.ok(packets.length > 1)
    assert.equal(packets[0].key, true)
    await writeFile(join(directory, 'packets.json'), JSON.stringify(packets))
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), directory],
      { windowsHide: true, shell: false, env: mobileProcessEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let output = ''
    child.stdout.on('data', chunk => { if (output.length < 16_384) output += chunk })
    child.stderr.on('data', chunk => { if (output.length < 16_384) output += chunk })
    const code = await new Promise((done, reject) => { child.on('error', reject); child.on('close', done) })
    assert.equal(code, 0, output || 'The isolated decoder fixture failed without a decoded-frame result.')
    console.log(output.trim())
  })
}
