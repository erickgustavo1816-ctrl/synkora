import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { appUpdateBadgeView, type AppUpdateStatus } from '../appUpdatePresentation'

// O SELO DE VERSÃO no pé do rail dos universos (missão "Atualização do
// Synkora", 2026-09-21 — pedido do dono: "no canto inferior esquerdo, ali na
// parte onde ficam os universos, mostrar qual é a versão e se está na mais
// recente; se não estiver, baixa sozinho e instala dentro do Synkora").
//
// O main faz o trabalho (electron-updater: verifica, baixa, verifica a
// assinatura do pacote e instala em silêncio ao reiniciar). Este componente só
// escuta o estado e oferece o único gesto que é do dono: REINICIAR. A folha de
// confirmação existe porque reiniciar derruba as conversas abertas — elas
// voltam com o app, mas a decisão é dele.

export default function AppUpdateBadge(): React.JSX.Element {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.synkora.appUpdate.status().then((next) => {
      if (alive) setStatus(next)
    })
    const off = window.synkora.appUpdate.onStatus((next) => setStatus(next))
    const clock = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => {
      alive = false
      off()
      window.clearInterval(clock)
    }
  }, [])

  const view = appUpdateBadgeView(status, now)

  const act = useCallback(async () => {
    if (busy) return
    if (view.action === 'check') {
      setBusy(true)
      try {
        setStatus(await window.synkora.appUpdate.check())
      } finally {
        setBusy(false)
      }
      return
    }
    if (view.action === 'download') {
      setBusy(true)
      try {
        setStatus(await window.synkora.appUpdate.download())
      } finally {
        setBusy(false)
      }
      return
    }
    if (view.action === 'install') {
      setInstallError(null)
      setConfirming(true)
    }
  }, [busy, view.action])

  const install = useCallback(async () => {
    if (busy) return
    setBusy(true)
    const result = await window.synkora.appUpdate.install()
    if (!result.ok) {
      setInstallError(result.error ?? 'não consegui iniciar a instalação')
      setBusy(false)
    }
    // ok = o app está saindo para instalar; nada mais a desenhar.
  }, [busy])

  useEffect(() => {
    if (!confirming) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setConfirming(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirming])

  return (
    <div className="rail-version">
      <button
        type="button"
        className={`rail-version-badge tone-${view.tone}${busy ? ' busy' : ''}`}
        data-tip={view.tip}
        aria-label={view.ariaLabel}
        aria-busy={busy || undefined}
        onClick={() => void act()}
      >
        {view.glyph && (
          <span className="rail-version-glyph" aria-hidden="true">
            {view.glyph}
          </span>
        )}
        <span className="rail-version-label">{view.label}</span>
        {view.percent !== null && (
          <span className="rail-version-bar" aria-hidden="true">
            <i style={{ width: `${view.percent}%` }} />
          </span>
        )}
      </button>

      {confirming &&
        createPortal(
          <div className="rail-version-sheet-backdrop" onMouseDown={() => setConfirming(false)}>
            <div
              className="rail-version-sheet"
              role="dialog"
              aria-label="Reiniciar e atualizar o Synkora"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <span className="rail-version-sheet-kicker">atualização pronta</span>
              <strong>Reiniciar e instalar o Synkora {status?.next ?? ''}?</strong>
              <p>
                O app fecha, instala em silêncio e volta sozinho. As conversas abertas são
                retomadas quando ele voltar.
              </p>
              {installError && <p className="rail-version-sheet-error">{installError}</p>}
              <div className="rail-version-sheet-actions">
                <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>
                  depois
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => void install()}>
                  {busy ? 'reiniciando…' : 'reiniciar agora'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
