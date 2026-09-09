import { useState } from 'react'

// CABEÇA DO PALCO — UMA FILEIRA (ordem do dono, 2026-09-08; mockup aprovado com
// o CSS real em scripts/harness/stage-head.html).
//
// O contrato original (docs/MOCKUP_WORKSPACE.md) tinha duas linhas — a tira
// de pílulas e a "linha fina" `dev · opus 4.8 · mission/1f3a` — e por baixo o
// GuiPane abria um terceiro cabeçalho repetindo papel, conta, modelo, effort e
// id. O dono reprovou ("muita informação, tudo feio/bagunçado; a única coisa
// que gosto são os botões"). Ficou o que é AÇÃO ou IDENTIDADE:
//
//   [lateral] [pílulas de conversa]   ···   [estado do turno] [conta] │ [botões]
//
//  - pílulas: `dev · reviewer · ajudante 1..n · terminal`, ativa = fundo ink,
//    texto papel; inativas = borda ink; ✕ com confirmação INLINE quando viva
//    (`window.confirm` quebra o foco da janela no Windows — nunca usar).
//  - estado do turno (StageRoundStatus) e conta (StageSeatChip) são do CHAT em
//    foco: o Board os monta e passa prontos; terminal no palco não os tem.
//  - modelo e effort moram no composer; a branch mora no trilho de entrega.
//  - com pílulas de sobra num palco estreito, elas quebram para baixo e a
//    primeira fileira (lateral · trail) continua alinhada (align-items: start).

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
  leadingAction,
  status,
  seat,
  actions
}: {
  pills: StagePill[]
  /** o toggle da coluna de missões, na ponta esquerda */
  leadingAction?: React.ReactNode
  /** estado do turno da conversa em foco — só quando é notícia */
  status?: React.ReactNode
  /** a conta da conversa em foco (chip que troca de seat) */
  seat?: React.ReactNode
  /** alavancas da missão (⇪, terminal de teste, revisão, arquivar, painéis) */
  actions?: React.ReactNode
}): React.JSX.Element {
  const [confirmId, setConfirmId] = useState<string | null>(null)

  return (
    <div className="stage-head">
      {leadingAction}
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

      {/* o que fica à direita: leitura do turno · conta │ ações da missão */}
      <div className="stage-trail">
        {status}
        {seat}
        {actions && (
          <>
            {(status || seat) && <span className="stage-sep" aria-hidden="true" />}
            <span className="stage-actions">{actions}</span>
          </>
        )}
      </div>
    </div>
  )
}
