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

test('o contador de cards não existe mais — nem o guarda dele', async () => {
  // Os CARDS morreram na purga F6 (2026-08-17). O guarda `showsTaskCount`
  // existia só para o ▣ nunca aparecer como 0/0; sem card, sem contador e sem
  // guarda. Esta asserção existe para o par não voltar meio vivo.
  const mod = await landing()
  assert.equal('showsTaskCount' in mod, false)
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
  const [panel, row, css] = await Promise.all([
    source('src/renderer/src/components/ProjectDashboard.tsx'),
    source('src/renderer/src/components/MissionDashboardRow.tsx'),
    source('src/renderer/src/global.css')
  ])
  // A LINHA saiu do painel para arquivo próprio quando ganhou a GAVETA do diff
  // (2026-08-17): ela passou a ter estado de busca, que não é do painel. As
  // invariantes valem para o PAR — "o painel", aqui, são os dois arquivos.
  const dashboard = `${panel}\n${row}`
  const code = withoutComments(dashboard)

  // O erro que o mockup nomeia: painel escuro fora de terminal.
  assert.doesNotMatch(code, /term-window/u)
  assert.doesNotMatch(code, /--panel/u)
  assert.doesNotMatch(css, /\.project-dashboard[^{]*\{[^}]*--panel/u)
  assert.doesNotMatch(css, /\.pd-[a-z-]+[^{]*\{[^}]*var\(--panel/u)
  // Componente burro: quem busca é o Board (nada de IPC nem store aqui). A
  // gaveta da linha lê o diff, mas pelas costuras que o trilho de entrega já
  // usa (`missionWorkspace`/`missionHistory`) — `window.synkora` direto
  // continua proibido, e o `useStore` também.
  assert.doesNotMatch(code, /window\.synkora/u)
  assert.doesNotMatch(code, /useStore/u)
  // NENHUM LEQUE: a leitura de Git nasce no CLIQUE do dono, nunca num efeito de
  // montagem. Dez missões abertas não podem virar dez leituras por render.
  assert.doesNotMatch(withoutComments(row), /useEffect/u)
  assert.match(row, /onClick=\{\(\) => void toggle\(\)\}/u)

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
  // ▣ não existe mais: a missão 2.0 não tem card para contar.
  assert.doesNotMatch(dashboard, /showsTaskCount|pd-count/u)
  // Arquivada é KPI, não linha: listá-la desfaria o arquivamento na prática.
  assert.doesNotMatch(code, /status === 'arquivada'/u)
  // O convite nunca some de vez: a landing continua oferecendo missão nova.
  assert.match(dashboard, /\+ nova missão/u)

  assert.match(css, /\.pd-mission\.waiting\s*\{[\s\S]*?var\(--warn\)/u)
  assert.match(css, /\.pd-dot\.ask\s*\{[\s\S]*?background:\s*var\(--warn\)/u)
  // `.pd-count` (o ▣ feitos/total) saiu do CSS junto com o contador na purga
  // F6 (2026-08-17) — a asserção de tabular-nums perdeu o objeto.
})

test('o Board escolhe a tela pelo módulo puro e mantém as duas no mesmo limite de erro', async () => {
  const board = await source('src/renderer/src/components/Board.tsx')

  assert.match(board, /import \{ projectLanding \} from '\.\.\/projectLanding'/u)
  // O limite de erro fica POR FORA do ramo: as duas telas dividem o paneId.
  assert.match(
    board,
    /paneId=\{`board-general:\$\{projectId\}`\}[\s\S]{0,600}projectLanding\(projectMissions\) === 'invite'[\s\S]{0,600}<ProjectGeneral/u
  )
  assert.match(board, /<ProjectDashboard[\s\S]{0,700}<\/GuiPanelErrorBoundary>/u)
  // Os PLANOS chegam prontos do Board (mesma lista da aba Mapa) e o gesto do
  // painel leva para lá — a casa mostra o relance, o mapa é onde se edita.
  assert.match(board, /plans=\{projectPlans\}/u)
  assert.match(board, /onOpenPlans=\{\(\) => setUniverseTab\(projectId, 'mapa'\)\}/u)
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

/* ---------- ATRIBUIÇÃO DE VERSÃO (ordem do dono, 2026-08-17) ----------
   Duas regras que a tela violava ao mesmo tempo, e por isso o dono lia
   "◈ V1.0" ao lado de contadores que somavam missão de OUTRA linha:

   (1) o chip ◈ de IDENTIDADE responde "o que está na main" — e o que está na
       main é a última versão LANÇADA. A régua antiga (`versoes.find(v =>
       !v.lancada)`) devolvia a versão ABERTA MAIS ANTIGA, que é o oposto: a
       linha em construção. Sem nada lançado o chip simplesmente não existe —
       inventar "◈ V1.0" para um projeto que nunca subiu nada é afirmar um
       release que não aconteceu.
   (2) cada LINHA de versão conta as missões CARIMBADAS nela. A única exceção
       (deliberada) é a missão viva SEM carimbo: ela conta na versão corrente,
       porque é nela que vai integrar (`ensureDefaultVersion`). */

const version = (over = {}) => ({
  id: over.id ?? 'v1',
  projectId: 'p1',
  name: over.name ?? 'V1.0',
  status: over.status ?? 'aberta',
  createdAt: over.createdAt ?? '2026-08-01T00:00:00.000Z',
  updatedAt: over.updatedAt ?? '2026-08-01T00:00:00.000Z',
  deliveries: over.deliveries ?? [],
  ...over
})

test('◈ de identidade = a versão que está NA MAIN (a última LANÇADA)', async () => {
  const { versionPortrait } = await landing()

  const portrait = versionPortrait(
    [
      version({ id: 'a', name: 'V1.0', status: 'lancada', releasedAt: '2026-08-02T00:00:00.000Z' }),
      version({ id: 'b', name: 'V1.1', status: 'lancada', releasedAt: '2026-08-10T00:00:00.000Z' }),
      version({ id: 'c', name: 'V2.0', status: 'aberta', createdAt: '2026-08-11T00:00:00.000Z' })
    ],
    []
  )
  assert.equal(portrait.versaoNaMain, 'V1.1', 'a lançada MAIS RECENTE é a que está na main')

  // A REGRESSÃO EXATA que o dono viu: duas abertas, nada lançado. A régua
  // antiga elegia a aberta mais antiga e a chamava de identidade do projeto.
  const nadaLancado = versionPortrait(
    [
      version({ id: 'a', name: 'V1.0', createdAt: '2026-08-13T00:00:00.000Z' }),
      version({ id: 'b', name: 'V1.0.1', createdAt: '2026-08-15T00:00:00.000Z' })
    ],
    []
  )
  assert.equal(
    nadaLancado.versaoNaMain,
    undefined,
    'sem release não há versão na main — o chip não nasce'
  )
  assert.equal(versionPortrait([], []).versaoNaMain, undefined)
})

test('cada linha de versão conta as missões CARIMBADAS nela', async () => {
  const { versionPortrait } = await landing()

  const versions = [
    version({ id: 'v10', name: 'V1.0', createdAt: '2026-08-13T00:00:00.000Z' }),
    version({ id: 'v101', name: 'V1.0.1', createdAt: '2026-08-15T00:00:00.000Z' })
  ]
  const { versoes } = versionPortrait(versions, [
    mission({ id: 'a', status: 'ativa', versionId: 'v10' }),
    mission({ id: 'b', status: 'ativa', versionId: 'v101' }),
    mission({ id: 'c', status: 'integrando', versionId: 'v101' }),
    // viva SEM carimbo: cai na CORRENTE (aberta mais antiga) — é lá que integra
    mission({ id: 'd', status: 'ativa' }),
    // concluída sem carimbo não tem linha nenhuma: ela integrou em algum lugar
    // que o registro não sabe dizer, e chutar seria inventar.
    mission({ id: 'e', status: 'concluida' }),
    mission({ id: 'f', status: 'concluida', versionId: 'v101' }),
    // arquivada não conta em lado nenhum (saiu do board de propósito)
    mission({ id: 'g', status: 'arquivada', versionId: 'v10' })
  ])

  assert.deepEqual(versoes, [
    { name: 'V1.0', lancada: false, missoesFeitas: 0, missoesTotal: 2 },
    { name: 'V1.0.1', lancada: false, missoesFeitas: 1, missoesTotal: 3 }
  ])
})

test('a linha soma entrega registrada e missão concluída SEM contar duas vezes', async () => {
  const { versionPortrait } = await landing()

  const { versoes } = versionPortrait(
    [
      version({
        id: 'v10',
        name: 'V1.0',
        deliveries: [
          // a mesma missão pelas DUAS provas: recibo da integração e status
          { id: 'd1', missionId: 'm9', title: 'x', at: '2026-08-10T00:00:00.000Z' },
          // recibo de missão que não está mais na lista (excluída/arquivada):
          // ela SUBIU de verdade e continua contando
          { id: 'd2', missionId: 'sumida', title: 'y', at: '2026-08-11T00:00:00.000Z' }
        ]
      })
    ],
    [mission({ id: 'm9', status: 'concluida', versionId: 'v10' })]
  )

  assert.deepEqual(versoes, [
    { name: 'V1.0', lancada: false, missoesFeitas: 2, missoesTotal: 2 }
  ])
})

test('o chip ◈ do universo e do painel leem NA MAIN, nunca a aberta mais antiga', async () => {
  const [universe, dashboard] = await Promise.all([
    source('src/renderer/src/screens/Universe.tsx'),
    source('src/renderer/src/components/ProjectDashboard.tsx')
  ])

  for (const [name, file] of [
    ['Universe', universe],
    ['ProjectDashboard', dashboard]
  ]) {
    assert.match(file, /versaoNaMain/u, `${name}: a identidade vem do campo da main`)
    assert.doesNotMatch(
      withoutComments(file),
      /versoes\.find\(/u,
      `${name}: eleger a versão do chip varrendo as ABERTAS é a régua que o dono reprovou`
    )
  }
})

test('a atividade recente só existe onde há CARIMBO — updatedAt nunca vira tempo', async () => {
  const { missionTimeline, RECENT_ACTIVITY_CAP } = await landing()

  const events = missionTimeline([
    mission({ id: 'a', title: 'nasceu', createdAt: '2026-08-10T10:00:00.000Z' }),
    mission({
      id: 'b',
      title: 'integrou',
      status: 'concluida',
      createdAt: '2026-08-01T10:00:00.000Z',
      completedAt: '2026-08-12T10:00:00.000Z'
    }),
    // A CERCA: concluída SEM `completedAt` e com `updatedAt` recentíssimo. O
    // `updatedAt` anda em qualquer mutação de store (status, seat, branch) e
    // não mede atividade nenhuma — a linha "integrada" não pode nascer dele.
    mission({
      id: 'c',
      title: 'sem carimbo',
      status: 'concluida',
      createdAt: '2026-08-02T10:00:00.000Z',
      updatedAt: '2026-08-30T10:00:00.000Z'
    })
  ])

  assert.deepEqual(
    events.map((e) => `${e.kind}:${e.title}`),
    ['integrada:integrou', 'criada:nasceu', 'criada:sem carimbo', 'criada:integrou']
  )
  assert.equal(events[0].day, '12/08/2026')
  // uma missão pode dar DOIS eventos (nasceu e integrou) sem colidir de chave
  assert.equal(events.filter((e) => e.missionId === 'b').length, 2)

  const muitas = Array.from({ length: 9 }, (_, i) =>
    mission({ id: `m${i}`, createdAt: `2026-08-0${i + 1}T00:00:00.000Z` })
  )
  assert.equal(missionTimeline(muitas).length, RECENT_ACTIVITY_CAP)
  assert.equal(missionTimeline(muitas, 2).length, 2)
  assert.deepEqual(missionTimeline([]), [])
  // data ilegível não vira evento em vez de virar "Invalid Date" na tela
  assert.deepEqual(missionTimeline([mission({ createdAt: 'ontem' })]), [])
})

test('o painel largo mostra plano, espera e cronologia sem inventar conta nova', async () => {
  const dashboard = await source('src/renderer/src/components/ProjectDashboard.tsx')

  // A FRAÇÃO DO PLANO é a do mapa: duas contas do mesmo plano divergiriam no
  // primeiro item descartado (que sai do denominador só numa delas).
  assert.match(dashboard, /import \{ planProgress \} from '\.\.\/planBoardPresentation'/u)
  assert.doesNotMatch(
    withoutComments(dashboard),
    /Math\.round\(\((done|progress\.done)/u,
    'a porcentagem do plano se calcula no módulo compartilhado, não aqui'
  )
  // Plano ARQUIVADO não é retrato do projeto — ele foi engavetado de propósito.
  assert.match(dashboard, /plan\.status !== 'arquivado'/u)

  // O QUE ESPERA VOCÊ sobe para uma faixa própria: dentro da linha da missão,
  // uma pergunta na quinta posição de uma lista longa fica abaixo da dobra.
  assert.match(dashboard, /pd-alert/u)
  assert.match(dashboard, /pendingIntegrationApproval \|\| entryOf\.get\(m\.id\)\?\.pulse/u)

  // A cronologia vem do módulo puro, com as duas datas que existem de verdade.
  assert.match(dashboard, /missionTimeline\(missions\)/u)
  assert.doesNotMatch(withoutComments(dashboard), /updatedAt/u)
})
