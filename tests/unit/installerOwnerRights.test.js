'use strict';
/**
 * OWNER RIGHTS (S-1-3-4) belongs to the installer's hardened SID set.
 *
 * The app restricts the folders and files it writes itself (audit-anchors, the
 * backup keyring, the database dumps) to SYSTEM + Administrators + OWNER RIGHTS.
 * Without OWNER RIGHTS in the installer's set, such a folder counted as "not
 * restricted": it was re-walked on every patch and the service-account
 * migration failed closed on it.
 *
 * The static checks run everywhere. On Windows the functions are EXTRACTED from
 * the shipped scripts with the PowerShell parser and RUN on a temp folder shaped
 * exactly like audit-anchors (same icacls line as the job).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const wt = process.platform === 'win32' ? test : test.skip;
const ROOT = path.join(__dirname, '..', '..');
const INSTALL = path.join(ROOT, 'installer', 'Install-IDevelop.ps1');
const MANAGE = path.join(ROOT, 'installer', 'Manage-IDevelop.ps1');
const q = (s) => s.replace(/'/g, "''");

function run(src) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-owner-'));
    const ps1 = path.join(base, 'probe.ps1');
    const dir = path.join(base, 'audit-anchors');
    fs.mkdirSync(dir);
    fs.writeFileSync(
        ps1,
        `
$ErrorActionPreference = 'Stop'
$tk = $null; $er = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${q(src)}', [ref]$tk, [ref]$er)
if ($er.Count) { throw "parse errors: $($er.Count)" }
$names = @('Test-AclHardened')
$defs = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $n.Name }, $true)
foreach ($d in $defs) { . ([scriptblock]::Create($d.Extent.Text)) }
$a = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$script:HardenedAclSids' }, $true) | Select-Object -First 1
. ([scriptblock]::Create($a.Extent.Text))
$script:ServiceAclSid = $null
$d = '${q(dir)}'
# Exactly what src/jobs/audit-anchor.js restrictDirAcl does.
& icacls.exe $d /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-3-4:(OI)(CI)F' /Q | Out-Null
$appShape = Test-AclHardened $d
# A real foreign grant (BUILTIN\\Users) is still NOT hardened.
& icacls.exe $d /grant '*S-1-5-32-545:(OI)(CI)RX' /Q | Out-Null
$withUsers = Test-AclHardened $d
& icacls.exe $d /reset /Q | Out-Null
[Console]::Out.Write((@{ appShape = $appShape; withUsers = $withUsers } | ConvertTo-Json -Compress))
`
    );
    try {
        return JSON.parse(
            execFileSync(
                'powershell.exe',
                ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
                {
                    encoding: 'utf8',
                    timeout: 120000,
                }
            ).replace(new RegExp('^' + String.fromCharCode(0xfeff)), '')
        );
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
}

describe('OWNER RIGHTS on an app-restricted folder counts as hardened', () => {
    for (const [name, src] of [
        ['Install', INSTALL],
        ['Manage', MANAGE],
    ]) {
        test(`${name}: the hardened SID set is SYSTEM, Administrators and OWNER RIGHTS`, () => {
            const text = fs.readFileSync(src, 'utf8');
            expect(text).toMatch(
                /^\$script:HardenedAclSids = @\('S-1-5-18', 'S-1-5-32-544', 'S-1-3-4'\)\r?$/m
            );
            // The installer itself never GRANTS OWNER RIGHTS: it only accepts it.
            expect(text).not.toMatch(/\/grant:r[^\r\n]*S-1-3-4/);
        });

        wt(`${name}: audit-anchors as the app leaves it passes; a Users grant still fails`, () => {
            const r = run(src);
            expect(r.appShape).toBe(true);
            expect(r.withUsers).toBe(false);
        });
    }

    test('the job still restricts the folder to SYSTEM + Administrators + OWNER RIGHTS', () => {
        const job = fs.readFileSync(path.join(ROOT, 'src', 'jobs', 'audit-anchor.js'), 'utf8');
        expect(job).toMatch(/'\*S-1-3-4:\(OI\)\(CI\)F'/);
    });
});
