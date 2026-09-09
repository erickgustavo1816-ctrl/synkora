#!/usr/bin/env node
/**
 * O MOTOR DO BROWSER EMBUTIDO — driver, sonda, foto e catálogo
 * (fatia H2 do design `.synkora/reports/DESIGN_BROWSER_EMBUTIDO_2026-08-29.md`).
 *
 * Três metades (a casa tem direito a três metades quando a terceira é a cerca):
 *
 *  A) O DRIVER CONTRA UMA PÁGINA DE VERDADE. O `BrowserDriverSession` fala CDP
 *     por `Runtime.evaluate`, e o que ele avalia é o `PAGE_SCRIPT`/`PROBE_SCRIPT`
 *     REAIS. Então o dublê desta suíte não é o script: é o Chromium. Um
 *     `Debugger` falso recebe as expressões e as roda contra um DOM sintético em
 *     node. Resultado: `read`, `find`, `act`, `probe` e o EPOCH são exercitados
 *     ponta a ponta, com a heurística de papel/nome de verdade, sem subir uma
 *     janela. O que NÃO se prova aqui é o Chromium (isso está pago nas sondas
 *     P4-P7); o que se prova é este código.
 *
 *  B) O RECIBO DA FOTO. `browser_shot` é a única tool que produz ARQUIVO, e a
 *     LEI 2 diz que todo recibo carrega o carimbo de frescor — quadro que não
 *     pulsa vira aviso honesto, nunca aprovação silenciosa. E a imagem inline é
 *     SÓ do claude: o codex descarta imagem de MCP (`openai/codex#10334`), e
 *     mandá-la seria pagar banda por nada.
 *
 *  C) A CERCA DO CATÁLOGO — a superfície mais perigosa do app. Quem enxerga o
 *     kit `browser_*` sai de um retorno antecipado dentro do `buildServer`, e um
 *     `if` trocado ali dá ao reviewer o poder de rodar o produto que ele deveria
 *     só ler. Aqui roda o servidor MCP HTTP REAL com cliente MCP REAL: o que se
 *     mede é o catálogo servido, não o que o código diz servir. Junto vem a
 *     CERCA DE TEXTO (nenhuma tool emite `structuredContent`) e a PRÉ-SANÇÃO —
 *     a lição da R14, que só falha quando alguém tira a costura.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

import {
  BROWSER_ACT_MAX_STEPS,
  BROWSER_CDP_TIMEOUT_MS,
  BROWSER_READ_CEILING_CHARS,
  BROWSER_READ_DEFAULT_MAX_CHARS,
  BROWSER_STALE_REF_RECIPE,
  BROWSER_WAIT_MAX_MS,
  BrowserDriverRegistry,
  BrowserDriverSession
} from '../.tmp/browser-driver-test/browserDriver.js'
import {
  contrastRatio,
  effectiveBackground,
  isLargeText,
  parseCssColor,
  wcagVerdict
} from '../.tmp/browser-driver-test/browserProbe.js'
import {
  BROWSER_SHOT_DIR,
  BROWSER_SHOT_MAX_WIDTH,
  freshnessStamp
} from '../.tmp/browser-driver-test/browserShot.js'
import {
  BROWSER_ENGINE_OFF,
  BROWSER_NO_MISSION,
  BROWSER_NO_TAB,
  BROWSER_TOOL_NAMES,
  buildGuiBrowserTools
} from '../.tmp/browser-driver-test/guiBrowserTools.js'
import { GUI_DELEGATE_CLAUDE_ALLOWED_TOOLS } from '../.tmp/browser-driver-test/guiDelegateMcp.js'
import { GUI_HELPER_LSP_CLAUDE_ALLOWED_TOOLS } from '../.tmp/browser-driver-test/guiHelperLspMcp.js'
import { Hub } from '../.tmp/browser-driver-test/hub.js'
import { startMcpServer } from '../.tmp/browser-driver-test/mcpServer.js'

// ————————————————————————————————————————————————————————————————
// O DOM SINTÉTICO — o mínimo que o PAGE_SCRIPT e o PROBE_SCRIPT tocam
// ————————————————————————————————————————————————————————————————

class FakeText {
  constructor(value) {
    this.nodeType = 3
    this.nodeValue = value
  }
}

class FakeEl {
  constructor(tag, options = {}) {
    this.nodeType = 1
    this.tagName = tag.toUpperCase()
    this.attrs = options.attrs ?? {}
    this.children = []
    this.childNodes = []
    this.parentElement = null
    this.isConnected = true
    this.style = options.style ?? {}
    this.rect = options.rect ?? { left: 0, top: 0, width: 100, height: 20 }
    this.hidden = false
    this.id = this.attrs.id ?? ''
    this.className = this.attrs.class ?? ''
    this.isContentEditable = false
    this.dispatched = 0
    if (options.text) this.childNodes.push(new FakeText(options.text))
    if (options.value !== undefined) this.value = options.value
    if (options.disabled) this.disabled = true
  }

  add(child) {
    child.parentElement = this
    this.children.push(child)
    this.childNodes.push(child)
    return this
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name)
  }

  getBoundingClientRect() {
    const r = this.rect
    return {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      right: r.left + r.width,
      bottom: r.top + r.height
    }
  }

  get innerText() {
    return this.textContent
  }

  get textContent() {
    let out = ''
    for (const node of this.childNodes) out += node.nodeType === 3 ? node.nodeValue : node.textContent
    return out
  }

  contains(other) {
    let cursor = other
    while (cursor) {
      if (cursor === this) return true
      cursor = cursor.parentElement
    }
    return false
  }

  scrollIntoView() {
    this.scrolledIntoView = true
  }

  focus() {
    this.ownerWindow.document.activeElement = this
  }

  dispatchEvent(event) {
    this.dispatched += 1
    this.events = [...(this.events ?? []), event?.type]
    return true
  }

  get scrollWidth() {
    return this.overflowW ?? this.rect.width
  }

  get clientWidth() {
    return this.rect.width
  }

  get scrollHeight() {
    return this.overflowH ?? this.rect.height
  }

  get clientHeight() {
    return this.rect.height
  }
}

/** Casador de seletor com o alcance exato que o script usa: `tag`, `#id`,
 *  `.classe`. Mais que isso seria escrever um jsdom — e o que se testa aqui é o
 *  nosso código, não o motor de seletores do Chromium. */
function matches(el, selector) {
  const raw = selector.trim()
  if (raw.startsWith('#')) return el.id === raw.slice(1)
  if (raw.startsWith('.')) return String(el.className).split(/\s+/).includes(raw.slice(1))
  return el.tagName === raw.toUpperCase()
}

/**
 * A PÁGINA: um formulário de missão pintado com as cores REAIS da casa — acento
 * `#d96c3f` sobre papel `#efe9dc`. Não é decoração: é o par que a sonda de
 * contraste tem de REPROVAR (2,81:1), e ter o caso verdadeiro no fixture é o que
 * mostra que a tool faz o QA que ela existe para fazer.
 */
function makeFixture(options = {}) {
  const body = new FakeEl('body', {
    rect: { left: 0, top: 0, width: 1000, height: 800 },
    style: { backgroundColor: 'rgb(239, 233, 220)' }
  })
  const h1 = new FakeEl('h1', { text: 'Painel da missão', rect: { left: 20, top: 20, width: 400, height: 40 } })
  const form = new FakeEl('form', {
    rect: { left: 10, top: 80, width: 500, height: 140 },
    style: { backgroundColor: 'rgba(0, 0, 0, 0)' }
  })
  const label = new FakeEl('label', { text: 'E-mail', rect: { left: 20, top: 80, width: 100, height: 16 } })
  const input = new FakeEl('input', {
    attrs: { type: 'text', placeholder: 'seu e-mail' },
    rect: { left: 20, top: 100, width: 200, height: 30 },
    value: ''
  })
  const save = new FakeEl('button', {
    text: 'Salvar',
    rect: { left: 20, top: 150, width: 90, height: 32 },
    style: {
      color: 'rgb(217, 108, 63)',
      backgroundColor: 'rgba(0, 0, 0, 0)',
      fontSize: '14px',
      fontWeight: '400'
    }
  })
  const cancel = new FakeEl('button', {
    text: 'Cancelar',
    rect: { left: 130, top: 150, width: 90, height: 32 },
    disabled: true
  })
  const secret = new FakeEl('div', { text: 'segredo do dono', style: { display: 'none' } })
  const aside = new FakeEl('div', { attrs: { 'aria-hidden': 'true' }, text: 'decoração' })
  // `input.labels` é o que o Chromium entrega para um `<label>` associado, e é
  // o PRIMEIRO caminho de nome do script: sem ele aqui, o teste passaria pelo
  // atalho do placeholder e nunca exercitaria a associação real.
  input.labels = [label]
  form.add(label).add(input).add(save).add(cancel)
  body.add(h1).add(form).add(secret).add(aside)

  const list = new FakeEl('ul', { rect: { left: 20, top: 240, width: 400, height: 400 } })
  for (let n = 0; n < (options.items ?? 40); n += 1) {
    list.add(
      new FakeEl('li', {
        text: `item de trabalho ${String(n).padStart(2, '0')} — pendente de revisão`,
        rect: { left: 20, top: 240 + n * 10, width: 400, height: 10 }
      })
    )
  }
  body.add(list)

  const modal = new FakeEl('div', {
    attrs: { id: 'modal', class: 'overlay grande' },
    rect: { left: 0, top: 120, width: 400, height: 200 }
  })

  const all = [body, h1, form, label, input, save, cancel, secret, aside, list, modal, ...list.children]

  const doc = {
    title: 'Missão · Synkora',
    readyState: 'complete',
    body,
    activeElement: null,
    getElementById: (id) => all.find((el) => el.id === id) ?? null,
    querySelector: (selector) => all.find((el) => el.isConnected && matches(el, selector)) ?? null,
    elementFromPoint: (x, y) => {
      if (fixture.topAt) {
        const forced = fixture.topAt(x, y)
        if (forced) return forced
      }
      for (const el of [save, cancel, input]) {
        const r = el.getBoundingClientRect()
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el
      }
      return body
    }
  }

  const win = {
    innerWidth: 1000,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    document: doc,
    location: { href: 'http://localhost:5173/board' },
    getComputedStyle(el) {
      const base = {
        display: el.style.display ?? 'block',
        visibility: el.style.visibility ?? 'visible',
        opacity: el.style.opacity ?? '1',
        color: el.style.color ?? 'rgb(38, 32, 25)',
        backgroundColor: el.style.backgroundColor ?? 'rgba(0, 0, 0, 0)',
        fontSize: el.style.fontSize ?? '16px',
        fontWeight: el.style.fontWeight ?? '400',
        overflow: el.style.overflow ?? 'visible',
        overflowX: el.style.overflowX ?? 'visible',
        overflowY: el.style.overflowY ?? 'visible',
        textOverflow: el.style.textOverflow ?? 'clip',
        position: 'static',
        lineHeight: '24px',
        padding: '0px',
        margin: '0px',
        border: '0px',
        borderRadius: '0px',
        zIndex: 'auto'
      }
      return {
        ...base,
        getPropertyValue: (prop) => base[prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ?? ''
      }
    }
  }

  for (const el of all) el.ownerWindow = win

  const fixture = { window: win, document: doc, body, h1, form, label, input, save, cancel, secret, list, modal, topAt: null }
  return fixture
}

// ————————————————————————————————————————————————————————————————
// O DEBUGGER FALSO — as expressões do driver rodam contra o DOM sintético
// ————————————————————————————————————————————————————————————————

let nextPageId = 1

function makeFakePage(fixture, options = {}) {
  const sent = []
  let onMessage = null
  const freshness = { frames: 2, ms: 14, ...(options.freshness ?? {}) }

  const run = (expression) => {
    const factory = new Function(
      'window',
      'document',
      'location',
      'HTMLInputElement',
      'HTMLTextAreaElement',
      `return (${expression})`
    )
    return factory(fixture.window, fixture.document, fixture.window.location, FakeEl, FakeEl)
  }

  const debuggerLike = {
    attached: false,
    isAttached: () => debuggerLike.attached,
    attach(version) {
      debuggerLike.attached = true
      debuggerLike.version = version
    },
    detach() {
      debuggerLike.attached = false
    },
    on(event, listener) {
      if (event === 'message') onMessage = listener
    },
    async sendCommand(method, params = {}) {
      sent.push({ method, params })
      if (options.refuse?.(method, params)) throw new Error(`${method} não existe neste Electron`)
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params.expression ?? '')
      // A sonda de frescor da LEI 2 e o assentamento da LEI 3 são promessas de
      // rAF: não há compositor num DOM de node, então elas respondem o que o
      // teste combinou (é justamente o frescor que se quer poder falsear).
      if (expression.startsWith('new Promise(')) {
        if (expression.includes('performance.now()')) {
          return { result: { value: { frames: freshness.frames, ms: freshness.ms } } }
        }
        return { result: { value: 1 } }
      }
      try {
        return { result: { value: run(expression) } }
      } catch (error) {
        return { exceptionDetails: { text: String(error?.message ?? error) } }
      }
    }
  }

  const page = {
    id: nextPageId++,
    debugger: debuggerLike,
    destroyed: false,
    isDestroyed: () => page.destroyed,
    getURL: () => fixture.window.location.href,
    getTitle: () => fixture.document.title
  }

  return {
    page,
    sent,
    /** Um evento do CDP chegando pela ponte do `debugger.on('message')`. */
    emit: (method, params) => onMessage?.(null, method, params),
    inputs: () => sent.filter((entry) => entry.method.startsWith('Input.')),
    freshness
  }
}

async function sessionOn(fixture, options) {
  const host = makeFakePage(fixture, options)
  const session = new BrowserDriverSession(host.page, options?.log)
  await session.ensureAttached()
  return { session, ...host }
}

const refIn = (text, needle) => {
  const found = new RegExp(`\\[ref_(\\d+)\\][^\\n]*${needle}`, 'u').exec(text)
  assert.ok(found, `não achei o ref de ${needle} em:\n${text}`)
  return Number(found[1])
}

test('CDP/RECUPERAÇÃO: inicialização que falhou não fica marcada como pronta', async () => {
  let first = true
  const host = makeFakePage(makeFixture({ items: 0 }), {
    refuse: (method) => {
      if (method !== 'Page.enable' || !first) return false
      first = false
      return true
    }
  })
  let subscriptions = 0
  const on = host.page.debugger.on
  host.page.debugger.on = (event, listener) => { subscriptions += 1; return on(event, listener) }
  const session = new BrowserDriverSession(host.page)
  await assert.rejects(session.ensureAttached(), /Page.enable/u)
  await session.ensureAttached()
  assert.equal(host.sent.filter(({ method }) => method === 'Page.enable').length, 2)
  assert.ok(host.sent.some(({ method }) => method === 'Runtime.enable'))
  assert.equal(subscriptions, 1, 'a recuperação não duplica eventos nem o epoch')
  assert.match(await session.read(), /Painel da missão/u)
})

test('CDP/RECUPERAÇÃO: chamadas simultâneas esperam a mesma inicialização', async () => {
  const host = makeFakePage(makeFixture({ items: 0 }))
  const send = host.page.debugger.sendCommand
  let release
  const pending = new Promise((resolve) => { release = resolve })
  host.page.debugger.sendCommand = async (method, params) => {
    if (method === 'Page.enable') await pending
    return send(method, params)
  }
  const session = new BrowserDriverSession(host.page)
  const first = session.ensureAttached()
  let secondReady = false
  const second = session.ensureAttached().then(() => { secondReady = true })
  await new Promise((resolve) => setImmediate(resolve))
  try {
    assert.equal(secondReady, false, 'nenhuma leitura começa antes de Page/Runtime prontos')
  } finally {
    release()
    await Promise.all([first, second])
  }
  assert.equal(host.sent.filter(({ method }) => method === 'Page.enable').length, 1)
})

// ————————————————————————————————————————————————————————————————
// A. A PÁGINA EM TEXTO — leitura, refs e o EPOCH
// ————————————————————————————————————————————————————————————————

test('READ: uma linha por elemento, em ordem de documento, com `[ref_N]` no que se clica', async () => {
  const fixture = makeFixture({ items: 0 })
  const { session } = await sessionOn(fixture)
  const receipt = await session.read({ filter: 'all' })

  assert.match(receipt, /^Missão · Synkora · http:\/\/localhost:5173\/board/u, 'o cabeçalho situa o agente')
  assert.match(receipt, /heading "Painel da missão" \(nivel=1\)/u)
  assert.match(receipt, /\[ref_\d+\] textbox "E-mail" \(vazio, dica="seu e-mail"\)/u)
  assert.match(receipt, /\[ref_\d+\] button "Cancelar" \(desabilitado\)/u)
  // Ordem de documento: um `reverse()` a mais inverteria a leitura inteira e o
  // agente descreveria a tela de trás para frente.
  assert.ok(receipt.indexOf('E-mail') < receipt.indexOf('Salvar'))
  assert.ok(receipt.indexOf('Salvar') < receipt.indexOf('Cancelar'))
  // `display:none` e `aria-hidden` não vazam — mas são CONTADOS, porque
  // "não vi nada" e "escondi 2" são respostas diferentes.
  assert.equal(receipt.includes('segredo do dono'), false)
  assert.match(receipt, /2 oculto\(s\) omitido\(s\)/u)
  assert.match(receipt, /refs válidos no epoch 1/u)
})

test('READ: `filter:"interactive"` corta o que não se clica — o corte barato de uma página grande', async () => {
  const fixture = makeFixture({ items: 10 })
  const { session } = await sessionOn(fixture)
  const cheap = await session.read({ filter: 'interactive' })
  assert.equal(cheap.includes('heading'), false)
  assert.equal(cheap.includes('item de trabalho'), false)
  assert.match(cheap, /3 interativo\(s\)/u, 'campo + dois botões')
})

test('READ: o corte SE ANUNCIA com a receita — truncagem silenciosa aprovaria meia página', async () => {
  const fixture = makeFixture({ items: 60 })
  const { session } = await sessionOn(fixture)
  const cut = await session.read({ maxChars: 600 })

  assert.match(cut, /\[CORTADO no teto de 600 caracteres\]/u)
  // Beco sem saída é bug: a receita nomeia as QUATRO saídas.
  assert.match(cut, /filter:"interactive"/u)
  assert.match(cut, /scope:"<seletor CSS>"/u)
  assert.match(cut, /depth menor/u)
  assert.ok(cut.includes(String(BROWSER_READ_CEILING_CHARS)), 'o teto do teto é dito em voz alta')

  const inteiro = await session.read({ filter: 'interactive' })
  assert.equal(inteiro.includes('[CORTADO'), false, 'o que cabe não ganha aviso de corte')

  // Teto pedido abaixo do piso é GRAMPEADO — um `maxChars: 10` devolveria um
  // recibo que não cabe nem o cabeçalho.
  const piso = await session.read({ maxChars: 10 })
  assert.match(piso, /\[CORTADO no teto de 500 caracteres\]/u)
  assert.equal(BROWSER_READ_DEFAULT_MAX_CHARS, 8_000)
})

test('READ: `scope` que não existe RECUSA nomeando a saída — nunca devolve tela vazia', async () => {
  const fixture = makeFixture({ items: 0 })
  const { session } = await sessionOn(fixture)
  const miss = await session.read({ scope: '#nao-existe' })
  assert.match(miss, /escopo nao encontrado: #nao-existe/u)
  assert.match(miss, /chame browser_read sem `scope`/u)

  const escopado = await session.read({ scope: 'form' })
  assert.equal(escopado.includes('Painel da missão'), false)
  assert.match(escopado, /button "Salvar"/u)
})

test('FIND: o atalho barato devolve ref E caixa — e a busca vazia ensina o caminho', async () => {
  const fixture = makeFixture({ items: 0 })
  const { session } = await sessionOn(fixture)
  const hit = await session.find('salv')
  assert.match(hit, /\[ref_\d+\] button "Salvar" @\(20,150\) 90x32/u)
  assert.match(hit, /refs válidos no epoch 1/u)

  const nada = await session.find('não existe nesta tela')
  assert.match(nada, /nenhum elemento casou/u)
  assert.match(nada, /browser_read \(filter:"interactive"\)/u)
})

test('EPOCH: o ref é do READ que o gerou — reler NÃO renumera, e navegar mata tudo', async () => {
  const fixture = makeFixture({ items: 0 })
  const { session, emit } = await sessionOn(fixture)

  const first = await session.read({ filter: 'interactive' })
  const salvar = refIn(first, 'Salvar')
  // A LEI que sustenta o `act` encadeado: a lei 3 manda toda ação devolver o
  // read, e um read que renumerasse refs invalidaria o ref recém-lido.
  const second = await session.read({ filter: 'interactive' })
  assert.equal(refIn(second, 'Salvar'), salvar)
  assert.equal(session.epoch, 1)

  // Navegação do frame PRINCIPAL vira epoch novo.
  emit('Page.frameNavigated', { frame: { url: 'http://localhost:5173/outra' } })
  assert.equal(session.epoch, 2)
  // Frame filho (iframe de anúncio, hot-reload de dev) NÃO conta.
  emit('Page.frameNavigated', { frame: { parentId: 'f2', url: 'https://iframe.test/' } })
  assert.equal(session.epoch, 2)

  const stale = await session.act([{ action: 'click', ref: salvar }])
  assert.match(stale, /ref \d+ nao existe nesta pagina/u)
  assert.match(stale, /browser_read de novo/u, 'a recusa NOMEIA a receita')
  assert.ok(stale.includes(BROWSER_STALE_REF_RECIPE), 'a frase é uma só, e viaja verbatim')
})

test('EPOCH: nó que sumiu do documento recusa pela MESMA porta (SPA que troca DOM sem navegar)', async () => {
  const fixture = makeFixture({ items: 0 })
  const { session } = await sessionOn(fixture)
  const read = await session.read({ filter: 'interactive' })
  const cancelar = refIn(read, 'Cancelar')
  fixture.cancel.isConnected = false

  const gone = await session.act([{ action: 'click', ref: cancelar }])
  assert.match(gone, /browser_read de novo/u)
  assert.match(gone, /PAROU no passo 1 de 1/u)
})

// ————————————————————————————————————————————————————————————————
// A LEI 3 — ação já observa, e o lote para no primeiro erro
// ————————————————————————————————————————————————————————————————

test('ACT: o lote roda em ORDEM e SEMPRE termina com a leitura pós-ação', async () => {
  const fixture = makeFixture({ items: 0 })
  const { session, inputs } = await sessionOn(fixture)
  const read = await session.read({ filter: 'interactive' })
  const campo = refIn(read, 'textbox')
  const salvar = refIn(read, 'Salvar')

  const receipt = await session.act(
    [
      { action: 'fill', ref: campo, value: 'a@b.c' },
      { action: 'click', ref: salvar }
    ],
    { filter: 'interactive' }
  )

  assert.match(receipt, /^2 ação\(ões\) executada\(s\):/u)
  assert.match(receipt, /1\. fill em textbox "E-mail" <input>/u)
  assert.match(receipt, /2\. click em button "Salvar" <button>/u)
  // O produto final da tool é o ESTADO da página depois — é o que corta 40% das
  // idas ao servidor (medido no mercado, §5 da pesquisa).
  assert.match(receipt, /— a página DEPOIS da\(s\) ação\(ões\) —/u)
  assert.match(receipt, /valor="a@b\.c"/u, 'a leitura pós-ação prova que o campo mudou')

  // O `fill` entra pelo setter do DOM (é o que o React escuta), e o clique é
  // ponteiro de verdade no centro do alvo.
  assert.equal(fixture.input.value, 'a@b.c')
  assert.deepEqual(fixture.input.events, ['input', 'change'])
  const pressed = inputs().filter((entry) => entry.params.type === 'mousePressed')
  assert.equal(pressed.length, 1)
  assert.deepEqual({ x: pressed[0].params.x, y: pressed[0].params.y }, { x: 65, y: 166 })
})

test('ACT: o lote PARA no primeiro erro, o passo seguinte NÃO roda, e o read volta assim mesmo', async () => {
  const fixture = makeFixture({ items: 0 })
  const { session, inputs } = await sessionOn(fixture)
  const read = await session.read({ filter: 'interactive' })
  const salvar = refIn(read, 'Salvar')
  const cancelar = refIn(read, 'Cancelar')

  const receipt = await session.act([
    { action: 'click', ref: salvar },
    { action: 'press', key: 'TeclaQueNaoExiste' },
    { action: 'click', ref: cancelar }
  ])

  assert.match(receipt, /PAROU no passo 2 de 3 — os passos seguintes NÃO rodaram/u)
  assert.match(receipt, /1\. click em button "Salvar"/u)
  assert.match(receipt, /2\. tecla desconhecida: "TeclaQueNaoExiste"/u)
  assert.match(receipt, /Receita: use nomes como Enter, Tab, Escape/u)
  assert.equal(receipt.includes('3.'), false, 'o terceiro passo não pode ter recibo')
  // A prova mecânica de que o 3º nem foi TENTADO: um clique só chegou ao CDP.
  assert.equal(inputs().filter((entry) => entry.params.type === 'mousePressed').length, 1)
  // E mesmo tendo parado, o agente precisa ver em que estado a página ficou.
  assert.match(receipt, /— a página DEPOIS da\(s\) ação\(ões\) —/u)
  assert.match(receipt, /button "Salvar"/u)
})

test('ACT: alvo COBERTO avisa e acontece; alvo sem ponto RECUSA; e o lote tem teto', async () => {
  const fixture = makeFixture({ items: 0 })
  const { session } = await sessionOn(fixture)
  const read = await session.read({ filter: 'interactive' })
  const salvar = refIn(read, 'Salvar')

  fixture.topAt = () => fixture.modal
  const coberto = await session.act([{ action: 'click', ref: salvar }])
  // Recusar aqui ESCONDERIA o fato: o dono clicando teria o mesmo desfecho. O
  // recibo conta a verdade e segue.
  assert.match(coberto, /COBERTO por div#modal\.overlay\.grande/u)
  assert.match(coberto, /1 ação\(ões\) executada\(s\)/u)
  fixture.topAt = null

  const semAlvo = await session.act([{ action: 'click' }])
  assert.match(semAlvo, /click sem alvo: informe `ref` \(do browser_read\) ou `x`\/`y`/u)

  const gigante = await session.act(
    Array.from({ length: BROWSER_ACT_MAX_STEPS + 1 }, () => ({ action: 'click', ref: salvar }))
  )
  assert.match(gigante, new RegExp(`teto de ${BROWSER_ACT_MAX_STEPS}`, 'u'))
  assert.match(gigante, /quebre em duas chamadas/u)
  assert.match(await session.act([]), /nenhuma ação pedida/u)
})

// ————————————————————————————————————————————————————————————————
// A SONDA — o veredito visual EM TEXTO (o que mata o QA de 40-50 min)
// ————————————————————————————————————————————————————————————————

test('PROBE/WCAG: a matemática do contraste é a da norma, não uma aproximação', () => {
  const preto = parseCssColor('#000')
  const branco = parseCssColor('rgb(255, 255, 255)')
  assert.equal(Math.round(contrastRatio(preto, branco) * 100) / 100, 21)
  assert.equal(contrastRatio(branco, branco), 1)
  assert.deepEqual(parseCssColor('#d96c3f'), { r: 217, g: 108, b: 63, a: 1 })
  assert.equal(parseCssColor('não é cor'), null)

  // O fundo EFETIVO sobe a cadeia até a primeira OPACA e compõe o que veio
  // antes — sem isso, todo elemento transparente daria contraste de mentira.
  assert.deepEqual(effectiveBackground(['rgba(0, 0, 0, 0)', 'rgba(255, 255, 255, 0.5)', 'rgb(0, 0, 0)']), {
    r: 128,
    g: 128,
    b: 128,
    a: 1
  })
  // Cadeia sem nada opaco cai no papel branco do Chromium.
  assert.deepEqual(effectiveBackground([]), { r: 255, g: 255, b: 255, a: 1 })

  assert.equal(isLargeText(24, 400), true)
  assert.equal(isLargeText(19, 700), true)
  assert.equal(isLargeText(19, 400), false)
  const razao = contrastRatio(parseCssColor('#d96c3f'), parseCssColor('#efe9dc'))
  assert.equal(wcagVerdict(razao, 14, 400).aaFloor, 4.5)
  assert.equal(wcagVerdict(razao, 28, 400).aaFloor, 3, 'texto grande baixa o piso')
})

test('PROBE: o acento da casa sobre o papel REPROVA em AA — com a razão e a receita', async () => {
  const fixture = makeFixture({ items: 0 })
  const { session } = await sessionOn(fixture)
  const read = await session.read({ filter: 'interactive' })
  const salvar = refIn(read, 'Salvar')

  const report = await session.probe({ ref: salvar })
  // Papel igual à tag não vira `button <button>`: o cabeçalho não repete.
  assert.match(report, /^<button> "Salvar"/u)
  assert.match(report, /caixa: x=20 y=150 90x32 \(na página: 20,150\) · viewport 1000x800/u)
  assert.match(report, /visível: sim · dentro da viewport: sim/u)
  // #d96c3f sobre #efe9dc = 2,81:1. É o acento REAL da casa sobre o papel REAL,
  // e ele reprova para texto normal — o fato que só um número consegue dizer.
  assert.match(report, /contraste: 2\.81:1 — REPROVA em AA \(texto normal: 14px peso 400, piso AA 4\.5:1\)/u)
  assert.match(report, /texto rgb\(217, 108, 63\) sobre fundo efetivo rgb\(239, 233, 220\)/u)
  assert.match(report, /o fundo é composto/u, 'o botão não pinta o próprio fundo, e o recibo diz')
  assert.match(report, /RECEITA: para passar em AA este par precisa de 4\.5:1/u)
  assert.match(report, /oclusão: nenhuma/u)
  assert.match(report, /transbordo: nenhum/u)
})

test('PROBE: transbordo, corte por ancestral e OCLUSÃO viram três linhas nomeadas', async () => {
  const fixture = makeFixture({ items: 0 })
  const { session } = await sessionOn(fixture)
  const read = await session.read({ filter: 'interactive' })
  const campo = refIn(read, 'textbox')

  fixture.input.overflowW = 400
  fixture.input.style.textOverflow = 'ellipsis'
  fixture.form.style.overflow = 'hidden'
  fixture.form.rect = { left: 20, top: 90, width: 150, height: 100 }
  fixture.topAt = () => fixture.modal

  const report = await session.probe({ ref: campo, styles: ['gap'] })
  assert.match(report, /TRANSBORDA: horizontal \(conteúdo 400px em 200px de caixa\)/u)
  assert.match(report, /cortado com reticências/u)
  assert.match(report, /CORTADO por <form> \(overflow\): 50px à direita/u)
  assert.match(report, /COBERTO: no ponto central quem recebe o clique é div#modal\.overlay\.grande/u)
  assert.match(report, /estilos computados:/u)
  assert.match(report, /\n {2}display: block/u, 'o conjunto base vem sempre, sem o agente pedir')
})

test('PROBE: ref de outra leitura RECUSA com a MESMA receita do act', async () => {
  const fixture = makeFixture({ items: 0 })
  const { session, emit } = await sessionOn(fixture)
  const read = await session.read({ filter: 'interactive' })
  const salvar = refIn(read, 'Salvar')

  emit('Page.frameNavigated', { frame: { url: 'http://localhost:5173/outra' } })
  const stale = await session.probe({ ref: salvar })
  assert.ok(stale.includes(BROWSER_STALE_REF_RECIPE))

  const semAlvo = await session.probe({})
  assert.match(semAlvo, /informe ref \(do browser_read\) ou selector/u)
})

// ————————————————————————————————————————————————————————————————
// Honestidade: nenhuma tool devolve silêncio com cara de sucesso
// ————————————————————————————————————————————————————————————————

test('WAIT: a espera esgotada NOMEIA as três saídas — "esperei e não veio" quase sempre é página quebrada', async () => {
  const fixture = makeFixture({ items: 0 })
  const { session } = await sessionOn(fixture)
  assert.match(await session.wait({ text: 'Painel da missão', timeoutMs: 400 }), /apareceu depois de/u)
  const timeout = await session.wait({ text: 'texto que nunca aparece', timeoutMs: 300 })
  assert.match(timeout, /ESPERA ESGOTADA em 300ms/u)
  assert.match(timeout, /browser_read/u)
  assert.match(timeout, /browser_console/u)
  assert.ok(timeout.includes(String(BROWSER_WAIT_MAX_MS)))
})

test('REDE: domínio que não subiu DIZ que não há registro — a ausência de linha não é rede limpa', async () => {
  const fixture = makeFixture({ items: 0 })
  const events = []
  const { session } = await sessionOn(fixture, {
    refuse: (method) => method === 'Network.enable',
    log: (entry) => events.push(entry)
  })
  const receipt = session.networkText({})
  assert.match(receipt, /NÃO existe registro de requisição/u)
  assert.match(receipt, /NÃO significa que a rede está limpa/u)
  assert.match(receipt, /browser_console/u)
  // E a espera por ociosidade recusa em vez de responder "rede ociosa" com o
  // contador de requisições em voo travado em zero.
  const idle = await session.wait({ networkIdle: true, timeoutMs: 300 })
  assert.match(idle, /não posso esperar a rede/u)
  assert.match(idle, /espere por `selector` ou `text`/u)
  assert.ok(events.some((entry) => entry.event === 'browser-cdp-domain-off'))
})

test('REGISTRO: uma sessão por aba, e a aba morta some do mapa sozinha', async () => {
  const fixture = makeFixture({ items: 0 })
  const registry = new BrowserDriverRegistry()
  const a = makeFakePage(fixture)
  const b = makeFakePage(fixture)
  assert.equal(registry.for(a.page), registry.for(a.page), 'a mesma aba reusa a sessão (e o epoch)')
  assert.notEqual(registry.for(a.page), registry.for(b.page))
  a.page.destroyed = true
  // A varredura mora no `for`: nenhum ponto do app precisa lembrar de limpar o
  // motor — e é justamente esse tipo de lembrete que se perde.
  assert.notEqual(registry.for(b.page).constructor, undefined)
  a.page.destroyed = false
  assert.notEqual(registry.for(a.page), undefined)
})

// ————————————————————————————————————————————————————————————————
// B. A FOTO — carimbo de frescor (LEI 2) e imagem inline só do claude
// ————————————————————————————————————————————————————————————————

function fakeImage(width = 1600, height = 900) {
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: (options) => fakeImage(options.width, Math.round((height * options.width) / width)),
    toJPEG: () => Buffer.from('j'.repeat(2048)),
    toPNG: () => Buffer.from('p'.repeat(4096))
  }
  return image
}

/** O DONO da aba desta conversa (D1 do design de 2026-09-01). O `paneId` é o da
 *  `IDENTITY` abaixo de propósito: é ele que o `withSession` usa para achar A
 *  ABA DELA — nunca a aba ativa da missão, que pode ser a de um vizinho. */
const OWNER_DEV = Object.freeze({ kind: 'dev', label: 'dev', paneId: 'gui-dev-abcd1234' })

/** O `BrowserManager` da H1 pelo buraco por onde a H2 o enxerga. */
function toolkitOn(t, fixture, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-browser-shot-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const host = makeFakePage(fixture, options.page)
  const tab = {
    tabId: 'tab-1',
    webContents: Object.assign(host.page, {
      capturePage: options.capturePage ?? (async () => fakeImage())
    })
  }
  const driving = []
  const ensured = []
  const closedOwners = []
  const logs = []
  // A LARGURA QUE A PÁGINA ENXERGA (2026-08-29) mora no MOTOR, não no CDP: o
  // dublê guarda o modo como o manager real guarda, para a suíte poder provar
  // que a tool escreve ALI — e não numa segunda verdade só dela.
  const viewport = { mode: 'auto', frameWidth: options.frameWidth ?? 400, writes: [] }
  const owner = options.owner ?? OWNER_DEV
  const tabs = options.tabs ?? [
    {
      tabId: 'tab-1',
      title: 'Missão · Synkora',
      url: 'http://localhost:5173/board',
      active: true,
      owner,
      driving: false
    }
  ]
  const manager = {
    ensureTab: async (missionId, projectId, url, tabOwner) => {
      ensured.push({ missionId, projectId, url, owner: tabOwner })
      return tab
    },
    // A PORTA DE ENTRADA das tools desde 2026-09-01: a aba DESTA identidade. O
    // dublê devolve a aba ativa em `activeTab` MESMO com `noTab` ligado — é
    // assim que a suíte prova que a recusa não cai de volta na aba do vizinho.
    tabOf: () => (options.noTab ? undefined : tab),
    activeTab: () => tab,
    listTabs: () => tabs,
    selectTab: () => true,
    closeMission: () => undefined,
    closeTabsOf: (ownerPaneId) => {
      closedOwners.push(ownerPaneId)
      return 1
    },
    setAgentDriving: (missionId, on, tabId) => driving.push({ missionId, on, tabId }),
    ...(options.captureReadiness ? { captureReadiness: options.captureReadiness } : {}),
    ...(options.noViewport
      ? {}
      : {
          setViewportMode: (missionId, mode, actor, tabId) => {
            viewport.writes.push({ missionId, mode, actor, tabId })
            if (options.refuseViewport) return { ok: false, error: options.refuseViewport }
            viewport.mode = mode
            return { ok: true }
          },
          viewportOf: () => viewport.mode,
          viewportFrameWidth: () => viewport.frameWidth
        })
  }
  const tools = buildGuiBrowserTools({
    manager,
    resolveTarget: (id) =>
      options.noTarget ? undefined : { missionId: 'missao-1', projectId: 'universo-1', root, owner },
    cliOf: () => options.cli ?? 'claude',
    log: (entry) => logs.push(entry)
  })
  return { tools, root, driving, host, viewport, ensured, closedOwners, logs, tabs }
}

const IDENTITY = Object.freeze({
  paneId: 'gui-dev-abcd1234',
  projectId: 'universo-1',
  role: 'gui-delegator',
  cwd: 'C:/wt/missao-01',
  missionId: 'missao-1'
})

test('SHOT: o recibo traz caminho RELATIVO, medidas e o CARIMBO DE FRESCOR (lei 2)', async (t) => {
  const fixture = makeFixture({ items: 0 })
  const { tools } = toolkitOn(t, fixture, { page: { freshness: { frames: 2, ms: 14 } } })
  const result = await tools.shot(IDENTITY, { name: 'Dock colapsado' })

  assert.match(result.text, new RegExp(`^${BROWSER_SHOT_DIR}/missao-1/001-dock-colapsado\\.jpg`, 'u'))
  assert.match(result.text, new RegExp(`reduzida de 1600px para caber no teto de ${BROWSER_SHOT_MAX_WIDTH}px`, 'u'))
  assert.match(result.text, /quadro FRESCO \(2 rAF em 14ms/u)
  assert.match(result.text, /CITE ESTE CAMINHO no chat/u, 'a foto é para o DONO ver — R36')
})

test('SHOT: quadro que NÃO pulsa vira AVISO honesto — nunca aprovação silenciosa', async (t) => {
  const fixture = makeFixture({ items: 0 })
  const { tools } = toolkitOn(t, fixture, { page: { freshness: { frames: 0, ms: 402 } } })
  const result = await tools.shot(IDENTITY, {})

  assert.match(result.text, /AVISO DE FRESCOR: o compositor NÃO pulsou \(0 quadro\(s\) em 402ms\)/u)
  assert.match(result.text, /NÃO aprove a tela por esta imagem/u)
  assert.match(result.text, /abra o painel BROWSER desta missão no dock/iu)
  // O carimbo é a MESMA frase do módulo: uma cópia divergiria na próxima rodada.
  assert.ok(result.text.includes(freshnessStamp({ frames: 0, ms: 402, pulsing: false })))
})

test('SHOT: a imagem inline é SÓ do claude — o codex descarta imagem de MCP', async (t) => {
  const fixture = makeFixture({ items: 0 })
  const claude = toolkitOn(t, fixture, { cli: 'claude' })
  const comImagem = await claude.tools.shot(IDENTITY, {})
  assert.ok(comImagem.image, 'o claude ganha a imagem de carona')
  assert.equal(comImagem.image.mimeType, 'image/jpeg')

  const codex = toolkitOn(t, fixture, { cli: 'codex' })
  const semImagem = await codex.tools.shot(IDENTITY, {})
  assert.equal(semImagem.image, undefined, 'mandar imagem ao codex seria pagar banda por nada')
  // O PRODUTO para os dois é o mesmo: o caminho no worktree.
  assert.match(semImagem.text, new RegExp(`^${BROWSER_SHOT_DIR}/missao-1/`, 'u'))
})

test('SHOT: a guarda da H1 recusa ANTES de trabalhar — e NADA é gravado', async (t) => {
  const fixture = makeFixture({ items: 0 })
  const written = []
  const { tools, root } = toolkitOn(t, fixture, {
    captureReadiness: () => ({
      ok: false,
      error: 'a janela do Synkora está minimizada/escondida — a captura pendura ali; restaure a janela e repita'
    }),
    capturePage: async () => {
      written.push('capturou')
      return fakeImage()
    }
  })
  const result = await tools.shot(IDENTITY, {})
  assert.match(result.text, /minimizada\/escondida/u)
  assert.match(result.text, /NADA foi gravado/u)
  assert.equal(written.length, 0, 'a recusa é ANTES da captura, não depois')
  assert.equal(result.image, undefined)
  assert.ok(root)
})

test('SHOT: a captura que PENDURA morre no relógio de 2s do módulo (o cinto da guarda)', async (t) => {
  const fixture = makeFixture({ items: 0 })
  const { tools } = toolkitOn(t, fixture, { capturePage: () => new Promise(() => undefined) })
  const result = await tools.shot(IDENTITY, {})
  // Sem este teto a chamada voltaria em 5-8s (P5) e o agente perderia a rodada.
  assert.match(result.text, /a captura PENDUROU/u)
  assert.match(result.text, /NADA foi gravado/u)
})

test('TOOLKIT: sem missão e sem aba, a recusa nomeia a receita e o ⚡ nem acende', async (t) => {
  const fixture = makeFixture({ items: 0 })
  const orfao = toolkitOn(t, fixture, { noTarget: true })
  assert.equal(await orfao.tools.read(IDENTITY, {}), BROWSER_NO_MISSION)
  assert.match(BROWSER_NO_MISSION, /NADA foi aberto/u)
  assert.deepEqual(orfao.driving, [], 'endereço órfão não acende o indicador de agente dirigindo')

  const fechado = toolkitOn(t, fixture, { noTab: true })
  const receipt = await fechado.tools.read(IDENTITY, {})
  // Desde 2026-09-01 a recusa é sobre A SUA aba, não sobre "o browser da
  // missão": o browser pode estar abertíssimo — com a aba do dev na frente — e
  // ainda assim não haver aba SUA para ler.
  assert.equal(receipt, BROWSER_NO_TAB)
  assert.match(receipt, /SUA aba/u)
  assert.match(receipt, /chame browser_open/u)
})

test('TOOLKIT: toda tool de trabalho acende o ⚡ do chrome (o dono vê o agente dirigindo)', async (t) => {
  const fixture = makeFixture({ items: 0 })
  const { tools, driving } = toolkitOn(t, fixture)
  await tools.read(IDENTITY, {})
  await tools.probe(IDENTITY, { selector: 'button' })
  assert.ok(driving.length >= 2)
  assert.ok(driving.every((entry) => entry.missionId === 'missao-1'))
  assert.equal(driving[0].on, true)
  // ⚡ POR ABA (D2): com uma frota na mesma missão, o indicador tem de dizer
  // QUAL aba está sendo dirigida — senão o dono vê a missão inteira piscando e
  // não sabe quem está mexendo em quê.
  assert.ok(
    driving.every((entry) => entry.tabId === 'tab-1'),
    'o ⚡ nomeia a aba de quem chamou'
  )
})

// ————————————————————————————————————————————————————————————————
// B1. A ABA É SUA (2026-09-01) — a fronteira que o design D1/D7 move
// ————————————————————————————————————————————————————————————————
//
// Antes, TODA tool operava na aba ATIVA da missão (`withSession` → `activeTab`).
// A medição de 01/09 (missão 86a05c06) mostrou o preço: o ajudante do
// `finish_ui_review` e o dev alternando a mesma aba entre a porta 8791 e as
// 8159/8148/8163, três leituras do ajudante caindo na PÁGINA DO DEV. A porta de
// entrada passou a ser `tabOf(missão, paneId da identidade)`.

test('SUA ABA: a tool NUNCA cai na aba do vizinho — sem a sua, a recusa manda abrir a sua', async (t) => {
  const fixture = makeFixture({ items: 0 })
  // `tabOf` vazio e `activeTab` CHEIO: é exatamente a cena da colisão. Cair no
  // `activeTab` aqui seria ler a página do dev e relatá-la como se fosse a sua.
  const { tools, driving } = toolkitOn(t, fixture, { noTab: true })
  const recusa = await tools.read(IDENTITY, {})
  assert.match(recusa, /SUA aba/u)
  assert.match(recusa, /browser_open/u, 'a recusa nomeia a RECEITA — beco sem saída é bug')
  assert.deepEqual(driving, [], 'sem aba, o ⚡ nem acende')

  // A cerca vale para a família inteira, não só para o `read`.
  for (const chamada of [
    () => tools.find(IDENTITY, { query: 'salvar' }),
    () => tools.act(IDENTITY, { actions: [{ action: 'click', ref: 1 }] }),
    () => tools.probe(IDENTITY, { selector: 'button' }),
    () => tools.viewport(IDENTITY, { preset: 'mobile' }),
    () => tools.evaluate(IDENTITY, { expression: '1' }),
    () => tools.wait(IDENTITY, { ms: 1 })
  ]) {
    assert.match(await chamada(), /browser_open/u)
  }
  const foto = await tools.shot(IDENTITY, {})
  assert.match(foto.text, /browser_open/u)
})

test('SUA ABA: `browser_open` leva o DONO ao motor — é assim que a aba nasce dela', async (t) => {
  const fixture = makeFixture({ items: 0 })
  const { tools, ensured } = toolkitOn(t, fixture)
  await tools.open(IDENTITY, { url: 'localhost:8791' })
  assert.equal(ensured.length, 1)
  assert.equal(ensured[0].url, 'localhost:8791')
  assert.deepEqual(ensured[0].owner, OWNER_DEV, 'o motor recebe QUEM está abrindo')
})

test('TOOLKIT/RECUPERAÇÃO: falha ao conectar uma aba aberta devolve receita e permite nova tentativa', async (t) => {
  let unavailable = true
  const { tools, logs, ensured } = toolkitOn(t, makeFixture({ items: 0 }), {
    page: { refuse: (method) => method === 'Page.enable' && unavailable }
  })
  const result = await tools.open(IDENTITY, {})
  assert.match(result, /SUA aba está aberta/u)
  assert.match(result, /browser_open/u)
  assert.match(result, /NENHUMA tela foi verificada/u)
  assert.doesNotMatch(result, /NADA foi aberto/u)
  const failed = logs.find(({ event }) => event === 'browser-open-incomplete')
  assert.equal(failed.ids.paneId, IDENTITY.paneId)
  assert.equal(failed.detail.stage, 'attach')
  unavailable = false
  assert.match(await tools.open(IDENTITY, {}), /Painel da missão/u)
  assert.equal(ensured.length, 2, 'a próxima tentativa continua na aba da mesma identidade')
})

test('TOOLKIT/RECUPERAÇÃO: CDP sem resposta termina no teto e a mesma aba pode recuperar', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { tools, host, logs } = toolkitOn(t, makeFixture({ items: 0 }))
  const send = host.page.debugger.sendCommand
  let unavailable = true
  host.page.debugger.sendCommand = (method, params) =>
    method === 'Page.enable' && unavailable ? new Promise(() => {}) : send(method, params)
  let settled = false
  const opened = tools.open(IDENTITY, {}).then((result) => { settled = true; return result })
  await new Promise((resolve) => setImmediate(resolve))
  t.mock.timers.tick(BROWSER_CDP_TIMEOUT_MS - 1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  assert.match(await opened, /NENHUMA tela foi verificada/u)
  assert.equal(logs.find(({ event }) => event === 'browser-open-incomplete').detail.stage, 'attach')
  unavailable = false
  assert.match(await tools.open(IDENTITY, {}), /Painel da missão/u)
})

test('TOOLKIT/RECUPERAÇÃO: falha na leitura inicial também tem receita sem alegar aba fechada', async (t) => {
  let evaluations = 0
  const { tools, logs } = toolkitOn(t, makeFixture({ items: 0 }), {
    page: { refuse: (method) => method === 'Runtime.evaluate' && ++evaluations === 2 }
  })
  assert.match(await tools.open(IDENTITY, {}), /SUA aba está aberta/u)
  assert.equal(logs.find(({ event }) => event === 'browser-open-incomplete').detail.stage, 'read')
  assert.match(await tools.open(IDENTITY, {}), /Painel da missão/u)
})

test('SUA ABA: sem `url`, o `browser_open` devolve a leitura e a LISTA com o dono de cada aba', async (t) => {
  const fixture = makeFixture({ items: 0 })
  const { tools } = toolkitOn(t, fixture, {
    tabs: [
      {
        tabId: 'tab-1',
        title: 'Board',
        url: 'http://localhost:8159/',
        active: false,
        owner: OWNER_DEV,
        driving: false
      },
      {
        tabId: 'tab-9',
        title: 'QA da landing',
        url: 'http://localhost:8791/',
        active: true,
        owner: { kind: 'helper', label: 'inv-brand', paneId: 'helper-mcp-1111' },
        driving: true
      },
      {
        tabId: 'tab-7',
        title: 'docs',
        url: 'https://exemplo.test/',
        active: false,
        owner: { kind: 'user', label: 'dono' },
        driving: false
      }
    ]
  })
  const texto = await tools.open(IDENTITY, {})

  // CONSCIÊNCIA, não controle (D7): o agente vê que existem outras abas e de
  // quem elas são — e não tem verbo nenhum para dirigi-las.
  assert.match(texto, /abas desta missão/u)
  assert.match(texto, /▸/u, 'a ativa é marcada')
  assert.match(texto, /⚡/u, 'quem está sendo dirigida é marcada')
  assert.match(texto, /ajudante "inv-brand"/u)
  assert.match(texto, /dono/u)
  assert.match(texto, /a SUA/u, 'a sua aba é apontada na lista')
  // A instrução velha morreu junto com o parâmetro: focar aba alheia não é ação
  // do agente.
  assert.doesNotMatch(texto, /tabId/u)
})

test('DIÁRIO: `browser-open` sai com `ids` (pane, missão, projeto) e com o DONO da aba', async (t) => {
  const fixture = makeFixture({ items: 0 })
  const { tools, logs } = toolkitOn(t, fixture)
  await tools.open(IDENTITY, { url: 'localhost:8791' })
  const aberto = logs.find((entry) => entry.event === 'browser-open')
  assert.ok(aberto, 'o diário registra a abertura')
  // "`browser-open` no diário sai SEM `paneId` (não se sabe quem abriu)" era a
  // medição de 01/09; D6 fecha esse buraco.
  assert.deepEqual(aberto.ids, {
    paneId: 'gui-dev-abcd1234',
    missionId: 'missao-1',
    projectId: 'universo-1'
  })
  assert.deepEqual(aberto.detail.owner, OWNER_DEV)
})

// ————————————————————————————————————————————————————————————————
// B2. A LARGURA QUE A PÁGINA ENXERGA — uma autoridade só (2026-08-29)
// ————————————————————————————————————————————————————————————————
//
// A reprovação do dono: *"ta meio limitado o quanto consigo deixar ele maior,
// meio que sempre vou ver o site/app com modo tablet"*. O painel é estreito, e a
// página renderizava na largura FÍSICA dele.
//
// O que estas cercas prendem NÃO é o zoom (isso é do `test:browser-pane`): é a
// FRONTEIRA. `browser_viewport` deixou de emular tamanho por CDP e passou a
// escrever o estado do MOTOR — o mesmo que o seletor do chrome do dono mostra.
// Se um dia alguém devolver o `Emulation.setDeviceMetricsOverride` para cá,
// existirão duas verdades sobre a largura e o seletor do dono passará a mentir.

test('VIEWPORT: os presets do agente são os MESMOS botões do dono — e `desktop` é 1280', async (t) => {
  const fixture = makeFixture({ items: 0 })
  const { tools, viewport, host } = toolkitOn(t, fixture)

  await tools.viewport(IDENTITY, { preset: 'desktop' })
  // O `actor` viaja junto: a caixa-preta não pode creditar ao DONO a emulação
  // que o agente ligou sozinho (os dois escrevem o mesmo campo). E desde
  // 2026-09-01 a ABA viaja também: a largura é da SUA aba, não da que o dono
  // está olhando.
  assert.deepEqual(viewport.writes.at(-1), {
    missionId: 'missao-1',
    mode: 1280,
    actor: 'agent',
    tabId: 'tab-1'
  })
  await tools.viewport(IDENTITY, { preset: 'tablet' })
  assert.equal(viewport.writes.at(-1).mode, 768)
  await tools.viewport(IDENTITY, { preset: 'mobile' })
  assert.equal(viewport.writes.at(-1).mode, 375)
  // `auto` é a porta de VOLTA: a moldura de verdade, sem emulação nenhuma.
  await tools.viewport(IDENTITY, { preset: 'auto' })
  assert.equal(viewport.writes.at(-1).mode, 'auto')
  // `width` livre vence o preset (o dono vê o número na ficha do chrome).
  await tools.viewport(IDENTITY, { preset: 'mobile', width: 1440 })
  assert.equal(viewport.writes.at(-1).mode, 1440)

  // A CERCA DE VERDADE: nenhuma dessas idas emulou TAMANHO por CDP. O tamanho é
  // do motor; o que sobrou de emulação aqui é só o tema.
  assert.equal(
    host.sent.filter((entry) => entry.method === 'Emulation.setDeviceMetricsOverride').length,
    0,
    'a largura voltou a ser emulada por CDP — o seletor do dono agora mente'
  )
})

test('VIEWPORT: o recibo conta a ESCALA, o piso do Chromium e o controle COMPARTILHADO', async (t) => {
  const fixture = makeFixture({ items: 0 })
  const { tools } = toolkitOn(t, fixture, { frameWidth: 400 })
  const receipt = await tools.viewport(IDENTITY, { preset: 'desktop' })

  assert.match(receipt, /1280px lógicos/u)
  assert.match(receipt, /ESCALADA \(0\.313×\) para caber na moldura de 400px/u)
  // O agente NÃO pode converter medida nenhuma: probe e act falam em lógico.
  assert.match(receipt, /pixels LÓGICOS/u)
  // E ele precisa saber que o dono vê (e muda) o mesmo estado — senão relata ao
  // dono uma emulação que o dono está olhando de outro jeito.
  assert.match(receipt, /O DONO vê e muda este mesmo modo pelo seletor do chrome/u)
  assert.match(receipt, /AUTO · 375 · 768 · 1280/u)

  // MOLDURA ESTREITA: o Chromium não desce de 0,25× de zoom (medido na sonda),
  // então a página recebe 1200px, não 1280 — e o recibo DIZ, com a saída.
  const apertado = toolkitOn(t, makeFixture({ items: 0 }), { frameWidth: 300 })
  const nota = await apertado.tools.viewport(IDENTITY, { preset: 'desktop' })
  assert.match(nota, /ATENÇÃO: a moldura é estreita demais para 1280px/u)
  assert.match(nota, /recebeu 1200px, não 1280px/u)
  assert.match(nota, /alargue o painel .* ou destaque o browser em janela própria/u)
})

test('VIEWPORT: com a largura CABENDO, o recibo diz TAMANHO REAL e de quem são as faixas', async (t) => {
  // A ordem do dono (2026-08-29): preset menor que a moldura vira MOLDURA DE
  // DISPOSITIVO — a página em tamanho real, centralizada, com faixas do app dos
  // lados. O agente precisa disto escrito por dois motivos concretos:
  // `browser_shot` fotografa a PÁGINA (375px), não a moldura com as faixas
  // dentro; e um defeito visto ali é do SITE, sem a dúvida "será que foi a
  // escala?" — que é exatamente a dúvida que o dono mandou matar.
  const { tools } = toolkitOn(t, makeFixture({ items: 0 }), { frameWidth: 1400 })
  const recibo = await tools.viewport(IDENTITY, { preset: 'mobile' })

  assert.match(recibo, /375px lógicos em TAMANHO REAL \(zoom 1, sem escala nenhuma\)/u)
  assert.match(recibo, /CENTRALIZADOS na moldura de 1400px, com 512px de faixa do APP de cada lado/u)
  assert.match(recibo, /browser_shot captura 375px \(a página\)/u)
  assert.match(recibo, /o que estiver quebrado dentro deles é do SITE/u)
  // E a palavra que ficou PROIBIDA neste ramo: nada foi escalado.
  assert.doesNotMatch(recibo, /ESCALADA/u)
  assert.doesNotMatch(recibo, /ATENÇÃO/u, 'o piso do Chromium não morde onde não há escala')

  // O ramo que ENCOLHE continua contando a escala, na MESMA moldura larga: é a
  // prova de que os dois recados são de ramos diferentes e não se misturam.
  const encolhe = await tools.viewport(IDENTITY, { width: 2400 })
  assert.match(encolhe, /ESCALADA \(0\.583×\) para caber na moldura de 1400px/u)
  assert.doesNotMatch(encolhe, /faixa do APP/u)
})

test('VIEWPORT: o TEMA continua sendo CDP — e largura sem motor não vira silêncio', async (t) => {
  const fixture = makeFixture({ items: 0 })
  const { tools, viewport, host } = toolkitOn(t, fixture)

  // Só o tema: emulação de MÍDIA é do driver, e o motor não é tocado.
  const soTema = await tools.viewport(IDENTITY, { colorScheme: 'dark' })
  const media = host.sent.filter((entry) => entry.method === 'Emulation.setEmulatedMedia')
  assert.equal(media.length, 1)
  assert.deepEqual(media[0].params.features, [{ name: 'prefers-color-scheme', value: 'dark' }])
  assert.equal(viewport.writes.length, 0, 'tema não mexe na largura')
  assert.match(soTema, /tema: dark/u)
  // O recibo do tema ainda conta a largura de agora: é ela que explica as
  // medidas que o `browser_probe` vai devolver na sequência.
  assert.match(soTema, /largura: AUTO/u)

  // Largura fora da faixa: recusa com receita, e NADA foi escrito.
  const invalida = await tools.viewport(IDENTITY, { width: 99 })
  assert.match(invalida, /largura não reconhecida/u)
  assert.match(invalida, /NADA mudou/u)
  assert.equal(viewport.writes.length, 0)

  // Nada pedido é nada feito — e a frase ensina o que existe.
  assert.match(await tools.viewport(IDENTITY, {}), /nada mudou — informe `preset`, `width` ou `colorScheme`/u)
})

test('VIEWPORT: motor sem a largura (harness velho) diz a VERDADE em vez de fingir', async (t) => {
  const fixture = makeFixture({ items: 0 })
  const { tools } = toolkitOn(t, fixture, { noViewport: true })
  const receipt = await tools.viewport(IDENTITY, { preset: 'desktop', colorScheme: 'dark' })

  assert.match(receipt, /este harness não controla a largura da página/u)
  assert.match(receipt, /tema: dark/u, 'o que DEU para fazer, foi feito e dito')

  // E a recusa do motor (missão sem aba) chega inteira ao agente.
  const recusa = toolkitOn(t, makeFixture({ items: 0 }), {
    refuseViewport: 'o browser desta missão não está aberto — abra uma aba (+) antes de mudar a largura'
  })
  const texto = await recusa.tools.viewport(IDENTITY, { preset: 'desktop' })
  assert.match(texto, /abra uma aba \(\+\) antes de mudar a largura/u)
  assert.match(texto, /A largura NÃO mudou/u)
})

// ————————————————————————————————————————————————————————————————
// C. A CERCA DO CATÁLOGO — servidor MCP REAL, cliente MCP REAL
// ————————————————————————————————————————————————————————————————

const BROWSER_TOOLS = Object.freeze([
  'browser_act',
  'browser_console',
  'browser_eval',
  'browser_find',
  'browser_network',
  'browser_open',
  'browser_probe',
  'browser_read',
  'browser_shot',
  'browser_viewport',
  'browser_wait'
])
const LSP_TOOLS = Object.freeze(['lsp_definition', 'lsp_diagnostics', 'lsp_hover', 'lsp_references'])
// SKILLS 3.0 (2026-09-08 — fatia 5.D): as três `skill_*` seguem a MESMA cerca
// do browser (dev + ajudante + planejador sim, reviewer não), e por isso elas
// aparecem em todas as réguas de catálogo deste arquivo.
const SKILL_TOOLS = Object.freeze(['skill_discard', 'skill_pull', 'skill_search'])
const PLANNER_TOOLS = Object.freeze(['delete_plan', 'get_plan', 'list_plans', 'propose_plan', 'update_plan'])
const DELEGATOR_TOOLS = Object.freeze([
  'delegate',
  'helper_cancel',
  'helper_result',
  'helper_resume',
  'helper_send',
  'helpers_status',
  'list_seats'
])
const INTEGRATION_TOOLS = Object.freeze(['integration_run', 'integration_status'])
// R38 (2026-08-29): mais uma no catálogo do gui-release, o `release_done` — a
// cerca do browser (que é o que este teste prova) segue idêntica: o release
// continua sem NENHUMA `browser_*`.
const RELEASE_TOOLS = Object.freeze(['release_done', 'release_run', 'release_status'])

const sorted = (...groups) => Object.freeze([...groups.flat()].sort())

function hubIn(t) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-browser-catalog-'))
  const hub = new Hub({
    projectPathOf: () => root,
    ensureProjectRuntimeWritable: () => undefined,
    onEvent: () => undefined
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { hub, root }
}

/** O kit falso do browser: cada método devolve o texto que a suíte reconhece,
 *  para se poder afirmar QUAL tool o catálogo ligou em QUAL método. */
function stubBrowserKit(calls) {
  const answer = (name) => async (id, input) => {
    calls.push({ tool: name, paneId: id.paneId, input })
    return `recibo de ${name}`
  }
  return {
    open: answer('browser_open'),
    read: answer('browser_read'),
    find: answer('browser_find'),
    act: answer('browser_act'),
    probe: answer('browser_probe'),
    viewport: answer('browser_viewport'),
    console: answer('browser_console'),
    network: answer('browser_network'),
    evaluate: answer('browser_eval'),
    wait: answer('browser_wait'),
    shot: async (id, input) => {
      calls.push({ tool: 'browser_shot', paneId: id.paneId, input })
      return { text: '.synkora/browser/missao-1/001-tela.jpg — 1200x675px', image: { data: 'AAAA', mimeType: 'image/jpeg' } }
    }
  }
}

async function serverIn(t, hub, { browser = true, calls = [] } = {}) {
  const served = []
  const handle = await startMcpServer({
    hub,
    listPlans: () => 'nenhum plano ainda',
    getPlan: () => 'plano',
    proposePlan: () => 'apresentada ao dono',
    updatePlan: () => 'plano atualizado',
    deletePlan: () => 'plano arquivado',
    delegateHelpers: async () => 'abri ajudantes',
    listSeats: async () => 'contas',
    helpersStatus: () => 'nenhum vivo',
    helperResult: async () => 'entrega',
    helperSend: () => 'entregue',
    helperCancel: () => 'descartado',
    helperResume: () => 'retomado',
    integrationStatus: () => 'fila',
    integrationRun: async () => 'INTEGRADA',
    releaseStatus: () => 'release',
    releaseRun: async () => 'SUBIU',
    lsp: {
      diagnostics: async () => 'nenhum problema',
      definition: async () => 'src/b.ts:3:14',
      references: async () => 'src/a.ts:1:1',
      hover: async () => 'const foo: string'
    },
    ...(browser ? { browser: stubBrowserKit(calls) } : {}),
    noteCatalogServed: (id, tools) => served.push({ role: id.role, paneId: id.paneId, tools })
  })
  t.after(() => handle.close())
  return { url: new URL(`http://127.0.0.1:${handle.port}/mcp`), served, calls }
}

async function clientFor(t, url, token, label) {
  const client = new Client({ name: `synkora-${label}`, version: '1.0.0' }, { cachePartition: label })
  const transport = new StreamableHTTPClientTransport(url, { authProvider: { token: async () => token } })
  await client.connect(transport)
  t.after(() => client.close())
  return client
}

async function toolNames(url, token, label) {
  const client = new Client({ name: `synkora-${label}`, version: '1.0.0' }, { cachePartition: label })
  const transport = new StreamableHTTPClientTransport(url, { authProvider: { token: async () => token } })
  await client.connect(transport)
  try {
    return (await client.listTools()).tools.map((tool) => tool.name).sort()
  } finally {
    await client.close()
  }
}

function textOf(result) {
  const block = result.content?.find((item) => item.type === 'text')
  assert.ok(block, 'a tool devia responder com um bloco de texto')
  return block.text
}

test('CATÁLOGO: o browser chega a quem VERIFICA A PRÓPRIA TELA — dev e ajudante', async (t) => {
  const { hub, root } = hubIn(t)
  const { url, served } = await serverIn(t, hub)
  hub.registerPane('token-dev', {
    paneId: 'gui-dev-11111111',
    projectId: 'universo-1',
    role: 'gui-delegator',
    cwd: root,
    missionId: 'missao-1'
  })
  hub.registerPane('token-ajudante', {
    paneId: 'gui-helper-11111111-2',
    projectId: 'universo-1',
    role: 'ajudante',
    cwd: root,
    missionId: 'missao-1',
    delegatorPaneId: 'gui-dev-11111111'
  })

  assert.deepEqual(
    await toolNames(url, 'token-dev', 'cat-dev'),
    sorted(DELEGATOR_TOOLS, INTEGRATION_TOOLS, LSP_TOOLS, BROWSER_TOOLS, SKILL_TOOLS)
  )
  // O QA DELEGADO é o caso real do design: o dev abre um ajudante só para
  // varrer a tela enquanto ele segue no código.
  assert.deepEqual(
    await toolNames(url, 'token-ajudante', 'cat-ajudante'),
    sorted(LSP_TOOLS, BROWSER_TOOLS, SKILL_TOOLS)
  )
  // O recibo do catálogo servido (a caixa-preta do boot) conta a mesma história.
  const receipt = served.find((entry) => entry.paneId === 'gui-helper-11111111-2')
  assert.deepEqual([...receipt.tools].sort(), sorted(LSP_TOOLS, BROWSER_TOOLS, SKILL_TOOLS))
})

test('CATÁLOGO: reviewer, planejador e release NÃO recebem o browser — a cerca é mecânica', async (t) => {
  const { hub, root } = hubIn(t)
  const { url } = await serverIn(t, hub)
  // O REVIEWER é a exceção deliberada: o contrato dele é LER o diff e reportar,
  // não rodar o produto. E o papel mora no PANE ID, não no `role`.
  hub.registerPane('token-reviewer', {
    paneId: 'gui-reviewer-11111111',
    projectId: 'universo-1',
    role: 'gui-delegator',
    cwd: root,
    missionId: 'missao-1'
  })
  hub.registerPane('token-planner', {
    paneId: 'gui-dev-22222222',
    projectId: 'universo-1',
    role: 'gui-planner',
    cwd: root
  })
  hub.registerPane('token-release', {
    paneId: 'gui-dev-33333333',
    projectId: 'universo-1',
    role: 'gui-release',
    cwd: root,
    missionId: 'missao-3'
  })

  const rev = await toolNames(url, 'token-reviewer', 'cat-rev')
  assert.deepEqual(rev, sorted(DELEGATOR_TOOLS, LSP_TOOLS))
  // 2026-08-30: o planejador delega (kit de ajudantes no catálogo dele) — e a
  // propriedade DESTE teste segue de pé: browser continua fora; quem navega na
  // pesquisa dele é o AJUDANTE.
  const planner = await toolNames(url, 'token-planner', 'cat-planner')
  assert.deepEqual(planner, sorted(PLANNER_TOOLS, DELEGATOR_TOOLS, LSP_TOOLS, SKILL_TOOLS))
  const release = await toolNames(url, 'token-release', 'cat-release')
  assert.deepEqual(release, sorted(RELEASE_TOOLS, LSP_TOOLS))

  for (const [label, tools] of [
    ['reviewer', rev],
    ['planejador', planner],
    ['release', release]
  ]) {
    for (const forbidden of BROWSER_TOOLS) {
      assert.equal(tools.includes(forbidden), false, `o ${label} enxergou ${forbidden}`)
    }
  }

  // Os papéis mortos da era F6 continuam com catálogo VAZIO.
  for (const role of ['maestro', 'dev', 'review', 'qa', 'livre']) {
    hub.registerPane(`token-${role}`, { paneId: `pane-${role}`, projectId: 'universo-1', role, cwd: root })
    assert.deepEqual(await toolNames(url, `token-${role}`, `cat-${role}`), [])
  }
})

test('CERCA DE TEXTO: NENHUMA das onze devolve `structuredContent` — os dois CLIs leem texto', async (t) => {
  const { hub, root } = hubIn(t)
  const calls = []
  const { url } = await serverIn(t, hub, { calls })
  hub.registerPane('token-ajudante', {
    paneId: 'gui-helper-abcd1234-2',
    projectId: 'universo-1',
    role: 'ajudante',
    cwd: root,
    missionId: 'missao-1'
  })
  const client = await clientFor(t, url, 'token-ajudante', 'texto')

  const args = {
    browser_open: { url: 'localhost:5173' },
    browser_read: {},
    browser_find: { query: 'salvar' },
    browser_act: { actions: [{ action: 'click', ref: 1 }] },
    browser_probe: { ref: 1 },
    browser_shot: { name: 'tela' },
    browser_viewport: { preset: 'mobile' },
    browser_console: { onlyErrors: true },
    browser_network: {},
    browser_eval: { expression: 'document.title' },
    browser_wait: { text: 'pronto' }
  }
  for (const name of BROWSER_TOOLS) {
    const result = await client.callTool({ name, arguments: args[name] })
    assert.notEqual(result.isError, true, `${name} devia responder texto, nunca erro de protocolo`)
    // O codex e o claude leem o mesmo campo. Um `structuredContent` aqui seria
    // um segundo canal que só um dos dois enxerga — e a verdade se partiria.
    assert.equal(result.structuredContent, undefined, `${name} vazou structuredContent`)
    assert.ok(textOf(result).length > 0)
    for (const block of result.content) {
      assert.ok(['text', 'image'].includes(block.type), `${name} devolveu bloco ${block.type}`)
    }
  }
  // A única imagem do kit é a do shot, e ela vive no `content[]`, não num campo
  // estruturado.
  const shot = await client.callTool({ name: 'browser_shot', arguments: { name: 'tela' } })
  assert.equal(shot.content.filter((block) => block.type === 'image').length, 1)
  assert.equal(shot.structuredContent, undefined)

  // Cada tool do catálogo chegou ao MÉTODO do kit que leva o nome dela.
  assert.deepEqual([...new Set(calls.map((entry) => entry.tool))].sort(), [...BROWSER_TOOLS].sort())
  assert.ok(calls.every((entry) => entry.paneId === 'gui-helper-abcd1234-2'))
})

test('MOTOR DESLIGADO: as onze CONTINUAM no catálogo e dizem que NADA foi verificado', async (t) => {
  const { hub, root } = hubIn(t)
  const { url } = await serverIn(t, hub, { browser: false })
  hub.registerPane('token-dev', {
    paneId: 'gui-dev-44444444',
    projectId: 'universo-1',
    role: 'gui-delegator',
    cwd: root,
    missionId: 'missao-1'
  })
  const client = await clientFor(t, url, 'token-dev', 'desligado')

  // Tool que SOME do catálogo entre um boot e outro é o pior desfecho: o agente
  // racionaliza a ausência em vez de ler o motivo.
  const names = await toolNames(url, 'token-dev', 'lista-desligada')
  for (const tool of BROWSER_TOOLS) assert.ok(names.includes(tool), `${tool} sumiu do catálogo`)

  const result = await client.callTool({ name: 'browser_read', arguments: {} })
  assert.notEqual(result.isError, true, 'recusa é RESULTADO, nunca -32603 mudo')
  assert.equal(textOf(result), BROWSER_ENGINE_OFF)
  assert.match(BROWSER_ENGINE_OFF, /NADA foi aberto, NADA foi navegado e NENHUMA tela foi verificada/u)
  assert.match(BROWSER_ENGINE_OFF, /não relate QA visual nenhum ao dono/u)
})

test('CATÁLOGO: os schemas ENSINAM os tetos reais, e as descrições proíbem o browser de fora', async (t) => {
  const { hub, root } = hubIn(t)
  const { url } = await serverIn(t, hub)
  hub.registerPane('token-dev', {
    paneId: 'gui-dev-55555555',
    projectId: 'universo-1',
    role: 'gui-delegator',
    cwd: root,
    missionId: 'missao-1'
  })
  const client = await clientFor(t, url, 'token-dev', 'descricoes')
  const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]))

  // Descrição que mente sobre o próprio limite é pior que descrição ausente: os
  // números saem dos módulos que os APLICAM.
  assert.ok(tools.get('browser_read').description.includes(String(BROWSER_READ_DEFAULT_MAX_CHARS)))
  assert.equal(tools.get('browser_act').inputSchema.properties.actions.maxItems, BROWSER_ACT_MAX_STEPS)
  assert.ok(tools.get('browser_shot').description.includes(String(BROWSER_SHOT_MAX_WIDTH)))
  assert.ok(tools.get('browser_wait').description.includes(String(BROWSER_WAIT_MAX_MS)))
  // A dor que originou a feature entra no lugar onde o agente sempre olha.
  assert.match(tools.get('browser_open').description, /PROIBIDO abrir browser externo/u)
  // A ABA É SUA (D1/D7, 2026-09-01). Duas cercas no mesmo lugar: a descrição
  // ensina a semântica nova, e o `tabId` SUMIU do contrato — com uma aba por
  // identidade, focar a aba de outro não é ação do agente, e um parâmetro que
  // não faz nada é uma promessa falsa (a mesma régua que matou o `height` do
  // viewport).
  assert.match(tools.get('browser_open').description, /SUA aba/u)
  assert.equal(tools.get('browser_open').inputSchema.properties.tabId, undefined)
  assert.match(tools.get('browser_read').description, /SUA aba/iu)
  assert.match(tools.get('browser_shot').description, /SUA aba/iu)
  assert.match(tools.get('browser_probe').description, /não screenshot/u)
  assert.match(tools.get('browser_eval').description, /conteúdo NÃO-CONFIÁVEL/u)

  // A LARGURA (2026-08-29). Duas coisas na descrição, e as duas são a dor do
  // dono: (1) o painel é estreito, então SEM pedir desktop o agente julga a tela
  // pelo layout de celular — foi assim que ele mesmo passou a ver o produto; e
  // (2) o estado é COMPARTILHADO: o dono vê e muda o mesmo modo no chrome, e um
  // agente que não soubesse disso trataria uma mudança do dono como bug da
  // página.
  const viewport = tools.get('browser_viewport')
  assert.match(viewport.description, /o painel do browser é ESTREITO/iu)
  assert.match(viewport.description, /O DONO vê esta mesma largura no seletor do chrome/u)
  assert.match(viewport.description, /AUTO · 375 · 768 · 1280/u)
  assert.deepEqual(viewport.inputSchema.properties.preset.enum, ['auto', 'mobile', 'tablet', 'desktop'])
  // `height` SUMIU do contrato: sob a receita de zoom a altura acompanha a
  // moldura sozinha, e um parâmetro que não faz nada é uma promessa falsa.
  assert.equal(viewport.inputSchema.properties.height, undefined)
})

test('PRÉ-SANÇÃO (a lição da R14): as onze estão na lista do AJUDANTE e na do CHAT', () => {
  // Sem esta costura, o PRIMEIRO `browser_read` de um ajudante claude levanta
  // `can_use_tool`, não há ninguém para responder, e o motor traduz isso em
  // HELPER_PERMISSION_DEAD_END: o ajudante MORRE. Um QA visual são dezenas de
  // chamadas seguidas — sem a lista, cada uma viraria card de permissão para o
  // dono no gesto em que ele pediu para não precisar olhar.
  assert.equal(BROWSER_TOOL_NAMES.length, 11, 'onze tools, não setenta')
  assert.equal(new Set(BROWSER_TOOL_NAMES).size, 11, 'sem nome repetido')
  assert.deepEqual([...BROWSER_TOOL_NAMES].sort(), [...BROWSER_TOOLS].sort())

  for (const name of BROWSER_TOOL_NAMES) {
    const sanctioned = `mcp__synkora__${name}`
    assert.ok(
      GUI_HELPER_LSP_CLAUDE_ALLOWED_TOOLS.includes(sanctioned),
      `PRÉ-SANÇÃO DO AJUDANTE faltando para ${name} — sem ela o ajudante claude morre no primeiro uso`
    )
    assert.ok(
      GUI_DELEGATE_CLAUDE_ALLOWED_TOOLS.includes(sanctioned),
      `PRÉ-SANÇÃO DO CHAT faltando para ${name} — sem ela cada chamada vira card de permissão para o dono`
    )
  }
  // SKILLS 3.0 (2026-09-08): as três `skill_*` entram nas MESMAS duas listas e
  // pela MESMA razão — o ajudante que puxa uma skill sem pré-sanção morre no
  // can_use_tool, e o chat do dono ganharia um card por chamada.
  for (const name of SKILL_TOOLS) {
    const sanctioned = `mcp__synkora__${name}`
    assert.ok(
      GUI_HELPER_LSP_CLAUDE_ALLOWED_TOOLS.includes(sanctioned),
      `PRÉ-SANÇÃO DO AJUDANTE faltando para ${name}`
    )
    assert.ok(
      GUI_DELEGATE_CLAUDE_ALLOWED_TOOLS.includes(sanctioned),
      `PRÉ-SANÇÃO DO CHAT faltando para ${name}`
    )
  }
  // A pré-sanção é NARROW: nada nativo entra de carona pelo kit do browser.
  for (const allowed of GUI_HELPER_LSP_CLAUDE_ALLOWED_TOOLS) {
    assert.match(allowed, /^mcp__synkora__/u, `${allowed} não é ferramenta interna`)
  }
})
