import { useEffect, useState } from 'react'
import { useStore } from '../store'
import {
  CHAT_FONT_SIZE_DEFAULT,
  CHAT_FONT_SIZE_RANGE,
  CHAT_FONT_SIZE_STEP,
  CHAT_LINE_HEIGHT_DEFAULT,
  CHAT_LINE_HEIGHT_RANGE,
  UI_FONT_FAMILY_DEFAULT,
  UI_SCALE_DEFAULT,
  UI_SCALE_RANGE,
  stepUiScale
} from '../uiAccessibility'
import './AccessibilitySettings.css'

// Ajustes ▸ Aparência ▸ ACESSIBILIDADE DO SYNKORA (ordem do dono, 2026-09-21).
// Substitui a "Tipografia fixa" dos painéis xterm, que "hoje não serve para
// nada": o que se regula aqui é o APP INTEIRO — escala (zoom real da janela,
// aplicado pelo main), fonte de todo o texto, movimento reduzido — e, por
// cima da escala, a leitura das mensagens do chat (tamanho e altura da
// linha). Cada gesto grava na hora; a prévia à direita lê as MESMAS variáveis
// CSS que o chat de verdade, então o que ela mostra é o que o app faz.

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export default function AccessibilitySettings(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const scale = settings?.uiScale ?? UI_SCALE_DEFAULT
  const fontFamily = settings?.uiFontFamily ?? UI_FONT_FAMILY_DEFAULT
  const reduceMotion = settings?.uiReduceMotion ?? false
  const chatFontSize = settings?.chatFontSize ?? CHAT_FONT_SIZE_DEFAULT
  const chatLineHeight = settings?.chatLineHeight ?? CHAT_LINE_HEIGHT_DEFAULT
  const [familyDraft, setFamilyDraft] = useState(fontFamily)

  useEffect(() => setFamilyDraft(fontFamily), [fontFamily])

  const setScale = (value: number): void => {
    if (value !== scale) void patchSettings({ uiScale: value })
  }

  const commitFamily = (): void => {
    const value = familyDraft.trim() || UI_FONT_FAMILY_DEFAULT
    setFamilyDraft(value)
    if (value !== fontFamily) void patchSettings({ uiFontFamily: value })
  }

  const setChatFontSize = (value: number): void => {
    const next = clamp(
      Math.round(value / CHAT_FONT_SIZE_STEP) * CHAT_FONT_SIZE_STEP,
      CHAT_FONT_SIZE_RANGE.min,
      CHAT_FONT_SIZE_RANGE.max
    )
    if (next !== chatFontSize) void patchSettings({ chatFontSize: next })
  }

  const setChatLineHeight = (value: number): void => {
    const next =
      Math.round(clamp(value, CHAT_LINE_HEIGHT_RANGE.min, CHAT_LINE_HEIGHT_RANGE.max) * 100) / 100
    if (next !== chatLineHeight) void patchSettings({ chatLineHeight: next })
  }

  const resetAll = (): void => {
    void patchSettings({
      uiScale: UI_SCALE_DEFAULT,
      uiFontFamily: UI_FONT_FAMILY_DEFAULT,
      uiReduceMotion: false,
      chatFontSize: CHAT_FONT_SIZE_DEFAULT,
      chatLineHeight: CHAT_LINE_HEIGHT_DEFAULT
    })
  }

  const chatFontLabel = `${chatFontSize.toFixed(1).replace(/\.0$/u, '')}px`

  return (
    <section className="settings-card typography-settings accessibility-settings">
      <header className="settings-card-head">
        <div>
          <span className="settings-card-kicker">interface</span>
          <h2>Acessibilidade do Synkora</h2>
          <p>
            Escala, fonte e movimento valem para o app inteiro: chat, board, ajustes e
            terminais. Nada aqui muda o espaço disponível na tela — só a leitura.
          </p>
        </div>
        <button type="button" className="btn ghost tiny" onClick={resetAll}>
          ↺ restaurar padrão
        </button>
      </header>

      <div className="typography-layout">
        <div className="typography-controls">
          <div className="pref-field">
            <div className="pref-label-row">
              <label htmlFor="ui-scale">escala da interface</label>
              <span>{scale}%</span>
            </div>
            <div className="font-stepper" id="ui-scale">
              <button
                type="button"
                aria-label="Diminuir a escala da interface"
                disabled={scale <= UI_SCALE_RANGE.min}
                onClick={() => setScale(stepUiScale(scale, -1))}
              >
                −
              </button>
              <output aria-live="polite">{scale}%</output>
              <button
                type="button"
                aria-label="Aumentar a escala da interface"
                disabled={scale >= UI_SCALE_RANGE.max}
                onClick={() => setScale(stepUiScale(scale, 1))}
              >
                +
              </button>
              <button
                type="button"
                className="pref-reset"
                aria-label="Restaurar a escala de 100%"
                disabled={scale === UI_SCALE_DEFAULT}
                onClick={() => setScale(UI_SCALE_DEFAULT)}
              >
                ↺
              </button>
            </div>
            <small>
              De {UI_SCALE_RANGE.min}% a {UI_SCALE_RANGE.max}%, de 5 em 5. Também funciona com
              Ctrl + −, Ctrl + + e Ctrl + 0 em qualquer tela.
            </small>
          </div>

          <div className="pref-field">
            <div className="pref-label-row">
              <label htmlFor="ui-font-family">fonte</label>
            </div>
            <input
              id="ui-font-family"
              className="pref-text-input"
              type="text"
              list="ui-font-presets"
              value={familyDraft}
              spellCheck={false}
              onChange={(event) => setFamilyDraft(event.target.value)}
              onBlur={commitFamily}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') {
                  setFamilyDraft(fontFamily)
                  event.currentTarget.blur()
                }
              }}
            />
            <datalist id="ui-font-presets">
              <option value="Cascadia Code" />
              <option value="Cascadia Mono" />
              <option value="Consolas" />
              <option value="JetBrains Mono" />
              <option value="Fira Code" />
            </datalist>
            <small>Vale para todo o texto do Synkora. Use uma fonte monoespaçada instalada no Windows.</small>
          </div>

          <div className="pref-field">
            <div className="pref-label-row">
              <label htmlFor="ui-reduce-motion">movimento</label>
              <span>{reduceMotion ? 'sempre reduzido' : 'seguindo o Windows'}</span>
            </div>
            <div className="pref-choice" id="ui-reduce-motion" role="group" aria-label="Movimento">
              <button
                type="button"
                aria-pressed={!reduceMotion}
                onClick={() => {
                  if (reduceMotion) void patchSettings({ uiReduceMotion: false })
                }}
              >
                seguir o Windows
              </button>
              <button
                type="button"
                aria-pressed={reduceMotion}
                onClick={() => {
                  if (!reduceMotion) void patchSettings({ uiReduceMotion: true })
                }}
              >
                reduzir sempre
              </button>
            </div>
            <small>
              "Reduzir sempre" para as animações e o fundo vivo, mesmo com o Windows permitindo
              movimento.
            </small>
          </div>

          <div className="pref-field">
            <p className="pref-group-title">chat</p>
            <div className="pref-subfield">
              <div className="pref-label-row">
                <label htmlFor="chat-font-size">tamanho da fonte</label>
                <span>{chatFontLabel}</span>
              </div>
              <div className="font-stepper" id="chat-font-size">
                <button
                  type="button"
                  aria-label="Diminuir a fonte do chat"
                  disabled={chatFontSize <= CHAT_FONT_SIZE_RANGE.min}
                  onClick={() => setChatFontSize(chatFontSize - CHAT_FONT_SIZE_STEP)}
                >
                  −
                </button>
                <output aria-live="polite">{chatFontLabel}</output>
                <button
                  type="button"
                  aria-label="Aumentar a fonte do chat"
                  disabled={chatFontSize >= CHAT_FONT_SIZE_RANGE.max}
                  onClick={() => setChatFontSize(chatFontSize + CHAT_FONT_SIZE_STEP)}
                >
                  +
                </button>
                <button
                  type="button"
                  className="pref-reset"
                  aria-label="Restaurar o tamanho padrão da fonte do chat"
                  disabled={chatFontSize === CHAT_FONT_SIZE_DEFAULT}
                  onClick={() => setChatFontSize(CHAT_FONT_SIZE_DEFAULT)}
                >
                  ↺
                </button>
              </div>
            </div>
            <div className="pref-subfield">
              <div className="pref-label-row">
                <label htmlFor="chat-line-height">altura da linha</label>
                <span>{chatLineHeight.toFixed(2)}</span>
              </div>
              <div className="line-height-control">
                <input
                  id="chat-line-height"
                  type="range"
                  min={CHAT_LINE_HEIGHT_RANGE.min}
                  max={CHAT_LINE_HEIGHT_RANGE.max}
                  step="0.05"
                  value={chatLineHeight}
                  onChange={(event) => setChatLineHeight(Number(event.target.value))}
                />
                <output>{chatLineHeight.toFixed(2)}</output>
                <button
                  type="button"
                  className="pref-reset"
                  aria-label="Restaurar a altura de linha padrão do chat"
                  disabled={chatLineHeight === CHAT_LINE_HEIGHT_DEFAULT}
                  onClick={() => setChatLineHeight(CHAT_LINE_HEIGHT_DEFAULT)}
                >
                  ↺
                </button>
              </div>
            </div>
            <small>Só as mensagens do chat, por cima da escala da interface.</small>
          </div>
        </div>

        <div className="type-preview paper" aria-label="Prévia da interface">
          <div className="paper-titlebar">
            <span>prévia · tamanho real</span>
            <em>é assim que o Synkora fica</em>
          </div>
          <div className="a11y-preview-body">
            <div className="a11y-preview-mission">
              <strong>🚀 Missão de exemplo</strong>
              <span>◈ V1.0 · dev em conversa</span>
            </div>
            <p className="a11y-preview-msg">
              <span className="who">agente ›</span> Notificações reescritas e clique ligado ao
              navegador. Rodando o typecheck.
            </p>
            <div className="a11y-preview-row">
              <button type="button" className="btn tiny" tabIndex={-1}>
                ⇪ integrar
              </button>
              <button type="button" className="btn ghost tiny" tabIndex={-1}>
                arquivar
              </button>
            </div>
            <span className="a11y-preview-note">
              ✓ 0123456789 · AaBbCc · escala {scale}% · chat {chatFontLabel}
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}
