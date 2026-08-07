import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import AdmZip from 'adm-zip'

import {
  createSkillArchiveDigest,
  createSkillArchiveIntegrity,
  decompressSkillArchiveEntry,
  MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES,
  SKILL_ARCHIVE_INTEGRITY_FILE,
  validateImportedSkillArchiveManifest,
  validateSkillArchiveMetadata,
  verifySkillArchiveIntegrity,
  verifySkillArchiveIntegrityDigests
} from '../src/main/skillArchiveIntegrity.ts'

function entries() {
  return [
    { path: 'lib/example/SKILL.md', data: Buffer.from('# Example') },
    { path: 'manifest.json', data: Buffer.from('{"installed":{}}') }
  ]
}

test('creates a deterministic SHA-256 manifest and verifies an intact archive', () => {
  const manifest = createSkillArchiveIntegrity(entries())
  assert.equal(manifest.version, 1)
  assert.equal(manifest.algorithm, 'sha256')
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ['lib/example/SKILL.md', 'manifest.json']
  )
  assert.ok(verifySkillArchiveIntegrity(entries(), Buffer.from(JSON.stringify(manifest))).ok)
})

test('rejects changed, missing and unexpected archive entries', () => {
  const original = entries()
  const manifest = createSkillArchiveIntegrity(original)
  assert.match(
    verifySkillArchiveIntegrity(
      [{ path: original[0].path, data: Buffer.from('# Xxample') }, original[1]],
      JSON.stringify(manifest)
    ).reason,
    /alterado/
  )
  assert.match(
    verifySkillArchiveIntegrity(original.slice(0, 1), JSON.stringify(manifest)).reason,
    /quantidade/
  )
  assert.match(
    verifySkillArchiveIntegrity(
      [...original, { path: 'extra.txt', data: Buffer.from('x') }],
      JSON.stringify(manifest)
    ).reason,
    /quantidade/
  )
})

test('rejects duplicate or traversal paths and malformed integrity manifests', () => {
  assert.throws(
    () =>
      createSkillArchiveIntegrity([
        { path: 'manifest.json', data: Buffer.from('a') },
        { path: 'manifest.json', data: Buffer.from('b') }
      ]),
    /duplicada/
  )
  assert.throws(
    () => createSkillArchiveIntegrity([{ path: '../secret', data: Buffer.from('x') }]),
    /inválida/
  )
  assert.equal(verifySkillArchiveIntegrity(entries(), '{').ok, false)
  assert.doesNotThrow(() => {
    assert.equal(
      verifySkillArchiveIntegrity(
        entries(),
        JSON.stringify({ version: 1, algorithm: 'sha256', files: [null] })
      ).ok,
      false
    )
  })
})

function meta(path, overrides = {}) {
  return {
    path,
    isDirectory: false,
    compressedBytes: 1,
    uncompressedBytes: 1,
    compressionMethod: 8,
    encrypted: false,
    ...overrides
  }
}

function zipMeta(entry) {
  return {
    path: entry.entryName,
    isDirectory: entry.isDirectory,
    compressedBytes: entry.header.compressedSize,
    uncompressedBytes: entry.header.size,
    compressionMethod: entry.header.method,
    encrypted: Boolean(entry.header.flags & 1)
  }
}

function readRealEntry(entry, maxOutputBytes) {
  return decompressSkillArchiveEntry(
    {
      ...zipMeta(entry),
      crc32: entry.header.crc,
      compressedData: entry.getCompressedData()
    },
    maxOutputBytes
  )
}

test('preflight rejects duplicate aliases, traversal, ADS and file-directory conflicts', () => {
  const manifest = meta('manifest.json')
  for (const bad of [
    [meta('lib/example/SKILL.md'), meta('lib/example/skill.md')],
    [meta('../manifest.json')],
    [meta('lib\\example\\SKILL.md')],
    [meta('lib/example/file.txt:payload')],
    [meta('lib/example/CON.txt')],
    [meta('lib/example/a'), meta('lib/example/a/b')]
  ]) {
    const result = validateSkillArchiveMetadata([manifest, ...bad])
    assert.equal(result.ok, false, result.reason)
  }
  assert.match(
    validateSkillArchiveMetadata([manifest, meta('manifest.json')]).reason,
    /duplicada|exatamente um/
  )
})

test('preflight enforces absolute expanded-size and archive-layout limits', () => {
  assert.match(
    validateSkillArchiveMetadata([
      meta('manifest.json'),
      meta('lib/example/SKILL.md', {
        compressedBytes: 16,
        uncompressedBytes: MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES
      }),
      meta('lib/example/extra.md')
    ]).reason,
    /expandido/
  )
  assert.match(
    validateSkillArchiveMetadata([meta('manifest.json'), meta('unexpected.txt')]).reason,
    /inesperada/
  )
  assert.match(
    validateSkillArchiveMetadata([
      meta('manifest.json'),
      meta('lib/example/SKILL.md', { compressionMethod: 99 })
    ]).reason,
    /compressão/
  )
})

test('limited decompression rejects a forged low size and bad CRC', () => {
  const expanded = Buffer.alloc(64 * 1024, 0x41)
  const compressed = deflateRawSync(expanded)
  assert.throws(
    () =>
      decompressSkillArchiveEntry(
        {
          ...meta('lib/example/SKILL.md', {
            compressedBytes: compressed.byteLength,
            uncompressedBytes: 1
          }),
          crc32: 0,
          compressedData: compressed
        },
        1024
      ),
    /larger|output|tamanho|buffer/i
  )

  const zip = new AdmZip()
  zip.addFile('lib/example/SKILL.md', Buffer.from('# safe'))
  const loaded = new AdmZip(zip.toBuffer()).getEntry('lib/example/SKILL.md')
  assert.ok(loaded)
  assert.throws(
    () =>
      decompressSkillArchiveEntry(
        {
          ...zipMeta(loaded),
          crc32: loaded.header.crc ^ 1,
          compressedData: loaded.getCompressedData()
        },
        1024
      ),
    /CRC/
  )
})

function validPortableManifest() {
  return {
    installed: {
      example: { sha: 'a'.repeat(40), installedAt: '2026-08-03T12:00:00.000Z' }
    },
    updates: {},
    custom: [
      {
        id: 'example',
        kind: 'skill',
        depts: ['back'],
        group: 'Custom',
        source: { repo: 'owner/repo', path: 'skills/example' },
        summary: 'Example skill',
        hint: 'Use for an example.'
      }
    ],
    repoHeads: { 'owner/repo@main': { sha: 'a'.repeat(40), etag: '"safe"' } }
  }
}

test('portable manifest fails closed instead of dropping invalid members', () => {
  assert.ok(validateImportedSkillArchiveManifest(validPortableManifest()))

  const invalidInstalled = validPortableManifest()
  invalidInstalled.installed.bad_id = { sha: 'x', installedAt: 'not-a-date' }
  assert.equal(validateImportedSkillArchiveManifest(invalidInstalled), undefined)

  const invalidCustom = validPortableManifest()
  invalidCustom.custom[0].depts = ['unknown']
  assert.equal(validateImportedSkillArchiveManifest(invalidCustom), undefined)

  const duplicateCustom = validPortableManifest()
  duplicateCustom.custom.push({ ...duplicateCustom.custom[0] })
  assert.equal(validateImportedSkillArchiveManifest(duplicateCustom), undefined)

  const invalidUpdates = validPortableManifest()
  invalidUpdates.updates = []
  assert.equal(validateImportedSkillArchiveManifest(invalidUpdates), undefined)

  const invalidHeads = validPortableManifest()
  invalidHeads.repoHeads['owner/other@main'] = {
    sha: 'b'.repeat(40),
    etag: 'bad\r\nvalue'
  }
  assert.equal(validateImportedSkillArchiveManifest(invalidHeads), undefined)
})

test('real ZIP round-trip and valid legacy ZIP pass all bounded checks', () => {
  const manifestData = Buffer.from(JSON.stringify(validPortableManifest()))
  const skillData = Buffer.from('---\nname: example\ndescription: Safe\n---\n')
  const contents = [
    { path: 'manifest.json', data: manifestData },
    { path: 'lib/example/SKILL.md', data: skillData }
  ]
  const zip = new AdmZip()
  for (const entry of contents) zip.addFile(entry.path, entry.data)
  zip.addFile(
    SKILL_ARCHIVE_INTEGRITY_FILE,
    Buffer.from(JSON.stringify(createSkillArchiveIntegrity(contents)))
  )

  const loadedEntries = new AdmZip(zip.toBuffer()).getEntries()
  assert.equal(validateSkillArchiveMetadata(loadedEntries.map(zipMeta)).ok, true)
  const digests = []
  let rawIntegrity
  for (const entry of loadedEntries) {
    const data = readRealEntry(entry, 1024 * 1024)
    if (entry.entryName === SKILL_ARCHIVE_INTEGRITY_FILE) rawIntegrity = data
    else digests.push(createSkillArchiveDigest({ path: entry.entryName, data }))
  }
  assert.ok(rawIntegrity)
  assert.equal(verifySkillArchiveIntegrityDigests(digests, rawIntegrity).ok, true)

  const legacy = new AdmZip()
  for (const entry of contents) legacy.addFile(entry.path, entry.data)
  const legacyEntries = new AdmZip(legacy.toBuffer()).getEntries()
  assert.equal(validateSkillArchiveMetadata(legacyEntries.map(zipMeta)).ok, true)
  const legacyManifest = legacyEntries.find((entry) => entry.entryName === 'manifest.json')
  assert.ok(legacyManifest)
  assert.ok(
    validateImportedSkillArchiveManifest(
      JSON.parse(readRealEntry(legacyManifest, 1024 * 1024).toString('utf8'))
    )
  )
})
