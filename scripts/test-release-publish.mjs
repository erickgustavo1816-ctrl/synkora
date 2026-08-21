// R29 (2026-08-21) — O RELEASE ENTREGA A CAIXA: o módulo puro da publicação.
//
// O caso que cobrou a rodada: a V1.0.4 do Painel subiu pelo release (merge +
// push) e o "verificar atualização" continuou quebrado — o updater lê a
// RELEASE PUBLICADA do GitHub, não a main. Aqui se prova a sonda (sinal
// estrutural: scripts.release), o bump cirúrgico e as frases da fotografia e
// do desfecho — tudo strings, sem disco, sem app.
//
// Como rodar:
//   node --experimental-strip-types --test scripts/test-release-publish.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bumpLockVersion,
  bumpManifestVersion,
  probeManifestPublish,
  releaseOutcomeFragments,
  releasePublishStatusLine,
  semverFromVersionName
} from '../src/main/releasePublish.ts'

// ————— o nome da versão vira número — por régua ESTREITA —————

test('semver do nome: V1.0.4/v1.0.4/1.0.4 passam; partes ausentes completam; o resto recusa', () => {
  assert.equal(semverFromVersionName('V1.0.4'), '1.0.4')
  assert.equal(semverFromVersionName('v1.0.4'), '1.0.4')
  assert.equal(semverFromVersionName('1.0.4'), '1.0.4')
  assert.equal(semverFromVersionName(' V2.1 '), '2.1.0')
  assert.equal(semverFromVersionName('V3'), '3.0.0')
  assert.equal(semverFromVersionName('V1.0 hotfix'), null, 'sufixo = julgamento, nunca bump mecânico')
  assert.equal(semverFromVersionName('Sprint 3'), null)
  assert.equal(semverFromVersionName(''), null)
})

// ————— a sonda: sinal estrutural, nunca heurística —————

test('a sonda lê scripts.release e o version; JSON ilegível responde null', () => {
  const withBox = probeManifestPublish(
    JSON.stringify({ version: '1.0.3', scripts: { release: 'node scripts/publish-release.mjs' } })
  )
  assert.deepEqual(withBox, { hasReleaseScript: true, version: '1.0.3' })

  const codeOnly = probeManifestPublish(JSON.stringify({ version: '0.2.0', scripts: { dev: 'vite' } }))
  assert.deepEqual(codeOnly, { hasReleaseScript: false, version: '0.2.0' })

  const bare = probeManifestPublish('{}')
  assert.deepEqual(bare, { hasReleaseScript: false, version: null })
  assert.equal(probeManifestPublish('nem json'), null)
  assert.equal(probeManifestPublish('[1,2]'), null, 'array não é manifesto')
})

// ————— o bump cirúrgico: a formatação do dono fica intacta —————

test('o bump troca SÓ o primeiro "version" e preserva o resto do texto', () => {
  const manifest = '{\n  "name": "app",\n  "version": "1.0.3",\n  "scripts": {\n    "dev": "vite"\n  }\n}\n'
  const bumped = bumpManifestVersion(manifest, '1.0.4')
  assert.equal(bumped, manifest.replace('"version": "1.0.3"', '"version": "1.0.4"'))
  assert.equal(bumpManifestVersion('{\n  "name": "sem-version"\n}\n', '1.0.4'), null)
})

test('o lock acompanha: os DOIS campos de versão, no formato do npm', () => {
  const lock = JSON.stringify(
    {
      name: 'app',
      version: '1.0.3',
      lockfileVersion: 3,
      packages: { '': { name: 'app', version: '1.0.3' }, 'node_modules/x': { version: '9.9.9' } }
    },
    null,
    2
  )
  const bumped = bumpLockVersion(lock, '1.0.4')
  const parsed = JSON.parse(bumped)
  assert.equal(parsed.version, '1.0.4')
  assert.equal(parsed.packages[''].version, '1.0.4')
  assert.equal(parsed.packages['node_modules/x'].version, '9.9.9', 'dependência não é tocada')
  assert.ok(bumped.endsWith('\n'), 'o npm termina o lock com newline')
  assert.equal(bumpLockVersion('quebrado', '1.0.4'), null)
})

// ————— as frases: a fotografia e o desfecho —————

test('a linha PUBLICAÇÃO: caixa com versões, caixa em dia, nome opaco, só código', () => {
  const ahead = releasePublishStatusLine({
    hasReleaseScript: true,
    manifestVersion: '1.0.3',
    expectedVersion: '1.0.4'
  })
  assert.match(ahead, /1\.0\.3 → 1\.0\.4/u)
  assert.match(ahead, /npm run release/u)
  assert.match(ahead, /PASTA DO PROJETO/u)

  assert.match(
    releasePublishStatusLine({ hasReleaseScript: true, manifestVersion: '1.0.4', expectedVersion: '1.0.4' }),
    /em dia/u
  )
  assert.match(
    releasePublishStatusLine({ hasReleaseScript: true, manifestVersion: '1.0.4' }),
    /não vira número/u,
    'nome que não parseia manda conferir na mão'
  )
  const codeOnly = releasePublishStatusLine({ hasReleaseScript: false })
  assert.match(codeOnly, /sem pipeline declarado/u)
  assert.match(codeOnly, /só código/u)
})

test('os fragmentos do desfecho: o ato do harness primeiro, a receita depois', () => {
  const full = releaseOutcomeFragments({
    hasReleaseScript: true,
    bump: { kind: 'committed', version: '1.0.4' }
  })
  assert.equal(full.length, 2)
  assert.match(full[0], /alinhado em 1\.0\.4/u)
  assert.match(full[0], /incluído no push/u)
  assert.match(full[1], /npm run release/u)
  assert.match(full[1], /PASTA DO PROJETO/u)
  assert.match(full[1], /só termina com a caixa publicada/u)

  const failed = releaseOutcomeFragments({
    hasReleaseScript: true,
    bump: { kind: 'commit-failed', version: '1.0.4', error: 'index.lock' }
  })
  assert.match(failed[0], /ATENÇÃO/u)
  assert.match(failed[0], /index\.lock/u)

  const opaqueName = releaseOutcomeFragments({
    hasReleaseScript: true,
    bump: { kind: 'name-not-semver', name: 'Sprint 3' }
  })
  assert.match(opaqueName[0], /Sprint 3/u)

  assert.deepEqual(
    releaseOutcomeFragments({ hasReleaseScript: false, bump: { kind: 'aligned', version: '1.0.4' } }),
    [],
    'produto só-código e version em dia: desfecho limpo, sem ruído'
  )
  assert.deepEqual(
    releaseOutcomeFragments({ hasReleaseScript: false, bump: { kind: 'name-not-semver', name: 'X' } }),
    [],
    'sem pipeline, nome opaco não vira sermão'
  )
  const bumpOnly = releaseOutcomeFragments({
    hasReleaseScript: false,
    bump: { kind: 'committed', version: '2.0.0' }
  })
  assert.equal(bumpOnly.length, 1, 'o bump é contado mesmo sem caixa — o commit existe e viaja no push')
})
