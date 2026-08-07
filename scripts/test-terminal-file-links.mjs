import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  findTerminalFileLinks,
  resolveTerminalFile,
  terminalFileOpenKind
} from '../src/main/terminalFileLinks.ts'

const sandbox = mkdtempSync(join(tmpdir(), 'synkora-terminal-links-'))
const project = join(sandbox, 'Projeto principal')
const pane = join(sandbox, 'Worktree com espacos')
const attachmentDir = join(pane, '.synkora', 'attachments')
const image = join(attachmentDir, 'imagem final.png')
const markdown = join(pane, 'resultado.md')
const unicodeMarkdown = join(pane, 'ação.md')
const makefile = join(pane, 'Makefile')
const dotEnv = join(pane, '.env')
const outsideDir = join(sandbox, 'fora')
const outside = join(outsideDir, 'escape.png')
const escapeLink = join(pane, 'atalho-fora')

mkdirSync(project, { recursive: true })
mkdirSync(attachmentDir, { recursive: true })
mkdirSync(outsideDir, { recursive: true })
writeFileSync(join(project, 'README.md'), '# projeto')
writeFileSync(image, 'png')
writeFileSync(markdown, '# resultado')
writeFileSync(unicodeMarkdown, '# ação')
writeFileSync(makefile, 'all:')
writeFileSync(dotEnv, 'SAFE=1')
writeFileSync(outside, 'fora')
let junctionAvailable = true
try {
  symlinkSync(outsideDir, escapeLink, 'junction')
} catch {
  junctionAvailable = false
}

const roots = [
  { id: 'project', path: project },
  { id: 'pane', path: pane }
]

after(() => rmSync(sandbox, { recursive: true, force: true }))

test('encontra caminho Windows absoluto com espacos e remove pontuacao final', () => {
  const windowsPath = image.replaceAll('/', '\\')
  const text = `Arquivo: ${windowsPath}, pronto.`
  const links = findTerminalFileLinks(text, roots)
  assert.equal(links.length, 1)
  assert.equal(links[0].text, windowsPath)
  assert.equal(links[0].root, 'pane')
  assert.equal(links[0].relativePath, '.synkora/attachments/imagem final.png')
})

test('resolve relativo com backslash no cwd do pane', () => {
  const text = 'Veja .synkora\\attachments\\imagem final.png).'
  const links = findTerminalFileLinks(text, roots)
  assert.equal(links.length, 1)
  assert.equal(links[0].text, '.synkora\\attachments\\imagem final.png')
  assert.equal(links[0].absolutePath, image)
})

test('mantém mais de um arquivo na linha, mesmo priorizando o absoluto', () => {
  const windowsPath = image.replaceAll('/', '\\')
  const links = findTerminalFileLinks(`README.md e ${windowsPath}`, roots)
  assert.deepEqual(links.map((link) => link.text), ['README.md', windowsPath])
})

test('uma linha hostil não esconde um caminho absoluto válido no final', () => {
  const noise = Array.from({ length: 300 }, (_, index) => `ausente${index}.txt`).join(' ')
  const windowsPath = image.replaceAll('/', '\\')
  const links = findTerminalFileLinks(`${noise} ${windowsPath}`, roots)
  assert.equal(links.some((link) => link.text === windowsPath), true)
})

test('reconhece Unicode, dotfile e nomes sem extensão', () => {
  const links = findTerminalFileLinks('Veja ação.md, .env e Makefile).', roots)
  assert.deepEqual(links.map((link) => link.text), ['ação.md', '.env', 'Makefile'])

  const windowsPath = makefile.replaceAll('/', '\\')
  const absolute = findTerminalFileLinks(`Gerado em ${windowsPath}.`, roots)
  assert.equal(absolute[0]?.text, windowsPath)
})

test('abre formatos passivos e apenas revela executáveis/scripts no Explorer', () => {
  assert.equal(terminalFileOpenKind(markdown), 'markdown')
  assert.equal(terminalFileOpenKind(image), 'external')
  for (const name of [
    'instalador.exe',
    'script.js',
    'script.py',
    'script.sh',
    'atalho.appref-ms',
    'macro.xlsm',
    'pacote.jar'
  ]) {
    assert.equal(terminalFileOpenKind(join(pane, name)), 'reveal', name)
  }
  assert.equal(terminalFileOpenKind(join(pane, 'formato-desconhecido.xyz')), 'reveal')
})

test('nega arquivo inexistente e tentativa de escapar das raizes', () => {
  assert.equal(resolveTerminalFile('nao-existe.png', roots), null)
  assert.equal(resolveTerminalFile('..\\fora\\escape.png', [{ id: 'pane', path: pane }]), null)
  assert.deepEqual(findTerminalFileLinks(`Fora: ${outside}`, roots), [])
  if (junctionAvailable) {
    assert.equal(resolveTerminalFile('atalho-fora\\escape.png', [{ id: 'pane', path: pane }]), null)
  }
})
