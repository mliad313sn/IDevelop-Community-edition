'use strict';
/**
 * Z-INST-5 — `if (Get-AppWindowsService -or (Get-AppScheduledTask))` is parsed
 * in COMMAND mode: `-or` and the second call become ARGUMENTS of the first
 * function, so the Scheduled-Task host was never detected (PowerShell 5.1
 * probe: $False with the task present, $True once both operands are wrapped).
 *
 * Z-INST-6 — Uninstall-IDevelop.ps1 relaunched itself elevated with
 * $MyInvocation.UnboundArguments, which is EMPTY for a script with a param()
 * block (probe: count=0 with three parameters bound), did not -Wait, exited 0,
 * and said "Dropped database ..." without reading psql's exit code (a closed
 * port returns 2). Install and Manage had already fixed the same trap.
 */
const fs = require('fs');
const path = require('path');

const INSTALLER = path.join(__dirname, '..', '..', 'installer');
const read = (f) => fs.readFileSync(path.join(INSTALLER, f), 'utf8');
const ps1Files = () => fs.readdirSync(INSTALLER).filter((f) => f.endsWith('.ps1'));

describe('no installer script tests a bare function call with -or in command mode', () => {
    test.each(ps1Files())('%s', (f) => {
        // `if (Get-X -or ...` / `if (Test-X -or ...` : the first operand is a bare
        // command, so everything after it is parsed as its arguments.
        const hits = [
            ...read(f).matchAll(/if\s*\(\s*(?:Get|Test|Find|Resolve)-[A-Za-z]+\s+-(?:or|and)\s/g),
        ].map((m) => m[0]);
        expect({ file: f, hits }).toEqual({ file: f, hits: [] });
    });

    test('both host checks in the installer wrap each operand', () => {
        const ins = read('Install-IDevelop.ps1');
        const wrapped = (
            ins.match(/\(\(Get-AppWindowsService\) -or \(Get-AppScheduledTask\)\)/g) || []
        ).length;
        expect(wrapped).toBe(2);
    });
});

describe('no installer script forwards $MyInvocation.UnboundArguments', () => {
    test.each(ps1Files())('%s', (f) => {
        // Comments may (and do) name the trap; only CODE is checked.
        const src = read(f).replace(/^\s*#[^\n]*/gm, '');
        const hasParam = /^\s*param\s*\(/m.test(src);
        const usesUnbound = /\$MyInvocation\.UnboundArguments/.test(src);
        expect({ file: f, hasParam, usesUnbound }).toEqual({
            file: f,
            hasParam,
            usesUnbound: false,
        });
    });
});

describe('Uninstall-IDevelop.ps1', () => {
    const un = read('Uninstall-IDevelop.ps1');

    test('forwards its bound parameters to the elevated run, waits for it and returns its exit code', () => {
        const elev = un.slice(0, un.indexOf('$cfg = Import-PowerShellDataFile'));
        expect(elev).toMatch(
            /foreach\s*\(\s*\$kv\s+in\s+\$PSBoundParameters\.GetEnumerator\(\)\s*\)/
        );
        expect(elev).toMatch(/-Verb RunAs[^\n]*-Wait -PassThru/);
        expect(elev).toMatch(/exit\s+\$child\.ExitCode/);
        expect(elev).toMatch(/exit 1602/);
    });

    test('says "Dropped database" only when both psql calls exited 0 under ON_ERROR_STOP=1', () => {
        const drop = un.slice(un.indexOf('# 4. database'));
        expect((drop.match(/-v ON_ERROR_STOP=1 -c "DROP (DATABASE|ROLE)/g) || []).length).toBe(2);
        expect(drop).toMatch(/\$rc1\s*=\s*\$LASTEXITCODE/);
        expect(drop).toMatch(/\$rc2\s*=\s*\$LASTEXITCODE/);
        expect(drop).toMatch(/\$dbDone\s*=\s*\(\s*\$rc1\s+-eq\s+0\s+-and\s+\$rc2\s+-eq\s+0\s*\)/);
        expect(drop).not.toMatch(/\$dbDone\s*=\s*\$true/);
        expect(drop).toMatch(/if\s*\(\s*\$dbDone\s*\)\s*\{\s*Say "Dropped database/);
        // a requested drop that did not happen is still a partial removal (1603)
        expect(drop).toMatch(
            /if\s*\(\s*\$dbAsked\s+-and\s+-not\s+\$dbDone\s*\)\s*\{\s*exit 1603\s*\}/
        );
    });

    test('the relocated silent re-exec hands the password over through the environment', () => {
        expect(un).toMatch(
            /if\s*\(\s*\$PgSuperPassword\s*\)\s*\{\s*\$env:SETUP_PG_SUPER_PASSWORD\s*=\s*\$PgSuperPassword\s*\}\s*\}/
        );
        expect(un).not.toMatch(/\$fwd\s*\+=\s*@\(\s*'-PgSuperPassword'/);
    });
});
