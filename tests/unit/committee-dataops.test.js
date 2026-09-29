'use strict';

/**
 * Product-readiness committee — SECTION operations (data management & ops).
 *
 * Twelve findings, every one reproduced by execution on throwaway clones of
 * idevelop before the fix and re-proved after it. The numbers quoted in each
 * block are those measurements. The database is mocked here; the live-data
 * behaviour was exercised by the clone probes.
 *
 *  1  SQL console: "/* routine cleanup *\/ TRUNCATE system_logs, assessment_history"
 *     executed and COMMITTED (system_logs 6 085 -> 0, assessment_history -> 0)
 *     because the tamper guard classified the RAW text and its ^ anchor matched
 *     the comment. A direct TRUNCATE also bypassed the row-level trigger.
 *  2  Skill-matrix workbook keyed skills on (name, domain): restored into a fresh
 *     install it merged 10 department-designed skills, nulled every
 *     sub_domain_id and lost all 56 role families.
 *  3  ImportExportService: one transaction, per-row catch-and-continue -> the
 *     first bad row aborted the transaction, COMMIT became ROLLBACK and the API
 *     answered `created: 1` while NOTHING landed.
 *  4  importFullFramework re-inserted every assessment as "today, default admin,
 *     no notes": 2 712 rows restamped, 175 notes lost on a no-op round-trip.
 *  5  DROP SCHEMA public / DROP OWNED / DROP DATABASE passed the console guard.
 *  6  No export carried assessed_by -> every re-import attributed all 2 714
 *     assessments to the importer (histogram 1:2 68:2712 -> 1:2714).
 *  7  "system_full_backup.json" was active-only (roles 50 -> 41, skills 1 142 -> 1 126).
 *  8  Workbook org units derived from occupants -> an empty service never round-tripped.
 *  9  importDomainsSkills / importRoles had no transaction -> partial commit.
 * 10  assessmentHistoryRetention displayed, never read, cannot be enforced.
 * 11  reminderLogRetentionDays read by the prune job but absent from the settings.
 * 12  Restore drill: a corrupt dump died on a NativeCommandError before any
 *     check ran; no "RESTORE DRILL FAILED" verdict was printed.
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(),
    runInSavepoint: jest.fn(),
    pool: { connect: jest.fn() },
};
jest.mock('../../src/config/database', () => mockDb);
// AppSettingsModel does `new TtlCache(...)` at module load, so the mock must
// export a constructible TtlCache too, or requiring the model throws
// "TtlCache is not a constructor" and the whole suite fails to load.
jest.mock('../../src/utils/ttlCache', () => ({
    dashboardCache: { bust: jest.fn() },
    TtlCache: class {
        get() {
            return undefined;
        }
        set() {}
        delete() {}
        clear() {}
    },
}));
jest.mock('../../src/utils/importSkillResolver', () => ({
    resolveActiveSkillByName: jest.fn(async () => ({ id: 7 })),
    resolveSkillByIdOrName: jest.fn(async () => ({ id: 7 })),
    isRetiredOnly: jest.fn(async () => false),
}));
jest.mock('../../src/utils/rbacScope', () => ({
    scopedEmployeeIds: jest.fn(async () => null),
    scopeClause: jest.fn(() => ''),
}));
const mockSiteModel = {
    findOne: jest.fn(async () => null),
    create: jest.fn(async (row) => {
        if (row.name === 'LOTD-B')
            throw new Error('duplicate key value violates unique constraint "sites_code_key"');
        return { id: 1 };
    }),
};
jest.mock('../../src/models/SiteModel', () => mockSiteModel);

const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const writes = () => mockDb.run.mock.calls.map((c) => c[0].replace(/\s+/g, ' ').trim());

/**
 * Route db.get / db.all by SQL fragment (first match wins — so a fragment must
 * be unique to the query it targets); a function may look at the params.
 * `dflt` is what an unrouted query returns: pass `[]` when routing db.all, so a
 * query the test does not care about reads as "no rows" instead of `undefined`.
 */
function router(routes, dflt = undefined) {
    return async (sql, params) => {
        for (const [fragment, value] of routes) {
            if (sql.includes(fragment))
                return typeof value === 'function' ? value(params, sql) : value;
        }
        return dflt;
    };
}

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({ changes: 1 });
    mockDb.runTransaction.mockReset().mockImplementation(async (fn) => fn());
    mockDb.runInSavepoint.mockReset().mockImplementation(async (fn) => fn());
    mockDb.pool.connect.mockReset();
});

// ---------------------------------------------------------------------------
// 1 + 5 — the SQL console guard classifies the statement head, and refuses
//         whole-schema destruction
// ---------------------------------------------------------------------------
describe('F1 — the tamper guard reads the statement HEAD, never the raw text', () => {
    const svc = require('../../src/services/SqlConsoleService');
    const violation = (sql) => svc._auditTamperViolation([sql]);

    test('a leading block comment no longer hides TRUNCATE of the audit tables', () => {
        expect(
            violation('/* routine cleanup */ TRUNCATE system_logs, assessment_history')
        ).toBeTruthy();
    });

    test('a leading line comment does not hide DELETE / UPDATE / ALTER either', () => {
        expect(violation('-- tidy\nDELETE FROM system_logs')).toBeTruthy();
        expect(violation('-- tidy\nUPDATE assessment_history SET action = 1')).toBeTruthy();
        expect(
            violation('/* x */ ALTER TABLE review_signatures DROP COLUMN signed_at')
        ).toBeTruthy();
        expect(violation('/* x */ ALTER TABLE employees DISABLE TRIGGER ALL')).toBeTruthy();
    });

    test('the same statement without the comment is still refused (no regression)', () => {
        expect(violation('TRUNCATE system_logs, assessment_history')).toBeTruthy();
    });

    test('the guard functions themselves cannot be redefined', () => {
        expect(
            violation(
                'CREATE OR REPLACE FUNCTION public.block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$'
            )
        ).toBeTruthy();
        expect(violation('DROP FUNCTION block_truncate()')).toBeTruthy();
    });

    test('a commented read of a protected table is still allowed', () => {
        expect(violation('/* look */ SELECT count(*) FROM system_logs')).toBeNull();
    });

    test('execute() refuses before touching the database', async () => {
        const r = await svc.execute(
            '/* routine cleanup */ TRUNCATE system_logs, assessment_history;'
        );
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/Refused/);
        expect(mockDb.pool.connect).not.toHaveBeenCalled();
    });
});

describe('F1 — migration 101 refuses TRUNCATE at the database itself', () => {
    const file = fs
        .readdirSync(path.join(__dirname, '../../db/postgres'))
        .find((f) => /^101_/.test(f));
    const sql = read(`db/postgres/${file}`);

    test('a statement-level BEFORE TRUNCATE trigger guards each append-only table', () => {
        expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.block_truncate\(\)/);
        for (const t of ['system_logs', 'assessment_history', 'review_signatures']) {
            const re = new RegExp(
                `BEFORE TRUNCATE ON public\\.${t}\\s+FOR EACH STATEMENT EXECUTE FUNCTION public\\.block_truncate\\(\\)`
            );
            expect(sql).toMatch(re);
        }
    });

    test('it raises the same IMMUTABLE_TABLE error every handler already reads', () => {
        expect(sql).toMatch(/IMMUTABLE_TABLE: % is append-only/);
        expect(sql).toMatch(/ERRCODE = 'check_violation'/);
    });

    test('it is idempotent (DROP TRIGGER IF EXISTS before each CREATE)', () => {
        expect((sql.match(/DROP TRIGGER IF EXISTS/g) || []).length).toBe(3);
    });

    test('it removes the orphan retention setting (finding 10)', () => {
        expect(sql).toMatch(
            /DELETE FROM public\.app_settings WHERE setting_key = 'assessmentHistoryRetention'/
        );
    });
});

describe('F5 — whole-schema / database destruction is refused unconditionally', () => {
    const svc = require('../../src/services/SqlConsoleService');
    const violation = (sql) => svc._auditTamperViolation([sql]);

    test.each([
        'DROP SCHEMA public CASCADE',
        'DROP SCHEMA IF EXISTS public CASCADE',
        'drop schema "public" cascade',
        '/* cleanup */ DROP SCHEMA public',
        'DROP OWNED BY postgres CASCADE',
        'DROP DATABASE idevelop_dev',
    ])('%s', (sql) => {
        expect(violation(sql)).toBeTruthy();
    });

    test('dropping an unrelated scratch schema is not over-blocked', () => {
        expect(violation('DROP SCHEMA lotd_scratch CASCADE')).toBeNull();
    });

    test('execute() refuses DROP SCHEMA public before touching the database', async () => {
        const r = await svc.execute('DROP SCHEMA public CASCADE;', { dryRun: true });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/DROP SCHEMA public/);
        expect(mockDb.pool.connect).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// 3 + 9 — one savepoint per row, one transaction per file
// ---------------------------------------------------------------------------
describe('F3 — a bad row is contained in its own savepoint', () => {
    const svc = require('../../src/services/ImportExportService');

    test('sites A and C land, B is the only error, and the counters describe what commits', async () => {
        const r = await svc.importOrganization(
            {
                sites: [
                    { name: 'LOTD-A', code: 'PC1' },
                    { name: 'LOTD-B', code: 'PC1' },
                    { name: 'LOTD-C', code: 'PC3' },
                ],
            },
            1
        );

        expect(r.sites.created).toBe(2);
        expect(r.sites.errors).toHaveLength(1);
        expect(r.sites.errors[0]).toMatch(/LOTD-B.*sites_code_key/);
        expect(mockDb.runTransaction).toHaveBeenCalledTimes(1);
        expect(mockDb.runInSavepoint).toHaveBeenCalledTimes(3); // one per row
        expect(mockSiteModel.create.mock.calls.map((c) => c[0].name)).toEqual([
            'LOTD-A',
            'LOTD-B',
            'LOTD-C',
        ]);
    });

    test('an uncaught error still surfaces as an exception, never as a success payload', async () => {
        mockDb.runTransaction.mockImplementation(async () => {
            throw new Error('current transaction is aborted');
        });
        await expect(svc.importOrganization({ sites: [{ name: 'X' }] }, 1)).rejects.toThrow(
            /aborted/
        );
    });
});

describe('F9 — importDomainsSkills and importRoles are transactional with per-row savepoints', () => {
    const svc = require('../../src/services/ImportExportService');

    test('importDomainsSkills runs inside ONE transaction, each row in a savepoint', async () => {
        mockDb.get.mockResolvedValue(undefined);
        await svc.importDomainsSkills(
            {
                domains: [{ name: 'D1' }, { name: 'D2' }],
                skills: [{ name: 'S', domainName: 'D1' }],
            },
            1
        );
        expect(mockDb.runTransaction).toHaveBeenCalledTimes(1);
        expect(mockDb.runInSavepoint).toHaveBeenCalledTimes(3);
    });

    test('importRoles runs inside ONE transaction, each row in a savepoint', async () => {
        mockDb.get.mockResolvedValue(undefined);
        await svc.importRoles([{ name: 'R1' }, { name: 'R2' }], 1);
        expect(mockDb.runTransaction).toHaveBeenCalledTimes(1);
        expect(mockDb.runInSavepoint).toHaveBeenCalledTimes(2);
    });

    test('a mid-file crash propagates out of the transaction (nothing partial is reported)', async () => {
        const trap = (arr) =>
            new Proxy(arr, {
                get(t, p) {
                    if (p === '1') throw new Error('mid-file crash');
                    return t[p];
                },
            });
        await expect(
            svc.importDomainsSkills({ domains: trap([{ name: 'D1' }, { name: 'D2' }]) }, 1)
        ).rejects.toThrow(/mid-file crash/);
        await expect(svc.importRoles(trap([{ name: 'R1' }, { name: 'R2' }]), 1)).rejects.toThrow(
            /mid-file crash/
        );
    });
});

// ---------------------------------------------------------------------------
// 4 — the full-framework matrix import keeps date / assessor / notes
// ---------------------------------------------------------------------------
describe('F4 — importFullFramework does not rewrite what the file cannot supply', () => {
    const imp = require('../../src/services/UnifiedImportService');

    async function workbookWith(level) {
        const wb = new ExcelJS.Workbook();
        const sh = wb.addWorksheet('Employees');
        sh.addRow([
            'Employee ID',
            'First Name',
            'Last Name',
            'Email',
            'Site',
            'Department',
            'Service',
            'Role',
            'Blasting',
        ]);
        sh.addRow(['E1', 'Ama', 'Moren', '', 'A', 'D', 'S', 'Driller', level]);
        return wb;
    }
    const org = [
        ['FROM sites WHERE', { id: 1 }],
        ['FROM departments WHERE', { id: 2 }],
        ['FROM services WHERE', { id: 3 }],
        ['FROM roles WHERE', { id: 4 }],
        ['FROM employees WHERE employeeNumber', { id: 11 }],
        ['FROM admins', { id: 4 }],
    ];

    test('an identical level writes NOTHING and is counted `unchanged`', async () => {
        mockDb.get.mockImplementation(
            router([...org, ['FROM skillAssessments', { id: 55, currentLevel: 3 }]])
        );
        const results = {};
        await imp.importEmployeesAndAssessments(await workbookWith(3), results);
        expect(writes().some((s) => /skillAssessments/i.test(s))).toBe(false);
        expect(results.assessments).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    });

    test('a changed level is an UPDATE that COALESCEs assessor and notes to the stored values', async () => {
        mockDb.get.mockImplementation(
            router([...org, ['FROM skillAssessments', { id: 55, currentLevel: 1 }]])
        );
        const results = {};
        await imp.importEmployeesAndAssessments(await workbookWith(3), results);
        const w = writes();
        expect(w.some((s) => s.startsWith('DELETE FROM skillAssessments'))).toBe(false);
        const update = w.find((s) => s.startsWith('UPDATE skillAssessments'));
        expect(update).toBeDefined();
        expect(update).toContain('assessedBy = COALESCE(?, assessedBy)');
        expect(update).toContain('notes = COALESCE(?, notes)');
        expect(update).not.toMatch(/datetime\('now'\)/);
        expect(results.assessments).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
    });

    test('a new assessment is still created', async () => {
        mockDb.get.mockImplementation(router([...org, ['FROM skillAssessments', undefined]]));
        const results = {};
        await imp.importEmployeesAndAssessments(await workbookWith(2), results);
        expect(writes().some((s) => s.startsWith('INSERT INTO skillAssessments'))).toBe(true);
        expect(results.assessments).toMatchObject({ created: 1, updated: 0, unchanged: 0 });
    });
});

// ---------------------------------------------------------------------------
// 2 + 6 + 8 — the skill-matrix workbook carries the whole framework
// ---------------------------------------------------------------------------
describe('F2/F6/F8 — the workbook model carries sub-domains, families, org units and the assessor', () => {
    const wb = require('../../src/services/SkillMatrixWorkbookService');
    const AT = '2026-05-04T10:00:00.000Z';

    const model = {
        meta: { format: 'idevelop-skill-matrix', version: 2 },
        competencyScale: [{ level: 0, definition: 'None' }],
        domains: [{ domainId: 'DOM-01', domainName: 'HSE' }],
        subDomains: [
            {
                domainId: 'DOM-01',
                domainName: 'HSE',
                subDomainName: 'Physical',
                definition: 'Body',
                position: 1,
            },
        ],
        skills: [
            {
                skillId: 'SKL-001',
                skillName: 'fatigue',
                domainId: 'DOM-01',
                domainName: 'HSE',
                subDomainName: 'Physical',
            },
            {
                skillId: 'SKL-002',
                skillName: 'fatigue',
                domainId: 'DOM-01',
                domainName: 'HSE',
                subDomainName: 'Mental',
            },
        ],
        roleFamilies: [{ roleFamilyName: 'Mining', description: 'Pit' }],
        roles: [
            { roleId: 'ROL-00', roleName: 'Driller', careerLevel: 'Entry', roleFamily: 'Mining' },
        ],
        roleRequirements: [
            {
                roleId: 'ROL-00',
                skillId: 'SKL-002',
                skillName: 'fatigue',
                domainId: 'DOM-01',
                requiredLevel: 2,
                isCritical: 'Yes',
            },
        ],
        organization: [{ site: 'A', department: 'D', service: 'Empty service' }],
        employees: [],
        assessments: [
            {
                employeeId: 'E1',
                employeeName: 'Ama Moren',
                roleId: 'ROL-00',
                skillId: 'SKL-002',
                skillName: 'fatigue',
                domainId: 'DOM-01',
                requiredLevel: 2,
                currentLevel: 3,
                gap: '',
                priority: '',
                developmentAction: '',
                targetDate: '',
                evidenceReference: '',
                assessedAt: AT,
                assessedBy: 'Admin: hr.lead',
                notes: 'ok',
            },
        ],
    };

    const expectInternal = (internal) => {
        expect(internal.subDomains).toEqual([
            { domainName: 'HSE', name: 'Physical', definition: 'Body', position: 1 },
        ]);
        expect(internal.skills).toEqual([
            { name: 'fatigue', domainName: 'HSE', subDomainName: 'Physical' },
            { name: 'fatigue', domainName: 'HSE', subDomainName: 'Mental' },
        ]);
        expect(internal.roleFamilies).toEqual([{ name: 'Mining', description: 'Pit' }]);
        expect(internal.roles).toEqual([
            { name: 'Driller', careerLevel: 'Entry', roleFamily: 'Mining' },
        ]);
        // The requirement resolves its sub-domain through the Skill ID.
        expect(internal.requirements[0]).toMatchObject({
            skillName: 'fatigue',
            subDomainName: 'Mental',
            requiredLevel: 2,
            isCritical: true,
        });
        expect(internal.organization).toEqual([
            { site: 'A', department: 'D', service: 'Empty service' },
        ]);
        expect(internal.assessments[0]).toMatchObject({
            skillName: 'fatigue',
            subDomainName: 'Mental',
            currentLevel: 3,
            assessedAt: AT,
            assessedBy: 'Admin: hr.lead',
            notes: 'ok',
        });
    };

    test('JSON round-trips every new section and field', () => {
        expectInternal(wb._modelToInternal(wb._jsonToModel(wb._modelToJson(model))));
    });
    test('XML round-trips every new section and field', () => {
        expectInternal(wb._modelToInternal(wb._xmlToModel(wb._modelToXml(model))));
    });
    test('CSV round-trips every new section and field', () => {
        const csv = wb._modelToCsv(model);
        expect(csv).toContain('### SUB_DOMAINS ###');
        expect(csv).toContain('### ROLE_FAMILIES ###');
        expect(csv).toContain('### ORGANIZATION ###');
        expectInternal(wb._modelToInternal(wb._csvToModel(csv)));
    });
    test('Excel round-trips every new section and field', async () => {
        const book = wb._modelToWorkbook(model);
        const buf = await book.xlsx.writeBuffer();
        const back = new ExcelJS.Workbook();
        await back.xlsx.load(buf);
        expectInternal(wb.parseWorkbook(back));
    });

    test('an older-layout file (no new columns) parses to exactly the shape it always did', () => {
        const old = {
            domains: model.domains,
            skills: [{ skillId: 'SKL-001', skillName: 'x', domainId: 'DOM-01', domainName: 'HSE' }],
            roles: [{ roleId: 'ROL-00', roleName: 'Driller', careerLevel: 'Entry' }],
        };
        const internal = wb._modelToInternal(wb._jsonToModel(JSON.stringify(old)));
        expect(internal.skills).toEqual([{ name: 'x', domainName: 'HSE' }]);
        expect(internal.roles).toEqual([{ name: 'Driller', careerLevel: 'Entry' }]);
        expect(internal.subDomains).toBeUndefined();
        expect(internal.roleFamilies).toBeUndefined();
        expect(internal.organization).toBeUndefined();
    });

    test('F2 — two skills sharing a name in one domain but not one sub-domain are TWO skills', async () => {
        mockDb.get.mockImplementation(
            router([
                ['FROM domains WHERE name', { id: 1 }],
                [
                    'FROM subDomains WHERE domainId',
                    (params) => (params[1] === 'Physical' ? { id: 10 } : { id: 20 }),
                ],
                ['FROM skills WHERE subDomainId', undefined],
            ])
        );
        const section = () => ({ created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] });
        const results = {
            domains: section(),
            subDomains: section(),
            skills: section(),
            warnings: [],
        };

        await wb._importSkills(
            {
                skills: [
                    { name: 'fatigue', domainName: 'HSE', subDomainName: 'Physical' },
                    { name: 'fatigue', domainName: 'HSE', subDomainName: 'Mental' },
                ],
            },
            results
        );

        const inserts = mockDb.run.mock.calls.filter((c) => c[0].startsWith('INSERT INTO skills'));
        expect(inserts).toHaveLength(2);
        expect(inserts[0][0]).toContain('subDomainId');
        expect(inserts.map((c) => c[1][2])).toEqual([10, 20]); // sub_domain_id written on insert
        expect(results.skills.created).toBe(2);
        expect(results.warnings).toEqual([]); // no "duplicate row" claim
    });

    test('F2 — a role names its family and the family is created/linked', async () => {
        let famCalls = 0;
        mockDb.get.mockImplementation(
            router([
                [
                    'FROM role_families WHERE',
                    () => (famCalls++ === 0 ? undefined : { id: 3, description: null }),
                ],
                ['FROM roles WHERE name', undefined],
            ])
        );
        const section = () => ({ created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] });
        const results = { roleFamilies: section(), roles: section(), warnings: [] };

        await wb._importRoles(
            { roles: [{ name: 'Driller', careerLevel: 'Entry', roleFamily: 'Mining' }] },
            results
        );

        expect(writes().some((s) => s.startsWith('INSERT INTO role_families'))).toBe(true);
        const roleInsert = mockDb.run.mock.calls.find((c) => c[0].startsWith('INSERT INTO roles'));
        expect(roleInsert[0]).toContain('role_family_id');
        expect(roleInsert[1]).toEqual(['Driller', 'Entry', 3]);
        expect(results.roleFamilies.created).toBe(1);
    });

    test('F8 — an organization unit with no occupant is created from its own section', async () => {
        mockDb.get.mockImplementation(
            router([
                ['FROM sites WHERE name', { id: 1 }],
                ['FROM departments WHERE name', { id: 2 }],
                [
                    'FROM services WHERE name',
                    (() => {
                        let n = 0;
                        return () => (n++ === 0 ? undefined : { id: 3 });
                    })(),
                ],
            ])
        );
        const section = () => ({ created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] });
        const results = { sites: section(), departments: section(), services: section() };

        await wb._importOrganization(
            { organization: [{ site: 'A', department: 'D', service: 'Empty service' }] },
            results
        );

        expect(writes().some((s) => s.startsWith('INSERT INTO services'))).toBe(true);
        expect(results.services.created).toBe(1);
    });

    test('F6 — the assessor the file names is honoured, so an identical row is `unchanged`', async () => {
        mockDb.all.mockResolvedValue([
            { id: 9, username: 'hr.lead' },
            { id: 4, username: 'admin' },
        ]);
        mockDb.get.mockImplementation(
            router([
                ['FROM employees WHERE employeeNumber', { id: 11 }],
                [
                    'FROM skillAssessments',
                    { id: 55, currentLevel: 3, assessedBy: 9, assessedAt: AT, notes: null },
                ],
            ])
        );
        const results = {
            assessments: { created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] },
        };

        await wb._importAssessments(
            {
                assessments: [
                    {
                        employeeNumber: 'E1',
                        skillName: 'Blasting',
                        domainName: 'HSE',
                        currentLevel: 3,
                        assessedAt: AT,
                        assessedBy: 'Admin: hr.lead',
                    },
                ],
            },
            results,
            4
        );

        expect(mockDb.run).not.toHaveBeenCalled();
        expect(results.assessments).toMatchObject({ updated: 0, unchanged: 1 });
    });

    test('F6 — a row WITHOUT an assessor falls back to the importer (and is reported as an update)', async () => {
        mockDb.all.mockResolvedValue([
            { id: 9, username: 'hr.lead' },
            { id: 4, username: 'admin' },
        ]);
        mockDb.get.mockImplementation(
            router([
                ['FROM employees WHERE employeeNumber', { id: 11 }],
                [
                    'FROM skillAssessments',
                    { id: 55, currentLevel: 3, assessedBy: 9, assessedAt: AT, notes: null },
                ],
            ])
        );
        const results = {
            assessments: { created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] },
        };

        await wb._importAssessments(
            {
                assessments: [
                    {
                        employeeNumber: 'E1',
                        skillName: 'Blasting',
                        domainName: 'HSE',
                        currentLevel: 3,
                        assessedAt: AT,
                    },
                ],
            },
            results,
            4
        );

        const update = mockDb.run.mock.calls.find((c) =>
            c[0].startsWith('UPDATE skillAssessments')
        );
        expect(update).toBeDefined();
        expect(update[1][1]).toBe(4);
        expect(update[0]).toContain('notes = COALESCE(?, notes)');
        expect(results.assessments).toMatchObject({ updated: 1, unchanged: 0 });
    });

    test('F2/F6/F8 — the export model reads the framework, the org units and the assessor from the database', async () => {
        mockDb.all.mockImplementation(
            router(
                [
                    // The scaffold query is routed on its own join: the org-unit query
                    // (services ∪ empty departments ∪ empty sites) also says UNION ALL.
                    [
                        'LEFT JOIN skillAssessments sa ON sa.employeeId',
                        [
                            {
                                employeeNumber: 'E1',
                                firstName: 'Ama',
                                lastName: 'Moren',
                                roleId: 4,
                                skillId: 7,
                                skillName: 'Blasting',
                                domainId: 1,
                                reqLevel: 2,
                                currentLevel: 3,
                                assessedAt: AT,
                                assessedBy: 9,
                                notes: 'ok',
                            },
                            {
                                employeeNumber: 'E1',
                                firstName: 'Ama',
                                lastName: 'Moren',
                                roleId: 4,
                                skillId: 8,
                                skillName: 'Rigging',
                                domainId: 1,
                                reqLevel: 1,
                                currentLevel: null,
                                assessedAt: null,
                                assessedBy: null,
                                notes: null,
                            },
                        ],
                    ],
                    [
                        'FROM subDomains sd JOIN domains d',
                        [{ id: 10, name: 'Ops', definition: 'Field', position: 1, domainId: 1 }],
                    ],
                    [
                        'FROM skills s JOIN domains d',
                        [
                            {
                                id: 7,
                                name: 'Blasting',
                                domainId: 1,
                                domainName: 'HSE',
                                subDomainName: 'Ops',
                            },
                            {
                                id: 8,
                                name: 'Rigging',
                                domainId: 1,
                                domainName: 'HSE',
                                subDomainName: 'Ops',
                            },
                        ],
                    ],
                    [
                        'FROM role_families WHERE isActive',
                        [{ id: 3, name: 'Mining', description: 'Pit' }],
                    ],
                    [
                        'FROM roles r LEFT JOIN role_families',
                        [{ id: 4, name: 'Driller', description: 'Entry', roleFamily: 'Mining' }],
                    ],
                    [
                        'FROM services sv',
                        [{ site: 'A', department: 'D', service: 'Empty service' }],
                    ],
                    [
                        'FROM roleSkillRequirements WHERE roleId',
                        [{ skillId: 7, requiredLevel: 2, isCritical: true }],
                    ],
                    [
                        'LEFT JOIN sites st',
                        [
                            {
                                id: 11,
                                employeeNumber: 'E1',
                                firstName: 'Ama',
                                lastName: 'Moren',
                                roleId: 4,
                                siteName: 'A',
                                deptName: 'D',
                                serviceName: 'S',
                                roleName: 'Driller',
                            },
                        ],
                    ],
                    ['FROM domains WHERE isActive', [{ id: 1, name: 'HSE' }]],
                    ['FROM admins', [{ id: 9, username: 'hr.lead' }]],
                ],
                []
            )
        );

        const m = await wb._collectModel({
            includeLiveEmployees: true,
            user: { id: 1, userType: 'admin', role: 'superadmin' },
        });

        expect(m.subDomains).toEqual([
            {
                domainId: 'DOM-01',
                domainName: 'HSE',
                subDomainName: 'Ops',
                definition: 'Field',
                position: 1,
            },
        ]);
        expect(m.skills[0]).toMatchObject({ skillName: 'Blasting', subDomainName: 'Ops' });
        expect(m.roleFamilies).toEqual([{ roleFamilyName: 'Mining', description: 'Pit' }]);
        expect(m.roles[0]).toMatchObject({ roleName: 'Driller', roleFamily: 'Mining' });
        expect(m.roleRequirements[0]).toMatchObject({
            skillName: 'Blasting',
            subDomainName: 'Ops',
        });
        expect(m.organization).toEqual([{ site: 'A', department: 'D', service: 'Empty service' }]);
        // Assessed row: who, when, note. Scaffold row: nothing invented.
        expect(m.assessments[0]).toMatchObject({
            skillName: 'Blasting',
            subDomainName: 'Ops',
            currentLevel: 3,
            assessedBy: 'Admin: hr.lead',
            notes: 'ok',
            assessedAt: AT,
        });
        expect(m.assessments[1]).toMatchObject({
            skillName: 'Rigging',
            currentLevel: '',
            assessedBy: '',
            notes: '',
            assessedAt: '',
        });
    });
});

// ---------------------------------------------------------------------------
// 6 + 7 — the JSON system export/import
// ---------------------------------------------------------------------------
describe('F6/F7 — the JSON export carries inactive rows and the assessor, and the import honours them', () => {
    const uj = require('../../src/services/UnifiedJsonService');
    const AT = '2026-05-04T10:00:00.000Z';

    test('every framework / org / role row is exported with its isActive flag, plus assessedBy', async () => {
        mockDb.all.mockImplementation(
            router(
                [
                    [
                        'FROM domains ORDER BY',
                        [
                            { id: 1, name: 'HSE', description: null, isActive: true },
                            { id: 2, name: 'Legacy', description: null, isActive: false },
                        ],
                    ],
                    [
                        'FROM sub_domains ORDER BY',
                        [
                            {
                                id: 10,
                                domainId: 1,
                                name: 'Ops',
                                definition: null,
                                position: 1,
                                isActive: true,
                            },
                        ],
                    ],
                    [
                        'FROM skills ORDER BY name',
                        [
                            {
                                domainId: 1,
                                subDomainId: 10,
                                name: 'Blasting',
                                category: null,
                                description: null,
                                strategicLink: null,
                                isActive: true,
                            },
                            {
                                domainId: 1,
                                subDomainId: 10,
                                name: 'Blasting',
                                category: null,
                                description: null,
                                strategicLink: null,
                                isActive: false,
                            },
                        ],
                    ],
                    [
                        'FROM sites s LEFT JOIN countries',
                        [{ id: 1, name: 'A', code: null, countryName: null, isActive: false }],
                    ],
                    [
                        'FROM role_families ORDER BY',
                        [{ name: 'Mining', description: null, isActive: true }],
                    ],
                    [
                        'FROM roles r LEFT JOIN',
                        [
                            {
                                id: 4,
                                name: 'Old role',
                                description: null,
                                isActive: false,
                                roleFamilyName: null,
                            },
                        ],
                    ],
                    [
                        'FROM employees e',
                        [
                            {
                                id: 11,
                                employeeNumber: 'E1',
                                firstName: 'Ama',
                                lastName: 'Moren',
                                isActive: true,
                            },
                        ],
                    ],
                    [
                        'FROM skillAssessments sa',
                        [
                            {
                                employeeId: 11,
                                skillName: 'Blasting',
                                domainName: 'HSE',
                                subDomainName: 'Ops',
                                level: 3,
                                notes: null,
                                assessedAt: AT,
                                assessedBy: 9,
                            },
                        ],
                    ],
                    [
                        'FROM admins',
                        [{ id: 9, username: 'hr.lead', email: null, role: 'localadmin' }],
                    ],
                    // regions / countries / departments / services / requirements /
                    // admin_scopes / app_settings are not routed: they read as no rows.
                ],
                []
            )
        );

        const out = await uj.exportSystemToJson();

        expect(out.framework.domains.map((d) => [d.name, d.isActive])).toEqual([
            ['HSE', true],
            ['Legacy', false],
        ]);
        expect(out.framework.domains[0].skills.map((s) => s.isActive)).toEqual([true, false]); // the retired twin is carried
        expect(out.framework.domains[0].subDomains[0]).toMatchObject({
            name: 'Ops',
            isActive: true,
        });
        expect(out.organization.sites[0]).toMatchObject({ name: 'A', isActive: false });
        expect(out.roleFamilies[0]).toMatchObject({ name: 'Mining', isActive: true });
        expect(out.roles[0]).toMatchObject({ name: 'Old role', isActive: false });
        expect(out.employees[0].assessments[0]).toMatchObject({
            skill: 'Blasting',
            subDomain: 'Ops',
            assessedBy: 'Admin: hr.lead',
            assessedAt: AT,
        });
        expect(out.metadata.scope).toMatch(/NOT a full backup/);
    });

    test('an inactive domain / skill / role in the file is re-created INACTIVE, not resurrected', async () => {
        let domainCalls = 0;
        let roleCalls = 0;
        mockDb.get.mockImplementation(
            router([
                ['FROM domains WHERE name', () => (domainCalls++ === 0 ? undefined : { id: 2 })],
                ['FROM skills WHERE', undefined],
                ['FROM roles WHERE name', () => (roleCalls++ === 0 ? undefined : { id: 4 })],
            ])
        );

        await uj.importSystemFromJson(
            {
                framework: {
                    domains: [
                        {
                            name: 'Legacy',
                            isActive: false,
                            skills: [{ name: 'Blasting', isActive: false }],
                        },
                    ],
                },
                roles: [{ name: 'Old role', isActive: false, requirements: [] }],
            },
            null
        );

        const domainInsert = mockDb.run.mock.calls.find((c) =>
            c[0].startsWith('INSERT INTO domains')
        );
        expect(domainInsert[1]).toEqual(['Legacy', null, false]);
        const skillLookup = mockDb.get.mock.calls.find((c) => c[0].includes('FROM skills WHERE'));
        expect(skillLookup[0]).toContain('isActive = ?');
        expect(skillLookup[1][skillLookup[1].length - 1]).toBe(false); // matched among RETIRED rows
        const skillInsert = mockDb.run.mock.calls.find((c) =>
            c[0].startsWith('INSERT INTO skills')
        );
        expect(skillInsert[1][skillInsert[1].length - 1]).toBe(false);
        const roleInsert = mockDb.run.mock.calls.find((c) => c[0].startsWith('INSERT INTO roles'));
        expect(roleInsert[1][roleInsert[1].length - 1]).toBe(false);
    });

    test('an older file without the flag still creates ACTIVE rows (back-compat)', async () => {
        let domainCalls = 0;
        mockDb.get.mockImplementation(
            router([
                ['FROM domains WHERE name', () => (domainCalls++ === 0 ? undefined : { id: 1 })],
            ])
        );
        await uj.importSystemFromJson(
            { framework: { domains: [{ name: 'HSE', skills: [] }] } },
            null
        );
        const domainInsert = mockDb.run.mock.calls.find((c) =>
            c[0].startsWith('INSERT INTO domains')
        );
        expect(domainInsert[1]).toEqual(['HSE', null, true]);
    });

    // skills.is_duplicate is the skill-merge marker (a retired twin judged to
    // overlap a standard item). Before: exported nowhere, so a restored instance
    // read every merged twin back as is_duplicate = false.
    const domainRows = [
        ['FROM domains WHERE name', { id: 1, description: null, isActive: true }],
        ['FROM sub_domains WHERE name', { id: 10, definition: null, position: 1, isActive: true }],
    ];

    test('F7 — the skill-merge marker is_duplicate is exported with every skill', async () => {
        mockDb.all.mockImplementation(
            router(
                [
                    [
                        'FROM domains ORDER BY',
                        [{ id: 1, name: 'HSE', description: null, isActive: true }],
                    ],
                    [
                        'FROM sub_domains ORDER BY',
                        [
                            {
                                id: 10,
                                domainId: 1,
                                name: 'Ops',
                                definition: null,
                                position: 1,
                                isActive: true,
                            },
                        ],
                    ],
                    [
                        'FROM skills ORDER BY name',
                        [
                            {
                                domainId: 1,
                                subDomainId: 10,
                                name: 'Blasting',
                                category: null,
                                description: null,
                                strategicLink: null,
                                isDuplicate: false,
                                isActive: true,
                            },
                            {
                                domainId: 1,
                                subDomainId: 10,
                                name: 'Blasting',
                                category: null,
                                description: null,
                                strategicLink: null,
                                isDuplicate: true,
                                isActive: false,
                            },
                        ],
                    ],
                ],
                []
            )
        );

        const out = await uj.exportSystemToJson();

        const skillSql = mockDb.all.mock.calls
            .map((c) => c[0])
            .find((s) => /FROM skills ORDER BY name/.test(s));
        expect(skillSql).toMatch(/is_duplicate AS isDuplicate/);
        expect(out.framework.domains[0].skills.map((s) => [s.isActive, s.isDuplicate])).toEqual([
            [true, false],
            [false, true],
        ]);
        expect(out.metadata.scope).toMatch(/isDuplicate/);
    });

    test('F7 — a new skill is created WITH the marker the file carries (and without it when the file has none)', async () => {
        mockDb.get.mockImplementation(router([...domainRows, ['FROM skills WHERE', undefined]]));

        await uj.importSystemFromJson(
            {
                framework: {
                    domains: [
                        {
                            name: 'HSE',
                            subDomains: [{ name: 'Ops' }],
                            skills: [
                                { name: 'Blasting', subDomain: 'Ops', isActive: true },
                                {
                                    name: 'Blasting',
                                    subDomain: 'Ops',
                                    isActive: false,
                                    isDuplicate: true,
                                },
                                'Rigging', // older string shape
                            ],
                        },
                    ],
                },
            },
            null
        );

        const inserts = mockDb.run.mock.calls.filter((c) => c[0].startsWith('INSERT INTO skills'));
        expect(inserts).toHaveLength(3);
        for (const [sql] of inserts) expect(sql).toMatch(/is_duplicate, isActive\) VALUES/);
        // is_duplicate sits just before isActive, which stays the LAST parameter.
        expect(inserts.map((c) => c[1][c[1].length - 2])).toEqual([false, true, false]);
        expect(inserts.map((c) => c[1][c[1].length - 1])).toEqual([true, false, true]);
    });

    test('F7 — an existing skill takes the marker from the file; a file without the key leaves it alone', async () => {
        const stored = {
            blasting: {
                id: 77,
                subDomainId: 10,
                category: null,
                description: null,
                strategicLink: null,
                isDuplicate: false,
            },
            rigging: {
                id: 78,
                subDomainId: 10,
                category: null,
                description: null,
                strategicLink: null,
                isDuplicate: false,
            },
            welding: {
                id: 79,
                subDomainId: 10,
                category: null,
                description: null,
                strategicLink: null,
                isDuplicate: true,
            },
        };
        mockDb.get.mockImplementation(
            router([
                ...domainRows,
                [
                    'FROM skills WHERE',
                    (params, sql) => {
                        expect(sql).toMatch(/is_duplicate AS isDuplicate/); // the lookup reads the stored marker
                        return stored[String(params[1]).toLowerCase()];
                    },
                ],
            ])
        );

        const { results } = await uj.importSystemFromJson(
            {
                framework: {
                    domains: [
                        {
                            name: 'HSE',
                            subDomains: [{ name: 'Ops' }],
                            skills: [
                                {
                                    name: 'Blasting',
                                    subDomain: 'Ops',
                                    isActive: false,
                                    isDuplicate: true,
                                }, // false -> true: corrected
                                { name: 'Rigging', subDomain: 'Ops', isDuplicate: false }, // identical: no write
                                { name: 'Welding', subDomain: 'Ops' }, // key absent: untouched
                            ],
                        },
                    ],
                },
            },
            null
        );

        const updates = mockDb.run.mock.calls.filter((c) => c[0].startsWith('UPDATE skills'));
        expect(updates).toHaveLength(1);
        expect(updates[0][0].replace(/\s+/g, ' ')).toBe(
            'UPDATE skills SET is_duplicate = ? WHERE id = ?'
        );
        expect(updates[0][1]).toEqual([true, 77]);
        expect(results.skillsUpdated).toBe(1);
        expect(results.skills).toBe(0);
    });

    test('F6 — the assessor label resolves to that admin, and an identical row is left alone', async () => {
        mockDb.all.mockResolvedValue([{ id: 9, username: 'hr.lead' }]);
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
                        firstName: 'Ama',
                        lastName: 'Moren',
                        email: null,
                        phone: null,
                        siteId: 1,
                        departmentId: 2,
                        serviceId: 3,
                        roleId: 4,
                        isActive: true,
                    },
                ],
                [
                    'FROM skillAssessments WHERE employeeId',
                    { id: 55, currentLevel: 3, notes: null, assessedBy: 9, assessedAt: AT },
                ],
            ])
        );

        const { results } = await uj.importSystemFromJson(
            {
                employees: [
                    {
                        employeeNumber: 'E1',
                        firstName: 'Ama',
                        lastName: 'Moren',
                        email: null,
                        phone: null,
                        site: 'A',
                        department: 'D',
                        service: 'S',
                        role: 'Driller',
                        isActive: true,
                        assessments: [
                            {
                                skill: 'Blasting',
                                domain: 'HSE',
                                level: 3,
                                notes: null,
                                assessedAt: AT,
                                assessedBy: 'Admin: hr.lead',
                            },
                        ],
                    },
                ],
            },
            { id: 1, userType: 'admin' }
        );

        expect(writes().some((s) => /skillAssessments/.test(s))).toBe(false);
        expect(results.assessmentsUnchanged).toBe(1);
        expect(results.assessments).toBe(0);
    });

    test('F6 — a changed row is written with the assessor the file names, not the importer', async () => {
        mockDb.all.mockResolvedValue([{ id: 9, username: 'hr.lead' }]);
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
                        firstName: 'Ama',
                        lastName: 'Moren',
                        email: null,
                        phone: null,
                        siteId: 1,
                        departmentId: 2,
                        serviceId: 3,
                        roleId: 4,
                        isActive: true,
                    },
                ],
                [
                    'FROM skillAssessments WHERE employeeId',
                    { id: 55, currentLevel: 1, notes: null, assessedBy: 9, assessedAt: AT },
                ],
                ['FROM admins WHERE id', { id: 1 }],
            ])
        );

        await uj.importSystemFromJson(
            {
                employees: [
                    {
                        employeeNumber: 'E1',
                        firstName: 'Ama',
                        lastName: 'Moren',
                        email: null,
                        phone: null,
                        site: 'A',
                        department: 'D',
                        service: 'S',
                        role: 'Driller',
                        isActive: true,
                        assessments: [
                            {
                                skill: 'Blasting',
                                domain: 'HSE',
                                level: 3,
                                notes: null,
                                assessedAt: AT,
                                assessedBy: 'Admin: hr.lead',
                            },
                        ],
                    },
                ],
            },
            { id: 1, userType: 'admin' }
        );

        const insert = mockDb.run.mock.calls.find((c) =>
            c[0].includes('INSERT INTO skillAssessments')
        );
        expect(insert).toBeDefined();
        expect(insert[1][4]).toBe(9); // assessedBy = hr.lead, not importer 1
    });

    test('admins are imported BEFORE assessments so a fresh install can resolve them', () => {
        const src = read('src/services/UnifiedJsonService.js');
        const admins = src.indexOf('// 4. Admins & scopes');
        const employees = src.indexOf('// 5. Employees');
        const maps = src.indexOf(
            '({ byName: adminByName, byId: adminById } = await buildAdminMaps())'
        );
        expect(admins).toBeGreaterThan(0);
        expect(admins).toBeLessThan(maps);
        expect(maps).toBeLessThan(employees);
    });

    test('F7 — the artifact is named for what it is, in the controller and in both locales', () => {
        const ctrl = read('src/controllers/DataManagementController.js');
        expect(ctrl).toMatch(/filename=system_provisioning_export\.json/);
        expect(ctrl).not.toMatch(/filename=system_full_backup\.json/);
        const en = JSON.parse(read('locales/en/datamgmt.json'));
        const fr = JSON.parse(read('locales/fr/datamgmt.json'));
        for (const k of ['json_export_title_provisioning', 'json_export_scope_note']) {
            expect(typeof en[k]).toBe('string');
            expect(typeof fr[k]).toBe('string');
        }
        expect(en.json_export_scope_note).toMatch(/not a full backup/i);
        expect(fr.json_export_scope_note).toMatch(/pas une sauvegarde complète/i);
    });
});

// ---------------------------------------------------------------------------
// 10 + 11 — settings that mean something
// ---------------------------------------------------------------------------
describe('F10/F11 — retention settings', () => {
    const AppSettingsModel = require('../../src/models/AppSettingsModel');

    async function seededKeys() {
        jest.spyOn(AppSettingsModel, 'findByKey').mockResolvedValue(null);
        const set = jest.spyOn(AppSettingsModel, 'setValue').mockResolvedValue(true);
        await AppSettingsModel.initializeDefaults();
        return new Map(set.mock.calls.map((c) => [c[0], c[1]]));
    }

    test('F10 — assessmentHistoryRetention is gone from the defaults (it enforced nothing)', async () => {
        const keys = await seededKeys();
        expect(keys.has('assessmentHistoryRetention')).toBe(false);
        // The reason is recorded where the setting used to be.
        expect(read('src/models/AppSettingsModel.js')).toMatch(/deliberately NOT implemented/);
    });

    test('F11 — reminderLogRetentionDays is a default next to the other two windows (180 days)', async () => {
        const keys = await seededKeys();
        expect(keys.get('reminderLogRetentionDays')).toBe('180');
        expect(keys.has('perfEventsRetentionDays')).toBe(true);
        expect(keys.has('notificationRetentionDays')).toBe(true);
    });

    test('F11 — the prune job reads that setting', async () => {
        jest.resetModules();
        const mockGetValue = jest.fn(async (key, dflt) => dflt);
        jest.doMock('../../src/models/AppSettingsModel', () => ({ getValue: mockGetValue }));
        jest.doMock('../../src/config/database', () => mockDb);
        const prune = require('../../src/jobs/telemetry-prune');
        mockDb.run.mockResolvedValue({ changes: 0 });
        await prune.tick();
        expect(mockGetValue).toHaveBeenCalledWith('reminderLogRetentionDays', 180);
        expect(writes().some((s) => s.startsWith('DELETE FROM reminder_log'))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 12 — the restore drill always reaches its verdict
// ---------------------------------------------------------------------------
describe('F12 — Verify-BackupRestore.ps1 prints its verdict on a corrupt dump', () => {
    const ps1 = read('scripts/Verify-BackupRestore.ps1');

    test('native calls run with a non-terminating error preference', () => {
        expect(ps1).toMatch(/function Invoke-Native\(\[scriptblock\]\$block\)/);
        expect(ps1).toMatch(/\$ErrorActionPreference = 'Continue'/);
        expect(ps1).toMatch(/Invoke-Native \{ & \$pgRestore /);
        expect(ps1).toMatch(
            /Invoke-Native \{ & \$psql -h \$PgHost -p \$PgPort -U postgres -d \$scratch -q -f/
        );
        expect(ps1).toMatch(
            /Invoke-Native \{ & \$psql -h \$PgHost -p \$PgPort -U postgres -d \$db -v ON_ERROR_STOP=1/
        );
    });

    test('no bare native call with 2>&1 remains under the Stop preference', () => {
        const bare = ps1.split('\n').filter((l) => /^\s*& \$(psql|pgRestore) /.test(l));
        expect(bare).toEqual([]);
    });

    test('the FAILED verdict and the non-zero exit are still there', () => {
        expect(ps1).toMatch(/RESTORE DRILL FAILED - \$failed check\(s\) failed/);
        expect(ps1).toMatch(/function Fail\(\$m\) \{ Log \$m 'Red'; exit 1 \}/);
    });
});
