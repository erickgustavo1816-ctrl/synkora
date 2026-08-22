import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// A LANDING DO ✦ GERAL: convite no universo vazio e, a partir da primeira
// missão, o RETRATO — que na Onda B do RIGHTDOCK (2026-08-22, mockup aprovado
// = contrato) deixou de ser o painel largo (`ProjectDashboard`, demolido) e
// virou o dock compacto (`DockGeneral`): dois números que importam e o rastro,
// na MESMA moldura do trilho da missão.
//
// Duas metades, de propósito:
//   (1) as CONTAS, importadas direto dos módulos puros — elas decidem qual tela
//       aparece e o que cada linha diz;
//   (2) os CONTRATOS DE FONTE, lidos como texto — é onde moram as regressões
//       que um teste puro nunca pegaria (um painel escuro no papel, o
//       componente virando esperto, o card gigante voltando).
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

test('zero missão de QUALQUER status é convite; a primeira já traz o retrato', async () => {
  const { projectLanding } = await landing()

  assert.equal(projectLanding([]), 'invite')
  assert.equal(projectLanding([mission()]), 'dashboard')
  // A regressão que o critério evita: universo cujas missões TODAS integraram
  // (ou foram arquivadas) voltava para o "crie a primeira missão", apagando da
  // tela a história que ele já tem.
  assert.equal(projectLanding([mission({ status: 'concluida' })]), 'dashboard')
  assert.equal(projectLanding([mission({ status: 'arquivada' })]), 'dashboard')
})

test('as listas do retrato: vivas por nascimento, integradas por completedAt, teto 5', async () => {
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

test('formatDay fala dd/mm/aaaa e cala quando não tem fonte', async () => {
  const { formatDay } = await landing()

  assert.equal(formatDay('2026-08-12T13:00:00.000Z'), '12/08/2026')
  assert.equal(formatDay(undefined), null)
  assert.equal(formatDay('não é data'), null)
})

test('os mortos ficam mortos: nem o contador de cards nem as contas do painel largo', async () => {
  // `showsTaskCount` morreu na purga F6 (o ▣ dos cards); `projectKpis`,
  // `missionTimeline` e `missionDayLabel` morreram com o painel largo na Onda
  // B do RIGHTDOCK — o dock compacto conta vivas/esperando pela régua única
  // (`waitingOnOwner`) e o rastro pelo `recentConcluded`. Esta asserção existe
  // para nenhum deles voltar meio vivo.
  const mod = await landing()
  for (const dead of ['showsTaskCount', 'projectKpis', 'missionTimeline', 'missionDayLabel']) {
    assert.equal(dead in mod, false, `${dead} devia ter morrido com o painel largo`)
  }
})

test('dot, selo e palavra de estado são UMA fonte para a coluna e para o retrato', async () => {
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

// ————————————————————————————————————————————————————————————————————————
// A alavanca de ARQUIVAR do planejamento diz "arquivar" (2026-08-17): a régua
// da rodada 3 fica — mas o CONCLUIR voltou como alavanca PRÓPRIA por ordem do
// dono na mesma noite (teste irmão no fim do arquivo). Aqui prende-se que o
// botão de arquivo continua UM e continua dizendo arquivar.
// ————————————————————————————————————————————————————————————————————————

test('o trilho do planejamento chama arquivar de ARQUIVAR', async () => {
  const rail = await source('src/renderer/src/components/MissionDeliveryRail.tsx')
  const code = withoutComments(rail)

  // No RIGHTDOCK o gesto tem DUAS casas: o dev arquiva pelo ícone ⊟ da fileira
  // de ações (a dica carrega a verdade inteira) e reativa pelo botão da seção;
  // o PLANEJAMENTO tem o rodapé próprio, com os dois sentidos no mesmo botão.
  assert.match(code, /'⊟ arquivar planejamento'/u, 'planejamento vivo diz arquivar')
  assert.match(code, /'↩ reabrir planejamento'/u, 'planejamento arquivado diz reabrir')
  assert.doesNotMatch(
    code,
    /'[^']*concluir[^']*planejamento[^']*'\s*:\s*'↩/u,
    'concluir é a OUTRA alavanca, nunca um rótulo do botão de arquivo'
  )
  assert.match(code, /data-tip="Arquivar a missão \(branch preservada\)"/u, 'o ⊟ do dev diz o que preserva')
  assert.match(code, /↩ reativar/u, 'dev arquivado tem a volta')

  // A dica responde a dúvida que o gesto levanta — o plano some junto? O
  // arquivar é a PAUSA (retomar ou excluir); o plano/ é do PROJETO e fica.
  const tip = code.match(/data-tip=\{\s*live([\s\S]*?)\}\s*onClick=\{onArchive\}/u)
  assert.ok(tip, 'a dica da alavanca de arquivo mudou de forma')
  assert.match(tip[1], /[Pp]ausa/u)
  assert.match(tip[1], /plano\//u)
})

test('a alavanca de arquivo do planejamento não depende de branch nem de fila', async () => {
  const rail = await source('src/renderer/src/components/MissionDeliveryRail.tsx')
  const code = withoutComments(rail)

  // O rodapé do planejamento nasce da guarda `planning && (…status…)` — nunca
  // de dentro das seções `!planning` (entrega/trabalho/histórico), que não
  // existem numa missão sem worktree. Prender isto evita que uma limpeza
  // futura arraste a alavanca para dentro da seção de entrega e ela suma da
  // tela exatamente na natureza que mais precisa dela.
  const block = code.match(
    /\{planning && \(mission\.status === 'ativa' \|\| mission\.status === 'arquivada'\)[\s\S]*?onClick=\{onArchive\}/u
  )
  assert.ok(block, 'o rodapé de arquivar/reabrir do planejamento mudou de guarda')
  assert.doesNotMatch(block[0], /!planning/u)
  assert.doesNotMatch(block[0], /integration/u, 'a alavanca não consulta fila nenhuma')
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

// ————— RIGHTDOCK ONDA B (2026-08-22): o retrato compacto do ✦ geral —————
//
// O painel largo (`ProjectDashboard` + `MissionDashboardRow`) foi DEMOLIDO —
// o mockup aprovado diz "sem card gigante: dois números que importam e o
// rastro". Quem ficou no ✦ geral com missões é o `DockGeneral`, na moldura do
// dock. As armadilhas que os testes do painel prendiam continuam valendo para
// o sucessor: papel (nunca painel escuro), componente burro, tooltip da casa.

test('o painel largo foi DEMOLIDO — arquivos, CSS e consumo no Board', async () => {
  await assert.rejects(
    source('src/renderer/src/components/ProjectDashboard.tsx'),
    'o painel largo devia ter saído do repo'
  )
  await assert.rejects(
    source('src/renderer/src/components/MissionDashboardRow.tsx'),
    'a linha do painel devia ter saído junto'
  )

  const css = await source('src/renderer/src/global.css')
  assert.doesNotMatch(css, /^\.pd-[a-z-]*\s*[,{]/mu, 'as regras .pd-* órfãs saíram do CSS')

  const board = await source('src/renderer/src/components/Board.tsx')
  assert.doesNotMatch(board, /ProjectDashboard/u, 'o Board não conhece mais o painel largo')
  assert.match(board, /<DockGeneral/u, 'o retrato compacto entrou no lugar')
})

test('o DockGeneral é PAPEL, burro e fala pela régua única', async () => {
  const general = await source('src/renderer/src/components/DockGeneral.tsx')
  const code = withoutComments(general)

  // O erro que o mockup nomeia: painel escuro fora de terminal.
  assert.doesNotMatch(code, /term-window/u)
  assert.doesNotMatch(code, /--panel/u)
  // Componente burro: quem busca é o Board (nada de IPC nem store aqui).
  assert.doesNotMatch(code, /window\.synkora/u)
  assert.doesNotMatch(code, /useStore/u)
  // Tooltip é `data-tip` (o `title=` nativo é proibido no app). O regex mira
  // ELEMENTO nativo (minúsculo): a prop `title` do DockSection é outra coisa —
  // ela vira o cabeçalho da seção, nunca tooltip do browser.
  assert.match(general, /data-tip=/u)
  assert.doesNotMatch(code, /<[a-z][^>]*\stitle="/u)

  // "N esperando você" nasce da régua única (`waitingOnOwner`) — nunca de uma
  // cópia local de `pendingIntegrationApproval || pulse`.
  assert.match(general, /waitingOnOwner/u)
  assert.doesNotMatch(code, /pendingIntegrationApproval/u, 'a régua não pode ter cópia local')
  // O rastro usa o carimbo real (`recentConcluded` + `formatDay`).
  assert.match(general, /recentConcluded/u)
  assert.match(general, /formatDay/u)
  assert.doesNotMatch(code, /updatedAt/u, 'updatedAt nunca vira tempo')
})

test('o Board escolhe a tela pelo módulo puro e mantém as duas no mesmo limite de erro', async () => {
  const board = await source('src/renderer/src/components/Board.tsx')

  assert.match(board, /import \{ projectLanding \} from '\.\.\/projectLanding'/u)
  // O limite de erro fica POR FORA do ramo: as duas telas dividem o paneId.
  assert.match(
    board,
    /paneId=\{`board-general:\$\{projectId\}`\}[\s\S]{0,600}projectLanding\(projectMissions\) === 'invite'[\s\S]{0,600}<ProjectGeneral/u
  )
  assert.match(board, /<DockGeneral[\s\S]{0,700}<\/GuiPanelErrorBoundary>/u)
  // O convite continua recebendo TODAS as missões (era `liveMissions.length`).
  assert.doesNotMatch(board, /missionCount=\{liveMissions\.length\}/u)
  assert.match(board, /missionCount=\{projectMissions\.length\}/u)
  // Clicar no pulso abre a missão pelo canal de seleção de sempre.
  assert.match(board, /onOpenMission=\{\(id\) => setMissionTab\(projectId, id\)\}/u)
  // O retrato não busca stats: o Board entrega o que o Universe já carregou.
  assert.match(board, /versoes=\{homeStats\?\.versoes\}/u)
  // O KANBAN LEGADO foi DEMOLIDO na purga F6 (2026-08-17) — a supressão virou
  // remoção por ordem do dono. O retrato ocupa a coluna sozinho.
  assert.doesNotMatch(board, /const showKanban =/u)
  assert.doesNotMatch(board, /board-columns/u)
  // A leitura de PLANOS que só o painel largo consumia morreu com ele: o
  // relance mora no MAPA — o ✦ geral não abre uma leitura para não mostrar.
  assert.doesNotMatch(board, /setProjectPlans/u)
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

// RIGHTDOCK ONDA B — "V1.0.6 em desenvolvimento · V1.0.5 na main": o mockup
// mostra as DUAS pontas, e elas são conceitos distintos de propósito. A
// identidade continua sendo `versaoNaMain` (a última LANÇADA); a linha em
// CONSTRUÇÃO é outra pergunta — "onde o trabalho de agora integra" — e a
// resposta mora num helper puro, nunca num find inline de componente.
test('versionInDev = a linha em CONSTRUÇÃO, nunca a identidade', async () => {
  const { versionInDev, versionPortrait } = await landing()

  const { versoes } = versionPortrait(
    [
      version({ id: 'a', name: 'V1.0', status: 'lancada', releasedAt: '2026-08-02T00:00:00.000Z' }),
      version({ id: 'b', name: 'V1.1', status: 'aberta', createdAt: '2026-08-10T00:00:00.000Z' }),
      version({ id: 'c', name: 'V1.2', status: 'aberta', createdAt: '2026-08-15T00:00:00.000Z' })
    ],
    []
  )
  // O retrato lista só as ABERTAS (da mais antiga para a mais nova) — a
  // corrente é a primeira delas.
  assert.equal(versionInDev(versoes), 'V1.1')

  // Sem nenhuma aberta o retrato traz a última lançada como referência — que
  // NÃO está em desenvolvimento: o helper cala em vez de mentir.
  const soLancada = versionPortrait(
    [version({ id: 'a', name: 'V1.0', status: 'lancada', releasedAt: '2026-08-02T00:00:00.000Z' })],
    []
  )
  assert.equal(versionInDev(soLancada.versoes), undefined)
  assert.equal(versionInDev([]), undefined)
  assert.equal(versionInDev(undefined), undefined)
})

test('o chip ◈ do universo e do retrato leem NA MAIN, nunca um find inline', async () => {
  const [universe, general] = await Promise.all([
    source('src/renderer/src/screens/Universe.tsx'),
    source('src/renderer/src/components/DockGeneral.tsx')
  ])

  for (const [name, file] of [
    ['Universe', universe],
    ['DockGeneral', general]
  ]) {
    assert.match(file, /versaoNaMain/u, `${name}: a identidade vem do campo da main`)
    assert.doesNotMatch(
      withoutComments(file),
      /versoes\.find\(/u,
      `${name}: eleger versão varrendo a lista no componente é a régua que o dono reprovou`
    )
  }
  // A linha em construção entra pelo helper puro — o par do teste acima.
  assert.match(general, /versionInDev/u)
})

// O PLANEJAMENTO tem DOIS desfechos (ordem do dono, 2026-08-17): CONCLUIR é o
// caminho feliz de um clique (a missão encerra e some da coluna; plano/ e a
// aba do mapa ficam) e ARQUIVAR é a pausa (retomar depois ou excluir). A
// rodada 3 tinha unificado tudo em "arquivar" e o dono mandou o concluir de
// volta — este teste impede as duas palavras de voltarem a ser uma só.
test('o trilho do planejamento oferece concluir E arquivar, com portas distintas', async () => {
  const rail = await source('src/renderer/src/components/MissionDeliveryRail.tsx')
  assert.match(rail, /✔ concluir planejamento/u, 'o concluir de um clique precisa existir')
  assert.match(rail, /⊟ arquivar planejamento/u, 'o arquivar continua sendo a pausa')
  assert.match(rail, /↩ reabrir planejamento/u, 'reabrir cobre a volta do arquivado')
  assert.match(rail, /onConclude\?: \(\) => void/u, 'o desfecho é prop própria, nunca o onArchive')

  const board = await source('src/renderer/src/components/Board.tsx')
  assert.match(board, /onConclude=\{\(\) => void concludePlanningMission\(selMission\.id\)\}/u)

  const ipc = await source('src/main/ipc/missions.ts')
  assert.match(
    ipc,
    /patch\.status === 'concluida' && missionTypeOf\(mission\) !== 'planejamento'/u,
    'a porta do concluir-por-clique é EXCLUSIVA do planejamento — dev conclui pela integração'
  )
  assert.match(
    ipc,
    /patch\.status === 'arquivada' \|\| patch\.status === 'concluida'/u,
    'concluir encerra os chats da missão como o arquivar (conversa fica gravada)'
  )
})
