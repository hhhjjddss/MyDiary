# 生成开屏动画所需资源（都放在 public/，Vite 会原样拷进 dist/）
#   1) public/logo-256.png  整枚应用图标（白色圆角底板 + 黑色符号），清晰版
#   2) public/logo-mark.png 只保留符号的白色剪影（alpha 由亮度反推），用于泛光
Add-Type -AssemblyName System.Drawing

$root   = 'D:\codingProject\MyDiary'
$srcPath = Join-Path $root 'electron\logo-256.png'
$pubDir  = Join-Path $root 'public'
if (-not (Test-Path $pubDir)) { New-Item -ItemType Directory -Path $pubDir | Out-Null }

# 1) 高清整图
$iconOut = Join-Path $pubDir 'logo-256.png'
Copy-Item $srcPath $iconOut -Force

# 2) 符号剪影：底板是白色 -> alpha 0；符号是黑色 -> alpha 255
$src = [System.Drawing.Bitmap]::FromFile($srcPath)
$w = $src.Width
$h = $src.Height
$dst = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)

$rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
$lock = [System.Drawing.Imaging.ImageLockMode]
$fmt = [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
$sd = $src.LockBits($rect, $lock::ReadOnly, $fmt)
$dd = $dst.LockBits($rect, $lock::WriteOnly, $fmt)

$sb = [byte[]]::new($sd.Stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($sd.Scan0, $sb, 0, $sb.Length)
$db = [byte[]]::new($dd.Stride * $h)

$minX = $w; $minY = $h; $maxX = -1; $maxY = -1; $solid = 0
for ($y = 0; $y -lt $h; $y++) {
  $srow = $y * $sd.Stride
  $drow = $y * $dd.Stride
  for ($x = 0; $x -lt $w; $x++) {
    $o = $srow + $x * 4
    $b = $sb[$o]; $g = $sb[$o + 1]; $r = $sb[$o + 2]; $a = $sb[$o + 3]
    $lum = (0.299 * $r + 0.587 * $g + 0.114 * $b) / 255.0
    $na = [int][Math]::Round(255.0 * (1.0 - $lum) * ($a / 255.0))
    if ($na -lt 0) { $na = 0 } elseif ($na -gt 255) { $na = 255 }
    $d = $drow + $x * 4
    $db[$d] = 255; $db[$d + 1] = 255; $db[$d + 2] = 255; $db[$d + 3] = $na
    if ($na -gt 24) {
      $solid++
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
[System.Runtime.InteropServices.Marshal]::Copy($db, 0, $dd.Scan0, $db.Length)
$src.UnlockBits($sd)
$dst.UnlockBits($dd)

$markOut = Join-Path $pubDir 'logo-mark.png'
$dst.Save($markOut, [System.Drawing.Imaging.ImageFormat]::Png)
$dst.Dispose()
$src.Dispose()

Write-Host ("icon  -> " + $iconOut)
Write-Host ("mark  -> " + $markOut)
Write-Host ("mark bbox: x " + $minX + ".." + $maxX + "  y " + $minY + ".." + $maxY + "  solidPx=" + $solid)
