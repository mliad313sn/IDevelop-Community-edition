'use strict';
/**
 * Wave 4 — handover & certification continuity.
 *
 *   1. LifecycleService._ensureHandover used to pass ONLY outgoingEmployeeId, so
 *      every auto-created plan was an empty shell: NULL successor, NULL due
 *      date, NULL owner — a row nobody owned and nothing could chase.
 *   2. HandoverService now backfills those three on an EXISTING plan too, but
 *      only where they are still NULL (never clobbering a human's choice).
 *   3. The weekly handover nudge aggregates per recipient (owning admin +
 *      outgoing person's manager) and is gated by the exactly-once ledger.
 *   4. cert-expiry's refresher auto-assign was guarded `stage >= 2 && stage <= 3`,
 *      which excluded stage 4 — the ALREADY-EXPIRED certificates, i.e. exactly
 *      the people most in breach.
 *
 * DB-free: the database and the collaborating services are mocked.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://t:t@127.0.0.1:5432/handover_continuity_test';
process.env.NODE_ENV = 'test';

const mockRoutes = { all: [], get: [], run: [] };
const mockCalls = { all: [], get: [], run: [] };
function mockRoute(kind, re, fn) {
    mockRoutes[kind].push([re, fn]);
}
function mockRespond(kind, sql, params) {
    mockCalls[kind].push({ sql, params });
    for (const [re, fn] of mockRoutes[kind]) if (re.test(sql)) return fn(sql, params);
    return kind === 'all' ? [] : null;
}
jest.mock('../../src/config/database', () => ({
    all: (sql, p) => Promise.resolve(mockRespond('all', sql, p)),
    get: (sql, p) => Promise.resolve(mockRespond('get', sql, p)),
    run: (sql, p) => Promise.resolve(mockRespond('run', sql, p)),
}));

function reset() {
    for (const k of ['all', 'get', 'run']) {
        mockRoutes[k].length = 0;
        mockCalls[k].length = 0;
    }
}
beforeEach(reset);

// ==========================================================================
describe('HandoverService — a plan arrives dated and owned', () => {
    const HandoverService = require('../../src/services/HandoverService');

    test('a leaver gets a tighter deadline than a mover', () => {
        const from = new Date(Date.UTC(2026, 7, 22));
        expect(HandoverService.dueDateFor('leaver', from)).toBe('2026-09-05'); // +14
        expect(HandoverService.dueDateFor('mover', from)).toBe('2026-09-21'); // +30
    });

    test('the due date crosses month and year boundaries correctly', () => {
        expect(HandoverService.dueDateFor('leaver', new Date(Date.UTC(2026, 11, 25)))).toBe(
            '2027-01-08'
        );
        expect(HandoverService.dueDateFor('mover', new Date(Date.UTC(2026, 0, 31)))).toBe(
            '2026-03-02'
        );
    });

    test('the owner resolves through plan owner → criticality designator → superadmin', async () => {
        let seen = '';
        mockRoute('get', /FROM employees e WHERE e\.id = /, (sql) => {
            seen = sql;
            return { ownerId: 42 };
        });
        expect(await HandoverService.resolveOwnerAdminId(7)).toBe(42);
        // The COALESCE ladder is the contract — all three rungs, in order.
        expect(seen.indexOf('succession_plans')).toBeGreaterThan(-1);
        expect(seen.indexOf('role_criticality')).toBeGreaterThan(seen.indexOf('succession_plans'));
        expect(seen.indexOf("role = 'superadmin'")).toBeGreaterThan(
            seen.indexOf('role_criticality')
        );
    });

    test('an install with no admin at all still resolves to null rather than throwing', async () => {
        mockRoute('get', /FROM employees e WHERE e\.id = /, () => ({ ownerId: null }));
        expect(await HandoverService.resolveOwnerAdminId(7)).toBeNull();
    });

    test('_backfill fills ONLY the NULLs and never clobbers a human choice', async () => {
        let updateParams = null;
        mockRoute('get', /UPDATE handover_plans/, (sql, p) => {
            updateParams = p;
            return { id: 5, ok: true };
        });
        const plan = { id: 5, incomingEmployeeId: 99, dueDate: null, ownerAdminId: null };
        await HandoverService._backfill(plan, {
            incomingEmployeeId: 12,
            dueDate: '2026-09-05',
            ownerAdminId: 3,
        });
        // The SQL is COALESCE-per-column, so the already-set successor survives.
        const sql = mockCalls.get.find((c) => /UPDATE handover_plans/.test(c.sql)).sql;
        expect(sql).toMatch(/incoming_employee_id\s*=\s*COALESCE\(incoming_employee_id, \?\)/);
        expect(sql).toMatch(/due_date\s*=\s*COALESCE\(due_date, \?::date\)/);
        expect(sql).toMatch(/owner_admin_id\s*=\s*COALESCE\(owner_admin_id, \?\)/);
        expect(updateParams).toEqual([12, '2026-09-05', 3, 5]);
    });

    test('_backfill is a complete no-op when nothing would change', async () => {
        const plan = { id: 5, incomingEmployeeId: 99, dueDate: '2026-01-01', ownerAdminId: 3 };
        const out = await HandoverService._backfill(plan, {
            incomingEmployeeId: 12,
            dueDate: '2026-09-05',
            ownerAdminId: 7,
        });
        expect(out).toBe(plan);
        expect(mockCalls.get.filter((c) => /UPDATE handover_plans/.test(c.sql))).toHaveLength(0);
    });

    test('listDue never nudges on "has open items" alone — a due date is required', async () => {
        await HandoverService.listDue();
        const { sql, params } = mockCalls.all[0];
        expect(params).toEqual([14, 30]);
        expect(sql).toMatch(/status IN \('open', 'in_progress'\)/);
        // Every branch of the OR is anchored on due_date (past, near, or absent
        // AND aged) — a plan seeded five minutes ago with five open items is not
        // due, which is what stops this from nudging every owner every week.
        const where = sql.slice(sql.indexOf('AND ('));
        const branches = where.split(/\bOR\b/);
        expect(branches.length).toBeGreaterThanOrEqual(3);
        for (const b of branches) expect(b).toMatch(/due_date/);
    });

    test('listDue reports BOTH accountable parties so the caller can aggregate', async () => {
        mockRoute('all', /FROM handover_plans h/, () => [
            { id: 1, outgoingEmployeeId: 50, ownerAdminId: 3, openItems: 2 },
        ]);
        // ReportingLineService.linesFor: the leaver 50 has an ACTIVE supervisor 60
        // and an ADMIN manager 9 (3.23.18 R2 — the admin manager is no longer lost).
        mockRoute('all', /LEFT JOIN employees sup/, () => [
            {
                employeeId: 50,
                employeeActive: false,
                supId: 60,
                supName: 'S',
                mgrAdmId: 9,
                mgrAdmName: 'adm',
            },
        ]);
        const out = await HandoverService.listDue();
        const sql = mockCalls.all[0].sql;
        expect(sql).toMatch(/h\.owner_admin_id/);
        expect(sql).toMatch(/AS open_items/);
        expect(out).toHaveLength(1);
        expect(out[0].ownerAdminId).toBe(3);
        expect(out[0].lineRecipients).toEqual([
            { userType: 'employee', userId: 60 },
            { userType: 'admin', userId: 9 },
        ]);
        expect(out[0].managerId).toBe(60);
    });
});

// ==========================================================================
describe('LifecycleService._ensureHandover resolves successor, due date and owner', () => {
    const topSuccessorForRole = jest.fn(async () => 55);
    jest.doMock('../../src/services/ContinuityService', () => ({ topSuccessorForRole }));

    let ensureForEvent;
    beforeEach(() => {
        jest.resetModules();
        topSuccessorForRole.mockClear();
        topSuccessorForRole.mockImplementation(async () => 55);
        ensureForEvent = jest.fn(async () => ({ id: 1 }));
        jest.doMock('../../src/config/database', () => ({
            all: (sql, p) => Promise.resolve(mockRespond('all', sql, p)),
            get: (sql, p) => Promise.resolve(mockRespond('get', sql, p)),
            run: (sql, p) => Promise.resolve(mockRespond('run', sql, p)),
        }));
        jest.doMock('../../src/services/ContinuityService', () => ({ topSuccessorForRole }));
        jest.doMock('../../src/services/HandoverService', () => ({
            ensureForEvent,
            dueDateFor: (kind) => (kind === 'mover' ? 'DUE_MOVER' : 'DUE_LEAVER'),
            resolveOwnerAdminId: async () => 42,
        }));
    });
    afterEach(() => {
        jest.resetModules();
        jest.dontMock('../../src/services/HandoverService');
    });

    test('all four fields reach HandoverService (the empty-shell defect)', async () => {
        mockRoute('get', /FROM lifecycle_events/, () => ({ id: 7 }));
        mockRoute('get', /SELECT role_id FROM employees/, () => ({ roleId: 33 }));
        const Lfc = require('../../src/services/LifecycleService');
        await Lfc._ensureHandover(10, 'leaver');
        expect(ensureForEvent).toHaveBeenCalledWith({
            lifecycleEventId: 7,
            outgoingEmployeeId: 10,
            incomingEmployeeId: 55,
            dueDate: 'DUE_LEAVER',
            ownerAdminId: 42,
        });
        expect(topSuccessorForRole).toHaveBeenCalledWith(33, { excludeEmployeeId: 10 });
    });

    test('a mover gets the mover deadline', async () => {
        mockRoute('get', /FROM lifecycle_events/, () => ({ id: 8 }));
        mockRoute('get', /SELECT role_id FROM employees/, () => ({ roleId: 33 }));
        const Lfc = require('../../src/services/LifecycleService');
        await Lfc._ensureHandover(10, 'mover');
        expect(ensureForEvent.mock.calls[0][0].dueDate).toBe('DUE_MOVER');
    });

    test('no bench → the plan is still created, dated and owned', async () => {
        mockRoute('get', /FROM lifecycle_events/, () => ({ id: 7 }));
        mockRoute('get', /SELECT role_id FROM employees/, () => ({ roleId: 33 }));
        topSuccessorForRole.mockImplementation(async () => {
            throw new Error('no continuity module');
        });
        const Lfc = require('../../src/services/LifecycleService');
        await Lfc._ensureHandover(10, 'leaver');
        expect(ensureForEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                incomingEmployeeId: null,
                dueDate: 'DUE_LEAVER',
                ownerAdminId: 42,
            })
        );
    });
});

// ==========================================================================
describe('reminders — the weekly handover.due nudge', () => {
    const listDue = jest.fn(async () => []);
    const notify = jest.fn(async () => ({ inapp: 'queued' }));

    beforeEach(() => {
        jest.resetModules();
        listDue.mockClear();
        notify.mockClear();
        listDue.mockImplementation(async () => []);
        jest.doMock('../../src/config/database', () => ({
            all: (sql, p) => Promise.resolve(mockRespond('all', sql, p)),
            get: (sql, p) => Promise.resolve(mockRespond('get', sql, p)),
            run: (sql, p) => Promise.resolve(mockRespond('run', sql, p)),
        }));
        jest.doMock('../../src/models/AppSettingsModel', () => ({
            getValue: async (k, d) => (k === 'reminderHour' ? 0 : d),
        }));
        jest.doMock('../../src/services/HandoverService', () => ({ listDue }));
        jest.doMock('../../src/services/NotificationService', () => ({
            notify,
            enqueue: jest.fn(async () => ({})),
            enqueueBulkInApp: jest.fn(async () => 0),
            get KIND_META() {
                return jest.requireActual('../../src/services/NotificationService').KIND_META;
            },
        }));
        // The ledger claim always succeeds unless a test says otherwise.
        mockRoute('get', /INSERT INTO reminder_log/, () => ({ id: 1 }));
    });
    afterEach(() => {
        jest.resetModules();
    });

    test('both accountable parties are nudged, once each, with counts', async () => {
        listDue.mockImplementation(async () => [
            { id: 1, ownerAdminId: 3, managerId: 77, isOverdue: true, openItems: 5 },
            { id: 2, ownerAdminId: 3, managerId: 77, isOverdue: false, openItems: 2 },
        ]);
        const out = await require('../../src/jobs/reminders').tick();
        expect(out.handover).toBe(2); // one admin + one manager, NOT one per plan
        const byUser = Object.fromEntries(
            notify.mock.calls.map((c) => [`${c[0].userType}:${c[0].userId}`, c[0]])
        );
        expect(Object.keys(byUser).sort()).toEqual(['admin:3', 'employee:77']);
        for (const n of Object.values(byUser)) {
            expect(n.kind).toBe('handover.due');
            expect(n.payload).toEqual({
                link: '/v2/continuity',
                count: 2,
                overdue: 1,
                dueSoon: 1,
                openItems: 7,
            });
        }
    });

    test('an ownerless legacy plan still reaches the manager', async () => {
        listDue.mockImplementation(async () => [
            { id: 1, ownerAdminId: null, managerId: 77, isOverdue: true, openItems: 5 },
        ]);
        const out = await require('../../src/jobs/reminders').tick();
        expect(out.handover).toBe(1);
        expect(notify.mock.calls[0][0]).toMatchObject({ userType: 'employee', userId: 77 });
    });

    test('the weekly ledger claim stops a second run from re-notifying', async () => {
        listDue.mockImplementation(async () => [
            { id: 1, ownerAdminId: 3, managerId: 77, isOverdue: true, openItems: 1 },
        ]);
        mockRoutes.get.length = 0;
        mockRoute('get', /INSERT INTO reminder_log/, () => null); // ON CONFLICT DO NOTHING → no row
        const out = await require('../../src/jobs/reminders').tick();
        expect(out.handover).toBe(0);
        expect(notify).not.toHaveBeenCalled();
    });

    test('nothing due → no notification at all', async () => {
        const out = await require('../../src/jobs/reminders').tick();
        expect(out.handover).toBe(0);
        expect(notify).not.toHaveBeenCalled();
    });

    test('the ledger primitives are exported for the other continuity ticks', () => {
        const reminders = require('../../src/jobs/reminders');
        expect(typeof reminders.claim).toBe('function');
        expect(reminders.weekBucket(new Date(Date.UTC(2026, 7, 22)))).toMatch(/^2026-W\d{2}$/);
        expect(reminders.monthBucket(new Date(Date.UTC(2026, 7, 22)))).toBe('2026-08');
    });
});

// ==========================================================================
describe('cert-expiry — the expired are the ones who most need a refresher', () => {
    const assignCourse = jest.fn(async () => ({ id: 1 }));
    const notify = jest.fn(async () => ({}));

    beforeEach(() => {
        jest.resetModules();
        assignCourse.mockClear();
        notify.mockClear();
        jest.doMock('../../src/config/database', () => ({
            all: (sql, p) => Promise.resolve(mockRespond('all', sql, p)),
            get: (sql, p) => Promise.resolve(mockRespond('get', sql, p)),
            run: (sql, p) => Promise.resolve(mockRespond('run', sql, p)),
        }));
        jest.doMock('../../src/models/AppSettingsModel', () => ({
            getValue: async () => null,
            setValue: async () => {},
        }));
        jest.doMock('../../src/services/NotificationService', () => ({ notify }));
        jest.doMock('../../src/services/LmsService', () => ({ assignCourse }));
        mockRoute('get', /FROM course_skill_map/, () => ({ courseId: 501 }));
        mockRoute('get', /COALESCE\(supervisor_id/, () => ({ mid: 77 }));
    });
    afterEach(() => {
        jest.resetModules();
    });

    const cert = (days, alertStage) => ({
        certId: 1,
        employeeId: 10,
        fullName: 'Kofi N.',
        skillId: 4,
        skillName: 'Travail en hauteur',
        expiresOn: '2026-07-01',
        daysToExpiry: days,
        alertStage,
    });

    test('stage ladder is unchanged: 90/60/30/expired', () => {
        const { stageFor } = require('../../src/jobs/cert-expiry');
        expect([stageFor(120), stageFor(90), stageFor(60), stageFor(30), stageFor(-1)]).toEqual([
            0, 1, 2, 3, 4,
        ]);
        expect(stageFor(null)).toBe(0);
    });

    test('an ALREADY EXPIRED certification now triggers the refresher (stage 4)', async () => {
        mockRoute('all', /v_certification_current/, () => [cert(-10, 3)]);
        const out = await require('../../src/jobs/cert-expiry').tick();
        expect(out.alerts).toBe(1);
        expect(out.lmsAssigned).toBe(1);
        expect(assignCourse).toHaveBeenCalledWith(10, 501, { assignedBy: null });
    });

    test('stages 2 and 3 still assign, stage 1 still does not', async () => {
        for (const [days, priorStage, expected] of [
            [45, 1, 1],
            [10, 2, 1],
            [80, 0, 0],
        ]) {
            jest.resetModules();
            assignCourse.mockClear();
            mockRoutes.all.length = 0;
            mockRoute('all', /v_certification_current/, () => [cert(days, priorStage)]);
            const out = await require('../../src/jobs/cert-expiry').tick();
            expect(out.lmsAssigned).toBe(expected);
        }
    });

    test('the stage watermark still makes each stage fire exactly once', async () => {
        mockRoute('all', /v_certification_current/, () => [cert(-10, 4)]); // stage 4 already claimed
        const out = await require('../../src/jobs/cert-expiry').tick();
        expect(out.alerts).toBe(0);
        expect(assignCourse).not.toHaveBeenCalled();
    });
});
