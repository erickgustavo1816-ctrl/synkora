/** Mobile simulator contract shared by the main process, preload and renderer. */
import type { MobileExpoState, MobileExpoStartRequest } from './mobileExpo'
export type MobilePlatform = 'android' | 'ios'
export type MobileHostPlatform = 'win32' | 'darwin' | 'linux' | 'unsupported'

export type MobileResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; error: string }

export interface MobilePlatformCapability {
  platform: MobilePlatform
  supported: boolean
  available: boolean
  inputAvailable: boolean
  title: string
  reason?: string
  setupSteps: string[]
  docsUrl: string
}

export interface MobileDevice {
  id: string
  platform: MobilePlatform
  name: string
  runtime?: string
  /** Structural CoreSimulator type; display names are user-editable. */
  deviceTypeIdentifier?: string
  state: 'available' | 'running' | 'unavailable'
  /** Only a session in this mission is disclosed here. */
  sessionId?: string
}

export interface MobileSession {
  id: string
  missionId: string
  platform: MobilePlatform
  deviceId: string
  deviceName: string
  deviceTypeIdentifier?: string
  /** Confirmed Android display preset; absent when geometry is unverified. */
  displayProfileId?: string
  state: 'starting' | 'ready' | 'stopping' | 'error'
  inputAvailable: boolean
  /** Owner pointer gestures use a confirmed, session-owned native control channel. */
  liveInputAvailable?: boolean
  /** An agent can only control its own lease; the owner can always interact. */
  controllerPaneId?: string
  /** Main-owned presentation; independent of the native device lifetime. */
  presentation?: MobilePresentation
  error?: string
}

export interface MobileState {
  hostPlatform: MobileHostPlatform
  platforms: MobilePlatformCapability[]
  devices: MobileDevice[]
  sessions: MobileSession[]
}

export interface MobileFrame {
  sessionId: string
  mimeType: 'image/png'
  data: string
  width: number
  height: number
  capturedAt: number
}

export interface MobileStartRequest {
  platform: MobilePlatform
  deviceId: string
  displayProfileId?: string
}

/** Coordinates are normalized to [0,1] in the displayed device orientation. */
export type MobileAction =
  | { type: 'tap'; x: number; y: number }
  | { type: 'swipe'; x: number; y: number; endX: number; endY: number; durationMs?: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: 'home' | 'back' | 'recents' | 'enter' | 'backspace' }
  | { type: 'openUrl'; url: string }
  | { type: 'install'; relativePath: string }
  | { type: 'launch'; appId: string }
  | { type: 'reverse'; port: number }
  | { type: 'displayProfile'; profileId: string }

export type MobileActor = { kind: 'owner' } | { kind: 'agent'; paneId: string }

/** Owner-only pointer events; coordinates use the displayed device orientation. */
export interface MobilePointerInput {
  phase: 'down' | 'move' | 'up' | 'cancel'
  gestureId: string
  x: number
  y: number
}

/** Annex-B access units. A new streamId always requires a fresh decoder. */
export interface MobileVideoPacket {
  missionId: string
  sessionId: string
  streamId: string
  codec: string
  timestampUs: number
  key: boolean
  data: Uint8Array
}

export interface MobilePresentation {
  host: 'dock' | 'detached'
  windowId?: string
  transitioning?: boolean
}
export interface MobileViewLease { consumerId: string }
export interface MobileVideoDelivery extends MobileVideoPacket { consumerId: string }
export interface MobilePhoneDescriptor {
  windowId: string
  missionId: string
  projectId: string
  sessionId: string
  platform: MobilePlatform
  session: MobileSession
}
export type MobilePhoneAction = Extract<MobileAction, { type: 'tap' | 'swipe' | 'text' | 'key' }>
export interface MobilePhoneGeometry { width: number; height: number }
export interface MobilePhoneGeometryResult extends MobilePhoneGeometry { clamped: boolean }

/** Monitor-reported dimensions, never a resolution-only physical-size guess.
 * Divide physicalPixelsPerMm by renderer DPR/visual zoom to obtain CSS px/mm.
 */
export interface MobileMonitorScale {
  physicalPixelsPerMm: number
  source: 'edid-detailed' | 'edid-basic' | 'coregraphics'
  displayId: number
  displayBounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
}

export interface MobileApi {
  monitorScale(): Promise<MobileResult<MobileMonitorScale | null>>
  /** Shared "Tamanho real" calibration: one main-owned record per screen+monitor key, the same in every window. */
  calibrationRead(key: string): Promise<MobileResult<number | null>>
  calibrationWrite(key: string, pixelsPerMm: number | null): Promise<MobileResult<boolean>>
  onCalibrationChanged(callback: () => void): () => void
  expoInspect(missionId: string): Promise<MobileResult<MobileExpoState>>
  expoStart(missionId: string, request?: MobileExpoStartRequest): Promise<MobileResult<MobileExpoState>>
  expoStop(missionId: string): Promise<MobileResult>
  expoOpenAndroid(missionId: string, sessionId: string): Promise<MobileResult>
  expoInstallGo(missionId: string, sessionId: string): Promise<MobileResult>
  inspect(missionId: string): Promise<MobileResult<MobileState>>
  start(missionId: string, request: MobileStartRequest): Promise<MobileResult<MobileSession>>
  stop(missionId: string, sessionId: string): Promise<MobileResult>
  detach(missionId: string, sessionId: string): Promise<MobileResult<MobilePhoneDescriptor>>
  focusDetached(missionId: string, sessionId: string): Promise<MobileResult>
  dock(missionId: string, sessionId: string): Promise<MobileResult>
  acquireView(missionId: string, sessionId: string): Promise<MobileResult<MobileViewLease>>
  releaseView(missionId: string, sessionId: string, consumerId: string): Promise<MobileResult>
  capture(missionId: string, sessionId: string, consumerId: string): Promise<MobileResult<MobileFrame>>
  /** Visual input requires a lease. Main-only setup actions keep their own authority. */
  act(missionId: string, sessionId: string, action: MobileAction, consumerId?: string): Promise<MobileResult>
  pointer(missionId: string, sessionId: string, input: MobilePointerInput, consumerId: string): Promise<MobileResult>
  setVideoVisible(missionId: string, sessionId: string, visible: boolean, consumerId: string): Promise<MobileResult>
  ackVideo(missionId: string, sessionId: string, streamId: string, timestampUs: number, consumerId: string): void
  onChanged(callback: (missionId: string) => void): () => void
  onVideo(callback: (packet: MobileVideoDelivery) => void): () => void
}

/** This is the entire bridge exposed to a detached phone. Identity is main-owned. */
export interface MobilePhoneApi {
  describe(): Promise<MobileResult<MobilePhoneDescriptor>>
  acquireView(): Promise<MobileResult<MobileViewLease>>
  releaseView(consumerId: string): Promise<MobileResult>
  capture(consumerId: string): Promise<MobileResult<MobileFrame>>
  act(action: MobilePhoneAction, consumerId: string): Promise<MobileResult>
  pointer(input: MobilePointerInput, consumerId: string): Promise<MobileResult>
  setVideoVisible(visible: boolean, consumerId: string): Promise<MobileResult>
  ackVideo(streamId: string, timestampUs: number, consumerId: string): void
  monitorScale(): Promise<MobileResult<MobileMonitorScale | null>>
  /** Shared "Tamanho real" calibration: one main-owned record per screen+monitor key, the same in every window. */
  calibrationRead(key: string): Promise<MobileResult<number | null>>
  calibrationWrite(key: string, pixelsPerMm: number | null): Promise<MobileResult<boolean>>
  onCalibrationChanged(callback: () => void): () => void
  resize(geometry: MobilePhoneGeometry): Promise<MobileResult<MobilePhoneGeometryResult>>
  dock(): Promise<MobileResult>
  onChanged(callback: () => void): () => void
  onVideo(callback: (packet: MobileVideoDelivery) => void): () => void
}
