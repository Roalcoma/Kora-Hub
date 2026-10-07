# Genera los íconos PNG de la PWA (web/public/icons). Uso: powershell -File ops/make-icons.ps1
# Bloque naranja con sombra, desplazado sobre fondo marino, con un acento cian: profundidad y asimetría.
Add-Type -AssemblyName System.Drawing
$dir = Join-Path $PSScriptRoot '..\web\public\icons'
New-Item -ItemType Directory -Force $dir | Out-Null
$ink = [System.Drawing.ColorTranslator]::FromHtml('#13243D')
$orange = [System.Drawing.ColorTranslator]::FromHtml('#F69008')
$cta = [System.Drawing.ColorTranslator]::FromHtml('#60D0FA')

function New-Icon([int]$size, [string]$name, [double]$inset) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.FillRectangle((New-Object System.Drawing.SolidBrush $ink), 0, 0, $size, $size)
  $pad = [int]($size * $inset)
  $box = $size - 2 * $pad
  $off = [int]($box * 0.07)
  $shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(110, 0, 0, 0))
  $g.FillRectangle($shadow, $pad + $off, $pad + $off * 2, $box - $off, $box - $off)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush $cta), $pad + $box - $off * 2, $pad + $off * 2, $off, $box - $off * 3)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush $orange), $pad - $off / 2, $pad - $off / 2, $box - $off * 2, $box - $off * 2)
  $font = New-Object System.Drawing.Font 'Segoe UI', ([float]($box * 0.34)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Near'
  $fmt.LineAlignment = 'Far'
  $rect = New-Object System.Drawing.RectangleF ([float]($pad + $box * 0.06)), ([float]$pad), ([float]($box - $off * 2)), ([float]($box - $off * 2 - $box * 0.04))
  $g.DrawString('AH', $font, (New-Object System.Drawing.SolidBrush $ink), $rect, $fmt)
  $bmp.Save((Join-Path $dir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}

New-Icon 192 'icon-192.png' 0.14
New-Icon 512 'icon-512.png' 0.14
New-Icon 512 'maskable-512.png' 0.24   # zona segura del 80 % para íconos adaptables
New-Icon 180 'apple-touch-icon.png' 0.14

# Insignia monocroma (Android la usa en la barra de estado)
$b = New-Object System.Drawing.Bitmap 72, 72
$g = [System.Drawing.Graphics]::FromImage($b)
$g.FillRectangle([System.Drawing.Brushes]::White, 14, 14, 44, 44)
$b.Save((Join-Path $dir 'badge-72.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$b.Dispose()
Get-ChildItem $dir | Select-Object Name, Length
