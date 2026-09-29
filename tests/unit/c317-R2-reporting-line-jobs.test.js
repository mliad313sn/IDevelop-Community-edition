'use strict';
/**
 * 3.23.18 — lane R2: the jobs route through ReportingLineService (mocked db).
 *  - reminders: a stalled PIP reaches the effective reviewer AND the manager
 *    (here an ADMIN manager), never through the old COALESCE column.
 *  - cert-expiry: the team alert follows the effective reviewer, admin included.
 *  - dispute L1 escalation: an admin-typed manager is reached.
 */
const mockDb = {
    all: jest.fn(async () => []),
    get: jest.fn(async () => null),
    run: jest.fn(async () => ({ changes: 0 })),
    runTransaction: jest.fn(async (fn) => fn()),
    runInSavepoint: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

const mockSettings = {
    getValue: jest.fn(async (k, d) => (k === 'reminderHour' ? 0 : d)),
    setValue: jest.fn(async () => undefined),
};
jest.mock('../../src/models/AppSettingsModel', () => mockSettings);

const mockN = {
    enqueue: jest.fn(async () => ({ state: 'queued' })),
    notify: jest.fn(async () => ({ inapp: 'queued' })),
    enqueueBulkInApp: jest.fn(async () => 0),
    KIND_META: {},
};
jest.mock('../../src/services/NotificationService', () => mockN);
jest.mock('../../src/services/LifecycleService', () => ({ processDue: jest.fn(async () => 0) }));
jest.mock('../../src/services/HandoverService', () => ({ listDue: jest.fn(async () => []) }));

const mockRL = {
    lineRecipientsMany: jest.fn(),
    effectiveReviewer: jest.fn(),
    managerOf: jest.fn(),
};
jest.mock('../../src/services/ReportingLineService', () => mockRL);

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.all.mockImplementation(async () => []);
    mockDb.get.mockImplementation(async () => null);
    mockSettings.getValue.mockImplementation(async (k, d) => (k === 'reminderHour' ? 0 : d));
    mockN.enqueue.mockImplementation(async () => ({ state: 'queued' }));
    mockN.notify.mockImplementation(async () => ({ inapp: 'queued' }));
});

test('reminders: a stalled PIP is announced to the reviewer AND the admin manager', async () => {
    mockDb.all.mockImplementation(async (sql) => {
        if (/FROM pips p/.test(sql)) return [{ empId: 7, stalled: 1, ending: 0 }];
        return [];
    });
    mockDb.get.mockImplementation(async (sql) =>
        /INSERT INTO reminder_log/.test(sql) ? { id: 1 } : null
    );
    mockRL.lineRecipientsMany.mockImplementation(async (ids, { includeManager }) => {
        const m = new Map();
        for (const id of ids)
            if (id === 7)
                m.set(7, [
                    { userType: 'employee', id: 11, role: 'reviewer' },
                    ...(includeManager ? [{ userType: 'admin', id: 3, role: 'manager' }] : []),
                ]);
        return m;
    });
    const out = await require('../../src/jobs/reminders').tick();
    expect(out.plans).toBe(2);
    const calls = mockN.enqueue.mock.calls.map(
        ([a]) => `${a.userType}:${a.userId}:${a.payload.count}`
    );
    expect(calls).toEqual(expect.arrayContaining(['employee:11:1', 'admin:3:1']));
    expect(mockRL.lineRecipientsMany).toHaveBeenCalledWith([7], { includeManager: true });
});

test('cert-expiry: the team alert goes to the effective reviewer, an admin included', async () => {
    mockSettings.getValue.mockImplementation(async () => null);
    mockDb.all.mockImplementation(async () => [
        {
            certId: 1,
            employeeId: 7,
            fullName: 'A B',
            skillId: 5,
            skillName: 'X',
            expiresOn: '2026-10-01',
            daysToExpiry: 80,
            alertStage: 0,
        },
    ]);
    mockRL.effectiveReviewer.mockResolvedValue({
        type: 'admin',
        id: 3,
        name: 'adm',
        via: 'manager',
    });
    const r = await require('../../src/jobs/cert-expiry').tick();
    expect(r.alerts).toBe(1);
    const team = mockN.notify.mock.calls.map(([a]) => a).find((a) => a.kind === 'cert.expiry.team');
    expect(team).toMatchObject({ userType: 'admin', userId: 3 });
});

test('cert-expiry: nobody live on the line → no team alert (never a departed account)', async () => {
    mockSettings.getValue.mockImplementation(async () => null);
    mockDb.all.mockImplementation(async () => [
        {
            certId: 1,
            employeeId: 7,
            fullName: 'A B',
            skillId: 5,
            skillName: 'X',
            expiresOn: '2026-10-01',
            daysToExpiry: 80,
            alertStage: 0,
        },
    ]);
    mockRL.effectiveReviewer.mockResolvedValue(null);
    await require('../../src/jobs/cert-expiry').tick();
    expect(mockN.notify.mock.calls.map(([a]) => a.kind)).toEqual(['cert.expiry']);
});

test('dispute L1: an admin-typed manager is the escalation recipient', async () => {
    mockRL.managerOf.mockResolvedValue({ type: 'admin', id: 3, name: 'adm' });
    const D = require('../../src/services/DisputeServiceV2');
    expect(await D._managerOf(7)).toEqual({ userType: 'admin', id: 3 });
    mockRL.managerOf.mockResolvedValue(null);
    expect(await D._managerOf(7)).toBeNull();
});
