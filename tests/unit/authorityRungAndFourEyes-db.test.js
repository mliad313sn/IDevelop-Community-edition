'use strict';
/**
 * Service probes on the real test database, each inside a rolled-back
 * transaction (tests/helpers/ladderWorld.js, invented people):
 *
 *   - four eyes on a 9-box placement: the drafter never approves, by either of
 *     their accounts; a SuperAdmin may approve their own draft with a written
 *     reason, journalled; switched off, the old behaviour comes back;
 *   - the audit lines record the rung an act used (` as=<rung>`);
 *   - the direct manager is told (line.acted_above) when someone above them
 *     approves a placement for their team — never when they act themselves;
 *   - an unlinked admin account sharing the person's identity is "self" on the
 *     9-box: it drafts nothing for them, and only for them.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = require('../helpers/testDatabase').isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(120000);

jest.mock('../../src/services/WebhookService', () => ({
    isEmittable: () => false,
    emit: async () => {},
    minimisePayload: () => ({}),
}));
const mockLogs = [];
jest.mock('../../src/services/LogService', () => ({
    log: jest.fn(async (e) => {
        mockLogs.push(e);
        return null;
    }),
}));

const W = require('../helpers/ladderWorld');
const db = HAS_DB ? require('../../src/config/database') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});
beforeEach(() => {
    mockLogs.length = 0;
});

const NB = () => require('../../src/services/NineBoxService');
const draft = (user, employeeId, performance = 'medium') =>
    NB().createDraft(user, { employeeId, performance, potential: 'medium' });
const codeOf = async (fn) => {
    try {
        await fn();
        return null;
    } catch (e) {
        return e.code || e.message;
    }
};

suite('four eyes on a 9-box placement', () => {
    test('the drafter cannot approve; another manager or a SuperAdmin can', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.build(db);
            const M = await W.hydrate(db, { employee: w.people.M });
            const SUPER = await W.hydrate(db, { admin: w.admins.SUPER });
            const d = await draft(M, w.people.P);
            const refused = await codeOf(() => NB().approve(M, d.id));
            const ok = await NB().approve(SUPER, d.id);
            return { refused, status: ok.status };
        });
        expect(out).toEqual({ refused: 'NINEBOX_FOUR_EYES', status: 'approved' });
    });

    test('the drafter’s linked admin account is the same person', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.build(db);
            // LA_SLUG may approve in its clearance — but it is M's own account now
            // (one admin account per person: the viewer lets go of M first).
            await db.run('UPDATE admins SET linked_employee_id = NULL WHERE id = ?', [
                w.admins.VIEWER,
            ]);
            await db.run('UPDATE admins SET linked_employee_id = ? WHERE id = ?', [
                w.people.M,
                w.admins.LA_SLUG,
            ]);
            const M = await W.hydrate(db, { employee: w.people.M });
            const mine = await W.hydrate(db, { admin: w.admins.LA_SLUG });
            const d = await draft(M, w.people.P);
            return codeOf(() => NB().approve(mine, d.id));
        });
        expect(out).toBe('NINEBOX_FOUR_EYES');
    });

    test('a SuperAdmin approves their own draft only with a written reason, journalled', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.build(db);
            const SUPER = await W.hydrate(db, { admin: w.admins.SUPER });
            const req = { user: SUPER, ip: null, get: () => null };
            const d = await draft(SUPER, w.people.Q);
            const none = await codeOf(() => NB().approve(SUPER, d.id, req));
            const short = await codeOf(() =>
                NB().approve(SUPER, d.id, req, { fourEyesReason: 'because' })
            );
            const ok = await NB().approve(SUPER, d.id, req, {
                fourEyesReason: 'Calibration session, the manager is on leave.',
            });
            return {
                none,
                short,
                status: ok.status,
                journal: mockLogs
                    .filter((e) => e.action === 'NINEBOX_FOUR_EYES_OVERRIDE')
                    .map((e) => e.details),
            };
        });
        expect(out.none).toBe('NINEBOX_FOUR_EYES');
        expect(out.short).toBe('NINEBOX_FOUR_EYES');
        expect(out.status).toBe('approved');
        expect(out.journal).toHaveLength(1);
        expect(out.journal[0]).toMatch(/reason: Calibration session, the manager is on leave\./);
    });

    test('switched off (an upgrade until a SuperAdmin decides), the drafter approves as before', async () => {
        const Settings = require('../../src/models/AppSettingsModel');
        const real = Settings.getValue.bind(Settings);
        const spy = jest
            .spyOn(Settings, 'getValue')
            .mockImplementation(async (k, d) => (k === 'nineBoxFourEyes' ? false : real(k, d)));
        try {
            const out = await W.inRolledBackTx(db, async () => {
                const w = await W.build(db);
                const M = await W.hydrate(db, { employee: w.people.M });
                const d = await draft(M, w.people.P);
                return (await NB().approve(M, d.id)).status;
            });
            expect(out).toBe('approved');
        } finally {
            spy.mockRestore();
        }
    });
});

suite('the rung on the audit line, and the notice to the direct manager', () => {
    test('a 9-box approval journals the rung it used (as=manager), and tells nobody', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.build(db);
            const S = await W.hydrate(db, { employee: w.people.S });
            const M = await W.hydrate(db, { employee: w.people.M });
            const d = await draft(S, w.people.P);
            await NB().approve(M, d.id, { user: M, ip: null, get: () => null });
            const notices = await db.all(
                "SELECT user_id FROM notifications WHERE kind = 'line.acted_above' AND (payload->>'employeeId')::int = ?",
                [w.people.P]
            );
            return {
                details: mockLogs
                    .filter((e) => e.action === 'NINEBOX_APPROVE')
                    .map((e) => e.details),
                notices: notices.length,
            };
        });
        expect(out.details).toHaveLength(1);
        expect(out.details[0]).toMatch(/ as=manager$/);
        expect(out.notices).toBe(0);
    });

    test('a SuperAdmin approving for M’s team: as=superadmin, and M is told (ids only)', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.build(db);
            const S = await W.hydrate(db, { employee: w.people.S });
            const SUPER = await W.hydrate(db, { admin: w.admins.SUPER });
            const d = await draft(S, w.people.P);
            await NB().approve(SUPER, d.id, { user: SUPER, ip: null, get: () => null });
            const notices = await db.all(
                `SELECT user_type, user_id, payload FROM notifications
                  WHERE kind = 'line.acted_above' AND (payload->>'employeeId')::int = ?`,
                [w.people.P]
            );
            return {
                M: w.people.M,
                P: w.people.P,
                details: mockLogs
                    .filter((e) => e.action === 'NINEBOX_APPROVE')
                    .map((e) => e.details),
                notices,
            };
        });
        expect(out.details[0]).toMatch(/ as=superadmin$/);
        expect(out.notices).toHaveLength(1);
        expect(out.notices[0].userType).toBe('employee');
        expect(Number(out.notices[0].userId)).toBe(out.M);
        expect(out.notices[0].payload).toEqual({
            action: 'ninebox_approved',
            employeeId: out.P,
            as: 'superadmin',
            link: '/talent/nine-box',
        });
    });

    test('a self-assessment approval by the supervisor journals as=supervisor', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.build(db);
            const skill = await db.get('SELECT id FROM skills ORDER BY id LIMIT 1');
            const sa = await db.get(
                `INSERT INTO self_assessments (employee_id, skill_id, self_rated_level, status, workflow_state)
                 VALUES (?, ?, 2, 'submitted', 'submitted') RETURNING id`,
                [w.people.P, skill.id]
            );
            const S = await W.hydrate(db, { employee: w.people.S });
            const SA = require('../../src/services/SelfAssessmentWorkflowService');
            await SA.approve(Number(sa.id), S, null, { user: S, ip: null, get: () => null });
            return mockLogs.filter((e) => e.action === 'SA_APPROVE').map((e) => e.details);
        });
        expect(out).toHaveLength(1);
        expect(out[0]).toMatch(/ as=supervisor$/);
    });
});

suite('the 9-box refuses one’s own record through a shared identity', () => {
    test('an unlinked SuperAdmin account with the person’s e-mail drafts nothing for them', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.build(db);
            const mail = (await db.get('SELECT email FROM employees WHERE id = ?', [w.people.P]))
                .email;
            await db.run('UPDATE admins SET email = ? WHERE id = ?', [
                `  ${String(mail).toUpperCase()} `,
                w.admins.SUPER,
            ]);
            const SUPER = await W.hydrate(db, { admin: w.admins.SUPER });
            const mine = await NB().resolveAuthority(SUPER, w.people.P);
            const theirs = await NB().resolveAuthority(SUPER, w.people.Q);
            return {
                mine: [mine.selfByIdentity, mine.canDraft, mine.canApprove],
                theirs: [theirs.selfByIdentity, theirs.canDraft, theirs.canApprove],
            };
        });
        expect(out.mine).toEqual([true, false, false]);
        expect(out.theirs).toEqual([false, true, true]);
    });
});
