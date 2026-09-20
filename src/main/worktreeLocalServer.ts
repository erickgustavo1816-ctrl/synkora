import { win32 } from 'node:path'

/** Custom Node previews are identified by their workspace and loopback
 * listener, not a guessed framework or filename. No eval, external script,
 * background job without a listener, or public listener qualifies. */
export function isLocalServerCommand(root: string, argv: string[], ports: unknown): boolean {
  if (argv.length !== 2 || !argv[1] || /[\u0000-\u001f]/u.test(argv[1]) || argv[1].startsWith('-') ||
    argv[1].startsWith('\\\\?\\') || argv[1].startsWith('\\\\.\\')) return false
  const script = win32.resolve(root, argv[1]).toLowerCase()
  const prefix = win32.resolve(root).toLowerCase().replace(/\\+$/u, '') + '\\'
  return script.startsWith(prefix) && /\.(?:mjs|cjs|js)$/iu.test(script) && Array.isArray(ports) &&
    ports.length > 0 && ports.length <= 16 && new Set(ports).size === ports.length &&
    ports.every(port => Number.isInteger(port) && port >= 1024 && port <= 65535)
}

/** Static, application-owned code. Commands and unrelated listeners never
 * leave the probe. The stop invocation builds a fresh listener snapshot. */
export const LOCAL_SERVER_PROBE_SCRIPT = String.raw`
$script:localServerListeners = $null
function Is-LocalServerCommand([string[]] $Argv) {
  if ($Argv.Length -lt 2) { return $false }
  $scriptPath = $Argv[1].Replace('/', '\')
  if (!$scriptPath -or $scriptPath.StartsWith('-') -or $scriptPath -match '[\x00-\x1f]' -or $scriptPath.StartsWith('\\?\') -or $scriptPath.StartsWith('\\.\')) { return $false }
  try {
    if (![IO.Path]::IsPathRooted($scriptPath)) { $scriptPath = [IO.Path]::Combine($targetRoot, $scriptPath) }
    $scriptPath = Absolute-Path ([IO.Path]::GetFullPath($scriptPath))
  } catch { return $false }
  return $scriptPath -and $scriptPath.StartsWith($targetRoot + '\', [StringComparison]::OrdinalIgnoreCase) -and $scriptPath -match '\.(mjs|cjs|js)$'
}
function Local-ServerPorts([uint32] $ProcessId) {
  if ($null -eq $script:localServerListeners) {
    try { $script:localServerListeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Select-Object OwningProcess, LocalAddress, LocalPort) }
    catch { $script:localServerListeners = @(); return @() }
  }
  $listeners = @($script:localServerListeners | Where-Object { $_.OwningProcess -eq $ProcessId })
  if ($listeners.Count -eq 0 -or $listeners.Count -gt 16) { return @() }
  foreach ($listener in $listeners) {
    if (@('127.0.0.1', '::1') -notcontains $listener.LocalAddress -or $listener.LocalPort -lt 1024 -or $listener.LocalPort -gt 65535) { return @() }
  }
  return @($listeners | ForEach-Object { [int]$_.LocalPort } | Sort-Object -Unique)
}
`
