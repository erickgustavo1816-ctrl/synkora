import { spawn } from 'child_process'
import { randomUUID } from 'crypto'

const TARGET_TTL_MS = 6 * 60 * 1000
const MAX_TEXT_UNITS = 20_000
const MAX_TRACKED_TARGETS = 64
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024
const CAPTURE_TIMEOUT_MS = 8_000
const COMMIT_TIMEOUT_MS = 12_000
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const activePowerShellChildren = new Set<ReturnType<typeof spawn>>()

interface CapturedTarget {
  ownerId: number
  hwnd: string
  pid: number
  tid: number
  hwndFocus: string
  capturedAt: number
  expiresAt: number
}

type PowerShellResult =
  | { kind: 'completed'; stdout: string }
  | { kind: 'unavailable' }
  | { kind: 'uncertain' }

interface CaptureResponse {
  ok: true
  hwnd: string
  pid: number
  tid: number
  hwndFocus: string
}

interface CommitResponse {
  status: 'inserted' | 'unavailable' | 'uncertain'
}

const CAPTURE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Write-Unavailable {
  [Console]::Out.Write('{"ok":false}')
  exit 0
}

try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class SynVoiceCaptureNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int left;
        public int top;
        public int right;
        public int bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO
    {
        public uint cbSize;
        public uint flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public RECT rcCaret;
    }

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);
}
'@

  $raw = [Console]::In.ReadToEnd()
  if ([String]::IsNullOrWhiteSpace($raw)) { Write-Unavailable }
  $request = $raw | ConvertFrom-Json

  [uint64]$ownPidWide = [uint64]$request.ownPid
  if ($ownPidWide -eq 0 -or $ownPidWide -gt [uint32]::MaxValue) { Write-Unavailable }
  [uint32]$ownPid = [uint32]$ownPidWide

  [IntPtr]$foreground = [SynVoiceCaptureNative]::GetForegroundWindow()
  if ($foreground -eq [IntPtr]::Zero) { Write-Unavailable }

  [uint32]$targetPid = 0
  [uint32]$targetTid = [SynVoiceCaptureNative]::GetWindowThreadProcessId(
    $foreground,
    [ref]$targetPid
  )
  if ($targetPid -eq 0 -or $targetTid -eq 0 -or $targetPid -eq $ownPid) {
    Write-Unavailable
  }

  $gui = New-Object SynVoiceCaptureNative+GUITHREADINFO
  $gui.cbSize = [Runtime.InteropServices.Marshal]::SizeOf(
    [type][SynVoiceCaptureNative+GUITHREADINFO]
  )
  if (-not [SynVoiceCaptureNative]::GetGUIThreadInfo($targetTid, [ref]$gui)) {
    Write-Unavailable
  }

  [long]$foregroundValue = $foreground.ToInt64()
  [long]$focusValue = $gui.hwndFocus.ToInt64()
  if ($foregroundValue -le 0 -or $focusValue -lt 0) { Write-Unavailable }

  $result = [ordered]@{
    ok = $true
    hwnd = $foregroundValue.ToString([Globalization.CultureInfo]::InvariantCulture)
    pid = [uint32]$targetPid
    tid = [uint32]$targetTid
    hwndFocus = $focusValue.ToString([Globalization.CultureInfo]::InvariantCulture)
  }
  [Console]::Out.Write(($result | ConvertTo-Json -Compress))
} catch {
  Write-Unavailable
}
`

const COMMIT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$script:sendAttempted = $false

function Write-Status([string]$status) {
  [Console]::Out.Write(('{"status":"' + $status + '"}'))
  exit 0
}

try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class SynVoiceCommitNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO
    {
        public uint cbSize;
        public uint flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public RECT rcCaret;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int left;
        public int top;
        public int right;
        public int bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public INPUTUNION U;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_V = 0x56;

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);

    public static INPUT[] CreateUnicodeInputs(string text)
    {
        INPUT[] inputs = new INPUT[text.Length * 2];
        for (int index = 0; index < text.Length; index++)
        {
            ushort unit = text[index];
            int down = index * 2;
            int up = down + 1;

            inputs[down].type = INPUT_KEYBOARD;
            inputs[down].U.ki.wVk = 0;
            inputs[down].U.ki.wScan = unit;
            inputs[down].U.ki.dwFlags = KEYEVENTF_UNICODE;

            inputs[up].type = INPUT_KEYBOARD;
            inputs[up].U.ki.wVk = 0;
            inputs[up].U.ki.wScan = unit;
            inputs[up].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        }
        return inputs;
    }

    public static INPUT[] CreatePasteInputs()
    {
        INPUT[] inputs = new INPUT[4];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].U.ki.wVk = VK_CONTROL;
        inputs[1].type = INPUT_KEYBOARD;
        inputs[1].U.ki.wVk = VK_V;
        inputs[2].type = INPUT_KEYBOARD;
        inputs[2].U.ki.wVk = VK_V;
        inputs[2].U.ki.dwFlags = KEYEVENTF_KEYUP;
        inputs[3].type = INPUT_KEYBOARD;
        inputs[3].U.ki.wVk = VK_CONTROL;
        inputs[3].U.ki.dwFlags = KEYEVENTF_KEYUP;
        return inputs;
    }

    public static string DecodeUtf8(string base64)
    {
        byte[] bytes = Convert.FromBase64String(base64);
        return new UTF8Encoding(false, true).GetString(bytes);
    }

    public static uint SendPrepared(INPUT[] inputs)
    {
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
}
'@

  function Test-TargetIdentity(
    [long]$expectedHwnd,
    [uint32]$expectedPid,
    [uint32]$expectedTid
  ) {
    [IntPtr]$window = [IntPtr]$expectedHwnd
    if (-not [SynVoiceCommitNative]::IsWindow($window)) { return $false }

    [uint32]$actualPid = 0
    [uint32]$actualTid = [SynVoiceCommitNative]::GetWindowThreadProcessId(
      $window,
      [ref]$actualPid
    )
    return $actualPid -eq $expectedPid -and $actualTid -eq $expectedTid
  }

  function Test-Target(
    [long]$expectedHwnd,
    [uint32]$expectedPid,
    [uint32]$expectedTid,
    [long]$expectedFocus
  ) {
    if (-not (Test-TargetIdentity $expectedHwnd $expectedPid $expectedTid)) {
      return $false
    }

    [IntPtr]$foreground = [SynVoiceCommitNative]::GetForegroundWindow()
    if ($foreground.ToInt64() -ne $expectedHwnd) { return $false }

    $gui = New-Object SynVoiceCommitNative+GUITHREADINFO
    $gui.cbSize = [Runtime.InteropServices.Marshal]::SizeOf(
      [type][SynVoiceCommitNative+GUITHREADINFO]
    )
    if (-not [SynVoiceCommitNative]::GetGUIThreadInfo($expectedTid, [ref]$gui)) {
      return $false
    }
    if ($expectedFocus -ne 0) {
      if (-not [SynVoiceCommitNative]::IsWindow([IntPtr]$expectedFocus)) { return $false }
      if ($gui.hwndFocus.ToInt64() -ne $expectedFocus) { return $false }
    }
    return $true
  }

  function Restore-Target(
    [long]$expectedHwnd,
    [uint32]$expectedPid,
    [uint32]$expectedTid,
    [long]$expectedFocus,
    [uint32]$ownPid
  ) {
    if (Test-Target $expectedHwnd $expectedPid $expectedTid $expectedFocus) {
      return $true
    }
    if (-not (Test-TargetIdentity $expectedHwnd $expectedPid $expectedTid)) {
      return $false
    }

    [IntPtr]$foreground = [SynVoiceCommitNative]::GetForegroundWindow()
    if ($foreground -eq [IntPtr]::Zero) { return $false }
    [uint32]$foregroundPid = 0
    [void][SynVoiceCommitNative]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
    # Nunca rouba o foco de um terceiro aplicativo. A restauração só é permitida
    # quando quem tomou o foco foi uma janela do próprio Synkora.
    if ($foregroundPid -ne $ownPid) { return $false }

    if (-not [SynVoiceCommitNative]::SetForegroundWindow([IntPtr]$expectedHwnd)) {
      return $false
    }
    Start-Sleep -Milliseconds 28
    return Test-Target $expectedHwnd $expectedPid $expectedTid $expectedFocus
  }

  $raw = [Console]::In.ReadToEnd()
  if ([String]::IsNullOrWhiteSpace($raw)) { Write-Status 'unavailable' }
  $request = $raw | ConvertFrom-Json

  [long]$expectedHwnd = 0
  [long]$expectedFocus = 0
  if (-not [long]::TryParse(
    [string]$request.target.hwnd,
    [Globalization.NumberStyles]::None,
    [Globalization.CultureInfo]::InvariantCulture,
    [ref]$expectedHwnd
  )) { Write-Status 'unavailable' }
  if (-not [long]::TryParse(
    [string]$request.target.hwndFocus,
    [Globalization.NumberStyles]::None,
    [Globalization.CultureInfo]::InvariantCulture,
    [ref]$expectedFocus
  )) { Write-Status 'unavailable' }
  if ($expectedHwnd -le 0 -or $expectedFocus -lt 0) { Write-Status 'unavailable' }

  [uint64]$expectedPidWide = [uint64]$request.target.pid
  [uint64]$expectedTidWide = [uint64]$request.target.tid
  [uint64]$ownPidWide = [uint64]$request.ownPid
  if (
    $expectedPidWide -eq 0 -or $expectedPidWide -gt [uint32]::MaxValue -or
    $expectedTidWide -eq 0 -or $expectedTidWide -gt [uint32]::MaxValue -or
    $ownPidWide -eq 0 -or $ownPidWide -gt [uint32]::MaxValue
  ) { Write-Status 'unavailable' }
  [uint32]$expectedPid = [uint32]$expectedPidWide
  [uint32]$expectedTid = [uint32]$expectedTidWide
  [uint32]$ownPid = [uint32]$ownPidWide
  if ($expectedPid -eq $ownPid) { Write-Status 'unavailable' }

  if (-not (Restore-Target $expectedHwnd $expectedPid $expectedTid $expectedFocus $ownPid)) {
    Write-Status 'unavailable'
  }
  if ([bool]$request.restoreOnly) { Write-Status 'inserted' }

  foreach ($virtualKey in @(0x10, 0x11, 0x12, 0x5B, 0x5C)) {
    [int]$state = [SynVoiceCommitNative]::GetAsyncKeyState($virtualKey)
    if (($state -band 0x8000) -ne 0) { Write-Status 'unavailable' }
  }

  if ([bool]$request.pasteOnly) {
    $pasteInputs = [SynVoiceCommitNative]::CreatePasteInputs()
    $script:sendAttempted = $true
    [uint32]$pasteSent = [SynVoiceCommitNative]::SendPrepared($pasteInputs)
    if ($pasteSent -eq [uint32]$pasteInputs.Length) { Write-Status 'inserted' }
    Write-Status 'uncertain'
  }

  [string]$encodedText = [string]$request.textBase64
  if ([String]::IsNullOrEmpty($encodedText) -or $encodedText.Length -gt 100000) {
    Write-Status 'unavailable'
  }
  [string]$text = [SynVoiceCommitNative]::DecodeUtf8($encodedText)
  if ([String]::IsNullOrEmpty($text) -or $text.Length -gt 20000) {
    Write-Status 'unavailable'
  }

  $inputs = [SynVoiceCommitNative]::CreateUnicodeInputs($text)
  if ($null -eq $inputs -or $inputs.Length -ne ($text.Length * 2)) {
    Write-Status 'unavailable'
  }

  if (-not (Test-Target $expectedHwnd $expectedPid $expectedTid $expectedFocus)) {
    Write-Status 'unavailable'
  }

  [uint32]$expectedCount = [uint32]$inputs.Length
  $script:sendAttempted = $true
  [uint32]$sent = [SynVoiceCommitNative]::SendPrepared($inputs)
  if ($sent -eq $expectedCount) { Write-Status 'inserted' }
  Write-Status 'uncertain'
} catch {
  if ($script:sendAttempted) { Write-Status 'uncertain' }
  Write-Status 'unavailable'
}
`

const CAPTURE_COMMAND = Buffer.from(CAPTURE_SCRIPT, 'utf16le').toString('base64')
const COMMIT_COMMAND = Buffer.from(COMMIT_SCRIPT, 'utf16le').toString('base64')

function runPowerShell(
  encodedCommand: string,
  payload: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<PowerShellResult> {
  if (signal?.aborted) return Promise.resolve({ kind: 'unavailable' })
  let input: string
  try {
    input = JSON.stringify(payload)
  } catch {
    return Promise.resolve({ kind: 'unavailable' })
  }

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
        {
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe']
        }
      )
    } catch {
      resolve({ kind: 'unavailable' })
      return
    }

    activePowerShellChildren.add(child)
    const stdout: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let launched = true
    let timer: NodeJS.Timeout | null = null

    const finish = (result: PowerShellResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', stopAsUncertain)
      activePowerShellChildren.delete(child)
      resolve(result)
    }

    const stopAsUncertain = (): void => {
      if (settled) return
      try {
        child.kill()
      } catch {
        // O processo pode ter terminado entre a verificacao e o encerramento.
      }
      finish({ kind: 'uncertain' })
    }

    timer = setTimeout(stopAsUncertain, timeoutMs)
    signal?.addEventListener('abort', stopAsUncertain, { once: true })
    if (signal?.aborted) {
      stopAsUncertain()
      return
    }

    child.stdout.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      stdoutBytes += buffer.length
      if (stdoutBytes > MAX_PROCESS_OUTPUT_BYTES) {
        stopAsUncertain()
        return
      }
      stdout.push(buffer)
    })

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
      if (stderrBytes > MAX_PROCESS_OUTPUT_BYTES) stopAsUncertain()
    })

    child.once('error', () => {
      launched = false
      finish({ kind: 'unavailable' })
    })

    child.once('close', (code) => {
      if (settled) return
      if (!launched) {
        finish({ kind: 'unavailable' })
        return
      }
      if (code !== 0) {
        finish({ kind: 'uncertain' })
        return
      }
      finish({ kind: 'completed', stdout: Buffer.concat(stdout).toString('utf8') })
    })

    child.stdin.on('error', () => {
      // O evento close classifica se o processo chegou ou nao a executar o script.
    })
    try {
      child.stdin.end(input, 'utf8')
    } catch {
      stopAsUncertain()
    }
  })
}

function isSafeId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 0xffffffff
}

function isHandle(value: unknown, allowZero: boolean): value is string {
  if (typeof value !== 'string' || !/^\d{1,19}$/.test(value)) return false
  if (!allowZero && value === '0') return false
  try {
    const parsed = BigInt(value)
    return parsed >= (allowZero ? 0n : 1n) && parsed <= BigInt('9223372036854775807')
  } catch {
    return false
  }
}

function parseCaptureResponse(stdout: string): CaptureResponse | null {
  try {
    const value: unknown = JSON.parse(stdout.trim())
    if (!value || typeof value !== 'object') return null
    const response = value as Partial<CaptureResponse>
    if (response.ok !== true) return null
    if (!isHandle(response.hwnd, false) || !isHandle(response.hwndFocus, true)) return null
    if (!isSafeId(response.pid) || !isSafeId(response.tid)) return null
    return response as CaptureResponse
  } catch {
    return null
  }
}

function parseCommitResponse(stdout: string): CommitResponse['status'] | null {
  try {
    const value: unknown = JSON.parse(stdout.trim())
    if (!value || typeof value !== 'object') return null
    const status = (value as Partial<CommitResponse>).status
    return status === 'inserted' || status === 'unavailable' || status === 'uncertain'
      ? status
      : null
  } catch {
    return null
  }
}

function sanitizeText(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > MAX_TEXT_UNITS) return null
  let sanitized: string
  try {
    sanitized = value
      .normalize('NFC')
      .replace(/[\r\n\t\u2028\u2029]/g, ' ')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
  } catch {
    return null
  }
  if (!sanitized || sanitized.length > MAX_TEXT_UNITS) return null
  return sanitized
}

export class WindowsTextInput {
  private readonly targets = new Map<string, CapturedTarget>()
  private globalGeneration = 0
  private readonly ownerGenerations = new Map<number, number>()

  async capture(ownerId: number): Promise<string | null> {
    if (process.platform !== 'win32' || !isSafeId(ownerId) || !isSafeId(process.pid)) return null

    this.purgeExpired()
    const capturedAt = Date.now()
    const globalGeneration = this.globalGeneration
    const ownerGeneration = this.ownerGenerations.get(ownerId) ?? 0
    const result = await runPowerShell(
      CAPTURE_COMMAND,
      { ownPid: process.pid },
      CAPTURE_TIMEOUT_MS
    )

    if (result.kind !== 'completed') return null
    if (this.globalGeneration !== globalGeneration) return null
    if ((this.ownerGenerations.get(ownerId) ?? 0) !== ownerGeneration) return null

    const response = parseCaptureResponse(result.stdout)
    if (!response || response.pid === process.pid) return null
    const expiresAt = capturedAt + TARGET_TTL_MS
    if (Date.now() >= expiresAt) return null

    this.makeRoom()
    const token = randomUUID()
    this.targets.set(token, {
      ownerId,
      hwnd: response.hwnd,
      pid: response.pid,
      tid: response.tid,
      hwndFocus: response.hwndFocus,
      capturedAt,
      expiresAt
    })
    return token
  }

  async commit(
    ownerId: number,
    token: string,
    text: string,
    signal?: AbortSignal,
    mode: 'unicode' | 'paste' = 'unicode'
  ): Promise<'inserted' | 'unavailable' | 'uncertain'> {
    if (!isSafeId(ownerId) || !TOKEN_PATTERN.test(token)) return 'unavailable'

    this.purgeExpired()
    const target = this.targets.get(token)
    if (!target || target.ownerId !== ownerId) return 'unavailable'
    this.targets.delete(token)

    if (signal?.aborted || process.platform !== 'win32' || !isSafeId(process.pid)) {
      return 'unavailable'
    }
    if (Date.now() >= target.expiresAt || target.pid === process.pid) return 'unavailable'

    const sanitized = sanitizeText(text)
    if (!sanitized) return 'unavailable'

    const result = await runPowerShell(
      COMMIT_COMMAND,
      {
        ownPid: process.pid,
        target: {
          hwnd: target.hwnd,
          pid: target.pid,
          tid: target.tid,
          hwndFocus: target.hwndFocus
        },
        restoreOnly: false,
        pasteOnly: mode === 'paste',
        textBase64: Buffer.from(sanitized, 'utf8').toString('base64')
      },
      COMMIT_TIMEOUT_MS,
      signal
    )

    if (result.kind === 'unavailable') return 'unavailable'
    if (result.kind === 'uncertain') return 'uncertain'
    return parseCommitResponse(result.stdout) ?? 'uncertain'
  }

  async restore(ownerId: number, token: string, signal?: AbortSignal): Promise<boolean> {
    if (!isSafeId(ownerId) || !TOKEN_PATTERN.test(token)) return false

    this.purgeExpired()
    const target = this.targets.get(token)
    if (!target || target.ownerId !== ownerId) return false
    if (
      signal?.aborted ||
      process.platform !== 'win32' ||
      !isSafeId(process.pid) ||
      Date.now() >= target.expiresAt ||
      target.pid === process.pid
    ) return false

    const result = await runPowerShell(
      COMMIT_COMMAND,
      {
        ownPid: process.pid,
        target: {
          hwnd: target.hwnd,
          pid: target.pid,
          tid: target.tid,
          hwndFocus: target.hwndFocus
        },
        restoreOnly: true,
        pasteOnly: false
      },
      CAPTURE_TIMEOUT_MS,
      signal
    )

    return result.kind === 'completed' && parseCommitResponse(result.stdout) === 'inserted'
  }

  discard(token: string): void {
    if (TOKEN_PATTERN.test(token)) this.targets.delete(token)
  }

  discardOwner(ownerId: number): void {
    if (!isSafeId(ownerId)) return
    this.ownerGenerations.set(ownerId, (this.ownerGenerations.get(ownerId) ?? 0) + 1)
    for (const [token, target] of this.targets) {
      if (target.ownerId === ownerId) this.targets.delete(token)
    }
  }

  clear(): void {
    this.globalGeneration += 1
    this.targets.clear()
    this.ownerGenerations.clear()
    for (const child of activePowerShellChildren) {
      try {
        child.kill()
      } catch {
        // O processo pode já ter encerrado.
      }
    }
    activePowerShellChildren.clear()
  }

  private purgeExpired(now = Date.now()): void {
    for (const [token, target] of this.targets) {
      if (now >= target.expiresAt) this.targets.delete(token)
    }
  }

  private makeRoom(): void {
    while (this.targets.size >= MAX_TRACKED_TARGETS) {
      let oldestToken: string | null = null
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [token, target] of this.targets) {
        if (target.capturedAt < oldestAt) {
          oldestAt = target.capturedAt
          oldestToken = token
        }
      }
      if (!oldestToken) return
      this.targets.delete(oldestToken)
    }
  }
}
