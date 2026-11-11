'use strict';
/**
 * Windows installer: the backup key and encrypted restore points.
 *
 *  - Install-IDevelop runs `backup-key.js init` on every run (never
 *    regenerates a key) and offers the ONE recovery-key export until it is
 *    done: to a path typed at the console, else to the server's key folder
 *    with a loud warning. Never inside the install directory; key material is
 *    never logged.
 *  - Manage-IDevelop -Backup encrypts the restore point's dump
 *    (database.sql.enc); -Restore verifies it before anything is stopped and
 *    decrypts it straight into psql. A legacy plain database.sql stays
 *    restorable, flagged [UNENCRYPTED].
 *
 * Linux: the CLI contract of scripts/backup-key.js the installer relies on is
 * run for real (derived mode, temp keyring), plus static checks. Windows: the
 * PowerShell functions are EXTRACTED with the parser and RUN.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const onWindows = process.platform === 'win32';
const wt = onWindows ? test : test.skip;
const ROOT = path.join(__dirname, '..', '..');
const INSTALL = path.join(ROOT, 'installer', 'Install-IDevelop.ps1');
const MANAGE = path.join(ROOT, 'installer', 'Manage-IDevelop.ps1');
const KEYTOOL = path.join(ROOT, 'scripts', 'backup-key.js');
const INST = fs.readFileSync(INSTALL, 'utf8').replace(/\r\n/g, '\n');
const MNG = fs.readFileSync(MANAGE, 'utf8').replace(/\r\n/g, '\n');
const q = (s) => s.replace(/'/g, "''");

function runPs(script) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-bk-'));
    const ps1 = path.join(dir, 'probe.ps1');
    fs.writeFileSync(ps1, script);
    try {
        return execFileSync(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
            { encoding: 'utf8', timeout: 120000 }
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
function prelude(src, names) {
    return `
$ErrorActionPreference = 'Stop'
$tk = $null; $er = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${q(src)}', [ref]$tk, [ref]$er)
if ($er.Count) { throw "parse errors: $($er.Count)" }
$names = @(${names.map((n) => `'${n}'`).join(',')})
$defs = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $n.Name }, $true)
if (@($defs).Count -ne $names.Count) { throw "functions found: $(@($defs).Count) of $($names.Count)" }
foreach ($d in $defs) { . ([scriptblock]::Create($d.Extent.Text)) }
$script:logs = New-Object System.Collections.Generic.List[string]
function Log($m, $l = 'INFO') { [void]$script:logs.Add("[$l] $m") }
`;
}
const json = (s) => JSON.parse(s.replace(/^\uFEFF/, ''));

// ------------------------------------------------------------- CLI contract
describe('scripts/backup-key.js: the contract the installer and Manage rely on', () => {
    let dir;
    let env;
    const run = (args, input) =>
        spawnSync(process.execPath, [KEYTOOL, ...args], {
            encoding: 'utf8',
            timeout: 60000,
            input,
            env,
        });
    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-bk-cli-'));
        env = {
            PATH: process.env.PATH,
            NODE_ENV: 'test',
            BACKUP_KEY_MODE: 'derived',
            APP_KEY: crypto.randomBytes(32).toString('hex'),
            BACKUP_KEYRING_FILE: path.join(dir, 'keys', 'backup-keyring.json'),
        };
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('init: exit 0, JSON with keyId / protection / created, idempotent', () => {
        const a = run(['init']);
        expect(a.status).toBe(0);
        const ja = JSON.parse(/\{[\s\S]*\}/.exec(a.stdout)[0]);
        expect(ja).toEqual(
            expect.objectContaining({ keyId: expect.any(String), protection: 'app-key-derived' })
        );
        expect(typeof ja.created).toBe('boolean');
        const b = run(['init']);
        const jb = JSON.parse(/\{[\s\S]*\}/.exec(b.stdout)[0]);
        expect(jb.keyId).toBe(ja.keyId); // never regenerated
        expect(jb.created).toBe(false);
        const s = run(['status']);
        expect(s.status).toBe(0);
        expect(JSON.parse(s.stdout)).toEqual(
            expect.objectContaining({ keyId: ja.keyId, exportedAt: null })
        );
    });

    test('restore point: encrypt --kind installer-restore-point --remove-plain, verify, pipe --run', () => {
        const plain = path.join(dir, 'database.sql');
        const sql = '-- dump\nCREATE TABLE probe (id int);\n';
        fs.writeFileSync(plain, sql);
        const enc = `${plain}.enc`;
        const e = run([
            'encrypt',
            '--in',
            plain,
            '--out',
            enc,
            '--kind',
            'installer-restore-point',
            '--remove-plain',
        ]);
        expect(e.status).toBe(0);
        expect(fs.existsSync(plain)).toBe(false); // removed only after it verified
        expect(fs.existsSync(enc)).toBe(true);
        expect(fs.readFileSync(enc).includes(Buffer.from('CREATE TABLE'))).toBe(false);
        expect(run(['verify', '--in', enc]).status).toBe(0);
        // The plaintext reaches the tool's stdin (Manage: psql), never a file.
        const p = run([
            'pipe',
            '--in',
            enc,
            '--run',
            process.execPath,
            '-e',
            "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s))",
        ]);
        expect(p.status).toBe(0);
        expect(p.stdout).toBe(sql);
        // A tampered file is refused before anything is restored.
        const buf = fs.readFileSync(enc);
        buf[buf.length - 5] ^= 0xff;
        fs.writeFileSync(enc, buf);
        expect(run(['verify', '--in', enc]).status).not.toBe(0);
    });

    test('a legacy plain database.sql still verifies (restored as-is, flagged)', () => {
        const legacy = path.join(dir, 'legacy.sql');
        fs.writeFileSync(legacy, 'CREATE TABLE legacy (id int);\n');
        const v = run(['verify', '--in', legacy]);
        expect(v.status).toBe(0);
        expect(JSON.parse(v.stdout).encrypted).toBe(false);
    });
});

// ------------------------------------------------------------------ static
describe('installer and Manage wiring (static)', () => {
    test('the hook runs after the audit-owner step and before the service step, on every run', () => {
        const hook = INST.indexOf('$script:BackupKeyResult = Invoke-BackupKeyHook');
        const ao = INST.indexOf('if ($script:AuditPlan.On) {');
        const svc = INST.indexOf('# STEP 6/7 - Service');
        expect(hook).toBeGreaterThan(ao);
        expect(hook).toBeLessThan(svc);
        expect(INST).toMatch(/\$sum \+= "Backup key {4}: \$\(\$script:BackupKeyResult\)"/);
    });

    test('the hook never logs the tool output and never exports into the install directory', () => {
        const fn = /function Invoke-BackupKeyHook[\s\S]*?\n\}/.exec(INST)[0];
        expect(fn).not.toMatch(/Log [^\n]*\$in\.Out/);
        expect(fn).not.toMatch(/Log [^\n]*\$ex\.Out/);
        expect(fn).toMatch(
            /\$full\.StartsWith\(\$instRoot, \[StringComparison\]::OrdinalIgnoreCase\)/
        );
        expect(fn).not.toMatch(/--force/);
        expect(fn).toMatch(
            /\$fallback = Join-Path \(Join-Path \$LogDir 'keys'\) "backup-recovery-\$keyTag\.txt"/
        );
    });

    test('the service account gets Read on the keyring only, never on a recovery file', () => {
        expect(INST).toMatch(
            /-Filter 'backup-keyring\*\.json' -ErrorAction SilentlyContinue\)\) \{\s+if \(-not \(Set-ServiceSidAce \$kf\.FullName \$false 'Read'\)\)/
        );
    });

    test('Manage -Backup encrypts; a plain dump only when the installed version has no backup-key.js', () => {
        const b = /function Invoke-Backup[\s\S]*?\n\}/.exec(MNG)[0];
        expect(b).toMatch(/Protect-RestorePointDump \$dbFile/);
        expect(b).toMatch(/elseif \(\$dump\.ToolMissing -or \$AllowPlainBackup\)/);
        expect(b).toMatch(
            /Remove-Item -LiteralPath \$rp -Recurse -Force[\s\S]*Die "Restore point REFUSED/
        );
        expect(b).toMatch(/encrypted = \[bool\]\$dump\.Encrypted/);
        expect(MNG).toMatch(/\[switch\]\$AllowPlainBackup/);
    });

    test('Manage -Restore verifies before it stops anything, and decrypts into psql', () => {
        const r = /function Invoke-Restore[\s\S]*?\n\}/.exec(MNG)[0];
        const verify = r.indexOf(
            "$vr = Invoke-KeyTool $cfg.InstallDir @('verify', '--in', $dbFile)"
        );
        const stop = r.indexOf('Stop-Service -Name $svc');
        expect(verify).toBeGreaterThan(0);
        expect(verify).toBeLessThan(stop);
        expect(r).toMatch(
            /Invoke-KeyTool \$cfg\.InstallDir @\('pipe', '--in', \$dbFile, '--run', \$psql/
        );
        expect(r).toMatch(/Die "RESTORE REFUSED/);
        expect(MNG).toMatch(/\[UNENCRYPTED\]/);
    });
});

// ------------------------------------------------------------------ Windows
describe('Manage restore points: encrypted dump, legacy plaintext still found (Windows)', () => {
    wt(
        'encrypt ok: .enc only; encrypt fails / tool missing: plain kept + said; .enc preferred',
        () => {
            const base = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-bk-rp-'));
            try {
                const b = q(base);
                const r = json(
                    runPs(`${prelude(MANAGE, ['Protect-RestorePointDump', 'Resolve-RestorePointDump'])}
function Mk($name) { $d = Join-Path '${b}' $name; New-Item -ItemType Directory -Force -Path $d | Out-Null; Set-Content -LiteralPath (Join-Path $d 'database.sql') -Value 'CREATE TABLE x();'; $d }
$calls = New-Object System.Collections.Generic.List[string]
$ok = { param([string[]]$KeyArgs) $calls.Add($KeyArgs -join ' '); Set-Content -LiteralPath $KeyArgs[4] -Value 'ENC'; Remove-Item -LiteralPath $KeyArgs[2]; [pscustomobject]@{ Code = 0; Out = '' } }
$half = { param([string[]]$KeyArgs) Set-Content -LiteralPath $KeyArgs[4] -Value 'partial'; [pscustomobject]@{ Code = 1; Out = 'did not verify' } }
$none = { param([string[]]$KeyArgs) [pscustomobject]@{ Code = -1; Out = 'missing' } }
$a = Mk 'rp-a'; $pa = Protect-RestorePointDump (Join-Path $a 'database.sql') $ok
$h = Mk 'rp-h'; $ph = Protect-RestorePointDump (Join-Path $h 'database.sql') $half
$n = Mk 'rp-n'; $pn = Protect-RestorePointDump (Join-Path $n 'database.sql') $none
$e = Join-Path '${b}' 'rp-empty'; New-Item -ItemType Directory -Force -Path $e | Out-Null
$o = [ordered]@{
  calls = @($calls)
  a = $pa; aFiles = (@(Get-ChildItem -LiteralPath $a | ForEach-Object { [string]$_.Name }) -join ',')
  h = $ph; hFiles = (@(Get-ChildItem -LiteralPath $h | ForEach-Object { [string]$_.Name }) -join ',')
  n = $pn
  resA = Resolve-RestorePointDump $a; resH = Resolve-RestorePointDump $h; resE = Resolve-RestorePointDump $e
}
[Console]::Out.Write(($o | ConvertTo-Json -Depth 4 -Compress))`)
                );
                expect(r.calls[0]).toMatch(
                    /^encrypt --in .*database\.sql --out .*database\.sql\.enc --kind installer-restore-point --remove-plain$/
                );
                expect(r.a.Encrypted).toBe(true);
                expect(r.aFiles).toBe('database.sql.enc');
                expect(r.h).toMatchObject({ Encrypted: false, ToolMissing: false });
                expect(r.h.Message).toMatch(/PLAIN SQL/);
                expect(r.hFiles).toBe('database.sql');
                expect(r.n).toMatchObject({ Encrypted: false, ToolMissing: true });
                expect(r.n.Message).toMatch(/backup-key\.js \/ node\.exe not found/);
                expect(r.resA).toMatchObject({ Encrypted: true });
                expect(r.resA.File).toMatch(/database\.sql\.enc$/);
                expect(r.resH).toMatchObject({ Encrypted: false });
                expect(r.resE).toBeNull();
            } finally {
                fs.rmSync(base, { recursive: true, force: true });
            }
        },
        60000
    );
});

describe('backup key hook: init every run, recovery export offered until done once (Windows)', () => {
    let r;
    let base;
    beforeAll(() => {
        if (!onWindows) return;
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-bk-key-'));
        const withScript = path.join(base, 'inst');
        const without = path.join(base, 'bare');
        fs.mkdirSync(path.join(withScript, 'scripts'), { recursive: true });
        fs.mkdirSync(without, { recursive: true });
        fs.writeFileSync(path.join(withScript, 'scripts', 'backup-key.js'), '//');
        const w = q(withScript);
        r = json(
            runPs(`${prelude(INSTALL, ['Invoke-BackupKeyHook'])}
$LogDir = '${q(path.join(base, 'pd'))}'
function Run($inst, [hashtable]$init, $exportedAt, $exportCode, $askAnswer, $initCode = 0) {
  $script:calls = New-Object System.Collections.Generic.List[string]
  $script:after = 0
  $script:io = @{ init = $init; exportedAt = $exportedAt; exportCode = $exportCode; initCode = $initCode }
  $run = {
    param([string[]]$KeyArgs)
    $script:calls.Add($KeyArgs -join ' ')
    switch ($KeyArgs[0]) {
      'init'   { [pscustomobject]@{ Code = $script:io.initCode; Out = ('backup-key: SECRET-KEY-MATERIAL' + [Environment]::NewLine + ($script:io.init | ConvertTo-Json)) } }
      'status' { [pscustomobject]@{ Code = 0; Out = (@{ keyId = 'k1'; protection = 'dpapi-localmachine'; exportedAt = $script:io.exportedAt } | ConvertTo-Json) } }
      'export' { [pscustomobject]@{ Code = $(if ($KeyArgs[2] -eq 'E:\\busy.txt') { 1 } else { $script:io.exportCode }); Out = 'SECRET-KEY-MATERIAL' } }
    }
  }
  $res = Invoke-BackupKeyHook $inst $run { $askAnswer } { $script:after++ }
  [pscustomobject]@{ Result = $res; Calls = @($script:calls); After = $script:after }
}
$dp = @{ keyId = 'k1'; protection = 'dpapi-localmachine'; keyring = 'C:\\PD\\keys\\backup-keyring.json'; created = $true }
$old = @{ keyId = 'k1'; protection = 'dpapi-localmachine'; keyring = 'x'; created = $false }
$derived = @{ keyId = 'k2'; protection = 'app-key-derived'; created = $true }
$script:logs.Clear()
$o = [ordered]@{
  freshExport = Run '${w}' $dp $null 0 'E:\\key.txt'
  freshLater = Run '${w}' $dp $null 0 $null
  onServer = Run '${w}' $dp $null 0 '${w}\\key.txt'
  upExported = Run '${w}' $old '2026-09-30T10:00:00Z' 0 'E:\\key.txt'
  upPending = Run '${w}' $old $null 0 'E:\\key.txt'
  upRace = Run '${w}' $old $null 3 'E:\\key.txt'
  derived = Run '${w}' $derived $null 0 'E:\\key.txt'
  initFails = Run '${w}' $dp $null 0 'E:\\key.txt' 1
  chosenFails = Run '${w}' $dp $null 0 'E:\\busy.txt'
  absent = Run '${q(without)}' $dp $null 0 $null
}
$o.fallback = Join-Path (Join-Path $LogDir 'keys') 'backup-recovery-k1.txt'
$o.logs = @($script:logs)
[Console]::Out.Write(($o | ConvertTo-Json -Depth 4 -Compress))`)
        );
    }, 120000);
    afterAll(() => {
        if (base) fs.rmSync(base, { recursive: true, force: true });
    });

    wt('fresh install: init, then the recovery key exported ONCE to the chosen path', () => {
        expect(r.freshExport).toEqual({
            Result: 'created/exported-now',
            Calls: ['init', 'status', 'export --out E:\\key.txt'],
            After: 2,
        });
        expect(r.freshLater).toEqual({
            Result: 'created/exported-to-server',
            Calls: ['init', 'status', `export --out ${r.fallback}`],
            After: 2,
        });
        expect(r.logs.join('\n')).toMatch(
            /BACKUP RECOVERY KEY WRITTEN TO .*backup-recovery-k1\.txt.*MOVE IT TO OFFLINE STORAGE NOW/
        );
    });

    wt('never inside the install directory: the key folder is used instead', () => {
        expect(r.onServer).toMatchObject({
            Result: 'created/exported-to-server',
            Calls: ['init', 'status', `export --out ${r.fallback}`],
        });
    });

    wt('a failed export to the chosen path falls back to the key folder', () => {
        expect(r.chosenFails).toMatchObject({
            Result: 'created/exported-to-server',
            Calls: ['init', 'status', 'export --out E:\\busy.txt', `export --out ${r.fallback}`],
        });
    });

    wt('upgrade: an existing key is kept, and not shown again once exported', () => {
        expect(r.upExported).toMatchObject({
            Result: 'existing/exported-earlier',
            Calls: ['init', 'status'],
        });
        expect(r.upPending).toMatchObject({
            Result: 'existing/exported-now',
            Calls: ['init', 'status', 'export --out E:\\key.txt'],
        });
        expect(r.upRace.Result).toBe('existing/exported-earlier');
        const all = Object.values(r).flatMap((x) => (x && x.Calls) || []);
        expect(all.some((c) => /force|rotate|import/.test(c))).toBe(false);
    });

    wt('APP_KEY-derived key: no recovery export, the APP_KEY is what to keep', () => {
        expect(r.derived).toMatchObject({ Result: 'created/app-key-derived', Calls: ['init'] });
        expect(r.logs.join('\n')).toMatch(/DERIVED from APP_KEY/);
    });

    wt('init failure / script not shipped: skipped with a WARN; key material never logged', () => {
        expect(r.initFails).toMatchObject({ Result: 'init-failed', Calls: ['init'] });
        expect(r.absent).toEqual({ Result: 'absent', Calls: [], After: 0 });
        const logs = r.logs.join('\n');
        expect(logs).toMatch(/scripts\\backup-key\.js is not in this package/);
        expect(logs).toMatch(/init failed \(exit 1\)/);
        expect(logs).not.toMatch(/SECRET-KEY-MATERIAL/);
    });
});
