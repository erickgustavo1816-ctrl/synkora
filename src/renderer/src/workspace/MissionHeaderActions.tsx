import type { Mission } from '../store'
import WorkspaceIcon from './WorkspaceIcon'

/** Presentation only: the Board retains the existing mission actions and gates. */
export default function MissionHeaderActions({ mission, planning, queueLabel, guiAvailable, reviewReady, testServerOpen,
  onIntegrate, onTestServer, onKillTestServer, onReview, onArchive, onConclude }: {
  mission: Mission; planning: boolean; queueLabel?: string; guiAvailable: boolean; reviewReady: boolean; testServerOpen: boolean
  onIntegrate: () => void; onTestServer: () => void; onKillTestServer: () => void
  onReview: () => void; onArchive: () => void; onConclude?: () => void
}): React.JSX.Element {
  const live = mission.status === 'ativa'
  const integration = mission.integration
  const uploadLabel = planning ? 'Concluir planejamento' : mission.pendingIntegrationApproval ? 'Aprovar integração'
    : integration?.state === 'sync_required' ? 'Retomar integração' : 'Subir missão'
  const uploadTip = planning ? 'Concluir esta sessão de planejamento' : integration?.lastError ?? queueLabel ?? 'Colocar esta missão na fila de integração da versão'
  const terminalLabel = testServerOpen ? 'Parar servidor de teste' : 'Abrir terminal de teste'
  const archiveLabel = mission.status === 'arquivada' ? 'Reativar missão' : 'Arquivar missão'
  return <div className="workspace-mission-actions" role="group" aria-label="Ações da missão">
    <button type="button" className={`workspace-integrate-button${mission.pendingIntegrationApproval ? ' is-pending' : ''}`}
      aria-label={uploadLabel} data-tip={uploadTip}
      disabled={!live || (planning ? !onConclude : !!integration && integration.state !== 'sync_required')}
      onClick={planning ? onConclude : onIntegrate}><WorkspaceIcon name={planning ? 'check' : 'upload'} /></button>
    <button type="button" aria-label={terminalLabel} data-tip={terminalLabel}
      className={testServerOpen ? 'is-running' : undefined} disabled={!live || planning}
      onClick={testServerOpen ? onKillTestServer : onTestServer}><WorkspaceIcon name="terminal" /></button>
    <button type="button" aria-label="Solicitar revisão" disabled={!live || planning || !guiAvailable || !reviewReady}
      data-tip={reviewReady ? 'Pedir uma revisão ao agente da missão' : 'Abra a conversa do agente para solicitar uma revisão'}
      onClick={onReview}><WorkspaceIcon name="review" /></button>
    <button type="button" aria-label={archiveLabel} data-tip={archiveLabel} disabled={!live && mission.status !== 'arquivada'}
      onClick={onArchive}><WorkspaceIcon name="archive" /></button>
  </div>
}
