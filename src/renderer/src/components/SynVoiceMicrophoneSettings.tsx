import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import Select from './Select'
import SynVoiceIcon from './SynVoiceIcon'

interface MicrophoneOption {
  deviceId: string
  label: string
}

function messageOf(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'O acesso ao microfone foi bloqueado. Libere a permissão do Synkora no Windows.'
  }
  return error instanceof Error ? error.message : String(error)
}

export default function SynVoiceMicrophoneSettings(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const selectedId = settings?.synVoiceInputDeviceId ?? ''
  const [microphones, setMicrophones] = useState<MicrophoneOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async (requestPermission = false): Promise<void> => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setLoading(false)
      setError('Este sistema não disponibilizou a lista de microfones.')
      return
    }
    setLoading(true)
    setError('')
    let permissionStream: MediaStream | null = null
    try {
      if (requestPermission) {
        permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      }
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
        (device) => device.kind === 'audioinput'
      )
      setMicrophones(
        devices.map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label.trim() || `Microfone ${index + 1}`
        }))
      )
    } catch (reason: unknown) {
      setError(messageOf(reason))
    } finally {
      for (const track of permissionStream?.getTracks() ?? []) track.stop()
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh(false)
    const onChange = (): void => void refresh(false)
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onChange)
  }, [refresh])

  const selectedAvailable = !selectedId || microphones.some((item) => item.deviceId === selectedId)
  const options = useMemo(() => {
    const list = [
      {
        value: '',
        label: 'Padrão do sistema',
        hint: 'acompanha a escolha do Windows'
      },
      ...microphones.map((microphone) => ({
        value: microphone.deviceId,
        label: microphone.label
      }))
    ]
    if (selectedId && !selectedAvailable) {
      list.splice(1, 0, {
        value: selectedId,
        label: 'Microfone salvo não encontrado',
        hint: 'conecte-o novamente ou escolha outro'
      })
    }
    return list
  }, [microphones, selectedAvailable, selectedId])

  return (
    <section className="settings-card voice-device-settings">
      <header className="settings-card-head">
        <div>
          <span className="settings-card-kicker">entrada de áudio</span>
          <h2>Microfone do SynVoice</h2>
          <p>
            Escolha o dispositivo usado em toda gravação. Se deixar no padrão, o SynVoice
            acompanha automaticamente a seleção do Windows.
          </p>
        </div>
        <span className={`settings-card-state${selectedAvailable ? '' : ' warn'}`}>
          <i className={`meta-dot ${selectedAvailable ? 'run' : 'err'}`} />
          {selectedAvailable ? 'pronto' : 'indisponível'}
        </span>
      </header>

      <div className="voice-device-row">
        <span className="voice-device-icon" aria-hidden="true">
          <SynVoiceIcon state="mic" />
        </span>
        <div className="voice-device-select">
          <label>microfone de entrada</label>
          <Select
            value={selectedId}
            options={options}
            disabled={loading}
            placeholder={loading ? 'detectando microfones…' : 'nenhum microfone encontrado'}
            tip="Microfone usado pelo SynVoice"
            onChange={(value) =>
              void patchSettings({ synVoiceInputDeviceId: value || undefined })
            }
          />
        </div>
        <button
          type="button"
          className="btn ghost"
          disabled={loading}
          onClick={() => void refresh(true)}
        >
          {loading ? 'detectando…' : 'detectar novamente'}
        </button>
      </div>

      {error && <div className="settings-inline-error" role="alert">{error}</div>}
      {!error && microphones.length === 0 && !loading && (
        <p className="settings-inline-note">
          Nenhum nome apareceu ainda. Clique em “detectar novamente” para liberar o acesso e
          identificar os dispositivos.
        </p>
      )}

      <div className="voice-advanced-link">
        <div>
          <strong>Provedor, modelo, atalhos e vocabulário</strong>
          <span>As opções avançadas do SynVoice continuam disponíveis na mesma central.</span>
        </div>
        <button
          type="button"
          className="btn ghost"
          onClick={() => window.dispatchEvent(new Event('synkora:open-voice-settings'))}
        >
          abrir opções do SynVoice
        </button>
      </div>
    </section>
  )
}
