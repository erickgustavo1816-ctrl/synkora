/** Offline pixel regression: synthetic fine strokes through real H.264/WebCodecs.
 * The pre-generated fixture needs only the decoder used by the product.
 * Uses only a hidden isolated Electron window; never contacts a mobile device. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

async function inspect() {
  const { app, BrowserWindow } = await import('electron')
  const directory = process.argv[2]
  app.setPath('userData', join(directory, 'profile'))
  const deadline = setTimeout(() => app.exit(1), 20_000)
  await app.whenReady()
  const window = new BrowserWindow({ width: 800, height: 600, show: false, focusable: false, skipTaskbar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  try {
    await window.loadFile(join(directory, 'index.html'))
    const encoded = await readFile(resolve('scripts/fixtures/mobile-sharpness-text.h264'))
    assert.equal(encoded.length, 91033, 'synthetic frame byte bound')
    assert.equal(createHash('sha256').update(encoded).digest('hex'), '9b36db846629511d7f5a2c52e7f71c967bbd7a390e8884237e384111c417fa2f', 'synthetic fixture provenance')
    const result = await window.webContents.executeJavaScript(`(async () => {
      const data = Uint8Array.from(atob('${encoded.toString('base64')}'), value => value.charCodeAt(0));
      let codec;
      for (let i = 0; i + 6 < data.length; i++) if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 31) === 7) {
        codec = 'avc1.' + [...data.subarray(i + 4, i + 7)].map(x => x.toString(16).padStart(2, '0')).join(''); break;
      }
      if (!codec) throw new Error('The synthetic key frame has no SPS');
      const canvas = document.getElementById('video'), holder = canvas.parentElement;
      holder.style.width = (294 / devicePixelRatio) + 'px'; holder.style.height = (653 / devicePixelRatio) + 'px';
      const NativeDecoder = window.VideoDecoder;
      let referenceFrame;
      window.VideoDecoder = class extends NativeDecoder {
        constructor(init) { super({ ...init, output(frame) { referenceFrame?.close(); referenceFrame = frame.clone(); init.output(frame); } }); }
      };
      let state, consumed = 0, recoveries = 0, dimensions;
      const player = MobileVideoSharpness.createMobileVideoRenderer(canvas, value => { state = value; }, {
        onConsumed() { consumed++; }, onRecovery() { recoveries++; }, onDimensions(value) { dimensions = value; }
      });
      try {
        player.push({ missionId: 'synthetic-sharpness', sessionId: 'synthetic-session', streamId: 'synthetic-stream',
          codec, timestampUs: 0, key: true, data });
        const started = performance.now();
        while (state !== 'playing' && performance.now() - started < 5000) await new Promise(done => setTimeout(done, 20));
        if (state !== 'playing') throw new Error('The production renderer never painted the synthetic video');
        // Reference uses the same decoded pixels. Snapshot them 1:1, then apply
        // the browser's image minifier, which conserves small strokes. Reading
        // pixels and cloning a frame happen only in this offline test.
        const native = new OffscreenCanvas(1080, 2400), nativeContext = native.getContext('2d', { alpha: false });
        nativeContext.drawImage(referenceFrame, 0, 0);
        const reference = new OffscreenCanvas(294, 653), referenceContext = reference.getContext('2d', { alpha: false });
        const scale = Math.min(294 / 1080, 653 / 2400), width = 1080 * scale, height = 2400 * scale;
        referenceContext.imageSmoothingQuality = 'high';
        referenceContext.drawImage(native, (294 - width) / 2, (653 - height) / 2, width, height);
        const pixels = canvas.getContext('2d').getImageData(8, 15, 270, 500).data;
        const expected = referenceContext.getImageData(8, 15, 270, 500).data;
        let squares = 0, count = 0, expectedInk = 0, actualInk = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (expected[i] > 253 && pixels[i] > 253) continue;
          const error = pixels[i] - expected[i]; squares += error * error; count++;
          expectedInk += 255 - expected[i]; actualInk += 255 - pixels[i];
        }
        const rmse = Math.sqrt(squares / count), inkRatio = actualInk / expectedInk;
        return { rmse, inkRatio, comparedPixels: count, frameFormat: referenceFrame.format, width: canvas.width, height: canvas.height,
          dimensions, consumed, recoveries, state };
      } finally { player.dispose(); referenceFrame?.close(); window.VideoDecoder = NativeDecoder; }
    })()`)
    console.log(JSON.stringify(result))
    assert.deepEqual(result.dimensions, { width: 1080, height: 2400 })
    assert.equal(result.width, 294)
    assert.equal(result.height, 653)
    assert.equal(result.consumed, 1)
    assert.equal(result.recoveries, 0)
    assert.ok(result.comparedPixels > 1000, 'the synthetic text must exercise enough fine strokes')
    assert.ok(result.rmse < 3, `fine strokes diverged from the same-source image reference: ${result.rmse}`)
    assert.ok(Math.abs(result.inkRatio - 1) < .03, `fine stroke coverage changed: ${result.inkRatio}`)
  } finally { clearTimeout(deadline); window.destroy() }
}

if (process.versions.electron) {
  inspect().then(async () => (await import('electron')).app.exit(0))
    .catch(async error => { console.error(error.stack); (await import('electron')).app.exit(1) })
} else {
  test('real H.264 VideoFrame reduction preserves thin-stroke coverage in isolated Chromium', { timeout: 30_000 }, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/mobile-video-sharpness-'))
    await build({ entryPoints: ['src/renderer/src/mobileVideo.ts'], bundle: true, platform: 'browser', format: 'iife',
      globalName: 'MobileVideoSharpness', outfile: join(directory, 'renderer.js') })
    await writeFile(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'"><title>Synthetic mobile video sharpness</title><div style="position:relative;width:120px;height:240px"><canvas id="video" style="position:absolute"></canvas></div><script src="renderer.js"></script>')
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), directory],
      { env: environment, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let output = ''
    const capture = chunk => { if (output.length < 16_384) output += chunk.toString().slice(0, 16_384 - output.length) }
    child.stdout.on('data', capture); child.stderr.on('data', capture)
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
    assert.equal(code, 0, output || 'The isolated sharpness proof failed without a result')
    console.log(output.trim())
  })
}
