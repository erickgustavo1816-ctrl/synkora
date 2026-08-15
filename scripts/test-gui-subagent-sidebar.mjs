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
