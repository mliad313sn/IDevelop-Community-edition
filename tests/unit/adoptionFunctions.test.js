'use strict';
/**
 * The three functions added to unblock adoption:
 *   - QualifiedPeopleService — the "who can do this, here, today" lookup,
 *   - CoverageService.generateRules — bulk safe-shift rule generation,
 *   - the scaffolded workbook Assessment sheet (blank != error).
 *
 * DB mocked; the live-data behaviour is exercised separately.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const mockScopedEmployeeIds = jest.fn();
jest.mock('../../src/utils/rbacScope', () => ({
    scopedEmployeeIds: (...a) => mockScopedEmployeeIds(...a),
    scopeClause: () => ({ clause: '', params: [] }),
}));

const QP = require('../../src/services/QualifiedPeopleService');
const CoverageService = require('../../src/services/CoverageService');

const ADMIN = { id: 1, userType: 'admin', role: 'superadmin' };

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({});
    mockDb.runTransaction.mockReset().mockImplementation((fn) => fn());
    mockScopedEmployeeIds.mockReset().mockResolvedValue(null);
});

describe('QualifiedPeopleService.searchSkills', () => {
    test('refuses terms shorter than 2 characters without querying', async () => {
        await expect(QP.searchSkills('a')).resolves.toEqual([]);
        expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('does not put a quoted alias in ORDER BY (breaks the sql-compat layer)', async () => {
        await QP.searchSkills('welding');
        const sql = mockDb.all.mock.calls[0][0];
        const orderBy = sql.slice(sql.toUpperCase().lastIndexOf('ORDER BY'));
        expect(orderBy).not.toMatch(/"[a-zA-Z]+"/);
    });
});

describe('QualifiedPeopleService.find', () => {
    test('returns nothing without a skill', async () => {
        await expect(QP.find(ADMIN, {})).resolves.toEqual({ rows: [], skill: null });
    });

    test('a caller governing nobody gets an empty result and no query', async () => {
        mockScopedEmployeeIds.mockResolvedValue([]);
        await expect(QP.find(ADMIN, { skillId: 5 })).resolves.toEqual({ rows: [], skill: null });
        expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('clamps the requested level into the 0..4 scale', async () => {
        mockDb.get.mockResolvedValue({ id: 5, name: 'Welding' });
        await QP.find(ADMIN, { skillId: 5, minLevel: 99 });
        const params = mockDb.all.mock.calls[0][1];
        expect(params).toContain(4); // clamped, not 99
    });

    test.each([
        ['away', { awayOnDate: true, certStatus: 'valid', isLapsed: false }],
        ['cert_expired', { awayOnDate: false, certStatus: 'expired', isLapsed: false }],
        ['lapsed', { awayOnDate: false, certStatus: 'valid', isLapsed: true }],
        ['cert_expiring', { awayOnDate: false, certStatus: 'expiring', isLapsed: false }],
        ['available', { awayOnDate: false, certStatus: 'valid', isLapsed: false }],
    ])('derives readiness "%s"', async (expected, row) => {
        mockDb.get.mockResolvedValue({ id: 5, name: 'Welding' });
        mockDb.all.mockResolvedValue([{ employeeId: 1, level: 3, ...row }]);
        const out = await QP.find(ADMIN, { skillId: 5 });
        expect(out.rows[0].readiness).toBe(expected);
    });

    test('certifiedOnly keeps only currently valid certificates', async () => {
        mockDb.get.mockResolvedValue({ id: 5, name: 'Welding' });
        mockDb.all.mockResolvedValue([
            { employeeId: 1, level: 3, certStatus: 'valid' },
            { employeeId: 2, level: 4, certStatus: 'expired' },
            { employeeId: 3, level: 2, certStatus: null },
        ]);
        const out = await QP.find(ADMIN, { skillId: 5, certifiedOnly: true });
        expect(out.rows.map((r) => r.employeeId)).toEqual([1]);
    });
});

describe('CoverageService.generateRules', () => {
    const twoSkills = [
        { id: 10, name: 'Rigging' },
        { id: 11, name: 'Slinging' },
    ];

    test('refuses a spec with neither skills nor a domain', async () => {
        await expect(CoverageService.generateRules({ scope: 'site' }, 1, false)).rejects.toThrow(
            /at least one skill/
        );
    });

    test('preview plans without writing anything', async () => {
        mockDb.all
            .mockResolvedValueOnce(twoSkills) // skills
            .mockResolvedValueOnce([
                { id: 1, name: 'Site A' },
                { id: 2, name: 'Site B' },
            ]) // sites
            .mockResolvedValueOnce([
                { unitId: 1, n: 5 },
                { unitId: 2, n: 3 },
            ]) // staffed
            .mockResolvedValueOnce([]); // existing rules
        const out = await CoverageService.generateRules(
            { skillIds: [10, 11], scope: 'site', minLevel: 2, minHeadcount: 2 },
            1,
            false
        );
        expect(out.committed).toBe(false);
        expect(out.planned).toHaveLength(4); // 2 skills x 2 sites
        expect(out.created).toBe(0);
        expect(mockDb.get).not.toHaveBeenCalled(); // createRule never reached
    });

    test('skips units with no staff, so no permanent false breach is created', async () => {
        mockDb.all
            .mockResolvedValueOnce(twoSkills)
            .mockResolvedValueOnce([
                { id: 1, name: 'Staffed' },
                { id: 2, name: 'Empty' },
            ])
            .mockResolvedValueOnce([{ unitId: 1, n: 4 }]) // site 2 has nobody
            .mockResolvedValueOnce([]);
        const out = await CoverageService.generateRules(
            { skillIds: [10, 11], scope: 'site' },
            1,
            false
        );
        expect(out.planned).toHaveLength(2);
        expect(out.skipped).toBe(2);
        expect(out.planned.every((p) => p.siteId === 1)).toBe(true);
    });

    test('is idempotent — an identical existing rule is skipped', async () => {
        mockDb.all
            .mockResolvedValueOnce(twoSkills)
            .mockResolvedValueOnce([{ id: 1, name: 'Site A' }])
            .mockResolvedValueOnce([{ unitId: 1, n: 5 }])
            .mockResolvedValueOnce([{ s: 1, d: null, k: 10, l: 2 }]); // one already exists
        const out = await CoverageService.generateRules(
            { skillIds: [10, 11], scope: 'site', minLevel: 2 },
            1,
            false
        );
        expect(out.planned).toHaveLength(1);
        expect(out.planned[0].skillId).toBe(11);
        expect(out.skipped).toBe(1);
    });

    test('company scope produces exactly one rule per skill', async () => {
        mockDb.all.mockResolvedValueOnce(twoSkills).mockResolvedValueOnce([]); // existing
        const out = await CoverageService.generateRules(
            { skillIds: [10, 11], scope: 'company' },
            1,
            false
        );
        expect(out.planned).toHaveLength(2);
        expect(out.planned.every((p) => p.siteId === null && p.departmentId === null)).toBe(true);
    });
});
