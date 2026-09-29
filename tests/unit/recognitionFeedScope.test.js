'use strict';

/**
 * Recognition privacy — `team` visibility is NOT organisation-wide.
 *
 * RecognitionService.feed() returned every `team` item to every signed-in
 * person (WHERE visibility IN ('team','org')): a thank-you meant for a crew was
 * readable across the whole company. A `team` item now reaches only the people
 * around its recipient — sender, recipient, the recipient's department, their
 * line (supervisor / employee-manager, either way) and peers under the same
 * line. `org` stays organisation-wide; `private` never appears in a feed; no
 * viewer fails closed to `org` only.
 *
 * Part 1 is pure (the WHERE builder). Part 2 runs the real query against the
 * test database inside a transaction that is always rolled back; it is skipped
 * (not failed) when no database is reachable.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_URL = Boolean(process.env.DATABASE_URL);
if (!HAS_URL) jest.doMock('../../src/config/database', () => ({}));

const Rec = require('../../src/services/RecognitionService');

describe('feedScope — the WHERE clause for a viewer (pure)', () => {
    test('no viewer fails closed: org-wide items only', () => {
        expect(Rec.feedScope(null)).toEqual({ where: "r.visibility = 'org'", params: [] });
        expect(Rec.feedScope(undefined)).toEqual({ where: "r.visibility = 'org'", params: [] });
        expect(Rec.feedScope({})).toEqual({ where: "r.visibility = 'org'", params: [] });
    });

    test("visibility 'org' restricts to org items, whoever asks", () => {
        expect(Rec.feedScope({ all: true }, 'org').where).toBe("r.visibility = 'org'");
        expect(Rec.feedScope({ employeeId: 5 }, 'org').where).toBe("r.visibility = 'org'");
    });

    test('the SuperAdmin reads team and org, never private', () => {
        const { where, params } = Rec.feedScope({ all: true });
        expect(where).toBe("r.visibility IN ('team','org')");
        expect(where).not.toMatch(/private/);
        expect(params).toEqual([]);
    });

    test('an employee viewer: team items only around them, private never', () => {
        const { where, params } = Rec.feedScope({ employeeId: 7 });
        expect(where).toMatch(/^\(r\.visibility = 'org' OR \(r\.visibility = 'team' AND \(/);
        expect(where).toMatch(/r\.to_employee_id = \?/);
        expect(where).toMatch(/r\.from_employee_id = \?/);
        expect(where).toMatch(/me\.department_id = tf\.department_id/);
        expect(where).not.toMatch(/private/);
        expect(params).toEqual([7, 7, 7]);
    });

    test('a scoped admin: team items about the people in scope, ids sanitised', () => {
        const { where, params } = Rec.feedScope({ scopeIds: [3, '4', 'x', -1, null] });
        expect(where).toMatch(/r\.to_employee_id = ANY\(\?::bigint\[\]\)/);
        expect(params).toEqual([[3, 4]]);
    });

    test('an empty scope is org-only, not everything', () => {
        expect(Rec.feedScope({ scopeIds: [] }).where).toBe("r.visibility = 'org'");
    });

    test('the team predicate covers department, line both ways and peers', () => {
        const p = Rec.teamPredicate('me', 'tf');
        expect(p).toMatch(/me\.department_id = tf\.department_id/);
        expect(p).toMatch(/tf\.supervisor_id = me\.id/);
        expect(p).toMatch(/tf\.manager_id = me\.id/);
        expect(p).toMatch(/me\.supervisor_id = tf\.id/);
        expect(p).toMatch(/me\.manager_id = tf\.id/);
        expect(p).toMatch(/me\.supervisor_id = tf\.supervisor_id/);
        expect(p).toMatch(/me\.manager_id = tf\.manager_id/);
    });
});

// ------------------------------------------------------------------ DB proof
const ROLLBACK = new Error('recognition-feed-rollback');
let db = null;
let ready = false;

beforeAll(async () => {
    if (!HAS_URL) return;
    db = require('../../src/config/database');
    try {
        await db.connect();
        ready = Boolean(
            await db.get('SELECT 1 AS ok FROM employees e JOIN sites s ON s.id = e.site_id LIMIT 1')
        );
    } catch (_) {
        ready = false;
    }
}, 30000);

afterAll(async () => {
    if (db && db.close) {
        try {
            await db.close();
        } catch (_) {
            /* closed */
        }
    }
});

async function inRollback(fn) {
    try {
        await db.runTransaction(async () => {
            await fn();
            throw ROLLBACK;
        });
    } catch (e) {
        if (e !== ROLLBACK) throw e;
    }
}

const itDb = (name, fn) =>
    test(
        name,
        async () => {
            if (!ready) return;
            await inRollback(fn);
        },
        30000
    );

async function fixture() {
    const tpl = await db.get(
        `SELECT e.site_id, e.department_id, e.service_id, e.role_id
           FROM employees e ORDER BY e.id LIMIT 1`
    );
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    // A second department (and service) on the same site: "elsewhere".
    const dept2 = Number(
        (
            await db.get('INSERT INTO departments (site_id, name) VALUES (?, ?) RETURNING id', [
                tpl.siteId,
                `RFS-other-${stamp}`,
            ])
        ).id
    );
    const svc2 = Number(
        (
            await db.get('INSERT INTO services (department_id, name) VALUES (?, ?) RETURNING id', [
                dept2,
                `RFS-svc-${stamp}`,
            ])
        ).id
    );
    const mk = async (n, { dept = tpl.departmentId, svc = tpl.serviceId, sup = null } = {}) =>
        Number(
            (
                await db.get(
                    `INSERT INTO employees (employee_number, first_name, last_name, site_id,
                                            department_id, service_id, role_id, supervisor_id)
                     VALUES (?, ?, 'RFS', ?, ?, ?, ?, ?) RETURNING id`,
                    [`RFS-${n}-${stamp}`, n, tpl.siteId, dept, svc, tpl.roleId, sup]
                )
            ).id
        );
    const give = async (from, to, visibility, message) =>
        Number(
            (
                await db.get(
                    `INSERT INTO recognitions (from_employee_id, to_employee_id, message, visibility)
                     VALUES (?, ?, ?, ?) RETURNING id`,
                    [from, to, message, visibility]
                )
            ).id
        );
    return { dept2, svc2, mk, give, stamp };
}

const ids = (rows) => rows.map((r) => Number(r.id));

describe('RecognitionService.feed — against the database', () => {
    itDb('a team item is invisible to someone outside the recipient’s circle', async () => {
        const { dept2, svc2, mk, give, stamp } = await fixture();
        // Elsewhere: a manager and her report, in the OTHER department.
        const boss = await mk('Boss', { dept: dept2, svc: svc2 });
        const alice = await mk('Alice', { dept: dept2, svc: svc2, sup: boss });
        const bob = await mk('Bob', { dept: dept2, svc: svc2, sup: boss });
        // Outsider: first department, no line relationship with them.
        const zoe = await mk('Zoe');
        const team = await give(bob, alice, 'team', `team-${stamp}`);
        const org = await give(bob, alice, 'org', `org-${stamp}`);
        const priv = await give(bob, alice, 'private', `private-${stamp}`);

        const forZoe = ids(await Rec.feed({ limit: 500, viewer: { employeeId: zoe } }));
        expect(forZoe).toContain(org);
        expect(forZoe).not.toContain(team); // the leak this fixes
        expect(forZoe).not.toContain(priv);

        // The recipient, the sender, the manager and a peer all see it.
        for (const who of [alice, bob, boss]) {
            const seen = ids(await Rec.feed({ limit: 500, viewer: { employeeId: who } }));
            expect(seen).toContain(team);
            expect(seen).not.toContain(priv);
        }
        const peer = await mk('Peer', { dept: dept2, svc: svc2, sup: boss });
        expect(ids(await Rec.feed({ limit: 500, viewer: { employeeId: peer } }))).toContain(team);
    });

    itDb('the recipient’s department sees it; a report sees their manager’s item', async () => {
        const { dept2, svc2, mk, give, stamp } = await fixture();
        const lead = await mk('Lead');
        // Report in ANOTHER department, but supervised by lead.
        const rep = await mk('Rep', { dept: dept2, svc: svc2, sup: lead });
        const colleague = await mk('Colleague'); // same department as lead
        const toLead = await give(null, lead, 'team', `lead-${stamp}`);
        expect(ids(await Rec.feed({ limit: 500, viewer: { employeeId: colleague } }))).toContain(
            toLead
        );
        expect(ids(await Rec.feed({ limit: 500, viewer: { employeeId: rep } }))).toContain(toLead);
    });

    itDb('no viewer fails closed; a scoped admin sees only their scope', async () => {
        const { dept2, svc2, mk, give, stamp } = await fixture();
        const a = await mk('A', { dept: dept2, svc: svc2 });
        const b = await mk('B');
        const toA = await give(null, a, 'team', `a-${stamp}`);
        const toB = await give(null, b, 'team', `b-${stamp}`);
        const anon = ids(await Rec.feed({ limit: 500 }));
        expect(anon).not.toContain(toA);
        expect(anon).not.toContain(toB);
        const scoped = ids(await Rec.feed({ limit: 500, viewer: { scopeIds: [a] } }));
        expect(scoped).toContain(toA);
        expect(scoped).not.toContain(toB);
        const sup = ids(await Rec.feed({ limit: 500, viewer: { all: true } }));
        expect(sup).toEqual(expect.arrayContaining([toA, toB]));
    });

    itDb('colleaguesFor lists the circle, active only, never oneself', async () => {
        const { dept2, svc2, mk } = await fixture();
        const boss = await mk('Boss', { dept: dept2, svc: svc2 });
        const me = await mk('Me', { dept: dept2, svc: svc2, sup: boss });
        const peer = await mk('Peer', { dept: dept2, svc: svc2, sup: boss });
        const far = await mk('Far'); // other department, no line link
        const gone = await mk('Gone', { dept: dept2, svc: svc2 });
        await db.run('UPDATE employees SET is_active = false WHERE id = ?', [gone]);
        const list = ids(await Rec.colleaguesFor(me));
        expect(list).toEqual(expect.arrayContaining([boss, peer]));
        expect(list).not.toContain(me);
        expect(list).not.toContain(far);
        expect(list).not.toContain(gone);
        expect(await Rec.isColleague(me, peer)).toBe(true);
        expect(await Rec.isColleague(me, far)).toBe(false);
        expect(await Rec.isColleague(me, me)).toBe(false);
    });

    itDb('give() stores an unknown visibility as the default team audience', async () => {
        const { mk } = await fixture();
        const a = await mk('A');
        const b = await mk('B');
        const row = await Rec.give({
            fromEmployeeId: a,
            toEmployeeId: b,
            message: 'x',
            visibility: 'everyone',
        });
        expect(row.visibility).toBe('team');
    });
});
