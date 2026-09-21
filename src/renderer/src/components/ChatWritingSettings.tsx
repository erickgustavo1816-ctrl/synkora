import { useStore } from '../store'
import {
  GUI_WRITING_MAX_LAG_RANGE,
  GUI_WRITING_PACE_DEFAULT,
  GUI_WRITING_WORDS_PER_SECOND_RANGE,
  guiWritingPaceOf
} from '../guiStreamReveal'

// A ESCRITA DO CHAT — os três ajustes do escritor único (pedido do dono ao
// aprovar o mockup de 2026-09-21: "queria que tivesse na parte de config como
// configurar a velocidade, a cadência, etc."). A régua que consome estes
// valores é `guiStreamReveal.ts`; aqui só a interface, no mesmo vocabulário
// dos campos de Aparência (pref-field, range, ↺).

const WPS_STEP = 5
const LAG_STEP = 100

function describeSpeed(wordsPerSecond: number): string {
  if (wordsPerSecond <= 0) return 'instantâneo — o texto aparece inteiro'
  if (wordsPerSecond <= 10) return 'lenta — leitura acompanhada'
  if (wordsPerSecond <= 25) return 'natural — como alguém digitando rápido'
  if (wordsPerSecond <= 45) return 'rápida — quase o ritmo da rede'
  return 'muito rápida — só suaviza as rajadas'
}

export default function ChatWritingSettings(): React.JSX.Element {
  const settings = useStore((state) => state.settings)
  const patchSettings = useStore((state) => state.patchSettings)
  const pace = guiWritingPaceOf(settings)
  const isDefault =
    pace.wordsPerSecond === GUI_WRITING_PACE_DEFAULT.wordsPerSecond &&
    pace.maxLagMs === GUI_WRITING_PACE_DEFAULT.maxLagMs &&
    pace.fade === GUI_WRITING_PACE_DEFAULT.fade

  const setSpeed = (value: number): void => {
    void patchSettings({ chatWritingWordsPerSecond: value })
  }
  const setLag = (value: number): void => {
    void patchSettings({ chatWritingMaxLagMs: value })
  }
  const setFade = (value: boolean): void => {
    void patchSettings({ chatWritingFade: value })
  }
  const resetAll = (): void => {
    void patchSettings({
      chatWritingWordsPerSecond: GUI_WRITING_PACE_DEFAULT.wordsPerSecond,
      chatWritingMaxLagMs: GUI_WRITING_PACE_DEFAULT.maxLagMs,
      chatWritingFade: GUI_WRITING_PACE_DEFAULT.fade
    })
  }

  return (
    <section className="settings-card chat-writing-settings">
      <header className="settings-card-head">
        <div>
          <span className="settings-card-kicker">a fala do agente</span>
          <h2>Escrita do chat</h2>
          <p>
            A resposta aparece palavra a palavra, um parágrafo de cada vez. Aqui você
            decide o ritmo; a leitura nunca fica mais de um instante atrás do que já chegou.
          </p>
        </div>
        <button type="button" className="btn ghost tiny" onClick={resetAll} disabled={isDefault}>
          ↺ restaurar padrão
        </button>
      </header>

      <div className="typography-layout">
        <div className="typography-controls">
          <div className="pref-field">
            <div className="pref-label-row">
              <label htmlFor="chat-writing-speed">velocidade</label>
              <span>{pace.wordsPerSecond === 0 ? 'instantâneo' : `${pace.wordsPerSecond} palavras/s`}</span>
            </div>
            <div className="line-height-control">
              <input
                id="chat-writing-speed"
                type="range"
                min={GUI_WRITING_WORDS_PER_SECOND_RANGE.min}
                max={GUI_WRITING_WORDS_PER_SECOND_RANGE.max}
                step={WPS_STEP}
                value={pace.wordsPerSecond}
                onChange={(event) => setSpeed(Number(event.target.value))}
              />
              <output>{pace.wordsPerSecond === 0 ? '∞' : pace.wordsPerSecond}</output>
              <button
                type="button"
                className="pref-reset"
                aria-label="Restaurar velocidade padrão"
                disabled={pace.wordsPerSecond === GUI_WRITING_PACE_DEFAULT.wordsPerSecond}
                onClick={() => setSpeed(GUI_WRITING_PACE_DEFAULT.wordsPerSecond)}
              >
                ↺
              </button>
            </div>
            <small>{describeSpeed(pace.wordsPerSecond)}</small>
          </div>

          <div className="pref-field">
            <div className="pref-label-row">
              <label htmlFor="chat-writing-lag">atraso máximo</label>
              <span>{(pace.maxLagMs / 1000).toFixed(1)} s</span>
            </div>
            <div className="line-height-control">
              <input
                id="chat-writing-lag"
                type="range"
                min={GUI_WRITING_MAX_LAG_RANGE.min}
                max={GUI_WRITING_MAX_LAG_RANGE.max}
                step={LAG_STEP}
                value={pace.maxLagMs}
                disabled={pace.wordsPerSecond === 0}
                onChange={(event) => setLag(Number(event.target.value))}
              />
              <output>{(pace.maxLagMs / 1000).toFixed(1)}s</output>
              <button
                type="button"
                className="pref-reset"
                aria-label="Restaurar atraso máximo padrão"
                disabled={pace.maxLagMs === GUI_WRITING_PACE_DEFAULT.maxLagMs}
                onClick={() => setLag(GUI_WRITING_PACE_DEFAULT.maxLagMs)}
              >
                ↺
              </button>
            </div>
            <small>
              Quanto a tela pode ficar atrás do texto recebido. Rajadas grandes aceleram a
              cadência para caber neste teto — sempre palavra a palavra.
            </small>
          </div>

          <div className="pref-field">
            <button
              type="button"
              className={`chat-notice-switch${pace.fade ? ' is-on' : ''}`}
              role="switch"
              aria-checked={pace.fade}
              disabled={pace.wordsPerSecond === 0}
              onClick={() => setFade(!pace.fade)}
            >
              <span className="chat-notice-copy">
                <strong>A palavra assenta</strong>
                <small>Cada passo entra com um fade curto em vez de aparecer seco.</small>
              </span>
              <span className="chat-notice-switch-state">
                <em>{pace.fade ? 'ligado' : 'desligado'}</em>
                <i aria-hidden="true">
                  <b />
                </i>
              </span>
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
