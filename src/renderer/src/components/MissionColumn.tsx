import { useStore, type Mission } from '../store'

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

/** Estado visual do ponto: o que exige o dono vence o que está só andando. */
function dotClass(entry: MissionColumnEntry): string {
  const { mission, pulse } = entry
  if (pulse || mission.pendingIntegrationApproval) return 'ask'
  if (mission.integration?.state === 'blocked') return 'err'
  if (mission.status === 'integrando' || mission.integration) return 'busy'
  return 'ok'
}

/** Selo curto à direita do título — o mesmo vocabulário das abas antigas. */
function badgeFor(entry: MissionColumnEntry): { glyph: string; kind: string } | null {
  const { mission, pulse } = entry
  if (pulse) return { glyph: '❓', kind: 'ask' }
  if (mission.pendingIntegrationApproval) return { glyph: '⇪', kind: 'ask' }
  const integration = mission.integration
  if (!integration || integration.state === 'merging') return null
  if (integration.state === 'blocked')
    return {
      glyph: integration.owner === 'orchestrator' ? '! reparo' : '! Maestro',
      kind: 'err'
    }
  if (integration.state === 'sync_required') return { glyph: '↻ sync', kind: 'busy' }
  return { glyph: `fila #${integration.position}`, kind: 'busy' }
}

export default function MissionColumn({
  projectId,
  entries,
  selectedId,
  generalPulse,
  greenfieldLocked,
  onSelect,
  onNewMission
}: {
  projectId: string
  entries: MissionColumnEntry[]
  selectedId: string | null
  generalPulse?: string
  greenfieldLocked: boolean
  onSelect: (missionId: string | null) => void
  onNewMission: () => void
}): React.JSX.Element {
  // Interruptores de permissão do UNIVERSO: eram a metade direita da barra de
  // abas que esta coluna substitui. Continuam sendo controle, não navegação —
  // por isso descem para o rodapé, longe da lista.
  const maestroBypass = useStore((s) => s.maestroBypass)
  const toggleBypass = useStore((s) => s.toggleBypass)
  const sensitiveBypassOk = useStore((s) => s.sensitiveBypassOk)
  const toggleSensitiveBypass = useStore((s) => s.toggleSensitiveBypass)

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
            nenhuma missão aberta — crie uma abaixo e o agente abre no worktree dela
          </div>
        )}
        {entries.map((entry) => {
          const { mission, done, total } = entry
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
                  diz onde o agente daquela conversa está de fato trabalhando. */}
              <span className="mc-branch">⎇ {mission.branch ?? 'sem branch (repo novo)'}</span>
            </button>
          )
        })}
      </div>

      <button
        className="mission-col-new"
        disabled={greenfieldLocked}
        data-tip={
          greenfieldLocked
            ? 'Projeto novo: as missões nascem pelo Maestro, na ordem do plano mestre.'
            : 'Nova missão: branch e worktree próprios, com o agente já dentro'
        }
        onClick={() => {
          if (!greenfieldLocked) onNewMission()
        }}
      >
        + nova missão
      </button>

      <div className="mission-col-tools">
        <button
          className={`perm-switch ${maestroBypass ? 'bypass' : 'guard'}`}
          role="switch"
          aria-checked={maestroBypass}
          data-tip={
            maestroBypass
              ? 'Permissões em BYPASS: os agentes seguem reto, sem pedir aprovação. Clique para religar as aprovações.'
              : 'Aprovações RELIGADAS: os agentes pedem permissão. Clique para voltar ao fluxo reto (bypass).'
          }
          onClick={() => void toggleBypass(projectId, !maestroBypass)}
        >
          <span className="ps-track">
            <span className="ps-knob">{maestroBypass ? '⏩' : '🛡'}</span>
          </span>
          <span className="ps-text">{maestroBypass ? 'bypass' : 'aprovações'}</span>
        </button>
        {/* Override do DONO para missão SENSÍVEL (classificador de risco): sem
            ele, projeto de domínio fiscal/PII perde o bypass em TODO pane
            escritor. Só faz sentido com bypass ligado. */}
        {maestroBypass && (
          <button
            className={`perm-switch ${sensitiveBypassOk ? 'bypass' : 'guard'}`}
            role="switch"
            aria-checked={sensitiveBypassOk}
            data-tip={
              sensitiveBypassOk
                ? 'Missões SENSÍVEIS (dados pessoais/fiscais, pagamentos…) também seguem em bypass — sua escolha, auditada na caixa-preta. Clique para voltar à proteção.'
                : 'Missões classificadas como SENSÍVEIS pedem aprovação mesmo com bypass. Num projeto cujo domínio é fiscal/PII isso trava tudo — clique para liberar o bypass nelas.'
            }
            onClick={() => void toggleSensitiveBypass(projectId, !sensitiveBypassOk)}
          >
            <span className="ps-track">
              <span className="ps-knob">{sensitiveBypassOk ? '⏩' : '🔒'}</span>
            </span>
            <span className="ps-text">{sensitiveBypassOk ? 'sensível ok' : 'sensível'}</span>
          </button>
        )}
      </div>
    </div>
  )
}
