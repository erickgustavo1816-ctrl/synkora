/// <reference types="vite/client" />
/// <reference path="../../src/preload/index.d.ts" />
import { createRoot } from 'react-dom/client'
import GuiPane from '../../src/renderer/src/components/GuiPane'
import { installDevMock } from '../../src/renderer/src/devMock'
import { useStore } from '../../src/renderer/src/store'
import type { GuiSessionEvent } from '../../src/renderer/src/guiApi'

installDevMock()
const paneId = 'gui-synthetic-recovery'
const scenario = new URLSearchParams(window.location.search).get('scenario') ?? 'failed'
const ready: GuiSessionEvent = { type: 'ready', caps: { models: [{ value: 'gpt-6.1-sol',
  displayName: 'GPT-6.1 Sol', supportedEffortLevels: ['high'] }], commands: [] } }
const events: GuiSessionEvent[] = [ready,
  { type: 'session-id', sessionId: 'codex-thread:synthetic-conversation' },
  { type: 'executor-changed', model: 'gpt-6.1-sol', effort: 'high' },
  { type: 'user-message', id: 'synthetic-owner-request', text: 'Confira por que a missão não pode ser excluída.', at: Date.now() },
  { type: 'turn-started' },
  { type: 'tool', name: 'Read', toolUseId: 'synthetic-completed-tool', input: { file_path: 'src/main/missionLifecycle.ts' } },
  { type: 'tool-result', toolUseId: 'synthetic-completed-tool', text: 'Recibo sintético: leitura concluída.', isError: false, outcome: 'completed' },
  { type: 'text', text: 'Encontrei alterações locais na missão. Vou conferir a proteção de exclusão.' },
  scenario === 'retrying'
    ? { type: 'turn-retry', turnId: 'synthetic-turn', text: 'O serviço interrompeu a resposta e está tentando novamente.' }
    : { type: 'result', turnId: 'synthetic-turn', isError: true, outcome: 'failed',
      recoveryToken: 'synthetic-recovery-token', errorText: 'Selected model is at capacity. Please try a different model.' }
]
window.synkora.gui.state = async () => ({ exists: true, alive: true, cursor: events.length,
  events: events.map((evt, index) => ({ seq: index + 1, evt })) })
const calls: string[][] = []
window.synkora.gui.resumeFailedTurn = async (id, token) => {
  calls.push([id, token])
  await new Promise(resolve => setTimeout(resolve, 900))
  if (scenario === 'refused') return { ok: false, error: 'A conversa ainda está trabalhando. Aguarde antes de retomar.' }
  if (scenario === 'transport') throw new Error('Synthetic private transport details')
  const push = (evt: GuiSessionEvent): void => useStore.getState().handleGuiLive(paneId, evt)
  push({ type: 'turn-started' })
  setTimeout(() => {
    push({ type: 'text', text: 'Retomei a verificação a partir do histórico e do trabalho já concluído.' })
    push({ type: 'result', turnId: 'synthetic-recovered-turn', isError: false, outcome: 'completed' })
  }, 350)
  return { ok: true }
}
;(window as unknown as { turnRecoveryFixture: unknown }).turnRecoveryFixture = {
  snapshot: () => {
    const pane = useStore.getState().guiPanes[paneId]
    return { calls, model: pane?.executorModel, sessionId: pane?.sessionId,
      userMessages: pane?.items.filter(item => item.kind === 'user').length,
      tools: pane?.items.filter(item => item.kind === 'tool').map(item => item.result?.status) }
  }
}
createRoot(document.getElementById('root')!).render(
  <div className="fixture-chat">
    <GuiPane paneId={paneId} projectId="synthetic" cli="codex" configDir="synthetic"
      cwd="synthetic" model="gpt-6.1-sol" effort="high" permissionMode="default" showHeader={false} />
  </div>
)
