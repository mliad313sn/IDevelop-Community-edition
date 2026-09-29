'use strict';
/**
 * 3.23.18 — lane R1 (reporting-line authority), proved against idevelop_fixtures
 * inside ONE transaction that is always rolled back: nothing written survives.
 *
 *  #3  Dashboard span of control / layers follow the REPORTING LINE (supervisor,
 *      else employee manager), cycle-safe, and a manager's own perimeter counts.
 *  #4  GovernanceService.resolveReviewer: live supervisor, else live manager —
 *      an admin manager joined on admins, never on employees.
 *  #5  Campaign "Responsable" grouping / filter / transferred flag use the LIVE
 *      responsable, activity-checked on both sides, admins in their own group.
 *  #6  Imports refuse a reporting loop / self-line per row and carry on.
 *  #7  "My direct reports" = supervisor_id = me OR employee-manager = me; the
 *      roster shows the effective line, admin managers labelled.
 *
 * Skipped (not failed) when the test database is not reachable.
 */
require('dotenv').config();

const ROLLBACK = new Error('c317R1-rollback');
let db;
let ready = false;

beforeAll(async () => {
    if (!/idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''))) return;
    db = require('../../src/config/database');
    try {
        await db.connect();
        const col = await db.get(
            `SELECT 1 AS ok FROM information_schema.columns
              WHERE table_name = 'cycle_participants' AND column_name = 'reviewer_assigned_at'`
        );
        ready = Boolean(col);
    } catch (_) {
        ready = false;
    }
}, 30000);

afterAll(async () => {
    if (db) {
        try {
            await db.close();
        } catch (_) {
            /* already closed */
        }
    }
});

async function inRollback(fn) {
    try {
        await db.runTransaction(async () => {
            await fn(await fixture());
            throw ROLLBACK;
        });
    } catch (e) {
        if (e !== ROLLBACK) throw e;
    }
}

async function fixture() {
    const admin = await db.get(
        "SELECT id FROM admins WHERE role::text = 'superadmin' ORDER BY id LIMIT 1"
    );
    const SUPER = { userType: 'admin', role: 'superadmin', id: Number(admin.id), username: 't' };
    const tpl = await db.get(
        `SELECT e.id, e.role_id, e.site_id, e.department_id, e.service_id FROM employees e
          WHERE e.is_active AND e.role_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM role_skill_requirements q WHERE q.role_id = e.role_id)
          ORDER BY e.id LIMIT 1`
    );
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const mk = async (n, { sup = null, mgr = null, mgrType = null } = {}) =>
        Number(
            (
                await db.get(
                    `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id, service_id, role_id,
                                            supervisor_id, manager_id, manager_type, is_active)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, true) RETURNING id`,
                    [
                        `R1-${n}-${stamp}`,
                        `R1${n}`,
                        `Z${stamp}`,
                        tpl.siteId,
                        tpl.departmentId,
                        tpl.serviceId,
                        tpl.roleId,
                        sup,
                        mgr,
                        mgr == null ? null : mgrType || 'employee',
                    ]
                )
            ).id
        );
    const ADM = Number(
        (
            await db.get(
                `INSERT INTO admins (username, password_hash, role) VALUES (?, 'x', 'localadmin') RETURNING id`,
                [`r1adm${stamp}`]
            )
        ).id
    );
    return { SUPER, tpl, stamp, mk, ADM, admName: `r1adm${stamp}` };
}

const maybe = (name, fn) =>
    test(
        name,
        async () => {
            if (!ready) return; // no test DB: nothing to prove here
            await fn();
        },
        60000
    );

const deactivate = (id) => db.run('UPDATE employees SET is_active = false WHERE id = ?', [id]);

// ---------------------------------------------------------------------------
describe('#4 — resolveReviewer: live line, typed manager', () => {
    maybe('inactive supervisor falls through; an ADMIN manager is named from admins', async () => {
        const Gov = require('../../src/services/GovernanceService');
        await inRollback(async ({ mk, ADM, admName }) => {
            const S = await mk('S');
            const S2 = await mk('S2');
            const M = await mk('M');
            const P = await mk('P', { sup: S, mgr: ADM, mgrType: 'admin' });
            const Q = await mk('Q', { sup: S2 });
            const R = await mk('R', { sup: S, mgr: M });
            await deactivate(S);

            expect(await Gov.resolveReviewer(P)).toMatchObject({
                kind: 'manager',
                type: 'admin',
                id: ADM,
                name: admName,
            });
            expect(await Gov.resolveReviewer(Q)).toMatchObject({
                kind: 'supervisor',
                type: 'employee',
                id: S2,
            });
            expect(await Gov.resolveReviewer(R)).toMatchObject({
                kind: 'manager',
                type: 'employee',
                id: M,
                name: expect.stringContaining('R1M'),
            });
        });
    });
});

// ---------------------------------------------------------------------------
describe('#3 — span of control and layers over the reporting line', () => {
    maybe(
        'a manager whose team is led through supervisor_id: managers 2, span 1, layers 2',
        async () => {
            const DashboardController = require('../../src/controllers/DashboardController');
            const ctrl = new DashboardController();
            await inRollback(async ({ mk }) => {
                const M = await mk('M');
                const R1 = await mk('R1', { sup: M });
                await mk('R2', { sup: R1 });
                let body = null;
                const res = {
                    status() {
                        return this;
                    },
                    json(j) {
                        body = j;
                    },
                };
                await ctrl.getMeasures({ user: { id: M, userType: 'manager' }, query: {} }, res);
                const m = Object.fromEntries((body.measures || []).map((x) => [x.key, x.value]));
                expect(m.people).toBe(2);
                expect(m.managers).toBe(2); // M (outside the perimeter) and R1
                expect(m.span).toBe(1);
                expect(m.layers).toBe(2);
            });
        }
    );

    maybe('a reporting LOOP drops nobody', async () => {
        const DashboardModel = require('../../src/models/DashboardModel');
        await inRollback(async ({ mk }) => {
            const A = await mk('A');
            const B = await mk('B', { sup: A });
            await db.run('UPDATE employees SET supervisor_id = ? WHERE id = ?', [B, A]);
            const C = await mk('C', { sup: B });
            const out = await DashboardModel.reportingLineMeasures([A, B, C]);
            expect(out.managers).toBe(2); // A and B head a line
            // The loop is cut at whichever of A/B is met first: 2 or 3 layers,
            // never null and never the "no manager" roots only (which were none).
            expect([2, 3]).toContain(out.layers);
            expect(out.span).toBe(1.5);
        });
    });
});

// ---------------------------------------------------------------------------
describe('#7 — direct reports and the roster line', () => {
    maybe(
        '"my direct reports" includes the people I MANAGE, not only those I supervise',
        async () => {
            const DashboardModel = require('../../src/models/DashboardModel');
            await inRollback(async ({ mk }) => {
                const M = await mk('M');
                const A = await mk('A', { sup: M });
                const B = await mk('B', { mgr: M });
                // manager_id carries M's NUMBER but typed 'admin': an admin account,
                // not the person M (the id spaces overlap). Never M's report.
                const C = await mk('C', { mgr: M, mgrType: 'admin' });
                const out = await DashboardModel.getEmployeeList(
                    { employeeIds: [A, B, C] },
                    { page: 1, pageSize: 50, supervisorId: M }
                );
                const ids = out.rows.map((r) => Number(r.id)).sort();
                expect(ids).toEqual([A, B].sort());
            });
        }
    );

    maybe(
        'the roster shows the effective line: supervisor, else manager, admin labelled',
        async () => {
            const EmployeeModel = require('../../src/models/EmployeeModel');
            await inRollback(async ({ mk, ADM, admName }) => {
                const S = await mk('S');
                const M = await mk('M');
                const P = await mk('P', { sup: S, mgr: ADM, mgrType: 'admin' });
                const Q = await mk('Q', { sup: M });
                const R = await mk('R', { mgr: M });
                await deactivate(S);
                const { rows } = await EmployeeModel.findPageWithOrg({
                    employeeIds: [P, Q, R],
                    filters: {},
                    limit: 10,
                    offset: 0,
                });
                const by = Object.fromEntries(rows.map((r) => [Number(r.id), r]));
                expect(by[P]).toMatchObject({ lineKind: 'admin', lineName: admName });
                expect(by[Q]).toMatchObject({ lineKind: 'supervisor' });
                expect(by[Q].lineName).toContain('R1M');
                expect(by[R]).toMatchObject({ lineKind: 'manager' });
                expect(by[R].lineName).toContain('R1M');
            });
        }
    );
});

// ---------------------------------------------------------------------------
describe('#5 — campaign "Responsable": live, typed, activity-checked', () => {
    async function campaign(SUPER, tpl, stamp, rows) {
        const C = Number(
            (
                await db.get(
                    `INSERT INTO assessment_cycles (code, label, status, opened_at, closes_at, created_by)
                     VALUES (?, 'r1', 'open', now() - interval '5 days', now() + interval '20 days', ?) RETURNING id`,
                    [`R1C-${stamp}`, SUPER.id]
                )
            ).id
        );
        for (const [emp, snapSup] of rows) {
            await db.run(
                `INSERT INTO cycle_participants (cycle_id, employee_id, role_id, supervisor_id, expected_skills)
                 VALUES (?, ?, ?, ?, 3)`,
                [C, emp, tpl.roleId, snapSup]
            );
        }
        return C;
    }

    maybe('grouping, filter and transferred flag', async () => {
        const CycleService = require('../../src/services/CycleService');
        await inRollback(async ({ SUPER, tpl, stamp, mk, ADM, admName }) => {
            const S1 = await mk('S1');
            const M = await mk('M');
            const X = await mk('X', { sup: S1 }); // will become admin-managed
            const Y = await mk('Y', { sup: S1 }); // stays with S1
            const Z = await mk('Z', { sup: S1, mgr: M }); // S1 leaves → M
            // W: the live supervisor IS the recorded one, but has LEFT; the live
            // line is M. The old flag compared a NON-checked COALESCE with the
            // snapshot (S3 = S3 → "not transferred") while the review sat with M.
            const S3 = await mk('S3');
            const W = await mk('W', { sup: S3, mgr: M });
            const C = await campaign(SUPER, tpl, stamp, [
                [X, S1],
                [Y, S1],
                [Z, S1],
                [W, S3],
            ]);
            await deactivate(S3);
            await db.run(
                "UPDATE employees SET supervisor_id = NULL, manager_id = ?, manager_type = 'admin' WHERE id = ?",
                [ADM, X]
            );
            // Y keeps S1 live; Z's supervisor S1 is replaced by a NEW supervisor who then
            // leaves — the recorded S1 is still active, the live line falls to M.
            const S9 = await mk('S9');
            await db.run('UPDATE employees SET supervisor_id = ? WHERE id = ?', [S9, Z]);
            await deactivate(S9);

            const groups = await CycleService.progressByManager(C, SUPER, {});
            const g = Object.fromEntries(groups.map((r) => [String(r.id), r]));
            expect(g[`admin:${ADM}`]).toMatchObject({ kind: 'admin', label: admName, total: 1 });
            expect(g[String(S1)]).toMatchObject({ kind: 'employee', total: 1 }); // Y only
            expect(g[String(M)]).toMatchObject({ kind: 'employee', total: 2 }); // Z and W
            expect(groups.some((r) => r.id === null)).toBe(false);

            const onS1 = await CycleService.participants(C, SUPER, { supervisorId: [String(S1)] });
            expect(onS1.rows.map((r) => Number(r.employeeId))).toEqual([Y]);
            const onAdm = await CycleService.participants(C, SUPER, {
                supervisorId: [`admin:${ADM}`],
            });
            expect(onAdm.rows.map((r) => Number(r.employeeId))).toEqual([X]);

            const all = await CycleService.participants(C, SUPER, {});
            const t = Object.fromEntries(
                all.rows.map((r) => [Number(r.employeeId), r.transferred])
            );
            expect(t[Y]).toBe(false);
            expect(t[X]).toBe(true);
            expect(t[Z]).toBe(true);
            expect(t[W]).toBe(true);

            const opts = await CycleService.filterOptions(C, SUPER, {});
            expect(opts.adminResponsibles.map((o) => o.id)).toEqual([`admin:${ADM}`]);
            expect(opts.supervisors.map((o) => o.id).sort()).toEqual([S1, M].sort());
            expect(opts.noSupervisor).toBe(0);
        });
    });
});

// ---------------------------------------------------------------------------
describe('#6 — imports refuse a reporting loop, row by row', () => {
    maybe(
        'workbook: a supervisor that closes a loop (or is the person) is refused and reported',
        async () => {
            const workbook = require('../../src/services/SkillMatrixWorkbookService');
            await inRollback(async ({ mk, stamp }) => {
                const A = await mk('A');
                const B = await mk('B', { sup: A });
                const D = await mk('D');
                const results = {
                    employees: { created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] },
                    warnings: [],
                };
                await workbook._linkHierarchy(
                    {
                        employees: [
                            { employeeNumber: `R1-A-${stamp}`, supervisorName: `R1B Z${stamp}` }, // loop
                            { employeeNumber: `R1-D-${stamp}`, supervisorName: `R1B Z${stamp}` }, // fine
                        ],
                    },
                    results,
                    { empOutcome: new Map() }
                );
                const a = await db.get('SELECT supervisor_id FROM employees WHERE id = ?', [A]);
                const d = await db.get('SELECT supervisor_id FROM employees WHERE id = ?', [D]);
                expect(a.supervisorId).toBeNull(); // the loop was NOT written
                expect(Number(d.supervisorId)).toBe(B); // the import carried on
                expect(results.employees.errors.join(' ')).toMatch(/reporting loop/);
            });
        }
    );

    maybe('JSON import: a looping supervisor is refused per row, the rest is written', async () => {
        const unified = require('../../src/services/UnifiedJsonService');
        await inRollback(async ({ mk, stamp }) => {
            const A = await mk('A');
            const B = await mk('B', { sup: A });
            const D = await mk('D');
            const { results } = await unified.importSystemFromJson(
                {
                    employees: [
                        {
                            employeeNumber: `R1-A-${stamp}`,
                            supervisorEmployeeNumber: `R1-B-${stamp}`,
                        },
                        {
                            employeeNumber: `R1-D-${stamp}`,
                            supervisorEmployeeNumber: `R1-B-${stamp}`,
                        },
                    ],
                },
                null
            );
            const a = await db.get('SELECT supervisor_id FROM employees WHERE id = ?', [A]);
            const d = await db.get('SELECT supervisor_id FROM employees WHERE id = ?', [D]);
            expect(a.supervisorId).toBeNull();
            expect(Number(d.supervisorId)).toBe(B);
            expect((results.errors || []).join(' ')).toMatch(/reporting loop/);
        });
    });
});
