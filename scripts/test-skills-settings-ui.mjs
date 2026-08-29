// SKILLS 2.0 — A CERCA DA TELA (Ajustes ▸ Skills).
//
// Módulo sob teste: `src/renderer/src/skillsSettingsModel.ts` — tudo o que a
// tela DECIDE mora lá fora do React, e é por isso que dá para prender aqui em
// node puro (padrão das suítes de UI da casa: `--experimental-strip-types`).
//
// O QUE ESTA SUÍTE PRENDE:
//
//  1. AS TRÊS ALAS EXISTEM SEMPRE. Ala sem slot é ala VAZIA na tela (com a
//     saída: adicionar da biblioteca) — nunca uma ala que SOME, porque ala que
//     some parece ala que não existe.
//  2. A LEI CONTA MESMO SEM TOGGLE. `chatActiveCount` soma o slot `law` ainda
//     que o `enabled` chegue falso: ela vai para a conversa por doutrina.
//  3. O ✓ DA BIBLIOTECA SAI DO KIT VIVO, não do retrato que veio junto da
//     lista — trocar um slot não precisa de ida ao disco para a lista mudar.
//  4. TODA RECUSA NOMEIA A SAÍDA (regra da casa: beco sem saída é bug), tanto
//     na adição ao kit quanto na guarda da URL de instalação.
//
// A última cerca lê o COMPONENTE como texto para provar que a ficha da lei não
// tem o que clicar — o modelo sozinho não garante isso.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  OCCASION_MAX,
  SKILLS_BOM_NOTE,
  SKILLS_KIT_RULE,
  SKILLS_LAW_BADGE,
  SKILLS_LAW_NOTE,
  chatActiveCount,
  chatLabel,
  chatSlotCount,
  checkKitAddition,
  checkSkillFolderUrl,
  isInChatKit,
  kitChatBlocks,
  kitGroups,
  kitSkillIds,
  libraryRows,
  matchesSkillQuery,
  prunableSkillIds,
  skillsWithBom,
  wingLabel
} from '../src/renderer/src/skillsSettingsModel.ts'

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

/* ------------------------------------------------------------- fixturas -- */

/** O kit como a tela o recebe do preload (espelho de `SkillsKitState`). */
function kitFixture() {
  return {
    version: 1,
    dev: {
      execucao: [
        { id: 'impeccable', occasion: 'mexer em UI (a lei da persona)', enabled: true, law: true },
        { id: 'synkora-investigacao', occasion: 'investigar antes de mexer', enabled: true },
        { id: 'owasp-security', occasion: 'segurança', enabled: false }
      ],
      orquestracao: [
        { id: 'writing-plans', occasion: 'destrinchar/planejar a frota', enabled: true }
      ]
    },
    planejamento: [
      { id: 'brainstorming', occasion: 'entrevistar/descobrir', enabled: true },
      { id: 'writing-plans', occasion: 'escrever o plano', enabled: false }
    ]
  }
}

const EMPTY_KIT = { version: 1, dev: { execucao: [], orquestracao: [] }, planejamento: [] }

function libraryFixture() {
  return [
    {
      id: 'synkora-investigacao',
      description: 'Investigação profunda antes de encostar no código',
      hasBom: false,
      inKit: false
    },
    { id: 'better-writing', description: 'Copy de interface', hasBom: false, inKit: true },
    {
      id: 'supabase-postgres-best-practices',
      description: 'Banco de dados: padrões de Postgres',
      hasBom: true,
      inKit: false
    },
    { id: 'agente-velho', description: 'subagente da era F6 (agent.md)', hasBom: false, inKit: true }
  ]
}

/* ============================================================== GRUPOS ==== */

test('o kit vira SEMPRE as três alas — inclusive vazio e inclusive nulo', () => {
  for (const kit of [null, EMPTY_KIT, kitFixture()]) {
    const groups = kitGroups(kit)
    assert.deepEqual(
      groups.map((group) => group.key),
      ['dev:execucao', 'dev:orquestracao', 'planejamento'],
      'uma ala sumiu da tela'
    )
    assert.deepEqual(
      groups.map((group) => group.chat),
      ['dev', 'dev', 'planejamento']
    )
    assert.deepEqual(
      groups.map((group) => group.wing),
      ['execucao', 'orquestracao', null]
    )
    for (const group of groups) assert.ok(Array.isArray(group.slots))
  }

  const vazio = kitGroups(EMPTY_KIT)
  assert.deepEqual(vazio.map((group) => group.slots.length), [0, 0, 0])

  // as duas alas do dev se explicam; o planejamento não repete o título do bloco
  const [execucao, orquestracao, planejamento] = kitGroups(kitFixture())
  assert.match(execucao.label, /execução/u)
  assert.ok(execucao.hint.trim().length > 0)
  assert.match(orquestracao.label, /orquestração/u)
  assert.ok(orquestracao.hint.trim().length > 0)
  assert.equal(planejamento.label, '')
  assert.equal(planejamento.hint, '')
  assert.deepEqual(
    execucao.slots.map((slot) => slot.id),
    ['impeccable', 'synkora-investigacao', 'owasp-security']
  )
})

test('kitChatBlocks aninha por CONVERSA: as duas alas do dev são a mesma pasta', () => {
  const blocks = kitChatBlocks(kitFixture())
  assert.deepEqual(
    blocks.map((block) => block.chat),
    ['dev', 'planejamento']
  )
  assert.deepEqual(
    blocks[0].groups.map((group) => group.key),
    ['dev:execucao', 'dev:orquestracao'],
    'as alas do dev viraram conversas irmãs'
  )
  assert.deepEqual(
    blocks[1].groups.map((group) => group.key),
    ['planejamento']
  )
  // o bloco diz ONDE a conversa nasce — é a pasta que recebe o kit
  assert.match(blocks[0].hint, /worktree/u)
  assert.match(blocks[1].hint, /raiz do projeto/u)
  for (const block of blocks) assert.ok(block.label.trim().length > 0)

  // e as três alas continuam existindo com kit vazio
  const vazio = kitChatBlocks(EMPTY_KIT)
  assert.deepEqual(vazio.map((block) => block.groups.length), [2, 1])
})

test('a conta do bloco: a LEI entra mesmo com `enabled` falso, o desligado não', () => {
  const [dev, planejamento] = kitChatBlocks(kitFixture())
  assert.equal(chatSlotCount(dev), 4)
  // impeccable (lei) + synkora-investigacao + writing-plans; owasp está desligado
  assert.equal(chatActiveCount(dev), 3)
  assert.equal(chatSlotCount(planejamento), 2)
  assert.equal(chatActiveCount(planejamento), 1)

  // A LEI NÃO TEM TOGGLE: se um estado torto chegar com `enabled: false`, ela
  // ainda vai para a conversa — o store a reacende na leitura, e a tela não
  // pode dizer ao dono que ela ficou de fora.
  const torto = kitFixture()
  torto.dev.execucao[0].enabled = false
  const [devTorto] = kitChatBlocks(torto)
  assert.equal(chatActiveCount(devTorto), 3, 'a lei sumiu da conta por causa do `enabled`')

  assert.equal(chatSlotCount(kitChatBlocks(EMPTY_KIT)[0]), 0)
  assert.equal(chatActiveCount(kitChatBlocks(EMPTY_KIT)[0]), 0)
})

test('kitSkillIds e isInChatKit falam do kit inteiro, ligado ou não', () => {
  const kit = kitFixture()
  assert.deepEqual(kitSkillIds(kit), [
    'brainstorming',
    'impeccable',
    'owasp-security',
    'synkora-investigacao',
    'writing-plans'
  ])
  assert.deepEqual(kitSkillIds(null), [])

  // dev = as DUAS alas
  assert.equal(isInChatKit(kit, 'dev', 'writing-plans'), true)
  assert.equal(isInChatKit(kit, 'dev', 'owasp-security'), true, 'slot desligado sumiu da conta')
  assert.equal(isInChatKit(kit, 'planejamento', 'owasp-security'), false)
  assert.equal(isInChatKit(kit, 'planejamento', 'writing-plans'), true)
})

/* =============================================================== LISTA ==== */

test('a busca dobra acento e exige TODOS os termos', () => {
  const [investigacao, , supabase] = libraryFixture()
  assert.equal(matchesSkillQuery(investigacao, 'investigação'), true, 'acento na BUSCA')
  assert.equal(matchesSkillQuery(investigacao, 'INVESTIGACAO'), true)
  assert.equal(matchesSkillQuery(investigacao, 'profunda encostar'), true)
  assert.equal(matchesSkillQuery(investigacao, 'profunda inexistente'), false)
  assert.equal(matchesSkillQuery(investigacao, '   '), true, 'busca vazia mostra tudo')
  // acha pela DESCRIÇÃO: o dono lembra do assunto, não do nome da pasta
  assert.equal(matchesSkillQuery(supabase, 'banco de dados'), true)
  assert.equal(matchesSkillQuery(supabase, 'postgres'), true)
})

test('libraryRows re-deriva o ✓ do kit VIVO e ordena por id', () => {
  const rows = libraryRows(libraryFixture(), kitFixture(), '')
  assert.deepEqual(
    rows.map((row) => row.id),
    ['agente-velho', 'better-writing', 'supabase-postgres-best-practices', 'synkora-investigacao']
  )
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]))
  // o retrato que veio na lista dizia inKit:false — o kit vivo diz que SIM
  assert.equal(byId['synkora-investigacao'].inKit, true, 'o ✓ não seguiu o kit vivo')
  // e o contrário: o retrato dizia true, o kit vivo não tem slot para ela
  assert.equal(byId['better-writing'].inKit, false, 'o ✓ ficou preso ao retrato antigo')
  assert.equal(byId['agente-velho'].inKit, false)
  // a fonte não é mutada
  assert.equal(libraryFixture()[0].inKit, false)

  // sem kit (ainda carregando) a linha usa o que veio no retrato
  const semKit = libraryRows(libraryFixture(), null, '')
  assert.equal(semKit.find((row) => row.id === 'better-writing').inKit, true)

  // a busca filtra as linhas, não muda o ✓
  const filtradas = libraryRows(libraryFixture(), kitFixture(), 'investigação')
  assert.deepEqual(
    filtradas.map((row) => row.id),
    ['synkora-investigacao']
  )
  assert.equal(filtradas[0].inKit, true)
})

test('a tela sabe quem tem BOM e quantas pastas a PODA leva', () => {
  assert.deepEqual(skillsWithBom(libraryFixture()), ['supabase-postgres-best-practices'])
  assert.match(SKILLS_BOM_NOTE, /BOM/u)
  assert.match(SKILLS_BOM_NOTE, /Reinstale por URL/u, 'a nota do BOM precisa dar a saída')

  // a poda leva o que NENHUM slot cita — habilitado ou não
  assert.deepEqual(prunableSkillIds(libraryFixture(), kitFixture()), [
    'agente-velho',
    'better-writing',
    'supabase-postgres-best-practices'
  ])
  // sem kit conhecido, a poda não "leva tudo" por otimismo: ela é derivada do
  // que a tela sabe, e o que ela sabe é a lista inteira
  assert.equal(prunableSkillIds(libraryFixture(), EMPTY_KIT).length, 4)
})

/* ==================================================== ADICIONAR AO KIT ==== */

test('as recusas de adicionar ao kit nomeiam a saída', () => {
  const kit = kitFixture()

  const semSkill = checkKitAddition({ id: '  ', chat: 'dev', wing: 'execucao', occasion: 'x' }, kit)
  assert.equal(semSkill.ok, false)
  assert.match(semSkill.error, /escolha uma skill da biblioteca/u)

  const semOcasiao = checkKitAddition(
    { id: 'domain-modeling', chat: 'dev', wing: 'execucao', occasion: '   ' },
    kit
  )
  assert.equal(semOcasiao.ok, false)
  assert.match(semOcasiao.error, /OCASIÃO/u)
  assert.match(semOcasiao.error, /ex\.:/u, 'a recusa mostra um exemplo do que escrever')

  const gigante = checkKitAddition(
    {
      id: 'domain-modeling',
      chat: 'dev',
      wing: 'execucao',
      occasion: 'o'.repeat(OCCASION_MAX + 1)
    },
    kit
  )
  assert.equal(gigante.ok, false)
  assert.match(gigante.error, new RegExp(`passou de ${OCCASION_MAX} caracteres`, 'u'))
  assert.match(gigante.error, /encurte/u)

  // slot repetido no MESMO chat (a ala não importa: dev é uma pasta só)
  const repetida = checkKitAddition(
    { id: 'writing-plans', chat: 'dev', wing: 'execucao', occasion: 'de novo' },
    kit
  )
  assert.equal(repetida.ok, false)
  assert.match(repetida.error, /já tem slot no kit de dev/u)
  assert.match(repetida.error, /edite o slot que existe/u)
})

test('a adição aprovada sai limpa, e a ala só existe no dev', () => {
  const kit = kitFixture()
  const dev = checkKitAddition(
    { id: '  domain-modeling ', chat: 'dev', wing: 'orquestracao', occasion: '  integrar   as fatias  ' },
    kit
  )
  assert.deepEqual(dev, {
    ok: true,
    id: 'domain-modeling',
    chat: 'dev',
    wing: 'orquestracao',
    occasion: 'integrar as fatias'
  })

  const planejamento = checkKitAddition(
    { id: 'codebase-design', chat: 'planejamento', wing: 'execucao', occasion: 'desenhar' },
    kit
  )
  assert.deepEqual(planejamento, {
    ok: true,
    id: 'codebase-design',
    chat: 'planejamento',
    occasion: 'desenhar'
  })
  assert.equal('wing' in planejamento, false, 'o planejamento não tem alas')

  // a mesma skill pode ter slot nos DOIS chats (ocasiões diferentes)
  const outroChat = checkKitAddition(
    { id: 'owasp-security', chat: 'planejamento', wing: 'execucao', occasion: 'pensar em risco' },
    kit
  )
  assert.equal(outroChat.ok, true)

  assert.equal(chatLabel('dev'), 'dev')
  assert.equal(chatLabel('planejamento'), 'planejamento')
  assert.equal(wingLabel('execucao'), 'execução')
  assert.equal(wingLabel('orquestracao'), 'orquestração')
})

/* ==================================================== INSTALAR POR URL ==== */

test('a guarda da URL aceita a PASTA da skill e a RAIZ do repositório', () => {
  const pasta = checkSkillFolderUrl('https://github.com/dono/repo/tree/main/skills/alpha')
  assert.deepEqual(pasta, {
    ok: true,
    url: 'https://github.com/dono/repo/tree/main/skills/alpha',
    folder: 'alpha'
  })

  // `<ref>` do GitHub pode ter barra: a URL sozinha não separa ref de caminho,
  // e quem desata o nó é o main (com a API). Aqui basta existir ALGO depois.
  const comBarra = checkSkillFolderUrl('https://github.com/dono/repo/tree/feat/x/skills/alpha')
  assert.equal(comBarra.ok, true)
  assert.equal(comBarra.folder, 'alpha')

  // A SKILL QUE MORA NA RAIZ do repo (caso real: temporal-developer).
  for (const raw of [
    'https://github.com/dono/repo',
    'https://www.github.com/dono/repo',
    'github.com/dono/repo',
    'https://github.com/dono/repo/'
  ]) {
    const raiz = checkSkillFolderUrl(raw)
    assert.equal(raiz.ok, true, `recusou a raiz do repo: ${raw}`)
    assert.equal(raiz.url, 'https://github.com/dono/repo')
    assert.equal(raiz.folder, '', 'a raiz não tem pasta — o id sai do frontmatter')
  }
})

test('a guarda da URL recusa arquivo, host estranho e raiz de tree', () => {
  const vazia = checkSkillFolderUrl('   ')
  assert.equal(vazia.ok, false)
  assert.match(vazia.error, /tree\/<ref>\/<caminho>/u)

  const arquivo = checkSkillFolderUrl('https://github.com/dono/repo/blob/main/skills/a/SKILL.md')
  assert.equal(arquivo.ok, false)
  assert.match(arquivo.error, /ARQUIVO/u)
  assert.match(arquivo.error, /abra a PASTA da skill/u, 'a recusa do blob precisa dar a saída')

  const outroHost = checkSkillFolderUrl('https://gitlab.com/dono/repo/tree/main/skills/alpha')
  assert.equal(outroHost.ok, false)
  assert.match(outroHost.error, /só github\.com/u)

  const semPasta = checkSkillFolderUrl('https://github.com/dono/repo/tree/main')
  assert.equal(semPasta.ok, false)
  assert.match(semPasta.error, /raiz do repositório/u)
  assert.match(semPasta.error, /abra a pasta da skill/u)

  const semRepo = checkSkillFolderUrl('https://github.com/dono')
  assert.equal(semRepo.ok, false)
  assert.match(semRepo.error, /faltou o repositório/u)

  const marcadorEstranho = checkSkillFolderUrl('https://github.com/dono/repo/issues/12')
  assert.equal(marcadorEstranho.ok, false)
  assert.match(marcadorEstranho.error, /aponte para uma pasta/u)

  const naoEhUrl = checkSkillFolderUrl('não é url nenhuma')
  assert.equal(naoEhUrl.ok, false)
  assert.match(naoEhUrl.error, /não é uma URL|endereço completo/u)
})

/* ============================================================== A REGRA === */

test('a regra visível e a doutrina da lei existem, escritas para o dono', () => {
  // ADR-0006: o kit é lido no SPAWN. Sem esta frase na tela, o dono desliga um
  // slot e espera que a conversa ABERTA mude de ideia.
  assert.match(SKILLS_KIT_RULE, /PRÓXIMA conversa/u)
  assert.match(SKILLS_KIT_RULE, /não re-sincroniza/u)

  assert.equal(SKILLS_LAW_BADGE, 'lei da persona')
  assert.match(SKILLS_LAW_NOTE, /toda conversa de dev/u)
  assert.match(SKILLS_LAW_NOTE, /commit/u, 'a lei muda por decisão registrada, nunca por clique')
  assert.equal(/clique/u.test(SKILLS_LAW_NOTE), true)
})

test('a ficha da LEI não tem o que clicar, e a tela imprime a regra', async () => {
  const tsx = await source('src/renderer/src/components/SkillsSettings.tsx')

  const start = tsx.indexOf('if (slot.law)')
  assert.notEqual(start, -1, 'a ficha da lei perdeu o caminho próprio em SkillsSettings.tsx')
  const end = tsx.indexOf('skill-slot${slot.enabled', start)
  assert.notEqual(end, -1, 'marcador final sumiu de SkillsSettings.tsx')
  const lawRow = tsx.slice(start, end)

  assert.equal(lawRow.includes('role="switch"'), false, 'a lei ganhou um toggle')
  assert.equal(lawRow.includes('onToggle('), false, 'a lei ganhou um gesto de ligar/desligar')
  assert.equal(lawRow.includes('onRemove('), false, 'a lei ganhou um botão de tirar do kit')
  assert.ok(lawRow.includes('SKILLS_LAW_BADGE'), 'a ficha da lei não diz o que ela é')
  assert.ok(lawRow.includes('SKILLS_LAW_NOTE'), 'a ficha da lei não explica por que não há toggle')

  // a linha da normal, logo abaixo, CONTINUA tendo os dois gestos
  const normalRow = tsx.slice(end)
  assert.ok(normalRow.includes('role="switch"'))
  assert.ok(normalRow.includes('onRemove(chat, slot)'))

  assert.ok(tsx.includes('{SKILLS_KIT_RULE}'), 'a tela não imprime a regra do próximo spawn')
})
