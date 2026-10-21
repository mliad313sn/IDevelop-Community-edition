'use strict';
/**
 * « Data quality » (/admin/data-quality, 4.0.0 port wave 10): the pure rules
 * of DataQualityService and the page rendered from models with the real
 * locale files, no database.
 *   - a 0 is « no anomaly » only when the population is above 0; an empty
 *     population is « nothing concerned », never 0 % and never « done »;
 *   - « not configured » and « not measured » are states, never a count;
 *   - under 5 records: the count, no %; a non-zero count never prints 0.0 %;
 *   - each section is computed only for the permission that opens its module;
 *     the rail's gate is the route's gate;
 *   - the page prints no name, no raw key, no inline handler (FR and EN).
 */
jest.mock('../../src/config/database', () => ({ get: jest.fn(), all: jest.fn(), run: jest.fn() }));
const fs = require('fs');
const path = require('path');
const { render } = require('../helpers/vizRender');
const DQ = require('../../src/services/DataQualityService');

const text = (h) =>
    h
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ');

const admin = (permissions, role = 'localadmin') => ({
    id: 7,
    userType: 'admin',
    role,
    permissions,
});

describe('row status: decided on what the page prints', () => {
    test('population 0 is « nothing concerned », never « no anomaly »', () => {
        expect(DQ.rowStatus({ count: 0, population: 0 })).toEqual({
            tone: 'neutral',
            status: 'empty',
        });
        expect(DQ.rowStatus({ count: 0, population: 12 })).toEqual({
            tone: 'good',
            status: 'clean',
        });
    });
    test('not configured and unavailable never become a count', () => {
        expect(DQ.rowStatus({ state: 'not_configured', count: 0, population: 9 }).status).toBe(
            'not_configured'
        );
        expect(DQ.rowStatus({ state: 'unavailable', count: 0, population: 9 }).status).toBe(
            'unavailable'
        );
        expect(DQ.rowStatus({ count: null, population: 9 }).status).toBe('unavailable');
        const f = DQ.finishRow({ key: 'x', state: 'not_configured', count: 3, population: 10 });
        expect(f.pct).toBeNull();
    });
    test('an alert row is « to deal with », another « to complete »', () => {
        expect(DQ.rowStatus({ count: 2, population: 9, alert: true }).status).toBe('todo');
        expect(DQ.rowStatus({ count: 2, population: 9 }).status).toBe('complete');
        expect(DQ.rowStatus({ state: 'info', alert: true }).status).toBe('todo');
        expect(DQ.rowStatus({ state: 'info' }).status).toBe('info');
    });
});

describe('the share beside a count', () => {
    test('under 5 records: no %', () => {
        expect(DQ.rowShare(1, 4)).toEqual({ pct: null, tiny: false });
        expect(DQ.rowShare(0, 0)).toEqual({ pct: null, tiny: false });
        expect(DQ.rowShare(null, 40)).toEqual({ pct: null, tiny: false });
    });
    test('from 5 records: one decimal; a non-zero count never reads 0.0 %', () => {
        expect(DQ.rowShare(1, 8)).toEqual({ pct: 12.5, tiny: false });
        expect(DQ.rowShare(1, 5000)).toEqual({ pct: 0, tiny: true });
        expect(DQ.rowShare(0, 5000)).toEqual({ pct: 0, tiny: false });
    });
});

describe('seals and the outside anchor', () => {
    test('the month to seal is due after the 5th', () => {
        expect(DQ.sealDueMonth('2026-10-05T12:00:00Z')).toBeNull();
        expect(DQ.sealDueMonth('2026-10-06T12:00:00Z')).toBe('2026-09');
        expect(DQ.sealDueMonth('2027-01-20T12:00:00Z')).toBe('2026-12');
        expect(DQ.sealDueMonth('not a date')).toBeNull();
    });
    test('the anchor needs attention after a failure or a silent week', () => {
        expect(DQ.anchorAlert({ fresh: true, lastRunOk: true })).toBe(false);
        expect(DQ.anchorAlert({ fresh: true, lastRunOk: false })).toBe(true);
        expect(DQ.anchorAlert({ fresh: false, lastRunOk: true })).toBe(true);
    });
});

describe('each section behind the permission of its module', () => {
    const ON = { development: true };
    test('SuperAdmin sees every section; the development one only with its module', () => {
        const sa = admin([], 'superadmin');
        expect(DQ.sectionsFor(sa, ON)).toEqual(DQ.SECTIONS);
        expect(DQ.sectionsFor(sa, {})).not.toContain('development');
    });
    test('a local administrator sees the sections of the permissions they hold', () => {
        expect(DQ.sectionsFor(admin(['view_employees']), ON)).toEqual(['people', 'development']);
        expect(DQ.sectionsFor(admin(['view_roles']), ON)).toEqual(['framework']);
        expect(DQ.sectionsFor(admin(['view_compliance']), ON)).toEqual(['certificates']);
        expect(DQ.sectionsFor(admin(['view_system_logs']), ON)).toEqual(['audit']);
        expect(DQ.sectionsFor(admin([]), ON)).toEqual([]);
        expect(DQ.canSeePanel(admin([]))).toBe(false);
        expect(DQ.canSeePanel(admin(['view_roles']))).toBe(true);
    });
    test('a manager or an employee never sees it', () => {
        expect(DQ.sectionsFor({ id: 3, userType: 'manager' }, ON)).toEqual([]);
        expect(DQ.canSeePanel({ id: 3, userType: 'employee' })).toBe(false);
    });
    test('the rail and the route use the same six permissions', () => {
        const nav = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'config', 'navigation.js'),
            'utf8'
        );
        const block = nav.slice(
            nav.indexOf('data_quality:\n'),
            nav.indexOf("// Route: requireAdmin + requirePermission('view_employees')")
        );
        const slugs = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
        expect(slugs).toEqual([...DQ.PANEL_SLUGS]);
        const routes = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'routes', 'index.js'),
            'utf8'
        );
        expect(routes).toMatch(
            /'\/admin\/data-quality',\s*requireAnyPermission\(\.\.\.DQ\.PANEL_SLUGS\)/
        );
    });
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------
const row = (o) => DQ.finishRow(o);
const model = {
    scoped: true,
    population: 42,
    todo: 1,
    sections: [
        {
            key: 'people',
            scoped: true,
            failed: false,
            rows: [
                row({
                    key: 'no_line',
                    count: 3,
                    population: 42,
                    alert: true,
                    href: '/employees?missingReviewer=1',
                }),
                row({ key: 'no_role', count: 0, population: 42, href: '/employees' }),
                row({ key: 'no_requirement', count: 1, population: 4000, href: '/roles' }),
                row({ key: 'no_role_start', count: 2, population: 3, href: '/employees' }),
            ],
        },
        {
            key: 'certificates',
            scoped: true,
            failed: false,
            rows: [
                row({
                    key: 'cert_missing',
                    state: 'not_configured',
                    count: null,
                    population: null,
                    href: '/compliance',
                }),
                row({ key: 'cert_no_issuer', count: 0, population: 0, href: '/compliance' }),
            ],
        },
        {
            key: 'audit',
            scoped: false,
            failed: false,
            rows: [
                row({
                    key: 'audit_chain',
                    state: 'unavailable',
                    count: null,
                    population: null,
                    href: null,
                }),
                row({
                    key: 'audit_seal',
                    state: 'info',
                    alert: false,
                    facts: { last: '2026-09', due: '2026-09' },
                    href: '/system-logs',
                }),
            ],
        },
        { key: 'privacy', scoped: false, failed: true, rows: [] },
    ],
};
const page = (lang = 'fr', m = model) =>
    render('views/pages/admin/data-quality.ejs', { dq: m, fmtDate: (d) => String(d) }, lang);

describe('the page', () => {
    test('counts « of N », a % from 5 records, « under 0.1 % » never 0', () => {
        const t = text(page('en'));
        expect(t).toMatch(/People nobody reviews .*? 3 of 42 people 7\.1% ▲ To deal with Open/);
        expect(t).toMatch(/People without a role 0 of 42 people 0\.0% ✓ No anomaly/);
        expect(t).toMatch(/1 of 4,000 people under 0.1%/);
        // 3 people: the count, no %
        expect(t).toMatch(
            /People without a role start date \(time to competence\) 2 of 3 people ! To complete/
        );
    });
    test('not configured, nothing concerned and not measured are words, never 0', () => {
        const html = page('en');
        const t = text(html);
        expect(html).toMatch(/data-dq-row="cert_missing" data-dq-status="not_configured"/);
        expect(t).toMatch(/Required certificates not on record — Not configured/);
        expect(t).toMatch(/Certificates without an issuer · Nothing concerned/);
        expect(t).not.toMatch(/Certificates without an issuer 0/);
        expect(t).toMatch(/Breaks in the activity log chain — Not measured/);
        expect(t).toMatch(/last sealed month 2026-09/);
        expect(html).toMatch(/data-dq-failed/);
    });
    test('the scope is said; the « to deal with » summary is counted', () => {
        const t = text(page('fr'));
        expect(t).toMatch(
            /Les chiffres des personnes portent sur les 42 personnes de votre périmètre\./
        );
        expect(t).toMatch(/1 ligne à traiter/);
        expect(t).toMatch(/Dans votre périmètre\./);
    });
    test('a link only where the row carries one', () => {
        const html = page('en');
        expect(html).not.toMatch(
            /data-dq-row="audit_chain"[\s\S]*?<a class="btn[^>]*>Open[\s\S]*?data-dq-row="audit_seal"/
        );
        expect(html).toMatch(/href="\/employees\?missingReviewer=1"/);
    });
    test('nothing visible: one sentence, no section', () => {
        const html = page('en', { sections: [], scoped: true, population: null });
        expect(text(html)).toMatch(/None of the areas of this page is open to your account\./);
        expect(html).not.toMatch(/data-dq-section/);
    });
    test('FR and EN: no raw key, no inline handler, no « undefined »', () => {
        for (const lang of ['fr', 'en']) {
            const html = page(lang);
            expect(html).not.toMatch(/\bdq_[a-z_]+/);
            expect(html).not.toMatch(/\son[a-z]+="/i);
            expect(html).not.toMatch(/undefined|NaN|\[object Object\]/);
        }
    });
});
