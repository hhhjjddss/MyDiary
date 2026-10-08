$ErrorActionPreference = 'Continue'
"=== direct 4399 /api/diary/2026-09-24 ==="
try {
  $r = Invoke-WebRequest -Uri 'http://localhost:4399/api/diary/2026-09-24' -UseBasicParsing -TimeoutSec 5
  "STATUS: " + $r.StatusCode
  "BODY: " + $r.Content.Substring(0, [Math]::Min(300, $r.Content.Length))
} catch {
  "ERR: " + $_.Exception.Message
}
"=== via proxy 5399 ==="
try {
  $p = Invoke-WebRequest -Uri 'http://localhost:5399/api/diary/2026-09-24' -UseBasicParsing -TimeoutSec 5
  "STATUS: " + $p.StatusCode
  "BODY: " + $p.Content.Substring(0, [Math]::Min(300, $p.Content.Length))
} catch {
  "ERR: " + $_.Exception.Message
}
