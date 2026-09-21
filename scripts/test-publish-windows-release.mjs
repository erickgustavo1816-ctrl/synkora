import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'
import { githubGateway, publishWindowsRelease } from './publish-windows-release.mjs'

const installer = 'Synkora-0.1.0-setup.exe'
const sha256 = data => createHash('sha256').update(data).digest('hex')

function fixture(t, existingInstaller) {
  const temporaryRoot = resolve(tmpdir())
  const outputDirectory = mkdtempSync(join(temporaryRoot, 'synkora-publisher-'))
  t.after(() => {
    assert.equal(dirname(resolve(outputDirectory)), temporaryRoot)
    assert.ok(basename(outputDirectory).startsWith('synkora-publisher-'))
    rmSync(outputDirectory, { recursive: true, force: true })
  })
  const local = Buffer.from('synthetic-local-installer\n'.repeat(500))
  writeFileSync(join(outputDirectory, installer), local)
  const state = {
    release: existingInstaller ? { draft: false, prerelease: false, published_at: '2026-09-21T12:00:00Z', html_url: 'https://example.invalid/release' } : null,
    files: new Map(existingInstaller ? [[installer, existingInstaller]] : []),
    calls: [], failUpload: null, corruptDownload: false
  }
  const gateway = {
    async read() {
      if (!state.release) return null
      return { ...state.release, assets: [...state.files].map(([name, data]) => ({ name, state: 'uploaded', size: data.length, digest: `sha256:${sha256(data)}` })) }
    },
    async download(tag, name, destination) {
      const data = Buffer.from(state.files.get(name))
      if (state.corruptDownload) data[0] ^= 1
      writeFileSync(destination, data)
    },
    async createDraft(tag) {
      assert.equal(state.release, null, 'a release can only be created once')
      state.calls.push('create-draft')
      state.release = { draft: true, prerelease: false, html_url: 'https://example.invalid/release' }
      return gateway.read(tag)
    },
    async upload(tag, file) {
      const name = basename(file)
      assert.equal(state.files.has(name), false, 'published files cannot be overwritten')
      if (name === state.failUpload) throw new Error('synthetic upload interruption')
      state.calls.push(`upload:${name}`)
      state.files.set(name, readFileSync(file))
    },
    async publish() {
      assert.equal(state.files.size, 3, 'a draft is published only after every asset exists')
      state.calls.push('publish')
      state.release.draft = false
    }
  }
  return { state, local, gateway, run: () => publishWindowsRelease({ version: '0.1.0', outputDirectory, gateway }) }
}

// GitHub's tag endpoint only returns published releases. Authenticated listings
// include drafts, including drafts left behind by an interrupted workflow.
function readThroughGithub(f, { listError } = {}) {
  const repository = 'erickgustavo1816-ctrl/synkora-releases'
  const requests = []
  const snapshot = () => f.state.release && {
    ...f.state.release,
    tag_name: 'v0.1.0',
    assets: [...f.state.files].map(([name, data]) => ({ name, state: 'uploaded', size: data.length, digest: `sha256:${sha256(data)}` }))
  }
  f.gateway.read = githubGateway(repository, (command, args) => {
    assert.equal(command, 'gh')
    assert.equal(args[0], 'api')
    requests.push(args)
    const release = snapshot()
    if (args[1] === `repos/${repository}/releases/tags/v0.1.0`) {
      if (release && !release.draft) return JSON.stringify(release)
      throw Object.assign(new Error('synthetic missing published release'), { stderr: 'HTTP 404' })
    }
    assert.equal(args[1], `repos/${repository}/releases?per_page=100`)
    assert.ok(args.includes('--paginate'))
    assert.ok(args.includes('--slurp'))
    if (listError) throw Object.assign(new Error('synthetic release listing failure'), { stderr: `HTTP ${listError}` })
    return JSON.stringify([[{ tag_name: 'v9.9.9', draft: false, assets: [] }], release ? [release] : []])
  }).read
  return requests
}

test('GitHub publication verifies a new draft when the tag endpoint returns 404', async t => {
  const f = fixture(t)
  const requests = readThroughGithub(f)
  const result = await f.run()
  assert.equal(f.state.release.draft, false)
  assert.deepEqual(f.state.calls, ['create-draft', `upload:${installer}`, `upload:${installer}.blockmap`, 'upload:latest.yml', 'publish'])
  assert.equal(result.preservedInstaller, false)
  assert.ok(requests.some(args => args.includes('--paginate')))
})

test('GitHub publication resumes a draft on a later page and preserves its installer', async t => {
  const published = Buffer.from('synthetic-draft-installer\n'.repeat(500))
  const f = fixture(t, published)
  f.state.release.draft = true
  readThroughGithub(f)
  const result = await f.run()
  assert.equal(result.preservedInstaller, true)
  assert.deepEqual(f.state.calls, [`upload:${installer}.blockmap`, 'upload:latest.yml', 'publish'])
  assert.deepEqual(f.state.files.get(installer), published)
})

test('GitHub publication stops before writes when draft lookup is denied', async t => {
  const f = fixture(t)
  readThroughGithub(f, { listError: '403' })
  await assert.rejects(f.run, /HTTP 403/)
  assert.deepEqual(f.state.calls, [])
})

test('new release is created once as a draft and published after all verified assets', async t => {
  const f = fixture(t)
  const result = await f.run()
  assert.deepEqual(f.state.calls, ['create-draft', `upload:${installer}`, `upload:${installer}.blockmap`, 'upload:latest.yml', 'publish'])
  assert.equal(result.preservedInstaller, false)
  const blockmap = JSON.parse(gunzipSync(f.state.files.get(`${installer}.blockmap`)))
  assert.equal(blockmap.files[0].sizes.reduce((sum, size) => sum + size, 0), f.local.length)
  assert.equal(blockmap.files[0].checksums.length, blockmap.files[0].sizes.length)
})

test('partial public release derives missing metadata from the existing installer', async t => {
  const published = Buffer.from('synthetic-published-installer\n'.repeat(500))
  const f = fixture(t, published)
  const result = await f.run()
  assert.equal(result.preservedInstaller, true)
  assert.deepEqual(f.state.calls, [`upload:${installer}.blockmap`, 'upload:latest.yml'])
  assert.deepEqual(f.state.files.get(installer), published)
  const checksum = createHash('sha512').update(published).digest('base64')
  assert.ok(f.state.files.get('latest.yml').toString().includes(checksum))
  assert.notDeepEqual(published, f.local, 'the fixture must detect accidental use of the local build')
})

test('retrying a complete release leaves all published assets unchanged', async t => {
  const f = fixture(t)
  await f.run()
  const before = [...f.state.files].map(([name, data]) => [name, sha256(data)])
  f.state.calls.length = 0
  const result = await f.run()
  assert.deepEqual(f.state.calls, [])
  assert.deepEqual(result.uploaded, [])
  assert.deepEqual([...f.state.files].map(([name, data]) => [name, sha256(data)]), before)
})

test('an interrupted draft resumes without recreating the release or replacing its installer', async t => {
  const f = fixture(t)
  f.state.failUpload = `${installer}.blockmap`
  await assert.rejects(f.run, /synthetic upload interruption/)
  assert.equal(f.state.release.draft, true)
  assert.equal(f.state.files.size, 1)
  f.state.failUpload = null
  await f.run()
  assert.equal(f.state.calls.filter(call => call === 'create-draft').length, 1)
  assert.equal(f.state.calls.filter(call => call === `upload:${installer}`).length, 1)
  assert.equal(f.state.release.draft, false)
})

test('conflicting published metadata stops before any remote write', async t => {
  const f = fixture(t, Buffer.from('published fixture'))
  f.state.files.set('latest.yml', Buffer.from('version: 9.9.9\n'))
  await assert.rejects(f.run, /another version/)
  assert.deepEqual(f.state.calls, [])
})

test('a downloaded installer checksum mismatch stops before any remote write', async t => {
  const f = fixture(t, Buffer.from('published fixture'))
  f.state.corruptDownload = true
  await assert.rejects(f.run, /checksum mismatch/)
  assert.deepEqual(f.state.calls, [])
})
