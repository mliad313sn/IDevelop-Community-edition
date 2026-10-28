'use strict';
/**
 * The authority ladder, pure: AuthorityService.allows / strictAllows /
 * ladderAllows over every combination of facts, the route half
 * (requireLineOrPermission, requireBulkApproveRight) and the view flag
 * (mayBulkApprove), in both modes. No database.
 *
 * The regression this file exists for: in STRICT mode (the default) the
 * ladder hands back exactly the caller's own pre-ladder rule — nobody gains
 * reach — and the route guards are exactly requireManagerOrAnyPermission.
 */
jest.mock('../../src/config/database', () => ({
    get: async () => null,
    all: async () => [],
    run: async () => ({ changes: 0 }),
}));
const mockSettings = { mode: 'strict' };
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: async (key, def) => (key === 'authority.ladder' ? mockSettings.mode : def),
}));

const A = require('../../src/services/AuthorityService');

const FACTS = [
    'isAdmin',
    'isSuper',
    'isLocalAdmin',
    'isViewer',
    'isSelf',
    'selfByIdentity',
    'isSupervisor',
    'isDirectManager',
    'isAdminManager',
    'isLineAbove',
    'inClearance',
];

/** A relation as AuthorityService.relation builds it, from raw facts. */
function relOf(f, mode) {
    const strictHolds = [];
    if (f.isSupervisor) strictHolds.push('supervisor');
    if (f.isDirectManager || f.isAdminManager) strictHolds.push('manager');
    if (f.isLocalAdmin && f.inClearance) strictHolds.push('localadmin');
    if (f.isSuper) strictHolds.push('superadmin');
    const ladderHolds = strictHolds.slice();
    if (f.isLineAbove) ladderHolds.push('manager');
    const top = (l) => l.reduce((n, h) => Math.max(n, A.RUNG[h]), 0);
    const blocked = f.isViewer || f.isSelf || f.selfByIdentity;
    const strictRung = blocked ? 0 : top(strictHolds);
    const ladderRung = blocked ? 0 : top(ladderHolds);
    const rung = mode === 'extended' ? ladderRung : strictRung;
    return {
        ...f,
        employee: { id: 1 },
        mode,
        strictRung,
        ladderRung,
        rung,
        as: A.rungName(rung),
    };
}

/** Every coherent combination of facts (2^11, minus impossible ones). */
function* combos() {
    for (let m = 0; m < 1 << FACTS.length; m++) {
        const f = {};
        FACTS.forEach((k, i) => (f[k] = Boolean(m & (1 << i))));
        const roles = [f.isSuper, f.isLocalAdmin, f.isViewer].filter(Boolean).length;
        if (roles > 1) continue;
        if ((f.isSuper || f.isLocalAdmin || f.isViewer || f.isAdminManager) && !f.isAdmin) continue;
        if (f.selfByIdentity && (f.isSelf || !f.isAdmin)) continue;
        if (f.isSuper && !f.inClearance) continue;
        if (f.isLineAbove && (f.isSupervisor || f.isDirectManager)) continue;
        yield f;
    }
}

describe('the action table', () => {
    test('every action names a rung of the ladder; single and bulk approval share one rule', () => {
        for (const def of Object.values(A.ACTIONS))
            expect(['supervisor', 'manager']).toContain(def.min);
        expect(A.ACTIONS['sa.bulk_approve']).toEqual(A.ACTIONS['sa.approve']);
        const managers = Object.keys(A.ACTIONS).filter((a) => A.ACTIONS[a].min === 'manager');
        expect(managers.sort()).toEqual(
            [
                'coaching.manage',
                'feedback360.manage',
                'ninebox.approve',
                'oneonone.act',
                'pip.act',
                'sa.arbitrate',
                'sa.validate',
            ].sort()
        );
    });

    test('the two-party spaces and the first dispute levels keep their reach in both modes', () => {
        const fixed = Object.keys(A.ACTIONS).filter((a) => A.ACTIONS[a].widens === false);
        expect(fixed.sort()).toEqual(
            [
                'dispute.l0',
                'dispute.l1',
                'feedback360.launch',
                'feedback360.manage',
                'oneonone.act',
            ].sort()
        );
    });

    test('an unknown action is a programming error, never a silent yes', () => {
        expect(() => A.allows(relOf({ isSuper: true, isAdmin: true }, 'extended'), 'sa.x')).toThrow(
            /unknown action/
        );
        expect(() => A.strictAllows({}, '__proto__')).toThrow(/unknown action/);
    });
});

describe('STRICT mode: the ladder hands back the caller’s own rule, nothing more', () => {
    test('for every combination of facts, every action, both answers of the caller', () => {
        const drift = [];
        for (const f of combos()) {
            const rel = relOf(f, 'strict');
            for (const action of Object.keys(A.ACTIONS))
                for (const strict of [true, false]) {
                    const got = A.allows(rel, action, { strict }).ok;
                    if (got !== strict) drift.push(`${action} ${JSON.stringify(f)} ${strict}`);
                }
        }
        expect(drift).toEqual([]);
    });

    test('without a caller rule, strictAllows is the pre-ladder 9-box rule (plus own-record refusal)', () => {
        // NineBoxService before the ladder, verbatim (slug held or not), with the
        // own-record refusal the port adds.
        const legacy = (f, hasSlug, approve) => {
            const adminMayDecide = f.isSuper || (f.isLocalAdmin && f.inClearance && hasSlug);
            const isManager = f.isDirectManager || f.isAdminManager;
            const own = f.isSelf || f.selfByIdentity;
            return approve
                ? !f.isViewer && !own && Boolean(adminMayDecide || isManager)
                : !f.isViewer && !own && Boolean(adminMayDecide || f.isSupervisor || isManager);
        };
        const drift = [];
        for (const f of combos())
            for (const hasSlug of [true, false]) {
                const rel = relOf(f, 'strict');
                const user = { permissions: hasSlug ? ['manage_talent_reviews'] : [] };
                for (const [action, approve] of [
                    ['ninebox.draft', false],
                    ['ninebox.approve', true],
                ])
                    if (A.strictAllows(rel, action, user) !== legacy(f, hasSlug, approve))
                        drift.push(`${action} ${hasSlug} ${JSON.stringify(f)}`);
            }
        expect(drift).toEqual([]);
    });

    test('the route guard is exactly requireManagerOrAnyPermission', async () => {
        mockSettings.mode = 'strict';
        const { requireLineOrPermission } = require('../../src/middleware/requireLineAuthority');
        const { requireManagerOrAnyPermission } = require('../../src/middleware/auth');
        for (const u of Object.values(USERS))
            for (const slug of ['manage_talent_reviews', 'approve_assessments'])
                expect([u.id, slug, await run(requireLineOrPermission(slug), u)]).toEqual([
                    u.id,
                    slug,
                    await run(requireManagerOrAnyPermission(slug), u),
                ]);
    });
});

describe('EXTENDED mode: the ladder adds, never removes; self and read-only never act', () => {
    test('extended ⊇ strict, and the ladder half never grants self, identity-self or a viewer', () => {
        const bad = [];
        for (const f of combos()) {
            const rel = relOf(f, 'extended');
            for (const action of Object.keys(A.ACTIONS)) {
                if (!A.allows(rel, action, { strict: true }).ok) bad.push(`lost ${action}`);
                const wide = A.allows(rel, action, { strict: false });
                if (wide.ok && (f.isSelf || f.selfByIdentity || f.isViewer))
                    bad.push(`granted ${action} ${JSON.stringify(f)}`);
                if (wide.ok && A.ACTIONS[action].widens === false) bad.push(`widened ${action}`);
            }
        }
        expect(bad).toEqual([]);
    });

    test.each([
        ['supervisor', { isSupervisor: true }, true, false],
        ['line above', { isLineAbove: true }, true, true],
        ['direct manager', { isDirectManager: true }, true, true],
        ['admin named manager', { isAdmin: true, isAdminManager: true }, true, true],
        [
            'local admin in clearance',
            { isAdmin: true, isLocalAdmin: true, inClearance: true },
            true,
            true,
        ],
        ['local admin out of clearance', { isAdmin: true, isLocalAdmin: true }, false, false],
        ['superadmin', { isAdmin: true, isSuper: true, inClearance: true }, true, true],
    ])('%s: supervisor actions %p, manager actions %p', (_l, f, sup, mgr) => {
        const rel = relOf(f, 'extended');
        expect(A.allows(rel, 'sa.approve', { strict: false }).ok).toBe(sup);
        expect(A.allows(rel, 'pip.act', { strict: false }).ok).toBe(mgr);
        expect(A.allows(rel, 'ninebox.approve', { strict: false }).ok).toBe(mgr);
    });

    test('refusals carry their reason', () => {
        const r = (f, a = 'sa.approve') => A.allows(relOf(f, 'extended'), a, { strict: false });
        expect(r({ isSelf: true, isSupervisor: true }).reason).toBe('self');
        expect(
            r({ isAdmin: true, selfByIdentity: true, isSuper: true, inClearance: true }).reason
        ).toBe('self');
        expect(
            r({ isAdmin: true, isViewer: true, isLineAbove: true, inClearance: true }).reason
        ).toBe('read_only');
        expect(r({ isAdmin: true, isLocalAdmin: true }).reason).toBe('out_of_scope');
        expect(r({}).reason).toBe('not_in_line');
        expect(r({ isSupervisor: true }, 'pip.act').reason).toBe('rung_too_low');
        expect(A.allows(null, 'sa.approve').reason).toBe('not_found');
    });

    test('the route guard lets every non-read-only account through, the service decides', async () => {
        mockSettings.mode = 'extended';
        const { requireLineOrPermission } = require('../../src/middleware/requireLineAuthority');
        const got = {};
        for (const [k, u] of Object.entries(USERS))
            got[k] = await run(requireLineOrPermission('manage_talent_reviews'), u);
        mockSettings.mode = 'strict';
        expect(got).toEqual({
            manager: 'next',
            employee: 403,
            local: 'next',
            localSlug: 'next',
            viewer: 403,
            super: 'next',
        });
    });
});

describe('the audit rung (as=<rung>)', () => {
    test('withAs leaves the details unchanged when no rung was resolved', () => {
        const u = { id: 1, userType: 'admin' };
        expect(A.withAs('x', u)).toBe('x');
        expect(A.withAs(null, u)).toBeNull();
    });

    test('a granted act records its rung, per session user and person', () => {
        const u = { id: 7, userType: 'manager' };
        A.noteAs(u, 42, 'manager');
        expect(A.withAs('approved', u)).toBe('approved as=manager');
        expect(A.withAs('approved', u, 42)).toBe('approved as=manager');
        expect(A.withAs('approved', u, 43)).toBe('approved');
        expect(A.withAs('approved', { id: 7, userType: 'manager' })).toBe('approved');
    });
});

// ---------------------------------------------------------------------------
const USERS = {
    manager: { id: 137, userType: 'manager' },
    employee: { id: 138, userType: 'employee' },
    local: { id: 69, userType: 'admin', role: 'localadmin', permissions: [] },
    localSlug: {
        id: 71,
        userType: 'admin',
        role: 'localadmin',
        permissions: ['manage_talent_reviews', 'approve_assessments'],
    },
    viewer: {
        id: 70,
        userType: 'admin',
        role: 'viewer',
        permissions: ['approve_assessments', 'manage_talent_reviews'],
    },
    super: { id: 68, userType: 'admin', role: 'superadmin', permissions: [] },
};

function run(mw, user, body = {}) {
    return new Promise((resolve) => {
        const req = {
            user,
            body,
            headers: { accept: 'application/json' },
            get: () => 'application/json',
            xhr: true,
            isAuthenticated: () => Boolean(user),
            originalUrl: '/x',
            method: 'POST',
            flash: () => {},
        };
        const res = {
            status(c) {
                this.code = c;
                return this;
            },
            json() {
                resolve(this.code || 200);
                return this;
            },
            redirect() {
                resolve(302);
            },
            render() {
                resolve(this.code || 200);
            },
            set() {
                return this;
            },
            setHeader() {},
            locals: {},
        };
        mw(req, res, () => resolve('next'));
    });
}

describe('bulk approval guard and view flag', () => {
    const bulk = require('../../src/middleware/requireBulkApproveRight');
    const three = { items: [{ id: 1 }, { id: 2 }, { id: 3 }] };

    test.each([
        ['manager', 'next', 'next'],
        ['local', 403, 'next'],
        ['localSlug', 'next', 'next'],
        ['super', 'next', 'next'],
        ['employee', 403, 403],
        ['viewer', 403, 403],
    ])('3 items, %s: strict %p, extended %p', async (who, strictWant, extendedWant) => {
        mockSettings.mode = 'strict';
        expect(await run(bulk, USERS[who], three)).toBe(strictWant);
        expect(await bulk.mayBulkApprove(USERS[who])).toBe(strictWant === 'next');
        mockSettings.mode = 'extended';
        expect(await run(bulk, USERS[who], three)).toBe(extendedWant);
        expect(await bulk.mayBulkApprove(USERS[who])).toBe(extendedWant === 'next');
        mockSettings.mode = 'strict';
    });

    test('one item is a single approval: the service decides', async () => {
        expect(await run(bulk, USERS.employee, { items: [{ id: 1 }] })).toBe('next');
    });
});

describe('the routes use the ladder guard', () => {
    const fs = require('fs');
    const path = require('path');
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
    const reg = (src, route) => {
        const i = src.indexOf(`'${route}'`);
        return src.slice(i, src.indexOf(')', src.indexOf('Controller', i)));
    };

    test.each([
        '/api/self-assessment/employee/:employeeId/approve-all',
        '/api/self-assessment/team/approve-all',
        '/api/ninebox',
        '/api/ninebox/:id/approve',
        '/api/ninebox/:id/disclose',
    ])('index.js %s → requireLineOrPermission', (route) => {
        expect(reg(read('src/routes/index.js'), route)).toMatch(/requireLineOrPermission\(/);
    });

    test('dispute L0/L1 refuse the own record through the ladder; L2 stays with the arbiter', () => {
        const slf = read('src/routes/v2-slf.js');
        for (const l of ['0', '1']) {
            const i = slf.indexOf(`'/disputes/:id/resolve-l${l}'`);
            expect(slf.slice(i, i + 300)).toMatch(
                new RegExp(`guardDisputeScope\\(req, res, 'L${l}'\\)`)
            );
        }
        const j = slf.indexOf("'/disputes/:id/resolve-l2'");
        expect(slf.slice(j, j + 300)).toMatch(/canArbitrate\(req\.user\)/);
    });
});
