/** Capture intent is explicit: owner artifacts do not add a model image. */
import type { BrowserDriverSession } from './browserDriver'
import { captureBrowserShot, type BrowserShotResult, type ShotCapturer } from './browserShot'
import { viewportCaptureRect } from './browserViewportFit'
import { sanitizeGuiArtifactPreviewText, sanitizeGuiArtifactPreviewUrl } from './guiFileBrowserUrl'

export interface BrowserToolShotInput {
  name?: string
  ref?: number
  selector?: string
  format?: 'jpeg' | 'png'
  quality?: number
  maxWidth?: number
  purpose?: 'artifact' | 'vision'
}

export async function captureBrowserToolShot(
  context: {
    session: Pick<BrowserDriverSession, 'rectFor' | 'freshness'>
    capturer: ShotCapturer
    root: string
    missionId: string
    title: string
    url: string
    cli: 'claude' | 'codex' | undefined
    readiness?: { ok: true } | { ok: false; error: string }
  },
  input: BrowserToolShotInput
): Promise<BrowserShotResult> {
  if (context.readiness && !context.readiness.ok) {
    return { ok: false, text: `${context.readiness.error} NADA foi gravado.` }
  }
  let clip: { x: number; y: number; width: number; height: number } | undefined
  let clipLabel: string | undefined
  if (input.ref !== undefined || input.selector) {
    const found = await context.session.rectFor({ ref: input.ref, selector: input.selector })
    if ('error' in found) return { ok: false, text: `não consegui recortar: ${found.error}` }
    clip = {
      x: Math.max(0, Math.round(found.rect.x)),
      y: Math.max(0, Math.round(found.rect.y)),
      width: Math.round(found.rect.width),
      height: Math.round(found.rect.height)
    }
    if (clip.width <= 0 || clip.height <= 0) {
      return {
        ok: false,
        text: `o alvo do recorte tem tamanho ZERO (${clip.width}x${clip.height}) — ele não está pintando nada. Receita: chame browser_probe no mesmo alvo para ver por quê.`
      }
    }
    clipLabel = found.label
  }
  const result = await captureBrowserShot(context.capturer, {
    root: context.root,
    missionId: context.missionId,
    name: input.name,
    title: sanitizeGuiArtifactPreviewText(context.title),
    url: sanitizeGuiArtifactPreviewUrl(context.url),
    format: input.format,
    quality: input.quality,
    maxWidth: input.maxWidth,
    clip: viewportCaptureRect(context.capturer, clip),
    clipLabel: clipLabel ? sanitizeGuiArtifactPreviewText(clipLabel) : undefined,
    inline: input.purpose === 'vision' && context.cli === 'claude',
    freshness: await context.session.freshness()
  })
  if (result.ok && input.purpose === 'vision' && context.cli !== 'claude') {
    result.text += '\nPara analisar a aparência, abra a imagem pelo caminho acima com a ferramenta local de imagem do CLI. O recibo sozinho não confirma a aparência.'
  }
  return result
}
