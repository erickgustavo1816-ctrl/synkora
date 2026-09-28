/**
 * O LEITOR DAS CONVERSAS DO CHAT, do lado do pane (R24 + 2026-09-28).
 *
 * Mora fora do GuiPane de propósito (o arquivo passou de 2900 linhas): aqui
 * ficam os GESTOS — abrir pela linha do topo, paginar por faixa de bytes e
 * navegar entre as conversas do chat. As decisões (quando a linha aparece,
 * qual conversa abrir, a posição "K de N") são puras e moram em
 * `guiHistoryReader.ts`; o DOM (rolagem, alvo selecionado) continua no pane.
 *
 * Toda leitura aberta pelo pane carrega o `sessionId` da conversa ABERTA: é
 * ele que a página seguinte pede de volta, senão o main paginaria a conversa
 * atual por baixo de uma anterior.
 */
import { useCallback, useMemo, useRef, useState, type RefObject } from 'react'
import { useStore, type GuiHistoryTarget, type GuiItem } from './store'
import {
  guiHistoryOpenPlan,
  guiHistoryPageRequest,
  guiThreadTopLine,
  type GuiThreadTopLine
} from './guiHistoryReader'
import type {
  HistoryPaneConversation,
  HistoryPaneConversationsResult,
  HistoryPaneLoadResult
} from '../../preload/index'

const OPEN_FAILED = 'não consegui abrir a conversa completa agora'
const NO_BRIDGE = 'esta janela não tem a ponte de histórico — reabra o Synkora'
const NAVIGATE_FAILED = 'não consegui abrir essa conversa agora — tente de novo ou volte à conversa atual'

/** O alvo do store a partir da leitura do main. `null` = leitura sem o
 *  mínimo para desenhar (sem conversa, sem falas). */
function historyTargetFrom(
  paneId: string,
  result: HistoryPaneLoadResult,
  conversations: HistoryPaneConversation[] | undefined
): GuiHistoryTarget | null {
  if (!result.ok || !result.provider || !result.sessionId || !result.messages) return null
  return {
    paneId,
    sessionId: result.sessionId,
    provider: result.provider,
    messages: result.messages,
    targetMessageId: result.targetMessageId ?? '',
    targetCursor: result.targetCursor ?? 0,
    truncated: result.truncated === true,
    hasMoreBefore: result.hasMoreBefore === true,
    hasMoreAfter: result.hasMoreAfter === true,
    ...(conversations ? { conversations } : {})
  }
}

export interface GuiConversationHistory {
  /** A linha do topo do fio; `null` = nada fora da tela. */
  topLine: GuiThreadTopLine | null
  opening: boolean
  /** Recusa da ABERTURA — desenhada sob a linha do topo. */
  error: string | null
  paging: 'before' | 'after' | null
  navigating: boolean
  /** Aviso DENTRO do leitor (página vazia, página ou navegação recusada). */
  pageNote: string | null
  open: () => Promise<void>
  loadPage: (direction: 'before' | 'after') => Promise<void>
  navigate: (sessionId: string) => Promise<void>
  /** Altura da lista ANTES da página anterior entrar — o pane compensa a
   *  rolagem com ela para o texto sob os olhos não fugir. */
  prependHeightRef: RefObject<number | null>
}

export function useGuiConversationHistory({
  paneId,
  items,
  prunedEvents,
  historyTarget,
  threadRef
}: {
  paneId: string
  items: readonly GuiItem[]
  prunedEvents: number
  historyTarget: GuiHistoryTarget | null
  threadRef: RefObject<HTMLDivElement | null>
}): GuiConversationHistory {
  const showGuiHistoryTarget = useStore((s) => s.showGuiHistoryTarget)
  const appendGuiHistoryPage = useStore((s) => s.appendGuiHistoryPage)
  // Estado local de propósito: é gesto, não fio.
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paging, setPaging] = useState<'before' | 'after' | null>(null)
  const [navigating, setNavigating] = useState(false)
  const [pageNote, setPageNote] = useState<string | null>(null)
  const prependHeightRef = useRef<number | null>(null)
  const topLine = useMemo(() => guiThreadTopLine(prunedEvents, items), [prunedEvents, items])

  const open = useCallback(async (): Promise<void> => {
    const history = window.synkora?.history
    const reader = history?.loadForPane
    if (!reader || !topLine) {
      setError(NO_BRIDGE)
      return
    }
    setOpening(true)
    setError(null)
    // Leitura nova não herda a compensação de scroll de uma página anterior.
    prependHeightRef.current = null
    try {
      // A lista é o que arma a navegação. Falhar em listá-la não impede abrir
      // a conversa atual (a poda de sempre); só a "conversa anterior" depende
      // dela — e aí a recusa do main (que nomeia a receita) vai para a tela.
      let listing: HistoryPaneConversationsResult | null = null
      try {
        listing = history?.paneConversations ? await history.paneConversations(paneId) : null
      } catch {
        listing = null
      }
      const plan = guiHistoryOpenPlan(topLine, listing)
      if (plan.kind === 'missing') {
        setError(plan.error)
        return
      }
      const result =
        plan.kind === 'current'
          ? await reader(paneId)
          : await reader(paneId, undefined, plan.sessionId)
      const target = historyTargetFrom(
        paneId,
        result,
        listing?.ok ? listing.conversations : undefined
      )
      if (!target) {
        setError(result.error ?? OPEN_FAILED)
        return
      }
      setPageNote(null)
      showGuiHistoryTarget(target)
    } catch {
      setError(OPEN_FAILED)
    } finally {
      setOpening(false)
    }
  }, [paneId, showGuiHistoryTarget, topLine])

  const loadPage = useCallback(
    async (direction: 'before' | 'after'): Promise<void> => {
      if (paging || navigating) return
      const reader = window.synkora?.history?.loadForPane
      const request = historyTarget
        ? guiHistoryPageRequest(historyTarget.messages, direction)
        : null
      if (!reader || !request || !historyTarget) {
        setPageNote('não consegui carregar esse trecho agora — reabra a conversa completa')
        return
      }
      const sessionId = historyTarget.sessionId
      setPaging(direction)
      setPageNote(null)
      try {
        const result = await reader(paneId, request, sessionId)
        if (!result.ok || !result.messages) {
          setPageNote(result.error ?? 'não consegui carregar esse trecho agora')
          return
        }
        if (result.messages.length === 0) {
          // Faixa só de ferramenta: o botão continua e o clique seguinte anda
          // mais um pedaço — o dono nunca fica sem próximo passo.
          setPageNote(
            direction === 'before'
              ? 'esse trecho não tinha falas — clique de novo para continuar subindo'
              : 'esse trecho não tinha falas — clique de novo para continuar descendo'
          )
        }
        if (direction === 'before') {
          prependHeightRef.current = threadRef.current?.scrollHeight ?? null
        }
        appendGuiHistoryPage(paneId, {
          direction,
          messages: result.messages,
          hasMore:
            direction === 'before' ? result.hasMoreBefore === true : result.hasMoreAfter === true,
          sessionId: result.sessionId ?? sessionId
        })
      } catch {
        setPageNote('não consegui carregar esse trecho agora')
      } finally {
        setPaging(null)
      }
    },
    [appendGuiHistoryPage, historyTarget, navigating, paging, paneId, threadRef]
  )

  const navigate = useCallback(
    async (sessionId: string): Promise<void> => {
      const reader = window.synkora?.history?.loadForPane
      if (!historyTarget || navigating || paging || sessionId === historyTarget.sessionId) return
      if (!reader) {
        setPageNote(NO_BRIDGE)
        return
      }
      const from = historyTarget.sessionId
      const conversations = historyTarget.conversations
      setNavigating(true)
      setPageNote(null)
      prependHeightRef.current = null
      try {
        // Sem página: o main abre a atual no começo e as anteriores no FIM.
        const result = await reader(paneId, undefined, sessionId)
        // O dono fechou o leitor (ou já está noutra conversa) enquanto a
        // leitura viajava: ela não reabre nada por cima da conversa viva.
        const live = useStore.getState().guiHistoryTarget
        if (!live || live.paneId !== paneId || live.sessionId !== from) return
        const target = historyTargetFrom(paneId, result, conversations)
        if (!target) {
          setPageNote(result.error ?? NAVIGATE_FAILED)
          return
        }
        showGuiHistoryTarget(target)
      } catch {
        setPageNote(NAVIGATE_FAILED)
      } finally {
        setNavigating(false)
      }
    },
    [historyTarget, navigating, paging, paneId, showGuiHistoryTarget]
  )

  return {
    topLine,
    opening,
    error,
    paging,
    navigating,
    pageNote,
    open,
    loadPage,
    navigate,
    prependHeightRef
  }
}
