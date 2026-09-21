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
  RELEASE_DONE_BOX_ADVISORY,
  ensureReleaseMission,
  releaseDoneDecision,
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

test('release separa destino main da pasta em dev e oferece troca dentro do chat', () => {
  const input = {
    version: version(), mainBranch: 'main', pendingMissions: [], openBacklogItems: [],
    planLockMessage: null, integrationPending: [], releaseIntentPending: false,
    target: { branch: 'main', currentBranch: 'dev', head: 'a'.repeat(40), branches: ['dev', 'main'], needsSwitch: true }
  }
  const text = releaseStatusText(input)
  assert.match(text, /DESTINO: main/u)
  assert.match(text, /PASTA DO PROJETO: dev/u)
  assert.match(text, /release_run.*main/u)
  const unset = { ...input, mainBranch: undefined, target: { currentBranch: 'dev', branches: ['dev', 'main'], needsSwitch: false, error: 'destino não definido; use release_target com a branch autorizada pelo dono' } }
  assert.match(releaseNextStep(unset), /release_target/u)
  assert.doesNotMatch(releaseNextStep(unset), /tudo livre/u)
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
  assert.match(releaseNextStep({ ...base, releaseIntentPending: true }), /release_run.*recuperar/u)
  assert.doesNotMatch(releaseNextStep({ ...base, releaseIntentPending: true }), /reinici/u)
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

test('sucesso (lancada) conta o que mudou; fracasso volta cru', async () => {
  const ok = await runReleaseForChat(
    {
      run: async () => 'versão V1.0 subiu para a main (ff) — é a versão atual',
      versionAfter: () => version({ status: 'lancada' }),
      publishRequired: () => false,
      // dep MORTA na R38 — fica só para o motor velho não morrer antes de o
      // assert de CONTEÚDO abaixo poder reprovar o texto dele.
      concludeMission: () => {}
    },
    'v-1'
  )
  assert.match(ok, /branch e o worktree da versão foram removidos/u)
  assert.match(ok, /CONTE AO DONO/u)

  const refusal = await runReleaseForChat(
    {
      run: async () =>
        'a versão V1.0 ainda tem 1 missão(ões) em andamento: "X" — integre (ou arquive) antes de subir',
      versionAfter: () => version(),
      publishRequired: () => {
        throw new Error('fracasso não pergunta pela caixa — não houve subida')
      }
    },
    'v-1'
  )
  assert.match(refusal, /integre \(ou arquive\)/u)
  assert.doesNotMatch(refusal, /release_done/u, 'sem subida não há fecho a oferecer')
})

// ————— R38 (2026-08-29): O FECHO É DO AGENTE —————
//
// O INCIDENTE (relato do dono): ele pediu ao chat do release para SUBIR A
// VERSÃO **e** construir o instalador. A ascensão pousou — e a conversa SUMIU
// antes da caixa existir. Causa raiz, nas duas pontas:
//   (a) runReleaseForChat concluía a missão no sucesso e mandava "NÃO rode mais
//       nada aqui" — resíduo da era R10, quando o chat morava no worktree da
//       versão; desde a R27 ele opera a PASTA DO PROJETO e desde a R29 a
//       própria persona diz o contrário (só termina com a caixa). A mecânica
//       contradizia a persona, e a mecânica ganhava;
//   (b) a reconciliação viva (missionEngine) concluía a mesma missão no
//       caminho de LEITURA, mesmo com o agente vivo no meio da entrega.
// Ordem do dono, verbatim: "o certo é ele mesmo decidir: ó, terminou aqui, vou
// fechar". O fecho virou FERRAMENTA (release_done).

test('R38 — a ascensão NÃO conclui mais nada: quem fecha é o agente', async () => {
  const concluded = []
  const ok = await runReleaseForChat(
    {
      run: async () => 'versão V1.0 subiu para a main (ff) — é a versão atual',
      versionAfter: () => version({ status: 'lancada' }),
      publishRequired: () => false,
      // A dep MORREU na R38 — este espião existe para pegar o motor velho.
      concludeMission: (id) => concluded.push(id)
    },
    'v-1',
    'm-live'
  )
  assert.deepEqual(concluded, [], 'a subida fecha NADA: o card não pode sumir no meio da entrega')
  assert.match(ok, /release_done/u, 'o desfecho nomeia a RECEITA do fecho')
  assert.match(ok, /TUDO que o dono pediu/u, 'e diz QUANDO se fecha')
  assert.doesNotMatch(
    ok,
    /NÃO rode mais nada aqui/u,
    'a ordem da era R10 morreu com o worktree que a justificava'
  )
  assert.match(
    ok,
    /esta conversa NÃO/u,
    'a frase honesta que sobrou: morreu a branch da versão, não a conversa'
  )
})

test('R38 — pipeline declarado ⇒ o desfecho entrega a receita da CAIXA, na pasta do projeto', async () => {
  const deps = (publishRequired) => ({
    run: async () => 'versão V1.0 subiu para a main (ff) — é a versão atual',
    versionAfter: () => version({ status: 'lancada' }),
    publishRequired: () => publishRequired,
    // dep MORTA na R38 — presente só para o motor velho chegar inteiro ao
    // assert de conteúdo (é o TEXTO que tem de reprovar, não um crash).
    concludeMission: () => {}
  })
  const withBox = await runReleaseForChat(deps(true), 'v-1')
  assert.match(withBox, /CAIXA/u, 'o próximo passo tem nome')
  assert.match(withBox, /PASTA DO PROJETO/u, 'e endereço — instrução sem pasta foi o build errado da R27')
  assert.match(withBox, /npm install/u, 'a receita nomeia o install quando as dependências mudaram')
  assert.match(withBox, /npm run release/u, 'e o script de release do produto')

  const codeOnly = await runReleaseForChat(deps(false), 'v-1')
  assert.doesNotMatch(codeOnly, /npm run release/u, 'sem pipeline, nenhuma caixa é inventada')
  assert.match(codeOnly, /release_done/u, 'mas o fecho continua sendo dele')
})

test('R38 — release_done: guarda DURA na versão, e a recusa nomeia release_run', () => {
  const semSubida = releaseDoneDecision({ version: version(), publishRequired: false })
  assert.equal(semSubida.ok, false, 'sem a versão lançada não há release a encerrar')
  assert.match(semSubida.text, /release_run/u, 'toda recusa nomeia a RECEITA (regra da casa)')
  assert.match(semSubida.text, /release_status/u)
  assert.equal(semSubida.advisory, undefined)

  const semVersao = releaseDoneDecision({ version: undefined, publishRequired: false })
  assert.equal(semVersao.ok, false)
  assert.match(semVersao.text, /não está ligada a uma versão/u)
})

test('R38 — release_done conclui na versão lançada, e a caixa é ADVISORY (nunca beco)', () => {
  const soCodigo = releaseDoneDecision({
    version: version({ status: 'lancada' }),
    publishRequired: false
  })
  assert.equal(soCodigo.ok, true)
  assert.equal(soCodigo.advisory, undefined, 'produto sem pipeline fecha limpo')
  assert.match(soCodigo.text, /V1\.0/u)

  // GUARDA DE JULGAMENTO: pipeline declarado e caixa não confirmada NÃO trancam
  // o fecho (só o agente sabe o que o dono pediu) — carimbam o recibo.
  const caixaNaoConfirmada = releaseDoneDecision({
    version: version({ status: 'lancada' }),
    publishRequired: true
  })
  assert.equal(caixaNaoConfirmada.ok, true, 'guarda de julgamento vira advisory, nunca recusa')
  assert.equal(caixaNaoConfirmada.advisory, RELEASE_DONE_BOX_ADVISORY)
  assert.match(caixaNaoConfirmada.text, /ADVISORY/u, 'o advisory sai carimbado no recibo')
  assert.match(RELEASE_DONE_BOX_ADVISORY, /instalável/u)

  const caixaConfirmada = releaseDoneDecision({
    version: version({ status: 'lancada' }),
    publishRequired: true,
    boxConfirmed: true
  })
  assert.equal(caixaConfirmada.ok, true)
  assert.equal(caixaConfirmada.advisory, undefined, 'caixa provada não carimba nada')
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

test('o catálogo: papel gui-release com as TRÊS tools, pré-sancionadas', async () => {
  const delegate = await source('src/main/guiDelegateMcp.ts')
  assert.match(delegate, /'release'/u)
  assert.match(delegate, /mcp__synkora__release_status/u)
  assert.match(delegate, /mcp__synkora__release_run/u)
  // R38: sem a pré-sanção, o FECHO levantaria card de permissão exatamente no
  // instante em que o agente diz "terminei" — o pior lugar para travar.
  assert.match(delegate, /mcp__synkora__release_done/u)
  const server = await source('src/main/mcpServer.ts')
  assert.match(server, /identity\.role === 'gui-release'/u)
  assert.match(server, /'release_status'/u)
  assert.match(server, /'release_run'/u)
  assert.match(server, /'release_done'/u)
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
test('a reconciliação de boot preserva a missão para terminar a entrega explicitamente', async () => {
  const index = await source('src/main/index.ts')
  const recover = index.slice(index.indexOf('function recoverVersionReleaseIntents'))
  const block = recover.slice(0, recover.indexOf('async function releaseVersionImpl'))
  assert.match(
    block,
    /release_done/u,
    'a recuperação deixa o fecho explícito disponível'
  )
  assert.doesNotMatch(
    block,
    /missions\.update\(m\.id, \{ status: 'concluida' \}\)/u,
    'uma subida provada não atesta a entrega'
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

// R27F2 ONDA 1 — O FECHO AVISA A TELA (bug do dono, 2026-08-22): a missão de
// release concluía no DISCO e a aba ficava aberta até o restart. A tela só
// recarrega missões pelo push `missions:changed` — e o caminho do release
// (fecho do release_run e reconciliação release↔versão) mudava missão sem
// empurrá-lo (emitBacklogChanged é VERSÕES; syncBoard é ARQUIVO). Régua nova:
// todo mutador de missão fora do missionEngine empurra missions:changed.
test('R27F2 — o fecho do release e a reconciliação empurram missions:changed', async () => {
  const index = await source('src/main/index.ts')

  // R38: a MESMA plumbing, com o gatilho novo — era a ascensão, agora é o
  // release_done do agente. A régua ("todo mutador de missão fora do
  // missionEngine empurra missions:changed") viajou junto, inteira.
  const conclude = index.slice(index.indexOf('releaseDone: (id) =>'))
  assert.match(
    conclude.slice(0, 2600),
    /missions:changed/u,
    'o fecho do agente avisa a tela — sem isso a aba fica até o restart'
  )
  assert.match(conclude.slice(0, 2600), /syncBoard\(mission\.projectId\)/u)
  assert.match(conclude.slice(0, 2600), /emitBacklogChanged\(mission\.projectId\)/u)

  const reconcile = index.slice(index.indexOf('// Recovery proves the ascent'))
  assert.match(
    reconcile.slice(0, 900),
    /missions:changed/u,
    'a reconciliação release↔versão avisa a tela pela MESMA régua'
  )
})

// R27F2 ONDA 4 — A VARREDURA DE BECOS (2026-08-22): nenhuma ponta do ciclo
// termina sem desfecho visível ou receita, e nenhum fecho depende de UM push
// entregue (doutrina: durável com recibo OU re-derivável por reconciliador).

test('a leitura de missões preserva a release ativa entre sessões', async () => {
  const engine = await source('src/main/missionEngine.ts')
  const read = engine.slice(engine.indexOf('function missionsWithIntegration'))
  const block = read.slice(0, read.indexOf('\n  /**'))
  assert.match(block, /release_done/u, 'o fecho tem um verbo explícito')
  assert.doesNotMatch(block, /missions\.update/u, 'uma leitura não conclui a entrega')
})

// R38 — A REDE FICA, MAS PARA DE PESCAR CONVERSA VIVA. A cura da R27F2 rodava
// no caminho de LEITURA e concluía a missão de release da versão já lançada
// mesmo com o agente vivo no meio da caixa: o card sumia (R30) e o dono perdia
// o chat. Lei da casa preservada — registro atrasado não fica eternamente
// "rodando" —, escopo estreitado: só ÓRFÃO (sem chat vivo) é curado.
test('a ausência de um pane vivo não é evidência de release concluída', async () => {
  const engine = await source('src/main/missionEngine.ts')
  const read = engine.slice(engine.indexOf('function missionsWithIntegration'))
  const block = read.slice(0, read.indexOf('\n  /**'))
  assert.doesNotMatch(block, /paneAlive\(/u, 'presença de processo não decide o ciclo da release')
  assert.doesNotMatch(block, /status: 'concluida'/u, 'a leitura não encerra a conversa')
  assert.match(
    engine,
    /paneAlive\(paneId: string\): boolean/u,
    'a sonda é DEP INJETADA (o motor não fala com o registro de sessões)'
  )

  const index = await source('src/main/index.ts')
  const wiring = index.slice(index.indexOf('const missionEngine = createMissionEngine'))
  assert.match(
    wiring.slice(0, 1400),
    /paneAlive: \(paneId\) => guiSessions\?\.has\(paneId\) === true/u,
    'o index liga a sonda ao registro REAL dos chats'
  )
})

// O BOOT É OUTRO CASO, e ele foi VERIFICADO em vez de presumido: a
// reconciliação de release roda no laço de projetos do whenReady, ANTES de
// `guiSessions = registerGuiIpc(...)` — o registro de conversas nem existe
// ainda e o Map dele nasce vazio a cada boot. Lá, todo release é órfão por
// construção, e a rede continua sendo a única saída.
test('a recuperação de BOOT preserva a conversa antes de carregar o registro de chats', async () => {
  const index = await source('src/main/index.ts')
  const recover = index.slice(index.indexOf('function recoverVersionReleaseIntents'))
  const block = recover.slice(0, recover.indexOf('async function releaseVersionImpl'))
  assert.match(block, /Recovery proves the ascent/u, 'o boot distingue subida de entrega')
  assert.match(block, /release_done/u, 'o fecho continua disponível depois da recuperação')
  // A CHAMADA, não a menção: o comentário acima cita `registerGuiIpc(...)`.
  assert.ok(
    index.indexOf('recoverVersionReleaseIntents(p.id)') <
      index.indexOf('guiSessions = registerGuiIpc(ctx'),
    'a ordem real do boot é a prova — reconciliação primeiro, registro de chats depois'
  )
})

test('R27F2 — toda recusa do motor de release carrega a receita', async () => {
  const index = await source('src/main/index.ts')
  const impl = index.slice(index.indexOf('async function releaseVersionImpl'))
  const implBody = impl.slice(0, impl.indexOf('function sweepProjectFiles'))
  // As receitas, uma por trava — regressão em qualquer uma vira beco de agente.
  assert.match(implBody, /deixe a fila terminar/u, 'fila de integração ensina a espera')
  assert.match(implBody, /integre \(ou arquive\)/u, 'missão pendente ensina os dois verbos')
  assert.match(implBody, /faça \(vire missão\) ou exclua/u, 'backlog aberto ensina os dois verbos')
  assert.match(implBody, /await recoverVersionReleaseIntents\(version.projectId, version.id\)/u, 'journal pendente retoma a própria tentativa sob a trava da release')
  assert.match(implBody, /Repare a identidade/u, 'isolamento inválido ensina o reparo')
  assert.match(implBody, /Finalize e valide/u, 'worktree sujo ensina o fecho')
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
  assert.match(codeOnly, /PUBLICAÇÃO: nenhum script `release`/u, 'ausência do script não exclui deploy por integração Git')
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

// R38 — A PERSONA E A MECÂNICA DIZEM A MESMA COISA. A R29 já mandava não
// terminar sem a caixa enquanto o release_run concluía a missão sozinho; a
// mecânica ganhava. Agora a regra do fecho está escrita na voz do contrato.
test('R38 — a persona: a ascensão fecha NADA, e o release_done é do agente', () => {
  const prompt = guiReleaseSystemPrompt()
  assert.match(prompt, /THE CLOSE IS YOURS/u, 'a regra do fecho tem nome, como THE BOX')
  assert.match(prompt, /release_done/u)
  assert.match(prompt, /ascent closes NOTHING/u, 'a subida não é o fim — dito em voz alta')
  assert.match(
    prompt,
    /RELEASE PROCESS:/u,
    'o inventário do papel acompanha o catálogo real'
  )
  for (const tool of ['release_missions', 'release_mission_update', 'release_mission_remove', 'list_plans', 'get_plan']) {
    assert.ok(prompt.includes(tool), `a Release precisa conhecer ${tool}`)
  }
  assert.match(
    prompt,
    /that work happens HERE/u,
    'pedido novo depois da ascensão é feito NESTA conversa, na pasta do projeto'
  )
  assert.doesNotMatch(
    prompt,
    /never call the release done without the box/u,
    'a frase antiga não nomeava a ferramenta do fecho'
  )
})

test('R38 — a descrição do release_done ENSINA quando fechar (e que fechar é definitivo)', async () => {
  const server = await source('src/main/mcpServer.ts')
  const at = server.indexOf("'release_done'")
  assert.ok(at > 0, 'a tool do fecho existe no catálogo do gui-release')
  const description = server.slice(at, at + 1600)
  assert.match(description, /CAIXA/u, 'a caixa entra no "tudo que o dono pediu"')
  assert.match(description, /release_run/u, 'a recusa nomeia a receita')
  assert.match(description, /NÃO fecha nada/u, 'e desfaz a expectativa velha da subida')
  assert.match(description, /tira o card da coluna/u, 'fechar é definitivo, e isso é dito antes')
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
