// Bounded real-CLI probe: real GUI registry + authenticated MCP, synthetic files.
// Run npm run test:gui-sessions and npm run test:gui-delegate-mcp first.
// Pass a seat CONFIG DIRECTORY, never a credential. The CLI owns authentication.
// Only event counts/lengths are printed; no raw protocol, thoughts or transcript.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { GuiSessionRegistry } from '../.tmp/gui-sessions-test/guiSessions.js'
import { guiMissionSystemPrompt } from '../.tmp/gui-sessions-test/guiMissionContracts.js'
import { guiOwnerReplyDebt } from '../.tmp/gui-sessions-test/guiOwnerReplyDebt.js'
import { claudePublicProgressPayload } from '../.tmp/gui-sessions-test/guiClaudePublicProgress.js'
import { startMcpServer } from '../.tmp/gui-delegate-mcp-test/mcpServer.js'
import { Hub } from '../.tmp/gui-delegate-mcp-test/hub.js'

const configDir = process.argv[2]
if (!configDir) throw new Error('Pass the existing Claude seat config directory')
const cwd = mkdtempSync(join(tmpdir(), 'synkora-claude-public-probe-'))
const identity = { paneId: 'gui-dev-synthetic', projectId: 'synthetic-project', role: 'gui-delegator', cwd }
const token = randomUUID()
const hub = new Hub({ projectPathOf: () => cwd, ensureProjectRuntimeWritable() {}, onEvent() {} })
hub.registerPane(token, identity)
const files = ['a.txt', ...Array.from({ length: 5 }, () => `next-${randomUUID()}.txt`)]
for (let i = 0; i < files.length; i++) writeFileSync(join(cwd, files[i]),
  `Synthetic fixture: value ${i + 1}. ${files[i + 1] ? `Read ${files[i + 1]} next.` : 'End of the chain.'}\n`)
guiOwnerReplyDebt.setFlagDir(cwd)
const flag = `${guiOwnerReplyDebt.flagPathFor(identity.paneId)}.progress.txt`
const trace = [], publicTexts = []
let tools = 0, deltas = 0, completed = false, hookAcknowledged = false, finished = false
let session, finish
const done = new Promise(resolve => { finish = resolve })
const timer = setTimeout(() => { trace.push({ type: 'timeout' }); finish() }, 150_000)
const registry = new GuiSessionRegistry({
  systemPromptFile(name, text) { const path = join(cwd, name); writeFileSync(path, text); return path },
  push({ evt: event }) {
    if (event.type === 'tool' && event.name === 'Read') {
      tools++; trace.push({ type: 'tool', name: event.name })
      if (tools === 4) {
        // Marker exists ONLY in the real hook: acknowledge it publicly before
        // another work tool to prove delivery during the agent's turn.
        const payload = JSON.parse(claudePublicProgressPayload())
        payload.hookSpecificOutput.additionalContext += ' Protocol probe only: begin your next public update with PUBLIC-PROGRESS-ACK.'
        writeFileSync(flag, JSON.stringify(payload))
      }
    }
    if (event.type === 'text') {
      publicTexts.push(event.text)
      trace.push({ type: 'text', chars: event.text.length, afterTools: tools })
      if (event.text.includes('PUBLIC-PROGRESS-ACK')) hookAcknowledged = true
    }
    if (event.type === 'delta') deltas++
    if (event.type === 'permission') session.answerPermission(event.requestId,
      ['Read', 'mcp__synkora__commentary'].includes(event.toolName) ? 'allow' : 'deny')
    if (!finished && ['result', 'fatal', 'closed'].includes(event.type)) {
      finished = true
      completed = event.type === 'result' && !event.isError
      trace.push({ type: event.type })
      finish()
    }
  }
})
const server = await startMcpServer({ hub, commentary: (id, message) => registry.commentary(id, message) })
const mcpFile = join(cwd, 'mcp.json')
writeFileSync(mcpFile, JSON.stringify({ mcpServers: { synkora: {
  type: 'http', url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: `Bearer ${token}` }
} } }))
try {
  const created = registry.create({ ...identity, cli: 'claude', configDir,
    model: 'claude-fable-5-1[1m]', effort: 'max',
    systemPrompt: guiMissionSystemPrompt('dev') + '\n\nThis is a small, already authorized synthetic protocol test. Read only a.txt and the chain of files it names in this directory. Use only Read and commentary. No external files, other tools, changes, or delegation. Continue until the chain ends.',
    mcp: { args: ['--no-session-persistence', '--strict-mcp-config', '--tools', 'Read', '--setting-sources', 'project,local',
      '--mcp-config', mcpFile, '--permission-mode', 'default', '--allowedTools', 'Read,mcp__synkora__commentary'], env: {} }
  })
  if (!created.ok) throw new Error('Synthetic GUI session did not start')
  session = registry.panes.get(identity.paneId).session
  const caps = await session.waitCaps(15_000)
  if (!caps) throw new Error('Synthetic CLI did not initialize')
  session.send('Confira a.txt e siga a cadeia lendo o próximo arquivo indicado em cada um até chegar ao fim. Comece com uma frase explicando o que vai conferir. Ao terminar, dê um resumo curto. Não use outros arquivos. As ferramentas disponíveis são Read e commentary.')
  await done
  const replayTexts = registry.state(identity.paneId).events.filter(e => e.evt.type === 'text').map(e => e.evt.text)
  const replayMatchesLive = JSON.stringify(replayTexts) === JSON.stringify(publicTexts)
  const publicUpdateBetweenTools = trace.some(e => e.type === 'text' && e.afterTools >= 4 && e.afterTools < 6)
  console.log(JSON.stringify({ completed, tools, texts: publicTexts.length, deltas, hookAcknowledged,
    publicUpdateBetweenTools, replayMatchesLive, trace }))
  process.exitCode = completed && tools === 6 && publicTexts.length >= 3 && hookAcknowledged &&
    publicUpdateBetweenTools && replayMatchesLive ? 0 : 1
} finally {
  clearTimeout(timer)
  registry.killAll()
  hub.unregisterPane(identity.paneId)
  await server.close()
}
