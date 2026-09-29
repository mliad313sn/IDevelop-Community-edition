'use strict';
/**
 * The four things that made Operational Compliance decorative-and-spammy:
 *
 *  1. an expired certificate changed nothing outside /compliance — the
 *     qualification maths now degrades a lapsed skill to 0 WITHOUT touching the
 *     department-designed requirement count;
 *  2. the bulk generator could write ~2,000 instantly-breached rules blind —
 *     the preview now states rules AND immediate breaches, and a cap refuses an
 *     oversized commit;
 *  3. breach alerts went only to the rule's creator (nobody when null) — the
 *     audience is now the managers of the breached scope, creator as fallback,
 *     manage_compliance admins as the floor, and a mass event is batched;
 *  4. the write gates admitted admins only, so no manager could sign off a VOC.
 *
 * DB / notifications mocked throughout.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const CoverageService = require('../../src/services/CoverageService');
const ReadinessService = require('../../src/services/ReadinessService');

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset();
    mockDb.run.mockReset().mockResolvedValue({});
});

// ---------------------------------------------------------------- 1. validity

describe('a lapsed certificate degrades qualification, not the requirement set', () => {
    const requirements = [
        { skillId: 10, skillName: 'Blasting licence', requiredLevel: 3, isCritical: true },
        { skillId: 11, skillName: 'Housekeeping', requiredLevel: 2, isCritical: false },
    ];
    const assessments = [
        { skillId: 10, currentLevel: 4 },
        { skillId: 11, currentLevel: 2 },
    ];

    test('valid certificate → the person is ready', () => {
        const r = ReadinessService._calculateSingleReadiness(
            7,
            requirements,
            assessments,
            80,
            new Set()
        );
        expect(r.totalRequired).toBe(2);
        expect(r.skillsMet).toBe(2);
        expect(r.isReady).toBe(true);
    });

    test('lapsed certificate → same requirement count, but no longer qualified', () => {
        const lapsed = new Set(['7:10']);
        const r = ReadinessService._calculateSingleReadiness(
            7,
            requirements,
            assessments,
            80,
            lapsed
        );
        // The department-designed requirement count MUST NOT move.
        expect(r.totalRequired).toBe(2);
        expect(r.pointsRequired).toBe(5);
        // The verdict does.
        expect(r.skillsMet).toBe(1);
        expect(r.criticalSkillsMet).toBe(0);
        expect(r.isReady).toBe(false);
        const gap = r.gaps.find((g) => g.skillId === 10);
        expect(gap).toMatchObject({ currentLevel: 0, certLapsed: true });
    });

    test('a lapse on a DIFFERENT employee never bleeds across', () => {
        const r = ReadinessService._calculateSingleReadiness(
            7,
            requirements,
            assessments,
            80,
            new Set(['8:10'])
        );
        expect(r.isReady).toBe(true);
    });
});

// ------------------------------------------------- 2. generator preview + cap

describe('bulk rule generation: preview states the breaches, cap refuses the flood', () => {
    // domain with 2 skills x 2 sites = 4 planned rules, nobody qualified anywhere
    function primeGenerate({ qualifiedRows = [] } = {}) {
        mockDb.all.mockImplementation(async (sql) => {
            if (/FROM skills WHERE domain_id/.test(sql))
                return [
                    { id: 1, name: 'S1' },
                    { id: 2, name: 'S2' },
                ];
            if (/FROM sites/.test(sql))
                return [
                    { id: 100, name: 'Site A' },
                    { id: 200, name: 'Site B' },
                ];
            if (/FROM employees/.test(sql))
                return [
                    { unitId: 100, n: 5 },
                    { unitId: 200, n: 5 },
                ];
            if (/FROM coverage_rules/.test(sql)) return [];
            if (/v_resolved_assessments/.test(sql)) return qualifiedRows;
            return [];
        });
    }

    test('preview writes NOTHING and reports plannedCount + immediateBreaches', async () => {
        primeGenerate();
        const out = await CoverageService.generateRules(
            { domainId: 3, scope: 'site', minLevel: 2, minHeadcount: 2 },
            null,
            false
        );
        expect(out.committed).toBe(false);
        expect(out.plannedCount).toBe(4);
        expect(out.immediateBreaches).toBe(4); // nobody qualified anywhere
        expect(out.created).toBe(0);
        expect(mockDb.get).not.toHaveBeenCalled(); // createRule never ran
        expect(out.planned.every((p) => p.wouldBreach === true)).toBe(true);
    });

    test('a unit that already has the headcount is NOT counted as an immediate breach', async () => {
        primeGenerate({ qualifiedRows: [{ unitId: 100, skillId: 1, n: 3 }] });
        const out = await CoverageService.generateRules(
            { domainId: 3, scope: 'site', minLevel: 2, minHeadcount: 2 },
            null,
            false
        );
        expect(out.plannedCount).toBe(4);
        expect(out.immediateBreaches).toBe(3);
        const covered = out.planned.find(
            (p) => Number(p.siteId) === 100 && Number(p.skillId) === 1
        );
        expect(covered).toMatchObject({ qualifiedNow: 3, wouldBreach: false });
    });

    test('commit past the cap is refused before a single row is written', async () => {
        primeGenerate();
        const prev = process.env.COVERAGE_GENERATE_MAX;
        process.env.COVERAGE_GENERATE_MAX = '3';
        try {
            await expect(
                CoverageService.generateRules(
                    { domainId: 3, scope: 'site', minLevel: 2, minHeadcount: 2 },
                    null,
                    true
                )
            ).rejects.toMatchObject({ code: 'too_many_rules', plannedCount: 4, cap: 3 });
            expect(mockDb.get).not.toHaveBeenCalled(); // nothing inserted
        } finally {
            if (prev === undefined) delete process.env.COVERAGE_GENERATE_MAX;
            else process.env.COVERAGE_GENERATE_MAX = prev;
        }
    });
});

// ------------------------------------------------------- 3. alert audience

describe('breach alerts reach the people who can act — never nobody', () => {
    const scopedRule = {
        id: 1,
        name: 'R',
        siteId: 100,
        departmentId: null,
        serviceId: null,
        createdBy: 42,
    };

    test('a scoped rule alerts the managers of the breached unit, not the author', async () => {
        mockDb.all.mockResolvedValue([
            { userId: 7, governs: 12 },
            { userId: 8, governs: 3 },
        ]);
        const audience = await CoverageService.alertAudienceFor(scopedRule);
        expect(audience).toEqual([
            { userType: 'employee', userId: 7, via: 'manager' },
            { userType: 'employee', userId: 8, via: 'manager' },
        ]);
    });

    test('no manager on the unit → the rule creator', async () => {
        mockDb.all.mockResolvedValue([]);
        const audience = await CoverageService.alertAudienceFor(scopedRule);
        expect(audience).toEqual([{ userType: 'admin', userId: 42, via: 'creator' }]);
    });

    // RBACService.adminsWithPermission — NOT the reviewer lateral join, which
    // also reads `FROM admins la` (3.23.18 R2: an admin-manager can be the reviewer).
    const PERMISSION_SQL = /FROM admins a\s+WHERE[\s\S]*admin_permissions/;

    test('null creator AND no manager → the manage_compliance admins (never empty)', async () => {
        mockDb.all.mockImplementation(async (sql) => {
            if (PERMISSION_SQL.test(sql)) return [{ id: 1 }, { id: 68 }];
            return [];
        });
        const audience = await CoverageService.alertAudienceFor({ ...scopedRule, createdBy: null });
        expect(audience).toEqual([
            { userType: 'admin', userId: 1, via: 'manage_compliance' },
            { userType: 'admin', userId: 68, via: 'manage_compliance' },
        ]);
    });

    test('a company-wide rule never fans out to every supervisor in the company', async () => {
        const seen = [];
        mockDb.all.mockImplementation(async (sql) => {
            seen.push(sql);
            if (PERMISSION_SQL.test(sql)) return [{ id: 1 }];
            return [];
        });
        const audience = await CoverageService.alertAudienceFor({
            id: 2,
            name: 'W',
            siteId: null,
            departmentId: null,
            serviceId: null,
            createdBy: null,
        });
        // No reviewer lookup at all (old shape `JOIN employees m`, new shape the lateral join).
        expect(seen.some((s) => /JOIN employees m\b|LEFT JOIN LATERAL/.test(s))).toBe(false);
        expect(audience).toEqual([{ userType: 'admin', userId: 1, via: 'manage_compliance' }]);
    });
});

// --------------------------------------------------- 3b. the job's alert cap

describe('coverage-check batches a mass breach instead of paging per rule', () => {
    const notify = jest.fn(async () => ({}));
    const log = jest.fn(async () => ({}));
    let tick;

    function breaches(n) {
        return Array.from({ length: n }, (_, i) => ({
            ruleId: i + 1,
            name: `R${i + 1}`,
            severity: 'critical',
            qualifiedHeadcount: 0,
            minHeadcount: 2,
            minLevel: 2,
            skillName: 'S',
            requireValidCert: false,
        }));
    }

    function load({ newlyBreached }) {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => mockDb);
        jest.doMock('../../src/services/NotificationService', () => ({ notify }));
        jest.doMock('../../src/services/LogService', () => ({ log }));
        jest.doMock('../../src/services/RBACService', () => ({
            adminsWithPermission: jest.fn(async () => [1, 2]),
        }));
        jest.doMock('../../src/services/CoverageService', () => ({
            evaluateAll: jest.fn(async () => ({
                evaluated: newlyBreached.length,
                newlyBreached,
                recovered: [],
            })),
            predictAndPersist: jest.fn(async () => ({ newlyPredicted: [] })),
            findRule: jest.fn(async (id) => ({ id, name: `R${id}`, siteId: 100, createdBy: null })),
            alertAudienceFor: jest.fn(async () => [
                { userType: 'employee', userId: 7, via: 'manager' },
            ]),
        }));
        tick = require('../../src/jobs/coverage-check').tick;
    }

    beforeEach(() => {
        notify.mockClear();
        log.mockClear();
        process.env.COVERAGE_ALERT_MAX = '5';
    });
    afterEach(() => {
        delete process.env.COVERAGE_ALERT_MAX;
        jest.resetModules();
    });

    test('under the cap: one alert per rule, routed to the audience', async () => {
        load({ newlyBreached: breaches(3) });
        await tick();
        expect(notify).toHaveBeenCalledTimes(3);
        expect(notify.mock.calls[0][0]).toMatchObject({
            userType: 'employee',
            userId: 7,
            kind: 'coverage.breach',
        });
    });

    test('over the cap: ONE batched notice per manage_compliance admin, and every breach still logged', async () => {
        load({ newlyBreached: breaches(40) });
        await tick();
        expect(notify).toHaveBeenCalledTimes(2); // 2 admins, not 40 rules
        expect(notify.mock.calls[0][0]).toMatchObject({
            userType: 'admin',
            kind: 'coverage.breach.batch',
            payload: expect.objectContaining({ count: 40, batched: true }),
        });
        // The audit trail is never capped: 40 breach entries + the batching note.
        const actions = log.mock.calls.map((c) => c[0].action);
        expect(actions.filter((a) => a === 'COVERAGE_BREACH')).toHaveLength(40);
        expect(actions).toContain('COVERAGE_ALERT_BATCHED');
    });
});

// ------------------------------------------------------------- 4. the gates

describe('who may act on compliance', () => {
    const ComplianceController = require('../../src/controllers/ComplianceController');
    const Klass = ComplianceController.constructor;

    const manager = { userType: 'manager', id: 5 };
    const delegate = {
        userType: 'admin',
        role: 'localadmin',
        id: 9,
        permissions: ['manage_compliance'],
    };
    const viewOnly = {
        userType: 'admin',
        role: 'localadmin',
        id: 10,
        permissions: ['view_compliance'],
    };
    const auditor = {
        userType: 'admin',
        role: 'viewer',
        id: 11,
        permissions: ['manage_compliance'],
    };
    const employee = { userType: 'employee', id: 20 };

    test('a manager may record a VOC (field act) but may not author org-wide rules', () => {
        expect(Klass.canRecord(manager)).toBe(true);
        expect(Klass.canConfigure(manager)).toBe(false);
    });

    test('a manage_compliance delegate may do both', () => {
        expect(Klass.canRecord(delegate)).toBe(true);
        expect(Klass.canConfigure(delegate)).toBe(true);
    });

    test('view-only delegates, read-only auditors and employees may do neither', () => {
        for (const u of [viewOnly, auditor, employee, null]) {
            expect(Klass.canRecord(u)).toBe(false);
            expect(Klass.canConfigure(u)).toBe(false);
        }
    });
});
