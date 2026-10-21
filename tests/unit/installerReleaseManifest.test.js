'use strict';
/**
 * Windows installer: the release manifest.
 *
 *  - Build-Package writes app\release-manifest.sha256 (sha256sum format, every
 *    shipped file, not itself), last, once the payload is final.
 *  - Install-IDevelop verifies the payload against it BEFORE anything is
 *    stopped or copied: an altered, missing or added file refuses the install.
 *  - After the copy, files of the install directory the release does not list
 *    (customer folders excluded) are reported; -EnforceManifest MOVES them to
 *    app-backups\retired-<stamp>\, never deletes them.
 *
 * Static checks run everywhere; on Windows the functions are EXTRACTED with the
 * PowerShell parser and RUN.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const onWindows = process.platform === 'win32';
const wt = onWindows ? test : test.skip;
const ROOT = path.join(__dirname, '..', '..');
const INSTALL = path.join(ROOT, 'installer', 'Install-IDevelop.ps1');
const BUILD = path.join(ROOT, 'installer', 'Build-Package.ps1');
const INST = fs.readFileSync(INSTALL, 'utf8').replace(/\r\n/g, '\n');
const BLD = fs.readFileSync(BUILD, 'utf8').replace(/\r\n/g, '\n');
const q = (s) => s.replace(/'/g, "''");

function runPs(script) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-mf-'));
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

describe('release manifest (static)', () => {
    test('Build-Package writes it last, after every guard, just before the zip', () => {
        const write = BLD.indexOf(
            '$manifestCount = Write-ReleaseManifest $appDest $manifestFile $version'
        );
        const zip = BLD.indexOf('Compress-Archive -Path (Join-Path $staging');
        const deny = BLD.indexOf('[OK] Denylist guard');
        expect(write).toBeGreaterThan(deny);
        expect(write).toBeLessThan(zip);
        // Nothing writes under app\ between the manifest and the zip.
        const after = BLD.indexOf('[OK] Release manifest', write);
        expect(BLD.slice(after, zip)).not.toMatch(/\$appDest/);
        expect(BLD).toMatch(/# IDevelop release manifest version=\$Version files=/);
    });

    test('the payload is verified BEFORE the service is stopped or a file is copied; both failures Fail', () => {
        const verify = INST.indexOf('$pv = Test-PayloadManifest $payload');
        const stop = INST.indexOf('Stop-AppService', verify);
        const copy = INST.indexOf('robocopy $payload $cfg.InstallDir');
        expect(verify).toBeGreaterThan(0);
        expect(verify).toBeLessThan(stop);
        expect(verify).toBeLessThan(copy);
        const block = INST.slice(
            verify,
            INST.indexOf('Log "Package integrity: $($pv.Count)', verify)
        );
        expect(block.match(/\bFail "/g)).toHaveLength(2);
    });

    test('the drift check never walks a customer folder (IDevelop folders named)', () => {
        const m = /\$script:ManifestCustomerDirs = @\(([\s\S]*?)\)\n/.exec(INST);
        const dirs = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
        for (const d of [
            'uploads',
            'branding',
            'logs',
            'backups',
            '.env',
            'certs',
            'data',
            'node_modules',
            'tmp',
            'service',
            'AI_Engine_Docs',
            'hris',
            'hris-drop',
        ])
            expect(dirs).toContain(d);
        expect(INST).toMatch(
            /\$script:ManifestCustomerNested = @\('public\\uploads', 'public\\branding'\)/
        );
        // HRIS_DROP_ROOT inside the install dir is excluded too.
        expect(INST).toMatch(/\$hrisRoot = Get-HrisDropRoot \$cfg\.InstallDir/);
    });

    test('-EnforceManifest moves, never deletes; report-only without it', () => {
        expect(INST).toMatch(/\[switch\]\$EnforceManifest\b/);
        expect(INST).toMatch(/\.PARAMETER EnforceManifest\b/);
        const fn = /function Move-ManifestUnknownFiles[\s\S]*?\n\}/.exec(INST)[0];
        expect(fn).toMatch(/Move-Item -LiteralPath \$src -Destination \$dest/);
        expect(fn).not.toMatch(/Remove-Item/);
        expect(fn).toMatch(/StartsWith\(\$root, \[StringComparison\]::OrdinalIgnoreCase\)/);
        expect(INST).toMatch(
            /if \(\$EnforceManifest\) \{\s+\$retDir = Join-Path \(Join-Path \$LogDir 'app-backups'\)/
        );
    });
});

describe('release manifest: Build-Package writes it, the installer reports drift (Windows)', () => {
    let base;
    let r;
    beforeAll(() => {
        if (!onWindows) return;
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-mf-man-'));
        const pkg = path.join(base, 'pkg');
        const inst = path.join(base, 'inst');
        const put = (root, rel, body) => {
            fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
            fs.writeFileSync(path.join(root, rel), body);
        };
        for (const [rel, body] of [
            ['server.js', '//s'],
            ['src/app.js', '//a'],
            ['views/pages/x.ejs', '<p>'],
            ['public/js/Page.JS', '//p'],
        ]) {
            put(pkg, rel, body);
            put(inst, rel, body);
        }
        put(inst, 'src/old-service.js', '//stale');
        put(inst, 'views/pages/retired.ejs', 'x');
        put(inst, 'hotfix.js', 'x');
        put(inst, 'uploads/evidence.pdf', 'x');
        put(inst, 'data/backups/b.json', 'x');
        put(inst, 'node_modules/a/index.js', 'x');
        put(inst, 'tmp/stage.bin', 'x');
        put(inst, 'logs/app.log', 'x');
        put(inst, 'service/IDevelop.exe', 'x');
        put(inst, 'AI_Engine_Docs/tmp/upload.xlsx', 'x');
        put(inst, 'hris/export.csv', 'x');
        put(inst, 'public/uploads/logo.png', 'x');
        put(inst, '.env', 'x');
        const b = q(base);
        r = json(
            runPs(`${prelude(BUILD, ['Write-ReleaseManifest'])}
$n = Write-ReleaseManifest '${b}\\pkg' '${b}\\pkg\\release-manifest.sha256' '9.9.9'
${prelude(INSTALL, ['Read-ReleaseManifest', 'Get-ManifestUnknownFiles', 'Move-ManifestUnknownFiles'], ['$script:ManifestCustomerDirs', '$script:ManifestCustomerNested'])}
$m = Read-ReleaseManifest '${b}\\pkg\\release-manifest.sha256'
$m.Known['release-manifest.sha256'] = @{ Hash = 'self'; Rel = 'release-manifest.sha256' }
$unk = @(Get-ManifestUnknownFiles '${b}\\inst' $m.Known $script:ManifestCustomerDirs $script:ManifestCustomerNested)
$before = @(Get-ChildItem -LiteralPath '${b}\\inst' -Recurse -File -Force).Count
$moved = Move-ManifestUnknownFiles '${b}\\inst' $unk '${b}\\retired'
$after = @(Get-ChildItem -LiteralPath '${b}\\inst' -Recurse -File -Force -ErrorAction SilentlyContinue).Count
$o = [ordered]@{ n = $n; version = $m.Version; unknown = $unk; moved = $moved; before = $before; after = $after
  unknownAfter = @(Get-ManifestUnknownFiles '${b}\\inst' $m.Known $script:ManifestCustomerDirs $script:ManifestCustomerNested)
  manifest = [IO.File]::ReadAllText('${b}\\pkg\\release-manifest.sha256') }
[Console]::Out.Write(($o | ConvertTo-Json -Depth 4 -Compress))`)
        );
    }, 120000);
    afterAll(() => {
        if (base) fs.rmSync(base, { recursive: true, force: true });
    });

    wt('Build-Package: one sha256sum line per shipped file, forward slashes, not itself', () => {
        expect(r.n).toBe(4);
        expect(r.version).toBe('9.9.9');
        const lines = r.manifest.trim().split('\n');
        expect(lines[0]).toMatch(/^# IDevelop release manifest version=9\.9\.9 files=4/);
        const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
        expect(lines.slice(1).sort()).toEqual(
            [
                `${sha('//s')}  server.js`,
                `${sha('//a')}  src/app.js`,
                `${sha('<p>')}  views/pages/x.ejs`,
                `${sha('//p')}  public/js/Page.JS`,
            ].sort()
        );
    });

    wt(
        'installer: only the drift is reported (case-insensitive), customer folders never walked',
        () => {
            expect([].concat(r.unknown)).toEqual([
                'hotfix.js',
                'src\\old-service.js',
                'views\\pages\\retired.ejs',
            ]);
        }
    );

    wt('-EnforceManifest: unknown files moved to retired\\, nothing else touched', () => {
        expect(r.moved).toBe(3);
        expect(r.after).toBe(r.before - 3);
        expect([].concat(r.unknownAfter || [])).toEqual([]);
        expect(fs.readFileSync(path.join(base, 'retired', 'src', 'old-service.js'), 'utf8')).toBe(
            '//stale'
        );
        expect(fs.existsSync(path.join(base, 'inst', 'uploads', 'evidence.pdf'))).toBe(true);
        expect(fs.existsSync(path.join(base, 'inst', '.env'))).toBe(true);
    });

    wt(
        'payload check: intact = 0 differences; altered / missing / added files each listed',
        () => {
            const pay = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-mf-pay-'));
            try {
                const files = { 'server.js': 'a', 'src/x.js': 'b', 'public/y.css': 'c' };
                for (const [rel, body] of Object.entries(files)) {
                    fs.mkdirSync(path.dirname(path.join(pay, rel)), { recursive: true });
                    fs.writeFileSync(path.join(pay, rel), body);
                }
                const lines = Object.entries(files).map(
                    ([rel, body]) =>
                        `${crypto.createHash('sha256').update(body).digest('hex')}  ${rel}`
                );
                fs.writeFileSync(
                    path.join(pay, 'release-manifest.sha256'),
                    [
                        '# IDevelop release manifest version=9.9.9 files=3 algorithm=sha256',
                        ...lines,
                    ].join('\n') + '\n'
                );
                const p = q(pay);
                const out = json(
                    runPs(`${prelude(INSTALL, ['Read-ReleaseManifest', 'Test-PayloadManifest'])}
$a = Test-PayloadManifest '${p}'
Set-Content -LiteralPath (Join-Path '${p}' 'Thumbs.db') -Value 'x'
$t = Test-PayloadManifest '${p}'
Set-Content -LiteralPath (Join-Path '${p}' 'src\\x.js') -Value 'tampered' -NoNewline
Remove-Item -LiteralPath (Join-Path '${p}' 'public\\y.css')
Set-Content -LiteralPath (Join-Path '${p}' 'evil.js') -Value 'x'
$b = Test-PayloadManifest '${p}'
$c = Test-PayloadManifest (Join-Path '${p}' 'nope')
[Console]::Out.Write((@{ a = $a; t = $t; b = $b; c = $c } | ConvertTo-Json -Depth 4 -Compress))`)
                );
                expect(out.a).toMatchObject({ Present: true, Version: '9.9.9', Count: 3 });
                expect(
                    [].concat(out.a.Mismatch || [], out.a.Missing || [], out.a.Extra || [])
                ).toEqual([]);
                // Explorer metadata is not a refusal.
                expect([].concat(out.t.Extra || [])).toEqual([]);
                expect([].concat(out.b.Mismatch)).toEqual(['src\\x.js']);
                expect([].concat(out.b.Missing)).toEqual(['public\\y.css']);
                expect([].concat(out.b.Extra)).toEqual(['evil.js']);
                expect(out.c.Present).toBe(false);
            } finally {
                fs.rmSync(pay, { recursive: true, force: true });
            }
        },
        120000
    );
});
