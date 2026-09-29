'use strict';
/**
 * SECTION campaigns — jobs. Two product rules, pinned by execution:
 *
 *   A1  A job must never persist an ABSENCE OF MEASUREMENT as a RESULT.
 *       fit-history wrote fit = 0 / critical_fit = 0 for roles whose occupants
 *       had never been assessed at all, into a TREND HISTORY, so the fabricated
 *       zero was permanent.
 *
 *   A2-A4  CLAIM-BEFORE-SEND MEANS RELEASE-ON-FAILURE.
 *       NotificationService.notify() signals failure by RETURNING
 *       { inapp: 'error' } — it does NOT throw. Every one of these jobs took its
 *       exactly-once claim, `.catch(() => {})`-ed the send, counted it, and kept
 *       the claim: the reminder was never delivered, never retried, and reported
 *       as sent. Monthly claims (access review, planning digest, retention
 *       crossings) lost the item for a whole MONTH.
 *
 *   A5  A cycle past its own closes_at was never locked and never closed, so the
 *       'cycle.closed' event never fired and NO IDP was ever generated from a
 *       campaign. jobs/cycle-deadline.js is what acts on the deadline.
 *
 * DB-free: database, services and the ledger are mocked; the assertions are on
 * the SQL parameters and on the ledger calls, i.e. on behaviour.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://t:t@127.0.0.1:5432/lot_a_test';
process.env.NODE_ENV = 'test';

// ---- fake database -------------------------------------------------------
const mockCalls = { run: [], get: [], all: [] };
const mockRoutes = { all: [], get: [], run: [] };
function route(kind, re, fn) {
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
    runTransaction: (fn) => fn(),
    runInSavepoint: (fn) => fn(),
}));

const mockNotify = jest.fn(async () => ({ inapp: 'queued' }));
const mockEnqueue = jest.fn(async () => ({ state: 'queued' }));
const mockBulk = jest.fn(async () => 0);
jest.mock('../../src/services/NotificationService', () => ({
    notify: (...a) => mockNotify(...a),
    enqueue: (...a) => mockEnqueue(...a),
    enqueueBulkInApp: (...a) => mockBulk(...a),
    get KIND_META() {
        return {};
    },
}));

// SECTION campaign-rules / A8 (référentiel RH 13/09/2026): automatic closing is GONE. The
// setting now only advances the closure PROPOSAL, so `mockGraceOverride` drives
// the proposal threshold, never a close.
let mockGraceOverride = null;

jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (k, d) => {
        if (k === 'reminderHour' || k === 'retentionRecomputeHour') return 0;
        if (k === 'planningDigestDom') return new Date().getDate();
        if (k === 'planningDigestHour') return 0;
        if (k === 'cycleAutoCloseGraceDays' && mockGraceOverride !== null) return mockGraceOverride;
        return d;
    }),
    setValue: jest.fn(async () => {}),
}));

beforeEach(() => {
    mockRoutes.all.length = 0;
    mockRoutes.get.length = 0;
    mockRoutes.run.length = 0;
    mockCalls.all.length = 0;
    mockCalls.get.length = 0;
    mockCalls.run.length = 0;
    mockNotify.mockClear();
    mockNotify.mockImplementation(async () => ({ inapp: 'queued' }));
    mockEnqueue.mockClear();
    mockEnqueue.mockImplementation(async () => ({ state: 'queued' }));
    mockBulk.mockClear();
    mockBulk.mockImplementation(async () => 0);
});

/** Every ledger claim taken, and every ledger claim handed back. */
function ledger() {
    const claimed = mockCalls.get.filter((c) => /INSERT INTO reminder_log/i.test(c.sql));
    const released = mockCalls.run.filter((c) => /DELETE FROM reminder_log/i.test(c.sql));
    return { claimed, released };
}
/** Claims still held = claimed minus released, keyed on (kind,type,id,ref,period). */
function heldClaims() {
    const { claimed, released } = ledger();
    const key = (p) => JSON.stringify(p.map(String));
    const gone = new Set(released.map((r) => key(r.params)));
    return claimed.filter((c) => !gone.has(key(c.params)));
}

// =========================================================================
//  A1 — fit-history: unmeasured is NULL, never 0
// =========================================================================
describe('A1 fit-history never persists an unmeasured role as a 0 % result', () => {
    const runFitHistory = async (fitRows) => {
        jest.resetModules();
        jest.doMock('../../src/models/BenchmarkModel', () => ({ getFit: async () => fitRows }), {
            virtual: false,
        });
        route('get', /FROM benchmark_fit_history/i, () => null); // no snapshot today yet
        route('run', /INSERT INTO benchmark_fit_history/i, () => ({ changes: 1 }));
        return require('../../src/jobs/fit-history').tick();
    };
    const inserted = () =>
        mockCalls.run
            .filter((c) => /INSERT INTO benchmark_fit_history/i.test(c.sql))
            .map((c) => ({
                roleId: c.params[0],
                occupants: c.params[1],
                fit: c.params[2],
                coverage: c.params[3],
                criticalFit: c.params[4],
            }));

    test('a role with occupants but ZERO assessed skills is stored as NULL fit, not 0', async () => {
        const out = await runFitHistory([
            { roleId: 137, occupants: 1, benchmarkFit: 0, coverage: 0, criticalFit: 0 },
        ]);
        expect(out.unmeasured).toBe(1);
        const row = inserted()[0];
        expect(row.roleId).toBe(137);
        expect(row.occupants).toBe(1);
        expect(row.fit).toBeNull();
        expect(row.criticalFit).toBeNull();
        // coverage 0 IS a measurement (0 % assessed) and is how the unmeasured
        // state is reported explicitly — it must survive, not be nulled away.
        expect(row.coverage).toBe(0);
    });

    test('a genuinely measured role keeps its real fit — including a real 0 %', async () => {
        await runFitHistory([
            { roleId: 74, occupants: 2, benchmarkFit: 82, coverage: 100, criticalFit: 91 },
            { roleId: 75, occupants: 1, benchmarkFit: 0, coverage: 100, criticalFit: 0 },
        ]);
        const rows = inserted();
        expect(rows[0]).toEqual({
            roleId: 74,
            occupants: 2,
            fit: 82,
            coverage: 100,
            criticalFit: 91,
        });
        // fit 0 at coverage 100 is a MEASURED zero and must NOT be erased.
        expect(rows[1]).toEqual({
            roleId: 75,
            occupants: 1,
            fit: 0,
            coverage: 100,
            criticalFit: 0,
        });
    });
});

// =========================================================================
//  A2 — reminders: a failed send releases the claim
// =========================================================================
describe('A2 reminders releases the claim when nothing was delivered', () => {
    const runReminders = async () => {
        jest.resetModules();
        route('get', /INSERT INTO reminder_log/i, () => ({ id: 1 })); // claim granted
        route('run', /DELETE FROM reminder_log/i, () => ({ changes: 1 })); // release
        route('all', /FROM admins/i, () => [{ id: 1 }, { id: 68 }]); // 2 superadmins
        jest.doMock('../../src/services/HandoverService', () => ({ listDue: async () => [] }));
        return require('../../src/jobs/reminders').tick();
    };

    test('notify() returning { inapp: "error" } consumes NO claim and is not counted', async () => {
        mockNotify.mockImplementation(async () => ({ inapp: 'error' }));
        const out = await runReminders();
        expect(mockNotify).toHaveBeenCalled(); // it really tried to send
        expect(out.access).toBe(0); // and did not pretend it worked
        expect(ledger().claimed.length).toBeGreaterThan(0); // claim-before-send still happened
        expect(heldClaims()).toHaveLength(0); // …and every claim was handed back
    });

    test('a delivered reminder KEEPS its claim — exactly-once is not weakened', async () => {
        const out = await runReminders();
        expect(out.access).toBe(2);
        expect(heldClaims()).toHaveLength(2);
        expect(ledger().released).toHaveLength(0);
    });

    test('the monthly access-review claim is the one released (lost for a month otherwise)', async () => {
        mockNotify.mockImplementation(async () => ({ inapp: 'error' }));
        await runReminders();
        const rel = ledger().released.map((r) => r.params[0]);
        expect(rel).toContain('access.review');
    });
});

// =========================================================================
//  A3 — succession-review: no over-count, no burnt claim
// =========================================================================
describe('A3 succession-review counts only what was delivered', () => {
    const runSuccession = async () => {
        jest.resetModules();
        route('get', /INSERT INTO reminder_log/i, () => ({ id: 1 }));
        route('run', /DELETE FROM reminder_log/i, () => ({ changes: 1 }));
        jest.doMock('../../src/services/ContinuityService', () => ({
            // no incumbent → the plan's owning admin is the recipient
            listPlansDue: async () => [{ id: 1, ownerAdminId: 7, incumbentEmployeeId: null }],
            criticalRolesWithoutSuccessor: async () => [],
        }));
        return require('../../src/jobs/succession-review').tick();
    };

    test('a failed send reports notified:0 and releases the weekly claim', async () => {
        mockNotify.mockImplementation(async () => ({ inapp: 'error' }));
        const out = await runSuccession();
        expect(out.plansDue).toBe(1);
        expect(out.notified).toBe(0);
        expect(heldClaims()).toHaveLength(0);
    });

    test('a delivered send reports notified:1 and keeps the claim', async () => {
        const out = await runSuccession();
        expect(out.notified).toBe(1);
        expect(heldClaims()).toHaveLength(1);
    });
});

// =========================================================================
//  A4 — planning-digest & retention-recompute: monthly claims released
// =========================================================================
describe('A4 planning-digest releases the monthly claim when the brief did not go out', () => {
    const runDigest = async () => {
        jest.resetModules();
        route('get', /INSERT INTO reminder_log/i, () => ({ id: 1 }));
        route('run', /DELETE FROM reminder_log/i, () => ({ changes: 1 }));
        route('all', /FROM\s+employees m/i, () => [{ id: 85, firstName: 'Amina' }]);
        // one certificate expiring → the manager has something to be told
        route('all', /v_certification_current/i, () => [
            { fullName: 'X', skillName: 'S', expiresOn: '2026-10-01', days: 20 },
        ]);
        route('all', /SELECT DISTINCT role_id/i, () => []);
        route('get', /kind = 'retention.high'/i, () => ({ n: 0 }));
        jest.doMock('../../src/models/EmployeeModel', () => ({
            findGovernedIds: async () => [1, 2],
        }));
        return require('../../src/jobs/planning-digest').tick();
    };

    test('notify() error → sent:0 and the monthly claim is handed back', async () => {
        mockNotify.mockImplementation(async () => ({ inapp: 'error' }));
        const out = await runDigest();
        expect(out.sent).toBe(0);
        expect(ledger().claimed.length).toBe(1);
        expect(heldClaims()).toHaveLength(0);
        expect(ledger().released[0].params[0]).toBe('planning.digest');
    });

    test('a delivered brief keeps its monthly claim', async () => {
        const out = await runDigest();
        expect(out.sent).toBe(1);
        expect(heldClaims()).toHaveLength(1);
    });
});

describe('A4 retention-recompute releases EVERY crossing behind a failed notification', () => {
    const runRetention = async () => {
        jest.resetModules();
        route('get', /INSERT INTO reminder_log/i, () => ({ id: 1 }));
        route('run', /DELETE FROM reminder_log/i, () => ({ changes: 1 }));
        // two employees of the SAME manager both cross into high tonight
        route('all', /FROM\s+employees e/i, () => [
            { id: 11, mgrId: 85, priorBand: 'low' },
            { id: 12, mgrId: 85, priorBand: 'low' },
        ]);
        jest.doMock('../../src/services/RetentionRiskService', () => ({
            computeFor: async () => ({ flightRisk: 'high' }),
        }));
        return require('../../src/jobs/retention-recompute').tick();
    };

    test('enqueue() throwing releases BOTH row-level claims, not just one', async () => {
        mockEnqueue.mockImplementation(async () => {
            throw new Error('delivery down');
        });
        const out = await runRetention();
        expect(out.crossedToHigh).toBe(2);
        expect(out.notified).toBe(0);
        expect(ledger().claimed).toHaveLength(2);
        expect(heldClaims()).toHaveLength(0);
        expect(
            ledger()
                .released.map((r) => String(r.params[3]))
                .sort()
        ).toEqual(['11', '12']);
    });

    test('a delivered aggregate keeps both claims (one notification, two crossings)', async () => {
        const out = await runRetention();
        expect(out.notified).toBe(1);
        expect(mockEnqueue.mock.calls[0][0].payload.count).toBe(2);
        expect(heldClaims()).toHaveLength(2);
    });
});

// =========================================================================
//  A5 — cycle-deadline: closes_at is finally acted on
// =========================================================================
describe('A5 cycle-deadline advances a campaign past its own deadline', () => {
    const mockLock = jest.fn(async () => {});
    const mockClose = jest.fn(async () => {});

    // SECTION campaign-rules / A8: the job also PROPOSES a closure; `mockPropose` stands in for
    // CycleService.proposeClosure so a test can see exactly what was proposed.
    const mockPropose = jest.fn(async (id, o) => ({
        proposed: true,
        proposalId: 1,
        overdueDays: 25,
        proposalDays: (o && o.proposalDays) || 21,
    }));

    const runDeadline = async ({
        open = [],
        locked = [],
        overdue = null,
        statusAfter = {},
        graceDays = null,
    } = {}) => {
        jest.resetModules();
        mockGraceOverride = graceDays;
        mockLock.mockClear();
        mockClose.mockClear();
        mockPropose.mockClear();
        route('get', /INSERT INTO reminder_log/i, () => ({ id: 1 }));
        route('run', /DELETE FROM reminder_log/i, () => ({ changes: 1 }));
        // The A8 sweep reads BOTH running states in one query; it must be routed
        // before the narrower open/locked patterns below.
        route('all', /status IN \('open', 'locked'\)/i, () =>
            overdue === null ? [...open, ...locked] : overdue
        );
        route('all', /status = 'open'/i, () => open);
        route('all', /status = 'locked'/i, () => locked);
        route('all', /FROM admins/i, () => [{ id: 1 }]);
        route('get', /SELECT status FROM assessment_cycles/i, (_s, p) => ({
            status: statusAfter[String(p[0])] || 'open',
        }));
        jest.doMock('../../src/services/CycleService', () => ({
            lock: (...a) => mockLock(...a),
            closeWithDisposition: (...a) => mockClose(...a),
            proposeClosure: (...a) => mockPropose(...a),
            closureProposalDays: async () =>
                mockGraceOverride === null ? 21 : Number(mockGraceOverride),
            CLOSURE_PROPOSAL_DEFAULT_DAYS: 21,
        }));
        return { out: await require('../../src/jobs/cycle-deadline').tick(), propose: mockPropose };
    };

    test('an OPEN cycle past closes_at is locked', async () => {
        const { out } = await runDeadline({
            open: [{ id: 9, code: '2026-Q3', closesOn: '2026-08-31' }],
            overdue: [],
            statusAfter: { 9: 'locked' },
        });
        expect(mockLock).toHaveBeenCalledWith(9);
        expect(out.locked).toBe(1);
    });

    // SECTION campaign-rules / A8 — « Clôture automatique après échéance : proposition après
    // 21 jours, JAMAIS automatique. » The job used to close a locked campaign as
    // soon as cycleAutoCloseGraceDays was positive; that path no longer exists.
    test('an overdue LOCKED cycle is NEVER closed by the job, whatever the setting says', async () => {
        const { out } = await runDeadline({
            overdue: [
                {
                    id: 9,
                    code: '2026-Q3',
                    closesOn: '2026-08-31',
                    overdue_days: 25,
                    status: 'locked',
                },
            ],
            statusAfter: { 9: 'locked' },
            graceDays: 14, // even opted in, as a customer used to
        });
        expect(mockClose).not.toHaveBeenCalled();
        expect(out.closed).toBe(0);
    });

    test('past the threshold the job PROPOSES a closure and flags the campaign', async () => {
        const { out, propose } = await runDeadline({
            overdue: [
                {
                    id: 9,
                    code: '2026-Q3',
                    closesOn: '2026-08-31',
                    overdue_days: 25,
                    status: 'locked',
                },
            ],
            statusAfter: { 9: 'locked' },
        });
        expect(propose).toHaveBeenCalledWith(9, { proposalDays: 21 });
        expect(out.closureProposed).toBe(1);
        expect(out.overdueFlagged).toBe(1);
        expect(out.closed).toBe(0);
    });

    test('before the threshold the campaign is only FLAGGED — nothing is proposed, nothing is closed', async () => {
        const { out, propose } = await runDeadline({
            overdue: [
                {
                    id: 9,
                    code: '2026-Q3',
                    closesOn: '2026-08-31',
                    overdue_days: 13,
                    status: 'locked',
                },
            ],
            statusAfter: { 9: 'locked' },
        });
        expect(propose).not.toHaveBeenCalled();
        expect(out.closureProposed).toBe(0);
        expect(out.overdueFlagged).toBe(1);
        expect(out.closed).toBe(0);
    });

    test('the overdue flag is claimed per ISO WEEK, so it repeats until somebody acts', async () => {
        await runDeadline({
            overdue: [
                {
                    id: 9,
                    code: '2026-Q3',
                    closesOn: '2026-08-31',
                    overdue_days: 13,
                    status: 'locked',
                },
            ],
            statusAfter: { 9: 'locked' },
        });
        // claim() params are [kind, targetType, targetId, refId, period].
        const periods = ledger()
            .claimed.filter((c) => c.params[0] === 'cycle.overdue')
            .map((c) => c.params[4]);
        expect(periods.length).toBeGreaterThan(0);
        periods.forEach((p) => expect(p).toMatch(/^cycle:9:\d{4}-W\d{2}$/));
    });

    test('a transition that did not happen is not counted (idempotent re-run)', async () => {
        const { out } = await runDeadline({
            open: [{ id: 9, code: '2026-Q3' }],
            overdue: [],
            statusAfter: { 9: 'open' }, // lock() was a no-op: someone else moved it
        });
        expect(out.locked).toBe(0);
        expect(mockNotify).not.toHaveBeenCalled();
    });

    test('the announcement claim is released when the superadmin was not reached', async () => {
        mockNotify.mockImplementation(async () => ({ inapp: 'error' }));
        await runDeadline({
            open: [{ id: 9, code: '2026-Q3' }],
            overdue: [],
            statusAfter: { 9: 'locked' },
        });
        expect(ledger().claimed).toHaveLength(1);
        expect(heldClaims()).toHaveLength(0);
    });
});
