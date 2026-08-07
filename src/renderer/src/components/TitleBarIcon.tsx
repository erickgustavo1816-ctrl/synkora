type TitleBarIconName = 'back' | 'terminal' | 'gauge' | 'tune' | 'settings'

interface Props {
  name: TitleBarIconName
  size?: number
  className?: string
}

/**
 * Sistema vetorial da barra da janela: grade 20x20, traco 1,5 e currentColor.
 * Os SVGs sao decorativos; o nome acessivel pertence sempre ao botao.
 */
export default function TitleBarIcon({
  name,
  size = 16,
  className
}: Props): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'back' && <path d="m8.25 5-5 5 5 5M3.5 10h13.25" />}

      {name === 'terminal' && (
        <>
          <rect x="2.5" y="3.25" width="15" height="13.5" rx="2" />
          <path d="m5.5 7 2.5 2.5L5.5 12M10.5 12.25h4" />
        </>
      )}

      {name === 'gauge' && (
        <>
          <path d="M3 14a7 7 0 0 1 14 0" />
          <path d="m10 13.75 3.35-4.4" />
          <circle cx="10" cy="13.75" r="1" />
        </>
      )}

      {name === 'tune' && (
        <>
          <path d="M3 5.25h5M12 5.25h5M3 10h9M15.75 10H17M3 14.75h2.75M9.75 14.75H17" />
          <circle cx="10" cy="5.25" r="2" />
          <circle cx="13.75" cy="10" r="2" />
          <circle cx="7.75" cy="14.75" r="2" />
        </>
      )}

      {name === 'settings' && (
        <>
          <path d="M8.15 2.5h3.7l.4 1.85 1.6.92 1.8-.58 1.85 3.2-1.38 1.27v1.68l1.38 1.27-1.85 3.2-1.8-.58-1.6.92-.4 1.85h-3.7l-.4-1.85-1.6-.92-1.8.58-1.85-3.2 1.38-1.27V9.16L2.5 7.89l1.85-3.2 1.8.58 1.6-.92.4-1.85Z" />
          <circle cx="10" cy="10" r="2.35" />
        </>
      )}
    </svg>
  )
}
