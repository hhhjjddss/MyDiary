Write-Output "--- direct 4399 ---"
try {
  $a = Invoke-WebRequest -Uri 'http://localhost:4399/api/status' -UseBasicParsing -TimeoutSec 5
  Write-Output ("OK " + $a.StatusCode)
  Write-Output $a.Content
} catch {
  Write-Output ("ERR " + $_.Exception.Message)
}

Write-Output ""
Write-Output "--- proxy 5399/api/status ---"
try {
  $b = Invoke-WebRequest -Uri 'http://localhost:5399/api/status' -UseBasicParsing -TimeoutSec 5
  Write-Output ("OK " + $b.StatusCode)
  Write-Output $b.Content
} catch {
  Write-Output ("ERR " + $_.Exception.Message)
}

Write-Output ""
Write-Output "--- proxy 5399/api/diaries ---"
try {
  $c = Invoke-WebRequest -Uri 'http://localhost:5399/api/diaries' -UseBasicParsing -TimeoutSec 5
  Write-Output ("OK " + $c.StatusCode + " len=" + $c.Content.Length)
} catch {
  Write-Output ("ERR " + $_.Exception.Message)
}
