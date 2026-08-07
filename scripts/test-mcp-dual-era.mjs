#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import {
  Client,
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/client'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = resolve(ROOT, 'docs', 'benchmarks', '2026-07-31', 'phase4-mcp.json')
const MODERN_VERSION = '2026-07-28'
const LEGACY_VERSION = '2025-11-25'
const EXPECTED_COUNTS = Object.freeze({ normal: 22, gate: 9, pm: 33, orchestrator: 28 })
const GATE_TOOLS = Object.freeze([
  'board_status',
  'code_diagnostics',
  'code_definition',
  'code_references',
  'code_symbols',
  'code_hover',
  'code_implementations',
  'code_call_hierarchy',
  'report'
])
const identities = new Map()
const slowWork = new Set()

function round(value) {
  return Math.round(value * 1000) / 1000
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * p
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function stats(values) {
  return {
    samples: values.length,
    medianMs: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    maxMs: round(Math.max(...values))
  }
}

function identity(role, suffix, extra = {}) {
  const value = Object.freeze({
    paneId: `phase4-${suffix}`,
    projectId: 'phase4-project',
    role,
    cwd: `C:\\fixture\\${suffix}`,
    seatId: 'phase4-seat',
    ...extra
  })
  const token = randomUUID()
  identities.set(token, value)
  return { token, identity: value }
}

function stub() {
  return 'phase4-stub'
}

async function asyncStub() {
  return 'phase4-stub'
}

function api() {
  return Object.freeze({
    hub: Object.freeze({ identityByToken: (token) => identities.get(token) }),
    boardStatus: (id) => JSON.stringify({ paneId: id.paneId, cwd: id.cwd, role: id.role }),
    codeQuery: async (id, query) => {
      if (query.path === 'slow.ts') {
        const pending = new Promise((resolvePending) => setTimeout(resolvePending, 350))
        slowWork.add(pending)
        try {
          await pending
        } finally {
          slowWork.delete(pending)
        }
      }
      return JSON.stringify({ paneId: id.paneId, cwd: id.cwd, operation: query.operation })
    },
    codeReportGuard: async () => undefined,
    createTasks: stub,
    archiveMission: stub,
    updateTask: stub,
    report: stub,
    delegateMany: asyncStub,
    listSkills: stub,
    setDefaultSkills: stub,
    notifyMaestro: stub,
    notifyPane: asyncStub,
    listPanes: stub,
    generateImage: asyncStub,
    createMission: stub,
    saveProjectPlan: stub,
    recordPlanningSkillUse: stub,
    approveProjectPlan: stub,
    startProjectMission: stub,
    guideIntegrationResolution: stub,
    createPlan: asyncStub,
    concludePlan: stub,
    runTask: asyncStub,
    deleteTask: stub,
    integrateMission: stub,
    queueMissions: stub,
    releaseVersion: stub,
    setReleaseHold: stub,
    removeBacklogItem: stub,
    registerDirectMission: stub,
    listSeats: asyncStub,
    listHelpers: stub,
    helperOutput: stub,
    helperSend: stub,
    helperClose: stub
  })
}

function methodsFromBody(body) {
  if (!body) return []
  try {
    const parsed = JSON.parse(body)
    const messages = Array.isArray(parsed) ? parsed : [parsed]
    return messages.map((message) => message?.method).filter((method) => typeof method === 'string')
  } catch {
    return []
  }
}

function trackedFetch(log) {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    let body = ''
    if (request.method === 'POST') body = await request.clone().text()
    log.requests += 1
    log.methods.push(...methodsFromBody(body))
    return fetch(input, init)
  }
}

async function openClient(url, token, mode, label) {
  const log = { requests: 0, methods: [] }
  const client = new Client(
    { name: `synkora-phase4-${label}`, version: '1.0.0' },
    { versionNegotiation: { mode }, cachePartition: label }
  )
  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: { token: async () => token },
    fetch: trackedFetch(log)
  })
  const started = performance.now()
  await client.connect(transport)
  return { client, transport, log, connectMs: performance.now() - started }
}

function resultText(result) {
  const block = result.content?.find((item) => item.type === 'text')
  assert.ok(block && typeof block.text === 'string')
  return block.text
}

async function exercise(url, token, mode, label, fakeIdentity = {}) {
  const opened = await openClient(url, token, mode, label)
  const listStarted = performance.now()
  const listed = await opened.client.listTools()
  const listMs = performance.now() - listStarted
  const called = await opened.client.callTool({
    name: 'board_status',
    arguments: { paneId: 'forged-pane', cwd: 'C:\\forged', ...fakeIdentity }
  })
  const marker = JSON.parse(resultText(called))
  return {
    ...opened,
    listMs,
    listed,
    toolNames: listed.tools.map((tool) => tool.name),
    marker
  }
}

async function closeOpened(opened) {
  await opened.client.close().catch(() => undefined)
}

async function rawStatus(url, { token, origin, path = '/mcp' } = {}) {
  return fetch(new URL(path, url), {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} })
  }).then((response) => response.status)
}

function hostStatus(port, host) {
  return new Promise((resolveStatus, rejectStatus) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path: '/mcp', method: 'GET', headers: { host } },
      (res) => {
        res.resume()
        res.once('end', () => resolveStatus(res.statusCode ?? 0))
      }
    )
    req.once('error', rejectStatus)
    req.end()
  })
}

async function profileCatalogs(url) {
  const definitions = [
    ['livre', 'livre', {}, 'normal'],
    ['dev', 'dev', { taskId: 'task-dev', phase: 'dev' }, 'normal'],
    ['review', 'review', { taskId: 'task-review', phase: 'review' }, 'gate'],
    ['qa', 'qa', { taskId: 'task-qa', phase: 'qa' }, 'gate'],
    ['ajudante', 'ajudante', { delegatorPaneId: 'phase4-dev' }, 'normal'],
    ['pm', 'maestro', {}, 'pm'],
    ['orchestrator', 'maestro', { missionId: 'mission-a' }, 'orchestrator']
  ]
  const catalogs = {}
  for (const [label, role, extra, expected] of definitions) {
    const principal = identity(role, `profile-${label}`, extra)
    const opened = await exercise(url, principal.token, 'legacy', `profile-${label}`)
    try {
      assert.equal(opened.toolNames.length, EXPECTED_COUNTS[expected], `${label} tool count`)
      catalogs[label] = opened.toolNames
      if (label === 'review' || label === 'qa') {
        const invalid = await opened.client.callTool({
          name: 'report',
          arguments: { status: 'done' }
        })
        assert.match(resultText(invalid), /só aceitam aprovada ou reprovada/)
        const missingReason = await opened.client.callTool({
          name: 'report',
          arguments: { status: 'reprovada' }
        })
        assert.match(resultText(missingReason), /precisa informar o motivo/)
      } else if (label === 'dev') {
        const invalid = await opened.client.callTool({
          name: 'report',
          arguments: { status: 'aprovada' }
        })
        assert.match(resultText(invalid), /só aceita done/)
      } else if (label === 'pm' || label === 'orchestrator') {
        const invalid = await opened.client.callTool({
          name: 'report',
          arguments: { status: 'done' }
        })
        assert.match(resultText(invalid), /Maestro não conclui/)
      }
    } finally {
      await closeOpened(opened)
    }
  }
  for (const label of ['dev', 'ajudante']) {
    assert.deepEqual(catalogs[label], catalogs.livre, `${label} catalog differs from livre`)
  }
  assert.deepEqual(catalogs.review, GATE_TOOLS, 'review gate ACL differs')
  assert.deepEqual(catalogs.qa, GATE_TOOLS, 'qa gate ACL differs')
  for (const label of ['livre', 'dev', 'review', 'qa', 'ajudante', 'pm']) {
    assert.equal(catalogs[label].includes('create_tasks'), false, `${label} exposes create_tasks`)
    assert.equal(catalogs[label].includes('update_task'), false, `${label} exposes update_task`)
  }
  assert.equal(catalogs.orchestrator.includes('create_tasks'), true)
  assert.equal(catalogs.orchestrator.includes('update_task'), true)
  for (const tool of [
    'record_planning_skill_use',
    'guide_integration_resolution',
    'queue_missions'
  ]) {
    assert.equal(catalogs.pm.includes(tool), true, `pm missing ${tool}`)
    assert.equal(catalogs.orchestrator.includes(tool), false, `orchestrator exposes ${tool}`)
  }
  return Object.fromEntries(
    Object.entries(catalogs).map(([label, names]) => [label, {
      count: names.length,
      sha256: createHash('sha256').update(JSON.stringify(names)).digest('hex'),
      names
    }])
  )
}

async function latency(url, era, rounds) {
  const connect = []
  const list = []
  const mode = era === 'modern' ? { pin: MODERN_VERSION } : 'legacy'
  for (let index = 0; index < rounds; index += 1) {
    const principal = identity('livre', `${era}-latency-${index}`)
    const opened = await exercise(url, principal.token, mode, `${era}-latency-${index}`)
    connect.push(opened.connectMs)
    list.push(opened.listMs)
    await closeOpened(opened)
  }
  return { connect: stats(connect), listTools: stats(list) }
}

async function concurrentClients(url) {
  const opened = await Promise.all(Array.from({ length: 32 }, async (_, index) => {
    const era = index % 2 === 0 ? 'legacy' : 'modern'
    const mode = era === 'modern' ? { pin: MODERN_VERSION } : 'legacy'
    const principal = identity('dev', `c32-${index}`, { taskId: `task-${index}`, phase: 'dev' })
    const client = await exercise(url, principal.token, mode, `c32-${index}`)
    assert.equal(client.marker.paneId, principal.identity.paneId)
    assert.equal(client.client.getProtocolEra(), era)
    return client
  }))
  try {
    const reference = opened[0].toolNames
    for (const client of opened) assert.deepEqual(client.toolNames, reference)
  } finally {
    await Promise.all(opened.map(closeOpened))
  }
  return { clients: opened.length, legacy: 16, modern: 16 }
}

async function cancellationAndDisconnect(url) {
  const cancelPrincipal = identity('dev', 'cancel', { taskId: 'cancel-task', phase: 'dev' })
  const cancelClient = await openClient(url, cancelPrincipal.token, { pin: MODERN_VERSION }, 'cancel')
  const controller = new AbortController()
  const started = performance.now()
  const pending = cancelClient.client.callTool(
    { name: 'code_symbols', arguments: { path: 'slow.ts' } },
    { signal: controller.signal, timeout: 2_000 }
  )
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(
    pending,
    (error) => error?.name === 'AbortError' || /AbortError|aborted/i.test(String(error?.message))
  )
  const cancelMs = performance.now() - started
  assert.ok(cancelMs < 1_000)
  const afterAbort = await cancelClient.client.callTool({ name: 'board_status', arguments: {} })
  assert.equal(JSON.parse(resultText(afterAbort)).paneId, cancelPrincipal.identity.paneId)
  await closeOpened(cancelClient)

  const disconnectPrincipal = identity('dev', 'disconnect', { taskId: 'disconnect-task', phase: 'dev' })
  const disconnectClient = await openClient(
    url,
    disconnectPrincipal.token,
    { pin: MODERN_VERSION },
    'disconnect'
  )
  const disconnectPending = disconnectClient.client
    .callTool({ name: 'code_symbols', arguments: { path: 'slow.ts' } }, { timeout: 2_000 })
    .then(() => 'resolved', () => 'rejected')
  setTimeout(() => void disconnectClient.client.close(), 30)
  const disposition = await Promise.race([
    disconnectPending,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), 1_000))
  ])
  assert.notEqual(disposition, 'timeout')
  return { abortMs: round(cancelMs), disconnectDisposition: disposition }
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('Node 24+ is required for TypeScript type stripping')
  }
  const { startMcpServer } = await import(new URL('../src/main/mcpServer.ts', import.meta.url))
  const server = await startMcpServer(api())
  const url = new URL(`http://127.0.0.1:${server.port}/mcp`)
  const allOpened = []
  try {
    const legacyPrincipal = identity('livre', 'legacy-main')
    const modernPrincipal = identity('livre', 'modern-main')
    const [legacy, modern] = await Promise.all([
      exercise(url, legacyPrincipal.token, 'legacy', 'legacy-main'),
      exercise(url, modernPrincipal.token, { pin: MODERN_VERSION }, 'modern-main')
    ])
    allOpened.push(legacy, modern)
    assert.equal(legacy.client.getProtocolEra(), 'legacy')
    assert.equal(legacy.client.getNegotiatedProtocolVersion(), LEGACY_VERSION)
    assert.equal(modern.client.getProtocolEra(), 'modern')
    assert.equal(modern.client.getNegotiatedProtocolVersion(), MODERN_VERSION)
    assert.deepEqual(legacy.toolNames, modern.toolNames)
    assert.deepEqual(legacy.log.methods.slice(0, 2), ['initialize', 'notifications/initialized'])
    assert.ok(legacy.log.methods.includes('tools/list'))
    assert.ok(legacy.log.methods.includes('tools/call'))
    assert.equal(legacy.log.methods.includes('server/discover'), false)
    assert.equal(modern.log.methods[0], 'server/discover')
    assert.equal(modern.log.methods.includes('initialize'), false)
    assert.ok(modern.log.methods.includes('tools/list'))
    assert.ok(modern.log.methods.includes('tools/call'))
    assert.equal(modern.listed.ttlMs, 300_000)
    assert.equal(modern.listed.cacheScope, 'private')
    assert.equal(modern.client.getDiscoverResult()?.ttlMs, 300_000)
    assert.equal(modern.client.getDiscoverResult()?.cacheScope, 'private')
    assert.equal(legacy.listed.ttlMs, undefined)
    assert.equal(legacy.listed.cacheScope, undefined)

    const beforeCachedList = modern.log.requests
    const cachedList = await modern.client.listTools()
    assert.deepEqual(cachedList.tools.map((tool) => tool.name), modern.toolNames)
    assert.equal(modern.log.requests, beforeCachedList)

    assert.equal(legacy.marker.paneId, legacyPrincipal.identity.paneId)
    assert.equal(legacy.marker.cwd, legacyPrincipal.identity.cwd)
    const cross = await exercise(url, modernPrincipal.token, 'legacy', 'cross-token', {
      paneId: legacyPrincipal.identity.paneId,
      cwd: legacyPrincipal.identity.cwd
    })
    allOpened.push(cross)
    assert.equal(cross.marker.paneId, modernPrincipal.identity.paneId)
    assert.equal(cross.marker.cwd, modernPrincipal.identity.cwd)

    assert.equal(await rawStatus(url), 401)
    assert.equal(await rawStatus(url, { token: 'invalid-token' }), 401)
    assert.equal(await rawStatus(url, { origin: 'https://evil.example' }), 403)
    assert.equal(await hostStatus(server.port, 'evil.example'), 403)
    assert.equal(await rawStatus(url, { token: legacyPrincipal.token, path: '/mcp-extra' }), 404)
    const revoked = identity('livre', 'revoked')
    identities.delete(revoked.token)
    assert.equal(await rawStatus(url, { token: revoked.token }), 401)

    const catalogs = await profileCatalogs(url)
    const concurrent = await concurrentClients(url)
    const cancellation = await cancellationAndDisconnect(url)
    const timings = {
      legacy: await latency(url, 'legacy', 30),
      modern: await latency(url, 'modern', 30)
    }

    const report = {
      schemaVersion: 1,
      benchmark: 'synkora-mcp-dual-era',
      generatedAt: new Date().toISOString(),
      packages: {
        server: '2.0.0',
        node: '2.0.0',
        client: '2.0.0'
      },
      protocols: {
        legacy: LEGACY_VERSION,
        modern: MODERN_VERSION,
        simultaneous: true,
        legacyMethods: legacy.log.methods,
        modernMethods: modern.log.methods
      },
      cache: {
        ttlMs: modern.listed.ttlMs,
        scope: modern.listed.cacheScope,
        secondListRequests: modern.log.requests - beforeCachedList
      },
      authentication: {
        missingRejected: true,
        invalidRejected: true,
        revokedRejected: true,
        crossPaneBoundToBearer: true,
        identityArgumentsIgnored: true,
        hostRejected: true,
        originRejected: true,
        exactPathRequired: true
      },
      catalogs,
      concurrency: concurrent,
      cancellation,
      timings
    }
    const serialized = JSON.stringify(report, null, 2)
    assert.doesNotMatch(serialized, /Bearer |SYNKORA_TOKEN|C:\\\\fixture|invalid-token/)
    writeFileSync(OUTPUT, `${serialized}\n`, 'utf-8')
    process.stdout.write(`MCP dual-era passed: 32 clients, ${legacy.toolNames.length} normal tools\n`)
    process.stdout.write(`report: ${OUTPUT}\n`)
  } finally {
    await Promise.all(allOpened.map(closeOpened))
    await Promise.allSettled([...slowWork])
    await server.close()
  }
}

const timeout = setTimeout(() => {
  process.stderr.write('MCP dual-era timed out\n')
  process.exitCode = 1
}, 120_000)
timeout.unref()

try {
  await main()
} catch (error) {
  process.exitCode = 1
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
} finally {
  clearTimeout(timeout)
}
