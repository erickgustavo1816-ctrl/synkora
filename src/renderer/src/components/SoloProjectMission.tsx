import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import GuiPane from './GuiPane'
import GuiPanelErrorBoundary from './GuiPanelErrorBoundary'
import GuiSeatPick from './GuiSeatPick'
import TerminalPane from './TerminalPane'
import DockMobile from './DockMobile'
import MissionStageHead, { type StagePill } from './MissionStageHead'
import StageRoundStatus from './StageRoundStatus'
import StageSeatChip from './StageSeatChip'
import SoloProjectPanels from './SoloProjectPanels'
import SoloProjectFinish from './SoloProjectFinish'
import { TestServerModal } from './TestServerModal'
import WorkspacePanels from '../workspace/WorkspacePanels'
import WorkspaceToolbar from '../workspace/WorkspaceToolbar'
import WorkspaceIcon from '../workspace/WorkspaceIcon'
import { useWorkspaceLayout } from '../workspace/useWorkspaceLayout'
import { availableWorkspacePanels } from '../workspacePanels'
import { formatGuiElapsed } from '../guiActivity'
import { guiSubagentSidebarEntries } from '../guiSubagentSidebar'
import { MISSION_GUI_ROLE_LABEL, type MissionChatSlots, type MissionGuiSlot } from '../useMissionChatSlots'
import { soloFinishButton, soloFinishRisk, soloTurnOpen } from '../soloProjectModel'
import { folderName } from '../util'
import {
  TERMINAL_DEFAULT_FONT_FAMILY,
  TERMINAL_DEFAULT_FONT_SIZE,
  TERMINAL_DEFAULT_LINE_HEIGHT,
  TERMINAL_NATIVE_SCROLLBAR_WIDTH,
  TERMINAL_SCROLLBAR_WIDTH,
  terminalFallbackForHost,
  terminalMinColsForBox
} from '../terminalGeometry'
import { useStore, type Mission, type Pane, type Project } from '../store'
import '../workspace/workspacePanels.css'
import './SoloProject.css'

// A MISSÃO É A TELA (cenas 4 e 5 do mockup aprovado) — projeto sem
// versionamento, uma missão por vez.
//
// Sem trilho de missões e sem "recolher missões": o TÍTULO da missão sobe para
// a ponta esquerda da cabeça do palco (renomeável no lugar). À direita, o
// estado do turno, a conta, o terminal de teste (roda na pasta do projeto), o
// menu de painéis (Browser · Mobile · Frota — nunca Trabalho, Histórico ou
// Release) e o FINALIZAR, onde o ⇪ mora no versionado: tinta em repouso,
// laranja com UM anel quando o agente entregou o resumo.
//
// O chat é PAPEL e nunca desmonta: os slots vivem no hook compartilhado com o
// Board (hospedado pela tela do projeto, que fica montada na aba Arquivos), e
// cada slot é um fragmento com chave — trocar de conversa ou de terminal só
// troca qual caixa está à vista.

const NO_PANES: Pane[] = []
const NO_SLOTS: MissionGuiSlot[] = []

export default function SoloProjectMission({
  project,
  mission,
  chat,
  terminalId,
  onTerminal,
  visible,
  onFinished
}: {
  project: Project
  mission: Mission
  chat: MissionChatSlots
  /** o terminal no palco; null = a conversa */
  terminalId: string | null
  onTerminal: (paneId: string | null) => void
  /** a tela da missão está à vista do dono (página, projeto e aba) */
  visible: boolean
  /** a missão foi finalizada: o Início a recebe com o filete */
  onFinished: (missionId: string) => void
}): React.JSX.Element {
  const seats = useStore((s) => s.seats)
  const settings = useStore((s) => s.settings)
  const guiPanes = useStore((s) => s.guiPanes)
  const panes = useStore((s) => s.panesByProject[project.id] ?? NO_PANES)
  const clearPaneAttention = useStore((s) => s.clearPaneAttention)
  const finishMission = useStore((s) => s.finishMission)
  const boardRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const workspace = useWorkspaceLayout(project.id, mission.id)
  /** o deck do workspace está por cima do chat: o palco fica inerte */
  const [chatCovered, setChatCovered] = useState(false)
  const [testServerOpen, setTestServerOpen] = useState(false)
  const [finishOpen, setFinishOpen] = useState(false)
  const [finishBusy, setFinishBusy] = useState(false)
  const [finishError, setFinishError] = useState<string | null>(null)

  const live = mission.status === 'ativa' || mission.status === 'integrando'
  const panelOptions = useMemo(() => availableWorkspacePanels('dev', live, 'none'), [live])
  const slots = chat.slots[mission.id] ?? NO_SLOTS
  const activeId = chat.active[mission.id]
  const slot = slots.find((s) => s.spawn.paneId === activeId) ?? slots[0]
  const slotGui = slot ? guiPanes[slot.spawn.paneId] : undefined
  const devSlot = slots.find((s) => s.role === 'dev')
  const devGui = devSlot ? guiPanes[devSlot.spawn.paneId] : undefined
  const needsSeat = slots.length === 0 && Boolean(chat.needsSeat[mission.id])
  const chatError = chat.errors[mission.id]

  // TERMINAIS DA MISSÃO (o ▶ terminal de teste, na pasta do projeto): ficam
  // MONTADOS — desmontar mata o PTY, e com ele o servidor.
  const termPanes = useMemo(
    () => panes.filter((p) => p.surface !== 'gui' && p.missionId === mission.id),
    [panes, mission.id]
  )
  const termInFront = termPanes.some((p) => p.id === terminalId) ? terminalId : null
  const testPane = termPanes.find((p) => p.testServer)
  // Terminal recém-nascido ganha o foco: o dono acabou de pedir o teste.
  const seenTerms = useRef<Set<string>>(new Set(termPanes.map((p) => p.id)))
  const termKey = termPanes.map((p) => p.id).join('|')
  useEffect(() => {
    const live = new Set(termKey ? termKey.split('|') : [])
    for (const id of live) {
      if (seenTerms.current.has(id)) continue
      seenTerms.current.add(id)
      onTerminal(id)
    }
    for (const id of seenTerms.current) if (!live.has(id)) seenTerms.current.delete(id)
  }, [termKey, onTerminal])

  // A caixa do palco medida de verdade: o terminal nasce com a geometria dela
  // (reaproveitar 120×30 cortava a borda direita em palco estreito).
  const [box, setBox] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = (): void => {
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      setBox((cur) =>
        Math.round(cur.w) === Math.round(rect.width) && Math.round(cur.h) === Math.round(rect.height)
          ? cur
          : { w: rect.width, h: rect.height }
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [])
  const measured = box.w > 0 ? box : undefined
  const fontFamily = settings?.uiFontFamily ?? TERMINAL_DEFAULT_FONT_FAMILY
  const fallbackFor = (kind: Pane['kind']): { cols: number; rows: number } =>
    terminalFallbackForHost(
      measured,
      TERMINAL_DEFAULT_FONT_SIZE,
      TERMINAL_DEFAULT_LINE_HEIGHT,
      kind === 'claude' ? TERMINAL_NATIVE_SCROLLBAR_WIDTH : TERMINAL_SCROLLBAR_WIDTH
    )
  const sizeGroup = measured
    ? `solo:${project.id}:${Math.round(measured.w)}x${Math.round(measured.h)}:${TERMINAL_DEFAULT_FONT_SIZE}:${fontFamily}`
    : `solo:${project.id}:fallback`

  // O FINALIZAR e o aviso de finalizar no meio do trabalho — réguas puras.
  const turnOpen = soloTurnOpen(devGui?.status)
  const helpersRunning = useMemo(
    () => guiSubagentSidebarEntries(devGui?.items ?? []).filter((entry) => entry.status === 'running').length,
    [devGui?.items]
  )
  const finishState = soloFinishButton({ needsSeat, summary: mission.summary, turnOpen })
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!finishOpen || !turnOpen || devGui?.startedAt == null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [finishOpen, turnOpen, devGui?.startedAt])
  const risk = soloFinishRisk({
    turnOpen,
    elapsed: turnOpen && devGui?.startedAt != null ? formatGuiElapsed(Math.max(0, now - devGui.startedAt)) : null,
    helpersRunning
  })

  async function confirmFinish(): Promise<void> {
    if (finishBusy) return
    setFinishBusy(true)
    setFinishError(null)
    const result = await finishMission(mission.id)
    setFinishBusy(false)
    if (!result.ok) {
      setFinishError(result.error)
      return
    }
    setFinishOpen(false)
    onFinished(mission.id)
  }

  // As pílulas: a conversa do agente e os terminais desta missão.
  const pills: StagePill[] = [
    ...slots.map((s, index): StagePill => {
      const helperN = slots.filter((x, j) => x.role === 'helper' && j <= index).length
      const label = s.role === 'helper' ? `ajudante ${helperN}` : MISSION_GUI_ROLE_LABEL[s.role]
      const pane = guiPanes[s.spawn.paneId]
      return {
        id: s.spawn.paneId,
        label,
        kind: 'chat',
        active: !termInFront && slot?.spawn.paneId === s.spawn.paneId,
        attention: Boolean(pane?.perm || pane?.question || pane?.planReview),
        tip: `Ver a conversa "${label}" desta missão`,
        onSelect: () => {
          onTerminal(null)
          chat.focus(mission.id, s.spawn.paneId)
        },
        onClose: s.role === 'dev' ? undefined : () => chat.closeSlot(mission.id, s.spawn.paneId),
        closeTip: `Encerrar a conversa "${label}" (a pasta fica como está)`
      }
    }),
    ...termPanes.map((pane): StagePill => ({
      id: pane.id,
      label: pane.testServer ? 'teste' : pane.title || 'terminal',
      kind: 'terminal',
      active: termInFront === pane.id,
      tip: `Ver o terminal "${pane.title}" desta missão`,
      onSelect: () => onTerminal(pane.id),
      onClose: () => window.synkora.panes.requestClose(project.id, pane.id),
      closeTip: 'Fechar o terminal (derruba o que estiver rodando nele)'
    }))
  ]

  const stageChat = !termInFront ? slot : undefined
  const terminalLabel = testPane ? 'Parar servidor de teste' : 'Abrir terminal de teste'
  const finishTip =
    finishState === 'blocked'
      ? 'Escolha a conta da missão para poder finalizá-la'
      : finishState === 'ready'
        ? 'O agente deixou o resumo: finalize quando quiser'
        : 'Finalizar a missão: o chat para e ela vai para o histórico'

  return (
    <div className="board workspace-board solo-mission">
      <div ref={boardRef} className="board-main stage-mode">
        <div
          className={`maestro-window stage-window${chatCovered ? ' is-covered' : ''}`}
          inert={chatCovered || undefined}
        >
          <MissionStageHead
            leadingAction={
              <>
                <SoloStageTitle mission={mission} />
                <span className="stage-sep solo-title-sep" aria-hidden="true" />
              </>
            }
            pills={pills}
            status={
              stageChat && slotGui ? (
                <StageRoundStatus status={slotGui.status} startedAt={slotGui.startedAt} />
              ) : undefined
            }
            seat={
              stageChat ? (
                <StageSeatChip
                  seats={seats}
                  seatId={stageChat.spawn.seatId}
                  cli={stageChat.spawn.cli}
                  account={slotGui?.caps?.account}
                  changing={chat.seatBusy !== null}
                  locked={slotGui?.composerBusy ?? false}
                  turnOpen={soloTurnOpen(slotGui?.status)}
                  onChange={(next) => void chat.chooseSeat(mission.id, next)}
                />
              ) : undefined
            }
            actions={
              <>
                <WorkspaceToolbar
                  controller={workspace}
                  available={panelOptions}
                  enabled
                  visible={visible}
                  title={mission.title}
                  boardRef={boardRef}
                  actions={
                    <div className="workspace-mission-actions" role="group" aria-label="Ações da missão">
                      <button
                        type="button"
                        aria-label={terminalLabel}
                        data-tip={testPane ? terminalLabel : 'Abrir terminal de teste (na pasta do universo)'}
                        className={testPane ? 'is-running' : undefined}
                        disabled={!live}
                        onClick={() =>
                          testPane
                            ? window.synkora.panes.requestClose(project.id, testPane.id)
                            : setTestServerOpen(true)
                        }
                      >
                        <WorkspaceIcon name="terminal" />
                      </button>
                    </div>
                  }
                />
                <button
                  type="button"
                  className={`btn tiny solo-finish-btn is-${finishState}`}
                  aria-label="Finalizar missão"
                  data-tip={finishTip}
                  disabled={finishState === 'blocked' || !live}
                  onClick={() => {
                    setFinishError(null)
                    setFinishOpen(true)
                  }}
                >
                  <WorkspaceIcon name="check" />
                  Finalizar
                </button>
              </>
            }
          />
          <div className="maestro-body maestro-terminal" ref={bodyRef}>
            {/* Cada filho é um FRAGMENTO COM CHAVE: a posição de um irmão nunca
                identifica a lista, então nenhum GuiPane/TerminalPane remonta. */}
            <Fragment key="mission-gui-slots">
              {slots.map((s) => {
                const active = visible && !termInFront && slot?.spawn.paneId === s.spawn.paneId
                return (
                  <div
                    key={s.spawn.paneId}
                    className={`maestro-slot${active ? ' is-active' : ''}`}
                    aria-hidden={active ? undefined : true}
                    inert={active ? undefined : true}
                  >
                    <GuiPanelErrorBoundary paneId={s.spawn.paneId} label="esta conversa">
                      <GuiPane
                        paneId={s.spawn.paneId}
                        active={active}
                        projectId={project.id}
                        cli={s.spawn.cli}
                        configDir={s.spawn.configDir}
                        cwd={s.spawn.cwd}
                        model={s.spawn.model}
                        effort={s.spawn.effort}
                        systemPrompt={s.spawn.systemPrompt}
                        resumeSessionId={s.spawn.resumeSessionId}
                        firstPrompt={s.spawn.firstPrompt}
                        permissionMode={s.spawn.permissionMode}
                        missionType="dev"
                        fast={s.spawn.fast}
                        mcp={s.spawn.mcp}
                        onPermissionMode={(pm) => chat.setPermission(mission.id, s.spawn.paneId, pm)}
                        onFastMode={(on) => chat.setFast(mission.id, s.spawn.paneId, on)}
                        onExecutorChange={(patch) => chat.setExecutor(mission.id, s.spawn.paneId, patch)}
                        seats={seats}
                        seatId={s.spawn.seatId}
                        seatError={chatError}
                        showHeader={false}
                      />
                    </GuiPanelErrorBoundary>
                  </div>
                )
              })}
            </Fragment>
            {needsSeat && !termInFront && (
              <div className="maestro-slot is-active">
                <GuiSeatPick
                  seats={seats}
                  title="Escolha a conta desta missão"
                  hint="O agente começa assim que você escolher, já com o título e o objetivo que você escreveu. Dá para trocar depois, na cabeça do chat."
                  busySeatId={chat.seatBusy}
                  error={chatError}
                  onPick={(seatId) => void chat.chooseSeat(mission.id, seatId)}
                />
              </div>
            )}
            {slots.length === 0 && !needsSeat && !termInFront && (
              <div className="maestro-empty">
                {chatError ? (
                  <div className="solo-chat-error">
                    <span>{chatError}</span>
                    <button type="button" className="term-btn" onClick={() => chat.retry(mission.id)}>
                      ⟳ tentar de novo
                    </button>
                  </div>
                ) : (
                  'abrindo a conversa desta missão…'
                )}
              </div>
            )}
            <Fragment key="terminal-slots">
              {termPanes.map((pane) => {
                const active = termInFront === pane.id
                const fallback = fallbackFor(pane.kind)
                return (
                  <div
                    key={pane.id}
                    className={`maestro-slot${active ? ' is-active' : ''}`}
                    aria-hidden={active ? undefined : true}
                    inert={active ? undefined : true}
                  >
                    <GuiPanelErrorBoundary
                      paneId={pane.id}
                      label={pane.title || 'este terminal'}
                      onClose={() => window.synkora.panes.requestClose(project.id, pane.id)}
                    >
                      <TerminalPane
                        paneId={pane.id}
                        cwd={pane.cwd ?? project.path}
                        kind={pane.kind}
                        projectId={project.id}
                        seatId={pane.seatId}
                        taskId={pane.taskId}
                        initialPrompt={pane.initialPrompt}
                        model={pane.model}
                        cliArgs={pane.cliArgs}
                        appendSystemPrompt={pane.appendSystemPrompt}
                        logFile={pane.logFile}
                        imagePasteProjectId={project.id}
                        fontSize={TERMINAL_DEFAULT_FONT_SIZE}
                        lineHeight={TERMINAL_DEFAULT_LINE_HEIGHT}
                        fontFamily={fontFamily}
                        minCols={terminalMinColsForBox(pane.kind, fallback)}
                        minRows={pane.kind === 'claude' ? 12 : 6}
                        fallbackSize={fallback}
                        sizeGroup={`${sizeGroup}:${pane.kind}`}
                        voiceLabel={pane.title}
                        onUserInput={() => clearPaneAttention(project.id, pane.id)}
                      />
                    </GuiPanelErrorBoundary>
                  </div>
                )
              })}
            </Fragment>
          </div>
        </div>

        <WorkspacePanels
          controller={workspace}
          available={panelOptions}
          enabled
          legacyEnabled={false}
          visible={visible}
          projectId={project.id}
          boardRef={boardRef}
          onCovered={setChatCovered}
        >
          <GuiPanelErrorBoundary paneId={`solo-panels:${mission.id}`} label="os painéis da missão">
            <SoloProjectPanels
              missionId={mission.id}
              projectId={project.id}
              live={live}
              subagentItems={devGui?.items ?? []}
              visible={visible}
            />
          </GuiPanelErrorBoundary>
          {panelOptions.includes('mobile') && (
            <GuiPanelErrorBoundary key={`mobile:${mission.id}`} paneId={`mobile:${mission.id}`} label="o simulador mobile">
              <DockMobile missionId={mission.id} projectId={project.id} visible={visible} />
            </GuiPanelErrorBoundary>
          )}
        </WorkspacePanels>
      </div>

      {testServerOpen && (
        <GuiPanelErrorBoundary
          key={`overlay:test-server:${mission.id}`}
          paneId={`overlay:test-server:${mission.id}`}
          label="o servidor de teste"
          onClose={() => setTestServerOpen(false)}
        >
          <TestServerModal
            projectId={project.id}
            target={{ missionId: mission.id }}
            label={`missão "${mission.title.slice(0, 32)}"`}
            lead={`Sobe o servidor da pasta ${folderName(project.path)} num terminal para você testar. O comando fica visível no terminal; feche o terminal para derrubar o servidor.`}
            onClose={() => setTestServerOpen(false)}
          />
        </GuiPanelErrorBoundary>
      )}

      {finishOpen && (
        <SoloProjectFinish
          title={mission.title}
          risk={risk}
          busy={finishBusy}
          error={finishError}
          onConfirm={() => void confirmFinish()}
          onCancel={() => setFinishOpen(false)}
        />
      )}
    </div>
  )
}

/** O TÍTULO DA MISSÃO na ponta esquerda do palco: é aqui que a tela diz qual
 *  missão é (não há trilho de missões). Clique renomeia no lugar; Enter ou
 *  clicar fora grava, Esc desiste. */
function SoloStageTitle({ mission }: { mission: Mission }): React.JSX.Element {
  const loadMissions = useStore((s) => s.loadMissions)
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // Enter, Esc e clicar fora encerram a MESMA edição: só o primeiro conta.
  const settled = useRef(false)

  useLayoutEffect(() => {
    if (!editing) return
    settled.current = false
    // `select()` sozinho não dá foco ao campo
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  function settle(value: string | null): void {
    if (settled.current) return
    settled.current = true
    setEditing(false)
    const title = value?.trim()
    if (!title || title === mission.title || !window.synkora.missions?.update) return
    void window.synkora.missions
      .update(mission.id, { title })
      .then(() => loadMissions(mission.projectId))
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="solo-stage-title-input"
        defaultValue={mission.title}
        aria-label="Título da missão"
        onKeyDown={(event) => {
          if (event.key === 'Enter') settle(event.currentTarget.value)
          if (event.key === 'Escape') {
            event.preventDefault()
            settle(null)
          }
        }}
        onBlur={(event) => settle(event.currentTarget.value)}
      />
    )
  }
  return (
    <button
      type="button"
      className="solo-stage-title"
      title="Renomear a missão"
      aria-label={`Missão ${mission.title} — renomear`}
      onClick={() => setEditing(true)}
    >
      <span>{mission.title}</span>
      <WorkspaceIcon name="pencil" />
    </button>
  )
}
