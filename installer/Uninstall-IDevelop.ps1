<#
.SYNOPSIS  Remove the IDevelop app (service, files, firewall rule, Start Menu, Apps & features entry).
.DESCRIPTION
    Stops & removes the auto-start service, removes the firewall rule, the Start
    Menu folder, the "Apps & features" registration and the install directory.
    Node.js and PostgreSQL are left installed (they may be shared).
    Pass -RemoveDatabase to also drop the app database + role (DESTRUCTIVE).
    Pass -RemoveData to also delete %ProgramData%\IDevelop (logs, backups,
    install history) - kept by default so a removal is auditable afterwards.

    Exit codes follow the Windows installer convention so management tools can
    read the result: 0 = success, 1602 = cancelled by the user, 1603 = fatal
    error during removal.
.EXAMPLE  .\Uninstall-IDevelop.ps1
.EXAMPLE  .\Uninstall-IDevelop.ps1 -Silent
.EXAMPLE  .\Uninstall-IDevelop.ps1 -RemoveDatabase -PgSuperPassword 'pgpass'
#>
[CmdletBinding()]
param(
    [switch]$RemoveDatabase,
    [string]$PgSuperPassword,
    [switch]$KeepFiles,
    [switch]$RemoveData,
    # Unattended removal: no confirmation prompt, no "press a key" at the end.
    # This is what QuietUninstallString invokes.
    [switch]$Silent
)
$ErrorActionPreference = 'Stop'
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# Same channel as the installer: the postgres password may arrive through the
# environment (SETUP_PG_SUPER_PASSWORD) so it never sits on a command line.
if (-not $PgSuperPassword -and $env:SETUP_PG_SUPER_PASSWORD) { $PgSuperPassword = $env:SETUP_PG_SUPER_PASSWORD }

# elevate
$prp = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $prp.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    # Forward the ORIGINAL parameters. $MyInvocation.UnboundArguments is EMPTY for
    # a script with a param block (measured: count=0 with three parameters
    # bound), so the elevated copy used to start with NO arguments: -RemoveDatabase
    # / -Silent were dropped and this shell exited 0 without waiting - a clean
    # "success" for work that had not started. Same fix as Install / Manage.
    $fwd = @()
    foreach ($kv in $PSBoundParameters.GetEnumerator()) {
        if ($kv.Key -eq 'PgSuperPassword') { continue }   # environment, not command line
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
        $child = Start-Process powershell.exe -Verb RunAs -ArgumentList $argList -Wait -PassThru
        exit $child.ExitCode
    } catch {
        Write-Host '  Administrator rights are required. Cancelled.' -ForegroundColor Yellow
        exit 1602
    }
}
$cfg = Import-PowerShellDataFile -Path (Join-Path $ScriptRoot 'config.psd1')
if ($PgSuperPassword) { $cfg.PgSuperPassword = $PgSuperPassword }
function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }

# An interactive uninstall names what is about to be removed and what is kept,
# then asks. Removing a production application must never be a silent surprise.
if (-not $Silent) {
    Say ''
    Say "  Uninstall $($cfg.AppName)" 'Cyan'
    Say "    Install dir : $($cfg.InstallDir)"
    Say "    Service     : $($cfg.ServiceName)"
    Say "    Database    : $($cfg.DbName) - $(if ($RemoveDatabase) { 'WILL BE DROPPED' } else { 'kept (pass -RemoveDatabase to drop it)' })"
    Say "    Logs/backups: $env:ProgramData\IDevelop - $(if ($RemoveData) { 'WILL BE DELETED' } else { 'kept (pass -RemoveData to delete them)' })"
    Say ''
    $answer = Read-Host '  Type YES to proceed'
    if ($answer -ne 'YES') { Say '  Cancelled - nothing was changed.' 'Yellow'; exit 1602 }
}

trap {
    Say "  Uninstall failed: $($_.Exception.Message)" 'Red'
    exit 1603
}

# 1. service host - remove BOTH possible hosts (real Windows service via WinSW,
#    and/or the legacy SYSTEM Scheduled Task).
$svcExe = Join-Path (Join-Path $cfg.InstallDir 'service') "$($cfg.ServiceName).exe"
if (Get-Service -Name $cfg.ServiceName -ErrorAction SilentlyContinue) {
    try { Stop-Service -Name $cfg.ServiceName -Force -ErrorAction SilentlyContinue } catch {}
    if (Test-Path -LiteralPath $svcExe) { & $svcExe uninstall 2>&1 | Out-Null }
    else { & sc.exe delete $cfg.ServiceName 2>&1 | Out-Null }
    Start-Sleep -Seconds 2
    Say "Removed Windows service '$($cfg.ServiceName)'." 'Green'
}
if (Get-ScheduledTask -TaskName $cfg.ServiceName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $cfg.ServiceName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $cfg.ServiceName -Confirm:$false
    Say "Removed Scheduled Task '$($cfg.ServiceName)'." 'Green'
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$($cfg.InstallDir)*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# 2. firewall
Get-NetFirewallRule -DisplayName "IDevelop ($($cfg.AppPort))" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue

# 2b. Windows integration: Apps & features entry + Start Menu folder.
#     Removed BEFORE the files, so a failure mid-way never leaves an entry whose
#     UninstallString points at a script that no longer exists (an orphan that
#     the user cannot clear from Settings).
$arpName = if ($cfg.ArpKeyName) { $cfg.ArpKeyName } else { $cfg.AppName }
$arpKey  = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$arpName"
if (Test-Path $arpKey) {
    Remove-Item -Path $arpKey -Recurse -Force -ErrorAction SilentlyContinue
    Say 'Removed the Apps & features entry.' 'Green'
}
$smName = if ($cfg.StartMenuFolder) { $cfg.StartMenuFolder } else { $cfg.AppName }
$smDir  = Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs\$smName"
if (Test-Path -LiteralPath $smDir) {
    Remove-Item -LiteralPath $smDir -Recurse -Force -ErrorAction SilentlyContinue
    Say 'Removed the Start Menu shortcuts.' 'Green'
}

# 3. files
if (-not $KeepFiles -and (Test-Path $cfg.InstallDir)) {
    # The uninstaller runs FROM <InstallDir>\maintenance, so deleting the tree
    # while it executes would pull the script out from under itself. Copy the
    # whole maintenance folder to a temp dir and re-exec there for the delete.
    # (The copy is a wildcard on purpose: the folder gained Maintain- and
    # Installer-Gui in 3.23.1 and a fixed list would have gone stale.)
    $selfDir = $ScriptRoot
    if ($selfDir.StartsWith($cfg.InstallDir, [StringComparison]::OrdinalIgnoreCase) -and -not $env:IDEVELOP_UNINSTALL_RELOCATED) {
        $tmp = Join-Path $env:TEMP ("IDevelop-uninstall-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        Copy-Item -Path (Join-Path $selfDir '*') -Destination $tmp -Force -Recurse
        $env:IDEVELOP_UNINSTALL_RELOCATED = '1'
        $fwd = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $tmp 'Uninstall-IDevelop.ps1')`"", '-Silent')
        if ($RemoveDatabase) { $fwd += '-RemoveDatabase'; if ($PgSuperPassword) { $env:SETUP_PG_SUPER_PASSWORD = $PgSuperPassword } }
        if ($RemoveData)     { $fwd += '-RemoveData' }
        $p = Start-Process powershell.exe -ArgumentList $fwd -Wait -PassThru -WindowStyle Hidden
        if (-not $Silent) { Say 'Uninstall complete.' 'Cyan'; Read-Host '  Press Enter to close' | Out-Null }
        exit $p.ExitCode
    }
    Remove-Item -Recurse -Force $cfg.InstallDir -ErrorAction SilentlyContinue
    if (Test-Path $cfg.InstallDir) {
        # Something still holds a handle (an open console in the folder, an AV
        # scan). Say so plainly instead of reporting a clean removal.
        Say "Install dir could not be fully removed (a file is in use): $($cfg.InstallDir)" 'Yellow'
    } else {
        Say "Removed install dir $($cfg.InstallDir)." 'Green'
    }
}

# 3b. ProgramData (install logs, app backups) - kept unless asked.
$pdDir = Join-Path $env:ProgramData 'IDevelop'
if ($RemoveData -and (Test-Path -LiteralPath $pdDir)) {
    Remove-Item -LiteralPath $pdDir -Recurse -Force -ErrorAction SilentlyContinue
    Say "Removed $pdDir (logs, backups, install history)." 'Green'
} elseif (Test-Path -LiteralPath $pdDir) {
    Say "Kept $pdDir (install logs and backups). Pass -RemoveData to delete it." 'Gray'
}

# 4. database (optional, destructive)
$dbAsked = [bool]$RemoveDatabase
$dbDone = $false
if ($RemoveDatabase) {
    $psql = $null
    if (-not $cfg.PgSuperPassword) { Say 'Provide -PgSuperPassword to drop the database.' 'Yellow' }
    else {
        $cmd = Get-Command psql.exe -ErrorAction SilentlyContinue
        $psql = if ($cmd) { $cmd.Source } else {
            (Get-ChildItem "$env:ProgramFiles\PostgreSQL" -Recurse -Filter psql.exe -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
        }
        if (-not $psql) { Say 'psql not found; cannot drop database.' 'Yellow' }
    }
    if ($psql) {
        $env:PGPASSWORD = $cfg.PgSuperPassword
        # "Dropped" is said only when psql said so: ON_ERROR_STOP=1 and the exit
        # code of EACH call (measured: a closed port returns 2, and the old code
        # printed "Dropped database ..." and exited 0 all the same).
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try {
            $out1 = & $psql -h $cfg.PgHost -p $cfg.PgPort -U postgres -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ""$($cfg.DbName)"" WITH (FORCE)" 2>&1
            $rc1 = $LASTEXITCODE
            $out2 = & $psql -h $cfg.PgHost -p $cfg.PgPort -U postgres -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ""$($cfg.DbUser)""" 2>&1
            $rc2 = $LASTEXITCODE
        } finally { $ErrorActionPreference = $prevEAP; Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
        $dbDone = ($rc1 -eq 0 -and $rc2 -eq 0)
        if ($dbDone) { Say "Dropped database '$($cfg.DbName)' and role '$($cfg.DbUser)'." 'Green' }
        else {
            $detail = (("$out1 $out2") -replace [regex]::Escape($cfg.PgSuperPassword), '***').Trim()
            Say "Database NOT removed: DROP DATABASE exit $rc1, DROP ROLE exit $rc2. $detail" 'Red'
        }
    }
}

Say 'Uninstall complete. (Node.js and PostgreSQL were left installed.)' 'Cyan'
if (-not $Silent) { Read-Host '  Press Enter to close' | Out-Null }
# A requested database drop that did not happen is a PARTIAL removal - report it
# as a failure rather than letting a management tool record a clean uninstall.
if ($dbAsked -and -not $dbDone) { exit 1603 }
exit 0
