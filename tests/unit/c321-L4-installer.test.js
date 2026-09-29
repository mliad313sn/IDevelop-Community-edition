'use strict';
/**
 * 3.23.21 lane L4 — ST-1 (Node version gate) and ST-4 (erasure re-application
 * recovery runbook). The PowerShell helpers are EXTRACTED from the shipped
 * scripts with the PowerShell parser and RUN, like c317-O-ops2-installer.
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c321-l4-ps-'));
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
$script:logs = New-Object System.Collections.Generic.List[string]
function Log($m, $l = 'INFO') { [void]$script:logs.Add("[$l] $m") }
`;
}

describe('ST-1 — Node version', () => {
    test('config.psd1 ships a Node 22 LTS >= 22.12 with the matching official MSI URL', () => {
        const cfg = fs.readFileSync(CONFIG, 'utf8');
        const v = /^\s*NodeVersion\s*=\s*'(\d+)\.(\d+)\.(\d+)'/m.exec(cfg);
        expect(v).not.toBeNull();
        const [maj, min] = [Number(v[1]), Number(v[2])];
        expect(maj === 22 ? min >= 12 : maj > 22).toBe(true);
        const ver = `${v[1]}.${v[2]}.${v[3]}`;
        expect(cfg).toMatch(
            new RegExp(
                `NodeMsiUrl\\s*=\\s*'https://nodejs\\.org/dist/v${ver}/node-v${ver}-x64\\.msi'`
            )
        );
        // The standard PG superuser password must still ship (user rule).
        expect(cfg).toMatch(/^\s*StandardPgSuperPassword\s*=/m);
    });

    wt(
        'Test-NodeVersionOk compares full major.minor against package.json engines and refuses the require(esm) gap',
        () => {
            const base = fs.mkdtempSync(path.join(os.tmpdir(), 'c321-l4-eng-'));
            try {
                fs.mkdirSync(path.join(base, 'app'));
                fs.writeFileSync(
                    path.join(base, 'app', 'package.json'),
                    JSON.stringify({ engines: { node: '>=20.19.0' } })
                );
                const sr = base.replace(/'/g, "''");
                const out =
                    runPs(`${prelude(INSTALL, ['Get-RequiredNodeVersion', 'Test-NodeVersionOk'])}
$cfg = @{ NodeMinMajor = 20 }
$ScriptRoot = '${sr}'
$need = Get-RequiredNodeVersion
$ScriptRoot = 'C:\\nonexistent-c321'
$fallback = Get-RequiredNodeVersion
$o = [ordered]@{
  need = "$need"; fallback = "$fallback"
  v20_18 = Test-NodeVersionOk ([version]'20.18.1') $need
  v20_19 = Test-NodeVersionOk ([version]'20.19.0') $need
  v21_7  = Test-NodeVersionOk ([version]'21.7.3') $need
  v22_11 = Test-NodeVersionOk ([version]'22.11.0') $need
  v22_12 = Test-NodeVersionOk ([version]'22.12.0') $need
  v24    = Test-NodeVersionOk ([version]'24.1.0') $need
  none   = Test-NodeVersionOk $null $need
}
[Console]::Out.Write(($o | ConvertTo-Json -Compress))`);
                const r = JSON.parse(out);
                expect(r.need).toBe('20.19.0');
                expect(r.fallback).toBe('20.0.0');
                expect(r.v20_18).toBe(false); // the old shipped 20.18.1 is refused
                expect(r.v20_19).toBe(true);
                expect(r.v21_7).toBe(false);
                expect(r.v22_11).toBe(false);
                expect(r.v22_12).toBe(true);
                expect(r.v24).toBe(true);
                expect(r.none).toBe(false);
            } finally {
                fs.rmSync(base, { recursive: true, force: true });
            }
        },
        60000
    );
});

describe('ST-4 — reapply-erasures failure prints a recovery runbook', () => {
    wt(
        'names the subject(s), the rerun command and the service start, before the failure is returned',
        () => {
            const base = fs.mkdtempSync(path.join(os.tmpdir(), 'c321-l4-era-'));
            try {
                const d = path.join(base, 'one');
                fs.mkdirSync(path.join(d, 'scripts'), { recursive: true });
                fs.writeFileSync(
                    path.join(d, 'scripts', 'reapply-erasures.js'),
                    "console.error('  ! employee #4242: boom'); console.error('  ! employee #77: boom'); process.exit(1);\n"
                );
                const one = d.replace(/'/g, "''");
                const none = path.join(base, 'none');
                fs.mkdirSync(none);
                const node = process.execPath.replace(/'/g, "''");
                const out =
                    runPs(`${prelude(MANAGE, ['Invoke-ReapplyErasures', 'Get-ErasureRunbook'])}
$cfg = @{ ServiceName = 'SvcX'; AppPort = 3999 }
$one = Invoke-ReapplyErasures -InstallDir '${one}' -NodeExe '${node}' -HasTombstones '1'
$miss = Invoke-ReapplyErasures -InstallDir '${none.replace(/'/g, "''")}' -NodeExe '${node}' -HasTombstones '1'
$o = [ordered]@{ one = $one; miss = $miss; logs = @($script:logs) }
[Console]::Out.Write(($o | ConvertTo-Json -Depth 4 -Compress))`);
                const r = JSON.parse(out);
                expect(r.one.Status).toBe('failed');
                const rb = r.one.Runbook.join('\n');
                expect(rb).toMatch(/employee #4242, employee #77/);
                expect(rb).toMatch(/scripts\\reapply-erasures\.js/);
                expect(rb).toMatch(/Start-Service SvcX/);
                expect(rb).toMatch(/localhost:3999\/readyz/);
                // Printed to the log (the operator sees it), before the Die message.
                const logs = r.logs.join('\n');
                expect(logs).toMatch(/\[ERROR\] =+ RECOVERY RUNBOOK/);
                expect(logs).toMatch(/\[ERROR\] Subject\(s\) NOT erased again: employee #4242/);
                expect(r.one.Message).toMatch(/RECOVERY RUNBOOK/);
                expect(r.miss.Status).toBe('failed');
                expect(r.miss.Runbook.join('\n')).toMatch(/script or node\.exe is missing/);
            } finally {
                fs.rmSync(base, { recursive: true, force: true });
            }
        },
        60000
    );
});
