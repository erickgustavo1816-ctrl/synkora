import type { GuiAttachmentDescriptor } from '../../../preload'

interface GuiAttachmentChipsProps {
  attachments: readonly GuiAttachmentDescriptor[]
  onRemove?: (id: string) => void
  className?: string
}

function attachmentLabel(kind: GuiAttachmentDescriptor['kind']): string {
  if (kind === 'image') return 'imagem'
  if (kind === 'folder') return 'pasta'
  return 'arquivo'
}

function attachmentGlyph(kind: GuiAttachmentDescriptor['kind']): string {
  if (kind === 'image') return '▧'
  if (kind === 'folder') return '▱'
  return '⌁'
}

function formatSize(size: number | null): string | null {
  if (size === null) return null
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
}

/** Chips deliberadamente sem `file://`: o renderer nunca tenta pré-visualizar
 * um path persistido. Ícone/tipo são suficientes no composer; o main volta a
 * validar o alvo físico quando o envio acontece. */
export default function GuiAttachmentChips({
  attachments,
  onRemove,
  className = ''
}: GuiAttachmentChipsProps): React.JSX.Element | null {
  if (attachments.length === 0) return null
  return (
    <ul className={`gui-attachment-chips ${className}`.trim()} aria-label="Anexos">
      {attachments.map((attachment) => {
        const kind = attachmentLabel(attachment.kind)
        const size = formatSize(attachment.size)
        return (
          <li key={attachment.id} className="gui-attachment-chip" data-kind={attachment.kind}>
            <span className="gui-attachment-kind" aria-hidden="true">
              {attachmentGlyph(attachment.kind)}
            </span>
            <span className="gui-attachment-copy">
              <span className="gui-attachment-name">{attachment.name}</span>
              <span className="gui-attachment-meta">
                {kind}
                {size ? ` · ${size}` : ''}
              </span>
            </span>
            {onRemove && (
              <button
                className="gui-attachment-remove"
                type="button"
                aria-label={`Remover anexo ${attachment.name}`}
                onClick={() => onRemove(attachment.id)}
              >
                ×
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
