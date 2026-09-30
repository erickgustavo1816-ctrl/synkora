import { UNVERSIONED_MODE_LABEL } from '../unversionedPresentation'
import './UnversionedFolderSeal.css'

// ————————————————————————————————————————————————————————————————————————
// A MARCA DO UNIVERSO SEM VERSIONAMENTO (dono, 2026-09-30): o SELO DE PASTA —
// opção B de docs/mockups/projeto-sem-versao-marca-2026-09-30.html — no canto
// de BAIXO À ESQUERDA do avatar ("o agente edita direto na pasta"). O canto
// direito é do ponto da missão no rail.
//
// Uso: filho de um avatar com `position: relative`, nos três lugares onde o
// avatar mora (rail, cabeçalho do universo, card da Home). É `aria-hidden`:
// o sentido vai no rótulo do avatar ("… (sem versionamento)"), e onde houver
// espaço o selo textual <UnversionedModeTag /> acompanha — o ícone nunca fica
// sozinho.
// ————————————————————————————————————————————————————————————————————————

export default function UnversionedFolderSeal({
  size
}: {
  size: 'rail' | 'header' | 'card'
}): React.JSX.Element {
  return (
    <span className={`uv-seal uv-seal--${size}`} aria-hidden="true">
      <svg viewBox="0 0 20 20" focusable="false">
        <path d="M2.5 5.5v10h15v-8.5h-7.5l-2-2h-5.5z" />
      </svg>
    </span>
  )
}

/** O selo TEXTUAL do modo: canto quase reto (os números da casa são pílulas;
 *  o modo é etiqueta), sem cor própria. */
export function UnversionedModeTag({ title }: { title?: string }): React.JSX.Element {
  return (
    <span className="mode-tag" title={title}>
      {UNVERSIONED_MODE_LABEL}
    </span>
  )
}
