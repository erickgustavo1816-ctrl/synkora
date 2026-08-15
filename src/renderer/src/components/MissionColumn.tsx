import { missionTypeOf, type Mission } from '../store'
import { badgeFor, dotClass } from '../missionPresentation'

// COLUNA DE MISSÕES (Synkora 2.0, onda B) — o mockup aprovado pelo dono: as
// missões saem da fila de abas no topo e viram CARDS na coluna da ESQUERDA,
// cada um com o WORKTREE embaixo do título.
//
// O canal de seleção continua sendo o `setMissionTab` de sempre: ele alimenta
// selMission, a visibilidade dos slots do chat, os gates do kanban e a baixa
// das perguntas do ask_user. Aqui muda SÓ a roupa — nada do fluxo.
//
// Monta como ÚLTIMO filho de `.board-main` (que é row-reverse): último no DOM
// = primeiro na tela, e acrescentar no fim não desloca nenhum irmão anterior
// (deslocar remontaria os TerminalPane e mataria os PTYs).

/** Uma linha da coluna, já resolvida pelo Board (a coluna não busca nada). */
export interface MissionColumnEntry {
  mission: Mission
  /** cards concluídos / total (plano fora da conta, como no resto do board) */
  done: number
  total: number
  seatName?: string
  model?: string
  versionLabel?: string
  /** pergunta pendente do agente ao dono (ask_user ou heurística do "?") */
  pulse?: string
  /** rótulo humano da posição na fila de integração */
  queueLabel?: string
}

// `dotClass`/`badgeFor` moraram aqui até 2026-08-15 e mudaram para
// `../missionPresentation`: o painel do projeto (✦ geral com missões) desenha
// as MESMAS missões, e duas cópias divergiriam na primeira mudança.

export default function MissionColumn({
  entries,
  selectedId,
  generalPulse,
  onSelect,
  onNewMission
}: {
  entries: MissionColumnEntry[]
  selectedId: string | null
  generalPulse?: string
  onSelect: (missionId: string | null) => void
  onNewMission: () => void
}): React.JSX.Element {
  // ONDA D: os interruptores BYPASS/SENSÍVEL do universo morreram daqui — a
  // permissão passou a ser POR CONVERSA, no composer do próprio chat (é lá
  // que o dono decide o quanto aquele agente pode agir sozinho).
  return (
    <div className="mission-col">
      <button
        className={`mission-col-general${selectedId ? '' : ' active'}${
          generalPulse ? ' asking' : ''
        }`}
        data-tip={
          generalPulse
            ? `❓ O MAESTRO PERGUNTOU A VOCÊ:\n${generalPulse}`
            : 'PM do universo: conversa geral, cria missões e ajusta o projeto'
        }
        onClick={() => onSelect(null)}
      >
        <span className="mc-glyph">{generalPulse ? '❓' : '✦'}</span>
        <span className="mc-general-label">geral</span>
      </button>

      <div className="mission-col-list">
        {entries.length === 0 && (
          <div className="mission-col-empty">
            nenhuma missão aberta — crie a primeira abaixo: missão de produto (worktree
            próprio) ou planejamento (escreve o plano/)
          </div>
        )}
        {entries.map((entry) => {
          const { mission, done, total } = entry
          // MISSÃO DE PLANEJAMENTO (2.0): ela roda na RAIZ e não tem branch —
          // mostrar "⎇ sem branch (repo novo)" ali seria descrever uma falta
          // que não existe. No lugar entra o ✎, que diz a natureza dela.
          const planning = missionTypeOf(mission) === 'planejamento'
          const badge = badgeFor(entry)
          const meta = [entry.seatName, entry.model].filter(Boolean).join(' · ')
          return (
            <button
              key={mission.id}
              className={`mission-card${selectedId === mission.id ? ' active' : ''}${
                mission.status === 'integrando' ? ' integrating' : ''
              }${entry.pulse || mission.pendingIntegrationApproval ? ' asking' : ''}`}
              data-tip={
                entry.pulse
                  ? `❓ O AGENTE PERGUNTOU A VOCÊ:\n${entry.pulse}`
                  : mission.pendingIntegrationApproval
                    ? `⇪ INTEGRAÇÃO AGUARDA SEU AVAL:\no agente pediu para integrar "${mission.title}" — abra a missão e confirme no trilho (nada mergeia sem você)`
                    : [mission.title, entry.queueLabel].filter(Boolean).join('\n')
              }
              onClick={() => onSelect(mission.id)}
            >
              <span className="mc-head">
                <span className={`mc-dot ${dotClass(entry)}`} aria-hidden="true" />
                <span className="mc-title">{mission.title}</span>
                {badge && <span className={`mc-badge ${badge.kind}`}>{badge.glyph}</span>}
              </span>
              {(meta || entry.versionLabel || total > 0) && (
                <span className="mc-meta">
                  {entry.versionLabel && <span className="mc-version">◈ {entry.versionLabel}</span>}
                  {meta && <span className="mc-seat">{meta}</span>}
                  {total > 0 && (
                    <span className="mc-count">
                      ▣ {done}/{total}
                    </span>
                  )}
                </span>
              )}
              {/* O WORKTREE embaixo de cada missão (pedido do dono): é ele que
                  diz onde o agente daquela conversa está de fato trabalhando.
                  Planejamento não tem worktree — leva o ✎ no lugar. */}
              {planning ? (
                <span className="mc-branch mc-planning">✎ planejamento · escreve plano/</span>
              ) : (
                <span className="mc-branch">⎇ {mission.branch ?? 'sem branch (repo novo)'}</span>
              )}
            </button>
          )
        })}
      </div>

      {/* SEM TRAVA: no 2.0 o dono cria missão em QUALQUER modo de projeto —
          a cerca greenfield ("as missões nascem pelo Maestro, na ordem do
          plano mestre") saiu daqui junto com a recusa do `missions:create`. */}
      <button
        className="mission-col-new"
        data-tip={
          'Nova missão: branch e worktree próprios, com o agente já dentro.\n' +
          'No modal dá para escolher PLANEJAMENTO — a conversa que escreve o plano/ na raiz.'
        }
        onClick={onNewMission}
      >
        + nova missão
      </button>
    </div>
  )
}
