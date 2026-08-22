import type { Mission, VersionStats } from '../store'
import type { PlanView } from '../planContract'
import { planProgress } from '../planBoardPresentation'
import type { MissionColumnEntry } from './MissionColumn'
import MissionDashboardRow from './MissionDashboardRow'
import {
  liveMissions,
  missionTimeline,
  projectKpis,
  recentConcluded,
} from '../projectLanding'

// PAINEL DO PROJETO — o ✦ geral de um universo QUE JÁ TEM MISSÃO (ordem do
// dono, 2026-08-15; ALARGADO em 2026-08-17).
//
// O convite (`ProjectGeneral`) é a tela do universo vazio. A partir da
// primeira missão o dono não precisa de convite, precisa de RETRATO: o que
// está andando, o que já integrou, o que está parado esperando ELE.
//
// A RODADA DE 2026-08-17 nasceu de uma frase do dono diante da tela antiga:
// "muito simples, feia — olha o tanto de espaço que sobra". A tela tinha
// quatro números, um chip e uma lista de uma linha num mar de papel. O que
// entrou NÃO foi enfeite: foi a informação que já existia no app e que esta
// tela não estava mostrando —
//   · a conta e o modelo de cada conversa (o `entries` já carregava);
//   · o diff da branch, SOB DEMANDA, na gaveta de cada linha;
//   · os PLANOS com o progresso deles (o mapa já os tinha; a casa não);
//   · a cronologia das missões pelos carimbos reais;
//   · as linhas de versão com a contagem CERTA de cada uma.
// e uma ESTRUTURA que ocupa a folha: banda de topo + duas colunas.
//
// Isto SUPERSEDE a cláusula "os números do projeto são chips na topbar, nunca
// um cartão ocupando o centro" do docs/MOCKUP_WORKSPACE.md — para o ✦ geral, e
// só para ele (a nota datada está no próprio mockup). A cláusula continua
// valendo no workspace de MISSÃO, onde o centro é da conversa.
//
// PAPEL, NUNCA PAINEL: nada aqui usa `--panel`/`.term-window` — eles são
// exclusivos de terminal.
//
// O componente NÃO BUSCA NADA: o Board resolve tudo (o `entries` é o mesmo
// array que alimenta a coluna da esquerda, `versoes`/`versaoNaMain` vêm do
// `homeStats` e os `plans` vêm do mesmo canal que o mapa lê). A ÚNICA leitura
// sob demanda é a gaveta de uma linha, e ela mora no `MissionDashboardRow`,
// disparada por clique — nunca no mount.

export default function ProjectDashboard({
  missions,
  entries,
  versoes,
  versaoNaMain,
  plans,
  versionLabelOf,
  onOpenMission,
  onOpenPlans,
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
  /** nome da versão de UMA missão — o `entries` só cobre as vivas, e a linha
   *  de uma missão integrada também precisa dizer em que linha ela entrou */
  versionLabelOf: (mission: Mission) => string | undefined
  onOpenMission: (missionId: string) => void
  /** leva à aba Mapa, onde o plano é editável item a item */
  onOpenPlans?: () => void
  onNewMission: () => void
}): React.JSX.Element {
  const kpis = projectKpis(missions)
  const entryOf = new Map(entries.map((entry) => [entry.mission.id, entry]))
  const vivas = liveMissions(missions)
  const integradas = recentConcluded(missions)
  const atividade = missionTimeline(missions)
  // Plano ARQUIVADO não é retrato do projeto: ele foi engavetado de propósito.
  const planosVivos = (plans ?? []).filter((plan) => plan.status !== 'arquivado')
  const esperando = vivas.filter(
    (m) => m.pendingIntegrationApproval || entryOf.get(m.id)?.pulse
  )

  return (
    <div className="project-dashboard">
      {/* BANDA DE TOPO — a identidade do projeto e o instrumento, numa faixa
          que atravessa a folha inteira em vez de deixar dois terços vazios.
          Sem rótulo em cima do título: o conteúdo se apresenta sozinho. */}
      <header className="pd-top">
        <div className="pd-top-line">
          {versaoNaMain ? (
            <span
              className="pd-identity"
              data-tip={`${versaoNaMain} é a última versão LANÇADA — é ela que está na main.\nAs linhas em construção estão à direita, cada uma com as missões dela.`}
            >
              <span className="pd-identity-mark">◈ {versaoNaMain}</span>
              <span className="pd-identity-note">na main</span>
            </span>
          ) : (
            <span
              className="pd-identity quiet"
              data-tip={
                'Nenhuma versão foi lançada ainda: a main não recebeu nenhum release deste projeto.\n' +
                'O trabalho se acumula na branch da versão em construção até você subir a versão na aba Versões.'
              }
            >
              <span className="pd-identity-note">nada lançado na main ainda</span>
            </span>
          )}

          {/* A landing NUNCA para de convidar: com dez missões vivas ou
              nenhuma, o caminho para a próxima frente de trabalho está aqui. */}
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

        <div className="pd-top-line instruments">
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
            <div
              className="stat-tile"
              data-tip="Missões arquivadas (fora do board, branch preservada)"
            >
              <span className="stat-num">{kpis.arquivadas}</span>
              <span className="stat-label">arquivadas</span>
            </div>
          </div>

          {/* AS LINHAS EM CONSTRUÇÃO, do lado do instrumento: elas são o outro
              eixo do mesmo placar (as missões por versão), e aqui ocupam a
              metade da banda que antes era papel vazio.
              A CONTAGEM É POR CARIMBO (ordem do dono, 2026-08-17): cada linha
              conta as missões que nasceram nela. */}
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
                    {v.missoesTotal > 0
                      ? `${v.missoesFeitas}/${v.missoesTotal} missões`
                      : 'sem missões'}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      </header>

      {/* O QUE ESPERA VOCÊ vem antes de tudo e atravessa a folha: com o aviso
          só dentro da linha da missão, uma pergunta parada na quinta linha de
          uma lista longa ficava abaixo da dobra. */}
      {esperando.length > 0 && (
        <p className="pd-alert">
          ⇪ {esperando.length}{' '}
          {esperando.length === 1
            ? 'missão está esperando você'
            : 'missões estão esperando você'}
          <span className="pd-alert-names">
            {esperando.map((m) => m.title).join(' · ')}
          </span>
        </p>
      )}

      {/* DUAS COLUNAS na folha larga (container query do `.board-content`): o
          trabalho VIVO à esquerda, com linhas inteiras para caber conta,
          modelo, fila e a gaveta do diff; o contexto — plano, história,
          cronologia — à direita. Estreita, tudo empilha nesta mesma ordem. */}
      <div className="pd-grid">
        <div className="pd-col">
          <section className="pd-section">
            <p className="pd-section-title">missões abertas</p>
            {vivas.length === 0 ? (
              <p className="pd-empty">
                nenhuma missão aberta agora — o que já foi feito está ao lado.
              </p>
            ) : (
              <div className="pd-list">
                {vivas.map((mission) => (
                  <MissionDashboardRow
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
        </div>

        <div className="pd-col side">
          {/* PLANOS: o mapa já os desenhava item a item; a casa do projeto não
              dizia nem que eles existiam. Aqui é o relance — título, se é o
              mestre, e a fração concluída —, e o gesto leva ao mapa, que é
              onde plano se edita. */}
          {planosVivos.length > 0 && (
            <section className="pd-section">
              <p className="pd-section-title">
                planos
                {onOpenPlans && (
                  <button className="pd-section-link" onClick={onOpenPlans}>
                    ver no mapa →
                  </button>
                )}
              </p>
              <div className="pd-plans">
                {planosVivos.map((plan) => {
                  // A MESMA conta do mapa (`planProgress`): descartada sai do
                  // denominador nos dois lugares, senão a casa e o mapa diriam
                  // frações diferentes do mesmo plano.
                  const progress = planProgress(plan.items)
                  return (
                    <div
                      key={plan.id}
                      className={`pd-plan${plan.status === 'concluido' ? ' done' : ''}`}
                      data-tip={`${plan.title}\n${progress.label}`}
                    >
                      <span className="pd-plan-head">
                        <span className="pd-plan-title">{plan.title}</span>
                        {plan.kind === 'mestre' && (
                          <span className="pd-plan-kind">mestre</span>
                        )}
                      </span>
                      <span className="pd-plan-bar" aria-hidden="true">
                        <span
                          className="pd-plan-fill"
                          style={{ width: `${progress.percent}%` }}
                        />
                      </span>
                      <span className="pd-plan-count">
                        {progress.done}/{progress.total} concluídas
                        {progress.running > 0 && (
                          <span className="pd-plan-running">
                            {' '}
                            · {progress.running} em andamento
                          </span>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {/* ARQUIVADAS não viram linha (só o KPI): elas saíram do board de
              propósito, e listá-las de volta desfaria o arquivamento. */}
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
                  <MissionDashboardRow
                    key={mission.id}
                    mission={mission}
                    versionLabel={versionLabelOf(mission)}
                    done
                  />
                ))}
              </div>
            </section>
          )}

          {/* CRONOLOGIA por carimbo REAL: nasceu e integrou, nada além disso —
              não existe carimbo de "última atividade" neste app, e inventar um
              a partir do `updatedAt` seria contar tempo que ninguém mediu. */}
          {atividade.length > 0 && (
            <section className="pd-section">
              <p className="pd-section-title">atividade recente</p>
              <ul className="pd-activity">
                {atividade.map((event) => (
                  // O título ENCURTA nesta coluna (medido: a 1280 de janela ela
                  // fica com 380px e um título longo perde o fim). A elipse é o
                  // padrão da casa para linha de missão; o que não pode é o
                  // texto ficar INALCANÇÁVEL — por isso a linha inteira leva o
                  // que ela diz no tooltip.
                  <li
                    key={`${event.missionId}:${event.kind}`}
                    className="pd-event"
                    data-tip={`${event.title}\n${event.kind} em ${event.day}`}
                  >
                    <span className={`pd-event-mark ${event.kind}`} aria-hidden="true">
                      {event.kind === 'integrada' ? '⇪' : '✦'}
                    </span>
                    <span className="pd-event-title">{event.title}</span>
                    <span className="pd-event-kind">{event.kind}</span>
                    <span className="pd-event-day">{event.day}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
