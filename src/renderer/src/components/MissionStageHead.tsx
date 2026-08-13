import { useState } from 'react'

// CABEÇA DO PALCO (mockup aprovado, docs/MOCKUP_WORKSPACE.md).
//
// Duas exigências literais do contrato, e é só isso que este módulo faz:
//
//  1. "Cabeçalho fino da conversa: `dev · opus 4.8 · mission/1f3a` em texto
//     apagado, UMA linha, SEM BARRA ESCURA DE PANE." — o PaneChrome (titlebar
//     preto de terminal) fica SÓ nas missões legadas, onde o que roda de fato
//     é um TUI. No palco 2.0 o chat é PAPEL, e um titlebar escuro em cima dele
//     era exatamente o "tá parecendo um pane ainda" do dono.
//
//  2. "Seletor de conversas: linha fina no topo do palco, pílulas por conversa
//     aberta — dev · reviewer · ajudante 1..n · terminal. Pílula ativa = fundo
//     ink, texto papel; inativas = borda ink. Fechar pelo ✕ na própria pílula
//     (com confirmação quando viva)."
//
// A confirmação é INLINE (a pílula vira "fechar?"): `window.confirm` quebra o
// foco da janela no Windows — regra antiga do projeto, nunca usar.

export interface StagePill {
  /** paneId da conversa ou id do pane de terminal — só precisa ser único */
  id: string
  label: string
  /** terminal ganha o ▷ e some do vocabulário de "conversa" */
  kind: 'chat' | 'terminal'
  active: boolean
  /** conversa que espera o dono (permissão pendente) pulsa na pílula */
  attention?: boolean
  tip?: string
  onSelect: () => void
  /** ausente = pílula sem ✕ (o chat do agente É a missão, não se fecha) */
  onClose?: () => void
  closeTip?: string
  /** ✕ pede confirmação inline (sessão/processo vivo do outro lado) */
  confirmClose?: boolean
}

export default function MissionStageHead({
  pills,
  meta,
  actions
}: {
  pills: StagePill[]
  /** a linha fina: papel-e-tinta apagada, uma linha só */
  meta: React.ReactNode
  /** alavancas do contexto (estudar/seat/limpar, encerrar planejamento…) */
  actions?: React.ReactNode
}): React.JSX.Element {
  const [confirmId, setConfirmId] = useState<string | null>(null)

  return (
    <div className="stage-head">
      <div className="stage-pills" role="tablist" aria-label="Conversas abertas">
        {pills.map((pill) => {
          const confirming = confirmId === pill.id
          return (
            <span key={pill.id} className="stage-pill-wrap">
              <button
                type="button"
                role="tab"
                aria-selected={pill.active}
                className={`stage-pill${pill.active ? ' active' : ''}${
                  pill.attention ? ' asking' : ''
                }${pill.kind === 'terminal' ? ' term' : ''}`}
                data-tip={pill.tip}
                onClick={() => {
                  setConfirmId(null)
                  pill.onSelect()
                }}
              >
                {pill.kind === 'terminal' && <span className="stage-pill-glyph">▷</span>}
                {pill.label}
              </button>
              {pill.onClose &&
                (confirming ? (
                  <button
                    type="button"
                    className="stage-pill-close confirming"
                    data-tip="Confirmar o fechamento"
                    onClick={() => {
                      setConfirmId(null)
                      pill.onClose?.()
                    }}
                    onBlur={() => setConfirmId((cur) => (cur === pill.id ? null : cur))}
                  >
                    fechar?
                  </button>
                ) : (
                  <button
                    type="button"
                    className="stage-pill-close"
                    aria-label={`Fechar ${pill.label}`}
                    data-tip={pill.closeTip}
                    onClick={() => {
                      if (pill.confirmClose === false) pill.onClose?.()
                      else setConfirmId(pill.id)
                    }}
                  >
                    ✕
                  </button>
                ))}
            </span>
          )
        })}
      </div>

      <div className="stage-meta">
        <span className="stage-meta-line">{meta}</span>
        {actions && <span className="stage-actions">{actions}</span>}
      </div>
    </div>
  )
}
