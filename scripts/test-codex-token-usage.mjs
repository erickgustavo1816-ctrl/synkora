// test-codex-token-usage.mjs — a cerca do medidor de contexto do CODEX.
// Roda em node cru: node --experimental-strip-types --test
//
// FIXTURE REAL: os 8 frames abaixo são os payloads `tokenUsage` de todos os
// eventos `thread/tokenUsage/updated` capturados pela sonda de 2026-08-17
// contra o binário `codex app-server 0.147.0` (modelo gpt-5.4-mini, effort low;
// frames 1-6 na thread nova, 7 = replay do `thread/resume`, 8 = turno após o
// resume). Copiados literalmente — nada aqui é estimado.
//
// O QUE ESTA SUÍTE PROVA: `last` é a fotografia do ÚLTIMO REQUEST (um turno
// emite um evento por chamada de API) = contexto vivo; `total` é o acumulado da
// thread, restaurado no resume, e alimentá-lo é o bug que levou o medidor do
// dono a 404.325 tokens numa janela de 258.400 (156,5%) antes do commit c8ceecd.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  codexCallParcelsFromTokenUsage,
  codexContextFromTokenUsage
} from '../src/main/codexTokenUsage.ts'

const FRAMES = [
  {
    total: { totalTokens: 18704, inputTokens: 18564, cachedInputTokens: 5504, cacheWriteInputTokens: 0, outputTokens: 140, reasoningOutputTokens: 27 },
    last: { totalTokens: 18704, inputTokens: 18564, cachedInputTokens: 5504, cacheWriteInputTokens: 0, outputTokens: 140, reasoningOutputTokens: 27 },
    modelContextWindow: 258400
  },
  {
    total: { totalTokens: 37535, inputTokens: 37298, cachedInputTokens: 23808, cacheWriteInputTokens: 0, outputTokens: 237, reasoningOutputTokens: 27 },
    last: { totalTokens: 18831, inputTokens: 18734, cachedInputTokens: 18304, cacheWriteInputTokens: 0, outputTokens: 97, reasoningOutputTokens: 0 },
    modelContextWindow: 258400
  },
  {
    total: { totalTokens: 56493, inputTokens: 56159, cachedInputTokens: 42112, cacheWriteInputTokens: 0, outputTokens: 334, reasoningOutputTokens: 27 },
    last: { totalTokens: 18958, inputTokens: 18861, cachedInputTokens: 18304, cacheWriteInputTokens: 0, outputTokens: 97, reasoningOutputTokens: 0 },
    modelContextWindow: 258400
  },
  {
    total: { totalTokens: 75486, inputTokens: 75147, cachedInputTokens: 60928, cacheWriteInputTokens: 0, outputTokens: 339, reasoningOutputTokens: 27 },
    last: { totalTokens: 18993, inputTokens: 18988, cachedInputTokens: 18816, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
    modelContextWindow: 258400
  },
  {
    total: { totalTokens: 100222, inputTokens: 99757, cachedInputTokens: 78720, cacheWriteInputTokens: 0, outputTokens: 465, reasoningOutputTokens: 43 },
    last: { totalTokens: 24736, inputTokens: 24610, cachedInputTokens: 17792, cacheWriteInputTokens: 0, outputTokens: 126, reasoningOutputTokens: 16 },
    modelContextWindow: 258400
  },
  {
    total: { totalTokens: 124993, inputTokens: 124523, cachedInputTokens: 103168, cacheWriteInputTokens: 0, outputTokens: 470, reasoningOutputTokens: 43 },
    last: { totalTokens: 24771, inputTokens: 24766, cachedInputTokens: 24448, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
    modelContextWindow: 258400
  },
  // 7 — replay emitido pelo próprio `thread/resume`, antes de qualquer request
  // novo: o pane retomado recupera o medidor sozinho, e `total` não zerou.
  {
    total: { totalTokens: 124993, inputTokens: 124523, cachedInputTokens: 103168, cacheWriteInputTokens: 0, outputTokens: 470, reasoningOutputTokens: 43 },
    last: { totalTokens: 24771, inputTokens: 24766, cachedInputTokens: 24448, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
    modelContextWindow: 258400
  },
  {
    total: { totalTokens: 149777, inputTokens: 149289, cachedInputTokens: 127616, cacheWriteInputTokens: 0, outputTokens: 488, reasoningOutputTokens: 54 },
    last: { totalTokens: 24784, inputTokens: 24766, cachedInputTokens: 24448, cacheWriteInputTokens: 0, outputTokens: 18, reasoningOutputTokens: 11 },
    modelContextWindow: 258400
  }
]

const WINDOW = 258400
const LAST_SERIES = [18704, 18831, 18958, 18993, 24736, 24771, 24771, 24784]
const FORBIDDEN_SERIES = [18704, 37535, 56493, 75486, 100222, 124993, 124993, 149777]
// Pico medido no transcript do pane `gui-dev-7bcd1b79` (%APPDATA%\synkora\
// gui-sessions.json) com a leitura antiga: 156,5% da MESMA janela.
const PRODUCTION_RUNAWAY_TOKENS = 404325

/** A leitura PROIBIDA (pré-c8ceecd), reproduzida aqui só para ser contrastada. */
const forbiddenReading = (frame) => frame?.total?.totalTokens

test('os 8 frames reais devolvem a série `last`, sempre dentro da janela', () => {
  const measured = FRAMES.map((frame) => codexContextFromTokenUsage(frame))

  assert.deepEqual(measured.map((r) => r.contextTokens), LAST_SERIES)
  assert.deepEqual(measured.map((r) => r.contextWindow), FRAMES.map(() => WINDOW))
  for (const [i, reading] of measured.entries()) {
    assert.ok(
      reading.contextTokens <= reading.contextWindow,
      `frame ${i + 1}: ${reading.contextTokens} estourou a janela ${reading.contextWindow}`
    )
  }
})

test('a régua é `last` e NUNCA `total` — divergem a partir do frame 2', () => {
  for (const [i, frame] of FRAMES.entries()) {
    const { contextTokens } = codexContextFromTokenUsage(frame)
    // A invariante, frame a frame: a leitura é literalmente `last.totalTokens`…
    assert.equal(contextTokens, frame.last.totalTokens, `frame ${i + 1}`)
    // …e, quando as duas fontes divergem, jamais é a acumulada.
    if (frame.last.totalTokens !== frame.total.totalTokens) {
      assert.notEqual(contextTokens, forbiddenReading(frame), `frame ${i + 1}`)
    }
  }

  // O frame 1 coincide (primeiro request da thread: total == last). Do 2 em
  // diante a leitura antiga já mente, e é aí que o teste ficaria vermelho.
  const measured = FRAMES.map((frame) => codexContextFromTokenUsage(frame).contextTokens)
  const forbidden = FRAMES.map(forbiddenReading)
  assert.deepEqual(forbidden, FORBIDDEN_SERIES)
  assert.equal(measured[0], forbidden[0])
  for (let i = 1; i < FRAMES.length; i += 1) {
    assert.notEqual(measured[i], forbidden[i], `frame ${i + 1} deveria divergir do acumulado`)
  }
})

test('`total` é acumulado sem teto — por isso não pode virar régua', () => {
  // total(n) = total(n−1) + last(n) fecha em 100% dos frames (o replay do
  // resume repete o frame anterior e por isso não soma). É a identidade que
  // define "acumulado" e o motivo de a série crescer para sempre.
  for (let i = 1; i < FRAMES.length; i += 1) {
    const previous = FRAMES[i - 1].total.totalTokens
    const expected = previous + FRAMES[i].last.totalTokens
    const replay = FRAMES[i].total.totalTokens === previous
    if (!replay) assert.equal(FRAMES[i].total.totalTokens, expected, `frame ${i + 1}`)
  }
  assert.equal(FORBIDDEN_SERIES.at(-1), 149777)
  // 8 requests já dão 6× de erro; na conversa do dono a mesma leitura atravessou
  // a janela — nenhum request único pode ter mais tokens do que a API aceita.
  assert.ok(FORBIDDEN_SERIES.at(-1) > LAST_SERIES.at(-1) * 6)
  assert.ok(PRODUCTION_RUNAWAY_TOKENS > WINDOW)
  assert.ok(LAST_SERIES.every((tokens) => tokens < WINDOW))
})

test('ausência de `last` não cai em `total`; janela inválida some', () => {
  const semLast = codexContextFromTokenUsage({
    total: { totalTokens: 149777 },
    modelContextWindow: WINDOW
  })
  assert.equal(semLast.contextTokens, undefined)
  assert.equal(semLast.contextWindow, WINDOW)

  const semJanela = codexContextFromTokenUsage({ last: { totalTokens: 24784 } })
  assert.equal(semJanela.contextTokens, 24784)
  assert.equal(semJanela.contextWindow, undefined)

  const janelaNula = codexContextFromTokenUsage({
    last: { totalTokens: 24784 },
    modelContextWindow: null
  })
  assert.equal(janelaNula.contextWindow, undefined)

  for (const vazio of [undefined, null, 'tokenUsage', 42, {}, { last: null }]) {
    const reading = codexContextFromTokenUsage(vazio)
    assert.equal(reading.contextTokens, undefined)
    assert.equal(reading.contextWindow, undefined)
  }
})

test('validação preservada: número inteiro, não-negativo; janela positiva', () => {
  for (const ruim of ['18704', 18704.5, -1, NaN, Infinity, null, {}]) {
    const reading = codexContextFromTokenUsage({
      last: { totalTokens: ruim },
      modelContextWindow: WINDOW
    })
    assert.equal(reading.contextTokens, undefined, `totalTokens ${String(ruim)}`)
  }
  assert.equal(codexContextFromTokenUsage({ last: { totalTokens: 0 } }).contextTokens, 0)

  for (const ruim of [0, -1, 258400.5, '258400', NaN]) {
    const reading = codexContextFromTokenUsage({
      last: { totalTokens: 100 },
      modelContextWindow: ruim
    })
    assert.equal(reading.contextWindow, undefined, `janela ${String(ruim)}`)
  }
})

test('contrato da fonte: o handler usa o módulo puro e não lê o acumulado', () => {
  const source = readFileSync(new URL('../src/main/codexSession.ts', import.meta.url), 'utf8')

  assert.ok(source.includes("from './codexTokenUsage'"), 'codexSession precisa importar o módulo puro')
  const handler = source.indexOf("case 'thread/tokenUsage/updated'")
  assert.ok(handler >= 0, 'handler de thread/tokenUsage/updated sumiu')
  const call = source.indexOf('codexContextFromTokenUsage(', handler)
  const assignment = source.indexOf('this.lastTokens =', handler)
  assert.ok(call > handler && call < assignment, 'a leitura precisa vir do módulo puro')

  for (const proibido of ['total.totalTokens', 'total?.totalTokens', "total']?.['totalTokens"]) {
    assert.ok(!source.includes(proibido), `leitura proibida reintroduzida: ${proibido}`)
  }
})

// ————— R25.1 — AS PARCELAS DE CADA CHAMADA (o que o odômetro soma) —————
//
// SONDA, não claim nova: os mesmos 8 frames reais acima já traziam
// `inputTokens` / `cachedInputTokens` / `cacheWriteInputTokens` / `outputTokens`
// dentro do `last`. A régua do contexto continua sendo `last.totalTokens`; o
// odômetro da conversa (R25) precisa da REPARTIÇÃO, porque cache lido custa
// ~0,1× e output ~5× — somar tudo como "tokens" mentiria sobre a cota.
//
// `inputTokens` do codex é o input INTEIRO (a identidade abaixo prova frame a
// frame: input + output = total), então a parcela FRESCA é o que sobra depois
// de tirar cache lido e cache escrito.

test('cada frame real reparte o `last` em fresco / cache escrito / cache lido / saída', () => {
  const parcels = FRAMES.map((frame) => codexCallParcelsFromTokenUsage(frame))

  assert.deepEqual(parcels[0], {
    inputTokens: 13_060,
    cacheWriteTokens: 0,
    cacheReadTokens: 5_504,
    outputTokens: 140
  })
  assert.deepEqual(parcels[1], {
    inputTokens: 430,
    cacheWriteTokens: 0,
    cacheReadTokens: 18_304,
    outputTokens: 97
  })

  for (const [i, frame] of FRAMES.entries()) {
    const parcel = parcels[i]
    // A identidade do protocolo: input + output = total do REQUEST.
    assert.equal(frame.last.inputTokens + frame.last.outputTokens, frame.last.totalTokens, `frame ${i + 1}`)
    // E a repartição não inventa nem perde token nenhum.
    assert.equal(
      parcel.inputTokens + parcel.cacheWriteTokens + parcel.cacheReadTokens + parcel.outputTokens,
      frame.last.totalTokens,
      `frame ${i + 1}`
    )
    // NUNCA o acumulado: repartir `total` contaria a thread inteira a cada
    // evento. O frame 1 coincide (primeiro request: total == last), como já
    // acontece na régua do contexto — do 2 em diante a leitura antiga mentiria.
    if (frame.last.totalTokens !== frame.total.totalTokens) {
      assert.notEqual(parcel.cacheReadTokens, frame.total.cachedInputTokens, `frame ${i + 1}`)
    }
  }
})

test('sem repartição confiável não há parcela — e nunca um chute', () => {
  // O `last` mínimo (só totalTokens) ainda mede CONTEXTO, mas não diz o custo:
  // publicar zero em cada parcela faria o odômetro contar chamada de graça.
  assert.equal(
    codexCallParcelsFromTokenUsage({ last: { totalTokens: 24_784 }, modelContextWindow: WINDOW }),
    undefined
  )
  assert.equal(codexCallParcelsFromTokenUsage({ total: { inputTokens: 100 } }), undefined)
  for (const vazio of [undefined, null, 'tokenUsage', 42, {}, { last: null }]) {
    assert.equal(codexCallParcelsFromTokenUsage(vazio), undefined)
  }
  // Frame incoerente (cache maior que o input) não vira parcela negativa.
  const incoerente = codexCallParcelsFromTokenUsage({
    last: { totalTokens: 100, inputTokens: 100, cachedInputTokens: 400, outputTokens: 0 }
  })
  assert.equal(incoerente.inputTokens, 0)
  assert.equal(incoerente.cacheReadTokens, 400)
})
