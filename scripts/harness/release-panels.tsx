import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import DockSection from '../../src/renderer/src/components/DockSection'
import MissionStageHead from '../../src/renderer/src/components/MissionStageHead'
import ReleaseRail from '../../src/renderer/src/components/ReleaseRail'
import StageRoundStatus from '../../src/renderer/src/components/StageRoundStatus'
import MissionHeaderActions from '../../src/renderer/src/workspace/MissionHeaderActions'
import ReleaseHeaderActions from '../../src/renderer/src/workspace/ReleaseHeaderActions'
import WorkspacePanels from '../../src/renderer/src/workspace/WorkspacePanels'
import WorkspaceToolbar, { WorkspaceSidebarToggle } from '../../src/renderer/src/workspace/WorkspaceToolbar'
import { useWorkspaceLayout } from '../../src/renderer/src/workspace/useWorkspaceLayout'
import {
  WORKSPACE_PANELS, availableWorkspacePanels, type WorkspaceMissionType, type WorkspacePanelId
} from '../../src/renderer/src/workspacePanels'

// O RELEASE VESTE OS PAINÉIS DO WORKSPACE (ordem do dono, 2026-09-09: "deixa
// tudo igual — e no código também"). Harness isolado: componentes REAIS
// (cabeça do palco, menu de painéis, trilho do release, alavanca de descarte,
// as janelas do WorkspacePanels), dados sintéticos, sem IPC. A missão de dev
// fica logo abaixo, com a mesma moldura, para o olho comparar as duas.
// Servido por scripts/harness-serve.mjs (/release-panels.html → /release-panels.js).

// O trilho do release lê a ponte do preload; aqui ela é uma fotografia fixa.
const lastRelease = {
  id: 'r1', projectId: 'harness', versionId: 'v1', versionName: 'V1.0.5',
  at: '2026-08-21T17:15:00.000Z', actor: 'agente', mergeDetail: 'merge --no-ff limpo',
  push: { attempted: true, ok: true }, publishRequired: true,
  outcome: 'subiu redonda; push ok; caixa por publicar (npm run release).'
}
;(window as unknown as { synkora: unknown }).synkora = {
  backlog: { projectReleases: async () => [lastRelease], onChanged: () => () => {} }
}

function Stage({ projectId, type, title, open, actions, children }: {
  projectId: string; type: WorkspaceMissionType; title: string
  /** painéis abertos ao montar (o dono abriria pelo menu ⋮) */
  open: WorkspacePanelId[]
  actions: ReactNode
  children: ReactNode
}): React.JSX.Element {
  const boardRef = useRef<HTMLDivElement>(null)
  const controller = useWorkspaceLayout(projectId)
  const [covered, setCovered] = useState(false)
  const available = availableWorkspacePanels(type, true)
  useEffect(() => {
    for (const id of open) if (!controller.preference.panels.includes(id)) controller.openPanel(id)
    // só na montagem: é o gesto que o dono faria uma vez no menu
  }, [])
  const pills = [{ id: 'dev', label: type === 'planejamento' ? 'planejamento' : 'dev', kind: 'chat' as const, active: true, onSelect() {} }]
  return <div className="board workspace-board h-board">
    <div ref={boardRef} className="board-main stage-mode">
      <div className={`maestro-window stage-window${covered ? ' is-covered' : ''}`} inert={covered || undefined}>
        <MissionStageHead pills={pills}
          status={<StageRoundStatus status="working" startedAt={Date.now() - 27_000} />}
          seat={<span className="stage-seat"><button type="button" className="stage-seat-btn">Codex — Hotmail ▾</button></span>}
          leadingAction={<WorkspaceSidebarToggle controller={controller} sidebarId={`${projectId}-missions`} />}
          actions={<WorkspaceToolbar controller={controller} available={available} enabled visible title={title} boardRef={boardRef} actions={actions} />} />
        <div className="h-thread">
          <p><b>VOCÊ</b> · Pode subir</p>
          <p>Plano destravado. Vou subir para a main pelo release_run e conto o desfecho.</p>
        </div>
      </div>
      <WorkspacePanels controller={controller} boardRef={boardRef} projectId={projectId}
        enabled visible legacyEnabled={false} available={available} onCovered={setCovered}>
        {children}
      </WorkspacePanels>
      <aside id={`${projectId}-missions`} className={`mission-col${controller.preference.sidebarCollapsed ? ' is-collapsed' : ''}`}>
        <div className="mission-col-content"><strong>Missões</strong><span>{title}</span></div>
      </aside>
    </div>
  </div>
}

function Harness(): React.JSX.Element {
  return <div className="h-page">
    <div className="h-label"><b>release</b> · a mesma moldura: cabeça do palco · painel "Release" · descarte na cabeça (⋮ abre o menu de painéis)</div>
    <Stage projectId="harness-release" type="release" title="Subir V1.0.6 para a main" open={['release']}
      actions={<ReleaseHeaderActions mission={{ status: 'ativa', seatId: 'seat-1' }} onDiscard={() => console.log('discard')} />}>
      <ReleaseRail projectId="harness" versionName="V1.0.6" />
    </Stage>
    <div className="h-label"><b>missão de dev</b> · a referência: mesma cabeça, mesmas janelas (conteúdo sintético)</div>
    <Stage projectId="harness-mission" type="dev" title="Padronizar o painel do release" open={['trabalho', 'frota']}
      actions={<MissionHeaderActions mission={{ id: 'm1', status: 'ativa' } as never} planning={false}
        guiAvailable reviewReady testServerOpen={false}
        onIntegrate={() => {}} onTestServer={() => {}} onKillTestServer={() => {}} onReview={() => {}} onArchive={() => {}} />}>
      <div className="delivery-rail dock">
        {WORKSPACE_PANELS.map(({ id, title }) => <DockSection key={id} id={id} title={title}>
          <div className="workspace-panel-empty"><strong>{title}</strong><span>Conteúdo sintético para comparar a moldura.</span></div>
        </DockSection>)}
      </div>
    </Stage>
  </div>
}

createRoot(document.getElementById('root')!).render(<Harness />)
