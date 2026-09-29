<#
.SYNOPSIS  Repare une installation dont les dependances sont incompletes, puis relance le service.
.DESCRIPTION
    A utiliser quand le service tourne en boucle sur ? Cannot find module ... ?
    alors que le dossier node_modules existe : c'est la signature d'une pose de
    dependances INTERROMPUE. npm met chaque paquet en attente sous un nom
    temporaire ? .paquet-<hash> ? puis le renomme ; tue le processus au milieu
    et il reste des dossiers vides a la place des paquets.

    Ce script ne touche NI au code applicatif, NI a la base, NI a aucun reglage.
    Il repose les dependances de production exactement comme l'installateur le
    fait (memes options), puis redemarre le service et verifie qu'il repond.

    UNE seule elevation, au debut - ou AUCUNE depuis un terminal deja
    administrateur.

.PARAMETER Clean  Supprime node_modules avant de reposer (repose tout a neuf, plus long).
.EXAMPLE  powershell -ExecutionPolicy Bypass -File .\Repair-Install.ps1
#>
[CmdletBinding()]
param([switch]$Clean)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Step($m) { Write-Host ''; Write-Host "  == $m" -ForegroundColor Cyan }

# --- UNE seule elevation ----------------------------------------------------
$prp = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $prp.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Say ''
    Say '  Reparation de l installation : droits administrateur necessaires.' 'Yellow'
    Say '  UNE fenetre de confirmation, la seule de toute la sequence.' 'Yellow'
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$($MyInvocation.MyCommand.Path)`"")
    if ($Clean) { $a += '-Clean' }
    $p = Start-Process powershell.exe -Verb RunAs -ArgumentList $a -Wait -PassThru
    exit $p.ExitCode
}

$cfg = Import-PowerShellDataFile (Join-Path $here 'config.psd1')
$dir = $cfg.InstallDir
$svc = $cfg.ServiceName

Step "1/5  Diagnostic de $dir"
if (-not (Test-Path (Join-Path $dir 'package.json'))) { throw "Aucune installation trouvee dans $dir." }
$pk = Get-Content (Join-Path $dir 'package.json') -Raw | ConvertFrom-Json
$deps = @($pk.dependencies.PSObject.Properties.Name)
$missing = @($deps | Where-Object { -not (Test-Path (Join-Path $dir ("node_modules\$_\package.json"))) })
Say "  dependances declarees : $($deps.Count)"
Say "  dependances absentes  : $($missing.Count)" $(if ($missing.Count) { 'Red' } else { 'Green' })
if ($missing.Count) { Say ("  " + (($missing | Select-Object -First 10) -join ', ')) }
if (-not $missing.Count -and -not $Clean) {
    Say '  Les dependances sont completes : la panne vient d ailleurs.' 'Yellow'
    Say '  Consultez C:\ProgramData\IDevelop et le journal du service avant d insister.' 'Yellow'
}

Step '2/5  Arret du service (pour liberer les fichiers verrouilles)'
$s = Get-Service $svc -ErrorAction SilentlyContinue
if ($s) {
    if ($s.Status -ne 'Stopped') { Stop-Service $svc -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }
    Say "  service : $((Get-Service $svc).Status)"
} else { Say '  service absent' 'Yellow' }
# Un node survivant garderait des fichiers ouverts et ferait echouer la pose.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$dir*" } |
    ForEach-Object { Say "  arret du processus node $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Step '3/5  Pose des dependances de production'
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { $npm = Join-Path $env:ProgramFiles 'nodejs\npm.cmd' }
if (-not (Test-Path $npm)) { throw 'npm introuvable.' }
if ($Clean -and (Test-Path (Join-Path $dir 'node_modules'))) {
    Say '  suppression de node_modules (option -Clean)...'
    Remove-Item (Join-Path $dir 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue
}
# Memes options que l'installateur, pour que le resultat soit identique.
$opts = @('--omit=dev', '--no-audit', '--no-fund', '--loglevel=error', '--ignore-scripts')
Push-Location $dir
try {
    Say "  npm install $($opts -join ' ')"
    & $npm @(@('install') + $opts)
    if ($LASTEXITCODE -ne 0) {
        Say "  echec (code $LASTEXITCODE) - nouvelle tentative apres suppression de node_modules..." 'Yellow'
        Remove-Item (Join-Path $dir 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue
        & $npm @(@('install') + $opts)
        if ($LASTEXITCODE -ne 0) { throw "npm install a echoue (code $LASTEXITCODE)." }
    }
} finally { Pop-Location }

$still = @($deps | Where-Object { -not (Test-Path (Join-Path $dir ("node_modules\$_\package.json")))})
Say "  dependances absentes apres pose : $($still.Count)" $(if ($still.Count) { 'Red' } else { 'Green' })
if ($still.Count) { throw ("Toujours absentes : " + ($still -join ', ')) }

Step '4/5  Redemarrage du service'
if (Get-Service $svc -ErrorAction SilentlyContinue) {
    Start-Service $svc
    Start-Sleep -Seconds 5
    Say "  service : $((Get-Service $svc).Status)"
}

Step '5/5  L application repond-elle'
$url = "http://localhost:$($cfg.AppPort)/api/v1/"
$ok = $false
for ($i = 0; $i -lt 12 -and -not $ok; $i++) {
    try {
        $r = (Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 10).Content | ConvertFrom-Json
        Say "  $url -> $($r.version) ($($r.status))" 'Green'
        $ok = $true
    } catch { Start-Sleep -Seconds 5 }
}
if (-not $ok) {
    Say "  $url ne repond toujours pas." 'Red'
    Say "  Journal : $dir\service\$svc.err.log (20 dernieres lignes)" 'Yellow'
    Get-Content "$dir\service\$svc.err.log" -Tail 20 -ErrorAction SilentlyContinue
}

Say ''
Say $(if ($ok) { '  Reparation terminee : l application est de nouveau en service.' } else { '  Reparation incomplete - voir le journal ci-dessus.' }) $(if ($ok) { 'Cyan' } else { 'Red' })
Say ''
if ($Host.Name -eq 'ConsoleHost') { Read-Host '  Entree pour fermer' | Out-Null }
exit $(if ($ok) { 0 } else { 1 })
