'use strict';
/**
 * The capability map on the REAL test database (read only, plus invented
 * fixtures in a rolled-back transaction):
 *   - ONE aggregate query whose marginals equal the heatmap cube
 *     (capabilityHeat) unit by unit and pillar by pillar, and the population
 *     total: never a mean of cells;
 *   - every active pillar and sub-domain of the framework is a row;
 *   - the Readiness tab carries the map and the Overview tab the strip, for a
 *     reader holding the « skills » capability, and neither for a reader
 *     without it;
 *   - no person's name in the rendered map; n < 5 never printed as a value;
 *   - a sub-domain cell's list (DOM s<id>) counts people, names nobody.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(240000);

const ROOT = path.join(__dirname, '..', '..');
const db = HAS_DB ? require('../../src/config/database') : null;
const D = HAS_DB ? require('../../src/services/DashboardHomeService') : null;
const H = require('../../src/utils/heatModel');
const KF = require('../../src/utils/kpiFormat');

const ROLLBACK = new Error('__C332CM_ROLLBACK__');
async function inTx(fn) {
    try {
        await db.runTransaction(async () => {
            await fn(db._txStore.getStore());
            throw ROLLBACK;
        });
    } catch (e) {
        if (e !== ROLLBACK) throw e;
    }
}

let SUPER;
beforeAll(async () => {
    if (!HAS_DB) return;
    await db.connect();
    const a = await db.get(
        `SELECT id FROM admins WHERE role = 'superadmin' AND is_active ORDER BY id LIMIT 1`
    );
    SUPER = { userType: 'admin', role: 'superadmin', id: Number(a.id), permissions: [] };
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const STAMP = `${Date.now()}`.slice(-6);
const NAMES = [
    ['Orsolya', 'Kwarteng'],
    ['Benedikt', 'Valcourt'],
    ['Ines', 'Haverford'],
    ['Tobiah', 'Lindqvar'],
    ['Wren', 'Abernathe'],
    ['Saoirse', 'Delacambre'],
];
/** Six invented people on one role with two requirements of one sub-domain, assessed. */
async function world() {
    // an invented pillar with one sub-domain and two skills (rolled back)
    const dom = await db.get('INSERT INTO domains (name) VALUES (?) RETURNING id', [
        `CM pillar ${STAMP}`,
    ]);
    const sub = await db.get(
        'INSERT INTO sub_domains (domain_id, name) VALUES (?, ?) RETURNING id',
        [dom.id, `CM sub-domain ${STAMP}`]
    );
    const sd = { sid: Number(sub.id), pid: Number(dom.id) };
    const sk = [];
    for (const n of ['one', 'two'])
        sk.push(
            await db.get(
                'INSERT INTO skills (domain_id, sub_domain_id, name) VALUES (?, ?, ?) RETURNING id',
                [dom.id, sub.id, `CM skill ${n} ${STAMP}`]
            )
        );
    const o = await db.get(
        `SELECT sv.id AS "serviceId", sv.department_id AS "departmentId", d.site_id AS "siteId"
           FROM services sv JOIN departments d ON d.id = sv.department_id ORDER BY sv.id LIMIT 1`
    );
    const role = await db.get('INSERT INTO roles (name) VALUES (?) RETURNING id', [`CM-${STAMP}`]);
    for (const s of sk)
        await db.run(
            `INSERT INTO role_skill_requirements (role_id, skill_id, required_level, is_critical)
             VALUES (?, ?, 3, false)`,
            [role.id, s.id]
        );
    const ids = [];
    for (const [i, [f, l]] of NAMES.entries()) {
        const e = await db.get(
            `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                    service_id, role_id, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, true) RETURNING id`,
            [`CM-${i}-${STAMP}`, f, l, o.siteId, o.departmentId, o.serviceId, role.id]
        );
        ids.push(Number(e.id));
        for (const s of sk)
            await db.run(
                `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by, notes, validation)
                 VALUES (?, ?, ?, ?, 'map fixture', 'manager_validated'::skill_validation)`,
                [e.id, s.id, i % 2 ? 1 : 3, SUPER.id]
            );
    }
    return {
        ids,
        sid: Number(sd.sid),
        pid: Number(sd.pid),
        siteId: Number(o.siteId),
        skills: sk.length,
    };
}

const tr = (key, vars) => {
    const [ns, k] = String(key).split(':');
    // eslint-disable-next-line security/detect-non-literal-require
    const dict = require(`../../locales/en/${ns}.json`);
    const get = (p) =>
        p.split('.').reduce((o, x) => (o && typeof o === 'object' ? o[x] : undefined), dict);
    let v = get(k);
    if (typeof v !== 'string' && vars && vars.count !== undefined)
        v = get(k + (Number(vars.count) === 1 ? '_one' : '_other'));
    if (typeof v !== 'string') v = k;
    return v.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, x) => (vars && vars[x] != null ? vars[x] : ''));
};

suite('the capability map on the database', () => {
    test('one query: its marginals equal the heatmap cube and the population total', async () => {
        await inTx(async () => {
            const w = await world();
            const all = (await db.all('SELECT id FROM employees WHERE is_active')).map((r) =>
                Number(r.id)
            );
            const map = await D.capabilityMap(all, 'site');
            const heat = await D.capabilityHeat(all, 'site', 'domain');
            const tot = map.find((r) => r.part === 'total');
            const htot = heat.find((r) => r.part === 'total');
            expect(tot.sumActual).toBeCloseTo(htot.sumActual, 6);
            expect(tot.sumRequired).toBeCloseTo(htot.sumRequired, 6);
            expect(tot.n).toBe(htot.n);
            for (const u of map.filter((r) => r.part === 'u')) {
                const h = heat.find((r) => r.part === 'unit' && r.unitKey === u.unitKey);
                expect(u.n).toBe(h.n);
                expect(u.sumRequired).toBeCloseTo(h.sumRequired, 6);
            }
            for (const p of map.filter((r) => r.part === 'p')) {
                const h = heat.find((r) => r.part === 'axis' && r.key === p.pillarKey);
                expect(p.n).toBe(h.n);
            }
            expect(w.skills).toBeGreaterThan(0);
        });
    });

    test('every active pillar and sub-domain is a row; no name; n < 5 never a value', async () => {
        await inTx(async () => {
            const w = await world();
            const tree = await D.frameworkTree();
            const active = await db.get(
                `SELECT COUNT(*)::int AS n FROM sub_domains sd JOIN domains d ON d.id = sd.domain_id
                  WHERE sd.is_active AND d.is_active`
            );
            const m = H.capabilityMapModel(await D.capabilityMap(w.ids, 'site'), tree, {
                unit: 'site',
            });
            expect(m.rows.length).toBe(tree.length);
            expect(m.rows.reduce((a, x) => a + x.children.length, 0)).toBe(active.n);
            for (const row of m.rows.concat(...m.rows.map((x) => x.children)))
                for (const c of row.cells)
                    if (c.state === 'ok') expect(c.n).toBeGreaterThanOrEqual(5);
            const file = path.join(ROOT, 'views/partials/viz/capmap.ejs');
            const h = ejs.render(
                fs.readFileSync(file, 'utf8'),
                { __: tr, lang: 'en', numFmt: KF.forLang('en'), H: m, heatId: 'db' },
                { filename: file }
            );
            for (const [f, l] of NAMES) {
                expect(h).not.toContain(f);
                expect(h).not.toContain(l);
            }
            // the fixture's sub-domain is measured over the six people
            const p = m.rows.find((x) => x.key === String(w.pid));
            const s = p.children.find((x) => x.key === String(w.sid));
            expect(s.marg.state).toBe('ok');
            expect(s.marg.n).toBe(6);
        });
    });

    test('the tabs carry the map and the strip for « skills », nothing without it; the list names nobody', async () => {
        await inTx(async () => {
            const w = await world();
            const ctx = await D.context({ user: SUPER, query: {}, remember: false });
            const rd = await D.tabModel(ctx, 'readiness', { query: {} });
            expect(rd.blocks).toContain('capabilityMap');
            expect(rd.capabilityMap && rd.capabilityMap.totalFirst).toBe(true);
            expect(rd.blocks).not.toContain('pillarHeat');
            const ov = await D.tabModel(ctx, 'overview', { query: {} });
            expect(ov.capStrip && ov.capStrip.cols.length).toBeGreaterThan(0);
            // a reader without the skills capability (a viewer with no permission)
            const viewer = await db.get(
                `INSERT INTO admins (username, password_hash, role) VALUES (?, 'x', 'viewer') RETURNING id`,
                [`cm_viewer_${STAMP}`]
            );
            await db.run(
                `INSERT INTO admin_scopes (admin_id, scope_type, site_id) VALUES (?, 'site', ?)`,
                [viewer.id, w.siteId]
            );
            const vctx = await D.context({
                user: { userType: 'admin', role: 'viewer', id: Number(viewer.id), permissions: [] },
                query: {},
                remember: false,
            });
            const vrd = await D.tabModel(vctx, 'readiness', { query: {} });
            expect(vrd.blocks).not.toContain('capabilityMap');
            expect(vrd.capabilityMap).toBeUndefined();
            // the list behind a sub-domain cell: counts, never a name
            const list = await D.drillList(ctx, 'DOM', 's' + w.sid);
            expect(list.forbidden).toBeFalsy();
            expect(JSON.stringify(list)).not.toMatch(new RegExp(NAMES.map((n) => n[1]).join('|')));
            expect(await D.drillList(ctx, 'DOM', 'x' + w.sid)).toBeNull();
        });
    });
});
