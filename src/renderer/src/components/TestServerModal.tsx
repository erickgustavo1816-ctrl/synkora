import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'

/**
 * Modal do "▶ testar" (decisão do usuário, 2026-08-06): sobe o dev server do
 * worktree da MISSÃO (testar a branch isolada) ou da VERSÃO (testar o conjunto
 * integrado) num pane shell — o usuário escolhe a porta e o comando nasce
 * digitado no terminal, visível e editável.
 */
export function TestServerModal({
  projectId,
  target,
  label,
  onClose
}: {
  projectId: string
  target: { missionId?: string; versionId?: string }
  label: string
  onClose: () => void
}): React.JSX.Element {
  const addPane = useStore((s) => s.addPane)
  const setTab = useStore((s) => s.setUniverseTab)
  const [port, setPort] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  // Mapa de portas em uso pelo harness (decisão do dono, 2026-08-07): o dono
  // escolhe a porta VENDO o que está ocupado — mesma linha que o QA recebe.
  const [portsMap, setPortsMap] = useState('')
  useEffect(() => {
    let alive = true
    void window.synkora.panes?.portsInUse?.(projectId).then((map) => {
      if (alive) setPortsMap(map || '')
    })
    return () => {
      alive = false
    }
  }, [projectId])

  async function start(): Promise<void> {
    if (busy) return
    const portN = port.trim() ? Number(port.trim()) : undefined
    if (port.trim() && (!Number.isInteger(portN) || portN! < 1 || portN! > 65535)) {
      setErr('porta inválida — use um número entre 1 e 65535 (ou deixe vazio)')
      return
    }
    if (!window.synkora.panes?.testServerSpec) {
      setErr('reinicie o app para habilitar o servidor de teste')
      return
    }
    setBusy(true)
    const res = await window.synkora.panes.testServerSpec(projectId, target, portN)
    setBusy(false)
    if (!res.ok || !res.paneId || !res.cwd) {
      setErr(res.msg || 'não foi possível preparar o servidor de teste')
      return
    }
    onClose()
    setTab(projectId, 'panes')
    addPane(projectId, 'shell', {
      id: res.paneId,
      title: res.title,
      cwd: res.cwd,
      missionId: res.missionId,
      versionId: res.versionId,
      testServer: true
    })
  }

  return createPortal(
    <div className="overlay" onClick={onClose}>
      <div className="task-modal confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="task-modal-head">
          <span className="task-dept">▶ testar {label}</span>
          <button className="pane-close dark-close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="confirm-text">
          Sobe o servidor desta branch num terminal para você testar. O comando fica visível no
          pane — feche o pane para derrubar o servidor.
        </p>
        <p className="confirm-text">
          {portsMap
            ? `⚠ portas em uso agora: ${portsMap}`
            : 'nenhuma porta em uso pelo harness agora — qualquer uma serve'}
        </p>
        <div className="mission-exec-row">
          <label>
            porta (opcional)
            <input
              className="task-modal-title"
              value={port}
              placeholder="padrão do projeto"
              onChange={(e) => {
                setPort(e.target.value)
                setErr('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void start()
              }}
            />
          </label>
        </div>
        {err && <div className="mission-msg">{err}</div>}
        <div className="task-modal-actions">
          <button className="btn ghost" onClick={onClose}>
            cancelar
          </button>
          <span className="task-modal-meta" />
          <button className="btn accent" disabled={busy} onClick={() => void start()}>
            {busy ? 'preparando…' : '▶ subir e testar'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
