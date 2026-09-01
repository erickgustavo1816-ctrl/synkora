// PORTA POR AJUDANTE — o registro de reservas (D4 do design vinculante
// `.synkora/reports/DESIGN_BROWSER_ABAS_POR_IDENTIDADE_2026-09-01.md`).
//
// A COLISÃO MEDIDA (missão 86a05c06, 01/09): o único ajudante que dirigiu o
// browser dividiu a MESMA aba com o dev e a URL alternou entre a porta dele
// (8791) e as do dev (8159/8148/8163) em minutos — três leituras do ajudante
// caíram na página do outro. Aba própria resolve metade; a outra metade é ESTA:
// cada ajudante nasce com uma porta reservada, anunciada no ambiente, na persona
// e no mapa do "▶ testar".
//
// O que esta suíte prende: o pool é DETERMINÍSTICO (mesma sequência, mesmas
// portas), a reserva é IDEMPOTENTE por ajudante (o resume volta na mesma porta),
// ela salta o que já está reservado e o que o harness ocupa, o pool cheio NUNCA
// estoura (devolve candidato e DIZ que está apertado) e as fichas entram no mapa
// da casa (`formatPortMap`) com o dono legível.
//
// Como rodar: `npm run test:gui-helper-ports`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  GUI_HELPER_PORT_BASE,
  GUI_HELPER_PORT_SPAN,
  createGuiHelperPortRegistry,
  guiHelperPorts
} from '../src/main/guiHelperPorts.ts'
import { formatPortMap } from '../src/main/portMap.ts'

const PROJECT = 'proj-9'
const OTHER = 'proj-outro'

/** Toda a faixa MENOS as portas nomeadas — é assim que se força a escolha sem
 *  conhecer a semente de um id (a régua é o comportamento, nunca o hash). */
function everythingBut(...free) {
  const keep = new Set(free)
  const taken = []
  for (let i = 0; i < GUI_HELPER_PORT_SPAN; i += 1) {
    const port = GUI_HELPER_PORT_BASE + i
    if (!keep.has(port)) taken.push(port)
  }
  return taken
}

test('a faixa é a do design e toda reserva cai DENTRO dela', () => {
  assert.equal(GUI_HELPER_PORT_BASE, 47100)
  assert.equal(GUI_HELPER_PORT_SPAN, 400)
  const ports = createGuiHelperPortRegistry()
  for (const helperId of ['h-1', 'h-2', 'abcdef12-3456-7890-abcd-ef1234567890', '']) {
    const port = ports.reserve(helperId, { projectId: PROJECT })
    assert.ok(
      port >= GUI_HELPER_PORT_BASE && port < GUI_HELPER_PORT_BASE + GUI_HELPER_PORT_SPAN,
      `${helperId} recebeu ${port}, fora da faixa reservada`
    )
    assert.equal(Number.isInteger(port), true, 'porta não inteira nunca sobe servidor')
  }
})

test('o pool é DETERMINÍSTICO: dois registros, a mesma frota, as mesmas portas', () => {
  const fleet = ['h-a', 'h-b', 'h-c', 'h-d']
  const um = createGuiHelperPortRegistry()
  const outro = createGuiHelperPortRegistry()
  const primeiro = fleet.map((id) => um.reserve(id, { projectId: PROJECT }))
  const segundo = fleet.map((id) => outro.reserve(id, { projectId: PROJECT }))
  assert.deepEqual(segundo, primeiro, 'a mesma sequência devolveu portas diferentes')
  // e ninguém divide porta com ninguém dentro do mesmo registro
  assert.equal(new Set(primeiro).size, fleet.length, 'dois ajudantes na mesma porta')
})

test('reservar de novo o MESMO ajudante devolve a MESMA porta e não consome outra', () => {
  const ports = createGuiHelperPortRegistry()
  const port = ports.reserve('h-1', { projectId: PROJECT, name: 'inv-brand' })
  assert.equal(ports.reserve('h-1', { projectId: PROJECT, name: 'inv-brand' }), port)
  assert.equal(ports.portOf('h-1'), port)
  // A re-tentativa do motor (529 na partida) passa por aqui de novo: uma ficha
  // só, uma porta só — nunca uma faixa comida por um ajudante que nem nasceu.
  assert.equal(ports.entries(PROJECT).length, 1, 'a re-reserva duplicou a ficha do mapa')
  // e o vizinho continua com a dele
  const vizinho = ports.reserve('h-2', { projectId: PROJECT })
  assert.notEqual(vizinho, port)
})

test('a reserva SALTA o que já está reservado e o que o harness ocupa', () => {
  const ports = createGuiHelperPortRegistry()
  // Só duas portas livres em toda a faixa: a primeira vai para quem chegar
  // primeiro, a segunda para o próximo — ninguém empilha em cima do outro.
  const taken = everythingBut(47250, 47251)
  const a = ports.reserve('h-a', { projectId: PROJECT }, taken)
  const b = ports.reserve('h-b', { projectId: PROJECT }, taken)
  assert.deepEqual([a, b].sort(), [47250, 47251], 'a reserva pisou numa porta ocupada')

  // E o `taken` do harness (servidor de teste do dono) é respeitado sozinho:
  const so = createGuiHelperPortRegistry()
  assert.equal(so.reserve('h-x', { projectId: PROJECT }, everythingBut(47399)), 47399)
})

test('pool cheio NUNCA estoura: devolve porta e a ficha diz que está apertado', () => {
  const ports = createGuiHelperPortRegistry()
  const port = ports.reserve('h-apertado', { projectId: PROJECT, name: 'aperto' }, everythingBut())
  assert.ok(
    port >= GUI_HELPER_PORT_BASE && port < GUI_HELPER_PORT_BASE + GUI_HELPER_PORT_SPAN,
    'o pool cheio devolveu porta fora da faixa'
  )
  assert.equal(ports.portOf('h-apertado'), port)
  // O mapa do dono não pode mentir: a porta saiu do pool CHEIO, então a linha
  // avisa. Quem resolve o resto é a persona ("se estiver ocupada, pegue a
  // seguinte e DIGA").
  const [entry] = ports.entries(PROJECT)
  assert.match(entry.owner, /pool cheio/iu, 'a ficha escondeu que a porta pode repetir')
})

test('release apaga a ficha, e o mesmo ajudante volta na MESMA porta', () => {
  const ports = createGuiHelperPortRegistry()
  const port = ports.reserve('h-1', { projectId: PROJECT })
  ports.release('h-1')
  assert.equal(ports.portOf('h-1'), undefined, 'a porta continuou reservada depois do desfecho')
  assert.deepEqual(ports.entries(PROJECT), [], 'ajudante morto continuou no mapa do dono')
  // helper_resume passa pelo adaptador de novo: a segunda vida do MESMO
  // ajudante encontra a faixa livre e volta ao endereço dele.
  assert.equal(ports.reserve('h-1', { projectId: PROJECT }), port)
  // soltar duas vezes (o dispose do motor pode passar mais de uma vez) é inerte
  ports.release('h-1')
  ports.release('h-1')
  assert.equal(ports.portOf('h-1'), undefined)
  ports.release('nunca-existiu')
})

test('as fichas saem POR PROJETO, com o dono legível e a porta marcada como PEDIDA', () => {
  const ports = createGuiHelperPortRegistry()
  const a = ports.reserve('9f2c1d0e-1111-2222-3333-444455556666', {
    projectId: PROJECT,
    name: 'inv-brand',
    delegatorPaneId: 'gui-dev-abc12345'
  })
  const b = ports.reserve('h-sem-nome', { projectId: PROJECT })
  ports.reserve('h-alheio', { projectId: OTHER, name: 'outro universo' })

  const entries = ports.entries(PROJECT)
  assert.equal(entries.length, 2, 'o mapa vazou (ou comeu) ajudante de outro projeto')
  for (const entry of entries) {
    assert.equal(entry.requested, true, 'a porta do ajudante é a PEDIDA — o produto pode pinar outra')
    assert.ok(entry.port, 'ficha sem porta não diz nada ao dono')
  }
  const owners = entries.map((entry) => entry.owner)
  assert.ok(
    owners.some((owner) => owner.includes('ajudante "inv-brand"')),
    `o apelido do ajudante sumiu do mapa: ${owners.join(' · ')}`
  )
  // Sem apelido o mapa mostra o id CURTO — id inteiro de uuid não cabe na linha
  // que o dono lê no modal do ▶ testar.
  assert.ok(
    owners.some((owner) => owner.includes('ajudante h-sem-n')),
    `sem apelido o dono ficou sem saber de quem é a porta: ${owners.join(' · ')}`
  )
  assert.equal(
    owners.some((owner) => owner.includes('outro universo')),
    false,
    'ajudante de outro projeto entrou no mapa'
  )

  // A ficha é a MESMA do mapa da casa: a linha do modal sai pronta.
  const linha = formatPortMap(entries)
  assert.match(linha, new RegExp(`${a} \\(pedida\\) = ajudante "inv-brand"`, 'u'))
  assert.ok(linha.includes(`${b} (pedida) = ajudante `))
})

test('o mapa do "▶ testar" enxerga as portas dos ajudantes', () => {
  // O `harnessPortsInUse` é o mapa que o modal do dono e o prompt do QA leem
  // (decisão de 2026-08-07: visibilidade nas duas pontas). Ele vive dentro do
  // engine do paneLifecycle, que nasce com um MainContext inteiro — subir isso
  // aqui seria montar meio main para provar uma concatenação. A régua é da
  // FONTE, como as outras invariantes estruturais da casa: o registro dos
  // ajudantes entra no mapa, no MESMO projeto.
  const src = readFileSync(new URL('../src/main/paneLifecycle.ts', import.meta.url), 'utf8')
  assert.match(
    src,
    /from '\.\/guiHelperPorts'/u,
    'o paneLifecycle não conhece o registro de portas dos ajudantes'
  )
  const at = src.indexOf('function harnessPortsInUse')
  assert.ok(at > 0, 'o mapa de portas mudou de casa')
  const body = src.slice(at, src.indexOf('\n  }', at))
  assert.match(
    body,
    /guiHelperPorts\.entries\(projectId\)/u,
    'a porta reservada do ajudante não aparece no mapa que o dono e o QA leem'
  )
})

test('o singleton do processo é UM só e é um registro de verdade', () => {
  assert.equal(typeof guiHelperPorts.reserve, 'function')
  assert.equal(typeof guiHelperPorts.release, 'function')
  assert.equal(typeof guiHelperPorts.portOf, 'function')
  assert.equal(typeof guiHelperPorts.entries, 'function')
  // O main inteiro fala com ESTE registro (o adaptador reserva, o
  // `harnessPortsInUse` lê): dois registros seriam duas verdades sobre a
  // mesma faixa.
  const port = guiHelperPorts.reserve('h-singleton', { projectId: 'proj-singleton' })
  assert.equal(guiHelperPorts.portOf('h-singleton'), port)
  guiHelperPorts.release('h-singleton')
  assert.deepEqual(guiHelperPorts.entries('proj-singleton'), [])
})
