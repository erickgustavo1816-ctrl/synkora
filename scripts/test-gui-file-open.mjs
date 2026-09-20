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
writeFileSync(join(cwd, 'archive.bin'), 'synthetic binary format')
// A entrega que o dono clica no fio (rodada 7-D) e um homônimo raso/profundo,
// para provar a escolha do painel fechando ambiguidade de NOME CURTO.
writeFileSync(join(cwd, 'src', 'relatorio.html'), '<!doctype html><title>x</title>')
writeFileSync(join(cwd, 'nota.md'), 'raso\n')
writeFileSync(join(cwd, 'one', 'nota.md'), 'fundo\n')
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

test('um HTML citado no chat abre renderizado no browser, inclusive acima do teto do leitor', () => {
  const resolver = new GuiFileResolver()
  const page = resolver.resolve(cwd, 'src/relatorio.html')
  assert.equal(page.ok, true)
  assert.equal(prepareGuiFileOpen(page.file).action, 'browser')
  assert.equal(prepareGuiFileOpen(page.file, 'preview').action, 'preview')

  writeFileSync(join(cwd, 'src', 'large-page.html'), '<!doctype html>' + ' '.repeat(600_000))
  const large = resolver.resolve(cwd, 'src/large-page.html')
  assert.equal(large.ok, true)
  assert.equal(prepareGuiFileOpen(large.file).action, 'browser', 'HTML grande não revela a pasta')
  const code = resolver.resolve(cwd, 'src/app.ts')
  assert.equal(prepareGuiFileOpen(code.file).action, 'preview', 'código continua no leitor')
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
 *
 * Rodada 7-D: o canal IRMÃO (`gui:fileOpenExternal`) nasceu logo abaixo e ele
 * PODE executar a associação do sistema — por ordem do dono, e só depois da
 * mesma cerca. Por isso o recorte do preview agora termina nele: cada um tem o
 * seu contrato, e nenhum dos dois passa a valer pelo silêncio do outro.
 */
const FILE_OPEN_START = "'gui:fileOpen'"
const FILE_OPEN_END = "'gui:fileOpenExternal'"
const EXTERNAL_OPEN_START = "'gui:fileOpenExternal'"
const EXTERNAL_OPEN_END = "ipcMain.handle('gui:attach'"

function handlerRegion(source, startMarker, endMarker) {
  const normalized = source.replace(/\r\n/gu, '\n')
  const start = normalized.indexOf(startMarker)
  assert.notEqual(start, -1, `marcador inicial sumiu de ipc/gui.ts: ${startMarker}`)
  const end = normalized.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(end, -1, `marcador final sumiu de ipc/gui.ts: ${endMarker}`)
  return normalized.slice(start, end)
}

function fileOpenHandlerRegion(source) {
  return handlerRegion(source, FILE_OPEN_START, FILE_OPEN_END)
}

function externalOpenHandlerRegion(source) {
  return handlerRegion(source, EXTERNAL_OPEN_START, EXTERNAL_OPEN_END)
}

const ipcSourceText = () =>
  readFileSync(new URL('../src/main/ipc/gui.ts', import.meta.url), 'utf8')

test('fallback de formato desconhecido apenas revela: nenhuma associação externa executa o arquivo', () => {
  const resolver = new GuiFileResolver()
  const result = resolver.resolve(cwd, 'archive.bin')
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

/**
 * RODADA 7-D — "abrir onde eu quiser" no CHAT (esclarecimento do dono).
 *
 * A metade entregue na rodada 7 pousou na aba Arquivos e no trilho de entrega;
 * a superfície que ele QUERIA é o fio: o agente cita um `.html`, o dono clica no
 * token e cai no painel de código sem saída. Agora o botão direito no token (e
 * no painel aberto) oferece as mesmas três saídas — e a de fora do app passa por
 * ESTE canal, que é irmão do preview e usa a MESMA cerca (o `cwd` do pane, o
 * resolver físico), nunca a raiz-por-ID da aba Arquivos.
 */
test('a rota externa do CHAT resolve pelo cwd do pane antes de tocar no shell', () => {
  const handler = externalOpenHandlerRegion(ipcSourceText())

  assert.ok(
    handler.includes('extras.assertAppRendererSender(e)'),
    'canal que dispara programa do sistema tem que autenticar o remetente'
  )
  assert.ok(
    handler.includes('registry.cwdOf(paneId)'),
    'a raiz precisa vir do registro do pane, nunca do renderer'
  )
  assert.match(
    handler,
    /fileResolver\.resolve\(cwd, reference, selectedPath\)/u,
    'a rota externa precisa passar pelo MESMO resolver do preview'
  )

  // O que vai para o sistema é SEMPRE o caminho que o resolver provou.
  for (const call of ['shell.openPath(', 'shell.showItemInFolder(']) {
    const at = handler.indexOf(call)
    assert.notEqual(at, -1, `chamada ausente: ${call}`)
    assert.ok(
      handler.slice(at + call.length).startsWith('resolved.file.absolutePath'),
      `${call} recebeu algo que não veio do resolver`
    )
    assert.ok(handler.indexOf('fileResolver.resolve(') < at, `${call} roda antes do resolver`)
  }
  assert.equal(
    /shell\.(?:openPath|showItemInFolder)\(\s*(?:reference|selectedPath|paneId|cwd)/u.test(handler),
    false,
    'caminho cru do renderer chegando ao shell'
  )

  // O modo do menu vira o verbo do sistema, e nada além dos dois existe.
  assert.match(handler, /mode === 'reveal' \? 'reveal' : 'default'/u)

  // CONTROLE NEGATIVO do recorte: com o caminho cru plantado, o guarda acusa.
  const forged = externalOpenHandlerRegion(
    ipcSourceText().replace(
      'shell.openPath(resolved.file.absolutePath)',
      'shell.openPath(reference)'
    )
  )
  assert.match(forged, /shell\.openPath\(reference\)/u, 'o recorte não alcança a chamada real')
})

test('a rota externa recusa por CLASSE e nunca journaliza caminho', () => {
  const handler = externalOpenHandlerRegion(ipcSourceText())

  // Ambiguidade não vira aposta: a recusa NOMEIA a receita (escolher no painel).
  assert.match(handler, /resolved\.reason === 'ambiguous'/u, 'nome ambíguo virou escolha do acaso')
  assert.match(handler, /abra no app/u, 'recusa sem receita é beco sem saída')

  const details = handler.match(/detail: \{[^}]*\}/gu) ?? []
  assert.ok(details.length > 0, 'a rota nova não deixa rastro nenhum na caixa-preta')
  for (const detail of details) {
    for (const leak of ['reference', 'selectedPath', 'absolutePath', 'path', 'cwd', 'error']) {
      assert.equal(detail.includes(leak), false, `caminho/erro no journal: ${detail}`)
    }
  }

  // A cerca do domínio gui continua de pé no arquivo inteiro.
  const ipc = ipcSourceText()
  assert.ok((ipc.match(/extras\.assertAppRendererSender\(e\)/gu) ?? []).length >= 20, 'a cerca do domínio gui encolheu')
})

test('a rota externa herda a cerca do resolver: nada perigoso alcança o sistema', () => {
  // O recorte precisa existir para esta prova valer (rota nova, cerca velha).
  assert.ok(externalOpenHandlerRegion(ipcSourceText()).length > 0)

  const resolver = new GuiFileResolver()
  for (const candidate of ['run.exe', 'script.ps1', '.env', '../outside/escape.txt']) {
    const refused = resolver.resolve(cwd, candidate)
    assert.equal(refused.ok, false, candidate)
    if (!refused.ok) assert.equal(refused.reason, 'denied', candidate)
  }

  // A entrega do dono (.html citada no fio) resolve para um absoluto DENTRO do
  // worktree — é esse, e só esse, que o `shell.openPath` recebe.
  const page = resolver.resolve(cwd, 'relatorio.html')
  assert.equal(page.ok, true)
  if (!page.ok) return
  assert.equal(page.file.path, 'src/relatorio.html')
  assert.equal(page.file.absolutePath, join(cwd, 'src', 'relatorio.html'))
})

test('nome ambíguo recusa a saída externa; a escolha do painel a destrava', () => {
  assert.ok(externalOpenHandlerRegion(ipcSourceText()).length > 0)

  const resolver = new GuiFileResolver()
  const ambiguous = resolver.resolve(cwd, 'nota.md')
  assert.equal(ambiguous.ok, false)
  if (ambiguous.ok) return
  assert.equal(ambiguous.reason, 'ambiguous')

  // DIALETO DO PAINEL: referência = caminho já resolvido, escolha = ele mesmo.
  // É o que fecha a ambiguidade antes de qualquer `shell.*` — inclusive para um
  // nome curto que tem homônimo mais fundo na árvore.
  const bare = resolver.resolve(cwd, 'nota.md', 'nota.md')
  assert.equal(bare.ok, true)
  if (bare.ok) assert.equal(bare.file.path, 'nota.md')

  const deep = resolver.resolve(cwd, 'one/nota.md', 'one/nota.md')
  assert.equal(deep.ok, true)
  if (deep.ok) assert.equal(deep.file.path, 'one/nota.md')

  // Escolha que não pertence à referência continua recusada (nada de forjar).
  const forged = resolver.resolve(cwd, 'nota.md', 'src/app.ts')
  assert.equal(forged.ok, false)
  if (!forged.ok) assert.equal(forged.reason, 'invalid')
})

// R26 — O .MD DO CHAT ABRE BONITO (pedido do dono, 2026-08-20): o preview que
// ele clica no fio renderiza markdown como a aba ARQUIVOS — mesma régua de
// extensões (espelho pinado entre os dois módulos-folha), mesmo conversor
// (marked + DOMPurify, extraído para UM componente compartilhado) e sem
// scroll lateral. No código velho tudo que não era imagem saía como texto cru
// num <pre> de rolagem horizontal.
test('R26 — preview de .md do chat sai como markdown, na régua da aba Arquivos', async () => {
  // `nota.md` tem homônimo de propósito (o teste da ambiguidade); aqui o alvo
  // é um caminho relativo EXPLÍCITO e único, como o clique num link do fio.
  writeFileSync(join(cwd, 'src', 'roteiro.md'), '# roteiro\n')
  const resolver = new GuiFileResolver()
  const nota = resolver.resolve(cwd, 'src/roteiro.md')
  assert.equal(nota.ok, true)
  if (!nota.ok) return
  const prepared = prepareGuiFileOpen(nota.file)
  assert.equal(prepared.ok, true)
  if (!prepared.ok || prepared.action !== 'preview') return
  assert.equal(prepared.preview.kind, 'markdown', 'o chat sabe que .md é markdown')
  assert.equal(prepared.preview.content, '# roteiro\n', 'o corpo continua o texto íntegro')

  // A variante .markdown segue a mesma régua; código continua text.
  writeFileSync(join(cwd, 'guia.markdown'), '# guia\n')
  const guia = new GuiFileResolver().resolve(cwd, 'guia.markdown')
  assert.equal(guia.ok, true)
  if (!guia.ok) return
  const guiaPrepared = prepareGuiFileOpen(guia.file)
  assert.equal(guiaPrepared.ok && guiaPrepared.action === 'preview' && guiaPrepared.preview.kind, 'markdown')
  const code = new GuiFileResolver().resolve(cwd, 'src/app.ts')
  assert.equal(code.ok, true)
  if (!code.ok) return
  const codePrepared = prepareGuiFileOpen(code.file)
  assert.equal(codePrepared.ok && codePrepared.action === 'preview' && codePrepared.preview.kind, 'text')

  // RÉGUA ÚNICA por espelho PINADO: os dois módulos são folha (a suíte roda o
  // .ts cru), então a régua é uma cópia declarada — e este assert é o lacre.
  const filePreview = await import('../src/main/filePreview.ts')
  const chatResolver = await import('../src/main/guiFileResolver.ts')
  assert.ok(filePreview.MARKDOWN_EXTENSIONS, 'a régua da aba Arquivos é exportada')
  assert.ok(chatResolver.GUI_MARKDOWN_PREVIEW_EXTENSIONS, 'a régua do chat existe')
  assert.deepEqual(
    [...chatResolver.GUI_MARKDOWN_PREVIEW_EXTENSIONS].sort(),
    [...filePreview.MARKDOWN_EXTENSIONS].sort(),
    'chat e aba Arquivos decidem markdown pela MESMA lista'
  )

  // O RENDERIZADOR é um só, compartilhado pelos dois painéis.
  const sharedPath = resolve('src/renderer/src/components/FileMarkdownContent.tsx')
  const shared = readFileSync(sharedPath, 'utf8')
  assert.match(shared, /marked\.parse/u)
  assert.match(shared, /DOMPurify\.sanitize/u)
  assert.match(shared, /md-view file-markdown/u)
  const chatPanel = readFileSync(resolve('src/renderer/src/components/GuiFileOpenPanel.tsx'), 'utf8')
  const filesPanel = readFileSync(resolve('src/renderer/src/components/FilePreviewPanel.tsx'), 'utf8')
  assert.match(chatPanel, /from '\.\/FileMarkdownContent'/u)
  assert.match(filesPanel, /from '\.\/FileMarkdownContent'/u)
  assert.match(chatPanel, /preview\.kind === 'markdown'/u)
  assert.match(chatPanel, /<FileMarkdownContent content=\{preview\.content\} \/>/u)
  assert.doesNotMatch(filesPanel, /marked\.parse/u, 'nenhum segundo pipeline de markdown')

  // Sem scroll lateral: o corpo markdown do card tem estilo próprio (wrap),
  // em vez de herdar o pre de largura max-content.
  const css = readFileSync(resolve('src/renderer/src/global.css'), 'utf8')
  assert.match(css, /\.gui-file-preview-body \.file-markdown/u)
})
