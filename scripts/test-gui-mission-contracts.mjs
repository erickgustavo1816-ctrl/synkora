import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GUI_MISSION_ROLES,
  MISSION_PLANNING_NOT_QUEUEABLE,
  MISSION_TYPES,
  guiMissionFirstPrompt,
  guiMissionPaneId,
  guiMissionRoleOf,
  guiSeatNeedsExecutorReset,
  guiMissionSystemPrompt,
  guiPlanningFirstPrompt,
  guiPlanningPaneId,
  guiPlanningSystemPrompt,
  isGuiMissionPaneId,
  isGuiMissionRole,
  isGuiPlanningPaneId,
  isMissionType,
  missionConflictRecipe,
  missionShortId,
  missionTypeOf,
  resumeSessionIdFor,
  routeGuiMissionPane
} from '../src/main/guiMissionContracts.ts'

const MISSION = '7e31d314-1111-2222-3333-444455556666'
const OTHER = 'aaaaaaaa-1111-2222-3333-444455556666'
const PROJECT = 'c0dad302-9999-8888-7777-666655554444'

// A CONVENÇÃO DE paneId é o endereço do resume: o guiSessions grava
// paneId → sessionId, então id instável = conversa nascendo em branco a cada
// reabertura da missão. Estes casos são o contrato dos dois lados.

test('dev e reviewer têm paneId determinístico por missão', () => {
  assert.equal(missionShortId(MISSION), '7e31d314')
  assert.equal(guiMissionPaneId('dev', MISSION), 'gui-dev-7e31d314')
  assert.equal(guiMissionPaneId('reviewer', MISSION), 'gui-reviewer-7e31d314')
  // chamar de novo devolve o MESMO id — é o que faz o resume cair na conversa
  assert.equal(guiMissionPaneId('dev', MISSION), guiMissionPaneId('dev', MISSION))
})

test('ajudante é o único papel plural e nunca sequestra o vizinho', () => {
  assert.equal(guiMissionPaneId('helper', MISSION), 'gui-helper-7e31d314-1')
  assert.equal(guiMissionPaneId('helper', MISSION, 1), 'gui-helper-7e31d314-1')
  assert.equal(guiMissionPaneId('helper', MISSION, 3), 'gui-helper-7e31d314-3')
  assert.notEqual(guiMissionPaneId('helper', MISSION, 1), guiMissionPaneId('helper', MISSION, 2))
  // índice inválido nunca vira id quebrado
  for (const bad of [0, -2, Number.NaN, undefined]) {
    assert.equal(guiMissionPaneId('helper', MISSION, bad), 'gui-helper-7e31d314-1')
  }
})

test('o ceifar reconhece TODOS os panes da missão e nenhum de outra', () => {
  for (const paneId of [
    guiMissionPaneId('dev', MISSION),
    guiMissionPaneId('reviewer', MISSION),
    guiMissionPaneId('helper', MISSION, 1),
    guiMissionPaneId('helper', MISSION, 7)
  ]) {
    assert.equal(isGuiMissionPaneId(paneId, MISSION), true, paneId)
    assert.equal(isGuiMissionPaneId(paneId, OTHER), false, paneId)
  }
  // pane de outra natureza jamais entra na ceifa da missão
  for (const alheio of ['maestro-proj--7e31d314', 'dev-7e31d314', 'gui-dev-7e31d31', '']) {
    assert.equal(isGuiMissionPaneId(alheio, MISSION), false, alheio)
  }
})

test('o papel se lê de volta do paneId', () => {
  assert.equal(guiMissionRoleOf('gui-dev-7e31d314'), 'dev')
  assert.equal(guiMissionRoleOf('gui-reviewer-7e31d314'), 'reviewer')
  assert.equal(guiMissionRoleOf('gui-helper-7e31d314-2'), 'helper')
  assert.equal(guiMissionRoleOf('maestro-proj--7e31d314'), undefined)
})

test('papel desconhecido é recusado antes de virar pane', () => {
  for (const role of GUI_MISSION_ROLES) assert.equal(isGuiMissionRole(role), true)
  for (const bad of ['maestro', 'qa', '', null, undefined, 7]) {
    assert.equal(isGuiMissionRole(bad), false)
  }
})

// CONTRATOS: curtos de propósito, um por papel, e a cerca do reviewer é a que
// o dono mandou escrever ("revisar a qualidade do que foi entregue, APENAS").

test('cada papel tem contrato próprio e todos respondem em PT-BR', () => {
  const seen = new Set()
  for (const role of GUI_MISSION_ROLES) {
    const contract = guiMissionSystemPrompt(role)
    assert.ok(contract.length > 200, `${role}: contrato vazio demais`)
    assert.ok(contract.length < 2400, `${role}: contrato virou constituição`)
    assert.ok(/PT-BR/.test(contract), `${role}: sem a regra do idioma`)
    assert.equal(seen.has(contract), false, `${role}: contrato repetido`)
    seen.add(contract)
  }
})

test('o reviewer nunca legisla capacidade que a missão não prometeu', () => {
  const contract = guiMissionSystemPrompt('reviewer')
  assert.match(contract, /NEVER LEGISLATE/)
  assert.match(contract, /do NOT edit the product/i)
})

test('o dev espera aval antes de trabalho grande e trabalha só no worktree', () => {
  const contract = guiMissionSystemPrompt('dev')
  assert.match(contract, /MINI-PLAN/)
  assert.match(contract, /ONLY inside this worktree/i)
})

// PRIMEIRO TURNO: é o único briefing que o pane recebe.

test('o briefing do reviewer aponta o diff do que foi entregue', () => {
  const prompt = guiMissionFirstPrompt('reviewer', {
    title: 'Tela de créditos',
    goal: 'Listar os créditos por empresa',
    baseBranch: 'version/v1.2'
  })
  assert.match(prompt, /MISSION: Tela de créditos/)
  assert.match(prompt, /Listar os créditos por empresa/)
  assert.match(prompt, /git diff version\/v1\.2\.\.\.HEAD/)
})

test('sem baseBranch o reviewer cai em main em vez de um comando quebrado', () => {
  const prompt = guiMissionFirstPrompt('reviewer', { title: 'X' })
  assert.match(prompt, /git diff main\.\.\.HEAD/)
})

test('o briefing do dev restata o goal antes de qualquer tool call', () => {
  const prompt = guiMissionFirstPrompt('dev', {
    title: 'Tela de créditos',
    goal: 'Listar os créditos',
    scope: 'src/renderer',
    branch: 'mission/7e31d314'
  })
  assert.match(prompt, /SCOPE: src\/renderer/)
  assert.match(prompt, /mission\/7e31d314/)
  assert.match(prompt, /VERY FIRST output/)
})

test('o ajudante espera a fatia antes de tocar em arquivo', () => {
  const prompt = guiMissionFirstPrompt('helper', { title: 'Tela de créditos' })
  assert.match(prompt, /wait for the specific slice/i)
})

// RECEITA DO CONFLITO: em 2.0 o bloqueio volta para quem escreveu, não para um
// orquestrador que não existe.

test('a receita do conflito nomeia as duas branches e o movimento', () => {
  const text = missionConflictRecipe({
    missionTitle: 'Tela de créditos',
    detail: 'conflito em src/a.ts, src/b.ts',
    targetBranch: 'version/v1.2',
    sourceBranch: 'mission/7e31d314'
  })
  assert.match(text, /Tela de créditos/)
  assert.match(text, /conflito em src\/a\.ts, src\/b\.ts/)
  assert.match(text, /traga version\/v1\.2 para dentro de mission\/7e31d314/)
  assert.match(text, /commite e avise o dono/)
})

test('sem branch conhecida a receita ainda é legível', () => {
  const text = missionConflictRecipe({ missionTitle: 'M', detail: 'destino sujo' })
  assert.match(text, /a branch de destino/)
  assert.match(text, /a branch desta missão/)
})

// PLANEJAMENTO (onda C): o PM permanente saiu da frente e esta sessão ocupou a
// coluna "✦ geral". Mesma convenção de endereço estável — reabrir o universo
// tem de cair na MESMA conversa, não numa em branco.

test('o pane de planejamento tem endereço estável por projeto', () => {
  assert.equal(guiPlanningPaneId(PROJECT), 'gui-plan-c0dad302')
  assert.equal(guiPlanningPaneId(PROJECT), guiPlanningPaneId(PROJECT))
  assert.notEqual(guiPlanningPaneId(PROJECT), guiPlanningPaneId(OTHER))
})

test('o ceifar por projeto pega o planejamento e NUNCA um chat de missão', () => {
  assert.equal(isGuiPlanningPaneId(guiPlanningPaneId(PROJECT), PROJECT), true)
  assert.equal(isGuiPlanningPaneId(guiPlanningPaneId(PROJECT), OTHER), false)
  // O chat de missão roda no worktree (userData) e sobrevive a relocar/excluir
  // o projeto — se caísse nesta ceifa, o dono perderia a conversa à toa.
  for (const paneId of [
    guiMissionPaneId('dev', MISSION),
    guiMissionPaneId('reviewer', MISSION),
    guiMissionPaneId('helper', MISSION, 2)
  ]) {
    assert.equal(isGuiPlanningPaneId(paneId, PROJECT), false, paneId)
  }
  // e o inverso: o planejamento nunca entra na ceifa de uma missão
  assert.equal(isGuiPlanningPaneId(guiPlanningPaneId(PROJECT), PROJECT), true)
  assert.equal(isGuiMissionPaneId(guiPlanningPaneId(PROJECT), MISSION), false)
  assert.equal(guiMissionRoleOf(guiPlanningPaneId(PROJECT)), undefined)
})

test('o planejador PROPÕE o plano, não executa produto nem cria missão', () => {
  const contract = guiPlanningSystemPrompt()
  assert.ok(contract.length > 200, 'contrato vazio demais')
  assert.ok(contract.length < 3200, 'contrato virou constituição')
  assert.match(contract, /PT-BR/)
  assert.match(contract, /ONE-OFF/)
  assert.match(contract, /do NOT execute product work/i)
  assert.match(contract, /CREATED BY THE OWNER/)
  // 2.0 onda D: o entregável estruturado é a PROPOSTA, e ela nunca cria nada —
  // quem cria é o clique do dono no card (porteira mecânica, não persona).
  assert.match(contract, /propose_plan/)
  assert.match(contract, /never creates anything/i)
  assert.match(contract, /END YOUR TURN and wait/i)
  for (const tool of ['list_plans', 'get_plan', 'update_plan', 'delete_plan']) {
    assert.ok(contract.includes(tool), `sem a ferramenta ${tool}`)
  }
  // O brief em prosa CONTINUA no repo: o JSON é a estrutura, o markdown é a
  // profundidade — um não substitui o outro (D4.6). E o roadmap.md deixou de
  // ser exigido, porque o mapa passou a ser o roadmap.
  assert.match(contract, /plano\/NNN-slug\.md/)
  assert.match(contract, /docPath/)
  assert.equal(
    /WRITE the plan into the repository/.test(contract),
    false,
    'o plano estruturado não se escreve mais como roadmap.md'
  )
  for (const section of [
    'Objetivo',
    'Fora de escopo',
    'Critério de pronto',
    'Tier',
    'Contexto'
  ]) {
    assert.ok(contract.includes(section), `sem a seção ${section}`)
  }
  // uma entrega por missão é a régua do dono ("título com 'e' = duas missões")
  assert.match(contract, /ONE DELIVERABLE PER MISSION/)
  // aval explícito antes de escrever: ausência nunca é consentimento
  assert.match(contract, /silence is not consent/i)
})

test('o planejador é diferente de todos os contratos de missão', () => {
  const planning = guiPlanningSystemPrompt()
  for (const role of GUI_MISSION_ROLES) {
    assert.notEqual(planning, guiMissionSystemPrompt(role), `contrato repetido com ${role}`)
  }
})

test('o 1º turno do planejamento nomeia o caderno em vez de dizer "não existe"', () => {
  const fresh = guiPlanningFirstPrompt({ projectName: 'PAINEL DE GESTÃO' })
  assert.match(fresh, /PROJECT: PAINEL DE GESTÃO/)
  assert.match(fresh, /no plano\/ files yet/)
  assert.match(fresh, /VERY FIRST output/)
  // e o estudo começa pelo que já está planejado, nunca por uma proposta cega
  assert.match(fresh, /list_plans/)
  // sem versão aberta o cabeçalho não inventa uma
  assert.equal(/VERSION IN PROGRESS/.test(fresh), false)

  const resumed = guiPlanningFirstPrompt({
    projectName: 'PAINEL DE GESTÃO',
    versionName: 'v1.2',
    roadmapExists: true
  })
  assert.match(resumed, /VERSION IN PROGRESS: v1\.2/)
  // compat: o roadmap.md legado continua sendo LIDO e absorvido (D4.6)
  assert.match(resumed, /legacy plano\/roadmap\.md/)
  assert.equal(/no plano\/ files yet/.test(resumed), false)
})

// TIPO DA MISSÃO: o planejamento deixou de ser um convite que aparece sozinho
// na coluna "✦ geral" e virou algo que o dono CRIA. O carimbo é de NASCIMENTO,
// e ausência é 'dev' — senão toda missão que já está no disco mudaria de
// natureza no primeiro boot depois desta mudança.

test('missão sem carimbo é de desenvolvimento, e o carimbo só aceita o que existe', () => {
  assert.deepEqual([...MISSION_TYPES], ['dev', 'planejamento'])
  for (const type of MISSION_TYPES) assert.equal(isMissionType(type), true)
  for (const bad of ['plan', 'planning', 'DEV', '', null, undefined, 7, {}]) {
    assert.equal(isMissionType(bad), false)
  }
  // legado (o disco de hoje) e ruído nunca viram planejamento por acidente
  assert.equal(missionTypeOf(undefined), 'dev')
  assert.equal(missionTypeOf({}), 'dev')
  assert.equal(missionTypeOf({ missionType: undefined }), 'dev')
  assert.equal(missionTypeOf({ missionType: 'dev' }), 'dev')
  assert.equal(missionTypeOf({ missionType: 'planning' }), 'dev')
  assert.equal(missionTypeOf({ missionType: 'planejamento' }), 'planejamento')
})

test('missão de dev abre os três papéis no worktree isolado', () => {
  for (const role of GUI_MISSION_ROLES) {
    for (const mission of [{}, { missionType: 'dev' }, { missionType: 'planning' }]) {
      const route = routeGuiMissionPane(mission, role)
      assert.equal(route.ok, true, `${role}: recusado`)
      assert.equal(route.missionType, 'dev')
      // a razão de a missão existir: o pane NUNCA nasce na branch principal
      assert.equal(route.workspace, 'worktree')
      assert.equal(route.systemPrompt, guiMissionSystemPrompt(role))
    }
  }
})

test('missão de planejamento é UMA conversa, na raiz, com o contrato do planejador', () => {
  const planning = { missionType: 'planejamento' }
  const route = routeGuiMissionPane(planning, 'dev')
  assert.equal(route.ok, true)
  assert.equal(route.missionType, 'planejamento')
  // RAIZ do projeto: ela lê o produto inteiro e escreve plano/ — pedir
  // worktree aqui criaria uma branch que ninguém jamais mesclaria.
  assert.equal(route.workspace, 'project-root')
  assert.equal(route.systemPrompt, guiPlanningSystemPrompt())
  assert.notEqual(route.systemPrompt, guiMissionSystemPrompt('dev'))
  // e o endereço do resume continua sendo o da missão: uma conversa por missão
  assert.equal(guiMissionPaneId('dev', MISSION), `gui-dev-${missionShortId(MISSION)}`)
})

test('planejamento não abre revisor nem ajudante', () => {
  for (const role of ['reviewer', 'helper']) {
    const route = routeGuiMissionPane({ missionType: 'planejamento' }, role)
    assert.equal(route.ok, false, `${role}: deixou abrir`)
    assert.match(route.error, /uma conversa só/)
  }
})

test('papel desconhecido é recusado antes do roteamento, em qualquer tipo', () => {
  for (const mission of [{}, { missionType: 'planejamento' }]) {
    for (const bad of ['maestro', 'qa', '', null, undefined]) {
      const route = routeGuiMissionPane(mission, bad)
      assert.equal(route.ok, false)
      assert.match(route.error, /papel desconhecido/)
    }
  }
})

test('a fila explica a porta errada em vez de acusar bloqueio', () => {
  // A mesma string que o motor devolve no ⇪ — o teste lê a fonte, não uma cópia.
  assert.match(MISSION_PLANNING_NOT_QUEUEABLE, /planejamento/)
  assert.match(MISSION_PLANNING_NOT_QUEUEABLE, /não entra na fila/)
  assert.match(MISSION_PLANNING_NOT_QUEUEABLE, /plano\//)
})

// PRIMEIRO TURNO DO PLANEJAMENTO COMO MISSÃO: o convite genérico da coluna
// "✦ geral" não tinha recorte nenhum; a missão tem o que o dono escreveu.

test('o recorte que o dono escreveu na missão viaja no 1º turno', () => {
  const prompt = guiPlanningFirstPrompt({
    projectName: 'PAINEL DE GESTÃO',
    focus: 'Planejar a v1.3\nFoco em créditos e PERDCOMP'
  })
  assert.match(prompt, /WHAT THE OWNER ASKED FOR:/)
  assert.match(prompt, /Planejar a v1\.3/)
  assert.match(prompt, /Foco em créditos e PERDCOMP/)
  // sem recorte (o convite do universo) o cabeçalho não inventa a seção
  const bare = guiPlanningFirstPrompt({ projectName: 'PAINEL DE GESTÃO' })
  assert.equal(/WHAT THE OWNER ASKED FOR/.test(bare), false)
  for (const empty of ['', '   ']) {
    assert.equal(
      /WHAT THE OWNER ASKED FOR/.test(
        guiPlanningFirstPrompt({ projectName: 'X', focus: empty })
      ),
      false
    )
  }
})

// GUARDA DO RESUME: conversa gravada só vale no MESMO CLI — sessão do claude
// não se retoma no codex. Régua única do chat da missão e do planejamento.

test('resume só sobrevive quando o CLI do seat continua o mesmo', () => {
  const claude = { sessionId: 'sess-1', cli: 'claude' }
  assert.equal(resumeSessionIdFor(claude, 'claude'), 'sess-1')
  assert.equal(resumeSessionIdFor(claude, 'codex'), undefined)

  const codex = { sessionId: 'codex-thread:abc', cli: 'codex' }
  assert.equal(resumeSessionIdFor(codex, 'codex'), 'codex-thread:abc')
  assert.equal(resumeSessionIdFor(codex, 'claude'), undefined)
})

test('registro ausente ou capenga nunca vira um --resume quebrado', () => {
  assert.equal(resumeSessionIdFor(undefined, 'claude'), undefined)
  assert.equal(resumeSessionIdFor({ cli: 'claude' }, 'claude'), undefined)
  assert.equal(resumeSessionIdFor({ sessionId: '', cli: 'claude' }, 'claude'), undefined)
  assert.equal(resumeSessionIdFor({ sessionId: 'x' }, 'claude'), undefined)
})

test('troca de seat só reseta modelo e effort quando atravessa CLI', () => {
  assert.equal(guiSeatNeedsExecutorReset({ cli: 'claude' }, { cli: 'claude' }, true), false)
  assert.equal(guiSeatNeedsExecutorReset({ cli: 'claude' }, { cli: 'codex' }, true), true)
  assert.equal(guiSeatNeedsExecutorReset(undefined, { cli: 'codex' }, false), false)
  assert.equal(
    guiSeatNeedsExecutorReset(undefined, { cli: 'codex' }, true),
    true,
    'seat gravado mas removido falha fechado'
  )
})
