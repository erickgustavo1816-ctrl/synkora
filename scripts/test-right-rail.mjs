import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  clampRightRailWidth,
  readRightRailPreference,
  rightRailBounds,
  rightRailStorageKey,
  stepRightRailWidth,
  writeRightRailPreference,
  RIGHT_RAIL_MOTION_MS,
  RIGHT_RAIL_MOTION_TAIL_MS
} from '../src/renderer/src/rightRailSizing.ts'
import {
  COMMIT_DIFF_LINES_PER_FILE,
  commitDiffInitialOpen,
  commitFileKindView,
  commitFilePathLabel,
  ellipsizeMiddle,
  parseCommitDiff,
  takeCommitDiffLines
} from '../src/renderer/src/guiDiffPresentation.ts'

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

/** O CÓDIGO sem comentários: uma proibição se mede no que RENDERIZA, e o
 *  comentário que explica a regra não pode reprovar o arquivo que a obedece. */
const withoutComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1')

/** Contrato do toque de revisão por import DINÂMICO (padrão do
 *  test-plan-board): num código sem o módulo o arquivo ainda roda e cada
 *  contrato de fonte reprova por conta própria. */
const reviewNudge = () => import('../src/renderer/src/missionReviewNudge.ts')

/** Vocabulário da fila de integração (rodada 9) pela MESMA porta dinâmica: o
 *  arquivo inteiro continua rodando quando só este módulo falta. */
const queueVocabulary = () => import('../src/renderer/src/integrationQueuePresentation.ts')

/** O bloco JSX de UM botão, achado pelo handler que ele chama. Recortar pelo
 *  handler — e não por uma regex frouxa sobre o arquivo — mantém o teste preso
 *  ao botão certo mesmo quando o trilho ganha vizinhos. */
function buttonWith(src, handler) {
  const at = src.indexOf(handler)
  assert.ok(at > 0, `botão com ${handler} não encontrado`)
  const start = src.lastIndexOf('<button', at)
  const end = src.indexOf('</button>', at)
  assert.ok(start >= 0 && end > at, `o bloco do botão ${handler} mudou de forma`)
  return src.slice(start, end)
}

test('trilho limita largura pela fração disponível e preserva o centro', () => {
  assert.deepEqual(rightRailBounds(1000), { min: 176, max: 420 })
  assert.equal(clampRightRailWidth(100, 1000), 176)
  assert.equal(clampRightRailWidth(999, 1000), 420)
  assert.equal(clampRightRailWidth(300, 1000), 300)

  const narrow = rightRailBounds(500)
  assert.deepEqual(narrow, { min: 128, max: 128 })
  assert.equal(clampRightRailWidth(204, 500), 128)
})

test('preferência é isolada por projeto, tolera storage inválido e persiste sem bloquear', () => {
  const values = new Map()
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  }
  const key = rightRailStorageKey('Projeto / um')
  assert.equal(key, 'synkora.rightRail.v1:Projeto%20%2F%20um')
  assert.deepEqual(readRightRailPreference(storage, key), { width: 204, collapsed: false })

  writeRightRailPreference(storage, key, { width: 287.6, collapsed: true })
  assert.deepEqual(readRightRailPreference(storage, key), { width: 288, collapsed: true })

  values.set(key, '{quebrado')
  assert.deepEqual(readRightRailPreference(storage, key), { width: 204, collapsed: false })
  assert.deepEqual(readRightRailPreference(null, key), { width: 204, collapsed: false })
})

test('passos de teclado respeitam os dois limites', () => {
  assert.equal(stepRightRailWidth(204, 'increase', 1000, 24), 228)
  assert.equal(stepRightRailWidth(204, 'decrease', 1000, 24), 180)
  assert.equal(stepRightRailWidth(176, 'decrease', 1000, 24), 176)
  assert.equal(stepRightRailWidth(420, 'increase', 1000, 24), 420)
})

test('contrato da UI expõe recolher, separator focável e cleanup do gesto', async () => {
  const [component, css, board] = await Promise.all([
    source('src/renderer/src/components/ResizableRightRail.tsx'),
    source('src/renderer/src/global.css'),
    source('src/renderer/src/components/Board.tsx')
  ])
  assert.match(component, /role="separator"/u)
  assert.match(component, /tabIndex=\{0\}/u)
  assert.match(component, /aria-valuemin=\{bounds\.min\}/u)
  assert.match(component, /ArrowLeft/u)
  assert.match(component, /ArrowRight/u)
  assert.match(component, /case 'Home'/u)
  assert.match(component, /case 'End'/u)
  assert.match(component, /setPointerCapture/u)
  assert.match(component, /releasePointerCapture/u)
  assert.match(component, /window\.removeEventListener\('blur', onCancel\)/u)
  assert.match(component, /aria-expanded=\{!preference\.collapsed\}/u)
  assert.match(component, /inert=\{preference\.collapsed \? true : undefined\}/u)
  assert.doesNotMatch(component, /right-rail-chrome/u)
  assert.doesNotMatch(component, /right-rail-toolbar/u)
  assert.match(css, /\.board-main\.stage-mode \.board-content\.right-rail/u)
  assert.match(css, /\.right-rail\.is-collapsed/u)
  assert.match(css, /\.right-rail-resizer:focus-visible/u)
  assert.match(css, /\.board-main\.stage-mode \.board-content\.right-rail\s*\{[\s\S]*?border-left:\s*1px solid var\(--line\)/u)
  assert.match(css, /\.right-rail-resizer\s*\{[\s\S]*?position:\s*absolute/u)
  assert.match(css, /\.right-rail-toggle\s*\{[\s\S]*?right:\s*12px/u)
  assert.match(css, /\.right-rail-content\s*\{[\s\S]*?padding-left:\s*12px/u)
  assert.match(css, /\.right-rail-content > \.delivery-rail > \.dr-head\s*\{[\s\S]*?padding-right:\s*22px/u)
  assert.match(
    css,
    /\.board-main\.stage-mode \.board-content\.right-rail\.is-collapsed\s*\{[\s\S]*?position:\s*absolute[\s\S]*?width:\s*0\s*!important[\s\S]*?border:\s*0/u
  )
  assert.match(
    css,
    /\.right-rail\.is-collapsed \.right-rail-toggle\s*\{[\s\S]*?top:\s*9px[\s\S]*?right:\s*9px[\s\S]*?transform:\s*none/u
  )
  assert.doesNotMatch(css, /\.right-rail-enabled\.is-collapsed\s*\{[\s\S]*?(?:width|flex-basis):\s*22px/u)
  // A cerca do grid aposentado vale para o RAIL, não para o arquivo inteiro:
  // o regex global reprovou o `.gpi-head` do card de proposta (2026-08-15),
  // uma regra alheia que por coincidência começa com as mesmas duas colunas.
  // A régua continua idêntica — nenhuma regra `.right-rail*` pode voltar ao
  // grid `18px minmax(0, 1fr)` do chrome antigo.
  for (const block of css.matchAll(/^\.right-rail[^{]*\{[\s\S]*?\n\}/gmu)) {
    assert.doesNotMatch(block[0], /grid-template-columns:\s*18px minmax\(0, 1fr\)/u)
  }
  assert.doesNotMatch(css, /\.right-rail-chrome\s*\{/u)
  assert.doesNotMatch(css, /\.right-rail-toolbar\s*\{/u)
  assert.match(board, /<ResizableRightRail/u)
  assert.match(board, /projectKey=\{projectId\}/u)
})

test('a rampa do recolher pertence ao BOTÃO e nunca atravessa o arrasto', async () => {
  const [component, css] = await Promise.all([
    source('src/renderer/src/components/ResizableRightRail.tsx'),
    source('src/renderer/src/global.css')
  ])

  // O clique liga a classe do gesto; o arrasto a desliga ANTES de capturar o
  // ponteiro. Sem essa ordem a largura ficaria elástica atrás do cursor.
  assert.match(component, /animating \? 'is-animating' : ''/u)
  assert.match(component, /onClick=\{toggleCollapsed\}/u)
  assert.match(
    component,
    /function onResizePointerDown\([\s\S]*?cancelCollapseAnimation\(\)[\s\S]*?setPointerCapture/u
  )
  // Movimento reduzido = toggle seco, o comportamento anterior à rampa.
  assert.match(component, /prefers-reduced-motion: reduce/u)
  assert.match(component, /!prefersReducedMotion\(\)/u)
  // Timer do gesto morre com o componente e com a troca de projeto.
  assert.match(component, /window\.clearTimeout\(motionTimerRef\.current\)/u)

  // A duração é UMA só: o componente publica a constante como custom property
  // e o CSS a consome — não há como o timer e a transição divergirem.
  assert.ok(
    RIGHT_RAIL_MOTION_MS >= 180 && RIGHT_RAIL_MOTION_MS <= 240,
    'a rampa precisa ficar na faixa curta (180–240ms) do tema'
  )
  assert.ok(RIGHT_RAIL_MOTION_TAIL_MS > 0, 'a classe precisa sobreviver ao último frame')
  assert.match(component, /'--right-rail-motion': `\$\{RIGHT_RAIL_MOTION_MS\}ms`/u)
  assert.match(component, /RIGHT_RAIL_MOTION_MS \+ RIGHT_RAIL_MOTION_TAIL_MS/u)

  const railRule = css.match(
    /\.board-main\.stage-mode \.board-content\.right-rail \{([\s\S]*?)\n\}/u
  )?.[1]
  assert.ok(railRule, 'a regra base do trilho precisa existir')
  // CERCA CENTRAL: transição na regra BASE pegaria o arrasto junto.
  assert.doesNotMatch(
    railRule,
    /transition/u,
    'a rampa mora em .is-animating; na regra base ela tornaria o arrasto elástico'
  )
  assert.match(
    css,
    /\.board-main\.stage-mode \.board-content\.right-rail\.is-animating\s*\{[\s\S]*?transition:\s*\n?\s*width var\(--right-rail-motion/u
  )
  // Fechando, o trilho continua NO FLUXO: é a largura dele que devolve o espaço
  // ao chat quadro a quadro (sem isso o centro saltaria de uma vez).
  assert.match(
    css,
    /\.board-main\.stage-mode \.board-content\.right-rail\.is-collapsed\.is-animating\s*\{[\s\S]*?position:\s*relative/u
  )

  // A margem negativa tem que comer EXATAMENTE o gap do .board-main, senão a
  // pegada salta no último frame, quando o trilho sai do fluxo.
  const boardMain = css.match(/\n\.board-main \{([\s\S]*?)\n\}/u)?.[1]
  const gap = Number(boardMain?.match(/\bgap:\s*(\d+)px/u)?.[1])
  const gutter = Number(railRule.match(/--right-rail-gutter:\s*(\d+)px/u)?.[1])
  assert.ok(Number.isFinite(gap) && Number.isFinite(gutter))
  assert.equal(gutter, gap, 'o --right-rail-gutter espelha o gap do .board-main')
  assert.match(
    css,
    /\.board-main\.stage-mode \.board-content\.right-rail\.is-collapsed\s*\{[\s\S]*?margin-left:\s*calc\(-1 \* var\(--right-rail-gutter\)\)/u
  )

  // O conteúdo fica na largura ABERTA durante o gesto (não se espreme): a conta
  // precisa bater com a caixa real — borda do trilho + paddings do scroller.
  const contentRule = css.match(/\n\.right-rail-content \{([\s\S]*?)\n\}/u)?.[1]
  const inset = Number(contentRule?.match(/--right-rail-content-inset:\s*(\d+)px/u)?.[1])
  const padLeft = Number(contentRule?.match(/padding-left:\s*(\d+)px/u)?.[1])
  const padRight = Number(contentRule?.match(/padding-right:\s*(\d+)px/u)?.[1])
  const border = Number(railRule.match(/border-left:\s*(\d+)px solid/u)?.[1])
  assert.ok([inset, padLeft, padRight, border].every(Number.isFinite))
  assert.equal(
    inset,
    padLeft + padRight + border,
    'o inset congelado no gesto = paddings do scroller + borda do trilho'
  )
  assert.match(
    css,
    /\.right-rail\.is-animating \.right-rail-content > \*\s*\{[\s\S]*?width:\s*calc\([\s\S]*?--right-rail-content-inset/u
  )
  // `visibility` na lista segura o conteúdo visível até o fim da rampa.
  assert.match(
    css,
    /\.right-rail\.is-animating \.right-rail-content\s*\{[\s\S]*?visibility var\(--right-rail-motion/u
  )
})

test('gesto seco onde a rampa não descreveria o movimento', async () => {
  const css = await source('src/renderer/src/global.css')

  // Empilhado a caixa que fecha é a ALTURA: largura animada ali seria mentira.
  const stacked = (css.match(/@container board \(max-width: 1103px\) \{[\s\S]*?\n\}/gu) ?? []).find(
    (block) => block.includes('.right-rail-resizer')
  )
  assert.ok(stacked, 'o bloco empilhado do trilho precisa existir')
  assert.match(
    stacked,
    /\.board \.board-main\.stage-mode \.board-content\.right-rail\.is-animating\s*\{[\s\S]*?transition:\s*none/u
  )
  assert.match(
    stacked,
    /\.board \.board-main\.stage-mode \.board-content\.right-rail\.is-collapsed\.is-animating\s*\{[\s\S]*?position:\s*absolute/u
  )

  // Movimento reduzido: o toggle volta a ser instantâneo, mesmo se a classe
  // escapar do guarda do componente.
  const reduced = (
    css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/gu) ?? []
  ).find((block) => block.includes('.right-rail-toggle'))
  assert.ok(reduced, 'o bloco de movimento reduzido do trilho precisa existir')
  assert.match(reduced, /\.board-main\.stage-mode \.board-content\.right-rail\.is-animating/u)
  assert.match(reduced, /\.right-rail\.is-animating \.right-rail-content/u)
  assert.match(reduced, /\.is-collapsed\.is-animating\s*\{[\s\S]*?position:\s*absolute/u)
})

// ————— VISUALIZADOR DE COMMIT: o parser do diff —————
// Fixtures LITERAIS, escritas como o git escreve. O parser é a fonte única das
// duas superfícies (resumo no trilho, linhas na janela larga), então um erro
// aqui aparece nas duas ao mesmo tempo.

const patch = (...lines) => `${lines.join('\n')}\n`

test('parser separa o patch por arquivo e conta o placar de cada um', () => {
  const summary = parseCommitDiff(
    patch(
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1111111..2222222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,4 +1,5 @@ export function app()',
      ' const a = 1',
      '-const b = 2',
      '+const b = 3',
      '+const c = 4',
      ' const d = 5',
      'diff --git a/leia.md b/leia.md',
      '--- a/leia.md',
      '+++ b/leia.md',
      '@@ -7 +7 @@',
      '-antes',
      '+depois'
    )
  )

  assert.equal(summary.files.length, 2)
  assert.equal(summary.insertions, 3)
  assert.equal(summary.deletions, 2)
  assert.equal(summary.truncated, false)
  assert.equal(summary.unreadable, false)

  const [first] = summary.files
  assert.equal(first.path, 'src/app.ts')
  assert.equal(first.kind, 'modify')
  assert.equal(first.insertions, 2)
  assert.equal(first.deletions, 1)
  assert.equal(first.lineCount, 5)
  // O `@@` vira âncora + assinatura da função, separados: a UI mostra os dois
  // com pesos diferentes em vez de repetir a linha crua.
  assert.equal(first.hunks[0].range, '@@ -1,4 +1,5 @@')
  assert.equal(first.hunks[0].section, 'export function app()')
  assert.deepEqual(
    first.hunks[0].lines.map((line) => [line.kind, line.oldNumber, line.newNumber, line.text]),
    [
      ['context', 1, 1, 'const a = 1'],
      ['remove', 2, null, 'const b = 2'],
      ['add', null, 2, 'const b = 3'],
      ['add', null, 3, 'const c = 4'],
      ['context', 3, 4, 'const d = 5']
    ]
  )
  // Hunk sem vírgula (`@@ -7 +7 @@`) numera a partir do 7 nos dois lados.
  assert.deepEqual(
    summary.files[1].hunks[0].lines.map((line) => [line.oldNumber, line.newNumber]),
    [
      [7, null],
      [null, 7]
    ]
  )
})

test('parser reconhece novo, apagado, renomeado, copiado e mudança só de permissão', () => {
  const summary = parseCommitDiff(
    patch(
      'diff --git a/novo.md b/novo.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/novo.md',
      '@@ -0,0 +1,2 @@',
      '+linha um',
      '+linha dois',
      'diff --git a/velho.md b/velho.md',
      'deleted file mode 100644',
      '--- a/velho.md',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-tchau',
      'diff --git a/antigo.txt b/renomeado.txt',
      'similarity index 96%',
      'rename from antigo.txt',
      'rename to renomeado.txt',
      '--- a/antigo.txt',
      '+++ b/renomeado.txt',
      '@@ -3 +3 @@',
      '-x',
      '+y',
      'diff --git a/base.txt b/copia.txt',
      'similarity index 100%',
      'copy from base.txt',
      'copy to copia.txt',
      'diff --git a/script.sh b/script.sh',
      'old mode 100644',
      'new mode 100755'
    )
  )

  assert.deepEqual(
    summary.files.map((file) => [file.path, file.kind, file.oldPath ?? null]),
    [
      ['novo.md', 'add', null],
      ['velho.md', 'delete', null],
      ['renomeado.txt', 'rename', 'antigo.txt'],
      ['copia.txt', 'copy', 'base.txt'],
      ['script.sh', 'mode', null]
    ]
  )
  // Modificação normal NÃO carrega oldPath: só rename/copy têm origem própria.
  assert.equal(commitFilePathLabel(summary.files[2]), 'antigo.txt → renomeado.txt')
  assert.equal(commitFilePathLabel(summary.files[0]), 'novo.md')
  // Arquivo sem linha nenhuma explica o porquê em vez de aparecer vazio.
  assert.match(summary.files[4].note ?? '', /permissão/u)
  assert.match(summary.files[3].note ?? '', /renomeado sem mudar conteúdo|sem linhas/u)
  assert.equal(commitFileKindView('add').cls, 'add')
  assert.equal(commitFileKindView('delete').glyph, '−')
})

test('binário entra na lista sem NENHUMA linha de payload na tela', () => {
  const summary = parseCommitDiff(
    patch(
      'diff --git a/logo.png b/logo.png',
      'index 4444444..5555555 100644',
      'GIT binary patch',
      'literal 120',
      'zc$@(K0001pP)<h;3K|Lk000e1NJLTq',
      'zc$@(K0001pP)<h;3K|Lk000e1NJLTq',
      '',
      'literal 0',
      'HcmV?d00001',
      'diff --git a/dados.bin b/dados.bin',
      'index 6666666..7777777 100644',
      'Binary files a/dados.bin and b/dados.bin differ',
      'diff --git a/depois.txt b/depois.txt',
      '--- a/depois.txt',
      '+++ b/depois.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b'
    )
  )

  assert.deepEqual(
    summary.files.map((file) => [file.path, file.binary, file.lineCount]),
    [
      ['logo.png', true, 0],
      ['dados.bin', true, 0],
      ['depois.txt', false, 2]
    ]
  )
  assert.match(summary.files[0].note ?? '', /binário/u)
  // O base85 do `--binary` não pode ter virado linha de contexto de ninguém —
  // e o arquivo DEPOIS dele precisa ser lido normalmente.
  assert.equal(summary.insertions, 1)
  assert.equal(summary.deletions, 1)
})

test('parser sobrevive às bordas: vazio, lixo, CRLF, caminho citado e sem newline final', () => {
  assert.deepEqual(parseCommitDiff('').files, [])
  assert.equal(parseCommitDiff('').unreadable, false, 'patch vazio não é patch ilegível')
  assert.equal(parseCommitDiff('isto nao e um patch').unreadable, true)
  assert.deepEqual(parseCommitDiff(undefined).files, [])

  // O git cita caminho com caractere especial e escreve os bytes UTF-8 em octal.
  const quoted = parseCommitDiff(
    patch(
      'diff --git "a/pasta com espa\\303\\247o/ol\\303\\241.txt" "b/pasta com espa\\303\\247o/ol\\303\\241.txt"',
      '--- "a/pasta com espa\\303\\247o/ol\\303\\241.txt"',
      '+++ "b/pasta com espa\\303\\247o/ol\\303\\241.txt"',
      '@@ -1 +1 @@',
      '-a',
      '+b'
    )
  )
  assert.equal(quoted.files[0].path, 'pasta com espaço/olá.txt')

  // CRLF no transporte não pode virar linha fantasma nem sujar o texto.
  const crlf = parseCommitDiff(
    ['diff --git a/x.txt b/x.txt', '--- a/x.txt', '+++ b/x.txt', '@@ -1 +1 @@', '-a', '+b', ''].join('\r\n')
  )
  assert.equal(crlf.files.length, 1)
  assert.deepEqual(
    crlf.files[0].hunks[0].lines.map((line) => line.text),
    ['a', 'b']
  )

  // "\ No newline at end of file" é recado do git: não conta como linha do
  // arquivo e não move a numeração.
  const noNewline = parseCommitDiff(
    patch(
      'diff --git a/x.txt b/x.txt',
      '--- a/x.txt',
      '+++ b/x.txt',
      '@@ -1,2 +1,2 @@',
      ' fica',
      '-antes',
      '\\ No newline at end of file',
      '+depois',
      '\\ No newline at end of file'
    )
  )
  const kinds = noNewline.files[0].hunks[0].lines.map((line) => line.kind)
  assert.deepEqual(kinds, ['context', 'remove', 'note', 'add', 'note'])
  assert.equal(noNewline.files[0].insertions, 1)
  assert.equal(noNewline.files[0].deletions, 1)
  const note = noNewline.files[0].hunks[0].lines[2]
  assert.equal(note.oldNumber, null)
  assert.equal(note.newNumber, null)

  // A última linha de contexto não ganha gêmea por causa do \n final.
  const trailing = parseCommitDiff(
    patch('diff --git a/x.txt b/x.txt', '--- a/x.txt', '+++ b/x.txt', '@@ -1,2 +1,2 @@', '-a', '+b', ' fim')
  )
  assert.equal(trailing.files[0].lineCount, 3)
})

test('corte do patch e teto de render são honestos, nunca silenciosos', () => {
  const cut = parseCommitDiff(
    patch('diff --git a/x.txt b/x.txt', '--- a/x.txt', '+++ b/x.txt', '@@ -1 +1 @@', '-a', '+b'),
    { truncated: true }
  )
  assert.equal(cut.truncated, true, 'o corte do main atravessa até a tela')

  const many = parseCommitDiff(
    patch(
      'diff --git a/x.txt b/x.txt',
      '--- a/x.txt',
      '+++ b/x.txt',
      `@@ -1,${600} +1,${600} @@`,
      ...Array.from({ length: 600 }, (_, index) => ` linha ${index}`)
    )
  )
  const file = many.files[0]
  assert.equal(file.lineCount, 600)

  const capped = takeCommitDiffLines(file, COMMIT_DIFF_LINES_PER_FILE)
  const shown = capped.hunks.reduce((total, hunk) => total + hunk.lines.length, 0)
  assert.equal(shown, COMMIT_DIFF_LINES_PER_FILE)
  assert.equal(capped.hidden, 600 - COMMIT_DIFF_LINES_PER_FILE)
  // O que sobra + o que aparece É o arquivo: o expansor nunca mente no número.
  assert.equal(shown + capped.hidden, file.lineCount)

  const whole = takeCommitDiffLines(file, Number.POSITIVE_INFINITY)
  assert.equal(whole.hidden, 0)
  assert.equal(whole.hunks, file.hunks, 'sem corte, os hunks passam sem cópia')

  // Corte no meio de um hunk mantém o hunk (com o cabeçalho) e fatia as linhas.
  const half = takeCommitDiffLines(file, 10)
  assert.equal(half.hunks.length, 1)
  assert.equal(half.hunks[0].lines.length, 10)
  assert.equal(half.hunks[0].header, file.hunks[0].header)
})

test('orçamento de abertura protege o commit largo sem esconder o primeiro arquivo', () => {
  const big = (lineCount) => ({ lineCount })
  assert.deepEqual(commitDiffInitialOpen([big(50), big(50), big(50)], 120, 400), [true, true, false])
  // O primeiro abre mesmo estourando sozinho: janela que abre vazia não responde
  // à pergunta que o clique fez.
  assert.deepEqual(commitDiffInitialOpen([big(9_000), big(10)], 120, 400), [true, false])
  assert.deepEqual(commitDiffInitialOpen([]), [])
})

test('caminho encurta pelo MEIO — as duas pontas identificam o arquivo', () => {
  assert.equal(ellipsizeMiddle('src/a.ts', 40), 'src/a.ts')
  const short = ellipsizeMiddle('src/renderer/src/components/MissionDeliveryRail.tsx', 24)
  assert.equal(short.length, 24)
  assert.ok(short.includes('…'))
  assert.ok(short.startsWith('src/re'), 'a raiz continua legível')
  assert.ok(short.endsWith('.tsx'), 'a ponta do nome do arquivo nunca se perde')
})

test('trilho mostra RESUMO e o diff cru some da coluna estreita', async () => {
  const [history, css] = await Promise.all([
    source('src/renderer/src/components/MissionCommitHistory.tsx'),
    source('src/renderer/src/global.css')
  ])

  // A regressão que originou o redesenho: patch cru dentro de ~200px.
  assert.doesNotMatch(history, /<pre>/u, 'patch cru não volta para o trilho')
  assert.doesNotMatch(css, /\.mh-patch-panel pre\s*\{/u)
  assert.match(history, /parseCommitDiff\(result\.diff \?\? '', \{ truncated: result\.truncated \}\)/u)
  assert.match(history, /<CommitPatchSummary/u)
  assert.match(history, /class(?:Name)?="mh-diff-file"/u)
  assert.match(history, /⤢ abrir diff/u)
  // Somente leitura continua sendo a promessa da superfície.
  assert.match(history, /somente leitura/u)
  assert.doesNotMatch(history, /\b(?:stage|commitar|git add)\b/iu)

  assert.match(css, /\.mh-diff-plus\s*\{[\s\S]*?color:\s*var\(--ok\)/u)
  assert.match(css, /\.mh-diff-minus\s*\{[\s\S]*?color:\s*var\(--err\)/u)
  assert.match(css, /\.mh-diff-path\s*\{[\s\S]*?text-overflow:\s*ellipsis/u)
  assert.match(css, /\.mh-diff-open\s*\{[\s\S]*?text-transform:\s*uppercase/u)
})

test('janela do diff é dona do Esc, do foco e do próprio teto de render', async () => {
  const [viewer, css] = await Promise.all([
    source('src/renderer/src/components/MissionCommitDiffViewer.tsx'),
    source('src/renderer/src/global.css')
  ])

  // `.overlay` + role=dialog é EXATAMENTE o que o guiEscape procura antes de
  // mandar o Esc para o chat: sem os dois, Esc interromperia o agente atrás.
  assert.match(viewer, /className="overlay cdv-overlay"/u)
  assert.match(viewer, /role="dialog"/u)
  assert.match(viewer, /aria-modal="true"/u)
  assert.match(viewer, /event\.key === 'Escape'/u)
  assert.match(viewer, /previousFocus\?\.isConnected/u)
  assert.match(viewer, /event\.key !== 'Tab'/u)
  assert.match(viewer, /createPortal/u)
  // Teto de render + expansor honesto.
  assert.match(viewer, /takeCommitDiffLines\(file, full \? Number\.POSITIVE_INFINITY : COMMIT_DIFF_LINES_PER_FILE\)/u)
  assert.match(viewer, /\+\{view\.hidden\}/u)
  assert.match(viewer, /commitDiffInitialOpen\(files\)/u)
  // Nada aqui escreve no worktree.
  assert.doesNotMatch(viewer, /window\.synkora/u)

  // Cabeçalho grudado no topo do scroller, rolagem horizontal POR ARQUIVO.
  assert.match(css, /\.cdv-file-head\s*\{[\s\S]*?position:\s*sticky[\s\S]*?top:\s*0/u)
  assert.match(css, /\.cdv-code\s*\{[\s\S]*?overflow-x:\s*auto/u)
  assert.match(css, /\.cdv-line\s*\{[\s\S]*?min-width:\s*max-content/u)
  assert.match(css, /\.cdv-line\.add\s*\{[\s\S]*?color-mix\(in srgb, var\(--ok\)/u)
  assert.match(css, /\.cdv-line\.remove\s*\{[\s\S]*?color-mix\(in srgb, var\(--err\)/u)
  assert.match(css, /\.cdv-num\s*\{[\s\S]*?font-variant-numeric:\s*tabular-nums/u)
  // A janela cabe abaixo da titlebar (36px) sem disputar z-index com ela.
  const window = css.match(/\n\.cdv-window \{([\s\S]*?)\n\}/u)?.[1]
  assert.ok(window, 'a regra da janela precisa existir')
  assert.match(window, /height:\s*min\(880px, calc\(100vh - 88px\)\)/u)
  assert.doesNotMatch(window, /z-index/u)
  const overlayPad = Number(
    css.match(/\n\.cdv-overlay \{[\s\S]*?padding:\s*(\d+)px/u)?.[1]
  )
  assert.ok(overlayPad >= 36, 'a folga vertical precisa passar da titlebar de 36px')
})

// ————— AS ALAVANCAS DE AGENTE DO TRILHO (design D6, reescrito em 18/08) —————
//
// Ordem do dono: o botão ✦ AJUDANTE morre — quem abre ajudante é o AGENTE do
// chat, pelo `delegate` do MCP, porque é o único caminho em que modelo, effort
// e conta aparecem na lateral. E o 🧐 REVISAR para de abrir pane: ele dá um
// TOQUE no chat principal, como mensagem do dono, com mandato ESTRITO de code
// review. Estes quatro testes são a cerca dos dois gestos.

test('o botão ✦ ajudante MORREU — nenhum gesto do trilho abre subagente', async () => {
  const [rail, board] = await Promise.all([
    source('src/renderer/src/components/MissionDeliveryRail.tsx'),
    source('src/renderer/src/components/Board.tsx')
  ])
  const railCode = withoutComments(rail)
  const boardCode = withoutComments(board)

  assert.doesNotMatch(railCode, /✦ ajudante/u, 'o botão de ajudante voltou ao trilho')
  assert.doesNotMatch(railCode, /onHelper/u, 'a prop do ajudante ficou pendurada no trilho')
  assert.doesNotMatch(boardCode, /onHelper/u, 'o Board ainda passa a prop do ajudante')
  // O papel PLURAL não nasce mais de clique nenhum: o caso especial dele saiu
  // junto com o botão.
  assert.doesNotMatch(boardCode, /openMissionGuiRole\([^)]*'helper'\)/u)
  assert.doesNotMatch(boardCode, /role !== 'helper'/u)
})

test('🧐 revisar dá um TOQUE no chat do agente — nunca abre pane de revisor', async () => {
  const board = await source('src/renderer/src/components/Board.tsx')
  const code = withoutComments(board)

  assert.doesNotMatch(
    code,
    /openMissionGuiRole\([^)]*'reviewer'\)/u,
    'o revisar voltou a abrir um pane em vez de tocar o agente'
  )
  // O toque viaja pelo MESMO caminho do composer (`gui.send`, pela ação do
  // store) e leva um messageId próprio de `guiItemIdentity` — é ele que dá
  // idempotência à entrega no main.
  assert.match(board, /from '\.\.\/missionReviewNudge'/u)
  assert.match(board, /from '\.\.\/guiItemIdentity'/u)
  assert.match(code, /sendGuiMessage\(\s*paneId,\s*REVIEW_NUDGE_TEXT,\s*guiItemId\(\)\s*\)/u)
  // O destino é o chat do AGENTE, nunca o slot que está em foco.
  assert.match(code, /directSlots\.find\(\(s\) => s\.role === 'dev'\)/u)
  assert.match(code, /onReview=\{\(\) => void nudgeReview\(\)\}/u)
  assert.match(code, /reviewReady=\{reviewReady\}/u)
})

test('o texto do toque carrega o mandato ESTRITO do dono', async () => {
  const { REVIEW_NUDGE_TEXT } = await reviewNudge()

  // Um parágrafo só: o toque entra no fio como uma fala do dono.
  assert.doesNotMatch(REVIEW_NUDGE_TEXT, /\n/u)
  assert.ok(
    REVIEW_NUDGE_TEXT.length > 200 && REVIEW_NUDGE_TEXT.length < 1_400,
    'o toque precisa caber numa fala, sem virar briefing'
  )
  // UM ajudante, pelo MCP — nunca subagente nativo, nunca uma frota.
  assert.match(REVIEW_NUDGE_TEXT, /\bdelegate\b/u)
  assert.match(REVIEW_NUDGE_TEXT, /UM ajudante/u)
  // O mandato: limpeza, escrita e refatoração — e NADA de QA.
  assert.match(REVIEW_NUDGE_TEXT, /limpo/u)
  assert.match(REVIEW_NUDGE_TEXT, /bem escrito/u)
  assert.match(REVIEW_NUDGE_TEXT, /refatora/u)
  assert.match(REVIEW_NUDGE_TEXT, /nada de QA|sem QA/u)
  // A régua velha do dono: reviewer NUNCA legisla capacidade nova.
  assert.match(REVIEW_NUDGE_TEXT, /nunca prometeu/u)
  assert.match(REVIEW_NUDGE_TEXT, /sugestão/u)
  // Os padrões carimbados pelo dono valem quando o pedido não especifica.
  assert.match(REVIEW_NUDGE_TEXT, /painel de delegação/u)
  // A volta: `helper_result` + lista ordenada por gravidade.
  assert.match(REVIEW_NUDGE_TEXT, /helper_result/u)
  assert.match(REVIEW_NUDGE_TEXT, /gravidade/u)
})

test('o botão de revisar diz a verdade nova — e a trava do chat fora do ar fica', async () => {
  const rail = withoutComments(await source('src/renderer/src/components/MissionDeliveryRail.tsx'))
  const button = buttonWith(rail, 'onClick={onReview}')

  // RIGHTDOCK: o rótulo virou ÍCONE na fileira de ações; a VERDADE inteira
  // mudou de lugar (para a dica), nunca de conteúdo.
  assert.match(button, /🧐/u)
  assert.match(button, /Revisar/u)
  // "sessão limpa" descrevia um PANE de revisor que não existe mais.
  assert.doesNotMatch(rail, /sessão limpa/u)
  // A dica descreve o que o clique faz de verdade: pedir UM ajudante que roda
  // na lateral, em sessão headless nova.
  assert.match(button, /ajudante/u)
  assert.match(button, /lateral/u)
  assert.match(button, /headless/u)
  // A trava continua: sem ponte OU sem chat pronto, o toque não sai.
  assert.match(button, /disabled=\{!guiAvailable \|\| !reviewReady\}/u)
  assert.match(rail, /reviewReady: boolean/u)
})

// ————— O TRILHO MEDE SOZINHO (W4, 2026-08-18 — bug ao vivo do dono) —————
//
// Ele viu um commit nascer e um arquivo aparecer, e o trilho seguiu dizendo
// "+0 −0 · 0 arquivos" até ele SAIR da aba e VOLTAR: o único gatilho de
// re-medida era o `reloadToken` do Board, que só anda no clique dele. Palavras
// do dono: "tudo ali tem que atualizar em tempo real; não tenho que sair e
// voltar pra ver o que tá acontecendo".
//
// Os quatro testes abaixo são a cerca dos TRÊS gatilhos (atividade com
// debounce · poll lento à vista · o reloadToken de sempre), da coalescência
// (nunca dois `git` no mesmo worktree) e do não-pisca (o número que já está na
// tela nunca some para "medindo…" nem para um erro passageiro).

/** O corpo de um `useEffect`, achado pela ÚLTIMA abertura antes do ponto onde
 *  a constante é usada. Recortar pelo uso — e não por uma regex sobre o arquivo
 *  inteiro — mantém o contrato preso ao efeito certo quando o trilho crescer. */
function effectUsing(src, needle, tail = 340) {
  const at = src.indexOf(needle)
  assert.ok(at > 0, `o uso de ${needle} não foi encontrado`)
  const start = src.lastIndexOf('useEffect', at)
  assert.ok(start >= 0, `o uso de ${needle} precisa morar dentro de um useEffect`)
  return src.slice(start, at + tail)
}

/** Número escrito no fonte com separador de milhar do TS (`15_000`). */
function constantOf(src, name) {
  const raw = src.match(new RegExp(`${name}\\s*=\\s*([\\d_]+)`, 'u'))?.[1]
  assert.ok(raw, `a constante ${name} precisa existir no trilho`)
  return Number(raw.replace(/_/gu, ''))
}

test('o trilho re-mede na ATIVIDADE do chat — debounce de cauda com faxina do timer', async () => {
  const [rail, board] = await Promise.all([
    source('src/renderer/src/components/MissionDeliveryRail.tsx'),
    source('src/renderer/src/components/Board.tsx')
  ])
  const railCode = withoutComments(rail)
  const boardCode = withoutComments(board)

  // A prop é OPCIONAL: missão de planejamento e o devMock não têm conversa
  // para observar, e a falta dela nunca pode derrubar o trilho.
  assert.match(railCode, /activityToken\?:\s*number/u)

  // DEBOUNCE DE CAUDA: cada evento novo rearma o relógio e a faxina cancela o
  // anterior — uma rajada de 200 deltas mede UMA vez, não 200.
  const debounce = effectUsing(railCode, ', RAIL_ACTIVITY_DEBOUNCE_MS)')
  assert.match(debounce, /window\.setTimeout\(/u)
  assert.match(debounce, /return \(\) => window\.clearTimeout\(/u)
  assert.match(debounce, /\[activityToken/u, 'o efeito precisa depender do sinal de atividade')

  const ms = constantOf(rail, 'RAIL_ACTIVITY_DEBOUNCE_MS')
  assert.ok(ms >= 2_000 && ms <= 3_000, `a cauda precisa ficar em 2–3s (veio ${ms}ms)`)

  // O Board deriva o sinal do que JÁ tem: `eventRevision` é o contador que o
  // store avança a cada evento REAL do backend (mensagem, resultado de
  // ferramenta, ajudante que assenta no fio do agente). Zero canal novo.
  assert.match(boardCode, /eventRevision \?\? 0/u)
  assert.match(boardCode, /activityToken=\{railActivity\}/u)
})

test('poll lento do trilho só roda À VISTA — e devolve intervalo e ouvinte ao sair', async () => {
  const [rail, board] = await Promise.all([
    source('src/renderer/src/components/MissionDeliveryRail.tsx'),
    source('src/renderer/src/components/Board.tsx')
  ])
  const railCode = withoutComments(rail)
  const boardCode = withoutComments(board)

  assert.match(railCode, /visible\?:\s*boolean/u)

  // Doutrina do reconciliador (F6.13): nenhum passo depende de entrega única.
  const poll = effectUsing(railCode, ', RAIL_POLL_MS)')
  assert.match(poll, /window\.setInterval\(/u)
  assert.match(poll, /return \(\) => window\.clearInterval\(/u)
  // A CERCA: escondido não mede. O Board fica MONTADO fora da aba e fora do
  // projeto ativo (desmontar mataria as conversas), então sem esta saída
  // antecipada o poll abriria `git` para universo que ninguém está olhando.
  assert.match(poll, /if \(!visible \|\| !docVisible/u)

  const every = constantOf(rail, 'RAIL_POLL_MS')
  assert.ok(every >= 10_000 && every <= 20_000, `o poll precisa ficar em 10–20s (veio ${every}ms)`)

  // Janela minimizada / outro app: o ouvinte entra e SAI (sem a devolução, cada
  // troca de missão deixaria um `visibilitychange` pendurado).
  assert.match(railCode, /document\.addEventListener\('visibilitychange'/u)
  assert.match(railCode, /document\.removeEventListener\('visibilitychange'/u)

  // O Board é a autoridade do "à vista": só ele sabe o projeto ativo e a aba.
  assert.match(boardCode, /visible=\{isActive && uniTab === 'board'\}/u)

  // O GATILHO VELHO FICA: o clique do dono (⇪, arquivar…) continua re-medindo.
  assert.match(railCode, /reloadToken\?:\s*number/u)
  assert.match(boardCode, /reloadToken=\{railReload\}/u)
})

test('medida do trilho é COALESCIDA: uma em voo, e o gatilho de dentro re-roda uma vez', async () => {
  const railCode = withoutComments(
    await source('src/renderer/src/components/MissionDeliveryRail.tsx')
  )

  // Gatilho que chega durante o voo NÃO abre um segundo `git` no mesmo
  // worktree: marca sujo e sai.
  assert.match(railCode, /if \(measuringRef\.current\) \{\s*dirtyRef\.current = true\s*return\s*\}/u)
  // …e quem está no ar re-roda UMA vez, já com o estado de agora.
  assert.match(railCode, /do \{\s*dirtyRef\.current = false/u)
  assert.match(railCode, /\} while \(dirtyRef\.current\)/u)
  // A trava SEMPRE cai — inclusive se a leitura estourar no meio.
  assert.match(railCode, /finally \{\s*measuringRef\.current = false/u)
  // Resposta atrasada da missão ANTERIOR nunca pinta o trilho da atual.
  assert.match(railCode, /missionRef\.current !== id/u)
})

test('re-medir não PISCA: o número fica na tela e o histórico só re-lê quando a branch anda', async () => {
  const rail = await source('src/renderer/src/components/MissionDeliveryRail.tsx')
  const railCode = withoutComments(rail)

  // "medindo o diff…" é estado de PRIMEIRA medida: com número na tela ele nunca
  // volta (o ramo do `summary` vem ANTES do `diffBusy`).
  assert.match(railCode, /summary\s*\?[\s\S]{0,240}?:\s*diffBusy\s*\?/u)

  // Nenhuma medida zera o resumo antes de ter o novo — nem a que falha.
  const start = railCode.indexOf('measuringRef.current = true')
  const end = railCode.indexOf('} while (dirtyRef.current)')
  assert.ok(start > 0 && end > start, 'o laço da medida precisa existir')
  const inFlight = railCode.slice(start, end)
  assert.doesNotMatch(
    inFlight,
    /setSummary\(null\)/u,
    'a medida nova nunca apaga a fotografia boa que já está na tela'
  )
  // Falha passageira do git no poll não derruba o placar: ela desce para a
  // própria linha, marcada como STALE quando já há número na tela (RIGHTDOCK:
  // a mesma verdade, na forma da seção TRABALHO).
  assert.match(rail, /dr-diff-stale/u)
  assert.match(rail, /dr-diff-error\$\{summary \? ' dr-diff-stale'/u)

  // O HISTÓRICO anda pelos MESMOS gatilhos — mas só quando a fotografia da
  // branch MUDA: sem esse portão o poll de 15s fecharia o commit expandido do
  // dono (e a janela de diff aberta) a cada volta, sem novidade nenhuma.
  assert.match(railCode, /function workspaceFingerprint\(/u)
  assert.match(railCode, /setHistoryBump\(\(n\) => n \+ 1\)/u)
  assert.match(railCode, /reloadToken=\{\(reloadToken \?\? 0\) \+ historyBump\}/u)
})

// ————————————————————————————————————————————————————————————————————————
// RODADA 9 (2026-08-19) — O AGENTE É O INTEGRADOR, e o dono VÊ.
//
// Ordem do dono, verbatim: "NÃO pode aparecer modal 'essa missão tá sendo
// integrada': eu preciso VER o que ele tá fazendo no chat." O ⇪ deixou de ser
// um comando executado atrás de um véu — ele AVISA o agente. O que a tela deve,
// então, é ESTADO: onde a missão está na fila e o que está acontecendo com ela
// agora. E cabeça de fila com erro é o AGENTE resolvendo, nunca um "integrando"
// congelado.
// ————————————————————————————————————————————————————————————————————————

test('a fila fala do AGENTE: cabeça com erro é conflito em resolução, nunca "integrando"', async () => {
  const {
    agentHasTheBall,
    agentIsResolving,
    integrationQueueBadge,
    integrationQueueNote,
    integrationShortLine,
    integrationStateWord
  } = await queueVocabulary()

  const head = { state: 'queued', position: 1, total: 3 }
  const conflict = { state: 'queued', position: 1, total: 3, lastError: 'CONFLITO em src/a.ts' }
  const waiting = { state: 'queued', position: 2, total: 3 }
  const merging = { state: 'merging', position: 1, total: 3 }
  const repair = { state: 'blocked', position: 1, total: 2, owner: 'orchestrator' }

  assert.equal(agentHasTheBall(head), true)
  assert.equal(agentHasTheBall(waiting), false)
  assert.equal(agentHasTheBall(merging), false, 'merging é a máquina, não a vez do agente')
  assert.equal(agentIsResolving(conflict), true)
  assert.equal(agentIsResolving(head), false)

  // A cabeça com erro NUNCA se lê como máquina trabalhando: o dono precisa
  // saber que quem está com a mão nela é o AGENTE.
  assert.match(integrationStateWord(conflict), /conflito/u)
  assert.doesNotMatch(integrationStateWord(conflict), /integrando/u)
  assert.match(integrationQueueNote(conflict), /agente/u)
  assert.match(integrationStateWord(head), /agente/u)
  assert.equal(integrationStateWord(merging), 'integrando')
  assert.match(integrationStateWord(waiting), /fila/u)
  assert.match(integrationStateWord(repair), /reparo/u)

  // A linha curta do mapa carrega a ordem quando ela é a notícia.
  assert.equal(integrationShortLine(waiting), 'fila #2/3')
  assert.equal(integrationShortLine(conflict), integrationStateWord(conflict))

  // O selo da coluna só existe onde o vocabulário de sempre não alcança...
  assert.equal(integrationQueueBadge({ mission: { integration: waiting } }), null)
  assert.equal(integrationQueueBadge({ mission: {} }), null)
  assert.equal(integrationQueueBadge({ mission: { integration: conflict } }).kind, 'err')
  assert.match(integrationQueueBadge({ mission: { integration: head } }).glyph, /agente/u)
  // ...e quem espera o DONO vence a fila (esse sinal não é dela).
  assert.equal(
    integrationQueueBadge({ mission: { integration: conflict }, pulse: 'o agente perguntou' }),
    null
  )
  assert.equal(
    integrationQueueBadge({ mission: { integration: head, pendingIntegrationApproval: true } }),
    null
  )
})

test('a FILA DA versão é a ORDEM REAL, com a missão do dono marcada', async () => {
  const { integrationQueueRows } = await queueVocabulary()

  const rows = integrationQueueRows(
    [
      { id: 'm3', title: 'terceira', integration: { state: 'queued', position: 3, total: 3 } },
      { id: 'm1', title: 'primeira', integration: { state: 'merging', position: 1, total: 3 } },
      { id: 'fora', title: 'sem ticket' },
      { id: 'm2', title: 'segunda', integration: { state: 'queued', position: 2, total: 3 } }
    ],
    'm2'
  )

  assert.deepEqual(
    rows.map((row) => row.missionId),
    ['m1', 'm2', 'm3'],
    'a lista tem de sair na ordem REAL da fila, não na ordem do store'
  )
  assert.deepEqual(rows.map((row) => row.mine), [false, true, false])
  assert.deepEqual(rows.map((row) => row.title), ['primeira', 'segunda', 'terceira'])
  assert.equal(rows.length, 3, 'missão sem ticket não entra na fila')
  assert.equal(integrationQueueRows([]).length, 0)
})

test('o ⇪ do trilho vira ESTADO: a fila é desenhada e nenhuma janela interrompe', async () => {
  const [rail, css, mapa] = await Promise.all([
    source('src/renderer/src/components/MissionDeliveryRail.tsx'),
    source('src/renderer/src/global.css'),
    source('src/renderer/src/components/MissionRouteBoard.tsx')
  ])
  const railCode = withoutComments(rail)

  // A ORDEM REAL mora no trilho, debaixo do ⇪ que a produziu.
  assert.match(railCode, /queueRows/u, 'o trilho não recebe a ordem da fila')
  assert.match(railCode, /className="dr-queue-list"/u, 'a FILA DA versão não é desenhada')
  assert.match(railCode, /dr-queue-pos/u, 'a posição de cada missão sumiu da lista')
  assert.match(railCode, /dr-queue-state/u, 'a lista não diz o estado de cada uma')
  assert.match(railCode, /integrationStateWord\(/u)
  assert.match(railCode, /integrationQueueNote\(/u)
  assert.match(railCode, /row\.mine/u, 'a missão do dono precisa se achar na fila')

  // Nenhum gesto do trilho abre diálogo/overlay — o ⇪ é o mais tentado deles.
  assert.doesNotMatch(railCode, /window\.(confirm|alert)\(/u)
  assert.doesNotMatch(railCode, /integrating-overlay|integrating-card/u)

  // O MOVIMENTO é o que o app JÁ tem: a fila não inventa animação nova.
  assert.match(
    css,
    /\.dr-queue-dot\.working\s*\{[^}]*animation: tb-status-pulse/su,
    'o pulso de "trabalhando" tem de reusar o keyframe da casa'
  )
  assert.match(css, /\.dr-queue-list\s*\{/u, 'a fila do trilho não tem roupa')

  // O mapa lê o MESMO vocabulário — a mesma missão não pode ter duas verdades.
  assert.match(mapa, /integrationShortLine/u, 'o quadro de rotas ficou com dialeto próprio')
})

// ————— RIGHTDOCK (2026-08-22) — o mockup aprovado é o contrato —————
//
// O dono aprovou verbatim docs/mockups/rightdock.html: o lado direito vira o
// RAIO-X DA MISSÃO — moldura única (cabeçalho "missão · título" + grip), três
// seções recolhíveis (ENTREGA · TRABALHO · FROTA) com resumo à direita do
// título; geral e release vestem a mesma moldura. Nada de maquinário novo:
// medidas vivas, fila, história e lateral são os de sempre, recompostos.

test('RIGHTDOCK — a moldura: dock-head + três seções com resumo', async () => {
  const rail = await source('src/renderer/src/components/MissionDeliveryRail.tsx')
  assert.match(rail, /DockSection/u, 'o primitivo de seção recolhível existe e o trilho o consome')
  assert.match(rail, /dock-head/u, 'o cabeçalho da moldura diz onde o dono está')
  assert.match(rail, /title="entrega"|title=\{?'entrega'/u, 'a seção ENTREGA existe')
  assert.match(rail, /title="trabalho"|title=\{?'trabalho'/u, 'a seção TRABALHO existe')
  assert.match(rail, /title="frota"|title=\{?'frota'/u, 'a seção FROTA existe')

  const section = await source('src/renderer/src/components/DockSection.tsx')
  assert.match(section, /aria-expanded/u, 'recolher é botão de verdade, com estado acessível')
  assert.match(section, /localStorage/u, 'o colapso persiste — o dock lembra como o dono o deixou')

  const css = await source('src/renderer/src/global.css')
  assert.match(css, /\.dock-head \{/u)
  assert.match(css, /\.dock-sec-head \{/u)
})

test('RIGHTDOCK — trabalho: ± por arquivo, e o motor do diff por arquivo de pé', async () => {
  const wt = await source('src/main/worktree.ts')
  const summary = wt.slice(wt.indexOf('export function missionWorkspaceSummary'))
  assert.match(
    summary.slice(0, 2600),
    /insertions: .*deletions: /su,
    'o numstat que já era lido agora fica POR ARQUIVO (antes era jogado fora)'
  )

  const ipc = await source('src/main/ipc/missions.ts')
  assert.match(ipc, /missions:workspaceFileDiff/u, 'o diff por arquivo ganhou canal')

  const bridgeSrc = await source('src/renderer/src/missionWorkspace.ts')
  assert.match(bridgeSrc, /fileDiff/u, 'a ponte tipada expõe o diff por arquivo')

  // O GESTO mudou de dono na rodada 2 (bloco no fim do arquivo): a linha LÊ o
  // documento e o ±placar abre o diff na janela larga. O que fica prendido
  // aqui é o motor — o canal e a ponte que as duas portas consomem.
  const rail = await source('src/renderer/src/components/MissionDeliveryRail.tsx')
  assert.match(rail, /missionWorkspace\.fileDiff\(/u, 'o trilho parou de consumir o diff por arquivo')
})

// ————— RIGHTDOCK ONDA B (2026-08-22) — o release veste a moldura —————
//
// A Onda A recompôs a missão; esta onda vestiu o RELEASE: a seção "última
// subida" lê a entidade R27F2 por projeto (`backlog:projectReleases`). O
// terceiro estado do mockup (retrato compacto no ✦ geral) foi ENTREGUE e
// REPROVADO pelo dono na mesma noite — o ProjectDashboard voltou (lápide no
// fim do arquivo). Nenhum dado inventado: os retratos leem o releasesStore,
// e a linha compacta NUNCA afirma além do que o registro prova.

const releasePresentation = () => import('../src/renderer/src/releaseRailPresentation.ts')

/** Um registro de subida como o releasesStore o grava (espelho do fixture da
 *  aba Versões: mesma entidade, recorte por projeto). */
const releaseRecord = (over = {}) => ({
  id: 'r1',
  projectId: 'p1',
  versionId: 'v1',
  versionName: 'V1.0.5',
  at: '2026-08-21T17:15:00.000Z',
  actor: 'agente',
  mergeDetail: 'merge --no-ff limpo',
  push: { attempted: true, ok: true },
  publishRequired: false,
  outcome: 'subiu redonda; push ok.',
  ...over
})

test('RIGHTDOCK B — a linha do retrato fala a verdade do dado, nunca além dele', async () => {
  const { releasePortraitLine, releasePushWord } = await releasePresentation()

  // O push tem TRÊS desfechos reais — e "sem remoto" não pode virar silêncio
  // nem virar falha: o projeto sem GitHub sobe local de propósito.
  assert.equal(releasePushWord({ attempted: true, ok: true }), 'push ok')
  assert.equal(releasePushWord({ attempted: true, ok: false }), 'push falhou')
  assert.equal(releasePushWord({ attempted: false }), 'sem remoto')

  // A linha inteira: ⇪ nome · dia/hora · push. A hora é a LOCAL da máquina do
  // dono (mesma régua do toLocaleString da aba Versões) — o teste prende a
  // FORMA, não o fuso.
  assert.match(
    releasePortraitLine(releaseRecord()),
    /^⇧ V1\.0\.5 · \d{2}\/\d{2} \d{2}:\d{2} · push ok$/u
  )

  // `publishRequired` declara que o produto TEM pipeline de caixa — o registro
  // não prova publicação. A linha diz a receita, nunca "caixa publicada".
  const comCaixa = releasePortraitLine(releaseRecord({ publishRequired: true }))
  assert.match(comCaixa, /· caixa \(npm run release\)$/u)
  assert.doesNotMatch(comCaixa, /caixa publicada/u)

  // Bump que FALHOU é notícia; bump que alinhou é redundante com o nome.
  assert.match(
    releasePortraitLine(releaseRecord({ bump: { version: '1.0.5', committed: false } })),
    /manifesto não alinhado/u
  )
  assert.doesNotMatch(
    releasePortraitLine(releaseRecord({ bump: { version: '1.0.5', committed: true } })),
    /manifesto/u
  )

  // Data ilegível não vira "Invalid Date" na tela: a linha sai sem o pedaço.
  assert.equal(releasePortraitLine(releaseRecord({ at: 'ontem' })), '⇧ V1.0.5 · push ok')
})

test('RIGHTDOCK B — o release veste a moldura: dock-head + a subida + última subida', async () => {
  const rail = await source('src/renderer/src/components/ReleaseRail.tsx')
  assert.match(rail, /dock-head/u, 'a moldura diz onde o dono está')
  assert.match(rail, /DockSection/u, 'as seções são o primitivo da casa')
  assert.match(rail, /title="a subida"/u)
  assert.match(rail, /title="última subida"/u)
  assert.match(rail, /release_run/u, 'a nota continua nomeando a RECEITA da subida')
  assert.match(rail, /releasePortraitLine/u, 'a linha compacta vem do módulo puro')
  // A metade main chega SÓ no restart: sem a ponte, a seção degrada com a
  // receita em vez de virar beco mudo — e sem subida nenhuma ela nem nasce.
  assert.match(rail, /projectReleases/u)
  assert.match(rail, /reinicie o app/u)
  // Re-derivável: o retrato assina o backlog:changed do projeto (o fecho do
  // release re-pinta sem gesto novo do dono).
  assert.match(rail, /onChanged/u)

  const board = await source('src/renderer/src/components/Board.tsx')
  assert.match(board, /<ReleaseRail/u, 'o Board consome o componente novo')
  assert.doesNotMatch(
    board,
    /release-rail-head/u,
    'o cabeçalho cru da R27 saiu — a moldura agora é o dock'
  )
})

// O teste do "DockGeneral" (retrato compacto no ✦ geral) morreu em 22/08 à
// noite: o dono REPROVOU a troca da página geral ("tava ótima e você mexeu —
// o combinado era mexer só na parte direita"). O ProjectDashboard voltou; a
// Onda B do RIGHTDOCK ficou sendo SÓ o ReleaseRail (acima) — o ✦ geral é
// prendido pelo test-project-landing, como sempre foi.

test('conflito avisa UMA vez, na língua do dono — a receita técnica mora na dica', async () => {
  const rail = await source('src/renderer/src/components/MissionDeliveryRail.tsx')
  const code = withoutComments(rail)

  // Pedido do dono (22/08, print do conflito ao vivo): a nota da fila já diz
  // "conflito na subida — o agente está resolvendo…"; a SEGUNDA linha (o
  // lastError cru do motor, com "merge da base" e lista de arquivos) era o
  // mesmo fato em dialeto técnico, empilhado. Ela não renderiza mais.
  assert.doesNotMatch(code, /dr-conflict/u, 'o aviso técnico duplicado voltou à entrega')
  // …mas NÃO virou beco: o detalhe continua a um hover, na dica do próprio ⇪
  // (e o AGENTE segue recebendo a receita pelo canal dele, não pela tela).
  assert.match(code, /data-tip=\{integration\.lastError \?\? queueLabel\}/u)
  // A nota da fila — o aviso que FICA — continua de pé.
  assert.match(code, /className="dr-queue"/u)

  const css = await source('src/renderer/src/global.css')
  assert.doesNotMatch(css, /^\.dr-conflict\s*\{/mu, 'a regra órfã sai junto')
})

test('RIGHTDOCK — o HISTÓRICO rola dentro da seção, com a barra retrô da casa', async () => {
  const css = await source('src/renderer/src/global.css')

  // Pedido do dono (22/08, print de 11 commits sem barra): as listas do dock
  // têm TETO e rolam por dentro — como o TRABALHO (.dr-files) já faz. O scroll
  // mora no SHELL do grafo: o SVG das arestas é filho absoluto dele, então as
  // linhas rolam JUNTO com os commits e o desenho nunca desalinha.
  const shell = css.match(/\n\.mh-graph-shell \{([\s\S]*?)\n\}/u)?.[1]
  assert.ok(shell, 'a regra do shell do grafo precisa existir')
  assert.match(shell, /max-height:\s*\d+px/u, 'sem teto o histórico cresce infinito')
  assert.match(shell, /overflow-y:\s*auto/u, 'o excesso rola por dentro da seção')
  // `scrollbar-width` (thin/none) SUPRIME a barra ::-webkit-scrollbar no
  // Chromium — foi exatamente o que escondeu a barra da frota. Aqui, nunca.
  assert.doesNotMatch(shell, /scrollbar-width/u, 'a barra retrô da casa é a barra')
  // E a CALHA fica: o dono viu o card do commit COLADO na barra ("tá muito
  // colado") — o respiro entre conteúdo e barra é parte do pedido.
  const gutter = Number(shell.match(/padding-right:\s*(\d+)px/u)?.[1])
  assert.ok(gutter >= 8, `o respiro até a barra precisa existir (veio ${gutter}px)`)
})

// ————— O CONSERTO DO DOCK (2026-08-22, noite — o dono viu ao vivo) —————
//
// No restart a fileira de ações apareceu ESMAGADA: `.dr-btn { width: 100% }`,
// relíquia do trilho em COLUNA, dava basis 100% a cada ícone dentro da fileira
// `.dock-acts`; o ⇪ (basis 0, sem encolher) sobrava com ~30px e virava uma
// COLUNA DE LETRAS. Com ele vieram três ruídos que a onda A entregou sem
// nunca olhar a tela: o ⇪ de contorno accent no lugar da tinta cheia do
// mockup, o chip "↑0 À FRENTE" que não dizia nada e o cabeçalho do histórico
// repetindo o título que a própria seção já dá.
//
// As cinco cercas abaixo são o conserto — todas reprovavam no código que o
// dono viu na tela.

/** O CORPO de uma regra CSS, recortado pelo seletor EXATO. Cerca de CSS escrita
 *  com `[\s\S]*?` sobre o arquivo inteiro acha a declaração de QUALQUER regra
 *  vizinha e aprova o que devia reprovar. */
function cssRule(css, selector) {
  const head = `\n${selector} {`
  const at = css.indexOf(head)
  assert.ok(at >= 0, `a regra ${selector} precisa existir`)
  const body = css.slice(at + head.length)
  const end = body.indexOf('\n}')
  assert.ok(end > 0, `a regra ${selector} não fecha`)
  return body.slice(0, end)
}

/** O corpo de uma função de MÓDULO, recortado pelo nome: a tabela-verdade fica
 *  presa à função que a implementa, nunca a uma varredura do arquivo. */
function functionIn(src, name) {
  const at = src.indexOf(`function ${name}(`)
  assert.ok(at > 0, `a função ${name} precisa existir`)
  const end = src.indexOf('\n}', at)
  assert.ok(end > at, `a função ${name} não fecha`)
  return src.slice(at, end)
}

/** O abre-tag de um elemento do JSX, achado pela classe que ele veste. */
function tagWith(src, needle, tail = 200) {
  const at = src.indexOf(needle)
  assert.ok(at > 0, `${needle} não foi encontrado`)
  const start = src.lastIndexOf('<', at)
  assert.ok(start >= 0, `${needle} precisa morar dentro de uma tag`)
  return src.slice(start, at + tail)
}

test('CONSERTO — a fileira de ações desfaz a largura do trilho em COLUNA', async () => {
  const css = await source('src/renderer/src/global.css')

  // A regra BASE fica de pé: os botões EMPILHADOS do planejamento (concluir,
  // arquivar, reativar) continuam ocupando a linha inteira.
  assert.match(
    cssRule(css, '.dr-btn'),
    /width:\s*100%/u,
    'os botões em coluna do planejamento perderam a largura'
  )

  // ...e a FILEIRA a desfaz: o ícone abraça o glifo, o primário estica.
  assert.match(
    cssRule(css, '.dock-acts .dr-btn'),
    /width:\s*auto/u,
    'dentro da fileira o botão herda 100% e esmaga o ⇪ — o bug que o dono viu'
  )
  assert.match(cssRule(css, '.dock-acts .btn.dock-primary'), /flex:\s*1/u)
  // Trilho estreito (176px é o piso) não cospe ícone para fora da moldura.
  assert.match(cssRule(css, '.dock-acts'), /flex-wrap:\s*wrap/u)
})

test('CONSERTO — o ⇪ primário veste a tinta cheia do mockup aprovado', async () => {
  const [css, mockup] = await Promise.all([
    source('src/renderer/src/global.css'),
    source('docs/mockups/rightdock.html')
  ])

  // O contrato lido do PRÓPRIO mockup — ele é a lei da composição.
  const contract = mockup.match(/\.btn\.primary \{([^}]*)\}/u)?.[1]
  assert.ok(contract, 'o mockup precisa continuar declarando o botão primário')
  assert.match(contract, /background:\s*var\(--ink\)/u)
  assert.match(contract, /color:\s*var\(--paper\)/u)

  const primary = cssRule(css, '.dock-acts .btn.dock-primary')
  assert.match(primary, /background:\s*var\(--ink\)/u, 'o ⇪ segue de contorno, não de tinta cheia')
  assert.match(primary, /color:\s*var\(--paper\)/u)
  // Tinta cheia precisa de hover PRÓPRIO: o `.btn:hover` da casa pinta ink em
  // cima de ink e o gesto não teria retorno nenhum.
  assert.match(css, /\.dock-acts \.btn\.dock-primary:hover/u)
  // O contorno accent do trilho antigo não sobrevive ao lado do novo.
  assert.doesNotMatch(css, /\.dr-integrate\s*\{/u)

  // A porteira mecânica continua GRITANDO no vocabulário da casa: anel no
  // acento pulsando com o `perm-pulse` que o app já usa.
  const pending = cssRule(css, '.dock-acts .btn.dock-primary.approve-pending')
  assert.match(pending, /var\(--accent\)/u)
  assert.match(pending, /animation:\s*perm-pulse/u)

  // Desabilitado NÃO é rótulo apagado: ali o texto é ESTADO (a fila, o agente
  // com a bola) e o dono precisa conseguir lê-lo.
  const off = cssRule(css, '.dock-acts .btn.dock-primary:disabled')
  assert.match(off, /color:\s*var\(--ink-2\)/u)
  assert.match(off, /background:\s*transparent/u)
})

test('CONSERTO — o chip da entrega só fala quando tem o que dizer', async () => {
  const [rail, css] = await Promise.all([
    source('src/renderer/src/components/MissionDeliveryRail.tsx'),
    source('src/renderer/src/global.css')
  ])
  const railCode = withoutComments(rail)

  // O bug: o chip nascia com QUALQUER resumo, e o dono leu "↑0 À FRENTE" —
  // uma linha que não informava nada.
  assert.doesNotMatch(
    railCode,
    /↑\{summary\.ahead\}/u,
    'o chip incondicional voltou: com ahead=0 ele é ruído puro'
  )

  // A tabela-verdade mora numa função PURA, legível de uma vez só.
  const chip = functionIn(rail, 'deliveryChip')
  assert.match(chip, /ahead > 0/u, 'commit à frente ⇒ o placar')
  assert.match(chip, /à frente/u)
  assert.match(chip, /files\.length === 0/u, 'nada à frente e nada mexido ⇒ árvore limpa')
  assert.match(chip, /árvore limpa/u, 'o ok do mockup sumiu da tabela')
  assert.match(chip, /dock-chip ok/u)
  // O terceiro ramo é o SILÊNCIO: mexida sem commit já aparece em TRABALHO.
  assert.match(
    chip,
    /files\.length === 0[\s\S]*?return null/u,
    'mexida sem commit tem de sair SEM chip'
  )

  // ...e o JSX não decide nada por fora dela.
  assert.match(railCode, /deliveryChip\(summary/u)

  // O ok do mockup tem roupa própria (`.chip.ok` = borda e texto no --ok).
  assert.match(cssRule(css, '.dock-chip.ok'), /color:\s*var\(--ok\)/u)
})

test('CONSERTO — o histórico não repete o título que a seção já deu', async () => {
  const [history, rail, css] = await Promise.all([
    source('src/renderer/src/components/MissionCommitHistory.tsx'),
    source('src/renderer/src/components/MissionDeliveryRail.tsx'),
    source('src/renderer/src/global.css')
  ])

  // A DockSection "histórico" já traz título E contagem; o cabeçalho interno
  // desenhava os dois de novo, uma linha abaixo.
  assert.match(rail, /title="histórico"/u, 'a seção continua sendo a dona do título')
  assert.doesNotMatch(history, /histórico da missão/u, 'o título duplicado voltou')
  assert.doesNotMatch(history, /mh-history-head|mh-history-title/u)
  assert.doesNotMatch(css, /\.mh-history-title\s*\{/u, 'a roupa do cabeçalho morto ficou pendurada')
  assert.doesNotMatch(css, /\.mh-history-head\s*\{/u)

  // A PROMESSA fica dita NA superfície (dica discreta), nunca vira letra morta.
  assert.ok(
    /data-tip="[^"]*somente leitura[^"]*"/u.test(history),
    'a promessa de "somente leitura" precisa continuar dita aqui'
  )
  // ...e o gesto que abre a janela larga segue existindo.
  assert.match(history, /⤢ abrir diff/u)
})

test('CONSERTO — a base com UUID corta na moldura e guarda o valor inteiro na dica', async () => {
  const [rail, css] = await Promise.all([
    source('src/renderer/src/components/MissionDeliveryRail.tsx'),
    source('src/renderer/src/global.css')
  ])

  // `base: version/5e846dd0-…-0b1e9eb12357` não cabe num trilho de 176px.
  const base = cssRule(css, '.dr-base')
  assert.match(base, /min-width:\s*0/u)
  assert.match(base, /overflow:\s*hidden/u)
  assert.match(base, /text-overflow:\s*ellipsis/u)
  assert.match(base, /white-space:\s*nowrap/u)

  // Cortar sem ESCONDER: o valor inteiro vai para a dica.
  const span = tagWith(rail, 'className="dr-base"')
  assert.match(span, /data-tip=/u, 'a base cortada precisa dizer o valor inteiro na dica')
  assert.match(span, /mission\.baseBranch/u)
})

// ————— RODADA 2 DO DOCK (2026-08-22, noite) — docs/mockups/rightdock-2.html —
//
// O dono escolheu o HEADER V1 (duas linhas) e mandou junto duas ordens faladas:
// o › de recolher vira ÍCONE DE PAINEL sentado na linha 1, e o clique num
// arquivo do TRABALHO passa a ABRIR O DOCUMENTO — o diff mudou de porta (mora
// no ±placar e abre na janela larga do histórico), depois de ele clicar num
// `.md` e receber uma caixa preta ilegível. Com isso morreram o diff inline, o
// duplo clique e o ▷ terminal comum ("o único que tem necessidade é o de
// teste"). O mockup é a LEI da composição: os contratos abaixo são lidos dele.

const dock2 = () => source('docs/mockups/rightdock-2.html')

test('RODADA 2 — o header tem DUAS linhas: o tipo em cima, o título inteiro embaixo', async () => {
  const [rail, release, css, mockup] = await Promise.all([
    source('src/renderer/src/components/MissionDeliveryRail.tsx'),
    source('src/renderer/src/components/ReleaseRail.tsx'),
    source('src/renderer/src/global.css'),
    dock2()
  ])
  const railCode = withoutComments(rail)

  // O CONTRATO LIDO DO PRÓPRIO MOCKUP (V1 = a variação escolhida).
  const l1 = mockup.match(/\.head2 \.l1 \{([^}]*)\}/u)?.[1]
  const t2 = mockup.match(/\.head2 \.title \{([^}]*)\}/u)?.[1]
  assert.ok(l1 && t2, 'o mockup precisa continuar declarando o header V1')
  assert.match(l1, /font-size:\s*10px/u)
  assert.match(l1, /letter-spacing:\s*\.16em/u)
  assert.match(t2, /font-size:\s*12\.5px/u)
  assert.match(t2, /font-weight:\s*700/u)

  // ...e a implementação o veste: a moldura EMPILHA as duas linhas.
  assert.match(cssRule(css, '.dock-head'), /flex-direction:\s*column/u, 'o header voltou a ser de uma linha só')
  const line1 = cssRule(css, '.dock-head-l1')
  assert.match(line1, /font-size:\s*10px/u)
  assert.match(line1, /letter-spacing:\s*0\.16em/u)
  assert.match(line1, /text-transform:\s*uppercase/u)
  const line2 = cssRule(css, '.dock-head-title')
  assert.match(line2, /font-size:\s*12\.5px/u)
  assert.match(line2, /font-weight:\s*700/u)
  assert.match(line2, /text-overflow:\s*ellipsis/u)
  assert.doesNotMatch(line2, /text-transform/u, 'o TÍTULO não é caixa alta — só a linha 1 é')

  // As duas molduras (missão e release) vestem a mesma linha 1, e o título
  // cortado guarda o valor inteiro na dica.
  for (const [nome, src] of [
    ['missão', rail],
    ['release', release]
  ]) {
    assert.match(src, /className="dock-head-l1"/u, `${nome}: a linha 1 do header sumiu`)
    assert.match(
      tagWith(src, 'className="dock-head-title"'),
      /data-tip=/u,
      `${nome}: o título cortado precisa dizer o inteiro na dica`
    )
  }
  assert.match(release, /dock-head-kind">release/u, 'o release perdeu o TIPO na linha 1')
  assert.match(release, /dock-head-title" data-tip=\{versionName/u, 'a linha 2 do release é a versão')

  // O ⋮⋮ continua sendo o pega de largura, agora empurrado na linha 1.
  assert.match(railCode, /className="dock-grip"/u)
  assert.match(cssRule(css, '.dock-grip'), /margin-left:\s*auto/u)
})

test('RODADA 2 — só o estado-NOTÍCIA entra no header; "em andamento" nunca', async () => {
  const [rail, css] = await Promise.all([
    source('src/renderer/src/components/MissionDeliveryRail.tsx'),
    source('src/renderer/src/global.css')
  ])
  const railCode = withoutComments(rail)

  // O CHIP BORDADO morreu: era ele que quebrava em duas linhas no trilho
  // estreito — o que o dono chamou de feio.
  assert.doesNotMatch(railCode, /dr-status/u, 'a pastilha bordada do status voltou ao header')

  // O padrão é SILÊNCIO: a coluna e a seção ENTREGA já contam que a missão anda.
  assert.match(
    railCode,
    /mission\.status === 'ativa'\s*\?\s*null/u,
    '"em andamento" é o estado padrão: ele nunca vira palavra no header'
  )
  // A palavra vem do vocabulário ÚNICO da casa, nunca de uma tabela nova aqui.
  assert.match(railCode, /STATUS_LABEL\[mission\.status\]/u)
  const { MISSION_STATUS_LABEL } = await import('../src/renderer/src/missionPresentation.ts')
  assert.equal(MISSION_STATUS_LABEL.ativa, 'em andamento')
  assert.equal(MISSION_STATUS_LABEL.integrando, 'integrando agora')
  assert.equal(MISSION_STATUS_LABEL.concluida, 'integrada')
  assert.equal(MISSION_STATUS_LABEL.arquivada, 'arquivada')

  // PALAVRA, não pastilha: sem borda; a cor diz qual das três notícias é.
  const word = cssRule(css, '.dock-head-state')
  assert.doesNotMatch(word, /border/u, 'a palavra de estado virou chip de novo')
  assert.match(cssRule(css, '.dock-head-state.integrando'), /var\(--accent\)/u)
  assert.match(cssRule(css, '.dock-head-state.concluida'), /var\(--ok\)/u)
  assert.match(cssRule(css, '.dock-head-state.arquivada'), /var\(--ink-3\)/u)
})

test('RODADA 2 — o recolher virou ÍCONE DE PAINEL, sentado na linha 1', async () => {
  const [component, css] = await Promise.all([
    source('src/renderer/src/components/ResizableRightRail.tsx'),
    source('src/renderer/src/global.css')
  ])

  // O chevron morreu: ele dizia uma DIREÇÃO, nunca o painel de que se trata.
  assert.doesNotMatch(component, /m10 3\.75-4 4\.25/u, 'o chevron antigo voltou')
  assert.doesNotMatch(component, /m6 3\.75 4 4\.25/u)

  // A FORMA carrega o estado (régua da casa): moldura + divisória interna, com
  // a fatia da direita PINTADA enquanto o trilho está aberto e OCA quando fecha.
  assert.match(component, /<rect/u, 'a moldura do painel sumiu do ícone')
  assert.match(
    component,
    /!preference\.collapsed && \(?\s*<(?:path|rect)[^>]*right-rail-toggle-pane/u,
    'a fatia cheia precisa depender do estado — sem isso a forma não diz nada'
  )
  assert.match(
    css,
    /\.right-rail-toggle svg \.right-rail-toggle-pane\s*\{[\s\S]*?fill:\s*currentColor/u,
    'a fatia do painel ficou sem tinta (o svg herda fill: none)'
  )

  // GHOST: o anel de contorno saiu (ele flutuava como um botão por cima do
  // texto) e o hover é TINTA. A caixa desce para a altura da linha 1.
  const toggle = cssRule(css, '.right-rail-toggle')
  assert.match(toggle, /border:\s*0/u, 'o anel de contorno do botão voltou')
  assert.match(toggle, /top:\s*7px/u, 'o botão precisa sentar na linha 1 do header')
  assert.match(cssRule(css, '.right-rail-toggle:hover'), /color:\s*var\(--ink\)/u)
  // ...e o ⋮⋮ do header não pode acabar DEBAIXO dele.
  assert.match(
    css,
    /\.right-rail-content > \.dock > \.dock-head > \.dock-head-l1\s*\{[\s\S]*?padding-right:/u,
    'a linha 1 precisa do respiro do botão flutuante'
  )

  // O contrato de acessibilidade não se mexe.
  assert.match(component, /aria-expanded=\{!preference\.collapsed\}/u)
  assert.match(component, /aria-label=\{preference\.collapsed \?/u)
  assert.match(component, /data-tip=\{preference\.collapsed \?/u)
  assert.match(css, /\.right-rail-toggle:focus-visible/u)
})

test('RODADA 2 — a ENTREGA é composta: branch e chip na MESMA linha, base e ◈ na fina', async () => {
  const [rail, css, mockup] = await Promise.all([
    source('src/renderer/src/components/MissionDeliveryRail.tsx'),
    source('src/renderer/src/global.css'),
    dock2()
  ])
  const railCode = withoutComments(rail)

  // Contrato do mockup: o chip é EMPURRADO para a direita, na mesma fileira —
  // é o que matou a sobra que o dono viu.
  const chip = mockup.match(/\n {2}\.chip \{([^}]*)\}/u)?.[1]
  assert.ok(chip, 'o mockup precisa continuar declarando o chip da entrega')
  assert.match(chip, /margin-left:\s*auto/u)
  assert.match(chip, /flex:\s*none/u)

  // A fileira ganhou CLASSE PRÓPRIA: `.dr-facts` é a coluna do PLANEJAMENTO, e
  // torcê-la quebraria a única linha daquela caixa.
  assert.match(railCode, /className="dr-row"/u, 'a fileira da entrega não existe')
  assert.doesNotMatch(
    railCode,
    /className="dr-facts"/u,
    'a entrega voltou a torcer a classe compartilhada do planejamento'
  )
  assert.match(railCode, /dr-facts dr-planning/u, 'o planejamento perdeu a coluna dele')
  const row = cssRule(css, '.dr-row')
  assert.match(row, /display:\s*flex/u)
  assert.match(row, /align-items:\s*center/u)
  assert.match(row, /font-size:\s*11\.5px/u)
  const rowChip = cssRule(css, '.dr-row .dock-chip')
  assert.match(rowChip, /margin-left:\s*auto/u)
  assert.match(rowChip, /flex:\s*none/u)

  // A LINHA FINA: base cortada pelo MEIO (as duas pontas identificam o valor) e
  // ◈ versão preso na direita.
  assert.match(railCode, /className="dr-fine"/u)
  assert.match(
    railCode,
    /ellipsizeMiddle\(mission\.baseBranch/u,
    'a base perdeu o corte pelo meio (o CSS só sabe cortar a ponta)'
  )
  assert.match(railCode, /from '\.\.\/guiDiffPresentation'/u)
  const fine = cssRule(css, '.dr-fine')
  assert.match(fine, /font-size:\s*10\.5px/u)
  assert.match(fine, /min-width:\s*0/u)
  const ver = cssRule(css, '.dr-version')
  assert.match(ver, /margin-left:\s*auto/u)
  assert.match(ver, /flex:\s*none/u)
})

test('RODADA 2 — TRABALHO: o clique LÊ o documento; o ±placar abre a janela larga', async () => {
  const [rail, viewer, css, mockup] = await Promise.all([
    source('src/renderer/src/components/MissionDeliveryRail.tsx'),
    source('src/renderer/src/components/MissionCommitDiffViewer.tsx'),
    source('src/renderer/src/global.css'),
    dock2()
  ])
  const railCode = withoutComments(rail)

  // O GESTO QUE O DONO FEZ: clicar no documento abre o DOCUMENTO, no leitor de
  // papel — não uma caixa preta de diff dentro de uma coluna de 200px.
  const line = buttonWith(railCode, 'className={`dr-file')
  assert.match(line, /setReader\(file\.path\)/u, 'o clique na linha não lê mais o arquivo')
  assert.doesNotMatch(railCode, /onDoubleClick/u, 'o duplo clique morreu — o clique simples lê')

  // O quadradinho preto morreu INTEIRO: estado, JSX e roupa.
  assert.doesNotMatch(railCode, /inlineDiff/u, 'o diff inline voltou ao trilho')
  assert.doesNotMatch(css, /\.dr-inline-diff/u, 'a roupa do diff inline ficou pendurada')
  assert.doesNotMatch(css, /\.dr-inline-trunc/u)

  // A PORTA do diff é o ±placar — e ela abre a MESMA janela larga do histórico.
  const delta = buttonWith(railCode, 'className="dr-file-delta"')
  assert.match(delta, /openFilePatch\(/u, 'o ± precisa ser o botão que abre o diff')
  assert.match(railCode, /parseCommitDiff\(/u, 'o patch vira ESTRUTURA antes de virar pixel')
  assert.match(railCode, /<MissionCommitDiffViewer/u, 'o diff do arquivo não abre na janela larga')

  // ...e a janela larga aprendeu a moldura do ARQUIVO sem perder a do commit.
  assert.match(viewer, /file\?:/u, 'a janela não aceita a variante de arquivo do worktree')
  assert.match(viewer, /commit\?:/u, 'a variante commit precisa continuar existindo')
  assert.doesNotMatch(viewer, /window\.synkora/u, 'a janela continua só DESENHANDO')

  // Apagado nesta branch não tem o que LER (o diff continua existindo): o gesto
  // de leitura fica desarmado e a dica diz por quê.
  assert.match(railCode, /aria-disabled=\{!openable\}/u)
  assert.match(line, /não há arquivo para ler/u)

  // O ± PARECE alavanca — é o hover do placar no mockup.
  const contract = mockup.match(/\.file \.delta:hover \{([^}]*)\}/u)?.[1]
  assert.ok(contract, 'o mockup precisa continuar declarando o hover do placar')
  assert.match(cssRule(css, '.dr-file-delta:hover'), /background|border-color/u)
  assert.match(cssRule(css, '.dr-file-delta'), /cursor:\s*pointer/u)
})

test('RODADA 2 — o ▷ terminal comum MORREU; só o ▶ de teste fica', async () => {
  const [rail, board] = await Promise.all([
    source('src/renderer/src/components/MissionDeliveryRail.tsx'),
    source('src/renderer/src/components/Board.tsx')
  ])
  const railCode = withoutComments(rail)
  const boardCode = withoutComments(board)

  assert.doesNotMatch(railCode, /onTerminal/u, 'a prop do terminal comum ficou pendurada no trilho')
  assert.doesNotMatch(railCode, /shellAvailable/u)
  assert.doesNotMatch(railCode, /Terminal comum/u)
  assert.doesNotMatch(boardCode, /missionShell/u, 'o Board ainda carrega a ponte do terminal comum')
  assert.doesNotMatch(boardCode, /openMissionShell/u)

  // "O único que tem necessidade é o terminal de teste": o ▶ fica intacto, com
  // o ■ de derrubar e as mesmas dicas.
  assert.match(railCode, /onTestServer/u)
  assert.match(railCode, /onKillTestServer/u)
  assert.match(railCode, /Terminal de teste/u)
})
