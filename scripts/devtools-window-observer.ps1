param([uint32]$TargetProcess, [long]$OwnerHandle)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class DevtoolsWindowObserver {
  public delegate bool EnumCallback(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback, IntPtr param);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  public static object Read(uint target, long owner) {
    uint ownerPid;
    GetWindowThreadProcessId((IntPtr)owner, out ownerPid);
    var root = GetAncestor((IntPtr)owner, 2).ToInt64();
    var handles = new List<long>();
    EnumWindows((hwnd, _) => {
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (pid == target && IsWindowVisible(hwnd)) handles.Add(hwnd.ToInt64());
      return true;
    }, IntPtr.Zero);
    var foreground = GetForegroundWindow().ToInt64();
    return new { foreground = foreground == owner || foreground == root ? "owner" : handles.Contains(foreground) ? "devtools" : "other-process",
      ownerExists = IsWindow((IntPtr)owner), ownerProcessMatches = ownerPid == target, ownerVisible = IsWindowVisible((IntPtr)owner), rootIsOwner = root == owner,
      order = handles.ConvertAll(hwnd => hwnd == owner || hwnd == root ? "owner" : "devtools").ToArray() };
  }
}
'@
[Console]::WriteLine('ready')
while ($null -ne ($query = [Console]::ReadLine())) {
  if ($query -eq 'owner') { [void][DevtoolsWindowObserver]::SetForegroundWindow([IntPtr]$OwnerHandle) }
  if ($query -eq 'quit') { break }
  [Console]::WriteLine(([DevtoolsWindowObserver]::Read($TargetProcess, $OwnerHandle) | ConvertTo-Json -Compress))
}
