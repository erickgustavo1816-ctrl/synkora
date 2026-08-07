export type PanePermissionCli = 'claude' | 'codex'
export type PaneAccessProfile = 'write' | 'review-read-only' | 'qa-read-only'

export interface PanePermissionContext {
  /**
   * Sensitive work never inherits the project's automatic writer bypass or
   * external tools. The user can still approve an exact CLI request
   * interactively. Read-only gates use the native read-only sandbox; their
   * audited Synkora MCP tools are allowlisted separately.
   */
  sensitive?: boolean
}

export const SYNKORA_READ_ONLY_GATE_TOOLS = [
  'report',
  // check_messages (CHECK 15, 2026-08-07): drena o correio MCP do pane —
  // leitura do próprio estado no harness, nunca do produto.
  'check_messages',
  // runtime_control (2026-08-06, "capacidade antes de escalação"): o QA
  // comanda o runtime que o HARNESS possui (start/stop/retry/porta) — nenhuma
  // escrita no produto; a cerca segue fingerprint + catálogo.
  'runtime_control',
  // status_note (2026-08-06): frase viva para o radar do dono — escreve só no
  // estado do harness, nunca no produto; gates também narram o que fazem.
  'status_note',
  'code_diagnostics',
  'code_definition',
  'code_references',
  'code_hover',
  'code_symbols',
  'code_implementations',
  'code_call_hierarchy'
] as const

/**
 * Codex keeps MCP approval separate from shell approval. Gates therefore run
 * with shell escalation disabled while only this small, read-only Synkora
 * catalog is approved automatically. The server is required so a gate cannot
 * silently start without its report channel.
 */
export function codexGateMcpPolicyArgs(): string[] {
  return [
    '-c',
    `mcp_servers.synkora.enabled_tools=${JSON.stringify(SYNKORA_READ_ONLY_GATE_TOOLS)}`,
    '-c',
    'mcp_servers.synkora.default_tools_approval_mode="approve"',
    '-c',
    'mcp_servers.synkora.required=true'
  ]
}

export function paneAccessProfile(role: string | undefined): PaneAccessProfile {
  if (role === 'review') return 'review-read-only'
  if (role === 'qa') return 'qa-read-only'
  return 'write'
}

export function paneExternalMcpCapabilities(profile: PaneAccessProfile): {
  browser: boolean
  testRunner: boolean
} {
  return {
    // DECISÃO DO USUÁRIO (validação ao vivo, 02/08/2026): "QA é sempre para
    // usar um chrome SÓ DELE" — o QA valida FUNCIONANDO e recebe o Playwright
    // isolado do app (nunca a integração Claude in Chrome com o navegador
    // pessoal). O REVIEW continua CODE ONLY: sem browser, sem runner. A cerca
    // de escrita dos gates segue no backend (fingerprint antes/depois
    // invalida o veredito).
    browser: profile === 'write' || profile === 'qa-read-only',
    testRunner: profile === 'write' || profile === 'qa-read-only'
  }
}

/** Desliga servidores MCP persistidos no CODEX_HOME do seat. O Synkora é
 * recolocado explicitamente pela linha de comando depois destes overrides. */
export function codexGateMcpDisableArgs(configToml: string): string[] {
  const servers = new Map<string, string>()
  const parseKey = (value: string): { name: string; raw: string } | undefined => {
    const source = value.trimStart()
    if (source.startsWith('"')) {
      let escaped = false
      for (let index = 1; index < source.length; index++) {
        const char = source[index]
        if (char === '"' && !escaped) {
          const raw = source.slice(0, index + 1)
          try {
            return { name: JSON.parse(raw), raw }
          } catch {
            return undefined
          }
        }
        escaped = char === '\\' && !escaped
        if (char !== '\\') escaped = false
      }
      return undefined
    }
    if (source.startsWith("'")) {
      const end = source.indexOf("'", 1)
      if (end < 0) return undefined
      return { name: source.slice(1, end), raw: source.slice(0, end + 1) }
    }
    const bare = source.match(/^([A-Za-z0-9_-]+)/)
    return bare ? { name: bare[1], raw: bare[1] } : undefined
  }

  for (const line of configToml.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (/^\[\s*mcp_servers\s*\]/.test(trimmed) || /^mcp_servers\s*=/.test(trimmed)) {
      throw new Error(
        'tabela MCP herdada usa formato inline não enumerável; gate Codex bloqueado'
      )
    }
    let body: string | undefined
    if (/^\[\s*mcp_servers\./.test(trimmed)) {
      body = trimmed.replace(/^\[\s*mcp_servers\./, '')
    } else if (/^mcp_servers\./.test(trimmed)) {
      body = trimmed.slice('mcp_servers.'.length)
    }
    if (body === undefined) continue
    const key = parseKey(body)
    if (!key) {
      throw new Error('configuração MCP herdada ilegível; gate Codex bloqueado')
    }
    if (key.name !== 'synkora') servers.set(key.name, key.raw)
  }

  return [...servers.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .flatMap(([, raw]) => ['-c', `mcp_servers.${raw}.enabled=false`])
}

/**
 * Permissões do processo, separadas do prompt.
 *
 * O shell dos gates Codex permanece disponível para leitura, porém dentro do
 * sandbox read-only e sem escalada. O MCP interno usa a configuração nativa de
 * approval por servidor: só as ferramentas auditadas acima são expostas e
 * aprovadas automaticamente.
 * - claude em plan mode bloqueia tool calls não-read-only, INCLUINDO o
 *   mcp__synkora__report (afirmado pelo próprio CLI na sonda). Sem plan mode,
 *   com o catálogo restrito a Read/Grep/Glob/Skill + allowlist MCP, o report
 *   completou.
 *
 * O fingerprint antes/depois permanece como segunda camada e invalida o
 * veredito se a árvore mudar. Claude continua sem ferramentas de escrita no
 * catálogo dos gates.
 */
export function panePermissionArgs(
  cli: PanePermissionCli,
  bypass: boolean,
  profile: PaneAccessProfile = 'write',
  context: PanePermissionContext = {}
): string[] {
  if (profile !== 'write') {
    if (cli === 'codex') {
      // O sandbox read-only do codex lê o disco inteiro sem prompt — gates
      // codex nunca param em permissão de leitura; nada a fazer com o bypass.
      return [
        '--sandbox',
        'read-only',
        '--ask-for-approval',
        'never',
        '--disable',
        'multi_agent',
        '--disable',
        'apps',
        '--disable',
        'browser_use',
        '--disable',
        'browser_use_external',
        '--disable',
        'browser_use_full_cdp_access',
        '--disable',
        'in_app_browser',
        '--disable',
        'computer_use',
        '--disable',
        'image_generation',
        '--disable',
        'plugins',
        '--disable',
        'remote_plugin',
        '--disable',
        'hooks'
      ]
    }
    const allowedTools = [
      'mcp__synkora__report',
      // correio MCP (CHECK 15): drenagem explícita da caixa do pane.
      'mcp__synkora__check_messages',
      // Leitura de coordenação: o QA consulta o board antes de validar (caso
      // real 2026-08-04: gate parado num prompt de permissão para
      // board_status — "era para estar em bypass"). Ambas são read-only.
      'mcp__synkora__board_status',
      'mcp__synkora__list_skills',
      'mcp__synkora__code_diagnostics',
      'mcp__synkora__code_definition',
      'mcp__synkora__code_references',
      'mcp__synkora__code_hover',
      'mcp__synkora__code_symbols',
      'mcp__synkora__code_implementations',
      'mcp__synkora__code_call_hierarchy',
      // QA navega no Chrome PRÓPRIO (Playwright MCP isolado) sem prompts de
      // permissão; o review não recebe esses servidores (CODE ONLY).
      // runtime_control: agência do QA sobre o runtime do harness (retry/
      // porta) — "o que uma pessoa normal faria", sem escalar.
      ...(profile === 'qa-read-only' && context.sensitive !== true
        ? ['mcp__playwright', 'mcp__playwright-test', 'mcp__synkora__runtime_control']
        : [])
    ]
    return [
      // Sem settings user/project/local: hooks e plugins herdados nao rodam.
      // O login do seat continua no CLAUDE_CONFIG_DIR e o MCP Synkora entra
      // explicitamente por --mcp-config/--strict-mcp-config.
      '--setting-sources=',
      // Sem settings, a preferência salva do Chrome não é lida e o CLI abre o
      // diálogo "Claude in Chrome extension detected" — gate nascia PARADO
      // num prompt (validação ao vivo, 02/08). Gate read-only nunca usa o
      // navegador do usuário: desliga a integração na flag.
      '--no-chrome',
      // SEM plan mode (ele bloqueia o report — sonda 5). A cerca de escrita é
      // o catálogo: nenhuma ferramenta de mutação existe na sessão.
      '--tools',
      'Read,Grep,Glob,Skill',
      '--allowedTools',
      allowedTools.join(','),
      // BYPASS LIGADO VALE SEMPRE — também nos GATES (caso real 2026-08-06:
      // o reviewer parou em "Do you want to proceed?" ao ler o DESIGN.md do
      // PROJETO — .synkora é git-invisível, o arquivo não existe no worktree
      // e leitura fora do cwd prompta; a F6.8c só tinha coberto o perfil
      // write). Com o catálogo acima sem NENHUMA ferramenta de mutação, o
      // bypass só silencia prompts de LEITURA — a cerca real segue sendo
      // catálogo + fingerprint antes/depois + ACL MCP.
      ...(bypass ? ['--permission-mode', 'bypassPermissions'] : [])
    ]
  }
  // BYPASS LIGADO VALE SEMPRE (decisão do usuário, 2026-08-05: "independente
  // do risco, high ou low, o bypass tem que funcionar" — caso real E2E: plano
  // risk HIGH suprimiu o bypass SILENCIOSAMENTE e o dev travou em "Do you
  // want to create percent.mjs?" sem aviso nenhum). Com o toggle ⏩ do projeto
  // ligado, pane sensível roda com bypass como qualquer outro — a cerca real
  // dos sensíveis continua a que sempre valeu: fingerprint, review+QA, ACL
  // MCP e a cerca .synkora. O ramo restritivo abaixo só existe para projeto
  // com bypass DESLIGADO (modo estrito de verdade).
  if (context.sensitive === true && !bypass) {
    if (cli === 'claude') {
      return [
        '--setting-sources=',
        '--no-chrome',
        '--permission-mode',
        'manual'
      ]
    }
    return [
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'untrusted',
      '--disable',
      'multi_agent',
      '--disable',
      'apps',
      '--disable',
      'browser_use',
      '--disable',
      'browser_use_external',
      '--disable',
      'browser_use_full_cdp_access',
      '--disable',
      'in_app_browser',
      '--disable',
      'computer_use',
      '--disable',
      'image_generation',
      '--disable',
      'plugins',
      '--disable',
      'remote_plugin',
      '--disable',
      'hooks'
    ]
  }
  const effectiveBypass = bypass
  if (cli === 'claude') {
    return ['--permission-mode', effectiveBypass ? 'bypassPermissions' : 'acceptEdits']
  }
  return effectiveBypass ? ['--dangerously-bypass-approvals-and-sandbox'] : []
}
