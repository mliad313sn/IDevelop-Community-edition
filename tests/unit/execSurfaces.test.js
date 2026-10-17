'use strict';
/**
 * The three new executive pages: SiteExposureService (built on KpiService), the
 * continuity-grant gate on key-person data, and the view-level hygiene rules
 * this codebase has been bitten by before (a nonce-less inline script is
 * silently blocked by CSP; a missing locale key renders as a raw key).
 */

// DB-free: these suites exercise pure arithmetic, the visibility predicate and
// static view/locale files. src/config/database throws at require time without
// DATABASE_URL, so it is mocked before anything pulls it in transitively.
jest.mock('../../src/config/database', () => ({
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
}));

const fs = require('fs');
const path = require('path');

const VIEW_DIR = path.join(__dirname, '../../views/pages/exec');
const VIEWS = ['key-person.ejs', 'site-exposure.ejs', 'board-pack.ejs'];

// ---------------------------------------------------------------------------
// SiteExposureService
// ---------------------------------------------------------------------------
describe('SiteExposureService', () => {
    const SiteExposureService = require('../../src/services/SiteExposureService');
    const site = (id, k1, k2, extra = {}) => ({
        siteId: id,
        siteName: 'Site ' + id,
        noSite: false,
        smallN: false,
        k1: { value: k1, numerator: 3, denominator: 6 },
        k2: { value: k2 },
        ...extra,
    });

    test('the footer IS the organisation KPI result, never a sum or a mean of site %', () => {
        // Averaging per-site percentages would give a different number from the
        // dashboard's: the footer is handed the organisation's own result.
        const org = { headcount: 15, k1: { value: 63.3 }, k3: { value: 50 } };
        expect(
            SiteExposureService.totals([{ k1: { value: 50 } }, { k1: { value: 90 } }], org)
        ).toBe(org);
        expect(SiteExposureService.totals([], null)).toBeNull();
    });

    test('the two « weakest site » answers are named apart', () => {
        const w = SiteExposureService.weakestSites([
            site(1, 40, 85),
            site(2, 70, 60),
            site(3, 80, 90),
        ]);
        expect(w.ready).toMatchObject({ siteId: 1, value: 40, numerator: 3, denominator: 6 });
        expect(w.level).toMatchObject({ siteId: 2, value: 60 });
        expect(w.same).toBe(false);
        const one = SiteExposureService.weakestSites([site(1, 40, 55), site(2, 70, 60)]);
        expect(one.same).toBe(true);
    });

    test('small sites and « No site » never decide the readiness answer; under 2 sites: none', () => {
        const w = SiteExposureService.weakestSites([
            site(1, 10, 20, { smallN: true }),
            { ...site(null, 5, 5), noSite: true },
            site(2, 70, 60),
            site(3, 80, 90),
        ]);
        expect(w.ready.siteId).toBe(2);
        expect(SiteExposureService.weakestSites([site(1, 40, 85)])).toBeNull();
        expect(SiteExposureService.weakestSites([])).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Key-person visibility gate
// ---------------------------------------------------------------------------
describe('canSeeKeyPerson — naming a sole holder is continuity-grade', () => {
    const { canSeeKeyPerson } = require('../../src/controllers/ExecDecisionController');

    test('managers and superadmins qualify', () => {
        expect(canSeeKeyPerson({ userType: 'manager', id: 5 })).toBe(true);
        expect(canSeeKeyPerson({ userType: 'admin', role: 'superadmin' })).toBe(true);
    });

    test('a local admin needs a continuity grant', () => {
        expect(canSeeKeyPerson({ userType: 'admin', role: 'localadmin', permissions: [] })).toBe(
            false
        );
        expect(
            canSeeKeyPerson({
                userType: 'admin',
                role: 'localadmin',
                permissions: ['manage_employees'],
            })
        ).toBe(false);
        expect(
            canSeeKeyPerson({
                userType: 'admin',
                role: 'localadmin',
                permissions: ['view_continuity'],
            })
        ).toBe(true);
    });

    test('a self-service employee never qualifies', () => {
        expect(canSeeKeyPerson({ userType: 'employee', id: 9 })).toBe(false);
        expect(canSeeKeyPerson(null)).toBe(false);
        expect(canSeeKeyPerson({})).toBe(false);
    });

    test('a missing permissions array does not throw or admit', () => {
        expect(canSeeKeyPerson({ userType: 'admin', role: 'localadmin' })).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// View hygiene
// ---------------------------------------------------------------------------
describe('exec views — CSP, i18n and branding hygiene', () => {
    test('every inline <script> carries a CSP nonce', () => {
        // A nonce-less inline script is silently blocked and the page
        // half-works — this has bitten this project before (/reports/builder).
        //
        // The tag is matched by its opening only: an EJS tag contains "%>", so
        // a naive /<script[^>]*>/ would stop inside the nonce expression itself
        // and wrongly report a miss.
        let checked = 0;
        for (const v of VIEWS) {
            const src = fs.readFileSync(path.join(VIEW_DIR, v), 'utf8');
            for (const m of src.matchAll(/<script\b/g)) {
                const head = src.slice(m.index, m.index + 200);
                if (/\bsrc=/.test(head.split('>')[0])) {
                    // external script: CSP-safe by construction, still counted
                    checked++;
                    continue;
                }
                expect(`${v} @${m.index}: ${head.slice(0, 80)}`).toMatch(/nonce="<%= cspNonce %>"/);
                checked++;
            }
        }
        // Guard against the test silently passing because it found no scripts.
        expect(checked).toBeGreaterThan(0);
    });

    test('no view hardcodes the product name (branding is white-label)', () => {
        for (const v of VIEWS) {
            const src = fs.readFileSync(path.join(VIEW_DIR, v), 'utf8');
            expect(`${v}`).toBeDefined();
            expect(src).not.toMatch(/IDevelop/);
        }
    });

    test('the board pack’s Print button actually calls window.print()', () => {
        // The report builder's Print button only toggled a CSS class and never
        // printed, leaving the user to find Ctrl+P.
        // CSP: no inline handler — the view marks the button, a served script prints.
        const src = fs.readFileSync(path.join(VIEW_DIR, 'board-pack.ejs'), 'utf8');
        expect(src).toMatch(/<button[^>]*data-print/);
        expect(src).toMatch(/src="\/js\/board-pack\.js/);
        const js = fs.readFileSync(path.join(__dirname, '../../public/js/board-pack.js'), 'utf8');
        expect(js).toMatch(/window\.print\(\)/);
        const css = fs.readFileSync(path.join(__dirname, '../../public/css/dashboard.css'), 'utf8');
        expect(css).toMatch(/@media print/);
    });

    test('every exec: key used in the views and controller exists in FR and EN', () => {
        const fr = require('../../locales/fr/exec.json');
        const en = require('../../locales/en/exec.json');
        const sources = [
            ...VIEWS.map((v) => path.join(VIEW_DIR, v)),
            path.join(__dirname, '../../src/controllers/ExecDecisionController.js'),
            path.join(__dirname, '../../views/partials/sidebar.ejs'),
            path.join(__dirname, '../../src/config/navigation.js'),
        ];
        const used = new Set();
        for (const f of sources) {
            const src = fs.readFileSync(f, 'utf8');
            for (const m of src.matchAll(/['"]exec:([a-z0-9_]+)['"]/g)) used.add(m[1]);
        }
        expect(used.size).toBeGreaterThan(30);
        const missingFr = [...used].filter((k) => fr[k] === undefined);
        const missingEn = [...used].filter((k) => en[k] === undefined);
        expect(missingFr).toEqual([]);
        expect(missingEn).toEqual([]);
    });

    test('FR and EN exec dictionaries are at full parity', () => {
        const fr = Object.keys(require('../../locales/fr/exec.json')).sort();
        const en = Object.keys(require('../../locales/en/exec.json')).sort();
        expect(fr).toEqual(en);
    });

    test('no exec key contains a dot (i18next keySeparator is ".")', () => {
        for (const k of Object.keys(require('../../locales/fr/exec.json'))) {
            expect(k).not.toMatch(/\./);
        }
    });

    test('the exec namespace is registered with i18next', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/config/i18n.js'), 'utf8');
        expect(src).toMatch(/'exec'/);
    });

    test('each page has a designed empty state rather than an empty table', () => {
        for (const v of ['key-person.ejs', 'site-exposure.ejs']) {
            const src = fs.readFileSync(path.join(VIEW_DIR, v), 'utf8');
            expect(`${v}`).toBeDefined();
            expect(src).toMatch(/empty-card/);
            expect(src).toMatch(/_empty_body/);
        }
    });
});

// ---------------------------------------------------------------------------
// Job registration
// ---------------------------------------------------------------------------
describe('kpi-snapshot tick registration', () => {
    test('the snapshot job is in the shared TICKS registry', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/jobs/index.js'), 'utf8');
        expect(src).toMatch(/kpi-snapshot\.tick/);
        // Both runtimes iterate TICKS, so registering once covers BullMQ and
        // the in-process scheduler (the v3.22.3 drift bug).
        const entry = src.slice(src.indexOf("'kpi-snapshot.tick'"));
        expect(entry.slice(0, 200)).toMatch(/cron:/);
        expect(entry.slice(0, 200)).toMatch(/everyMin:/);
    });
});
