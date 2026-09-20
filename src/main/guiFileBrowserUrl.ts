export const GUI_ARTIFACT_PREVIEW_PREFIX = '/__synkora_preview/'

export function isGuiArtifactPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port &&
      !url.username && !url.password && /^\/__synkora_preview\/[a-f0-9]{48}\/.+/u.test(url.pathname)
  } catch { return false }
}

/** Page text, titles and diagnostics can include the page's own location.
 * Mask only our capability URL shape, without altering normal site output. */
export function sanitizeGuiArtifactPreviewText(value: string): string {
  return value.replace(/\bhttp:\/\/127\.0\.0\.1(?::\d+)?\/__synkora_preview\/[^\s<>"'`]+/giu,
    'http://127.0.0.1/[artifact-preview]')
    .replace(/\/__synkora_preview\/[^\s<>"'`]*/giu, '/[artifact-preview]')
}

/** The loopback capability is main-only and ephemeral. Browser journals must
 * omit both it and the artifact path; ordinary navigation keeps its behavior. */
export function sanitizeGuiArtifactPreviewUrl(value: string | undefined): string | undefined {
  if (!value) return value
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
      url.pathname.startsWith(GUI_ARTIFACT_PREVIEW_PREFIX)) return 'http://127.0.0.1/[artifact-preview]'
  } catch { /* Non-URL journal values keep the pre-existing behavior. */ }
  return value
}
