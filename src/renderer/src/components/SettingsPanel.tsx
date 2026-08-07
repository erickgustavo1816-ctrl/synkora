import { useState } from 'react'
import Select from './Select'
import { useStore } from '../store'

// ————————————————————————————————————————————————————————————————————————
// AJUSTES DE IMAGEM — seção própria dentro da central de Configurações.
//
// O que saiu e POR QUE, para ninguém trazer de volta sem motivo:
//  · versão dos CLIs → já é o dropdown `clis ▾` do titlebar;
//  · limites das contas → já é o `limites ▾` do titlebar;
//  · ConPTY e limpar layouts → diagnóstico, não rotina de quem está entrando.
//
// O painel é `.term-window` (o padrão da casa). A tentativa de fazê-lo em
// papel foi reprovada na hora ("ficou feio, não está combinando com o app"):
// sem nenhuma superfície escura a página vira uma massa clara sem hierarquia —
// o contraste papel × painel É a identidade do Synkora, não um detalhe.
// ————————————————————————————————————————————————————————————————————————

interface Props {
  /** registra o cartão como âncora de gravidade do campo de partículas */
  anchor?: (key: string, el: HTMLElement | null) => void
  /** aceso quando o alerta do topo aponta para cá */
  highlight?: string | null
}

export default function SettingsPanel({ anchor, highlight }: Props): React.JSX.Element {
  const seats = useStore((s) => s.seats)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const setSettingsSecret = useStore((s) => s.setSettingsSecret)

  const [editKey, setEditKey] = useState(false)
  const [keyError, setKeyError] = useState<string | null>(null)

  const codexSeats = seats.filter((s) => s.cli === 'codex')
  const provider = settings?.imageProvider ?? 'codex'
  const routeConfigured =
    provider === 'codex' ? codexSeats.length > 0 : Boolean(settings?.openrouterKeyConfigured)
  const routeDetail = keyError ?? (
    provider === 'codex'
      ? codexSeats.length > 0
        ? `${codexSeats.length} ${codexSeats.length === 1 ? 'conta Codex disponível' : 'contas Codex disponíveis'}`
        : 'adicione uma conta Codex para concluir a rota'
      : settings?.openrouterKeyConfigured
        ? 'chave da API protegida e pronta para uso'
        : 'adicione uma chave da OpenRouter para concluir a rota'
  )

  return (
    <section
      className={`image-panel term-window ${highlight === 'imagens' ? 'flash' : ''}`}
      ref={(el) => anchor?.('settings', el)}
    >
      <div className="term-titlebar">
        <span className="dots">
          <i />
          <i />
          <i />
        </span>
        <span className="term-title">geração de imagens</span>
        <code className="image-title-tool">generate_image</code>
        <span className={`image-route-state${routeConfigured ? '' : ' warn'}`}>
          <i className={`meta-dot ${routeConfigured ? 'run' : 'err'}`} />
          {routeConfigured ? 'configurada' : 'requer ajuste'}
        </span>
      </div>

      <div className="image-body">
        <div className="image-summary">
          <span className="image-kicker">rota dos agentes</span>
          <strong>Quem cria as imagens</strong>
          <p>Escolha o serviço e a credencial usados quando um agente chama a ferramenta.</p>
          <span className={`image-route-detail${routeConfigured ? '' : ' warn'}`}>{routeDetail}</span>
        </div>

        <div className={`image-controls ${provider}`}>
          <div className="set-row">
            <label>provedor</label>
            <Select
              className="dark"
              tip="Provedor de geração de imagens"
              value={provider}
              onChange={(v) => {
                setKeyError(null)
                void patchSettings({ imageProvider: v as 'codex' | 'openrouter' })
              }}
              options={[
                {
                  value: 'codex',
                  label: 'Codex — geração nativa',
                  hint: 'image_generation',
                  cli: 'codex'
                },
                { value: 'openrouter', label: 'OpenRouter — API', hint: 'modelos externos' }
              ]}
            />
          </div>

          {provider === 'codex' && (
            <div className="set-row">
              <label>conta</label>
              {codexSeats.length === 0 ? (
                <span className="set-warn set-control">nenhuma conta Codex</span>
              ) : (
                <Select
                  className="dark"
                  tip="Conta usada para gerar imagens"
                  value={settings?.imageSeatId ?? ''}
                  onChange={(v) => void patchSettings({ imageSeatId: v || undefined })}
                  options={[
                    { value: '', label: 'primeira conta Codex disponível' },
                    ...codexSeats.map((s) => ({ value: s.id, label: s.name, cli: s.cli }))
                  ]}
                />
              )}
            </div>
          )}

          {provider === 'openrouter' && (
            <>
              <div className="set-row">
                <label htmlFor="openrouter-image-key">chave da API</label>
                {settings?.openrouterKeyConfigured && !editKey ? (
                  <span className="set-secret">
                    <span>{settings.openrouterKeyMasked ?? '••••••••'} definida</span>
                    <button
                      type="button"
                      className="btn ghost tiny"
                      onClick={() => {
                        setKeyError(null)
                        setEditKey(true)
                      }}
                    >
                      trocar
                    </button>
                  </span>
                ) : (
                  // nunca renderizar o valor guardado: o campo abre VAZIO e só
                  // grava o que for digitado agora
                  <input
                    id="openrouter-image-key"
                    className="set-input"
                    type="password"
                    autoFocus={editKey}
                    placeholder="sk-or-…"
                    defaultValue=""
                    onBlur={(e) => {
                      const v = e.target.value.trim()
                      setEditKey(false)
                      if (v) {
                        void setSettingsSecret('openrouterKey', v)
                          .then(() => setKeyError(null))
                          .catch(() => setKeyError('não foi possível proteger a chave agora; tente novamente'))
                      }
                    }}
                  />
                )}
              </div>
              <div className="set-row">
                <label>modelo</label>
                <Select
                  className="dark"
                  tip="Modelo usado para gerar imagens"
                  value={settings?.openrouterModel ?? 'google/gemini-2.5-flash-image'}
                  onChange={(v) => void patchSettings({ openrouterModel: v })}
                  options={[
                    {
                      value: 'google/gemini-2.5-flash-image',
                      label: 'Nano Banana',
                      hint: 'Gemini Flash Image'
                    },
                    { value: 'openai/gpt-image-1', label: 'GPT Image 1' }
                  ]}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
