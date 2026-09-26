import { Fragment } from 'react'
import type { Mission, VersionStats } from '../store'
import type { PlanView } from '../planContract'
import { planProgress } from '../planBoardPresentation'
import { waitingOnOwner } from '../missionPresentation'
import type { MissionColumnEntry } from './MissionColumn'
import MissionDashboardRow from './MissionDashboardRow'
import WorkspaceIcon from '../workspace/WorkspaceIcon'
import {
  landingHeadline,
  landingMilestone,
  liveMissions,
  livePlanning,
  missionCount,
  missionDayLabel,
  progressLabel,
  projectKpis,
  releasedLines,
  versionPercent,
  versionWork
} from '../projectLanding'
import './ProjectDashboard.css'

// O ✦ geral de um universo que já tem missão. Contrato visual: o mockup
// aprovado em docs/mockups/painel-projeto-2026-09-26.html.
//
// O componente NÃO BUSCA NADA: o Board resolve tudo. A única leitura sob
// demanda é a gaveta de uma linha (`MissionDashboardRow`), por clique.

export default function ProjectDashboard({
  missions,
  entries,
  versoes,
  versaoNaMain,
  plans,
  versionLabelOf,
  onOpenMission,
  onOpenPlans,
  onOpenVersions,
  onTestVersion,
  onNewMission
}: {
  /** TODAS as missões do universo, em qualquer status */
  missions: Mission[]
  /** as VIVAS, já resolvidas pelo Board (conta, modelo, versão, fila, pulso) */
  entries: MissionColumnEntry[]
  /** retrato por versão do `homeStats`; ausente = ainda não foi lido */
  versoes?: VersionStats[]
  /** o que está NA MAIN: nome da última versão LANÇADA (ordem do dono,
   *  2026-08-17). Ausente = nada subiu ainda, e a tela diz isso em vez de
   *  eleger uma versão aberta e chamá-la de identidade do projeto. */
  versaoNaMain?: string
  /** planos do projeto (mesma lista da aba Mapa); ausente = janela sem a ponte */
  plans?: PlanView[]
  /** nome da versão de UMA missão — é o carimbo que põe cada missão no cartão
   *  da linha dela e na tabela das lançadas */
  versionLabelOf: (mission: Mission) => string | undefined
  onOpenMission: (missionId: string) => void
  /** leva à aba Mapa, onde o plano é editável item a item */
  onOpenPlans?: () => void
  /** leva à aba Versões — onde o ⇪ da subida e o placar da linha moram.
   *  Ausente = janela sem a ponte, e o painel simplesmente não oferece o gesto */
  onOpenVersions?: () => void
  /** sobe o servidor da branch DESTA versão num terminal (o mesmo canal do
   *  ▶ testar da aba Versões) — o worktree da versão já vem mobiliado */
  onTestVersion?: (versionName: string) => void
  onNewMission: () => void
}): React.JSX.Element {
  const kpis = projectKpis(missions)
  const entryOf = new Map(entries.map((entry) => [entry.mission.id, entry]))
  const waiting = (mission: Mission): boolean =>
    waitingOnOwner({ mission, pulse: entryOf.get(mission.id)?.pulse })
  const marco = landingMilestone(missions, versoes)
  const headline = landingHeadline(missions, versoes)
  const work = versionWork(missions, versoes, versionLabelOf, waiting)
  const planning = livePlanning(missions)
  const released = releasedLines(missions, versoes, versionLabelOf, versaoNaMain)
  const esperando = liveMissions(missions).filter(waiting)
  const planosVivos = (plans ?? []).filter((plan) => plan.status !== 'arquivado')
  // um acento por vez: no marco ele é do lançamento; fora dele, da missão nova
  const launchable = Boolean(marco && onOpenVersions)

  const liveRow = (mission: Mission): React.JSX.Element => (
    <MissionDashboardRow
      key={mission.id}
      mission={mission}
      entry={entryOf.get(mission.id)}
      onOpen={onOpenMission}
    />
  )

  // sem clique e sem conta/modelo: o `entries` só resolve missão viva
  const doneRow = (mission: Mission): React.JSX.Element => {
    const day = missionDayLabel(mission)
    return (
      <li key={mission.id} className="pd-row">
        <div className="pd-row-done" data-tip={mission.title}>
          <WorkspaceIcon name="check" />
          <span className="pd-row-title">{mission.title}</span>
          {day && <span className="pd-row-when">{day}</span>}
        </div>
      </li>
    )
  }

  const summary: [string, number][] = [
    ['Em andamento', kpis.emAndamento],
    ['Na fila', kpis.naFila],
    ['Integradas', kpis.integradas],
    ['Arquivadas', kpis.arquivadas]
  ]

  return (
    <div className="project-dashboard">
      <header className="pd-header">
        <div className="pd-heading">
          <h1 className="pd-title">{headline.title}</h1>
          <p className="pd-sub">
            {headline.building && (
              <span>
                <b>{headline.building}</b> em construção
              </span>
            )}
            {headline.progress && <span>{progressLabel(headline.progress)}</span>}
            {versaoNaMain ? (
              <span
                data-tip={`${versaoNaMain} é a última versão LANÇADA — é ela que está na main.`}
              >
                na main: <b>{versaoNaMain}</b>
              </span>
            ) : (
              <span data-tip="Nenhuma versão foi lançada ainda: a main não recebeu nenhum release deste projeto.">
                nada lançado na main ainda
              </span>
            )}
          </p>
        </div>

        <div className="pd-actions">
          {marco && onOpenVersions && (
            <button
              type="button"
              className="btn accent"
              data-tip={
                `Leva à aba Versões, onde o ⇪ subir versão faz o merge da branch da ${marco.name} na main.\n` +
                'O merge continua sendo um clique SEU lá — este botão abre a mesa, não sobe nada.'
              }
              onClick={onOpenVersions}
            >
              <WorkspaceIcon name="release" />
              lançar na main
            </button>
          )}
          {marco && onTestVersion && (
            <button
              type="button"
              className="btn"
              data-tip={
                `Sobe o servidor da branch da ${marco.name} num terminal, já dentro do worktree da versão.\n` +
                'Você escolhe a porta; o comando nasce visível no pane.'
              }
              onClick={() => onTestVersion(marco.name)}
            >
              <WorkspaceIcon name="play" />
              testar a versão
            </button>
          )}
          <button
            type="button"
            className={`btn ${launchable ? 'ghost' : 'accent'}`}
            data-tip={
              'Nova missão: branch e worktree próprios, com o agente já dentro.\n' +
              'No modal dá para escolher PLANEJAMENTO — a conversa que escreve o plano/ na raiz.'
            }
            onClick={onNewMission}
          >
            <WorkspaceIcon name="plus" />
            nova missão
          </button>
        </div>
      </header>

      <div className="pd-body">
        <div className="pd-main">
          {esperando.length > 0 && (
            <section className="pd-attn" aria-label="Esperando você">
              <p className="pd-attn-head">
                <span className="pd-dot ask" aria-hidden="true" />
                esperando você · {esperando.length}
              </p>
              {esperando.map((mission) => {
                const why =
                  entryOf.get(mission.id)?.pulse ?? 'A integração espera o seu aval no trilho de entrega'
                return (
                  <div key={mission.id} className="pd-attn-row">
                    <span className="pd-attn-title">{mission.title}</span>
                    <span className="pd-attn-why" data-tip={why}>
                      <WorkspaceIcon name="ask" />
                      <span>{why}</span>
                    </span>
                    <button
                      type="button"
                      className="btn tiny"
                      data-tip="Abre a conversa desta missão para destravar"
                      onClick={() => onOpenMission(mission.id)}
                    >
                      abrir
                      <WorkspaceIcon name="arrow" />
                    </button>
                  </div>
                )
              })}
            </section>
          )}

          {work.lines.map((line) => {
            const { name, missoesFeitas, missoesTotal } = line.version
            return (
              <section key={name} className="pd-card">
                <header className="pd-card-head">
                  <span
                    className="pd-version-name"
                    data-tip={`Versão em construção: toda missão desta linha integra na branch da ${name}`}
                  >
                    {name}
                  </span>
                  {line.ready ? (
                    <span className="pd-pill ok">
                      <WorkspaceIcon name="check" />
                      pronta
                    </span>
                  ) : (
                    <span className="pd-pill">em construção</span>
                  )}
                  <span className="pd-card-progress">
                    {line.ready
                      ? missionCount(missoesTotal)
                      : missoesTotal > 0
                        ? `${missoesFeitas} de ${missoesTotal} integradas`
                        : 'sem missões ainda'}
                    {!line.ready && missoesTotal > 0 && (
                      <span className="pd-bar" aria-hidden="true">
                        <span style={{ width: `${versionPercent(missoesFeitas, missoesTotal)}%` }} />
                      </span>
                    )}
                  </span>
                </header>
                {line.live.length + line.done.length > 0 ? (
                  <ul className="pd-rows">
                    {line.live.map(liveRow)}
                    {line.done.map(doneRow)}
                  </ul>
                ) : (
                  <p className="pd-empty">nenhuma missão nesta versão ainda</p>
                )}
              </section>
            )
          })}

          {work.loose.length > 0 && (
            <section className="pd-block">
              <h2 className="pd-section-title">em andamento</h2>
              <div className="pd-card">
                <ul className="pd-rows">{work.loose.map(liveRow)}</ul>
              </div>
            </section>
          )}

          {planning.length > 0 && (
            <section className="pd-block">
              <h2 className="pd-section-title">planejamento</h2>
              <div className="pd-card">
                <ul className="pd-rows">{planning.map(liveRow)}</ul>
              </div>
            </section>
          )}

          {released.length > 0 && (
            <section className="pd-block">
              <div className="pd-section-head">
                <h2 className="pd-section-title">lançadas</h2>
                {onOpenVersions && (
                  <button
                    type="button"
                    className="pd-link"
                    data-tip="O placar completo: missões, entregas e a branch de cada versão"
                    onClick={onOpenVersions}
                  >
                    abrir a aba Versões
                    <WorkspaceIcon name="arrow" />
                  </button>
                )}
              </div>
              <div className="pd-released">
                {released.map((line) => (
                  <div
                    key={line.name}
                    className="pd-released-row"
                    data-tip={`${line.name}\n${line.titles.join('\n')}`}
                  >
                    <span className="pd-version-name">{line.name}</span>
                    <span>{line.onMain && <span className="pd-pill ok sm">na main</span>}</span>
                    <span className="pd-released-count">{missionCount(line.titles.length)}</span>
                    <span className="pd-released-titles">{line.titles.join(' · ')}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="pd-side">
          <section>
            <h2 className="pd-section-title">resumo</h2>
            <dl className="pd-summary">
              {summary.map(([label, value]) => (
                <Fragment key={label}>
                  <dt>{label}</dt>
                  <dd className={value === 0 ? 'zero' : undefined}>{value}</dd>
                </Fragment>
              ))}
              <dt className="total">Total</dt>
              <dd className="total">{missions.length}</dd>
            </dl>
          </section>

          {planosVivos.length > 0 && (
            <section>
              <div className="pd-section-head">
                <h2 className="pd-section-title">planos</h2>
                {onOpenPlans && (
                  <button type="button" className="pd-link" onClick={onOpenPlans}>
                    abrir no Mapa
                    <WorkspaceIcon name="arrow" />
                  </button>
                )}
              </div>
              <div className="pd-plans">
                {planosVivos.map((plan) => {
                  // a mesma conta do mapa, para a casa e o mapa dizerem a mesma fração
                  const progress = planProgress(plan.items)
                  // cumprido é selo: a barra cheia leria como trabalho pendente
                  const sealed = progress.total > 0 && progress.done === progress.total
                  return (
                    <div
                      key={plan.id}
                      className={`pd-plan${sealed || plan.status === 'concluido' ? ' done' : ''}`}
                      data-tip={`${plan.title}\n${progress.label}`}
                    >
                      <span className="pd-plan-head">
                        <span className="pd-plan-title">{plan.title}</span>
                        {plan.kind === 'mestre' && <span className="pd-tag">mestre</span>}
                      </span>
                      {sealed ? (
                        <span className="pd-plan-foot">
                          <WorkspaceIcon name="check" />
                          {progress.done} de {progress.total} · cumprido
                        </span>
                      ) : (
                        <span className="pd-plan-foot">
                          <span className="pd-bar" aria-hidden="true">
                            <span style={{ width: `${progress.percent}%` }} />
                          </span>
                          {progress.done} de {progress.total}
                          {progress.running > 0 && ` · ${progress.running} em andamento`}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}
