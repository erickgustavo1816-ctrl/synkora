import { useStore } from '../store'
import type { SynkoraPreferences } from '../../../preload'

export type NoticePreference =
  | 'chatNotifyNeedsYou'
  | 'chatNotifyFinished'
  | 'chatNotifyFailed'
  | 'chatSoundsEnabled'

export interface NoticeChoice {
  key: NoticePreference
  label: string
  description: string
}

export const WINDOWS_CHOICES: NoticeChoice[] = [
  {
    key: 'chatNotifyNeedsYou',
    label: 'Precisa de você',
    description: 'Permissão, pergunta ou decisão sobre um plano.'
  },
  {
    key: 'chatNotifyFinished',
    label: 'Turno concluído',
    description: 'O agente terminou todo o trabalho que estava na fila.'
  },
  {
    key: 'chatNotifyFailed',
    label: 'Turno falhou',
    description: 'A sessão encontrou uma falha e não conseguiu continuar.'
  }
]

/** Com o Synkora em foco, o que vira aviso do Windows (fora de foco, tudo vira). */
type NoticeFocusMode = NonNullable<SynkoraPreferences['desktopNotifyWhileFocused']>

interface NoticeFocusChoice {
  value: NoticeFocusMode
  label: string
  summary: string
  description: string
}

const FOCUS_MODE_CHOICES: NoticeFocusChoice[] = [
  {
    value: 'off-screen',
    label: 'fora da tela',
    summary: 'avisa o que você não está vendo',
    description:
      'Outro projeto, outra missão, missão integrada e conflito na fila viram aviso. ' +
      'O chat aberto na sua frente não gera aviso.'
  },
  {
    value: 'always',
    label: 'sempre',
    summary: 'avisa tudo',
    description: 'Todo aviso sai, inclusive o do chat que está na sua frente.'
  },
  {
    value: 'never',
    label: 'nunca',
    summary: 'avisa só fora do app',
    description: 'Com o Synkora em foco, nenhum aviso do Windows. Quando você sai do app, eles voltam.'
  }
]

export const CHAT_SOUND_CHOICE: NoticeChoice = {
  key: 'chatSoundsEnabled',
  label: 'Sons de atenção',
  description: 'Plins diferentes para “precisa de você” e “turno concluído”.'
}

export function NoticeSwitch({
  choice,
  checked,
  onChange,
  className
}: {
  choice: NoticeChoice
  checked: boolean
  onChange: (key: NoticePreference, value: boolean) => void
  className?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`chat-notice-switch${className ? ` ${className}` : ''}${checked ? ' is-on' : ''}`}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(choice.key, !checked)}
    >
      <span className="chat-notice-copy">
        <strong>{choice.label}</strong>
        <small>{choice.description}</small>
      </span>
      <span className="chat-notice-switch-state">
        <em>{checked ? 'ligado' : 'desligado'}</em>
        <i aria-hidden="true"><b /></i>
      </span>
    </button>
  )
}

export default function ChatNoticeSettings(): React.JSX.Element {
  const settings = useStore((state) => state.settings)
  const patchSettings = useStore((state) => state.patchSettings)

  const checked = (key: NoticePreference): boolean => settings?.[key] ?? true
  const update = (key: NoticePreference, value: boolean): void => {
    void patchSettings({ [key]: value } as Pick<SynkoraPreferences, NoticePreference>)
  }
  const focusMode = settings?.desktopNotifyWhileFocused ?? 'off-screen'
  const focusChoice =
    FOCUS_MODE_CHOICES.find((choice) => choice.value === focusMode) ?? FOCUS_MODE_CHOICES[0]

  return (
    <section className="settings-card chat-notice-settings">
      <header className="settings-card-head">
        <div>
          <span className="settings-card-kicker">notificações e som</span>
          <h2>Avisos do chat</h2>
          <p>
            Escolha quando uma missão pode chamar sua atenção. O aviso sempre leva o nome
            da missão, e o título <code>[pronto]</code> continua disponível como sinal discreto.
          </p>
        </div>
      </header>

      <div className="chat-notice-layout">
        <fieldset>
          <legend>Avisos do Windows</legend>
          {WINDOWS_CHOICES.map((choice) => (
            <NoticeSwitch
              key={choice.key}
              choice={choice}
              checked={checked(choice.key)}
              onChange={update}
            />
          ))}
          <div className="pref-field chat-notice-focus">
            <div className="pref-label-row">
              <label htmlFor="chat-notice-focus">com o Synkora aberto</label>
              <span>{focusChoice.summary}</span>
            </div>
            <div
              className="pref-choice"
              id="chat-notice-focus"
              role="group"
              aria-label="Com o Synkora aberto"
            >
              {FOCUS_MODE_CHOICES.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  aria-pressed={choice.value === focusMode}
                  onClick={() => {
                    if (choice.value !== focusMode)
                      void patchSettings({ desktopNotifyWhileFocused: choice.value })
                  }}
                >
                  {choice.label}
                </button>
              ))}
            </div>
            <small>{focusChoice.description}</small>
          </div>
        </fieldset>

        <fieldset>
          <legend>Som do chat</legend>
          <NoticeSwitch
            choice={CHAT_SOUND_CHOICE}
            checked={checked('chatSoundsEnabled')}
            onChange={update}
          />
          <p className="chat-notice-note">
            Desligar o som não remove os sinais visuais nem os avisos do Windows escolhidos acima.
          </p>
        </fieldset>
      </div>
    </section>
  )
}
