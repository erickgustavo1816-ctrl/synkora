import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { guiThinkingPresentation } from '../src/renderer/src/guiThinkingPresentation.ts'

const base = {
  status: 'working',
  stream: '',
  activeAssistantId: null,
  thinking: false,
  activityText: null,
  awaitingInteraction: false
}

test('feedback aparece imediatamente sem expor texto interno de raciocínio', () => {
  assert.deepEqual(guiThinkingPresentation(base), {
    label: 'o agente está preparando a resposta'
  })
  assert.deepEqual(
    guiThinkingPresentation({ ...base, thinking: true }),
    { label: 'o agente está pensando' }
  )
  assert.doesNotMatch(
    readFileSync(
      new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
      'utf8'
    ),
    /thinkingText:\s*gui\.thinkingText/u
  )
})

test('feedback nunca sobrevive a resposta, ferramenta, interação ou terminal', () => {
  for (const input of [
    { ...base, stream: 'resposta' },
    { ...base, activeAssistantId: 'assistant-1' },
    { ...base, activityText: 'Read · src/app.ts' },
    { ...base, awaitingInteraction: true },
    { ...base, status: 'idle' },
    { ...base, status: 'waiting-you' },
    { ...base, status: 'dead' }
  ]) {
    assert.equal(guiThinkingPresentation(input), null)
  }
})

test('o marcador fica fora do transcript e anuncia somente o estado, sem cronômetro', () => {
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')
  assert.match(pane, /guiThinkingPresentation\(/u)
  assert.match(pane, /className="gui-thinking" role="status"/u)
  assert.match(pane, /\{thinkingPresentation\.label\}/u)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.gui-dots i\s*\{\s*animation: none/su)
  assert.doesNotMatch(pane, /guiThinkingPresentation[\s\S]*?items:\s*pushGuiItem/u)
})
