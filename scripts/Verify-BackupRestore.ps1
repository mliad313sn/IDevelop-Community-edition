<#
.SYNOPSIS  Backup restore drill - prove the newest DB backup actually restores.
.DESCRIPTION
    "A backup that has never been restored is a hope, not a plan."
    This drill takes the NEWEST pg_dump produced by the app's daily db-backup
    job (or a file you point it at), restores it into a THROWAWAY scratch
    database, runs structural sanity checks (core tables exist and hold rows,
    the analytics views select), then drops the scratch DB. The live database
    is never touched. Run quarterly, or after changing anything about backups.

    Exit code 0 = the backup restores and passes checks; non-zero = ACT NOW -
    your backups may not be restorable.

    ENCRYPTED BACKUPS (SA-39). Daily backups are <db>-<date>.dump.enc files with
    a SHA-256 manifest next to them. The drill checks the manifest and every
    encrypted chunk FIRST (node scripts\backup-key.js verify) and refuses a file
    that does not match, or whose key this server does not hold. The restore
    then streams the decrypted dump into pg_restore's stdin (backup-key.js pipe):
    no clear copy is written to disk. A legacy plaintext .dump is still
    restored, with a warning. See docs\BACKUPS.md.

.PARAMETER BackupFile     Path to a .sql/.dump/.dump.enc backup (default: newest file in -BackupDir).
.PARAMETER BackupDir      Where the daily backups land (default: %ProgramData%\IDevelop\backups, else <app>\backups\auto).
.PARAMETER PgSuperPassword postgres superuser password (default: PGPASSWORD env or prompt).
.PARAMETER PgHost / PgPort Target PostgreSQL (default localhost:5432).
.EXAMPLE  powershell -ExecutionPolicy Bypass -File .\scripts\Verify-BackupRestore.ps1 -PgSuperPassword 'pgpass'
#>
[CmdletBinding()]
param(
    [string]$BackupFile,
    [string]$BackupDir,
    [string]$PgSuperPassword,
    [string]$PgHost = 'localhost',
    [int]$PgPort = 5432
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$appRoot = Split-Path -Parent $here
if (-not $BackupDir) {
    $pdBackups = if ($env:ProgramData) { Join-Path $env:ProgramData 'IDevelop\backups' } else { $null }
    $pdOk = $false
    if ($pdBackups) { try { $pdOk = [bool](Test-Path $pdBackups -ErrorAction Stop) } catch { $pdOk = $false } }
    $BackupDir = if ($pdOk) { $pdBackups } else { Join-Path $appRoot 'backups\auto' }
}
$backupKeyJs = Join-Path $here 'backup-key.js'

function Log($m, $c = 'Gray') { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -ForegroundColor $c }
function Fail($m) { Log $m 'Red'; exit 1 }

# --- locate psql ---
$psql = (Get-Command psql.exe -ErrorAction SilentlyContinue).Source
if (-not $psql) {
    $psql = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName 'bin\psql.exe' } |
        Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $psql) { Fail 'psql.exe not found - install the PostgreSQL client tools.' }

# --- locate the backup ---
if (-not $BackupFile) {
    $candidate = Get-ChildItem $BackupDir -Include '*.sql', '*.dump', '*.dump.enc' -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $candidate) { Fail "No backup files found under $BackupDir - is the daily db-backup job running?" }
    $BackupFile = $candidate.FullName
}
if (-not (Test-Path $BackupFile)) { Fail "Backup file not found: $BackupFile" }
$age = [math]::Round(((Get-Date) - (Get-Item $BackupFile).LastWriteTime).TotalHours, 1)
Log "Backup   : $BackupFile ($([math]::Round((Get-Item $BackupFile).Length/1MB,1)) MB, ${age}h old)"
if ($age -gt 48) { Log "WARNING: newest backup is ${age}h old - the daily backup job may be failing." 'Yellow' }

# --- encrypted? manifest? (magic bytes, not the extension) ---
$head8 = New-Object byte[] 8
$fs = [IO.File]::OpenRead($BackupFile); try { [void]$fs.Read($head8, 0, 8) } finally { $fs.Close() }
$encrypted = ([Text.Encoding]::ASCII.GetString($head8) -eq 'IDVBKENC')
$hasManifest = Test-Path ($BackupFile + '.manifest.json')
$node = $null
if ($encrypted -or $hasManifest) {
    $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $node -and (Test-Path "$env:ProgramFiles\nodejs\node.exe")) { $node = "$env:ProgramFiles\nodejs\node.exe" }
    if (-not $node) { Fail 'node.exe not found - it is needed to verify and decrypt an encrypted backup.' }
    if (-not (Test-Path $backupKeyJs)) { Fail 'scripts\backup-key.js not found next to this drill.' }
    Log 'Verifying the SHA-256 manifest and every encrypted chunk BEFORE restoring ...'
    $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $vOut = & $node $backupKeyJs verify --in $BackupFile 2>&1
    $vCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($vCode -ne 0) { Fail ("RESTORE REFUSED - integrity check failed: " + ((($vOut | ForEach-Object { "$_" }) -join ' ').Trim())) }
    Log '  integrity OK' 'Green'
} else {
    Log 'WARNING: unencrypted legacy backup with no integrity manifest - restored as-is.' 'Yellow'
}

if (-not $PgSuperPassword) { $PgSuperPassword = $env:PGPASSWORD }
if (-not $PgSuperPassword) {
    $sec = Read-Host 'postgres superuser password' -AsSecureString
    $PgSuperPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
$env:PGPASSWORD = $PgSuperPassword

$scratch = 'restore_drill_' + (Get-Date -Format 'yyyyMMddHHmmss')

# Native tools (psql / pg_restore) report failure through $LASTEXITCODE and
# stderr. Under $ErrorActionPreference = 'Stop', the FIRST stderr line of a
# native command becomes a terminating NativeCommandError, which jumped straight
# to `finally` before a single check ran: a corrupt dump exited 1 with no
# "RESTORE DRILL FAILED" verdict and no check output at all. Run every native
# call with a non-terminating preference so the verdict is always printed.
function Invoke-Native([scriptblock]$block) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $block } finally { $ErrorActionPreference = $prev }
}
function Psql([string]$db, [string]$sql) {
    Invoke-Native { & $psql -h $PgHost -p $PgPort -U postgres -d $db -v ON_ERROR_STOP=1 -t -A -c $sql 2>&1 }
}

try {
    Log "Creating scratch database $scratch ..."
    $r = Psql 'postgres' "CREATE DATABASE $scratch"
    if ($LASTEXITCODE -ne 0) { Fail "Could not create scratch DB: $r" }

    Log 'Restoring the backup into the scratch DB (errors tolerated for ownership noise) ...'
    # The daily db-backup job writes CUSTOM-format dumps (-F c, header "PGDMP")
    # which need pg_restore; plain .sql dumps go through psql. Detect by magic
    # bytes, not extension. Ownership/grant noise is expected - structural
    # failures surface in the checks below.
    $magic = [Text.Encoding]::ASCII.GetString($head8, 0, 5)
    $pgRestore = Join-Path (Split-Path -Parent $psql) 'pg_restore.exe'
    if ($encrypted) {
        # Decrypted stream -> pg_restore stdin; no clear copy on disk.
        if (-not (Test-Path $pgRestore)) { Fail "pg_restore.exe not found next to psql - cannot restore a custom-format dump." }
        Invoke-Native { & $node $backupKeyJs pipe --in $BackupFile --run $pgRestore -h $PgHost -p $PgPort -U postgres -d $scratch --no-owner --no-privileges 2>&1 } |
            Where-Object { "$_" -match 'error|decryption' } | Select-Object -First 5 | ForEach-Object { Log "  restore: $_" 'DarkYellow' }
    } elseif ($magic -eq 'PGDMP') {
        if (-not (Test-Path $pgRestore)) { Fail "pg_restore.exe not found next to psql - cannot restore a custom-format dump." }
        Invoke-Native { & $pgRestore -h $PgHost -p $PgPort -U postgres -d $scratch --no-owner --no-privileges $BackupFile 2>&1 } |
            Where-Object { "$_" -match 'error' } | Select-Object -First 5 | ForEach-Object { Log "  restore: $_" 'DarkYellow' }
    } else {
        Invoke-Native { & $psql -h $PgHost -p $PgPort -U postgres -d $scratch -q -f $BackupFile 2>&1 } |
            Where-Object { "$_" -match 'ERROR' } | Select-Object -First 5 | ForEach-Object { Log "  restore: $_" 'DarkYellow' }
    }

    Log 'Running structural sanity checks ...'
    $checks = @(
        @{ name = 'employees table has rows';        sql = 'SELECT COUNT(*) FROM employees' ;              min = 1 },
        @{ name = 'skills table has rows';           sql = 'SELECT COUNT(*) FROM skills';                  min = 1 },
        @{ name = 'admins table has rows';           sql = 'SELECT COUNT(*) FROM admins';                  min = 1 },
        @{ name = 'assessment history present';      sql = 'SELECT COUNT(*) FROM assessment_history';      min = 0 },
        @{ name = 'v_employee_readiness selects';    sql = 'SELECT COUNT(*) FROM v_employee_readiness';    min = 0 },
        @{ name = 'v_certification_current selects'; sql = 'SELECT COUNT(*) FROM v_certification_current'; min = 0 },
        @{ name = 'v_coverage_status selects';       sql = 'SELECT COUNT(*) FROM v_coverage_status';       min = 0 },
        @{ name = 'schema_meta has migrations';      sql = 'SELECT COUNT(*) FROM schema_meta';             min = 10 }
    )
    $failed = 0
    foreach ($c in $checks) {
        $out = Psql $scratch $c.sql
        $n = 0; [void][int]::TryParse(($out | Select-Object -First 1), [ref]$n)
        if ($LASTEXITCODE -ne 0) { Log ("  FAIL  {0}: {1}" -f $c.name, ($out | Select-Object -First 1)) 'Red'; $failed++ }
        elseif ($n -lt $c.min)   { Log ("  FAIL  {0}: {1} rows (< {2})" -f $c.name, $n, $c.min) 'Red'; $failed++ }
        else                     { Log ("  OK    {0}: {1}" -f $c.name, $n) 'Green' }
    }

    if ($failed -gt 0) { Fail "RESTORE DRILL FAILED - $failed check(s) failed. Investigate the backup pipeline NOW." }
    Log 'RESTORE DRILL PASSED - the newest backup restores and passes all checks.' 'Green'
    exit 0
}
finally {
    Log "Dropping scratch database $scratch ..."
    Psql 'postgres' "DROP DATABASE IF EXISTS $scratch WITH (FORCE)" | Out-Null
    $env:PGPASSWORD = ''
}
