import { execFileSync } from 'child_process'
import { freshMacPath, resetMacPathCache } from './macPath'

// No Windows, processos herdam o PATH de quando o pai nasceu. Se o usuário
// instala um CLI (ex.: Codex) com o app aberto, o novo diretório só existe no
// registro — não no env herdado. Aqui lemos o PATH atual do registro e
// mesclamos com o herdado, para que os PTYs sempre enxerguem CLIs recém-instalados.

function regQueryPath(hive: string, key: string): string {
  try {
    const out = execFileSync('reg', ['query', `${hive}\\${key}`, '/v', 'Path'], {
      encoding: 'utf-8'
    })
    const match = out.match(/Path\s+REG(?:_EXPAND)?_SZ\s+(.+)/)
    return match?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

function expandEnvVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (all, name: string) => process.env[name] ?? all)
}

let cached: string | null = null

export function freshWindowsPath(): string {
  if (process.platform === 'darwin') return freshMacPath()
  if (process.platform !== 'win32') return process.env['PATH'] ?? ''
  if (cached) return cached

  const machine = regQueryPath(
    'HKLM',
    'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
  )
  const user = regQueryPath('HKCU', 'Environment')
  const inherited = process.env['PATH'] ?? ''

  const seen = new Set<string>()
  const merged: string[] = []
  for (const raw of `${inherited};${expandEnvVars(machine)};${expandEnvVars(user)}`.split(';')) {
    const entry = raw.trim()
    const key = entry.toLowerCase()
    if (entry && !seen.has(key)) {
      seen.add(key)
      merged.push(entry)
    }
  }

  cached = merged.join(';')
  return cached
}

/** Invalida o cache (ex.: usuário clicou em "recarregar PATH"). */
export function resetPathCache(): void {
  cached = null
  resetMacPathCache()
}
