foreach ($ep in @('/api/status', '/api/stats', '/api/diaries', '/api/diary/2026-09-24', '/api/diary/2026-09-20')) {
  try {
    $r = Invoke-WebRequest -Uri ("http://localhost:4399" + $ep) -UseBasicParsing -TimeoutSec 4
    "$ep -> " + $r.StatusCode
  } catch {
    "$ep -> ERR: " + $_.Exception.Message
  }
}
