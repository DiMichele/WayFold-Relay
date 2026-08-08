$ErrorActionPreference = "Stop"
$OfflineDir = Split-Path -Parent $PSScriptRoot
$Root = Split-Path -Parent $OfflineDir
$Dist = Join-Path $Root "dist"
$NodeLocal = Join-Path $Root "node\node.exe"
$Serve = Join-Path $OfflineDir "serve.mjs"

if (-not (Test-Path $Dist)) {
  Write-Host "ERRORE: cartella dist mancante. Estrai tutto lo zip." -ForegroundColor Red
  exit 1
}

$node = $null
if (Test-Path $NodeLocal) { $node = $NodeLocal }
else {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source }
}

if (-not $node) {
  Write-Host "ERRORE: Node.js non trovato." -ForegroundColor Red
  Write-Host "Usa la cartella node inclusa nello zip oppure installa Node 18+." -ForegroundColor Yellow
  exit 1
}

Write-Host "Avvio server HTTPS (porta 8443)..." -ForegroundColor Cyan
& $node $Serve $Dist
