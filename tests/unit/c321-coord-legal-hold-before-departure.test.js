'use strict';
/**
 * 3.23.21 (F11): a legal hold can be set on someone who has NOT left yet — there
 * is no retention job to stamp, so DSRService.setLegalHold falls back to the
 * employee-level hold (carried onto the job at departure). An erased or unknown
 * person still gets the 404.
 */
const mockDb = { get: jest.fn(), run: jest.fn(), all: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
const mockLifecycle = {
    setEmployeeLegalHold: jest.fn(async () => ({ ok: true, onEmployee: true })),
};
jest.mock('../../src/services/LifecycleService', () => mockLifecycle);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));

const DSR = require('../../src/services/DSRService');

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.run.mockResolvedValue({ changes: 0 }); // no open retention job
});

test('no retention job and a current employee → the hold goes on the employee', async () => {
    mockDb.get.mockResolvedValue({ id: 42, erasedAt: null });
    const out = await DSR.setLegalHold(42, {
        hold: true,
        reason: 'enquête accident',
        actorRef: 'admin:1',
    });
    expect(out).toEqual({ ok: true, onEmployee: true });
    expect(mockLifecycle.setEmployeeLegalHold).toHaveBeenCalledWith(42, {
        hold: true,
        reason: 'enquête accident',
        actorRef: 'admin:1',
    });
});

test('an erased or unknown person still gets 404 no_open_retention_job', async () => {
    for (const row of [{ id: 42, erasedAt: new Date() }, undefined]) {
        mockDb.get.mockResolvedValue(row);
        await expect(DSR.setLegalHold(42, { hold: true, reason: 'x' })).rejects.toMatchObject({
            status: 404,
            code: 'no_open_retention_job',
        });
    }
    expect(mockLifecycle.setEmployeeLegalHold).not.toHaveBeenCalled();
});

test('a reason is still mandatory', async () => {
    await expect(DSR.setLegalHold(42, { hold: true, reason: '  ' })).rejects.toMatchObject({
        code: 'reason_required',
    });
});
