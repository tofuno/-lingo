# =============================================================================
# Lingo Desk - desktop launcher
# -----------------------------------------------------------------------------
# Opens the dashboard in Edge "app mode" (--app=), which gives a standalone
# window with no address bar / tabs, i.e. it looks and behaves like a native app.
#
# Why not Electron? It needs ~400MB of deps and a build step. Edge app mode is
# already installed, starts instantly, and is a real window with its own taskbar
# entry. Swap in Electron later only if a true standalone .exe is required.
#
# Behaviour:
#   - if the local servers (8899/8900) are not up, starts them hidden
#   - waits for readiness, then opens the app window
#   - when the window closes, stops the servers ONLY if this script started them
# =============================================================================

$ErrorActionPreference = "Continue"

$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Url    = "http://127.0.0.1:8899/"
$Port   = 8899
$Edge   = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $Edge)) { $Edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe" }

function Test-AppPort([int]$p) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  return [bool]$c
}

function Stop-AppServers {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'start\.js|server\.js|proxy\.js' -and $_.CommandLine -notmatch 'mock-backend' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

$startedByUs = $false

if (-not (Test-AppPort $Port)) {
  if (-not (Test-Path (Join-Path $AppDir "start.js"))) {
    [System.Windows.Forms.MessageBox]::Show("start.js not found next to this script.") | Out-Null
    exit 1
  }
  Start-Process -FilePath "node" -ArgumentList "start.js" -WorkingDirectory $AppDir -WindowStyle Hidden
  $startedByUs = $true

  # wait up to 30s for the front end to listen
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-AppPort $Port) { break }
  }
}

if (-not (Test-AppPort $Port)) {
  Write-Host "Server did not come up on port $Port."
  exit 1
}

# Dedicated profile so the window is its own process (and our WaitForExit works
# instead of handing off to an already-running Edge).
$profileDir = Join-Path $env:LOCALAPPDATA "LingoDesk\edge-profile"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$edgeArgs = @(
  "--app=$Url",
  "--window-size=1440,920",
  "--user-data-dir=$profileDir",
  "--no-first-run",
  "--no-default-browser-check"
)

$proc = Start-Process -FilePath $Edge -ArgumentList $edgeArgs -PassThru

# Block until the app window is closed
try { $proc.WaitForExit() } catch { }

if ($startedByUs) { Stop-AppServers }
