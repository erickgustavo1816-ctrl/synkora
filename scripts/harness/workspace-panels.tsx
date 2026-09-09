import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import DockSection from '../../src/renderer/src/components/DockSection'
import WorkspacePanels from '../../src/renderer/src/workspace/WorkspacePanels'
import { useWorkspaceLayout } from '../../src/renderer/src/workspace/useWorkspaceLayout'
import { WORKSPACE_PANELS, availableWorkspacePanels } from '../../src/renderer/src/workspacePanels'

// Isolated renderer fixture: real panels and styles, synthetic content, no IPC.
function Harness() {
  const boardRef = useRef<HTMLDivElement>(null)
  const controller = useWorkspaceLayout('synthetic-panel-layout')
  const [covered, setCovered] = useState(false)
  Object.assign(window, { workspaceHarness: controller })
  return <div className="board workspace-board" style={{ height: '100%' }}>
    <div ref={boardRef} className="board-main stage-mode">
      <div className={`maestro-window stage-window${covered ? ' is-covered' : ''}`} inert={covered || undefined}>
        <header className="stage-head"><span>Missão de teste</span></header>
        <div style={{ padding: 20, flex: 1 }}>
          <p>Conversa de exemplo</p><p>O chat conserva seu espaço enquanto os painéis são reorganizados.</p>
        </div>
        <div style={{ margin: 12, padding: 14, border: '1px solid var(--line-strong)', borderRadius: 8 }}>Escreva uma mensagem…</div>
      </div>
      <WorkspacePanels controller={controller} boardRef={boardRef} projectId="synthetic-panel-layout"
        enabled visible legacyEnabled={false} available={availableWorkspacePanels(false, true)} onCovered={setCovered}>
        <div className="delivery-rail dock">
          {WORKSPACE_PANELS.map(({ id, title }) => <DockSection key={id} id={id} title={title}>
            {id === 'browser' ? <div className="dock-browser">
              <div className="dock-browser-nav"><span>← → ↻</span><span>abrir um endereço</span></div>
              <div className="workspace-panel-empty" style={{ background: 'var(--panel)', color: 'var(--panel-ink)', height: '100%' }}>
                <strong>Nenhuma página aberta nesta missão</strong><span>Browser de exemplo</span>
              </div>
            </div> : <div className="workspace-panel-empty"><strong>{title}</strong><span>Conteúdo sintético para verificar a disposição dos painéis.</span></div>}
          </DockSection>)}
        </div>
      </WorkspacePanels>
      <aside className={`mission-col${controller.preference.sidebarCollapsed ? ' is-collapsed' : ''}`}>
        <div className="mission-col-content"><strong>Missões</strong><span>Exemplo local</span></div>
      </aside>
    </div>
  </div>
}

createRoot(document.getElementById('root')!).render(<Harness />)
