import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// A LANDING DO ✦ GERAL (2026-08-15): convite no universo vazio, PAINEL DO
// PROJETO a partir da primeira missão, e a foto do universo trocando pelos
// avatares do alto da janela.
//
// Duas metades, de propósito:
//   (1) as CONTAS, importadas direto dos módulos puros — elas decidem qual tela
//       aparece e o que cada linha diz;
//   (2) os CONTRATOS DE FONTE, lidos como texto — é onde moram as regressões
//       que um teste puro nunca pegaria (o rodapé da foto voltar, um painel
//       escuro no papel, o limite de erro perder a tela que ele protege).
//
// Os módulos puros entram por import DINÂMICO: assim, num código sem eles, o
// arquivo ainda roda e cada contrato de fonte reprova por conta própria — em
// vez de o teste inteiro morrer no topo sem dizer nada.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

/** O CÓDIGO sem os comentários. Proibição de superfície (`--panel`,
 *  `.term-window`) se mede no que RENDERIZA — um comentário que explica por que
 *  a regra existe não pode reprovar o arquivo que a obedece. */
const withoutComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1')
const landing = () => import('../src/renderer/src/projectLanding.ts')
const presentation = () => import('../src/renderer/src/missionPresentation.ts')

const mission = (over = {}) => ({
  id: over.id ?? 'm1',
  projectId: 'p1',
  title: over.title ?? 'missão',
  status: over.status ?? 'ativa',
  createdAt: over.createdAt ?? '2026-08-01T10:00:00.000Z',
  updatedAt: over.updatedAt ?? '2026-08-09T10:00:00.000Z',
  ...over
})

test('zero missão de QUALQUER status é convite; a primeira já traz o painel', async () => {
  const { projectLanding } = await landing()

  assert.equal(projectLanding([]), 'invite')
  assert.equal(projectLanding([mission()]), 'dashboard')
  // A regressão que o critério evita: universo cujas missões TODAS integraram
  // (ou foram arquivadas) voltava para o "crie a primeira missão", apagando da
  // tela a história que ele já tem.
  assert.equal(projectLanding([mission({ status: 'concluida' })]), 'dashboard')
  assert.equal(projectLanding([mission({ status: 'arquivada' })]), 'dashboard')
})

test('KPIs contam vivo, integrado, fila e arquivado sem se sobrepor', async () => {
  const { projectKpis } = await landing()

  const kpis = projectKpis([
    mission({ id: 'a', status: 'ativa' }),
    mission({ id: 'b', status: 'ativa', pendingIntegrationApproval: true }),
    mission({ id: 'c', status: 'integrando' }),
    mission({
      id: 'd',
      status: 'ativa',
      integration: { state: 'queued', position: 2, total: 3 }
    }),
    mission({ id: 'e', status: 'concluida' }),
    mission({ id: 'f', status: 'concluida' }),
    mission({ id: 'g', status: 'arquivada' })
  ])

  assert.deepEqual(kpis, { emAndamento: 4, integradas: 2, naFila: 3, arquivadas: 1 })

  // Missão arquivada com ticket velho no registro NÃO conta como fila: a fila é
  // um estado de missão VIVA, e contá-la seria prometer um merge que não vem.
  const stale = projectKpis([
    mission({ id: 'z', status: 'arquivada', integration: { state: 'queued', position: 1, total: 1 } })
  ])
  assert.equal(stale.naFila, 0)
  assert.deepEqual(projectKpis([]), {
    emAndamento: 0,
    integradas: 0,
    naFila: 0,
    arquivadas: 0
  })
})

test('as listas do painel: vivas por nascimento, integradas por completedAt, teto 5', async () => {
  const { liveMissions, recentConcluded, RECENT_CONCLUDED_CAP } = await landing()

  const all = [
    mission({ id: 'velha', createdAt: '2026-08-01T00:00:00.000Z' }),
    mission({ id: 'nova', createdAt: '2026-08-09T00:00:00.000Z' }),
    mission({ id: 'integrando', status: 'integrando', createdAt: '2026-08-05T00:00:00.000Z' }),
    mission({ id: 'arquivada', status: 'arquivada' }),
    mission({
      id: 'feita-antes',
      status: 'concluida',
      completedAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z'
    }),
    mission({ id: 'feita-depois', status: 'concluida', completedAt: '2026-08-08T00:00:00.000Z' })
  ]

  assert.deepEqual(
    liveMissions(all).map((m) => m.id),
    ['nova', 'integrando', 'velha']
  )
  // `updatedAt` NUNCA ordena: 'feita-antes' tem o updatedAt mais novo de todos
  // (manutenção do store) e mesmo assim fica atrás — quem manda é o carimbo da
  // integração.
  assert.deepEqual(
    recentConcluded(all).map((m) => m.id),
    ['feita-depois', 'feita-antes']
  )

  const many = Array.from({ length: 9 }, (_, i) =>
    mission({
      id: `c${i}`,
      status: 'concluida',
      completedAt: `2026-08-0${i + 1}T00:00:00.000Z`
    })
  )
  assert.equal(recentConcluded(many).length, RECENT_CONCLUDED_CAP)
  assert.equal(recentConcluded(many)[0].id, 'c8', 'a mais recente abre a lista')
  assert.equal(recentConcluded(many, 2).length, 2)
  assert.deepEqual(recentConcluded([]), [])
})

test('a data da linha usa o VERBO certo e cala quando não tem fonte', async () => {
  const { missionDayLabel, formatDay } = await landing()

  assert.equal(
    missionDayLabel(mission({ createdAt: '2026-08-12T13:00:00.000Z' })),
    'criada em 12/08/2026'
  )
  assert.equal(
    missionDayLabel(
      mission({ status: 'concluida', completedAt: '2026-08-14T13:00:00.000Z' })
    ),
    'integrada em 14/08/2026'
  )
  // A CERCA: missão antiga sem `completedAt` não pode cair no `updatedAt` e
  // chamá-lo de integração — sem fonte real, a linha não fala de tempo.
  assert.equal(
    missionDayLabel(mission({ status: 'concluida', updatedAt: '2026-08-30T00:00:00.000Z' })),
    null
  )
  assert.equal(formatDay(undefined), null)
  assert.equal(formatDay('não é data'), null)
})

test('▣ só existe com card de verdade — missão 2.0 nunca mostra 0/0', async () => {
  const { showsTaskCount } = await landing()

  assert.equal(showsTaskCount(0), false)
  assert.equal(showsTaskCount(3), true)
  assert.equal(showsTaskCount(Number.NaN), false)
})

test('dot, selo e palavra de estado são UMA fonte para a coluna e para o painel', async () => {
  const { dotClass, badgeFor, waitingOnOwner, MISSION_STATUS_LABEL } = await presentation()

  assert.equal(dotClass({ mission: mission() }), 'ok')
  assert.equal(dotClass({ mission: mission({ status: 'integrando' }) }), 'busy')
  assert.equal(
    dotClass({
      mission: mission({ integration: { state: 'blocked', position: 1, total: 2 } })
    }),
    'err'
  )
  // O que exige o dono vence o que está só andando.
  assert.equal(
    dotClass({
      mission: mission({ status: 'integrando', pendingIntegrationApproval: true })
    }),
    'ask'
  )
  assert.equal(dotClass({ mission: mission(), pulse: 'o agente perguntou' }), 'ask')

  assert.deepEqual(badgeFor({ mission: mission(), pulse: 'x' }), { glyph: '❓', kind: 'ask' })
  assert.deepEqual(badgeFor({ mission: mission({ pendingIntegrationApproval: true }) }), {
    glyph: '⇪',
    kind: 'ask'
  })
  assert.equal(badgeFor({ mission: mission() }), null)
  assert.equal(
    badgeFor({ mission: mission({ integration: { state: 'merging', position: 1, total: 1 } }) }),
    null
  )
  assert.deepEqual(
    badgeFor({
      mission: mission({
        integration: { state: 'blocked', position: 1, total: 2, owner: 'orchestrator' }
      })
    }),
    { glyph: '! reparo', kind: 'err' }
  )
  assert.deepEqual(
    badgeFor({ mission: mission({ integration: { state: 'queued', position: 3, total: 4 } }) }),
    { glyph: 'fila #3', kind: 'busy' }
  )

  assert.equal(waitingOnOwner({ mission: mission() }), false)
  assert.equal(waitingOnOwner({ mission: mission({ pendingIntegrationApproval: true }) }), true)
  assert.equal(waitingOnOwner({ mission: mission(), pulse: 'o agente perguntou' }), true)
  assert.equal(MISSION_STATUS_LABEL.concluida, 'integrada')
  assert.equal(MISSION_STATUS_LABEL.ativa, 'em andamento')
})

test('a coluna e o trilho consomem o módulo — nenhuma cópia da regra sobrou', async () => {
  const [column, rail] = await Promise.all([
    source('src/renderer/src/components/MissionColumn.tsx'),
    source('src/renderer/src/components/MissionDeliveryRail.tsx')
  ])

  assert.match(column, /from '\.\.\/missionPresentation'/u)
  assert.doesNotMatch(column, /function dotClass/u)
  assert.doesNotMatch(column, /function badgeFor/u)
  assert.match(rail, /MISSION_STATUS_LABEL as STATUS_LABEL/u)
  assert.doesNotMatch(rail, /const STATUS_LABEL: Record/u)
})

test('o convite perdeu o rodapé da foto e ganhou o centro', async () => {
  const [general, css] = await Promise.all([
    source('src/renderer/src/components/ProjectGeneral.tsx'),
    source('src/renderer/src/global.css')
  ])

  // A REGRESSÃO: o rodapé de identidade voltar para dentro do convite.
  assert.doesNotMatch(general, /pg-identity/u)
  assert.doesNotMatch(general, /pg-avatar/u)
  assert.doesNotMatch(general, /pg-photo-remove/u)
  assert.doesNotMatch(general, /setProjectPhoto|removeProjectPhoto/u)
  // Sem foto, o convite não precisa mais do store para nada.
  assert.doesNotMatch(general, /useStore/u)
  assert.match(general, /is-invite/u)

  assert.match(
    css,
    /\.project-general\.is-invite\s*\{[\s\S]*?place-items:\s*center/u,
    'o convite centraliza NA COLUNA (grid + place-items), não como overlay'
  )
  assert.match(
    css,
    /\.project-general\.is-invite \.pg-start\s*\{[\s\S]*?width:\s*min\(620px, 92%\)/u
  )
  assert.match(
    css,
    /\.project-general\.is-invite \.pg-start\s*\{[\s\S]*?animation:\s*rise/u
  )
  // As regras órfãs do rodapé saíram do arquivo inteiro.
  assert.doesNotMatch(css, /^\.pg-identity\s*\{/mu)
  assert.doesNotMatch(css, /^\.pg-avatar\s*\{/mu)
  assert.doesNotMatch(css, /^\.pg-photo-remove\s*\{/mu)
  // ... mas o fix do PNG transparente do avatar do titlebar FICA (ele morava
  // num seletor compartilhado com `.pg-avatar` — apagar o bloco inteiro
  // devolveria o anel colorido em volta da foto).
  assert.match(css, /\.tb-title-avatar:has\(img\)\s*\{[\s\S]*?background:\s*transparent/u)
})

test('o painel do projeto é PAPEL, mostra o que os chips não dizem e nunca inventa número', async () => {
  const [dashboard, css] = await Promise.all([
    source('src/renderer/src/components/ProjectDashboard.tsx'),
    source('src/renderer/src/global.css')
  ])
  const code = withoutComments(dashboard)

  // O erro que o mockup nomeia: painel escuro fora de terminal.
  assert.doesNotMatch(code, /term-window/u)
  assert.doesNotMatch(code, /--panel/u)
  assert.doesNotMatch(css, /\.project-dashboard[^{]*\{[^}]*--panel/u)
  assert.doesNotMatch(css, /\.pd-[a-z-]+[^{]*\{[^}]*var\(--panel/u)
  // Componente burro: quem busca é o Board (nada de IPC nem store aqui).
  assert.doesNotMatch(code, /window\.synkora/u)
  assert.doesNotMatch(code, /useStore/u)

  // Tooltip é `data-tip` (o `title=` nativo é proibido no app).
  assert.match(dashboard, /data-tip=/u)
  assert.doesNotMatch(code, /\stitle="/u)

  // Os KPIs reusam o tile que já existe.
  assert.match(dashboard, /stat-tile/u)
  assert.match(dashboard, /stat-num/u)
  assert.match(dashboard, /stat-label/u)
  for (const label of ['em andamento', 'integradas', 'na fila ⇪', 'arquivadas'])
    assert.ok(dashboard.includes(label), `KPI ausente: ${label}`)

  // A linha por missão diz o que os chips da barra não conseguem dizer.
  assert.match(dashboard, /MISSION_STATUS_LABEL\[mission\.status\]/u)
  assert.match(dashboard, /✎ planejamento/u)
  assert.match(dashboard, /⎇ \{mission\.branch/u)
  assert.match(dashboard, /queueLabel/u)
  // ▣ SEMPRE atrás do guarda — nunca "0/0" como se fosse fato.
  assert.match(dashboard, /showsTaskCount\(total\) &&[\s\S]{0,200}▣/u)
  // Arquivada é KPI, não linha: listá-la desfaria o arquivamento na prática.
  assert.doesNotMatch(code, /status === 'arquivada'/u)
  // O convite nunca some de vez: a landing continua oferecendo missão nova.
  assert.match(dashboard, /\+ nova missão/u)

  assert.match(css, /\.pd-mission\.waiting\s*\{[\s\S]*?var\(--warn\)/u)
  assert.match(css, /\.pd-dot\.ask\s*\{[\s\S]*?background:\s*var\(--warn\)/u)
  assert.match(css, /\.pd-count\s*\{[\s\S]*?font-variant-numeric:\s*tabular-nums/u)
})

test('o Board escolhe a tela pelo módulo puro e mantém as duas no mesmo limite de erro', async () => {
  const board = await source('src/renderer/src/components/Board.tsx')

  assert.match(board, /import \{ projectLanding \} from '\.\.\/projectLanding'/u)
  // O limite de erro fica POR FORA do ramo: as duas telas dividem o paneId.
  assert.match(
    board,
    /paneId=\{`board-general:\$\{projectId\}`\}[\s\S]{0,600}projectLanding\(projectMissions\) === 'invite'[\s\S]{0,600}<ProjectGeneral/u
  )
  assert.match(board, /<ProjectDashboard[\s\S]{0,400}<\/GuiPanelErrorBoundary>/u)
  // O convite passou a receber TODAS as missões (era `liveMissions.length`).
  assert.doesNotMatch(board, /missionCount=\{liveMissions\.length\}/u)
  assert.match(board, /missionCount=\{projectMissions\.length\}/u)
  // Clicar numa linha abre a missão pelo canal de seleção de sempre.
  assert.match(board, /onOpenMission=\{\(id\) => setMissionTab\(projectId, id\)\}/u)
  // O painel não busca stats: o Board entrega o que o Universe já carregou.
  assert.match(board, /versoes=\{homeStats\?\.versoes\}/u)
  // O KANBAN LEGADO foi DEMOLIDO na purga F6 (2026-08-17) — a supressão virou
  // remoção por ordem do dono. O painel do projeto ocupa a coluna sozinho.
  assert.doesNotMatch(board, /const showKanban =/u)
  assert.doesNotMatch(board, /board-columns/u)
})

/* ---------- a coluna de missões: UMA largura, sempre ---------- */

/** o corpo de uma regra CSS pelo seletor EXATO, ancorado em início de linha */
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const found = css.match(new RegExp(`\\n${escaped}\\s*\\{([^}]*)\\}`, 'u'))
  assert.ok(found, `regra ausente: ${selector}`)
  return found[1]
}

test('a coluna de missões mede o MESMO no ✦ geral e com missão aberta', async () => {
  const css = await source('src/renderer/src/global.css')

  // O DEFEITO (ordem do dono, 2026-08-15b): DOIS donos do mesmo eixo. A coluna
  // media 240px no ✦ geral e 216px com missão 2.0 selecionada — medido: 24px
  // de salto a cada clique, e o conteúdo útil caindo de 229px para 205px.
  const base = ruleBody(css, '.mission-col')
  assert.match(base, /--mission-col-width:\s*240px/u, 'a medida mora no token, em lugar nenhum mais')
  assert.match(base, /flex:\s*0 0 var\(--mission-col-width\)/u)

  // o modo palco só ORDENA: redeclarar largura aqui é o bug voltando
  const stage = ruleBody(css, '.board-main.stage-mode .mission-col')
  assert.match(stage, /order:\s*2/u, 'o palco continua mandando a coluna para a esquerda')
  assert.doesNotMatch(
    stage,
    /(?:^|;)\s*(?:flex|flex-basis|width|min-width|max-width)\s*:/u,
    'o modo palco não pode declarar largura — a fonte única é o token'
  )
})

test('em janela estreita a coluna vira faixa TAMBÉM no ✦ geral', async () => {
  const css = await source('src/renderer/src/global.css')

  // CASCATA POR POSIÇÃO: o seletor cru `.mission-col` (0,1,0) dentro do
  // `@container board (max-width: 1103px)` perdia para o `.mission-col` que
  // mora MAIS ABAIXO no arquivo (mesma especificidade). Com o `.board-main` já
  // empilhado, o `flex: 0 0 240px` passava a valer como 240px de ALTURA — a
  // coluna nunca virava faixa horizontal fora do modo palco. Medido a 1000px
  // de janela, antes: altura 240px e `flex-direction: column`.
  assert.match(
    css,
    /\.board \.mission-col,\s*\.board \.board-main\.stage-mode \.mission-col\s*\{/u,
    'a faixa estreita precisa do prefixo `.board` para vencer por especificidade'
  )
  assert.doesNotMatch(
    css,
    /(?:^|\n)\s*\.mission-col,\s*\.board \.board-main\.stage-mode \.mission-col/u,
    'o seletor cru voltou: ele perde por posição e a coluna deixa de empilhar'
  )
  // as MESMAS gêmeas mais abaixo no arquivo derrubavam estas duas também
  assert.match(css, /\.board \.mission-col-list\s*\{/u)
  assert.match(css, /\.board \.mission-col-general,\s*\.board \.mission-col-new\s*\{/u)
})

test('a régua de 10px: os botões da coluna reservam a MESMA calha dos cards', async () => {
  const css = await source('src/renderer/src/global.css')

  // O DEFEITO: `.mission-col-list` reserva a calha da barra
  // (`scrollbar-gutter: stable`) e os dois botões são filhos DIRETOS da coluna
  // — a borda direita deles ficava 10px à frente da dos cards, com ou sem
  // barra na tela. Medido antes: botão em 313px, card em 303px.
  assert.match(ruleBody(css, ':root'), /--scrollbar-w:\s*10px/u, 'a medida da barra ganhou nome')
  assert.match(
    css,
    /\.mission-col-general,\s*\.mission-col-new\s*\{[^}]*margin-inline-end:\s*var\(--scrollbar-w\)/u,
    'os botões reservam a mesma calha — e pelo TOKEN, não por um 10 solto'
  )

  // as declarações globais da barra CONSOMEM o token: trocar a barra sem
  // trocar a régua desalinharia tudo de novo
  const bars = [...css.matchAll(/(?:^|\n)::-webkit-scrollbar\s*\{([^}]*)\}/gu)].map((m) => m[1])
  assert.ok(bars.length >= 1, 'a regra global da barra sumiu do arquivo')
  for (const bar of bars) assert.match(bar, /width:\s*var\(--scrollbar-w\)/u)

  // e a lista continua RESERVANDO a calha: trocar `stable` por `auto` devolve
  // o card mudando de largura no meio de uma leitura.
  assert.match(ruleBody(css, '.mission-col-list'), /scrollbar-gutter:\s*stable/u)
})

test('a foto do universo troca nos dois avatares do alto da janela', async () => {
  const [titleBar, universe] = await Promise.all([
    source('src/renderer/src/components/TitleBar.tsx'),
    source('src/renderer/src/screens/Universe.tsx')
  ])

  for (const [name, file] of [
    ['TitleBar', titleBar],
    ['Universe', universe]
  ]) {
    assert.match(file, /setProjectPhoto/u, `${name}: a alavanca da foto precisa existir`)
    assert.match(
      file,
      /aria-label=\{`Trocar a foto do universo \$\{project\.name\}`\}/u,
      `${name}: o botão precisa de nome acessível`
    )
    assert.match(file, /data-tip="Trocar a foto do universo"/u)
  }
  // O avatar do workspace era `aria-hidden` e inerte — virar botão sem tirar o
  // aria-hidden esconderia o próprio controle do leitor de tela.
  assert.doesNotMatch(universe, /className="ws-avatar"[\s\S]{0,200}aria-hidden/u)
})
