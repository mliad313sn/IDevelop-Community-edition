'use strict';
/**
 * ZDB-1 — a snapshot restore never deletes an append-only journal.
 *
 * Measured on the test base (transaction rolled back): the wipe set computed
 * from live FK metadata held 91 tables, three of them append-only journals;
 * the restore disabled two triggers, took a pg_dump restore point, then died
 * on the third — 23514 "IMMUTABLE_TABLE: self_assessment_events is
 * append-only". On a base where a trigger was never installed, the same DELETE
 * would have destroyed nine_box_events / lifecycle_events / employee_movements.
 *
 * Rule: journals (declared by the database's block_mutation triggers UNION the
 * product's list) are out of the wipe set; when one of them references a
 * table to be wiped, the restore is refused BEFORE any pg_dump or write.
 */
const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/SnapshotModel', () => ({ findById: jest.fn(), create: jest.fn() }));
const mockCreateRestorePoint = jest.fn().mockResolvedValue({ name: 'rp', sizeBytes: 1 });
jest.mock('../../src/services/SqlConsoleService', () => ({
    createRestorePoint: mockCreateRestorePoint,
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const SnapshotModel = require('../../src/models/SnapshotModel');
const Snap = require('../../src/services/SnapshotService');

// A small schema: employees (root) ← self_assessment_rounds ← self_assessment_events (journal)
//                  employees ← nine_box_evaluations ← nine_box_events (journal, NO trigger installed)
//                  employees ← pip_plans (workflow table, wiped)
const EDGES = [
    {
        child: 'self_assessment_rounds',
        parent: 'employees',
        childCol: 'employee_id',
        deleteRule: 'c',
    },
    {
        child: 'self_assessment_events',
        parent: 'self_assessment_rounds',
        childCol: 'self_assessment_id',
        deleteRule: 'c',
    },
    {
        child: 'nine_box_evaluations',
        parent: 'employees',
        childCol: 'employee_id',
        deleteRule: 'c',
    },
    {
        child: 'nine_box_events',
        parent: 'nine_box_evaluations',
        childCol: 'evaluation_id',
        deleteRule: 'c',
    },
    { child: 'pip_plans', parent: 'employees', childCol: 'employee_id', deleteRule: 'c' },
    { child: 'admins', parent: 'employees', childCol: 'linked_employee_id', deleteRule: 'n' },
];
// Only self_assessment_events carries a trigger in this schema.
const TRIGGERS = [{ tableName: 'self_assessment_events' }];

function wireDb(rowCounts) {
    mockDb.all.mockImplementation(async (sql) => {
        if (/pg_trigger/.test(sql)) return TRIGGERS;
        if (/pg_constraint/.test(sql)) return EDGES;
        return [];
    });
    mockDb.get.mockImplementation(async (sql) => {
        const m = /FROM (\w+) WHERE (\w+) IS NOT NULL/.exec(sql);
        if (m) return { n: rowCounts[m[1]] || 0 };
        return {};
    });
    mockDb.run.mockResolvedValue({ changes: 0 });
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('the wipe set', () => {
    test('excludes every journal — declared by trigger OR by the product list', async () => {
        wireDb({});
        const { wipe, protected: prot } = await Snap.assertRestorable({});
        expect(wipe.has('employees')).toBe(true);
        expect(wipe.has('pip_plans')).toBe(true); // workflow table: still reset-to-snapshot
        expect(wipe.has('self_assessment_rounds')).toBe(true);
        expect(wipe.has('nine_box_evaluations')).toBe(true);
        // journals:
        expect(wipe.has('self_assessment_events')).toBe(false); // trigger-declared
        expect(wipe.has('nine_box_events')).toBe(false); // product list, no trigger here
        expect(wipe.has('admins')).toBe(false);
        expect(prot.has('nine_box_events')).toBe(true);
        expect(prot.has('system_logs')).toBe(true);
    });

    test('assessment_history stays restorable (captured and replaced by the snapshot itself)', () => {
        expect(Snap.constructor.PROTECTED_JOURNALS).not.toContain('assessment_history');
    });
});

describe('assertRestorable', () => {
    test('refuses when a journal holds rows that reference the wipe set, naming them', async () => {
        wireDb({ self_assessment_events: 630, nine_box_events: 152 });
        await expect(Snap.assertRestorable({})).rejects.toMatchObject({
            code: 'SNAPSHOT_RESTORE_PROTECTED_JOURNAL',
            blockers: expect.arrayContaining([
                expect.stringContaining(
                    'self_assessment_events.self_assessment_id -> self_assessment_rounds (630 rows)'
                ),
                expect.stringContaining(
                    'nine_box_events.evaluation_id -> nine_box_evaluations (152 rows)'
                ),
            ]),
        });
    });

    test('a journal without a trigger is protected exactly like one with it', async () => {
        wireDb({ nine_box_events: 1 });
        await expect(Snap.assertRestorable({})).rejects.toThrow(/nine_box_events/);
    });

    test('passes when the journals are empty (fresh base)', async () => {
        wireDb({});
        await expect(Snap.assertRestorable({})).resolves.toBeTruthy();
    });
});

describe('restoreSnapshot', () => {
    test('is refused BEFORE the pg_dump restore point and before any write', async () => {
        wireDb({ self_assessment_events: 630 });
        SnapshotModel.findById.mockResolvedValue({
            id: 7,
            snapshotData: { data: { employees: [] } },
        });
        await expect(Snap.restoreSnapshot(7, 1)).rejects.toThrow(/append-only journal/);
        expect(mockCreateRestorePoint).not.toHaveBeenCalled();
        expect(mockDb.runTransaction).not.toHaveBeenCalled();
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('_wipeForRestore never issues a DELETE on a journal', async () => {
        wireDb({});
        await Snap._wipeForRestore({});
        const deletes = mockDb.run.mock.calls
            .map((c) => String(c[0]))
            .filter((s) => /^DELETE FROM/.test(s));
        expect(deletes.length).toBeGreaterThan(0);
        for (const d of deletes) {
            expect(d).not.toMatch(
                /DELETE FROM (self_assessment_events|nine_box_events|system_logs|review_signatures|lifecycle_events|employee_movements)\b/
            );
        }
        expect(deletes).toContain('DELETE FROM pip_plans');
    });
});
