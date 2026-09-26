import { useStore } from '../store'
import {
  NOTICE_AUTO_CLOSE_SECONDS,
  noticePrefsOf,
  type NoticeAutoCloseSeconds,
  type NoticeCorner
} from '../noticeStack'

// OS AVISOS DO BOARD — os dois ajustes da pilha flutuante do Board/Backlog
// (mockup aprovado pelo dono em 2026-09-26: docs/mockups/avisos-2026-09-26.html).
// A regra — recusa e erro nunca fecham sozinhos — mora em `noticeStack.ts`;
// aqui só a interface, no mesmo vocabulário de "com o Synkora aberto".

function autoCloseLabel(seconds: NoticeAutoCloseSeconds): string {
  return seconds === 0 ? 'nunca' : `${seconds} s`
}

const CORNER_CHOICES: { value: NoticeCorner; label: string; summary: string }[] = [
  { value: 'bottom', label: 'inferior', summary: 'no pé do Board' },
  { value: 'top', label: 'superior', summary: 'no topo do Board' }
]

export default function NoticeSettings(): React.JSX.Element {
  const settings = useStore((state) => state.settings)
  const patchSettings = useStore((state) => state.patchSettings)
  const { autoCloseSeconds, corner } = noticePrefsOf(settings)
  const cornerChoice = CORNER_CHOICES.find((choice) => choice.value === corner) ?? CORNER_CHOICES[0]

  return (
    <section className="settings-card">
      <header className="settings-card-head">
        <div>
          <span className="settings-card-kicker">board e backlog</span>
          <h2>Avisos do Board</h2>
          <p>Os avisos flutuantes do ⇪, da revisão e das releases.</p>
        </div>
      </header>

      <div className="typography-layout">
        <div className="typography-controls">
          <div className="pref-field">
            <div className="pref-label-row">
              <label htmlFor="notice-auto-close">fechar sozinho</label>
              <span>{autoCloseSeconds === 0 ? 'fica até o ×' : `some em ${autoCloseSeconds} s`}</span>
            </div>
            <div
              className="pref-choice"
              id="notice-auto-close"
              role="group"
              aria-label="Fechar sozinho"
            >
              {NOTICE_AUTO_CLOSE_SECONDS.map((seconds) => (
                <button
                  key={seconds}
                  type="button"
                  aria-pressed={seconds === autoCloseSeconds}
                  onClick={() => {
                    if (seconds !== autoCloseSeconds)
                      void patchSettings({ noticeAutoCloseSeconds: seconds })
                  }}
                >
                  {autoCloseLabel(seconds)}
                </button>
              ))}
            </div>
            <small>
              Vale só para avisos informativos e de fila. Recusas e erros ficam até você fechar
              no ×. Passar o mouse pausa a contagem.
            </small>
          </div>

          <div className="pref-field">
            <div className="pref-label-row">
              <label htmlFor="notice-corner">canto</label>
              <span>{cornerChoice.summary}</span>
            </div>
            <div className="pref-choice" id="notice-corner" role="group" aria-label="Canto">
              {CORNER_CHOICES.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  aria-pressed={choice.value === corner}
                  onClick={() => {
                    if (choice.value !== corner) void patchSettings({ noticeCorner: choice.value })
                  }}
                >
                  {choice.label}
                </button>
              ))}
            </div>
            <small>
              Onde os avisos aparecem no Board. Inferior fica longe do cabeçalho do chat, onde
              mora o ⇪.
            </small>
          </div>
        </div>
      </div>
    </section>
  )
}
