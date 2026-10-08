# 清理 MyDiary 的残留进程（占用 4399 / 5399 的进程）
$ports = @(4399, 5399)
$pids = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $ports -contains $_.LocalPort } |
  Select-Object -ExpandProperty OwningProcess -Unique

foreach ($pid2 in $pids) {
  try {
    Stop-Process -Id $pid2 -Force -ErrorAction Stop
    Write-Output ("killed PID " + $pid2)
  } catch {
    Write-Output ("skip PID " + $pid2)
  }
}

if (-not $pids) {
  Write-Output "no leftover process"
}
