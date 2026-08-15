import { useEffect, useState } from 'react'
import GuiPane from './GuiPane'
import GuiPanelErrorBoundary from './GuiPanelErrorBoundary'
import { guiApi } from '../guiApi'
import { missionChatAddresses, type MissionChatAddress } from '../guiMissionPanes'
import { missionTypeOf, useStore, type Mission } from '../store'

// A CONVERSA DE UMA MISSÃO ENCERRADA (2.0), SOMENTE LEITURA.
//
// Arquivar/integrar mata os processos e GUARDA o fio (guiSessions: `killWhere`
// preserva identidade e transcript; só excluir a missão chama `forgetWhere`).
// Este modal é o único lugar que lê essa fotografia — e ele lê pelo ÚNICO
// caminho que não ressuscita nada: `gui:state`, que devolve o que está no
// disco sem abrir sessão. A spec (`missions:guiSpec`) recusa missão encerrada
// de propósito e continua recusando: nada aqui passa por ela.
//
// O endereço de cada conversa é determinístico (`gui-dev-<id8>` etc.), então
// descobrir "quais conversas esta missão teve" é sondar os endereços possíveis
// e ficar com os que existem. Sonda em SÉRIE: o endereço que não existe volta
// vazio na hora, e assim no máximo UM transcript grande viaja por vez.

interface Props {
  mission: Mission
  onClose: () => void
}

export default function ArchivedMissionChat({ mission, onClose }: Props): React.JSX.Element {
  const seats = useStore((s) => s.seats)
  // O status VIVO da missão (a prop é a fotografia do clique): reativar devolve
  // a conversa ao board, e duas montagens do mesmo paneId brigariam pela mesma
  // chave de `guiPanes`. Quem sai é a leitura.
  const liveStatus = useStore((s) => s.missions.find((m) => m.id === mission.id)?.status)
  const [probing, setProbing] = useState(true)
  const [found, setFound] = useState<MissionChatAddress[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setProbing(true)
    void (async () => {
      const survivors: MissionChatAddress[] = []
      for (const address of missionChatAddresses(mission.id)) {
        const state = await guiApi.state(address.paneId)
        if (cancelled) return
        if (state.exists) survivors.push(address)
      }
      setFound(survivors)
      setActiveId(survivors[0]?.paneId ?? null)
      setProbing(false)
    })()
    return () => {
      cancelled = true
    }
  }, [mission.id])

  useEffect(() => {
    if (liveStatus === 'arquivada' || liveStatus === 'concluida') return
    onClose()
  }, [liveStatus, onClose])

  const current = found.find((address) => address.paneId === activeId) ?? found[0]
  // A conta gravada na missão é a fonte do CLI e do nome no cabeçalho. Conta
  // apagada depois: sobra a marca padrão e NADA mais — nome e plano só
  // aparecem quando o seat existe de verdade.
  const seat = seats.find((s) => s.id === mission.seatId)
  const planning = missionTypeOf(mission) === 'planejamento'

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="arch-chat"
        role="dialog"
        aria-modal="true"
        aria-label={`Conversa da missão ${mission.title}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="arch-chat-head">
          <span className="arch-chat-title">
            {/* o glifo é moldura, não palavra: classe própria para recuar de
                tinta enquanto o nome da missão lidera */}
            <span className="arch-chat-glyph" aria-hidden="true">
              ⊟
            </span>
            {mission.title}
          </span>
          <span className="arch-chat-sub">
            conversa congelada · somente leitura
            {mission.branch ? ` · ⎇ ${mission.branch}` : ''}
          </span>
          {found.length > 1 && (
            <span className="stage-pills" role="tablist" aria-label="Conversas desta missão">
              {found.map((address) => (
                <button
                  key={address.paneId}
                  type="button"
                  role="tab"
                  aria-selected={address.paneId === current?.paneId}
                  className={`stage-pill${address.paneId === current?.paneId ? ' active' : ''}`}
                  data-tip={`Ler a conversa "${address.label}" desta missão`}
                  onClick={() => setActiveId(address.paneId)}
                >
                  {address.label}
                </button>
              ))}
            </span>
          )}
          <button
            className="pane-close dark-close"
            aria-label="Fechar a conversa"
            data-tip="Fechar"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="arch-chat-body">
          {probing ? (
            <p className="arch-chat-empty">procurando a conversa desta missão…</p>
          ) : current ? (
            <GuiPanelErrorBoundary paneId={current.paneId} label="esta conversa">
              <GuiPane
                readOnly
                showHeader
                active={false}
                paneId={current.paneId}
                projectId={mission.projectId}
                cli={seat?.cli ?? 'claude'}
                cwd={mission.worktree ?? ''}
                model={mission.model}
                effort={mission.effort}
                seats={seats}
                seatId={mission.seatId}
                role={current.label}
                branchLabel={mission.branch}
              />
            </GuiPanelErrorBoundary>
          ) : planning ? (
            <p className="arch-chat-empty">
              a conversa de planejamento é do PROJETO, não desta missão — ela continua na
              coluna ✦ geral do universo.
            </p>
          ) : (
            <p className="arch-chat-empty">
              a conversa desta missão não está mais guardada — o histórico tem limite de
              espaço e as conversas mais antigas saem primeiro.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
