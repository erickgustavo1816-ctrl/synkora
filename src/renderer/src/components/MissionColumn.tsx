import { missionTypeOf, type Mission } from '../store'
import { isReleaseMissionRecord } from '../missionCardAccess'
import { badgeFor, dotClass } from '../missionPresentation'
import { integrationQueueBadge } from '../integrationQueuePresentation'

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
  onNewMission,
  collapsed = false,
  id
}: {
  entries: MissionColumnEntry[]
  selectedId: string | null
  generalPulse?: string
  onSelect: (missionId: string | null) => void
  onNewMission: () => void
  collapsed?: boolean
  id?: string
}): React.JSX.Element {
  // ONDA D: os interruptores BYPASS/SENSÍVEL do universo morreram daqui — a
  // permissão passou a ser POR CONVERSA, no composer do próprio chat (é lá
  // que o dono decide o quanto aquele agente pode agir sozinho).
  return (
    <div className={`mission-col${collapsed ? ' is-collapsed' : ''}`} id={id} aria-hidden={collapsed} inert={collapsed || undefined}>
      <div className="mission-col-content">
      <button
        className={`mission-col-general${selectedId ? '' : ' active'}${
          generalPulse ? ' asking' : ''
        }`}
        data-tip={
          generalPulse
            ? `❓ PERGUNTA PARA VOCÊ:\n${generalPulse}`
            : 'A casa do universo: o retrato do projeto e o convite para criar missão'
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
          const { mission } = entry
          // MISSÃO DE PLANEJAMENTO (2.0): ela roda na RAIZ e não tem branch —
          // mostrar "⎇ sem branch (repo novo)" ali seria descrever uma falta
          // que não existe. No lugar entra o ✎, que diz a natureza dela.
          const planning = missionTypeOf(mission) === 'planejamento'
          // R30 — o card do RELEASE: entrada de navegação enquanto a subida
          // vive (sem ela, clicar em geral perdia o chat — bug do dono,
          // 2026-08-21). Não é missão: a borda tracejada e a linha de baixo
          // dizem a natureza; concluiu, o Board o tira da lista. A régua é a
          // DECLARADA (missionCardAccess) — a tela consome, nunca reescreve.
          const release = isReleaseMissionRecord(mission)
          // O SELO: a fila fala primeiro só onde ela sabe mais (rodada 9) — na
          // CABEÇA, onde a bola é do agente e "fila #1" seria uma meia-verdade;
          // no resto, o vocabulário de sempre. Quem espera o DONO vence os dois
          // (o `integrationQueueBadge` devolve null e cede a vez).
          const badge = integrationQueueBadge(entry) ?? badgeFor(entry)
          const meta = [entry.seatName, entry.model].filter(Boolean).join(' · ')
          return (
            <button
              key={mission.id}
              className={`mission-card${release ? ' release-card' : ''}${
                selectedId === mission.id ? ' active' : ''
              }${mission.status === 'integrando' ? ' integrating' : ''}${
                entry.pulse || mission.pendingIntegrationApproval ? ' asking' : ''
              }`}
              data-tip={
                release
                  ? 'O chat da subida: quem sobe é o agente (release_run). Concluiu, o card sai — a aba VERSÕES reabre a conversa pelo ⇪.'
                  : entry.pulse
                    ? `❓ O AGENTE PERGUNTOU A VOCÊ:\n${entry.pulse}`
                    : mission.pendingIntegrationApproval
                      ? `⇪ INTEGRAÇÃO AGUARDA SEU AVAL:\no agente pediu para integrar "${mission.title}" — abra a missão e confirme no cabeçalho (nada mergeia sem você)`
                      : [mission.title, entry.queueLabel].filter(Boolean).join('\n')
              }
              onClick={() => onSelect(mission.id)}
            >
              <span className="mc-head">
                <span className={`mc-dot ${dotClass(entry)}`} aria-hidden="true" />
                <span className="mc-title">{mission.title}</span>
                {badge && <span className={`mc-badge ${badge.kind}`}>{badge.glyph}</span>}
              </span>
              {/* O contador ▣ feitos/total de CARDS saiu na purga F6
                  (2026-08-17): a missão 2.0 não tem card — o que ela tem é a
                  conversa, e o andamento dela se lê no próprio chat. */}
              {(meta || entry.versionLabel) && (
                <span className="mc-meta">
                  {entry.versionLabel && <span className="mc-version">◈ {entry.versionLabel}</span>}
                  {meta && <span className="mc-seat">{meta}</span>}
                </span>
              )}
              {/* O WORKTREE embaixo de cada missão (pedido do dono): é ele que
                  diz onde o agente daquela conversa está de fato trabalhando.
                  Planejamento não tem worktree — leva o ✎ no lugar. */}
              {planning ? (
                <span className="mc-branch mc-planning">✎ planejamento · escreve plano/</span>
              ) : release ? (
                <span className="mc-branch mc-planning">◇ release · sobe a versão para a main</span>
              ) : (
                <span className="mc-branch">⎇ {mission.branch ?? 'sem branch (repo novo)'}</span>
              )}
            </button>
          )
        })}
      </div>

      {/* SEM TRAVA: no 2.0 o dono cria missão em QUALQUER modo de projeto —
          a cerca greenfield ("as missões nascem na ordem do
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
    </div>
  )
}
