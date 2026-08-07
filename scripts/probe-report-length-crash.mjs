#!/usr/bin/env node
// Sonda 2026-08-02: reproduzir o "Cannot read properties of undefined
// (reading 'length')" que o dev CLAUDE do card non_code recebeu 5x ao chamar
// report {status:"done"} (missão "Link bonito no WhatsApp", card 447ebd67).
// O Proxy da caixa-preta NÃO registrou nem codeReportGuard nem report nas
// tentativas — o crash acontece ANTES do api.*, na camada mcpServer/SDK.
// Roda o startMcpServer REAL com api stub e varia a forma da chamada.
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const identities = new Map()

function identity(role, suffix, extra = {}) {
  const value = Object.freeze({
    paneId: `probe-${suffix}`,
    projectId: 'probe-project',
    role,
    cwd: `C:\\fixture\\${suffix}`,
    seatId: 'probe-seat',
    ...extra
  })
  const token = randomUUID()
  identities.set(token, value)
  return { token, identity: value }
}

const stub = () => 'probe-stub'
const asyncStub = async () => 'probe-stub'

function api() {
  return Object.freeze({
    hub: Object.freeze({ identityByToken: (token) => identities.get(token) }),
    boardStatus: stub,
    codeQuery: asyncStub,
    // guard PASSA (como no caso real pós-.md) — o crash veio depois dele
    codeReportGuard: async () => undefined,
    createTasks: stub,
    archiveMission: stub,
    updateTask: stub,
    report: (id, content, summary) =>
      `report ok: role=${id.role} content=${content} summary=${(summary ?? '').length} chars`,
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

const { startMcpServer } = await import(new URL('../src/main/mcpServer.ts', import.meta.url))
const server = await startMcpServer(api())
const url = new URL(`http://127.0.0.1:${server.port}/mcp`)

const dev = identity('dev', 'dev', { taskId: 'task-dev', phase: 'dev' })

// claude 2.1.220 fala a spec LEGADA — igual ao pane real.
const cases = [
  ['done sem summary', { status: 'done' }],
  ['done com summary curto', { status: 'done', summary: 'resumo curto' }],
  ['done com summary longo', { status: 'done', summary: 'x'.repeat(3000) }],
  ['done com summary unicode', { status: 'done', summary: 'imagem 1200×630 ✓ · Pinyon “ok”' }],
  ['done com reason extra', { status: 'done', reason: 'n/a', summary: 's' }]
]

for (const [label, args] of cases) {
  const client = new Client(
    { name: `probe-${label}`, version: '1.0.0' },
    { versionNegotiation: { mode: 'legacy' }, cachePartition: label }
  )
  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: { token: async () => dev.token }
  })
  try {
    await client.connect(transport)
    const result = await client.callTool({ name: 'report', arguments: args })
    const text = result.content?.find((item) => item.type === 'text')?.text
    console.log(`[${label}] isError=${result.isError ?? false} => ${String(text).slice(0, 140)}`)
  } catch (error) {
    console.log(`[${label}] THROW => ${error?.message}`)
    if (error?.stack) console.log(String(error.stack).split('\n').slice(0, 6).join('\n'))
  } finally {
    await client.close().catch(() => undefined)
  }
}

await server.close?.()
process.exit(0)
