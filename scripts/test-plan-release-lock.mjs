import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  PLAN_RELEASE_LOCK_LIST_MAX,
  activeMasterPlan,
  planReleaseLock
} from '../.tmp/plan-release-lock-test/planReleaseLock.js'

// A TRAVA DE RELEASE DO PLANO MESTRE (ordem do dono, 2026-08-17): "⇪ subir
// versão" RECUSA enquanto o plano do MAPA tiver missão pendente da versão, e a
// recusa NOMEIA as pendentes e receita as DUAS saídas — "ou eu excluo ou eu
// faço".
//
// O módulo é PURO por desenho: recebe a fotografia (plano mestre + carimbos de
// versão das missões + a versão que sobe) e devolve a recusa ou `null`. É o que
// deixa a régua ser PROVADA aqui em vez de conferida no olho dentro do
// `releaseVersionImpl`.
//
// A amarração item→versão é o candidato (i) do handoff, decidido no design:
// `Plan` NÃO ganha versionId. Item VINCULADO herda a versão da missão; item SEM
// missão do plano mestre ativo é trabalho aprovado e ainda não atribuído — ele
// conta contra QUALQUER release.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const item = (over = {}) => ({
  id: over.id ?? 'i1',
  title: over.title ?? 'item',
  status: over.status ?? 'planejada',
  ...over
})

const mission = (over = {}) => ({
  id: over.id ?? 'm1',
  title: over.title ?? 'missão',
  status: over.status ?? 'ativa',
  ...over
})

const master = (items, over = {}) => ({
  title: over.title ?? 'Plano mestre',
  kind: over.kind ?? 'mestre',
  status: over.status ?? 'ativo',
  items
})

const lockOf = (plan, missions = [], over = {}) =>
  planReleaseLock({
    versionId: over.versionId ?? 'v1',
    versionName: over.versionName ?? 'V1.1',
    plan,
    missions
  })

// ————— o que TRAVA —————

test('item SEM missão do plano mestre ativo trava qualquer release', () => {
  const lock = lockOf(master([item({ id: 'a', title: 'Fila de integração' })]))

  assert.ok(lock, 'o item aprovado e não atribuído deixou a versão subir')
  assert.deepEqual(
    lock.pending.map((entry) => entry.id),
    ['a']
  )
  assert.equal(lock.pending[0].title, 'Fila de integração')
  assert.equal(lock.pending[0].status, 'planejada')

  // "qualquer release": ele não tem versão para herdar, então a segunda versão
  // aberta encontra a mesma trava. A saída é vincular (começar) ou excluir.
  assert.ok(lockOf(master([item({ id: 'a' })]), [], { versionId: 'v2', versionName: 'V2.0' }))
})

test('item VINCULADO trava a versão DA MISSÃO — e só ela', () => {
  const items = [
    item({ id: 'a', title: 'Extrator', status: 'em_andamento', missionId: 'm1' }),
    item({ id: 'b', title: 'Painel', status: 'em_andamento', missionId: 'm2' })
  ]
  const missions = [
    mission({ id: 'm1', versionId: 'v1' }),
    mission({ id: 'm2', versionId: 'v2' })
  ]

  const v1 = lockOf(master(items), missions, { versionId: 'v1', versionName: 'V1.1' })
  assert.ok(v1, 'a missão pendente da própria versão não travou')
  assert.deepEqual(
    v1.pending.map((entry) => entry.id),
    ['a']
  )
  assert.equal(v1.pending[0].missionId, 'm1')
  // O trabalho da OUTRA versão não pode aparecer na recusa desta.
  assert.ok(!v1.message.includes('Painel'), 'a recusa citou trabalho de outra versão')

  const v2 = lockOf(master(items), missions, { versionId: 'v2', versionName: 'V2.0' })
  assert.deepEqual(
    v2.pending.map((entry) => entry.id),
    ['b']
  )
})

test('missão ARQUIVADA preserva o estado autoral: se pendia, continua travando', () => {
  // Engavetar a missão não faz o trabalho acontecer — e a saída, por decisão do
  // dono, é EXCLUIR o item do plano.
  const lock = lockOf(
    master([item({ id: 'a', title: 'Fila', status: 'em_andamento', missionId: 'm1' })]),
    [mission({ id: 'm1', status: 'arquivada', versionId: 'v1' })]
  )
  assert.ok(lock)
  assert.equal(lock.pending[0].status, 'em_andamento')

  // Arquivada com o item JÁ descartado não trava (o dono tirou do plano).
  assert.equal(
    lockOf(
      master([item({ id: 'a', status: 'descartada', missionId: 'm1' })]),
      [mission({ id: 'm1', status: 'arquivada', versionId: 'v1' })]
    ),
    null
  )
})

test('vínculo apontando para missão que não existe mais conta como item solto', () => {
  // A autocura (`PlanStore.reconcile`) vai desvincular esse item na próxima
  // leitura do mapa e devolvê-lo a 'planejada'. Até lá ele é trabalho sem casa:
  // deixar passar seria abrir uma janela em que a versão sobe com pendência.
  const lock = lockOf(
    master([item({ id: 'a', title: 'Sumida', status: 'em_andamento', missionId: 'fantasma' })]),
    [mission({ id: 'm1', versionId: 'v1' })]
  )
  assert.ok(lock, 'item apontando para missão inexistente escapou da trava')
  assert.deepEqual(
    lock.pending.map((entry) => entry.id),
    ['a']
  )
})

// ————— o que NÃO trava —————

test('item concluído ou descartado nunca trava', () => {
  // 'concluida' é DERIVADA: quem manda é a missão vinculada.
  assert.equal(
    lockOf(
      master([item({ id: 'a', status: 'em_andamento', missionId: 'm1' })]),
      [mission({ id: 'm1', status: 'concluida', versionId: 'v1' })]
    ),
    null,
    'missão concluída ⇒ item concluído ⇒ não pende'
  )
  assert.equal(lockOf(master([item({ id: 'a', status: 'descartada' })])), null)
  assert.equal(
    lockOf(
      master([
        item({ id: 'a', status: 'descartada' }),
        item({ id: 'b', status: 'em_andamento', missionId: 'm1' })
      ]),
      [mission({ id: 'm1', status: 'concluida', versionId: 'v1' })]
    ),
    null
  )
  // Plano mestre vazio e universo sem plano nenhum: nada a barrar.
  assert.equal(lockOf(master([])), null)
  assert.equal(lockOf(undefined), null)
})

test('missão vinculada SEM versão não é problema desta release', () => {
  // Mesma régua do guard irmão de missões vivas: quem não tem carimbo de versão
  // não conta contra a versão que sobe.
  assert.equal(
    lockOf(
      master([item({ id: 'a', status: 'em_andamento', missionId: 'm1' })]),
      [mission({ id: 'm1' })]
    ),
    null
  )
})

test('plano LIVRE nunca trava, e mestre concluído/arquivado também não', () => {
  const items = [item({ id: 'a', title: 'Fila' })]

  assert.equal(lockOf(master(items, { kind: 'livre' })), null, 'plano livre travou a versão')
  assert.equal(lockOf(master(items, { status: 'concluido' })), null)
  assert.equal(lockOf(master(items, { status: 'arquivado' })), null)
  // E o mestre ATIVO continua travando — senão os três acima passariam por
  // engano num módulo que nunca trava.
  assert.ok(lockOf(master(items)))
})

test('activeMasterPlan escolhe o mestre ATIVO, e só ele', () => {
  const livre = { id: 'l', kind: 'livre', status: 'ativo' }
  const arquivado = { id: 'x', kind: 'mestre', status: 'arquivado' }
  const ativo = { id: 'm', kind: 'mestre', status: 'ativo' }

  assert.equal(activeMasterPlan([livre, arquivado, ativo]).id, 'm')
  assert.equal(activeMasterPlan([livre, arquivado]), undefined)
  assert.equal(activeMasterPlan([]), undefined)
})

// ————— a RECUSA —————

test('a recusa nomeia as pendentes e receita as DUAS saídas', () => {
  const lock = lockOf(
    master(
      [
        item({ id: 'a', title: 'Fila de integração' }),
        item({ id: 'b', title: 'Painel de gestão', status: 'em_andamento', missionId: 'm1' }),
        item({ id: 'c', title: 'Já feito', status: 'em_andamento', missionId: 'm2' })
      ],
      { title: 'Mestre da V1.1' }
    ),
    [
      mission({ id: 'm1', versionId: 'v1' }),
      mission({ id: 'm2', status: 'concluida', versionId: 'v1' })
    ]
  )
  assert.ok(lock)

  // Voz dos guards irmãos do releaseVersionImpl: nomeia a versão, conta, lista.
  assert.match(lock.message, /^a versão V1\.1 ainda tem 2 /u)
  assert.match(lock.message, /"Fila de integração"/u)
  assert.match(lock.message, /"Painel de gestão"/u)
  assert.ok(!lock.message.includes('Já feito'), 'a recusa citou item concluído')
  // O plano é NOMEADO: com dois planos no universo, "o plano" não diz qual.
  assert.match(lock.message, /plano mestre "Mestre da V1\.1"/u)

  // AS DUAS SAÍDAS, nas palavras do dono ("ou eu excluo ou eu faço"): os dois
  // verbos que a linha do item mostra no mapa.
  assert.match(lock.message, /criar missão/u)
  assert.match(lock.message, /excluir/u)
  assert.match(lock.message, /antes de subir$/u)
})

test('a recusa não vira parede de texto: a lista tem teto', () => {
  const items = Array.from({ length: PLAN_RELEASE_LOCK_LIST_MAX + 2 }, (_, index) =>
    item({ id: `i${index}`, title: `Missão ${index}` })
  )
  const lock = lockOf(master(items))

  assert.ok(lock)
  assert.equal(lock.pending.length, PLAN_RELEASE_LOCK_LIST_MAX + 2)
  assert.match(lock.message, /\+2/u, 'o resto da lista sumiu sem dizer quantos são')
  assert.ok(
    !lock.message.includes(`Missão ${PLAN_RELEASE_LOCK_LIST_MAX + 1}`),
    'a lista passou do teto'
  )
  assert.match(lock.message, new RegExp(`Missão ${PLAN_RELEASE_LOCK_LIST_MAX - 1}`, 'u'))
})

// ————— contrato de fonte: a trava tem que estar LIGADA —————

test('CONTRATO: releaseVersionImpl chama a trava depois do guard de backlog', async () => {
  const index = await source('src/main/index.ts')

  assert.match(index, /from '\.\/planReleaseLock'/u, 'o index não importa o módulo da trava')

  const impl = index.slice(index.indexOf('async function releaseVersionImpl'))
  assert.ok(impl, 'releaseVersionImpl sumiu do index')
  // Só o trecho de GUARDS: depois do intent começa o merge de verdade.
  const guards = impl.slice(0, impl.indexOf('writeVersionReleaseIntent'))

  assert.match(guards, /planReleaseLock\(/u, 'a trava do plano não é chamada no release')
  const backlogGuard = guards.indexOf('item(ns) de backlog pendente(s)')
  assert.ok(backlogGuard > 0, 'o guard de backlog sumiu do release')
  assert.ok(
    backlogGuard < guards.indexOf('planReleaseLock('),
    'a trava do plano entrou antes do guard de backlog'
  )
  // A régua mora no módulo: o index não pode reimplementar a leitura do item.
  assert.ok(
    !/effectivePlanItemStatus/u.test(guards),
    'o release passou a derivar estado de item por conta própria'
  )
})

test('CONTRATO: a trava é registrada como suíte e entra num agregado', async () => {
  const pkg = JSON.parse(await source('package.json'))

  assert.ok(pkg.scripts['test:plan-release-lock'], 'a suíte não está registrada')
  assert.match(
    pkg.scripts['test:plan-release-lock'],
    /scripts\/test-plan-release-lock\.mjs/u
  )
  // Nenhuma folha fora de agregado: uma suíte que ninguém roda não protege nada.
  assert.match(pkg.scripts['test:domain'], /test:plan-release-lock/u)
})
