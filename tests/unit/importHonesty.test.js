'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC E1 (324) and E2 (288) — an import that REPORTS SUCCESS WHILE LYING.
 *
 * E1  The full-system JSON import answered `{ success: true, skills: 0 }` while
 *     silently discarding every edited attribute of a domain, sub-domain, skill,
 *     role family, role, site, department or service. Reproduced by execution on
 *     idevelop (export -> mutate 9 attributes -> import -> read back, all inside a
 *     rolled-back transaction): 8 of 9 edits LOST, the 9th matching only by
 *     coincidence, and the summary reporting 0 everywhere. After the fix: 9 of 9
 *     persisted and the summary names one correction per entity.
 *
 * E2  The workbook import OVERWROTE 2 714 assessments, 1 932 requirements and 79
 *     employees while reporting `created: 0, skipped: N` — an operator could not
 *     tell "did nothing" from "rewrote everything". Measured with xmin (the
 *     physical row version) before and after: 2 714 / 2 714 and 1 932 / 1 932 rows
 *     rewritten under the word "skipped". After the fix the counters name what
 *     happened — created / updated / unchanged / skipped-with-reason — and an
 *     identical row is left untouched (0 / 2 714 rewritten).
 *
 * The export side is NOT touched: blank scaffold rows keep `currentLevel: ""`,
 * `gap: ""` and are reported as `notRated`, which the import now carries into its
 * own summary instead of dropping it.
 *
 * DB mocked here; the live-data behaviour is exercised by the rolled-back probes.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/utils/ttlCache', () => ({ dashboardCache: { bust: jest.fn() } }));
jest.mock('../../src/utils/importSkillResolver', () => ({
    resolveActiveSkillByName: jest.fn(),
    isRetiredOnly: jest.fn(async () => false),
}));

const resolver = require('../../src/utils/importSkillResolver');
const workbook = require('../../src/services/SkillMatrixWorkbookService');
const unified = require('../../src/services/UnifiedJsonService');

/** Route db.get by SQL fragment; anything unmatched returns undefined. */
function router(routes) {
    return async (sql) => {
        for (const [fragment, value] of routes) {
            if (sql.includes(fragment)) return typeof value === 'function' ? value() : value;
        }
        return undefined;
    };
}
const writes = () => mockDb.run.mock.calls.map((c) => c[0].replace(/\s+/g, ' ').trim());
const section = () => ({ created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] });

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({});
    mockDb.runTransaction.mockReset().mockImplementation(async (fn) => fn());
    resolver.resolveActiveSkillByName.mockReset();
    resolver.isRetiredOnly.mockReset().mockResolvedValue(false);
});

// ---------------------------------------------------------------------------
// E2 — the workbook import must name what it did
// ---------------------------------------------------------------------------

describe('E2 — a rewritten requirement is reported as rewritten, not as skipped', () => {
    const req = (level, critical) => ({
        requirements: [
            {
                roleName: 'Driller',
                skillName: 'Blasting',
                domainName: 'HSE',
                requiredLevel: level,
                isCritical: critical,
            },
        ],
    });

    test('a DIFFERENT required level is written and counted `updated`', async () => {
        mockDb.get.mockImplementation(
            router([
                ['FROM roles WHERE name', { id: 3 }],
                ['FROM roleSkillRequirements', { id: 99, requiredLevel: 2, isCritical: false }],
            ])
        );
        resolver.resolveActiveSkillByName.mockResolvedValue({ id: 7 });
        const results = { requirements: section() };

        await workbook._importRequirements(req(4, false), results);

        expect(writes().some((s) => s.startsWith('UPDATE roleSkillRequirements'))).toBe(true);
        expect(results.requirements).toMatchObject({
            created: 0,
            updated: 1,
            unchanged: 0,
            skipped: 0,
        });
    });

    test('an IDENTICAL row is not written at all and is counted `unchanged`', async () => {
        mockDb.get.mockImplementation(
            router([
                ['FROM roles WHERE name', { id: 3 }],
                ['FROM roleSkillRequirements', { id: 99, requiredLevel: 4, isCritical: true }],
            ])
        );
        resolver.resolveActiveSkillByName.mockResolvedValue({ id: 7 });
        const results = { requirements: section() };

        await workbook._importRequirements(req(4, true), results);

        expect(mockDb.run).not.toHaveBeenCalled();
        expect(results.requirements).toMatchObject({
            created: 0,
            updated: 0,
            unchanged: 1,
            skipped: 0,
        });
    });

    test('a row that was NOT applied is counted `skipped` and carries its reason', async () => {
        mockDb.get.mockImplementation(router([['FROM roles WHERE name', undefined]]));
        const results = { requirements: section() };

        await workbook._importRequirements(req(4, false), results);

        expect(results.requirements.skipped).toBe(1);
        expect(
            results.requirements.updated +
                results.requirements.unchanged +
                results.requirements.created
        ).toBe(0);
        expect(results.requirements.errors.join(' ')).toMatch(/role "Driller" not found/);
    });
});

describe('E2 — a rewritten assessment is reported as rewritten, not as skipped', () => {
    const AT = '2026-05-04T10:00:00.000Z';
    const one = (level) => ({
        assessments: [
            {
                employeeNumber: 'EMP-1',
                skillName: 'Blasting',
                domainName: 'HSE',
                currentLevel: level,
                assessedAt: AT,
            },
        ],
    });

    test('a DIFFERENT level is written and counted `updated`', async () => {
        mockDb.get.mockImplementation(
            router([
                ['FROM employees WHERE employeeNumber', { id: 11 }],
                [
                    'FROM skillAssessments',
                    { id: 55, currentLevel: 1, assessedBy: 4, assessedAt: AT },
                ],
            ])
        );
        resolver.resolveActiveSkillByName.mockResolvedValue({ id: 7 });
        const results = { assessments: section() };

        await workbook._importAssessments(one(3), results, 4);

        expect(writes().some((s) => s.startsWith('UPDATE skillAssessments'))).toBe(true);
        expect(results.assessments).toMatchObject({
            created: 0,
            updated: 1,
            unchanged: 0,
            skipped: 0,
        });
    });

    test('an IDENTICAL level, assessor AND date write nothing and count `unchanged`', async () => {
        mockDb.get.mockImplementation(
            router([
                ['FROM employees WHERE employeeNumber', { id: 11 }],
                [
                    'FROM skillAssessments',
                    { id: 55, currentLevel: 3, assessedBy: 4, assessedAt: AT },
                ],
            ])
        );
        resolver.resolveActiveSkillByName.mockResolvedValue({ id: 7 });
        const results = { assessments: section() };

        await workbook._importAssessments(one(3), results, 4);

        expect(mockDb.run).not.toHaveBeenCalled();
        expect(results.assessments).toMatchObject({
            created: 0,
            updated: 0,
            unchanged: 1,
            skipped: 0,
        });
    });

    test("re-attributing somebody else's assessment to the importer is an UPDATE, never `unchanged`", async () => {
        // Same level, same date, DIFFERENT assessor: the row IS rewritten, so
        // claiming "unchanged" would hide a write to the audit trail.
        mockDb.get.mockImplementation(
            router([
                ['FROM employees WHERE employeeNumber', { id: 11 }],
                [
                    'FROM skillAssessments',
                    { id: 55, currentLevel: 3, assessedBy: 9, assessedAt: AT },
                ],
            ])
        );
        resolver.resolveActiveSkillByName.mockResolvedValue({ id: 7 });
        const results = { assessments: section() };

        await workbook._importAssessments(one(3), results, 4);

        expect(results.assessments).toMatchObject({ updated: 1, unchanged: 0 });
    });
});

describe('E2 — an existing employee is reported honestly', () => {
    const stored = {
        id: 11,
        firstName: 'Ama',
        lastName: 'Moren',
        siteId: 1,
        departmentId: 2,
        serviceId: 3,
        roleId: 4,
    };
    const file = (over = {}) => ({
        employees: [
            {
                employeeNumber: 'EMP-1',
                fullName: 'Ama Moren',
                firstName: 'Ama',
                lastName: 'Moren',
                site: 'Riverside',
                department: 'IT',
                service: 'Ops',
                roleName: 'Driller',
                managerName: '',
                supervisorName: '',
                ...over,
            },
        ],
    });
    const org = [
        ['FROM sites WHERE name', { id: 1 }],
        ['FROM departments WHERE name', { id: 2 }],
        ['FROM services WHERE name', { id: 3 }],
        ['FROM roles WHERE name', { id: 4 }],
        ['FROM employees WHERE employeeNumber', stored],
    ];

    test('an unchanged person is not rewritten and is counted `unchanged`', async () => {
        mockDb.get.mockImplementation(router(org));
        const results = {
            employees: section(),
            sites: section(),
            departments: section(),
            services: section(),
        };

        await workbook._importEmployees(file(), results);

        expect(writes().some((s) => s.startsWith('UPDATE employees'))).toBe(false);
        expect(results.employees).toMatchObject({
            created: 0,
            updated: 0,
            unchanged: 1,
            skipped: 0,
        });
    });

    test('a changed placement is written and counted `updated`', async () => {
        mockDb.get.mockImplementation(
            router([
                ...org.slice(0, 4),
                ['FROM employees WHERE employeeNumber', { ...stored, roleId: 99 }],
            ])
        );
        const results = {
            employees: section(),
            sites: section(),
            departments: section(),
            services: section(),
        };

        await workbook._importEmployees(file(), results);

        expect(writes().some((s) => s.startsWith('UPDATE employees'))).toBe(true);
        expect(results.employees).toMatchObject({
            created: 0,
            updated: 1,
            unchanged: 0,
            skipped: 0,
        });
    });

    test('a hierarchy link written by the second pass upgrades the person to `updated`', async () => {
        // The link pass used to rewrite EVERY employee unconditionally, so a
        // summary claiming "unchanged" would have been false for 79 of 80 people.
        mockDb.get.mockImplementation(router(org));
        mockDb.all.mockResolvedValue([{ id: 12, firstName: 'Yao', lastName: 'Bini' }]);
        const results = {
            employees: section(),
            sites: section(),
            departments: section(),
            services: section(),
            warnings: [],
        };
        const ctx = { empOutcome: new Map() };

        await workbook._importEmployees(file(), results, ctx);
        expect(results.employees).toMatchObject({ updated: 0, unchanged: 1 });

        await workbook._linkHierarchy(file({ supervisorName: 'Yao Bini' }), results, ctx);

        expect(writes().some((s) => s.startsWith('UPDATE employees SET manager_id'))).toBe(true);
        expect(results.employees).toMatchObject({ updated: 1, unchanged: 0 });
    });

    test('an already-correct hierarchy link writes nothing', async () => {
        mockDb.get.mockImplementation(
            router([
                ...org.slice(0, 4),
                [
                    'FROM employees WHERE employeeNumber',
                    { ...stored, managerId: null, managerType: null, supervisorId: 12 },
                ],
            ])
        );
        mockDb.all.mockResolvedValue([{ id: 12, firstName: 'Yao', lastName: 'Bini' }]);
        const results = { employees: section(), warnings: [] };

        await workbook._linkHierarchy(file({ supervisorName: 'Yao Bini' }), results, {
            empOutcome: new Map(),
        });

        expect(mockDb.run).not.toHaveBeenCalled();
    });
});

describe('E2 — the import summary shape', () => {
    test('every section names created/updated/unchanged/skipped, and the not-rated are reported', async () => {
        jest.spyOn(workbook, 'parse').mockResolvedValue({
            domains: [{ name: 'HSE' }],
            skills: [],
            roles: [],
            requirements: [],
            employees: [],
            assessments: [
                {
                    employeeNumber: 'EMP-1',
                    skillName: 'Blasting',
                    domainName: 'HSE',
                    currentLevel: 2,
                    assessedAt: null,
                },
            ],
            errors: [],
            // Blank scaffold rows: the not-yet-measured, which the export reports
            // and the import used to drop on the floor.
            notRated: 896,
        });
        mockDb.get.mockImplementation(
            router([
                ['FROM domains WHERE name', { id: 1 }],
                ['FROM employees WHERE employeeNumber', { id: 11 }],
                [
                    'FROM skillAssessments',
                    { id: 55, currentLevel: 0, assessedBy: 4, assessedAt: null },
                ],
                ['FROM admins', { id: 4 }],
            ])
        );
        resolver.resolveActiveSkillByName.mockResolvedValue({ id: 7 });

        const { results } = await workbook.import('matrix.json', 4, 'json');

        for (const name of [
            'domains',
            'skills',
            'roles',
            'requirements',
            'employees',
            'assessments',
        ]) {
            expect(results[name]).toEqual(
                expect.objectContaining({
                    created: expect.any(Number),
                    updated: expect.any(Number),
                    unchanged: expect.any(Number),
                    skipped: expect.any(Number),
                })
            );
        }
        // The overwrite is named as an overwrite.
        expect(results.assessments.updated).toBe(1);
        expect(results.assessments.skipped).toBe(0);
        // The unmeasured is carried, never presented as a level 0.
        expect(results.assessments.notRated).toBe(896);
        workbook.parse.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// E1 — the JSON import must apply, and report, the edits it is given
// ---------------------------------------------------------------------------

describe('E1 — an edited framework attribute survives the round trip', () => {
    const runImport = (data) => unified.importSystemFromJson(data, null);

    test('a corrected domain description is written and reported', async () => {
        mockDb.get.mockImplementation(
            router([['FROM domains WHERE name', { id: 10, description: 'Legacy Pillar' }]])
        );

        const { results } = await runImport({
            framework: { domains: [{ name: 'HSE', description: 'CORRECTED', skills: [] }] },
        });

        expect(mockDb.run).toHaveBeenCalledWith('UPDATE domains SET description = ? WHERE id = ?', [
            'CORRECTED',
            10,
        ]);
        expect(results.domainsUpdated).toBe(1);
        expect(results.domains).toBe(0); // nothing was CREATED, and it does not pretend otherwise
    });

    test('an unchanged domain is not rewritten', async () => {
        mockDb.get.mockImplementation(
            router([['FROM domains WHERE name', { id: 10, description: 'Legacy Pillar' }]])
        );

        const { results } = await runImport({
            framework: { domains: [{ name: 'HSE', description: 'Legacy Pillar', skills: [] }] },
        });

        expect(mockDb.run).not.toHaveBeenCalled();
        expect(results.domainsUpdated).toBe(0);
    });

    test('a file that does not carry the key leaves the stored value alone', async () => {
        mockDb.get.mockImplementation(
            router([['FROM domains WHERE name', { id: 10, description: 'Legacy Pillar' }]])
        );

        await runImport({ framework: { domains: [{ name: 'HSE', skills: [] }] } });

        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('corrected skill attributes are written and reported', async () => {
        mockDb.get.mockImplementation(
            router([
                ['FROM domains WHERE name', { id: 10, description: null }],
                [
                    'FROM skills WHERE',
                    {
                        id: 20,
                        subDomainId: null,
                        category: 'Technical',
                        description: 'old',
                        strategicLink: null,
                    },
                ],
            ])
        );

        const { results } = await runImport({
            framework: {
                domains: [
                    {
                        name: 'HSE',
                        skills: [
                            {
                                name: 'Blasting',
                                category: 'Safety',
                                description: 'new',
                                strategicLink: 'Zero harm',
                            },
                        ],
                    },
                ],
            },
        });

        const update = mockDb.run.mock.calls.find((c) => c[0].startsWith('UPDATE skills'));
        expect(update).toBeDefined();
        expect(update[0]).toContain('category = ?');
        expect(update[0]).toContain('description = ?');
        expect(update[0]).toContain('strategicLink = ?');
        expect(update[1]).toEqual(['Safety', 'new', 'Zero harm', 20]);
        expect(results.skillsUpdated).toBe(1);
        expect(results.skills).toBe(0);
    });

    test('a corrected role description and family reassignment are written and reported', async () => {
        mockDb.get.mockImplementation(
            router([
                ['FROM role_families', { id: 8, description: null }],
                ['FROM roles WHERE name', { id: 5, description: 'old', roleFamilyId: 2 }],
            ])
        );

        const { results } = await runImport({
            roles: [
                {
                    name: 'Driller',
                    description: 'CORRECTED',
                    roleFamily: 'Operations',
                    requirements: [],
                },
            ],
        });

        const update = mockDb.run.mock.calls.find((c) => c[0].startsWith('UPDATE roles'));
        expect(update).toBeDefined();
        expect(update[1]).toEqual(['CORRECTED', 8, 5]);
        expect(results.rolesUpdated).toBe(1);
    });

    test('a corrected site / department / service code is written and reported', async () => {
        mockDb.get.mockImplementation(
            router([
                ['FROM sites WHERE name', { id: 1, code: null, countryId: 4 }],
                ['FROM departments WHERE name', { id: 2, code: 'OLD' }],
                ['FROM services WHERE name', { id: 3, code: null }],
            ])
        );

        const { results } = await runImport({
            organization: {
                sites: [
                    {
                        name: 'Riverside',
                        code: 'ABJ',
                        departments: [
                            { name: 'IT', code: 'IT-1', services: [{ name: 'Ops', code: 'OPS' }] },
                        ],
                    },
                ],
            },
        });

        expect(mockDb.run).toHaveBeenCalledWith('UPDATE sites SET code = ? WHERE id = ?', [
            'ABJ',
            1,
        ]);
        expect(mockDb.run).toHaveBeenCalledWith('UPDATE departments SET code = ? WHERE id = ?', [
            'IT-1',
            2,
        ]);
        expect(mockDb.run).toHaveBeenCalledWith('UPDATE services SET code = ? WHERE id = ?', [
            'OPS',
            3,
        ]);
        expect(results.sitesUpdated).toBe(1);
        expect(results.departmentsUpdated).toBe(1);
        expect(results.servicesUpdated).toBe(1);
    });

    test('an existing person the file did not correct is not counted as updated', async () => {
        // `employeesUpdated` must mean "people this file corrected". It used to
        // count every person the file merely mentioned: 80 of 80 on a no-op
        // re-import, of which 70 differed only by '' versus NULL e-mail.
        mockDb.get.mockImplementation(
            router([
                ['FROM sites WHERE LOWER(name)', { id: 1 }],
                ['FROM departments WHERE LOWER(name)', { id: 2 }],
                ['FROM services WHERE LOWER(name)', { id: 3 }],
                ['FROM roles WHERE LOWER(name)', { id: 4 }],
                [
                    'FROM employees WHERE employeeNumber',
                    {
                        id: 11,
                        username: 'a.moren',
                        firstName: 'Ama',
                        lastName: 'Moren',
                        email: '',
                        phone: null,
                        siteId: 1,
                        departmentId: 2,
                        serviceId: 3,
                        roleId: 4,
                        isActive: true,
                    },
                ],
            ])
        );

        const { results } = await unified.importSystemFromJson(
            {
                employees: [
                    {
                        employeeNumber: 'EMP-1',
                        firstName: 'Ama',
                        lastName: 'Moren',
                        email: null,
                        phone: null,
                        site: 'Riverside',
                        department: 'IT',
                        service: 'Ops',
                        role: 'Driller',
                        isActive: true,
                        assessments: [],
                    },
                ],
            },
            null
        );

        expect(writes().some((s) => s.startsWith('UPDATE employees'))).toBe(false);
        expect(results.employeesUpdated).toBe(0);
    });

    test('a corrected person IS written and counted (the L4-6 behaviour still holds)', async () => {
        mockDb.get.mockImplementation(
            router([
                ['FROM sites WHERE LOWER(name)', { id: 1 }],
                ['FROM departments WHERE LOWER(name)', { id: 2 }],
                ['FROM services WHERE LOWER(name)', { id: 3 }],
                ['FROM roles WHERE LOWER(name)', { id: 4 }],
                [
                    'FROM employees WHERE employeeNumber',
                    {
                        id: 11,
                        username: 'a.moren',
                        firstName: 'Ama',
                        lastName: 'Moren',
                        email: '',
                        phone: null,
                        siteId: 1,
                        departmentId: 2,
                        serviceId: 9,
                        roleId: 4,
                        isActive: true,
                    },
                ],
            ])
        );

        const { results } = await unified.importSystemFromJson(
            {
                employees: [
                    {
                        employeeNumber: 'EMP-1',
                        firstName: 'Ama',
                        lastName: 'Moren',
                        email: null,
                        phone: '+225 01',
                        site: 'Riverside',
                        department: 'IT',
                        service: 'Ops',
                        role: 'Driller',
                        isActive: true,
                        assessments: [],
                    },
                ],
            },
            null
        );

        const update = mockDb.run.mock.calls.find((c) => c[0].startsWith('UPDATE employees'));
        expect(update).toBeDefined();
        expect(update[0]).toContain('phone = ?');
        expect(update[0]).toContain('serviceId = ?');
        expect(results.employeesUpdated).toBe(1);
    });
});
