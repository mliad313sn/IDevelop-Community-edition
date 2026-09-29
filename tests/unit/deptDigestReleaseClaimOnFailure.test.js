'use strict';

/**
 * Re-audit J4 — dept-digest claimed the month (`last_sent_on = today`) BEFORE the
 * send, then only bumped a `sent` counter on success. A soft delivery failure —
 * notify() returning `{ inapp: 'error' }` WITHOUT throwing, or EmailService.send
 * returning `{ sent: false }` — left the claim standing, so the departmental
 * digest was silently burned for the whole period, with no ops trace.
 *
 * The fix keeps claim-before-send (a crash mid-run must not double-send) but
 * RELEASES the claim back to its prior value when delivery does not go through,
 * so the digest is due again and retries (bounded to the day by the frequency
 * gate), and reports a `failed` count the job ledger turns into an ops alert.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';
process.env.NODE_ENV = 'test';

// ---- routing DB double ----------------------------------------------------
const routes = { all: [], get: [], run: [] };
const runCalls = [];
function route(kind, re, fn) {
    routes[kind].push([re, fn]);
}
function mockRespond(kind, sql, params) {
    if (kind === 'run') runCalls.push({ sql, params });
    for (const [re, fn] of routes[kind]) if (re.test(sql)) return fn(sql, params);
    return kind === 'all' ? [] : kind === 'run' ? { changes: 1 } : null;
}
jest.mock('../../src/config/database', () => ({
    all: (sql, p) => Promise.resolve(mockRespond('all', sql, p)),
    get: (sql, p) => Promise.resolve(mockRespond('get', sql, p)),
    run: (sql, p) => Promise.resolve(mockRespond('run', sql, p)),
}));

jest.mock('../../src/models/EmployeeModel', () => ({
    findGovernedIds: jest.fn(async () => [1, 2]),
}));
const mockNotify = jest.fn(async () => ({ inapp: 'queued' }));
jest.mock('../../src/services/NotificationService', () => ({ notify: (...a) => mockNotify(...a) }));
jest.mock('../../src/services/EmailService', () => ({
    send: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../../src/services/CoverageService', () => ({ status: jest.fn(async () => []) }));
jest.mock('../../src/utils/branding', () => ({ getBranding: jest.fn(async () => null) }));

const PRIOR = '2026-08-01';
// dept-digest keys `today` off the LOCAL day (utils/dayKey, J12), so mirror that
// here rather than toISOString() — otherwise this test is wrong off-UTC.
const today = require('../../src/utils/dayKey').dayKey();

beforeEach(() => {
    routes.all.length = 0;
    routes.get.length = 0;
    routes.run.length = 0;
    runCalls.length = 0;
    mockNotify.mockReset();
    // One employee subscriber, monthly, already sent once on PRIOR.
    route('all', /FROM digest_subscriptions/, () => [
        {
            id: 5,
            subscriberType: 'employee',
            subscriberId: 11,
            frequency: 'monthly',
            dayOfWeek: null,
            dayOfMonth: Number(today.slice(8, 10)),
            hour: 0,
            lastSentOn: PRIOR,
        },
    ]);
    // departmentStats: one department in scope so the digest is NOT "nothing to say".
    route('all', /FROM v_employee_skill_gaps/, () => [
        {
            departmentId: 1,
            siteName: 'Site',
            departmentName: 'Dept',
            headcount: 2,
            completionPct: 50,
        },
    ]);
    route('get', /SELECT first_name, email FROM employees/, () => ({
        firstName: 'A',
        email: 'a@example.com',
    }));
});

const claimUpdates = () =>
    runCalls.filter((c) => /UPDATE digest_subscriptions SET last_sent_on/.test(c.sql));

describe('J4 — a burned digest month is released for retry, not lost', () => {
    test('a soft notify failure releases the claim back to the prior date and counts a failure', async () => {
        mockNotify.mockImplementation(async () => ({ inapp: 'error' })); // delivered nothing, did NOT throw
        const out = await require('../../src/jobs/dept-digest').tick();

        expect(out.sent).toBe(0);
        expect(out.failed).toBe(1);
        const ups = claimUpdates();
        // First the claim (today), then the release back to the prior send date.
        expect(ups[0].params).toEqual([today, 5]);
        expect(ups[ups.length - 1].params).toEqual([PRIOR, 5]);
        expect(ups.some((c) => c.params[0] === PRIOR)).toBe(true);
    });

    test('a thrown delivery also releases the claim (the period is never burned by a crash)', async () => {
        mockNotify.mockImplementation(async () => {
            throw new Error('smtp down');
        });
        const out = await require('../../src/jobs/dept-digest').tick();
        expect(out.failed).toBe(1);
        expect(claimUpdates().some((c) => c.params[0] === PRIOR)).toBe(true);
    });

    test('a delivered digest KEEPS its claim — the month is not re-sent', async () => {
        mockNotify.mockImplementation(async () => ({ inapp: 'queued' }));
        const out = await require('../../src/jobs/dept-digest').tick();
        expect(out.sent).toBe(1);
        expect(out.failed).toBe(0);
        const ups = claimUpdates();
        expect(ups).toHaveLength(1); // claim only, no release
        expect(ups[0].params).toEqual([today, 5]);
        expect(ups.some((c) => c.params[0] === PRIOR)).toBe(false);
    });
});
