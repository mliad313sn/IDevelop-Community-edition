<#
.SYNOPSIS  Assemble the distributable IDevelop installer package (run by the developer).
.DESCRIPTION
    Stages the installer scripts + a clean copy of the application (no node_modules,
    .git, logs, tmp, data, etc.), regenerates the PostgreSQL data snapshot from the
    live dev database, and zips everything into ..\dist\.

    The resulting zip is what you ship: unzip on the target machine and run
    Install-IDevelop.ps1 as administrator.

    Pure PowerShell (no robocopy) so it runs under restricted execution sandboxes.
.PARAMETER OutDir   Override the output directory (default ..\dist).
.PARAMETER Stamp    Override the package name stamp (default yyyyMMdd).
.PARAMETER SkipData Skip regenerating the data snapshot (reuse whatever is already staged).
.PARAMETER ScrubPgPassword Blank StandardPgSuperPassword in the shipped config.psd1 (for a
                    package that must not carry this appliance's postgres credential). By
                    default the standard password SHIPS, unchanged since 3.22.85, so a
                    Patch / Migrate on the appliance runs unattended.
.EXAMPLE  powershell -ExecutionPolicy Bypass -File .\Build-Package.ps1 -Stamp phase8-okr-20260617
#>
[CmdletBinding()]
param([string]$OutDir, [string]$Stamp, [switch]$SkipData, [switch]$IncludeData, [switch]$ScrubPgPassword)

# Community Edition default: NEVER bundle a database snapshot unless explicitly
# requested with -IncludeData. A fresh install then creates and seeds an empty
# database, so no organisation's data can travel inside a public package.
if (-not $IncludeData) { $SkipData = $true }

$ErrorActionPreference = 'Stop'
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path   # ...\installer
$appRoot = Split-Path -Parent $here                          # ...\IDevelop-V3 (the app)
$version = (Get-Content (Join-Path $appRoot 'package.json') -Raw | ConvertFrom-Json).version
if (-not $Stamp)  { $Stamp  = Get-Date -Format 'yyyyMMdd' }
if (-not $OutDir) { $OutDir = Join-Path $appRoot 'dist' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# NAME GUARD - artifact names are derived from $version, so the version is
# validated against an allow-list of shapes (plain semver plus an optional
# neutral suffix) before anything is staged: no free-text label can leak into
# the .zip / .exe names or into GET /api/v1/.
if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$') {
    throw ("Refusing to package: package.json version '$version' is not a plain " +
           "semver. Artifact names are derived from it, so any label here is " +
           "stamped into the .zip, the .exe and the installed package.json " +
           "(and served by GET /api/v1/). Use '3.22.85', not '3.22.85-some-label'.")
}
$pkgName = "IDevelop-Installer-$version-$Stamp"
$staging = Join-Path $OutDir $pkgName
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
$appDest  = Join-Path $staging 'app'
$dataDest = Join-Path $staging 'data'
New-Item -ItemType Directory -Force -Path $appDest  | Out-Null
New-Item -ItemType Directory -Force -Path $dataDest | Out-Null

Write-Host "Building $pkgName ..." -ForegroundColor Cyan

# 1. installer scripts + docs -> package root
$installerScripts = @('Setup-Wizard.bat', 'Setup-Wizard.ps1', 'Setup.bat', 'Install-IDevelop.ps1',
    'Installer-Gui.ps1', 'Uninstall-IDevelop.ps1', 'Manage-IDevelop.ps1', 'Maintain-IDevelop.ps1',
    'config.psd1', 'README.md', 'MANUAL-DEPLOY.md')
foreach ($f in $installerScripts) {
    $src = Join-Path $here $f
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $staging $f) -Force }
}
# A script the installer copies into <InstallDir>\maintenance but that never
# reached the package would leave "Modify" in Apps & features pointing at a file
# that does not exist. Fail the build instead of shipping that.
foreach ($f in @('Maintain-IDevelop.ps1', 'Installer-Gui.ps1', 'Manage-IDevelop.ps1', 'Uninstall-IDevelop.ps1', 'config.psd1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $staging $f))) {
        throw "Servicing tool missing from the package: $f (Install-MaintenanceTools copies it into <InstallDir>\maintenance)."
    }
}

# 1a. STANDARD POSTGRES PASSWORD - config.psd1 may carry an appliance-wide
#     'postgres' superuser password (StandardPgSuperPassword) so Patch / Migrate
#     run unattended on YOUR appliance. The repository ships it blank. Pass
#     -ScrubPgPassword when building a package for anyone else so a value you
#     set locally never leaves your machine.
$stagedCfg = Join-Path $staging 'config.psd1'
if (Test-Path -LiteralPath $stagedCfg) {
    $stagedPw = (Import-PowerShellDataFile -Path $stagedCfg).StandardPgSuperPassword
    if ($ScrubPgPassword) {
        $cfgText = Get-Content -LiteralPath $stagedCfg -Raw
        $cfgText = [regex]::Replace($cfgText, "(?m)^(\s*StandardPgSuperPassword\s*=\s*).*$", "`${1}''")
        Set-Content -LiteralPath $stagedCfg -Value $cfgText -Encoding UTF8 -NoNewline
        Write-Host "  Scrubbed StandardPgSuperPassword from the staged config.psd1 (-ScrubPgPassword)" -ForegroundColor Gray
    } elseif ($stagedPw) {
        Write-Host ("  Standard postgres password ships in config.psd1 (" + $stagedPw.Length + " chars) - patch/migrate on the appliance run unattended") -ForegroundColor Gray
    } else {
        Write-Host "  WARNING: config.psd1 has no StandardPgSuperPassword - the installer will need -PgSuperPassword on the appliance" -ForegroundColor Yellow
    }
}
# Deploy runbooks: ship every DEPLOY-RUNBOOK-*.md so the version-specific runbook
# is always included without editing this list each release.
Get-ChildItem -LiteralPath $here -Filter 'DEPLOY-RUNBOOK-*.md' -File -ErrorAction SilentlyContinue |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $staging $_.Name) -Force }

# 1b. Optional: bundle the WinSW service wrapper so the package installs a real
#     Windows service WITHOUT any install-time download (airgap-friendly). Drop
#     WinSW-x64.exe into installer\bin\ to include it; otherwise the installer
#     downloads it from config.WinSwUrl at install time.
$binSrc = Join-Path $here 'bin'
if (Test-Path -LiteralPath $binSrc) {
    $binDest = Join-Path $staging 'bin'
    New-Item -ItemType Directory -Force -Path $binDest | Out-Null
    Get-ChildItem -LiteralPath $binSrc -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $binDest $_.Name) -Force }
    Write-Host "  Bundled service wrapper from installer\bin\ ($((Get-ChildItem $binDest -File).Name -join ', '))" -ForegroundColor Gray
} else {
    Write-Host "  [note] no installer\bin\WinSW-x64.exe bundled - the installer will download WinSW at install time (or fall back to a Scheduled Task offline)." -ForegroundColor DarkGray
}

# 2. application payload -> app\  (exclude heavy / env-specific / the installer itself)
#    Pure-PowerShell top-level copy: every top-level entry except the excluded set.
$excludeDirs = @('node_modules', '.git', '.github', '.husky', '.claude', '.vscode', 'logs', 'tmp', 'data', 'coverage', 'certs', 'installer', 'dist', 'backups', 'docs', 'tests',
    # Dev-only trees and internal documents. A customer's Program Files should
    # contain the product and nothing else: these were shipping into every
    # install with no consumer in the app (nothing references 'mobile', and the
    # rest are working notes, test output and an internal requirements doc).
    'AI_Engine_Docs', 'Apps Environment', 'mobile', 'test-results', 'test-results-uat', 'playwright-report', '.idea')

# Loose dev-tooling files at the project root. Same rule: lint/format/commit
# config, container recipes and developer batch helpers are not part of a
# Windows on-premise deployment, and shipping them invites an operator to run
# one. 'manage.bat' IS the product's own maintenance entry point and stays.
$excludeFiles = @('.editorconfig', '.eslintrc.json', '.prettierrc', '.prettierignore',
    '.gitattributes', '.gitignore', 'commitlint.config.js', 'playwright.config.js',
    'jest.config.js', 'Dockerfile', 'docker-compose.yml',
    'install_and_run.bat', 'restart_server.bat', 'Requirements_Document.html')

# GUARD - stray root-level scripts must never ship.
# The exclude list above covers DIRECTORIES only, so any loose .js dropped in the
# project root is copied into the customer payload. That has happened twice:
#   - scratch_final.js shipped inside 3.22.80
#   - update-readiness.js sat in the root for two months. It fabricates competency
#     data (randomly up/downgrading skills for 12 NAMED real employees to hit
#     preset readiness percentages, writing falsified assessment_history rows
#     attributed to admin 1) and auto-runs on `node update-readiness.js` with no
#     environment guard.
# Shipping either is a data-integrity and privacy incident, so this is a hard
# FAILURE rather than a silent skip: a new root script must be added here
# deliberately, or moved into scripts\ where it belongs.
$allowedRootJs = @('server.js', 'jest.config.js', 'playwright.config.js', 'commitlint.config.js')
$strayRootJs = Get-ChildItem -LiteralPath $appRoot -File -Filter '*.js' |
    Where-Object { $allowedRootJs -notcontains $_.Name }
if ($strayRootJs) {
    $names = ($strayRootJs | ForEach-Object { $_.Name }) -join ', '
    throw ("Refusing to package: unexpected root-level script(s) [$names]. " +
           "Move them to scripts\, delete them, or add them to `$allowedRootJs in Build-Package.ps1 " +
           "if they are genuinely part of the product.")
}

Get-ChildItem -LiteralPath $appRoot -Force |
    Where-Object { $excludeDirs -notcontains $_.Name -and $excludeFiles -notcontains $_.Name -and $_.Name -ne '.env' } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $appDest $_.Name) -Recurse -Force }

# 2a. Windows application icon.
#     The Add/Remove Programs entry, the Start Menu shortcuts and the .url
#     launcher all need a real .ico - Windows will not render a PNG in any of
#     those places. Generated here from the app's own 512px icon so the product
#     keeps ONE visual identity and nobody has to maintain a second asset.
$icoOut = Join-Path $appDest 'public\icons\idevelop.ico'
$pngSrc = Join-Path $appRoot 'public\icons\icon-512.png'
if (Test-Path -LiteralPath $pngSrc) {
    try {
        Add-Type -AssemblyName System.Drawing
        $src = [System.Drawing.Image]::FromFile($pngSrc)
        # A multi-size .ico renders crisply everywhere (16 in the Start Menu list,
        # 32 in Apps & features, 48/256 on the desktop and in large-icon views).
        $sizes = @(16, 32, 48, 64, 128, 256)
        $pngBytes = @()
        foreach ($s in $sizes) {
            $bmp = New-Object System.Drawing.Bitmap($s, $s)
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.DrawImage($src, 0, 0, $s, $s)
            $g.Dispose()
            $ms = New-Object System.IO.MemoryStream
            $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
            $pngBytes += , $ms.ToArray()
            $ms.Dispose(); $bmp.Dispose()
        }
        $src.Dispose()
        # ICO container: 6-byte header + 16 bytes per entry, then the PNG frames
        # (PNG-compressed frames are valid in .ico from Windows Vista onward).
        $fs = [System.IO.File]::Create($icoOut)
        $bw = New-Object System.IO.BinaryWriter($fs)
        $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
        $offset = 6 + (16 * $sizes.Count)
        for ($i = 0; $i -lt $sizes.Count; $i++) {
            $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
            $bw.Write([Byte]$dim); $bw.Write([Byte]$dim)
            $bw.Write([Byte]0); $bw.Write([Byte]0)
            $bw.Write([UInt16]1); $bw.Write([UInt16]32)
            $bw.Write([UInt32]$pngBytes[$i].Length); $bw.Write([UInt32]$offset)
            $offset += $pngBytes[$i].Length
        }
        foreach ($b in $pngBytes) { $bw.Write($b) }
        $bw.Flush(); $bw.Close(); $fs.Close()
        Write-Host "  [OK] Application icon: public\icons\idevelop.ico ($($sizes.Count) sizes)" -ForegroundColor Gray
    } catch {
        Write-Host "  [WARN] Could not generate the .ico ($($_.Exception.Message)) - Apps & features will fall back to the Node icon." -ForegroundColor Yellow
    }
} else {
    Write-Host "  [WARN] public\icons\icon-512.png missing - no application icon generated." -ForegroundColor Yellow
}

# 2b. DEV-ONLY CREDENTIAL SEEDERS must not ship.
#     scripts\ is a FILE-level mix: set-admin-password.js is genuine product (the
#     installer and PostgresDatabase.js both call it), but seven of its
#     neighbours are dev fixtures that create logins with hard-coded passwords -
#     'Welcome123!', 'Admin123!', 'Employee123!', 'Test1234!' and the local admin
#     password - and NOTHING in the installer or the app references any of them.
#     They travelled into 3.22.84 and 3.22.85 purely because the exclude list
#     above covers directories only.
#
#     Shipping them is a real credential risk: several rewrite EVERY employee and
#     admin password in the target database, and their defaults would not even
#     pass the product's own password policy. Removed after the copy so the
#     source tree keeps them for development.
#
#     2026-09-17: the list of seven was not enough. scripts\ also carried
#     one-shot data mutators with no guard and no dry-run (assign-role-families
#     rewrote roles.role_family_id in an unconditional loop), framework loaders,
#     capture/stress/PDF tooling and an SQLite-era restore script, all copied
#     into Program Files because the copy above takes scripts\ whole. So the
#     contract is now an ALLOW-LIST: every script in scripts\ is classified as
#     PRODUCT (ships) or DEV (removed), and a script in neither list FAILS the
#     build. Adding a script means deciding where it belongs, out loud.
#
#     PRODUCT = referenced by the installer, package.json, server.js, the app,
#     or a deploy runbook as something an operator runs on the appliance.
$productScripts = @(
    'migrate.js',              # package.json db:migrate:all (the installer's migrator)
    'migrate-preflight.js',    # db:migrate:preflight / :postflight + HealthController
    'reset-for-golive.js',     # Setup.bat option R / db:reset:golive
    'set-admin-password.js',   # installer (fresh DB admin password) + PostgresDatabase
    'reapply-erasures.js',     # Manage -Restore: re-apply erasure tombstones after a restore
    'rotate-app-key.js',       # server.js points the operator at it (APP_KEY rotation)
    'seed-cert-policies.js',   # apply a default certification policy (dry-run + --commit)
    'seed-starter-framework.js', # optional generic starter capability framework (npm run db:seed:starter)
    'import-esco.js',          # ESCO CSV -> framework JSON for seed-starter-framework --file (npm run import:esco)
    'reset-superadmin-mfa.js', # Manage -ResetSuperadminMfa: OS-admin recovery of a SuperAdmin's MFA
    'Health-Watchdog.ps1',     # service watchdog (Scheduled Task)
    'Verify-BackupRestore.ps1' # quarterly restore drill
)
$devOnlyScripts = @(
    # demo data (dev machine only)
    'seed-demo.js', 'seed-demo-org.js',
    # one-shot data maintenance (dev machine only)
    'backfill-access-profiles.js', 'v3-merge-duplicate-skills.js',
    # QA and documentation tooling
    '_emoji-inventory.js', '_emoji-to-icons.js', '_scan-emoji.js', 'build-user-guide.js',
    'check-icons.js', 'export-contracts.js', 'export-security-measures.js', 'export-skills-framework.js', 'export-v3-matrix.js', 'loadtest-readiness.js', 'security-check.js'
)
$devOnlyDirs = @('_lib')
$stagedScripts = Get-ChildItem -LiteralPath (Join-Path $appDest 'scripts') -File -ErrorAction SilentlyContinue
$unclassified = @($stagedScripts | Where-Object { $productScripts -notcontains $_.Name -and $devOnlyScripts -notcontains $_.Name } | ForEach-Object { $_.Name })
if ($unclassified.Count) {
    throw ("Refusing to package: scripts\ carries " + $unclassified.Count + " unclassified script(s) [" +
           ($unclassified -join ', ') + "]. Add each one to `$productScripts (ships to the customer) " +
           "or `$devOnlyScripts (removed from the package) in Build-Package.ps1.")
}
$removed = @()
foreach ($s in $devOnlyScripts) {
    $p = Join-Path $appDest "scripts\$s"
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force; $removed += $s }
}
foreach ($d in $devOnlyDirs) {
    $p = Join-Path $appDest "scripts\$d"
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force; $removed += "$d\" }
}
$shipped = @(Get-ChildItem -LiteralPath (Join-Path $appDest 'scripts') -File | ForEach-Object { $_.Name })
$notAllowed = @($shipped | Where-Object { $productScripts -notcontains $_ })
if ($notAllowed.Count) { throw ("Refusing to package: scripts\ still ships [" + ($notAllowed -join ', ') + "] after the dev-only purge.") }
Write-Host "  [OK] scripts\: $($shipped.Count) product script(s) ship [$($shipped -join ', ')]; $($removed.Count) dev-only entries removed" -ForegroundColor Gray

# And prove it, rather than trusting the list: any REMAINING shipped script that
# hashes a password must be one we have deliberately accounted for. A new seeder
# added later fails the build instead of quietly shipping.
$allowedCredScripts = @('set-admin-password.js')
$stillHashing = Get-ChildItem -LiteralPath (Join-Path $appDest 'scripts') -File -Filter '*.js' -ErrorAction SilentlyContinue |
    Where-Object {
        $allowedCredScripts -notcontains $_.Name -and
        ([System.IO.File]::ReadAllText($_.FullName) -match 'bcrypt\.hash|password_hash\s*=')
    }
if ($stillHashing) {
    $names = ($stillHashing | ForEach-Object { $_.Name }) -join ', '
    throw ("Refusing to package: shipped script(s) [$names] write password hashes but are not " +
           "accounted for. Add them to `$devOnlyScripts (dev fixture) or `$allowedCredScripts " +
           "(genuine product) in Build-Package.ps1.")
}

# 3. data snapshot -> data\<DbName>.sql  (full pg_dump of the live dev DB so the shipped
#    schema/data is always current; the installer drops+recreates+imports it when the
#    target DB is empty, then runs db:migrate:all on top). The filename is derived from
#    config.psd1 (DataDumpFile / DbName) so the package + installer stay in sync — for
#    example data\idevelop.sql. Only runs with -IncludeData.
$cfgForData = Import-PowerShellDataFile -Path (Join-Path $here 'config.psd1')
$dumpName = if ($cfgForData.DataDumpFile) { Split-Path -Leaf $cfgForData.DataDumpFile } else { "$($cfgForData.DbName).sql" }
$dumpFile = Join-Path $dataDest $dumpName
if ($SkipData) {
    Write-Host "  [skip] data snapshot (-SkipData)" -ForegroundColor Yellow
} else {
    $envFile = Join-Path $appRoot '.env'
    $dbUrl = (Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1) -replace '^DATABASE_URL=', ''
    if (-not $dbUrl) { throw "DATABASE_URL not found in $envFile - cannot regenerate data snapshot (use -SkipData to reuse staged data)." }
    $pgDump = $null
    $cmd = Get-Command pg_dump.exe -ErrorAction SilentlyContinue
    if ($cmd) { $pgDump = $cmd.Source }
    if (-not $pgDump) {
        $cand = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
                Sort-Object Name -Descending |
                ForEach-Object { Join-Path $_.FullName 'bin\pg_dump.exe' } |
                Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if ($cand) { $pgDump = $cand }
    }
    if (-not $pgDump) { throw "pg_dump.exe not found - install PostgreSQL client tools or use -SkipData." }
    Write-Host "  Regenerating data snapshot via $pgDump ..." -ForegroundColor Gray
    # GUARD - test credentials must never ship LIVE. The dev database carries
    # deliberate QA fixtures (test.super is an ACTIVE superadmin with a known
    # password); a fresh customer install imports this snapshot verbatim, which
    # would seed a working superadmin login anyone can read from the repo.
    # Deactivate them for the duration of the dump, then restore, so dev keeps
    # its fixtures and the package ships them switched OFF.
    $psqlExe = Join-Path (Split-Path -Parent $pgDump) 'psql.exe'
    $testGuardOn  = "UPDATE admins SET is_active = false WHERE username LIKE 'test.%'; UPDATE employees SET is_account_active = false WHERE username LIKE 'test.%';"
    $testGuardOff = "UPDATE admins SET is_active = true  WHERE username LIKE 'test.%'; UPDATE employees SET is_account_active = true  WHERE username LIKE 'test.%';"
    & $psqlExe $dbUrl -v ON_ERROR_STOP=1 -q -c $testGuardOn
    if ($LASTEXITCODE -ne 0) { throw "test-account guard failed - refusing to dump with live test credentials" }
    # Capture pg_dump's exit code INSIDE the try: the finally's psql overwrites
    # $LASTEXITCODE, so testing it afterwards would mask a failed dump.
    # RUNTIME-ONLY rows never ship: the dev box's web sessions (live cookies),
    # password-reset tokens and the SAML request / replay caches. The tables
    # themselves ship (schema only). Found 2026-09-25: a session id in the dump
    # tripped the de-branding guard; the real defect was shipping sessions at all.
    $runtimeOnly = @('public.session', 'public.password_reset_tokens',
        'public.saml_request_cache', 'public.saml_assertion_seen')
    $excludeData = $runtimeOnly | ForEach-Object { "--exclude-table-data=$_" }
    $dumpExit = 1
    try {
        & $pgDump --no-owner --no-privileges @excludeData --file $dumpFile $dbUrl
        $dumpExit = $LASTEXITCODE
    } finally {
        & $psqlExe $dbUrl -q -c $testGuardOff | Out-Null
    }
    if ($dumpExit -ne 0) { throw "pg_dump failed (exit $dumpExit)" }
    $tables = (Select-String -LiteralPath $dumpFile -Pattern '^CREATE TABLE' -AllMatches).Count
    Write-Host "  [OK] Snapshot: $([math]::Round((Get-Item $dumpFile).Length/1MB,1)) MB, $tables tables" -ForegroundColor Gray

    # 3a. DEMO-LOGIN GUARD - a fresh install restores this snapshot, so any
    #     ENABLED test/demo/probe account in it becomes a real, reachable login
    #     on the customer's machine. That actually shipped for years as an
    #     ACTIVE 'test.super' SuperAdmin.
    #
    #     This is a hard FAILURE and not a silent fix because the accounts keep
    #     coming back: the integration tests run against a development database and
    #     re-enable them, so a package built straight after a test run is
    #     contaminated again. Deactivate them (scratchpad restore-accounts.js)
    #     and rebuild - do not weaken this check.
    $suspect = '^(qa|test|demo|ux|zz)[._]'
    $live = @()
    $inCopy = $false; $cols = @()
    foreach ($line in [System.IO.File]::ReadLines($dumpFile)) {
        if ($line -match '^COPY public\.admins \(([^)]+)\) FROM stdin;') {
            $cols = $Matches[1].Split(',') | ForEach-Object { $_.Trim() }; $inCopy = $true; continue
        }
        if ($inCopy) {
            if ($line -eq '\.') { break }
            $v = $line.Split("`t")
            $row = @{}; for ($i = 0; $i -lt $cols.Count -and $i -lt $v.Count; $i++) { $row[$cols[$i]] = $v[$i] }
            $u = [string]$row['username']
            if ($u -match $suspect -and $row['is_active'] -eq 't') { $live += $u }
        }
    }
    if ($live.Count) {
        throw ("Refusing to package: the data snapshot carries $($live.Count) ENABLED test/demo account(s) " +
               "[" + ($live -join ', ') + "] which would become live logins on a fresh install. " +
               "Deactivate them on a development database and rebuild.")
    }
    Write-Host "  [OK] Demo-login guard: no enabled test/demo account in the snapshot" -ForegroundColor Gray
}

# 3b. DENYLIST GUARD - an optional, git-ignored installer\denylist.txt lists
#     tokens (one .NET regex per line, '#' comments) that must never appear in a
#     package you distribute: your organisation's name, internal hostnames,
#     customer names. The build fails if any shipped text file matches. Vendored
#     third-party bundles and base64 payloads are exempt. Keeping the list OUT of
#     the repository means the guard never has to name what it protects.
$scanExt = @('.js', '.mjs', '.cjs', '.json', '.sql', '.md', '.html', '.htm', '.ejs', '.css',
             '.ps1', '.psd1', '.psm1', '.bat', '.cmd', '.txt', '.yml', '.yaml', '.xml', '.env', '.cs', '.manifest')
$denyFile = Join-Path $here 'denylist.txt'
$denyRx = @()
if (Test-Path -LiteralPath $denyFile) {
    $denyRx = Get-Content -LiteralPath $denyFile | Where-Object { $_ -and $_ -notmatch '^\s*#' } | ForEach-Object { [regex]$_.Trim() }
}
$b64Rx   = [regex]'data:[^;,]+;base64,[A-Za-z0-9+/=]+'
$brandHits = @()
if ($denyRx.Count) {
    Get-ChildItem -LiteralPath $staging -Recurse -File -Force | ForEach-Object {
        if ($scanExt -notcontains $_.Extension.ToLower()) { return }
        if ($_.FullName -match '[\\/]vendor[\\/]') { return }
        $text = $b64Rx.Replace([System.IO.File]::ReadAllText($_.FullName), '')
        $n = 0; foreach ($rx in $denyRx) { $n += $rx.Matches($text).Count }
        if ($n -gt 0) {
            $rel = $_.FullName.Substring($staging.Length).TrimStart('\', '/')
            $brandHits += "$rel ($n)"
        }
    }
}
if ($brandHits) {
    throw ("Refusing to package: a denylisted token appears in " +
           "$($brandHits.Count) shipped file(s):`n  " + ($brandHits -join "`n  ") +
           "`nRemove it (or, for a genuine third-party false positive, exempt the path above) and rebuild.")
}
Write-Host ("  [OK] Denylist guard: " + $(if ($denyRx.Count) { "$($denyRx.Count) pattern(s), no match" } else { 'no installer\denylist.txt - skipped' })) -ForegroundColor Gray

# 4. zip
$zip = Join-Path $OutDir "$pkgName.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -Force
$sizeMB = [math]::Round((Get-Item $zip).Length / 1MB, 1)

Write-Host "[OK] Package: $zip ($sizeMB MB)" -ForegroundColor Green
Write-Host "  Staging: $staging" -ForegroundColor Gray
Write-Host "  Ship the .zip; on the target run: powershell -ExecutionPolicy Bypass -File .\Install-IDevelop.ps1" -ForegroundColor Gray
