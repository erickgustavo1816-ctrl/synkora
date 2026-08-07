import { useEffect, useState } from 'react'
import { useStore } from '../store'
import {
  TERMINAL_DEFAULT_FONT_FAMILY,
  TERMINAL_DEFAULT_FONT_SIZE,
  TERMINAL_DEFAULT_LINE_HEIGHT,
  terminalFontStack
} from '../terminalGeometry'

const FONT_MIN = 8
const FONT_MAX = 24
const LINE_MIN = 1
const LINE_MAX = 1.8

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export default function AppearanceSettings(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const fontSize = settings?.terminalFontSize ?? TERMINAL_DEFAULT_FONT_SIZE
  const lineHeight = settings?.terminalLineHeight ?? TERMINAL_DEFAULT_LINE_HEIGHT
  const fontFamily = settings?.terminalFontFamily ?? TERMINAL_DEFAULT_FONT_FAMILY
  const [familyDraft, setFamilyDraft] = useState(fontFamily)

  useEffect(() => setFamilyDraft(fontFamily), [fontFamily])

  const setFontSize = (value: number): void => {
    void patchSettings({ terminalFontSize: clamp(Math.round(value), FONT_MIN, FONT_MAX) })
  }

  const setLineHeight = (value: number): void => {
    void patchSettings({
      terminalLineHeight: Math.round(clamp(value, LINE_MIN, LINE_MAX) * 100) / 100
    })
  }

  const commitFamily = (): void => {
    const value = familyDraft.trim() || TERMINAL_DEFAULT_FONT_FAMILY
    setFamilyDraft(value)
    if (value !== fontFamily) void patchSettings({ terminalFontFamily: value })
  }

  const resetAll = (): void => {
    void patchSettings({
      terminalFontSize: TERMINAL_DEFAULT_FONT_SIZE,
      terminalLineHeight: TERMINAL_DEFAULT_LINE_HEIGHT,
      terminalFontFamily: TERMINAL_DEFAULT_FONT_FAMILY
    })
  }

  return (
    <section className="settings-card typography-settings">
      <header className="settings-card-head">
        <div>
          <span className="settings-card-kicker">painéis e terminais</span>
          <h2>Tipografia fixa</h2>
          <p>
            O tamanho escolhido vale para todos os painéis. Ao estreitar um painel,
            cabem menos colunas — a letra não encolhe, não estica e não ganha zoom.
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
              <label htmlFor="terminal-font-size">tamanho da fonte</label>
              <span>{fontSize}px</span>
            </div>
            <div className="font-stepper" id="terminal-font-size">
              <button
                type="button"
                aria-label="Diminuir tamanho da fonte"
                disabled={fontSize <= FONT_MIN}
                onClick={() => setFontSize(fontSize - 1)}
              >
                −
              </button>
              <output aria-live="polite">{fontSize}px</output>
              <button
                type="button"
                aria-label="Aumentar tamanho da fonte"
                disabled={fontSize >= FONT_MAX}
                onClick={() => setFontSize(fontSize + 1)}
              >
                +
              </button>
              <button
                type="button"
                className="pref-reset"
                aria-label="Restaurar tamanho padrão"
                disabled={fontSize === TERMINAL_DEFAULT_FONT_SIZE}
                onClick={() => setFontSize(TERMINAL_DEFAULT_FONT_SIZE)}
              >
                ↺
              </button>
            </div>
            <small>Também funciona com Ctrl + −, Ctrl + + e Ctrl + 0 nos painéis.</small>
          </div>

          <div className="pref-field">
            <div className="pref-label-row">
              <label htmlFor="terminal-line-height">altura da linha</label>
              <span>{lineHeight.toFixed(2)}</span>
            </div>
            <div className="line-height-control">
              <input
                id="terminal-line-height"
                type="range"
                min={LINE_MIN}
                max={LINE_MAX}
                step="0.05"
                value={lineHeight}
                onChange={(event) => setLineHeight(Number(event.target.value))}
              />
              <output>{lineHeight.toFixed(2)}</output>
              <button
                type="button"
                className="pref-reset"
                aria-label="Restaurar altura de linha padrão"
                disabled={lineHeight === TERMINAL_DEFAULT_LINE_HEIGHT}
                onClick={() => setLineHeight(TERMINAL_DEFAULT_LINE_HEIGHT)}
              >
                ↺
              </button>
            </div>
          </div>

          <div className="pref-field">
            <div className="pref-label-row">
              <label htmlFor="terminal-font-family">fonte</label>
            </div>
            <input
              id="terminal-font-family"
              className="pref-text-input"
              type="text"
              list="terminal-font-presets"
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
            <datalist id="terminal-font-presets">
              <option value="Cascadia Code" />
              <option value="Cascadia Mono" />
              <option value="Consolas" />
              <option value="JetBrains Mono" />
              <option value="Fira Code" />
            </datalist>
            <small>Use uma fonte monoespaçada instalada no Windows.</small>
          </div>
        </div>

        <div className="type-preview term-window" aria-label="Prévia da tipografia do terminal">
          <div className="term-titlebar">
            <span className="dots"><i /><i /><i /></span>
            <span className="term-title">prévia · tamanho real</span>
            <span className="type-preview-cols">painel estreito = menos colunas</span>
          </div>
          <pre
            style={{
              fontFamily: terminalFontStack(fontFamily),
              fontSize: `${fontSize}px`,
              lineHeight
            }}
          >
            <span className="preview-prompt">synkora ›</span> executando missão{`\n`}
            <span className="preview-ok">✓</span> fonte fixa em {fontSize}px{`\n`}
            <span className="preview-muted">0123456789 · AaBbCc · ╭─╮</span>
          </pre>
        </div>
      </div>
    </section>
  )
}
