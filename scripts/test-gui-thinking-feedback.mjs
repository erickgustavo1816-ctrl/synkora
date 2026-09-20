import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { guiThinkingPresentation } from '../src/renderer/src/guiThinkingPresentation.ts'
import { guiPublicSilenceSince, guiWorkTarget } from '../src/renderer/src/guiWorkProgress.ts'
import {
  GUI_PULSE_QUIET_MS,
  GUI_PULSE_STALLED_MS,
  guiAgentPulsePresentation,
  guiPulseTrail,
  guiPulseVerbFor
} from '../src/renderer/src/guiAgentPulse.ts'

const base = {
  status: 'working',
  stream: '',
  activeAssistantId: null,
  thinking: false,
  activityText: null,
  awaitingInteraction: false
}

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('feedback aparece imediatamente sem expor texto interno de raciocínio', () => {
  assert.deepEqual(guiThinkingPresentation(base), {
    label: 'o agente está preparando a resposta',
    phase: 'preparing'
  })
  assert.deepEqual(guiThinkingPresentation({ ...base, thinking: true }), {
    label: 'o agente está pensando',
    phase: 'thinking'
  })
  assert.doesNotMatch(source('../src/renderer/src/components/GuiPane.tsx'), /thinkingText:\s*gui\.thinkingText/u)
  assert.doesNotMatch(source('../src/renderer/src/components/GuiAgentPulse.tsx'), /thinkingText/u)
})

test('feedback continua visível enquanto uma ferramenta ainda espera resultado', () => {
  assert.deepEqual(guiThinkingPresentation({ ...base, activityText: 'Bash · tarefa sintética' }), {
    label: 'aguardando retorno da ferramenta',
    phase: 'tool'
  })
  assert.deepEqual(guiThinkingPresentation({ ...base, thinking: true, activityText: 'Bash' }), {
    label: 'o agente está pensando',
    phase: 'thinking'
  })
})

test('feedback acompanha resposta parcial e novas fases mesmo depois de texto do agente', () => {
  const responding = { ...base, turnActive: true, stream: 'resposta parcial', activeAssistantId: 'assistant-1' }
  assert.equal(guiThinkingPresentation(responding).phase, 'responding')
  assert.equal(guiThinkingPresentation({ ...responding, thinking: true }).phase, 'thinking')
  assert.equal(guiThinkingPresentation({ ...responding, activityText: 'Read' }).phase, 'tool')
  assert.equal(guiThinkingPresentation({ ...responding, stream: '' }).phase, 'responding')
})

test('feedback nunca sobrevive a interação, fim do pai ou terminal', () => {
  for (const input of [
    { ...base, turnActive: false },
    { ...base, turnActive: false, thinking: true, stream: 'resposta', activeAssistantId: 'assistant-1' },
    { ...base, awaitingInteraction: true },
    { ...base, status: 'idle' },
    { ...base, status: 'waiting-you' },
    { ...base, status: 'dead' }
  ]) {
    assert.equal(guiThinkingPresentation(input), null)
    assert.equal(pulseOf(input, { publicSilenceSince: 1, now: 900_000 }), null)
  }
})

/** O componente faz exatamente isto: a fase de `guiThinkingPresentation` entra no pulso. */
const pulseOf = (state, extra = {}) =>
  guiAgentPulsePresentation({
    phase: guiThinkingPresentation(state)?.phase ?? null,
    items: [],
    now: 0,
    ...extra
  })

test('o pulso fica fora do transcript e anuncia o estado com gesto, verbo e relógio', () => {
  const pane = source('../src/renderer/src/components/GuiPane.tsx')
  const pulse = source('../src/renderer/src/components/GuiAgentPulse.tsx')
  const css = source('../src/renderer/src/components/GuiAgentPulse.css')
  assert.match(pane, /<GuiAgentPulse\b/u)
  assert.doesNotMatch(pane, /className="gui-thinking"/u, 'o indicador antigo morreu com o pulso')
  assert.match(pulse, /role="status"/u)
  assert.match(pulse, /className="gui-pulse-clock" aria-hidden="true"/u, 'o relógio não é narrado a cada segundo')
  assert.match(pulse, /guiThinkingPresentation\(phaseInput\)\?\.phase/u, 'a fase do turno é a de sempre')
  assert.doesNotMatch(pulse, /pushGuiItem/u)
  // Um GESTO por ação (ordem do dono, 2026-09-16) e repouso legível sem movimento.
  for (const action of ['thinking', 'reading', 'editing', 'running', 'searching', 'responding',
    'compacting', 'browsing', 'skill', 'helpers', 'integrating', 'waiting'])
    assert.match(css, new RegExp(`\\[data-action='${action}'\\]`, 'u'), `${action} tem gesto próprio`)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.gui-pulse-glyph i\s*\{\s*animation: none/su)
  assert.match(source('../src/renderer/src/global.css'),
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.gui-dots i\s*\{\s*animation: none/su)
})

test('silêncio público continua durante pensamento e ferramentas, e reinicia apenas com fala', () => {
  let since = guiPublicSilenceSince(null, { type: 'turn-started' }, 1000, false)
  assert.equal(since, 1000)
  for (const event of [
    { type: 'thinking', text: 'SYNTHETIC_PRIVATE_REASONING' },
    { type: 'tool', name: 'Read', input: {}, toolUseId: 'read' },
    { type: 'tool-result', toolUseId: 'read', text: 'synthetic output', isError: false },
    { type: 'command-output', text: 'system notice' },
    { type: 'delta', text: ' ' },
    { type: 'turn-started' }
  ]) since = guiPublicSilenceSince(since, event, 100_000, true)
  assert.equal(since, 1000)
  assert.equal(guiPublicSilenceSince(since, { type: 'delta', text: 'Andamento público.' }, 101_000, true), 101_000)
  assert.equal(guiPublicSilenceSince(since, { type: 'text', text: 'Andamento público.' }, 102_000, true), 102_000)
  assert.equal(guiPublicSilenceSince(since, { type: 'turn-started' }, 103_000, false), 103_000)
})

test('encerramento, retomada e espera humana delimitam o relógio de silêncio', () => {
  for (const type of ['result', 'closed', 'fatal', 'session-restarted', 'conversation-cleared', 'permission', 'question', 'plan-review']) {
    assert.equal(guiPublicSilenceSince(1000, { type }, 100_000, true), null, type)
  }
  assert.equal(guiPublicSilenceSince(1000, { type: 'result', continues: true, turnActive: false }, 100_000, true), null)
  assert.equal(guiPublicSilenceSince(1000, { type: 'question', blocking: false }, 100_000, true), 1000)
  assert.equal(guiPublicSilenceSince(null, { type: 'tool', name: 'Read', parentToolUseId: 'child' }, 100_000, false), null)
})

test('o relógio e a forma do pulso seguem o silêncio público: 2 s, 1 min, 3 min', () => {
  const thinking = { ...base, thinking: true }
  const at = now => pulseOf(thinking, { publicSilenceSince: 1000, now })
  assert.deepEqual(at(2_999), { action: 'thinking', verb: 'pensando', tier: 'live' })
  assert.deepEqual(at(3_000).clock, { kind: 'since', ms: 2_000 })
  assert.equal(at(1000 + GUI_PULSE_QUIET_MS - 1).tier, 'live')
  const quiet = at(1000 + GUI_PULSE_QUIET_MS)
  assert.equal(quiet.tier, 'quiet')
  assert.deepEqual(quiet.clock, { kind: 'silence', ms: GUI_PULSE_QUIET_MS })
  assert.equal(quiet.hint, undefined)
  const stalled = at(1000 + GUI_PULSE_STALLED_MS + 20_000)
  assert.equal(stalled.tier, 'stalled')
  assert.deepEqual(stalled.clock, { kind: 'silence', ms: GUI_PULSE_STALLED_MS + 20_000 })
  assert.match(stalled.hint, /■ interrompe/u)
  assert.equal(pulseOf({ ...thinking, status: 'idle' }, { publicSilenceSince: 1000, now: 500_000 }), null)
  assert.equal(pulseOf(thinking, { publicSilenceSince: null, now: 500_000 }).clock, undefined)
  // respondendo e compactando não têm relógio: o texto (ou a compactação) já é o sinal
  assert.deepEqual(
    pulseOf({ ...base, stream: 'x', activeAssistantId: 'a' }, { publicSilenceSince: 1000, now: 500_000 }),
    { action: 'responding', verb: 'respondendo', tier: 'live' }
  )
  assert.deepEqual(pulseOf({ ...thinking, contextCompacting: true }, { publicSilenceSince: 1000, now: 500_000 }), {
    action: 'compacting', verb: 'compactando contexto', tier: 'live'
  })
})

test('o verbo e o gesto vêm do TIPO da ferramenta; o alvo só do campo de arquivo', () => {
  const tool = { id: 'read', kind: 'tool', name: 'Read', summary: 'synthetic-secret-command',
    progressTarget: 'src/example.ts', at: 1 }
  const pulse = (items, state = base) => pulseOf(state, { items, now: 5_000, publicSilenceSince: 1000 })
  const since4 = { kind: 'since', ms: 4_000 }
  // ferramenta pendente é o fato mais forte: é ELA que está acontecendo
  assert.deepEqual(pulse([tool]), { action: 'reading', verb: 'lendo', target: 'src/example.ts', tier: 'live', clock: since4 })
  assert.equal(pulse([tool], { ...base, thinking: true }).verb, 'lendo')
  // ferramenta concluída vira o rastro do pensamento
  const done = { ...tool, result: { isError: false } }
  assert.deepEqual(pulseOf({ ...base, thinking: true }, { items: [done], now: 5_000 }), {
    action: 'thinking', verb: 'pensando', trail: '— leu src/example.ts', tier: 'live'
  })
  assert.equal(pulseOf(base, { items: [done], now: 5_000 }).verb, 'preparando a resposta')
  for (const [result, trail] of [
    [{ isError: true }, '— falhou ao ler src/example.ts'],
    [{ isError: false, status: 'interrupted' }, '— lendo src/example.ts · interrompido'],
    [{ isError: false, status: 'cancelled' }, '— lendo src/example.ts · cancelado'],
    [{ isError: false, status: 'denied' }, '— lendo src/example.ts · não autorizado'],
    [{ isError: false, provisional: true }, '— lendo src/example.ts · sem resultado confirmado']
  ]) assert.equal(pulseOf(base, { items: [{ ...tool, result }], now: 5_000 }).trail, trail)
  // comando: NUNCA o texto do comando — só o verbo
  const command = { ...tool, id: 'cmd', name: 'Bash', progressTarget: undefined }
  assert.deepEqual(pulse([command]), { action: 'running', verb: 'rodando um comando', tier: 'live', clock: since4 })
  assert.equal(pulseOf(base, { items: [{ ...command, result: { isError: true } }], now: 5_000 }).trail, '— o comando falhou')
  // ferramenta genérica mostra o nome; ajudantes e fala pública não contam
  assert.deepEqual(pulse([{ ...command, name: 'WebFetch' }]),
    { action: 'waiting', verb: 'usando', target: 'WebFetch', tier: 'live', clock: since4 })
  const later = { ...command, result: { isError: false } }
  const child = { ...later, id: 'child', result: undefined, parentToolUseId: 'child' }
  const speech = { ...later, id: 'speech', name: 'mcp__synkora__commentary' }
  assert.equal(pulseOf(base, { items: [later, child, speech], now: 5_000 }).trail, '— rodou um comando')
  assert.doesNotMatch(JSON.stringify(pulse([tool, later, child, speech])), /synthetic-secret-command/u)
  // a ferramenta pendente saiu da janela, mas o backend ainda diz que há uma
  assert.deepEqual(pulseOf({ ...base, activityText: 'Bash' }),
    { action: 'waiting', verb: 'esperando a ferramenta', tier: 'live' })
  // os gestos do mockup: cada família tem o seu
  assert.equal(guiPulseVerbFor('mcp__synkora__browser_open').action, 'browsing')
  assert.equal(guiPulseVerbFor('Skill').action, 'skill')
  assert.equal(guiPulseVerbFor('mcp__synkora__integration_run').action, 'integrating')
  assert.equal(guiPulseVerbFor('mcp__synkora__helper_result').action, 'helpers')
  assert.equal(guiPulseVerbFor('apply_patch').action, 'editing')
  assert.equal(guiPulseVerbFor('PowerShell').action, 'running')
  assert.equal(guiPulseVerbFor('Grep').action, 'searching')
  assert.equal(guiPulseTrail({ ...tool, name: 'Edit', result: { isError: false } }), 'editou src/example.ts')
})

test('arquivo vem somente de campo explícito e não expõe comando ou caminho absoluto', () => {
  assert.equal(guiWorkTarget('Read', { file_path: 'C:\\synthetic-user\\project\\src\\example.ts' }), 'src/example.ts')
  assert.equal(guiWorkTarget('Bash', { command: 'synthetic-secret', path: 'secret' }), undefined)
  assert.equal(guiWorkTarget('Read', { command: 'synthetic-secret' }), undefined)
  assert.equal(guiWorkTarget('Read', { file_path: 'invalid\nsynthetic' }), undefined)
  assert.equal(guiWorkTarget('apply_patch', {}, 'src/edited.ts'), 'src/edited.ts')
})
