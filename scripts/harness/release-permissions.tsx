import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import GuiPane from '../../src/renderer/src/components/GuiPane'
import { installDevMock } from '../../src/renderer/src/devMock'
import type { GuiPaneSpawn, GuiPermissionMode } from '../../src/renderer/src/guiApi'
import { useStore, type MissionType } from '../../src/renderer/src/store'

const scenarios: Record<string, {
  label: string; missionType: MissionType; saved: GuiPermissionMode; live?: boolean; working?: boolean
}> = {
  saved: { label: 'Release · plano salvo', missionType: 'release', saved: 'plan' },
  default: { label: 'Release · padrão', missionType: 'release', saved: 'default' },
  edits: { label: 'Release · edições', missionType: 'release', saved: 'acceptEdits' },
  full: { label: 'Release · acesso completo', missionType: 'release', saved: 'bypass' },
  dev: { label: 'Dev · plano', missionType: 'dev', saved: 'plan' },
  planning: { label: 'Planejamento · plano', missionType: 'planejamento', saved: 'plan' },
  live: { label: 'Release · sessão viva em plano', missionType: 'release', saved: 'default', live: true },
  working: { label: 'Release · turno ativo em plano', missionType: 'release', saved: 'default', live: true, working: true }
}
const query = new URLSearchParams(window.location.search)
const scenarioKey = query.get('scenario') ?? 'saved'
const scenario = scenarios[scenarioKey] ?? scenarios.saved
const cli = query.get('cli') === 'claude' ? 'claude' : 'codex'
const paneId = `gui-dev-synthetic-${scenarioKey}`
const caps = { commands: [], models: [{ value: 'default', displayName: 'Padrão', supportsFastMode: true }] }
const fixture = { spawns: [] as GuiPaneSpawn[], selections: [] as GuiPermissionMode[] }
Object.assign(window, { releasePermissionsHarness: fixture })

installDevMock()
window.synkora.gui.state = async () => {
  const last = fixture.spawns.at(-1)
  const alive = scenario.live || Boolean(last)
  return {
    exists: alive, alive, cursor: !alive ? 0 : scenario.working && !last ? 2 : 1,
    permissionMode: last?.permissionMode ?? (scenario.live ? 'plan' : undefined),
    events: alive ? [{ seq: 1, evt: { type: 'ready', caps } },
      ...(scenario.working && !last ? [{ seq: 2, evt: { type: 'turn-started' } }] : [])] : []
  }
}
window.synkora.gui.create = async spawn => {
  fixture.spawns.push(spawn)
  useStore.getState().handleGuiLive(paneId, { type: 'ready', caps })
  return { ok: true }
}

function Harness(): React.JSX.Element {
  const [permissionMode, setPermissionMode] = useState(scenario.saved)
  const [fast, setFast] = useState(false)
  const [mountKey, setMountKey] = useState(0)
  return <>
    <div className="h-controls">
      <label>Cenário <select aria-label="Cenário" value={scenarioKey} onChange={event => {
        window.location.search = new URLSearchParams({ scenario: event.target.value, cli }).toString()
      }}>
        {Object.entries(scenarios).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
      </select></label>
      <label>CLI <select aria-label="CLI" value={cli} onChange={event => {
        window.location.search = new URLSearchParams({ scenario: scenarioKey, cli: event.target.value }).toString()
      }}><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
      <button type="button" onClick={() => setMountKey(value => value + 1)}>Remontar chat</button>
      <span>Dados sintéticos · GuiPane real</span>
    </div>
    <div className="h-chat">
      <GuiPane key={mountKey} paneId={paneId} projectId="synthetic" cli={cli}
        configDir="synthetic-config" cwd="synthetic-workspace" role="agente"
        missionType={scenario.missionType} permissionMode={permissionMode} fast={fast}
        resumeSessionId="synthetic-resume" active onFastMode={setFast}
        onPermissionMode={next => { fixture.selections.push(next); setPermissionMode(next) }} />
    </div>
  </>
}

createRoot(document.getElementById('root')!).render(<Harness />)
