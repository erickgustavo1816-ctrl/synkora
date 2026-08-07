interface Props {
  size?: number
  className?: string
}

/** Painel de andamento: grade 20×20, traço 1,5 e `currentColor`, alinhado ao
 * sistema vetorial compacto do SynVoice. O botão fornece o nome acessível. */
export default function ProgressPanelIcon({
  size = 15,
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
      <rect x="2.5" y="3" width="15" height="14" rx="2" />
      <path d="M2.5 7.25h15M7.25 7.25V17M10.25 10.25h4.25M10.25 13.25h3.25" />
    </svg>
  )
}
