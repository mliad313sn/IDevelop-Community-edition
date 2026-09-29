'use strict';

/**
 * J2 — the benchmark role fit-trend froze after 180 days.
 *
 * The history query was `ORDER BY snapshot_date ASC LIMIT 180`, which takes the
 * OLDEST 180 rows. Once a role accumulated more than 180 daily snapshots the
 * chart showed its first six months forever and never a recent point again. It
 * now takes the most recent 180 (DESC LIMIT 180) and re-orders them chronological
 * for the chart.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const norm = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\s+/g, ' ');

const HAS_DB = !!process.env.DATABASE_URL;
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;

// The exact query the controller runs.
const TREND_SQL = `SELECT day, fit, coverage, critical_fit FROM (
     SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS day, fit, coverage, critical_fit, snapshot_date
       FROM benchmark_fit_history WHERE role_id = ?
      ORDER BY snapshot_date DESC LIMIT 180
 ) t ORDER BY snapshot_date ASC`;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('the fit-trend shows the most recent 180 days, not the oldest', () => {
    test('with 181 days of history it returns the newest 180, chronologically', async () => {
        const role = await db.get('SELECT id FROM roles LIMIT 1');
        expect(role).toBeTruthy();
        await db
            .runTransaction(async () => {
                for (let i = 181; i >= 1; i--) {
                    await db.run(
                        `INSERT INTO benchmark_fit_history (role_id, snapshot_date, fit, coverage, critical_fit)
                         VALUES (?, (CURRENT_DATE - ?::int), ?, ?, ?)`,
                        [role.id, i, 100 - (i % 50), 80, 90]
                    );
                }
                const rows = await db.all(TREND_SQL, [role.id]);
                const days = rows.map((r) => r.day);
                expect(rows.length).toBe(180);
                // chronological ascending
                for (let i = 1; i < days.length; i++) expect(days[i - 1] <= days[i]).toBe(true);
                // the newest day is present, the oldest inserted (day 181) is not
                const newest = (await db.get(`SELECT to_char(CURRENT_DATE - 1, 'YYYY-MM-DD') AS d`))
                    .d;
                const oldest = (
                    await db.get(`SELECT to_char(CURRENT_DATE - 181, 'YYYY-MM-DD') AS d`)
                ).d;
                expect(days).toContain(newest);
                expect(days).not.toContain(oldest);
                throw new Error('__ROLLBACK__');
            })
            .catch((e) => {
                if (!/__ROLLBACK__/.test(e.message)) throw e;
            });
    });

    test('the controller query takes the newest window (DESC) then orders ASC', () => {
        const src = norm('src/controllers/BenchmarkController.js');
        expect(src).toMatch(
            /ORDER BY snapshot_date DESC LIMIT 180 \) t ORDER BY snapshot_date ASC/
        );
        // the old oldest-first form is gone
        expect(src).not.toMatch(
            /FROM benchmark_fit_history WHERE role_id = \? ORDER BY snapshot_date ASC LIMIT 180/
        );
    });
});
