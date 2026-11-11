'use strict';
/**
 * THE AUTHORITY LADDER on the real test database, every case inside a
 * rolled-back transaction (tests/helpers/ladderWorld.js, invented people).
 *
 * 1. STRICT MODE (the default) — NOBODY GAINS REACH. Every service is asked
 *    its OWN question (SelfAssessmentWorkflowService / CoachingPlanService /
 *    NineBoxService .resolveAuthority, PipService.actingAuthority,
 *    IDPService.planAuthority, LmsService._mayDecide, the 9-box and bulk route
 *    gates), never the ladder helper, and the answer is the pre-ladder reach,
 *    cell by cell: the line above reads and does not act (except the LMS
 *    uplift, which already reached the governed sub-tree), a local admin
 *    without the feature permission is refused where the feature asked for it.
 * 2. EXTENDED MODE — the ladder: the line above acts as the manager, a local
 *    admin in clearance acts without the feature permission. Never the
 *    subject, never a viewer, never a local admin outside their clearance.
 * 3. Extended never takes away what strict grants.
 * 4. Manager == supervisor: one rung, the union.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = require('../helpers/testDatabase').isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;

jest.mock('../../src/services/WebhookService', () => ({
    isEmittable: () => false,
    emit: async () => {},
    minimisePayload: () => ({}),
}));

const W = require('../helpers/ladderWorld');
const db = HAS_DB ? require('../../src/config/database') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const ACTIONS = [
    'sa.approve',
    'sa.validate',
    'sa.bulk_approve',
    'coaching.act',
    'coaching.manage',
    'ninebox.draft',
    'ninebox.approve',
    'pip.act',
    'idp.act',
    'lms.uplift',
];

// [label, account, target, strict row, extended row] — 1 = may act, 0 = refused,
// in the order of ACTIONS.
//                                         sa  sv  bk  ca  cm  nd  na  pip idp lms
const ACTORS = [
    ['supervisor', { p: 'S' }, 'P', '1 0 1 1 0 1 0 0 1 1', '1 0 1 1 0 1 0 0 1 1'],
    ['manager', { p: 'M' }, 'P', '1 1 1 1 1 1 1 1 1 1', '1 1 1 1 1 1 1 1 1 1'],
    ['line above (N+2)', { p: 'N2' }, 'P', '0 0 0 0 0 0 0 0 0 1', '1 1 1 1 1 1 1 1 1 1'],
    ['manager = supervisor', { p: 'M' }, 'Q', '1 1 1 1 1 1 1 1 1 1', '1 1 1 1 1 1 1 1 1 1'],
    [
        'supervisor on admin account',
        { a: 'ADMIN_S' },
        'P',
        '1 0 0 1 0 0 0 0 1 0',
        '1 0 1 1 0 1 0 0 1 1',
    ],
    ['admin named manager', { a: 'NAMED' }, 'R', '1 1 0 1 1 0 0 1 1 0', '1 1 1 1 1 1 1 1 1 1'],
    ['local admin in clearance', { a: 'LA_IN' }, 'P', '1 1 0 1 1 0 0 1 1 0', '1 1 1 1 1 1 1 1 1 1'],
    [
        'local admin with the permissions',
        { a: 'LA_SLUG' },
        'P',
        '1 1 1 1 1 1 1 1 1 1',
        '1 1 1 1 1 1 1 1 1 1',
    ],
    [
        'local admin out of clearance',
        { a: 'LA_OUT' },
        'P',
        '0 0 0 0 0 0 0 0 0 0',
        '0 0 0 0 0 0 0 0 0 0',
    ],
    [
        'viewer (line + clearance)',
        { a: 'VIEWER' },
        'P',
        '0 0 0 0 0 0 0 0 0 0',
        '0 0 0 0 0 0 0 0 0 0',
    ],
    ['self', { p: 'P' }, 'P', '0 0 0 0 0 0 0 0 0 0', '0 0 0 0 0 0 0 0 0 0'],
    ['superadmin', { a: 'SUPER' }, 'P', '1 1 1 1 1 1 1 1 1 1', '1 1 1 1 1 1 1 1 1 1'],
];
const row = (s) => Object.fromEntries(s.split(' ').map((v, i) => [ACTIONS[i], v === '1']));

/** Every service asked its own question, for every actor. */
async function measure(world) {
    const SA = require('../../src/services/SelfAssessmentWorkflowService');
    const Coaching = require('../../src/services/CoachingPlanService');
    const NineBox = require('../../src/services/NineBoxService');
    const Pip = require('../../src/services/PipService');
    const IDP = require('../../src/services/IDPService');
    const Lms = require('../../src/services/LmsService');
    const { requireLineOrPermission } = require('../../src/middleware/requireLineAuthority');
    const bulkGate = require('../../src/middleware/requireBulkApproveRight');
    const out = {};
    for (const [label, who, target] of ACTORS) {
        const spec = who.p ? { employee: world.people[who.p] } : { admin: world.admins[who.a] };
        const user = await W.hydrate(db, spec);
        const eid = world.people[target];
        const sa = await SA.resolveAuthority(user, eid);
        const own = sa.isSelf || sa.selfByIdentity;
        const co = await Coaching.resolveAuthority(user, eid);
        const nb = await NineBox.resolveAuthority(user, eid);
        const nbRoute = await W.passes(requireLineOrPermission('manage_talent_reviews'), user);
        const bulkRoute = await W.passes(bulkGate, user, { items: [{ id: 1 }, { id: 2 }] });
        out[label] = {
            'sa.approve': Boolean(sa.canSupervise && !own),
            'sa.validate': Boolean(sa.canManage && !own),
            'sa.bulk_approve': Boolean(bulkRoute && sa.canSupervise && !own),
            'coaching.act': Boolean(co.canSupervise),
            'coaching.manage': Boolean(co.canManage),
            'ninebox.draft': Boolean(nbRoute && nb.canDraft),
            'ninebox.approve': Boolean(nbRoute && nb.canApprove),
            'pip.act': Boolean((await Pip.actingAuthority(user, eid)).canAct),
            'idp.act': Boolean((await IDP.planAuthority(user, { employeeId: eid })).canAct),
            'lms.uplift': Boolean(await Lms._mayDecide(user, eid)),
        };
    }
    return out;
}

function withMode(mode, fn) {
    const A = require('../../src/services/AuthorityService');
    const spy = jest.spyOn(A, 'mode').mockResolvedValue(mode);
    return Promise.resolve()
        .then(fn)
        .finally(() => spy.mockRestore());
}

suite('the ladder — every service asked, real database, rolled back', () => {
    jest.setTimeout(240000);
    let strict = null;
    let extended = null;
    let defaultMode = null;

    beforeAll(async () => {
        await W.inRolledBackTx(db, async () => {
            const world = await W.build(db);
            // Nothing stubbed: the mode really comes from the App Settings.
            defaultMode = await require('../../src/services/AuthorityService').mode();
            strict = await measure(world);
            extended = await withMode('extended', () => measure(world));
        });
    });

    test('the default mode is strict', () => {
        expect(defaultMode).toBe('strict');
    });

    const cells = (col) =>
        ACTORS.flatMap((a) => ACTIONS.map((action) => [a[0], action, row(a[col])[action]]));

    test.each(cells(3))('strict (default): %s — %s → %p', (label, action, want) => {
        expect(strict[label][action]).toBe(want);
    });

    test.each(cells(4))('extended: %s — %s → %p', (label, action, want) => {
        expect(extended[label][action]).toBe(want);
    });

    test('extended never takes away a right strict grants', () => {
        const lost = [];
        for (const [label] of ACTORS)
            for (const a of ACTIONS)
                if (strict[label][a] && !extended[label][a]) lost.push(label + a);
        expect(lost).toEqual([]);
    });
});

suite('manager == supervisor: one rung, the union', () => {
    jest.setTimeout(120000);
    test('M is both supervisor and manager of Q: the manager rung, every action', async () => {
        const A = require('../../src/services/AuthorityService');
        const out = await W.inRolledBackTx(db, async () => {
            const world = await W.build(db);
            const u = await W.hydrate(db, { employee: world.people.M });
            const rel = await A.relation(u, world.people.Q);
            const acts = [];
            for (const action of Object.keys(A.ACTIONS)) {
                const r = await A.canAct(u, action, world.people.Q);
                if (!r.ok) acts.push(action);
            }
            return { rel, refused: acts };
        });
        expect(out.rel.isSupervisor).toBe(true);
        expect(out.rel.isDirectManager).toBe(true);
        expect(out.rel.holds).toEqual(['supervisor', 'manager']);
        expect(out.rel.as).toBe('manager');
        expect(out.refused).toEqual([]);
    });
});
