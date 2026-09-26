import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// O PAINEL DO PROJETO do mockup aprovado em 2026-09-26
// (docs/mockups/painel-projeto-2026-09-26.html): as regras puras e o componente
// REAL renderizado por estado — "um acento por estado" só se conta na tela.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const landing = () => import('../src/renderer/src/projectLanding.ts')
const presentation = () => import('../src/renderer/src/missionPresentation.ts')

const mission = (over = {}) => ({
  id: 'm1',
  projectId: 'p1',
  title: over.id ?? 'missão',
  status: 'ativa',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  ...over
})
const done = (id, versionId, completedAt, over = {}) =>
  mission({ id, versionId, status: 'concluida', completedAt, ...over })
const line = (name, missoesFeitas, missoesTotal, lancada = false) => ({
  name,
  lancada,
  missoesFeitas,
  missoesTotal
})
const stampOf = (m) => m.versionId
const ids = (list) => list.map((m) => m.id)

test('missionCount concorda o substantivo com o número', async () => {
  const { missionCount } = await landing()

  assert.equal(missionCount(1), '1 missão')
  assert.equal(missionCount(0), '0 missões')
  assert.equal(missionCount(3), '3 missões')
})

test('progressLabel concorda o substantivo com o total, não com as feitas', async () => {
  const { progressLabel } = await landing()

  assert.equal(progressLabel({ feitas: 1, total: 1 }), '1 de 1 missão integrada')
  assert.equal(progressLabel({ feitas: 0, total: 1 }), '0 de 1 missão integrada')
  assert.equal(progressLabel({ feitas: 2, total: 5 }), '2 de 5 missões integradas')
})

test('o título diz o momento: marco, trabalho vivo ou nada andando', async () => {
  const { landingHeadline } = await landing()
  const feita = done('feita', 'V0.1.4', '2026-09-20T10:00:00.000Z')

  assert.deepEqual(landingHeadline([feita], [line('V0.1.4', 3, 3), line('V0.1.5', 0, 0)]), {
    title: 'V0.1.4 pronta para lançar',
    progress: { feitas: 3, total: 3 }
  })
  assert.deepEqual(landingHeadline([mission(), feita], [line('V0.1.5', 2, 5)]), {
    title: '1 missão em andamento',
    building: 'V0.1.5',
    progress: { feitas: 2, total: 5 }
  })
  assert.equal(
    landingHeadline(
      [mission({ id: 'a' }), mission({ id: 'b', status: 'integrando' })],
      [line('V0.1.5', 0, 2)]
    ).title,
    '2 missões em andamento'
  )
  assert.deepEqual(landingHeadline([feita], [line('V0.1.5', 1, 2)]), {
    title: 'Nenhuma missão em andamento',
    building: 'V0.1.5',
    progress: { feitas: 1, total: 2 }
  })
  // linha aberta ainda vazia: nomeia a construção sem inventar um "0 de 0"
  assert.deepEqual(landingHeadline([feita], [line('V0.1.5', 0, 0)]), {
    title: 'Nenhuma missão em andamento',
    building: 'V0.1.5'
  })
  assert.deepEqual(landingHeadline([feita], [line('V0.1.3', 3, 3, true)]), {
    title: 'Nenhuma missão em andamento'
  })
  assert.deepEqual(landingHeadline([mission()], undefined), { title: '1 missão em andamento' })
})

test('versionWork põe cada missão viva ou integrada no cartão da linha DELA', async () => {
  const { versionWork } = await landing()

  const work = versionWork(
    [
      mission({ id: 'sem-carimbo', createdAt: '2026-09-24T10:00:00.000Z' }),
      mission({ id: 'nova', versionId: 'V0.1.4', createdAt: '2026-09-26T10:00:00.000Z' }),
      mission({ id: 'espera', versionId: 'V0.1.4', status: 'integrando', createdAt: '2026-09-20T10:00:00.000Z' }),
      mission({ id: 'na-015', versionId: 'V0.1.5' }),
      mission({ id: 'de-lancada', versionId: 'V0.1.3', createdAt: '2026-09-22T10:00:00.000Z' }),
      mission({ id: 'desconhecida', versionId: 'V9', createdAt: '2026-09-23T10:00:00.000Z' }),
      done('feita-antes', 'V0.1.4', '2026-09-21T10:00:00.000Z'),
      done('feita-depois', 'V0.1.4', '2026-09-25T10:00:00.000Z'),
      done('feita-sem-carimbo', undefined, '2026-09-25T10:00:00.000Z'),
      done('feita-na-lancada', 'V0.1.3', '2026-09-10T10:00:00.000Z'),
      mission({ id: 'plano', missionType: 'planejamento' }),
      mission({ id: 'plano-carimbado', missionType: 'planejamento', versionId: 'V0.1.4' }),
      mission({ id: 'arquivada', status: 'arquivada', versionId: 'V0.1.4' })
    ],
    [line('V0.1.3', 3, 3, true), line('V0.1.4', 2, 5), line('V0.1.5', 0, 1)],
    stampOf,
    (m) => m.id === 'espera'
  )

  assert.deepEqual(
    work.lines.map((l) => [l.version.name, ids(l.live), ids(l.done)]),
    [
      ['V0.1.4', ['espera', 'nova', 'sem-carimbo'], ['feita-depois', 'feita-antes']],
      ['V0.1.5', ['na-015'], []]
    ]
  )
  assert.deepEqual(ids(work.loose), ['desconhecida', 'de-lancada'])
})

test('versionWork: sem linha aberta o trabalho vivo não some, e pronta segue a régua do marco', async () => {
  const { versionWork } = await landing()
  const viva = mission({ id: 'viva', createdAt: '2026-09-26T10:00:00.000Z' })
  const esperando = mission({ id: 'esperando', versionId: 'V0.1.3', createdAt: '2026-09-01T10:00:00.000Z' })
  const feita = done('feita', 'V0.1.3', '2026-09-20T10:00:00.000Z')
  const waiting = (m) => m.id === 'esperando'

  const soLancadas = versionWork([viva, esperando, feita], [line('V0.1.3', 1, 1, true)], stampOf, waiting)
  assert.deepEqual(soLancadas.lines, [])
  assert.deepEqual(ids(soLancadas.loose), ['esperando', 'viva'])
  assert.deepEqual(ids(versionWork([viva], undefined, stampOf, waiting).loose), ['viva'])

  const prontas = versionWork([], [line('A', 3, 3), line('B', 1, 3), line('C', 0, 0)], stampOf, waiting)
  assert.deepEqual(
    prontas.lines.map((l) => l.ready),
    [true, false, false]
  )
})

test('livePlanning: só o planejamento vivo, o mais novo primeiro', async () => {
  const { livePlanning } = await landing()

  const planning = livePlanning([
    mission({ id: 'velho', missionType: 'planejamento', createdAt: '2026-09-01T10:00:00.000Z' }),
    mission({ id: 'novo', missionType: 'planejamento', createdAt: '2026-09-20T10:00:00.000Z' }),
    mission({ id: 'concluido', missionType: 'planejamento', status: 'concluida' }),
    mission({ id: 'arquivado', missionType: 'planejamento', status: 'arquivada' }),
    mission({ id: 'dev' })
  ])
  assert.deepEqual(ids(planning), ['novo', 'velho'])
})

test('releasedLines: uma fileira por linha lançada, com as missões carimbadas nela', async () => {
  const { releasedLines } = await landing()
  const missions = [
    done('Login', 'V0.1.2', '2026-09-10T10:00:00.000Z'),
    done('Arrumar', 'V0.1.3', '2026-09-20T10:00:00.000Z'),
    done('Bug', 'V0.1.3', '2026-09-21T10:00:00.000Z'),
    done('Tela', 'V0.1.4', '2026-09-24T10:00:00.000Z'),
    done('Solta', undefined, '2026-09-25T10:00:00.000Z'),
    done('Roteiro', 'V0.1.3', '2026-09-26T10:00:00.000Z', { missionType: 'planejamento' }),
    mission({ id: 'Viva', versionId: 'V0.1.3' })
  ]

  assert.deepEqual(releasedLines(missions, [line('V0.1.4', 1, 2)], stampOf, 'V0.1.3'), [
    { name: 'V0.1.3', onMain: true, titles: ['Bug', 'Arrumar'] },
    { name: 'V0.1.2', onMain: false, titles: ['Login'] }
  ])
  // sem linha aberta o retrato traz a última lançada: ela é changelog, não construção
  assert.deepEqual(
    releasedLines(missions, [line('V0.1.4', 1, 1, true)], stampOf, 'V0.1.4').map((l) => [l.name, l.onMain]),
    [
      ['V0.1.4', true],
      ['V0.1.3', false],
      ['V0.1.2', false]
    ]
  )
})

test('releasedLines ordena pela subida mais recente, respeita o teto e espera o retrato', async () => {
  const { releasedLines, RELEASED_LINES_CAP } = await landing()
  const missions = Array.from({ length: RELEASED_LINES_CAP + 2 }, (_, i) =>
    done(`m${i}`, `V0.${i + 8}`, new Date(Date.UTC(2026, 8, 10 + i, 10)).toISOString())
  )
  const newestFirst = missions.map((m) => m.versionId).reverse()
  const names = (lines) => lines.map((l) => l.name)

  assert.deepEqual(names(releasedLines(missions, [], stampOf)), newestFirst.slice(0, RELEASED_LINES_CAP))
  assert.deepEqual(names(releasedLines(missions, [], stampOf, undefined, 2)), newestFirst.slice(0, 2))
  assert.deepEqual(releasedLines(missions, undefined, stampOf), [])
})

test('o selo por extenso cobre cada estado e fala o mesmo tom do ponto', async () => {
  const { missionStatePill, dotClass } = await presentation()
  const queue = (state, over = {}) => ({ state, position: 2, total: 3, ...over })

  const cases = [
    [{ mission: mission(), pulse: 'o agente perguntou' }, 'espera você', 'ask'],
    [{ mission: mission({ pendingIntegrationApproval: true }) }, 'espera você', 'ask'],
    [{ mission: mission({ integration: queue('blocked', { owner: 'orchestrator' }) }), pulse: 'x' }, 'espera você', 'ask'],
    [{ mission: mission({ integration: queue('blocked', { owner: 'orchestrator' }) }) }, 'reparo pendente', 'err'],
    [{ mission: mission({ integration: queue('blocked', { owner: 'maestro' }) }) }, 'decisão pendente', 'err'],
    [{ mission: mission({ integration: queue('blocked') }) }, 'decisão pendente', 'err'],
    [{ mission: mission({ integration: queue('sync_required') }) }, 'sincronizar', 'busy'],
    [{ mission: mission({ integration: queue('merging') }) }, 'integrando agora', 'busy'],
    [{ mission: mission({ status: 'integrando' }) }, 'integrando agora', 'busy'],
    [{ mission: mission({ integration: queue('queued') }) }, 'na fila · 2º', 'busy'],
    [{ mission: mission() }, 'em andamento', 'ok']
  ]
  for (const [signal, label, tone] of cases) {
    assert.deepEqual(missionStatePill(signal), { label, tone })
    assert.equal(missionStatePill(signal).tone, dotClass(signal), `${label}: selo e ponto discordam`)
  }
})

/* ---------- o componente, renderizado ---------- */

let dashboard
async function compileDashboard() {
  const { outputFiles } = await build({
    entryPoints: [
      fileURLToPath(new URL('../src/renderer/src/components/ProjectDashboard.tsx', import.meta.url))
    ],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    write: false,
    loader: { '.css': 'empty' },
    external: ['react', 'react-dom'],
    plugins: [
      {
        // o store de verdade escreve no `document` ao ser importado; a linha só lê o tipo da
        // missão. O filtro é regex do Go: sem a flag `u`.
        name: 'synthetic-store',
        setup(stub) {
          stub.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: 'store', namespace: 'synthetic' }))
          stub.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({
            contents: "export const missionTypeOf = (m) => m?.missionType ?? 'dev'"
          }))
        }
      }
    ]
  })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', outputFiles[0].text)(
    createRequire(import.meta.url),
    loaded,
    loaded.exports
  )
  return loaded.exports.default
}

async function renderPanel(props) {
  dashboard ??= await compileDashboard()
  return renderToStaticMarkup(
    createElement(dashboard, {
      entries: [],
      versionLabelOf: stampOf,
      onOpenMission() {},
      onNewMission() {},
      ...props
    })
  )
}

const text = (html) => html.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim()
function between(html, from, to) {
  const start = html.indexOf(from)
  assert.notEqual(start, -1, `trecho ausente: ${from}`)
  const end = html.indexOf(to, start + from.length)
  return html.slice(start, end === -1 ? undefined : end)
}
const buttons = (html) =>
  [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/button>/gu)].map(([, cls, inner]) => [
    cls,
    text(inner)
  ])
const versionCards = (html) =>
  html
    .split('<section class="pd-card">')
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf('</section>')))
const rowTitles = (html) => [...html.matchAll(/class="pd-row-title">([^<]*)</gu)].map((m) => m[1])

test('o painel traz a própria folha e o global.css não guarda regra dele', async () => {
  const [panel, global] = await Promise.all([
    source('src/renderer/src/components/ProjectDashboard.tsx'),
    source('src/renderer/src/global.css')
  ])

  assert.match(panel, /^import '\.\/ProjectDashboard\.css'$/mu)
  assert.doesNotMatch(
    global.replace(/\/\*[\s\S]*?\*\//gu, ''),
    /\.(pd-[\w-]+|project-dashboard)\b/u,
    'duas folhas para o mesmo painel brigam pela ordem de import'
  )
})

test('o título vem do landingHeadline e o cabeçalho tem UM acento por estado', async () => {
  const { landingHeadline } = await landing()
  const shipped = [
    done('a', 'V0.1.4', '2026-09-25T10:00:00.000Z'),
    done('b', 'V0.1.4', '2026-09-24T10:00:00.000Z')
  ]
  const pronta = [line('V0.1.4', 2, 2)]
  const bridges = { onOpenVersions() {}, onTestVersion() {} }

  const states = [
    [
      'marco',
      { missions: shipped, versoes: pronta, ...bridges },
      [
        ['btn accent', 'lançar na main'],
        ['btn', 'testar a versão'],
        ['btn ghost', 'nova missão']
      ]
    ],
    [
      'marco sem a ponte da aba Versões',
      { missions: shipped, versoes: pronta, onTestVersion() {} },
      [
        ['btn', 'testar a versão'],
        ['btn accent', 'nova missão']
      ]
    ],
    [
      'trabalho vivo',
      {
        missions: [mission({ id: 'viva', versionId: 'V0.1.5' }), mission({ id: 'outra' }), ...shipped],
        versoes: [line('V0.1.5', 0, 2)],
        ...bridges
      },
      [['btn accent', 'nova missão']]
    ],
    [
      'nada andando',
      { missions: shipped, versoes: [line('V0.1.5', 1, 3)], ...bridges },
      [['btn accent', 'nova missão']]
    ]
  ]
  for (const [state, props, expected] of states) {
    const header = between(await renderPanel(props), '<header class="pd-header">', '</header>')
    assert.equal(text(between(header, '<h1', '</h1>')), landingHeadline(props.missions, props.versoes).title, state)
    assert.deepEqual(buttons(header), expected, state)
  }
})

test('sem o retrato das versões o painel não inventa linha, fração nem changelog', async () => {
  const html = await renderPanel({
    missions: [mission({ id: 'viva' }), done('feita', 'V0.1.4', '2026-09-20T10:00:00.000Z')]
  })
  const main = between(html, '<div class="pd-main">', '<aside')

  assert.equal(text(between(html, '<p class="pd-sub">', '</p>')), 'nada lançado na main ainda')
  assert.doesNotMatch(main, /pd-card-head|pd-bar|pd-released/u)
  assert.deepEqual(rowTitles(main), ['viva'])
  assert.match(html, /<dt>Integradas<\/dt><dd>1<\/dd>/u)
  assert.match(html, /<dt class="total">Total<\/dt><dd class="total">2<\/dd>/u)
})

test('cada versão aberta é um cartão com as missões DELA: vivas primeiro, integradas como leitura', async () => {
  const { missionDayLabel } = await landing()
  const feita = done('feita', 'V0.1.5', '2026-09-23T10:00:00.000Z')
  const html = await renderPanel({
    missions: [
      done('a', 'V0.1.4', '2026-09-25T10:00:00.000Z'),
      done('b', 'V0.1.4', '2026-09-24T10:00:00.000Z'),
      mission({ id: 'viva-velha', versionId: 'V0.1.5', branch: 'mission/velha', createdAt: '2026-09-20T10:00:00.000Z' }),
      mission({ id: 'viva-nova', versionId: 'V0.1.5', branch: 'mission/nova', createdAt: '2026-09-26T10:00:00.000Z' }),
      feita
    ],
    versoes: [line('V0.1.4', 2, 2), line('V0.1.5', 1, 3), line('V0.1.6', 0, 0)]
  })
  const head = (card) => text(between(card, '<header', '</header>'))
  const cards = versionCards(html)
  assert.equal(cards.length, 3, 'um cartão por linha aberta')
  const [pronta, andando, vazia] = cards

  assert.equal(head(pronta), 'V0.1.4 pronta 2 missões')
  assert.doesNotMatch(pronta, /pd-bar/u, 'linha completa é selo, não barra cheia')
  assert.equal(head(andando), 'V0.1.5 em construção 1 de 3 integradas')
  assert.match(andando, /class="pd-bar"[^>]*><span style="width:33%">/u)
  assert.equal(head(vazia), 'V0.1.6 em construção sem missões ainda')
  assert.doesNotMatch(vazia, /pd-bar/u)
  assert.equal(text(between(vazia, '<p class="pd-empty">', '</p>')), 'nenhuma missão nesta versão ainda')

  assert.deepEqual(rowTitles(html), ['a', 'b', 'viva-nova', 'viva-velha', 'feita'])
  assert.equal(andando.match(/class="pd-row-open"/gu)?.length, 2, 'só a viva é botão')
  assert.equal(text(between(andando, '<div class="pd-row-done"', '</li>')), `feita ${missionDayLabel(feita)}`)
  assert.doesNotMatch(html, /class="pd-drawer"/u, 'a gaveta só abre no clique')
  assert.equal(html.match(/aria-expanded="false"/gu)?.length, 2)
})

test('o que espera o dono sobe para a faixa âmbar, antes das versões', async () => {
  const pergunta = mission({ id: 'pergunta', versionId: 'V0.1.5', createdAt: '2026-09-25T10:00:00.000Z' })
  const aval = mission({
    id: 'aval',
    versionId: 'V0.1.5',
    pendingIntegrationApproval: true,
    createdAt: '2026-09-26T10:00:00.000Z'
  })
  const andando = mission({ id: 'andando', versionId: 'V0.1.5', createdAt: '2026-09-27T10:00:00.000Z' })
  const props = {
    missions: [pergunta, aval, andando],
    versoes: [line('V0.1.5', 0, 3)],
    entries: [{ mission: pergunta, pulse: 'posso trocar o provedor?' }]
  }
  const html = await renderPanel(props)
  const strip = between(html, '<section class="pd-attn"', '</section>')

  assert.ok(html.indexOf('class="pd-attn"') < html.indexOf('class="pd-card"'))
  assert.equal(text(between(strip, '<p', '</p>')), 'esperando você · 2')
  assert.deepEqual(
    [...strip.matchAll(/class="pd-attn-title">([^<]*)</gu)].map((m) => m[1]),
    ['aval', 'pergunta']
  )
  assert.match(strip, /posso trocar o provedor\?/u)
  assert.match(strip, /A integração espera o seu aval/u)

  const [card] = versionCards(html)
  assert.deepEqual(rowTitles(card), ['aval', 'pergunta', 'andando'])
  assert.equal(card.match(/class="pd-pill ask">espera você/gu)?.length, 2)

  assert.doesNotMatch(await renderPanel({ ...props, missions: [andando], entries: [] }), /pd-attn/u)
})

test('planejamento mora num bloco próprio e as lançadas viram uma tabela curta', async () => {
  const html = await renderPanel({
    missions: [
      mission({ id: 'Roteiro', missionType: 'planejamento' }),
      mission({ id: 'Tela', versionId: 'V0.1.5', branch: 'mission/tela' }),
      done('Arrumar', 'V0.1.3', '2026-09-20T10:00:00.000Z'),
      done('Bug', 'V0.1.3', '2026-09-21T10:00:00.000Z'),
      done('Login', 'V0.1.2', '2026-09-10T10:00:00.000Z')
    ],
    versoes: [line('V0.1.5', 0, 1)],
    versaoNaMain: 'V0.1.3',
    onOpenVersions() {}
  })

  const cards = versionCards(html)
  assert.equal(cards.length, 1, 'linha lançada não vira cartão')
  assert.deepEqual(rowTitles(cards[0]), ['Tela'])
  const planning = between(html, '<h2 class="pd-section-title">planejamento</h2>', '</section>')
  assert.deepEqual(rowTitles(planning), ['Roteiro'])
  assert.match(text(planning), /escreve plano\//u)
  assert.doesNotMatch(planning, /pd-row-tool/u, 'planejamento não tem branch para abrir diff')

  const released = between(html, '<h2 class="pd-section-title">lançadas</h2>', '</section>')
  assert.match(text(released), /^lançadas abrir a aba Versões /u)
  assert.deepEqual(
    [...released.matchAll(/<div class="pd-released-row"[^>]*>([\s\S]*?)<\/div>/gu)].map((m) => text(m[1])),
    ['V0.1.3 na main 2 missões Bug · Arrumar', 'V0.1.2 1 missão Login']
  )
})

test('a lateral resume sem gritar zero e mostra plano cumprido como selo', async () => {
  const items = (...statuses) => statuses.map((status, i) => ({ id: `i${i}`, status }))
  const html = await renderPanel({
    missions: [
      mission({ id: 'viva' }),
      done('feita', 'V0.1.3', '2026-09-20T10:00:00.000Z'),
      mission({ id: 'guardada', status: 'arquivada' })
    ],
    versoes: [line('V0.1.5', 0, 1)],
    plans: [
      { id: 'p1', title: 'Mestre', kind: 'mestre', status: 'ativo', items: items('concluida', 'concluida', 'descartada') },
      { id: 'p2', title: 'Parcial', kind: 'livre', status: 'ativo', items: items('concluida', 'em_andamento', 'planejada') },
      { id: 'p3', title: 'Engavetado', kind: 'livre', status: 'arquivado', items: items('planejada') }
    ],
    onOpenPlans() {}
  })
  const side = between(html, '<aside class="pd-side">', '</aside>')

  assert.match(
    side,
    /<dt>Em andamento<\/dt><dd>1<\/dd><dt>Na fila<\/dt><dd class="zero">0<\/dd><dt>Integradas<\/dt><dd>1<\/dd><dt>Arquivadas<\/dt><dd>1<\/dd><dt class="total">Total<\/dt><dd class="total">3<\/dd>/u
  )
  assert.deepEqual(
    [...side.matchAll(/<div class="(pd-plan(?: done)?)"[^>]*>([\s\S]*?)<\/div>/gu)].map(([, cls, inner]) => [
      cls,
      text(inner),
      inner.match(/width:(\d+)%/u)?.[1] ?? null
    ]),
    [
      ['pd-plan done', 'Mestre mestre 2 de 2 · cumprido', null],
      ['pd-plan', 'Parcial 1 de 3 · 1 em andamento', '33']
    ]
  )
})
