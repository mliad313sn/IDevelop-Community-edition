'use strict';
/**
 * Windows installer: recommended PostgreSQL hardening (-ApplyPgHardening).
 *
 * log_connections / log_disconnections, a log_line_prefix naming user,
 * database and client, CONNECT on the application database for the app role
 * only, and listen_addresses = 'localhost' only when PgHost is a loopback
 * address. Applied automatically on a server Setup created (marker
 * %ProgramData%\IDevelop\pg-created-by-installer.json, trusted only when an
 * administrator or SYSTEM owns it); anywhere else reported, asked at the
 * console, or applied with -ApplyPgHardening. Every run writes a report.
 *
 * Static checks run everywhere; on Windows the functions are EXTRACTED with the
 * PowerShell parser and RUN.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const onWindows = process.platform === 'win32';
const wt = onWindows ? test : test.skip;
const ROOT = path.join(__dirname, '..', '..');
const INSTALL = path.join(ROOT, 'installer', 'Install-IDevelop.ps1');
const INST = fs.readFileSync(INSTALL, 'utf8').replace(/\r\n/g, '\n');
const q = (s) => s.replace(/'/g, "''");

function runPs(script) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-pgh-'));
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

describe('PostgreSQL hardening (static)', () => {
    test('the switch exists and is documented', () => {
        expect(INST).toMatch(/\[switch\]\$ApplyPgHardening\b/);
        expect(INST).toMatch(/\.PARAMETER ApplyPgHardening\b/);
    });

    test('consent: created by us, or the switch, or a console answer; never silent elsewhere', () => {
        const m = /function Resolve-PgHardeningConsent[\s\S]*?\n\}/.exec(INST)[0];
        expect(m).toMatch(
            /if \(\$CreatedByUs\) \{ return \[pscustomobject\]@\{ Granted = \$true; Mode = 'created' \} \}/
        );
        expect(m).toMatch(
            /if \(-not \$CanAsk\) \{ return \[pscustomobject\]@\{ Granted = \$false; Mode = 'unattended' \} \}/
        );
        expect(INST).toMatch(
            /Resolve-PgHardeningConsent \$script:PgCreatedByUs \$ApplyPgHardening\.IsPresent \(Test-CanAsk\)/
        );
    });

    test('the marker is written only by the installer that created the server, and is ACL-closed', () => {
        expect(INST).toMatch(
            /\$script:PgMarkerFile = Join-Path \$LogDir 'pg-created-by-installer\.json'/
        );
        const write = INST.indexOf("createdBy = 'IDevelop installer'");
        const installed = INST.indexOf("Log 'PostgreSQL installed.' 'OK'");
        expect(write).toBeGreaterThan(installed);
        const block = INST.slice(write, write + 1000);
        expect(block).toMatch(
            /icacls\.exe \$script:PgMarkerFile \/inheritance:r \/grant:r '\*S-1-5-18:F' '\*S-1-5-32-544:F'/
        );
        // Owned by Administrators explicitly (a Windows client gives the file to
        // the creating user by default).
        expect(block).toMatch(/icacls\.exe \$script:PgMarkerFile \/setowner '\*S-1-5-32-544'/);
        // Trusted only when an administrator or SYSTEM owns it (the service may
        // write in %ProgramData%\IDevelop and must not forge it).
        const t = /function Test-PgMarkerTrusted[\s\S]*?\n\}/.exec(INST)[0];
        expect(t).toMatch(/\$own -notin @\('S-1-5-18', 'S-1-5-32-544'\)/);
    });

    test('pg_hba.conf is never changed by the hardening; listen_addresses only for a loopback PgHost', () => {
        const plan = /function Get-PgHardeningPlan[\s\S]*?\n\}/.exec(INST)[0];
        expect(plan).not.toMatch(/hba/i);
        expect(plan).toMatch(/if \(\$CoLocated\) \{/);
        expect(INST).toMatch(/\$coLocated = Test-LoopbackHost \$cfg\.PgHost/);
        // Only a server we created is restarted by Setup.
        expect(INST).toMatch(
            /if \(\$script:PgCreatedByUs -and \$pgSvc\) \{\s+try \{\s+Restart-Service -Name \$pgSvc\.Name/
        );
    });

    test('the statements go through psql stdin, never on a command line', () => {
        expect(INST).toMatch(
            /\$runSql = \{ param\(\$sql\) Invoke-PsqlStdin \$psql @\(.*'-f', '-'\) \$sql \}/
        );
    });

    test('the report and the summary line are written on every run', () => {
        expect(INST).toMatch(/\$pgReport = Get-PgHardeningReport \$pgItems \$script:PgHbaTrust/);
        expect(INST).toMatch(/\$sum \+= "PG hardening {2}: \$\(\$script:PgHardeningSummary\)"/);
    });
});

describe('PostgreSQL hardening: plan, consent, apply, report (Windows)', () => {
    const NAMES = [
        'Test-LoopbackHost',
        'Test-YesAnswer',
        'Get-PgHardeningPlan',
        'Resolve-PgHardeningConsent',
        'Invoke-PgHardening',
        'Get-PgHardeningReport',
    ];
    let r;
    beforeAll(() => {
        if (!onWindows) return;
        r = json(
            runPs(`${prelude(INSTALL, NAMES)}
$weak = @{ log_connections = 'off'; log_disconnections = 'off'; log_line_prefix = '%m [%p] '; listen_addresses = '*' }
$good = @{ log_connections = 'on'; log_disconnections = 'on'; log_line_prefix = '%m [%p] user=%u,db=%d,client=%h '; listen_addresses = 'localhost' }
$sqls = New-Object System.Collections.Generic.List[string]
$runOk = { param($s) $sqls.Add($s); [pscustomobject]@{ Code = 0; Out = '' } }
$runAlterFails = { param($s) $sqls.Add($s); if ($s -like 'ALTER SYSTEM*') { [pscustomobject]@{ Code = 1; Out = 'ERROR: must be superuser' } } else { [pscustomobject]@{ Code = 0; Out = '' } } }

$coloc = Get-PgHardeningPlan $weak $true $true 'idevelop' 'idevelop_app'
$applied = Invoke-PgHardening $coloc $true $runOk
$appliedSql = @($sqls); $sqls.Clear()
$remote = Get-PgHardeningPlan $weak $true $false 'idevelop' 'idevelop_app'
$todo = Invoke-PgHardening $remote $false $runOk
$todoSql = @($sqls); $sqls.Clear()
$managed = Invoke-PgHardening (Get-PgHardeningPlan $weak $true $false 'we"ird' 'idevelop_app') $true $runAlterFails
$managedSql = @($sqls); $sqls.Clear()
$clean = Invoke-PgHardening (Get-PgHardeningPlan $good $false $true 'idevelop' 'idevelop_app') $true $runOk
$cleanSql = @($sqls)
$asked = 0
$o = [ordered]@{
  loop = @('localhost', '127.0.0.1', '127.3.2.1', '::1', '[::1]', 'LOCALHOST', 'db01', '10.0.0.5', $env:COMPUTERNAME, '0.0.0.0', '') | ForEach-Object { [bool](Test-LoopbackHost $_) }
  applied = @($applied | ForEach-Object { "$($_.Key)=$($_.Status)" })
  appliedSql = $appliedSql
  todo = @($todo | ForEach-Object { "$($_.Key)=$($_.Status)" })
  todoSql = $todoSql
  managed = @($managed | ForEach-Object { "$($_.Key)=$($_.Status)" })
  managedSql = $managedSql
  clean = @($clean | ForEach-Object { "$($_.Key)=$($_.Status)" })
  cleanSql = $cleanSql
  consent = [ordered]@{
    created = Resolve-PgHardeningConsent $true $false $false { $script:asked++; 'N' }
    switch = Resolve-PgHardeningConsent $false $true $true { $script:asked++; 'N' }
    yes = Resolve-PgHardeningConsent $false $false $true { $script:asked++; ' y ' }
    no = Resolve-PgHardeningConsent $false $false $true { $script:asked++; 'non' }
    throws = Resolve-PgHardeningConsent $false $false $true { $script:asked++; throw 'no console' }
    unattended = Resolve-PgHardeningConsent $false $false $false { $script:asked++; 'Y' }
  }
  report = @(Get-PgHardeningReport $todo @('line 7: host all all 0.0.0.0/0 trust') 'C:\\pg\\pg_hba.conf' 'unattended' $false 'db01:5432')
  reportNoHba = @(Get-PgHardeningReport $clean $null '' 'nothing to apply' $true 'localhost:5432')
}
$o.asked = $script:asked
[Console]::Out.Write(($o | ConvertTo-Json -Depth 5 -Compress))`)
        );
    }, 120000);

    wt('loopback = localhost / 127.x / ::1 only (the machine name is NOT loopback)', () => {
        expect(r.loop).toEqual([
            true,
            true,
            true,
            true,
            true,
            true,
            false,
            false,
            false,
            false,
            false,
        ]);
    });

    wt('co-located + consent: every recommendation applied, then one reload', () => {
        expect(r.applied).toEqual([
            'log_connections=APPLIED',
            'log_disconnections=APPLIED',
            'log_line_prefix=APPLIED',
            'CONNECT ON DATABASE idevelop=APPLIED',
            'listen_addresses=APPLIED',
        ]);
        expect(r.appliedSql).toEqual([
            "ALTER SYSTEM SET log_connections = 'on';",
            "ALTER SYSTEM SET log_disconnections = 'on';",
            "ALTER SYSTEM SET log_line_prefix = '%m [%p] user=%u,db=%d,client=%h ';",
            'GRANT CONNECT ON DATABASE "idevelop" TO "idevelop_app";\nREVOKE CONNECT ON DATABASE "idevelop" FROM PUBLIC;',
            "ALTER SYSTEM SET listen_addresses = 'localhost';",
            'SELECT pg_reload_conf();',
        ]);
    });

    wt(
        'a server we do not own without consent: NOTHING executed; listen_addresses never offered remotely',
        () => {
            expect(r.todoSql).toEqual([]);
            expect(r.todo).toEqual([
                'log_connections=TO DO',
                'log_disconnections=TO DO',
                'log_line_prefix=TO DO',
                'CONNECT ON DATABASE idevelop=TO DO',
                'listen_addresses=NOT OFFERED',
            ]);
        }
    );

    wt(
        'a refused ALTER SYSTEM (managed server) does not hide that the REVOKE worked; identifiers quoted',
        () => {
            expect(r.managed).toEqual([
                'log_connections=FAILED',
                'log_disconnections=FAILED',
                'log_line_prefix=FAILED',
                'CONNECT ON DATABASE we"ird=APPLIED',
                'listen_addresses=NOT OFFERED',
            ]);
            expect(r.managedSql).toContain(
                'GRANT CONNECT ON DATABASE "we""ird" TO "idevelop_app";\nREVOKE CONNECT ON DATABASE "we""ird" FROM PUBLIC;'
            );
            expect(r.managedSql).not.toContain('SELECT pg_reload_conf();');
        }
    );

    wt('an already-hardened server: nothing to execute', () => {
        expect(r.cleanSql).toEqual([]);
        expect(r.clean.every((s) => s.endsWith('=OK'))).toBe(true);
    });

    wt(
        'consent: created -> auto; switch -> yes; console Y -> yes; anything else / unattended -> no',
        () => {
            expect(r.consent.created).toEqual({ Granted: true, Mode: 'created' });
            expect(r.consent.switch).toEqual({ Granted: true, Mode: 'switch' });
            expect(r.consent.yes).toEqual({ Granted: true, Mode: 'interactive' });
            expect(r.consent.no).toEqual({ Granted: false, Mode: 'declined' });
            expect(r.consent.throws).toEqual({ Granted: false, Mode: 'declined' });
            expect(r.consent.unattended).toEqual({ Granted: false, Mode: 'unattended' });
            expect(r.asked).toBe(3); // created / switch / unattended never prompt
        }
    );

    wt('the report lists what was checked, the pg_hba trust lines, and how to apply', () => {
        const rep = r.report.join('\n');
        expect(rep).toMatch(
            /server db01:5432, created by this installer: no, decision: unattended/
        );
        expect(rep).toMatch(/\[TO DO\] log_connections: off -> on/);
        expect(rep).toMatch(/\[NOT OFFERED\] listen_addresses/);
        expect(rep).toMatch(/pg_hba\.conf \(C:\\pg\\pg_hba\.conf\): 1 'trust' entry/);
        expect(rep).toMatch(/line 7: host all all 0\.0\.0\.0\/0 trust/);
        expect(rep).toMatch(/-ApplyPgHardening/);
        expect(r.reportNoHba.join('\n')).toMatch(/\[NOT CHECKED\] pg_hba\.conf/);
    });
});
