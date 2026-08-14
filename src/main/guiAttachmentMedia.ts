/** Geração de prévia segura no processo principal.
 *
 * O renderer nunca recebe `file://` nem bytes originais. O main lê um arquivo
 * já autorizado, confirma assinatura/dimensões antes do decoder e devolve um
 * PNG reserializado e limitado.
 */
import { nativeImage } from 'electron'
import {
  GUI_ATTACHMENT_MAX_BYTES,
  GUI_ATTACHMENT_PREVIEW_MAX_BYTES,
  guiSafeImageInfo,
  type GuiAttachmentPreviewPurpose,
  type GuiAttachmentPreviewResult
} from './guiAttachments'

const PREVIEW_BOX: Readonly<Record<GuiAttachmentPreviewPurpose, { width: number; height: number }>> = {
  thumbnail: { width: 360, height: 240 },
  lightbox: { width: 1_920, height: 1_440 }
}
const PREVIEW_BYTE_CAP: Readonly<Record<GuiAttachmentPreviewPurpose, number>> = {
  thumbnail: 512 * 1024,
  lightbox: GUI_ATTACHMENT_PREVIEW_MAX_BYTES
}

function fittedSize(
  width: number,
  height: number,
  box: { width: number; height: number }
): { width: number; height: number } {
  const scale = Math.min(1, box.width / width, box.height / height)
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale))
  }
}

export function renderGuiAttachmentPreview(
  source: Uint8Array,
  expectedMime: string,
  purpose: GuiAttachmentPreviewPurpose
): GuiAttachmentPreviewResult {
  try {
    if (source.length === 0 || source.length > GUI_ATTACHMENT_MAX_BYTES) {
      return { ok: false, error: 'a imagem excede o limite de prévia' }
    }
    const header = guiSafeImageInfo(source)
    if (!header || header.mime !== expectedMime) {
      return { ok: false, error: 'a imagem não tem um formato seguro para prévia' }
    }
    const decoded = nativeImage.createFromBuffer(Buffer.from(source))
    if (decoded.isEmpty()) return { ok: false, error: 'não consegui preparar a prévia da imagem' }
    const decodedSize = decoded.getSize()
    const sameDimensions = decodedSize.width === header.width && decodedSize.height === header.height
    const exifRotation =
      header.mime === 'image/jpeg' &&
      decodedSize.width === header.height &&
      decodedSize.height === header.width
    if (!sameDimensions && !exifRotation) {
      return { ok: false, error: 'as dimensões da imagem são inconsistentes' }
    }

    let target = fittedSize(decodedSize.width, decodedSize.height, PREVIEW_BOX[purpose])
    let output = decoded.resize({ ...target, quality: 'best' }).toPNG()
    const outputCap = PREVIEW_BYTE_CAP[purpose]
    // PNG muito ruidoso pode exceder o teto mesmo após redimensionar. Reduzir
    // preserva uma prévia útil sem empurrar payloads gigantes pelo IPC/DOM.
    while (output.length > outputCap && target.width > 160 && target.height > 120) {
      target = {
        width: Math.max(160, Math.floor(target.width / 2)),
        height: Math.max(120, Math.floor(target.height / 2))
      }
      output = decoded.resize({ ...target, quality: 'best' }).toPNG()
    }
    if (output.length === 0 || output.length > outputCap) {
      return { ok: false, error: 'a prévia da imagem ficou grande demais' }
    }
    return {
      ok: true,
      dataUrl: `data:image/png;base64,${output.toString('base64')}`,
      mime: 'image/png',
      width: target.width,
      height: target.height
    }
  } catch {
    return { ok: false, error: 'a imagem não está mais disponível' }
  }
}
