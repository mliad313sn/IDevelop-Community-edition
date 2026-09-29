'use strict';
/**
 * Lot B — B3: joiner / mover / leaver as a governed workflow.
 *   · a manager may only REQUEST a departure (reason mandatory); an admin decides
 *   · a departure may be SCHEDULED and is executed by the hourly tick when due
 *   · every cascade stamp skips rows that are still a request or not yet due
 *   · the ledger never shows a bare dash: stateOf() names what happened
 *   · an SSO sign-in is a sign-in (last_login_at), so "never signed in" is true
 *
 * DB mocked; no queue (REDIS_URL unset) so record() runs its cascade inline,
 * which is the contract the /v2/lifecycle route always had.
 */

const mockDb = {
    get: jest.fn(),
    all: jest.fn(() => Promise.resolve([])),
    run: jest.fn(() => Promise.resolve()),
    runTransaction: jest.fn((fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

const db = require('../../src/config/database');
const Lifecycle = require('../../src/services/LifecycleService');
const Sso = require('../../src/services/SsoService');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

beforeEach(() => {
    db.get.mockReset();
    db.all.mockReset();
    db.all.mockResolvedValue([]);
    db.run.mockReset();
    db.run.mockResolvedValue();
    delete process.env.REDIS_URL;
});

describe('what a reader sees (stateOf)', () => {
    test.each([
        [{ revertedAt: new Date() }, 'reverted'],
        [{ decision: 'declined', requestedBy: 'employee:136', decidedAt: new Date() }, 'declined'],
        [{ requestedBy: 'employee:136' }, 'requested'],
        [{ effectiveAt: new Date(Date.now() + 86400000) }, 'scheduled'],
        [{ processedAt: new Date(), payload: { skipped: 'no_open_cycle' } }, 'skipped'],
        [{ processedAt: new Date() }, 'done'],
        [{}, 'pending'],
    ])('%j → %s', (row, expected) => {
        expect(Lifecycle.stateOf(row)).toBe(expected);
    });

    test('an absent event still has a name', () => {
        expect(Lifecycle.stateOf(null)).toBe('pending');
    });
});

describe('a manager requests, an admin decides', () => {
    test('a departure without a reason is refused BEFORE any write', async () => {
        await expect(
            Lifecycle.requestLeaver(138, {
                requestedBy: { id: 136, userType: 'manager' },
                reason: '   ',
            })
        ).rejects.toMatchObject({ code: 'lc_reason_required', status: 400 });
        expect(db.get).not.toHaveBeenCalled();
        expect(db.run).not.toHaveBeenCalled();
    });

    test('the request is a row waiting for a decision — nothing is switched off', async () => {
        db.get.mockResolvedValue({ id: 51 });
        const out = await Lifecycle.requestLeaver(138, {
            requestedBy: { id: 136, userType: 'manager' },
            reason: 'fin de contrat',
        });
        expect(out).toEqual({ id: 51, requested: true });
        const [sql, params] = db.get.mock.calls[0];
        expect(sql).toContain('requested_by');
        expect(params).toEqual([138, 'fin de contrat', null, 'manager:136']);
        expect(db.run).not.toHaveBeenCalled(); // no deprovisioning here
    });

    test('only "approved" or "declined" are decisions', async () => {
        await expect(Lifecycle.decide(51, { adminId: 1, decision: 'maybe' })).rejects.toMatchObject(
            { code: 'lc_bad_decision', status: 400 }
        );
    });

    test('a row that is not a pending request cannot be decided twice', async () => {
        db.get.mockResolvedValue({
            id: 51,
            employeeId: 138,
            kind: 'leaver',
            requestedBy: 'manager:136',
            decidedAt: new Date(),
        });
        await expect(
            Lifecycle.decide(51, { adminId: 1, decision: 'approved' })
        ).rejects.toMatchObject({ code: 'lc_not_a_request', status: 409 });
        expect(db.run).not.toHaveBeenCalled();
    });

    test('declining closes the row and runs nothing', async () => {
        db.get.mockResolvedValue({
            id: 51,
            employeeId: 138,
            kind: 'leaver',
            payload: {},
            requestedBy: 'manager:136',
        });
        const spy = jest.spyOn(Lifecycle, 'handle').mockResolvedValue();
        const out = await Lifecycle.decide(51, {
            adminId: 1,
            decision: 'declined',
            note: 'reste en poste',
        });
        expect(out).toEqual({ id: 51, declined: true });
        expect(db.run.mock.calls[0][0]).toContain(
            "processed_at = CASE WHEN ? = 'declined' THEN now()"
        );
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    test('approving a departure dated in the future leaves it scheduled', async () => {
        db.get.mockResolvedValue({
            id: 51,
            employeeId: 138,
            kind: 'leaver',
            payload: {},
            requestedBy: 'manager:136',
            effectiveAt: new Date(Date.now() + 3 * 86400000),
        });
        const spy = jest.spyOn(Lifecycle, 'handle').mockResolvedValue();
        expect(await Lifecycle.decide(51, { adminId: 1, decision: 'approved' })).toEqual({
            id: 51,
            approved: true,
            scheduled: true,
        });
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    test('approving a departure that is due executes the cascade now', async () => {
        db.get.mockResolvedValue({
            id: 51,
            employeeId: 138,
            kind: 'leaver',
            payload: { reason: 'x' },
            requestedBy: 'manager:136',
            effectiveAt: null,
        });
        const spy = jest.spyOn(Lifecycle, 'handle').mockResolvedValue();
        expect(await Lifecycle.decide(51, { adminId: 1, decision: 'approved' })).toEqual({
            id: 51,
            approved: true,
            scheduled: false,
        });
        expect(spy).toHaveBeenCalledWith('leaver', expect.objectContaining({ employeeId: 138 }));
        spy.mockRestore();
    });
});

describe('recording and scheduling', () => {
    test('a future effective date records without executing', async () => {
        db.get.mockResolvedValue({ id: 60 });
        const spy = jest.spyOn(Lifecycle, 'handle').mockResolvedValue();
        const out = await Lifecycle.record('leaver', 138, {
            reason: 'mutation',
            effectiveAt: new Date(Date.now() + 86400000),
        });
        expect(out).toEqual({ id: 60, scheduled: true });
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    test('no effective date = now: the cascade runs inline when no queue is configured', async () => {
        db.get.mockResolvedValue({ id: 61 });
        const spy = jest.spyOn(Lifecycle, 'handle').mockResolvedValue();
        const out = await Lifecycle.record('joiner', 138, {
            payload: { source: 'onboarding' },
            actorRef: 'admin:1',
        });
        expect(out).toEqual({ id: 61, scheduled: false });
        expect(spy).toHaveBeenCalledWith('joiner', { employeeId: 138, source: 'onboarding' });
        spy.mockRestore();
    });

    test('processDue only takes rows that are due AND actionable', async () => {
        db.all.mockResolvedValue([{ id: 60, employeeId: 138, kind: 'leaver', payload: {} }]);
        const spy = jest.spyOn(Lifecycle, 'handle').mockResolvedValue();
        expect(await Lifecycle.processDue()).toBe(1);
        const sql = db.all.mock.calls[0][0];
        expect(sql).toContain('processed_at IS NULL');
        expect(sql).toContain('effective_at <= now()');
        expect(sql).toContain("requested_by IS NULL OR decision = 'approved'");
        spy.mockRestore();
    });

    test('one failing event does not stop the others', async () => {
        db.all.mockResolvedValue([
            { id: 1, employeeId: 1, kind: 'leaver', payload: {} },
            { id: 2, employeeId: 2, kind: 'leaver', payload: {} },
        ]);
        const spy = jest
            .spyOn(Lifecycle, 'handle')
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce();
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(await Lifecycle.processDue()).toBe(1);
        spy.mockRestore();
        err.mockRestore();
    });
});

describe('a real placement change is a mobility', () => {
    test('nothing moved → no event', async () => {
        const same = { siteId: 11, departmentId: 3, serviceId: 7, roleId: 4 };
        expect(await Lifecycle.moverFromChanges(142, same, { ...same })).toBeNull();
        expect(db.get).not.toHaveBeenCalled();
    });

    test('a site change records a mover carrying from / to / changed', async () => {
        db.get.mockImplementation((sql) => {
            if (/FROM sites/.test(sql)) return Promise.resolve({ name: 'Riverside' });
            if (/FROM departments/.test(sql)) return Promise.resolve({ name: 'D' });
            if (/FROM services/.test(sql)) return Promise.resolve({ name: 'S' });
            if (/FROM roles/.test(sql)) return Promise.resolve({ name: 'R' });
            return Promise.resolve({ id: 70 }); // the INSERT … RETURNING id
        });
        const spy = jest.spyOn(Lifecycle, 'handle').mockResolvedValue();
        const out = await Lifecycle.moverFromChanges(
            142,
            { siteId: 11, departmentId: 3, serviceId: 7, roleId: 4 },
            { siteId: 12, departmentId: 3, serviceId: 7, roleId: 4 },
            { actorRef: 'admin:1', reason: 'transfert' }
        );
        expect(out).toEqual({ id: 70, scheduled: false });
        const insert = db.get.mock.calls.find((c) => /INSERT INTO lifecycle_events/.test(c[0]));
        const payload = JSON.parse(insert[1][2]);
        expect(payload.changed).toEqual(['siteId']);
        expect(payload.from.siteId).toBe(11);
        expect(payload.to.siteId).toBe(12);
        expect(payload.source).toBe('employee_form');
        expect(insert[1][3]).toBe('transfert'); // the reason column
        spy.mockRestore();
    });
});

describe('an honest ledger', () => {
    test('a joiner with no open campaign is PROCESSED and says why', async () => {
        db.get.mockResolvedValue(null); // no open cycle
        const out = await Lifecycle.onJoiner({ employeeId: 138 });
        expect(out).toEqual({ skipped: 'no_open_cycle' });
        const [sql] = db.run.mock.calls[0];
        expect(sql).toContain('processed_at = now()');
        expect(sql).toContain('"skipped":"no_open_cycle"');
    });

    test('no cascade stamp may close a row that is still a request or not yet due', () => {
        const src = read('src/services/LifecycleService.js');
        // Every statement that stamps a joiner / mover / leaver as processed, read
        // from "UPDATE lifecycle_events" to the end of its template literal.
        const stamps = src
            .split('UPDATE lifecycle_events')
            .slice(1)
            .map((chunk) => chunk.slice(0, chunk.indexOf('`')))
            .filter(
                (s) =>
                    s.includes('processed_at = now()') && /kind = '(joiner|mover|leaver)'/.test(s)
            );
        expect(stamps.length).toBeGreaterThanOrEqual(4);
        stamps.forEach((s) => expect(s).toContain('${ACTIONABLE}'));
    });
});

describe('an SSO sign-in is a sign-in', () => {
    test('it stamps last_login_at for an employee principal', async () => {
        expect(await Sso.stampLastLogin({ kind: 'employee', id: '138' })).toBe(true);
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE employees SET last_login_at = now()'),
            [138]
        );
    });

    test('admins keep their own trail, and a broken stamp never fails the login', async () => {
        expect(await Sso.stampLastLogin({ kind: 'admin', id: 1 })).toBe(false);
        expect(await Sso.stampLastLogin(null)).toBe(false);
        expect(db.run).not.toHaveBeenCalled();
        db.run.mockRejectedValueOnce(new Error('db down'));
        expect(await Sso.stampLastLogin({ kind: 'employee', id: 138 })).toBe(false);
    });

    test('the SSO finish path calls it next to the SSO-only enforcement', () => {
        const src = read('src/config/sso.js');
        expect(src).toMatch(
            /await SsoService\.enforceSsoOnly\(principal\);\s*(\/\/[^\n]*\n\s*)*await SsoService\.stampLastLogin\(principal\);/
        );
    });
});

describe('dormant accounts are reviewed once a month, not every night', () => {
    const src = read('src/jobs/reminders.js');

    test('the tick claims before it sends and releases when the send fails', () => {
        const block = src.slice(
            src.indexOf('SECTION accounts: dormant accounts'),
            src.indexOf('end SECTION accounts', src.indexOf('SECTION accounts: dormant accounts'))
        );
        expect(block).toMatch(/claim\('account\.dormant', 'admin', a\.id, 0, mo\)/);
        expect(block).toMatch(/release\('account\.dormant', 'admin', a\.id, 0, mo\)/);
        expect(block).toContain('monthBucket(now)');
    });

    test('it notifies a COUNT and the console link — never a name', () => {
        const block = src.slice(
            src.indexOf('SECTION accounts: dormant accounts'),
            src.indexOf('end SECTION accounts', src.indexOf('SECTION accounts: dormant accounts'))
        );
        expect(block).toContain("link: '/admin/accounts?state=dormant'");
        expect(block).not.toMatch(/first_name|last_name/);
    });

    test('scheduled departures are executed before the daily hour gate', () => {
        expect(src.indexOf('LifecycleService').valueOf()).toBeGreaterThan(-1);
        expect(src.indexOf('processDue')).toBeLessThan(src.indexOf('if (now.getHours() < hour)'));
    });
});
