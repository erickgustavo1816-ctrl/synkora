import type { CliCaps, CliCommand } from './maestroSession'

// Local commands belong to the pane, regardless of the CLI behind it.
const CONVERSATION_COMMANDS: CliCommand[] = [
  { name: 'new', description: 'zera o contexto e começa outra conversa neste mesmo chat' },
  { name: 'reset', description: 'igual a /new: reinicia a conversa neste mesmo chat' },
  { name: 'clear', description: 'igual a /new: reinicia a conversa neste mesmo chat' }
]
const commandNames = new Set(CONVERSATION_COMMANDS.map(({ name }) => `/${name}`))

export const GUI_NEW_CONVERSATION_USAGE =
  'Para começar outra conversa neste mesmo chat, envie /new, /new chat, /reset ou /clear sozinho, sem anexos. Os arquivos da missão são mantidos.'

/** Only an explicit, standalone command resets the conversation. Prose,
 * arguments and multiline messages must never discard context by accident. */
export function routeGuiConversationCommand(text: string): 'reset' | 'usage' | null {
  const trimmed = text.trim()
  const name = trimmed.split(/\s+/u)[0]
  if (!commandNames.has(name)) return null
  return /^\/(?:new(?:[ \t]+chat)?|reset|clear)$/u.test(trimmed) ? 'reset' : 'usage'
}

/** Publish the pane's commands alongside genuine CLI capabilities. Local
 * descriptions override terminal-only copies; custom skills remain intact. */
export function withGuiConversationCommands(caps: CliCaps): CliCaps {
  return {
    ...caps,
    commands: [
      ...CONVERSATION_COMMANDS.map((command) => ({ ...command })),
      ...caps.commands.filter(({ name }) => !commandNames.has(name.startsWith('/') ? name : `/${name}`))
    ]
  }
}
