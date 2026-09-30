import { useCallback, useEffect, useMemo, useState } from 'react'
import FilesView from './FilesView'
import GuiPanelErrorBoundary from './GuiPanelErrorBoundary'
import SoloProjectStart from './SoloProjectStart'
import SoloProjectReading from './SoloProjectReading'
import SoloProjectMission from './SoloProjectMission'
import UnversionedFolderSeal, { UnversionedModeTag } from './UnversionedFolderSeal'
import WorkspaceIcon from '../workspace/WorkspaceIcon'
import { useMissionChatSlots } from '../useMissionChatSlots'
import { soloHistory, soloHistoryRow, soloProjectView, soloUniverseTab } from '../soloProjectModel'
import { projectNameWithMode } from '../unversionedPresentation'
import { folderName, hueOf, initialsOf, plainIpcError } from '../util'
import { useStore, type Project } from '../store'
import './SoloProject.css'

// O UNIVERSO SEM VERSIONAMENTO (2026-09-30) — desenhado do zero, não remendo
// do Board. Mockup aprovado: docs/mockups/projeto-sem-versao-2026-09-30.html.
//
// O cabeçalho perde os chips ◈/fila e as abas Mapa e Versões: ficam MISSÃO e
// ARQUIVOS (o FilesView de sempre, com raiz na pasta). A marca do modo é o
// SELO DE PASTA no avatar, sempre com o selo textual ao lado.
//
// A aba Missão tem três vistas, decididas por `soloProjectView`: a missão
// aberta ocupa a tela inteira; sem ela, o Início (folha de escrever +
// histórico) ou a leitura de uma finalizada, no mesmo lugar.
//
// Esta tela fica MONTADA fora da aba e fora do projeto ativo (keepalive do
// App/Universe): é ela quem hospeda os slots de chat — trocar para Arquivos
// nunca desmonta a conversa.

const TAB_VALUE = { missao: 'board', arquivos: 'arquivos' } as const

export default function SoloProject({ project }: { project: Project }): React.JSX.Element {
  const projectId = project.id
  const missions = useStore((s) => s.missionsByProject[projectId] ?? s.missions)
  const storedTab = useStore((s) => s.universeTabByProject[projectId])
  const setUniverseTab = useStore((s) => s.setUniverseTab)
  const missionTab = useStore((s) => s.missionTabByProject[projectId] ?? null)
  const setMissionTab = useStore((s) => s.setMissionTab)
  const isActive = useStore((s) => s.openProjectId === projectId)
  const appPage = useStore((s) => s.appPage)
  const seats = useStore((s) => s.seats)
  const renameProject = useStore((s) => s.renameProject)
  const relocateProject = useStore((s) => s.relocateProject)
  const setProjectPhoto = useStore((s) => s.setProjectPhoto)
  const createMission = useStore((s) => s.createMission)
  const deleteMission = useStore((s) => s.deleteMission)
  const [relocError, setRelocError] = useState<string | null>(null)
  const [readingId, setReadingId] = useState<string | null>(null)
  const [justFinishedId, setJustFinishedId] = useState<string | null>(null)
  const [terminalId, setTerminalId] = useState<string | null>(null)

  const tab = soloUniverseTab(storedTab)
  // Valor antigo da aba (mapa, versões — de antes do modo existir na tela, ou
  // de um atalho) cai na Missão: o store volta a dizer a verdade, e o browser
  // nativo (que lê a aba 'board') acompanha.
  useEffect(() => {
    if (storedTab && storedTab !== TAB_VALUE[tab]) setUniverseTab(projectId, TAB_VALUE[tab])
  }, [storedTab, tab, projectId, setUniverseTab])

  const view = soloProjectView(missions, projectId, readingId)
  const open = view.kind === 'mission' ? view.mission : undefined
  const visible = appPage === 'workspace' && isActive && tab === 'missao'

  // A missão aberta é a missão SELECIONADA do projeto: quem lê
  // `missionTabByProject` (links de arquivo do chat, paleta) enxerga a mesma
  // missão que a tela mostra.
  useEffect(() => {
    const target = open?.id ?? null
    if (missionTab !== target) setMissionTab(projectId, target)
  }, [open?.id, missionTab, projectId, setMissionTab])

  const chat = useMissionChatSlots({
    projectId,
    isActive,
    mission: open,
    missions,
    onChatFocus: () => setTerminalId(null)
  })

  const history = useMemo(
    () => soloHistory(missions, projectId).map((m) => soloHistoryRow(m)),
    [missions, projectId]
  )

  const startMission = useCallback(
    async (input: { title: string; goal?: string; direct: true; missionType: 'dev' }): Promise<string | null> => {
      try {
        const created = await createMission(projectId, input)
        if (!created) return 'Não deu para criar a missão. Reinicie o Synkora e tente de novo.'
        setReadingId(null)
        setJustFinishedId(null)
        return null
      } catch (err) {
        return plainIpcError(err)
      }
    },
    [createMission, projectId]
  )

  const closeReading = useCallback(() => setReadingId(null), [])
  const onFinished = useCallback((missionId: string) => {
    setTerminalId(null)
    setJustFinishedId(missionId)
  }, [])

  const unversionedName = projectNameWithMode(project.name, true)

  return (
    <div className="workspace solo-project">
      <header className="ws-header">
        <div className="ws-identity">
          <button
            type="button"
            className="ws-avatar solo-avatar"
            style={{ ['--card-hue' as string]: hueOf(project.name) }}
            aria-label={`Trocar a foto do universo ${unversionedName}`}
            data-tip="Trocar a foto do universo"
            onClick={() => void setProjectPhoto(projectId)}
          >
            {project.photo ? <img src={project.photo} alt="" draggable={false} /> : initialsOf(project.name)}
            <UnversionedFolderSeal size="header" />
          </button>
          <input
            key={project.name}
            className="ws-name"
            defaultValue={project.name}
            aria-label="Nome do universo"
            data-tip="Nome do universo — Enter ou clique fora para salvar"
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            onBlur={(e) => {
              const v = e.target.value.trim()
              if (v && v !== project.name) void renameProject(projectId, v)
            }}
          />
          <span className="solo-mode-tag">
            <UnversionedModeTag title="Uma missão por vez; as edições vão direto para a pasta" />
          </span>
        </div>
        <nav className="tabs" aria-label="Seções do universo">
          <button
            type="button"
            className={`tab ${tab === 'missao' ? 'active' : ''}`}
            aria-current={tab === 'missao' ? 'page' : undefined}
            onClick={() => setUniverseTab(projectId, 'board')}
          >
            Missão
          </button>
          <button
            type="button"
            className={`tab ${tab === 'arquivos' ? 'active' : ''}`}
            aria-current={tab === 'arquivos' ? 'page' : undefined}
            onClick={() => setUniverseTab(projectId, 'arquivos')}
          >
            Arquivos
          </button>
        </nav>
        <div className="ws-actions">
          <span className="ws-path" data-tip={project.path}>
            <WorkspaceIcon name="folder" />
            <span className="ws-path-text">{project.path}</span>
          </span>
          <button
            type="button"
            className="btn ghost tiny"
            data-tip="Alterar a pasta deste universo (renomeou ou moveu fora do app?)"
            onClick={() => {
              setRelocError(null)
              void relocateProject(projectId).then(setRelocError)
            }}
          >
            <WorkspaceIcon name="folder" />
            Pasta
          </button>
        </div>
      </header>

      {relocError && <div className="ws-reloc-error">✗ {relocError}</div>}

      <div className="workspace-stage">
        {/* A aba Missão fica na caixa real mesmo fora de vista: ela hospeda a
            conversa e os terminais — desmontar mataria sessão viva. */}
        <div
          className={`tab-content workspace-keepalive${tab === 'missao' ? ' is-active' : ''}`}
          aria-hidden={tab === 'missao' ? undefined : true}
          inert={tab === 'missao' ? undefined : true}
        >
          <GuiPanelErrorBoundary paneId={`view:${projectId}:missao`} label="a missão">
            {view.kind === 'mission' ? (
              <SoloProjectMission
                key={view.mission.id}
                project={project}
                mission={view.mission}
                chat={chat}
                terminalId={terminalId}
                onTerminal={setTerminalId}
                visible={visible}
                onFinished={onFinished}
              />
            ) : view.kind === 'reading' ? (
              <SoloProjectReading
                key={view.mission.id}
                mission={view.mission}
                projectPath={project.path}
                seats={seats}
                onBack={closeReading}
                onRemove={async () => {
                  const result = await deleteMission(view.mission.id)
                  if (!result.ok) return result.error
                  setReadingId(null)
                  return null
                }}
              />
            ) : (
              <SoloProjectStart
                folder={folderName(project.path)}
                rows={history}
                justFinishedId={justFinishedId}
                autoFocus={visible}
                onStart={startMission}
                onRead={setReadingId}
              />
            )}
          </GuiPanelErrorBoundary>
        </div>
        {/* Arquivos não roda processo nenhum: monta só quando ativa (a lista
            chega fresca), com raiz na pasta do projeto. */}
        {tab === 'arquivos' && (
          <div className="tab-content">
            <GuiPanelErrorBoundary paneId={`view:${projectId}:arquivos`} label="os arquivos">
              <FilesView projectId={projectId} />
            </GuiPanelErrorBoundary>
          </div>
        )}
      </div>
    </div>
  )
}
