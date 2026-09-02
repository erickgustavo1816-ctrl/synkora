import type { Mission, VersionStats } from '../store'
import type { PlanView } from '../planContract'
import { planProgress } from '../planBoardPresentation'
import type { MissionColumnEntry } from './MissionColumn'
import MissionDashboardRow from './MissionDashboardRow'
import {
  landingMilestone,
  ledgerTail,
  liveMissions,
  missionTimeline,
  missionWorkDays,
  projectKpis,
  versionPercent
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
// A RODADA R38 (2026-08-24, mockup `docs/mockups/project-landing-2.html`)
// nasceu da foto de um universo com a versão PRONTA e nada vivo: três zeros
// gigantes, a coluna "missões abertas" vazia e cinco fichas repetindo a mesma
// linha em duas seções. O retrato de hoje é um bom retrato — de HOJE; naquele
// momento a única história era "a 0.1.1 está completa esperando o lançamento".
// A cura não é enfeitar o vazio, é a landing ter ESTADOS:
//   · com trabalho vivo → o retrato de sempre (nada dele se perdeu);
//   · sem nada vivo e com a linha de versão COMPLETA → o MARCO: o palco é da
//     versão, com as três ações do instante (lançar, testar, ver o placar);
//   · universo zerado → o convite, que continua sendo o `ProjectGeneral`.
// A régua é pura e mora no `landingMilestone`. Nesta rodada também:
//   · "integradas" + "atividade recente" viraram UMA lista (a obra por dia);
//   · plano cumprido virou SELO (o pontilhado diz encerrado por forma);
//   · o chip de versão virou RÉGUA, com a fração desenhada.
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
  /** nome da versão de UMA missão — o `entries` só cobre as vivas, e a linha
   *  de uma missão integrada também precisa dizer em que linha ela entrou */
  versionLabelOf: (mission: Mission) => string | undefined
  onOpenMission: (missionId: string) => void
  /** leva à aba Mapa, onde o plano é editável item a item */
  onOpenPlans?: () => void
  /** leva à aba Versões — onde o ⇪ da subida e o placar da linha moram.
   *  Ausente = janela sem a ponte, e o palco simplesmente não oferece o gesto */
  onOpenVersions?: () => void
  /** sobe o servidor da branch DESTA versão num terminal (o mesmo canal do
   *  ▶ testar da aba Versões) — o worktree da versão já vem mobiliado */
  onTestVersion?: (versionName: string) => void
  onNewMission: () => void
}): React.JSX.Element {
  const kpis = projectKpis(missions)
  const entryOf = new Map(entries.map((entry) => [entry.mission.id, entry]))
  const vivas = liveMissions(missions)
  // A OBRA: uma lista só, agrupada pelo dia do carimbo. Ela substituiu o par
  // "integradas" + "atividade recente", que era a mesma lista duas vezes.
  const obra = missionWorkDays(missionTimeline(missions))
  // O ESTADO DA TELA em uma linha: com marco, o palco é da versão pronta.
  const marco = landingMilestone(missions, versoes)
  // Plano ARQUIVADO não é retrato do projeto: ele foi engavetado de propósito.
  const planosVivos = (plans ?? []).filter((plan) => plan.status !== 'arquivado')
  const esperando = vivas.filter(
    (m) => m.pendingIntegrationApproval || entryOf.get(m.id)?.pulse
  )

  // AS OUTRAS LINHAS: no marco, o palco já É uma versão — as demais continuam
  // aparecendo logo abaixo dele. Uma linha em construção não pode sumir da
  // casa só porque a irmã ficou pronta.
  const outrasVersoes = (versoes ?? []).filter((v) => v.name !== marco?.name)

  // A RÉGUA DE UMA LINHA DE VERSÃO — a MESMA figura nos dois estados (no
  // retrato ela divide a banda com o instrumento; no marco ela desce para
  // debaixo do palco), por isso ela nasce uma vez só.
  const versionRail = (v: VersionStats): React.JSX.Element => (
    <span
      key={v.name}
      className={`pd-version${v.lancada ? ' released' : ''}`}
      data-tip={
        v.lancada
          ? `${v.name} já está na main — o placar completo fica na aba Versões`
          : `Versão em construção: toda missão desta linha integra na branch da ${v.name}`
      }
    >
      <span className="pd-version-name">
        ◈ {v.name}
        {v.lancada && ' ✓'}
      </span>
      <span className="pd-version-count">
        {v.lancada ? 'na main' : 'em construção'}
        {v.missoesTotal > 0
          ? ` · ${v.missoesFeitas}/${v.missoesTotal} integradas`
          : ' · sem missões'}
      </span>
      {v.missoesTotal > 0 && (
        <span className="pd-version-bar" aria-hidden="true">
          <span
            className="pd-version-fill"
            style={{ width: `${versionPercent(v.missoesFeitas, v.missoesTotal)}%` }}
          />
        </span>
      )}
    </span>
  )

  // A SEÇÃO DA OBRA muda de COLUNA com o estado, e é por isso que ela nasce
  // aqui: no marco ela é o conteúdo principal (a esquerda larga, onde estaria
  // a lista de missões); com trabalho vivo ela é contexto e volta para a
  // coluna estreita, ao lado do plano. Renderizá-la nos dois lugares deixaria
  // uma das colunas deserta em cada estado.
  const obraSection =
    obra.length > 0 ? (
      <section className="pd-section">
        <p className="pd-section-title">
          {marco ? `a obra da ${marco.name}` : 'a obra'}
          <span className="pd-section-more">
            {kpis.integradas > 0
              ? `${kpis.integradas} ${kpis.integradas === 1 ? 'integrada' : 'integradas'} — o placar completo na aba Versões`
              : 'o placar completo na aba Versões'}
          </span>
        </p>
        <div className="pd-work">
          {obra.map((group) => (
            <div key={group.day} className="pd-work-group">
              <p className="pd-work-day">{group.label}</p>
              <ul className="pd-activity">
                {group.events.map((event) => (
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
                    {/* CONTA E MODELO ficam FORA desta linha de propósito: o
                        `entries` só resolve missão VIVA, e escrever "Claude ·
                        conta 2" numa missão encerrada seria adivinhar quem a
                        rodou. O que a linha diz, ela sabe. */}
                    <span className="pd-event-kind">{event.kind}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    ) : null

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

        {/* O PALCO DO MARCO. "9/9 integradas, nada na main" é um MARCO, não um
            vazio: o cartão da versão assume o centro com as três ações do
            instante. Ele tem BORDA DE 2px e nenhuma sombra — a diferença vem da
            FORMA; cartão que flutua é a linguagem do mapa, não a desta casa. */}
        {marco && (
          <section
            className="pd-milestone"
            data-tip={
              `${marco.name} está pronta: todas as missões dela já integraram na branch da versão.\n` +
              'O que falta é o SEU ⇪ — nada sobe na main sem o seu clique.'
            }
          >
            <div className="pd-milestone-head">
              <span className="pd-milestone-name">◈ {marco.name}</span>
              <span className="pd-milestone-state">pronta — aguardando lançamento</span>
              <span className="pd-milestone-facts">
                {marco.missoesFeitas}/{marco.missoesTotal} missões integradas
              </span>
            </div>
            <span className="pd-milestone-bar" aria-hidden="true">
              <span
                className="pd-milestone-fill"
                style={{ width: `${versionPercent(marco.missoesFeitas, marco.missoesTotal)}%` }}
              />
            </span>
            <div className="pd-milestone-deck">
              {onOpenVersions && (
                <button
                  className="btn go"
                  data-tip={
                    `Leva à aba Versões, onde o ⇪ subir versão faz o merge da branch da ${marco.name} na main.\n` +
                    'O merge continua sendo um clique SEU lá — este botão abre a mesa, não sobe nada.'
                  }
                  onClick={onOpenVersions}
                >
                  ⇪ lançar na main
                </button>
              )}
              {onTestVersion && (
                <button
                  className="btn"
                  data-tip={
                    `Sobe o servidor da branch da ${marco.name} num terminal — o worktree da versão, com as missões já unificadas.\n` +
                    'Você escolhe a porta; o comando nasce visível no pane.'
                  }
                  onClick={() => onTestVersion(marco.name)}
                >
                  ▶ testar a versão
                </button>
              )}
              {onOpenVersions && (
                <button
                  className="btn ghost"
                  data-tip="O placar completo da linha: missões, entregas e a branch da versão"
                  onClick={onOpenVersions}
                >
                  aba versões →
                </button>
              )}
              <span className="pd-milestone-hint">
                testar abre o terminal já dentro do worktree da {marco.name}
              </span>
            </div>
          </section>
        )}

        {/* As OUTRAS linhas de versão não somem no marco: elas descem para
            debaixo do palco, na mesma régua do retrato. */}
        {marco && outrasVersoes.length > 0 && (
          <div className="pd-versions">{outrasVersoes.map(versionRail)}</div>
        )}

        {/* O LEDGER — a contagem em UMA linha de texto. No marco os quatro
            tiles diziam "0 · N · 0 · 0": três zeros grandes não são
            informação, são um cartaz de vazio. Com trabalho vivo os números
            voltam a importar e o instrumento volta com eles. */}
        {marco && (
          <p
            className="pd-ledger"
            data-tip="O placar do universo inteiro — por linha de versão, ele está na aba Versões"
          >
            <span>
              <b>{missions.length}</b> {missions.length === 1 ? 'missão' : 'missões'} no total
            </span>
            <span className="pd-ledger-sep" aria-hidden="true">
              ·
            </span>
            <span>
              <b>{kpis.integradas}</b> {kpis.integradas === 1 ? 'integrada' : 'integradas'}
            </span>
            <span className="pd-ledger-sep" aria-hidden="true">
              ·
            </span>
            <span>{ledgerTail(kpis)}</span>
          </p>
        )}

        {!marco && (
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
              conta as missões que nasceram nela.
              R38: a pílula virou RÉGUA. Ela dizia "5/8 missões" e escondia o
              RUMO — a mesma fração, desenhada, diz de relance quanto falta
              para a linha fechar (e é o mesmo dado do `VersionStats`). */}
          {outrasVersoes.length > 0 && (
            <div className="pd-versions">{outrasVersoes.map(versionRail)}</div>
          )}
        </div>
        )}
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
          cronologia — à direita. Estreita, tudo empilha nesta mesma ordem.
          R38: no MARCO não existe trabalho vivo — a coluna larga seria uma
          seção com uma frase de desculpas ("nenhuma missão aberta agora"), que
          é exatamente o vazio da reprovação. Ali quem ocupa a esquerda é a
          OBRA da versão, e o plano segue à direita. */}
      <div className="pd-grid">
        <div className="pd-col">
          {!marco && (
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
          )}
          {marco && obraSection}
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
                  // PLANO CUMPRIDO É SELO, NÃO INSTRUMENTO (R38): a barra
                  // cheia de 8/8 com a roupa de um plano em curso lia como
                  // trabalho pendente. O selo é a FRAÇÃO cheia — nasce do
                  // número, não do status, porque é o número que a tela mostra.
                  const sealed = progress.total > 0 && progress.done === progress.total
                  return (
                    <div
                      key={plan.id}
                      className={`pd-plan${sealed || plan.status === 'concluido' ? ' done' : ''}`}
                      data-tip={`${plan.title}\n${progress.label}`}
                    >
                      <span className="pd-plan-head">
                        {sealed && (
                          <span className="pd-plan-check" aria-hidden="true">
                            ✓
                          </span>
                        )}
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
                      {/* A FRAÇÃO DO SELO fica na LEGENDA, não na fileira do
                          título: medido no harness, com o ✓, o selo "mestre" e
                          o "8/8 — cumprido" na mesma linha, o nome do plano
                          sobrava com 181px na coluna de 370 e virava
                          "Versão de estabilização: …". O nome é a identidade;
                          quem cede é o número. */}
                      {sealed ? (
                        <span className="pd-plan-frac">
                          {progress.done}/{progress.total} — cumprido
                        </span>
                      ) : (
                        <span className="pd-plan-count">
                          {progress.done}/{progress.total} concluídas
                          {progress.running > 0 && (
                            <span className="pd-plan-running">
                              {' '}
                              · {progress.running} em andamento
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {/* A OBRA — UMA lista, por carimbo REAL (nasceu e integrou, nada
              além disso: não existe carimbo de "última atividade" neste app).
              Ela era DUAS seções aqui: "integradas", com as cinco últimas
              missões concluídas, e "atividade recente", onde as mesmas cinco
              apareciam de novo com outra palavra. ARQUIVADAS continuam de fora
              (elas saíram do board de propósito; listá-las desfaria isso). */}
          {!marco && obraSection}
        </div>
      </div>
    </div>
  )
}
