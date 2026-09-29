import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import { InlineNotice } from './NoticeStack'

// NOVO UNIVERSO (Synkora 2.0, onda D) — o "+" da Home e do rail passam por
// aqui porque o nascimento do projeto ganhou uma decisão nova: o LINK DO
// GITHUB (opcional).
//
// Com link, o main conecta o repositório no nascimento (init + remote + push,
// ou clone quando o repo já existe). Sem link, nada muda em relação ao fluxo
// de sempre: escolher a pasta É criar o universo.
//
// A falha de push/auth NÃO cancela nada: o universo já existe e o aviso chega
// em PT-BR nesta mesma janela — é o dono que decide o que fazer com o remoto.

export default function NewUniverseModal({
  onClose
}: {
  onClose: () => void
}): React.JSX.Element {
  const createProject = useStore((s) => s.createProject)
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [gitUrl, setGitUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** aviso do main depois de criar (push/auth falhou) — o universo JÁ existe */
  const [warning, setWarning] = useState<string | null>(null)

  async function pickFolder(): Promise<void> {
    const folder = await window.synkora.pickFolder()
    if (!folder) return
    setPath(folder)
    // o nome sai da pasta (renomeável na barra do universo) — pedir nome antes
    // da pasta era o único lugar do app que fazia isso
    if (!name.trim()) setName(folder.split(/[\\/]/).filter(Boolean).pop() ?? 'universo')
    setError('')
  }

  async function create(): Promise<void> {
    if (busy) return
    if (!path) {
      setError('escolha a pasta do projeto primeiro')
      return
    }
    setBusy(true)
    const aviso = await createProject(name.trim() || 'universo', path, gitUrl.trim() || undefined)
    setBusy(false)
    if (aviso) {
      setWarning(aviso)
      return
    }
    onClose()
  }

  return createPortal(
    <div className="overlay">
      <div
        className="task-modal confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Novo universo"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="task-modal-head">
          <span className="task-dept">＋ novo universo</span>
          <button className="pane-close dark-close" onClick={onClose}>
            ×
          </button>
        </div>

        {warning ? (
          <>
            <p className="confirm-text">
              O universo foi criado — mas o GitHub não fechou o ciclo:
            </p>
            <InlineNotice tone="warn">{warning}</InlineNotice>
            <p className="confirm-sub">
              Nada se perdeu: o projeto está aqui e a pasta é sua. Ajuste o remoto quando
              quiser.
            </p>
            <div className="task-modal-actions">
              <span className="task-modal-meta" />
              <button className="btn accent" onClick={onClose}>
                entendi
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="confirm-text">
              Escolha a pasta do projeto. Com um link do GitHub, o Synkora conecta o
              repositório já no nascimento.
            </p>
            <div className="nu-row">
              <button className="btn ghost tiny" disabled={busy} onClick={() => void pickFolder()}>
                📁 escolher pasta
              </button>
              <span className="nu-path" data-tip={path || undefined}>
                {path || 'nenhuma pasta escolhida'}
              </span>
            </div>
            <div className="mission-exec-row">
              <label>
                nome
                <input
                  className="task-modal-title"
                  value={name}
                  placeholder="sai do nome da pasta"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                link do GitHub (opcional)
                <input
                  className="task-modal-title"
                  value={gitUrl}
                  placeholder="https://github.com/voce/projeto"
                  onChange={(e) => {
                    setGitUrl(e.target.value)
                    setError('')
                  }}
                />
              </label>
            </div>
            {error && <InlineNotice tone="error">{error}</InlineNotice>}
            <div className="task-modal-actions">
              <button className="btn ghost" onClick={onClose}>
                cancelar
              </button>
              <span className="task-modal-meta" />
              <button className="btn accent" disabled={busy || !path} onClick={() => void create()}>
                {busy ? '… criando' : '✦ criar universo'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
