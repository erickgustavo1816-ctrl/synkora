import assert from 'node:assert/strict'
import test from 'node:test'

// Regressão do limpador do tee (SONDA 2026-08-03, probe-tee-garble.mjs em TUI
// claude real): apagar sequências de cursor fundia palavras
// ("transcriptpreservapalavras…", "helper_outpt" no diário) e vazava lixo de
// CSI kitty/charset ("<u78", "(B"). Cada caso abaixo é uma classe PROVADA na
// sonda — não são hipóteses.
const { cleanPtyChunk, collapseRepaintFrame } = await import(
  new URL('../.tmp/pty-transcript-test/pty.js', import.meta.url)
)

test('CUF (célula pulada) vira separador — palavras não fundem', () => {
  assert.equal(cleanPtyChunk('Your\x1b[1Cfull\x1b[3Coutput'), 'Your full output')
})

test('CHA (salto de coluna) separa em vez de fundir', () => {
  assert.equal(cleanPtyChunk('Enter\x1b[20Gto\x1b[30Gconfirm'), 'Enter to confirm')
})

test('CUP na MESMA linha reagrupa a linha; linha nova quebra', () => {
  assert.equal(
    cleanPtyChunk('\x1b[5;1HHello\x1b[5;7Hworld\x1b[6;1Hnext'),
    'Hello world\nnext'
  )
})

test('movimento relativo de linha (CUU/CUD/CNL/CPL) quebra a linha', () => {
  assert.equal(cleanPtyChunk('primeira\x1b[2Asegunda'), 'primeira\nsegunda')
})

test('CSI kitty/modifyOtherKeys (params <=>) não vaza como texto', () => {
  assert.equal(cleanPtyChunk('ok\x1b[>4m\x1b[<u\x1b[>1u fim'), 'ok fim')
})

test('charset/keypad/DECSC-DECRC (ESC ( B, ESC =, ESC 7/8) somem sem rastro', () => {
  assert.equal(cleanPtyChunk('a\x1b(Bb\x1b=c\x1b7d\x1b8e'), 'abcde')
})

test('SGR/EL/ED e OSC continuam removidos; CR vira quebra', () => {
  assert.equal(
    cleanPtyChunk('\x1b]0;titulo\x07\x1b[31mvermelho\x1b[0m\x1b[2K\rlinha'),
    'vermelho\nlinha'
  )
})

test('repaint do mesmo conteúdo produz linhas idênticas (dedupe do flushLog pega)', () => {
  const paint = '\x1b[3;1HStatus:\x1b[3;9Hok'
  assert.equal(cleanPtyChunk(paint), cleanPtyChunk(paint))
  assert.equal(cleanPtyChunk(paint), 'Status: ok')
})

test('texto sem sequências passa intacto', () => {
  const plain = 'ajudante 7224247f concluiu: próximo jogo às 19h.\nlinha 2'
  assert.equal(cleanPtyChunk(plain), plain)
})

// SONDA 2026-08-04 (probe-codex-resume-mcp.mjs + analyze-codex-bytes.mjs, TUI
// codex real): o shimmer repinta só a janela destacada da palavra por frame —
// as strings abaixo saíram LITERALMENTE da captura de bytes. Frames colapsam;
// linhas legítimas nunca.
test('frame do shimmer que encolhe é descartado (strings reais da sonda)', () => {
  assert.equal(collapseRepaintFrame('• Working', 'orking'), 'drop')
  assert.equal(collapseRepaintFrame('orking', '• rking'), 'drop')
  assert.equal(collapseRepaintFrame('• king 4', 'ing'), 'drop')
  assert.equal(collapseRepaintFrame('Working', '• Working'), 'drop')
  // o contador de tokens vaza como sufixo do frame ("• king 4") e o glifo
  // sozinho ("•") resetava a cadeia — ambos medidos no replay da captura
  assert.equal(collapseRepaintFrame('Working', '• king 4'), 'drop')
  assert.equal(collapseRepaintFrame('Working', '•'), 'drop')
})

test('frame do shimmer que cresce substitui a versão curta', () => {
  assert.equal(collapseRepaintFrame('Wor', '• Work'), 'replace')
  assert.equal(collapseRepaintFrame('• Worki', 'Working'), 'replace')
})

test('linhas legítimas nunca colapsam como frame', () => {
  assert.equal(collapseRepaintFrame('passo 1', 'passo 2'), 'keep')
  assert.equal(collapseRepaintFrame('npm run typecheck', 'npm run lint'), 'keep')
  assert.equal(
    collapseRepaintFrame(
      'a verificação conjunta reprovou o card por regressão de lint em src/main/index.ts (176 erros)',
      'reprovou o card'
    ),
    'keep'
  )
  assert.equal(collapseRepaintFrame('', 'Working'), 'keep')
  assert.equal(collapseRepaintFrame('•', 'Working'), 'keep')
  // progresso repintado (letras iguais, número cresce) substitui, não duplica
  assert.equal(collapseRepaintFrame('passed 2', 'passed 23'), 'replace')
})
