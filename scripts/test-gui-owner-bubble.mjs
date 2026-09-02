// A BOLHA CONTA A VERDADE (D6 do design de 2026-09-02) + A FALA SEM PARAR
// (R39.1, mesmo dia).
//
// Queixa do dono, verbatim: "ele tá deixando na fila". A fala dele entrava no
// pote e a tela não dizia NADA — nem que o agente estava sendo parado, nem que
// a mensagem tinha sido entregue, nem que já havia sido respondida. Esta suíte
// prende as palavras, a régua que faz o estado só ANDAR PARA A FRENTE e o
// desenho do carimbo (recibo mono sob a bolha, nunca card).
//
// R39.1 — decisão do dono, verbatim: "pode ser sem parar, puro. Aí minha
// mensagem vai ficar lá. Só que eu quero que tenha alguma coisa, tipo que ela
// não foi lida ainda… E se eu quiser eu posso forçar, aí forçando ele para o
// turno e lê o que eu quero falar, quando for algo urgente." Entram `unread`
// (o ÚNICO estado com AÇÃO: o botão "ler agora") e `read` (o recibo de
// leitura), e a suíte prende também o botão, o nome dele e a recusa.
//
// Rodar: node --experimental-strip-types --test scripts/test-gui-owner-bubble.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  applyGuiOwnerMessageState,
  nextOwnerDelivery,
  ownerBubbleLabel,
  ownerDeliveryStamp,
  ownerForceLabel,
  ownerForceRefusalText
} from '../src/renderer/src/guiOwnerBubble.ts'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

/** `assert.match` num arquivo de 500 KB despeja o arquivo INTEIRO na falha e a
 *  prova de vermelho vira ilegível. Aqui a falha diz o que faltou e onde. */
const temNo = (fonte, regex, onde) => assert.ok(regex.test(fonte), `${onde}: falta ${regex}`)
const naoTemNo = (fonte, regex, onde) => assert.ok(!regex.test(fonte), `${onde}: sobra ${regex}`)

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
  // R39.1: a rota nova carrega o MESMO relógio e a MESMA regra de data.
  assert.deepEqual(ownerDeliveryStamp({ state: 'read', at: ontem }, NOW), {
    text: 'lida 01/09 21:33:46',
    tone: 'read'
  })
})

// ————————————— R39.1: as palavras novas e a única ação —————————————

test('R39.1 — "não lida ainda" e "lida hh:mm:ss" entram no vocabulário', () => {
  // A fala saiu para o CLI e espera a fronteira: NÃO tem relógio (não
  // aconteceu nada ainda para carimbar hora), e por isso `at` não importa.
  assert.equal(ownerDeliveryStamp({ state: 'unread', at: AT }, NOW).text, 'não lida ainda')
  assert.equal(ownerDeliveryStamp({ state: 'unread', at: AT }, NOW).tone, 'unread')
  assert.equal(ownerDeliveryStamp({ state: 'unread', at: Number.NaN }, NOW).text, 'não lida ainda')
  // O recibo de leitura: o CLI absorveu a fala às hh:mm:ss.
  assert.deepEqual(ownerDeliveryStamp({ state: 'read', at: AT }, NOW), {
    text: 'lida 21:33:46',
    tone: 'read'
  })
  // A rota antiga (pote entregue como turno novo) continua dizendo "entregue".
  assert.equal(ownerDeliveryStamp({ state: 'read', at: Number.NaN }, NOW), null)
})

test('R39.1 — `unread` é o ÚNICO estado que expõe uma AÇÃO', () => {
  const TODOS = ['unread', 'stopping', 'read', 'delivered', 'answered']
  const comAcao = TODOS.filter((state) => ownerDeliveryStamp({ state, at: AT }, NOW)?.action)
  assert.deepEqual(comAcao, ['unread'])
  // Depois que o CLI leu, forçar não significa mais nada — a ação some com o
  // motivo dela, não por regra de tela.
  assert.deepEqual(ownerDeliveryStamp({ state: 'unread', at: AT }, NOW).action, {
    label: 'ler agora',
    hint: 'força o agente a parar e ler esta mensagem agora — o que ele estava fazendo é cortado'
  })
  // A dica conta o CUSTO antes do clique: era exatamente esse o medo do dono.
  assert.match(
    ownerDeliveryStamp({ state: 'unread', at: AT }, NOW).action.hint,
    /é cortado$/u
  )
})

test('R39.1 — o nome acessível do botão CITA a fala que vai furar a fila', () => {
  assert.equal(ownerForceLabel('para tudo'), 'ler agora: "para tudo"')
  // "ler agora" repetido em três bolhas não diria QUAL delas; e uma fala
  // comprida não pode virar ladainha no leitor de tela.
  const comprida =
    'para o que você tá fazendo: o design da rodada mudou e a delegação inteira sai do gui-delegator'
  const nome = ownerForceLabel(comprida)
  assert.ok(nome.startsWith('ler agora: "para o que você tá fazendo'))
  assert.ok(nome.endsWith('…"'), nome)
  assert.ok(nome.length < comprida.length)
  // Quebra de linha vira espaço: nome acessível é UMA frase.
  assert.equal(ownerForceLabel('para\n  tudo'), 'ler agora: "para tudo"')
  // Fala vazia cai no rótulo puro — nome pela metade seria pior que nenhum.
  assert.equal(ownerForceLabel('   '), 'ler agora')
})

test('R39.1 — a recusa do main nomeia o que falhou e nunca sai vazia', () => {
  assert.equal(
    ownerForceRefusalText('a sessão não está mais viva'),
    'não deu para forçar a leitura — a sessão não está mais viva'
  )
  assert.equal(
    ownerForceRefusalText(undefined),
    'não deu para forçar a leitura — a sessão não respondeu'
  )
  assert.equal(
    ownerForceRefusalText('  '),
    'não deu para forçar a leitura — a sessão não respondeu'
  )
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
  // R39.1 — os estados novos entram no nome pelo mesmo caminho: o leitor de
  // tela ouve o recibo junto com a fala, sem nenhuma regra a mais.
  assert.equal(
    ownerBubbleLabel(ownerDeliveryStamp({ state: 'unread', at: AT }, NOW)),
    'sua mensagem — não lida ainda'
  )
  assert.equal(
    ownerBubbleLabel(ownerDeliveryStamp({ state: 'read', at: AT }, NOW)),
    'sua mensagem — lida 21:33:46'
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

test('R39.1 — a ordem do tempo nova: não lida → parando → lida → respondida', () => {
  // O caminho INTEIRO do "ler agora": a fala espera, o dono força, o CLI lê e
  // o agente responde.
  assert.deepEqual(nextOwnerDelivery(undefined, 'unread', AT), { state: 'unread', at: AT })
  assert.deepEqual(nextOwnerDelivery({ state: 'unread', at: AT }, 'stopping', AT + 10), {
    state: 'stopping',
    at: AT + 10
  })
  assert.deepEqual(nextOwnerDelivery({ state: 'stopping', at: AT }, 'read', AT + 20), {
    state: 'read',
    at: AT + 20
  })
  assert.deepEqual(nextOwnerDelivery({ state: 'read', at: AT }, 'answered', AT + 30), {
    state: 'answered',
    at: AT + 30
  })
  // A rota PADRÃO (sem forçar): a fala espera e o recibo chega sozinho.
  assert.deepEqual(nextOwnerDelivery({ state: 'unread', at: AT }, 'read', AT + 40), {
    state: 'read',
    at: AT + 40
  })
})

test('R39.1 — nada regride para "não lida", e lida/entregue dividem o mesmo degrau', () => {
  // Um `unread` atrasado não pode apagar o recibo que já está na tela.
  assert.equal(nextOwnerDelivery({ state: 'stopping', at: AT }, 'unread', AT + 5), null)
  assert.equal(nextOwnerDelivery({ state: 'read', at: AT }, 'unread', AT + 5), null)
  assert.equal(nextOwnerDelivery({ state: 'answered', at: AT }, 'unread', AT + 5), null)
  assert.equal(nextOwnerDelivery({ state: 'unread', at: AT }, 'unread', AT + 5), null)
  // `read` não volta para `stopping` (o corte já passou).
  assert.equal(nextOwnerDelivery({ state: 'read', at: AT }, 'stopping', AT + 5), null)
  // MESMA batida: "chegou nele" por duas rotas. Quem chega primeiro fica.
  assert.equal(nextOwnerDelivery({ state: 'read', at: AT }, 'delivered', AT + 5), null)
  assert.equal(nextOwnerDelivery({ state: 'delivered', at: AT }, 'read', AT + 5), null)
  // E o `answered` continua vencendo os dois.
  assert.deepEqual(nextOwnerDelivery({ state: 'read', at: AT }, 'answered', AT + 5), {
    state: 'answered',
    at: AT + 5
  })
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
  // R39.1 — o union cresceu com os dois estados novos, NA ORDEM DO TEMPO.
  temNo(api, /state: 'unread' \| 'stopping' \| 'read' \| 'delivered' \| 'answered'/u, 'guiApi.ts')
  // Espelho declarado (regra da casa): o comentário nomeia o par no main.
  const from = api.indexOf("type: 'owner-message-state'")
  assert.ok(from !== -1)
  assert.match(api.slice(Math.max(0, from - 1_600), from), /guiSessions\.ts/u)
})

test('R39.1 — a ponte do "ler agora" existe no preload e no espelho do renderer', () => {
  // O canal é contrato com o agente A (main): nome trocado = botão mudo.
  const preload = read('src/preload/index.ts')
  temNo(
    preload,
    /forceOwnerMessage: \(paneId: string, messageId: string\): Promise<GuiResult> =>\s*\n?\s*ipcRenderer\.invoke\('gui:forceOwnerMessage', paneId, messageId\)/u,
    'preload/index.ts'
  )
  const api = read('src/renderer/src/guiApi.ts')
  // O tipo da ponte + a chamada real (nenhum componente fala com
  // `window.synkora.gui` direto — a regra da casa em `guiApi.ts`).
  temNo(
    api,
    /forceOwnerMessage: \(paneId: string, messageId: string\) => Promise<\{ ok: boolean; error\?: string \}>/u,
    'guiApi.ts'
  )
  temNo(api, /async forceOwnerMessage\(/u, 'guiApi.ts')
  temNo(api, /await api\.forceOwnerMessage\(paneId, messageId\)/u, 'guiApi.ts')
  // Sem ponte no preload a UI avisa, nunca finge que funcionou.
  const from = api.indexOf('async forceOwnerMessage(')
  assert.match(api.slice(from, from + 500), /if \(!api\?\.forceOwnerMessage\) return \{ ok: false, error: NO_BRIDGE \}/u)
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

/** A bolha do dono virou componente próprio na R39.1 (ela ganhou ESTADO). */
function recorteDaBolha() {
  const pane = read('src/renderer/src/components/GuiPane.tsx')
  const from = pane.indexOf('function GuiOwnerBubble(')
  const to = pane.indexOf('function GuiMessage(')
  assert.ok(from !== -1 && to > from, 'a bolha do dono foi recortada')
  return { pane, bolha: pane.slice(from, to) }
}

test('a bolha do dono desenha o carimbo e leva o estado no nome acessível', () => {
  const { pane, bolha } = recorteDaBolha()
  assert.match(bolha, /ownerDeliveryStamp\(item\.delivery, Date\.now\(\)\)/u)
  assert.match(bolha, /ownerBubbleLabel\(/u)
  assert.match(bolha, /aria-label/u)
  assert.match(bolha, /gui-owner-state-\$\{stamp\.tone\}/u)
  // A bolha em si não muda: a tag, os anexos e o texto continuam onde estavam.
  assert.match(bolha, /className="gui-msg user"/u)
  assert.match(bolha, /className="gui-msg-text">\{item\.text\}/u)
  assert.match(bolha, /<GuiAttachmentChips/u)
  // E o `GuiMessage` continua entregando a bolha do dono a ela.
  temNo(
    pane,
    /if \(item\.kind === 'user'\) return <GuiOwnerBubble paneId=\{paneId\} item=\{item\} \/>/u,
    'GuiPane.tsx'
  )
})

test('R39.1 — a bolha `unread` tem o botão "ler agora", e só ela', () => {
  const { bolha } = recorteDaBolha()
  // A ação vem do MODELO (`stamp.action`): a tela não decide sozinha qual
  // estado ganha botão, e por isso a foto e a suíte contam a mesma história.
  assert.match(bolha, /\{stamp\.action && \(/u)
  assert.match(bolha, /className="gui-owner-force"/u)
  assert.match(bolha, /\{stamp\.action\.label\}/u)
  // Botão de verdade: alcançável pelo teclado (nada de <div onClick>).
  assert.match(bolha, /<button\s+type="button"/u)
  // O gesto vai pelo canal do main, com o id DESTA bolha.
  assert.match(bolha, /guiApi\.forceOwnerMessage\(paneId, item\.id\)/u)
  // Em voo o botão desliga: dois cliques seriam dois cortes.
  assert.match(bolha, /disabled=\{forcing\}/u)
  assert.match(bolha, /setForcing\(true\)/u)
  assert.match(bolha, /setForcing\(false\)/u)
  // O nome do botão cita a fala; a dica conta o custo antes do clique.
  assert.match(bolha, /aria-label=\{ownerForceLabel\(item\.text\)\}/u)
  assert.match(bolha, /data-tip=\{stamp\.action\.hint\}/u)
})

test('R39.1 — o botão NÃO cai dentro do aria-hidden do carimbo', () => {
  const { bolha } = recorteDaBolha()
  // Antes o carimbo inteiro saía `aria-hidden`; com um alvo focável dentro
  // isso vira armadilha de leitor de tela. O silêncio ficou só na marca e na
  // palavra (que o nome da bolha já diz).
  assert.doesNotMatch(bolha, /className=\{`gui-owner-state [^`]*`\} aria-hidden/u)
  assert.match(bolha, /<i className="gui-owner-state-mark" aria-hidden="true" \/>/u)
  assert.match(bolha, /<span aria-hidden="true">\{stamp\.text\}<\/span>/u)
})

test('R39.1 — a recusa do main para na linha de aviso da própria bolha', () => {
  const { bolha } = recorteDaBolha()
  assert.match(bolha, /ownerForceRefusalText\(result\.error\)/u)
  assert.match(bolha, /if \(!result\.ok\) setRefusal\(/u)
  // Voz de erro da casa (`gui-error`), região viva SEMPRE montada — nó de
  // `role=status` que nasce junto com o texto costuma não ser anunciado.
  assert.match(bolha, /className="gui-error gui-owner-refusal" role="status"/u)
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

test('R39.1 — "não lida" NÃO se mexe: esperar não é movimento', () => {
  const css = read('src/renderer/src/global.css')
  const from = css.indexOf('.gui-owner-state-unread .gui-owner-state-mark {')
  assert.ok(from !== -1, 'a marca do `unread` existe')
  const marca = css.slice(from, css.indexOf('}', from))
  assert.doesNotMatch(marca, /animation/u)
  // A marca é o MESMO traço do "entregue", rodado 90°: a porta ainda fechada.
  assert.match(marca, /border-left: 1px solid currentColor/u)
  // E `lida` divide o traço deitado com `entregue` — a PALAVRA é que separa
  // as duas rotas, não uma quinta forma inventada.
  temNo(
    css,
    /\.gui-owner-state-read \.gui-owner-state-mark,\s*\n\s*\.gui-owner-state-delivered \.gui-owner-state-mark \{[^}]*border-top: 1px solid currentColor/u,
    'global.css'
  )
  // Nenhum keyframe novo entrou por causa dos estados novos.
  naoTemNo(css, /@keyframes gui-owner/u, 'global.css')
})

test('R39.1 — "ler agora" fala a língua de botão da casa, com todos os estados', () => {
  const css = read('src/renderer/src/global.css')
  const from = css.indexOf('.gui-owner-force {')
  assert.ok(from !== -1, 'o botão do `unread` existe')
  const bloco = css.slice(from, from + 1_400)
  const caixa = bloco.slice(0, bloco.indexOf('}'))
  // Papel & painel: borda ink, mono, CAIXA ALTA, fundo transparente — o mesmo
  // vocabulário do `.gui-btn`, na escala do carimbo.
  assert.match(caixa, /border: 1px solid var\(--gui-line-strong\)/u)
  assert.match(caixa, /font-family: var\(--mono\)/u)
  assert.match(caixa, /text-transform: uppercase/u)
  assert.match(caixa, /background: transparent/u)
  // A AÇÃO fica acima do RELATO na hierarquia da linha: ink cheio contra o
  // `--ink-2` do recibo.
  assert.match(caixa, /color: var\(--ink\)/u)
  // Alvo confortável (24px) — e é o único alvo da bolha.
  const alvo = /min-height: (\d+)px/u.exec(caixa)
  assert.ok(alvo && Number(alvo[1]) >= 24, `alvo pequeno demais: ${alvo?.[1]}`)
  // Nenhum estado fica pela metade: hover, active, foco e desabilitado.
  assert.match(bloco, /\.gui-owner-force:hover:not\(:disabled\)/u)
  assert.match(bloco, /\.gui-owner-force:active:not\(:disabled\)/u)
  // O anel de foco é o da casa no membro ESCURO da paleta: `--accent` sobre
  // papel mede 2,81:1 e não alcança o piso de 3:1; `--accent-deep`, 3,66:1.
  assert.match(
    bloco,
    /\.gui-owner-force:focus-visible \{[^}]*outline: 2px solid var\(--accent-deep\)/u
  )
  assert.match(bloco, /\.gui-owner-force:disabled \{[^}]*cursor: default/u)
})

test('R39.1 — a recusa some quando não há recusa (região viva sempre montada)', () => {
  const css = read('src/renderer/src/global.css')
  temNo(css, /\.gui-owner-refusal:empty \{\s*\n\s*display: none;/u, 'global.css')
  const from = css.indexOf('.gui-owner-refusal {')
  assert.ok(from !== -1)
  const caixa = css.slice(from, css.indexOf('}', from))
  // Escala de recibo, e sem cor própria: a voz de erro vem do `.gui-error`
  // que a bolha empilha junto — uma linguagem de erro só no fio inteiro.
  assert.match(caixa, /font-size: 11px/u)
  assert.doesNotMatch(caixa, /color:/u)
})
