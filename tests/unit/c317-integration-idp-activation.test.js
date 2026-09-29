'use strict';
/**
 * 3.23.18 R2 — who hears that an IDP went live.
 *
 * IDPService.signOff used to resolve the second recipient with
 *   COALESCE(supervisor_id, CASE WHEN manager_type = 'employee' THEN manager_id END)
 * so a supervisor who had LEFT was told (and nobody else), and an ADMIN
 * manager was never told. It now walks ReportingLineService.lineRecipients:
 * the ACTIVE effective reviewer + the manager (employee or admin) when
 * different. The raw employees.supervisor_id below still points at the
 * departed 96 — the old lookup reads it and notifies 96 (mutation check).
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
const mockNotify = jest.fn();
jest.mock('../../src/services/NotificationService', () => ({ notify: (...a) => mockNotify(...a) }));

const IDPService = require('../../src/services/IDPService');

const EMP = 89;
const DEPARTED_SUP = 96;

/** @param {object|null} line  the linesFor row for EMP (null → no line at all) */
function wire(line) {
    mockDb.get.mockImplementation(async (sql) => {
        if (/information_schema\.columns/i.test(sql)) return null;
        if (/FROM idp_plans WHERE id/i.test(sql))
            return { id: 6, employeeId: EMP, status: 'draft' };
        if (/UPDATE idp_plans SET status = 'active'/i.test(sql)) return { id: 6 };
        // The raw column the OLD lookup read: still the departed supervisor.
        if (/FROM employees WHERE id/i.test(sql)) return { sid: DEPARTED_SUP };
        return null;
    });
    mockDb.all.mockImplementation(async (sql) => {
        if (/FROM idp_signoffs/i.test(sql)) return [{ role: 'employee' }, { role: 'supervisor' }];
        if (/LEFT JOIN employees sup/.test(sql)) return line ? [line] : [];
        return [];
    });
}

const sign = () =>
    IDPService.signOff({ idpId: 6, role: 'supervisor', userId: 97, ip: '127.0.0.1', ua: 'ua' });
const told = () =>
    mockNotify.mock.calls
        .map(([a]) => a)
        .filter((a) => a.kind === 'idp.activated')
        .map((a) => `${a.userType}:${a.userId}`)
        .sort();

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset();
    mockDb.run.mockReset().mockResolvedValue({ changes: 1 });
    mockNotify.mockReset().mockResolvedValue(null);
    IDPService._resetSchemaCache();
});

describe('idp.activated reaches the LIVE line, never a departed supervisor', () => {
    test('departed supervisor + admin manager → the employee and the admin manager, not the leaver', async () => {
        // The SQL join drops the inactive supervisor: supId is NULL.
        wire({
            employeeId: EMP,
            employeeActive: true,
            supId: null,
            mgrAdmId: 5,
            mgrAdmName: 'adm',
        });
        await expect(sign()).resolves.toEqual({ activated: true });
        expect(told()).toEqual(['admin:5', `employee:${EMP}`]);
        expect(told()).not.toContain(`employee:${DEPARTED_SUP}`);
    });

    test('active supervisor + a different employee manager → both, plus the employee', async () => {
        wire({
            employeeId: EMP,
            employeeActive: true,
            supId: 96,
            supName: 'S',
            mgrEmpId: 97,
            mgrEmpName: 'M',
        });
        await sign();
        expect(told()).toEqual([`employee:${EMP}`, 'employee:96', 'employee:97']);
        const toSup = mockNotify.mock.calls.find(([a]) => a.userId === 96)[0];
        expect(toSup).toMatchObject({ category: 'talent', payload: { link: '/v2/idp' } });
    });

    test('nobody live on the line → only the employee is told', async () => {
        wire(null);
        await sign();
        expect(told()).toEqual([`employee:${EMP}`]);
    });

    test('a failing line lookup never blocks the sign-off', async () => {
        wire(null);
        mockDb.all.mockImplementation(async (sql) => {
            if (/FROM idp_signoffs/i.test(sql))
                return [{ role: 'employee' }, { role: 'supervisor' }];
            throw new Error('db down');
        });
        await expect(sign()).resolves.toEqual({ activated: true });
        expect(told()).toEqual([`employee:${EMP}`]);
    });
});
