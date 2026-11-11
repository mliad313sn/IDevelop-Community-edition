'use strict';
/**
 * K14 « Time to reach the role » and the K5 / K6 bench snapshot columns on
 * the REAL test database (migrations 187, 188 and 189). Invented fixtures,
 * every test inside a rolled-back transaction:
 *   - the role-start trigger stamps a role CHANGE (never an INSERT, never over
 *     a date set by the same statement, never the same role written again);
 *   - the joiner flow stamps a new person's first role once;
 *   - K14 stays « not measured » until a captured date exists, then is the
 *     median of the days from the start to the first « Ready »;
 *   - snapshotMetrics carries the K9 denominator and the K5 / K6 bench, and a
 *     department row is accepted by the snapshot table;
 *   - migrations 186 to 189 can be applied again without error or change.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(240000);

const W = require('../helpers/kpiWorld');
const db = HAS_DB ? require('../../src/config/database') : null;
const K = HAS_DB ? require('../../src/services/KpiService') : null;

let F = null;
beforeAll(async () => {
    if (!HAS_DB) return;
    await db.connect();
    F = await W.seedFacts(db);
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const tx = (fn) => W.inRolledBackTx(db, fn);

async function role(tag) {
    const r = await db.get('INSERT INTO roles (name) VALUES (?) RETURNING id', [
        `K14-${tag}-${W.STAMP}`,
    ]);
    const id = Number(r.id);
    const [S1, S2] = F.SKILLS;
    await db.run(
        `INSERT INTO role_skill_requirements (role_id, skill_id, required_level, is_critical)
         VALUES (?, ?, 2, true), (?, ?, 2, false)`,
        [id, S1, id, S2]
    );
    return id;
}
async function emp(tag, roleId) {
    const r = await db.get(
        `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                service_id, role_id, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, true) RETURNING id`,
        [
            `K14-${tag}-${W.STAMP}`,
            `Kfourteen${tag}`,
            `Fixture${W.STAMP}`,
            F.ORG.siteId,
            F.ORG.departmentId,
            F.ORG.serviceId,
            roleId,
        ]
    );
    return Number(r.id);
}
const startOf = async (id) =>
    (await db.get(
        `SELECT to_char(role_start_date, 'YYYY-MM-DD') AS d,
                    to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today
               FROM employees WHERE id = ?`,
        [id]
    )) || {};

suite('K14 role start date and K5 / K6 snapshots (real database)', () => {
    test('the trigger stamps a role change only', async () => {
        const out = await tx(async () => {
            const r1 = await role('T1');
            const r2 = await role('T2');
            const e = await emp('T', r1);
            const afterInsert = await startOf(e);
            await db.run('UPDATE employees SET role_id = ? WHERE id = ?', [r2, e]);
            const afterChange = await startOf(e);
            await db.run(
                "UPDATE employees SET role_id = ?, role_start_date = DATE '2026-01-05' WHERE id = ?",
                [r1, e]
            );
            const explicit = await startOf(e);
            await db.run('UPDATE employees SET first_name = first_name WHERE id = ?', [e]);
            const unrelated = await startOf(e);
            await db.run('UPDATE employees SET role_id = ? WHERE id = ?', [r1, e]);
            const sameRole = await startOf(e);
            return { afterInsert, afterChange, explicit, unrelated, sameRole };
        });
        expect(out.afterInsert.d).toBeNull(); // an import date is not a start date
        expect(out.afterChange.d).toBe(out.afterChange.today);
        expect(out.explicit.d).toBe('2026-01-05');
        expect(out.unrelated.d).toBe('2026-01-05');
        expect(out.sameRole.d).toBe('2026-01-05'); // the same role again is not a change
    });

    test('the joiner flow stamps the first role once, never over a captured date', async () => {
        const out = await tx(async () => {
            const r = await role('J');
            const e = await emp('J', r);
            const LifecycleService = require('../../src/services/LifecycleService');
            await LifecycleService.onJoiner({ employeeId: e });
            const first = await startOf(e);
            await db.run("UPDATE employees SET role_start_date = DATE '2026-02-02' WHERE id = ?", [
                e,
            ]);
            await LifecycleService.onJoiner({ employeeId: e });
            const again = await startOf(e);
            return { first, again };
        });
        expect(out.first.d).toBe(out.first.today);
        expect(out.again.d).toBe('2026-02-02');
    });

    test('K14 is measured once captured dates exist: median days to the first « Ready »', async () => {
        const out = await tx(async () => {
            const r0 = await role('M0');
            const r = await role('M');
            const [S1, S2] = F.SKILLS;
            const before = await K.k14TimeToCompetence({
                viewer: F.SUPER,
                employeeIds: [await emp('M-none', r)],
            });
            const ids = [];
            for (let i = 0; i < 5; i++) {
                const e = await emp('M' + i, r0);
                await db.run('UPDATE employees SET role_id = ? WHERE id = ?', [r, e]);
                // a start date 10 * (i + 1) days ago, set without a role change
                await db.run(
                    'UPDATE employees SET role_start_date = CURRENT_DATE - ?::int WHERE id = ?',
                    [10 * (i + 1), e]
                );
                for (const s of [S1, S2])
                    await db.run(
                        `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by, notes, validation)
                         VALUES (?, ?, 2, ?, 'K14 fixture', 'manager_validated'::skill_validation)`,
                        [e, s, F.adminId]
                    );
                ids.push(e);
            }
            const after = await K.k14TimeToCompetence({ viewer: F.SUPER, employeeIds: ids });
            const four = await K.k14TimeToCompetence({
                viewer: F.SUPER,
                employeeIds: ids.slice(0, 4),
            });
            return { before, after, four };
        });
        expect(out.before.status).toBe('not_measured');
        expect(out.before.notCaptured).toBe(true);
        expect(out.after.notCaptured).toBeUndefined();
        expect(out.after.n).toBe(5);
        expect(out.after.value).toBe(30); // 10, 20, 30, 40, 50 days
        expect(out.after.status).toBeNull(); // informational, never a band
        expect(out.four.status).toBe('small_n');
        expect(out.four.value).toBeNull();
    });

    test('snapshotMetrics carries the K9 n and the K5 / K6 bench; a department row is stored', async () => {
        const out = await tx(async () => {
            const m = await K.snapshotMetrics({ system: true, departmentId: F.ORG.departmentId });
            const S = require('../../src/services/KpiSnapshotService');
            await db.run(
                "DELETE FROM kpi_snapshots WHERE snapshot_date = CURRENT_DATE AND scope_type = 'department' AND scope_id = ?",
                [F.ORG.departmentId]
            );
            await S.capture('department', F.ORG.departmentId, 'fixture', m);
            const row = await S.latest('department', F.ORG.departmentId, m.kpiContract);
            return { m, row };
        });
        for (const k of [
            'safetyFitN',
            'benchStrengthPct',
            'benchCriticalRoles',
            'criticalRolesWithoutReady',
        ])
            expect(Object.prototype.hasOwnProperty.call(out.m, k)).toBe(true);
        expect(out.row).not.toBeNull();
        expect(out.row.totalEmployees).toBe(out.m.totalEmployees);
        expect(out.row.safetyFitN).toBe(out.m.safetyFitN);
        expect(out.row.benchCriticalRoles).toBe(out.m.benchCriticalRoles);
        // no critical role designated: never a reassuring 0
        if (out.m.benchCriticalRoles === 0) expect(out.row.criticalRolesWithoutReady).toBeNull();
    });

    test('migrations 186 to 189 apply again without error or change', async () => {
        const files = [
            '186_kpi_targets_alerts.sql',
            '187_dept_snapshots_digests.sql',
            '188_role_start_date.sql',
            '189_kpi_snapshot_bench.sql',
        ];
        const shape = async (q) =>
            (
                await q.query(
                    `SELECT table_name || '.' || column_name AS c FROM information_schema.columns
                      WHERE table_schema = 'public'
                        AND (table_name IN ('kpi_targets', 'kpi_alert_states', 'kpi_alert_events',
                                            'persona_digests', 'persona_digest_prefs', 'kpi_snapshots')
                             OR (table_name = 'employees' AND column_name = 'role_start_date'))
                      ORDER BY 1`
                )
            ).rows.map((r) => r.c);
        await tx(async (q) => {
            const before = await shape(q);
            for (const f of files) {
                const sql = fs.readFileSync(path.join(__dirname, '../../db/postgres', f), 'utf8');
                expect(sql.trim().endsWith('SELECT public.fn_console_reader_sync();')).toBe(true);
                await q.query(sql);
                await q.query(sql);
            }
            expect(await shape(q)).toEqual(before);
            const trg = await q.query(
                `SELECT tgname FROM pg_trigger
                  WHERE tgname IN ('trg_kpi_targets_immutable', 'trg_employee_role_start_date')
                    AND NOT tgisinternal`
            );
            expect(trg.rows.map((r) => r.tgname).sort()).toEqual([
                'trg_employee_role_start_date',
                'trg_kpi_targets_immutable',
            ]);
            const chk = await q.query(
                `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
                  WHERE conname = 'chk_kpi_snapshot_scope'`
            );
            expect(chk.rows).toHaveLength(1);
            expect(chk.rows[0].d).toMatch(/department/);
        });
    });
});
