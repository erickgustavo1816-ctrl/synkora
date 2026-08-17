import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// O MENU DE PLANEJAMENTO (2026-08-15): a aba MAPA passa a listar planos, e o
// plano nasce de uma PROPOSTA aprovada dentro da conversa.
//
// Duas metades, como nas suítes irmãs:
//   (1) as CONTAS puras — progresso, ordem das abas, pulso da missão vinculada
//       e a leitura defensiva do rascunho que chega pelo canal vivo;
//   (2) os CONTRATOS DE FONTE — onde moram as regressões que teste puro nenhum
//       pega: perder o CAS de uma mutação, o agente ganhar uma porta de criação
//       que é do dono, ou o card vivo aparecer numa conversa congelada.
//
// Módulos puros por import DINÂMICO: num código sem eles o arquivo ainda roda e
// cada contrato de fonte reprova por conta própria.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

/** O CÓDIGO sem comentários: uma proibição se mede no que RENDERIZA, e o
 *  comentário que explica a regra não pode reprovar o arquivo que a obedece. */
const withoutComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1')

const presentation = () => import('../src/renderer/src/planBoardPresentation.ts')
// a leitura defensiva do rascunho mora no guiApi (espelho 3 dos cinco)
const guiApi = () => import('../src/renderer/src/guiApi.ts')

const NO_CHAT = { pulse: 'dormant', running: 0, attention: 0, live: 0 }
const chat = (over = {}) => ({ ...NO_CHAT, ...over })

const item = (over = {}) => ({
  id: over.id ?? 'i1',
  title: over.title ?? 'item',
  objective: over.objective ?? 'objetivo',
  doneCriteria: over.doneCriteria ?? [],
  dependsOn: over.dependsOn ?? [],
  order: over.order ?? 0,
  status: over.status ?? 'planejada',
  createdAt: '2026-08-15T10:00:00.000Z',
  updatedAt: '2026-08-15T10:00:00.000Z',
  ...over
})

const planTab = (over = {}) => ({
  id: over.id ?? 'p1',
  title: over.title ?? 'plano',
  kind: over.kind ?? 'livre',
  status: over.status ?? 'ativo',
  order: over.order ?? 0,
  ...over
})

test('progresso do plano é derivado, e o descartado sai da conta', async () => {
  const { planProgress } = await presentation()

  const mixed = planProgress([
    item({ status: 'concluida' }),
    item({ status: 'em_andamento' }),
    item({ status: 'planejada' }),
    item({ status: 'descartada' })
  ])
  // A regressão que isto evita: contar o descartado como trabalho pendente —
  // um plano cujo dono JÁ decidiu não fazer um item ficaria eternamente em 2/4.
  assert.equal(mixed.total, 3)
  assert.equal(mixed.done, 1)
  assert.equal(mixed.discarded, 1)
  assert.equal(mixed.running, 1)
  assert.equal(mixed.percent, 33)
  assert.match(mixed.label, /^1\/3 missões concluídas · 1 descartada$/u)

  assert.equal(planProgress([item({ status: 'concluida' })]).label, '1/1 missão concluída')
  assert.equal(planProgress([]).label, 'nenhuma missão neste plano')
  assert.equal(planProgress([]).percent, 0)
  assert.equal(
    planProgress([item({ status: 'descartada' })]).label,
    'todas as missões foram descartadas'
  )
})

test('cada status do item tem glifo E palavra (nunca só a cor)', async () => {
  const { planItemPresentation } = await presentation()

  for (const status of ['planejada', 'em_andamento', 'concluida', 'descartada']) {
    const view = planItemPresentation(status)
    assert.ok(view.glyph.length > 0, `${status} sem glifo`)
    assert.ok(view.label.length > 0, `${status} sem palavra`)
    assert.equal(view.cls, status)
  }
  assert.equal(planItemPresentation('planejada').label, 'planejada')
  assert.equal(planItemPresentation('concluida').label, 'concluída')
})

test('abas do mapa: rotas primeiro, mestre na frente dos livres, arquivado fora', async () => {
  const { mapTabs, resolveMapTab } = await presentation()

  const tabs = mapTabs({
    plans: [
      planTab({ id: 'b', title: 'Dívida técnica', order: 2 }),
      planTab({ id: 'a', title: 'V1.1', order: 1 }),
      planTab({ id: 'm', title: 'Mestre', kind: 'mestre', order: 9 }),
      planTab({ id: 'x', title: 'Antigo', status: 'arquivado', order: 0 })
    ]
  })
  // UMA DIMENSÃO A MENOS desde o expurgo F6: entre `rotas` e os planos não há
  // mais espaço para a aba do roadmap por ondas.
  assert.deepEqual(
    tabs.map((tab) => tab.id),
    ['rotas', 'plano:m', 'plano:a', 'plano:b']
  )
  assert.ok(
    !tabs.some((tab) => tab.kind === 'mestre-f6' || tab.id === 'plano-mestre-f6'),
    'a aba do roadmap F6 voltou'
  )
  // Plano arquivado não ocupa espaço permanente na fila.
  assert.ok(!tabs.some((tab) => tab.id === 'plano:x'))

  // Universo sem plano nenhum: só o quadro de rotas, e sem fila de abas.
  const semPlano = mapTabs({ plans: [] })
  assert.deepEqual(
    semPlano.map((tab) => tab.id),
    ['rotas']
  )

  // Aba lembrada que sumiu (plano excluído) nunca prende a tela num vazio.
  assert.equal(resolveMapTab(tabs, 'plano:sumiu').id, 'rotas')
  assert.equal(resolveMapTab(tabs, 'plano:a').planId, 'a')
  assert.equal(resolveMapTab(tabs, undefined).id, 'rotas')
})

test('título de plano longo encolhe na aba sem virar id ilegível', async () => {
  const { planTabLabel } = await presentation()

  assert.equal(planTabLabel(planTab({ title: 'V1.1' })), 'V1.1')
  const longo = planTabLabel(
    planTab({ title: 'Reforma completa da fila de integração e da retomada' })
  )
  assert.ok(longo.length <= 22)
  assert.ok(longo.endsWith('…'))
  assert.equal(planTabLabel(planTab({ title: '   ' })), 'plano sem título')
})

test('pulso da ficha: o que EXIGE o dono vence o que só está andando', async () => {
  const { planMissionPulse } = await presentation()

  const mission = (over = {}) => ({ id: 'm', title: 'missão', status: 'ativa', ...over })

  assert.deepEqual(
    planMissionPulse(mission({ pendingIntegrationApproval: true }), chat({ running: 2 })),
    { dot: 'ask', label: 'esperando seu ⇪', waiting: true }
  )
  assert.deepEqual(planMissionPulse(mission(), chat({ attention: 1, live: 1 })), {
    dot: 'ask',
    label: 'esperando você',
    waiting: true
  })
  assert.equal(planMissionPulse(mission({ status: 'concluida' }), NO_CHAT).dot, 'done')
  assert.equal(planMissionPulse(mission({ status: 'integrando' }), NO_CHAT).dot, 'busy')
  assert.equal(planMissionPulse(mission(), chat({ running: 2, live: 2 })).label, '2 trabalhando')
  assert.equal(planMissionPulse(mission(), chat({ live: 1 })).label, 'conversa aberta')
  // Conversa fechada não é missão parada: a sessão vive no main.
  assert.equal(planMissionPulse(mission(), NO_CHAT).label, 'missão aberta')
})

test('item sem missão, com missão viva e apontando para missão que sumiu', async () => {
  const { planItemLink } = await presentation()

  const viva = { id: 'm1', title: 'Missão viva', status: 'ativa' }
  const missions = new Map([[viva.id, viva]])
  const chatOf = () => chat({ running: 1, live: 1 })

  assert.equal(planItemLink(item(), missions, chatOf).kind, 'none')

  const linked = planItemLink(item({ missionId: 'm1' }), missions, chatOf)
  assert.equal(linked.kind, 'linked')
  assert.equal(linked.mission.title, 'Missão viva')
  assert.equal(linked.pulse.label, 'trabalhando')

  // A regressão que isto evita: progresso FANTASMA — o item aponta para uma
  // missão excluída na mão e a aba seguiria mostrando trabalho que não existe.
  assert.equal(planItemLink(item({ missionId: 'sumiu' }), missions, chatOf).kind, 'missing')

  // A missão VIVA vence a fotografia da leitura (ela muda a cada evento).
  const comFoto = planItemLink(
    item({ missionId: 'm1', mission: { id: 'm1', title: 'Foto velha', status: 'concluida' } }),
    missions,
    chatOf
  )
  assert.equal(comFoto.mission.title, 'Missão viva')
  // Sem a missão no store, a fotografia ainda serve (missão arquivada).
  const soFoto = planItemLink(
    item({ missionId: 'm9', mission: { id: 'm9', title: 'Arquivada', status: 'arquivada' } }),
    new Map(),
    chatOf
  )
  assert.equal(soFoto.kind, 'linked')
  assert.equal(soFoto.pulse.label, 'arquivada')
})

test('dependência do rascunho vira TÍTULO, por chave ou por posição', async () => {
  const { planDraftDependencyLabels, planDraftItemCountLabel } = await presentation()

  const draft = {
    items: [
      { id: 'a', title: 'Fundação', objective: '', doneCriteria: [], dependsOn: [] },
      { title: 'Fila', objective: '', doneCriteria: [], dependsOn: [] },
      {
        id: 'c',
        title: 'Tela',
        objective: '',
        doneCriteria: [],
        dependsOn: ['a', '2', 'a', 'z9']
      }
    ]
  }
  assert.deepEqual(planDraftDependencyLabels(draft, draft.items[2]), [
    'Fundação',
    'Fila',
    // chave que não resolve fica VISÍVEL: esconder uma dependência é pior que
    // mostrá-la crua.
    'z9'
  ])
  assert.deepEqual(planDraftDependencyLabels(draft, draft.items[0]), [])

  assert.equal(planDraftItemCountLabel(0), 'sem missões descritas')
  assert.equal(planDraftItemCountLabel(1), '1 missão neste plano')
  assert.equal(planDraftItemCountLabel(4), '4 missões neste plano')
})

test('o goal da missão pré-preenchida carrega objetivo, critérios e o brief', async () => {
  const { planItemMissionGoal } = await presentation()

  const goal = planItemMissionGoal({
    objective: 'Fechar a fila.',
    outOfScope: 'App mobile.',
    context: 'Vem da V1.0.',
    doneCriteria: ['reinício retoma o ticket', 'destino avançado pausa'],
    docPath: 'plano/012-fila.md'
  })
  assert.match(goal, /Fechar a fila\./u)
  assert.match(goal, /Contexto: Vem da V1\.0\./u)
  assert.match(goal, /Fora do escopo: App mobile\./u)
  assert.match(goal, /- reinício retoma o ticket/u)
  assert.match(goal, /Brief completo: plano\/012-fila\.md/u)

  // Item magro não gera seção vazia nenhuma.
  assert.equal(planItemMissionGoal({ objective: 'Só isso.', doneCriteria: [] }), 'Só isso.')
})

test('rascunho que chega pelo canal vivo é lido com desconfiança', async () => {
  const { readPlanDraft, PLAN_DRAFT_MAX_ITEMS } = await guiApi()

  assert.equal(readPlanDraft(null), null)
  assert.equal(readPlanDraft('plano'), null)
  assert.equal(readPlanDraft({}), null)
  // `items` torto não vira exceção dentro do redutor: vira plano sem missões.
  assert.deepEqual(readPlanDraft({ title: 'V1', items: 'nope' }), { title: 'V1', items: [] })

  const draft = readPlanDraft({
    title: '  V1.1  ',
    description: ' fecha a fila ',
    kind: 'inventado',
    items: [
      { title: '  Fila  ', objective: ' fechar ', doneCriteria: ['a', '', 42], tier: 'medio' },
      { title: '', objective: 'sem título entra na lista?' },
      { titulo: 'campo errado' },
      { title: 'Tela', tier: 'gigante', dependsOn: ['fila', ''] }
    ]
  })
  assert.equal(draft.title, 'V1.1')
  assert.equal(draft.description, 'fecha a fila')
  assert.ok(!('kind' in draft), 'kind fora do vocabulário não entra')
  assert.equal(draft.items.length, 2, 'item sem título não é item')
  assert.equal(draft.items[0].title, 'Fila')
  assert.equal(draft.items[0].objective, 'fechar')
  assert.deepEqual(draft.items[0].doneCriteria, ['a'])
  assert.equal(draft.items[0].tier, 'medio')
  assert.ok(!('tier' in draft.items[1]), 'tier fora do vocabulário não entra')
  assert.deepEqual(draft.items[1].dependsOn, ['fila'])

  const gordo = readPlanDraft({
    title: 'despejo',
    items: Array.from({ length: PLAN_DRAFT_MAX_ITEMS + 20 }, (_, i) => ({
      title: `item ${i}`,
      objective: ''
    }))
  })
  assert.equal(gordo.items.length, PLAN_DRAFT_MAX_ITEMS)
})

test('CONTRATO: toda mutação de plano leva o updatedAt que a tela mostrou', async () => {
  const board = await source('src/renderer/src/components/PlanBoardView.tsx')
  const api = await source('src/renderer/src/plansApi.ts')

  // CAS otimista: o agente edita o plano pela tool enquanto a aba está aberta.
  // Sem `expectedUpdatedAt` a tela escreveria por cima do que mudou.
  for (const call of ['update', 'archive', 'remove', 'linkMission']) {
    assert.match(
      api,
      new RegExp(`${call}:\\s*\\([^)]*expectedUpdatedAt`, 'su'),
      `plansApi.${call} sem expectedUpdatedAt`
    )
  }
  assert.ok(
    (board.match(/plan\.updatedAt/gu) ?? []).length >= 4,
    'alguma ação da aba do plano parou de mandar a fotografia que ela mostrou'
  )
})

test('CONTRATO: a aba do plano não fala com a ponte direto e não usa diálogo nativo', async () => {
  const board = withoutComments(await source('src/renderer/src/components/PlanBoardView.tsx'))
  const map = withoutComments(await source('src/renderer/src/components/UniverseMapView.tsx'))

  for (const [name, src] of [
    ['PlanBoardView', board],
    ['UniverseMapView', map]
  ]) {
    assert.ok(!/window\.synkora\.plans/u.test(src), `${name} fura o acessor de planos`)
    assert.ok(!/window\.(confirm|alert)\(/u.test(src), `${name} usa diálogo nativo`)
    assert.ok(!/\stitle="/u.test(src), `${name} usa title= em vez de data-tip`)
    assert.ok(!/term-window|--panel\b/u.test(src), `${name} usa superfície de terminal`)
  }
  // Excluir plano é irreversível: confirmação in-app, com o objeto nomeado.
  assert.match(board, /confirm-modal/u)
  assert.match(board, /excluir plano/u)
})

test('CONTRATO: o roadmap F6 MORREU — existe UMA tela de plano no app', async () => {
  // ESTE TESTE FOI INVERTIDO no expurgo de 2026-08-17. Ele afirmava
  // "o roadmap F6 continua de pé" e exigia o `import PlanMapView` — era a
  // ordem antiga ("suprimir, não demolir") escrita em código. A ordem foi
  // REVOGADA pelo dono; agora ele prova a AUSÊNCIA, para que ninguém
  // ressuscite a segunda tela de plano em silêncio.
  const map = withoutComments(await source('src/renderer/src/components/UniverseMapView.tsx'))

  assert.ok(!/PlanMapView/u.test(map), 'o PlanMapView voltou ao mapa')
  assert.ok(!/projectPlan/u.test(map), 'o mapa voltou a sondar o roadmap F6')
  assert.ok(!/hasLegacyPlan/u.test(map), 'a sondagem do roadmap legado voltou')
  assert.match(map, /<PlanBoardView/u)

  // O arquivo da tela legada não existe mais — e o import morto reprovaria.
  await assert.rejects(
    () => source('src/renderer/src/components/PlanMapView.tsx'),
    'PlanMapView.tsx foi recriado'
  )

  // A ponte legada também não existe: nem o handler, nem o namespace.
  const preload = withoutComments(await source('src/preload/index.ts'))
  assert.ok(!/projectPlan:/u.test(preload), 'o preload voltou a expor projectPlan')
  await assert.rejects(
    () => source('src/main/ipc/projectPlan.ts'),
    'o IPC projectPlan foi recriado'
  )

  // A aba ativa é POR PROJETO: dois universos abertos não dividem a escolha.
  const store = await source('src/renderer/src/store.ts')
  assert.match(store, /mapTabByProject: Record<string, string>/u)
  assert.match(map, /s\.mapTabByProject\[projectId\]/u)
  // E a fila se refaz quando o plano OU as missões mudam (o progresso vem delas).
  assert.match(map, /plansApi\.onChanged/u)
  assert.match(map, /missions\?\.onChanged/u)
})

test('CONTRATO: cadastrar universo não semeia PROJECT_PLAN.json nem classifica modo', async () => {
  // A causa provada do print do dono: `ipc/projects.ts` semeava um
  // PROJECT_PLAN.json vazio em todo universo novo, e a listagem re-derivava o
  // modo chamando `projectModeOf` — que semeava de novo pela porta dos fundos.
  const projects = withoutComments(await source('src/main/ipc/projects.ts'))

  assert.ok(!/ensureGreenfieldProjectPlan/u.test(projects), 'a semeadura voltou')
  assert.ok(!/projectModeOf|projectPlanOf/u.test(projects), 'a classificação F6 voltou')
  assert.ok(!/'greenfield'/u.test(projects), 'o modo greenfield voltou ao cadastro')
  assert.match(projects, /projects\.create\(name, path\)/u)
  // A pergunta "esta pasta está vazia?" sobrevive — ela decide CLONAR × PUBLICAR.
  assert.match(projects, /isEffectivelyEmptyProject/u)
  assert.match(projects, /from '\.\.\/projectFolder'/u)
})

test('CONTRATO: criar missão a partir do item é gesto do DONO', async () => {
  const board = await source('src/renderer/src/components/PlanBoardView.tsx')

  // O modal do dono é a única porta: nada de criar missão direto no clique.
  assert.match(board, /<NewMissionModal/u)
  assert.match(board, /initialTitle=\{creatingFor\.title\}/u)
  assert.match(board, /initialGoal=\{planItemMissionGoal\(creatingFor\)\}/u)
  // E o vínculo entra no MESMO gesto, com CAS.
  assert.match(board, /plansApi\.linkMission\(/u)
  assert.ok(
    !/missions\.create\(|createMission\(/u.test(withoutComments(board)),
    'a aba do plano não pode criar missão por fora do modal'
  )
})
