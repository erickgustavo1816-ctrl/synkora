import type { MobileFrame, MobileResult } from '../../shared/mobileSimulator'

export const MOBILE_CAPTURE_INTERVAL_MS = 900

interface CaptureOptions {
  capture: () => Promise<MobileResult<MobileFrame>>
  onFrame: (frame: MobileFrame) => void
  onError: (error: string) => void
  isVideoPlaying: () => boolean
}
interface CaptureScheduler {
  schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  cancel: (timer: ReturnType<typeof setTimeout>) => void
}

/** Serial fallback: no timer while a capture is pending and no delivery after cleanup. */
export function startMobileCapture(options: CaptureOptions, scheduler: CaptureScheduler = {
  schedule: (callback, delay) => setTimeout(callback, delay), cancel: timer => clearTimeout(timer)
}): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async (): Promise<void> => {
    if (stopped) return
    if (!options.isVideoPlaying()) {
      try {
        const result = await options.capture()
        if (stopped || options.isVideoPlaying()) return
        if (result.ok) options.onFrame(result.value)
        else options.onError(result.error)
      } catch {
        if (!stopped) options.onError('Não foi possível atualizar a tela. Tente capturar novamente.')
      } finally {
        if (!stopped) timer = scheduler.schedule(() => { void tick() }, MOBILE_CAPTURE_INTERVAL_MS)
      }
    } else timer = scheduler.schedule(() => { void tick() }, MOBILE_CAPTURE_INTERVAL_MS)
  }
  void tick()
  return () => { stopped = true; if (timer !== undefined) scheduler.cancel(timer) }
}
