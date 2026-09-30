import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import type { GuiPaneSpawn, GuiPermissionMode } from './guiApi'
import { missionGui, type MissionGuiRole } from './missionGui'
import { GuiRequestEpoch, withoutMissionGuiSlots } from './guiRequestEpoch'

// OS SLOTS DE CHAT DA MISSÃO DIRETA — um hook, duas telas (2026-09-30).
//
// Morava inteiro dentro do Board: o pedido da spec do agente ao entrar na
// missão, o card de escolha de conta, as épocas que descartam a spec pedida
// com a conta anterior, a troca de conta e a soltura das sessões de missão que
// deixou de viver. O projeto SEM VERSIONAMENTO abre a mesma conversa pelo
// mesmo caminho, então a mecânica saiu para cá — o Board e a tela nova só
// dizem QUAL missão está em cena e desenham o resultado.
//
// Quem hospeda continua dono do que é dele: terminais no palco, avisos e o
// toque de revisão. `onChatFocus` é a única ponte: toda vez que uma conversa
// vem para a frente, quem hospeda tira o terminal do caminho.

/** Uma conversa aberta de uma missão DIRETA (onda B). O papel não viaja na
 *  spec — é quem pediu que sabe por que pediu cada uma. */
export interface MissionGuiSlot {
  role: MissionGuiRole
  spawn: GuiPaneSpawn
}

export const MISSION_GUI_ROLE_LABEL: Record<MissionGuiRole, string> = {
  dev: 'agente',
  reviewer: 'revisor',
  helper: 'ajudante'
}

export interface MissionChatSlotsOptions {
  projectId: string
  /** o projeto está na tela: só ele pede spec (cada slot é um CLI de verdade) */
  isActive: boolean
  /** a missão em cena — o chat do agente abre quando o dono entra nela */
  mission: { id: string; direct?: boolean } | undefined
  /** as missões do projeto: a que deixa de viver solta as conversas dela */
  missions: readonly { id: string; status: string }[]
  /** uma conversa veio para a frente: quem hospeda tira o terminal do palco */
  onChatFocus?: (missionId: string) => void
}

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map
  const next = { ...map }
  delete next[key]
  return next
}

export function useMissionChatSlots({
  projectId,
  isActive,
  mission,
  missions,
  onChatFocus
}: MissionChatSlotsOptions) {
  const loadMissions = useStore((s) => s.loadMissions)
  const dropGuiPane = useStore((s) => s.dropGuiPane)
  // Todas ficam MONTADAS depois de abertas (a conversa É o trabalho); trocar
  // de papel só troca qual slot está visível.
  const [slots, setSlots] = useState<Record<string, MissionGuiSlot[]>>({})
  const [active, setActive] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  // Missão sem conta escolhida (2.0): não é erro — é o CARD de escolha no
  // lugar da conversa. `seatBusy` trava o card enquanto o main troca a conta.
  const [needsSeat, setNeedsSeat] = useState<Record<string, boolean>>({})
  const [seatBusy, setSeatBusy] = useState<string | null>(null)
  // A geração é o valor, não só uma trava booleana: uma Promise velha
  // nunca pode apagar a trava do pedido novo que reutilizou a mesma chave.
  const missionGuiInFlight = useRef<Map<string, number>>(new Map())
  const missionGuiEpoch = useRef(new GuiRequestEpoch())
  const seatChangeInFlight = useRef(false)
  const focusRef = useRef(onChatFocus)
  focusRef.current = onChatFocus

  // Nada nasce em segundo plano (cada slot é um CLI de verdade): o chat do
  // agente abre quando o dono ENTRA na missão pela primeira vez e daí em
  // diante fica montado. A guarda de voo evita o fetch duplo enquanto o 1º
  // `guiSpec` viaja — o efeito redispara antes de o estado chegar.
  useEffect(() => {
    if (!isActive || !mission?.direct) return
    const mid = mission.id
    if (slots[mid]?.length) return
    const key = `${mid}:dev`
    const captured = missionGuiEpoch.current.capture(mid)
    if (missionGuiInFlight.current.get(key) === captured) return
    missionGuiInFlight.current.set(key, captured)
    void missionGui
      .spec(mid, 'dev')
      .then((res) => {
        if (!missionGuiEpoch.current.isCurrent(mid, captured)) return
        if (!res.ok || !res.spawn) {
          // Falta de conta tem tela PRÓPRIA (o card de escolha) — tratá-la
          // como erro mandaria o dono procurar um problema que não existe.
          if (res.needsSeat) {
            setNeedsSeat((prev) => ({ ...prev, [mid]: true }))
            return
          }
          setErrors((prev) => ({
            ...prev,
            [mid]: res.error ?? 'não deu para abrir a conversa desta missão'
          }))
          return
        }
        setNeedsSeat((prev) => withoutKey(prev, mid))
        const spawn = res.spawn
        setSlots((prev) => (prev[mid]?.length ? prev : { ...prev, [mid]: [{ role: 'dev', spawn }] }))
        setActive((prev) => ({ ...prev, [mid]: spawn.paneId }))
        setErrors((prev) => withoutKey(prev, mid))
      })
      .finally(() => {
        if (missionGuiInFlight.current.get(key) === captured) missionGuiInFlight.current.delete(key)
      })
  }, [isActive, mission?.id, mission?.direct, slots])

  // Missão saiu de viva: as sessões dela morrem no main (gui:kill) e os slots
  // somem. Missão AUSENTE da lista não conta: uma fotografia incompleta não
  // autoriza encerrar a conversa.
  // A soltura acontece AQUI, no efeito, e não dentro do updater do setState:
  // `dropGuiPane` escreve no store, e o updater roda na fase de render quando
  // o componente já tem outra atualização na fila (o finalizar recarrega a
  // lista e troca a aba) — o React acusava "Cannot update a component while
  // rendering a different component".
  const slotsRef = useRef(slots)
  slotsRef.current = slots
  useEffect(() => {
    const ended = Object.keys(slotsRef.current).filter((id) => {
      const m = missions.find((x) => x.id === id)
      return Boolean(m && (m.status === 'concluida' || m.status === 'arquivada'))
    })
    if (ended.length === 0) return
    for (const id of ended) for (const slot of slotsRef.current[id]) dropGuiPane(slot.spawn.paneId)
    setSlots((prev) => {
      const next = { ...prev }
      for (const id of ended) delete next[id]
      return next
    })
  }, [missions, dropGuiPane])

  /** Traz uma conversa para a frente (a pílula do palco, um aviso, o toque). */
  const focus = useCallback((missionId: string, paneId: string): void => {
    setActive((prev) => ({ ...prev, [missionId]: paneId }))
  }, [])

  /** Abre (ou volta o foco para) uma conversa da missão direta.
   *
   *  ONDA W3 (ordem do dono, 2026-08-18): o AJUDANTE não nasce de clique
   *  nenhum — quem o abre é o agente do chat, pelo `delegate` do MCP. A cerca
   *  é o TIPO do parâmetro: pedir esse papel por aqui é erro de compilação. */
  async function openRole(missionId: string, role: Exclude<MissionGuiRole, 'helper'>): Promise<void> {
    const current = slots[missionId] ?? []
    // Todo papel que a UI ainda abre é ÚNICO por missão: clicar de novo volta
    // o foco para a rodada em andamento.
    const existing = current.find((s) => s.role === role)
    if (existing) {
      focusRef.current?.(missionId)
      focus(missionId, existing.spawn.paneId)
      return
    }
    const key = `${missionId}:${role}`
    const captured = missionGuiEpoch.current.capture(missionId)
    if (missionGuiInFlight.current.get(key) === captured) return
    missionGuiInFlight.current.set(key, captured)
    const res = await missionGui.spec(missionId, role)
    if (missionGuiInFlight.current.get(key) === captured) missionGuiInFlight.current.delete(key)
    if (!missionGuiEpoch.current.isCurrent(missionId, captured)) return
    if (!res.ok || !res.spawn) {
      // Sem conta escolhida NENHUM papel abre — e a resposta é o card de
      // escolha, não um erro.
      if (res.needsSeat) {
        setNeedsSeat((prev) => ({ ...prev, [missionId]: true }))
        return
      }
      setErrors((prev) => ({
        ...prev,
        [missionId]: res.error ?? `não deu para abrir ${MISSION_GUI_ROLE_LABEL[role]}`
      }))
      return
    }
    const spawn = res.spawn
    setSlots((prev) => {
      const cur = prev[missionId] ?? []
      if (cur.some((s) => s.spawn.paneId === spawn.paneId)) return prev
      return { ...prev, [missionId]: [...cur, { role, spawn }] }
    })
    focusRef.current?.(missionId)
    focus(missionId, spawn.paneId)
  }

  /** "⟳ tentar de novo": o erro sai da tela e o agente é pedido outra vez. */
  function retry(missionId: string): void {
    setErrors((prev) => withoutKey(prev, missionId))
    void openRole(missionId, 'dev')
  }

  const patchSpawn = useCallback(
    (missionId: string, paneId: string, patch: Partial<GuiPaneSpawn>): void => {
      setSlots((prev) => {
        const cur = prev[missionId]
        if (!cur) return prev
        return {
          ...prev,
          [missionId]: cur.map((s) =>
            s.spawn.paneId === paneId ? { ...s, spawn: { ...s.spawn, ...patch } } : s
          )
        }
      })
    },
    []
  )

  /** O modo de permissão escolhido NO CHAT: o slot remontado nasce com a regra
   *  certa em vez de voltar ao padrão (o motor também persiste do lado dele). */
  const setPermission = useCallback(
    (missionId: string, paneId: string, permissionMode: GuiPermissionMode): void =>
      patchSpawn(missionId, paneId, { permissionMode }),
    [patchSpawn]
  )

  /** R11: o toggle ⚡ fast do chat — também é flag de spawn. */
  const setFast = useCallback(
    (missionId: string, paneId: string, fast: boolean): void =>
      patchSpawn(missionId, paneId, { fast: fast || undefined }),
    [patchSpawn]
  )

  /** Modelo/effort trocados NO CHAT: a remontagem não volta ao executor antigo. */
  const setExecutor = useCallback(
    (missionId: string, paneId: string, patch: { model?: string; effort?: string }): void =>
      patchSpawn(missionId, paneId, patch),
    [patchSpawn]
  )

  /**
   * A CONTA DA CONVERSA (2.0): vale para o card da missão sem conta e para o
   * chip do cabeçalho. O main transplanta a conversa quando o CLI é o mesmo e
   * MATA as sessões vivas (elas falavam pela conta antiga) — aqui os slots
   * são descartados e o chat reabre já na conta nova.
   */
  async function chooseChatSeat(missionId: string, seatId: string): Promise<void> {
    if (seatChangeInFlight.current) return
    seatChangeInFlight.current = true
    // Specs pedidas antes deste ponto pertencem à conta anterior.
    missionGuiEpoch.current.invalidate(missionId)
    setErrors((prev) => withoutKey(prev, missionId))
    setSeatBusy(seatId)
    try {
      const res = await missionGui.setChatSeat(projectId, missionId, seatId)
      if (!res.ok) {
        setErrors((prev) => ({
          ...prev,
          [missionId]: res.msg ?? 'não deu para escolher a conta desta conversa'
        }))
        return
      }
      for (const slot of slots[missionId] ?? []) dropGuiPane(slot.spawn.paneId)
      setSlots((prev) => withoutMissionGuiSlots(prev, missionId))
      setNeedsSeat((prev) => withoutKey(prev, missionId))
      setErrors((prev) => withoutKey(prev, missionId))
      await loadMissions(projectId)
      // NÃO chamar openRole daqui: esta closure ainda enxerga os slots antigos
      // e focaria o pane que o main acabou de matar. A remoção acima dispara o
      // efeito canônico de slots vazios, que pede uma spec nova já resolvida
      // para a conta nova.
    } catch {
      setErrors((prev) => ({ ...prev, [missionId]: 'não deu para trocar a conta desta conversa' }))
    } finally {
      setSeatBusy(null)
      seatChangeInFlight.current = false
    }
  }

  /** Fecha UMA conversa (revisor/ajudante). O chat do agente não fecha por
   *  aqui: ele é a missão. */
  function closeSlot(missionId: string, paneId: string): void {
    dropGuiPane(paneId)
    const rest = (slots[missionId] ?? []).filter((s) => s.spawn.paneId !== paneId)
    setSlots((prev) => ({ ...prev, [missionId]: rest }))
    setActive((prev) =>
      prev[missionId] === paneId ? { ...prev, [missionId]: rest[0]?.spawn.paneId ?? '' } : prev
    )
  }

  return {
    slots,
    active,
    errors,
    needsSeat,
    seatBusy,
    focus,
    openRole,
    retry,
    chooseSeat: chooseChatSeat,
    closeSlot,
    setPermission,
    setFast,
    setExecutor
  }
}

export type MissionChatSlots = ReturnType<typeof useMissionChatSlots>
