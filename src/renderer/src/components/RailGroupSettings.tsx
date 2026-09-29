import { useStore } from '../store'

// OS GRUPOS NO RAIL (2026-09-29) — o nome escrito sob a pasta, à la iPhone.
// Decisão do dono ao aprovar o mockup (docs/mockups/grupos-universos-
// 2026-09-29.html): ligado por padrão, com a escolha aqui em Aparência. Quem
// consome `settings.railGroupNames` é o rail; ausente = ligado.

export default function RailGroupSettings(): React.JSX.Element {
  const settings = useStore((state) => state.settings)
  const patchSettings = useStore((state) => state.patchSettings)
  const names = settings?.railGroupNames !== false

  return (
    <section className="settings-card rail-group-settings">
      <header className="settings-card-head">
        <div>
          <span className="settings-card-kicker">rail de universos</span>
          <h2>Grupos no rail</h2>
          <p>
            Arraste um universo sobre outro no rail para criar uma pasta. Aqui você escolhe
            como a pasta fechada se apresenta.
          </p>
        </div>
      </header>

      <div className="chat-notice-layout">
        <fieldset>
          <legend>Pastas</legend>
          <button
            type="button"
            className={`chat-notice-switch${names ? ' is-on' : ''}`}
            role="switch"
            aria-checked={names}
            onClick={() => void patchSettings({ railGroupNames: !names })}
          >
            <span className="chat-notice-copy">
              <strong>Nome do grupo sob a pasta</strong>
              <small>
                Escrito embaixo da pasta no rail, como no iPhone; desligado, aparece só ao passar o
                mouse.
              </small>
            </span>
            <span className="chat-notice-switch-state">
              <em>{names ? 'ligado' : 'desligado'}</em>
              <i aria-hidden="true">
                <b />
              </i>
            </span>
          </button>
        </fieldset>
      </div>
    </section>
  )
}
