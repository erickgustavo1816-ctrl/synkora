import type { SynkoraApi } from './index'

declare global {
  interface Window {
    synkora: SynkoraApi
  }
}

export {}
