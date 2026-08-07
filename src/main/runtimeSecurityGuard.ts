/**
 * Runtime guardrails for terminal boundaries.
 *
 * This module is deliberately pure: it never executes a command and never
 * receives repository contents. It classifies the submitted shell line only,
 * so the PTY boundary can fail closed for known credential paths and leave a
 * small, content-free audit decision for sensitive effects.
 */

export type RuntimeSecurityCategory =
  | 'secret-path'
  | 'destructive-effect'
  | 'external-effect'

export type RuntimeSecurityDecision =
  | {
      action: 'allow'
    }
  | {
      action: 'block'
      category: RuntimeSecurityCategory
      reason: string
      commandName: string
    }
  | {
      action: 'human-authorized'
      category: Exclude<RuntimeSecurityCategory, 'secret-path'>
      reason: string
      commandName: string
    }

const SAFE_ENV_TEMPLATE_RE = /^\.env\.(?:example|sample|template|defaults?)$/i

const PROTECTED_PATH_PATTERNS: readonly RegExp[] = [
  // Real dotenv variants. Templates are excluded separately below.
  /(?:^|[\s"'`=:@\\/])\.env[A-Za-z0-9_.*?-]*(?:$|[\s"'`,;|&])/i,
  /(?:^|[\s"'`=:@\\/])(?:\.npmrc|\.pypirc|\.netrc)(?:$|[\s"'`,;|&])/i,
  /(?:^|[\s"'`=:@\\/])\.(?:aws|ssh|azure|docker|kube|gnupg)(?:[\\/]|$|[\s"'`,;|&])/i,
  /[\\/]\.config[\\/](?:gcloud|gh)[\\/]/i,
  /(?:^|[\s"'`=:@\\/])\.git-credentials(?:$|[\s"'`,;|&])/i,
  /(?:^|[\s"'`=:@\\/])(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:$|[.\s"'`,;|&])/i,
  /(?:^|[\s"'`=:@\\/])[^\\/\s"'`,;|&]+\.(?:pem|key|p12|pfx|jks|keystore)(?:$|[\s"'`,;|&])/i,
  /(?:^|[\s"'`=:@\\/])[^\\/\s"'`,;|&]*(?:credentials?|client[-_. ]?secret|service[-_. ]?account|auth[-_. ]?config)[^\\/\s"'`,;|&]*\.(?:json|ya?ml|toml|ini|conf|txt)(?:$|[\s"'`,;|&])/i,
  /[\\/](?:credentials?|service[-_. ]?account|auth[-_. ]?config)(?:$|[\s"'`,;|&])/i,
  /(?:^|[\s"'`=:@\\/])(?:secrets?|vault)\.(?:json|ya?ml|toml|ini|conf|txt)(?:$|[\s"'`,;|&])/i,
  /[\\/](?:secrets?|vault)(?:$|[\s"'`,;|&])/i,
  /(?:^|[\s"'`=:@\\/])(?:backups?|dumps?)(?:[\\/]|$|[\s"'`,;|&])/i,
  /(?:^|[\s"'`=:@\\/])[^\\/\s"'`,;|&]*(?:backup|dump)[^\\/\s"'`,;|&]*\.(?:sql|dump|bak|backup|tar|tgz|zip|7z|gz)(?:$|[\s"'`,;|&])/i,
  /(?:^|[\s"'`=:@\\/])(?:database|db)[-_. ]?(?:backup|dump)\.(?:sql|dump|bak|backup|gz)(?:$|[\s"'`,;|&])/i
]

const METADATA_ONLY_COMMAND_RE =
  /^\s*(?:(?:git\s+(?:status|check-ignore)\b)|(?:test-path|get-item|stat|ls|dir)\b)/i

function isMetadataOnlyCommand(command: string): boolean {
  return (
    METADATA_ONLY_COMMAND_RE.test(command) &&
    !/[;&|<>`\r\n]/.test(command) &&
    !/\$\s*\(/.test(command)
  )
}

const DESTRUCTIVE_EFFECT_PATTERNS: readonly RegExp[] = [
  /(?:^|[;&|]\s*)(?:rm\s+(?:-[^\s]*[rf][^\s]*\s+|--recursive\b)|remove-item\b[^\r\n]*(?:-recurse|-force)|del\s+\/s\b|rmdir\s+\/s\b)/i,
  /\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*f|push\b[^\r\n]*--force)\b/i,
  /\b(?:drop\s+(?:database|schema|table)|truncate\s+table|delete\s+from)\b/i,
  /\b(?:terraform\s+destroy|kubectl\s+delete|helm\s+uninstall)\b/i,
  /\b(?:refund|chargeback|rotate[-_ ]?secret|delete[-_ ]?(?:account|tenant|customer))\b/i
]

const EXTERNAL_EFFECT_PATTERNS: readonly RegExp[] = [
  /(?:^|[;&|]\s*)(?:curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|ssh|scp|sftp|rsync)\b/i,
  /\bgit\s+push\b/i,
  /\b(?:npm|pnpm|yarn)\s+(?:publish|deploy)\b/i,
  /\b(?:docker\s+push|gh\s+pr\s+create|vercel\s+(?:deploy|--prod)|netlify\s+deploy|firebase\s+deploy)\b/i,
  /\b(?:aws|gcloud|az)\s+[^\r\n]*(?:deploy|publish|delete|remove|update|create|put|apply)\b/i
]

function normalizedCommandName(command: string): string {
  const first = command
    .trim()
    .replace(/^(?:&\s*)/, '')
    .match(/^(?:["']([^"']+)["']|([^\s;&|]+))/)
  const raw = first?.[1] ?? first?.[2] ?? 'comando'
  const leaf = raw.split(/[\\/]/).at(-1) ?? raw
  return leaf.replace(/\.(?:exe|cmd|bat|ps1)$/i, '').slice(0, 48).toLowerCase()
}

function protectedPathMatch(command: string): RegExpMatchArray | undefined {
  const source = command.replace(/[()[\]{}]/g, ' ')
  for (const pattern of PROTECTED_PATH_PATTERNS) {
    let offset = 0
    while (offset < source.length) {
      const match = source.slice(offset).match(pattern)
      if (!match) break
      const token = match[0]
        .trim()
        .replace(/^[\\/"'`=:@]+/, '')
        .replace(/["'`,;|&]$/, '')
      if (!SAFE_ENV_TEMPLATE_RE.test(token.split(/[\\/]/).at(-1) ?? token)) return match
      offset += (match.index ?? 0) + Math.max(1, match[0].length)
    }
  }
  return undefined
}

/** Returns only a boolean; callers must never log the matching path. */
export function referencesProtectedSecretPath(command: string): boolean {
  return Boolean(protectedPathMatch(command))
}

/**
 * A line typed by a person is itself the exact, contemporaneous authorization
 * for a destructive/external shell effect. We therefore allow it but emit a
 * content-free audit decision. Automated injection uses `humanInput=false` and
 * is refused until a person submits the exact command themselves.
 */
export function inspectShellSubmission(
  command: string,
  options: { humanInput: boolean }
): RuntimeSecurityDecision {
  const trimmed = command.trim()
  if (!trimmed) return { action: 'allow' }
  const commandName = normalizedCommandName(trimmed)

  if (referencesProtectedSecretPath(trimmed) && !isMetadataOnlyCommand(trimmed)) {
    return {
      action: 'block',
      category: 'secret-path',
      commandName,
      reason:
        'leitura ou manipulação de arquivo de credencial bloqueada; use somente metadados ou um fluxo dedicado com saída mascarada'
    }
  }

  const sensitiveEffect = DESTRUCTIVE_EFFECT_PATTERNS.some((pattern) => pattern.test(trimmed))
    ? ('destructive-effect' as const)
    : EXTERNAL_EFFECT_PATTERNS.some((pattern) => pattern.test(trimmed))
      ? ('external-effect' as const)
      : undefined
  if (!sensitiveEffect) return { action: 'allow' }

  const reason =
    sensitiveEffect === 'destructive-effect'
      ? 'ação destrutiva ou irreversível exige submissão humana explícita do comando exato'
      : 'ação com efeito externo exige submissão humana explícita do comando exato'
  return options.humanInput
    ? { action: 'human-authorized', category: sensitiveEffect, commandName, reason }
    : { action: 'block', category: sensitiveEffect, commandName, reason }
}
