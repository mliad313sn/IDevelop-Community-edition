<#
.SYNOPSIS
    IDevelop - PostgreSQL installer for Windows 11 / Server 2019 / 2022 (and newer).

.DESCRIPTION
    Stands up the whole stack on a machine where only the OS is present, and is
    idempotent (each component is reused if already working):
      - Visual C++ Redistributable (x64) - PostgreSQL + native node modules need it
      - Node.js  (installed silently only if missing / too old)
      - PostgreSQL (installed unattended only if NO instance is found; an existing
                    local OR remote instance is detected and reused)
      - Application database + role + extensions + privileges (PG 15+ aware)
      - Application files, .env (secrets auto-generated), production npm install,
        schema migrations + seed
      - A Windows auto-start service (Scheduled Task as SYSTEM, restart-on-failure)
      - Firewall rule for the app port + health check
      - Self-healing upgrades: an upgrade / patch of an existing install backs up
        the running version and AUTOMATICALLY rolls back to it (restoring the code
        and restarting the service) if the new version fails to deploy or fails its
        health check — so a bad release never leaves the box down (opt out: -NoRollback)

    This rebuild focuses on PostgreSQL correctness:
      * real connectivity preflight before any DB work (fails fast, clear message)
      * proper grants for PostgreSQL 15+ (schema ownership + default privileges)
      * full stdout/stderr of npm / migrate / seed captured to the log (no more
        opaque "exit 1")
      * optional SSL for remote / managed PostgreSQL (PG_SSL in .env)
      * .env and node_modules never clobbered by the file copy

.PARAMETER InstallDir         Override install location.
.PARAMETER AppPort            Override HTTP port.
.PARAMETER UseExistingPostgres   Force "reuse existing PG" mode (never install PG).
.PARAMETER PgHost / PgPort    Target an existing PostgreSQL host/port.
.PARAMETER PgSuperPassword    Superuser (postgres) password - REQUIRED when reusing
                              an instance; SET as the new password on a fresh install.
.PARAMETER PgSsl              Connect to PostgreSQL over TLS (managed / remote PG).
.PARAMETER SkipFirewall       Don't create the firewall rule.
.PARAMETER NoService          Deploy + configure DB but don't register/start the service.
.PARAMETER ServiceMode        How to host the app: 'Service' (a real Windows service via the
                              WinSW wrapper - shows in services.msc / Get-Service), 'ScheduledTask'
                              (a SYSTEM startup task, no extra binary), or 'Auto' (default: prefer a
                              real service, fall back to a task only if WinSW can't be obtained).
                              Overrides config.psd1's ServiceMode.
.PARAMETER UseScheduledTask   Shortcut for -ServiceMode ScheduledTask (keep the legacy task host).
.PARAMETER Repair             Repair an existing / partial install: re-validate every
                              component, regenerate a broken .env, force a clean
                              dependency rebuild, re-apply migrations (idempotent),
                              and re-register the service. The database is never dropped.
.PARAMETER ForceDeps          Force a clean rebuild of node_modules (without full -Repair).
.PARAMETER Patch              Patch / upgrade an existing install in place: update code,
                              install new deps, apply pending migrations, restart the
                              service. Preserves .env, the database and all data; backs
                              up the current code first. Fails if no install exists.
.PARAMETER MigrateServiceAccount  Upgrade: move the service from LocalSystem to its virtual
                              account NT SERVICE\<ServiceName> once the upgrade is healthy
                              (re-ACL + restart + health check; automatic return to
                              LocalSystem if it is not healthy). A new install gets the
                              virtual account by default.
.PARAMETER EnableAuditOwnerSeparation  Turn on audit-trail ownership separation (off by
                              default: four SuperAdmin tools are refused while it is on).
.PARAMETER ApplyPgHardening   Apply the recommended PostgreSQL hardening on a server this
                              installer did not create (otherwise: report it, and ask
                              when a console is attached). Applied automatically on a
                              server Setup created.
.PARAMETER EnforceManifest    Move the files of the install directory that the release
                              manifest does not list (customer folders excluded) to
                              %ProgramData%\IDevelop\app-backups\retired-<stamp>\.
                              Never deletes. Default: report them only.
.PARAMETER SkipPreMigrationDump  Upgrade of an existing install: do NOT take the encrypted,
                              verified database dump that otherwise precedes the
                              migrations (%ProgramData%\IDevelop\backups\pre-upgrade-*).
                              For a very large database that has its own verified
                              backup only. Logged as a WARN. Default: the dump is taken,
                              and a failed dump stops the run before any migration.
.PARAMETER NoRollback         Disable the automatic restore-on-failure safety net. By
                              default, when patching / upgrading an EXISTING install,
                              the installer backs up the running version first and — if
                              the new version fails to deploy or fails its health check —
                              AUTOMATICALLY restores that backup and restarts the service,
                              so the machine is never left on a broken build. Pass this to
                              opt out and leave the failed new version in place for
                              inspection (the backup is still kept).

.EXAMPLE
    # Fresh machine - installs everything:
    powershell -ExecutionPolicy Bypass -File .\Install-IDevelop.ps1 -PgSuperPassword 'StrongPgPass!'

.EXAMPLE
    # Reuse an existing / remote PostgreSQL over SSL:
    .\Install-IDevelop.ps1 -UseExistingPostgres -PgHost db.internal -PgPort 5432 -PgSsl -PgSuperPassword 'theRealPostgresPass'

.EXAMPLE
    # Patch an existing install to this version (keeps the DB, data and .env):
    .\Install-IDevelop.ps1 -Patch -UseExistingPostgres -PgSuperPassword 'theRealPostgresPass'

.EXAMPLE
    # Repair a broken / partial installation (keeps the database and any changed admin password):
    .\Install-IDevelop.ps1 -Repair -PgSuperPassword 'theRealPostgresPass'
#>
[CmdletBinding()]
param(
    [string]$InstallDir,
    [int]$AppPort,
    [switch]$UseExistingPostgres,
    [string]$PgHost,
    [int]$PgPort,
    [string]$PgSuperPassword,
    [switch]$PgSsl,
    [switch]$SkipFirewall,
    [switch]$NoService,
    # How to host the app as a background auto-start process. 'Service' = a real
    # Windows service (WinSW wrapper); 'ScheduledTask' = SYSTEM startup task;
    # 'Auto' = prefer a real service, fall back to a task if WinSW is unavailable.
    [ValidateSet('Auto', 'Service', 'ScheduledTask')]
    [string]$ServiceMode,
    # Convenience alias for -ServiceMode ScheduledTask.
    [switch]$UseScheduledTask,
    # Repair an existing / partial install: re-validates every component,
    # forces a clean dependency reinstall, re-applies migrations, regenerates a
    # broken .env, and re-registers the service. Never drops the database.
    [switch]$Repair,
    # Force a clean rebuild of node_modules even outside -Repair.
    [switch]$ForceDeps,
    # Patch / upgrade an EXISTING install: refresh the application code, install any
    # new dependencies, apply pending migrations (idempotent) and restart the
    # service - while PRESERVING .env, node_modules, the database and ALL data.
    # The current app code is backed up first (rollback). Requires an existing
    # install (fails fast otherwise) and never imports the bundled data snapshot.
    [switch]$Patch,
    # MIGRATE MODE: bring an OLDER installed version up to this package, end to end.
    # = -Patch (code refresh, migrations, service restart; DB/data/.env preserved)
    # plus a pre-flight report of every pending migration, a DOWNGRADE guard (a
    # database produced by a newer version is refused before anything runs), a
    # post-flight proof that nothing is left pending, and a from→to report.
    # Compatible with every future package by construction: migrations are
    # numbered, idempotent and tracked in schema_meta, so any newer package
    # applies exactly the files this database has not seen yet.
    [switch]$Migrate,
    # Disable the automatic restore-on-failure safety net. By default, an upgrade /
    # patch of an EXISTING install that fails to deploy or fails its post-deploy
    # health check is AUTOMATICALLY rolled back to the pre-upgrade backup and the
    # service is restarted on the previous version. -NoRollback leaves the failed
    # build in place (the backup is still kept) for inspection.
    [switch]$NoRollback,
    # Console-only progress: no graphical progress window. The window (an
    # Office-style "Installing IDevelop..." bar with a details log and an
    # end screen) opens by default on an interactive desktop; pass -NoGui for
    # unattended / scripted runs, where nobody is there to press Close.
    [switch]$NoGui,
    # Full setup wizard instead of a progress-only window: a Welcome page that
    # states what setup is about to do, where it goes and which version replaces
    # which (plus Options), then the licence with an explicit "I accept", then
    # progress, then the finish page. Nothing on the machine is touched until
    # the person presses the action button; Cancel exits 1602. This is what the
    # .exe launches - Setup.bat's own menu has already taken the decision, so it
    # does not pass it.
    [switch]$Wizard,
    # With the window: close the end screen by itself after N seconds (0 = wait
    # for Close). Lets a scripted run still show the window without blocking.
    [int]$GuiAutoClose = 0,
    # App-ONLY patch: refresh the application code and restart, but do NOT run
    # database migrations (no schema/data changes at all). Use with -Patch for a
    # pure code hotfix. Without this flag, -Patch also applies pending migrations
    # (the "upgrade" path, where new DB info can be introduced).
    [switch]$SkipMigrations,
    # Full reinstall: replace an existing instance with a brand-new one AND a fresh
    # database loaded from the bundled snapshot. Unlike a normal (data-preserving)
    # install, this FORCES a drop+recreate+import of the database even when it
    # already holds data. The pre-existing code + database are backed up first.
    [switch]$Reinstall,
    # Unattended data-loss confirmation: skip the interactive "type the employee
    # count to confirm" guard that a -Reinstall triggers when the target database
    # still holds real employee data. Pass this ONLY for automated/headless runs
    # that genuinely intend to destroy and recreate a test instance.
    [switch]$ConfirmDataLoss,
    # Allow the forgotten-password recovery of a LOCAL PostgreSQL, which opens a
    # temporary pg_hba.conf 'trust' window on loopback (~10 s, database and user
    # 'postgres' only) to reset the 'postgres' password. Without it an unattended
    # run FAILS with a clear message and an interactive run ASKS; every use is
    # written to %ProgramData%\IDevelop\logs\pg-trust-window.log.
    [switch]$AllowPasswordRecovery,
    # Switch an EXISTING service from LocalSystem to its least-privilege virtual
    # account NT SERVICE\<ServiceName>. Done AFTER the upgrade is healthy: every
    # data folder is re-ACLed for the account, the service is restarted as it, and
    # put back on LocalSystem automatically if it does not come up healthy. (A new
    # install gets the virtual account by default; an upgrade is never forced.)
    [switch]$MigrateServiceAccount,
    # Turn on audit-trail ownership separation (off by default). Four SuperAdmin
    # tools are then refused (see config.psd1 AuditOwnerSeparation).
    [switch]$EnableAuditOwnerSeparation,
    # Apply the recommended PostgreSQL hardening on a server this installer did
    # NOT create, without asking (unattended consent). Without it: report + ask.
    [switch]$ApplyPgHardening,
    # ENFORCE the release manifest: files in the install dir that the package does
    # not list are MOVED (never deleted) to app-backups\retired-<stamp>\.
    # Without it the unknown files are only reported.
    [switch]$EnforceManifest,
    # Do NOT take the encrypted pre-migration database dump of an upgrade (a very
    # large database with its own verified backup only). Logged as a WARN.
    [switch]$SkipPreMigrationDump
)

$ErrorActionPreference = 'Stop'
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# The postgres superuser password may also arrive through the ENVIRONMENT
# (SETUP_PG_SUPER_PASSWORD) instead of -PgSuperPassword. Every launcher (Setup.bat,
# Setup-Wizard, Maintain, Deploy-OneShot) uses that channel now, for two reasons
# measured on the appliance: a command-line argument is copied verbatim into the
# "Host Application:" header of every PowerShell transcript (46 install
# transcripts under %ProgramData% carried the password, readable by any local
# user), and cmd.exe's delayed expansion eats every '!' of a value it expands
# on a line (the standard password contains one). A child process inherits the
# variable without either the shell or the transcript ever seeing its value.
if (-not $PgSuperPassword -and $env:SETUP_PG_SUPER_PASSWORD) {
    $PgSuperPassword = $env:SETUP_PG_SUPER_PASSWORD
    $script:PgPwFromEnv = $true
}

# Custom exception so the top-level handler can distinguish a controlled Fail
# (a known, reported problem) from an unexpected crash.
class InstallerError : System.Exception {
    InstallerError([string]$m) : base($m) {}
}

# ---------------------------------------------------------------------------
# Elevation: relaunch as administrator if needed.
# ---------------------------------------------------------------------------
$wid = [Security.Principal.WindowsIdentity]::GetCurrent()
$prp = New-Object Security.Principal.WindowsPrincipal($wid)
if (-not $prp.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host ''
    Write-Host '  Administrator rights are required to install IDevelop.' -ForegroundColor Yellow
    Write-Host '  A new elevated PowerShell window will open now - watch THAT window' -ForegroundColor Yellow
    Write-Host '  for progress. You may close this one. (Approve the UAC prompt.)' -ForegroundColor Yellow
    Write-Host ''
    Start-Sleep -Seconds 1
    # Forward the ORIGINAL parameters. $MyInvocation.UnboundArguments is EMPTY for a
    # script with a param block - everything is bound - so the elevated copy used to
    # start with NO arguments: '-Patch -SkipMigrations' silently became a full
    # INSTALL/UPGRADE run. Idempotent migrations hid it, but the intent was ignored.
    $fwd = @()
    foreach ($kv in $PSBoundParameters.GetEnumerator()) {
        # The secret never goes back onto a command line (it would land in the
        # elevated run's transcript header): the child inherits it as an
        # environment variable instead.
        if ($kv.Key -eq 'PgSuperPassword') { continue }
        if ($kv.Value -is [switch]) {
            if ($kv.Value.IsPresent) { $fwd += "-$($kv.Key)" }
        } else {
            $fwd += "-$($kv.Key)"
            $fwd += '"{0}"' -f ("$($kv.Value)" -replace '"', '\"')
        }
    }
    if ($PgSuperPassword) { $env:SETUP_PG_SUPER_PASSWORD = $PgSuperPassword }
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$($MyInvocation.MyCommand.Path)`"") + $fwd
    try {
        # -Wait + real exit code so a caller can distinguish success from failure.
        $child = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList -Wait -PassThru
        exit $child.ExitCode
    } catch {
        Write-Host '  Elevation was cancelled or failed. Re-run PowerShell as Administrator and try again.' -ForegroundColor Red
        Read-Host '  Press Enter to close'
        exit 1
    }
}

# ---------------------------------------------------------------------------
# Config + logging
# ---------------------------------------------------------------------------
$cfg = Import-PowerShellDataFile -Path (Join-Path $ScriptRoot 'config.psd1')
if ($InstallDir)      { $cfg.InstallDir = $InstallDir }
if ($AppPort)         { $cfg.AppPort = $AppPort }
if ($PgHost)          { $cfg.PgHost = $PgHost }
if ($PgPort)          { $cfg.PgPort = $PgPort }
if ($PgSuperPassword) { $cfg.PgSuperPassword = $PgSuperPassword }
if ($PgSsl)           { $cfg.PgSsl = $true }
# Resolve the effective service host: -UseScheduledTask wins, then -ServiceMode,
# then config, defaulting to 'Auto' (prefer a real Windows service).
if ($UseScheduledTask) { $cfg.ServiceMode = 'ScheduledTask' }
elseif ($ServiceMode)  { $cfg.ServiceMode = $ServiceMode }
if (-not $cfg.ServiceMode) { $cfg.ServiceMode = 'Auto' }

$LogDir  = Join-Path $env:ProgramData 'IDevelop'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$stamp        = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogFile      = Join-Path $LogDir ('install-{0}.log' -f $stamp)
$SummaryFile  = Join-Path $LogDir ('install-{0}.summary.txt' -f $stamp)

# TRANSCRIPTS ARE NOT ORDINARY LOGS. Start-Transcript writes the full command
# line into its "Host Application:" header, and %ProgramData%\IDevelop is
# readable by BUILTIN\Users (measured: 46 transcripts on the appliance carried
# -PgSuperPassword <value>). So: (1) transcripts live in a sub-folder whose ACL
# is cut down to Administrators + SYSTEM before the first byte is written, and
# (2) the launchers pass the password through the environment, so the header
# has nothing to leak. Best-effort: never let logging break the run.
$TranscriptDir = Join-Path $LogDir 'transcripts'
$Transcript    = Join-Path $TranscriptDir ('install-{0}.transcript.log' -f $stamp)
function Protect-TranscriptDir([string]$dir) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    # SIDs, not names: 'Administrators' is localised on a French appliance.
    & icacls.exe $dir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' *> $null
    return ($LASTEXITCODE -eq 0)
}
# Earlier versions wrote the transcript next to the log. Redact the header of
# every one still there and move it under the protected folder - a deploy is
# the only moment an administrator is guaranteed to be at the keyboard.
function Move-LegacyTranscripts([string]$from, [string]$to) {
    $moved = 0
    foreach ($f in (Get-ChildItem -LiteralPath $from -File -Filter 'install-*.transcript.log' -ErrorAction SilentlyContinue)) {
        try {
            $t = [System.IO.File]::ReadAllText($f.FullName)
            $t = [regex]::Replace($t, '(-PgSuperPassword[:\s]+)("[^"]*"|''[^'']*''|\S+)', '${1}***redacted***')
            [System.IO.File]::WriteAllText((Join-Path $to $f.Name), $t)
            Remove-Item -LiteralPath $f.FullName -Force
            $moved++
        } catch {}
    }
    return $moved
}
$script:TranscriptDirProtected = $false
try {
    $script:TranscriptDirProtected = Protect-TranscriptDir $TranscriptDir
    $script:LegacyTranscriptsMoved = Move-LegacyTranscripts $LogDir $TranscriptDir
} catch { $script:LegacyTranscriptsMoved = 0 }
try {
    if (-not $script:TranscriptDirProtected) { throw 'transcript folder ACL could not be restricted' }
    Start-Transcript -Path $Transcript -Append -ErrorAction Stop | Out-Null; $script:TranscriptOn = $true
} catch { $script:TranscriptOn = $false }

# Per-step result ledger for the machine-readable summary at the end.
$script:StepResults = [System.Collections.Generic.List[object]]::new()
function Record-Step {
    param([int]$Number, [string]$Name, [string]$Status, [string]$Detail = '')
    $script:StepResults.Add([pscustomobject]@{ Step = $Number; Name = $Name; Status = $Status; Detail = $Detail })
}

# Progress state - drives the on-screen progress bar and the window title so the
# user always sees what stage we're on, even at a glance.
$script:TotalSteps  = 7
$script:CurrentStep = 0
$script:CurrentName = 'Starting'

function Set-Step {
    param([int]$Number, [string]$Name)
    # Mark the previous step as completed (if it wasn't already failed) before moving on.
    if ($script:CurrentStep -gt 0 -and -not ($script:StepResults | Where-Object { $_.Step -eq $script:CurrentStep })) {
        Record-Step $script:CurrentStep $script:CurrentName 'OK'
    }
    $script:CurrentStep = $Number
    $script:CurrentName = $Name
    $pct = [int](($Number / [double]$script:TotalSteps) * 100)
    # Progress window (when open) - it reads these fields on its own thread.
    if ($script:Gui) { try { $script:Gui.Sync.Step = $Number; $script:Gui.Sync.StepName = $Name } catch {} }
    # Progress bar pinned at the top of the console.
    Write-Progress -Id 1 -Activity 'IDevelop installation' `
        -Status ("Step {0}/{1}: {2}" -f $Number, $script:TotalSteps, $Name) -PercentComplete $pct
    # Window title - visible in the taskbar / Alt-Tab even when minimized.
    try { $Host.UI.RawUI.WindowTitle = "IDevelop install - Step $Number/$($script:TotalSteps): $Name" } catch {}
}

function Log {
    param([string]$Msg, [string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'HH:mm:ss'), $Level, $Msg
    $color = switch ($Level) { 'ERROR' { 'Red' } 'WARN' { 'Yellow' } 'OK' { 'Green' } 'STEP' { 'Cyan' } default { 'Gray' } }
    Write-Host $line -ForegroundColor $color
    Add-Content -Path $LogFile -Value $line
    # Progress window: every line feeds the details log; the notable ones
    # become the sentence under the step name.
    if ($script:Gui) {
        try {
            [void]$script:Gui.Sync.Lines.Add($line)
            if ($Level -in 'STEP', 'OK', 'WARN', 'ERROR') { $script:Gui.Sync.Detail = $Msg }
        } catch {}
    }
    # Surface live sub-status under the progress bar without changing the step.
    if ($Level -in 'STEP', 'OK', 'WARN', 'ERROR') {
        $pct = [int](($script:CurrentStep / [double]$script:TotalSteps) * 100)
        try {
            Write-Progress -Id 1 -Activity 'IDevelop installation' `
                -Status ("Step {0}/{1}: {2}" -f $script:CurrentStep, $script:TotalSteps, $script:CurrentName) `
                -CurrentOperation $Msg -PercentComplete $pct
        } catch {}
    }
}

# Fail records the failing step, then throws so the single top-level handler can
# show the banner + pause, guaranteeing the window never just disappears.
function Fail($m) {
    Log $m 'ERROR'
    Record-Step $script:CurrentStep $script:CurrentName 'FAILED' $m
    throw [InstallerError]::new($m)
}

# ---------------------------------------------------------------------------
# DATA-AT-REST ACLs (3.23.17, S-01). Measured on the appliance: the live .env
# (DATABASE_URL password, SESSION_SECRET, APP_KEY), every daily pg_dump under
# %ProgramData%\IDevelop\backups and the .env copies under app-backups were
# readable by BUILTIN\Users, and the ProgramData tree was even writable by them
# (inherited WD,AD). Only the transcripts folder was protected. Each target is
# now cut down to SYSTEM + Administrators; the service runs as LocalSystem, so
# it keeps full control. SIDs, not names ('Administrateurs' on a French box).
# Idempotent: a target whose ACL is already protected and holds only those two
# SIDs is left alone, so the (large) app-backups tree is walked once, not on
# every patch. Never fatal: a failure is logged as WARN and the run goes on.
# ---------------------------------------------------------------------------
# + OWNER RIGHTS (S-1-3-4): the app itself closes the folders and files it writes
# (audit-anchors, the backup keyring, the database dumps) to SYSTEM + Administrators
# + OWNER RIGHTS. OWNER RIGHTS is only ever the creator, never a group, so a folder
# the app restricted that way IS hardened; without it audit-anchors read 'PARTIAL',
# was re-walked on every patch and refused -MigrateServiceAccount.
$script:HardenedAclSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-3-4')
# 3.23.18 (S-04): with ServiceAccount = 'Virtual' the service runs as its virtual
# account NT SERVICE\<ServiceName>. That SID is then ALSO granted on the data
# folders (Modify), the .env file (Read) and the code (ReadAndExecute only) -
# see Get-AppAclTargets. $null = LocalSystem (nothing extra). RevokeAclSids:
# removed on sight - the virtual SID after a switch back to LocalSystem.
$script:ServiceAclSid = $null
$script:RevokeAclSids = @()

# The per-service SID Windows derives from the service NAME alone: S-1-5-80-
# followed by the SHA-1 of the upper-cased name (UTF-16LE) read as five
# little-endian DWORDs - the value 'sc.exe showsid <name>' prints. Computable
# before the service exists, so the ACLs can be laid before it is registered.
function Get-ServiceSid([string]$Name) {
    $sha = [System.Security.Cryptography.SHA1]::Create()
    try { $h = $sha.ComputeHash([System.Text.Encoding]::Unicode.GetBytes($Name.ToUpperInvariant())) } finally { $sha.Dispose() }
    $parts = @(); for ($i = 0; $i -lt 20; $i += 4) { $parts += [BitConverter]::ToUInt32($h, $i) }
    return 'S-1-5-80-' + ($parts -join '-')
}
# config.psd1 ServiceAccount -> @{ Mode = LocalSystem | Virtual | Custom; Account; Sid }.
# 'Virtual' (or the literal 'NT SERVICE\<ServiceName>') = the virtual account.
function Resolve-ServiceAccount($Configured, [string]$ServiceName) {
    $v = "$Configured".Trim()
    $virtualName = "NT SERVICE\$ServiceName"
    if ($v -eq 'Virtual' -or $v -eq $virtualName) {
        return [pscustomobject]@{ Mode = 'Virtual'; Account = $virtualName; Sid = (Get-ServiceSid $ServiceName) }
    }
    if (-not $v -or $v -eq 'LocalSystem') { return [pscustomobject]@{ Mode = 'LocalSystem'; Account = 'LocalSystem'; Sid = $null } }
    return [pscustomobject]@{ Mode = 'Custom'; Account = $v; Sid = $null }
}
# $WithService = $false: the service account must NOT be on this target (a folder
# it is never granted, such as the code backups): its ACE then fails the check.
function Test-AclHardened([string]$Path, [bool]$WithService = $true) {
    try {
        $svc = if ($WithService) { @(@($script:ServiceAclSid) | Where-Object { $_ }) } else { @() }
        $allowed = @($script:HardenedAclSids) + $svc
        $seen = @()
        $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
        if (-not $acl.AreAccessRulesProtected) { return $false }
        foreach ($r in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
            if ($allowed -notcontains $r.IdentityReference.Value) { return $false }
            $seen += $r.IdentityReference.Value
        }
        # The service account must actually HOLD its grant, not merely be allowed one.
        if ($svc.Count -and ($seen -notcontains $script:ServiceAclSid)) { return $false }
        return $true
    } catch { return $false }
}
# Grant / revoke the virtual service account's ACE through .NET, NOT icacls:
# icacls refuses a SID it cannot map to a name (error 1332), and NT SERVICE\<name>
# only maps once the service exists - the data folders are hardened BEFORE the
# service is registered. $Grant: '' = revoke only, or a FileSystemRights name
# ('Modify' / 'ReadAndExecute' inherited by children on a folder, 'Read' on a
# file). EXACTLY that right is left: a broader ACE an older release laid (Modify
# on the install root or on the WinSW folder) is replaced, not kept because it
# "includes" the new one. Writes only when something changes. Returns $true / $false.
function Set-ServiceSidAce([string]$Path, [bool]$IsDir, [string]$Grant) {
    try {
        $sec = if ($IsDir) { New-Object System.Security.AccessControl.DirectorySecurity($Path, [System.Security.AccessControl.AccessControlSections]::Access) }
               else { New-Object System.Security.AccessControl.FileSecurity($Path, [System.Security.AccessControl.AccessControlSections]::Access) }
        $rules = @($sec.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))
        $changed = $false
        foreach ($s in @(@($script:RevokeAclSids) | Where-Object { $_ })) {
            if (@($rules | Where-Object { $_.IdentityReference.Value -eq $s }).Count) {
                $sec.PurgeAccessRules((New-Object System.Security.Principal.SecurityIdentifier($s))); $changed = $true
            }
        }
        if ($Grant -and $script:ServiceAclSid) {
            $sid = New-Object System.Security.Principal.SecurityIdentifier($script:ServiceAclSid)
            $right = [System.Security.AccessControl.FileSystemRights]$Grant
            $inhF = if ($IsDir) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
            $want = [int]$right; $sync = [int][System.Security.AccessControl.FileSystemRights]::Synchronize
            $mine = @($rules | Where-Object { $_.IdentityReference.Value -eq $script:ServiceAclSid })
            $exact = @($mine | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.InheritanceFlags -eq $inhF -and (([int]$_.FileSystemRights -band $want) -eq $want) -and (([int]$_.FileSystemRights -band (-bnot ($want -bor $sync))) -eq 0) })
            if (-not ($mine.Count -eq 1 -and $exact.Count -eq 1)) {
                $sec.PurgeAccessRules($sid)
                $sec.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $right, $inhF, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)))
                $changed = $true
            }
        }
        if ($changed) {
            if ($IsDir) { [System.IO.Directory]::SetAccessControl($Path, $sec) } else { [System.IO.File]::SetAccessControl($Path, $sec) }
        }
        return $true
    } catch { return $false }
}
# $DirGrant: what the virtual service account gets on a FOLDER ('Modify', or
# 'ReadAndExecute' for the WinSW folder), or 'None' (a folder it must never
# touch: its ACE is removed). A FILE always gets 'Read' (the .env).
function Protect-SensitivePath([string]$Path, [string]$DirGrant = 'Modify') {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return 'absent' }
    $isDir = (Get-Item -LiteralPath $Path -Force).PSIsContainer
    $svcGrant = if (-not $script:ServiceAclSid -or $DirGrant -eq 'None') { '' } elseif ($isDir) { $DirGrant } else { 'Read' }
    $withSvc = [bool]$svcGrant
    if (Test-AclHardened $Path $withSvc) {
        # The service account's LEVEL is re-checked as well (an older release
        # granted Modify where ReadAndExecute is now the rule).
        if ($svcGrant -and -not (Set-ServiceSidAce $Path $isDir $svcGrant)) { return 'FAILED (service-account ACE)' }
        return 'already restricted'
    }
    $inh = if ($isDir) { '(OI)(CI)' } else { '' }
    $rc = 1
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        # 1) Explicit broad grants a copy may have carried in (Users, Authenticated
        #    Users, Everyone, CREATOR OWNER, Power Users), on the whole tree -
        #    FIRST, while the tree is still listable.
        $tree = if ($isDir) { '/T' } else { $null }
        & icacls.exe $Path /remove:g '*S-1-5-32-545' '*S-1-5-11' '*S-1-1-0' '*S-1-3-0' '*S-1-5-32-547' $tree /C /Q *> $null
        # 2) /inheritance:r drops every inherited ACE (BUILTIN\Users, CREATOR OWNER...);
        #    children that inherit are re-propagated from the new DACL by icacls.
        & icacls.exe $Path /inheritance:r /grant:r "*S-1-5-18:${inh}F" "*S-1-5-32-544:${inh}F" /C /Q *> $null
        $rc = $LASTEXITCODE
    } catch { $rc = 1 } finally { $ErrorActionPreference = $prev }
    if ($rc -ne 0) { return "FAILED (icacls exit $rc)" }
    # 3) The virtual service account: its grant on this target, or its ACE (and a
    #    stale one after a switch back to LocalSystem) removed.
    if ($script:ServiceAclSid -or @(@($script:RevokeAclSids) | Where-Object { $_ }).Count) {
        if ($svcGrant) {
            if (-not (Set-ServiceSidAce $Path $isDir $svcGrant)) { return 'FAILED (service-account ACE)' }
        } else {
            $keepRevoke = $script:RevokeAclSids
            try {
                $script:RevokeAclSids = @(@($keepRevoke) + @($script:ServiceAclSid) | Where-Object { $_ })
                if (-not (Set-ServiceSidAce $Path $isDir '')) { return 'FAILED (service-account ACE)' }
            } finally { $script:RevokeAclSids = $keepRevoke }
        }
    }
    if (Test-AclHardened $Path $withSvc) { return 'restricted' }
    return 'PARTIAL (an explicit non-admin ACE remains)'
}
# HRIS_DROP_ROOT of the installed .env (docs/HRIS-SYNC.md): the folder tree the
# HRIS CSV connector reads its exports from. '' when unset.
function Get-HrisDropRoot([string]$InstallDir) {
    try {
        $envFile = Join-Path $InstallDir '.env'
        if (-not $InstallDir -or -not (Test-Path -LiteralPath $envFile)) { return '' }
        $m = [regex]::Match([IO.File]::ReadAllText($envFile), '(?m)^[ \t]*HRIS_DROP_ROOT[ \t]*=[ \t]*"?([^"\r\n]*)"?')
        if ($m.Success -and $m.Groups[1].Value.Trim()) { return $m.Groups[1].Value.Trim() }
    } catch {}
    return ''
}
# WHERE THE APP WRITES, and what the service account gets there. One pure
# function (a test runs it, and checks Install and Manage compute the same list)
# so the virtual account is granted EVERY place the app writes:
#   %ProgramData%\IDevelop: backups (daily dumps, erasure tombstones),
#     sql-restore-points (SQL console), audit-anchors, tls, keys (the backup
#     keyring), logs, and the root itself - Modify.
#   <InstallDir>: uploads, data, logs, backups, tmp (upload staging), certs,
#     AI_Engine_Docs (Data Management upload staging), service\logs (WinSW
#     logs) - Modify; .env - Read; service\ (the wrapper EXE + XML) and the
#     install root - ReadAndExecute, NEVER Modify: the code (src, scripts,
#     node_modules, the installer scripts) is run by administrators, so a
#     service able to rewrite it could escalate to whoever runs it next.
#   app-backups and restore-points (code backups, Manage restore points whose
#     code Manage -Restore runs as administrator): restricted, and NOTHING for
#     the service, for the same reason.
#   HRIS_DROP_ROOT (when set in .env): ReadAndExecute, additive (a customer
#     folder: never restricted by Setup). Local paths only: on a network share
#     (\\server\share) the virtual account authenticates as the COMPUTER account
#     (DOMAIN\<machine>$), which the share's owner must grant.
# Each entry: Path; Kind Dir|File; Restrict (cut down to SYSTEM + Administrators);
# Grant for the virtual account ('' when there is none); ProtectedFiles: the app
# writes files there with their OWN protected DACL (SYSTEM + Administrators +
# OWNER RIGHTS: dumps, the keyring, SQL-console restore points). Nothing
# inherits into such a file, so a file created by an administrator or by
# LocalSystem stays closed to the virtual account (a keyring it cannot read =
# every backup refused) unless its SID is put on the file itself.
function Get-AppAclTargets([string]$DataRoot, [string]$InstallDir, [string]$ServiceSid, [string]$HrisDropRoot = '') {
    $out = @()
    $m = if ($ServiceSid) { 'Modify' } else { '' }
    $rx = if ($ServiceSid) { 'ReadAndExecute' } else { '' }
    $pf = @('backups', 'sql-restore-points', 'keys', 'audit-anchors')
    foreach ($sub in @('backups', 'app-backups', 'restore-points', 'sql-restore-points', 'logs', 'audit-anchors', 'tls', 'keys')) {
        $gr = if ($sub -in @('app-backups', 'restore-points')) { '' } else { $m }
        $out += [pscustomobject]@{ Path = (Join-Path $DataRoot $sub); Kind = 'Dir'; Restrict = $true; Grant = $gr; ProtectedFiles = ($pf -contains $sub)
                    # keys\: the keyring only (Read) - never an exported backup-recovery-*.txt.
                    ProtectedFilter = $(if ($sub -eq 'keys') { 'backup-keyring*.json' } else { '*' }) }
    }
    $out += [pscustomobject]@{ Path = $DataRoot; Kind = 'Dir'; Restrict = $true; Grant = $m; ProtectedFiles = $false; ProtectedFilter = '*' }
    if ($InstallDir) {
        $out += [pscustomobject]@{ Path = (Join-Path $InstallDir '.env'); Kind = 'File'; Restrict = $true; Grant = $(if ($ServiceSid) { 'Read' } else { '' }); ProtectedFiles = $false; ProtectedFilter = '*' }
        foreach ($sub in @('logs', 'backups', 'uploads', 'data', 'tmp', 'certs', 'AI_Engine_Docs')) {
            $out += [pscustomobject]@{ Path = (Join-Path $InstallDir $sub); Kind = 'Dir'; Restrict = $true; Grant = $m; ProtectedFiles = ($sub -in @('backups', 'data')); ProtectedFilter = '*' }
        }
        $out += [pscustomobject]@{ Path = (Join-Path $InstallDir 'service\logs'); Kind = 'Dir'; Restrict = $true; Grant = $m; ProtectedFiles = $false; ProtectedFilter = '*' }
        $out += [pscustomobject]@{ Path = (Join-Path $InstallDir 'service'); Kind = 'Dir'; Restrict = $true; Grant = $rx; ProtectedFiles = $false; ProtectedFilter = '*' }
        # The install root stays readable (Program Files rules): additive grant only.
        $out += [pscustomobject]@{ Path = $InstallDir; Kind = 'Dir'; Restrict = $false; Grant = $rx; ProtectedFiles = $false; ProtectedFilter = '*' }
    }
    if ($HrisDropRoot -and -not $HrisDropRoot.StartsWith('\\')) {
        $out += [pscustomobject]@{ Path = $HrisDropRoot; Kind = 'Dir'; Restrict = $false; Grant = $rx; ProtectedFiles = $false; ProtectedFilter = '*' }
    }
    return $out
}
# $DataRoot = %ProgramData%\IDevelop; $InstallDir optional (the .env lives there).
# Sub-folders first, root last. Returns the number of targets NOT restricted.
function Protect-AppDataAcls([string]$DataRoot, [string]$InstallDir) {
    $all = @(Get-AppAclTargets $DataRoot $InstallDir $script:ServiceAclSid (Get-HrisDropRoot $InstallDir))
    $targets = @($all | Where-Object { $_.Restrict })
    $who = if ($script:ServiceAclSid) { "SYSTEM + Administrators + the service account $($script:ServiceAclSid)" } else { 'SYSTEM + Administrators only' }
    $touchSvc = $script:ServiceAclSid -or @(@($script:RevokeAclSids) | Where-Object { $_ }).Count
    $bad = 0
    # The service SID on (or off) every PROTECTED file of those folders - first,
    # while the folders are still listable by whoever runs this.
    if ($touchSvc) {
        foreach ($t in @($all | Where-Object { $_.ProtectedFiles -and (Test-Path -LiteralPath $_.Path -ErrorAction SilentlyContinue) })) {
            $fg = if (-not $script:ServiceAclSid) { '' } elseif ($t.ProtectedFilter -ne '*') { 'Read' } else { 'Modify' }
            $n = 0; $nf = 0
            foreach ($f in @(Get-ChildItem -LiteralPath $t.Path -Recurse -File -Force -Filter $t.ProtectedFilter -ErrorAction SilentlyContinue)) {
                $isProt = $false
                try { $isProt = (New-Object System.Security.AccessControl.FileSecurity($f.FullName, [System.Security.AccessControl.AccessControlSections]::Access)).AreAccessRulesProtected } catch { $isProt = $true }
                if (-not $isProt) { continue }
                if (Set-ServiceSidAce $f.FullName $false $fg) { $n++ } else { $nf++ }
            }
            if ($nf) { $bad++; Log "ACL: $nf protected file(s) under $($t.Path) could not be updated for the service account." 'WARN' }
            elseif ($n) { Log "ACL: service-account access $(if ($fg) { 'granted' } else { 'withdrawn' }) on $n protected file(s) under $($t.Path)." }
        }
    }
    foreach ($tt in $targets) {
        $t = $tt.Path
        $dg = if ($tt.Kind -ne 'Dir') { 'Modify' } elseif ($tt.Grant) { $tt.Grant } elseif ($script:ServiceAclSid) { 'None' } else { 'Modify' }
        $r = Protect-SensitivePath $t $dg
        if ($r -eq 'absent') { continue }
        if ($r -like 'FAILED*' -or $r -like 'PARTIAL*') { $bad++; Log "ACL hardening: $t -> $r" 'WARN' }
        else { Log "ACL hardening: $t -> $r ($who$(if ($script:ServiceAclSid -and -not $tt.Grant) { ' - not the service account' }))" }
    }
    # Additive grants on folders Setup does not restrict (the install root, the
    # HRIS drop folder): ReadAndExecute for the virtual account, revoked after a
    # switch back to LocalSystem.
    if ($touchSvc) {
        foreach ($tt in @($all | Where-Object { -not $_.Restrict -and (Test-Path -LiteralPath $_.Path -ErrorAction SilentlyContinue) })) {
            if (-not (Set-ServiceSidAce $tt.Path $true $tt.Grant)) { $bad++; Log "ACL: service-account access on $($tt.Path) could not be updated." 'WARN' }
            elseif ($tt.Grant) { Log "ACL: service account $($script:ServiceAclSid) holds $($tt.Grant) on $($tt.Path) (read-only; Modify only on the data folders)." }
        }
    }
    return $bad
}
# ---------------------------------------------------------------------------
# WHICH ACCOUNT THE SERVICE RUNS AS. config.psd1 ServiceAccount:
#   'Auto' (shipped) - a NEW install gets the virtual account NT SERVICE\<name>;
#                      an UPGRADE keeps what the service runs as today: a virtual
#                      service stays virtual, a LocalSystem one stays LocalSystem
#                      (never forced) with the recommendation shown, and moves only
#                      on -MigrateServiceAccount or a 'yes' at the console.
#   'Virtual' / 'LocalSystem' / '<account>' - explicit.
# A move of an EXISTING service from LocalSystem to the virtual account is never
# made in passing by the re-registration: the upgrade runs on the current account
# and, once it is healthy, Invoke-ServiceAccountMigration switches it with its own
# health check and its own way back (Migrate = $true below).
# Pure: returns @{ Mode; Account; Sid; VirtualSid; Migrate; Recommend; Reason }.
# ---------------------------------------------------------------------------
function Resolve-ServiceAccountPlan($Configured, [string]$ServiceName, [string]$CurrentStartName, [bool]$ServiceExists, [bool]$MigrateRequested) {
    $virtualName = "NT SERVICE\$ServiceName"
    $vsid = Get-ServiceSid $ServiceName
    $cur = "$CurrentStartName".Trim()
    $curIsVirtual = $ServiceExists -and ($cur -ieq $virtualName)
    $v = "$Configured".Trim()
    $mk = {
        param($mode, $account, $migrate, $recommend, $reason)
        [pscustomobject]@{
            Mode = $mode; Account = $account; Sid = $(if ($mode -eq 'Virtual') { $vsid } else { $null })
            VirtualSid = $vsid; Migrate = [bool]$migrate; Recommend = [bool]$recommend; Reason = $reason
        }
    }
    if ($v -ieq 'LocalSystem') { return (& $mk 'LocalSystem' 'LocalSystem' $false $false 'config.psd1 ServiceAccount = LocalSystem (explicit)') }
    if ($v -ieq 'Virtual' -or $v -ieq $virtualName) {
        $mig = $ServiceExists -and -not $curIsVirtual
        return (& $mk 'Virtual' $virtualName $mig $false $(if ($mig) { 'config.psd1 ServiceAccount = Virtual (explicit): the existing service is moved to the virtual account after the upgrade, with a health check' } else { 'config.psd1 ServiceAccount = Virtual (explicit)' }))
    }
    if ($v -and $v -ine 'Auto') { return (& $mk 'Custom' $v $false $false "config.psd1 ServiceAccount = $v (explicit)") }
    if (-not $ServiceExists) { return (& $mk 'Virtual' $virtualName $false $false 'new install: least-privilege virtual account (default)') }
    if ($curIsVirtual) { return (& $mk 'Virtual' $virtualName $false $false 'upgrade: the service already runs as its virtual account - kept') }
    if ($MigrateRequested) { return (& $mk 'Virtual' $virtualName $true $false 'upgrade: migration to the virtual account requested') }
    $shown = if ($cur) { $cur } else { 'LocalSystem' }
    return (& $mk 'LocalSystem' 'LocalSystem' $false $true "upgrade: the service keeps its current account ($shown) - not forced")
}
# Point the ACL helpers and Register-WindowsService at a plan. While a migration
# is pending the run stays on LocalSystem and revokes NOTHING (the switch comes last).
function Set-ServiceAccountContext($Plan) {
    if ($Plan.Mode -eq 'Virtual' -and -not $Plan.Migrate) {
        $script:SvcAcct = [pscustomobject]@{ Mode = 'Virtual'; Account = $Plan.Account; Sid = $Plan.Sid }
        $script:ServiceAclSid = $Plan.Sid; $script:RevokeAclSids = @()
    } elseif ($Plan.Mode -eq 'Virtual') {
        $script:SvcAcct = [pscustomobject]@{ Mode = 'LocalSystem'; Account = 'LocalSystem'; Sid = $null }
        $script:ServiceAclSid = $null; $script:RevokeAclSids = @()
    } else {
        $script:SvcAcct = [pscustomobject]@{ Mode = $Plan.Mode; Account = $Plan.Account; Sid = $null }
        $script:ServiceAclSid = $null; $script:RevokeAclSids = @($Plan.VirtualSid)
    }
}
# The switch itself, with its way back. $Ops are scriptblocks so the sequence can
# be proven without a real service:
#   ApplyAcls {param($grantSid, $revokeSids)} -> number of targets NOT restricted
#   SetAccount {param($account)} -> $true when the SCM reports that account
#   Restart {} ; Healthy {} -> $true when the app answers its health check
# Result: MIGRATED | ABORTED-ACL | ABORTED-SC | ROLLED-BACK | ROLLBACK-UNHEALTHY.
function Invoke-ServiceAccountMigration([string]$Sid, [string]$Account, [hashtable]$Ops) {
    $steps = New-Object System.Collections.Generic.List[string]
    $done = { param($r) [pscustomobject]@{ Result = $r; Steps = @($steps) } }
    # 1. Grant the virtual account on every data folder FIRST (nothing revoked). A
    #    folder that could not be granted would fail later, at night, in a backup
    #    job: refuse the switch instead (fail closed) and take the grants back.
    $bad = [int](& $Ops.ApplyAcls $Sid @())
    $steps.Add("acl-grant:$bad")
    if ($bad -gt 0) {
        [void](& $Ops.ApplyAcls $null @($Sid)); $steps.Add('acl-revoke')
        return (& $done 'ABORTED-ACL')
    }
    # 2. The SCM switch (the service keeps running on LocalSystem until the restart).
    if (-not (& $Ops.SetAccount $Account)) {
        $steps.Add("sc:$Account=failed")
        [void](& $Ops.ApplyAcls $null @($Sid)); $steps.Add('acl-revoke')
        return (& $done 'ABORTED-SC')
    }
    $steps.Add("sc:$Account")
    # 3. Restart as the virtual account and prove it serves.
    & $Ops.Restart | Out-Null; $steps.Add('restart')
    if (& $Ops.Healthy) { $steps.Add('healthy'); return (& $done 'MIGRATED') }
    $steps.Add('unhealthy')
    # 4. Way back: LocalSystem again, virtual grants removed, restart, re-check.
    $back = [bool](& $Ops.SetAccount 'LocalSystem'); $steps.Add("sc:LocalSystem=$back")
    [void](& $Ops.ApplyAcls $null @($Sid)); $steps.Add('acl-revoke')
    & $Ops.Restart | Out-Null; $steps.Add('restart')
    if (& $Ops.Healthy) { $steps.Add('healthy'); return (& $done 'ROLLED-BACK') }
    $steps.Add('unhealthy')
    return (& $done 'ROLLBACK-UNHEALTHY')
}
# AUDIT-TRAIL OWNERSHIP SEPARATION. config.psd1 AuditOwnerSeparation:
#   'Auto' (shipped) - OFF for a new install: while it is on, four SuperAdmin
#                      tools are refused (Danger-Zone cleanup, data reset, snapshot
#                      restore, SQL-console revert), so it is the operator's call.
#                      It is OFFERED (-EnableAuditOwnerSeparation, or a 'yes' at the
#                      console on an upgrade). An upgrade keeps the CURRENT state of
#                      the database: separated stays separated.
#   $true / $false   - explicit.
# Pure: returns @{ On; Recommend; Reason } (Recommend = the offer is shown).
function Resolve-AuditOwnerPlan($Configured, [bool]$FreshInstall, [bool]$CurrentlySeparated, [bool]$EnableRequested) {
    $mk = { param($on, $rec, $why) [pscustomobject]@{ On = [bool]$on; Recommend = [bool]$rec; Reason = $why } }
    if ($Configured -is [bool]) {
        if ($Configured) { return (& $mk $true $false 'config.psd1 AuditOwnerSeparation = $true (explicit)') }
        return (& $mk $false $false 'config.psd1 AuditOwnerSeparation = $false (explicit)')
    }
    if ($CurrentlySeparated) { return (& $mk $true $false 'upgrade: the audit tables are already separated - kept') }
    if ($EnableRequested) { return (& $mk $true $false 'separation requested (-EnableAuditOwnerSeparation)') }
    if ($FreshInstall) { return (& $mk $false $true 'new install: off by default (available: -EnableAuditOwnerSeparation)') }
    return (& $mk $false $true 'upgrade: not separated today - kept (not forced)')
}
# An operator can answer: a console (Test-InteractiveSession, defined below), the
# progress window not on auto-close (-GuiAutoClose N marks a scripted run) and not
# -NoGui (the unattended switch). Otherwise: never ask, just report.
function Test-CanAsk { return ((Test-InteractiveSession) -and -not $NoGui -and $GuiAutoClose -eq 0) }
# Yes = O / OUI / Y / YES (any case). Anything else, or no console, = no.
function Test-YesAnswer([string]$Answer) { return ("$Answer".Trim().ToUpperInvariant() -in @('O', 'OUI', 'Y', 'YES')) }
function Read-OperatorYes([string]$Question) {
    Log "QUESTION (answer in the setup CONSOLE window): $Question" 'STEP'
    $a = ''
    try { $a = Read-Host "  $Question [Y/N]" } catch { $a = '' }
    return (Test-YesAnswer $a)
}

# What the service runs as today (an upgrade keeps it unless asked otherwise).
$script:SvcStartName = $null; $script:SvcHostExists = $false
try {
    $w0 = Get-CimInstance Win32_Service -Filter "Name='$($cfg.ServiceName)'" -ErrorAction Stop
    if ($w0) { $script:SvcHostExists = $true; $script:SvcStartName = "$($w0.StartName)" }
} catch {}
if (-not $script:SvcHostExists) {
    # A Scheduled Task host runs as SYSTEM.
    try { if (Get-ScheduledTask -TaskName $cfg.ServiceName -ErrorAction Stop) { $script:SvcHostExists = $true; $script:SvcStartName = 'LocalSystem' } } catch {}
}
$script:SvcPlan = Resolve-ServiceAccountPlan $cfg.ServiceAccount $cfg.ServiceName $script:SvcStartName $script:SvcHostExists $MigrateServiceAccount.IsPresent
Set-ServiceAccountContext $script:SvcPlan
$script:SvcMigration = $null

# Firewall profiles (3.23.17, S-05). The rule used to be '-Profile Any', i.e.
# open on Public networks too. Default: Domain + Private. When a network the
# machine is CONNECTED to right now is classified Public, Public is added (with
# a WARN) - otherwise the appliance would become unreachable on the only network
# it has. config.psd1 FirewallProfiles overrides the default list.
# Firewall rules this product owns carry the Group 'IDevelop'. Older versions
# left untagged 'IDevelop (<port>)' rules, one per port ever used.
$script:FirewallGroup = 'IDevelop'
function Get-AppFirewallRules {
    $byName = @{}
    foreach ($r in @(Get-NetFirewallRule -Group $script:FirewallGroup -ErrorAction SilentlyContinue) +
                   @(Get-NetFirewallRule -DisplayName 'IDevelop*' -ErrorAction SilentlyContinue)) {
        if ($r -and -not $byName.ContainsKey($r.Name)) { $byName[$r.Name] = $r }
    }
    return @($byName.Values)
}
# Pure planner (no side effect): which owned rules to REMOVE. Kept = the first
# tagged rule per wanted display name; removed = stale ports, duplicates, and an
# untagged rule for a wanted name (the caller re-creates it tagged).
function Get-FirewallRulePlan($Existing, [string[]]$Wanted, [string]$Group) {
    $remove = @(); $keep = @(); $seen = @{}
    foreach ($r in @($Existing | Where-Object { $_ })) {
        $dn = "$($r.DisplayName)"
        if ($Wanted -notcontains $dn) { $remove += [pscustomobject]@{ Name = $r.Name; DisplayName = $dn; Why = 'port no longer in use' }; continue }
        if ("$($r.Group)" -ne $Group) { $remove += [pscustomobject]@{ Name = $r.Name; DisplayName = $dn; Why = 'untagged - re-created in group ' + $Group }; continue }
        if ($seen.ContainsKey($dn)) { $remove += [pscustomobject]@{ Name = $r.Name; DisplayName = $dn; Why = 'duplicate' }; continue }
        $seen[$dn] = $true; $keep += $r
    }
    return [pscustomobject]@{ Remove = $remove; Keep = $keep }
}

function Resolve-FirewallProfiles($configured, [string[]]$activeCategories) {
    $valid = @('Domain', 'Private', 'Public')
    $list = @()
    foreach ($p in @($configured)) {
        foreach ($q in ("$p" -split '[,; ]+')) {
            if ($q.Trim() -eq 'Any') { foreach ($v in $valid) { if ($list -notcontains $v) { $list += $v } }; continue }
            $m = $valid | Where-Object { $_ -eq $q.Trim() } | Select-Object -First 1
            if ($m -and ($list -notcontains $m)) { $list += $m }
        }
    }
    if ($list.Count -eq 0) { $list = @('Domain', 'Private') }
    $publicAdded = $false
    if (($activeCategories -contains 'Public') -and ($list -notcontains 'Public')) { $list += 'Public'; $publicAdded = $true }
    return [pscustomobject]@{ Profiles = $list; PublicAdded = $publicAdded }
}

# ---------------------------------------------------------------------------
# Progress window (Installer-Gui.ps1): an Office-style "Installing..." bar on
# its own thread, fed by Set-Step / Log above. Best-effort: a desktop without
# WPF, a service session or -NoGui leaves the console progress in charge.
# ---------------------------------------------------------------------------
$script:Gui = $null
if (-not $NoGui -and [Environment]::UserInteractive -and $Host.Name -ne 'ServerRemoteHost') {
    try {
        . (Join-Path $ScriptRoot 'Installer-Gui.ps1')
        $guiVersion = ''
        try { $vp0 = Join-Path $ScriptRoot 'app\package.json'; if (Test-Path $vp0) { $guiVersion = (Get-Content $vp0 -Raw | ConvertFrom-Json).version } } catch {}
        $guiVerb = if ($Migrate) { 'Updating' } elseif ($Patch) { 'Updating' } elseif ($Repair) { 'Repairing' } elseif ($Reinstall) { 'Reinstalling' } else { 'Installing' }
        $guiIcon = ''
        foreach ($cand in @((Join-Path $ScriptRoot 'app\public\icons\idevelop.ico'), (Join-Path $ScriptRoot 'app\public\favicon.ico'), (Join-Path $ScriptRoot 'app\public\icons\icon-192.png'), (Join-Path $ScriptRoot 'bin\IDevelop.ico'))) { if (Test-Path $cand) { $guiIcon = $cand; break } }

        # ---- Wizard front page (-Wizard) -----------------------------------
        # A Windows setup is expected to say what it is about to do and get a
        # deliberate "Install" before it touches the machine. -Wizard turns the
        # window into that: Welcome (+ Options) -> Licence -> Progress -> Finish.
        # Without it the window is progress-only, exactly as before, which is
        # what Setup.bat's own menu and every unattended call still get.
        $guiArgs = @{
            AppName = $cfg.AppName; Version = $guiVersion; Publisher = $cfg.Publisher
            Headline = ("{0} {1}..." -f $guiVerb, $cfg.AppName)
            TotalSteps = $script:TotalSteps; AutoCloseSeconds = $GuiAutoClose; IconPath = $guiIcon
        }
        if ($Wizard) {
            $installed = Test-Path (Join-Path $cfg.InstallDir 'server.js')
            $oldVer = ''
            try { $opj = Join-Path $cfg.InstallDir 'package.json'; if (Test-Path $opj) { $oldVer = (Get-Content $opj -Raw | ConvertFrom-Json).version } } catch {}
            $verb = if (-not $installed) { 'Install' } elseif ($Repair) { 'Repair' } elseif ($Reinstall) { 'Reinstall' } else { 'Update' }
            $title = if ($verb -eq 'Install') { "Install $($cfg.AppName)" } else { "$verb $($cfg.AppName)" }
            $lead = if ($installed -and $oldVer -and $guiVersion -and $oldVer -ne $guiVersion) {
                "Setup will update this computer from version $oldVer to version $guiVersion. Your database and settings are preserved."
            } elseif ($installed) {
                "Setup will refresh the installed files on this computer. Your database and settings are preserved."
            } else {
                "Setup will install $($cfg.AppName) on this computer and run it as a Windows service that starts automatically."
            }
            $verLine = if ($installed -and $oldVer) { "$oldVer  ->  $guiVersion" } else { $guiVersion }
            $plan = @()
            $plan += 'Check prerequisites (Node.js, PostgreSQL, Visual C++ runtime) and install any that are missing.'
            if ($installed) { $plan += 'Back up the current version so setup can roll back if the new one does not start.' }
            $plan += "Copy the application to $($cfg.InstallDir)."
            $plan += 'Create or upgrade the database schema, applying any pending migrations.'
            $plan += "Register the '$($cfg.ServiceName)' Windows service and start it."
            $plan += 'Add the Start Menu shortcuts and the Apps & features entry, then check the app responds.'
            $licBody = ''
            try {
                # -Encoding UTF8 matters: PowerShell 5.1's default is ANSI, which
                # turned the licence's em-dash into mojibake on the page.
                $licPath = Join-Path $ScriptRoot 'app\LICENSE'
                if (Test-Path $licPath) { $licBody = (Get-Content $licPath -Raw -Encoding UTF8) }
            } catch {}
            $guiArgs.ShowWelcome = $true
            $guiArgs.ActionVerb = $verb
            $guiArgs.WelcomeTitle = $title
            $guiArgs.WelcomeLead = $lead
            $guiArgs.InstallDir = $cfg.InstallDir
            $guiArgs.VersionLine = $verLine
            $guiArgs.DbLine = "$($cfg.DbName) on $($cfg.PgHost):$($cfg.PgPort)"
            $guiArgs.AppUrlPlanned = "http://localhost:$($cfg.AppPort)/"
            $guiArgs.PlanSteps = $plan
            $guiArgs.LicenseBody = $licBody
        }
        $script:Gui = Start-InstallerGui @guiArgs
        Log 'Setup window opened (pass -NoGui for console-only progress).'

        if ($Wizard) {
            if (-not (Wait-InstallerConsent -Gui $script:Gui)) {
                # 1602 is the Windows installer convention for "cancelled by the
                # user" - a management tool must not read this as a failure.
                Log 'Setup was cancelled on the welcome page - nothing was changed.' 'WARN'
                try { $script:Gui.PowerShell.Stop(); $script:Gui.PowerShell.Dispose(); $script:Gui.Runspace.Dispose() } catch {}
                exit 1602
            }
            # Honour the two choices the person can actually change.
            if (-not $script:Gui.Sync.OptFirewall) { $SkipFirewall = $true; Log 'Firewall rule skipped (unchecked in Options).' }
            $script:SkipShortcuts = -not $script:Gui.Sync.OptShortcuts
        }
    } catch {
        $script:Gui = $null
        Log ("Setup window unavailable ({0}) - console progress only." -f $_.Exception.Message) 'WARN'
    }
}

function New-Secret([int]$bytes = 32) {
    # Re-roll a value that contains a "year" digit run (20xx): earlier releases
    # refused such a SESSION_SECRET as guessable and the service boot-looped
    # (about 9 % of 64-hex values). The app no longer does, but a secret must be
    # valid for whichever version reads it.
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        for ($try = 0; $try -lt 64; $try++) {
            $b = New-Object byte[] $bytes
            $rng.GetBytes($b)
            $s = -join ($b | ForEach-Object { $_.ToString('x2') })
            if ($s -notmatch '20\d\d') { return $s }
        }
        return $s
    } finally { $rng.Dispose() }
}

# ---------------------------------------------------------------------------
# HTTPS (3.23.18, S-05). config.psd1 Https = @{ Enabled; Port; CertThumbprint;
# SelfSigned }. When enabled the installer issues (or reuses) a certificate in
# LocalMachine\My, exports it as a PFX under %ProgramData%\IDevelop\tls
# (ACL-restricted with the rest of the data tree) and writes TLS_PFX_PATH,
# TLS_PFX_PASSPHRASE, HTTPS_PORT, COOKIE_SECURE=1 and an https APP_BASE_URL into
# .env. server.js then serves HTTPS on that port and the HTTP port only redirects.
# ---------------------------------------------------------------------------
$script:TlsFriendlyName = 'IDevelop TLS (self-signed)'
function Resolve-HttpsConfig($h) {
    $o = [ordered]@{ Enabled = $false; Port = 3443; CertThumbprint = ''; SelfSigned = $true }
    if ($h -is [hashtable]) {
        if ($h.ContainsKey('Enabled')) { $o.Enabled = [bool]$h.Enabled }
        if ($h.ContainsKey('Port') -and ("$($h.Port)" -match '^\d{1,5}$') -and [int]$h.Port -ge 1 -and [int]$h.Port -le 65535) { $o.Port = [int]$h.Port }
        if ($h.ContainsKey('CertThumbprint') -and $h.CertThumbprint) { $o.CertThumbprint = (("$($h.CertThumbprint)") -replace '[^0-9A-Fa-f]', '').ToUpperInvariant() }
        if ($h.ContainsKey('SelfSigned')) { $o.SelfSigned = [bool]$h.SelfSigned }
    }
    return [pscustomobject]$o
}
# Value of KEY in a .env text ('' when absent or commented out).
function Get-EnvValue([string]$Text, [string]$Key) {
    $m = [regex]::Match("$Text", '(?m)^[ \t]*' + [regex]::Escape($Key) + '[ \t]*=([^\r\n]*)')
    if ($m.Success) { return $m.Groups[1].Value.Trim() }
    return ''
}
# Set (replace in place, else append) each KEY=VALUE of the ordered map.
function Set-EnvKeys([string]$Text, $Pairs) {
    $t = "$Text"
    foreach ($k in @($Pairs.Keys)) {
        $line = "$k=$($Pairs[$k])"
        $rx = '(?m)^[ \t]*' + [regex]::Escape($k) + '[ \t]*=[^\r\n]*'
        if ([regex]::IsMatch($t, $rx)) { $t = [regex]::Replace($t, $rx, { param($m) $line }) }
        else { $t = $t.TrimEnd("`r", "`n") + "`r`n" + $line + "`r`n" }
    }
    return $t
}
# Comment out each KEY (HTTPS switched off again): kept for the record, not read.
function Disable-EnvKeys([string]$Text, [string[]]$Keys) {
    $t = "$Text"
    foreach ($k in $Keys) {
        $t = [regex]::Replace($t, '(?m)^([ \t]*' + [regex]::Escape($k) + '[ \t]*=[^\r\n]*)', { param($m) '# (HTTPS disabled in config.psd1) ' + $m.Groups[1].Value })
    }
    return $t
}
# The .env side of HTTPS, as a pure text transform (unit-tested).
#   On : TLS_PFX_PATH / TLS_PFX_PASSPHRASE / HTTPS_PORT / COOKIE_SECURE=1 set;
#        APP_BASE_URL -> the https URL unless the operator already set an https one.
#   Off: only if a previous run had turned it on (TLS_PFX_PATH present): those
#        keys are commented out, COOKIE_SECURE too unless TRUST_PROXY is set (a
#        forced Secure cookie on plain HTTP is refused at boot), and APP_BASE_URL
#        goes back to the http URL if it is still the one the installer wrote.
function Update-EnvForHttps([string]$Text, [bool]$On, [string]$PfxPath, [string]$Passphrase, [int]$HttpsPort, [string]$HttpsBaseUrl, [string]$HttpBaseUrl) {
    if ($On) {
        $pairs = [ordered]@{ TLS_PFX_PATH = $PfxPath; TLS_PFX_PASSPHRASE = $Passphrase; HTTPS_PORT = "$HttpsPort"; COOKIE_SECURE = '1' }
        $cur = Get-EnvValue $Text 'APP_BASE_URL'
        if (-not $cur -or $cur -notmatch '^https://') { $pairs['APP_BASE_URL'] = $HttpsBaseUrl }
        return (Set-EnvKeys $Text $pairs)
    }
    if (-not (Get-EnvValue $Text 'TLS_PFX_PATH')) { return $Text }
    $t = Disable-EnvKeys $Text @('TLS_PFX_PATH', 'TLS_PFX_PASSPHRASE', 'HTTPS_PORT')
    if (-not (Get-EnvValue $t 'TRUST_PROXY')) { $t = Disable-EnvKeys $t @('COOKIE_SECURE') }
    if ((Get-EnvValue $t 'APP_BASE_URL') -eq $HttpsBaseUrl) { $t = Set-EnvKeys $t ([ordered]@{ APP_BASE_URL = $HttpBaseUrl }) }
    return $t
}
function Get-MachineFqdn {
    $n = $null
    try { $n = [System.Net.Dns]::GetHostEntry($env:COMPUTERNAME).HostName } catch { $n = $null }
    if (-not $n) { $n = $env:COMPUTERNAME }
    return "$n".ToLowerInvariant()
}
# The certificate to serve: CertThumbprint from LocalMachine\My when given (must
# hold an EXPORTABLE private key), else a reusable self-signed one (same DNS
# names, > 30 days left), else a new self-signed one (RSA 2048, SHA-256, 5 years,
# server-auth EKU). Returns $null (with a WARN) when nothing usable exists.
function Get-TlsCertificate($Https, [string[]]$DnsNames) {
    if ($Https.CertThumbprint) {
        $c = Get-Item -LiteralPath ("Cert:\LocalMachine\My\" + $Https.CertThumbprint) -ErrorAction SilentlyContinue
        if (-not $c) { Log "HTTPS: certificate $($Https.CertThumbprint) not found in LocalMachine\My." 'WARN'; return $null }
        if (-not $c.HasPrivateKey) { Log "HTTPS: certificate $($Https.CertThumbprint) has no private key." 'WARN'; return $null }
        Log "HTTPS: using the certificate $($Https.CertThumbprint) ($($c.Subject), expires $($c.NotAfter.ToString('yyyy-MM-dd')))."
        return $c
    }
    if (-not $Https.SelfSigned) { Log 'HTTPS: Enabled but no CertThumbprint and SelfSigned = $false - no certificate to serve.' 'WARN'; return $null }
    $want = @($DnsNames | Where-Object { $_ } | ForEach-Object { "$_".ToLowerInvariant() } | Select-Object -Unique)
    $reuse = $null
    foreach ($cand in @(Get-ChildItem -Path 'Cert:\LocalMachine\My' -ErrorAction SilentlyContinue | Sort-Object NotAfter -Descending)) {
        if ($cand.FriendlyName -ne $script:TlsFriendlyName -or -not $cand.HasPrivateKey -or $cand.NotAfter -le (Get-Date).AddDays(30)) { continue }
        $have = @($cand.DnsNameList | ForEach-Object { "$($_.Unicode)".ToLowerInvariant() })
        if (@($want | Where-Object { $have -notcontains $_ }).Count -eq 0) { $reuse = $cand; break }
    }
    if ($reuse) { Log "HTTPS: reusing the self-signed certificate $($reuse.Thumbprint) (expires $($reuse.NotAfter.ToString('yyyy-MM-dd')))."; return $reuse }
    $c = New-SelfSignedCertificate -DnsName $want -CertStoreLocation 'Cert:\LocalMachine\My' -FriendlyName $script:TlsFriendlyName `
        -NotAfter (Get-Date).AddYears(5) -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
        -KeyUsage DigitalSignature, KeyEncipherment -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.1') -ErrorAction Stop
    Log "HTTPS: self-signed certificate created for $($want -join ', ') (thumbprint $($c.Thumbprint), valid to $($c.NotAfter.ToString('yyyy-MM-dd')))." 'OK'
    return $c
}

# DOWNLOAD INTEGRITY: everything the installer downloads and RUNS is checked.
# Returns @{ Ok; Reason; Hash; Signer }. $Sha256 is mandatory (config.psd1 pins
# one per artefact: fail closed when it is missing). $Publisher, when set, must
# be the CN / O of a VALID Authenticode signature (Microsoft, OpenJS Foundation,
# EnterpriseDB); empty = the vendor does not sign the file (WinSW): hash only.
function Test-DownloadedArtifact([string]$Path, [string]$Sha256, [string]$Publisher) {
    $res = [pscustomobject]@{ Ok = $false; Reason = ''; Hash = ''; Signer = '' }
    if (-not (Test-Path -LiteralPath $Path)) { $res.Reason = 'file not found'; return $res }
    if (-not $Sha256 -or $Sha256.Trim() -notmatch '^[0-9A-Fa-f]{64}$') {
        $res.Reason = 'no pinned SHA-256 for this artefact in config.psd1 (refusing to run an unverified file)'; return $res
    }
    $res.Hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($res.Hash -ne $Sha256.Trim().ToLowerInvariant()) {
        $res.Reason = "SHA-256 mismatch (expected $($Sha256.Trim().ToLowerInvariant()), got $($res.Hash))"; return $res
    }
    if ($Publisher) {
        $sig = Get-AuthenticodeSignature -LiteralPath $Path
        $subj = if ($sig.SignerCertificate) { "$($sig.SignerCertificate.Subject)" } else { '' }
        $res.Signer = $subj
        if ("$($sig.Status)" -ne 'Valid') { $res.Reason = "Authenticode signature is '$($sig.Status)', not Valid"; return $res }
        $pubRx = '(^|,\s*)(CN|O)="?' + [regex]::Escape($Publisher) + '"?(\s*,|$)'
        if ($subj -notmatch $pubRx) { $res.Reason = "signed by '$subj', expected publisher '$Publisher'"; return $res }
    }
    $res.Ok = $true
    return $res
}

function Get-File([string]$Url, [string]$OutFile, [string]$Sha256, [string]$Publisher) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12, [Net.SecurityProtocolType]::Tls13
    # A file already present (pre-placed for an offline / slow-link install) is
    # reused ONLY when it is the pinned file; anything else is removed and fetched.
    if (Test-Path -LiteralPath $OutFile) {
        $pre = Test-DownloadedArtifact $OutFile $Sha256 $Publisher
        if ($pre.Ok) {
            Log "Using already-present file: $OutFile ($([math]::Round((Get-Item $OutFile).Length/1MB,1)) MB) - SHA-256 verified$(if ($Publisher) { ", signed by $Publisher" })." 'OK'
            return
        }
        Log "Ignoring the already-present $OutFile - $($pre.Reason). It is removed and the pinned file is downloaded." 'WARN'
        Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $OutFile) { Fail "Cannot remove the unverified file $OutFile - delete it and re-run." }
    }
    # PS 5.1's Invoke-WebRequest renders a per-byte progress bar that can slow a
    # large download to a crawl. Suppressing it dramatically speeds big files.
    $prevPref = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        # Up to 5 attempts. NO short timeout: large prerequisites (PostgreSQL is
        # ~350 MB) over a slow/throttled link can legitimately take a long time,
        # and that is acceptable - we never abort a download for being slow.
        $downloaded = $false
        for ($i = 1; $i -le 5 -and -not $downloaded; $i++) {
            try {
                Log "Downloading $Url (attempt $i of 5 - large files may take a while; this is normal)"
                $sw = [Diagnostics.Stopwatch]::StartNew()
                # -TimeoutSec 0 = no client-side timeout; let it run to completion.
                Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec 0
                $sw.Stop()
                $mb = if (Test-Path $OutFile) { [math]::Round((Get-Item $OutFile).Length/1MB,1) } else { 0 }
                Log "Downloaded $mb MB in $([int]$sw.Elapsed.TotalSeconds)s." 'OK'
                $downloaded = $true
            }
            catch {
                Log "Download attempt $i failed: $($_.Exception.Message)" 'WARN'
                if (Test-Path $OutFile) { Remove-Item $OutFile -Force -ErrorAction SilentlyContinue }  # drop partial
                Start-Sleep -Seconds ([Math]::Min(30, 5 * $i))   # back off: 5,10,15,20,25s
            }
        }
        if (-not $downloaded) {
            Fail "Could not download $Url after 5 attempts. Check internet access, or pre-place the file at: $OutFile (the installer will reuse it when its SHA-256 matches config.psd1)."
        }
        # Integrity is not a transient failure: never retried, and the file is
        # never run - it is deleted before the install aborts.
        $chk = Test-DownloadedArtifact $OutFile $Sha256 $Publisher
        if (-not $chk.Ok) {
            Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
            Fail "INTEGRITY CHECK FAILED for $Url - $($chk.Reason). The file was deleted and NOT run. Check the URL / hash pair in config.psd1 (or a proxy rewriting downloads)."
        }
        Log "Integrity verified: SHA-256 $($chk.Hash)$(if ($Publisher) { "; Authenticode Valid, $Publisher" })." 'OK'
    } finally {
        $ProgressPreference = $prevPref
    }
}

function Refresh-Path {
    $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $u = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($m, $u) | Where-Object { $_ }) -join ';'
}

function Test-PortInUse([int]$port) {
    try { return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
    catch { return $false }
}

# Return the first free TCP port at/above $start (so the app can fall back to the
# next port when something else already owns the preferred one).
function Get-FreePort([int]$start, [int]$maxTries = 200) {
    for ($p = $start; ($p -le 65535) -and ($p -lt ($start + $maxTries)); $p++) {
        if (-not (Test-PortInUse $p)) { return $p }
    }
    return $start   # nothing free in range; caller's health-check will surface it
}

# Health probe: TRUE when an HTTP server answers on $url. Uses HttpWebRequest
# with AllowAutoRedirect=$false so a 302 (the app's normal redirect to /login)
# is RETURNED, not thrown. NB: PowerShell 5.1's Invoke-WebRequest throws
# "maximum redirection count exceeded" on a 302 when -MaximumRedirection 0, which
# made a perfectly healthy app look down - this avoids that trap. Any HTTP
# response (2xx/3xx/4xx/5xx) means the server is listening; only a transport
# failure (connection refused / timeout) counts as "not up yet".
function Test-HttpUp([string]$url, [int]$timeoutMs = 4000) {
    try {
        $req = [System.Net.HttpWebRequest]::Create($url)
        $req.AllowAutoRedirect = $false
        $req.Timeout = $timeoutMs
        $req.Method = 'GET'
        $resp = $req.GetResponse()
        $resp.Close()
        return $true
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) { return $true }   # server answered (3xx/4xx/5xx)
        return $false
    } catch { return $false }
}

# TIME SYNC. TOTP codes (MFA) are valid for 30 s either side, and session
# expiry and the audit trail's timestamps all trust this clock. Parses
# 'w32tm /query /status' (the Source line reads the same on an English and a
# French Windows) and the W32Time service state.
function ConvertFrom-W32tmStatus([string[]]$Lines, [string]$ServiceStatus, [string]$StartType) {
    $src = ''
    foreach ($l in @($Lines)) { if ("$l" -match '^\s*Source\s*:\s*(.+?)\s*$') { $src = $Matches[1]; break } }
    # A free-running / CMOS clock (or no answer at all) is "not synchronised";
    # a domain controller, an NTP peer or Hyper-V's VM IC provider is a source.
    $localClock = (-not $src) -or ($src -match '(?i)CMOS|Free-running|Horloge')
    $running = ("$ServiceStatus" -eq 'Running')
    return [pscustomobject]@{
        Source = $src; ServiceStatus = "$ServiceStatus"; StartType = "$StartType"
        Ok = ($running -and -not $localClock)
    }
}
# A console someone can answer (not a service session, not redirected stdin).
function Test-InteractiveSession {
    try { return ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and $Host.Name -ne 'ServerRemoteHost') } catch { return $false }
}
function Get-TimeSyncStatus {
    $svc = Get-Service -Name 'W32Time' -ErrorAction SilentlyContinue
    $st = if ($svc) { "$($svc.Status)" } else { 'Missing' }
    $stt = if ($svc) { "$($svc.StartType)" } else { '' }
    $lines = @()
    if ($svc -and $svc.Status -eq 'Running') {
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try { $lines = @(& w32tm.exe /query /status 2>$null) } catch { $lines = @() } finally { $ErrorActionPreference = $prev }
    }
    return (ConvertFrom-W32tmStatus $lines $st $stt)
}

function Test-VcRedist {
    foreach ($k in @(
            'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64',
            'HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64')) {
        try { if ((Get-ItemProperty -Path $k -ErrorAction Stop).Installed -eq 1) { return $true } } catch {}
    }
    return $false
}

# Run an external command, stream + capture all output to the log, return exit code.
# This replaces the old Start-Process -NoNewWindow approach that swallowed the
# real error text behind a bare exit code.
function Invoke-Logged {
    param(
        [Parameter(Mandatory)][string]$File,
        [string[]]$Arguments = @(),
        [string]$WorkDir = $PWD,
        [hashtable]$EnvVars = @{},
        # Indexes of $Arguments that hold secrets and must be masked in the echo.
        [int[]]$RedactArgs = @()
    )
    $prevEnv = @{}
    foreach ($k in $EnvVars.Keys) { $prevEnv[$k] = [Environment]::GetEnvironmentVariable($k); Set-Item "Env:$k" $EnvVars[$k] }
    Push-Location $WorkDir
    # Native tools (npm in particular) write progress + deprecation warnings to
    # stderr. With $ErrorActionPreference='Stop' those stderr lines are promoted
    # to a terminating error and would abort the install even on success. Relax
    # it for the duration of the external call and judge success by EXIT CODE only.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # Echo a redacted copy of the command line (never the real secret).
        $echoArgs = @($Arguments)
        foreach ($i in $RedactArgs) { if ($i -ge 0 -and $i -lt $echoArgs.Count) { $echoArgs[$i] = '***redacted***' } }
        Log ("> {0} {1}" -f $File, ($echoArgs -join ' '))
        # 2>&1 merges stderr into the output so we can log it; it is NOT treated
        # as failure here - only a non-zero exit code (checked by the caller) is.
        $out = & $File @Arguments 2>&1
        $code = $LASTEXITCODE
        foreach ($l in $out) { Add-Content -Path $LogFile -Value ("    | " + $l) ; Write-Host ("    | " + $l) -ForegroundColor DarkGray }
        return $code
    } finally {
        $ErrorActionPreference = $prevEAP
        Pop-Location
        foreach ($k in $EnvVars.Keys) { if ($null -ne $prevEnv[$k]) { Set-Item "Env:$k" $prevEnv[$k] } else { Remove-Item "Env:$k" -ErrorAction SilentlyContinue } }
    }
}

Log "===== IDevelop installer (PostgreSQL) =====" 'STEP'
Log "Install dir : $($cfg.InstallDir)"
Log "App port    : $($cfg.AppPort)"
Log "PG target   : $($cfg.PgHost):$($cfg.PgPort)  (ssl=$($cfg.PgSsl))"
Log "Log file    : $LogFile"
Log "Transcript  : $Transcript $(if(-not $script:TranscriptOn){'(unavailable - transcript folder could not be restricted to Administrators+SYSTEM)'})"
if ($script:LegacyTranscriptsMoved) { Log "Moved $($script:LegacyTranscriptsMoved) older transcript(s) under transcripts\ (Administrators+SYSTEM only) with their command line redacted." 'OK' }
if ($script:PgPwFromEnv) { Log 'postgres password taken from the environment (SETUP_PG_SUPER_PASSWORD) - not on the command line.' }

# --- Environment header: everything needed to reproduce / diagnose a failure. ---
# Secrets are redacted. This block makes the log self-contained for support.
function Write-EnvHeader {
    $h = @()
    $h += '----- ENVIRONMENT -----'
    $h += "Timestamp        : $(Get-Date -Format o)"
    $h += "Run as user      : $([Security.Principal.WindowsIdentity]::GetCurrent().Name)"
    $h += "Computer         : $env:COMPUTERNAME"
    try { $ci = Get-CimInstance Win32_OperatingSystem; $h += "OS               : $($ci.Caption) build $($ci.BuildNumber) ($($ci.OSArchitecture))" } catch {}
    $h += "PowerShell       : $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"
    $h += "Culture          : $(Get-Culture)"
    $h += "Working dir      : $PWD"
    $h += "Script root      : $ScriptRoot"
    $h += "Free space (sys) : $([math]::Round((Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':')) -ErrorAction SilentlyContinue).Free/1GB,1)) GB"
    # Bound parameters (redact the PG password if it was passed).
    $boundCopy = @{}
    foreach ($k in $PSBoundParameters.Keys) { $boundCopy[$k] = if ($k -eq 'PgSuperPassword') { '***redacted***' } else { $PSBoundParameters[$k] } }
    $h += "Parameters       : " + (($boundCopy.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' ')
    # Resolved config (redact passwords).
    $h += "Config (resolved): InstallDir=$($cfg.InstallDir); AppPort=$($cfg.AppPort); PgHost=$($cfg.PgHost); PgPort=$($cfg.PgPort); PgSsl=$($cfg.PgSsl); DbName=$($cfg.DbName); DbUser=$($cfg.DbUser); NodeVersion=$($cfg.NodeVersion); PgMajor=$($cfg.PgMajor)"
    $h += "PgSuperPassword  : $(if($cfg.PgSuperPassword){'(set)'}else{'(empty - will generate / require)'})"
    # Toolchain presence (versions help spot a stale Node / missing psql).
    try { $nv = (& node --version) 2>$null } catch {}; $h += "node             : $(if($nv){$nv}else{'not on PATH'})"
    try { $npmv = (& npm.cmd --version) 2>$null } catch {}; $h += "npm              : $(if($npmv){$npmv}else{'not on PATH'})"
    try { $psv = (& psql --version) 2>$null } catch {}; $h += "psql             : $(if($psv){$psv}else{'not on PATH'})"
    # Port snapshot for the app + PG ports.
    foreach ($prt in @($cfg.AppPort, $cfg.PgPort, 6379)) {
        $busy = Test-PortInUse $prt
        $h += "Port $prt".PadRight(17) + ": $(if($busy){'IN USE'}else{'free'})"
    }
    $h += '-----------------------'
    foreach ($l in $h) { Add-Content -Path $LogFile -Value $l }
    Write-Host '  (environment header written to log)' -ForegroundColor DarkGray
}

# Tracks whether we reached the end cleanly so the finally{} banner is accurate.
$script:InstallSucceeded = $false
# Rollback bookkeeping (set during the run; read in catch/finally + summary).
$script:BackupDir   = $null
$script:RolledBack  = $null   # $null | 'SUCCESS' | 'FAILED-UNHEALTHY' | 'ERROR' | 'SKIPPED'

# Records which host actually ended up running the app (for the summary banner).
$script:ServiceKind = $null   # 'WindowsService' | 'ScheduledTask'

# --- Helpers to detect each kind of host (used for prior-install detection,
#     stop, and clean switch-over between mechanisms). ---
function Get-AppWindowsService { Get-Service -Name $cfg.ServiceName -ErrorAction SilentlyContinue }
function Get-AppScheduledTask  { Get-ScheduledTask -TaskName $cfg.ServiceName -ErrorAction SilentlyContinue }
function Get-WinSwExePath      { Join-Path (Join-Path $cfg.InstallDir 'service') "$($cfg.ServiceName).exe" }

# --- Resolve a WinSW wrapper exe: prefer one bundled in the package (<root>\bin),
#     else download it from config WinSwUrl. Returns a path, or $null if neither. ---
function Resolve-WinSw {
    foreach ($name in @('WinSW-x64.exe', 'WinSW.exe', 'winsw.exe')) {
        $bundled = Join-Path (Join-Path $ScriptRoot 'bin') $name
        if (Test-Path -LiteralPath $bundled) {
            # The bundled wrapper runs as the service account: it is held to the
            # same pinned hash as a downloaded one.
            $chk = Test-DownloadedArtifact $bundled $cfg.WinSwSha256 $cfg.WinSwPublisher
            if ($chk.Ok) { Log "Using bundled service wrapper: $bundled (SHA-256 verified)"; return $bundled }
            Log "The bundled service wrapper $bundled failed its integrity check - $($chk.Reason). It is NOT used; replace bin\WinSW-x64.exe with the pinned WinSW release." 'ERROR'
            return $null
        }
    }
    if (-not $cfg.WinSwUrl) { return $null }
    $dest = Join-Path $env:TEMP 'WinSW-x64.exe'
    try {
        Log "Downloading the service wrapper (WinSW) from $($cfg.WinSwUrl) ..."
        Get-File $cfg.WinSwUrl $dest $cfg.WinSwSha256 $cfg.WinSwPublisher
        if (Test-Path -LiteralPath $dest) { return $dest }
    } catch { Log "WinSW download failed: $($_.Exception.Message)" 'WARN' }
    return $null
}

# --- Remove the OTHER host so the two mechanisms never run the app twice. ---
function Remove-ScheduledTaskHost {
    if (Get-AppScheduledTask) {
        Stop-ScheduledTask -TaskName $cfg.ServiceName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $cfg.ServiceName -Confirm:$false -ErrorAction SilentlyContinue
        Log "Removed the legacy Scheduled Task host (switched to a Windows service)."
    }
}
function Remove-WindowsServiceHost {
    $svcExe = Get-WinSwExePath
    if (Get-AppWindowsService) {
        try { Stop-Service -Name $cfg.ServiceName -Force -ErrorAction SilentlyContinue } catch {}
        if (Test-Path -LiteralPath $svcExe) { & $svcExe uninstall 2>&1 | Out-Null }
        else { & sc.exe delete $cfg.ServiceName 2>&1 | Out-Null }
        Start-Sleep -Seconds 2
        Log "Removed the Windows service host (switched to a Scheduled Task)."
    }
}

# --- Wait until the service wrapper exe is really free. Stop-Service / "uninstall"
#     return before the WinSW process (and its node child) have exited, and the
#     Copy-Item that follows then failed with "being used by another process":
#     measured on 2026-09-25 (3.23.15 -> 3.23.16), the upgrade silently fell back
#     to a Scheduled Task host. Waits up to $Seconds for no process to run from the
#     file AND for an exclusive open to succeed. ---
function Wait-FileReleased([string]$Path, [int]$Seconds = 30) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        $busy = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
            try { $_.Path -and ($_.Path -ieq $Path) } catch { $false } })
        if ($busy.Count -eq 0) {
            if (-not (Test-Path -LiteralPath $Path)) { return $true }
            try {
                $fs = [System.IO.File]::Open($Path, 'Open', 'ReadWrite', 'None')
                $fs.Close()
                return $true
            } catch { }
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# --- Register the app as a REAL Windows service via the WinSW wrapper. Returns
#     $true on success. The service runs `node server.js` from the install dir
#     (so it picks up .env + node_modules), auto-restarts on failure, and rolls
#     its stdout/stderr logs. Version-agnostic: serves whatever code is on disk. ---
function Register-WindowsService {
  try {
    $winsw = Resolve-WinSw
    if (-not $winsw) { return $false }
    $svcDir = Join-Path $cfg.InstallDir 'service'
    New-Item -ItemType Directory -Force -Path $svcDir | Out-Null
    # WinSW writes the app's stdout/stderr here (<name>.out.log / .err.log: stack
    # traces, SQL errors, e-mail addresses) and the folder used to inherit
    # BUILTIN\Users read from Program Files. Restricted like the other data
    # folders (SYSTEM + Administrators, + the service account), BEFORE the
    # wrapper writes its first line. The folder holds the wrapper EXE + XML:
    # ReadAndExecute for the service account; the logs go to service\logs, the
    # only place it may write here (WinSW <logpath> below).
    $svcLogDir = Join-Path $svcDir 'logs'
    New-Item -ItemType Directory -Force -Path $svcLogDir | Out-Null
    $svcLogAcl = Protect-SensitivePath $svcLogDir 'Modify'
    if ($svcLogAcl -like 'FAILED*' -or $svcLogAcl -like 'PARTIAL*') { Log "ACL hardening: $svcLogDir -> $svcLogAcl" 'WARN' }
    else { Log "ACL hardening: $svcLogDir -> $svcLogAcl (service logs)" }
    $svcAcl = Protect-SensitivePath $svcDir 'ReadAndExecute'
    if ($svcAcl -like 'FAILED*' -or $svcAcl -like 'PARTIAL*') { Log "ACL hardening: $svcDir -> $svcAcl" 'WARN' }
    else { Log "ACL hardening: $svcDir -> $svcAcl (service wrapper, read-only)" }
    $svcExe = Join-Path $svcDir "$($cfg.ServiceName).exe"
    $svcXml = Join-Path $svcDir "$($cfg.ServiceName).xml"

    # Refresh an existing service so config changes (node path, account) apply.
    if (Get-AppWindowsService) {
        try { Stop-Service -Name $cfg.ServiceName -Force -ErrorAction SilentlyContinue } catch {}
        if (Test-Path -LiteralPath $svcExe) { & $svcExe uninstall 2>&1 | Out-Null }
        Start-Sleep -Seconds 2
    }
    # The old wrapper may still be exiting: wait for the file, then copy with retries.
    if (-not (Wait-FileReleased -Path $svcExe -Seconds 30)) {
        Log "Service wrapper still in use after 30 s: $svcExe" 'WARN'
    }
    $copied = $false
    for ($i = 1; $i -le 5 -and -not $copied; $i++) {
        try {
            Copy-Item -LiteralPath $winsw -Destination $svcExe -Force -ErrorAction Stop
            $copied = $true
        } catch {
            if ($i -eq 5) { throw }
            Log "Service wrapper copy attempt $i failed ($($_.Exception.Message)); retrying." 'WARN'
            Start-Sleep -Seconds (2 * $i)
        }
    }

    # From the resolved plan, never the raw config value ('Auto' is not an account).
    $acct = if ($script:SvcAcct -and $script:SvcAcct.Mode -eq 'Custom') { $script:SvcAcct.Account } else { 'LocalSystem' }
    # 'Virtual' (S-04): WinSW 2.x has no virtual-account form, so the service is
    # registered as LocalSystem and switched to NT SERVICE\<name> with sc.exe
    # right after the install, BEFORE its first start (see below).
    if ($script:SvcAcct.Mode -eq 'Virtual') { $acct = 'LocalSystem' }
    # WinSW <serviceaccount> for LocalSystem uses the special username form.
    $acctXml = if ($acct -eq 'LocalSystem') {
        "  <serviceaccount><username>LocalSystem</username></serviceaccount>"
    } else {
        "  <serviceaccount><username>$([System.Security.SecurityElement]::Escape($acct))</username></serviceaccount>"
    }
    $xml = @"
<service>
  <id>$($cfg.ServiceName)</id>
  <name>$($cfg.AppName)</name>
  <description>$($cfg.AppName) Performance Management System (Node.js app, hosted by WinSW).</description>
  <executable>$($script:nodeExe)</executable>
  <arguments>server.js</arguments>
  <workingdirectory>$($cfg.InstallDir)</workingdirectory>
  <env name="NODE_ENV" value="production" />
$acctXml
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="10 sec" />
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <logpath>$([System.Security.SecurityElement]::Escape($svcLogDir))</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
</service>
"@
    Set-Content -LiteralPath $svcXml -Value $xml -Encoding UTF8

    & $svcExe install 2>&1 | ForEach-Object { Add-Content -Path $LogFile -Value "  [winsw] $_" }
    # Belt-and-suspenders: ensure auto-start even if the wrapper didn't set it.
    & sc.exe config $cfg.ServiceName start= auto 2>&1 | Out-Null
    if ($script:SvcAcct.Mode -eq 'Virtual') {
        # A virtual account has no password: 'obj=' alone is the documented form.
        $scOut = & sc.exe config $cfg.ServiceName obj= $script:SvcAcct.Account 2>&1
        $startName = $null
        try { $startName = (Get-CimInstance Win32_Service -Filter "Name='$($cfg.ServiceName)'" -ErrorAction Stop).StartName } catch { $startName = $null }
        if ("$startName" -eq $script:SvcAcct.Account) {
            Log "Service account: $($script:SvcAcct.Account) (virtual account, SID $($script:SvcAcct.Sid)) - not LocalSystem." 'OK'
        } else {
            Log ("Service account: could not switch to $($script:SvcAcct.Account) (sc.exe: " + ("$scOut".Trim()) + ") - the service runs as '$startName'.") 'WARN'
        }
    }
    Start-Service -Name $cfg.ServiceName -ErrorAction Stop
    $svc = Get-AppWindowsService
    if ($svc -and $svc.Status -eq 'Running') { $script:ServiceKind = 'WindowsService'; return $true }
    # Started but not Running yet - give it a moment.
    Start-Sleep -Seconds 3
    if ((Get-AppWindowsService).Status -eq 'Running') { $script:ServiceKind = 'WindowsService'; return $true }
    return $false
  } catch {
    Log "Windows service registration failed: $($_.Exception.Message)" 'WARN'
    return $false
  }
}

# --- Register the app as a SYSTEM Scheduled Task at startup (legacy / fallback,
#     airgap-safe: needs no extra binary). ---
function Register-ScheduledTaskService {
    if ($script:SvcAcct -and $script:SvcAcct.Mode -eq 'Virtual') {
        Log "ServiceAccount = 'Virtual' applies to the Windows service only - the Scheduled Task host runs as SYSTEM." 'WARN'
    }
    if (Get-AppScheduledTask) { Unregister-ScheduledTask -TaskName $cfg.ServiceName -Confirm:$false }
    $action    = New-ScheduledTaskAction -Execute $script:nodeExe -Argument 'server.js' -WorkingDirectory $cfg.InstallDir
    $trigger   = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $cfg.ServiceName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $cfg.ServiceName
    $script:ServiceKind = 'ScheduledTask'
}

# --- (Re)register + start the auto-start host, per the resolved ServiceMode.
#     Used by both the install (STEP 6) and the rollback path. ---
function Register-AppService {
    switch ($cfg.ServiceMode) {
        'ScheduledTask' {
            Remove-WindowsServiceHost
            Register-ScheduledTaskService
            Log "Hosted as a SYSTEM Scheduled Task ('$($cfg.ServiceName)')."
        }
        'Service' {
            Remove-ScheduledTaskHost
            if (Register-WindowsService) { Log "Hosted as a Windows service ('$($cfg.ServiceName)')." 'OK' }
            else { Fail "ServiceMode='Service' was requested but the WinSW wrapper could not be obtained (offline and not bundled in <package>\bin). Bundle WinSW-x64.exe or use -ServiceMode Auto / ScheduledTask." }
        }
        default {  # 'Auto'
            Remove-ScheduledTaskHost
            if (Register-WindowsService) {
                Log "Hosted as a Windows service ('$($cfg.ServiceName)')." 'OK'
            } else {
                # Say which reason it was: the wrapper can be bundled and still fail to
                # register (the file-in-use race above), and the old wording sent the
                # reader looking for a missing binary.
                Log 'Windows service could not be registered (wrapper missing, or registration failed - see the warning above) - falling back to a SYSTEM Scheduled Task host. Re-run the installer to switch back to a Windows service.' 'WARN'
                Register-ScheduledTaskService
                Log "Hosted as a SYSTEM Scheduled Task ('$($cfg.ServiceName)')."
            }
        }
    }
}

# --- Stop whichever host is running + any stray app node process so files unlock. ---
function Stop-AppService {
    if (Get-AppWindowsService) {
        try { Stop-Service -Name $cfg.ServiceName -Force -ErrorAction SilentlyContinue } catch {}
    }
    if (Get-AppScheduledTask) {
        Stop-ScheduledTask -TaskName $cfg.ServiceName -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$($cfg.InstallDir)*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
}

# --- Poll the app's health endpoint; $true once it answers within ~60s. ---
function Wait-AppHealthy([int]$tries = 30) {
    for ($i = 0; $i -lt $tries; $i++) {
        Start-Sleep -Seconds 2
        if ((Test-HttpUp "http://localhost:$($cfg.AppPort)/health") -or (Test-HttpUp "http://localhost:$($cfg.AppPort)/")) { return $true }
    }
    return $false
}

# --- Automatic restore-on-failure: bring the previous version back online. ---
# Only meaningful for an upgrade / patch (a pre-upgrade backup must exist). Stops
# the service, overlays the backed-up code over the install dir (the backup
# excluded node_modules, so installed deps stay in place), best-effort reconciles
# dependencies to the restored lockfile, restarts the service and re-checks health.
# Returns $true only when the restored version is confirmed UP.

# Delete from <InstallDir>\db\postgres every migration file that <Reference>\db\postgres
# does not carry, and return their names. Used by the rollback here and by the same
# step in Manage-IDevelop.ps1 -Restore: a point-in-time restore of the CODE is
# only true if the service cannot find newer migrations to apply at boot.
function Remove-MigrationsNotIn([string]$InstallDir, [string]$Reference) {
    $live = Join-Path $InstallDir 'db\postgres'
    $ref  = Join-Path $Reference  'db\postgres'
    $gone = @()
    if (-not (Test-Path -LiteralPath $live)) { return $gone }
    $keep = @{}
    if (Test-Path -LiteralPath $ref) {
        foreach ($f in (Get-ChildItem -LiteralPath $ref -File -Filter '*.sql')) { $keep[$f.Name.ToLowerInvariant()] = $true }
    }
    foreach ($f in (Get-ChildItem -LiteralPath $live -File -Filter '*.sql')) {
        if (-not $keep.ContainsKey($f.Name.ToLowerInvariant())) {
            Remove-Item -LiteralPath $f.FullName -Force
            $gone += $f.Name
        }
    }
    return $gone
}

function Invoke-Rollback([string]$reason) {
    if ($NoRollback) {
        Log "Automatic rollback is disabled (-NoRollback). The failed build is left in place; backup preserved at: $($script:BackupDir)" 'WARN'
        $script:RolledBack = 'SKIPPED'
        return $false
    }
    if (-not $script:BackupDir -or -not (Test-Path -LiteralPath $script:BackupDir)) {
        Log 'No pre-upgrade backup is available - cannot roll back automatically (this was likely a fresh install).' 'WARN'
        return $false
    }
    Log "ROLLBACK: restoring the previous version because: $reason" 'STEP'
    try {
        Stop-AppService
        # Restore the backed-up code over the install dir. /E overlays files and
        # leaves target-only items (node_modules) intact. The backup includes the
        # previous package.json / package-lock.json / .env, so this fully reverts
        # the code and configuration to the last working state.
        # /E never deletes, so the NEW package's migration files would survive
        # the rollback in db\postgres - and the restored service applies every
        # numbered file schema_meta does not list at its next boot (measured:
        # 12 files >= 113 would hit a 3.22.97 database). Remove first every
        # migration the backup does not carry.
        $purged = Remove-MigrationsNotIn -InstallDir $cfg.InstallDir -Reference $script:BackupDir
        if ($purged.Count) { Log "Rollback: removed $($purged.Count) migration file(s) newer than the backup: $($purged -join ', ')" 'OK' }
        robocopy $script:BackupDir $cfg.InstallDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { Log "Rollback file copy reported a robocopy error ($LASTEXITCODE) - continuing to restart." 'WARN' }
        else { Log 'Previous version code restored over the install directory.' 'OK' }
        # The restored .env is a fresh copy that inherits Users:(RX) again (S-01).
        try { [void](Protect-AppDataAcls $LogDir $cfg.InstallDir) } catch { Log "ACL hardening after rollback skipped: $($_.Exception.Message)" 'WARN' }

        # Best-effort: reconcile node_modules to the restored lockfile. If this
        # fails (e.g. no registry access) we keep the existing node_modules, which
        # is almost always still compatible with the previous code.
        if ($script:npmCmd -and (Test-Path (Join-Path $cfg.InstallDir 'package.json'))) {
            Log 'Rollback: reconciling dependencies to the restored version...'
            $npmCommonR = @('--omit=dev', '--no-audit', '--no-fund', '--loglevel=error', '--ignore-scripts')
            $envR = if ($script:childEnv) { $script:childEnv } else { @{ NODE_ENV = 'production' } }
            $rc = Invoke-Logged -File $script:npmCmd -Arguments (@('install') + $npmCommonR) -WorkDir $cfg.InstallDir -EnvVars $envR
            if ($rc -ne 0) { Log "Rollback: dependency reconcile returned $rc - kept existing node_modules (usually fine)." 'WARN' }
        }

        if ($NoService) {
            Log 'Previous version code restored. -NoService was set, so the service was not (re)started.' 'OK'
            $script:RolledBack = 'SUCCESS'
            return $true
        }
        Register-AppService
        Log 'Service restarted on the previous version - verifying health...'
        if (Wait-AppHealthy) {
            Log "ROLLBACK SUCCESSFUL - the previous version is back UP at http://localhost:$($cfg.AppPort)/." 'OK'
            $script:RolledBack = 'SUCCESS'
            return $true
        }
        Log "ROLLBACK ran but the restored version is NOT responding on port $($cfg.AppPort). Manual recovery needed; the backup is at: $($script:BackupDir)" 'ERROR'
        $script:RolledBack = 'FAILED-UNHEALTHY'
        return $false
    } catch {
        Log "ROLLBACK encountered an error: $($_.Exception.Message). The backup is preserved at: $($script:BackupDir)" 'ERROR'
        $script:RolledBack = 'ERROR'
        return $false
    }
}

try {

Write-EnvHeader

# ---------------------------------------------------------------------------
# STEP 1/7 - Preflight & prerequisites
# ---------------------------------------------------------------------------
Set-Step 1 'Preflight & prerequisites'
Log 'STEP 1/7 - Preflight & prerequisites' 'STEP'

# --- Detect any prior / partial installation so we can repair intelligently. ---
$priorInstallDir   = Test-Path (Join-Path $cfg.InstallDir 'server.js')
$priorEnv          = Test-Path (Join-Path $cfg.InstallDir '.env')
$priorNodeModules  = Test-Path (Join-Path $cfg.InstallDir 'node_modules')
$priorService      = [bool](Get-AppWindowsService) -or [bool](Get-AppScheduledTask)
$priorAny          = $priorInstallDir -or $priorEnv -or $priorService
if ($Repair) {
    Log "REPAIR MODE: re-validating and repairing the existing installation (the database is never dropped)." 'STEP'
}
if ($priorAny) {
    Log ("Existing install detected: files={0}, .env={1}, node_modules={2}, service={3}." -f $priorInstallDir, $priorEnv, $priorNodeModules, $priorService)
    if (-not $Repair) { Log 'Re-running in upgrade mode (use -Repair to force a full re-validation / clean dependency rebuild).' }
} else {
    if ($Repair) { Log 'No existing installation found at the target - -Repair will perform a fresh install.' 'WARN' }
    else { Log 'No existing installation detected - performing a fresh install.' }
}

# The service account decision, said out loud; on an upgrade that keeps
# LocalSystem, the recommendation and the one-switch migration are offered.
Log "Service account: $($script:SvcPlan.Account) - $($script:SvcPlan.Reason)."
if ($script:SvcPlan.Recommend) {
    Log "RECOMMENDED: run the service as its virtual account NT SERVICE\$($cfg.ServiceName) (least privilege: no password, no rights on the rest of the machine) instead of LocalSystem. Re-run with -MigrateServiceAccount: every data folder is re-ACLed for it, the service restarts as it, and goes back to LocalSystem by itself if it does not come up healthy." 'WARN'
    if ($NoService) {
        Log 'Service account migration not offered: -NoService.'
    } elseif (Test-CanAsk) {
        if (Read-OperatorYes "Move the $($cfg.ServiceName) service to NT SERVICE\$($cfg.ServiceName) now (automatic return to LocalSystem if unhealthy)?") {
            $script:SvcPlan = Resolve-ServiceAccountPlan $cfg.ServiceAccount $cfg.ServiceName $script:SvcStartName $script:SvcHostExists $true
            Set-ServiceAccountContext $script:SvcPlan
            Log 'Operator accepted the service account migration - it runs after the upgrade is healthy.' 'OK'
        } else { Log 'Service account left on LocalSystem (operator declined).' }
    }
}
if ($script:SvcPlan.Migrate -and $NoService) {
    Log 'Service account migration requested but -NoService is set - nothing to migrate.' 'WARN'
    $script:SvcPlan.Migrate = $false
}

# --- Migrate mode is an upgrade with proof around it. ---
if ($Migrate) {
    if ($SkipMigrations) { Fail 'MIGRATE MODE applies migrations by definition; -SkipMigrations cannot be combined with -Migrate.' }
    $Patch = $true
    $script:MigrateMode = $true
}

# --- Patch / upgrade mode: require an existing install; never touch live data. ---
if ($Patch) {
    if (-not $priorAny) {
        Fail "PATCH MODE requested but no existing IDevelop installation was found at '$($cfg.InstallDir)'. Run a normal install first (without -Patch)."
    }
    if ($SkipMigrations) {
        Log 'PATCH MODE (APP ONLY): refreshing application code + restarting the service. NO database migrations. The database, all data and .env are preserved.' 'STEP'
    } else {
        Log 'UPGRADE MODE: refreshing application code + applying pending migrations (new DB info may be introduced) + restarting the service. The database, data and .env are preserved.' 'STEP'
    }
    $cfg.ImportData = $false   # a patch/upgrade must NEVER re-import / overwrite live data
}

if ($Reinstall) {
    # Full reinstall: force a brand-new database from the bundled snapshot even if
    # one already holds data (STEP 4b honours $Reinstall to skip the preserve check).
    $cfg.ImportData = $true
    if ($priorAny) {
        Log 'FULL REINSTALL: the existing app + database are backed up, then REPLACED by a brand-new instance and a fresh database from the bundled snapshot.' 'STEP'
    } else {
        Log 'FULL INSTALL: fresh instance + database from the bundled snapshot.' 'STEP'
    }
}

# Record installed vs packaged version for the summary (best-effort, never fatal).
$script:OldVersion = $null; $script:NewVersion = $null
try { $vp = Join-Path $cfg.InstallDir 'package.json'; if (Test-Path $vp) { $script:OldVersion = (Get-Content $vp -Raw | ConvertFrom-Json).version } } catch {}
try { $vp = Join-Path $ScriptRoot 'app\package.json'; if (Test-Path $vp) { $script:NewVersion = (Get-Content $vp -Raw | ConvertFrom-Json).version } } catch {}
if ($script:OldVersion -or $script:NewVersion) {
    $ovTxt = if ($script:OldVersion) { $script:OldVersion } else { 'none' }
    $nvTxt = if ($script:NewVersion) { $script:NewVersion } else { '?' }
    Log "Application version: installed=$ovTxt -> package=$nvTxt"
    # The window's headline can now say where the update goes.
    if ($script:Gui -and $script:OldVersion -and $script:NewVersion -and ($Patch -or $Migrate)) {
        try { $script:Gui.Sync.Headline = ("Updating {0} from {1} to {2}..." -f $cfg.AppName, $script:OldVersion, $script:NewVersion) } catch {}
    }
}

$os = Get-CimInstance Win32_OperatingSystem
$build = [int]($os.BuildNumber)
Log "OS: $($os.Caption) (build $build)"
if ($build -lt 17763) { Log 'Windows older than Server 2019 / Win10 1809 - not officially supported.' 'WARN' }
Refresh-Path

# Time sync. Warn; change the W32Time service ONLY with the operator's consent
# (typed Y at the console): it is a machine-wide setting.
try {
    $ts = Get-TimeSyncStatus
    if ($ts.Ok) {
        Log "Time sync: W32Time $($ts.ServiceStatus) ($($ts.StartType)), source '$($ts.Source)'." 'OK'
    } else {
        Log ("Time sync: NOT synchronised (W32Time service $($ts.ServiceStatus), start type '$($ts.StartType)', source '" + $(if ($ts.Source) { $ts.Source } else { 'none' }) + "'). MFA codes (TOTP, 30 s window), session expiry and audit timestamps depend on this clock.") 'WARN'
        $ans = ''
        # Asked on an interactive install / repair only: a Patch is the scripted
        # deploy path and must never stop on a question it did not need.
        if (-not $Patch -and (Test-InteractiveSession)) {
            try { $ans = Read-Host "  Type Y to set the Windows Time service (W32Time) to Automatic, start it and resync (anything else: leave it)" } catch { $ans = '' }
        }
        if ("$ans".Trim() -eq 'Y') {
            try {
                Set-Service -Name 'W32Time' -StartupType Automatic -ErrorAction Stop
                if ((Get-Service -Name 'W32Time').Status -ne 'Running') { Start-Service -Name 'W32Time' -ErrorAction Stop }
                $prevT = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
                & w32tm.exe /resync /nowait *> $null
                $ErrorActionPreference = $prevT
                Log 'Time sync: W32Time set to Automatic and started (operator consent); a resync was requested.' 'OK'
            } catch { Log "Time sync: could not configure W32Time ($($_.Exception.Message))." 'WARN' }
        } else {
            Log 'Time sync: left unchanged. Fix: Set-Service W32Time -StartupType Automatic; Start-Service W32Time; w32tm /resync (or point it at the domain / an NTP server).' 'WARN'
        }
    }
} catch { Log "Time sync check skipped: $($_.Exception.Message)" 'WARN' }

if (Test-VcRedist) {
    Log 'Visual C++ Redistributable already present - reusing.' 'OK'
} else {
    Log 'Visual C++ Redistributable not found - installing.'
    $vc = Join-Path $env:TEMP 'vc_redist.x64.exe'
    Get-File $cfg.VcRedistUrl $vc $cfg.VcRedistSha256 $cfg.VcRedistPublisher
    $p = Start-Process -FilePath $vc -ArgumentList @('/install', '/quiet', '/norestart') -Wait -PassThru
    if ($p.ExitCode -notin 0, 1638, 3010) { Log "VC++ redist returned $($p.ExitCode) (continuing)." 'WARN' }
    else { Log 'Visual C++ Redistributable installed.' 'OK' }
}

if (Test-PortInUse $cfg.AppPort) {
    # Both operands parenthesised: `Get-X -or (Get-Y)` is parsed in COMMAND mode,
    # so `-or` and the second call become ARGUMENTS of Get-X and the task host was
    # never detected (measured: $False with the task present, $True once wrapped).
    if ((Get-AppWindowsService) -or (Get-AppScheduledTask)) { Log "Port $($cfg.AppPort) held by the existing $($cfg.ServiceName) host (will restart on upgrade)." }
    else { Log "Port $($cfg.AppPort) is in use by another process - the installer will automatically move the app to the next free port (override with -AppPort)." 'WARN' }
}

# ---------------------------------------------------------------------------
# STEP 2/7 - Node.js
# ---------------------------------------------------------------------------
Set-Step 2 'Node.js'
Log 'STEP 2/7 - Node.js' 'STEP'
function Get-NodeVersion {
    # Returns [version] of the node on PATH (or Program Files), or $null.
    $exe = 'node'
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        $pf = Join-Path $env:ProgramFiles 'nodejs\node.exe'
        if (Test-Path $pf) { $exe = $pf }
    }
    try { $v = (& $exe --version) 2>$null; if ($v -match 'v(\d+)\.(\d+)\.(\d+)') { return [version]("{0}.{1}.{2}" -f $Matches[1], $Matches[2], $Matches[3]) } } catch {}
    return $null
}
function Get-RequiredNodeVersion {
    # Minimum from app\package.json engines.node (">=20.19.0"); falls back to NodeMinMajor.0.
    $req = [version]("{0}.0.0" -f $cfg.NodeMinMajor)
    try {
        $pj = Join-Path $ScriptRoot 'app\package.json'
        if (Test-Path $pj) {
            $eng = (Get-Content $pj -Raw | ConvertFrom-Json).engines.node
            if ($eng -match '(\d+)\.(\d+)(?:\.(\d+))?') {
                $patch = 0; if ($Matches[3]) { $patch = $Matches[3] }
                $req = [version]("{0}.{1}.{2}" -f $Matches[1], $Matches[2], $patch)
            }
        }
    } catch {}
    return $req
}
function Test-NodeVersionOk([version]$have, [version]$need) {
    # Full major.minor comparison against engines, PLUS the require(esm) gap:
    # Node 21.x and 22.0-22.11 satisfy ">=20.19" numerically but cannot load
    # openid-client/jose (Entra SSO) without a flag.
    if ($null -eq $have) { return $false }
    if ($have -lt $need) { return $false }
    if ($have.Major -eq 21) { return $false }
    if ($have.Major -eq 22 -and $have.Minor -lt 12) { return $false }
    return $true
}
$nodeNeed = Get-RequiredNodeVersion
$nodeHave = Get-NodeVersion
if (Test-NodeVersionOk $nodeHave $nodeNeed) {
    Log "Existing Node.js v$nodeHave detected (required >= $nodeNeed) - reusing." 'OK'
} else {
    if ($nodeHave) { Log "Node v$nodeHave does not meet the requirement (>= $nodeNeed; 21.x and 22.0-22.11 lack require(esm) for Entra SSO) - installing v$($cfg.NodeVersion)." 'WARN' }
    else { Log 'Node.js not found - installing.' }
    $msi = Join-Path $env:TEMP "node-$($cfg.NodeVersion).msi"
    Get-File $cfg.NodeMsiUrl $msi $cfg.NodeMsiSha256 $cfg.NodeMsiPublisher
    Log 'Installing Node.js silently...'
    $p = Start-Process msiexec.exe -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart', 'ADDLOCAL=ALL') -Wait -PassThru
    if ($p.ExitCode -ne 0) { Fail "Node.js MSI failed (exit $($p.ExitCode))." }
    Refresh-Path
    $nodeHave = Get-NodeVersion
    if (-not (Test-NodeVersionOk $nodeHave $nodeNeed)) { Fail "Node.js install did not produce a usable node on PATH (found v$nodeHave, need >= $nodeNeed)." }
    Log "Node.js v$nodeHave installed." 'OK'
}
$npmCmdObj  = Get-Command npm.cmd -ErrorAction SilentlyContinue
$npmCmd     = if ($npmCmdObj) { $npmCmdObj.Source } else { Join-Path $env:ProgramFiles 'nodejs\npm.cmd' }
$nodeExeObj = Get-Command node.exe -ErrorAction SilentlyContinue
$nodeExe    = if ($nodeExeObj) { $nodeExeObj.Source } else { Join-Path $env:ProgramFiles 'nodejs\node.exe' }

# ---------------------------------------------------------------------------
# STEP 3/7 - PostgreSQL (detect existing, else install)
# ---------------------------------------------------------------------------
Set-Step 3 'PostgreSQL'
Log 'STEP 3/7 - PostgreSQL' 'STEP'
function Find-PgBin {
    $cmd = Get-Command psql.exe -ErrorAction SilentlyContinue
    if ($cmd) { return Split-Path -Parent $cmd.Source }
    $roots = @("$env:ProgramFiles\PostgreSQL", "${env:ProgramFiles(x86)}\PostgreSQL")
    foreach ($r in $roots) {
        if (Test-Path $r) {
            $bin = Get-ChildItem $r -Directory -ErrorAction SilentlyContinue |
                Sort-Object Name -Descending |
                ForEach-Object { Join-Path $_.FullName 'bin' } |
                Where-Object { Test-Path (Join-Path $_ 'psql.exe') } |
                Select-Object -First 1
            if ($bin) { return $bin }
        }
    }
    return $null
}
function Test-PgListening([string]$h, [int]$port) {
    try { return (Test-NetConnection -ComputerName $h -Port $port -WarningAction SilentlyContinue).TcpTestSucceeded } catch { return $false }
}
# SECRETS OFF THE COMMAND LINE: the EDB PostgreSQL installer used to receive the
# superuser password as '--superpassword <pw>', visible to every local user in
# the process list (Get-CimInstance Win32_Process, tasklist /v) for the minutes
# the install takes. It now reads it from an InstallBuilder option file
# ('--optionfile', key=value lines, UTF-8 without BOM) written in a fresh folder
# under the elevated user's own %TEMP% (profile ACL: that user, SYSTEM,
# Administrators). The caller deletes .Dir as soon as the installer returns.
# Returns @{ Args; Dir; OptionFile }. Nothing secret is in .Args.
function New-PgInstallerArgs([string]$SuperPassword, [int]$Port, [string]$TempRoot = $env:TEMP) {
    $dir = Join-Path $TempRoot ('idevelop-pgopt-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $opt = Join-Path $dir 'pg-install.options'
    [IO.File]::WriteAllText($opt, "superpassword=$SuperPassword`r`n", (New-Object System.Text.UTF8Encoding($false)))
    $a = @(
        '--mode', 'unattended', '--unattendedmodeui', 'none',
        '--optionfile', "`"$opt`"",
        '--serverport', "$Port",
        '--enable-components', 'server,commandlinetools'
    )
    return @{ Args = $a; Dir = $dir; OptionFile = $opt }
}

$isLocalPg   = $cfg.PgHost -in @('localhost', '127.0.0.1', '::1', $env:COMPUTERNAME)
$pgService   = if ($isLocalPg) { Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1 } else { $null }
$pgBin       = Find-PgBin
$pgListening = Test-PgListening $cfg.PgHost $cfg.PgPort
$pgExists    = $UseExistingPostgres -or $pgService -or $pgListening -or (-not $isLocalPg)
# Was this server created by this installer (now or on an earlier run)? The
# marker is trusted only when an administrator or SYSTEM owns it: the service
# account may write in %ProgramData%\IDevelop and must not be able to forge it
# (it would make Setup change and restart a server it does not own).
$script:PgMarkerFile = Join-Path $LogDir 'pg-created-by-installer.json'
$script:PgCreatedByUs = $false
function Test-PgMarkerTrusted([string]$Path, [int]$Port) {
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return $false }
        $own = (New-Object System.Security.AccessControl.FileSecurity($Path, [System.Security.AccessControl.AccessControlSections]::Owner)).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
        if ($own -notin @('S-1-5-18', 'S-1-5-32-544')) { return $false }
        return ([int]((Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json).port) -eq $Port)
    } catch { return $false }
}
if ($pgExists -and $isLocalPg) { $script:PgCreatedByUs = Test-PgMarkerTrusted $script:PgMarkerFile ([int]$cfg.PgPort) }

if ($pgExists) {
    Log "Existing PostgreSQL (service=$([bool]$pgService), psql=$([bool]$pgBin), port $($cfg.PgPort) open=$pgListening, local=$isLocalPg) - reusing." 'OK'
    # If no password was supplied, seed the standard as the first thing to TRY.
    # The connect routine below tries every candidate and, if all fail, prompts
    # for the real current password - so a blank here is never a dead end.
    if (-not $cfg.PgSuperPassword -and $cfg.ContainsKey('StandardPgSuperPassword') -and $cfg.StandardPgSuperPassword) {
        $cfg.PgSuperPassword = $cfg.StandardPgSuperPassword
        Log 'No -PgSuperPassword supplied; will try the standard appliance password (then prompt if needed).'
    }
    if (-not $pgBin) {
        Fail 'PostgreSQL is targeted but psql.exe was not found on this machine. Install the PostgreSQL client tools (or add its bin folder to PATH) so the installer can run migrations, then retry.'
    }
} else {
    Log 'No PostgreSQL found - installing locally.'
    if (-not $cfg.PgSuperPassword) {
        if ($cfg.ContainsKey('StandardPgSuperPassword') -and $cfg.StandardPgSuperPassword) {
            $cfg.PgSuperPassword = $cfg.StandardPgSuperPassword
            Log 'New PostgreSQL will be created with the standard appliance postgres password.'
        } else {
            $cfg.PgSuperPassword = New-Secret 18; Log 'Generated a postgres superuser password (recorded in this log).'
        }
    }
    $exe = Join-Path $env:TEMP "postgresql-$($cfg.PgMajor).exe"
    Get-File $cfg.PgInstallerUrl $exe $cfg.PgInstallerSha256 $cfg.PgInstallerPublisher
    Log 'Installing PostgreSQL unattended (large component - this can take a while; please wait)...'
    $pgInst = New-PgInstallerArgs -SuperPassword $cfg.PgSuperPassword -Port $cfg.PgPort
    $prevPP = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
    try { $p = Start-Process -FilePath $exe -ArgumentList $pgInst.Args -Wait -PassThru }
    finally { $ProgressPreference = $prevPP; Remove-Item -LiteralPath $pgInst.Dir -Recurse -Force -ErrorAction SilentlyContinue }
    if ($p.ExitCode -ne 0) { Fail "PostgreSQL installer failed (exit $($p.ExitCode))." }
    # Wait for the service to actually accept connections, not just a fixed sleep.
    Start-Sleep -Seconds 3
    $pgBin = Find-PgBin
    if (-not $pgBin) { Fail 'PostgreSQL installed but psql.exe not found.' }
    for ($i = 0; $i -lt 15; $i++) { if (Test-PgListening $cfg.PgHost $cfg.PgPort) { break }; Start-Sleep -Seconds 2 }
    Log 'PostgreSQL installed.' 'OK'
    # Remember that THIS installer created the server, so its recommended
    # hardening is applied now and re-applied on later runs. SYSTEM +
    # Administrators only (see Test-PgMarkerTrusted).
    $script:PgCreatedByUs = $true
    try {
        Set-Content -LiteralPath $script:PgMarkerFile -Value (@{ createdBy = 'IDevelop installer'; created = (Get-Date -Format o); port = $cfg.PgPort; major = $cfg.PgMajor } | ConvertTo-Json -Compress) -Encoding ASCII
        # Owner = Administrators explicitly: on a Windows client the default owner
        # is the creating user, and only an administrator can hand a file to the
        # Administrators group (what Test-PgMarkerTrusted checks).
        & icacls.exe $script:PgMarkerFile /setowner '*S-1-5-32-544' /Q *> $null
        & icacls.exe $script:PgMarkerFile /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' /Q *> $null
    } catch { Log "Could not write $($script:PgMarkerFile): $($_.Exception.Message)" 'WARN' }
}
$psql = Join-Path $pgBin 'psql.exe'
# Ensure psql's bin is on PATH for this session (the environment header showed
# 'psql : not on PATH' even when PG was present - this makes it consistent for
# any child process and for re-runs).
if ($env:Path -notlike "*$pgBin*") { $env:Path = "$pgBin;$env:Path" }
Log "Using psql: $psql"

# ---------------------------------------------------------------------------
# STEP 4/7 - Database, role, extensions, privileges (idempotent, PG 15+ aware)
# ---------------------------------------------------------------------------
Set-Step 4 'Database setup'
Log 'STEP 4/7 - Database setup' 'STEP'
# On repair / upgrade, if a valid .env already exists, reuse the DB password it
# contains so the role password we set below stays in sync with what the app
# will use. Otherwise generate a fresh one. This prevents a repair from locking
# the app out by resetting the role to a new password the preserved .env doesn't have.
if (-not $cfg.DbPassword) {
    $envFileEarly = Join-Path $cfg.InstallDir '.env'
    $reusedPw = $null
    if (Test-Path $envFileEarly) {
        $envRawEarly = Get-Content $envFileEarly -Raw
        $m = [regex]::Match($envRawEarly, 'postgres://[^:]+:([^@]+)@')
        if ($m.Success) { $reusedPw = [Uri]::UnescapeDataString($m.Groups[1].Value) }
    }
    if ($reusedPw) { $cfg.DbPassword = $reusedPw; Log 'Reusing DB password from the existing .env (keeps role + app in sync).' }
    else { $cfg.DbPassword = New-Secret 18 }
}
$env:PGPASSWORD = $cfg.PgSuperPassword
if ($cfg.PgSsl) { $env:PGSSLMODE = 'require' }

# Scrub any known secret value out of a string before it reaches the console/log/
# transcript. psql echoes the offending `LINE 1: ...` on a syntax error, which for an
# `ALTER ROLE ... PASSWORD '...'` would otherwise print the password verbatim.
function Hide-Secrets([string]$s) {
    if (-not $s) { return $s }
    foreach ($sec in @($cfg.PgSuperPassword, $cfg.DbPassword)) {
        if ($sec) { $s = $s -replace [regex]::Escape($sec), '***' }
    }
    return $s
}

# SQL THAT CARRIES A SECRET (ALTER/CREATE ROLE ... PASSWORD) goes through
# psql's STANDARD INPUT, never its command line: an argv is readable by any
# process that can query this one (and lands in crash dumps and EDR process
# logs). The SQL is written as UTF-8 bytes (no BOM) to stdin ('-f -'); the
# connection password stays in PGPASSWORD (environment, not argv).
# Returns @{ Code; Out }.
function Format-NativeArg([string]$a) {
    if ($a -ne '' -and $a -notmatch '[\s"]') { return $a }
    return '"' + (($a -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}
function Invoke-PsqlStdin([string]$Exe, [string[]]$ArgList, [string]$Sql) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.Arguments = (@($ArgList) | ForEach-Object { Format-NativeArg "$_" }) -join ' '
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.EnvironmentVariables['PGCLIENTENCODING'] = 'UTF8'
    # .NET Framework builds the child's stdin writer from [Console]::InputEncoding
    # and writes that encoding's preamble at once: a UTF-8 console would put a BOM
    # in front of the SQL. Start the child under a BOM-less UTF-8 input encoding,
    # then restore the console's own.
    $prevIn = $null
    try { $prevIn = [Console]::InputEncoding; [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { $prevIn = $null }
    try { $p = [System.Diagnostics.Process]::Start($psi) }
    finally { if ($prevIn) { try { [Console]::InputEncoding = $prevIn } catch {} } }
    $errTask = $p.StandardError.ReadToEndAsync()
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($Sql + "`n")
    $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $p.StandardInput.BaseStream.Flush()
    $p.StandardInput.Close()
    $p.WaitForExit()
    return [pscustomobject]@{ Code = $p.ExitCode; Out = (($outTask.Result + $errTask.Result).Trim()) }
}
function PsqlSecret([string]$db, [string]$sql) {
    $r = Invoke-PsqlStdin $psql @('-h', $cfg.PgHost, '-p', "$($cfg.PgPort)", '-U', 'postgres', '-d', $db, '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-') $sql
    if ($r.Code -ne 0) { Fail ("psql failed on [$db]: " + (Hide-Secrets $r.Out)) }
    return $r.Out
}

function Psql([string]$db, [string]$sql) {
    # psql emits NOTICE/WARNING to stderr; under ErrorActionPreference=Stop that
    # would abort even on success. Relax locally and decide by exit code only.
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        $out = & $psql -h $cfg.PgHost -p $cfg.PgPort -U postgres -d $db -t -A -v ON_ERROR_STOP=1 -c $sql 2>&1
        if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $prevEAP; Fail ("psql failed on [$db]: " + (Hide-Secrets ("$out"))) }
        return ($out | Out-String).Trim()
    } finally { $ErrorActionPreference = $prevEAP }
}

# Structural proof that a snapshot import (or a restore) actually landed: the
# tables the product cannot start without must exist AND hold rows. Returns
# @{ missing = <names>; summary = 'employees=N skills=N admins=N schema_meta=N' }.
# A snapshot is a full pg_dump of a working instance, so every one of these is
# non-empty in a good import; an empty one means the COPY block failed.
function Test-ImportedSnapshot([string]$db) {
    $missing = @(); $parts = @()
    foreach ($t in @('employees', 'skills', 'admins', 'schema_meta')) {
        $n = -1
        try {
            $exists = Psql $db "SELECT (to_regclass('public.$t') IS NOT NULL)::int"
            if ($exists -eq '1') { $n = [int](Psql $db "SELECT count(*) FROM public.$t") }
        } catch { $n = -1 }
        if ($n -le 0) { $missing += $t }
        $parts += "$t=$(if ($n -lt 0) { 'absent' } else { $n })"
    }
    return @{ missing = $missing; summary = ($parts -join ' ') }
}

# Run a MULTI-LINE / comment-bearing SQL script via a temp file + `psql -f`.
# CRITICAL: never pass such SQL through `Psql` (`-c`). Windows PowerShell 5.1 mangles
# embedded double quotes and newlines when building a native-command argument, so a
# comment like  -- ... "must be owner of function" ...  gets split into stray argv
# tokens and psql sees an "unterminated dollar-quoted string". `-f` reads the SQL
# from the file verbatim and is immune to all shell quoting. Used for the ownership
# reconcile DO-blocks (which carry comments). Same technique as Manage restore.
function PsqlFile([string]$db, [string]$sql) {
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $tmp = Join-Path $env:TEMP 'idevelop-reown.sql'
    try {
        Set-Content -LiteralPath $tmp -Value $sql -Encoding UTF8
        $out = & $psql -h $cfg.PgHost -p $cfg.PgPort -U postgres -d $db -t -A -v ON_ERROR_STOP=1 -f $tmp 2>&1
        if ($LASTEXITCODE -ne 0) { $ErrorActionPreference = $prevEAP; Fail "psql failed on [$db]: $out" }
        return ($out | Out-String).Trim()
    } finally {
        $ErrorActionPreference = $prevEAP
        Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
# AUDIT-TRAIL OWNERSHIP (3.23.18, S-06). The append-only / hash-chained tables
# (every table carrying a block_mutation / block_truncate / hash-chain trigger:
# system_logs, assessment_history, review_signatures, self_assessment_events...)
# were OWNED by the app role, and an owner can ALTER TABLE ... DISABLE TRIGGER,
# DROP TRIGGER, or CREATE OR REPLACE the guard function itself - so a SQL
# injection or a stolen DATABASE_URL could rewrite history. This moves those
# tables AND their guard functions to a NOLOGIN role and leaves the app role
# SELECT + INSERT (+ USAGE on their sequences) only. Idempotent; a non-superuser
# session only WARNs. Opt-in (config.psd1 AuditOwnerSeparation) because four
# SuperAdmin tools suspend these triggers as the app role (Danger-Zone cleanup,
# data reset, snapshot restore, SQL-console revert) and are refused while it is
# on. The ownership reconcile before the migrations hands the tables back to the
# app role for the migration pass; this runs again right after it.
# Single quotes only: the text goes through psql -f, but no double quotes by rule.
# ---------------------------------------------------------------------------
$script:AuditOwnerRole = 'idevelop_audit_owner'
# Earlier installers created the role under a name inherited from the product
# IDevelop was derived from; it is renamed in place (ownerships and grants are
# kept). Assembled from two parts so the repository carries no trace of that
# name (tests/unit/brandTokensAbsent.test.js). Migration 169 does the same.
$script:LegacyAuditOwnerRole = 'four' + 'mp_audit_owner'
function Get-AuditOwnerSql([string]$Owner, [string]$App, [string]$Legacy = '') {
    $sql = @'
DO $audit$
DECLARE
  r record; s record; n int := 0; t text;
  own text := '__OWNER__'; app text := '__APP__'; legacy text := '__LEGACY__';
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE WARNING 'AUDIT_OWNER_SKIPPED: % is not a superuser - the audit tables stay owned by the app role', current_user;
    RETURN;
  END IF;
  IF legacy <> '' AND legacy <> own
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = legacy)
     AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = own) THEN
    EXECUTE format('ALTER ROLE %I RENAME TO %I', legacy, own);
    RAISE NOTICE 'AUDIT_OWNER_RENAMED: legacy audit owner role renamed to %', own;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = own) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN', own);
  END IF;
  -- The guard functions first: an owner could CREATE OR REPLACE them into no-ops.
  -- + the audit-log redaction / purge / seal functions and their helpers
  -- (migration 170): the SECURITY DEFINER ones work on system_logs, so they must
  -- belong to its owner, or every GDPR erasure (redaction) is refused and fails
  -- closed; the helpers decide what block_mutation lets through, so the app role
  -- must not be able to replace them.
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
            WHERE ns.nspname = 'public' AND p.proname IN ('block_mutation', 'block_truncate', 'fn_system_logs_hashchain',
                  'fn_system_logs_redact', '_fn_system_logs_redact_flush', 'fn_system_logs_purge', 'fn_system_logs_seal',
                  'fn_system_logs_mutation_allowed', 'fn_system_logs_rowhash') LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I', r.sig, own);
  END LOOP;
  -- A change of owner hands the OLD owner's privileges to the new one. Migration
  -- 170 revoked EXECUTE on the writing functions from PUBLIC and left it to the
  -- app role as their owner, so after the move the app could no longer call
  -- them ('permission denied for function fn_system_logs_redact'): EXECUTE is
  -- granted back on exactly the functions the app calls.
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
            WHERE ns.nspname = 'public' AND p.proname IN ('fn_system_logs_redact', 'fn_system_logs_purge', 'fn_system_logs_seal') LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', r.sig, app);
  END LOOP;
  FOR r IN SELECT DISTINCT c.oid, c.relname
             FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid
             JOIN pg_namespace ns ON ns.oid = c.relnamespace
             JOIN pg_proc p ON p.oid = t.tgfoid
            WHERE ns.nspname = 'public' AND NOT t.tgisinternal
              AND p.proname IN ('block_mutation', 'block_truncate', 'fn_system_logs_hashchain') LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO %I', r.relname, own);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', r.relname, app);
    EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO %I', r.relname, app);
    -- serial / identity sequences follow the table owner; the app still needs nextval.
    FOR s IN SELECT q.oid::regclass AS seq FROM pg_class q JOIN pg_depend d ON d.objid = q.oid
              WHERE q.relkind = 'S' AND d.refobjid = r.oid AND d.deptype IN ('a', 'i') LOOP
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', s.seq, app);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO %I', s.seq, app);
    END LOOP;
    n := n + 1;
  END LOOP;
  -- The SECURITY DEFINER functions above run AS the owner role and read ordinary
  -- tables it does not own: fn_system_logs_redact and fn_system_logs_mutation_allowed
  -- check employees.erased_at; fn_system_logs_purge reads the legal holds
  -- (employees.legal_hold_at, pii_cleanup_jobs, admins.linked_employee_id).
  -- Without SELECT every GDPR erasure fails with 'permission denied'. Keep this
  -- list in step with what those functions read (a test compares them).
  FOREACH t IN ARRAY ARRAY['employees', 'admins', 'pii_cleanup_jobs'] LOOP
    IF to_regclass('public.' || quote_ident(t)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO %I', t, own);
    END IF;
  END LOOP;
  RAISE NOTICE 'AUDIT_OWNER_APPLIED: % table(s) owned by %, app role % limited to SELECT + INSERT', n, own, app;
END $audit$;
'@
    return $sql.Replace('__OWNER__', $Owner).Replace('__APP__', $App).Replace('__LEGACY__', $Legacy)
}

# Connectivity preflight - robust. Try each candidate superuser password, and if
# none work, PROMPT for the real current one before giving up. This is what makes
# the first upgrade of an existing (non-standardized) PostgreSQL work: we must
# connect with the CURRENT password before we can change it to the standard.
function Test-PgProbe([string]$pw) {
    $env:PGPASSWORD = $pw
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $out = & $psql -h $cfg.PgHost -p $cfg.PgPort -U postgres -d postgres -t -A -c 'SELECT version()' 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    return [pscustomobject]@{ ok = ($code -eq 0); out = ($out | Out-String).Trim() }
}

# Wait until PostgreSQL accepts a (trust) connection after a restart.
function Wait-PgReady([int]$tries = 20) {
    for ($i = 0; $i -lt $tries; $i++) {
        $env:PGPASSWORD = ''
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        & $psql -h 127.0.0.1 -p $cfg.PgPort -U postgres -d postgres -t -A -c 'SELECT 1' *> $null
        $ok = ($LASTEXITCODE -eq 0); $ErrorActionPreference = $prev
        if ($ok) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

# The temporary 'trust' window is NEVER opened silently.
#   -AllowPasswordRecovery         -> allowed (the operator said so on the command line)
#   interactive console            -> asked; only the typed word TRUST allows it
#   unattended (no console/stdin)  -> refused; the caller FAILS with a clear message
# Returns @{ Granted; Mode = switch | interactive | declined | unattended }.
function Resolve-TrustWindowConsent([bool]$Allowed, [bool]$Interactive, [scriptblock]$Ask) {
    if ($Allowed) { return [pscustomobject]@{ Granted = $true; Mode = 'switch' } }
    if (-not $Interactive) { return [pscustomobject]@{ Granted = $false; Mode = 'unattended' } }
    $ans = ''
    try { $ans = "$(& $Ask)".Trim() } catch { $ans = '' }
    if ($ans -ceq 'TRUST') { return [pscustomobject]@{ Granted = $true; Mode = 'interactive' } }
    return [pscustomobject]@{ Granted = $false; Mode = 'declined' }
}
# Every decision about the window, and every opening / closing of it, is written
# to the install log AND to a dedicated ledger
# (%ProgramData%\IDevelop\logs\pg-trust-window.log) that outlives the per-run logs.
function Write-TrustWindowAudit([string]$Event, [string]$Detail) {
    $who = "$env:USERDOMAIN\$env:USERNAME"
    try { $who = [Security.Principal.WindowsIdentity]::GetCurrent().Name } catch {}
    Log "PG TRUST WINDOW - $Event - $Detail" 'WARN'
    try {
        $dir = Join-Path $LogDir 'logs'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Add-Content -LiteralPath (Join-Path $dir 'pg-trust-window.log') -Value ('{0} | {1} | {2} | {3} | {4}' -f (Get-Date -Format o), $env:COMPUTERNAME, $who, $Event, $Detail)
    } catch {}
}

# Reset an UNKNOWN local postgres password to $targetPw using the standard
# forgotten-password recovery: temporarily switch pg_hba.conf loopback auth to
# 'trust', restart PostgreSQL, ALTER the password, then RESTORE pg_hba.conf and
# restart again. Local PG + admin only (both hold here). Returns $true on success.
# pg_hba.conf is always restored (even on error) so PG is never left open.
# Only after Resolve-TrustWindowConsent granted it; the trust lines are narrowed
# to database 'postgres' / user 'postgres' on loopback, and the new password
# travels through psql's stdin (never its command line).
function Reset-PgSuperViaTrust([string]$targetPw) {
    $bak = $null; $hba = $null; $svcName = $null
    try {
        $svc = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' } | Select-Object -First 1
        if (-not $svc) { $svc = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1 }
        if ($svc) { $svcName = $svc.Name }
        $pgBinDir = Split-Path $psql -Parent
        $dataDir = $null
        if ($svcName) {
            $wmi = Get-CimInstance Win32_Service -Filter "Name='$svcName'" -ErrorAction SilentlyContinue
            if ($wmi -and $wmi.PathName -match '-D\s+"?([^"]+?data)"?') { $dataDir = $Matches[1] }
        }
        if (-not $dataDir) {
            $guess = Join-Path (Split-Path $pgBinDir -Parent) 'data'
            if (Test-Path (Join-Path $guess 'pg_hba.conf')) { $dataDir = $guess }
        }
        if (-not $dataDir) { Log 'Auto-reset: could not locate the PostgreSQL data directory (pg_hba.conf).' 'WARN'; return $false }
        $hba = Join-Path $dataDir 'pg_hba.conf'
        if (-not (Test-Path $hba)) { Log "Auto-reset: pg_hba.conf not found ($hba)." 'WARN'; return $false }
        if (-not $svcName) { Log 'Auto-reset: PostgreSQL Windows service not found (needed to restart).' 'WARN'; return $false }

        Log "Auto-resetting the unknown 'postgres' password to the standard value (temporary trust on $hba, ~10s)..." 'STEP'
        $bak = "$hba.idevelop-bak"
        Copy-Item -LiteralPath $hba -Destination $bak -Force
        $orig = Get-Content -LiteralPath $hba -Raw
        $trust = "# IDevelop installer - TEMPORARY trust (auto-removed)`r`nhost postgres postgres 127.0.0.1/32 trust`r`nhost postgres postgres ::1/128 trust`r`n# end temporary`r`n"
        Set-Content -LiteralPath $hba -Value ($trust + $orig) -Encoding ASCII
        Write-TrustWindowAudit 'OPENED' "$hba (loopback, database/user postgres only)"

        Restart-Service -Name $svcName -Force -ErrorAction Stop
        [void](Wait-PgReady 25)

        $env:PGPASSWORD = ''
        $lit = $targetPw -replace "'", "''"
        $alt = Invoke-PsqlStdin $psql @('-h', '127.0.0.1', '-p', "$($cfg.PgPort)", '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', '-') "ALTER ROLE postgres WITH PASSWORD '$lit'"
        $altOk = ($alt.Code -eq 0); $altOut = $alt.Out

        # Restore pg_hba.conf + restart (removes trust) no matter the ALTER outcome.
        Copy-Item -LiteralPath $bak -Destination $hba -Force
        Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue; $bak = $null
        Restart-Service -Name $svcName -Force -ErrorAction SilentlyContinue
        [void](Wait-PgReady 25)
        Write-TrustWindowAudit 'CLOSED' "$hba restored (password reset $(if ($altOk) { 'succeeded' } else { 'FAILED' }))"

        if ($altOk) { Log 'postgres password reset to the standard appliance value; loopback trust removed.' 'OK'; return $true }
        Log ("Auto-reset: ALTER ROLE did not confirm success (" + (Hide-Secrets ("$altOut")) + ").") 'WARN'; return $false
    } catch {
        Log "Auto-reset error: $($_.Exception.Message). Restoring pg_hba.conf." 'WARN'
        try { if ($bak -and $hba -and (Test-Path $bak)) { Copy-Item -LiteralPath $bak -Destination $hba -Force; Remove-Item $bak -Force -ErrorAction SilentlyContinue; Write-TrustWindowAudit 'CLOSED' "$hba restored after an error" } } catch {}
        try { if ($svcName) { Restart-Service -Name $svcName -Force -ErrorAction SilentlyContinue; [void](Wait-PgReady 20) } } catch {}
        return $false
    }
}

# READ-ONLY check of pg_hba.conf for 'trust' entries. A 'trust' line lets anyone
# who reaches that address log in as any role without a password - on a
# database of HR data. Lines inside our own marked block (the installer's
# temporary recovery window) are ignored; everything else is reported. Returns
# the offending lines as @{ Line; Text }. Nothing is ever changed.
function Get-PgHbaTrustLines([string]$Text) {
    $hits = @()
    $inOurs = $false
    $n = 0
    foreach ($raw in ($Text -split "`r?`n")) {
        $n++
        $t = $raw.Trim()
        if ($t -like '# IDevelop installer - TEMPORARY trust*') { $inOurs = $true; continue }
        if ($inOurs) { if ($t -like '# end temporary*') { $inOurs = $false }; continue }
        $body = ($t -replace '#.*$', '').Trim()
        if (-not $body) { continue }
        $tok = @($body -split '\s+')
        $method = $null
        if ($tok[0] -eq 'local') { if ($tok.Count -ge 4) { $method = $tok[3] } }
        elseif ($tok[0] -like 'host*') {
            # host DB USER ADDRESS [MASK] METHOD - a bare IPv4/IPv6 mask shifts the method.
            if ($tok.Count -ge 6 -and $tok[4] -match '^[0-9a-fA-F:.]+$' -and $tok[3] -notmatch '/') { $method = $tok[5] }
            elseif ($tok.Count -ge 5) { $method = $tok[4] }
        }
        if ($method -and $method.ToLowerInvariant() -eq 'trust') { $hits += [pscustomobject]@{ Line = $n; Text = $t } }
    }
    return , $hits
}

# ---------------------------------------------------------------------------
# RECOMMENDED POSTGRESQL HARDENING.
#   log_connections / log_disconnections = on, a log_line_prefix naming the user,
#   the database and the client address, CONNECT on the application database for
#   the app role only (REVOKE ... FROM PUBLIC), and listen_addresses = 'localhost'
#   ONLY when the app reaches PostgreSQL on a loopback address (co-located).
# On a server this installer CREATED: applied automatically. On any other server
# (we do not own it; changing it silently can break other applications): WARN,
# then ask at the console, or apply only with -ApplyPgHardening. Every run writes
# a report (checked / applied / to do + the pg_hba.conf 'trust' check) to the log.
# pg_hba.conf itself is NEVER changed by Setup.
# ---------------------------------------------------------------------------
function Test-LoopbackHost([string]$HostName) {
    $x = "$HostName".Trim().Trim('[', ']').ToLowerInvariant()
    return ($x -eq 'localhost' -or $x -eq '::1' -or $x -match '^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$')
}
function Get-PgHardeningPlan($Current, [bool]$PublicCanConnect, [bool]$CoLocated, [string]$DbName, [string]$AppRole) {
    $qi = { param($n) '"' + ("$n" -replace '"', '""') + '"' }
    $on = { param($v) ("$v".Trim().ToLowerInvariant() -notin @('', 'off', 'false', '0', 'no')) }
    $item = {
        param($key, $cur, $rec, $offered, $needed, $restart, $sql, $note)
        [pscustomobject]@{ Key = $key; Current = "$cur"; Recommended = $rec; Offered = [bool]$offered; Needed = [bool]($offered -and $needed)
                           Restart = [bool]$restart; Sql = @($sql); Note = $note; Status = ''; Error = '' }
    }
    $items = @()
    foreach ($k in @('log_connections', 'log_disconnections')) {
        $cur = $Current[$k]
        $items += (& $item $k $cur 'on' $true (-not (& $on $cur)) $false @("ALTER SYSTEM SET $k = 'on'") 'who connected / disconnected, and when')
    }
    $prefix = '%m [%p] user=%u,db=%d,client=%h '
    $lp = "$($Current['log_line_prefix'])"
    $items += (& $item 'log_line_prefix' $lp $prefix $true (-not ($lp -match '%u' -and $lp -match '%d' -and $lp -match '%h')) $false @("ALTER SYSTEM SET log_line_prefix = '$($prefix -replace "'", "''")'") 'every log line names the user, the database and the client address')
    $items += (& $item "CONNECT ON DATABASE $DbName" $(if ($PublicCanConnect) { 'PUBLIC (every role)' } else { 'granted roles only' }) "$AppRole only" $true $PublicCanConnect $false @(
            "GRANT CONNECT ON DATABASE $(& $qi $DbName) TO $(& $qi $AppRole)",
            "REVOKE CONNECT ON DATABASE $(& $qi $DbName) FROM PUBLIC") 'no other login role of this server can open the HR database')
    $la = "$($Current['listen_addresses'])"
    $exposed = @(@($la -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not (Test-LoopbackHost $_) })
    if ($CoLocated) {
        $items += (& $item 'listen_addresses' $la 'localhost' $true ($exposed.Count -gt 0) $true @("ALTER SYSTEM SET listen_addresses = 'localhost'") 'the app and PostgreSQL are on this machine: nothing else needs to reach PostgreSQL over the network')
    } else {
        $items += (& $item 'listen_addresses' $la 'localhost' $false $false $true @() 'not offered: the app reaches PostgreSQL through a non-loopback address (PgHost), so PostgreSQL must keep listening on the network')
    }
    return $items
}
# Created by us -> applied; -ApplyPgHardening -> applied; console -> asked; else report only.
function Resolve-PgHardeningConsent([bool]$CreatedByUs, [bool]$Switch, [bool]$CanAsk, [scriptblock]$Ask) {
    if ($CreatedByUs) { return [pscustomobject]@{ Granted = $true; Mode = 'created' } }
    if ($Switch) { return [pscustomobject]@{ Granted = $true; Mode = 'switch' } }
    if (-not $CanAsk) { return [pscustomobject]@{ Granted = $false; Mode = 'unattended' } }
    $ans = ''
    try { $ans = "$(& $Ask)" } catch { $ans = '' }
    if (Test-YesAnswer $ans) { return [pscustomobject]@{ Granted = $true; Mode = 'interactive' } }
    return [pscustomobject]@{ Granted = $false; Mode = 'declined' }
}
# Applies each needed item on its own (a refused ALTER SYSTEM on a managed server
# must not hide that the REVOKE worked) and sets Status: OK | APPLIED | FAILED |
# TO DO | NOT OFFERED. $RunSql {param($sql)} -> @{ Code; Out } (psql via stdin).
function Invoke-PgHardening($Items, [bool]$Granted, [scriptblock]$RunSql) {
    $reload = $false
    foreach ($it in @($Items)) {
        if (-not $it.Offered) { $it.Status = 'NOT OFFERED'; continue }
        if (-not $it.Needed) { $it.Status = 'OK'; continue }
        if (-not $Granted) { $it.Status = 'TO DO'; continue }
        $r = & $RunSql ((@($it.Sql) -join ";`n") + ';')
        # A reloadable ALTER SYSTEM setting (log_*) needs pg_reload_conf(); GRANT /
        # REVOKE act at once; listen_addresses needs a restart, not a reload.
        if ($r -and $r.Code -eq 0) { $it.Status = 'APPLIED'; if ($it.Key -like 'log_*') { $reload = $true } }
        else { $it.Status = 'FAILED'; $it.Error = "$(if ($r) { $r.Out })".Trim() }
    }
    if ($reload) { [void](& $RunSql 'SELECT pg_reload_conf();') }
    return @($Items)
}
function Get-PgHardeningReport($Items, $HbaTrust, [string]$HbaFile, [string]$ConsentMode, [bool]$CreatedByUs, [string]$Target) {
    $l = @()
    $l += "PostgreSQL hardening report - server $Target, created by this installer: $(if ($CreatedByUs) { 'yes' } else { 'no' }), decision: $ConsentMode"
    foreach ($it in @($Items)) {
        $st = if ($it.Status) { $it.Status } else { '?' }
        $line = '  [{0}] {1}: {2}' -f $st, $it.Key, $(if ($it.Current) { $it.Current } else { '(empty)' })
        if ($st -in @('APPLIED', 'TO DO', 'FAILED')) { $line += " -> $($it.Recommended)" }
        $line += " ($($it.Note))"
        if ($st -eq 'FAILED' -and $it.Error) { $line += " - $($it.Error)" }
        $l += $line
    }
    if ($null -eq $HbaTrust) { $l += '  [NOT CHECKED] pg_hba.conf trust entries (neither the file nor pg_hba_file_rules could be read)' }
    elseif (@($HbaTrust).Count) {
        $l += "  [TO DO] pg_hba.conf ($HbaFile): $(@($HbaTrust).Count) 'trust' entr$(if (@($HbaTrust).Count -eq 1) { 'y' } else { 'ies' }) - replace with scram-sha-256 and reload (never changed by Setup):"
        foreach ($h in @($HbaTrust)) { $l += "      $h" }
    } else { $l += '  [OK] pg_hba.conf: no trust entries' }
    $todo = @(@($Items) | Where-Object { $_.Status -eq 'TO DO' }).Count
    if ($todo -and $ConsentMode -in @('unattended', 'declined')) {
        $l += "  $todo recommendation(s) not applied: re-run with -ApplyPgHardening (or answer Y at the console) to apply them."
    }
    return $l
}

$pgCandidates = New-Object System.Collections.Generic.List[string]
foreach ($p in @($PgSuperPassword, $cfg.PgSuperPassword, $cfg.StandardPgSuperPassword)) {
    if ($p -and -not $pgCandidates.Contains($p)) { $pgCandidates.Add($p) }
}
$pgConnected = $false; $pgWorkingPw = $null; $pgVer = ''; $pgLastErr = 'no password to try'
foreach ($cand in $pgCandidates) {
    $r = Test-PgProbe $cand
    if ($r.ok) { $pgConnected = $true; $pgWorkingPw = $cand; $pgVer = $r.out; break }
    $pgLastErr = $r.out
}
if (-not $pgConnected) {
    Log "Could not authenticate as 'postgres' with the supplied/standard password." 'WARN'
    # LOCAL PostgreSQL with an unknown password: rather than abort, AUTO-RESET it to
    # the standard appliance value (forgotten-password recovery) so the install can
    # proceed unattended. This is the primary path for appliance machines whose
    # original postgres password is lost.
    # THE AUTO-RESET IS ARMED ONLY WHEN NO DISTINCT PASSWORD WAS SUPPLIED. An
    # operator who typed a password that does not work most likely typed it
    # wrong (or a launcher mangled it - cmd.exe used to eat the '!'); replacing
    # the real postgres password on the strength of a typo is not recovery, it is
    # a lockout of every other client of this server. So: nothing supplied, or
    # only the standard value from config.psd1 -> unattended reset as before;
    # a distinct supplied password -> ask, and abort silently when nobody answers.
    $distinctSupplied = $PgSuperPassword -and ($PgSuperPassword -ne $cfg.StandardPgSuperPassword)
    $armReset = $isLocalPg -and $cfg.StandardPgSuperPassword
    $trustConsented = $false
    if ($armReset -and $distinctSupplied) {
        Log 'A postgres password was SUPPLIED and it does not work. The automatic reset of the postgres password is NOT armed for a supplied value (a mistyped password must not overwrite the real one).' 'WARN'
        $ans = ''
        try { $ans = Read-Host "  Type RESET to replace the postgres password with the standard appliance value anyway (anything else: keep the current password)" } catch { $ans = '' }
        $armReset = ($ans -eq 'RESET')
        if ($armReset) { Log 'Operator confirmed the postgres password reset.' 'WARN'; $trustConsented = $true; Write-TrustWindowAudit 'CONSENT' 'operator typed RESET at the console' }
        else { Log 'postgres password left untouched (no confirmation).' }
    }
    # The reset needs a temporary pg_hba.conf 'trust' window. It is opened only
    # with -AllowPasswordRecovery or an operator's typed TRUST; an unattended run
    # stops here with the reason instead of opening it silently.
    if ($armReset -and -not $trustConsented) {
        $consent = Resolve-TrustWindowConsent $AllowPasswordRecovery.IsPresent (Test-InteractiveSession) {
            Write-Host ''
            Write-Host "  The 'postgres' password of this LOCAL PostgreSQL is unknown. Setup can reset it to the" -ForegroundColor Yellow
            Write-Host "  standard appliance value by opening a temporary pg_hba.conf 'trust' window (~10 s," -ForegroundColor Yellow
            Write-Host "  loopback only, database/user postgres only); pg_hba.conf is restored right after." -ForegroundColor Yellow
            Read-Host "  Type TRUST to allow it (anything else: do not touch pg_hba.conf)"
        }
        switch ($consent.Mode) {
            'switch'      { Write-TrustWindowAudit 'CONSENT' 'operator passed -AllowPasswordRecovery' }
            'interactive' { Write-TrustWindowAudit 'CONSENT' 'operator typed TRUST at the console' }
            'declined'    { Write-TrustWindowAudit 'REFUSED' 'operator did not type TRUST - pg_hba.conf left untouched' }
            'unattended'  {
                Write-TrustWindowAudit 'REFUSED' 'unattended run without -AllowPasswordRecovery - pg_hba.conf left untouched'
                Fail ("Cannot authenticate as 'postgres' on the LOCAL PostgreSQL and this run is UNATTENDED. Recovering the password needs a temporary pg_hba.conf 'trust' window (~10 s, loopback only), which is never opened silently. " +
                      "Either supply the current password (SETUP_PG_SUPER_PASSWORD environment variable or -PgSuperPassword), or re-run with -AllowPasswordRecovery to allow the recovery (it is logged in %ProgramData%\IDevelop\logs\pg-trust-window.log), or run Setup interactively to be asked.")
            }
        }
        $armReset = $consent.Granted
    }
    if ($armReset) {
        if (Reset-PgSuperViaTrust $cfg.StandardPgSuperPassword) {
            $r = Test-PgProbe $cfg.StandardPgSuperPassword
            if ($r.ok) { $pgConnected = $true; $pgWorkingPw = $cfg.StandardPgSuperPassword; $pgVer = $r.out }
            else { $pgLastErr = $r.out }
        }
    }
}
if (-not $pgConnected) {
    # Still stuck (remote PG we can't reset, or the reset didn't take): offer a
    # manual password entry before giving up.
    Log 'Falling back to a manual password prompt.' 'WARN'
    for ($try = 1; $try -le 3 -and -not $pgConnected; $try++) {
        $entered = $null
        try {
            $sec = Read-Host -AsSecureString "  Enter the CURRENT 'postgres' superuser password (attempt $try/3; blank to abort)"
            if ($sec -and $sec.Length -gt 0) { $entered = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)) }
        } catch { $entered = $null }
        if (-not $entered) { break }
        $r = Test-PgProbe $entered
        if ($r.ok) { $pgConnected = $true; $pgWorkingPw = $entered; $pgVer = $r.out }
        else { Log 'Authentication failed - check the password and try again.' 'WARN'; $pgLastErr = $r.out }
    }
}
if (-not $pgConnected) {
    Fail "Cannot connect to PostgreSQL at $($cfg.PgHost):$($cfg.PgPort) as 'postgres'. Reason: $pgLastErr`n  - For a LOCAL PostgreSQL the installer tried to auto-reset the password but could not (check that the PostgreSQL service + data directory are accessible).`n  - Re-run and supply the correct current password: -PgSuperPassword ""<postgres password>"".`n  - Or check the port and pg_hba.conf.$( if (-not $cfg.PgSsl) { "`n  - If this PostgreSQL requires TLS, re-run with -PgSsl." } )"
}
$cfg.PgSuperPassword = $pgWorkingPw
$env:PGPASSWORD = $pgWorkingPw
Log "Connected. $pgVer" 'OK'
# Parse server major for version-specific grants.
$pgServerMajor = 0
if ($pgVer -match 'PostgreSQL (\d+)') { $pgServerMajor = [int]$Matches[1] }

# Warn LOUDLY about 'trust' authentication (read-only; never changed). Not Psql:
# that one Fail()s the step, and a diagnostic must never fail the run.
function Get-PsqlText([string]$db, [string]$sql) {
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        $o = & $psql -h $cfg.PgHost -p $cfg.PgPort -U postgres -d $db -t -A -c $sql 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        return ($o | Out-String).Trim()
    } finally { $ErrorActionPreference = $prevEAP }
}
$script:PgHbaTrust = $null; $script:PgHbaFile = $null   # $null = not checked
try {
    $hbaTrust = @()
    $hbaFile = Get-PsqlText 'postgres' 'SHOW hba_file'
    if ($isLocalPg -and $hbaFile -and (Test-Path -LiteralPath $hbaFile)) {
        $hbaTrust = Get-PgHbaTrustLines ([System.IO.File]::ReadAllText($hbaFile))
        $hbaTrust = @($hbaTrust | ForEach-Object { "line $($_.Line): $($_.Text)" })
    } elseif ($pgServerMajor -ge 10) {
        $rows = Get-PsqlText 'postgres' "SELECT line_number || ': ' || type || ' ' || array_to_string(database, ',') || ' ' || array_to_string(user_name, ',') || ' ' || coalesce(address, '') FROM pg_hba_file_rules WHERE auth_method = 'trust'"
        $hbaTrust = @(("$rows" -split "`r?`n") | Where-Object { $_.Trim() } | ForEach-Object { "line $_" })
    }
    $script:PgHbaTrust = @($hbaTrust); $script:PgHbaFile = $hbaFile
    if ($hbaTrust.Count) {
        Log "SECURITY: pg_hba.conf ($hbaFile) has $($hbaTrust.Count) 'trust' entr$(if ($hbaTrust.Count -eq 1) { 'y' } else { 'ies' }) - anyone reaching those addresses logs in to PostgreSQL WITHOUT a password, as any role, including the HR database. Replace 'trust' with 'scram-sha-256' and reload PostgreSQL (Setup does not change a server's authentication itself):" 'WARN'
        foreach ($l in $hbaTrust) { Log "    $l" 'WARN' }
    } else {
        Log 'pg_hba.conf: no trust authentication entries.' 'OK'
    }
} catch { Log "pg_hba.conf trust check skipped: $($_.Exception.Message)" 'WARN' }

# Standardize the 'postgres' superuser password to the appliance value. We do
# this AFTER authenticating with the current password, so an existing PG is
# changed and a fresh PG is re-affirmed. Every deployment then has a known,
# consistent DB admin credential. Update the live session password too so the
# rest of STEP 4 (role/db/extension creation) keeps working.
if ($cfg.ContainsKey('StandardPgSuperPassword') -and $cfg.StandardPgSuperPassword) {
    if ($cfg.PgSuperPassword -ne $cfg.StandardPgSuperPassword) {
        $stdPwLit = $cfg.StandardPgSuperPassword -replace "'", "''"
        PsqlSecret 'postgres' "ALTER ROLE postgres WITH PASSWORD '$stdPwLit'" | Out-Null
        $cfg.PgSuperPassword = $cfg.StandardPgSuperPassword
        $env:PGPASSWORD = $cfg.PgSuperPassword
        Log "postgres superuser password set to the standard appliance value." 'OK'
    } else {
        Log 'postgres superuser password already matches the standard appliance value.' 'OK'
    }
}

# Role (idempotent). Single-quotes in password are escaped for the SQL literal.
$dbPwLit = $cfg.DbPassword -replace "'", "''"
$roleExists = Psql 'postgres' "SELECT 1 FROM pg_roles WHERE rolname='$($cfg.DbUser)'"
if ($roleExists -ne '1') {
    PsqlSecret 'postgres' "CREATE ROLE ""$($cfg.DbUser)"" LOGIN PASSWORD '$dbPwLit'" | Out-Null
    Log "Created DB role '$($cfg.DbUser)'." 'OK'
} else {
    PsqlSecret 'postgres' "ALTER ROLE ""$($cfg.DbUser)"" LOGIN PASSWORD '$dbPwLit'" | Out-Null
    Log "DB role '$($cfg.DbUser)' exists - password reset." 'OK'
}

# Database (idempotent). CREATE DATABASE can't run in a multi-statement tx, so
# guard with a separate existence check.
$dbExists = Psql 'postgres' "SELECT 1 FROM pg_database WHERE datname='$($cfg.DbName)'"
$freshDb = ($dbExists -ne '1')
if ($freshDb) {
    Psql 'postgres' "CREATE DATABASE ""$($cfg.DbName)"" OWNER ""$($cfg.DbUser)""" | Out-Null
    Log "Created database '$($cfg.DbName)' owned by '$($cfg.DbUser)'." 'OK'
} else {
    Log "Database '$($cfg.DbName)' already exists - reusing." 'OK'
}

# Extensions need superuser; create them so the app's CREATE EXTENSION IF NOT
# EXISTS is a no-op under the less-privileged app role.
foreach ($ext in @('citext', 'pgcrypto', 'pg_trgm', 'unaccent')) {
    Psql $cfg.DbName "CREATE EXTENSION IF NOT EXISTS $ext" | Out-Null
}

# Privileges. On PostgreSQL 15+ the public schema is no longer world-writable,
# so the app role must be granted CREATE on it AND made the schema owner, plus
# default privileges so objects the app creates remain usable. This is the fix
# for the classic "permission denied for schema public" migration failure.
Psql $cfg.DbName "GRANT ALL ON SCHEMA public TO ""$($cfg.DbUser)""" | Out-Null
Psql $cfg.DbName "ALTER SCHEMA public OWNER TO ""$($cfg.DbUser)""" | Out-Null
Psql $cfg.DbName "GRANT ALL ON ALL TABLES IN SCHEMA public TO ""$($cfg.DbUser)""" | Out-Null
Psql $cfg.DbName "GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ""$($cfg.DbUser)""" | Out-Null
Psql $cfg.DbName "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ""$($cfg.DbUser)""" | Out-Null
Psql $cfg.DbName "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ""$($cfg.DbUser)""" | Out-Null
Log "Extensions + privileges applied (server major $pgServerMajor)." 'OK'

# Recommended PostgreSQL hardening + its report. Never fatal.
$script:PgHardeningSummary = $null
try {
    $pgCur = @{}
    foreach ($k in @('log_connections', 'log_disconnections', 'log_line_prefix', 'listen_addresses')) { $pgCur[$k] = Get-PsqlText 'postgres' "SHOW $k" }
    $dbLit = $cfg.DbName -replace "'", "''"
    $pubConnect = ((Get-PsqlText 'postgres' "SELECT has_database_privilege('public', '$dbLit', 'CONNECT')::int") -eq '1')
    $coLocated = Test-LoopbackHost $cfg.PgHost
    $pgItems = Get-PgHardeningPlan $pgCur $pubConnect $coLocated $cfg.DbName $cfg.DbUser
    $pgNeeded = @($pgItems | Where-Object { $_.Needed })
    if ($pgNeeded.Count -and -not $script:PgCreatedByUs) {
        Log "PostgreSQL at $($cfg.PgHost):$($cfg.PgPort) was NOT created by this installer and $($pgNeeded.Count) recommended hardening setting(s) are missing: $(($pgNeeded | ForEach-Object { $_.Key }) -join ', '). Setup never changes a server it did not create without your consent." 'WARN'
    }
    $pgConsent = if ($pgNeeded.Count) {
        Resolve-PgHardeningConsent $script:PgCreatedByUs $ApplyPgHardening.IsPresent (Test-CanAsk) {
            foreach ($it in $pgNeeded) { Write-Host ("    - {0}: {1} -> {2}{3}" -f $it.Key, $(if ($it.Current) { $it.Current } else { '(empty)' }), $it.Recommended, $(if ($it.Restart) { ' (effective at the next PostgreSQL restart)' } else { '' })) -ForegroundColor Yellow }
            $qh = 'Apply the recommended PostgreSQL hardening listed above?'
            Log "QUESTION (answer in the setup CONSOLE window): $qh" 'STEP'
            Read-Host "  $qh [Y/N]"
        }
    } else { [pscustomobject]@{ Granted = $false; Mode = 'nothing to apply' } }
    $runSql = { param($sql) Invoke-PsqlStdin $psql @('-h', $cfg.PgHost, '-p', "$($cfg.PgPort)", '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-') $sql }
    $pgItems = Invoke-PgHardening $pgItems $pgConsent.Granted $runSql
    $listenItem = $pgItems | Where-Object { $_.Key -eq 'listen_addresses' -and $_.Status -eq 'APPLIED' } | Select-Object -First 1
    if ($listenItem) {
        # A server we created is ours to restart now; any other one restarts in its
        # owner's maintenance window (the setting waits in postgresql.auto.conf).
        $pgSvc = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' } | Select-Object -First 1
        if ($script:PgCreatedByUs -and $pgSvc) {
            try {
                Restart-Service -Name $pgSvc.Name -Force -ErrorAction Stop
                $up = $false
                for ($i = 0; $i -lt 30 -and -not $up; $i++) { Start-Sleep -Seconds 1; $up = (Test-PgProbe $cfg.PgSuperPassword).ok }
                $env:PGPASSWORD = $cfg.PgSuperPassword
                $listenItem.Status = if ($up) { 'APPLIED' } else { 'FAILED' }
                $listenItem.Note += $(if ($up) { ' - PostgreSQL restarted' } else { ' - PostgreSQL did not answer after its restart' })
            } catch { $listenItem.Note += " - restart failed: $($_.Exception.Message)" }
        } else {
            $listenItem.Note += ' - effective at the NEXT PostgreSQL restart (not restarted by Setup)'
        }
    }
    $pgReport = Get-PgHardeningReport $pgItems $script:PgHbaTrust $script:PgHbaFile $pgConsent.Mode $script:PgCreatedByUs "$($cfg.PgHost):$($cfg.PgPort)"
    foreach ($line in $pgReport) {
        $lvl = if ($line -match '^\s+\[(TO DO|FAILED)\]') { 'WARN' } elseif ($line -match '^\s+\[APPLIED\]') { 'OK' } else { 'INFO' }
        Log $line $lvl
    }
    $cnt = { param($s) @($pgItems | Where-Object { $_.Status -eq $s }).Count }
    $script:PgHardeningSummary = "{0} applied, {1} to do, {2} failed, {3} already OK; pg_hba trust entries: {4}" -f (& $cnt 'APPLIED'), (& $cnt 'TO DO'), (& $cnt 'FAILED'), (& $cnt 'OK'), $(if ($null -eq $script:PgHbaTrust) { 'not checked' } else { @($script:PgHbaTrust).Count })
} catch { Log "PostgreSQL hardening check skipped: $($_.Exception.Message)" 'WARN' }

# Is the audit trail ALREADY separated in this database? Read before the ownership
# reconcile below hands the tables back to the app role for the migration pass
# (the plan then keeps an upgrade in the state it was in).
$script:AuditSeparatedNow = $false
try {
    $aoN = Get-PsqlText $cfg.DbName "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tableowner IN ('$($script:AuditOwnerRole)', '$($script:LegacyAuditOwnerRole)')"
    $script:AuditSeparatedNow = ("$aoN".Trim() -match '^\d+$') -and ([int]"$aoN".Trim() -gt 0)
} catch { $script:AuditSeparatedNow = $false }

# ---------------------------------------------------------------------------
# STEP 4b - Import bundled data snapshot (full DB)
# ---------------------------------------------------------------------------
# Provision the database from the bundled snapshot so the app comes up fully
# populated (org, employees, skills, assessments, talent data AND the existing
# logins). The decision is based on REAL DATA, not merely whether the database
# row exists:
#   - DB has application data (employees > 0)  -> preserve it, skip import (true upgrade).
#   - DB is fresh, OR exists but is empty/partial (e.g. a leftover from a prior
#     FAILED run that committed a few migrations but no data) -> (re)create it
#     clean and import the snapshot. This is what unblocks the "skipping import
#     -> resume broken migrate chain" failure loop.
$dataImported = $false
$dumpRel  = if ($cfg.ContainsKey('DataDumpFile') -and $cfg.DataDumpFile) { $cfg.DataDumpFile } else { 'data\idevelop.sql' }
$dumpPath = Join-Path $ScriptRoot $dumpRel
if ($cfg.ImportData -eq $true) {
  if (-not (Test-Path $dumpPath)) {
    Log "ImportData is on but the snapshot '$dumpRel' was not found beside the installer - skipping import (the migrate chain will be used instead)." 'WARN'
  } else {
    # How much real data is already there? to_regclass is NULL-safe if the
    # table doesn't exist yet, so this never errors on a fresh/partial DB.
    $rowCount = 0
    $hasEmp = Psql $cfg.DbName "SELECT (to_regclass('public.employees') IS NOT NULL)::int"
    if ($hasEmp -eq '1') { $rowCount = [int](Psql $cfg.DbName "SELECT count(*) FROM employees") }

    if ($rowCount -gt 0 -and -not $Reinstall) {
      Log "Database '$($cfg.DbName)' already holds $rowCount employees - preserving live data; skipping import." 'OK'
    } else {
      if ($Reinstall -and $rowCount -gt 0) {
        Log "FULL REINSTALL: the existing database holds $rowCount employee record(s); it will be DROPPED and recreated from the bundled snapshot." 'WARN'
        # DATA-LOSS GUARD (2026-07-10 incident backstop): a full reinstall PERMANENTLY
        # destroys a test instance. When it still holds real employee data, require an
        # explicit typed confirmation (the exact employee count) before dropping, unless
        # -ConfirmDataLoss was supplied for an intentional unattended run. Aborts BEFORE
        # any drop, so a test instance is left untouched on a mismatch. Read-Host with
        # no console returns empty -> mismatch -> safe abort.
        if (-not $ConfirmDataLoss) {
          Write-Host ''
          Write-Host '  ***********************  DATA-LOSS WARNING  ***********************' -ForegroundColor Red
          Write-Host "  A FULL REINSTALL will PERMANENTLY DELETE the '$($cfg.DbName)' database" -ForegroundColor Yellow
          Write-Host "  and its $rowCount employee record(s), replacing it with the bundled" -ForegroundColor Yellow
          Write-Host '  snapshot. A restore point was taken first, but this is destructive.' -ForegroundColor Yellow
          Write-Host '  To KEEP the live data, abort and choose Upgrade (app + DB) instead.' -ForegroundColor Yellow
          Write-Host '  *****************************************************************' -ForegroundColor Red
          $answer = Read-Host "  Type the number $rowCount to CONFIRM deletion (anything else aborts)"
          if ((("" + $answer).Trim()) -ne (("" + $rowCount).Trim())) {
            Fail "Full reinstall ABORTED by the data-loss guard - a test instance was NOT modified. Use Upgrade (app + DB) to preserve data, or re-run and type $rowCount to confirm (or pass -ConfirmDataLoss for an unattended run)."
          }
          Log "Data-loss confirmed by operator ($rowCount employees) - proceeding with the destructive reinstall." 'WARN'
        } else {
          Log "Data-loss auto-confirmed via -ConfirmDataLoss ($rowCount employees) - proceeding with the destructive reinstall." 'WARN'
        }
      }
      if (-not $freshDb -or ($Reinstall -and $rowCount -gt 0)) {
        if (-not ($Reinstall -and $rowCount -gt 0)) {
          Log "Database '$($cfg.DbName)' exists but holds no application data (leftover from a prior/failed run) - recreating it for a clean import." 'WARN'
        }
        # Drop + recreate so the snapshot loads into a pristine schema. WITH
        # (FORCE) terminates any lingering backends (PG 13+).
        Psql 'postgres' "DROP DATABASE IF EXISTS ""$($cfg.DbName)"" WITH (FORCE)" | Out-Null
        Psql 'postgres' "CREATE DATABASE ""$($cfg.DbName)"" OWNER ""$($cfg.DbUser)""" | Out-Null
        foreach ($ext in @('citext', 'pgcrypto', 'pg_trgm', 'unaccent')) { Psql $cfg.DbName "CREATE EXTENSION IF NOT EXISTS $ext" | Out-Null }
        Psql $cfg.DbName "GRANT ALL ON SCHEMA public TO ""$($cfg.DbUser)""" | Out-Null
        Psql $cfg.DbName "ALTER SCHEMA public OWNER TO ""$($cfg.DbUser)""" | Out-Null
        Log 'Recreated empty database + extensions.' 'OK'
      }
      Log "Importing bundled data snapshot ($dumpRel) into '$($cfg.DbName)'..." 'STEP'
      $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      $impOut = & $psql -h $cfg.PgHost -p $cfg.PgPort -U postgres -d $cfg.DbName -v ON_ERROR_STOP=0 -f $dumpPath 2>&1
      $impCode = $LASTEXITCODE
      $ErrorActionPreference = $prevEAP
      ($impOut | Out-String) | Add-Content -Path $LogFile
      # ON_ERROR_STOP=0 makes psql exit 0 whatever failed inside the file
      # (measured: a file with a failing SELECT -> exit 0). The exit code is
      # therefore NO proof. Proof = the count of `ERROR:` lines psql printed
      # plus a structural check that the tables the product cannot live
      # without actually hold rows.
      $impErrors = @($impOut | Where-Object { "$_" -match '(^|\s)ERROR:' })
      $impCheck = Test-ImportedSnapshot $cfg.DbName
      if ($impCheck.missing.Count) {
        Fail ("Data snapshot import FAILED: psql reported $($impErrors.Count) SQL error(s) and these core tables are missing or empty: " + ($impCheck.missing -join ', ') + ". First errors: " + (($impErrors | Select-Object -First 3) -join ' | ') + ". See $LogFile.")
      }
      if ($impErrors.Count -gt 0 -or $impCode -ne 0) {
        Log "Data snapshot imported WITH $($impErrors.Count) SQL error(s) (psql exit $impCode); core tables verified ($($impCheck.summary)). Review the errors in $LogFile before go-live. First: $(($impErrors | Select-Object -First 3) -join ' | ')" 'WARN'
      } else {
        Log "Data snapshot imported - 0 SQL errors; verified $($impCheck.summary)." 'OK'
      }
      # Re-own imported objects to the app role + (re)grant, so the app can
      # read/write and future migrations (run as the app role) can alter them.
      $reown = @'
DO $do$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename     FROM pg_tables    WHERE schemaname='public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO %I',    r.tablename,     '__OWNER__'); END LOOP;
  FOR r IN SELECT sequencename  FROM pg_sequences WHERE schemaname='public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO %I', r.sequencename,  '__OWNER__'); END LOOP;
  FOR r IN SELECT table_name    FROM information_schema.views WHERE table_schema='public' LOOP
    EXECUTE format('ALTER VIEW public.%I OWNER TO %I',     r.table_name,    '__OWNER__'); END LOOP;
  -- Standalone ENUM/composite/domain types owned by another role. MUST filter on
  -- owner (o.rolname <> app): after the table loop above, every TABLE auto row
  -- type is already app-owned, and ALTER TYPE on a table row type is always
  -- rejected by PostgreSQL, which under ON_ERROR_STOP=1 aborts the whole install.
  -- The owner filter skips those app-owned row types.
  FOR r IN SELECT t.typname FROM pg_type t
             JOIN pg_namespace n ON n.oid=t.typnamespace
             JOIN pg_roles o ON o.oid=t.typowner
            WHERE n.nspname='public' AND o.rolname <> '__OWNER__'
              AND t.typtype IN ('e','c','d') LOOP
    EXECUTE format('ALTER TYPE public.%I OWNER TO %I', r.typname, '__OWNER__'); END LOOP;
  -- FUNCTIONS / PROCEDURES / AGGREGATES too (excluding extension-owned routines),
  -- so a reinstalled/imported DB can be upgraded later (CREATE OR REPLACE / ALTER
  -- routine requires ownership). Mirrors the STEP-5 pre-migrate reconcile.
  FOR r IN SELECT p.proname, p.prokind, pg_get_function_identity_arguments(p.oid) AS args
             FROM pg_proc p
             JOIN pg_namespace n ON n.oid=p.pronamespace
             JOIN pg_roles o ON o.oid=p.proowner
            WHERE n.nspname='public' AND o.rolname <> '__OWNER__'
              AND NOT EXISTS (SELECT 1 FROM pg_depend d
                               WHERE d.objid=p.oid AND d.classid='pg_proc'::regclass
                                 AND d.deptype='e') LOOP
    IF    r.prokind = 'a' THEN EXECUTE format('ALTER AGGREGATE public.%I(%s) OWNER TO %I', r.proname, r.args, '__OWNER__');
    ELSIF r.prokind = 'p' THEN EXECUTE format('ALTER PROCEDURE public.%I(%s) OWNER TO %I', r.proname, r.args, '__OWNER__');
    ELSE                       EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO %I',  r.proname, r.args, '__OWNER__');
    END IF; END LOOP;
END $do$;
'@
      $reown = $reown.Replace('__OWNER__', $cfg.DbUser)
      PsqlFile $cfg.DbName $reown | Out-Null
      Psql $cfg.DbName "GRANT ALL ON ALL TABLES IN SCHEMA public TO ""$($cfg.DbUser)""" | Out-Null
      Psql $cfg.DbName "GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ""$($cfg.DbUser)""" | Out-Null
      Psql $cfg.DbName "GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO ""$($cfg.DbUser)""" | Out-Null
      $dataImported = $true
      Log 'Imported data re-owned + granted to the app role.' 'OK'
    }
  }
}

# ---------------------------------------------------------------------------
# STEP 5/7 - Deploy application files + .env + dependencies
# ---------------------------------------------------------------------------
Set-Step 5 'Deploy application'
Log 'STEP 5/7 - Deploy application' 'STEP'
$payload = Join-Path $ScriptRoot 'app'
if (-not (Test-Path (Join-Path $payload 'server.js'))) { Fail "Application payload not found at $payload (expected an 'app' folder beside this script)." }

# PACKAGE INTEGRITY: the payload is VERIFIED against app\release-manifest.sha256
# (written by Build-Package: the SHA-256 of every shipped file) BEFORE anything
# is stopped or copied. A file altered, missing or added since the build stops
# the install (fail closed) and every difference is listed: a tampered or
# half-extracted package never reaches Program Files. (Authenticode signing of
# the exe / zip is the next step: it needs a code-signing certificate.)
function Read-ReleaseManifest([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $null }
    $known = @{}; $ver = ''
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line -match '^#.*\bversion=(\S+)') { $ver = $Matches[1]; continue }
        if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
            $rel = ($Matches[2].Trim() -replace '/', '\').TrimStart('\')
            if ($rel) { $known[$rel.ToLowerInvariant()] = @{ Hash = $Matches[1].ToLowerInvariant(); Rel = $rel } }
        }
    }
    if (-not $known.Count) { return $null }
    return [pscustomobject]@{ Version = $ver; Known = $known }
}
function Test-PayloadManifest([string]$PayloadDir) {
    $res = [pscustomobject]@{ Present = $false; Version = ''; Count = 0; Mismatch = @(); Missing = @(); Extra = @() }
    $mf = Read-ReleaseManifest (Join-Path $PayloadDir 'release-manifest.sha256')
    if (-not $mf) { return $res }
    $res.Present = $true; $res.Version = $mf.Version; $res.Count = $mf.Known.Count
    $root = [IO.Path]::GetFullPath($PayloadDir).TrimEnd('\')
    $seen = @{}
    $mm = New-Object System.Collections.Generic.List[string]
    $ex = New-Object System.Collections.Generic.List[string]
    foreach ($f in @(Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue)) {
        $rel = $f.FullName.Substring($root.Length + 1)
        $low = $rel.ToLowerInvariant()
        if ($low -eq 'release-manifest.sha256') { continue }
        # Explorer's own metadata (thumbnail caches, folder settings) appears as
        # soon as someone browses the extracted folder: not code, not refused.
        if (-not $mf.Known.ContainsKey($low) -and $f.Name -in @('Thumbs.db', 'ehthumbs.db', 'desktop.ini', '.DS_Store')) { continue }
        if (-not $mf.Known.ContainsKey($low)) { $ex.Add($rel); continue }
        $seen[$low] = $true
        $h = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($h -ne $mf.Known[$low].Hash) { $mm.Add($rel) }
    }
    $res.Mismatch = @($mm | Sort-Object)
    $res.Extra = @($ex | Sort-Object)
    $res.Missing = @($mf.Known.Keys | Where-Object { -not $seen.ContainsKey($_) } | ForEach-Object { $mf.Known[$_].Rel } | Sort-Object)
    return $res
}
$pv = Test-PayloadManifest $payload
if (-not $pv.Present) {
    Fail "Package integrity: app\release-manifest.sha256 is missing - this package cannot be verified and is refused. Use the complete package produced by Build-Package.ps1 (the manifest is written there)."
}
$pvBad = @($pv.Mismatch).Count + @($pv.Missing).Count + @($pv.Extra).Count
if ($pvBad -gt 0) {
    foreach ($x in @($pv.Mismatch)) { Log "    ALTERED (SHA-256 differs from the manifest): $x" 'ERROR' }
    foreach ($x in @($pv.Missing))  { Log "    MISSING (listed in the manifest): $x" 'ERROR' }
    foreach ($x in @($pv.Extra))    { Log "    NOT IN THE MANIFEST (added after the build): $x" 'ERROR' }
    Fail "Package integrity check FAILED: $(@($pv.Mismatch).Count) altered, $(@($pv.Missing).Count) missing, $(@($pv.Extra).Count) added file(s) against release-manifest.sha256 $($pv.Version) - nothing was stopped or copied. Re-extract the original package (or rebuild it) and run Setup again."
}
Log "Package integrity: $($pv.Count) file(s) match release-manifest.sha256 $($pv.Version) (SHA-256)." 'OK'

# Stop a previous host so files aren't locked (upgrade). Handle BOTH hosting modes —
# a real Windows service (the Auto/Service default) AND a Scheduled Task — otherwise a
# service-hosted node.exe keeps node_modules/files locked during the robocopy/npm step.
if ((Get-AppWindowsService) -or (Get-AppScheduledTask)) {
    Log 'Stopping existing app host for upgrade...'
    Stop-AppService
}

New-Item -ItemType Directory -Force -Path $cfg.InstallDir | Out-Null
$existingEnv = Join-Path $cfg.InstallDir '.env'
$preserveEnv = $null
$carryOverEnv = ''   # user-set optional config rescued from a regenerated .env
if (Test-Path $existingEnv) {
    $envRaw = Get-Content $existingEnv -Raw
    # A preserved .env from a FAILED run can be incomplete. Only keep it if it
    # actually contains a usable DATABASE_URL; otherwise regenerate it.
    if ($envRaw -match '(?m)^\s*DATABASE_URL\s*=\s*postgres') {
        $preserveEnv = $envRaw
        Log 'Existing .env is valid (has DATABASE_URL) - preserving it.'
    } else {
        Log 'Existing .env is incomplete / missing DATABASE_URL - it will be regenerated.' 'WARN'
        # Rescue any user-set optional settings (SMTP credentials for email
        # notifications, Redis, ClamAV, proxy/cookie tuning) so regenerating a
        # broken .env doesn't silently drop them.
        $carryOverEnv = ((Get-Content $existingEnv) |
            Where-Object { $_ -match '^\s*(SMTP_|REDIS_URL|CLAMD_|REQUIRE_MALWARE_SCAN|TRUST_PROXY|COOKIE_SECURE|PG_POOL_MAX|LOG_LEVEL|APP_BASE_URL)\S*\s*=' }) -join "`r`n"
        if ($carryOverEnv) { Log 'Carrying over custom SMTP / Redis / ClamAV settings from the old .env into the regenerated one.' }
    }
}

# Back up the CURRENT app code before overlaying the new version so a patch /
# upgrade can be rolled back. Excludes node_modules/logs/tmp/data (large or
# re-creatable); the preserved .env IS included for a complete restore point.
# uploads and backups are not code and an upgrade never touches them: copying
# them on every run grew app-backups without limit, and a code rollback must
# never put older evidence files back over newer ones.
if ($priorInstallDir) {
    $bkVer = if ($script:OldVersion) { $script:OldVersion } else { 'prev' }
    $backupDir = Join-Path (Join-Path $LogDir 'app-backups') ("app-$bkVer-$stamp")
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $bxd = @('node_modules', 'logs', 'tmp', 'data', 'coverage', 'certs', 'uploads', 'backups') | ForEach-Object { Join-Path $cfg.InstallDir $_ }
    robocopy $cfg.InstallDir $backupDir /E /XD $bxd /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Log "Pre-upgrade backup hit a copy error (robocopy exit $LASTEXITCODE) - continuing." 'WARN' }
    else { Log "Previous app code backed up to: $backupDir" 'OK'; Log '  (rollback: stop the service, copy this folder back over the install dir, restart the service)'; $script:BackupDir = $backupDir }
    # Keep the newest AppBackupKeep code copies (config.psd1, default 5; 0 = keep
    # all). Only superseded app-<version>-<stamp> CODE copies are removed: never a
    # retired-* folder (-EnforceManifest), never the copy just taken (the rollback
    # source of this run), never a restore point or a database dump. Each removal
    # is logged by name.
    try {
        $keepN = 5
        if ($cfg.ContainsKey('AppBackupKeep')) { $keepN = [int]$cfg.AppBackupKeep }
        if ($keepN -gt 0) {
            $abRoot = Join-Path $LogDir 'app-backups'
            $old = @(Get-ChildItem -LiteralPath $abRoot -Directory -Filter 'app-*' -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -ne $backupDir } | Sort-Object LastWriteTime -Descending | Select-Object -Skip ([Math]::Max(0, $keepN - 1)))
            $prunedN = 0
            foreach ($o in $old) {
                try { Remove-Item -LiteralPath $o.FullName -Recurse -Force -ErrorAction Stop; $prunedN++; Log "  pruned superseded code copy: $($o.Name)" }
                catch { Log "  could not prune $($o.Name): $($_.Exception.Message)" 'WARN' }
            }
            $script:AppBackupPruned = "kept newest $keepN, pruned $prunedN"
            if ($prunedN -gt 0) { Log "Code backups: kept the newest $keepN app-* copies, pruned $prunedN older one(s)." 'OK' }
        } else {
            $script:AppBackupPruned = 'all kept (AppBackupKeep = 0)'
        }
    } catch { Log "Code-backup pruning skipped: $($_.Exception.Message)" 'WARN' }
}

# APP-ONLY PATCH (-Patch -SkipMigrations) PROMISES "no database change". The
# promise used to be false: the copy below shipped db\postgres\*.sql with the
# code, and the service applies every numbered file schema_meta does not list
# at its next boot - outside this log, without pre-flight. So, before a single
# file moves: the package's migration files are compared with schema_meta, and
# a package that carries migrations this database has not applied is REFUSED
# for an app-only patch (choose Upgrade / Migrate). When nothing is pending the
# copy skips db\postgres altogether, so the promise holds by construction.
if ($SkipMigrations -and $Patch) {
    $shippedMig = Get-ChildItem -LiteralPath (Join-Path $payload 'db\postgres') -File -Filter '*.sql' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d' -and $_.Name -notmatch '_down\.sql$' -and $_.Name -ne '01_schema.sql' } |
        ForEach-Object { $_.Name -replace '\.sql$', '' }
    $appliedRaw = ''
    try { $appliedRaw = Psql $cfg.DbName "SELECT string_agg(key, E'\n') FROM schema_meta" } catch { $appliedRaw = '' }
    $appliedKeys = @{}
    foreach ($k in ($appliedRaw -split "`r?`n")) { if ($k.Trim()) { $appliedKeys[$k.Trim()] = $true } }
    $pendingMig = @($shippedMig | Where-Object { -not $appliedKeys.ContainsKey($_) })
    if ($pendingMig.Count -gt 0) {
        Fail ("APP-ONLY PATCH REFUSED: this package carries $($pendingMig.Count) migration(s) the database has not applied [" + ($pendingMig -join ', ') + "]. An app-only patch cannot honour 'no database change' with them (the service would apply them at its next start). Choose Upgrade (app + DB) / Migrate instead.")
    }
    Log "App-only patch: 0 pending migration(s) in this package for '$($cfg.DbName)' - db\postgres will not be copied." 'OK'
}

Log 'Copying application files...'
# IMPORTANT: do NOT use /MIR here. /MIR mirrors and would DELETE the live
# node_modules and .env in the target on every run (then force a full reinstall,
# or worse, wipe a preserved env mid-copy). /E copies the tree and leaves
# target-only files (installed deps, .env) intact. We still exclude dev/runtime
# dirs from the source.
$exclude = @('node_modules', '.git', 'logs', 'tmp', 'data', 'coverage', 'certs')
if ($SkipMigrations -and $Patch) { $exclude += 'db\postgres' }
$xd = $exclude | ForEach-Object { Join-Path $payload $_ }
robocopy $payload $cfg.InstallDir /E /XD $xd /XF '.env' /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "File copy failed (robocopy exit $LASTEXITCODE)." }
Log 'Files copied.' 'OK'

# --- RETIRED FILES -----------------------------------------------------------
# /E is deliberately not /MIR, so a file the product no longer ships STAYS in the
# install directory for ever. That is normally harmless. It is not harmless when
# the retired file is the reason for the upgrade.
#
# Each entry below must say WHY it has to go, because deleting a customer's file
# is not something to do on a hunch. Paths are relative to the install directory,
# resolved inside it, and a miss is not an error - most installs will not have
# them.
$retired = @(
    @{ p = 'public\user-guide.html';    why = 'served with NO authentication (express.static runs before the session); names real employees and their 9-box placement. Moved to private\guides\ and handed out by an authenticated route in 3.23.3.' },
    @{ p = 'public\user-guide.en.html'; why = 'same file, English.' },
    # Found on a test instance on 2026-09-24 (deployed tree compared with tag v3.23.15):
    # views the product no longer ships and no route renders (all redirect).
    # Removed so the install directory is exactly the release.
    @{ p = 'views\pages\admins\invitations.ejs';      why = 'retired view, no route renders it.' },
    @{ p = 'views\pages\coaching\index.ejs';          why = 'retired view, deleted from the product in 3.22.91.' },
    @{ p = 'views\pages\slf\cycles.ejs';              why = 'retired view, no route renders it.' },
    @{ p = 'views\pages\talent\9box-grid.ejs';        why = 'retired view, no route renders it.' },
    @{ p = 'public\js\data-management.js';            why = 'dead script, no view loads it; removed in 3.23.17.' }
)
foreach ($r in $retired) {
    $full = Join-Path $cfg.InstallDir $r.p
    # Refuse anything that resolves outside the install directory.
    $root = [IO.Path]::GetFullPath($cfg.InstallDir)
    $target = [IO.Path]::GetFullPath($full)
    if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        Log "Refusing to remove a path outside the install directory: $($r.p)" 'WARN'
        continue
    }
    if (Test-Path -LiteralPath $target) {
        try {
            Remove-Item -LiteralPath $target -Force -ErrorAction Stop
            Log "Removed retired file: $($r.p) - $($r.why)" 'OK'
        } catch {
            # Loud, not silent: this one is a data-exposure fix, and an operator
            # who is not told will believe the upgrade closed it.
            Log "COULD NOT remove retired file $($r.p): $($_.Exception.Message). Delete it by hand - $($r.why)" 'WARN'
        }
    }
}

# --- RETIRED SCRIPTS ---------------------------------------------------------
# scripts\ is reconciled against the payload rather than by naming files one at
# a time, because the list is long and grows: Build-Package already strips the
# dev-only entries (43 on the 3.23.7 build), but /E never deletes, so every one
# of them that a PREVIOUS version installed is still sitting in the customer's
# install directory.
#
# Measured on this machine at 3.23.7: the package ships 9 scripts and the
# install directory held 54 - 45 stale, among them _provision-test-users.js,
# seed-all-test-accounts.js and seed-second-admin.js (they create accounts),
# _purge-uat-entities.js (it deletes data), db-transfer.js (it can overwrite a
# database) and a row of one-off migrations with no dry-run guard. That is the
# exact incident class Build-Package's own exclusion list exists to prevent, and
# excluding them from the package never removed the ones already on disk.
#
# This directory is product-owned: nothing a customer authored belongs in it, so
# "whatever the payload does not carry" is a safe rule. It is scoped to this one
# directory and to .js/.ps1 - never applied to the tree at large.
$scriptsLive = Join-Path $cfg.InstallDir 'scripts'
$scriptsSrc  = Join-Path $payload 'scripts'
if ((Test-Path -LiteralPath $scriptsLive) -and (Test-Path -LiteralPath $scriptsSrc)) {
    $shipped = @{}
    foreach ($f in (Get-ChildItem -LiteralPath $scriptsSrc -File)) {
        $shipped[$f.Name.ToLowerInvariant()] = $true
    }
    $removed = 0
    foreach ($f in (Get-ChildItem -LiteralPath $scriptsLive -File)) {
        if ($f.Extension -notin @('.js', '.ps1')) { continue }
        if ($shipped.ContainsKey($f.Name.ToLowerInvariant())) { continue }
        try {
            Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop
            $removed++
        } catch {
            Log "COULD NOT remove stale script scripts\$($f.Name): $($_.Exception.Message)" 'WARN'
        }
    }
    if ($removed -gt 0) {
        Log "Removed $removed stale dev-only script(s) from scripts\ - the package ships $($shipped.Count)" 'OK'
    }
}

# --- RELEASE MANIFEST: DRIFT IN THE INSTALL DIRECTORY ---------------------------
# Whatever the install dir holds beyond the manifest - outside the customer
# folders below - is drift: a file an older version shipped, a hand-copied
# hotfix, a leftover. It is REPORTED (install log + summary); -EnforceManifest
# MOVES it, never deletes it, to %ProgramData%\IDevelop\app-backups\retired-<stamp>\.
# Customer folders are never walked: runtime data (uploads, branding, logs,
# backups, data, tmp, AI_Engine_Docs upload staging, the WinSW service folder,
# certs), configuration (.env, config), dependencies (node_modules), HRIS drop
# folders, and HRIS_DROP_ROOT when it lies inside the install dir.
$script:ManifestName = 'release-manifest.sha256'
$script:ManifestCustomerDirs = @('uploads', 'branding', 'logs', 'backups', 'config', '.env', 'certs', 'data',
    'node_modules', 'tmp', 'app-backups', 'service', 'maintenance', 'AI_Engine_Docs', 'hris', 'hris-drop', 'imports')
$script:ManifestCustomerNested = @('public\uploads', 'public\branding')
# Relative paths (install-dir case) of files NOT in $Known. Customer folders are
# never walked: $ExcludeTop by top-level name, $ExcludeNested by relative prefix.
function Get-ManifestUnknownFiles([string]$InstallDir, [hashtable]$Known, [string[]]$ExcludeTop, [string[]]$ExcludeNested) {
    $root = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
    $nested = @(@($ExcludeNested) | Where-Object { $_ } | ForEach-Object { ($_ -replace '/', '\').Trim('\').ToLowerInvariant() + '\' })
    $unknown = New-Object System.Collections.Generic.List[string]
    foreach ($e in @(Get-ChildItem -LiteralPath $root -Force -ErrorAction SilentlyContinue)) {
        if (@($ExcludeTop) -contains $e.Name) { continue }
        $files = if ($e.PSIsContainer) { @(Get-ChildItem -LiteralPath $e.FullName -Recurse -File -Force -ErrorAction SilentlyContinue) } else { @($e) }
        foreach ($f in $files) {
            $rel = $f.FullName.Substring($root.Length + 1)
            $low = $rel.ToLowerInvariant()
            if ($Known.ContainsKey($low)) { continue }
            if (@($nested | Where-Object { $low.StartsWith($_) }).Count) { continue }
            $unknown.Add($rel)
        }
    }
    # Unrolled on purpose: callers wrap the call in @() (0, 1 or N paths alike).
    return @($unknown | Sort-Object)
}
# -EnforceManifest: MOVE (never delete) each file to $RetiredDir\<same relative
# path>. Refuses any path that resolves outside the install dir. Returns the count moved.
function Move-ManifestUnknownFiles([string]$InstallDir, [string[]]$RelPaths, [string]$RetiredDir) {
    $root = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\') + '\'
    $moved = 0
    foreach ($rel in @($RelPaths)) {
        $src = [IO.Path]::GetFullPath((Join-Path $InstallDir $rel))
        if (-not $src.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { Log "Refusing to move a path outside the install directory: $rel" 'WARN'; continue }
        if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { continue }
        try {
            $dest = Join-Path $RetiredDir $rel
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
            Move-Item -LiteralPath $src -Destination $dest -Force -ErrorAction Stop
            $moved++
            Log "Moved out of the install directory (not in the release manifest): $rel -> $dest" 'OK'
        } catch { Log "COULD NOT move $rel out of the install directory: $($_.Exception.Message)" 'WARN' }
    }
    return $moved
}
$script:ManifestSummary = $null
try {
    $mf = Read-ReleaseManifest (Join-Path $payload $script:ManifestName)
    if (-not $mf) {
        Log "Release manifest: $($script:ManifestName) is not in this package - unknown-file check skipped." 'WARN'
    } else {
        $mf.Known[$script:ManifestName.ToLowerInvariant()] = @{ Hash = 'self'; Rel = $script:ManifestName }
        $nestedEx = @($script:ManifestCustomerNested)
        $hrisRoot = Get-HrisDropRoot $cfg.InstallDir
        if ($hrisRoot) {
            $instFull = [IO.Path]::GetFullPath($cfg.InstallDir).TrimEnd('\') + '\'
            try { $hrisFull = [IO.Path]::GetFullPath($hrisRoot) } catch { $hrisFull = '' }
            if ($hrisFull -and $hrisFull.StartsWith($instFull, [StringComparison]::OrdinalIgnoreCase)) { $nestedEx += $hrisFull.Substring($instFull.Length) }
        }
        $unk = @(Get-ManifestUnknownFiles $cfg.InstallDir $mf.Known $script:ManifestCustomerDirs $nestedEx)
        if ($unk.Count -eq 0) {
            Log "Release manifest $($mf.Version): the install directory holds exactly the release (customer folders excluded)." 'OK'
            $script:ManifestSummary = 'no unknown file'
        } else {
            Log "Release manifest $($mf.Version): $($unk.Count) file(s) in $($cfg.InstallDir) are NOT part of this release (customer folders $($script:ManifestCustomerDirs -join ', ') excluded):" 'WARN'
            foreach ($u in $unk) { Log "    unknown: $u" 'WARN' }
            if ($EnforceManifest) {
                $retDir = Join-Path (Join-Path $LogDir 'app-backups') ("retired-$stamp")
                $nMoved = Move-ManifestUnknownFiles $cfg.InstallDir $unk $retDir
                $script:ManifestSummary = "$nMoved of $($unk.Count) unknown file(s) moved to $retDir (-EnforceManifest)"
            } else {
                Log "REPORT ONLY: nothing was moved. Re-run with -EnforceManifest to move these files (never deleted) to $(Join-Path $LogDir 'app-backups')\retired-<stamp>\." 'WARN'
                $script:ManifestSummary = "$($unk.Count) unknown file(s) reported - -EnforceManifest moves them out"
            }
        }
    }
} catch { Log "Release manifest check skipped: $($_.Exception.Message)" 'WARN' }

# Resolve the effective HTTP port. The old service (if any) was just stopped, so
# if the preferred port is STILL occupied it belongs to ANOTHER application -
# advance to the next free port and use it everywhere (.env, firewall, health
# check, service). On an upgrade the preserved .env's PORT is the preference.
$desiredPort = $cfg.AppPort
if ($preserveEnv) {
    $pm = [regex]::Match($preserveEnv, '(?m)^\s*PORT\s*=\s*(\d+)')
    if ($pm.Success) { $desiredPort = [int]$pm.Groups[1].Value }
}
if (Test-PortInUse $desiredPort) {
    if ($priorAny) {
        # Upgrade / patch of our OWN install: the port belongs to us, not a foreign
        # app. The old listener was just stopped but the socket can take a moment to
        # release (or WinSW briefly respawned it). Wait for it to free instead of
        # drifting to the next port (which silently moved the service to 3001 on a
        # previous build). Keep the same port regardless so clients/firewall/bookmarks
        # stay valid; the new instance binds once the old listener is gone.
        # Windows can hold a just-closed listener socket for 30-60s; wait up to 60s
        # for it to release before giving up (still keeping the port either way).
        $waited = 0
        while ((Test-PortInUse $desiredPort) -and $waited -lt 60) { Start-Sleep -Seconds 1; $waited++ }
        if (Test-PortInUse $desiredPort) {
            Log "Port $desiredPort still held $waited s after stopping the old service - keeping it (the new instance will bind once the old listener releases)." 'WARN'
        } else {
            Log "Port $desiredPort released after $waited s - reusing it for the upgraded service." 'OK'
        }
        $cfg.AppPort = $desiredPort
    } else {
        # Fresh install: an in-use port belongs to a different application - advance.
        $free = Get-FreePort ($desiredPort + 1)
        if ($free -ne $desiredPort) {
            Log "Port $desiredPort is in use by another process - the app will run on the next free port: $free." 'WARN'
            $cfg.AppPort = $free
        } else {
            Log "Port $desiredPort is busy and no free port was found nearby - the app may fail to bind. Pass -AppPort to choose one." 'WARN'
            $cfg.AppPort = $desiredPort
        }
    }
} else {
    $cfg.AppPort = $desiredPort
}

# .env
$dbUrl = "postgres://$($cfg.DbUser):$($cfg.DbPassword)@$($cfg.PgHost):$($cfg.PgPort)/$($cfg.DbName)"
if ($cfg.PgSsl) { $dbUrl += '?sslmode=require' }
if ($preserveEnv) {
    # Keep the preserved .env but ensure its PORT reflects the resolved port.
    if ($preserveEnv -match '(?m)^\s*PORT\s*=') {
        $preserveEnv = [regex]::Replace($preserveEnv, '(?m)^\s*PORT\s*=.*$', "PORT=$($cfg.AppPort)")
    } else {
        $preserveEnv = $preserveEnv.TrimEnd() + "`r`nPORT=$($cfg.AppPort)`r`n"
    }
    Set-Content -Path $existingEnv -Value $preserveEnv -Encoding UTF8
    Log ".env preserved from previous install (PORT=$($cfg.AppPort))."
} else {
    $sessionSecret = New-Secret 32
    $apiKey = New-Secret 24
    $sslLine = if ($cfg.PgSsl) { "PG_SSL=require`n" } else { '' }
    $envContent = @"
NODE_ENV=production
PORT=$($cfg.AppPort)
SESSION_SECRET=$sessionSecret
APP_KEY=$apiKey
DATABASE_URL=$dbUrl
${sslLine}V2_FEATURES=$($cfg.V2Features)
# Public URL of this instance as USERS reach it - embedded in outgoing emails
# (e.g. the onboarding credentials mail links to APP_BASE_URL/login). Defaults to
# this machine's hostname; change it if users reach the app via a DNS alias/proxy.
APP_BASE_URL=http://$(($env:COMPUTERNAME).ToLower()):$($cfg.AppPort)
# NOTE: the postgres superuser password is deliberately NOT written here. The app
# connects only as the idevelop_app role via DATABASE_URL; the superuser value must never
# be persisted to .env (readable in-app-dir + copied into every backup/restore point).

# ---- Email / SMTP (outgoing notifications) ----
# Email-on-action is configured in the app: Settings -> Email (SMTP) + Email Triggers,
# then enable the master switch. These variables are an OPTIONAL fallback used only
# when the matching Settings value is left blank (keeps credentials out of the DB).
# SMTP_HOST=smtp.example.com
# SMTP_PORT=587
# SMTP_USER=noreply@example.com
# SMTP_PASS=your_smtp_password
# SMTP_FROM=IDevelop <noreply@example.com>
"@
    if ($carryOverEnv) {
        $envContent += "`r`n# ---- rescued from the previous .env ----`r`n$carryOverEnv`r`n"
    }
    Set-Content -Path $existingEnv -Value $envContent -Encoding UTF8
    Log '.env generated with fresh secrets.' 'OK'
}

# HTTPS (S-05) - on EVERY mode, so switching it on is a config edit + a Patch.
$script:HttpsOn = $false
$httpsCfg = Resolve-HttpsConfig $(if ($cfg.ContainsKey('Https')) { $cfg.Https } else { $null })
$script:HttpsPort = $httpsCfg.Port
try {
    $envText = [System.IO.File]::ReadAllText($existingEnv)
    $fqdn = Get-MachineFqdn
    $httpsBase = if ($httpsCfg.Port -eq 443) { "https://$fqdn" } else { "https://${fqdn}:$($httpsCfg.Port)" }
    $httpBase = "http://$(($env:COMPUTERNAME).ToLower()):$($cfg.AppPort)"
    if ($httpsCfg.Enabled) {
        if ($httpsCfg.Port -eq $cfg.AppPort) { throw "Https.Port ($($httpsCfg.Port)) must differ from AppPort ($($cfg.AppPort)): the HTTP port stays open to redirect." }
        $cert = Get-TlsCertificate $httpsCfg @($fqdn, ($env:COMPUTERNAME).ToLower(), 'localhost')
        if (-not $cert) { throw 'no usable certificate (see the WARN above)' }
        $tlsDir = Join-Path $LogDir 'tls'
        New-Item -ItemType Directory -Force -Path $tlsDir | Out-Null
        $pfxPath = Join-Path $tlsDir 'server.pfx'
        $pfxPass = Get-EnvValue $envText 'TLS_PFX_PASSPHRASE'
        if (-not $pfxPass) { $pfxPass = New-Secret 24 }
        $sec = ConvertTo-SecureString -String $pfxPass -AsPlainText -Force
        Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $sec -Force -ErrorAction Stop | Out-Null
        # The PUBLIC certificate, to distribute to the browsers (GPO / trusted root).
        Export-Certificate -Cert $cert -FilePath (Join-Path $tlsDir 'server.cer') -Force -ErrorAction SilentlyContinue | Out-Null
        $envText = Update-EnvForHttps $envText $true $pfxPath $pfxPass $httpsCfg.Port $httpsBase $httpBase
        Set-Content -LiteralPath $existingEnv -Value $envText -Encoding UTF8
        $script:HttpsOn = $true
        Log "HTTPS enabled: https://${fqdn}:$($httpsCfg.Port)/ (certificate $($cert.Thumbprint); PFX under $tlsDir). HTTP port $($cfg.AppPort) now only redirects to HTTPS. A self-signed certificate is not trusted by browsers until tls\server.cer is deployed as a trusted root (GPO)." 'OK'
    } else {
        $newText = Update-EnvForHttps $envText $false '' '' $httpsCfg.Port $httpsBase $httpBase
        if ($newText -ne $envText) {
            Set-Content -LiteralPath $existingEnv -Value $newText -Encoding UTF8
            Log 'HTTPS is disabled in config.psd1: the TLS settings of a previous run were commented out in .env - the app serves plain HTTP again.' 'WARN'
        }
    }
} catch {
    Log "HTTPS NOT enabled: $($_.Exception.Message) - the app keeps serving plain HTTP on port $($cfg.AppPort)." 'WARN'
}

# S-01: the .env (DB password, SESSION_SECRET, APP_KEY), the backups and the
# code backups are for SYSTEM + Administrators only - on EVERY mode (fresh
# install, Repair, Patch, Upgrade, Migrate), so existing appliances are fixed too.
try {
    # The service account only READS the install root, so it can no longer create
    # the folders it writes to: they are created here, before the ACLs are laid.
    foreach ($wd in @('logs', 'tmp', 'uploads', 'data', 'backups', 'certs', 'AI_Engine_Docs', 'service\logs')) {
        $wp = Join-Path $cfg.InstallDir $wd
        if (-not (Test-Path -LiteralPath $wp)) { New-Item -ItemType Directory -Force -Path $wp | Out-Null }
    }
    $aclBad = Protect-AppDataAcls $LogDir $cfg.InstallDir
    if ($aclBad -gt 0) { Log "ACL hardening: $aclBad target(s) could not be fully restricted - see the WARN lines above." 'WARN' }
    else { Log 'ACL hardening: .env, backups, code backups, restore points and logs are restricted to SYSTEM + Administrators.' 'OK' }
} catch { Log "ACL hardening skipped: $($_.Exception.Message)" 'WARN' }

# Build the env passed to node/npm so child processes see the DB url even if the
# app reads it from the environment as well as from .env.
$childEnv = @{ DATABASE_URL = $dbUrl; NODE_ENV = 'production' }
if ($cfg.PgSsl) { $childEnv['PG_SSL'] = 'require' }

Log 'Installing production dependencies (npm)...'
$nmPath = Join-Path $cfg.InstallDir 'node_modules'
# In repair / force-deps mode, remove any partial or corrupt node_modules so the
# install starts clean (a half-finished npm ci - exactly the earlier failure -
# can leave node_modules in a broken state).
if (($Repair -or $ForceDeps) -and (Test-Path $nmPath)) {
    Log 'Repair: removing existing node_modules for a clean dependency rebuild...'
    Remove-Item -Recurse -Force $nmPath -ErrorAction SilentlyContinue
    if (Test-Path $nmPath) { Log 'Could not fully remove node_modules (files may be locked); continuing - npm will overwrite.' 'WARN' }
}
$npmCommon = @('--omit=dev', '--no-audit', '--no-fund', '--loglevel=error', '--ignore-scripts')
$hasLock = Test-Path (Join-Path $cfg.InstallDir 'package-lock.json')
$npmArgs = if ($hasLock) { @('ci') + $npmCommon } else { @('install') + $npmCommon }
# OFFLINE FIRST. The package carries npm-cache\ (every production tarball of the
# lockfile, stored under its sha512; Build-Package.ps1 step 3a). With it, a
# server without registry access installs and upgrades, and the service is
# down for less time. npm still checks each tarball against the lockfile. The
# registry path below is only the fallback, and the summary says which ran.
$code = 1
$script:DepsSource = $null
$offlineCache = Join-Path $ScriptRoot 'npm-cache'
if ($hasLock -and (Test-Path -LiteralPath (Join-Path $offlineCache '_cacache'))) {
    Log "Installing dependencies OFFLINE from the package cache ($offlineCache)..."
    $code = Invoke-Logged -File $npmCmd -Arguments (@('ci', '--offline', '--cache', $offlineCache) + $npmCommon) -WorkDir $cfg.InstallDir -EnvVars $childEnv
    if ($code -eq 0) { $script:DepsSource = 'offline (package npm-cache)' }
    else {
        Log "Offline npm ci failed (exit $code) - removing the partial node_modules and falling back to the registry..." 'WARN'
        Remove-Item -Recurse -Force $nmPath -ErrorAction SilentlyContinue
    }
} else {
    Log 'No npm-cache\ in this package - dependencies come from the npm registry.' 'WARN'
}
if ($code -ne 0) {
    $code = Invoke-Logged -File $npmCmd -Arguments $npmArgs -WorkDir $cfg.InstallDir -EnvVars $childEnv
    if ($code -eq 0) { $script:DepsSource = 'online (npm registry)' }
}
# `npm ci` is strict: it fails if node_modules/lockfile are out of sync (common
# on a partially-installed repair). Fall back to `npm install`, which reconciles.
if ($code -ne 0 -and $hasLock) {
    Log "npm ci failed (exit $code) - retrying with 'npm install' to reconcile a partial/locked tree..." 'WARN'
    Remove-Item -Recurse -Force $nmPath -ErrorAction SilentlyContinue
    $code = Invoke-Logged -File $npmCmd -Arguments (@('install') + $npmCommon) -WorkDir $cfg.InstallDir -EnvVars $childEnv
}
# A fallback that itself fails (e.g. a transient registry stall mid-install) can
# leave node_modules half-written. Do ONE final clean retry before giving up so a
# simple re-run isn't required to recover.
if ($code -ne 0) {
    Log "npm install failed (exit $code) - removing the partial node_modules and making one final clean attempt..." 'WARN'
    Remove-Item -Recurse -Force $nmPath -ErrorAction SilentlyContinue
    $code = Invoke-Logged -File $npmCmd -Arguments (@('install') + $npmCommon) -WorkDir $cfg.InstallDir -EnvVars $childEnv
}
if ($code -ne 0) { Fail "npm install failed (exit $code). See the captured output above in $LogFile (common causes: no registry access - point npm at an internal mirror or vendor node_modules; or a package-lock mismatch)." }
if (-not $script:DepsSource) { $script:DepsSource = 'online (npm install fallback)' }
Log "Dependencies installed ($($script:DepsSource))." 'OK'

# Refresh the self-hosted browser assets (public\vendor\chart.umd.min.js) from the
# freshly installed node_modules so the served file always matches package.json.
# Non-fatal: the package already ships a known-good copy under public\vendor.
if (Test-Path (Join-Path $cfg.InstallDir 'node_modules\chart.js\dist\chart.umd.min.js')) {
    Log 'Syncing vendored browser assets (npm run vendor:sync)...'
    $code = Invoke-Logged -File $npmCmd -Arguments @('run', 'vendor:sync', '--silent') -WorkDir $cfg.InstallDir -EnvVars $childEnv
    if ($code -ne 0) { Log "vendor:sync failed (exit $code) - keeping the packaged public\vendor assets." 'WARN' }
    else { Log 'Vendored assets synced.' 'OK' }
}

# Reconcile object ownership to the app role on EVERY install/patch (idempotent —
# ALTER ... OWNER to the same owner is a no-op). Migrations run as the app role, and
# ALTER TABLE/SEQUENCE/VIEW requires OWNERSHIP (not just GRANT). On an in-place upgrade
# the base schema may be owned by 'postgres', so without this a future ALTER migration
# fails with "must be owner of table". Runs as superuser so it can reassign ownership.
Log 'Reconciling object ownership to the app role (so migrations can ALTER)...'
$reownAll = @'
DO $do$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename     FROM pg_tables    WHERE schemaname='public' AND tableowner    <> '__OWNER__' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO %I',    r.tablename,    '__OWNER__'); END LOOP;
  FOR r IN SELECT sequencename  FROM pg_sequences WHERE schemaname='public' AND sequenceowner <> '__OWNER__' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO %I', r.sequencename, '__OWNER__'); END LOOP;
  FOR r IN SELECT table_name    FROM information_schema.views WHERE table_schema='public' LOOP
    EXECUTE format('ALTER VIEW public.%I OWNER TO %I',     r.table_name,   '__OWNER__'); END LOOP;
  -- ENUM / composite / domain TYPES too, so ALTER TYPE migrations succeed.
  FOR r IN SELECT t.typname FROM pg_type t
             JOIN pg_namespace n ON n.oid=t.typnamespace
             JOIN pg_roles o ON o.oid=t.typowner
            WHERE n.nspname='public' AND o.rolname <> '__OWNER__'
              AND t.typtype IN ('e','c','d') LOOP
    EXECUTE format('ALTER TYPE public.%I OWNER TO %I', r.typname, '__OWNER__'); END LOOP;
  -- FUNCTIONS / PROCEDURES / AGGREGATES too. A migration that does CREATE OR
  -- REPLACE FUNCTION (or ALTER/DROP) requires the current role to OWN the routine;
  -- on an in-place upgrade these may still be owned by postgres from the original
  -- schema load, so without this a later migration fails with a must-be-owner error.
  -- pg_get_function_identity_arguments yields the exact signature ALTER needs.
  FOR r IN SELECT p.proname, p.prokind,
                  pg_get_function_identity_arguments(p.oid) AS args
             FROM pg_proc p
             JOIN pg_namespace n ON n.oid=p.pronamespace
             JOIN pg_roles o ON o.oid=p.proowner
            WHERE n.nspname='public' AND o.rolname <> '__OWNER__'
              -- Skip routines that belong to an EXTENSION (pg_trgm, unaccent,
              -- pgcrypto, citext, ...). Those are owned by 'postgres' by design;
              -- reassigning them is wrong and can break extension upgrade/drop.
              AND NOT EXISTS (SELECT 1 FROM pg_depend d
                               WHERE d.objid=p.oid AND d.classid='pg_proc'::regclass
                                 AND d.deptype='e') LOOP
    IF    r.prokind = 'a' THEN EXECUTE format('ALTER AGGREGATE public.%I(%s) OWNER TO %I', r.proname, r.args, '__OWNER__');
    ELSIF r.prokind = 'p' THEN EXECUTE format('ALTER PROCEDURE public.%I(%s) OWNER TO %I', r.proname, r.args, '__OWNER__');
    ELSE                       EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO %I',  r.proname, r.args, '__OWNER__');
    END IF; END LOOP;
END $do$;
'@
$reownAll = $reownAll.Replace('__OWNER__', $cfg.DbUser)
PsqlFile $cfg.DbName $reownAll | Out-Null
Psql $cfg.DbName "GRANT ALL ON ALL TABLES IN SCHEMA public TO ""$($cfg.DbUser)""" | Out-Null
Psql $cfg.DbName "GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ""$($cfg.DbUser)""" | Out-Null
Psql $cfg.DbName "GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO ""$($cfg.DbUser)""" | Out-Null
Psql $cfg.DbName "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ""$($cfg.DbUser)""" | Out-Null
Psql $cfg.DbName "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ""$($cfg.DbUser)""" | Out-Null
Psql $cfg.DbName "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ""$($cfg.DbUser)""" | Out-Null
Log 'Ownership reconciled to the app role.' 'OK'

# App-only patch (-Patch -SkipMigrations) deliberately makes NO schema/data
# changes. SkipMigrations is honoured only in patch mode - a fresh install /
# reinstall must always migrate so the schema matches the code.
if ($SkipMigrations -and $Patch) {
    Log 'Migrations SKIPPED (app-only patch: -SkipMigrations). No database changes were made by this run, and db\postgres was not refreshed (0 pending migrations verified before the copy).' 'OK'
} else {
    if ($script:MigrateMode) {
        # PRE-FLIGHT: list what will be applied, and refuse a database that is
        # AHEAD of this package (exit 2) before a single migration statement runs.
        # The auto-rollback cannot protect against a downgrade - nothing fails at
        # install time; the wrong code simply runs on a newer schema.
        Log "MIGRATE: pre-flight ($($script:OldVersion) -> $($script:NewVersion))..." 'STEP'
        $pre = Invoke-Logged -File $npmCmd -Arguments @('run', '--silent', 'db:migrate:preflight') -WorkDir $cfg.InstallDir -EnvVars $childEnv
        if ($pre -eq 2) { Fail 'MIGRATE REFUSED: this database was produced by a NEWER version than this package (see the pre-flight list above). Use a package of that version or newer.' }
        if ($pre -ne 0) { Fail "MIGRATE pre-flight failed (exit $pre). See $LogFile." }
    }
    # PRE-MIGRATION DUMP (SA-57). On an EXISTING install, an encrypted and verified
    # pg_dump is taken BEFORE a single migration statement runs
    # (scripts\pre-upgrade-dump.js: the key and pipeline of the daily backup, then
    # pg_restore --list on the decrypted stream; nothing clear on disk). It is the
    # database half of the rollback (docs\ROLLBACK.md): once the new schema is in,
    # the pre-flight refuses the older package, and the code copy alone cannot go
    # back. A failed dump STOPS the run here - nothing has changed in the database
    # yet. -SkipPreMigrationDump is the logged way past it. Never on -Reinstall
    # (the database is recreated) and never on a fresh install.
    $script:PreUpgradeDump = $null
    if ($priorInstallDir -and -not $Reinstall) {
        if ($SkipPreMigrationDump) {
            Log 'Pre-migration database dump SKIPPED (-SkipPreMigrationDump): after these migrations the only way back is your own verified backup.' 'WARN'
            $script:PreUpgradeDump = 'SKIPPED (-SkipPreMigrationDump)'
        } elseif (-not (Test-Path -LiteralPath (Join-Path $cfg.InstallDir 'scripts\pre-upgrade-dump.js'))) {
            Fail 'Pre-migration database dump: scripts\pre-upgrade-dump.js is missing from the install directory - NO migration was applied. Use the complete package produced by Build-Package.ps1, or pass -SkipPreMigrationDump if you hold your own verified backup.'
        } else {
            $dumpDir = Join-Path $LogDir 'backups'
            New-Item -ItemType Directory -Force -Path $dumpDir | Out-Null
            Log "Taking the encrypted pre-migration database dump into $dumpDir ..." 'STEP'
            $fromV = if ($script:OldVersion) { $script:OldVersion } else { 'prev' }
            $toV = if ($script:NewVersion) { $script:NewVersion } else { 'new' }
            $dumpEnv = $childEnv.Clone()
            # The pg_dump beside the psql this run uses (same client major); the
            # verification then picks the pg_restore next to it.
            $pgDumpExe = if ($pgBin) { Join-Path $pgBin 'pg_dump.exe' } else { '' }
            if ($pgDumpExe -and (Test-Path -LiteralPath $pgDumpExe)) { $dumpEnv['PG_DUMP_PATH'] = $pgDumpExe }
            $dcode = Invoke-Logged -File $nodeExe -Arguments @('scripts\pre-upgrade-dump.js', '--from', $fromV, '--to', $toV, '--out-dir', $dumpDir) -WorkDir $cfg.InstallDir -EnvVars $dumpEnv
            if ($dcode -ne 0) { Fail "Pre-migration database dump FAILED (exit $dcode) - NO migration was applied, the database is unchanged. Fix the cause shown above (backup key, pg_dump, disk space) and run Setup again, or pass -SkipPreMigrationDump if you hold your own verified backup." }
            $script:PreUpgradeDump = Get-ChildItem -LiteralPath $dumpDir -File -Filter 'pre-upgrade-*.dump.enc' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
            Log "Pre-migration dump verified: $($script:PreUpgradeDump)" 'OK'
            Log '  (rollback: docs\ROLLBACK.md - restore this dump, then the code copy app-backups\app-<old>-<stamp>)'
        }
    }
    Log 'Applying database migrations...'
    $code = Invoke-Logged -File $npmCmd -Arguments @('run', 'db:migrate:all') -WorkDir $cfg.InstallDir -EnvVars $childEnv
    if ($code -ne 0) { Fail "Migrations failed (exit $code). The full SQL error is captured above in $LogFile." }
    Log 'Migrations applied.' 'OK'
    if ($script:MigrateMode) {
        # POST-FLIGHT: the same report must now show ZERO pending. A second pass
        # of the runner is also the idempotency proof every release is held to.
        $post = Invoke-Logged -File $npmCmd -Arguments @('run', '--silent', 'db:migrate:postflight') -WorkDir $cfg.InstallDir -EnvVars $childEnv
        if ($post -ne 0) {
            # The migration pass itself SUCCEEDED (or we would not be here): the
            # database already carries the new schema. Say so - the code rollback
            # that follows puts the OLD version on the NEW schema, and the operator
            # must know to re-run Migrate rather than keep the rolled-back version.
            Log "MIGRATE post-flight failed (exit $post) AFTER a successful migration pass: the DATABASE now carries the $($script:NewVersion) schema. The code will be rolled back to $($script:OldVersion); re-run Migrate (or restore the database backup taken before this run) rather than keeping the old version on the new schema." 'ERROR'
            Fail "MIGRATE post-flight failed (exit $post): the report still lists pending migrations after the run (the database WAS migrated). See $LogFile."
        }
        Log "MIGRATE: schema verified - nothing pending; $($script:OldVersion) to $($script:NewVersion)." 'OK'
    }
}

if ($dataImported) {
    Log 'Seed skipped - data snapshot already imported (existing logins preserved).' 'OK'
} else {
    Log 'Seeding default data...'
    $code = Invoke-Logged -File $npmCmd -Arguments @('run', 'db:seed') -WorkDir $cfg.InstallDir -EnvVars $childEnv
    if ($code -ne 0) { Log "Seed step returned $code (may already be seeded - see log)." 'WARN' }
    else { Log 'Seed complete.' 'OK' }
}

# Security: never leave an unknown or well-known admin password on a FRESH DB.
#   * A fresh database (fresh install / full reinstall) gets the STANDARD
#     appliance admin password from config.psd1 (StandardAdminPassword) when one
#     is configured - whether the bundled snapshot was imported (whose 'admin'
#     row carries the DEV machine's password, known to nobody on site) or the
#     seed ran - with a change REQUIRED at first login.
#   * Without a standard password: a seeded DB gets a random one shown once on
#     the console; an imported snapshot keeps its imported credentials.
#   * A patch / upgrade / migrate NEVER touches it (existing logins preserved).
#   * "Fresh database" = created in this run ($freshDb) OR (re)provisioned from
#     the snapshot in this run ($dataImported: a full reinstall drops and
#     recreates an EXISTING database, so $freshDb - computed before STEP 4b -
#     is false there; that gap shipped a reinstall whose 'admin' password was
#     the dev machine's, 3.22.93).
$script:adminPw = $null; $script:adminPwStandard = $false
if ($freshDb -or $dataImported) {
    if ($cfg.ContainsKey('StandardAdminPassword') -and $cfg.StandardAdminPassword) {
        $script:adminPw = $cfg.StandardAdminPassword; $script:adminPwStandard = $true
    } elseif (-not $dataImported) {
        $script:adminPw = New-Secret 9   # 18 hex chars
    }
    if ($script:adminPw) {
        # In the child's ENVIRONMENT, never on its command line (the process list
        # is readable by every local user); Invoke-Logged removes it right after.
        $pwEnv = @{} + $childEnv; $pwEnv['SET_ADMIN_PASSWORD'] = $script:adminPw
        $code = Invoke-Logged -File $nodeExe -Arguments @('scripts\set-admin-password.js') -WorkDir $cfg.InstallDir -EnvVars $pwEnv
        if ($code -ne 0) {
            Log "Could not set the admin password (exit $code). The database's own admin credential still applies (seed output above, or the imported snapshot)." 'WARN'
            $script:adminPw = $null; $script:adminPwStandard = $false
        } elseif ($script:adminPwStandard) {
            Log 'Default admin set to the standard appliance password (config.psd1 StandardAdminPassword) - change required at first login.' 'OK'
        } else {
            Log 'Default admin secured with a random password (change required at first login).' 'OK'
        }
    }
}

# S-06: audit-trail ownership, AFTER migrations + seed (they need the app role to
# own everything; the reconcile above handed it back). Never fatal. OFF by default
# for a new install; an upgrade keeps the state the database was in (read before
# the reconcile) and is offered the switch (-EnableAuditOwnerSeparation, or a
# 'yes' at the console).
$aoCfg = if ($cfg.ContainsKey('AuditOwnerSeparation')) { $cfg.AuditOwnerSeparation } else { 'Auto' }
$aoFresh = (-not $priorAny) -or $freshDb -or $dataImported
$script:AuditPlan = Resolve-AuditOwnerPlan $aoCfg $aoFresh $script:AuditSeparatedNow $EnableAuditOwnerSeparation.IsPresent
Log "Audit-trail ownership: $($script:AuditPlan.Reason)."
if ($script:AuditPlan.Recommend) {
    Log "AVAILABLE: audit-trail ownership separation - the append-only tables and their guard triggers owned by the NOLOGIN role '$($script:AuditOwnerRole)'; '$($cfg.DbUser)' keeps SELECT + INSERT, so a stolen DATABASE_URL cannot rewrite history. While it is on, four SuperAdmin tools are refused (Danger-Zone cleanup, data reset, snapshot restore, SQL-console revert). Re-run with -EnableAuditOwnerSeparation to turn it on."
    # Asked on an upgrade only: a new install keeps the default without a question.
    if (-not $aoFresh -and (Test-CanAsk)) {
        if (Read-OperatorYes 'Separate the audit-trail ownership now (the four SuperAdmin tools above are then refused)?') {
            $script:AuditPlan = Resolve-AuditOwnerPlan $aoCfg $aoFresh $script:AuditSeparatedNow $true
            Log 'Operator accepted the audit-trail ownership separation.' 'OK'
        } else { Log 'Audit-trail ownership left with the app role (operator declined).' }
    }
}
if ($script:AuditPlan.On) {
    # Not PsqlFile: that one Fails the step, and this must never fail the run.
    $aoFile = Join-Path $env:TEMP 'idevelop-audit-owner.sql'
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        Set-Content -LiteralPath $aoFile -Value (Get-AuditOwnerSql $script:AuditOwnerRole $cfg.DbUser $script:LegacyAuditOwnerRole) -Encoding UTF8
        $aoOut = & $psql -h $cfg.PgHost -p $cfg.PgPort -U postgres -d $cfg.DbName -t -A -v ON_ERROR_STOP=1 -f $aoFile 2>&1
        $aoRc = $LASTEXITCODE
        $aoTxt = Hide-Secrets (($aoOut | Out-String).Trim())
        if ($aoRc -ne 0) { Log "Audit-trail ownership separation failed (psql exit $aoRc): $aoTxt" 'WARN' }
        elseif ($aoTxt -match 'AUDIT_OWNER_SKIPPED') { Log 'Audit-trail ownership NOT separated: the installer session is not a PostgreSQL superuser.' 'WARN' }
        else { Log "Audit-trail tables owned by '$($script:AuditOwnerRole)' (NOLOGIN); '$($cfg.DbUser)' keeps SELECT + INSERT only. $aoTxt" 'OK' }
    } catch { Log "Audit-trail ownership separation failed: $($_.Exception.Message)" 'WARN' }
    finally { $ErrorActionPreference = $prevEAP; Remove-Item -LiteralPath $aoFile -ErrorAction SilentlyContinue }
} else {
    Log "Audit-trail ownership: not separated - '$($cfg.DbUser)' owns the append-only tables."
}

# THE BACKUP ENCRYPTION KEY (scripts\backup-key.js, docs/BACKUPS.md), run from
# the install dir (it reads .env / APP_KEY there):
#   init              idempotent - creates the key ONLY when none exists (never
#                     regenerates); exit 0; JSON { keyId, protection, keyring, created }
#   status            exit 0; JSON { keyId, protection, exportedAt }
#   export --out <f>  the recovery copy, ONCE: exit 0 written; exit 3 already exported
# Only the parsed flags are logged (created / protection / exportedAt), never the
# raw output, and never the recovery key itself (it goes to a file).
# $RunNode {param([string[]]$KeyArgs)} -> @{ Code; Out }; $AskPath {} -> path or
# $null; $AfterWrite {} -> re-grant the service account on the keyring (the
# script writes it with a protected DACL: SYSTEM + Administrators + owner).
# Result: absent | init-failed | <created|existing>/<exported-now|exported-to-server|exported-earlier|NOT-exported|app-key-derived>
function Invoke-BackupKeyHook([string]$InstallDir, [scriptblock]$RunNode, [scriptblock]$AskPath, [scriptblock]$AfterWrite) {
    if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'scripts\backup-key.js'))) {
        Log 'Backup encryption key: scripts\backup-key.js is not in this package - no key initialised.' 'WARN'
        return 'absent'
    }
    $parse = { param($t) $m = [regex]::Match("$t", '(?s)\{.*\}'); if ($m.Success) { try { $m.Value | ConvertFrom-Json } catch { $null } } }
    $in = & $RunNode @('init')
    if ([int]$in.Code -ne 0) { Log "Backup encryption key: init failed (exit $($in.Code)) - the daily backup creates it, or fails and alerts, until it exists." 'WARN'; return 'init-failed' }
    $ij = & $parse $in.Out
    $state = if ($ij -and $ij.created -eq $true) { 'created' } else { 'existing' }
    if ($state -eq 'created') { Log "Backup encryption key created (protection: $(if ($ij.protection) { $ij.protection } else { '?' }))." 'OK' }
    else { Log 'Backup encryption key: present - kept (init never regenerates an existing key).' 'OK' }
    if ($AfterWrite) { & $AfterWrite | Out-Null }
    if ($ij -and $ij.protection -and $ij.protection -ne 'dpapi-localmachine') {
        Log "Backup encryption key is DERIVED from APP_KEY (protection '$($ij.protection)'): there is no separate recovery key - keep an OFFLINE copy of the APP_KEY line of .env instead, and change APP_KEY only with scripts\rotate-app-key.js." 'WARN'
        return "$state/app-key-derived"
    }
    $sj = & $parse ((& $RunNode @('status')).Out)
    if ($sj -and $sj.exportedAt) {
        Log "Backup recovery key: already exported on $($sj.exportedAt) - not shown again."
        return "$state/exported-earlier"
    }
    # Where the ONE export goes: the path the operator types (interactive), else
    # %ProgramData%\IDevelop\keys\backup-recovery-<keyId>.txt (SYSTEM +
    # Administrators only, never granted to the service) with a loud WARN to move
    # it offline. Never inside the install dir (copied into every code backup).
    $keyTag = if ($ij -and $ij.keyId) { ("$($ij.keyId)" -replace '[^A-Za-z0-9_-]', '_') } else { 'current' }
    $fallback = Join-Path (Join-Path $LogDir 'keys') "backup-recovery-$keyTag.txt"
    $cands = @()
    $dest = & $AskPath
    if ($dest) {
        $full = $null
        try { $full = [IO.Path]::GetFullPath($dest) } catch { $full = $null }
        $instRoot = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\') + '\'
        if (-not $full) { Log "Recovery key: '$dest' is not a valid path - written to the server's key folder instead." 'WARN' }
        elseif ($full.StartsWith($instRoot, [StringComparison]::OrdinalIgnoreCase)) { Log "Recovery key: not inside the install directory ('$full') - written to the server's key folder instead." 'WARN' }
        else { $cands += $full }
    }
    $cands += $fallback
    foreach ($target in $cands) {
        try { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null } catch {}
        $ex = & $RunNode @('export', '--out', $target)
        if ($AfterWrite) { & $AfterWrite | Out-Null }   # export stamps exportedAt in the keyring
        if ([int]$ex.Code -eq 3) { Log 'Backup recovery key: already exported earlier - not shown again.'; return "$state/exported-earlier" }
        if ([int]$ex.Code -ne 0) { Log "Recovery key export to '$target' failed (exit $($ex.Code); the file must not exist yet)." 'WARN'; continue }
        if ($target -ne $fallback) {
            Log "Backup recovery key saved to $target - move it to OFFLINE storage (removable media in a safe) and delete any other copy." 'OK'
            return "$state/exported-now"
        }
        Log "BACKUP RECOVERY KEY WRITTEN TO $target (SYSTEM + Administrators only). MOVE IT TO OFFLINE STORAGE NOW (removable media in a safe) AND DELETE IT FROM THIS SERVER: whoever holds this file and a backup can read the HR data, and without it the backups cannot be restored on another server (backup-key.js import --in <file>)." 'WARN'
        return "$state/exported-to-server"
    }
    Log "RECOVERY KEY NOT EXPORTED YET: as an administrator, from $InstallDir run  node scripts\backup-key.js export --out <removable drive>\idevelop-backup-recovery-key.txt  and keep that file OFFLINE. Without it, encrypted backups cannot be restored on another server." 'WARN'
    return "$state/NOT-exported"
}

# Every run (fresh install AND upgrade): 'init' once .env / APP_KEY exist - it
# creates the key only when there is none and never regenerates one; the
# recovery-key export is offered until it has been done ONCE. Never fatal.
$script:BackupKeyResult = $null
try {
    $script:BackupKeyResult = Invoke-BackupKeyHook -InstallDir $cfg.InstallDir -RunNode {
        param([string[]]$KeyArgs)
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        Push-Location $cfg.InstallDir
        try {
            $o = & $nodeExe (@('scripts\backup-key.js') + $KeyArgs) 2>&1
            return [pscustomobject]@{ Code = $LASTEXITCODE; Out = (($o | Out-String).Trim()) }
        } finally { Pop-Location; $ErrorActionPreference = $prevEAP }
    } -AfterWrite {
        # The keyring gets a protected DACL (SYSTEM + Administrators + OWNER RIGHTS)
        # and its owner is the administrator running Setup: a virtual-account
        # service must be put on the file itself or every backup is refused.
        # (A migration still pending does it in Protect-AppDataAcls.) Read on the
        # keyring ONLY - never on an exported backup-recovery-*.txt.
        if ($script:ServiceAclSid) {
            foreach ($kf in @(Get-ChildItem -LiteralPath (Join-Path $LogDir 'keys') -File -Force -Filter 'backup-keyring*.json' -ErrorAction SilentlyContinue)) {
                if (-not (Set-ServiceSidAce $kf.FullName $false 'Read')) { Log "ACL: could not grant the service account on $($kf.FullName) - backups would be refused under the virtual account." 'WARN' }
            }
        }
    } -AskPath {
        if (-not (Test-CanAsk)) { return $null }
        Write-Host ''
        Write-Host '  BACKUP RECOVERY KEY - written ONCE. Backups are encrypted with a key kept on this server.' -ForegroundColor Yellow
        Write-Host '  If this server is lost, the backups can only be restored with the recovery key.' -ForegroundColor Yellow
        Write-Host '  Save it to REMOVABLE media and keep it OFFLINE (a safe), never on this server or a share.' -ForegroundColor Yellow
        Log 'QUESTION (answer in the setup CONSOLE window): where to save the backup recovery key' 'STEP'
        $p = ''
        try { $p = Read-Host '  Full path of the file to write (e.g. E:\idevelop-backup-recovery-key.txt; blank = the server key folder, to move offline yourself)' } catch { $p = '' }
        return "$p".Trim().Trim('"')
    }
} catch { Log "Backup key step skipped: $($_.Exception.Message)" 'WARN' }

# ---------------------------------------------------------------------------
# STEP 6/7 - Service (Windows service via WinSW, or SYSTEM Scheduled Task)
# ---------------------------------------------------------------------------
if ($NoService) {
    Set-Step 6 'Service'
    Log 'STEP 6/7 - Service (skipped via -NoService)' 'STEP'
} else {
    Set-Step 6 'Register auto-start service'
    Log "STEP 6/7 - Register auto-start service (mode: $($cfg.ServiceMode))" 'STEP'
    Register-AppService
    $kindTxt = if ($script:ServiceKind -eq 'WindowsService') { 'Windows service' } else { 'Scheduled Task' }
    Log "Service '$($cfg.ServiceName)' registered and started as a $kindTxt." 'OK'
}

# ---------------------------------------------------------------------------
# Windows integration: Add/Remove Programs entry, a servicing copy of the
# maintenance scripts, and Start Menu shortcuts.
#
# WHY: a per-machine Windows application is expected to be visible and
# removable from "Apps & features" WITHOUT the original media. Before this, the
# only way to uninstall was to still have the installer package lying around -
# so an administrator who deleted it had no supported removal path at all, and
# nothing in Windows showed that the product was installed or how big it was.
#
# The uninstaller and its config are copied INTO the install directory
# (<InstallDir>\maintenance) precisely so UninstallString points at a path that
# survives; the extracted package under %ProgramData% is wiped by the next run.
# ---------------------------------------------------------------------------
function Install-MaintenanceTools {
    $dest = Join-Path $cfg.InstallDir 'maintenance'
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    # Maintain-IDevelop.ps1 + Installer-Gui.ps1 are what makes "Modify" in
    # Apps & features open the MODERN maintenance window. Without them Windows
    # had nothing to call but Manage-IDevelop.ps1, which with no arguments
    # printed a console usage line and quit.
    foreach ($f in @('Uninstall-IDevelop.ps1', 'config.psd1', 'Manage-IDevelop.ps1',
                     'Maintain-IDevelop.ps1', 'Installer-Gui.ps1')) {
        $src = Join-Path $ScriptRoot $f
        if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $dest -Force }
    }
    return $dest
}

# Resolve an .ico for the ARP entry and the shortcuts. Build-Package generates
# one from the app icon; if it is missing we fall back to the Node executable so
# the entry still shows SOME icon rather than a blank placeholder.
function Resolve-AppIcon {
    # The icon ships inside the payload (app\public\icons) and is therefore
    # already under InstallDir by the time this runs.
    $installed = Join-Path $cfg.InstallDir 'public\icons\idevelop.ico'
    if (Test-Path -LiteralPath $installed) { return $installed }
    return $script:nodeExe
}

function Register-AppEntry {
    try {
        $maint   = Install-MaintenanceTools
        $unPs1   = Join-Path $maint 'Uninstall-IDevelop.ps1'
        $icon    = Resolve-AppIcon
        $ver     = if ($script:NewVersion) { $script:NewVersion } else { '0.0.0' }
        $verNums = ($ver -split '[^\d]') | Where-Object { $_ -ne '' }
        $maj     = if ($verNums.Count -ge 1) { [int]$verNums[0] } else { 0 }
        $min     = if ($verNums.Count -ge 2) { [int]$verNums[1] } else { 0 }

        # EstimatedSize is reported in KB and is what "Apps & features" shows as
        # the install size. Measured, not guessed - and capped so a pathological
        # tree cannot overflow the DWORD.
        $sizeKb = 0
        try {
            $bytes = (Get-ChildItem -LiteralPath $cfg.InstallDir -Recurse -File -Force -ErrorAction SilentlyContinue |
                      Measure-Object -Property Length -Sum).Sum
            $sizeKb = [int][Math]::Min([Math]::Round($bytes / 1KB), 2147483647)
        } catch { $sizeKb = 0 }

        $key = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$($cfg.ArpKeyName)"
        New-Item -Path $key -Force | Out-Null
        $pwsh = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
        $vals = [ordered]@{
            DisplayName     = "$($cfg.AppName) V3"
            DisplayVersion  = $ver
            Publisher       = $cfg.Publisher
            InstallLocation = $cfg.InstallDir
            InstallDate     = (Get-Date).ToString('yyyyMMdd')
            DisplayIcon     = $icon
            UninstallString = "`"$pwsh`" -NoProfile -ExecutionPolicy Bypass -File `"$unPs1`""
            # QuietUninstallString is what Windows uses for an unattended removal
            # (Settings, winget, and management tools all prefer it when present).
            QuietUninstallString = "`"$pwsh`" -NoProfile -ExecutionPolicy Bypass -File `"$unPs1`" -Silent"
            # Modify opens the modern maintenance window. It falls back to
            # Manage-IDevelop.ps1 only if the servicing copy predates it, so an
            # upgrade from an older install never leaves a dead button.
            ModifyPath      = "`"$pwsh`" -NoProfile -ExecutionPolicy Bypass -File `"$(
                $m = Join-Path $maint 'Maintain-IDevelop.ps1'
                if (Test-Path -LiteralPath $m) { $m } else { Join-Path $maint 'Manage-IDevelop.ps1' })`""
            HelpLink        = $cfg.HelpLink
            URLInfoAbout    = $cfg.AboutUrl
            Comments        = 'Competency and performance management, installed on-premise as a Windows service.'
        }
        foreach ($k in $vals.Keys) {
            if ($null -ne $vals[$k] -and $vals[$k] -ne '') {
                New-ItemProperty -Path $key -Name $k -Value ([string]$vals[$k]) -PropertyType String -Force | Out-Null
            }
        }
        foreach ($p in @{ EstimatedSize = $sizeKb; VersionMajor = $maj; VersionMinor = $min; NoModify = 0; NoRepair = 0 }.GetEnumerator()) {
            New-ItemProperty -Path $key -Name $p.Key -Value ([int]$p.Value) -PropertyType DWord -Force | Out-Null
        }
        Log "Registered in Apps & features: $($cfg.AppName) V3 $ver ($([Math]::Round($sizeKb/1024)) MB)." 'OK'
    } catch {
        # Never fail an otherwise good install over a cosmetic registry entry.
        Log "Could not write the Apps & features entry: $($_.Exception.Message)" 'WARN'
    }

    # --- Start Menu (All Users) ---------------------------------------------
    if ($script:SkipShortcuts) {
        Log 'Start Menu shortcuts skipped (unchecked in the setup wizard).'
        return
    }
    try {
        $programs = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'
        $folder   = Join-Path $programs $cfg.StartMenuFolder
        New-Item -ItemType Directory -Force -Path $folder | Out-Null
        $icon = Resolve-AppIcon
        $maint = Join-Path $cfg.InstallDir 'maintenance'
        $pwsh = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

        # The app itself is a web application: the correct "launch" shortcut is a
        # URL shortcut, not an executable. Written as a .url file (Explorer and
        # the Start Menu both honour IconFile/IconIndex on these).
        $url = Join-Path $folder "$($cfg.AppName).url"
        @(
            '[InternetShortcut]',
            "URL=http://localhost:$($cfg.AppPort)/",
            "IconFile=$icon",
            'IconIndex=0'
        ) | Set-Content -LiteralPath $url -Encoding ASCII

        $sh = New-Object -ComObject WScript.Shell
        $mk = {
            param($path, $target, $args, $desc, $iconPath)
            $lnk = $sh.CreateShortcut($path)
            $lnk.TargetPath = $target
            if ($args) { $lnk.Arguments = $args }
            $lnk.WorkingDirectory = $cfg.InstallDir
            $lnk.Description = $desc
            if ($iconPath -and (Test-Path -LiteralPath $iconPath)) { $lnk.IconLocation = "$iconPath,0" }
            $lnk.Save()
        }
        & $mk (Join-Path $folder "$($cfg.AppName) Maintenance.lnk") $pwsh `
             "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $maint 'Manage-IDevelop.ps1')`"" `
             "Service control, backups, admin password reset for $($cfg.AppName)" $icon
        & $mk (Join-Path $folder "Uninstall $($cfg.AppName).lnk") $pwsh `
             "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $maint 'Uninstall-IDevelop.ps1')`"" `
             "Remove $($cfg.AppName) from this computer" $icon
        Log "Start Menu shortcuts created under '$($cfg.StartMenuFolder)'." 'OK'
    } catch {
        Log "Could not create the Start Menu shortcuts: $($_.Exception.Message)" 'WARN'
    }
}

# ---------------------------------------------------------------------------
# STEP 7/7 - Firewall + health check
# ---------------------------------------------------------------------------
Set-Step 7 'Firewall + health check'
Log 'STEP 7/7 - Firewall + health check' 'STEP'
if (-not $SkipFirewall -and ($cfg.OpenFirewall -ne $false)) {
    $activeCats = @()
    try { $activeCats = @(Get-NetConnectionProfile -ErrorAction Stop | ForEach-Object { "$($_.NetworkCategory)" }) } catch { $activeCats = @() }
    $fwCfg = if ($cfg.ContainsKey('FirewallProfiles')) { $cfg.FirewallProfiles } else { $null }
    $fw = Resolve-FirewallProfiles $fwCfg $activeCats
    $fwProfiles = $fw.Profiles
    if ($fw.PublicAdded) {
        Log ("Firewall: a network this machine is connected to is classified PUBLIC - the rule is opened on the Public profile too, otherwise the app would be unreachable. Classify that network as Private/Domain (Settings > Network) and re-run a Patch to close it on Public.") 'WARN'
    }
    $fwName = "IDevelop ($($cfg.AppPort))"
    # Every rule this product owns carries the Group 'IDevelop', and on every run
    # the rules it owns are ENUMERATED (by group, and by the 'IDevelop*' display
    # name older versions used): a rule for a port no longer in use (an old
    # fallback port, a disabled HTTPS port) is removed, an untagged rule for a
    # current port is re-created tagged.
    $fwWanted = @($fwName)
    if ($script:HttpsOn) { $fwWanted += "IDevelop HTTPS ($($script:HttpsPort))" }
    try {
        $fwOwned = @(Get-AppFirewallRules)
        $fwPlan = Get-FirewallRulePlan $fwOwned $fwWanted $script:FirewallGroup
        foreach ($r in @($fwPlan.Remove)) {
            try { Remove-NetFirewallRule -Name $r.Name -ErrorAction Stop; Log "Firewall: removed '$($r.DisplayName)' ($($r.Why))." 'OK' }
            catch { Log "Firewall: could not remove '$($r.DisplayName)': $($_.Exception.Message)" 'WARN' }
        }
    } catch { Log "Firewall: rule enumeration skipped ($($_.Exception.Message))." 'WARN' }
    $existingRule = Get-NetFirewallRule -DisplayName $fwName -ErrorAction SilentlyContinue
    if (-not $existingRule) {
        New-NetFirewallRule -DisplayName $fwName -Group $script:FirewallGroup -Direction Inbound -Action Allow `
            -Protocol TCP -LocalPort $cfg.AppPort -Profile $fwProfiles | Out-Null
        Log "Firewall rule added for TCP $($cfg.AppPort) on profile(s): $($fwProfiles -join ', ')." 'OK'
    } else {
        # Earlier versions created the rule with '-Profile Any': narrow it on upgrade.
        $want = ($fwProfiles | Sort-Object) -join ','
        foreach ($rule in @($existingRule)) {
            $have = "$($rule.Profile)"
            $haveList = if ($have -eq 'Any') { 'Domain,Private,Public' } else { (($have -split ',\s*') | Sort-Object) -join ',' }
            if ($haveList -ne $want) {
                try {
                    Set-NetFirewallRule -Name $rule.Name -Profile $fwProfiles -ErrorAction Stop
                    Log "Firewall rule '$fwName' narrowed: profile $have -> $($fwProfiles -join ', ')." 'OK'
                } catch { Log "Could not update the firewall rule profile ($($_.Exception.Message)) - left as $have." 'WARN' }
            }
        }
    }
    # HTTPS port (S-05): same profiles as the HTTP rule.
    if ($script:HttpsOn) {
        $fwTls = "IDevelop HTTPS ($($script:HttpsPort))"
        try {
            $tlsRule = Get-NetFirewallRule -DisplayName $fwTls -ErrorAction SilentlyContinue
            if (-not $tlsRule) {
                New-NetFirewallRule -DisplayName $fwTls -Group $script:FirewallGroup -Direction Inbound -Action Allow -Protocol TCP -LocalPort $script:HttpsPort -Profile $fwProfiles -ErrorAction Stop | Out-Null
                Log "Firewall rule added for TCP $($script:HttpsPort) (HTTPS) on profile(s): $($fwProfiles -join ', ')." 'OK'
            } else {
                foreach ($rule in @($tlsRule)) { Set-NetFirewallRule -Name $rule.Name -Profile $fwProfiles -ErrorAction Stop }
            }
        } catch { Log "Could not create the HTTPS firewall rule ($($_.Exception.Message)) - open TCP $($script:HttpsPort) manually." 'WARN' }
    }
}

if (-not $NoService) {
    Log 'Waiting for the app to come up...'
    # Prefer the dedicated /health endpoint (always 200 JSON, no redirect);
    # Wait-AppHealthy falls back to / for older builds.
    $ok = Wait-AppHealthy
    if ($ok -and $script:HttpsOn) {
        Log "Application is UP: https://localhost:$($script:HttpsPort)/ (HTTP port $($cfg.AppPort) answers with a redirect to HTTPS - that is expected)." 'OK'
    } elseif ($ok) {
        Log "Application is UP at http://localhost:$($cfg.AppPort)/ (responds with a redirect to the login page - that is expected)." 'OK'
    }
    elseif ($script:BackupDir) {
        # This is an upgrade / patch and the NEW version failed its health check.
        # Fail throws into the catch block, which performs the automatic rollback
        # to the previous (working) version.
        Fail "The new version did not respond on port $($cfg.AppPort) after ~60s - rolling back to the previous version."
    }
    else {
        # Fresh install with nothing to roll back to: report clearly, don't fail
        # the whole run (the app may simply still be warming up).
        Log "App not responding on port $($cfg.AppPort) after ~60s. Check the '$($cfg.ServiceName)' task, or run:  cd `"$($cfg.InstallDir)`"; node server.js" 'WARN'
    }
}

# LocalSystem -> NT SERVICE\<name>, only now that the upgrade is known healthy on
# the old account, with its own health check and way back (a failure here
# reverts the ACCOUNT, never the upgrade that just succeeded).
if ($script:SvcPlan.Migrate) {
    if ($NoService -or $script:ServiceKind -ne 'WindowsService') {
        Log "Service account migration skipped: the app is hosted as '$($script:ServiceKind)', not a Windows service (a Scheduled Task host always runs as SYSTEM)." 'WARN'
        $script:SvcMigration = [pscustomobject]@{ Result = 'NOT-APPLICABLE'; Steps = @() }
    } else {
        Log "Service account migration: LocalSystem -> $($script:SvcPlan.Account) (SID $($script:SvcPlan.Sid))..." 'STEP'
        $script:SvcMigration = Invoke-ServiceAccountMigration $script:SvcPlan.Sid $script:SvcPlan.Account @{
            ApplyAcls  = { param($grantSid, $revokeSids) $script:ServiceAclSid = $grantSid; $script:RevokeAclSids = @($revokeSids); return [int](Protect-AppDataAcls $LogDir $cfg.InstallDir) }
            SetAccount = {
                param($account)
                $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
                try { & sc.exe config $cfg.ServiceName obj= $account *> $null } finally { $ErrorActionPreference = $prevEAP }
                $sn = $null
                try { $sn = (Get-CimInstance Win32_Service -Filter "Name='$($cfg.ServiceName)'" -ErrorAction Stop).StartName } catch { $sn = $null }
                return ("$sn" -ieq $account)
            }
            Restart    = { try { Restart-Service -Name $cfg.ServiceName -Force -ErrorAction Stop } catch { Log "Service restart: $($_.Exception.Message)" 'WARN' } }
            Healthy    = { return [bool](Wait-AppHealthy) }
        }
        Log "Service account migration steps: $($script:SvcMigration.Steps -join ' > ')"
        switch ($script:SvcMigration.Result) {
            'MIGRATED' {
                Set-ServiceAccountContext ([pscustomobject]@{ Mode = 'Virtual'; Account = $script:SvcPlan.Account; Sid = $script:SvcPlan.Sid; VirtualSid = $script:SvcPlan.VirtualSid; Migrate = $false })
                Log "Service account: the service now runs as $($script:SvcPlan.Account) and answers its health check." 'OK'
            }
            'ROLLED-BACK' { Log 'Service account migration: the service was NOT healthy as the virtual account - put back on LocalSystem, healthy again. The upgrade itself is kept. See the ACL lines above, then retry with -MigrateServiceAccount.' 'WARN' }
            'ABORTED-ACL' { Log 'Service account migration NOT attempted: a data folder could not be granted to the virtual account (see the ACL WARN lines above). The service stays on LocalSystem.' 'WARN' }
            'ABORTED-SC'  { Log 'Service account migration NOT attempted: sc.exe could not change the service account. The service stays on LocalSystem.' 'WARN' }
            default       { Log "Service account migration: the way back to LocalSystem did NOT bring the app up ($($script:SvcMigration.Result)). Check the service '$($cfg.ServiceName)' now: sc.exe qc $($cfg.ServiceName); Restart-Service $($cfg.ServiceName)." 'ERROR' }
        }
    }
}

# Declare the product to Windows only once the install is known good. Doing it
# earlier would leave an "Apps & features" entry advertising a version that the
# automatic rollback had just reverted.
Register-AppEntry

if (-not (Test-PortInUse 6379)) {
    $msg = 'Redis not detected - background jobs (dispute escalator, notifications) run inline. Optional: install Redis/Memurai and set REDIS_URL in .env, then restart the service.'
    if ($cfg.RedisExpected) { Log $msg 'WARN' } else { Log $msg }
}

Log ''
Log '==================================================' 'OK'
Log " IDevelop installation complete." 'OK'
Log "   URL          : http://localhost:$($cfg.AppPort)/" 'OK'
Log "   Install dir  : $($cfg.InstallDir)" 'OK'
Log "   Database     : $($cfg.DbName) @ $($cfg.PgHost):$($cfg.PgPort) (ssl=$($cfg.PgSsl))" 'OK'
$svcKindTxt = if ($script:ServiceKind -eq 'WindowsService') { 'Windows service' } elseif ($script:ServiceKind -eq 'ScheduledTask') { 'Scheduled Task' } else { 'not installed (-NoService)' }
Log "   Service      : $($cfg.ServiceName) ($svcKindTxt)" 'OK'
if ($Patch) { Log "   Mode         : PATCH (code updated; database + data preserved)" 'OK' }
if ($script:OldVersion -or $script:NewVersion) {
    $ovTxt2 = if ($script:OldVersion) { $script:OldVersion } else { 'none' }
    $nvTxt2 = if ($script:NewVersion) { $script:NewVersion } else { '?' }
    Log "   Version      : $ovTxt2 -> $nvTxt2" 'OK'
}
if ($script:BackupDir) { Log "   Code backup  : $($script:BackupDir)" 'OK' }
if ($dataImported) {
    Log "   Data         : full snapshot imported (org, employees, skills, assessments, talent)" 'OK'
}
if ($script:adminPwStandard) {
    Log "   Admin login  : admin / the standard appliance admin password (config.psd1 StandardAdminPassword) - change required at first login" 'OK'
} elseif ($dataImported) {
    Log "   Admin login  : imported credentials (use the existing username/password from the source system)" 'OK'
} elseif ($script:adminPw) {
    # Print the one-time password to the interactive CONSOLE only — never through Log,
    # which also writes the install log + transcript (would defeat "shown once").
    Write-Host "   Admin login  : admin / $($script:adminPw)" -ForegroundColor Cyan
    Log "   Admin login  : admin / (shown on console only - not written to logs)" 'OK'
    Log "                  ^ shown ONCE on screen - record it now; a change is required at first login." 'WARN'
} elseif ($freshDb) {
    Log "   Admin login  : admin / (random password printed ONCE in the seed output above - see the install log for the FIRST-RUN SUPERADMIN box)" 'WARN'
} else {
    Log "   Admin login  : unchanged (existing database reused)" 'OK'
}
Log "   Install log  : $LogFile" 'OK'
Log '==================================================' 'OK'

$script:InstallSucceeded = $true

}   # end try
catch {
    # Controlled failures (Fail -> InstallerError) are already logged with the
    # reason. Anything else is an unexpected crash - capture the full detail so
    # the window shows WHAT broke instead of just closing.
    $err = $_
    if ($err.Exception -isnot [InstallerError]) {
        Log "UNEXPECTED ERROR at step $($script:CurrentStep)/$($script:TotalSteps) ($($script:CurrentName)):" 'ERROR'
        Log ("  {0}" -f $err.Exception.Message) 'ERROR'
        if ($err.InvocationInfo) { Log ("  at {0}:{1}" -f $err.InvocationInfo.ScriptName, $err.InvocationInfo.ScriptLineNumber) 'ERROR' }
        # Full stack trace to the log only (keeps the console readable).
        Add-Content -Path $LogFile -Value ($err.ScriptStackTrace)
        Add-Content -Path $LogFile -Value ($err | Out-String)
    }
    $script:InstallSucceeded = $false

    # Automatic restore-on-failure. Only an upgrade / patch has a pre-upgrade
    # backup ($script:BackupDir); a fresh install has nothing to revert to. The
    # new version was already stopped/overwritten during deploy, so the box is
    # currently down on a bad build - bring the previous version back online.
    if ($script:BackupDir -and -not $NoRollback) {
        $reason = if ($err.Exception) { $err.Exception.Message } else { 'installation failed' }
        Invoke-Rollback $reason | Out-Null
    } elseif ($script:BackupDir -and $NoRollback) {
        Log "Upgrade failed and -NoRollback was set - the previous version was NOT restored. Backup: $($script:BackupDir)" 'WARN'
        $script:RolledBack = 'SKIPPED'
    }
}
finally {
    Write-Progress -Id 1 -Activity 'IDevelop installation' -Completed

    # Mark the final reached step OK if it never failed (success path).
    if ($script:InstallSucceeded -and $script:CurrentStep -gt 0 -and -not ($script:StepResults | Where-Object { $_.Step -eq $script:CurrentStep })) {
        Record-Step $script:CurrentStep $script:CurrentName 'OK'
    }

    # ---- Machine-readable summary: paste straight into a CAB ticket. ----
    try {
        $overall = if ($script:InstallSucceeded) { 'SUCCESS' } else { 'FAILED' }
        $modeLabel = if ($Patch) { 'PATCH' } elseif ($Repair) { 'REPAIR' } else { 'INSTALL/UPGRADE' }
        $sum = @()
        $sum += 'IDevelop - Installation Summary'
        $sum += '==================================='
        $sum += "Result        : $overall"
        $sum += "Mode          : $modeLabel"
        $sum += "Timestamp     : $(Get-Date -Format o)"
        $sum += "Computer      : $env:COMPUTERNAME"
        $sum += "Install dir   : $($cfg.InstallDir)"
        $sum += "Database      : $($cfg.DbName) @ $($cfg.PgHost):$($cfg.PgPort) (ssl=$($cfg.PgSsl))"
        $sum += "App URL       : http://localhost:$($cfg.AppPort)/"
        $sumKind = if ($script:ServiceKind -eq 'WindowsService') { "Windows service (WinSW)" } elseif ($script:ServiceKind -eq 'ScheduledTask') { 'Scheduled Task (SYSTEM)' } else { "none ($($cfg.ServiceMode))" }
        $sum += "Service host  : $($cfg.ServiceName) - $sumKind"
        if ($script:OldVersion -or $script:NewVersion) {
            $ovS = if ($script:OldVersion) { $script:OldVersion } else { 'none' }
            $nvS = if ($script:NewVersion) { $script:NewVersion } else { '?' }
            $sum += "Version       : $ovS -> $nvS"
        }
        if ($script:BackupDir) { $sum += "Code backup   : $($script:BackupDir)" }
        if ($script:AppBackupPruned) { $sum += "Code backups  : $($script:AppBackupPruned)" }
        # Least-privilege / hardening / drift outcomes, one line each.
        if ($script:SvcPlan) {
            $svcTxt = "$($script:SvcAcct.Account) - $($script:SvcPlan.Reason)"
            if ($script:SvcMigration) { $svcTxt += " - migration: $($script:SvcMigration.Result)" }
            elseif ($script:SvcPlan.Recommend) { $svcTxt += ' - RECOMMENDED: -MigrateServiceAccount' }
            $sum += "Service acct  : $svcTxt"
        }
        if ($script:AuditPlan) { $sum += "Audit owner   : $(if ($script:AuditPlan.On) { 'separated' } else { 'not separated' }) - $($script:AuditPlan.Reason)" }
        if ($script:PgHardeningSummary) { $sum += "PG hardening  : $($script:PgHardeningSummary)" }
        if ($script:ManifestSummary) { $sum += "Manifest      : $($script:ManifestSummary)" }
        if ($script:BackupKeyResult) { $sum += "Backup key    : $($script:BackupKeyResult)" }
        if ($script:PreUpgradeDump) { $sum += "DB dump (pre) : $($script:PreUpgradeDump)" }
        if ($script:DepsSource) { $sum += "Dependencies  : $($script:DepsSource)" }
        if (-not $script:InstallSucceeded) {
            $sum += "Failed at     : Step $($script:CurrentStep)/$($script:TotalSteps) - $($script:CurrentName)"
        }
        if ($script:RolledBack) {
            $rbTxt = switch ($script:RolledBack) {
                'SUCCESS'          { 'YES - previous version restored and confirmed UP' }
                'FAILED-UNHEALTHY' { 'ATTEMPTED - restored but not responding (manual recovery needed)' }
                'ERROR'            { 'ATTEMPTED - rollback hit an error (see log; backup preserved)' }
                'SKIPPED'          { 'NO - disabled via -NoRollback (failed build left in place)' }
                default            { $script:RolledBack }
            }
            $sum += "Auto-rollback : $rbTxt"
        }
        $sum += ''
        $sum += 'Per-step results:'
        for ($n = 1; $n -le $script:TotalSteps; $n++) {
            $r = $script:StepResults | Where-Object { $_.Step -eq $n } | Select-Object -Last 1
            if ($r)      { $line = "  [{0}] Step {1}: {2}" -f $r.Status, $n, $r.Name; if ($r.Detail) { $line += " - $($r.Detail)" } }
            else         { $line = "  [SKIPPED] Step {0}: (not reached)" -f $n }
            $sum += $line
        }
        $sum += ''
        $sum += "Full log      : $LogFile"
        if ($script:TranscriptOn) { $sum += "Transcript    : $Transcript" }
        Set-Content -Path $SummaryFile -Value $sum -Encoding UTF8
        # Also echo the summary into the main log so a single file has it all.
        Add-Content -Path $LogFile -Value ''
        Add-Content -Path $LogFile -Value $sum
    } catch { Write-Host "  (could not write summary file: $($_.Exception.Message))" -ForegroundColor DarkYellow }

    Write-Host ''
    if ($script:InstallSucceeded) {
        try { $Host.UI.RawUI.WindowTitle = 'IDevelop install - DONE' } catch {}
        Write-Host '  ============================================================' -ForegroundColor Green
        Write-Host '   INSTALLATION COMPLETE' -ForegroundColor Green
        Write-Host ("   Open    :  http://localhost:{0}/" -f $cfg.AppPort) -ForegroundColor Green
        Write-Host ("   Log     :  {0}" -f $LogFile) -ForegroundColor Green
        Write-Host ("   Summary :  {0}" -f $SummaryFile) -ForegroundColor Green
        Write-Host '  ============================================================' -ForegroundColor Green
    } elseif ($script:RolledBack -eq 'SUCCESS') {
        # The new version failed, but the previous one was automatically restored
        # and is serving again - the box is NOT down. Make that unmistakably clear.
        try { $Host.UI.RawUI.WindowTitle = 'IDevelop install - FAILED, rolled back (service UP)' } catch {}
        Write-Host '  ============================================================' -ForegroundColor Yellow
        Write-Host ("   NEW VERSION FAILED at step {0}/{1}: {2}" -f $script:CurrentStep, $script:TotalSteps, $script:CurrentName) -ForegroundColor Yellow
        Write-Host  '   AUTOMATIC ROLLBACK SUCCEEDED - the PREVIOUS version was' -ForegroundColor Green
        Write-Host ("   restored and is UP at http://localhost:{0}/." -f $cfg.AppPort) -ForegroundColor Green
        Write-Host  '   No downtime remains. Investigate the failure, then retry:' -ForegroundColor Yellow
        Write-Host ("     - Summary :  {0}" -f $SummaryFile) -ForegroundColor Yellow
        Write-Host ("     - Log     :  {0}" -f $LogFile) -ForegroundColor Yellow
        if ($script:BackupDir) { Write-Host ("     - Backup  :  {0}" -f $script:BackupDir) -ForegroundColor Yellow }
        Write-Host '  ============================================================' -ForegroundColor Yellow
    } else {
        try { $Host.UI.RawUI.WindowTitle = "IDevelop install - FAILED at step $($script:CurrentStep)/$($script:TotalSteps)" } catch {}
        Write-Host '  ============================================================' -ForegroundColor Red
        Write-Host ("   INSTALLATION FAILED at step {0}/{1}: {2}" -f $script:CurrentStep, $script:TotalSteps, $script:CurrentName) -ForegroundColor Red
        if ($script:RolledBack -in @('FAILED-UNHEALTHY','ERROR')) {
            Write-Host  '   Automatic rollback was attempted but did NOT fully restore service.' -ForegroundColor Red
            if ($script:BackupDir) { Write-Host ("   Manual recovery: stop the service, copy {0} over {1}, restart." -f $script:BackupDir, $cfg.InstallDir) -ForegroundColor Yellow }
        }
        Write-Host  '   To fix it, send these three files to support:' -ForegroundColor Yellow
        Write-Host ("     1. {0}" -f $SummaryFile) -ForegroundColor Yellow
        Write-Host ("     2. {0}" -f $LogFile) -ForegroundColor Yellow
        if ($script:TranscriptOn) { Write-Host ("     3. {0}" -f $Transcript) -ForegroundColor Yellow }
        Write-Host  '   The log holds the captured npm / psql / migration output.' -ForegroundColor Yellow
        Write-Host '  ============================================================' -ForegroundColor Red
    }
    Write-Host ''

    # Stop the transcript before pausing so it's flushed to disk.
    if ($script:TranscriptOn) { try { Stop-Transcript | Out-Null } catch {} }

    if ($script:Gui) {
        # End screen of the progress window: outcome, the few lines that matter,
        # and Open / Open log / Close. The person's choice is the pause.
        try {
            $appUrl = 'http://localhost:{0}/' -f $cfg.AppPort
            $outcome = if ($script:InstallSucceeded) { 'success' } elseif ($script:RolledBack -eq 'SUCCESS') { 'rolledback' } else { 'failed' }
            $lines = @()
            if ($script:OldVersion -and $script:NewVersion) { $lines += ('Version: {0} -> {1}' -f $script:OldVersion, $script:NewVersion) }
            elseif ($script:NewVersion) { $lines += ('Version: {0}' -f $script:NewVersion) }
            switch ($outcome) {
                'success' {
                    $lines += ('{0} is installed and running at {1}' -f $cfg.AppName, $appUrl)
                    if ($script:adminPwStandard) { $lines += 'Sign in as admin with the standard appliance password - a change is required at first login.' }
                    elseif ($script:adminPw) { $lines += 'The one-time admin password was shown in the setup console.' }
                    $lines += ('Log: {0}' -f $LogFile)
                }
                'rolledback' {
                    $lines += ('The new version failed at step {0} of {1} ({2}).' -f $script:CurrentStep, $script:TotalSteps, $script:CurrentName)
                    $lines += ('The previous version was restored automatically and is running at {0}' -f $appUrl)
                    $lines += ('Summary: {0}' -f $SummaryFile)
                }
                default {
                    $lines += ('Failed at step {0} of {1} ({2}).' -f $script:CurrentStep, $script:TotalSteps, $script:CurrentName)
                    $lines += ('Send these files to support: {0}' -f $SummaryFile)
                    $lines += ('{0}' -f $LogFile)
                }
            }
            Complete-InstallerGui -Gui $script:Gui -Outcome $outcome -Summary $lines -AppUrl $appUrl -LogFile $LogFile -SummaryFile $SummaryFile
            $openApp = Wait-InstallerGui -Gui $script:Gui
            if ($openApp) { try { Start-Process $appUrl } catch {} }
        } catch { Write-Host "  (progress window: $($_.Exception.Message))" -ForegroundColor DarkYellow }
    } elseif ([Environment]::UserInteractive -and $Host.Name -ne 'ServerRemoteHost') {
        # Guaranteed pause so the console NEVER just disappears - even when launched
        # by a double-click or a self-elevated relaunch. Skipped only in fully
        # non-interactive hosts (e.g. CI) where no console is attached.
        try { Read-Host '  Press Enter to close this window' | Out-Null } catch {}
    }
    if (-not $script:InstallSucceeded) { exit 1 }
}
