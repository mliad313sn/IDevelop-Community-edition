'use strict';
/**
 * 3.23.17 lane D — installer side of S-01 (data-at-rest ACLs) and S-05
 * (firewall profile). The PowerShell helpers are EXTRACTED from the shipped
 * scripts with the PowerShell parser (not a regex) and RUN against a temp tree
 * that mimics %ProgramData%\IDevelop (BUILTIN\Users inherited RX + WD/AD) and
 * the install dir (.env).
 *
 * Not elevated: the test user stays the OWNER of what it creates, so it keeps
 * READ_CONTROL/WRITE_DAC and can read the resulting ACL back and clean up. What
 * this cannot prove without elevation: that LocalSystem (the service) keeps
 * read/write - asserted instead by the presence of the S-1-5-18:F ACE.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const onWindows = process.platform === 'win32';
const INSTALL = path.join(__dirname, '..', '..', 'installer', 'Install-IDevelop.ps1');
const MANAGE = path.join(__dirname, '..', '..', 'installer', 'Manage-IDevelop.ps1');

function runPs(script) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c317-ps-'));
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

/** PowerShell prelude: load the named functions (and the SID list) from `src`. */
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
if (-not $sidLine) { throw 'HardenedAclSids assignment not found' }
Invoke-Expression $sidLine
$script:logs = New-Object System.Collections.Generic.List[string]
function Log($m, $l = 'INFO') { [void]$script:logs.Add("[$l] $m") }
function SidsOf($p) {
    # GetNamedSecurityInfo, not Get-Acl: Get-Acl enumerates the PARENT folder, which
    # a non-elevated owner can no longer list once it is hardened.
    $a = New-Object System.Security.AccessControl.FileSecurity($p, [System.Security.AccessControl.AccessControlSections]::Access)
    [pscustomobject]@{ protected = $a.AreAccessRulesProtected; sids = @($a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique) }
}
`;
}

const ACL_NAMES = ['Test-AclHardened', 'Protect-SensitivePath', 'Protect-AppDataAcls'];

function aclProbe(src, base) {
    const b = base.replace(/'/g, "''");
    return runPs(`${prelude(src, ACL_NAMES)}
$root = Join-Path '${b}' 'pd'; $inst = Join-Path '${b}' 'inst'
foreach ($d in @('backups', 'app-backups\\app-1', 'logs', 'restore-points\\rp-1')) { New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null }
New-Item -ItemType Directory -Force -Path (Join-Path $inst 'logs') | Out-Null
# Mimic %ProgramData%: BUILTIN\\Users inherits read + create (the audit's finding).
& icacls.exe $root /grant '*S-1-5-32-545:(OI)(CI)RX' '*S-1-5-32-545:(CI)(WD,AD)' /Q | Out-Null
& icacls.exe $inst /grant '*S-1-5-32-545:(OI)(CI)RX' /Q | Out-Null
Set-Content -LiteralPath (Join-Path $root 'backups\\db-2026.dump') -Value 'dump'
Set-Content -LiteralPath (Join-Path $root 'app-backups\\app-1\\.env') -Value 'APP_KEY=x'
Set-Content -LiteralPath (Join-Path $root 'restore-points\\rp-1\\database.sql') -Value 'sql'
Set-Content -LiteralPath (Join-Path $root 'install-1.log') -Value 'log'
Set-Content -LiteralPath (Join-Path $inst '.env') -Value 'DATABASE_URL=postgres://u:p@h/db'
# An EXPLICIT Users grant deep in a tree (what a copy WITH security could carry).
& icacls.exe (Join-Path $root 'app-backups\\app-1\\.env') /grant '*S-1-5-32-545:R' /Q | Out-Null
$before = SidsOf (Join-Path $root 'backups\\db-2026.dump')
$bad = Protect-AppDataAcls $root $inst
$out = [ordered]@{
    before = $before
    bad = $bad
    dump = SidsOf (Join-Path $root 'backups\\db-2026.dump')
    envCopy = SidsOf (Join-Path $root 'app-backups\\app-1\\.env')
    rpSql = SidsOf (Join-Path $root 'restore-points\\rp-1\\database.sql')
    rootLog = SidsOf (Join-Path $root 'install-1.log')
    root = SidsOf $root
    env = SidsOf (Join-Path $inst '.env')
    again = @((Protect-SensitivePath $root), (Protect-SensitivePath (Join-Path $inst '.env')))
    absent = Protect-SensitivePath (Join-Path $inst 'nope')
    logs = @($script:logs)
}
# Hand the tree back to the (owner) test user so it can be deleted.
& icacls.exe $root /grant "$($env:USERNAME):(OI)(CI)F" /T /C /Q | Out-Null
& icacls.exe (Join-Path $inst '.env') /grant "$($env:USERNAME):F" /C /Q | Out-Null
[Console]::Out.Write(($out | ConvertTo-Json -Depth 5 -Compress))
`);
}

const USERS = 'S-1-5-32-545';
const SYSTEM = 'S-1-5-18';
const ADMINS = 'S-1-5-32-544';

describe.each([
    ['Install-IDevelop.ps1', INSTALL],
    ['Manage-IDevelop.ps1', MANAGE],
])('%s — Protect-AppDataAcls on a ProgramData-like tree', (_label, src) => {
    let base;
    let r;
    beforeAll(() => {
        if (!onWindows) return;
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'c317-acl-'));
        r = JSON.parse(aclProbe(src, base));
    }, 130000);
    afterAll(() => {
        if (!base) return;
        // Even if the probe died half-way: we are the OWNER, so re-grant then delete.
        try {
            const b = base.replace(/'/g, "''");
            runPs(`Get-ChildItem -LiteralPath '${b}' -Recurse -Force -ErrorAction SilentlyContinue | Out-Null
& icacls.exe '${b}' /grant "$($env:USERNAME):(OI)(CI)F" /T /C /Q *> $null
foreach ($f in @('pd\\app-backups\\app-1\\.env', 'inst\\.env')) { & icacls.exe (Join-Path '${b}' $f) /grant "$($env:USERNAME):F" /C /Q *> $null }
& icacls.exe '${b}' /grant "$($env:USERNAME):(OI)(CI)F" /T /C /Q *> $null`);
        } catch {
            /* best effort */
        }
        fs.rmSync(base, { recursive: true, force: true });
    });

    (onWindows ? test : test.skip)(
        'precondition: the dump WAS readable by BUILTIN\\Users (inherited)',
        () => {
            expect(r.before.sids).toContain(USERS);
            expect(r.before.protected).toBe(false);
        }
    );

    (onWindows ? test : test.skip)(
        'every sensitive file ends with SYSTEM + Administrators only',
        () => {
            expect(r.bad).toBe(0);
            for (const k of ['dump', 'envCopy', 'rpSql', 'rootLog', 'root', 'env']) {
                expect({ k, sids: r[k].sids }).toEqual({ k, sids: [SYSTEM, ADMINS].sort() });
            }
        }
    );

    (onWindows ? test : test.skip)(
        'the root and the install .env are protected from re-inheriting',
        () => {
            expect(r.root.protected).toBe(true);
            expect(r.env.protected).toBe(true);
        }
    );

    (onWindows ? test : test.skip)(
        'idempotent: a second run leaves restricted targets alone; absent paths are skipped',
        () => {
            expect(r.again).toEqual(['already restricted', 'already restricted']);
            expect(r.absent).toBe('absent');
            expect(r.logs.join('\n')).toMatch(/ACL hardening: .*\.env -> restricted/);
            expect(r.logs.join('\n')).not.toMatch(/\[WARN\]/);
        }
    );
});

describe('Install-IDevelop.ps1 — Resolve-FirewallProfiles (S-05)', () => {
    (onWindows ? test : test.skip)(
        'Domain+Private by default; Public added only when an active network is Public',
        () => {
            const out = runPs(`${prelude(INSTALL, [...ACL_NAMES, 'Resolve-FirewallProfiles'])}
$cases = [ordered]@{
    defaultPrivateNet = Resolve-FirewallProfiles @('Domain', 'Private') @('Private')
    defaultDomainNet  = Resolve-FirewallProfiles @('Domain', 'Private') @('DomainAuthenticated')
    publicNet         = Resolve-FirewallProfiles @('Domain', 'Private') @('Private', 'Public')
    unset             = Resolve-FirewallProfiles $null @()
    csvString         = Resolve-FirewallProfiles 'Private, Domain' @()
    junkOnly          = Resolve-FirewallProfiles @('Bogus') @()
    anyKeyword        = Resolve-FirewallProfiles 'Any' @()
    alreadyPublic     = Resolve-FirewallProfiles @('Domain', 'Private', 'Public') @('Public')
}
[Console]::Out.Write(($cases | ConvertTo-Json -Depth 4 -Compress))
`);
            const c = JSON.parse(out);
            const p = (x) => [].concat(x.Profiles).sort();
            expect(p(c.defaultPrivateNet)).toEqual(['Domain', 'Private']);
            expect(c.defaultPrivateNet.PublicAdded).toBe(false);
            expect(p(c.defaultDomainNet)).toEqual(['Domain', 'Private']);
            expect(p(c.publicNet)).toEqual(['Domain', 'Private', 'Public']);
            expect(c.publicNet.PublicAdded).toBe(true);
            expect(p(c.unset)).toEqual(['Domain', 'Private']);
            expect(p(c.csvString)).toEqual(['Domain', 'Private']);
            expect(p(c.junkOnly)).toEqual(['Domain', 'Private']);
            expect(p(c.anyKeyword)).toEqual(['Domain', 'Private', 'Public']);
            expect(c.alreadyPublic.PublicAdded).toBe(false);
        },
        70000
    );

    test('config.psd1 ships FirewallProfiles = Domain, Private', () => {
        const cfg = fs.readFileSync(
            path.join(__dirname, '..', '..', 'installer', 'config.psd1'),
            'utf8'
        );
        expect(cfg).toMatch(/^\s*FirewallProfiles\s*=\s*@\('Domain',\s*'Private'\)/m);
    });
});
