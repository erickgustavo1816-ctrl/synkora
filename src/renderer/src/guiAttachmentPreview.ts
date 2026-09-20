import type { GuiAttachmentPreviewResult } from '../../preload'

const MAX_PREVIEW_DATA_URL_CHARS = 5_600_000

/** Only bounded PNGs re-encoded by the existing main-process preview bridge. */
export function safePreviewSource(result: GuiAttachmentPreviewResult): string | null {
  if (
    !result.ok ||
    result.mime !== 'image/png' ||
    !Number.isSafeInteger(result.width) ||
    !Number.isSafeInteger(result.height) ||
    result.width <= 0 ||
    result.height <= 0 ||
    result.dataUrl.length > MAX_PREVIEW_DATA_URL_CHARS ||
    !result.dataUrl.startsWith('data:image/png;base64,')
  ) return null
  return result.dataUrl
}
