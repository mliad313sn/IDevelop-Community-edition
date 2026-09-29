'use strict';
/**
 * 3.23.18 lane P-privacy — S-07 retention purge, erasure tombstones, reporting
 * cycles after a snapshot restore. Mocked database: the behaviour under test is
 * which statements run, in which order, and what is skipped.
 */
const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(),
    runInSavepoint: jest.fn(),
};
jest.mock('../../src/config/database', () => mockDb);
const mockLog = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/LogService', () => ({ log: mockLog }));
const mockSettings = { getValue: jest.fn(), setValue: jest.fn().mockResolvedValue(undefined) };
jest.mock('../../src/models/AppSettingsModel', () => mockSettings);
jest.mock('../../src/services/SessionService', () => ({
    revokeAllForUser: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/ApiKeyService', () => ({
    revokeByOwner: jest.fn().mockResolvedValue(undefined),
}));
const mockDeprovision = jest.fn().mockResolvedValue({});
jest.mock('../../src/services/LifecycleService', () => ({ deprovision: mockDeprovision }));
jest.mock('../../src/models/SnapshotModel', () => ({ findById: jest.fn(), create: jest.fn() }));
jest.mock('../../src/services/SqlConsoleService', () => ({
    createRestorePoint: jest.fn().mockResolvedValue({ name: 'rp', sizeBytes: 1 }),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const DSR = require('../../src/services/DSRService');

const runs = () => mockDb.run.mock.calls.map((c) => String(c[0]));
const ledgerActions = () =>
    mockDb.run.mock.calls
        .filter((c) => /INSERT INTO retention_ledger/.test(c[0]))
        .map((c) => c[1][4]);

function dueRow(over = {}) {
    return {
        employeeId: 501,
        countryCode: 'SN',
        dueAt: '2026-01-01T00:00:00Z',
        legalHoldAt: null,
        empId: 501,
        isActive: false,
        erasedAt: null,
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ERASURE_TOMBSTONE_FILE;
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.runInSavepoint.mockImplementation(async (fn) => fn());
    mockDb.run.mockResolvedValue({ changes: 1 });
    mockDb.get.mockResolvedValue(undefined);
    mockDb.all.mockResolvedValue([]);
    mockSettings.getValue.mockResolvedValue('report');
});

describe('retention mode — fail closed', () => {
    test.each([
        ['apply', 'apply'],
        ['report', 'report'],
        ['APPLY', 'report'],
        ['', 'report'],
        [null, 'report'],
        ['yes', 'report'],
    ])('setting %p → %p', async (stored, expected) => {
        mockSettings.getValue.mockResolvedValue(stored);
        expect(await DSR.retentionMode()).toBe(expected);
    });
    test('unreadable setting → report', async () => {
        mockSettings.getValue.mockRejectedValue(new Error('down'));
        expect(await DSR.retentionMode()).toBe('report');
    });
});

describe('runRetention', () => {
    test('REPORT mode lists what it would erase and writes nothing else', async () => {
        mockDb.all.mockResolvedValueOnce([dueRow(), dueRow({ employeeId: 502, empId: 502 })]);
        const eraseSpy = jest.spyOn(DSR, 'erase');
        const r = await DSR.runRetention({ mode: 'report' });
        expect(r.mode).toBe('report');
        expect(r.counts).toEqual({ would_erase: 2 });
        expect(eraseSpy).not.toHaveBeenCalled();
        expect(ledgerActions()).toEqual(['would_erase', 'would_erase']);
        // No claim, no job completion, no pseudonymisation.
        expect(runs().some((s) => /UPDATE pii_cleanup_jobs|UPDATE employees/.test(s))).toBe(false);
    });

    test('the configured mode is used when none is passed (default report)', async () => {
        mockDb.all.mockResolvedValueOnce([dueRow()]);
        const eraseSpy = jest.spyOn(DSR, 'erase');
        const r = await DSR.runRetention();
        expect(r.mode).toBe('report');
        expect(eraseSpy).not.toHaveBeenCalled();
    });

    test('APPLY mode claims the job row, then erases through erase() with method retention_purge', async () => {
        mockDb.all.mockResolvedValueOnce([dueRow()]);
        const eraseSpy = jest.spyOn(DSR, 'erase').mockResolvedValue({ erased: true });
        const r = await DSR.runRetention({ mode: 'apply' });
        expect(r.counts).toEqual({ erased: 1 });
        const claimIdx = runs().findIndex((s) => /SET claimed_at = now\(\)/.test(s));
        expect(claimIdx).toBeGreaterThanOrEqual(0);
        expect(runs()[claimIdx]).toMatch(/legal_hold_at IS NULL/);
        expect(eraseSpy).toHaveBeenCalledWith(
            501,
            null,
            expect.objectContaining({ method: 'retention_purge' })
        );
        expect(ledgerActions()).toEqual(['erased']);
        expect(mockLog).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'RETENTION_PURGE', entityId: 501 })
        );
    });

    test('a lost claim (another worker holds the row) never erases', async () => {
        mockDb.all.mockResolvedValueOnce([dueRow()]);
        mockDb.run.mockImplementation(async (sql) =>
            /SET claimed_at = now\(\)/.test(sql) ? { changes: 0 } : { changes: 1 }
        );
        const eraseSpy = jest.spyOn(DSR, 'erase');
        const r = await DSR.runRetention({ mode: 'apply' });
        expect(eraseSpy).not.toHaveBeenCalled();
        expect(r.counts).toEqual({ skipped_claimed: 1 });
    });

    test('legal hold, rehired (active) and missing subjects are skipped even in apply mode', async () => {
        mockDb.all.mockResolvedValueOnce([
            dueRow({ legalHoldAt: '2026-05-01' }),
            dueRow({ employeeId: 502, empId: 502, isActive: true }),
            dueRow({ employeeId: 503, empId: null }),
        ]);
        const eraseSpy = jest.spyOn(DSR, 'erase');
        const r = await DSR.runRetention({ mode: 'apply' });
        expect(eraseSpy).not.toHaveBeenCalled();
        expect(r.counts).toEqual({ skipped_legal_hold: 1, skipped_active: 1, skipped_missing: 1 });
        expect(runs().some((s) => /SET claimed_at = now\(\)/.test(s))).toBe(false);
    });

    test('a failed erasure releases the claim and is recorded as failed', async () => {
        mockDb.all.mockResolvedValueOnce([dueRow()]);
        jest.spyOn(DSR, 'erase').mockRejectedValue(new Error('boom'));
        const r = await DSR.runRetention({ mode: 'apply' });
        expect(r.counts).toEqual({ failed: 1 });
        expect(runs().some((s) => /SET claimed_at = NULL/.test(s))).toBe(true);
    });

    test('already erased subject: the job is closed (apply) and not erased twice', async () => {
        mockDb.all.mockResolvedValueOnce([dueRow({ erasedAt: '2026-02-01' })]);
        const eraseSpy = jest.spyOn(DSR, 'erase');
        const r = await DSR.runRetention({ mode: 'apply' });
        expect(eraseSpy).not.toHaveBeenCalled();
        expect(r.counts).toEqual({ already_erased: 1 });
        expect(runs().some((s) => /already erased/.test(s))).toBe(true);
    });
});

describe('the retention-purge tick', () => {
    const job = require('../../src/jobs/retention-purge');
    test('runs once a day; a forced run bypasses the gate', async () => {
        const now = new Date('2026-09-26T10:00:00Z');
        mockSettings.getValue.mockImplementation(async (k) =>
            k === 'retentionPurgeLastRunOn' ? '2026-09-26' : 'report'
        );
        const spy = jest
            .spyOn(DSR, 'runRetention')
            .mockResolvedValue({ runId: 'x', mode: 'report', due: 0, counts: {} });
        expect(await job.tick({ now })).toEqual({ done: false, skipped: 'already_today' });
        expect(spy).not.toHaveBeenCalled();
        const r = await job.tick({ now, force: true });
        expect(r.done).toBe(true);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(mockSettings.setValue).toHaveBeenCalledWith(
            'retentionPurgeLastRunOn',
            '2026-09-26',
            'string',
            expect.any(String),
            'jobs'
        );
    });
});

describe('erasure tombstones', () => {
    function wireErase(emp) {
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM employees WHERE id = \?/.test(sql)) return emp;
            return undefined;
        });
        mockDb.all.mockResolvedValue([]);
    }

    test('erase() writes a tombstone row inside the transaction, and the mirror file', async () => {
        const file = path.join(os.tmpdir(), `c317-tomb-${process.pid}-${Date.now()}.jsonl`);
        process.env.ERASURE_TOMBSTONE_FILE = file;
        wireErase({ id: 77, isActive: false, email: 'a@b.c', employeeNumber: 'E77' });
        await DSR.erase(77, 1, { reason: 'asked' });
        const ins = mockDb.run.mock.calls.find((c) => /INSERT INTO erasure_tombstones/.test(c[0]));
        expect(ins).toBeTruthy();
        expect(ins[1].slice(0, 3)).toEqual(['employee', 77, 'dsr_erase']);
        const lines = DSR.readTombstoneFile(file);
        expect(lines).toEqual([
            expect.objectContaining({
                subjectType: 'employee',
                subjectId: 77,
                method: 'dsr_erase',
            }),
        ]);
        fs.unlinkSync(file);
    });

    test('a re-application never runs the leaver cascade and is audited as such', async () => {
        wireErase({ id: 78, isActive: true, email: 'x@y.z', employeeNumber: 'E78' });
        await DSR.erase(78, null, { reapply: true, method: 'retention_purge' });
        expect(mockDeprovision).not.toHaveBeenCalled();
        expect(mockLog).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'GDPR_ERASURE_REAPPLIED' })
        );
        // the subject is switched off all the same
        expect(runs().some((s) => /is_active = false, is_account_active = false/.test(s))).toBe(
            true
        );
    });

    test('reapplyTombstones erases again every tombstoned subject whose row came back', async () => {
        const file = path.join(os.tmpdir(), `c317-tomb2-${process.pid}-${Date.now()}.jsonl`);
        fs.writeFileSync(
            file,
            JSON.stringify({
                subjectType: 'employee',
                subjectId: 90,
                erasedAt: '2026-03-01T00:00:00Z',
                method: 'dsr_erase',
            }) + '\nnot json\n'
        );
        mockDb.get.mockResolvedValue({ n: 2 });
        mockDb.all.mockResolvedValue([
            { subjectId: 90, method: 'dsr_erase' },
            { subjectId: 91, method: 'retention_purge' },
        ]);
        const eraseSpy = jest.spyOn(DSR, 'erase').mockImplementation(async (id) => {
            if (id === 91) throw new Error('nope');
            return { erased: true };
        });
        const r = await DSR.reapplyTombstones({ source: 'test', file });
        expect(eraseSpy).toHaveBeenCalledWith(
            90,
            null,
            expect.objectContaining({ reapply: true, method: 'dsr_erase' })
        );
        expect(r.reapplied).toEqual([90]);
        expect(r.failed).toEqual([{ id: 91, error: 'nope' }]);
        // the mirror line went back into the table
        expect(
            mockDb.run.mock.calls.some(
                (c) => /INSERT INTO erasure_tombstones/.test(c[0]) && c[1][1] === 90
            )
        ).toBe(true);
        fs.unlinkSync(file);
    });
});

describe('snapshot restore', () => {
    const SnapshotModel = require('../../src/models/SnapshotModel');
    const Snap = require('../../src/services/SnapshotService');

    function wireRestore() {
        SnapshotModel.findById.mockResolvedValue({ snapshotData: { data: { employees: [] } } });
        jest.spyOn(Snap, 'assertRestorable').mockResolvedValue(undefined);
        jest.spyOn(Snap, '_wipeForRestore').mockResolvedValue(undefined);
        jest.spyOn(Snap, '_restoreRows').mockResolvedValue(undefined);
        jest.spyOn(Snap, '_resyncSequences').mockResolvedValue(undefined);
    }

    test('re-applies the tombstones and reports reporting loops in the summary', async () => {
        wireRestore();
        const re = jest
            .spyOn(DSR, 'reapplyTombstones')
            .mockResolvedValue({ tombstones: 3, reapplied: [7], failed: [], mergedFromFile: 0 });
        mockDb.all.mockImplementation(async (sql) =>
            /WITH RECURSIVE edges/.test(sql)
                ? [
                      { startId: 40, path: ['40', '12', '40'] },
                      { startId: 12, path: ['12', '40', '12'] },
                  ]
                : []
        );
        const r = await Snap.restoreSnapshot(5, 1);
        expect(re).toHaveBeenCalled();
        expect(r.erasuresReapplied).toEqual([7]);
        expect(r.reportingCycles).toEqual([[12, 40, 12]]);
        expect(mockLog).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'SNAPSHOT_RESTORE_REPORTING_CYCLES' })
        );
    });

    test('an erasure that cannot be re-applied aborts the restore (fail closed)', async () => {
        wireRestore();
        jest.spyOn(DSR, 'reapplyTombstones').mockResolvedValue({
            tombstones: 1,
            reapplied: [],
            failed: [{ id: 9, error: 'x' }],
            mergedFromFile: 0,
        });
        await expect(Snap.restoreSnapshot(5, 1)).rejects.toThrow(/could not be erased again/);
    });

    test('a failed cycle query is NOT MEASURED (null), never "no loop"', async () => {
        mockDb.all.mockRejectedValue(new Error('down'));
        expect(await Snap.findReportingCycles()).toBeNull();
    });
});
