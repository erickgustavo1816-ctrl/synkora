import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FileActionResult } from '../../../preload/index'
import type { FileTreeAction, FileTreeNode } from './fileTreeTypes'

interface ActionCopy {
  title: string
  lead: string
  confirm: string
  inputLabel?: string
}

function copyFor(action: FileTreeAction, node: FileTreeNode): ActionCopy {
  const target = node.root ? 'a raiz do projeto' : `“${node.name}”`
  switch (action) {
    case 'create-file':
      return {
        title: 'Criar arquivo',
        lead: `O arquivo será criado dentro de ${target}, sem substituir itens existentes.`,
        confirm: 'Criar arquivo',
        inputLabel: 'Nome do arquivo'
      }
    case 'create-folder':
      return {
        title: 'Criar pasta',
        lead: `A pasta será criada dentro de ${target}, sem substituir itens existentes.`,
        confirm: 'Criar pasta',
        inputLabel: 'Nome da pasta'
      }
    case 'rename':
      return {
        title: 'Renomear item',
        lead: `Escolha um novo nome para ${target}. O item não será movido de pasta.`,
        confirm: 'Renomear',
        inputLabel: 'Novo nome'
      }
    case 'trash':
      return {
        title: 'Mover para a Lixeira',
        lead: `${target} será movido para a Lixeira do sistema, para que possa ser recuperado.`,
        confirm: 'Mover para a Lixeira'
      }
    case 'copy-path':
      return {
        title: 'Copiar caminho',
        lead: `O caminho completo de ${target} será copiado pelo app.`,
        confirm: 'Copiar caminho'
      }
    case 'download-zip':
      return {
        title: 'Baixar pasta como ZIP',
        lead: `${target} será validada e compactada sem seguir links. Metadados internos (.git/.synkora) ficam de fora; depois você escolherá o destino.`,
        confirm: 'Escolher destino'
      }
  }
}

function successMessage(action: FileTreeAction, result: FileActionResult): string {
  switch (action) {
    case 'create-file':
      return 'Arquivo criado.'
    case 'create-folder':
      return 'Pasta criada.'
    case 'rename':
      return 'Item renomeado.'
    case 'trash':
      return 'Item enviado para a Lixeira.'
    case 'copy-path':
      return 'Caminho copiado.'
    case 'download-zip': {
      const detail = result.archive
        ? ` ${result.archive.files.toLocaleString('pt-BR')} arquivo(s), ${result.archive.bytes.toLocaleString('pt-BR')} bytes.`
        : ''
      return `ZIP salvo como ${result.savedName ?? 'arquivo.zip'}.${detail}`
    }
  }
}

interface Props {
  action: FileTreeAction
  node: FileTreeNode
  onRun(action: FileTreeAction, node: FileTreeNode, name: string): Promise<FileActionResult>
  onClose(): void
}

export default function FileActionModal({ action, node, onRun, onClose }: Props): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [name, setName] = useState(action === 'rename' ? node.name : '')
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<FileActionResult | null>(null)
  const copy = useMemo(() => copyFor(action, node), [action, node])
  const complete = result?.ok === true

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (copy.inputLabel) {
        inputRef.current?.focus()
        if (action === 'rename') inputRef.current?.select()
      } else {
        dialogRef.current
          ?.querySelector<HTMLButtonElement>('[data-autofocus="true"]')
          ?.focus()
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [action, copy.inputLabel])

  const submit = async (): Promise<void> => {
    if (pending || complete) return
    if (copy.inputLabel && !name.trim()) {
      setResult({ ok: false, error: 'Digite um nome para continuar.' })
      inputRef.current?.focus()
      return
    }
    setPending(true)
    setResult(null)
    try {
      setResult(await onRun(action, node, name))
    } catch {
      setResult({ ok: false, error: 'Não foi possível concluir esta ação agora.' })
    } finally {
      setPending(false)
    }
  }

  return createPortal(
    <div
      className="file-action-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !pending) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="file-action-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-action-title"
        aria-describedby="file-action-description"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !pending) {
            event.preventDefault()
            onClose()
            return
          }
          if (event.key !== 'Tab') return
          const focusable = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled)'
            ) ?? []
          )
          if (focusable.length === 0) return
          const first = focusable[0]
          const last = focusable.at(-1) as HTMLElement
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <div className="file-action-kicker">ação de arquivo</div>
        <h2 id="file-action-title">{copy.title}</h2>
        <p id="file-action-description">{copy.lead}</p>
        <code className="file-action-path" title={node.path || 'raiz do projeto'}>
          {node.path || 'raiz do projeto'}
        </code>

        {copy.inputLabel && !complete && (
          <label className="file-action-field">
            <span>{copy.inputLabel}</span>
            <input
              ref={inputRef}
              value={name}
              maxLength={255}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              onChange={(event) => {
                setName(event.target.value)
                if (result && !result.ok) setResult(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void submit()
                }
              }}
            />
          </label>
        )}

        <div
          className={`file-action-feedback${result?.ok ? ' success' : result?.error ? ' error' : ''}`}
          role={result?.error ? 'alert' : 'status'}
          aria-live="polite"
        >
          {pending
            ? action === 'download-zip'
              ? 'Validando e compactando…'
              : 'Aplicando…'
            : result?.ok
              ? successMessage(action, result)
              : result?.cancelled
                ? 'A escolha de destino foi cancelada. Nada foi gravado.'
                : result?.error ?? ''}
        </div>

        <div className="file-action-buttons">
          {complete ? (
            <button type="button" className="btn primary" data-autofocus="true" onClick={onClose}>
              Concluir
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn ghost"
                data-autofocus={action === 'trash' ? 'true' : undefined}
                disabled={pending}
                onClick={onClose}
              >
                Cancelar
              </button>
              <button
                type="button"
                className={`btn primary${action === 'trash' ? ' danger' : ''}`}
                data-autofocus={!copy.inputLabel && action !== 'trash' ? 'true' : undefined}
                disabled={pending}
                onClick={() => void submit()}
              >
                {pending ? 'Aguarde…' : copy.confirm}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
