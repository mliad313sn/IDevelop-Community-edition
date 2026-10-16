'use strict';
/**
 * No secret on a process command line in the installer scripts.
 *
 *  - set-admin-password.js takes the password from SET_ADMIN_PASSWORD (the
 *    legacy argv form still works for older callers).
 *  - Install-IDevelop.ps1 passes it to that script through the child's
 *    environment, and gives the EDB PostgreSQL installer the superuser
 *    password through an option file (New-PgInstallerArgs), never
 *    `--superpassword <pw>`.
 *  - Manage-IDevelop.ps1 Invoke-SetAdminPasswordTool: the password reaches the
 *    script from the environment, both for a current (env-aware) script and for
 *    an OLDER argv-only script (a fixed `node -e` shim). On Windows the child's
 *    real OS command line (Win32_Process.CommandLine) is read and must not
 *    contain it.
 *
 * Static checks run everywhere; the PowerShell functions are EXTRACTED with the
 * parser and RUN on Windows only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const onWindows = process.platform === 'win32';
const wt = onWindows ? test : test.skip;
const ROOT = path.join(__dirname, '..', '..');
const INSTALL = path.join(ROOT, 'installer', 'Install-IDevelop.ps1');
const MANAGE = path.join(ROOT, 'installer', 'Manage-IDevelop.ps1');
const TOOL = path.join(ROOT, 'scripts', 'set-admin-password.js');
const q = (s) => s.replace(/'/g, "''");
const SECRET = 'Zq7-argv-Secret!x';

function runPs(script, env = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-argv-'));
    const ps1 = path.join(dir, 'probe.ps1');
    fs.writeFileSync(ps1, script);
    try {
        return execFileSync(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
            { encoding: 'utf8', timeout: 110000, env: { ...process.env, ...env } }
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
if ($er.Count) { throw "parse errors: $($er.Count) $($er[0].Message) line $($er[0].Extent.StartLineNumber)" }
$names = @(${names.map((n) => `'${n}'`).join(',')})
$defs = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $n.Name }, $true)
if (@($defs).Count -ne $names.Count) { throw "functions found: $(@($defs).Count) of $($names.Count)" }
foreach ($d in $defs) { . ([scriptblock]::Create($d.Extent.Text)) }
`;
}

// A stand-in for scripts/set-admin-password.js: records the password it received
// and its own OS command line (what any local user sees in the process list).
function fakeTool(dir, envAware) {
    const f = path.join(dir, envAware ? 'tool-new.js' : 'tool-old.js');
    const read = envAware
        ? 'const pw = process.env.' + 'SET_ADMIN_' + 'PASSWORD;'
        : 'const pw = process.argv[2];';
    fs.writeFileSync(
        f,
        `${read}
const { execFileSync } = require('child_process');
const cl = execFileSync('powershell.exe', ['-NoProfile', '-Command',
  '(Get-CimInstance Win32_Process -Filter "ProcessId=' + process.pid + '").CommandLine'], { encoding: 'utf8' });
require('fs').writeFileSync(process.env.ARGV_PROBE_OUT, JSON.stringify({ pw, cl }));
`
    );
    return f;
}

describe('scripts/set-admin-password.js reads the environment first', () => {
    // The length check runs before any database connection, so a dummy URL is
    // enough to see WHICH value the script took.
    const run = (env, args) =>
        spawnSync(process.execPath, [TOOL, ...args], {
            encoding: 'utf8',
            timeout: 30000,
            env: {
                PATH: process.env.PATH,
                DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
                ...env,
            },
        });

    test('SET_ADMIN_PASSWORD wins over argv (a short env value is refused even with a long argv)', () => {
        const r = run({ SET_ADMIN_PASSWORD: 'short' }, ['LongEnoughPassword1']);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/at least 8 characters/);
    });

    test('the legacy argv form is still read when the variable is absent', () => {
        const r = run({}, ['short']);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/at least 8 characters/);
    });

    test('the variable is deleted from the process environment once read', () => {
        const js = fs.readFileSync(TOOL, 'utf8');
        expect(js).toMatch(/const fromEnv = process\.env\.SET_ADMIN_PASSWORD;/);
        expect(js).toMatch(/delete process\.env\.SET_ADMIN_PASSWORD;/);
    });
});

describe('Install-IDevelop.ps1: no password on a child command line', () => {
    const src = fs.readFileSync(INSTALL, 'utf8');

    test('the admin password goes to set-admin-password.js through the environment', () => {
        expect(src).toMatch(/\$pwEnv\['SET_ADMIN_PASSWORD'\] = \$script:adminPw/);
        expect(src).toMatch(
            /-Arguments @\('scripts\\set-admin-password\.js'\) -WorkDir \$cfg\.InstallDir -EnvVars \$pwEnv/
        );
        expect(src).not.toMatch(/set-admin-password\.js', \$script:adminPw/);
    });

    test('the EDB installer reads the superuser password from an option file, deleted after', () => {
        expect(src).not.toMatch(/'--superpassword'/);
        expect(src).toMatch(
            /\$pgInst = New-PgInstallerArgs -SuperPassword \$cfg\.PgSuperPassword -Port \$cfg\.PgPort/
        );
        expect(src).toMatch(/-ArgumentList \$pgInst\.Args -Wait -PassThru/);
        expect(src).toMatch(/Remove-Item -LiteralPath \$pgInst\.Dir -Recurse -Force/);
        const fn = src.slice(src.indexOf('function New-PgInstallerArgs'));
        const body = fn.slice(0, fn.indexOf('\n}'));
        expect(body).toMatch(/'--optionfile'/);
        expect(body).toMatch(/UTF8Encoding\(\$false\)/); // no BOM: the first key must parse
        expect(body).toMatch(/\[guid\]::NewGuid\(\)/); // a fresh folder per run
    });

    wt(
        'New-PgInstallerArgs: the option file holds the password, the argument list never does',
        () => {
            const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-argv-pg-'));
            try {
                const res = runPs(`${prelude(INSTALL, ['New-PgInstallerArgs'])}
$r = New-PgInstallerArgs -SuperPassword '${q(SECRET)}' -Port 5433 -TempRoot '${q(tmp)}'
[Console]::Out.Write((@{ args = ($r.Args -join ' '); dir = $r.Dir; opt = $r.OptionFile } | ConvertTo-Json -Compress))`);
                const r = JSON.parse(res.trim());
                expect(r.args).not.toContain(SECRET);
                expect(r.args).not.toMatch(/--superpassword/);
                expect(r.args).toContain(`"${r.opt}"`);
                expect(r.args).toMatch(/--serverport 5433/);
                expect(r.opt.startsWith(r.dir)).toBe(true);
                expect(r.dir.startsWith(tmp)).toBe(true);
                const bytes = fs.readFileSync(r.opt);
                expect(bytes[0]).not.toBe(0xef);
                expect(bytes.toString('utf8')).toBe(`superpassword=${SECRET}\r\n`);
            } finally {
                fs.rmSync(tmp, { recursive: true, force: true });
            }
        },
        120000
    );
});

describe('Manage-IDevelop.ps1: Invoke-SetAdminPasswordTool', () => {
    const src = fs.readFileSync(MANAGE, 'utf8');

    test('static: the password is set in the environment and removed in finally', () => {
        expect(src).toMatch(/\$env:SET_ADMIN_PASSWORD = \$cfg\.StandardAdminPassword/);
        expect(src).toMatch(/finally \{ Remove-Item Env:\\SET_ADMIN_PASSWORD/);
        expect(src).toMatch(/Invoke-SetAdminPasswordTool -NodeExe \$nodeExe -Tool \$tool/);
    });

    test('static: no node call carries a password variable as an argument', () => {
        const nodeCalls = src
            .split(/\r?\n/)
            .filter((l) => /&\s*\$(node|nodeExe|NodeExe)\b/.test(l));
        expect(nodeCalls.length).toBeGreaterThan(0);
        for (const l of nodeCalls) expect(l).not.toMatch(/Password|\$pw\b|\$pass/i);
    });

    test('static: the shim for older scripts copies the variable inside node and deletes it', () => {
        const m = /\$shim = '([^']+)'/.exec(src);
        expect(m).not.toBeNull();
        expect(m[1]).toMatch(/delete e\.SET_ADMIN_PASSWORD/);
        expect(m[1]).toMatch(/process\.argv=\[process\.argv\[0\],t,p\]/);
    });

    for (const envAware of [true, false]) {
        wt(
            `${envAware ? 'env-aware' : 'legacy argv-only'} script gets the password, the OS command line never shows it`,
            () => {
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-argv-tool-'));
                try {
                    const tool = fakeTool(dir, envAware);
                    const outFile = path.join(dir, 'out.json');
                    const res = runPs(
                        `${prelude(MANAGE, ['Invoke-SetAdminPasswordTool'])}
$env:SET_ADMIN_PASSWORD = '${q(SECRET)}'
$r = Invoke-SetAdminPasswordTool -NodeExe '${q(process.execPath)}' -Tool '${q(tool)}'
[Console]::Out.Write("code=$($r.Code)")`,
                        { ARGV_PROBE_OUT: outFile }
                    );
                    expect(res).toContain('code=0');
                    const got = JSON.parse(fs.readFileSync(outFile, 'utf8'));
                    expect(got.pw).toBe(SECRET);
                    expect(got.cl.length).toBeGreaterThan(0);
                    expect(got.cl).not.toContain(SECRET);
                } finally {
                    fs.rmSync(dir, { recursive: true, force: true });
                }
            },
            120000
        );
    }

    wt(
        'no password in the environment: nothing is run (code -1)',
        () => {
            const res = runPs(
                `${prelude(MANAGE, ['Invoke-SetAdminPasswordTool'])}
Remove-Item Env:\\SET_ADMIN_PASSWORD -ErrorAction SilentlyContinue
$r = Invoke-SetAdminPasswordTool -NodeExe 'C:\\nope\\node.exe' -Tool 'C:\\nope\\t.js'
[Console]::Out.Write("code=$($r.Code)")`
            );
            expect(res).toContain('code=-1');
        },
        120000
    );
});
