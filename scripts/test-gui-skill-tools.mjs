#!/usr/bin/env node
/**
 * AS TRÊS FERRAMENTAS DE SKILL DO CHAT (Skills 3.0 — fatia 5.D do design
 * `.synkora/reports/DESIGN_HARNESS_DO_MODELO_2026-09-08.md`; ADRs 0009/0010).
 *
 * Ordem do dono: "não quero mais algo fixo. Quero que a IA decida qual é a
 * melhor opção pra ela ali naquele momento, e ela vá atrás, ela busque, ela
 * pegue e ela faça" — e, sobre a skill achada na internet, "ir lá, ler a skill,
 * utilizar a skill naquela missão e depois descartar".
 *
 * O que esta suíte prende (cada asserção é uma cerca do §5.D):
 *   1. `skill_search` mostra as TRÊS camadas na ordem da doutrina e o rodapé com
 *      a receita da web — a prateleira nunca é uma cerca.
 *   2. `skill_pull` materializa nos DOIS alvos, escreve o rastro
 *      (`.synkora/harness.json`), avisa o dono no fio, pede a recarga ao CLI e
 *      escreve o diário. Nada disso é opcional: rastro é ordem do ADR-0010.
 *   3. Entrada de CATÁLOGO viaja com `expectId` (13 das 270 têm pasta upstream
 *      diferente do id — sem isso a validação "pasta == name" recusaria skills
 *      boas) e as irmãs de `requires` vão junto.
 *   4. Toda recusa NOMEIA A RECEITA: veto permanente, interruptor do dono,
 *      pasta do dono, URL torta, escolha de caminho. Beco sem saída é bug.
 *   5. Sem motor, as tools CONTINUAM no catálogo e dizem em letras maiúsculas
 *      que NADA foi puxado.
 *
 * Node puro sobre `.tmp/gui-skill-tools-test` (o `npm run test:gui-skill-tools`
 * compila): sem Electron, sem rede — o GitHub é dublê.
 */
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
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  SKILLS_ENGINE_OFF,
  SKILL_TOOL_NAMES,
  buildGuiSkillTools,
  registerSkillsKit
} from '../.tmp/gui-skill-tools-test/guiSkillTools.js'

const TARGETS = ['.claude/skills', '.agents/skills']

// ————————————————————————————— dublês —————————————————————————————

function skillMd(name, description = `o que ${name} ensina`) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\ncorpo\n`
}

function writeFile(file, content) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
}

/**
 * O GitHub INTEIRO sem rede, por PASTA: `folders` mapeia `<repo>|<path>` para
 * `{ name, files }`. `calls` é a prova do custo (2 chamadas core + 1 raw por
 * arquivo) e de QUAL pasta foi pedida — é assim que o `expectId` se mede.
 */
function githubFake(folders) {
  const calls = []
  const shaOf = (key) => {
    let hash = 0
    for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) % 0xfffffff
    return `${hash.toString(16)}c0ffee1234567890`.slice(0, 40)
  }
  const bodiesOf = (key) => {
    const folder = folders[key]
    if (!folder) return undefined
    const [, path] = key.split('|')
    const prefix = path ? `${path}/` : ''
    const out = { [`${prefix}SKILL.md`]: skillMd(folder.name, folder.description) }
    for (const [rel, content] of Object.entries(folder.files ?? {})) {
      out[`${prefix}${rel}`] = content
    }
    return out
  }
  const keyForSha = (repo, sha) =>
    Object.keys(folders).find((key) => key.startsWith(`${repo}|`) && shaOf(key) === sha)
  const fetchImpl = async (url) => {
    calls.push(url)
    const parsed = new URL(url)
    if (parsed.hostname === 'api.github.com' && parsed.pathname.endsWith('/commits')) {
      const repo = parsed.pathname.slice('/repos/'.length, -'/commits'.length)
      const key = `${repo}|${parsed.searchParams.get('path') ?? ''}`
      if (!folders[key]) return new Response('null', { status: 404 })
      return new Response(JSON.stringify([{ sha: shaOf(key) }]), { status: 200 })
    }
    if (parsed.hostname === 'api.github.com' && parsed.pathname.includes('/git/trees/')) {
      // /repos/<dono>/<repo>/git/trees/<sha>
      const [, , repoOwner, repoName, , , sha] = parsed.pathname.split('/')
      const repo = `${repoOwner}/${repoName}`
      const key = keyForSha(repo, sha)
      const bodies = key ? bodiesOf(key) : undefined
      if (!bodies) return new Response('null', { status: 404 })
      return new Response(
        JSON.stringify({
          truncated: false,
          tree: Object.entries(bodies).map(([path, content]) => ({
            path,
            type: 'blob',
            mode: '100644',
            size: Buffer.byteLength(content)
          }))
        }),
        { status: 200 }
      )
    }
    // raw.githubusercontent.com/<owner>/<repo>/<sha>/<caminho>
    const parts = parsed.pathname.slice(1).split('/')
    const repo = `${parts[0]}/${parts[1]}`
    const sha = parts[2]
    const rest = decodeURIComponent(parts.slice(3).join('/'))
    const key = keyForSha(repo, sha)
    const bodies = key ? bodiesOf(key) : undefined
    if (!bodies || bodies[rest] === undefined) return new Response('nope', { status: 404 })
    return new Response(Buffer.from(bodies[rest]), { status: 200 })
  }
  return { fetchImpl, calls }
}

function harnessFor(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-skill-tools-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'worktree')
  const lib = join(root, 'lib')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(lib, { recursive: true })
  const notes = []
  const reloads = []
  const records = []
  const toolkit = buildGuiSkillTools({
    cwdOf: (identity) => identity.cwd || undefined,
    agentPullEnabled: () => options.agentPull !== false,
    libraryRoot: () => lib,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    note: (paneId, text) => notes.push({ paneId, text }),
    reloadSkills: async (paneId) => {
      reloads.push(paneId)
      return options.reload ?? { ok: true }
    },
    record: (event) => records.push(event)
  })
  const identity = {
    paneId: 'gui-dev-abcd1234',
    projectId: 'universo-1',
    role: 'gui-delegator',
    missionId: 'missao-1',
    cwd
  }
  return { root, cwd, lib, notes, reloads, records, toolkit, identity }
}

function harnessJson(cwd) {
  return JSON.parse(readFileSync(join(cwd, '.synkora', 'harness.json'), 'utf8'))
}

function recordsOf(records, event) {
  return records.filter((entry) => entry.event === event)
}

// ————————————————————————— 1. skill_search —————————————————————————

test('skill_search mostra as TRÊS camadas na ordem da doutrina e a receita da web', (t) => {
  const { toolkit, identity, cwd, lib, records } = harnessFor(t)
  // prateleira: a pasta do dono no worktree (sem manifesto = pasta dele)
  writeFile(join(cwd, '.claude/skills/impeccable/SKILL.md'), skillMd('impeccable', 'polish de UI'))
  // biblioteca da máquina
  writeFile(join(lib, 'grilling/SKILL.md'), skillMd('grilling', 'interrogatório de plano'))
  // e uma que já está na prateleira NÃO pode aparecer duas vezes
  writeFile(join(lib, 'impeccable/SKILL.md'), skillMd('impeccable', 'polish de UI'))

  const text = toolkit.search(identity, 'gsap animação')
  const shelfAt = text.indexOf('PRATELEIRA')
  const libAt = text.indexOf('BIBLIOTECA')
  const catalogAt = text.indexOf('CATÁLOGO')
  assert.ok(shelfAt >= 0 && libAt > shelfAt && catalogAt > libAt, `as três camadas em ordem:\n${text}`)
  assert.match(text, /impeccable/u)
  assert.match(text, /grilling/u)
  // o catálogo da casa responde à QUERY do agente (a régua é do agente A)
  assert.match(text, /gsap-core/u)
  assert.match(text, /animação/u)
  // a fonte pinável de cada linha do catálogo
  assert.match(text, /greensock\/gsap-skills/u)
  // o rodapé: a web é do AGENTE, e o que se puxa é a pasta do GitHub
  assert.match(text, /github\.com\/<dono>\/<repo>\/tree\/<branch>/u)
  assert.match(text, /skills\.sh/u)
  assert.match(text, /mission-playbook/u)
  // a biblioteca não repete o que já está na prateleira
  const libBlock = text.slice(libAt, catalogAt)
  assert.equal(libBlock.includes('impeccable'), false, 'a biblioteca repetiu a prateleira')
  assert.ok(libBlock.includes('grilling'))
  // diário: a busca é sobre a QUERY do agente, com as contagens por camada
  const searched = recordsOf(records, 'skill-search')
  assert.equal(searched.length, 1)
  assert.equal(searched[0].ids.paneId, identity.paneId)
  assert.equal(searched[0].detail.shelf, 1)
  assert.equal(searched[0].detail.library, 1)
  assert.ok(searched[0].detail.catalog > 0)
})

test('skill_search sem query lista prateleira e biblioteca e diz que o catálogo pede busca', (t) => {
  const { toolkit, identity, cwd, lib } = harnessFor(t)
  writeFile(join(cwd, '.claude/skills/impeccable/SKILL.md'), skillMd('impeccable', 'polish de UI'))
  writeFile(join(lib, 'grilling/SKILL.md'), skillMd('grilling', 'interrogatório'))
  const text = toolkit.search(identity, '')
  assert.match(text, /impeccable/u)
  assert.match(text, /grilling/u)
  assert.match(text, /CATÁLOGO/u)
  assert.match(text, /skill_search/u)
  assert.equal(/gsap-core/u.test(text), false, 'sem query o catálogo não despeja 270 linhas')
})

// ———————————————————— 2. skill_pull pela BIBLIOTECA ————————————————————

test('skill_pull { id } da biblioteca materializa nos DOIS alvos, escreve rastro, nota e recarga', async (t) => {
  const { toolkit, identity, cwd, lib, notes, reloads, records } = harnessFor(t)
  writeFile(join(lib, 'grilling/SKILL.md'), skillMd('grilling', 'interrogatório implacável'))
  writeFile(join(lib, 'grilling/reference/como.md'), 'passo a passo')

  const receipt = await toolkit.pull(identity, { id: 'grilling' })

  for (const target of TARGETS) {
    assert.ok(
      existsSync(join(cwd, target, 'grilling', 'SKILL.md')),
      `${target} ficou sem a skill — os dois CLIs leem pastas diferentes`
    )
    assert.ok(existsSync(join(cwd, target, 'grilling', 'reference', 'como.md')))
  }
  // o recibo é a ENTREGA IMEDIATA (sonda de recarga): caminho + descrição +
  // rastro + a régua da recarga
  assert.match(receipt, /\.claude[\\/]skills[\\/]grilling[\\/]SKILL\.md|\.claude\/skills\/grilling\/SKILL\.md/u)
  assert.match(receipt, /interrogatório implacável/u)
  assert.match(receipt, /biblioteca/u)
  assert.match(receipt, /Read/u)
  assert.match(receipt, /próximo turno|turno seguinte/u)

  // rastro (ADR-0010): harness.json da conversa
  const harness = harnessJson(cwd)
  assert.equal(harness.version, 1)
  assert.equal(harness.entries.length, 1)
  assert.equal(harness.entries[0].id, 'grilling')
  assert.equal(harness.entries[0].origin, 'library')
  assert.equal(harness.entries[0].by, identity.paneId)
  assert.ok(harness.entries[0].pulledAt)

  // nota no fio + recarga pedida ao CLI deste pane
  assert.deepEqual(notes, [{ paneId: identity.paneId, text: '❖ skill puxada da biblioteca: grilling' }])
  assert.deepEqual(reloads, [identity.paneId])

  const pulled = recordsOf(records, 'skill-pulled')
  assert.equal(pulled.length, 1)
  assert.equal(pulled[0].ids.paneId, identity.paneId)
  assert.equal(pulled[0].ids.missionId, 'missao-1')
  assert.equal(pulled[0].detail.id, 'grilling')
  assert.equal(pulled[0].detail.origin, 'library')
  assert.deepEqual(pulled[0].detail.targets, TARGETS)
  assert.equal(recordsOf(records, 'skill-reload').length, 1)
})

test('skill_pull { id } que já está na prateleira é NO-OP com recibo — nunca um erro', async (t) => {
  const { toolkit, identity, cwd, notes, reloads } = harnessFor(t)
  writeFile(join(cwd, '.claude/skills/impeccable/SKILL.md'), skillMd('impeccable', 'polish de UI'))
  const receipt = await toolkit.pull(identity, { id: 'impeccable' })
  assert.match(receipt, /já está/u)
  assert.match(receipt, /SKILL\.md/u)
  assert.equal(existsSync(join(cwd, '.synkora', 'harness.json')), false, 'no-op não inventa rastro')
  assert.deepEqual(notes, [])
  assert.deepEqual(reloads, [])
})

// ———————————————————— 3. skill_pull pelo CATÁLOGO ————————————————————

test('skill_pull { id } do catálogo passa expectId e traz as irmãs de requires', async (t) => {
  // `grill-me` requer `grilling`; as duas moram em mattpocock/skills.
  const { fetchImpl, calls } = githubFake({
    'mattpocock/skills|skills/productivity/grill-me': {
      name: 'grill-me',
      description: 'o lançador do interrogatório'
    },
    'mattpocock/skills|skills/productivity/grilling': {
      name: 'grilling',
      description: 'uma pergunta por vez'
    }
  })
  const { toolkit, identity, cwd, notes, records } = harnessFor(t, { fetch: fetchImpl })

  const receipt = await toolkit.pull(identity, { id: 'grill-me' })

  for (const id of ['grill-me', 'grilling']) {
    for (const target of TARGETS) {
      assert.ok(existsSync(join(cwd, target, id, 'SKILL.md')), `${id} não chegou em ${target}`)
    }
  }
  assert.match(receipt, /grilling/u, 'o recibo tem de dizer que a irmã veio junto')
  // O PIN É DA PASTA (ADR-0007): commits?path=<pasta da skill>
  const commits = calls.filter((url) => url.includes('/commits?'))
  assert.ok(commits.some((url) => url.includes('path=skills%2Fproductivity%2Fgrill-me')))
  // o staging não vaza: o pouso `.dl-*` é apagado depois do materialize
  const staging = join(cwd, '.synkora', 'skills-sync-tmp')
  assert.deepEqual(
    existsSync(staging) ? readdirSync(staging) : [],
    [],
    'o pouso do download ficou para trás no worktree'
  )

  const harness = harnessJson(cwd)
  assert.deepEqual(
    harness.entries.map((entry) => entry.id).sort(),
    ['grill-me', 'grilling']
  )
  for (const entry of harness.entries) {
    assert.equal(entry.origin, 'catalog')
    assert.equal(entry.repo, 'mattpocock/skills')
    assert.ok(entry.sha, 'sem sha não existe "guardar na biblioteca" no mesmo commit')
  }
  assert.equal(notes.length, 2, 'cada skill puxada ganha a linha dela no fio do dono')
  assert.match(notes[0].text, /mattpocock\/skills @ [0-9a-f]{7}/u)
  const pulled = recordsOf(records, 'skill-pulled')
  assert.equal(pulled.length, 2)
  assert.equal(pulled[0].detail.sha7.length, 7)
})

test('skill_pull do catálogo com pasta upstream DIFERENTE do id só passa com expectId', async (t) => {
  // `design-taste-frontend` mora em `skills/taste-skill` (uma das 13 da
  // curadoria): sem `expectId` a régua "pasta == name" recusaria a skill boa.
  const { fetchImpl } = githubFake({
    'Leonxlnx/taste-skill|skills/taste-skill': {
      name: 'design-taste-frontend',
      description: 'o rulebook anti-slop'
    }
  })
  const { toolkit, identity, cwd } = harnessFor(t, { fetch: fetchImpl })
  const receipt = await toolkit.pull(identity, { id: 'design-taste-frontend' })
  assert.ok(
    existsSync(join(cwd, '.claude/skills/design-taste-frontend/SKILL.md')),
    `a skill do gosto do dono não chegou:\n${receipt}`
  )
})

test('skill_pull do catálogo com o interruptor DESLIGADO recusa nomeando a TELA do dono', async (t) => {
  const { fetchImpl, calls } = githubFake({
    'mattpocock/skills|skills/productivity/grilling': { name: 'grilling' }
  })
  const { toolkit, identity, cwd } = harnessFor(t, { fetch: fetchImpl, agentPull: false })
  const text = await toolkit.pull(identity, { id: 'grilling' })
  assert.match(text, /Ajustes/u)
  assert.match(text, /Skills/u)
  assert.match(text, /internet/u)
  assert.match(text, /NADA/u)
  assert.deepEqual(calls, [], 'o interruptor desligado não pode gastar UMA chamada de rede')
  assert.equal(existsSync(join(cwd, '.claude/skills/grilling')), false)
})

test('skill_pull de id VETADO recusa com a razão e a receita — nunca "não achei"', async (t) => {
  const { toolkit, identity, records } = harnessFor(t)
  const text = await toolkit.pull(identity, { id: 'using-git-worktrees' })
  assert.match(text, /Receita/u)
  assert.match(text, /worktree/u)
  const refused = recordsOf(records, 'skill-pull-refused')
  assert.equal(refused.length, 1)
  assert.equal(refused[0].reason, 'veto')
})

test('skill_pull { url } de repo VETADO recusa antes da rede, nomeando o veto', async (t) => {
  const { fetchImpl, calls } = githubFake({})
  const { toolkit, identity } = harnessFor(t, { fetch: fetchImpl })
  const text = await toolkit.pull(identity, {
    url: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/claude-security/skills/x'
  })
  assert.match(text, /claude-security|proprietário/u)
  assert.match(text, /Receita/u)
  assert.deepEqual(calls, [], 'veto de repo não pode gastar rede')
})

test('skill_pull { url } torta recusa nomeando o FORMATO da pasta do GitHub', async (t) => {
  const { toolkit, identity, records } = harnessFor(t)
  const text = await toolkit.pull(identity, { url: 'https://gitlab.com/dono/repo' })
  assert.match(text, /github\.com\/<dono>\/<repo>\/tree\/<branch>/u)
  assert.equal(recordsOf(records, 'skill-pull-refused')[0].reason, 'parse')
})

test('skill_pull { url } boa baixa pinada e entra como origem url', async (t) => {
  const { fetchImpl } = githubFake({
    'dono/repo|skills/alpha': { name: 'alpha', description: 'a skill alpha' }
  })
  const { toolkit, identity, cwd, notes } = harnessFor(t, { fetch: fetchImpl })
  const receipt = await toolkit.pull(identity, {
    url: 'https://github.com/dono/repo/tree/main/skills/alpha'
  })
  assert.ok(existsSync(join(cwd, '.agents/skills/alpha/SKILL.md')), receipt)
  assert.equal(harnessJson(cwd).entries[0].origin, 'url')
  assert.match(notes[0].text, /dono\/repo @ /u)
})

// ———————————————————— 4. skill_pull do PLAYBOOK autoral ————————————————————

test('skill_pull { path } espelha o playbook que o agente escreveu, como authored', async (t) => {
  const { toolkit, identity, cwd, notes, reloads, records } = harnessFor(t)
  writeFile(
    join(cwd, '.claude/skills/mission-playbook/SKILL.md'),
    skillMd('mission-playbook', 'a direção desta missão')
  )
  const receipt = await toolkit.pull(identity, { path: '.claude/skills/mission-playbook' })
  assert.ok(
    existsSync(join(cwd, '.agents/skills/mission-playbook/SKILL.md')),
    `o espelho para o codex não nasceu:\n${receipt}`
  )
  assert.equal(harnessJson(cwd).entries[0].origin, 'authored')
  assert.deepEqual(notes, [
    { paneId: identity.paneId, text: '❖ playbook da missão escrito pelo agente: mission-playbook' }
  ])
  assert.deepEqual(reloads, [identity.paneId])
  assert.equal(recordsOf(records, 'skill-authored').length, 1)
  assert.equal(recordsOf(records, 'skill-pulled').length, 0, 'playbook autoral tem evento próprio')
})

test('skill_pull sem caminho nenhum (ou com dois) recusa NOMEANDO os três', async (t) => {
  const { toolkit, identity } = harnessFor(t)
  for (const input of [{}, { id: 'a', url: 'dono/repo' }]) {
    const text = await toolkit.pull(identity, input)
    assert.match(text, /\bid\b/u)
    assert.match(text, /\burl\b/u)
    assert.match(text, /\bpath\b/u)
    assert.match(text, /NADA/u)
  }
})

test('sem pasta de trabalho, o pull recusa dizendo o que fazer — nunca estoura', async (t) => {
  const { toolkit } = harnessFor(t)
  const orphan = { paneId: 'gui-dev-0f0f0f0f', projectId: 'universo-1', role: 'gui-delegator', cwd: '' }
  const text = await toolkit.pull(orphan, { id: 'grilling' })
  assert.match(text, /pasta de trabalho/u)
  assert.match(text, /NADA/u)
})

// ———————————————————— 5. o AJUDANTE: nota no delegador ————————————————————

test('o ajudante avisa o DELEGADOR no fio e não pede recarga (é headless)', async (t) => {
  const { toolkit, cwd, lib, notes, reloads } = harnessFor(t)
  writeFile(join(lib, 'grilling/SKILL.md'), skillMd('grilling', 'interrogatório'))
  const helper = {
    paneId: 'helper-mcp-abc123',
    projectId: 'universo-1',
    role: 'ajudante',
    delegatorPaneId: 'gui-dev-abcd1234',
    cwd
  }
  const receipt = await toolkit.pull(helper, { id: 'grilling' })
  assert.deepEqual(notes.map((note) => note.paneId), ['gui-dev-abcd1234'])
  assert.deepEqual(reloads, [], 'sessão headless não tem catálogo nativo para recarregar')
  assert.match(receipt, /Read/u, 'sem recarga, ler o SKILL.md é a única rota do turno')
  assert.equal(harnessJson(cwd).entries[0].by, 'helper-mcp-abc123')
})

// ————————————————————————— 6. skill_discard —————————————————————————

test('skill_discard tira a skill dos alvos, carimba o rastro, avisa e escreve o diário', async (t) => {
  const { toolkit, identity, cwd, lib, notes, records } = harnessFor(t)
  writeFile(join(lib, 'grilling/SKILL.md'), skillMd('grilling', 'interrogatório'))
  await toolkit.pull(identity, { id: 'grilling' })
  notes.length = 0

  const text = await toolkit.discard(identity, 'grilling')
  for (const target of TARGETS) {
    assert.equal(existsSync(join(cwd, target, 'grilling')), false, `${target} ficou com a pasta`)
  }
  assert.match(text, /grilling/u)
  const harness = harnessJson(cwd)
  assert.ok(harness.entries[0].discardedAt, 'a linha do rastro FICA, carimbada')
  assert.deepEqual(notes, [{ paneId: identity.paneId, text: '❖ skill descartada: grilling' }])
  assert.equal(recordsOf(records, 'skill-discarded').length, 1)
})

test('skill_discard de pasta que não é nossa recusa com a rota do motor', async (t) => {
  const { toolkit, identity, cwd } = harnessFor(t)
  writeFile(join(cwd, '.claude/skills/impeccable/SKILL.md'), skillMd('impeccable'))
  const text = await toolkit.discard(identity, 'impeccable')
  assert.match(text, /impeccable/u)
  assert.ok(existsSync(join(cwd, '.claude/skills/impeccable/SKILL.md')), 'apagou pasta do dono')
})

// ————————————————————— 7. o catálogo MCP e o motor OFF —————————————————————

test('registerSkillsKit registra as TRÊS tools com descrição e schema', () => {
  const registered = []
  registerSkillsKit(
    {
      registerTool: (name, definition, handler) => registered.push({ name, definition, handler })
    },
    undefined,
    { paneId: 'gui-dev-abcd1234', projectId: 'p', role: 'gui-delegator', cwd: '/tmp' }
  )
  assert.deepEqual(registered.map((tool) => tool.name), [...SKILL_TOOL_NAMES])
  for (const tool of registered) {
    assert.ok(tool.definition.description.length > 200, `${tool.name} sem descrição de verdade`)
  }
  const search = registered.find((tool) => tool.name === 'skill_search')
  assert.match(search.definition.description, /prateleira/iu)
  assert.match(search.definition.description, /biblioteca/iu)
  assert.match(search.definition.description, /catálogo/iu)
  const pull = registered.find((tool) => tool.name === 'skill_pull')
  assert.match(pull.definition.description, /github\.com\/<dono>\/<repo>\/tree\/<branch>/u)
  assert.match(pull.definition.description, /skills\.sh/u)
  assert.match(pull.definition.description, /mission-playbook/u)
  assert.deepEqual(Object.keys(pull.definition.inputSchema).sort(), ['id', 'path', 'url'])
})

test('sem o motor ligado, as três dizem em CAIXA ALTA que NADA foi puxado', async () => {
  const registered = new Map()
  registerSkillsKit(
    { registerTool: (name, definition, handler) => registered.set(name, handler) },
    undefined,
    { paneId: 'gui-dev-abcd1234', projectId: 'p', role: 'gui-delegator', cwd: '/tmp' }
  )
  assert.match(SKILLS_ENGINE_OFF, /NADA/u)
  for (const name of SKILL_TOOL_NAMES) {
    const result = await registered.get(name)({ query: 'x', id: 'grilling' })
    assert.equal(result.content[0].text, SKILLS_ENGINE_OFF, `${name} inventou resposta sem motor`)
  }
})

test('com o motor ligado, o catálogo entrega o TEXTO da tool (nunca structuredContent)', async (t) => {
  const { toolkit, identity, lib } = harnessFor(t)
  writeFile(join(lib, 'grilling/SKILL.md'), skillMd('grilling', 'interrogatório'))
  const registered = new Map()
  registerSkillsKit(
    { registerTool: (name, definition, handler) => registered.set(name, handler) },
    toolkit,
    identity
  )
  const searched = await registered.get('skill_search')({ query: 'grilling' })
  assert.equal(searched.structuredContent, undefined, 'o codex descarta content[] com structured')
  assert.match(searched.content[0].text, /grilling/u)
  const pulled = await registered.get('skill_pull')({ id: 'grilling' })
  assert.match(pulled.content[0].text, /grilling/u)
  const discarded = await registered.get('skill_discard')({ id: 'grilling' })
  assert.match(discarded.content[0].text, /grilling/u)
})
