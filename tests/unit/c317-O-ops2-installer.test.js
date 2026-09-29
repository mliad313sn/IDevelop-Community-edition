'use strict';
/**
 * 3.23.18 lane O-ops2 — installer side of S-04 (virtual service account),
 * S-05 (HTTPS .env wiring), item 4 (uploads/ + data/ ACLs) and the Manage
 * -Restore erasure re-application (coordinator request, S-07).
 *
 * The PowerShell helpers are EXTRACTED from the shipped scripts with the
 * PowerShell parser and RUN (not grepped). ACL probes run on a temp tree the
 * (non-elevated) test user owns, like c317-D-ops-security-installer.test.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const onWindows = process.platform === 'win32';
const ROOT = path.join(__dirname, '..', '..');
const INSTALL = path.join(ROOT, 'installer', 'Install-IDevelop.ps1');
const MANAGE = path.join(ROOT, 'installer', 'Manage-IDevelop.ps1');
const CONFIG = path.join(ROOT, 'installer', 'config.psd1');
const wt = onWindows ? test : test.skip;

function runPs(script) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c317-o-ps-'));
    const ps1 = path.join(dir, 'probe.ps1');
    fs.writeFileSync(ps1, script);
    try {
        return execFileSync(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
            {
                encoding: 'utf8',
                timeout: 120000,
            }
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function prelude(src, names) {
    return `
$ErrorActionPreference = 'Stop'
$tk = $null; $er = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${src}', [ref]$tk, [ref]$er)
if ($er.Count) { throw "parse errors: $($er.Count)" }
$names = @(${names.map((n) => `'${n}'`).join(',')})
$defs = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $n.Name }, $true)
if (@($defs).Count -ne $names.Count) { throw "functions found: $(@($defs).Count) of $($names.Count)" }
foreach ($d in $defs) { . ([scriptblock]::Create($d.Extent.Text)) }
$sidLine = (Get-Content -LiteralPath '${src}' | Where-Object { $_ -match '^\\$script:HardenedAclSids\\s*=' } | Select-Object -First 1)
if ($sidLine) { Invoke-Expression $sidLine }
$script:logs = New-Object System.Collections.Generic.List[string]
function Log($m, $l = 'INFO') { [void]$script:logs.Add("[$l] $m") }
function AclOf($p) {
    $a = New-Object System.Security.AccessControl.FileSecurity($p, [System.Security.AccessControl.AccessControlSections]::Access)
    $rules = @($a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    [pscustomobject]@{
        protected = $a.AreAccessRulesProtected
        sids = @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
        rights = @($rules | ForEach-Object { "$($_.IdentityReference.Value)=$([int]$_.FileSystemRights)" })
    }
}
`;
}

const ACL = [
    'Get-ServiceSid',
    'Resolve-ServiceAccount',
    'Test-AclHardened',
    'Set-ServiceSidAce',
    'Protect-SensitivePath',
    'Protect-AppDataAcls',
];
const SYSTEM = 'S-1-5-18';
const ADMINS = 'S-1-5-32-544';
const USERS = 'S-1-5-32-545';

describe.each([
    ['Install-IDevelop.ps1', INSTALL],
    ['Manage-IDevelop.ps1', MANAGE],
])('%s — S-04 service account', (_label, src) => {
    wt(
        'Get-ServiceSid matches sc.exe showsid; Resolve-ServiceAccount modes',
        () => {
            const out = runPs(`${prelude(src, ACL)}
$o = [ordered]@{
  sid = Get-ServiceSid 'IDevelop'
  sid2 = Get-ServiceSid 'C317ProbeSvc'
  virtual = Resolve-ServiceAccount 'Virtual' 'IDevelop'
  literal = Resolve-ServiceAccount 'NT SERVICE\\IDevelop' 'IDevelop'
  local = Resolve-ServiceAccount 'LocalSystem' 'IDevelop'
  blank = Resolve-ServiceAccount '' 'IDevelop'
  custom = Resolve-ServiceAccount 'NT AUTHORITY\\LocalService' 'IDevelop'
}
[Console]::Out.Write(($o | ConvertTo-Json -Depth 4 -Compress))`);
            const r = JSON.parse(out);
            const sc = (n) =>
                /SERVICE SID:\s*(S-1-5-80-[\d-]+)/.exec(
                    execFileSync('sc.exe', ['showsid', n], { encoding: 'utf8' })
                )[1];
            expect(r.sid).toBe(sc('IDevelop'));
            expect(r.sid2).toBe(sc('C317ProbeSvc'));
            expect(r.virtual).toEqual({
                Mode: 'Virtual',
                Account: 'NT SERVICE\\IDevelop',
                Sid: r.sid,
            });
            expect(r.literal.Mode).toBe('Virtual');
            expect(r.local).toEqual({ Mode: 'LocalSystem', Account: 'LocalSystem', Sid: null });
            expect(r.blank.Mode).toBe('LocalSystem');
            expect(r.custom).toEqual({
                Mode: 'Custom',
                Account: 'NT AUTHORITY\\LocalService',
                Sid: null,
            });
        },
        60000
    );

    describe('ACLs: uploads/data restricted; the virtual account granted, then revoked', () => {
        let base;
        let r;
        beforeAll(() => {
            if (!onWindows) return;
            base = fs.mkdtempSync(path.join(os.tmpdir(), 'c317-o-acl-'));
            const b = base.replace(/'/g, "''");
            r = JSON.parse(
                runPs(`${prelude(src, ACL)}
$root = Join-Path '${b}' 'pd'; $inst = Join-Path '${b}' 'inst'; $inst2 = Join-Path '${b}' 'inst2'
foreach ($d in @('backups', 'audit-anchors', 'tls')) { New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null }
foreach ($d in @('uploads', 'data')) { New-Item -ItemType Directory -Force -Path (Join-Path $inst $d) | Out-Null }
New-Item -ItemType Directory -Force -Path $inst2 | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path '${b}' 'solo') | Out-Null
& icacls.exe $root /grant '*S-1-5-32-545:(OI)(CI)RX' /Q | Out-Null
& icacls.exe $inst /grant '*S-1-5-32-545:(OI)(CI)RX' /Q | Out-Null
& icacls.exe $inst2 /grant '*S-1-5-32-545:(OI)(CI)RX' /Q | Out-Null
Set-Content -LiteralPath (Join-Path $inst 'uploads\\evidence.pdf') -Value 'pdf'
Set-Content -LiteralPath (Join-Path $inst 'data\\x.json') -Value '{}'
Set-Content -LiteralPath (Join-Path $inst '.env') -Value 'APP_KEY=x'
Set-Content -LiteralPath (Join-Path $inst2 '.env') -Value 'APP_KEY=y'
$svcSid = Get-ServiceSid 'C317ProbeSvc'
$before = AclOf (Join-Path $inst 'uploads\\evidence.pdf')

# Phase 1 - LocalSystem (the shipped default): uploads/ and data/ now restricted.
$script:ServiceAclSid = $null; $script:RevokeAclSids = @($svcSid)
$bad1 = Protect-AppDataAcls $root $inst
$p1 = [ordered]@{ bad = $bad1; uploads = AclOf (Join-Path $inst 'uploads'); upFile = AclOf (Join-Path $inst 'uploads\\evidence.pdf'); data = AclOf (Join-Path $inst 'data'); anchors = AclOf (Join-Path $root 'audit-anchors'); tls = AclOf (Join-Path $root 'tls'); solo = Protect-SensitivePath (Join-Path '${b}' 'solo') }

# Phase 2 - Virtual on a second tree: the SID is granted (M on dirs, R on .env, M on the install root).
$script:ServiceAclSid = $svcSid; $script:RevokeAclSids = @()
$bad2 = Protect-AppDataAcls (Join-Path '${b}' 'pd-absent') $inst2
$p2 = [ordered]@{ bad = $bad2; env = AclOf (Join-Path $inst2 '.env'); root = AclOf $inst2; again = Protect-SensitivePath (Join-Path $inst2 '.env') }
# ...and a target hardened BEFORE the switch (SYSTEM + Admins only) is NOT 'already restricted'.
$p2.staleTls = Protect-SensitivePath (Join-Path '${b}' 'solo')
$p2.tls = AclOf (Join-Path '${b}' 'solo')

# Phase 3 - back to LocalSystem: the virtual SID is removed again.
$script:ServiceAclSid = $null; $script:RevokeAclSids = @($svcSid)
$bad3 = Protect-AppDataAcls (Join-Path '${b}' 'pd-absent') $inst2
$p3 = [ordered]@{ bad = $bad3; env = AclOf (Join-Path $inst2 '.env'); root = AclOf $inst2; tls = Protect-SensitivePath (Join-Path '${b}' 'solo'); tlsAcl = AclOf (Join-Path '${b}' 'solo') }

$out = [ordered]@{ svcSid = $svcSid; before = $before; p1 = $p1; p2 = $p2; p3 = $p3; logs = @($script:logs) }
& icacls.exe '${b}' /grant "$($env:USERNAME):(OI)(CI)F" /T /C /Q *> $null
foreach ($f in @('inst\\.env', 'inst2\\.env', 'inst\\uploads', 'inst\\data', 'pd\\tls', 'pd\\audit-anchors', 'pd\\backups', 'pd')) { & icacls.exe (Join-Path '${b}' $f) /grant "$($env:USERNAME):(OI)(CI)F" /T /C /Q *> $null }
[Console]::Out.Write(($out | ConvertTo-Json -Depth 6 -Compress))`)
            );
        }, 130000);
        afterAll(() => {
            if (!base) return;
            try {
                const b = base.replace(/'/g, "''");
                runPs(`& icacls.exe '${b}' /grant "$($env:USERNAME):(OI)(CI)F" /T /C /Q *> $null
Get-ChildItem -LiteralPath '${b}' -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { & icacls.exe $_.FullName /grant "$($env:USERNAME):F" /C /Q *> $null }`);
            } catch {
                /* best effort */
            }
            fs.rmSync(base, { recursive: true, force: true });
        });

        wt('precondition: an uploaded file WAS readable by BUILTIN\\Users', () => {
            expect(r.before.sids).toContain(USERS);
        });

        wt(
            'default (LocalSystem): uploads/, data/, audit-anchors/, tls/ -> SYSTEM + Administrators only',
            () => {
                expect(r.p1.bad).toBe(0);
                for (const k of ['uploads', 'upFile', 'data', 'anchors', 'tls']) {
                    expect({ k, sids: r.p1[k].sids }).toEqual({ k, sids: [SYSTEM, ADMINS].sort() });
                }
                expect(r.p1.uploads.protected).toBe(true);
            }
        );

        wt(
            'Virtual: the service SID gets Read on .env, Modify on folders and on the install root',
            () => {
                const sid = r.svcSid;
                const READ = 1179785; // FileSystemRights.Read (+Synchronize)
                const MODIFY = 1245631; // FileSystemRights.Modify (+Synchronize)
                expect(r.p2.bad).toBe(0);
                expect(r.p2.env.sids).toEqual([SYSTEM, ADMINS, sid].sort());
                expect(r.p2.env.rights).toContain(`${sid}=${READ}`);
                expect(r.p2.root.rights).toContain(`${sid}=${MODIFY}`);
                expect(r.p2.again).toBe('already restricted');
                expect(r.p2.staleTls).toBe('restricted');
                expect(r.p2.tls.rights).toContain(`${sid}=${MODIFY}`);
            }
        );

        wt('switching back to LocalSystem removes every grant of the virtual account', () => {
            const sid = r.svcSid;
            expect(r.p3.bad).toBe(0);
            expect(r.p3.env.sids).toEqual([SYSTEM, ADMINS].sort());
            expect(r.p3.root.sids).not.toContain(sid);
            expect(r.p3.tls).toBe('restricted');
            expect(r.p3.tlsAcl.sids).toEqual([SYSTEM, ADMINS].sort());
        });
    });
});

describe('Install-IDevelop.ps1 — S-05 HTTPS .env wiring', () => {
    wt(
        'Resolve-HttpsConfig defaults; Update-EnvForHttps on/off round-trip',
        () => {
            const names = [
                'Resolve-HttpsConfig',
                'Get-EnvValue',
                'Set-EnvKeys',
                'Disable-EnvKeys',
                'Update-EnvForHttps',
            ];
            const out = runPs(`${prelude(INSTALL, names)}
$env0 = "NODE_ENV=production\`r\`nPORT=3000\`r\`nAPP_BASE_URL=http://box:3000\`r\`nDATABASE_URL=postgres://u:p@h/db\`r\`n"
$on = Update-EnvForHttps $env0 $true 'C:\\ProgramData\\IDevelop\\tls\\server.pfx' 'pp' 3443 'https://box.corp:3443' 'http://box:3000'
$on2 = Update-EnvForHttps $on $true 'C:\\ProgramData\\IDevelop\\tls\\server.pfx' 'pp' 3443 'https://box.corp:3443' 'http://box:3000'
$custom = Update-EnvForHttps ($env0 -replace 'http://box:3000', 'https://hr.corp.example') $true 'x.pfx' 'pp' 3443 'https://box.corp:3443' 'http://box:3000'
$off = Update-EnvForHttps $on $false '' '' 3443 'https://box.corp:3443' 'http://box:3000'
$offProxy = Update-EnvForHttps ($on + "TRUST_PROXY=1\`r\`n") $false '' '' 3443 'https://box.corp:3443' 'http://box:3000'
$never = Update-EnvForHttps $env0 $false '' '' 3443 'https://box.corp:3443' 'http://box:3000'
$o = [ordered]@{
  def = Resolve-HttpsConfig $null
  cfg = Resolve-HttpsConfig @{ Enabled = $true; Port = 8443; CertThumbprint = 'ab cd:EF'; SelfSigned = $false }
  bad = Resolve-HttpsConfig @{ Enabled = $true; Port = 'x' }
  on = $on; on2same = ($on2 -eq $on); custom = $custom; off = $off; offProxy = $offProxy; neverSame = ($never -eq $env0)
}
[Console]::Out.Write(($o | ConvertTo-Json -Depth 4 -Compress))`);
            const r = JSON.parse(out);
            expect(r.def).toEqual({
                Enabled: false,
                Port: 3443,
                CertThumbprint: '',
                SelfSigned: true,
            });
            expect(r.cfg).toEqual({
                Enabled: true,
                Port: 8443,
                CertThumbprint: 'ABCDEF',
                SelfSigned: false,
            });
            expect(r.bad.Port).toBe(3443);
            expect(r.on).toMatch(/^TLS_PFX_PATH=C:\\ProgramData\\IDevelop\\tls\\server\.pfx\r$/m);
            expect(r.on).toMatch(/^TLS_PFX_PASSPHRASE=pp\r$/m);
            expect(r.on).toMatch(/^HTTPS_PORT=3443\r$/m);
            expect(r.on).toMatch(/^COOKIE_SECURE=1\r$/m);
            expect(r.on).toMatch(/^APP_BASE_URL=https:\/\/box\.corp:3443\r$/m);
            expect(r.on).not.toMatch(/http:\/\/box:3000/);
            expect(r.on2same).toBe(true); // idempotent: no duplicated keys
            expect(r.custom).toMatch(/^APP_BASE_URL=https:\/\/hr\.corp\.example\r?$/m); // operator's https URL kept
            expect(r.off).toMatch(/^# \(HTTPS disabled in config\.psd1\) TLS_PFX_PATH=/m);
            expect(r.off).not.toMatch(/^TLS_PFX_PATH=/m);
            expect(r.off).not.toMatch(/^COOKIE_SECURE=1/m);
            expect(r.off).toMatch(/^APP_BASE_URL=http:\/\/box:3000\r$/m);
            expect(r.offProxy).toMatch(/^COOKIE_SECURE=1\r$/m); // behind a proxy it stays
            expect(r.neverSame).toBe(true); // never enabled -> .env untouched
        },
        60000
    );
});

describe('Manage-IDevelop.ps1 — -Restore re-applies GDPR erasures before the service starts', () => {
    wt(
        'exit 0 -> ok; exit 1 / 2 -> failed; no tombstones table -> skipped; script missing -> failed',
        () => {
            const base = fs.mkdtempSync(path.join(os.tmpdir(), 'c317-o-era-'));
            try {
                const mk = (name, code) => {
                    const d = path.join(base, name);
                    fs.mkdirSync(path.join(d, 'scripts'), { recursive: true });
                    fs.writeFileSync(
                        path.join(d, 'scripts', 'reapply-erasures.js'),
                        `console.log('[reapply-erasures] ran in ' + process.cwd()); process.exit(${code});\n`
                    );
                    return d.replace(/'/g, "''");
                };
                const ok = mk('ok', 0);
                const one = mk('one', 1);
                const two = mk('two', 2);
                const none = path.join(base, 'none').replace(/'/g, "''");
                fs.mkdirSync(path.join(base, 'none'));
                const node = process.execPath.replace(/'/g, "''");
                const out =
                    runPs(`${prelude(MANAGE, ['Invoke-ReapplyErasures', 'Get-ErasureRunbook'])}
$o = [ordered]@{
  ok = Invoke-ReapplyErasures -InstallDir '${ok}' -NodeExe '${node}' -HasTombstones '1'
  one = Invoke-ReapplyErasures -InstallDir '${one}' -NodeExe '${node}' -HasTombstones '1'
  two = Invoke-ReapplyErasures -InstallDir '${two}' -NodeExe '${node}' -HasTombstones '?'
  old = Invoke-ReapplyErasures -InstallDir '${ok}' -NodeExe '${node}' -HasTombstones '0'
  missing = Invoke-ReapplyErasures -InstallDir '${none}' -NodeExe '${node}' -HasTombstones '1'
  logs = @($script:logs)
}
[Console]::Out.Write(($o | ConvertTo-Json -Depth 4 -Compress))`);
                const r = JSON.parse(out);
                expect(r.ok.Status).toBe('ok');
                expect(r.one.Status).toBe('failed');
                expect(r.one.Message).toMatch(/exited 1[\s\S]*NOT started/);
                expect(r.two.Status).toBe('failed');
                expect(r.old.Status).toBe('skipped');
                expect(r.missing.Status).toBe('failed');
                // Ran FROM the install dir (it reads .env there) and its output is logged.
                expect(r.logs.join('\n')).toMatch(/\[reapply-erasures\] ran in .*[\\/]ok/);
            } finally {
                fs.rmSync(base, { recursive: true, force: true });
            }
        },
        60000
    );

    test('Invoke-Restore dies on a failed re-application, before the pre-flight and the service start', () => {
        const src = fs.readFileSync(MANAGE, 'utf8');
        const body = src.slice(
            src.indexOf('function Invoke-Restore'),
            src.indexOf('# Delete from <InstallDir>')
        );
        const era = body.indexOf('Invoke-ReapplyErasures');
        expect(era).toBeGreaterThan(body.indexOf('Importing database.sql'));
        expect(era).toBeLessThan(body.indexOf('migrate-preflight.js'));
        expect(era).toBeLessThan(body.indexOf('Start-Service'));
        expect(body).toMatch(/if \(\$era\.Status -eq 'failed'\) \{ Die \$era\.Message \}/);
    });
});

describe('config.psd1 — shipped defaults', () => {
    test('LocalSystem, HTTPS off, audit separation off; NO credential ships in the public config', () => {
        const cfg = fs.readFileSync(CONFIG, 'utf8');
        expect(cfg).toMatch(/^\s*ServiceAccount\s*=\s*'LocalSystem'/m);
        expect(cfg).toMatch(
            /Https\s*=\s*@\{[\s\S]*?Enabled\s*=\s*\$false[\s\S]*?Port\s*=\s*3443[\s\S]*?CertThumbprint\s*=\s*''[\s\S]*?SelfSigned\s*=\s*\$true/
        );
        expect(cfg).toMatch(/^\s*AuditOwnerSeparation\s*=\s*\$false/m);
        // A public repository must never carry a working credential: both
        // appliance-wide passwords ship blank (the installer then generates or
        // asks for them).
        expect(cfg).toMatch(/^\s*StandardPgSuperPassword\s*=\s*''/m);
        expect(cfg).toMatch(/^\s*StandardAdminPassword\s*=\s*''/m);
    });
});
