// O PAINEL DE PADRÕES DA DELEGAÇÃO — "abinha do lado" (D8 do design vinculante
// `.synkora/reports/DESIGN_SUBAGENTES_SEM_ABA_2026-08-18.md`).
//
// Ordem do dono (18/08, tarde): "como padrão vai vir eles; caso eu queira
// outros, aí eu falo". Esta suíte prova as quatro metades do painel:
//   1. a régua PURA (catálogo real dos DOIS CLIs, effort filtrado por modelo,
//      resumo honesto quando nada está carimbado);
//   2. o CONTRATO DE FONTE da superfície (a abinha nasce recolhida, fala PT-BR,
//      está montada no chat e só aparece em chat que DELEGA);
//   3. a linha da persona — o agente precisa saber que o pino do dono existe;
//   4. o CATÁLOGO que alimenta tudo isso (R13): a marca de fast que os dois
//      CLIs publicam com nomes diferentes e o painel lê numa chave só.
//
// Como rodar: `npm run test:gui-delegation-defaults` — SEMPRE pelo npm, porque
// o script recompila `src/main/catalog.ts` em `.tmp/` antes do node (o `.mjs`
// solto rodaria a compilação velha).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  guiDelegationEffortOptions,
  guiDelegationModelGroups,
  guiDelegationModelLabelParts,
  guiDelegationModelOption,
  guiDelegationSummary,
  guiPaneDelegates
} from '../src/renderer/src/guiDelegationDefaults.ts'
import { guiModelShortName } from '../src/renderer/src/guiComposerPresentation.ts'
import {
  GUI_MISSION_ROLES,
  guiMissionSystemPrompt,
  guiPlanningSystemPrompt
} from '../src/main/guiMissionContracts.ts'
// O catálogo também é do MAIN, mas importa irmão sem extensão (`./winPath`), e
// o type-stripping do node não resolve isso: por isso ele chega compilado.
import {
  CLAUDE_FALLBACK_MODELS,
  CODEX_FALLBACK_MODELS,
  claudeModelsFromHandshake,
  codexModelsFromDebug
} from '../.tmp/gui-delegation-defaults-test/catalog.js'

const source = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

/**
 * O EMBELEZADOR DE ID do composer (`prettyModel`, em `PaneChrome.tsx`),
 * executado a partir do fonte: ele mora num componente React, que não roda em
 * node puro, mas é metade da fonte única de nome digno — e um teste que o
 * imitasse provaria a imitação, não o app.
 */
function composerPrettyModel() {
  const chrome = source('src/renderer/src/components/PaneChrome.tsx')
  const body = chrome.match(
    /export function prettyModel\(id: string\): string \{\r?\n([\s\S]*?)\r?\n\}/u
  )?.[1]
  assert.ok(body, 'o embelezador de id do composer saiu do PaneChrome')
  return new Function('id', body)
}

/** A régua COMPLETA do seletor de modelo do composer: nome do catálogo
 *  primeiro, embelezador do id quando o catálogo só repete o identificador. */
function composerNamer() {
  const prettyModel = composerPrettyModel()
  return ({ id, displayName }) =>
    guiModelShortName({ value: id, displayName, resolvedModel: id }, prettyModel(id))
}

/** QUANDO O ⚡ APARECE (R13 §B3), executado a partir do fonte do painel — mesma
 *  técnica do embelezador acima, e pelo mesmo motivo: a régua mora num
 *  componente React, e um teste que a imitasse provaria a imitação. */
function panelFastChipVisible() {
  const panel = source('src/renderer/src/components/GuiDelegationDefaults.tsx')
  const expression = panel.match(/const fastChipVisible = (.+)\r?\n/u)?.[1]
  assert.ok(expression, 'a régua de visibilidade do ⚡ saiu do painel')
  return new Function('defaults', 'pinnedOption', `return ${expression}`)
}

/**
 * O `chooseModel` do painel (R13 §B4), executado a partir do fonte com as
 * dependências injetadas: `apply` vira um coletor, e o teste lê os patches que
 * o painel REALMENTE mandaria ao main.
 */
function panelChooseModel() {
  const panel = source('src/renderer/src/components/GuiDelegationDefaults.tsx')
  const body = panel.match(
    /const chooseModel = useCallback\(\r?\n\s*\(model: string \| null\): void => \{\r?\n([\s\S]*?)\r?\n {4}\},/u
  )?.[1]
  assert.ok(body, 'o chooseModel saiu do painel')
  const run = new Function(
    'model',
    'apply',
    'defaults',
    'groups',
    'guiDelegationEffortOptions',
    'guiDelegationModelOption',
    body
  )
  return (defaults, groups, model) => {
    const patches = []
    run(
      model,
      (patch) => patches.push(patch),
      defaults,
      groups,
      guiDelegationEffortOptions,
      guiDelegationModelOption
    )
    return patches
  }
}

/** Catálogos como o `catalog.ts` os devolve: o do claude costuma vir SEM
 *  `efforts` por modelo (fallback curado), o do codex traz nível por modelo. O
 *  `supportsFastMode` copia a sonda de 19/08 — só opus e sol têm o modo. */
const CATALOGS = [
  {
    cli: 'claude',
    models: [
      { id: 'fable', label: 'fable — o mais capaz', supportsFastMode: false },
      { id: 'opus[1m]', label: 'opus — equilíbrio (1M ctx)', supportsFastMode: true },
      { id: 'haiku', label: 'haiku — o mais rápido', efforts: [], supportsFastMode: false }
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max']
  },
  {
    cli: 'codex',
    models: [
      {
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6-Sol',
        efforts: ['minimal', 'low', 'medium', 'high'],
        supportsFastMode: true
      }
    ],
    efforts: ['minimal', 'low', 'medium', 'high']
  }
]

// ————— 1. A RÉGUA PURA —————

test('o painel oferece os DOIS catálogos, agrupados por CLI', () => {
  const groups = guiDelegationModelGroups(CATALOGS)
  assert.deepEqual(
    groups.map((group) => [group.cli, group.options.length]),
    [
      ['claude', 3],
      ['codex', 1]
    ],
    'cross-CLI é cidadão de primeira classe: o pino pode ser do outro binário'
  )
  assert.equal(groups[0].options[0].id, 'fable')
  assert.equal(groups[0].options[0].label, 'fable — o mais capaz')
  assert.equal(guiDelegationModelOption(groups, 'gpt-5.6-sol')?.cli, 'codex')
  assert.equal(guiDelegationModelOption(groups, 'não-existe'), undefined)
  // Catálogo que ainda não chegou não inventa grupo vazio na tela.
  assert.deepEqual(guiDelegationModelGroups([{ cli: 'claude', models: [], efforts: [] }]), [])
})

test('o effort é filtrado pelo MODELO escolhido, e "não aceita" é dito', () => {
  const groups = guiDelegationModelGroups(CATALOGS)
  assert.deepEqual(guiDelegationEffortOptions(groups, 'gpt-5.6-sol'), [
    'minimal',
    'low',
    'medium',
    'high'
  ])
  // Modelo sem `efforts` no catálogo herda os níveis DAQUELE CLI — nunca os do
  // outro (as escalas não se misturam).
  assert.deepEqual(guiDelegationEffortOptions(groups, 'fable'), [
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
  ])
  // haiku DECLARA lista vazia (sonda 2026-08-18 §2.4): o flag é engolido, e
  // carimbar "haiku · low" na lateral seria mentira.
  assert.deepEqual(guiDelegationEffortOptions(groups, 'haiku'), [])
  assert.deepEqual(guiDelegationEffortOptions(groups, undefined), [])
})

test('o resumo da abinha diz a verdade quando nada foi carimbado', () => {
  assert.equal(guiDelegationSummary({}), 'herdado da conversa')
  assert.equal(guiDelegationSummary({ model: 'fable' }), 'fable')
  assert.equal(guiDelegationSummary({ model: 'fable', effort: 'low' }), 'fable · low')
  assert.equal(
    guiDelegationSummary({ effort: 'low' }),
    'modelo da conversa · low',
    'effort sozinho não pode parecer um modelo'
  )
})

// ————— 2. QUEM VÊ A ABINHA —————
//
// Só chat que DELEGA. O sinal é derivado dos args do MCP, exatamente como o
// `guiSpawnSuppressesNativeAgents` deriva a cerca do codex: campo novo no
// GuiPaneSpawn precisaria ser repetido à mão em quatro listas do renderer, e foi
// o silêncio dessas listas que já deixou um chat sem ferramenta por uma noite.

test('a abinha só existe em chat com o kit de DELEGAÇÃO', () => {
  assert.equal(guiPaneDelegates(undefined), false, 'chat sem ferramenta não delega')
  assert.equal(
    guiPaneDelegates({ args: ['--mcp-config', 'x.json', '--strict-mcp-config'] }),
    false,
    'o planejador tem MCP e não delega'
  )
  assert.equal(
    guiPaneDelegates({ args: ['--mcp-config', 'x.json', '--disallowedTools', 'Task,Agent'] }),
    true
  )
  assert.equal(
    guiPaneDelegates({
      args: ['-c', 'mcp_servers.synkora.url=http://x', '-c', 'features.multi_agent=false']
    }),
    true
  )
})

test('os marcadores da detecção são os que o main REALMENTE emite', () => {
  const delegateMcp = source('src/main/guiDelegateMcp.ts')
  const plannerMcp = source('src/main/guiPlannerMcp.ts')
  const claudeArgs = delegateMcp.match(
    /export function guiDelegateClaudeArgs[\s\S]*?\n\}/u
  )?.[0]
  const codexArgs = delegateMcp.match(/export function guiDelegateCodexArgs[\s\S]*?\n\}/u)?.[0]
  assert.ok(claudeArgs && codexArgs, 'os construtores de args do kit de delegação sumiram')
  assert.match(claudeArgs, /--disallowedTools/u)
  assert.match(codexArgs, /CODEX_NATIVE_AGENT_FENCE_ARG/u)
  assert.match(delegateMcp, /CODEX_NATIVE_AGENT_FENCE_ARG = 'features\.multi_agent=false'/u)
  // E o kit de PLANOS não pode casar com nenhum dos dois marcadores.
  const plannerArgs = plannerMcp.match(/export function guiPlannerCodexArgs[\s\S]*?\n\}/u)?.[0]
  assert.ok(plannerArgs)
  assert.doesNotMatch(plannerArgs, /multi_agent/u)
  assert.doesNotMatch(plannerMcp, /disallowedTools/u)
})

// ————— 3. A SUPERFÍCIE —————

test('a abinha nasce recolhida, abre no clique e fala PT-BR', () => {
  const panel = source('src/renderer/src/components/GuiDelegationDefaults.tsx')
  assert.match(panel, /useState\(false\)/u, 'painel aberto de fábrica não é discreto')
  assert.match(panel, /aria-expanded=\{open\}/u)
  assert.match(panel, /padrão dos ajudantes/u)
  assert.match(panel, /herdado da conversa|guiDelegationSummary/u)
  assert.match(panel, />\s*limpar\s*</u, 'sem a saída, o pino do dono vira armadilha')
  assert.match(panel, /modelo/u)
  assert.match(panel, /effort/u)
  // Diálogo nativo QUEBRA o foco da janela no Windows (regra do CLAUDE.md).
  assert.doesNotMatch(panel, /window\.(confirm|alert)/u)
  // O renderer nunca fala com o main direto: a costura é o guiApi.
  assert.doesNotMatch(panel, /window\.synkora/u)
  assert.match(panel, /guiApi\.delegationDefaults|delegationDefaults\(/u)
})

test('o painel usa o catálogo REAL dos dois CLIs, não as caps do pane', () => {
  const panel = source('src/renderer/src/components/GuiDelegationDefaults.tsx')
  assert.match(panel, /loadCatalog/u, 'a lista tem de vir do catalog.ts, por CLI')
  assert.match(panel, /catalogByCli/u)
  assert.match(panel, /'claude'/u)
  assert.match(panel, /'codex'/u)
  assert.match(panel, /guiDelegationEffortOptions/u)
  // O effort do modelo que NÃO aceita nível não pode virar uma lista vazia muda.
  assert.match(panel, /—/u)
})

test('o chat monta a abinha, e só quando ele delega', () => {
  const pane = source('src/renderer/src/components/GuiPane.tsx')
  assert.match(pane, /import GuiDelegationDefaults from '\.\/GuiDelegationDefaults'/u)
  assert.match(pane, /guiPaneDelegates\(mcp\)/u)
  assert.match(pane, /<GuiDelegationDefaults/u)
  const mount = pane.match(/\{[^\n]*delegat[^\n]*&&[\s\S]{0,400}?<GuiDelegationDefaults[\s\S]*?\/>/u)
  assert.ok(mount, 'a montagem precisa ser condicional ao chat que delega')
  assert.match(mount[0], /paneId=\{paneId\}/u)
})

test('a abinha tem casa no CSS de papel do chat', () => {
  const css = source('src/renderer/src/global.css')
  assert.match(css, /\.gui-deleg-defaults\s*\{/u)
  assert.match(css, /\.gui-deleg-tab\s*\{/u)
  assert.match(css, /\.gui-deleg-panel\s*\{/u)
  // Papel, nunca `--panel`: a superfície escura é exclusiva do TerminalPane.
  const block =
    css.match(/\.gui-deleg-defaults\s*\{[\s\S]*?\n\}/u)?.[0] ?? ''
  assert.doesNotMatch(block, /var\(--panel\)/u)
})

// ————— 3B. O PAINEL DIGNO (design R7 §B2) —————
//
// 5º achado da validação ao vivo: "Tá muito feio... Opus Rochetes um milhão".
// O painel mostrava id CRU (`opus[1m]`, `gpt-5.6-sol`) onde o seletor de modelo
// do composer mostra nome digno. A decisão: a MESMA fonte de nome dos dois
// lados — o id cru vira metadado discreto, nunca título.

test('R7B2 — o catálogo se parte em NOME e descrição, e o id nunca é o título', () => {
  // `catalog.ts` escreve `${displayName} — ${description}`: o nome é a cabeça.
  assert.deepEqual(guiDelegationModelLabelParts('opus[1m]', 'opus — equilíbrio (1M ctx)'), {
    displayName: 'opus',
    detail: 'equilíbrio (1M ctx)'
  })
  // Sem descrição (o `display_name` do codex) a cabeça é o rótulo inteiro.
  assert.deepEqual(guiDelegationModelLabelParts('gpt-5.6-sol', 'GPT-5.6-Sol'), {
    displayName: 'GPT-5.6-Sol',
    detail: null
  })
  // Catálogo que só REPETE o id não tem nome humano nenhum a oferecer: a cabeça
  // sai vazia para o embelezador do id assumir (o `prettyModel` do composer).
  assert.deepEqual(guiDelegationModelLabelParts('opus[1m]', 'opus[1m]'), {
    displayName: '',
    detail: null
  })
  assert.deepEqual(guiDelegationModelLabelParts('opus[1m]', '  opus[1m]  '), {
    displayName: '',
    detail: null
  })
  // Mas a CAIXA é nome humano, não repetição: o `display_name` do codex difere
  // do slug só por ela, e é essa palavra que o seletor do composer mostra.
  assert.equal(
    guiDelegationModelLabelParts('gpt-5.6-sol', 'GPT-5.6-Sol').displayName,
    'GPT-5.6-Sol'
  )
  // E ter DESCRIÇÃO já prova que o catálogo escolheu um nome: `fable` coincidir
  // com o alias não é motivo para jogar a palavra fora e virar `FABLE` do lado
  // de `opus` — duas vozes na mesma lista é o feio que a rodada veio consertar.
  assert.deepEqual(guiDelegationModelLabelParts('fable', 'fable — o mais capaz'), {
    displayName: 'fable',
    detail: 'o mais capaz'
  })
})

test('R7B2 — o painel escreve o MESMO nome que o seletor do composer', () => {
  const namer = composerNamer()
  const groups = guiDelegationModelGroups(CATALOGS, namer)
  const option = (id) => guiDelegationModelOption(groups, id)

  // O que o dono viu feio, agora com nome: id cru só como metadado.
  assert.equal(option('opus[1m]').name, 'opus')
  assert.equal(option('opus[1m]').id, 'opus[1m]')
  assert.equal(option('opus[1m]').detail, 'equilíbrio (1M ctx)')
  assert.equal(option('gpt-5.6-sol').name, 'GPT-5.6-Sol')
  assert.equal(option('gpt-5.6-sol').detail, null)
  assert.equal(option('fable').name, 'fable')
  // O rótulo CRU do catálogo continua inteiro na ficha (é ele que vira dica).
  assert.equal(option('fable').label, 'fable — o mais capaz')

  // Catálogo que só repete o id: o título é o nome BONITO do id, jamais o id.
  const [cru] = guiDelegationModelGroups(
    [{ cli: 'claude', models: [{ id: 'opus[1m]', label: 'opus[1m]' }], efforts: ['max'] }],
    namer
  )
  assert.equal(cru.options[0].name, 'OPUS 1M')
  assert.notEqual(cru.options[0].name, 'opus[1m]')

  // Sem embelezador injetado a régua não inventa nada — é o painel que traz a
  // fonte única do composer, e a metade pura só sabe o que o catálogo disse.
  const semNome = guiDelegationModelGroups(CATALOGS)
  assert.equal(guiDelegationModelOption(semNome, 'opus[1m]').name, 'opus')
})

test('R7B2 — a abinha recolhida mostra o nome digno, não o id', () => {
  const groups = guiDelegationModelGroups(CATALOGS, composerNamer())
  assert.equal(guiDelegationSummary({ model: 'opus[1m]' }, groups), 'opus')
  assert.equal(guiDelegationSummary({ model: 'opus[1m]', effort: 'max' }, groups), 'opus · max')
  assert.equal(
    guiDelegationSummary({ model: 'gpt-5.6-sol', effort: 'high' }, groups),
    'GPT-5.6-Sol · high'
  )
  // Pino que o catálogo carregado não conhece continua dito COMO FOI CARIMBADO:
  // trocar por um nome inventado esconderia justamente o pino que precisa de
  // atenção. E sem catálogo nenhum a verdade é a mesma.
  assert.equal(guiDelegationSummary({ model: 'opus[1m]' }), 'opus[1m]')
  assert.equal(guiDelegationSummary({ model: 'modelo-x' }, groups), 'modelo-x')
  assert.equal(guiDelegationSummary({}, groups), 'herdado da conversa')
  assert.equal(guiDelegationSummary({ effort: 'low' }, groups), 'modelo da conversa · low')
})

test('R7B2 — a superfície busca o nome na fonte única, e o id vira metadado', () => {
  const panel = source('src/renderer/src/components/GuiDelegationDefaults.tsx')

  // A FONTE ÚNICA: as duas metades da régua do composer, importadas, nunca
  // reescritas aqui.
  assert.match(panel, /import \{ guiModelShortName \} from '\.\.\/guiComposerPresentation'/u)
  assert.match(panel, /import \{ prettyModel \} from '\.\/PaneChrome'/u)
  assert.match(panel, /guiDelegationModelGroups\(catalogs, MODEL_NAMER\)/u)

  // Título e metadado são elementos DIFERENTES: nome em cima, id embaixo.
  const nome = panel.indexOf('className="gui-deleg-item-name">{option.name}')
  const id = panel.indexOf('className="gui-deleg-item-id">{option.id}')
  assert.ok(nome > 0, 'o título da ficha do modelo tem de ser o NOME')
  assert.ok(id > 0, 'o id cru precisa de um papel próprio de metadado')
  assert.ok(id > nome, 'o id nunca vem antes do nome: título em cima, motor embaixo')

  // Escolha ligada é ESTADO, não só cor: o leitor de tela precisa ouvi-la.
  assert.match(panel, /aria-pressed=/u)
  // A dica é a do app (`data-tip`, via portal); o `title=` nativo é feio, lento
  // e some no Windows — o Tooltip da casa existe justamente para substituí-lo.
  assert.doesNotMatch(panel, /\stitle=\{/u)
  assert.match(panel, /data-tip=/u)

  // ESPERANDO ≠ VAZIO: enquanto os CLIs não respondem o painel diz que está
  // consultando; só depois disso o silêncio vira ausência.
  assert.match(panel, /consultando/u)
  assert.match(panel, /nenhum CLI respondeu/u)

  // O pino que o catálogo não conhece continua VISÍVEL como escolha ligada —
  // um pino invisível é o estado mais enganoso possível deste painel.
  assert.match(panel, /fora do catálogo/u)

  // A abinha recolhida lê o resumo JÁ com o catálogo em mãos — e vai buscá-lo
  // quando há pino, mesmo fechada: era a linha recolhida que escrevia
  // `opus[1m]`, e sem catálogo não existe nome digno para carregar ali.
  assert.match(panel, /guiDelegationSummary\(defaults, groups\)/u)
  assert.match(
    panel,
    /open \|\| Boolean\(defaults\.model\)/u,
    'com pino carimbado, a linha recolhida precisa do catálogo para nomeá-lo'
  )

  // EFFORT: o painel fala a mesma língua do seletor de esforço do composer —
  // o nível cru e "padrão do modelo" para o default.
  const pane = source('src/renderer/src/components/GuiPane.tsx')
  assert.match(pane, /padrão do modelo/u)
  assert.match(panel, /padrão do modelo/u)
})

test('R7B2 — o painel passa no AA do papel e diz a escolha por FORMA', () => {
  const css = source('src/renderer/src/global.css')
  const start = css.indexOf('ABINHA DO PADRÃO DOS AJUDANTES (D8)')
  const end = css.indexOf('.gui-composer-surface {')
  assert.ok(start > 0 && end > start, 'o bloco da abinha sumiu do CSS de papel')
  const bloco = css.slice(start, end)

  assert.match(bloco, /\.gui-deleg-item-name \{/u)
  assert.match(bloco, /\.gui-deleg-item-id \{/u)

  // `--ink-3` sobre papel dá ~3:1 — reprovado para texto de 10px, que é
  // justamente o tamanho de tudo aqui. A tinta pequena do painel é `--ink-2`
  // (~6,3:1). Não é gosto: é o piso de contraste.
  assert.doesNotMatch(bloco, /var\(--ink-3\)/u)
  assert.match(bloco, /var\(--ink-2\)/u)

  // Diferença dita por FORMA antes de cor (régua da casa): a escolha ligada
  // ganha um traço interno, não só um fundo tingido.
  const ativo = bloco.match(/\.gui-deleg-item\[aria-pressed='true'\] \{[\s\S]*?\n\}/u)?.[0] ?? ''
  assert.ok(ativo, 'a escolha ligada não tem casa própria no CSS')
  assert.match(ativo, /box-shadow: inset/u)

  // Alvo clicável de gente: 22px reprovava no mínimo de 24px.
  const alvo = bloco.match(/\.gui-deleg-item \{[\s\S]*?\n\}/u)?.[0] ?? ''
  const altura = Number(alvo.match(/min-height: (\d+)px/u)?.[1] ?? 0)
  assert.ok(altura >= 28, `a ficha do modelo ficou pequena demais para o dedo (${altura}px)`)

  // Papel, sempre — e nada de movimento novo nesta rodada.
  assert.doesNotMatch(bloco, /var\(--panel\)/u)
  assert.doesNotMatch(bloco, /animation:/u)
})

// ————— 3C. O ⚡ NO PAINEL (design R12 §B4) —————
//
// Queixa 2 do dono (19/08): "o fast não tá aparecendo quando eu tô escolhendo o
// padrão dos ajudantes… pra eu chamar sempre ajudantes no fast". O pino ganha um
// terceiro campo — e ele é o único que CUSTA mais, então nunca fica calado.

test('R12 — o resumo da abinha carrega o ⚡ carimbado, com ou sem modelo', () => {
  const groups = guiDelegationModelGroups(CATALOGS, composerNamer())
  // Sem modelo e sem effort a herança continua sendo a verdade — mas ela não
  // pode engolir a escolha que gasta mais limite.
  assert.equal(guiDelegationSummary({ fast: true }), 'herdado da conversa · ⚡ fast')
  assert.equal(guiDelegationSummary({ model: 'opus[1m]', fast: true }, groups), 'opus · ⚡ fast')
  assert.equal(
    guiDelegationSummary({ model: 'opus[1m]', effort: 'max', fast: true }, groups),
    'opus · max · ⚡ fast'
  )
  assert.equal(
    guiDelegationSummary({ effort: 'low', fast: true }, groups),
    'modelo da conversa · low · ⚡ fast'
  )
  // Desligado é o fundo do mundo: só o que custa aparece.
  assert.equal(guiDelegationSummary({ fast: false }), 'herdado da conversa')
  assert.equal(guiDelegationSummary({ model: 'opus[1m]' }, groups), 'opus')
})

// ————— 3D. O ⚡ DO TAMANHO CERTO (design R13 §B) —————
//
// O dono reprovou a R12 com print: "parece um remendo... você criou um scroll
// vertical pro padrão dos ajudantes; o Fast podia aparecer em algum lugar ali,
// do lado do [herdar] da conversa. E tá aparecendo Fast pra modelo que não tem
// — o Fable 5 não tem Fast, o Haiku não tem". O campo próprio morre, o chip
// muda de casa e a visibilidade passa a vir do CATÁLOGO.

test('R13 — o catálogo do claude carrega o fast que o handshake publica', () => {
  // Captura real do handshake (`.tmp/probe-fast/claude-caps.jsonl`, 19/08): a
  // marca vem POR MODELO, e não vem para todo mundo.
  const models = claudeModelsFromHandshake([
    { value: 'default', displayName: 'Padrão', supportsFastMode: true },
    {
      value: 'opus[1m]',
      displayName: 'opus',
      description: 'equilíbrio (1M ctx)',
      supportsFastMode: true
    },
    { value: 'fable', displayName: 'fable', description: 'o mais capaz' },
    { value: 'haiku', displayName: 'haiku', supportsEffort: false },
    { displayName: 'sem id' }
  ])
  assert.deepEqual(
    models.map((m) => [m.id, m.supportsFastMode]),
    [
      ['default', true],
      ['opus[1m]', true],
      ['fable', false],
      ['haiku', false]
    ],
    'só a AFIRMAÇÃO do CLI liga o modo caro — campo ausente é não'
  )
  // O resto do parse continua de pé: rótulo com descrição, e a lista VAZIA de
  // quem declara não aceitar effort.
  assert.equal(models[1].label, 'opus — equilíbrio (1M ctx)')
  assert.equal(models[0].label, 'Padrão')
  assert.deepEqual(models[3].efforts, [])
})

test('R13 — o catálogo do codex deriva o fast do service tier `priority`', () => {
  // Sonda de 19/08 no binário: `codex debug models` publica `service_tiers` por
  // modelo, e o gpt-5.6-sol traz `[{id:'priority',name:'Fast'}]`.
  const models = codexModelsFromDebug([
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      visibility: 'list',
      default_reasoning_level: 'low',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
      service_tiers: [{ id: 'flex' }, { id: 'priority', name: 'Fast' }]
    },
    {
      slug: 'gpt-5.6-mini',
      display_name: 'Mini',
      visibility: 'list',
      service_tiers: [{ id: 'flex' }]
    },
    { slug: 'gpt-5-antigo', display_name: 'Antigo', visibility: 'list' },
    { slug: 'escondido', visibility: 'hidden', service_tiers: [{ id: 'priority' }] }
  ])
  assert.deepEqual(
    models.map((m) => [m.id, m.supportsFastMode]),
    [
      ['gpt-5.6-sol', true],
      ['gpt-5.6-mini', false],
      ['gpt-5-antigo', false]
    ],
    'sem o tier `priority` não existe fast — e modelo escondido nem entra na lista'
  )
  assert.deepEqual(models[0].efforts, ['low', 'high'])
  assert.equal(models[0].defaultEffort, 'low')
})

test('R13 — os fallbacks NÃO ligam o modo caro', () => {
  for (const model of [...CLAUDE_FALLBACK_MODELS, ...CODEX_FALLBACK_MODELS]) {
    assert.equal(
      model.supportsFastMode,
      undefined,
      `${model.id}: fallback é lista curada à mão, e chute não liga modo que gasta mais`
    )
  }
  // E o silêncio do fallback vira `false` na ficha — nunca uma oferta.
  const [claude] = guiDelegationModelGroups([
    { cli: 'claude', models: CLAUDE_FALLBACK_MODELS, efforts: ['max'] }
  ])
  assert.ok(claude.options.every((option) => option.supportsFastMode === false))
})

test('R13 — a ficha do modelo carrega a marca de fast do catálogo', () => {
  const groups = guiDelegationModelGroups(CATALOGS, composerNamer())
  const option = (id) => guiDelegationModelOption(groups, id)
  assert.equal(option('opus[1m]').supportsFastMode, true)
  assert.equal(option('gpt-5.6-sol').supportsFastMode, true)
  assert.equal(option('fable').supportsFastMode, false)
  assert.equal(option('haiku').supportsFastMode, false)
  // Catálogo que não fala do assunto responde `false`: o painel decide com uma
  // resposta, nunca com um buraco.
  const [mudo] = guiDelegationModelGroups([
    { cli: 'claude', models: [{ id: 'opus[1m]', label: 'opus' }], efforts: ['max'] }
  ])
  assert.equal(mudo.options[0].supportsFastMode, false)
})

test('R13 — o ⚡ só aparece onde ele pode valer (e o pino ligado, sempre)', () => {
  const visible = panelFastChipVisible()
  assert.equal(visible({}, { supportsFastMode: true }), true, 'modelo com o modo oferece o modo')
  assert.equal(
    visible({}, { supportsFastMode: false }),
    false,
    'fable e haiku não têm fast: prometer ali era a queixa 3 do dono'
  )
  assert.equal(visible({}, undefined), false, 'sem pino de modelo não há o que prometer')
  // Honestidade, espelho do `pinnedOutsideCatalog`: pino LIGADO nunca fica
  // invisível — o dono não pode gastar mais limite sem ver por quê.
  assert.equal(visible({ fast: true }, undefined), true)
  assert.equal(visible({ fast: true }, { supportsFastMode: false }), true)
  assert.equal(visible({ fast: false }, undefined), false)
})

test('R13 — trocar de modelo arrasta o ⚡ junto, como o effort', () => {
  const choose = panelChooseModel()
  const groups = guiDelegationModelGroups(CATALOGS, composerNamer())
  const patch = (defaults, model, catalog = groups) => {
    const patches = choose(defaults, catalog, model)
    assert.equal(patches.length, 1, 'a escolha do modelo grava UM patch')
    return patches[0]
  }

  // Modelo COM fast: o pino atravessa (campo ausente CONSERVA, regra do main).
  const paraOpus = patch({ model: 'fable', fast: true }, 'opus[1m]')
  assert.equal(paraOpus.model, 'opus[1m]')
  assert.equal(paraOpus.fast, undefined)
  // Modelo SEM fast: o pino cai no MESMO patch, como o effort não suportado.
  const paraHaiku = patch({ model: 'opus[1m]', effort: 'max', fast: true }, 'haiku')
  assert.equal(paraHaiku.model, 'haiku')
  assert.equal(paraHaiku.effort, null)
  assert.equal(paraHaiku.fast, null, 'fast valendo para modelo sem fast é promessa falsa')
  // Cross-CLI com fast dos dois lados: nada cai.
  const paraSol = patch({ model: 'opus[1m]', effort: 'high', fast: true }, 'gpt-5.6-sol')
  assert.equal(paraSol.effort, 'high')
  assert.equal(paraSol.fast, undefined)
  // Limpar o modelo limpa os três — sem modelo não existe pino a defender.
  const limpo = patch({ model: 'opus[1m]', effort: 'max', fast: true }, null)
  assert.deepEqual(limpo, { model: null, effort: null, fast: null })
  // CATÁLOGO VAZIO é ausência de notícia, não notícia de ausência: o pino fica.
  const semCatalogo = patch({ model: 'opus[1m]', fast: true }, 'modelo-x', [])
  assert.equal(semCatalogo.model, 'modelo-x')
  assert.equal(semCatalogo.fast, undefined)
  // Re-clicar o modelo já carimbado não grava nada (nem derruba o fast).
  assert.deepEqual(choose({ model: 'opus[1m]', fast: true }, groups, 'opus[1m]'), [])
})

test('R13 — o ⚡ mora na fileira do modelo, e o campo da R12 morreu', () => {
  const panel = source('src/renderer/src/components/GuiDelegationDefaults.tsx')
  const css = source('src/renderer/src/global.css')

  // O campo próprio da R12 (rótulo + duas fichas + nota) era o que estourava o
  // teto do painel (`max-height: min(320px, 46dvh)`) e criava o scroll.
  assert.doesNotMatch(panel, />\s*desligado\s*</u, 'a ficha "desligado" era metade dele')
  assert.doesNotMatch(panel, /\$\{panelId\}-fast/u, 'o rótulo do campo próprio saiu junto')

  // O lugar que o dono apontou: MESMA fileira de "herdar da conversa", antes da
  // lista de modelos. As âncoras são o TEXTO DA FICHA (`>rótulo<`) porque
  // "herdar da conversa" também aparece em comentário — e comentário não é tela.
  const herdar = panel.indexOf('>herdar da conversa<')
  const chip = panel.indexOf('>⚡ fast<')
  const lista = panel.indexOf('{groups.map((group) =>')
  assert.ok(herdar > 0 && chip > herdar, 'o ⚡ vem depois de "herdar da conversa"')
  assert.ok(chip < lista, 'e antes da lista de modelos: é a primeira fileira do campo')
  assert.doesNotMatch(
    panel.slice(herdar, chip),
    /gui-deleg-chips/u,
    'fileira nova entre os dois seria outra linha, e o scroll voltaria'
  )

  // Um clique alterna: ligado apaga, apagado liga.
  assert.match(panel, /apply\(\{ fast: defaults\.fast === true \? null : true \}\)/u)
  assert.match(panel, /className="gui-deleg-item-name">⚡ fast</u)
  // Escolha ligada é ESTADO (o leitor de tela precisa ouvi-la), e o ⚡ é desenho.
  assert.match(panel, /aria-pressed=\{defaults\.fast === true\}/u)
  assert.match(panel, /aria-label="Modo fast[^"]*"/u)
  // O preço mora na dica do app, não num alarme permanente na tela.
  assert.match(panel, /data-tip="[^"]*gasta mais limite[^"]*"/u)
  // "limpar" apaga o pino INTEIRO — e o botão morto conhece as três escolhas.
  assert.match(panel, /apply\(\{ model: null, effort: null, fast: null \}\)/u)
  assert.match(panel, /!defaults\.model && !defaults\.effort && !defaults\.fast/u)

  // ZERO CSS NOVO: o chip nasce das classes que a abinha já tem.
  assert.doesNotMatch(css, /\.gui-deleg-fast/u)
  assert.doesNotMatch(panel, /className="gui-deleg-fast/u)
})

// ————— 4. A PERSONA —————

test('a ordem permanente avisa o agente que o dono pode ter carimbado o padrão', () => {
  const sections = GUI_MISSION_ROLES.map((role) => {
    const contract = guiMissionSystemPrompt(role)
    const at = contract.indexOf('DELEGATION — STANDING ORDER FROM THE OWNER:')
    assert.ok(at >= 0, `${role}: sem a ordem permanente`)
    return contract.slice(at)
  })
  for (const section of sections) assert.equal(section, sections[0], 'fonte única')
  const order = sections[0]
  assert.match(order, /\bPIN(?:NED|S)?\b|\bpinned\b/u, 'o pino do dono nem é citado')
  assert.match(order, /side panel/iu)
  assert.match(order, /model/u)
  assert.match(order, /effort/u)
  // O teto continua sendo contra CONSTITUIÇÃO — a régua nova cabe, discurso
  // não. Subiu 1400→1800 e 2600→3000 junto com o teto da suíte de contratos
  // (rodada padrão-é-lei, 18/08: a seção ganhou a regra do pino do dono e
  // mede 1752; os DOIS tetos andam juntos, sempre). E 1800→2000 / 3000→3200 na
  // noite do MESMO dia (5º teste ao vivo), pela linha da ENTREGA EM ARQUIVO +
  // o correio que chega sozinho no próximo resultado de tool. E 2000→2500 /
  // 3200→3700 na mesma noite (rodada 6, o CICLO REDONDO), pelas duas linhas de
  // parar/retomar/descartar: a seção media 2448 e o contrato do dev, 3636. E
  // 2500→3000 / 3700→4200 na rodada 7 (validação ao vivo, achado 3: "o arquivo
  // não tem que ficar lá, a não ser que seja uma implementação"), pelas duas
  // linhas do INSUMO: a seção mede 2922 e o contrato do dev, 4110. Na rodada 9
  // (2026-08-19) só o teto do CONTRATO subiu, 4200→5600: a ordem permanente
  // ficou intocada (2922) e quem cresceu foi o DEV, que ganhou a seção do
  // INTEGRADOR — "quando eu clico em subir, o AGENTE sobe" —, medindo 5462. Na
  // R25 (2026-08-20) de novo só o do CONTRATO, 5600→6500: a ordem permanente
  // seguiu intocada e os TRÊS papéis ganharam a DOUTRINA DE CUSTO (a auditoria
  // mediu o orquestrador re-lendo ~192k por chamada), com o dev em 6352. E em
  // 2026-08-23 de novo só o do CONTRATO, 6500→7200: a REGRA DO FRATRICÍDIO
  // (o agente de uma auditoria derrubou o Synkora duas vezes na mesma noite
  // com `Get-Process electron | Stop-Process`) entrou em dev/helper — a ordem
  // permanente seguiu intocada.
  assert.ok(order.length < 3000, `a ordem permanente virou constituição (${order.length})`)
  for (const role of GUI_MISSION_ROLES) {
    assert.ok(guiMissionSystemPrompt(role).length < 7200, `${role}: contrato virou constituição`)
  }
  // O planejador não delega: ele nunca recebe a seção nem o pino.
  assert.doesNotMatch(guiPlanningSystemPrompt(), /STANDING ORDER FROM THE OWNER/u)
})
