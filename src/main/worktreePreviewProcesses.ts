import { execFile } from 'node:child_process'
import { win32, join } from 'node:path'

/** A proof contains only the allowlisted argv fields, never a raw command line
 * or the environment. Creation time + command hash bind it to one process. */
export interface WorktreePreviewProcess {
  pid: number
  creationTime: string
  executablePath: string
  commandHash: string
  argv: string[]
}

export interface WorktreePreviewProbe {
  processes: WorktreePreviewProcess[]
  failed: number
  skipped?: boolean
}

export interface WorktreePreviewStopResult {
  stopped: number
  failed: number
  skipped?: boolean
}

const OPERATION_TIMEOUT_MS = 15_000
const MAX_PROCESSES = 64
const ASTRO_ENTRY = 'node_modules\\astro\\bin\\astro.mjs'

function absoluteWindowsPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\u0000-\u001f]/u.test(value)) return undefined
  const path = value.replaceAll('/', '\\')
  if (path.startsWith('\\\\?\\') || path.startsWith('\\\\.\\')) return undefined
  if (!/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))/iu.test(path)) return undefined
  if (path.split('\\').some((part) => part === '.' || part === '..')) return undefined
  return win32.normalize(path).replace(/\\+$/u, '').toLowerCase()
}

function normalizedRoot(root: string): string | undefined {
  const value = absoluteWindowsPath(root)
  return value && !/^[a-z]:$/u.test(value) ? value : undefined
}

function allowedAstroFlags(args: string[]): boolean {
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    const equalAt = argument.indexOf('=')
    const flag = equalAt < 0 ? argument : argument.slice(0, equalAt)
    if ((flag !== '--host' && flag !== '--port') || seen.has(flag)) return false
    seen.add(flag)
    let value: string | undefined = equalAt < 0 ? undefined : argument.slice(equalAt + 1)
    if (value === undefined && args[index + 1] !== undefined && !args[index + 1].startsWith('--')) value = args[++index]
    if (flag === '--port') {
      if (!value || !/^\d{1,5}$/u.test(value) || Number(value) < 1 || Number(value) > 65535) return false
    } else if (value !== undefined && (!value || value.length > 253 || !/^[a-z0-9_.:[\]-]+$/iu.test(value))) {
      return false
    }
  }
  return true
}

/** argv is parsed by Windows itself in the isolated probe. Matching is by
 * executable/script/subcommand position, not a textual mention of the root. */
export function isWorktreePreviewProcess(root: string, value: unknown): value is WorktreePreviewProcess {
  if (!value || typeof value !== 'object') return false
  const process = value as Partial<WorktreePreviewProcess>
  const targetRoot = normalizedRoot(root)
  const executable = absoluteWindowsPath(process.executablePath)
  if (!targetRoot || !executable || win32.basename(executable) !== 'node.exe') return false
  if (!Number.isInteger(process.pid) || process.pid! <= 0 || process.pid! > 0xffffffff) return false
  if (typeof process.creationTime !== 'string' || !/^\d{1,20}$/u.test(process.creationTime)) return false
  if (typeof process.commandHash !== 'string' || !/^[a-f0-9]{64}$/u.test(process.commandHash)) return false
  const args = process.argv
  if (!Array.isArray(args) || args.length < 3 || args.length > 16 || !args.every((arg) => typeof arg === 'string')) return false
  const command = args[0].toLowerCase()
  if (command !== 'node' && command !== 'node.exe' && absoluteWindowsPath(args[0]) !== executable) return false
  if (absoluteWindowsPath(args[1]) !== `${targetRoot}\\${ASTRO_ENTRY}`) return false
  if (args[2] !== 'dev' && args[2] !== 'preview') return false
  return allowedAstroFlags(args.slice(3))
}

// This script is static. Root and proofs travel in a base64 JSON environment
// value; neither paths nor command lines are interpolated into shell code.
// Filtering happens before anything leaves PowerShell, so unrelated command
// lines (including arbitrary prose/credentials) never enter the main process.
const WINDOWS_PREVIEW_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SYNKORA_PREVIEW_REQUEST)) | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class SynkoraPreviewNative {
  [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder path, ref int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr handle, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  public static string[] Split(string command) {
    int count;
    IntPtr memory = CommandLineToArgvW(command, out count);
    if (memory == IntPtr.Zero) throw new Win32Exception();
    try {
      string[] args = new string[count];
      for (int i = 0; i < count; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
      return args;
    } finally { LocalFree(memory); }
  }
  public static string CreationTime(uint pid) {
    IntPtr handle = OpenProcess(0x1000, false, pid);
    if (handle == IntPtr.Zero) return null;
    try {
      long created, exited, kernel, user;
      return GetProcessTimes(handle, out created, out exited, out kernel, out user) ? created.ToString(System.Globalization.CultureInfo.InvariantCulture) : null;
    } finally { CloseHandle(handle); }
  }
  public static string Stop(uint pid, string creationTime, string executablePath, uint timeout) {
    // The immutable OS handle binds termination to the verified instance,
    // even if the PID is recycled after the final CIM lookup.
    IntPtr handle = OpenProcess(0x00100000 | 0x1000 | 0x0001, false, pid);
    if (handle == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87 ? "gone" : "failed";
    try {
      long created, exited, kernel, user;
      if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) return "failed";
      if (created.ToString(System.Globalization.CultureInfo.InvariantCulture) != creationTime) return "changed";
      int size = 32768;
      StringBuilder path = new StringBuilder(size);
      if (!QueryFullProcessImageName(handle, 0, path, ref size)) return "failed";
      if (!String.Equals(path.ToString().Replace('/', '\\'), executablePath.Replace('/', '\\'), StringComparison.OrdinalIgnoreCase)) return "changed";
      if (WaitForSingleObject(handle, 0) == 0) return "gone";
      if (!TerminateProcess(handle, 0)) return "failed";
      return WaitForSingleObject(handle, timeout) == 0 ? "stopped" : "failed";
    } finally { CloseHandle(handle); }
  }
}
'@
function Absolute-Path([string] $Value) {
  if ([string]::IsNullOrEmpty($Value) -or $Value.Length -gt 8192 -or $Value -match '[\x00-\x1f]') { return $null }
  $Value = $Value.Replace('/', '\')
  if ($Value.StartsWith('\\?\') -or $Value.StartsWith('\\.\')) { return $null }
  if ($Value -notmatch '^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))') { return $null }
  foreach ($part in $Value.Split('\')) { if ($part -eq '.' -or $part -eq '..') { return $null } }
  try { return [IO.Path]::GetFullPath($Value).TrimEnd('\').ToLowerInvariant() } catch { return $null }
}
function Allowed-Flags([string[]] $Values) {
  $seen = @{}
  for ($i = 0; $i -lt $Values.Length; $i++) {
    $parts = $Values[$i].Split([char[]]'=', 2)
    $flag = $parts[0]
    if (($flag -cne '--host' -and $flag -cne '--port') -or $seen.ContainsKey($flag)) { return $false }
    $seen[$flag] = $true
    $value = $null
    if ($parts.Length -eq 2) { $value = $parts[1] }
    elseif ($i + 1 -lt $Values.Length -and !$Values[$i + 1].StartsWith('--')) { $i++; $value = $Values[$i] }
    if ($flag -ceq '--port') {
      if (!$value -or $value -notmatch '^\d{1,5}$' -or [int]$value -lt 1 -or [int]$value -gt 65535) { return $false }
    } elseif ($null -ne $value -and (!$value -or $value.Length -gt 253 -or $value -notmatch '^[a-z0-9_.:\[\]-]+$')) { return $false }
  }
  return $true
}
function Read-Candidate($Item) {
  if ($Item.Name -ine 'node.exe' -or !$Item.CommandLine) { return $null }
  $executable = Absolute-Path $Item.ExecutablePath
  if (!$executable -or [IO.Path]::GetFileName($executable) -ine 'node.exe') { return $null }
  $argv = [SynkoraPreviewNative]::Split($Item.CommandLine)
  if ($argv.Length -lt 3 -or $argv.Length -gt 16) { return $null }
  if ($argv[0] -ine 'node' -and $argv[0] -ine 'node.exe' -and (Absolute-Path $argv[0]) -ine $executable) { return $null }
  if ((Absolute-Path $argv[1]) -ine ($targetRoot + '\node_modules\astro\bin\astro.mjs')) { return $null }
  if ($argv[2] -cne 'dev' -and $argv[2] -cne 'preview') { return $null }
  $flags = @()
  if ($argv.Length -gt 3) { $flags = $argv[3..($argv.Length - 1)] }
  if (!(Allowed-Flags $flags)) { return $null }
  $creation = [SynkoraPreviewNative]::CreationTime([uint32]$Item.ProcessId)
  if (!$creation) { return $null }
  # CIM and the native handle must describe the same instance. CIM dates have
  # microsecond precision; FILETIME may include one more decimal place.
  if ($Item.CreationDate -isnot [DateTime]) { return $null }
  $nativeTicks = [long]$creation
  $cimTicks = $Item.CreationDate.ToUniversalTime().ToFileTimeUtc()
  if (($nativeTicks - ($nativeTicks % 10)) -ne ($cimTicks - ($cimTicks % 10))) { return $null }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Item.CommandLine))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  return @{ pid = [int]$Item.ProcessId; creationTime = $creation; executablePath = $Item.ExecutablePath; commandHash = $hash; argv = @($argv) }
}
$targetRoot = Absolute-Path $request.root
$result = @{ stopped = 0; failed = 0; processes = @() }
try {
  if (!$targetRoot -or $targetRoot -match '^[a-z]:$') { throw 'invalid-root' }
  if ($request.mode -ceq 'probe') {
    $previewMatches = New-Object 'System.Collections.Generic.List[object]'
    foreach ($item in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)) {
      $candidate = Read-Candidate $item
      if ($null -ne $candidate) {
        if ($previewMatches.Count -ge 64) { $result.failed++; continue }
        $previewMatches.Add($candidate)
      }
    }
    $result.processes = @($previewMatches.ToArray())
  } elseif ($request.mode -ceq 'stop') {
    $deadline = [DateTime]::UtcNow.AddMilliseconds(6000)
    foreach ($proof in @($request.processes)) {
      if ([DateTime]::UtcNow -ge $deadline) { $result.failed++; continue }
      try {
        $processId = [uint32]$proof.pid
        $currentItem = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $processId) -ErrorAction Stop
        if ($null -eq $currentItem) { continue }
        $current = Read-Candidate $currentItem
        if ($null -eq $current -or $current.creationTime -cne $proof.creationTime -or $current.commandHash -cne $proof.commandHash -or (Absolute-Path $current.executablePath) -ine (Absolute-Path $proof.executablePath)) { $result.failed++; continue }
        $remaining = [Math]::Max(1, [Math]::Min(2000, ($deadline - [DateTime]::UtcNow).TotalMilliseconds))
        $status = [SynkoraPreviewNative]::Stop($processId, $proof.creationTime, $proof.executablePath, [uint32]$remaining)
        if ($status -ceq 'stopped') { $result.stopped++ }
        elseif ($status -cne 'gone') { $result.failed++ }
      } catch { $result.failed++ }
    }
  } else { throw 'invalid-mode' }
} catch { $result.failed++ }
$result | ConvertTo-Json -Depth 5 -Compress
`

interface ScriptResult {
  stopped: number
  failed: number
  processes: unknown[]
}

function runWindowsProbe(request: { mode: 'probe' | 'stop'; root: string; processes?: WorktreePreviewProcess[] }, timeout: number): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const failed = { stopped: 0, failed: 1, processes: [] }
    if (timeout <= 0) { resolve(failed); return }
    const payload = Buffer.from(JSON.stringify(request), 'utf8').toString('base64')
    // One Windows environment value is bounded too. Oversized proofs fail
    // closed instead of throwing or truncating a root/process identity.
    if (payload.length > 24_000) { resolve(failed); return }
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'
    const shell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    try { execFile(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WINDOWS_PREVIEW_SCRIPT, 'utf16le').toString('base64')], {
      windowsHide: true,
      timeout,
      maxBuffer: 256 * 1024,
      encoding: 'utf8',
      env: { SystemRoot: systemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, SYNKORA_PREVIEW_REQUEST: payload }
    }, (error, stdout) => {
      // Exceptions/stderr may carry command lines or arbitrary environment
      // data. Only bounded aggregate counts cross this boundary.
      if (error) { resolve(failed); return }
      try {
        const value = JSON.parse(stdout.trim()) as Partial<ScriptResult>
        if (!Number.isInteger(value.stopped) || value.stopped! < 0 || value.stopped! > MAX_PROCESSES ||
            !Number.isInteger(value.failed) || value.failed! < 0 || !Array.isArray(value.processes)) {
          resolve(failed)
          return
        }
        resolve({ stopped: value.stopped!, failed: value.failed!, processes: value.processes })
      } catch { resolve(failed) }
    }) } catch { resolve(failed) }
  })
}

async function probe(root: string, timeout: number): Promise<WorktreePreviewProbe> {
  if (process.platform !== 'win32') return { processes: [], failed: 0, skipped: true }
  if (!normalizedRoot(root)) return { processes: [], failed: 1 }
  const result = await runWindowsProbe({ mode: 'probe', root }, timeout)
  const processes = result.processes.filter((value): value is WorktreePreviewProcess => isWorktreePreviewProcess(root, value))
  return { processes, failed: result.failed + result.processes.length - processes.length }
}

/** Read-only: useful for scoped repair evidence; no unrelated process data. */
export function probeWorktreePreviewProcesses(root: string): Promise<WorktreePreviewProbe> {
  return probe(root, OPERATION_TIMEOUT_MS)
}

async function stopProbed(root: string, processes: WorktreePreviewProcess[], timeout: number): Promise<WorktreePreviewStopResult> {
  if (process.platform !== 'win32') return { stopped: 0, failed: 0, skipped: true }
  if (!normalizedRoot(root)) return { stopped: 0, failed: 1 }
  if (processes.length > MAX_PROCESSES || processes.some((value) => !isWorktreePreviewProcess(root, value))) return { stopped: 0, failed: Math.max(1, processes.length) }
  if (!processes.length) return { stopped: 0, failed: 0 }
  const result = await runWindowsProbe({ mode: 'stop', root, processes }, timeout)
  return { stopped: result.stopped, failed: result.failed }
}

/** Revalidates a prior proof and stops only that process instance. A changed
 * command/start time fails closed; terminating a recycled PID is forbidden. */
export function stopProbedWorktreePreviewProcesses(root: string, processes: WorktreePreviewProcess[]): Promise<WorktreePreviewStopResult> {
  return stopProbed(root, processes, OPERATION_TIMEOUT_MS)
}

export async function stopWorktreePreviewProcesses(root: string): Promise<WorktreePreviewStopResult> {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS
  const proof = await probe(root, OPERATION_TIMEOUT_MS)
  if (proof.skipped) return { stopped: 0, failed: 0, skipped: true }
  if (proof.failed) return { stopped: 0, failed: proof.failed }
  return stopProbed(root, proof.processes, deadline - Date.now())
}
