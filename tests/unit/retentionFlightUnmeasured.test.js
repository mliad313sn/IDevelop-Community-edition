'use strict';

/**
 * T3 — flight_risk published "low" for people who had no flight signal at all.
 *
 * flightScore is additive-only, so 0 means "we found no signal", and
 * bandFromFlight(0) = 'low'. A person with no 9-box placement, no active PIP and
 * no recent survey answer was stored as "low flight risk" — a reassuring verdict
 * drawn from the absence of any measurement (72 of 76 on the dev dataset). This
 * is the exact disease migration 135 fixed for impact_of_loss.
 *
 * Flight is now measured only when at least one real input exists (placement,
 * active PIP, or survey engagement); otherwise flight_risk is null. Migration
 * 137 drops the NOT NULL DEFAULT 'low' that made the fabrication mandatory.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// Needs a POPULATED database (several sites, assessed people, reviews): runs
// only against an opt-in fixture database — see CONTRIBUTING.md.
const HAS_DB = /idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
const RetentionRiskService = HAS_DB ? require('../../src/services/RetentionRiskService') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const noSignal = `e.is_active = true
    AND NOT EXISTS (SELECT 1 FROM nine_box_evaluations n WHERE n.employee_id = e.id AND n.status = 'approved')
    AND NOT EXISTS (SELECT 1 FROM talent_placements p WHERE p.employee_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM pips WHERE employee_id = e.id AND state = 'active')
    AND NOT EXISTS (SELECT 1 FROM survey_responses r WHERE r.employee_id = e.id AND r.score IS NOT NULL)`;

suite('flight risk is unknown, not "low", when nothing was measured', () => {
    test('the column accepts null (migration 137)', async () => {
        const col = await db.get(
            `SELECT is_nullable FROM information_schema.columns
              WHERE table_name = 'retention_risk' AND column_name = 'flight_risk'`
        );
        expect(col.isNullable).toBe('YES');
    });

    test('a person with no signal bands flight null, not low', async () => {
        const e = await db.get(`SELECT e.id FROM employees e WHERE ${noSignal} LIMIT 1`);
        expect(e).toBeTruthy(); // the fixture must contain such a person
        const s = await RetentionRiskService._signals(e.id);
        expect(s.flightBand).toBeNull();
        expect(s.flightScore).toBeNull();
        expect(s.factors.flightMeasured).toBe(false);
    });

    test('a person with a real signal still gets a flight band', async () => {
        const p = await db.get(
            "SELECT employee_id AS id FROM nine_box_evaluations WHERE status = 'approved' LIMIT 1"
        );
        const s = await RetentionRiskService._signals(p.id);
        expect(['low', 'medium', 'high']).toContain(s.flightBand);
        expect(s.factors.flightMeasured).toBe(true);
    });

    test('the write path stores the null and rolls back clean', async () => {
        const e = await db.get(`SELECT e.id FROM employees e WHERE ${noSignal} LIMIT 1`);
        const before = await db.get(
            'SELECT flight_risk AS f FROM retention_risk WHERE employee_id = ?',
            [e.id]
        );
        try {
            await db.runTransaction(async () => {
                const row = await RetentionRiskService.computeFor(e.id);
                expect(row.flightRisk).toBeNull();
                throw new Error('__ROLLBACK__');
            });
        } catch (err) {
            if (!String(err.message).includes('__ROLLBACK__')) throw err;
        }
        const after = await db.get(
            'SELECT flight_risk AS f FROM retention_risk WHERE employee_id = ?',
            [e.id]
        );
        expect(after).toEqual(before);
    });

    test('flightMeasured is a superset of impactMeasured — impact never measured without flight', async () => {
        // A placement drives impact and also makes flight measured, so there is
        // no person with a measured impact but an unmeasured flight.
        const sample = await db.all('SELECT id FROM employees WHERE is_active = true LIMIT 40');
        for (const e of sample) {
            const s = await RetentionRiskService._signals(e.id);
            if (s.impactBand != null) expect(s.flightBand).not.toBeNull();
        }
    });
});
