// SKILLS 2.0/3.0 — A CERCA DO MOTOR (prateleira, biblioteca, sync, download,
// harness da missão, poda).
//
// Contrato: `.synkora/reports/DESIGN_SKILLS_2_0_BUILD_2026-08-29.md` (§Gate) e
// `.synkora/reports/DESIGN_HARNESS_DO_MODELO_2026-09-08.md` (§5.B) + os ADRs
// 0002/0004/0007 e 0008/0009/0010. Módulos sob teste (compilados por `tsc` como
// as suítes irmãs, ver o script `test:skills-kit` no package.json):
//
//   src/main/skillsKit.ts          o DADO da prateleira do dono
//   src/main/skillsLibraryScan.ts  a lib do disco e o manifest.json
//   src/main/skillsInstall.ts      baixar pasta pinada (a única rede)
//   src/main/skillsPrune.ts        a poda por gesto explícito
//   src/main/skillsSync.ts         o transporte do kit para o worktree
//   src/main/skillsAgentSync.ts    o harness que o AGENTE monta no worktree
//   src/main/skillsHarness.ts      o RASTRO (.synkora/harness.json + notas)
//
// O QUE ESTA SUÍTE PRENDE (e por que cada cerca existe):
//
//  1. A LEI CAIU (ADR-0008) E NADA VOLTA SOZINHO. `impeccable` é slot comum:
//     desliga, sai do kit, e um `skills-kit.json` com `law: true` dentro não
//     promove ninguém. Uma implementação que re-afirme doutrina na leitura
//     passa no resto e MORRE aqui.
//  2. O QUE O AGENTE PUXOU SOBREVIVE AO SYNC. Entrada `origin: 'agent'` não sai
//     na remontagem de aba nem com `chat: null` — só por discard (ADR-0010).
//  3. DESLIGAR NÃO É AUTORIZAR APAGAR. A poda protege por `allKitSkillIds`
//     (todo id citado), não por `kitForChat` (só os habilitados).
//  4. O QUE É DO DONO NÃO SE TOCA. Pasta que o dono pôs à mão no worktree — ou
//     a nossa que ele editou — nunca é sobrescrita nem apagada, e a recusa
//     nomeia a rota real.
//  5. NADA DE REDE. O download roda inteiro com `fetch` injetado; nenhum teste
//     desta suíte abre socket nem encosta em `userData`.
//
// Toda escrita acontece em pasta temporária descartada no `t.after`.
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'

import {
  SkillsKitStore,
  allKitSkillIds,
  attachSkillsKitRecorder,
  isSkillId,
  kitForChat,
  seedSkillsKit
} from '../.tmp/skills-kit-test/skillsKit.js'
import {
  parseSkillFrontmatter,
  scanSkillsLibrary
} from '../.tmp/skills-kit-test/skillsLibraryScan.js'
import {
  downloadSkillFolder,
  installSkillFromUrl,
  parseSkillFolderUrl
} from '../.tmp/skills-kit-test/skillsInstall.js'
import { pruneSkillsLibrary } from '../.tmp/skills-kit-test/skillsPrune.js'
import {
  SKILL_SYNC_TARGETS,
  skillsSyncNoteText,
  syncPaneSkills
} from '../.tmp/skills-kit-test/skillsSync.js'
import {
  discardAgentSkill,
  discardAgentSkills,
  listWorktreeSkills,
  materializeAgentSkill,
  mirrorLocalSkill
} from '../.tmp/skills-kit-test/skillsAgentSync.js'
import {
  MISSION_PLAYBOOK_ID,
  SKILL_HARNESS_FILE,
  liveHarnessEntries,
  missionHarnessBriefing,
  readSkillHarness,
  recordSkillDiscard,
  recordSkillPull,
  skillDiscardNoteText,
  skillPullNoteText
} from '../.tmp/skills-kit-test/skillsHarness.js'

/* ------------------------------------------------------------ utilidades -- */

/** A caixa-preta do store é um recorder único do módulo: a suíte a liga uma vez
 *  e cada teste olha só o DELTA (degradação muda é bug — regra da casa). */
const signals = []
attachSkillsKitRecorder((signal) => signals.push(signal))

function sandbox(t, label) {
  const root = mkdtempSync(join(tmpdir(), `synkora-skills-${label}-`))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** `<base>/lib/<id>/SKILL.md` — o mesmo layout que `skillsBaseDir()` resolve. */
function fakeLib(base, skills) {
  const lib = join(base, 'lib')
  mkdirSync(lib, { recursive: true })
  for (const [id, body] of Object.entries(skills)) {
    mkdirSync(join(lib, id), { recursive: true })
    if (body !== null) writeFileSync(join(lib, id, 'SKILL.md'), body)
  }
  return lib
}

const CLAUDE_TARGET = '.claude/skills'
const CODEX_TARGET = '.agents/skills'
const SYNC_MANIFEST = '.synkora-kit.json'

function slot(id, occasion = 'ocasião de teste', enabled = true) {
  return { id, occasion, enabled }
}

/**
 * Uma skill na lib com bytes que qualquer "normalização" estragaria: CRLF,
 * acento e emoji. A cópia do sync é byte a byte — se alguém trocar
 * `copyFileSync` por leitura/escrita em texto, a comparação de Buffer quebra.
 */
function seedLibSkill(lib, id, body = 'corpo', { bom = false } = {}) {
  const dir = join(lib, id)
  mkdirSync(join(dir, 'references'), { recursive: true })
  const md = Buffer.from(
    `---\r\nname: ${id}\r\ndescription: ação — ${body} ✦\r\n---\r\n\r\n# ${id}\r\n${body}\r\n`,
    'utf8'
  )
  writeFileSync(join(dir, 'SKILL.md'), md)
  // um anexo COM BOM: o sync é transporte, não instalador — ele preserva o que
  // achou (quem tira BOM é o `skillsInstall`, na entrada da biblioteca)
  const extra = bom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`extra ${body} ✦\n`, 'utf8')])
    : Buffer.from(`extra ${body} ✦\n`, 'utf8')
  writeFileSync(join(dir, 'references', 'extra.md'), extra)
  return { md, extra }
}

/* ================================================================ SEED ==== */

test('a primeira leitura semeia o kit aprovado e grava o arquivo', (t) => {
  const root = sandbox(t, 'seed')
  const file = join(root, 'skills-kit.json')
  assert.equal(existsSync(file), false, 'o teste começa sem arquivo')

  const state = new SkillsKitStore(file).state()
  assert.equal(state.version, 1)
  // O KIT v3 — a lista fechada com o dono no grill de 2026-08-21, restaurada
  // por ordem dele em 2026-08-29 sobre a reconstrução que o build tinha semeado.
  assert.deepEqual(
    state.dev.execucao.map((entry) => entry.id),
    [
      'impeccable',
      'synkora-design-system-standard',
      'synkora-codigo-limpo',
      'synkora-investigacao',
      'codebase-design',
      'node',
      'systematic-debugging',
      'test-driven-development',
      'verification-before-completion',
      'owasp-security',
      'better-writing'
    ]
  )
  assert.deepEqual(
    state.dev.orquestracao.map((entry) => entry.id),
    ['writing-plans']
  )
  assert.deepEqual(
    state.planejamento.map((entry) => entry.id),
    ['grilling', 'grill-me', 'grill-with-docs', 'domain-modeling', 'writing-plans']
  )
  // 17 slots (11 + 1 + 5), 16 skills DISTINTAS: `writing-plans` serve duas
  // ocasiões (uma na ala orquestração do dev, outra no planejamento) e a pasta
  // é uma só — é ela que a poda protege, e é ela que o sync copia UMA vez.
  assert.equal(state.dev.execucao.length, 11)
  assert.equal(state.dev.orquestracao.length, 1)
  assert.equal(state.planejamento.length, 5)
  assert.equal(state.dev.execucao.length + state.dev.orquestracao.length + state.planejamento.length, 17)
  assert.deepEqual(
    [...allKitSkillIds(state)].sort(),
    [
      'better-writing',
      'codebase-design',
      'domain-modeling',
      'grill-me',
      'grill-with-docs',
      'grilling',
      'impeccable',
      'node',
      'owasp-security',
      'synkora-codigo-limpo',
      'synkora-design-system-standard',
      'synkora-investigacao',
      'systematic-debugging',
      'test-driven-development',
      'verification-before-completion',
      'writing-plans'
    ],
    'a biblioteca no disco é EXATAMENTE este conjunto — a poda usa esta lista'
  )
  assert.equal(allKitSkillIds(state).size, 16)

  // toda ocasião é texto útil: slot sem ocasião é ficha muda na tela
  for (const entry of [...state.dev.execucao, ...state.dev.orquestracao, ...state.planejamento]) {
    assert.ok(entry.occasion.trim().length > 3, `ocasião vazia em ${entry.id}`)
    assert.equal(entry.enabled, true)
  }

  // `impeccable` abre a ala execução como SLOT COMUM (ADR-0008: a lei caiu) e a
  // ocasião dele diz que é UMA direção entre várias
  assert.equal(state.dev.execucao[0].id, 'impeccable')
  assert.equal(state.dev.execucao[0].occasion, 'direção/polish de UI — uma das direções de design')
  assert.equal(
    [...state.dev.execucao, ...state.dev.orquestracao, ...state.planejamento].some(
      (entry) => 'law' in entry
    ),
    false,
    'algum slot nasceu carimbado como lei'
  )

  assert.ok(existsSync(file), 'o arquivo nasce na primeira leitura, sem clique nenhum')
  assert.ok(existsSync(`${file}.bak`), 'jsonStore grava o .bak junto')
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal('law' in onDisk.dev.execucao[0], false, 'o disco guardou a lei')
})

test('o segundo boot é mudo: mesmo conteúdo, nenhum sinal novo', (t) => {
  const root = sandbox(t, 'seed-idempotente')
  const file = join(root, 'skills-kit.json')
  new SkillsKitStore(file)
  const before = readFileSync(file, 'utf8')
  const marker = signals.length

  const again = new SkillsKitStore(file).state()
  assert.equal(readFileSync(file, 'utf8'), before, 'o segundo boot reescreveu o kit')
  assert.equal(signals.length, marker, 'boot são não fala com a caixa-preta')
  assert.equal(again.dev.execucao.length, 11)
})

/* ============================================ A LEI CAIU (ADR-0008) ======= */

test('a ocasião da ERA DA LEI migra na leitura: "(a lei da persona)" vira a direção de design', (t) => {
  // O userData do dono guarda a fotografia do kit de 08-29, em que o slot do
  // impeccable dizia "mexer em UI (a lei da persona)". A lei caiu (ADR-0008) e
  // a tela mostraria uma história revogada até ele editar à mão. A migração é
  // UMA troca de texto, só quando o texto é EXATAMENTE o da era da lei (uma
  // ocasião que o dono escreveu por conta própria nunca é tocada), persistida
  // e dita à caixa-preta uma vez; o segundo boot é mudo.
  const root = sandbox(t, 'ocasiao-da-lei')
  const file = join(root, 'skills-kit.json')
  const seed = seedSkillsKit()
  seed.dev.execucao[0] = { id: 'impeccable', occasion: 'mexer em UI (a lei da persona)', enabled: true, law: true }
  seed.planejamento.push({ id: 'grilling-x', occasion: 'mexer em UI (a lei da persona)', enabled: true })
  writeFileSync(file, JSON.stringify(seed))
  const marker = signals.length

  const state = new SkillsKitStore(file).state()
  const impeccable = state.dev.execucao.find((entry) => entry.id === 'impeccable')
  assert.equal(impeccable.occasion, 'direção/polish de UI — uma das direções de design')
  assert.equal('law' in impeccable, false)
  // só o impeccable migra: outro slot com o mesmo texto é ocasião do dono
  assert.equal(state.planejamento.find((entry) => entry.id === 'grilling-x').occasion, 'mexer em UI (a lei da persona)')
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.dev.execucao[0].occasion, 'direção/polish de UI — uma das direções de design', 'a migração não pousou no disco')
  assert.deepEqual(
    signals.slice(marker).map((signal) => signal.event),
    ['skills-kit-migrated'],
    'a migração é dita à caixa-preta exatamente uma vez'
  )

  const again = new SkillsKitStore(file).state()
  assert.equal(again.dev.execucao[0].occasion, 'direção/polish de UI — uma das direções de design')
  assert.equal(signals.length, marker + 1, 'o segundo boot é mudo')
})

test('impeccable é slot COMUM: desliga, sai do kit e volta pela tela', (t) => {
  const root = sandbox(t, 'impeccable-comum')
  const file = join(root, 'skills-kit.json')
  const store = new SkillsKitStore(file)

  const off = store.setSlotEnabled('dev', 'impeccable', false)
  assert.equal(off.ok, true, `recusou desligar: ${off.error ?? ''}`)
  assert.equal(off.state.dev.execucao[0].enabled, false)
  assert.equal(
    JSON.parse(readFileSync(file, 'utf8')).dev.execucao[0].enabled,
    false,
    'o toggle da direção de design não pousou no disco'
  )
  // desligada, ela não viaja para o worktree — mas a poda continua protegendo a
  // pasta (desligar nunca foi autorizar apagar)
  assert.equal(
    kitForChat(off.state, 'dev').some((slot) => slot.id === 'impeccable'),
    false
  )
  assert.equal(allKitSkillIds(off.state).has('impeccable'), true)

  const gone = store.removeSlot('dev', 'impeccable')
  assert.equal(gone.ok, true, `recusou remover: ${gone.error ?? ''}`)
  assert.equal(
    JSON.parse(readFileSync(file, 'utf8')).dev.execucao.some((e) => e.id === 'impeccable'),
    false,
    'a remoção não pousou no disco'
  )
  // e ela volta como qualquer outra ocasião: nada aqui é irreversível
  const back = store.addSlot('dev', { id: 'impeccable', occasion: 'polir a interface' })
  assert.equal(back.ok, true)
  assert.equal(back.state.dev.execucao.at(-1).occasion, 'polir a interface')
})

test('kit sem impeccable NÃO ressuscita, e `law: true` no JSON não promove ninguém', (t) => {
  const root = sandbox(t, 'lei-revogada')
  const file = join(root, 'skills-kit.json')
  new SkillsKitStore(file)

  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.dev.execucao = raw.dev.execucao.filter((entry) => entry.id !== 'impeccable')
  // um arquivo da ERA DA LEI (ou doutorado à mão) tentando promover alguém
  raw.dev.execucao[0].law = true
  raw.planejamento[0].law = true
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')

  const marker = signals.length
  const state = new SkillsKitStore(file).state()
  assert.equal(
    state.dev.execucao.some((entry) => entry.id === 'impeccable'),
    false,
    'a lei ressuscitou na leitura'
  )
  for (const slot of [...state.dev.execucao, ...state.planejamento]) {
    assert.equal('law' in slot, false, `${slot.id} chegou carimbado como lei`)
  }
  // nada de degradação: um kit sem impeccable é uma ESCOLHA do dono, não avaria
  assert.equal(signals.length, marker, 'a leitura de um kit legítimo falou com a caixa-preta')
  assert.equal(
    JSON.parse(readFileSync(file, 'utf8')).dev.execucao.some((e) => e.id === 'impeccable'),
    false,
    'a leitura reescreveu o arquivo do dono'
  )

  // e o slot que o arquivo tentou promover continua desligável e removível
  const store = new SkillsKitStore(file)
  assert.equal(store.setSlotEnabled('dev', state.dev.execucao[0].id, false).ok, true)
  assert.equal(store.removeSlot('planejamento', state.planejamento[0].id).ok, true)
})

/* =========================================================== MUTAÇÕES ===== */

test('ligar, adicionar e remover atravessam o disco', (t) => {
  const root = sandbox(t, 'mutacoes')
  const file = join(root, 'skills-kit.json')
  const store = new SkillsKitStore(file)

  assert.equal(store.setSlotEnabled('dev', 'owasp-security', false).ok, true)
  assert.equal(
    new SkillsKitStore(file).state().dev.execucao.find((e) => e.id === 'owasp-security').enabled,
    false,
    'o toggle não pousou no arquivo'
  )

  const added = store.addSlot('dev', { id: 'nova-skill', occasion: 'ocasião nova' }, 'orquestracao')
  assert.equal(added.ok, true)
  assert.equal(added.state.dev.orquestracao.at(-1).id, 'nova-skill')
  assert.equal(
    new SkillsKitStore(file).state().dev.orquestracao.at(-1).occasion,
    'ocasião nova'
  )

  const removed = store.removeSlot('dev', 'nova-skill')
  assert.equal(removed.ok, true)
  assert.equal(
    new SkillsKitStore(file).state().dev.orquestracao.some((e) => e.id === 'nova-skill'),
    false,
    'a remoção não pousou no arquivo'
  )
})

test('as recusas do addSlot dizem o que fazer', (t) => {
  const root = sandbox(t, 'add-recusas')
  const store = new SkillsKitStore(join(root, 'skills-kit.json'))

  const semOcasiao = store.addSlot('planejamento', { id: 'alguma-skill', occasion: '   ' })
  assert.equal(semOcasiao.ok, false)
  assert.match(semOcasiao.error, /OCASIÃO/u)

  const idTorto = store.addSlot('planejamento', { id: 'Nao/Vale', occasion: 'x' })
  assert.equal(idTorto.ok, false)
  assert.match(idTorto.error, /minúsculas, dígitos e hífen/u)

  const duplicada = store.addSlot('dev', { id: 'writing-plans', occasion: 'de novo' })
  assert.equal(duplicada.ok, false)
  assert.match(duplicada.error, /já está no kit de dev \(ala orquestração\)/u)

  const fantasma = store.setSlotEnabled('dev', 'skill-que-nao-existe', false)
  assert.equal(fantasma.ok, false)
  assert.match(fantasma.error, /adicione pela biblioteca/u)
})

test('kitForChat dedupa a pasta e deixa o desligado fora; a poda vê os dois', () => {
  const state = seedSkillsKit()
  state.dev.execucao.find((entry) => entry.id === 'test-driven-development').enabled = false
  // a MESMA pasta em duas ocasiões do mesmo chat: o transporte não a duplica
  state.dev.execucao.push({ id: 'writing-plans', occasion: 'planejar a fatia', enabled: true })

  const dev = kitForChat(state, 'dev')
  assert.equal(
    dev.some((entry) => entry.id === 'test-driven-development'),
    false,
    'slot desligado foi para o worktree'
  )
  assert.equal(dev.filter((entry) => entry.id === 'writing-plans').length, 1, 'pasta duplicada')
  // 11 da execução − 1 desligado + o `writing-plans` empurrado; o da ala
  // orquestração cai na deduplicação
  assert.equal(dev.length, 11)

  const planejamento = kitForChat(state, 'planejamento')
  assert.deepEqual(
    planejamento.map((entry) => entry.id),
    ['grilling', 'grill-me', 'grill-with-docs', 'domain-modeling', 'writing-plans']
  )

  // A PROTEÇÃO DA PODA IGNORA O `enabled`: desligar não é autorizar apagar.
  const protegidos = allKitSkillIds(state)
  assert.equal(protegidos.has('test-driven-development'), true)
  assert.equal(protegidos.size, 16)
})

/* ========================================================= DEGRADAÇÃO ===== */

test('arquivo ilegível volta ao seed, e o sinal diz que ele EXISTIA', (t) => {
  const root = sandbox(t, 'degrada-total')
  const file = join(root, 'skills-kit.json')
  writeFileSync(file, '{ isto não é json', 'utf8')

  const marker = signals.length
  const state = new SkillsKitStore(file).state()
  assert.equal(state.dev.execucao.length, 11)
  assert.equal(state.dev.execucao[0].id, 'impeccable')
  assert.ok(signals.length > marker)
  assert.equal(signals.at(-1).event, 'skills-kit-seeded')
  assert.match(signals.at(-1).reason, /existia mas não era legível/u)
  assert.equal(signals.at(-1).detail.existed, true)
})

test('lixo parcial derruba SÓ o slot podre — o kit do dono sobrevive', (t) => {
  const root = sandbox(t, 'degrada-parcial')
  const file = join(root, 'skills-kit.json')
  const store = new SkillsKitStore(file)
  store.addSlot('planejamento', { id: 'skill-do-dono', occasion: 'a ocasião do dono' })

  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.planejamento.push({ id: 'SEM/VALIDADE', occasion: 'id ilegal' })
  raw.planejamento.push(null)
  raw.planejamento.push({ id: 'grilling', occasion: 'duplicada' })
  raw.dev.orquestracao.push(42)
  writeFileSync(file, JSON.stringify(raw), 'utf8')

  const marker = signals.length
  const state = new SkillsKitStore(file).state()
  assert.equal(
    state.planejamento.some((entry) => entry.id === 'skill-do-dono'),
    true,
    'o slot do dono morreu junto com o lixo'
  )
  assert.equal(state.planejamento.filter((entry) => entry.id === 'grilling').length, 1)
  assert.equal(state.planejamento.length, 6, 'sobraram os 5 do seed + o do dono')
  assert.equal(state.dev.orquestracao.length, 1)
  assert.ok(signals.length > marker)
  assert.equal(signals.at(-1).event, 'skills-kit-degraded')
  assert.ok(signals.at(-1).detail.dropped.length >= 3)
})

/* =============================================================== SCAN ===== */

test('o scan lê a lib inteira e degrada linha a linha, sem sumir com nenhuma', (t) => {
  const root = sandbox(t, 'scan')
  const lib = fakeLib(root, {
    boa: '---\nname: boa\ndescription: Uma skill bem descrita\nversion: 1\n---\n# corpo',
    bloco:
      '---\nname: bloco\ndescription: >-\n  primeira linha do bloco\n  segunda linha\nversion: 2\n---\n',
    'com-bom': Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('---\nname: com-bom\ndescription: tem BOM\n---\n')
    ]),
    'sem-frontmatter': '# só um título',
    vazia: null
  })
  mkdirSync(join(lib, 'agente'), { recursive: true })
  writeFileSync(join(lib, 'agente', 'agent.md'), '---\nname: agente\n---\n')

  const entries = scanSkillsLibrary(lib)
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ['agente', 'bloco', 'boa', 'com-bom', 'sem-frontmatter', 'vazia'],
    'a lista sai ordenada e ninguém some dela'
  )
  const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]))

  assert.equal(byId.boa.description, 'Uma skill bem descrita')
  assert.equal(byId.boa.hasBom, false)
  // escalar de bloco (`description: >-`): 43 das ~300 skills da lib usam a forma
  assert.equal(byId.bloco.description, 'primeira linha do bloco segunda linha')
  assert.equal(byId['com-bom'].hasBom, true, 'o BOM passou despercebido')
  assert.equal(byId['com-bom'].description, 'tem BOM')
  assert.match(byId['sem-frontmatter'].description, /sem "description:"/u)
  assert.match(byId.vazia.description, /sem SKILL\.md/u)
  // pasta de SUBAGENTE da era F6: a linha diz o que é, não finge erro de leitura
  assert.match(byId.agente.description, /subagente da era F6/u)

  // lib inexistente (máquina nova) é biblioteca VAZIA, não exceção
  assert.deepEqual(scanSkillsLibrary(join(root, 'nao-existe')), [])
})

test('descrição gigante é truncada; frontmatter ausente não explode', (t) => {
  const root = sandbox(t, 'scan-longo')
  const lib = fakeLib(root, {
    longa: `---\nname: longa\ndescription: ${'a'.repeat(400)}\n---\n`
  })
  const [longa] = scanSkillsLibrary(lib)
  assert.equal(longa.description.length, 201)
  assert.ok(longa.description.endsWith('…'))
  assert.deepEqual(parseSkillFrontmatter('sem frontmatter nenhum'), {})
  assert.equal(parseSkillFrontmatter('---\nname: x\n---\n').description, undefined)
})

/* =============================================================== SYNC ===== */

test('as pastas-alvo são as da sonda — e `.codex` não aparece em lugar nenhum', () => {
  assert.deepEqual(SKILL_SYNC_TARGETS.claude, ['.claude/skills'])
  assert.deepEqual(SKILL_SYNC_TARGETS.codex, ['.agents/skills'])
  assert.equal(
    JSON.stringify(SKILL_SYNC_TARGETS).includes('.codex'),
    false,
    'criar .codex/ faz o codex cuspir ERROR de trust a cada sessão (P6 da sonda)'
  )
})

test('o sync materializa nos DOIS alvos, byte a byte, e escreve o manifesto', (t) => {
  const root = sandbox(t, 'sync-materializa')
  const cwd = join(root, 'worktree')
  const lib = join(root, 'lib')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(lib, { recursive: true })
  const bytes = seedLibSkill(lib, 'impeccable', 'corpo', { bom: true })

  const out = syncPaneSkills(cwd, 'dev', { kit: [slot('impeccable')], libraryRoot: lib })
  assert.equal(out.ok, true)
  assert.deepEqual(out.synced, ['impeccable'])
  assert.deepEqual(out.failures, [])
  assert.equal(out.wrote, true)

  for (const target of [CLAUDE_TARGET, CODEX_TARGET]) {
    const skill = join(cwd, target, 'impeccable')
    assert.deepEqual(readFileSync(join(skill, 'SKILL.md')), bytes.md, `${target} re-encodou`)
    assert.notEqual(readFileSync(join(skill, 'SKILL.md'))[0], 0xef, 'a cópia INVENTOU um BOM')
    // o anexo já vinha COM BOM: transporte preserva o que achou
    assert.deepEqual(readFileSync(join(skill, 'references', 'extra.md')), bytes.extra)

    const manifest = JSON.parse(readFileSync(join(cwd, target, SYNC_MANIFEST), 'utf8'))
    assert.equal(manifest.version, 1)
    assert.equal(manifest.entries.length, 1)
    assert.equal(manifest.entries[0].id, 'impeccable')
    assert.match(manifest.entries[0].fingerprint, /^[0-9a-f]{64}$/u)
  }
  // o pouso temporário não deixa skill fantasma no cardápio do CLI
  assert.equal(existsSync(join(cwd, '.synkora', 'skills-sync-tmp')), false)
})

test('re-sincronizar não toca o disco (o reconciliador roda a cada remontagem)', (t) => {
  const root = sandbox(t, 'sync-idempotente')
  const cwd = join(root, 'worktree')
  const lib = join(root, 'lib')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(lib, { recursive: true })
  seedLibSkill(lib, 'owasp-security')
  const kit = [slot('owasp-security')]

  const first = syncPaneSkills(cwd, 'dev', { kit, libraryRoot: lib })
  const manifestBefore = readFileSync(join(cwd, CLAUDE_TARGET, SYNC_MANIFEST), 'utf8')
  const second = syncPaneSkills(cwd, 'dev', { kit, libraryRoot: lib })

  assert.equal(first.wrote, true)
  assert.equal(second.wrote, false, 'a segunda passada escreveu — não é idempotente')
  assert.deepEqual(second.synced, ['owasp-security'])
  assert.equal(readFileSync(join(cwd, CLAUDE_TARGET, SYNC_MANIFEST), 'utf8'), manifestBefore)
})

test('slot DESLIGADO sai do worktree; o resto do kit fica', (t) => {
  const root = sandbox(t, 'sync-desliga')
  const cwd = join(root, 'worktree')
  const lib = join(root, 'lib')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(lib, { recursive: true })
  seedLibSkill(lib, 'better-writing')
  seedLibSkill(lib, 'domain-modeling')

  syncPaneSkills(cwd, 'dev', {
    kit: [slot('better-writing'), slot('domain-modeling')],
    libraryRoot: lib
  })
  const out = syncPaneSkills(cwd, 'dev', {
    kit: [slot('better-writing'), slot('domain-modeling', 'ocasião', false)],
    libraryRoot: lib
  })

  assert.deepEqual(out.removed, ['domain-modeling'])
  assert.deepEqual(out.synced, ['better-writing'])
  for (const target of [CLAUDE_TARGET, CODEX_TARGET]) {
    assert.equal(existsSync(join(cwd, target, 'domain-modeling')), false, `${target} manteve`)
    assert.equal(existsSync(join(cwd, target, 'better-writing', 'SKILL.md')), true)
  }
})

test('release (chat null) limpa SÓ o que era nosso, mesmo com kit na mão', (t) => {
  const root = sandbox(t, 'sync-release')
  const cwd = join(root, 'worktree')
  const lib = join(root, 'lib')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(lib, { recursive: true })
  seedLibSkill(lib, 'writing-plans')
  const kit = [slot('writing-plans')]
  syncPaneSkills(cwd, 'dev', { kit, libraryRoot: lib })

  // uma skill que o DONO pôs à mão na mesma pasta, sem passar pelo Synkora
  const manual = join(cwd, CLAUDE_TARGET, 'meu-manual')
  mkdirSync(manual, { recursive: true })
  const manualBytes = Buffer.from('---\nname: meu-manual\n---\nescrito à mão\n', 'utf8')
  writeFileSync(join(manual, 'SKILL.md'), manualBytes)

  // O TIPO DO CHAT É A AUTORIDADE: mesmo recebendo o kit, `null` é kit vazio.
  const out = syncPaneSkills(cwd, null, { kit, libraryRoot: lib })
  assert.equal(out.ok, true)
  assert.deepEqual(out.removed, ['writing-plans'])
  assert.deepEqual(out.synced, [])

  assert.deepEqual(readFileSync(join(manual, 'SKILL.md')), manualBytes, 'apagou o do dono')
  assert.equal(existsSync(join(cwd, CLAUDE_TARGET, 'writing-plans')), false)
  assert.equal(existsSync(join(cwd, CLAUDE_TARGET, SYNC_MANIFEST)), false)
  // o alvo do codex ficou vazio de verdade: a pasta some inteira
  assert.equal(existsSync(join(cwd, CODEX_TARGET)), false, '.agents/skills sobrou vazia')

  // e num worktree virgem o release não CRIA pasta nenhuma
  const virgem = join(root, 'virgem')
  mkdirSync(virgem, { recursive: true })
  syncPaneSkills(virgem, null, { libraryRoot: lib })
  assert.deepEqual(readdirSync(virgem), [])
})

test('pasta que o DONO pôs à mão nunca é sobrescrita, nem com o mesmo id', (t) => {
  const root = sandbox(t, 'sync-dono')
  const cwd = join(root, 'worktree')
  const lib = join(root, 'lib')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(lib, { recursive: true })
  seedLibSkill(lib, 'impeccable', 'da-lib')

  const dele = join(cwd, CLAUDE_TARGET, 'impeccable')
  mkdirSync(dele, { recursive: true })
  const bytes = Buffer.from('---\nname: impeccable\n---\nMEU, escrito à mão\n', 'utf8')
  writeFileSync(join(dele, 'SKILL.md'), bytes)

  const out = syncPaneSkills(cwd, 'dev', { kit: [slot('impeccable')], libraryRoot: lib })
  assert.deepEqual(readFileSync(join(dele, 'SKILL.md')), bytes, 'sobrescreveu a pasta do dono')
  assert.deepEqual(out.userModified, ['impeccable'])
  assert.deepEqual(out.synced, [], 'declarou sincronizado o que é do dono')
  // e o alvo que estava LIVRE recebeu a da lib normalmente
  assert.equal(existsSync(join(cwd, CODEX_TARGET, 'impeccable', 'SKILL.md')), true)
  // a pasta do dono NÃO entra no manifesto: ela nunca vira nossa por decurso —
  // e como nada foi declarado nosso naquele alvo, nem manifesto existe ali
  assert.equal(
    existsSync(join(cwd, CLAUDE_TARGET, SYNC_MANIFEST)),
    false,
    'o Synkora declarou como sua uma pasta que não escreveu'
  )
  const doCodex = JSON.parse(readFileSync(join(cwd, CODEX_TARGET, SYNC_MANIFEST), 'utf8'))
  assert.deepEqual(
    doCodex.entries.map((entry) => entry.id),
    ['impeccable']
  )
})

test('pasta NOSSA editada por fora não é re-copiada nem apagada', (t) => {
  const root = sandbox(t, 'sync-editada')
  const cwd = join(root, 'worktree')
  const lib = join(root, 'lib')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(lib, { recursive: true })
  seedLibSkill(lib, 'systematic-debugging')
  const kit = [slot('systematic-debugging')]
  syncPaneSkills(cwd, 'dev', { kit, libraryRoot: lib })

  const editado = join(cwd, CLAUDE_TARGET, 'systematic-debugging', 'SKILL.md')
  const bytes = Buffer.from('EDITADO PELO AGENTE\n', 'utf8')
  writeFileSync(editado, bytes)

  const kept = syncPaneSkills(cwd, 'dev', { kit, libraryRoot: lib })
  assert.deepEqual(readFileSync(editado), bytes, 're-copiou por cima da edição')
  assert.deepEqual(kept.userModified, ['systematic-debugging'])
  assert.deepEqual(kept.synced, [])

  // a divergência continua RELATADA a cada spawn enquanto o id estiver no kit
  const again = syncPaneSkills(cwd, 'dev', { kit, libraryRoot: lib })
  assert.deepEqual(again.userModified, ['systematic-debugging'])

  // e nem a REMOÇÃO a alcança: o kit esvazia, o alvo do codex (ainda nosso)
  // limpa, e o arquivo divergente do dono fica de pé
  const emptied = syncPaneSkills(cwd, 'dev', { kit: [], libraryRoot: lib })
  assert.deepEqual(readFileSync(editado), bytes, 'apagou arquivo divergente do dono')
  assert.deepEqual(emptied.removed, ['systematic-debugging'])
  assert.equal(existsSync(join(cwd, CODEX_TARGET, 'systematic-debugging')), false)
})

test('a lib mudou: a pasta que é NOSSA é re-materializada inteira', (t) => {
  const root = sandbox(t, 'sync-lib-nova')
  const cwd = join(root, 'worktree')
  const lib = join(root, 'lib')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(lib, { recursive: true })
  seedLibSkill(lib, 'better-writing', 'v1')
  const kit = [slot('better-writing')]
  syncPaneSkills(cwd, 'dev', { kit, libraryRoot: lib })
  const v2 = seedLibSkill(lib, 'better-writing', 'v2')

  const out = syncPaneSkills(cwd, 'dev', { kit, libraryRoot: lib })
  assert.equal(out.wrote, true)
  assert.deepEqual(out.synced, ['better-writing'])
  for (const target of [CLAUDE_TARGET, CODEX_TARGET]) {
    assert.deepEqual(readFileSync(join(cwd, target, 'better-writing', 'SKILL.md')), v2.md)
  }
})

test('id fora da lib é falha NOMEADA e não estripa o cardápio do worktree', (t) => {
  const root = sandbox(t, 'sync-lib-sumiu')
  const cwd = join(root, 'worktree')
  const lib = join(root, 'lib')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(lib, { recursive: true })
  seedLibSkill(lib, 'brainstorming')
  const kit = [slot('brainstorming')]
  syncPaneSkills(cwd, 'dev', { kit, libraryRoot: lib })

  rmSync(join(lib, 'brainstorming'), { recursive: true, force: true })
  const out = syncPaneSkills(cwd, 'dev', { kit, libraryRoot: lib })
  assert.equal(out.ok, false)
  assert.deepEqual(
    out.failures.map((failure) => failure.id),
    ['brainstorming']
  )
  assert.match(out.failures[0].error, /biblioteca/u)
  assert.equal(
    existsSync(join(cwd, CLAUDE_TARGET, 'brainstorming', 'SKILL.md')),
    true,
    'um acidente na lib apagou o cardápio de um worktree vivo'
  )

  const note = skillsSyncNoteText(out)
  assert.match(note, /brainstorming/u)
  assert.match(note, /cardápio/u)
  assert.match(note, /Ajustes › Skills/u, 'a nota tem que terminar na receita')
  assert.equal(skillsSyncNoteText({ ...out, failures: [] }), null, 'sync são não fala no chat')
})

test('o manifesto do worktree é entrada NÃO confiável — nunca vira um rm', (t) => {
  const root = sandbox(t, 'sync-manifesto-hostil')
  const cwd = join(root, 'worktree')
  const lib = join(root, 'lib')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(lib, { recursive: true })
  seedLibSkill(lib, 'brainstorming')

  const vitima = join(cwd, 'NAO-APAGAR')
  mkdirSync(vitima, { recursive: true })
  writeFileSync(join(vitima, 'segredo.txt'), 'x')

  mkdirSync(join(cwd, CLAUDE_TARGET), { recursive: true })
  writeFileSync(
    join(cwd, CLAUDE_TARGET, SYNC_MANIFEST),
    JSON.stringify({
      version: 1,
      entries: [
        { id: '../../NAO-APAGAR', fingerprint: 'a'.repeat(64), dest: {}, source: {} },
        { id: 'brainstorming', fingerprint: 'nao-e-sha', dest: {}, source: {} }
      ]
    }),
    'utf8'
  )

  const out = syncPaneSkills(cwd, 'dev', { kit: [slot('brainstorming')], libraryRoot: lib })
  assert.equal(existsSync(join(vitima, 'segredo.txt')), true, 'o manifesto virou um rm')
  assert.equal(out.ok, true)

  // manifesto ilegível degrada para "não gerencio nada": re-materializa e segue
  writeFileSync(join(cwd, CODEX_TARGET, SYNC_MANIFEST), '{{{ não é json', 'utf8')
  const degradado = syncPaneSkills(cwd, 'dev', { kit: [slot('brainstorming')], libraryRoot: lib })
  assert.equal(degradado.ok, true)
  assert.equal(existsSync(join(cwd, CODEX_TARGET, 'brainstorming', 'SKILL.md')), true)
})

test('pane sem pasta de trabalho é falha nomeada, nunca uma exceção', () => {
  const out = syncPaneSkills('', 'dev', { kit: [], libraryRoot: 'qualquer' })
  assert.equal(out.ok, false)
  assert.equal(out.failures[0].id, 'skills')
  assert.match(out.failures[0].error, /pasta de trabalho/u)
})

/* ========================================================== INSTALAÇÃO ==== */

test('parseSkillFolderUrl entende as três formas e recusa o resto', () => {
  assert.deepEqual(parseSkillFolderUrl('https://github.com/dono/repo/tree/main/skills/alpha'), {
    repo: 'dono/repo',
    ref: 'main',
    path: 'skills/alpha'
  })
  assert.deepEqual(parseSkillFolderUrl('https://github.com/dono/repo'), {
    repo: 'dono/repo',
    path: ''
  })
  assert.deepEqual(parseSkillFolderUrl('dono/repo'), { repo: 'dono/repo', path: '' })
  assert.equal(parseSkillFolderUrl('https://gitlab.com/dono/repo'), null)
  assert.equal(parseSkillFolderUrl(''), null)
})

const PINNED_SHA = 'c0ffee1234567890'

/**
 * O GitHub INTEIRO, sem rede: commits (o pin), trees (a listagem) e raw (os
 * bytes). `calls` é a prova do custo — a instalação gasta 2 chamadas core.
 */
function githubFake(files, { name = 'alpha', bom = false, truncated = false, prefix = 'skills/alpha/' } = {}) {
  const calls = []
  const skillMd = `---\nname: ${name}\ndescription: skill de teste\n---\n# corpo\n`
  const bodies = {
    [`${prefix}SKILL.md`]: bom ? `\uFEFF${skillMd}` : skillMd,
    ...files
  }
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.includes('/commits?')) {
      return new Response(JSON.stringify([{ sha: PINNED_SHA }]), { status: 200 })
    }
    if (url.includes('/git/trees/')) {
      assert.ok(url.includes(PINNED_SHA), 'a tree tem que usar o sha PINADO da pasta')
      return new Response(
        JSON.stringify({
          truncated,
          tree: Object.keys(bodies).map((path) => ({
            path,
            type: 'blob',
            mode: '100644',
            size: Buffer.byteLength(bodies[path])
          }))
        }),
        { status: 200 }
      )
    }
    const key = decodeURIComponent(
      url.replace(`https://raw.githubusercontent.com/dono/repo/${PINNED_SHA}/`, '')
    )
    if (bodies[key] === undefined) return new Response('nope', { status: 404 })
    return new Response(Buffer.from(bodies[key]), { status: 200 })
  }
  return { fetchImpl, calls, bodies }
}

test('instala pinado na PASTA, sem BOM no texto, e preserva o manifest', async (t) => {
  const root = sandbox(t, 'install')
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({
      installed: { velha: { sha: 'v', installedAt: 'v', supplyChain: { decision: 'review' } } },
      updates: { alpha: 'sha-novo-visto', velha: 'outro' },
      repoHeads: { 'dono/repo@main': { sha: 'fff' } },
      lastCheckAt: 'ontem'
    }),
    'utf8'
  )
  // um PNG que começa com os mesmos três bytes do BOM: binário não é texto, e a
  // limpeza do BOM não pode mutilar arquivo que ninguém vai parsear
  const png = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('PNG-CRU')])
  const { fetchImpl, calls } = githubFake(
    {
      'skills/alpha/reference/uso.md': 'como usar',
      'skills/alpha/logo.png': png,
      'skills/alpha/demo.mp4': 'binário de vídeo'
    },
    { bom: true }
  )

  const result = await installSkillFromUrl('https://github.com/dono/repo/tree/main/skills/alpha', {
    base: root,
    fetch: fetchImpl
  })
  assert.deepEqual(result, { ok: true, id: 'alpha' })

  // O PIN É DA PASTA, não do HEAD do repo (ADR-0007).
  const commits = calls.find((url) => url.includes('/commits?'))
  assert.match(commits, /path=skills%2Falpha/u, 'o pin não é da pasta')
  assert.match(commits, /sha=main/u, 'o ref da URL não chegou no pin')
  assert.equal(calls.filter((url) => url.includes('api.github.com')).length, 2, '2 chamadas core')

  const installed = readFileSync(join(root, 'lib', 'alpha', 'SKILL.md'))
  assert.notEqual(installed[0], 0xef, 'o BOM sobreviveu à escrita')
  assert.ok(installed.toString('utf8').startsWith('---\nname: alpha'))
  assert.equal(readFileSync(join(root, 'lib', 'alpha', 'reference', 'uso.md'), 'utf8'), 'como usar')
  assert.deepEqual(readFileSync(join(root, 'lib', 'alpha', 'logo.png')), png, 'mutilou o binário')
  assert.equal(existsSync(join(root, 'lib', 'alpha', 'demo.mp4')), false, 'vídeo é pulado')
  assert.equal(existsSync(join(root, '.staging-alpha')), false, 'o staging some depois do rename')

  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  assert.equal(manifest.installed.alpha.sha, PINNED_SHA)
  assert.ok(manifest.installed.alpha.installedAt)
  assert.equal(manifest.installed.velha.sha, 'v', 'entrada antiga sumiu')
  assert.deepEqual(manifest.installed.velha.supplyChain, { decision: 'review' })
  // o "sha novo visto" do id recém-instalado sai (acabou de ser instalado); o
  // dos outros ids fica de pé
  assert.deepEqual(manifest.updates, { velha: 'outro' })
  assert.deepEqual(manifest.repoHeads, { 'dono/repo@main': { sha: 'fff' } }, 'chave estranha sumiu')
  assert.equal(manifest.lastCheckAt, 'ontem')

  // e a SEGUNDA instalação do mesmo id é recusada nomeando a saída (a poda)
  const again = await installSkillFromUrl(
    'https://github.com/dono/repo/tree/main/skills/alpha',
    { base: root, fetch: fetchImpl }
  )
  assert.equal(again.ok, false)
  assert.match(again.error, /já está na biblioteca/u)
  assert.match(again.error, /PODA/u)
})

test('pasta divergente do `name:` é recusada ANTES de baixar', async (t) => {
  const root = sandbox(t, 'install-divergente')
  const { fetchImpl, calls } = githubFake({}, { name: 'outra-coisa' })
  const result = await installSkillFromUrl(
    'https://github.com/dono/repo/tree/main/skills/alpha',
    { base: root, fetch: fetchImpl }
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /a pasta apontada chama "alpha"/u)
  assert.match(result.error, /name: "outra-coisa"/u)
  assert.equal(existsSync(join(root, 'lib')), false, 'escreveu mesmo recusando')
  assert.equal(
    calls.some((url) => url.includes('/git/trees/')),
    false,
    'baixou a listagem antes de validar o name'
  )
})

test('tree truncada pelo GitHub é recusa — nunca skill pela metade', async (t) => {
  const root = sandbox(t, 'install-truncada')
  const { fetchImpl } = githubFake({ 'skills/alpha/extra.md': 'x' }, { truncated: true })
  const result = await installSkillFromUrl(
    'https://github.com/dono/repo/tree/main/skills/alpha',
    { base: root, fetch: fetchImpl }
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /truncou/u)
  assert.match(result.error, /pela metade/u)
  assert.equal(existsSync(join(root, 'lib', 'alpha')), false)
})

test('raiz de repo sem SKILL.md é recusada nomeando a receita da URL', async (t) => {
  const root = sandbox(t, 'install-raiz')
  const { fetchImpl } = githubFake({}, { prefix: 'algum/lugar/' })
  const result = await installSkillFromUrl('dono/repo', { base: root, fetch: fetchImpl })
  assert.equal(result.ok, false)
  assert.match(result.error, /não achei SKILL\.md/u)
  assert.match(result.error, /aponte a PASTA da skill no GitHub/u)
  assert.equal(existsSync(join(root, 'lib')), false)
})

test('rate limit e URL inválida nomeiam a saída', async (t) => {
  const root = sandbox(t, 'install-cota')
  const limited = async () =>
    new Response('{}', {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(1755000000) }
    })
  const rate = await installSkillFromUrl('dono/repo', { base: root, fetch: limited })
  assert.equal(rate.ok, false)
  assert.match(rate.error, /limite de requisições/u)

  const bad = await installSkillFromUrl('não é url', { base: root, fetch: limited })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /aponte a PASTA da skill/u)
})

test('manifest ilegível barra a instalação antes do download', async (t) => {
  const root = sandbox(t, 'install-manifest-podre')
  writeFileSync(join(root, 'manifest.json'), '{{{', 'utf8')
  const { fetchImpl, calls } = githubFake({})
  const result = await installSkillFromUrl(
    'https://github.com/dono/repo/tree/main/skills/alpha',
    { base: root, fetch: fetchImpl }
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /manifest\.json/u)
  assert.match(result.error, /\.bak/u, 'a recusa precisa dizer como recuperar')
  assert.equal(calls.some((url) => url.includes('/git/trees/')), false, 'chegou até a tree')
  assert.equal(readFileSync(join(root, 'manifest.json'), 'utf8'), '{{{', 'sobrescreveu o manifest')
})

/* =============================================================== PODA ===== */

test('a poda leva SÓ o que nenhum slot cita — o desligado fica', (t) => {
  const root = sandbox(t, 'poda')
  fakeLib(root, {
    impeccable: '---\nname: impeccable\n---\n',
    'owasp-security': '---\nname: owasp-security\n---\n',
    'lixo-antigo': '---\nname: lixo-antigo\n---\n',
    'outro-lixo': '---\nname: outro-lixo\n---\n'
  })
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify(
      {
        installed: {
          impeccable: { sha: 'aaa', installedAt: 'x', supplyChain: { decision: 'review' } },
          'lixo-antigo': { sha: 'bbb', installedAt: 'y' },
          'outro-lixo': { sha: 'ccc', installedAt: 'z' }
        },
        updates: { 'lixo-antigo': 'ddd', impeccable: 'eee' },
        repoHeads: { 'dono/repo@main': { sha: 'fff' } },
        lastCheckAt: '2026-08-17T00:00:00.000Z'
      },
      null,
      2
    ),
    'utf8'
  )

  const state = seedSkillsKit()
  // DESLIGAR NÃO É AUTORIZAR APAGAR: o slot desligado protege a pasta igual.
  state.dev.execucao.find((entry) => entry.id === 'owasp-security').enabled = false

  const result = pruneSkillsLibrary(state, { base: root })
  assert.deepEqual(result.removed, ['lixo-antigo', 'outro-lixo'])
  assert.deepEqual(result.kept, ['impeccable', 'owasp-security'])
  assert.equal(existsSync(join(root, 'lib', 'lixo-antigo')), false)
  assert.equal(
    existsSync(join(root, 'lib', 'owasp-security')),
    true,
    'a poda apagou a pasta de um slot DESLIGADO'
  )

  const after = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  assert.deepEqual(Object.keys(after.installed), ['impeccable'])
  assert.deepEqual(after.updates, { impeccable: 'eee' })
  assert.deepEqual(after.installed.impeccable.supplyChain, { decision: 'review' })
  assert.deepEqual(after.repoHeads, { 'dono/repo@main': { sha: 'fff' } }, 'chave estranha sumiu')
  assert.equal(after.lastCheckAt, '2026-08-17T00:00:00.000Z')
})

test('manifest ilegível não é sobrescrito pela poda — e o sinal diz isso', (t) => {
  const root = sandbox(t, 'poda-manifest-podre')
  fakeLib(root, { 'lixo-antigo': '---\nname: lixo-antigo\n---\n' })
  writeFileSync(join(root, 'manifest.json'), 'não é json', 'utf8')

  const notes = []
  const result = pruneSkillsLibrary(seedSkillsKit(), {
    base: root,
    record: (signal) => notes.push(signal)
  })
  assert.deepEqual(result.removed, ['lixo-antigo'])
  assert.equal(readFileSync(join(root, 'manifest.json'), 'utf8'), 'não é json')
  assert.equal(notes.at(-1).event, 'skills-prune-manifest-unreadable')
})

test('lib inexistente não é erro de poda; e o id da pasta é sempre validado', (t) => {
  const root = sandbox(t, 'poda-vazia')
  assert.deepEqual(pruneSkillsLibrary(seedSkillsKit(), { base: root }), { removed: [], kept: [] })

  assert.equal(isSkillId('systematic-debugging'), true)
  assert.equal(isSkillId('Com-Maiuscula'), false)
  assert.equal(isSkillId('com--dois'), false)
  assert.equal(isSkillId('com/barra'), false)
  assert.equal(isSkillId('../fuga'), false)
})

/* ========================================== DOWNLOAD PARA O WORKTREE ====== */

/** Uma pasta já "baixada" (o pouso que o downloadSkillFolder devolve). */
function fakeDownload(root, id, body = 'puxada') {
  const dir = join(root, 'staging', `.dl-${id}-${body}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    Buffer.from(`---\nname: ${id}\ndescription: ${body} ✦\n---\n# ${id}\n${body}\n`, 'utf8')
  )
  return dir
}

/** Pastas `.dl-*` que sobraram num staging — pouso vazado é lixo no worktree. */
function landings(staging) {
  try {
    return readdirSync(staging).filter((name) => name.startsWith('.dl-'))
  } catch {
    return []
  }
}

test('downloadSkillFolder pousa no staging, pinado no sha da PASTA', async (t) => {
  const root = sandbox(t, 'download')
  const staging = join(root, 'staging')
  mkdirSync(staging, { recursive: true })
  const { fetchImpl, calls } = githubFake(
    { 'skills/alpha/reference/uso.md': 'como usar' },
    { bom: true }
  )

  const out = await downloadSkillFolder(
    { repo: 'dono/repo', path: 'skills/alpha', ref: 'main' },
    { staging, fetch: fetchImpl }
  )
  assert.equal(out.ok, true, out.error)
  assert.equal(out.download.id, 'alpha')
  assert.equal(out.download.sha, PINNED_SHA)
  assert.equal(out.download.description, 'skill de teste')
  assert.equal(out.download.files, 2)
  assert.ok(out.download.bytes > 0)
  // o pouso mora DENTRO do staging e leva sufixo aleatório: duas frotas puxando
  // a mesma skill não podem colidir num nome previsível
  assert.equal(dirname(out.download.dir), staging)
  assert.ok(basename(out.download.dir).startsWith('.dl-alpha-'))
  assert.notEqual(basename(out.download.dir), '.dl-alpha-')

  const md = readFileSync(join(out.download.dir, 'SKILL.md'))
  assert.notEqual(md[0], 0xef, 'o BOM sobreviveu ao download')
  assert.equal(readFileSync(join(out.download.dir, 'reference', 'uso.md'), 'utf8'), 'como usar')
  // NINGUÉM decidiu destino aqui: a biblioteca da máquina segue intocada
  assert.equal(existsSync(join(root, 'lib')), false)

  const commits = calls.find((url) => url.includes('/commits?'))
  assert.match(commits, /path=skills%2Falpha/u, 'o pin não é da pasta')
  assert.match(commits, /sha=main/u, 'o ref não chegou no pin')
  assert.equal(calls.filter((url) => url.includes('api.github.com')).length, 2, '2 chamadas core')
})

test('um SHA serve de ref — é assim que o dono guarda no MESMO pin (R2)', async (t) => {
  const root = sandbox(t, 'download-sha')
  const staging = join(root, 'staging')
  mkdirSync(staging, { recursive: true })
  const { fetchImpl, calls } = githubFake({})

  const out = await downloadSkillFolder(
    { repo: 'dono/repo', path: 'skills/alpha', ref: PINNED_SHA },
    { staging, fetch: fetchImpl }
  )
  assert.equal(out.ok, true, out.error)
  assert.match(
    calls.find((url) => url.includes('/commits?')),
    new RegExp(`sha=${PINNED_SHA}`, 'u'),
    'o sha não foi usado como ref no pin'
  )
})

test('expectId do catálogo troca a régua: vale o `name:`, não o nome da pasta', async (t) => {
  const root = sandbox(t, 'download-expect')
  const staging = join(root, 'staging')
  mkdirSync(staging, { recursive: true })
  // o caso real da curadoria F6: skills/soft-skill → high-end-visual-design
  const fake = () =>
    githubFake({}, { name: 'high-end-visual-design', prefix: 'skills/soft-skill/' }).fetchImpl
  const source = { repo: 'dono/repo', path: 'skills/soft-skill' }

  const ok = await downloadSkillFolder(source, {
    staging,
    fetch: fake(),
    expectId: 'high-end-visual-design'
  })
  assert.equal(ok.ok, true, ok.error)
  assert.equal(ok.download.id, 'high-end-visual-design')

  // catálogo desatualizado (a fonte virou outra skill) é recusa NOMEADA
  const wrong = await downloadSkillFolder(source, {
    staging,
    fetch: fake(),
    expectId: 'outra-coisa'
  })
  assert.equal(wrong.ok, false)
  assert.match(wrong.error, /o catálogo pede "outra-coisa"/u)
  assert.match(wrong.error, /name: "high-end-visual-design"/u)

  // e SEM expectId a régua volta a ser a spec dos CLIs: pasta == name
  const strict = await downloadSkillFolder(source, { staging, fetch: fake() })
  assert.equal(strict.ok, false)
  assert.match(strict.error, /a pasta apontada chama "soft-skill"/u)
})

test('tree truncada é recusa e não deixa pouso no staging', async (t) => {
  const root = sandbox(t, 'download-truncada')
  const staging = join(root, 'staging')
  mkdirSync(staging, { recursive: true })
  const { fetchImpl } = githubFake({ 'skills/alpha/extra.md': 'x' }, { truncated: true })

  const out = await downloadSkillFolder(
    { repo: 'dono/repo', path: 'skills/alpha' },
    { staging, fetch: fetchImpl }
  )
  assert.equal(out.ok, false)
  assert.match(out.error, /truncou/u)
  assert.match(out.error, /pela metade/u)
  assert.deepEqual(landings(staging), [], 'a recusa deixou pouso para trás')
})

/* ==================================== O HARNESS DO AGENTE NO WORKTREE ==== */

test('materializeAgentSkill escreve nos DOIS alvos com origin agent', (t) => {
  const root = sandbox(t, 'agent-materializa')
  const cwd = join(root, 'worktree')
  mkdirSync(cwd, { recursive: true })
  const source = fakeDownload(root, 'gsap-core')

  const out = materializeAgentSkill(cwd, source, 'gsap-core')
  assert.equal(out.ok, true, out.error)
  assert.deepEqual(out.targets, [CLAUDE_TARGET, CODEX_TARGET])
  assert.equal(out.replaced, false)

  const bytes = readFileSync(join(source, 'SKILL.md'))
  for (const target of [CLAUDE_TARGET, CODEX_TARGET]) {
    assert.deepEqual(readFileSync(join(cwd, target, 'gsap-core', 'SKILL.md')), bytes)
    const manifest = JSON.parse(readFileSync(join(cwd, target, SYNC_MANIFEST), 'utf8'))
    assert.deepEqual(
      manifest.entries.map((entry) => [entry.id, entry.origin]),
      [['gsap-core', 'agent']],
      `${target}: a origem não pousou no manifesto`
    )
  }
  // a pasta-FONTE não é tocada (quem a apaga é quem a criou)
  assert.equal(existsSync(join(source, 'SKILL.md')), true)
  // o pouso do transporte não deixa skill FANTASMA: a pasta-alvo tem só a skill
  // e o manifesto, e `.synkora/skills-sync-tmp` fica vazia (a varredura dela é
  // do sync do kit — aqui ela pode hospedar o staging de outro pull em voo)
  assert.deepEqual(readdirSync(join(cwd, CLAUDE_TARGET)).sort(), [SYNC_MANIFEST, 'gsap-core'])
  assert.deepEqual(readdirSync(join(cwd, '.synkora', 'skills-sync-tmp')), [])

  const shelf = listWorktreeSkills(cwd)
  assert.deepEqual(shelf, [
    {
      id: 'gsap-core',
      origin: 'agent',
      targets: [CLAUDE_TARGET, CODEX_TARGET],
      description: 'puxada ✦'
    }
  ])
})

test('pasta do DONO com o mesmo id é recusa NOMEADA — e nada é escrito', (t) => {
  const root = sandbox(t, 'agent-pasta-do-dono')
  const cwd = join(root, 'worktree')
  mkdirSync(cwd, { recursive: true })
  const source = fakeDownload(root, 'gsap-core')
  // o dono (ou o agente, com as ferramentas dele) já tem uma pasta com esse id
  const dele = join(cwd, CODEX_TARGET, 'gsap-core')
  mkdirSync(dele, { recursive: true })
  const bytes = Buffer.from('---\nname: gsap-core\n---\nMEU, escrito à mão\n', 'utf8')
  writeFileSync(join(dele, 'SKILL.md'), bytes)

  const out = materializeAgentSkill(cwd, source, 'gsap-core')
  assert.equal(out.ok, false)
  assert.match(out.error, /"gsap-core" já existe em \.agents\/skills\//u)
  assert.match(out.error, /não é minha/u)
  assert.match(out.error, /skill_pull/u, 'beco sem saída é bug: a recusa nomeia a receita')
  assert.deepEqual(readFileSync(join(dele, 'SKILL.md')), bytes, 'sobrescreveu a pasta do dono')
  // PRÉ-VOO: o alvo livre também não foi escrito — meio-caminho seria um
  // cardápio diferente por CLI na mesma missão
  assert.equal(existsSync(join(cwd, CLAUDE_TARGET, 'gsap-core')), false)
  assert.equal(existsSync(join(cwd, CLAUDE_TARGET, SYNC_MANIFEST)), false)

  // id fora do padrão nunca vira caminho
  for (const hostil of ['..', '.', 'com/barra', 'com\\barra', 'Com-Maiuscula']) {
    const refused = materializeAgentSkill(cwd, source, hostil)
    assert.equal(refused.ok, false, `${hostil} virou caminho`)
    assert.match(refused.error, /id de skill/u)
  }
})

test('substituir só com a impressão digital: igual troca, EDITADA é recusada', (t) => {
  const root = sandbox(t, 'agent-substitui')
  const cwd = join(root, 'worktree')
  mkdirSync(cwd, { recursive: true })

  assert.equal(materializeAgentSkill(cwd, fakeDownload(root, 'gsap-core', 'v1'), 'gsap-core').ok, true)
  const v2 = fakeDownload(root, 'gsap-core', 'v2')
  const again = materializeAgentSkill(cwd, v2, 'gsap-core')
  assert.equal(again.ok, true, again.error)
  assert.equal(again.replaced, true, 'a troca pela versão nova não aconteceu')
  for (const target of [CLAUDE_TARGET, CODEX_TARGET]) {
    assert.deepEqual(
      readFileSync(join(cwd, target, 'gsap-core', 'SKILL.md')),
      readFileSync(join(v2, 'SKILL.md'))
    )
  }

  // o agente editou a skill puxada: a re-materialização NÃO joga fora o dele
  const editado = join(cwd, CLAUDE_TARGET, 'gsap-core', 'SKILL.md')
  const meu = Buffer.from('---\nname: gsap-core\n---\nEDITADO AQUI DENTRO\n', 'utf8')
  writeFileSync(editado, meu)
  const v3 = fakeDownload(root, 'gsap-core', 'v3')
  const refused = materializeAgentSkill(cwd, v3, 'gsap-core')
  assert.equal(refused.ok, false)
  assert.match(refused.error, /EDITADA depois de puxada/u)
  assert.match(refused.error, /skill_pull/u)
  assert.deepEqual(readFileSync(editado), meu, 'a edição do agente foi por cima')
  // e o outro alvo continua no v2 (o pré-voo recusou antes de escrever)
  assert.deepEqual(
    readFileSync(join(cwd, CODEX_TARGET, 'gsap-core', 'SKILL.md')),
    readFileSync(join(v2, 'SKILL.md'))
  )
})

test('mirrorLocalSkill: o playbook escrito em .claude/skills aparece em .agents/skills', (t) => {
  const root = sandbox(t, 'agent-espelha')
  const cwd = join(root, 'worktree')
  const dir = join(cwd, CLAUDE_TARGET, MISSION_PLAYBOOK_ID)
  mkdirSync(dir, { recursive: true })
  const bytes = Buffer.from(
    `---\nname: ${MISSION_PLAYBOOK_ID}\ndescription: o playbook desta missão\n---\n# direção\n`,
    'utf8'
  )
  writeFileSync(join(dir, 'SKILL.md'), bytes)

  const out = mirrorLocalSkill(cwd, `${CLAUDE_TARGET}/${MISSION_PLAYBOOK_ID}`)
  assert.equal(out.ok, true, out.error)
  assert.equal(out.id, MISSION_PLAYBOOK_ID)
  assert.deepEqual(out.targets, [CLAUDE_TARGET, CODEX_TARGET])
  assert.deepEqual(readFileSync(join(cwd, CODEX_TARGET, MISSION_PLAYBOOK_ID, 'SKILL.md')), bytes)

  // a pasta-FONTE (autoral) não entra no manifesto: o discard não pode apagar o
  // que o agente escreveu à mão
  assert.equal(existsSync(join(cwd, CLAUDE_TARGET, SYNC_MANIFEST)), false)
  const mirrored = JSON.parse(readFileSync(join(cwd, CODEX_TARGET, SYNC_MANIFEST), 'utf8'))
  assert.deepEqual(
    mirrored.entries.map((entry) => [entry.id, entry.origin]),
    [[MISSION_PLAYBOOK_ID, 'agent']]
  )
  assert.deepEqual(listWorktreeSkills(cwd), [
    {
      id: MISSION_PLAYBOOK_ID,
      origin: 'agent',
      targets: [CLAUDE_TARGET, CODEX_TARGET],
      description: 'o playbook desta missão'
    }
  ])

  // o playbook evoluiu: espelhar nsegunda vez re-espelha a versão nova
  const v2 = Buffer.from(
    `---\nname: ${MISSION_PLAYBOOK_ID}\ndescription: o playbook desta missão\n---\n# direção v2\n`,
    'utf8'
  )
  writeFileSync(join(dir, 'SKILL.md'), v2)
  const respelhado = mirrorLocalSkill(cwd, `${CLAUDE_TARGET}/${MISSION_PLAYBOOK_ID}`)
  assert.equal(respelhado.ok, true, respelhado.error)
  assert.deepEqual(readFileSync(join(cwd, CODEX_TARGET, MISSION_PLAYBOOK_ID, 'SKILL.md')), v2)
})

test('mirrorLocalSkill recusa nome divergente, BOM e caminho fora do worktree', (t) => {
  const root = sandbox(t, 'agent-espelha-recusas')
  const cwd = join(root, 'worktree')
  mkdirSync(cwd, { recursive: true })

  const write = (folder, body) => {
    const dir = join(cwd, 'playbooks', folder)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), body)
    return `playbooks/${folder}`
  }

  const divergente = write('meu-plano', '---\nname: outra-coisa\n---\n')
  const nome = mirrorLocalSkill(cwd, divergente)
  assert.equal(nome.ok, false)
  assert.match(nome.error, /a pasta chama "meu-plano"/u)
  assert.match(nome.error, /name: "outra-coisa"/u)

  const comBom = write(
    'com-bom',
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('---\nname: com-bom\n---\n', 'utf8')
    ])
  )
  const bom = mirrorLocalSkill(cwd, comBom)
  assert.equal(bom.ok, false)
  assert.match(bom.error, /BOM/u)
  assert.match(bom.error, /SEM BOM/u, 'a recusa do BOM precisa dizer o que fazer')

  const semSkill = join(cwd, 'playbooks', 'vazia')
  mkdirSync(semSkill, { recursive: true })
  const vazia = mirrorLocalSkill(cwd, 'playbooks/vazia')
  assert.equal(vazia.ok, false)
  assert.match(vazia.error, /não tem SKILL\.md/u)

  for (const hostil of ['../fora', '..', '', '/etc/skills', 'C:/Windows']) {
    const refused = mirrorLocalSkill(cwd, hostil)
    assert.equal(refused.ok, false, `"${hostil}" atravessou`)
    assert.match(refused.error, /caminho inválido|fora do worktree|não achei a pasta/u)
  }
  // nada disso escreveu pasta-alvo nenhuma
  assert.equal(existsSync(join(cwd, CODEX_TARGET)), false)
})

test('a skill do AGENTE sobrevive ao sync do kit e ao chat null', (t) => {
  const root = sandbox(t, 'agent-sobrevive')
  const cwd = join(root, 'worktree')
  const lib = join(root, 'lib')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(lib, { recursive: true })
  seedLibSkill(lib, 'better-writing')
  const kit = [slot('better-writing')]

  syncPaneSkills(cwd, 'dev', { kit, libraryRoot: lib })
  assert.equal(materializeAgentSkill(cwd, fakeDownload(root, 'gsap-core'), 'gsap-core').ok, true)

  // 1) REMONTAGEM DE ABA: o sync do kit passa por cima e não leva o harness
  const again = syncPaneSkills(cwd, 'dev', { kit, libraryRoot: lib })
  assert.equal(again.removed.includes('gsap-core'), false, 'o sync do kit removeu a do agente')
  assert.deepEqual(again.failures, [])
  for (const target of [CLAUDE_TARGET, CODEX_TARGET]) {
    assert.equal(existsSync(join(cwd, target, 'gsap-core', 'SKILL.md')), true, target)
  }

  // 2) `chat: null` (release, pane sem tipo): limpa o KIT e mantém o harness
  const cleared = syncPaneSkills(cwd, null, { libraryRoot: lib })
  assert.deepEqual(cleared.removed, ['better-writing'])
  for (const target of [CLAUDE_TARGET, CODEX_TARGET]) {
    assert.equal(
      existsSync(join(cwd, target, 'gsap-core', 'SKILL.md')),
      true,
      `${target}: chat null apagou a skill puxada pelo agente`
    )
    assert.equal(existsSync(join(cwd, target, 'better-writing')), false)
    const manifest = JSON.parse(readFileSync(join(cwd, target, SYNC_MANIFEST), 'utf8'))
    assert.deepEqual(
      manifest.entries.map((entry) => entry.id),
      ['gsap-core'],
      `${target}: o manifesto perdeu a entrada do agente`
    )
  }

  // 3) o id que o agente puxou TAMBÉM está no kit: a pasta continua dele, o
  // sync não a re-materializa da lib nem a apaga
  seedLibSkill(lib, 'gsap-core', 'da-lib')
  const doKit = syncPaneSkills(cwd, 'dev', { kit: [slot('gsap-core')], libraryRoot: lib })
  assert.deepEqual(doKit.synced, ['gsap-core'])
  assert.deepEqual(doKit.removed, [])
  assert.match(
    readFileSync(join(cwd, CLAUDE_TARGET, 'gsap-core', 'SKILL.md'), 'utf8'),
    /puxada/u,
    'o kit sobrescreveu a versão que o agente pinou'
  )
})

test('discardAgentSkill leva a pasta dos dois alvos e nomeia o que fica', (t) => {
  const root = sandbox(t, 'agent-descarta')
  const cwd = join(root, 'worktree')
  mkdirSync(cwd, { recursive: true })
  assert.equal(materializeAgentSkill(cwd, fakeDownload(root, 'gsap-core'), 'gsap-core').ok, true)

  const out = discardAgentSkill(cwd, 'gsap-core')
  assert.equal(out.ok, true, out.error)
  assert.deepEqual(out.removed, [CLAUDE_TARGET, CODEX_TARGET])
  for (const target of [CLAUDE_TARGET, CODEX_TARGET]) {
    assert.equal(existsSync(join(cwd, target, 'gsap-core')), false, target)
    // manifesto vazio some, e a pasta-alvo vazia volta a não existir
    assert.equal(existsSync(join(cwd, target, SYNC_MANIFEST)), false)
  }
  assert.deepEqual(listWorktreeSkills(cwd), [])

  // descartar de novo é recusa que nomeia a receita de VER a prateleira
  const outra = discardAgentSkill(cwd, 'gsap-core')
  assert.equal(outra.ok, false)
  assert.match(outra.error, /não está entre as skills que este worktree puxou/u)
  assert.match(outra.error, /skill_search/u)

  // pasta do DONO nunca é destruída pelo discard, e a recusa a nomeia
  const dele = join(cwd, CLAUDE_TARGET, 'meu-manual')
  mkdirSync(dele, { recursive: true })
  writeFileSync(join(dele, 'SKILL.md'), '---\nname: meu-manual\n---\n')
  const doDono = discardAgentSkill(cwd, 'meu-manual')
  assert.equal(doDono.ok, false)
  assert.match(doDono.error, /não apaguei nada/u)
  assert.match(doDono.error, /\.claude\/skills\/meu-manual/u)
  assert.equal(existsSync(join(dele, 'SKILL.md')), true)

  assert.equal(discardAgentSkill(cwd, '../fuga').ok, false)
  assert.match(discardAgentSkill(cwd, '../fuga').error, /id de skill/u)

  // MANIFESTO HOSTIL: a entrada se declara `agent` para a pasta do dono. Dizer
  // "é minha" não é prova — só a impressão digital autoriza destruir.
  writeFileSync(
    join(cwd, CLAUDE_TARGET, SYNC_MANIFEST),
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'meu-manual',
          origin: 'agent',
          fingerprint: 'a'.repeat(64),
          dest: { files: 1, bytes: 1, mtimeMs: 1 },
          source: { files: 1, bytes: 1, mtimeMs: 1 }
        }
      ]
    }),
    'utf8'
  )
  const mentiroso = discardAgentSkill(cwd, 'meu-manual')
  assert.equal(mentiroso.ok, false)
  assert.match(mentiroso.error, /não apaguei nada/u)
  assert.match(mentiroso.error, /editada depois de puxada/u)
  assert.equal(existsSync(join(dele, 'SKILL.md')), true, 'o manifesto virou um rm')
  // e paramos de gerenciá-la: o registro mentiroso sai, a pasta fica
  assert.equal(existsSync(join(cwd, CLAUDE_TARGET, SYNC_MANIFEST)), false)
})

test('discardAgentSkills limpa a missão, deixa o kit e o autoral de pé', (t) => {
  const root = sandbox(t, 'agent-descarta-tudo')
  const cwd = join(root, 'worktree')
  const lib = join(root, 'lib')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(lib, { recursive: true })
  seedLibSkill(lib, 'writing-plans')
  syncPaneSkills(cwd, 'planejamento', { kit: [slot('writing-plans')], libraryRoot: lib })
  assert.equal(materializeAgentSkill(cwd, fakeDownload(root, 'gsap-core'), 'gsap-core').ok, true)
  assert.equal(materializeAgentSkill(cwd, fakeDownload(root, 'brainstorming'), 'brainstorming').ok, true)
  // e um playbook AUTORAL, espelhado a partir da pasta do próprio agente
  const autoral = join(cwd, CLAUDE_TARGET, MISSION_PLAYBOOK_ID)
  mkdirSync(autoral, { recursive: true })
  writeFileSync(
    join(autoral, 'SKILL.md'),
    `---\nname: ${MISSION_PLAYBOOK_ID}\ndescription: meu playbook\n---\n`
  )
  assert.equal(mirrorLocalSkill(cwd, `${CLAUDE_TARGET}/${MISSION_PLAYBOOK_ID}`).ok, true)

  const swept = discardAgentSkills(cwd)
  assert.deepEqual(swept.removed, ['brainstorming', 'gsap-core', MISSION_PLAYBOOK_ID])
  assert.deepEqual(swept.kept, [])
  for (const target of [CLAUDE_TARGET, CODEX_TARGET]) {
    assert.equal(existsSync(join(cwd, target, 'gsap-core')), false, target)
    assert.equal(existsSync(join(cwd, target, 'brainstorming')), false, target)
    // o KIT do dono não é alcançado pela limpeza do harness
    assert.equal(existsSync(join(cwd, target, 'writing-plans', 'SKILL.md')), true, target)
  }
  // o ESPELHO sai; a pasta que o agente escreveu à mão fica (é dele)
  assert.equal(existsSync(join(cwd, CODEX_TARGET, MISSION_PLAYBOOK_ID)), false)
  assert.equal(existsSync(join(autoral, 'SKILL.md')), true)

  // worktree sem harness: varredura vazia, nunca exceção
  assert.deepEqual(discardAgentSkills(join(root, 'virgem')), { removed: [], kept: [] })
  assert.deepEqual(discardAgentSkills(''), { removed: [], kept: [] })
})

test('listWorktreeSkills mostra a prateleira viva com as três origens', (t) => {
  const root = sandbox(t, 'agent-prateleira')
  const cwd = join(root, 'worktree')
  const lib = join(root, 'lib')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(lib, { recursive: true })
  assert.deepEqual(listWorktreeSkills(cwd), [], 'worktree virgem tem prateleira vazia')
  assert.deepEqual(listWorktreeSkills(''), [])

  seedLibSkill(lib, 'owasp-security', 'do kit')
  syncPaneSkills(cwd, 'dev', { kit: [slot('owasp-security')], libraryRoot: lib })
  assert.equal(materializeAgentSkill(cwd, fakeDownload(root, 'gsap-core'), 'gsap-core').ok, true)
  const dele = join(cwd, CLAUDE_TARGET, 'meu-manual')
  mkdirSync(dele, { recursive: true })
  writeFileSync(join(dele, 'SKILL.md'), '---\nname: meu-manual\ndescription: escrito à mão\n---\n')

  assert.deepEqual(listWorktreeSkills(cwd), [
    { id: 'gsap-core', origin: 'agent', targets: [CLAUDE_TARGET, CODEX_TARGET], description: 'puxada ✦' },
    { id: 'meu-manual', origin: 'user', targets: [CLAUDE_TARGET], description: 'escrito à mão' },
    {
      id: 'owasp-security',
      origin: 'kit',
      targets: [CLAUDE_TARGET, CODEX_TARGET],
      description: 'ação — do kit ✦'
    }
  ])
})

/* ============================================================== RASTRO ==== */

test('harness.json: ida e volta, re-pull revive e o descarte carimba', (t) => {
  const root = sandbox(t, 'harness')
  const cwd = join(root, 'worktree')
  mkdirSync(cwd, { recursive: true })

  assert.deepEqual(readSkillHarness(cwd), { version: 1, entries: [] }, 'missão nova tem harness vazio')
  assert.deepEqual(readSkillHarness(''), { version: 1, entries: [] })
  assert.deepEqual(readSkillHarness(join(root, 'nao-existe')), { version: 1, entries: [] })

  const first = recordSkillPull(cwd, {
    id: 'gsap-core',
    origin: 'catalog',
    repo: 'dono/repo',
    path: 'skills/gsap-core',
    sha: 'c0ffee1234567890abcdef',
    description: 'animação com GSAP',
    by: 'gui-dev-ab12cd34'
  })
  assert.equal(first.entries.length, 1)
  assert.equal(first.entries[0].id, 'gsap-core')
  assert.ok(first.entries[0].pulledAt.endsWith('Z'), 'pulledAt não é ISO')
  assert.equal(first.entries[0].by, 'gui-dev-ab12cd34')

  const file = join(cwd, SKILL_HARNESS_FILE)
  assert.equal(existsSync(file), true, `o rastro não pousou em ${SKILL_HARNESS_FILE}`)
  assert.equal(existsSync(`${file}.bak`), false, 'o rastro é re-derivável: nada de .bak no worktree')
  assert.deepEqual(
    readdirSync(join(cwd, '.synkora')).filter((name) => name.includes('.tmp-')),
    [],
    'a escrita atômica deixou temporário para trás'
  )
  assert.deepEqual(readSkillHarness(cwd), first)

  // DESCARTOU: a linha fica, carimbada — "puxei e descartei" é história do dono
  const discarded = recordSkillDiscard(cwd, 'gsap-core')
  assert.equal(discarded.entries.length, 1)
  assert.ok(discarded.entries[0].discardedAt)
  assert.deepEqual(liveHarnessEntries(discarded), [])
  // descarte de quem nunca foi puxado não inventa linha
  assert.deepEqual(recordSkillDiscard(cwd, 'nunca-puxada').entries.length, 1)

  // RE-PULL revive a MESMA linha (não cria uma segunda) e atualiza o pin
  const revived = recordSkillPull(cwd, {
    id: 'gsap-core',
    origin: 'url',
    repo: 'dono/repo',
    sha: 'facade9876543210',
    by: 'ajudante-1'
  })
  assert.equal(revived.entries.length, 1)
  assert.equal(revived.entries[0].discardedAt, undefined, 'o re-pull não reviveu a linha')
  assert.equal(revived.entries[0].sha, 'facade9876543210')
  assert.equal(revived.entries[0].origin, 'url')
  assert.equal(liveHarnessEntries(revived).length, 1)
})

test('harness.json é entrada NÃO confiável: lixo degrada para vazio, texto é cortado', (t) => {
  const root = sandbox(t, 'harness-hostil')
  const cwd = join(root, 'worktree')
  mkdirSync(join(cwd, '.synkora'), { recursive: true })
  const file = join(cwd, SKILL_HARNESS_FILE)

  writeFileSync(file, '{{{ não é json', 'utf8')
  assert.deepEqual(readSkillHarness(cwd), { version: 1, entries: [] })
  writeFileSync(file, JSON.stringify({ version: 2, entries: [{ id: 'x' }] }), 'utf8')
  assert.deepEqual(readSkillHarness(cwd), { version: 1, entries: [] }, 'versão futura entrou')

  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      entries: [
        { id: '../fuga', origin: 'url', pulledAt: 'x', by: 'y' },
        { id: 'Com-Maiuscula', origin: 'url', pulledAt: 'x', by: 'y' },
        null,
        { id: 'boa', origin: 'inventada', description: 'd'.repeat(900), by: 'b'.repeat(400) },
        { id: 'boa', origin: 'url', by: 'duplicada' }
      ]
    }),
    'utf8'
  )
  const harness = readSkillHarness(cwd)
  assert.deepEqual(
    harness.entries.map((entry) => entry.id),
    ['boa'],
    'id hostil ou duplicado entrou no rastro'
  )
  assert.equal(harness.entries[0].origin, 'url', 'origem inventada não degradou')
  assert.ok(harness.entries[0].description.length <= 301)
  assert.ok(harness.entries[0].by.length <= 141)
  assert.ok(harness.entries[0].pulledAt.endsWith('Z'))
  // e um pull sobre arquivo podre reconstrói o rastro em vez de morrer
  const healed = recordSkillPull(cwd, { id: 'gsap-core', origin: 'library', by: 'gui-dev-1' })
  assert.deepEqual(
    healed.entries.map((entry) => entry.id),
    ['boa', 'gsap-core']
  )
  assert.deepEqual(recordSkillPull('', { id: 'x', origin: 'url', by: 'y' }).entries, [])
})

test('as notas do fio nomeiam a procedência de cada origem', () => {
  const base = { pulledAt: '2026-09-08T12:00:00.000Z', by: 'gui-dev-1' }
  assert.equal(
    skillPullNoteText({ ...base, id: 'gsap-core', origin: 'url', repo: 'dono/repo', sha: 'c0ffee1234567' }),
    '❖ skill puxada pelo agente: gsap-core · dono/repo @ c0ffee1'
  )
  assert.equal(
    skillPullNoteText({ ...base, id: 'gsap-core', origin: 'catalog', repo: 'dono/repo', sha: 'abcdef7890' }),
    '❖ skill puxada pelo agente: gsap-core · dono/repo @ abcdef7'
  )
  assert.equal(
    skillPullNoteText({ ...base, id: 'grilling', origin: 'library' }),
    '❖ skill puxada da biblioteca: grilling'
  )
  assert.equal(
    skillPullNoteText({ ...base, id: MISSION_PLAYBOOK_ID, origin: 'authored' }),
    `❖ playbook da missão escrito pelo agente: ${MISSION_PLAYBOOK_ID}`
  )
  // sem sha (procedência incompleta) a nota não INVENTA pin nenhum
  assert.equal(
    skillPullNoteText({ ...base, id: 'gsap-core', origin: 'url', repo: 'dono/repo' }),
    '❖ skill puxada pelo agente: gsap-core · dono/repo'
  )
  assert.equal(skillDiscardNoteText('gsap-core'), '❖ skill descartada: gsap-core')
})

test('o briefing do ajudante lista o que a missão puxou, playbook PRIMEIRO', (t) => {
  const root = sandbox(t, 'harness-briefing')
  const cwd = join(root, 'worktree')
  mkdirSync(cwd, { recursive: true })
  assert.equal(missionHarnessBriefing(cwd), undefined, 'missão sem harness ganhou bloco vazio')

  recordSkillPull(cwd, {
    id: 'gsap-core',
    origin: 'catalog',
    repo: 'dono/repo',
    sha: 'c0ffee1234567',
    description: 'animação com GSAP',
    by: 'gui-dev-1'
  })
  recordSkillPull(cwd, {
    id: 'brainstorming',
    origin: 'library',
    description: 'abrir o leque antes de decidir',
    by: 'gui-dev-1'
  })
  recordSkillPull(cwd, {
    id: MISSION_PLAYBOOK_ID,
    origin: 'authored',
    description: 'a direção desta missão',
    by: 'gui-dev-1'
  })
  recordSkillPull(cwd, { id: 'owasp-security', origin: 'library', by: 'gui-dev-1' })
  recordSkillDiscard(cwd, 'owasp-security')

  const briefing = missionHarnessBriefing(cwd)
  const lines = briefing.split('\n')
  assert.equal(
    lines[0],
    'SKILLS THIS MISSION ALREADY PULLED — they are in your skills folder, load them by name:'
  )
  assert.equal(
    lines[1],
    `- ${MISSION_PLAYBOOK_ID} — a direção desta missão (the mission's own playbook: read it FIRST)`
  )
  assert.equal(lines[2], '- gsap-core — animação com GSAP (dono/repo @ c0ffee1)')
  assert.equal(lines[3], '- brainstorming — abrir o leque antes de decidir')
  assert.equal(lines.length, 4, 'a skill descartada entrou no briefing')
})
