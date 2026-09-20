/** Expo uses the real Android emulator or a physical phone; never emulates iOS on Windows. */
export interface MobileExpoProject {
  kind: 'expo' | 'react-native' | 'other'
  expoVersion?: string
  sdkVersion?: string
  dependenciesInstalled: boolean
  hasDevClient: boolean
  message: string
}

export interface MobileExpoState {
  project: MobileExpoProject
  status: 'idle' | 'starting' | 'running' | 'stopping' | 'error'
  addresses: string[]
  selectedAddress?: string
  port?: number
  lanUrl?: string
  androidUrl?: string
  qrDataUrl?: string
  error?: string
}

export interface MobileExpoStartRequest {
  /** Must be one of the current non-loopback local IPv4 addresses. */
  address?: string
}
