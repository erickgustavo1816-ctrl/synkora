/**
 * MCP API — domínio mailbox (fase 1, commit 4b).
 * Correio MCP (F6.10): entrega de carona nos resultados de tool, drain
 * explícito e journal do catálogo servido por pane.
 *
 * Corpo movido VERBATIM do literal mcpApi do index.ts. O return é tipado
 * Pick<McpApi, …> para preservar o contextual typing que o literal dava aos
 * parâmetros. uiSender/mcpPort (e campos nascidos depois do literal, como
 * mcpPaneFirstContact) são lidos via ctx a cada uso — getters reativos.
 */
import { join } from 'path'
import { formatInboxBlock, mailboxKeyOf } from '../mailbox'
import type { MainContext } from '../mainContext'
import type { McpApi } from '../mcpServer'

export function buildMailboxApi(
  ctx: MainContext
): Pick<McpApi, 'noteCatalogServed' | 'drainInboxFor' | 'checkMessages'> {
  const {
    blackbox,
    mailbox,
    mcpCatalogServedByPane
  } = ctx
  return {
    noteCatalogServed: (id, tools) => {
      const key = id.paneId ?? 'sem-pane'
      const signature = `${id.role ?? '?'}:${tools.join(',')}`
      if (mcpCatalogServedByPane.get(key) === signature) return
      mcpCatalogServedByPane.set(key, signature)
      blackbox.record({
        cat: 'mcp',
        event: 'catalog-served',
        actor: 'harness',
        ids: {
          projectId: id.projectId,
          missionId: id.missionId,
          taskId: id.taskId,
          paneId: id.paneId,
          role: id.role
        },
        reason: `catálogo MCP construído para role=${id.role ?? '?'} (${tools.length} tools)`,
        detail: { tools: tools.join(',').slice(0, 900) }
      })
    },
    drainInboxFor: (id, tool) => {
      if (!id.paneId) return undefined
      const key = mailboxKeyOf(id, id.paneId)
      const messages = mailbox.drain(key)
      if (messages.length === 0) return undefined
      blackbox.record({
        cat: 'msg',
        event: 'mailbox-delivered',
        actor: 'harness',
        ids: {
          paneId: id.paneId,
          projectId: id.projectId,
          missionId: id.missionId,
          taskId: id.taskId,
          role: id.role
        },
        reason: `${messages.length} mensagem(ns) entregues de carona no resultado de ${tool}`
      })
      return formatInboxBlock(messages)
    },
    checkMessages: (id) => {
      if (!id.paneId) return 'caixa indisponível para esta identidade'
      const key = mailboxKeyOf(id, id.paneId)
      const messages = mailbox.drain(key)
      if (messages.length === 0)
        return 'caixa vazia — nenhuma mensagem pendente para você (as entregas também chegam de carona nos resultados das suas outras tools)'
      blackbox.record({
        cat: 'msg',
        event: 'mailbox-delivered',
        actor: 'harness',
        ids: {
          paneId: id.paneId,
          projectId: id.projectId,
          missionId: id.missionId,
          taskId: id.taskId,
          role: id.role
        },
        reason: `${messages.length} mensagem(ns) drenadas via check_messages`
      })
      return formatInboxBlock(messages).trim()
    }
  }
}
