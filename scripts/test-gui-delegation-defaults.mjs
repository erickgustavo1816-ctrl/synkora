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
  guiDelegationModelCli,
  guiDelegationModelGroups,
  guiDelegationModelLabelParts,
  guiDelegationModelOption,
  guiDelegationSummary,
  guiFleetModelPatch,
  guiFleetPlan,
  guiFleetSeatPatch,
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
  return ({ id, displayName, resolvedModel }) =>
    guiModelShortName(
      { value: id, displayName, resolvedModel: resolvedModel ?? id },
      prettyModel(id)
    )
}

/** O bloco de CSS da aba, entre o comentário de abertura e a regra seguinte. */
function fleetCssBlock(css) {
  const start = css.indexOf('A ABA "ajudantes ˄"')
  const end = css.indexOf('.gui-composer-surface {')
  assert.ok(start > 0 && end > start, 'o bloco da aba sumiu do CSS de papel')
  return css.slice(start, end)
}

/** Escapa um seletor para virar regex. */
const rx = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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

test('a aba nasce recolhida, abre no clique e fala PT-BR', () => {
  const panel = source('src/renderer/src/components/GuiDelegationDefaults.tsx')
  assert.match(
    panel,
    /const \[open, setOpen\] = useState\(false\)/u,
    'aba aberta de fábrica não é discreta'
  )
  assert.match(panel, /aria-expanded=\{open\}/u)
  assert.match(panel, /<span className="name">ajudantes<\/span>/u, 'a aba se chama "ajudantes"')
  // Abaixada, a aba diz a configuração EM USO (pedido do dono: "não sei qual
  // configuração eu tô usando"): o resumo ao lado do nome, tinta cheia com pino.
  assert.match(panel, /className=\{pinned \? 'sum pinned' : 'sum'\}/u)
  assert.match(panel, /pinned \? summary : 'herdam da conversa'/u)
  assert.doesNotMatch(panel, /className="pin"/u, 'o ponto de pino morreu: o resumo fala por ele')
  assert.match(
    panel,
    /Padrão dos ajudantes: \$\{busy \? 'gravando…' : summary\}/u,
    'o leitor de tela ouve o resumo na aba recolhida'
  )
  assert.match(panel, />\s*limpar\s*</u, 'sem a saída, o pino do dono vira armadilha')
  for (const label of ['conta', 'modelo', 'effort']) {
    assert.match(panel, new RegExp(`label="${label}"`, 'u'), `o select de ${label} sumiu`)
  }
  assert.match(panel, />\s*fast\s*</u, 'o interruptor do fast tem rótulo')
  // Diálogo nativo QUEBRA o foco da janela no Windows (regra do CLAUDE.md).
  assert.doesNotMatch(panel, /window\.(confirm|alert)/u)
  // O renderer nunca fala com o main direto: a costura é o guiApi.
  assert.doesNotMatch(panel, /window\.synkora/u)
  assert.match(panel, /guiApi\.delegationDefaults|delegationDefaults\(/u)
})

test('a aba SOBE: a caixa é ancorada no composer e o corpo desdobra por baixo dela', () => {
  const css = source('src/renderer/src/global.css')
  const fleet = css.match(/\n\.gui-fleet \{[^}]*\}/u)?.[0] ?? ''
  assert.match(fleet, /position: absolute/u)
  assert.match(fleet, /bottom: 0/u, 'ancorada embaixo: quando o corpo cresce é a aba que sobe')
  assert.match(fleet, /grid-template-rows: auto 0fr/u)
  assert.match(fleet, /transition: grid-template-rows/u, 'o desdobrar É a animação')
  // A coluna do grid é a CAIXA: sem o minmax(0, 1fr) a aba com resumo longo
  // vazava para fora do composer no chat estreito (print do dono, 09/09).
  assert.match(fleet, /grid-template-columns: minmax\(0, 1fr\)/u)
  // O chat fecha o próprio contexto de empilhamento: a aba (z 30) e os menus
  // ficam ATRÁS do painel do workspace que cobre o chat (deck em overlay,
  // z 20), como todo o resto — a aba vazava para a frente (print de 09/09).
  assert.match(css, /\n\.gui-pane \{[^}]*isolation: isolate/u)
  // A aba ESTICA na largura do composer ("eu quero que estique"): o resumo tem
  // a largura toda, e a tesoura é só o último recurso para nunca sair da caixa.
  assert.match(css, /\n\.gui-fleet-tab \{[^}]*flex: 1 1 auto/u)
  assert.match(css, /\n\.gui-fleet-tab \.sum-text \{[^}]*text-overflow: ellipsis/u)
  assert.match(css, /\.gui-fleet\[data-open='true'\] \{[^}]*grid-template-rows: auto 1fr/u)
  // o corpo corta enquanto desdobra e libera os menus só depois de assentar
  assert.match(css, /\n\.gui-fleet-body \{[^}]*overflow: hidden/u)
  assert.match(
    css,
    /\.gui-fleet\[data-open='true'\]\[data-settled='true'\] \.gui-fleet-body \{[^}]*overflow: visible/u
  )
  // A aba fechada tem as MESMAS bordas da aberta (7px): a pílula foi reprovada
  // ("quando ele sobe ele não é full redondo").
  const tab = css.match(/\n\.gui-fleet-tab \{[^}]*\}/u)?.[0] ?? ''
  assert.match(tab, /border-radius: 7px/u)
  assert.doesNotMatch(tab, /999px/u)
  assert.match(css, /\.gui-fleet\[data-open='true'\] \.gui-fleet-tab \{[^}]*border-radius: 7px 7px 0 0/u)
  // Os menus dos selects abrem PARA CIMA: o cartão mora no pé do pane e o
  // palco recorta o que passa da janela — para baixo a lista perdia opções.
  const menu = css.match(/\n\.gui-fleet-menu \{[^}]*\}/u)?.[0] ?? ''
  assert.match(menu, /bottom: calc\(100% \+ 4px\)/u)
  assert.doesNotMatch(menu, /\n\s*top: calc/u)
  const panel = source('src/renderer/src/components/GuiDelegationDefaults.tsx')
  assert.match(panel, /event\.propertyName === 'grid-template-rows'/u, 'assenta no transitionend certo')
  assert.match(
    panel,
    /SETTLE_FALLBACK_MS/u,
    'com reduced-motion não há transição: sem o teto o corpo cortaria os menus para sempre'
  )
  // O "limpar" mora na linha da aba, nunca no cartão (ordem do dono: sem
  // linha fantasma quando os campos quebram).
  const head = panel.indexOf('className="gui-fleet-head"')
  const clear = panel.indexOf('className="gui-fleet-clear"')
  const card = panel.indexOf('className="gui-fleet-card"')
  assert.ok(head > 0 && clear > head && clear < card, 'limpar fica na cabeça, antes do cartão')
})

test('os selects nascem um de cada vez: conta › modelo › effort › fast', () => {
  const groups = guiDelegationModelGroups(CATALOGS)
  const seats = [
    { id: 's-claude', name: 'Claude – Pessoal', cli: 'claude' },
    { id: 's-codex', name: 'Codex – Hotmail', cli: 'codex' }
  ]
  const plan = (defaults, reachedModel = false, conversationCli = 'claude') =>
    guiFleetPlan({ defaults, conversationCli, seats, groups, reachedModel })
  // Nada carimbado, nada respondido: só a conta.
  const zero = plan({})
  assert.equal(zero.showModel, false)
  assert.equal(zero.showEffort, false)
  assert.equal(zero.showFast, false)
  assert.equal(zero.cli, 'claude', 'sem conta carimbada, o catálogo é o da conversa')
  // Respondeu "a da conversa": o modelo nasce, com "o da conversa" como opção.
  const answered = plan({}, true)
  assert.equal(answered.showModel, true)
  assert.equal(answered.modelInheritAllowed, true)
  assert.deepEqual(
    answered.modelOptions.map((option) => option.id),
    ['fable', 'opus[1m]', 'haiku']
  )
  // Conta de OUTRO CLI: os modelos são os DELA, e "o da conversa" não existe.
  const codex = plan({ seat: 's-codex' })
  assert.equal(codex.cli, 'codex')
  assert.equal(codex.showModel, true)
  assert.equal(codex.modelInheritAllowed, false)
  assert.deepEqual(
    codex.modelOptions.map((option) => option.id),
    ['gpt-5.6-sol']
  )
  // Modelo carimbado: o effort nasce com os níveis DELE; o fast só se ele aceita.
  const opus = plan({ seat: 's-claude', model: 'opus[1m]' })
  assert.equal(opus.showEffort, true)
  assert.deepEqual(opus.effortOptions, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(opus.showFast, true)
  assert.equal(plan({ model: 'fable' }).showFast, false, 'fable não tem fast (queixa 3 do dono)')
  const haiku = plan({ model: 'haiku' })
  assert.equal(haiku.showEffort, true)
  assert.deepEqual(haiku.effortOptions, [], 'haiku não aceita effort — e a aba diz isso')
  // Pino LIGADO nunca fica invisível.
  assert.equal(plan({ model: 'fable', fast: true }).showFast, true)
  assert.equal(plan({ fast: true }).showFast, true)
  // Conta que o app não conhece mais: dita pelo id, ainda valendo.
  const ghost = plan({ seat: 's-sumida' })
  assert.equal(ghost.seatOutsideList, true)
  assert.equal(ghost.cli, 'claude')
})

test('o chat monta a aba, e só quando ele delega', () => {
  const pane = source('src/renderer/src/components/GuiPane.tsx')
  assert.match(pane, /import GuiDelegationDefaults from '\.\/GuiDelegationDefaults'/u)
  assert.match(pane, /guiPaneDelegates\(mcp\)/u)
  assert.match(pane, /<GuiDelegationDefaults/u)
  const mount = pane.match(/\{[^\n]*delegat[^\n]*&&[\s\S]{0,400}?<GuiDelegationDefaults[\s\S]*?\/>/u)
  assert.ok(mount, 'a montagem precisa ser condicional ao chat que delega')
  assert.match(mount[0], /paneId=\{paneId\}/u)
  assert.match(mount[0], /cli=\{cli\}/u, 'o CLI da conversa manda no catálogo enquanto a conta é "a da conversa"')
})

test('a aba tem casa no CSS de papel do chat', () => {
  const css = source('src/renderer/src/global.css')
  for (const rule of [
    '.gui-fleet-host',
    '.gui-fleet-tab',
    '.gui-fleet-card',
    '.gui-fleet-select',
    '.gui-fleet-switch'
  ]) {
    assert.match(css, new RegExp(`\\n${rx(rule)} \\{`, 'u'), `${rule} sumiu do CSS`)
  }
  // Papel, nunca `--panel`: a superfície escura é exclusiva do TerminalPane.
  assert.doesNotMatch(fleetCssBlock(css), /var\(--panel\)/u)
  assert.doesNotMatch(css, /\.gui-deleg-/u, 'a abinha antiga morreu inteira')
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
  assert.equal(option('opus[1m]').name, 'Opus')
  assert.equal(option('opus[1m]').id, 'opus[1m]')
  assert.equal(option('opus[1m]').detail, 'equilíbrio (1M ctx)')
  assert.equal(option('gpt-5.6-sol').name, 'GPT-5.6 Sol')
  assert.equal(option('gpt-5.6-sol').detail, null)
  assert.equal(option('fable').name, 'Fable')
  // O rótulo CRU do catálogo continua inteiro na ficha (é ele que vira dica).
  assert.equal(option('fable').label, 'fable — o mais capaz')

  // Catálogo que só repete o id: o título é o nome BONITO do id, jamais o id.
  const [cru] = guiDelegationModelGroups(
    [{ cli: 'claude', models: [{ id: 'opus[1m]', label: 'opus[1m]' }], efforts: ['max'] }],
    namer
  )
  assert.equal(cru.options[0].name, 'Opus 1M')
  assert.notEqual(cru.options[0].name, 'opus[1m]')

  // Sem embelezador injetado a régua não inventa nada — é o painel que traz a
  // fonte única do composer, e a metade pura só sabe o que o catálogo disse.
  const semNome = guiDelegationModelGroups(CATALOGS)
  assert.equal(guiDelegationModelOption(semNome, 'opus[1m]').name, 'opus')
})

test('R7B2 — a abinha recolhida mostra o nome digno, não o id', () => {
  const groups = guiDelegationModelGroups(CATALOGS, composerNamer())
  assert.equal(guiDelegationSummary({ model: 'opus[1m]' }, groups), 'Opus')
  assert.equal(guiDelegationSummary({ model: 'opus[1m]', effort: 'max' }, groups), 'Opus · max')
  assert.equal(
    guiDelegationSummary({ model: 'gpt-5.6-sol', effort: 'high' }, groups),
    'GPT-5.6 Sol · high'
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
  const select = source('src/renderer/src/components/GuiFleetSelect.tsx')

  // A FONTE ÚNICA: as duas metades da régua do composer, importadas, nunca
  // reescritas aqui.
  assert.match(panel, /import \{ guiModelShortName \} from '\.\.\/guiComposerPresentation'/u)
  assert.match(panel, /import \{ prettyModel \} from '\.\/PaneChrome'/u)
  assert.match(panel, /guiDelegationModelGroups\(catalogs, MODEL_NAMER\)/u)

  // O menu do modelo mostra SÓ O NOME (pedido do dono, 09/09: "não quero ver
  // essa parte da direita"); o id cru e a descrição moram na dica.
  assert.match(panel, /label: option\.name/u, 'o rótulo da opção de modelo tem de ser o NOME')
  assert.doesNotMatch(panel, /detail: option\.id/u, 'o id cru saiu da direita do menu')
  assert.match(panel, /option\.id !== option\.name \? option\.id : null/u, 'o id continua na dica')
  assert.match(select, /<b>\{option\.label\}<\/b>/u)
  assert.match(select, /\{option\.detail && <span>\{option\.detail\}<\/span>\}/u)
  // E o nome carrega a VERSÃO quando o catálogo publica o id canônico — a mesma
  // régua do composer ("Opus 5"), nunca o alias cru ("opus[1m]").
  const versioned = guiDelegationModelGroups(
    [
      {
        cli: 'claude',
        models: [
          { id: 'opus[1m]', label: 'Opus — equilíbrio', resolvedModel: 'claude-opus-5' },
          { id: 'sonnet', label: 'Sonnet', resolvedModel: 'claude-sonnet-5' },
          { id: 'fable', label: 'Fable 5.1', resolvedModel: 'claude-fable-5-1' }
        ],
        efforts: ['max']
      }
    ],
    composerNamer()
  )
  assert.deepEqual(
    versioned[0].options.map((option) => option.name),
    ['Opus 5', 'Sonnet 5', 'Fable 5.1']
  )
  assert.equal(versioned[0].options[0].resolvedModel, 'claude-opus-5')
  assert.match(panel, /padrão da conta · \$\{short\}/u, 'o default do claude fala como o composer')
  // Escolha ligada é ESTADO do item (aria-expanded no select, active no item).
  assert.match(select, /aria-expanded=\{open\}/u)
  assert.match(select, /option\.id === selectedId \? ' active' : ''/u)
  // A dica é a do app (`data-tip`, via portal); o `title=` nativo é feio, lento
  // e some no Windows.
  assert.doesNotMatch(panel, /\stitle=\{/u)
  assert.doesNotMatch(select, /\stitle=\{/u)
  assert.match(panel, /data-tip=/u)

  // ESPERANDO ≠ VAZIO: enquanto a conta não responde o menu diz que está
  // consultando; só depois disso o silêncio vira ausência.
  assert.match(panel, /consultando/u)
  assert.match(panel, /nenhum CLI respondeu/u)
  // O pino que o catálogo não conhece continua VISÍVEL — um pino invisível é o
  // estado mais enganoso possível da aba.
  assert.match(panel, /fora do catálogo/u)
  // A aba recolhida lê o resumo JÁ com o catálogo e as contas em mãos — e vai
  // buscar o catálogo quando há pino, mesmo fechada.
  assert.match(panel, /guiDelegationSummary\(defaults, groups, fleetSeats\)/u)
  assert.match(panel, /open \|\| Boolean\(defaults\.model\)/u)

  // EFFORT: a aba fala a mesma língua do seletor de esforço do composer.
  const pane = source('src/renderer/src/components/GuiPane.tsx')
  assert.match(pane, /padrão do modelo/u)
  assert.match(panel, /padrão do modelo/u)
})

test('R7B2 — a aba passa no AA do papel e diz a escolha por FORMA', () => {
  const css = source('src/renderer/src/global.css')
  const bloco = fleetCssBlock(css)
  assert.ok(bloco.length > 1000, 'o bloco da aba sumiu do CSS de papel')

  // Tinta pequena de TEXTO em --ink-2 (~6,3:1 sobre papel); --ink-3 (~3:1,
  // reprovado a 10px) só em traço — seta, trilho e botão do interruptor.
  for (const selector of [
    '.gui-fleet-label',
    '.gui-fleet-clear',
    '.gui-fleet-item span',
    '.gui-fleet-select .val.ghost'
  ]) {
    const rule = bloco.match(new RegExp(`\\n${rx(selector)} \\{[^}]*\\}`, 'u'))?.[0] ?? ''
    assert.match(rule, /var\(--ink-2\)/u, `${selector} precisa de --ink-2`)
    assert.doesNotMatch(rule, /var\(--ink-3\)/u, `${selector} em --ink-3 reprova o AA`)
  }

  // Diferença dita por FORMA antes de cor: o item escolhido ganha borda, e o
  // interruptor ligado é o botão que ANDA — a cor vem por cima.
  assert.match(bloco, /\.gui-fleet-item\.active \{[^}]*border-color: var\(--accent\)/u)
  assert.match(bloco, /\.gui-fleet-switch\[aria-checked='true'\] \.knob \{[^}]*transform: translateX/u)

  // Alvo clicável de gente.
  const select = Number(bloco.match(/\n\.gui-fleet-select \{[^}]*height: (\d+)px/u)?.[1] ?? 0)
  assert.ok(select >= 28, `o select ficou pequeno demais para o dedo (${select}px)`)
  const item = Number(bloco.match(/\n\.gui-fleet-item \{[^}]*min-height: (\d+)px/u)?.[1] ?? 0)
  assert.ok(item >= 26, `a opção ficou pequena demais para o dedo (${item}px)`)

  // Papel, sempre. O movimento é o desdobrar (sinal), e quem pede menos
  // movimento não recebe nenhum.
  assert.doesNotMatch(bloco, /var\(--panel\)/u)
  assert.match(bloco, /@keyframes fleet-in/u)
  assert.match(bloco, /prefers-reduced-motion: reduce/u)
  // O bug que o dono apontou no mockup: `both` deixa um stacking context para
  // sempre, e o campo seguinte pinta por cima do menu do anterior.
  assert.match(bloco, /animation: fleet-in [^;]*backwards/u)
  assert.match(bloco, /\.gui-fleet-field:has\(\[aria-expanded='true'\]\) \{[^}]*z-index: 2/u)
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
  assert.equal(guiDelegationSummary({ model: 'opus[1m]', fast: true }, groups), 'Opus · ⚡ fast')
  assert.equal(
    guiDelegationSummary({ model: 'opus[1m]', effort: 'max', fast: true }, groups),
    'Opus · max · ⚡ fast'
  )
  assert.equal(
    guiDelegationSummary({ effort: 'low', fast: true }, groups),
    'modelo da conversa · low · ⚡ fast'
  )
  // Desligado é o fundo do mundo: só o que custa aparece.
  assert.equal(guiDelegationSummary({ fast: false }), 'herdado da conversa')
  assert.equal(guiDelegationSummary({ model: 'opus[1m]' }, groups), 'Opus')
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
      resolvedModel: 'claude-opus-5',
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
  // O id canônico atravessa quando o handshake o publica — é a versão do nome.
  assert.equal(models[1].resolvedModel, 'claude-opus-5')
  assert.equal(models[2].resolvedModel, undefined)
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
  const groups = guiDelegationModelGroups(CATALOGS)
  const show = (defaults) =>
    guiFleetPlan({ defaults, conversationCli: 'claude', seats: [], groups, reachedModel: false })
      .showFast
  assert.equal(show({ model: 'opus[1m]' }), true, 'modelo com o modo oferece o modo')
  assert.equal(show({ model: 'fable' }), false, 'fable não tem fast: prometer ali era a queixa 3')
  assert.equal(show({ model: 'haiku' }), false)
  assert.equal(show({}), false, 'sem pino de modelo não há o que prometer')
  // Honestidade, espelho do `pinnedOutsideCatalog`: pino LIGADO nunca fica
  // invisível — o dono não pode gastar mais limite sem ver por quê.
  assert.equal(show({ fast: true }), true)
  assert.equal(show({ model: 'fable', fast: true }), true)
  assert.equal(show({ fast: false }), false)
})

test('R13 — trocar de modelo arrasta o ⚡ junto, como o effort', () => {
  const groups = guiDelegationModelGroups(CATALOGS, composerNamer())
  const claude = groups.find((group) => group.cli === 'claude').options
  const codex = groups.find((group) => group.cli === 'codex').options

  // Modelo COM fast: o pino atravessa (campo ausente CONSERVA, regra do main).
  const paraOpus = guiFleetModelPatch({ model: 'fable', fast: true }, claude, true, 'opus[1m]')
  assert.equal(paraOpus.model, 'opus[1m]')
  assert.equal(paraOpus.fast, undefined)
  // Modelo SEM fast: o pino cai no MESMO patch, como o effort não suportado.
  const paraHaiku = guiFleetModelPatch(
    { model: 'opus[1m]', effort: 'max', fast: true },
    claude,
    true,
    'haiku'
  )
  assert.equal(paraHaiku.model, 'haiku')
  assert.equal(paraHaiku.effort, null)
  assert.equal(paraHaiku.fast, null, 'fast valendo para modelo sem fast é promessa falsa')
  // Cross-CLI com fast dos dois lados: nada cai.
  const paraSol = guiFleetModelPatch(
    { model: 'opus[1m]', effort: 'high', fast: true },
    codex,
    true,
    'gpt-5.6-sol'
  )
  assert.equal(paraSol.effort, 'high')
  assert.equal(paraSol.fast, undefined)
  // Limpar o modelo limpa os três — sem modelo não existe pino a defender.
  assert.deepEqual(
    guiFleetModelPatch({ model: 'opus[1m]', effort: 'max', fast: true }, claude, true, null),
    { model: null, effort: null, fast: null }
  )
  // CATÁLOGO VAZIO é ausência de notícia, não notícia de ausência: o pino fica.
  const semCatalogo = guiFleetModelPatch({ model: 'opus[1m]', fast: true }, [], false, 'modelo-x')
  assert.equal(semCatalogo.model, 'modelo-x')
  assert.equal(semCatalogo.fast, undefined)
  // Re-clicar o modelo já carimbado não grava nada (nem derruba o fast).
  assert.equal(guiFleetModelPatch({ model: 'opus[1m]', fast: true }, claude, true, 'opus[1m]'), null)
})

test('a CONTA é a primeira etapa: trocar de conta arrasta o modelo do outro CLI', () => {
  const seats = [
    { id: 's-claude', name: 'Claude – Pessoal', cli: 'claude' },
    { id: 's-codex', name: 'Codex – Hotmail', cli: 'codex' }
  ]
  assert.deepEqual(guiFleetSeatPatch({}, seats, 'claude', 's-claude'), { seat: 's-claude' })
  assert.equal(guiFleetSeatPatch({ seat: 's-claude' }, seats, 'claude', 's-claude'), null, 'repetir não grava')
  assert.equal(guiFleetSeatPatch({}, seats, 'claude', null), null, '"a da conversa" sem pino não grava')
  // Conta de outro CLI: o modelo carimbado (e o effort e o fast, que são dele) caem.
  assert.deepEqual(
    guiFleetSeatPatch({ seat: 's-claude', model: 'opus[1m]', effort: 'max', fast: true }, seats, 'claude', 's-codex'),
    { seat: 's-codex', model: null, effort: null, fast: null }
  )
  // Mesmo CLI: o modelo fica.
  assert.deepEqual(guiFleetSeatPatch({ seat: 's-claude', model: 'opus[1m]' }, seats, 'claude', null), {
    seat: null
  })
  // Voltar para "a da conversa" (claude) derruba um modelo codex.
  assert.deepEqual(guiFleetSeatPatch({ seat: 's-codex', model: 'gpt-5.6-sol' }, seats, 'claude', null), {
    seat: null,
    model: null,
    effort: null,
    fast: null
  })
  // A régua do CLI pelo nome é a MESMA do motor (resolveHelperCli).
  assert.equal(guiDelegationModelCli('gpt-5.6-sol'), 'codex')
  assert.equal(guiDelegationModelCli('opus[1m]'), 'claude')
})

test('a aba recolhida diz a conta pelo nome (e pelo id quando o app não a conhece mais)', () => {
  const groups = guiDelegationModelGroups(CATALOGS, composerNamer())
  const seats = [{ id: 's-claude', name: 'Claude – Pessoal', cli: 'claude' }]
  assert.equal(guiDelegationSummary({ seat: 's-claude' }, groups, seats), 'Claude – Pessoal')
  assert.equal(
    guiDelegationSummary({ seat: 's-claude', model: 'opus[1m]', effort: 'max', fast: true }, groups, seats),
    'Claude – Pessoal · Opus · max · ⚡ fast'
  )
  assert.equal(guiDelegationSummary({ seat: 's-sumida' }, groups, seats), 's-sumida')
  assert.equal(guiDelegationSummary({}, groups, seats), 'herdado da conversa')
})

test('R13 — o ⚡ é um interruptor no fim da sequência, e limpar apaga o pino inteiro', () => {
  const panel = source('src/renderer/src/components/GuiDelegationDefaults.tsx')
  const css = source('src/renderer/src/global.css')

  // Um interruptor de verdade: papel de switch, estado audível, um clique alterna.
  assert.match(panel, /role="switch"/u)
  assert.match(panel, /aria-checked=\{defaults\.fast === true\}/u)
  assert.match(panel, /apply\(\{ fast: defaults\.fast === true \? null : true \}\)/u)
  // O preço mora na dica do app, não num alarme permanente na tela.
  assert.match(panel, /data-tip="[^"]*gasta mais limite[^"]*"/u)
  // A ordem das etapas no fonte é a da tela: conta, modelo, effort, fast.
  const seat = panel.indexOf('label="conta"')
  const model = panel.indexOf('label="modelo"')
  const effort = panel.indexOf('label="effort"')
  const fast = panel.indexOf('className="gui-fleet-field switch"')
  assert.ok(seat > 0 && model > seat && effort > model && fast > effort, 'a sequência do dono')
  // "limpar" apaga o pino INTEIRO — e o botão morto conhece as quatro escolhas.
  assert.match(panel, /apply\(\{ seat: null, model: null, effort: null, fast: null \}\)/u)
  assert.match(panel, /disabled=\{busy \|\| !pinned\}/u)
  assert.match(panel, /defaults\.seat \|\| defaults\.model \|\| defaults\.effort \|\| defaults\.fast/u)
  // ZERO classe de fast: o interruptor nasce das classes da aba.
  assert.doesNotMatch(css, /\.gui-deleg-fast|\.gui-fleet-fast/u)
})

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
  // permanente seguiu intocada. E na R31 (2026-08-23) de novo só o do
  // CONTRATO, 7200→8200: a VOZ DO DONO (responder sempre + narrar o passo a
  // passo) entrou nos três papéis — a ordem permanente seguiu intocada; o dev
  // mede 8010. E na R36 (mesma data) de novo só o do CONTRATO, 8200→8700: a
  // ENTREGA VISUAL (visual sem referência não existe na tela do dono) entrou
  // em dev/ajudante — a ordem permanente seguiu intocada; o dev mede 8459. E
  // na R37 (mesma data) de novo só o do CONTRATO, 8700→10300: o MUNDO ("ao
  // invés de ficar remendando, explica para ele como é o synkora, onde ele
  // está e como funciona") abriu os CINCO contratos com a linha ONDE VOCÊ
  // ESTÁ por papel; a ordem permanente seguiu intocada; o dev mede 9751. E no
  // Skills 2.0 (2026-08-29) de novo só o do CONTRATO, 10300→11400: o CARDÁPIO
  // DE SKILLS (ADR-0001: escolher é julgamento do agente) + a LEI do
  // impeccable (ADR-0005) entraram em dev/ajudante — a ordem permanente
  // seguiu intocada; o dev mede 10985. E no BROWSER DA CASA (2026-08-29,
  // mesma data) de novo só o do CONTRATO, 11400→13300: o bloco do browser
  // embutido ("QA visual não pode demorar 40-50 min" — nunca em browser
  // externo nem em playwright próprio) entrou em dev/ajudante; a ordem
  // permanente seguiu intocada (2922) e o dev mede 12848. E na ABA POR
  // IDENTIDADE (2026-09-01) de novo só o do CONTRATO, 13300→14500: a ordem do
  // dono ("cada um na sua aba, na sua porta") reescreveu o bloco do browser —
  // uma aba por identidade e porta reservada por ajudante; a ordem permanente
  // seguiu intocada (2922) e o dev mede 13840. E na R39 (2026-09-02) de novo só
  // o do CONTRATO, 14500→15000: a emenda D8 da VOZ DO DONO (o app PARA o turno
  // e entrega a fala como turno NOVO; a tool em voo foi CORTADA; TODA tool,
  // nativas inclusive, trava até a resposta) entrou nos três papéis — coube
  // dentro do teto velho, mas deixou só 256 chars de folga, e o teto existe
  // justamente para caber UMA régua do dono. A ordem permanente seguiu intocada
  // (2922) e o dev mede 14244. E no HARNESS DO MODELO (2026-09-08, Skills 3.0 —
  // ADRs 0008-0011) de novo só o do CONTRATO, 15000→16500: o cardápio FECHADO de
  // 5 linhas virou o bloco em que o AGENTE monta o harness da missão ("não quero
  // mais algo fixo. Quero que a IA decida qual é a melhor opção pra ela ali
  // naquele momento, e ela vá atrás, ela busque, ela pegue e ela faça") e a LEI
  // do impeccable virou UMA linha de padrão — 2309 chars de bloco comum contra
  // os 886 do cardápio velho. A ordem permanente seguiu intocada (2922), o dev
  // mede 16316 e o ajudante 14321. Os DOIS tetos andam juntos, sempre — e o
  // orquestrador subiu 16500→17000 nos dois no review da fatia (184 chars de
  // folga não são uma régua do dono).
  assert.ok(order.length < 3000, `a ordem permanente virou constituição (${order.length})`)
  for (const role of GUI_MISSION_ROLES) {
    assert.ok(
      guiMissionSystemPrompt(role).length < 17000,
      `${role}: contrato virou constituição (${guiMissionSystemPrompt(role).length})`
    )
  }
  // 2026-08-30 (ordem do dono: "coloque os ajudantes também para eu
  // selecionar"): o planejador DELEGA — a MESMA seção, palavra por palavra
  // (fonte única, como entre os papéis de missão), e com ela o pino D8.
  const planning = guiPlanningSystemPrompt()
  const plannerAt = planning.indexOf('DELEGATION — STANDING ORDER FROM THE OWNER:')
  assert.ok(plannerAt >= 0, 'o planejador ficou sem a ordem permanente')
  assert.equal(planning.slice(plannerAt), sections[0], 'fonte única também no planejador')
  // O teto DELE também é espelho (a suíte de contratos é a fonte): 10900→13600
  // no HARNESS DO MODELO (2026-09-08) — o cardápio de 886 virou o bloco comum de
  // 2309 e o planejador ganhou o MÉTODO por cima (863, ADR-0011: "é um
  // planejamento simples… é um planejamento mais abstrato"). Mede 13154; o
  // design pedia 12000, número escrito antes da medição e no qual o texto
  // vinculante não caberia. Os DOIS tetos andam juntos, sempre.
  assert.ok(planning.length < 13600, `o planejador virou constituição (${planning.length})`)
})

// O BROWSER DA CASA (2026-08-29 — DESIGN_BROWSER_EMBUTIDO, fatia H4) entrou em
// dev/ajudante e é a razão do teto novo desta suíte. Aqui só a invariante que é
// DESTE arquivo: seção nova nenhuma pode empurrar a ordem permanente do fim do
// contrato — ela é a última palavra desde 18/08, e é assim que o agente a lê
// por último. O conteúdo do bloco é provado na suíte de contratos.
test('o bloco do browser não rouba a última palavra da ordem permanente', () => {
  const BROWSER_HEADER = 'BROWSER — VISUAL QA RUNS IN THE HOUSE BROWSER, NEVER IN ONE YOU OPEN:'
  for (const role of ['dev', 'helper']) {
    const contract = guiMissionSystemPrompt(role)
    const at = contract.indexOf(BROWSER_HEADER)
    assert.ok(at >= 0, `${role}: sem o bloco do browser da casa`)
    assert.ok(
      at < contract.indexOf('DELEGATION — STANDING ORDER FROM THE OWNER:'),
      `${role}: o browser passou na frente da ordem permanente`
    )
    // 2026-09-01 (ABA POR IDENTIDADE): quem DELEGA precisa saber, no mesmo
    // contrato onde delega, que o ajudante nasce com aba E porta próprias — a
    // colisão medida na missão 86a05c06 foi exatamente o delegador dirigindo a
    // aba (e a porta) de quem ele mesmo abriu.
    assert.match(contract, /THE TAB IS YOURS/u, `${role}: a aba voltou a não ter dono`)
    assert.match(
      contract,
      /THEIR OWN RESERVED PORT/u,
      `${role}: a porta reservada do ajudante sumiu do contrato de quem delega`
    )
  }
  // Reviewer e planejador não testam UI — o bloco não entra no contrato deles,
  // e a régua da aba/porta é do bloco: nenhum dos dois a recebe de carona.
  assert.doesNotMatch(guiMissionSystemPrompt('reviewer'), /browser_/u)
  assert.doesNotMatch(guiPlanningSystemPrompt(), /browser_/u)
  assert.doesNotMatch(guiMissionSystemPrompt('reviewer'), /THE TAB IS YOURS/u)
  assert.doesNotMatch(guiPlanningSystemPrompt(), /THE TAB IS YOURS/u)
})
