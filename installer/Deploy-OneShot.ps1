<#
.SYNOPSIS  Tout le travail qui exige des droits administrateur, en UNE seule elevation.
.DESCRIPTION
    Ce script existe pour une raison simple : chaque appel isole a
    `Start-Process -Verb RunAs` declenche sa propre fenetre de controle de compte
    Windows. Quatorze deploiements successifs, c'est quatorze clics. Ici tout le
    travail eleve est regroupe, donc UNE seule fenetre au demarrage - ou AUCUNE
    si le script est lance depuis un terminal deja administrateur.

    Ce qui n'a PAS besoin de droits (bump de version, construction du paquet et
    de l'executable, tests) est fait AVANT, hors de ce script. Ici on ne fait que
    ce qui touche C:\Program Files, le service Windows et le pare-feu.

    Le script ne desactive rien, ne modifie aucun reglage de securite, et
    n'installe aucune tache planifiee. Il fait le travail, le verifie, et rend
    la main.

.PARAMETER Package   Dossier du paquet deja construit (defaut : le plus recent sous ..\dist).
.PARAMETER SkipDeploy  N'installe pas ; se contente de verifier l'instance en service.
.EXAMPLE  powershell -ExecutionPolicy Bypass -File .\Deploy-OneShot.ps1
#>
[CmdletBinding()]
param(
    [string]$Package,
    [switch]$SkipDeploy
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Step($m) { Write-Host ''; Write-Host "  == $m" -ForegroundColor Cyan }

# --- UNE seule elevation, ici et nulle part ailleurs ------------------------
$prp = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $prp.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Say ''
    Say '  Ce script a besoin des droits administrateur (service Windows, C:\Program Files).' 'Yellow'
    Say '  UNE fenetre de confirmation va s ouvrir. C est la seule de toute la sequence.' 'Yellow'
    Say ''
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$($MyInvocation.MyCommand.Path)`"")
    if ($Package)   { $a += @('-Package', "`"$Package`"") }
    if ($SkipDeploy) { $a += '-SkipDeploy' }
    $p = Start-Process powershell.exe -Verb RunAs -ArgumentList $a -Wait -PassThru
    exit $p.ExitCode
}

Say ''
Say '  Session administrateur active - aucune autre fenetre ne sera demandee.' 'Green'

# --- 1. Le paquet -----------------------------------------------------------
if (-not $SkipDeploy) {
    Step '1/5  Paquet a installer'
    if (-not $Package) {
        $cand = Get-ChildItem (Join-Path $root 'dist') -Directory -Filter 'IDevelop-Installer-*' -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $cand) { throw "Aucun paquet construit sous $root\dist. Construisez-le d abord (Build-Package.ps1)." }
        $Package = $cand.FullName
    }
    if (-not (Test-Path (Join-Path $Package 'Install-IDevelop.ps1'))) {
        throw "Ce dossier ne contient pas Install-IDevelop.ps1 : $Package"
    }
    Say "  $Package"

    # --- 2. Installation ----------------------------------------------------
    Step '2/5  Installation (-Migrate, fenetre de progression moderne)'
    $cfg = Import-PowerShellDataFile (Join-Path $Package 'config.psd1')
    # LE FORMAT MODERNE EST CONSERVE. On garde la fenetre de progression
    # (Installer-Gui.ps1) : c'est le visage du produit, et un deploiement qui
    # retombe sur une console est une regression d'experience.
    # `-GuiAutoClose 8` est le compromis : la fenetre s'affiche, montre les
    # etapes et l'ecran de fin, puis se ferme SEULE au bout de 8 secondes - donc
    # elle n'attend jamais un clic et ne bloque pas une sequence automatisee.
    # `-NoGui` n'est utilise QUE si aucun bureau n'est disponible.
    $args = @('-Migrate', '-UseExistingPostgres', '-GuiAutoClose', '8')
    if (-not [Environment]::UserInteractive) { $args = @('-Migrate', '-UseExistingPostgres', '-NoGui') }
    # Par l'environnement, jamais en argument : l'argument est recopie tel quel
    # dans l'en-tete de la transcription d'installation (lisible par tout
    # utilisateur local). L'installateur lit SETUP_PG_SUPER_PASSWORD lui-meme.
    if ($cfg.StandardPgSuperPassword) { $env:SETUP_PG_SUPER_PASSWORD = $cfg.StandardPgSuperPassword }
    Push-Location $Package
    try {
        # Deja eleve : appel DIRECT, pas de Start-Process -Verb RunAs, donc pas
        # de seconde fenetre. C est tout l interet de ce script.
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\Install-IDevelop.ps1' @args
    } finally { Pop-Location }
}

# --- 3. Le verdict vient du JOURNAL, jamais du code de sortie ---------------
Step '3/5  Verdict de l installation'
$sum = Get-ChildItem 'C:\ProgramData\IDevelop\install-*.summary.txt' -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($sum) {
    $res = (Select-String -Path $sum.FullName -Pattern '^Result\s*:' | Select-Object -First 1).Line
    $ver = (Select-String -Path $sum.FullName -Pattern '^Version\s*:' | Select-Object -First 1).Line
    Say "  $($sum.Name)"
    Say "  $res" $(if ($res -match 'SUCCESS') { 'Green' } else { 'Red' })
    Say "  $ver"
} else { Say '  Aucun rapport d installation trouve.' 'Yellow' }

# --- 4. L instance repond-elle ---------------------------------------------
Step '4/5  Instance en service'
$svc = Get-Service IDevelop -ErrorAction SilentlyContinue
Say "  service : $(if ($svc) { $svc.Status } else { 'absent' })"
try {
    $api = (Invoke-WebRequest 'http://localhost:3000/api/v1/' -UseBasicParsing -TimeoutSec 20).Content | ConvertFrom-Json
    Say "  /api/v1 : $($api.version) ($($api.status))" 'Green'
} catch { Say "  /api/v1 : injoignable - $($_.Exception.Message)" 'Red' }

# --- 5. Verification fonctionnelle ------------------------------------------
Step '5/5  Verification fonctionnelle'
$verify = Join-Path $root 'scripts\_verify-live.js'
if (Test-Path $verify) {
    Push-Location $root
    try {
        if (-not $env:VERIFY_ADMIN_PASSWORD) { Say '  VERIFY_ADMIN_PASSWORD not set - functional check skipped.' 'Yellow'; return }
        & node $verify 2>&1 | Select-Object -Last 4
    } finally { Pop-Location; Remove-Item Env:\VERIFY_ADMIN_PASSWORD -ErrorAction SilentlyContinue }
} else { Say '  scripts\_verify-live.js absent.' 'Yellow' }

Say ''
Say '  Termine. Aucune autre confirmation ne sera demandee pour cette sequence.' 'Cyan'
Say ''
if ($Host.Name -eq 'ConsoleHost' -and -not $env:IDEVELOP_ONESHOT_QUIET) {
    Read-Host '  Entree pour fermer' | Out-Null
}
