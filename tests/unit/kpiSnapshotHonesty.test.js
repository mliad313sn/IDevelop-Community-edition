'use strict';

/**
 * Four defects in the KPI trend, all of which made a line look like movement
 * that nobody caused.
 *
 * (21) A delta in an AVERAGE can be a change in WHO is averaged. One
 *      below-average leaver raises the mean. `measuredEmployees` travelled in
 *      the same payload and was never shown, so "+0.6 pts" read as improvement.
 *      Demonstrated here: avgReadiness +4 alongside measuredEmployees -1.
 *
 * (22) `priorSnapshot` had no upper age bound — it took the most recent
 *      snapshot at least 28 days old, whatever its age. A chip captioned as a
 *      month's movement compared against a snapshot 300 days old in testing.
 *
 * (23) Counts derived from measurement were stored as 0, not NULL. A site
 *      nobody has assessed reports roleReadyCount 0 (COUNT cannot return null),
 *      and the day it IS assessed the delta reads "+4 role-ready" — four people
 *      who did not become ready, they became visible.
 *
 * (24) One failing site aborted the whole tick, and because the org row is
 *      written FIRST the early-skip guard then reported "already_today" on
 *      every retry. The missing sites could never be captured for that date,
 *      and a hole in a trend line is permanent.
 *
 * Every write below happens inside a rolled-back transaction.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = !!process.env.DATABASE_URL;
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
const KpiSnapshotService = HAS_DB ? require('../../src/services/KpiSnapshotService') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const rolledBack = async (fn) => {
    try {
        await db.runTransaction(async () => {
            await fn();
            throw new Error('__ROLLBACK__');
        });
    } catch (e) {
        if (!String(e.message).includes('__ROLLBACK__')) throw e;
    }
};

suite('22 — a month-on-month delta may not reach back arbitrarily', () => {
    test('the window is bounded, and the factor is stated rather than hidden', () => {
        expect(KpiSnapshotService.MAX_PRIOR_AGE_FACTOR).toBe(3);
    });

    test('a snapshot far outside the window is refused, not used', async () => {
        await rolledBack(async () => {
            await db.run(
                "DELETE FROM kpi_snapshots WHERE scope_type='org' AND scope_id=0 AND snapshot_date > CURRENT_DATE - 400"
            );
            await db.run(
                `INSERT INTO kpi_snapshots (scope_type, scope_id, snapshot_date, avg_readiness, measured_employees)
                 VALUES ('org', 0, CURRENT_DATE - 300, 50, 10)`
            );
            expect(await KpiSnapshotService.priorSnapshot('org', 0, 28)).toBeNull();
            const d = await KpiSnapshotService.deltas({ avgReadiness: 74 }, 'org', 0, 28);
            expect(d.since).toBeNull();
            expect(d.values).toEqual({}); // no delta beats a wrong delta
        });
    });

    test('a snapshot inside the window is still used', async () => {
        await rolledBack(async () => {
            await db.run(
                "DELETE FROM kpi_snapshots WHERE scope_type='org' AND scope_id=0 AND snapshot_date > CURRENT_DATE - 400"
            );
            await db.run(
                `INSERT INTO kpi_snapshots (scope_type, scope_id, snapshot_date, avg_readiness, measured_employees)
                 VALUES ('org', 0, CURRENT_DATE - 30, 70, 12)`
            );
            const p = await KpiSnapshotService.priorSnapshot('org', 0, 28);
            expect(p).not.toBeNull();
        });
    });
});

suite('21 — a movement in an average carries the population that moved with it', () => {
    test('measuredEmployees is a delta metric, so the chip can qualify the number', async () => {
        expect(KpiSnapshotService.METRICS).toContain('measuredEmployees');
        await rolledBack(async () => {
            await db.run(
                "DELETE FROM kpi_snapshots WHERE scope_type='org' AND scope_id=0 AND snapshot_date > CURRENT_DATE - 400"
            );
            await db.run(
                `INSERT INTO kpi_snapshots (scope_type, scope_id, snapshot_date, avg_readiness, measured_employees)
                 VALUES ('org', 0, CURRENT_DATE - 30, 70, 12)`
            );
            const d = await KpiSnapshotService.deltas(
                { avgReadiness: 74, measuredEmployees: 11 },
                'org',
                0,
                28
            );
            // the headcount effect, right beside the "improvement"
            expect(d.values.avgReadiness).toBe(4);
            expect(d.values.measuredEmployees).toBe(-1);
        });
    });
});

suite('23 — a count nobody measured is unknown, not zero', () => {
    test('measurement-derived counts store NULL when nothing was measured', async () => {
        await rolledBack(async () => {
            await db.run(
                "DELETE FROM kpi_snapshots WHERE snapshot_date = CURRENT_DATE AND scope_type='site' AND scope_id = 999"
            );
            await KpiSnapshotService.capture('site', 999, 'Nowhere', {
                totalEmployees: 0,
                measuredEmployees: 0,
                avgReadiness: null,
                roleReadyCount: 0, // what COUNT() returns for an empty scope
                rolesAtRisk: 0,
                rolesUnmeasured: 0,
            });
            const row = await db.get(
                `SELECT total_employees AS te, measured_employees AS me,
                        role_ready_count AS rr, roles_at_risk AS rar
                   FROM kpi_snapshots
                  WHERE snapshot_date = CURRENT_DATE AND scope_type='site' AND scope_id = 999`
            );
            expect(row.rr).toBeNull(); // unknown, not "nobody is ready"
            expect(row.rar).toBeNull();
            // the facts about an empty scope are still facts
            expect(Number(row.te)).toBe(0);
            expect(Number(row.me)).toBe(0);
        });
    });

    test('a MEASURED zero is still stored as zero', async () => {
        await rolledBack(async () => {
            await db.run(
                "DELETE FROM kpi_snapshots WHERE snapshot_date = CURRENT_DATE AND scope_type='site' AND scope_id = 998"
            );
            await KpiSnapshotService.capture('site', 998, 'Somewhere', {
                totalEmployees: 10,
                measuredEmployees: 10,
                avgReadiness: 40,
                roleReadyCount: 0, // measured, and genuinely none
                rolesAtRisk: 3,
            });
            const row = await db.get(
                `SELECT role_ready_count AS rr, roles_at_risk AS rar FROM kpi_snapshots
                  WHERE snapshot_date = CURRENT_DATE AND scope_type='site' AND scope_id = 998`
            );
            expect(Number(row.rr)).toBe(0);
            expect(Number(row.rar)).toBe(3);
        });
    });
});

suite('24 — a day with a hole in it is not a finished day', () => {
    const job = require('../../src/jobs/kpi-snapshot');

    test('a complete day is skipped, a day missing a site is refilled', async () => {
        await rolledBack(async () => {
            await db.run('DELETE FROM kpi_snapshots WHERE snapshot_date = CURRENT_DATE');
            const first = await job.tick();
            expect(first.captured).toBeGreaterThan(1);

            const sites = await db.get('SELECT COUNT(*)::int AS n FROM sites');
            const got = async () =>
                Number(
                    (
                        await db.get(
                            "SELECT COUNT(*)::int AS n FROM kpi_snapshots WHERE snapshot_date = CURRENT_DATE AND scope_type='site'"
                        )
                    ).n
                );
            expect(await got()).toBe(Number(sites.n));

            // complete -> skip
            expect((await job.tick()).skipped).toBe('already_today');

            // punch a hole: the old guard would have skipped for ever
            await db.run(
                "DELETE FROM kpi_snapshots WHERE snapshot_date = CURRENT_DATE AND scope_type='site' AND scope_id = (SELECT MIN(id) FROM sites)"
            );
            expect(await got()).toBe(Number(sites.n) - 1);
            const refill = await job.tick();
            expect(refill.skipped).toBeUndefined();
            expect(await got()).toBe(Number(sites.n));
        });
        // job.tick() captures every scope — genuinely heavy; the 5s default is too
        // tight under full-suite DB contention (passes in isolation at ~3.3s).
    }, 20000);

    test('one failing site does not cost the others their day', async () => {
        const DashboardModel = require('../../src/models/DashboardModel');
        const real = DashboardModel.getOverviewKPIs.bind(DashboardModel);
        const sites = await db.all('SELECT id FROM sites ORDER BY name');
        const doomed = Number(sites[0].id);

        DashboardModel.getOverviewKPIs = async (filters) => {
            if (filters && Array.isArray(filters.siteIds) && Number(filters.siteIds[0]) === doomed)
                throw new Error('simulated site failure');
            return real(filters);
        };
        try {
            await rolledBack(async () => {
                await db.run('DELETE FROM kpi_snapshots WHERE snapshot_date = CURRENT_DATE');
                const r = await job.tick();
                // it reports the hole instead of claiming a clean run
                expect(r.failed).toBeTruthy();
                expect(r.failed).toHaveLength(1);
                expect(r.failed[0].error).toMatch(/simulated site failure/);
                // and every OTHER site still got its row
                const n = await db.get(
                    "SELECT COUNT(*)::int AS n FROM kpi_snapshots WHERE snapshot_date = CURRENT_DATE AND scope_type='site'"
                );
                expect(Number(n.n)).toBe(sites.length - 1);
            });
        } finally {
            DashboardModel.getOverviewKPIs = real;
        }
    }, 20000); // job.tick() over every scope — heavy; see the note above.
});
