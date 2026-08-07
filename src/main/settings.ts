import { app, safeStorage } from 'electron'
import {
  SettingsStoreCore,
  type SecretProtector,
  type SettingsSecretName,
  type SynkoraPreferences,
  type SynkoraSettings,
  type SynkoraSettingsPatch,
  type SynkoraSettingsView
} from './settingsCore'

export type {
  SettingsSecretName,
  SynkoraPreferences,
  SynkoraSettings,
  SynkoraSettingsPatch,
  SynkoraSettingsView
} from './settingsCore'

function secureStorageReady(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

const electronProtector: SecretProtector = {
  isAvailable: secureStorageReady,
  seal: (value) => safeStorage.encryptString(value).toString('base64'),
  open: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
}

/** Store do main: o renderer só deve receber `view()`, nunca `get()`. */
export class SettingsStore {
  private readonly core = new SettingsStoreCore({
    userDataPath: app.getPath('userData'),
    protector: electronProtector
  })

  get(): SynkoraSettings {
    return this.core.get()
  }

  view(): SynkoraSettingsView {
    return this.core.view()
  }

  update(patch: SynkoraSettingsPatch): SynkoraSettings {
    return this.core.update(patch)
  }

  setSecret(name: SettingsSecretName, value: string): SynkoraSettings {
    return this.core.setSecret(name, value)
  }

  clearSecret(name: SettingsSecretName): SynkoraSettings {
    return this.core.clearSecret(name)
  }
}
