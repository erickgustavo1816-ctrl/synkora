import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CURATED_SKILLS } from '../src/main/skillsCatalog.ts'
import {
  selectInstalledIdsForDepartment,
  selectInstalledManualOnlyIdsToPrune,
  selectInstalledPlanningIds
} from '../src/main/skillsRouting.ts'
import {
  managedWorkspaceSkillContentsMatch,
  MANAGED_WORKSPACE_SKILL_MARKER,
  pruneUninstalledManagedWorkspaceSkills,
  syncManagedWorkspaceSkillCopies,
  WorkspaceSkillLeaseRegistry
} from '../src/main/workspaceSkills.ts'

const SUPERPOWERS_IDS = [
  'brainstorming',
  'dispatching-parallel-agents',
  'executing-plans',
  'finishing-a-development-branch',
  'receiving-code-review',
  'requesting-code-review',
  'subagent-driven-development',
  'systematic-debugging',
  'test-driven-development',
  'using-git-worktrees',
  'using-superpowers',
  'verification-before-completion',
  'writing-plans'
]

const PLANNING_IDS = [
  'grilling',
  'grill-me',
  'grill-with-docs',
  'brainstorming',
  'writing-plans',
  'to-tickets',
  'before-you-build',
  'roadmap-planning'
]

test('o catálogo contém as 13 skills permitidas do Superpowers com paths exatos', () => {
  const byId = new Map(CURATED_SKILLS.map((skill) => [skill.id, skill]))
  for (const id of SUPERPOWERS_IDS) {
    const skill = byId.get(id)
    assert.ok(skill, `skill ausente: ${id}`)
    assert.equal(skill.source.repo, 'obra/superpowers')
    assert.equal(skill.source.path, `skills/${id}`)
    assert.equal(skill.source.ref, 'main')
  }
  assert.equal(SUPERPOWERS_IDS.includes('writing-skills'), false)
})

test('skills manuais não entram na injeção automática do departamento', () => {
  const defs = [
    { id: 'normal', kind: 'skill', depts: ['back'], group: 'x' },
    { id: 'manual', kind: 'skill', depts: ['back'], group: 'x', manualOnly: true },
    { id: 'other', kind: 'skill', depts: ['front'], group: 'x' }
  ]
  const installed = new Set(['normal', 'manual', 'other'])
  assert.deepEqual(
    selectInstalledIdsForDepartment(defs, (id) => installed.has(id), 'back'),
    ['normal']
  )
})

test('uma escolha manual não vaza para a próxima execução no mesmo workspace', () => {
  const defs = [
    { id: 'normal', kind: 'skill', depts: ['back'], group: 'x' },
    { id: 'manual-a', kind: 'skill', depts: ['back'], group: 'x', manualOnly: true },
    { id: 'manual-b', kind: 'skill', depts: ['back'], group: 'x', manualOnly: true },
    { id: 'missing', kind: 'skill', depts: ['back'], group: 'x', manualOnly: true }
  ]
  const installed = new Set(['normal', 'manual-a', 'manual-b'])
  assert.deepEqual(
    selectInstalledManualOnlyIdsToPrune(
      defs,
      (id) => installed.has(id),
      ['normal', 'manual-b']
    ),
    ['manual-a']
  )
})

test('injeção preserva uma skill local em colisão e não deixa cópia parcial', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-skill-collision-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'library', 'brainstorming')
  const claude = join(root, 'project', '.claude', 'skills', 'brainstorming')
  const agents = join(root, 'project', '.agents', 'skills', 'brainstorming')
  mkdirSync(source, { recursive: true })
  mkdirSync(claude, { recursive: true })
  writeFileSync(join(source, 'SKILL.md'), 'versão da biblioteca\n', 'utf8')
  writeFileSync(join(claude, 'SKILL.md'), 'versão local do projeto\n', 'utf8')

  assert.equal(syncManagedWorkspaceSkillCopies(source, [claude, agents], 'brainstorming'), false)
  assert.equal(readFileSync(join(claude, 'SKILL.md'), 'utf8'), 'versão local do projeto\n')
  assert.equal(existsSync(agents), false, 'o preflight deve impedir uma injeção parcial')
})

test('marcador inválido nunca autoriza sobrescrever uma skill local', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-skill-invalid-marker-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'library', 'brainstorming')
  const local = join(root, 'project', '.claude', 'skills', 'brainstorming')
  mkdirSync(source, { recursive: true })
  mkdirSync(local, { recursive: true })
  writeFileSync(join(source, 'SKILL.md'), 'mesmos bytes\n', 'utf8')
  writeFileSync(join(local, 'SKILL.md'), 'mesmos bytes\n', 'utf8')
  writeFileSync(join(local, MANAGED_WORKSPACE_SKILL_MARKER), '{inválido', 'utf8')

  assert.equal(syncManagedWorkspaceSkillCopies(source, [local], 'brainstorming'), false)
  assert.equal(readFileSync(join(local, MANAGED_WORKSPACE_SKILL_MARKER), 'utf8'), '{inválido')
})

test('injeção pode atualizar somente cópias comprovadamente gerenciadas', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-skill-managed-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'library', 'brainstorming')
  const claude = join(root, 'project', '.claude', 'skills', 'brainstorming')
  const agents = join(root, 'project', '.agents', 'skills', 'brainstorming')
  mkdirSync(source, { recursive: true })
  mkdirSync(claude, { recursive: true })
  writeFileSync(join(source, 'SKILL.md'), 'versão nova\n', 'utf8')
  writeFileSync(join(claude, 'SKILL.md'), 'versão antiga\n', 'utf8')
  writeFileSync(
    join(claude, MANAGED_WORKSPACE_SKILL_MARKER),
    `${JSON.stringify({ managedBy: 'synkora', id: 'brainstorming' })}\n`,
    'utf8'
  )

  assert.equal(syncManagedWorkspaceSkillCopies(source, [claude, agents], 'brainstorming'), true)
  assert.equal(readFileSync(join(claude, 'SKILL.md'), 'utf8'), 'versão nova\n')
  assert.equal(readFileSync(join(agents, 'SKILL.md'), 'utf8'), 'versão nova\n')
  assert.equal(existsSync(join(agents, MANAGED_WORKSPACE_SKILL_MARKER)), true)
})

test('skill app-owned repara bytes adulterados mesmo com marcador e versão atuais', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-skill-app-owned-repair-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'library', 'synkora-frontend-standard')
  const destination = join(root, 'project', '.agents', 'skills', 'synkora-frontend-standard')
  mkdirSync(source, { recursive: true })
  mkdirSync(destination, { recursive: true })
  writeFileSync(join(source, 'SKILL.md'), 'contrato oficial\n', 'utf8')
  writeFileSync(join(destination, 'SKILL.md'), 'conteúdo adulterado\n', 'utf8')
  writeFileSync(join(destination, 'extra.md'), 'arquivo inesperado\n', 'utf8')
  writeFileSync(
    join(destination, MANAGED_WORKSPACE_SKILL_MARKER),
    `${JSON.stringify({
      managedBy: 'synkora',
      id: 'synkora-frontend-standard',
      version: 'bundled:sha-atual'
    })}\n`,
    'utf8'
  )

  assert.equal(managedWorkspaceSkillContentsMatch(source, destination), false)
  assert.equal(
    syncManagedWorkspaceSkillCopies(
      source,
      [destination],
      'synkora-frontend-standard',
      'bundled:sha-atual',
      true
    ),
    true
  )
  assert.equal(readFileSync(join(destination, 'SKILL.md'), 'utf8'), 'contrato oficial\n')
  assert.equal(existsSync(join(destination, 'extra.md')), false)
  assert.equal(managedWorkspaceSkillContentsMatch(source, destination), true)
})

test('desinstalação poda apenas cópias marcadas pelo Synkora', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-skill-prune-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const roots = [join(root, '.claude', 'skills'), join(root, '.agents', 'skills')]
  const makeSkill = (skillRoot, id, marker) => {
    const dir = join(skillRoot, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `${id}\n`, 'utf8')
    if (marker) {
      writeFileSync(
        join(dir, MANAGED_WORKSPACE_SKILL_MARKER),
        `${JSON.stringify(marker)}\n`,
        'utf8'
      )
    }
    return dir
  }

  const removedClaude = makeSkill(roots[0], 'removed', {
    managedBy: 'synkora',
    id: 'removed'
  })
  const removedAgents = makeSkill(roots[1], 'removed', {
    managedBy: 'synkora',
    id: 'removed'
  })
  const kept = makeSkill(roots[0], 'kept', { managedBy: 'synkora', id: 'kept' })
  const local = makeSkill(roots[0], 'local', undefined)
  const forged = makeSkill(roots[0], 'forged', {
    managedBy: 'synkora',
    id: 'outro-id'
  })

  assert.deepEqual(pruneUninstalledManagedWorkspaceSkills(roots, new Set(['kept'])), ['removed'])
  assert.equal(existsSync(removedClaude), false)
  assert.equal(existsSync(removedAgents), false)
  assert.equal(existsSync(kept), true)
  assert.equal(existsSync(local), true)
  assert.equal(existsSync(forged), true)
})

test('leases preservam a união das skills de panes paralelos até cada pane encerrar', () => {
  const leases = new WorkspaceSkillLeaseRegistry()
  leases.acquire('pane-a', {
    cwd: 'C:/repo',
    workspaceKey: 'c:/repo',
    ids: ['using-superpowers', 'using-superpowers']
  })
  leases.acquire('pane-b', {
    cwd: 'C:/repo',
    workspaceKey: 'c:/repo',
    ids: ['executing-plans']
  })
  leases.acquire('pane-c', {
    cwd: 'C:/outro',
    workspaceKey: 'c:/outro',
    ids: ['writing-plans']
  })

  assert.deepEqual(leases.activeIds('c:/repo'), [
    'using-superpowers',
    'executing-plans'
  ])
  assert.equal(leases.release('pane-a')?.cwd, 'C:/repo')
  assert.deepEqual(leases.activeIds('c:/repo'), ['executing-plans'])
  assert.deepEqual(leases.activeIds('c:/outro'), ['writing-plans'])
  assert.equal(leases.release('inexistente'), undefined)
})

test('o Maestro recebe toda skill instalada classificada como planejamento', () => {
  const defs = [
    { id: 'old-flag', kind: 'skill', depts: ['research'], group: 'planejamento' },
    { id: 'future', kind: 'skill', depts: ['research'], group: 'Planejamento' },
    { id: 'missing', kind: 'skill', depts: ['research'], group: 'planejamento' },
    { id: 'debug', kind: 'skill', depts: ['back'], group: 'debugging' },
    { id: 'planner-agent', kind: 'agent', depts: ['research'], group: 'planejamento' }
  ]
  const installed = new Set(['old-flag', 'future', 'debug', 'planner-agent'])
  assert.deepEqual(
    selectInstalledPlanningIds(defs, (id) => installed.has(id)),
    ['old-flag', 'future']
  )
})

test('o catálogo real entrega ao Maestro todas as oito skills de planejamento', () => {
  const catalogPlanning = CURATED_SKILLS.filter(
    (skill) => skill.kind === 'skill' && skill.group.toLocaleLowerCase('pt-BR') === 'planejamento'
  ).map((skill) => skill.id)

  assert.deepEqual(catalogPlanning, PLANNING_IDS)
  assert.deepEqual(selectInstalledPlanningIds(CURATED_SKILLS, () => true), PLANNING_IDS)
})

test('front-end também recebe os métodos de implementação, depuração e revisão aplicáveis', () => {
  const frontIds = new Set(selectInstalledIdsForDepartment(CURATED_SKILLS, () => true, 'front'))
  for (const id of [
    'test-driven-development',
    'verification-before-completion',
    'receiving-code-review',
    'systematic-debugging'
  ]) {
    assert.ok(frontIds.has(id), `${id} deveria estar disponível para front-end`)
  }
  assert.equal(frontIds.has('requesting-code-review'), false, 'skill manual não deve ser injetada')
})

test('workflows que disputariam git/review do Synkora são somente explícitos', () => {
  const manual = new Set(
    CURATED_SKILLS.filter((skill) => skill.manualOnly).map((skill) => skill.id)
  )
  for (const id of [
    'executing-plans',
    'finishing-a-development-branch',
    'requesting-code-review',
    'subagent-driven-development',
    'using-git-worktrees',
    'using-superpowers'
  ]) {
    assert.ok(manual.has(id), `${id} deveria exigir seleção explícita`)
  }
})

test('as personas impedem que Superpowers crie um segundo fluxo de execução', () => {
  const personaSource = readFileSync(new URL('../src/main/maestro.ts', import.meta.url), 'utf8')
  assert.match(personaSource, /save_project_plan/)
  assert.match(personaSource, /NEVER create or commit docs\/superpowers/)
  assert.match(personaSource, /start_project_mission/)
  assert.match(personaSource, /SYNKORA PRECEDENCE/)
  assert.match(personaSource, /docs\/superpowers\/specs/)
  assert.match(personaSource, /integrate_mission/)
  assert.match(personaSource, /GREENFIELD ORIGIN/)
  assert.match(personaSource, /CURRENT persisted status/)
  assert.match(personaSource, /awaiting_release/)
  assert.match(personaSource, /done: the original roadmap is history/)
  assert.match(personaSource, /focused-mission flow/)
  assert.match(personaSource, /do not reopen the old roadmap implicitly/)
  assert.match(personaSource, /WINDOWS VISUAL COMPANION/)
  assert.match(personaSource, /Program Files\\\\Git\\\\bin\\\\bash\.exe/)
})
