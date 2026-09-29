<#
.SYNOPSIS  IDevelop maintenance: full backup (code + database) and restore.
.DESCRIPTION
    Creates and restores "restore points" - each one a self-contained snapshot of
    the running install: the application code PLUS a full SQL dump of the database
    and a manifest. Used by Setup.bat before every patch / upgrade / reinstall (so
    there is always a rollback), and by the Maintenance menu to restore a previous
    version + its database.

    Restore points live under  %ProgramData%\IDevelop\restore-points\rp-<ver>-<stamp>\
        app\           - the application code at that point (no node_modules)
        database.sql   - full pg_dump (--no-owner --no-privileges), plain SQL
        manifest.json  - version, timestamp, db name, note

.PARAMETER Backup    Create a new restore point (code + database).
.PARAMETER List      List existing restore points.
.PARAMETER Restore   Restore a restore point (code + database) and restart the service.
.PARAMETER RestorePoint  Folder name to restore (with -Restore); if omitted, choose interactively.
.PARAMETER PgSuperPassword  PostgreSQL 'postgres' superuser password (needed for -Restore: drop+recreate the DB).
.PARAMETER Note      Optional label stored in the restore point's manifest.
.PARAMETER Keep      How many restore points to keep when pruning after a backup (default 8).
.PARAMETER ResetSuperadminMfa  SuperAdmin username whose two-factor authentication is cleared (OS-admin recovery, 3.23.20).
.EXAMPLE  .\Manage-IDevelop.ps1 -Backup -Note "before 3.22.1 upgrade"
.EXAMPLE  .\Manage-IDevelop.ps1 -List
.EXAMPLE  .\Manage-IDevelop.ps1 -Restore -PgSuperPassword 'StrongPgPass!'
#>
[CmdletBinding()]
param(
    [switch]$Backup,
    [switch]$List,
    [switch]$Restore,
    [switch]$CheckDb,          # report DB reachability (postgres + app role) - read-only
    [switch]$SetPgPassword,    # change the postgres superuser password to the standard
    [switch]$SetAdminPassword, # reset the application 'admin' login to config.psd1 StandardAdminPassword
    [string]$ResetSuperadminMfa, # 3.23.20: OS-admin recovery - clear a SuperAdmin's MFA (username)
    [string]$RestorePoint,
    [string]$PgSuperPassword,
    [string]$Note,
    [int]$Keep = 8
)

$ErrorActionPreference = 'Stop'
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# The postgres password may arrive through the environment (SETUP_PG_SUPER_PASSWORD)
# instead of -PgSuperPassword: the launchers use that channel so the value never
# sits on a command line (transcript headers) and never crosses cmd.exe's delayed
# expansion (which eats '!'). See Install-IDevelop.ps1 for the measurements.
if (-not $PgSuperPassword -and $env:SETUP_PG_SUPER_PASSWORD) { $PgSuperPassword = $env:SETUP_PG_SUPER_PASSWORD }

# --- Elevation (backup/restore touch Program Files, the service and the DB) ---
$wid = [Security.Principal.WindowsIdentity]::GetCurrent()
$prp = New-Object Security.Principal.WindowsPrincipal($wid)
if (-not $prp.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host '  Administrator rights required - relaunching elevated (approve the UAC prompt)...' -ForegroundColor Yellow
    # Forward the ORIGINAL parameters. $MyInvocation.UnboundArguments is EMPTY for a
    # script with a param block - everything is bound - so the previous relaunch
    # started the elevated copy with no arguments at all: a -Backup request silently
    # became a do-nothing "manage" run and no restore point was ever created.
    $fwd = @()
    foreach ($kv in $PSBoundParameters.GetEnumerator()) {
        # The secret goes to the elevated child through the environment, never
        # back onto a command line.
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
    # -Wait + real exit code: callers (Setup.bat, deploy runners) must be able to tell
    # a failed backup from a successful one before they touch the installation.
    $child = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList -Wait -PassThru
    Write-Host ("  Elevated run finished (exit {0}). Log: {1}" -f $child.ExitCode, "$env:ProgramData\IDevelop\logs") -ForegroundColor Gray
    exit $child.ExitCode
}

# Console + file logging. Every run writes a timestamped log under
# %ProgramData%\IDevelop\logs so any issue is easy to trace afterwards.
$script:LogFile = $null
function Log($m, $lvl = 'INFO') {
    $c = switch ($lvl) { 'OK' { 'Green' } 'WARN' { 'Yellow' } 'ERROR' { 'Red' } 'STEP' { 'Cyan' } default { 'Gray' } }
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'HH:mm:ss'), $lvl, $m
    Write-Host ("  $line") -ForegroundColor $c
    if ($script:LogFile) { try { Add-Content -Path $script:LogFile -Value $line } catch {} }
}
function Die($m) { Log $m 'ERROR'; exit 1 }

# --- Config + paths ---
$cfgPath = Join-Path $ScriptRoot 'config.psd1'
if (-not (Test-Path $cfgPath)) { Die "config.psd1 not found next to this script ($cfgPath)." }
$cfg = Import-PowerShellDataFile -Path $cfgPath
$LogDir = Join-Path $env:ProgramData 'IDevelop'
$rpRoot = Join-Path $LogDir 'restore-points'
$LogsDir = Join-Path $LogDir 'logs'
New-Item -ItemType Directory -Force -Path $rpRoot, $LogsDir | Out-Null
$action = if ($Backup) { 'backup' } elseif ($Restore) { 'restore' } elseif ($List) { 'list' } elseif ($CheckDb) { 'checkdb' } elseif ($SetPgPassword) { 'setpgpw' } elseif ($ResetSuperadminMfa) { 'resetsamfa' } else { 'manage' }
$script:LogFile = Join-Path $LogsDir ('manage-{0}-{1}.log' -f $action, (Get-Date -Format 'yyyyMMdd-HHmmss'))
Log "=== IDevelop maintenance: $action | $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') | log: $script:LogFile ===" 'STEP'

# --- Data-at-rest ACLs (3.23.17, S-01) - same rule as Install-IDevelop.ps1 ---
# Restore points hold the .env and a full database.sql; the daily dumps and the
# code backups sit next to them. SYSTEM + Administrators only (SIDs: the group is
# 'Administrateurs' on a French box). Idempotent and never fatal.
$script:HardenedAclSids = @('S-1-5-18', 'S-1-5-32-544')
# 3.23.18 (S-04): ServiceAccount = 'Virtual' -> NT SERVICE\<ServiceName> is also
# granted (Modify on folders, Read on the .env). Same rule as the installer.
$script:ServiceAclSid = $null
$script:RevokeAclSids = @()
# S-1-5-80-<SHA-1 of the upper-cased service name, UTF-16LE, five LE DWORDs> -
# what 'sc.exe showsid <name>' prints.
function Get-ServiceSid([string]$Name) {
    $sha = [System.Security.Cryptography.SHA1]::Create()
    try { $h = $sha.ComputeHash([System.Text.Encoding]::Unicode.GetBytes($Name.ToUpperInvariant())) } finally { $sha.Dispose() }
    $parts = @(); for ($i = 0; $i -lt 20; $i += 4) { $parts += [BitConverter]::ToUInt32($h, $i) }
    return 'S-1-5-80-' + ($parts -join '-')
}
function Resolve-ServiceAccount($Configured, [string]$ServiceName) {
    $v = "$Configured".Trim()
    $virtualName = "NT SERVICE\$ServiceName"
    if ($v -eq 'Virtual' -or $v -eq $virtualName) {
        return [pscustomobject]@{ Mode = 'Virtual'; Account = $virtualName; Sid = (Get-ServiceSid $ServiceName) }
    }
    if (-not $v -or $v -eq 'LocalSystem') { return [pscustomobject]@{ Mode = 'LocalSystem'; Account = 'LocalSystem'; Sid = $null } }
    return [pscustomobject]@{ Mode = 'Custom'; Account = $v; Sid = $null }
}
function Test-AclHardened([string]$Path) {
    try {
        $allowed = @($script:HardenedAclSids) + @(@($script:ServiceAclSid) | Where-Object { $_ })
        $seen = @()
        $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
        if (-not $acl.AreAccessRulesProtected) { return $false }
        foreach ($r in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
            if ($allowed -notcontains $r.IdentityReference.Value) { return $false }
            $seen += $r.IdentityReference.Value
        }
        if ($script:ServiceAclSid -and ($seen -notcontains $script:ServiceAclSid)) { return $false }
        return $true
    } catch { return $false }
}
# The virtual account's ACE goes through .NET, not icacls: icacls refuses a SID
# it cannot map yet (error 1332 before the service exists). Same as the installer.
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
            $have = @($rules | Where-Object { $_.IdentityReference.Value -eq $script:ServiceAclSid -and $_.AccessControlType -eq 'Allow' -and (($_.FileSystemRights -band $right) -eq $right) -and $_.InheritanceFlags -eq $inhF })
            if (-not $have.Count) {
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
function Protect-SensitivePath([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return 'absent' }
    if (Test-AclHardened $Path) { return 'already restricted' }
    $isDir = (Get-Item -LiteralPath $Path -Force).PSIsContainer
    $inh = if ($isDir) { '(OI)(CI)' } else { '' }
    $rc = 1
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        # Explicit broad grants first (whole tree, while still listable), then drop inheritance.
        $tree = if ($isDir) { '/T' } else { $null }
        & icacls.exe $Path /remove:g '*S-1-5-32-545' '*S-1-5-11' '*S-1-1-0' '*S-1-3-0' '*S-1-5-32-547' $tree /C /Q *> $null
        & icacls.exe $Path /inheritance:r /grant:r "*S-1-5-18:${inh}F" "*S-1-5-32-544:${inh}F" /C /Q *> $null
        $rc = $LASTEXITCODE
    } catch { $rc = 1 } finally { $ErrorActionPreference = $prev }
    if ($rc -ne 0) { return "FAILED (icacls exit $rc)" }
    if ($script:ServiceAclSid -or @(@($script:RevokeAclSids) | Where-Object { $_ }).Count) {
        $g = if (-not $script:ServiceAclSid) { '' } elseif ($isDir) { 'Modify' } else { 'Read' }
        if (-not (Set-ServiceSidAce $Path $isDir $g)) { return 'FAILED (service-account ACE)' }
    }
    if (Test-AclHardened $Path) { return 'restricted' }
    return 'PARTIAL (an explicit non-admin ACE remains)'
}
function Protect-AppDataAcls([string]$DataRoot, [string]$InstallDir) {
    $targets = @()
    foreach ($sub in @('backups', 'app-backups', 'restore-points', 'sql-restore-points', 'logs', 'audit-anchors', 'tls')) { $targets += (Join-Path $DataRoot $sub) }
    $targets += $DataRoot
    if ($InstallDir) {
        $targets += (Join-Path $InstallDir '.env')
        foreach ($sub in @('logs', 'backups', 'uploads', 'data')) { $targets += (Join-Path $InstallDir $sub) }
    }
    $who = if ($script:ServiceAclSid) { "SYSTEM + Administrators + the service account $($script:ServiceAclSid)" } else { 'SYSTEM + Administrators only' }
    $bad = 0
    foreach ($t in $targets) {
        $r = Protect-SensitivePath $t
        if ($r -eq 'absent') { continue }
        if ($r -like 'FAILED*' -or $r -like 'PARTIAL*') { $bad++; Log "ACL hardening: $t -> $r" 'WARN' }
        else { Log "ACL hardening: $t -> $r ($who)" }
    }
    if ($InstallDir -and (Test-Path -LiteralPath $InstallDir) -and ($script:ServiceAclSid -or @(@($script:RevokeAclSids) | Where-Object { $_ }).Count)) {
        $g = if ($script:ServiceAclSid) { 'Modify' } else { '' }
        if (-not (Set-ServiceSidAce $InstallDir $true $g)) { $bad++; Log "ACL: service-account access on $InstallDir could not be updated." 'WARN' }
    }
    return $bad
}
$script:SvcAcct = Resolve-ServiceAccount $cfg.ServiceAccount $cfg.ServiceName
if ($script:SvcAcct.Mode -eq 'Virtual') { $script:ServiceAclSid = $script:SvcAcct.Sid }
else { $script:RevokeAclSids = @(Get-ServiceSid $cfg.ServiceName) }
# Before any restore point / import log is written: it then inherits the restriction.
if ($action -in @('backup', 'restore')) {
    try { [void](Protect-AppDataAcls $LogDir $cfg.InstallDir) } catch { Log "ACL hardening skipped: $($_.Exception.Message)" 'WARN' }
}

# --- Locate PostgreSQL client tools ---
function Find-PgTool([string]$exe) {
    $c = Get-Command $exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $cand = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName "bin\$exe" } |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    return $cand
}
$pgDump = Find-PgTool 'pg_dump.exe'
$psql   = Find-PgTool 'psql.exe'

# --- postgres superuser auth: try candidate passwords, optionally prompt ---
function Test-PgSuper([string]$pw) {
    $env:PGPASSWORD = $pw
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $out = & $psql -h $cfg.PgHost -p $cfg.PgPort -U postgres -d postgres -t -A -c 'SELECT version()' 2>&1
    $code = $LASTEXITCODE; $ErrorActionPreference = $prev
    return [pscustomobject]@{ ok = ($code -eq 0); out = ($out | Out-String).Trim() }
}
function Get-SuperCandidates {
    $list = New-Object System.Collections.Generic.List[string]
    foreach ($p in @($PgSuperPassword, $cfg.StandardPgSuperPassword)) {
        if ($p -and -not $list.Contains($p)) { $list.Add($p) }
    }
    return $list
}
# Returns @{ pw; ver } for the working postgres password, or $null. With -AllowPrompt
# it asks (securely, 3 tries) for the current password if no candidate works.
function Resolve-SuperPassword([switch]$AllowPrompt) {
    foreach ($c in (Get-SuperCandidates)) {
        $r = Test-PgSuper $c
        if ($r.ok) { return @{ pw = $c; ver = $r.out; which = $(if ($c -eq $cfg.StandardPgSuperPassword) { 'standard appliance password' } else { 'supplied password' }) } }
        $script:lastPgErr = $r.out
    }
    if ($AllowPrompt) {
        for ($i = 1; $i -le 3; $i++) {
            $entered = $null
            try {
                $sec = Read-Host -AsSecureString "  Enter the CURRENT 'postgres' superuser password (attempt $i/3; blank to abort)"
                if ($sec -and $sec.Length -gt 0) { $entered = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)) }
            } catch { $entered = $null }
            if (-not $entered) { break }
            $r = Test-PgSuper $entered
            if ($r.ok) { return @{ pw = $entered; ver = $r.out; which = 'entered password' } }
            Log 'Authentication failed - check the password and try again.' 'WARN'; $script:lastPgErr = $r.out
        }
    }
    return $null
}

# --- Read the app-role connection from the install's .env (for pg_dump) ---
function Get-InstalledDbCreds {
    $envFile = Join-Path $cfg.InstallDir '.env'
    $res = @{ user = $cfg.DbUser; pass = $null; host = $cfg.PgHost; port = $cfg.PgPort; db = $cfg.DbName }
    if (Test-Path $envFile) {
        $line = (Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1)
        if ($line) {
            $url = $line -replace '^DATABASE_URL=', ''
            if ($url -match 'postgres(?:ql)?://([^:]+):([^@]+)@([^:/]+):(\d+)/([^?\s]+)') {
                $res.user = $Matches[1]; $res.pass = $Matches[2]; $res.host = $Matches[3]; $res.port = [int]$Matches[4]; $res.db = $Matches[5]
            }
        }
    }
    return $res
}

function Get-InstalledVersion {
    $vp = Join-Path $cfg.InstallDir 'package.json'
    if (Test-Path $vp) { try { return (Get-Content $vp -Raw | ConvertFrom-Json).version } catch {} }
    return 'unknown'
}

# --- Forgotten-password recovery: reset an unknown local postgres password to
#     $targetPw via a temporary pg_hba.conf 'trust' (restored afterwards). ---
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
        if (-not $dataDir) { $guess = Join-Path (Split-Path $pgBinDir -Parent) 'data'; if (Test-Path (Join-Path $guess 'pg_hba.conf')) { $dataDir = $guess } }
        if (-not $dataDir) { Log 'Auto-reset: could not locate the PostgreSQL data directory.' 'WARN'; return $false }
        $hba = Join-Path $dataDir 'pg_hba.conf'
        if (-not (Test-Path $hba) -or -not $svcName) { Log 'Auto-reset: pg_hba.conf or PG service not found.' 'WARN'; return $false }
        Log "Auto-resetting the unknown 'postgres' password to the standard value (temporary trust on $hba)..." 'STEP'
        $bak = "$hba.idevelop-bak"; Copy-Item -LiteralPath $hba -Destination $bak -Force
        $orig = Get-Content -LiteralPath $hba -Raw
        $trust = "# IDevelop installer - TEMPORARY trust (auto-removed)`r`nhost all all 127.0.0.1/32 trust`r`nhost all all ::1/128 trust`r`n# end temporary`r`n"
        Set-Content -LiteralPath $hba -Value ($trust + $orig) -Encoding ASCII
        Restart-Service -Name $svcName -Force -ErrorAction Stop; [void](Wait-PgReady 25)
        $env:PGPASSWORD = ''
        $lit = $targetPw -replace "'", "''"
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $altOut = & $psql -h 127.0.0.1 -p $cfg.PgPort -U postgres -d postgres -v ON_ERROR_STOP=1 -c "ALTER ROLE postgres WITH PASSWORD '$lit'" 2>&1
        $altOk = ($LASTEXITCODE -eq 0); $ErrorActionPreference = $prev
        Copy-Item -LiteralPath $bak -Destination $hba -Force; Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue; $bak = $null
        Restart-Service -Name $svcName -Force -ErrorAction SilentlyContinue; [void](Wait-PgReady 25)
        if ($altOk) { Log 'postgres password reset to the standard appliance value; trust removed.' 'OK'; return $true }
        # Scrub the password out of any echoed psql error before it reaches the log/transcript.
        $altSafe = if ($altOut) { "$altOut" -replace [regex]::Escape($targetPw), '***' } else { $altOut }
        Log "Auto-reset: ALTER ROLE did not succeed ($altSafe)." 'WARN'; return $false
    } catch {
        Log "Auto-reset error: $($_.Exception.Message). Restoring pg_hba.conf." 'WARN'
        try { if ($bak -and $hba -and (Test-Path $bak)) { Copy-Item -LiteralPath $bak -Destination $hba -Force; Remove-Item $bak -Force -ErrorAction SilentlyContinue } } catch {}
        try { if ($svcName) { Restart-Service -Name $svcName -Force -ErrorAction SilentlyContinue; [void](Wait-PgReady 20) } } catch {}
        return $false
    }
}

# ===========================================================================
#  BACKUP  - code + database -> a new restore point
# ===========================================================================
function Invoke-Backup {
    if (-not (Test-Path $cfg.InstallDir)) { Die "No installation found at '$($cfg.InstallDir)' - nothing to back up." }
    if (-not $pgDump) { Die 'pg_dump.exe not found - install the PostgreSQL client tools.' }
    $creds = Get-InstalledDbCreds
    $ver = Get-InstalledVersion
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $rp = Join-Path $rpRoot "rp-$ver-$stamp"
    New-Item -ItemType Directory -Force -Path $rp | Out-Null
    Log "Creating restore point: $(Split-Path -Leaf $rp)" 'STEP'

    # 1. Code (exclude the heavy/rebuildable bits).
    $appDest = Join-Path $rp 'app'
    New-Item -ItemType Directory -Force -Path $appDest | Out-Null
    $rc = robocopy $cfg.InstallDir $appDest /E /XD 'node_modules' 'logs' 'tmp' /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { Die "Code backup failed (robocopy exit $LASTEXITCODE)." }
    Log 'Application code captured.' 'OK'

    # 2. Database (full plain-SQL dump; --no-owner/--no-privileges so it restores
    #    into a clean DB regardless of role names).
    $dbFile = Join-Path $rp 'database.sql'
    $env:PGPASSWORD = $creds.pass
    try {
        & $pgDump --no-owner --no-privileges -h $creds.host -p $creds.port -U $creds.user -d $creds.db -f $dbFile
        if ($LASTEXITCODE -ne 0) { Die "pg_dump failed (exit $LASTEXITCODE)." }
    } finally { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
    $dbMB = [math]::Round((Get-Item $dbFile).Length / 1MB, 2)
    Log "Database captured (database.sql, $dbMB MB)." 'OK'

    # 3. Manifest.
    $manifest = [ordered]@{
        version   = $ver
        createdUtc = (Get-Date).ToUniversalTime().ToString('o')
        dbName    = $creds.db
        note      = $Note
        appPort   = $cfg.AppPort
    }
    ($manifest | ConvertTo-Json) | Set-Content -Path (Join-Path $rp 'manifest.json') -Encoding UTF8
    Log "Restore point complete: $rp" 'OK'

    # 4. Prune old restore points (keep the newest $Keep).
    $all = Get-ChildItem $rpRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'rp-*' } | Sort-Object LastWriteTime -Descending
    if ($all.Count -gt $Keep) {
        $all | Select-Object -Skip $Keep | ForEach-Object {
            try { Remove-Item -LiteralPath $_.FullName -Recurse -Force; Log "Pruned old restore point: $($_.Name)" } catch {}
        }
    }
    return $rp
}

# ===========================================================================
#  LIST
# ===========================================================================
function Get-RestorePoints {
    Get-ChildItem $rpRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'rp-*' -and (Test-Path (Join-Path $_.FullName 'database.sql')) } |
        Sort-Object LastWriteTime -Descending
}
function Invoke-List {
    $rps = Get-RestorePoints
    if (-not $rps -or $rps.Count -eq 0) { Log 'No restore points found.' 'WARN'; return }
    Write-Host ''
    Write-Host '  #   Restore point                          Version            Created' -ForegroundColor Cyan
    Write-Host '  --  -------------------------------------  -----------------  -------------------'
    $i = 0
    foreach ($rp in $rps) {
        $i++
        $mf = @{}; $mfp = Join-Path $rp.FullName 'manifest.json'
        if (Test-Path $mfp) { try { $mf = Get-Content $mfp -Raw | ConvertFrom-Json } catch {} }
        $ver = if ($mf.version) { $mf.version } else { '?' }
        '  {0,-2}  {1,-37}  {2,-17}  {3}' -f $i, $rp.Name, $ver, $rp.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') | Write-Host
        if ($mf.note) { Write-Host ("        note: " + $mf.note) -ForegroundColor DarkGray }
    }
    Write-Host ''
}

# ===========================================================================
#  RESTORE  - code + database from a chosen restore point
# ===========================================================================
function Invoke-Restore {
    if (-not $psql) { Die 'psql.exe not found - install the PostgreSQL client tools.' }
    $rps = Get-RestorePoints
    if (-not $rps -or $rps.Count -eq 0) { Die 'No restore points available to restore.' }

    # Pick the target restore point.
    $target = $null
    if ($RestorePoint) {
        $target = $rps | Where-Object { $_.Name -eq $RestorePoint } | Select-Object -First 1
        if (-not $target) { Die "Restore point '$RestorePoint' not found." }
    } else {
        Invoke-List
        $sel = Read-Host '  Enter the number of the restore point to RESTORE (or blank to cancel)'
        if (-not $sel) { Log 'Cancelled.'; return }
        if ($sel -notmatch '^\d+$' -or [int]$sel -lt 1 -or [int]$sel -gt $rps.Count) { Die "Invalid selection '$sel'." }
        $target = $rps[[int]$sel - 1]
    }
    $dbFile = Join-Path $target.FullName 'database.sql'
    $appSrc = Join-Path $target.FullName 'app'
    if (-not (Test-Path $dbFile)) { Die "Restore point is missing database.sql." }

    # Verify a WORKING postgres superuser password BEFORE touching anything (tries
    # candidates, then prompts). Confirming up front avoids failing mid-restore
    # after the service is already stopped.
    if (-not $psql) { Die 'psql.exe not found.' }
    $conn = Resolve-SuperPassword -AllowPrompt
    if (-not $conn) { Die "Could not authenticate as 'postgres' (needed to recreate the database). $script:lastPgErr" }
    $superPw = $conn.pw
    Log "postgres superuser: authenticated ($($conn.which))." 'OK'

    Write-Host ''
    Log "About to RESTORE '$($target.Name)'. The current app code and database will be REPLACED by this restore point." 'WARN'
    $confirm = Read-Host '  Type RESTORE to confirm'
    if ($confirm -ne 'RESTORE') { Log 'Cancelled.'; return }

    $creds = Get-InstalledDbCreds
    $svc = $cfg.ServiceName
    # Every step that finished with something to verify by hand lands here; the
    # closing line says "complete" only when this stays empty.
    $script:restoreWarnings = @()

    # 1. Stop the service.
    try { Stop-Service -Name $svc -Force -ErrorAction Stop; Log "Service '$svc' stopped." 'OK' }
    catch { Log "Service '$svc' not running / not found (continuing)." 'WARN' }

    # 2. Restore code. robocopy /E OVERLAYS and never deletes, so a migration
    #    file newer than the restore point would survive in db\postgres and the
    #    service would apply it to the restored database at its next start while
    #    this script announced "RESTORE complete" (measured: 12 files >= 113
    #    against a 3.22.97 point). Every migration the point does not carry is
    #    removed BEFORE the overlay. node_modules is preserved (not in the backup).
    if (Test-Path $appSrc) {
        $purged = Remove-MigrationsNotIn -InstallDir $cfg.InstallDir -Reference $appSrc
        if ($purged.Count) { Log "Removed $($purged.Count) migration file(s) newer than the restore point: $($purged -join ', ')" 'OK' }
        $rc = robocopy $appSrc $cfg.InstallDir /E /XD 'node_modules' /NFL /NDL /NJH /NJS /NP
        if ($LASTEXITCODE -ge 8) { Die "Code restore failed (robocopy exit $LASTEXITCODE)." }
        Log 'Application code restored.' 'OK'
        # The restored .env is a fresh copy that inherits Users:(RX) again (S-01).
        try { [void](Protect-SensitivePath (Join-Path $cfg.InstallDir '.env')) } catch { Log "ACL hardening of the restored .env skipped: $($_.Exception.Message)" 'WARN' }
    } else { Log 'Restore point has no app\ folder - restoring database only.' 'WARN' }

    # 3. Restore the database: drop + recreate + import (as superuser), then re-own
    #    every object to the app role so the app + future migrations work.
    $env:PGPASSWORD = $superPw
    function P([string]$db, [string]$sql) { & $psql -h $creds.host -p $creds.port -U postgres -d $db -v ON_ERROR_STOP=1 -t -A -c $sql }
    try {
        Log "Dropping + recreating database '$($creds.db)'..." 'STEP'
        & $psql -h $creds.host -p $creds.port -U postgres -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ""$($creds.db)"" WITH (FORCE)" | Out-Null
        if ($LASTEXITCODE -ne 0) { Die 'Could not drop the database (check the superuser password / connections).' }
        & $psql -h $creds.host -p $creds.port -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ""$($creds.db)"" OWNER ""$($creds.user)""" | Out-Null
        foreach ($ext in @('citext', 'pgcrypto', 'pg_trgm', 'unaccent')) {
            & $psql -h $creds.host -p $creds.port -U postgres -d $creds.db -c "CREATE EXTENSION IF NOT EXISTS $ext" | Out-Null
        }
        Log 'Importing database.sql...' 'STEP'
        # ON_ERROR_STOP=0 -> psql exits 0 whatever failed (measured: a file with
        # a failing SELECT exits 0). The verdict comes from the `ERROR:` lines in
        # the import log and from a structural count of the core tables, never
        # from the exit code.
        $importLog = Join-Path $LogDir 'last-restore-import.log'
        & $psql -h $creds.host -p $creds.port -U postgres -d $creds.db -v ON_ERROR_STOP=0 -f $dbFile *> $importLog
        $impErrors = @(Select-String -LiteralPath $importLog -Pattern '(^|\s)ERROR:' -ErrorAction SilentlyContinue)
        $impCheck = Test-RestoredDatabase $creds
        if ($impCheck.missing.Count) {
            Die ("Database import FAILED: $($impErrors.Count) SQL error(s) in $importLog and these core tables are missing or empty: " + ($impCheck.missing -join ', ') + ". The service was NOT started. Restore another point or fix the dump.")
        }
        if ($impErrors.Count) {
            $script:restoreWarnings += "database import: $($impErrors.Count) SQL error(s) - see $importLog"
            Log "Database imported WITH $($impErrors.Count) SQL error(s) (see $importLog); core tables verified ($($impCheck.summary))." 'WARN'
        } else { Log "Database imported - 0 SQL errors; verified $($impCheck.summary)." 'OK' }

        # Re-own all objects to the app role. Run via a temp .sql file with -f
        # (NOT -c): PowerShell mangles newlines in a multi-line -c argument, which
        # can let a "--" comment swallow the closing dollar-quote of the DO block.
        $reownSql = @'
DO $do$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO %I', r.tablename, '__OWNER__'); END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO %I', r.sequencename, '__OWNER__'); END LOOP;
  FOR r IN SELECT table_name FROM information_schema.views WHERE table_schema='public' LOOP
    EXECUTE format('ALTER VIEW public.%I OWNER TO %I', r.table_name, '__OWNER__'); END LOOP;
  FOR r IN SELECT t.typname FROM pg_type t
             JOIN pg_namespace n ON n.oid=t.typnamespace
             JOIN pg_roles o ON o.oid=t.typowner
            WHERE n.nspname='public' AND o.rolname <> '__OWNER__'
              AND t.typtype IN ('e','c','d') LOOP
    EXECUTE format('ALTER TYPE public.%I OWNER TO %I', r.typname, '__OWNER__'); END LOOP;
  -- FUNCTIONS / PROCEDURES / AGGREGATES too, so a restored DB can be upgraded
  -- afterwards (CREATE OR REPLACE / ALTER routine requires ownership).
  FOR r IN SELECT p.proname, p.prokind,
                  pg_get_function_identity_arguments(p.oid) AS args
             FROM pg_proc p
             JOIN pg_namespace n ON n.oid=p.pronamespace
             JOIN pg_roles o ON o.oid=p.proowner
            WHERE n.nspname='public' AND o.rolname <> '__OWNER__'
              -- Skip EXTENSION-owned routines (pg_trgm, unaccent, pgcrypto, citext).
              AND NOT EXISTS (SELECT 1 FROM pg_depend d
                               WHERE d.objid=p.oid AND d.classid='pg_proc'::regclass
                                 AND d.deptype='e') LOOP
    IF    r.prokind = 'a' THEN EXECUTE format('ALTER AGGREGATE public.%I(%s) OWNER TO %I', r.proname, r.args, '__OWNER__');
    ELSIF r.prokind = 'p' THEN EXECUTE format('ALTER PROCEDURE public.%I(%s) OWNER TO %I', r.proname, r.args, '__OWNER__');
    ELSE                       EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO %I',  r.proname, r.args, '__OWNER__');
    END IF; END LOOP;
END $do$;
GRANT ALL ON ALL TABLES IN SCHEMA public TO "__OWNER__";
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO "__OWNER__";
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO "__OWNER__";
'@
        $reownSql = $reownSql.Replace('__OWNER__', $creds.user)
        $reownFile = Join-Path $LogDir 'last-restore-reown.sql'
        Set-Content -LiteralPath $reownFile -Value $reownSql -Encoding UTF8
        $reownLog = Join-Path $LogDir 'last-restore-reown.log'
        & $psql -h $creds.host -p $creds.port -U postgres -d $creds.db -v ON_ERROR_STOP=0 -f $reownFile *> $reownLog
        $reownErrors = @(Select-String -LiteralPath $reownLog -Pattern '(^|\s)ERROR:' -ErrorAction SilentlyContinue)
        $notOwned = ''
        try { $notOwned = (P $creds.db "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner <> '$($creds.user)'" | Out-String).Trim() } catch { $notOwned = '?' }
        if ($reownErrors.Count -or $notOwned -ne '0') {
            $script:restoreWarnings += "ownership: $($reownErrors.Count) SQL error(s), $notOwned table(s) still not owned by $($creds.user) - see $reownLog"
            Log "Ownership reconcile finished with $($reownErrors.Count) SQL error(s); $notOwned table(s) still not owned by '$($creds.user)' (see $reownLog). Future migrations may fail with 'must be owner'." 'WARN'
        } else { Log "Database ownership reconciled to the app role - 0 SQL errors, 0 table(s) left with another owner." 'OK' }
        # Does the restored database carry the erasure tombstones (migration 151)?
        $hasTombstones = '?'
        try { $hasTombstones = (P $creds.db "SELECT (to_regclass('public.erasure_tombstones') IS NOT NULL)::int" | Out-String).Trim() } catch { $hasTombstones = '?' }
    } finally { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }

    $nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $nodeExe -and (Test-Path "$env:ProgramFiles\nodejs\node.exe")) { $nodeExe = "$env:ProgramFiles\nodejs\node.exe" }

    # 3a. GDPR (S-07): the restore brought back the database as it was when the
    #     point was taken - including people erased SINCE. Re-apply every erasure
    #     (tombstones table + the mirror file beside the backups) BEFORE the service
    #     starts. Exit 0 = done; 1 = someone could not be erased again; 2 = the run
    #     failed. Anything but 0 is a restore FAILURE: the service is NOT started.
    $era = Invoke-ReapplyErasures -InstallDir $cfg.InstallDir -NodeExe $nodeExe -HasTombstones $hasTombstones
    if ($era.Status -eq 'failed') { Die $era.Message }
    if ($era.Status -eq 'skipped') { $script:restoreWarnings += $era.Message }

    # 3b. PRE-FLIGHT BEFORE THE SERVICE STARTS: the restored code must ship NO
    #     migration the restored database has not applied, or the service would
    #     migrate the point-in-time database at boot (outside this log). The
    #     product's own post-flight report answers exactly that (exit 3 = pending).
    $preflight = Join-Path $cfg.InstallDir 'scripts\migrate-preflight.js'
    if ((Test-Path -LiteralPath $preflight) -and $nodeExe) {
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        Push-Location $cfg.InstallDir
        try { $preOut = & $nodeExe $preflight --expect-none 2>&1; $preRc = $LASTEXITCODE } finally { Pop-Location; $ErrorActionPreference = $prev }
        ($preOut | Out-String) | Add-Content -Path $script:LogFile
        if ($preRc -ne 0) {
            Die "RESTORE REFUSED before start: the restored code and database do not match (migration pre-flight exit $preRc - see the log above). The service was NOT started, so nothing migrates the restored database behind your back. Pick a restore point whose code matches its database, or run Migrate."
        }
        Log 'Migration pre-flight: nothing pending - the restored code matches the restored database.' 'OK'
    } else {
        $script:restoreWarnings += 'migration pre-flight NOT run (scripts\migrate-preflight.js or node.exe not found)'
        Log 'Migration pre-flight could not run (scripts\migrate-preflight.js or node.exe not found) - unmeasured, NOT a pass.' 'WARN'
    }

    # 4. Start the service + health check.
    try { Start-Service -Name $svc -ErrorAction Stop; Log "Service '$svc' started." 'OK' }
    catch { Log "Could not start service '$svc' - start it manually (Start-Service $svc)." 'WARN' }

    Start-Sleep -Seconds 3
    try {
        $r = Invoke-WebRequest -UseBasicParsing "http://localhost:$($cfg.AppPort)/readyz" -TimeoutSec 8
        Log "Health check: /readyz -> $($r.StatusCode)" 'OK'
    } catch { Log "Health check did not pass yet - the app may still be starting. Check http://localhost:$($cfg.AppPort)/readyz" 'WARN' }

    if ($script:restoreWarnings.Count) {
        Log "RESTORE finished WITH $($script:restoreWarnings.Count) warning(s) - now running '$($target.Name)', but verify before trusting it:" 'WARN'
        foreach ($w in $script:restoreWarnings) { Log "  - $w" 'WARN' }
    } else {
        Log "RESTORE complete: now running '$($target.Name)' (import, ownership, erasure re-application and migration pre-flight all verified)." 'OK'
    }
}

# Delete from <InstallDir>\db\postgres every migration file <Reference>\db\postgres
# does not carry; returns their names. Same helper as Install-IDevelop.ps1's rollback.
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

# GDPR (S-07): re-apply every erasure made after the restore point, BEFORE the
# service starts. Runs <InstallDir>\scripts\reapply-erasures.js from the install
# dir (it reads .env there). Returns @{ Status = 'ok'|'skipped'|'failed'; Message }.
#   HasTombstones '0'  -> the restored DB predates migration 151: 'skipped' (warning).
#   script/node absent -> 'failed' (cannot prove the erasures were re-applied).
#   exit code <> 0     -> 'failed' (1 = someone could not be erased again, 2 = run failed).
function Invoke-ReapplyErasures([string]$InstallDir, [string]$NodeExe, [string]$HasTombstones) {
    $reapply = Join-Path $InstallDir 'scripts\reapply-erasures.js'
    if ($HasTombstones -eq '0') {
        $m = 'erasures NOT re-applied: this restore point predates the erasure tombstones (migration 151) - check the mirror file erasure-tombstones-*.jsonl beside the backups and run scripts\reapply-erasures.js after the next Migrate'
        Log "Erasure re-application skipped: $m" 'WARN'
        return @{ Status = 'skipped'; Message = $m }
    }
    if (-not (Test-Path -LiteralPath $reapply) -or -not $NodeExe) {
        $rb = Get-ErasureRunbook -InstallDir $InstallDir -NodeExe $NodeExe -Subjects @() -ExitCode -1
        foreach ($l in $rb) { Log $l 'ERROR' }
        return @{ Status = 'failed'; Runbook = $rb; Message = 'RESTORE FAILED: scripts\reapply-erasures.js or node.exe not found - erasures made after this restore point could not be re-applied. The service was NOT started. Follow the RECOVERY RUNBOOK printed above.' }
    }
    Log 'Re-applying GDPR erasures made after this restore point (scripts\reapply-erasures.js)...' 'STEP'
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $eraRc = 2
    Push-Location $InstallDir
    try { $eraOut = & $NodeExe $reapply 2>&1; $eraRc = $LASTEXITCODE } finally { Pop-Location; $ErrorActionPreference = $prev }
    foreach ($line in @($eraOut)) { if ("$line".Trim()) { Log "  [reapply-erasures] $line" } }
    if ($eraRc -ne 0) {
        # Subjects the script could not erase again ("  ! employee #<id>: <error>").
        $subjects = @()
        foreach ($line in @($eraOut)) { if ("$line" -match 'employee #(\d+)') { $subjects += $Matches[1] } }
        $rb = Get-ErasureRunbook -InstallDir $InstallDir -NodeExe $NodeExe -Subjects $subjects -ExitCode $eraRc
        foreach ($l in $rb) { Log $l 'ERROR' }
        return @{ Status = 'failed'; Runbook = $rb; Subjects = $subjects; Message = "RESTORE FAILED: re-applying GDPR erasures exited $eraRc (1 = at least one person could not be erased again, 2 = the run failed - see the lines above). The service was NOT started: a restored database must not serve the data of people who asked to be erased. Follow the RECOVERY RUNBOOK printed above." }
    }
    Log 'GDPR erasures re-applied (exit 0).' 'OK'
    return @{ Status = 'ok'; Message = 'erasures re-applied' }
}

# ST-4 (3.23.21): the operator-facing recovery runbook printed when the erasure
# re-application fails - which subject(s), the exact rerun command, and how to
# start the service ONLY once the rerun exits 0. Returns the lines (ASCII).
function Get-ErasureRunbook([string]$InstallDir, [string]$NodeExe, [string[]]$Subjects, [int]$ExitCode) {
    $svcName = 'IDevelop'
    if ($cfg -and $cfg.ServiceName) { $svcName = $cfg.ServiceName }
    $node = $NodeExe
    if (-not $node) { $node = "$env:ProgramFiles\nodejs\node.exe" }
    $lines = @()
    $lines += '================ RECOVERY RUNBOOK - GDPR erasure re-application ================'
    if (@($Subjects).Count) {
        $lines += "Subject(s) NOT erased again: employee #$(@($Subjects) -join ', employee #')"
    } elseif ($ExitCode -eq -1) {
        $lines += 'Subject(s): unknown - the script or node.exe is missing, nothing was re-applied.'
    } else {
        $lines += "Subject(s): not identified (exit $ExitCode = the run itself failed) - see the [reapply-erasures] lines above."
    }
    $lines += 'The service is STOPPED on purpose: do not start it until step 2 exits 0.'
    $lines += "1. Fix the cause shown above (database reachable? .env in $InstallDir correct? node.exe installed?)."
    $lines += '2. Re-run the re-application from an elevated PowerShell:'
    $lines += "     cd `"$InstallDir`""
    $lines += "     & `"$node`" scripts\reapply-erasures.js ; `$LASTEXITCODE    (must print 0)"
    $lines += '   If the tombstones table is empty, point it at the mirror file beside the backups:'
    $lines += "     & `"$node`" scripts\reapply-erasures.js --file <backups>\erasure-tombstones-<date>.jsonl"
    $lines += "3. Only then start the service:  Start-Service $svcName"
    $port = '<AppPort>'
    if ($cfg -and $cfg.AppPort) { $port = $cfg.AppPort }
    $lines += "4. Check health:  http://localhost:$port/readyz  (then re-run Manage -CheckDb if in doubt)."
    $lines += '================================================================================='
    return , $lines
}

# Structural proof that an import landed: the core tables exist AND hold rows.
# Uses the superuser connection ($env:PGPASSWORD is set by the caller).
function Test-RestoredDatabase($creds) {
    $missing = @(); $parts = @()
    foreach ($t in @('employees', 'skills', 'admins', 'schema_meta')) {
        $n = -1
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try {
            $raw = & $psql -h $creds.host -p $creds.port -U postgres -d $creds.db -t -A -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.$t" 2>$null
            if ($LASTEXITCODE -eq 0) { $n = [int](("$raw" -split "`n")[0].Trim()) }
        } catch { $n = -1 } finally { $ErrorActionPreference = $prev }
        if ($n -le 0) { $missing += $t }
        $parts += "$t=$(if ($n -lt 0) { 'absent' } else { $n })"
    }
    return @{ missing = $missing; summary = ($parts -join ' ') }
}

# ===========================================================================
#  CHECK DB  - read-only reachability report (pre-flight)
# ===========================================================================
function Invoke-CheckDb {
    Log '=== Database connection check ===' 'STEP'
    if (-not $psql) { Log 'psql.exe NOT found - install the PostgreSQL client tools.' 'ERROR'; return 1 }
    $rc = 0
    # 1. postgres superuser (candidate passwords, no prompt - just report).
    $conn = Resolve-SuperPassword
    if ($conn) {
        Log "postgres superuser : REACHABLE via the $($conn.which)." 'OK'
        Log ("  server           : " + (($conn.ver -split "`n")[0]))
    } else {
        Log 'postgres superuser : NOT reachable with the standard/supplied password.' 'WARN'
        Log '                     (an install/restore will prompt you for the current password.)' 'WARN'
        $rc = 1
    }
    $env:PGPASSWORD = ''
    # 2. app role + app database (from the install .env).
    $creds = Get-InstalledDbCreds
    if ($creds.pass) {
        $env:PGPASSWORD = $creds.pass
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $n = & $psql -h $creds.host -p $creds.port -U $creds.user -d $creds.db -t -A -c 'SELECT count(*) FROM employees' 2>&1
        $code = $LASTEXITCODE; $ErrorActionPreference = $prev
        if ($code -eq 0) { Log "app database '$($creds.db)' : REACHABLE as '$($creds.user)' ($(($n | Out-String).Trim()) employees)." 'OK' }
        else { Log "app database '$($creds.db)' : could NOT be queried as '$($creds.user)'." 'WARN'; $rc = 1 }
        $env:PGPASSWORD = ''
    } else {
        Log "app role           : no DATABASE_URL in $($cfg.InstallDir)\.env (skipped)." 'WARN'
    }
    Log '=== check complete ===' 'STEP'
    return $rc
}

# ===========================================================================
#  SET PG PASSWORD  - change the postgres superuser password to the standard
# ===========================================================================
function Invoke-SetPgPassword {
    Log '=== Standardize the postgres superuser password ===' 'STEP'
    if (-not $psql) { Die 'psql.exe not found.' }
    if (-not ($cfg.ContainsKey('StandardPgSuperPassword') -and $cfg.StandardPgSuperPassword)) {
        Die 'No StandardPgSuperPassword is set in config.psd1 - nothing to change it to.'
    }
    # Authenticate with the CURRENT password (candidates, then prompt).
    $conn = Resolve-SuperPassword -AllowPrompt
    if (-not $conn) {
        # Unknown password: reset it to the standard via temporary trust auth
        # (forgotten-password recovery) rather than giving up.
        Log 'Could not authenticate as postgres - the password is unknown; auto-resetting to the standard value.' 'WARN'
        if (Reset-PgSuperViaTrust $cfg.StandardPgSuperPassword) { return 0 }
        Die 'Could not reset the postgres password (see the log).'
    }
    Log "Authenticated as postgres ($($conn.which))." 'OK'
    if ($conn.pw -eq $cfg.StandardPgSuperPassword) {
        Log 'postgres password already matches the standard appliance value - nothing to change.' 'OK'
        $env:PGPASSWORD = ''; return 0
    }
    $env:PGPASSWORD = $conn.pw
    $lit = $cfg.StandardPgSuperPassword -replace "'", "''"
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & $psql -h $cfg.PgHost -p $cfg.PgPort -U postgres -d postgres -v ON_ERROR_STOP=1 -c "ALTER ROLE postgres WITH PASSWORD '$lit'" | Out-Null
    $code = $LASTEXITCODE; $ErrorActionPreference = $prev
    $env:PGPASSWORD = ''
    if ($code -eq 0) { Log 'postgres superuser password CHANGED to the standard appliance value.' 'OK'; return 0 }
    Die 'ALTER ROLE postgres failed - see the log.'
}

# ===========================================================================
#  SET ADMIN PASSWORD - reset the application 'admin' login to the standard
#  appliance value (config.psd1 StandardAdminPassword), change required at
#  first login. The recovery for "invalid credentials after a fresh install /
#  reinstall" (a 3.22.93 reinstall kept the snapshot's dev-only admin hash).
#  Runs the application's own scripts\set-admin-password.js against the
#  installed .env, so it works on any version that ships that script.
# ===========================================================================
function Invoke-SetAdminPassword {
    Log "=== Reset the application 'admin' password to the standard appliance value ===" 'STEP'
    if (-not ($cfg.ContainsKey('StandardAdminPassword') -and $cfg.StandardAdminPassword)) {
        Die 'No StandardAdminPassword is set in config.psd1 - nothing to set it to.'
    }
    $tool = Join-Path $cfg.InstallDir 'scripts\set-admin-password.js'
    if (-not (Test-Path $tool)) { Die "Not installed: '$tool' not found - install the application first." }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $nodeExe = if ($node) { $node.Source } else { Join-Path $env:ProgramFiles 'nodejs\node.exe' }
    if (-not (Test-Path $nodeExe)) { Die 'node.exe not found - Node.js is required.' }
    $creds = Get-InstalledDbCreds
    if (-not $creds.pass) { Die "No DATABASE_URL in $($cfg.InstallDir)\.env - the application database cannot be reached." }
    Log "Target: 'admin' in database '$($creds.db)' @ $($creds.host):$($creds.port) (via $($cfg.InstallDir)\.env)."
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    Push-Location $cfg.InstallDir
    try { $out = & $nodeExe $tool $cfg.StandardAdminPassword 2>&1; $code = $LASTEXITCODE }
    finally { Pop-Location; $ErrorActionPreference = $prev }
    foreach ($l in @($out)) { if ("$l".Trim()) { Log ("  " + "$l".Trim()) } }
    if ($code -eq 0) {
        Log "'admin' password set to the standard appliance value - a change is required at first login." 'OK'
        return 0
    }
    Die "set-admin-password.js failed (exit $code) - see the log."
}

# ===========================================================================
#  -ResetSuperadminMfa <username> (3.23.20, Amendment C2d): the ONLY recovery
#  path for a SuperAdmin who lost their authenticator when no other SuperAdmin
#  can reset it. OS administrators only (this script is elevated). Runs the
#  application's scripts\reset-superadmin-mfa.js against the installed .env:
#  clears the TOTP secret + backup codes, ends the account's sessions, and the
#  next sign-in is held on MFA enrolment. Audited as MFA_RESET_BY_OS_ADMIN with
#  the Windows user and host; every SuperAdmin is alerted. No web/e-mail path.
# ===========================================================================
function Invoke-ResetSuperadminMfa([string]$Username) {
    Log "=== Reset the two-factor authentication of SuperAdmin '$Username' (OS-admin recovery) ===" 'STEP'
    if (-not $Username.Trim()) { Die 'A SuperAdmin username is required: -ResetSuperadminMfa <username>.' }
    $tool = Join-Path $cfg.InstallDir 'scripts\reset-superadmin-mfa.js'
    if (-not (Test-Path $tool)) { Die "Not installed: '$tool' not found - this version predates the tool (3.23.20)." }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $nodeExe = if ($node) { $node.Source } else { Join-Path $env:ProgramFiles 'nodejs\node.exe' }
    if (-not (Test-Path $nodeExe)) { Die 'node.exe not found - Node.js is required.' }
    $creds = Get-InstalledDbCreds
    if (-not $creds.pass) { Die "No DATABASE_URL in $($cfg.InstallDir)\.env - the application database cannot be reached." }
    Log "Target: SuperAdmin '$Username' in database '$($creds.db)' @ $($creds.host):$($creds.port)."
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    Push-Location $cfg.InstallDir
    try {
        $env:APP_OS_ADMIN_USER = "$env:USERDOMAIN\$env:USERNAME"
        $out = & $nodeExe $tool $Username 2>&1; $code = $LASTEXITCODE
    }
    finally { Pop-Location; $ErrorActionPreference = $prev; Remove-Item Env:\APP_OS_ADMIN_USER -ErrorAction SilentlyContinue }
    foreach ($l in @($out)) { if ("$l".Trim()) { Log ("  " + "$l".Trim()) } }
    if ($code -eq 0) {
        Log "Two-factor authentication of '$Username' cleared - the next sign-in is held on enrolment." 'OK'
        return 0
    }
    Die "reset-superadmin-mfa.js failed (exit $code) - see the log."
}

# ===========================================================================
#  Dispatch
# ===========================================================================
if ($Backup)             { Invoke-Backup | Out-Null; exit 0 }
elseif ($List)           { Invoke-List; exit 0 }
elseif ($Restore)        { Invoke-Restore; exit 0 }
elseif ($CheckDb)        { $rc = Invoke-CheckDb; exit ([int]$rc) }
elseif ($SetPgPassword)  { $rc = Invoke-SetPgPassword; exit ([int]$rc) }
elseif ($SetAdminPassword) { $rc = Invoke-SetAdminPassword; exit ([int]$rc) }
elseif ($ResetSuperadminMfa) { $rc = Invoke-ResetSuperadminMfa $ResetSuperadminMfa; exit ([int]$rc) }
else {
    Write-Host 'Usage: Manage-IDevelop.ps1 -Backup | -List | -Restore [-RestorePoint <name>] | -CheckDb | -SetPgPassword [-PgSuperPassword <pw>] | -SetAdminPassword | -ResetSuperadminMfa <username> [-Note <text>]'
    exit 2
}
