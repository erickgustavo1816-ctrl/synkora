import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  PLAN_ITEM_DETACHED_NOTE,
  PLAN_MASTER_TAKEN_ERROR,
  PLAN_STALE_ERROR,
  PlanStore,
  effectivePlanItemStatus,
  planDependenciesOfMission,
  planView
} from '../.tmp/plans-test/plans.js'
import {
  PLAN_ITEM_MAX_COUNT,
  isPlanDraft,
  normalizePlanDraft,
  planDocPathProblem,
  planDraftKey
} from '../.tmp/plans-test/planDraft.js'

function storeIn(t, label) {
  const root = mkdtempSync(join(tmpdir(), `synkora-plans-${label}-`))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'plans.json')
  return { file, store: new PlanStore(file) }
}

/** Rascunho mínimo já normalizado (o caminho que a aprovação usa). */
function draftOf(items, extra = {}) {
  const normalized = normalizePlanDraft({ title: 'Plano de teste', items, ...extra })
  assert.equal(normalized.ok, true, normalized.error)
  return normalized.draft
}

// ————— porteira do rascunho —————

test('a porteira completa toda key e recusa dependência que não é anterior', () => {
  const ok = normalizePlanDraft({
    title: '  Versão 2  ',
    description: 'o recorte',
    items: [
      { title: 'Fundação da fila', objective: 'subir a fila' },
      {
        title: 'Tela da fila',
        objective: 'mostrar a fila',
        dependsOn: ['fundacao-da-fila'],
        doneCriteria: ['a fila aparece na tela', '   '],
        tier: 'medio',
        docPath: 'plano/002-tela.md'
      }
    ]
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.draft.title, 'Versão 2')
  assert.equal(ok.draft.kind, 'livre')
  assert.deepEqual(
    ok.draft.items.map((item) => item.key),
    ['fundacao-da-fila', 'tela-da-fila']
  )
  // acento vira ascii, vazio é descartado
  assert.deepEqual(ok.draft.items[1].dependsOn, ['fundacao-da-fila'])
  assert.deepEqual(ok.draft.items[1].doneCriteria, ['a fila aparece na tela'])

  const forward = normalizePlanDraft({
    title: 'Plano',
    items: [
      { title: 'A', objective: 'a', dependsOn: ['b'] },
      { title: 'B', objective: 'b' }
    ]
  })
  assert.equal(forward.ok, false)
  assert.match(forward.error, /não é uma missão anterior/)
})

test('key duplicada ganha sufixo em vez de sobrescrever a irmã', () => {
  const draft = draftOf([
    { title: 'Ajustes', objective: 'um' },
    { title: 'Ajustes', objective: 'dois' }
  ])
  assert.deepEqual(
    draft.items.map((item) => item.key),
    ['ajustes', 'ajustes-2']
  )
})

test('planDraftKey nunca devolve vazio e planDocPathProblem barra travessia', () => {
  assert.equal(planDraftKey('!!!', 3), 'item-4')
  assert.equal(planDocPathProblem('plano/003-fila.md'), null)
  assert.match(planDocPathProblem('../fora.md'), /inválido/)
  assert.match(planDocPathProblem('/etc/passwd'), /relativo/)
  assert.match(planDocPathProblem('C:/segredo.md'), /relativo/)
  assert.match(planDocPathProblem('plano\\003.md'), /barra invertida/)
})

test('o rascunho recusa lista vazia, item sem objetivo e excesso de missões', () => {
  assert.match(normalizePlanDraft({ title: 'x', items: [] }).error, /pelo menos uma missão/)
  assert.match(
    normalizePlanDraft({ title: 'x', items: [{ title: 'A' }] }).error,
    /está sem objetivo/
  )
  const many = Array.from({ length: PLAN_ITEM_MAX_COUNT + 1 }, (_, index) => ({
    title: `M${index}`,
    objective: 'o'
  }))
  assert.match(normalizePlanDraft({ title: 'x', items: many }).error, /missões demais/)
  assert.match(normalizePlanDraft({ title: 'x', kind: 'outro', items: [] }).error, /natureza/)
})

test('isPlanDraft aceita só a forma total e rejeita dependência para frente', () => {
  const draft = draftOf([
    { title: 'A', objective: 'a' },
    { title: 'B', objective: 'b', dependsOn: ['a'] }
  ])
  assert.equal(isPlanDraft(draft), true)
  assert.equal(isPlanDraft({ ...draft, items: [] }), false)
  assert.equal(
    isPlanDraft({
      ...draft,
      items: [
        { ...draft.items[0], dependsOn: ['b'] },
        draft.items[1]
      ]
    }),
    false
  )
  assert.equal(isPlanDraft({ ...draft, items: [{ key: 'a', title: 'A' }] }), false)
  assert.equal(isPlanDraft(null), false)
})

// ————— store —————

test('a aprovação materializa keys em ids e persiste o plano ativo', (t) => {
  const { file, store } = storeIn(t, 'create')
  const created = store.create(
    'p1',
    draftOf([
      { title: 'Fundação', objective: 'base' },
      { title: 'Tela', objective: 'ui', dependsOn: ['fundacao'] }
    ]),
    { paneId: 'gui-dev-abcd1234', proposedAt: '2026-08-15T00:00:00.000Z' }
  )
  assert.equal(created.ok, true)
  const plan = created.plan
  assert.equal(plan.status, 'ativo')
  assert.ok(plan.approvedAt)
  assert.equal(plan.items[0].status, 'planejada')
  // a key virou o id real do item anterior
  assert.deepEqual(plan.items[1].dependsOn, [plan.items[0].id])
  assert.deepEqual(
    plan.items.map((item) => item.order),
    [0, 1]
  )

  const persisted = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].id, plan.id)
  const reopened = new PlanStore(file).get(plan.id)
  assert.equal(reopened?.title, 'Plano de teste')
})

test('só existe UM plano mestre ativo por universo, e arquivar libera a vaga', (t) => {
  const { store } = storeIn(t, 'mestre')
  const first = store.create('p1', draftOf([{ title: 'A', objective: 'a' }], { kind: 'mestre' }), {
    manual: true
  })
  assert.equal(first.ok, true)
  const second = store.create('p1', draftOf([{ title: 'B', objective: 'b' }], { kind: 'mestre' }), {
    manual: true
  })
  assert.equal(second.ok, false)
  assert.equal(second.error, PLAN_MASTER_TAKEN_ERROR)
  // outro universo não é bloqueado pelo mestre deste
  assert.equal(
    store.create('p2', draftOf([{ title: 'C', objective: 'c' }], { kind: 'mestre' }), {
      manual: true
    }).ok,
    true
  )
  store.archive(first.plan.id)
  assert.equal(
    store.create('p1', draftOf([{ title: 'D', objective: 'd' }], { kind: 'mestre' }), {
      manual: true
    }).ok,
    true
  )
})

test('list ordena mestre primeiro e depois por order', (t) => {
  const { store } = storeIn(t, 'order')
  const livre1 = store.create('p1', draftOf([{ title: 'A', objective: 'a' }]), { manual: true })
  const livre2 = store.create('p1', draftOf([{ title: 'B', objective: 'b' }]), { manual: true })
  const mestre = store.create(
    'p1',
    draftOf([{ title: 'C', objective: 'c' }], { kind: 'mestre' }),
    { manual: true }
  )
  assert.deepEqual(
    store.list('p1').map((plan) => plan.id),
    [mestre.plan.id, livre1.plan.id, livre2.plan.id]
  )
})

test('CAS recusa gravar por cima de uma fotografia que o chamador não viu', (t) => {
  const { store } = storeIn(t, 'cas')
  const created = store.create('p1', draftOf([{ title: 'A', objective: 'a' }]), { manual: true })
  const stale = created.plan.updatedAt
  const first = store.update(created.plan.id, { title: 'Nome novo' }, stale)
  assert.equal(first.ok, true)
  const second = store.update(created.plan.id, { title: 'Nome mais novo' }, stale)
  assert.equal(second.ok, false)
  assert.equal(second.error, PLAN_STALE_ERROR)
  assert.equal(store.get(created.plan.id)?.title, 'Nome novo')

  assert.equal(store.archive(created.plan.id, stale).ok, false)
  assert.equal(store.remove(created.plan.id, stale).ok, false)
  assert.equal(store.linkMission(created.plan.id, created.plan.items[0].id, 'm1', stale).ok, false)
  // sem fotografia (caminho interno do harness) o mutador passa
  assert.equal(store.archive(created.plan.id).ok, true)
})

test('o agente nunca escreve concluida nem exclui item que já virou missão', (t) => {
  const { store } = storeIn(t, 'guards')
  const created = store.create(
    'p1',
    draftOf([
      { title: 'A', objective: 'a' },
      { title: 'B', objective: 'b' }
    ]),
    { manual: true }
  )
  const [a, b] = created.plan.items

  const concluded = store.update(created.plan.id, {
    items: [{ id: a.id, status: 'concluida' }]
  })
  assert.equal(concluded.ok, false)
  assert.match(concluded.error, /vem da missão vinculada/)

  const linked = store.linkMission(created.plan.id, a.id, 'mission-1')
  assert.equal(linked.ok, true)
  assert.equal(linked.plan.items[0].missionId, 'mission-1')
  assert.equal(linked.plan.items[0].status, 'em_andamento')

  const removal = store.update(created.plan.id, { removeItemIds: [a.id] })
  assert.equal(removal.ok, false)
  assert.match(removal.error, /marque como descartada/)

  // item ainda livre sai, e a aresta que apontava para ele some junto
  const withEdge = store.update(created.plan.id, {
    items: [{ id: a.id, dependsOn: [b.id] }]
  })
  assert.equal(withEdge.ok, true)
  const removed = store.update(created.plan.id, { removeItemIds: [b.id] })
  assert.equal(removed.ok, true)
  assert.deepEqual(removed.plan.items[0].dependsOn, [])
  assert.equal(removed.plan.items.length, 1)
})

test('a mesma missão nunca fica vinculada a dois itens', (t) => {
  const { store } = storeIn(t, 'link-twice')
  const created = store.create(
    'p1',
    draftOf([
      { title: 'A', objective: 'a' },
      { title: 'B', objective: 'b' }
    ]),
    { manual: true }
  )
  const [a, b] = created.plan.items
  assert.equal(store.linkMission(created.plan.id, a.id, 'm1').ok, true)
  const twice = store.linkMission(created.plan.id, b.id, 'm1')
  assert.equal(twice.ok, false)
  assert.match(twice.error, /já está vinculada/)
})

test('addItems entra no fim e resolve dependência por key nova e por id antigo', (t) => {
  const { store } = storeIn(t, 'add')
  const created = store.create('p1', draftOf([{ title: 'A', objective: 'a' }]), { manual: true })
  const existing = created.plan.items[0]
  const grown = store.update(created.plan.id, {
    addItems: [
      { key: 'nova-1', title: 'Nova 1', objective: 'n1', doneCriteria: [], dependsOn: [existing.id] },
      { key: 'nova-2', title: 'Nova 2', objective: 'n2', doneCriteria: [], dependsOn: ['nova-1'] }
    ]
  })
  assert.equal(grown.ok, true)
  const [, nova1, nova2] = grown.plan.items
  assert.deepEqual(nova1.dependsOn, [existing.id])
  assert.deepEqual(nova2.dependsOn, [nova1.id])
  assert.deepEqual(
    grown.plan.items.map((item) => item.order),
    [0, 1, 2]
  )
  // dependência inventada não vira aresta fantasma
  const bogus = store.update(created.plan.id, {
    addItems: [
      { key: 'nova-3', title: 'Nova 3', objective: 'n3', doneCriteria: [], dependsOn: ['fantasma'] }
    ]
  })
  assert.equal(bogus.ok, true)
  assert.deepEqual(bogus.plan.items.at(-1).dependsOn, [])
})

test('item não depende de si mesmo nem de item de outro plano', (t) => {
  const { store } = storeIn(t, 'edges')
  const created = store.create('p1', draftOf([{ title: 'A', objective: 'a' }]), { manual: true })
  const item = created.plan.items[0]
  assert.match(
    store.update(created.plan.id, { items: [{ id: item.id, dependsOn: [item.id] }] }).error,
    /não pode depender de si mesma/
  )
  assert.match(
    store.update(created.plan.id, { items: [{ id: item.id, dependsOn: ['de-outro'] }] }).error,
    /não está neste plano/
  )
})

// ————— progresso derivado —————

test('a missão manda no estado do item, e descartada vence tudo', () => {
  const base = {
    id: 'i1',
    title: 'A',
    objective: 'a',
    doneCriteria: [],
    dependsOn: [],
    order: 0,
    status: 'planejada',
    createdAt: 'x',
    updatedAt: 'x'
  }
  const mission = (status) => ({ id: 'm1', title: 'M', status })
  assert.equal(effectivePlanItemStatus(base, undefined), 'planejada')
  assert.equal(effectivePlanItemStatus(base, mission('ativa')), 'em_andamento')
  assert.equal(effectivePlanItemStatus(base, mission('integrando')), 'em_andamento')
  assert.equal(effectivePlanItemStatus(base, mission('concluida')), 'concluida')
  // arquivada preserva o autoral (engavetar não desfaz nem completa trabalho)
  assert.equal(
    effectivePlanItemStatus({ ...base, status: 'em_andamento' }, mission('arquivada')),
    'em_andamento'
  )
  assert.equal(
    effectivePlanItemStatus({ ...base, status: 'descartada' }, mission('concluida')),
    'descartada'
  )
})

test('a visão traz progresso derivado e nunca conta item descartado', (t) => {
  const { store } = storeIn(t, 'view')
  const created = store.create(
    'p1',
    draftOf([
      { title: 'A', objective: 'a' },
      { title: 'B', objective: 'b' },
      { title: 'C', objective: 'c' }
    ]),
    { manual: true }
  )
  const [a, b, c] = created.plan.items
  store.linkMission(created.plan.id, a.id, 'm-done')
  store.linkMission(created.plan.id, b.id, 'm-live')
  const withDiscard = store.update(created.plan.id, {
    items: [{ id: c.id, status: 'descartada' }]
  })
  assert.equal(withDiscard.ok, true)

  const view = planView(store.get(created.plan.id), [
    { id: 'm-done', title: 'Feita', status: 'concluida' },
    { id: 'm-live', title: 'Viva', status: 'ativa' }
  ])
  assert.deepEqual(view.progress, { done: 1, total: 2 })
  assert.equal(view.items[0].status, 'concluida')
  assert.equal(view.items[0].authoredStatus, 'em_andamento')
  assert.equal(view.items[0].mission.title, 'Feita')
  assert.equal(view.items[2].status, 'descartada')
  assert.equal(view.items[2].mission, undefined)
  // o disco continua guardando a INTENÇÃO, nunca o derivado
  assert.equal(store.get(created.plan.id).items[0].status, 'em_andamento')
})

// ————— autocura —————

test('missão que sumiu solta o vínculo, anota e persiste — sem progresso fantasma', (t) => {
  const { file, store } = storeIn(t, 'reconcile')
  const created = store.create(
    'p1',
    draftOf([
      { title: 'A', objective: 'a' },
      { title: 'B', objective: 'b' }
    ]),
    { manual: true }
  )
  const [a, b] = created.plan.items
  store.linkMission(created.plan.id, a.id, 'm-viva')
  store.linkMission(created.plan.id, b.id, 'm-morta')

  const healed = store.reconcile('p1', new Set(['m-viva']))
  assert.equal(healed.changed, true)
  assert.deepEqual(healed.detached, [
    { planId: created.plan.id, itemId: b.id, missionId: 'm-morta' }
  ])
  const plan = store.get(created.plan.id)
  assert.equal(plan.items[0].missionId, 'm-viva')
  assert.equal(plan.items[1].missionId, undefined)
  assert.equal(plan.items[1].status, 'planejada')
  assert.equal(plan.items[1].note, PLAN_ITEM_DETACHED_NOTE)

  // idempotente: a segunda passada não mexe em nada
  assert.equal(store.reconcile('p1', new Set(['m-viva'])).changed, false)
  // e o reparo pousou no disco antes da fotografia viva
  const persisted = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(persisted[0].items[1].note, PLAN_ITEM_DETACHED_NOTE)

  // o primeiro toque no item apaga a anotação
  const touched = store.update(created.plan.id, { items: [{ id: b.id, title: 'B melhor' }] })
  assert.equal(touched.plan.items[1].note, undefined)
})

test('a autocura de um universo nunca toca o plano de outro', (t) => {
  const { store } = storeIn(t, 'reconcile-scope')
  const mine = store.create('p1', draftOf([{ title: 'A', objective: 'a' }]), { manual: true })
  const theirs = store.create('p2', draftOf([{ title: 'B', objective: 'b' }]), { manual: true })
  store.linkMission(mine.plan.id, mine.plan.items[0].id, 'm1')
  store.linkMission(theirs.plan.id, theirs.plan.items[0].id, 'm1')

  const healed = store.reconcile('p1', new Set())
  assert.equal(healed.detached.length, 1)
  assert.equal(store.get(theirs.plan.id).items[0].missionId, 'm1')
})

test('remoção dura some com o plano e removeProject leva o universo inteiro', (t) => {
  const { store } = storeIn(t, 'remove')
  const one = store.create('p1', draftOf([{ title: 'A', objective: 'a' }]), { manual: true })
  const two = store.create('p1', draftOf([{ title: 'B', objective: 'b' }]), { manual: true })
  const other = store.create('p2', draftOf([{ title: 'C', objective: 'c' }]), { manual: true })
  assert.equal(store.remove(one.plan.id, one.plan.updatedAt).ok, true)
  assert.equal(store.get(one.plan.id), undefined)
  assert.equal(store.remove('inexistente').ok, false)
  store.removeProject('p1')
  assert.equal(store.get(two.plan.id), undefined)
  assert.equal(store.get(other.plan.id)?.id, other.plan.id)
})

test('arquivar carimba a data e desarquivar por patch a apaga', (t) => {
  const { store } = storeIn(t, 'archive')
  const created = store.create('p1', draftOf([{ title: 'A', objective: 'a' }]), { manual: true })
  const archived = store.archive(created.plan.id)
  assert.equal(archived.plan.status, 'arquivado')
  assert.ok(archived.plan.archivedAt)
  const reopened = store.update(created.plan.id, { status: 'ativo' })
  assert.equal(reopened.plan.status, 'ativo')
  assert.equal(reopened.plan.archivedAt, undefined)
})

test('JSON quebrado no principal é reparado pelo backup; sem backup válido, começa vazio', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-plans-corrupt-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'plans.json')
  const seeded = new PlanStore(file)
  const created = seeded.create('p1', draftOf([{ title: 'A', objective: 'a' }]), { manual: true })

  // o principal vira lixo: o .bak que o jsonStore mantém traz o plano de volta
  writeFileSync(file, '{ isto não é json', 'utf8')
  assert.equal(new PlanStore(file).get(created.plan.id)?.title, 'Plano de teste')

  // as duas fotografias inválidas (aqui: forma estruturalmente errada) nunca
  // derrubam o boot — o universo simplesmente nasce sem plano nenhum
  writeFileSync(file, JSON.stringify([{ semIdentidade: true }]), 'utf8')
  writeFileSync(`${file}.bak`, JSON.stringify({ nao: 'é lista' }), 'utf8')
  assert.deepEqual(new PlanStore(file).list('p1'), [])
})

// ————— DESIGNAÇÃO DE MESTRE (ordem do dono, 2026-08-17) —————
//
// `kind` deixou de ser carimbo de nascimento: promover e rebaixar são gestos
// do dono. Continua FORA de todo patch — só `setKind` o move —, e é ele que
// guarda o invariante de UM mestre ATIVO por universo.

const masterDraft = (title) =>
  normalizePlanDraft({ title, kind: 'mestre', items: [{ title: 'A', objective: 'a' }] }).draft

test('designação: promover um plano livre e rebaixá-lo de volta', (t) => {
  const { store } = storeIn(t, 'setkind-promote')
  const plan = store.create('p1', draftOf([{ title: 'A', objective: 'a' }]), { manual: true }).plan
  assert.equal(plan.kind, 'livre')

  const promoted = store.setKind(plan.id, 'mestre', plan.updatedAt)
  assert.equal(promoted.ok, true)
  assert.equal(promoted.plan.kind, 'mestre')
  // O disco pousa antes da fotografia viva: reler o store confirma.
  assert.equal(store.get(plan.id).kind, 'mestre')

  const demoted = store.setKind(plan.id, 'livre', promoted.plan.updatedAt)
  assert.equal(demoted.ok, true)
  assert.equal(demoted.plan.kind, 'livre')
})

test('designação: o segundo mestre é recusado NOMEANDO quem tem o título', (t) => {
  const { store } = storeIn(t, 'setkind-taken')
  const holder = store.create('p1', masterDraft('O plano de fundo'), { manual: true }).plan
  const other = store.create('p1', draftOf([{ title: 'B', objective: 'b' }]), { manual: true }).plan

  const refused = store.setKind(other.id, 'mestre', other.updatedAt)
  assert.equal(refused.ok, false)
  // A receita tem de nomear o plano e dizer o que fazer — "já existe um" não
  // diz ao dono ONDE está o que ele precisa rebaixar.
  assert.match(refused.error, /O plano de fundo/u)
  assert.match(refused.error, /remova a designação/u)

  // Rebaixar o atual libera o slot no mesmo universo.
  assert.equal(store.setKind(holder.id, 'livre', holder.updatedAt).ok, true)
  assert.equal(store.setKind(other.id, 'mestre', other.updatedAt).ok, true)

  // Outro universo nunca disputa o slot.
  const alheio = store.create('p2', draftOf([{ title: 'C', objective: 'c' }]), { manual: true }).plan
  assert.equal(store.setKind(alheio.id, 'mestre', alheio.updatedAt).ok, true)
})

test('designação: mestre só se o plano estiver ATIVO; rebaixar é sempre possível', (t) => {
  const { store } = storeIn(t, 'setkind-status')
  const arquivado = store.create('p1', draftOf([{ title: 'A', objective: 'a' }]), { manual: true })
    .plan
  const archived = store.archive(arquivado.id, arquivado.updatedAt)
  const refusedArchived = store.setKind(arquivado.id, 'mestre', archived.plan.updatedAt)
  assert.equal(refusedArchived.ok, false)
  assert.match(refusedArchived.error, /reabra este plano/u)

  const concluido = store.create('p1', draftOf([{ title: 'B', objective: 'b' }]), { manual: true })
    .plan
  const done = store.update(concluido.id, { status: 'concluido' }, concluido.updatedAt)
  assert.equal(store.setKind(concluido.id, 'mestre', done.plan.updatedAt).ok, false)

  // Mas um mestre que foi concluído/arquivado NUNCA fica preso no título.
  const mestre = store.create('p1', masterDraft('Mestre'), { manual: true }).plan
  const guardado = store.archive(mestre.id, mestre.updatedAt)
  const solto = store.setKind(mestre.id, 'livre', guardado.plan.updatedAt)
  assert.equal(solto.ok, true)
  assert.equal(solto.plan.kind, 'livre')
  assert.equal(solto.plan.status, 'arquivado')
})

test('designação: CAS defasado recusa, e designar de novo não bombeia updatedAt', (t) => {
  const { store } = storeIn(t, 'setkind-cas')
  const plan = store.create('p1', draftOf([{ title: 'A', objective: 'a' }]), { manual: true }).plan

  const stale = store.setKind(plan.id, 'mestre', '2020-01-01T00:00:00.000Z')
  assert.equal(stale.ok, false)
  assert.equal(stale.error, PLAN_STALE_ERROR)
  assert.equal(store.get(plan.id).kind, 'livre')

  const promoted = store.setKind(plan.id, 'mestre', plan.updatedAt)
  const again = store.setKind(promoted.plan.id, 'mestre', promoted.plan.updatedAt)
  assert.equal(again.ok, true)
  // Idempotente SEM ESCRITA: a fotografia do dono continua válida depois.
  assert.equal(again.plan.updatedAt, promoted.plan.updatedAt)

  assert.equal(store.setKind('inexistente', 'mestre').ok, false)
})

test('designação: nenhum patch move o `kind` — só o gesto do dono', (t) => {
  const { store } = storeIn(t, 'setkind-patch')
  const plan = store.create('p1', draftOf([{ title: 'A', objective: 'a' }]), { manual: true }).plan
  // `update_plan` executa direto por desenho: se `kind` entrasse no patch, o
  // agente se autodesignaria plano mestre.
  const patched = store.update(plan.id, { kind: 'mestre', title: 'Outro' }, plan.updatedAt)
  assert.equal(patched.ok, true)
  assert.equal(patched.plan.title, 'Outro')
  assert.equal(patched.plan.kind, 'livre')
})

// ————— R16: O GRAFO DIZ DE QUEM A MISSÃO DEPENDE (2026-08-19) —————
//
// O briefing do dev precisa saber o que as dependências JÁ entregaram, e o
// vínculo já existia inteiro: item com missionId desta missão → dependsOn →
// item dependido → a missão dele. Nenhum campo novo; o que faltava era a
// leitura. Ela mora aqui, pura, porque é contrato — o ipc só resolve o ESTADO
// de cada missão dependida em cima do que sai daqui.

test('as dependências de uma missão saem do plano, com o título do item dependido', (t) => {
  const { store } = storeIn(t, 'deps-lookup')
  const created = store.create(
    'p1',
    draftOf([
      { title: 'Store da fila', objective: 'guardar os tickets' },
      { title: 'Botão de subir', objective: 'o gesto do dono' },
      {
        title: 'Tela da fila',
        objective: 'mostrar a fila',
        dependsOn: ['store-da-fila', 'botao-de-subir']
      }
    ]),
    { manual: true }
  )
  const [store_, botao, tela] = created.plan.items
  store.linkMission(created.plan.id, store_.id, 'm-store')
  store.linkMission(created.plan.id, botao.id, 'm-botao')
  store.linkMission(created.plan.id, tela.id, 'm-tela')

  assert.deepEqual(planDependenciesOfMission(store.list('p1'), 'm-tela'), [
    { itemTitle: 'Store da fila', missionId: 'm-store' },
    { itemTitle: 'Botão de subir', missionId: 'm-botao' }
  ])
  // quem não depende de ninguém (o que o dono roda em paralelo) sai vazio
  assert.deepEqual(planDependenciesOfMission(store.list('p1'), 'm-store'), [])
  // missão que não está em plano nenhum, e id vazio, nunca inventam grafo
  assert.deepEqual(planDependenciesOfMission(store.list('p1'), 'm-avulsa'), [])
  assert.deepEqual(planDependenciesOfMission(store.list('p1'), ''), [])
})

test('dependência sem missão criada ou DESCARTADA fica fora do grafo', (t) => {
  const { store } = storeIn(t, 'deps-recortes')
  const created = store.create(
    'p1',
    draftOf([
      { title: 'Ainda no papel', objective: 'sem missão' },
      { title: 'Fora do plano', objective: 'o dono descartou' },
      { title: 'Entregue', objective: 'essa vale' },
      {
        title: 'Depende de todas',
        objective: 'a que abre o chat',
        dependsOn: ['ainda-no-papel', 'fora-do-plano', 'entregue']
      }
    ]),
    { manual: true }
  )
  const [, descartada, entregue, dependente] = created.plan.items
  store.linkMission(created.plan.id, descartada.id, 'm-descartada')
  store.linkMission(created.plan.id, entregue.id, 'm-entregue')
  store.linkMission(created.plan.id, dependente.id, 'm-dependente')
  store.update(created.plan.id, { items: [{ id: descartada.id, status: 'descartada' }] })

  // item sem missão não tem entrega para contar; item descartado saiu do plano
  assert.deepEqual(planDependenciesOfMission(store.list('p1'), 'm-dependente'), [
    { itemTitle: 'Entregue', missionId: 'm-entregue' }
  ])
})

test('a mesma missão dependida em dois planos aparece UMA vez', (t) => {
  const { store } = storeIn(t, 'deps-dedupe')
  for (const label of ['um', 'dois']) {
    const created = store.create(
      'p1',
      draftOf(
        [
          { title: 'Store da fila', objective: 'guardar' },
          { title: 'Tela da fila', objective: 'mostrar', dependsOn: ['store-da-fila'] }
        ],
        { title: `Plano ${label}` }
      ),
      { manual: true }
    )
    const [dependida, dependente] = created.plan.items
    store.linkMission(created.plan.id, dependida.id, 'm-store')
    store.linkMission(created.plan.id, dependente.id, 'm-tela')
  }

  assert.deepEqual(planDependenciesOfMission(store.list('p1'), 'm-tela'), [
    { itemTitle: 'Store da fila', missionId: 'm-store' }
  ])
})
