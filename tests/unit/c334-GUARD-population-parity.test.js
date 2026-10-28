'use strict';
/**
 * Guard — the same filter counts the same people in every layer (read-only).
 *
 * Why: the dashboard, the employee list, the public API and the access rules
 * each have their own query. If one of them forgets a rule (an erased person
 * who is still flagged active, for instance), two screens disagree on « how
 * many people » and nobody knows which one is right.
 *
 * What, for 3 filters (whole organisation, one site, one department), as a
 * SuperAdmin:
 *   A dashboard  KpiService.resolvePopulation({viewer, siteId?, departmentId?}).ids.length
 *   B list page  EmployeeModel.findPageWithOrg({scopes:null, filters:{isActive:true,…}}).total
 *   C API        EmployeesRepository.count(user)  (organisation only)
 *   D access     RBACService.getFilteredEmployees(user, {siteId?|departmentId?}).length
 *   E raw SQL    is_active AND erased_at IS NULL (+ filter)
 * must all be equal. Then, inside ONE transaction that is always rolled back,
 * one active person is marked erased while staying is_active: A, B, D and E
 * drop by one, and a manager's population (findGovernedIds, findGoverned,
 * canAccessEmployeeData) drops that person while still governing the people
 * below them. Nothing is committed.
 *
 * Skipped without the test database.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { isTestDatabaseUrl } = require('../helpers/testDatabase');

const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(240000);

const db = HAS_DB ? require('../../src/config/database') : null;
const K = HAS_DB ? require('../../src/services/KpiService') : null;
const EmployeeModel = HAS_DB ? require('../../src/models/EmployeeModel') : null;
const RBACService = HAS_DB ? require('../../src/services/RBACService') : null;
const repo = HAS_DB ? require('../../src/api/v1/repository') : null;

let SA, siteId, departmentId;
const n = (x) => (x == null ? null : Number(x));
const raw = async (where, params = []) =>
    n((await db.get(`SELECT COUNT(*)::int AS "c" FROM employees e WHERE ${where}`, params)).c);
const listTotal = async (o) =>
    n((await EmployeeModel.findPageWithOrg({ limit: 1, offset: 0, scopes: null, ...o })).total);
const apiCount = async (u) => {
    const c = await repo.EmployeesRepository.count(u);
    return n(typeof c === 'object' ? c.total : c);
};

/** the five layers for one filter */
async function layers(filter) {
    const f = filter || {};
    const where = ['e.is_active = true AND e.erased_at IS NULL'];
    const params = [];
    if (f.siteId) {
        where.push('e.site_id = ?');
        params.push(f.siteId);
    }
    if (f.departmentId) {
        where.push('e.department_id = ?');
        params.push(f.departmentId);
    }
    return {
        A: (await K.resolvePopulation({ viewer: SA, ...f })).ids.length,
        B: await listTotal({ filters: { isActive: true, ...f } }),
        C: Object.keys(f).length ? null : await apiCount(SA),
        D: (await RBACService.getFilteredEmployees(SA, f)).length,
        E: await raw(where.join(' AND '), params),
    };
}

beforeAll(async () => {
    if (!HAS_DB) return;
    await db.connect();
    const a = await db.get(
        "SELECT id FROM admins WHERE role = 'superadmin' AND is_active ORDER BY id LIMIT 1"
    );
    SA = { id: Number(a.id), userType: 'admin', role: 'superadmin', permissions: [] };
    const s = await db.get(
        'SELECT site_id AS "id" FROM employees WHERE is_active AND erased_at IS NULL AND site_id IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC, 1 LIMIT 1'
    );
    const d = await db.get(
        'SELECT department_id AS "id" FROM employees WHERE is_active AND erased_at IS NULL AND department_id IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC, 1 LIMIT 1'
    );
    siteId = s ? Number(s.id) : null;
    departmentId = d ? Number(d.id) : null;
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('the same filter counts the same people in every layer', () => {
    test('whole organisation: A = B = C = D = E', async () => {
        const L = await layers();
        expect(L.E).toBeGreaterThan(0);
        expect([L.A, L.B, L.C, L.D]).toEqual([L.E, L.E, L.E, L.E]);
    });
    test('one site: A = B = D = E', async () => {
        if (!siteId) return;
        const L = await layers({ siteId });
        expect(L.E).toBeGreaterThan(0);
        expect([L.A, L.B, L.D]).toEqual([L.E, L.E, L.E]);
    });
    test('one department: A = B = D = E', async () => {
        if (!departmentId) return;
        const L = await layers({ departmentId });
        expect(L.E).toBeGreaterThan(0);
        expect([L.A, L.B, L.D]).toEqual([L.E, L.E, L.E]);
    });
});

suite('an erased person who is still flagged active (rolled back, nothing committed)', () => {
    const ROLLBACK = new Error('probe rollback');
    /** run fn inside a transaction that is ALWAYS rolled back; returns fn's result */
    async function probe(fn) {
        let out;
        await db
            .withActor('admin:' + SA.id, async () => {
                out = await fn();
                throw ROLLBACK;
            })
            .catch((e) => {
                if (e !== ROLLBACK) throw e;
            });
        return out;
    }
    const pick = () =>
        db.get(
            'SELECT id FROM employees WHERE is_active AND erased_at IS NULL AND site_id = ? ORDER BY id LIMIT 1',
            [siteId]
        );

    test('every layer drops the person, and the rollback leaves nothing behind', async () => {
        if (!siteId) return;
        const before = await layers({ siteId });
        const r = await probe(async () => {
            const who = await pick();
            await db.run('UPDATE employees SET erased_at = now() WHERE id = ?', [who.id]);
            return layers({ siteId });
        });
        expect(r.E).toBe(before.E - 1);
        expect([r.A, r.B, r.D]).toEqual([r.E, r.E, r.E]);
        expect((await layers({ siteId })).E).toBe(before.E);
    });

    test("a manager's population drops the erased person and still governs the people below", async () => {
        const m = await db.get(
            `SELECT mgr AS "id" FROM (
                SELECT COALESCE(supervisor_id, CASE WHEN manager_type = 'employee' THEN manager_id END) AS mgr
                  FROM employees WHERE is_active AND erased_at IS NULL) x
              WHERE mgr IS NOT NULL GROUP BY mgr ORDER BY COUNT(*) DESC, mgr LIMIT 1`
        );
        if (!m) return;
        const mgrId = Number(m.id);
        const ids0 = (await EmployeeModel.findGovernedIds(mgrId)).map(Number);
        const rows0 = await EmployeeModel.findGoverned(mgrId);
        expect(ids0.length).toBeGreaterThan(0);
        const victim = ids0[0];
        const r = await probe(async () => {
            await db.run('UPDATE employees SET erased_at = now() WHERE id = ?', [victim]);
            const ids = (await EmployeeModel.findGovernedIds(mgrId)).map(Number);
            const rows = await EmployeeModel.findGoverned(mgrId);
            const can = await RBACService.canAccessEmployeeData(
                { id: mgrId, userType: 'manager' },
                { id: victim }
            );
            const below = await db.all(
                `SELECT id FROM employees WHERE is_active AND erased_at IS NULL
                   AND (supervisor_id = ? OR (manager_id = ? AND manager_type = 'employee'))`,
                [victim, victim]
            );
            return { ids, rows, can, below: below.map((x) => Number(x.id)) };
        });
        expect(r.ids).not.toContain(victim);
        expect(r.ids.length).toBe(ids0.length - 1);
        expect(r.rows.map((x) => Number(x.id))).not.toContain(victim);
        expect(r.rows.length).toBe(rows0.length - 1);
        expect(r.can).toBe(false);
        for (const id of r.below) expect(r.ids).toContain(id);
        expect((await EmployeeModel.findGovernedIds(mgrId)).length).toBe(ids0.length);
    });

    test('leavers: the list page with the inactive filter equals the raw inactive count', async () => {
        expect(await listTotal({ filters: { isActive: false } })).toBe(
            await raw('e.is_active = false')
        );
    });
});
