import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  FILE_PREVIEW_MAX_BYTES,
  listReadOnlyFileTree,
  readReadOnlyFilePreview
} from '../src/main/filePreview.ts'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'synkora-p25-'))
  const outside = mkdtempSync(path.join(os.tmpdir(), 'synkora-p25-outside-'))
  mkdirSync(path.join(root, 'src'))
  mkdirSync(path.join(root, 'assets'))
  writeFileSync(path.join(root, 'src', 'example.ts'), 'const answer: number = 42\nexport { answer }\n')
  writeFileSync(path.join(root, 'README.md'), '# Safe preview\n\n<script>alert(1)</script>\n')
  writeFileSync(path.join(root, 'assets', 'pixel.png'), PNG_1X1)
  writeFileSync(path.join(root, 'data.bin'), Buffer.from([0, 1, 2, 255]))
  writeFileSync(path.join(root, 'large.txt'), Buffer.alloc(FILE_PREVIEW_MAX_BYTES + 1, 0x61))
  writeFileSync(path.join(root, '.env'), 'TOKEN=do-not-read\n')
  writeFileSync(path.join(outside, 'outside.txt'), 'outside root\n')
  let junction = null
  try {
    junction = path.join(root, 'external-junction')
    symlinkSync(outside, junction, 'junction')
  } catch {
    // Some CI Windows images deny junction creation. The rest of the suite
    // still proves traversal/absolute containment; the conditional assertion
    // below records the physical-link case when the OS allows it.
    junction = null
  }
  return { root, outside, junction }
}

test('lista árvore flat bounded e não segue junction/symlink', (t) => {
  const { root, outside, junction } = fixture()
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  const result = listReadOnlyFileTree(root)
  const paths = result.entries.map((entry) => entry.path)
  assert.ok(paths.includes('src/example.ts'))
  assert.ok(paths.includes('README.md'))
  assert.ok(paths.includes('assets/pixel.png'))
  assert.ok(!paths.includes('external-junction/outside.txt'))
  if (junction) assert.ok(result.skipped >= 1)
  assert.ok(result.entries.every((entry) => !Object.values(entry).some((value) => String(value).includes(root))))
})

test('previewa código, markdown, imagem e relata binário/grande/sensível', (t) => {
  const { root, outside } = fixture()
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  const code = readReadOnlyFilePreview(root, 'src/example.ts')
  assert.equal(code?.ok, true)
  assert.equal(code?.kind, 'code')
  if (code?.ok && 'content' in code) assert.match(code.content, /answer/)

  const markdown = readReadOnlyFilePreview(root, 'README.md')
  assert.equal(markdown?.ok, true)
  assert.equal(markdown?.kind, 'markdown')
  if (markdown?.ok && 'content' in markdown) assert.match(markdown.content, /<script>/)

  const image = readReadOnlyFilePreview(root, 'assets\\pixel.png')
  assert.equal(image?.ok, true)
  assert.equal(image?.kind, 'image')
  if (image?.ok && image.kind === 'image') assert.equal(image.image.mime, 'image/png')

  assert.equal(readReadOnlyFilePreview(root, 'data.bin')?.kind, 'binary')
  assert.equal(readReadOnlyFilePreview(root, 'large.txt')?.kind, 'large')
  assert.equal(readReadOnlyFilePreview(root, '.env')?.kind, 'blocked')
})

test('recusa traversal, caminho absoluto, links externos e raiz linkada', (t) => {
  const { root, outside, junction } = fixture()
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  assert.equal(readReadOnlyFilePreview(root, '../outside.txt'), null)
  assert.equal(readReadOnlyFilePreview(root, path.join(outside, 'outside.txt')), null)
  if (junction) assert.equal(readReadOnlyFilePreview(root, 'external-junction/outside.txt'), null)
  if (junction) assert.equal(listReadOnlyFileTree(junction).error, 'raiz de arquivos indisponível')
})

test('aplica teto de entradas mesmo em árvore gerada grande', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'synkora-p25-cap-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (let index = 0; index < 2_005; index++) {
    writeFileSync(path.join(root, `file-${index}.txt`), 'x')
  }
  const result = listReadOnlyFileTree(root)
  assert.equal(result.entries.length, 2_000)
  assert.equal(result.truncated, true)
})
