interface Props {
  mode: 'detach' | 'attach'
  size?: number
  className?: string
}

/** Setas vetoriais do mini SynVoice, alinhadas na mesma caixa óptica da engrenagem. */
export default function SynVoiceWindowIcon({
  mode,
  size = 14,
  className
}: Props): React.JSX.Element {
  const detach = mode === 'detach'
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {detach ? (
        <>
          <path d="M4.9 15.1 15.1 4.9" />
          <path d="M10.7 4.9h4.4v4.4" />
        </>
      ) : (
        <>
          <path d="M15.1 4.9 4.9 15.1" />
          <path d="M9.3 15.1H4.9v-4.4" />
        </>
      )}
    </svg>
  )
}
