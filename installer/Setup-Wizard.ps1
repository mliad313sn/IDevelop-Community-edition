<#
.SYNOPSIS  The modern IDevelop setup wizard: decides what this machine needs, asks, then runs it.
.DESCRIPTION
    This is what the Setup .exe launches.

      * Nothing installed  -> straight into Install-IDevelop.ps1 -Wizard
                              (Welcome -> Licence -> Progress -> Finish).
      * Already installed  -> the maintenance chooser, which offers EVERY
                              operation this package supports, then dispatches:

        update / filesonly / repair / reinstall -> Install-IDevelop.ps1
        backup / restore / listpoints / checkdb
        / adminpw / pgpw                        -> Manage-IDevelop.ps1
        uninstall                               -> Uninstall-IDevelop.ps1

    EVERYTHING goes through this window. The console menu (Setup.bat) is NOT an
    offered choice any more; it is a rescue path, reached only when the window
    cannot open at all (no desktop, RDP without WPF, Server Core) or when
    -Action menu is typed on the command line. It still ships because removing
    it would make those machines impossible to install.

    Exit codes follow the Windows convention: 0 success, 1602 cancelled by the
    user, 1603 fatal error.
.PARAMETER Action  Skip the chooser and run this action directly (same ids as above).
#>
[CmdletBinding()]
param([string]$Action = '')

$ErrorActionPreference = 'Stop'
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- elevate ---------------------------------------------------------------
$prp = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $prp.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$($MyInvocation.MyCommand.Path)`"")
    if ($Action) { $a += @('-Action', $Action) }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $a
    exit 0
}

. (Join-Path $ScriptRoot 'Installer-Gui.ps1')
$cfg = Import-PowerShellDataFile -Path (Join-Path $ScriptRoot 'config.psd1')

$INSTALL   = Join-Path $ScriptRoot 'Install-IDevelop.ps1'
$MANAGE    = Join-Path $ScriptRoot 'Manage-IDevelop.ps1'
$UNINSTALL = Join-Path $ScriptRoot 'Uninstall-IDevelop.ps1'
$MENU      = Join-Path $ScriptRoot 'Setup.bat'
if (-not (Test-Path $INSTALL)) { Write-Host 'ERROR: Install-IDevelop.ps1 not found next to this script.' -ForegroundColor Red; exit 1603 }

function Get-Version([string]$pkgJson) {
    try { if (Test-Path $pkgJson) { return (Get-Content $pkgJson -Raw | ConvertFrom-Json).version } } catch {}
    return ''
}
$pkgVersion = Get-Version (Join-Path $ScriptRoot 'app\package.json')
$curVersion = Get-Version (Join-Path $cfg.InstallDir 'package.json')
$installed  = Test-Path (Join-Path $cfg.InstallDir 'server.js')
$pgPass     = if ($cfg.ContainsKey('StandardPgSuperPassword')) { [string]$cfg.StandardPgSuperPassword } else { '' }
$icon = ''
foreach ($c in @((Join-Path $ScriptRoot 'app\public\icons\idevelop.ico'),
                 (Join-Path $cfg.InstallDir 'public\icons\idevelop.ico'))) { if (Test-Path $c) { $icon = $c; break } }

# --- choose ----------------------------------------------------------------
if (-not $Action) {
    if (-not $installed) {
        $Action = 'install'
    } else {
        try {
            $Action = Show-SetupChooser -AppName $cfg.AppName -InstalledVersion $curVersion `
                        -PackageVersion $pkgVersion -InstallDir $cfg.InstallDir -IconPath $icon -Publisher $cfg.Publisher
        } catch {
            # LE MENU TEXTE N'EST PLUS UNE VOIE OFFERTE, c'est un SECOURS.
            # Decision du proprietaire : tout passe par l'interface moderne. Le
            # menu console n'apparait plus dans le choix des actions ; il ne
            # subsiste QUE pour le cas ou la fenetre ne peut pas s'ouvrir du
            # tout : machine sans bureau, session RDP sans WPF, Server Core.
            # Le supprimer entierement rendrait ces machines-la non
            # installables, ce qui serait pire que de le garder invisible.
            Write-Host ("Interface d'installation indisponible ({0})." -f $_.Exception.Message) -ForegroundColor Yellow
            Write-Host "Cette machine n'a pas d'interface graphique : bascule sur le mode texte de secours." -ForegroundColor Yellow
            # Marque la provenance : sans elle, Setup.bat nous renverrait la main
            # et les deux tourneraient en rond.
            $env:SETUP_VIA_WIZARD = '1'
            & cmd.exe /c "`"$MENU`""
            exit $LASTEXITCODE
        }
    }
}
if (-not $Action) {
    Write-Host '  Setup was cancelled. Nothing on this computer was changed.' -ForegroundColor Yellow
    exit 1602
}

# --- dispatch --------------------------------------------------------------
function Invoke-Ps([string]$file, [string[]]$argv) {
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $file) + $argv
    $p = Start-Process powershell.exe -ArgumentList $a -Wait -PassThru -NoNewWindow
    return $p.ExitCode
}
# The password travels through the ENVIRONMENT, never the command line: a
# -PgSuperPassword argument is copied into the "Host Application:" header of
# every install transcript (46 of them carried it on the appliance). The child
# scripts read SETUP_PG_SUPER_PASSWORD themselves. $pg stays an empty list so
# every dispatch line below is unchanged in shape.
$pg = @(); if ($pgPass) { $env:SETUP_PG_SUPER_PASSWORD = $pgPass }

switch ($Action) {
    'install'    { exit (Invoke-Ps $INSTALL (@('-Wizard') + $pg)) }
    # The chooser already took the decision, so the installer runs with its
    # progress window only - asking "are you sure" twice is not a wizard.
    'update'     { exit (Invoke-Ps $INSTALL (@('-Migrate', '-UseExistingPostgres') + $pg)) }
    'filesonly'  { exit (Invoke-Ps $INSTALL (@('-Patch', '-SkipMigrations', '-UseExistingPostgres') + $pg)) }
    'repair'     { exit (Invoke-Ps $INSTALL (@('-Patch', '-UseExistingPostgres') + $pg)) }
    'reinstall'  { exit (Invoke-Ps $INSTALL (@('-Reinstall', '-UseExistingPostgres') + $pg)) }
    'backup'     { exit (Invoke-Ps $MANAGE @('-Backup', '-Note', 'wizard backup')) }
    'restore'    { exit (Invoke-Ps $MANAGE (@('-Restore') + $pg)) }
    'listpoints' { $rc = Invoke-Ps $MANAGE @('-List'); Read-Host '  Press Enter to close' | Out-Null; exit $rc }
    'checkdb'    { $rc = Invoke-Ps $MANAGE (@('-CheckDb') + $pg); Read-Host '  Press Enter to close' | Out-Null; exit $rc }
    'adminpw'    { $rc = Invoke-Ps $MANAGE @('-SetAdminPassword'); Read-Host '  Press Enter to close' | Out-Null; exit $rc }
    'pgpw'       { exit (Invoke-Ps $MANAGE @('-SetPgPassword')) }
    'uninstall'  { exit (Invoke-Ps $UNINSTALL @()) }
    # 'menu' n'est plus propose par l'interface (decision du proprietaire : tout
    # passe par l'assistant moderne). Le cas reste traite pour le SEUL chemin qui
    # peut encore le produire : `-Action menu` passe explicitement en ligne de
    # commande sur une machine sans bureau.
    'menu'       { $env:SETUP_VIA_WIZARD = '1'; & cmd.exe /c "`"$MENU`""; exit $LASTEXITCODE }
    default {
        Write-Host ("ERROR: unknown action '{0}'." -f $Action) -ForegroundColor Red
        exit 1603
    }
}
