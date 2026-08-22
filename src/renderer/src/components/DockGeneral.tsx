import type { Mission, VersionStats } from '../store'
import type { MissionColumnEntry } from './MissionColumn'
import { waitingOnOwner } from '../missionPresentation'
import { formatDay, liveMissions, recentConcluded, versionInDev } from '../projectLanding'
import DockSection from './DockSection'

// RIGHTDOCK Onda B (2026-08-22, mockup aprovado = contrato) — o ✦ GERAL vira
// o RETRATO COMPACTO na moldura do dock: "sem card gigante — dois números que
// importam e o rastro". O painel largo (`ProjectDashboard`) foi demolido; o
// convite (`ProjectGeneral`) continua sendo a tela do universo VAZIO.
//
// Seções do mockup, verbatim:
//   AGORA — missões vivas + "N esperando você" (o pulso REAL, pela régua única
//   `waitingOnOwner`; o clique leva à missão) e a versão em desenvolvimento ao
//   lado da que está na main (conceitos distintos de propósito).
//   ÚLTIMAS ENTREGAS — o rastro das integradas, datado pelo carimbo real.
//
// O componente NÃO BUSCA NADA: o Board resolve tudo (o `entries` é o mesmo
// array da coluna da esquerda; `versoes`/`versaoNaMain` vêm do `homeStats`).
// PAPEL, NUNCA PAINEL: nada aqui usa `--panel`/`.term-window`.

export default function DockGeneral({
  missions,
  entries,
  versoes,
  versaoNaMain,
  onOpenMission
}: {
  /** TODAS as missões de SUPERFÍCIE do universo (o Board já filtra release) */
  missions: Mission[]
  /** as VIVAS, já resolvidas pelo Board — é daqui que vem o pulso (pergunta
   *  pendente) de cada missão */
  entries: MissionColumnEntry[]
  /** retrato por versão do `homeStats`; ausente = ainda não foi lido */
  versoes?: VersionStats[]
  /** a última versão LANÇADA (a que está na main); ausente = nada subiu */
  versaoNaMain?: string
  onOpenMission: (missionId: string) => void
}): React.JSX.Element {
  const entryOf = new Map(entries.map((entry) => [entry.mission.id, entry]))
  const vivas = liveMissions(missions)
  const esperando = vivas.filter((m) =>
    waitingOnOwner({ mission: m, pulse: entryOf.get(m.id)?.pulse })
  )
  const emDev = versionInDev(versoes)
  const entregas = recentConcluded(missions)

  return (
    <section className="dock-general dock" aria-label="Retrato do projeto">
      <div className="dock-head">
        <span className="dock-head-kind">✦ geral</span>
        <span className="dock-head-title">· painel de gestão</span>
        <span className="dock-grip" aria-hidden="true">⋮⋮</span>
      </div>

      <DockSection id="geral-agora" title="agora">
        <div className="dg-stat">
          <b>{vivas.length}</b>
          <span>{vivas.length === 1 ? 'missão viva' : 'missões vivas'}</span>
          {esperando.length > 0 && (
            <button
              className="dg-waiting"
              data-tip={`${esperando.map((m) => m.title).join(' · ')}\nclique abre a missão`}
              onClick={() => onOpenMission(esperando[0].id)}
            >
              · {esperando.length} esperando você
            </button>
          )}
        </div>
        {/* As DUAS pontas da versão, cada uma com a sua verdade: em
            desenvolvimento = a linha em construção (helper puro); na main = a
            última lançada. Sem fonte, a linha (ou a metade dela) não nasce. */}
        {(emDev || versaoNaMain) && (
          <div className="dg-stat">
            <b>◈ {emDev ?? versaoNaMain}</b>
            <span className="dg-mini">
              {emDev
                ? `em desenvolvimento${versaoNaMain ? ` · ${versaoNaMain} na main` : ''}`
                : 'na main'}
            </span>
          </div>
        )}
      </DockSection>

      {/* Sem entrega nenhuma a seção nem nasce: dock enxuto > seção vazia. */}
      {entregas.length > 0 && (
        <DockSection id="geral-entregas" title="últimas entregas">
          {entregas.map((m) => {
            const day = formatDay(m.completedAt)
            return (
              <span className="dg-delivery" key={m.id} data-tip={m.title}>
                ▣ {m.title}
                {day && <span className="dg-mini"> · {day}</span>}
              </span>
            )
          })}
        </DockSection>
      )}
    </section>
  )
}
