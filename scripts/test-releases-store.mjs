// R27F2 ONDA 2 — O RELEASE VIRA ENTIDADE NO DADO (2026-08-22).
//
// Até aqui o release era (missão tipo release) + (version.status 'lancada') +
// mensagens efêmeras de hub: nenhum lugar respondia "o que subiu, quando, com
// push ok?, com caixa?". A entidade nasce no SUCESSO do releaseVersionImpl —
// falha não cria entidade (recusa é conversa) — e alimenta o bloco do release
// na aba Versões (Onda 3) e a auditoria.
//
// Como rodar:
//   node --experimental-strip-types --test scripts/test-releases-store.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { ReleasesStore } from '../src/main/releasesStore.ts'

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('a entidade persiste e volta do disco — uma linha por subida', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synkora-releases-'))
  const file = join(dir, 'releases.json')
  try {
    const store = new ReleasesStore(file)
    const record = store.append({
      projectId: 'p1',
      versionId: 'v1',
      versionName: 'V1.0.5',
      missionId: 'm1',
      actor: 'agent-release',
      mergeDetail: 'ff',
      push: { attempted: true, ok: true },
      bump: { version: '1.0.5', committed: true },
      publishRequired: true,
      outcome: 'versão V1.0.5 subiu para a main (ff) — é a versão atual'
    })
    assert.ok(record.id, 'a entidade ganha id')
    assert.ok(record.at, 'a entidade carimba o instante')

    // Persistência de verdade: outra instância lê o MESMO arquivo.
    const reread = new ReleasesStore(file)
    const list = reread.list('p1')
    assert.equal(list.length, 1)
    assert.equal(list[0].versionName, 'V1.0.5')
    assert.equal(list[0].push.ok, true)
    assert.equal(reread.listForVersion('v1').length, 1)
    assert.equal(reread.listForVersion('v-nao-existe').length, 0)

    // Ordem: a mais RECENTE primeiro (o painel lê o topo).
    store.append({
      projectId: 'p1',
      versionId: 'v2',
      versionName: 'V1.0.6',
      actor: 'agent-release',
      mergeDetail: 'ff',
      push: { attempted: false },
      publishRequired: false,
      outcome: 'subiu'
    })
    assert.equal(new ReleasesStore(file).list('p1')[0].versionName, 'V1.0.6')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lixo no disco degrada para vazio — nunca um app que não abre', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synkora-releases-'))
  const file = join(dir, 'releases.json')
  try {
    writeFileSync(file, 'nem json', 'utf8')
    assert.deepEqual(new ReleasesStore(file).list('p1'), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('o motor ESCREVE a entidade no sucesso — com push, bump e caixa de verdade', async () => {
  const index = await source('src/main/index.ts')
  const impl = index.slice(index.indexOf('async function releaseVersionImpl'))
  const implBody = impl.slice(0, impl.indexOf('function sweepProjectFiles'))
  assert.match(implBody, /releases\.append\(/u, 'o sucesso do release grava a entidade')
  const appendAt = implBody.indexOf('releases.append(')
  const releasedAt = implBody.indexOf('markVersionReleased')
  assert.ok(
    releasedAt >= 0 && appendAt > releasedAt,
    'a entidade nasce DEPOIS do fato provado (lancada), nunca antes'
  )
  const appendBlock = implBody.slice(appendAt, appendAt + 900)
  assert.match(appendBlock, /mergeDetail/u, 'a entidade carrega o detalhe do merge')
  assert.match(appendBlock, /publishRequired/u, 'a entidade sabe se o produto publica caixa')
})
