import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { plansApi } from '../plansApi'
import type { PlanItemView, PlanView } from '../planContract'
import {
  PLAN_STATUS_LABEL,
  planClipLine,
  planItemCanDiscard,
  planItemCanStart,
  planItemDependencies,
  planItemLink,
  planItemMissionGoal,
  planItemPresentation,
  planItemStartBlock,
  planProgress,
  planReadyToConclude,
  planTierLabel,
  type PlanDependencySource,
  type PlanItemDependency,
  type PlanLinkedMission
} from '../planBoardPresentation'
import { missionChatSummary } from '../guiMissionPanes'
import NewMissionModal from './NewMissionModal'

// A ABA DE UM PLANO (D4.5) — a ÚNICA tela de plano do app desde o expurgo F6
// (2026-08-17): não existe mais uma segunda gramática competindo com esta.
//
// O que esta tela responde: "o que este plano prometeu, o que dele já virou
// missão, e o que está acontecendo com essas missões AGORA". Por isso o
// progresso nunca é campo persistido — ele nasce dos itens, e o pulso de cada
// ficha nasce da missão viva mais a conversa dela (`missionChatSummary`), a
// mesma régua do quadro de rotas.
//
// O dono é a única porta de criação de missão: o agente escreve o plano, o
// clique daqui abre o modal PRÉ-PREENCHIDO e o item se amarra à missão criada.

/**
 * A DESCRIÇÃO do plano é prosa do dono e pode ter parágrafos inteiros — no
 * teste ao vivo ela empurrou a primeira missão para fora da tela.
 *
 * O que se controla é a ALTURA, nunca a largura: a medida de leitura em `ch`
 * morreu nas superfícies de plano por ordem do dono (2026-08-17) e não volta
 * pela porta dos fundos. O cabeçalho mostra a abertura; o resto abre no clique.
 *
 * O botão só existe quando há texto escondido DE VERDADE, e isso é MEDIDO no
 * que renderizou (`scrollHeight` contra `clientHeight`) — contar letras erraria
 * a cada largura de aba. Aberto, a medida é pulada de propósito: com o corte
 * suspenso os dois valores se igualam e o próprio botão se apagaria.
 */
function PlanDescription({ text }: { text: string }): React.JSX.Element {
  const ref = useRef<HTMLParagraphElement | null>(null)
  const [open, setOpen] = useState(false)
  const [clipped, setClipped] = useState(false)

  useLayoutEffect(() => {
    const node = ref.current
    if (!node || open) return
    const measure = (): void => setClipped(node.scrollHeight - node.clientHeight > 1)
    measure()
    // A aba do mapa muda de largura com a janela e com o rail: o mesmo texto
    // corta em 1200px e não corta em 1800px.
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [text, open])

  return (
    <div className="planboard-lede">
      <p ref={ref} className={`planboard-desc${open ? ' open' : ''}`}>
        {text}
      </p>
      {clipped && (
        <button
          type="button"
          className="planboard-desc-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'ver menos' : 'ver mais'}
        </button>
      )}
    </div>
  )
}

/**
 * A tag diz o NOME curto; o resto da história é a dica. Ela nomeia POR QUE a
 * dependência já não segura nada — concluída e descartada satisfazem pelo mesmo
 * motivo, mas por caminhos opostos, e o dono precisa saber qual dos dois foi.
 */
function dependencyTip(dependency: PlanItemDependency): string {
  const head = `${dependency.order}. ${dependency.title}`
  if (dependency.status === 'concluida')
    return `${head}\nconcluída — não segura mais esta missão\nclique para localizar no quadro`
  if (dependency.status === 'descartada')
    return `${head}\nsaiu do plano — não segura mais esta missão\nclique para localizar no quadro`
  return `${head}\nprecisa estar concluída antes desta começar\nclique para localizar no quadro`
}

export default function PlanBoardView({
  projectId,
  plan,
  onChanged
}: {
  projectId: string
  plan: PlanView
  /** o plano mudou por uma ação daqui — o menu do mapa relê a lista */
  onChanged: () => void
}): React.JSX.Element {
  const missions = useStore((s) => s.missions)
  const guiPanes = useStore((s) => s.guiPanes)
  const setUniverseTab = useStore((s) => s.setUniverseTab)
  const setMissionTab = useStore((s) => s.setMissionTab)

  const [creatingFor, setCreatingFor] = useState<PlanItemView | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  // Item cuja pergunta de exclusão está aberta. Um por vez: abrir a de outro
  // fecha a anterior sozinha.
  const [discarding, setDiscarding] = useState('')
  const [pending, setPending] = useState('')
  const [message, setMessage] = useState('')

  // Índice das missões do projeto. `guiPanes` entra só pelo pulso e a leitura
  // é memoizada: `gui:live` dispara a cada delta do turno, e re-derivar a
  // lista inteira por frame seria caro à toa (lição do MissionRouteBoard).
  const missionsById = useMemo(() => {
    const map = new Map<string, PlanLinkedMission>()
    for (const mission of missions) {
      if (mission.projectId !== projectId) continue
      map.set(mission.id, {
        id: mission.id,
        title: mission.title,
        status: mission.status,
        ...(mission.pendingIntegrationApproval ? { pendingIntegrationApproval: true } : {})
      })
    }
    return map
  }, [missions, projectId])

  const items = useMemo(
    () => plan.items.slice().sort((a, b) => a.order - b.order),
    [plan.items]
  )

  // O GRAFO (rodada 8): `dependsOn` guarda ids, e a tag mostra o NÚMERO + o
  // estado (ajuste do dono: tag compacta — o título vive na dica). O número é o
  // MESMO `pb-order` que a linha exibe (a lista ordenada), e o status é o
  // EFETIVO (o main já o derivou da missão real ao montar a PlanView) — a tag
  // dá check exatamente quando a missão dependida termina.
  const itemsById = useMemo(
    () =>
      new Map<string, PlanDependencySource>(
        items.map((entry, index) => [
          entry.id,
          { title: entry.title, order: index + 1, status: entry.status }
        ])
      ),
    [items]
  )

  // CLIQUE NA TAG LOCALIZA A MISSÃO (ajuste do dono, rodada 8): o quadro rola
  // até a linha dependida e ela pulsa uma vez — movimento como SINAL, apontando
  // "é esta aqui". O timer é um só: clicar noutra tag move o holofote em vez de
  // empilhar brilhos.
  const [spotlight, setSpotlight] = useState<string | null>(null)
  const spotlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const itemRows = useRef(new Map<string, HTMLLIElement | null>())
  useEffect(
    () => () => {
      if (spotlightTimer.current) clearTimeout(spotlightTimer.current)
    },
    []
  )
  const locateItem = useCallback((id: string): void => {
    itemRows.current.get(id)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    if (spotlightTimer.current) clearTimeout(spotlightTimer.current)
    setSpotlight(id)
    spotlightTimer.current = setTimeout(() => setSpotlight(null), 1600)
  }, [])

  const links = useMemo(() => {
    const chats = new Map<string, ReturnType<typeof missionChatSummary>>()
    const chatOf = (missionId: string): ReturnType<typeof missionChatSummary> => {
      const cached = chats.get(missionId)
      if (cached) return cached
      const summary = missionChatSummary(missionId, guiPanes)
      chats.set(missionId, summary)
      return summary
    }
    return new Map(items.map((item) => [item.id, planItemLink(item, missionsById, chatOf)]))
  }, [items, missionsById, guiPanes])

  const progress = useMemo(() => planProgress(plan.items), [plan.items])

  const openMission = useCallback(
    (missionId: string, live: boolean): void => {
      setUniverseTab(projectId, 'board')
      // Missão encerrada não tem aba própria no board: o ✦ geral é o destino
      // honesto (mesma regra do quadro de rotas).
      setMissionTab(projectId, live ? missionId : null)
    },
    [projectId, setUniverseTab, setMissionTab]
  )

  const run = useCallback(
    async (key: string, action: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
      if (pending) return
      setPending(key)
      setMessage('')
      try {
        const result = await action()
        if (!result.ok) setMessage(result.error ?? 'não deu para concluir esta ação')
        else onChanged()
      } finally {
        setPending('')
      }
    },
    [onChanged, pending]
  )

  const concluded = plan.status === 'concluido'
  // O AVISO (ordem do dono, 2026-08-28): o dono viu 8/8 na tela e o app nao
  // disse nada. Agora ele diz — e so diz: concluir continua sendo o clique
  // dele, inclusive com item abandonado.
  const ready = planReadyToConclude(plan)

  return (
    <div className="planboard">
      <header className="planboard-head">
        {/* IDENTIDADE de um lado, ESTADO do outro (2026-08-17). Os dois selos
            estavam colados no título falando gramáticas opostas — "plano
            mestre" em caixa baixa e "EM ANDAMENTO" em caixa alta —, e o dono
            leu isso como uma tag só, sem sentido. Agora a caixa é a MESMA para
            os dois (a voz de rótulo da casa) e o que os separa é o que eles
            são: a marca de mestre é IDENTIDADE e anda com o título; o estado é
            ESTADO e vai para a outra ponta da linha. */}
        <div className="planboard-identity">
          <h2 className="planboard-title">{plan.title.trim() || 'plano sem título'}</h2>
          {plan.kind === 'mestre' && (
            <span
              className="planboard-chip mestre"
              data-tip="O plano de fundo deste universo — o recorte que vale para o projeto inteiro. Só um por vez, e a designação é sua: sai quando você quiser."
            >
              plano mestre
            </span>
          )}
          <span className={`planboard-status ${plan.status}`}>{PLAN_STATUS_LABEL[plan.status]}</span>
        </div>

        {plan.description && <PlanDescription text={plan.description} />}

        <div className="planboard-meta">
          {ready && (
            <span className="planboard-ready" data-tip="O app não conclui sozinho: a decisão continua sua">
              pronto para concluir
            </span>
          )}
          <span className="planboard-progress">
            <span
              className="planboard-progress-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.percent}
              aria-valuetext={progress.label}
              aria-label="Missões concluídas neste plano"
            >
              <span
                className="planboard-progress-fill"
                style={{ width: `${progress.percent}%` }}
              />
            </span>
            {progress.label}
          </span>

          <span className="planboard-actions">
            {/* DESIGNAÇÃO (2026-08-17): o chip lá em cima é IDENTIDADE — chip é
                estado, nunca verbo. O verbo mora aqui, junto de concluir e
                arquivar, e a recusa cai sozinha em .planboard-message pelo
                mesmo `run()` de sempre. Sem modal: é reversível e nomeado. */}
            {plan.kind === 'livre'
              ? plan.status === 'ativo' && (
                  <button
                    className="btn ghost tiny"
                    disabled={Boolean(pending)}
                    data-tip="Marca este como o plano de fundo do universo. Só um por vez — e dá para tirar depois."
                    onClick={() =>
                      void run('mestre', () => plansApi.setKind(plan.id, 'mestre', plan.updatedAt))
                    }
                  >
                    {pending === 'mestre' ? 'designando…' : 'definir como plano mestre'}
                  </button>
                )
              : (
                  <button
                    className="btn ghost tiny"
                    disabled={Boolean(pending)}
                    data-tip="Este deixa de ser o plano de fundo do universo. Nada do conteúdo muda."
                    onClick={() =>
                      void run('mestre', () => plansApi.setKind(plan.id, 'livre', plan.updatedAt))
                    }
                  >
                    {pending === 'mestre' ? 'removendo…' : 'remover designação'}
                  </button>
                )}
            {!concluded && (
              <button
                className={`btn tiny${ready ? '' : ' ghost'}`}
                disabled={Boolean(pending)}
                data-tip={
                  ready
                    ? 'Todas as missões deste plano já integraram. Concluir tira a rota da fila de abas e guarda o plano — nada é apagado, e dá para reabrir.'
                    : 'Marca o plano como concluído: a rota sai da fila de abas e vai para os guardados. Nada é apagado, e dá para reabrir.'
                }
                onClick={() =>
                  void run('concluir', () =>
                    plansApi.update(plan.id, { status: 'concluido' }, plan.updatedAt)
                  )
                }
              >
                {pending === 'concluir' ? 'concluindo…' : 'concluir plano'}
              </button>
            )}
            <button
              className="btn ghost tiny"
              disabled={Boolean(pending)}
              data-tip="Tira o plano da fila de abas sem perder nada — dá para trazer de volta"
              onClick={() => void run('arquivar', () => plansApi.archive(plan.id, plan.updatedAt))}
            >
              {pending === 'arquivar' ? 'arquivando…' : 'arquivar'}
            </button>
            {/* Quatro botões idênticos em fila é um clique errado esperando
                acontecer: o irreversível ganha um filete que o separa dos
                reversíveis E a roupa de perigo da casa — a mesma da exclusão
                de versão na aba Versões. */}
            <span className="planboard-actions-split" aria-hidden="true" />
            <button
              className="btn ghost tiny danger"
              disabled={Boolean(pending)}
              data-tip="Apaga o plano de vez. As missões já criadas continuam existindo."
              onClick={() => setConfirmRemove(true)}
            >
              excluir
            </button>
          </span>
        </div>

        {message && (
          <p className="planboard-message" role="alert">
            {message}
          </p>
        )}
      </header>

      {items.length === 0 ? (
        <p className="planboard-empty">
          Este plano ainda não tem missões. Peça-as na conversa de planejamento: o agente escreve,
          você aprova, e elas aparecem aqui.
        </p>
      ) : (
        <ul className="planboard-items">
          {items.map((item, index) => {
            const state = planItemPresentation(item.status)
            const link = links.get(item.id) ?? { kind: 'none' as const }
            const tier = planTierLabel(item.tier)
            // As dependências saíram do tooltip e viraram TAGS visíveis — repetir
            // a lista na dica seria dizer duas vezes a mesma coisa.
            const dependencies = planItemDependencies(item, itemsById)
            const blockedBy = planItemStartBlock(item, itemsById)
            // LIVRE = planejada, sem missão ainda e sem nada pendente. É a
            // resposta de relance a "o que dá para abrir em paralelo agora?".
            const free = link.kind === 'none' && item.status === 'planejada' && !blockedBy
            const tip = [planClipLine(item.objective), item.docPath ? `brief: ${item.docPath}` : '']
              .filter(Boolean)
              .join('\n')
            return (
              <li
                key={item.id}
                ref={(row) => {
                  itemRows.current.set(item.id, row)
                }}
                className={`planboard-item ${state.cls}${spotlight === item.id ? ' pb-spotlit' : ''}`}
              >
                <span className="pb-glyph" aria-hidden="true">
                  {state.glyph}
                </span>
                <span className="pb-order">{index + 1}</span>
                <span className="pb-main" data-tip={tip || undefined}>
                  <span className="pb-title">{item.title}</span>
                  {item.objective && (
                    <span className="pb-objective">{planClipLine(item.objective, 140)}</span>
                  )}
                  {/* O GRAFO NA LINHA (rodada 8). Uma palavra ABRE a fileira e é
                      ela que se lê na varredura vertical: "livre" quando nada
                      segura, "depende de" quando algo segura. Nunca as duas —
                      quando a última dependência dá check, a palavra TROCA no
                      mesmo lugar, e é essa troca que o dono vê acontecer. */}
                  {(dependencies.length > 0 || free) && (
                    <span className="pb-deps">
                      {free ? (
                        <span
                          className="pb-free"
                          data-tip="Nada segura esta missão: dá para começar agora, em paralelo com as outras livres."
                        >
                          livre
                        </span>
                      ) : (
                        <span className="pb-deps-label">depende de</span>
                      )}
                      {/* TAG COMPACTA (ajuste do dono): ícone + NÚMERO — o
                          triângulo aponta a dependência pendente, o check diz
                          que ela já não segura nada; o título inteiro vive na
                          dica. Clicar LOCALIZA a missão dependida no quadro. */}
                      {dependencies.map((dependency) => (
                        <button
                          key={dependency.id}
                          type="button"
                          className={`pb-dep${dependency.satisfied ? ' ok' : ''}`}
                          data-tip={dependencyTip(dependency)}
                          aria-label={`depende de ${dependency.order}. ${dependency.title}${dependency.satisfied ? ' (concluída)' : ''} — localizar no quadro`}
                          onClick={() => locateItem(dependency.id)}
                        >
                          <span className="pb-dep-icon" aria-hidden="true">
                            {dependency.satisfied ? '✓' : '▸'}
                          </span>
                          <span className="pb-dep-num">{dependency.order}</span>
                        </button>
                      ))}
                    </span>
                  )}
                </span>
                {tier && <span className="pb-tier">{tier}</span>}

                {/* OS DOIS VERBOS DO DONO (2026-08-17): começar — "criar
                    missão", que já existia — e EXCLUIR. Eles dividem UMA célula
                    da grade: abrir coluna nova empurraria o título do item para
                    reticências em toda largura. */}
                <span className="pb-actions">
                  {discarding === item.id ? (
                    /* Confirmação INLINE: a pergunta TROCA as ações da linha.
                       Diálogo nativo quebra o foco da janela no Windows, e um
                       overlay rouba a tela inteira por um gesto pequeno. */
                    <span
                      className="pb-confirm"
                      role="group"
                      aria-label={`excluir "${item.title}" do plano?`}
                    >
                      <span className="pb-confirm-q">excluir?</span>
                      <button
                        className="btn ghost tiny danger"
                        disabled={Boolean(pending)}
                        onClick={() => {
                          setDiscarding('')
                          void run(`descartar:${item.id}`, () =>
                            plansApi.update(
                              plan.id,
                              { items: [{ id: item.id, status: 'descartada' }] },
                              plan.updatedAt
                            )
                          )
                        }}
                      >
                        sim
                      </button>
                      <button className="btn ghost tiny" onClick={() => setDiscarding('')}>
                        não
                      </button>
                    </span>
                  ) : (
                    <>
                      {link.kind === 'linked' ? (
                        <button
                          className={`pb-mission${link.pulse.waiting ? ' asking' : ''}`}
                          data-tip={`${link.mission.title}\nclique para abrir a missão no Board`}
                          onClick={() =>
                            openMission(
                              link.mission.id,
                              link.mission.status === 'ativa' ||
                                link.mission.status === 'integrando'
                            )
                          }
                        >
                          <span className={`pb-dot ${link.pulse.dot}`} aria-hidden="true" />
                          <span className="pb-mission-label">{link.pulse.label}</span>
                        </button>
                      ) : link.kind === 'missing' ? (
                        <span className="pb-note">missão removida</span>
                      ) : !planItemCanStart(item.status) ? (
                        /* CONCLUÍDA (por fora, sem missão vinculada — o caso
                           real do Painel) e DESCARTADA: trabalho que já
                           aconteceu ou saiu do plano não oferece "criar
                           missão" — a mesma régua do excluir, um verbo só onde
                           ainda há trabalho. */
                        <span className="pb-note">{state.label}</span>
                      ) : (
                        /* A TRAVA DO DONO SOBRE O PRÓPRIO PLANO (rodada 8):
                           enquanto uma dependência estiver pendente, o verbo
                           "começar" fica desabilitado e a dica NOMEIA quem está
                           segurando — mais as duas saídas sancionadas (concluir
                           a dependida ou tirá-la do plano). A dica mora no
                           invólucro porque botão desabilitado não recebe
                           mouseover no Chromium: pendurada nele, ela nunca
                           apareceria justamente onde é necessária. */
                        <span
                          className={`pb-gate${blockedBy ? ' locked' : ''}`}
                          data-tip={
                            blockedBy
                              ? `esperando: ${blockedBy.join(', ')}\ndestrava quando essas missões forem concluídas — ou quando você tirá-las do plano`
                              : 'Abre a nova missão com o título e o objetivo deste item já preenchidos'
                          }
                        >
                          <button
                            className="btn ghost tiny pb-create"
                            disabled={Boolean(pending) || Boolean(blockedBy)}
                            onClick={() => setCreatingFor(item)}
                          >
                            criar missão
                          </button>
                        </span>
                      )}
                      {planItemCanDiscard(item.status) && (
                        <button
                          className="btn ghost tiny danger pb-discard"
                          disabled={Boolean(pending)}
                          data-tip="Tira esta missão do plano: ela sai do progresso e deixa de segurar a publicação da versão. Se já virou missão, a missão continua no Board."
                          onClick={() => setDiscarding(item.id)}
                        >
                          excluir
                        </button>
                      )}
                    </>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {creatingFor && (
        <NewMissionModal
          projectId={projectId}
          initialTitle={creatingFor.title}
          initialGoal={planItemMissionGoal(creatingFor)}
          onClose={() => setCreatingFor(null)}
          onCreated={async (mission) => {
            const item = creatingFor
            setCreatingFor(null)
            if (!item) return
            // Uma escrita, no mesmo gesto: a missão nasceu, o item passa a
            // apontar para ela. CAS com o `updatedAt` que esta tela mostrou.
            const result = await plansApi.linkMission(
              plan.id,
              item.id,
              mission.id,
              plan.updatedAt
            )
            if (!result.ok) setMessage(result.error)
            onChanged()
            // A TELA VAI ATRÁS DA MISSÃO (ordem do dono, 19/08): criar do
            // quadro leva DIRETO ao chat recém-nascido — que abre MUDO, como
            // sempre (o agente só fala depois da primeira mensagem dele). O
            // Backlog e o Board já faziam isso; o quadro era o único que
            // deixava o dono para trás.
            setMissionTab(projectId, mission.id)
            setUniverseTab(projectId, 'board')
          }}
        />
      )}

      {confirmRemove && (
        <div className="overlay" onClick={() => setConfirmRemove(false)}>
          <div className="task-modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="task-modal-head">
              <span className="task-dept">excluir plano</span>
              <button className="pane-close dark-close" onClick={() => setConfirmRemove(false)}>
                ×
              </button>
            </div>
            <p className="confirm-text">
              Excluir o plano <b>{plan.title.trim() || 'sem título'}</b>?
            </p>
            <p className="confirm-sub">
              A aba dele some e os {plan.items.length} item(ns) do plano se perdem — não dá para
              desfazer. As missões já criadas continuam no Board. Para guardar o plano sem apagar,
              use arquivar.
            </p>
            <div className="task-modal-actions">
              <button className="btn ghost" onClick={() => setConfirmRemove(false)}>
                cancelar
              </button>
              <span className="task-modal-meta" />
              <button
                className="btn danger-solid"
                disabled={Boolean(pending)}
                onClick={() => {
                  setConfirmRemove(false)
                  void run('excluir', () => plansApi.remove(plan.id, plan.updatedAt))
                }}
              >
                excluir plano
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
