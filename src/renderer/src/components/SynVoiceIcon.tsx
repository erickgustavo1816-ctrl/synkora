interface Props {
  state?: 'mic' | 'stop' | 'processing' | 'done'
}

/**
 * Ícones SynVoice: grade 20×20, traço 1,5 e cantos arredondados.
 * O botão carrega o nome acessível; o SVG é sempre decorativo.
 */
export default function SynVoiceIcon({ state = 'mic' }: Props): React.JSX.Element {
  return (
    <svg
      className={`synvoice-icon ${state}`}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {state === 'mic' && (
        <>
          <rect x="7" y="2.5" width="6" height="9.5" rx="3" />
          <path d="M4.75 9.5v.75a5.25 5.25 0 0 0 10.5 0V9.5M10 15.5v2M7.5 17.5h5" />
        </>
      )}
      {state === 'stop' && <rect x="5.75" y="5.75" width="8.5" height="8.5" rx="1.5" fill="currentColor" stroke="none" />}
      {state === 'processing' && (
        <circle className="synvoice-icon-spinner" cx="10" cy="10" r="6.25" strokeDasharray="25 14" />
      )}
      {state === 'done' && <path d="m4.5 10 3.4 3.4L15.5 6" />}
    </svg>
  )
}

