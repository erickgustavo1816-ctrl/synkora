import { app } from 'electron'
import {
  SettingsStoreCore,
  type SynkoraSettings,
  type SynkoraSettingsPatch,
  type SynkoraSettingsView
} from './settingsCore'

export type {
  SynkoraPreferences,
  SynkoraSettings,
  SynkoraSettingsPatch,
  SynkoraSettingsView
} from './settingsCore'

/**
 * Store do main. Não existe mais assimetria get()/view(): sem cofre de
 * credenciais, tudo em settings.json pode atravessar para o renderer — que é
 * exatamente por que o cofre saiu (limpa F6, 2026-08-17). O par continua
 * declarado porque ~40 call sites o usam e porque o dia em que um segredo
 * voltar, ele volta por aqui.
 */
export class SettingsStore {
  private readonly core = new SettingsStoreCore({
    userDataPath: app.getPath('userData')
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
}
