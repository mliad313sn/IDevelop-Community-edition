'use strict';
/**
 * installer/ — the modern setup interface is the ONLY interface a user meets.
 *
 * The owner's instruction (2026-09-15): future deployments keep the modern
 * installation interface and hide the console one; everything must go through
 * the modern interface.
 *
 * That is three separate facts, and each of them has already been wrong once:
 *
 *  1. The maintenance chooser must not offer the console menu as a CHOICE. It
 *     used to carry an "Advanced text menu" row, which is precisely the door
 *     this instruction closes.
 *  2. Setup.bat must hand over to the wizard when the machine has a desktop.
 *     Double-clicking it went straight into the text menu, so the console
 *     interface stayed one click away no matter what the chooser offered.
 *  3. The hand-over must be guarded by a marker, or Setup.bat and the wizard
 *     call each other for ever. The guard is invisible when it works and
 *     catastrophic when it does not, so it is pinned here.
 *
 * The console menu still SHIPS. Deleting it would leave a machine with no
 * desktop (Server Core, RDP without WPF) no way to install at all, which is a
 * worse outcome than keeping a door nobody is shown. This test therefore pins
 * "not offered", never "not present".
 *
 * Read-only: these tests parse the installer scripts, they never run them. The
 * hand-over itself was exercised by execution and mutation-tested separately.
 */
const fs = require('fs');
const path = require('path');

const INSTALLER = path.join(__dirname, '..', '..', 'installer');
const read = (f) => fs.readFileSync(path.join(INSTALLER, f), 'utf8');

const GUI = 'Installer-Gui.ps1';
const WIZ = 'Setup-Wizard.ps1';
const BAT = 'Setup.bat';

// Every row the maintenance chooser offers, in order: @{ id='update'; t='...'
const chooserIds = () => [...read(GUI).matchAll(/@\{\s*id='([a-z]+)'/g)].map((m) => m[1]);

// Every action the dispatcher can actually carry out: 'update' { ... }
const dispatchIds = () => [...read(WIZ).matchAll(/^\s{4}'([a-z]+)'\s*\{/gm)].map((m) => m[1]);

describe('the console menu is not an offered choice', () => {
    test('the chooser has no row that opens the text menu', () => {
        expect(chooserIds()).not.toContain('menu');
    });

    test('no chooser row advertises the text menu in its wording', () => {
        // A row could dispatch elsewhere and still SELL the console; both the
        // title and the description are read by the user, so both are checked.
        const rows = [...read(GUI).matchAll(/@\{\s*id='[a-z]+';\s*t='([^']*)';\s*d='([^']*)'/g)];
        expect(rows.length).toBeGreaterThan(5);
        const offending = rows
            .filter(([, t, d]) => /text menu|console/i.test(`${t} ${d}`))
            .map(([, t]) => t);
        expect(offending).toEqual([]);
    });
});

describe('the console menu still exists as a rescue path', () => {
    test('the package ships it', () => {
        expect(fs.existsSync(path.join(INSTALLER, BAT))).toBe(true);
    });

    test('the dispatcher still honours -Action menu', () => {
        // Reachable on purpose from the command line and from the no-WPF
        // fallback; removing this case makes a desktop-less machine
        // uninstallable, which is the whole reason the menu is kept.
        expect(dispatchIds()).toContain('menu');
    });

    test('the wizard falls back to the menu when its window cannot open', () => {
        const wiz = read(WIZ);
        const fallback = wiz.slice(wiz.indexOf('Show-SetupChooser'));
        expect(fallback).toMatch(/catch\s*\{[\s\S]{0,1200}\$MENU/);
    });
});

describe('Setup.bat hands the job to the modern interface', () => {
    const bat = () => read(BAT);

    test('it calls the wizard before it ever draws the menu', () => {
        const src = bat();
        const handover = src.indexOf('Setup-Wizard.bat');
        const menu = src.indexOf(':menu');
        expect(handover).toBeGreaterThan(-1);
        expect(menu).toBeGreaterThan(-1);
        expect(handover).toBeLessThan(menu);
    });

    test('it hands over only when a desktop AND WPF are actually available', () => {
        // Handing over on a machine that cannot open the window would strand
        // the operator with no interface at all.
        expect(bat()).toMatch(/PresentationFramework[\s\S]{0,200}UserInteractive/);
    });

    test('the hand-over is guarded by the marker, so the two cannot loop', () => {
        expect(bat()).toMatch(/if not defined SETUP_VIA_WIZARD \(/);
    });

    test('the wizard sets that marker everywhere it calls the menu', () => {
        // Count INVOCATIONS, not the `$MENU = Join-Path ...` definition: one
        // unmarked call site is all it takes to make the two loop.
        const wiz = read(WIZ);
        const calls = (wiz.match(/cmd\.exe \/c [^\n]*\$MENU/g) || []).length;
        const marks = (wiz.match(/\$env:SETUP_VIA_WIZARD = '1'/g) || []).length;
        expect(calls).toBeGreaterThan(0);
        expect({ calls, marks }).toEqual({ calls, marks: calls });
    });

    test('the marker carries no brand token', () => {
        // Environment variables are visible to the customer's ops team.
        expect(/SETUP_VIA_WIZARD/.test(bat())).toBe(true);
        expect(/idevelop/i.test('SETUP_VIA_WIZARD')).toBe(false);
    });
});

describe('every button in the modern interface leads somewhere', () => {
    test('each chooser row has a dispatch case', () => {
        const orphans = chooserIds().filter((id) => !dispatchIds().includes(id));
        expect(orphans).toEqual([]);
    });

    test('the chooser still offers every packaged operation', () => {
        // The owner asked for all options to be integrated; a shrinking chooser
        // silently pushes people back to the console.
        expect(chooserIds().sort()).toEqual([
            'adminpw',
            'backup',
            'checkdb',
            'filesonly',
            'listpoints',
            'pgpw',
            'reinstall',
            'repair',
            'restore',
            'uninstall',
            'update',
        ]);
    });
});

describe('the chooser documents exactly the buttons it draws', () => {
    // Caught a real leftover: the row was deleted but Show-SetupChooser's own
    // help block still listed `menu  the advanced text menu (Setup.bat)`, so
    // the package shipped documentation advertising the door we had just shut.
    test('the documented id list matches the offered rows', () => {
        const gui = read(GUI);
        const block = gui.slice(
            gui.indexOf('Ask what to do on a machine that already has the product'),
            gui.indexOf('Actions marked destructive')
        );
        expect(block.length).toBeGreaterThan(200);
        const documented = [...block.matchAll(/^ {6}([a-z]+) {2,}\S/gm)].map((m) => m[1]);
        expect(documented.sort()).toEqual(chooserIds().sort());
    });
});

describe('Windows own Modify button opens the modern window', () => {
    // Apps & features used to point Modify at Manage-IDevelop.ps1, which with
    // no arguments printed a one-line console usage message and quit: a console
    // interface reached from Windows' UI, that did nothing.
    const MAINT = 'Maintain-IDevelop.ps1';
    const INSTALL = 'Install-IDevelop.ps1';

    // Actions that deploy code. A servicing copy has no application payload.
    const PAYLOAD = ['update', 'filesonly', 'repair', 'reinstall'];

    test('the servicing entry point ships', () => {
        expect(fs.existsSync(path.join(INSTALLER, MAINT))).toBe(true);
    });

    test('ModifyPath names it, with the old script only as a fallback', () => {
        const ins = read(INSTALL);
        const modify = ins.slice(ins.indexOf('ModifyPath'), ins.indexOf('HelpLink'));
        expect(modify).toContain(MAINT);
        // The fallback matters on an upgrade whose servicing copy predates it.
        expect(modify).toContain('Manage-IDevelop.ps1');
    });

    test('the installer copies everything that window needs', () => {
        const ins = read(INSTALL);
        const fn = ins.slice(
            ins.indexOf('function Install-MaintenanceTools'),
            ins.indexOf('function Resolve-AppIcon')
        );
        for (const f of [
            MAINT,
            GUI,
            'Manage-IDevelop.ps1',
            'Uninstall-IDevelop.ps1',
            'config.psd1',
        ]) {
            expect({ needs: f, copied: fn.includes(f) }).toEqual({ needs: f, copied: true });
        }
    });

    test('the package carries them, or the build fails', () => {
        // A servicing tool the installer copies but the package never shipped
        // leaves Modify pointing at a file that does not exist.
        const build = read('Build-Package.ps1');
        expect(build).toContain(MAINT);
        expect(build).toMatch(/Servicing tool missing from the package/);
    });

    test('it offers exactly what a servicing copy can do', () => {
        const maintIds = [...read(MAINT).matchAll(/^ {4}'([a-z]+)'\s*\{/gm)].map((m) => m[1]);
        expect(maintIds.sort()).toEqual(
            chooserIds()
                .filter((id) => !PAYLOAD.includes(id))
                .sort()
        );
    });

    test('the chooser drops the payload actions in servicing mode', () => {
        const gui = read(GUI);
        expect(gui).toMatch(/\$sync\.Mode -eq 'servicing'/);
        for (const id of PAYLOAD) expect(gui).toMatch(new RegExp(`'${id}'`));
    });

    test('it refuses the payload actions instead of ignoring them', () => {
        // Silently doing nothing is the failure that looks like success.
        const maint = read(MAINT);
        for (const id of PAYLOAD) {
            expect({ id, refused: maint.includes(`'${id}'`) }).toEqual({ id, refused: true });
        }
        expect(maint).toMatch(/needs the setup package for the version you want/);
    });

    test("it reports the elevated run's exit code, not its own", () => {
        // Returning 0 after merely LAUNCHING the elevated run reports success
        // for work that had not started.
        const elev = read(MAINT).slice(0, read(MAINT).indexOf('$MANAGE '));
        expect(elev).toMatch(/-Verb RunAs[\s\S]{0,120}-Wait -PassThru/);
        expect(elev).toMatch(/exit \$p\.ExitCode/);
    });
});

describe('the installer scripts stay ASCII', () => {
    // PowerShell 5.1 reads a BOM-less file as ANSI, so an accented character in
    // a .ps1 reaches the wizard as mojibake. It has happened twice.
    test.each([GUI, WIZ, BAT, 'Setup-Wizard.bat', 'Maintain-IDevelop.ps1'])(
        '%s has no byte above 127',
        (f) => {
            const bytes = fs.readFileSync(path.join(INSTALLER, f));
            const bad = [];
            for (let i = 0; i < bytes.length; i += 1) if (bytes[i] > 127) bad.push(i);
            expect({ file: f, count: bad.length }).toEqual({ file: f, count: 0 });
        }
    );
});
