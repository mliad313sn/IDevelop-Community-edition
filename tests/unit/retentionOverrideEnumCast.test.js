'use strict';
/**
 * ZDB-2 — the manual retention-risk override was dead.
 *
 * Measured on the test base (transaction rolled back): setOverride(138,
 * {high, high}) → 42804 "column flight_risk is of type risk_level but
 * expression is of type text"; the same on an employee without a row and on
 * empty bands. Over HTTP the route answered 500 with the driver's text.
 *
 * Cause: `COALESCE(?, 'low')` types the parameter as TEXT. The cast belongs on
 * the parameter, in both the VALUES list and the DO UPDATE branch.
 *
 * Part 1 is DB-free (the SQL handed to the driver). Part 2 executes the real
 * statement against the configured PostgreSQL, existing row AND absent row,
 * inside a rolled-back transaction — it runs when LIVE_DB_TESTS=1.
 */
const path = require('path');

describe('RetentionRiskService.setOverride — parameter cast (DB-free)', () => {
    let db, svc;
    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => ({
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn().mockResolvedValue({
                employeeId: 138,
                flightRisk: 'high',
                impactOfLoss: 'high',
                manualOverride: true,
            }),
            all: jest.fn().mockResolvedValue([]),
        }));
        db = require('../../src/config/database');
        svc = require('../../src/services/RetentionRiskService');
    });

    test('every band parameter is cast to risk_level, in VALUES and in DO UPDATE', async () => {
        await svc.setOverride(138, { flightRisk: 'high', impactOfLoss: 'high' });
        const sql = String(db.run.mock.calls[0][0]);
        const casts = sql.match(/\?\s*::\s*risk_level/g) || [];
        expect(casts).toHaveLength(4);
        expect(sql).toMatch(/VALUES\s*\(\?,\s*COALESCE\(\?\s*::\s*risk_level,\s*'low'\)/);
        expect(sql).toMatch(
            /flight_risk\s*=\s*COALESCE\(\?\s*::\s*risk_level,\s*retention_risk\.flight_risk\)/
        );
        // No bare COALESCE(?, …) is left — that is the exact TEXT-typed shape.
        expect(sql).not.toMatch(/COALESCE\(\?,/);
    });

    test('null bands are passed as NULL (the enum default / the row value wins)', async () => {
        await svc.setOverride(138, {});
        expect(db.run.mock.calls[0][1]).toEqual([138, null, null, null, null, null]);
    });
});

const LIVE = process.env.LIVE_DB_TESTS === '1';
(LIVE ? describe : describe.skip)(
    'RetentionRiskService.setOverride — real SQL, rolled back',
    () => {
        let db, svc;
        beforeAll(async () => {
            jest.resetModules();
            jest.dontMock('../../src/config/database');
            require('dotenv').config({ path: path.join(__dirname, '../../.env') });
            db = require('../../src/config/database');
            svc = require('../../src/services/RetentionRiskService');
            await db.connect();
        });
        afterAll(async () => {
            await db.close();
        });

        const rolledBack = async (fn) => {
            await expect(
                db.runTransaction(async () => {
                    await fn();
                    throw new Error('__ROLLBACK__');
                })
            ).rejects.toThrow('__ROLLBACK__');
        };

        test('existing row: override lands', async () => {
            await rolledBack(async () => {
                const emp = await db.get(
                    'SELECT employee_id AS id FROM retention_risk ORDER BY employee_id LIMIT 1'
                );
                if (!emp) return; // fixture state is never a defect
                const r = await svc.setOverride(emp.id, {
                    flightRisk: 'high',
                    impactOfLoss: 'high',
                });
                expect(r.flightRisk).toBe('high');
                expect(r.impactOfLoss).toBe('high');
                expect(r.manualOverride).toBe(true);
            });
        });

        test('absent row: override inserts, and empty bands fall back to low', async () => {
            await rolledBack(async () => {
                const emp = await db.get(
                    'SELECT id FROM employees WHERE cancelled_at IS NULL ORDER BY id LIMIT 1'
                );
                if (!emp) return;
                await db.run('DELETE FROM retention_risk WHERE employee_id = ?', [emp.id]);
                const r = await svc.setOverride(emp.id, {});
                expect(r.flightRisk).toBe('low');
                expect(r.impactOfLoss).toBe('low');
                expect(r.manualOverride).toBe(true);
            });
        });
    }
);
