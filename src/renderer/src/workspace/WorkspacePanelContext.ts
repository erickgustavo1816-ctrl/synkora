import { createContext } from 'react'
import type { WorkspacePanelId } from '../workspacePanels'
import type { WorkspaceController } from './useWorkspaceLayout'
import type { WorkspacePanelDrag } from './useWorkspacePanelDrag'

export const WorkspacePanelContext = createContext<{
  controller: WorkspaceController
  panels: WorkspacePanelId[]
  columns: WorkspacePanelId[][]
  maximized: WorkspacePanelId | null
  visible: boolean
  projectId: string
  rowSplits: number[]
  drag: WorkspacePanelDrag
  returnFocus: () => void
  fitPanel: (id: WorkspacePanelId) => void
} | null>(null)

/** The native browser must obey its window's visibility, not just the Board. */
export const WorkspacePanelVisibility = createContext(true)
