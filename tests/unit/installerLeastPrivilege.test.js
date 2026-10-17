'use strict';
/**
 * Windows installer: least-privilege service account and audit-owner plan.
 *
 *  - ServiceAccount 'Auto': a NEW install runs as NT SERVICE\<name>; an upgrade
 *    keeps its account and is OFFERED -MigrateServiceAccount, which runs after
 *    the upgrade is healthy and goes back to LocalSystem by itself when the
 *    service does not come up healthy.
 *  - The account gets Modify on the data folders only, ReadAndExecute on the
 *    code, nothing on the code backups; WinSW logs go to service\logs.
 *  - AuditOwnerSeparation 'Auto': OFF for a new install (it disables four
 *    SuperAdmin tools), offered with -EnableAuditOwnerSeparation; an upgrade
 *    keeps the state its database is in.
 *
 * The static checks run everywhere (they read the .ps1 sources). On Windows the
 * functions are EXTRACTED with the PowerShell parser and RUN.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const onWindows = process.platform === 'win32';
const wt = onWindows ? test : test.skip;
const ROOT = path.join(__dirname, '..', '..');
const INSTALL = path.join(ROOT, 'installer', 'Install-IDevelop.ps1');
const MANAGE = path.join(ROOT, 'installer', 'Manage-IDevelop.ps1');
const CONFIG = path.join(ROOT, 'installer', 'config.psd1');
const INST = fs.readFileSync(INSTALL, 'utf8').replace(/\r\n/g, '\n');
const MNG = fs.readFileSync(MANAGE, 'utf8').replace(/\r\n/g, '\n');
const q = (s) => s.replace(/'/g, "''");

/** The text of `function <name>` up to its closing brace at column 0. */
function psFunction(src, name) {
    const start = src.indexOf(`\nfunction ${name}`);
    if (start < 0) return null;
    const end = src.indexOf('\n}\n', start);
    return src.slice(start + 1, end + 2);
}

function runPs(script) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-lp-'));
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
function prelude(src, names, assignments = []) {
    return `
$ErrorActionPreference = 'Stop'
$tk = $null; $er = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${q(src)}', [ref]$tk, [ref]$er)
if ($er.Count) { throw "parse errors: $($er.Count)" }
$names = @(${names.map((n) => `'${n}'`).join(',')})
$defs = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $n.Name }, $true)
if (@($defs).Count -ne $names.Count) { throw "functions found: $(@($defs).Count) of $($names.Count)" }
foreach ($d in $defs) { . ([scriptblock]::Create($d.Extent.Text)) }
$want = @(${assignments.map((n) => `'${n}'`).join(',')})
foreach ($w in $want) {
    $a = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq $w }, $true) | Select-Object -First 1
    if (-not $a) { throw "assignment not found: $w" }
    . ([scriptblock]::Create($a.Extent.Text))
}
$script:logs = New-Object System.Collections.Generic.List[string]
function Log($m, $l = 'INFO') { [void]$script:logs.Add("[$l] $m") }
function Fail($m) { throw "FAIL: $m" }
`;
}
const json = (s) => JSON.parse(s.replace(/^\uFEFF/, ''));

// ------------------------------------------------------------------ static
describe('Install and Manage share the same ACL and account rules (static)', () => {
    const SHARED = [
        'Get-ServiceSid',
        'Test-AclHardened',
        'Set-ServiceSidAce',
        'Protect-SensitivePath',
        'Get-HrisDropRoot',
        'Get-AppAclTargets',
        'Protect-AppDataAcls',
        'Resolve-ServiceAccountPlan',
    ];
    for (const name of SHARED) {
        test(`${name} is identical in both scripts`, () => {
            const a = psFunction(INST, name);
            const b = psFunction(MNG, name);
            expect(a).not.toBeNull();
            expect(b).toBe(a);
        });
    }

    test('the code is ReadAndExecute, never Modify; the code backups get nothing', () => {
        const f = psFunction(INST, 'Get-AppAclTargets');
        expect(f).toMatch(/\$rx = if \(\$ServiceSid\) \{ 'ReadAndExecute' \}/);
        expect(f).toMatch(/Path = \$InstallDir; Kind = 'Dir'; Restrict = \$false; Grant = \$rx/);
        expect(f).toMatch(
            /Join-Path \$InstallDir 'service'\); Kind = 'Dir'; Restrict = \$true; Grant = \$rx/
        );
        expect(f).toMatch(/\$sub -in @\('app-backups', 'restore-points'\)\) \{ '' \}/);
        // No line grants Modify on the install root any more.
        expect(INST).not.toMatch(/Set-ServiceSidAce \$InstallDir \$true 'Modify'/);
        expect(INST).not.toMatch(/holds Modify on \$InstallDir/);
    });

    test('Set-ServiceSidAce keeps EXACTLY the requested right (a broader ACE is replaced)', () => {
        const f = psFunction(INST, 'Set-ServiceSidAce');
        expect(f).toMatch(/-bnot \(\$want -bor \$sync\)/);
        expect(f).toMatch(/if \(-not \(\$mine\.Count -eq 1 -and \$exact\.Count -eq 1\)\)/);
    });

    test('the folders the service writes are created before the ACLs, since it only reads the root', () => {
        const create = INST.indexOf(
            "foreach ($wd in @('logs', 'tmp', 'uploads', 'data', 'backups', 'certs', 'AI_Engine_Docs', 'service\\logs'))"
        );
        const acl = INST.indexOf('$aclBad = Protect-AppDataAcls $LogDir $cfg.InstallDir');
        expect(create).toBeGreaterThan(0);
        expect(create).toBeLessThan(acl);
    });

    test('the WinSW wrapper is registered from the plan, never from the raw config value', () => {
        const reg = psFunction(INST, 'Register-WindowsService');
        expect(reg).toMatch(
            /\$acct = if \(\$script:SvcAcct -and \$script:SvcAcct\.Mode -eq 'Custom'\) \{ \$script:SvcAcct\.Account \} else \{ 'LocalSystem' \}/
        );
        expect(reg).not.toMatch(/\$acct = if \(\$cfg\.ServiceAccount\)/);
    });

    test('-MigrateServiceAccount runs after the health check, before the product is declared', () => {
        const health = INST.indexOf('$ok = Wait-AppHealthy');
        const mig = INST.indexOf('if ($script:SvcPlan.Migrate) {');
        const arp = INST.indexOf('\nRegister-AppEntry\n');
        expect(health).toBeGreaterThan(0);
        expect(mig).toBeGreaterThan(health);
        expect(mig).toBeLessThan(arp);
        const block = INST.slice(mig, arp);
        expect(block).toMatch(
            /Invoke-ServiceAccountMigration \$script:SvcPlan\.Sid \$script:SvcPlan\.Account/
        );
        expect(block).toMatch(/Healthy\s+= \{ return \[bool\]\(Wait-AppHealthy\) \}/);
        expect(block).toMatch(/& sc\.exe config \$cfg\.ServiceName obj= \$account/);
    });

    test('the switches exist and are documented', () => {
        for (const s of ['MigrateServiceAccount', 'EnableAuditOwnerSeparation']) {
            expect(INST).toMatch(new RegExp(`\\[switch\\]\\$${s}\\b`));
            expect(INST).toMatch(new RegExp(`\\.PARAMETER ${s}\\b`));
        }
    });

    test('the audit separation state is read BEFORE the reconcile hands the tables back', () => {
        const read = INST.indexOf('$script:AuditSeparatedNow = $false');
        const reown = INST.indexOf('$reownAll = @');
        const plan = INST.indexOf('$script:AuditPlan = Resolve-AuditOwnerPlan');
        expect(read).toBeGreaterThan(0);
        expect(read).toBeLessThan(reown);
        expect(plan).toBeGreaterThan(reown);
        // The legacy role name counts as separated too (an install not renamed yet).
        expect(INST.slice(read, reown)).toMatch(
            /tableowner IN \('\$\(\$script:AuditOwnerRole\)', '\$\(\$script:LegacyAuditOwnerRole\)'\)/
        );
    });

    test('a new install is never asked about the audit separation (off by default)', () => {
        expect(INST).toMatch(/if \(-not \$aoFresh -and \(Test-CanAsk\)\) \{/);
    });

    test('Manage resolves the grants from what the service RUNS AS', () => {
        expect(MNG).toMatch(
            /\$plan = Resolve-ServiceAccountPlan \$\(if \(\$svcExists\) \{ 'Auto' \} else \{ \$cfg\.ServiceAccount \}\)/
        );
    });

    test('config.psd1 ships both settings on Auto', () => {
        const cfg = fs.readFileSync(CONFIG, 'utf8');
        expect(cfg).toMatch(/^\s*ServiceAccount\s*=\s*'Auto'/m);
        expect(cfg).toMatch(/^\s*AuditOwnerSeparation\s*=\s*'Auto'/m);
    });

    test('WinSW logs: service\\logs, and the tools that read them look there first', () => {
        const rep = fs.readFileSync(path.join(ROOT, 'installer', 'Repair-Install.ps1'), 'utf8');
        expect(rep).toMatch(/\\service\\logs\\\$svc\.err\.log/);
        const wd = fs.readFileSync(path.join(ROOT, 'scripts', 'Health-Watchdog.ps1'), 'utf8');
        expect(wd).toMatch(/IDevelop\\service\\logs\\/);
    });
});

// ------------------------------------------------------------------ Windows
describe('service account plan (new install: virtual; upgrade: kept, offered)', () => {
    const CASES = `
$o = [ordered]@{
  fresh      = Resolve-ServiceAccountPlan 'Auto' 'IDevelop' '' $false $false
  blankFresh = Resolve-ServiceAccountPlan '' 'IDevelop' '' $false $false
  upLocal    = Resolve-ServiceAccountPlan 'Auto' 'IDevelop' 'LocalSystem' $true $false
  upMigrate  = Resolve-ServiceAccountPlan 'Auto' 'IDevelop' 'LocalSystem' $true $true
  upVirtual  = Resolve-ServiceAccountPlan 'Auto' 'IDevelop' 'NT SERVICE\\IDevelop' $true $false
  expLocal   = Resolve-ServiceAccountPlan 'LocalSystem' 'IDevelop' 'NT SERVICE\\IDevelop' $true $true
  expVirtUp  = Resolve-ServiceAccountPlan 'Virtual' 'IDevelop' 'LocalSystem' $true $false
  expVirtNew = Resolve-ServiceAccountPlan 'Virtual' 'IDevelop' '' $false $false
  custom     = Resolve-ServiceAccountPlan 'NT AUTHORITY\\LocalService' 'IDevelop' 'LocalSystem' $true $true
  sid        = Get-ServiceSid 'IDevelop'
}
[Console]::Out.Write(($o | ConvertTo-Json -Depth 4 -Compress))`;
    let inst;
    let mng;
    beforeAll(() => {
        if (!onWindows) return;
        const names = ['Get-ServiceSid', 'Resolve-ServiceAccountPlan'];
        inst = json(runPs(prelude(INSTALL, names) + CASES));
        mng = json(runPs(prelude(MANAGE, names) + CASES));
    }, 120000);

    wt('a NEW install (no service yet) runs as NT SERVICE\\<name>, with the service SID', () => {
        for (const k of ['fresh', 'blankFresh']) {
            expect(inst[k]).toMatchObject({
                Mode: 'Virtual',
                Account: 'NT SERVICE\\IDevelop',
                Sid: inst.sid,
                Migrate: false,
                Recommend: false,
            });
        }
    });

    wt('an UPGRADE of a LocalSystem service is NOT forced: kept + recommended', () => {
        expect(inst.upLocal).toMatchObject({
            Mode: 'LocalSystem',
            Sid: null,
            Migrate: false,
            Recommend: true,
        });
        expect(inst.upLocal.VirtualSid).toBe(inst.sid);
    });

    wt(
        '-MigrateServiceAccount (or explicit Virtual) on a LocalSystem service = verified migration',
        () => {
            expect(inst.upMigrate).toMatchObject({
                Mode: 'Virtual',
                Migrate: true,
                Recommend: false,
            });
            expect(inst.expVirtUp).toMatchObject({ Mode: 'Virtual', Migrate: true });
            expect(inst.expVirtNew).toMatchObject({ Mode: 'Virtual', Migrate: false });
        }
    );

    wt('a service already virtual stays virtual; explicit LocalSystem / custom win', () => {
        expect(inst.upVirtual).toMatchObject({ Mode: 'Virtual', Migrate: false, Recommend: false });
        expect(inst.expLocal).toMatchObject({
            Mode: 'LocalSystem',
            Migrate: false,
            Recommend: false,
        });
        expect(inst.custom).toMatchObject({
            Mode: 'Custom',
            Account: 'NT AUTHORITY\\LocalService',
        });
    });

    wt('Manage resolves exactly like the installer', () => {
        expect(mng).toEqual(inst);
    });
});

describe('ACL computation: the virtual account writes everywhere the app writes, and nowhere else', () => {
    const PROBE = `
$sid = 'S-1-5-80-1-2-3-4-5'
$o = [ordered]@{
  virt = @(Get-AppAclTargets 'C:\\PD\\IDevelop' 'C:\\PF\\IDevelop' $sid 'D:\\hris\\in')
  local = @(Get-AppAclTargets 'C:\\PD\\IDevelop' 'C:\\PF\\IDevelop' $null 'D:\\hris\\in')
  noInstall = @(Get-AppAclTargets 'C:\\PD\\IDevelop' '' $sid)
}
[Console]::Out.Write(($o | ConvertTo-Json -Depth 4 -Compress))`;
    let inst;
    let mng;
    beforeAll(() => {
        if (!onWindows) return;
        inst = json(runPs(prelude(INSTALL, ['Get-AppAclTargets']) + PROBE));
        mng = json(runPs(prelude(MANAGE, ['Get-AppAclTargets']) + PROBE));
    }, 120000);

    wt('Modify on every write location, Read on .env, ReadAndExecute on the code', () => {
        const by = Object.fromEntries(inst.virt.map((t) => [t.Path, t]));
        const mustWrite = [
            'C:\\PD\\IDevelop\\backups',
            'C:\\PD\\IDevelop\\sql-restore-points',
            'C:\\PD\\IDevelop\\audit-anchors',
            'C:\\PD\\IDevelop\\tls',
            'C:\\PD\\IDevelop\\keys',
            'C:\\PD\\IDevelop\\logs',
            'C:\\PD\\IDevelop',
            'C:\\PF\\IDevelop\\uploads',
            'C:\\PF\\IDevelop\\data',
            'C:\\PF\\IDevelop\\logs',
            'C:\\PF\\IDevelop\\backups',
            'C:\\PF\\IDevelop\\tmp',
            'C:\\PF\\IDevelop\\certs',
            'C:\\PF\\IDevelop\\AI_Engine_Docs',
            'C:\\PF\\IDevelop\\service\\logs',
        ];
        for (const p of mustWrite) {
            expect({ p, t: by[p] && { Grant: by[p].Grant, Restrict: by[p].Restrict } }).toEqual({
                p,
                t: { Grant: 'Modify', Restrict: true },
            });
        }
        expect(by['C:\\PF\\IDevelop\\.env']).toMatchObject({
            Kind: 'File',
            Grant: 'Read',
            Restrict: true,
        });
        expect(by['C:\\PF\\IDevelop']).toMatchObject({ Grant: 'ReadAndExecute', Restrict: false });
        expect(by['C:\\PF\\IDevelop\\service']).toMatchObject({
            Grant: 'ReadAndExecute',
            Restrict: true,
        });
        // Code backups: restricted, nothing for the service.
        for (const p of ['C:\\PD\\IDevelop\\app-backups', 'C:\\PD\\IDevelop\\restore-points'])
            expect(by[p]).toMatchObject({ Grant: '', Restrict: true });
        // The servicing config (may hold the standard passwords): restricted, nothing for the service.
        expect(by['C:\\PF\\IDevelop\\maintenance\\config.psd1']).toMatchObject({
            Kind: 'File',
            Grant: '',
            Restrict: true,
        });
        // HRIS drop folder (HRIS_DROP_ROOT): read-only, never restricted by Setup.
        expect(by['D:\\hris\\in']).toMatchObject({ Grant: 'ReadAndExecute', Restrict: false });
        expect(inst.virt.filter((t) => t.ProtectedFiles).map((t) => t.Path)).toEqual([
            'C:\\PD\\IDevelop\\backups',
            'C:\\PD\\IDevelop\\sql-restore-points',
            'C:\\PD\\IDevelop\\audit-anchors',
            'C:\\PD\\IDevelop\\keys',
            'C:\\PF\\IDevelop\\backups',
            'C:\\PF\\IDevelop\\data',
        ]);
        expect(by['C:\\PD\\IDevelop\\keys'].ProtectedFilter).toBe('backup-keyring*.json');
    });

    wt('LocalSystem: the same targets are restricted, nothing granted', () => {
        expect(inst.local.map((t) => t.Path)).toEqual(inst.virt.map((t) => t.Path));
        expect(inst.local.every((t) => t.Grant === '')).toBe(true);
        expect(inst.noInstall.some((t) => t.Path.startsWith('C:\\PF'))).toBe(false);
    });

    wt('Manage computes the identical list', () => {
        expect(mng).toEqual(inst);
    });

    wt(
        'an existing Modify ACE is downgraded to ReadAndExecute (upgrade of an older install)',
        () => {
            const base = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-lp-acl-'));
            try {
                const out = runPs(`${prelude(INSTALL, ['Set-ServiceSidAce'])}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$script:ServiceAclSid = $sid; $script:RevokeAclSids = @()
$d = Join-Path '${q(base)}' 'root'; New-Item -ItemType Directory -Force -Path $d | Out-Null
function Mine($p) { $a = New-Object System.Security.AccessControl.DirectorySecurity($p, [System.Security.AccessControl.AccessControlSections]::Access); @($a.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq $sid } | ForEach-Object { [int]$_.FileSystemRights }) }
$ok1 = Set-ServiceSidAce $d $true 'Modify'; $before = Mine $d
$ok2 = Set-ServiceSidAce $d $true 'ReadAndExecute'; $after = Mine $d
$ok3 = Set-ServiceSidAce $d $true 'ReadAndExecute'; $again = Mine $d
[Console]::Out.Write((@{ ok = @($ok1, $ok2, $ok3); before = @($before); after = @($after); again = @($again) } | ConvertTo-Json -Compress))`);
                const r = json(out);
                expect(r.ok).toEqual([true, true, true]);
                expect(r.before).toEqual([1245631]); // Modify
                expect(r.after).toEqual([1179817]); // ReadAndExecute
                expect(r.again).toEqual([1179817]);
            } finally {
                fs.rmSync(base, { recursive: true, force: true });
            }
        },
        120000
    );
});

describe('Invoke-ServiceAccountMigration: switch after a healthy upgrade, with its way back', () => {
    let r;
    beforeAll(() => {
        if (!onWindows) return;
        r = json(
            runPs(`${prelude(INSTALL, ['Invoke-ServiceAccountMigration'])}
function Run($aclBad, $scOk, $health) {
  $script:calls = New-Object System.Collections.Generic.List[string]
  $script:h = @($health)
  $ops = @{
    ApplyAcls = { param($g, $rv) $script:calls.Add("acl grant=[$g] revoke=[$(@($rv) -join ',')]"); if ($g) { $aclBad } else { 0 } }
    SetAccount = { param($a) $script:calls.Add("sc $a"); if ($a -eq 'LocalSystem') { $true } else { $scOk } }
    Restart = { $script:calls.Add('restart') }
    Healthy = { $v = $script:h[0]; $script:h = @($script:h | Select-Object -Skip 1); $script:calls.Add("healthy=$v"); $v }
  }
  $res = Invoke-ServiceAccountMigration 'S-1-5-80-9' 'NT SERVICE\\X' $ops
  [pscustomobject]@{ Result = $res.Result; Calls = @($script:calls) }
}
$o = [ordered]@{
  ok = Run 0 $true @($true)
  unhealthy = Run 0 $true @($false, $true)
  bothBad = Run 0 $true @($false, $false)
  aclBad = Run 2 $true @($true)
  scBad = Run 0 $false @($true)
}
[Console]::Out.Write(($o | ConvertTo-Json -Depth 5 -Compress))`)
        );
    }, 120000);

    wt('healthy as the virtual account: MIGRATED; grants first, nothing revoked', () => {
        expect(r.ok.Result).toBe('MIGRATED');
        expect(r.ok.Calls).toEqual([
            'acl grant=[S-1-5-80-9] revoke=[]',
            'sc NT SERVICE\\X',
            'restart',
            'healthy=True',
        ]);
    });

    wt('NOT healthy: back to LocalSystem, grants revoked, restarted, re-checked', () => {
        expect(r.unhealthy.Result).toBe('ROLLED-BACK');
        expect(r.unhealthy.Calls).toEqual([
            'acl grant=[S-1-5-80-9] revoke=[]',
            'sc NT SERVICE\\X',
            'restart',
            'healthy=False',
            'sc LocalSystem',
            'acl grant=[] revoke=[S-1-5-80-9]',
            'restart',
            'healthy=True',
        ]);
        expect(r.bothBad.Result).toBe('ROLLBACK-UNHEALTHY');
    });

    wt('fail closed: a folder not granted or sc.exe refusing means no switch at all', () => {
        expect(r.aclBad.Result).toBe('ABORTED-ACL');
        expect(r.aclBad.Calls.some((c) => c.startsWith('sc '))).toBe(false);
        expect(r.aclBad.Calls).toContain('acl grant=[] revoke=[S-1-5-80-9]');
        expect(r.scBad.Result).toBe('ABORTED-SC');
        expect(r.scBad.Calls).not.toContain('restart');
    });
});

describe('audit-owner separation plan', () => {
    wt(
        'new install off (offered); upgrade keeps the database state; explicit values win',
        () => {
            const r = json(
                runPs(`${prelude(INSTALL, ['Resolve-AuditOwnerPlan'])}
$o = [ordered]@{
  fresh = Resolve-AuditOwnerPlan 'Auto' $true $false $false
  freshAsk = Resolve-AuditOwnerPlan 'Auto' $true $false $true
  upOff = Resolve-AuditOwnerPlan 'Auto' $false $false $false
  upOn = Resolve-AuditOwnerPlan 'Auto' $false $true $false
  upAsk = Resolve-AuditOwnerPlan 'Auto' $false $false $true
  expOff = Resolve-AuditOwnerPlan $false $true $true $true
  expOn = Resolve-AuditOwnerPlan $true $false $false $false
}
[Console]::Out.Write(($o | ConvertTo-Json -Compress))`)
            );
            expect(r.fresh).toMatchObject({ On: false, Recommend: true });
            expect(r.freshAsk).toMatchObject({ On: true, Recommend: false });
            expect(r.upOff).toMatchObject({ On: false, Recommend: true });
            expect(r.upOn).toMatchObject({ On: true, Recommend: false });
            expect(r.upAsk).toMatchObject({ On: true, Recommend: false });
            expect(r.expOff).toMatchObject({ On: false, Recommend: false });
            expect(r.expOn).toMatchObject({ On: true });
        },
        60000
    );

    wt(
        'config.psd1 parses with both settings on Auto',
        () => {
            const r = json(
                runPs(`$c = Import-PowerShellDataFile -Path '${q(CONFIG)}'
[Console]::Out.Write((@{ sa = $c.ServiceAccount; ao = $c.AuditOwnerSeparation } | ConvertTo-Json -Compress))`)
            );
            expect(r).toEqual({ sa: 'Auto', ao: 'Auto' });
        },
        60000
    );
});
