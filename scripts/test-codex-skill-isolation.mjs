import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  codexSkillIsolationProfileName,
  codexSkillPathsFromPromptInput,
  isMethodGovernedPaneRole,
  prepareCodexSkillIsolationProfile,
  removeCodexSkillIsolationProfile,
  renderCodexSkillIsolationProfile
} from '../src/main/codexSkillIsolation.ts'

function temporaryDirectory(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    cleanup() {
      const safeRoot = resolve(tmpdir()).toLocaleLowerCase('en-US')
      const safeTarget = resolve(dir).toLocaleLowerCase('en-US')
      if (safeTarget.startsWith(`${safeRoot}\\`)) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }
}

test('only method-governed product panes receive the closed skill catalog', () => {
  for (const role of ['maestro', 'dev', 'review', 'qa', 'ajudante']) {
    assert.equal(isMethodGovernedPaneRole(role), true, role)
  }
  for (const role of ['livre', undefined, 'shell']) {
    assert.equal(isMethodGovernedPaneRole(role), false, String(role))
  }
})

test('long pane ids keep generation entropy in the isolation profile name', () => {
  const longPane = `orch-${'a'.repeat(100)}`
  const first = codexSkillIsolationProfileName(`${longPane}-generation-one`)
  const second = codexSkillIsolationProfileName(`${longPane}-generation-two`)
  assert.notEqual(first, second)
  assert.ok(first.length <= 80)
  assert.ok(second.length <= 80)
  assert.match(first, /^synkora-skills-[A-Za-z0-9_-]+-[a-f0-9]{20}$/)
})

test('prompt-input paths become exact disabled skill entries without bodies', () => {
  const output = String.raw`
### Available skills
- alpha (file: C:\\repo\\.agents\\skills\\alpha\\SKILL.md)
- beta (file: C:/Users/example/.codex/skills/.system/beta/SKILL.md)
- duplicate (file: C:/repo/.agents/skills/alpha/SKILL.md)
`
  const paths = codexSkillPathsFromPromptInput(output)
  assert.deepEqual(paths, [
    'C:/repo/.agents/skills/alpha/SKILL.md',
    'C:/Users/example/.codex/skills/.system/beta/SKILL.md'
  ])
  const profile = renderCodexSkillIsolationProfile(paths)
  assert.equal((profile.match(/\[\[skills\.config\]\]/g) ?? []).length, 2)
  assert.equal((profile.match(/enabled = false/g) ?? []).length, 2)
  assert.doesNotMatch(profile, /alpha instructions|beta instructions/)
})

test('profile preparation probes before and after and fails closed on residual catalog', async (t) => {
  const temp = temporaryDirectory('synkora-skill-profile-')
  t.after(temp.cleanup)
  const calls = []
  const prepared = await prepareCodexSkillIsolationProfile({
    paneGenerationId: 'pane-1-generation-1',
    cwd: temp.dir,
    configDir: temp.dir,
    mcpDisableArgs: [],
    probe: async (_cwd, _configDir, profileName) => {
      calls.push(profileName)
      return profileName
        ? 'system prompt without a skill catalog'
        : '### Available skills\n- rogue (file: C:/repo/.agents/skills/rogue/SKILL.md)'
    }
  })
  assert.deepEqual(calls, [undefined, prepared.profileName])
  assert.equal(existsSync(prepared.profilePath), true)
  assert.match(readFileSync(prepared.profilePath, 'utf8'), /rogue\/SKILL\.md/)
  removeCodexSkillIsolationProfile(prepared.profilePath)
  assert.equal(existsSync(prepared.profilePath), false)

  await assert.rejects(
    prepareCodexSkillIsolationProfile({
      paneGenerationId: 'pane-2-generation-1',
      cwd: temp.dir,
      configDir: temp.dir,
      mcpDisableArgs: [],
      probe: async () =>
        '### Available skills\n- still-visible (file: C:/repo/.agents/skills/rogue/SKILL.md)'
    }),
    /remained visible/
  )
})

test('installed Codex removes a real repository skill from effective prompt-input', async (t) => {
  const version = spawnSync('codex', ['--version'], { encoding: 'utf8', windowsHide: true })
  if (version.status !== 0) {
    t.skip('Codex CLI unavailable')
    return
  }
  const workspace = temporaryDirectory('synkora-codex-skill-workspace-')
  const config = temporaryDirectory('synkora-codex-skill-config-')
  t.after(workspace.cleanup)
  t.after(config.cleanup)
  const skillDir = join(workspace.dir, '.agents', 'skills', 'rogue')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: rogue\ndescription: Always use for a Synkora isolation probe.\n---\nROGUE_SENTINEL\n',
    'utf8'
  )
  const prepared = await prepareCodexSkillIsolationProfile({
    paneGenerationId: 'real-codex-probe',
    cwd: workspace.dir,
    configDir: config.dir
  })
  assert.ok(prepared.disabledPaths.some((path) => path.endsWith('/rogue/SKILL.md')))
  assert.equal(existsSync(prepared.profilePath), true)
})

test('launcher integrates isolation after seat preparation and rechecks generation', () => {
  const source = readFileSync(resolve('src/main/index.ts'), 'utf8')
  const prepareAt = source.indexOf('await seats.prepare(seat)')
  const isolateAt = source.indexOf('await prepareCodexSkillIsolationProfile({', prepareAt)
  const recheckAt = source.indexOf('if (!preparationCanContinue())', isolateAt)
  const spawnAt = source.indexOf('ptyCreated = ptys.create', recheckAt)
  assert.ok(prepareAt >= 0 && isolateAt > prepareAt)
  assert.ok(recheckAt > isolateAt && spawnAt > recheckAt)
  assert.match(source.slice(isolateAt, spawnAt), /effectiveCliArgs = \[/)
  assert.match(source.slice(isolateAt, spawnAt), /'-p'/)
  assert.match(source, /methodGoverned \|\| accessProfile !== 'write' \|\| sensitive/)
})

test('prompt probes never start inherited MCP servers', async (t) => {
  const version = spawnSync('codex', ['--version'], { encoding: 'utf8', windowsHide: true })
  if (version.status !== 0) {
    t.skip('Codex CLI unavailable')
    return
  }
  const workspace = temporaryDirectory('synkora-codex-mcp-workspace-')
  const config = temporaryDirectory('synkora-codex-mcp-config-')
  t.after(workspace.cleanup)
  t.after(config.cleanup)
  const sentinelPath = join(config.dir, 'mcp-started.txt')
  const serverPath = join(config.dir, 'sentinel-server.cjs')
  writeFileSync(
    serverPath,
    `require('node:fs').writeFileSync(${JSON.stringify(sentinelPath)}, 'started'); setTimeout(() => process.exit(0), 50)`,
    'utf8'
  )
  writeFileSync(
    join(config.dir, 'config.toml'),
    [
      '[mcp_servers.sentinel]',
      'command = "node"',
      `args = [${JSON.stringify(serverPath.replace(/\\/g, '/'))}]`,
      ''
    ].join('\n'),
    'utf8'
  )

  const prepared = await prepareCodexSkillIsolationProfile({
    paneGenerationId: 'mcp-sentinel-probe',
    cwd: workspace.dir,
    configDir: config.dir
  })
  assert.equal(existsSync(prepared.profilePath), true)
  assert.equal(existsSync(sentinelPath), false)
})
