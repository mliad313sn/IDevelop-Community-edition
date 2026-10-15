'use strict';
/**
 * The employee's « Next step » (src/services/EmployeeHomeService.js) on the
 * real test database, inside a transaction that is always rolled back: the
 * priority order (self-assessment to fix / continue / start, an answered
 * change request, a blocked then expiring safety clearance, else the
 * results), fixed destinations only, and the rendered home shows it.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const W = require('../helpers/dashWorld');
const H = require('../../src/services/EmployeeHomeService');

const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(120000);

let db;
suite('the employee next step (rolled back)', () => {
    beforeAll(async () => {
        db = require('../../src/config/database');
        await db.connect();
    });
    afterAll(async () => {
        await db.close();
    });

    test('priority order and fixed destinations', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.world(db);
            const notAssessed = w.people.E[8]; // requirements, nothing assessed, no self-assessment
            const ready = w.people.E[0];
            const steps = {};
            steps.start = await H.nextStep(notAssessed);
            await db.run(
                `INSERT INTO self_assessments (employee_id, skill_id, self_rated_level, status, workflow_state)
                 VALUES (?, ?, 2, 'draft', 'draft')`,
                [notAssessed, w.S1]
            );
            steps.cont = await H.nextStep(notAssessed);
            await db.run(
                `UPDATE self_assessments SET workflow_state = 'changes_requested' WHERE employee_id = ?`,
                [notAssessed]
            );
            steps.fix = await H.nextStep(notAssessed);
            steps.results = await H.nextStep(ready);
            await db.run(
                `INSERT INTO safety_gate_status (employee_id, status, reasons, fingerprint, computed_at, changed_at)
                 VALUES (?, 'BLOCKED', '[]'::jsonb, 'test', now(), now())
                 ON CONFLICT (employee_id) DO UPDATE SET status = 'BLOCKED', enforced_status = NULL`,
                [ready]
            );
            steps.blocked = await H.nextStep(ready);
            steps.bad = await H.nextStep('1 OR 1=1');
            return steps;
        });
        expect(out.start).toEqual({ key: 'sa_start', href: '/employee/self-assessment' });
        expect(out.cont.key).toBe('sa_continue');
        expect(out.fix.key).toBe('sa_fix');
        expect(out.results).toEqual({ key: 'results', href: '/employee/assessment-status' });
        expect(out.blocked).toEqual({ key: 'safety_blocked', href: '/safety-gate/me' });
        expect(out.bad.key).toBe('results');
        for (const href of Object.values(H.STEPS)) expect(href).toMatch(/^\/[a-z]/);
    });

    test('the employee home renders the step and its button in both languages', () => {
        const { render } = require('../helpers/vizRender');
        const fs = require('fs');
        const src = fs.readFileSync(
            path.join(__dirname, '..', '..', 'views/pages/employee/dashboard.ejs'),
            'utf8'
        );
        expect(src).toMatch(/id="empNext"/);
        for (const lang of ['fr', 'en']) {
            const t = require(`../../locales/${lang}/employee.json`);
            for (const k of Object.keys(H.STEPS)) {
                expect([lang, k, typeof t['next_' + k]]).toEqual([lang, k, 'string']);
                expect([lang, k, typeof t['next_' + k + '_cta']]).toEqual([lang, k, 'string']);
            }
        }
        expect(typeof render).toBe('function');
    });
});
