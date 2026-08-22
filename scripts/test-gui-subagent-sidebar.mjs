import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  GUI_SUBAGENT_DISMISS_NO_BRIDGE,
  GUI_SUBAGENT_DISMISS_TIP,
  dismissGuiSubagentHelper,
  formatGuiSubagentElapsed,
  guiSubagentDismissable,
  guiSubagentElapsedMs,
  guiSubagentMetadataForTool,
  guiSubagentModelName,
  guiSubagentSidebarEntries,
  isGuiSubagentToolEvent,
  normalizeGuiSubagentSidebar
} from '../src/renderer/src/guiSubagentSidebar.ts'
import { guiBackgroundWorkPresentation } from '../src/renderer/src/guiBackgroundWorkPresentation.ts'
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
  // O modelo chega CRU do protocolo e sai DIGNO na ficha (R7 §B2) — a régua
  // vive em `guiSubagentModelName` e é provada na seção R7B, abaixo.
  assert.equal(entries[0].model, 'GPT-5.6 LUNA')
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
  assert.match(source, /useMemo\(\(\) => guiSubagentSidebarEntries\(items\), \[items\]\)/u)
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
  assert.equal(entries[0].model, 'OPUS 1M')
  assert.equal(entries[0].effort, 'max')
  assert.equal(entries[0].seat, 'Claude - Gmail')
  assert.equal(entries[0].cli, 'claude')
  assert.equal(entries[0].task, 'revise o módulo A')
  // Cross-CLI é cidadão de primeira classe: mesma ficha, outro carimbo.
  assert.equal(entries[3].model, 'GPT-5.6 LUNA')
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

  // Respawn (boot): o AJUDANTE vira INTERROMPIDO (R6.1 — o motor preservou o
  // registro dele, retomável; "cancelado" mentiria) e a atividade filha fecha.
  // A ficha FICA na lateral (guiSubagentSidebarEntries) mas sai do FIO
  // (normalizeGuiSubagentSidebar só conta quem trabalha).
  const respawn = settleLaunchedGuiSubagents(items)
  assert.equal(respawn[1].result.status, 'interrupted')
  assert.equal(respawn[2].result.status, 'cancelled')
  assert.deepEqual(normalizeGuiSubagentSidebar(respawn), [])
  assert.deepEqual(
    guiSubagentSidebarEntries(respawn).map((entry) => entry.status),
    ['interrupted'],
    'a ficha do interrompido tem de sobreviver ao boot'
  )
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

// ————— W4 · CRONÔMETRO DA FICHA (ordem do dono, 18/08: "há quanto tempo ele
// tá trabalhando") —————
//
// A ficha já dizia QUEM e O QUE; faltava HÁ QUANTO TEMPO. Como a lateral é
// só-trabalhando (terminal factual encerra a ficha), o cronômetro é a única
// leitura de "esse ajudante empacou" que o dono tem sem abrir o transcript.

// W4.1 — a régua do relógio, isolada do React.
test('W4 — o cronômetro conta em m:ss e vira h:mm:ss depois da primeira hora', () => {
  assert.equal(formatGuiSubagentElapsed(0), '0:00')
  assert.equal(formatGuiSubagentElapsed(999), '0:00', 'o segundo só troca quando fecha')
  assert.equal(formatGuiSubagentElapsed(1_000), '0:01')
  assert.equal(formatGuiSubagentElapsed(7_000), '0:07')
  assert.equal(formatGuiSubagentElapsed(59_999), '0:59')
  assert.equal(formatGuiSubagentElapsed(60_000), '1:00')
  assert.equal(formatGuiSubagentElapsed(65_000), '1:05')
  assert.equal(formatGuiSubagentElapsed(600_000), '10:00')
  assert.equal(formatGuiSubagentElapsed(3_599_000), '59:59', 'o último segundo antes da hora')
  assert.equal(formatGuiSubagentElapsed(3_600_000), '1:00:00')
  assert.equal(formatGuiSubagentElapsed(3_661_000), '1:01:01')
  assert.equal(formatGuiSubagentElapsed(45_296_000), '12:34:56')

  // O idioma é o MESMO do cronômetro do turno (`formatGuiElapsed`, na barra de
  // atividade): duas telas do app contando o tempo de jeitos diferentes é a
  // desarmonia que o dono lê como bug.
  const barra = readFileSync(
    new URL('../src/renderer/src/guiActivity.ts', import.meta.url),
    'utf8'
  )
  assert.match(barra, /\$\{hours\}:\$\{String\(minutes\)\.padStart\(2, '0'\)\}/u)

  // Relógio torto nunca vira TEXTO torto: carimbo no futuro, virada de fuso ou
  // valor não-finito aterrissam em 0:00 — nunca "-1:59" nem "NaN:NaN".
  assert.equal(formatGuiSubagentElapsed(-1), '0:00')
  assert.equal(formatGuiSubagentElapsed(-86_400_000), '0:00')
  assert.equal(formatGuiSubagentElapsed(Number.NaN), '0:00')
  assert.equal(formatGuiSubagentElapsed(Number.POSITIVE_INFINITY), '0:00')
  assert.equal(formatGuiSubagentElapsed(Number.NEGATIVE_INFINITY), '0:00')

  // O carimbo factual do card é o zero do cronômetro — a normalização preserva
  // `at` justamente para isso.
  const [entry] = normalizeGuiSubagentSidebar([
    {
      ...tool('1770000000000', 'Task', 'trabalho longo'),
      toolUseId: 'agent-1',
      subagent: guiSubagentMetadataForTool('Task', { prompt: 'trabalho longo' })
    }
  ])
  assert.equal(entry.at, 1_770_000_000_000)
  assert.equal(formatGuiSubagentElapsed(1_770_000_125_000 - entry.at), '2:05')
})

// W4.2 — o relógio é UM para a lista inteira. Um timer por ficha multiplicaria
// o custo pelo número de ajudantes abertos (o lote do dono abre cinco), e um
// timer sobrevivendo à lateral vazia seria vazamento puro.
test('W4 — a lista tem UM relógio só, com faxina, e a ficha mostra o cronômetro', () => {
  const source = readFileSync(
    new URL('../src/renderer/src/components/GuiSubagentSidebar.tsx', import.meta.url),
    'utf8'
  )
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')

  assert.equal(
    (source.match(/setInterval/gu) ?? []).length,
    1,
    'um timer por ficha multiplicaria o custo por ajudante aberto'
  )
  const hookStart = source.indexOf('function useGuiSubagentClock')
  const cardStart = source.indexOf('function SubagentCard')
  assert.ok(hookStart >= 0, 'o relógio compartilhado tem nome próprio')
  assert.ok(cardStart > hookStart, 'o relógio mora ACIMA da ficha, não dentro dela')

  const relogio = source.slice(hookStart, cardStart)
  assert.match(relogio, /window\.setInterval\(/u)
  assert.match(relogio, /window\.clearInterval\(timer\)/u, 'timer sem faxina vaza no unmount')
  assert.match(relogio, /if \(!active\) return/u, 'lateral vazia não mantém timer de pé')
  assert.doesNotMatch(source.slice(cardStart), /setInterval/u, 'nunca um timer POR card')

  // Ligado ao único fato que faz o relógio ANDAR: haver ficha trabalhando. A
  // R6-C trocou "ter ficha" por "ter ficha viva" porque a lateral passou a
  // guardar o interrompido — cujo cronômetro está congelado e não pede tique.
  assert.match(
    source,
    /useGuiSubagentClock\(entries\.some\(\(entry\) => entry\.status === 'running'\)\)/u
  )

  // O cronômetro é medido do carimbo FACTUAL do card contra o tique dividido —
  // e passa pela régua que CONGELA o interrompido (R6-C), nunca pelo `now` cru.
  assert.match(source, /gui-subagent-row-elapsed/u)
  assert.match(source, /guiSubagentElapsedMs\(entry, now, clock\)/u)

  // FORA da região viva do estado: um live region que muda a cada segundo faria
  // o leitor de tela narrar o relógio para sempre.
  const status = source.slice(source.indexOf('role="status"'))
  assert.doesNotMatch(
    status.slice(0, status.indexOf('</span>')),
    /elapsed/u,
    'o relógio não pode ser narrado a cada tique'
  )

  // Dígito não dança a cada segundo (largura fixa) e o tom é o da fileira de
  // metadados — o cronômetro informa, nunca disputa com o nome do ajudante.
  assert.match(css, /\.gui-subagent-row-elapsed \{[^}]*font-variant-numeric: tabular-nums/u)
  assert.match(css, /\.gui-subagent-row-elapsed \{[^}]*var\(--ink-3\)/u)
})

// ————— R6-C · O CICLO REDONDO: interrompido é PAUSA, não descarte —————
//
// Design vinculante R6.1/R6.3 (`.synkora/reports/DESIGN_SUBAGENTES_SEM_ABA_
// 2026-08-18.md`): o ■ do dono e o fechamento do app INTERROMPEM a frota
// PRESERVANDO ela, e o card do ajudante interrompido FICA na lateral, com o
// cronômetro congelado, para o dono ver qual frota ele pode retomar.
//
// O contrato entre as ondas é literal: o card sintetizado do ajudante
// interrompido chega com `result.status === 'interrupted'` — irmão do
// 'cancelled' que a lateral já lê hoje.

/** O terminal que a onda B carimba quando a frota é parada PRESERVANDO. */
function interruptedResult(text = 'entrega parcial preservada') {
  return result(text, 'interrupted', false, { agentStatus: 'settled' })
}

const HELPER_PROFILE = {
  helperId: 'h-1',
  name: 'sonda A',
  model: 'opus[1m]',
  effort: 'max',
  seat: 'Claude - Gmail',
  cli: 'claude',
  prompt: 'sonde o binário do codex'
}

// R6C.1 — a ficha SOBREVIVE ao terminal, com rótulo próprio. É o oposto de
// todos os outros desfechos: eles encerram a ficha, este a deixa esperando.
test('R6C — o ajudante INTERROMPIDO fica na lateral, com rótulo próprio', () => {
  const parado = helperCard('10', 'h-1', HELPER_PROFILE, { result: interruptedResult() })
  const atividade = {
    ...tool('20', 'Read', 'src/main/index.ts'),
    toolUseId: 'act-1',
    parentToolUseId: 'helper:h-1',
    result: result('encerrado com o subagente')
  }
  const [ficha] = guiSubagentSidebarEntries([
    delegateEnvelope('1', [HELPER_PROFILE]),
    parado,
    atividade
  ])

  assert.ok(ficha, 'interromper PRESERVA: a ficha não pode sumir da lateral')
  assert.equal(ficha.toolUseId, 'helper:h-1')
  assert.equal(ficha.status, 'interrupted')
  assert.equal(ficha.statusLabel, 'interrompido')
  // O dono precisa ver QUAL frota ele pode retomar — modelo, effort e conta
  // continuam na ficha exatamente como quando ela estava viva.
  assert.equal(ficha.model, 'OPUS 1M')
  assert.equal(ficha.effort, 'max')
  assert.equal(ficha.seat, 'Claude - Gmail')
  assert.equal(ficha.cli, 'claude')
  assert.equal(ficha.task, 'sonde o binário do codex')
  // "agora" é presente do indicativo: ajudante parado não tem atividade em
  // curso, nem quando o filho ficou pendente no anel (replay/queda suja).
  assert.equal(ficha.activity, null)
  const [comFilhoAberto] = guiSubagentSidebarEntries([
    parado,
    { ...tool('21', 'Grep', 'varredura'), toolUseId: 'act-2', parentToolUseId: 'helper:h-1' }
  ])
  assert.equal(comFilhoAberto.activity, null, 'ficha parada nunca diz "agora"')
})

// R6C.2 — os dois verbos do dono são estados DIFERENTES na tela: cancelar é
// descarte (sai), interromper é pausa (fica). Sem essa distinção ele não sabe
// o que ainda dá para retomar.
test('R6C — cancelado é DESCARTE e sai; interrompido é pausa e fica', () => {
  const descartado = helperCard(
    '11',
    'h-2',
    { ...HELPER_PROFILE, helperId: 'h-2', name: 'sonda B' },
    { result: result('', 'cancelled', false, { agentStatus: 'settled' }) }
  )
  const parado = helperCard('12', 'h-1', HELPER_PROFILE, { result: interruptedResult() })

  assert.deepEqual(
    guiSubagentSidebarEntries([descartado, parado]).map((entry) => [
      entry.toolUseId,
      entry.statusLabel
    ]),
    [['helper:h-1', 'interrompido']]
  )

  // E os outros desfechos continuam encerrando a ficha, como sempre.
  for (const status of ['completed', 'failed', 'denied', 'cancelled']) {
    assert.deepEqual(
      guiSubagentSidebarEntries([
        helperCard('13', 'h-3', { ...HELPER_PROFILE, helperId: 'h-3' }, {
          result: result('fim', status, status === 'failed', { agentStatus: 'settled' })
        })
      ]),
      [],
      `${status} não pode virar pausa`
    )
  }
})

// R6C.3 — O FIO NÃO CONTA FROTA PARADA. `normalizeGuiSubagentSidebar` continua
// sendo a projeção VIVA (é ela que o GuiPane entrega ao indicador "N
// subagentes trabalhando em segundo plano"): contar um ajudante interrompido
// ali diria ao dono que o app está trabalhando enquanto ninguém está.
test('R6C — o indicador do fio conta só quem trabalha; a lateral guarda o parado', () => {
  const parado = helperCard('10', 'h-1', HELPER_PROFILE, { result: interruptedResult() })
  const vivo = helperCard(
    '11',
    'h-2',
    { ...HELPER_PROFILE, helperId: 'h-2', name: 'sonda B' },
    { result: launched('helper-task-2') }
  )

  assert.deepEqual(normalizeGuiSubagentSidebar([parado]), [])
  assert.equal(
    guiBackgroundWorkPresentation({
      status: 'working',
      liveSubagents: normalizeGuiSubagentSidebar([parado])
    }),
    null,
    'frota parada não pode piscar trabalho no fio'
  )
  assert.equal(guiSubagentSidebarEntries([parado]).length, 1)

  // Com um irmão vivo o fio conta UM, e a lateral mostra os DOIS.
  assert.deepEqual(
    normalizeGuiSubagentSidebar([parado, vivo]).map((entry) => entry.toolUseId),
    ['helper:h-2']
  )
  assert.equal(
    guiBackgroundWorkPresentation({
      status: 'working',
      liveSubagents: normalizeGuiSubagentSidebar([parado, vivo])
    }).label,
    '1 subagente trabalhando em segundo plano'
  )
  assert.deepEqual(
    guiSubagentSidebarEntries([parado, vivo]).map((entry) => entry.status),
    ['interrupted', 'running'],
    'a ordem é a do fato, não a do estado: ficha nunca pula de lugar sozinha'
  )
})

// R6C.4 — O CRONÔMETRO CONGELA. Uma ficha parada que continua contando é a
// mentira mais fácil desta tela: o dono leria "trabalhando há 40 minutos" de
// um processo que morreu no minuto 4.
test('R6C — o cronômetro congela na interrupção e nunca volta a andar', () => {
  const memoria = new Map()
  const vivo = { toolUseId: 'helper:h-1', status: 'running', at: 1_000 }

  assert.equal(guiSubagentElapsedMs(vivo, 1_000, memoria), 0)
  assert.equal(guiSubagentElapsedMs(vivo, 126_000, memoria), 125_000)
  assert.equal(formatGuiSubagentElapsed(125_000), '2:05')

  const parado = { ...vivo, status: 'interrupted' }
  assert.equal(
    guiSubagentElapsedMs(parado, 200_000, memoria),
    125_000,
    'o relógio para onde o trabalho parou'
  )
  assert.equal(
    guiSubagentElapsedMs(parado, 9_999_000, memoria),
    125_000,
    'nem uma hora depois ele anda um segundo'
  )

  // Ficha que JÁ NASCE parada (o card interrompido que volta do anel no boot):
  // não existe tempo trabalhado nesta montagem, e a lateral prefere não mostrar
  // nada a inventar um "0:00" que seria falso.
  assert.equal(
    guiSubagentElapsedMs({ toolUseId: 'helper:h-9', status: 'interrupted', at: 5 }, 900_000, new Map()),
    null
  )

  // Retomar (helper_resume) é trabalho NOVO: o card novo conta do zero dele.
  assert.equal(
    guiSubagentElapsedMs(
      { toolUseId: 'helper:h-1#r2', status: 'running', at: 300_000 },
      302_000,
      memoria
    ),
    2_000
  )

  // Relógio torto continua não virando texto torto (a régua da W4 vale aqui).
  assert.equal(guiSubagentElapsedMs({ ...vivo, at: 999_999 }, 1_000, new Map()), 0)
})

// R6C.5 — a superfície: tom próprio, sem animação nova, e o fio intocado.
test('R6C — a ficha parada tem tom próprio no papel & painel, sem movimento novo', () => {
  const source = readFileSync(
    new URL('../src/renderer/src/components/GuiSubagentSidebar.tsx', import.meta.url),
    'utf8'
  )
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')

  // A lateral consome a projeção COMPLETA; o cronômetro passa pela memória.
  assert.match(source, /guiSubagentSidebarEntries/u)
  assert.match(source, /guiSubagentElapsedMs\(entry, now, clock\)/u)
  // Sem tempo medido nesta montagem, a ficha NÃO desenha o relógio.
  assert.match(source, /elapsed && \(/u)

  // O FIO continua consumindo a projeção viva — é o que impede o indicador de
  // "N subagentes trabalhando" de contar uma frota interrompida.
  assert.match(
    pane,
    /useMemo\(\(\) => normalizeGuiSubagentSidebar\(gui\.items\), \[gui\.items\]\)/u,
    'o indicador do fio não pode passar a contar ficha parada'
  )

  // Pausa NÃO é erro: o tom da ficha parada é o traço apagado do papel, nunca
  // o vermelho de falha — e nada de animação nova (a lateral já pulsa o vivo).
  const bloco = css.match(/\.gui-subagent-row\.interrupted \{[^}]*\}/u)?.[0] ?? ''
  assert.ok(bloco, 'a ficha interrompida não tem casa no CSS')
  assert.match(bloco, /border-left-style: dashed/u)
  assert.doesNotMatch(bloco, /var\(--err\)/u, 'interromper não é falhar')
  assert.doesNotMatch(bloco, /animation/u, 'a R6-C não traz movimento novo')
  assert.match(
    css,
    /\.gui-subagent-row\.interrupted \.gui-subagent-row-dot \{[^}]*background: transparent/u,
    'o ponto cheio é de quem está vivo'
  )
})

// ————— R7B — A LATERAL SÓ PROMOVE DELEGAÇÃO DE VERDADE (design R7 §B1) —————
//
// 2º print da validação ao vivo do dono: o long-poll do delegador claude
// (`mcp__synkora__helper_result`) virou ficha fantasma "subagente · modelo não
// informado". A causa era mecânica — TODA tool do catálogo de delegação leva
// `helperId` no input, e `helperId` sozinho promovia o card.
//
// A promoção passa a ter três portas, e nenhuma delas é um campo de input:
// nome `delegate` (o envelope), nome `helper:*` (o card sintetizado pelo
// harness) e `type` de subagente nativo.

test('R7B — tool do catálogo com helperId no input NUNCA vira ficha', () => {
  // O caso LITERAL do print: o long-poll, com o input que ele realmente manda.
  assert.equal(
    guiSubagentMetadataForTool('mcp__synkora__helper_result', { helperId: 'h-1' }),
    undefined,
    'o long-poll do helper_result não é um subagente'
  )

  // A família inteira do catálogo, nas três formas de nome que chegam ao
  // renderer, com o input mais tentador possível (helperId + model).
  for (const name of [
    'mcp__synkora__helper_result',
    'mcp__synkora__helper_send',
    'mcp__synkora__helper_resume',
    'mcp__synkora__helper_cancel',
    'mcp__synkora__helpers_status',
    'helper_result',
    'helper_cancel',
    'synkora/helper_resume',
    'synkora__helper_send'
  ]) {
    assert.equal(
      guiSubagentMetadataForTool(name, {
        helperId: 'h-1',
        model: 'opus[1m]',
        effort: 'max',
        seat: 'Claude - Gmail'
      }),
      undefined,
      `${name} é card comum de tool no fio, nunca ficha da lateral`
    )
  }

  // E com o anel montado: o card do print não abre ficha nenhuma, nem sozinho
  // nem ao lado da frota de verdade.
  const longPoll = {
    ...tool('30', 'mcp__synkora__helper_result', 'aguardando h-1'),
    toolUseId: 'poll-1',
    subagent: guiSubagentMetadataForTool('mcp__synkora__helper_result', { helperId: 'h-1' })
  }
  assert.deepEqual(guiSubagentSidebarEntries([longPoll]), [], 'ficha fantasma do print 2')
  assert.deepEqual(
    guiSubagentSidebarEntries([
      delegateEnvelope('1', [HELPER_PROFILE]),
      helperCard('10', 'h-1', HELPER_PROFILE, { result: launched('helper-task-1') }),
      longPoll
    ]).map((entry) => entry.toolUseId),
    ['helper:h-1'],
    'o ajudante de verdade fica; o long-poll dele não vira um irmão fantasma'
  )

  // As TRÊS portas que sobraram continuam abrindo — o card sintetizado (nas
  // duas vidas), o envelope e o subagente nativo.
  assert.ok(guiSubagentMetadataForTool('helper:h-1', { helperId: 'h-1', model: 'opus[1m]' }))
  assert.ok(guiSubagentMetadataForTool('helper:h-1#vida2', { helperId: 'h-1', model: 'opus[1m]' }))
  assert.ok(guiSubagentMetadataForTool('mcp__synkora__delegate', { helpers: [] }))
  assert.ok(guiSubagentMetadataForTool('Ferramenta', { subagent_type: 'qa' }))
})

// R7B.2 — O NOME DIGNO DO MODELO (design R7 §B2: "a ficha da lateral também
// ganha o nome bonito do modelo quando houver"). O id cru é vocabulário de
// motor; a ficha é leitura de relance do dono.
test('R7B — a ficha prefere o NOME BONITO do modelo, com o id cru de reserva', () => {
  assert.equal(guiSubagentModelName('opus[1m]'), 'OPUS 1M')
  assert.equal(guiSubagentModelName('claude-opus-4-8'), 'OPUS 4.8')
  assert.equal(guiSubagentModelName('sonnet'), 'SONNET')
  assert.equal(guiSubagentModelName('gpt-5.6-luna'), 'GPT-5.6 LUNA')
  assert.equal(guiSubagentModelName('gpt-5.2-codex'), 'GPT-5.2 CODEX')

  // Reserva HONESTA: id de família desconhecida sai como veio. Enfeitar o que
  // não se reconhece é inventar identidade de motor.
  assert.equal(guiSubagentModelName('mistral-nemo-2407'), 'mistral-nemo-2407')
  assert.equal(guiSubagentModelName(''), '')

  // GÊMEO DECLARADO de `prettyModel` (PaneChrome): as duas telas escrevem o
  // MESMO nome para o mesmo modelo. O gêmeo não pode ser importado (as suítes
  // carregam TS com type-stripping do node, que não resolve irmão sem extensão
  // — e o PaneChrome é React), então a paridade é PROVADA aqui, executando a
  // função do outro arquivo.
  const chrome = readFileSync(
    new URL('../src/renderer/src/components/PaneChrome.tsx', import.meta.url),
    'utf8'
  )
  // CRLF: os fontes do repo são de Windows, e a chave de fechamento da função
  // (a única na coluna 0) é o que delimita o corpo.
  const corpo = chrome.match(
    /export function prettyModel\(id: string\): string \{\r?\n([\s\S]*?)\r?\n\}/u
  )?.[1]
  assert.ok(corpo, 'o gêmeo `prettyModel` mudou de assinatura ou saiu do PaneChrome')
  const composer = new Function('id', corpo)
  for (const id of [
    'opus[1m]',
    'opus',
    'claude-opus-4-8',
    'claude-fable-5-20260401',
    'sonnet',
    'haiku',
    'gpt-5.6-luna',
    'gpt-5.2-codex',
    'gpt-5.6-sol'
  ]) {
    assert.equal(
      guiSubagentModelName(id),
      composer(id),
      `${id}: a lateral e o composer têm de escrever o mesmo nome`
    )
  }
  // A ÚNICA divergência deliberada: fora das famílias conhecidas o composer
  // caixa-alta o id, e a lateral prefere devolvê-lo intacto.
  assert.equal(composer('mistral-nemo'), 'MISTRAL NEMO')
  assert.equal(guiSubagentModelName('mistral-nemo'), 'mistral-nemo')
})

// R7B.3 — o nome bonito é da FICHA, não da metadata: o que o motor disse
// continua guardado cru (é ele que o `helper_resume` e a depuração usam).
test('R7B — a metadata guarda o id cru; quem embeleza é a ficha', () => {
  const metadata = guiSubagentMetadataForTool('helper:h-7', {
    helperId: 'h-7',
    name: 'sonda',
    model: 'claude-opus-4-8',
    effort: 'max',
    seat: 'Claude - Gmail',
    cli: 'claude',
    prompt: 'sonde'
  })
  assert.equal(metadata.model, 'claude-opus-4-8', 'a projeção do input não maquia o motor')

  const [ficha] = guiSubagentSidebarEntries([
    helperCard('40', 'h-7', {
      helperId: 'h-7',
      name: 'sonda',
      model: 'claude-opus-4-8',
      effort: 'max',
      seat: 'Claude - Gmail',
      cli: 'claude',
      prompt: 'sonde'
    })
  ])
  assert.equal(ficha.model, 'OPUS 4.8')
  // Effort e conta continuam sendo palavra do motor — só o MODELO tem nome de
  // catálogo para preferir.
  assert.equal(ficha.effort, 'max')
  assert.equal(ficha.seat, 'Claude - Gmail')
  // E o silêncio continua sendo dito, nunca preenchido.
  const [semModelo] = guiSubagentSidebarEntries([
    {
      ...tool('41', 'Task', 'sem modelo'),
      toolUseId: 'nativo-1',
      subagent: guiSubagentMetadataForTool('Task', { subagent_type: 'geral' })
    }
  ])
  assert.equal(semModelo.model, 'modelo não informado')
})

// ————— R12 §B5 — o ⚡ NA FICHA —————
//
// Ordem do dono (19/08): "…e quando o ajudante tem fast também". O recibo de
// abertura já carimbava '⚡ fast'; a ficha, que é o que fica na tela enquanto a
// frota trabalha, não sabia de nada.

test('R12 — a ficha do ajudante fast carrega e mostra o ⚡', () => {
  const metadata = guiSubagentMetadataForTool('helper:h-8', {
    helperId: 'h-8',
    name: 'sonda veloz',
    model: 'opus[1m]',
    effort: 'max',
    fast: true,
    seat: 'Claude - Gmail',
    cli: 'claude',
    prompt: 'corra'
  })
  assert.equal(metadata.fast, true)
  // `true` LITERAL: string e número não acendem um modo que gasta mais limite.
  for (const sujo of ['true', 'sim', 1, {}]) {
    assert.equal(
      guiSubagentMetadataForTool('helper:h-8', { helperId: 'h-8', model: 'x', fast: sujo }).fast,
      undefined,
      `${JSON.stringify(sujo)} não pode virar ⚡ na ficha`
    )
  }
  assert.equal(
    guiSubagentMetadataForTool('helper:h-8', { helperId: 'h-8', model: 'x' }).fast,
    undefined
  )

  const [veloz] = guiSubagentSidebarEntries([
    helperCard('50', 'h-8', {
      name: 'sonda veloz',
      model: 'opus[1m]',
      effort: 'max',
      fast: true,
      seat: 'Claude - Gmail',
      cli: 'claude',
      prompt: 'corra'
    })
  ])
  assert.equal(veloz.fast, true)
  assert.equal(veloz.effort, 'max', 'o ⚡ entra ao lado do effort, nunca no lugar dele')
  const [normal] = guiSubagentSidebarEntries([
    helperCard('51', 'h-9', { model: 'opus[1m]', prompt: 'ande' })
  ])
  assert.equal(normal.fast, undefined, 'ajudante comum não ganha carimbo nenhum')

  const source = readFileSync(
    new URL('../src/renderer/src/components/GuiSubagentSidebar.tsx', import.meta.url),
    'utf8'
  )
  assert.match(source, /\{entry\.fast && <span>⚡ fast<\/span>\}/u)
  // O leitor de tela ouve a palavra, não o desenho.
  assert.match(source, /Fast: ligado/u)
})

// ————— R27F3 — O ✕ DA FROTA (ordem do dono, 2026-08-22) —————
//
// "Quando o subagente deu interrompido, eu quero algum X pra eu tirar dali,
// porque eu já entendi." O mockup aprovado (docs/mockups/rightdock-2.html,
// seção FROTA) põe o ✕ no canto da ficha, ghost em ink-3 e vermelho no hover,
// com uma nota que é contrato: descartar é o MESMO descarte do helper_cancel —
// a entrega parcial vai junto, e a dica tem de avisar.
//
// Três cercas, nesta ordem: quem GANHA o ✕ (ficha parada com ajudante no
// motor), o que a DICA promete e como o clique DEGRADA sem a ponte do preload.

/** Roda `fn` com um `window` de mentira — a ponte do preload não existe em
 *  node, e é justamente a ausência dela que o degradê tem de cobrir. */
async function withWindow(fake, fn) {
  const had = 'window' in globalThis
  const previous = globalThis.window
  globalThis.window = fake
  try {
    return await fn()
  } finally {
    if (had) globalThis.window = previous
    else delete globalThis.window
  }
}

test('R27F3 — a ficha do ajudante carrega o helperId; a nativa não tem nenhum', () => {
  const [ficha] = guiSubagentSidebarEntries([
    helperCard('10', 'h-1', HELPER_PROFILE, { result: interruptedResult() })
  ])
  assert.equal(ficha.helperId, 'h-1', 'sem o id do motor o ✕ não teria a quem falar')

  // O caminho NATIVO aposentado (Task/Agent) nunca teve ajudante no motor: a
  // ficha dele não pode ganhar um botão que não tem para onde ir.
  const [nativa] = guiSubagentSidebarEntries([agentCard('20', 'agent-1', 'investigue')])
  assert.equal(nativa.helperId, null)
})

test('R27F3 — o ✕ só nasce na ficha PARADA que tem ajudante no motor', () => {
  const parada = { status: 'interrupted', helperId: 'h-1' }
  assert.equal(guiSubagentDismissable(parada), true)

  // TRABALHANDO não ganha ✕: quem para a frota viva é o ■ da conversa, e um
  // descarte por clique aqui jogaria fora trabalho em curso sem aviso.
  assert.equal(guiSubagentDismissable({ status: 'running', helperId: 'h-1' }), false)
  // Sem helperId não há clique possível — botão morto é pior que botão ausente.
  assert.equal(guiSubagentDismissable({ status: 'interrupted', helperId: null }), false)
  assert.equal(guiSubagentDismissable({ status: 'running', helperId: null }), false)
  // E os desfechos que ENCERRAM também não: o motor não descarta quem já
  // entregou (a entrega é o produto) nem quem já foi descartado. Eles nem
  // chegam à lateral hoje — mas um botão que só sabe recusar seria um beco.
  for (const status of ['completed', 'failed', 'denied', 'cancelled']) {
    assert.equal(
      guiSubagentDismissable({ status, helperId: 'h-1' }),
      false,
      `${status} não tem descarte honesto no motor`
    )
  }
})

test('R27F3 — a dica do ✕ avisa que a entrega parcial some junto', () => {
  assert.match(GUI_SUBAGENT_DISMISS_TIP, /descarta o ajudante/u)
  assert.match(GUI_SUBAGENT_DISMISS_TIP, /entrega parcial/u)
  // O NOME do verbo do agente: é o que liga o gesto do dono ao que o chat já
  // sabe fazer, e o que impede a leitura de "só some da tela".
  assert.match(GUI_SUBAGENT_DISMISS_TIP, /helper_cancel/u)
})

test('R27F3 — o clique fala com a ponte; sem ponte, degrada com a receita', async () => {
  const pedidos = []
  const ok = await withWindow(
    { synkora: { gui: { dismissHelper: async (helperId) => {
      pedidos.push(helperId)
      return { ok: true, state: 'discarded' }
    } } } },
    () => dismissGuiSubagentHelper('h-1')
  )
  assert.deepEqual(ok, { ok: true })
  assert.deepEqual(pedidos, ['h-1'], 'o ✕ tem de chegar ao motor pelo id do ajudante')

  // A metade do MAIN só chega no restart seguinte: enquanto ela não chega, o
  // clique não pode ser um no-op silencioso — ele NOMEIA a receita.
  const semPonte = await withWindow({ synkora: { gui: {} } }, () =>
    dismissGuiSubagentHelper('h-1')
  )
  assert.deepEqual(semPonte, { ok: false, error: GUI_SUBAGENT_DISMISS_NO_BRIDGE })
  assert.match(GUI_SUBAGENT_DISMISS_NO_BRIDGE, /reinicie o app \(npm run dev\)/u)
  const semSynkora = await withWindow({}, () => dismissGuiSubagentHelper('h-1'))
  assert.deepEqual(semSynkora, { ok: false, error: GUI_SUBAGENT_DISMISS_NO_BRIDGE })

  // Recusa do main viaja VERBATIM (é ela que nomeia o estado real do ajudante).
  const recusa = await withWindow(
    { synkora: { gui: { dismissHelper: async () => ({ ok: false, error: 'o ajudante ainda trabalha' }) } } },
    () => dismissGuiSubagentHelper('h-1')
  )
  assert.deepEqual(recusa, { ok: false, error: 'o ajudante ainda trabalha' })

  // Ponte que explode ou responde lixo nunca vira "descartei": o dono ficaria
  // olhando uma ficha que ele acha que já foi.
  const explodiu = await withWindow(
    { synkora: { gui: { dismissHelper: async () => { throw new Error('canal caiu') } } } },
    () => dismissGuiSubagentHelper('h-1')
  )
  assert.equal(explodiu.ok, false)
  assert.match(explodiu.error, /canal caiu/u)
  const lixo = await withWindow(
    { synkora: { gui: { dismissHelper: async () => undefined } } },
    () => dismissGuiSubagentHelper('h-1')
  )
  assert.equal(lixo.ok, false)
  assert.ok(lixo.error, 'resposta sem forma tem de virar recusa com texto')
})

test('R27F3 — a superfície do ✕ segue o mockup aprovado (ghost, ink-3, err no hover)', () => {
  const source = readFileSync(
    new URL('../src/renderer/src/components/GuiSubagentSidebar.tsx', import.meta.url),
    'utf8'
  )
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')

  // O botão nasce da REGRA, nunca de um `status === 'interrupted'` solto na
  // marcação: quem decide é a mesma função que a suíte prova acima.
  assert.match(source, /guiSubagentDismissable\(entry\)/u)
  assert.match(source, /gui-subagent-row-dismiss/u)
  assert.match(source, /✕/u)
  // Dica é data-tip (o title= nativo é proibido na casa).
  assert.match(source, /data-tip=\{GUI_SUBAGENT_DISMISS_TIP\}/u)
  assert.doesNotMatch(source, /title=\{GUI_SUBAGENT_DISMISS_TIP\}/u)
  // O clique passa pela ponte, e a recusa vira TEXTO na lateral.
  assert.match(source, /dismissGuiSubagentHelper\(/u)
  assert.match(source, /gui-subagent-note/u)
  // A linha só sai da lista com um OK do motor — nada de esconder ficha que o
  // outro lado recusou (ou que a ponte nem chegou a ouvir).
  assert.match(source, /if \(outcome\.ok\) setDismissed/u)
  assert.match(source, /else setNotice\(outcome\.error\)/u)
  // E a seção nunca fica VAZIA sob o cabeçalho: enquanto o card seguir no anel,
  // o corpo diz o que aconteceu.
  assert.match(source, /derived\.length > 0 \?/u)
  assert.match(source, /ficha descartada/u)

  const botao = css.match(/\.gui-subagent-row-dismiss \{[^}]*\}/u)?.[0] ?? ''
  assert.ok(botao, 'o ✕ da frota não tem casa no CSS')
  // Os valores do mockup, verbatim: ghost (sem borda, sem fundo), ink-3, 11px.
  assert.match(botao, /border: 0/u)
  assert.match(botao, /background: none/u)
  assert.match(botao, /color: var\(--ink-3\)/u)
  assert.match(botao, /font-size: 11px/u)
  assert.match(botao, /align-self: start/u)
  assert.match(
    css,
    /\.gui-subagent-row-dismiss:hover \{[^}]*color: var\(--err\)/u,
    'o hover do mockup é o vermelho do descarte'
  )
  // Foco visível é régua da casa — o anel de 2px do papel.
  assert.match(css, /\.gui-subagent-row-dismiss:focus-visible \{[^}]*outline: 2px solid/u)
})

test('a lista da frota rola com a barra retrô da casa — nunca a thin nativa', () => {
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')

  // Pedido do dono (22/08): scroll "bonitinho" também na FROTA. A lista JÁ
  // rolava (max-height + overflow), mas `scrollbar-width: thin` SUPRIME o
  // ::-webkit-scrollbar customizado no Chromium — a barra retrô de 10px da
  // casa nunca aparecia ali. A propriedade sai; a barra global assume.
  const lista = css.match(/\n\.gui-subagent-sidebar-list \{([\s\S]*?)\n\}/u)?.[1]
  assert.ok(lista, 'a regra da lista da frota precisa existir')
  assert.match(lista, /max-height/u, 'o teto que faz a lista rolar fica')
  assert.match(lista, /overflow/u)
  assert.doesNotMatch(
    lista,
    /scrollbar-width/u,
    'thin/none aqui mata a barra retrô no Chromium — foi o bug do dono'
  )
  // A CALHA é CONDICIONAL (terceiro ajuste do dono, mesmo dia): sem barra o
  // card fica SIMÉTRICO na seção (nada de vão morto à direita); a barra
  // nascendo, o respiro direito encolhe um pouco para acomodá-la. CSS não
  // sabe se a barra nasceu — a régua vem da medida viva do componente.
  assert.doesNotMatch(
    lista,
    /padding-right/u,
    'calha fixa de novo: sem scroll ela vira vão morto e o card fica torto'
  )
  const calha = css.match(/\.gui-subagent-sidebar-list\.has-scroll \{[^}]*\}/u)?.[0] ?? ''
  assert.ok(calha, 'a calha condicional precisa existir')
  const gutter = Number(calha.match(/padding-right:\s*(\d+)px/u)?.[1])
  assert.ok(gutter >= 2 && gutter <= 8, `o respiro com barra é PEQUENO (veio ${gutter}px)`)

  const componente = readFileSync(
    new URL('../src/renderer/src/components/GuiSubagentSidebar.tsx', import.meta.url),
    'utf8'
  )
  assert.match(componente, /scrollHeight > .*clientHeight/u, 'a régua da calha é a medida real')
  assert.match(componente, /has-scroll/u, 'a classe da calha nasce da medida')
  assert.match(componente, /ResizeObserver/u, 'a janela mudando re-mede sozinha')
})

test('a ficha fecha à direita com a linha FINA e NEUTRA — o sinal de estado é só a esquerda', () => {
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')

  // Ajuste do dono (22/08, terceira volta): a borda direita espelhada em 2px
  // de cor de estado "chapou" — o fecho da caixa é a MESMA linha fina e
  // neutra do topo e da base (1px --line); a barra COLORIDA continua sendo
  // exclusiva da esquerda, onde ela é o sinal.
  const row = css.match(/\n\.gui-subagent-row \{([\s\S]*?)\n\}/u)?.[1] ?? ''
  assert.match(row, /--row-edge:/u, 'a cor do sinal da esquerda segue com fonte única')
  assert.match(row, /border-left: 2px solid var\(--row-edge\)/u)
  assert.match(row, /border-right: 1px solid var\(--line\)/u, 'o fecho é fino e neutro')
  assert.doesNotMatch(row, /border-right: 2px/u, 'a moldura gorda espelhada foi reprovada')

  // Os estados trocam SÓ a fonte do sinal — nunca o fecho neutro.
  for (const [estado, cor] of [
    ['running', '--accent'],
    ['completed', '--ok']
  ]) {
    const regra = css.match(new RegExp(`\\.gui-subagent-row\\.${estado} \\{[^}]*\\}`, 'u'))?.[0] ?? ''
    assert.match(regra, new RegExp(`--row-edge: var\\(${cor}\\)`, 'u'), `${estado} pinta pela fonte única`)
    assert.doesNotMatch(regra, /border-right/u, `${estado} não encosta no fecho neutro`)
  }

  // O tracejado da pausa é do SINAL (esquerda); o fecho neutro fica sólido
  // como as linhas de cima e de baixo.
  const parada = css.match(/\.gui-subagent-row\.interrupted \{[^}]*\}/u)?.[0] ?? ''
  assert.match(parada, /border-left-style: dashed/u)
  assert.doesNotMatch(parada, /border-right-style/u, 'o fecho neutro não traceja')
})
