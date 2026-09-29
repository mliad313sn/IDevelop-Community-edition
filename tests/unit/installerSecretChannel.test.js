'use strict';
/**
 * Z-INST-3 / Z-INST-8 — the postgres superuser password never travels on a
 * command line and never crosses cmd.exe's delayed expansion.
 *
 * Measured on 2026-09-17 (see the committee dossier):
 *   - 46 install-*.transcript.log files under %ProgramData%\IDevelop carried
 *     "Host Application: ... -PgSuperPassword <value>" in clear, in a folder
 *     BUILTIN\Users can read. Start-Transcript copies the command line into
 *     that header; nothing downstream can redact it.
 *   - Setup.bat runs with EnableDelayedExpansion and expanded %PGPASS% on the
 *     installer's command line: 'Abc!2026' reached the installer as 'Abc2026'
 *     (cmd probe), the installer could not authenticate, and - PostgreSQL being
 *     local - armed Reset-PgSuperViaTrust and REPLACED the real password.
 *
 * The fix is one channel for every launcher: the value is read straight into
 * the environment variable SETUP_PG_SUPER_PASSWORD (set /p keeps '!' and '^'
 * intact: cmd probe, this file), children inherit it, and Install / Manage /
 * Uninstall read $env:SETUP_PG_SUPER_PASSWORD themselves. Transcripts also
 * move into a sub-folder whose ACL is cut to Administrators + SYSTEM, and the
 * headers of the transcripts already on disk are redacted on the next deploy.
 *
 * Source assertions use \s* between tokens (a reformat must not turn into a
 * red suite); the cmd and PowerShell probes are real executions.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const INSTALLER = path.join(__dirname, '..', '..', 'installer');
const read = (f) => fs.readFileSync(path.join(INSTALLER, f), 'utf8');
const onWindows = process.platform === 'win32';

describe('Setup.bat never puts the secret on a line', () => {
    const bat = read('Setup.bat');

    test('the masked entry lands straight in SETUP_PG_SUPER_PASSWORD', () => {
        expect(bat).toMatch(/set \/p "SETUP_PG_SUPER_PASSWORD=" < "%_pgf%"/);
    });

    test('no launcher line passes -PgSuperPassword or expands the secret', () => {
        // The rem block explains the hazard by name; only CODE lines are checked.
        const code = bat.replace(/^\s*rem[^\n]*/gim, '');
        expect(code).not.toMatch(/-PgSuperPassword/);
        expect(code).not.toMatch(/%PGPASS%|!PGPASS!/);
        expect(code).not.toMatch(/%SETUP_PG_SUPER_PASSWORD%|!SETUP_PG_SUPER_PASSWORD!/);
    });

    test('the menu still runs under delayed expansion (the hazard is real, the fix is the channel)', () => {
        expect(bat).toMatch(/setlocal EnableExtensions EnableDelayedExpansion/);
    });

    (onWindows ? test : test.skip)(
        "cmd probe: a password with '!', '^' and '%' reaches a PowerShell child intact through the environment",
        () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-pg-'));
            const pw = 'Abc!2026^Prod%IT';
            const pwFile = path.join(dir, 'pw.txt');
            fs.writeFileSync(pwFile, pw, 'ascii');
            // Setup.bat's own mechanism, verbatim: the set /p line with the temp
            // file substituted, under the same setlocal as the real menu.
            const line = /set \/p "SETUP_PG_SUPER_PASSWORD=" < "%_pgf%"/
                .exec(bat)[0]
                .replace('%_pgf%', pwFile);
            const probe = [
                '@echo off',
                'setlocal EnableExtensions EnableDelayedExpansion',
                'set "SETUP_PG_SUPER_PASSWORD="',
                line,
                'powershell -NoProfile -Command "[Console]::Out.Write($env:SETUP_PG_SUPER_PASSWORD)"',
            ].join('\r\n');
            const batFile = path.join(dir, 'probe.bat');
            fs.writeFileSync(batFile, probe, 'ascii');
            try {
                const got = execFileSync('cmd.exe', ['/c', batFile], {
                    encoding: 'utf8',
                    timeout: 60000,
                });
                expect(got).toBe(pw);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        },
        70000
    );
});

describe('the PowerShell launchers use the environment, not an argument', () => {
    test.each(['Setup-Wizard.ps1', 'Maintain-IDevelop.ps1', 'Deploy-OneShot.ps1'])(
        '%s sets $env:SETUP_PG_SUPER_PASSWORD and builds no -PgSuperPassword argument',
        (f) => {
            const src = read(f);
            expect(src).toMatch(/\$env:SETUP_PG_SUPER_PASSWORD\s*=\s*\$/);
            expect(src).not.toMatch(/@\(\s*'-PgSuperPassword'\s*,/);
        }
    );
});

describe('the scripts that need the password read the environment', () => {
    test.each(['Install-IDevelop.ps1', 'Manage-IDevelop.ps1', 'Uninstall-IDevelop.ps1'])(
        '%s falls back to SETUP_PG_SUPER_PASSWORD when -PgSuperPassword is absent',
        (f) => {
            expect(read(f)).toMatch(
                /if\s*\(\s*-not\s+\$PgSuperPassword\s+-and\s+\$env:SETUP_PG_SUPER_PASSWORD\s*\)\s*\{\s*\$PgSuperPassword\s*=\s*\$env:SETUP_PG_SUPER_PASSWORD/
            );
        }
    );

    test.each(['Install-IDevelop.ps1', 'Manage-IDevelop.ps1', 'Uninstall-IDevelop.ps1'])(
        '%s keeps the secret off the elevated relaunch command line',
        (f) => {
            const src = read(f);
            const elev = src.slice(0, src.indexOf('-Verb RunAs'));
            expect(elev).toMatch(
                /if\s*\(\s*\$kv\.Key\s+-eq\s+'PgSuperPassword'\s*\)\s*\{\s*continue\s*\}/
            );
            expect(elev).toMatch(
                /if\s*\(\s*\$PgSuperPassword\s*\)\s*\{\s*\$env:SETUP_PG_SUPER_PASSWORD\s*=\s*\$PgSuperPassword\s*\}/
            );
        }
    );
});

describe('transcripts are written where only administrators can read them', () => {
    const ins = read('Install-IDevelop.ps1');

    test('the transcript path is under a transcripts sub-folder', () => {
        expect(ins).toMatch(/\$TranscriptDir\s*=\s*Join-Path\s+\$LogDir\s+'transcripts'/);
        expect(ins).toMatch(/\$Transcript\s*=\s*Join-Path\s+\$TranscriptDir/);
    });

    test('the ACL is cut to Administrators + SYSTEM (by SID) BEFORE Start-Transcript, and a failed cut means no transcript', () => {
        const acl = ins.indexOf('/inheritance:r');
        const start = ins.indexOf('Start-Transcript -Path');
        expect(acl).toBeGreaterThan(-1);
        expect(acl).toBeLessThan(start);
        expect(ins).toMatch(/S-1-5-32-544:\(OI\)\(CI\)F/);
        expect(ins).toMatch(/S-1-5-18:\(OI\)\(CI\)F/);
        expect(ins).toMatch(/if\s*\(\s*-not\s+\$script:TranscriptDirProtected\s*\)\s*\{\s*throw/);
    });

    test('the environment header redaction of -PgSuperPassword is still there (belt) and the bound-parameter loop skips it (braces)', () => {
        expect(ins).toMatch(/'PgSuperPassword'\s*\)\s*\{\s*'\*\*\*redacted\*\*\*'/);
    });

    (onWindows ? test : test.skip)(
        'PowerShell probe: Move-LegacyTranscripts redacts the header value and moves the file',
        () => {
            const fn =
                /function Move-LegacyTranscripts\(\[string\]\$from, \[string\]\$to\) \{[\s\S]*?\n\}/.exec(
                    ins
                );
            expect(fn).not.toBeNull();
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcripts-'));
            const from = path.join(dir, 'from');
            const to = path.join(dir, 'to');
            fs.mkdirSync(from);
            fs.mkdirSync(to);
            const secret = 'OnePass!2026Prod#IT';
            fs.writeFileSync(
                path.join(from, 'install-20260916-203753.transcript.log'),
                `**********************\r\nHost Application: powershell.exe -File Install.ps1 -Migrate -PgSuperPassword ${secret} -GuiAutoClose 8\r\n**********************\r\nbody -PgSuperPassword "${secret}" tail\r\n`
            );
            const script = `${fn[0]}\n$n = Move-LegacyTranscripts '${from}' '${to}'\n[Console]::Out.Write($n)`;
            const ps1 = path.join(dir, 'probe.ps1');
            fs.writeFileSync(ps1, script);
            try {
                const n = execFileSync(
                    'powershell.exe',
                    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
                    {
                        encoding: 'utf8',
                        timeout: 60000,
                    }
                );
                expect(n.trim()).toBe('1');
                expect(
                    fs.existsSync(path.join(from, 'install-20260916-203753.transcript.log'))
                ).toBe(false);
                const moved = fs.readFileSync(
                    path.join(to, 'install-20260916-203753.transcript.log'),
                    'utf8'
                );
                expect(moved).not.toContain(secret);
                expect(moved).toContain('-PgSuperPassword ***redacted***');
                expect(moved).toContain('-GuiAutoClose 8');
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        },
        70000
    );
});

describe('the automatic postgres password reset is not armed by a supplied password', () => {
    const ins = read('Install-IDevelop.ps1');

    test('a distinct supplied password asks for RESET instead of resetting', () => {
        expect(ins).toMatch(
            /\$distinctSupplied\s*=\s*\$PgSuperPassword\s+-and\s+\(\s*\$PgSuperPassword\s+-ne\s+\$cfg\.StandardPgSuperPassword\s*\)/
        );
        expect(ins).toMatch(/\$armReset\s*=\s*\(\s*\$ans\s+-eq\s+'RESET'\s*\)/);
        expect(ins).toMatch(/if\s*\(\s*\$armReset\s*\)\s*\{\s*if\s*\(\s*Reset-PgSuperViaTrust/);
    });
});
