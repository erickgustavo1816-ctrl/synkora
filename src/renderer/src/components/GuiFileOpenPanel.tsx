import { useCallback, useEffect, useId, useRef } from 'react'
import FileMarkdownContent from './FileMarkdownContent'
import type { GuiFileOpenMode, GuiFileOpenResult } from '../guiApi'
import {
  isChatFileTarget,
  runGuiChatFileOpen,
  type ChatFileContextTarget,
  type FileContextTarget
} from '../guiFileContextMenu'
import GuiFileContextMenu, { useFileContextMenu } from './GuiFileContextMenu'

function fileSizeLabel(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

interface Props {
  /** a conversa dona desta folha — é dela que o main tira a pasta autorizada */
  paneId: string
  result: GuiFileOpenResult
  busy: boolean
  onChoose: (path: string) => void
  /** reler ESTA folha (o "abrir no app" quando aqui já é onde ele está) */
  onReopen: (reference: string, selectedPath: string, mode?: GuiFileOpenMode) => void
  onClose: () => void
}

/** Superfície mínima e read-only de P17. P25 pode substituir o corpo do
 * preview mantendo o mesmo contrato `GuiFileOpenResult`; escolha, erros e a
 * fronteira IPC não precisam mudar. */
export default function GuiFileOpenPanel({
  paneId,
  result,
  busy,
  onChoose,
  onReopen,
  onClose
}: Props): React.JSX.Element {
  const initialFocusRef = useRef<HTMLButtonElement | null>(null)
  const menuButtonRef = useRef<HTMLButtonElement | null>(null)
  const titleId = useId()

  // ONDE ABRIR ESTE ARQUIVO (rodada 7, C1 — a metade do CHAT). A folha segue
  // sendo a leitura DEFAULT: "abrir no app" aqui é reler esta folha. As outras
  // duas saídas atravessam o canal do pane com a ambiguidade JÁ resolvida — a
  // referência e a escolha são o caminho que o main provou.
  const preview = result.ok && result.action === 'preview' ? result.preview : null
  const openTarget: ChatFileContextTarget | null = preview
    ? {
        paneId,
        reference: preview.path,
        selectedPath: preview.path,
        path: preview.path,
        current: true
      }
    : null

  // "abrir no app" com o arquivo JÁ nesta folha é reler esta folha — a única
  // leitura honesta de "abrir aqui" quando aqui já é onde ele está.
  const reopenHere = useCallback((menuTarget: FileContextTarget): void => {
    if (!isChatFileTarget(menuTarget) || !menuTarget.selectedPath) return
    onReopen(menuTarget.reference, menuTarget.selectedPath, 'preview')
  }, [onReopen])

  const openBrowser = useCallback((menuTarget: FileContextTarget): void => {
    if (!isChatFileTarget(menuTarget) || !menuTarget.selectedPath) return
    onReopen(menuTarget.reference, menuTarget.selectedPath, 'browser')
  }, [onReopen])

  const fileMenu = useFileContextMenu(reopenHere, runGuiChatFileOpen, openBrowser)
  const menuOpen = Boolean(fileMenu.menu)

  useEffect(() => {
    initialFocusRef.current?.focus({ preventScroll: true })
  }, [result])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Com o menu aberto, Escape é DELE (fecha o menu e devolve o foco ao ↗);
      // fechar a folha inteira aqui roubaria o gesto de quem está escolhendo.
      if (menuOpen) return
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', closeOnEscape, true)
    return () => window.removeEventListener('keydown', closeOnEscape, true)
  }, [menuOpen, onClose])

  if (!result.ok && result.reason === 'ambiguous' && result.choices?.length) {
    return (
      <section
        className="gui-file-panel gui-file-choices"
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
      >
        <div className="gui-file-panel-head">
          <div>
            <strong id={titleId}>qual arquivo?</strong>
            <span>{result.error}</span>
          </div>
          <button
            className="gui-file-close"
            type="button"
            aria-label="Fechar escolha de arquivo"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="gui-file-choice-list">
          {result.choices.map((choice, index) => (
            <button
              key={choice.path}
              ref={index === 0 ? initialFocusRef : undefined}
              className="gui-file-choice"
              type="button"
              disabled={busy}
              onClick={() => onChoose(choice.path)}
            >
              <strong>{choice.name}</strong>
              <span>{choice.path}</span>
            </button>
          ))}
        </div>
        {result.truncated && (
          <p className="gui-file-panel-note">
            há mais resultados — feche e peça ao agente um caminho mais completo
          </p>
        )}
      </section>
    )
  }

  if (preview) {
    return (
      <section
        className="gui-file-panel gui-file-preview"
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        onContextMenu={(event) => {
          if (openTarget) fileMenu.openFromPointer(event, openTarget)
        }}
      >
        <div className="gui-file-panel-head">
          <div>
            <strong id={titleId}>{preview.name}</strong>
            <span title={preview.path}>{preview.path}</span>
          </div>
          <span className="gui-file-panel-actions">
            {openTarget && (
              <button
                ref={menuButtonRef}
                className="gui-file-close gui-file-panel-open"
                type="button"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title="Escolha onde abrir este arquivo."
                aria-label="Onde abrir este arquivo"
                onClick={() => fileMenu.openFromAnchor(menuButtonRef.current, openTarget)}
              >
                ↗
              </button>
            )}
            <button
              ref={initialFocusRef}
              className="gui-file-close"
              type="button"
              aria-label="Fechar preview do arquivo"
              onClick={onClose}
            >
              ×
            </button>
          </span>
        </div>
        {/* Recusa do sistema (arquivo sumiu, sem programa padrão) fica NA folha:
            o gesto e a resposta no mesmo lugar. */}
        {fileMenu.notice && <p className="gui-file-open-notice">// {fileMenu.notice}</p>}
        <div className="gui-file-preview-body">
          {preview.kind === 'image' ? (
            <img src={preview.content} alt={`Preview de ${preview.name}`} />
          ) : preview.kind === 'markdown' ? (
            // R26 — .md abre BONITO no chat: o mesmo renderizador da aba
            // Arquivos (um pipeline só), e o corpo quebra linha em vez de
            // ganhar rolagem lateral.
            <FileMarkdownContent content={preview.content} />
          ) : (
            <pre tabIndex={0}><code>{preview.content}</code></pre>
          )}
        </div>
        <div className="gui-file-preview-foot">
          somente leitura · {fileSizeLabel(preview.size)}
        </div>
        {fileMenu.menu && (
          <GuiFileContextMenu
            target={fileMenu.menu.target}
            options={fileMenu.menu.options}
            x={fileMenu.menu.x}
            y={fileMenu.menu.y}
            onChoose={fileMenu.choose}
            onDismiss={fileMenu.dismiss}
          />
        )}
      </section>
    )
  }

  // Aqui só chegam os dois desfechos SEM folha: o recado do `reveal` e a recusa
  // (o preview já voltou acima). Quem separa é o `action`, não o `ok`.
  const message = result.ok ? (result.action === 'reveal' || result.action === 'browser' ? result.message : '') : result.error

  return (
    <section
      className={`gui-file-panel gui-file-feedback${result.ok ? '' : ' error'}`}
      role={result.ok ? 'status' : 'alert'}
    >
      <span>{message}</span>
      <button
        ref={initialFocusRef}
        className="gui-file-close"
        type="button"
        aria-label="Fechar aviso de arquivo"
        onClick={onClose}
      >
        ×
      </button>
    </section>
  )
}
