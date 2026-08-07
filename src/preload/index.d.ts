import type { SynkoraApi, SynkoraOverlayApi, SynkoraProgressOverlayApi } from './index'

declare global {
  interface Window {
    synkora: SynkoraApi
    synkoraOverlay: SynkoraOverlayApi
    synkoraProgressOverlay: SynkoraProgressOverlayApi
  }
}

export {}
