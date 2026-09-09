import { useEffect, useId, useRef, useState } from 'react'
import CliMark from './CliMark'
import type { Seat, SeatCli } from '../store'

// A CONTA DA CONVERSA na cabeça do palco (a cabeça em UMA fileira, 2026-09-08).
//
// Era o botão largo do cabeçalho próprio do GuiPane (nome + e-mail + plano +
// caret) numa fileira que repetia a conta da linha de cima. Virou um chip
// QUIETO na mesma família dos botões da barra: marca do CLI + nome + ▾; e-mail
// e plano moram na dica. É o ÚNICO lugar onde se troca de conta no meio da
// conversa, e trocar no meio do turno é LEGÍTIMO (R21.2: é a fuga do rate
// limit; o main transplanta a conversa e mata as sessões vivas, sem guarda de
// ocupação) — por isso o turno aberto nunca desabilita o botão, só muda a dica.

export interface StageSeatAccount {
  email?: string
  subscriptionType?: string
}

export default function StageSeatChip({
  seats,
  seatId,
  cli,
  account,
  changing,
  locked = false,
  turnOpen,
  onChange
}: {
  seats: Seat[]
  seatId?: string
  /** CLI da conversa: a marca quando o seat não está (mais) na lista */
  cli: SeatCli
  /** o que o CLI contou de si nas caps (e-mail, plano) — vai para a dica */
  account?: StageSeatAccount
  /** troca pedida ao main e ainda sem resposta */
  changing: boolean
  /** o composer da conversa está no meio de uma troca de executor ou de um
   *  anexo: trocar a conta agora transplantaria a conversa por cima da
   *  operação em voo (a guarda de voo/anexo do cabeçalho antigo) */
  locked?: boolean
  /** turno aberto (trabalhando ou esperando o dono): a dica diz a verdade */
  turnOpen: boolean
  onChange: (seatId: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const host = useRef<HTMLSpanElement>(null)
  const menuId = useId()
  const seat = seats.find((option) => option.id === seatId)

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      if (!host.current?.contains(event.target as Node)) setOpen(false)
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  const facts = [account?.email, account?.subscriptionType].filter(Boolean).join(' · ')
  // A dica nomeia a RECEITA quando o chip não aceita clique (beco é bug).
  const tip = `${
    locked
      ? 'A conta troca quando o composer terminar a troca de modelo/effort ou o anexo em voo.'
      : turnOpen
        ? 'Trocar interrompe o turno atual e retoma a MESMA conversa na conta nova (mesmo CLI).'
        : 'Conta desta conversa. Trocar mantém a conversa quando o CLI é o mesmo.'
  }${facts ? ` (${facts})` : ''}`

  return (
    <span className="stage-seat" ref={host}>
      <button
        type="button"
        className={`stage-seat-btn${open ? ' open' : ''}`}
        disabled={changing || locked}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-tip={tip}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="ss-mark" aria-hidden="true">
          <CliMark cli={seat?.cli ?? cli} size={12} />
        </span>
        <span className="ss-name">
          {changing ? 'trocando conta…' : (seat?.name ?? 'escolher conta')}
        </span>
        <span className="ss-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="gui-menu gui-seat-menu" id={menuId} role="menu" aria-label="Conta desta conversa">
          {seats.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitem"
              className={`gui-menu-item${option.id === seatId ? ' active' : ''}`}
              disabled={changing || locked}
              onClick={() => {
                setOpen(false)
                if (option.id !== seatId) onChange(option.id)
              }}
            >
              <CliMark cli={option.cli} size={12} />
              <b>{option.name}</b>
              <span>{option.cli}</span>
            </button>
          ))}
          <span className="gui-menu-foot">
            mesma família de CLI: a conversa vai junto para a conta nova · CLI diferente: a
            conversa recomeça
          </span>
        </div>
      )}
    </span>
  )
}
