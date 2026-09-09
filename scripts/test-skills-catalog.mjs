// SKILLS 3.0 — O CATÁLOGO DA CASA COMO DADO (a 2ª camada da busca do agente).
//
// Contrato: `.synkora/reports/DESIGN_HARNESS_DO_MODELO_2026-09-08.md` §5.A +
// ADR-0009 ("a qualidade da escolha é a qualidade do índice"). Módulos sob
// teste, compilados pelo script `test:skills-catalog` do package.json:
//
//   src/main/skillsCatalog.ts        o índice PURO (sem electron, sem fs)
//   src/main/skillsCatalogData.json  o DADO gerado de git (curadoria da era F6)
//
// O QUE ESTA SUÍTE PRENDE (e por que cada cerca existe):
//
//  1. O DADO CHEGOU INTEIRO. As ~275 skills verificadas na fonte na era F6 são
//     o índice; um gerador que perdeu metade, duplicou id ou deixou entrada sem
//     `hint`/`summary` cega o agente — e cegueira aqui vira "não achei nada".
//  2. A BUSCA É SOBRE A QUERY, NUNCA SOBRE O CHAT. Só entra o texto que o
//     agente digitou; acento não separa PT-BR de EN (NFD), token de 1 char não
//     conta, e query que não casa devolve `[]` em vez de ruído.
//  3. A FONTE É PINÁVEL. `catalogSourceUrl` é URL de EXIBIÇÃO (chuta `main`
//     quando não há ref); quem baixa usa repo/path/ref do dado.
//  4. OS VETOS SÃO PERMANENTES E CASAM POR TRÊS CHAVES. Proprietária da
//     Anthropic, plugin proprietário, id que sombreia comando built-in e
//     ruleset remoto sem pin nunca entram — nem pelo catálogo, nem por URL.
//
// Nenhum teste abre socket, escreve arquivo ou encosta em userData.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  SKILL_SOURCE_VETOES,
  catalogEntry,
  catalogGroups,
  catalogSourceUrl,
  searchSkillsCatalog,
  skillSourceVeto,
  skillsCatalog
} from '../.tmp/skills-catalog-test/skillsCatalog.js'

const DATA_FILE = fileURLToPath(new URL('../src/main/skillsCatalogData.json', import.meta.url))
const rawData = JSON.parse(readFileSync(DATA_FILE, 'utf8'))

/** o mesmo padrão de `isSkillId` (src/main/skillsKit.ts) — espelho declarado */
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

const idsOf = (hits) => hits.map((hit) => hit.entry.id)

// ——————————————————————————————————————————————————————————————————————
// 1. O DADO
// ——————————————————————————————————————————————————————————————————————

test('o catálogo traz a curadoria inteira (≥ 250 entradas) e o módulo espelha o JSON', () => {
  const entries = skillsCatalog()
  assert.ok(Array.isArray(rawData), 'skillsCatalogData.json tem de ser um array')
  assert.ok(
    entries.length >= 250,
    `esperado ≥ 250 skills no catálogo, veio ${entries.length}`
  )
  assert.equal(entries.length, rawData.length)
  assert.deepEqual(
    entries.map((entry) => entry.id),
    rawData.map((entry) => entry.id)
  )
})

test('todo id é válido pelo padrão da casa, único, e a lista está ordenada por id', () => {
  const entries = skillsCatalog()
  const seen = new Set()
  for (const entry of entries) {
    assert.ok(
      typeof entry.id === 'string' && SKILL_ID_PATTERN.test(entry.id) && !entry.id.includes('--'),
      `id fora do padrão: ${JSON.stringify(entry.id)}`
    )
    assert.ok(!seen.has(entry.id), `id duplicado no catálogo: ${entry.id}`)
    seen.add(entry.id)
  }
  const ids = entries.map((entry) => entry.id)
  assert.deepEqual(ids, [...ids].sort(), 'o catálogo tem de sair do gerador ordenado por id')
})

test('toda entrada tem repo, path, group, depts, summary e hint utilizáveis', () => {
  for (const entry of skillsCatalog()) {
    for (const field of ['repo', 'group', 'summary', 'hint']) {
      assert.ok(
        typeof entry[field] === 'string' && entry[field].trim().length > 0,
        `${entry.id}: campo "${field}" vazio`
      )
    }
    assert.ok(typeof entry.path === 'string', `${entry.id}: path tem de ser string (pode ser '')`)
    assert.match(entry.repo, /^[^/\s]+\/[^/\s]+$/, `${entry.id}: repo fora de owner/repo`)
    assert.ok(
      Array.isArray(entry.depts) && entry.depts.length > 0,
      `${entry.id}: depts vazio`
    )
    for (const dept of entry.depts) {
      assert.ok(typeof dept === 'string' && dept.length > 0, `${entry.id}: dept vazio`)
    }
    if (entry.ref !== undefined) {
      assert.ok(typeof entry.ref === 'string' && entry.ref.length > 0, `${entry.id}: ref vazia`)
    }
    if (entry.requires !== undefined) {
      assert.ok(Array.isArray(entry.requires) && entry.requires.length > 0, `${entry.id}: requires vazio`)
    }
  }
})

test('nada da era F6 que não é dado do catálogo sobreviveu na entrada', () => {
  const allowed = new Set(['id', 'repo', 'path', 'ref', 'group', 'depts', 'summary', 'hint', 'requires'])
  for (const entry of rawData) {
    for (const key of Object.keys(entry)) {
      assert.ok(allowed.has(key), `${entry.id}: campo da era F6 vazou para o dado: ${key}`)
    }
  }
})

test('catalogEntry acha por id e devolve undefined para id desconhecido', () => {
  const hit = catalogEntry('gsap-core')
  assert.ok(hit, 'gsap-core tem de estar no catálogo')
  assert.equal(hit.repo, 'greensock/gsap-skills')
  assert.equal(catalogEntry('nao-existe-nesta-casa'), undefined)
  assert.equal(catalogEntry(''), undefined)
})

test('catalogGroups é a lista de ocasiões única, ordenada e cobrindo toda entrada', () => {
  const groups = catalogGroups()
  assert.ok(groups.length > 10, `esperado mais de 10 ocasiões, veio ${groups.length}`)
  assert.deepEqual([...new Set(groups)], [...groups], 'catalogGroups não pode repetir')
  assert.deepEqual([...groups].sort(), [...groups], 'catalogGroups tem de vir ordenado')
  const known = new Set(groups)
  for (const entry of skillsCatalog()) {
    assert.ok(known.has(entry.group), `${entry.id}: group fora de catalogGroups: ${entry.group}`)
  }
})

// ——————————————————————————————————————————————————————————————————————
// 2. A BUSCA
// ——————————————————————————————————————————————————————————————————————

test('"landing page taste" traz as duas direções estéticas do gosto do dono', () => {
  const hits = searchSkillsCatalog('landing page taste')
  const ids = idsOf(hits)
  assert.ok(
    ids.slice(0, 5).includes('design-taste-frontend'),
    `design-taste-frontend tem de estar no topo 5, veio ${JSON.stringify(ids)}`
  )
  assert.ok(
    ids.includes('high-end-visual-design'),
    `high-end-visual-design tem de aparecer, veio ${JSON.stringify(ids)}`
  )
  // ordenado por score desc e, no empate, por id
  for (let i = 1; i < hits.length; i += 1) {
    const before = hits[i - 1]
    const now = hits[i]
    assert.ok(
      before.score > now.score || (before.score === now.score && before.entry.id < now.entry.id),
      `ordem quebrada entre ${before.entry.id} e ${now.entry.id}`
    )
  }
})

test('"gsap animação" traz gsap-core primeiro (acento não separa PT-BR de EN)', () => {
  const ids = idsOf(searchSkillsCatalog('gsap animação'))
  assert.equal(ids[0], 'gsap-core', `esperado gsap-core em 1º, veio ${JSON.stringify(ids)}`)
  // sem NFD a query "animação" não casaria com o group 'animação' do dado
  const semAcento = idsOf(searchSkillsCatalog('gsap animacao'))
  assert.deepEqual(semAcento, ids, 'com e sem acento têm de dar o MESMO resultado')
})

test('"debugging" e o PT-BR "caçar bug" chegam na mesma metodologia', () => {
  const emIngles = idsOf(searchSkillsCatalog('debugging')).slice(0, 5)
  assert.ok(
    emIngles.includes('systematic-debugging'),
    `systematic-debugging tem de estar no topo 5 de "debugging", veio ${JSON.stringify(emIngles)}`
  )
  const emPortugues = idsOf(searchSkillsCatalog('caçar bug')).slice(0, 5)
  assert.ok(
    emPortugues.includes('systematic-debugging'),
    `systematic-debugging tem de estar no topo 5 de "caçar bug", veio ${JSON.stringify(emPortugues)}`
  )
})

test('a pontuação segue a régua do design e matched nomeia os campos', () => {
  const [exato] = searchSkillsCatalog('impeccable')
  assert.equal(exato.entry.id, 'impeccable')
  assert.ok(exato.score >= 10, `id igual vale ≥ 10, veio ${exato.score}`)
  assert.ok(exato.matched.includes('id'), `matched tem de nomear "id", veio ${JSON.stringify(exato.matched)}`)

  const porGrupo = searchSkillsCatalog('animação').find((hit) => hit.entry.id === 'gsap-react')
  assert.ok(porGrupo, 'gsap-react casa por group')
  assert.deepEqual(porGrupo.matched, ['group'])
  assert.equal(porGrupo.score, 4)

  const porDept = searchSkillsCatalog('qa', 400).find((hit) => hit.matched.includes('dept'))
  assert.ok(porDept, 'algum hit de "qa" tem de casar por dept')
  assert.ok(porDept.entry.depts.includes('qa'))

  for (const hit of searchSkillsCatalog('accessibility')) {
    assert.ok(hit.matched.length > 0, `${hit.entry.id}: matched vazio com score ${hit.score}`)
    for (const field of hit.matched) {
      assert.ok(
        ['id', 'group', 'dept', 'hint', 'summary'].includes(field),
        `campo desconhecido em matched: ${field}`
      )
    }
  }
})

test('query sem casamento devolve [] — nunca ruído', () => {
  assert.deepEqual(searchSkillsCatalog('zzqqxx floxobarnicle'), [])
  assert.deepEqual(searchSkillsCatalog(''), [])
  assert.deepEqual(searchSkillsCatalog('   '), [])
  assert.deepEqual(searchSkillsCatalog('!!! ??? ---'), [])
  // token de 1 char não conta (senão "a" varreria o catálogo)
  assert.deepEqual(searchSkillsCatalog('a'), [])
})

test('o limite é 12 por padrão e respeita o pedido do chamador', () => {
  assert.ok(searchSkillsCatalog('design').length <= 12)
  assert.equal(searchSkillsCatalog('design', 3).length, 3)
  assert.deepEqual(searchSkillsCatalog('design', 0), [])
})

test('a busca é função pura da query (nenhum estado entre chamadas)', () => {
  const primeira = searchSkillsCatalog('react performance')
  const segunda = searchSkillsCatalog('react performance')
  assert.deepEqual(idsOf(primeira), idsOf(segunda))
  assert.deepEqual(
    primeira.map((hit) => hit.score),
    segunda.map((hit) => hit.score)
  )
})

// ——————————————————————————————————————————————————————————————————————
// 3. A FONTE
// ——————————————————————————————————————————————————————————————————————

test('catalogSourceUrl monta a URL de exibição do GitHub', () => {
  assert.equal(
    catalogSourceUrl(catalogEntry('gsap-core')),
    'https://github.com/greensock/gsap-skills/tree/main/skills/gsap-core'
  )
  assert.equal(
    catalogSourceUrl(catalogEntry('debugging-code')),
    'https://github.com/AlmogBaku/debug-skill/tree/master/skills/debugging-code'
  )
  // skill na raiz do repo: sem /tree/<ref>/
  assert.equal(
    catalogSourceUrl(catalogEntry('founder-voice-ghostwriter')),
    'https://github.com/BayramAnnakov/founder-voice-ghostwriter'
  )
  // ref ausente = a URL CHUTA main só para mostrar (quem baixa usa o dado)
  assert.equal(
    catalogSourceUrl({
      id: 'x',
      repo: 'owner/repo',
      path: 'skills/x',
      group: 'g',
      depts: ['front'],
      summary: 's',
      hint: 'h'
    }),
    'https://github.com/owner/repo/tree/main/skills/x'
  )
  assert.equal(
    catalogSourceUrl({
      id: 'x',
      repo: 'owner/repo',
      path: '',
      group: 'g',
      depts: ['front'],
      summary: 's',
      hint: 'h'
    }),
    'https://github.com/owner/repo'
  )
})

test('toda entrada gera URL de exibição bem-formada', () => {
  for (const entry of skillsCatalog()) {
    const url = catalogSourceUrl(entry)
    assert.ok(url.startsWith(`https://github.com/${entry.repo}`), `${entry.id}: URL torta -> ${url}`)
    assert.ok(!url.includes('//tree'), `${entry.id}: URL com barra dupla -> ${url}`)
    assert.ok(!url.endsWith('/'), `${entry.id}: URL terminando em barra -> ${url}`)
  }
})

// ——————————————————————————————————————————————————————————————————————
// 4. OS VETOS
// ——————————————————————————————————————————————————————————————————————

test('todo veto tem chave conhecida, valor e RAZÃO em PT-BR', () => {
  assert.ok(SKILL_SOURCE_VETOES.length >= 6, `esperado ao menos 6 vetos, veio ${SKILL_SOURCE_VETOES.length}`)
  for (const veto of SKILL_SOURCE_VETOES) {
    assert.ok(['id', 'repo', 'name'].includes(veto.kind), `chave de veto desconhecida: ${veto.kind}`)
    assert.ok(typeof veto.value === 'string' && veto.value.length > 0, 'veto sem valor')
    assert.ok(
      typeof veto.reason === 'string' && veto.reason.length >= 30,
      `veto ${veto.value} sem razão utilizável: ${JSON.stringify(veto.reason)}`
    )
  }
})

test('skillSourceVeto casa por id, por repo (sem ligar para caixa) e por name', () => {
  const porId = skillSourceVeto({ id: 'docx' })
  assert.ok(porId, 'docx é proprietária da Anthropic — tem de ser vetada')
  assert.equal(porId.kind, 'id')
  assert.match(porId.reason, /propriet/i)
  for (const id of ['pdf', 'pptx', 'xlsx']) {
    assert.ok(skillSourceVeto({ id }), `${id} tem de ser vetada junto do quarteto`)
  }

  const porRepo = skillSourceVeto({ repo: 'Anthropics/Claude-Plugins-Official' })
  assert.ok(porRepo, 'o repo do claude-security tem de ser vetado em qualquer caixa')
  assert.equal(porRepo.kind, 'repo')

  const porName = skillSourceVeto({ id: 'security-review' })
  assert.ok(porName, 'security-review sombreia o comando built-in')
  assert.equal(porName.kind, 'name')

  assert.ok(skillSourceVeto({ id: 'web-design-guidelines' }), 'ruleset remoto sem pin é veto')

  assert.equal(skillSourceVeto({ id: 'gsap-core' }), undefined)
  assert.equal(skillSourceVeto({ repo: 'greensock/gsap-skills' }), undefined)
  assert.equal(skillSourceVeto({}), undefined)
})

test('nada vetado sobrou no dado gerado', () => {
  const byId = new Map(skillsCatalog().map((entry) => [entry.id, entry]))
  for (const veto of SKILL_SOURCE_VETOES) {
    if (veto.kind === 'id' || veto.kind === 'name') {
      assert.equal(byId.get(veto.value), undefined, `entrada vetada no JSON: ${veto.value}`)
    } else {
      const alvo = veto.value.toLowerCase()
      const achada = skillsCatalog().find((entry) => entry.repo.toLowerCase() === alvo)
      assert.equal(achada, undefined, `repo vetado no JSON: ${veto.value} (${achada?.id})`)
    }
  }
})

test('nenhuma entrada do catálogo é recusada pelo próprio veto', () => {
  for (const entry of skillsCatalog()) {
    assert.equal(
      skillSourceVeto({ id: entry.id, repo: entry.repo }),
      undefined,
      `${entry.id}: o catálogo oferece o que o veto recusa`
    )
  }
})
