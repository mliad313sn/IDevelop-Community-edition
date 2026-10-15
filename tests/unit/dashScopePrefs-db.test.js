'use strict';
/**
 * The dashboard scope bar's remembered scope (migration 185,
 * src/services/DashboardScopeService.js):
 *   - pure: only whole numbers or 'none' are read from a URL, a department of
 *     another site is refused, a unit outside the reader's population is
 *     refused;
 *   - on the real test database (inside a transaction that is always rolled
 *     back): a URL scope is remembered per ACCOUNT and page, a second account
 *     never reads it (a shared computer is used by several people), a remembered
 *     scope that left the reader's clearance is dropped silently, a refused URL
 *     is neither applied nor remembered;
 *   - the table is exported with the person and deleted on erasure (employee
 *     rows only).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const S = require('../../src/services/DashboardScopeService');
const { isTestDatabaseUrl } = require('../helpers/testDatabase');

const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(120000);

const OPTS = {
    people: 9,
    sites: [
        { id: 4, name: 'North', n: 5 },
        { id: 7, name: 'South', n: 3 },
    ],
    noSite: 1,
    departments: [
        { id: 12, name: 'Ops', siteId: 4, label: 'Ops', n: 5 },
        { id: 13, name: 'Lab', siteId: 7, label: 'Lab', n: 3 },
    ],
};

describe('scope parsing and validation (pure)', () => {
    test('no scope in the URL is null; ?scope=all is the whole clearance', () => {
        expect(S.parseQuery({})).toBeNull();
        expect(S.parseQuery({ tab: 'safety' })).toBeNull();
        expect(S.parseQuery({ scope: 'all' })).toEqual({
            site: null,
            department: null,
            all: true,
            malformed: false,
        });
    });

    test('only whole numbers or « none » are read; anything else is malformed', () => {
        expect(S.parseQuery({ site: '4' }).site).toBe(4);
        expect(S.parseQuery({ site: 'none' }).site).toBe('none');
        for (const bad of ['4 OR 1=1', '-1', '0', '4.5', '1e3', "4'", 'x'.repeat(40)])
            expect([bad, S.parseQuery({ site: bad }).malformed]).toEqual([bad, true]);
        // the last of a repeated parameter wins, never an array in a query
        expect(S.parseQuery({ site: ['4', '7'] }).site).toBe(7);
    });

    test('a unit outside the reader population is refused, never answered empty', () => {
        expect(S.validate(S.parseQuery({ site: '4' }), OPTS)).toEqual({
            ok: true,
            scope: { site: 4 },
        });
        expect(S.validate(S.parseQuery({ site: '99' }), OPTS).ok).toBe(false);
        expect(S.validate(S.parseQuery({ department: '99' }), OPTS).ok).toBe(false);
        expect(S.validate(S.parseQuery({ site: 'none' }), { ...OPTS, noSite: 0 }).ok).toBe(false);
        // a department of another site is a contradiction
        expect(S.validate(S.parseQuery({ site: '4', department: '13' }), OPTS).ok).toBe(false);
        expect(S.validate(S.parseQuery({ site: '4', department: '12' }), OPTS).scope).toEqual({
            site: 4,
            department: 12,
        });
    });

    test('the KPI scope and the query string keep ids only', () => {
        const v = { id: 1, userType: 'admin' };
        expect(S.kpiScope(v, { site: 4, department: 12 })).toEqual({
            viewer: v,
            siteId: 4,
            departmentId: 12,
        });
        expect(S.kpiScope(v, {})).toEqual({ viewer: v });
        expect(S.queryOf({ site: 'none' })).toBe('site=none');
        expect(S.queryOf({})).toBe('');
    });

    test('the scope is never kept in browser storage', () => {
        const fs = require('fs');
        const root = path.join(__dirname, '..', '..');
        for (const f of [
            'public/js/dashboard-tabs.js',
            'views/partials/scope-bar.ejs',
            'views/pages/dashboard/index.ejs',
        ]) {
            const p = path.join(root, f);
            if (!fs.existsSync(p)) continue;
            expect([f, /localStorage|sessionStorage/.test(fs.readFileSync(p, 'utf8'))]).toEqual([
                f,
                false,
            ]);
        }
    });
});

suite('remembered scope on the real database (rolled back)', () => {
    let db;
    const ROLLBACK = new Error('__SCOPE_ROLLBACK__');
    async function tx(fn) {
        let out;
        try {
            await db.runTransaction(async () => {
                out = await fn();
                throw ROLLBACK;
            });
        } catch (e) {
            if (e !== ROLLBACK) throw e;
        }
        return out;
    }
    beforeAll(async () => {
        db = require('../../src/config/database');
        await db.connect();
    });
    afterAll(async () => {
        await db.close();
    });

    test('per account and page; another account never reads it; a stale scope is dropped', async () => {
        const out = await tx(async () => {
            const a = { id: 900001, userType: 'admin' };
            const b = { id: 900002, userType: 'admin' };
            const e = { id: 900001, userType: 'employee' };
            const r1 = await S.resolve({
                user: a,
                query: { site: '4' },
                page: 'dashboard',
                opts: OPTS,
            });
            const again = await S.resolve({ user: a, query: {}, page: 'dashboard', opts: OPTS });
            const other = await S.resolve({ user: b, query: {}, page: 'dashboard', opts: OPTS });
            const samIdEmployee = await S.resolve({
                user: e,
                query: {},
                page: 'dashboard',
                opts: OPTS,
            });
            const otherPage = await S.resolve({
                user: a,
                query: {},
                page: 'board_pack',
                opts: OPTS,
            });
            // the site leaves the reader's clearance: dropped, never re-offered
            const stale = await S.resolve({
                user: a,
                query: {},
                page: 'dashboard',
                opts: { ...OPTS, sites: [OPTS.sites[1]] },
            });
            // a refused URL is neither applied nor remembered
            const refused = await S.resolve({
                user: a,
                query: { site: '99' },
                page: 'dashboard',
                opts: OPTS,
            });
            const after = await S.resolve({ user: a, query: {}, page: 'dashboard', opts: OPTS });
            // ?scope=all is a choice too
            await S.resolve({ user: a, query: { scope: 'all' }, page: 'dashboard', opts: OPTS });
            const all = await S.resolve({ user: a, query: {}, page: 'dashboard', opts: OPTS });
            // an unknown page key is never stored
            const unknown = await S.writePref(a, 'evil-page', { site: 4 });
            return {
                r1,
                again,
                other,
                samIdEmployee,
                otherPage,
                stale,
                refused,
                after,
                all,
                unknown,
            };
        });
        expect(out.r1).toEqual({ scope: { site: 4 }, source: 'url', refused: false });
        expect(out.again).toEqual({ scope: { site: 4 }, source: 'saved', refused: false });
        expect(out.other.source).toBe('default');
        expect(out.samIdEmployee.source).toBe('default');
        expect(out.otherPage.source).toBe('default');
        expect(out.stale).toEqual({ scope: {}, source: 'default', refused: false });
        expect(out.refused).toEqual({ scope: {}, source: 'url', refused: true });
        expect(out.after.scope).toEqual({ site: 4 });
        expect(out.all).toEqual({ scope: {}, source: 'saved', refused: false });
        expect(out.unknown).toBe(false);
    });

    test('the shape CHECK refuses free text and an unknown account kind', async () => {
        for (const sql of [
            `INSERT INTO dashboard_scope_prefs (user_type, user_id, page, scope) VALUES ('robot', 1, 'dashboard', '{}')`,
            `INSERT INTO dashboard_scope_prefs (user_type, user_id, page, scope) VALUES ('admin', 1, 'dashboard', '[]')`,
            `INSERT INTO dashboard_scope_prefs (user_type, user_id, page, scope) VALUES ('admin', 1, 'dashboard', '{"note": "${'x'.repeat(300)}"}')`,
        ]) {
            await expect(tx(() => db.run(sql))).rejects.toThrow(/dashboard_scope_prefs_shape/);
        }
    });

    test('exported with the person, deleted on erasure (employee rows only)', async () => {
        const out = await tx(async () => {
            const emp = await db.get(
                `SELECT id FROM employees WHERE erased_at IS NULL ORDER BY id LIMIT 1`
            );
            const id = Number(emp.id);
            await S.writePref({ id, userType: 'employee' }, 'dashboard', { site: 4 });
            await S.writePref({ id, userType: 'admin' }, 'dashboard', { site: 4 });
            const DSR = require('../../src/services/DSRService');
            const exp = await DSR.export(id);
            const Registry = require('../../src/services/erasureRegistry');
            const e = Registry.SUBJECT_DATA_REGISTRY.find(
                (x) => x.table === 'dashboard_scope_prefs'
            );
            const { sql, params } = Registry.registryWhere(e, id);
            await db.run(`DELETE FROM dashboard_scope_prefs WHERE ${sql}`, params);
            const left = await db.all(
                `SELECT user_type AS "t" FROM dashboard_scope_prefs WHERE user_id = ? ORDER BY 1`,
                [id]
            );
            return { exp: exp.dashboardScope, left: left.map((r) => r.t) };
        });
        expect(out.exp).toHaveLength(1);
        expect(out.exp[0].page).toBe('dashboard');
        expect(out.left).toEqual(['admin']);
    });
});
