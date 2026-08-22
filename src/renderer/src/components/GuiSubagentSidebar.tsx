import { useEffect, useMemo, useRef, useState } from 'react'
import {
  GUI_SUBAGENT_DISMISS_TIP,
  dismissGuiSubagentHelper,
  formatGuiSubagentElapsed,
  guiSubagentDismissable,
  guiSubagentElapsedMs,
  guiSubagentSidebarEntries,
  type GuiSubagentSidebarEntry
} from '../guiSubagentSidebar'
import type { GuiItem } from '../store'

/** A leitura de relance do dono: modelo, effort e conta na MESMA fileira. O
 *  nativo aposentado não informa effort nem conta — a etiqueta então some, em
 *  vez de mentir um valor. O fast é dito por extenso: o ⚡ da fileira é desenho,
 *  e "raio" não é o que o dono precisa ouvir. */
function metaLabel(entry: GuiSubagentSidebarEntry): string {
  const parts = [`Modelo: ${entry.model}`]
  if (entry.effort) parts.push(`Effort: ${entry.effort}`)
  if (entry.fast) parts.push('Fast: ligado')
  if (entry.seat) parts.push(`Conta: ${entry.seat}`)
  return parts.join(' · ')
}

/**
 * UM relógio para a lista INTEIRA (ordem do dono, 18/08: "há quanto tempo ele
 * tá trabalhando"). Um timer por ficha multiplicaria o custo pelo número de
 * ajudantes abertos — e o lote do dono abre cinco de uma vez.
 *
 * O tique é de 1s porque é assim que um cronômetro se lê: contando. Ele só
 * existe enquanto há ficha TRABALHANDO (`active`) — lateral vazia, ou só com
 * frota interrompida, não mantém timer de pé, porque cronômetro congelado não
 * pede tique — e a faxina do efeito o encerra na desmontagem do pane. Cada
 * ficha tem a própria fase (o `at` dela), então o relógio compartilhado nunca é
 * alinhado a todas: a leitura de uma ficha recém-aberta assenta no tique
 * seguinte, e o `setNow` de entrada re-sincroniza quando a seção volta a viver.
 */
function useGuiSubagentClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

function SubagentCard({
  entry,
  elapsedMs,
  dismissing,
  onDismiss
}: {
  entry: GuiSubagentSidebarEntry
  /** `null` = não há tempo trabalhado a mostrar nesta montagem (ficha que já
   *  voltou parada do anel) — a ficha então simplesmente não desenha relógio. */
  elapsedMs: number | null
  /** O descarte desta ficha está em voo: o botão para de aceitar clique (dois
   *  ✕ no mesmo ajudante fariam o segundo voltar como "já não existe"). */
  dismissing: boolean
  onDismiss: () => void
}): React.JSX.Element {
  // O zero do cronômetro é o carimbo FACTUAL do tool call, nunca a hora em que
  // a ficha apareceu na tela: replay de transcript e re-render não zeram nada.
  const elapsed = elapsedMs === null ? null : formatGuiSubagentElapsed(elapsedMs)
  const working = entry.status === 'running'
  return (
    // Cross-CLI é indistinguível por desenho: o CLI vira CARIMBO (estilo e
    // depuração), nunca mais um texto disputando a fileira de metadados.
    <article
      className={`gui-subagent-row ${entry.status}`}
      data-subagent-id={entry.toolUseId}
      data-subagent-status={entry.status}
      data-subagent-cli={entry.cli ?? undefined}
    >
      <header className="gui-subagent-row-head">
        <span className="gui-subagent-row-dot" aria-hidden="true" />
        <strong>{entry.name}</strong>
        {/* Fora da região viva do estado DE PROPÓSITO: um live region que muda
            a cada segundo faria o leitor de tela narrar o relógio para sempre.
            Parado, o verbo vai para o passado — o número é história, não um
            cronômetro que ainda anda. */}
        {elapsed && (
          <time
            className="gui-subagent-row-elapsed"
            aria-label={working ? `Trabalhando há ${elapsed}` : `Trabalhou ${elapsed}`}
          >
            {elapsed}
          </time>
        )}
        <span className="gui-subagent-row-status" role="status" aria-live="polite">
          {entry.statusLabel}
        </span>
        {/* O ✕ DA FROTA (R27F3): ele nasce da REGRA, nunca de um estado escrito
            à mão aqui — ficha parada COM ajudante no motor. No canto da fileira
            do topo, como no mockup aprovado: ghost em ink-3, vermelho no hover,
            e a dica que diz o preço inteiro do clique. */}
        {guiSubagentDismissable(entry) && (
          <button
            type="button"
            className="gui-subagent-row-dismiss"
            data-tip={GUI_SUBAGENT_DISMISS_TIP}
            aria-label={`Descartar o ajudante ${entry.name}`}
            disabled={dismissing}
            onClick={onDismiss}
          >
            ✕
          </button>
        )}
      </header>
      <div className="gui-subagent-row-meta" aria-label={metaLabel(entry)}>
        <span>{entry.model}</span>
        {entry.effort && <span>{entry.effort}</span>}
        {/* Ao lado do effort porque é a mesma pergunta — COMO ele foi aberto —,
            e antes da conta, que responde ONDE. A fileira já quebra sozinha. */}
        {entry.fast && <span>⚡ fast</span>}
        {entry.seat && <span>{entry.seat}</span>}
        {entry.type && <span>{entry.type}</span>}
      </div>
      <p className="gui-subagent-row-task" aria-label={`Tarefa: ${entry.task}`} title={entry.task}>
        {entry.task}
      </p>
      {entry.activity && (
        <p className="gui-subagent-row-activity">
          <span>agora</span>
          <span>{entry.activity}</span>
        </p>
      )}
      {entry.outcome && (
        <p className="gui-subagent-row-outcome" aria-label={`Desfecho: ${entry.outcome}`} title={entry.outcome}>
          {entry.outcome}
        </p>
      )}
    </article>
  )
}

/**
 * Seção da lateral de entrega. Sem fichas, não ocupa espaço nem deixa um
 * placeholder barulhento; a lista nasce no primeiro Task/Agent factual.
 */
export default function GuiSubagentSidebar({
  items
}: {
  items: readonly GuiItem[]
}): React.JSX.Element | null {
  // A normalização varre a lista inteira do pane; o trilho renderiza a cada
  // delta da conversa, então ela só roda quando os itens realmente mudam.
  const derived = useMemo(() => guiSubagentSidebarEntries(items), [items])
  /**
   * FICHAS QUE O MOTOR JÁ CONFIRMOU DESCARTADAS (R27F3).
   *
   * O descarte de verdade acontece no motor, e o caminho normal devolve a
   * verdade pelo fio: o `settled` do ajudante reescreve o card no anel e a ficha
   * sai daqui por conta própria. Este conjunto cobre o card que o anel trouxe de
   * uma geração ANTERIOR do app — o correlacionador nasce vazio com o processo e
   * não tem mais como reescrever aquele card —, e por isso ele só recebe id
   * DEPOIS de um `ok` do motor. Nada aqui esconde ficha: quem some já foi jogado
   * fora do outro lado, e uma ficha que o motor recusa continua na tela com o
   * motivo escrito.
   */
  const [dismissed, setDismissed] = useState<readonly string[]>([])
  const [dismissing, setDismissing] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const entries = useMemo(
    () => derived.filter((entry) => !dismissed.includes(entry.toolUseId)),
    [derived, dismissed]
  )
  const dismiss = (entry: GuiSubagentSidebarEntry): void => {
    if (!entry.helperId || dismissing) return
    setDismissing(entry.toolUseId)
    setNotice(null)
    void dismissGuiSubagentHelper(entry.helperId).then((outcome) => {
      setDismissing(null)
      if (outcome.ok) setDismissed((current) => [...current, entry.toolUseId])
      // Recusa do motor (ficha viva, entrega pronta) e falta de ponte viram
      // TEXTO ao pé da lista, onde o gesto aconteceu — nunca um clique mudo.
      else setNotice(outcome.error)
    })
  }
  // Antes do retorno vazio: a regra dos hooks não admite chamada condicional —
  // quem desliga o timer é o `active`, não o early return.
  const now = useGuiSubagentClock(entries.some((entry) => entry.status === 'running'))
  // A memória do cronômetro congelado vive por MONTAGEM da lateral: ela guarda
  // a última leitura viva de cada ficha e é dela que a ficha parada lê seu
  // número. Fora de um ref ela seria recriada a cada render e o congelamento
  // viraria um "0:00" novo a cada tique.
  const clockRef = useRef<Map<string, number> | null>(null)
  if (!clockRef.current) clockRef.current = new Map()
  const clock = clockRef.current
  if (entries.length === 0) {
    // SEÇÃO VAZIA NÃO EXISTE NESTE DOCK. Quando o card ainda está no anel (a
    // ficha veio de uma geração anterior do app e ninguém mais reescreve aquele
    // card), quem conta a frota lá fora ainda a conta — então o corpo da seção
    // diz o que aconteceu, em vez de ficar em branco sob um cabeçalho. Com o
    // anel em dia o card some sozinho e a seção inteira fecha, como sempre.
    return derived.length > 0 ? (
      <p className="gui-subagent-note quiet" role="status">
        // ficha descartada
      </p>
    ) : null
  }
  return (
    <aside className="gui-subagent-sidebar" aria-label="Subagentes desta conversa">
      <header className="gui-subagent-sidebar-head">
        <span className="gui-subagent-sidebar-title">
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <circle cx="6" cy="6" r="2.25" />
            <circle cx="12.5" cy="11.5" r="2.25" />
            <path d="M7.8 7.35 10.7 10" />
          </svg>
          <span>Subagentes</span>
        </span>
        <span className="gui-subagent-sidebar-count" aria-label={`${entries.length} subagentes`}>
          {entries.length}
        </span>
      </header>
      <div className="gui-subagent-sidebar-list">
        {entries.map((entry) => (
          <SubagentCard
            key={entry.id}
            entry={entry}
            elapsedMs={guiSubagentElapsedMs(entry, now, clock)}
            dismissing={dismissing === entry.toolUseId}
            onDismiss={() => dismiss(entry)}
          />
        ))}
      </div>
      {/* A recusa mora ao pé da lista, onde o gesto aconteceu — a mesma régua
          da linha de arquivo do trilho (`.dr-file-notice`). */}
      {notice && (
        <p className="gui-subagent-note" role="status">
          // {notice}
        </p>
      )}
    </aside>
  )
}

