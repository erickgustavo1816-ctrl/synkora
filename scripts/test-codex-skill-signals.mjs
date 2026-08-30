import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexSession } from '../.tmp/codex-skill-signals-test/codexSession.js'
import {
  codexSkillSignals,
  codexSkillsRoot,
  skillNameUnderSkillsRoot
} from '../.tmp/codex-skill-signals-test/codexSkillSignals.js'
import { GuiCodexAgentRegistry } from '../.tmp/codex-skill-signals-test/guiCodexAgents.js'

// O USO DE SKILL NO CODEX — as duas superfícies que a sonda de 2026-08-30 mediu
// (`.synkora/reports/PROBE_SKILL_USE_2026-08-30.md`, capturas cruas em
// `.tmp/probe-skill-use/codex-frames.jsonl`). O codex-cli 0.151.0 NÃO tem item
// de skill: as 19 variantes de `ThreadItem` do próprio schema do binário não
// incluem nenhuma. Sobram duas formas TIPADAS, e é só delas que o chip nasce:
//
//   (a) FORTE  — `userMessage` com `content[] {type:'skill', name, path}`;
//   (b) BEST-EFFORT — `commandExecution` com `commandActions[] {type:'read',
//       path}` cujo caminho cai em `<cwd>/.agents/skills/<nome>/SKILL.md`, a
//       pasta que o PRÓPRIO sync do Synkora escreveu.
//
// Os frames abaixo são CÓPIA LITERAL da captura (nada reescrito à mão): é o que
// impede a suíte de provar um protocolo que só existe na nossa cabeça.
//
// Nada aqui casa TEXTO — nem a string crua do comando, nem a saída do modelo.
// Se o campo tipado sumir num update do CLI, o chip some e a suíte fica
// vermelha; heurística sobre conteúdo é proibida nesta casa.

/** O cwd REAL da sonda — a raiz contra a qual o `file-read` é comparado. */
const PROBE_CWD = 'C:\\Users\\Erick\\AppData\\Local\\Temp\\synkora-probe-skill-use\\codex'
const PROBE_SKILL_PATH =
  'C:\\Users\\Erick\\AppData\\Local\\Temp\\synkora-probe-skill-use\\codex\\.agents\\skills\\synkprobe-usemark\\SKILL.md'
const THREAD = '01a053f4-2cb6-7171-bd52-2f86c0920bea'

/** Frame LITERAL da captura (linha de `item/started`, cenário 2a): o modelo
 *  decidiu sozinho abrir o corpo da skill pelo shell. */
function commandExecutionFrame(overrides = {}) {
  return {
    type: 'commandExecution',
    id: 'call_7fwArFdK0BI5jXRVAsdiuaEQ',
    pluginId: null,
    scriptPath: null,
    command:
      '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Get-Content -Raw \'C:\\\\Users\\\\Erick\\\\AppData\\\\Local\\\\Temp\\\\synkora-probe-skill-use\\\\codex\\\\.agents\\\\skills\\\\synkprobe-usemark\\\\SKILL.md\'"',
    cwd: PROBE_CWD,
    processId: '60381',
    source: 'unifiedExecStartup',
    status: 'inProgress',
    commandActions: [
      {
        type: 'read',
        command: `Get-Content -Raw '${PROBE_SKILL_PATH}'`,
        name: 'SKILL.md',
        path: PROBE_SKILL_PATH
      }
    ],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
    ...overrides
  }
}

/** Frame LITERAL da captura (cenário 2b): a entrada tipada `SkillUserInput`
 *  volta ECOADA no `userMessage`, com nome E caminho. */
function userMessageFrame() {
  return {
    type: 'userMessage',
    id: '01a053f4-648e-79d0-8b07-c34c5727a5b4',
    clientId: null,
    content: [
      { type: 'skill', name: 'synkprobe-usemark', path: PROBE_SKILL_PATH },
      { type: 'text', text: 'Follow it exactly.', text_elements: [] }
    ]
  }
}

/** Sessão de mentira para o ingest de notificações: sem processo, sem RPC, sem
 *  timer — o mesmo molde da suíte de colaboração. */
function ingestSession({ cwd = PROBE_CWD } = {}) {
  const session = Object.create(CodexSession.prototype)
  const events = []
  const recorded = []
  session.opts = {
    cwd,
    recordSkillEntered: (detail) => recorded.push(detail)
  }
  session.emit = (event) => events.push(event)
  session.killed = false
  session.closed = false
  session.child = { exitCode: 0, signalCode: null }
  session.threadId = THREAD
  session.turnId = 'turn-root'
  session.pendingTurnStart = null
  session.pendingSendOperations = new Set()
  session.terminalReconcilePending = false
  session.activeCollabParentIds = new Set()
  session.collabParentByThreadId = new Map()
  session.startedCollabToolIds = new Set()
  session.deferredCollabResult = null
  session.codexAgents = new GuiCodexAgentRegistry()
  session.skillsEntered = new Set()
  session.approvals = new Map()
  session.pending = new Map()
  session.idleTimer = null
  session.turnSilenceTimer = null
  session.turnStartTimer = null
  session.interruptTimer = null
  session.interruptedTurnId = null
  session.turnErrorTimer = null
  return {
    session,
    events,
    recorded,
    skills: () => events.filter((event) => event.type === 'tool' && event.name === 'Skill'),
    note: (method, item) => session.handleNotification(method, { threadId: THREAD, item })
  }
}

// ————— o casamento de caminho: campo tipado contra pasta CONHECIDA —————

test('a raiz de skills do codex sai do cwd do pane, na pasta que o sync escreveu', () => {
  assert.equal(codexSkillsRoot(PROBE_CWD), `${PROBE_CWD}\\.agents\\skills`)
})

test('só <raiz>/<nome>/SKILL.md vira nome de skill — o resto é leitura comum', () => {
  const root = codexSkillsRoot(PROBE_CWD)
  assert.equal(skillNameUnderSkillsRoot(PROBE_SKILL_PATH, root), 'synkprobe-usemark')
  // O MESMO arquivo fora da raiz sincronizada não é skill deste pane.
  assert.equal(
    skillNameUnderSkillsRoot(`${PROBE_CWD}\\src\\SKILL.md`, root),
    undefined,
    'SKILL.md solto na árvore não é uso de skill'
  )
  assert.equal(
    skillNameUnderSkillsRoot(`${PROBE_CWD}\\.claude\\skills\\outra\\SKILL.md`, root),
    undefined,
    'a raiz do OUTRO CLI não fala pelo pane codex'
  )
  // Fundo demais e raso demais: a forma é exata, não é "começa com".
  assert.equal(skillNameUnderSkillsRoot(`${root}\\nome\\docs\\SKILL.md`, root), undefined)
  assert.equal(skillNameUnderSkillsRoot(`${root}\\SKILL.md`, root), undefined)
  assert.equal(skillNameUnderSkillsRoot(`${root}\\nome\\README.md`, root), undefined)
  // Travessia: `..` jamais vira nome de skill.
  assert.equal(skillNameUnderSkillsRoot(`${root}\\..\\SKILL.md`, root), undefined)
  // Windows não distingue caixa no caminho — o NOME sai como o disco o escreveu.
  assert.equal(
    skillNameUnderSkillsRoot(PROBE_SKILL_PATH.toUpperCase(), root),
    'SYNKPROBE-USEMARK'
  )
})

test('o sinal sai dos DOIS frames reais, com a fonte declarada', () => {
  const root = codexSkillsRoot(PROBE_CWD)
  assert.deepEqual(codexSkillSignals(userMessageFrame(), root), [
    { skill: 'synkprobe-usemark', source: 'input-echo' }
  ])
  assert.deepEqual(codexSkillSignals(commandExecutionFrame(), root), [
    { skill: 'synkprobe-usemark', source: 'file-read' }
  ])
  // Item sem nenhuma das duas formas não inventa sinal.
  assert.deepEqual(codexSkillSignals({ type: 'agentMessage', text: 'oi' }, root), [])
})

// ————— o enxerto no motor: o MESMO evento que o claude já produz —————

test('userMessage com content[] skill vira o evento Skill normalizado (2b)', () => {
  const ingest = ingestSession()
  ingest.note('item/started', userMessageFrame())
  const skills = ingest.skills()
  assert.equal(skills.length, 1, 'a entrada tipada nasce chip')
  assert.equal(skills[0].input.skill, 'synkprobe-usemark')
  assert.equal(typeof skills[0].toolUseId, 'string')
  assert.ok(skills[0].toolUseId, 'o card tem id próprio — nenhum resultado o confunde')
})

test('a entrada já nasce com recibo — o chip nunca vira ferramenta em voo', () => {
  const ingest = ingestSession()
  ingest.note('item/started', userMessageFrame())
  const chip = ingest.skills()[0]
  const recibo = ingest.events.find(
    (event) => event.type === 'tool-result' && event.toolUseId === chip.toolUseId
  )
  assert.ok(recibo, 'sem recibo a reconciliação do turno anunciaria uma órfã que não existe')
  assert.equal(recibo.isError, false)
  assert.equal(recibo.outcome, 'completed')
})

test('commandActions read de SKILL.md na raiz sincronizada vira o evento Skill (2a)', () => {
  const ingest = ingestSession()
  ingest.note('item/started', commandExecutionFrame())
  const skills = ingest.skills()
  assert.equal(skills.length, 1)
  assert.equal(skills[0].input.skill, 'synkprobe-usemark')
  // O card de comando continua exatamente como era: o chip é ACRÉSCIMO.
  const bash = ingest.events.filter((event) => event.type === 'tool' && event.name === 'Bash')
  assert.equal(bash.length, 1, 'a leitura continua aparecendo como comando')
  assert.notEqual(
    skills[0].toolUseId,
    bash[0].toolUseId,
    'ids distintos: id repetido impediria o comando de receber o resultado'
  )
})

// ————— a cerca do falso positivo: leitura comum NÃO é uso de skill —————

test('read de caminho alheio não produz chip nenhum', () => {
  const ingest = ingestSession()
  const alheio = `${PROBE_CWD}\\src\\main\\index.ts`
  ingest.note(
    'item/started',
    commandExecutionFrame({
      commandActions: [
        { type: 'read', command: `Get-Content -Raw '${alheio}'`, name: 'index.ts', path: alheio }
      ]
    })
  )
  assert.equal(ingest.skills().length, 0, 'ler um arquivo qualquer não entrou skill nenhuma')
  assert.equal(ingest.recorded.length, 0, 'e o diário não ganha linha por leitura comum')
  assert.equal(
    ingest.events.filter((event) => event.type === 'tool' && event.name === 'Bash').length,
    1,
    'o card de comando de sempre continua lá'
  )
})

test('ação tipada que não é leitura não vira chip, mesmo apontando para a raiz', () => {
  const ingest = ingestSession()
  ingest.note(
    'item/started',
    commandExecutionFrame({
      commandActions: [{ type: 'write', command: 'set-content', name: 'SKILL.md', path: PROBE_SKILL_PATH }]
    })
  )
  assert.equal(ingest.skills().length, 0, 'escrever na pasta do kit não é usar a skill')
})

test('cwd de outro pane não empresta a raiz — o casamento é contra a pasta DESTE chat', () => {
  const ingest = ingestSession({ cwd: 'C:\\outro\\worktree' })
  ingest.note('item/started', commandExecutionFrame())
  assert.equal(ingest.skills().length, 0)
})

// ————— o marcador é POR CONVERSA (veredito 3 da sonda) —————

test('started + completed do MESMO item entregam um chip só', () => {
  const ingest = ingestSession()
  const started = commandExecutionFrame()
  ingest.note('item/started', started)
  ingest.note(
    'item/completed',
    commandExecutionFrame({ status: 'completed', exitCode: 0, aggregatedOutput: 'corpo da skill' })
  )
  assert.equal(ingest.skills().length, 1, 'o eco do item/completed não duplica o chip')
})

test('a mesma skill relida na mesma sessão não repinta o chip', () => {
  const ingest = ingestSession()
  ingest.note('item/started', commandExecutionFrame())
  ingest.note('item/started', commandExecutionFrame({ id: 'call_outro' }))
  assert.equal(ingest.skills().length, 1, 'entrar duas vezes na mesma conversa é entrar uma vez')
})

test('duas skills diferentes na mesma conversa entram cada uma com o seu chip', () => {
  const ingest = ingestSession()
  ingest.note('item/started', commandExecutionFrame())
  const outra = `${PROBE_CWD}\\.agents\\skills\\outra-skill\\SKILL.md`
  ingest.note(
    'item/started',
    commandExecutionFrame({
      id: 'call_outra',
      commandActions: [
        { type: 'read', command: `Get-Content -Raw '${outra}'`, name: 'SKILL.md', path: outra }
      ]
    })
  )
  assert.deepEqual(
    ingest.skills().map((event) => event.input.skill),
    ['synkprobe-usemark', 'outra-skill']
  )
})

// ————— o diário: cada ENTRADA tem recibo —————

test('a entrada de skill vira linha de caixa-preta, uma vez, com cli e nome', () => {
  const ingest = ingestSession()
  ingest.note('item/started', userMessageFrame())
  ingest.note('item/completed', userMessageFrame())
  assert.equal(ingest.recorded.length, 1)
  assert.equal(ingest.recorded[0].cli, 'codex')
  assert.equal(ingest.recorded[0].skill, 'synkprobe-usemark')
  assert.equal(ingest.recorded[0].source, 'input-echo')
})

test('sessão sem recorder não quebra — o chip é o produto, o diário é acessório', () => {
  const ingest = ingestSession()
  delete ingest.session.opts.recordSkillEntered
  ingest.note('item/started', userMessageFrame())
  assert.equal(ingest.skills().length, 1)
})
