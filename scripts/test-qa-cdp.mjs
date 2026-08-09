/**
 * Suite da Fase 4 (QA de Electron com app REAL via CDP — qaCdp.ts + o ramo
 * CDP do qaRuntime). Strings literais vêm da sonda probe-electron-cdp.mjs
 * (rodada 2026-08-08 nesta máquina, 4/4 verde).
 * Rodar: npm run test:qa-cdp
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cdpInvocation,
  decorateBrowserLaunchArgs,
  isElectronScript,
  isElectronViteScript,
  matchDevToolsListening,
  qaCdpEndpointFor,
  qaCdpPortFor,
  qaCdpReservations,
  releaseQaCdpPort,
  reserveQaCdpPort
} from '../src/main/qaCdp.ts'
// NOTA: qaRuntime.ts importa './runtimeOwnership' SEM extensão (resolução do
// bundler) e não é alcançável por --experimental-strip-types — a mudança da
// Fase 4 lá é o ramo CDP (consulta ao registro daqui) + a delegação do
// detector para isElectronScript, ambos cobertos por esta suíte.

test('isElectronScript reconhece electron-vite e electron puro, nunca web', () => {
  assert.equal(isElectronScript('electron-vite dev'), true)
  assert.equal(isElectronScript('electron-vite preview'), true)
  assert.equal(isElectronScript('electron .'), true)
  assert.equal(isElectronScript('cross-env NODE_ENV=dev electron main.js'), true)
  assert.equal(isElectronScript('vite'), false)
  assert.equal(isElectronScript('next dev'), false)
  // 'electronics-app start' não pode casar: \b protege o nome parcial
  assert.equal(isElectronScript('electronics-app start'), false)
})

test('isElectronViteScript distingue a ferramenta do binario puro', () => {
  assert.equal(isElectronViteScript('electron-vite dev --watch'), true)
  assert.equal(isElectronViteScript('electron .'), false)
})

test('cdpInvocation electron-vite: env REMOTE_DEBUGGING_PORT + argv com -- duplo', () => {
  const inv = cdpInvocation('electron-vite dev', 9333)
  // env cobre o script `dev` (startElectron só lê a env em development);
  // o argv (`-- --`) cobre também `preview` — flag duplicada com o MESMO
  // valor é inofensiva no Chromium.
  assert.deepEqual(inv.env, { REMOTE_DEBUGGING_PORT: '9333' })
  assert.equal(inv.suffix, ' -- -- --remote-debugging-port=9333')
})

test('cdpInvocation electron puro: UM -- (o -- duplo mataria o parse de switch do Chromium)', () => {
  const inv = cdpInvocation('electron .', 9333)
  assert.deepEqual(inv.env, {})
  assert.equal(inv.suffix, ' -- --remote-debugging-port=9333')
})

test('cdpInvocation script web: vazio (CDP nao se aplica)', () => {
  const inv = cdpInvocation('vite', 9333)
  assert.deepEqual(inv.env, {})
  assert.equal(inv.suffix, '')
})

test('matchDevToolsListening casa a linha REAL da sonda e extrai a porta', () => {
  // Linha literal capturada pela sonda R1 (2026-08-08)
  const line =
    'DevTools listening on ws://127.0.0.1:64800/devtools/browser/abbc4cc8-2b8c-46ca-9b68-36a163b475a0'
  const hit = matchDevToolsListening(`ruido antes\n${line}\nruido depois`)
  assert.ok(hit)
  assert.equal(hit.port, 64800)
  assert.ok(hit.wsUrl.startsWith('ws://127.0.0.1:64800/'))
})

test('matchDevToolsListening exige a linha COMPLETA (chunk cortado no meio da porta nao casa)', () => {
  const part1 = 'saida do vite...\nDevTools listening on ws://127.0.0.1:5'
  const part2 = '1234/devtools/browser/aabbccdd-1122-3344-5566-778899aabbcc\n'
  // porta truncada NUNCA casa — casar aqui viraria erro fatal espúrio de
  // "porta divergente" no qaRuntime (a razão do sufixo obrigatório no regex)
  assert.equal(matchDevToolsListening(part1), undefined)
  // o tee acumulado junta os chunks — o match final vê a porta inteira
  const full = matchDevToolsListening(part1 + part2)
  assert.ok(full)
  assert.equal(full.port, 51234)
})

test('matchDevToolsListening ignora texto sem a linha', () => {
  assert.equal(matchDevToolsListening('Local: http://localhost:5174/'), undefined)
})

test('reserva de porta CDP: estavel por card, some no release', async () => {
  const taskId = 'test-task-cdp-0001'
  try {
    const port = await reserveQaCdpPort(taskId)
    assert.ok(typeof port === 'number' && port > 0, 'reserva devolve porta real do SO')
    // idempotente: o restart do runtime e o respawn do pane reusam a MESMA
    // porta — o --cdp-endpoint do pane foi lacrado no spawn
    assert.equal(await reserveQaCdpPort(taskId), port)
    assert.equal(qaCdpPortFor(taskId), port)
    assert.equal(qaCdpEndpointFor(taskId), `http://127.0.0.1:${port}`)
    assert.ok(qaCdpReservations().some((r) => r.taskId === taskId && r.port === port))
  } finally {
    releaseQaCdpPort(taskId)
  }
  assert.equal(qaCdpPortFor(taskId), undefined)
  assert.equal(qaCdpEndpointFor(taskId), undefined)
})

test('decorateBrowserLaunchArgs: output-dir com cwd; cdp-endpoint SO para QA com reserva', async () => {
  const taskId = 'test-task-cdp-0002'
  try {
    const port = await reserveQaCdpPort(taskId)
    const base = ['cli.js']
    const qa = decorateBrowserLaunchArgs(base, { cwd: 'C:/wt', role: 'qa', taskId })
    assert.ok(qa.includes('--output-dir'), 'evidencia nunca nasce git-visivel')
    assert.ok(qa.includes('--cdp-endpoint'))
    assert.equal(qa[qa.indexOf('--cdp-endpoint') + 1], `http://127.0.0.1:${port}`)
    // dev do MESMO card: browser normal, sem CDP (ele navega URL de dev server)
    const dev = decorateBrowserLaunchArgs(base, { cwd: 'C:/wt', role: 'dev', taskId })
    assert.ok(!dev.includes('--cdp-endpoint'))
    // QA de card SEM reserva (produto web): sem CDP
    const web = decorateBrowserLaunchArgs(base, { cwd: 'C:/wt', role: 'qa', taskId: 'sem-reserva' })
    assert.ok(!web.includes('--cdp-endpoint'))
    // sem cwd (pane sem worktree): nada de output-dir
    const bare = decorateBrowserLaunchArgs(base, { role: 'qa', taskId })
    assert.ok(!bare.includes('--output-dir'))
    // base nunca é mutada
    assert.deepEqual(base, ['cli.js'])
  } finally {
    releaseQaCdpPort(taskId)
  }
})

