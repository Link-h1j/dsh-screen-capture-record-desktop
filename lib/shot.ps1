# Capture the whole virtual desktop (all monitors) into an image file.
#
# Called by the dsh-screen-capture-record-desktop host half. Kept as a separate script
# on purpose: the plugin's Node side never has to embed bitmap code, and the
# same file works from a shell when the button needs debugging.
#
# Why native pixels by default: the browser half uses this bitmap as a
# region-picker backdrop and crops the chosen rect out of it, so downscaling
# here would be baked into every crop. A 4K JPEG is ~1-2 MB, but it travels
# over loopback. Pass -MaxEdge 1440 for small recording frames.
#
# Why this exists at all: the Desktop (Electron) shell installs
#   setPermissionRequestHandler(cb => cb(false))
#   setDisplayMediaRequestHandler((_r, cb) => cb({}))
# so navigator.mediaDevices.getDisplayMedia() can NEVER produce a stream there.
# Capture has to happen in the host process.
#
# Pure ASCII -- Windows PowerShell 5.1 reads a BOM-less .ps1 as GBK, so a
# comment in Chinese here would corrupt the file's parse.

param(
  [Parameter(Mandatory = $true)][string]$OutPath,
  [int]$MaxEdge = 0,
  [int]$Quality = 88,
  [ValidateSet('jpg', 'png')][string]$Format = 'jpg'
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Without this the host process is DPI-unaware and Windows hands back a
# virtual-screen rect in scaled units, so a 150% display yields a blurry
# upscaled capture. Making the process DPI-aware first gives real pixels.
try {
  Add-Type -Namespace DshShot -Name Dpi -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetProcessDPIAware();
'@
  [void][DshShot.Dpi]::SetProcessDPIAware()
} catch {
  # Best effort: a non-DPI-aware capture is still useful.
}

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($vs.Width -le 0 -or $vs.Height -le 0) { throw 'virtual screen reported an empty rect' }

$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
} finally {
  $g.Dispose()
}

# Downscale only when an explicit cap is given; 0 (the default) keeps native
# pixels, which is what the region picker crops from.
$scale = 1.0
if ($MaxEdge -gt 0) {
  $scale = [Math]::Min(1.0, [Math]::Min($MaxEdge / $vs.Width, $MaxEdge / $vs.Height))
}
$out = $bmp
$scaled = $null
if ($scale -lt 1.0) {
  $w = [int][Math]::Round($vs.Width * $scale)
  $h = [int][Math]::Round($vs.Height * $scale)
  $scaled = New-Object System.Drawing.Bitmap($w, $h)
  $g2 = [System.Drawing.Graphics]::FromImage($scaled)
  try {
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g2.DrawImage($bmp, 0, 0, $w, $h)
  } finally {
    $g2.Dispose()
  }
  $out = $scaled
}

$dir = Split-Path -Parent $OutPath
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

try {
  if ($Format -eq 'png') {
    $out.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } else {
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
      Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    if (-not $codec) { throw 'JPEG encoder not available' }
    $eps = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $eps.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
      [System.Drawing.Imaging.Encoder]::Quality, [int64]$Quality)
    try {
      $out.Save($OutPath, $codec, $eps)
    } finally {
      $eps.Dispose()
    }
  }
} finally {
  if ($scaled) { $scaled.Dispose() }
  $bmp.Dispose()
}

if (-not (Test-Path $OutPath)) { throw "capture failed: $OutPath was not written" }
$bytes = (Get-Item $OutPath).Length
# Machine-readable line for the host half's log.
Write-Output ("captured {0}x{1} -> {2} ({3} bytes, {4})" -f $vs.Width, $vs.Height, $OutPath, $bytes, $Format)
