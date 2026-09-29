/// <reference types="vite/client" />
/// <reference path="../../src/preload/index.d.ts" />
import { createRoot } from 'react-dom/client'
import type { Mission } from '../../src/preload/index'
import type { MissionRemovalConfirmation, MissionRemovalResult } from '../../src/shared/missionRemoval'
import BacklogView from '../../src/renderer/src/components/BacklogView'
import { installDevMock } from '../../src/renderer/src/devMock'
import { useStore } from '../../src/renderer/src/store'

installDevMock()
const scenario = new URLSearchParams(window.location.search).get('scenario') ?? 'refused'
const projectId = 'synthetic-project'
const title = new URLSearchParams(window.location.search).has('long-title')
  ? 'Missão sintética 📄 中文 — ' + 'alterações locais para revisão '.repeat(8)
  : 'Missão sintética'
let missions: Mission[] = [{
  id: 'synthetic-mission', projectId, title, status: 'arquivada', direct: true,
  branch: 'mission/synthetic', createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z'
}]
const requests: Readonly<{ id: string; confirmation?: Readonly<MissionRemovalConfirmation> }>[] = []
Object.defineProperty(window, 'missionRemovalFixture', {
  value: Object.freeze({ scenario, snapshot: () => Object.freeze([...requests]) }),
  writable: false,
  configurable: false
})
let receipt = { token: 'synthetic-discard-receipt-1', title }
let discardAttempts = 0
let removalRefused = false
let refreshFailed = false
const dirtyRefusal = (): MissionRemovalResult => ({
  ok: false,
  error: 'A pasta da missão contém alterações locais. Para excluí-la, confirme o descarte dessas alterações abaixo.',
  discard: { ...receipt }
})
window.synkora.backlog.listVersions = async () => []
window.synkora.backlog.listItems = async () => []
window.synkora.backlog.manifestVersion = async () => null
window.synkora.missions.list = async () => {
  if (refreshFailed) throw new Error('Synthetic refresh failure')
  return missions
}
window.synkora.missions.remove = async (id, confirmation): Promise<MissionRemovalResult> => {
  requests.push(Object.freeze({ id, ...(confirmation ? { confirmation: Object.freeze({ ...confirmation }) } : {}) }))
  await new Promise(resolve => setTimeout(resolve, 900))
  if (scenario === 'transport') throw new Error('Synthetic transport failure')
  if (scenario === 'success') { missions = []; return { ok: true } }
  if (scenario === 'refused') {
    return { ok: false, error: 'A pasta da missão contém alterações locais. Reative a missão e peça ao agente para salvar ou revisar essas alterações antes de excluir.' }
  }
  if (removalRefused) {
    return { ok: false, error: 'Há uma integração pendente. Abra o chat da missão para resolver antes de excluir.' }
  }
  if (!confirmation) return dirtyRefusal()
  if (confirmation.discardToken !== receipt.token || confirmation.confirmTitle !== receipt.title) {
    return { ...dirtyRefusal(), ok: false, error: 'A confirmação mudou. Confira as alterações e confirme novamente.' }
  }
  discardAttempts += 1
  if (scenario === 'discard-transport') {
    receipt = { ...receipt, token: `synthetic-discard-receipt-${discardAttempts + 1}` }
    throw new Error('Synthetic uncertain discard transport failure')
  }
  if (scenario === 'discard-refusal') {
    removalRefused = true
    return { ok: false, error: 'Há uma integração pendente. Abra o chat da missão para resolver antes de excluir.' }
  }
  if (scenario === 'discard-stale' && discardAttempts === 1) {
    receipt = { ...receipt, token: 'synthetic-discard-receipt-2' }
    return { ok: false, error: 'As alterações da missão mudaram. Confira e confirme novamente.', discard: { ...receipt } }
  }
  if (scenario === 'dirty') return dirtyRefusal()
  missions = []
  refreshFailed = scenario === 'refresh-transport'
  return { ok: true }
}
useStore.setState({ missions, openProjectId: projectId, projects: [], homeStats: {} })
createRoot(document.getElementById('root')!).render(<BacklogView projectId={projectId} />)
