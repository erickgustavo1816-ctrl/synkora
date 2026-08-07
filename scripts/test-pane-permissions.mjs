import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  codexGateMcpDisableArgs,
  codexGateMcpPolicyArgs,
  paneAccessProfile,
  paneExternalMcpCapabilities,
  panePermissionArgs
} from '../src/main/panePermissions.ts'

test('Codex gates disable every inherited MCP except the freshly injected Synkora server', () => {
  assert.deepEqual(
    codexGateMcpDisableArgs(`
[mcp_servers.node_repl]
command = "node"
[mcp_servers.node_repl.env]
MODE = "safe"
[mcp_servers.openaiDeveloperDocs]
url = "https://example.invalid"
[mcp_servers."quoted.server"]
command = "node"
[mcp_servers.synkora]
url = "http://127.0.0.1"
`),
    [
      '-c',
      'mcp_servers.node_repl.enabled=false',
      '-c',
      'mcp_servers.openaiDeveloperDocs.enabled=false',
      '-c',
      'mcp_servers."quoted.server".enabled=false'
    ]
  )
})

test('Codex gate fails closed when an inherited MCP key cannot be parsed', () => {
  assert.throws(
    () => codexGateMcpDisableArgs('[mcp_servers.]'),
    /gate Codex bloqueado/
  )
  assert.throws(
    () => codexGateMcpDisableArgs('[mcp_servers]\nevil = { command = "cmd" }'),
    /gate Codex bloqueado/
  )
  assert.throws(
    () => codexGateMcpDisableArgs('mcp_servers = { evil = { command = "cmd" } }'),
    /gate Codex bloqueado/
  )
})

test('generated overrides really disable inherited servers in Codex itself', (t) => {
  const version = spawnSync('codex', ['--version'], {
    encoding: 'utf-8',
    windowsHide: true
  })
  if (version.status !== 0) {
    t.skip('Codex CLI indisponível neste ambiente')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'synkora-gate-mcp-'))
  t.after(() => {
    const safeRoot = resolve(tmpdir()).toLocaleLowerCase('en-US')
    const safeTarget = resolve(dir).toLocaleLowerCase('en-US')
    if (safeTarget.startsWith(safeRoot + '\\')) rmSync(dir, { recursive: true, force: true })
  })
  const config = [
    '[mcp_servers.node_repl]',
    'command = "cmd"',
    '[mcp_servers.openaiDeveloperDocs]',
    'command = "cmd"',
    ''
  ].join('\n')
  writeFileSync(join(dir, 'config.toml'), config, 'utf-8')
  const probe = spawnSync(
    'codex',
    [
      ...codexGateMcpDisableArgs(config),
      ...codexGateMcpPolicyArgs(),
      '-c',
      'mcp_servers.synkora.command="cmd"',
      'mcp',
      'list',
      '--json'
    ],
    {
      encoding: 'utf-8',
      windowsHide: true,
      env: { ...process.env, CODEX_HOME: dir }
    }
  )
  assert.equal(probe.status, 0, probe.stderr)
  const catalog = JSON.parse(probe.stdout)
  const enabled = new Map(catalog.map((entry) => [entry.name, entry.enabled]))
  assert.equal(enabled.get('node_repl'), false)
  assert.equal(enabled.get('openaiDeveloperDocs'), false)
  assert.equal(enabled.get('synkora'), true)
})

test('role mapping is the single source for spawn and remount capabilities', () => {
  assert.equal(paneAccessProfile('review'), 'review-read-only')
  assert.equal(paneAccessProfile('qa'), 'qa-read-only')
  assert.equal(paneAccessProfile('dev'), 'write')
  assert.deepEqual(paneExternalMcpCapabilities(paneAccessProfile('review')), {
    browser: false,
    testRunner: false
  })
  // decisão do usuário (02/08): QA valida FUNCIONANDO — Chrome PRÓPRIO
  // (Playwright isolado) + runner; nunca a integração com o navegador pessoal
  assert.deepEqual(paneExternalMcpCapabilities(paneAccessProfile('qa')), {
    browser: true,
    testRunner: true
  })
  assert.deepEqual(paneExternalMcpCapabilities(paneAccessProfile('dev')), {
    browser: true,
    testRunner: true
  })
})

test('gates Codex stay readable without bypass, writes, network or escalation', () => {
  for (const bypass of [false, true]) {
    for (const profile of ['review-read-only', 'qa-read-only']) {
      const args = panePermissionArgs('codex', bypass, profile)
      assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false)
      assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only')
      assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'never')
      assert.equal(args.includes('shell_tool'), false, 'shell é a LEITURA do reviewer')
      for (const feature of [
        'multi_agent',
        'apps',
        'browser_use',
        'browser_use_external',
        'browser_use_full_cdp_access',
        'in_app_browser',
        'computer_use',
        'image_generation',
        'plugins',
        'remote_plugin',
        'hooks'
      ]) {
        assert.equal(args.includes(feature), true)
      }
    }
  }
})

test('Codex gate MCP policy exposes only audited read-only tools and is required', () => {
  const args = codexGateMcpPolicyArgs()
  const overrides = args.filter((_, index) => index % 2 === 1)
  const enabled = overrides.find((entry) => entry.startsWith('mcp_servers.synkora.enabled_tools='))
  assert.ok(enabled)
  const tools = JSON.parse(enabled.slice(enabled.indexOf('=') + 1))
  assert.deepEqual(tools.sort(), [
    // correio MCP do pane (CHECK 15, 2026-08-07)
    'check_messages',
    'code_call_hierarchy',
    'code_definition',
    'code_diagnostics',
    'code_hover',
    'code_implementations',
    'code_references',
    'code_symbols',
    'report',
    // agência do QA sobre o runtime do harness (2026-08-06)
    'runtime_control',
    // frase viva no radar do dono (2026-08-06) — escreve só estado do harness
    'status_note'
  ].sort())
  assert.equal(overrides.includes('mcp_servers.synkora.default_tools_approval_mode="approve"'), true)
  assert.equal(overrides.includes('mcp_servers.synkora.required=true'), true)
})

test('review Claude exposes only reading/skill built-ins and audited Synkora tools', () => {
  for (const bypass of [false, true]) {
    const args = panePermissionArgs('claude', bypass, 'review-read-only')
    assert.equal(args.includes('--setting-sources='), true)
    // sem settings, o diálogo "Claude in Chrome" travava o gate (visto ao
    // vivo em 02/08) — a integração fica desligada na flag
    assert.equal(args.includes('--no-chrome'), true)
    // plan mode bloqueia o mcp__synkora__report (sonda 5) — nunca pode voltar
    assert.equal(args.includes('plan'), false)
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob,Skill')
    assert.match(args[args.indexOf('--allowedTools') + 1], /mcp__synkora__report/)
    // review é CODE ONLY: nenhum browser/runner
    assert.doesNotMatch(args[args.indexOf('--allowedTools') + 1], /playwright/)
    // ferramenta de escrita NUNCA entra no catálogo do gate
    assert.doesNotMatch(args.join(' '), /\bBash\b|\bEdit\b|\bWrite\b|\bTask\b/)
    // BYPASS LIGADO VALE SEMPRE, também no gate (caso real 2026-08-06: o
    // reviewer parou num prompt de LEITURA fora do cwd — DESIGN.md do projeto
    // não existe no worktree porque .synkora é git-invisível). Sem escrita no
    // catálogo, o bypass só silencia prompts de leitura.
    if (bypass) {
      assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions')
    } else {
      assert.equal(args.includes('--permission-mode'), false)
    }
  }
})

test('QA Claude keeps the hard MCP boundary but gets its OWN browser (user rule 02/08)', () => {
  for (const bypass of [false, true]) {
    const args = panePermissionArgs('claude', bypass, 'qa-read-only')
    assert.equal(args.includes('--setting-sources='), true)
    assert.equal(args.includes('--no-chrome'), true)
    // "QA é sempre para usar um chrome só dele" — Playwright isolado allowlisted
    assert.match(args[args.indexOf('--allowedTools') + 1], /mcp__playwright/)
    assert.doesNotMatch(args.join(' '), /\bBash\b|\bEdit\b|\bWrite\b|\bTask\b/)
    assert.equal(args.includes('--permission-mode'), bypass)
  }
})

test('write panes preserve the existing project permission policy', () => {
  assert.deepEqual(panePermissionArgs('claude', true), [
    '--permission-mode',
    'bypassPermissions'
  ])
  assert.deepEqual(panePermissionArgs('claude', false), [
    '--permission-mode',
    'acceptEdits'
  ])
  assert.deepEqual(panePermissionArgs('codex', true), [
    '--dangerously-bypass-approvals-and-sandbox'
  ])
  assert.deepEqual(panePermissionArgs('codex', false), [])
})

test('sensitive writers fail safe only in strict mode — bypass ON always wins (user law 2026-08-05)', () => {
  // BYPASS LIGADO VALE SEMPRE ("independente do risco, high ou low"): com o
  // toggle ⏩ do projeto, pane sensível roda com bypass como qualquer outro —
  // a cerca real dos sensíveis segue fingerprint + review/QA + ACL MCP.
  assert.deepEqual(panePermissionArgs('claude', true, 'write', { sensitive: true }), [
    '--permission-mode',
    'bypassPermissions'
  ])
  assert.deepEqual(panePermissionArgs('codex', true, 'write', { sensitive: true }), [
    '--dangerously-bypass-approvals-and-sandbox'
  ])
  // Modo ESTRITO (bypass desligado): o ramo restritivo sensível continua.
  assert.deepEqual(panePermissionArgs('claude', false, 'write', { sensitive: true }), [
    '--setting-sources=',
    '--no-chrome',
    '--permission-mode',
    'manual'
  ])
  const codex = panePermissionArgs('codex', false, 'write', { sensitive: true })
  assert.deepEqual(codex.slice(0, 4), [
    '--sandbox',
    'workspace-write',
    '--ask-for-approval',
    'untrusted'
  ])
  assert.equal(codex.includes('--dangerously-bypass-approvals-and-sandbox'), false)
  for (const disabled of [
    'multi_agent',
    'apps',
    'browser_use',
    'browser_use_external',
    'browser_use_full_cdp_access',
    'in_app_browser',
    'computer_use',
    'image_generation',
    'plugins',
    'remote_plugin',
    'hooks'
  ]) {
    assert.equal(codex.includes(disabled), true)
  }

  // Backward compatibility: an ordinary writer keeps the existing fast path.
  assert.deepEqual(panePermissionArgs('claude', true, 'write', { sensitive: false }), [
    '--permission-mode',
    'bypassPermissions'
  ])
})

test('sensitive read-only gates never regain bypass or external browser tools', () => {
  for (const profile of ['review-read-only', 'qa-read-only']) {
    const codex = panePermissionArgs('codex', true, profile, { sensitive: true })
    assert.equal(codex.includes('--dangerously-bypass-approvals-and-sandbox'), false)
    assert.equal(codex[codex.indexOf('--sandbox') + 1], 'read-only')
  }
  const claudeQa = panePermissionArgs('claude', true, 'qa-read-only', { sensitive: true })
  assert.doesNotMatch(claudeQa[claudeQa.indexOf('--allowedTools') + 1], /playwright/)
})
