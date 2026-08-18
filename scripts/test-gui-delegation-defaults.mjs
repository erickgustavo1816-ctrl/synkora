// O PAINEL DE PADRÕES DA DELEGAÇÃO — "abinha do lado" (D8 do design vinculante
// `.synkora/reports/DESIGN_SUBAGENTES_SEM_ABA_2026-08-18.md`).
//
// Ordem do dono (18/08, tarde): "como padrão vai vir eles; caso eu queira
// outros, aí eu falo". Esta suíte prova as três metades do painel:
//   1. a régua PURA (catálogo real dos DOIS CLIs, effort filtrado por modelo,
//      resumo honesto quando nada está carimbado);
//   2. o CONTRATO DE FONTE da superfície (a abinha nasce recolhida, fala PT-BR,
//      está montada no chat e só aparece em chat que DELEGA);
//   3. a linha da persona — o agente precisa saber que o pino do dono existe.
//
// Como rodar (o package.json não foi tocado — a linha para registrar está no
// relatório w3-panel.md):
//   node --experimental-strip-types --test scripts/test-gui-delegation-defaults.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  guiDelegationEffortOptions,
  guiDelegationModelGroups,
  guiDelegationModelOption,
  guiDelegationSummary,
  guiPaneDelegates
} from '../src/renderer/src/guiDelegationDefaults.ts'
import {
  GUI_MISSION_ROLES,
  guiMissionSystemPrompt,
  guiPlanningSystemPrompt
} from '../src/main/guiMissionContracts.ts'

const source = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

/** Catálogos como o `catalog.ts` os devolve: o do claude costuma vir SEM
 *  `efforts` por modelo (fallback curado), o do codex traz nível por modelo. */
const CATALOGS = [
  {
    cli: 'claude',
    models: [
      { id: 'fable', label: 'fable — o mais capaz' },
      { id: 'opus[1m]', label: 'opus — equilíbrio (1M ctx)' },
      { id: 'haiku', label: 'haiku — o mais rápido', efforts: [] }
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max']
  },
  {
    cli: 'codex',
    models: [
      {
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6-Sol',
        efforts: ['minimal', 'low', 'medium', 'high']
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
  // parar/retomar/descartar: a seção mede 2448 e o contrato do dev, 3636.
  assert.ok(order.length < 2500, `a ordem permanente virou constituição (${order.length})`)
  for (const role of GUI_MISSION_ROLES) {
    assert.ok(guiMissionSystemPrompt(role).length < 3700, `${role}: contrato virou constituição`)
  }
  // O planejador não delega: ele nunca recebe a seção nem o pino.
  assert.doesNotMatch(guiPlanningSystemPrompt(), /STANDING ORDER FROM THE OWNER/u)
})
