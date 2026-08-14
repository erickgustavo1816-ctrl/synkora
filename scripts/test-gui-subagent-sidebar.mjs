import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  guiSubagentMetadataForTool,
  normalizeGuiSubagentSidebar
} from '../src/renderer/src/guiSubagentSidebar.ts'

function tool(id, name, summary, extra = {}) {
  return { id: `item-${id}`, kind: 'tool', name, summary, at: Number(id), ...extra }
}

function result(text, status = 'completed', isError = false) {
  return { text, isError, status, lineCount: 1, truncated: false }
}

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

  assert.deepEqual(entries.map((entry) => entry.toolUseId), ['parent-a', 'parent-b'])
  assert.equal(entries[0].name, 'Luna Front')
  assert.equal(entries[0].model, 'gpt-5.6-luna')
  assert.equal(entries[0].task, 'investigue o fluxo A')
  assert.equal(entries[0].activity, 'Edit · arquivo que está sendo corrigido')
  assert.equal(entries[0].status, 'running')
  assert.equal(entries[1].name, 'backend')
  assert.equal(entries[1].model, 'modelo não informado')
  assert.equal(entries[1].status, 'completed')
  assert.equal(entries[1].outcome, 'B terminou')
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

test('status terminal diferencia falha, negação e cancelamento', () => {
  const entries = normalizeGuiSubagentSidebar([
    {
      ...tool('1', 'Task', 'falha'),
      toolUseId: 'failed',
      subagent: guiSubagentMetadataForTool('Task', { prompt: 'falha' }),
      result: result('erro real', 'failed', true)
    },
    {
      ...tool('2', 'Task', 'negado'),
      toolUseId: 'denied',
      subagent: guiSubagentMetadataForTool('Task', { prompt: 'negado' }),
      result: result('', 'denied')
    },
    {
      ...tool('3', 'Task', 'cancelado'),
      toolUseId: 'cancelled',
      subagent: guiSubagentMetadataForTool('Task', { prompt: 'cancelado' }),
      result: result('', 'cancelled')
    }
  ])
  assert.deepEqual(entries.map((entry) => entry.status), ['failed', 'denied', 'cancelled'])
  assert.equal(entries[0].outcome, 'erro real')
  assert.equal(entries[1].outcome, null)
  assert.equal(entries[2].outcome, null)
})

test('superfície da seção tem nome acessível e campos pedidos', () => {
  const source = readFileSync(
    new URL('../src/renderer/src/components/GuiSubagentSidebar.tsx', import.meta.url),
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
})
