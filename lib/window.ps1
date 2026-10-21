# dsh-screen-capture-record-desktop - hide/show the DSH desktop windows (Win32).
#
# Why this exists
# ---------------
# The screenshot overlay lives INSIDE the DSH desktop window, so it cannot make the
# DSH UI disappear from a screen capture by itself. The host process (the Electron
# main process child) instead calls this script right before lib/shot.ps1: hide every
# top-level DSH window, grab the screen, show them again. The screenshot then shows
# what was behind DSH instead of DSH itself.
#
# Window discovery: top-level windows owned by the DSH main process. The host passes
# its own parent pid (the Electron main process). As a fallback the script looks for
# a known process name with a main window (older/newer desktop shells).
#
# ASCII only (PowerShell 5.1 reads this file with the console code page - keep it pure
# ASCII like shot.ps1 / sources.ps1, otherwise Chinese text turns into mojibake).
#
# Output: exactly one JSON line on stdout, diagnostics go to stderr.
#   {"ok":true,"pid":55996,"count":2,"hwnds":[9308282,...]}
#   {"ok":true,"pid":55996,"windows":[{"hwnd":...,"visible":true,"iconic":false,"zoomed":true,"area":...}]}
#   {"ok":false,"error":"no-window"}
#
# Actions:
#   -Action state                 list candidate windows (no side effect)
#   -Action hide -OwnerPid N      hide every visible candidate window, return handles
#   -Action hide                  same, auto-detect the DSH process
#   -Action show -Hwnds a,b,c     show / restore the given handles
#
# NOTE: the parameter is -OwnerPid, not -Pid: $PID is a read-only automatic
# PowerShell variable (the current process id), so it cannot be reused as a name.
#
# SW_HIDE=0 (hide). For showing we must NOT use SW_SHOW here: this script is
# spawned by the host with CREATE_NO_WINDOW (windowsHide), and in that state the
# activating SW_SHOW silently does nothing to a window owned by another process
# (measured 2026-10-20: ShowWindow returned false, WS_VISIBLE stayed clear, the
# window never came back). SW_SHOWNA=8 (display without activating) works from
# such a process; foreground transfer is done separately with
# SetForegroundWindow. SW_MAXIMIZE=3 / SW_SHOWMINNOACTIVE=7 restore the previous
# maximized / minimized state that the hide step recorded.

param(
  [ValidateSet('state', 'hide', 'show')]
  [string]$Action = 'state',
  [int]$OwnerPid = 0,
  [string]$Hwnds = '',
  [string]$ZoomedHwnds = '',
  [string]$IconicHwnds = ''
)

$ErrorActionPreference = 'Stop'

$win32 = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DshWin
{
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder buffer, int maxCount);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public static List<IntPtr> All()
    {
        List<IntPtr> list = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            list.Add(hWnd);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static uint PidOf(IntPtr hWnd)
    {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        return pid;
    }

    public static string ClassOf(IntPtr hWnd)
    {
        StringBuilder buffer = new StringBuilder(256);
        GetClassName(hWnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    public static long AreaOf(IntPtr hWnd)
    {
        RECT rect;
        if (!GetWindowRect(hWnd, out rect)) return 0;
        long width = rect.Right - rect.Left;
        long height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0) return 0;
        return width * height;
    }
}
'@

function Write-Json([string]$text) {
  [Console]::Out.WriteLine($text)
  [Console]::Out.Flush()
}

function Resolve-DshPid([int]$wanted) {
  if ($wanted -gt 0) { return $wanted }
  $names = @('DeepSeek Harness', 'DSHdesktop', 'dsh-desktop', 'electron', 'Electron')
  foreach ($name in $names) {
    $procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
    foreach ($proc in $procs) {
      if ($proc.MainWindowHandle -ne 0) { return $proc.Id }
    }
  }
  return 0
}

function Get-Candidates([int]$ownerPid) {
  $list = New-Object System.Collections.ArrayList
  foreach ($handle in [DshWin]::All()) {
    $windowPid = [int]([DshWin]::PidOf($handle))
    if ($ownerPid -gt 0 -and $windowPid -ne $ownerPid) { continue }
    $cls = [DshWin]::ClassOf($handle)
    if (-not $cls.StartsWith('Chrome_WidgetWin_')) { continue }
    $area = [DshWin]::AreaOf($handle)
    if ($area -lt 20000) { continue }
    $item = New-Object psobject
    $item | Add-Member -NotePropertyName hwnd -NotePropertyValue ([int64]$handle.ToInt64())
    $item | Add-Member -NotePropertyName pid -NotePropertyValue $windowPid
    $item | Add-Member -NotePropertyName visible -NotePropertyValue ([DshWin]::IsWindowVisible($handle))
    $item | Add-Member -NotePropertyName iconic -NotePropertyValue ([DshWin]::IsIconic($handle))
    $item | Add-Member -NotePropertyName zoomed -NotePropertyValue ([DshWin]::IsZoomed($handle))
    $item | Add-Member -NotePropertyName area -NotePropertyValue $area
    [void]$list.Add($item)
  }
  return $list
}

function Format-HwndList($handles) {
  $parts = @()
  foreach ($h in $handles) { $parts += [string]$h }
  return '[' + ($parts -join ',') + ']'
}

try {
  Add-Type -TypeDefinition $win32 -Language CSharp | Out-Null
} catch {
  Write-Json '{"ok":false,"error":"add-type-failed"}'
  exit 1
}

try {
  # For hide/state the owner pid identifies the windows; for show with explicit
  # handles the pid is irrelevant (and auto-detection fails while every DSH window
  # is hidden, because MainWindowHandle becomes 0).
  $explicitShow = ($Action -eq 'show' -and $Hwnds -ne '')
  if ($explicitShow) {
    $ownerPid = 0
  } else {
    $ownerPid = Resolve-DshPid $OwnerPid
  }
  if ($ownerPid -le 0 -and -not $explicitShow) {
    Write-Json '{"ok":false,"error":"no-dsh-process"}'
    exit 0
  }

  if ($Action -eq 'state') {
    $candidates = @(Get-Candidates $ownerPid)
    $items = @()
    foreach ($item in $candidates) {
      $vis = 'false'
      if ($item.visible) { $vis = 'true' }
      $ico = 'false'
      if ($item.iconic) { $ico = 'true' }
      $zoo = 'false'
      if ($item.zoomed) { $zoo = 'true' }
      $items += '{"hwnd":' + $item.hwnd + ',"visible":' + $vis + ',"iconic":' + $ico + ',"zoomed":' + $zoo + ',"area":' + $item.area + '}'
    }
    Write-Json ('{"ok":true,"pid":' + $ownerPid + ',"windows":[' + ($items -join ',') + ']}')
    exit 0
  }

  if ($Action -eq 'hide') {
    $candidates = @(Get-Candidates $ownerPid)
    $hidden = @()
    $zoomedHidden = @()
    $iconicHidden = @()
    foreach ($item in $candidates) {
      if (-not $item.visible) { continue }
      $handle = [IntPtr]::new([int64]$item.hwnd)
      # ShowWindow returns the PREVIOUS visibility: true means it really was shown
      if ([DshWin]::ShowWindow($handle, 0)) {
        $hidden += $item.hwnd
        if ($item.zoomed) { $zoomedHidden += $item.hwnd }
        if ($item.iconic) { $iconicHidden += $item.hwnd }
      }
    }
    if ($hidden.Count -eq 0) {
      Write-Json '{"ok":false,"error":"no-window"}'
      exit 0
    }
    Write-Json ('{"ok":true,"pid":' + $ownerPid + ',"count":' + $hidden.Count +
      ',"hwnds":' + (Format-HwndList $hidden) +
      ',"zoomed":' + (Format-HwndList $zoomedHidden) +
      ',"iconic":' + (Format-HwndList $iconicHidden) + '}')
    exit 0
  }

  # show
  function Parse-HwndList([string]$text) {
    $out = @()
    if ($text -eq '') { return $out }
    foreach ($part in $text.Split(',')) {
      $trimmed = $part.Trim()
      if ($trimmed -eq '') { continue }
      $value = [int64]0
      if ([int64]::TryParse($trimmed, [ref]$value)) { $out += $value }
    }
    return $out
  }

  $handles = @(Parse-HwndList $Hwnds)
  if ($handles.Count -eq 0) {
    $candidates = @(Get-Candidates $ownerPid)
    foreach ($item in $candidates) { $handles += $item.hwnd }
  }
  $zoomedHandles = @(Parse-HwndList $ZoomedHwnds)
  $iconicHandles = @(Parse-HwndList $IconicHwnds)

  $shown = @()
  $visibleNow = 0
  $first = $true
  foreach ($value in $handles) {
    $handle = [IntPtr]::new([int64]$value)
    if (-not [DshWin]::IsWindow($handle)) { continue }
    if ($iconicHandles -contains $value) {
      # restore the minimized state it had before the hide
      [void][DshWin]::ShowWindow($handle, 7)
    } else {
      # SW_SHOWNA: display without activating (required from a CREATE_NO_WINDOW
      # child, see the header note). Fall back to SW_SHOW if it still did not show.
      [void][DshWin]::ShowWindow($handle, 8)
      if (-not [DshWin]::IsWindowVisible($handle)) { [void][DshWin]::ShowWindow($handle, 5) }
      if ($zoomedHandles -contains $value) { [void][DshWin]::ShowWindow($handle, 3) }
    }
    $shown += $value
    if ([DshWin]::IsWindowVisible($handle)) { $visibleNow += 1 }
    if ($first -and [DshWin]::IsWindowVisible($handle)) {
      [void][DshWin]::SetForegroundWindow($handle)
      $first = $false
    }
  }
  Write-Json ('{"ok":true,"pid":' + $ownerPid + ',"count":' + $shown.Count +
    ',"visible":' + $visibleNow + ',"hwnds":' + (Format-HwndList $shown) + '}')
  exit 0
} catch {
  Write-Json '{"ok":false,"error":"exception"}'
  exit 0
}
