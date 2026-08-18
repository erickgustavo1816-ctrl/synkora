import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import FilePreviewPanel from './FilePreviewPanel'
import type { FilePreviewResult, FileTreeRoot } from '../../../preload/index'

// LEITURA RÁPIDA DA ENTREGA (rodada 7, C1) — "ver pelo Synkora", no trilho.
//
// A lista de "ver arquivos" do trilho era texto morto: o dono via o nome do
// `.html` que a missão produziu e não tinha como abrir NADA sem sair da tela da
// decisão. Agora o clique abre o arquivo aqui, e o leitor é o MESMO da aba
// Arquivos (`FilePreviewPanel`) — não nasce um segundo viewer no app, com
// outras regras de papel, outro badge de somente-leitura e outro jeito de
// mostrar imagem.
//
// A leitura passa pelo canal somente-leitura de sempre (`files:preview`), que
// resolve a raiz por ID no main. Nada aqui escreve no worktree.

interface Props {
  projectId: string
  root: FileTreeRoot
  /** caminho relativo à raiz autorizada */
  path: string
  onClose: () => void
}

interface PreviewBridge {
  preview: (
    projectId: string,
    root: FileTreeRoot,
    relativePath: string
  ) => Promise<FilePreviewResult | null>
}

export default function GuiFileQuickReader({
  projectId,
  root,
  path,
  onClose
}: Props): React.JSX.Element {
  const [preview, setPreview] = useState<FilePreviewResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let stale = false
    setLoading(true)
    setPreview(null)
    const files = window.synkora.files as Partial<PreviewBridge>
    if (typeof files?.preview !== 'function') {
      setLoading(false)
      setPreview({
        ok: false,
        error: 'reinicie o app (npm run dev) para ler arquivo por aqui',
        path
      })
      return
    }
    const request = files.preview(projectId, root, path)
    void request
      .then((result) => {
        if (stale) return
        setPreview(result)
        setLoading(false)
      })
      .catch(() => {
        if (stale) return
        setPreview({ ok: false, error: 'não foi possível abrir este arquivo agora', path })
        setLoading(false)
      })
    return () => {
      stale = true
    }
  }, [projectId, root, path, revision])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Escape fecha UMA camada por vez: com o menu de contexto aberto por
        // dentro desta folha, ele é quem some — derrubar a leitura junto seria
        // desfazer duas coisas com um gesto só. (Este ouvinte é de CAPTURA, no
        // window, então sem esta porta ele passaria na frente do menu.)
        const origin = event.target as Element | null
        if (typeof origin?.closest === 'function' && origin.closest('[role="menu"]')) return
        event.preventDefault()
        event.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', closeOnEscape, true)
    return () => window.removeEventListener('keydown', closeOnEscape, true)
  }, [onClose])

  const reload = useCallback((): void => setRevision((value) => value + 1), [])
  const name = path.split('/').at(-1) ?? path

  return createPortal(
    <div
      className="gui-file-reader-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="gui-file-reader-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Leitura de ${name}`}
      >
        <div className="gui-file-reader-head">
          <span className="gui-file-reader-title">leitura da entrega</span>
          <button
            type="button"
            className="gui-file-reader-close"
            aria-label="Fechar a leitura"
            data-tip="Fechar (Esc)"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <FilePreviewPanel
          path={path}
          preview={preview}
          loading={loading}
          onReload={reload}
          projectId={projectId}
          root={root}
        />
      </div>
    </div>,
    document.body
  )
}
