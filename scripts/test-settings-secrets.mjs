/**
 * SEGREDOS DE SETTINGS — a suíte que prova que eles NÃO EXISTEM MAIS.
 *
 * Até a limpa F6 (2026-08-17) este arquivo cobria um cofre safeStorage com dois
 * segredos: `openrouterKey` (geração de imagens) e `githubToken` (cota do
 * instalador de skills). Os dois subsistemas morreram e o cofre ficou sem
 * consumidor, então ele morreu junto — e o contrato que sobra é o INVERSO:
 * nenhum caminho de credencial atravessa settings, e um documento gravado
 * pelo build F6 continua carregando.
 *
 * R-12 do contrato: "documento gravado pelo build F6 carrega, ignora chaves
 * órfãs e não lança".
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SettingsStoreCore } from '../src/main/settingsCore.ts'

function tempStore(t) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-settings-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** Exatamente o que o build F6 gravava em settings.json. */
const F6_DOCUMENT = {
  codeIntelligenceMode: 'off',
  mcpProtocolMode: 'modern-experimental',
  imageProvider: 'openrouter',
  imageSeatId: 'seat-codex-1',
  openrouterModel: 'google/gemini-2.5-flash-image',
  openrouterKey: 'sk-or-legacy-123456',
  githubToken: 'github_pat_legacy_987654',
  externalServicePreparation: 'on-demand',
  terminalFontSize: 14,
  terminalFontFamily: 'Fira Code',
  chatNotifyFinished: false
}

test('um settings.json do build F6 carrega, descarta as chaves órfãs e não lança', (t) => {
  const root = tempStore(t)
  writeFileSync(join(root, 'settings.json'), JSON.stringify(F6_DOCUMENT))

  const store = new SettingsStoreCore({ userDataPath: root })
  const view = store.view()

  // As preferências que SOBREVIVERAM chegam com o valor gravado — o descarte
  // é seletivo, não um reset.
  assert.equal(view.externalServicePreparation, 'on-demand')
  // a fonte do terminal de antes vira a fonte do app; o tamanho xterm morreu
  assert.equal(view.uiFontFamily, 'Fira Code')
  assert.equal(view.uiScale, 100)
  assert.equal(view.terminalFontSize, undefined)
  assert.equal(view.chatNotifyFinished, false)
  // ...e as que morreram não voltam por nenhuma porta.
  for (const dead of [
    'codeIntelligenceMode',
    'mcpProtocolMode',
    'imageProvider',
    'imageSeatId',
    'openrouterModel',
    'openrouterKey',
    'githubToken',
    'openrouterKeyConfigured',
    'openrouterKeyMasked',
    'githubTokenConfigured',
    'githubTokenMasked'
  ]) {
    assert.equal(dead in view, false, `${dead} não pode existir na view`)
    assert.equal(dead in store.get(), false, `${dead} não pode existir no estado interno`)
  }
  // O segredo legado nunca chega ao renderer, nem por vazamento textual.
  assert.doesNotMatch(JSON.stringify(view), /legacy|123456|987654/)
})

test('a primeira gravação limpa as chaves órfãs do disco sem tocar em outro arquivo', (t) => {
  const root = tempStore(t)
  writeFileSync(join(root, 'settings.json'), JSON.stringify(F6_DOCUMENT))
  // O cofre do dono continua no disco: a limpa PARA DE LER, nunca apaga.
  const vault = join(root, 'settings-secrets.json')
  const vaultBody = JSON.stringify({ version: 1, secrets: { githubToken: 'cipher-abc' } })
  writeFileSync(vault, vaultBody)

  const store = new SettingsStoreCore({ userDataPath: root })
  store.update({ uiScale: 110 })

  const persisted = readFileSync(join(root, 'settings.json'), 'utf8')
  assert.doesNotMatch(persisted, /openrouterKey|githubToken|imageProvider|codeIntelligenceMode/)
  assert.match(persisted, /"uiScale": 110/)
  assert.equal(readFileSync(vault, 'utf8'), vaultBody, 'o cofre antigo fica intacto')
})

/**
 * Os comentários destes arquivos EXPLICAM o cofre que saiu — e devem explicar,
 * senão o próximo leitor reinventa a superfície. A asserção é sobre CÓDIGO, e
 * por isso o comentário é retirado antes de olhar.
 */
const codeOf = (relative) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

test('nenhuma superfície de credencial sobrou no store nem no IPC', () => {
  const core = codeOf('../src/main/settingsCore.ts')
  const store = codeOf('../src/main/settings.ts')
  const ipc = codeOf('../src/main/ipc/settings.ts')

  for (const [name, source] of [['settingsCore', core], ['settings', store], ['ipc/settings', ipc]]) {
    assert.doesNotMatch(source, /safeStorage|SecretProtector|SettingsSecretName/u, `${name} sem cofre`)
    assert.doesNotMatch(source, /\bsetSecret\b|\bclearSecret\b/u, `${name} sem escrita de segredo`)
  }
  // O canal IPC não pode existir nem como casca: invoke sem handler REJEITA.
  assert.doesNotMatch(ipc, /settings:secret:/u)
  // O SynVoice tem cofre PRÓPRIO e não pode ser arrastado junto (R-8).
  const voice = readFileSync(new URL('../src/main/synVoice.ts', import.meta.url), 'utf8')
  assert.match(voice, /synvoice-secret\.json/u)
  assert.match(voice, /safeStorage/u)
})

test('preferências de aviso nascem ligadas e persistem cada escolha desligada', (t) => {
  const root = tempStore(t)
  const store = new SettingsStoreCore({ userDataPath: root })
  assert.deepEqual(
    {
      needsYou: store.view().chatNotifyNeedsYou,
      finished: store.view().chatNotifyFinished,
      failed: store.view().chatNotifyFailed,
      sounds: store.view().chatSoundsEnabled
    },
    { needsYou: true, finished: true, failed: true, sounds: true }
  )

  store.update({
    chatNotifyNeedsYou: false,
    chatNotifyFinished: false,
    chatNotifyFailed: false,
    chatSoundsEnabled: false
  })
  const reloaded = new SettingsStoreCore({ userDataPath: root })
  assert.equal(reloaded.view().chatNotifyNeedsYou, false)
  assert.equal(reloaded.view().chatNotifyFinished, false)
  assert.equal(reloaded.view().chatNotifyFailed, false)
  assert.equal(reloaded.view().chatSoundsEnabled, false)
})

test('o aviso com o Synkora aberto nasce em "fora da tela", persiste a escolha e recusa valor torto', (t) => {
  // 2026-09-22 (ordem do dono): com o app em foco, avisa o que está fora da tela.
  const root = tempStore(t)
  const store = new SettingsStoreCore({ userDataPath: root })
  assert.equal(store.view().desktopNotifyWhileFocused, 'off-screen')

  store.update({ desktopNotifyWhileFocused: 'never' })
  assert.equal(new SettingsStoreCore({ userDataPath: root }).view().desktopNotifyWhileFocused, 'never')
  store.update({ desktopNotifyWhileFocused: 'always' })
  assert.equal(new SettingsStoreCore({ userDataPath: root }).view().desktopNotifyWhileFocused, 'always')

  store.update({ desktopNotifyWhileFocused: 'talvez' })
  assert.equal(store.view().desktopNotifyWhileFocused, 'off-screen')
})

test('a escrita do chat nasce no padrão, persiste a escolha e prende às faixas', (t) => {
  // 2026-09-21: velocidade/atraso/fade são do dono (Ajustes › Aparência ›
  // Escrita do chat); campo torto ou fora da faixa nunca chega ao renderer.
  const root = tempStore(t)
  const store = new SettingsStoreCore({ userDataPath: root })
  assert.deepEqual(
    {
      wps: store.view().chatWritingWordsPerSecond,
      lag: store.view().chatWritingMaxLagMs,
      fade: store.view().chatWritingFade
    },
    { wps: 20, lag: 1000, fade: true }
  )

  store.update({ chatWritingWordsPerSecond: 35, chatWritingMaxLagMs: 1500, chatWritingFade: false })
  const reloaded = new SettingsStoreCore({ userDataPath: root })
  assert.equal(reloaded.view().chatWritingWordsPerSecond, 35)
  assert.equal(reloaded.view().chatWritingMaxLagMs, 1500)
  assert.equal(reloaded.view().chatWritingFade, false)

  const clamped = tempStore(t)
  writeFileSync(
    join(clamped, 'settings.json'),
    JSON.stringify({ chatWritingWordsPerSecond: 999, chatWritingMaxLagMs: -5, chatWritingFade: 'sim' })
  )
  const view = new SettingsStoreCore({ userDataPath: clamped }).view()
  assert.equal(view.chatWritingWordsPerSecond, 60)
  assert.equal(view.chatWritingMaxLagMs, 300)
  assert.equal(view.chatWritingFade, true)
})

test('documento corrompido ou de tipo errado cai nos defaults sem lançar', (t) => {
  const root = tempStore(t)
  writeFileSync(join(root, 'settings.json'), '{ isto não é json')
  assert.doesNotThrow(() => new SettingsStoreCore({ userDataPath: root }))
  assert.equal(new SettingsStoreCore({ userDataPath: root }).view().uiScale, 100)

  const other = tempStore(t)
  writeFileSync(join(other, 'settings.json'), JSON.stringify(['array', 'no', 'lugar', 'errado']))
  assert.doesNotThrow(() => new SettingsStoreCore({ userDataPath: other }))
  assert.equal(new SettingsStoreCore({ userDataPath: other }).view().chatSoundsEnabled, true)
})

test('o interruptor do skill_pull nasce LIGADO e só um `false` explícito o desliga', (t) => {
  const root = tempStore(t)
  // ADR-0010 (2026-09-08): "o harness que o próprio modelo cria é melhor" — o
  // padrão é o agente podendo puxar; o interruptor existe para o dono cortar.
  assert.equal(new SettingsStoreCore({ userDataPath: root }).view().skillsAgentPull, true)

  new SettingsStoreCore({ userDataPath: root }).update({ skillsAgentPull: false })
  assert.equal(new SettingsStoreCore({ userDataPath: root }).view().skillsAgentPull, false)

  // documento de ANTES do campo, e valor torto, caem no ligado (nunca no meio)
  const legado = tempStore(t)
  writeFileSync(join(legado, 'settings.json'), JSON.stringify({ terminalFontSize: 15 }))
  assert.equal(new SettingsStoreCore({ userDataPath: legado }).view().skillsAgentPull, true)
  const torto = tempStore(t)
  writeFileSync(join(torto, 'settings.json'), JSON.stringify({ skillsAgentPull: 'talvez' }))
  assert.equal(new SettingsStoreCore({ userDataPath: torto }).view().skillsAgentPull, true)
})

test('acessibilidade: faixas e passos na leitura, e o padrão de quem nunca mexeu', (t) => {
  const root = tempStore(t)
  const view = new SettingsStoreCore({ userDataPath: root }).view()
  assert.deepEqual(
    [view.uiScale, view.uiFontFamily, view.uiReduceMotion, view.chatFontSize, view.chatLineHeight],
    [100, 'Cascadia Code', false, 12.5, 1.55]
  )
  writeFileSync(
    join(root, 'settings.json'),
    JSON.stringify({ uiScale: 400, uiReduceMotion: 'sim', chatFontSize: 13.3, chatLineHeight: 0.4 })
  )
  const clamped = new SettingsStoreCore({ userDataPath: root }).view()
  assert.equal(clamped.uiScale, 150, 'teto da escala')
  assert.equal(clamped.uiReduceMotion, false, 'só `true` liga o movimento reduzido')
  assert.equal(clamped.chatFontSize, 13.5, 'fonte do chat assenta em meio ponto')
  assert.equal(clamped.chatLineHeight, 1.2, 'piso da altura da linha')
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ uiScale: 60, chatFontSize: 99 }))
  const low = new SettingsStoreCore({ userDataPath: root }).view()
  assert.equal(low.uiScale, 80)
  assert.equal(low.chatFontSize, 20)
})
