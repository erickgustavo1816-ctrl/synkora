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

  assert.match(button, /🧐 revisar/u)
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
  // própria linha, abaixo dos números.
  assert.match(rail, /dr-diff-stale/u)
  assert.match(rail, /\{summary && diffError &&/u)

  // O HISTÓRICO anda pelos MESMOS gatilhos — mas só quando a fotografia da
  // branch MUDA: sem esse portão o poll de 15s fecharia o commit expandido do
  // dono (e a janela de diff aberta) a cada volta, sem novidade nenhuma.
  assert.match(railCode, /function workspaceFingerprint\(/u)
  assert.match(railCode, /setHistoryBump\(\(n\) => n \+ 1\)/u)
  assert.match(railCode, /reloadToken=\{\(reloadToken \?\? 0\) \+ historyBump\}/u)
})
