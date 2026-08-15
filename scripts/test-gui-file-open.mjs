import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import {
  GuiFileResolver,
  prepareGuiFileOpen
} from '../src/main/guiFileResolver.ts'

const sandbox = mkdtempSync(join(tmpdir(), 'synkora-gui-file-open-'))
const cwd = join(sandbox, 'worktree')
const outside = join(sandbox, 'outside')

mkdirSync(join(cwd, 'src'), { recursive: true })
mkdirSync(join(cwd, 'packages', 'ui', 'components'), { recursive: true })
mkdirSync(join(cwd, 'one'), { recursive: true })
mkdirSync(join(cwd, 'two'), { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = true\n')
writeFileSync(join(cwd, 'packages', 'ui', 'components', 'unique.ts'), 'export {}\n')
writeFileSync(join(cwd, 'one', 'duplicate.ts'), 'one\n')
writeFileSync(join(cwd, 'two', 'duplicate.ts'), 'two\n')
writeFileSync(join(cwd, 'manual.pdf'), '%PDF synthetic')
writeFileSync(join(cwd, 'run.exe'), 'not really executable')
writeFileSync(join(cwd, 'script.ps1'), 'Write-Host no')
writeFileSync(join(cwd, '.env'), 'SECRET=redacted')
writeFileSync(join(outside, 'escape.txt'), 'outside')

let junctionAvailable = true
try {
  symlinkSync(outside, join(cwd, 'junction'), process.platform === 'win32' ? 'junction' : 'dir')
} catch {
  junctionAvailable = false
}

after(() => rmSync(sandbox, { recursive: true, force: true }))

test('resolve caminho relativo explícito e prepara preview somente leitura', () => {
  const resolver = new GuiFileResolver()
  const result = resolver.resolve(cwd, 'src/app.ts')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.file.path, 'src/app.ts')
  assert.equal(result.file.name, 'app.ts')

  const prepared = prepareGuiFileOpen(result.file)
  assert.equal(prepared.ok, true)
  if (!prepared.ok || prepared.action !== 'preview') return
  assert.equal(prepared.preview.kind, 'text')
  assert.equal(prepared.preview.content, 'export const app = true\n')
  assert.equal('absolutePath' in prepared.preview, false)
})

test('aceita absoluto apenas quando continua dentro do cwd autoritativo', () => {
  const resolver = new GuiFileResolver()
  const inside = resolver.resolve(cwd, resolve(cwd, 'src', 'app.ts'))
  assert.equal(inside.ok, true)
  if (inside.ok) assert.equal(inside.file.path, 'src/app.ts')

  const escaped = resolver.resolve(cwd, resolve(outside, 'escape.txt'))
  assert.deepEqual(
    escaped.ok ? null : escaped.reason,
    'denied'
  )
})

test('resolve basename e sufixo somente quando o resultado é único', () => {
  const resolver = new GuiFileResolver()
  const basename = resolver.resolve(cwd, 'unique.ts')
  assert.equal(basename.ok, true)
  if (basename.ok) assert.equal(basename.file.path, 'packages/ui/components/unique.ts')

  const suffix = resolver.resolve(cwd, 'components/unique.ts')
  assert.equal(suffix.ok, true)
  if (suffix.ok) assert.equal(suffix.file.path, 'packages/ui/components/unique.ts')
})

test('basename duplicado pede escolha relativa e revalida a seleção', () => {
  const resolver = new GuiFileResolver()
  const duplicate = resolver.resolve(cwd, 'duplicate.ts')
  assert.equal(duplicate.ok, false)
  if (duplicate.ok) return
  assert.equal(duplicate.reason, 'ambiguous')
  assert.deepEqual(
    duplicate.choices?.map((choice) => choice.path),
    ['one/duplicate.ts', 'two/duplicate.ts']
  )
  assert.equal(duplicate.choices?.some((choice) => resolve(choice.path) === choice.path), false)

  const selected = resolver.resolve(cwd, 'duplicate.ts', 'two/duplicate.ts')
  assert.equal(selected.ok, true)
  if (selected.ok) assert.equal(selected.file.path, 'two/duplicate.ts')

  const forged = resolver.resolve(cwd, 'duplicate.ts', 'src/app.ts')
  assert.equal(forged.ok, false)
  if (!forged.ok) assert.equal(forged.reason, 'invalid')
})

test('inexistente e scan truncado recusam sem inventar unicidade', () => {
  const resolver = new GuiFileResolver()
  const missing = resolver.resolve(cwd, 'missing.ts')
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.reason, 'not-found')

  const capped = new GuiFileResolver({ maxScanEntries: 1 })
  const limited = capped.resolve(cwd, 'unique.ts')
  assert.equal(limited.ok, false)
  if (!limited.ok) assert.equal(limited.reason, 'limited')
})

test('recusa traversal, segredo e extensões executáveis', () => {
  const resolver = new GuiFileResolver()
  for (const candidate of ['../outside/escape.txt', 'run.exe', 'script.ps1', '.env']) {
    const result = resolver.resolve(cwd, candidate)
    assert.equal(result.ok, false, candidate)
    if (!result.ok) assert.equal(result.reason, 'denied', candidate)
  }

})

test('recusa junction antes de seguir o alvo', { skip: !junctionAvailable }, () => {
  const resolver = new GuiFileResolver()
  const linked = resolver.resolve(cwd, 'junction/escape.txt')
  assert.equal(linked.ok, false)
  if (!linked.ok) assert.equal(linked.reason, 'denied')
})

/**
 * O guarda "revelar, nunca executar" vale para ESTA superfície: o handler
 * `gui:fileOpen`. O arquivo inteiro não serve de recorte — `gui:attachmentAction`
 * abre anexo autorizado pelo dono com `shell.openPath` DE PROPÓSITO, e medir o
 * arquivo todo transformava esse recurso legítimo em reprovação falsa.
 *
 * Os marcadores não têm quebra de linha, então o checkout CRLF do Windows não
 * os alcança; a normalização mantém isso verdadeiro se algum deles crescer.
 * Marcador que não resolve FALHA ALTO: recorte que degrada em silêncio (virar o
 * arquivo inteiro, ou vazio) é guarda morto fingindo estar vivo.
 */
const FILE_OPEN_START = "'gui:fileOpen'"
const FILE_OPEN_END = "ipcMain.handle('gui:attach'"

function fileOpenHandlerRegion(source) {
  const normalized = source.replace(/\r\n/gu, '\n')
  const start = normalized.indexOf(FILE_OPEN_START)
  assert.notEqual(start, -1, `marcador inicial sumiu de ipc/gui.ts: ${FILE_OPEN_START}`)
  const end = normalized.indexOf(FILE_OPEN_END, start)
  assert.notEqual(end, -1, `marcador final sumiu de ipc/gui.ts: ${FILE_OPEN_END}`)
  return normalized.slice(start, end)
}

test('fallback apenas revela: nenhuma associação externa executa o arquivo', () => {
  const resolver = new GuiFileResolver()
  const result = resolver.resolve(cwd, 'manual.pdf')
  assert.equal(result.ok, true)
  if (!result.ok) return
  const prepared = prepareGuiFileOpen(result.file)
  assert.equal(prepared.ok, true)
  if (prepared.ok) assert.equal(prepared.action, 'reveal')

  const ipcSource = readFileSync(
    new URL('../src/main/ipc/gui.ts', import.meta.url),
    'utf8'
  )
  const handler = fileOpenHandlerRegion(ipcSource)
  assert.match(handler, /shell\.showItemInFolder\(prepared\.absolutePath\)/u)
  assert.doesNotMatch(handler, /shell\.openPath/u)

  // CONTROLE NEGATIVO: com a execução plantada DENTRO do recorte, o guarda tem
  // de acusar. Sem isto, recorte errado passaria como aprovação silenciosa — e
  // o `replace` que não achar seu alvo derruba este assert junto.
  const regression = fileOpenHandlerRegion(
    ipcSource.replace(
      'shell.showItemInFolder(prepared.absolutePath)',
      'shell.openPath(prepared.absolutePath)\n      shell.showItemInFolder(prepared.absolutePath)'
    )
  )
  assert.match(regression, /shell\.openPath/u)
})
