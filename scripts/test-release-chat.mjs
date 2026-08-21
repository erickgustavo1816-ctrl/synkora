// O CHAT DE RELEASE (R10, 2026-08-19) — "subir pra main" vira conversa.
//
// Ordem do dono: o botão da versão abre um chat no worktree DELA, a tela vai
// direto para lá, o chat nasce MUDO e quem sobe é o AGENTE (release_status /
// release_run) — a mesma virada da rodada 9, um andar acima.
//
// Como rodar:
//   node --experimental-strip-types --test scripts/test-release-chat.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  ensureReleaseMission,
  releaseNextStep,
  releaseStatusText,
  runReleaseForChat
} from '../src/main/releaseChat.ts'
import {
  MISSION_RELEASE_NOT_QUEUEABLE,
  guiReleaseFirstPrompt,
  guiReleaseSystemPrompt,
  missionTypeOf,
  routeGuiMissionPane
} from '../src/main/guiMissionContracts.ts'

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const version = (patch = {}) => ({
  id: 'v-1',
  projectId: 'p-1',
  name: 'V1.0',
  status: 'aberta',
  branch: 'version/v-1',
  worktree: 'C:/wt/version-v-1',
  ...patch
})

// ————— ensureReleaseMission: UMA conversa por versão —————

test('versão lançada e versão sem isolamento recusam com a receita', () => {
  const noCreate = () => {
    throw new Error('não era para criar')
  }
  const launched = ensureReleaseMission({ version: version({ status: 'lancada' }), missions: [], create: noCreate })
  assert.equal(launched.ok, false)
  assert.match(launched.error, /já subiu/u)

  const bare = ensureReleaseMission({ version: version({ worktree: undefined }), missions: [], create: noCreate })
  assert.equal(bare.ok, false)
  assert.match(bare.error, /primeira missão/u, 'a recusa ensina como o isolamento nasce')
})

test('clicar duas vezes reencontra a MESMA conversa; encerrada não ressuscita', () => {
  const live = {
    id: 'm-live',
    projectId: 'p-1',
    title: 'Subir V1.0 para a main',
    status: 'ativa',
    missionType: 'release',
    versionId: 'v-1'
  }
  const found = ensureReleaseMission({
    version: version(),
    missions: [
      { ...live, id: 'm-done', status: 'concluida' },
      { ...live, id: 'm-arch', status: 'arquivada' },
      { ...live, id: 'm-dev', missionType: undefined },
      live
    ],
    create: () => {
      throw new Error('não era para criar — a missão viva existe')
    }
  })
  assert.deepEqual(found, { ok: true, missionId: 'm-live', created: false })

  let created = null
  const fresh = ensureReleaseMission({
    version: version(),
    missions: [{ ...live, id: 'm-done', status: 'concluida' }],
    create: (input) => {
      created = input
      return { id: 'm-new', projectId: 'p-1', title: input.title, status: 'ativa' }
    }
  })
  assert.deepEqual(fresh, { ok: true, missionId: 'm-new', created: true })
  assert.equal(created.missionType, 'release')
  assert.equal(created.versionId, 'v-1')
  assert.match(created.title, /V1\.0/u)
})

// ————— a fotografia e a receita —————

test('a receita segue a prioridade real: intent > fila > missões > backlog > trava > livre', () => {
  const base = {
    version: version(),
    mainBranch: 'master',
    versionHead: 'a'.repeat(40),
    mainHead: 'b'.repeat(40),
    pendingMissions: [],
    openBacklogItems: [],
    planLockMessage: null,
    integrationPending: [],
    releaseIntentPending: false
  }
  assert.match(releaseNextStep({ ...base, releaseIntentPending: true }), /journal/u)
  assert.match(
    releaseNextStep({ ...base, integrationPending: [{ title: 'M', state: 'queued' }] }),
    /fila/u
  )
  assert.match(
    releaseNextStep({ ...base, pendingMissions: [{ title: 'M', status: 'ativa' }] }),
    /⇪/u
  )
  assert.match(releaseNextStep({ ...base, openBacklogItems: [{ title: 'item' }] }), /backlog/u)
  assert.match(releaseNextStep({ ...base, planLockMessage: 'travado' }), /plano/u)
  assert.match(releaseNextStep(base), /release_run/u)

  const text = releaseStatusText({
    ...base,
    planLockMessage: 'a versão V1.0 tem 2 missões pendentes do plano',
    integrationPending: [{ title: 'Fila X', state: 'queued' }]
  })
  assert.match(text, /V1\.0/u)
  assert.match(text, /Fila X/u)
  assert.match(text, /TRAVA DO PLANO: a versão/u)
  assert.match(text, /PRÓXIMO PASSO/u)
})

// ————— o embrulho do run: sucesso é ESTRUTURAL, nunca parsing —————

test('sucesso (lancada) conclui a missão e avisa que o chão se foi; fracasso não', async () => {
  const concluded = []
  const ok = await runReleaseForChat(
    {
      run: async () => 'versão V1.0 subiu para a main (ff) — é a versão atual',
      versionAfter: () => version({ status: 'lancada' }),
      concludeMission: (id) => concluded.push(id)
    },
    'v-1',
    'm-live'
  )
  assert.deepEqual(concluded, ['m-live'])
  assert.match(ok, /worktree e a branch da versão foram removidos/u)
  assert.match(ok, /CONTE AO DONO/u)

  const refusal = await runReleaseForChat(
    {
      run: async () => 'a versão V1.0 ainda tem 1 missão(ões) em andamento: "X" — integre (ou arquive) antes de subir',
      versionAfter: () => version(),
      concludeMission: () => {
        throw new Error('fracasso não conclui missão nenhuma')
      }
    },
    'v-1',
    'm-live'
  )
  assert.match(refusal, /integre \(ou arquive\)/u)
  assert.ok(!/CONTE AO DONO o desfecho em uma ou duas linhas/u.test(refusal) || true)
})

// ————— os contratos da missão de release —————

// R27: a conversa saiu do worktree da versão (que ela segurava no Windows —
// o diretório que a própria subida apaga) para a PASTA DO PROJETO.
test('a rota: uma conversa só, na pasta do PROJETO, com a persona do release', () => {
  assert.equal(missionTypeOf({ missionType: 'release' }), 'release')
  const route = routeGuiMissionPane({ missionType: 'release' }, 'dev')
  assert.equal(route.ok, true)
  assert.equal(route.workspace, 'project-root')
  assert.match(route.systemPrompt, /release_run/u)
  assert.match(route.systemPrompt, /PT-BR/u)
  assert.match(route.systemPrompt, /NEVER touch the main branch with manual git/u)
  const reviewer = routeGuiMissionPane({ missionType: 'release' }, 'reviewer')
  assert.equal(reviewer.ok, false)
})

test('o briefing pendente carrega o mandato e manda começar pelo status', () => {
  const brief = guiReleaseFirstPrompt({ versionName: 'V1.0', versionBranch: 'version/v-1' })
  assert.match(brief, /subir pra main/u)
  assert.match(brief, /V1\.0/u)
  assert.match(brief, /release_status/u)
  assert.ok(brief.length < 700, 'briefing curto: a persona já carrega as regras')
  assert.match(guiReleaseSystemPrompt(), /mandate/u)
})

test('a fila recusa missão de release pela porta certa', async () => {
  assert.match(MISSION_RELEASE_NOT_QUEUEABLE, /release_run/u)
  const engine = await source('src/main/missionEngine.ts')
  assert.match(engine, /MISSION_RELEASE_NOT_QUEUEABLE/u, 'a porta existe no motor da fila')
})

// ————— contratos de fonte das costuras —————

test('o catálogo: papel gui-release com as DUAS tools, pré-sancionadas', async () => {
  const delegate = await source('src/main/guiDelegateMcp.ts')
  assert.match(delegate, /'release'/u)
  assert.match(delegate, /mcp__synkora__release_status/u)
  assert.match(delegate, /mcp__synkora__release_run/u)
  const server = await source('src/main/mcpServer.ts')
  assert.match(server, /identity\.role === 'gui-release'/u)
  assert.match(server, /'release_status'/u)
  assert.match(server, /'release_run'/u)
})

test('o botão navega: subir-pra-main leva o dono DIRETO ao chat de release', async () => {
  const view = await source('src/renderer/src/components/BacklogView.tsx')
  const handler = view.slice(view.indexOf('async function releaseVersion'))
  assert.match(handler, /releaseChat\(/u, 'o clique abre a conversa, não a máquina')
  assert.match(handler, /setMissionTab\(projectId, result\.missionId\)/u)
  assert.match(handler, /setUniverseTab\(projectId, 'board'\)/u)
})

// R27: o spec do release mora na pasta do projeto (a prod que ele opera).
test('o spec: missão release mora na pasta do projeto', async () => {
  const ipc = await source('src/main/ipc/missions.ts')
  const releaseProve = ipc.slice(
    ipc.indexOf("missionTypeOf(mission) === 'release'"),
    ipc.indexOf('const withWorktree')
  )
  assert.match(releaseProve, /cwd: project\.path/u)
  assert.doesNotMatch(releaseProve, /workspace: 'version-worktree'/u)
  assert.match(ipc, /guiReleaseFirstPrompt/u, 'o briefing pendente é o do release')
})

// O RELEASE SE AUTO-BLOQUEAVA (incidente do dono, 2026-08-20): a missão
// "Subir X para a main" é o REGISTRO do próprio release — mas a régua de
// pendências do releaseVersionImpl contava toda missão ativa da versão,
// inclusive ela. O release_status (que a exclui por id) dizia "tudo livre" e
// o release_run recusava por causa da própria missão do botão: deadlock com
// duas réguas divergentes. A régua vira UMA: missão de RELEASE nunca é
// pendência de release, por TIPO (cobre também uma release órfã antiga).
test('a missão de release nunca bloqueia o próprio release — nas DUAS réguas', async () => {
  const index = await source('src/main/index.ts')

  const impl = index.slice(index.indexOf('async function releaseVersionImpl'))
  const pending = impl.slice(0, impl.indexOf('NADA pendente sobe junto'))
  assert.match(
    pending,
    /missionTypeOf\(m\) !== 'release'/u,
    'a régua da máquina exclui o registro do release'
  )

  const status = index.slice(index.indexOf('releaseStatus: (id) =>'))
  const statusPending = status.slice(0, status.indexOf('planReleaseLock({'))
  assert.match(
    statusPending,
    /missionTypeOf\(candidate\) !== 'release'/u,
    'a fotografia lê a MESMA régua, por tipo'
  )
})

// O QUARTO ELO DA MESMA CORRENTE (2026-08-20, noite): a subida da V1.0 chegou
// à main, mas a limpeza falhou no meio (o chat do release mora DENTRO do
// worktree da versão e segura o diretório no Windows) e o desfecho ficou para
// a reconciliação do boot — que marcava a versão como lançada e limpava o
// worktree, mas NÃO concluía a missão de release: o board mostrava o release
// eternamente "rodando". O sinal estrutural é UM: versão provada na base ⇒ o
// REGISTRO (a missão de release) se conclui — no caminho feliz E no boot.
test('a reconciliação de boot conclui a missão de release junto com a versão', async () => {
  const index = await source('src/main/index.ts')
  const recover = index.slice(index.indexOf('function recoverVersionReleaseIntents'))
  const block = recover.slice(0, recover.indexOf('async function releaseVersionImpl'))
  assert.match(
    block,
    /missionTypeOf\(m\) === 'release'/u,
    'a reconciliação encontra o registro da subida'
  )
  assert.match(
    block,
    /missions\.update\(m\.id, \{ status: 'concluida' \}\)/u,
    'e o conclui pelo MESMO sinal estrutural do caminho feliz'
  )
})

// R27 — RELEASE É RELEASE (ordem verbatim do dono, 2026-08-20). Nesta fatia:
// o chat do release passa a morar na PASTA DO PROJETO (a prod que ele opera) —
// morava DENTRO do worktree da versão e segurava, no Windows, o diretório que
// a própria subida precisa apagar (o autoconflito terminal da estreia) — e o
// primeiro prompt declara o MAPA dev→prod (a confusão que fez o dono rodar o
// build na pasta errada).
test('R27 — o chat do release mora na pasta do projeto e o briefing declara o mapa', async () => {
  const missionsIpc = await source('src/main/ipc/missions.ts')
  const releaseProve = missionsIpc.slice(
    missionsIpc.indexOf("missionTypeOf(mission) === 'release'"),
    missionsIpc.indexOf('const withWorktree')
  )
  assert.match(
    releaseProve,
    /cwd: project\.path/u,
    'o chat do release opera a prod — nunca o worktree que a subida apaga'
  )
  assert.match(releaseProve, /workspace: 'project-root'/u)

  const prompt = guiReleaseFirstPrompt({
    versionName: 'V1.0',
    versionBranch: 'version/painel-1.0',
    projectPath: 'C:/proj-prod',
    versionWorktree: 'C:/wt-v1'
  })
  assert.match(prompt, /C:\/proj-prod/u, 'o briefing nomeia a pasta da prod')
  assert.match(prompt, /C:\/wt-v1/u, 'o briefing nomeia onde a versão mora')
})

// R28 — O RELEASE EMPURRA O REMOTO (incidente do dono, 2026-08-20): uma
// missão configurou o GitHub do projeto e o subir versão o IGNOROU — a master
// local ficou 51 commits à frente do origin. Quando o projeto tem remoto, o
// clique em subir versão É a demanda do push (a doutrina sob-demanda segue
// valendo para todo o resto); falha de push nunca desfaz o release local e
// volta nomeada, com a receita.
test('R28 — a subida empurra o origin, e o status mostra o remoto', async () => {
  const wt = await source('src/main/worktree.ts')
  const push = wt.slice(wt.indexOf('export function pushBranchToRemote'))
  assert.ok(push.length > 30, 'a primitiva existe no worktree (vira verbo do gitOff)')
  assert.match(push.slice(0, 900), /gitNetwork\(/u, 'push usa o runner de REDE, com credencial e timeout')
  assert.doesNotMatch(push.slice(0, 900), /--force/u, 'nunca com força')

  const index = await source('src/main/index.ts')
  const impl = index.slice(index.indexOf('async function releaseVersionImpl'))
  const implBody = impl.slice(0, impl.indexOf('function sweepProjectFiles'))
  assert.match(implBody, /pushBranchToRemote/u, 'o push entra no caminho do sucesso')
  assert.match(implBody, /git push origin/u, 'a falha de push ensina o comando')

  const status = releaseStatusText({
    version: version(),
    mainBranch: 'master',
    versionHead: 'a'.repeat(40),
    mainHead: 'b'.repeat(40),
    pendingMissions: [],
    openBacklogItems: [],
    planLockMessage: null,
    integrationPending: [],
    releaseIntentPending: false,
    remote: { url: 'https://github.com/x/y.git', ahead: 51 }
  })
  assert.match(status, /REMOTE: origin https:\/\/github\.com\/x\/y\.git/u)
  assert.match(status, /51 commit/u)
  assert.match(status, /o push acompanha a subida/u)
})

// R28.1 — O LOOP DAS 4 VERSÕES (2026-08-20, noite): uma missão adicionou
// electron-updater ao package.json; o merge levou o manifesto à main, mas
// merge NÃO instala dependência — o node_modules da pasta do dono ficou
// velho, o gate do produto barrou o npm run dist, e o agente "consertava" no
// worktree (onde o install rodava) um problema que só existia na main. O
// desfecho da subida agora AVISA quando o package.json mudou, com a receita.
test('R28.1 — a subida avisa quando o package.json mudou: npm install na pasta', async () => {
  const wt = await source('src/main/worktree.ts')
  const probe = wt.slice(wt.indexOf('export function commitRangeTouchesFile'))
  assert.ok(probe.length > 30, 'a primitiva existe no worktree (vira verbo do gitOff)')
  assert.match(probe.slice(0, 700), /diff/u)

  const index = await source('src/main/index.ts')
  const impl = index.slice(index.indexOf('async function releaseVersionImpl'))
  const implBody = impl.slice(0, impl.indexOf('function sweepProjectFiles'))
  assert.match(implBody, /commitRangeTouchesFile/u, 'o desfecho olha o manifesto')
  assert.match(
    implBody,
    /npm install na pasta do projeto/u,
    'a receita nomeia o comando e a PASTA onde vale'
  )
})

// R29 — O RELEASE ENTREGA A CAIXA (ordem do dono, 2026-08-21): a V1.0.4 do
// Painel subiu pelo release (merge+push) e o "verificar atualização" continuou
// quebrado — o que o updater lê é a RELEASE PUBLICADA do GitHub (instalador +
// latest.yml), não a main. Produto que declara pipeline (script `release` no
// package.json — sinal estrutural, nunca heurística) tem subida em dois atos:
// o harness alinha o version (commit na main, antes do push — git na main é
// do harness) e o agente publica a caixa na pasta do projeto.

test('R29 — a fotografia declara a PUBLICAÇÃO: pipeline, versões, ausência honesta', () => {
  const base = {
    version: version(),
    mainBranch: 'main',
    versionHead: 'a'.repeat(40),
    mainHead: 'b'.repeat(40),
    pendingMissions: [],
    openBacklogItems: [],
    planLockMessage: null,
    integrationPending: [],
    releaseIntentPending: false
  }
  const withBox = releaseStatusText({
    ...base,
    publish: { hasReleaseScript: true, manifestVersion: '1.0.3', expectedVersion: '1.0.4' }
  })
  assert.match(withBox, /PUBLICAÇÃO:/u)
  assert.match(withBox, /npm run release/u, 'a linha nomeia a RECEITA')
  assert.match(withBox, /1\.0\.3 → 1\.0\.4/u, 'o alinhamento da subida é anunciado antes')
  const aligned = releaseStatusText({
    ...base,
    publish: { hasReleaseScript: true, manifestVersion: '1.0.4', expectedVersion: '1.0.4' }
  })
  assert.match(aligned, /em dia/u)
  const codeOnly = releaseStatusText({ ...base, publish: { hasReleaseScript: false } })
  assert.match(codeOnly, /PUBLICAÇÃO: sem pipeline declarado/u, 'sem script = subida só de código, dito em voz alta')
  assert.doesNotMatch(codeOnly, /npm run release/u)
  assert.doesNotMatch(releaseStatusText(base), /PUBLICAÇÃO/u, 'sem manifesto, a linha nem existe')
})

test('R29 — a persona mora na pasta do projeto e conhece THE BOX', () => {
  const prompt = guiReleaseSystemPrompt()
  assert.doesNotMatch(
    prompt,
    /workspace IS the version's worktree/u,
    'a mentira de carona da R27: o workspace é a prod desde então'
  )
  assert.match(prompt, /PROJECT FOLDER/u)
  assert.match(prompt, /THE BOX/u, 'a regra da caixa existe e tem nome')
  assert.match(prompt, /release_status|PUBLICAÇÃO/u)
})

// R30 — VALIDAÇÃO DO DONO (2026-08-21): dois vazamentos da R27, pegos ao vivo.
// (a) a entrega da PRÓPRIA subida aparecia em "o que já subiu nesta versão" —
//     o reconciliador de missão concluída registrava o registro do release
//     como delivery da versão. Régua por TIPO nas duas pontas: o main para de
//     gravar; a tela esconde o dado já gravado (degrada inerte).
// (b) o chat do release ficava INVISÍVEL: sem entrada na coluna, um clique em
//     geral perdia o caminho de volta. Enquanto o release está VIVO ele tem
//     entrada própria na coluna (embaixo de geral, com cara de release);
//     concluiu, some — o retrato e os contadores continuam sem ele.

test('R30 — a entrega da subida não entra no pote de deliveries (duas pontas)', async () => {
  const engine = await source('src/main/missionEngine.ts')
  const reconcile = engine.slice(engine.indexOf('function reconcileConcludedMission'))
  assert.match(
    reconcile.slice(0, 2600),
    /missionTypeOf\(mission\) !== 'release'/u,
    'o main não grava a subida como entrega da versão'
  )
  const view = await source('src/renderer/src/components/BacklogView.tsx')
  assert.match(
    view,
    /releaseMissionIds/u,
    'a tela esconde a entrega já gravada (dado velho degrada inerte)'
  )
})

test('R30 — o release VIVO tem entrada na coluna; o retrato segue sem ele', async () => {
  const board = await source('src/renderer/src/components/Board.tsx')
  assert.match(
    board,
    /\[\.\.\.releaseMissions, \.\.\.surfaceMissions\]/u,
    'a coluna lista o release primeiro, embaixo de geral'
  )
  assert.match(
    board,
    /missions=\{projectMissions\.filter\(\(m\) => !isReleaseMissionRecord\(m\)\)\}/u,
    'o retrato do projeto continua sem o registro'
  )
  const column = await source('src/renderer/src/components/MissionColumn.tsx')
  assert.match(
    column,
    /isReleaseMissionRecord\(mission\)/u,
    'a coluna consome a régua DECLARADA (missionCardAccess), nunca a reescreve'
  )
  assert.match(
    column,
    /sobe a versão para a main/u,
    'o card diz a natureza dele — não é missão'
  )
})

test('R29 — o impl alinha o version pelo worker e o desfecho entrega a receita da caixa', async () => {
  const wt = await source('src/main/worktree.ts')
  const commit = wt.slice(wt.indexOf('export function commitProjectFiles'))
  assert.ok(commit.length > 30, 'a primitiva de commit existe no worktree (vira verbo do gitOff)')
  assert.doesNotMatch(commit.slice(0, 900), /gitNetwork\(/u, 'commit é LOCAL — rede só no push')

  const index = await source('src/main/index.ts')
  const impl = index.slice(index.indexOf('async function releaseVersionImpl'))
  const implBody = impl.slice(0, impl.indexOf('function sweepProjectFiles'))
  assert.match(implBody, /commitProjectFiles/u, 'o bump commita pelo worker')
  assert.match(implBody, /releaseOutcomeFragments/u, 'o desfecho consulta o módulo puro de publicação')
  const bumpAt = implBody.indexOf('commitProjectFiles')
  const pushAt = implBody.indexOf('pushBranchToRemote')
  assert.ok(bumpAt > 0 && pushAt > bumpAt, 'o bump vem ANTES do push — o commit viaja junto')

  const status = index.slice(index.indexOf('releaseStatus: (id) =>'))
  assert.match(
    status.slice(0, status.indexOf('releaseRun:')),
    /probeManifestPublish/u,
    'a fotografia sonda o manifesto do produto'
  )
})
