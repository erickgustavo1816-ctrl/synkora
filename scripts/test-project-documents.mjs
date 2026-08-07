import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { after, test } from 'node:test'
import { readProjectMarkdown } from '../src/main/terminalFileLinks.ts'

const sandbox = mkdtempSync(join(tmpdir(), 'synkora-project-docs-'))
const project = join(sandbox, 'Synkora')
const sibling = join(sandbox, 'Synkora-secrets')
const docs = join(project, 'docs')
const valid = join(docs, 'GUIA.md')
const secret = join(sibling, 'segredo.md')
const escapeLink = join(project, 'docs-fora')

mkdirSync(docs, { recursive: true })
mkdirSync(sibling, { recursive: true })
writeFileSync(valid, '# guia seguro', 'utf8')
writeFileSync(join(project, 'nao-markdown.txt'), 'texto', 'utf8')
writeFileSync(secret, 'SEGREDO_FORA_DO_PROJETO', 'utf8')

let junctionAvailable = true
try {
  symlinkSync(sibling, escapeLink, 'junction')
} catch {
  junctionAvailable = false
}

after(() => rmSync(sandbox, { recursive: true, force: true }))

test('lê Markdown existente dentro da raiz canônica', () => {
  const result = readProjectMarkdown(project, 'docs/GUIA.md')
  assert.equal(result?.content, '# guia seguro')
  assert.equal(typeof result?.mtime, 'number')
})

test('bloqueia traversal para pasta irmã com o mesmo prefixo', () => {
  const traversal = `../${basename(sibling)}/segredo.md`
  assert.equal(readProjectMarkdown(project, traversal), null)
})

test('bloqueia symlink ou junction que resolve fora do projeto', () => {
  if (!junctionAvailable) return
  assert.equal(readProjectMarkdown(project, 'docs-fora/segredo.md'), null)
})

test('aceita somente caminho relativo Markdown e rejeita byte nulo', () => {
  assert.equal(readProjectMarkdown(project, valid), null)
  assert.equal(readProjectMarkdown(project, 'nao-markdown.txt'), null)
  assert.equal(readProjectMarkdown(project, 'docs/GUIA.md\0.md'), null)
})
