# Enumerate recordable sources: monitors, the whole virtual desktop, and top-level windows.
#
# Called by the dsh-screen-capture-record-desktop host half (GET .../sources).
# The browser half cannot enumerate monitors or windows, so this is the only way
# the "which one do you want to record?" picker can show real choices.
#
# Prints ONE JSON object on stdout (stderr is free for diagnostics):
#   { ok, virtual:{x,y,w,h}, monitors:[{index,primary,x,y,w,h,name}],
#     windows:[{handle,title,process,x,y,w,h,hwnd}], cursor:{x,y} }
#
# Coordinates are PHYSICAL virtual-desktop pixels -- the same space that
# recorder.py grabs from (it calls SetProcessDpiAwareness(2) too). Setting
# DPI awareness here first is what keeps the two in sync on a 150% display.
#
# Pure ASCII -- Windows PowerShell 5.1 reads a BOM-less .ps1 as GBK, so a
# comment in Chinese here would corrupt the file's parse.

param(
  [int]$MaxWindows = 80,
  [int]$MinWidth = 120,
  [int]$MinHeight = 80
)

$ErrorActionPreference = 'Stop'

# Redirected stdout is encoded with the console code page (GBK on a Chinese
# Windows) unless we say otherwise -- and ConvertTo-Json does NOT escape
# non-ASCII on PowerShell 5.1, so Chinese window titles arrive as mojibake
# ("截图中..." -> "��ͼ��..."). Force UTF-8 before anything is written.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

Add-Type -AssemblyName System.Windows.Forms

# Out: JSON with non-ASCII escaped (\uXXXX) -- PowerShell 5.1's ConvertTo-Json
# does that for us, which conveniently makes the payload ASCII-safe on stdout.
try {
  Add-Type -Namespace DshSrc -Name Dpi -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetProcessDPIAware();
'@
  [void][DshSrc.Dpi]::SetProcessDPIAware()
} catch {
  # Best effort: without it the rects are scaled by the display's DPI factor.
}

Add-Type -Namespace DshSrc -Name Win -MemberDefinition @'
public delegate bool EnumProc(System.IntPtr hWnd, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool EnumWindows(EnumProc lpEnumFunc, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindowVisible(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsIconic(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern int GetWindowTextW(System.IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT lpRect);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern int GetWindowLong(System.IntPtr hWnd, int nIndex);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern int GetSystemMetrics(int nIndex);
[System.Runtime.InteropServices.DllImport("dwmapi.dll")]
public static extern int DwmGetWindowAttribute(System.IntPtr hWnd, int attr, out RECT pvAttribute, int cbAttribute);
[System.Runtime.InteropServices.DllImport("dwmapi.dll")]
public static extern int DwmGetWindowAttributeInt(System.IntPtr hWnd, int attr, out int pvAttribute, int cbAttribute);
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

$GW_EXSTYLE = -20
$WS_EX_TOOLWINDOW = 0x00000080
$DWMWA_EXTENDED_FRAME_BOUNDS = 9
$DWMWA_CLOAKED = 14
$SM_XVIRTUALSCREEN = 76
$SM_YVIRTUALSCREEN = 77
$SM_CXVIRTUALSCREEN = 78
$SM_CYVIRTUALSCREEN = 79

$vx = [DshSrc.Win]::GetSystemMetrics($SM_XVIRTUALSCREEN)
$vy = [DshSrc.Win]::GetSystemMetrics($SM_YVIRTUALSCREEN)
$vw = [DshSrc.Win]::GetSystemMetrics($SM_CXVIRTUALSCREEN)
$vh = [DshSrc.Win]::GetSystemMetrics($SM_CYVIRTUALSCREEN)
if ($vw -le 0 -or $vh -le 0) {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $vx = $vs.X; $vy = $vs.Y; $vw = $vs.Width; $vh = $vs.Height
}
$vRight = $vx + $vw
$vBottom = $vy + $vh

# ---- monitors ----
$monitors = @()
$idx = 0
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  $b = $s.Bounds
  # Screen.Bounds is already virtual-desktop space; keep the raw values.
  $monitors += [pscustomobject]@{
    index = $idx
    primary = [bool]$s.Primary
    x = [int]$b.X
    y = [int]$b.Y
    w = [int]$b.Width
    h = [int]$b.Height
    name = [string]$s.DeviceName
  }
  $idx++
}
if ($monitors.Count -eq 0) {
  $monitors += [pscustomobject]@{ index = 0; primary = $true; x = $vx; y = $vy; w = $vw; h = $vh; name = 'DISPLAY' }
}

# ---- top-level windows (EnumWindows = top of the z-order first) ----
$handles = New-Object System.Collections.ArrayList
$callback = [DshSrc.Win+EnumProc]{
  param([System.IntPtr]$h, [System.IntPtr]$l)
  [void]$handles.Add($h)
  return $true
}
try { [void][DshSrc.Win]::EnumWindows($callback, [System.IntPtr]::Zero) } catch { }

$windows = @()
foreach ($h in $handles) {
  if ($windows.Count -ge $MaxWindows) { break }
  try {
    if (-not [DshSrc.Win]::IsWindowVisible($h)) { continue }
    if ([DshSrc.Win]::IsIconic($h)) { continue }

    $ex = [DshSrc.Win]::GetWindowLong($h, $GW_EXSTYLE)
    if (($ex -band $WS_EX_TOOLWINDOW) -ne 0) { continue }

    $cloaked = 0
    try {
      $hr = [DshSrc.Win]::DwmGetWindowAttributeInt($h, $DWMWA_CLOAKED, [ref]$cloaked, 4)
      if ($hr -eq 0 -and $cloaked -ne 0) { continue }
    } catch { }

    $sb = New-Object System.Text.StringBuilder 512
    [void][DshSrc.Win]::GetWindowTextW($h, $sb, 512)
    $title = $sb.ToString().Trim()
    if ([string]::IsNullOrWhiteSpace($title)) { continue }

    # Prefer the DWM frame bounds: GetWindowRect on a maximized/DWM window
    # includes the invisible resize border (a few px of black on every side).
    $r = New-Object DshSrc.Win+RECT
    $got = $false
    try {
      $hr = [DshSrc.Win]::DwmGetWindowAttribute($h, $DWMWA_EXTENDED_FRAME_BOUNDS, [ref]$r, 16)
      if ($hr -eq 0 -and ($r.Right -gt $r.Left)) { $got = $true }
    } catch { }
    if (-not $got) {
      if (-not [DshSrc.Win]::GetWindowRect($h, [ref]$r)) { continue }
    }

    $x = [int]$r.Left; $y = [int]$r.Top
    $w = [int]($r.Right - $r.Left); $hh = [int]($r.Bottom - $r.Top)
    if ($w -lt $MinWidth -or $hh -lt $MinHeight) { continue }

    # Clamp into the virtual desktop: a recording region has to live inside it.
    $cx1 = [Math]::Max($x, $vx); $cy1 = [Math]::Max($y, $vy)
    $cx2 = [Math]::Min($x + $w, $vRight); $cy2 = [Math]::Min($y + $hh, $vBottom)
    $cw = $cx2 - $cx1; $ch = $cy2 - $cy1
    if ($cw -lt $MinWidth -or $ch -lt $MinHeight) { continue }

    $procName = ''
    try {
      $pid32 = [uint32]0
      [void][DshSrc.Win]::GetWindowThreadProcessId($h, [ref]$pid32)
      if ($pid32 -gt 0) { $procName = [string](Get-Process -Id ([int]$pid32) -ErrorAction Stop).ProcessName }
    } catch { }

    $windows += [pscustomobject]@{
      title = $title
      process = $procName
      x = $cx1
      y = $cy1
      w = $cw
      h = $ch
      hwnd = [int64]$h
    }
  } catch {
    # A window can vanish mid-enumeration; skip it, never abort the whole list.
    continue
  }
}

$cursor = [pscustomobject]@{ x = 0; y = 0 }
try {
  $pt = [System.Windows.Forms.Cursor]::Position
  $cursor = [pscustomobject]@{ x = [int]$pt.X; y = [int]$pt.Y }
} catch { }

$payload = [pscustomobject]@{
  ok = $true
  virtual = [pscustomobject]@{ x = [int]$vx; y = [int]$vy; w = [int]$vw; h = [int]$vh }
  monitors = @($monitors)
  windows = @($windows)
  cursor = $cursor
}

# ConvertTo-Json escapes non-ASCII to \uXXXX, so this stays readable no matter
# what code page the redirected stdout uses.
$json = $payload | ConvertTo-Json -Depth 5 -Compress
Write-Output $json
