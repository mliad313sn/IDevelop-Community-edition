<#
.SYNOPSIS  Build a single self-extracting IDevelop-Setup-<version>.exe from a built package .zip.
.DESCRIPTION
    Compiles installer\exe-stub.cs with the package .zip embedded as a resource,
    using the built-in .NET Framework C# compiler (csc.exe) - no third-party tools.
    Running the resulting .exe extracts the whole package next to itself and
    launches Setup-Wizard.bat - the MODERN interface, which self-elevates. It
    falls back to Setup.bat only if the wizard is missing; Setup.bat then hands
    the job straight back to the wizard on any machine that has a desktop, so a
    user never meets the console interface.

    Run Build-Package.ps1 first (it produces the .zip under ..\dist).
.PARAMETER Zip   Path to the package .zip (default: newest IDevelop-Installer-*.zip in ..\dist).
.PARAMETER Out   Output .exe path (default: ..\dist\IDevelop-Setup-<version>.exe).
.EXAMPLE  powershell -ExecutionPolicy Bypass -File .\Build-Exe.ps1
#>
[CmdletBinding()]
param([string]$Zip, [string]$Out)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$appRoot = Split-Path -Parent $here
$distDir = Join-Path $appRoot 'dist'
$version = (Get-Content (Join-Path $appRoot 'package.json') -Raw | ConvertFrom-Json).version

if (-not $Zip) {
    $Zip = (Get-ChildItem $distDir -Filter 'IDevelop-Installer-*.zip' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}
if (-not $Zip -or -not (Test-Path $Zip)) { throw "Package .zip not found - run Build-Package.ps1 first (looked in $distDir)." }
if (-not $Out) { $Out = Join-Path $distDir "IDevelop-Setup-$version.exe" }

$fw = Get-ChildItem 'C:\Windows\Microsoft.NET\Framework64' -Directory -Filter 'v4.*' -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
if (-not $fw) { $fw = Get-ChildItem 'C:\Windows\Microsoft.NET\Framework' -Directory -Filter 'v4.*' | Sort-Object Name -Descending | Select-Object -First 1 }
$csc = Join-Path $fw.FullName 'csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe not found (.NET Framework 4.x required)." }

$stub = Join-Path $here 'exe-stub.cs'
if (-not (Test-Path $stub)) { throw "exe-stub.cs not found next to this script." }

# Embed a UAC manifest (requireAdministrator) so the exe elevates itself HONESTLY
# via Windows, instead of relaunching through PowerShell at runtime — that
# self-elevation chain is a primary "defense evasion" behavior signal that got a
# previous build quarantined (Behavior:Win32/DefenseEvasion.A!ml, VT 0/0).
$manifest = Join-Path $here 'app.manifest'
if (-not (Test-Path $manifest)) { throw "app.manifest not found next to this script." }

if ([System.IO.File]::Exists($Out)) { [System.IO.File]::Delete($Out) }

# Stamp the REAL product version into the PE version resource. It used to be
# hard-coded in exe-stub.cs and had drifted to 3.22.25 - so every setup binary
# since then reported a version that was years of releases out of date in its
# file properties, in software inventories and to reputation heuristics. The
# source stays the single declaration; only the number is substituted, into a
# temporary copy, so exe-stub.cs is never rewritten by a build.
$verParts = @($version -split '[^\d]' | Where-Object { $_ -ne '' })
while ($verParts.Count -lt 4) { $verParts += '0' }
$peVersion = ($verParts[0..3] -join '.')
$stubSrc = Get-Content -LiteralPath $stub -Raw
$stubSrc = [System.Text.RegularExpressions.Regex]::Replace(
    $stubSrc, '(?<=Assembly(?:File)?Version\(")[^"]+(?="\)])', $peVersion)
$stubTmp = Join-Path ([System.IO.Path]::GetTempPath()) ("exe-stub-$peVersion.cs")
Set-Content -LiteralPath $stubTmp -Value $stubSrc -Encoding UTF8
$stub = $stubTmp

Write-Host "Compiling $Out" -ForegroundColor Cyan
Write-Host "  version  : $peVersion (stamped into the file properties)"
Write-Host ("  embedding: $(Split-Path -Leaf $Zip) (" + [math]::Round((Get-Item $Zip).Length / 1MB, 1) + " MB)")
Write-Host "  manifest : requireAdministrator (no runtime PowerShell self-elevation)"
$cscArgs = @(
    '/nologo', '/target:exe', '/platform:anycpu', "/out:$Out",
    "/win32manifest:$manifest",
    "/resource:$Zip,package.zip",
    "/reference:$($fw.FullName)\System.IO.Compression.FileSystem.dll",
    "/reference:$($fw.FullName)\System.IO.Compression.dll",
    $stub
)
& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "csc failed (exit $LASTEXITCODE)." }
if (-not (Test-Path $Out)) { throw 'csc reported success but no exe was produced.' }
Write-Host ("[OK] Self-extracting installer: $Out (" + [math]::Round((Get-Item $Out).Length / 1MB, 1) + " MB)") -ForegroundColor Green
Write-Host '  Double-click the .exe on the target machine -> it extracts and opens the setup wizard.'
