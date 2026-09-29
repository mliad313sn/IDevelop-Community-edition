'use strict';
/**
 * Wave 4 — proactive continuity automation. These pin the behaviours that made
 * key-person risk actionable instead of merely visible:
 *
 *   1. The three new ticks are in the SHARED registry (so they exist under both
 *      scheduler runtimes — the v3.22.3 drift class of bug).
 *   2. succession-review aggregates PER RECIPIENT — one notification carrying a
 *      count, never one per row — and the weekly ledger claim gates the re-fire.
 *   3. retention-recompute sweeps the whole active population but notifies ONLY
 *      on a CROSSING into high, in-app only (retention_risk is `restricted`).
 *   4. planning-digest says nothing when there is nothing to say, and its
 *      retention section carries a count and never a name.
 *   5. The four new notification kinds are wired into all three maps.
 *
 * DB-free: the database, the services and the ledger are mocked.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://t:t@127.0.0.1:5432/continuity_automation_test';
process.env.NODE_ENV = 'test';

// ---- fake database -------------------------------------------------------
const mockRoutes = { all: [], get: [], run: [] };
function mockRoute(kind, re, fn) {
    mockRoutes[kind].push([re, fn]);
}
function mockRespond(kind, sql, params) {
    for (const [re, fn] of mockRoutes[kind]) if (re.test(sql)) return fn(sql, params);
    return kind === 'all' ? [] : null;
}
jest.mock('../../src/config/database', () => ({
    all: (sql, p) => Promise.resolve(mockRespond('all', sql, p)),
    get: (sql, p) => Promise.resolve(mockRespond('get', sql, p)),
    run: (sql, p) => Promise.resolve(mockRespond('run', sql, p)),
}));

// ---- shared ledger (jobs/reminders exports it) ----------------------------
const mockClaim = jest.fn(async () => true);
jest.mock('../../src/jobs/reminders', () => ({
    tick: jest.fn(),
    claim: (...a) => mockClaim(...a),
    weekBucket: () => '2026-W34',
    monthBucket: () => '2026-08',
}));

jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (k, d) =>
        k === 'reminderHour' || k === 'retentionRecomputeHour' ? 0 : d
    ),
    setValue: jest.fn(async () => {}),
}));

const mockNotify = jest.fn(async () => ({ inapp: 'queued' }));
const mockEnqueue = jest.fn(async () => ({ state: 'queued' }));
jest.mock('../../src/services/NotificationService', () => {
    const actual = jest.requireActual('../../src/services/NotificationService');
    return {
        notify: (...a) => mockNotify(...a),
        enqueue: (...a) => mockEnqueue(...a),
        get KIND_META() {
            return actual.KIND_META;
        },
        get KIND_POLICY() {
            return actual.KIND_POLICY;
        },
        get KIND_MESSAGES() {
            return actual.KIND_MESSAGES;
        },
    };
});

const mockListPlansDue = jest.fn(async () => []);
const mockCriticalRoles = jest.fn(async () => []);
jest.mock('../../src/services/ContinuityService', () => ({
    listPlansDue: (...a) => mockListPlansDue(...a),
    criticalRolesWithoutSuccessor: (...a) => mockCriticalRoles(...a),
}));

const mockComputeFor = jest.fn(async () => ({ flightRisk: 'low' }));
jest.mock('../../src/services/RetentionRiskService', () => ({
    computeFor: (...a) => mockComputeFor(...a),
}));

beforeEach(() => {
    mockRoutes.all.length = 0;
    mockRoutes.get.length = 0;
    mockRoutes.run.length = 0;
    mockClaim.mockClear();
    mockClaim.mockImplementation(async () => true);
    mockNotify.mockClear();
    mockEnqueue.mockClear();
    mockComputeFor.mockClear();
    mockListPlansDue.mockImplementation(async () => []);
    mockCriticalRoles.mockImplementation(async () => []);
});

// ==========================================================================
describe('TICKS registry carries the three continuity ticks', () => {
    test('all three are registered exactly once, with a cron and an interval', () => {
        const { TICKS } = require('../../src/jobs/index');
        const wanted = [
            'succession-review.tick',
            'retention-recompute.tick',
            'planning-digest.tick',
        ];
        const names = TICKS.map((t) => t.name);
        for (const w of wanted) {
            expect(names.filter((n) => n === w)).toHaveLength(1);
            const t = TICKS.find((x) => x.name === w);
            expect(typeof t.cron).toBe('string');
            expect(t.everyMin).toBeGreaterThan(0);
            expect(typeof t.fn).toBe('function');
            // Hourly ticks are minute-staggered so they never all fire together.
            expect(t.cron).toMatch(/^\d+ \* \* \* \*$/);
        }
        // Each NEW tick claims a minute of its own, so the three do not pile
        // onto an hour that already has work on it. (Two pre-existing optional
        // ticks share minute 0; that is deliberately not in scope here.)
        const minutes = TICKS.filter((t) => /^\d+ \* \* \* \*$/.test(t.cron)).map(
            (t) => t.cron.split(' ')[0]
        );
        for (const w of wanted) {
            const mine = TICKS.find((x) => x.name === w).cron.split(' ')[0];
            expect(minutes.filter((m) => m === mine)).toHaveLength(1);
        }
    });
});

// ==========================================================================
describe('succession-review — aggregation, recipients, exactly-once', () => {
    // ReportingLineService.linesFor rows: incumbent `id` with ACTIVE supervisor `mgr`.
    const LINE_SQL = /LEFT JOIN employees sup[\s\S]*WHERE e\.id IN/;
    const managerRows = (pairs) =>
        pairs.map(([id, mgr]) => ({
            employeeId: id,
            employeeActive: true,
            supId: mgr,
            supName: 'M',
        }));

    test('ONE notification per recipient carrying counts, not one per row', async () => {
        // Two plans due, both under the same manager, plus two critical roles
        // with an empty bench, also under that manager. Old-style per-row
        // delivery would be four bells; the contract is one.
        mockListPlansDue.mockImplementation(async () => [
            { id: 1, incumbentEmployeeId: 11, ownerAdminId: 9 },
            { id: 2, incumbentEmployeeId: 12, ownerAdminId: 9 },
        ]);
        mockCriticalRoles.mockImplementation(async () => [{ roleId: 100 }, { roleId: 101 }]);
        mockRoute('all', LINE_SQL, () =>
            managerRows([
                [11, 77],
                [12, 77],
            ])
        );
        mockRoute('all', /SELECT DISTINCT e\.role_id/, () => [
            { roleId: 100, mgrId: 77 },
            { roleId: 101, mgrId: 77 },
        ]);

        const out = await require('../../src/jobs/succession-review').tick();
        expect(out).toMatchObject({ plansDue: 2, rolesWithoutSuccessor: 2, notified: 1 });
        expect(mockNotify).toHaveBeenCalledTimes(1);
        const arg = mockNotify.mock.calls[0][0];
        expect(arg).toMatchObject({
            userType: 'employee',
            userId: 77,
            kind: 'succession.review_due',
        });
        expect(arg.payload).toEqual({
            link: '/v2/continuity',
            count: 4,
            plansDue: 2,
            noSuccessor: 2,
        });
    });

    test('payload is counts + link ONLY — no role name, no incumbent name', async () => {
        mockListPlansDue.mockImplementation(async () => [
            { id: 1, incumbentEmployeeId: 11, ownerAdminId: 9 },
        ]);
        mockCriticalRoles.mockImplementation(async () => [
            { roleId: 100, roleName: 'Chef de quart' },
        ]);
        mockRoute('all', LINE_SQL, () => managerRows([[11, 77]]));
        mockRoute('all', /SELECT DISTINCT e\.role_id/, () => [{ roleId: 100, mgrId: 77 }]);

        await require('../../src/jobs/succession-review').tick();
        const json = JSON.stringify(mockNotify.mock.calls[0][0].payload);
        expect(json).not.toMatch(/Chef de quart/);
        expect(Object.keys(mockNotify.mock.calls[0][0].payload).sort()).toEqual([
            'count',
            'link',
            'noSuccessor',
            'plansDue',
        ]);
    });

    test('a plan with no incumbent falls back to its owning admin', async () => {
        mockListPlansDue.mockImplementation(async () => [
            { id: 1, incumbentEmployeeId: null, ownerAdminId: 9 },
        ]);
        await require('../../src/jobs/succession-review').tick();
        expect(mockNotify).toHaveBeenCalledTimes(1);
        expect(mockNotify.mock.calls[0][0]).toMatchObject({ userType: 'admin', userId: 9 });
    });

    test('a vacant critical role escalates to the superadmins', async () => {
        mockCriticalRoles.mockImplementation(async () => [{ roleId: 100 }]);
        mockRoute('all', /SELECT DISTINCT e\.role_id/, () => []); // no occupants
        mockRoute('all', /FROM admins WHERE role = 'superadmin'/, () => [{ id: 1 }, { id: 2 }]);
        const out = await require('../../src/jobs/succession-review').tick();
        expect(out.notified).toBe(2);
        expect(mockNotify.mock.calls.map((c) => c[0].userId).sort()).toEqual([1, 2]);
        expect(mockNotify.mock.calls.every((c) => c[0].userType === 'admin')).toBe(true);
    });

    test('the weekly ledger claim is taken BEFORE the send, and gates the re-fire', async () => {
        mockListPlansDue.mockImplementation(async () => [
            { id: 1, incumbentEmployeeId: 11, ownerAdminId: 9 },
        ]);
        mockRoute('all', LINE_SQL, () => managerRows([[11, 77]]));
        mockClaim.mockImplementation(async () => false); // already claimed this week
        const out = await require('../../src/jobs/succession-review').tick();
        expect(mockClaim).toHaveBeenCalledWith('succession.review', 'employee', 77, 0, '2026-W34');
        expect(out.notified).toBe(0);
        expect(mockNotify).not.toHaveBeenCalled();
    });

    test('nothing due → no queries fanned out and no notification', async () => {
        const out = await require('../../src/jobs/succession-review').tick();
        expect(out).toMatchObject({ plansDue: 0, rolesWithoutSuccessor: 0, notified: 0 });
        expect(mockNotify).not.toHaveBeenCalled();
    });
});

// ==========================================================================
describe('retention-recompute — sweeps everyone, notifies only on a crossing', () => {
    const population = (rows) =>
        mockRoute('all', /FROM employees e[\s\S]*LEFT JOIN retention_risk/, () => rows);

    test('recomputes the whole active population (the empty-table defect)', async () => {
        population([
            { id: 1, mgrId: 9, priorBand: null },
            { id: 2, mgrId: 9, priorBand: 'low' },
            { id: 3, mgrId: null, priorBand: 'medium' },
        ]);
        const out = await require('../../src/jobs/retention-recompute').tick();
        expect(out.computed).toBe(3);
        expect(mockComputeFor.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
    });

    test('only a transition INTO high notifies — an already-high row is silent', async () => {
        population([
            { id: 1, mgrId: 9, priorBand: 'low' }, // crosses
            { id: 2, mgrId: 9, priorBand: 'high' }, // already high → silent
        ]);
        mockComputeFor.mockImplementation(async () => ({ flightRisk: 'high' }));
        const out = await require('../../src/jobs/retention-recompute').tick();
        expect(out.crossedToHigh).toBe(1);
        expect(out.notified).toBe(1);
        expect(mockClaim).toHaveBeenCalledWith('retention.high', 'employee', 9, 1, '2026-08');
    });

    test('several crossings under one manager collapse into ONE notification', async () => {
        population([
            { id: 1, mgrId: 9, priorBand: 'low' },
            { id: 2, mgrId: 9, priorBand: 'medium' },
            { id: 3, mgrId: 9, priorBand: null },
        ]);
        mockComputeFor.mockImplementation(async () => ({ flightRisk: 'high' }));
        const out = await require('../../src/jobs/retention-recompute').tick();
        expect(out.crossedToHigh).toBe(3);
        expect(mockEnqueue).toHaveBeenCalledTimes(1);
        expect(mockEnqueue.mock.calls[0][0].payload).toEqual({ link: '/v2/continuity', count: 3 });
    });

    test('delivery is IN-APP ONLY and never names anyone (restricted tier)', async () => {
        population([{ id: 1, mgrId: 9, priorBand: 'low' }]);
        mockComputeFor.mockImplementation(async () => ({ flightRisk: 'high' }));
        await require('../../src/jobs/retention-recompute').tick();
        expect(mockNotify).not.toHaveBeenCalled(); // mockNotify() fans out to webhooks
        expect(mockEnqueue.mock.calls[0][0]).toMatchObject({
            userType: 'employee',
            userId: 9,
            channel: 'inapp',
            kind: 'retention.risk_high',
        });
        expect(Object.keys(mockEnqueue.mock.calls[0][0].payload).sort()).toEqual(['count', 'link']);
    });

    test('the claim is what stops a nightly re-fire', async () => {
        population([{ id: 1, mgrId: 9, priorBand: 'low' }]);
        mockComputeFor.mockImplementation(async () => ({ flightRisk: 'high' }));
        mockClaim.mockImplementation(async () => false);
        const out = await require('../../src/jobs/retention-recompute').tick();
        expect(out.crossedToHigh).toBe(1); // the crossing is real
        expect(out.notified).toBe(0); // but it was already announced
        expect(mockEnqueue).not.toHaveBeenCalled();
    });

    test('one failing employee never aborts the sweep', async () => {
        population([
            { id: 1, mgrId: 9, priorBand: null },
            { id: 2, mgrId: 9, priorBand: null },
        ]);
        mockComputeFor.mockImplementation(async (id) => {
            if (id === 1) throw new Error('boom');
            return { flightRisk: 'low' };
        });
        const out = await require('../../src/jobs/retention-recompute').tick();
        expect(out).toMatchObject({ computed: 1, failed: 1 });
    });

    test('an already-claimed day short-circuits the sweep', async () => {
        const AppSettingsModel = require('../../src/models/AppSettingsModel');
        AppSettingsModel.getValue.mockImplementation(async (k, d) => {
            if (k === 'retentionRecomputeHour') return 0;
            if (k === 'retentionRecomputeLastRunOn') return new Date().toISOString().slice(0, 10);
            return d;
        });
        const out = await require('../../src/jobs/retention-recompute').tick();
        expect(out).toEqual({ computed: 0, skipped: 'already_today' });
        expect(mockComputeFor).not.toHaveBeenCalled();
        AppSettingsModel.getValue.mockImplementation(async (k, d) =>
            k === 'retentionRecomputeHour' ? 0 : d
        );
    });

    test('an outright sweep failure does NOT claim the day (retries next tick) — J6', async () => {
        const AppSettingsModel = require('../../src/models/AppSettingsModel');
        AppSettingsModel.setValue.mockClear();
        // The population query itself throws before any row is computed.
        mockRoute('all', /FROM employees e[\s\S]*LEFT JOIN retention_risk/, () => {
            throw new Error('db down');
        });
        await expect(require('../../src/jobs/retention-recompute').tick()).rejects.toThrow(
            'db down'
        );
        // The day was never claimed, so the next hourly tick retries instead of
        // leaving last night's flight-risk on the heat-map as if it were tonight's.
        expect(AppSettingsModel.setValue).not.toHaveBeenCalledWith(
            'retentionRecomputeLastRunOn',
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything()
        );
    });

    test('a completed sweep claims the day AFTER the pass (idempotent re-run is safe) — J6', async () => {
        const AppSettingsModel = require('../../src/models/AppSettingsModel');
        AppSettingsModel.setValue.mockClear();
        population([{ id: 1, mgrId: 9, priorBand: 'low' }]);
        mockComputeFor.mockImplementation(async () => ({ flightRisk: 'low' }));
        await require('../../src/jobs/retention-recompute').tick();
        expect(AppSettingsModel.setValue).toHaveBeenCalledWith(
            'retentionRecomputeLastRunOn',
            expect.any(String),
            'string',
            expect.any(String),
            'jobs'
        );
    });
});

// ==========================================================================
describe('planning-digest — useful, or silent', () => {
    const pd = () => require('../../src/jobs/planning-digest');

    test('an empty scope produces nothing at all', async () => {
        expect(await pd().__test.collect(7, [])).toEqual({ certs: [], noBench: [], newlyHigh: 0 });
    });

    test('"newly high" reads the ledger, not retention_risk.updated_at', async () => {
        // updated_at is rewritten on EVERY nightly pass, so it can never mean
        // "changed recently"; the reminder_log mockClaim is the real event.
        let sawLedger = false;
        mockRoute('get', /FROM reminder_log/, (sql, p) => {
            sawLedger = /kind = 'retention\.high'/.test(sql) && p[0] === 7;
            return { n: 3 };
        });
        mockRoute('all', /SELECT DISTINCT role_id FROM employees/, () => []);
        const data = await pd().__test.collect(7, [1, 2]);
        expect(sawLedger).toBe(true);
        expect(data.newlyHigh).toBe(3);
    });

    test('every rendered section is bilingual FR + EN', () => {
        const html = pd().__test.renderHtml(
            'Amina',
            {
                certs: [
                    {
                        fullName: 'Kofi N.',
                        skillName: 'Travail en hauteur',
                        expiresOn: '2026-09-15',
                        days: 24,
                    },
                ],
                noBench: [{ roleName: 'Chef de quart', criticalityScore: 5, occupantCount: 3 }],
                newlyHigh: 2,
            },
            { branding: { appName: 'IDevelop', accentColor: '#5140D9' }, monthLabel: '2026-08' }
        );
        expect(html).toMatch(/Certifications à renouveler/);
        expect(html).toMatch(/Certifications to renew/);
        expect(html).toMatch(/Postes critiques sans successeur/);
        expect(html).toMatch(/Critical positions with no successor/);
        expect(html).toMatch(/Risque de départ passé en élevé/);
        expect(html).toMatch(/Retention risk that turned high/);
        expect(html).toMatch(/Chef de quart/); // roles ARE named
        expect(html).toMatch(/Kofi N\./); // cert holders ARE named
    });

    test('the retention section carries a COUNT and never a name', () => {
        const html = pd().__test.renderHtml('Amina', { certs: [], noBench: [], newlyHigh: 4 }, {});
        expect(html).toMatch(/4 personne\(s\)/);
        // The escaped apostrophe is what the template emits.
        expect(html).toMatch(/reste dans l&#39;application/);
        // No table of people, no band, no score.
        expect(html).not.toMatch(/flight_risk|impact_of_loss|élevé\s*\/\s*high\b.*<td/);
    });

    test('empty sections are omitted rather than rendered as a row of zeros', () => {
        const html = pd().__test.renderHtml('Amina', { certs: [], noBench: [], newlyHigh: 0 }, {});
        expect(html).not.toMatch(/Certifications à renouveler/);
        expect(html).not.toMatch(/Postes critiques sans successeur/);
        expect(html).not.toMatch(/Risque de départ passé en élevé/);
    });

    test('a long cert list is capped in the body but the total is still stated', () => {
        const certs = Array.from({ length: 20 }, (_, i) => ({
            fullName: `P${i}`,
            skillName: 'S',
            expiresOn: '2026-09-01',
            days: i,
        }));
        const html = pd().__test.renderHtml('Amina', { certs, noBench: [], newlyHigh: 0 }, {});
        expect(html).toMatch(/8 autre\(s\)/);
        expect(html).toMatch(/P0/);
        expect(html).not.toMatch(/>P19</);
    });

    test('the plain-text part mirrors the HTML sections', () => {
        const text = pd().__test.renderText({
            certs: [
                {
                    fullName: 'Kofi N.',
                    skillName: 'Travail en hauteur',
                    expiresOn: '2026-09-15',
                    days: 24,
                },
            ],
            noBench: [{ roleName: 'Chef de quart' }],
            newlyHigh: 2,
        });
        expect(text).toMatch(/Kofi N\./);
        expect(text).toMatch(/Chef de quart/);
        expect(text).toMatch(/Risque de départ passé en élevé ce mois-ci : 2/);
    });
});

// ==========================================================================
describe('ContinuityService.topSuccessorForRole — the name a handover needs', () => {
    // requireActual unmocks the service itself; its `db` dependency still
    // resolves to the fake above.
    const Continuity = jest.requireActual('../../src/services/ContinuityService');

    test('orders by readiness band, then bench rank, then confidence', async () => {
        let sql = '';
        mockRoute('get', /FROM successors s/, (s) => {
            sql = s;
            return { candidateId: 55 };
        });
        expect(await Continuity.topSuccessorForRole(33)).toBe(55);
        expect(sql).toMatch(/WHEN 'ready_now' THEN 0/);
        expect(sql).toMatch(/s\.bench_rank NULLS LAST, s\.confidence DESC NULLS LAST, s\.id/);
        expect(sql).toMatch(/e\.is_active = true/); // a bench entry outlives the person
        expect(sql).toMatch(/sp\.status <> 'archived'/);
    });

    test('the outgoing person can never succeed themselves', async () => {
        let params = null,
            sql = '';
        mockRoute('get', /FROM successors s/, (s, p) => {
            sql = s;
            params = p;
            return { candidateId: 55 };
        });
        await Continuity.topSuccessorForRole(33, { excludeEmployeeId: 10 });
        expect(sql).toMatch(/AND s\.candidate_employee_id <> \?/);
        expect(params).toEqual([33, 10]);
    });

    test('without an exclusion the predicate is omitted, not passed as a NULL param', async () => {
        // A bare `? IS NULL` cannot have its type inferred by Postgres.
        let params = null,
            sql = '';
        mockRoute('get', /FROM successors s/, (s, p) => {
            sql = s;
            params = p;
            return null;
        });
        expect(await Continuity.topSuccessorForRole(33)).toBeNull();
        expect(sql).not.toMatch(/candidate_employee_id <> \?/);
        expect(params).toEqual([33]);
    });

    test('a role with no plan or no bench returns null rather than throwing', async () => {
        expect(await Continuity.topSuccessorForRole(33)).toBeNull();
        expect(await Continuity.topSuccessorForRole(null)).toBeNull();
    });
});

// ==========================================================================
describe('the four new notification kinds are fully wired', () => {
    const N = jest.requireActual('../../src/services/NotificationService');

    test.each([
        ['succession.review_due', 'digest'],
        ['handover.due', 'digest'],
        ['retention.risk_high', 'none'],
    ])('%s has META + the expected email tier', (kind, tier) => {
        expect(N.KIND_POLICY[kind]).toBe(tier);
        const meta = N.KIND_META[kind];
        expect(meta).toBeDefined();
        expect(meta.icon).toBeTruthy();
        expect(meta.link.startsWith('/')).toBe(true);
        expect(meta.title.fr).toBeTruthy();
        expect(meta.title.en).toBeTruthy();
        expect(meta.title.fr).not.toBe(meta.title.en);
    });

    test('the two emailable kinds have a real bilingual body', () => {
        for (const kind of ['succession.review_due', 'handover.due']) {
            expect(N.KIND_MESSAGES[kind].fr).toBeTruthy();
            expect(N.KIND_MESSAGES[kind].en).toBeTruthy();
        }
    });

    test('retention.risk_high is in-app only — it must never be emailable', () => {
        expect(N.KIND_POLICY['retention.risk_high']).toBe('none');
    });

    test('planning.digest composes its own mail, so it is category-gated not tier-gated', () => {
        expect(N.KIND_POLICY['planning.digest']).toBeUndefined(); // like manager_digest / dept_digest
        expect(N.KIND_META['planning.digest']).toBeDefined();
        expect(N.KIND_MESSAGES['planning.digest'].fr).toBeTruthy();
        expect(N.KIND_MESSAGES['planning.digest'].en).toBeTruthy();
    });
});
