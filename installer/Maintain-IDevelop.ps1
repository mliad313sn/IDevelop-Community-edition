<#
.SYNOPSIS  The modern maintenance window for an INSTALLED copy - what Windows opens from "Modify".
.DESCRIPTION
    Apps & features has a Modify button. It used to run Manage-IDevelop.ps1
    with no arguments, which printed a one-line console usage message and quit:
    a console interface, reached from Windows' own user interface, that did
    nothing. This script replaces it with the same chooser the setup package
    shows, in servicing mode.

    It lives in <InstallDir>\maintenance next to the copies of
    Manage-IDevelop.ps1, Uninstall-IDevelop.ps1, Installer-Gui.ps1 and
    config.psd1 that the installer leaves behind, so it keeps working after the
    setup package has been deleted - which is the whole point of a servicing
    copy.

    There is no application payload here, so update / repair / reinstall are
    not offered; the window says where they live instead of failing.

      backup / restore / listpoints / checkdb / adminpw / pgpw
                                              -> Manage-IDevelop.ps1
      uninstall                               -> Uninstall-IDevelop.ps1

    Exit codes follow the Windows convention: 0 success, 1602 cancelled by the
    user, 1603 fatal error.
.PARAMETER Action  Skip the chooser and run this action directly (same ids as above).
#>
[CmdletBinding()]
param([string]$Action = '')

$ErrorActionPreference = 'Stop'
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- elevate ---------------------------------------------------------------
# Every action here touches the service, C:\Program Files or the database.
$prp = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $prp.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$($MyInvocation.MyCommand.Path)`"")
    if ($Action) { $a += @('-Action', $Action) }
    # Wait and hand back the ELEVATED run's exit code. Returning 0 here would
    # report success for work that had not started, let alone succeeded - and a
    # caller (Windows, a script, a management tool) has no other way to know.
    try {
        $p = Start-Process powershell.exe -Verb RunAs -ArgumentList $a -Wait -PassThru
        exit $p.ExitCode
    } catch {
        # The user declined the elevation prompt. That is a cancellation, not a
        # failure, and Windows has a code for it.
        Write-Host '  Administrator rights are required. Cancelled.' -ForegroundColor Yellow
        exit 1602
    }
}

$MANAGE    = Join-Path $ScriptRoot 'Manage-IDevelop.ps1'
$UNINSTALL = Join-Path $ScriptRoot 'Uninstall-IDevelop.ps1'
$GUI       = Join-Path $ScriptRoot 'Installer-Gui.ps1'
$CFG       = Join-Path $ScriptRoot 'config.psd1'
foreach ($needed in @($MANAGE, $CFG)) {
    if (-not (Test-Path $needed)) {
        Write-Host ("ERROR: {0} is missing from the maintenance folder." -f (Split-Path -Leaf $needed)) -ForegroundColor Red
        Write-Host '       Re-run the setup package to restore the servicing tools.' -ForegroundColor Yellow
        exit 1603
    }
}

$cfg = Import-PowerShellDataFile -Path $CFG
$installDir = if ($cfg.ContainsKey('InstallDir')) { [string]$cfg.InstallDir } else { Split-Path -Parent $ScriptRoot }
$appName    = if ($cfg.ContainsKey('AppName'))    { [string]$cfg.AppName }    else { 'IDevelop' }
$publisher  = if ($cfg.ContainsKey('Publisher'))  { [string]$cfg.Publisher }  else { '' }
$pgPass     = if ($cfg.ContainsKey('StandardPgSuperPassword')) { [string]$cfg.StandardPgSuperPassword } else { '' }

function Get-Version([string]$pkgJson) {
    try { if (Test-Path $pkgJson) { return (Get-Content $pkgJson -Raw | ConvertFrom-Json).version } } catch {}
    return ''
}
$curVersion = Get-Version (Join-Path $installDir 'package.json')
$icon = Join-Path $installDir 'public\icons\idevelop.ico'
if (-not (Test-Path $icon)) { $icon = '' }

# --- choose ----------------------------------------------------------------
if (-not $Action) {
    if (-not (Test-Path $GUI)) {
        Write-Host 'ERROR: Installer-Gui.ps1 is missing from the maintenance folder.' -ForegroundColor Red
        Write-Host '       Re-run the setup package to restore the servicing tools.' -ForegroundColor Yellow
        exit 1603
    }
    . $GUI
    try {
        $Action = Show-SetupChooser -AppName $appName -InstalledVersion $curVersion -InstallDir $installDir `
                    -IconPath $icon -Publisher $publisher -Mode 'servicing'
    } catch {
        # No desktop, or WPF refused to load. There is no console menu in a
        # servicing copy, so say what to run rather than pretend.
        Write-Host ("Maintenance window unavailable ({0})." -f $_.Exception.Message) -ForegroundColor Yellow
        Write-Host ''
        Write-Host '  Run one of these instead, from this folder:' -ForegroundColor Yellow
        Write-Host '    powershell -ExecutionPolicy Bypass -File .\Manage-IDevelop.ps1 -Backup'
        Write-Host '    powershell -ExecutionPolicy Bypass -File .\Manage-IDevelop.ps1 -List'
        Write-Host '    powershell -ExecutionPolicy Bypass -File .\Manage-IDevelop.ps1 -Restore'
        Write-Host '    powershell -ExecutionPolicy Bypass -File .\Manage-IDevelop.ps1 -CheckDb'
        Write-Host '    powershell -ExecutionPolicy Bypass -File .\Uninstall-IDevelop.ps1'
        exit 1603
    }
}
if (-not $Action) {
    Write-Host '  Cancelled. Nothing on this computer was changed.' -ForegroundColor Yellow
    exit 1602
}

# --- dispatch --------------------------------------------------------------
function Invoke-Ps([string]$file, [string[]]$argv) {
    if (-not (Test-Path $file)) {
        Write-Host ("ERROR: {0} is missing from the maintenance folder." -f (Split-Path -Leaf $file)) -ForegroundColor Red
        return 1603
    }
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $file) + $argv
    $p = Start-Process powershell.exe -ArgumentList $a -Wait -PassThru -NoNewWindow
    return $p.ExitCode
}
# Environment, not command line (see Setup-Wizard.ps1): the value would land in
# the transcript header of the child run otherwise.
$pg = @(); if ($pgPass) { $env:SETUP_PG_SUPER_PASSWORD = $pgPass }

switch ($Action) {
    'backup'     { exit (Invoke-Ps $MANAGE @('-Backup', '-Note', 'maintenance backup')) }
    'restore'    { exit (Invoke-Ps $MANAGE (@('-Restore') + $pg)) }
    'listpoints' { $rc = Invoke-Ps $MANAGE @('-List'); Read-Host '  Press Enter to close' | Out-Null; exit $rc }
    'checkdb'    { $rc = Invoke-Ps $MANAGE (@('-CheckDb') + $pg); Read-Host '  Press Enter to close' | Out-Null; exit $rc }
    'adminpw'    { $rc = Invoke-Ps $MANAGE @('-SetAdminPassword'); Read-Host '  Press Enter to close' | Out-Null; exit $rc }
    'pgpw'       { exit (Invoke-Ps $MANAGE @('-SetPgPassword')) }
    'uninstall'  { exit (Invoke-Ps $UNINSTALL @()) }
    # Deliberately refused, not silently ignored: these need the application
    # payload, which a servicing copy does not have.
    { $_ -in @('update', 'filesonly', 'repair', 'reinstall', 'install') } {
        Write-Host ("'{0}' needs the setup package for the version you want." -f $Action) -ForegroundColor Yellow
        Write-Host '  Run IDevelop-Setup-<version>.exe and choose it there.' -ForegroundColor Yellow
        exit 1603
    }
    default {
        Write-Host ("ERROR: unknown action '{0}'." -f $Action) -ForegroundColor Red
        exit 1603
    }
}
