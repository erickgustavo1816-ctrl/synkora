import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  guiSubagentMetadataForTool,
  isGuiSubagentToolEvent,
  normalizeGuiSubagentSidebar
} from '../src/renderer/src/guiSubagentSidebar.ts'
import {
  closePendingGuiTools,
  settleLaunchedGuiSubagents
} from '../src/renderer/src/guiTerminalTools.ts'
import { guiToolResultTargetIndex } from '../src/renderer/src/guiToolPresentation.ts'

function tool(id, name, summary, extra = {}) {
  return { id: `item-${id}`, kind: 'tool', name, summary, at: Number(id), ...extra }
}

function result(text, status = 'completed', isError = false, extra = {}) {
  return { text, isError, status, lineCount: 1, truncated: false, ...extra }
}

/** ACK de despacho do Agent assíncrono: o card tem resultado e o agente vive. */
function launched(taskId) {
  return result('agente despachado', 'completed', false, {
    agentStatus: 'launched',
    agentTaskId: taskId
  })
}

function agentCard(id, toolUseId, prompt, extra = {}) {
  return {
    ...tool(id, 'Agent', prompt),
    toolUseId,
    subagent: guiSubagentMetadataForTool('Agent', { prompt, subagent_type: 'geral' }),
    ...extra
  }
}

test('ferramenta de filho fica em background sem dividir a resposta principal', () => {
  assert.equal(isGuiSubagentToolEvent({ parentToolUseId: 'parent-a' }), true)
  assert.equal(isGuiSubagentToolEvent({}), false)
  assert.equal(isGuiSubagentToolEvent({ parentToolUseId: '' }), false)
})

test('normaliza subagentes concorrentes intercalados e preserva atividade atual', () => {
  const parentA = {
    ...tool('10', 'Task', 'A tarefa curta'),
    toolUseId: 'parent-a',
    subagent: guiSubagentMetadataForTool('Task', {
      name: 'Luna Front',
      subagent_type: 'frontend',
      model: 'gpt-5.6-luna',
      prompt: 'investigue o fluxo A'
    })
  }
  const parentB = {
    ...tool('20', 'Task', 'B tarefa curta'),
    toolUseId: 'parent-b',
    subagent: guiSubagentMetadataForTool('Task', {
      subagent_type: 'backend',
      prompt: 'investigue o fluxo B'
    }),
    result: result('B terminou')
  }
  const childACompleted = {
    ...tool('30', 'Read', 'arquivo base'),
    toolUseId: 'child-a-1',
    parentToolUseId: 'parent-a',
    result: result('ok')
  }
  const childB = {
    ...tool('40', 'Grep', 'padrão B'),
    toolUseId: 'child-b',
    parentToolUseId: 'parent-b',
    result: result('ok')
  }
  const childAPending = {
    ...tool('50', 'Edit', 'arquivo que está sendo corrigido'),
    toolUseId: 'child-a-2',
    parentToolUseId: 'parent-a'
  }

  const entries = normalizeGuiSubagentSidebar([
    parentA,
    parentB,
    childACompleted,
    childB,
    childAPending
  ])

  assert.deepEqual(entries.map((entry) => entry.toolUseId), ['parent-a'])
  assert.equal(entries[0].name, 'Luna Front')
  assert.equal(entries[0].model, 'gpt-5.6-luna')
  assert.equal(entries[0].task, 'investigue o fluxo A')
  assert.equal(entries[0].activity, 'Edit · arquivo que está sendo corrigido')
  assert.equal(entries[0].status, 'running')
  assert.equal(entries[0].outcome, null)
})

test('mostra subagente aberto antes do primeiro filho e não inventa modelo', () => {
  const parent = {
    ...tool('10', 'Agent', 'descrição do agente'),
    toolUseId: 'agent-1',
    subagent: guiSubagentMetadataForTool('Agent', {
      description: 'tarefa de validação',
      subagent_type: 'qa'
    })
  }
  const [entry] = normalizeGuiSubagentSidebar([parent])
  assert.ok(entry)
  assert.equal(entry.name, 'qa')
  assert.equal(entry.type, 'qa')
  assert.equal(entry.model, 'modelo não informado')
  assert.equal(entry.task, 'tarefa de validação')
  assert.equal(entry.activity, 'aguardando a primeira atividade')
  assert.equal(entry.status, 'running')
})

test('não promove uma ferramenta comum só porque o input tem descrição ou modelo', () => {
  assert.equal(
    guiSubagentMetadataForTool('Read', {
      description: 'descrição de arquivo',
      model: 'modelo usado internamente'
    }),
    undefined
  )
  const entries = normalizeGuiSubagentSidebar([
    {
      ...tool('11', 'Read', 'descrição de arquivo'),
      toolUseId: 'read-11'
    }
  ])
  assert.deepEqual(entries, [])
})

// B1 — o recibo de despacho do Agent assíncrono não é conclusão: era ele que
// esvaziava a lateral com os três agentes ainda trabalhando.
test('B1 — subagente apenas DESPACHADO continua na lateral trabalhando', () => {
  const parents = [
    agentCard('1', 'agent-1', 'investigue o fluxo A', { result: launched('task-1') }),
    agentCard('2', 'agent-2', 'investigue o fluxo B', { result: launched('task-2') }),
    agentCard('3', 'agent-3', 'investigue o fluxo C', { result: launched('task-3') })
  ]
  const child = {
    ...tool('4', 'Grep', 'padrão do agente B'),
    toolUseId: 'child-b',
    parentToolUseId: 'agent-2'
  }

  const entries = normalizeGuiSubagentSidebar([...parents, child])
  assert.deepEqual(entries.map((entry) => entry.toolUseId), ['agent-1', 'agent-2', 'agent-3'])
  for (const entry of entries) {
    assert.equal(entry.status, 'running')
    assert.equal(entry.statusLabel, 'trabalhando')
    assert.equal(entry.outcome, null)
  }
  assert.equal(entries[0].activity, 'aguardando a primeira atividade')
  assert.equal(entries[1].activity, 'Grep · padrão do agente B')
})

// B2 — reescrita do teste que cristalizou a inferência errada: o que tira o
// subagente da lateral é o terminal FACTUAL, nunca o despacho.
test('B2 — terminal factual sai da lateral; despacho fica', () => {
  const settled = normalizeGuiSubagentSidebar([
    {
      ...tool('1', 'Task', 'falha'),
      toolUseId: 'failed',
      subagent: guiSubagentMetadataForTool('Task', { prompt: 'falha' }),
      result: result('erro real', 'failed', true, { agentStatus: 'settled', agentTaskId: 't1' })
    },
    {
      ...tool('2', 'Task', 'negado'),
      toolUseId: 'denied',
      subagent: guiSubagentMetadataForTool('Task', { prompt: 'negado' }),
      result: result('', 'denied', false, { agentStatus: 'settled', agentTaskId: 't2' })
    },
    {
      ...tool('3', 'Task', 'cancelado'),
      toolUseId: 'cancelled',
      subagent: guiSubagentMetadataForTool('Task', { prompt: 'cancelado' }),
      result: result('', 'cancelled', false, { agentStatus: 'settled', agentTaskId: 't3' })
    },
    {
      ...tool('4', 'Task', 'concluído'),
      toolUseId: 'completed',
      subagent: guiSubagentMetadataForTool('Task', { prompt: 'concluído' }),
      result: result('resumo do trabalho', 'completed', false, {
        agentStatus: 'settled',
        agentTaskId: 't4'
      })
    }
  ])
  assert.deepEqual(settled, [], 'settled em qualquer desfecho encerra a ficha')

  // Codex (e ferramenta comum) não carrega ciclo de vida: resultado É terminal.
  const codex = normalizeGuiSubagentSidebar([
    {
      ...tool('5', 'spawn_agent', 'colaboração codex'),
      toolUseId: 'codex-parent',
      subagent: guiSubagentMetadataForTool('spawn_agent', { prompt: 'colaboração codex' }),
      result: result('subagente concluído')
    }
  ])
  assert.deepEqual(codex, [], 'a regra do Codex continua intacta')

  const dispatched = normalizeGuiSubagentSidebar([
    agentCard('6', 'agent-vivo', 'segue trabalhando', { result: launched('task-vivo') })
  ])
  assert.deepEqual(dispatched.map((entry) => entry.toolUseId), ['agent-vivo'])
})

// B3 — o settled real substitui o recibo no MESMO card (o pareamento por id
// precisa aceitar um card que já tem o resultado de despacho).
test('B3 — settled sobrescreve o despacho no mesmo card e encerra a ficha', () => {
  const items = [agentCard('1', 'agent-1', 'auditoria', { result: launched('task-1') })]
  const target = guiToolResultTargetIndex(items, 'agent-1')
  assert.equal(target, 0, 'o card despachado continua elegível ao terminal factual')

  items[target] = {
    ...items[target],
    result: result('encontrei 3 problemas', 'completed', false, {
      agentStatus: 'settled',
      agentTaskId: 'task-1'
    })
  }
  assert.deepEqual(normalizeGuiSubagentSidebar(items), [])
  assert.equal(
    guiToolResultTargetIndex(items, 'agent-1'),
    -1,
    'card já assentado não aceita uma segunda conclusão'
  )
})

// B4 — filho nunca é fechado por conta própria; ele segue a árvore do pai.
test('B4 — terminal da sessão cancela o agente despachado e leva os filhos junto', () => {
  const parent = agentCard('1', 'agent-1', 'trabalho longo', { result: launched('task-1') })
  const child = {
    ...tool('2', 'Read', 'arquivo do agente'),
    toolUseId: 'child-1',
    parentToolUseId: 'agent-1'
  }
  const closed = closePendingGuiTools([parent, child], { type: 'closed', code: 0 })

  assert.equal(closed[0].result.status, 'cancelled', 'agente vivo não vira falha do turno')
  assert.equal(closed[0].result.isError, false)
  assert.equal(closed[0].result.agentStatus, 'settled')
  assert.equal(closed[1].result.status, 'cancelled')
  assert.equal(closed[1].result.agentStatus, undefined, 'filho não é um agente')
  assert.deepEqual(normalizeGuiSubagentSidebar(closed), [])
})

// B5 — respawn: tarefa de fundo morre com o processo.
test('B5 — respawn não ressuscita agente despachado na lateral', () => {
  const parent = agentCard('1', 'agent-1', 'trabalho perdido', { result: launched('task-1') })
  const child = {
    ...tool('2', 'Grep', 'em andamento'),
    toolUseId: 'child-1',
    parentToolUseId: 'agent-1'
  }
  const settledTool = {
    ...tool('3', 'Read', 'histórico'),
    toolUseId: 'read-1',
    result: result('conteúdo')
  }
  const pendingRoot = { ...tool('4', 'Bash', 'npm test'), toolUseId: 'bash-1' }

  const respawned = settleLaunchedGuiSubagents([parent, child, settledTool, pendingRoot])
  assert.equal(respawned[0].result.status, 'cancelled')
  assert.equal(respawned[1].result.status, 'cancelled')
  assert.equal(respawned[2], settledTool, 'resultado autoritativo é preservado')
  assert.equal(respawned[3], pendingRoot, 'a fotografia do resto do transcript não é tocada')
  assert.deepEqual(normalizeGuiSubagentSidebar(respawned), [])
  assert.equal(parent.result.agentStatus, 'launched', 'o estado de entrada continua cru')
})

// B6 — fim de rodada raiz com agente vivo não pode encerrar a ficha (o CLI roda
// um turno raiz novo a cada conclusão de agente).
test('B6 — result raiz de ciclo autônomo não encerra o agente ainda vivo', () => {
  const parent = agentCard('1', 'agent-1', 'trabalho em curso', { result: launched('task-1') })
  const child = {
    ...tool('2', 'Grep', 'varredura'),
    toolUseId: 'child-1',
    parentToolUseId: 'agent-1'
  }
  const items = [parent, child]

  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
  assert.match(store, /const settlesTurn = !evt\.continues/u)
  assert.match(store, /if \(settlesTurn\) next = \{ \.\.\.next, items: closePendingGuiTools/u)

  // Com `continues`, o redutor nem chama o fechamento — a lateral segue cheia.
  assert.deepEqual(
    normalizeGuiSubagentSidebar(items).map((entry) => entry.toolUseId),
    ['agent-1']
  )
  assert.equal(items[1].result, undefined)
})

test('superfície da seção tem nome acessível e campos pedidos', () => {
  const source = readFileSync(
    new URL('../src/renderer/src/components/GuiSubagentSidebar.tsx', import.meta.url),
    'utf8'
  )
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  assert.match(source, /aria-label="Subagentes desta conversa"/u)
  for (const contract of [
    'gui-subagent-row-meta',
    'gui-subagent-row-task',
    'gui-subagent-row-activity',
    'gui-subagent-row-status',
    'gui-subagent-row-outcome'
  ]) {
    assert.match(source, new RegExp(contract, 'u'))
  }
  assert.doesNotMatch(source, /id do subagente/u)
  assert.match(source, /role="status"/u)
  assert.match(source, /useMemo\(\(\) => normalizeGuiSubagentSidebar\(items\), \[items\]\)/u)
  assert.doesNotMatch(pane, /GuiSubagentContainer/u)
  assert.match(pane, /if \(item\.kind === 'subagent'\)[\s\S]*?continue/u)
  assert.match(pane, /item\.kind === 'tool' && item\.subagent/u)
})

// ————— AJUDANTES POR MCP: a TERCEIRA fonte, no mesmo idioma (design D3) —————
//
// Contrato do card SINTETIZADO que a onda 2 emite (um por ajudante, nunca um
// card só para cinco):
//   name             `helper:<helperId>`
//   toolUseId        id estável do ajudante (pai dos cards de atividade dele)
//   parentToolUseId  toolUseId da chamada `delegate` (o envelope do lote)
//   input            { helperId, name?, model, effort?, seat?|seatName?, cli?,
//                      prompt?|description? }
function helperCard(id, helperId, input, extra = {}) {
  const cardName = `helper:${helperId}`
  return {
    ...tool(id, cardName, input.prompt ?? ''),
    toolUseId: cardName,
    parentToolUseId: 'delegate-1',
    subagent: guiSubagentMetadataForTool(cardName, { helperId, ...input }),
    ...extra
  }
}

function delegateEnvelope(id, helpers) {
  return {
    ...tool(id, 'mcp__synkora__delegate', 'delegate'),
    toolUseId: 'delegate-1',
    subagent: guiSubagentMetadataForTool('mcp__synkora__delegate', { helpers }),
    result: launched('task-delegate-1')
  }
}

// C1 — o que o dono pediu para VER: modelo, effort e conta de cada ajudante.
test('C1 — metadata do ajudante carrega effort, conta e CLI', () => {
  const helper = guiSubagentMetadataForTool('helper:h-1', {
    helperId: 'h-1',
    name: 'revisor do diff',
    model: 'opus[1m]',
    effort: 'max',
    seat: 'Claude - Gmail',
    cli: 'claude',
    prompt: 'revise o diff do worktree'
  })
  assert.ok(helper, 'o card sintetizado de ajudante é uma delegação')
  assert.equal(helper.helperId, 'h-1')
  assert.equal(helper.model, 'opus[1m]')
  assert.equal(helper.effort, 'max')
  assert.equal(helper.seat, 'Claude - Gmail')
  assert.equal(helper.cli, 'claude')
  assert.equal(helper.prompt, 'revise o diff do worktree')

  // Aliases defensivos: o wire pode mandar seatName/reasoningEffort.
  const alias = guiSubagentMetadataForTool('mcp__synkora__delegate', {
    subagent_type: 'ajudante',
    seatName: 'Codex - Hotmail',
    reasoningEffort: 'low',
    cli: 'codex'
  })
  assert.ok(alias)
  assert.equal(alias.seat, 'Codex - Hotmail')
  assert.equal(alias.effort, 'low')
  assert.equal(alias.cli, 'codex')

  // Nativo aposentado: sem os campos novos nada é inventado.
  const nativo = guiSubagentMetadataForTool('Task', {
    prompt: 'investigue',
    subagent_type: 'geral'
  })
  assert.ok(nativo)
  assert.equal(nativo.effort, undefined)
  assert.equal(nativo.seat, undefined)
  assert.equal(nativo.cli, undefined)
  assert.equal(nativo.helperId, undefined)
})

// C2 — o nome da tool chega diferente em cada CLI; os dois são delegação.
test('C2 — a delegação por MCP é reconhecida nos dois CLIs', () => {
  // claude: a chave do servidor entra no nome (sonda probe-claude-fence §3).
  assert.ok(guiSubagentMetadataForTool('mcp__synkora__delegate', { prompt: 'abra 5 opus' }))
  // codex: `codexSession.ts` entrega o nome CRU da tool (`item.tool`); a forma
  // qualificada por servidor também passa, por precaução.
  assert.ok(guiSubagentMetadataForTool('delegate', { prompt: 'x' }))
  assert.ok(guiSubagentMetadataForTool('synkora/delegate', { prompt: 'x' }))
  assert.ok(guiSubagentMetadataForTool('synkora__delegate', { prompt: 'x' }))
  // A âncora nativa continua intacta.
  assert.ok(guiSubagentMetadataForTool('Task', { prompt: 'x' }))
  assert.ok(guiSubagentMetadataForTool('spawn_agent', { prompt: 'x' }))

  // As IRMÃS do catálogo de delegação não são delegação nenhuma — e a família
  // `Task*` do claude 2.1.234 (que é a LISTA DE AFAZERES, sonda
  // probe-claude-fence §1.2) não pode virar ficha de subagente.
  for (const name of [
    'mcp__synkora__helpers_status',
    'mcp__synkora__helper_result',
    'mcp__synkora__helper_send',
    'mcp__synkora__list_seats',
    'mcp__claude_ai_Google_Drive__search_files',
    'mcp__playwright__browser_navigate',
    'TaskCreate',
    'TaskList',
    'TaskUpdate',
    'TaskOutput',
    'TaskStop',
    'Read'
  ]) {
    assert.equal(
      guiSubagentMetadataForTool(name, { model: 'x', description: 'y' }),
      undefined,
      `${name} não pode virar ficha de subagente`
    )
  }

  // O recibo 'launched' segura o envelope aberto (contrato já existente).
  const [entry] = normalizeGuiSubagentSidebar([delegateEnvelope('1', [{ prompt: 'a' }])])
  assert.ok(entry, 'a chamada MCP de delegação abre ficha antes do primeiro recibo')
  assert.equal(entry.toolUseId, 'delegate-1')
  assert.equal(entry.status, 'running')
  assert.equal(entry.statusLabel, 'trabalhando')
})

// C3 — a ordem do dono em mecânica: 5 ajudantes = 5 fichas, cross-CLI incluso.
test('C3 — lote abre uma ficha POR ajudante e o envelope não duplica', () => {
  const pedido = [
    { helperId: 'h-1', name: 'revisor A', model: 'opus[1m]', effort: 'max', seat: 'Claude - Gmail', cli: 'claude', prompt: 'revise o módulo A' },
    { helperId: 'h-2', name: 'revisor B', model: 'opus[1m]', effort: 'max', seat: 'Claude - Hotmail', cli: 'claude', prompt: 'revise o módulo B' },
    { helperId: 'h-3', name: 'revisor C', model: 'opus[1m]', effort: 'max', seat: 'Claude - Gmail', cli: 'claude', prompt: 'revise o módulo C' },
    { helperId: 'h-4', name: 'sonda D', model: 'gpt-5.6-luna', effort: 'high', seat: 'Codex - Hotmail', cli: 'codex', prompt: 'sonde o binário D' },
    { helperId: 'h-5', name: 'sonda E', model: 'gpt-5.6-luna', effort: 'high', seat: 'Codex - Hotmail', cli: 'codex', prompt: 'sonde o binário E' }
  ]
  const envelope = delegateEnvelope('1', pedido)
  const helpers = pedido.map((input, index) =>
    helperCard(String(10 + index), input.helperId, input)
  )
  const atividade = {
    ...tool('30', 'Read', 'src/main/index.ts'),
    toolUseId: 'act-3',
    parentToolUseId: 'helper:h-3'
  }

  const entries = normalizeGuiSubagentSidebar([envelope, ...helpers, atividade])
  assert.deepEqual(
    entries.map((entry) => entry.toolUseId),
    ['helper:h-1', 'helper:h-2', 'helper:h-3', 'helper:h-4', 'helper:h-5'],
    'cinco ajudantes nunca colapsam num card só'
  )
  assert.ok(
    !entries.some((entry) => entry.toolUseId === 'delegate-1'),
    'o envelope do lote não vira uma sexta ficha sem modelo/effort/conta'
  )

  assert.equal(entries[0].name, 'revisor A')
  assert.equal(entries[0].model, 'opus[1m]')
  assert.equal(entries[0].effort, 'max')
  assert.equal(entries[0].seat, 'Claude - Gmail')
  assert.equal(entries[0].cli, 'claude')
  assert.equal(entries[0].task, 'revise o módulo A')
  // Cross-CLI é cidadão de primeira classe: mesma ficha, outro carimbo.
  assert.equal(entries[3].model, 'gpt-5.6-luna')
  assert.equal(entries[3].effort, 'high')
  assert.equal(entries[3].seat, 'Codex - Hotmail')
  assert.equal(entries[3].cli, 'codex')

  // Atividade não vaza entre irmãos nem para o envelope.
  assert.equal(entries[2].activity, 'Read · src/main/index.ts')
  assert.equal(entries[0].activity, 'aguardando a primeira atividade')

  // Ajudante que assenta sai da lateral; os irmãos continuam trabalhando.
  const comUmPronto = [
    envelope,
    { ...helpers[0], result: result('achei 3 problemas') },
    ...helpers.slice(1),
    atividade
  ]
  assert.deepEqual(
    normalizeGuiSubagentSidebar(comUmPronto).map((entry) => entry.toolUseId),
    ['helper:h-2', 'helper:h-3', 'helper:h-4', 'helper:h-5']
  )
})

// C5 — o card do ajudante herda o ciclo de vida JÁ provado do Agent nativo:
// recibo 'launched' segura a ficha (e é o que a poda de 400 itens protege),
// terminal factual do motor encerra, e morte de sessão/respawn cancelam o
// ajudante junto com a atividade dele (D1: helper não sobrevive a restart).
test('C5 — o card do ajudante segue o ciclo de vida launched/settled', () => {
  const perfil = {
    helperId: 'h-1',
    name: 'revisor do diff',
    model: 'opus[1m]',
    effort: 'max',
    seat: 'Claude - Gmail',
    cli: 'claude',
    prompt: 'revise o diff do worktree'
  }
  const envelope = delegateEnvelope('1', [perfil])
  const helper = helperCard('10', 'h-1', perfil, { result: launched('helper-task-1') })
  const atividade = {
    ...tool('20', 'Read', 'src/main/index.ts'),
    toolUseId: 'act-1',
    parentToolUseId: 'helper:h-1'
  }
  const items = [envelope, helper, atividade]

  const vivo = normalizeGuiSubagentSidebar(items)
  assert.deepEqual(vivo.map((entry) => entry.toolUseId), ['helper:h-1'])
  assert.equal(vivo[0].status, 'running')
  assert.equal(vivo[0].activity, 'Read · src/main/index.ts')

  // O recibo não fecha o card: o terminal do motor entra no MESMO id.
  const alvo = guiToolResultTargetIndex(items, 'helper:h-1')
  assert.equal(alvo, 1)
  const assentado = [...items]
  assentado[alvo] = {
    ...helper,
    result: result('entreguei o parecer', 'completed', false, {
      agentStatus: 'settled',
      agentTaskId: 'helper-task-1'
    })
  }
  assert.deepEqual(normalizeGuiSubagentSidebar(assentado), [])

  // Respawn e morte de sessão levam ajudante e atividade juntos.
  const respawn = settleLaunchedGuiSubagents(items)
  assert.equal(respawn[1].result.status, 'cancelled')
  assert.equal(respawn[2].result.status, 'cancelled')
  assert.deepEqual(normalizeGuiSubagentSidebar(respawn), [])
  assert.deepEqual(
    normalizeGuiSubagentSidebar(closePendingGuiTools(items, { type: 'closed', code: 0 })),
    []
  )
})

// C4 — a superfície mostra o que o dono foi buscar (modelo + effort + conta).
test('C4 — a ficha exibe effort e conta e carimba o CLI', () => {
  const source = readFileSync(
    new URL('../src/renderer/src/components/GuiSubagentSidebar.tsx', import.meta.url),
    'utf8'
  )
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')

  assert.match(source, /\{entry\.effort && <span>\{entry\.effort\}<\/span>\}/u)
  assert.match(source, /\{entry\.seat && <span>\{entry\.seat\}<\/span>\}/u)
  assert.match(source, /data-subagent-cli=/u)
  assert.match(source, /Conta: \$\{entry\.seat\}/u)
  assert.match(source, /Effort: \$\{entry\.effort\}/u)
  // Três campos não cabem numa linha de ~165px do trilho: a fileira quebra.
  assert.match(css, /\.gui-subagent-row-meta \{[^}]*flex-wrap: wrap/u)
})
