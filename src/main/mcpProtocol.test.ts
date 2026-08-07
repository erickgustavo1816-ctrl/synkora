import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CODEX_MCP_2026_FEATURE,
  CODEX_MCP_PROTOCOL_CACHE_TTL_MS,
  CodexMcpProtocolDetector,
  codexMcpProtocolArgs,
  codexMcpProtocolDecision,
  type CodexMcpProtocolProbe,
  type CodexProbeCommand,
  type CodexProbeRunner
} from './mcpProtocol'

function fixedRunner(
  versionOutput: string,
  featuresOutput: string,
  calls: CodexProbeCommand[] = []
): CodexProbeRunner {
  return async (command) => {
    calls.push(command)
    return {
      ok: true,
      output: command.args[0] === '--version' ? versionOutput : featuresOutput
    }
  }
}

function capableProbe(featureEnabled: boolean): CodexMcpProtocolProbe {
  return {
    checkedAt: 1,
    version: '0.147.0-alpha.1',
    featurePresent: true,
    featureEnabled,
    capability: true,
    reason: 'ready'
  }
}

test('probes both Codex commands with an isolated environment and accepts the minimum version', async () => {
  const calls: CodexProbeCommand[] = []
  const detector = new CodexMcpProtocolDetector({
    runner: fixedRunner(
      'codex-cli 0.147.0-alpha.1',
      `other_feature stable true\n${CODEX_MCP_2026_FEATURE} experimental false`,
      calls
    ),
    now: () => 1_000
  })

  const probe = await detector.probe('C:\\Codex Seats\\ação')
  assert.deepEqual(calls.map((call) => call.args), [['--version'], ['features', 'list']])
  for (const call of calls) {
    assert.equal(call.command, 'codex')
    assert.equal(call.env['CODEX_HOME'], 'C:\\Codex Seats\\ação')
    assert.equal(typeof call.env['PATH'], 'string')
    assert.equal(call.timeoutMs, 15_000)
    assert.equal(call.windowsHide, true)
  }
  assert.equal(probe.version, '0.147.0-alpha.1')
  assert.equal(probe.featurePresent, true)
  assert.equal(probe.featureEnabled, false)
  assert.equal(probe.capability, true)
  assert.equal(probe.reason, 'ready')
  assert.equal(detector.status('C:\\Codex Seats\\ação').state, 'ready')
})

test('mode policy enables or disables the feature only when capability is proven', () => {
  const disabled = capableProbe(false)
  const enabled = capableProbe(true)
  const unsupported: CodexMcpProtocolProbe = {
    ...enabled,
    capability: false,
    reason: 'version-too-old'
  }

  assert.deepEqual(codexMcpProtocolDecision('auto', enabled), {
    requestedMode: 'auto',
    effectiveProtocol: 'modern',
    args: [],
    probe: enabled
  })
  assert.deepEqual(codexMcpProtocolArgs('auto', disabled), [
    '--disable',
    CODEX_MCP_2026_FEATURE
  ])
  assert.deepEqual(codexMcpProtocolArgs('legacy', enabled), [
    '--disable',
    CODEX_MCP_2026_FEATURE
  ])
  assert.deepEqual(codexMcpProtocolArgs('modern-experimental', disabled), [
    '--enable',
    CODEX_MCP_2026_FEATURE
  ])
  const fallback = codexMcpProtocolDecision('modern-experimental', unsupported)
  assert.equal(fallback.effectiveProtocol, 'legacy')
  assert.deepEqual(fallback.args, [])
})

test('fails closed for an old version, a lookalike feature or malformed feature state', async () => {
  const old = new CodexMcpProtocolDetector({
    runner: fixedRunner(
      'codex-cli 0.146.999',
      `${CODEX_MCP_2026_FEATURE} experimental true`
    )
  })
  assert.equal((await old.probe()).capability, false)
  assert.equal((await old.probe()).reason, 'version-too-old')

  const lookalike = new CodexMcpProtocolDetector({
    runner: fixedRunner(
      'codex-cli 0.147.0',
      `${CODEX_MCP_2026_FEATURE}_extra experimental true`
    )
  })
  const missing = await lookalike.probe()
  assert.equal(missing.featurePresent, false)
  assert.equal(missing.capability, false)
  assert.equal(missing.reason, 'feature-missing')

  const malformed = new CodexMcpProtocolDetector({
    runner: fixedRunner('codex-cli 0.147.0', `${CODEX_MCP_2026_FEATURE} experimental maybe`)
  })
  const invalid = await malformed.probe()
  assert.equal(invalid.featurePresent, true)
  assert.equal(invalid.featureEnabled, null)
  assert.equal(invalid.capability, false)
  assert.equal(invalid.reason, 'feature-output-invalid')
})

test('shares a ten-minute single-flight per configDir and exposes only sanitized status', async () => {
  let now = 5_000
  let commandCount = 0
  const runner: CodexProbeRunner = async (command) => {
    commandCount += 1
    return {
      ok: true,
      output: command.args[0] === '--version'
        ? 'codex-cli 0.147.0-alpha.3'
        : `${CODEX_MCP_2026_FEATURE} experimental true\nsecret-token-do-not-cache`
    }
  }
  const detector = new CodexMcpProtocolDetector({ runner, now: () => now })

  const [first, second] = await Promise.all([
    detector.prewarm('C:\\private-seat'),
    detector.probe('C:\\private-seat')
  ])
  assert.deepEqual(first, second)
  assert.equal(commandCount, 2)
  await detector.probe('C:\\private-seat')
  assert.equal(commandCount, 2)

  await detector.probe('C:\\other-seat')
  assert.equal(commandCount, 4)
  now += CODEX_MCP_PROTOCOL_CACHE_TTL_MS + 1
  assert.equal(detector.status('C:\\private-seat').state, 'expired')
  await detector.probe('C:\\private-seat')
  assert.equal(commandCount, 6)

  const serialized = JSON.stringify(detector.status('C:\\private-seat'))
  assert.doesNotMatch(serialized, /private-seat|secret-token/)
  detector.invalidate()
  assert.equal(detector.status('C:\\private-seat').state, 'idle')
  assert.equal(detector.status('C:\\other-seat').state, 'idle')
})

test('runner failures do not leak command output and remain legacy', async () => {
  const detector = new CodexMcpProtocolDetector({
    runner: async () => {
      throw new Error('SYNKORA_TOKEN=private CODEX_HOME=C:\\private')
    }
  })
  const decision = await detector.decision('modern-experimental', 'C:\\private')
  assert.equal(decision.effectiveProtocol, 'legacy')
  assert.deepEqual(decision.args, [])
  assert.equal(decision.probe.reason, 'codex-unavailable')
  assert.doesNotMatch(JSON.stringify(detector.status('C:\\private')), /SYNKORA_TOKEN|C:\\\\private/)
})
