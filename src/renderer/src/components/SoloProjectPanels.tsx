import { useMemo } from 'react'
import { useWorkspaceActivity } from '../workspace/useWorkspaceActivity'
import { guiSubagentSidebarEntries } from '../guiSubagentSidebar'
import type { GuiItem } from '../store'
import DockSection from './DockSection'
import DockBrowser, { useMissionBrowser } from './DockBrowser'
import GuiSubagentSidebar, { frotaSectionSummary } from './GuiSubagentSidebar'

// OS PAINÉIS DA MISSÃO SEM VERSIONAMENTO (2026-09-30): Browser e Frota — o
// Mobile entra pelo próprio DockMobile. Nada aqui mede a pasta: sem base, sem
// commit e sem diff, o trilho de entrega da missão versionada (e o poll de 15s
// que ele faz no worktree) não tem o que dizer neste modo. Os painéis vestem a
// MESMA moldura do workspace (DockSection → WorkspacePanel).

export default function SoloProjectPanels({
  missionId,
  projectId,
  live,
  subagentItems,
  visible
}: {
  missionId: string
  projectId: string
  /** missão aberta: o motor fecha o browser junto com a missão */
  live: boolean
  /** o fio do agente — a Frota deriva das fichas dos ajudantes nele */
  subagentItems: readonly GuiItem[]
  /** a tela da missão está à vista do dono */
  visible: boolean
}): React.JSX.Element {
  const browser = useMissionBrowser(missionId)
  const frota = useMemo(() => guiSubagentSidebarEntries(subagentItems), [subagentItems])
  // Browser que abre sozinho e ajudante que nasce trazem o painel para a
  // frente — a mesma régua da missão versionada, sem a medida do worktree.
  useWorkspaceActivity(missionId, {
    browser: browser.loaded ? browser.state : null,
    helpers: frota,
    workspace: null
  }, live)

  return (
    <>
      {live && (
        <DockSection id="browser" title="browser" summary={browser.summary}>
          <DockBrowser
            missionId={missionId}
            projectId={projectId}
            state={browser.state}
            engine={browser.engine}
            error={browser.error}
            visible={visible}
          />
        </DockSection>
      )}
      <DockSection id="frota" title="frota" summary={frotaSectionSummary(frota)}>
        {frota.length > 0 ? <GuiSubagentSidebar items={subagentItems} /> : (
          <div className="workspace-panel-empty">Nenhum ajudante nesta missão ainda.<span>Quando o agente delegar uma tarefa, você acompanha por aqui.</span></div>
        )}
      </DockSection>
    </>
  )
}
