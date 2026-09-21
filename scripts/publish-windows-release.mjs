import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap')
const digest = (data, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(data).digest(encoding)

function validateMetadata(data, version, installer, bytes) {
  const info = yaml.load(data.toString('utf8'))
  assert.equal(info.version, version, 'Published update metadata has another version')
  assert.equal(info.path, installer, 'Published update metadata names another installer')
  assert.equal(info.sha512, digest(bytes, 'sha512', 'base64'), 'Published update metadata has another checksum')
  assert.equal(info.files?.length, 1, 'Expected one Windows installer')
  assert.equal(info.files[0].url, installer)
  assert.equal(info.files[0].sha512, info.sha512)
  assert.equal(info.files[0].size, bytes.length)
}

/** Reconcile only the three Windows assets. Existing installers and tags are immutable here. */
export async function publishWindowsRelease({ version, outputDirectory, gateway }) {
  assert.match(version, /^\d+\.\d+\.\d+$/, 'This workflow publishes the stable Windows channel')
  const tag = `v${version}`
  const installer = `Synkora-${version}-setup.exe`
  const names = [installer, `${installer}.blockmap`, 'latest.yml']
  let release = await gateway.read(tag)
  assert.ok(!release?.prerelease, 'A prerelease cannot be published to the stable channel')
  const assets = new Map((release?.assets ?? []).map(asset => [asset.name, asset]))
  const work = join(outputDirectory, 'publication')
  mkdirSync(work, { recursive: true })

  async function downloadVerified(asset, destination) {
    assert.equal(asset.state, 'uploaded', `Asset is still uploading: ${asset.name}`)
    await gateway.download(tag, asset.name, destination)
    const contents = readFileSync(destination)
    assert.equal(contents.length, asset.size, `Downloaded asset size mismatch: ${asset.name}`)
    assert.equal(asset.digest, `sha256:${digest(contents)}`, `Downloaded asset checksum mismatch: ${asset.name}`)
    return contents
  }

  // When recovering a partial publication, derive metadata from the actual
  // published binary, never from a rebuilt installer with the same version.
  const installerPath = join(work, installer)
  const binary = assets.has(installer)
    ? await downloadVerified(assets.get(installer), installerPath)
    : readFileSync(join(outputDirectory, installer))
  writeFileSync(installerPath, binary)
  await buildBlockMap(installerPath, 'gzip', `${installerPath}.blockmap`)
  const checksum = digest(binary, 'sha512', 'base64')
  const metadata = Buffer.from(yaml.dump({
    version,
    files: [{ url: installer, sha512: checksum, size: binary.length }],
    path: installer,
    sha512: checksum,
    releaseDate: release?.published_at ?? new Date().toISOString()
  }))
  writeFileSync(join(work, 'latest.yml'), metadata)
  const expected = new Map(names.map(name => [name, readFileSync(join(work, name))]))

  // Validate every existing asset before any remote write. Conflicting content
  // requires an owner-chosen new version; it is never overwritten or deleted.
  for (const name of names.slice(1)) {
    if (!assets.has(name)) continue
    const data = await downloadVerified(assets.get(name), join(work, `existing-${name}`))
    if (name === 'latest.yml') validateMetadata(data, version, installer, binary)
    else assert.equal(digest(data), digest(expected.get(name)), 'Published blockmap differs from the installer')
    expected.set(name, data)
  }

  if (!release) release = await gateway.createDraft(tag, version)
  const uploaded = []
  for (const name of names) {
    if (assets.has(name)) continue
    await gateway.upload(tag, join(work, name))
    uploaded.push(name)
  }
  release = await gateway.read(tag)
  for (const name of names) {
    const asset = release?.assets.find(candidate => candidate.name === name)
    assert.equal(asset?.state, 'uploaded', `Publication is missing ${name}`)
    assert.equal(asset.size, expected.get(name).length, `Published asset size mismatch: ${name}`)
    assert.equal(asset.digest, `sha256:${digest(expected.get(name))}`, `Published asset checksum mismatch: ${name}`)
  }
  if (release.draft) {
    await gateway.publish(tag)
    release = await gateway.read(tag)
  }
  assert.ok(release && !release.draft && !release.prerelease, 'The complete release is not public')
  return { tag, url: release.html_url, uploaded, preservedInstaller: assets.has(installer) }
}

export function githubGateway(repository, execute = execFileSync) {
  assert.equal(repository, 'erickgustavo1816-ctrl/synkora-releases', 'Unexpected publication destination')
  function gh(args) {
    try {
      return execute('gh', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      const status = /HTTP (\d{3})/.exec(String(error.stderr ?? ''))?.[1]
      const failure = new Error(`GitHub ${args[0]} ${args[1]} failed${status ? ` (HTTP ${status})` : ''}; inspect Actions access and retry the workflow`)
      failure.httpStatus = status
      throw failure
    }
  }
  return {
    async read(tag) {
      try { return JSON.parse(gh(['api', `repos/${repository}/releases/tags/${tag}`])) }
      catch (error) { if (error.httpStatus !== '404') throw error }
      // The tag endpoint only exposes published releases. Authenticated listings
      // also include drafts, so creation and interrupted uploads can be verified.
      const pages = JSON.parse(gh(['api', `repos/${repository}/releases?per_page=100`, '--paginate', '--slurp']))
      return pages.flat().find(release => release.tag_name === tag) ?? null
    },
    async download(tag, name, destination) {
      gh(['release', 'download', tag, '--repo', repository, '--pattern', name, '--output', destination, '--clobber'])
    },
    async createDraft(tag, version) {
      gh(['release', 'create', tag, '--repo', repository, '--title', version, '--notes', 'Instalador e atualizações do Synkora.', '--draft'])
      return this.read(tag)
    },
    async upload(tag, file) {
      // No --clobber: retrying can add missing assets, never replace published bytes.
      gh(['release', 'upload', tag, file, '--repo', repository])
    },
    async publish(tag) {
      gh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest'])
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version
    const result = await publishWindowsRelease({ version, outputDirectory: resolve('release'), gateway: githubGateway(process.env.RELEASES_REPO) })
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
