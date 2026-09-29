/// <reference types="vite/client" />
/// <reference path="../../src/preload/index.d.ts" />
import { createRoot } from 'react-dom/client'
import type { Mission } from '../../src/preload/index'
import BacklogView from '../../src/renderer/src/components/BacklogView'
import { installDevMock } from '../../src/renderer/src/devMock'
import { useStore } from '../../src/renderer/src/store'

installDevMock()
const scenario = new URLSearchParams(window.location.search).get('scenario') ?? 'refused'
const projectId = 'synthetic-project'
let missions: Mission[] = [{
  id: 'synthetic-mission', projectId, title: 'Missão sintética', status: 'arquivada', direct: true,
  branch: 'mission/synthetic', createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z'
}]
window.synkora.backlog.listVersions = async () => []
window.synkora.backlog.listItems = async () => []
window.synkora.backlog.manifestVersion = async () => null
window.synkora.missions.list = async () => missions
window.synkora.missions.remove = async () => {
  await new Promise(resolve => setTimeout(resolve, 900))
  if (scenario === 'transport') throw new Error('Synthetic transport failure')
  if (scenario === 'success') { missions = []; return { ok: true } }
  return { ok: false, error: 'A pasta da missão contém alterações locais. Reative a missão e peça ao agente para salvar ou revisar essas alterações antes de excluir.' }
}
useStore.setState({ missions, openProjectId: projectId, projects: [], homeStats: {} })
createRoot(document.getElementById('root')!).render(<BacklogView projectId={projectId} />)
