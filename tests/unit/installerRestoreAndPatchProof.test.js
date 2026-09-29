'use strict';
/**
 * Z-INST-1 — a restore (Manage -Restore) or the installer's automatic rollback
 * overlaid the old code with robocopy /E, which never deletes: every migration
 * file newer than the restore point stayed in db\postgres, and the service
 * applied them to the restored database at its next boot while the script
 * announced "RESTORE complete" (12 files >= 113 against a 3.22.97 point).
 *
 * Z-INST-4 — the snapshot import (Install) and the restore import / re-own
 * (Manage) ran psql with ON_ERROR_STOP=0, whose exit code is 0 whatever failed
 * inside the file (probe: a failing SELECT -> exit 0), then said "imported" /
 * "reconciled" / "RESTORE complete" on that exit code.
 *
 * Z-INST-7 — "Patch (APP ONLY) - no database changes" copied db\postgres\*.sql
 * with the code; the service migrated at the next start, outside the install
 * log and without pre-flight.
 *
 * The Remove-MigrationsNotIn probe below RUNS the helper (PowerShell) against
 * temp folders; everything else reads the scripts with \s* between tokens.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const INSTALLER = path.join(__dirname, '..', '..', 'installer');
// .gitattributes checks *.ps1 out as CRLF, but a file rewritten locally may be LF:
// compare text, not line endings.
const read = (f) => fs.readFileSync(path.join(INSTALLER, f), 'utf8').replace(/\r\n/g, '\n');
const onWindows = process.platform === 'win32';
const FN_RX =
    /function Remove-MigrationsNotIn\(\[string\]\$InstallDir, \[string\]\$Reference\) \{[\s\S]*?\n\}/;

describe('Z-INST-1: migrations newer than the restore point are removed before the overlay', () => {
    const manage = read('Manage-IDevelop.ps1');
    const install = read('Install-IDevelop.ps1');

    test('both scripts carry the same helper', () => {
        const a = FN_RX.exec(manage);
        const b = FN_RX.exec(install);
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();
        expect(a[0]).toBe(b[0]);
    });

    test('Manage -Restore purges BEFORE its robocopy, Install rollback purges BEFORE its robocopy', () => {
        const restore = manage.slice(
            manage.indexOf('function Invoke-Restore'),
            manage.indexOf('function Invoke-CheckDb')
        );
        const purge = restore.indexOf(
            'Remove-MigrationsNotIn -InstallDir $cfg.InstallDir -Reference $appSrc'
        );
        const copy = restore.indexOf('robocopy $appSrc $cfg.InstallDir');
        expect(purge).toBeGreaterThan(-1);
        expect(purge).toBeLessThan(copy);

        const rollback = install.slice(
            install.indexOf('function Invoke-Rollback'),
            install.indexOf('STEP 1/7')
        );
        const purge2 = rollback.indexOf(
            'Remove-MigrationsNotIn -InstallDir $cfg.InstallDir -Reference $script:BackupDir'
        );
        const copy2 = rollback.indexOf('robocopy $script:BackupDir $cfg.InstallDir');
        expect(purge2).toBeGreaterThan(-1);
        expect(purge2).toBeLessThan(copy2);
    });

    test('Manage -Restore runs the migration post-flight and refuses to start the service on a mismatch', () => {
        const restore = manage.slice(
            manage.indexOf('function Invoke-Restore'),
            manage.indexOf('function Invoke-CheckDb')
        );
        const pre = restore.indexOf('migrate-preflight.js');
        const start = restore.indexOf('Start-Service -Name $svc');
        expect(pre).toBeGreaterThan(-1);
        expect(pre).toBeLessThan(start);
        expect(restore).toMatch(/\$preflight --expect-none/);
        expect(restore).toMatch(
            /if\s*\(\s*\$preRc\s+-ne\s+0\s*\)\s*\{\s*Die "RESTORE REFUSED before start/
        );
        // an unmeasured pre-flight is a warning, never a pass
        expect(restore).toMatch(/unmeasured, NOT a pass/);
    });

    (onWindows ? test : test.skip)(
        'PowerShell probe: the helper deletes exactly the .sql files the reference does not carry',
        () => {
            const fn = FN_RX.exec(manage)[0];
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
            const live = path.join(dir, 'live', 'db', 'postgres');
            const ref = path.join(dir, 'ref', 'db', 'postgres');
            fs.mkdirSync(live, { recursive: true });
            fs.mkdirSync(ref, { recursive: true });
            for (const f of [
                '01_schema.sql',
                '110_x.sql',
                '113_self_assessment_rounds.sql',
                '124_audit_guard_self_protection.sql',
                'notes.txt',
            ])
                fs.writeFileSync(path.join(live, f), '-- live');
            for (const f of ['01_schema.sql', '110_x.sql'])
                fs.writeFileSync(path.join(ref, f), '-- ref');
            const ps1 = path.join(dir, 'probe.ps1');
            fs.writeFileSync(
                ps1,
                `${fn}\n$g = Remove-MigrationsNotIn -InstallDir '${path.join(dir, 'live')}' -Reference '${path.join(dir, 'ref')}'\n[Console]::Out.Write(($g -join ','))`
            );
            try {
                const out = execFileSync(
                    'powershell.exe',
                    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
                    {
                        encoding: 'utf8',
                        timeout: 60000,
                    }
                );
                expect(out.trim().split(',').sort()).toEqual([
                    '113_self_assessment_rounds.sql',
                    '124_audit_guard_self_protection.sql',
                ]);
                expect(fs.readdirSync(live).sort()).toEqual([
                    '01_schema.sql',
                    '110_x.sql',
                    'notes.txt',
                ]);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        },
        70000
    );
});

describe('Z-INST-4: "imported" and "reconciled" are said on proof, never on an ON_ERROR_STOP=0 exit code', () => {
    const install = read('Install-IDevelop.ps1');
    const manage = read('Manage-IDevelop.ps1');

    test('Install counts psql ERROR lines and checks the core tables after the snapshot import', () => {
        const imp = install.slice(
            install.indexOf('$impOut = & $psql'),
            install.indexOf('# Re-own imported objects')
        );
        expect(imp).toMatch(
            /\$impErrors\s*=\s*@\(\s*\$impOut\s*\|\s*Where-Object\s*\{\s*"\$_"\s+-match\s+'\(\^\|\\s\)ERROR:'/
        );
        expect(imp).toMatch(/\$impCheck\s*=\s*Test-ImportedSnapshot\s+\$cfg\.DbName/);
        expect(imp).toMatch(/if\s*\(\s*\$impCheck\.missing\.Count\s*\)\s*\{\s*Fail/);
        expect(imp).not.toMatch(/else\s*\{\s*Log 'Data snapshot imported\.' 'OK'/);
        expect(imp).toMatch(/imported WITH \$\(\$impErrors\.Count\) SQL error/);
    });

    test('Test-ImportedSnapshot names the four core tables and treats absent-or-empty as missing', () => {
        const fn = install.slice(
            install.indexOf('function Test-ImportedSnapshot'),
            install.indexOf('# Run a MULTI-LINE')
        );
        for (const t of ['employees', 'skills', 'admins', 'schema_meta'])
            expect(fn).toContain(`'${t}'`);
        expect(fn).toMatch(/if\s*\(\s*\$n\s+-le\s+0\s*\)\s*\{\s*\$missing\s*\+=\s*\$t\s*\}/);
    });

    test('Manage reads the import and re-own logs for ERROR lines, verifies the tables, and only then says complete', () => {
        const restore = manage.slice(
            manage.indexOf('function Invoke-Restore'),
            manage.indexOf('function Invoke-CheckDb')
        );
        expect(restore).toMatch(
            /\$impErrors\s*=\s*@\(\s*Select-String\s+-LiteralPath\s+\$importLog\s+-Pattern\s+'\(\^\|\\s\)ERROR:'/
        );
        expect(restore).toMatch(/\$impCheck\s*=\s*Test-RestoredDatabase\s+\$creds/);
        expect(restore).toMatch(/if\s*\(\s*\$impCheck\.missing\.Count\s*\)\s*\{\s*Die/);
        expect(restore).toMatch(
            /\$reownErrors\s*=\s*@\(\s*Select-String\s+-LiteralPath\s+\$reownLog/
        );
        expect(restore).toMatch(/tableowner\s+<>\s+'\$\(\$creds\.user\)'/);
        expect(restore).not.toMatch(/\n\s*Log 'Database imported\.' 'OK'/);
        expect(restore).not.toMatch(
            /\n\s*Log 'Database ownership reconciled to the app role\.' 'OK'/
        );
        expect(restore).toMatch(
            /if\s*\(\s*\$script:restoreWarnings\.Count\s*\)\s*\{\s*Log "RESTORE finished WITH/
        );
        expect(restore).toMatch(/\}\s*else\s*\{\s*Log "RESTORE complete/);
    });
});

describe('Z-INST-7: an app-only patch is refused when the package carries an unapplied migration', () => {
    const install = read('Install-IDevelop.ps1');

    test('the pending check runs BEFORE the file copy and fails closed', () => {
        const guard = install.indexOf('APP-ONLY PATCH REFUSED');
        const copy = install.indexOf("Log 'Copying application files...'");
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(copy);
        const block = install.slice(install.indexOf('if ($SkipMigrations -and $Patch) {'), copy);
        expect(block).toMatch(/SELECT string_agg\(key, E'\\n'\) FROM schema_meta/);
        expect(block).toMatch(/_down\\\.sql\$/);
        expect(block).toMatch(/if\s*\(\s*\$pendingMig\.Count\s+-gt\s+0\s*\)\s*\{\s*Fail/);
    });

    test('db\\postgres is not copied on an app-only patch', () => {
        expect(install).toMatch(
            /if\s*\(\s*\$SkipMigrations\s+-and\s+\$Patch\s*\)\s*\{\s*\$exclude\s*\+=\s*'db\\postgres'\s*\}/
        );
    });

    test('nothing still promises "no database change" unconditionally', () => {
        for (const f of ['Setup.bat', 'Installer-Gui.ps1', 'README.md']) {
            const src = read(f);
            expect({
                file: f,
                promise: /no database changes?\b(?! were made by this run)/i.test(src),
            }).toEqual({ file: f, promise: false });
        }
        const line = /Migrations SKIPPED[^\n]*/.exec(install)[0];
        expect(line).toMatch(/0 pending migrations verified before the copy/);
    });
});
