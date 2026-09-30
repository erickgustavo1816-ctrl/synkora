import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'

// PROJETO SEM VERSIONAMENTO — as decisões puras da tela (2026-09-30).
//
// A tela nova do universo sem versionamento decide QUAL vista mostrar (Início,
// leitura de uma missão finalizada ou a missão aberta), em que ordem o
// histórico aparece, o que cada linha diz, em que estado o FINALIZAR está e
// que painéis a missão pode abrir. Tudo isso mora em módulos puros; o JSX só
// desenha. Os módulos entram por bundle do esbuild (eles importam a costura de
// `src/shared/projectVersioning.ts` sem extensão, como o resto do renderer).
//
// Código velho: `soloProjectModel.ts` não existe, `availableWorkspacePanels`
// não conhece a modalidade e `eligibleDockMission` só olha a aba de missão —
// cada teste abaixo reprova por conta própria.

function load(contents) {
  const out = buildSync({
    stdin: { contents, resolveDir: 'src/renderer/src', loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false
  }).outputFiles[0].text
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', out)(createRequire(import.meta.url), loaded, loaded.exports)
  return loaded.exports
}

const model = () => load("export * from './soloProjectModel'")

const mission = (over = {}) => ({
  id: over.id ?? 'm1',
  projectId: over.projectId ?? 'p1',
  title: over.title ?? 'Reescrever a seção de preços',
  status: over.status ?? 'ativa',
  direct: true,
  createdAt: over.createdAt ?? '2026-09-25T09:00:00.000Z',
  updatedAt: over.updatedAt ?? '2026-09-25T09:00:00.000Z',
  ...over
})

/** ISO de um horário LOCAL — a tela fala no fuso do dono. */
const local = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).toISOString()

test('a vista: missão aberta é a tela; sem ela, leitura pedida ou Início', () => {
  const { soloProjectView } = model()
  const done = mission({ id: 'old', status: 'concluida', completedAt: local(2026, 9, 29, 16, 5) })
  const open = mission({ id: 'now', status: 'ativa' })

  assert.deepEqual(soloProjectView([], 'p1', null), { kind: 'start' })
  assert.deepEqual(soloProjectView([done], 'p1', null), { kind: 'start' })
  assert.deepEqual(soloProjectView([done], 'p1', 'old'), { kind: 'reading', mission: done })
  assert.deepEqual(soloProjectView([done, open], 'p1', null), { kind: 'mission', mission: open })
  // uma missão por vez: com a missão aberta, a leitura NÃO rouba a tela
  assert.deepEqual(soloProjectView([done, open], 'p1', 'old'), { kind: 'mission', mission: open })
  // 'integrando' também ocupa a pasta (a régua é a da costura)
  const busy = mission({ id: 'busy', status: 'integrando' })
  assert.deepEqual(soloProjectView([busy], 'p1', null), { kind: 'mission', mission: busy })
  // leitura só de missão FINALIZADA deste projeto; apagada ou alheia volta ao Início
  assert.deepEqual(soloProjectView([done], 'p1', 'gone'), { kind: 'start' })
  assert.deepEqual(soloProjectView([mission({ id: 'x', projectId: 'p2', status: 'concluida' })], 'p1', 'x'), { kind: 'start' })
  assert.deepEqual(soloProjectView([mission({ id: 'arq', status: 'arquivada' })], 'p1', 'arq'), { kind: 'start' })
  // missão aberta de OUTRO projeto não é a tela deste
  assert.deepEqual(soloProjectView([mission({ projectId: 'p2' })], 'p1', null), { kind: 'start' })
})

test('o histórico: só finalizadas deste projeto, a mais recente primeiro', () => {
  const { soloHistory } = model()
  const list = [
    mission({ id: 'a', status: 'concluida', completedAt: local(2026, 9, 25, 9, 12) }),
    mission({ id: 'open', status: 'ativa' }),
    mission({ id: 'c', status: 'concluida', completedAt: local(2026, 9, 30, 11, 2) }),
    mission({ id: 'other', projectId: 'p2', status: 'concluida', completedAt: local(2026, 9, 30, 12, 0) }),
    // sem carimbo de conclusão: cai no updatedAt (nunca some da lista)
    mission({ id: 'b', status: 'concluida', updatedAt: local(2026, 9, 27, 11, 40) }),
    mission({ id: 'arch', status: 'arquivada' })
  ]
  assert.deepEqual(soloHistory(list, 'p1').map((m) => m.id), ['c', 'b', 'a'])
  assert.deepEqual(soloHistory([], 'p1'), [])
})

test('a linha do livro-razão: data curta, hora, título e a frase do resumo (ou a falta dela)', () => {
  const { soloHistoryRow, ledgerWhen, SOLO_SUMMARY_MISSING, soloFinishedLabel } = model()
  const now = new Date(2026, 8, 30, 18, 0)
  assert.deepEqual(ledgerWhen(local(2026, 9, 30, 11, 2), now), { day: '30 set', time: '11:02' })
  assert.deepEqual(ledgerWhen(local(2026, 1, 3, 7, 5), now), { day: '3 jan', time: '07:05' })
  // ano diferente do de hoje ganha o ano (senão "3 jan" mentiria)
  assert.deepEqual(ledgerWhen(local(2025, 12, 31, 23, 59), now), { day: '31 dez 2025', time: '23:59' })
  assert.equal(ledgerWhen('not-a-date', now), null)

  const row = soloHistoryRow(mission({
    id: 'r', status: 'concluida', title: 'Revisar os prazos', completedAt: local(2026, 9, 29, 16, 5),
    summary: '  Encurtei a implantação de 90 para 60 dias.  '
  }), now)
  assert.deepEqual(row, {
    id: 'r', title: 'Revisar os prazos', day: '29 set', time: '16:05',
    summary: 'Encurtei a implantação de 90 para 60 dias.', label: 'Ler a missão Revisar os prazos'
  })
  // sem resumo a linha DIZ isso, em vez de sumir com a frase
  const bare = soloHistoryRow(mission({ status: 'concluida', summary: '   ', completedAt: local(2026, 9, 26, 18, 21) }), now)
  assert.equal(bare.summary, null)
  assert.equal(SOLO_SUMMARY_MISSING, 'sem resumo: o agente não deixou um')

  assert.equal(
    soloFinishedLabel(mission({ status: 'concluida', completedAt: local(2026, 9, 29, 16, 5) }), now),
    'finalizada em 29 set, 16:05'
  )
})

test('o FINALIZAR: tinta em repouso, acento quando o resumo chegou, travado na escolha de conta', () => {
  const { soloFinishButton, soloTurnOpen } = model()
  assert.equal(soloFinishButton({ needsSeat: true, summary: 'pronto', turnOpen: false }), 'blocked')
  assert.equal(soloFinishButton({ needsSeat: false, summary: undefined, turnOpen: false }), 'rest')
  assert.equal(soloFinishButton({ needsSeat: false, summary: '   ', turnOpen: false }), 'rest')
  assert.equal(soloFinishButton({ needsSeat: false, summary: 'Separei os preços.', turnOpen: false }), 'ready')
  // resumo antigo com o agente ainda no turno: o sinal espera o turno fechar
  assert.equal(soloFinishButton({ needsSeat: false, summary: 'Separei os preços.', turnOpen: true }), 'rest')

  assert.equal(soloTurnOpen('working'), true)
  assert.equal(soloTurnOpen('waiting-you'), true)
  for (const status of ['idle', 'starting', 'dead', undefined]) assert.equal(soloTurnOpen(status), false, String(status))
})

test('o risco de finalizar no meio do turno fala do que existe de verdade, com plural certo', () => {
  const { soloFinishRisk } = model()
  assert.equal(soloFinishRisk({ turnOpen: false, elapsed: null, helpersRunning: 0 }), null)
  assert.deepEqual(soloFinishRisk({ turnOpen: true, elapsed: '2:14', helpersRunning: 1 }), {
    headline: 'O agente está no meio de uma resposta (há 2:14) e 1 ajudante ainda trabalha.',
    consequence: 'Finalizar agora interrompe os dois, e uma edição feita pela metade pode ficar na pasta.'
  })
  assert.deepEqual(soloFinishRisk({ turnOpen: true, elapsed: null, helpersRunning: 0 }), {
    headline: 'O agente está no meio de uma resposta.',
    consequence: 'Finalizar agora interrompe o agente, e uma edição feita pela metade pode ficar na pasta.'
  })
  assert.deepEqual(soloFinishRisk({ turnOpen: true, elapsed: '0:40', helpersRunning: 3 }), {
    headline: 'O agente está no meio de uma resposta (há 0:40) e 3 ajudantes ainda trabalham.',
    consequence: 'Finalizar agora interrompe o agente e os ajudantes, e uma edição feita pela metade pode ficar na pasta.'
  })
  assert.deepEqual(soloFinishRisk({ turnOpen: false, elapsed: null, helpersRunning: 1 }), {
    headline: '1 ajudante ainda trabalha.',
    consequence: 'Finalizar agora interrompe o ajudante, e uma edição feita pela metade pode ficar na pasta.'
  })
  assert.deepEqual(soloFinishRisk({ turnOpen: false, elapsed: null, helpersRunning: 2 }).headline, '2 ajudantes ainda trabalham.')
})

test('o Início: título obrigatório com a frase certa, objetivo opcional, missão de dev direta', () => {
  const { soloStartDraft, SOLO_TITLE_NEEDED } = model()
  assert.equal(SOLO_TITLE_NEEDED, 'Dê um título para a missão.')
  assert.deepEqual(soloStartDraft('   ', 'algo'), { ok: false, error: SOLO_TITLE_NEEDED })
  assert.deepEqual(soloStartDraft('  Reescrever preços ', '  '), {
    ok: true, input: { title: 'Reescrever preços', direct: true, missionType: 'dev' }
  })
  assert.deepEqual(soloStartDraft('Reescrever preços', ' três planos '), {
    ok: true, input: { title: 'Reescrever preços', goal: 'três planos', direct: true, missionType: 'dev' }
  })
})

test('recusa do main chega sem o embrulho do Electron', () => {
  const { plainIpcError } = load("export * from './util'")
  assert.equal(
    plainIpcError(new Error("Error invoking remote method 'missions:create': Error: Este projeto não é versionado e já tem uma missão aberta.")),
    'Este projeto não é versionado e já tem uma missão aberta.'
  )
  assert.equal(plainIpcError('falhou'), 'falhou')
})

test('a aba do universo sem versionamento: Arquivos ou Missão (valor antigo cai na Missão)', () => {
  const { soloUniverseTab } = model()
  assert.equal(soloUniverseTab('arquivos'), 'arquivos')
  for (const tab of ['board', 'mapa', 'backlog', undefined]) assert.equal(soloUniverseTab(tab), 'missao', String(tab))
})

test('painéis do projeto sem versionamento: Browser, Mobile e Frota — nunca Trabalho, Histórico ou Release', () => {
  const { availableWorkspacePanels } = load("export * from './workspacePanels'")
  assert.deepEqual(availableWorkspacePanels('dev', true, 'none'), ['browser', 'mobile', 'frota'])
  assert.deepEqual(availableWorkspacePanels('dev', false, 'none'), ['frota'])
  // o versionado não muda
  assert.deepEqual(availableWorkspacePanels('dev', true), ['browser', 'mobile', 'frota', 'trabalho', 'historico'])
  assert.deepEqual(availableWorkspacePanels('dev', true, 'git'), ['browser', 'mobile', 'frota', 'trabalho', 'historico'])
  assert.deepEqual(availableWorkspacePanels('release', true), ['browser', 'mobile', 'frota', 'trabalho', 'historico', 'release'])
})

test('o browser nativo encaixa na missão aberta do projeto sem versionamento, pela costura', () => {
  const { eligibleDockMission } = load("export * from './browserDockVisibility'")
  const solo = { id: 'p1', versioning: 'none' }
  const base = (over = {}) => ({
    appPage: 'workspace', openProjectId: 'p1', universeTabByProject: {}, missionTabByProject: {},
    projects: [solo], missions: [mission({ id: 'open' }), mission({ id: 'done', status: 'concluida' })], ...over
  })
  // a missão aberta É a tela: vale mesmo sem aba de missão selecionada
  assert.equal(eligibleDockMission(base()), 'open')
  assert.equal(eligibleDockMission(base({ missionTabByProject: { p1: 'done' } })), 'open')
  // aba Arquivos, outra página ou nenhuma missão aberta: o browser some
  assert.equal(eligibleDockMission(base({ universeTabByProject: { p1: 'arquivos' } })), null)
  assert.equal(eligibleDockMission(base({ appPage: 'settings' })), null)
  assert.equal(eligibleDockMission(base({ missions: [mission({ id: 'done', status: 'concluida' })] })), null)
  // o versionado continua pela aba de missão
  const git = base({ projects: [{ id: 'p1' }] })
  assert.equal(eligibleDockMission(git), null)
  assert.equal(eligibleDockMission({ ...git, missionTabByProject: { p1: 'open' } }), 'open')
})
