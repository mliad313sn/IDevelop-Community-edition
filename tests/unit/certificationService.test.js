'use strict';
/**
 * CertificationService (migration 56) — policy coercion, expiry derivation
 * from the per-skill policy, status-count mapping, and the bulk-import
 * validator's row rules (unknown employee/skill, date shape, duplicate skip,
 * preview-vs-commit). DB mocked; the import test builds a real .xlsx in tmp
 * via exceljs (a production dependency) so the parse path is exercised too.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const path = require('path');
const fs = require('fs');
const CertificationService = require('../../src/services/CertificationService');

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset();
    mockDb.run.mockReset();
});

describe('setPolicy', () => {
    test('coerces numerics, defaults the revalidation window, upserts', async () => {
        mockDb.get.mockResolvedValue({ skillId: 5 });
        await CertificationService.setPolicy(
            5,
            { validityMonths: '24', revalidationWindowDays: '', decayMonths: null },
            9
        );
        const [sql, params] = mockDb.get.mock.calls[0];
        expect(sql).toMatch(/ON CONFLICT \(skill_id\) DO UPDATE/);
        expect(params).toEqual([5, true, 24, 90, null, 9]); // '' → null window → default 90
    });
});

describe('record', () => {
    test('derives expires_on from the policy validity when not supplied', async () => {
        mockDb.get
            .mockResolvedValueOnce({ validityMonths: 12 }) // policy lookup
            .mockResolvedValueOnce({ id: 77 }) // INSERT … RETURNING
            .mockResolvedValueOnce({ id: 77, expiresOn: '2027-03-01' }); // reload
        await CertificationService.record(
            { employeeId: 1, skillId: 5, issuedOn: '2026-03-01' },
            { userType: 'admin', id: 9 }
        );
        const insertParams = mockDb.get.mock.calls[1][1];
        expect(insertParams[4]).toBe('2027-03-01'); // issued 2026-03-01 + 12 months
    });

    test('requires employeeId, skillId and issuedOn', async () => {
        await expect(CertificationService.record({ skillId: 1 }, null)).rejects.toThrow(/required/);
    });
});

describe('statusCounts', () => {
    test('maps rows onto the fixed status keys with zero defaults', async () => {
        mockDb.all.mockResolvedValue([
            { status: 'expiring', n: 2 },
            { status: 'expired', n: 1 },
        ]);
        const counts = await CertificationService.statusCounts(null);
        expect(counts).toEqual({ valid: 0, expiring: 2, expired: 1, no_expiry: 0 });
    });
});

describe('importWorkbook (preview-before-commit)', () => {
    const tmpFile = path.join(__dirname, '..', '..', 'tmp', `cert-import-test-${process.pid}.xlsx`);

    afterEach(() => {
        try {
            fs.unlinkSync(tmpFile);
        } catch (_) {
            /* already gone */
        }
    });

    async function buildWorkbook(rows) {
        const ExcelJS = require('exceljs');
        const wb = new ExcelJS.Workbook();
        const sheet = wb.addWorksheet('Certifications');
        sheet.addRow([
            'Employee Number',
            'Skill Name',
            'Cert Number',
            'Issued On',
            'Expires On',
            'Notes',
        ]);
        for (const r of rows) sheet.addRow(r);
        fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
        await wb.xlsx.writeFile(tmpFile);
    }

    // 15s timeouts: these tests write and parse a REAL .xlsx via exceljs,
    // which can exceed Jest's 5s default on a loaded machine.
    test('validates rows, resolves references, skips duplicates — dry-run writes NOTHING', async () => {
        await buildWorkbook([
            ['EMP001', 'First Aid', 'FA-1', '2026-01-01', '2028-01-01', 'ok row'],
            ['NOPE', 'First Aid', '', '2026-01-01', '', 'unknown employee'],
            ['EMP001', 'Ghost Skill', '', '2026-01-01', '', 'unknown skill'],
            ['EMP001', 'First Aid', '', 'not-a-date', '', 'bad date'],
            ['EMP002', 'First Aid', '', '2026-01-01', '', 'duplicate'],
        ]);
        mockDb.get.mockImplementation(async (sql, params) => {
            if (/FROM employees/.test(sql)) {
                return String(params[0]).toUpperCase() === 'NOPE'
                    ? null
                    : { id: params[0] === 'EMP002' ? 2 : 1 };
            }
            if (/FROM skills/.test(sql)) {
                return /ghost/i.test(params[0]) ? null : { id: 50 };
            }
            if (/FROM employee_certifications/.test(sql)) {
                return Number(params[0]) === 2 ? { id: 999 } : null; // EMP002's row already exists
            }
            return null;
        });

        const r = await CertificationService.importWorkbook(tmpFile, { dryRun: true });
        expect(r.total).toBe(5);
        expect(r.valid).toBe(1); // only the first row survives
        expect(r.skipped).toBe(1); // the duplicate
        expect(r.errors).toHaveLength(3);
        expect(r.created).toBe(0); // DRY-RUN: nothing recorded
        expect(mockDb.run).not.toHaveBeenCalled();
    }, 15000);

    test('commit records exactly the valid rows (idempotent re-import → all skipped)', async () => {
        await buildWorkbook([['EMP001', 'First Aid', 'FA-1', '2026-01-01', '2028-01-01', '']]);
        let dupExists = false;
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM employees/.test(sql)) return { id: 1 };
            if (/FROM skills/.test(sql)) return { id: 50 };
            if (/FROM employee_certifications/.test(sql) && /issued_on/.test(sql))
                return dupExists ? { id: 1 } : null;
            if (/skill_certification_policies/.test(sql)) return null; // no policy
            if (/INSERT INTO employee_certifications/.test(sql)) return { id: 123 };
            return { id: 123 };
        });

        const first = await CertificationService.importWorkbook(tmpFile, {
            dryRun: false,
            actor: { userType: 'admin', id: 9 },
        });
        expect(first.created).toBe(1);

        dupExists = true; // simulate the row now existing
        const second = await CertificationService.importWorkbook(tmpFile, { dryRun: false });
        expect(second.created).toBe(0);
        expect(second.skipped).toBe(1);
    }, 15000);
});
