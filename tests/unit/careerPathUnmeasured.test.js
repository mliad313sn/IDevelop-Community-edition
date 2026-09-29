'use strict';

/**
 * N7 — the career-path projection printed "0" and a red gap for skills nobody
 * has assessed, and 0 % readiness for a target role with no measured evidence.
 *
 * careerPathData joined raw skill_assessments with COALESCE(current_level, 0),
 * so a never-assessed requirement of the TARGET role read as "current 0, gap
 * = required" and folded into met/total as a failure. It now reads the resolved
 * view (validated + approved self), honours a lapsed certificate, excludes
 * required_level = 0, and returns current/gap null for the unmeasured with
 * readiness over the measured requirements (null when none) plus coverage.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// Needs a POPULATED database (several sites, assessed people, reviews): runs
// only against an opt-in fixture database — see CONTRIBUTING.md.
const HAS_DB = /idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;

let ctrl;
const RBACService = require('../../src/services/RBACService');

beforeAll(async () => {
    if (HAS_DB) await db.connect();
    ctrl = require('../../src/controllers/TalentActionsController');
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const call = async (employeeId, targetRoleId) => {
    const req = {
        query: { employeeId, targetRoleId },
        user: { id: 1, userType: 'admin', role: 'superadmin' },
        t: null,
    };
    let body = null;
    let code = 200;
    const res = {
        status(c) {
            code = c;
            return this;
        },
        json(b) {
            body = b;
            return this;
        },
    };
    // superadmin bypasses the scope guard; guard against RBAC surprises anyway
    jest.spyOn(RBACService, 'isSuperAdmin').mockReturnValue(true);
    await ctrl.careerPathData(req, res);
    return { code, body };
};

suite('career-path never fabricates a 0 for the unmeasured', () => {
    test('a fully-unmeasured projection returns null readiness, null current/gap, coverage 0', async () => {
        // employee 286 has zero assessments; project onto role 87 (63 reqs)
        const { code, body } = await call(286, 87);
        expect(code).toBe(200);
        expect(body.readiness).toBeNull(); // was 0
        expect(body.coverage).toBe(0);
        expect(body.measured).toBe(0);
        expect(body.total).toBeGreaterThan(0);
        for (const r of body.rows) {
            expect(r.assessed).toBe(false);
            expect(r.current).toBeNull(); // was 0
            expect(r.gap).toBeNull(); // was `required`
        }
        // nobody measured => no fabricated critical gaps
        expect(body.criticalGaps).toBe(0);
    });

    test('a partially-measured projection reports readiness over the measured only', async () => {
        // employee 158 is assessed on 51 of role 87's 63 requirements
        const { code, body } = await call(158, 87);
        expect(code).toBe(200);
        expect(body.measured).toBe(51);
        expect(body.total).toBe(63);
        expect(body.coverage).toBe(Math.round((51 / 63) * 100));
        expect(body.readiness).not.toBeNull();
        // readiness is met / measured, both drawn from assessed rows only
        const assessed = body.rows.filter((r) => r.assessed);
        expect(assessed.length).toBe(51);
        const met = assessed.filter((r) => r.met).length;
        expect(body.readiness).toBe(Math.round((met / 51) * 100));
        // the 12 unmeasured requirements carry null, not a gap
        const unmeasured = body.rows.filter((r) => !r.assessed);
        expect(unmeasured.length).toBe(12);
        for (const r of unmeasured) expect(r.gap).toBeNull();
    });

    test('the query reads the resolved view and honours a lapse, not raw skill_assessments', () => {
        const fs = require('fs');
        const src = fs
            .readFileSync(
                path.join(__dirname, '../../src/controllers/TalentActionsController.js'),
                'utf8'
            )
            .replace(/\s+/g, ' ');
        expect(src).toMatch(/LEFT JOIN v_resolved_assessments ra/);
        expect(src).toMatch(/LEFT JOIN v_certification_lapsed cl/);
        expect(src).not.toMatch(/COALESCE\(sa\.current_level, 0\) AS current/);
        expect(src).toMatch(/rsr\.required_level > 0/);
    });
});
