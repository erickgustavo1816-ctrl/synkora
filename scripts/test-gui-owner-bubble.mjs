// A BOLHA CONTA A VERDADE (D6 do design de 2026-09-02).
//
// Queixa do dono, verbatim: "ele tá deixando na fila". A fala dele entrava no
// pote e a tela não dizia NADA — nem que o agente estava sendo parado, nem que
// a mensagem tinha sido entregue, nem que já havia sido respondida. Esta suíte
// prende as três palavras, a régua que faz o estado só ANDAR PARA A FRENTE e o
// desenho do carimbo (recibo mono sob a bolha, nunca card).
//
// Rodar: node --experimental-strip-types --test scripts/test-gui-owner-bubble.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  applyGuiOwnerMessageState,
  nextOwnerDelivery,
  ownerBubbleLabel,
  ownerDeliveryStamp
} from '../src/renderer/src/guiOwnerBubble.ts'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

/** 02/09/2026, 21:33:46 — a hora REAL da medição que gerou o design. */
const AT = new Date(2026, 8, 2, 21, 33, 46).getTime()
const NOW = new Date(2026, 8, 2, 21, 40, 0).getTime()

// ————————————————————————————— o carimbo —————————————————————————————

test('o carimbo diz a palavra de cada estado (e a hora da entrega)', () => {
  assert.deepEqual(ownerDeliveryStamp({ state: 'stopping', at: AT }, NOW), {
    text: 'parando o agente…',
    tone: 'stopping'
  })
  assert.deepEqual(ownerDeliveryStamp({ state: 'delivered', at: AT }, NOW), {
    text: 'entregue 21:33:46',
    tone: 'delivered'
  })
  assert.deepEqual(ownerDeliveryStamp({ state: 'answered', at: AT }, NOW), {
    text: 'respondida',
    tone: 'answered'
  })
})

test('sem entrega não há carimbo — mensagem de motor velho não ganha selo mudo', () => {
  // Motor antigo (ou fala mandada sem turno aberto) nunca emite o evento: a
  // bolha tem de ficar EXATAMENTE como era, sem linha nenhuma sob ela.
  assert.equal(ownerDeliveryStamp(undefined, NOW), null)
  assert.equal(ownerDeliveryStamp(null, NOW), null)
  // Estado fora do vocabulário: o main é o dono da união, mas um estado novo
  // nunca pode desenhar palavra inventada na tela do dono.
  assert.equal(ownerDeliveryStamp({ state: 'queued', at: AT }, NOW), null)
  assert.equal(ownerDeliveryStamp({ state: 'delivered', at: Number.NaN }, NOW), null)
})

test('entrega de outro dia carimba a data — 21:33:46 sozinho mentiria', () => {
  const ontem = new Date(2026, 8, 1, 21, 33, 46).getTime()
  assert.deepEqual(ownerDeliveryStamp({ state: 'delivered', at: ontem }, NOW), {
    text: 'entregue 01/09 21:33:46',
    tone: 'delivered'
  })
})

test('o nome acessível da bolha carrega o estado', () => {
  assert.equal(
    ownerBubbleLabel(ownerDeliveryStamp({ state: 'stopping', at: AT }, NOW)),
    'sua mensagem — parando o agente…'
  )
  assert.equal(
    ownerBubbleLabel(ownerDeliveryStamp({ state: 'answered', at: AT }, NOW)),
    'sua mensagem — respondida'
  )
  assert.equal(ownerBubbleLabel(null), null)
})

// ————————————————————————————— a régua —————————————————————————————

test('o estado só anda para a frente: parando → entregue → respondida', () => {
  assert.deepEqual(nextOwnerDelivery(undefined, 'stopping', AT), { state: 'stopping', at: AT })
  assert.deepEqual(nextOwnerDelivery({ state: 'stopping', at: AT }, 'delivered', AT + 10), {
    state: 'delivered',
    at: AT + 10
  })
  assert.deepEqual(nextOwnerDelivery({ state: 'delivered', at: AT }, 'answered', AT + 20), {
    state: 'answered',
    at: AT + 20
  })
  // Pulo direto (mensagem sem turno aberto: nunca houve `stopping`).
  assert.deepEqual(nextOwnerDelivery(undefined, 'delivered', AT), { state: 'delivered', at: AT })
})

test('nada regride nem repete: entregue não volta a parando, respondida não volta a entregue', () => {
  assert.equal(nextOwnerDelivery({ state: 'delivered', at: AT }, 'stopping', AT + 5), null)
  assert.equal(nextOwnerDelivery({ state: 'answered', at: AT }, 'delivered', AT + 5), null)
  assert.equal(nextOwnerDelivery({ state: 'answered', at: AT }, 'answered', AT + 5), null)
  assert.equal(nextOwnerDelivery({ state: 'delivered', at: AT }, 'delivered', AT + 5), null)
  assert.equal(nextOwnerDelivery({ state: 'stopping', at: AT }, 'queued', AT + 5), null)
})

// ————————————————————————— o redutor do fio —————————————————————————

const fio = () => [
  { id: 'm1', kind: 'user', text: 'para tudo', at: AT },
  { id: 'm1', kind: 'tool', name: 'Bash' },
  { id: 'm2', kind: 'user', text: 'e faz assim', at: AT + 1 }
]

test('o redutor marca a bolha certa e devolve a MESMA lista quando nada muda', () => {
  const antes = fio()
  const depois = applyGuiOwnerMessageState(antes, 'm1', 'stopping', AT)
  assert.notEqual(depois, antes)
  assert.deepEqual(depois[0].delivery, { state: 'stopping', at: AT })
  // O item `tool` com o MESMO id não é bolha: passa intacto (mesma referência).
  assert.equal(depois[1], antes[1])
  assert.equal(depois[2], antes[2])
  assert.equal(depois[2].delivery, undefined)

  // Idempotente: repetir o evento não faz o zustand repintar o fio inteiro.
  assert.equal(applyGuiOwnerMessageState(depois, 'm1', 'stopping', AT + 9), depois)
  // Regressão: o `delivered` atrasado de uma carona não apaga o `answered`.
  const respondida = applyGuiOwnerMessageState(depois, 'm1', 'answered', AT + 20)
  assert.equal(applyGuiOwnerMessageState(respondida, 'm1', 'delivered', AT + 30), respondida)
})

test('id desconhecido não mexe em nada — evento de outra conversa cai no vazio', () => {
  const antes = fio()
  assert.equal(applyGuiOwnerMessageState(antes, 'nao-existe', 'delivered', AT), antes)
})

// ————————————————— o espelho, a costura e o desenho —————————————————

test('o espelho do renderer declara o evento e aponta para o dono do union', () => {
  const api = read('src/renderer/src/guiApi.ts')
  assert.match(api, /type: 'owner-message-state'/u)
  assert.match(api, /state: 'stopping' \| 'delivered' \| 'answered'/u)
  // Espelho declarado (regra da casa): o comentário nomeia o par no main.
  const from = api.indexOf("type: 'owner-message-state'")
  assert.ok(from !== -1)
  assert.match(api.slice(Math.max(0, from - 900), from), /guiSessions\.ts/u)
})

test('o store guarda a entrega no item `user` e trata o evento novo', () => {
  const store = read('src/renderer/src/store.ts')
  assert.match(store, /delivery\?: GuiOwnerDelivery/u)
  assert.match(store, /case 'owner-message-state':/u)
  assert.match(store, /applyGuiOwnerMessageState\(state\.items, evt\.id, evt\.state, evt\.at\)/u)
  // Referência estável: sem mudança, o estado do pane sai idêntico.
  const from = store.indexOf("case 'owner-message-state':")
  const trecho = store.slice(from, from + 500)
  assert.match(trecho, /items === state\.items \? state :/u)
})

test('a bolha do dono desenha o carimbo e leva o estado no nome acessível', () => {
  const pane = read('src/renderer/src/components/GuiPane.tsx')
  const from = pane.indexOf("if (item.kind === 'user') {")
  const to = pane.indexOf("if (item.kind === 'note')")
  assert.ok(from !== -1 && to > from, 'a bolha do dono foi recortada')
  const bolha = pane.slice(from, to)
  assert.match(bolha, /ownerDeliveryStamp\(item\.delivery, Date\.now\(\)\)/u)
  assert.match(bolha, /ownerBubbleLabel\(/u)
  assert.match(bolha, /aria-label/u)
  assert.match(bolha, /gui-owner-state-\$\{stamp\.tone\}/u)
  // A bolha em si não muda: a tag, os anexos e o texto continuam onde estavam.
  assert.match(bolha, /className="gui-msg user"/u)
  assert.match(bolha, /className="gui-msg-text">\{item\.text\}/u)
})

test('o carimbo é recibo: mono discreto, dígito tabular, sem card e sem acento', () => {
  const css = read('src/renderer/src/global.css')
  const from = css.indexOf('.gui-owner-state {')
  assert.ok(from !== -1, 'o namespace gui-owner-state existe')
  const bloco = css.slice(from, from + 2_400)
  assert.match(bloco, /font-variant-numeric: tabular-nums/u)
  assert.match(bloco, /color: var\(--ink-[23]\)/u)
  // Papel & painel: nem acento nem erro pintam um recibo.
  assert.doesNotMatch(bloco, /--acc\b|--err\b/u)
  // E ele é LINHA, não card: a caixa do carimbo não tem moldura nem fundo
  // (as marcas, essas sim, são formas desenhadas em borda).
  const caixa = bloco.slice(bloco.indexOf('.gui-owner-state {'), bloco.indexOf('}'))
  assert.doesNotMatch(caixa, /border|background|box-shadow/u)
  // Só o estado VIVO se mexe, e com a animação que a casa já tem.
  assert.match(bloco, /\.gui-owner-state-stopping[\s\S]*animation: gui-subagent-pulse/u)
  assert.doesNotMatch(bloco, /\.gui-owner-state-(delivered|answered)[^{]*\{[^}]*animation:[^n]/u)
  assert.doesNotMatch(css, /@keyframes gui-owner/u)
  // Movimento é sinal, e sinal tem chave de desligar.
  assert.match(bloco, /prefers-reduced-motion: reduce[\s\S]*animation: none/u)
})
