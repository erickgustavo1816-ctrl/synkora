// ————————————————————————————————————————————————————————————————————————
// A MARCA DO SYNKORA — fonte única do logo.
//
// A estrela de quatro pontas com a órbita em volta: o ✦ do app dentro do anel
// do universo. Vive num componente só porque o logo aparece em três lugares
// (titlebar, Home e o botão Home do rail) e uma marca desenhada três vezes
// vira três marcas diferentes na primeira alteração.
//
// Herda `currentColor`: em fundo escuro o pai pinta de acento, em papel também
// — quem decide a cor é o contexto, não o desenho. A órbita usa opacidade em
// vez de cor fixa pelo mesmo motivo.
//
// O ÍCONE DO APP (build/icon.ico, gerado por scripts/make-icon.mjs) desenha
// EXATAMENTE esta geometria. Mudar as proporções aqui sem regerar o ícone faz
// a marca da janela divergir da marca de dentro do app.
// ————————————————————————————————————————————————————————————————————————

interface Props {
  /** lado em px (o desenho é quadrado) */
  size?: number
  className?: string
}

export default function SynkoraMark({ size = 17, className }: Props): React.JSX.Element {
  return (
    <svg
      className={className ? `synkora-mark ${className}` : 'synkora-mark'}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <ellipse
        cx="12"
        cy="12"
        rx="10.5"
        ry="5.2"
        transform="rotate(-28 12 12)"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        opacity="0.55"
      />
      <path
        d="M12 3.2c.55 4.2 1.9 6.05 6.1 6.6-4.2.55-5.55 2.4-6.1 6.6-.55-4.2-1.9-6.05-6.1-6.6 4.2-.55 5.55-2.4 6.1-6.6Z"
        fill="currentColor"
        transform="translate(0 2.2)"
      />
    </svg>
  )
}
