import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// ————— R39: A FALA DO DONO PARA O TURNO —————
//
// Design vinculante: `.synkora/reports/DESIGN_FALA_DO_DONO_PARA_O_TURNO_2026-09-02.md`.
// O CASO MEDIDO (missão 86a05c06/d13f0a00, 01/09 21:30–21:40): três falas do
// dono entraram no pote enquanto o agente estava em tools NATIVAS (que não
// carregam a carona) e só chegaram 3 min depois, de carona num `delegate`;
// entregues, o modelo tentou SEIS tools recusadas pela dívida e só falou às
// 21:38:45 — OITO minutos da primeira mensagem à resposta. A única posição que
// o modelo obedece é a ÚLTIMA mensagem de usuário de um turno NOVO: então a
// fala PARA o turno e volta como turno novo, com envelope de retomada.
//
// Esta suíte mede as duas peças PURAS: o pote com a marca `handoff`
// (guiOwnerMail) e a régua da rota + o rastreio do último passo (guiOwnerSteer).
// As duas entram pela porta TOLERANTE — módulo ausente derruba só os testes da
// peça que falta, e cada um deles diz o que falta.

const mailModule = await import('../.tmp/gui-owner-mail-test/guiOwnerMail.js').catch(() => ({}))
const steerModule = await import('../.tmp/gui-owner-mail-test/guiOwnerSteer.js').catch(() => ({}))

function mailbox() {
  assert.ok(
    mailModule.GuiOwnerMailbox,
    'o módulo do pote do dono (guiOwnerMail) não existe — sem ele a fala do dono não tem onde esperar'
  )
  return new mailModule.GuiOwnerMailbox()
}

function handText(entries, lastStep) {
  assert.ok(
    mailModule.guiOwnerHandText,
    'falta `guiOwnerHandText` (D3): sem o ENVELOPE DE RETOMADA o agente volta sem saber que foi PARADO nem o que ficou pela metade'
  )
  return mailModule.guiOwnerHandText(entries, lastStep)
}

function plan(input) {
  assert.ok(
    steerModule.ownerSteerPlan,
    'falta o módulo da rota (guiOwnerSteer.ownerSteerPlan) — a régua de D1/D5 mora nele, fora do guiSessions de 3707 linhas'
  )
  return steerModule.ownerSteerPlan(input)
}

const baseInput = {
  alive: true,
  turnActive: false,
  isSlash: false,
  hasPendingBriefing: false,
  pendingInteraction: null,
  text: 'para tudo: o schema mudou'
}

// ————— o pote ganha a MARCA (D1.b / D2) —————

test('D1 — o pote guarda a fala MARCADA de handoff, e a marca sobrevive ao peek', () => {
  const mail = mailbox()
  assert.equal(
    mail.post('p1', { messageId: 'm-1', text: 'para tudo', at: 1, handoff: true }),
    true
  )
  assert.equal(mail.count('p1'), 1)
  assert.equal(
    mail.peek('p1')[0].handoff,
    true,
    'sem a marca, a carona levaria a fala DENTRO do turno que está sendo cortado'
  )
})

test('D2 — a CARONA não drena correio de handoff: `skipHandoff` deixa a marca no pote', () => {
  const mail = mailbox()
  mail.post('p1', { messageId: 'm-1', text: 'fala de carona', at: 1 })
  mail.post('p1', { messageId: 'm-2', text: 'fala que parou o turno', at: 2, handoff: true })

  const ride = mail.drain('p1', { skipHandoff: true })
  assert.deepEqual(
    ride.map((entry) => entry.messageId),
    ['m-1'],
    'a carona só pode levar o correio SEM marca — a fala de handoff pertence ao turno novo'
  )
  assert.equal(mail.count('p1'), 1, 'a fala marcada tem de continuar no pote esperando o fecho')
  assert.equal(mail.peek('p1')[0].messageId, 'm-2')
})

test('D2 — `handoffOnly` leva só a marcada, na ordem em que o dono falou', () => {
  const mail = mailbox()
  mail.post('p1', { messageId: 'm-1', text: 'sem marca', at: 1 })
  mail.post('p1', { messageId: 'm-2', text: 'primeira parada', at: 2, handoff: true })
  mail.post('p1', { messageId: 'm-3', text: 'segunda parada', at: 3, handoff: true })

  const hand = mail.drain('p1', { handoffOnly: true })
  assert.deepEqual(
    hand.map((entry) => entry.messageId),
    ['m-2', 'm-3'],
    'a segunda fala corrige a primeira: embaralhar inverteria a ordem do dono'
  )
  assert.equal(mail.count('p1'), 1)
})

test('D2 — `drain` sem opção continua levando TUDO (o contrato de hoje não muda)', () => {
  const mail = mailbox()
  mail.post('p1', { messageId: 'm-1', text: 'sem marca', at: 1 })
  mail.post('p1', { messageId: 'm-2', text: 'com marca', at: 2, handoff: true })
  assert.equal(mail.drain('p1').length, 2)
  assert.equal(mail.count('p1'), 0)
})

test('D1 — a marca atravessa o DISCO: o app que morre no meio da parada não perde o envelope', () => {
  assert.ok(mailModule.createGuiOwnerMailStore, 'o pote do dono não tem disco')
  const dir = mkdtempSync(join(tmpdir(), 'synkora-owner-hand-'))
  const file = join(dir, mailModule.GUI_OWNER_MAIL_STORE_FILE)
  try {
    const antes = new mailModule.GuiOwnerMailbox()
    antes.attachStore(mailModule.createGuiOwnerMailStore(file))
    antes.post('p1', { messageId: 'm-1', text: 'volta e me responde', at: Date.now(), handoff: true })

    const depois = new mailModule.GuiOwnerMailbox()
    depois.attachStore(mailModule.createGuiOwnerMailStore(file))
    assert.equal(depois.count('p1'), 1, 'a fala não sobreviveu ao fechamento do app')
    assert.equal(
      depois.peek('p1')[0].handoff,
      true,
      'sem a marca no disco, o renascimento entregaria a fala CRUA — sem dizer que ele foi parado'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ————— o ENVELOPE DE RETOMADA (D3) —————

test('D3 — o envelope diz que ele foi PARADO, nomeia o passo cortado e pede resposta antes da retomada', () => {
  const text = handText(
    [{ messageId: 'm-1', text: 'para tudo: o schema mudou', at: 1, handoff: true }],
    'Bash — npm run test:gui-sessions'
  )
  assert.match(text, /MENSAGEM DO DONO/u)
  assert.match(
    text,
    /você foi PARADO para lê-la/u,
    'sem isto o modelo lê a fala como interrupção misteriosa e volta a fazer o que fazia'
  )
  assert.match(text, /para tudo: o schema mudou/u, 'a fala do dono viaja VERBATIM')
  assert.match(text, /Você estava em: Bash — npm run test:gui-sessions/u)
  assert.match(
    text,
    /NÃO terminou/u,
    'a tool em voo foi cortada: dizer o contrário faria o modelo confiar num resultado que não existe'
  )
  assert.match(text, /re-cheque/u)
  assert.match(text, /Responda PRIMEIRO/u)
  assert.match(text, /1–2 linhas/u)
  assert.match(text, /retome/u, 'a ordem do dono é responder E retomar — não trocar de assunto')
})

test('D3 — sem tool em voo o envelope diz "pensando" e NÃO inventa tool cortada', () => {
  const text = handText([{ messageId: 'm-1', text: 'muda o rumo', at: 1, handoff: true }], null)
  assert.match(text, /Você estava em: pensando/u)
  assert.doesNotMatch(
    text,
    /A tool em voo/u,
    'reivindicar uma tool que não existia é mentira de harness'
  )
  assert.match(text, /Responda PRIMEIRO/u)
})

test('D3 — várias falas viajam NUMERADAS, na ordem, numa entrega só', () => {
  const text = handText(
    [
      { messageId: 'm-1', text: 'primeira', at: 1, handoff: true },
      { messageId: 'm-2', text: 'segunda', at: 2, handoff: true },
      { messageId: 'm-3', text: 'terceira', at: 3, handoff: true }
    ],
    null
  )
  assert.match(text, /1\. "primeira"/u)
  assert.match(text, /2\. "segunda"/u)
  assert.match(text, /3\. "terceira"/u)
  assert.ok(
    text.indexOf('primeira') < text.indexOf('segunda') &&
      text.indexOf('segunda') < text.indexOf('terceira'),
    'a ordem em que ele falou é a ordem em que o agente tem de ler'
  )
})

// ————— a RÉGUA DA ROTA (D1/D5) —————

test("D1/D1' — turno ABERTO e fala comum: a fala ENTRA no turno, em QUALQUER pane", () => {
  // A R39 parava o turno aqui; a R39.1 steera. A cerca da R22 continua caída: a
  // rota vale para pane delegador ou não, e para os dois CLIs.
  const decision = plan({ ...baseInput, turnActive: true })
  assert.equal(decision.route, 'steer')
  assert.match(decision.reason, /turno/u, 'a razão tem de nomear o que decidiu a rota')
})

test('D1 — sem turno aberto nada muda: a fala vai pelo caminho de sempre', () => {
  assert.equal(plan({ ...baseInput, turnActive: false }).route, 'stdin')
})

test('R31.2 — comando do CLI continua sendo EXECUTADO pelo binário, nunca citado', () => {
  const decision = plan({ ...baseInput, turnActive: true, isSlash: true, text: '/compact' })
  assert.equal(decision.route, 'slash-queue')
})

test('D1 — briefing pendente segue pelo caminho de PROMPT (contrato de missão não é citação)', () => {
  assert.equal(
    plan({ ...baseInput, turnActive: true, hasPendingBriefing: true }).route,
    'stdin'
  )
})

test('D1 — fala grande demais para o pote NÃO para o turno: parar sem ter onde guardar seria perdê-la', () => {
  assert.ok(mailModule.GUI_OWNER_MAIL_MAX_CHARS, 'o pote precisa expor o teto por mensagem')
  const decision = plan({
    ...baseInput,
    turnActive: true,
    text: 'x'.repeat(mailModule.GUI_OWNER_MAIL_MAX_CHARS + 1)
  })
  assert.equal(decision.route, 'stdin')
})

test('D5 — pergunta aberta: o CLI está PARADO esperando o dono, e a fala dele vira a RESPOSTA', () => {
  const decision = plan({
    ...baseInput,
    turnActive: true,
    pendingInteraction: { kind: 'question', requestId: 'req-1', question: 'Qual caminho?' }
  })
  assert.equal(decision.route, 'answer-question')
  assert.equal(decision.requestId, 'req-1', 'a rota tem de dizer QUAL pergunta ela responde')
})

test('D5 — permissão/plano em aberto: nada a interromper, a fala ESPERA no pote', () => {
  for (const kind of ['permission', 'plan-review']) {
    const decision = plan({
      ...baseInput,
      turnActive: true,
      pendingInteraction: { kind, requestId: 'req-2' }
    })
    assert.equal(
      decision.route,
      'hold',
      `com ${kind} em aberto o CLI está parado esperando o dono: interromper arriscaria derrubar o processo na escalada de 10s`
    )
  }
})

test('D1 — sessão morta nunca é rota de parada', () => {
  assert.equal(plan({ ...baseInput, alive: false, turnActive: true }).route, 'stdin')
})

// ————— o RASTREIO DO ÚLTIMO PASSO (D3) —————

function tracker() {
  assert.ok(
    steerModule.GuiOwnerStepTracker,
    'falta o rastreio do último passo (guiOwnerSteer.GuiOwnerStepTracker) — sem ele o envelope não sabe o que foi cortado'
  )
  return new steerModule.GuiOwnerStepTracker()
}

test('D3 — o rastreio nomeia a tool em voo com nome + começo do input', () => {
  const steps = tracker()
  steps.noteTool('p1', 'Bash', { command: 'npm run test:gui-sessions' })
  const step = steps.lastStepOf('p1')
  assert.match(step, /^Bash — /u)
  assert.match(step, /npm run test:gui-sessions/u)
  assert.ok(step.length <= 100, 'o envelope é curto: o input entra capado')
})

test('D3 — input longo entra CAPADO (o envelope viaja dentro de um turno caro)', () => {
  const steps = tracker()
  steps.noteTool('p1', 'Write', { content: 'y'.repeat(500) })
  const step = steps.lastStepOf('p1')
  assert.ok(step.length < 120, `o passo veio inteiro (${step.length} chars)`)
  assert.match(step, /…/u, 'o corte tem de aparecer')
})

test('D3 — tool que VOLTOU não é mais "tool em voo": o passo vira pensando', () => {
  const steps = tracker()
  steps.noteTool('p1', 'Bash', { command: 'npm test' })
  steps.noteToolResult('p1')
  assert.equal(
    steps.lastStepOf('p1'),
    null,
    'a tool já tinha voltado — dizer que ela foi cortada seria mentir para o modelo'
  )
})

test('D3 — só pensando (nenhuma tool) devolve passo nenhum', () => {
  const steps = tracker()
  steps.noteThinking('p1')
  assert.equal(steps.lastStepOf('p1'), null)
})

test('D3 — o fecho do turno esquece o passo: o próximo envelope não fala do turno passado', () => {
  const steps = tracker()
  steps.noteTool('p1', 'Read', { file_path: '/w/a.ts' })
  steps.noteResult('p1')
  assert.equal(steps.lastStepOf('p1'), null)
})

test('D6 — o rastreio guarda os ids ENTREGUES até o agente falar (o carimbo "respondida")', () => {
  const steps = tracker()
  steps.noteDelivered('p1', ['m-1', 'm-2'])
  assert.deepEqual(steps.takeDelivered('p1'), ['m-1', 'm-2'])
  assert.deepEqual(steps.takeDelivered('p1'), [], 'a mesma entrega não vira duas respostas')
})

// ————— R39.1: A FALA SEM PARAR + O RECIBO DE LEITURA + O "LER AGORA" —————
//
// Decisão do dono (02/09, depois de ver bônus e ônus da R39): "pode ser sem
// parar, puro. Aí minha mensagem vai ficar lá. Só que eu quero que tenha alguma
// coisa, tipo que ela não foi lida ainda… E se eu quiser eu posso forçar, aí
// forçando ele para o turno e lê o que eu quero falar, quando for algo
// urgente."
//
// O medo dele é o CUSTO do corte (raciocínio e tool em voo jogados fora), não a
// frota — que nunca parou (D1.c). Então o padrão passa a ser STEER: a fala vai
// AGORA ao CLI e uma cópia espera no pote, MARCADA `steered`, até o RECIBO DE
// LEITURA. As sondas de 02/09 (`PROBE_STEER_RECEIPT_2026-09-02.md`) provaram o
// recibo nos dois motores: no claude é `command_lifecycle{state:'started'}` do
// uuid que a casa carimba (3,3 s do envio, medido); no codex é o `item/started`
// de `userMessage` com o nosso `clientId` (16,5 s, medido).

test("D1' — com turno aberto a rota é STEER (não parar), e `stop-and-hand` só com FORCE", () => {
  assert.equal(
    plan({ ...baseInput, turnActive: true }).route,
    'steer',
    'o padrão do dono é SEM PARAR: cortar joga fora raciocínio e tool em voo'
  )
  assert.equal(
    plan({ ...baseInput, turnActive: true, force: true }).route,
    'stop-and-hand',
    'só o gesto "ler agora" volta a PARAR o turno'
  )
  assert.equal(
    plan({ ...baseInput, turnActive: false, force: true }).route,
    'stdin',
    'sem turno não há o que cortar — forçar ali seria interromper o nada'
  )
})

test("D1' — as cercas antigas ganham do steer: slash, briefing, pergunta e pedido parado", () => {
  assert.equal(plan({ ...baseInput, turnActive: true, isSlash: true }).route, 'slash-queue')
  assert.equal(plan({ ...baseInput, turnActive: true, hasPendingBriefing: true }).route, 'stdin')
  assert.equal(
    plan({
      ...baseInput,
      turnActive: true,
      pendingInteraction: { kind: 'question', requestId: 'r1', question: 'Qual caminho?' }
    }).route,
    'answer-question'
  )
  assert.equal(
    plan({
      ...baseInput,
      turnActive: true,
      pendingInteraction: { kind: 'permission', requestId: 'r2' }
    }).route,
    'hold'
  )
})

test("D1' — fala grande demais para o pote continua indo pelo caminho de sempre", () => {
  const huge = 'x'.repeat(mailModule.GUI_OWNER_MAIL_MAX_CHARS + 1)
  assert.equal(plan({ ...baseInput, turnActive: true, text: huge }).route, 'stdin')
})

test("D1'/D3' — o pote guarda a marca `steered`, e ela SOBREVIVE ao disco", () => {
  const box = mailbox()
  assert.equal(box.post('p1', { messageId: 'm-1', text: 'olha isto', at: 1, steered: true }), true)
  assert.equal(box.peek('p1')[0].steered, true, 'sem a marca a cópia viraria correio comum')

  const dir = mkdtempSync(join(tmpdir(), 'synkora-owner-steered-'))
  try {
    const file = join(dir, 'gui-owner-mail.json')
    const alive = new mailModule.GuiOwnerMailbox({
      store: mailModule.createGuiOwnerMailStore(file)
    })
    alive.post('p1', { messageId: 'm-1', text: 'olha isto', at: Date.now(), steered: true })
    const reborn = new mailModule.GuiOwnerMailbox({
      store: mailModule.createGuiOwnerMailStore(file)
    })
    assert.equal(reborn.peek('p1')[0].steered, true, 'o app que morre não pode perder a marca')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("D3' — `skipSteered` deixa a cópia no pote (o fecho de turno NÃO a entrega)", () => {
  const box = mailbox()
  box.post('p1', { messageId: 'm-1', text: 'a que foi steerada', at: 1, steered: true })
  box.post('p1', { messageId: 'm-2', text: 'correio comum', at: 2 })

  const taken = box.drain('p1', { skipSteered: true })
  assert.deepEqual(
    taken.map((e) => e.messageId),
    ['m-2']
  )
  assert.deepEqual(
    box.peek('p1').map((e) => e.messageId),
    ['m-1'],
    'a fala que já está no CLI não pode ser entregue de novo pelo fecho'
  )
})

test("D3' — o flush de REABERTURA (sem opção) leva a steerada: entrega única, nunca perda", () => {
  const box = mailbox()
  box.post('p1', { messageId: 'm-1', text: 'a que ficou sem recibo', at: 1, steered: true })
  assert.deepEqual(
    box.drain('p1').map((e) => e.messageId),
    ['m-1'],
    'processo que morreu com a fala dentro tem de entregá-la no nascimento'
  )
})

test("D2' — `removeById` tira SÓ a fala do recibo, e devolve a entrada que saiu", () => {
  const box = mailbox()
  box.post('p1', { messageId: 'm-1', text: 'primeira', at: 1, steered: true })
  box.post('p1', { messageId: 'm-2', text: 'segunda', at: 2, steered: true })

  const gone = box.removeById('p1', 'm-1')
  assert.equal(gone?.text, 'primeira')
  assert.deepEqual(
    box.peek('p1').map((e) => e.messageId),
    ['m-2']
  )
  assert.equal(box.removeById('p1', 'm-1'), null, 'recibo repetido não pode apagar outra fala')
  assert.equal(box.removeById('p1', 'nao-existe'), null)
})

test("D4' — o envelope CURTO do \"ler agora\" diz o corte, o passo e a ordem de responder", () => {
  assert.ok(
    mailModule.guiOwnerForceText,
    "falta `guiOwnerForceText` (D4'.a): sem ele o turno novo nasce sem saber que o dono FORÇOU a leitura"
  )
  const text = mailModule.guiOwnerForceText('Bash — npm run test:gui-system')
  assert.match(text, /FORÇOU/u, 'o modelo tem de saber que o corte foi um gesto do dono')
  assert.match(text, /Você estava em: Bash — npm run test:gui-system/u)
  assert.match(text, /NÃO terminou/u, 'a tool em voo foi cortada: re-checar antes de confiar')
  assert.match(text, /Responda PRIMEIRO/u)
  assert.ok(text.length < 700, `o envelope de retomada é curto por obrigação (${text.length})`)

  const thinking = mailModule.guiOwnerForceText(null)
  assert.match(thinking, /pensando/u)
  assert.doesNotMatch(
    thinking,
    /tool em voo NÃO terminou/u,
    'sem tool cortada, nada de inventar corte'
  )
})

test("D2' — o rastreio guarda a fala STEERADA até o recibo, e o recibo a leva UMA vez", () => {
  const steps = tracker()
  assert.ok(
    typeof steps.noteSteered === 'function',
    'falta `noteSteered` no rastreio: sem ele a dívida não sabe QUANDO armar'
  )
  steps.noteSteered('p1', 'm-1', 1_000)
  steps.noteSteered('p1', 'm-2', 1_200)
  assert.deepEqual(
    steps.pendingSteered('p1').map((e) => e.messageId),
    ['m-1', 'm-2']
  )

  const read = steps.takeRead('p1', 'm-1')
  assert.deepEqual(
    read.map((e) => e.messageId),
    ['m-1']
  )
  assert.equal(read[0].at, 1_000, 'o instante do envio é o que mede o msSinceSend do diário')
  assert.deepEqual(steps.takeRead('p1', 'm-1'), [], 'o mesmo recibo nunca arma a dívida duas vezes')

  // Sem id: o recibo aproximado (`approx`) leva o que estiver esperando.
  assert.deepEqual(
    steps.takeRead('p1').map((e) => e.messageId),
    ['m-2']
  )
})

test("D2' — o rastreio esquece as steeradas quando a conversa acaba", () => {
  const steps = tracker()
  steps.noteSteered('p1', 'm-1', 1)
  steps.forget('p1')
  assert.deepEqual(steps.pendingSteered('p1'), [])
})
