<#
.SYNOPSIS  External health watchdog - emails IT when IDevelop stops answering.
.DESCRIPTION
    WinSW restarts a crashed service silently; nothing tells anyone when the
    app is DOWN (a down app cannot email about itself). This watchdog runs
    OUTSIDE the app as a Windows Scheduled Task (every 5 minutes): it probes
    /health and /readyz, and when probes fail N consecutive runs it sends ONE
    alert email through your SMTP relay (and one recovery email when the app
    comes back). State lives in ProgramData so the exactly-once behaviour
    survives reboots.

    Register (run once, as admin):
      schtasks /Create /TN "IDevelop-HealthWatchdog" /SC MINUTE /MO 5 /RU SYSTEM ^
        /TR "powershell -ExecutionPolicy Bypass -NoProfile -File \"C:\Program Files\IDevelop\scripts\Health-Watchdog.ps1\" -SmtpServer smtp.corp.local -To it-ops@corp.local -From idevelop@corp.local"

.PARAMETER Url        Health URL (default http://localhost:3000/health).
.PARAMETER ReadyUrl   Readiness URL (default http://localhost:3000/readyz).
.PARAMETER Threshold  Consecutive failures before alerting (default 2 -> ~10 min).
.PARAMETER SmtpServer / SmtpPort / To / From / SmtpUser / SmtpPass  Mail relay settings.
#>
[CmdletBinding()]
param(
    [string]$Url = 'http://localhost:3000/health',
    [string]$ReadyUrl = 'http://localhost:3000/readyz',
    [int]$Threshold = 2,
    [string]$SmtpServer,
    [int]$SmtpPort = 25,
    [string]$To,
    [string]$From = 'IDevelop Watchdog <noreply@localhost>',
    [string]$SmtpUser,
    [string]$SmtpPass
)

$ErrorActionPreference = 'Stop'
$stateDir = 'C:\ProgramData\IDevelop'
$stateFile = Join-Path $stateDir 'health-watchdog.state.json'
$logFile = Join-Path $stateDir 'health-watchdog.log'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

function Log($m) { "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m | Add-Content -Path $logFile -Encoding utf8 }

# ---- probe ----
$live = $false; $ready = $false; $detail = ''
try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 10
    $live = $r.StatusCode -eq 200
} catch { $detail = "health: $($_.Exception.Message)" }
if ($live) {
    try {
        $r2 = Invoke-WebRequest -Uri $ReadyUrl -UseBasicParsing -TimeoutSec 10
        $ready = $r2.StatusCode -eq 200
        if (-not $ready) { $detail = "readyz HTTP $($r2.StatusCode) (database down?)" }
    } catch { $detail = "readyz: $($_.Exception.Message) (database down?)" }
}
$healthy = $live -and $ready

# ---- state (exactly-once alerting across runs/reboots) ----
$state = @{ failures = 0; alerted = $false }
if (Test-Path $stateFile) {
    try { $j = Get-Content $stateFile -Raw | ConvertFrom-Json; $state.failures = [int]$j.failures; $state.alerted = [bool]$j.alerted } catch { }
}

function Send-Alert([string]$subject, [string]$body) {
    if (-not $SmtpServer -or -not $To) { Log "ALERT (no SMTP configured): $subject"; return }
    try {
        $p = @{ SmtpServer = $SmtpServer; Port = $SmtpPort; To = $To; From = $From; Subject = $subject; Body = $body }
        if ($SmtpUser) {
            $sec = ConvertTo-SecureString $SmtpPass -AsPlainText -Force
            $p.Credential = New-Object System.Management.Automation.PSCredential($SmtpUser, $sec)
        }
        Send-MailMessage @p
        Log "alert email sent: $subject"
    } catch { Log "alert email FAILED: $($_.Exception.Message)" }
}

if ($healthy) {
    if ($state.alerted) {
        Send-Alert '[IDevelop] RECOVERED - service is answering again' `
            ("The IDevelop health probes succeed again as of {0}.`nHost: {1}" -f (Get-Date), $env:COMPUTERNAME)
        Log 'recovered - recovery email sent'
    }
    $state = @{ failures = 0; alerted = $false }
} else {
    $state.failures++
    Log "probe FAILED ($($state.failures)/$Threshold): $detail"
    # Also surface the WinSW restart count - repeated restarts = crash-looping.
    $svcNote = ''
    try {
        $recent = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager'; StartTime = (Get-Date).AddHours(-1) } -ErrorAction SilentlyContinue |
            Where-Object { $_.Message -match 'IDevelop' } | Measure-Object
        if ($recent.Count -gt 0) { $svcNote = "`nService Control Manager events mentioning IDevelop in the last hour: $($recent.Count) (crash-looping?)" }
    } catch { }
    if ($state.failures -ge $Threshold -and -not $state.alerted) {
        Send-Alert '[IDevelop] DOWN - health probe failing' `
            ("IDevelop has failed {0} consecutive health probes.`nLast error: {1}`nHost: {2}`nTime: {3}{4}`n`nCheck: Get-Service IDevelop - logs under C:\Program Files\IDevelop\service\ - C:\ProgramData\IDevelop\logs" -f $state.failures, $detail, $env:COMPUTERNAME, (Get-Date), $svcNote)
        $state.alerted = $true
    }
}

$state | ConvertTo-Json | Set-Content -Path $stateFile -Encoding utf8
exit 0
