'use strict';
/**
 * « Exposure by site » rebuilt on KpiService (contract kpi-2), on the real test
 * database (the invented KPI world, inside a transaction that is always rolled
 * back):
 *   - every column is the dashboard indicator for that site: K1, K3, K8 per
 *     site are KpiService.bySite, K2 is k2ByUnit; the footer is the
 *     organisation's result;
 *   - a site under 5 people (here « No site », one person) prints counts only:
 *     no percentage, no status colour;
 *   - the page carries no person name, and the two « weakest site » answers
 *     are named apart when they differ.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const W = require('../helpers/kpiWorld');
const { render } = require('../helpers/vizRender');

const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(180000);

let db;
let F;

suite('site exposure on KpiService (rolled back)', () => {
    beforeAll(async () => {
        db = require('../../src/config/database');
        await db.connect();
        F = await W.seedFacts(db);
    });
    afterAll(async () => {
        await db.close();
    });

    test('every column is the KPI for that site; the footer is the organisation', async () => {
        const K = require('../../src/services/KpiService');
        const S = require('../../src/services/SiteExposureService');
        const out = await W.inRolledBackTx(db, async (q) => {
            const w = await W.world(db, F, q);
            const viewer = F.SUPER;
            const s = { viewer };
            return {
                w,
                se: await S.bySite(viewer, { keyPerson: true }),
                k1: await K.bySite('K1', s),
                k3: await K.bySite('K3', s),
                k8: await K.bySite('K8', s),
                k2: await K.k2ByUnit(s, 'site'),
                org1: await K.compute('K1', s),
            };
        });
        const key = (r) => (r.noSite || r.siteId == null ? 'none' : String(r.siteId));
        const by = (b) => new Map(b.rows.map((r) => [key(r), r.result]));
        const i1 = by(out.k1);
        const i3 = by(out.k3);
        const i8 = by(out.k8);
        expect(out.se.rows.length).toBe(out.k1.rows.length);
        for (const r of out.se.rows) {
            const k = key(r);
            expect(r.k1.value).toBe(i1.get(k).value);
            expect(r.k1.denominator).toBe(i1.get(k).denominator);
            expect(r.k3.value).toBe(i3.get(k).value);
            if (r.k8) {
                const b8 = i8.get(k).breakdown || {};
                expect(r.k8.expired).toBe(b8.expiredPeople === undefined ? null : b8.expiredPeople);
                expect(r.k8.status).toBe(i8.get(k).status);
            }
            const u = out.k2.units.get(k);
            expect(r.k2.value).toBe(u ? u.value : null);
        }
        expect(out.se.org.k1.value).toBe(out.org1.value);
        expect(out.se.org.k1.denominator).toBe(out.org1.denominator);
        expect(out.se.org.headcount).toBe(out.se.scope.employeeCount);
        expect(out.se.scope.unrestricted).toBe(true);

        // « No site » holds H only: under 5 people, counts only
        const none = out.se.rows.find((r) => r.noSite);
        expect(none).toBeDefined();
        expect(none.smallN).toBe(true);

        const html = render('views/pages/exec/site-exposure.ejs', {
            rows: out.se.rows,
            totals: out.se.org,
            weakest: out.se.weakest,
            scope: out.se.scope,
            showKeyPerson: true,
        });
        // no person of the fixture world is named
        expect(html).not.toMatch(new RegExp('Fixture' + W.STAMP));
        expect(html).not.toMatch(/KPI-[A-Z0-9]+-\d/);
        const row = html.slice(
            html.indexOf('data-site="none"'),
            html.indexOf('</tr>', html.indexOf('data-site="none"'))
        );
        expect(row).not.toMatch(/\d ?%/);
        expect(row).not.toMatch(/class="(good|warn|bad)"/);
        // the footer is there, and no « above 100 % » anywhere
        expect(html).toMatch(/<tfoot>/);
        const pcts = [...html.matchAll(/(\d{3,})(?:,\d)? ?%/g)].map((m) => Number(m[1]));
        expect(pcts.filter((v) => v > 100)).toEqual([]);
    });
});
