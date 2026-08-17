import { missionTypeOf, type Mission, type VersionStats } from '../store'
import type { MissionColumnEntry } from './MissionColumn'
import {
  MISSION_STATUS_LABEL,
  badgeFor,
  dotClass,
  waitingOnOwner,
  type MissionSignal
} from '../missionPresentation'
import {
  liveMissions,
  missionDayLabel,
  projectKpis,
  recentConcluded,
} from '../projectLanding'

// PAINEL DO PROJETO — o ✦ geral de um universo QUE JÁ TEM MISSÃO (ordem do
// dono, 2026-08-15).
//
// O convite (`ProjectGeneral`) é a tela do universo vazio. A partir da
// primeira missão o dono não precisa de convite, precisa de RETRATO: o que
// está andando, o que já integrou, o que está parado esperando ELE.
//
// Isto SUPERSEDE a cláusula "os números do projeto são chips na topbar, nunca
// um cartão ocupando o centro" do docs/MOCKUP_WORKSPACE.md — para o ✦ geral, e
// só para ele (a nota datada está no próprio mockup). A cláusula continua
// valendo no workspace de MISSÃO, onde o centro é da conversa; aqui não há
// conversa nenhuma disputando o espaço, e os chips da barra não conseguem
// dizer o que este painel diz: uma LINHA POR MISSÃO.
//
// PAPEL, NUNCA PAINEL: nada aqui usa `--panel`/`.term-window` — eles são
// exclusivos de terminal.
//
// O componente NÃO BUSCA NADA: o Board resolve tudo (o `entries` é o mesmo
// array que alimenta a coluna da esquerda, e `versoes` vem do `homeStats` que
// o Universe já mantém fresco).

export default function ProjectDashboard({
  missions,
  entries,
  versoes,
  versionLabelOf,
  onOpenMission,
  onNewMission
}: {
  /** TODAS as missões do universo, em qualquer status */
  missions: Mission[]
  /** as VIVAS, já resolvidas pelo Board (conta, modelo, versão, progresso, pulso) */
  entries: MissionColumnEntry[]
  /** retrato por versão do `homeStats`; ausente = ainda não foi lido */
  versoes?: VersionStats[]
  /** nome da versão de UMA missão — o `entries` só cobre as vivas, e a linha
   *  de uma missão integrada também precisa dizer em que linha ela entrou */
  versionLabelOf: (mission: Mission) => string | undefined
  onOpenMission: (missionId: string) => void
  onNewMission: () => void
}): React.JSX.Element {
  const kpis = projectKpis(missions)
  const entryOf = new Map(entries.map((entry) => [entry.mission.id, entry]))
  const vivas = liveMissions(missions)
  const integradas = recentConcluded(missions)

  return (
    <div className="project-dashboard">
      <div className="pd-kpis">
        <div
          className={`stat-tile${kpis.emAndamento > 0 ? ' hot' : ''}`}
          data-tip="Missões vivas: em andamento ou integrando agora"
        >
          <span className="stat-num">{kpis.emAndamento}</span>
          <span className="stat-label">em andamento</span>
        </div>
        <div
          className={`stat-tile${kpis.integradas > 0 ? ' ok' : ''}`}
          data-tip="Missões que já entraram na linha de destino"
        >
          <span className="stat-num">{kpis.integradas}</span>
          <span className="stat-label">integradas</span>
        </div>
        <div
          className="stat-tile"
          data-tip={
            'Na fila serial de integração — ou esperando o SEU ⇪.\n' +
            'Nada mergeia sozinho: o clique do dono é a porteira.'
          }
        >
          <span className="stat-num">{kpis.naFila}</span>
          <span className="stat-label">na fila ⇪</span>
        </div>
        <div className="stat-tile" data-tip="Missões arquivadas (fora do board, branch preservada)">
          <span className="stat-num">{kpis.arquivadas}</span>
          <span className="stat-label">arquivadas</span>
        </div>
      </div>

      {/* RETRATO POR VERSÃO, versão COMPACTA: a aba Versões mostra o placar
          inteiro (missões · em execução · concluídas). Aqui é só "onde cada
          linha está" — repetir tudo faria duas telas dizerem o mesmo. */}
      {versoes && versoes.length > 0 && (
        <div className="pd-versions">
          {versoes.map((v) => (
            <span
              key={v.name}
              className={`pd-version${v.lancada ? ' released' : ''}`}
              data-tip={
                v.lancada
                  ? `${v.name} já está na main — o placar completo fica na aba Versões`
                  : `Versão em construção: toda missão desta linha integra na branch da ${v.name}`
              }
            >
              ◈ {v.name}
              {v.lancada && ' ✓'}
              <span className="pd-version-count">
                {v.missoesTotal > 0 ? `${v.missoesFeitas}/${v.missoesTotal} missões` : 'sem missões'}
              </span>
            </span>
          ))}
        </div>
      )}

      <section className="pd-section">
        <p className="pd-section-title">missões abertas</p>
        {vivas.length === 0 ? (
          <p className="pd-empty">
            nenhuma missão aberta agora — o que já foi feito está logo abaixo.
          </p>
        ) : (
          <div className="pd-list">
            {vivas.map((mission) => (
              <MissionRow
                key={mission.id}
                mission={mission}
                entry={entryOf.get(mission.id)}
                versionLabel={versionLabelOf(mission)}
                onOpen={onOpenMission}
              />
            ))}
          </div>
        )}
      </section>

      {/* ARQUIVADAS não viram linha (só o KPI): elas saíram do board de
          propósito, e listá-las de volta desfaria o arquivamento na prática. */}
      {integradas.length > 0 && (
        <section className="pd-section">
          <p className="pd-section-title">
            integradas
            {kpis.integradas > integradas.length && (
              <span className="pd-section-more">
                {integradas.length} de {kpis.integradas} — o resto na aba Versões
              </span>
            )}
          </p>
          <div className="pd-list">
            {integradas.map((mission) => (
              <MissionRow
                key={mission.id}
                mission={mission}
                versionLabel={versionLabelOf(mission)}
                done
              />
            ))}
          </div>
        </section>
      )}

      {/* A landing NUNCA para de convidar: com dez missões vivas ou nenhuma, o
          caminho para a próxima frente de trabalho está sempre aqui. */}
      <button
        className="btn accent pd-cta"
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

/** Uma linha do painel. Sem `onOpen` ela não é clicável (missão encerrada). */
function MissionRow({
  mission,
  entry,
  versionLabel,
  done = false,
  onOpen
}: {
  mission: Mission
  entry?: MissionColumnEntry
  versionLabel?: string
  done?: boolean
  onOpen?: (missionId: string) => void
}): React.JSX.Element {
  const signal: MissionSignal = { mission, pulse: entry?.pulse }
  const badge = badgeFor(signal)
  const waiting = waitingOnOwner(signal)
  const planning = missionTypeOf(mission) === 'planejamento'
  const day = missionDayLabel(mission)
  const label = MISSION_STATUS_LABEL[mission.status]

  const body = (
    <>
      <span className="pd-head">
        <span className={`pd-dot ${dotClass(signal)}`} aria-hidden="true" />
        <span className="pd-title">{mission.title}</span>
        <span className={`pd-status ${mission.status}`}>{label}</span>
        {badge && <span className={`pd-badge ${badge.kind}`}>{badge.glyph}</span>}
      </span>
      <span className="pd-meta">
        {versionLabel && <span className="pd-version-tag">◈ {versionLabel}</span>}
        {planning ? (
          <span className="pd-branch">✎ planejamento · escreve plano/</span>
        ) : (
          <span className="pd-branch">⎇ {mission.branch ?? 'sem branch (repo novo)'}</span>
        )}
        {entry?.queueLabel && <span className="pd-queue">{entry.queueLabel}</span>}
        {day && <span className="pd-day">{day}</span>}
      </span>
      {waiting && (
        <span className="pd-waiting">
          {entry?.pulse ? `❓ ${entry.pulse}` : '⇪ a integração espera o seu aval no trilho de entrega'}
        </span>
      )}
    </>
  )

  const className = `pd-mission${waiting ? ' waiting' : ''}${done ? ' done' : ''}`

  // MISSÃO ENCERRADA NÃO É BOTÃO: o canal de seleção do board (`setMissionTab`)
  // só resolve missão VIVA — um clique aqui não abriria nada, e prometer o que
  // não acontece é pior que não oferecer. O histórico dela está na aba Versões.
  if (!onOpen) {
    return (
      <div
        className={className}
        data-tip={`${mission.title} — ${label}\nmissão encerrada: o histórico dela está na aba Versões`}
      >
        {body}
      </div>
    )
  }

  return (
    <button
      className={className}
      data-tip={
        waiting
          ? `❓ ESTA MISSÃO ESPERA VOCÊ:\nabra a conversa para destravar`
          : `Abrir ${mission.title}`
      }
      onClick={() => onOpen(mission.id)}
    >
      {body}
    </button>
  )
}
