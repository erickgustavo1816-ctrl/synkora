import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const MAX_PROMPT_INPUT_BYTES = 16 * 1024 * 1024

export function isMethodGovernedPaneRole(role: string | undefined): boolean {
  return ['maestro', 'dev', 'review', 'qa', 'ajudante'].includes(role ?? '')
}

export function codexSkillIsolationProfileName(paneGenerationId: string): string {
  const safe = paneGenerationId.replace(/[^A-Za-z0-9_-]/g, '')
  if (!safe) throw new Error('invalid pane generation id for Codex skill isolation')
  // Preserve entropy at the END. Long deterministic pane ids used to consume
  // the whole 80-char prefix and silently truncate the generation UUID.
  const prefix = safe.slice(0, 44)
  const generationHash = createHash('sha256')
    .update(paneGenerationId, 'utf8')
    .digest('hex')
    .slice(0, 20)
  return `synkora-skills-${prefix}-${generationHash}`
}

export function codexSkillPathsFromPromptInput(output: string): string[] {
  const paths = new Set<string>()
  // `debug prompt-input` normally emits forward slashes on Windows, while a
  // JSON wrapper may escape backslashes. Normalize both representations.
  const normalized = output.replace(/\\\\/g, '/')
  const pattern =
    /(?:\(file:\s*|["']?path["']?\s*[:=]\s*["']?)((?:[A-Za-z]:\/|\/)[^"'\r\n)]*?SKILL\.md)/gi
  for (const match of normalized.matchAll(pattern)) {
    const candidate = match[1].replace(/\\/g, '/')
    if (!isAbsolute(candidate)) continue
    paths.add(resolve(candidate).replace(/\\/g, '/'))
  }
  return [...paths].sort((left, right) => left.localeCompare(right, 'en'))
}

export function renderCodexSkillIsolationProfile(paths: readonly string[]): string {
  const unique = [...new Set(paths.map((path) => resolve(path).replace(/\\/g, '/')))].sort(
    (left, right) => left.localeCompare(right, 'en')
  )
  return [
    '# Synkora runtime profile. Generated per pane; never edit by hand.',
    ...unique.flatMap((path) => [
      '',
      '[[skills.config]]',
      `path = ${JSON.stringify(path)}`,
      'enabled = false'
    ]),
    ''
  ].join('\n')
}

export type CodexPromptInputProbe = (
  cwd: string,
  configDir: string,
  profileName?: string,
  mcpDisableArgs?: readonly string[]
) => Promise<string>

const SAFE_CATALOG_FLAGS = [
  '--disable',
  'multi_agent',
  '--disable',
  'apps',
  '--disable',
  'plugins',
  '--disable',
  'remote_plugin',
  '--disable',
  'hooks'
] as const

function execCodex(
  args: readonly string[],
  cwd: string,
  configDir: string
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      'codex',
      [...args],
      {
        cwd,
        env: { ...process.env, CODEX_HOME: configDir },
        windowsHide: true,
        maxBuffer: MAX_PROMPT_INPUT_BYTES,
        encoding: 'utf8'
      },
      (error, stdout) => {
        if (error) reject(error)
        else resolveOutput(stdout)
      }
    )
  })
}

export async function discoverCodexMcpDisableArgs(
  cwd: string,
  configDir: string
): Promise<string[]> {
  // `mcp list` reads the effective layered configuration but does not connect
  // to the servers. This includes user, managed and trusted project config.
  const output = await execCodex([...SAFE_CATALOG_FLAGS, 'mcp', 'list', '--json'], cwd, configDir)
  const start = output.indexOf('[')
  const end = output.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error('Codex MCP catalog was not valid JSON')
  const parsed = JSON.parse(output.slice(start, end + 1)) as unknown
  if (!Array.isArray(parsed)) throw new Error('Codex MCP catalog was not an array')
  const names = parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof (entry as { name?: unknown }).name !== 'string') {
      throw new Error('Codex MCP catalog contained an unreadable entry')
    }
    return (entry as { name: string }).name
  })
  return [...new Set(names)]
    .sort((left, right) => left.localeCompare(right, 'en'))
    .flatMap((name) => {
      const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)
      return ['-c', `mcp_servers.${key}.enabled=false`]
    })
}

function probeCodexPromptInput(
  cwd: string,
  configDir: string,
  profileName?: string,
  mcpDisableArgs: readonly string[] = []
): Promise<string> {
  return execCodex(
    [
      ...SAFE_CATALOG_FLAGS,
      ...mcpDisableArgs,
      ...(profileName ? ['-p', profileName] : []),
      'debug',
      'prompt-input',
      'synkora skill isolation probe'
    ],
    cwd,
    configDir
  )
}

export async function prepareCodexSkillIsolationProfile(input: {
  paneGenerationId: string
  cwd: string
  configDir: string
  probe?: CodexPromptInputProbe
  mcpDisableArgs?: readonly string[]
}): Promise<{ profileName: string; profilePath: string; disabledPaths: string[] }> {
  const profileName = codexSkillIsolationProfileName(input.paneGenerationId)
  const probe = input.probe ?? probeCodexPromptInput
  const mcpDisableArgs =
    input.mcpDisableArgs ?? (await discoverCodexMcpDisableArgs(input.cwd, input.configDir))
  const output = await probe(input.cwd, input.configDir, undefined, mcpDisableArgs)
  const disabledPaths = codexSkillPathsFromPromptInput(output)
  if (/Available skills/i.test(output) && disabledPaths.length === 0) {
    throw new Error('Codex advertised skills but their paths could not be enumerated')
  }

  const profilePath = join(input.configDir, `${profileName}.config.toml`)
  const temporaryPath = `${profilePath}.${process.pid}.${randomUUID()}.tmp`
  mkdirSync(input.configDir, { recursive: true })
  try {
    writeFileSync(temporaryPath, renderCodexSkillIsolationProfile(disabledPaths), {
      encoding: 'utf8',
      flag: 'wx'
    })
    rmSync(profilePath, { force: true })
    renameSync(temporaryPath, profilePath)

    // Do not trust a flag or a generated file. Ask the exact installed Codex
    // binary for the effective prompt and fail closed if any catalog remains.
    const verifiedOutput = await probe(input.cwd, input.configDir, profileName, mcpDisableArgs)
    const remainingPaths = codexSkillPathsFromPromptInput(verifiedOutput)
    if (/Available skills/i.test(verifiedOutput) || remainingPaths.length > 0) {
      throw new Error(
        `Codex skill catalog remained visible after isolation (${remainingPaths.length} paths: ${remainingPaths.slice(0, 3).join(', ') || 'unparsed'})`
      )
    }
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true })
      rmSync(profilePath, { force: true })
    } catch {
      // Nothing left to clean.
    }
    throw error
  }
  return { profileName, profilePath, disabledPaths }
}

export function removeCodexSkillIsolationProfile(profilePath: string | undefined): void {
  if (!profilePath || !existsSync(profilePath)) return
  try {
    rmSync(profilePath, { force: true })
  } catch {
    // Cleanup is best-effort; each preparation uses a fresh generation id.
  }
}
