import { useCallback, useEffect, useMemo, useState } from 'react'
import { missionTypeOf, useStore, type Mission, type Version } from '../store'
import { missionChatSummary, missionChatLabel, type MissionChatSummary } from '../guiMissionPanes'
import { isReleaseMissionRecord } from '../missionCardAccess'
import { integrationShortLine } from '../integrationQueuePresentation'

// ————————————————————————————————————————————————————————————————————————
// QUADRO DE ROTAS — a aba MAPA do mockup aprovado (docs/MOCKUP_WORKSPACE.md).
//
// "A aba MAPA mostra O PLANEJAMENTO — o quadro de rotas: linha = versão
//  (aberta em destaque, lançada apagada ✓), colunas = backlog · rodando ·
//  fila ⇪ · integrada, ficha = missão (dot de status; âmbar pulsando quando
//  espera o dono). Clique na ficha abre a missão no Board."
//
// A CONSTELAÇÃO ficou dormente (o código dela segue intacto em
// ConstellationMap.tsx, sem nenhum ponto de montagem): mapa cósmico é bonito e
// não responde a pergunta nenhuma de planejamento — este quadro responde as
// duas que o dono faz o dia inteiro ("o que está rodando?" e "o que já subiu
// em qual versão?").
//
// Não roda processo nenhum: monta/desmonta com a aba, sem rAF e sem canvas.
// ————————————————————————————————————————————————————————————————————————

/** As quatro colunas do mockup, na ordem em que o trabalho anda. */
type RouteLane = 'backlog' | 'rodando' | 'fila' | 'integrada'

const LANE_LABEL: Record<RouteLane, string> = {
  backlog: 'backlog',
  rodando: 'rodando',
  fila: 'fila ⇪',
  integrada: 'integrada'
}

const LANES: RouteLane[] = ['backlog', 'rodando', 'fila', 'integrada']

/**
 * Em que coluna esta missão está AGORA. A régua é o estado do motor, nunca
 * um campo novo: fila = tem ticket (ou o dono foi chamado para o ⇪);
 * rodando = conversa viva no worktree; backlog = viva e sem nada aberto.
 */
function laneOf(mission: Mission, chat: MissionChatSummary): RouteLane {
  if (mission.status === 'concluida') return 'integrada'
  if (mission.status === 'integrando' || mission.integration || mission.pendingIntegrationApproval)
    return 'fila'
  return chat.live > 0 ? 'rodando' : 'backlog'
}

/** Estado do ponto: o que EXIGE o dono vence o que está só andando. */
function dotOf(mission: Mission, chat: MissionChatSummary): string {
  if (chat.attention || mission.pendingIntegrationApproval) return 'ask'
  if (mission.integration?.state === 'blocked') return 'err'
  if (mission.status === 'concluida') return 'done'
  if (mission.status === 'integrando' || chat.running > 0) return 'busy'
  return 'ok'
}

/** Linha curta embaixo do título — o que esta missão está fazendo. */
function noteOf(mission: Mission, chat: MissionChatSummary): string {
  if (mission.pendingIntegrationApproval) return 'esperando seu ⇪'
  // Planejamento CONCLUI, não integra: "integrada" prometeria um merge que
  // nunca existiu — ele escreve plano/ na raiz e encerra.
  if (mission.status === 'concluida')
    return missionTypeOf(mission) === 'planejamento' ? 'concluída' : 'integrada'
  if (mission.status === 'integrando') return 'mesclando agora'
  // O VOCABULÁRIO da fila é um só (rodada 9): a mesma missão não pode se ler
  // "fila #1" aqui e "com o agente" no trilho. A régua nova entra de graça —
  // cabeça com erro vira conflito EM RESOLUÇÃO, nunca uma fila parada.
  if (mission.integration) return integrationShortLine(mission.integration)
  return missionChatLabel(chat)
}

interface RouteRow {
  key: string
  name: string
  released: boolean
  /** ordena as linhas: abertas primeiro (mais antiga em cima), lançadas depois */
  order: number
  /** a linha do PLANEJAMENTO: fora de versão por régua de nascimento — glifo ✎
   *  e contagem "concluídas" (planejamento conclui, não integra) */
  planning?: boolean
  missions: Mission[]
}

export default function MissionRouteBoard({
  projectId
}: {
  projectId: string
}): React.JSX.Element {
  const missions = useStore((s) => s.missions)
  const guiPanes = useStore((s) => s.guiPanes)
  const setUniverseTab = useStore((s) => s.setUniverseTab)
  const setMissionTab = useStore((s) => s.setMissionTab)

  const [versions, setVersions] = useState<Version[]>([])
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const list = await window.synkora.backlog.listVersions(projectId)
    setVersions(list)
    setLoaded(true)
  }, [projectId])

  // As versões mudam pelos mesmos eventos das missões (integrar, lançar).
  useEffect(() => {
    void refresh()
    const off = window.synkora.missions?.onChanged?.((pid: string) => {
      if (pid === projectId) void refresh()
    })
    return () => off?.()
  }, [projectId, refresh])

  const mine = useMemo(
    () =>
      missions.filter(
        (m) =>
          m.projectId === projectId &&
          m.status !== 'arquivada' &&
          // R27 — o registro de release não é missão de superfície: no quadro
          // de rota ele aparecia como card RODANDO e inflava o "N/M
          // integradas" da versão (o 8/9 que o dono viu).
          !isReleaseMissionRecord(m)
      ),
    [missions, projectId]
  )

  // Pulso das conversas por missão. Assinatura ENXUTA: `gui:live` dispara a
  // cada delta do turno e re-derivar a grade inteira a cada frame seria caro à
  // toa (a mesma lição do mapa antigo).
  const chats = useMemo(() => {
    const out: Record<string, MissionChatSummary> = {}
    for (const m of mine) out[m.id] = missionChatSummary(m.id, guiPanes)
    return out
  }, [mine, guiPanes])

  const rows = useMemo<RouteRow[]>(() => {
    const byId = new Map<string, RouteRow>()
    const abertas = versions
      .filter((v) => v.status === 'aberta')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const lancadas = versions
      .filter((v) => v.status === 'lancada')
      .sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? ''))
    abertas.forEach((v, i) =>
      byId.set(v.id, { key: v.id, name: v.name, released: false, order: i, missions: [] })
    )
    lancadas.forEach((v, i) =>
      byId.set(v.id, {
        key: v.id,
        name: v.name,
        released: true,
        order: 1000 + i,
        missions: []
      })
    )
    // Missão VIVA sem carimbo cai na versão CORRENTE (a aberta mais antiga) —
    // é nela que ela vai integrar. Sem nenhuma versão aberta, linha própria.
    const corrente = abertas[0]?.id
    const loose: RouteRow = {
      key: '__sem-versao__',
      name: 'sem versão',
      released: false,
      order: 999,
      missions: []
    }
    // PLANEJAMENTO NÃO PERTENCE A VERSÃO (régua do nascimento, NewMissionModal):
    // ele escreve plano/ na raiz e nunca integra em linha nenhuma. Cair na
    // corrente ("é nela que ela vai integrar" — falso aqui) ou na "sem versão"
    // (como se faltasse um carimbo) mentiria das duas formas; a linha é própria.
    const plano: RouteRow = {
      key: '__planejamento__',
      name: 'planejamento',
      released: false,
      order: 998,
      planning: true,
      missions: []
    }
    for (const m of mine) {
      if (missionTypeOf(m) === 'planejamento') {
        plano.missions.push(m)
        continue
      }
      const target =
        (m.versionId && byId.get(m.versionId)) ||
        (m.status !== 'concluida' && corrente ? byId.get(corrente) : undefined)
      ;(target ?? loose).missions.push(m)
    }
    const out = [...byId.values()]
    if (plano.missions.length) out.push(plano)
    if (loose.missions.length) out.push(loose)
    return out
      .filter((row) => row.missions.length > 0 || !row.released)
      .sort((a, b) => a.order - b.order)
  }, [versions, mine])

  const open = useCallback(
    (missionId: string, live: boolean): void => {
      setUniverseTab(projectId, 'board')
      // Missão já integrada não tem aba própria no board (só as VIVAS ficam na
      // coluna): abrir o ✦ geral é o destino honesto.
      setMissionTab(projectId, live ? missionId : null)
    },
    [projectId, setUniverseTab, setMissionTab]
  )

  if (!loaded) return <div className="routeboard routeboard-empty">lendo as rotas…</div>

  if (rows.length === 0)
    return (
      <div className="routeboard routeboard-empty">
        Nenhuma versão ainda — crie uma missão no Board e ela aparece aqui, na versão corrente.
      </div>
    )

  return (
    <div className="routeboard">
      {/* A legenda espelha a GRADE da linha (calha do nome + 4 colunas): é a
          única forma de os rótulos caírem exatamente sobre as colunas. */}
      <div className="rb-legend" aria-hidden="true">
        <span className="rb-legend-gutter" />
        <div className="rb-legend-lanes">
          {LANES.map((lane) => (
            <span key={lane} className={`rb-legend-item rb-${lane}`}>
              {LANE_LABEL[lane]}
            </span>
          ))}
        </div>
      </div>

      <div className="rb-rows">
        {rows.map((row) => {
          const byLane: Record<RouteLane, Mission[]> = {
            backlog: [],
            rodando: [],
            fila: [],
            integrada: []
          }
          for (const m of row.missions) byLane[laneOf(m, chats[m.id])].push(m)
          return (
            <section key={row.key} className={`rb-row${row.released ? ' released' : ''}`}>
              <header className="rb-row-head">
                <span className="rb-row-name">
                  {row.planning ? '✎' : '◈'} {row.name}
                  {row.released && <span className="rb-row-check"> ✓</span>}
                </span>
                <span className="rb-row-count">
                  {byLane.integrada.length}/{row.missions.length}{' '}
                  {row.planning ? 'concluídas' : 'integradas'}
                </span>
              </header>
              <div className="rb-lanes">
                {LANES.map((lane) => (
                  <div key={lane} className={`rb-lane rb-${lane}`}>
                    <span className="rb-lane-label">{LANE_LABEL[lane]}</span>
                    {byLane[lane].length === 0 && <span className="rb-lane-empty">—</span>}
                    {byLane[lane].map((m) => {
                      const chat = chats[m.id]
                      const live = m.status === 'ativa' || m.status === 'integrando'
                      return (
                        <button
                          key={m.id}
                          className={`rb-card${chat.attention || m.pendingIntegrationApproval ? ' asking' : ''}`}
                          data-tip={`${m.title}\n${
                            row.planning
                              ? '✎ planejamento · escreve plano/'
                              : (m.branch ?? 'sem branch')
                          } · ${noteOf(m, chat)}${
                            live ? '\nclique para abrir a missão no Board' : ''
                          }`}
                          onClick={() => open(m.id, live)}
                        >
                          <span className="rb-card-head">
                            <span className={`rb-dot ${dotOf(m, chat)}`} aria-hidden="true" />
                            <span className="rb-card-title">{m.title}</span>
                          </span>
                          <span className="rb-card-note">{noteOf(m, chat)}</span>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
