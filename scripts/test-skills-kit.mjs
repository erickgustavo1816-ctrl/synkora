// SKILLS 2.0 — A CERCA DO MOTOR (kit, biblioteca, sync, instalação, poda).
//
// Contrato: `.synkora/reports/DESIGN_SKILLS_2_0_BUILD_2026-08-29.md` (§Gate) +
// os ADRs 0002/0004/0005/0007. Módulos sob teste (compilados por `tsc` como as
// suítes irmãs, ver o script `test:skills-kit` no package.json):
//
//   src/main/skillsKit.ts          o DADO do cardápio + a LEI da persona
//   src/main/skillsLibraryScan.ts  a lib do disco e o manifest.json
//   src/main/skillsInstall.ts      instalar por URL pinada (a única rede)
//   src/main/skillsPrune.ts        a poda por gesto explícito
//   src/main/skillsSync.ts         o transporte para o worktree
//
// O QUE ESTA SUÍTE PRENDE (e por que cada cerca existe):
//
//  1. A LEI VOLTA SEMPRE. Desligar/remover `impeccable` é recusado NOMEANDO a
//     receita, e um `skills-kit.json` editado à mão que perdeu (ou desligou) a
//     lei a recebe de volta na leitura. Uma implementação que só faça
//     `JSON.parse` do arquivo passa no resto e MORRE aqui.
//  2. DESLIGAR NÃO É AUTORIZAR APAGAR. A poda protege por `allKitSkillIds`
//     (todo id citado), não por `kitForChat` (só os habilitados).
//  3. O QUE É DO DONO NÃO SE TOCA. Pasta que o dono pôs à mão no worktree — ou
//     a nossa que ele editou — nunca é sobrescrita nem apagada pelo sync.
//  4. NADA DE REDE. O instalador roda inteiro com `fetch` injetado; nenhum teste
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
import { join } from 'node:path'
import test from 'node:test'

import {
  SkillsKitStore,
  allKitSkillIds,
  attachSkillsKitRecorder,
  isSkillId,
  kitForChat,
  seedSkillsKit,
  skillsLawRefusal,
  SKILLS_LAW_ID
} from '../.tmp/skills-kit-test/skillsKit.js'
import {
  parseSkillFrontmatter,
  scanSkillsLibrary
} from '../.tmp/skills-kit-test/skillsLibraryScan.js'
import {
  installSkillFromUrl,
  parseSkillFolderUrl
} from '../.tmp/skills-kit-test/skillsInstall.js'
import { pruneSkillsLibrary } from '../.tmp/skills-kit-test/skillsPrune.js'
import {
  SKILL_SYNC_TARGETS,
  skillsSyncNoteText,
  syncPaneSkills
} from '../.tmp/skills-kit-test/skillsSync.js'

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
  assert.deepEqual(
    state.dev.execucao.map((entry) => entry.id),
    [
      'impeccable',
      'synkora-investigacao',
      'synkora-codigo-limpo',
      'test-driven-development',
      'systematic-debugging',
      'verification-before-completion',
      'nodejs-backend-patterns',
      'supabase-postgres-best-practices',
      'owasp-security',
      'better-writing'
    ]
  )
  assert.deepEqual(
    state.dev.orquestracao.map((entry) => entry.id),
    ['writing-plans', 'resolving-merge-conflicts']
  )
  assert.deepEqual(
    state.planejamento.map((entry) => entry.id),
    [
      'brainstorming',
      'domain-modeling',
      'codebase-design',
      'architecture-decision-records',
      'writing-plans'
    ]
  )
  // 17 slots, 16 skills DISTINTAS: `writing-plans` serve duas ocasiões (uma na
  // ala orquestração do dev, outra no planejamento) e a pasta é uma só.
  assert.equal(state.dev.execucao.length + state.dev.orquestracao.length + state.planejamento.length, 17)
  assert.equal(allKitSkillIds(state).size, 16)

  // toda ocasião é texto útil: slot sem ocasião é ficha muda na tela
  for (const entry of [...state.dev.execucao, ...state.dev.orquestracao, ...state.planejamento]) {
    assert.ok(entry.occasion.trim().length > 3, `ocasião vazia em ${entry.id}`)
    assert.equal(entry.enabled, true)
  }

  // a LEI nasce carimbada e é a primeira da ala execução
  assert.equal(state.dev.execucao[0].id, SKILLS_LAW_ID)
  assert.equal(state.dev.execucao[0].law, true)
  assert.equal(state.dev.execucao.filter((entry) => entry.law).length, 1, 'v1 tem UMA lei')

  assert.ok(existsSync(file), 'o arquivo nasce na primeira leitura, sem clique nenhum')
  assert.ok(existsSync(`${file}.bak`), 'jsonStore grava o .bak junto')
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.dev.execucao[0].law, true)
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
  assert.equal(again.dev.execucao.length, 10)
})

/* ================================================================= LEI ==== */

test('a lei recusa desligar e recusa sair, e a recusa NOMEIA a receita', (t) => {
  const root = sandbox(t, 'lei')
  const file = join(root, 'skills-kit.json')
  const store = new SkillsKitStore(file)

  const off = store.setSlotEnabled('dev', SKILLS_LAW_ID, false)
  assert.equal(off.ok, false)
  assert.equal(off.error, skillsLawRefusal(SKILLS_LAW_ID))
  assert.match(off.error, /LEI da persona/u)
  assert.match(off.error, /commit no seed de src\/main\/skillsKit\.ts/u, 'beco sem saída é bug')
  assert.equal(off.state.dev.execucao[0].enabled, true, 'a recusa devolve o estado intacto')

  const gone = store.removeSlot('dev', SKILLS_LAW_ID)
  assert.equal(gone.ok, false)
  assert.equal(gone.error, skillsLawRefusal(SKILLS_LAW_ID))

  // e o disco também não mudou: a recusa acontece ANTES do commit
  const persisted = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(persisted.dev.execucao[0].id, SKILLS_LAW_ID)
  assert.equal(persisted.dev.execucao[0].enabled, true)
})

test('lei APAGADA à mão volta na leitura seguinte, com sinal', (t) => {
  const root = sandbox(t, 'lei-apagada')
  const file = join(root, 'skills-kit.json')
  new SkillsKitStore(file)

  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.dev.execucao = raw.dev.execucao.filter((entry) => entry.id !== SKILLS_LAW_ID)
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')
  assert.equal(
    JSON.parse(readFileSync(file, 'utf8')).dev.execucao.some((e) => e.id === SKILLS_LAW_ID),
    false,
    'o arquivo doutorado precisa MESMO estar sem a lei'
  )

  const marker = signals.length
  const healed = new SkillsKitStore(file).state()
  assert.equal(healed.dev.execucao[0].id, SKILLS_LAW_ID)
  assert.equal(healed.dev.execucao[0].law, true)
  assert.equal(healed.dev.execucao[0].enabled, true)
  assert.ok(signals.length > marker, 'a cura da lei é muda')
  assert.equal(signals.at(-1).event, 'skills-kit-degraded')
  // a cura POUSA no disco: o próximo boot já encontra a lei de volta
  assert.equal(
    JSON.parse(readFileSync(file, 'utf8')).dev.execucao[0].id,
    SKILLS_LAW_ID,
    'a lei voltou só na memória'
  )
})

test('lei DESLIGADA à mão volta ligada; e o arquivo não promove ninguém a lei', (t) => {
  const root = sandbox(t, 'lei-desligada')
  const file = join(root, 'skills-kit.json')
  new SkillsKitStore(file)

  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.dev.execucao[0].enabled = false
  // e uma tentativa de PROMOVER outra skill a lei, editando userData
  raw.dev.execucao[1].law = true
  raw.planejamento[0].law = true
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')

  const healed = new SkillsKitStore(file).state()
  assert.equal(healed.dev.execucao[0].enabled, true, 'a lei ficou desligada')
  assert.equal(healed.dev.execucao[0].law, true)
  assert.equal(healed.dev.execucao[1].law, undefined, 'o arquivo promoveu uma skill a lei')
  assert.equal(healed.planejamento[0].law, undefined)
  // e a falsa lei continua desligável: quem manda é o código, não o JSON
  const store = new SkillsKitStore(file)
  assert.equal(store.setSlotEnabled('dev', healed.dev.execucao[1].id, false).ok, true)
  assert.equal(store.removeSlot('planejamento', healed.planejamento[0].id).ok, true)
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
  assert.equal(dev.length, 11)

  const planejamento = kitForChat(state, 'planejamento')
  assert.deepEqual(
    planejamento.map((entry) => entry.id),
    [
      'brainstorming',
      'domain-modeling',
      'codebase-design',
      'architecture-decision-records',
      'writing-plans'
    ]
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
  assert.equal(state.dev.execucao.length, 10)
  assert.equal(state.dev.execucao[0].id, SKILLS_LAW_ID)
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
  raw.planejamento.push({ id: 'brainstorming', occasion: 'duplicada' })
  raw.dev.orquestracao.push(42)
  writeFileSync(file, JSON.stringify(raw), 'utf8')

  const marker = signals.length
  const state = new SkillsKitStore(file).state()
  assert.equal(
    state.planejamento.some((entry) => entry.id === 'skill-do-dono'),
    true,
    'o slot do dono morreu junto com o lixo'
  )
  assert.equal(state.planejamento.filter((entry) => entry.id === 'brainstorming').length, 1)
  assert.equal(state.planejamento.length, 6, 'sobraram os 5 do seed + o do dono')
  assert.equal(state.dev.orquestracao.length, 2)
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
