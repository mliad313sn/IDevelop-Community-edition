/**
 * Installer: the Windows-service wrapper must be free before it is replaced.
 *
 * Measured on the live instance (2026-09-25, 3.23.15 -> 3.23.16): Stop-Service /
 * `winsw uninstall` return before the wrapper process has exited; the Copy-Item
 * two seconds later failed with "being used by another process", and the upgrade
 * silently fell back to a SYSTEM Scheduled Task host (logged as "wrapper
 * unavailable (offline + not bundled)" although it was bundled).
 */
const fs = require('fs');
const path = require('path');

const ps = fs.readFileSync(
    path.join(__dirname, '..', '..', 'installer', 'Install-IDevelop.ps1'),
    'utf8'
);

describe('Install-IDevelop.ps1 — service wrapper replacement', () => {
    test('waits for the wrapper to be released before copying over it', () => {
        expect(ps).toMatch(/function Wait-FileReleased\(\[string\]\$Path, \[int\]\$Seconds = 30\)/);
        expect(ps).toMatch(/\[System\.IO\.File\]::Open\(\$Path, 'Open', 'ReadWrite', 'None'\)/);
        const reg = ps.slice(ps.indexOf('function Register-WindowsService'));
        expect(reg.indexOf('Wait-FileReleased -Path $svcExe')).toBeGreaterThan(-1);
        expect(reg.indexOf('Wait-FileReleased -Path $svcExe')).toBeLessThan(
            reg.indexOf('Copy-Item -LiteralPath $winsw')
        );
    });
    test('the copy is retried, and the last failure still surfaces', () => {
        expect(ps).toMatch(/for \(\$i = 1; \$i -le 5 -and -not \$copied; \$i\+\+\)/);
        expect(ps).toMatch(
            /Copy-Item -LiteralPath \$winsw -Destination \$svcExe -Force -ErrorAction Stop/
        );
        expect(ps).toMatch(/if \(\$i -eq 5\) \{ throw \}/);
    });
    test('the fallback message no longer blames a missing binary', () => {
        expect(ps).not.toMatch(
            /WinSW wrapper unavailable \(offline \+ not bundled\) - falling back/
        );
        expect(ps).toMatch(
            /Windows service could not be registered \(wrapper missing, or registration failed/
        );
    });
    test('the script stays ASCII in what this fix added (BOM-less .ps1)', () => {
        const added = ps.slice(
            ps.indexOf('function Wait-FileReleased'),
            ps.indexOf('function Register-WindowsService')
        );
        expect([...added].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
    });
});
