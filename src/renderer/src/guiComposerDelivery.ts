import type { GuiAttachmentDescriptor } from '../../preload'

function sameAttachments(
  left: readonly GuiAttachmentDescriptor[],
  right: readonly GuiAttachmentDescriptor[]
): boolean {
  return (
    left.length === right.length &&
    left.every((attachment, index) => {
      const other = right[index]
      return (
        other !== undefined &&
        attachment.id === other.id &&
        attachment.capability === other.capability &&
        attachment.kind === other.kind &&
        attachment.name === other.name &&
        attachment.mime === other.mime &&
        attachment.size === other.size
      )
    })
  )
}

/** O IPC pode responder depois de o dono continuar digitando. Só a fotografia
 * confirmada sai do composer; falha ou conteúdo novo permanecem intactos. */
export function guiComposerClearPlan(
  accepted: boolean,
  currentDraft: string,
  sentDraft: string,
  currentAttachments: readonly GuiAttachmentDescriptor[],
  sentAttachments: readonly GuiAttachmentDescriptor[]
): { draft: boolean; attachments: boolean } {
  if (!accepted) return { draft: false, attachments: false }
  return {
    draft: currentDraft === sentDraft,
    attachments: sameAttachments(currentAttachments, sentAttachments)
  }
}
