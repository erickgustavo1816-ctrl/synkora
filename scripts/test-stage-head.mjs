import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// ————— A CABEÇA DO PALCO EM UMA FILEIRA (ordem do dono, 2026-09-08) —————
//
// "Tem muita informação e tá tudo muito feio/bagunçado. A única coisa que
// gosto daí são os botões." Eram TRÊS fileiras (pílula · linha-meta com
// papel/conta/modelo/effort/⎇ · cabeçalho próprio do GuiPane repetindo tudo).
// Ficou UMA: lateral · pílulas · estado do turno · chip da conta · botões.
// Modelo e effort moram no composer; a branch mora no trilho de entrega.
// Mockup aprovado com o CSS real em scripts/harness/stage-head.html.

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** o bloco da PRIMEIRA regra cujo seletor é exatamente `selector` */
function rule(css, selector) {
  const start = css.indexOf(`\n${selector} {`)
  assert.notEqual(start, -1, `regra ${selector} não existe`)
  return css.slice(start, css.indexOf('}', start) + 1)
}

test('a cabeça do palco é UMA fileira: sem linha-meta e sem cabeçalho próprio do chat', () => {
  const head = read('../src/renderer/src/components/MissionStageHead.tsx')
  const board = read('../src/renderer/src/components/Board.tsx')
  const pane = read('../src/renderer/src/components/GuiPane.tsx')
  const css = read('../src/renderer/src/global.css')
  const workspaceCss = read('../src/renderer/src/workspace/workspacePanels.css')

  assert.doesNotMatch(head, /stage-meta/u, 'a linha-meta morreu com o header antigo')
  assert.match(head, /className="stage-trail"/u, 'o que fica à direita mora no trail')
  assert.doesNotMatch(board, /stageMetaParts|stage-branch|sm-role|missionCopied/u)
  assert.match(board, /showHeader=\{false\}/u, 'o GuiPane no palco não abre cabeçalho próprio')
  assert.match(board, /<StageRoundStatus\b/u, 'o estado do turno é do Board (ele conhece o pane em foco)')
  assert.match(board, /<StageSeatChip\b/u, 'a conta da conversa vive na cabeça do palco')
  assert.doesNotMatch(pane, /gui-head-seat-btn|gui-head-status|gui-head-round/u, 'o GuiPane não troca conta nem narra estado no seu cabeçalho')
  assert.match(pane, /seatError &&/u, 'a falha da troca continua visível no chat')

  const stageHead = rule(css, '.stage-head')
  assert.match(stageHead, /flex-direction: row/u)
  assert.match(stageHead, /container-type: inline-size/u, 'o palco estreito é decidido pela largura da própria cabeça')
  assert.doesNotMatch(stageHead, /overflow: hidden/u, 'o menu da conta abre para baixo a partir da cabeça')
  assert.doesNotMatch(css, /\.stage-meta-line\s*\{/u)
  assert.doesNotMatch(css, /\.stage-branch\s*\{/u)
  assert.doesNotMatch(css, /\.gui-head-seat-btn\s*\{/u)
  assert.doesNotMatch(css, /\.gui-head-status\s*\{/u)
  assert.doesNotMatch(workspaceCss, /\.stage-meta\b/u, 'o toggle da lateral se ancora na cabeça, não numa linha-meta')
  assert.match(workspaceCss, /\.stage-head \.workspace-sidebar-toggle/u)
})

test('estado do turno: só notícia vira palavra, e o relógio segue colado no estado', () => {
  const status = read('../src/renderer/src/components/StageRoundStatus.tsx')
  const css = read('../src/renderer/src/global.css')

  assert.match(status, /idle: null/u, 'parado não escreve nada')
  assert.match(status, /if \(!text\) return null/u)
  assert.match(status, /formatGuiElapsed/u, 'o relógio de rodada (R11) sobreviveu à mudança de casa')
  assert.match(status, /setInterval\(\(\) => setNow\(Date\.now\(\)\), 1_000\)/u)
  assert.match(status, /className="ss-clock" aria-hidden="true"/u, 'narrar o relógio a cada segundo é tortura')

  assert.match(rule(css, '.stage-status .ss-clock'), /tabular-nums/u)
  assert.match(css, /@keyframes stage-dot\b/u, 'o ponto pulsa só com trabalho vivo do outro lado')
  assert.match(rule(css, '.stage-status.dead'), /var\(--err\)/u)
  // o texto do estado fica em --ink-2 (AA sobre papel); a cor mora no ponto
  assert.match(rule(css, '.stage-status'), /color: var\(--ink-2\)/u)
})

test('o chip da conta: quieto, nunca beco, menu que não é cortado', () => {
  const chip = read('../src/renderer/src/components/StageSeatChip.tsx')
  const css = read('../src/renderer/src/global.css')

  assert.match(chip, /seats\.map\(\(option\) =>/u, 'a lista de contas passada é renderizada')
  assert.match(chip, /disabled=\{changing \|\| locked\}/u, 'só a troca em voo e o composer ocupado travam')
  assert.doesNotMatch(chip, /disabled=\{[^}]*turnOpen[^}]*\}/u, 'turno aberto nunca desabilita a troca (R21.2)')
  assert.match(chip, /'trocando conta…'/u, 'o único ocupado real é narrado por rótulo, não por cursor')
  assert.match(chip, /Trocar interrompe o turno atual e retoma a MESMA conversa na conta nova \(mesmo CLI\)\./u)
  assert.match(chip, /Conta desta conversa\. Trocar mantém a conversa quando o CLI é o mesmo\./u)

  const disabled = rule(css, '.stage-seat-btn:disabled')
  assert.match(disabled, /opacity: 0\.62/u)
  assert.match(disabled, /cursor: default/u)
  assert.doesNotMatch(disabled, /cursor: wait/u, 'a bolinha eterna não volta')
  const menu = rule(css, '.gui-seat-menu')
  assert.match(menu, /right: 0/u, 'o chip fica na ponta direita: o menu alinha pela direita')
  assert.match(menu, /top: calc\(100% \+ 6px\)/u)
  assert.match(menu, /overflow-y: auto/u)
  // palco estreito: some a palavra, fica o sinal
  const narrow = css.match(/@container stage-head \(max-width: \d+px\)\s*\{[\s\S]*?\n\}/u)?.[0] ?? ''
  assert.match(narrow, /\.stage-status \.ss-text/u)
  assert.match(narrow, /\.stage-seat-btn \.ss-name/u)
})
