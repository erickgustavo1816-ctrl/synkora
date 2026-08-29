/**
 * RODADA 7 — C1: "abrir arquivo onde o dono quiser".
 *
 * Hoje clicar num `.html` da entrega abre o preview de CÓDIGO dentro do app, e
 * não há saída: o dono quer ESCOLHER — ver pelo Synkora, mandar para o programa
 * padrão do sistema (`.html` no navegador, `.png` no visualizador) ou mostrar na
 * pasta. Esta suíte guarda as três coisas que não podem regredir:
 *
 *   1. o MODELO do menu (quais saídas existem por tipo de arquivo, e o que um
 *      arquivo apagado nesta branch pode oferecer: nada);
 *   2. a GUARDA — nenhum caminho que o resolver do main recusaria chega ao IPC;
 *   3. o CONTRATO de superfície: menu por PORTAL (nunca menu nativo), teclado
 *      declarado, e o canal novo do main resolvendo a raiz por ID + o arquivo
 *      pelo resolver físico antes de qualquer `shell.*`.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  FILE_CONTEXT_LABELS,
  fileContextOptions,
  fileContextRequest,
  fileOpenFamily,
  guiChatFileRequest,
  isChatFileTarget,
  runFileOpen,
  runGuiChatFileOpen
} from '../src/renderer/src/guiFileContextMenu.ts'

const source = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8')

const target = (patch = {}) => ({
  projectId: 'proj-1',
  root: { kind: 'mission', missionId: 'mission-1' },
  path: 'docs/relatorio.html',
  ...patch
})

/** O dialeto do CHAT (rodada 7-D): a autoridade é o PANE, e o caminho é a
 *  referência crua que o agente escreveu no fio. */
const chatTarget = (patch = {}) => ({
  paneId: 'pane-1',
  reference: 'docs/relatorio.html',
  path: 'docs/relatorio.html',
  ...patch
})

/** Ponte falsa: guarda TODA chamada que chegaria ao `files:openExternal`. */
function stubBridge(impl) {
  const calls = []
  globalThis.window = {
    synkora: {
      files: {
        openExternal: async (projectId, root, relativePath, mode) => {
          calls.push({ projectId, root, relativePath, mode })
          return impl ? impl() : { ok: true, action: mode === 'reveal' ? 'reveal' : 'external' }
        }
      }
    }
  }
  return calls
}

/** Ponte falsa do canal do CHAT (`gui:fileOpenExternal`). */
function stubGuiBridge(impl) {
  const calls = []
  globalThis.window = {
    synkora: {
      gui: {
        fileOpenExternal: async (paneId, reference, selectedPath, mode) => {
          calls.push({ paneId, reference, selectedPath, mode })
          return impl ? impl() : { ok: true, action: mode === 'reveal' ? 'reveal' : 'external' }
        }
      }
    }
  }
  return calls
}

test('o menu oferece as TRÊS saídas do dono, nesta ordem, em PT-BR', () => {
  const options = fileContextOptions(target())
  assert.deepEqual(
    options.map((option) => option.action),
    ['open-in-app', 'open-default', 'reveal']
  )
  assert.deepEqual(options.map((option) => option.label), [
    'abrir no app',
    'abrir com o programa padrão',
    'mostrar na pasta'
  ])
  assert.equal(FILE_CONTEXT_LABELS['open-in-app'], 'abrir no app')
  // Toda saída fala por que existe: dica vazia é menu mudo.
  for (const option of options) assert.ok(option.tip.length > 8, `dica ausente: ${option.action}`)
})

test('arquivo APAGADO nesta branch não oferece abertura nenhuma', () => {
  assert.deepEqual(fileContextOptions(target({ status: 'D' })), [])
  // O resto do vocabulário do git segue abrindo (status desconhecido inclusive).
  for (const status of ['A', 'M', 'R', 'C', 'U', '?', 'X']) {
    assert.equal(fileContextOptions(target({ status })).length, 3, `status recusado: ${status}`)
  }
})

test('a dica conta PARA ONDE o arquivo vai: .html no navegador, .png no visualizador', () => {
  assert.equal(fileOpenFamily('docs/relatorio.html'), 'page')
  assert.equal(fileOpenFamily('index.HTM'), 'page')
  assert.equal(fileOpenFamily('arte/logo.svg'), 'page')
  assert.equal(fileOpenFamily('shot.png'), 'image')
  assert.equal(fileOpenFamily('foto.JPEG'), 'image')
  assert.equal(fileOpenFamily('manual.pdf'), 'document')
  assert.equal(fileOpenFamily('src/store.ts'), 'plain')
  assert.equal(fileOpenFamily('Makefile'), 'plain')

  const tipFor = (path) =>
    fileContextOptions(target({ path })).find((option) => option.action === 'open-default').tip
  assert.match(tipFor('docs/relatorio.html'), /navegador/u)
  assert.match(tipFor('shot.png'), /imagens|visualizador/u)
  assert.match(tipFor('src/store.ts'), /programa padrão/u)
})

test('no viewer a saída "abrir no app" diz a verdade: já está aberto aqui', () => {
  const here = fileContextOptions(target({ current: true }))
    .find((option) => option.action === 'open-in-app')
  assert.equal(here.label, 'abrir no app')
  assert.match(here.tip, /já está aberto|recarrega/u)
})

test('GUARDA: só caminho que o resolver aceitaria chega ao IPC', async () => {
  const calls = stubBridge()
  const recusados = [
    target({ path: '../fora-do-worktree.txt' }),
    target({ path: 'docs/../../segredo.env' }),
    target({ path: 'C:\\Windows\\System32\\calc.exe' }),
    target({ path: '/etc/passwd' }),
    target({ path: '\\\\servidor\\share\\x.txt' }),
    target({ path: '' }),
    target({ path: 'docs/./a.html' }),
    target({ path: `docs/${'a'.repeat(4096)}.html` }),
    target({ path: 'docs/a\u0000.html' }),
    target({ projectId: '' }),
    target({ root: { kind: 'mission' } }),
    target({ root: { kind: 'universo' } }),
    target({ root: null })
  ]
  for (const bad of recusados) {
    assert.equal(fileContextRequest(bad), null, `guarda deixou passar: ${JSON.stringify(bad.path)}`)
    const outcome = await runFileOpen('default', bad)
    assert.equal(outcome.ok, false)
    assert.ok(outcome.error, 'recusa sem motivo é beco sem saída')
  }
  assert.equal(calls.length, 0, 'caminho cru do renderer chegou ao IPC')
})

test('caminho bom atravessa normalizado, e o modo do sistema é o do menu', async () => {
  const calls = stubBridge()
  assert.deepEqual(fileContextRequest(target({ path: 'docs\\sub\\a.html' })), {
    projectId: 'proj-1',
    root: { kind: 'mission', missionId: 'mission-1' },
    path: 'docs/sub/a.html'
  })

  assert.deepEqual(await runFileOpen('default', target()), { ok: true, action: 'external' })
  assert.deepEqual(await runFileOpen('reveal', target({ root: { kind: 'project' } })), {
    ok: true,
    action: 'reveal'
  })
  assert.deepEqual(calls, [
    {
      projectId: 'proj-1',
      root: { kind: 'mission', missionId: 'mission-1' },
      relativePath: 'docs/relatorio.html',
      mode: 'default'
    },
    {
      projectId: 'proj-1',
      root: { kind: 'project' },
      relativePath: 'docs/relatorio.html',
      mode: 'reveal'
    }
  ])
})

test('sem a ponte no preload, a recusa NOMEIA a receita (nunca beco sem saída)', async () => {
  globalThis.window = { synkora: { files: {} } }
  const outcome = await runFileOpen('default', target())
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /npm run dev/u)

  // Ponte que explode no meio também vira recusa legível, nunca promessa quebrada.
  stubBridge(() => {
    throw new Error('canal caiu')
  })
  const crashed = await runFileOpen('reveal', target())
  assert.equal(crashed.ok, false)
  assert.ok(crashed.error)
})

test('o menu é PORTAL, com teclado declarado — e nenhum menu/diálogo nativo', async () => {
  const menu = await source('src/renderer/src/components/GuiFileContextMenu.tsx')
  for (const contract of [
    'createPortal',
    'role="menu"',
    'role="menuitem"',
    "event.key === 'Escape'",
    "event.key === 'ArrowDown'",
    "event.key === 'ArrowUp'",
    'pointerdown',
    'aria-label'
  ]) {
    assert.ok(menu.includes(contract), `contrato ausente no menu: ${contract}`)
  }
  for (const forbidden of ['window.confirm', 'window.alert', 'Menu.popup', 'remote']) {
    assert.equal(menu.includes(forbidden), false, `superfície nativa no menu: ${forbidden}`)
  }
  // O teclado abre o menu pelas MESMAS teclas da árvore de arquivos.
  assert.ok(menu.includes("event.key === 'ContextMenu'"))
  assert.ok(menu.includes("event.key === 'F10'"))
})

test('o trilho de entrega ganhou o menu sem perder a lista de sempre', async () => {
  const rail = await source('src/renderer/src/components/MissionDeliveryRail.tsx')
  assert.ok(rail.includes('GuiFileContextMenu'), 'o trilho não monta o menu')
  assert.ok(rail.includes('onContextMenu'), 'botão direito não abre nada no trilho')
  // RIGHTDOCK (2026-08-22): a classe ganhou o estado ` open` do diff inline —
  // a lista continua a mesma, com o mesmo menu e o mesmo leitor.
  assert.ok(rail.includes('className={`dr-file'), 'a lista de arquivos da entrega sumiu')
  assert.ok(rail.includes('dr-file-status'), 'o glifo de status do git sumiu')
  // Abrir no app é o clique de sempre — o leitor é o MESMO da aba Arquivos.
  assert.ok(rail.includes('GuiFileQuickReader'))
  assert.equal(rail.includes('window.confirm'), false)
})

test('o leitor rápido reaproveita o viewer da aba Arquivos (não nasce um segundo)', async () => {
  const reader = await source('src/renderer/src/components/GuiFileQuickReader.tsx')
  assert.match(reader, /import FilePreviewPanel from '\.\/FilePreviewPanel'/u)
  assert.ok(reader.includes('createPortal'), 'overlay fora de portal')
  assert.ok(reader.includes("event.key === 'Escape'"), 'Escape não fecha o leitor')
  assert.ok(reader.includes('files.preview'), 'o leitor não lê pelo canal somente-leitura')
})

test('o viewer também abre o menu — e continua somente leitura', async () => {
  const viewer = await source('src/renderer/src/components/FilePreviewPanel.tsx')
  assert.ok(viewer.includes('GuiFileContextMenu'), 'o viewer não monta o menu')
  assert.ok(viewer.includes('onContextMenu'), 'botão direito não abre nada no viewer')
  assert.match(viewer, /file-preview-badge">somente leitura</u, 'a promessa somente-leitura sumiu')
  assert.ok(viewer.includes('aria-haspopup="menu"'), 'sem gatilho de teclado o menu é só do mouse')
})

test('o canal novo do main resolve a raiz por ID e o arquivo pelo resolver físico', async () => {
  const ipc = await source('src/main/ipc/files.ts')
  assert.ok(ipc.includes("'files:openExternal'"), 'o canal novo não existe')

  const handler = ipc.match(/'files:openExternal',[\s\S]*?\n  \)/u)?.[0] ?? ''
  assert.ok(handler, 'não deu para isolar o handler novo')
  assert.ok(
    handler.includes('extras.assertAppRendererSender(event)'),
    'canal que dispara programa do sistema tem que autenticar o remetente'
  )
  assert.ok(handler.includes('readOnlyRootPath('), 'a raiz precisa vir de ID, nunca do renderer')
  assert.ok(handler.includes('resolveReadOnlyFile('), 'o arquivo precisa passar pelo resolver')

  // O que vai para o sistema é SEMPRE o caminho que o resolver provou.
  for (const call of ['shell.openPath(', 'shell.showItemInFolder(']) {
    const at = handler.indexOf(call)
    assert.notEqual(at, -1, `chamada ausente: ${call}`)
    assert.ok(
      handler.slice(at + call.length).startsWith('file.absolutePath'),
      `${call} recebeu algo que não veio do resolver`
    )
    assert.ok(handler.indexOf('resolveReadOnlyFile(') < at, `${call} roda antes do resolver`)
  }
  assert.equal(
    /shell\.(?:openPath|showItemInFolder)\(\s*relativePath/u.test(handler),
    false,
    'caminho cru do renderer chegando ao shell'
  )

  // A cerca antiga continua de pé (a suíte da aba Arquivos conta ≥ 7).
  assert.ok((ipc.match(/extras\.assertAppRendererSender\(event\)/gu) ?? []).length >= 8)
})

test('o preload publica a ponte com o tipo do MAIN (fonte única, sem espelho torto)', async () => {
  const preload = await source('src/preload/index.ts')
  assert.match(preload, /openExternal:\s*\(/u)
  assert.ok(preload.includes("ipcRenderer.invoke('files:openExternal'"))
  assert.match(preload, /FileExternalOpenResult[\s\S]{0,400}from '\.\.\/main\/ipc\/files'/u)
  assert.match(preload, /export type \{[^}]*FileExternalOpenResult/u)
})

/**
 * RODADA 7-D — o esclarecimento do dono: a superfície que ele QUERIA é o CHAT.
 *
 * "Quando o agente cita um arquivo e eu clico, abre aquele painelzinho de
 * código — quero o botão direito ali, como o app do Codex faz." O menu, o
 * modelo e a guarda são os MESMOS; o que muda é o dialeto do pedido: a aba de
 * arquivos fala `projectId + raiz lógica + caminho relativo`, o chat fala
 * `paneId + referência` (a autoridade é o `cwd` do pane, como todo o resto do
 * fio já é).
 */
test('o token do fio tem o MESMO menu de três saídas, no dialeto do pane', () => {
  const options = fileContextOptions(chatTarget())
  assert.deepEqual(
    options.map((option) => option.action),
    ['open-in-app', 'open-default', 'reveal']
  )
  assert.deepEqual(options.map((option) => option.label), [
    'abrir no app',
    'abrir com o programa padrão',
    'mostrar na pasta'
  ])
  // A dica continua contando PARA ONDE o arquivo vai — o `.html` do dono.
  assert.match(
    options.find((option) => option.action === 'open-default').tip,
    /navegador/u
  )
  assert.match(
    fileContextOptions(chatTarget({ path: 'shot.png', reference: 'shot.png' }))
      .find((option) => option.action === 'open-default').tip,
    /imagens|visualizador/u
  )
  // No painel já aberto, "abrir no app" diz a verdade: recarrega esta folha.
  assert.match(
    fileContextOptions(chatTarget({ current: true }))
      .find((option) => option.action === 'open-in-app').tip,
    /já está aberto|recarrega/u
  )
  assert.equal(isChatFileTarget(chatTarget()), true)
  assert.equal(isChatFileTarget(target()), false)
})

test('GUARDA do dialeto do chat: nada torto atravessa o canal do pane', async () => {
  const calls = stubGuiBridge()
  const recusados = [
    chatTarget({ paneId: '' }),
    chatTarget({ paneId: 'a'.repeat(300) }),
    chatTarget({ paneId: 42 }),
    chatTarget({ reference: '' }),
    chatTarget({ reference: 'docs/../../segredo.env' }),
    chatTarget({ reference: 'a'.repeat(4096) }),
    chatTarget({ reference: 'docs/a\u0000.html' }),
    chatTarget({ reference: 'docs/a\n.html' }),
    chatTarget({ reference: 17 }),
    chatTarget({ selectedPath: '' }),
    chatTarget({ selectedPath: '../fora.html' }),
    chatTarget({ selectedPath: 'C:\\Windows\\System32\\calc.exe' }),
    chatTarget({ selectedPath: 9 })
  ]
  for (const bad of recusados) {
    assert.equal(guiChatFileRequest(bad), null, `guarda deixou passar: ${JSON.stringify(bad)}`)
    const outcome = await runGuiChatFileOpen('default', bad)
    assert.equal(outcome.ok, false)
    assert.ok(outcome.error, 'recusa sem motivo é beco sem saída')
  }
  assert.equal(calls.length, 0, 'referência torta do renderer chegou ao IPC')

  // Referência boa atravessa INTACTA (quem normaliza é o resolver do main), e o
  // modo do menu vira o verbo do sistema.
  assert.deepEqual(guiChatFileRequest(chatTarget()), {
    paneId: 'pane-1',
    reference: 'docs/relatorio.html'
  })
  assert.deepEqual(
    guiChatFileRequest(chatTarget({ reference: 'nota.md', selectedPath: 'nota.md' })),
    { paneId: 'pane-1', reference: 'nota.md', selectedPath: 'nota.md' }
  )
  assert.deepEqual(await runGuiChatFileOpen('default', chatTarget()), {
    ok: true,
    action: 'external'
  })
  assert.deepEqual(
    await runGuiChatFileOpen('reveal', chatTarget({ selectedPath: 'docs/relatorio.html' })),
    { ok: true, action: 'reveal' }
  )
  assert.deepEqual(calls, [
    {
      paneId: 'pane-1',
      reference: 'docs/relatorio.html',
      selectedPath: undefined,
      mode: 'default'
    },
    {
      paneId: 'pane-1',
      reference: 'docs/relatorio.html',
      selectedPath: 'docs/relatorio.html',
      mode: 'reveal'
    }
  ])
})

test('os dois dialetos não se misturam — nem por engano de superfície', async () => {
  const filesCalls = stubBridge()
  // Alvo do CHAT no abridor da aba de arquivos: recusa, e nada atravessa.
  const wrongDialect = await runFileOpen('default', chatTarget())
  assert.equal(wrongDialect.ok, false)
  assert.ok(wrongDialect.error)
  assert.equal(filesCalls.length, 0)

  const guiCalls = stubGuiBridge()
  // E o contrário: alvo da aba de arquivos no abridor do chat.
  const otherWay = await runGuiChatFileOpen('reveal', target())
  assert.equal(otherWay.ok, false)
  assert.ok(otherWay.error)
  assert.equal(guiCalls.length, 0)

  // Sem a ponte do pane, a recusa NOMEIA a receita (nunca beco sem saída).
  globalThis.window = { synkora: { gui: {} } }
  const noBridge = await runGuiChatFileOpen('default', chatTarget())
  assert.equal(noBridge.ok, false)
  assert.match(noBridge.error, /npm run dev/u)

  // Ponte que explode no meio vira recusa legível.
  stubGuiBridge(() => {
    throw new Error('canal caiu')
  })
  const crashed = await runGuiChatFileOpen('default', chatTarget())
  assert.equal(crashed.ok, false)
  assert.ok(crashed.error)
})

test('o menu recebe o ABRIDOR de fora: o padrão é o de sempre, o chat injeta o seu', async () => {
  const menu = await source('src/renderer/src/components/GuiFileContextMenu.tsx')
  assert.match(
    menu,
    /opener: FileMenuOpener = runFileOpen/u,
    'o abridor precisa ser injetável, com o dialeto de hoje como padrão'
  )
  assert.match(
    menu,
    /opener\(action === 'reveal' \? 'reveal' : 'default', current\.target\)/u,
    'o menu continua grampeado num dialeto só'
  )

  // As superfícies velhas seguem no dialeto delas; as novas injetam o do pane.
  for (const velha of ['MissionDeliveryRail', 'FilePreviewPanel']) {
    const code = await source(`src/renderer/src/components/${velha}.tsx`)
    assert.ok(code.includes('useFileContextMenu('), `${velha} perdeu o controlador`)
    assert.equal(
      code.includes('runGuiChatFileOpen'),
      false,
      `${velha} não fala o dialeto do chat`
    )
  }
  for (const nova of ['GuiMarkdown', 'GuiFileOpenPanel']) {
    const code = await source(`src/renderer/src/components/${nova}.tsx`)
    assert.ok(code.includes('useFileContextMenu('), `${nova} não monta o controlador`)
    assert.ok(code.includes('runGuiChatFileOpen'), `${nova} não injeta o abridor do pane`)
  }
})

test('o token do chat abre o menu no botão direito e pelo teclado', async () => {
  const markdown = await source('src/renderer/src/components/GuiMarkdown.tsx')
  assert.ok(markdown.includes('onContextMenu'), 'botão direito não abre nada no fio')
  assert.ok(markdown.includes('openFromPointer('), 'o gesto do mouse não abre o menu')
  assert.ok(markdown.includes('openFromKeyboard('), 'sem teclado o menu é só do mouse')
  assert.ok(markdown.includes('<GuiFileContextMenu'), 'o fio não monta o menu')
  assert.ok(
    markdown.includes("closest('button[data-gui-file-token]')"),
    'o menu tem que nascer do TOKEN, não da mensagem inteira'
  )
  // O CLIQUE ESQUERDO continua exatamente o de sempre.
  assert.match(markdown, /guiApi\.fileOpen\(paneId, reference, selectedPath\)/u)
  assert.match(markdown, /aria-haspopup/u, 'o token não anuncia que tem menu')
  for (const forbidden of ['window.confirm', 'window.alert', 'Menu.popup']) {
    assert.equal(markdown.includes(forbidden), false, `superfície nativa no fio: ${forbidden}`)
  }
})

test('o painel de código ganhou o ↗ — sobre o arquivo JÁ resolvido', async () => {
  const panel = await source('src/renderer/src/components/GuiFileOpenPanel.tsx')
  assert.ok(panel.includes('aria-haspopup="menu"'), 'sem gatilho de teclado o menu é só do mouse')
  assert.ok(panel.includes('onContextMenu'), 'botão direito não abre nada no painel')
  assert.ok(panel.includes('<GuiFileContextMenu'), 'o painel não monta o menu')
  // A ambiguidade JÁ está resolvida aqui: referência e escolha são o caminho
  // que o main provou, então a saída externa nunca cai em "qual arquivo?".
  assert.match(panel, /reference: preview\.path/u)
  assert.match(panel, /selectedPath: preview\.path/u)
  assert.ok(panel.includes('current: true'), 'o painel não diz que o arquivo já está aberto aqui')
  // A recusa do sistema fica ONDE o gesto aconteceu.
  assert.ok(panel.includes('gui-file-open-notice'), 'a recusa do sistema não tem lugar no painel')
})

test('o canal do CHAT existe no preload e no espelho do guiApi', async () => {
  const preload = await source('src/preload/index.ts')
  assert.match(preload, /fileOpenExternal:\s*\(/u)
  assert.ok(preload.includes("ipcRenderer.invoke('gui:fileOpenExternal'"))
  assert.match(
    preload,
    /GuiFileExternalOpenResult[\s\S]{0,400}from '\.\.\/main\/ipc\/gui'/u,
    'o tipo do canal novo tem que vir do MAIN (fonte única)'
  )
  assert.match(preload, /export type \{[^}]*GuiFileExternalOpenResult/u)

  const api = await source('src/renderer/src/guiApi.ts')
  assert.match(api, /fileOpenExternal:\s*\(/u, 'o espelho do guiApi não declara o canal')
  assert.match(api, /async fileOpenExternal\(/u, 'o guiApi não implementa o canal')
  assert.ok(api.includes('GuiFileExternalOpenResult'))
})

test('o bloco de estilo novo é papel & painel, sem animação e sem tema escuro', async () => {
  const css = await source('src/renderer/src/global.css')
  // O recorte vai do marcador de INÍCIO ao de FIM do próprio bloco — até
  // 2026-08-29 ele ia "até o fim do arquivo", e o CSS do browser embutido
  // (que tem animação e painel POR DESIGN: o ⚡ pulsa e a página é escura)
  // apendado depois dele fez a cerca morder o vizinho. Cerca prende o que é
  // dela; bloco sem marcador de fim é que seria o bug.
  const start = css.indexOf('BLOCO NOVO: abrir arquivo onde o dono quiser')
  const end = css.indexOf('fim do BLOCO NOVO de abrir arquivo onde o dono quiser')
  assert.ok(start >= 0 && end > start, 'o bloco novo não está delimitado no global.css')
  const block = css.slice(start, end)

  // O menu reaproveita a linguagem de `.file-context-menu` (uma só no app).
  assert.ok(block.includes('.gui-file-context-menu'))
  assert.match(block, /\.dr-file\s*\{[\s\S]*?cursor:\s*pointer/u, 'o item da entrega não virou alavanca')
  assert.ok(block.includes('.gui-file-reader-backdrop'))
  assert.equal(/animation:|@keyframes|transition:/u.test(block), false, 'animação nova no bloco')
  assert.equal(/var\(--panel/u.test(block), false, 'painel escuro é exclusivo do TerminalPane')

  // Rodada 7-D: a fileira de ações do painel de código do CHAT mora no MESMO
  // bloco (uma decisão, um lugar) e segue a régua acima.
  assert.ok(block.includes('.gui-file-panel-actions'), 'o ↗ do painel do chat não tem lugar')
  assert.ok(block.includes('.gui-file-panel-open'))
  assert.match(block, /\.gui-file-panel-open\[aria-expanded='true'\]/u, 'o ↗ aberto não se declara')
})
