'use strict';
/**
 * « Usage by site » (/admin/usage, UsageService, 4.0.0 port wave 10). Pure
 * rules, the page rendered with the real locale files, and the figures on the
 * REAL schema inside a transaction that is always rolled back (invented
 * people; skipped without the test database):
 *   - a share is rounded DOWN, never up; nothing to measure is null, never 0 %;
 *   - a site of fewer than 5 people prints no figure;
 *   - the reader's clearance only; leavers and erased people out;
 *   - no name, no raw key, no inline handler; the page never says « adoption »
 *     (the module stages of Administration › Modules are another thing).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const fs = require('fs');

const U = require('../../src/services/UsageService');
const { render } = require('../helpers/vizRender');

const text = (h) =>
    h
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ');

describe('pure rules', () => {
    test('a share is rounded down, never up; no denominator is null', () => {
        expect(U.floorPct(1999, 2000)).toBe(99.9);
        expect(U.floorPct(2, 3)).toBe(66.6);
        expect(U.floorPct(0, 7)).toBe(0);
        expect(U.floorPct(0, 0)).toBeNull();
        expect(U.floorPct(3, null)).toBeNull();
    });
    test('under 5 people: no figure at all', () => {
        const r = U.siteRow({
            siteId: 4,
            siteName: 'Harbour',
            people: 4,
            activated: 4,
            selfAssessed: 1,
        });
        expect(r).toMatchObject({
            masked: true,
            activated: null,
            activatedPct: null,
            validated14Pct: null,
        });
    });
    test('5 people: counts and floored shares; no validation is « not measured »', () => {
        const r = U.siteRow({
            siteId: 4,
            siteName: 'Harbour',
            people: 6,
            activated: 5,
            selfAssessed: 2,
            approved: 0,
            approvedFast: 0,
        });
        expect(r).toMatchObject({
            masked: false,
            activated: 5,
            activatedPct: 83.3,
            selfAssessed: 2,
            selfAssessedPct: 33.3,
            approved: 0,
            validated14Pct: null,
        });
    });
    test('the total over several sites follows the same rules', () => {
        const t = U.totalRow([
            { people: 3, activated: 3, selfAssessed: 3, approved: 3, approvedFast: 3 },
            { people: 3, activated: 0, selfAssessed: 0, approved: 0, approvedFast: 0 },
        ]);
        expect(t).toMatchObject({ people: 6, activated: 3, activatedPct: 50, validated14Pct: 100 });
    });
});

describe('the page', () => {
    const model = {
        smallN: 5,
        windowDays: 90,
        validateDays: 14,
        people: 10,
        rows: [
            U.siteRow({
                siteId: 1,
                siteName: 'Harbour',
                people: 6,
                activated: 5,
                selfAssessed: 2,
                approved: 3,
                approvedFast: 2,
            }),
            U.siteRow({
                siteId: 2,
                siteName: 'Northfield',
                people: 4,
                activated: 4,
                selfAssessed: 4,
                approved: 4,
                approvedFast: 4,
            }),
            U.siteRow({
                siteId: null,
                siteName: null,
                people: 7,
                activated: 0,
                selfAssessed: 0,
                approved: 0,
                approvedFast: 0,
            }),
        ],
        total: null,
    };
    const page = (lang) => render('views/pages/admin/usage.ejs', { usage: model }, lang);

    test('counts and floored shares; under 5 people no figure; nothing measured in words', () => {
        const t = text(page('en'));
        expect(t).toMatch(/Harbour 6 5 83\.3% 2 33\.3% 66\.6% of 3 lines validated/);
        expect(t).toMatch(/Northfield 4 — Fewer than 5 people: no figure/);
        expect(t).not.toMatch(/Northfield 4 4/);
        expect(t).toMatch(/No site 7 0 0\.0% 0 0\.0% — Not measured yet/);
    });
    test('« Usage by site », never « adoption »; FR and EN clean', () => {
        for (const lang of ['fr', 'en']) {
            const html = page(lang);
            expect(html).not.toMatch(/\bus_[a-z_]+/);
            expect(html).not.toMatch(/\son[a-z]+="/i);
            expect(html).not.toMatch(/undefined|NaN/);
            expect(text(html)).not.toMatch(/adoption/i);
        }
        expect(text(page('fr'))).toMatch(/Usage par site/);
        expect(text(page('en'))).toMatch(/Usage by site/);
    });
    test('an empty clearance is one sentence', () => {
        const html = render('views/pages/admin/usage.ejs', { usage: { ...model, rows: [] } }, 'en');
        expect(text(html)).toMatch(/No person is within your clearance\./);
        expect(html).not.toMatch(/<table/);
    });
    test('the locale files never call it adoption', () => {
        for (const lang of ['fr', 'en']) {
            const a = JSON.parse(
                fs.readFileSync(
                    path.join(__dirname, '..', '..', 'locales', lang, 'admin.json'),
                    'utf8'
                )
            );
            const c = JSON.parse(
                fs.readFileSync(
                    path.join(__dirname, '..', '..', 'locales', lang, 'chrome.json'),
                    'utf8'
                )
            );
            const usage = Object.entries(a)
                .filter(([k]) => k.startsWith('us_'))
                .concat(Object.entries(c).filter(([k]) => k.startsWith('nav_usage')));
            expect(usage.length).toBeGreaterThan(10);
            expect(usage.filter(([, v]) => /adoption/i.test(v))).toEqual([]);
        }
    });
});

// ---------------------------------------------------------------------------
// The figures on the real schema
// ---------------------------------------------------------------------------
const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL || '');
const dbSuite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
const W = require('../helpers/kpiWorld');

if (HAS_DB) {
    beforeAll(async () => db.connect());
    afterAll(async () => db.close());
}

dbSuite('usage by site on the real schema (invented people, rolled back)', () => {
    test('per site of the clearance, masked under 5, floored, leavers out', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const F = await W.seedFacts(db);
            const site = async (name) =>
                Number(
                    (
                        await db.get('INSERT INTO sites (name) VALUES (?) RETURNING id', [
                            `${name}-${W.STAMP}`,
                        ])
                    ).id
                );
            const roleId = Number((await db.get('SELECT id FROM roles ORDER BY id LIMIT 1')).id);
            const big = await site('US-BIG');
            const small = await site('US-SMALL');
            const emp = async (tag, siteId, o = {}) =>
                Number(
                    (
                        await db.get(
                            `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                                    service_id, role_id, is_active, erased_at, last_login_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
                            [
                                `US-${tag}-${W.STAMP}`,
                                `Use${tag}`,
                                `Fixture${W.STAMP}`,
                                siteId,
                                F.ORG.departmentId,
                                F.ORG.serviceId,
                                roleId,
                                o.active !== false,
                                o.erased ? new Date() : null,
                                o.login ? new Date() : null,
                            ]
                        )
                    ).id
                );
            const P = [];
            for (let i = 0; i < 6; i++) P.push(await emp(`B${i}`, big, { login: i < 4 }));
            await emp('LEAVER', big, { active: false, login: true });
            await emp('ERASED', big, { erased: true, login: true });
            for (let i = 0; i < 3; i++) await emp(`S${i}`, small, { login: true });
            // P0: two lines approved in 3 and 20 days; P1: one line submitted, not approved
            const line = (person, skill, submittedAgo, approvedAfter) =>
                db.run(
                    `INSERT INTO self_assessment_rounds (employee_id, skill_id, self_rated_level, status, workflow_state,
                                                         submitted_at, approved_at, approved_by_ref)
                     VALUES (?, ?, 2, ?::self_assessment_state, ?, now() - (? || ' days')::interval,
                             CASE WHEN ?::int IS NULL THEN NULL
                                  ELSE now() - (? || ' days')::interval + (?::int || ' days')::interval END,
                             CASE WHEN ?::int IS NULL THEN NULL ELSE 'admin:1' END)`,
                    [
                        person,
                        skill,
                        approvedAfter === null ? 'submitted' : 'approved',
                        approvedAfter === null ? 'submitted' : 'approved',
                        String(submittedAgo),
                        approvedAfter,
                        String(submittedAgo),
                        approvedAfter,
                        approvedAfter,
                    ]
                );
            await line(P[0], F.SKILLS[0], 30, 3);
            await line(P[0], F.SKILLS[1], 40, 20);
            await line(P[1], F.SKILLS[0], 10, null);
            // a line older than 90 days does not count
            await line(P[2], F.SKILLS[0], 120, 2);
            const all = await U.bySite(F.SUPER);
            // a local administrator scoped to the big site only
            const la = await db.get(
                `INSERT INTO admins (username, email, password_hash, role, is_active, force_password_change)
                 VALUES (?, ?, 'x', 'localadmin', true, false) RETURNING id`,
                [`us-local-${W.STAMP}`, `us-local-${W.STAMP}@example.test`]
            );
            await db.run(
                `INSERT INTO admin_scopes (admin_id, scope_type, site_id) VALUES (?, 'site', ?)`,
                [Number(la.id), big]
            );
            const local = await U.bySite({
                id: Number(la.id),
                userType: 'admin',
                role: 'localadmin',
                permissions: ['view_employees'],
            });
            return { all, local, big, small };
        });
        const bigRow = out.all.rows.find((r) => r.siteId === out.big);
        expect(bigRow).toMatchObject({
            people: 6,
            masked: false,
            activated: 4,
            activatedPct: 66.6,
            selfAssessed: 2,
            selfAssessedPct: 33.3,
            approved: 2,
            validated14Pct: 50,
        });
        const smallRow = out.all.rows.find((r) => r.siteId === out.small);
        expect(smallRow).toMatchObject({
            people: 3,
            masked: true,
            activated: null,
            activatedPct: null,
        });
        expect(out.all.total).not.toBeNull();
        expect(out.local.rows.map((r) => r.siteId)).toEqual([out.big]);
        expect(out.local.total).toBeNull();
        const json = JSON.stringify(out.all);
        expect(json).not.toMatch(/Use[BS]\d|Fixture|LEAVER|ERASED|employeeId/);
    });
});
