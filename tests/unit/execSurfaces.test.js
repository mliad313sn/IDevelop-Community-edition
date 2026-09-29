'use strict';
/**
 * The three new executive pages: SiteExposureService arithmetic, the
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

    test('totals re-derive coverage from summed numerator/denominator', () => {
        // Averaging per-site percentages would give a different number from the
        // dashboard's. Coverage must be assessed/expected over the whole set.
        const t = SiteExposureService.totals([
            { assessedRequirements: 100, expectedRequirements: 200, headcount: 10 },
            { assessedRequirements: 90, expectedRequirements: 100, headcount: 5 },
        ]);
        expect(t.assessedRequirements).toBe(190);
        expect(t.expectedRequirements).toBe(300);
        expect(t.coverage).toBeCloseTo(63.3, 1); // NOT (50+90)/2 = 70
        expect(t.headcount).toBe(15);
    });

    test('totals report null coverage when nothing is expected (no divide-by-zero 0%)', () => {
        const t = SiteExposureService.totals([
            { assessedRequirements: 0, expectedRequirements: 0 },
        ]);
        expect(t.coverage).toBeNull();
    });

    test('totals of an empty set are zeros with null coverage, not NaN', () => {
        const t = SiteExposureService.totals([]);
        expect(t.headcount).toBe(0);
        expect(t.soleHolder).toBe(0);
        expect(t.coverage).toBeNull();
        expect(Number.isNaN(t.headcount)).toBe(false);
    });

    test('never-measured is summed as its own column, separate from the risk bands', () => {
        const t = SiteExposureService.totals([
            { soleHolder: 2, noQualified: 3, neverMeasured: 100 },
            { soleHolder: 1, noQualified: 1, neverMeasured: 60 },
        ]);
        expect(t.soleHolder).toBe(3);
        expect(t.noQualified).toBe(4);
        expect(t.neverMeasured).toBe(160);
        // The unknowns are never folded into the risk numbers.
        expect(t.soleHolder + t.noQualified).toBe(7);
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
                if (/\bsrc=/.test(head.split('>')[0])) continue; // external script
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
        const src = fs.readFileSync(path.join(VIEW_DIR, 'board-pack.ejs'), 'utf8');
        expect(src).toMatch(/window\.print\(\)/);
        expect(src).toMatch(/@media print/);
    });

    test('every exec: key used in the views and controller exists in FR and EN', () => {
        const fr = require('../../locales/fr/exec.json');
        const en = require('../../locales/en/exec.json');
        const sources = [
            ...VIEWS.map((v) => path.join(VIEW_DIR, v)),
            path.join(__dirname, '../../src/controllers/ExecDecisionController.js'),
            path.join(__dirname, '../../views/partials/sidebar.ejs'),
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
