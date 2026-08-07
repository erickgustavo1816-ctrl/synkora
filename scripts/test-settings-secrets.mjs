import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SettingsStoreCore } from '../src/main/settingsCore.ts'

const protector = {
  isAvailable: () => true,
  seal: (value) => Buffer.from(`protected:${value}`, 'utf8').toString('base64'),
  open: (value) => {
    const decoded = Buffer.from(value, 'base64').toString('utf8')
    if (!decoded.startsWith('protected:')) throw new Error('invalid ciphertext')
    return decoded.slice('protected:'.length)
  }
}

function tempStore(t) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-settings-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('migra segredos legados, limpa settings.json e só expõe flags/máscaras', (t) => {
  const root = tempStore(t)
  const openrouterKey = 'sk-or-legacy-123456'
  const githubToken = 'github_pat_legacy_987654'
  writeFileSync(join(root, 'settings.json'), JSON.stringify({
    imageProvider: 'openrouter',
    openrouterKey,
    githubToken,
    terminalFontSize: 14
  }))

  const store = new SettingsStoreCore({ userDataPath: root, protector })
  const internal = store.get()
  const view = store.view()
  const persistedSettings = readFileSync(join(root, 'settings.json'), 'utf8')
  const persistedVault = readFileSync(join(root, 'settings-secrets.json'), 'utf8')

  assert.equal(internal.openrouterKey, openrouterKey)
  assert.equal(internal.githubToken, githubToken)
  assert.equal(view.openrouterKeyConfigured, true)
  assert.equal(view.openrouterKeyMasked, '••••••••')
  assert.equal(view.githubTokenConfigured, true)
  assert.equal(view.githubTokenMasked, '••••••••')
  assert.equal('openrouterKey' in view, false)
  assert.equal('githubToken' in view, false)
  assert.doesNotMatch(JSON.stringify(view), /legacy|123456|987654/)
  assert.doesNotMatch(persistedSettings, /openrouterKey|githubToken|legacy|123456|987654/)
  assert.doesNotMatch(persistedVault, /legacy|123456|987654/)
})

test('troca e remove credenciais sem aceitar segredo pelo patch comum', (t) => {
  const root = tempStore(t)
  const store = new SettingsStoreCore({ userDataPath: root, protector })

  store.setSecret('openrouterKey', 'sk-or-current-abcd')
  store.setSecret('githubToken', 'github_pat_current_wxyz')
  store.update({ openrouterKey: 'must-not-enter' })

  assert.equal(store.get().openrouterKey, 'sk-or-current-abcd')
  assert.equal(store.view().openrouterKeyMasked, '••••••••')

  store.clearSecret('githubToken')
  const reloaded = new SettingsStoreCore({ userDataPath: root, protector })
  assert.equal(reloaded.get().openrouterKey, 'sk-or-current-abcd')
  assert.equal(reloaded.get().githubToken, undefined)
  assert.equal(reloaded.view().githubTokenConfigured, false)
  assert.equal('githubTokenMasked' in reloaded.view(), false)
})

test('cofre indisponível não devolve o legado ao renderer nem aceita segredo novo', (t) => {
  const root = tempStore(t)
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ githubToken: 'legacy-offline-1234' }))
  const unavailable = {
    isAvailable: () => false,
    seal: () => { throw new Error('unavailable') },
    open: () => { throw new Error('unavailable') }
  }
  const store = new SettingsStoreCore({ userDataPath: root, protector: unavailable })

  assert.equal(store.get().githubToken, 'legacy-offline-1234')
  assert.equal(store.view().githubTokenConfigured, true)
  assert.equal(store.view().githubTokenMasked, '••••••••')
  assert.equal('githubToken' in store.view(), false)
  assert.throws(() => store.setSecret('githubToken', 'new-token'), /cofre seguro/)
})
