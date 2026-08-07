import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { gzipSync } from 'node:zlib'

export type GlobalActivationBinding =
  | {
      mode: 'toggle'
      kind: 'keyboard'
      code: string
      ctrlKey: boolean
      altKey: boolean
      shiftKey: boolean
      metaKey: boolean
    }
  | { mode: 'toggle'; kind: 'mouse'; button: number }
  | {
      mode: 'hold'
      kind: 'keyboard'
      code: string
      ctrlKey: boolean
      altKey: boolean
      shiftKey: boolean
      metaKey: boolean
    }

export type GlobalActivationEvent = 'toggle' | 'hold-start' | 'hold-stop'

const MAX_CONFIG_BYTES = 512
const MAX_STREAM_CHUNK_BYTES = 4 * 1024
const MAX_PENDING_LINE_BYTES = 512
const MAX_PROTOCOL_LINE_BYTES = 128
const START_TIMEOUT_MS = 10_000

const KEYBOARD_CODES = new Set<string>([
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  ...Array.from({ length: 26 }, (_, index) => `Key${String.fromCharCode(65 + index)}`),
  ...Array.from({ length: 10 }, (_, index) => `Digit${index}`),
  'Space',
  'ArrowLeft',
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
  'Delete',
  'Escape'
])

// The command is deliberately fixed. The selected binding is sent separately on stdin,
// so no key or button supplied by the renderer can become PowerShell source code.
const ACTIVATION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Fail-Activation {
  [Console]::Error.WriteLine('FAILED')
  [Console]::Error.Flush()
  exit 2
}

try {
  $configLine = [Console]::In.ReadLine()
  if ([string]::IsNullOrWhiteSpace($configLine) -or $configLine.Length -gt 512) {
    Fail-Activation
  }
  $config = $configLine | ConvertFrom-Json

  $mode = [string]$config.mode
  $kind = [string]$config.kind
  if (($mode -ne 'toggle' -and $mode -ne 'hold') -or
      ($kind -ne 'keyboard' -and $kind -ne 'mouse') -or
      ($kind -eq 'mouse' -and $mode -ne 'toggle')) {
    Fail-Activation
  }

  $virtualKeys = @{
    Space = 0x20
    ArrowLeft = 0x25
    ArrowUp = 0x26
    ArrowRight = 0x27
    ArrowDown = 0x28
    Home = 0x24
    End = 0x23
    PageUp = 0x21
    PageDown = 0x22
    Insert = 0x2D
    Delete = 0x2E
    Escape = 0x1B
  }
  for ($number = 1; $number -le 12; $number++) {
    $virtualKeys["F$number"] = 0x6F + $number
  }
  for ($letter = 0; $letter -lt 26; $letter++) {
    $virtualKeys["Key$([char](65 + $letter))"] = 0x41 + $letter
  }
  for ($digit = 0; $digit -lt 10; $digit++) {
    $virtualKeys["Digit$digit"] = 0x30 + $digit
  }

  [int]$virtualKey = 0
  [int]$mouseButton = -1
  [bool]$ctrlKey = $false
  [bool]$altKey = $false
  [bool]$shiftKey = $false
  [bool]$metaKey = $false

  if ($kind -eq 'keyboard') {
    $code = [string]$config.code
    if (-not $virtualKeys.ContainsKey($code)) { Fail-Activation }
    $virtualKey = [int]$virtualKeys[$code]
    $ctrlKey = [bool]$config.ctrlKey
    $altKey = [bool]$config.altKey
    $shiftKey = [bool]$config.shiftKey
    $metaKey = [bool]$config.metaKey
  } else {
    $mouseButton = [int]$config.button
    if ($mouseButton -ne 1 -and $mouseButton -ne 3 -and $mouseButton -ne 4) {
      Fail-Activation
    }
  }

  $null = Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class SynVoiceGlobalActivation
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;
    private const int HC_ACTION = 0;

    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;
    private const int WM_MBUTTONDOWN = 0x0207;
    private const int WM_MBUTTONUP = 0x0208;
    private const int WM_XBUTTONDOWN = 0x020B;
    private const int WM_XBUTTONUP = 0x020C;

    private const int LLKHF_INJECTED = 0x10;
    private const int PM_NOREMOVE = 0x0000;

    private const uint EVENT_TOGGLE = 0x8001;
    private const uint EVENT_HOLD_START = 0x8002;
    private const uint EVENT_HOLD_STOP = 0x8003;

    private const int VK_SHIFT = 0x10;
    private const int VK_CONTROL = 0x11;
    private const int VK_MENU = 0x12;
    private const int VK_LWIN = 0x5B;
    private const int VK_RWIN = 0x5C;
    private const int VK_MBUTTON = 0x04;
    private const int VK_XBUTTON1 = 0x05;
    private const int VK_XBUTTON2 = 0x06;

    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public IntPtr HWnd;
        public uint Value;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public Point Pt;
        public uint Private;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(
        int hookId,
        HookProc callback,
        IntPtr module,
        uint threadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(
        IntPtr hook,
        int nCode,
        IntPtr wParam,
        IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int virtualKey);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostThreadMessage(
        uint threadId,
        uint message,
        UIntPtr wParam,
        IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetMessage(
        out Message message,
        IntPtr window,
        uint minimum,
        uint maximum);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PeekMessage(
        out Message message,
        IntPtr window,
        uint minimum,
        uint maximum,
        uint removeMessage);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TranslateMessage(ref Message message);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref Message message);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetModuleHandle(string moduleName);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    private static HookProc keyboardCallback;
    private static HookProc mouseCallback;
    private static IntPtr keyboardHook = IntPtr.Zero;
    private static IntPtr mouseHook = IntPtr.Zero;
    private static uint messageThreadId;

    private static int targetVirtualKey;
    private static int targetMouseButton;
    private static bool holdMode;
    private static bool needControl;
    private static bool needAlt;
    private static bool needShift;
    private static bool needMeta;
    private static bool targetKeyDown;
    private static bool targetMouseDown;
    private static bool holdActive;
    private static bool consumeKeyPress;

    private static bool IsDown(int virtualKey)
    {
        return (GetAsyncKeyState(virtualKey) & 0x8000) != 0;
    }

    private static bool ModifiersMatch()
    {
        return IsDown(VK_CONTROL) == needControl &&
               IsDown(VK_MENU) == needAlt &&
               IsDown(VK_SHIFT) == needShift &&
               (IsDown(VK_LWIN) || IsDown(VK_RWIN)) == needMeta;
    }

    private static void QueueEvent(uint activationEvent)
    {
        PostThreadMessage(messageThreadId, activationEvent, UIntPtr.Zero, IntPtr.Zero);
    }

    private static IntPtr KeyboardHook(int nCode, IntPtr wParam, IntPtr lParam)
    {
        bool consume = false;
        try
        {
            if (nCode == HC_ACTION)
            {
                // Read only the virtual-key field needed for the configured comparison.
                int virtualKey = Marshal.ReadInt32(lParam, 0);
                if (virtualKey == targetVirtualKey)
                {
                    // flags is read only after the configured key matched.
                    int flags = Marshal.ReadInt32(lParam, 8);
                    if ((flags & LLKHF_INJECTED) == 0)
                    {
                        int message = unchecked((int)wParam.ToInt64());
                        bool isDown = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
                        bool isUp = message == WM_KEYUP || message == WM_SYSKEYUP;

                        if (isDown && !targetKeyDown)
                        {
                            targetKeyDown = true;
                            if (ModifiersMatch())
                            {
                                consumeKeyPress = true;
                                if (holdMode)
                                {
                                    holdActive = true;
                                    QueueEvent(EVENT_HOLD_START);
                                }
                                else
                                {
                                    QueueEvent(EVENT_TOGGLE);
                                }
                            }
                        }
                        if (isDown && consumeKeyPress)
                        {
                            // Consume repeats too, while still emitting only once.
                            consume = true;
                        }
                        else if (isUp && targetKeyDown)
                        {
                            targetKeyDown = false;
                            consume = consumeKeyPress;
                            consumeKeyPress = false;
                            if (holdActive)
                            {
                                // Deliberately do not re-check modifiers on key-up.
                                holdActive = false;
                                QueueEvent(EVENT_HOLD_STOP);
                            }
                        }
                    }
                }
            }
        }
        catch
        {
            // A hook must never interfere with input delivery.
        }

        IntPtr next = CallNextHookEx(keyboardHook, nCode, wParam, lParam);
        return consume ? new IntPtr(1) : next;
    }

    private static bool IsConfiguredMouseMessage(int message, IntPtr lParam, out bool isDown, out bool isUp)
    {
        isDown = false;
        isUp = false;

        if (targetMouseButton == 1)
        {
            isDown = message == WM_MBUTTONDOWN;
            isUp = message == WM_MBUTTONUP;
            return isDown || isUp;
        }

        if (message != WM_XBUTTONDOWN && message != WM_XBUTTONUP)
        {
            return false;
        }

        // mouseData is read only for an X-button message that might be configured.
        int mouseData = Marshal.ReadInt32(lParam, 8);
        int xButton = (mouseData >> 16) & 0xffff;
        int expected = targetMouseButton == 3 ? 1 : 2;
        if (xButton != expected)
        {
            return false;
        }

        isDown = message == WM_XBUTTONDOWN;
        isUp = message == WM_XBUTTONUP;
        return true;
    }

    private static IntPtr MouseHook(int nCode, IntPtr wParam, IntPtr lParam)
    {
        bool consume = false;
        try
        {
            if (nCode == HC_ACTION)
            {
                int message = unchecked((int)wParam.ToInt64());
                bool isDown;
                bool isUp;
                if (IsConfiguredMouseMessage(message, lParam, out isDown, out isUp))
                {
                    // Logitech Options+ can remap a physical side button into an
                    // injected XBUTTON event. It is accepted only after the exact
                    // configured button has matched; no other mouse event is read.
                    consume = true;
                    if (isDown && !targetMouseDown)
                    {
                        targetMouseDown = true;
                        QueueEvent(EVENT_TOGGLE);
                    }
                    else if (isUp)
                    {
                        targetMouseDown = false;
                    }
                }
            }
        }
        catch
        {
            // A hook must never interfere with input delivery.
        }

        IntPtr next = CallNextHookEx(mouseHook, nCode, wParam, lParam);
        return consume ? new IntPtr(1) : next;
    }

    private static void EmitEvent(uint message)
    {
        string json = null;
        if (message == EVENT_TOGGLE)
        {
            json = "{\"event\":\"toggle\"}";
        }
        else if (message == EVENT_HOLD_START)
        {
            json = "{\"event\":\"hold-start\"}";
        }
        else if (message == EVENT_HOLD_STOP)
        {
            json = "{\"event\":\"hold-stop\"}";
        }

        if (json != null)
        {
            Console.Out.WriteLine(json);
            Console.Out.Flush();
        }
    }

    public static bool Run(
        bool keyboard,
        bool hold,
        int virtualKey,
        int mouseButton,
        bool control,
        bool alt,
        bool shift,
        bool meta)
    {
        targetVirtualKey = virtualKey;
        targetMouseButton = mouseButton;
        holdMode = hold;
        needControl = control;
        needAlt = alt;
        needShift = shift;
        needMeta = meta;
        holdActive = false;
        consumeKeyPress = false;
        messageThreadId = GetCurrentThreadId();

        Message ignored;
        PeekMessage(out ignored, IntPtr.Zero, 0, 0, PM_NOREMOVE);

        IntPtr module = GetModuleHandle(null);
        if (keyboard)
        {
            targetKeyDown = IsDown(targetVirtualKey);
            keyboardCallback = KeyboardHook;
            keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardCallback, module, 0);
            if (keyboardHook == IntPtr.Zero)
            {
                return false;
            }
        }
        else
        {
            int buttonVirtualKey = targetMouseButton == 1
                ? VK_MBUTTON
                : (targetMouseButton == 3 ? VK_XBUTTON1 : VK_XBUTTON2);
            targetMouseDown = IsDown(buttonVirtualKey);
            mouseCallback = MouseHook;
            mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseCallback, module, 0);
            if (mouseHook == IntPtr.Zero)
            {
                return false;
            }
        }

        Console.Error.WriteLine("READY");
        Console.Error.Flush();

        try
        {
            Message message;
            int result;
            while ((result = GetMessage(out message, IntPtr.Zero, 0, 0)) > 0)
            {
                if (message.Value == EVENT_TOGGLE ||
                    message.Value == EVENT_HOLD_START ||
                    message.Value == EVENT_HOLD_STOP)
                {
                    EmitEvent(message.Value);
                }
                else
                {
                    TranslateMessage(ref message);
                    DispatchMessage(ref message);
                }
            }
            return result == 0;
        }
        finally
        {
            if (keyboardHook != IntPtr.Zero)
            {
                UnhookWindowsHookEx(keyboardHook);
                keyboardHook = IntPtr.Zero;
            }
            if (mouseHook != IntPtr.Zero)
            {
                UnhookWindowsHookEx(mouseHook);
                mouseHook = IntPtr.Zero;
            }
            GC.KeepAlive(keyboardCallback);
            GC.KeepAlive(mouseCallback);
        }
    }
}
'@

  $started = [SynVoiceGlobalActivation]::Run(
    ($kind -eq 'keyboard'),
    ($mode -eq 'hold'),
    $virtualKey,
    $mouseButton,
    $ctrlKey,
    $altKey,
    $shiftKey,
    $metaKey)

  if (-not $started) { Fail-Activation }
} catch {
  Fail-Activation
}
`

// Windows limits a process command line to roughly 32 KiB. Keep the readable fixed
// script above, but pass a small fixed loader plus its compressed bytes to PowerShell.
const ACTIVATION_PAYLOAD = gzipSync(Buffer.from(ACTIVATION_SCRIPT, 'utf8')).toString('base64')
const ACTIVATION_LOADER = String.raw`
$ProgressPreference = 'SilentlyContinue'
$bytes = [Convert]::FromBase64String('${ACTIVATION_PAYLOAD}')
$memory = New-Object IO.MemoryStream(,$bytes)
$gzip = New-Object IO.Compression.GzipStream($memory, [IO.Compression.CompressionMode]::Decompress)
$reader = New-Object IO.StreamReader($gzip, [Text.Encoding]::UTF8)
$source = $reader.ReadToEnd()
$reader.Dispose()
& ([ScriptBlock]::Create($source))
`
const ACTIVATION_COMMAND = Buffer.from(ACTIVATION_LOADER, 'utf16le').toString('base64')

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isValidBinding(binding: GlobalActivationBinding): boolean {
  if (!binding || (binding.mode !== 'toggle' && binding.mode !== 'hold')) return false

  if (binding.kind === 'mouse') {
    return binding.mode === 'toggle' && [1, 3, 4].includes(binding.button)
  }

  return (
    binding.kind === 'keyboard' &&
    KEYBOARD_CODES.has(binding.code) &&
    isBoolean(binding.ctrlKey) &&
    isBoolean(binding.altKey) &&
    isBoolean(binding.shiftKey) &&
    isBoolean(binding.metaKey)
  )
}

function parseEventLine(line: string, mode: GlobalActivationBinding['mode']): GlobalActivationEvent | null {
  if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const keys = Object.keys(parsed)
  if (keys.length !== 1 || keys[0] !== 'event') return null

  const event = (parsed as { event?: unknown }).event
  if (mode === 'toggle') return event === 'toggle' ? event : null
  return event === 'hold-start' || event === 'hold-stop' ? event : null
}

export class WindowsGlobalActivation {
  private child: ChildProcessWithoutNullStreams | null = null
  private generation = 0
  private onEvent: ((event: GlobalActivationEvent) => void) | null = null

  async configure(
    binding: GlobalActivationBinding,
    onEvent: (event: GlobalActivationEvent) => void
  ): Promise<boolean> {
    this.stop()

    if (process.platform !== 'win32' || !isValidBinding(binding) || typeof onEvent !== 'function') {
      return false
    }

    let input: string
    try {
      input = JSON.stringify(binding)
    } catch {
      return false
    }
    if (Buffer.byteLength(input, 'utf8') > MAX_CONFIG_BYTES) return false

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', ACTIVATION_COMMAND],
        {
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe']
        }
      )
    } catch {
      return false
    }

    const generation = this.generation
    this.child = child
    this.onEvent = onEvent

    return await new Promise<boolean>((resolve) => {
      let settled = false
      let ready = false
      let stdoutPending = Buffer.alloc(0)
      let stderrPending = Buffer.alloc(0)

      const isCurrent = (): boolean => this.child === child && this.generation === generation

      const settle = (value: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }

      const terminate = (): void => {
        if (isCurrent()) {
          this.child = null
          this.onEvent = null
        }
        try {
          child.kill()
        } catch {
          // It may have exited between validation and termination.
        }
        settle(false)
      }

      const consumeStdout = (chunk: Buffer | string): void => {
        if (!isCurrent()) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (buffer.length > MAX_STREAM_CHUNK_BYTES) {
          terminate()
          return
        }

        stdoutPending = Buffer.concat([stdoutPending, buffer])
        if (stdoutPending.length > MAX_PENDING_LINE_BYTES) {
          terminate()
          return
        }

        let newline = stdoutPending.indexOf(0x0a)
        while (newline >= 0) {
          const lineBuffer = stdoutPending.subarray(0, newline)
          stdoutPending = stdoutPending.subarray(newline + 1)
          const line = lineBuffer.toString('utf8').replace(/\r$/, '')
          const event = parseEventLine(line, binding.mode)
          if (!event) {
            terminate()
            return
          }

          const callback = this.onEvent
          if (callback && isCurrent()) {
            try {
              callback(event)
            } catch {
              // Consumer errors must not bring down the global input hook.
            }
          }
          newline = stdoutPending.indexOf(0x0a)
        }
      }

      const consumeStderr = (chunk: Buffer | string): void => {
        if (!isCurrent()) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (buffer.length > MAX_STREAM_CHUNK_BYTES) {
          terminate()
          return
        }

        stderrPending = Buffer.concat([stderrPending, buffer])
        if (stderrPending.length > MAX_PENDING_LINE_BYTES) {
          terminate()
          return
        }

        let newline = stderrPending.indexOf(0x0a)
        while (newline >= 0) {
          const line = stderrPending.subarray(0, newline).toString('utf8').replace(/\r$/, '')
          stderrPending = stderrPending.subarray(newline + 1)
          if (!ready && line === 'READY') {
            ready = true
            settle(true)
          } else {
            terminate()
            return
          }
          newline = stderrPending.indexOf(0x0a)
        }
      }

      const timer = setTimeout(terminate, START_TIMEOUT_MS)

      child.stdout.on('data', consumeStdout)
      child.stderr.on('data', consumeStderr)
      child.once('error', terminate)
      child.once('close', () => {
        if (isCurrent()) {
          this.child = null
          this.onEvent = null
        }
        if (!ready) settle(false)
      })

      child.stdin.once('error', terminate)
      child.stdin.end(`${input}\n`)
    })
  }

  stop(): void {
    this.generation += 1
    const child = this.child
    this.child = null
    this.onEvent = null
    if (!child) return

    try {
      child.kill()
    } catch {
      // The subprocess may already be gone.
    }
  }
}
