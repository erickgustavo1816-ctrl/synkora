import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'

mkdirSync(resolve('.tmp'), { recursive: true })
const directory = mkdtempSync(resolve('.tmp/gui-artifact-preview-'))
const bundle = join(directory, 'modules.mjs')
buildSync({ stdin: { contents: `
  export { GuiFileResolver, GUI_BROWSER_FILE_MIME, prepareGuiFileOpen } from './src/main/guiFileResolver';
  export { GuiArtifactPreviewServer } from './src/main/guiFileBrowserPreview';
  export { createGuiFileBrowserOpener } from './src/main/guiFileBrowserOpen';
  export { sanitizeGuiArtifactPreviewUrl, sanitizeGuiArtifactPreviewText } from './src/main/guiFileBrowserUrl';
  export { presentGuiFileBrowser } from './src/renderer/src/guiFileBrowserPresentation';
  export { fileContextOptions, fileOpenFamily } from './src/renderer/src/guiFileContextMenu';
  export { findGuiFileTokens } from './src/renderer/src/guiFileTokens';
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: bundle })
const { GuiFileResolver, GUI_BROWSER_FILE_MIME, prepareGuiFileOpen, GuiArtifactPreviewServer,
  createGuiFileBrowserOpener, sanitizeGuiArtifactPreviewUrl, sanitizeGuiArtifactPreviewText,
  presentGuiFileBrowser, fileContextOptions, fileOpenFamily, findGuiFileTokens } = await import(pathToFileURL(bundle))
after(() => rmSync(directory, { recursive: true, force: true }))

function fixture(t, options = {}) {
  const root = mkdtempSync(join(directory, 'tree-'))
  const write = (path, bytes) => {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes)
    return target
  }
  write('site/landing.html', '<!doctype html><title>Fixture</title><h1>Synthetic artifact</h1>')
  write('site/assets/style.css', 'h1 { color: rgb(31, 90, 55) }')
  write('site/assets/app.js', 'globalThis.fixtureReady = true')
  write('site/assets/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')
  write('site/report.pdf', '%PDF-1.4 synthetic')
  write('site/other.html', '<p>unselected synthetic document</p>')
  write('site/data.json', '{"fixture":true}')
  write('site/.hidden.css', 'synthetic hidden fixture')
  write('site/.config/test.css', 'synthetic hidden directory')
  write('site/secrets/test.css', 'synthetic sensitive directory')
  write('site/credentials.json', '{"synthetic":true}')
  write('site/app.ts', 'export const fixture = true')
  write('outside.css', 'synthetic outside selected directory')
  const resolver = new GuiFileResolver()
  const server = new GuiArtifactPreviewServer({ resolver, entryMime: GUI_BROWSER_FILE_MIME, ...options })
  t.after(() => server.close())
  const selected = resolver.resolve(root, 'site/landing.html')
  assert.equal(selected.ok, true)
  return { root, resolver, server, file: selected.file, write }
}

async function leaseFor(t, options = {}) {
  const fixtureValue = fixture(t, options)
  const opened = await fixtureValue.server.open(fixtureValue.file, () => true)
  assert.equal(opened.ok, true, 'synthetic preview should start')
  return { ...fixtureValue, lease: opened.lease }
}

function request(url, tail = null, options = {}) {
  const parsed = new URL(url)
  const prefix = parsed.pathname.slice(0, parsed.pathname.lastIndexOf('/') + 1)
  return new Promise((done, reject) => {
    const request = httpRequest({ hostname: parsed.hostname, port: parsed.port,
      path: tail === null ? parsed.pathname : prefix + tail, method: options.method ?? 'GET',
      headers: options.headers, agent: false }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => done({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
    })
    request.on('error', error => reject(new Error(`synthetic preview transport: ${error.code ?? 'failure'}`)))
    request.end()
  })
}

test('default routing covers native browser artifacts and keeps source/text readers', t => {
  const { root, resolver, write } = fixture(t)
  for (const extension of ['html', 'htm', 'xhtml', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'avif', 'ico', 'webp', 'mp3', 'wav', 'ogg', 'm4a', 'mp4', 'webm', 'ogv']) {
    const name = `entry.${extension}`
    write(`site/${name}`, 'synthetic artifact')
    const result = resolver.resolve(root, `site/${name}`, `site/${name}`)
    assert.equal(result.ok, true, extension)
    assert.equal(prepareGuiFileOpen(result.file).action, 'browser', extension)
    assert.notEqual(fileOpenFamily(name), 'plain', extension)
    assert.equal(findGuiFileTokens(name)[0]?.value, name, extension)
    const options = fileContextOptions({ paneId: 'pane', reference: name, path: name })
    assert.equal(options[0]?.action, 'open-browser', extension)
  }
  for (const extension of ['ts', 'py', 'txt']) {
    write(`site/source.${extension}`, 'synthetic source')
    const result = resolver.resolve(root, `site/source.${extension}`)
    assert.equal(prepareGuiFileOpen(result.file).action, 'preview')
    assert.equal(prepareGuiFileOpen(result.file, 'browser').ok, false)
  }
  const pdf = resolver.resolve(root, 'site/report.pdf')
  assert.equal(prepareGuiFileOpen(pdf.file).action, 'reveal')
  assert.equal(prepareGuiFileOpen(pdf.file, 'browser').ok, false)
  assert.equal(fileContextOptions({ paneId: 'pane', reference: 'report.pdf', path: 'report.pdf' })
    .some(option => option.action === 'open-browser'), false,
  'native PDF viewer is unsupported in the required private session; do not advertise a blank preview')
})

test('preview serves selected HTML and relative CSS/JS/images with deliberate HTTP headers', async t => {
  const { lease } = await leaseFor(t)
  const html = await request(lease.url)
  assert.equal(html.status, 200)
  assert.ok(html.body.includes(Buffer.from('Synthetic artifact')))
  assert.equal(html.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(html.headers['referrer-policy'], 'no-referrer')
  assert.equal(html.headers['cache-control'], 'no-store')
  assert.equal(html.headers['x-content-type-options'], 'nosniff')
  assert.equal(html.headers['access-control-allow-origin'], undefined)
  assert.ok(html.headers['content-security-policy'].includes('sandbox allow-scripts allow-same-origin'))
  assert.ok(html.headers['content-security-policy'].includes("worker-src 'none'"))
  for (const [path, mime] of [['assets/style.css', 'text/css'], ['assets/app.js', 'text/javascript'], ['assets/icon.svg', 'image/svg+xml']]) {
    const asset = await request(lease.url, path)
    assert.equal(asset.status, 200, path)
    assert.ok(asset.headers['content-type'].startsWith(mime), path)
  }
})

test('HTTP preview does not authorize neighbors, hidden paths, traversal, bad hosts or write methods', async t => {
  const { lease } = await leaseFor(t)
  for (const path of ['report.pdf', 'other.html', 'data.json', 'app.ts', '.hidden.css', '.config/test.css',
    'secrets/test.css', 'credentials.json', '../outside.css', '%2e%2e/outside.css', '%252e%252e/outside.css',
    'assets%2fstyle.css', 'assets%5cstyle.css', 'assets/%00style.css', 'assets/', '', 'C:/outside.css']) {
    assert.equal((await request(lease.url, path)).status, 404, path)
  }
  assert.equal((await request(lease.url, null, { headers: { host: 'untrusted.invalid' } })).status, 403)
  assert.equal((await request(lease.url, null, { headers: { origin: 'https://untrusted.invalid' } })).status, 403)
  assert.equal((await request(lease.url, null, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    assert.equal((await request(lease.url, null, { method })).status, 405)
  }
  const forged = new URL(lease.url)
  const parts = forged.pathname.split('/'); parts[2] = '0'.repeat(48)
  forged.pathname = parts.join('/')
  assert.equal((await request(forged.href)).status, 404)
})

test('range and HEAD support native media loading without reading unrestricted files', async t => {
  const { root, server, resolver, write } = fixture(t)
  write('site/selected.mp4', 'SYNTHETIC media range body')
  const file = resolver.resolve(root, 'site/selected.mp4').file
  const opened = await server.open(file, () => true)
  assert.equal(opened.ok, true)
  const range = await request(opened.lease.url, null, { headers: { range: 'bytes=0-7' } })
  assert.equal(range.status, 206)
  assert.equal(range.body.toString(), 'SYNTHETI')
  assert.equal(range.headers['content-type'], 'video/mp4')
  assert.equal(range.headers['content-security-policy'], undefined, 'HTML sandbox must not disable the native media player')
  const head = await request(opened.lease.url, null, { method: 'HEAD' })
  assert.equal(head.status, 200); assert.equal(head.body.length, 0)
  assert.ok(Number(head.headers['content-length']) > 8)
  assert.equal((await request(opened.lease.url, null, { headers: { range: 'bytes=900-' } })).status, 416)
  assert.equal((await request(opened.lease.url, null, { headers: { range: 'bytes=0-1,4-5' } })).status, 416)
})

test('preview revalidates symlink/junction changes on every resource access', async t => {
  const { root, lease, write } = await leaseFor(t)
  const outside = join(root, 'outside')
  mkdirSync(outside); writeFileSync(join(outside, 'secret.css'), 'synthetic outside fixture')
  try { symlinkSync(outside, join(root, 'site', 'linked'), process.platform === 'win32' ? 'junction' : 'dir') }
  catch { t.skip('synthetic junction creation unavailable'); return }
  assert.equal((await request(lease.url, 'linked/secret.css')).status, 404)
  write('site/swapped/original.css', 'synthetic original')
  assert.equal((await request(lease.url, 'swapped/original.css')).status, 200)
  rmSync(join(root, 'site', 'swapped'), { recursive: true })
  symlinkSync(outside, join(root, 'site', 'swapped'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await request(lease.url, 'swapped/secret.css')).status, 404)
})

test('lease count, bytes and lifetime are bounded; closed capabilities stop serving', async t => {
  const { file, server, write } = fixture(t, { maxLeases: 1, maxBytes: 128, ttlMs: 100 })
  const first = await server.open(file, () => true)
  assert.equal(first.ok, true)
  assert.equal((await server.open(file, () => true)).ok, false)
  write('site/assets/large.css', ' '.repeat(129))
  assert.equal((await request(first.lease.url, 'assets/large.css')).status, 413)
  first.lease.close()
  assert.equal(first.lease.alive(), false)
  const reopened = await server.open(file, () => true)
  assert.equal(reopened.ok, true)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(reopened.lease.alive(), false)
  await assert.rejects(request(reopened.lease.url), /synthetic preview transport/)
})

test('preview access checks the pane identity again, rather than retaining a killed pane authority', async t => {
  const { file, server } = fixture(t)
  let authorized = true
  const opened = await server.open(file, () => authorized)
  assert.equal(opened.ok, true)
  authorized = false
  try { assert.equal((await request(opened.lease.url)).status, 410) }
  catch (error) { assert.ok(error.message.includes('synthetic preview transport')) }
  assert.equal(opened.lease.alive(), false)
})

test('owner artifact opening never navigates an agent tab and rolls back failed presentations', async t => {
  const { file } = fixture(t)
  let owner = { missionId: 'mission', projectId: 'project', cwd: file.rootPath }
  let closed = 0, newTabs = 0, leaseClosed = 0, popouts = 0
  const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const lease = { url: 'synthetic main-only URL', alive: () => true, close: () => { leaseClosed++ } }
  const browser = {
    state: () => ({ projectId: 'project', host: 'dock', activeTabId: 'agent-tab' }),
    newArtifactTab: async (mission, project, url) => {
      assert.equal(mission, 'mission'); assert.equal(project, 'project'); assert.equal(url, lease.url)
      newTabs++; return { ok: true, tabId: 'owner-artifact-tab' }
    },
    tabById: (_mission, tab) => tab === 'owner-artifact-tab' ? { tabId: tab, webContents: wc } : undefined,
    closeTab: (_mission, tab) => { assert.equal(tab, 'owner-artifact-tab'); closed++; return true },
    popOut: () => { popouts++; return { ok: false, error: 'synthetic popout failure' } }
  }
  const open = createGuiFileBrowserOpener({ browser, previews: { open: async () => ({ ok: true, lease }) }, identity: () => owner })
  const first = await open('pane', file)
  assert.equal(first.ok, true); assert.equal(first.action, 'browser'); assert.equal(newTabs, 1)
  assert.equal(closed, 0); assert.equal(popouts, 0)
  wc.emit('destroyed'); assert.equal(leaseClosed, 1)
  browser.state = () => ({ projectId: 'project', host: 'popout' })
  assert.equal((await open('pane', file)).ok, false)
  assert.equal(closed, 1); assert.equal(popouts, 1); assert.equal(leaseClosed, 2)
  owner = undefined
  assert.equal((await open('pane', file)).ok, false); assert.equal(newTabs, 2)
})

test('successful owner result reveals the current workspace browser and preserves popout/stale navigation', async () => {
  const calls = []
  const result = { ok: true, action: 'browser', missionId: 'mission', projectId: 'project', host: 'dock', message: 'ok' }
  const context = { projectId: 'project', visible: true, selectedMissionId: 'mission', openPanel: id => calls.push(id) }
  assert.equal((await presentGuiFileBrowser(result, context)).ok, true)
  assert.deepEqual(calls, ['browser'])
  assert.equal((await presentGuiFileBrowser({ ...result, host: 'popout' }, context)).ok, true)
  assert.deepEqual(calls, ['browser'])
  assert.equal((await presentGuiFileBrowser(result, { ...context, selectedMissionId: 'other-mission' })).ok, false)
  assert.equal((await presentGuiFileBrowser(result, { ...context, visible: false })).ok, false)
  assert.deepEqual(calls, ['browser'])
  assert.equal((await presentGuiFileBrowser(result, null, async mission => {
    assert.equal(mission, 'mission'); calls.push('popout'); return { ok: true }
  })).ok, true)
  assert.equal((await presentGuiFileBrowser(result, null)).ok, false)
})

test('preview capability URLs are masked in journal and embedded/relative text without touching normal URLs', () => {
  const token = 'a'.repeat(48)
  const url = `http://127.0.0.1:4567/__synkora_preview/${token}/synthetic.html?q=1`
  assert.equal(sanitizeGuiArtifactPreviewUrl(url), 'http://127.0.0.1/[artifact-preview]')
  for (const value of [url, 'loaded ' + url, '/__synkora_preview/' + token + '/synthetic.html', '/__synkora_preview/' + token.slice(0, 12)]) {
    assert.equal(sanitizeGuiArtifactPreviewText(value).includes(token.slice(0, 12)), false)
  }
  const ordinary = 'http://127.0.0.1:8790/index.html https://example.invalid/page'
  assert.equal(sanitizeGuiArtifactPreviewText(ordinary), ordinary)
  const manager = readFileSync(resolve('src/main/browserPane.ts'), 'utf8')
  assert.ok(manager.includes('newArtifactTab(')); assert.ok(manager.includes('`browser-artifact-${randomUUID()}`'))
  assert.ok(manager.includes('disposeEphemeralSession?.(tab.ephemeralPartition)'))
})
