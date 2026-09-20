/** Physical monitor metadata only. Never exposes EDID, hardware identities or raw helper output. */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { win32 } from 'node:path'
import { DARWIN_MONITOR_SCRIPT, parseDarwinMonitorSamples, type DarwinMonitorMetrics } from './mobileMonitorDarwin'
export { parseDarwinMonitorSamples } from './mobileMonitorDarwin'

export interface WindowsMonitorMetrics {
  boundsPx: { x: number; y: number; width: number; height: number }
  widthMm: number
  heightMm: number
  source: 'edid-detailed' | 'edid-basic'
  confidence: 'reported' | 'estimated'
}

export type NativeMonitorMetrics = WindowsMonitorMetrics | DarwinMonitorMetrics
type PhysicalSize = Omit<WindowsMonitorMetrics, 'boundsPx'>
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_MONITORS = 32
const CACHE_MS = 60_000
const TIMEOUT_MS = 10_000
const HEADER = [0, 255, 255, 255, 255, 255, 255, 0]

function plausibleSize(width: number, height: number): boolean {
  return width >= 70 && height >= 70 && width <= 2500 && height <= 2500 &&
    Math.hypot(width, height) >= 150 && Math.hypot(width, height) <= 3000 &&
    width / height >= 0.2 && width / height <= 5
}

const matchingAspect = (width: number, height: number, pixelsWide: number, pixelsHigh: number): boolean => {
  const ratio = (width / height) / (pixelsWide / pixelsHigh)
  return Number.isFinite(ratio) && ratio >= 1 / 1.08 && ratio <= 1.08
}

/** EDID 1.x base block only; optional extension blocks do not supply these dimensions. */
export function parseMobileMonitorEdid(bytes: unknown): PhysicalSize | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 128 || bytes.byteLength > 4096 || bytes.byteLength % 128 !== 0 ||
    !HEADER.every((value, index) => bytes[index] === value) || bytes[18] !== 1 || bytes[19] > 4) return undefined
  let checksum = 0
  for (let index = 0; index < 128; index++) checksum = (checksum + bytes[index]) & 255
  if (checksum !== 0) return undefined
  const basicWidth = bytes[21] * 10, basicHeight = bytes[22] * 10
  const hasBasic = plausibleSize(basicWidth, basicHeight)
  for (let offset = 54; offset <= 108; offset += 18) {
    if ((bytes[offset] | bytes[offset + 1] << 8) === 0) continue
    const widthMm = bytes[offset + 12] | (bytes[offset + 14] & 240) << 4
    const heightMm = bytes[offset + 13] | (bytes[offset + 14] & 15) << 8
    const pixelsWide = bytes[offset + 2] | (bytes[offset + 4] & 240) << 4
    const lines = bytes[offset + 5] | (bytes[offset + 7] & 240) << 4
    const pixelsHigh = lines * ((bytes[offset + 17] & 128) ? 2 : 1)
    if (!plausibleSize(widthMm, heightMm) || pixelsWide < 128 || pixelsHigh < 128 ||
      !matchingAspect(widthMm, heightMm, pixelsWide, pixelsHigh)) continue
    // A timing may describe a letterboxed image rather than the full physical panel.
    if (hasBasic && (Math.abs(widthMm - basicWidth) > Math.max(6, basicWidth * 0.02) ||
      Math.abs(heightMm - basicHeight) > Math.max(6, basicHeight * 0.02))) continue
    return { widthMm, heightMm, source: 'edid-detailed', confidence: 'reported' }
  }
  return hasBasic ? { widthMm: basicWidth, heightMm: basicHeight, source: 'edid-basic', confidence: 'estimated' } : undefined
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const boundedInteger = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum

/** Parses the bounded private helper pipe, then discards all metadata except physical geometry. */
export function parseMobileMonitorSamples(output: unknown): WindowsMonitorMetrics[] {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) return []
  let samples: unknown
  try { samples = JSON.parse(output) } catch { return [] }
  if (!Array.isArray(samples) || samples.length > MAX_MONITORS) return []
  const result: WindowsMonitorMetrics[] = []
  for (const sample of samples) {
    if (!object(sample) || sample.matchedInterfaces !== 1 || ![0, 90, 180, 270].includes(sample.rotation as number) ||
      typeof sample.edid !== 'string' || sample.edid.length > 5500 || !object(sample.boundsPx)) continue
    const { x, y, width, height } = sample.boundsPx
    if (!boundedInteger(x, -1_000_000, 1_000_000) || !boundedInteger(y, -1_000_000, 1_000_000) ||
      !boundedInteger(width, 128, 32768) || !boundedInteger(height, 128, 32768) ||
      Math.abs(x + width) > 1_000_000 || Math.abs(y + height) > 1_000_000) continue
    const bytes = Buffer.from(sample.edid, 'base64')
    if (bytes.toString('base64') !== sample.edid) continue
    const size = parseMobileMonitorEdid(bytes)
    if (!size) continue
    const rotated = sample.rotation === 90 || sample.rotation === 270
    const widthMm = rotated ? size.heightMm : size.widthMm, heightMm = rotated ? size.widthMm : size.heightMm
    if (!matchingAspect(widthMm, heightMm, width, height)) continue
    result.push({ boundsPx: { x, y, width, height }, widthMm, heightMm, source: size.source, confidence: size.confidence })
  }
  // Clone/overlap configurations cannot identify a unique physical screen for a point.
  return result.filter((item, index) => !result.some((other, otherIndex) => index !== otherIndex &&
    item.boundsPx.x < other.boundsPx.x + other.boundsPx.width && other.boundsPx.x < item.boundsPx.x + item.boundsPx.width &&
    item.boundsPx.y < other.boundsPx.y + other.boundsPx.height && other.boundsPx.y < item.boundsPx.y + item.boundsPx.height))
}

// All code and arguments are internal constants. Device paths stay inside SetupAPI, never parsed as registry paths.
const HELPER = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SynkoraMonitorMetadata {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct MONITORINFO {
    public uint cbSize; public RECT monitor,work; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string device;
  }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct DISPLAY_DEVICE {
    public uint cb;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string name;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string description;
    public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string id;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string key;
  }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct MODE {
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string name;
    public ushort spec,driver,size,extra; public uint fields;
    public int x,y; public uint orientation,fixedOutput;
    public short color,duplex,yResolution,tt,collate;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string form;
    public ushort logPixels; public uint bits,width,height,displayFlags,frequency;
    public uint icmMethod,icmIntent,media,dither,reserved1,reserved2,panningWidth,panningHeight;
  }
  [StructLayout(LayoutKind.Sequential)] struct INTERFACE { public uint size; public Guid guid; public uint flags; public IntPtr reserved; }
  [StructLayout(LayoutKind.Sequential)] struct DEVICE { public uint size; public Guid guid; public uint instance; public IntPtr reserved; }
  delegate bool MonitorCallback(IntPtr monitor,IntPtr dc,ref RECT rect,IntPtr data);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc,IntPtr clip,MonitorCallback callback,IntPtr data);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetMonitorInfoW(IntPtr monitor,ref MONITORINFO info);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool EnumDisplayDevicesW(string device,uint index,ref DISPLAY_DEVICE info,uint flags);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool EnumDisplaySettingsW(string device,int mode,ref MODE info);
  [DllImport("setupapi.dll")] static extern IntPtr SetupDiCreateDeviceInfoList(IntPtr guid,IntPtr owner);
  [DllImport("setupapi.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SetupDiOpenDeviceInterfaceW(IntPtr set,string path,uint flags,ref INTERFACE info);
  [DllImport("setupapi.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SetupDiGetDeviceInterfaceDetailW(IntPtr set,ref INTERFACE info,IntPtr detail,uint size,out uint needed,ref DEVICE device);
  [DllImport("setupapi.dll")] static extern IntPtr SetupDiOpenDevRegKey(IntPtr set,ref DEVICE device,uint scope,uint profile,uint type,uint access);
  [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern int RegQueryValueExW(IntPtr key,string name,IntPtr reserved,out uint type,byte[] data,ref uint size);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern int RegOpenKeyExW(IntPtr key,string name,uint options,uint access,out IntPtr result);
  [DllImport("advapi32.dll")] static extern int RegCloseKey(IntPtr key);
  public sealed class Bounds { public int x,y,width,height; }
  public sealed class Sample { public Bounds boundsPx; public int rotation,matchedInterfaces; public string edid; }
  static bool Invalid(IntPtr handle) { return handle==IntPtr.Zero || handle==new IntPtr(-1); }
  static byte[] Value(IntPtr key,string name,out bool found) {
    uint size=0,type; int code=RegQueryValueExW(key,name,IntPtr.Zero,out type,null,ref size);
    found=code!=2;
    if(code!=0 || type!=3 || size<128 || size>4096 || size%128!=0) return null;
    byte[] bytes=new byte[size]; uint actual=size;
    if(RegQueryValueExW(key,name,IntPtr.Zero,out type,bytes,ref actual)!=0 || type!=3 || actual!=size) return null;
    byte[] block=new byte[128]; Array.Copy(bytes,block,128); return block;
  }
  static byte[] ReadEdid(string path) {
    IntPtr set=SetupDiCreateDeviceInfoList(IntPtr.Zero,IntPtr.Zero);
    if(Invalid(set)) return null;
    try {
      INTERFACE face=new INTERFACE(); face.size=(uint)Marshal.SizeOf(typeof(INTERFACE));
      if(!SetupDiOpenDeviceInterfaceW(set,path,0,ref face) || face.guid!=new Guid("e6f07b5f-ee97-4a90-b076-33f57bf4eaa7")) return null;
      DEVICE device=new DEVICE(); device.size=(uint)Marshal.SizeOf(typeof(DEVICE)); uint needed;
      bool detail=SetupDiGetDeviceInterfaceDetailW(set,ref face,IntPtr.Zero,0,out needed,ref device);
      if(!detail && Marshal.GetLastWin32Error()!=122) return null;
      IntPtr key=SetupDiOpenDevRegKey(set,ref device,1,0,1,1);
      if(Invalid(key)) return null;
      try {
        IntPtr over;
        if(RegOpenKeyExW(key,"EDID_OVERRIDE",0,1,out over)==0) {
          try { bool found; byte[] replacement=Value(over,"0",out found); if(found) return replacement; }
          finally { RegCloseKey(over); }
        }
        bool present; return Value(key,"EDID",out present);
      } finally { RegCloseKey(key); }
    } finally { SetupDiDestroyDeviceInfoList(set); }
  }
  public static Sample[] Read() {
    List<Sample> result=new List<Sample>(); IntPtr previous=IntPtr.Zero;
    try {
      previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
      if(previous==IntPtr.Zero) previous=SetThreadDpiAwarenessContext(new IntPtr(-3));
      if(previous==IntPtr.Zero) return result.ToArray();
      int count=0;
      bool success=EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,delegate(IntPtr handle,IntPtr dc,ref RECT rect,IntPtr data) {
        if(++count>32) return false;
        try {
          MONITORINFO info=new MONITORINFO(); info.cbSize=(uint)Marshal.SizeOf(typeof(MONITORINFO));
          if(!GetMonitorInfoW(handle,ref info) || String.IsNullOrEmpty(info.device)) return true;
          MODE mode=new MODE(); mode.size=(ushort)Marshal.SizeOf(typeof(MODE));
          if(!EnumDisplaySettingsW(info.device,-1,ref mode) || mode.orientation>3 || (mode.fields & 0x1800a0)!=0x1800a0 ||
            mode.x!=info.monitor.left || mode.y!=info.monitor.top ||
            mode.width!=(long)info.monitor.right-info.monitor.left || mode.height!=(long)info.monitor.bottom-info.monitor.top) return true;
          int matched=0; string path=null;
          for(uint i=0;i<32;i++) {
            DISPLAY_DEVICE display=new DISPLAY_DEVICE(); display.cb=(uint)Marshal.SizeOf(typeof(DISPLAY_DEVICE));
            if(!EnumDisplayDevicesW(info.device,i,ref display,1)) break;
            if((display.flags & 1)==0 || (display.flags & 8)!=0) continue;
            matched++; path=display.id;
          }
          if(matched!=1 || String.IsNullOrEmpty(path)) return true;
          byte[] edid=ReadEdid(path); if(edid==null) return true;
          result.Add(new Sample { boundsPx=new Bounds { x=mode.x,y=mode.y,width=(int)mode.width,height=(int)mode.height },
            rotation=(int)mode.orientation*90,matchedInterfaces=matched,edid=Convert.ToBase64String(edid) });
        } catch { }
        return true;
      },IntPtr.Zero);
      return success ? result.ToArray() : new Sample[0];
    } catch { return new Sample[0]; }
    finally { if(previous!=IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
  }
}
'@
ConvertTo-Json -InputObject @([SynkoraMonitorMetadata]::Read()) -Depth 4 -Compress
`

type SpawnProcess = (executable: string, args: readonly string[], options: SpawnOptions) => ChildProcess
interface DetectorDependencies {
  platform?: string
  now?: () => number
  /** Internal test seams; renderer input is never forwarded to these dependencies. */
  runHelper?: (signal: AbortSignal) => Promise<string>
  spawnProcess?: SpawnProcess
  timeoutMs?: number
}

function runHelper(signal: AbortSignal, spawnProcess: SpawnProcess, platform: 'win32' | 'darwin'): Promise<string> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve('[]'); return }
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'
    const system32 = win32.join(systemRoot, 'System32')
    const powerShell = win32.join(system32, 'WindowsPowerShell', 'v1.0')
    const encoded = Buffer.from(HELPER, 'utf16le').toString('base64')
    if (encoded.length >= 30000) { resolve('[]'); return }
    let child: ChildProcess
    try {
      child = platform === 'darwin' ? spawnProcess('/usr/bin/osascript', ['-l', 'JavaScript', '-e', DARWIN_MONITOR_SCRIPT], {
        shell: false, windowsHide: true, cwd: '/', stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' }
      }) : spawnProcess(win32.join(powerShell, 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
          shell: false, windowsHide: true, cwd: system32, stdio: ['ignore', 'pipe', 'pipe'],
          env: { SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
            PATH: `${system32};${powerShell}`, PSModulePath: win32.join(powerShell, 'Modules') }
        })
    } catch { resolve('[]'); return }
    let settled = false, bytes = 0
    const chunks: Buffer[] = []
    const finish = (value: string): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', cancel)
      chunks.length = 0
      resolve(value)
    }
    const cancel = (): void => {
      if (settled) return
      finish('[]')
      try { child.kill('SIGKILL') } catch { /* only this owned helper is targeted */ }
    }
    signal.addEventListener('abort', cancel, { once: true })
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (settled) return
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += data.byteLength
      if (bytes > MAX_OUTPUT_BYTES) cancel()
      else chunks.push(data)
    })
    child.stderr?.resume()
    child.on('error', cancel)
    child.once('close', code => finish(code === 0 ? Buffer.concat(chunks).toString('utf8').trim() : '[]'))
    if (signal.aborted) cancel()
  })
}

const copy = (items: NativeMonitorMetrics[]): NativeMonitorMetrics[] => items.map(item => item.source === 'coregraphics'
  ? { ...item, boundsDip: { ...item.boundsDip } } : { ...item, boundsPx: { ...item.boundsPx } })

export class MobileMonitorScaleDetector {
  private generation = 0
  private cached?: { generation: number; at: number; value: NativeMonitorMetrics[] }
  private inFlight?: { generation: number; promise: Promise<NativeMonitorMetrics[]>; abort: AbortController }
  private readonly now: () => number
  constructor(private readonly deps: DetectorDependencies = {}) { this.now = deps.now ?? Date.now }

  invalidate(): void { this.generation++; this.cached = undefined; this.inFlight?.abort.abort() }

  async read(forceRefresh = false): Promise<NativeMonitorMetrics[]> {
    const platform = this.deps.platform ?? process.platform
    if (platform !== 'win32' && platform !== 'darwin') return []
    if (forceRefresh) this.invalidate()
    const generation = this.generation, now = this.now()
    if (this.cached?.generation === generation && now >= this.cached.at && now - this.cached.at < CACHE_MS) return copy(this.cached.value)
    if (this.inFlight?.generation === generation) return copy(await this.inFlight.promise)
    const abort = new AbortController()
    const promise = this.query(abort, platform).then(value => {
      if (this.generation !== generation) return []
      this.cached = { generation, at: this.now(), value }
      return value
    }).finally(() => { if (this.inFlight?.generation === generation) this.inFlight = undefined })
    this.inFlight = { generation, promise, abort }
    return copy(await promise)
  }

  private async query(abort: AbortController, platform: 'win32' | 'darwin'): Promise<NativeMonitorMetrics[]> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = Number.isFinite(this.deps.timeoutMs) ? Math.min(TIMEOUT_MS, Math.max(1, this.deps.timeoutMs!)) : TIMEOUT_MS
    let onAbort: () => void = () => undefined
    const cancelled = new Promise<string>(resolve => {
      onAbort = () => resolve('[]')
      abort.signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => abort.abort(), limit)
    })
    try {
      const output = await Promise.race([
        (this.deps.runHelper ? this.deps.runHelper(abort.signal) : runHelper(abort.signal, this.deps.spawnProcess ?? spawn, platform)).catch(() => '[]'), cancelled
      ])
      return platform === 'darwin' ? parseDarwinMonitorSamples(output) : parseMobileMonitorSamples(output)
    } catch { return [] } finally { clearTimeout(timer); abort.signal.removeEventListener('abort', onAbort) }
  }
}
