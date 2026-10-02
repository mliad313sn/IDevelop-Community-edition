'use strict';
/**
 * Windows installer hardening:
 *   - every downloaded artefact is pinned by SHA-256 (and Authenticode publisher
 *     when signed); a pre-placed file is reused only when it matches; PG 17.11;
 *   - the pg_hba.conf 'trust' window is never opened silently, is narrowed to
 *     database/user postgres, and every use goes to a ledger;
 *   - SQL carrying a password goes through psql's stdin, never argv;
 *   - read-only warnings for pg_hba 'trust' lines and an unsynchronised clock;
 *   - owned firewall rules carry a Group, stale / duplicate ones are removed;
 *   - the service log folder is restricted before the first write;
 *   - Build-Package: CI secret-scan config and .dockerignore never ship, the root
 *     is an allow-list (every entry of THIS repository is classified), uploads\
 *     ships empty, and an -IncludeData dump fails on any secret-table row.
 *
 * Static checks run everywhere. The pure PowerShell helpers are EXTRACTED with
 * the PowerShell parser and run when a PowerShell is available (Windows CI).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const INSTALLER = path.join(ROOT, 'installer');
const read = (f) => fs.readFileSync(path.join(INSTALLER, f), 'utf8').replace(/\r\n/g, '\n');
const code = (f) => read(f).replace(/^\s*#[^\n]*/gm, '');
const INSTALL = read('Install-IDevelop.ps1');
const MANAGE = read('Manage-IDevelop.ps1');
const BUILD = read('Build-Package.ps1');
const CONFIG = read('config.psd1');

const cfgValue = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*'([^']*)'`, 'm').exec(CONFIG);
    return m ? m[1] : null;
};

describe('download integrity (config.psd1 pins)', () => {
    test.each([
        ['WinSwUrl', 'WinSwSha256', 'WinSwPublisher', ''],
        ['VcRedistUrl', 'VcRedistSha256', 'VcRedistPublisher', 'Microsoft Corporation'],
        ['NodeMsiUrl', 'NodeMsiSha256', 'NodeMsiPublisher', 'OpenJS Foundation'],
        ['PgInstallerUrl', 'PgInstallerSha256', 'PgInstallerPublisher', 'EnterpriseDB Corporation'],
    ])('%s is pinned', (url, sha, pub, publisher) => {
        expect(cfgValue(url)).toMatch(/^https:\/\//);
        expect(cfgValue(sha)).toMatch(/^[0-9a-f]{64}$/);
        expect(cfgValue(pub)).toBe(publisher);
        // the installer passes the pin with the URL
        const call = new RegExp(`Get-File \\$cfg\\.${url} \\$\\w+ \\$cfg\\.${sha} \\$cfg\\.${pub}`);
        expect(INSTALL).toMatch(call);
    });

    test('PostgreSQL 17.11; the VC++ URL is versioned and carries its own hash', () => {
        expect(cfgValue('PgInstallerUrl')).toMatch(/postgresql-17\.11-\d+-windows-x64\.exe$/);
        const vc = cfgValue('VcRedistUrl');
        expect(vc).not.toMatch(/aka\.ms/);
        expect(vc.toLowerCase()).toContain(cfgValue('VcRedistSha256'));
        expect(cfgValue('NodeMsiUrl')).toContain(`v${cfgValue('NodeVersion')}`);
    });

    test('a missing pin, a hash mismatch or a bad signature refuses the file', () => {
        const fn = INSTALL.slice(
            INSTALL.indexOf('function Test-DownloadedArtifact'),
            INSTALL.indexOf('function Get-File')
        );
        expect(fn).toMatch(/no pinned SHA-256/);
        expect(fn).toMatch(/Get-FileHash -LiteralPath \$Path -Algorithm SHA256/);
        expect(fn).toMatch(/Get-AuthenticodeSignature/);
        expect(fn).toMatch(/\$sig\.Status\)" -ne 'Valid'/);
        const get = INSTALL.slice(INSTALL.indexOf('function Get-File'));
        expect(get).toMatch(/INTEGRITY CHECK FAILED/);
        expect(get).not.toMatch(/Length -gt 1MB/); // size alone no longer admits a pre-placed file
        // the bundled WinSW is held to the same pin
        expect(INSTALL).toMatch(
            /Test-DownloadedArtifact \$bundled \$cfg\.WinSwSha256 \$cfg\.WinSwPublisher/
        );
    });
});

describe('the pg_hba.conf trust window', () => {
    test.each([
        ['Install-IDevelop.ps1', INSTALL],
        ['Manage-IDevelop.ps1', MANAGE],
    ])('%s: consent, narrowed lines, ledger', (f, src) => {
        expect(src).toMatch(/\[switch\]\$AllowPasswordRecovery/);
        expect(src).toMatch(/function Resolve-TrustWindowConsent/);
        expect(src).toMatch(/\$ans -ceq 'TRUST'/);
        expect(src).toMatch(/'pg-trust-window\.log'/);
        expect(src).not.toMatch(/host all all 127\.0\.0\.1\/32 trust/);
        expect(src).toMatch(/host postgres postgres 127\.0\.0\.1\/32 trust/);
        expect(src).toMatch(/Write-TrustWindowAudit 'OPENED'/);
        expect(src).toMatch(/Write-TrustWindowAudit 'CLOSED'/);
        expect(src).toMatch(/'unattended'\s*\{/);
    });

    test('an unattended install fails with the reason instead of opening it', () => {
        const block = INSTALL.slice(INSTALL.indexOf('if ($armReset -and -not $trustConsented)'));
        expect(block).toMatch(/'unattended'\s*\{[\s\S]*?Fail \(/);
        expect(block).toMatch(/\$armReset = \$consent\.Granted/);
    });
});

describe('passwords never travel on a command line', () => {
    test.each(fs.readdirSync(INSTALLER).filter((f) => f.endsWith('.ps1')))('%s', (f) => {
        const src = code(f);
        // -c "<sql with PASSWORD '...'>" on a psql command line
        expect(src).not.toMatch(/-c\s+"[^"\n]*PASSWORD '/);
        expect(src).not.toMatch(/Psql '[^']+' "[^"\n]*PASSWORD '/);
    });
    test('the role passwords go through PsqlSecret / Invoke-PsqlStdin', () => {
        expect(INSTALL).toMatch(/PsqlSecret 'postgres' "ALTER ROLE postgres WITH PASSWORD/);
        expect(INSTALL).toMatch(
            /PsqlSecret 'postgres' "CREATE ROLE ""\$\(\$cfg\.DbUser\)"" LOGIN PASSWORD/
        );
        expect(INSTALL).toMatch(
            /PsqlSecret 'postgres' "ALTER ROLE ""\$\(\$cfg\.DbUser\)"" LOGIN PASSWORD/
        );
        expect(MANAGE).toMatch(/Invoke-PsqlStdin \$psql @\([^\n]*'-f', '-'\) "ALTER ROLE postgres/);
        for (const src of [INSTALL, MANAGE])
            expect(src).toMatch(/UTF8Encoding\(\$false\)\)\.GetBytes\(\$Sql/);
    });
});

describe('read-only warnings, firewall, service logs', () => {
    test('pg_hba trust lines and the clock are reported by Setup and -CheckDb', () => {
        for (const src of [INSTALL, MANAGE]) {
            expect(src).toMatch(/function Get-PgHbaTrustLines/);
            expect(src).toMatch(/function ConvertFrom-W32tmStatus/);
            expect(src).toMatch(/pg_hba_file_rules WHERE auth_method = 'trust'/);
        }
        // W32Time is changed only after a typed Y, never on a Patch
        expect(INSTALL).toMatch(/if \(-not \$Patch -and \(Test-InteractiveSession\)\)/);
        expect(INSTALL).toMatch(
            /if \("\$ans"\.Trim\(\) -eq 'Y'\)\s*\{\s*try \{\s*Set-Service -Name 'W32Time'/
        );
    });

    test('owned firewall rules are tagged with the IDevelop group and reconciled', () => {
        expect(INSTALL).toMatch(/\$script:FirewallGroup = 'IDevelop'/);
        const news = INSTALL.match(/New-NetFirewallRule [^\n]*/g) || [];
        expect(news.length).toBeGreaterThanOrEqual(2);
        for (const n of news) expect(n).toMatch(/-Group \$script:FirewallGroup/);
        expect(INSTALL).toMatch(/Get-FirewallRulePlan \$fwOwned \$fwWanted \$script:FirewallGroup/);
        expect(read('Uninstall-IDevelop.ps1')).toMatch(/Get-NetFirewallRule -Group 'IDevelop'/);
    });

    test('the service log folder is restricted before the wrapper writes', () => {
        for (const src of [INSTALL, MANAGE])
            expect(src).toMatch(/@\('logs', 'backups', 'uploads', 'data', 'service'\)/);
        const reg = INSTALL.slice(INSTALL.indexOf('function Register-WindowsService'));
        expect(reg.indexOf('Protect-SensitivePath $svcDir')).toBeGreaterThan(-1);
        expect(reg.indexOf('Protect-SensitivePath $svcDir')).toBeLessThan(
            reg.indexOf('$svcExe = Join-Path $svcDir')
        );
    });
});

describe('Build-Package.ps1', () => {
    const list = (name) => {
        const m = new RegExp(`\\$${name}\\s*=\\s*@\\(([\\s\\S]*?)\\)\\s*\\n`).exec(BUILD);
        expect(m).not.toBeNull();
        return [...m[1].replace(/#[^\n]*/g, '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
    };

    test('the CI secret-scan config, the container ignore file and a worktree .git never ship', () => {
        const ex = list('excludeFiles');
        for (const f of ['.gitleaks.toml', '.dockerignore', '.git']) expect(ex).toContain(f);
    });

    test('every entry at the root of this repository is classified (the build would not fail on it)', () => {
        const shipFiles = list('shipRootFiles');
        const shipDirs = list('shipRootDirs');
        const exFiles = list('excludeFiles');
        const exDirs = list('excludeDirs');
        // entries a working copy may hold that the repository does not track
        const local = new Set([
            'node_modules',
            'logs',
            'tmp',
            '.env',
            'coverage',
            'dist',
            'uploads',
        ]);
        const stray = fs
            .readdirSync(ROOT, { withFileTypes: true })
            .filter((d) => !local.has(d.name))
            .filter((d) =>
                d.isDirectory()
                    ? !shipDirs.includes(d.name) && !exDirs.includes(d.name)
                    : !shipFiles.includes(d.name) && !exFiles.includes(d.name)
            )
            .map((d) => d.name);
        expect(stray).toEqual([]);
        for (const f of ['LICENSE', 'NOTICE', 'server.js', 'package.json'])
            expect(shipFiles).toContain(f);
        expect(BUILD).toMatch(/Refusing to package: unexpected root-level entr/);
        expect(BUILD).toMatch(/uploads\\ holds/);
    });

    test('the -IncludeData dump excludes secret data and is read back for secret rows', () => {
        const pats = list('script:SecretTablePatterns');
        for (const t of [
            'session',
            'mfa_*',
            'api_keys',
            'user_identities',
            'hris_connectors',
            'lms_integrations',
        ])
            expect(pats).toContain(t);
        expect(BUILD).toMatch(/\$violations = Get-SecretRowViolations \$rowCounts/);
        expect(BUILD).toMatch(/Refusing to package: the data snapshot carries secret rows/);
        expect(BUILD).toMatch(/@\(@\(\$runtimeOnly\) \+ @\(\$secretData\)/);
    });
});

test('ESLint warns on non-literal fs paths in the product code', () => {
    const raw = fs.readFileSync(path.join(ROOT, '.eslintrc.json'), 'utf8');
    const rules = raw.slice(raw.indexOf('"rules"'), raw.indexOf('"overrides"'));
    expect(rules).toMatch(/"security\/detect-non-literal-fs-filename":\s*"warn"/);
});

// ---------------------------------------------------------------------------
// Behaviour of the pure helpers, when a PowerShell is available.
// ---------------------------------------------------------------------------
function findPowerShell() {
    for (const exe of process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh']) {
        try {
            execFileSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
                stdio: 'ignore',
                timeout: 30000,
            });
            return exe;
        } catch (_) {
            /* not this one */
        }
    }
    return null;
}
const PS = findPowerShell();
const psSuite = PS ? describe : describe.skip;

function runHelpers(file, names, body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-helpers-'));
    const ps1 = path.join(dir, 'probe.ps1');
    const src = path.join(INSTALLER, file).replace(/'/g, "''");
    fs.writeFileSync(
        ps1,
        `$ErrorActionPreference = 'Stop'
$tk = $null; $er = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${src}', [ref]$tk, [ref]$er)
if ($er.Count) { throw "parse errors: $($er.Count)" }
$names = @(${names.map((n) => `'${n}'`).join(',')})
$defs = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $n.Name }, $true)
foreach ($d in $defs) { . ([scriptblock]::Create($d.Extent.Text)) }
${body}`
    );
    try {
        return JSON.parse(
            execFileSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
                encoding: 'utf8',
                timeout: 120000,
            })
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

psSuite('PowerShell helpers (behaviour)', () => {
    jest.setTimeout(120000);

    test('trust lines, clock status, consent and the firewall plan', () => {
        const r = runHelpers(
            'Install-IDevelop.ps1',
            [
                'Get-PgHbaTrustLines',
                'ConvertFrom-W32tmStatus',
                'Resolve-TrustWindowConsent',
                'Get-FirewallRulePlan',
                'Format-NativeArg',
            ],
            `$hba = @"
# comment trust
local all postgres trust
host all all 127.0.0.1/32 scram-sha-256
host all all 10.0.0.0 255.0.0.0 trust
# IDevelop installer - TEMPORARY trust (auto-removed)
host postgres postgres 127.0.0.1/32 trust
# end temporary
"@
$trust = Get-PgHbaTrustLines $hba
$ok = ConvertFrom-W32tmStatus @('Leap Indicator: 0', 'Source: time.windows.com,0x9') 'Running' 'Automatic'
$cmos = ConvertFrom-W32tmStatus @('Source: Local CMOS Clock') 'Running' 'Manual'
$c1 = Resolve-TrustWindowConsent $true $false { 'x' }
$c2 = Resolve-TrustWindowConsent $false $false { 'TRUST' }
$c3 = Resolve-TrustWindowConsent $false $true { 'TRUST' }
$c4 = Resolve-TrustWindowConsent $false $true { 'trust' }
$rules = @(
  [pscustomobject]@{ Name = 'a'; DisplayName = 'IDevelop (3000)'; Group = 'IDevelop' },
  [pscustomobject]@{ Name = 'b'; DisplayName = 'IDevelop (3000)'; Group = 'IDevelop' },
  [pscustomobject]@{ Name = 'c'; DisplayName = 'IDevelop (3001)'; Group = '' },
  [pscustomobject]@{ Name = 'd'; DisplayName = 'IDevelop HTTPS (3443)'; Group = '' })
$plan = Get-FirewallRulePlan $rules @('IDevelop (3000)', 'IDevelop HTTPS (3443)') 'IDevelop'
[Console]::Out.Write((@{
  trust = @($trust | ForEach-Object { $_.Line });
  ok = $ok.Ok; cmos = $cmos.Ok;
  consent = @($c1.Mode, $c2.Mode, $c3.Mode, $c4.Mode);
  removed = @($plan.Remove | ForEach-Object { $_.Name });
  kept = @($plan.Keep | ForEach-Object { $_.Name });
  arg = Format-NativeArg 'a b"c'
} | ConvertTo-Json -Compress))`
        );
        expect(r.trust).toEqual([2, 4]);
        expect(r.ok).toBe(true);
        expect(r.cmos).toBe(false);
        expect(r.consent).toEqual(['switch', 'unattended', 'interactive', 'declined']);
        expect(r.removed.sort()).toEqual(['b', 'c', 'd']);
        expect(r.kept).toEqual(['a']);
        expect(r.arg).toBe('"a b\\"c"');
    });

    test('the secret-row guard reads the dump', () => {
        const dump = path.join(os.tmpdir(), `dump-${process.pid}.sql`);
        fs.writeFileSync(
            dump,
            [
                'COPY public.skills (id, name) FROM stdin;',
                '1\tWelding',
                '\\.',
                'COPY public.api_keys (id) FROM stdin;',
                '1',
                '\\.',
                'COPY public.session (sid) FROM stdin;',
                '\\.',
            ].join('\n')
        );
        try {
            const r = runHelpers(
                'Build-Package.ps1',
                ['Test-TableLike', 'Get-DumpTableRowCounts', 'Get-SecretRowViolations'],
                `$script:SecretTablePatterns = @('session', 'api_keys', 'mfa_*')
$c = Get-DumpTableRowCounts '${dump.replace(/'/g, "''")}'
$v = Get-SecretRowViolations $c
[Console]::Out.Write((@{ skills = $c['skills']; session = $c['session']; v = @($v) } | ConvertTo-Json -Compress))`
            );
            expect(r.skills).toBe(1);
            expect(r.session).toBe(0);
            expect(r.v).toEqual(['api_keys (1 rows): secret/runtime table - never shipped']);
        } finally {
            fs.rmSync(dump, { force: true });
        }
    });
});
