import type { ReactNode } from 'react'

// O SELECT DA ABA "ajudantes ˄" (2026-09-08): rótulo em cima, caixa com o
// valor e a seta, menu por baixo — a mesma caixa dos menus do composer. Ele é
// burro de propósito: quem sabe qual menu está aberto, quem fecha no clique de
// fora e quem grava a escolha é a aba (um `openMenu` só para os três selects).

export interface GuiFleetSelectOption {
  id: string
  label: string
  /** metadado à direita (o id do modelo, o CLI da conta) */
  detail?: string
  /** a opção de HERDAR: sem peso, em tinta apagada */
  ghost?: boolean
  mark?: ReactNode
  tip?: string
}

function Caret(): React.JSX.Element {
  return (
    <svg
      className="caret"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 3.5 5 6.5l3-3" />
    </svg>
  )
}

export default function GuiFleetSelect({
  id,
  label,
  value,
  valueMark,
  ghost = false,
  disabled = false,
  tip,
  open,
  onOpenChange,
  options,
  selectedId,
  onPick,
  foot
}: {
  id: string
  label: string
  /** o texto na caixa (a escolha, ou o que vale enquanto não há escolha) */
  value: string
  valueMark?: ReactNode
  /** o valor é herança/placeholder, não escolha do dono */
  ghost?: boolean
  disabled?: boolean
  tip?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  options: readonly GuiFleetSelectOption[]
  selectedId: string
  onPick: (id: string) => void
  /** nota no pé do menu (catálogo a caminho, pino fora do catálogo…) */
  foot?: string
}): React.JSX.Element {
  const labelId = `${id}-label`
  return (
    <div className="gui-fleet-field">
      <span className="gui-fleet-label" id={labelId}>
        {label}
      </span>
      <span className="gui-fleet-select-host">
        <button
          type="button"
          className="gui-fleet-select"
          aria-labelledby={labelId}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          data-tip={tip}
          onClick={() => onOpenChange(!open)}
        >
          {valueMark}
          <span className={ghost ? 'val ghost' : 'val'}>{value}</span>
          <Caret />
        </button>
        {open && (
          <div className="gui-fleet-menu" role="menu" aria-labelledby={labelId}>
            {options.map((option) => (
              <button
                key={option.id || '∅'}
                type="button"
                role="menuitem"
                className={`gui-fleet-item${option.id === selectedId ? ' active' : ''}${
                  option.ghost ? ' ghost' : ''
                }`}
                data-tip={option.tip}
                onClick={() => {
                  onOpenChange(false)
                  onPick(option.id)
                }}
              >
                {option.mark}
                <b>{option.label}</b>
                {option.detail && <span>{option.detail}</span>}
              </button>
            ))}
            {foot && <span className="gui-menu-foot">{foot}</span>}
          </div>
        )}
      </span>
    </div>
  )
}
