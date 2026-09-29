'use strict';
/**
 * SECTION accounts — B3 + B4. Reverting a lifecycle event must undo THAT event, and must
 * describe honestly what it did and did not undo.
 *
 * B3 — `revert('joiner')` deleted the arrival's blank shells from
 * `assessment_cycles WHERE status = 'open'` AS EVALUATED AT REVERT TIME, not
 * from the campaign the arrival was actually enrolled into. Reproduced by
 * rolled-back probe (50 shells seeded in campaign A, A closed, unrelated
 * campaign B opened with 1 shell for the same person):
 *
 *   revert() summary -> {"kind":"joiner","employeeId":84,"assessmentShellsRemoved":1}
 *   AFTER revert -> origin campaign A still holds: 50 | unrelated campaign B now holds: 0
 *   VERDICT: DEFECT — wrong campaign touched
 *
 * It destroyed a row from an unrelated live campaign, left every row it was
 * meant to remove, and reported "1 removed". After the fix, same probe:
 *
 *   revert() summary -> {"kind":"joiner","employeeId":84,"originCycleId":25,"assessmentShellsRemoved":50}
 *   AFTER revert -> origin campaign A still holds: 0 | unrelated campaign B now holds: 1
 *
 * B4 — `revert('leaver')` answered `reactivated: true` while the linked ADMIN
 * account onLeaver had deactivated stayed off and its API keys stayed revoked:
 *
 *   AFTER leaver  employee.is_active = false | linked admin.is_active = false | api key live = false
 *   revert() summary -> {"kind":"leaver","employeeId":84,"reactivated":true}
 *   AFTER revert  employee.is_active = true  | linked admin.is_active = false | api key live = false
 *
 * After the fix: {"adminAccountsReactivated":1,"apiKeysRestored":1,"reactivated":true}
 * and all three are live again. For a LEGACY event that recorded nothing, the
 * keys are reported as `apiKeysRestored: null, apiKeysNotRecorded: true` — an
 * unmeasured thing is surfaced, never dressed up as a count.
 *
 * DB mocked; the live behaviour is the rolled-back probe quoted above.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const Lifecycle = require('../../src/services/LifecycleService');

const EVENT_SQL = /FROM lifecycle_events WHERE id/;
const WINDOW_SQL = /FROM assessment_cycles\s+WHERE opened_at <= \? AND closes_at >= \?/;

/** Every db.run call whose SQL matches, as { sql, params }. */
const runs = (re) =>
    mockDb.run.mock.calls.filter(([sql]) => re.test(sql)).map(([sql, params]) => ({ sql, params }));

function stubRevert(event, { cycleExists = true, windowCycleId = null } = {}) {
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.run.mockResolvedValue({ changes: 1 });
    mockDb.all.mockResolvedValue([]);
    mockDb.get.mockImplementation(async (sql) => {
        if (EVENT_SQL.test(sql)) return event;
        if (WINDOW_SQL.test(sql)) return windowCycleId ? { id: windowCycleId } : null;
        if (/FROM assessment_cycles WHERE id/.test(sql))
            return cycleExists ? { id: event.payload && event.payload.cycleId } : null;
        return null;
    });
}

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset();
    mockDb.run.mockReset();
    mockDb.runTransaction.mockReset();
});

describe('B3 — a joiner revert undoes ITS OWN campaign', () => {
    const joiner = (payload, occurredAt = '2026-01-10T00:00:00.000Z') => ({
        id: 3,
        employeeId: 84,
        kind: 'joiner',
        revertedAt: null,
        occurredAt,
        payload,
    });

    test('the shells deleted are bound to the cycle the event recorded', async () => {
        stubRevert(joiner({ cycleId: 25 }));
        const s = await Lifecycle.revert(3, { adminId: 1 });
        const [del] = runs(/DELETE FROM self_assessments/);
        expect(del).toBeDefined();
        expect(del.params).toContain(25);
        expect(s.originCycleId).toBe(25);
    });

    test("it never re-reads 'whatever campaign is open now'", async () => {
        stubRevert(joiner({ cycleId: 25 }));
        await Lifecycle.revert(3, { adminId: 1 });
        const [del] = runs(/DELETE FROM self_assessments/);
        expect(del.sql).not.toMatch(/status\s*=\s*'open'/);
    });

    test('only unrated provisional shells are in range — a real "None" answer survives', async () => {
        stubRevert(joiner({ cycleId: 25 }));
        await Lifecycle.revert(3, { adminId: 1 });
        const [del] = runs(/DELETE FROM self_assessments/);
        expect(del.sql).toMatch(/self_rated_level IS NULL/);
        expect(del.sql).not.toMatch(/self_rated_level\s*=\s*0/);
    });

    test('a legacy event with no recorded cycle falls back to the campaign open AT THE TIME', async () => {
        stubRevert(joiner({}), { windowCycleId: 41 });
        const s = await Lifecycle.revert(3, { adminId: 1 });
        const win = mockDb.get.mock.calls.find(([sql]) => WINDOW_SQL.test(sql));
        expect(win).toBeDefined();
        // the window is probed with the event's own timestamp, not "now"
        expect(win[1]).toEqual(['2026-01-10T00:00:00.000Z', '2026-01-10T00:00:00.000Z']);
        expect(s.originCycleId).toBe(41);
    });

    test('when no campaign can be tied to the event, NOTHING is deleted and the summary says so', async () => {
        stubRevert(joiner({}), { windowCycleId: null });
        const s = await Lifecycle.revert(3, { adminId: 1 });
        expect(runs(/DELETE FROM self_assessments/)).toHaveLength(0);
        expect(s.originCycleUnknown).toBe(true);
        expect(s.assessmentShellsRemoved).toBe(0);
    });

    test('a recorded cycle that no longer exists is not trusted blindly', async () => {
        stubRevert(joiner({ cycleId: 999 }), { cycleExists: false, windowCycleId: 41 });
        const s = await Lifecycle.revert(3, { adminId: 1 });
        expect(s.originCycleId).toBe(41);
    });
});

describe('B3 — onJoiner records the campaign it enrolled into', () => {
    test('processing a joiner stamps payload.cycleId on the event', async () => {
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM assessment_cycles WHERE status='open'/.test(sql)) return { id: 25 };
            return null;
        });
        mockDb.all.mockResolvedValue([]);
        mockDb.run.mockResolvedValue({ changes: 1 });
        await Lifecycle.onJoiner({ employeeId: 84 });
        const [stamp] = runs(/UPDATE lifecycle_events/);
        expect(stamp).toBeDefined();
        expect(stamp.sql).toMatch(/jsonb_build_object\('cycleId'/);
        expect(stamp.params[0]).toBe(25);
    });
});

describe('B4 — a leaver revert restores the access the leaver took away', () => {
    const leaver = (payload) => ({
        id: 8,
        employeeId: 84,
        kind: 'leaver',
        revertedAt: null,
        occurredAt: '2026-01-10T00:00:00.000Z',
        payload,
    });

    test('the linked admin accounts it deactivated are switched back on', async () => {
        stubRevert(leaver({ revokedAdminIds: [12], revokedApiKeyIds: [] }));
        const s = await Lifecycle.revert(8, { adminId: 1 });
        const [up] = runs(/UPDATE admins SET is_active = true WHERE id = \?/);
        expect(up).toBeDefined();
        expect(up.params).toContain(12);
        expect(s.adminAccountsReactivated).toBe(1);
    });

    test('the API keys it revoked are un-revoked — exactly those, by id', async () => {
        stubRevert(leaver({ revokedAdminIds: [12], revokedApiKeyIds: [77, 78] }));
        mockDb.all.mockResolvedValue([{ id: 77 }, { id: 78 }]);
        const s = await Lifecycle.revert(8, { adminId: 1 });
        const call = mockDb.all.mock.calls.find(([sql]) =>
            /UPDATE api_keys SET revoked_at = NULL/.test(sql)
        );
        expect(call).toBeDefined();
        expect(call[1]).toEqual([77, 78]);
        expect(call[0]).toMatch(/revoked_at IS NOT NULL/); // never resurrect a key killed for another reason
        expect(s.apiKeysRestored).toBe(2);
    });

    test('a legacy event reports the keys as NOT RECORDED rather than as zero restored', async () => {
        stubRevert(leaver({}));
        const s = await Lifecycle.revert(8, { adminId: 1 });
        expect(s.apiKeysNotRecorded).toBe(true);
        expect(s.apiKeysRestored).toBeNull();
        expect(s.adminAccountsInferred).toBe(true);
    });

    test('reactivated:true is now backed by the admin + key restore, not asserted alone', async () => {
        stubRevert(leaver({ revokedAdminIds: [12], revokedApiKeyIds: [77] }));
        mockDb.all.mockResolvedValue([{ id: 77 }]);
        const s = await Lifecycle.revert(8, { adminId: 1 });
        expect(s.reactivated).toBe(true);
        expect(s).toHaveProperty('adminAccountsReactivated');
        expect(s).toHaveProperty('apiKeysRestored');
    });
});

describe('B4 — onLeaver records what it switched off', () => {
    test('the processed event carries the admin ids and key ids it revoked', async () => {
        mockDb.get.mockResolvedValue(null);
        mockDb.run.mockResolvedValue({ changes: 1 });
        mockDb.all.mockImplementation(async (sql) => {
            if (/FROM admins WHERE linked_employee_id/.test(sql)) return [{ id: 12 }];
            if (/FROM api_keys WHERE owner_admin_id/.test(sql)) return [{ id: 77 }, { id: 78 }];
            return [];
        });
        await Lifecycle.onLeaver({ employeeId: 84 });
        const [stamp] = runs(/UPDATE lifecycle_events/);
        expect(stamp).toBeDefined();
        expect(stamp.sql).toMatch(/'revokedAdminIds'/);
        expect(stamp.sql).toMatch(/'revokedApiKeyIds'/);
        expect(JSON.parse(stamp.params[0])).toEqual([12]);
        expect(JSON.parse(stamp.params[1])).toEqual([77, 78]);
    });
});
