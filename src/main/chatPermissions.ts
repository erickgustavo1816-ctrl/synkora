/**
 * Permission rules shared by the chat backends.
 *
 * The CLI is authoritative when it supplies permission suggestions. The
 * fallback below is deliberately narrow: it only covers Bash commands and
 * uses the first two conservative tokens, so clicking "sempre" can never
 * silently turn into an unrestricted command grant.
 */

const SAFE_BASH_TOKEN = /^[A-Za-z0-9._/@:+%=,-]+$/u
const MAX_RULE_LENGTH = 240

function fallbackBashPermissionRule(
  toolName: string,
  input: Record<string, unknown>
): string | undefined {
  if (toolName.toLowerCase() !== 'bash') return undefined
  const command = typeof input['command'] === 'string' ? input['command'].trim() : ''
  if (!command) return undefined

  const tokens = command.split(/\s+/u).slice(0, 2)
  if (tokens.length === 0 || tokens.some((token) => !SAFE_BASH_TOKEN.test(token))) return undefined

  const rule = `Bash(${tokens.join(' ')}:*)`
  return rule.length <= MAX_RULE_LENGTH ? rule : undefined
}

type PermissionRuleEntry = {
  toolName: string
  ruleContent?: string
}

type PermissionUpdate = {
  type: string
  rules?: PermissionRuleEntry[]
  behavior?: string
  destination?: string
  mode?: string
  directories?: string[]
}

function isPermissionUpdate(value: unknown): value is PermissionUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const update = value as Record<string, unknown>
  if (typeof update['type'] !== 'string') return false
  if (
    update['type'] === 'addRules' ||
    update['type'] === 'replaceRules' ||
    update['type'] === 'removeRules'
  ) {
    return (
      Array.isArray(update['rules']) &&
      update['rules'].every((rule) => {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false
        const entry = rule as Record<string, unknown>
        return (
          typeof entry['toolName'] === 'string' &&
          (entry['ruleContent'] === undefined || typeof entry['ruleContent'] === 'string')
        )
      })
    )
  }
  if (update['type'] === 'setMode') return typeof update['mode'] === 'string'
  if (update['type'] === 'addDirectories' || update['type'] === 'removeDirectories') {
    return Array.isArray(update['directories']) && update['directories'].every((item) => typeof item === 'string')
  }
  return false
}

/**
 * Resolve what the "sempre" action will send back to the CLI.
 *
 * Claude's permission protocol uses update entry objects, not display
 * strings. Valid CLI entries are returned verbatim; when none arrive, a
 * conservative Bash prefix is converted to the smallest `addRules` entry.
 */
export function resolveChatPermissionSuggestions(
  toolName: string,
  input: Record<string, unknown>,
  suggestions: unknown
): unknown[] {
  const cliSuggestions = Array.isArray(suggestions)
    ? suggestions.filter(isPermissionUpdate)
    : []
  if (cliSuggestions.length > 0) return cliSuggestions

  const fallback = fallbackBashPermissionRule(toolName, input)
  if (!fallback) return []
  return [
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: fallback.slice('Bash('.length, -1) }],
      behavior: 'allow',
      destination: 'localSettings'
    }
  ]
}

/** The compact rule shown in the permission card before the user confirms. */
export function chatPermissionRuleLabel(suggestions: readonly unknown[]): string | undefined {
  const labels: string[] = []
  for (const suggestion of suggestions) {
    if (typeof suggestion === 'string' && suggestion.trim()) {
      labels.push(suggestion.trim())
      continue
    }
    if (!isPermissionUpdate(suggestion)) continue
    if (suggestion.rules) {
      for (const rule of suggestion.rules) {
        labels.push(
          rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName
        )
      }
    } else if (suggestion.type === 'setMode' && suggestion.mode) {
      labels.push(`modo ${suggestion.mode}`)
    } else if (suggestion.directories?.length) {
      labels.push(`${suggestion.type}(${suggestion.directories.join(', ')})`)
    }
  }
  return labels.length > 0 ? labels.join(' · ') : undefined
}

export { fallbackBashPermissionRule }
